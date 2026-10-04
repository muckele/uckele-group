import { performance } from 'node:perf_hooks';

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const instancePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const statePattern = /^[a-z][a-z-]{0,39}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const leasePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const waitStates = new Set(['started', 'stopped', 'suspended', 'destroyed']);

class FlyMachinesApiResponseError extends Error {}

// This is intentionally a low-level provider client. The caller must choose lease TTL,
// renewal, generation ownership, and release policy before mapping it into the control seam.

function requireIdentity(value, label) {
  if (!identityPattern.test(String(value || ''))) throw new Error(`${label} is invalid.`);
  return String(value);
}

function requireBaseUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Fly Machines API base URL is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search
    || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new Error('Fly Machines API base URL must be an exact HTTPS origin.');
  }
  return parsed.origin;
}

function requireCommand({ deadlineAt, signal } = {}) {
  if (!Number.isFinite(deadlineAt) || deadlineAt <= performance.now()) {
    throw new Error('Fly Machines API deadline is invalid or expired.');
  }
  if (!signal || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function') {
    throw new Error('Fly Machines API abort signal is required.');
  }
  if (signal.aborted) throw new Error('Fly Machines API request was aborted.');
  return { deadlineAt, signal };
}

function requireLeaseNonce(value) {
  if (!leasePattern.test(String(value || ''))) throw new Error('Fly Machine lease nonce is invalid.');
  return String(value);
}

function requireSeconds(value, label, maximum = 86_400) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireDescription(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || /[\r\n]/.test(value)) {
    throw new Error('Fly Machine lease description is invalid.');
  }
  return value;
}

async function readJson(response, maximum, abort) {
  if (!response?.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    throw new FlyMachinesApiResponseError('Fly Machines API response body was invalid.');
  }
  const chunks = [];
  let size = 0;
  for await (const value of response.body) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maximum) {
      abort();
      throw new FlyMachinesApiResponseError('Fly Machines API response exceeded the configured cap.');
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new FlyMachinesApiResponseError('Fly Machines API response was invalid.');
  }
}

async function abortResponse(response, abort) {
  abort();
  try { await response?.body?.cancel?.(); } catch {
    // The provider response is already rejected; cancellation is best-effort cleanup.
  }
}

function normalizeInspection(value, expectedMachineId) {
  if (!value || value.id !== expectedMachineId) {
    throw new Error('Fly Machines API returned the wrong Machine.');
  }
  if (!statePattern.test(String(value.state || ''))) {
    throw new Error('Fly Machines API returned an invalid Machine state.');
  }
  if (!instancePattern.test(String(value.instance_id || ''))) {
    throw new Error('Fly Machines API returned an invalid instance identity.');
  }
  if (value.nonce !== null && value.nonce !== undefined
    && !instancePattern.test(String(value.nonce))) {
    throw new Error('Fly Machines API returned an invalid lease nonce.');
  }
  if (value.private_ip !== null && value.private_ip !== undefined
    && (typeof value.private_ip !== 'string' || value.private_ip.length > 160)) {
    throw new Error('Fly Machines API returned an invalid private address.');
  }
  const imageDigest = value.image_ref?.digest ?? null;
  if (imageDigest !== null && !digestPattern.test(String(imageDigest))) {
    throw new Error('Fly Machines API returned an invalid image digest.');
  }
  return Object.freeze({
    machineId: value.id,
    state: value.state,
    instanceId: value.instance_id,
    leaseNonce: value.nonce ?? null,
    privateIp: value.private_ip ?? null,
    imageDigest,
  });
}

function normalizeLease(value) {
  const lease = value?.status === 'success' ? value.data : null;
  if (!lease || !leasePattern.test(String(lease.nonce || ''))
    || !Number.isSafeInteger(lease.expires_at) || lease.expires_at < 1
    || !instancePattern.test(String(lease.version || ''))
    || typeof lease.owner !== 'string' || lease.owner.length < 1 || lease.owner.length > 200
    || typeof lease.description !== 'string' || lease.description.length > 200) {
    throw new Error('Fly Machines API returned an invalid lease.');
  }
  return Object.freeze({
    nonce: lease.nonce,
    expiresAt: lease.expires_at,
    owner: lease.owner,
    description: lease.description,
    version: lease.version,
  });
}

function normalizeOk(value, operation) {
  const result = value?.status === 'success' ? value.data : value;
  if (result?.ok !== true) throw new Error(`Fly Machines API ${operation} result was invalid.`);
  return Object.freeze({ ok: true });
}

