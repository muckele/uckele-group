import assert from 'node:assert/strict';
import test from 'node:test';
import { PURSUIT_STAGES } from '../server/storage/pursuitTrackerStorageContract.js';
import { buildGmailThreadUrl, foldPursuitStage, STAGE_LABELS, stageAfterReplyType } from '../server/services/pursuitTracker.js';

const T0 = '2026-11-01T09:00:00.000Z';
const at = (time) => `2026-11-02T${time}:00.000Z`;

// A normalized PursuitBundle (Task 2) for a deal pursued at T0; each test overrides what it needs.
function makeBundle(overrides = {}) {
  return {
    opportunityId: 'opp-1',
    name: 'Acme Plumbing',
    opportunityStatus: 'active',
    decisions: [{ id: 'd1', action: 'pursue', createdAt: T0 }],
    campaign: { id: 'c1', state: 'active-follow-up', reasonCode: null, crmSubmissionId: null,
      conversationId: 'conv-1', gmailThreadId: '18c1a2b3d4e5f607' },
    replies: [],
    documents: [],
    crm: null,
    events: [],
    ...overrides,
  };
}

const reply = (id, processedAt, classification = 'reply', messageAt = processedAt) =>
  ({ gmailMessageId: id, classification, processedAt, messageAt });
const document = (id, createdAt, documentType = 'cim') =>
  ({ id, documentType, originalName: 'x.pdf', sizeBytes: 10, createdAt });
const crm = (fields) => ({ diligenceStage: null, diligenceUpdatedAt: null, pipelineStage: null,
  pipelineUpdatedAt: null, ...fields });
function ownerEvent(id, createdAt, fields) {
  return { id, idempotencyKey: id, opportunityId: 'opp-1', previousEventId: null, kind: 'stage-move',
    replyType: null, fromStage: 'cim-requested', stage: 'cim-requested', acknowledgedReplyId: null,
    acknowledgedProcessedAt: null, secureDocumentId: null, actor: 'owner@uckele.test',
    policyVersion: 'pursuit-tracker-v1', createdAt, ...fields };
}
const pick = (projection) => ({ member: projection.member, passedInDealHunter: projection.passedInDealHunter,
  stage: projection.stage });

// --- §5.2: one test per row ---------------------------------------------------------------

test('fold: latest pursue decision → starts at cim-requested', () => {
  const projection = foldPursuitStage(makeBundle());
  assert.deepEqual(projection, { member: true, passedInDealHunter: false, stage: 'cim-requested',
    stageSince: T0, stageSource: 'evidence', needsAction: null, lastReplyAt: null, latestEventId: 'genesis',
    replyCount: 0 });
});

for (const classification of ['reply', 'stop']) {
  test(`fold: gmail row classified ${classification} → moves forward to broker-replied and needs action`, () => {
    const projection = foldPursuitStage(makeBundle({ replies: [reply('R1', at('10:00'), classification, at('09:30'))] }));
    assert.equal(projection.stage, 'broker-replied');
    assert.equal(projection.stageSince, at('10:00'));
    assert.equal(projection.stageSource, 'evidence');
    assert.deepEqual(projection.needsAction, { reason: 'reply', at: at('10:00'), replyId: 'R1', classification });
    assert.equal(projection.lastReplyAt, at('09:30'));
    assert.equal(projection.replyCount, 1);
  });
}

test('fold: gmail row classified bounce → no stage change; needs action only while action-required/recipient_bounced', () => {
  const bounced = makeBundle({
    replies: [reply('B1', at('10:00'), 'bounce')],
    campaign: { id: 'c1', state: 'action-required', reasonCode: 'recipient_bounced', crmSubmissionId: null,
      conversationId: 'conv-1', gmailThreadId: null },
  });
  const projection = foldPursuitStage(bounced);
  assert.equal(projection.stage, 'cim-requested');
  assert.deepEqual(projection.needsAction, { reason: 'bounce', at: at('10:00'), replyId: 'B1', classification: 'bounce' });
  assert.equal(projection.replyCount, 0);
});

