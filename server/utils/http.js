function firstHeaderValue(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  return value.split(',')[0].trim();
}

export function getClientIp(request, { trustProxy = false } = {}) {
  if (trustProxy) {
    const trustedProxyIp =
      firstHeaderValue(request.headers['fly-client-ip']) ||
      firstHeaderValue(request.headers['cf-connecting-ip']) ||
      firstHeaderValue(request.headers['x-real-ip']);

    if (trustedProxyIp) {
      return trustedProxyIp;
    }
  }

  return request.ip || request.socket?.remoteAddress || 'unknown';
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
