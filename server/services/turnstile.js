import { getConfig } from '../config.js';

export async function verifyTurnstileToken(token, remoteIp) {
  const config = getConfig();

  if (!config.turnstile.secretKey) {
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

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      secret: config.turnstile.secretKey,
      response: token,
      remoteip: remoteIp,
    }),
  });

  if (!response.ok) {
    return {
      enabled: true,
      success: false,
      error: 'Anti-spam verification could not be validated.',
    };
  }

  const result = await response.json();

  return {
    enabled: true,
    success: Boolean(result.success),
    error: result.success ? '' : 'Anti-spam verification failed. Please try again.',
  };
}
