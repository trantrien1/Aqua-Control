const $ = id => document.getElementById(id);
const ranges = [
  ['temperature', 'Nhiệt độ', '°C', -55, 125, 0.1],
  ['ph', 'pH', '', 0, 14, 0.01],
  ['tds', 'TDS', 'ppm', 0, 5000, 1],
  ['turbidity_percent', 'Độ đục', '%', 0, 100, 0.1],
];
const stageText = {
  unknown: 'Chờ trạng thái từ ESP32', idle: 'Sẵn sàng thay nước', draining: 'Đang rút nước',
  switching: 'Đang chuyển bơm', filling: 'Đang bơm nước vào', settling: 'Đang chờ nước ổn định',
  locked: 'Đã đủ 3 lần tự động · cần kiểm tra', error: 'Đã dừng · cần kiểm tra mực nước',
};
const reasons = {
  'cancelled-check-level': 'Bạn đã dừng chu trình. Kiểm tra và cân bằng mực nước trước khi đặt lại.',
  'interrupted-check-level': 'Chu trình bị mất điện. Kiểm tra mực nước trước khi đặt lại.',
  'phase-timeout-check-level': 'Pha bơm bị quá giờ. Kiểm tra thiết bị và mực nước.',
  'storage-error': 'ESP32 không lưu được cấu hình an toàn. Kiểm tra thiết bị.',
  overflow: 'Phao báo tràn. Kiểm tra mực nước và nguồn cấp.',
  'max-attempts': 'Thông số vẫn ngoài ngưỡng sau 3 lần tự động. Kiểm tra nước và cảm biến.',
};
const configErrors = {
  'invalid-config': 'Cấu hình không hợp lệ',
  'pumps-or-cycle-busy': 'Bơm hoặc chu trình đang chạy',
  'server-revision-older': 'ESP32 đang giữ cấu hình mới hơn; lưu lại cấu hình trên web',
  'storage-error': 'ESP32 chưa lưu được cấu hình vào bộ nhớ',
};
let current = null;
let deviceId = null;
let revision = null;
let dirty = false;
let working = false;
let online = false;
let confirmedDevice = null;
const number = n => Number(n).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
const duration = n => `${Math.floor(n / 60)} phút ${Math.ceil(n % 60)} giây`;

function estimate() {
  const liters = current?.water?.settings?.tankLiters;
  const percent = Number($('water-percent').value);
  if (!liters || !Number.isInteger(percent) || percent < 1 || percent > 50) {
    $('water-estimate').textContent = 'Lưu thể tích bể và chọn từ 1 đến 50% để xem dự tính.';
    return null;
  }
  const amount = liters * percent / 100;
  const seconds = amount / 96 * 3600;
  const text = `${number(amount)} lít · ${duration(seconds)} mỗi bơm · tổng khoảng ${duration(seconds * 2 + 61)}.`;
  $('water-estimate').textContent = text;
  return { text, percent };
}

