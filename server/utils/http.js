export function getClientIp(request) {
  const headers = request?.headers || {};
  const trustedHeaders = [
    headers['fly-client-ip'],
    headers['cf-connecting-ip'],
    headers['x-real-ip'],
    headers['x-vercel-forwarded-for'],
  ];

  for (const header of trustedHeaders) {
    const value = firstHeaderValue(header);

    if (value) {
      return value;
    }
  }

  const forwardedFor = lastHeaderValue(headers['x-forwarded-for']);

  if (forwardedFor) {
    return forwardedFor;
  }

  return sanitizeHeaderValue(request?.ip || request?.socket?.remoteAddress || 'unknown') || 'unknown';
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) {
    return firstHeaderValue(value[0]);
  }

  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  return sanitizeHeaderValue(value.split(',')[0]);
}

function lastHeaderValue(value) {
  if (Array.isArray(value)) {
    return lastHeaderValue(value[value.length - 1]);
  }

  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  const parts = value.split(',').map((part) => sanitizeHeaderValue(part)).filter(Boolean);
  return parts.at(-1) || '';
}

function sanitizeHeaderValue(value) {
  return String(value || '').trim();
}

export function getRequestOrigin(request, fallbackOrigin = '') {
  if (process.env.NODE_ENV === 'production' && fallbackOrigin) {
    try {
      const url = new URL(fallbackOrigin);
      return url.origin;
    } catch {
      return fallbackOrigin.replace(/\/+$/, '');
    }
  }

  const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto']);
  const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host']);
  const host = forwardedHost || firstHeaderValue(request.headers.host);
  const protocol = forwardedProto || (request.socket?.encrypted ? 'https' : 'http');

  if (!host) {
    return fallbackOrigin;
  }

  return `${protocol}://${host}`;
}

export function asyncRoute(handler) {
  return async (request, response, next) => {
    try {
      await handler(request, response);
    } catch (error) {
      next(error);
    }
  };
}
