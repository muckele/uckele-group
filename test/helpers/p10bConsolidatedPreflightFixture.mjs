// Offline boundary adapter. Validation, private contexts, process ownership,
// canonical sealing and public approval facts are production components.
import fs from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';
import path from 'node:path';
import { sha256, stableCanonicalJson } from '../../server/utils/security.js';
import { checkP10bOwnerRecipe, validateP10bOwnerPublicInputs, prepareP10bOwnerBundle,
  boundP10bOwnerFile, createP10bPreflightCommands } from '../../server/services/p10bOwnerPreflight.js';
import { P10B_GUARDIAN_NATIVE_SHA256 } from '../../server/services/p10bOperatorSource.js';
import { P10B_STOPPED_DIAGNOSTIC_NATIVE_SHA256 } from '../../server/services/p10bStoppedUpdateContract.js';
const [mode, root, operation] = process.argv.slice(2);
const file = path.join(root, 'recipe.json');
const baseline = JSON.parse(fs.readFileSync(new URL('../fixtures/p10bObservedBaselineShape.json', import.meta.url)));
const manifest = fs.readFileSync(new URL('../fixtures/p10bRetainedCandidateManifest.json', import.meta.url), 'utf8');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name)));
const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value), { mode: 0o600, flag: 'wx' });
if (mode === '--fixture') {
  fs.mkdirSync(path.join(root, 'runtime-evidence'), { mode: 0o700 });
  write('price.json', { observedAt: new Date().toISOString(), source: 'https://docs.fly.io/about/pricing',
    ewrShared1Cpu512MbPer30DaysUsd: 3.69, oneUsdIsBillingCap: false, retainedStorageContinues: true });
  const binary = { path: process.execPath, sha256: sha256(fs.readFileSync(process.execPath)) };
  write('recipe.json', { version: 'p10b-owner-preparer-recipe-v1', hostSourceHead: '2'.repeat(40),
    guestSourceHead: 'c4944a46ac362cdcd002e077d5533b4b0843b1d0', nonce: 'c'.repeat(24),
    app: 'uckele-group-p10b', machineId: '0803730bd1d7e8', volumeId: 'vol_vwnkpex1k3yx9dnv',
    candidateImage: 'registry.fly.io/uckele-group-p10b@sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc',
    ownerHome: root, outputDirectory: root, evidenceDirectory: path.join(root, 'runtime-evidence'),
    ownerIssuanceDirectory: path.join(root, 'owner-public-issuance'),
    sealedBundlePath: path.join(root, 'sealed-session.json'), approvedBundlePath: path.join(root, 'approved-session.json'),
    files: { node: binary, python: binary, fly: binary, docker: binary, buildx: binary, names: binary, probe: binary,
      native: { path: process.execPath, sha256: 'de28af1f823644d0eb4f4cd025b74791b2e041a660cd061cafc67c7175c0b088' },
      price: { path: path.join(root, 'price.json'), sha256: sha256(fs.readFileSync(path.join(root, 'price.json'))) } },
    recovery: { directory: path.join(root, '.uckele-group-p10b-host'), activePath: path.join(root, '.uckele-group-p10b-host/0803730bd1d7e8.active.json'),
      packetDigest: 'a'.repeat(64), expectedSha256: 'b'.repeat(64), reservedAt: '2026-10-10T07:12:20.821Z', evidencePath: '/offline/historical-evidence' } });
  if (operation === '--diagnostic') {
    const diagnostic = read('recipe.json'); diagnostic.version = 'p10b-owner-stopped-update-recipe-v2';
    diagnostic.files.diagnosticNative = { path: process.execPath, sha256: P10B_STOPPED_DIAGNOSTIC_NATIVE_SHA256 };
    fs.writeFileSync(file, JSON.stringify(diagnostic), { mode: 0o600 });
  }
  if (operation === '--guardian') {
    const guardian = read('recipe.json'); guardian.version = 'p10b-owner-guardian-only-recipe-v1';
    guardian.files.guardianNative = { path: process.execPath, sha256: P10B_GUARDIAN_NATIVE_SHA256 };
    fs.writeFileSync(file, JSON.stringify(guardian), { mode: 0o600 });
  }
  process.exit(0);
}
const recipe = read('recipe.json');
const options = { checkSource: head => { if (head !== '2'.repeat(40)) throw Error('fixture source drift'); },
  checkFile: item => item === recipe.files.native || item === recipe.files.diagnosticNative || item === recipe.files.guardianNative ? item.path : boundP10bOwnerFile(item) };
