import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { clearCookie, parseCookies, serializeCookie } from '../utils/cookies.js';
import { getClientIp, getRequestOrigin } from '../utils/http.js';
import { hashIp, safeCompareText, sha256, signPayload, verifySignedPayload } from '../utils/security.js';
import { sendAdminMagicLinkEmail } from './delivery.js';

const adminAuthRateLimitEvents = new Map();
const magicLinkGenericMessage = 'If that email is allowed for private access, a sign-in link has been sent.';
const primaryAdminPrincipalId = 'admin:primary';

function createSessionCookie(session) {
  const config = getConfig();
  const token = signPayload({
    sid: session.id,
    role: session.role,
    username: session.username,
    exp: Date.parse(session.expires_at),
  }, config.admin.sessionSecret);

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

function getSessionPrincipalId(username, role) {
  if (role === 'admin') {
    return primaryAdminPrincipalId;
  }

  return `viewer:identity:${normalizeEmail(username)}`;
}

async function issueAdminSession(username, role = 'admin', authMethod = 'password', request = {}, storage = getStorage()) {
  const now = new Date();
  const record = {
    id: randomUUID(),
    role,
    username,
    principal_id: getSessionPrincipalId(username, role),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + getConfig().admin.sessionMaxAgeMs).toISOString(),
    last_seen_at: now.toISOString(),
    revoked_at: null,
    created_ip_hash: hashIp(getClientIp(request)),
    user_agent: String(request.headers?.['user-agent'] || '').slice(0, 300),
    metadata: { auth_method: authMethod },
  };
  const session = await storage.insertAdminSession(record);
  return { session, cookie: createSessionCookie(session) };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function getViewerEmailMatch(email, config) {
  const normalizedEmail = normalizeEmail(email);
  return (config.admin.viewerEmails || []).find((viewerEmail) => normalizeEmail(viewerEmail) === normalizedEmail) || '';
}

function buildMagicLinkRateLimitBuckets(email, request) {
  const normalizedEmail = String(email || '').trim().toLowerCase() || 'empty';
  return [
    `admin-magic-link:ip:${hashIp(getClientIp(request))}`,
    `admin-magic-link:email:${sha256(normalizedEmail).slice(0, 24)}`,
  ];
}

function buildPasswordLoginRateLimitBuckets(username, request) {
  const normalizedUsername = String(username || '').trim().toLowerCase() || 'empty';
  return [
    `admin-password:ip:${hashIp(getClientIp(request))}`,
    `admin-password:username:${sha256(normalizedUsername).slice(0, 24)}`,
  ];
}

function enforceInMemoryRateLimit(buckets, windowMs, maxAttempts) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const snapshots = buckets.map((bucket) => ({
    bucket,
    timestamps: (adminAuthRateLimitEvents.get(bucket) || []).filter((timestamp) => timestamp >= cutoff),
  }));

  if (snapshots.some((snapshot) => snapshot.timestamps.length >= maxAttempts)) {
    return { blocked: true };
  }

  for (const snapshot of snapshots) {
    adminAuthRateLimitEvents.set(snapshot.bucket, [...snapshot.timestamps, now]);
  }

  return { blocked: false };
}

async function enforceAdminRateLimit({ buckets, maxAttempts, windowMs, blockedReason, logLabel }) {
  const blockedResult = {
    ok: false,
    status: 429,
    reason: blockedReason,
  };

  try {
    const storage = getStorage();
    const windowStartIso = new Date(Date.now() - windowMs).toISOString();
    const counts = await Promise.all(buckets.map((bucket) => storage.countRateLimitEvents(bucket, windowStartIso)));

    if (counts.some((count) => count >= maxAttempts)) {
      return blockedResult;
    }

    const nowIso = new Date().toISOString();
    await Promise.all(buckets.map((bucket) => storage.addRateLimitEvent(bucket, nowIso)));
    return { ok: true };
  } catch (error) {
    console.warn(`[admin-auth] ${logLabel} rate limit storage failed: ${error.message}`);
    return enforceInMemoryRateLimit(buckets, windowMs, maxAttempts).blocked ? blockedResult : { ok: true };
  }
}

async function enforceMagicLinkRateLimit(email, request) {
  const config = getConfig();
  return enforceAdminRateLimit({
    buckets: buildMagicLinkRateLimitBuckets(email, request),
    maxAttempts: Math.max(1, Math.min(config.protection.rateLimitMax, 3)),
    windowMs: config.protection.rateLimitWindowMs,
    blockedReason: 'Too many sign-in link requests. Please wait a few minutes and try again.',
    logLabel: 'magic-link',
  });
}

