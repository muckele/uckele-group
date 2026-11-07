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
const OK_BEFORE = 'GO_LIVE_CHECK result=ok from=controlled unset=DEAL_HUNTER_CIM_MAILBOX_PROVIDER,'
  + 'DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS,DEAL_HUNTER_SHEET_CSV_URLS';

// The fake fly logs each call, answers `ssh console` with FAKE_BEFORE / FAKE_AFTER and
// `secrets list` with FAKE_SECRETS. FAKE_FAIL names a subcommand ("set", "unset", "deploy",
// "list") that should fail; FAKE_SSH_EXIT is the exit status of `ssh console`.
const FAKE_FLY = `#!/bin/bash
echo "$*" >> "$FAKE_LOG"
if [[ "$1" == "ssh" ]]; then
  echo "Connecting to fdaa::1... complete"
  if [[ "$*" == *" before"* ]]; then
    answer="$FAKE_BEFORE"
    if [[ -e "$FAKE_LOG.seen" ]] && [[ -n "$FAKE_BEFORE_2" ]]; then answer="$FAKE_BEFORE_2"; fi
    echo "ssh before" >> "$FAKE_LOG.seen"
    printf '%s\\r\\n' "Sending setup now: controlled test" "$answer"
  fi
  if [[ "$*" == *" after"* ]]; then printf '%s\\r\\n' "$FAKE_AFTER"; fi
  exit "\${FAKE_SSH_EXIT:-0}"
fi
if [[ "$1" == "secrets" && "$2" == "$FAKE_FAIL" ]]; then exit 1; fi
if [[ "$1" == "secrets" && "$2" == "list" ]]; then printf '%s\\n' "$FAKE_SECRETS"; fi
exit 0
`;
// FAKE_HEALTH: "up", "down", or "down-after-deploy".
const FAKE_CURL = `#!/bin/bash
echo "curl" >> "$FAKE_LOG"
[[ "$FAKE_HEALTH" == "down" ]] && exit 7
if [[ "$FAKE_HEALTH" == "down-after-deploy" ]] && grep -q "secrets deploy" "$FAKE_LOG"; then exit 7; fi
exit 0
`;
const DEPLOYED = JSON.stringify([
  { Name: 'RESEND_API_KEY', Digest: 'abc123', Status: 'Deployed' },
  { Name: 'DEAL_HUNTER_CIM_PROVIDER_PROFILE', Digest: 'def456', Status: 'Deployed' },
  { Name: 'DEAL_HUNTER_CIM_MAILBOX_PROVIDER', Digest: '789aaa', Status: 'Deployed' },
], null, 2);

function run({ args = [], input = 'GO LIVE\n', before = OK_BEFORE, after = 'GO_LIVE_CHECK result=ok',
  fail = '', health = 'up', secrets = DEPLOYED, sshExit = '0', before2 = '' } = {}) {
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
        FAKE_HEALTH: health, FAKE_SECRETS: secrets, FAKE_SSH_EXIT: sshExit,
        FAKE_BEFORE_2: before2 },
    });
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    return { ...child, calls, secrets: calls.filter((call) => call.startsWith('secrets ') && !call.startsWith('secrets list')) };
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
  assert.equal(sshCalls.length, 3);
  // The check runs before the prompt and again after GO LIVE, with the names Fly will deploy.
  for (const call of sshCalls.slice(0, 2)) {
    assert.match(call, /go-live-check\.js before --app=uckele-group --secret-names=RESEND_API_KEY,DEAL_HUNTER_CIM_PROVIDER_PROFILE,DEAL_HUNTER_CIM_MAILBOX_PROVIDER --env-names=\S*SQLITE_PATH/);
    assert.match(call, /--env-names=\S*NODE_ENV/);
    assert.doesNotMatch(call, /abc123|keep-sheet/);
  }
  assert.match(sshCalls[2], /go-live-check\.js after --app=uckele-group --expect-unset=DEAL_HUNTER_CIM_MAILBOX_PROVIDER,DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS,DEAL_HUNTER_SHEET_CSV_URLS/);
  // The after-check runs only after the deploy.
  assert.ok(result.calls.indexOf(sshCalls[2]) > result.calls.indexOf('secrets deploy -a uckele-group'));
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
  const result = run({ before: 'GO_LIVE_CHECK result=ok from=controlled unset=DEAL_HUNTER_CIM_MAILBOX_PROVIDER,RESEND_API_KEY' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.secrets, []);
  assert.match(result.stdout, /RESEND_API_KEY, which this script never removes/);
});

