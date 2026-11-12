/**
 * Tầng HTTP: xác thực, danh sách thiết bị, snapshot, lịch sử, điều khiển bơm
 * và kênh đẩy dữ liệu thời gian thực (Server-Sent Events).
 *
 * Mọi API dữ liệu đều đi qua `loadDevice` để kiểm tra quyền sở hữu: khách hàng
 * chỉ đụng được thiết bị của mình, quản trị viên đụng được tất cả.
 */
import crypto from 'node:crypto';
import express from 'express';
import { config, PARAMS, PARAM_KEYS, PUMPS, PUMP_KEYS } from './config.js';
import { bus, EVENTS } from './bus.js';
import * as db from './db.js';
import {
  controlPump,
  controlWater, getWaterSnapshot, publishWaterConfig,
  getDeviceSnapshot,
  getPumpSnapshot,
  isBrokerConnected,
  runtimeFor,
} from './broker.js';
import { evaluateReading, rangeLabel, statusOf, suggestedPumps } from './alerts.js';
import {
  publicState as telegramState,
  sendTest as sendTelegramTest,
} from './telegram.js';
import { waterSettings, validateSettings, parameterDef } from './water.js';
import { hashPassword, verifyPassword } from './users.js';
import {
  clearSessionCookie,
  createSession,
  readSession,
  registerLoginAttempt,
  requireAdmin,
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

/* ------------------------------------------------------------------ helpers --- */

/** Thiết bị mà người dùng được phép xem, kèm danh sách rút gọn để đổ vào ô chọn. */
function deviceListFor(user) {
  return db.devicesForUser(user).map((d) => {
    const runtime = runtimeFor(d.deviceId);
    return {
      deviceId: d.deviceId,
      name: d.name,
      online: runtime.status === 'online',
      lastSeen: runtime.lastSeen,
      ownerId: d.ownerId,
    };
  });
}

/** Chọn thiết bị theo query/param và xác nhận quyền sở hữu. */
function resolveDevice(req, res) {
  const allowed = db.devicesForUser(req.session.user);
  if (!allowed.length) {
    res.status(409).json({ error: 'Tài khoản chưa được cấp thiết bị nào.' });
    return null;
  }
  const wanted = req.params.deviceId || req.query.device || '';
  const device = wanted
    ? allowed.find((d) => d.deviceId === wanted)
    : allowed[0];
  if (!device) {
    res.status(404).json({ error: 'Không tìm thấy thiết bị này trong tài khoản của bạn.' });
    return null;
  }
  return device;
}

/**
 * Snapshot đầy đủ cho một thiết bị. `deviceOptions` để giao diện vẽ ô chọn bể
 * mà không phải gọi thêm một API.
 */
function buildState(deviceId, user) {
  const device = getDeviceSnapshot(deviceId);
  const runtime = runtimeFor(deviceId);
  const reading = runtime.lastReading;
  const settings = waterSettings(deviceId);
  const issues = evaluateReading(reading, settings);
  const pumpState = getPumpSnapshot(deviceId);
  const now = Date.now();
  const voltageMode =
    device.capabilities.turbidity_voltage ||
    reading?.turbidity_voltage != null ||
    reading?.sensor_status?.turbidity_adc_voltage !== undefined;

  return {
    now,
    device,
    devices: deviceListFor(user),
    brokerConnected: isBrokerConnected(),
    reading,
    water: getWaterSnapshot(deviceId),
    readingAgeMs: runtime.lastReadingAt ? now - runtime.lastReadingAt : null,
    params: PARAM_KEYS.filter((key) => !['turbidity', 'turbidity_voltage', 'turbidity_percent'].includes(key) || key === (device.capabilities.turbidity_percent ? 'turbidity_percent' : voltageMode ? 'turbidity_voltage' : 'turbidity'))
      .filter((key) => key !== 'water_level' || device.capabilities.water_level)
      .map((key) => {
        const def = parameterDef(key, settings);
        const sensorStatus = reading?.sensor_status || {};
        let note = def.note || '';
        let statusText = null;
        if (key === 'ph' && sensorStatus.ph_fixed_reference && reading?.ph == null) {
          note = `Đang dùng mốc 1,927 V → pH 7,00. ADC hiện tại ${sensorStatus.ph_adc_voltage ?? '—'} V chưa quy đổi được theo mô hình.`;
          statusText = 'Chưa quy đổi';
        } else if (key === 'ph' && sensorStatus.ph_estimated) {
          note = 'Mốc tham chiếu 1,927 V → pH 7,00 · ước tính';
        } else if (key === 'ph' && sensorStatus.ph_calibrated === false) {
          note = 'Hiệu chuẩn bằng lệnh Serial ph7 và ph4';
          statusText = 'Chưa hiệu chuẩn';
        }
        if (key === 'tds' && sensorStatus.tds_estimated) {
          note = sensorStatus.tds_temperature_fallback
            ? 'Ước tính · tạm bù nhiệt 25 °C do lỗi DS18B20'
            : 'Ước tính · bù nhiệt DS18B20 · chưa hiệu chuẩn TDS';
        }
        if (key === 'water_level' && !device.capabilities.water_level) {
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
          rangeLabel: rangeLabel(key, settings),
          note,
          statusText,
          value: reading ? (reading[key] ?? null) : null,
          status: reading ? statusOf(key, reading[key], settings) : 'nodata',
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
    recentAlerts: db.recentAlerts(12, [deviceId]),
    recentPumpEvents: db.recentPumpEvents(12, [deviceId]),
    retention: db.retainedRange(deviceId),
    telegram: telegramState(user),
  };
}

export function stateSnapshot(deviceId, user) {
  return buildState(deviceId, user);
}

const parseId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/* ---------------------------------- công khai --------------------------------- */

api.get('/health', (req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()), brokerConnected: isBrokerConnected() });
});

api.post('/login', express.json({ limit: '4kb' }), (req, res) => {
  const ip = req.ip || 'unknown';
  const limit = registerLoginAttempt(ip);
  if (!limit.allowed) {
    res.status(429).json({
      error: `Sai mật khẩu quá nhiều lần. Thử lại sau ${Math.ceil(limit.retryAfterMs / 60000)} phút.`,
    });
    return;
  }

  const username = String(req.body?.username ?? 'admin').trim();
  const password = req.body?.password;
  const user = db.getUserByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng.', remaining: limit.remaining });
    return;
  }
  if (user.disabled) {
    res.status(403).json({ error: 'Tài khoản đã bị khoá. Liên hệ quản trị viên.' });
    return;
  }

  resetLoginAttempts(ip);
  setSessionCookie(res, createSession(user));
  res.json({ ok: true, username: user.username, role: user.role });
});

