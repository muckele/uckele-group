import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBoundedRecommendationContext,
  buildDeterministicFollowUpRecommendation,
  buildOpenAiFollowUpProjection,
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
      aiReasoningEffort: 'low',
      aiTimeoutMs: 5_000,
      aiMaxContextChars: 30_000,
      aiMaxOutputTokens: 1_600,
      aiMaxRetries: 0,
      aiRateLimitPerMinute: 120,
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

test('buyer qualification and financial prerequisites require owner review without a draft', async (t) => {
  const fixtures = [
    {
      name: 'buyer profile',
      body: 'Please complete our buyer profile before receiving access.',
      signal: 'buyer-qualification-request',
    },
    {
      name: 'proof of funds before CIM',
      body: 'Please provide proof of funds before we share the CIM.',
      signal: 'financial-qualification-request',
    },
    {
      name: 'fee agreement',
      body: 'Our process requires a signed fee agreement before proceeding.',
      signal: 'financial-commitment-request',
    },
    {
      name: 'lender commitment letter',
      body: 'Please submit a lender commitment letter for the seller to review.',
      signal: 'financial-commitment-request',
    },
    {
      name: 'imperative buyer profile',
      body: 'Complete our buyer profile before proceeding.',
      signal: 'buyer-qualification-request',
    },
    {
      name: 'you must provide proof of funds',
      body: 'You must provide proof of funds before access.',
      signal: 'financial-qualification-request',
    },
    {
      name: 'passive proof of funds requirement',
      body: 'Proof of funds must be provided before access.',
      signal: 'financial-qualification-request',
    },
    {
      name: 'passive buyer profile requirement',
      body: 'Buyer profile must be completed before access.',
      signal: 'buyer-qualification-request',
    },
    {
      name: 'omitted copula fee requirement',
      body: 'Signed fee agreement required before proceeding.',
      signal: 'financial-commitment-request',
    },
    {
      name: 'financing commitment without letter',
      body: 'A financing commitment is required before access.',
      signal: 'financial-commitment-request',
    },
    {
      name: 'you need to pay retainer',
      body: 'You need to pay the retainer before proceeding.',
      signal: 'financial-commitment-request',
    },
    {
      name: 'modal buyer profile request',
      body: 'Can you send us your buyer profile?',
      signal: 'buyer-qualification-request',
    },
    {
      name: 'modal proof of funds request',
      body: 'Could you please provide proof of funds before access?',
      signal: 'financial-qualification-request',
    },
    {
      name: 'contextual fee agreement request',
      body: 'Before we proceed, please sign and return the fee agreement.',
      signal: 'financial-commitment-request',
    },
    {
      name: 'plural upfront processing fees',
      body: 'You need to pay the upfront processing fees before proceeding.',
      signal: 'financial-commitment-request',
    },
    {
      name: 'upload proof of funds',
      body: 'Please upload proof of funds before access.',
      signal: 'financial-qualification-request',
    },
    {
      name: 'fill out buyer qualification form',
      body: 'Please fill out our buyer qualification form before proceeding.',
      signal: 'buyer-qualification-request',
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const recommendation = buildDeterministicFollowUpRecommendation({
        context: context({ communications: [communication({ body_text: fixture.body })] }),
        now,
        config: config(),
      });

      assert.equal(recommendation.intent, 'nda_request');
      assert.equal(recommendation.actionType, 'complete_nda_or_buyer_profile');
      assert.equal(recommendation.conversationState, 'nda_or_buyer_profile_requested');
      assert.equal(recommendation.draftSubject, '');
      assert.equal(recommendation.draftBodyText, '');
      assert.equal(recommendation.sendAllowed, false);
      assert.ok(recommendation.signals.includes(fixture.signal));
      assert.ok(recommendation.blockers.includes('owner-qualification-review-required'));
      assert.ok(recommendation.safetyFlags.includes('outreach-blocked'));
    });
  }
});

