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

test('passing a command center record completes CRM follow-up state', async () => {
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
    async updateSubmission(id, values) {
      capturedUpdate = values;
      return { id, ...values };
    },
  };

  const result = await updateAcquisitionCommandCenterRecord({
    submissionId: 'submission-1',
    passReason: 'too-expensive',
    updatedBy: 'codex-test',
    storage,
  });

  assert.equal(result.ok, true);
  assert.equal(capturedUpdate.follow_up_state, 'completed');
  assert.equal(capturedUpdate.metadata.acquisitionCommand.pipelineStage, 'passed');
  assert.equal(capturedUpdate.metadata.acquisitionCommand.passReason, 'too-expensive');
  assert.equal(capturedUpdate.metadata.diligence.stage, 'passed');
  assert.equal(capturedUpdate.metadata.diligence.decision, 'pass');
});
