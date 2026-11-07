// scripts/go-live-production-gmail.sh, run against a fake `fly` and a fake `curl`: it changes
// secrets only after the server check passes and the owner types GO LIVE, stages every change
// before one deploy, and never removes a setting outside its fixed list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(rootDir, 'scripts', 'go-live-production-gmail.sh');
const OK_BEFORE = 'GO_LIVE_CHECK result=ok unset=DEAL_HUNTER_CIM_MAILBOX_PROVIDER,'
  + 'DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS,DEAL_HUNTER_SHEET_CSV_URLS';

// The fake fly logs each call and answers `ssh console` with FAKE_BEFORE / FAKE_AFTER.
// FAKE_FAIL names a subcommand ("set", "unset", "deploy") that should fail.
const FAKE_FLY = `#!/bin/bash
echo "$*" >> "$FAKE_LOG"
if [[ "$1" == "ssh" ]]; then
  echo "Connecting to fdaa::1... complete"
  if [[ "$*" == *" before"* ]]; then printf '%s\\r\\n' "Sending setup now: controlled-mailbox-v1" "$FAKE_BEFORE"; fi
  if [[ "$*" == *" after"* ]]; then printf '%s\\r\\n' "$FAKE_AFTER"; fi
  exit 0
fi
if [[ "$1" == "secrets" && "$2" == "$FAKE_FAIL" ]]; then exit 1; fi
exit 0
`;
const FAKE_CURL = `#!/bin/bash
echo "curl" >> "$FAKE_LOG"
[[ "$FAKE_HEALTH" != "down" ]]
`;

function run({ args = [], input = 'GO LIVE\n', before = OK_BEFORE, after = 'GO_LIVE_CHECK result=ok',
  fail = '', health = 'up' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-golive-sh-'));
  try {
    const fly = path.join(dir, 'fly');
    const curl = path.join(dir, 'curl');
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(fly, FAKE_FLY, { mode: 0o755 });
    fs.writeFileSync(curl, FAKE_CURL, { mode: 0o755 });
    fs.writeFileSync(log, '');
    const child = spawnSync('bash', [scriptPath, ...args], {
      encoding: 'utf8',
      input,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GO_LIVE_FLY: fly, GO_LIVE_CURL: curl,
        GO_LIVE_WAIT_SECONDS: '1', FAKE_LOG: log, FAKE_BEFORE: before, FAKE_AFTER: after, FAKE_FAIL: fail,
        FAKE_HEALTH: health },
    });
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    return { ...child, calls, secrets: calls.filter((call) => call.startsWith('secrets ')) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a passing check and GO LIVE stage every change, deploy once, then verify', () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.secrets, [
    'secrets set --stage -a uckele-group DEAL_HUNTER_CIM_PROVIDER_PROFILE=production-gmail-v1',
    'secrets unset --stage -a uckele-group DEAL_HUNTER_CIM_MAILBOX_PROVIDER '
      + 'DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS DEAL_HUNTER_SHEET_CSV_URLS',
    'secrets deploy -a uckele-group',
  ]);
  const sshCalls = result.calls.filter((call) => call.startsWith('ssh '));
  assert.equal(sshCalls.length, 2);
  assert.match(sshCalls[0], /go-live-check\.js before/);
  assert.match(sshCalls[1], /go-live-check\.js after/);
  // The after-check runs only after the deploy.
  assert.ok(result.calls.indexOf(sshCalls[1]) > result.calls.indexOf('secrets deploy -a uckele-group'));
  assert.match(result.stdout, /Live sending is still off/);
  assert.doesNotMatch(result.stdout, /GO_LIVE_CHECK/);
});

test('nothing changes when the server check is blocked', () => {
  const result = run({ before: 'GO_LIVE_CHECK result=blocked' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.secrets, []);
  assert.match(result.stdout, /Stopped\. Nothing changed\./);
});

test('nothing changes when the server check prints no result line', () => {
  const result = run({ before: 'Error: Cannot find module /app/scripts/go-live-check.js' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.secrets, []);
  assert.match(result.stdout, /Deploy the latest main first/);
});

test('nothing changes unless the owner types exactly GO LIVE', () => {
  for (const input of ['yes\n', 'go live\n', '\n', '']) {
    const result = run({ input });
    assert.notEqual(result.status, 0, JSON.stringify(input));
    assert.deepEqual(result.secrets, [], JSON.stringify(input));
  }
});

test('--check runs only the check', () => {
  const result = run({ args: ['--check'], input: '' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.secrets, []);
  assert.match(result.stdout, /The check passed\. Nothing changed/);
});

test('a removal outside the fixed list is refused', () => {
  const result = run({ before: 'GO_LIVE_CHECK result=ok unset=DEAL_HUNTER_CIM_MAILBOX_PROVIDER,RESEND_API_KEY' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.secrets, []);
  assert.match(result.stdout, /RESEND_API_KEY, which this script never removes/);
});

test('with nothing to remove, only the profile is staged before the deploy', () => {
  const result = run({ before: 'GO_LIVE_CHECK result=ok' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.secrets, [
    'secrets set --stage -a uckele-group DEAL_HUNTER_CIM_PROVIDER_PROFILE=production-gmail-v1',
    'secrets deploy -a uckele-group',
  ]);
});

test('a failed staging step never deploys', () => {
  for (const fail of ['set', 'unset']) {
    const result = run({ fail });
    assert.notEqual(result.status, 0, fail);
    assert.equal(result.secrets.some((call) => call.startsWith('secrets deploy')), false, fail);
    assert.match(result.stdout, /The app is unchanged/, fail);
  }
});

test('a down app stops before any server check', () => {
  const result = run({ health: 'down' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls.filter((call) => call !== 'curl'), []);
});

test('a blocked after-check says the switch did not land', () => {
  const result = run({ after: 'GO_LIVE_CHECK result=blocked' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /did not land as planned/);
});

test('unknown options change nothing', () => {
  const result = run({ args: ['--force'] });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, []);
});
