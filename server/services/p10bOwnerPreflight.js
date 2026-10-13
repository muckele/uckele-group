import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { assertP10bReviewedCheckout, P10B_RETAINED_GUEST_HEAD, P10B_RETAINED_IMAGE, P10B_RETAINED_NATIVE_SHA256 } from './p10bOperatorSource.js';
import { P10B_PUBLIC_ENV_NAMES, P10B_RUNTIME_FLAGS, validateP10bBaselineConfig, validateP10bNoEmailSession } from './p10bRuntimeOnlyOperator.js';
import { P10B_PROVIDER_IDENTITY, p10bProviderIdentityDigest } from './p10bProviderIdentity.js';
import { reserveP10bLocalReap } from './p10bHostAuthentication.js';
import { createP10bOperatorEvidence } from './p10bOperatorFiles.js';
const digest = value => sha256(stableCanonicalJson(value));
const deny = message => { throw Error(message); };
const canonicalTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function privateDirectory(directory) {
  const s = fs.lstatSync(directory, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink() || Number(s.uid) !== process.getuid() || (Number(s.mode) & 0o777) !== 0o700) deny('Private owner directory required');
  return s;
}
export function boundP10bOwnerFile(binding) {
  if (!binding || typeof binding.path !== 'string' || path.resolve(binding.path) !== binding.path || !/^[a-f0-9]{64}$/.test(binding.sha256 || '')) deny('Concrete file binding required');
  const stat = fs.lstatSync(binding.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024 || sha256(fs.readFileSync(binding.path)) !== binding.sha256) deny('Bound file changed');
  return binding.path;
}
export function checkP10bOwnerRecipe(recipe, { checkSource = assertP10bReviewedCheckout, checkFile = boundP10bOwnerFile, clock = Date.now } = {}) {
  if (recipe?.version !== 'p10b-owner-preparer-recipe-v1' || recipe.app !== 'uckele-group-p10b'
    || recipe.machineId !== '0803730bd1d7e8' || recipe.volumeId !== 'vol_vwnkpex1k3yx9dnv'
    || recipe.guestSourceHead !== P10B_RETAINED_GUEST_HEAD || !/^[a-f0-9]{40}$/.test(recipe.hostSourceHead || '')
    || recipe.hostSourceHead === recipe.guestSourceHead || !/^[a-f0-9]{24}$/.test(recipe.nonce || '')
    || recipe.candidateImage !== `registry.fly.io/uckele-group-p10b@${P10B_RETAINED_IMAGE}`
    || recipe.files?.native?.sha256 !== P10B_RETAINED_NATIVE_SHA256) deny('Fixed reviewed recipe required');
  checkSource(recipe.hostSourceHead);
  for (const name of ['node', 'python', 'fly', 'docker', 'buildx', 'native', 'names', 'probe', 'price']) {
    checkFile(recipe.files[name]);
    if (name !== 'price') fs.accessSync(recipe.files[name].path, fs.constants.X_OK);
  }
  privateDirectory(recipe.outputDirectory); privateDirectory(recipe.evidenceDirectory);
  if (path.dirname(recipe.evidenceDirectory) !== recipe.outputDirectory
    || recipe.sealedBundlePath !== path.join(recipe.outputDirectory, 'sealed-session.json')
    || recipe.approvedBundlePath !== path.join(recipe.outputDirectory, 'approved-session.json')
    || fs.existsSync(recipe.sealedBundlePath) || fs.existsSync(recipe.approvedBundlePath)
    || fs.readdirSync(recipe.evidenceDirectory).length) deny('Existing evidence preserved; fresh output required');
  if (path.resolve(recipe.ownerHome) !== recipe.ownerHome || recipe.recovery?.directory !== path.join(recipe.ownerHome, '.uckele-group-p10b-host')
    || recipe.recovery.activePath !== path.join(recipe.recovery.directory, `${recipe.machineId}.active.json`)
    || !/^[a-f0-9]{64}$/.test(recipe.recovery.packetDigest || '') || !/^[a-f0-9]{64}$/.test(recipe.recovery.expectedSha256 || '')
    || !canonicalTime(recipe.recovery.reservedAt) || typeof recipe.recovery.evidencePath !== 'string') deny('Frozen historical recovery recipe required');
  const price = JSON.parse(fs.readFileSync(recipe.files.price.path, 'utf8'));
  if (!Number.isFinite(Date.parse(price.observedAt)) || Date.parse(price.observedAt) > clock()
    || clock() - Date.parse(price.observedAt) > 86400000 || price.source !== 'https://docs.fly.io/about/pricing'
    || price.oneUsdIsBillingCap !== false || price.retainedStorageContinues !== true
    || price.ewrShared1Cpu512MbPer30DaysUsd !== 3.69) deny('Dated public price evidence stale or changed; resolve before token creation');
  return { status: 'STATIC_READY_FOR_SEPARATELY_APPROVED_PRIVATE_SETUP', recipeDigest: digest(recipe), authenticatedActions: 0,
    tokenInputRequested: false, runtimeApproved: false, productionReady: false, globalAutomationPaused: true };
}
export function projectP10bStoppedBaseline(rows, namesOnly = false) {
  if (!Array.isArray(rows) || rows.length !== 1) deny('Sole isolated Machine required');
  const m = rows[0]; const c = m.config;
  if (m.id !== '0803730bd1d7e8' || m.state !== 'stopped' || m.region !== 'ewr' || !/^[A-Za-z0-9-]{1,80}$/.test(m.instance_id || '')
    || !c?.env || typeof c.env !== 'object' || Array.isArray(c.env)) deny('Exact stopped public target required');
  const names = Object.keys(c.env).sort();
  if (names.some(name => !P10B_PUBLIC_ENV_NAMES.includes(name))) deny('Environment names denied before value access');
  const result = { instanceId: m.instance_id, environmentNames: names };
  if (namesOnly) return result;
  const image = 'sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629';
  if (m.image_ref?.digest !== image) deny('Immutable baseline drift');
  validateP10bBaselineConfig(c, image);
  for (const [name, value] of Object.entries(P10B_RUNTIME_FLAGS)) if (name !== 'P10B_QUALIFICATION_RUNTIME' && c.env[name] !== value) deny('Hard-off or sender identity drift');
  return { ...result, baselineImageDigest: image, baselineConfig: structuredClone(c) };
}
export function createP10bPreflightContext(environment) {
  const token = environment.FLY_API_TOKEN;
  if (typeof token !== 'string' || !token.trim() || token.length > 16384 || [...token].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) deny('Opaque private app input required');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-app-auth-')); const original = privateDirectory(directory);
  for (const name of ['home', 'docker']) fs.mkdirSync(path.join(directory, name), { mode: 0o700 });
  let cleaned = false;
  const context = { directory, assertReaped() {
    const current = privateDirectory(directory);
    if (current.ino !== original.ino || current.dev !== original.dev || fs.readdirSync(directory).some(name => name.startsWith('.p10b-reap-'))) deny('Private preflight reaping unverified');
    return true;
  }, cleanup(reaped) {
    if (cleaned) return true;
    if (reaped !== true) deny('Private preflight cleanup held');
    context.assertReaped(); fs.rmSync(directory, { recursive: true, force: false }); delete context.environment.FLY_API_TOKEN; cleaned = true; return true;
  } };
  Object.defineProperty(context, 'environment', { value: { PATH: '/usr/bin:/bin', HOME: path.join(directory, 'home'),
    FLY_CONFIG_DIR: directory, DOCKER_CONFIG: path.join(directory, 'docker'), FLY_NO_UPDATE_CHECK: '1',
    P10B_APP_TOKEN_CONTEXT: 'p10b-app-token-context-v1', FLY_API_TOKEN: token }, enumerable: false });
  return context;
}
function groupAbsent(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw Error('Owned group identity uncertain');
  try { process.kill(-pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw Error('Owned group state uncertain'); }
}
export function createP10bPreflightCommands(context, { spawnProcess = spawn, absent = groupAbsent } = {}) {
  const entries = new Set(); let uncertain = false;
  function kill(entry) {
    if (entry.gone) return;
    try { if (!absent(entry.child.pid)) process.kill(-entry.child.pid, 'SIGKILL'); }
    catch { uncertain = true; }
  }
  async function proveGroup(entry) {
    let gone = false;
    try {
      if (!absent(entry.child.pid)) kill(entry);
      const end = Date.now() + 1000;
      do { if (absent(entry.child.pid)) { gone = true; break; } await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < end);
      if (gone) { entry.reservation.retire(true); entry.gone = true; entries.delete(entry); }
    } catch { uncertain = true; gone = false; }
    return gone;
  }
  async function reap() {
    for (const entry of entries) kill(entry);
    const outcomes = await Promise.all([...entries].map(async entry => {
      let timer;
      try { await Promise.race([entry.terminal, new Promise(resolve => { timer = setTimeout(resolve, 1100); })]);
        return entry.closed ? proveGroup(entry) : false; }
      finally { clearTimeout(timer); }
    }));
    return outcomes.every(Boolean) && entries.size === 0 && !uncertain;
  }
  async function command(executable, args, timeoutMs = 10000, input = '') {
    const reservation = reserveP10bLocalReap(context.environment);
    const child = spawnProcess(executable, args, { env: context.environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let resolveTerminal; let code; let signal; let failed = false; let bytes = 0; const chunks = [];
    const entry = { child, reservation, closed: false, gone: false, terminal: new Promise(resolve => { resolveTerminal = resolve; }) }; entries.add(entry);
    child.once('error', () => { failed = true; if (!child.pid) { uncertain = true; entry.closed = true; resolveTerminal(false); } });
    child.once('close', async (value, killedBy) => {
      entry.closed = true; code = value; signal = killedBy;
      resolveTerminal(await proveGroup(entry));
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length; if (bytes > 131072) { failed = true; kill(entry); }
      else if (stream === child.stdout) chunks.push(chunk);
    });
    child.stdin.on('error', () => { failed = true; kill(entry); }); child.stdin.end(input);
    let timer; let cutoff;
    try {
      const finished = await Promise.race([entry.terminal, new Promise(resolve => {
        timer = setTimeout(() => { failed = true; kill(entry); cutoff = setTimeout(() => resolve(false), 1100); }, timeoutMs);
      })]);
      const output = Buffer.concat(chunks).toString('utf8');
      if (!finished || failed || code !== 0 || signal !== null || output.includes(context.environment.FLY_API_TOKEN)) deny('Bounded preflight command failed');
      return output;
    } finally { clearTimeout(timer); clearTimeout(cutoff); }
  }
  return { command, reap };
}
function assertIssuance(receipt, recipe, permission, started) {
  const fields = ['version', 'ownerAttested', 'issuanceSucceeded', 'app', 'scope', 'tokenId', 'tokenName', 'revokedAt', 'issuanceEvidenceId',
    'issuanceStartedAt', 'issuanceCompletedAt', 'requestedLifetimeMs', 'expiresAt'];
  if (!receipt || Object.keys(receipt).some(key => !fields.includes(key)) || receipt.version !== 'p10b-app-token-issuance-v1'
    || receipt.ownerAttested !== true || receipt.issuanceSucceeded !== true || receipt.app !== recipe.app || receipt.scope !== 'app-deploy'
    || receipt.tokenName !== `p10b-runtime-no-email-${recipe.nonce}` || !/^[A-Za-z0-9_:-]{1,120}$/.test(receipt.tokenId || '')
    || !/^[A-Za-z0-9_.:@-]{1,240}$/.test(receipt.issuanceEvidenceId || '') || receipt.revokedAt !== null
    || !canonicalTime(receipt.issuanceStartedAt) || !canonicalTime(receipt.issuanceCompletedAt) || !canonicalTime(receipt.expiresAt)
    || receipt.requestedLifetimeMs !== 7200000 || Date.parse(receipt.issuanceStartedAt) < Date.parse(permission.approvedAt)
    || Date.parse(receipt.issuanceCompletedAt) < Date.parse(receipt.issuanceStartedAt) || Date.parse(receipt.issuanceCompletedAt) > started
    || Date.parse(receipt.issuanceCompletedAt) - Date.parse(receipt.issuanceStartedAt) > 60000
    || Date.parse(receipt.expiresAt) < Date.parse(receipt.issuanceStartedAt) + 7199000
    || Date.parse(receipt.expiresAt) > Date.parse(receipt.issuanceCompletedAt) + 7200000
    || Date.parse(receipt.expiresAt) < started + 3600000) deny('Public issuance metadata insufficient before authentication');
}
export function validateP10bOwnerPublicInputs({ recipe, receipt, permission, clock = Date.now,
  checkSource = assertP10bReviewedCheckout, checkFile = boundP10bOwnerFile } = {}) {
  const checked = checkP10bOwnerRecipe(recipe, { checkSource, checkFile, clock });
  const started = clock();
  if (permission?.version !== 'p10b-owner-private-setup-v1' || permission.approved !== true || permission.recipeDigest !== checked.recipeDigest
    || !canonicalTime(permission.approvedAt) || Date.parse(permission.approvedAt) > started || started - Date.parse(permission.approvedAt) >= 3600000
    || permission.providerCalls !== 0 || permission.emails !== 0 || permission.productionReady !== false
    || permission.globalAutomationPaused !== true || permission.exclusiveAdmissionWriters !== true || permission.recoveryApproved !== true) deny('Explicit private setup scope required');
  assertIssuance(receipt, recipe, permission, started);
  return { status: 'PUBLIC_INPUTS_VALIDATED', tokenInputRequested: false, sessionNotStarted: true };
}
export async function prepareP10bOwnerBundle({ recipe, receipt, permission, environment = process.env, clock = Date.now,
  checkSource = assertP10bReviewedCheckout, checkFile = boundP10bOwnerFile, createCommands = createP10bPreflightCommands } = {}) {
  validateP10bOwnerPublicInputs({ recipe, receipt, permission, checkSource, checkFile, clock });
  const started = clock();
  assertIssuance(receipt, recipe, permission, started);
  const evidence = createP10bOperatorEvidence(recipe.evidenceDirectory);
  const context = createP10bPreflightContext(environment); const commands = createCommands(context);
  let session; let imageEvidence; let failed = true; let interrupted = false; let reaped = false; let cleanupVerified = false;
  const stopOnSignal = () => { interrupted = true; failed = true; void commands.reap(); };
  process.on('SIGTERM', stopOnSignal); process.on('SIGINT', stopOnSignal);
  try {
    const run = (binary, args, timeout = 10000, input) => {
      if (interrupted || clock() < started || clock() - started >= 120000) deny('Original preflight deadline expired');
      return commands.command(binary, args, Math.min(timeout, 120000 - (clock() - started)), input);
    };
    evidence.write('p10b-owner-setup-scope.json', permission); evidence.write('p10b-owner-public-issuance.json', receipt);
    const first = projectP10bStoppedBaseline(JSON.parse(await run(recipe.files.fly.path, ['machines', 'list', '--app', recipe.app, '--json'])), true);
    const actual = projectP10bStoppedBaseline(JSON.parse(await run(recipe.files.fly.path, ['machines', 'list', '--app', recipe.app, '--json'])));
    if (actual.instanceId !== first.instanceId || stableCanonicalJson(actual.environmentNames) !== stableCanonicalJson(first.environmentNames)) deny('Independent baseline identity/name drift');
    await run(recipe.files.probe.path, ['-test.run=^TestBoundedPublicBaselineProbe$', '-test.v'], 10000, stableCanonicalJson(actual.baselineConfig));
    const baselineObservedAt = new Date(clock()).toISOString();
    const names = JSON.parse(await run(recipe.files.names.path, ['--secret-names']));
    if (!Array.isArray(names) || names.length > 32 || new Set(names).size !== names.length
      || names.some(name => typeof name !== 'string' || !/^[A-Z0-9_]{1,120}$/.test(name) || ['RESEND_API_KEY', 'EMAIL_WEBHOOK_SECRET'].includes(name))) deny('Names-only inventory denied');
    names.sort();
    await run(recipe.files.names.path, ['--registry-config'], 5000);
    // Nonempty auths prevents Docker's default credential-store discovery.
    // Pin buildx's first search directory; HOME is also a fresh empty directory.
    const dockerConfig = path.join(context.environment.DOCKER_CONFIG, 'config.json');
    const config = JSON.parse(fs.readFileSync(dockerConfig, 'utf8'));
    if (Object.keys(config).join(',') !== 'auths' || Object.keys(config.auths || {}).join(',') !== 'registry.fly.io'
      || typeof config.auths['registry.fly.io'].auth !== 'string') deny('Isolated SDK registry configuration required');
    config.cliPluginsExtraDirs = [path.dirname(recipe.files.buildx.path)];
    fs.writeFileSync(dockerConfig, JSON.stringify(config), { mode: 0o600 });
    const rawManifest = await run(recipe.files.docker.path,
      ['--config', context.environment.DOCKER_CONFIG, 'buildx', 'imagetools', 'inspect', '--raw', recipe.candidateImage], 20000);
    if (`sha256:${sha256(rawManifest)}` !== P10B_RETAINED_IMAGE) deny('Immutable candidate registry digest drift');
    const manifest = JSON.parse(rawManifest);
    if (manifest.schemaVersion !== 2 || manifest.config?.digest !== 'sha256:c6fdf0239ffcf163bbde675f63c2c1ccfd5033f4fef777fdd10aef3491bac790') deny('Retained candidate manifest binding drift');
    const observedAt = new Date(clock()).toISOString();
    imageEvidence = { version: 'p10b-image-prerequisite-v1', sourceHead: recipe.guestSourceHead,
      imageDigest: P10B_RETAINED_IMAGE, immutableImage: recipe.candidateImage, buildCount: 1, pushCount: 1,
      registryManifestVerified: true, manifestEvidenceDigest: sha256(rawManifest), verifiedAt: observedAt };
    session = { version: 'p10b-no-email-session-v1', app: recipe.app, machineId: recipe.machineId, volumeId: recipe.volumeId,
      sourceHead: recipe.guestSourceHead, hostSourceHead: recipe.hostSourceHead, nonce: recipe.nonce, candidateImageDigest: P10B_RETAINED_IMAGE,
      baselineImageDigest: actual.baselineImageDigest, baselineConfig: actual.baselineConfig,
      ownerPermissionDigest: digest(permission), permissionEvidenceId: `private-owner:${recipe.nonce}`, startedAt: new Date(started).toISOString(),
      sessionDeadline: new Date(started + 3600000).toISOString(), maximumStarts: 2, maximumStartWindowMs: 300000,
      maximumStoppedConfigUpdates: 3, maximumIncrementalUsd: 1, maximumLocalBuilds: 1, maximumImagePushes: 1,
      productionReady: false, globalAutomationPaused: true, nativeClientSha256: recipe.files.native.sha256,
      namesClientPath: recipe.files.names.path, namesClientSha256: recipe.files.names.sha256, authenticationEvidence: receipt,
      configurationEvidence: { version: 'p10b-isolated-configuration-evidence-v2', providerIdentity: P10B_PROVIDER_IDENTITY,
        providerIdentityDigest: p10bProviderIdentityDigest(P10B_PROVIDER_IDENTITY), flySecretMetadataDigest: digest(names), verifiedAt: observedAt },
      budget: { priceEvidenceDigest: recipe.files.price.sha256, maximumUsdPerSecond: 0.000002, fixedIncrementalUsd: 0.8 },
      recovery: { ...recipe.recovery, attemptPath: path.join(recipe.recovery.directory, `${recipe.recovery.packetDigest}.attempt.json`),
        archivePath: path.join(recipe.recovery.directory, `${recipe.machineId}.active.json.archived-uncertain-${recipe.nonce}.json`),
        intentPath: path.join(recipe.evidenceDirectory, 'p10b-recovery-intent.json'), terminalPath: path.join(recipe.evidenceDirectory, 'p10b-recovery-terminal.json') } };
    if (interrupted || clock() - started >= 120000) deny('Original preflight deadline expired');
    validateP10bNoEmailSession(session, clock()); checkSource(recipe.hostSourceHead);
    evidence.write('p10b-owner-public-baseline.json', { ...actual, observedAt: baselineObservedAt, configurationDigest: digest(actual.baselineConfig),
      independentNames: first.environmentNames, sourceHead: recipe.guestSourceHead, hostSourceHead: recipe.hostSourceHead });
    evidence.write('p10b-owner-secret-names.json', { names, namesDigest: digest(names), observedAt, valueDerivedDigestsRequested: false });
    evidence.write('p10b-owner-immutable-manifest.json', manifest);
    failed = interrupted;
  } catch { failed = true; }
  finally {
    process.removeListener('SIGTERM', stopOnSignal); process.removeListener('SIGINT', stopOnSignal);
    try { reaped = await commands.reap() === true; } catch { reaped = false; }
    try { cleanupVerified = context.cleanup(reaped) === true; } catch { cleanupVerified = false; }
    evidence.write('p10b-owner-preflight-closure.json', { success: !failed && reaped && cleanupVerified, reaped, cleanupVerified,
      closedAt: new Date(clock()).toISOString(), privateAuthDirectory: context.directory, productionReady: false, providerCalls: 0, emails: 0 });
  }
  if (failed || !reaped || !cleanupVerified) deny('Preflight held; preserve evidence and uncertain private directories');
  const approval = { version: 'p10b-no-email-approval-v1', approved: false, sessionDigest: digest(session),
    ownerPermissionDigest: session.ownerPermissionDigest, sourceHead: session.sourceHead, hostSourceHead: session.hostSourceHead,
    expiresAt: session.sessionDeadline, recoveryApproved: true, exclusiveAdmissionWriters: true, providerCalls: 0, emails: 0 };
  fs.writeFileSync(recipe.sealedBundlePath, `${stableCanonicalJson({ version: 'p10b-no-email-bundle-v1', status: 'AWAITING_EXACT_OWNER_APPROVAL', session, approval, imageEvidence })}\n`,
    { flag: 'wx', mode: 0o600 });
  return { status: 'AWAITING_EXACT_OWNER_APPROVAL', sessionDigest: digest(session), sessionDeadline: session.sessionDeadline,
    sessionCanonical: stableCanonicalJson(session),
    sealedBundlePath: recipe.sealedBundlePath, sealedBundleSha256: sha256(fs.readFileSync(recipe.sealedBundlePath)),
    privateAuthDirectory: context.directory, preflightCleanupVerified: true, runtimeApproved: false };
}
