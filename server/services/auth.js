import { getConfig } from '../config.js';
import { clearCookie, parseCookies, serializeCookie } from '../utils/cookies.js';
import { getRequestOrigin } from '../utils/http.js';
import { safeCompareText, signPayload, verifySignedPayload } from '../utils/security.js';
import { sendAdminMagicLinkEmail } from './delivery.js';

function createSessionCookie(session) {
  const config = getConfig();
  const token = signPayload(session, config.admin.sessionSecret);

  return serializeCookie(config.admin.sessionCookieName, token, {
    httpOnly: true,
    maxAge: config.admin.sessionMaxAgeMs,
    path: '/',
    sameSite: 'Lax',
    secure: config.isProduction,
  });
}

function maskEmail(value) {
  const email = String(value || '').trim();

  if (!email.includes('@')) {
    return '';
  }

  const [localPart, domain] = email.split('@');
  return `${localPart.slice(0, 2)}***@${domain}`;
}

function createAdminSession(username) {
  return {
    role: 'admin',
    username,
    exp: Date.now() + getConfig().admin.sessionMaxAgeMs,
  };
}

export function getAdminSession(request) {
  const config = getConfig();
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[config.admin.sessionCookieName];
  return verifySignedPayload(token, config.admin.sessionSecret);
}

export function requireAdmin(request) {
  const session = getAdminSession(request);

  if (!session || session.role !== 'admin') {
    return null;
  }

  return session;
}

export function getAdminAuthState() {
  const config = getConfig();
  const outboundMagicLinkSupported = config.delivery.provider !== 'formspree';

  return {
    authMode: config.admin.authMode,
    magicLinkEnabled: Boolean(config.admin.email && config.admin.magicLinkSecret && outboundMagicLinkSupported),
    passwordEnabled: Boolean(config.admin.allowPasswordAuth && config.admin.username && config.admin.password),
    adminEmailHint: maskEmail(config.admin.email),
  };
}

export function loginAdmin(username, password) {
  const config = getConfig();

  if (!config.admin.allowPasswordAuth) {
    return { ok: false, reason: 'Password sign-in is disabled. Use the magic-link flow instead.' };
  }

  if (!config.admin.username || !config.admin.password || !config.admin.sessionSecret) {
    return { ok: false, reason: 'Admin credentials are not configured.' };
  }

  if (!safeCompareText(username, config.admin.username) || !safeCompareText(password, config.admin.password)) {
    return { ok: false, reason: 'Invalid credentials.' };
  }

  const session = createAdminSession(config.admin.username);

  return {
    ok: true,
    session,
    cookie: createSessionCookie(session),
  };
}

export async function requestAdminMagicLink(email, request) {
  const config = getConfig();

  if (!config.admin.email || !config.admin.magicLinkSecret) {
    return { ok: false, reason: 'Magic-link sign-in is not configured.' };
  }

  if (config.delivery.provider === 'formspree') {
    return { ok: false, reason: 'Magic-link emails require Resend, EmailJS, or console delivery. Formspree only handles inbound lead routing.' };
  }

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const expectedEmail = config.admin.email.trim().toLowerCase();

  if (!normalizedEmail || normalizedEmail !== expectedEmail) {
    return {
      ok: true,
      message: 'If that email is allowed for admin access, a sign-in link has been sent.',
    };
  }

  const expiresAt = new Date(Date.now() + config.admin.magicLinkTtlMs).toISOString();
  const token = signPayload(
    {
      type: 'admin-magic-link',
      email: expectedEmail,
      exp: Date.now() + config.admin.magicLinkTtlMs,
    },
    config.admin.magicLinkSecret,
  );
  const publicOrigin = getRequestOrigin(request, config.server.origin);
  const magicLinkUrl = `${publicOrigin}/admin?admin_token=${encodeURIComponent(token)}`;
  const deliveryResult = await sendAdminMagicLinkEmail({
    to: config.admin.email,
    magicLinkUrl,
    expiresAt,
  });

  if (deliveryResult.status === 'failed') {
    return { ok: false, reason: deliveryResult.error };
  }

  return {
    ok: true,
    message: 'A secure sign-in link has been sent to the admin email address.',
    previewUrl: config.isProduction ? '' : magicLinkUrl,
  };
}

export function verifyAdminMagicLink(token) {
  const config = getConfig();
  const payload = verifySignedPayload(token, config.admin.magicLinkSecret);

  if (!payload || payload.type !== 'admin-magic-link' || payload.email !== config.admin.email.trim().toLowerCase()) {
    return { ok: false, reason: 'That sign-in link is invalid or has expired.' };
  }

  const session = createAdminSession(config.admin.email);

  return {
    ok: true,
    session,
    cookie: createSessionCookie(session),
  };
}

export function logoutAdmin() {
  const config = getConfig();
  return clearCookie(config.admin.sessionCookieName, {
    path: '/',
    sameSite: 'Lax',
    secure: config.isProduction,
  });
}
