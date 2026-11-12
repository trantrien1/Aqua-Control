/**
 * Cấu hình toàn hệ thống.
 * Đọc từ biến môi trường, tự nạp file .env ở thư mục gốc nếu có.
 * Không phụ thuộc thư viện ngoài (dotenv) để giữ project gọn.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');

/** Nạp file .env dạng KEY=VALUE, không ghi đè biến đã có sẵn trong môi trường. */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value, fallback) => {
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
};

/** Bí mật ký cookie phiên: ưu tiên .env, nếu không có thì sinh và lưu lại để phiên không mất khi restart. */
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  if (fs.existsSync(file)) {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

export const config = {
  /** Cổng HTTP của dashboard + API. */
  port: num(process.env.PORT, 3000),
  /** Cổng MQTT mà ESP32 sẽ kết nối tới. */
  mqttPort: num(process.env.MQTT_PORT, 1883),
  /** Chỉ lắng nghe trên card mạng này; 0.0.0.0 để ESP32 trong LAN truy cập được. */
  host: process.env.HOST || '0.0.0.0',
  /** Mật khẩu quản trị duy nhất. */
  adminPassword: process.env.ADMIN_PASSWORD || 'beca123',
  sessionSecret: resolveSessionSecret(),
  /** Thời hạn phiên đăng nhập (giây). */
  sessionTtl: num(process.env.SESSION_TTL_SECONDS, 7 * 24 * 3600),

  topicPrefix: process.env.MQTT_TOPIC_PREFIX || 'aquarium',
  /** Không nhận được dữ liệu trong khoảng này thì coi thiết bị là mất kết nối. */
  staleAfterMs: num(process.env.STALE_AFTER_SECONDS, 60) * 1000,
  commandAckTimeoutMs: num(process.env.COMMAND_ACK_TIMEOUT_MS, 8000),
  /** Giãn cách tối thiểu giữa hai cảnh báo cùng loại (chống spam). */
  alertCooldownMs: num(process.env.ALERT_COOLDOWN_SECONDS, 180) * 1000,
  /** Số dòng telemetry giữ lại trong DB; dòng cũ hơn sẽ bị dọn. */
  retentionDays: num(process.env.RETENTION_DAYS, 30),

  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'aquarium.db'),

  /** Bật broker MQTT nhúng trong tiến trình Node. */
  embeddedBroker: bool(process.env.EMBEDDED_BROKER, true),
  /** Nếu embeddedBroker=false thì kết nối tới broker ngoài (Mosquitto...). */
  externalBrokerUrl: process.env.MQTT_URL || `mqtt://127.0.0.1:${num(process.env.MQTT_PORT, 1883)}`,

  /** Thông báo Telegram. Bỏ trống TELEGRAM_BOT_TOKEN thì tắt hẳn tính năng. */
  telegram: {
    token: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    /** 'warn' báo cả vùng vàng (mặc định); 'critical' chỉ báo vùng đỏ. */
    notifyLevel: (process.env.TELEGRAM_NOTIFY_LEVEL || 'warn').trim(),
    /** Nhắc lại khi thông số vẫn còn xấu: vùng vàng mỗi 30 phút, vùng đỏ mỗi 10 phút. */
    repeatMs: {
      warn: num(process.env.TELEGRAM_REPEAT_WARN_MINUTES, 30) * 60000,
      critical: num(process.env.TELEGRAM_REPEAT_CRITICAL_MINUTES, 10) * 60000,
    },
    publicUrl:
      process.env.PUBLIC_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : `http://localhost:${num(process.env.PORT, 3000)}`),
    /** Đổi được để dùng Bot API tự dựng hoặc chạy kiểm thử cục bộ. */
    apiBase: (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
  },
};

/**
 * Định nghĩa 6 tham số đo và ngưỡng an toàn (lấy từ bản giới thiệu đề tài).
 * min/max là dải "tốt"; vượt warn thì cảnh báo vàng; vượt critical thì cảnh báo đỏ.
 */
