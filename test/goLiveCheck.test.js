// scripts/go-live-check.js: the server-side check behind the owner's go-live switch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  PRODUCTION_PROFILE,
  REMOVABLE_KEYS,
  goLiveAfterProblems,
  goLiveProblems,
  goLiveTargetEnv,
  goLiveUnsetKeys,
  sheetSourcesPlan,
} from '../scripts/go-live-check.js';
import { RUNBOOK_STAGES, flyTomlEnv, productionSecrets } from './productionBootEnv.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(rootDir, 'scripts', 'go-live-check.js');
const FEED = 'https://docs.google.com/spreadsheets/d/example/export?format=csv';
const TEST_SHEET = 'https://docs.google.com/spreadsheets/d/e/test-sheet/pub?output=csv';
const STEP5 = RUNBOOK_STAGES['step 5 controlled test through Gmail'];
const STEP6 = RUNBOOK_STAGES['step 6 production Gmail'];
const GOOD_BOOT = { errors: [], cimMode: 'production-gmail', cimProvider: 'gmail', deliveryProvider: 'resend',
  sheetSourceCount: 1 };

function codes(problems) {
  return problems.map((problem) => problem.code);
}

test('the switch removes the test-only settings and the test Sheet, and sets the production profile', () => {
  const env = { ...STEP5, DEAL_HUNTER_SHEET_CSV_URL: FEED, DEAL_HUNTER_SHEET_CSV_URLS: `${FEED},${TEST_SHEET}` };
  assert.deepEqual(goLiveUnsetKeys(env), ['DEAL_HUNTER_CIM_MAILBOX_PROVIDER',
    'DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS', 'DEAL_HUNTER_SHEET_CSV_URLS']);
  const target = goLiveTargetEnv(env);
  assert.equal(target.DEAL_HUNTER_CIM_PROVIDER_PROFILE, PRODUCTION_PROFILE);
  assert.equal('DEAL_HUNTER_CIM_MAILBOX_PROVIDER' in target, false);
  assert.equal('DEAL_HUNTER_SHEET_CSV_URLS' in target, false);
  assert.equal(target.DEAL_HUNTER_SHEET_CSV_URL, FEED);
  // The input is not changed.
  assert.equal(env.DEAL_HUNTER_CIM_PROVIDER_PROFILE, 'controlled-mailbox-v1');
  for (const key of goLiveUnsetKeys(env)) assert.ok(REMOVABLE_KEYS.includes(key));
});

test('only settings that are set are removed, and --keep-sheet-sources keeps the Sheet list', () => {
  assert.deepEqual(goLiveUnsetKeys({ ...STEP6 }), []);
  const env = { ...STEP5, DEAL_HUNTER_SHEET_CSV_URL: FEED, DEAL_HUNTER_SHEET_CSV_URLS: `${FEED},${TEST_SHEET}` };
  assert.deepEqual(goLiveUnsetKeys(env, { keepSheetSources: true }), ['DEAL_HUNTER_CIM_MAILBOX_PROVIDER',
    'DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS']);
});

test('a Sheet list that is not the feed plus one test Sheet is left alone and blocks the switch', () => {
  for (const sources of [`${TEST_SHEET},${FEED}`, `${FEED},${TEST_SHEET},${TEST_SHEET}2`, FEED, `${FEED},${FEED}`]) {
    const env = { DEAL_HUNTER_SHEET_CSV_URL: FEED, DEAL_HUNTER_SHEET_CSV_URLS: sources };
    assert.equal(sheetSourcesPlan(env).remove, false, sources);
    assert.equal(sheetSourcesPlan(env).problem.code, 'sheet_sources_unexpected', sources);
    assert.deepEqual(goLiveUnsetKeys(env), []);
  }
  // Spaces around the entries don't matter.
  assert.equal(sheetSourcesPlan({ DEAL_HUNTER_SHEET_CSV_URL: FEED,
    DEAL_HUNTER_SHEET_CSV_URLS: ` ${FEED} , ${TEST_SHEET} ` }).remove, true);
});

test('the switch is allowed from the controlled test with Live sending off and a clean startup check', () => {
  assert.deepEqual(goLiveProblems({ env: { ...STEP5 }, boot: GOOD_BOOT, liveSendingEnabled: false }), []);
  // Re-running after a half-finished switch (profile already production) is also allowed.
  assert.deepEqual(goLiveProblems({ env: { ...STEP6 }, boot: GOOD_BOOT, liveSendingEnabled: false }), []);
});

test('the switch is refused while Live sending is on or unreadable', () => {
  assert.deepEqual(codes(goLiveProblems({ env: { ...STEP5 }, boot: GOOD_BOOT, liveSendingEnabled: true })),
    ['live_sending_on']);
  assert.deepEqual(codes(goLiveProblems({ env: { ...STEP5 }, boot: GOOD_BOOT, liveSendingEnabled: null })),
    ['live_sending_unknown']);
});

