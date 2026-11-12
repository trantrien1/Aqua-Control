/**
 * Băm mật khẩu bằng scrypt có sẵn trong node:crypto.
 *
 * Không dùng bcrypt/argon2 để khỏi phải biên dịch module native trên Windows.
 * scrypt nằm trong lõi Node nên vẫn an toàn mà không thêm phụ thuộc.
 *
 * Vai trò: 'admin' thấy và làm được mọi thứ; 'customer' chỉ thấy thiết bị của mình.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import * as db from './db.js';

const KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  let actual;
  try {
    actual = crypto.scryptSync(
      String(password),
      Buffer.from(saltB64, 'base64url'),
      expected.length,
      SCRYPT_PARAMS,
    );
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Tài khoản quản trị mặc định, tạo một lần từ ADMIN_PASSWORD.
 * Mật khẩu admin đã đổi trong DB thì giữ nguyên, không bị ghi đè khi restart.
 */
export function ensureAdmin() {
  const existing = db.getUserByUsername('admin');
  if (existing) return existing;
  const user = db.createUser({
    username: 'admin',
    passwordHash: hashPassword(config.adminPassword),
    role: 'admin',
  });
  console.log('[auth] Đã tạo tài khoản quản trị "admin".');
  return user;
}
