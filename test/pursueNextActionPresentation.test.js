import assert from 'node:assert/strict';
import test from 'node:test';

import { pursueNextActionPresentation } from '../src/components/admin/brokerMaterialsPresentation.js';

function action(brokerMaterials, overrides = {}) {
  return pursueNextActionPresentation({
    brokerMaterials,
    linkedCrmId: 'crm-1',
    opportunity: {},
    ...overrides,
  });
}

test('Pursue next action starts with explicit owner and CRM prerequisites', () => {
  assert.deepEqual(action({ pursued: false }), {
    kind: 'Next action',
    title: 'Record Pursue to begin the materials handoff',
    detail: 'Pursue establishes current owner intent before request preparation.',
  });
  assert.equal(action({ pursued: true }, { linkedCrmId: '' }).title, 'Create or link the CRM record');
  assert.equal(action({ pursued: true }, { opportunity: { dismissed: true } }).title,
    'Restore this opportunity for review');
});

test('Pursue next action reflects current recipient, prerequisite, and pause authority', () => {
  assert.equal(action({ pursued: true, recipientOptions: [{}, {}] }).title,
    'Select the authoritative broker recipient');
  assert.deepEqual(action({ pursued: true, preparationBlockers: [{ message: 'No current recipient.' }] }), {
    kind: 'Waiting reason', title: 'Resolve the current prerequisite', detail: 'No current recipient.',
  });
  assert.deepEqual(action({ pursued: true, sendBlockers: [{ message: 'Outreach is paused.' }] }), {
    kind: 'Next action', title: 'Review the bounded campaign authorization',
    detail: 'Sending remains unavailable: Outreach is paused.',
  });
});

test('Pursue next action presents durable request outcomes without encouraging duplicates', () => {
  const cases = [
    [{ status: 'responded' }, 'Next action', 'Review the broker reply'],
    [{ status: 'ambiguous' }, 'Waiting reason', 'Review the ambiguous delivery result'],
    [{ status: 'failed' }, 'Next action', 'Resolve the delivery issue'],
    [{ status: 'sent' }, 'Waiting reason', 'Wait for the broker response'],
  ];
  for (const [existingRequest, kind, title] of cases) {
    const result = action({ pursued: true, existingRequest });
    assert.equal(result.kind, kind);
    assert.equal(result.title, title);
  }
  assert.equal(action({ pursued: true, existingRequest: { status: 'ambiguous' },
    attachmentStatus: { inbound: { status: 'metadata_observed', count: 1 }, vault: { status: 'available', count: 1 } } }).title,
    'Review the ambiguous delivery result');
  assert.equal(action({ pursued: true, existingRequest: { status: 'sent' },
    attachmentStatus: { inbound: { status: 'pending', count: 1 } } }).title,
    'Wait for the broker response');
  assert.equal(action({ pursued: true }, { pursueCimReleaseAvailable: true,
    cimRelease: { campaign: { id: 'campaign-1' }, status: { actionRequired: true } } }).title,
    'Review the durable CIM campaign status');
  assert.equal(action({ pursued: false }, { pursueCimReleaseAvailable: true,
    cimRelease: { decision: { disposition: 'watch' }, campaign: null } }).title,
    'Record Pursue to begin the materials handoff');
  assert.equal(action({ pursued: false }, { pursueCimReleaseAvailable: true, cimRelease: null }).title,
    'Wait for durable CIM status');
  const campaign = { id: 'campaign-1' };
  assert.equal(action({ pursued: true }, { cimRelease: { campaign,
    status: { code: 'responded', actionRequired: false } } }).title, 'Review the broker reply');
  assert.equal(action({ pursued: true }, { cimRelease: { campaign,
    status: { code: 'materials_received', actionRequired: false } } }).title,
    'Review received broker materials');
  assert.deepEqual(action({ pursued: true }, { cimRelease: { campaign,
    status: { code: 'expired', actionRequired: false } } }), {
    kind: 'Next action', title: 'Review the unanswered opportunity',
    detail: 'The bounded four-week email campaign expired without a reply or CIM. Decide whether a phone call is appropriate; no further email is scheduled.',
  });
  assert.equal(action({ pursued: true }, { cimRelease: { campaign,
    status: { code: 'provider_pending', actionRequired: true } } }).title,
    'Reconcile the pending provider outcome');
  assert.equal(action({ pursued: true }, { cimRelease: { campaign,
    status: { code: 'provider_ambiguous', actionRequired: true } } }).title,
    'Reconcile the ambiguous provider outcome');
  assert.equal(action({ pursued: true, attachmentStatus: {
    inbound: { status: 'metadata_observed', count: 1 }, vault: { status: 'available', count: 1 },
  } }, { cimRelease: { campaign,
    status: { code: 'provider_ambiguous', actionRequired: true } } }).title,
    'Reconcile the ambiguous provider outcome');
  assert.equal(action({ pursued: true, attachmentStatus: {
    inbound: { status: 'metadata_observed', count: 1 },
  } }, { cimRelease: { campaign,
    status: { code: 'provider_definitive_failure', actionRequired: true } } }).title,
    'Review the durable CIM campaign status');
});

test('Pursue next action describes one bounded approval without implying per-message review', () => {
  assert.deepEqual(action({ pursued: true }), {
    kind: 'Next action', title: 'Review the bounded campaign authorization',
    detail: 'Approve the verified recipient and campaign policy once. Every touch still requires current safety authority; live sending remains separately gated.',
  });
});

test('Pursue next action does not overstate attachment readiness', () => {
  const cases = [
    [{ inbound: { status: 'pending', count: 1 } }, 'Waiting reason', 'Wait for attachment retrieval'],
    [{ inbound: { status: 'error', count: 1 } }, 'Waiting reason', 'Resolve the attachment retrieval failure'],
    [{ inbound: { status: 'metadata_observed', count: 1 } }, 'Next action', 'Confirm attachment retrieval and scanning'],
    [{ inbound: { status: 'none' }, vault: { status: 'available', count: 1 } }, 'Next action', 'Confirm document scan and owner-review status'],
  ];
  for (const [attachmentStatus, kind, title] of cases) {
    const result = action({ pursued: true, existingRequest: { status: 'responded' }, attachmentStatus });
    assert.equal(result.kind, kind);
    assert.equal(result.title, title);
  }
  assert.equal(action({ pursued: true, existingRequest: { status: 'responded' }, attachmentStatus: {
    inbound: { status: 'error', count: 1 }, vault: { status: 'available', count: 1 },
  } }).title, 'Resolve the attachment retrieval failure');
});
