import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const runnerPath = new URL('../scripts/run-follow-up-eval.js', import.meta.url);
const liveArguments = [
  runnerPath.pathname,
  '--live',
  '--synthetic-only',
  '--ack-paid-api',
  '--candidate',
  'synthetic-never-called:low',
];

function guardedRun(environment) {
  return spawnSync(process.execPath, liveArguments, {
    encoding: 'utf8',
    env: {
      ...process.env,
      FOLLOW_UP_AI_ENABLED: 'false',
      FOLLOW_UP_EMAIL_ENABLED: 'false',
      ...environment,
    },
  });
}

test('live eval trims production flags and refuses before a model call', () => {
  const result = guardedRun({
    OPENAI_API_KEY: 'synthetic-not-a-real-key',
    FOLLOW_UP_AI_ENABLED: ' true ',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FOLLOW_UP_AI_ENABLED must remain false/);
  assert.doesNotMatch(result.stderr, /authentication|provider|network/i);
});

test('live eval treats a whitespace-only API key as missing', () => {
  const result = guardedRun({ OPENAI_API_KEY: '   ' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENAI_API_KEY must be present/);
  assert.doesNotMatch(result.stderr, /authentication|provider|network/i);
});
