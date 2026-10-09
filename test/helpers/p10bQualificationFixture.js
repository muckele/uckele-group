import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createSqliteStorage } from '../../server/storage/sqlite.js';
import { prepareP10bControlledMailbox } from '../../server/services/pursueCimControlledMailboxHarness.js';
import { P10B_QUALIFICATION_VERSION, qualificationDigest } from '../../server/services/p10bQualificationContract.js';
import { recordEmailEventsFromWebhook } from '../../server/services/emailEvents.js';

export function config() {
  return { isProduction: false, server: { outboundRequestTimeoutMs: 100 },
    delivery: { provider: 'console', resendApiKey: '', resendFromEmail: '' },
    followUp: { emailEnabled: false, aiEnabled: false },
    dealHunter: { dailyEmail: { enabled: false }, cimOutreach: { paused: true },
      cimAutomation: { schedulerEnabled: false, paused: true },
      cimFollowUp: { enabled: false }, cimProvider: { enabled: false,
        qualificationRuntime: true, qualificationPhase: 'qualify',
        profile: 'controlled-mailbox-v1', mode: 'controlled-mailbox', provider: 'resend',
        resendApiKey: 'offline-sending-secret', reconciliationApiKey: 'offline-read-secret',
        emailWebhookSecret: `whsec_${Buffer.from('offline-webhook-signing-key').toString('base64')}`,
        resendFromEmail: 'P10B Sender <sender@p10b-e2e.uckelegroup.com>',
        resendReplyTo: 'replies@p10b-e2e.uckelegroup.com',
        resendInboundDomain: 'p10b-e2e.uckelegroup.com', allowedRecipients: ['mathew@uckelegroup.com'] } } };
}

let fixtureNumber = 0;
export async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-qualification-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'fixture.sqlite') },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const configuration = config();
  const prepared = await prepareP10bControlledMailbox({ storage, config: configuration,
    actor: 'offline-owner', now: '2026-10-12T16:00:00.000Z',
    synthetic: { runId: 'offline-first-mailbox', recipient: 'mathew@uckelegroup.com',
      permissionEvidenceId: 'offline-permission', permissionEvidenceHash: 'f'.repeat(64) } });
  const manifest = { version: P10B_QUALIFICATION_VERSION,
    runtime: { teamId: 'offline-team', app: 'uckele-group-p10b', machineId: (++fixtureNumber).toString(16).padStart(14, '0'),
      imageDigest: `sha256:${'a'.repeat(64)}`, databaseIdentityHash: 'b'.repeat(64) },
    domain: 'p10b-e2e.uckelegroup.com', recipient: 'mathew@uckelegroup.com',
    from: configuration.dealHunter.cimProvider.resendFromEmail,
    replyTo: prepared.review.transmission.addressing.replyTo,
    ownerPermissionDigest: 'f'.repeat(64), configurationEvidenceDigest: 'c'.repeat(64),
    transmissionId: prepared.review.transmission.id,
    payloadDigest: prepared.review.transmission.payloadDigest, reviewDigest: prepared.review.digest,
    issuedAt: prepared.preparedAt,
    expiresAt: new Date(Date.parse(prepared.preparedAt) + 10 * 60 * 1000).toISOString(),
    maximumCalls: 1, retries: 0, maximumIncrementalUsd: 1, maximumRuntimeMs: 1000 };
  let clock = manifest.issuedAt;
  let calls = 0;
  let stops = 0;
  let reconciliationProof;
  const observed = { runtime: { ...manifest.runtime }, domain: manifest.domain,
    ownerPermissionDigest: manifest.ownerPermissionDigest,
    configurationEvidenceDigest: manifest.configurationEvidenceDigest,
    freshDatabase: true, stopSupervised: true, incrementalUsd: 0.001 };
  const options = { storage, config: configuration, opportunityId: prepared.opportunityId,
    initialActivationId: prepared.initialActivationId, actor: 'offline-owner', manifest,
    supervisorTarget: { app: manifest.runtime.app, machineId: manifest.runtime.machineId },
    stopTimeoutMs: 200,
    reviewedDigest: qualificationDigest(manifest), clock: () => clock,
    observe: async () => structuredClone(observed),
    stopAndVerify: async ({ app, machineId }) => { stops += 1; return { app, machineId, stopped: true }; },
    readFetcher: async (url, options) => {
      assert.equal(url, 'https://api.resend.com/emails?limit=100');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer offline-read-secret');
      return new Response(JSON.stringify({ data: [{ id: 'offline-provider-message',
        created_at: manifest.issuedAt, from: manifest.from, to: [manifest.recipient],
        cc: [], bcc: [], reply_to: manifest.replyTo, subject: prepared.review.transmission.copy.subject }] }), { status: 200 });
    },
    testHooks: { beforeLifecycleObservation: async ({ reconciliation }) => {
      reconciliationProof = reconciliation;
      assert.equal(stops, 0, 'the supervisor must retain the runtime until lifecycle evidence is complete');
      await ingestFakeLifecycle({ storage, configuration, manifest, at: clock });
    } },
    fetcher: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://api.resend.com/emails');
      const body = JSON.parse(options.body);
      assert.equal(body.from, manifest.from);
      assert.deepEqual(body.to, [manifest.recipient]);
      assert.equal(body.reply_to, manifest.replyTo);
      return new Response(JSON.stringify({ id: 'offline-provider-message' }), { status: 200 });
    } };
  return { storage, directory, manifest, observed, prepared, options, get calls() { return calls; },
    get reconciliation() { return reconciliationProof; },
    get stops() { return stops; }, set clock(value) { clock = value; } };
}

export function signedRequest(payload, configuration, at, svixId) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.parse(at) / 1000));
  const key = Buffer.from(configuration.dealHunter.cimProvider.emailWebhookSecret.slice(6), 'base64');
  const signature = createHmac('sha256', key).update(`${svixId}.${timestamp}.${rawBody}`).digest('base64');
  return { body: payload, rawBody, headers: { 'svix-id': svixId,
    'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` } };
}

export async function ingestFakeLifecycle({ storage, configuration, manifest, at, attachments = [] }) {
  const delivery = { type: 'email.delivered', created_at: at, data: {
    email_id: 'offline-provider-message', from: manifest.from, to: [manifest.recipient],
    subject: 'P10B controlled mailbox lifecycle test', created_at: at } };
  const received = { type: 'email.received', created_at: at, data: {
    email_id: 'offline-inbound-message', from: manifest.recipient, to: [manifest.replyTo],
    subject: 'Re: P10B controlled mailbox lifecycle test', created_at: at, attachments } };
  const options = { storage, configOverride: configuration, now: at, clock: () => at,
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api.resend.com/emails/receiving/offline-inbound-message');
      assert.equal(options.headers.Authorization, 'Bearer offline-read-secret');
      return new Response(JSON.stringify({ id: 'offline-inbound-message', from: manifest.recipient,
        to: [manifest.replyTo], created_at: at, text: 'Offline synthetic owner reply.',
        subject: received.data.subject, headers: {}, attachments }), { status: 200 });
    } };
  assert.equal((await recordEmailEventsFromWebhook(signedRequest(delivery, configuration, at, 'evt_delivery'), options)).ok, true);
  const replyResult = await recordEmailEventsFromWebhook(signedRequest(received, configuration, at, 'evt_reply'), options);
  assert.equal(replyResult.ok, true);
  return { delivery, received, replyResult };
}
