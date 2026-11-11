/**
 * Tầng HTTP: xác thực, snapshot trạng thái, lịch sử, điều khiển bơm và kênh
 * đẩy dữ liệu thời gian thực (Server-Sent Events).
 */
import express from 'express';
import { config, PARAMS, PARAM_KEYS, PUMPS, PUMP_KEYS } from './config.js';
import { bus, EVENTS } from './bus.js';
import * as db from './db.js';
import {
  controlPump,
  getDeviceSnapshot,
  getPumpSnapshot,
  isBrokerConnected,
  runtime,
} from './broker.js';
import { evaluateReading, rangeLabel, statusOf, suggestedPumps } from './alerts.js';
import {
  checkPassword,
  clearSessionCookie,
  createSession,
  registerLoginAttempt,
  requireAuth,
  resetLoginAttempts,
  setSessionCookie,
} from './auth.js';

export const api = express.Router();

/** Khung thời gian biểu đồ: bước gộp bucket chọn sẵn để mỗi biểu đồ ~120–200 điểm. */
const RANGES = {
  '1h': { ms: 3600e3, bucket: 30e3 },
  '6h': { ms: 6 * 3600e3, bucket: 180e3 },
  '24h': { ms: 24 * 3600e3, bucket: 600e3 },
  '7d': { ms: 7 * 24 * 3600e3, bucket: 3600e3 },
  '30d': { ms: 30 * 24 * 3600e3, bucket: 4 * 3600e3 },
};

const VALID_ACTIONS = new Set(['on', 'off']);

function buildState() {
  const device = getDeviceSnapshot();
  const reading = runtime.lastReading;
  const issues = evaluateReading(reading);
  const pumpState = getPumpSnapshot();
  const now = Date.now();
  const voltageMode = device.capabilities.turbidity_voltage ||
    reading?.turbidity_voltage != null || reading?.sensor_status?.turbidity_adc_voltage !== undefined;

  return {
    now,
    device,
    brokerConnected: isBrokerConnected(),
    reading,
    readingAgeMs: runtime.lastReadingAt ? now - runtime.lastReadingAt : null,
    params: PARAM_KEYS.filter((key) => key !== (voltageMode ? 'turbidity' : 'turbidity_voltage'))
      .filter((key) => !['water_level', 'food_level'].includes(key) || device.capabilities[key])
      .map((key) => {
      const def = PARAMS[key];
      const sensorStatus = reading?.sensor_status || {};
      let note = def.note || '';
      let statusText = null;
      if (key === 'ph' && sensorStatus.ph_calibrated === false) {
        note = 'Hiệu chuẩn bằng lệnh Serial ph7 và ph4';
        statusText = 'Chưa hiệu chuẩn';
      }
      if (key === 'tds' && sensorStatus.tds_estimated) {
        note = sensorStatus.tds_temperature_fallback
          ? 'Ước tính · tạm bù nhiệt 25 °C do lỗi DS18B20'
          : 'Ước tính · bù nhiệt DS18B20 · chưa hiệu chuẩn TDS';
      }
      if (['water_level', 'food_level'].includes(key) && !device.capabilities[key]) {
        note = 'Chưa bật cảm biến trong firmware';
      }
      if (key === 'turbidity_voltage' && reading?.[key] != null) statusText = 'Chưa quy đổi NTU';
      return {
        key,
        label: def.label,
        short: def.short,
        unit: def.unit,
        decimals: def.decimals,
        min: def.min,
        max: def.max,
        warnLow: def.warnLow,
        warnHigh: def.warnHigh,
        criticalLow: def.criticalLow,
        criticalHigh: def.criticalHigh,
        rangeLabel: rangeLabel(key),
        note,
        statusText,
        value: reading ? (reading[key] ?? null) : null,
        status: reading ? statusOf(key, reading[key]) : 'nodata',
      };
    }),
    issues,
    suggestions: device.capabilities.pumps ? suggestedPumps(issues) : [],
    pumps: pumpState.pumps,
    exclusiveGroups: pumpState.exclusiveGroups,
    pumpCatalog: PUMP_KEYS.map((key) => ({
      key,
      label: PUMPS[key].label,
      short: PUMPS[key].short,
      description: PUMPS[key].description,
      maxRunSeconds: PUMPS[key].maxRunSeconds,
      gpio: PUMPS[key].gpio,
      relayChannel: PUMPS[key].relayChannel,
      kind: PUMPS[key].kind,
      defaultSeconds: PUMPS[key].defaultSeconds,
      durations: PUMPS[key].durations,
    })),
    recentAlerts: db.recentAlerts(12),
    recentPumpEvents: db.recentPumpEvents(12),
    retention: db.retainedRange(),
  };
}

