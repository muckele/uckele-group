import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildActionQueue,
  buildAcquisitionSourceHealth,
  buildNextSourceSnapshot,
  calculateDiligenceReadiness,
  deriveAcquisitionPipelineStage,
  getSourceHealth,
  updateAcquisitionCommandCenterRecord,
} from '../server/services/acquisitionCommandCenter.js';

test('diligence readiness scores complete core acquisition checks', () => {
  const readiness = calculateDiligenceReadiness({
    submission: {
      sba_eligible: 'yes',
      prospectus_url: 'https://example.com/cim.pdf',
      asking_price: '$1,400,000',
      ttm_ebitda: '$450,000',
      ebitda_multiple: '3.1x',
      metadata: {
        diligence: {
          checklist: {
            p_and_l: true,
            tax_returns: true,
            balance_sheet: true,
            owner_role: true,
            management_depth: true,
            customer_concentration: true,
          },
          financing: {
            seller_note: 'Seller is open to a 15% seller note.',
            sba_lender_status: 'SBA lender reviewed and supportive.',
          },
          memo: 'Recurring maintenance contracts with commercial customers and scheduled maintenance revenue.',
        },
      },
    },
    documents: [{ id: 'doc-1', original_name: 'CIM P&L tax returns balance sheet.pdf' }],
  });

  assert.equal(readiness.score, 100);
  assert.equal(readiness.complete, readiness.total);
  assert.deepEqual(readiness.missing, []);
});

test('generated Deal Hunter notes do not count as completed diligence evidence', () => {
  const readiness = calculateDiligenceReadiness({
    submission: {
      asking_price: '$1,400,000',
      ttm_ebitda: '$450,000',
      notes: [
        'Deal Hunter generated notes',
        'Questions to ask broker or seller',
        '- Would the seller consider seller financing, an earnout, or other structure?',
        '- What customer concentration exists in the top 5 and top 10 accounts?',
        '- How much revenue is recurring, contracted, or repeat customer work?',
        'End Deal Hunter generated notes',
        '',
        'User notes',
      ].join('\n'),
      metadata: {
        diligence: {},
      },
    },
    documents: [],
  });

  const completedIds = readiness.items.filter((item) => item.complete).map((item) => item.id);

  assert.equal(completedIds.includes('seller-financing-fit'), false);
  assert.equal(completedIds.includes('customer-concentration'), false);
  assert.equal(completedIds.includes('revenue-quality'), false);
});

test('acquisition pipeline derives stage from command override, CIM response, and documents', () => {
  assert.equal(
    deriveAcquisitionPipelineStage({
      submission: {
        metadata: {
          acquisitionCommand: {
            pipelineStage: 'passed',
          },
        },
      },
    }),
    'passed',
  );

  assert.equal(
    deriveAcquisitionPipelineStage({
      submission: { metadata: {} },
      cimRequest: { status: 'responded' },
    }),
    'broker-replied',
  );

  assert.equal(
    deriveAcquisitionPipelineStage({
      submission: {
        prospectus_url: 'https://example.com/cim.pdf',
        metadata: {},
      },
    }),
    'docs-received',
  );
});

test('source health flags row drops and missing post-window updates', () => {
  const health = buildAcquisitionSourceHealth({
    now: new Date('2026-06-16T18:00:00.000Z'),
    config: {
      dealHunter: {
        dailyEmail: {
          time: '10:15',
          timezone: 'America/Los_Angeles',
        },
      },
    },
    previousSnapshot: {
      sources: {
        'sheet-0': {
          rowCount: 100,
        },
      },
    },
    review: {
      generatedAt: '2026-06-16T18:00:00.000Z',
      totals: {
        newDeals: 0,
      },
      sources: [
        {
          id: 'sheet-0',
          name: 'SMB Deal Hunter Google Sheet',
          mode: 'csv',
          fetched: true,
          rowCount: 60,
        },
      ],
    },
  });

  assert.equal(health.afterDailyUpdateWindow, true);
  assert.equal(health.healthy, false);
  assert.equal(health.sources[0].rowDelta, -40);
  assert.equal(health.issues.some((issue) => issue.message.includes('Row count dropped from 100 to 60')), true);
  assert.equal(health.issues.some((issue) => issue.sourceId === 'daily-update-window'), true);
});

