/**
 * Bảng điều khiển chính.
 *
 * Luồng dữ liệu: SSE /api/stream đẩy toàn bộ snapshot trạng thái mỗi khi có
 * bản tin telemetry, thay đổi bơm hoặc trạng thái thiết bị. Client chỉ có một
 * hàm render duy nhất, cộng thêm một nhịp 1 giây để cập nhật các con số đếm
 * thời gian (tuổi dữ liệu, thời gian bơm còn lại) mà không chờ server.
 */
import { renderWater, bindWater } from "./water.js";
import { LineChart } from "./chart.js";
import { api, activeDevice, setActiveDevice } from "./api.js";
import {
  PUMP_SOURCE_TEXT,
  STATUS_ICON,
  STATUS_TEXT,
  fmtAgo,
  fmtClock,
  fmtDateTime,
  fmtDuration,
  fmtNumber,
} from "./format.js";

const $ = (id) => document.getElementById(id);

const PARAM_ICON = {
  temperature: "#i-thermometer",
  ph: "#i-flask",
  tds: "#i-gauge",
  turbidity: "#i-eye",
  turbidity_voltage: "#i-eye",
  turbidity_percent: "#i-eye",
  water_level: "#i-droplet",
};

const RANGE_LABELS = {
  "1h": "1 giờ",
  "6h": "6 giờ",
  "24h": "24 giờ",
  "7d": "7 ngày",
  "30d": "30 ngày",
};

const PUMP_ACTION_TEXT = {
  on: 'Bật', off: 'Tắt', start: 'Bắt đầu', stop: 'Dừng', reset: 'Đặt lại',
  update: 'Cập nhật', idle: 'Sẵn sàng', draining: 'Đang rút nước', switching: 'Chuyển bơm',
  filling: 'Đang bơm vào', settling: 'Chờ ổn định', locked: 'Đã khóa tự động', error: 'Cần kiểm tra',
};

const dom = {
  connPill: $("conn-pill"),
  connText: $("conn-text"),
  brandSub: $("brand-sub"),
  lastUpdate: $("last-update"),
  metricGrid: $("metric-grid"),
  alertsPanel: $("alerts-panel"),
  pumpGrid: $("pump-grid"),
  metricTabs: $("metric-tabs"),
  rangeTabs: $("range-tabs"),
  chartSummary: $("chart-summary"),
  chartSafeLegend: $("chart-safe-legend"),
  alertLog: $("alert-log"),
  pumpLog: $("pump-log"),
  dialog: $("pump-dialog"),
  dialogTitle: $("dialog-title"),
  dialogDesc: $("dialog-desc"),
  dialogConfirm: $("dialog-confirm"),
  durationChoices: $("duration-choices"),
  toasts: $("toasts"),
  logout: $("logout-btn"),
  stopAll: $("stop-all"),
  relayCount: $("relay-count"),
  relayFeedback: $("relay-feedback"),
  dialogNote: $("dialog-note"),
  tankId: $("tank-id"),
  summaryBadge: $("summary-badge"),
  goodCount: $("good-count"),
  overviewStatus: $("overview-status"),
  sensorFreshness: $("sensor-freshness"),
  chartCurrentLabel: $("chart-current-label"),
  telegramStatus: $("telegram-status"),
  telegramTest: $("telegram-test"),
  telegramLink: $("telegram-link"),
  telegramUnlink: $("telegram-unlink"),
  telegramCode: $("telegram-code"),
  telegramCommand: $("telegram-command"),
  telegramBot: $("telegram-bot"),
  deviceSelect: $("device-select"),
  accountChip: $("account-chip"),
  adminSection: $("admin"),
  adminUsers: $("admin-users"),
  adminDevices: $("admin-devices"),
  adminNewUser: $("admin-new-user"),
  adminNewDevice: $("admin-new-device"),
  adminUserForm: $("admin-user-form"),
  adminUserFormTitle: $("admin-user-form-title"),
  adminUserName: $("admin-user-name"),
  adminUserPass: $("admin-user-pass"),
  adminUserPassLabel: $("admin-user-pass-label"),
  adminUserError: $("admin-user-error"),
  adminUserSave: $("admin-user-save"),
  adminUserCancel: $("admin-user-cancel"),
  adminDeviceForm: $("admin-device-form"),
  adminDeviceOwner: $("admin-device-owner"),
  adminDeviceName: $("admin-device-name"),
  adminDeviceError: $("admin-device-error"),
  adminDeviceCancel: $("admin-device-cancel"),
  adminSecret: $("admin-secret"),
  adminSecretId: $("admin-secret-id"),
  adminSecretKey: $("admin-secret-key"),
  adminSecretClose: $("admin-secret-close"),
};

const chart = new LineChart($("chart"));

let state = null;
let me = null;
let currentMetric = "temperature";
let currentRange = "24h";
let tabsSignature = "";
let pendingPump = null;
let chartToken = 0;
let streamConnected = true;
const sending = new Set();
const sendingActions = new Map();
let relaySignature = "";
let devicePickerSignature = "";
let snapshotReceivedAt = 0;
let previousFreshness = "";
let trendSignature = "";
let trendsLoading = false;
const trends = new Map();
/** Tham chiếu tới các phần tử cần cập nhật mỗi giây của từng bơm. */
const pumpRefs = new Map();

/* ------------------------------------------------------------------ tiện ích */

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function icon(symbol, size = 16) {
  return `<svg width="${size}" height="${size}" aria-hidden="true"><use href="${symbol}" /></svg>`;
}

function toast(message, kind = "info") {
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.kind = kind;
  node.textContent = message;
  dom.toasts.appendChild(node);
  setTimeout(() => node.remove(), 5000);
}

function paramDef(key) {
  return state?.params?.find((p) => p.key === key) || null;
}

function pumpDef(key) {
  return state?.pumpCatalog?.find((p) => p.key === key) || null;
}

// Age received telemetry using the server's clock, plus elapsed client time.
// Device heartbeats alone must never make an old sensor reading look fresh.
function elapsedSinceSnapshot() {
  return Math.max(0, Date.now() - snapshotReceivedAt);
}

function deviceReachable() {
  return (
    !!state &&
    streamConnected &&
    state.brokerConnected &&
    state.device.online &&
    state.device.ageMs != null &&
    state.device.ageMs + elapsedSinceSnapshot() <= state.device.staleAfterMs
  );
}

