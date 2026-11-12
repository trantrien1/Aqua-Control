/**
 * Lớp truy cập SQLite, dùng module node:sqlite có sẵn trong Node 22.5+
 * nên không cần biên dịch thư viện native (tránh lỗi build trên Windows).
 *
 * Bảng:
 *   users       – tài khoản khách hàng + quản trị, chat id Telegram đã ghép nối
 *   devices     – mỗi ESP32 thuộc về một tài khoản, giữ hash của device key
 *   readings    – lịch sử tham số đo, phục vụ biểu đồ
 *   pump_events – nhật ký bật/tắt bơm, ghi cả nguồn lệnh
 *   alerts      – nhật ký cảnh báo đã phát (đã áp dụng chống spam)
 */
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config, PARAM_KEYS } from './config.js';

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    username          TEXT    NOT NULL UNIQUE,
    password_hash     TEXT    NOT NULL,
    role              TEXT    NOT NULL DEFAULT 'customer',
    disabled          INTEGER NOT NULL DEFAULT 0,
    telegram_chat_id  TEXT,
    telegram_linked_at INTEGER,
    link_code         TEXT,
    link_code_expires INTEGER,
    created_at        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    device_id  TEXT PRIMARY KEY,
    online     INTEGER NOT NULL DEFAULT 0,
    last_seen  INTEGER,
    ip         TEXT,
    firmware   TEXT,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS readings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT    NOT NULL,
    ts           INTEGER NOT NULL,
    received_at  INTEGER NOT NULL,
    temperature  REAL,
    ph           REAL,
    tds          REAL,
    turbidity    REAL,
    water_level  REAL
  );
  CREATE INDEX IF NOT EXISTS idx_readings_device_ts ON readings (device_id, ts);

  CREATE TABLE IF NOT EXISTS pump_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT    NOT NULL,
    pump        TEXT    NOT NULL,
    action      TEXT    NOT NULL,
    ts          INTEGER NOT NULL,
    source      TEXT    NOT NULL,
    duration_s  INTEGER,
    actor       TEXT,
    note        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pump_events_ts ON pump_events (ts);

  CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT    NOT NULL,
    param       TEXT    NOT NULL,
    level       TEXT    NOT NULL,
    value       REAL,
    message     TEXT    NOT NULL,
    ts          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts (ts);
`);

// Thêm cột tại chỗ để dữ liệu cũ của người dùng vẫn còn nguyên.
function addColumn(table, column, ddl) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  if (!cols.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn('readings', 'turbidity_voltage', 'turbidity_voltage REAL');
addColumn('readings', 'turbidity_percent', 'turbidity_percent REAL');
addColumn('readings', 'sensor_status', 'sensor_status TEXT');
addColumn('devices', 'owner_id', 'owner_id INTEGER');
addColumn('devices', 'key_hash', 'key_hash TEXT');
addColumn('devices', 'name', 'name TEXT');
addColumn('devices', 'created_at', 'created_at INTEGER');
addColumn('users', 'notify_muted_until', 'notify_muted_until INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices (owner_id)');
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
db.exec('CREATE TABLE IF NOT EXISTS water_settings (device_id TEXT PRIMARY KEY, settings TEXT NOT NULL)');
export function getWaterSettings(deviceId) {
  const row = db.prepare('SELECT settings FROM water_settings WHERE device_id = ?').get(deviceId);
  return row ? JSON.parse(row.settings) : null;
}
export function saveWaterSettings(deviceId, settings) {
  db.prepare('INSERT INTO water_settings (device_id, settings) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET settings = excluded.settings').run(deviceId, JSON.stringify(settings));
}

/** Ghép danh sách device thành mệnh đề IN an toàn tham số. */
function inClause(deviceIds) {
  const ids = [...new Set(deviceIds)].filter(Boolean);
  if (!ids.length) return { sql: 'NULL', params: [] };
  return { sql: ids.map(() => '?').join(', '), params: ids };
}

const stmt = {
  insertReading: db.prepare(`
    INSERT INTO readings (device_id, ts, received_at, temperature, ph, tds, turbidity, turbidity_voltage, turbidity_percent, water_level, sensor_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  latestReading: db.prepare(`
    SELECT * FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT 1
  `),
  retainedRange: db.prepare(`
    SELECT MIN(ts) AS from_ts, MAX(ts) AS to_ts, COUNT(*) AS n FROM readings WHERE device_id = ?
  `),
  insertPumpEvent: db.prepare(`
    INSERT INTO pump_events (device_id, pump, action, ts, source, duration_s, actor, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  lastPumpEvent: db.prepare(`
    SELECT * FROM pump_events WHERE pump = ? AND device_id = ? ORDER BY ts DESC LIMIT 1
  `),
  insertAlert: db.prepare(`
    INSERT INTO alerts (device_id, param, level, value, message, ts) VALUES (?, ?, ?, ?, ?, ?)
  `),
  upsertDevice: db.prepare(`
    INSERT INTO devices (device_id, online, last_seen, ip, firmware, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      online      = excluded.online,
      last_seen   = COALESCE(excluded.last_seen, devices.last_seen),
      ip          = COALESCE(excluded.ip, devices.ip),
      firmware    = COALESCE(excluded.firmware, devices.firmware),
      updated_at  = excluded.updated_at
  `),
  getDevice: db.prepare(`SELECT * FROM devices WHERE device_id = ?`),
  purgeReadings: db.prepare(`DELETE FROM readings WHERE ts < ?`),
  purgeAlerts: db.prepare(`DELETE FROM alerts WHERE ts < ?`),
};

/* ------------------------------------------------------------------- users --- */

const ROW_TO_USER = (row) =>
  row
    ? {
        id: row.id,
        username: row.username,
        passwordHash: row.password_hash,
        role: row.role,
        disabled: !!row.disabled,
        telegramChatId: row.telegram_chat_id || null,
        telegramLinkedAt: row.telegram_linked_at || null,
        linkCode: row.link_code || null,
        linkCodeExpires: row.link_code_expires || null,
        // 0 = đang nhận thông báo; > now = tạm tắt tới mốc đó.
        notifyMutedUntil: Number(row.notify_muted_until) || 0,
        createdAt: row.created_at,
      }
    : null;

export function createUser({ username, passwordHash, role = 'customer' }) {
  const result = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(String(username).trim(), passwordHash, role, Date.now());
  return getUserById(Number(result.lastInsertRowid));
}

export function getUserById(id) {
  return ROW_TO_USER(db.prepare(`SELECT * FROM users WHERE id = ?`).get(Number(id)));
}

export function getUserByUsername(username) {
  return ROW_TO_USER(
    db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`).get(String(username).trim()),
  );
}

