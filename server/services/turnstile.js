import { getConfig } from '../config.js';
import { fetchWithTimeout } from '../utils/http.js';

export async function verifyTurnstileToken(token, remoteIp) {
  const config = getConfig();
  const enabled = Boolean(config.turnstile.siteKey && config.turnstile.secretKey);

  if (!enabled) {
    return {
      enabled: false,
      success: true,
      error: '',
    };
  }

  if (!token) {
    return {
      enabled: true,
      success: false,
      error: 'Please complete the anti-spam verification before submitting.',
    };
  }

  let response;

  try {
    response = await fetchWithTimeout('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      timeoutMs: config.server.outboundRequestTimeoutMs,
      timeoutMessage: 'Anti-spam verification timed out.',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        secret: config.turnstile.secretKey,
        response: token,
        remoteip: remoteIp,
      }),
    });
  } catch (error) {
    console.warn(`[turnstile] provider request failed: ${error.message}`);
    return {
      enabled: true,
      success: false,
      error: 'Anti-spam verification could not be validated.',
    };
  }

  if (!response.ok) {
    return {
      enabled: true,
      success: false,
      error: 'Anti-spam verification could not be validated.',
    };
  }

  const result = await response.json().catch(() => null);
  const success = Boolean(result?.success);

  if (!success) {
    const errorCodes = Array.isArray(result?.['error-codes']) ? result['error-codes'].join(',') : 'unknown';
    const hostname = result?.hostname || 'unknown';
    console.warn(`[turnstile] verification failed codes=${errorCodes} hostname=${hostname}`);
  }

  return {
    enabled: true,
    success,
    error: success ? '' : 'Anti-spam verification failed. Please try again.',
  };
}