test('satisfied, negated, quoted, and unrelated prerequisite terms are not new requests', async (t) => {
  const fixtures = [
    {
      name: 'already provided proof of funds',
      body: 'We already provided proof of funds. Could you send the CIM?',
      action: 'send_approved_materials',
      state: 'documents_requested',
    },
    {
      name: 'negated proof of funds requirement',
      body: 'No proof of funds is required. Could you send the CIM?',
      action: 'send_approved_materials',
      state: 'documents_requested',
    },
    {
      name: 'counterparty negates proof of funds requirement',
      body: 'We do not require proof of funds. Could you send the CIM?',
      action: 'send_approved_materials',
      state: 'documents_requested',
    },
    {
      name: 'contracted proof of funds negation',
      body: "Proof of funds isn't required. Could you send the CIM?",
      action: 'send_approved_materials',
      state: 'documents_requested',
    },
    {
      name: 'confirmation of negated proof of funds requirement',
      body: 'Please send confirmation that no proof of funds is required.',
      action: 'manual_review',
      state: 'reply_received',
    },
    {
      name: 'counterparty needs no proof of funds',
      body: 'We need no proof of funds. Could you send the CIM?',
      action: 'send_approved_materials',
      state: 'documents_requested',
    },
    {
      name: 'proof of funds already provided after requirement',
      body: 'The seller requires proof of funds, which we already provided. Could you send the CIM?',
      action: 'send_approved_materials',
      state: 'documents_requested',
    },
    {
      name: 'proof of funds provided in following clause',
      body: 'Proof of funds is required; we have already provided it. Could you send the CIM?',
      action: 'send_approved_materials',
      state: 'documents_requested',
    },
    {
      name: 'proof of funds provided in following sentence',
      body: 'Proof of funds is required. We have already provided the proof of funds. Could you send the CIM?',
      action: 'send_approved_materials',
      state: 'documents_requested',
    },
    {
      name: 'proof of funds has been provided',
      body: 'Proof of funds has been provided. Could you send the CIM?',
      action: 'send_approved_materials',
      state: 'documents_requested',
    },
    {
      name: 'proof of funds is provided',
      body: 'Proof of funds is provided. Could you send the CIM?',
      action: 'send_approved_materials',
      state: 'documents_requested',
    },
    {
      name: 'fee agreement signed status',
      body: 'Fee agreement signed. Thank you.',
      action: 'manual_review',
      state: 'reply_received',
    },
    {
      name: 'fee agreement is signed status',
      body: 'The fee agreement is signed. Could you send the CIM?',
      action: 'send_approved_materials',
      state: 'documents_requested',
    },
    {
      name: 'signed fee agreement requested for records',
      body: 'Please send the fee agreement we already signed for our records.',
      action: 'manual_review',
      state: 'reply_received',
    },
    {
      name: 'already attached proof of funds without attachment metadata',
      body: 'Attached is our proof of funds.',
      action: 'manual_review',
      state: 'reply_received',
    },
    {
      name: 'unrelated use of commitment',
      body: 'What is the expected time commitment?',
      action: 'answer_question',
      state: 'reply_received',
    },
    {
      name: 'quoted proof of funds request',
      body: 'Thanks for the update.\n\nOn Friday someone wrote:\n> Please provide proof of funds before we share the CIM.',
      action: 'manual_review',
      state: 'reply_received',
    },
    {
      name: 'Outlook quoted proof of funds request',
      body: 'Thanks for the update.\n\nFrom: Broker <broker@example.test>\nSent: Friday, October 2, 2026\nTo: Buyer <buyer@example.test>\nSubject: Re: Opportunity\n\nPlease provide proof of funds before we share the CIM.',
      action: 'manual_review',
      state: 'reply_received',
    },
    {
      name: 'inline attributed proof of funds request',
      body: 'For reference, the prior email said: “Please provide proof of funds before we share the CIM.”',
      action: 'manual_review',
      state: 'reply_received',
    },
    {
      name: 'curly single-quoted stated proof of funds request',
      body: 'The prior email stated: ‘Please upload proof of funds before access.’',
      action: 'manual_review',
      state: 'reply_received',
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const recommendation = buildDeterministicFollowUpRecommendation({
        context: context({ communications: [communication({ body_text: fixture.body })] }),
        now,
        config: config(),
      });

      assert.equal(recommendation.actionType, fixture.action);
      assert.equal(recommendation.conversationState, fixture.state);
      assert.notEqual(recommendation.signals[0], 'buyer-qualification-request');
      assert.notEqual(recommendation.signals[0], 'financial-qualification-request');
      assert.notEqual(recommendation.signals[0], 'financial-commitment-request');
    });
  }
});