export function listUsers() {
  return db
    .prepare(`SELECT * FROM users ORDER BY role DESC, username COLLATE NOCASE`)
    .all()
    .map(ROW_TO_USER);
}

export function setUserDisabled(id, disabled) {
  db.prepare(`UPDATE users SET disabled = ? WHERE id = ?`).run(disabled ? 1 : 0, Number(id));
}

export function setUserPassword(id, passwordHash) {
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, Number(id));
}

export function deleteUser(id) {
  const owned = db.prepare(`SELECT COUNT(*) AS n FROM devices WHERE owner_id = ?`).get(Number(id));
  if (owned?.n) throw new Error('Tài khoản còn thiết bị, chuyển hoặc xoá thiết bị trước.');
  db.prepare(`DELETE FROM users WHERE id = ? AND role != 'admin'`).run(Number(id));
}

/** Mã ghép nối Telegram dùng một lần, có hạn. */
export function setLinkCode(userId, code, expiresAt) {
  db.prepare(`UPDATE users SET link_code = ?, link_code_expires = ? WHERE id = ?`).run(
    code,
    expiresAt,
    Number(userId),
  );
}

export function findUserByLinkCode(code) {
  return ROW_TO_USER(
    db.prepare(`SELECT * FROM users WHERE link_code = ? AND link_code_expires > ?`).get(
      String(code),
      Date.now(),
    ),
  );
}

export function bindTelegramChat(userId, chatId) {
  db.prepare(
    `UPDATE users SET telegram_chat_id = ?, telegram_linked_at = ?, link_code = NULL, link_code_expires = NULL WHERE id = ?`,
  ).run(String(chatId), Date.now(), Number(userId));
}

export function unbindTelegram(userId) {
  db.prepare(
    `UPDATE users SET telegram_chat_id = NULL, telegram_linked_at = NULL, notify_muted_until = 0 WHERE id = ?`,
  ).run(Number(userId));
}

/** Tạm tắt thông báo tới mốc `untilMs`; truyền 0 để bật lại ngay. */
export function setNotifyMute(userId, untilMs) {
  db.prepare(`UPDATE users SET notify_muted_until = ? WHERE id = ?`).run(
    Math.max(0, Number(untilMs) || 0),
    Number(userId),
  );
}

export function getUserByChatId(chatId) {
  return ROW_TO_USER(
    db.prepare(`SELECT * FROM users WHERE telegram_chat_id = ?`).get(String(chatId)),
  );
}

/* ----------------------------------------------------------------- devices --- */

const ROW_TO_DEVICE = (row) =>
  row
    ? {
        deviceId: row.device_id,
        ownerId: row.owner_id ?? null,
        name: row.name || row.device_id,
        online: !!row.online,
        lastSeen: row.last_seen,
        ip: row.ip,
        firmware: row.firmware,
        createdAt: row.created_at ?? null,
      }
    : null;

