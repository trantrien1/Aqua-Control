import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import mqtt from 'mqtt';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise(r => server.close(r));
  return port;
}

test('water v3: settings ownership, sync, flow, ACK, cancellation, simulator and persistence', { timeout: 35000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-water-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.TELEGRAM_BOT_TOKEN = '';
  const db = await import('../server/db.js');
  const { hashPassword } = await import('../server/users.js');
  const alice = db.createUser({ username: 'alice', passwordHash: hashPassword('test-password') });
  const bob = db.createUser({ username: 'bob', passwordHash: hashPassword('test-password') });
  db.createDevice({ ownerId: bob.id, name: 'Bể Bob' });
  const created = db.createDevice({ ownerId: alice.id, name: 'Bể test nước' });
  db.closeDb();
  const id = created.deviceId;
  const port = await freePort(), mqttPort = await freePort();
  const env = { ...process.env, PORT: String(port), MQTT_PORT: String(mqttPort), HOST: '127.0.0.1', TELEGRAM_BOT_TOKEN: '', SESSION_SECRET: 'test-water-only', MQTT_SERVER_USERNAME: 'water-test-server', MQTT_SERVER_PASSWORD: 'test-only', COMMAND_ACK_TIMEOUT_MS: '1000' };
  let server, device, simulator, cookie, logs = '';
  function launch() {
    server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], { env, windowsHide: true });
    server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
  }
  async function stop(child) { if (child && child.exitCode == null) { const done = once(child, 'exit'); child.kill(); await done; } }
  t.after(async () => { if (device) await device.endAsync(true); await stop(simulator); await stop(server); fs.rmSync(dir, { recursive: true, force: true }); });
  async function waitFor(fn) {
    const end = Date.now() + 6000;
    while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch {} await sleep(25); }
    throw new Error('Timeout: ' + logs);
  }
  const request = (route, method = 'GET', body, session = cookie) => fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Cookie: session || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  async function login(username) { const r = await request('/api/login', 'POST', { username, password: 'test-password' }); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0]; }
  const state = async () => (await request(`/api/state?device=${id}`)).json();
  const settingsRoute = `/api/devices/${id}/settings`;
  const waterRoute = `/api/devices/${id}/water-change`;
  launch();
  await waitFor(async () => (await (await request('/api/health')).json()).brokerConnected);
  cookie = await login('alice');
  let s = await state();
  assert.equal(s.water.settings.autoEnabled, false);
  assert.equal(s.water.settings.tankLiters, null);
  const bobCookie = await login('bob');
  // Another owner's ID must not leak data or accept commands.
  const bobDevice = await request('/api/admin/devices', 'POST', {}, bobCookie);
  assert.equal(bobDevice.status, 403);
  const forbidden = await request(settingsRoute, 'GET', undefined, bobCookie);
  assert.equal(forbidden.status, 404);
  assert.equal((await request(settingsRoute, 'PATCH', {}, bobCookie)).status, 404);
  assert.equal((await request(waterRoute, 'POST', { action: 'start', percent: 20 }, bobCookie)).status, 404);
  assert.equal((await request(settingsRoute, 'GET', undefined, '')).status, 401);
  device = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`, { username: id, password: created.deviceKey });
  await once(device, 'connect');
  await device.subscribeAsync([`aquarium/${id}/cmd`, `aquarium/${id}/config`]);
  const messages = [];
  device.on('message', (topic, bytes) => messages.push({ topic, ...JSON.parse(bytes) }));
  const caps = { pumps: true, relay_keys: ['drain', 'fill', 'light'], water_change: true, water_recovery: true, turbidity_percent: true, turbidity_voltage: true };
  let report = { capabilities: caps, settings_revision: 0, water_change: { stage: 'idle', attempts: 0 }, pumps: { drain: false, fill: false, light: false } };
  const publish = async (suffix, body) => { await device.publishAsync(`aquarium/${id}/${suffix}`, JSON.stringify(body), { qos: 1 }); await sleep(40); };
  await publish('telemetry', { ...report, temperature: 26, ph: 7.35, tds: 225, turbidity_percent: 45, sensor_status: { ph_estimated: true, ph_calibrated: false } });
  await waitFor(async () => (await state()).device.online);
  assert.equal((await request(waterRoute, 'POST', { action: 'start', percent: 20 })).status, 409);
  const original = (await state()).water.settings;
  assert.equal((await request(settingsRoute, 'PATCH', { ...original, tankLiters: -1 })).status, 400);
  const badRanges = structuredClone(original.thresholds); badRanges.ph.min = 10;
  assert.equal((await request(settingsRoute, 'PATCH', { ...original, tankLiters: 60, thresholds: badRanges })).status, 400);
  const thresholds = structuredClone(original.thresholds); thresholds.ph.max = 7.3;
  const config = { ...original, tankLiters: 60, thresholds };
  let response = await request(settingsRoute, 'PATCH', config);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).synced, false);
  assert.equal((await request(settingsRoute, 'PATCH', config)).status, 409); // Stale revision.
  assert.equal((await request(waterRoute, 'POST', { action: 'start', percent: 25 })).status, 409);
  await waitFor(() => messages.find(m => m.topic.endsWith('/config') && m.revision === 1));
  report.settings_revision = 1;
  await publish('telemetry', { ...report, temperature: 26, ph: 7.35, tds: 225, turbidity_percent: 45 });
  s = await state();
  assert.equal(s.water.synced, true);
  assert.equal(s.params.find(p => p.key === 'turbidity_percent').unit, '%');
  assert.equal(s.params.find(p => p.key === 'ph').status, 'warn');
  assert.ok(s.issues.some(i => i.param === 'turbidity_percent'));
  const history = await (await request(`/api/history?device=${id}&metric=turbidity_percent&range=1h`)).json();
  assert.ok(history.points.some(p => p.avg === 45));
  response = await request(waterRoute, 'POST', { action: 'start', percent: 25 });
  assert.equal(response.status, 200);
  const pending = await response.json();
  assert.equal(pending.estimate.liters, 15);
  assert.equal(pending.estimate.phaseSeconds, 562.5);
  assert.equal((await request(waterRoute, 'POST', { action: 'start', percent: 25 })).status, 409);
  assert.equal((await request(settingsRoute, 'PATCH', { ...config, revision: 1 })).status, 409);
  await publish('ack', { ...report, id: pending.pending.id, type: 'water_change', ok: true, water_change: { stage: 'draining', percent: 25, remaining_ms: 562500 }, pumps: { drain: true, fill: false, light: false } });
  assert.equal((await state()).water.stage, 'draining');
  assert.equal((await request(`/api/devices/${id}/pumps/fill`, 'POST', { action: 'on', seconds: 3 })).status, 409);
  response = await request(waterRoute, 'POST', { action: 'stop' });
  const stopped = await response.json();
  await publish('ack', { ...report, id: stopped.pending.id, type: 'water_change', ok: true, water_change: { stage: 'error', reason: 'cancelled-check-level' } });
  assert.equal((await request(waterRoute, 'POST', { action: 'reset' })).status, 409);
  response = await request(waterRoute, 'POST', { action: 'reset', confirmLevel: true });
  const reset = await response.json();
  await publish('ack', { ...report, id: reset.pending.id, type: 'water_change', ok: true });
  await device.endAsync(true); device = null;
  // Run the actual simulator quickly, without altering production timing.
  response = await request(settingsRoute, 'PATCH', { ...config, revision: 1, tankLiters: 1 });
  assert.equal(response.status, 200);
  simulator = spawn(process.execPath, ['tools/simulate-device.js', '--device', id, '--key', created.deviceKey, '--url', `mqtt://127.0.0.1:${mqttPort}`, '--time-scale', '0.02', '--interval', '0.05'], { env, windowsHide: true, stdio: 'ignore' });
  await waitFor(async () => (await state()).water.synced);
  response = await request(waterRoute, 'POST', { action: 'start', percent: 25 });
  assert.equal(response.status, 200);
  await waitFor(async () => (await state()).water.stage === 'draining');
  await waitFor(async () => (await state()).water.stage === 'filling');
  await waitFor(async () => (await state()).water.stage === 'settling');
  await waitFor(async () => (await state()).water.stage === 'idle');
  s = await state(); assert.ok(s.pumps.every(p => !p.on));
  await stop(simulator); simulator = null;
  await stop(server); launch();
  await waitFor(async () => (await (await request('/api/health')).json()).brokerConnected);
  cookie = await login('alice');
  s = await state();
  assert.equal(s.water.settings.tankLiters, 1);
  assert.equal(s.water.settings.thresholds.ph.max, 7.3);
  assert.equal(s.water.settings.revision, 2);
  assert.equal(s.water.synced, false);
  assert.equal(s.device.online, false);
  // A real ESP32 can retain revision 6 while a fresh/restored server has revision 2.
  device = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`, { username: id, password: created.deviceKey });
  await once(device, 'connect');
  await publish('state', { ...report, settings_revision: 6 });
  s = await state();
  assert.equal(s.water.settingsIssue, 'device-newer');
  await publish('ack', { type: 'config', ok: false, reason: 'server-revision-older', settings_revision: 6 });
  assert.equal((await state()).water.settingsError, 'server-revision-older');
  response = await request(settingsRoute, 'PATCH', { ...s.water.settings, tankLiters: 60 });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).settings.revision, 7);
  await publish('ack', { type: 'config', ok: true, settings_revision: 7 });
  assert.equal((await state()).water.synced, true);
  assert.equal((await state()).water.settingsError, null);
});
