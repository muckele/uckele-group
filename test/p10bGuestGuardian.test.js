import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runP10bGuestGuardian, closeP10bGuestAuthority } from '../server/services/p10bGuestGuardian.js';
import { p10bGuestWindow, parseP10bGuestWindow, p10bGuestPaths, writeP10bGuestRecord,
  readP10bGuestRecord, assertP10bGuestReady, requestP10bGuestShutdown,
  completeP10bGuestHandoff } from '../server/services/p10bGuestShutdown.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { p10bDatabaseIdentity } from '../server/services/p10bRuntime.js';
import { fixture, config } from './helpers/p10bQualificationFixture.js';

const digest = (value) => sha256(stableCanonicalJson(value));
const windowAt = (milliseconds = 1500, phase = 'prepare') => ({ version: 'p10b-guest-window-v1',
  app: 'uckele-group-p10b', machineId: '0803730bd1d7e8', imageDigest: `sha256:${'a'.repeat(64)}`,
  sourceHead: '1'.repeat(40), phase, databasePath: '/data/p10b-first-mailbox-offline.sqlite', runBinding: 'c'.repeat(64),
  issuedAt: new Date().toISOString(), stopAt: new Date(Date.now() + milliseconds).toISOString(),
  closureGraceMs: 100, stopReserveMs: 100 });
