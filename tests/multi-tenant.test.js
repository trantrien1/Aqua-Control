/**
 * Kiểm thử đa khách hàng, chạy trực tiếp: `node --no-warnings tests/multi-tenant.test.js`
 *
 * Không dùng `node --test` vì sandbox của máy này chặn spawn tiến trình con.
 * Bài kiểm tra khởi động broker thật trên cổng riêng và dùng DB tạm, nên không
 * đụng tới dữ liệu thật của người dùng.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-mt-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.PORT = '0';
process.env.MQTT_PORT = '18830';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.MQTT_SERVER_USERNAME = 'test-server';
process.env.MQTT_SERVER_PASSWORD = 'test-server-pass';

const db = await import('../server/db.js');
const users = await import('../server/users.js');
const broker = await import('../server/broker.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
  }
}

/* --------------------------- mật khẩu và phiên --------------------------- */

const hash = users.hashPassword('matkhau123');
check('băm mật khẩu không lộ mật khẩu gốc', () => {
  assert.ok(!hash.includes('matkhau123'));
  assert.match(hash, /^scrypt\$/);
});
check('đúng mật khẩu thì qua', () => assert.equal(users.verifyPassword('matkhau123', hash), true));
check('sai mật khẩu thì trượt', () => assert.equal(users.verifyPassword('sai', hash), false));
check('hash hỏng không làm sập', () => assert.equal(users.verifyPassword('x', 'rac'), false));

const { createSession, verifySession, safeEqual } = await import('../server/auth.js');
const alice = db.createUser({ username: 'alice', passwordHash: hash, role: 'customer' });
const bob = db.createUser({ username: 'bob', passwordHash: users.hashPassword('bob12345'), role: 'customer' });

