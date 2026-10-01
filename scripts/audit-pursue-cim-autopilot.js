import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getConfig } from '../server/config.js';
import { getStorage } from '../server/storage/index.js';
import { CIM_CAMPAIGN_POLICY_VERSION } from '../server/services/cimCampaignPolicy.js';
import { buildPursueCimReleaseEvidence, getPursueCimOperations,
  runPursueCimShadow } from '../server/services/pursueCimOperations.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function gitCandidate(repoRoot) {
  const git = (...args) => execFileSync('git', args,
    { cwd: repoRoot, encoding: 'utf8' }).trim();
  return { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
    clean: git('status', '--porcelain').length === 0 };
}

function scenarioEvidence(document) {
  if (!document || !Array.isArray(document.results) || document.results.length > 200) {
    throw new Error('Scenario results must contain a bounded results array');
  }
  const results = document.results.map((item) => {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const status = item?.status;
    if (!id || id.length > 120 || !['passed', 'failed', 'not-applicable'].includes(status)) {
      throw new Error('Malformed scenario result');
    }
    return { id, status };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(results.map((item) => item.id)).size !== results.length) {
    throw new Error('Duplicate scenario result');
  }
  const attempted = results.filter((item) => item.status !== 'not-applicable').length;
  const passed = results.filter((item) => item.status === 'passed').length;
  return { attempted, passed, failed: attempted - passed,
    digest: sha256(stableCanonicalJson({ version: 'p9-scenario-results-v1', results })) };
}

export async function createPursueCimReleaseEvidenceReport({ storage, config,
  candidate, scenarios, now = new Date().toISOString(), repoRoot = root } = {}) {
  if (!storage || !config) throw new Error('Pursue CIM release-evidence dependencies are required');
  const [operations, shadow] = await Promise.all([
    getPursueCimOperations({ storage, now }),
    runPursueCimShadow({ storage, config, now }),
  ]);
  const providerEnabled = config.delivery?.provider === 'resend'
    && Boolean(config.delivery?.resendApiKey);
  const policy = { version: CIM_CAMPAIGN_POLICY_VERSION,
    batchingPolicyVersion: 'batching-off-v1' };
  const configProjection = {
    deliveryProvider: String(config.delivery?.provider || 'unknown'),
    providerEnabled,
    configuredOutreachPause: config.dealHunter?.cimOutreach?.paused !== false,
    configuredAutomationPause: config.dealHunter?.cimAutomation?.paused !== false,
    durableCentralPause: operations.pause.paused !== false,
  };
  return buildPursueCimReleaseEvidence({ candidate: candidate || gitCandidate(repoRoot),
    policy: { version: policy.version, hash: sha256(stableCanonicalJson(policy)) },
    config: { hash: sha256(stableCanonicalJson(configProjection)), providerEnabled,
      centralPaused: operations.pause.paused !== false },
    scenarios, operations, shadow, generatedAt: now });
}

async function main() {
  const index = process.argv.indexOf('--scenario-results');
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error('Usage: npm run cim:autopilot:evidence -- --scenario-results <path>');
  }
  const document = JSON.parse(await fs.readFile(path.resolve(process.argv[index + 1]), 'utf8'));
  const storage = getStorage();
  try {
    const report = await createPursueCimReleaseEvidenceReport({ storage, config: getConfig(),
      scenarios: scenarioEvidence(document) });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    storage.close?.();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`[pursue-cim-release-evidence] ${error.message}\n`);
    process.exitCode = 1;
  });
}
