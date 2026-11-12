import * as db from './db.js';
import { config, PARAMS } from './config.js';
import { controlPump, controlWater, getDeviceSnapshot, getPumpSnapshot, getWaterSnapshot, publishWaterConfig, runtimeFor } from './broker.js';
import { validateSettings } from './water.js';
import { bus, EVENTS } from './bus.js';

export const BOT_COMMANDS = [
  ['help', 'Hướng dẫn các lệnh'], ['be', 'Danh sách bể của bạn'], ['chonbe', 'Chọn bể: /chonbe mã_bể'],
  ['status', 'Tình trạng các bể'], ['cam_bien', 'Số đo và chẩn đoán cảm biến'], ['nuoc', 'Chu trình và cấu hình nước'],
  ['nguong', 'Xem ngưỡng an toàn'], ['bomvao', 'Bơm vào: /bomvao số_giây'], ['rutnuoc', 'Rút nước: /rutnuoc số_giây'],
  ['den', 'Đèn: /den bat số_giây hoặc /den tat'], ['thaynuoc', 'Thay nước: /thaynuoc phần_trăm'],
  ['dung', 'Dừng chu trình và tắt cả ba relay'], ['tudong', 'Tự thay nước: /tudong bat hoặc tat'],
  ['datlai', 'Đặt lại sau kiểm tra: /datlai XACNHAN'], ['web', 'Mở bảng điều khiển'],
  ['tat', 'Tạm tắt thông báo'], ['bat', 'Bật lại thông báo'], ['stop', 'Ngắt liên kết Telegram'],
].map(([command, description]) => ({ command, description }));
const handled = new Set(['help', 'trogiup', 'be', 'chonbe', 'cam_bien', 'nuoc', 'nguong', 'bomvao', 'rutnuoc', 'den', 'thaynuoc', 'dung', 'tudong', 'datlai', 'web']);
const selected = new Map();
const stages = { unknown: 'Chưa xác nhận', idle: 'Sẵn sàng', draining: 'Đang rút', switching: 'Chuyển bơm', filling: 'Bơm vào', settling: 'Chờ ổn định', locked: 'Khóa tự động', error: 'Cần kiểm tra mực nước' };
const fail = message => { throw new Error(message); };
const secondsOf = value => {
  if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 3600) fail('Thời gian phải là số nguyên 1–3600 giây.');
  return Number(value);
};

export function clearDeviceSelections() { selected.clear(); }

