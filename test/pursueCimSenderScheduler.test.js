// Task 8: the 15-minute Pursue sender scheduler. One durable claim per 15-minute slot, so
// overlapping ticks (or two processes) run the sender once, and one Job history row per run
// that carries counts only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PURSUE_CIM_SENDER_JOB_NAME, startPursueCimSenderScheduler } from '../server/services/pursueCimSenderScheduler.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';

const SECRET = 'ya29.secret-access-token-value';

function harness(t, { enabled = true, start = '2030-10-28T15:07:00.000Z' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-pursue-sender-scheduler-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(root, 'sender.sqlite') } });
  let current = new Date(start);
  const logs = [];
  const timers = [];
  const schedulers = [];
  const value = {
    storage, logs, timers,
    set(iso) { current = new Date(iso); },
    start(extra = {}) {
      const scheduler = startPursueCimSenderScheduler({ storage,
        config: { dealHunter: { pursueSender: { enabled, intervalMinutes: 15 } } },
        now: () => current,
        setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
        clearTimer: () => {},
        logger: { log: (line) => logs.push(line), error: (line) => logs.push(line) },
        ...extra });
      schedulers.push(scheduler);
      return scheduler;
    },
    jobs() {
      return storage.listScheduledJobs({ limit: 50 }).then((rows) => rows
        .filter((row) => row.job_name === PURSUE_CIM_SENDER_JOB_NAME));
    },
  };
  t.after(() => {
    for (const scheduler of schedulers) scheduler.stop();
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return value;
}

const summary = (overrides = {}) => ({ sentInitial: 2, sentFollowUps: 1, expired: 1,
  reconciled: 0, skipped: { outside_send_window: 3 }, failed: 0, ambiguous: 0, ...overrides });

test('the sender scheduler is off unless enabled', async (t) => {
  const h = harness(t, { enabled: false });
  let runs = 0;
  const scheduler = h.start({ run: async () => { runs += 1; return summary(); } });
  await scheduler.tick();
  assert.equal(runs, 0);
  assert.equal(h.timers.length, 0);
  assert.ok(h.logs.some((line) => line.includes('disabled')));
});

test('overlapping scheduler ticks run once (claim)', async (t) => {
  const h = harness(t);
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = async () => { runs += 1; await gate; return summary(); };
  // Two processes sharing one database, ticking in the same 15-minute slot.
  const first = h.start({ run });
  const second = h.start({ run, claimTokenFactory: () => 'second-process-claim-token' });
  const ticks = [first.tick(), second.tick(), first.tick()];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all(ticks);
  assert.equal(runs, 1);
  const jobs = await h.jobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job_key, 'pursue-cim-sender:2030-10-28T15:00:00.000Z');
  assert.equal(jobs[0].status, 'completed');
  // The same slot never runs twice, even from a fresh tick later in the slot.
  h.set('2030-10-28T15:14:00.000Z');
  await second.tick();
  assert.equal(runs, 1);
  // The next slot runs again.
  h.set('2030-10-28T15:15:30.000Z');
  await first.tick();
  assert.equal(runs, 2);
  assert.equal((await h.jobs()).length, 2);
});

test('one Job history row per run carries the counts and no secrets or bodies', async (t) => {
  const h = harness(t);
  const inputs = [];
  const scheduler = h.start({ run: async (input) => { inputs.push(input);
    return summary({ stoppedFor: 'provider_quota', body: 'Hi Jordan, the CIM please',
      accessToken: SECRET }); } });
  await scheduler.tick();
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].storage, h.storage);
  assert.equal(inputs[0].now.toISOString(), '2030-10-28T15:07:00.000Z');
  // The run reads a live clock, not the frozen tick instant.
  assert.equal(typeof inputs[0].clock, 'function');
  h.set('2030-10-28T15:07:42.000Z');
  assert.equal(inputs[0].clock().toISOString(), '2030-10-28T15:07:42.000Z');
  const [job] = await h.jobs();
  assert.equal(job.job_name, 'pursue-cim-sender');
  assert.equal(job.status, 'completed');
  const { claimToken, claimedAt, ...metadata } = job.metadata;
  assert.ok(claimToken && claimedAt);
  assert.deepEqual(metadata, { slot: '2030-10-28T15:00:00.000Z', trigger: 'scheduler',
    ok: true, sentInitial: 2, sentFollowUps: 1, expired: 1, reconciled: 0, released: 0,
    skipped: { outside_send_window: 3 }, failed: 0, ambiguous: 0,
    stoppedFor: 'provider_quota', error: null });
  assert.equal(JSON.stringify(job).includes(SECRET), false);
  assert.equal(JSON.stringify(job).includes('Hi Jordan'), false);
});

test('the run log line names the sanitized skip codes, and only when there are any', async (t) => {
  const h = harness(t);
  const results = [
    summary({ skipped: { authority_changed: 2, outside_send_window: 1, 'Bad Code!': 4, quiet: 0 } }),
    summary({ skipped: {} }),
  ];
  const scheduler = h.start({ run: async () => results.shift() });
  await scheduler.tick();
  h.set('2030-10-28T15:15:30.000Z');
  await scheduler.tick();
  assert.deepEqual(h.logs.filter((line) => line.includes(' slot=')), [
    '[pursue-cim-sender] slot=2030-10-28T15:00:00.000Z sent=2 followUps=1 expired=1'
      + ' skipped=authority_changed:2,outside_send_window:1',
    '[pursue-cim-sender] slot=2030-10-28T15:15:00.000Z sent=2 followUps=1 expired=1',
  ]);
});

test('a run that throws is recorded failed by code only', async (t) => {
  const h = harness(t);
  const scheduler = h.start({ run: async () => {
    throw Object.assign(new Error(`token refresh failed: ${SECRET}`), { code: 'gmail_token_invalid' });
  } });
  await scheduler.tick();
  const [job] = await h.jobs();
  assert.equal(job.status, 'failed');
  assert.equal(job.last_error, 'gmail_token_invalid');
  assert.equal(job.metadata.ok, false);
  assert.equal(JSON.stringify(job).includes(SECRET), false);
  assert.equal(h.logs.join('\n').includes(SECRET), false);
  const uncoded = harness(t);
  const other = uncoded.start({ run: async () => { throw new Error(`boom ${SECRET}`); } });
  await other.tick();
  const [failed] = await uncoded.jobs();
  assert.equal(failed.last_error, 'pursue_sender_failed');
  assert.equal(JSON.stringify(failed).includes(SECRET), false);
});
