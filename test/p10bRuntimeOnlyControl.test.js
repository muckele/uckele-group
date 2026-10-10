import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createP10bRuntimeOnlyControl } from '../server/services/p10bRuntimeOnlyControl.js';
import { p10bGuestFreshPathInventory, p10bGuestPaths } from '../server/services/p10bGuestShutdown.js';
import { demonstrateOfflineGuardianLoss, offlineDemoWindow } from './helpers/p10bRuntimeOnlyFixture.js';

const at = Date.parse('2026-10-10T12:00:00.000Z');
function fixture() {
  let now = at; let reads = 0, updates = 0, version = 0; const records = new Map(); const queue = [];
  const session = { app: 'uckele-group-p10b', machineId: '0803730bd1d7e8',
    startedAt: new Date(at).toISOString(), sessionDeadline: new Date(at + 3600000).toISOString(),
    maximumStarts: 2, maximumStartWindowMs: 300000, maximumIncrementalUsd: 1, maximumStoppedConfigUpdates: 3,
    productionReady: false, globalAutomationPaused: true, ownerPermissionDigest: 'f'.repeat(64),
    candidateImageDigest: `sha256:${'a'.repeat(64)}`, baselineImageDigest: `sha256:${'b'.repeat(64)}` };
  const baseline = { image: `registry.fly.io/uckele-group@${session.baselineImageDigest}`, env: { paused: 'true' },
    restart: { policy: 'no' }, guest: { memory_mb: 512, cpus: 1, cpu_kind: 'shared' },
    mounts: [{ volume: 'vol_vwnkpex1k3yx9dnv', path: '/data' }],
    services: [{ autostart: false, autostop: false, internal_port: 8787 }] };
  const candidate = { ...structuredClone(baseline), image: `registry.fly.io/uckele-group-p10b@${session.candidateImageDigest}` };
  const machine = { id: session.machineId, state: 'stopped', region: 'ewr', instance_id: 'baseline',
    config: structuredClone(baseline), image_ref: { digest: session.baselineImageDigest } };
  const evidence = { has: name => records.has(name), read: name => records.get(name),
    write(name, value) { assert.equal(records.has(name), false); records.set(name, structuredClone(value)); } };
  const control = createP10bRuntimeOnlyControl({ session, evidence, clock: () => now, wait: async ms => { now += ms; } });
  const api = async (method = 'GET', body) => {
    if (method === 'POST') {
      assert.equal(body.skip_launch, true); assert.equal(body.current_version, machine.instance_id);
      assert.equal(machine.state, 'stopped'); updates++;
      machine.config = structuredClone(body.config); machine.image_ref.digest = body.config.image.split('@')[1];
      machine.instance_id = 'next-' + (++version);
      return { ...structuredClone(machine), state: 'created' };
    }
    reads++; const result = queue.length ? queue.shift()(structuredClone(machine)) : structuredClone(machine);
    return result;
  };
  return { session, baseline, candidate, machine, evidence, records, control, api, queue,
    get reads() { return reads; }, get updates() { return updates; }, set now(value) { now = value; } };
}

test('operator import performs no authentication and closed authority blocks before any read', async () => {
  const f = fixture(); f.records.set('p10b-runtime-only-session-closure.json', { closed: true });
  await assert.rejects(f.control.guardedUpdate(f.api, f.baseline, f.candidate, 'demo'), /closed/);
  assert.equal(f.reads, 0); assert.equal(f.updates, 0);
});

test('created-to-stopped readback accepts only the prior or exact new version and retains evidence', async () => {
  const f = fixture();
  f.queue.push(value => value, value => ({ ...value, state: 'created' }));
  const updated = await f.control.guardedUpdate(f.api, f.baseline, f.candidate, 'demo');
  assert.equal(updated.state, 'stopped'); assert.equal(updated.instance_id, 'next-1'); assert.equal(f.updates, 1);
  assert.equal(f.records.get('p10b-runtime-only-update-demo-readback.json').length, 2);
  await assert.rejects(f.control.guardedUpdate(f.api, f.candidate, f.candidate, 'demo'), /replay/);
  assert.equal(f.updates, 1);
});

test('uncertain readback retains intent, refuses retry and cannot qualify preparation', async t => {
  for (const variant of ['timeout', 'version', 'configuration']) await t.test(variant, async () => {
    const f = fixture(); f.queue.push(value => value, value => {
      if (variant === 'timeout') f.now = at + 10001;
      if (variant === 'version') value.instance_id = 'unknown';
      if (variant === 'configuration') value.config.env.paused = 'false';
      return value;
    });
    await assert.rejects(f.control.guardedUpdate(f.api, f.baseline, f.candidate, 'demo'));
    assert.equal(f.records.has('p10b-runtime-only-update-demo-intent.json'), true);
    assert.equal(f.records.has('p10b-runtime-only-update-demo-verified.json'), false);
    await assert.rejects(f.control.guardedUpdate(f.api, f.baseline, f.candidate, 'demo'), /replay/);
    await assert.rejects(f.control.guardedUpdate(f.api, f.candidate, f.candidate, 'prepare'), /timing proof/);
    assert.equal(f.updates, 1);
  });
});