const temporary = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-guest-')), 'fixture.sqlite');
async function until(predicate, milliseconds = 3000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Offline process evidence timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function closureHarness(window, databasePath) {
  const paths = p10bGuestPaths(window, databasePath); const windowDigest = digest(window);
  writeP10bGuestRecord(`${databasePath}.p10b-${window.phase}-server.json`, {
    app: window.app, machineId: window.machineId, sourceHead: window.sourceHead,
    guestWindowDigest: windowDigest, pid: 900002 });
  let exits = 0; const steps = [];
  return { paths, steps, get exits() { return exits; }, options: { window, databasePath,
    closeAuthority: () => { steps.push('authority'); return { authorityClosed: true }; },
    signalProcess: (_pid, signal) => { assert.equal(signal, 'SIGUSR2'); steps.push('ingress');
      writeP10bGuestRecord(`${databasePath}.p10b-${window.phase}-server-closed.json`, {
        closed: true, guestWindowDigest: windowDigest }); },
    exit: () => { steps.push('exit'); exits += 1; } } };
}

test('guest final receipt follows preserved candidate, authority, ingress and verified handoff', async () => {
  const window = windowAt(); const databasePath = temporary(); const h = closureHarness(window, databasePath);
  const guard = runP10bGuestGuardian(h.options);
  await assertP10bGuestReady({ window, databasePath });
  const outcome = { sqliteClosed: true, lifecycleVerified: false, productionReady: false };
  const [receipt, duplicate] = await Promise.all([requestP10bGuestShutdown({ window, databasePath, outcome }),
    requestP10bGuestShutdown({ window, databasePath, outcome })]);
  assert.deepEqual(duplicate, receipt);
  assert.equal(receipt.cleanupUncertain, false); assert.equal(receipt.handoffVerified, true);
  assert.deepEqual(readP10bGuestRecord(h.paths.outcome).outcome, outcome);
  assert.equal(h.exits, 0);
  completeP10bGuestHandoff(window, databasePath);
  const finished = await guard;
  assert.deepEqual(readP10bGuestRecord(h.paths.receipt), finished);
  assert.deepEqual(h.steps, ['authority', 'ingress', 'exit']); assert.equal(h.exits, 1);
  await assert.rejects(assertP10bGuestReady({ window, databasePath }), /closing/);
});

test('malformed or missing handoff cannot preserve an earlier success receipt', async (t) => {
  for (const variant of ['malformed', 'missing']) await t.test(variant, async () => {
    const window = windowAt(450); const databasePath = temporary(); const h = closureHarness(window, databasePath);
    const outcome = { sqliteClosed: true, productionReady: false };
    writeP10bGuestRecord(h.paths.outcome, { windowDigest: digest(window), outcome });
    writeP10bGuestRecord(h.paths.request, { windowDigest: digest(window), outcomeDigest: digest(outcome), failure: false });
    if (variant === 'malformed') writeP10bGuestRecord(h.paths.handoff, { windowDigest: 'bad', outcomeDigest: digest(outcome) });
    const result = await runP10bGuestGuardian(h.options);
    assert.equal(readP10bGuestRecord(h.paths.ack).cleanupUncertain, false);
    assert.equal(result.cleanupUncertain, true);
    assert.deepEqual(readP10bGuestRecord(h.paths.receipt), result); assert.equal(h.exits, 1);
  });
});

test('failed authority, listener or worker SQLite closure remains uncertain at the fixed cutoff', async (t) => {
  for (const variant of ['authority', 'listener', 'sqlite']) await t.test(variant, async () => {
    const window = windowAt(550); const databasePath = temporary(); const h = closureHarness(window, databasePath);
    if (variant === 'authority') h.options.closeAuthority = () => { throw new Error('offline close failure'); };
    if (variant === 'listener') h.options.signalProcess = () => {};
    const guard = runP10bGuestGuardian(h.options);
    const receipt = await requestP10bGuestShutdown({ window, databasePath,
      outcome: { sqliteClosed: variant !== 'sqlite', productionReady: false }, failure: true });
    assert.equal(receipt.cleanupUncertain, true); assert.equal(receipt.failure, true);
    completeP10bGuestHandoff(window, databasePath); await guard; assert.equal(h.exits, 1);
  });
});

test('expired, future and replayed guest starts refuse readiness and exit once', async (t) => {
  for (const variant of ['expired', 'future', 'replay']) await t.test(variant, async () => {
    const window = windowAt(400); const databasePath = temporary(); const paths = p10bGuestPaths(window, databasePath);
    if (variant === 'expired') window.stopAt = new Date(Date.now() - 1).toISOString();
    if (variant === 'future') window.issuedAt = new Date(Date.now() + 200).toISOString();
    if (variant === 'replay') writeP10bGuestRecord(paths.start, { windowDigest: digest(window), pid: 900004 });
    let exits = 0;
    const result = await runP10bGuestGuardian({ window, databasePath, exit: () => { exits += 1; } });
    assert.equal(exits, 1); assert.equal(result.cleanupUncertain, true); assert.equal(fs.existsSync(paths.ready), false);
  });
});

test('wall clock rollback cannot renew the guest deadline or cause multiple exit decisions', async () => {
  const window = windowAt(400); const databasePath = temporary(); const started = Date.now();
  let calls = 0; let exits = 0;
  await runP10bGuestGuardian({ window, databasePath,
    clock: () => ++calls < 4 ? started : started - 100000,
    exit: () => { exits += 1; } });
  assert.equal(exits, 1); assert.ok(Date.now() - started < 600);
});

test('guest authority cleanup preserves preparation setup but withdraws qualification permission', async (t) => {
  for (const phase of ['prepare', 'qualify']) await t.test(phase, async (t) => {
    const f = await fixture(t); const databasePath = path.join(f.directory, 'fixture.sqlite'); const window = windowAt(1500, phase);
    writeP10bGuestRecord(`${databasePath}.p10b-${phase === 'prepare' ? 'start' : 'qualify-start'}.json`, {
      sourceHead: window.sourceHead, guestWindowDigest: digest(window), databaseIdentityHash: p10bDatabaseIdentity(databasePath) });
    const result = closeP10bGuestAuthority(window, databasePath, f.manifest.issuedAt);
    assert.equal(result.authorityClosed, true);
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const activation = db.prepare('SELECT status FROM deal_hunter_cim_capability_activations WHERE id=?').get(f.prepared.initialActivationId);
      assert.equal(activation.status, phase === 'prepare' ? 'current' : 'withdrawn');
      assert.equal(db.prepare("SELECT outreach_paused FROM deal_hunter_cim_safety_settings WHERE id='global'").get().outreach_paused, 1);
    } finally { db.close(); }
  });
});

