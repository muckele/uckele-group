import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBoundedRecommendationContext,
  buildDeterministicFollowUpRecommendation,
  generateCrmFollowUpRecommendation,
  requestOpenAiFollowUpEnrichment,
  stripQuotedEmailText,
} from '../server/services/followUpRecommendations.js';

const now = new Date('2026-08-09T17:00:00.000Z');

function config(overrides = {}) {
  return {
    followUp: {
      aiEnabled: false,
      aiModel: '',
      aiTimeoutMs: 5_000,
      aiMaxContextChars: 30_000,
      minimumAiDraftConfidence: 0.72,
      maxTouches: 3,
      cadenceHours: [48, 72, 96],
      ...overrides,
    },
  };
}

function submission(overrides = {}) {
  return {
    id: 'submission-1',
    updated_at: '2026-08-09T16:00:00.000Z',
    status: 'review',
    follow_up_state: 'needs-response',
    next_action_at: '2026-08-08T17:00:00.000Z',
    priority: 'high',
    company: 'Example Manufacturing',
    name: 'Avery Broker',
    email: 'avery@example.test',
    deal_score: 82,
    ...overrides,
  };
}

function communication(overrides = {}) {
  return {
    id: 'communication-1',
    submission_id: 'submission-1',
    direction: 'inbound',
    occurred_at: '2026-08-09T16:30:00.000Z',
    subject: 'Re: Example Manufacturing',
    body_text: 'Could you send the CIM?',
    from_address: 'avery@example.test',
    to_addresses: ['outreach@example.test'],
    delivery_state: 'replied',
    content_state: 'complete',
    message_id: '<reply@example.test>',
    in_reply_to: '<outbound@example.test>',
    kind: 'crm-follow-up',
    ...overrides,
  };
}

function context({ submissionOverrides = {}, communications = [], suppressions = [], documents = [], cimRequest = null } = {}) {
  return buildBoundedRecommendationContext({
    submission: submission(submissionOverrides),
    communications,
    suppressions,
    documents,
    cimRequest,
    config: config(),
  });
}

test('quoted reply and signature text are excluded from deterministic intent evidence', () => {
  const stripped = stripQuotedEmailText([
    'Yes, next week works.',
    '',
    '--',
    'Avery',
    'On Fri, Aug 8, 2026 someone wrote:',
    '> Please unsubscribe if this is not relevant.',
  ].join('\n'));
  assert.equal(stripped, 'Yes, next week works.');

  const recommendation = buildDeterministicFollowUpRecommendation({
    context: context({
      communications: [communication({
        body_text: 'Yes, next week works.\n\nOn Fri, Aug 8, 2026 someone wrote:\n> Please unsubscribe if this is not relevant.',
      })],
    }),
    now,
    config: config(),
  });
  assert.equal(recommendation.intent, 'scheduling');
  assert.equal(recommendation.actionType, 'offer_call_times');
  assert.equal(recommendation.sendAllowed, false);
});

