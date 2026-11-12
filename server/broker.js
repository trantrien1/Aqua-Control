/**
 * Tầng giao tiếp thiết bị, phục vụ NHIỀU ESP32 cùng lúc.
 *
 * Mỗi thiết bị có một "runtime" riêng (số đo mới nhất, trạng thái bơm, hẹn giờ).
 * Chạy broker MQTT nhúng (aedes) ngay trong tiến trình Node nên không cần cài
 * Mosquitto: ESP32 chỉ cần trỏ vào IP máy chủ, cổng 1883.
 *
 * Xác thực: mỗi thiết bị do trang web cấp có deviceId + deviceKey. ESP32 đăng
 * nhập MQTT bằng đúng cặp đó; server tra hash trong bảng devices. Nhờ vậy người
 * lạ biết deviceId cũng không giả được thiết bị của khách khác.
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
import { waterSettings, ACTIVE_STAGES, changeEstimate } from './water.js';

const PREFIX = config.topicPrefix;

/** Bản ghi runtime của một thiết bị. */
function freshRuntime(deviceId) {
  return {
    deviceId,
    status: 'offline',
    lastSeen: null,
    lastReading: null,
    lastReadingAt: null,
    firmware: null,
    ip: null,
    rssi: null,
    settingsRevision: null,
    waterChange: { stage: 'unknown', attempts: 0 },
    waterPending: null,
    waterError: null,
    waterReportedAt: null,
    lastConfigSentAt: 0,
    settingsError: null,
    capabilities: {
      pumps: false,
      water_level: false,
      turbidity_voltage: false,
      turbidity_percent: false,
      water_change: false,
      water_recovery: false,
      relay_keys: [],
    },
    pumps: Object.fromEntries(
      PUMP_KEYS.map((key) => [
        key,
        {
          on: false,
          known: false,
          since: null,
          commandedAt: null,
          pending: false,
          pendingAction: null,
          commandId: null,
          lastCommandId: null,
          error: null,
          offAt: null,
          source: null,
        },
      ]),
    ),
  };
}

/** deviceId -> runtime. Không giới hạn số thiết bị, tạo lười khi có bản tin đầu tiên. */
const devices = new Map();
/** `deviceId|pumpKey` -> timeout hẹn giờ tự ngắt. */
const pumpTimers = new Map();
const ackTimers = new Map();

let aedes = null;
let netServer = null;
let client = null;

const topic = (deviceId, suffix) => `${PREFIX}/${deviceId}/${suffix}`;

export function runtimeFor(deviceId) {
  let found = devices.get(deviceId);
  if (!found) {
    found = freshRuntime(deviceId);
    devices.set(deviceId, found);
  }
  return found;
}

export function knownDeviceIds() {
  return [...devices.keys()];
}

export function publishWaterConfig(deviceId) {
  if (!client?.connected) return;
  runtimeFor(deviceId).lastConfigSentAt = Date.now();
  client.publish(topic(deviceId, 'config'), JSON.stringify(waterSettings(deviceId)), { qos: 1, retain: true });
}

function applyWaterReport(runtime, payload) {
  if (Number.isInteger(payload.settings_revision)) runtime.settingsRevision = payload.settings_revision;
  const w = payload.water_change;
  if (w && ['idle', 'draining', 'switching', 'filling', 'settling', 'locked', 'error'].includes(w.stage)) {
    const changed = runtime.waterChange.stage !== w.stage;
    runtime.waterChange = {
      stage: w.stage, percent: Number(w.percent) || 0, attempts: Math.min(3, Math.max(0, Number(w.attempts) || 0)),
      automatic: w.automatic === true, remaining_ms: Math.max(0, Number(w.remaining_ms) || 0),
      reason: String(w.reason || '').slice(0, 160),
    };
    runtime.waterReportedAt = Date.now();
    if (changed) {
      const message = `Thay nước: ${w.stage}, ${runtime.waterChange.percent}%, lần tự động ${runtime.waterChange.attempts}/3${w.reason ? ' · ' + runtime.waterChange.reason : ''}`;
      db.logPumpEvent({ deviceId: runtime.deviceId, pump: 'water_change', action: w.stage, source: w.automatic ? 'auto' : 'device', note: message });
      bus.emit(EVENTS.water, { deviceId: runtime.deviceId, ...runtime.waterChange, message });
    }
  }
  const desiredRevision = waterSettings(runtime.deviceId).revision;
  // A newer NVS configuration must be resolved by the owner, not retried forever.
  if (runtime.capabilities.water_change && (runtime.settingsRevision == null || runtime.settingsRevision < desiredRevision) && Date.now() - runtime.lastConfigSentAt > 5000) publishWaterConfig(runtime.deviceId);
}

