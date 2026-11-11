/**
 * Lớp truy cập SQLite, dùng module node:sqlite có sẵn trong Node 22.5+
 * nên không cần biên dịch thư viện native (tránh lỗi build trên Windows).
 *
 * Ba bảng chính:
 *   readings    – lịch sử 6 tham số đo, phục vụ biểu đồ
 *   pump_events – nhật ký bật/tắt bơm, ghi cả nguồn lệnh
 *   alerts      – nhật ký cảnh báo đã phát (đã áp dụng chống spam)
 */
import { DatabaseSync } from 'node:sqlite';
import { config, PARAM_KEYS } from './config.js';

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS readings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT    NOT NULL,
    ts           INTEGER NOT NULL,
    received_at  INTEGER NOT NULL,
    temperature  REAL,
    ph           REAL,
    tds          REAL,
    turbidity    REAL,
    water_level  REAL,
    food_level   REAL
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

  CREATE TABLE IF NOT EXISTS devices (
    device_id  TEXT PRIMARY KEY,
    online     INTEGER NOT NULL DEFAULT 0,
    last_seen  INTEGER,
    ip         TEXT,
    firmware   TEXT,
    updated_at INTEGER
  );
`);

// Add columns in place so existing NTU history and other user data stay intact.
const readingColumns = new Set(db.prepare('PRAGMA table_info(readings)').all().map((c) => c.name));
if (!readingColumns.has('turbidity_voltage')) db.exec('ALTER TABLE readings ADD COLUMN turbidity_voltage REAL');
if (!readingColumns.has('sensor_status')) db.exec('ALTER TABLE readings ADD COLUMN sensor_status TEXT');

const stmt = {
  insertReading: db.prepare(`
    INSERT INTO readings (device_id, ts, received_at, temperature, ph, tds, turbidity, turbidity_voltage, water_level, food_level, sensor_status)
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
  recentPumpEvents: db.prepare(`
    SELECT * FROM pump_events ORDER BY ts DESC LIMIT ?
  `),
  lastPumpEvent: db.prepare(`
    SELECT * FROM pump_events WHERE pump = ? ORDER BY ts DESC LIMIT 1
  `),
  insertAlert: db.prepare(`
    INSERT INTO alerts (device_id, param, level, value, message, ts) VALUES (?, ?, ?, ?, ?, ?)
  `),
  recentAlerts: db.prepare(`
    SELECT * FROM alerts ORDER BY ts DESC LIMIT ?
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
  listDevices: db.prepare(`SELECT * FROM devices ORDER BY device_id`),
  pruneReadings: db.prepare(`DELETE FROM readings WHERE ts < ?`),
  pruneAlerts: db.prepare(`DELETE FROM alerts WHERE ts < ?`),
};

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
        sensor_status: JSON.parse(row.sensor_status || '{}'),
        water_level: row.water_level,
        food_level: row.food_level,
      }
    : null;

export function latestReading(deviceId = config.defaultDeviceId) {
  return ROW_TO_READING(stmt.latestReading.get(deviceId));
}

export function retainedRange(deviceId = config.defaultDeviceId) {
  return stmt.retainedRange.get(deviceId) ?? { from_ts: null, to_ts: null, n: 0 };
}

/**
 * Lấy chuỗi thời gian của một tham số, gộp theo từng "bucket" để biểu đồ
 * 7 ngày không phải kéo hàng chục nghìn điểm về trình duyệt.
 * Trả về trung bình, min, max trong mỗi bucket.
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
  const rows = db.prepare(sql).all(bucket, bucket, deviceId, fromTs, toTs);
  return rows.map((r) => ({
    ts: r.bucket_start,
    avg: r.avg_v,
    min: r.min_v,
    max: r.max_v,
    n: r.n,
  }));
}

export function logPumpEvent(event) {
  const result = stmt.insertPumpEvent.run(
    event.deviceId ?? config.defaultDeviceId,
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

export function recentPumpEvents(limit = 50) {
  return stmt.recentPumpEvents.all(Math.min(limit, 500)).map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    pump: row.pump,
    action: row.action,
    ts: row.ts,
    source: row.source,
    durationS: row.duration_s,
    actor: row.actor,
    note: row.note,
  }));
}

export function lastPumpEvent(pump) {
  const row = stmt.lastPumpEvent.get(pump);
  if (!row) return null;
  return {
    id: row.id,
    pump: row.pump,
    action: row.action,
    ts: row.ts,
    source: row.source,
    durationS: row.duration_s,
    actor: row.actor,
    note: row.note,
  };
}

export function logAlert(alert) {
  stmt.insertAlert.run(
    alert.deviceId ?? config.defaultDeviceId,
    alert.param,
    alert.level,
    numOrNull(alert.value),
    alert.message,
    alert.ts ?? Date.now(),
  );
}

export function recentAlerts(limit = 50) {
  return stmt.recentAlerts.all(Math.min(limit, 500)).map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    param: row.param,
    level: row.level,
    value: row.value,
    message: row.message,
    ts: row.ts,
  }));
}

export function upsertDevice(deviceId, patch) {
  const existing = stmt.getDevice.get(deviceId);
  stmt.upsertDevice.run(
    deviceId,
    patch.online == null ? (existing?.online ?? 0) : patch.online ? 1 : 0,
    patch.lastSeen ?? null,
    patch.ip ?? null,
    patch.firmware ?? null,
    Date.now(),
  );
  return getDevice(deviceId);
}

export function getDevice(deviceId = config.defaultDeviceId) {
  const row = stmt.getDevice.get(deviceId);
  if (!row) return null;
  return {
    deviceId: row.device_id,
    online: !!row.online,
    lastSeen: row.last_seen,
    ip: row.ip,
    firmware: row.firmware,
    updatedAt: row.updated_at,
  };
}

export function listDevices() {
  return stmt.listDevices.all().map((row) => ({
    deviceId: row.device_id,
    online: !!row.online,
    lastSeen: row.last_seen,
    ip: row.ip,
    firmware: row.firmware,
  }));
}

/** Dọn dữ liệu cũ hơn số ngày lưu trữ. Gọi định kỳ từ server. */
export function pruneOldData() {
  const cutoff = Date.now() - config.retentionDays * 24 * 3600 * 1000;
  const readings = stmt.pruneReadings.run(cutoff).changes;
  const alerts = stmt.pruneAlerts.run(cutoff).changes;
  return { readings, alerts };
}

export function closeDb() {
  try {
    db.close();
  } catch {
    /* đã đóng rồi */
  }
}