export function renderWater(state, reachable) {
  current = state;
  online = reachable;
  const water = state.water;
  if (!water) return;
  const settings = water.settings;
  const changedDevice = deviceId !== state.device.id;
  if (changedDevice) { dirty = false; $('water-level-confirm').checked = false; $('water-settings-error').textContent = ''; }
  if (changedDevice || (!dirty && revision !== settings.revision)) {
    deviceId = state.device.id;
    revision = settings.revision;
    $('tank-liters').value = settings.tankLiters ?? '';
    $('water-auto').checked = settings.autoEnabled;
    $('threshold-inputs').innerHTML = ranges.map(([key, label, unit, low, high, step]) => `<tr><th scope="row">${label} <small>${unit}</small></th>${['criticalMin', 'min', 'max', 'criticalMax'].map(field => `<td><input type="number" name="${key}.${field}" value="${settings.thresholds[key][field]}" min="${low}" max="${high}" step="${step}" required aria-label="${label} ${field}" /></td>`).join('')}</tr>`).join('');
  }
  $('water-mode').textContent = settings.autoEnabled ? 'Tự động thay nước đã bật' : 'Điều khiển thủ công';
  $('water-sync').textContent = dirty ? 'Có thay đổi chưa lưu' : water.synced ? 'ESP32 đã áp dụng' : water.settingsIssue === 'device-newer'
    ? `ESP32 đang giữ bản ${water.deviceRevision}. Nhập thể tích/ngưỡng và lưu để đồng bộ bản mới.`
    : water.settingsError ? `ESP32 chưa áp dụng: ${configErrors[water.settingsError] || water.settingsError}` : 'Đã lưu tại máy chủ · chờ ESP32';
  $('water-save').disabled = working || water.busy;
  $('water-stage').textContent = !online ? 'ESP32 mất kết nối · chưa xác nhận trạng thái' : water.pending ? 'Đang chờ ESP32 xác nhận…' : (stageText[water.stage] || water.stage);
  const remaining = Math.max(0, Math.ceil(((water.remaining_ms || 0) - (Date.now() - (water.reportedAt || Date.now()))) / 1000));
  $('water-cycle-info').textContent = water.error || reasons[water.reason] || (water.busy ? `${water.percent}% · ${water.automatic ? 'Tự động' : 'Thủ công'} · còn ${duration(remaining)} ở pha hiện tại. Số đo tạm dừng trong khi bơm.` : `Tự động đã chạy ${water.attempts || 0}/3 lần trong đợt hiện tại.`);
  for (const step of document.querySelectorAll('[data-stage]')) step.classList.toggle('is-active', step.dataset.stage === water.stage || (water.stage === 'switching' && step.dataset.stage === 'filling'));
  const manualBusy = state.pumps.some(p => p.key !== 'light' && (p.on || p.pending));
  const valid = Boolean(estimate());
  $('water-start').disabled = working || dirty || !valid || !online || !water.supported || !water.synced || water.busy || manualBusy || ['unknown', 'error'].includes(water.stage);
  $('water-stop').disabled = working || !online || !water.supported;
  $('water-reset-panel').hidden = !['error', 'locked'].includes(water.stage);
  $('water-reset').disabled = working || !online || water.busy || manualBusy || !$('water-level-confirm').checked;
}

export function bindWater({ api, refresh, toast }) {
  const rerender = () => current && renderWater(current, online);
  $('water-settings-form').addEventListener('input', () => { dirty = true; rerender(); });
  $('water-percent').addEventListener('input', rerender);
  $('water-level-confirm').addEventListener('change', rerender);
  for (const button of document.querySelectorAll('[data-percent]')) button.addEventListener('click', () => {
    $('water-percent').value = button.dataset.percent; rerender();
  });
  $('water-settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!current || working) return;
    const requestDevice = deviceId;
    const thresholds = Object.fromEntries(ranges.map(([key]) => [key, Object.fromEntries(['min', 'max', 'criticalMin', 'criticalMax'].map(field => [field, Number(document.querySelector(`[name="${key}.${field}"]`).value)]))]));
    working = true; rerender();
    $('water-settings-error').textContent = '';
    try {
      await api.saveSettings({ revision, tankLiters: Number($('tank-liters').value), autoEnabled: $('water-auto').checked, thresholds });
      if (deviceId === requestDevice) { dirty = false; revision = null; }
      toast('Đã lưu cấu hình. Chờ ESP32 xác nhận áp dụng.');
      await refresh();
    } catch (err) { $('water-settings-error').textContent = err.message; }
    finally { working = false; rerender(); }
  });
  async function command(action, percent) {
    if (working) return;
    working = true; rerender();
    try {
      await api.waterChange(action, percent, $('water-level-confirm').checked);
      toast('Đã gửi lệnh. Đang chờ ESP32 xác nhận.');
      $('water-level-confirm').checked = false;
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
    finally { working = false; rerender(); }
  }
  $('water-start').addEventListener('click', () => {
    const e = estimate();
    if (!e) return;
    confirmedDevice = { deviceId, percent: e.percent };
    $('water-confirm-description').textContent = `Thay ${e.percent}% nước: ${e.text}`;
    $('water-confirm').returnValue = '';
    $('water-confirm').showModal();
  });
  $('water-confirm').addEventListener('close', () => {
    if ($('water-confirm').returnValue === 'ok' && confirmedDevice?.deviceId === deviceId) command('start', confirmedDevice.percent);
    confirmedDevice = null;
  });
  $('water-stop').addEventListener('click', () => command('stop'));
  $('water-reset').addEventListener('click', () => command('reset'));
  setInterval(rerender, 1000);
}
