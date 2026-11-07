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
  appReadKeys,
  environmentProblems,
  goLiveAfterProblems,
  goLiveProblems,
  goLiveTargetEnv,
  goLiveUnsetKeys,
  parseNames,
  pendingRemovals,
  profileLabel,
  sheetSourcesPlan,
} from '../scripts/go-live-check.js';
import { RUNBOOK_STAGES, flyTomlEnv, productionSecrets } from './productionBootEnv.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(rootDir, 'scripts', 'go-live-check.js');
const FEED = 'https://docs.google.com/spreadsheets/d/example/export?format=csv';
const TEST_SHEET = 'https://docs.google.com/spreadsheets/d/e/test-sheet/pub?output=csv';
const STEP5 = RUNBOOK_STAGES['step 5 controlled test through Gmail'];
const STEP6 = RUNBOOK_STAGES['step 6 production Gmail'];
const WITH_TEST_SHEET = { DEAL_HUNTER_SHEET_CSV_URL: FEED, DEAL_HUNTER_SHEET_CSV_URLS: `${FEED},${TEST_SHEET}` };
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

test('after the switch, leftover settings, the old profile, Live sending on or no Sheet are reported', () => {
  const off = { boot: GOOD_BOOT, liveSendingEnabled: false };
  assert.deepEqual(goLiveAfterProblems({ env: { ...STEP6 }, ...off }), []);
  assert.deepEqual(codes(goLiveAfterProblems({ env: { ...STEP5 }, ...off })),
    ['profile_not_production', 'setting_left', 'setting_left']);
  assert.deepEqual(codes(goLiveAfterProblems({ env: { ...STEP6, ...WITH_TEST_SHEET }, ...off,
    expectUnset: ['DEAL_HUNTER_SHEET_CSV_URLS'] })), ['setting_left']);
  assert.deepEqual(codes(goLiveAfterProblems({ env: { ...STEP6 }, boot: GOOD_BOOT, liveSendingEnabled: true })),
    ['live_sending_on']);
  assert.deepEqual(codes(goLiveAfterProblems({ env: { ...STEP6 }, boot: GOOD_BOOT, liveSendingEnabled: null })),
    ['live_sending_unknown']);
  assert.deepEqual(codes(goLiveAfterProblems({ env: { ...STEP6 }, liveSendingEnabled: false,
    boot: { ...GOOD_BOOT, sheetSourceCount: 0 } })), ['no_sheet_source']);
  assert.deepEqual(codes(goLiveAfterProblems({ env: { ...STEP6 }, boot: null, liveSendingEnabled: false })),
    ['boot_check_failed']);
});

test('a removal staged on Fly (on the machine, but neither a secret nor set by config) blocks the switch', () => {
  const appKeys = new Set(['RESEND_API_KEY', 'DEAL_HUNTER_CIM_MAILBOX_PROVIDER', 'SQLITE_PATH']);
  const env = { RESEND_API_KEY: 'x', DEAL_HUNTER_CIM_MAILBOX_PROVIDER: 'gmail', SQLITE_PATH: '/data/a', PATH: '/bin' };
  assert.deepEqual(pendingRemovals(env, { secretNames: ['DEAL_HUNTER_CIM_MAILBOX_PROVIDER'], envNames: ['SQLITE_PATH'],
    appKeys }), ['RESEND_API_KEY']);
  // The switch's own removals, staged by an earlier failed run, are not counted.
  assert.deepEqual(pendingRemovals(env, { secretNames: ['RESEND_API_KEY'], envNames: ['SQLITE_PATH'], appKeys,
    plannedUnset: ['DEAL_HUNTER_CIM_MAILBOX_PROVIDER'] }), []);
  assert.deepEqual(codes(goLiveProblems({ env: { ...STEP5 }, boot: GOOD_BOOT, liveSendingEnabled: false,
    pending: ['RESEND_API_KEY'] })), ['removal_staged']);
  assert.deepEqual(codes(goLiveProblems({ env: { ...STEP5 }, boot: GOOD_BOOT, liveSendingEnabled: false,
    pending: null })), ['secret_names_missing']);
});

test('the app-read names come from server/config.js, and name lists drop anything that is not a name', () => {
  const keys = appReadKeys();
  for (const key of ['DEAL_HUNTER_CIM_PROVIDER_PROFILE', 'DEAL_HUNTER_CIM_MAILBOX_PROVIDER', 'RESEND_API_KEY']) {
    assert.ok(keys.has(key), key);
  }
  assert.deepEqual(parseNames('A_1, b ,C;rm -rf,,D'), ['A_1', 'D']);
});

