/**
 * Tầng giao tiếp thiết bị.
 *
 * Chạy một MQTT broker nhúng (aedes) ngay trong tiến trình Node, nên không cần
 * cài Mosquitto riêng: ESP32 chỉ cần trỏ vào IP máy tính, cổng 1883.
 * Server nói chuyện với broker đó qua một MQTT client nội bộ — nhờ vậy nếu sau
 * này muốn chuyển sang broker ngoài chỉ cần đặt EMBEDDED_BROKER=false + MQTT_URL.
 *
 * Sơ đồ topic (prefix mặc định "aquarium"):
 *   aquarium/<deviceId>/telemetry   ESP32 -> server   dữ liệu cảm biến (JSON)
 *   aquarium/<deviceId>/state       ESP32 -> server   trạng thái relay, retained
 *   aquarium/<deviceId>/status      LWT online/offline, retained
 *   aquarium/<deviceId>/ack         ESP32 -> server   phản hồi lệnh
 *   aquarium/<deviceId>/cmd         server -> ESP32   lệnh điều khiển bơm (JSON)
 */
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import aedesFactory from 'aedes';
import mqttFactory from 'mqtt';
import { config, PUMPS, PUMP_KEYS, PUMP_GROUPS } from './config.js';
import { bus, EVENTS } from './bus.js';
import * as db from './db.js';
import { evaluateReading, logNewAlerts } from './alerts.js';

const PREFIX = config.topicPrefix;

/** Trạng thái sống của thiết bị và bơm, dùng chung cho toàn server. */
export const runtime = {
  deviceId: config.defaultDeviceId,
  status: 'offline',
  lastSeen: null,
  lastReading: null,
  lastReadingAt: null,
  firmware: null,
  ip: null,
  rssi: null,
  capabilities: { pumps: false, water_level: false, food_level: false, turbidity_voltage: false, relay_keys: [] },
  pumps: Object.fromEntries(
    PUMP_KEYS.map((key) => [
      key,
      { on: false, known: false, since: null, commandedAt: null, pending: false,
        pendingAction: null, commandId: null, lastCommandId: null, error: null, offAt: null, source: null },
    ]),
  ),
};

/** Hẹn giờ tự ngắt bơm theo thời gian chạy tối đa. */
const pumpTimers = new Map();
const ackTimers = new Map();

let aedes = null;
let netServer = null;
let client = null;

const topic = (deviceId, suffix) => `${PREFIX}/${deviceId}/${suffix}`;

function setOnline(deviceId, online, patch = {}) {
  const changed = runtime.status !== (online ? 'online' : 'offline');
  runtime.status = online ? 'online' : 'offline';
  if (!online) {
    for (const key of PUMP_KEYS) {
      const state = runtime.pumps[key];
      state.known = false;
      state.pending = false;
      state.pendingAction = null;
      state.commandId = null;
      clearAckTimer(key);
      clearPumpTimer(key);
    }
  }
  if (patch.lastSeen) runtime.lastSeen = patch.lastSeen;
  if (patch.ip) runtime.ip = patch.ip;
  if (patch.firmware) runtime.firmware = patch.firmware;
  db.upsertDevice(deviceId, {
    online,
    lastSeen: runtime.lastSeen ?? undefined,
    ip: runtime.ip ?? undefined,
    firmware: runtime.firmware ?? undefined,
  });
  if (changed) bus.emit(EVENTS.device, getDeviceSnapshot());
}

export function getDeviceSnapshot() {
  const now = Date.now();
  const ageMs = runtime.lastSeen ? now - runtime.lastSeen : null;
  return {
    id: runtime.deviceId,
    status: runtime.status,
    online: runtime.status === 'online',
    lastSeen: runtime.lastSeen,
    ageMs,
    ip: runtime.ip,
    firmware: runtime.firmware,
    rssi: runtime.rssi,
    capabilities: { ...runtime.capabilities },
    staleAfterMs: config.staleAfterMs,
  };
}

/** Chuyển payload thô thành bản ghi chuẩn; chấp nhận cả khoá viết tắt từ firmware cũ. */
const ALIASES = {
  temp: 'temperature',
  temperature: 'temperature',
  ph: 'ph',
  pH: 'ph',
  tds: 'tds',
  turbidity: 'turbidity',
  turbidity_voltage: 'turbidity_voltage',
  ntu: 'turbidity',
  water_level: 'water_level',
  waterLevel: 'water_level',
  level: 'water_level',
  food_level: 'food_level',
  foodLevel: 'food_level',
};

