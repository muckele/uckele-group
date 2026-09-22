import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  CRM_DUPLICATE_CONSOLIDATION_CONFIG_AUTHORITY_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
  CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
  CRM_DUPLICATE_CONSOLIDATION_RUNTIME_SAFETY_SCHEMA,
  buildCrmDuplicateConsolidationRuntimeSafetyAuthority,
  canonicalJsonSha256,
  crmDuplicateConsolidationFinancialEvidenceMatches,
  crmDuplicateConsolidationRawStringMatchesSha256,
  inspectCrmDuplicateConsolidationMarketplaceIdentity,
  selectCrmDuplicateConsolidationConfigAuthority,
} from '../server/repairs/crmDuplicateConsolidation.js';
import { createSqliteCrmDuplicateConsolidationReadOnlyStorage } from '../server/storage/sqlite.js';
import { createFixture } from './crmDuplicateConsolidationRepair.test.js';

const safeConfig = () => ({
  dealHunter: {
    cimFollowUp: { enabled: false },
    cimAutomation: { schedulerEnabled: false },
  },
});

test('V2 repair namespace is distinct while the approval and checkpoint contracts remain V1', () => {
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION, 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA, 'crm-duplicate-consolidation-plan-v3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA, 'crm-duplicate-consolidation-manifest-v3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION, 'APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_CONFIG_AUTHORITY_SCHEMA, 'crm-duplicate-consolidation-runtime-config-v1');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_RUNTIME_SAFETY_SCHEMA, 'crm-duplicate-consolidation-runtime-safety-v1');
});