test('independent guest exits on its original cutoff after host loss or a blocked app process', async (t) => {
  for (const variant of ['host-loss', 'blocked-app']) await t.test(variant, async (t) => {
    const f = await fixture(t); const databasePath = path.join(f.directory, 'fixture.sqlite');
    const window = windowAt(3000, 'qualify'); const began = Date.now();
    writeP10bGuestRecord(`${databasePath}.p10b-qualify-start.json`, { sourceHead: window.sourceHead,
      guestWindowDigest: digest(window), databaseIdentityHash: p10bDatabaseIdentity(databasePath) });
    const cfg = config(); cfg.storage = { provider: 'sqlite', sqlitePath: window.databasePath };
    cfg.protection = { rateLimitRetentionMs: 0 };
    cfg.dealHunter.cimProvider.qualificationGuestWindow = stableCanonicalJson(window);
    const completed = `${databasePath}.offline-guest-exit.json`;
    const data = `${databasePath}.offline-boot.json`; fs.writeFileSync(data, JSON.stringify({ databasePath, window, completed, cfg }));
    const guardScript = `${databasePath}.offline-guest.mjs`;
    fs.writeFileSync(guardScript, `import fs from 'node:fs';
      import {runP10bGuestGuardian} from ${JSON.stringify(new URL('../server/services/p10bGuestGuardian.js', import.meta.url).href)};
      const d=JSON.parse(fs.readFileSync(process.argv[2]));
      await runP10bGuestGuardian({window:d.window,databasePath:d.databasePath,exit:(receipt)=>{
        fs.writeFileSync(d.completed,JSON.stringify({receipt,exitedAt:Date.now()}));process.exit(0);}});`);
    const appScript = `${databasePath}.offline-app.mjs`;
    fs.writeFileSync(appScript, `import fs from 'node:fs';import {createServer} from 'node:http';
      import {createSqliteStorage} from ${JSON.stringify(new URL('../server/storage/sqlite.js', import.meta.url).href)};
      import {installP10bIngressClosure} from ${JSON.stringify(new URL('../server/services/p10bIngressClosure.js', import.meta.url).href)};
      const d=JSON.parse(fs.readFileSync(process.argv[2]));
      const cached=createSqliteStorage({...d.cfg,storage:{sqlitePath:d.databasePath}});
      const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      installP10bIngressClosure({config:d.cfg,runtime:{app:d.window.app,machineId:d.window.machineId,sourceHead:d.window.sourceHead},
        server,databasePath:d.databasePath,closeStorage:()=>cached.close()});`);
    const hostScript = `${databasePath}.offline-host.mjs`;
    fs.writeFileSync(hostScript, `import {spawn} from 'node:child_process';
      const app=spawn(process.execPath,[${JSON.stringify(appScript)},process.argv[3]],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH}});
      app.unref();
      const guard=spawn(process.execPath,process.argv.slice(2),{detached:true,stdio:'ignore',env:{PATH:process.env.PATH}});
      guard.unref();process.stdout.write(JSON.stringify({guardPid:guard.pid,appPid:app.pid})+'\\n');setInterval(()=>{},1000);`);
    const host = spawn(process.execPath, [hostScript, guardScript, data], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH } });
    const [chunk] = await once(host.stdout, 'data'); const { guardPid, appPid } = JSON.parse(String(chunk).trim());
    t.after(() => { host.kill('SIGKILL'); for (const pid of [guardPid, appPid]) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ } } });
    await until(() => fs.existsSync(p10bGuestPaths(window, databasePath).ready));
    await until(() => fs.existsSync(`${databasePath}.p10b-qualify-server.json`));
    if (variant === 'host-loss') { const closed = once(host, 'close'); host.kill('SIGKILL'); await closed; }
    else {
      // SIGSTOP blocks every callback in this distinct app/control process.
      process.kill(appPid, 'SIGSTOP');
    }
    await until(() => fs.existsSync(completed));
    const result = JSON.parse(fs.readFileSync(completed));
    assert.ok(result.exitedAt <= Date.parse(window.stopAt) + 150, 'Guest deadline was renewed');
    assert.ok(result.exitedAt - began < 3150);
    assert.equal(result.receipt.authorityClosed, true);
    assert.equal(result.receipt.ingressClosed, variant === 'host-loss');
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(db.prepare('SELECT status FROM deal_hunter_cim_capability_activations WHERE id=?').get(f.prepared.initialActivationId).status, 'withdrawn');
      assert.equal(db.prepare("SELECT outreach_paused FROM deal_hunter_cim_safety_settings WHERE id='global'").get().outreach_paused, 1);
    } finally { db.close(); }
    assert.equal(result.receipt.cleanupUncertain, true); assert.equal(result.receipt.failure, true);
    assert.equal(fs.existsSync(p10bGuestPaths(window, databasePath).outcome), false);
  });
});

test('frozen public window rejects changed target, unknown fields, oversized reserves and renewable cutoffs', () => {
  const window = windowAt();
  assert.deepEqual(parseP10bGuestWindow(JSON.stringify(window)), window);
  for (const changed of [{ ...window, machineId: 'production' }, { ...window, extra: true },
    { ...window, closureGraceMs: 30001 }, { ...window, databasePath: '/data/production.sqlite' }]) {
    assert.throws(() => parseP10bGuestWindow(JSON.stringify(changed)));
  }
  const packet = { operation: 'qualify', guest: { issuedAt: window.issuedAt, stopAt: window.stopAt,
    closureGraceMs: 100, stopReserveMs: 100 }, manifest: { issuedAt: window.issuedAt,
    expiresAt: window.stopAt, maximumRuntimeMs: 1500 }, target: window, sourceHead: window.sourceHead,
    databasePath: window.databasePath, ownerPermissionDigest: 'e'.repeat(64) };
  packet.guest.stopAt = new Date(Date.parse(window.stopAt) + 1).toISOString();
  assert.throws(() => p10bGuestWindow(packet), /Frozen/);
});

