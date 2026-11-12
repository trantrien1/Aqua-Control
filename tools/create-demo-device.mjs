#!/usr/bin/env node
/**
 * Tạo sẵn một khách hàng demo + một thiết bị, rồi in ra DEVICE_ID/DEVICE_KEY
 * để chạy bộ giả lập. Tiện cho việc thử nghiệm không cần mở web.
 *
 *   node tools/create-demo-device.mjs
 *   node tools/create-demo-device.mjs --user demo --pass demo123456 --name "Bể demo"
 */
import { config } from '../server/config.js';
import * as db from '../server/db.js';
import { hashPassword } from '../server/users.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const username = arg('user', 'demo');
const password = arg('pass', 'demo123456');
const name = arg('name', 'Bể demo');

let user = db.getUserByUsername(username);
if (!user) {
  user = db.createUser({ username, passwordHash: hashPassword(password), role: 'customer' });
  console.log(`Đã tạo tài khoản ${username} (mật khẩu ${password}).`);
} else {
  console.log(`Tài khoản ${username} đã có, dùng lại.`);
}

const existing = db.listDevices(user.id)[0];
const { device, deviceId, deviceKey } = existing
  ? { device: existing, deviceId: existing.deviceId, deviceKey: null }
  : db.createDevice({ ownerId: user.id, name });

console.log('');
console.log(`  DEVICE_ID=${deviceId}`);
if (deviceKey) {
  console.log(`  DEVICE_KEY=${deviceKey}`);
  console.log('');
  console.log('  Khoá chỉ hiện một lần — chép ngay vào firmware hoặc .env.');
} else {
  console.log('  Thiết bị đã tồn tại; quên khoá thì đổi khoá trong mục Quản trị.');
}
console.log('');
console.log(`  Dữ liệu: ${config.dbPath}`);
db.closeDb();
