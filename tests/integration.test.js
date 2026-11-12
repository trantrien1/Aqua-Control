import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import mqtt from 'mqtt';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('water firmware protocol → MQTT → SQLite → REST/SSE, migration and relay gating', { timeout: 45000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-integration-'));
  const dbPath = path.join(dir, 'test.db');
  // Start with the old schema and an NTU record; migration must preserve it.
  const oldDb = new DatabaseSync(dbPath);
  oldDb.exec(`CREATE TABLE readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, ts INTEGER NOT NULL,
    received_at INTEGER NOT NULL, temperature REAL, ph REAL, tds REAL,
    turbidity REAL, water_level REAL
  )`);
  oldDb.prepare('INSERT INTO readings (device_id, ts, received_at, turbidity) VALUES (?, ?, ?, ?)')
    .run('legacy-device', Date.now() - 1000, Date.now() - 1000, 14);
  oldDb.close();

  // Cấp tài khoản + thiết bị trước khi khởi động server, dùng chính module db
  // để migration chạy trên lược đồ cũ vừa tạo.
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.DB_PATH = dbPath;
  process.env.SESSION_SECRET = 'integration-test-only';
  const db = await import('../server/db.js');
  const { hashPassword } = await import('../server/users.js');
  const owner = db.createUser({ username: 'chu-be', passwordHash: hashPassword('test-password'), role: 'customer' });
  const created = db.createDevice({ ownerId: owner.id, name: 'Bể kiểm thử' });
  const deviceId = created.deviceId;
  const deviceKey = created.deviceKey;
  // Gắn bản ghi cũ vào thiết bị thật để kiểm tra dữ liệu cũ còn nguyên.
  db.db
    .prepare('UPDATE readings SET device_id = ? WHERE device_id = ?')
    .run(deviceId, 'legacy-device');
  db.closeDb();

  const port = await freePort();
  const mqttPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  let device;
  let output = '';
  let cookie = '';
  const env = {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), MQTT_PORT: String(mqttPort),
    TELEGRAM_BOT_TOKEN: '', DB_PATH: dbPath, SESSION_SECRET: 'integration-test-only', ADMIN_PASSWORD: 'test-password',
    MQTT_TOPIC_PREFIX: 'aquarium', EMBEDDED_BROKER: 'true',
    MQTT_SERVER_USERNAME: 'integration-server', MQTT_SERVER_PASSWORD: 'integration-server-pass',
    COMMAND_ACK_TIMEOUT_MS: '700',
  };
  const launch = () => {
    child = spawn(process.execPath, ['--no-warnings', 'server/index.js'], { env, windowsHide: true });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
  };
  const stop = async () => {
    if (!child || child.exitCode != null) return;
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
  };
  t.after(async () => {
    if (device) await device.endAsync(true);
    await stop();
    // The directory is created by this test under the OS temp directory.
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function request(url, options = {}) {
    return fetch(`${base}${url}`, { ...options, headers: { Cookie: cookie, ...options.headers } });
  }
  async function waitFor(check) {
    for (let i = 0; i < 100; i++) {
      try { const value = await check(); if (value) return value; } catch { /* starting */ }
      await sleep(80);
    }
    throw new Error(`Condition timed out. Server log:\n${output}`);
  }
  async function login() {
    const response = await request('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'chu-be', password: 'test-password' }),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
  }
  const snapshot = async () => (await request('/api/state')).json();
  const topic = (suffix) => `aquarium/${deviceId}/${suffix}`;
  const publish = (kind, value) => device.publishAsync(topic(kind), JSON.stringify(value), { qos: 1 });
  const connectDevice = () =>
    mqtt.connectAsync(`mqtt://127.0.0.1:${mqttPort}`, {
      clientId: `integration-${deviceId}`, username: deviceId, password: deviceKey, reconnectPeriod: 0,
    });
  launch();
  await waitFor(async () => (await (await request('/api/health')).json()).brokerConnected);
  await login();
  device = await connectDevice();
  const caps = { pumps: false, water_level: false, turbidity_voltage: true };
  const payload = {
    temperature: 26.25, ph: null, tds: 225, turbidity: null, turbidity_voltage: 4.08,
    water_level: null, firmware: '2.0.0-water', capabilities: caps,
    sensor_status: { ph_calibrated: false, tds_estimated: true, tds_temperature_fallback: false, turbidity_adc_voltage: 2.04 },
    pumps: { drain: false, fill: false },
  };
  await waitFor(async () => {
    await publish('telemetry', payload);
    const s = await snapshot();
    return s.reading?.turbidity_voltage === 4.08 && s;
  });
  let state = await snapshot();
  assert.equal(state.reading.ph, null);
  assert.equal(state.reading.turbidity, null);
  assert.equal(state.reading.water_level, null);
  assert.equal(state.params.length, 4);
  assert.equal(state.params.find((p) => p.key === 'ph').statusText, 'Chưa hiệu chuẩn');
  assert.equal(state.params.find((p) => p.key === 'turbidity_voltage').unit, 'V');
  assert.equal(state.params.find((p) => p.key === 'turbidity_voltage').status, 'unrated');
  assert.equal(state.issues.length, 0);
  assert.equal(state.suggestions.length, 0);
  assert.ok(state.pumps.every((p) => p.available === false));
  assert.equal((await request(`/api/devices/${deviceId}/pumps/drain`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"on"}',
  })).status, 409);

  const volts = await (await request('/api/history?metric=turbidity_voltage&range=1h')).json();
  assert.equal(volts.unit, 'V');
  assert.ok(volts.points.length > 0);
  assert.ok(volts.points.every((p) => Math.abs(p.avg - 4.08) < 0.0001));
  const ntu = await (await request('/api/history?metric=turbidity&range=1h')).json();
  assert.equal(ntu.points.length, 1);
  assert.equal(ntu.points[0].avg, 14);

  // Verify a live SSE update rather than only the initial snapshot.
  const abort = new AbortController();
  const stream = await request('/api/stream', { signal: abort.signal });
  const reader = stream.body.getReader();
  let streamText = '';
  try {
    const next = { ...payload, ph: 9.2, sensor_status: { ...payload.sensor_status, ph_calibrated: true } };
    await publish('telemetry', next);
    const deadline = AbortSignal.timeout(5000);
    while (!streamText.includes('"ph":9.2')) {
      const part = await Promise.race([
        reader.read(),
        new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error('SSE update timed out')), { once: true })),
      ]);
      streamText += new TextDecoder().decode(part.value);
    }
    assert.match(streamText, /event: state/);
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
  state = await snapshot();
  assert.ok(state.issues.some((i) => i.param === 'ph' && i.level === 'critical'));
  assert.ok(!state.issues.some((i) => i.param === 'turbidity_voltage'));

  // Thiết bị khác không thể ghi đè số đo hay mở khoá relay của bể này:
  // broker chặn ngay ở tầng xác thực và đóng kết nối của client vi phạm.
  // QoS 0 vì broker cắt kết nối trước khi kịp trả PUBACK, QoS 1 sẽ treo.
  await device.publishAsync(`aquarium/other-device/telemetry`, JSON.stringify({ ph: 1, capabilities: { pumps: true } }), { qos: 0 });
  await sleep(200);
  assert.equal((await snapshot()).reading.ph, 9.2);
  assert.equal((await snapshot()).device.capabilities.pumps, false);
  // Broker đã ngắt kết nối của client vi phạm nên phải nối lại mới publish tiếp được.
  await device.endAsync(true);
  device = await connectDevice();

  await publish('telemetry', { ...payload, temperature: null, ph: '', tds: false, turbidity_voltage: 0,
    sensor_status: { ...payload.sensor_status, tds_temperature_fallback: true } });
  await waitFor(async () => (await snapshot()).reading.temperature === null);
  state = await snapshot();
  assert.equal(state.reading.ph, null);
  assert.equal(state.reading.tds, null);
  assert.equal(state.reading.turbidity_voltage, 0);

  await device.endAsync(true);
  device = null;
  await stop();
  launch();
  await waitFor(async () => (await (await request('/api/health')).json()).brokerConnected);
  await login();
  state = await snapshot();
  assert.equal(state.reading.ph, null);
  assert.equal(state.reading.turbidity_voltage, 0);
  assert.equal(state.reading.sensor_status.ph_calibrated, false);
  assert.equal(state.params.find((p) => p.key === 'turbidity_voltage').unit, 'V');

  // Old firmware cannot silently map its drain channel onto the new light.
  device = await connectDevice();
  await device.subscribeAsync(topic('cmd'));
  const commands = [];
  device.on('message', (name, bytes) => { if (name === topic('cmd')) commands.push(JSON.parse(bytes)); });
  const command = async (pump, action, seconds) => request(`/api/devices/${deviceId}/pumps/${pump}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, seconds }),
  });
  await publish('telemetry', { temperature: 25, ph: 7.2, tds: 220, turbidity: 12, water_level: 70,
    capabilities: { pumps: true, water_level: true, turbidity_voltage: false } });
  await waitFor(async () => (await snapshot()).device.capabilities.pumps);
  state = await snapshot();
  assert.ok(state.params.some((p) => p.key === 'turbidity' && p.unit === 'NTU'));
  assert.equal((await command('light', 'on', 3)).status, 409);
  assert.equal((await command('ph_up', 'on', 3)).status, 400);

  const relayCaps = { pumps: true, relay_keys: ['drain', 'fill', 'light'],
    water_level: false, turbidity_voltage: true };
  let reported = { drain: false, fill: false, light: false };
  await publish('telemetry', { ...payload, capabilities: relayCaps, pumps: reported });
  await waitFor(async () => (await snapshot()).pumps.every((p) => p.available && p.confirmed));
  state = await snapshot();
  assert.deepEqual(state.pumps.map((p) => [p.key, p.gpio, p.maxRunSeconds]), [
    ['drain', 18, 3600], ['fill', 19, 3600], ['light', 21, 3600],
  ]);
  assert.equal(state.params.length, 4);

  // Commands stay pending until reported; unrelated/opposite telemetry is not an ACK.
  let response = await command('drain', 'on');
  assert.equal(response.status, 200);
  let sent = (await response.json()).pumps.find((p) => p.key === 'drain');
  assert.equal(sent.on, false);
  assert.equal(sent.pending, true);
  await waitFor(() => commands.some((c) => c.id === sent.commandId));
  assert.equal(commands.find((c) => c.id === sent.commandId).duration, 3);
  await publish('state', { pumps: reported });
  assert.equal((await snapshot()).pumps.find((p) => p.key === 'drain').pending, true);
  await publish('ack', { id: 'obsolete-command', pump: 'drain', ok: true, action: 'on', pumps: { ...reported, drain: true } });
  assert.equal((await snapshot()).pumps.find((p) => p.key === 'drain').on, false);
  reported.drain = true;
  await publish('ack', { id: sent.commandId, pump: 'drain', ok: true, action: 'on', pumps: reported });
  await waitFor(async () => (await snapshot()).pumps.find((p) => p.key === 'drain').on);

  // Light is independent; durations clamp per channel.
  response = await command('light', 'on', 7200);
  assert.equal(response.status, 200);
  const lightId = (await response.json()).pumps.find((p) => p.key === 'light').commandId;
  await waitFor(() => commands.some((c) => c.id === lightId));
  assert.equal(commands.find((c) => c.id === lightId).duration, 3600);
  reported.light = true;
  await publish('ack', { id: lightId, pump: 'light', ok: true, action: 'on', pumps: reported });
  state = await waitFor(async () => { const s = await snapshot(); return s.pumps.find((p) => p.key === 'light').on && s; });
  assert.equal(state.pumps.find((p) => p.key === 'drain').on, true);

  response = await command('fill', 'on', 500);
  assert.equal(response.status, 200);
  const downId = (await response.json()).pumps.find((p) => p.key === 'fill').commandId;
  await waitFor(() => commands.some((c) => c.id === downId));
  const downIndex = commands.findIndex((c) => c.id === downId);
  assert.equal(commands[downIndex].duration, 500);
  assert.equal(commands[downIndex - 1].pump, 'drain');
  assert.equal(commands[downIndex - 1].action, 'off');
  reported = { drain: false, fill: true, light: true };
  await publish('ack', { id: downId, pump: 'fill', ok: true, action: 'on', pumps: reported });
  await waitFor(async () => (await snapshot()).pumps.find((p) => p.key === 'fill').on);

  // OFF rejection must preserve the device's actual ON state.
  response = await command('light', 'off');
  const offId = (await response.json()).pumps.find((p) => p.key === 'light').commandId;
  await publish('ack', { id: offId, pump: 'light', ok: false, reason: 'test-rejection', pumps: reported });
  state = await waitFor(async () => { const s = await snapshot(); return s.pumps.find((p) => p.key === 'light').error && s; });
  assert.equal(state.pumps.find((p) => p.key === 'light').on, true);

  // Missing ACK becomes unknown instead of displaying false success.
  response = await command('light', 'off');
  assert.equal(response.status, 200);
  state = await waitFor(async () => { const s = await snapshot(); return s.pumps.find((p) => p.key === 'light').error && !s.pumps.find((p) => p.key === 'light').pending && s; });
  assert.equal(state.pumps.find((p) => p.key === 'light').confirmed, false);

  // State from a local Serial test includes its own countdown.
  reported = { drain: false, fill: false, light: true };
  await publish('state', { capabilities: relayCaps, pumps: reported,
    relay_timers: { light: { remaining_ms: 2750, source: 'serial' } },
  });
  state = await waitFor(async () => { const s = await snapshot(); return s.pumps.find((p) => p.key === 'light').source === 'serial' && s; });
  assert.ok(state.pumps.find((p) => p.key === 'light').remainingSeconds <= 3);
  response = await request(`/api/devices/${deviceId}/relays/stop-all`, { method: 'POST' });
  assert.equal(response.status, 200);
  await waitFor(() => commands.slice(-3).every((c) => c.action === 'off') && new Set(commands.slice(-3).map((c) => c.pump)).size === 3);
  reported = { drain: false, fill: false, light: false };
  await publish('state', { pumps: reported });
  await waitFor(async () => (await snapshot()).pumps.every((p) => !p.pending));
  await device.publishAsync(topic('status'), 'offline', { qos: 1 });
  await waitFor(async () => !(await snapshot()).device.online);
  assert.ok((await snapshot()).pumps.every((p) => !p.confirmed));
  assert.equal((await command('drain', 'on', 3)).status, 409);

  // A retained online/state snapshot after a restart is not proof of liveness.
  await device.publishAsync(topic('status'), 'online', { qos: 1, retain: true });
  await device.publishAsync(topic('state'), JSON.stringify({ capabilities: relayCaps, pumps: reported }), { qos: 1, retain: true });
  await stop();
  launch();
  await waitFor(async () => (await (await request('/api/health')).json()).brokerConnected);
  await login();
  await sleep(150);
  assert.equal((await snapshot()).device.online, false);
  assert.equal((await command('light', 'on', 3)).status, 409);
  await device.endAsync(true);
  device = null;

  // Exercise the real simulator: light + pump, interlock, 3s auto-off, stop all.
  const simulator = spawn(process.execPath, [
    'tools/simulate-device.js', '--scenario', 'relay-test', '--interval', '1',
    '--url', `mqtt://127.0.0.1:${mqttPort}`, '--device', deviceId, '--key', deviceKey,
  ], { env, windowsHide: true, stdio: 'ignore' });
  t.after(async () => { if (simulator.exitCode == null) { const stopped = once(simulator, 'exit'); simulator.kill(); await stopped; } });
  await waitFor(async () => (await snapshot()).device.firmware === 'simulator-3.0-water');
  const initialWater = (await snapshot()).water;
  const saved = await request('/api/devices/' + deviceId + '/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...initialWater.settings, tankLiters: 60 }),
  });
  assert.equal(saved.status, 200);
  await waitFor(async () => (await snapshot()).water.synced);
  assert.equal((await command('drain', 'on', 30)).status, 200);
  await waitFor(async () => (await snapshot()).pumps.find((p) => p.key === 'drain').on);
  assert.equal((await command('light', 'on', 3)).status, 200);
  await waitFor(async () => (await snapshot()).pumps.find((p) => p.key === 'light').on);
  assert.equal((await command('fill', 'on', 30)).status, 200);
  state = await waitFor(async () => { const s = await snapshot(); return s.pumps.find((p) => p.key === 'fill').on && !s.pumps.find((p) => p.key === 'drain').on && s; });
  assert.equal(state.pumps.find((p) => p.key === 'light').on, true);
  await waitFor(async () => !(await snapshot()).pumps.find((p) => p.key === 'light').on);
  assert.equal((await snapshot()).pumps.find((p) => p.key === 'fill').on, true);
  assert.equal((await request(`/api/devices/${deviceId}/relays/stop-all`, { method: 'POST' })).status, 200);
  await waitFor(async () => (await snapshot()).pumps.every((p) => !p.on && !p.pending));
});