test('the profile is shown as a label, never its raw value', () => {
  assert.equal(profileLabel({ DEAL_HUNTER_CIM_PROVIDER_PROFILE: 'controlled-mailbox-v1' }), 'controlled test');
  assert.equal(profileLabel({ DEAL_HUNTER_CIM_PROVIDER_PROFILE: 'production-gmail-v1' }), 'production');
  assert.equal(profileLabel({ DEAL_HUNTER_CIM_PROVIDER_PROFILE: 're_live_pasted_key' }), '(something else)');
  assert.equal(profileLabel({}), '(none)');
});

test('the check must run with the production app settings', () => {
  const env = { NODE_ENV: 'production', SQLITE_PATH: '/data/a.sqlite', FLY_APP_NAME: 'uckele-group' };
  assert.deepEqual(environmentProblems(env, { app: 'uckele-group', sqliteExists: true }), []);
  assert.deepEqual(codes(environmentProblems({ ...env, FLY_APP_NAME: 'other' }, { app: 'uckele-group', sqliteExists: true })),
    ['wrong_app']);
  assert.deepEqual(codes(environmentProblems({}, { app: '', sqliteExists: false })),
    ['not_production', 'no_database', 'no_app_name']);
});

// End to end: the script as the server runs it, against the real config module and a database.
function runScript(args, stageEnv, { liveSending = 0, withControls = true, extraEnv = {}, names = true } = {}) {
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
    const fullArgs = [...args, '--app=uckele-group'];
    if (names && args[0] === 'before') {
      const configNames = Object.keys(flyTomlEnv());
      fullArgs.push(`--env-names=${[...configNames, 'NODE_ENV'].join(',')}`,
        `--secret-names=${Object.keys(env).filter((key) => !configNames.includes(key) && /^[A-Z]/.test(key)).join(',')}`);
    }
    const child = spawnSync(process.execPath, [scriptPath, ...fullArgs], { encoding: 'utf8', env, cwd: rootDir });
    return { ...child, lastLine: child.stdout.trim().split('\n').at(-1) };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}


test('before: from the controlled test with Live sending off, the check passes and names what it removes', () => {
  const run = runScript(['before'], { ...STEP5, ...WITH_TEST_SHEET });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.lastLine, 'GO_LIVE_CHECK result=ok from=controlled unset=DEAL_HUNTER_CIM_MAILBOX_PROVIDER,'
    + 'DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS,DEAL_HUNTER_SHEET_CSV_URLS');
  assert.match(run.stdout, /App startup check with the new settings: passes/);
  assert.match(run.stdout, /Live sending: off/);
  assert.match(run.stdout, /Sending setup now: controlled test/);
});

test('before: a setting on the machine that Fly will not deploy blocks the switch', () => {
  const run = runScript(['before'], { ...STEP5 }, { names: false, extraEnv: {} });
  assert.match(run.stdout, /\[secret_names_missing\]/);
  const staged = runScript(['before', '--secret-names=DEAL_HUNTER_CIM_PROVIDER_ENABLED',
    `--env-names=${Object.keys(flyTomlEnv()).join(',')}`], { ...STEP5 }, { names: false });
  assert.match(staged.lastLine, /^GO_LIVE_CHECK result=blocked/);
  assert.match(staged.stdout, /\[removal_staged\]/);
  assert.match(staged.stdout, /RESEND_API_KEY/);
});

test('before: from production with nothing left to remove, the check passes with from=production', () => {
  const run = runScript(['before'], { ...STEP6 });
  assert.equal(run.lastLine, 'GO_LIVE_CHECK result=ok from=production');
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
  const done = runScript(['after', '--expect-unset=DEAL_HUNTER_SHEET_CSV_URLS'], { ...STEP6 });
  assert.equal(done.lastLine, 'GO_LIVE_CHECK result=ok');
  const liveOn = runScript(['after'], { ...STEP6 }, { liveSending: 1 });
  assert.match(liveOn.stdout, /\[live_sending_on\]/);
  const notDone = runScript(['after'], { ...STEP5 });
  assert.match(notDone.lastLine, /^GO_LIVE_CHECK result=blocked/);
  assert.match(notDone.stdout, /\[profile_not_production\]/);
});

test('an unknown command prints usage and exits 2', () => {
  const run = runScript(['sideways'], { ...STEP5 });
  assert.equal(run.status, 2);
  assert.match(run.stdout, /Usage:/);
});