test('missing, dead and mismatched guest guardians cannot admit startup or late work', async (t) => {
  for (const variant of ['missing', 'dead', 'mismatch', 'closing']) await t.test(variant, async () => {
    const window = windowAt(); const databasePath = temporary(); const paths = p10bGuestPaths(window, databasePath);
    if (variant !== 'missing') writeP10bGuestRecord(paths.ready, {
      windowDigest: variant === 'mismatch' ? 'bad' : digest(window), pid: 900007 });
    await assert.rejects(assertP10bGuestReady({ window, databasePath, timeoutMs: 30,
      clock: () => variant === 'closing' ? Date.parse(window.stopAt) : Date.now(),
      signalProcess: () => { throw new Error('offline dead process'); } }));
    assert.equal(fs.existsSync(paths.request), false);
  });
});

test('guest refuses changed retained SQLite identity before opening or closing authority', async (t) => {
  const f = await fixture(t); const databasePath = path.join(f.directory, 'fixture.sqlite');
  const window = windowAt(1500, 'qualify');
  writeP10bGuestRecord(`${databasePath}.p10b-qualify-start.json`, { sourceHead: window.sourceHead,
    guestWindowDigest: digest(window), databaseIdentityHash: 'b'.repeat(64) });
  assert.throws(() => closeP10bGuestAuthority(window, databasePath, f.manifest.issuedAt), /identity changed/);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try { assert.equal(db.prepare('SELECT status FROM deal_hunter_cim_capability_activations WHERE id=?')
    .get(f.prepared.initialActivationId).status, 'current'); } finally { db.close(); }
});

test('concurrent readers never see a partially written receipt and exclusive publication preserves evidence', async () => {
  const databasePath = temporary(); const file = `${databasePath}.receipt.json`; const value = { complete: true, text: 'x'.repeat(2000) };
  const script = `${databasePath}.reader.mjs`;
  fs.writeFileSync(script, `import fs from 'node:fs';process.stdout.write('ready\\n');
    const file=process.argv[2];const deadline=Date.now()+2000;
    const poll=setInterval(()=>{if(fs.existsSync(file)){
      try{process.stdout.write(JSON.stringify({value:JSON.parse(fs.readFileSync(file,'utf8'))})+'\\n');}
      catch{process.stdout.write(JSON.stringify({partial:true})+'\\n');}
      clearInterval(poll);
    }else if(Date.now()>deadline){clearInterval(poll);process.exitCode=1;}},1);`);
  const reader = spawn(process.execPath, [script, file], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH } });
  try {
    await once(reader.stdout, 'data'); const result = once(reader.stdout, 'data');
    writeP10bGuestRecord(file, value, { ...fs, openSync: (...args) => {
      const fd = fs.openSync(...args);
      if (args[1] === 'wx') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      return fd;
    } });
    const [chunk] = await result; assert.deepEqual(JSON.parse(String(chunk)).value, value);
    const original = fs.readFileSync(file, 'utf8');
    assert.throws(() => writeP10bGuestRecord(file, { changed: true }), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.includes('.pending-')), false);
  } finally { reader.kill('SIGKILL'); }
});

test('sync failure cannot publish success and private cleanup failure cannot alter a committed receipt', () => {
  const databasePath = temporary(); const failed = `${databasePath}.sync-failed.json`;
  assert.throws(() => writeP10bGuestRecord(failed, { cleanupUncertain: false }, { ...fs,
    fsyncSync: () => { throw new Error('offline fsync failure'); } }), /fsync failure/);
  assert.equal(fs.existsSync(failed), false);
  const committed = `${databasePath}.committed.json`; const value = { cleanupUncertain: false, complete: true };
  writeP10bGuestRecord(committed, value, { ...fs, unlinkSync: () => { throw new Error('offline private removal failure'); } });
  assert.deepEqual(readP10bGuestRecord(committed), value);
  assert.equal(fs.readdirSync(path.dirname(committed)).filter((name) => name.includes('.pending-')).length, 1);
});