export function getWaterSnapshot(deviceId) {
  const runtime = runtimeFor(deviceId);
  if (runtime.waterPending && Date.now() - runtime.waterPending.sentAt > config.commandAckTimeoutMs) {
    runtime.waterPending = null;
    runtime.waterError = 'Chưa nhận xác nhận từ ESP32. Kiểm tra trạng thái trước khi thử lại.';
  }
  return {
    ...runtime.waterChange, settings: waterSettings(deviceId), flowLph: 96,
    supported: runtime.capabilities.water_change,
    synced: runtime.status === 'online' && runtime.settingsRevision === waterSettings(deviceId).revision,
    deviceRevision: runtime.settingsRevision, reportedAt: runtime.waterReportedAt,
    settingsIssue: runtime.settingsRevision > waterSettings(deviceId).revision ? 'device-newer' : null,
    settingsError: runtime.settingsError,
    busy: ACTIVE_STAGES.includes(runtime.waterChange.stage) || Boolean(runtime.waterPending),
    pending: runtime.waterPending, error: runtime.waterError,
  };
}

export function controlWater(deviceId, action, options = {}) {
  const runtime = runtimeFor(deviceId);
  const snapshot = getWaterSnapshot(deviceId);
  const reject = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
  if (!['start', 'stop', 'reset'].includes(action)) reject('Lệnh thay nước không hợp lệ.', 400);
  if (runtime.status !== 'online' || !snapshot.supported) reject('ESP32 đang offline hoặc chưa hỗ trợ thay nước.');
  let estimate = null;
  if (action === 'start') {
    if (!Number.isInteger(options.percent) || options.percent < 1 || options.percent > 50) reject('Phần trăm thay nước phải là số nguyên từ 1 đến 50.', 400);
    if (!snapshot.settings.tankLiters || !snapshot.synced) reject('Nhập thể tích bể và chờ ESP32 đồng bộ cấu hình.');
    if (snapshot.busy || ['unknown', 'error'].includes(snapshot.stage) || ['drain', 'fill'].some(k => runtime.pumps[k].on || runtime.pumps[k].pending || !runtime.pumps[k].known)) reject('Bơm đang bận hoặc cần kiểm tra và xác nhận mực nước.');
    estimate = changeEstimate(snapshot.settings.tankLiters, options.percent);
  }
  if (action === 'reset' && (snapshot.busy || options.confirmLevel !== true || ['drain', 'fill'].some(k => runtime.pumps[k].on || !runtime.pumps[k].known))) reject('Dừng bơm và xác nhận đã kiểm tra, cân bằng mực nước trước khi đặt lại.');
  const id = `water-${randomUUID()}`;
  publishCommand(deviceId, { id, type: 'water_change', action, percent: options.percent, settings_revision: snapshot.settings.revision, ts: Date.now() });
  runtime.waterPending = { id, action, sentAt: Date.now() };
  runtime.waterError = null;
  clearAckTimer(deviceId, 'water_change');
  const ackTimer = setTimeout(() => {
    ackTimers.delete(`${deviceId}|water_change`);
    if (runtime.waterPending?.id !== id) return;
    runtime.waterPending = null;
    runtime.waterError = 'Chưa nhận xác nhận từ ESP32. Kiểm tra trạng thái trước khi thử lại.';
    bus.emit(EVENTS.water, { deviceId });
  }, config.commandAckTimeoutMs);
  ackTimer.unref?.();
  ackTimers.set(`${deviceId}|water_change`, ackTimer);
  db.logPumpEvent({ deviceId, pump: 'water_change', action, source: options.source || 'user', actor: options.actor, note: estimate ? `${options.percent}% · ${estimate.liters} L · ${estimate.phaseSeconds}s mỗi pha` : null });
  bus.emit(EVENTS.water, { deviceId });
  return { ...getWaterSnapshot(deviceId), estimate };
}