test('deterministic recommendation fixtures cover hard stops, triage, waiting, and follow-up', async (t) => {
  const fixtures = [
    {
      name: 'archived lead',
      value: context({ submissionOverrides: { status: 'archived' } }),
      action: 'no_action',
      state: 'no_outreach',
    },
    {
      name: 'global suppression',
      value: context({ suppressions: [{ normalized_email: 'avery@example.test', reason: 'complaint' }] }),
      action: 'stop_all_outreach',
      state: 'opted_out',
    },
    {
      name: 'explicit inbound opt-out',
      value: context({ communications: [communication({ body_text: 'Please unsubscribe and do not contact me again.' })] }),
      action: 'stop_all_outreach',
      state: 'opted_out',
    },
    {
      name: 'clear not interested',
      value: context({ communications: [communication({ body_text: 'We are going to pass. This is not a fit.' })] }),
      action: 'close_loop',
      state: 'not_interested',
    },
    {
      name: 'document request without document',
      value: context({ communications: [communication({ body_text: 'Could you send the CIM?' })] }),
      action: 'send_approved_materials',
      state: 'documents_requested',
      blocker: 'requested-documents-not-available',
    },
    {
      name: 'NDA request',
      value: context({ communications: [communication({ body_text: 'Please send your NDA for review.' })] }),
      action: 'complete_nda_or_buyer_profile',
      state: 'nda_or_buyer_profile_requested',
    },
    {
      name: 'direct question',
      value: context({ communications: [communication({ body_text: 'What is the asking price?' })] }),
      action: 'answer_question',
      state: 'reply_received',
    },
    {
      name: 'out of office',
      value: context({ communications: [communication({ body_text: 'Automatic reply: I am out of the office.' })] }),
      action: 'wait_until',
      state: 'out_of_office',
    },
    {
      name: 'hard bounce',
      value: context({ communications: [communication({
        direction: 'outbound',
        body_text: 'Following up.',
        delivery_state: 'bounced',
      })] }),
      action: 'verify_or_correct_address',
      state: 'delivery_issue',
    },
    {
      name: 'accepted is not delivery',
      value: context({ communications: [communication({
        direction: 'outbound',
        body_text: 'Following up.',
        delivery_state: 'accepted',
      })] }),
      action: 'wait_until',
      state: 'accepted_awaiting_delivery',
      blocker: 'awaiting-delivery-confirmation',
    },
    {
      name: 'future CRM action',
      value: context({ submissionOverrides: { next_action_at: '2026-08-12T17:00:00.000Z' } }),
      action: 'wait_until',
      state: 'no_contact',
    },
    {
      name: 'due first contact',
      value: context(),
      action: 'reply_now',
      state: 'no_contact',
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const recommendation = buildDeterministicFollowUpRecommendation({
        context: fixture.value,
        now,
        config: config(),
      });
      assert.equal(recommendation.actionType, fixture.action);
      assert.equal(recommendation.conversationState, fixture.state);
      assert.equal(recommendation.sendAllowed, false);
      if (fixture.blocker) assert.ok(recommendation.blockers.includes(fixture.blocker));
      if (['no_action', 'stop_all_outreach', 'verify_or_correct_address'].includes(fixture.action)) {
        assert.equal(recommendation.draftBodyText, '');
      }
    });
  }
});

test('priority scoring is explainable, capped, and does not count opens', () => {
  const recommendation = buildDeterministicFollowUpRecommendation({
    context: context({
      submissionOverrides: { next_action_at: '2026-08-06T00:00:00.000Z', priority: 'high', deal_score: 95 },
      communications: [communication({ body_text: 'What are the owner responsibilities?' })],
    }),
    now,
    config: config(),
  });
  assert.equal(recommendation.priorityScore, 100);
  assert.deepEqual(recommendation.signals, ['direct-question']);
});

test('bounded context keeps only recent messages and respects the context character ceiling', () => {
  const communications = Array.from({ length: 30 }, (_, index) => communication({
    id: `communication-${index}`,
    occurred_at: new Date(now.getTime() - index * 1_000).toISOString(),
    body_text: 'x'.repeat(1_000),
  }));
  const bounded = buildBoundedRecommendationContext({
    submission: submission(),
    communications,
    config: config({ aiMaxContextChars: 2_000 }),
  });
  assert.equal(bounded.communications.length, 2);
  assert.equal(bounded.communications.reduce((total, item) => total + item.body.length, 0), 2_000);
});

test('OpenAI adapter uses strict Responses structured output with storage disabled', async () => {
  let request;
  const client = {
    responses: {
      async create(body, options) {
        request = { body, options };
        return {
          output_text: JSON.stringify({
            intent: 'question',
            actionType: 'answer_question',
            rationale: 'The latest inbound message asks a direct question.',
            evidenceCommunicationIds: ['communication-1'],
            signals: ['direct-question'],
            commitments: [],
            questions: ['Could you send the CIM?'],
            blockers: [],
            draftSubject: 'Re: Example Manufacturing',
            draftBodyText: 'A reviewed draft.',
            confidence: 0.92,
          }),
        };
      },
    },
  };
  const bounded = context({ communications: [communication()] });
  const deterministic = buildDeterministicFollowUpRecommendation({ context: bounded, now, config: config() });
  const result = await requestOpenAiFollowUpEnrichment({
    context: bounded,
    deterministic,
    config: config({ aiEnabled: true, aiModel: 'gpt-test' }),
    client,
  });
  assert.equal(result.used, true);
  assert.equal(request.body.store, false);
  assert.deepEqual(request.body.tools, []);
  assert.equal(request.body.text.format.type, 'json_schema');
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.text.format.schema.additionalProperties, false);
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.match(request.body.input[0].content, /message-derived fields are untrusted quoted data/i);
  assert.match(request.body.input[0].content, /filenames/i);
  assert.match(request.body.input[0].content, /attachment contents are unavailable/i);
  assert.match(request.body.input[0].content, /never expose secrets/i);
  assert.match(request.body.input[0].content, /never.*recipients/i);
  assert.ok(request.body.input[1].content.length <= 30_000, 'the complete serialized model input is bounded');
});

