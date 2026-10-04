import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import {
  createSyntheticCloudScannerFactory,
  createGeneratedSyntheticScanJob,
  createPinnedNodeHttpsRequestImpl,
  loadCimScanSyntheticCallerConfig,
  runGeneratedSyntheticScanJobs,
} from '../server/services/cimScanSyntheticCloudCaller.js';

const environment = Object.freeze({
  CIM_SCAN_FLY_MACHINE_ID: 'machine-1',
  CIM_SCAN_FLY_APP_NAME: 'ug-cim-scan-benchmark',
  CIM_SCAN_FLY_API_BASE_URL: 'https://api.machines.dev',
  CIM_SCAN_FLY_TOKEN_FILE: '/run/secrets/fly-scanner-token',
  CIM_SCAN_CA_FILE: '/run/config/cim-scan-ca.pem',
  CIM_SCAN_CERTIFICATE_PIN_SHA256: 'a'.repeat(64),
  CIM_SCAN_KEY_ID: 'synthetic-key-1',
  CIM_SCAN_KEY_FILE: '/run/secrets/cim-scan-protocol-key',
  CIM_SCAN_JOB_OWNER: 'synthetic-cloud-caller',
});

test('synthetic caller requires exact identities, pins, and file-backed credentials without defaults', () => {
  assert.deepEqual(loadCimScanSyntheticCallerConfig(environment), {
    machineId: environment.CIM_SCAN_FLY_MACHINE_ID,
    appName: environment.CIM_SCAN_FLY_APP_NAME,
    apiBaseUrl: environment.CIM_SCAN_FLY_API_BASE_URL,
    accessTokenFile: environment.CIM_SCAN_FLY_TOKEN_FILE,
    caFile: environment.CIM_SCAN_CA_FILE,
    certificatePinSha256: environment.CIM_SCAN_CERTIFICATE_PIN_SHA256,
    keyId: environment.CIM_SCAN_KEY_ID,
    keyFile: environment.CIM_SCAN_KEY_FILE,
    jobOwner: environment.CIM_SCAN_JOB_OWNER,
  });
  for (const field of [
    'CIM_SCAN_FLY_MACHINE_ID', 'CIM_SCAN_FLY_APP_NAME', 'CIM_SCAN_FLY_API_BASE_URL',
    'CIM_SCAN_FLY_TOKEN_FILE', 'CIM_SCAN_CA_FILE', 'CIM_SCAN_CERTIFICATE_PIN_SHA256',
    'CIM_SCAN_KEY_ID', 'CIM_SCAN_KEY_FILE', 'CIM_SCAN_JOB_OWNER',
  ]) {
    assert.throws(() => loadCimScanSyntheticCallerConfig({ ...environment, [field]: undefined }),
      /required|invalid|absolute|pin|URL/i, field);
  }
});

test('Node request wrapper injects one CA while preserving exact SNI, pin callback, and normal verification', () => {
  const ca = Buffer.from('synthetic-private-ca-certificate');
  let observed;
  const wrapped = createPinnedNodeHttpsRequestImpl({
    ca,
    requestImpl(url, options, respond) {
      observed = { url, options, respond };
      return { synthetic: true };
    },
  });
  const checkServerIdentity = () => undefined;
  const responseHandler = () => {};
  const result = wrapped(new URL('https://machine-1.vm.ug-cim-scan-benchmark.internal:8443/v1/cim-scan'), {
    method: 'POST',
    servername: 'machine-1.vm.ug-cim-scan-benchmark.internal',
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    checkServerIdentity,
  }, responseHandler);
  assert.deepEqual(result, { synthetic: true });
  assert.equal(observed.options.ca, ca);
  assert.equal(observed.options.rejectUnauthorized, true);
  assert.equal(observed.options.minVersion, 'TLSv1.2');
  assert.equal(observed.options.servername, 'machine-1.vm.ug-cim-scan-benchmark.internal');
  assert.equal(observed.options.checkServerIdentity, checkServerIdentity);
  assert.equal(observed.respond, responseHandler);
  assert.throws(() => createPinnedNodeHttpsRequestImpl({ ca: Buffer.alloc(0), requestImpl() {} }),
    /CA|certificate/i);
});