async function enforcePasswordLoginRateLimit(username, request) {
  const config = getConfig();
  return enforceAdminRateLimit({
    buckets: buildPasswordLoginRateLimitBuckets(username, request),
    maxAttempts: Math.max(1, Math.min(config.protection.rateLimitMax, 5)),
    windowMs: config.protection.rateLimitWindowMs,
    blockedReason: 'Too many password sign-in attempts. Please wait a few minutes and try again.',
    logLabel: 'password',
  });
}

export async function getAdminSession(request, { storage = getStorage() } = {}) {
  if (request.adminSession) return request.adminSession;
  const config = getConfig();
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[config.admin.sessionCookieName];
  const payload = verifySignedPayload(token, config.admin.sessionSecret);

  if (!payload?.sid || !['admin', 'viewer'].includes(payload.role)) {
    return null;
  }

  try {
    const session = await storage.getAdminSession(payload.sid);
    const now = new Date().toISOString();
    if (
      !session || session.revoked_at || session.expires_at <= now ||
      session.username !== payload.username || session.role !== payload.role
    ) {
      return null;
    }
    request.adminSession = session;
    await storage.touchAdminSession?.(session.id, now);
    session.last_seen_at = now;
    return session;
  } catch (error) {
    console.warn(`[admin-auth] session lookup failed: ${error.message}`);
    return null;
  }
}

export async function requireAdmin(request) {
  const session = await getAdminSession(request);

  if (!session || session.role !== 'admin') {
    return null;
  }

  return session;
}

export async function requireAdminAccess(request) {
  const session = await getAdminSession(request);

  if (!session || !['admin', 'viewer'].includes(session.role)) {
    return null;
  }

  return session;
}

export function getAdminAuthState() {
  const config = getConfig();
  const outboundMagicLinkSupported = config.delivery.provider !== 'formspree';
  const adminPasswordEnabled = Boolean(config.admin.username && config.admin.password);
  const viewerPasswordEnabled = Boolean(config.admin.viewerUsername && config.admin.viewerPassword);
  const viewerMagicLinkEnabled = Boolean(config.admin.viewerEmails?.length);

  return {
    authMode: config.admin.authMode,
    magicLinkEnabled: Boolean((config.admin.email || viewerMagicLinkEnabled) && config.admin.magicLinkSecret && outboundMagicLinkSupported),
    passwordEnabled: Boolean(config.admin.allowPasswordAuth && (adminPasswordEnabled || viewerPasswordEnabled)),
    adminEmailHint: maskEmail(config.admin.email),
    viewerAccessEnabled: Boolean(viewerMagicLinkEnabled || viewerPasswordEnabled),
  };
}

export async function loginAdmin(username, password, request) {
  const config = getConfig();

  if (!config.admin.allowPasswordAuth) {
    return { ok: false, reason: 'Password sign-in is disabled. Use the magic-link flow instead.' };
  }

  if (!config.admin.sessionSecret) {
    return { ok: false, reason: 'Admin credentials are not configured.' };
  }

  const rateLimitResult = await enforcePasswordLoginRateLimit(username, request);

  if (!rateLimitResult.ok) {
    return rateLimitResult;
  }

  if (config.admin.username && config.admin.password && safeCompareText(username, config.admin.username) && safeCompareText(password, config.admin.password)) {
    return {
      ok: true,
      ...(await issueAdminSession(config.admin.username, 'admin', 'password', request)),
    };
  }

  if (
    config.admin.viewerUsername &&
    config.admin.viewerPassword &&
    safeCompareText(username, config.admin.viewerUsername) &&
    safeCompareText(password, config.admin.viewerPassword)
  ) {
    return {
      ok: true,
      ...(await issueAdminSession(config.admin.viewerUsername, 'viewer', 'password', request)),
    };
  }

  if (!config.admin.username && !config.admin.viewerUsername) {
    return { ok: false, reason: 'Admin credentials are not configured.' };
  }

  return { ok: false, reason: 'Invalid credentials.' };
}