function setOnline(deviceId, online, patch = {}) {
  const runtime = runtimeFor(deviceId);
  const changed = runtime.status !== (online ? 'online' : 'offline');
  runtime.status = online ? 'online' : 'offline';
  if (!online) {
    runtime.waterPending = null;
    clearAckTimer(deviceId, 'water_change');
    for (const key of PUMP_KEYS) {
      const state = runtime.pumps[key];
      state.known = false;
      state.pending = false;
      state.pendingAction = null;
      state.commandId = null;
      clearAckTimer(deviceId, key);
      clearPumpTimer(deviceId, key);
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
  if (changed) bus.emit(EVENTS.device, getDeviceSnapshot(deviceId));
}

export function getDeviceSnapshot(deviceId) {
  const runtime = runtimeFor(deviceId);
  const now = Date.now();
  const record = db.getDevice(deviceId);
  return {
    id: deviceId,
    name: record?.name || deviceId,
    ownerId: record?.ownerId ?? null,
    status: runtime.status,
    online: runtime.status === 'online',
    lastSeen: runtime.lastSeen,
    ageMs: runtime.lastSeen ? now - runtime.lastSeen : null,
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
  turbidity_percent: 'turbidity_percent',
  ntu: 'turbidity',
  water_level: 'water_level',
  waterLevel: 'water_level',
  level: 'water_level',
};

function normalizeTelemetry(runtime, payload) {
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
  out.sensor_status =
    payload.sensor_status && typeof payload.sensor_status === 'object' ? payload.sensor_status : {};
  applyCapabilities(runtime, payload.capabilities);
  return out;
}

function applyCapabilities(runtime, caps) {
  if (!caps || typeof caps !== 'object') return;
  for (const key of Object.keys(runtime.capabilities)) {
    if (typeof caps[key] === 'boolean') runtime.capabilities[key] = caps[key];
  }
  // Require explicit channel support: old "drain" firmware must not unlock a light.
  runtime.capabilities.relay_keys = Array.isArray(caps.relay_keys)
    ? caps.relay_keys.filter((key) => PUMP_KEYS.includes(key))
    : [];
}

function relayAvailable(runtime, key) {
  return runtime.capabilities.pumps && runtime.capabilities.relay_keys.includes(key);
}

function clearAckTimer(deviceId, key) {
  const id = `${deviceId}|${key}`;
  if (ackTimers.has(id)) clearTimeout(ackTimers.get(id));
  ackTimers.delete(id);
}

/** Áp trạng thái relay thật do thiết bị báo về. */
function applyReportedPumps(runtime, pumps, timers = {}) {
  if (!pumps || typeof pumps !== 'object') return false;
  const deviceId = runtime.deviceId;
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
      clearAckTimer(deviceId, key);
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
        clearPumpTimer(deviceId, key);
      }
    }
  }
  if (changed) {
    db.upsertDevice(deviceId, { online: true });
    bus.emit(EVENTS.pumps, getPumpSnapshot(deviceId));
  }
  return changed;
}