function readingsFresh() {
  return (
    deviceReachable() &&
    state.readingAgeMs != null &&
    state.readingAgeMs + elapsedSinceSnapshot() <= state.device.staleAfterMs
  );
}

function freshnessLabel() {
  if (!streamConnected) return "Mất kết nối máy chủ";
  if (!state?.brokerConnected) return "Mất kết nối MQTT";
  if (!deviceReachable()) return "Thiết bị mất kết nối";
  if (!state.reading) return "Chưa có số đo";
  return readingsFresh() ? "Đang cập nhật" : "Dữ liệu cũ";
}

function renderOverview() {
  if (!state) return;
  const fresh = readingsFresh();
  const good = fresh
    ? state.params.filter(
        (p) => p.status === "good" && Number.isFinite(p.value),
      ).length
    : 0;
  const critical = state.issues.some((issue) => issue.level === "critical");
  const warning = state.issues.length > 0;
  const allRated =
    fresh && good === state.params.length && state.params.length > 0;
  const kind = !fresh
    ? "nodata"
    : critical
      ? "critical"
      : warning
        ? "warn"
        : allRated
          ? "good"
          : "unrated";
  dom.summaryBadge.className = `badge badge--${kind}`;
  dom.summaryBadge.textContent = !fresh
    ? freshnessLabel()
    : critical
      ? "Cần kiểm tra ngay"
      : warning
        ? "Cần chú ý"
        : allRated
          ? "Trong ngưỡng"
          : "Chưa đánh giá đủ";
  dom.goodCount.textContent = fresh ? `${good}/${state.params.length}` : "—";
  dom.overviewStatus.textContent = !state.reading
    ? "Chờ số đo đầu tiên."
    : !fresh
      ? "Đang hiển thị số đo cũ."
      : warning
        ? `${state.issues.length} cảnh báo.`
        : allRated
          ? ""
          : `${state.params.filter((p) => ["nodata", "unrated"].includes(p.status)).length} cảm biến chưa đánh giá.`;
  dom.sensorFreshness.textContent = freshnessLabel();
  dom.sensorFreshness.parentElement.dataset.fresh = String(fresh);
}

function recordTrends() {
  if (!state.reading?.ts || !readingsFresh()) return;
  for (const p of state.params) {
    const points = trends.get(p.key) || [];
    if (!points.some((point) => point.ts === state.reading.ts)) {
      points.push({
        ts: state.reading.ts,
        value: Number.isFinite(p.value) ? p.value : null,
      });
    }
    trends.set(
      p.key,
      points.filter((point) => point.ts >= state.now - 3600_000).slice(-120),
    );
  }
}