test('the switch is refused when the app would not start or would not send through Gmail', () => {
  assert.deepEqual(codes(goLiveProblems({ env: { ...STEP5 }, liveSendingEnabled: false,
    boot: { ...GOOD_BOOT, errors: ['RESEND_API_KEY is required.'] } })), ['boot_error']);
  assert.deepEqual(codes(goLiveProblems({ env: { ...STEP5 }, liveSendingEnabled: false, boot: null })),
    ['boot_check_failed']);
  assert.deepEqual(codes(goLiveProblems({ env: { ...STEP5 }, liveSendingEnabled: false,
    boot: { ...GOOD_BOOT, cimMode: 'controlled-mailbox', deliveryProvider: 'console', sheetSourceCount: 0 } })),
  ['not_production_gmail', 'app_email_off', 'no_sheet_source']);
});

test('the switch is refused outside the rollout: no profile, or a sender setting off', () => {
  assert.deepEqual(codes(goLiveProblems({ env: {}, boot: GOOD_BOOT, liveSendingEnabled: false })),
    ['profile_unexpected', 'setting_off', 'setting_off', 'setting_off']);
  assert.deepEqual(codes(goLiveProblems({ env: { ...STEP5, DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED: 'false' },
    boot: GOOD_BOOT, liveSendingEnabled: false })), ['setting_off']);
});

test('after the switch, leftover test settings or the old profile are reported', () => {
  assert.deepEqual(goLiveAfterProblems({ env: { ...STEP6 }, boot: GOOD_BOOT }), []);
  assert.deepEqual(codes(goLiveAfterProblems({ env: { ...STEP5 }, boot: GOOD_BOOT })),
    ['profile_not_production', 'test_setting_left', 'test_setting_left']);
  assert.deepEqual(codes(goLiveAfterProblems({ env: { ...STEP6 }, boot: null })), ['boot_check_failed']);
});

// End to end: the script as the server runs it, against the real config module and a database.
function runScript(args, stageEnv, { liveSending = 0, withControls = true, extraEnv = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-golive-'));
  try {
    const secrets = productionSecrets(dataDir);
    fs.mkdirSync(secrets.DEAL_HUNTER_DAILY_EMAIL_MARKER_DIR, { recursive: true });
    fs.mkdirSync(secrets.BACKUP_DIRECTORY, { recursive: true });
    const db = new Database(secrets.SQLITE_PATH);
    if (withControls) {
      db.exec('CREATE TABLE deal_hunter_pursue_send_controls (control_key TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
      db.prepare("INSERT INTO deal_hunter_pursue_send_controls VALUES ('live_sending', ?)").run(liveSending);
    }
    db.close();
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...flyTomlEnv(), ...secrets, ...stageEnv,
      ...extraEnv, NODE_ENV: 'production' };
    const child = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', env, cwd: rootDir });
    return { ...child, lastLine: child.stdout.trim().split('\n').at(-1) };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const WITH_TEST_SHEET = { DEAL_HUNTER_SHEET_CSV_URL: FEED, DEAL_HUNTER_SHEET_CSV_URLS: `${FEED},${TEST_SHEET}` };

test('before: from the controlled test with Live sending off, the check passes and names what it removes', () => {
  const run = runScript(['before'], { ...STEP5, ...WITH_TEST_SHEET });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.lastLine, 'GO_LIVE_CHECK result=ok unset=DEAL_HUNTER_CIM_MAILBOX_PROVIDER,'
    + 'DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS,DEAL_HUNTER_SHEET_CSV_URLS');
  assert.match(run.stdout, /App startup check with the new settings: passes/);
  assert.match(run.stdout, /Live sending: off/);
});

test('before: never prints a setting value', () => {
  const run = runScript(['before'], { ...STEP5, ...WITH_TEST_SHEET }, { liveSending: 1 });
  for (const secret of ['tester@example.net', FEED, TEST_SHEET, 're_test_key', 'client-secret', 'whsec_test']) {
    assert.equal(run.stdout.includes(secret), false, secret);
    assert.equal(run.stderr.includes(secret), false, secret);
  }
});

test('before: blocked while Live sending is on, or when it cannot be read', () => {
  const on = runScript(['before'], { ...STEP5 }, { liveSending: 1 });
  assert.match(on.lastLine, /^GO_LIVE_CHECK result=blocked/);
  assert.match(on.stdout, /\[live_sending_on\]/);
  const unreadable = runScript(['before'], { ...STEP5 }, { withControls: false });
  assert.match(unreadable.lastLine, /^GO_LIVE_CHECK result=blocked/);
  assert.match(unreadable.stdout, /\[live_sending_unknown\]/);
});

test('before: blocked when the new settings would stop the app from starting', () => {
  const run = runScript(['before'], { ...STEP5 }, { extraEnv: { RESEND_API_KEY: '' } });
  assert.match(run.lastLine, /^GO_LIVE_CHECK result=blocked/);
  assert.match(run.stdout, /\[boot_error\]/);
  assert.match(run.stdout, /App startup check with the new settings: fails/);
});

test('after: passes on the step 6 settings and is blocked on the step 5 settings', () => {
  const done = runScript(['after'], { ...STEP6 });
  assert.equal(done.lastLine, 'GO_LIVE_CHECK result=ok');
  const notDone = runScript(['after'], { ...STEP5 });
  assert.match(notDone.lastLine, /^GO_LIVE_CHECK result=blocked/);
  assert.match(notDone.stdout, /\[profile_not_production\]/);
});

test('an unknown command prints usage and exits 2', () => {
  const run = runScript(['sideways'], { ...STEP5 });
  assert.equal(run.status, 2);
  assert.match(run.stdout, /Usage:/);
});