export async function requestAdminMagicLink(email, request) {
  const config = getConfig();

  if ((!config.admin.email && !config.admin.viewerEmails?.length) || !config.admin.magicLinkSecret) {
    return { ok: false, reason: 'Magic-link sign-in is not configured.' };
  }

  if (config.delivery.provider === 'formspree') {
    return { ok: false, reason: 'Magic-link emails require Resend, EmailJS, or console delivery. Formspree only handles inbound lead routing.' };
  }

  const normalizedEmail = normalizeEmail(email);
  const expectedEmail = normalizeEmail(config.admin.email);
  const matchedViewerEmail = getViewerEmailMatch(normalizedEmail, config);
  const rateLimitResult = await enforceMagicLinkRateLimit(normalizedEmail, request);

  if (!rateLimitResult.ok) {
    return rateLimitResult;
  }

  if (!normalizedEmail || (normalizedEmail !== expectedEmail && !matchedViewerEmail)) {
    return {
      ok: true,
      message: magicLinkGenericMessage,
    };
  }

  const expiresAt = new Date(Date.now() + config.admin.magicLinkTtlMs).toISOString();
  const role = normalizedEmail === expectedEmail ? 'admin' : 'viewer';
  const tokenId = randomUUID();
  const token = signPayload(
    {
      type: 'admin-magic-link',
      jti: tokenId,
      email: role === 'admin' ? expectedEmail : normalizeEmail(matchedViewerEmail),
      role,
      exp: Date.now() + config.admin.magicLinkTtlMs,
    },
    config.admin.magicLinkSecret,
  );
  const publicOrigin = getRequestOrigin(request, config.server.origin);
  const magicLinkUrl = `${publicOrigin}/admin?admin_token=${encodeURIComponent(token)}`;
  const storage = getStorage();
  await storage.insertAdminMagicLink({
    token_hash: sha256(tokenId),
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    email: role === 'admin' ? expectedEmail : normalizeEmail(matchedViewerEmail),
    role,
    requested_ip_hash: hashIp(getClientIp(request)),
    metadata: {},
  });
  const deliveryResult = await sendAdminMagicLinkEmail({
    to: role === 'admin' ? config.admin.email : matchedViewerEmail,
    magicLinkUrl,
    expiresAt,
    role,
  });

  if (deliveryResult.status === 'failed') {
    await storage.consumeAdminMagicLink(sha256(tokenId), new Date().toISOString()).catch(() => {});
    return { ok: false, reason: deliveryResult.error };
  }

  return {
    ok: true,
    message: magicLinkGenericMessage,
    previewUrl: config.isProduction ? '' : magicLinkUrl,
  };
}

export async function verifyAdminMagicLink(token) {
  const config = getConfig();
  const payload = verifySignedPayload(token, config.admin.magicLinkSecret);
  const role = payload?.role === 'viewer' ? 'viewer' : 'admin';
  const expectedEmail = role === 'admin' ? normalizeEmail(config.admin.email) : normalizeEmail(getViewerEmailMatch(payload?.email, config));

  if (!payload?.jti || payload.type !== 'admin-magic-link' || normalizeEmail(payload.email) !== expectedEmail) {
    return { ok: false, reason: 'That sign-in link is invalid or has expired.' };
  }

  const storage = getStorage();
  const consumed = await storage.consumeAdminMagicLink(sha256(payload.jti), new Date().toISOString());
  if (!consumed || consumed.email !== normalizeEmail(payload.email) || consumed.role !== role) {
    return { ok: false, reason: 'That sign-in link is invalid, expired, or has already been used.' };
  }

  return {
    ok: true,
    ...(await issueAdminSession(payload.email, role, 'magic-link', {}, storage)),
  };
}

export async function logoutAdmin(request) {
  const config = getConfig();
  const session = await getAdminSession(request);
  if (session) await getStorage().revokeAdminSession(session.id, new Date().toISOString());
  return clearCookie(config.admin.sessionCookieName, {
    path: '/',
    sameSite: 'Lax',
    secure: config.isProduction,
  });
}

export async function revokeAllAdminSessions(request) {
  const session = await requireAdminAccess(request);
  if (!session) return { ok: false, status: 401, reason: 'Unauthorized.' };
  const revoked = await getStorage().revokeAdminSessionsForPrincipal(session.principal_id, new Date().toISOString());
  return {
    ok: true,
    revoked,
    cookie: clearCookie(getConfig().admin.sessionCookieName, {
      path: '/', sameSite: 'Lax', secure: getConfig().isProduction,
    }),
  };
}

export async function cleanupExpiredAuthRecords(storage = getStorage(), now = new Date()) {
  return storage.cleanupExpiredAuthRecords?.(now.toISOString()) || { magicLinks: 0, sessions: 0 };
}

export function startAuthCleanupScheduler({ storage = getStorage(), scheduleTimer = setInterval } = {}) {
  const interval = scheduleTimer(() => {
    cleanupExpiredAuthRecords(storage).catch((error) => console.warn(`[admin-auth] cleanup failed: ${error.message}`));
  }, 6 * 60 * 60 * 1000);
  interval.unref?.();
  return { stop() { clearInterval(interval); } };
}