/** All commands re-check ownership from the DB, including a previously selected tank. */
export async function handleDeviceCommand(user, chatId, command, args, respond) {
  const name = command.replace(/^\//, '');
  if (!handled.has(name)) return false;
  try {
    if (name === 'help' || name === 'trogiup') {
      await respond([
        '🐟 Aqua Control', '/be — liệt kê bể; /chonbe <mã_bể> — chọn bể trước khi điều khiển.',
        '/status · /cam_bien · /nuoc · /nguong · /web',
        '/bomvao <giây> · /rutnuoc <giây> (1–3600 giây)',
        '/den bat <giây> · /den tat', '/thaynuoc <phần_trăm> (1–50%)',
        '/dung — dừng chu trình, tắt cả bơm và đèn', '/tudong bat|tat — bật/tắt tự thay nước, chờ ESP32 áp dụng',
        '/datlai XACNHAN — chỉ gửi sau khi đã kiểm tra và cân bằng mực nước',
        '/tat [phút] · /bat — tắt/bật thông báo', '/stop — NGẮT LIÊN KẾT thông báo; dùng /dung để dừng bơm.',
        'Chỉ bể thuộc quyền của tài khoản đã liên kết mới nhận lệnh. Bể offline không nhận lệnh điều khiển.',
      ].join('\n'));
      return true;
    }
    if (!user || user.disabled) fail('Chat chưa liên kết tài khoản hợp lệ. Gửi /start <mã> lấy từ web.');
    const devices = db.devicesForUser(user);
    if (name === 'web') { await respond(config.telegram.publicUrl); return true; }
    if (!devices.length) fail('Tài khoản chưa được cấp bể.');
    if (name === 'be') {
      await respond(['Bể bạn có quyền truy cập:', ...devices.map(d => `${getDeviceSnapshot(d.deviceId).online ? '🟢' : '⚪'} ${d.name} · ${d.deviceId}`), 'Chọn bằng /chonbe <mã_bể>.'].join('\n'));
      return true;
    }
    if (name === 'chonbe') {
      const device = devices.find(d => d.deviceId === args[0]);
      if (!device || args.length !== 1) fail('Mã bể không hợp lệ hoặc không thuộc tài khoản. Gửi /be để xem danh sách.');
      selected.set(String(chatId), { userId: user.id, deviceId: device.deviceId });
      await respond(`Đã chọn ${device.name} (${device.deviceId}). Các lệnh tiếp theo áp dụng cho bể này.`);
      return true;
    }
    const choice = selected.get(String(chatId));
    const device = choice?.userId === user.id ? devices.find(d => d.deviceId === choice.deviceId) : devices.length === 1 ? devices[0] : null;
    if (!device) fail('Gửi /be rồi /chonbe <mã_bể> để chọn đúng bể.');
    const id = device.deviceId;
    const label = `${device.name} (${id})`;
    const water = getWaterSnapshot(id);
    const settings = water.settings;
    const respondForTank = text => respond(`🐟 ${label}\n${text}`);
    if (name === 'cam_bien') {
      const r = db.latestReading(id);
      if (!r) fail('Bể chưa gửi số đo.');
      const sensor = r.sensor_status || {};
      await respondForTank([
        ...['temperature', 'ph', 'tds', 'turbidity_percent'].map(k => `${PARAMS[k].short}: ${r[k] == null ? 'Chưa quy đổi' : r[k].toFixed(PARAMS[k].decimals) + ' ' + PARAMS[k].unit}`),
        `ADC pH / TDS / đục: ${[sensor.ph_adc_voltage, sensor.tds_adc_voltage, sensor.turbidity_adc_voltage].map(v => v == null ? '—' : Number(v).toFixed(3) + ' V').join(' / ')}`,
        `pH: ${sensor.ph_status || (sensor.ph_fixed_reference ? 'tham chiếu cố định' : 'chưa có chẩn đoán')}`,
        `DS18B20: ${sensor.temperature_device_count ?? 'chưa có thông tin'} cảm biến được dò`,
        `Số đo nhận lúc: ${new Date(r.receivedAt).toLocaleString('vi-VN')}`,
      ].join('\n'));
    } else if (name === 'nuoc') {
      await respondForTank(`Thể tích: ${settings.tankLiters ?? 'chưa đặt'} L\nLưu lượng mỗi bơm: 96 L/h\nTự thay: ${settings.autoEnabled ? 'bật' : 'tắt'}\nChu trình: ${stages[water.stage] || water.stage}\nLần tự động: ${water.attempts || 0}/3\nCấu hình: server ${settings.revision}, ESP32 ${water.deviceRevision ?? 'chưa biết'}\n${water.synced ? 'ESP32 đã áp dụng' : 'Chưa đồng bộ'}${water.reason ? '\nLý do: ' + water.reason : ''}`);
    } else if (name === 'nguong') {
      await respondForTank(Object.entries(settings.thresholds).map(([k,r]) => `${PARAMS[k].short}: an toàn ${r.min}–${r.max} ${PARAMS[k].unit}; nguy hiểm ngoài ${r.criticalMin}–${r.criticalMax}`).join('\n') + '\nChỉnh ngưỡng trên web rồi Lưu cấu hình bể.');
    } else if (name === 'bomvao' || name === 'rutnuoc') {
      if (args.length !== 1) fail(`Cú pháp: /${name} <số_giây>.`);
      const seconds = secondsOf(args[0]);
      controlPump(id, name === 'bomvao' ? 'fill' : 'drain', 'on', { seconds, source: 'telegram', actor: user.username });
      await respondForTank(`Đã gửi lệnh ${name === 'bomvao' ? 'bơm vào' : 'rút nước'} ${seconds} giây. Chờ ESP32 xác nhận; /dung để dừng.`);
    } else if (name === 'den') {
      if (args[0] === 'tat' && args.length === 1) controlPump(id, 'light', 'off', { source: 'telegram', actor: user.username });
      else if (args[0] === 'bat' && args.length === 2) controlPump(id, 'light', 'on', { seconds: secondsOf(args[1]), source: 'telegram', actor: user.username });
      else fail('Cú pháp: /den bat <giây> hoặc /den tat.');
      await respondForTank('Đã gửi lệnh đèn. Chờ ESP32 xác nhận.');
    } else if (name === 'thaynuoc') {
      if (args.length !== 1 || !/^\d+$/.test(args[0])) fail('Cú pháp: /thaynuoc <phần_trăm>, số nguyên 1–50.');
      const result = controlWater(id, 'start', { percent: Number(args[0]), actor: user.username, source: 'telegram' });
      await respondForTank(`Đã gửi lệnh thay ${args[0]}% (${result.estimate.liters} L), ${result.estimate.phaseSeconds}s mỗi bơm. Chờ ESP32 xác nhận; /dung để dừng.`);
    } else if (name === 'dung') {
      if (args.length) fail('Cú pháp: /dung.');
      if (!getDeviceSnapshot(id).online || !getPumpSnapshot(id).pumps.some(p => p.available)) fail('ESP32 offline hoặc chưa khai báo relay; chưa gửi được lệnh dừng.');
      if (water.supported) controlWater(id, 'stop', { actor: user.username, source: 'telegram' });
      for (const p of getPumpSnapshot(id).pumps.filter(p => p.available)) controlPump(id, p.key, 'off', { source: 'telegram', actor: user.username });
      await respondForTank('Đã gửi lệnh dừng chu trình và tắt ba relay. Chờ ESP32 xác nhận. Nếu dừng giữa chu trình, kiểm tra mực nước trước khi đặt lại.');
    } else if (name === 'datlai') {
      if (args.length !== 1 || args[0] !== 'XACNHAN') fail('Chỉ sau khi đã kiểm tra và cân bằng mực nước, gửi /datlai XACNHAN.');
      controlWater(id, 'reset', { actor: user.username, source: 'telegram', confirmLevel: true });
      await respondForTank('Đã gửi yêu cầu đặt lại sau xác nhận kiểm tra mực nước. Chờ ESP32.');
    } else if (name === 'tudong') {
      if (args.length !== 1 || !['bat', 'tat'].includes(args[0])) fail('Cú pháp: /tudong bat hoặc /tudong tat.');
      const rt = runtimeFor(id);
      if (water.busy || ['drain', 'fill'].some(k => rt.pumps[k].on || rt.pumps[k].pending)) fail('Dừng chu trình và hai bơm trước khi đổi cấu hình.');
      const next = validateSettings({ ...settings, autoEnabled: args[0] === 'bat' }, settings);
      next.revision = Math.max(next.revision, (water.deviceRevision ?? 0) + 1);
      db.saveWaterSettings(id, next); publishWaterConfig(id);
      db.logPumpEvent({ deviceId: id, pump: 'settings', action: 'update', source: 'telegram', actor: user.username, note: `Tự thay nước: ${args[0]}` });
      bus.emit(EVENTS.water, { deviceId: id });
      await respondForTank(`Đã lưu tự thay nước: ${args[0]}. Chỉ có hiệu lực khi ESP32 nhận và xác nhận cấu hình mới.`);
    }
  } catch (err) { await respond(`❌ ${err.message}`); }
  return true;
}