for (const classification of ['owner', 'auto-reply', 'ours']) {
  test(`fold: gmail row classified ${classification} → no stage change and no attention`, () => {
    const projection = foldPursuitStage(makeBundle({ replies: [reply('X1', at('10:00'), classification)] }));
    assert.equal(projection.stage, 'cim-requested');
    assert.equal(projection.needsAction, null);
    assert.equal(projection.replyCount, 0);
    assert.equal(projection.lastReplyAt, null);
  });
}

test('fold: CIM-type secure document → moves forward to cim-received', () => {
  for (const documentType of ['cim', 'teaser', 'prospectus', 'offering_memorandum', 'offering_materials', 'data_room', 'broker_materials']) {
    const projection = foldPursuitStage(makeBundle({ documents: [document('doc-1', at('11:00'), documentType)] }));
    assert.equal(projection.stage, 'cim-received', documentType);
    assert.equal(projection.stageSince, at('11:00'));
  }
});

const crmDiligenceRows = [
  ['cim-requested', 'cim-requested'], ['nda-sent', 'nda-sent'], ['cim-received', 'cim-received'],
  ['financial-review', 'financial-review'], ['lender-review', 'financial-review'],
  ['loi-candidate', 'loi-candidate'], ['passed', 'passed'], ['not-started', 'cim-requested'],
];
for (const [diligenceStage, expected] of crmDiligenceRows) {
  test(`fold: CRM diligence.stage ${diligenceStage} → ${expected === 'cim-requested' && diligenceStage !== 'cim-requested' ? 'none' : expected}`, () => {
    const projection = foldPursuitStage(makeBundle({ crm: crm({ diligenceStage, diligenceUpdatedAt: at('12:00') }) }));
    assert.equal(projection.stage, expected);
  });
}

const crmPipelineRows = [
  ['cim-requested', 'cim-requested'], ['broker-replied', 'broker-replied'], ['docs-received', 'cim-received'],
  ['diligence', 'financial-review'], ['loi-candidate', 'loi-candidate'], ['passed', 'passed'],
  ['new-fit', 'cim-requested'],
];
for (const [pipelineStage, expected] of crmPipelineRows) {
  test(`fold: CRM pipelineStage ${pipelineStage} → ${pipelineStage === 'new-fit' ? 'none' : expected}`, () => {
    const projection = foldPursuitStage(makeBundle({ crm: crm({ pipelineStage, pipelineUpdatedAt: at('12:00') }) }));
    assert.equal(projection.stage, expected);
  });
}

test('fold: owner stage-move → sets exactly that stage, in either direction, and acknowledges', () => {
  const forwardMove = foldPursuitStage(makeBundle({
    replies: [reply('R1', at('10:00'))],
    events: [ownerEvent('e1', at('11:00'), { kind: 'stage-move', fromStage: 'broker-replied', stage: 'loi-candidate',
      acknowledgedReplyId: 'R1', acknowledgedProcessedAt: at('10:00') })],
  }));
  assert.equal(forwardMove.stage, 'loi-candidate');
  assert.equal(forwardMove.stageSource, 'owner');
  assert.equal(forwardMove.stageSince, at('11:00'));
  assert.equal(forwardMove.needsAction, null);
  assert.equal(forwardMove.latestEventId, 'e1');

  const backward = foldPursuitStage(makeBundle({
    documents: [document('doc-1', at('09:30'))],
    events: [ownerEvent('e1', at('11:00'), { kind: 'stage-move', fromStage: 'cim-received', stage: 'broker-replied' })],
  }));
  assert.equal(backward.stage, 'broker-replied');
  assert.equal(backward.stageSource, 'owner');
});