check('phiên giữ đúng uid và vai trò', () => {
  const token = createSession(alice);
  const payload = verifySession(token);
  assert.equal(payload.uid, alice.id);
  assert.equal(payload.role, 'customer');
});
check('token bị sửa thì vô hiệu', () => {
  const token = createSession(alice);
  const [body, sig] = token.split('.');
  const forged = `${Buffer.from(JSON.stringify({ uid: bob.id, sub: 'bob', role: 'admin', exp: Date.now() + 9e6 })).toString('base64url')}.${sig}`;
  assert.equal(verifySession(forged), null);
  assert.notEqual(forged, token);
  assert.ok(body);
});
check('cookie của tài khoản đã xoá thì mất hiệu lực', () => {
  const token = createSession(bob);
  db.deleteUser(bob.id);
  assert.equal(db.getUserById(bob.id), null);
  assert.ok(verifySession(token));
});
check('safeEqual so sánh đúng', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

const bob2 = db.createUser({ username: 'bob', passwordHash: users.hashPassword('bob12345'), role: 'customer' });

/* ------------------------------ thiết bị ------------------------------ */

const created = db.createDevice({ ownerId: alice.id, name: 'Bể phòng khách' });
check('cấp thiết bị trả mã và khoá', () => {
  assert.match(created.deviceId, /^esp32-[0-9a-f]{6}$/);
  assert.ok(created.deviceKey.length >= 30);
  assert.equal(created.device.ownerId, alice.id);
  assert.equal(created.device.name, 'Bể phòng khách');
});
check('DB không lưu khoá dạng thô', () => {
  const row = db.db.prepare('SELECT key_hash FROM devices WHERE device_id = ?').get(created.deviceId);
  assert.notEqual(row.key_hash, created.deviceKey);
  assert.match(row.key_hash, /^[0-9a-f]{64}$/);
});
check('khoá đúng thì xác thực được', () => {
  const device = db.verifyDeviceCredentials(created.deviceId, created.deviceKey);
  assert.equal(device?.deviceId, created.deviceId);
});
check('khoá sai thì bị từ chối', () => {
  assert.equal(db.verifyDeviceCredentials(created.deviceId, 'sai-khoa'), null);
  assert.equal(db.verifyDeviceCredentials('esp32-khac', created.deviceKey), null);
});
check('đổi khoá thì khoá cũ hết dùng được', () => {
  const { deviceKey } = db.rotateDeviceKey(created.deviceId);
  assert.equal(db.verifyDeviceCredentials(created.deviceId, created.deviceKey), null);
  assert.ok(db.verifyDeviceCredentials(created.deviceId, deviceKey));
  created.deviceKey = deviceKey;
});

const carol = db.createUser({ username: 'carol', passwordHash: hash, role: 'customer' });
const other = db.createDevice({ ownerId: carol.id, name: 'Bể văn phòng' });

check('mỗi người chỉ thấy thiết bị của mình', () => {
  const mine = db.devicesForUser(alice).map((d) => d.deviceId);
  const theirs = db.devicesForUser(carol).map((d) => d.deviceId);
  assert.deepEqual(mine, [created.deviceId]);
  assert.deepEqual(theirs, [other.deviceId]);
  assert.equal(db.devicesForUser({ role: 'admin', id: alice.id }).length, 0);
});
check('số đo và nhật ký tách theo thiết bị', () => {
  db.insertReading(created.deviceId, { ph: 7.1, temperature: 25.5, ts: 1_000_000 });
  db.insertReading(other.deviceId, { ph: 6.9, temperature: 26.1, ts: 1_000_001 });
  db.logAlert({ deviceId: created.deviceId, param: 'ph', level: 'warn', value: 6.4, message: 'a', ts: 1 });
  db.logAlert({ deviceId: other.deviceId, param: 'ph', level: 'warn', value: 6.3, message: 'b', ts: 2 });
  assert.equal(db.recentAlerts(10, [created.deviceId]).length, 1);
  assert.equal(db.recentAlerts(10, [created.deviceId])[0].message, 'a');
  assert.equal(db.recentAlerts(10, [other.deviceId])[0].message, 'b');
  assert.equal(db.recentAlerts(10, null).length, 2);
  assert.equal(db.recentAlerts(10, []).length, 0);
});
check('lịch sử tính đúng tham số và khoảng thời gian', () => {
  const points = db.history(created.deviceId, 'ph', 0, 2_000_000, 60_000);
  assert.equal(points.length, 1);
  assert.ok(Math.abs(points[0].avg - 7.1) < 1e-9);
});

/* --------------------------- cooldown cảnh báo --------------------------- */

const { resetCooldown, logNewAlerts } = await import('../server/alerts.js');
check('cooldown tách riêng theo thiết bị', () => {
  resetCooldown();
  const issues = [{ param: 'ph', level: 'critical', value: 9.5, message: 'pH cao', label: 'pH' }];
  assert.equal(logNewAlerts(issues, created.deviceId, 1000).length, 1);
  assert.equal(logNewAlerts(issues, other.deviceId, 1001).length, 1);
  assert.equal(logNewAlerts(issues, created.deviceId, 1002).length, 0);
  assert.equal(logNewAlerts(issues, created.deviceId, 1000 + 181_000).length, 1);
});

/* ---------------------------- lọc cảnh báo bot --------------------------- */
/* Logic báo tin / nhắc lặp / tắt thông báo nằm ở tests/telegram.test.js. */

/* ------------------------- xác thực MQTT qua broker ---------------------- */

await broker.startBroker();

const mqtt = (await import('mqtt')).default;
function connectClient(username, password) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://127.0.0.1:18830`, {
      clientId: `t-${Math.random().toString(16).slice(2, 8)}`,
      username,
      password,
      reconnectPeriod: 0,
      connectTimeout: 4000,
    });
    const timer = setTimeout(() => {
      client.end(true);
      reject(new Error('timeout'));
    }, 6000);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once('error', (err) => {
      clearTimeout(timer);
      client.end(true);
      reject(err);
    });
  });
}

let deviceClient = null;
try {
  deviceClient = await connectClient(created.deviceId, created.deviceKey);
  results.push({ name: 'thiết bị có khoá đúng kết nối được broker', ok: true });
} catch (err) {
  results.push({ name: 'thiết bị có khoá đúng kết nối được broker', ok: false, error: err.message });
}

try {
  await connectClient(created.deviceId, 'khoa-sai');
  results.push({ name: 'thiết bị dùng khoá sai bị chặn', ok: false, error: 'vẫn kết nối được' });
} catch {
  results.push({ name: 'thiết bị dùng khoá sai bị chặn', ok: true });
}

try {
  await connectClient('esp32-khongtontai', 'abc');
  results.push({ name: 'thiết bị chưa cấp phát bị chặn', ok: false, error: 'vẫn kết nối được' });
} catch {
  results.push({ name: 'thiết bị chưa cấp phát bị chặn', ok: true });
}