test('with nothing to remove, only the profile is staged before the deploy', () => {
  const result = run({ before: 'GO_LIVE_CHECK result=ok from=controlled' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.secrets, [
    'secrets set --stage -a uckele-group DEAL_HUNTER_CIM_PROVIDER_PROFILE=production-gmail-v1',
    'secrets deploy -a uckele-group',
  ]);
});

test('a failed removal step puts the staged profile back and never deploys', () => {
  const result = run({ fail: 'unset' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.secrets, [
    'secrets set --stage -a uckele-group DEAL_HUNTER_CIM_PROVIDER_PROFILE=production-gmail-v1',
    'secrets unset --stage -a uckele-group DEAL_HUNTER_CIM_MAILBOX_PROVIDER '
      + 'DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS DEAL_HUNTER_SHEET_CSV_URLS',
    'secrets set --stage -a uckele-group DEAL_HUNTER_CIM_PROVIDER_PROFILE=controlled-mailbox-v1',
  ]);
  assert.match(result.stdout, /The app is unchanged/);
});

test('when even the restore fails, the script says the production profile is still staged', () => {
  const result = run({ fail: 'set' });
  assert.notEqual(result.status, 0);
  assert.equal(result.secrets.some((call) => call.startsWith('secrets deploy')), false);
  assert.match(result.stdout, /STILL STAGED/);
  assert.doesNotMatch(result.stdout, /The app is unchanged/);
});

test('a failed deploy prints the recovery that starts the app, not the controlled profile', () => {
  const result = run({ fail: 'deploy' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /secrets unset -a uckele-group DEAL_HUNTER_CIM_PROVIDER_PROFILE/);
  assert.match(result.stdout, /Don't set the profile back to controlled-mailbox-v1 by itself/);
  assert.equal(result.calls.some((call) => call.includes(' after')), false);
});

test('an app that does not come back prints the recovery', () => {
  const result = run({ health: 'down-after-deploy' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /hasn't answered for 1 seconds/);
  assert.match(result.stdout, /secrets unset -a uckele-group DEAL_HUNTER_CIM_PROVIDER_PROFILE/);
});

test('staged secret changes on Fly stop the script before any change', () => {
  const staged = JSON.stringify([
    { Name: 'RESEND_API_KEY', Digest: 'abc123', Status: 'Staged' },
    { Name: 'ADMIN_EMAIL', Digest: 'abc124', Status: 'Partial' },
    { Name: 'DEAL_HUNTER_CIM_PROVIDER_PROFILE', Digest: 'def456', Status: 'Staged' },
  ]);
  const result = run({ secrets: staged });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.secrets, []);
  assert.equal(result.calls.some((call) => call.startsWith('ssh ')), false);
  assert.match(result.stdout, /staged secret changes that aren't applied yet: RESEND_API_KEY ADMIN_EMAIL/);
  assert.doesNotMatch(result.stdout, /abc123/);
});

test('a staged profile left by an earlier run does not block, and a missing status does', () => {
  const ownStaged = JSON.stringify([{ Name: 'RESEND_API_KEY', Status: 'Deployed' },
    { Name: 'DEAL_HUNTER_CIM_PROVIDER_PROFILE', Status: 'Staged' }]);
  assert.equal(run({ secrets: ownStaged }).status, 0);
  const noStatus = run({ secrets: JSON.stringify([{ Name: 'RESEND_API_KEY', Digest: 'x' }]) });
  assert.notEqual(noStatus.status, 0);
  assert.deepEqual(noStatus.secrets, []);
});

test('an unreadable secret list stops the script', () => {
  for (const options of [{ fail: 'list' }, { secrets: 'not json' }, { secrets: '[]' }]) {
    const result = run(options);
    assert.notEqual(result.status, 0, JSON.stringify(options));
    assert.deepEqual(result.secrets, [], JSON.stringify(options));
    assert.match(result.stdout, /Couldn't read the secret list/, JSON.stringify(options));
  }
});

test('a server check that changes after GO LIVE stops the script', () => {
  const result = run({ before2: 'GO_LIVE_CHECK result=blocked' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.secrets, []);
  assert.match(result.stdout, /Something changed since the first check/);
});

test('the server check failing to run stops the script', () => {
  const result = run({ before: 'Error: connection refused', sshExit: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.secrets, []);
  assert.match(result.stdout, /the server check could not run/);
});

test('--keep-sheet-sources is passed to the server check', () => {
  const result = run({ args: ['--check', '--keep-sheet-sources'], input: '' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.calls.find((call) => call.startsWith('ssh ')), / --keep-sheet-sources/);
});

test('a re-run after the switch finished changes nothing', () => {
  const result = run({ before: 'GO_LIVE_CHECK result=ok from=production' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.secrets, []);
  assert.match(result.stdout, /already done/);
});

test('a check result without a known sending setup is refused', () => {
  const result = run({ before: 'GO_LIVE_CHECK result=ok unset=DEAL_HUNTER_CIM_MAILBOX_PROVIDER' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.secrets, []);
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