function handleTelemetry(deviceId, payload) {
  const runtime = runtimeFor(deviceId);
  const reading = normalizeTelemetry(runtime, payload);
  runtime.lastReading = reading;
  runtime.lastReadingAt = Date.now();

  db.insertReading(deviceId, reading);
  applyReportedPumps(runtime, payload.pumps, payload.relay_timers);
  applyWaterReport(runtime, payload);

  const issues = evaluateReading(reading, waterSettings(deviceId));
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
  const runtime = runtimeFor(deviceId);
  applyCapabilities(runtime, payload.capabilities);
  if (payload.firmware) runtime.firmware = String(payload.firmware);
  if (payload.ip) runtime.ip = String(payload.ip);
  if (retained) return; // Wait for live telemetry/ACK before claiming a relay is confirmed.
  applyReportedPumps(runtime, payload.pumps, payload.relay_timers);
  applyWaterReport(runtime, payload);
  setOnline(deviceId, true, { lastSeen: Date.now() });
}

function handleAck(deviceId, payload) {
  const runtime = runtimeFor(deviceId);
  if (payload.type === 'config') {
    runtime.settingsError = payload.ok === false ? String(payload.reason || 'config-rejected') : null;
    applyWaterReport(runtime, payload);
    bus.emit(EVENTS.water, { deviceId });
  }
  if (payload.type === 'water_change') {
    if (runtime.waterPending && payload.id !== runtime.waterPending.id) return;
    runtime.waterPending = null;
    clearAckTimer(deviceId, 'water_change');
    runtime.waterError = payload.ok === false ? (payload.reason || 'Thiết bị từ chối thay nước') : null;
    applyWaterReport(runtime, payload);
    bus.emit(EVENTS.pumps, getPumpSnapshot(deviceId));
  }
  const pump = payload.pump;
  if (PUMPS[pump] && payload.id && runtime.pumps[pump].lastCommandId && payload.id !== runtime.pumps[pump].lastCommandId) return;
  if (payload.pumps) applyReportedPumps(runtime, payload.pumps, payload.relay_timers);
  if (pump && PUMPS[pump] && payload.ok === false) {
    // Thiết bị từ chối lệnh: trả trạng thái về như cũ và báo cho giao diện.
    const state = runtime.pumps[pump];
    state.pending = false;
    state.pendingAction = null;
    state.commandId = null;
    state.error = payload.error || payload.reason || 'Thiết bị từ chối lệnh';
    clearAckTimer(deviceId, pump);
    // Keep the reported state (an OFF rejection must not claim that a load is off).
    if (!payload.pumps || typeof payload.pumps[pump] !== 'boolean') state.known = false;
    clearPumpTimer(deviceId, pump);
    bus.emit(EVENTS.pumps, getPumpSnapshot(deviceId));
    bus.emit(EVENTS.alert, {
      deviceId,
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
  // Chỉ nhận bản tin của thiết bị đã được trang web cấp phát.
  if (!db.getDevice(deviceId)) return;
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

export function getPumpSnapshot(deviceId) {
  const runtime = runtimeFor(deviceId);
  const now = Date.now();
  return {
    deviceId,
    pumps: PUMP_KEYS.map((key) => {
      const def = PUMPS[key];
      const state = runtime.pumps[key];
      const last = db.lastPumpEvent(deviceId, key);
      const runSeconds = state.on && state.since ? Math.round((now - state.since) / 1000) : 0;
      const remainingSeconds = state.on
        ? state.offAt
          ? Math.max(0, Math.ceil((state.offAt - now) / 1000))
          : null
        : def.maxRunSeconds;
      return {
        key,
        available: relayAvailable(runtime, key),
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

/** Gửi lệnh điều khiển bơm tới một thiết bị qua MQTT. */
function publishCommand(deviceId, command) {
  if (!client || !client.connected) {
    const err = new Error('Máy chủ chưa kết nối được broker MQTT nên không gửi được lệnh.');
    err.statusCode = 503;
    throw err;
  }
  client.publish(topic(deviceId, 'cmd'), JSON.stringify(command), { qos: 1 });
}

function clearPumpTimer(deviceId, key) {
  const id = `${deviceId}|${key}`;
  if (pumpTimers.has(id)) {
    clearTimeout(pumpTimers.get(id));
    pumpTimers.delete(id);
  }
}

function armPumpTimer(deviceId, key, seconds) {
  clearPumpTimer(deviceId, key);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  runtimeFor(deviceId).pumps[key].offAt = Date.now() + seconds * 1000;
  const timer = setTimeout(() => {
    pumpTimers.delete(`${deviceId}|${key}`);
    try {
      controlPump(deviceId, key, 'off', {
        actor: 'server',
        source: 'watchdog',
        note: `Tự ngắt sau ${seconds}s (giới hạn an toàn)`,
      });
    } catch (err) {
      console.error('[watchdog] Không gửi được lệnh ngắt bơm:', err.message);
    }
  }, seconds * 1000);
  timer.unref?.();
  pumpTimers.set(`${deviceId}|${key}`, timer);
}

/**
 * Lệnh relay thủ công. Chu trình thay nước tự động do ESP32 thực thi tại chỗ
 * theo cấu hình đã được chủ bể lưu và thiết bị xác nhận.
 *
 * @param {string} deviceId
 * @param {string} pumpKey  drain | fill | light
 * @param {'on'|'off'} action
 * @param {{actor?:string, source?:string, seconds?:number, note?:string}} options
 */
export function controlPump(deviceId, pumpKey, action, options = {}) {
  const runtime = runtimeFor(deviceId);
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
  if (!relayAvailable(runtime, pumpKey)) {
    const err = new Error('Firmware chưa khai báo kênh relay này. Nạp firmware v3 để đồng bộ bơm và đèn.');
    err.statusCode = 409;
    throw err;
  }

  const source = options.source || 'user';
  const actor = options.actor || 'admin';
  const note = options.note || null;
  const state = runtime.pumps[pumpKey];
  if (action === 'on' && pumpKey !== 'light') {
    const water = getWaterSnapshot(deviceId);
    if (runtime.capabilities.water_change && (!water.synced || !water.settings.tankLiters || water.busy || ['error', 'unknown'].includes(water.stage))) {
      throw Object.assign(new Error('Lưu thể tích bể, chờ đồng bộ ESP32 và kết thúc/kiểm tra chu trình nước trước khi bật bơm.'), { statusCode: 409 });
    }
  }
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
        controlPump(deviceId, other, 'off', {
          source: 'interlock',
          actor,
          note: `Ngắt khi bật ${def.label}`,
        });
      }
    }
  }

  const seconds =
    action === 'on'
      ? Math.min(Math.max(Math.floor(Number(options.seconds) || def.defaultSeconds), 1), def.maxRunSeconds)
      : null;

  const commandId = `cmd-${randomUUID()}`;
  publishCommand(deviceId, {
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
  if (action === 'on') armPumpTimer(deviceId, pumpKey, seconds);
  clearAckTimer(deviceId, pumpKey);
  const ackTimer = setTimeout(() => {
    ackTimers.delete(`${deviceId}|${pumpKey}`);
    if (state.commandId !== commandId) return;
    state.pending = false;
    state.pendingAction = null;
    state.commandId = null;
    state.known = false;
    state.error = 'Chưa nhận xác nhận từ ESP32. Kiểm tra thiết bị hoặc gửi lệnh Tắt.';
    bus.emit(EVENTS.pumps, getPumpSnapshot(deviceId));
  }, config.commandAckTimeoutMs);
  ackTimer.unref?.();
  ackTimers.set(`${deviceId}|${pumpKey}`, ackTimer);

  db.logPumpEvent({ deviceId, pump: pumpKey, action, source, actor, durationS: seconds, note });
  const snapshot = getPumpSnapshot(deviceId);
  bus.emit(EVENTS.pumps, snapshot);
  return snapshot;
}

/** Kiểm tra định kỳ: quá lâu không thấy dữ liệu thì coi như mất kết nối. */
function startStaleWatcher() {
  const timer = setInterval(() => {
    for (const [deviceId, runtime] of devices) {
      if (runtime.status !== 'online') continue;
      const last = runtime.lastSeen ?? 0;
      if (Date.now() - last <= config.staleAfterMs) continue;
      setOnline(deviceId, false);
      bus.emit(EVENTS.alert, {
        deviceId,
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

    /**
     * Xác thực thiết bị: username = deviceId, password = deviceKey do trang web cấp.
     * Client nội bộ của server dùng tài khoản riêng trong MQTT_SERVER_USERNAME.
     */
    const serverUser = process.env.MQTT_SERVER_USERNAME || `server-${process.pid}`;
    const serverPass = process.env.MQTT_SERVER_PASSWORD || config.sessionSecret;
    aedes.authenticate = (client_, username, password, done) => {
      const user = username?.toString() ?? '';
      const pass = password?.toString() ?? '';
      if (user === serverUser && pass === serverPass) return done(null, true);
      const device = db.verifyDeviceCredentials(user, pass);
      if (!device) {
        const err = new Error('Sai mã thiết bị hoặc khoá thiết bị');
        err.returnCode = 4;
        return done(err, false);
      }
      // Gắn deviceId vào phiên để không cho client này đăng bản tin của thiết bị khác.
      client_.deviceId = device.deviceId;
      return done(null, true);
    };

    /**
     * Chặn giả mạo chéo: một thiết bị chỉ được publish/subscribe trong nhánh
     * topic của chính nó. server-* được toàn quyền.
     */
    aedes.authorizePublish = (client_, packet, done) => {
      const scope = client_?.deviceId;
      if (!scope) return done(null);
      if (['telemetry', 'state', 'status', 'ack'].some(suffix => packet.topic === topic(scope, suffix))) return done(null);
      const err = new Error('Thiết bị chỉ được gửi số đo, trạng thái và phản hồi trong nhánh của mình');
      err.returnCode = 5;
      return done(err);
    };
    aedes.authorizeSubscribe = (client_, sub, done) => {
      const scope = client_?.deviceId;
      if (!scope) return done(null, sub);
      if (sub.topic.startsWith(`${PREFIX}/${scope}/`)) return done(null, sub);
      const err = new Error('Thiết bị không được đọc topic của thiết bị khác');
      err.returnCode = 5;
      return done(err, null);
    };

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
    username: config.embeddedBroker
      ? process.env.MQTT_SERVER_USERNAME || `server-${process.pid}`
      : process.env.MQTT_USERNAME || undefined,
    password: config.embeddedBroker
      ? process.env.MQTT_SERVER_PASSWORD || config.sessionSecret
      : process.env.MQTT_PASSWORD || undefined,
  });

  client.on('connect', () => {
    console.log(`[mqtt] Server đã kết nối broker: ${url}`);
    client.subscribe(`${PREFIX}/+/telemetry`, { qos: 1 });
    client.subscribe(`${PREFIX}/+/state`, { qos: 1 });
    client.subscribe(`${PREFIX}/+/status`, { qos: 1 });
    client.subscribe(`${PREFIX}/+/ack`, { qos: 1 });
    for (const record of db.listDevices()) publishWaterConfig(record.deviceId);
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

  // Nạp lại trạng thái đã lưu để dashboard không trống ngay sau khi khởi động.
  for (const record of db.listDevices()) {
    const runtime = runtimeFor(record.deviceId);
    runtime.lastSeen = record.lastSeen ?? null;
    runtime.ip = record.ip ?? null;
    runtime.firmware = record.firmware ?? null;
    const last = db.latestReading(record.deviceId);
    if (last) {
      runtime.lastReading = last;
      runtime.lastReadingAt = last.receivedAt;
    }
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