test('source health retains Deal OS export freshness and coverage provenance', () => {
  const health = buildAcquisitionSourceHealth({
    review: {
      generatedAt: '2026-08-10T17:00:00.000Z',
      totals: { newDeals: 2 },
      sources: [{
        id: 'deal-os-export',
        name: 'SMB Deal OS export',
        mode: 'manual-export',
        fetched: true,
        rowCount: 120,
        exportedAt: '2026-08-10T15:00:00.000Z',
        importedAt: '2026-08-10T15:05:00.000Z',
        importedBy: 'mathew@example.com',
        importAgeHours: 2,
        maxAgeHours: 72,
        scope: 'saved-search',
        coverageLabel: 'All active criteria',
        expectedRowCount: 120,
        duplicateCount: 0,
        stableIdCount: 118,
        listingUrlCount: 120,
        coverageLimitReached: false,
      }],
    },
    now: new Date('2026-08-10T17:00:00.000Z'),
  });
  const source = health.sources[0];

  assert.equal(source.exportedAt, '2026-08-10T15:00:00.000Z');
  assert.equal(source.importedBy, 'mathew@example.com');
  assert.equal(source.importAgeHours, 2);
  assert.equal(source.scope, 'saved-search');
  assert.equal(source.coverageLabel, 'All active criteria');
  assert.equal(source.stableIdCount, 118);
  assert.equal(source.listingUrlCount, 120);

  const snapshot = buildNextSourceSnapshot(health, {}, '2026-08-10T17:00:00.000Z');
  assert.equal(snapshot.sources['deal-os-export'].coverageLabel, 'All active criteria');
  assert.equal(snapshot.sources['deal-os-export'].exportedAt, '2026-08-10T15:00:00.000Z');
});

test('source health suppresses no-new-deals warning when a configured source fails', () => {
  const health = buildAcquisitionSourceHealth({
    now: new Date('2026-06-16T18:00:00.000Z'),
    config: {
      dealHunter: {
        dailyEmail: {
          time: '10:15',
          timezone: 'America/Los_Angeles',
        },
      },
    },
    review: {
      generatedAt: '2026-06-16T18:00:00.000Z',
      totals: {
        newDeals: 0,
      },
      sources: [
        {
          id: 'sheet-0',
          name: 'SMB Deal Hunter Google Sheet',
          mode: 'csv',
          fetched: true,
          rowCount: 982,
        },
        {
          id: 'airtable-shared',
          name: 'Airtable Biz List',
          mode: 'shared-view',
          fetched: false,
          rowCount: 0,
          error: 'Airtable shared view is too large to import safely.',
          requiresConfiguration: true,
          configurationKey: 'DEAL_HUNTER_AIRTABLE_TOKEN',
        },
      ],
    },
  });
  const airtableStatus = health.sources.find((source) => source.id === 'airtable-shared');

  assert.equal(health.healthy, false);
  assert.equal(airtableStatus.tone, 'warning');
  assert.equal(airtableStatus.requiresConfiguration, true);
  assert.equal(airtableStatus.configurationKey, 'DEAL_HUNTER_AIRTABLE_TOKEN');
  assert.equal(health.issues.some((issue) => issue.sourceId === 'airtable-shared'), true);
  assert.equal(health.issues.some((issue) => issue.sourceId === 'daily-update-window'), false);
});

test('source health snapshot preserves last healthy row count when a source drops', () => {
  const previousSnapshot = {
    dateKey: '2026-06-15',
    sources: {
      'sheet-0': {
        rowCount: 100,
        name: 'SMB Deal Hunter Google Sheet',
        mode: 'csv',
        checkedAt: '2026-06-15T18:00:00.000Z',
      },
    },
  };
  const sourceHealth = buildAcquisitionSourceHealth({
    now: new Date('2026-06-16T18:00:00.000Z'),
    config: {
      dealHunter: {
        dailyEmail: {
          time: '10:15',
          timezone: 'America/Los_Angeles',
        },
      },
    },
    previousSnapshot,
    review: {
      generatedAt: '2026-06-16T18:00:00.000Z',
      totals: {
        newDeals: 4,
      },
      sources: [
        {
          id: 'sheet-0',
          name: 'SMB Deal Hunter Google Sheet',
          mode: 'csv',
          fetched: true,
          rowCount: 60,
        },
      ],
    },
  });
  const nextSnapshot = buildNextSourceSnapshot(sourceHealth, previousSnapshot, '2026-06-16T18:01:00.000Z');

  assert.equal(nextSnapshot.sources['sheet-0'].rowCount, 100);
  assert.equal(nextSnapshot.sources['sheet-0'].checkedAt, '2026-06-15T18:00:00.000Z');
});

test('read-only source health checks do not persist source snapshots', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-source-health-'));
  const snapshotPath = path.join(tempDir, 'source-health.json');
  const previousSnapshotPath = process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH;
  process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = snapshotPath;

  try {
    const sourceHealth = await getSourceHealth(
      {},
      {
        persistSnapshot: false,
        review: {
          generatedAt: '2026-06-16T18:00:00.000Z',
          totals: {
            newDeals: 2,
          },
          sources: [
            {
              id: 'sheet-0',
              name: 'SMB Deal Hunter Google Sheet',
              mode: 'csv',
              fetched: true,
              rowCount: 100,
            },
          ],
        },
      },
    );

    assert.equal(sourceHealth.sources[0].rowCount, 100);
    assert.equal(fs.existsSync(snapshotPath), false);
  } finally {
    if (previousSnapshotPath === undefined) {
      delete process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH;
    } else {
      process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = previousSnapshotPath;
    }
  }
});