function trendMarkup(p) {
  const points = trends.get(p.key) || [];
  const values = points.filter((point) => Number.isFinite(point.value));
  if (values.length < 2 || !readingsFresh() || !Number.isFinite(p.value)) {
    return '<div class="metric__trend metric__trend--empty" title="Xu hướng 1 giờ"><span>Chưa đủ dữ liệu</span></div>';
  }
  const low = Math.min(...values.map((point) => point.value));
  const high = Math.max(...values.map((point) => point.value));
  const span = high - low || 1;
  const from = points[0].ts;
  const duration = Math.max(1, points.at(-1).ts - from);
  let start = true;
  const path = points
    .map((point) => {
      if (!Number.isFinite(point.value)) {
        start = true;
        return "";
      }
      const x = 2 + ((point.ts - from) / duration) * 112;
      const y = high === low ? 16 : 29 - ((point.value - low) / span) * 26;
      const command = `${start ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      start = false;
      return command;
    })
    .join(" ");
  const delta = values.at(-1).value - values[0].value;
  const rounded = Number(delta.toFixed(p.decimals));
  const label =
    rounded === 0
      ? "Không đổi"
      : `${rounded > 0 ? "↗ +" : "↘ −"}${fmtNumber(Math.abs(rounded), p.decimals)}${p.unit ? ` ${p.unit}` : ""}`;
  return `<div class="metric__trend"><div><span>${esc(label)}</span><small>1 giờ</small></div><svg viewBox="0 0 116 32" role="img" aria-label="Xu hướng ${esc(p.short)} trong 1 giờ qua"><path d="${path}" /></svg></div>`;
}

async function seedTrends() {
  if (!state || trendsLoading) return;
  trendsLoading = true;
  const keys = state.params.map((p) => p.key);
  try {
    const results = await Promise.allSettled(
      keys.map((key) => api.getHistory(key, "1h")),
    );
    results.forEach((result, index) => {
      if (
        result.status !== "fulfilled" ||
        !state.params.some((p) => p.key === keys[index])
      )
        return;
      const combined = new Map(
        result.value.points.map((point) => [
          point.ts,
          {
            ts: point.ts,
            value: Number.isFinite(point.avg) ? point.avg : null,
          },
        ]),
      );
      for (const point of trends.get(keys[index]) || [])
        combined.set(point.ts, point);
      trends.set(
        keys[index],
        [...combined.values()]
          .filter((point) => point.ts >= state.now - 3600_000)
          .sort((a, b) => a.ts - b.ts)
          .slice(-120),
      );
    });
    renderMetrics();
  } finally {
    trendsLoading = false;
  }
}

/* ---------------------------------------------------------------- kết nối/SSE */

function renderConnection() {
  if (!state) return;
  const online = deviceReachable();
  const brokerDown = !state.brokerConnected;

  dom.connPill.className = `pill ${
    !streamConnected || brokerDown
      ? "pill--offline"
      : online
        ? "pill--online"
        : "pill--offline"
  }`;
  dom.connText.textContent = connectionText();
  dom.connPill.title = brokerDown
    ? "Máy chủ chưa kết nối được broker MQTT nội bộ."
    : online
      ? `Thiết bị ${state.device.id} đang gửi dữ liệu.`
      : `Thiết bị ${state.device.id} không gửi dữ liệu.`;

  const parts = [state.device.id];
  if (state.device.firmware) parts.push(`firmware ${state.device.firmware}`);
  if (state.device.ip) parts.push(state.device.ip);
  if (Number.isFinite(state.device.rssi))
    parts.push(`RSSI ${state.device.rssi} dBm`);
  dom.brandSub.textContent = parts.join(" · ");
  dom.tankId.textContent = state.device.name
    ? `${state.device.name} · ${state.device.id}`
    : state.device.id;
}

function connectionText() {
  if (!state) return "Đang kết nối…";
  if (!streamConnected) return "Mất kết nối máy chủ";
  if (!state.brokerConnected) return "Máy chủ mất broker";
  return deviceReachable() ? "Thiết bị đang kết nối" : "Thiết bị mất kết nối";
}

function renderLastUpdate() {
  if (!state) return;
  if (!state.reading) {
    dom.lastUpdate.textContent = "Chưa nhận được dữ liệu nào từ thiết bị.";
    return;
  }
  const measured = state.reading.ts ? fmtClock(state.reading.ts) : "—";
  const age =
    state.readingAgeMs != null
      ? fmtAgo(Date.now() - state.readingAgeMs - elapsedSinceSnapshot())
      : "không rõ";
  dom.lastUpdate.textContent = `${readingsFresh() ? "Cập nhật" : "Số đo gần nhất"} ${measured} · ${age}`;
}

/* ------------------------------------------------------------------ thẻ số đo */

function renderMetrics() {
  if (!state) return;
  const expanded = new Set(
    [...dom.metricGrid.querySelectorAll("details[open]")].map(
      (node) => node.closest("[data-metric-key]").dataset.metricKey,
    ),
  );
  const html = state.params
    .map((p) => {
      const hasValue = Number.isFinite(p.value);
      const num = hasValue ? fmtNumber(p.value, p.decimals) : "—";
      const stale = !!state.reading && !readingsFresh();
      const status = stale ? "nodata" : p.status;
      const badge = `<span class="badge badge--${status}">${icon(STATUS_ICON[status], 12)}${esc(
        stale ? "Dữ liệu cũ" : p.statusText || STATUS_TEXT[p.status],
      )}</span>`;
      return `
        <article class="card metric" data-status="${status}" data-metric-key="${esc(p.key)}">
          <div class="metric__head">
            <span class="metric__icon">${icon(PARAM_ICON[p.key] || "#i-gauge", 21)}</span>
            <span class="metric__label" title="${esc(p.label)}">${esc(p.key === "temperature" ? "Nhiệt độ nước" : p.key === "turbidity_voltage" ? "Độ đục" : p.short)}</span>
          </div>
          <div class="metric__value">
            <span class="metric__num">${num}</span>
            ${p.unit ? `<span class="metric__unit">${esc(p.unit)}</span>` : ""}
          </div>
          ${badge}
          ${Number.isFinite(p.min) && Number.isFinite(p.max) ? `<span class="metric__range" aria-label="Ngưỡng ${esc(p.rangeLabel)}" title="Ngưỡng cấu hình">${esc(p.rangeLabel)}</span>` : ""}
          ${p.note ? `<details class="metric-details" ${expanded.has(p.key) ? "open" : ""}><summary>${p.key === "tds" ? "Ước tính" : "Chi tiết"}</summary><p>${esc(p.note)}</p></details>` : ""}
          ${trendMarkup(p)}
        </article>`;
    })
    .join("");
  dom.metricGrid.innerHTML = html;
  dom.metricGrid.setAttribute("aria-busy", "false");
}

/* ------------------------------------------------------------------- cảnh báo */

function renderAlerts() {
  if (!state) return;
  const issues = state.issues || [];
  dom.alertsPanel.parentElement.hidden = readingsFresh() && !issues.length;
  dom.alertsPanel.setAttribute("aria-busy", "false");

  if (!issues.length) {
    const hasData = !!state.reading;
    const fresh = readingsFresh();
    dom.alertsPanel.innerHTML = `
      <div class="empty">
        <span class="empty__icon">${icon(fresh ? "#i-check" : "#i-wifi-off", 22)}</span>
        <div><p class="empty__title">${!hasData ? "Chưa có số đo" : !fresh ? `${freshnessLabel()} · Số đo cũ` : "Không có cảnh báo"}</p></div>
      </div>`;
    return;
  }

  const suggestionByReason = new Map(
    (state.suggestions || []).map((s) => [s.reason, s.pump]),
  );
  const rows = issues
    .map((issue) => {
      const pumpKey = suggestionByReason.get(issue.message);
      const def = pumpKey ? pumpDef(pumpKey) : null;
      const action = def
        ? `<div class="alert-row__action">
             <button type="button" class="btn btn--sm btn--on" data-suggest="${esc(def.key)}">
               ${icon("#i-droplet", 14)}Bật ${esc(def.short)}
             </button>
           </div>`
        : "";
      return `
        <li class="alert-row" data-level="${esc(issue.level)}">
          <span class="alert-row__icon">${icon("#i-alert", 18)}</span>
          <div class="alert-row__body">
            <p>${esc(issue.message)}</p>
          </div>
          ${action}
        </li>`;
    })
    .join("");

  dom.alertsPanel.innerHTML = `${readingsFresh() ? "" : '<p class="stale-alert">Cảnh báo từ số đo cũ</p>'}<ul class="alert-list">${rows}</ul>`;
}

/* --------------------------------------------------------------- quản trị viên */

let adminUsers = [];
let adminDevices = [];
let editingUserId = null;

function renderAdmin() {
  if (me?.role !== "admin") return;
  dom.adminUsers.innerHTML = adminUsers.length
    ? adminUsers
        .map(
          (u) => `
          <div class="admin-row">
            <div class="admin-row__main">
              <strong>${esc(u.username)}${u.role === "admin" ? " · quản trị" : ""}</strong>
              <small>${u.devices.length ? esc(u.devices.map((d) => d.name || d.deviceId).join(", ")) : "chưa có thiết bị"}</small>
            </div>
            <span class="admin-row__tag ${u.telegramLinked ? "admin-row__tag--on" : ""}">${u.telegramLinked ? "Telegram" : "chưa link"}</span>
            <span class="admin-row__tag ${u.disabled ? "admin-row__tag--off" : "admin-row__tag--on"}">${u.disabled ? "đã khoá" : "hoạt động"}</span>
            <div class="admin-row__actions">
              <button class="btn btn--sm" type="button" data-user-edit="${u.id}">Sửa</button>
              ${
                u.role === "admin"
                  ? ""
                  : `<button class="btn btn--sm" type="button" data-user-toggle="${u.id}" data-disabled="${u.disabled ? "0" : "1"}">${u.disabled ? "Mở khoá" : "Khoá"}</button>
                     <button class="btn btn--sm btn--off" type="button" data-user-delete="${u.id}">Xoá</button>`
              }
            </div>
          </div>`,
        )
        .join("")
    : '<p class="empty__hint">Chưa có khách hàng.</p>';

  const ownerOptions = adminUsers
    .filter((u) => !u.disabled)
    .map((u) => `<option value="${u.id}">${esc(u.username)}</option>`)
    .join("");
  if (dom.adminDeviceOwner.innerHTML !== ownerOptions) {
    dom.adminDeviceOwner.innerHTML = ownerOptions;
  }

  dom.adminDevices.innerHTML = adminDevices.length
    ? adminDevices
        .map(
          (d) => `
          <div class="admin-row">
            <div class="admin-row__main">
              <strong>${esc(d.name || d.deviceId)}</strong>
              <small>${esc(d.deviceId)} · ${esc(d.owner || "chưa gán")}</small>
            </div>
            <span class="admin-row__tag ${d.online ? "admin-row__tag--on" : "admin-row__tag--off"}">${d.online ? "trực tuyến" : "offline"}</span>
            <div class="admin-row__actions">
              <button class="btn btn--sm" type="button" data-device-rotate="${esc(d.deviceId)}">Đổi khoá</button>
              <button class="btn btn--sm" type="button" data-device-rename="${esc(d.deviceId)}">Đổi tên</button>
              <button class="btn btn--sm btn--off" type="button" data-device-delete="${esc(d.deviceId)}">Xoá</button>
            </div>
          </div>`,
        )
        .join("")
    : '<p class="empty__hint">Chưa cấp thiết bị nào.</p>';
}

async function loadAdmin() {
  if (me?.role !== "admin") return;
  try {
    const [users, devices] = await Promise.all([api.listUsers(), api.getDevices()]);
    adminUsers = users.users;
    adminDevices = devices.devices;
    renderAdmin();
  } catch (err) {
    toast(err.message, "error");
  }
}

/** Hiện thông tin nạp firmware — khoá chỉ có ở đây một lần duy nhất. */
function showDeviceSecret(deviceId, deviceKey) {
  dom.adminSecretId.textContent = deviceId;
  dom.adminSecretKey.textContent = deviceKey;
  dom.adminSecret.hidden = false;
  dom.adminSecret.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function openUserForm(user) {
  editingUserId = user?.id ?? null;
  dom.adminUserFormTitle.textContent = user ? `Sửa ${user.username}` : "Thêm khách hàng";
  dom.adminUserName.value = user?.username ?? "";
  dom.adminUserName.disabled = Boolean(user);
  dom.adminUserPass.value = "";
  dom.adminUserPassLabel.textContent = user
    ? "Mật khẩu mới (bỏ trống nếu giữ nguyên)"
    : "Mật khẩu";
  dom.adminUserError.textContent = "";
  dom.adminUserForm.hidden = false;
  (user ? dom.adminUserPass : dom.adminUserName).focus();
}

/* ------------------------------------------------------------------ telegram */

function renderTelegram() {
  const tg = state?.telegram;
  if (!tg) return;
  const label = tg.notifyLevel === "warn" ? "cảnh báo và nguy hiểm" : "chỉ mức nguy hiểm";
  let text = "Chưa kết nối.";
  if (!tg.enabled) text = "Máy chủ chưa cấu hình bot Telegram (TELEGRAM_BOT_TOKEN).";
  else if (!tg.linked)
    text = `Bấm “Liên kết Telegram” để nhận cảnh báo riêng cho tài khoản này (${label}).`;
  else if (tg.mute?.muted)
    text = `🔕 Đang tạm tắt thông báo ${
      tg.mute.forever ? "đến khi bạn bật lại" : `còn ${fmtDuration(Math.round(tg.mute.remainingMs / 1000))}`
    } · gõ /bat trong bot để bật lại ngay.`;
  else
    text = `Đang báo ${label} · đã gửi ${tg.sentCount} tin. Nhắc lại mỗi 30 phút (vàng) và 10 phút (đỏ) khi vẫn còn xấu.`;
  if (tg.lastError) text += ` Lỗi gần nhất: ${tg.lastError}`;
  dom.telegramStatus.textContent = text;
  dom.telegramTest.disabled = !tg.ready || sending.has("telegram");
  dom.telegramLink.disabled = !tg.enabled || sending.has("telegram") || tg.linked;
  dom.telegramUnlink.hidden = !tg.linked;
  dom.telegramUnlink.disabled = sending.has("telegram");
}

/** Hiện mã liên kết kèm lệnh /start để người dùng sao chép sang Telegram. */
function showTelegramCode(result) {
  dom.telegramCommand.textContent = `/start ${result.code}`;
  dom.telegramBot.textContent = result.botUsername ? `@${result.botUsername}` : "bot của hệ thống";
  dom.telegramCode.hidden = false;
  dom.telegramLink.disabled = true;
}

/* -------------------------------------------------------------- danh sách bể */

function renderDevicePicker() {
  const devices = state?.devices ?? [];
  if (!devices.length) {
    dom.deviceSelect.innerHTML = '<option value="">Chưa có thiết bị</option>';
    dom.deviceSelect.disabled = true;
    return;
  }
  dom.deviceSelect.disabled = false;
  const signature = JSON.stringify(devices.map((d) => [d.deviceId, d.name, d.online]));
  if (signature === devicePickerSignature) return;
  devicePickerSignature = signature;
  dom.deviceSelect.innerHTML = devices
    .map(
      (d) =>
        `<option value="${esc(d.deviceId)}"${d.deviceId === state.device.id ? " selected" : ""}>${esc(
          d.name || d.deviceId,
        )}${d.online ? " · trực tuyến" : " · mất kết nối"}</option>`,
    )
    .join("");
}

function renderAccount() {
  if (!me) return;
  dom.accountChip.textContent =
    me.role === "admin" ? `${me.username} · quản trị` : me.username;
  dom.adminSection.hidden = me.role !== "admin";
}

/** Đổi bể đang xem: cắt luồng SSE cũ rồi mở luồng mới cho thiết bị đó. */
async function switchDevice(deviceId) {
  if (!deviceId || deviceId === state?.device?.id) return;
  setActiveDevice(deviceId);
  state = null;
  relaySignature = "";
  devicePickerSignature = "";
  trends.clear();
  trendSignature = "";
  closeStream();
  await refresh();
  loadChart();
  seedTrends();
  connectStream();
}

/* ------------------------------------------------------------------ điều khiển */

function renderPumps() {
  if (!state) return;
  const online = deviceReachable();
  const allConfirmed = online && state.pumps.every((p) => p.confirmed);
  dom.relayCount.innerHTML = `${allConfirmed ? state.pumps.filter((p) => p.on).length : "—"} <small>/ 3</small>`;
  dom.relayFeedback.textContent = allConfirmed
    ? "Đã xác nhận"
    : "Chưa xác nhận";
  dom.stopAll.disabled =
    !online || !state.pumps.some((p) => p.available) || sending.has("all");
  // Preserve focused buttons while sensor telemetry/countdowns update in place.
  const signature = JSON.stringify([
    online,
    state.water?.synced,
    state.water?.busy,
    state.water?.stage,
    state.water?.settings?.tankLiters,
    [...sending],
    state.pumps.map((p) => [
      p.key,
      p.on,
      p.confirmed,
      p.available,
      p.pending,
      p.pendingAction,
      p.error,
      p.source,
    ]),
  ]);
  if (signature === relaySignature) {
    tickPumps();
    return;
  }
  relaySignature = signature;
  pumpRefs.clear();

  dom.pumpGrid.innerHTML = state.pumps
    .map((p) => {
      const busy = p.pending || sending.has(p.key) || sending.has("all");
      const waterReady = p.kind === "light" || !state.water?.supported || (state.water.synced && state.water.settings.tankLiters && !state.water.busy && !["unknown", "error"].includes(state.water.stage));
      const canOn = online && p.available && !busy && waterReady && (!p.confirmed || !p.on);
      const canOff = online && p.available;
      const confirmedOn = online && p.confirmed && p.on;
      const stateText = !online
        ? "Mất kết nối"
        : !p.available
          ? "Chưa hỗ trợ"
          : !p.confirmed
            ? "Chưa xác nhận"
            : p.on
              ? p.kind === "light"
                ? "Đang sáng"
                : "Đang chạy"
              : "Đang tắt";
      const isSending = sending.has(p.key) || sending.has("all");
      const action = isSending
        ? sendingActions.get(p.key) || "off"
        : p.pendingAction;
      const commandText = isSending
        ? `Đang gửi lệnh ${action === "off" ? "tắt" : "bật"}…`
        : `Chờ ESP32 xác nhận ${action === "off" ? "tắt" : "bật"}`;
      const symbol =
        p.kind === "light"
          ? "#i-light"
          : p.key === "fill"
            ? "#i-plus"
            : "#i-minus";
      return `
        <article class="card pump${confirmedOn ? " is-on" : ""}${online && p.available ? "" : " is-offline"}" data-pump="${esc(p.key)}" data-kind="${esc(p.kind)}" aria-busy="${busy}">
          <div class="relay-topline"><span class="relay-channel">KÊNH 0${esc(p.relayChannel)}</span><span class="pump__state" role="status"><span class="relay-dot"></span>${esc(stateText)}</span></div>
          <div class="pump__heading"><span class="device-icon" aria-hidden="true">${icon(symbol, 25)}</span><h3 class="pump__title">${esc(p.label)}</h3></div>
          ${online && busy ? `<p class="command-feedback" role="status">${icon("#i-clock", 13)}${commandText}</p>` : ""}
          <div class="pump__meta"><span>Tối đa ${esc(fmtDuration(p.maxRunSeconds))}</span></div>
          <div class="pump__progress"><div class="pump__progress-fill" data-fill></div></div>
          <p class="pump__timer" data-timer></p>
          ${p.error ? `<p class="relay-error" role="alert">${esc(p.error)}</p>` : ""}
          <div class="pump__actions">
            <button type="button" class="btn btn--on" data-action="on" ${canOn ? "" : "disabled"}>${icon("#i-power", 15)}Bật có hẹn giờ</button>
            <button type="button" class="btn btn--off" data-action="off" ${canOff ? "" : "disabled"}>Tắt</button>
          </div>
          <button type="button" class="relay-test" data-action="test" ${canOn ? "" : "disabled"}>Thử 3 giây <span aria-hidden="true">↗</span></button>
        </article>`;
    })
    .join("");

  for (const p of state.pumps) {
    const card = dom.pumpGrid.querySelector(`[data-pump="${p.key}"]`);
    if (!card) continue;
    pumpRefs.set(p.key, {
      card,
      stateEl: card.querySelector(".pump__state"),
      timer: card.querySelector("[data-timer]"),
      fill: card.querySelector("[data-fill]"),
      onButton: card.querySelector('[data-action="on"]'),
      offButton: card.querySelector('[data-action="off"]'),
    });
  }

  dom.pumpGrid.setAttribute("aria-busy", "false");
  if (!online) {
    dom.pumpGrid.title =
      "Mất kết nối. Trạng thái hiện tại của relay chưa được xác nhận.";
  } else {
    dom.pumpGrid.removeAttribute("title");
  }
  tickPumps();
}

/* --------------------------------------------------------------- tab + biểu đồ */

function buildTabs() {
  if (!state) return;
  const signature = state.params.map((p) => p.key).join(",");
  if (signature === tabsSignature) return;
  if (!state.params.some((p) => p.key === currentMetric)) {
    currentMetric =
      currentMetric === "turbidity" ? "turbidity_voltage" : "temperature";
  }
  dom.metricTabs.innerHTML = state.params
    .map(
      (p) =>
        `<button type="button" class="tab" role="tab" data-metric="${esc(p.key)}" aria-selected="${p.key === currentMetric}" aria-controls="chart">${esc(p.short)}</button>`,
    )
    .join("");
  dom.rangeTabs.innerHTML = Object.entries(RANGE_LABELS)
    .map(
      ([key, label]) =>
        `<button type="button" class="tab" role="tab" data-range="${key}" aria-selected="${key === currentRange}" aria-controls="chart">${esc(label)}</button>`,
    )
    .join("");
  tabsSignature = signature;
}

function syncTabs() {
  for (const btn of dom.metricTabs.querySelectorAll("[data-metric]")) {
    btn.setAttribute(
      "aria-selected",
      String(btn.dataset.metric === currentMetric),
    );
    btn.tabIndex = btn.dataset.metric === currentMetric ? 0 : -1;
  }
  for (const btn of dom.rangeTabs.querySelectorAll("[data-range]")) {
    btn.setAttribute(
      "aria-selected",
      String(btn.dataset.range === currentRange),
    );
    btn.tabIndex = btn.dataset.range === currentRange ? 0 : -1;
  }
}

async function loadChart() {
  const token = ++chartToken;
  syncTabs();
  dom.chartSummary.textContent = "Đang tải…";
  try {
    const data = await api.getHistory(currentMetric, currentRange);
    if (token !== chartToken) return;
    const def = paramDef(currentMetric);
    dom.chartCurrentLabel.textContent = `${def ? def.label : data.metric}${data.unit ? ` · ${data.unit}` : ""}`;
    dom.chartSafeLegend.hidden =
      !Number.isFinite(data.safeRange.min) ||
      !Number.isFinite(data.safeRange.max);
    chart.setData(data.points, {
      unit: data.unit,
      decimals: data.decimals,
      safeRange: { low: data.safeRange.min, high: data.safeRange.max },
      rangeMs: data.to - data.from,
      label: def ? def.label : data.metric,
    });

    if (!data.points.length) {
      dom.chartSummary.textContent = "Chưa có dữ liệu trong khoảng này.";
      return;
    }
    const values = data.points
      .map((p) => p.avg)
      .filter((v) => Number.isFinite(v));
    if (!values.length) {
      dom.chartSummary.textContent = "Chưa có số đo hợp lệ trong khoảng này.";
      return;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    dom.chartSummary.textContent = `TB ${fmtNumber(avg, data.decimals)} · Min ${fmtNumber(min, data.decimals)} · Max ${fmtNumber(max, data.decimals)}${data.unit ? ` ${data.unit}` : ""}`;
    dom.chartSummary.title = `${data.points.length} điểm dữ liệu`;
  } catch (err) {
    if (token !== chartToken) return;
    chart.setData([], null);
    dom.chartSummary.textContent =
      "Không tải được lịch sử. Hãy thử chọn lại khoảng thời gian.";
    toast(err.message, "error");
  }
}

/* ------------------------------------------------------------------- nhật ký */

function renderLogs() {
  if (!state) return;

  const alerts = state.recentAlerts || [];
  dom.alertLog.innerHTML = alerts.length
    ? `<table class="log-table">
        <thead><tr><th scope="col">Thời gian</th><th scope="col">Mức</th><th scope="col">Nội dung</th></tr></thead>
        <tbody>${alerts
          .map(
            (a) => `<tr>
              <td class="mono" title="${esc(fmtDateTime(a.ts))}">${esc(fmtClock(a.ts))}</td>
              <td><span class="badge badge--${esc(a.level === "critical" ? "critical" : "warn")}">${esc(
                a.level === "critical" ? "Nguy hiểm" : "Cảnh báo",
              )}</span></td>
              <td>${esc(a.message)}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table>`
    : '<p class="empty__hint">Chưa có cảnh báo</p>';

  const events = state.recentPumpEvents || [];
  dom.pumpLog.innerHTML = events.length
    ? `<table class="log-table">
        <thead><tr><th scope="col">Thời gian</th><th scope="col">Thiết bị</th><th scope="col">Lệnh gửi</th><th scope="col">Nguồn</th><th scope="col">Thời lượng</th></tr></thead>
        <tbody>${events
          .map((e) => {
            const def = pumpDef(e.pump);
            const name = def ? def.short : ({ water_change: 'Thay nước', settings: 'Cấu hình bể' }[e.pump] || e.pump);
            return `<tr>
              <td class="mono" title="${esc(fmtDateTime(e.ts))}">${esc(fmtClock(e.ts))}</td>
              <td>${esc(name)}</td>
              <td>${esc(PUMP_ACTION_TEXT[e.action] || e.action)}</td>
              <td title="${esc(e.note || "")}">${esc(PUMP_SOURCE_TEXT[e.source] || e.source)}</td>
              <td class="mono">${e.durationS ? esc(fmtDuration(e.durationS)) : "—"}</td>
            </tr>`;
          })
          .join("")}</tbody>
      </table>`
    : '<p class="empty__hint">Chưa có lệnh</p>';
}

/* ------------------------------------------------------------- cập nhật mỗi giây */

function tickPumps() {
  if (!state) return;
  for (const p of state.pumps) {
    const refs = pumpRefs.get(p.key);
    if (!refs) continue;
    if (!deviceReachable()) {
      refs.timer.textContent = "";
      refs.fill.style.width = "0%";
    } else if (p.pending) {
      refs.timer.textContent = "";
    } else if (!p.confirmed) {
      refs.timer.textContent = "";
      refs.fill.style.width = "0%";
    } else if (p.on && p.since) {
      const elapsed = Math.max(0, Math.round((Date.now() - p.since) / 1000));
      const remaining = p.offAt
        ? Math.max(0, Math.ceil((p.offAt - Date.now()) / 1000))
        : null;
      refs.timer.textContent =
        remaining === null
          ? "Chưa có thời gian còn lại"
          : remaining === 0
            ? "Hết giờ · Chờ xác nhận tắt"
            : `Tự tắt sau ${fmtDuration(remaining)}${p.source === "serial" ? " · thử qua Serial" : ""}`;
      const ratio = Math.min(1, elapsed / Math.max(1, p.maxRunSeconds));
      refs.fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    } else {
      refs.timer.textContent = "";
      refs.fill.style.width = "0%";
    }
  }
}

function tick() {
  if (!state) return;
  renderConnection();
  renderOverview();
  renderLastUpdate();
  renderPumps();
  const freshness = `${readingsFresh()}-${deviceReachable()}`;
  if (freshness !== previousFreshness) {
    previousFreshness = freshness;
    renderMetrics();
    renderAlerts();
  }
}

/* ------------------------------------------------------------------ điều khiển */

function openPumpDialog(pumpKey) {
  const pump = state?.pumps?.find((p) => p.key === pumpKey);
  const def = pumpDef(pumpKey);
  if (
    !pump ||
    !def ||
    !pump.available ||
    pump.pending ||
    sending.has(pumpKey) ||
    sending.has("all") ||
    !deviceReachable()
  )
    return;

  pendingPump = pumpKey;
  dom.dialog.returnValue = "";
  dom.dialogTitle.textContent = `Bật ${def.label.toLowerCase()}`;
  dom.dialogDesc.textContent = def.description;
  dom.dialogNote.textContent =
    def.kind === "light"
      ? "Tự tắt khi hết giờ."
      : "Bơm nước còn lại sẽ tắt. Lưu lượng 96 lít/giờ, tương đương 37,5 giây/lít. Tự tắt khi hết giờ.";
  dom.dialogConfirm.textContent = `Bật ${def.short}`;

  const choices = def.durations;
  const defaultSeconds = def.defaultSeconds;
  dom.durationChoices.innerHTML = choices
    .map((s) => {
      const id = `dur-${s}`;
      return `<label class="choice" for="${id}">
        <input type="radio" id="${id}" name="duration" value="${s}" ${s === defaultSeconds ? "checked" : ""} />
        <span>${fmtDuration(s)}</span>
      </label>`;
    })
    .join("");

  $("pump-seconds").value = defaultSeconds;
  dom.dialog.showModal();
}

async function sendPumpCommand(pumpKey, action, seconds) {
  const def = pumpDef(pumpKey);
  if (!deviceReachable()) {
    toast("Thiết bị ESP32 đang mất kết nối nên không thể điều khiển.", "error");
    return;
  }
  sending.add(pumpKey);
  sendingActions.set(pumpKey, action);
  renderPumps();
  try {
    await api.controlPump(pumpKey, action, seconds);
    toast(
      action === "on"
        ? `Đã gửi lệnh bật ${def ? def.short : pumpKey} trong ${fmtDuration(seconds)}.`
        : `Đã gửi lệnh tắt ${def ? def.short : pumpKey}.`,
      "success",
    );
    await refresh();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    sending.delete(pumpKey);
    sendingActions.delete(pumpKey);
    renderPumps();
  }
}

/* ------------------------------------------------------------------- vòng đời */

function render() {
  if (!state) return;
  buildTabs();
  renderConnection();
  renderDevicePicker();
  renderOverview();
  renderLastUpdate();
  renderMetrics();
  renderAlerts();
  renderTelegram();
  renderPumps();
  renderWater(state, deviceReachable());
  renderLogs();
}

function applyState(next) {
  const previousTs = state?.reading?.ts;
  state = next;
  snapshotReceivedAt = Date.now();
  recordTrends();
  render();
  const keys = state.params.map((p) => p.key).join(",");
  if (keys !== trendSignature) {
    trendSignature = keys;
    seedTrends();
  }
  if (state.reading?.ts !== previousTs) loadChart();
}

async function refresh() {
  try {
    applyState(await api.getState());
  } catch (err) {
    toast(err.message, "error");
  }
}

let streamSource = null;

function closeStream() {
  if (streamSource) {
    streamSource.close();
    streamSource = null;
  }
}

function connectStream() {
  closeStream();
  const source = new EventSource(
    activeDevice()
      ? `/api/stream?device=${encodeURIComponent(activeDevice())}`
      : "/api/stream",
  );
  streamSource = source;
  source.addEventListener("open", () => {
    streamConnected = true;
    render();
  });
  source.addEventListener("state", (event) => {
    try {
      streamConnected = true;
      applyState(JSON.parse(event.data));
    } catch {
      /* bỏ qua bản tin hỏng */
    }
  });
  source.addEventListener("error", async () => {
    if (!state) return;
    streamConnected = false;
    render();
    try {
      const res = await fetch("/api/me", { credentials: "same-origin" });
      if (res.status === 401) window.location.replace("/login");
    } catch {
      /* mạng đang có sự cố, EventSource sẽ tự thử lại */
    }
  });
}

function bindEvents() {
  bindWater({ api, refresh, toast });
  dom.durationChoices.addEventListener("change", (event) => { $("pump-seconds").value = event.target.value; });
  for (const tabs of [dom.metricTabs, dom.rangeTabs]) {
    tabs.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      const buttons = [...tabs.querySelectorAll('[role="tab"]')];
      const index = buttons.indexOf(event.target);
      if (index < 0) return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
              buttons.length;
      buttons[next].click();
      buttons[next].focus();
    });
  }
  const galleryDialog = $("gallery-dialog");
  $("aquarium-gallery").addEventListener("click", (event) => {
    const button = event.target.closest("[data-image]");
    if (!button) return;
    $("gallery-dialog-image").src = button.dataset.image;
    $("gallery-dialog-image").alt = button.dataset.alt;
    $("gallery-dialog-caption").textContent = button.dataset.caption;
    galleryDialog.showModal();
  });
  document.querySelector(".nav-links").addEventListener("click", (event) => {
    const link = event.target.closest(".nav-link");
    if (!link) return;
    for (const item of document.querySelectorAll(".nav-link")) {
      item.classList.toggle("is-active", item === link);
      if (item === link) item.setAttribute("aria-current", "location");
      else item.removeAttribute("aria-current");
    }
  });
  dom.pumpGrid.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;
    const card = button.closest("[data-pump]");
    if (!card) return;
    const pumpKey = card.dataset.pump;
    if (button.dataset.action === "on") openPumpDialog(pumpKey);
    else if (button.dataset.action === "test")
      sendPumpCommand(pumpKey, "on", 3);
    else sendPumpCommand(pumpKey, "off");
  });

  dom.stopAll.addEventListener("click", async () => {
    if (!deviceReachable()) return;
    sending.add("all");
    renderPumps();
    try {
      await api.stopAll();
      toast("Đã gửi lệnh tắt cả ba kênh. Đang chờ ESP32 xác nhận.");
      await refresh();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      sending.delete("all");
      renderPumps();
    }
  });

  dom.alertsPanel.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-suggest]");
    if (button) openPumpDialog(button.dataset.suggest);
  });

  dom.telegramTest.addEventListener("click", async () => {
    sending.add("telegram");
    renderTelegram();
    try {
      await api.testTelegram();
      toast("Đã gửi tin thử tới Telegram.");
      await refresh();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      sending.delete("telegram");
      renderTelegram();
    }
  });

  dom.telegramLink.addEventListener("click", async () => {
    sending.add("telegram");
    renderTelegram();
    try {
      showTelegramCode(await api.linkTelegram());
    } catch (err) {
      toast(err.message, "error");
    } finally {
      sending.delete("telegram");
      renderTelegram();
    }
  });

  dom.telegramUnlink.addEventListener("click", async () => {
    sending.add("telegram");
    renderTelegram();
    try {
      await api.unlinkTelegram();
      dom.telegramCode.hidden = true;
      toast("Đã ngắt liên kết Telegram.");
      await refresh();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      sending.delete("telegram");
      renderTelegram();
    }
  });

  dom.deviceSelect.addEventListener("change", () => {
    switchDevice(dom.deviceSelect.value);
  });

  /* ------------------------------------------------------------- quản trị */

  dom.adminNewUser.addEventListener("click", () => openUserForm(null));

  dom.adminNewDevice.addEventListener("click", () => {
    dom.adminDeviceError.textContent = "";
    dom.adminDeviceName.value = "";
    dom.adminDeviceForm.hidden = false;
    dom.adminDeviceOwner.focus();
  });

  dom.adminUserCancel.addEventListener("click", () => {
    dom.adminUserForm.hidden = true;
    editingUserId = null;
  });

  dom.adminDeviceCancel.addEventListener("click", () => {
    dom.adminDeviceForm.hidden = true;
  });

  dom.adminSecretClose.addEventListener("click", () => {
    dom.adminSecret.hidden = true;
    dom.adminSecretKey.textContent = "";
  });

  dom.adminUserForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = dom.adminUserName.value.trim();
    const password = dom.adminUserPass.value;
    dom.adminUserSave.disabled = true;
    dom.adminUserError.textContent = "";
    try {
      if (editingUserId) {
        const patch = {};
        if (password) patch.password = password;
        await api.updateUser(editingUserId, patch);
        toast("Đã cập nhật tài khoản.");
      } else {
        if (!username) throw new Error("Vui lòng nhập tên đăng nhập.");
        await api.createUser(username, password);
        toast(`Đã tạo tài khoản ${username}.`);
      }
      dom.adminUserForm.hidden = true;
      editingUserId = null;
      await loadAdmin();
    } catch (err) {
      dom.adminUserError.textContent = err.message;
    } finally {
      dom.adminUserSave.disabled = false;
    }
  });

  dom.adminDeviceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const ownerId = Number(dom.adminDeviceOwner.value);
    if (!ownerId) {
      dom.adminDeviceError.textContent = "Chưa có khách hàng để cấp thiết bị.";
      return;
    }
    dom.adminDeviceError.textContent = "";
    try {
      const result = await api.createDevice(ownerId, dom.adminDeviceName.value.trim());
      dom.adminDeviceForm.hidden = true;
      showDeviceSecret(result.device.deviceId, result.deviceKey);
      toast(`Đã cấp thiết bị ${result.device.deviceId}.`);
      await loadAdmin();
    } catch (err) {
      dom.adminDeviceError.textContent = err.message;
    }
  });

  dom.adminUsers.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const editId = button.dataset.userEdit;
    const toggleId = button.dataset.userToggle;
    const deleteId = button.dataset.userDelete;
    try {
      if (editId) {
        openUserForm(adminUsers.find((u) => String(u.id) === editId));
      } else if (toggleId) {
        await api.updateUser(Number(toggleId), {
          disabled: button.dataset.disabled === "1",
        });
        await loadAdmin();
      } else if (deleteId) {
        const target = adminUsers.find((u) => String(u.id) === deleteId);
        if (!confirm(`Xoá tài khoản ${target?.username ?? deleteId}?`)) return;
        await api.deleteUser(Number(deleteId));
        toast("Đã xoá tài khoản.");
        await loadAdmin();
      }
    } catch (err) {
      toast(err.message, "error");
    }
  });

  dom.adminDevices.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const { deviceRotate, deviceRename, deviceDelete } = button.dataset;
    try {
      if (deviceRotate) {
        if (!confirm("Đổi khoá thiết bị? Firmware đang chạy sẽ mất kết nối cho tới khi nạp khoá mới.")) return;
        const result = await api.rotateDeviceKey(deviceRotate);
        showDeviceSecret(result.deviceId, result.deviceKey);
        toast("Đã tạo khoá mới.");
      } else if (deviceRename) {
        const current = adminDevices.find((d) => d.deviceId === deviceRename);
        const name = prompt("Tên mới cho bể:", current?.name ?? "");
        if (name === null) return;
        await api.updateDevice(deviceRename, { name: name.trim() });
        await loadAdmin();
      } else if (deviceDelete) {
        if (!confirm(`Xoá thiết bị ${deviceDelete}? Số đo và nhật ký của bể này sẽ bị xoá.`)) return;
        await api.deleteDevice(deviceDelete);
        toast("Đã xoá thiết bị.");
        await loadAdmin();
      }
    } catch (err) {
      toast(err.message, "error");
    }
  });

  dom.dialog.addEventListener("close", () => {
    if (dom.dialog.returnValue !== "ok" || !pendingPump) {
      pendingPump = null;
      return;
    }
    const checked = dom.durationChoices.querySelector(
      'input[name="duration"]:checked',
    );
    const seconds = Number($("pump-seconds").value);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) { toast("Thời gian phải từ 1 đến 3600 giây.", "error"); pendingPump = null; return; }
    const pumpKey = pendingPump;
    pendingPump = null;
    sendPumpCommand(pumpKey, "on", seconds);
  });

  dom.metricTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-metric]");
    if (!button) return;
    currentMetric = button.dataset.metric;
    loadChart();
  });

  dom.rangeTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-range]");
    if (!button) return;
    currentRange = button.dataset.range;
    loadChart();
  });

  dom.logout.addEventListener("click", async () => {
    try {
      await api.logout();
    } catch {
      /* dù lỗi vẫn đưa về trang đăng nhập */
    }
    window.location.replace("/login");
  });
}

async function start() {
  bindEvents();
  try {
    me = await api.me();
  } catch {
    return; // api.me tự chuyển về /login khi phiên hết hạn
  }
  renderAccount();
  await refresh();
  // Nạp danh sách khách hàng/thiết bị ngay, kể cả khi tài khoản quản trị chưa
  // được cấp thiết bị (trước đây dòng này nằm sau lệnh return nên danh sách trống).
  if (me.role === "admin") await loadAdmin();
  if (!state) {
    // Tài khoản chưa được cấp thiết bị: vẫn hiện khung, chờ quản trị viên cấp.
    dom.metricGrid.innerHTML =
      '<p class="empty__hint">Tài khoản chưa được cấp thiết bị nào. Liên hệ quản trị viên.</p>';
    dom.pumpGrid.innerHTML = "";
    return;
  }
  setActiveDevice(state.device.id);
  loadChart();
  connectStream();
  setInterval(tick, 1000);
  setInterval(seedTrends, 60_000);
}

start();
