/**
 * Phiên đăng nhập tối giản: một mật khẩu quản trị, cookie ký HMAC.
 * Không dùng thư viện session vì nhu cầu chỉ có một người dùng quản trị.
 */
import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE_NAME = 'beca_sid';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(data) {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
}

/** So sánh chuỗi theo thời gian hằng để không rò rỉ thông tin qua thời gian phản hồi. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Vẫn chạy so sánh để thời gian không phụ thuộc độ dài.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function checkPassword(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  return safeEqual(candidate, config.adminPassword);
}

export function createSession(username = 'admin') {
  const payload = { sub: username, exp: Date.now() + config.sessionTtl * 1000 };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

/** @returns {{sub:string, exp:number}|null} */
export function verifySession(token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(body);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.sub || !Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function readSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return verifySession(cookies[COOKIE_NAME]);
}

export function setSessionCookie(res, token) {
  const maxAge = config.sessionTtl;
  res.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Middleware chặn các API cần đăng nhập. */
export function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    res.status(401).json({ error: 'Chưa đăng nhập hoặc phiên đã hết hạn.' });
    return;
  }
  req.session = session;
  next();
}

/** Chặn thử mật khẩu liên tục: 5 lần sai trong 5 phút thì tạm khoá 5 phút. */
const attempts = new Map();

export function registerLoginAttempt(ip) {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const entry = attempts.get(ip) ?? { count: 0, firstAt: now, blockedUntil: 0 };
  if (entry.blockedUntil > now) return { allowed: false, retryAfterMs: entry.blockedUntil - now };
  if (now - entry.firstAt > windowMs) {
    entry.count = 0;
    entry.firstAt = now;
  }
  entry.count += 1;
  if (entry.count > 5) {
    entry.blockedUntil = now + windowMs;
    attempts.set(ip, entry);
    return { allowed: false, retryAfterMs: windowMs };
  }
  attempts.set(ip, entry);
  return { allowed: true, remaining: 5 - entry.count };
}

export function resetLoginAttempts(ip) {
  attempts.delete(ip);
}
