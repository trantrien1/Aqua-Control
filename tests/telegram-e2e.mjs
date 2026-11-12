/**
 * Chạy thật toàn bộ đường dây nhiều khách hàng: MQTT → đánh giá ngưỡng → gọi
 * Telegram API, với một Telegram giả lập cục bộ để không cần bot token thật.
 *
 *   node --no-warnings tests/telegram-e2e.mjs
 *
 * Điều quan trọng nhất được kiểm tra: mỗi thông số chỉ báo MỘT lần khi rơi vào
 * vùng đỏ, mỗi chủ thiết bị chỉ nhận tin của bể mình, và lệnh /tat – /bat trong bot
 * thật sự bật/tắt đường gửi tin.
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

const sent = [];
/** Tin nhắn người dùng gửi cho bot, để getUpdates trả về ở vòng poll kế tiếp. */
const queued = [];
const telegramMock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const method = req.url.split('/').pop();
    if (method === 'sendMessage') {
      sent.push(JSON.parse(body || '{}'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    let result = true;
    if (method === 'getMe') result = { username: 'aqua_test_bot' };
    else if (method === 'getUpdates') result = queued.splice(0);
    res.end(JSON.stringify({ ok: true, result }));
  });
});

const tgPort = await freePort();
const mqttPort = await freePort();
await new Promise((r) => telegramMock.listen(tgPort, '127.0.0.1', r));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-e2e-'));
Object.assign(process.env, {
  DB_PATH: path.join(dir, 'e2e.db'),
  MQTT_PORT: String(mqttPort),
  EMBEDDED_BROKER: 'true',
  MQTT_SERVER_USERNAME: 'e2e-server',
  MQTT_SERVER_PASSWORD: 'e2e-server-pass',
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_NOTIFY_LEVEL: 'critical',
  TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`,
  PUBLIC_URL: 'http://localhost:3000',
});

const { startBroker, stopBroker } = await import('../server/broker.js');
const { startTelegram, stopTelegram } = await import('../server/telegram.js');
const db = await import('../server/db.js');
const mqtt = (await import('mqtt')).default;

/* Hai khách hàng, mỗi người một bể và một chat id khác nhau. */
const alice = db.createUser({ username: 'alice', passwordHash: 'x', role: 'customer' });
const bob = db.createUser({ username: 'bob', passwordHash: 'x', role: 'customer' });
const deviceA = db.createDevice({ ownerId: alice.id, name: 'Bể phòng khách' });
const deviceB = db.createDevice({ ownerId: bob.id, name: 'Bể văn phòng' });
db.bindTelegramChat(alice.id, '111');
db.bindTelegramChat(bob.id, '222');

await startBroker();
startTelegram();

const connect = (device) =>
  mqtt.connectAsync(`mqtt://127.0.0.1:${mqttPort}`, {
    username: device.deviceId,
    password: device.deviceKey,
    reconnectPeriod: 0,
  });

const clientA = await connect(deviceA);
const clientB = await connect(deviceB);

const publish = (client, device, values) =>
  client.publishAsync(
    `aquarium/${device.deviceId}/telemetry`,
    JSON.stringify({ ts: Date.now(), temperature: 25, ph: 7.4, tds: 200, turbidity: 12, ...values }),
  );
const settle = () => new Promise((r) => setTimeout(r, 400));