test('repair-specific config authority accepts defined false defaults and recognized explicit false tokens', () => {
  const absent = selectCrmDuplicateConsolidationConfigAuthority({
    config: safeConfig(),
    environment: {},
  });
  assert.equal(absent.schema, CRM_DUPLICATE_CONSOLIDATION_CONFIG_AUTHORITY_SCHEMA);
  assert.match(absent.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(absent.facts.map((fact) => [fact.sourceId, fact.value, fact.rawState, fact.rawToken]), [
    ['dealHunter.cimFollowUp.enabled', false, 'default-absent', null],
    ['dealHunter.cimAutomation.schedulerEnabled', false, 'default-absent', null],
  ]);

  const empty = selectCrmDuplicateConsolidationConfigAuthority({
    config: safeConfig(),
    environment: {
      DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: '',
      DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED: '   ',
    },
  });
  assert.deepEqual(empty.facts.map((fact) => [fact.rawState, fact.rawToken]), [
    ['default-empty', ''],
    ['default-empty', ''],
  ]);

  for (const token of ['0', 'false', 'FALSE', ' no ', 'off']) {
    const explicit = selectCrmDuplicateConsolidationConfigAuthority({
      config: safeConfig(),
      environment: {
        DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: token,
        DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED: token,
      },
    });
    assert.deepEqual(explicit.facts.map((fact) => [fact.rawState, fact.rawToken]), [
      ['explicit-false', token.trim().toLowerCase()],
      ['explicit-false', token.trim().toLowerCase()],
    ]);
  }
});

test('repair-specific config authority refuses malformed, enabled, mismatched, and incomplete facts', () => {
  const cases = [
    {
      name: 'malformed explicit token',
      config: safeConfig(),
      environment: { DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: 'disabled-ish' },
      pattern: /malformed.*DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED/i,
    },
    {
      name: 'recognized true token',
      config: { ...safeConfig(), dealHunter: { ...safeConfig().dealHunter, cimFollowUp: { enabled: true } } },
      environment: { DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: 'yes' },
      pattern: /must be false|enabled/i,
    },
    {
      name: 'lexical and effective mismatch',
      config: safeConfig(),
      environment: { DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: 'on' },
      pattern: /disagrees|mismatch/i,
    },
    {
      name: 'incomplete config',
      config: { dealHunter: { cimFollowUp: { enabled: false } } },
      environment: {},
      pattern: /schedulerEnabled.*boolean|incomplete/i,
    },
  ];
  for (const item of cases) {
    assert.throws(
      () => selectCrmDuplicateConsolidationConfigAuthority(item),
      item.pattern,
      item.name,
    );
  }
});

test('four-source authority binds like-for-like config facts and exact durable rows without self-hashing', () => {
  const configAuthority = selectCrmDuplicateConsolidationConfigAuthority({
    config: safeConfig(),
    environment: {},
  });
  const cimSafetyRow = {
    id: 'global',
    updated_at: '2026-09-20T00:00:00.000Z',
    outreach_paused: 1,
    updated_by: 'synthetic-test',
    metadata: '{}',
  };
  const automationRow = {
    id: 'cim-initial-outreach',
    updated_at: '2026-09-20T00:00:00.000Z',
    paused: 1,
    updated_by: 'synthetic-test',
    metadata: '{}',
  };
  const authority = buildCrmDuplicateConsolidationRuntimeSafetyAuthority({
    configAuthority,
    cimSafetyRow,
    automationRow,
  });
  assert.equal(authority.schema, CRM_DUPLICATE_CONSOLIDATION_RUNTIME_SAFETY_SCHEMA);
  assert.equal(authority.config.digest, configAuthority.digest);
  assert.deepEqual(authority.durable.map((fact) => [fact.sourceId, fact.value]), [
    ['deal_hunter_cim_safety_settings/global/outreach_paused', true],
    ['deal_hunter_automation_settings/cim-initial-outreach/paused', true],
  ]);
  assert.ok(authority.durable.every((fact) => /^[a-f0-9]{64}$/.test(fact.rawRowDigest)));
  assert.match(authority.digest, /^[a-f0-9]{64}$/);
  const { digest, ...hashInput } = authority;
  assert.equal(digest, canonicalJsonSha256(hashInput));

  assert.throws(() => buildCrmDuplicateConsolidationRuntimeSafetyAuthority({
    configAuthority,
    cimSafetyRow: { ...cimSafetyRow, outreach_paused: 0 },
    automationRow,
  }), /outreach.*paused.*true/i);
  assert.throws(() => buildCrmDuplicateConsolidationRuntimeSafetyAuthority({
    configAuthority,
    cimSafetyRow,
    automationRow: { ...automationRow, id: 'global' },
  }), /cim-initial-outreach/i);
});

test('real read-only SQLite preview binds the two real durable row IDs and selected config authority', async (t) => {
  const fixture = await createFixture(t);
  const config = {
    ...fixture.config,
    ...safeConfig(),
  };
  const storage = createSqliteCrmDuplicateConsolidationReadOnlyStorage(config, { environment: {} });
  try {
    const inspection = await storage.inspectCrmDuplicateConsolidation();
    assert.equal(
      inspection.runtimeSafetyAuthority.schema,
      CRM_DUPLICATE_CONSOLIDATION_RUNTIME_SAFETY_SCHEMA,
    );
    assert.deepEqual(
      inspection.runtimeSafetyAuthority.durable.map((fact) => fact.sourceId),
      [
        'deal_hunter_cim_safety_settings/global/outreach_paused',
        'deal_hunter_automation_settings/cim-initial-outreach/paused',
      ],
    );
    assert.equal(
      inspection.runtimeSafetyAuthority.config.digest,
      selectCrmDuplicateConsolidationConfigAuthority({ config, environment: {} }).digest,
    );
    assert.ok(inspection.blockers.includes('berlin-superseded-deal-key-digest-drift'));
  } finally {
    storage.close();
  }
});

test('raw identity hashing validates type and preserves exact UTF-8 bytes', () => {
  const synthetic = 'SYNTHETIC restricted-identity surrogate / 42 ';
  const digest = createHash('sha256').update(synthetic, 'utf8').digest('hex');
  assert.equal(crmDuplicateConsolidationRawStringMatchesSha256(synthetic, digest), true);
  assert.equal(crmDuplicateConsolidationRawStringMatchesSha256(synthetic.trim(), digest), false);
  for (const invalid of ['', null, undefined, false, 0, { value: synthetic }]) {
    assert.equal(crmDuplicateConsolidationRawStringMatchesSha256(invalid, digest), false);
  }
});

test('marketplace inspection accepts approved URL-only evidence and rejects malformed or conflicting additions', () => {
  const expectedIdentity = 'costar:2516010';
  const approvedUrl = 'https://www.bizbuysell.com/business-opportunity/synthetic-pooler/2516010/';
  assert.deepEqual(inspectCrmDuplicateConsolidationMarketplaceIdentity({
    listingUrl: approvedUrl,
    expectedIdentity,
  }), {
    identities: [expectedIdentity],
    valid: true,
    blockers: [],
  });
  assert.deepEqual(inspectCrmDuplicateConsolidationMarketplaceIdentity({
    listingUrl: approvedUrl,
    identityAliases: [
      'url:bizbuysell.com/business-opportunity/synthetic-pooler/2516010',
      expectedIdentity,
    ],
    expectedIdentity,
  }), {
    identities: [expectedIdentity],
    valid: true,
    blockers: [],
  });

  const badCases = [
    {
      listingUrl: 'https://bizbuysell.com.evil.invalid/business-opportunity/2516010',
      blocker: /unsupported.*listing.*url/i,
    },
    {
      listingUrl: approvedUrl,
      listingAliases: ['not a supported marketplace URL'],
      blocker: /malformed|unsupported.*listing alias/i,
    },
    {
      listingUrl: approvedUrl,
      identityAliases: ['costar:9999999'],
      blocker: /conflicting|unexpected.*identity/i,
    },
    {
      listingUrl: approvedUrl,
      identityAliases: null,
      blocker: /identityAliases.*array/i,
    },
  ];
  for (const input of badCases) {
    const result = inspectCrmDuplicateConsolidationMarketplaceIdentity({
      expectedIdentity,
      ...input,
    });
    assert.equal(result.valid, false);
    assert.ok(result.blockers.some((blocker) => input.blocker.test(blocker)), JSON.stringify(result));
  }
});

test('financial authority comes from raw Annual Profit without synthetic financialProvenance', () => {
  const pair = {
    askingPrice: '$1,580,000',
    revenue: '$3,535,760',
    financialLabel: 'Annual Profit',
    financialValue: '$535,397',
  };
  const row = {
    asking_price: pair.askingPrice,
    ttm_revenue: pair.revenue,
    ttm_ebitda: pair.financialValue,
    metadata: JSON.stringify({
      dealHunter: {
        raw: { 'Annual Profit': pair.financialValue },
      },
    }),
  };
  assert.deepEqual(crmDuplicateConsolidationFinancialEvidenceMatches(row, pair), {
    valid: true,
    blocker: null,
  });
  for (const raw of [
    {},
    { 'Annual Profit': '$1' },
    { EBITDA: pair.financialValue },
    { 'Annual Profit': null },
  ]) {
    assert.equal(crmDuplicateConsolidationFinancialEvidenceMatches({
      ...row,
      metadata: JSON.stringify({ dealHunter: { raw } }),
    }, pair).valid, false);
  }
});