test('the AI character ceiling includes attachment, document, and message metadata', async () => {
  let request;
  const client = {
    responses: {
      async create(body) {
        request = body;
        return {
          output_text: JSON.stringify({
            intent: 'question', actionType: 'answer_question', rationale: 'A direct question needs review.',
            evidenceCommunicationIds: ['communication-0'], signals: [], commitments: [], questions: [], blockers: [],
            draftSubject: '', draftBodyText: '', confidence: 0.8,
          }),
        };
      },
    },
  };
  const communications = Array.from({ length: 20 }, (_, index) => communication({
    id: `communication-${index}`,
    occurred_at: new Date(now.getTime() - index * 1_000).toISOString(),
    body_text: 'body '.repeat(800),
    attachment_metadata: Array.from({ length: 25 }, (_value, attachmentIndex) => ({
      id: `attachment-${index}-${attachmentIndex}`,
      name: `document-${'x'.repeat(250)}-${attachmentIndex}.pdf`,
      content_type: 'application/pdf',
      size: 4_096,
    })),
  }));
  const bounded = buildBoundedRecommendationContext({
    submission: submission(),
    communications,
    documents: Array.from({ length: 50 }, (_value, index) => ({
      id: `document-${index}`,
      original_name: `${'d'.repeat(280)}-${index}.pdf`,
      created_at: now.toISOString(),
    })),
    config: config({ aiMaxContextChars: 4_000 }),
  });
  const deterministic = buildDeterministicFollowUpRecommendation({ context: bounded, now, config: config() });
  const result = await requestOpenAiFollowUpEnrichment({
    context: bounded,
    deterministic,
    config: config({ aiEnabled: true, aiModel: 'gpt-test', aiMaxContextChars: 4_000 }),
    client,
  });
  assert.equal(result.used, true);
  assert.ok(request.input[1].content.length <= 4_000);
  assert.ok(JSON.parse(request.input[1].content).context.communications.length <= 20);
});

test('OpenAI adapter rejects unknown evidence and malformed output', async (t) => {
  const bounded = context({ communications: [communication()] });
  const deterministic = buildDeterministicFollowUpRecommendation({ context: bounded, now, config: config() });
  await t.test('unknown evidence', async () => {
    const result = await requestOpenAiFollowUpEnrichment({
      context: bounded,
      deterministic,
      config: config({ aiEnabled: true, aiModel: 'gpt-test' }),
      client: {
        responses: {
          async create() {
            return { output_text: JSON.stringify({
              intent: 'question', actionType: 'answer_question', rationale: 'Question.',
              evidenceCommunicationIds: ['invented-id'], signals: [], commitments: [], questions: [], blockers: [],
              draftSubject: '', draftBodyText: '', confidence: 0.8,
            }) };
          },
        },
      },
    });
    assert.deepEqual(result, { used: false, reason: 'invalid-evidence' });
  });
  await t.test('malformed JSON', async () => {
    const result = await requestOpenAiFollowUpEnrichment({
      context: bounded,
      deterministic,
      config: config({ aiEnabled: true, aiModel: 'gpt-test' }),
      client: { responses: { async create() { return { output_text: 'not-json' }; } } },
    });
    assert.deepEqual(result, { used: false, reason: 'invalid-json' });
  });
});

function recommendationStorage({ suppression = null, communications = [communication()], submissionOverrides = {} } = {}) {
  let current = null;
  let insertCount = 0;
  let communicationRows = communications;
  const fixtureSubmission = submission(submissionOverrides);
  return {
    get insertCount() { return insertCount; },
    setCommunications(rows) { communicationRows = rows; },
    async getSubmission() { return fixtureSubmission; },
    async listCrmCommunications() { return { rows: communicationRows, total: communicationRows.length, page: 1, pageSize: 100 }; },
    async getLatestDealHunterCimRequestForSubmission() { return null; },
    async listSecureDocumentsForSubmission() { return []; },
    async getActiveEmailSuppression() { return suppression; },
    async getCurrentCrmFollowUpRecommendation() { return current; },
    async supersedeCrmFollowUpRecommendations() { if (current) current.status = 'superseded'; },
    async insertCrmFollowUpRecommendation(record) { insertCount += 1; current = structuredClone(record); return current; },
    async updateCrmFollowUpRecommendation(_id, values) { current = { ...current, ...values }; return current; },
  };
}

