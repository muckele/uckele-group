import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../server/utils/security.js';
import { strictP10bJson } from '../server/services/p10bStrictJson.js';
import { createP10bRecoveryFilesystem } from '../server/services/p10bOperatorFiles.js';
import { P10B_STOPPED_LOG_PROBE_NATIVE_SHA256 } from '../server/services/p10bStoppedLogProbeRelease.js';
import { runP10bStoppedLogProbe } from '../server/services/p10bStoppedLogProbe.js';
const help = 'Stopped log probe: --probe <public-profile.json> --approval <separate-approval.json> --native-client <reviewed-probe-executable>. Requires separate future live approval and opaque private environment input. Never starts or updates a Machine.';
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') process.stdout.write(`${help}\n`);
  else {
    if (args.length !== 6 || args[0] !== '--probe' || args[2] !== '--approval' || args[4] !== '--native-client'
      || !/^[a-f0-9]{64}$/.test(P10B_STOPPED_LOG_PROBE_NATIVE_SHA256 || '')) throw Error();
    const filesystem = createP10bRecoveryFilesystem();
    const read = file => strictP10bJson(filesystem.snapshot(path.resolve(file)).bytes);
    const probe = read(args[1]); const approval = read(args[3]); const executable = path.resolve(args[5]);
    const stat = fs.lstatSync(executable);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024
      || probe.nativeClientSha256 !== P10B_STOPPED_LOG_PROBE_NATIVE_SHA256
      || sha256(fs.readFileSync(executable)) !== P10B_STOPPED_LOG_PROBE_NATIVE_SHA256) throw Error();
    process.chdir(fileURLToPath(new URL('..', import.meta.url)));
    const result = await runP10bStoppedLogProbe({ probe, approval, executable });
    process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.success) process.exitCode = 1;
  }
} catch {
  process.stdout.write(`${JSON.stringify({ version: 'p10b-stopped-log-probe-hold-v1', success: false, code: 'stopped-probe-held', productionReady: false,
    qualificationAllowed: false, globalAutomationPaused: true })}\n`); process.exitCode = 1;
}
