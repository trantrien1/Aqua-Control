#!/usr/bin/env node
/**
 * Bộ giả lập thiết bị ESP32 — cho phép demo toàn bộ hệ thống khi chưa có phần cứng.
 *
 * Nó đóng vai trò y như firmware thật:
 *   - giữ kết nối MQTT kèm Last Will "offline"
 *   - gửi telemetry định kỳ với số liệu trôi nhẹ như cảm biến thật
 *   - nhận lệnh bơm, bật/tắt relay, trả lời ack và tự ngắt theo thời gian cho phép
 *
 * Cách dùng:
 *   npm run sim
 *   node tools/simulate-device.js --scenario critical
 *   node tools/simulate-device.js --url mqtt://192.168.1.10:1883 --interval 3
 */
import mqttFactory from 'mqtt';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg('url', process.env.MQTT_URL || 'mqtt://127.0.0.1:1883');
const DEVICE_ID = arg('device', process.env.DEVICE_ID || '');
/** Khoá thiết bị do trang web cấp khi tạo bể (deviceId + deviceKey). */
const DEVICE_KEY = arg('key', process.env.DEVICE_KEY || '');
const INTERVAL = Math.max(1, Number(arg('interval', process.env.SIM_INTERVAL || 5))) * 1000;
const SCENARIO = arg('scenario', 'relay-test');
const PREFIX = process.env.MQTT_TOPIC_PREFIX || 'aquarium';
const ONCE = argv.includes('--once');
const WATER_TEST = SCENARIO === 'water-test';
const FOUR_SENSOR = WATER_TEST || SCENARIO === 'relay-test';
const CAPABILITIES = {
  pumps: !WATER_TEST,
  relay_keys: WATER_TEST ? [] : ['ph_up', 'ph_down', 'light'],
  water_level: !FOUR_SENSOR,
  turbidity_voltage: FOUR_SENSOR,
};

const topic = (suffix) => `${PREFIX}/${DEVICE_ID}/${suffix}`;

/** Trạng thái "phần cứng" của bộ giả lập. */
const hardware = {
  pumps: { ph_up: false, ph_down: false, light: false },
  timers: {},
  offAt: {},
};

/** Số liệu gốc theo kịch bản; sau đó trôi dần để biểu đồ trông giống thật. */
const SCENARIOS = {
  normal: { temperature: 25.6, ph: 7.35, tds: 225, turbidity: 14, water_level: 78 },
  critical: { temperature: 31.8, ph: 9.25, tds: 470, turbidity: 165, water_level: 96 },
  low: { temperature: 21.4, ph: 6.15, tds: 95, turbidity: 20, water_level: 28 },
  drift: { temperature: 27.1, ph: 8.05, tds: 340, turbidity: 62, water_level: 91 },
};

const readings = { ...(SCENARIOS[SCENARIO] || SCENARIOS.normal) };

const LIMITS = {
  temperature: [18, 34],
  ph: [5.5, 9.5],
  tds: [50, 500],
  turbidity: [0, 200],
  water_level: [15, 99],
};

const STEPS = {
  temperature: 0.12,
  ph: 0.03,
  tds: 1.5,
  turbidity: 1.2,
  water_level: 0.4,
};

function drift(key) {
  const [lo, hi] = LIMITS[key];
  const step = STEPS[key];
  let value = readings[key] + (Math.random() - 0.5) * 2 * step;
  // Kéo nhẹ về giá trị gốc để không trôi mất kịch bản.
  const anchor = (SCENARIOS[SCENARIO] || SCENARIOS.normal)[key];
  value += (anchor - value) * 0.08;
  readings[key] = Math.min(hi, Math.max(lo, value));
  return Number(readings[key].toFixed(key === 'tds' || key === 'turbidity' ? 0 : 2));
}

/** Only the two pH pumps affect pH. The light never changes any pump or level. */
function applyPumpEffects() {
  if (hardware.pumps.ph_up) readings.ph = Math.min(9.5, readings.ph + 0.05);
  if (hardware.pumps.ph_down) readings.ph = Math.max(5.5, readings.ph - 0.05);
}

if (!DEVICE_ID || !DEVICE_KEY) {
  console.error('Thiếu DEVICE_ID hoặc DEVICE_KEY.');
  console.error('Cấp thiết bị trong mục Quản trị của web, hoặc chạy:');
  console.error('  node tools/create-demo-device.mjs');
  console.error('');
  console.error('Rồi chạy lại:');
  console.error('  npm run sim -- --device <DEVICE_ID> --key <DEVICE_KEY>');
  process.exit(1);
}

const client = mqttFactory.connect(URL, {
  clientId: `sim-${DEVICE_ID}`,
  clean: true,
  reconnectPeriod: 2000,
  username: DEVICE_ID,
  password: DEVICE_KEY,
  will: {
    topic: topic('status'),
    payload: Buffer.from('offline'),
    qos: 1,
    retain: true,
  },
});

const relayTimers = () => Object.fromEntries(Object.keys(hardware.pumps).map((key) => [key, {
  remaining_ms: hardware.pumps[key] ? Math.max(0, (hardware.offAt[key] || 0) - Date.now()) : 0,
  source: 'mqtt',
}]));

