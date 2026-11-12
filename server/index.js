/**
 * Điểm khởi chạy: dựng Express + broker MQTT nhúng trong cùng một tiến trình.
 *
 *   npm start        -> http://localhost:3000  (dashboard + API)
 *                   -> mqtt://<ip-may-tinh>:1883 (ESP32 kết nối vào đây)
 */
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns';
import net from 'node:net';
import express from 'express';
import { config, ROOT } from './config.js';
import { api } from './api.js';
import { startBroker, stopBroker } from './broker.js';
import { startTelegram, stopTelegram } from './telegram.js';
import { readSession } from './auth.js';
import { ensureAdmin } from './users.js';
import { closeDb, listDevices, pruneOldData } from './db.js';

// Một số VM (Azure) có IPv6 không hoạt động: Node thử IPv6 trước rồi timeout
// dù IPv4 vẫn tốt, làm bot Telegram chập chờn. Ưu tiên IPv4 và tắt auto-select
// để mọi kết nối ra ngoài dùng IPv4 ngay.
net.setDefaultAutoSelectFamily(false);
dns.setDefaultResultOrder('ipv4first');

const PUBLIC_DIR = path.join(ROOT, 'public');
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', false);

/** Header bảo mật cơ bản. Toàn bộ JS/CSS đều là file riêng nên CSP không cần nới. */
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  next();
});

app.use('/api', api);

app.get('/login', (req, res) => {
  if (readSession(req)) {
    res.redirect('/');
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/', (req, res) => {
  const session = readSession(req);
  if (!session) {
    res.redirect('/login');
    return;
  }
  if (session.user.role === 'admin') return res.redirect('/admin');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/admin', (req, res) => {
  const session = readSession(req);
  if (!session) return res.redirect('/login');
  if (session.user.role !== 'admin') return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    etag: true,
    maxAge: '5m',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-store');
      if (/\.(js|css)$/.test(filePath)) res.set('Cache-Control', 'no-cache');
    },
  }),
);

app.use((req, res) => {
  res.status(404).json({ error: 'Không tìm thấy đường dẫn.' });
});

// eslint-disable-next-line no-unused-vars -- Express nhận diện middleware lỗi qua 4 tham số
app.use((err, req, res, next) => {
  console.error('[http] Lỗi không xử lý:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Lỗi máy chủ nội bộ.' });
});

/** In địa chỉ IP trong LAN để nhập vào firmware ESP32. */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push({ name, address: info.address });
    }
  }
  return out;
}

async function main() {
  ensureAdmin();
  await startBroker();
  startTelegram();

  const server = app.listen(config.port, config.host, () => {
    const lans = lanAddresses();
    const devices = listDevices();
    console.log('');
    console.log('  HỆ THỐNG GIÁM SÁT BỂ CÁ IoT — đang chạy');
    console.log('  ------------------------------------------------');
    console.log(`  Dashboard : http://localhost:${config.port}`);
    for (const lan of lans) {
      console.log(`              http://${lan.address}:${config.port}   (${lan.name})`);
    }
    console.log(`  MQTT      : ${config.embeddedBroker ? 'broker nhúng' : config.externalBrokerUrl} cổng ${config.mqttPort}`);
    for (const lan of lans) {
      console.log(`              ESP32 -> ${lan.address}:${config.mqttPort}`);
    }
    console.log(`  Thiết bị  : ${devices.length ? devices.map((d) => d.deviceId).join(', ') : 'chưa cấp — vào web để tạo'}`);
    console.log(`  Dữ liệu   : ${config.dbPath}`);
    console.log(`  Đăng nhập : admin / ${config.adminPassword === 'beca123' ? 'mặc định "beca123" — nên đổi trong .env' : 'mật khẩu đã đặt trong .env'}`);
    console.log('');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[http] Cổng ${config.port} đang bị chương trình khác chiếm. Đổi PORT trong .env.`);
    } else {
      console.error('[http] Lỗi máy chủ:', err.message);
    }
    process.exit(1);
  });

  // Dọn dữ liệu cũ mỗi 6 giờ để file DB không phình vô hạn.
  const pruneTimer = setInterval(() => {
    const removed = pruneOldData();
    if (removed.readings || removed.alerts) {
      console.log(`[db] Đã dọn ${removed.readings} bản ghi cũ, ${removed.alerts} cảnh báo cũ.`);
    }
  }, 6 * 3600 * 1000);
  pruneTimer.unref?.();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] Nhận ${signal}, đang dừng...`);
    clearInterval(pruneTimer);
    await new Promise((resolve) => server.close(resolve));
    stopTelegram();
    await stopBroker();
    closeDb();
    console.log('[server] Đã dừng sạch.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] Khởi động thất bại:', err);
  process.exit(1);
});