let result;
if (mode === '--check-only') result = { ...checkP10bOwnerRecipe(recipe, options), recipeFileSha256: sha256(fs.readFileSync(file)) };
else if (mode === '--validate-input') result = validateP10bOwnerPublicInputs({ recipe, receipt: read('issuance-receipt.json'),
  permission: read('private-setup-scope.json'), ...options });
else if (mode === '--prepare') {
  result = await prepareP10bOwnerBundle({ recipe, receipt: read('issuance-receipt.json'), permission: read('private-setup-scope.json'),
    ...options, createCommands(context) {
      const owned = createP10bPreflightCommands(context);
      return { reap: owned.reap, async command(_executable, args, timeout, input) {
        if (fs.existsSync(path.join(root, 'inject-preflight-failure'))) throw Error('synthetic private remote failure');
        let source;
        if (args[0] === '--registry-config') source = `import fs from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';import path from 'node:path';fs.writeFileSync(path.join(process.env.DOCKER_CONFIG,'config.json'),JSON.stringify({auths:{'registry.fly.io':{auth:'synthetic-only'}}}),{mode:0o600});`;
        else {
          let output;
          if (args[0] === 'machines') output = JSON.stringify([{ id: recipe.machineId, state: 'stopped', region: 'ewr', instance_id: 'offline-instance',
            image_ref: { digest: baseline.image.split('@')[1] }, config: baseline }]);
          else if (args[0] === '--secret-names') output = JSON.stringify(['DEAL_HUNTER_CIM_MAILBOX_RESEND_API_KEY']);
          else if (args.includes('--raw')) output = manifest;
          else if (args[0].startsWith('-test.run=')) output = 'PASS';
          else throw Error('unrecognized external boundary');
          source = `process.stdout.write(${JSON.stringify(output)});`;
        }
        return owned.command(process.execPath, ['--input-type=module', '-e', source], timeout, input);
      } };
    } });
} else if (mode === '--execute') {
  // Only the external runtime boundary is simulated. The approval and sealed
  // session presented to this boundary were produced by real components.
  const approved = read('approved-session.json');
  const digest = sha256(stableCanonicalJson(approved.session));
  if (approved.approval.approved !== true || approved.approval.sessionDigest !== digest) throw Error('approval mismatch');
  write('execution-boundary.json', { sessionDigest: digest, runtimeSimulated: true, providerCalls: 0, emails: 0 });
  const guardian = recipe.version === 'p10b-owner-guardian-only-recipe-v1';
  if (guardian && (approved.version !== 'p10b-guardian-only-bundle-v1' || approved.session.maximumStarts !== 1
    || approved.session.maximumStoppedConfigUpdates !== 2 || approved.session.qualificationAllowed !== false
    || approved.session.maximumLocalBuilds !== 0 || approved.session.maximumImagePushes !== 0
    || approved.approval.version !== 'p10b-guardian-only-approval-v1')) throw Error('wrong guardian authority');
  const diagnostic = recipe.version === 'p10b-owner-stopped-update-recipe-v2';
  if (diagnostic && (approved.session.version !== 'p10b-stopped-update-session-v2' || approved.session.maximumStarts !== 0 || approved.session.recoveryPolicy !== 'acknowledged-only-nonrunning-v1'
    || approved.approval.version !== 'p10b-stopped-update-approval-v2')) throw Error('wrong diagnostic authority');
  fs.writeFileSync(path.join(recipe.evidenceDirectory, diagnostic ? 'p10b-stopped-update-auth-closure.json' : 'p10b-runtime-only-auth-closure.json'),
    JSON.stringify({ success: true, cleanupVerified: true, reapVerified: true, sessionDigest: digest }), { mode: 0o600, flag: 'wx' });
  result = { success: true, productionReady: false, providerCalls: 0, emails: 0,
    ...(guardian ? { operation: 'guardian-only', maximumStarts: 1, qualificationAllowed: false, restored: true, mutationSettled: true } : {}),
    ...(diagnostic ? { operation: 'stopped-update-diagnostic', maximumStarts: 0, qualificationAllowed: false, restored: true, mutationSettled: true } : {}) };
} else throw Error('unknown offline mode');
process.stdout.write(JSON.stringify(result));