function normalizeTelemetry(payload) {
  const out = { ts: Date.now() };
  for (const [rawKey, value] of Object.entries(payload)) {
    const key = ALIASES[rawKey];
    if (!key) continue;
    const n = value == null || value === '' || typeof value === 'boolean' ? NaN : Number(value);
    out[key] = Number.isFinite(n) ? n : null;
  }
  if (Number.isFinite(Number(payload.ts)) && Number(payload.ts) > 0) out.ts = Number(payload.ts);
  if (payload.rssi != null) runtime.rssi = Number(payload.rssi);
  if (payload.ip) runtime.ip = String(payload.ip);
  if (payload.firmware) runtime.firmware = String(payload.firmware);
  out.sensor_status = payload.sensor_status && typeof payload.sensor_status === 'object'
    ? payload.sensor_status : {};
  applyCapabilities(payload.capabilities);
  return out;
}

function applyCapabilities(caps) {
  if (!caps || typeof caps !== 'object') return;
  for (const key of Object.keys(runtime.capabilities)) {
    if (typeof caps[key] === 'boolean') runtime.capabilities[key] = caps[key];
  }
  // Require explicit channel support: old "drain" firmware must not unlock a light.
  runtime.capabilities.relay_keys = Array.isArray(caps.relay_keys)
    ? caps.relay_keys.filter((key) => PUMP_KEYS.includes(key)) : [];
}

function relayAvailable(key) {
  return runtime.capabilities.pumps && runtime.capabilities.relay_keys.includes(key);
}

function clearAckTimer(key) {
  if (ackTimers.has(key)) clearTimeout(ackTimers.get(key));
  ackTimers.delete(key);
}

/** Áp trạng thái relay thật do thiết bị báo về. */
function applyReportedPumps(pumps, deviceId, timers = {}) {
  if (!pumps || typeof pumps !== 'object') return false;
  let changed = false;
  for (const key of PUMP_KEYS) {
    if (typeof pumps[key] !== 'boolean') continue;
    const on = pumps[key];
    const state = runtime.pumps[key];
    if (!state.known) changed = true;
    state.known = true;
    if (state.on !== on) {
      state.on = on;
      state.since = on ? Date.now() : null;
      changed = true;
    }
    // A stale in-flight state report must not complete the opposite command.
    if (state.pending && on === (state.pendingAction === 'on')) {
      state.pending = false;
      state.pendingAction = null;
      state.commandId = null;
      clearAckTimer(key);
      changed = true;
    }
    if (!state.pending) state.error = null;
    const remainingMs = timers?.[key]?.remaining_ms;
    if (on && Number.isFinite(remainingMs) && remainingMs >= 0) {
      state.offAt = Date.now() + remainingMs;
      state.source = timers[key].source;
    }
    if (!on) {
      // Preserve the pending ON watchdog until the actual ON/OFF is confirmed.
      if (!state.pending) {
        state.offAt = null;
        clearPumpTimer(key);
      }
    }
  }
  if (changed) {
    db.upsertDevice(deviceId, { online: true });
    bus.emit(EVENTS.pumps, getPumpSnapshot());
  }
  return changed;
}

function handleTelemetry(deviceId, payload) {
  runtime.deviceId = deviceId;
  const reading = normalizeTelemetry(payload);
  runtime.lastReading = reading;
  runtime.lastReadingAt = Date.now();

  db.insertReading(deviceId, reading);
  applyReportedPumps(payload.pumps, deviceId, payload.relay_timers);

  const issues = evaluateReading(reading);
  const newAlerts = logNewAlerts(issues, deviceId);

  setOnline(deviceId, true, { lastSeen: Date.now() });
  bus.emit(EVENTS.reading, { deviceId, reading, issues, newAlerts });
  for (const alert of newAlerts) bus.emit(EVENTS.alert, alert);
}

function handleStatus(deviceId, raw, retained = false) {
  const text = raw.trim().toLowerCase();
  if (text === 'online' && !retained) {
    setOnline(deviceId, true, { lastSeen: Date.now() });
  } else if (['offline', 'gone', 'disconnected'].includes(text)) {
    setOnline(deviceId, false);
  }
}

