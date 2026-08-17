import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  communicationLimits,
  createManualCommunication,
  listCrmCommunications,
} from '../server/services/communications.js';
import { createManualSubmission } from '../server/services/submissions.js';

function testStorage(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-manual-communications-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return storage;
}

async function lead(storage) {
  const result = await createManualSubmission({
    company: 'Manual Communication Co',
    lead_type: 'broker',
    broker_name: 'Robin Broker',
    broker_email: 'robin@example.com',
    status: 'review',
    follow_up_state: 'needs-response',
  }, 'communications-admin', { storage });
  assert.equal(result.ok, true);
  return result.submission;
}

test('manual communication logging stores safe first-class content and durable summary-only activity', async (t) => {
  const storage = testStorage(t);
  const submission = await lead(storage);
  const expectedSubmissionUpdatedAt = submission.updated_at;
  const occurredAt = '2026-08-05T19:30:00.000Z';
  const body = 'Broker confirmed the NDA is coming tomorrow. Keep the complete detail here, not in generic audit metadata.';
  const result = await createManualCommunication({
    submissionId: submission.id,
    actor: 'communications-admin',
    storage,
    input: {
      direction: 'inbound',
      channel: 'phone',
      occurredAt,
      fromAddress: 'Robin Broker',
      toAddresses: ['Matt Uckele'],
      subject: 'NDA timing call',
      body,
      bodyHtmlSanitized: '<img src=x onerror="alert(1)">',
      status: 'contacted',
      followUpState: 'waiting-on-owner',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.communication.body_text, body);
  assert.equal(result.communication.body_html_sanitized, '');
  assert.equal(result.communication.channel, 'phone');
  assert.equal(result.communication.occurred_at, occurredAt);
  assert.equal(result.communication.source, 'manual');
  assert.equal(result.communication.from_address, null);
  assert.deepEqual(result.communication.to_addresses, []);
  assert.equal(result.communication.metadata.manualParticipants.from, 'Robin Broker');
  assert.deepEqual(result.communication.metadata.manualParticipants.to, ['Matt Uckele']);
  assert.equal(result.communication.metadata.workflowUpdate.state, 'applied');
  assert.equal(result.communication.metadata.workflowUpdate.expectedSubmissionUpdatedAt, expectedSubmissionUpdatedAt);
  assert.equal(result.communication.metadata.workflowUpdate.warning, '');
  assert.equal(result.workflowUpdated, true);
  assert.equal(result.workflowWarning, '');
  assert.equal(result.partialSuccess, false);
  assert.equal(result.submission.status, 'contacted');
  assert.equal(result.submission.follow_up_state, 'waiting-on-owner');

  const listed = await listCrmCommunications({ submissionId: submission.id, storage });
  assert.equal(listed.total, 1);
  assert.equal(listed.rows[0].id, result.communication.id);
  const activity = await storage.listCrmActivityEvents({ submissionId: submission.id, limit: 100 });
  const created = activity.find((event) => event.event_type === 'communication.created');
  const workflow = activity.find((event) => event.event_type === 'communication.workflow-updated');
  assert.ok(created);
  assert.ok(workflow);
  assert.equal(created.metadata.communicationId, result.communication.id);
  assert.equal(JSON.stringify(activity).includes(body), false, 'message body must stay out of generic activity metadata');
});

test('manual communication remains a durable success and reloadable warning when its optional workflow CAS conflicts', async (t) => {
  const storage = testStorage(t);
  const submission = await lead(storage);
  const expectedSubmissionUpdatedAt = submission.updated_at;
  const originalMutation = storage.mutateWithCrmActivity.bind(storage);
  let workflowMutationObserved = false;

  storage.mutateWithCrmActivity = async (options) => {
    if (options.operation === 'update_submission' && options.activity?.event_type === 'communication.workflow-updated') {
      workflowMutationObserved = true;
      assert.equal(options.payload.expectedUpdatedAt, expectedSubmissionUpdatedAt);
      const concurrentUpdatedAt = new Date(Date.parse(expectedSubmissionUpdatedAt) + 1000).toISOString();
      const concurrentlyUpdated = await storage.updateSubmissionIfCurrent(submission.id, expectedSubmissionUpdatedAt, {
        updated_at: concurrentUpdatedAt,
        notes: 'Concurrent administrator edit.',
      });
      assert.ok(concurrentlyUpdated);
    }
    return originalMutation(options);
  };

  const body = 'The broker confirmed a call for tomorrow.';
  const result = await createManualCommunication({
    submissionId: submission.id,
    actor: 'communications-admin',
    storage,
    input: {
      direction: 'inbound',
      channel: 'phone',
      occurredAt: '2026-08-06T20:00:00.000Z',
      fromAddress: 'Robin Broker',
      subject: 'Broker scheduling call',
      body,
      status: 'contacted',
      followUpState: 'completed',
    },
  });

  assert.equal(workflowMutationObserved, true);
  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(result.error, undefined);
  assert.equal(result.workflowUpdated, false);
  assert.equal(result.partialSuccess, true);
  assert.ok(result.workflowWarning);
  assert.ok(result.workflowWarning.length <= communicationLimits.maxWorkflowWarningLength);
  assert.match(result.workflowWarning, /communication logged/i);
  assert.match(result.workflowWarning, /record changed/i);

  const currentSubmission = await storage.getSubmission(submission.id);
  assert.equal(currentSubmission.status, 'review');
  assert.equal(currentSubmission.follow_up_state, 'needs-response');
  assert.equal(currentSubmission.notes, 'Concurrent administrator edit.');

  const reloaded = await listCrmCommunications({ submissionId: submission.id, storage });
  assert.equal(reloaded.total, 1, 'the caller must not need to submit the communication again');
  assert.equal(reloaded.rows[0].body_text, body);
  assert.equal(reloaded.rows[0].metadata.workflowUpdate.state, 'conflict');
  assert.equal(reloaded.rows[0].metadata.workflowUpdate.warning, result.workflowWarning);
  assert.equal(reloaded.rows[0].metadata.workflowUpdate.expectedSubmissionUpdatedAt, expectedSubmissionUpdatedAt);

  const activity = await storage.listCrmActivityEvents({ submissionId: submission.id, limit: 100 });
  assert.equal(activity.filter((event) => event.event_type === 'communication.created').length, 1);
  assert.equal(activity.some((event) => event.event_type === 'communication.workflow-updated'), false);
  assert.equal(JSON.stringify(activity).includes(body), false, 'message body must stay out of generic activity metadata');
});

test('manual communication remains successful and does not expose secondary workflow errors', async (t) => {
  const storage = testStorage(t);
  const submission = await lead(storage);
  const originalMutation = storage.mutateWithCrmActivity.bind(storage);
  const sensitiveSecondaryError = 'workflow database failed while handling confidential broker body';

  storage.mutateWithCrmActivity = async (options) => {
    if (options.operation === 'update_submission' && options.activity?.event_type === 'communication.workflow-updated') {
      throw new Error(sensitiveSecondaryError);
    }
    return originalMutation(options);
  };

  const result = await createManualCommunication({
    submissionId: submission.id,
    actor: 'communications-admin',
    storage,
    input: {
      direction: 'inbound',
      channel: 'note',
      occurredAt: '2026-08-06T20:00:00.000Z',
      body: 'Durable communication content.',
      followUpState: 'completed',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(result.workflowUpdated, false);
  assert.equal(result.partialSuccess, true);
  assert.match(result.workflowWarning, /communication logged/i);
  assert.equal(JSON.stringify(result).includes(sensitiveSecondaryError), false);

  const reloaded = await listCrmCommunications({ submissionId: submission.id, storage });
  assert.equal(reloaded.total, 1);
  assert.equal(reloaded.rows[0].metadata.workflowUpdate.state, 'failed');
  assert.equal(reloaded.rows[0].metadata.workflowUpdate.warning, result.workflowWarning);
  assert.equal(JSON.stringify(reloaded.rows[0]).includes(sensitiveSecondaryError), false);
});

test('manual communication validation enforces body and outbound-recipient bounds before writing', async (t) => {
  const storage = testStorage(t);
  const submission = await lead(storage);
  for (const bodyField of ['body', 'bodyText', 'body_text']) {
    const oversized = await createManualCommunication({
      submissionId: submission.id,
      actor: 'communications-admin',
      storage,
      input: {
        direction: 'inbound',
        channel: 'note',
        [bodyField]: 'x'.repeat(communicationLimits.maxBodyTextLength + 1),
      },
    });
    assert.equal(oversized.ok, false, `${bodyField} must not be silently truncated`);
    assert.equal(oversized.status, 413);
  }

  const tooManyRecipients = await createManualCommunication({
    submissionId: submission.id,
    actor: 'communications-admin',
    storage,
    input: {
      direction: 'outbound',
      channel: 'email',
      toAddresses: Array.from({ length: communicationLimits.maxAddressCount + 1 }, (_, index) => `person-${index}@example.com`),
      subject: 'Too many recipients',
      bodyText: 'This must be rejected before normalization.',
    },
  });
  assert.equal(tooManyRecipients.ok, false);
  assert.equal(tooManyRecipients.status, 413);

  const noRecipient = await createManualCommunication({
    submissionId: submission.id,
    actor: 'communications-admin',
    storage,
    input: {
      direction: 'outbound',
      channel: 'email',
      subject: 'Missing recipient',
      body: 'This must not be saved.',
    },
  });
  assert.equal(noRecipient.ok, false);
  assert.equal(noRecipient.status, 400);

  for (const occurredAt of ['', 'not-a-date']) {
    const invalidOccurrence = await createManualCommunication({
      submissionId: submission.id,
      actor: 'communications-admin',
      storage,
      input: {
        direction: 'inbound',
        channel: 'note',
        occurredAt,
        body: 'A direct API caller must provide the real occurrence time.',
      },
    });
    assert.equal(invalidOccurrence.ok, false);
    assert.equal(invalidOccurrence.status, 400);
    assert.match(invalidOccurrence.error, /occurrence date and time/i);
  }
  const listed = await listCrmCommunications({ submissionId: submission.id, storage });
  assert.equal(listed.total, 0);
});