test('source health uses cached snapshot unless explicitly refreshed', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-source-health-cache-'));
  const snapshotPath = path.join(tempDir, 'source-health.json');
  const previousSnapshotPath = process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH;
  process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = snapshotPath;
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({
      generatedAt: '2026-06-16T18:00:00.000Z',
      dateKey: '2026-06-16',
      issues: [],
      totals: { reviewedDeals: 42 },
      sources: {
        'sheet-0': {
          rowCount: 982,
          name: 'SMB Deal Hunter Google Sheet',
          mode: 'csv',
          checkedAt: '2026-06-16T18:00:00.000Z',
        },
      },
    }),
  );

  try {
    const sourceHealth = await getSourceHealth(
      {
        async listDealHunterSeenDeals() {
          throw new Error('live source review should not run');
        },
      },
      { persistSnapshot: true },
    );

    assert.equal(sourceHealth.cached, true);
    assert.equal(sourceHealth.healthy, true);
    assert.equal(sourceHealth.sources[0].rowCount, 982);
    assert.equal(sourceHealth.totals.reviewedDeals, 42);
  } finally {
    if (previousSnapshotPath === undefined) {
      delete process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH;
    } else {
      process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = previousSnapshotPath;
    }
  }
});

test('cached source health recomputes Deal OS export age and fails stale imports closed', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-source-health-deal-os-cache-'));
  const snapshotPath = path.join(tempDir, 'source-health.json');
  const previousSnapshotPath = process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH;
  process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = snapshotPath;
  const exportedAt = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({
      generatedAt: new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString(),
      issues: [],
      sources: {
        'deal-os-export': {
          rowCount: 120,
          name: 'SMB Deal OS export',
          mode: 'manual-export',
          checkedAt: new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString(),
          exportedAt,
          importedAt: exportedAt,
          importedBy: 'mathew@example.com',
          importAgeHours: 1,
          maxAgeHours: 72,
          scope: 'saved-search',
          coverageLabel: 'All active criteria',
        },
      },
    }),
  );

  try {
    const sourceHealth = await getSourceHealth({}, { persistSnapshot: false });
    const source = sourceHealth.sources[0];

    assert.equal(sourceHealth.cached, true);
    assert.equal(sourceHealth.healthy, false);
    assert.equal(source.fetched, false);
    assert.equal(source.tone, 'danger');
    assert.ok(source.importAgeHours >= 73);
    assert.match(source.error, /72-hour freshness limit/);
    assert.equal(sourceHealth.issues.some((issue) => issue.sourceId === 'deal-os-export'), true);
  } finally {
    if (previousSnapshotPath === undefined) {
      delete process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH;
    } else {
      process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = previousSnapshotPath;
    }
  }
});

test('command center action queue ignores passed records', () => {
  const actions = buildActionQueue([
    {
      id: 'passed-1',
      company: 'Passed Route Co',
      score: 88,
      pipelineStage: 'passed',
      brokerEmail: 'broker@example.com',
      followUpPrompt: {
        severity: 'warning',
        title: 'Follow up with broker',
        message: 'This should not show.',
      },
      readiness: {
        score: 20,
        missing: [{ label: 'Documents received' }],
      },
    },
    {
      id: 'active-1',
      company: 'Active HVAC Co',
      score: 91,
      pipelineStage: 'new-fit',
      brokerEmail: 'broker@example.com',
      createdAt: '2026-06-16T15:00:00.000Z',
      readiness: {
        score: 0,
        missing: [],
      },
    },
  ]);

  assert.equal(actions.some((action) => action.record?.id === 'passed-1'), false);
  assert.equal(actions.some((action) => action.record?.id === 'active-1'), true);
});

test('passing a command center record atomically archives it and completes CRM follow-up state', async () => {
  let capturedUpdate = null;
  const storage = {
    async getSubmission(id) {
      return {
        id,
        metadata: {
          diligence: {
            stage: 'not-started',
            decision: 'undecided',
          },
        },
      };
    },
    async mutateWithCrmActivity({ operation, payload, activity }) {
      assert.equal(operation, 'archive_submission');
      assert.equal(activity.event_type, 'submission.archived');
      capturedUpdate = payload.values;
      return { applied: true, record: { id: payload.id, ...payload.values }, activity };
    },
  };

  const result = await updateAcquisitionCommandCenterRecord({
    submissionId: 'submission-1',
    passReason: 'too-expensive',
    updatedBy: 'codex-test',
    storage,
  });

  assert.equal(result.ok, true);
  assert.equal(result.archived, true);
  assert.equal(capturedUpdate.status, 'archived');
  assert.equal(capturedUpdate.archive_reason, 'valuation');
  assert.equal(capturedUpdate.follow_up_state, 'completed');
  assert.equal(capturedUpdate.next_action_at, null);
  assert.equal(capturedUpdate.metadata.acquisitionCommand.pipelineStage, 'passed');
  assert.equal(capturedUpdate.metadata.acquisitionCommand.passReason, 'too-expensive');
  assert.equal(capturedUpdate.metadata.diligence.stage, 'passed');
  assert.equal(capturedUpdate.metadata.diligence.decision, 'pass');
});