test('a new prerequisite request is retained after an older prerequisite was satisfied', () => {
  const recommendation = buildDeterministicFollowUpRecommendation({
    context: context({
      communications: [communication({
        body_text: 'We already provided the old proof of funds. Updated proof of funds is required before access.',
      })],
    }),
    now,
    config: config(),
  });

  assert.equal(recommendation.actionType, 'complete_nda_or_buyer_profile');
  assert.equal(recommendation.conversationState, 'nda_or_buyer_profile_requested');
  assert.equal(recommendation.draftBodyText, '');
  assert.ok(recommendation.blockers.includes('owner-qualification-review-required'));
});

test('hard stops and inbound attachments retain precedence over qualification requests', async (t) => {
  const fixtures = [
    {
      name: 'explicit opt out',
      communication: communication({ body_text: 'Please unsubscribe. We also require proof of funds.' }),
      action: 'stop_all_outreach',
      state: 'opted_out',
    },
    {
      name: 'attachment review',
      communication: communication({
        body_text: 'Please provide proof of funds.',
        attachment_metadata: [{ id: 'attachment-1', name: 'requirements.pdf', content_type: 'application/pdf' }],
      }),
      action: 'review_documents',
      state: 'documents_received_review_needed',
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const recommendation = buildDeterministicFollowUpRecommendation({
        context: context({ communications: [fixture.communication] }),
        now,
        config: config(),
      });

      assert.equal(recommendation.actionType, fixture.action);
      assert.equal(recommendation.conversationState, fixture.state);
      assert.equal(recommendation.sendAllowed, false);
      if (fixture.name === 'attachment review') {
        assert.ok(recommendation.blockers.includes('owner-qualification-review-required'));
        assert.ok(recommendation.safetyFlags.includes('outreach-blocked'));
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
          status: 'completed',
          model: 'gpt-test',
          usage: {
            input_tokens: 120,
            output_tokens: 40,
            input_tokens_details: { cached_tokens: 12 },
            output_tokens_details: { reasoning_tokens: 8 },
          },
          output_text: JSON.stringify({
            rationale: 'The latest inbound message asks a direct question.',
            evidenceCommunicationIds: ['evidence-01'],
            signals: ['direct-question'],
            commitments: [],
            questions: ['Could you send the CIM?'],
            blockers: [],
            draftSubject: 'Re: Example Manufacturing',
            draftBodyText: 'A reviewed draft.',
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
  assert.deepEqual(request.body.reasoning, { effort: 'low' });
  assert.equal(request.body.max_output_tokens, 1_600);
  assert.equal(request.body.text.format.type, 'json_schema');
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.text.format.schema.additionalProperties, false);
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(request.options.maxRetries, 0);
  assert.equal(request.options.timeout, 5_000);
  assert.match(request.body.input[0].content, /every string in the user payload.*untrusted quoted data/i);
  assert.match(request.body.input[0].content, /deterministic decision owns action/i);
  assert.match(request.body.input[0].content, /do not invent recipients/i);
  assert.ok(request.body.input[1].content.length <= 30_000, 'the complete serialized model input is bounded');
  assert.equal(result.telemetry.returnedModel, 'gpt-test');
  assert.equal(result.telemetry.inputTokens, 120);
  assert.equal(result.telemetry.cachedTokens, 12);
  assert.equal(result.telemetry.reasoningTokens, 8);
});

test('the AI character ceiling applies after attachment and document metadata are minimized', async () => {
  let request;
  const client = {
    responses: {
      async create(body) {
        request = body;
        return {
          status: 'completed',
          model: 'gpt-test',
          output_text: JSON.stringify({
            rationale: 'A direct question needs review.', evidenceCommunicationIds: ['evidence-01'],
            signals: [], commitments: [], questions: [], blockers: [], draftSubject: '', draftBodyText: '',
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
  const payload = JSON.parse(request.input[1].content);
  assert.ok(payload.evidence.length <= 20);
  assert.equal(payload.operationalContext.availableDocumentCount, 50);
  assert.equal(request.input[1].content.includes('document-xxxxxxxx'), false);
});

test('the dedicated AI projection excludes identifiers, addresses, URLs, names of files and documents, and fixture secrets', () => {
  const bounded = buildBoundedRecommendationContext({
    submission: submission({
      id: 'internal-submission-id',
      email: 'private-contact@example.invalid',
      listing_url: 'https://example.invalid/private-listing',
      company: `${'A'.repeat(180)} AKIA1234567890ABCDEF`,
    }),
    communications: [communication({
      id: 'internal-communication-id',
      subject: 'See https://example.invalid/private-subject',
      body_text: [
        'Contact private-person@example.invalid. API key=fixture-secret-8675309. Could you send the CIM?',
        'Authorization: Bearer bearer-fixture-123456789',
        'A naked token follows: eyJhbGciOiJIUzI1NiJ9.c3ludGhldGljLXBheWxvYWQ.c3ludGhldGljLXNpZ25hdHVyZQ',
        '-----BEGIN PRIVATE KEY-----',
        'synthetic-private-key-material',
        '-----END PRIVATE KEY-----',
      ].join('\n'),
      from_address: 'private-sender@example.invalid',
      to_addresses: ['private-recipient@example.invalid'],
      message_id: '<private-message-id@example.invalid>',
      in_reply_to: '<private-parent@example.invalid>',
      parent_communication_id: 'private-parent-id',
      attachment_metadata: [{ id: 'private-attachment-id', name: 'private-filename.pdf', content_type: 'application/pdf' }],
    })],
    cimRequest: {
      id: 'private-cim-id', status: 'pending', recipient_email: 'private-cim@example.invalid',
    },
    documents: [{ id: 'private-document-id', original_name: 'private-document-name.pdf' }],
    suppressions: [{ normalized_email: 'private-contact@example.invalid', reason: 'admin-block' }],
    config: config(),
  });
  const deterministic = buildDeterministicFollowUpRecommendation({ context: bounded, now, config: config() });
  const serialized = JSON.stringify(buildOpenAiFollowUpProjection({ context: bounded, deterministic }));
  for (const forbidden of [
    'internal-submission-id', 'internal-communication-id', 'private-contact@example.invalid',
    'private-sender@example.invalid', 'private-recipient@example.invalid', 'private-message-id',
    'private-parent-id', 'private-listing', 'private-filename.pdf', 'private-document-name.pdf',
    'private-attachment-id', 'private-document-id', 'private-cim-id', 'fixture-secret-8675309',
    'application/pdf', 'admin-block', 'bearer-fixture-123456789', 'eyJhbGciOiJIUzI1NiJ9',
    'synthetic-private-key-material', 'AKIA1234567890ABCDE',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `forbidden model input leaked: ${forbidden}`);
  }
  assert.match(serialized, /evidence-01/);
  assert.match(serialized, /\[redacted-address\]/);
  assert.match(serialized, /\[redacted-url\]/);
  assert.match(serialized, /\[redacted-secret\]/);
  assert.match(serialized, /"hasAttachments":true/);
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
            return { status: 'completed', model: 'gpt-test', output_text: JSON.stringify({
              evidenceCommunicationIds: ['invented-id'], signals: [], commitments: [], questions: [], blockers: [],
              rationale: 'Question.', draftSubject: '', draftBodyText: '',
            }) };
          },
        },
      },
    });
    assert.equal(result.used, false);
    assert.equal(result.reason, 'invalid-evidence');
  });
  await t.test('malformed JSON', async () => {
    const result = await requestOpenAiFollowUpEnrichment({
      context: bounded,
      deterministic,
      config: config({ aiEnabled: true, aiModel: 'gpt-test' }),
      client: { responses: { async create() { return { status: 'completed', model: 'gpt-test', output_text: 'not-json' }; } } },
    });
    assert.equal(result.used, false);
    assert.equal(result.reason, 'invalid-json');
  });
});

test('OpenAI adapter maps explicit provider response states to bounded fallback reasons', async (t) => {
  const bounded = context({ communications: [communication()] });
  const deterministic = buildDeterministicFollowUpRecommendation({ context: bounded, now, config: config() });
  const cases = [
    ['refusal', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }], output_text: '' }, 'refusal'],
    ['max output', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{' }, 'incomplete-max-output'],
    ['content filter', { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output_text: '' }, 'incomplete-content-filter'],
    ['other incomplete', { status: 'incomplete', incomplete_details: {}, output_text: '' }, 'incomplete-response'],
    ['empty output', { status: 'completed', model: 'gpt-test', output_text: '' }, 'empty-output'],
    ['failed response', { status: 'failed', output_text: '' }, 'response-failed'],
    ['cancelled response', { status: 'cancelled', output_text: '' }, 'response-cancelled'],
    ['unexpected response', { status: 'queued', output_text: '' }, 'unexpected-response-state'],
    ['missing response status', { model: 'gpt-test', output_text: '{}' }, 'unexpected-response-state'],
    ['missing returned model', { status: 'completed', output_text: '{}' }, 'unexpected-response-state'],
    ['returned model mismatch', { status: 'completed', model: 'different-model', output_text: '{}' }, 'returned-model-mismatch'],
  ];
  for (const [name, response, reason] of cases) {
    await t.test(name, async () => {
      const result = await requestOpenAiFollowUpEnrichment({
        context: bounded,
        deterministic,
        config: config({ aiEnabled: true, aiModel: 'gpt-test' }),
        client: { responses: { async create() { return response; } } },
      });
      assert.equal(result.used, false);
      assert.equal(result.reason, reason);
      assert.ok(['completed', 'refused', 'incomplete', 'empty', 'failed', 'cancelled', 'unexpected'].includes(result.telemetry.responseState));
    });
  }
});

test('OpenAI adapter maps provider errors without retaining provider error bodies', async (t) => {
  const bounded = context({ communications: [communication()] });
  const deterministic = buildDeterministicFollowUpRecommendation({ context: bounded, now, config: config() });
  const cases = [
    ['authentication', { name: 'AuthenticationError', status: 401 }, 'provider-authentication'],
    ['rate limit', { name: 'RateLimitError', status: 429 }, 'provider-rate-limit'],
    ['timeout', { name: 'APIConnectionTimeoutError' }, 'timeout'],
    ['transient', { name: 'InternalServerError', status: 503 }, 'provider-transient'],
    ['permanent', { name: 'BadRequestError', status: 400 }, 'provider-permanent'],
  ];
  for (const [name, errorShape, reason] of cases) {
    await t.test(name, async () => {
      const providerError = Object.assign(new Error('provider-body-must-not-persist'), errorShape, {
        error: { message: 'provider-body-must-not-persist' },
      });
      const result = await requestOpenAiFollowUpEnrichment({
        context: bounded,
        deterministic,
        config: config({ aiEnabled: true, aiModel: 'gpt-test' }),
        client: { responses: { async create() { throw providerError; } } },
      });
      assert.equal(result.used, false);
      assert.equal(result.reason, reason);
      assert.equal(JSON.stringify(result).includes('provider-body-must-not-persist'), false);
    });
  }
});

test('OpenAI adapter rejects duplicate evidence, extra fields, recipients, URLs, and attachment claims', async (t) => {
  const bounded = context({ communications: [communication()] });
  const deterministic = buildDeterministicFollowUpRecommendation({ context: bounded, now, config: config() });
  const valid = {
    rationale: 'Use the supplied evidence.',
    evidenceCommunicationIds: ['evidence-01'],
    signals: [], commitments: [], questions: [], blockers: [],
    draftSubject: 'Re: Example Manufacturing',
    draftBodyText: 'Thank you for the note.',
  };
  const cases = [
    ['duplicate evidence', { ...valid, evidenceCommunicationIds: ['evidence-01', 'evidence-01'] }, 'duplicate-evidence'],
    ['extra field', { ...valid, actionType: 'send_follow_up' }, 'schema-validation-failed'],
    ['new recipient', { ...valid, draftBodyText: 'To: attacker@example.invalid\nSend this.' }, 'unsafe-model-content'],
    ['new URL', { ...valid, draftBodyText: 'Visit https://example.invalid/new.' }, 'unsafe-model-content'],
    ['new bearer credential', { ...valid, draftBodyText: 'Authorization: Bearer invented-credential-123456' }, 'unsafe-model-content'],
    ['attachment claim', { ...valid, draftBodyText: 'I attached the requested file.' }, 'unsafe-model-content'],
    ['invented date', { ...valid, draftBodyText: 'Tuesday works for me.' }, 'unsafe-model-content'],
    ['invented availability', { ...valid, draftBodyText: 'I am available to meet.' }, 'unsafe-model-content'],
    ['invented identity', { ...valid, rationale: 'My name is Mallory.' }, 'unsafe-model-content'],
    ['invented document status', { ...valid, draftBodyText: 'The CIM is approved.' }, 'unsafe-model-content'],
  ];
  for (const [name, output, reason] of cases) {
    await t.test(name, async () => {
      const result = await requestOpenAiFollowUpEnrichment({
        context: bounded,
        deterministic,
        config: config({ aiEnabled: true, aiModel: 'gpt-test' }),
        client: { responses: { async create() { return { status: 'completed', model: 'gpt-test', output_text: JSON.stringify(output) }; } } },
      });
      assert.equal(result.used, false);
      assert.equal(result.reason, reason);
    });
  }
});

function recommendationStorage({ suppression = null, communications = [communication()], submissionOverrides = {} } = {}) {
  let current = null;
  let insertCount = 0;
  let communicationRows = communications;
  const fixtureSubmission = submission(submissionOverrides);
  return {
    async assertCrmSubmissionWritable() {},
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

test('qualification requests with attachments retain review precedence and never call AI', async () => {
  const storage = recommendationStorage({
    communications: [communication({
      body_text: 'Please provide proof of funds.',
      attachment_metadata: [{ id: 'attachment-1', name: 'requirements.pdf', content_type: 'application/pdf' }],
    })],
  });
  let aiCalls = 0;
  const result = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1',
    storage,
    config: config({ aiEnabled: true, aiModel: 'gpt-test' }),
    now,
    aiClient: { responses: { async create() { aiCalls += 1; throw new Error('must not be called'); } } },
  });

  assert.equal(result.ok, true);
  assert.equal(result.recommendation.action_type, 'review_documents');
  assert.ok(result.recommendation.blockers_json.includes('owner-qualification-review-required'));
  assert.ok(result.recommendation.safety_flags_json.includes('outreach-blocked'));
  assert.equal(aiCalls, 0);
});

test('owner-only qualification requests never call AI without attachments', async () => {
  const storage = recommendationStorage({
    communications: [communication({ body_text: 'Please upload proof of funds before access.' })],
  });
  let aiCalls = 0;
  const result = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1',
    storage,
    config: config({ aiEnabled: true, aiModel: 'gpt-test' }),
    now,
    aiClient: { responses: { async create() { aiCalls += 1; throw new Error('must not be called'); } } },
  });

  assert.equal(result.ok, true);
  assert.equal(result.recommendation.action_type, 'complete_nda_or_buyer_profile');
  assert.equal(result.recommendation.draft_body_text, '');
  assert.ok(result.recommendation.blockers_json.includes('owner-qualification-review-required'));
  assert.ok(result.recommendation.safety_flags_json.includes('outreach-blocked'));
  assert.equal(aiCalls, 0);
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
          return { status: 'completed', model: 'gpt-test', output_text: JSON.stringify({
            rationale: 'Answer the question.', evidenceCommunicationIds: ['evidence-01'],
            signals: [], commitments: [], questions: [], blockers: [], draftSubject: '', draftBodyText: '',
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
          return { status: 'completed', model: 'gpt-test', output_text: JSON.stringify({
            rationale: 'Offer a call.',
            evidenceCommunicationIds: ['evidence-01'],
            signals: ['meeting-request'],
            commitments: [],
            questions: [],
            blockers: [],
            draftSubject: 'Re: Example Manufacturing',
            draftBodyText: 'Please let me know what time works.',
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

test('simultaneous identical recommendation requests share one provider call and one persisted result', async () => {
  const storage = recommendationStorage();
  let aiCalls = 0;
  let release;
  let markStarted;
  const providerGate = new Promise((resolve) => { release = resolve; });
  const providerStarted = new Promise((resolve) => { markStarted = resolve; });
  const aiClient = {
    responses: {
      async create() {
        aiCalls += 1;
        markStarted();
        await providerGate;
        return {
          status: 'completed',
          model: 'gpt-test',
          output_text: JSON.stringify({
            rationale: 'The supplied message requests reviewed materials.',
            evidenceCommunicationIds: ['evidence-01'],
            signals: ['document-request'], commitments: [], questions: [], blockers: [],
            draftSubject: 'Re: Example Manufacturing',
            draftBodyText: 'Thank you. I will review the approved materials.',
          }),
        };
      },
    },
  };
  const enabledConfig = config({ aiEnabled: true, aiModel: 'gpt-test' });
  const first = generateCrmFollowUpRecommendation({
    submissionId: 'submission-1', storage, config: enabledConfig, now, aiClient,
  });
  await providerStarted;
  const second = generateCrmFollowUpRecommendation({
    submissionId: 'submission-1', storage, config: enabledConfig, now, aiClient,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aiCalls, 1);
  release();
  const [leader, shared] = await Promise.all([first, second]);
  assert.equal(storage.insertCount, 1);
  assert.equal(leader.recommendation.id, shared.recommendation.id);
  assert.deepEqual(new Set([leader.singleFlightOutcome, shared.singleFlightOutcome]), new Set(['leader', 'shared']));
  assert.equal(leader.recommendation.metadata.aiUsed, true);
  assert.equal(leader.recommendation.metadata.aiReturnedModel, 'gpt-test');
});

test('a slower older generation cannot supersede a newer different fingerprint', async () => {
  const storage = recommendationStorage();
  let releaseOlder;
  let markOlderStarted;
  const olderGate = new Promise((resolve) => { releaseOlder = resolve; });
  const olderStarted = new Promise((resolve) => { markOlderStarted = resolve; });
  const older = generateCrmFollowUpRecommendation({
    submissionId: 'submission-1',
    storage,
    config: config({ aiEnabled: true, aiModel: 'gpt-test' }),
    now,
    aiClient: {
      responses: {
        async create() {
          markOlderStarted();
          await olderGate;
          return {
            status: 'completed',
            model: 'gpt-test',
            output_text: JSON.stringify({
              rationale: 'Older model result.',
              evidenceCommunicationIds: ['evidence-01'],
              signals: [], commitments: [], questions: [], blockers: [],
              draftSubject: 'Re: Example Manufacturing',
              draftBodyText: 'Older draft.',
            }),
          };
        },
      },
    },
  });
  await olderStarted;

  const newer = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1',
    storage,
    config: config({ aiEnabled: false, aiModel: '' }),
    now,
  });
  releaseOlder();
  const superseded = await older;

  assert.equal(newer.ok, true);
  assert.equal(superseded.ok, false);
  assert.equal(superseded.status, 409);
  assert.equal(superseded.code, 'recommendation-generation-superseded');
  assert.equal(storage.insertCount, 1);
  assert.equal((await storage.getCurrentCrmFollowUpRecommendation()).id, newer.recommendation.id);
});

test('the per-process AI request cap falls back without a provider call', async () => {
  const validResponse = {
    status: 'completed',
    model: 'gpt-test',
    output_text: JSON.stringify({
      rationale: 'The supplied message requests reviewed materials.',
      evidenceCommunicationIds: ['evidence-01'],
      signals: [],
      commitments: [],
      questions: [],
      blockers: [],
      draftSubject: 'Re: Example Manufacturing',
      draftBodyText: 'Thank you. I will review the approved materials.',
    }),
  };
  const seedStorage = recommendationStorage();
  await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1',
    storage: seedStorage,
    config: config({ aiEnabled: true, aiModel: 'gpt-test', aiRateLimitPerMinute: 120 }),
    now,
    aiClient: { responses: { async create() { return validResponse; } } },
  });

  const cappedStorage = recommendationStorage();
  let providerCalls = 0;
  const result = await generateCrmFollowUpRecommendation({
    submissionId: 'submission-1',
    storage: cappedStorage,
    config: config({ aiEnabled: true, aiModel: 'gpt-test', aiRateLimitPerMinute: 1 }),
    now,
    aiClient: {
      responses: {
        async create() {
          providerCalls += 1;
          return validResponse;
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(providerCalls, 0);
  assert.equal(result.recommendation.metadata.aiUsed, false);
  assert.equal(result.recommendation.metadata.aiFallbackReason, 'rate-cap-reached');
  assert.equal(result.recommendation.metadata.aiResponseState, 'not-requested');
  assert.equal(result.recommendation.metadata.sendAllowed, false);
});

test('unexpected legacy metadata types and duplicate communication IDs remain bounded and deterministic', () => {
  const bounded = buildBoundedRecommendationContext({
    submission: submission(),
    communications: [
      communication({ id: 'duplicate', occurred_at: '2026-08-09T16:59:00.000Z', body_text: 'Please unsubscribe.' }),
      communication({ id: 'duplicate', occurred_at: '2026-08-09T16:00:00.000Z', body_text: 'Interested.' }),
      null,
      42,
      communication({
        id: 'legacy-types',
        occurred_at: '2026-08-09T15:00:00.000Z',
        to_addresses: 'not-an-array',
        attachment_metadata: { filename: 'not-an-array' },
      }),
    ],
    documents: { not: 'an-array' },
    suppressions: 'not-an-array',
    config: config(),
  });
  assert.equal(bounded.communications.length, 2);
  assert.equal(bounded.communications[0].id, 'duplicate');
  const recommendation = buildDeterministicFollowUpRecommendation({ context: bounded, now, config: config() });
  assert.equal(recommendation.actionType, 'stop_all_outreach');
  assert.deepEqual(recommendation.evidenceCommunicationIds, ['duplicate']);
  assert.equal(recommendation.sendAllowed, false);
});