function normalizeStart(value) {
  if (!value || !statePattern.test(String(value.previous_state || ''))
    || typeof value.migrated !== 'boolean'
    || typeof value.new_host !== 'string' || value.new_host.length > 200) {
    throw new Error('Fly Machines API start result was invalid.');
  }
  return Object.freeze({
    previousState: value.previous_state,
    migrated: value.migrated,
    newHost: value.new_host || null,
  });
}

export function createFlyMachinesApiClient({
  apiBaseUrl,
  appName,
  machineId,
  accessToken,
  maxResponseBytes,
  fetchImpl,
} = {}) {
  const baseUrl = requireBaseUrl(apiBaseUrl);
  const exactAppName = requireIdentity(appName, 'Fly application identity');
  const exactMachineId = requireIdentity(machineId, 'Fly Machine identity');
  if (typeof accessToken !== 'string' || accessToken.length < 1 || accessToken.length > 4_096
    || /[\r\n]/.test(accessToken)) {
    throw new Error('An explicit bounded Fly access token is required.');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 262_144) {
    throw new Error('Fly Machines API response cap is invalid.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('An injected Fly HTTP transport is required.');
  const machinePath = `/v1/apps/${encodeURIComponent(exactAppName)}/machines/${encodeURIComponent(exactMachineId)}`;

  async function request(path, {
    operation,
    method = 'GET',
    body,
    leaseNonce,
    expectedStatus = 200,
    ...command
  }) {
    const { deadlineAt, signal } = requireCommand(command);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.max(1, Math.ceil(deadlineAt - performance.now())));
    try {
      let response;
      try {
        const headers = {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
        };
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (leaseNonce !== undefined) {
          headers['fly-machine-lease-nonce'] = requireLeaseNonce(leaseNonce);
        }
        response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          redirect: 'error',
          headers: Object.freeze(headers),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
      } catch {
        throw new Error(controller.signal.aborted
          ? 'Fly Machines API request was aborted or exceeded its deadline.'
          : 'Fly Machines API request failed.');
      }
      if (!response || response.status !== expectedStatus) {
        await abortResponse(response, abort);
        throw new Error(`Fly Machines API ${operation} request was not successful.`);
      }
      try {
        return await readJson(response, maxResponseBytes, abort);
      } catch (error) {
        if (error instanceof FlyMachinesApiResponseError) throw error;
        throw new Error(controller.signal.aborted
          ? 'Fly Machines API request was aborted or exceeded its deadline.'
          : 'Fly Machines API response could not be read.');
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  return Object.freeze({
    async inspect(command = {}) {
      return normalizeInspection(await request(machinePath, {
        ...command, operation: 'inspect',
      }), exactMachineId);
    },

    async acquireLease({ ttlSeconds, description, ...command } = {}) {
      return normalizeLease(await request(`${machinePath}/lease`, {
        ...command,
        operation: 'lease acquisition',
        method: 'POST',
        body: {
          ttl: requireSeconds(ttlSeconds, 'Fly Machine lease TTL'),
          description: requireDescription(description),
        },
        expectedStatus: 201,
      }));
    },

    async releaseLease({ leaseNonce, ...command } = {}) {
      return normalizeOk(await request(`${machinePath}/lease`, {
        ...command,
        operation: 'lease release',
        method: 'DELETE',
        leaseNonce,
      }), 'lease release');
    },

    async start({ leaseNonce, ...command } = {}) {
      return normalizeStart(await request(`${machinePath}/start`, {
        ...command,
        operation: 'start',
        method: 'POST',
        leaseNonce,
      }));
    },

    async wait({ leaseNonce, instanceId, state, timeoutSeconds, ...command } = {}) {
      if (!instancePattern.test(String(instanceId || ''))) {
        throw new Error('Fly Machine wait instance identity is invalid.');
      }
      if (!waitStates.has(state)) throw new Error('Fly Machine wait state is invalid.');
      const query = new URLSearchParams({
        state,
        instance_id: instanceId,
        timeout: String(requireSeconds(timeoutSeconds, 'Fly Machine wait timeout', 300)),
      });
      return normalizeOk(await request(`${machinePath}/wait?${query}`, {
        ...command,
        operation: 'wait',
        leaseNonce,
      }), 'wait');
    },

    async stop({ leaseNonce, stopSignal, timeoutSeconds, ...command } = {}) {
      if (!/^SIG[A-Z0-9]{1,12}$/.test(String(stopSignal || ''))) {
        throw new Error('Fly Machine stop signal is invalid.');
      }
      return normalizeOk(await request(`${machinePath}/stop`, {
        ...command,
        operation: 'stop',
        method: 'POST',
        leaseNonce,
        body: {
          signal: stopSignal,
          timeout: String(requireSeconds(timeoutSeconds, 'Fly Machine stop timeout', 300)),
        },
      }), 'stop');
    },
  });
}