export const PARAMS = {
  temperature: {
    key: 'temperature',
    label: 'Nhiệt độ nước',
    short: 'Nhiệt độ',
    unit: '°C',
    icon: 'thermometer',
    decimals: 1,
    min: 24, max: 28,
    warnLow: 22, warnHigh: 30,
    criticalLow: 20, criticalHigh: 32,
  },
  ph: {
    key: 'ph',
    label: 'Độ pH',
    short: 'pH',
    unit: '',
    icon: 'ph',
    decimals: 2,
    min: 6.8, max: 8.2,
    warnLow: 6.5, warnHigh: 8.5,
    criticalLow: 6.0, criticalHigh: 9.0,
  },
  tds: {
    key: 'tds',
    label: 'TDS (tổng chất rắn hòa tan)',
    short: 'TDS',
    unit: 'ppm',
    icon: 'tds',
    decimals: 0,
    min: 180, max: 280,
    warnLow: 120, warnHigh: 350,
    criticalLow: 60, criticalHigh: 450,
  },
  turbidity: {
    key: 'turbidity',
    label: 'Độ đục',
    short: 'Độ đục',
    unit: 'NTU',
    icon: 'turbidity',
    decimals: 0,
    min: 0, max: 50,
    warnLow: null, warnHigh: 80,
    criticalLow: null, criticalHigh: 150,
  },
  turbidity_voltage: {
    key: 'turbidity_voltage',
    label: 'Độ đục (điện áp OUT)',
    short: 'Độ đục (V)',
    unit: 'V',
    icon: 'turbidity',
    decimals: 3,
    monitor: false,
    min: null, max: null,
    note: 'Chưa hiệu chuẩn NTU · OUT ≈ 2 × điện áp ADC',
  },
  turbidity_percent: {
    key: 'turbidity_percent', label: 'Độ đục tương đối', short: 'Độ đục', unit: '%',
    icon: 'turbidity', decimals: 1, min: 0, max: 30, warnLow: null, warnHigh: 30,
    criticalLow: null, criticalHigh: 60, note: 'Mốc nước trong 3,272 V · độ đục tương đối',
  },
  water_level: {
    key: 'water_level',
    label: 'Mực nước trong bể',
    short: 'Mực nước',
    unit: '%',
    icon: 'water',
    decimals: 0,
    min: 40, max: 90,
    warnLow: 35, warnHigh: 92,
    criticalLow: 25, criticalHigh: 97,
  },
};

export const PARAM_KEYS = Object.keys(PARAMS);

/**
 * Hai bơm nước và một đèn do người dùng điều khiển tay qua relay.
 * group: hai bơm cùng group không được chạy đồng thời (rút nước và bơm vào).
 * maxRunSeconds: thời gian chạy tối đa trước khi tự ngắt — đây là chốt an toàn, không phải tự động hoá.
 */
export const PUMPS = {
  drain: {
    key: 'drain',
    label: 'Bơm nước ra',
    short: 'Rút nước',
    description: 'Rút nước khỏi bể, lưu lượng 96 lít/giờ. Bơm vào sẽ tắt trước.',
    kind: 'pump',
    relayChannel: 1,
    gpio: 18,
    defaultSeconds: 3,
    durations: [3, 30, 60, 120, 300, 600],
    maxRunSeconds: 3600,
    group: 'water',
  },
  fill: {
    key: 'fill',
    label: 'Bơm nước vào',
    short: 'Bơm vào',
    description: 'Bơm nước sạch vào bể, lưu lượng 96 lít/giờ. Bơm rút sẽ tắt trước.',
    kind: 'pump',
    relayChannel: 2,
    gpio: 19,
    defaultSeconds: 3,
    durations: [3, 30, 60, 120, 300, 600],
    maxRunSeconds: 3600,
    group: 'water',
  },
  light: {
    key: 'light',
    label: 'Đèn bể cá',
    short: 'Đèn',
    description: 'Bật đèn 6 V qua relay. Hoạt động độc lập với hai bơm nước.',
    kind: 'light',
    relayChannel: 3,
    gpio: 21,
    defaultSeconds: 3,
    durations: [3, 60, 300, 900, 1800, 3600],
    maxRunSeconds: 3600,
    group: 'light',
  },
};

export const PUMP_KEYS = Object.keys(PUMPS);

/** Nhóm bơm loại trừ nhau. */
export const PUMP_GROUPS = PUMP_KEYS.reduce((acc, key) => {
  const group = PUMPS[key].group;
  (acc[group] ||= []).push(key);
  return acc;
}, {});
