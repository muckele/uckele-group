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

export function asyncRoute(handler) {
  return async (request, response, next) => {
    try {
      await handler(request, response);
    } catch (error) {
      next(error);
    }
  };
}
