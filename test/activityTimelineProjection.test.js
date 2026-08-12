import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCrmActivityTimeline } from '../server/services/activity.js';

function lifecycle(id, type, messageId, createdAt, overrides = {}) {
  return {
    id,
    submission_id: 'submission-1',
    opportunity_id: 'opportunity-1',
    created_at: createdAt,
    actor: 'email-provider',
    role: 'system',
    event_type: `email.${type}`,
    summary: `Email ${type}: CIM request`,
    metadata: { provider: 'resend', messageId, communicationId: `communication-${messageId}`, subject: 'CIM request', ...overrides },
  };
}

test('timeline groups one logical lifecycle and preserves all provider audit events', () => {
  const events = [
    lifecycle('local', 'sent', 'message-1', '2026-08-12T10:00:00.000Z'),
    lifecycle('webhook-sent', 'sent', 'message-1', '2026-08-12T10:00:01.000Z'),
    lifecycle('webhook-delivered', 'delivered', 'message-1', '2026-08-12T10:00:02.000Z'),
  ];
  const result = projectCrmActivityTimeline(events);
  assert.equal(result.counts.logicalEmails, 1);
  assert.equal(result.counts.rawEmailEvents, 3);
  assert.equal(result.events[0].event_type, 'email.delivered');
  assert.equal(result.events[0].metadata.auditEvents.length, 3);
});
test('timeline keeps different provider ids and blank-id legacy events separate', () => {
  const sameSubject = [
    lifecycle('one', 'delivered', 'message-1', '2026-08-12T10:00:00.000Z'),
    lifecycle('two', 'delivered', 'message-2', '2026-08-12T10:00:00.500Z'),
    lifecycle('blank-one', 'sent', '', '2026-08-12T10:00:01.000Z', { communicationId: '' }),
    lifecycle('blank-two', 'sent', '', '2026-08-12T10:00:02.000Z', { communicationId: '' }),
  ];
  const result = projectCrmActivityTimeline(sameSubject);
  assert.equal(result.counts.logicalEmails, 2);
  assert.equal(result.events.length, 4);
  assert.equal(result.events.filter((event) => !event.metadata?.logicalMessage).length, 2);
});

test('timeline lifecycle precedence retains complaint, bounce, reply, delay, and failure visibility', () => {
  for (const [highest, states] of [
    ['complained', ['sent', 'delivered', 'complained']],
    ['bounced', ['sent', 'delivered', 'bounced']],
    ['failed', ['sent', 'failed']],
    ['replied', ['sent', 'delivered', 'replied']],
    ['delayed', ['sent', 'delayed']],
    ['suppressed', ['sent', 'suppressed']],
  ]) {
    const result = projectCrmActivityTimeline(states.map((state, index) => lifecycle(`${highest}-${index}`, state, highest, `2026-08-12T10:00:0${index}.000Z`)));
    assert.equal(result.events[0].event_type, `email.${highest}`);
  }
});