api.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* ------------------------------ phần cần đăng nhập ---------------------------- */

api.use(requireAuth);

api.get('/me', (req, res) => {
  const { user } = req.session;
  res.json({
    username: user.username,
    role: user.role,
    expiresAt: req.session.exp,
    telegramLinked: Boolean(user.telegramChatId),
  });
});

api.get('/state', (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;
  res.set('Cache-Control', 'no-store');
  res.json(buildState(device.deviceId, req.session.user));
});

api.get('/history', (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;
  const metric = String(req.query.metric || 'temperature');
  const rangeKey = String(req.query.range || '24h');
  const range = RANGES[rangeKey] ?? RANGES['24h'];
  if (!PARAM_KEYS.includes(metric)) {
    res.status(400).json({ error: `Tham số không hợp lệ: ${metric}` });
    return;
  }
  const to = Date.now();
  const from = to - range.ms;
  const points = db.history(device.deviceId, metric, from, to, range.bucket);
  res.set('Cache-Control', 'no-store');
  res.json({
    metric,
    deviceId: device.deviceId,
    range: RANGES[rangeKey] ? rangeKey : '24h',
    from,
    to,
    bucketMs: range.bucket,
    unit: PARAMS[metric].unit,
    decimals: PARAMS[metric].decimals,
    safeRange: { min: parameterDef(metric, waterSettings(device.deviceId)).min, max: parameterDef(metric, waterSettings(device.deviceId)).max },
    points,
  });
});

api.get('/alerts', (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;
  res.json({ alerts: db.recentAlerts(Number(req.query.limit) || 50, [device.deviceId]) });
});

api.get('/events/pumps', (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;
  res.json({ events: db.recentPumpEvents(Number(req.query.limit) || 50, [device.deviceId]) });
});

/** Danh sách thiết bị của chính mình (admin thấy tất cả, kèm chủ sở hữu). */
api.get('/devices', (req, res) => {
  const { user } = req.session;
  const devices = deviceListFor(user);
  res.json({
    devices: user.role === 'admin'
      ? devices.map((d) => ({ ...d, owner: db.getUserById(d.ownerId)?.username ?? null }))
      : devices,
  });
});

