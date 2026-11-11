/**
 * Đánh giá ngưỡng và phát cảnh báo.
 *
 * Hai khái niệm tách biệt:
 *  - Trạng thái "đang có vấn đề" được TÍNH TRỰC TIẾP từ bản ghi mới nhất,
 *    nên luôn đúng và tự hết khi số liệu về bình thường (không cần bảng riêng).
 *  - Nhật ký cảnh báo chỉ ghi khi đã qua thời gian chờ (cooldown), để người dùng
 *    không nhận hàng chục thông báo giống nhau mỗi giờ rồi bỏ qua tất cả.
 */
import { PARAMS, PARAM_KEYS, config, PUMPS } from './config.js';
import { logAlert } from './db.js';

/** Ngưỡng cảnh báo vàng/đỏ của từng tham số, dùng chung cho server và trình duyệt. */
export const ALERT_COOLDOWN_MS = config.alertCooldownMs;

/** Map khoá `${param}|${level}` -> thời điểm cảnh báo gần nhất. */
const lastAlertAt = new Map();

const fmt = (value, decimals) =>
  Number(value).toLocaleString('vi-VN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

/**
 * Xếp loại một giá trị đo.
 * @returns {'good'|'warn'|'critical'|'nodata'}
 */
export function statusOf(paramKey, value) {
  const def = PARAMS[paramKey];
  if (!def || value === null || value === undefined || !Number.isFinite(Number(value))) {
    return 'nodata';
  }
  const v = Number(value);
  if (def.monitor === false) return 'unrated';
  if (def.criticalLow != null && v < def.criticalLow) return 'critical';
  if (def.criticalHigh != null && v > def.criticalHigh) return 'critical';
  if (def.warnLow != null && v < def.warnLow) return 'warn';
  if (def.warnHigh != null && v > def.warnHigh) return 'warn';
  return 'good';
}

/** Mô tả ngưỡng an toàn để hiển thị cạnh số đo, ví dụ "24,0 – 28,0 °C". */
export function rangeLabel(paramKey) {
  const def = PARAMS[paramKey];
  if (!def) return '';
  if (def.monitor === false) return def.note || 'Chưa có ngưỡng đánh giá';
  const { min, max, decimals, unit } = def;
  const text = `${fmt(min, decimals ?? 0)} – ${fmt(max, decimals ?? 0)} ${unit}`.trim();
  return text;
}

function describeIssue(paramKey, level, value) {
  const def = PARAMS[paramKey];
  const d = def.decimals ?? 0;
  const v = fmt(value, d);
  const unit = def.unit ? ` ${def.unit}` : '';

  const tooLow =
    (level === 'critical' ? def.criticalLow : def.warnLow) != null &&
    Number(value) < (level === 'critical' ? def.criticalLow : def.warnLow);
  const limit = tooLow
    ? level === 'critical'
      ? def.criticalLow
      : def.warnLow
    : level === 'critical'
      ? def.criticalHigh
      : def.warnHigh;
  const limitText = limit == null ? '' : `${fmt(limit, d)}${def.unit ? ` ${def.unit}` : ''}`;

  const levelText = level === 'critical' ? 'nguy hiểm' : 'cảnh báo';
  const dirText = tooLow ? 'thấp hơn' : 'vượt';

  return `${def.short}: ${v}${unit} ${dirText} ngưỡng ${levelText} (${limitText}).`;
}

/**
 * Tính danh sách vấn đề hiện tại từ một bản ghi.
 * @returns {Array<{param:string, level:'warn'|'critical', value:number, message:string, label:string}>}
 */
export function evaluateReading(reading) {
  if (!reading) return [];
  const issues = [];
  for (const key of PARAM_KEYS) {
    const level = statusOf(key, reading[key]);
    if (level !== 'warn' && level !== 'critical') continue;
    issues.push({
      param: key,
      label: PARAMS[key].short,
      level,
      value: Number(reading[key]),
      message: describeIssue(key, level, reading[key]),
    });
  }
  return issues;
}

/**
 * Gợi ý hành động cho từng vấn đề: bơm nào có thể xử lý, kèm hướng dẫn.
 * Đây chỉ là gợi ý trên giao diện — hệ thống không tự bật bơm.
 */
export function suggestedPumps(issues) {
  const suggestions = [];
  for (const p of Object.values(PUMPS)) {
    const issue = issues.find((i) => i.param === p.triggerParam);
    if (!issue) continue;
    if (p.triggerBelow != null && issue.value < p.triggerBelow) {
      suggestions.push({ pump: p.key, reason: issue.message });
    } else if (p.triggerAbove != null && issue.value > p.triggerAbove) {
      suggestions.push({ pump: p.key, reason: issue.message });
    }
  }
  return suggestions;
}

/**
 * Ghi nhật ký cảnh báo, bỏ qua nếu chưa qua thời gian chờ.
 * @returns danh sách cảnh báo vừa được ghi (đã lọc cooldown)
 */
export function logNewAlerts(issues, deviceId = config.defaultDeviceId, now = Date.now()) {
  const created = [];
  for (const issue of issues) {
    const key = `${issue.param}|${issue.level}`;
    const previous = lastAlertAt.get(key);
    if (previous != null && now - previous < config.alertCooldownMs) continue;
    lastAlertAt.set(key, now);
    logAlert({ ...issue, deviceId, ts: now });
    created.push({ ...issue, ts: now });
  }
  return created;
}

/** Xoá bộ nhớ cooldown, phục vụ kiểm thử. */
export function resetCooldown() {
  lastAlertAt.clear();
}