function handleState(deviceId, payload, retained = false) {
  runtime.deviceId = deviceId;
  applyCapabilities(payload.capabilities);
  if (payload.firmware) runtime.firmware = String(payload.firmware);
  if (payload.ip) runtime.ip = String(payload.ip);
  if (retained) return; // Wait for live telemetry/ACK before claiming a relay is confirmed.
  applyReportedPumps(payload.pumps, deviceId, payload.relay_timers);
  if (payload.ts) runtime.lastSeen = Math.max(runtime.lastSeen ?? 0, Date.now());
  setOnline(deviceId, true, { lastSeen: Date.now() });
}

function handleAck(deviceId, payload) {
  const pump = payload.pump;
  if (PUMPS[pump] && payload.id && runtime.pumps[pump].lastCommandId && payload.id !== runtime.pumps[pump].lastCommandId) return;
  if (payload.pumps) applyReportedPumps(payload.pumps, deviceId, payload.relay_timers);
  if (pump && PUMPS[pump] && payload.ok === false) {
    // Thiết bị từ chối lệnh: trả trạng thái về như cũ và báo cho giao diện.
    const state = runtime.pumps[pump];
    state.pending = false;
    state.pendingAction = null;
    state.commandId = null;
    state.error = payload.error || payload.reason || 'Thiết bị từ chối lệnh';
    clearAckTimer(pump);
    // Keep the reported state (an OFF rejection must not claim that a load is off).
    if (!payload.pumps || typeof payload.pumps[pump] !== 'boolean') state.known = false;
    clearPumpTimer(pump);
    bus.emit(EVENTS.pumps, getPumpSnapshot());
    bus.emit(EVENTS.alert, {
      param: 'device',
      level: 'warn',
      value: null,
      message: `Thiết bị từ chối lệnh ${PUMPS[pump].label}: ${payload.error || payload.reason || 'không rõ lý do'}`,
      ts: Date.now(),
    });
  }
  setOnline(deviceId, true, { lastSeen: Date.now() });
}

function dispatchMessage(t, payloadText, retained = false) {
  if (!t.startsWith(`${PREFIX}/`)) return;
  const parts = t.split('/');
  if (parts.length < 3) return;
  const deviceId = parts[1];
  // This dashboard controls one configured ESP32. Do not let another node/simulator take it over.
  if (deviceId !== config.defaultDeviceId) return;
  const kind = parts.slice(2).join('/');

  let payload = null;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    payload = null;
  }

  switch (kind) {
    case 'telemetry':
      if (payload) handleTelemetry(deviceId, payload);
      break;
    case 'status':
      handleStatus(deviceId, payloadText, retained);
      break;
    case 'state':
      if (payload) handleState(deviceId, payload, retained);
      break;
    case 'ack':
      if (payload) handleAck(deviceId, payload);
      break;
    default:
      break;
  }
}

export function getPumpSnapshot() {
  const now = Date.now();
  return {
    pumps: PUMP_KEYS.map((key) => {
      const def = PUMPS[key];
      const state = runtime.pumps[key];
      const last = db.lastPumpEvent(key);
      const runSeconds = state.on && state.since ? Math.round((now - state.since) / 1000) : 0;
      const remainingSeconds = state.on
        ? state.offAt
          ? Math.max(0, Math.ceil((state.offAt - now) / 1000))
          : null
        : def.maxRunSeconds;
      return {
        key,
        available: relayAvailable(key),
        label: def.label,
        short: def.short,
        description: def.description,
        relayChannel: def.relayChannel,
        gpio: def.gpio,
        group: def.group,
        maxRunSeconds: def.maxRunSeconds,
        kind: def.kind,
        defaultSeconds: def.defaultSeconds,
        durations: def.durations,
        on: state.on,
        confirmed: state.known && runtime.status === 'online',
        pending: state.pending,
        pendingAction: state.pendingAction,
        error: state.error,
        commandId: state.commandId,
        source: state.source,
        since: state.since,
        offAt: state.offAt,
        runSeconds,
        remainingSeconds,
        lastEvent: last,
      };
    }),
    exclusiveGroups: PUMP_GROUPS,
    deviceOnline: runtime.status === 'online',
  };
}