function publishState() {
  client.publish(
    topic('state'),
    JSON.stringify({
      firmware: 'simulator-2.2-relay3',
      pumps: hardware.pumps,
      capabilities: CAPABILITIES,
      relay_timers: relayTimers(),
      ts: Date.now(),
    }),
    { qos: 1, retain: true },
  );
}

function setPump(pump, on) {
  if (!(pump in hardware.pumps)) return false;
  // Hai bơm pH không được chạy đồng thời (giống chốt liên động trên firmware).
  if (on && ['ph_up', 'ph_down'].includes(pump)) {
    const other = pump === 'ph_up' ? 'ph_down' : 'ph_up';
    setPump(other, false);
  }
  hardware.pumps[pump] = on;
  if (!on && hardware.timers[pump]) {
    clearTimeout(hardware.timers[pump]);
    delete hardware.timers[pump];
  }
  if (!on) delete hardware.offAt[pump];
  return true;
}

function scheduleOff(pump, seconds) {
  if (!seconds || !Number.isFinite(seconds)) return;
  if (hardware.timers[pump]) clearTimeout(hardware.timers[pump]);
  hardware.offAt[pump] = Date.now() + seconds * 1000;
  hardware.timers[pump] = setTimeout(() => {
    delete hardware.timers[pump];
    setPump(pump, false);
    publishState();
    console.log(`[sim] Tự ngắt ${pump} sau ${seconds}s (giới hạn an toàn của thiết bị)`);
  }, seconds * 1000);
}

let telemetryLoop;
client.on('connect', () => {
  console.log(`[sim] Đã kết nối ${URL} với mã thiết bị ${DEVICE_ID}`);
  console.log(`[sim] Kịch bản: ${SCENARIO}, chu kỳ gửi: ${INTERVAL / 1000}s`);
  client.publish(topic('status'), 'online', { qos: 1, retain: true });
  client.subscribe(topic('cmd'), { qos: 1 });
  publishState();
  sendTelemetry();

  if (ONCE) {
    setTimeout(() => {
      client.end(true);
      process.exit(0);
    }, 600);
    return;
  }
  clearInterval(telemetryLoop);
  telemetryLoop = setInterval(sendTelemetry, INTERVAL);
  telemetryLoop.unref?.();
});

client.on('message', (t, payload) => {
  if (t !== topic('cmd')) return;
  let command;
  try {
    command = JSON.parse(payload.toString('utf8'));
  } catch {
    return;
  }
  const { pump, action } = command;
  const maximum = pump === 'light' ? 3600 : 120;
  const duration = Math.max(1, Math.min(maximum, Math.floor(Number(command.duration) || 3)));
  const ok = CAPABILITIES.pumps && ['on', 'off'].includes(action) && setPump(pump, action === 'on');
  if (ok && action === 'on') scheduleOff(pump, duration);
  publishState();
  client.publish(
    topic('ack'),
    JSON.stringify({
      id: command.id,
      pump,
      action,
      ok,
      error: ok ? undefined : `Kênh relay hoặc hành động không hợp lệ: ${pump}`,
      pumps: hardware.pumps,
      ts: Date.now(),
    }),
    { qos: 1 },
  );
  console.log(`[sim] Lệnh ${action.toUpperCase()} ${pump} -> ${ok ? 'đã áp dụng' : 'từ chối'}`);
});

function sendTelemetry() {
  if (!client.connected) return;
  applyPumpEffects();
  const payload = {
    ts: Date.now(),
    temperature: drift('temperature'),
    ph: drift('ph'),
    tds: drift('tds'),
    turbidity: drift('turbidity'),
    water_level: Number(readings.water_level.toFixed(1)),
    rssi: -55 - Math.floor(Math.random() * 15),
    firmware: 'simulator-2.2-relay3',
    pumps: hardware.pumps,
    capabilities: CAPABILITIES,
    relay_timers: relayTimers(),
  };
  if (FOUR_SENSOR) {
    Object.assign(payload, {
      ph: WATER_TEST ? null : drift('ph'),
      turbidity: null,
      turbidity_voltage: 4.08,
      water_level: null,
      sensor_status: {
        ph_calibrated: !WATER_TEST,
        tds_estimated: true,
        tds_temperature_fallback: false,
        ph_adc_voltage: 1.5,
        tds_adc_voltage: 0.6,
        turbidity_adc_voltage: 2.04,
      },
    });
  }
  client.publish(topic('telemetry'), JSON.stringify(payload), { qos: 1 });
  console.log(
    `[sim] ${new Date().toLocaleTimeString('vi-VN')}  ` +
      `${payload.temperature.toFixed(1)}°C  pH ${payload.ph?.toFixed(2) ?? 'chua hieu chuan'}  ` +
      `TDS ${payload.tds.toFixed(0)}  ${FOUR_SENSOR ? `TURB ${payload.turbidity_voltage} V` : `NTU ${payload.turbidity.toFixed(0)}`}  ` +
      `nước ${payload.water_level ?? '--'}%`,
  );
}

client.on('error', (err) => console.error('[sim] Lỗi MQTT:', err.message));

process.on('SIGINT', () => {
  console.log('\n[sim] Đang ngắt kết nối (thiết bị sẽ chuyển sang offline)...');
  client.publish(topic('status'), 'offline', { qos: 1, retain: true });
  setTimeout(() => client.end(true, () => process.exit(0)), 300);
});