const replyTypeRows = [
  ['not-available', 'financial-review', 'passed'],
  ['nda-requested', 'cim-requested', 'nda-sent'],
  ['nda-requested', 'cim-received', 'cim-received'],
  ['sim-received', 'broker-replied', 'cim-received'],
  ['sim-received', 'loi-candidate', 'loi-candidate'],
  ['question', 'cim-requested', 'broker-replied'],
  ['other', 'cim-requested', 'broker-replied'],
  ['question', 'nda-sent', 'nda-sent'],
];
for (const [replyType, before, after] of replyTypeRows) {
  test(`fold: owner reply-type ${replyType} from ${before} → ${after} and acknowledges`, () => {
    const stageMove = before === 'cim-requested' ? [] : [ownerEvent('e0', at('10:00'), { kind: 'stage-move',
      fromStage: 'cim-requested', stage: before })];
    const projection = foldPursuitStage(makeBundle({
      replies: [reply('R1', at('10:30'))],
      events: [...stageMove, ownerEvent('e1', at('11:00'), { kind: 'reply-type', replyType, fromStage: before,
        stage: after, acknowledgedReplyId: 'R1', acknowledgedProcessedAt: at('10:30') })],
    }));
    assert.equal(projection.stage, after);
    assert.equal(projection.needsAction, null);
  });
}

test('fold: owner sim-intake → max(current, cim-received); acknowledges only if an ack id was sent', () => {
  const base = { replies: [reply('R1', at('10:00'))] };
  const withAck = foldPursuitStage(makeBundle({ ...base, events: [ownerEvent('e1', at('11:00'), { kind: 'sim-intake',
    secureDocumentId: 'doc-9', stage: 'cim-received', acknowledgedReplyId: 'R1', acknowledgedProcessedAt: at('10:00') })] }));
  assert.equal(withAck.stage, 'cim-received');
  assert.equal(withAck.stageSource, 'owner');
  assert.equal(withAck.needsAction, null);

  const withoutAck = foldPursuitStage(makeBundle({ ...base, events: [ownerEvent('e1', at('11:00'), { kind: 'sim-intake',
    secureDocumentId: 'doc-9', stage: 'cim-received' })] }));
  assert.equal(withoutAck.stage, 'cim-received');
  assert.equal(withoutAck.needsAction.replyId, 'R1');

  const ahead = foldPursuitStage(makeBundle({ events: [
    ownerEvent('e0', at('10:00'), { kind: 'stage-move', stage: 'loi-candidate' }),
    ownerEvent('e1', at('11:00'), { kind: 'sim-intake', secureDocumentId: 'doc-9', stage: 'loi-candidate' })] }));
  assert.equal(ahead.stage, 'loi-candidate');
  assert.equal(ahead.stageSince, at('10:00'));
});

test('fold: owner acknowledge → stage unchanged, acknowledges the reply', () => {
  const projection = foldPursuitStage(makeBundle({
    replies: [reply('R1', at('10:00'))],
    events: [ownerEvent('e1', at('11:00'), { kind: 'acknowledge', fromStage: 'broker-replied', stage: 'broker-replied',
      acknowledgedReplyId: 'R1', acknowledgedProcessedAt: at('10:00') })],
  }));
  assert.equal(projection.stage, 'broker-replied');
  assert.equal(projection.stageSource, 'evidence');
  assert.equal(projection.stageSince, at('10:00'));
  assert.equal(projection.needsAction, null);
});

// --- §5.1 membership and the rest of §5.2/§5.3 --------------------------------------------

test('fold: no decision, or a latest watch → not a member', () => {
  const none = foldPursuitStage(makeBundle({ decisions: [] }));
  assert.deepEqual(pick(none), { member: false, passedInDealHunter: false, stage: null });
  const watched = foldPursuitStage(makeBundle({
    decisions: [{ id: 'd1', action: 'pursue', createdAt: T0 }, { id: 'd2', action: 'watch', createdAt: at('08:00') }],
    events: [ownerEvent('e1', at('09:00'), {})],
  }));
  assert.deepEqual(pick(watched), { member: false, passedInDealHunter: false, stage: null });
  assert.equal(watched.latestEventId, 'e1');
  assert.equal(watched.needsAction, null);
});

test('fold: pass after pursue lists the deal as passed in Deal Hunter', () => {
  const projection = foldPursuitStage(makeBundle({
    decisions: [{ id: 'd1', action: 'pursue', createdAt: T0 }, { id: 'd2', action: 'pass', createdAt: at('08:00') }],
    replies: [reply('R1', at('07:00'))],
  }));
  assert.deepEqual(pick(projection), { member: true, passedInDealHunter: true, stage: 'passed' });
  assert.equal(projection.stageSince, at('08:00'));
  assert.equal(projection.needsAction, null);
  assert.equal(foldPursuitStage(makeBundle({ decisions: [{ id: 'd2', action: 'pass', createdAt: at('08:00') }] })).member, false);
});