test('generated caller creates non-user bytes lazily and a fresh composition for every job', async () => {
  const now = () => new Date('2026-10-03T12:00:00.000Z');
  const jobs = [
    createGeneratedSyntheticScanJob({
      name: 'clean-1k', sizeBytes: 1_024,
      requestId: '11111111-1111-4111-8111-111111111111',
      intakeId: '12222222-2222-4222-8222-222222222222',
      jobOwner: 'synthetic-cloud-caller', now,
    }),
    createGeneratedSyntheticScanJob({
      name: 'clean-8m', sizeBytes: 8 * 1024 * 1024,
      requestId: '21111111-1111-4111-8111-111111111111',
      intakeId: '22222222-2222-4222-8222-222222222222',
      jobOwner: 'synthetic-cloud-caller', now,
    }),
  ];
  let compositions = 0;
  const opened = [];
  const results = await runGeneratedSyntheticScanJobs({
    jobs,
    createScannerComposition() {
      compositions += 1;
      return {
        scanner: {
          async scan(input) {
            let size = 0;
            for await (const chunk of input.openByteStream()) size += chunk.length;
            opened.push(size);
            return { outcome: 'clean', reasonCode: 'clean' };
          },
        },
      };
    },
  });
  assert.equal(compositions, 2);
  assert.deepEqual(opened, [1_024, 8 * 1024 * 1024]);
  assert.deepEqual(results.map(({ name, result }) => ({ name, outcome: result.outcome })), [
    { name: 'clean-1k', outcome: 'clean' },
    { name: 'clean-8m', outcome: 'clean' },
  ]);
  assert.equal(jobs[0].openCount(), 1);
  assert.equal(jobs[1].openCount(), 1);
  assert.throws(() => jobs[0].openByteStream(), /once/i);
});

test('generated caller refuses unsupported sizes and invalid composition results before scanning', async () => {
  const base = {
    name: 'invalid',
    requestId: '31111111-1111-4111-8111-111111111111',
    intakeId: '32222222-2222-4222-8222-222222222222',
    jobOwner: 'synthetic-cloud-caller',
    now: () => new Date('2026-10-03T12:00:00.000Z'),
  };
  assert.throws(() => createGeneratedSyntheticScanJob({ ...base, sizeBytes: 0 }), /size/i);
  assert.throws(() => createGeneratedSyntheticScanJob({ ...base, sizeBytes: 8 * 1024 * 1024 + 1 }), /size/i);
  const job = createGeneratedSyntheticScanJob({ ...base, sizeBytes: 1_024 });
  await assert.rejects(runGeneratedSyntheticScanJobs({ jobs: [job], createScannerComposition: () => ({}) }),
    /scanner|composition/i);
  assert.equal(job.openCount(), 0);
});

test('caller factory reads explicit files once and creates a new exact-port composition per scan', async () => {
  const reads = [];
  const compositions = [];
  const factory = await createSyntheticCloudScannerFactory({
    config: loadCimScanSyntheticCallerConfig(environment),
    async readFile(file, options) {
      reads.push({ file, options });
      if (file === environment.CIM_SCAN_FLY_TOKEN_FILE) return Buffer.from('synthetic-token\n');
      if (file === environment.CIM_SCAN_CA_FILE) return Buffer.from('synthetic-ca');
      return Buffer.alloc(32, 9);
    },
    fetchImpl: async () => { throw new Error('must stay inert'); },
    requestImpl() { throw new Error('must stay inert'); },
    wallNowMs: () => 1_700_000_000_000,
    monotonicNow: () => 10,
    now: () => new Date('2026-10-03T12:00:00.000Z'),
    composeScanner(options) {
      compositions.push(options);
      return { scanner: { scan() {} } };
    },
  });
  assert.deepEqual(reads.map(({ file }) => file), [
    environment.CIM_SCAN_FLY_TOKEN_FILE,
    environment.CIM_SCAN_CA_FILE,
    environment.CIM_SCAN_KEY_FILE,
  ]);
  assert.notEqual(factory(), factory());
  assert.equal(compositions.length, 2);
  for (const options of compositions) {
    assert.equal(options.port, 8443);
    assert.equal(options.accessToken, 'synthetic-token');
    assert.equal(options.keyResolver('synthetic-key-1').length, 32);
    assert.equal(options.keyResolver('other'), null);
    assert.equal(typeof options.requestImpl, 'function');
  }
});

test('standalone caller exposes only bounded generated scenarios and no production registration', async () => {
  const source = await fsp.readFile('scripts/run-cim-scan-cloud-synthetic.js', 'utf8');
  assert.match(source, /clean-1k/);
  assert.match(source, /clean-8m/);
  assert.match(source, /stale-1k/);
  assert.match(source, /createSyntheticCloudScannerFactory/);
  assert.doesNotMatch(source, /BenchmarkClock|createSyntheticScenarioClock|CLOCK_OFFSET/);
  assert.doesNotMatch(source, /server\/index|server\/app|secureDocuments|scannerReady|intake\.enabled/);
});
