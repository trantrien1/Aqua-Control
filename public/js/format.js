/** Định dạng số, thời gian và nhãn trạng thái dùng chung cho giao diện. */

export const STATUS_TEXT = {
  good: 'Bình thường',
  warn: 'Cảnh báo',
  critical: 'Nguy hiểm',
  nodata: 'Chưa có dữ liệu',
  unrated: 'Chưa đánh giá',
};

export const STATUS_ICON = {
  good: '#i-check',
  warn: '#i-alert',
  critical: '#i-alert',
  nodata: '#i-wifi-off',
  unrated: '#i-eye',
};

export const PUMP_SOURCE_TEXT = {
  user: 'Người dùng',
  watchdog: 'Tự ngắt an toàn',
  interlock: 'Liên động',
  device: 'Thiết bị',
  auto: 'Tự động',
  water_change: 'Thay nước',
  mqtt: 'Web',
  serial: 'Serial',
  telegram: 'Telegram',
};

export function fmtNumber(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('vi-VN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtValue(value, decimals = 1, unit = '') {
  const text = fmtNumber(value, decimals);
  return unit ? `${text} ${unit}` : text;
}

export function fmtClock(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function fmtDateTime(ts) {
  if (!ts) return '—';
  const date = new Date(ts);
  return `${date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })} ${date.toLocaleTimeString(
    'vi-VN',
    { hour: '2-digit', minute: '2-digit', second: '2-digit' },
  )}`;
}

export function fmtDayMonth(ts) {
  return new Date(ts).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

/** "12 giây trước", "3 phút trước"… */
export function fmtAgo(ts, now = Date.now()) {
  if (!ts) return 'chưa bao giờ';
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 5) return 'vừa xong';
  if (seconds < 60) return `${seconds} giây trước`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.round(hours / 24)} ngày trước`;
}

export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} phút ${rest}s` : `${m} phút`;
}