test('fold: watch after pursue removes the deal; a second pursue after restore starts again at cim-requested and ignores older events and replies', () => {
  const decisions = [
    { id: 'd1', action: 'pursue', createdAt: T0 },
    { id: 'd2', action: 'watch', createdAt: '2026-11-01T12:00:00.000Z' },
    { id: 'd3', action: 'pursue', createdAt: at('08:00') },
  ];
  const bundle = makeBundle({
    decisions,
    replies: [reply('OLD', '2026-11-01T10:00:00.000Z'), reply('NEW', at('09:00'))],
    documents: [document('old-doc', '2026-11-01T11:00:00.000Z', 'cim')],
    crm: crm({ diligenceStage: 'nda-sent', diligenceUpdatedAt: '2026-11-01T11:30:00.000Z' }),
    events: [ownerEvent('e1', '2026-11-01T10:30:00.000Z', { kind: 'stage-move', stage: 'loi-candidate',
      acknowledgedReplyId: 'OLD', acknowledgedProcessedAt: '2026-11-01T10:00:00.000Z' })],
  });
  const projection = foldPursuitStage(bundle);
  // The old document and CRM stage are applied at the pursue instant; the old event and reply are dropped.
  assert.equal(projection.stage, 'cim-received');
  assert.equal(projection.stageSince, at('08:00'));
  assert.equal(projection.stageSource, 'evidence');
  assert.equal(projection.replyCount, 1);
  assert.equal(projection.needsAction.replyId, 'NEW');
  assert.equal(projection.latestEventId, 'e1');

  const fresh = foldPursuitStage({ ...bundle, documents: [], crm: null });
  assert.equal(fresh.stage, 'broker-replied');
});

test('fold: an item exactly at the pursue instant is kept', () => {
  const projection = foldPursuitStage(makeBundle({ replies: [reply('R1', T0)] }));
  assert.equal(projection.stage, 'broker-replied');
});

test('fold: evidence never moves backward or out of passed; only a stage-move reopens', () => {
  const backward = foldPursuitStage(makeBundle({
    crm: crm({ diligenceStage: 'financial-review', diligenceUpdatedAt: at('10:00'), pipelineStage: 'broker-replied',
      pipelineUpdatedAt: at('11:00') }),
    replies: [reply('R1', at('12:00'))],
  }));
  assert.equal(backward.stage, 'financial-review');
  assert.equal(backward.stageSince, at('10:00'));

  const passedBundle = makeBundle({
    events: [ownerEvent('e1', at('10:00'), { kind: 'reply-type', replyType: 'not-available', stage: 'passed' })],
    replies: [reply('R1', at('11:00'))],
    documents: [document('doc-1', at('11:30'))],
    crm: crm({ pipelineStage: 'loi-candidate', pipelineUpdatedAt: at('12:00') }),
  });
  const stuck = foldPursuitStage(passedBundle);
  assert.equal(stuck.stage, 'passed');
  assert.equal(stuck.stageSource, 'owner');
  assert.equal(stuck.stageSince, at('10:00'));

  const reopened = foldPursuitStage({ ...passedBundle, events: [...passedBundle.events,
    ownerEvent('e2', at('13:00'), { kind: 'stage-move', fromStage: 'passed', stage: 'broker-replied' })] });
  assert.equal(reopened.stage, 'broker-replied');
});

test('fold: sort key is instant, then system before owner, then id', () => {
  // Same instant: the system document moves to cim-received first, then the owner moves back.
  const projection = foldPursuitStage(makeBundle({
    documents: [document('doc-1', at('10:00'))],
    events: [ownerEvent('e1', at('10:00'), { kind: 'stage-move', stage: 'nda-sent' })],
  }));
  assert.equal(projection.stage, 'nda-sent');
  assert.equal(projection.stageSource, 'owner');
  // Owner events at one instant fold in id order.
  const byId = foldPursuitStage(makeBundle({ events: [
    ownerEvent('b', at('10:00'), { kind: 'stage-move', stage: 'loi-candidate' }),
    ownerEvent('a', at('10:00'), { kind: 'stage-move', stage: 'nda-sent' })] }));
  assert.equal(byId.stage, 'loi-candidate');
  assert.equal(byId.latestEventId, 'b');
});

