import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sha256 } from '../server/utils/security.js';
import { openP10bStoppedUpdateClient } from '../server/services/p10bNativeMachineClient.js';
import { createP10bAppTokenContext } from '../server/services/p10bHostAuthentication.js';
import { publicP10bStoppedUpdateFailure } from '../server/services/p10bStoppedUpdateContract.js';
import { stoppedDiagnosticFixture, diagnosticDigest } from './helpers/p10bStoppedDiagnosticFixture.js';
for (const mode of ['extra-status-field', 'string-status', 'contradictory-dispatch', 'raw-body', 'token-echo', 'extra-ready-field']) {
  test(`diagnostic native IPC rejects malformed or private frames: ${mode}`, async () => {
    const { session, approval } = stoppedDiagnosticFixture();
    session.nativeClientSha256 = sha256(fs.readFileSync(process.execPath)); approval.sessionDigest = diagnosticDigest(session);
    const context = createP10bAppTokenContext({ session, approval, environment: { PATH: '/usr/bin:/bin', HOME: '/tmp',
      FLY_API_TOKEN: 'synthetic-private-ipc-canary' } });
    const code = `const rl=require('node:readline').createInterface({input:process.stdin});let initialized=false;
      rl.on('line',line=>{const input=JSON.parse(line); if(!initialized){initialized=true;
      console.log(JSON.stringify({version:'p10b-stopped-native-ready-v1',ready:true${mode === 'extra-ready-field' ? ",rawBody:'private-canary'" : ''}}));return;}
      const frame={id:input.id,ok:false,error:'http-failed',observation:{httpStatus:422,elapsedMs:1,dispatched:true}};
      ${mode === 'extra-status-field' ? "frame.observation.headers={'x-private':'private-canary'};" : ''}
      ${mode === 'string-status' ? "frame.observation.httpStatus='422';" : ''}
      ${mode === 'contradictory-dispatch' ? 'frame.observation.dispatched=false;' : ''}
      ${mode === 'raw-body' ? "frame.rawBody='private-canary';" : ''}
      ${mode === 'token-echo' ? 'frame.rawBody=process.env.FLY_API_TOKEN;' : ''}
      console.log(JSON.stringify(frame));});`;
    let native; let reaped = false;
    try {
      if (mode === 'extra-ready-field') {
        await assert.rejects(openP10bStoppedUpdateClient({ executable: process.execPath, args: ['-e', code], session, approval,
          configs: [session.baselineConfig, session.diagnosticConfig], readOnly: true, environment: context.environment }),
        error => { reaped = error.reapVerified; assert.equal(error.message.includes('canary'), false); return true; });
      } else {
        native = await openP10bStoppedUpdateClient({ executable: process.execPath, args: ['-e', code], session, approval,
          configs: [session.baselineConfig, session.diagnosticConfig], readOnly: true, environment: context.environment });
        await assert.rejects(native.client(), error => {
          const facts = publicP10bStoppedUpdateFailure(error);
          assert.deepEqual(facts.observation, { httpStatus: null, elapsedMs: facts.observation.elapsedMs, dispatched: null });
          assert.equal(facts.code, 'bridge-protocol'); assert.equal(JSON.stringify(error).includes('canary'), false); return true;
        });
      }
    } finally {
      if (native) reaped = await native.reap();
      assert.equal(reaped, true); assert.equal(context.cleanup({ reaped }), true);
      assert.equal(fs.existsSync(context.environment.FLY_CONFIG_DIR), false);
    }
  });
}