/** Chờ tới khi điều kiện đúng, tối đa `timeout` ms. */
async function waitFor(fn, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

if (deviceClient) {
  const telemetry = JSON.stringify({
    ph: 7.4,
    temperature: 25.8,
    tds: 240,
    firmware: 'test-1.0',
    capabilities: { pumps: true, relay_keys: ['drain', 'fill', 'light'] },
    pumps: { drain: false, fill: false, light: false },
  });
  deviceClient.publish(`aquarium/${created.deviceId}/telemetry`, telemetry, { qos: 1 });
  deviceClient.publish(`aquarium/${created.deviceId}/status`, 'online', { qos: 1, retain: true });

  const arrived = await waitFor(() => broker.runtimeFor(created.deviceId).status === 'online' && broker.getDeviceSnapshot(created.deviceId).online);
  results.push({ name: 'telemetry của thiết bị đã cấp phát được nhận', ok: arrived });

  const readingOk = await waitFor(() => db.latestReading(created.deviceId)?.ph === 7.4);
  results.push({ name: 'số đo ghi vào DB của đúng thiết bị', ok: readingOk });

  // Thiết bị A không được ghi vào nhánh topic của thiết bị B.
  let blocked = false;
  deviceClient.once('error', () => {});
  deviceClient.publish(`aquarium/${other.deviceId}/telemetry`, JSON.stringify({ ph: 1.1 }));
  await new Promise((r) => setTimeout(r, 400));
  blocked = db.latestReading(other.deviceId)?.ph !== 1.1;
  results.push({ name: 'thiết bị không ghi được vào topic thiết bị khác', ok: blocked });

  // Broker đóng kết nối khi thiết bị ghi sai nhánh topic, nên phải nối lại.
  deviceClient.end(true);
  deviceClient = await connectClient(created.deviceId, created.deviceKey);

  // Gửi lệnh bật bơm và chờ ack từ thiết bị.
  deviceClient.subscribe(`aquarium/${created.deviceId}/cmd`, { qos: 1 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  deviceClient.on('message', (topic, payload) => {
    let command;
    try {
      command = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    if (!topic.endsWith('/cmd')) return;
    deviceClient.publish(
      `aquarium/${created.deviceId}/ack`,
      JSON.stringify({
        id: command.id,
        pump: command.pump,
        action: command.action,
        ok: true,
        pumps: { drain: command.action === 'on', fill: false, light: false },
      }),
      { qos: 1 },
    );
  });

  let snapshot = null;
  try {
    snapshot = broker.controlPump(created.deviceId, 'drain', 'on', { actor: 'alice', seconds: 3 });
    results.push({ name: 'lệnh bật bơm được gửi cho thiết bị đang online', ok: snapshot.pumps.some((p) => p.key === 'drain' && p.pending) });
  } catch (err) {
    results.push({ name: 'lệnh bật bơm được gửi cho thiết bị đang online', ok: false, error: err.message });
  }

  const confirmed = await waitFor(() => broker.getPumpSnapshot(created.deviceId).pumps.find((p) => p.key === 'drain')?.on === true);
  results.push({ name: 'ack của thiết bị xác nhận trạng thái bơm', ok: confirmed });

  const interlocked = await waitFor(() => {
    broker.controlPump(created.deviceId, 'fill', 'on', { actor: 'alice', seconds: 3 });
    return broker.getPumpSnapshot(created.deviceId).pumps.find((p) => p.key === 'drain')?.pendingAction === 'off';
  }, 3000);
  results.push({ name: 'bật bơm vào thì bơm ra bị ngắt', ok: interlocked });
}

/* --------------------------- từ chối khi offline ------------------------- */

await new Promise((r) => setTimeout(r, 200));
let offlineBlocked = false;
try {
  // Thiết bị chưa từng kết nối thì phải bị từ chối, không gửi lệnh mù.
  broker.controlPump(other.deviceId, 'drain', 'on', { actor: 'carol' });
} catch (err) {
  offlineBlocked = err.statusCode === 409;
}
results.push({ name: 'thiết bị offline thì không nhận lệnh', ok: offlineBlocked });

/* ---------------------------------- tổng kết ---------------------------- */

if (deviceClient) deviceClient.end(true);
await broker.stopBroker();
db.closeDb();
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} kiểm tra đạt.`);
// Thoát tường minh: client MQTT còn giữ reconnect timer nên event loop không tự rỗng.
process.exit(failed.length ? 1 : 0);