test('fold: latestEventId is the chain tip, even when created_at is not monotonic along the chain', () => {
  // genesis -> z (10:00) -> m (09:00): m is the tip although z has the later created_at.
  const chain = foldPursuitStage(makeBundle({ events: [
    ownerEvent('z', at('10:00'), { previousEventId: 'genesis' }),
    ownerEvent('m', at('09:00'), { previousEventId: 'z' })] }));
  assert.equal(chain.latestEventId, 'm');
  // Several unreferenced events: the tie-break is (createdAt, id).
  const forked = foldPursuitStage(makeBundle({ events: [
    ownerEvent('b', at('10:00'), { previousEventId: 'genesis' }),
    ownerEvent('a', at('10:00'), { previousEventId: 'genesis' })] }));
  assert.equal(forked.latestEventId, 'b');
  assert.equal(foldPursuitStage(makeBundle()).latestEventId, 'genesis');
});

test('fold: a reply processed late with an older message_at still needs action', () => {
  const projection = foldPursuitStage(makeBundle({
    replies: [reply('R1', at('10:00'), 'reply', at('09:50')), reply('R0', at('10:05'), 'reply', at('09:00'))],
    events: [ownerEvent('e1', at('10:02'), { kind: 'acknowledge', fromStage: 'broker-replied', stage: 'broker-replied',
      acknowledgedReplyId: 'R1', acknowledgedProcessedAt: at('10:00') })],
  }));
  assert.equal(projection.needsAction.replyId, 'R0');
  assert.equal(projection.needsAction.at, at('10:05'));
});

test('fold: needsAction names the oldest unacknowledged row', () => {
  const projection = foldPursuitStage(makeBundle({ replies: [reply('R2', at('10:05')), reply('R1', at('10:00')),
    reply('R3', at('10:05'), 'stop')] }));
  assert.equal(projection.needsAction.replyId, 'R1');
  assert.equal(projection.replyCount, 3);
});

test('fold: acknowledgement is the largest acknowledged reply, not the newest event', () => {
  const projection = foldPursuitStage(makeBundle({
    replies: [reply('R1', at('10:00')), reply('R2', at('10:05')), reply('R3', at('10:10'))],
    events: [
      ownerEvent('e1', at('11:00'), { kind: 'acknowledge', fromStage: 'broker-replied', stage: 'broker-replied',
        acknowledgedReplyId: 'R2', acknowledgedProcessedAt: at('10:05') }),
      ownerEvent('e2', at('11:05'), { kind: 'acknowledge', fromStage: 'broker-replied', stage: 'broker-replied',
        acknowledgedReplyId: 'R1', acknowledgedProcessedAt: at('10:00') }),
    ],
  }));
  assert.equal(projection.needsAction.replyId, 'R3');
});

test('fold: ties on processedAt break by gmail message id', () => {
  const projection = foldPursuitStage(makeBundle({
    replies: [reply('A', at('10:00')), reply('B', at('10:00'))],
    events: [ownerEvent('e1', at('11:00'), { kind: 'acknowledge', fromStage: 'broker-replied', stage: 'broker-replied',
      acknowledgedReplyId: 'A', acknowledgedProcessedAt: at('10:00') })],
  }));
  assert.equal(projection.needsAction.replyId, 'B');
});

