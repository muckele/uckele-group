import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { p10bGuestPaths } from '../server/services/p10bGuestShutdown.js';

const load = async () => {
  const service = await import('../server/services/p10bGuardianParent.js').catch(() => null);
  assert.equal(typeof service?.runP10bGuardianParent, 'function', 'OS child-reaping provenance is absent');
  return service;
};

async function parentFixture(t, variant = 'normal', options = {}) {
  const service = await load();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-reaper-offline-'));
  const databasePath = path.join(directory, 'fixture.sqlite');
  const window = { version: 'p10b-guest-window-v1', app: 'uckele-group-p10b', machineId: '0803730bd1d7e8',
    sourceHead: '1'.repeat(40), imageDigest: `sha256:${'a'.repeat(64)}`, phase: 'prepare',
    databasePath: '/data/p10b-first-mailbox-reaper-offline.sqlite', runBinding: 'c'.repeat(64),
    issuedAt: new Date().toISOString(), stopAt: new Date(Date.now() + 4000).toISOString(),
    closureGraceMs: 500, stopReserveMs: 500 };
  const paths = p10bGuestPaths(window, databasePath);
  const childScript = path.join(directory, 'child.mjs');
  fs.writeFileSync(childScript, `
    import fs from 'node:fs';
    import {runP10bGuestGuardian} from ${JSON.stringify(new URL('../server/services/p10bGuestGuardian.js', import.meta.url).href)};
    import {p10bGuestPaths,writeP10bGuestRecord} from ${JSON.stringify(new URL('../server/services/p10bGuestShutdown.js', import.meta.url).href)};
    import {sha256,stableCanonicalJson} from ${JSON.stringify(new URL('../server/utils/security.js', import.meta.url).href)};
    const window=JSON.parse(process.env.P10B_GUEST_WINDOW), databasePath=process.argv[2], variant=process.argv[3];
    fs.writeFileSync(databasePath+'.environment.json',JSON.stringify(Object.keys(process.env).sort()));
    if(variant==='zero-without-binding')process.exit(0);
    const paths=p10bGuestPaths(window,databasePath);
    const timer=setInterval(()=>{if(fs.existsSync(paths.ready)&&!fs.existsSync(paths.request)){
      writeP10bGuestRecord(paths.request,{windowDigest:sha256(stableCanonicalJson(window)),failure:true,outcomeDigest:null});clearInterval(timer);}},10);
    await runP10bGuestGuardian({window,databasePath,exit:()=>{
      if(variant==='tampered-receipt'){const receipt=JSON.parse(fs.readFileSync(paths.receipt));
        receipt.version='unknown';fs.writeFileSync(paths.receipt,JSON.stringify(receipt));}
      if(variant==='nonzero')process.exit(7);
      if(variant==='signal')process.kill(process.pid,'SIGTERM');
      else process.exit(0);
    }});
  `);
  let child; const codes = []; const output = options.output || new PassThrough(); let text = '';
  if (output.on) output.on('data', chunk => { text += chunk; });
  const launch = ({ environment }) => {
    assert.deepEqual(Object.keys(environment).sort(), ['FLY_APP_NAME', 'FLY_MACHINE_ID', 'P10B_GUEST_WINDOW']);
    child = spawn(process.execPath, [childScript, databasePath, variant], { env: environment, stdio: 'ignore' });
    return child;
  };
  t.after(() => { if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL'); });
  const result = await service.runP10bGuardianParent({ window, databasePath, launch, output,
    environment: { ...process.env, ADMIN_PASSWORD: 'synthetic-forbidden-presence', RESEND_API_KEY: 'synthetic-forbidden-presence' },
    exit: code => codes.push(code), ...options });
  return { result, paths, child, codes, text, window, databasePath, directory };
}

test('actual guardian child exit supplies its exact reaped PID and immutable bound record', async t => {
  const f = await parentFixture(t);
  assert.equal(f.result.success, true); assert.deepEqual(f.codes, [0]);
  const retained = JSON.parse(fs.readFileSync(f.paths.processExit));
  assert.equal(retained.guardianPid, f.child.pid); assert.equal(retained.code, 0); assert.equal(retained.signal, null);
  assert.equal(retained.bindingVerified, true); assert.equal(retained.productionReady, false);
  assert.ok(Date.parse(retained.exitedAt) <= Date.parse(f.window.stopAt) - f.window.stopReserveMs);
  assert.ok(f.text.startsWith('P10B_GUARDIAN_CHILD_EXIT '));
  // macOS Node injects this public locale variable at process creation.
  assert.deepEqual(JSON.parse(fs.readFileSync(f.databasePath + '.environment.json'))
    .filter(name => !(process.platform === 'darwin' && name === '__CF_USER_TEXT_ENCODING')),
    ['FLY_APP_NAME', 'FLY_MACHINE_ID', 'P10B_GUEST_WINDOW']);
  assert.equal(fs.existsSync(f.databasePath), false);
});

test('code0 without fresh child markers never supplies success', async t => {
  const f = await parentFixture(t, 'zero-without-binding');
  assert.equal(f.result.success, false); assert.deepEqual(f.codes, [1]);
  assert.equal(f.result.record.code, 0); assert.equal(f.result.record.bindingVerified, false);
});

test('a matching digest on an unknown receipt schema never supplies success', async t => {
  const f = await parentFixture(t, 'tampered-receipt');
  assert.equal(f.result.success, false); assert.equal(f.result.record.bindingVerified, false);
  assert.deepEqual(f.codes, [1]);
});

test('actual nonzero and signalled guardian children fail closed', async t => {
  for (const variant of ['nonzero', 'signal']) await t.test(variant, async t => {
    const f = await parentFixture(t, variant);
    assert.equal(f.result.success, false); assert.deepEqual(f.codes, [1]);
    assert.equal(f.result.record.guardianPid, f.child.pid);
    assert.equal(f.result.record.code, variant === 'nonzero' ? 7 : null);
    assert.equal(f.result.record.signal, variant === 'signal' ? 'SIGTERM' : null);
  });
});

test('blocked log transport is bounded after actual child exit', async t => {
  const output = { write() { /* Deliberately never acknowledge the write. */ } };
  const began = Date.now(); const f = await parentFixture(t, 'normal', { output });
  assert.equal(f.result.success, false); assert.deepEqual(f.codes, [1]);
  assert.equal(f.result.record.code, 0); assert.equal(f.result.record.bindingVerified, true);
  assert.ok(Date.now() - Date.parse(f.result.record.exitedAt) < 750);
  assert.ok(Date.now() - began < 4000);
});

test('retained parent markers prevent child launch and are never overwritten', async () => {
  const service = await load(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-reaper-replay-'));
  const databasePath = path.join(directory, 'fixture.sqlite');
  const window = { version: 'p10b-guest-window-v1', app: 'uckele-group-p10b', machineId: '0803730bd1d7e8',
    sourceHead: '1'.repeat(40), imageDigest: `sha256:${'a'.repeat(64)}`, phase: 'prepare',
    databasePath: '/data/p10b-first-mailbox-replay-offline.sqlite', runBinding: 'c'.repeat(64),
    issuedAt: new Date().toISOString(), stopAt: new Date(Date.now() + 4000).toISOString(),
    closureGraceMs: 500, stopReserveMs: 500 };
  const paths = p10bGuestPaths(window, databasePath); const bytes = '{"retained":true}';
  fs.writeFileSync(paths.parentStart, bytes, { flag: 'wx' }); let launches = 0; const codes = [];
  const result = await service.runP10bGuardianParent({ window, databasePath,
    launch: () => { launches++; }, exit: code => codes.push(code) });
  assert.equal(result.success, false); assert.equal(launches, 0); assert.deepEqual(codes, [1]);
  assert.equal(fs.readFileSync(paths.parentStart, 'utf8'), bytes);
});

test('an actual OS spawn failure publishes no successful child binding', async t => {
  const f = await parentFixture(t, 'normal', { launch: ({ environment }) =>
    spawn('/definitely-absent-p10b-offline-executable', [], { env: environment, stdio: 'ignore' }) });
  assert.equal(f.result.success, false); assert.deepEqual(f.codes, [1]);
  assert.equal(f.result.record.spawnFailed, true); assert.equal(f.result.record.guardianPid, null);
  assert.equal(f.result.record.code, null); assert.equal(f.result.record.bindingVerified, false);
});
