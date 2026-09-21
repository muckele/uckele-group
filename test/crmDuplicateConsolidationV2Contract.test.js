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
  crmDuplicateConsolidationFinancialEvidenceMatches,
  crmDuplicateConsolidationRawStringMatchesSha256,
  inspectCrmDuplicateConsolidationMarketplaceIdentity,
  selectCrmDuplicateConsolidationConfigAuthority,
} from '../server/repairs/crmDuplicateConsolidation.js';

const safeConfig = () => ({
  dealHunter: {
    cimFollowUp: { enabled: false },
    cimAutomation: { schedulerEnabled: false },
  },
});

test('V2 repair namespace is distinct while the approval and checkpoint contracts remain V1', () => {
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION, 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V2');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA, 'crm-duplicate-consolidation-plan-v2');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA, 'crm-duplicate-consolidation-manifest-v2');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION, 'APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V2');
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