async function waitFor(label, ok, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Hết thời gian chờ: ${label}`);
}

try {
  // Lần đầu: pH trong ngưỡng → không có tin nào.
  await publish(clientA, deviceA, { ph: 7.4 });
  await settle();
  assert.equal(sent.length, 0, 'pH bình thường không được báo');

  // pH vượt ngưỡng đỏ (9.2 > 9.0) → đúng 1 tin, gửi cho chủ của bể A.
  await publish(clientA, deviceA, { ph: 9.2 });
  await settle();
  assert.equal(sent.length, 1, 'lần đầu vào vùng đỏ phải báo');
  assert.match(sent[0].text, /NGUY HIỂM/);
  assert.match(sent[0].text, /pH/);
  assert.equal(sent[0].chat_id, '111', 'chỉ chủ bể A nhận tin');
  assert.match(sent[0].text, /Bể phòng khách/);

  // Vẫn nguy hiểm: gửi thêm 3 lần, không được báo thêm.
  for (const ph of [9.3, 9.1, 9.4]) await publish(clientA, deviceA, { ph });
  await settle();
  assert.equal(sent.length, 1, 'đang nguy hiểm thì không báo lặp');

  // Bể B cũng vào vùng đỏ → chủ B nhận tin riêng, chủ A không nhận thêm.
  await publish(clientB, deviceB, { ph: 9.2 });
  await settle();
  assert.equal(sent.length, 2, 'bể khác phải báo riêng cho chủ của nó');
  assert.equal(sent[1].chat_id, '222');
  assert.match(sent[1].text, /Bể văn phòng/);

  // Thêm TDS vào vùng đỏ ở bể A → báo thêm 1 tin cho TDS.
  await publish(clientA, deviceA, { ph: 9.4, tds: 500 });
  await settle();
  assert.equal(sent.length, 3, 'tham số thứ hai phải được báo riêng');
  assert.match(sent[2].text, /TDS/);
  assert.equal(sent[2].chat_id, '111');

  // Chủ A ngắt liên kết → thôi nhận tin, bể B vẫn báo bình thường.
  db.unbindTelegram(alice.id);
  await publish(clientA, deviceA, { ph: 9.6, tds: 200 });
  await settle();
  assert.equal(sent.length, 3, 'đã ngắt liên kết thì không gửi nữa');
  db.bindTelegramChat(alice.id, '111');

  // Quay lại vùng đỏ sau khi ra khỏi → báo lại.
  await publish(clientA, deviceA, { ph: 7.4, tds: 200 });
  await settle();
  await publish(clientA, deviceA, { ph: 9.5, tds: 200 });
  await settle();
  assert.equal(sent.length, 4, 'ra khỏi vùng đỏ rồi quay lại phải báo lại');
  assert.match(sent[3].text, /pH/);
  assert.equal(sent[3].chat_id, '111');

  // Khách gõ lệnh trong bot: /tat 30 → thôi nhận tin, /bat → nhận tiếp.
  const alerts = () => sent.filter((m) => /NGUY HIỂM|CẢNH BÁO/.test(m.text));
  const before = alerts().length;

  queued.push({ update_id: 1, message: { chat: { id: '111' }, text: '/tat 30' } });
  await waitFor('bot xác nhận tắt thông báo', () =>
    sent.some((m) => /Đã tắt thông báo trong 30 phút/.test(m.text)));
  assert.ok(db.getUserById(alice.id).notifyMutedUntil > Date.now(), 'lệnh /tat phải ghi vào DB');

  await publish(clientA, deviceA, { ph: 7.4 });
  await settle();
  await publish(clientA, deviceA, { ph: 9.7 });
  await settle();
  assert.equal(alerts().length, before, 'đang tắt thông báo thì không gửi cảnh báo');

  queued.push({ update_id: 2, message: { chat: { id: '111' }, text: '/bat' } });
  await waitFor('bot xác nhận bật lại', () => db.getUserById(alice.id).notifyMutedUntil === 0);

  await publish(clientA, deviceA, { ph: 7.4 });
  await settle();
  await publish(clientA, deviceA, { ph: 9.8 });
  await settle();
  assert.equal(alerts().length, before + 1, 'bật lại thông báo thì nhận tiếp');

  console.log('✔ pH bình thường: không báo');
  console.log('✔ vào vùng đỏ: báo đúng 1 tin cho đúng chủ bể');
  console.log('✔ còn nguy hiểm: không báo lặp');
  console.log('✔ bể của khách khác: báo riêng, không lẫn');
  console.log('✔ ngắt liên kết: thôi nhận tin');
  console.log('✔ quay lại vùng đỏ: báo lại');
  console.log('✔ /tat trong bot: ghi vào DB và không gửi tin · /bat: nhận tiếp');
  console.log(`\nCảnh báo đã gửi: ${alerts().length} · tổng số tin bot gửi: ${sent.length}`);
} finally {
  await clientA.endAsync(true);
  await clientB.endAsync(true);
  stopTelegram();
  await stopBroker();
  db.closeDb();
  telegramMock.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