export function stateSnapshot() {
  return buildState();
}

/* ---------------------------------- công khai --------------------------------- */

api.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    brokerConnected: isBrokerConnected(),
    device: getDeviceSnapshot(),
  });
});

api.post('/login', express.json({ limit: '4kb' }), (req, res) => {
  const ip = req.ip || 'unknown';
  const limit = registerLoginAttempt(ip);
  if (!limit.allowed) {
    res
      .status(429)
      .json({ error: `Sai mật khẩu quá nhiều lần. Thử lại sau ${Math.ceil(limit.retryAfterMs / 60000)} phút.` });
    return;
  }
  const { password } = req.body ?? {};
  if (!checkPassword(password)) {
    res.status(401).json({ error: 'Mật khẩu không đúng.', remaining: limit.remaining });
    return;
  }
  resetLoginAttempts(ip);
  setSessionCookie(res, createSession('admin'));
  res.json({ ok: true, username: 'admin' });
});

api.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* ------------------------------ phần cần đăng nhập ---------------------------- */

api.use(requireAuth);

api.get('/me', (req, res) => {
  res.json({ username: req.session.sub, expiresAt: req.session.exp });
});

api.get('/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(buildState());
});

api.get('/history', (req, res) => {
  const metric = String(req.query.metric || 'temperature');
  const rangeKey = String(req.query.range || '24h');
  const range = RANGES[rangeKey] ?? RANGES['24h'];
  if (!PARAM_KEYS.includes(metric)) {
    res.status(400).json({ error: `Tham số không hợp lệ: ${metric}` });
    return;
  }
  const to = Date.now();
  const from = to - range.ms;
  const points = db.history(config.defaultDeviceId, metric, from, to, range.bucket);
  res.set('Cache-Control', 'no-store');
  res.json({
    metric,
    range: RANGES[rangeKey] ? rangeKey : '24h',
    from,
    to,
    bucketMs: range.bucket,
    unit: PARAMS[metric].unit,
    decimals: PARAMS[metric].decimals,
    safeRange: { min: PARAMS[metric].min, max: PARAMS[metric].max },
    points,
  });
});

api.get('/alerts', (req, res) => {
  res.json({ alerts: db.recentAlerts(Number(req.query.limit) || 50) });
});

api.get('/events/pumps', (req, res) => {
  res.json({ events: db.recentPumpEvents(Number(req.query.limit) || 50) });
});

api.get('/devices', (req, res) => {
  res.json({ devices: db.listDevices(), defaultDeviceId: config.defaultDeviceId });
});

api.post('/relays/stop-all', (req, res) => {
  try {
    const available = getPumpSnapshot().pumps.filter((p) => p.available);
    if (!available.length) return res.status(409).json({ error: 'Chưa có kênh relay được firmware xác nhận hỗ trợ.' });
    for (const p of available) controlPump(p.key, 'off', { actor: req.session.sub, source: 'user', note: 'Tắt tất cả relay' });
    res.json({ ok: true, ...getPumpSnapshot() });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

api.post('/pumps/:pump', express.json({ limit: '4kb' }), (req, res) => {
  const { pump } = req.params;
  const action = String(req.body?.action || '').toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    res.status(400).json({ error: 'Trường "action" phải là "on" hoặc "off".' });
    return;
  }
  const seconds = req.body?.seconds != null ? Number(req.body.seconds) : undefined;
  if (seconds != null && (!Number.isFinite(seconds) || seconds <= 0)) {
    res.status(400).json({ error: 'Trường "seconds" phải là số dương.' });
    return;
  }
  try {
    const snapshot = controlPump(pump, action, {
      actor: req.session.sub,
      source: 'user',
      seconds,
    });
    res.json({ ok: true, ...snapshot });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Kênh thời gian thực. Gộp các sự kiện dồn dập trong 300ms thành một lần đẩy
 * trạng thái đầy đủ, để trình duyệt chỉ cần một hàm render duy nhất.
 */
api.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let broadcastTimer = null;
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const schedule = () => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      try {
        send('state', buildState());
      } catch (err) {
        console.error('[sse] Lỗi gửi trạng thái:', err.message);
      }
    }, 300);
  };

  send('state', buildState());

  const onUpdate = () => schedule();
  for (const event of Object.values(EVENTS)) bus.on(event, onUpdate);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* sẽ dọn ở sự kiện close */
    }
  }, 15000);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    if (broadcastTimer) clearTimeout(broadcastTimer);
    for (const event of Object.values(EVENTS)) bus.off(event, onUpdate);
  };

  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);
});