/** Mã thiết bị dạng esp32-xxxx và khoá bí mật dùng một lần để nạp firmware. */
export function createDevice({ ownerId, name }) {
  const deviceId = `esp32-${crypto.randomBytes(3).toString('hex')}`;
  const deviceKey = crypto.randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO devices (device_id, owner_id, key_hash, name, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(deviceId, Number(ownerId), sha256(deviceKey), name || deviceId, Date.now());
  return { device: getDevice(deviceId), deviceId, deviceKey };
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Xác thực ESP32 khi nó mở kết nối MQTT: username = deviceId, password = deviceKey. */
export function verifyDeviceCredentials(deviceId, deviceKey) {
  const row = stmt.getDevice.get(String(deviceId || ''));
  if (!row?.key_hash) return null;
  const provided = Buffer.from(sha256(deviceKey || ''));
  const expected = Buffer.from(row.key_hash);
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;
  return ROW_TO_DEVICE(row);
}

export function rotateDeviceKey(deviceId) {
  const deviceKey = crypto.randomBytes(24).toString('base64url');
  db.prepare(`UPDATE devices SET key_hash = ? WHERE device_id = ?`).run(
    sha256(deviceKey),
    String(deviceId),
  );
  return { device: getDevice(deviceId), deviceKey };
}

export function getDevice(deviceId) {
  return ROW_TO_DEVICE(stmt.getDevice.get(String(deviceId || '')));
}

export function listDevices(ownerId = null) {
  const rows =
    ownerId == null
      ? db.prepare(`SELECT * FROM devices ORDER BY created_at DESC, device_id`).all()
      : db.prepare(`SELECT * FROM devices WHERE owner_id = ? ORDER BY device_id`).all(Number(ownerId));
  return rows.map(ROW_TO_DEVICE);
}

/** Device mà một tài khoản được phép xem. Admin thấy tất cả. */
export function devicesForUser(user) {
  if (!user) return [];
  if (user.role === 'admin') return listDevices();
  return listDevices(user.id);
}

export function deviceIdsForUser(user) {
  return devicesForUser(user).map((d) => d.deviceId);
}

export function assignDeviceOwner(deviceId, ownerId) {
  db.prepare(`UPDATE devices SET owner_id = ? WHERE device_id = ?`).run(
    ownerId == null ? null : Number(ownerId),
    String(deviceId),
  );
}

export function renameDevice(deviceId, name) {
  db.prepare(`UPDATE devices SET name = ? WHERE device_id = ?`).run(
    name || String(deviceId),
    String(deviceId),
  );
}

export function deleteDeviceRow(deviceId) {
  const id = String(deviceId);
  db.prepare(`DELETE FROM readings WHERE device_id = ?`).run(id);
  db.prepare(`DELETE FROM pump_events WHERE device_id = ?`).run(id);
  db.prepare(`DELETE FROM alerts WHERE device_id = ?`).run(id);
  db.prepare(`DELETE FROM water_settings WHERE device_id = ?`).run(id);
  db.prepare(`DELETE FROM devices WHERE device_id = ?`).run(id);
}

/* ---------------------------------------------------------------- readings --- */

/** Chỉ nhận giá trị số hữu hạn, mọi thứ khác (null, NaN, chuỗi rỗng) quy về null. */
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function insertReading(deviceId, reading) {
  const ts = Number.isFinite(Number(reading.ts)) ? Number(reading.ts) : Date.now();
  const values = PARAM_KEYS.map((key) => numOrNull(reading[key]));
  stmt.insertReading.run(deviceId, ts, Date.now(), ...values, JSON.stringify(reading.sensor_status ?? {}));
  return ts;
}

const ROW_TO_READING = (row) =>
  row
    ? {
        deviceId: row.device_id,
        ts: row.ts,
        receivedAt: row.received_at,
        temperature: row.temperature,
        ph: row.ph,
        tds: row.tds,
        turbidity: row.turbidity,
        turbidity_voltage: row.turbidity_voltage,
        turbidity_percent: row.turbidity_percent,
        sensor_status: JSON.parse(row.sensor_status || '{}'),
        water_level: row.water_level,
      }
    : null;

export function latestReading(deviceId) {
  return ROW_TO_READING(stmt.latestReading.get(String(deviceId)));
}

export function retainedRange(deviceId) {
  return stmt.retainedRange.get(String(deviceId)) ?? { from_ts: null, to_ts: null, n: 0 };
}

/**
 * Chuỗi thời gian của một tham số, gộp theo "bucket" để biểu đồ 7 ngày không
 * phải kéo hàng chục nghìn điểm về trình duyệt. Trả trung bình, min, max.
 */
export function history(deviceId, param, fromTs, toTs, bucketMs) {
  if (!PARAM_KEYS.includes(param)) throw new Error(`Tham số không hợp lệ: ${param}`);
  const bucket = Math.max(1000, Math.floor(bucketMs));
  const sql = `
    SELECT (ts / ?) * ? AS bucket_start,
           AVG(${param}) AS avg_v,
           MIN(${param}) AS min_v,
           MAX(${param}) AS max_v,
           COUNT(${param}) AS n
    FROM readings
    WHERE device_id = ? AND ts >= ? AND ts <= ? AND ${param} IS NOT NULL
    GROUP BY bucket_start
    ORDER BY bucket_start ASC
  `;
  const rows = db.prepare(sql).all(bucket, bucket, String(deviceId), fromTs, toTs);
  return rows.map((r) => ({
    ts: r.bucket_start,
    avg: r.avg_v,
    min: r.min_v,
    max: r.max_v,
    n: r.n,
  }));
}

/* ------------------------------------------------------------------- events --- */

export function logPumpEvent(event) {
  const result = stmt.insertPumpEvent.run(
    String(event.deviceId),
    event.pump,
    event.action,
    event.ts ?? Date.now(),
    event.source ?? 'user',
    event.durationS ?? null,
    event.actor ?? null,
    event.note ?? null,
  );
  return Number(result.lastInsertRowid);
}

const ROW_TO_PUMP_EVENT = (row) => ({
  id: row.id,
  deviceId: row.device_id,
  pump: row.pump,
  action: row.action,
  ts: row.ts,
  source: row.source,
  durationS: row.duration_s,
  actor: row.actor,
  note: row.note,
});

/** @param {string[]|null} deviceIds null = không lọc (chỉ dùng cho admin). */
export function recentPumpEvents(limit = 50, deviceIds = null) {
  const cap = Math.min(Number(limit) || 50, 500);
  if (deviceIds === null) {
    return db.prepare(`SELECT * FROM pump_events ORDER BY ts DESC LIMIT ?`).all(cap).map(ROW_TO_PUMP_EVENT);
  }
  const scope = inClause(deviceIds);
  if (!scope.params.length) return [];
  return db
    .prepare(`SELECT * FROM pump_events WHERE device_id IN (${scope.sql}) ORDER BY ts DESC LIMIT ?`)
    .all(...scope.params, cap)
    .map(ROW_TO_PUMP_EVENT);
}

export function lastPumpEvent(deviceId, pump) {
  const row = stmt.lastPumpEvent.get(pump, String(deviceId));
  return row ? ROW_TO_PUMP_EVENT(row) : null;
}

export function logAlert(alert) {
  stmt.insertAlert.run(
    String(alert.deviceId),
    alert.param,
    alert.level,
    numOrNull(alert.value),
    alert.message,
    alert.ts ?? Date.now(),
  );
}

const ROW_TO_ALERT = (row) => ({
  id: row.id,
  deviceId: row.device_id,
  param: row.param,
  level: row.level,
  value: row.value,
  message: row.message,
  ts: row.ts,
});

export function recentAlerts(limit = 50, deviceIds = null) {
  const cap = Math.min(Number(limit) || 50, 500);
  if (deviceIds === null) {
    return db.prepare(`SELECT * FROM alerts ORDER BY ts DESC LIMIT ?`).all(cap).map(ROW_TO_ALERT);
  }
  const scope = inClause(deviceIds);
  if (!scope.params.length) return [];
  return db
    .prepare(`SELECT * FROM alerts WHERE device_id IN (${scope.sql}) ORDER BY ts DESC LIMIT ?`)
    .all(...scope.params, cap)
    .map(ROW_TO_ALERT);
}

/* ------------------------------------------------------------------ devices --- */

export function upsertDevice(deviceId, patch) {
  const existing = stmt.getDevice.get(String(deviceId));
  stmt.upsertDevice.run(
    String(deviceId),
    patch.online == null ? (existing?.online ?? 0) : patch.online ? 1 : 0,
    patch.lastSeen ?? null,
    patch.ip ?? null,
    patch.firmware ?? null,
    Date.now(),
  );
  return getDevice(deviceId);
}

/** Dọn dữ liệu cũ hơn số ngày lưu trữ. Gọi định kỳ từ server. */
export function pruneOldData() {
  const cutoff = Date.now() - config.retentionDays * 24 * 3600 * 1000;
  const readings = stmt.purgeReadings.run(cutoff).changes;
  const alerts = stmt.purgeAlerts.run(cutoff).changes;
  return { readings, alerts };
}

export function closeDb() {
  try {
    db.close();
  } catch {
    /* đã đóng rồi */
  }
}