test('no proof, active Machine or unknown concurrent config forbids preparation and restoration', async () => {
  const f = fixture();
  await assert.rejects(f.control.guardedUpdate(f.api, f.baseline, f.candidate, 'prepare'), /timing proof/);
  f.machine.state = 'started'; await assert.rejects(f.control.restoreBaseline(f.api, f.baseline, [f.candidate]), /certain stopped/);
  f.machine.state = 'stopped'; f.machine.config.env.paused = 'changed';
  await assert.rejects(f.control.restoreBaseline(f.api, f.baseline, [f.candidate]), /unknown concurrent/);
  assert.equal(f.updates, 0);
});

test('fixed five-minute and sixty-minute windows and capacity hard-offs remain strict', async () => {
  const f = fixture(); const window = { issuedAt: new Date(at).toISOString(), stopAt: new Date(at + 300000).toISOString() };
  f.control.assertWindow(window);
  for (const stop of [299999, 300001]) assert.throws(() => f.control.assertWindow({ ...window, stopAt: new Date(at + stop).toISOString() }));
  f.now = at + 3600000 - 30000;
  await assert.rejects(f.control.restoreBaseline(f.api, f.baseline, []), /cutoff/);
  const g = fixture(); const wrong = structuredClone(g.candidate); wrong.services[0].autostart = true;
  await assert.rejects(g.control.guardedUpdate(g.api, g.baseline, wrong, 'demo'), /capacity/);
  assert.equal(g.updates, 0);
});

test('failed actual zero-provider demonstration gates preparation and still restores exact stopped baseline', async t => {
  const f = fixture(); await f.control.guardedUpdate(f.api, f.baseline, f.candidate, 'demo');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-failed-demo-'));
  const result = await demonstrateOfflineGuardianLoss(t, { directory, machine: f.machine,
    databasePath: path.join(directory, 'watchdog.sqlite'), sourceHead: '1'.repeat(40), abnormal: true });
  assert.equal(result.proof.success, false); assert.equal(result.proof.normalMachineExit, false);
  f.records.set('p10b-runtime-only-demo-proof.json', result.proof);
  await assert.rejects(f.control.guardedUpdate(f.api, f.candidate, f.candidate, 'prepare'), /timing proof/);
  const restored = await f.control.restoreBaseline(f.api, f.baseline, [f.candidate]);
  assert.equal(restored.fullConfigRestored, true); assert.equal(f.machine.state, 'stopped');
  assert.deepEqual(f.machine.config, f.baseline); assert.equal(f.updates, 2);
});

test('freshness checks include both phases and parent/exit records without rejecting the current boot records', () => {
  const paths = ['/data/p10b-first-mailbox-watchdog.sqlite', '/data/p10b-first-mailbox-nosend.sqlite'];
  const inventory = p10bGuestFreshPathInventory(paths, { activeDatabasePath: paths[0], activePhase: 'prepare' });
  for (const databasePath of paths) for (const phase of ['prepare', 'qualify']) {
    const records = p10bGuestPaths({ phase }, databasePath);
    for (const [name, file] of Object.entries(records)) {
      assert.equal(inventory.includes(file), !(databasePath === paths[0] && phase === 'prepare'
        && ['start', 'ready', 'parentStart'].includes(name)), `${phase}/${name}`);
    }
  }
  assert.equal(new Set(inventory).size, inventory.length);
  assert.equal(offlineDemoWindow({ id: '0803730bd1d7e8', image_ref: { digest: `sha256:${'a'.repeat(64)}` } }, '1'.repeat(40)).phase, 'prepare');
});

test('slow synchronous validation cannot cross the final readback deadline and return success', async () => {
  const f = fixture(); const checked = structuredClone(f.machine); const config = checked.config; let validations = 0;
  Object.defineProperty(checked, 'config', { enumerable: true, get() {
    if (++validations >= 3) f.now = at + 10000;
    return config;
  } });
  await assert.rejects(f.control.readUpdatedStopped(async () => checked, f.baseline, 'baseline', at + 10000), /timed out/);
});

test('session closure during the pending read cannot return successful stopped verification', async () => {
  const f = fixture();
  const client = async () => {
    const value = await f.api(); f.records.set('p10b-runtime-only-session-closure.json', { closed: true }); return value;
  };
  await assert.rejects(f.control.readUpdatedStopped(client, f.baseline, 'baseline', at + 10000), /closed/);
});