/** Gửi lệnh điều khiển bơm tới thiết bị qua MQTT. */
function publishCommand(command) {
  if (!client || !client.connected) {
    const err = new Error('Máy chủ chưa kết nối được broker MQTT nên không gửi được lệnh.');
    err.statusCode = 503;
    throw err;
  }
  client.publish(topic(runtime.deviceId, 'cmd'), JSON.stringify(command), { qos: 1 });
}

function clearPumpTimer(key) {
  if (pumpTimers.has(key)) {
    clearTimeout(pumpTimers.get(key));
    pumpTimers.delete(key);
  }
}

function armPumpTimer(key, seconds) {
  clearPumpTimer(key);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  runtime.pumps[key].offAt = Date.now() + seconds * 1000;
  const timer = setTimeout(() => {
    pumpTimers.delete(key);
    try {
      controlPump(key, 'off', {
        actor: 'server',
        source: 'watchdog',
        note: `Tự ngắt sau ${seconds}s (giới hạn an toàn)`,
      });
    } catch (err) {
      console.error('[watchdog] Không gửi được lệnh ngắt bơm:', err.message);
    }
  }, seconds * 1000);
  timer.unref?.();
  pumpTimers.set(key, timer);
}

/**
 * Điều khiển một bơm. Không có chế độ tự động: mọi lệnh đều do người dùng bấm.
 * Riêng việc tự ngắt sau maxRunSeconds là chốt an toàn, có thể thấy rõ trên giao diện.
 *
 * @param {string} pumpKey  ph_up | ph_down | light
 * @param {'on'|'off'} action
 * @param {{actor?:string, source?:string, seconds?:number, note?:string}} options
 */
export function controlPump(pumpKey, action, options = {}) {
  const def = PUMPS[pumpKey];
  if (!def) {
    const err = new Error(`Không có kênh relay "${pumpKey}".`);
    err.statusCode = 400;
    throw err;
  }
  if (action !== 'on' && action !== 'off') {
    const err = new Error('Hành động chỉ có thể là "on" hoặc "off".');
    err.statusCode = 400;
    throw err;
  }
  if (runtime.status !== 'online') {
    const err = new Error(
      'Thiết bị ESP32 đang mất kết nối nên không thể điều khiển. Lệnh không được gửi đi.',
    );
    err.statusCode = 409;
    throw err;
  }
  if (!relayAvailable(pumpKey)) {
    const err = new Error('Firmware chưa khai báo kênh relay này. Nạp firmware 2.2 để đồng bộ bơm và đèn.');
    err.statusCode = 409;
    throw err;
  }

  const source = options.source || 'user';
  const actor = options.actor || 'admin';
  const note = options.note || null;
  const state = runtime.pumps[pumpKey];
  if (action === 'on' && state.pending) {
    const err = new Error('Kênh đang chờ ESP32 xác nhận. Có thể bấm Tắt để dừng.');
    err.statusCode = 409;
    throw err;
  }

  // Hai bơm cùng nhóm (nâng pH / hạ pH) triệt tiêu nhau nên phải ngắt cái còn lại.
  if (action === 'on') {
    const others = (PUMP_GROUPS[def.group] || []).filter((k) => k !== pumpKey);
    for (const other of others) {
      if (runtime.pumps[other].on || runtime.pumps[other].pendingAction === 'on') {
        controlPump(other, 'off', { source: 'interlock', actor, note: `Ngắt khi bật ${def.label}` });
      }
    }
  }

  const seconds =
    action === 'on'
      ? Math.min(Math.max(Math.floor(Number(options.seconds) || def.defaultSeconds), 1), def.maxRunSeconds)
      : null;

  const commandId = `cmd-${randomUUID()}`;
  publishCommand({
    id: commandId,
    pump: pumpKey,
    action,
    duration: seconds,
    ts: Date.now(),
    source,
  });

  state.pending = true;
  state.pendingAction = action;
  state.commandId = commandId;
  state.lastCommandId = commandId;
  state.error = null;
  state.commandedAt = Date.now();
  if (action === 'on') {
    armPumpTimer(pumpKey, seconds);
  }
  clearAckTimer(pumpKey);
  const ackTimer = setTimeout(() => {
    ackTimers.delete(pumpKey);
    if (state.commandId !== commandId) return;
    state.pending = false;
    state.pendingAction = null;
    state.commandId = null;
    state.known = false;
    state.error = 'Chưa nhận xác nhận từ ESP32. Kiểm tra thiết bị hoặc gửi lệnh Tắt.';
    bus.emit(EVENTS.pumps, getPumpSnapshot());
  }, config.commandAckTimeoutMs);
  ackTimer.unref?.();
  ackTimers.set(pumpKey, ackTimer);

  db.logPumpEvent({ pump: pumpKey, action, source, actor, durationS: seconds, note });
  const snapshot = getPumpSnapshot();
  bus.emit(EVENTS.pumps, snapshot);
  return snapshot;
}