test('fold: a bounce needs action only while the campaign is action-required/recipient_bounced', () => {
  const campaign = (state, reasonCode) => ({ id: 'c1', state, reasonCode, crmSubmissionId: null,
    conversationId: 'conv-1', gmailThreadId: null });
  const replies = [reply('B1', at('10:00'), 'bounce')];
  assert.equal(foldPursuitStage(makeBundle({ replies, campaign: campaign('action-required', 'recipient_bounced') }))
    .needsAction.reason, 'bounce');
  for (const other of [campaign('action-required', 'other'), campaign('active-follow-up', null), null]) {
    assert.equal(foldPursuitStage(makeBundle({ replies, campaign: other })).needsAction, null);
  }
  const acknowledged = foldPursuitStage(makeBundle({
    replies,
    campaign: campaign('action-required', 'recipient_bounced'),
    events: [ownerEvent('e1', at('11:00'), { kind: 'acknowledge', acknowledgedReplyId: 'B1', acknowledgedProcessedAt: at('10:00') })],
  }));
  assert.equal(acknowledged.needsAction, null);
});

test('fold: a prospectus URL or a financials document is not SIM evidence', () => {
  const projection = foldPursuitStage(makeBundle({
    prospectusUrl: 'https://broker.example/prospectus.pdf',
    campaign: { id: 'c1', state: 'active-follow-up', reasonCode: null, crmSubmissionId: null, conversationId: 'conv-1',
      gmailThreadId: null, prospectusUrl: 'https://broker.example/prospectus.pdf' },
    documents: [document('doc-1', at('10:00'), 'financials'), document('doc-2', at('10:05'), 'tax_return')],
  }));
  assert.equal(projection.stage, 'cim-requested');
});

test('fold: lender-review → financial-review; docs-received → cim-received; new-fit and not-started → none', () => {
  const stageOf = (fields) => foldPursuitStage(makeBundle({ crm: crm(fields) })).stage;
  assert.equal(stageOf({ diligenceStage: 'lender-review', diligenceUpdatedAt: at('10:00') }), 'financial-review');
  assert.equal(stageOf({ pipelineStage: 'docs-received', pipelineUpdatedAt: at('10:00') }), 'cim-received');
  assert.equal(stageOf({ pipelineStage: 'new-fit', pipelineUpdatedAt: at('10:00') }), 'cim-requested');
  assert.equal(stageOf({ diligenceStage: 'not-started', diligenceUpdatedAt: at('10:00') }), 'cim-requested');
});

test('fold: a CRM stage with no usable date is applied at the pursue instant', () => {
  const projection = foldPursuitStage(makeBundle({ crm: crm({ diligenceStage: 'nda-sent' }) }));
  assert.equal(projection.stage, 'nda-sent');
  assert.equal(projection.stageSince, T0);
});

// --- helpers ---------------------------------------------------------------------------------

test('reply types: not-available → passed; question on financial-review stays financial-review', () => {
  assert.equal(stageAfterReplyType('financial-review', 'question'), 'financial-review');
  assert.equal(stageAfterReplyType('loi-candidate', 'not-available'), 'passed');
  assert.equal(stageAfterReplyType('cim-requested', 'nda-requested'), 'nda-sent');
  assert.equal(stageAfterReplyType('loi-candidate', 'sim-received'), 'loi-candidate');
  assert.equal(stageAfterReplyType('passed', 'other'), 'passed');
  assert.equal(stageAfterReplyType('nda-sent', 'bogus'), 'nda-sent');
});

test('stage labels follow the fixed order', () => {
  assert.deepEqual(Object.keys(STAGE_LABELS), [...PURSUIT_STAGES]);
  assert.deepEqual(Object.values(STAGE_LABELS), ['SIM requested', 'Broker replied', 'NDA', 'SIM received',
    'Reviewing', 'LOI candidate', 'Passed']);
});

test('gmail link: authuser is encoded, #all is used, bad ids give null', () => {
  assert.equal(buildGmailThreadUrl({ threadId: '18c1a2b3d4e5f607', address: 'Owner+deals@uckele.test' }),
    'https://mail.google.com/mail/?authuser=Owner%2Bdeals%40uckele.test#all/18c1a2b3d4e5f607');
  for (const threadId of [null, '', 'a/b', 'x'.repeat(65), '<script>']) assert.equal(buildGmailThreadUrl({ threadId, address: 'o@u.test' }), null);
  for (const address of [null, undefined, '', '  ']) assert.equal(buildGmailThreadUrl({ threadId: 'abc', address }), null);
  assert.equal(buildGmailThreadUrl(), null);
});