api.get('/devices/:deviceId/settings', (req, res) => {
  const device = resolveDevice(req, res);
  if (device) res.json(getWaterSnapshot(device.deviceId));
});

api.patch('/devices/:deviceId/settings', express.json({ limit: '8kb' }), (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;
  try {
    const water = getWaterSnapshot(device.deviceId);
    const rt = runtimeFor(device.deviceId);
    if (water.busy || ['drain', 'fill'].some(k => rt.pumps[k].on || rt.pumps[k].pending)) return res.status(409).json({ error: 'Dừng chu trình và hai bơm trước khi đổi cấu hình.' });
    const next = validateSettings(req.body, water.settings);
    // Preserve a device's newer NVS revision when restoring an older server backup.
    next.revision = Math.max(next.revision, (rt.settingsRevision ?? 0) + 1);
    db.saveWaterSettings(device.deviceId, next);
    publishWaterConfig(device.deviceId);
    db.logPumpEvent({ deviceId: device.deviceId, pump: 'settings', action: 'update', source: 'user', actor: req.session.sub, note: 'Cập nhật thể tích, tự động và ngưỡng; bản ' + next.revision });
    bus.emit(EVENTS.water, { deviceId: device.deviceId });
    res.json(getWaterSnapshot(device.deviceId));
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

api.post('/devices/:deviceId/water-change', express.json({ limit: '4kb' }), (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;
  try {
    res.json(controlWater(device.deviceId, req.body?.action, { percent: req.body?.percent, confirmLevel: req.body?.confirmLevel, actor: req.session.sub }));
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

api.post('/devices/:deviceId/relays/stop-all', (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;
  try {
    const available = getPumpSnapshot(device.deviceId).pumps.filter((p) => p.available);
    if (!available.length) {
      return res.status(409).json({ error: 'Chưa có kênh relay được firmware xác nhận hỗ trợ.' });
    }
    if (getWaterSnapshot(device.deviceId).supported) controlWater(device.deviceId, 'stop', { actor: req.session.sub });
    for (const p of available) {
      controlPump(device.deviceId, p.key, 'off', {
        actor: req.session.sub,
        source: 'user',
        note: 'Tắt tất cả relay',
      });
    }
    res.json({ ok: true, ...getPumpSnapshot(device.deviceId) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

api.post('/devices/:deviceId/pumps/:pump', express.json({ limit: '4kb' }), (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;
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
    const snapshot = controlPump(device.deviceId, req.params.pump, action, {
      actor: req.session.sub,
      source: 'user',
      seconds,
    });
    res.json({ ok: true, ...snapshot });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/* --------------------------------- Telegram ---------------------------------- */

/** Mã liên kết dùng một lần, hạn 15 phút. */
api.post('/telegram/link', (req, res) => {
  const { user } = req.session;
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const expiresAt = Date.now() + 15 * 60 * 1000;
  db.setLinkCode(user.id, code, expiresAt);
  res.json({
    code,
    expiresAt,
    botUsername: telegramState(user).botUsername,
    enabled: telegramState(user).enabled,
    linked: Boolean(user.telegramChatId),
  });
});

api.post('/telegram/unlink', (req, res) => {
  db.unbindTelegram(req.session.user.id);
  res.json({ ok: true, telegram: telegramState(db.getUserById(req.session.user.id)) });
});

api.post('/telegram/test', async (req, res) => {
  try {
    const user = db.getUserById(req.session.user.id);
    res.json({ ok: true, telegram: await sendTelegramTest(user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ------------------------------- quản trị viên -------------------------------- */

const admin = express.Router();
admin.use(requireAdmin);

admin.get('/users', (req, res) => {
  res.json({
    users: db.listUsers().map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      disabled: u.disabled,
      telegramLinked: Boolean(u.telegramChatId),
      createdAt: u.createdAt,
      devices: db.listDevices(u.id).map((d) => ({ deviceId: d.deviceId, name: d.name })),
    })),
  });
});

admin.post('/users', express.json({ limit: '4kb' }), (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Tên đăng nhập 3–32 ký tự, chỉ chữ, số và . _ -' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự.' });
  }
  if (db.getUserByUsername(username)) {
    return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại.' });
  }
  const user = db.createUser({ username, passwordHash: hashPassword(password), role: 'customer' });
  res.status(201).json({ user: { id: user.id, username: user.username, role: user.role } });
});

admin.patch('/users/:id', express.json({ limit: '4kb' }), (req, res) => {
  const id = parseId(req.params.id);
  const user = id ? db.getUserById(id) : null;
  if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
  if (user.role === 'admin' && (req.body?.disabled === true)) {
    return res.status(400).json({ error: 'Không thể khoá tài khoản quản trị.' });
  }
  if (typeof req.body?.disabled === 'boolean') db.setUserDisabled(id, req.body.disabled);
  if (typeof req.body?.password === 'string' && req.body.password) {
    if (req.body.password.length < 6) {
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự.' });
    }
    db.setUserPassword(id, hashPassword(req.body.password));
  }
  const updated = db.getUserById(id);
  res.json({ user: { id: updated.id, username: updated.username, disabled: updated.disabled } });
});

admin.delete('/users/:id', (req, res) => {
  const id = parseId(req.params.id);
  const user = id ? db.getUserById(id) : null;
  if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Không thể xoá tài khoản quản trị.' });
  try {
    db.deleteUser(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

/** Cấp thiết bị mới: trả deviceId + deviceKey đúng một lần để nạp vào firmware. */
admin.post('/devices', express.json({ limit: '4kb' }), (req, res) => {
  const ownerId = parseId(req.body?.ownerId);
  const owner = ownerId ? db.getUserById(ownerId) : null;
  if (!owner) return res.status(400).json({ error: 'Phải chọn tài khoản chủ sở hữu.' });
  const name = String(req.body?.name ?? '').trim().slice(0, 60) || null;
  const { device, deviceKey } = db.createDevice({ ownerId, name });
  res.status(201).json({ device, deviceKey, owner: owner.username });
});

admin.post('/devices/:deviceId/rotate-key', (req, res) => {
  const device = db.getDevice(req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Không tìm thấy thiết bị.' });
  const { deviceKey } = db.rotateDeviceKey(device.deviceId);
  res.json({ ok: true, deviceId: device.deviceId, deviceKey });
});

admin.patch('/devices/:deviceId', express.json({ limit: '4kb' }), (req, res) => {
  const device = db.getDevice(req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Không tìm thấy thiết bị.' });
  if (req.body?.ownerId !== undefined) {
    const ownerId = parseId(req.body.ownerId);
    if (!ownerId || !db.getUserById(ownerId)) {
      return res.status(400).json({ error: 'Tài khoản chủ sở hữu không hợp lệ.' });
    }
    db.assignDeviceOwner(device.deviceId, ownerId);
  }
  if (typeof req.body?.name === 'string') {
    db.renameDevice(device.deviceId, req.body.name.trim().slice(0, 60));
  }
  res.json({ device: db.getDevice(device.deviceId) });
});

admin.delete('/devices/:deviceId', (req, res) => {
  const device = db.getDevice(req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Không tìm thấy thiết bị.' });
  db.deleteDeviceRow(device.deviceId);
  res.json({ ok: true });
});

api.use('/admin', admin);

/* --------------------------------- SSE stream -------------------------------- */

/**
 * Kênh thời gian thực. Gộp các sự kiện dồn dập trong 300ms thành một lần đẩy
 * trạng thái đầy đủ, để trình duyệt chỉ cần một hàm render duy nhất.
 * Mỗi kết nối chỉ nhận dữ liệu của thiết bị mình đang xem.
 */
api.get('/stream', (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;

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
        // Tra lại phiên mỗi lần đẩy: tài khoản bị khoá thì ngắt luôn kênh.
        const session = readSession(req);
        if (!session) {
          res.end();
          return;
        }
        const stillAllowed = db
          .devicesForUser(session.user)
          .some((d) => d.deviceId === device.deviceId);
        if (!stillAllowed) {
          res.end();
          return;
        }
        send('state', buildState(device.deviceId, session.user));
      } catch (err) {
        console.error('[sse] Lỗi gửi trạng thái:', err.message);
      }
    }, 300);
  };

  send('state', buildState(device.deviceId, req.session.user));

  const onUpdate = (payload) => {
    // Bỏ qua sự kiện của thiết bị khác cho nhẹ băng thông.
    if (payload?.deviceId && payload.deviceId !== device.deviceId) return;
    schedule();
  };
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
