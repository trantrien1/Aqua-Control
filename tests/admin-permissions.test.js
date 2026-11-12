import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('admin can only create customers; readings, credentials, SSE, control and takeover routes are denied', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-admin-scope-'));
  Object.assign(process.env, { DB_PATH: path.join(dir, 'test.db'), TELEGRAM_BOT_TOKEN: '' });
  const db = await import('../server/db.js');
  const { hashPassword } = await import('../server/users.js');
  const administrator = db.createUser({ username: 'admin', passwordHash: hashPassword('test-password'), role: 'admin' });
  const customer = db.createUser({ username: 'customer', passwordHash: hashPassword('test-password'), role: 'customer' });
  const created = db.createDevice({ ownerId: customer.id, name: 'Private customer tank' });
  const adminDevice = db.createDevice({ ownerId: administrator.id, name: 'Legacy admin-owned tank' });
  db.insertReading(created.deviceId, { ph: 7.23, temperature: 26, tds: 220 });
  assert.deepEqual(db.devicesForUser(administrator), []);
  db.closeDb();
  const port = await freePort(), mqttPort = await freePort();
  let logs = '';
  const server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], { windowsHide: true, env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), MQTT_PORT: String(mqttPort),
    SESSION_SECRET: 'admin-permissions-test', TELEGRAM_BOT_TOKEN: '', MQTT_SERVER_USERNAME: 'admin-scope-test', MQTT_SERVER_PASSWORD: 'test-only',
  } });
  server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
  t.after(async () => { if (server.exitCode == null) { const done = once(server, 'exit'); server.kill(); await done; } fs.rmSync(dir, { recursive: true, force: true }); });
  const request = (route, cookie = '', method = 'GET', body) => fetch(`http://127.0.0.1:${port}${route}`, { method, redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await request('/api/health')).ok) { ready = true; break; } } catch {}
    await sleep(40);
  }
  assert.ok(ready, logs);
  async function login(username, password = 'test-password') {
    const response = await request('/api/login', '', 'POST', { username, password });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const adminCookie = await login('admin');
  const customerCookie = await login('customer');
  const redirect = await request('/', adminCookie);
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), '/admin');
  const adminPage = await (await request('/admin', adminCookie)).text();
  assert.ok(adminPage.includes('admin-create-user'));
  assert.ok(!adminPage.includes('metric-grid') && !adminPage.includes('device-select'));
  assert.equal((await request('/admin', customerCookie)).headers.get('location'), '/');
  const id = created.deviceId;
  for (const route of [
    '/api/state', `/api/state?device=${id}`, `/api/state?device=${adminDevice.deviceId}`,
    '/api/devices', '/api/history?metric=ph', '/api/alerts', '/api/events/pumps',
    `/api/devices/${id}/settings`, `/api/stream?device=${id}`, '/api/admin/users',
  ]) assert.equal((await request(route, adminCookie)).status, 403, route);
  for (const [route, method, body] of [
    [`/api/devices/${id}/pumps/drain`, 'POST', { action: 'on', seconds: 3 }],
    [`/api/devices/${id}/water-change`, 'POST', { action: 'start', percent: 20 }],
    [`/api/devices/${id}/settings`, 'PATCH', {}], [`/api/devices/${id}/relays/stop-all`, 'POST', {}],
    ['/api/devices', 'POST', { name: 'Should not be created' }],
    [`/api/admin/users/${customer.id}`, 'PATCH', { password: 'hijacked-password', disabled: true }],
    [`/api/admin/users/${customer.id}`, 'DELETE', {}],
    ['/api/admin/devices', 'POST', { ownerId: administrator.id, name: 'Forbidden' }],
    [`/api/admin/devices/${id}`, 'PATCH', { ownerId: administrator.id }],
    [`/api/admin/devices/${id}/rotate-key`, 'POST', {}], [`/api/admin/devices/${id}`, 'DELETE', {}],
    ['/api/telegram/link', 'POST', {}],
  ]) assert.equal((await request(route, adminCookie, method, body)).status, 403, method + ' ' + route);
  // Customer data and credentials remain intact after all denied takeover attempts.
  await login('customer');
  const ownState = await (await request(`/api/state?device=${id}`, customerCookie)).json();
  assert.equal(ownState.reading.ph, 7.23);
  assert.ok(ownState.devices.every(d => d.ownerId === customer.id));
  const create = await request('/api/admin/users', adminCookie, 'POST', { username: 'new-customer', password: 'new-password', role: 'admin' });
  assert.equal(create.status, 201);
  const newUser = (await create.json()).user;
  assert.equal(newUser.role, 'customer');
  assert.equal((await request('/api/admin/users', adminCookie, 'POST', { username: 'new-customer', password: 'new-password' })).status, 409);
  assert.equal((await request('/api/admin/users', customerCookie, 'POST', { username: 'forbidden', password: 'password' })).status, 403);
  const newCookie = await login('new-customer', 'new-password');
  assert.equal((await request('/api/devices', '', 'POST', { name: 'Anonymous' })).status, 401);
  const ownDevice = await request('/api/devices', newCookie, 'POST', { name: 'My new tank', ownerId: customer.id });
  assert.equal(ownDevice.status, 201);
  const own = await ownDevice.json();
  assert.equal(own.device.ownerId, newUser.id); assert.ok(own.deviceKey.length >= 24);
  assert.equal((await request(`/api/state?device=${id}`, newCookie)).status, 404);
  assert.equal((await request(`/api/state?device=${own.device.deviceId}`, customerCookie)).status, 404);
  assert.equal((await request(`/api/state?device=${own.device.deviceId}`, newCookie)).status, 200);
});
