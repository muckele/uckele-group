export function getClientIp(request) {
  const forwardedFor = request.headers['x-forwarded-for'];

  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0].trim();
  }

  const realIp = request.headers['x-real-ip'];

  if (typeof realIp === 'string' && realIp.length > 0) {
    return realIp.trim();
  }

  return request.ip || request.socket?.remoteAddress || 'unknown';
}

function firstHeaderValue(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  return value.split(',')[0].trim();
}

export function getRequestOrigin(request, fallbackOrigin = '') {
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