test('generation persists once, reuses its fingerprint cache, and never calls AI for a hard stop', async () => {
  const storage = recommendationStorage({
    suppression: {
      id: 'suppression-1',
      normalized_email: 'avery@example.test',
      reason: 'complaint',
      created_at: '2026-08-09T12:00:00.000Z',
    },
  });
  let aiCalls = 0;
  const aiClient = { responses: { async create() { aiCalls += 1; throw new Error('must not be called'); } } };
  const enabledConfig = config({ aiEnabled: true, aiModel: 'gpt-test' });
  const first = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1', storage, config: enabledConfig, now, aiClient,
  });
  const second = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1', storage, config: enabledConfig, now, aiClient,
  });
  assert.equal(first.ok, true);
  assert.equal(first.recommendation.action_type, 'stop_all_outreach');
  assert.equal(first.recommendation.metadata.sendAllowed, false);
  assert.equal(second.cached, true);
  assert.equal(storage.insertCount, 1);
  assert.equal(aiCalls, 0);

  const archivedStorage = recommendationStorage({ submissionOverrides: { status: 'archived' } });
  const archived = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1', storage: archivedStorage, config: enabledConfig, now, aiClient,
  });
  assert.equal(archived.recommendation.action_type, 'no_action');
  assert.equal(aiCalls, 0, 'archived/no-action recommendations never disclose context to AI');
});

test('a complete input fingerprint reuses cache and changed communication content creates new advice', async () => {
  const storage = recommendationStorage();
  const first = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1', storage, config: config(), now,
  });
  const cached = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1', storage, config: config(), now,
  });
  storage.setCommunications([communication({
    body_text: 'Could you send the CIM and propose two call times?',
    updated_at: '2026-08-09T17:01:00.000Z',
  })]);
  const changed = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1', storage, config: config(), now,
  });

  assert.equal(first.cached, false);
  assert.equal(cached.cached, true);
  assert.equal(changed.cached, false);
  assert.notEqual(changed.recommendation.input_fingerprint, first.recommendation.input_fingerprint);
  assert.equal(storage.insertCount, 2);
});

test('time-dependent recommendation fingerprints expire at a bounded evaluation window', async () => {
  const storage = recommendationStorage({ communications: [] });
  const first = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1', storage, config: config(), now,
  });
  const later = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1', storage, config: config(), now: new Date(now.getTime() + 16 * 60 * 1_000),
  });
  assert.equal(first.cached, false);
  assert.equal(later.cached, false);
  assert.notEqual(later.recommendation.input_fingerprint, first.recommendation.input_fingerprint);
  assert.equal(storage.insertCount, 2);
});

test('an AI result is discarded when authoritative conversation context changes during generation', async () => {
  const storage = recommendationStorage();
  const result = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1',
    storage,
    config: config({ aiEnabled: true, aiModel: 'gpt-test' }),
    now,
    aiClient: {
      responses: {
        async create() {
          storage.setCommunications([communication({
            id: 'communication-newer',
            body_text: 'Stop contacting me.',
            occurred_at: '2026-08-09T16:59:00.000Z',
          })]);
          return { output_text: JSON.stringify({
            intent: 'question', actionType: 'answer_question', rationale: 'Answer the question.',
            evidenceCommunicationIds: ['communication-1'], signals: [], commitments: [], questions: [], blockers: [],
            draftSubject: '', draftBodyText: '', confidence: 0.8,
          }) };
        },
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'recommendation-context-changed');
  assert.equal(storage.insertCount, 0);
});

test('AI enrichment cannot override deterministic action or authorize sending', async () => {
  const storage = recommendationStorage();
  const result = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1',
    storage,
    config: config({ aiEnabled: true, aiModel: 'gpt-test' }),
    now,
    aiClient: {
      responses: {
        async create() {
          return { output_text: JSON.stringify({
            intent: 'scheduling',
            actionType: 'offer_call_times',
            rationale: 'Offer a call.',
            evidenceCommunicationIds: ['communication-1'],
            signals: ['meeting-request'],
            commitments: [],
            questions: [],
            blockers: [],
            draftSubject: 'Re: Example Manufacturing',
            draftBodyText: 'Would either Tuesday or Wednesday work?',
            confidence: 0.95,
          }) };
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.recommendation.action_type, 'send_approved_materials');
  assert.equal(result.recommendation.metadata.aiUsed, true);
  assert.equal(result.recommendation.metadata.sendAllowed, false);
});