/** Kiểm tra định kỳ: quá lâu không thấy dữ liệu thì coi như mất kết nối. */
function startStaleWatcher() {
  const timer = setInterval(() => {
    if (runtime.status !== 'online') return;
    const last = runtime.lastSeen ?? 0;
    if (Date.now() - last > config.staleAfterMs) {
      setOnline(runtime.deviceId, false);
      bus.emit(EVENTS.alert, {
        param: 'device',
        level: 'critical',
        value: null,
        message: `Mất dữ liệu từ thiết bị hơn ${Math.round(config.staleAfterMs / 1000)} giây.`,
        ts: Date.now(),
      });
    }
  }, Math.max(2000, Math.floor(config.staleAfterMs / 4)));
  timer.unref?.();
  return timer;
}

/** Khởi động broker nhúng + client nội bộ. */
export async function startBroker() {
  if (config.embeddedBroker) {
    aedes = aedesFactory();
    if (process.env.MQTT_USERNAME) {
      const user = process.env.MQTT_USERNAME;
      const pass = process.env.MQTT_PASSWORD || '';
      aedes.authenticate = (client_, username, password, done) => {
        const ok = username?.toString() === user && password?.toString() === pass;
        if (!ok) {
          const err = new Error('Sai tài khoản MQTT');
          err.returnCode = 4;
          return done(err, false);
        }
        return done(null, true);
      };
    }

    netServer = net.createServer(aedes.handle);
    await new Promise((resolve, reject) => {
      netServer.once('error', reject);
      netServer.listen(config.mqttPort, config.host, () => {
        netServer.off('error', reject);
        resolve();
      });
    });
    console.log(`[mqtt] Broker nhúng đang lắng nghe tại ${config.host}:${config.mqttPort}`);
  }

  const url = config.embeddedBroker
    ? `mqtt://127.0.0.1:${config.mqttPort}`
    : config.externalBrokerUrl;

  client = mqttFactory.connect(url, {
    clientId: `aquarium-server-${process.pid}`,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 10000,
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
  });

  client.on('connect', () => {
    console.log(`[mqtt] Server đã kết nối broker: ${url}`);
    client.subscribe(`${PREFIX}/+/telemetry`, { qos: 1 });
    client.subscribe(`${PREFIX}/+/state`, { qos: 1 });
    client.subscribe(`${PREFIX}/+/status`, { qos: 1 });
    client.subscribe(`${PREFIX}/+/ack`, { qos: 1 });
  });

  client.on('message', (t, payload, packet) => {
    try {
      dispatchMessage(t, payload.toString('utf8'), packet.retain);
    } catch (err) {
      console.error('[mqtt] Lỗi xử lý bản tin:', t, err.message);
    }
  });

  client.on('error', (err) => console.error('[mqtt] Lỗi client:', err.message));

  startStaleWatcher();

  // Nạp lại trạng thái thiết bị đã lưu để dashboard không trống khi vừa khởi động.
  const saved = db.getDevice(runtime.deviceId);
  if (saved) {
    runtime.lastSeen = saved.lastSeen ?? null;
    runtime.ip = saved.ip ?? null;
    runtime.firmware = saved.firmware ?? null;
  }
  const last = db.latestReading(runtime.deviceId);
  if (last) {
    runtime.lastReading = last;
    runtime.lastReadingAt = last.receivedAt;
  }
}

export async function stopBroker() {
  for (const timer of ackTimers.values()) clearTimeout(timer);
  ackTimers.clear();
  for (const timer of pumpTimers.values()) clearTimeout(timer);
  pumpTimers.clear();
  if (client) {
    client.removeAllListeners();
    client.end(true);
    client = null;
  }
  if (netServer) {
    await new Promise((resolve) => netServer.close(resolve));
    netServer = null;
  }
  if (aedes) {
    await new Promise((resolve) => aedes.close(resolve));
    aedes = null;
  }
}

export function isBrokerConnected() {
  return !!client && client.connected;
}
