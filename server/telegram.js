/**
 * Bot Telegram nhiều khách hàng.
 *
 * Mỗi tài khoản tự liên kết chat id riêng: vào web bấm "Liên kết Telegram" để lấy
 * mã 8 ký tự, mở bot và gửi `/start <mã>`. Bot lưu chat id vào tài khoản đó, từ đó
 * chỉ nhắn cho đúng người sở hữu thiết bị — không ai thấy dữ liệu của người khác.
 *
 * Nguyên tắc chống spam: báo khi một thông số CHUYỂN vào vùng vàng/đỏ, sau đó nhắc
 * lại theo chu kỳ chừng nào còn xấu (vàng 30 phút, đỏ 10 phút — xem config.telegram.repeatMs).
 * Người dùng tạm tắt được ngay trong bot: 30 phút / 1 giờ / 2 giờ / đến khi bật lại / tuỳ chỉnh.
 * Trạng thái theo dõi tách riêng cho từng cặp thiết bị + chat id.
 *
 * Không có TELEGRAM_BOT_TOKEN thì module im lặng hoàn toàn; mọi thứ khác vẫn chạy.
 */
import { config, PARAMS } from './config.js';
import { bus, EVENTS } from './bus.js';
import * as db from './db.js';

const RANK = { good: 0, nodata: 0, unrated: 0, warn: 1, critical: 2 };

/** Mốc "tắt đến khi bật lại" — dùng một giá trị rất xa thay vì thêm cột thứ hai. */
export const MUTE_FOREVER = Number.MAX_SAFE_INTEGER;

/**
 * Quyết định lần đọc này cần gửi tin nào.
 * `tracker` là Map(param -> {level, lastSentAt}) của lần đọc trước.
 * Trả về tracker mới (đã bỏ tham số hết xấu) và danh sách tin cần gửi.
 * Tách riêng khỏi mạng để kiểm thử được.
 */
export function planNotifications(tracker, issues, now, opts = {}) {
  const minRank = RANK[opts.minLevel] ?? 1;
  const repeatMs = opts.repeatMs ?? {};
  const next = new Map();
  const sends = [];
  for (const issue of issues ?? []) {
    const rank = RANK[issue.level] ?? 0;
    if (rank < minRank) continue;

    const prev = tracker.get(issue.param);
    // Lên cấp (vàng -> đỏ) thì báo ngay, không chờ hết chu kỳ.
    const escalated = prev && rank > (RANK[prev.level] ?? 0);
    const due = prev && now - prev.lastSentAt >= (repeatMs[issue.level] ?? Infinity);

    if (!prev || escalated || due) {
      sends.push({ issue, reminder: Boolean(prev) });
      next.set(issue.param, { level: issue.level, lastSentAt: now });
    } else {
      next.set(issue.param, prev);
    }
  }
  return { next, sends };
}

/** Trạng thái tắt thông báo của một tài khoản. */
export function muteInfo(user, now = Date.now()) {
  const until = Number(user?.notifyMutedUntil) || 0;
  if (!until || until <= now) return { muted: false, until: 0, forever: false, remainingMs: 0 };
  return { muted: true, until, forever: until >= MUTE_FOREVER, remainingMs: until - now };
}

const state = {
  enabled: Boolean(config.telegram.token),
  lastSentAt: null,
  lastError: null,
  sentCount: 0,
  botUsername: null,
};

const api = (method) => `${config.telegram.apiBase}/bot${config.telegram.token}/${method}`;

async function callTelegram(method, body) {
  const res = await fetch(api(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.description || `Telegram HTTP ${res.status}`);
  }
  return data.result;
}

const clock = (ts) =>
  new Date(ts).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
  });

export function formatAlert(issue, extra = {}) {
  const icon = issue.level === 'critical' ? '🚨' : '⚠️';
  const title = issue.level === 'critical' ? 'NGUY HIỂM' : 'CẢNH BÁO';
  const lines = [
    `${extra.reminder ? '🔁 Nhắc lại · ' : ''}${icon} ${title} — ${extra.deviceName || extra.deviceId || 'bể cá'}`,
    '',
    issue.message,
    '',
    `Lúc: ${clock(extra.ts || Date.now())}`,
    `Mở bảng điều khiển: ${config.telegram.publicUrl}`,
    'Gõ /tat để tạm tắt thông báo.',
  ];
  return lines.join('\n');
}

async function sendToChat(chatId, text, replyMarkup = null) {
  await callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  state.lastSentAt = Date.now();
  state.lastError = null;
  state.sentCount += 1;
}

const MUTE_CHOICES = [
  { text: 'Tắt 30 phút', minutes: 30 },
  { text: 'Tắt 1 giờ', minutes: 60 },
  { text: 'Tắt 2 giờ', minutes: 120 },
];

/** Bàn phím chọn thời gian tắt thông báo; `muted` để hiện nút bật lại. */
function muteKeyboard(muted) {
  const rows = [
    MUTE_CHOICES.slice(0, 2).map((c) => ({ text: c.text, callback_data: `mute:${c.minutes}` })),
    MUTE_CHOICES.slice(2).map((c) => ({ text: c.text, callback_data: `mute:${c.minutes}` })),
    [
      { text: 'Tắt đến khi bật lại', callback_data: 'mute:forever' },
      { text: 'Tuỳ chỉnh…', callback_data: 'mute:custom' },
    ],
  ];
  if (muted) rows.push([{ text: '🔔 Bật lại ngay', callback_data: 'mute:off' }]);
  return { inline_keyboard: rows };
}

export function muteStatusText(user, now = Date.now()) {
  const info = muteInfo(user, now);
  if (!info.muted) return '🔔 Đang nhận thông báo.';
  if (info.forever) return '🔕 Đang tắt thông báo đến khi bạn bật lại.';
  return `🔕 Đang tắt thông báo tới ${clock(info.until)} (còn ${Math.ceil(info.remainingMs / 60000)} phút).`;
}

/** Gửi thử cho đúng tài khoản đang đăng nhập. */
export async function sendTest(user) {
  if (!state.enabled) throw new Error('Máy chủ chưa cấu hình TELEGRAM_BOT_TOKEN.');
  if (!user?.telegramChatId) throw new Error('Tài khoản chưa liên kết Telegram.');
  await sendToChat(
    user.telegramChatId,
    `✅ Aqua Control đã kết nối được với Telegram của bạn.\nTài khoản: ${user.username}\nMức thông báo: ${config.telegram.notifyLevel === 'warn' ? 'cảnh báo và nguy hiểm' : 'chỉ mức nguy hiểm'}`,
  );
  return publicState(user);
}

export function publicState(user = null) {
  return {
    enabled: state.enabled,
    ready: state.enabled && Boolean(user?.telegramChatId),
    linked: Boolean(user?.telegramChatId),
    linkedAt: user?.telegramLinkedAt ?? null,
    notifyLevel: config.telegram.notifyLevel,
    mute: muteInfo(user),
    botUsername: state.botUsername,
    sentCount: state.sentCount,
    lastSentAt: state.lastSentAt,
    lastError: state.lastError,
  };
}

/**
 * Theo dõi tin nhắn tới bot. Người dùng gửi `/start <mã>` để liên kết tài khoản.
 * Dùng long polling 25 giây nên không cần mở cổng công khai hay webhook HTTPS.
 */
let pollTimer = null;
let polling = false;
let offset = 0;

/** Chat id -> thời điểm hỏi "mấy phút?" cho lựa chọn tắt tuỳ chỉnh. */
const pendingMute = new Map();

/** Xử lý nút bấm inline (tắt thông báo). */
async function handleCallback(query) {
  const chatId = query.message?.chat?.id;
  const data = query.data ?? '';
  const ack = (text) =>
    callTelegram('answerCallbackQuery', { callback_query_id: query.id, ...(text ? { text } : {}) })
      .catch(() => {});
  const user = chatId ? db.getUserByChatId(chatId) : null;
  if (!user) {
    await ack('Chat này chưa liên kết tài khoản.');
    return;
  }
  if (!data.startsWith('mute:')) {
    await ack();
    return;
  }

  const choice = data.slice('mute:'.length);
  if (choice === 'custom') {
    pendingMute.set(chatId, Date.now());
    await ack('Gửi số phút');
    await sendToChat(chatId, 'Gõ số phút muốn tắt thông báo (ví dụ: 45). Gõ /huy để bỏ.');
    return;
  }
  if (choice === 'off') {
    db.setNotifyMute(user.id, 0);
    await ack('Đã bật lại');
    await sendToChat(chatId, '🔔 Đã bật lại thông báo.');
    return;
  }

  const minutes = choice === 'forever' ? null : Number.parseInt(choice, 10);
  if (minutes !== null && !(minutes > 0)) {
    await ack('Không hiểu lựa chọn');
    return;
  }
  db.setNotifyMute(user.id, minutes ? Date.now() + minutes * 60000 : MUTE_FOREVER);
  await ack('Đã tắt');
  await sendToChat(
    chatId,
    minutes ? `🔕 Đã tắt thông báo trong ${minutes} phút.` : '🔕 Đã tắt thông báo đến khi bạn bật lại.',
  );
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  const message = update.message;
  const text = message?.text?.trim();
  const chatId = message?.chat?.id;
  if (!text || !chatId) return;
  const user = db.getUserByChatId(chatId);

  if (!text.startsWith('/')) {
    // Đang chờ số phút cho lựa chọn "tuỳ chỉnh".
    const askedAt = pendingMute.get(chatId);
    const minutes = Number.parseInt(text, 10);
    if (askedAt && Date.now() - askedAt < 5 * 60000 && user && minutes > 0) {
      pendingMute.delete(chatId);
      db.setNotifyMute(user.id, Date.now() + minutes * 60000);
      await sendToChat(chatId, `🔕 Đã tắt thông báo trong ${minutes} phút.`);
      return;
    }
    await sendToChat(
      chatId,
      'Bot này chỉ gửi cảnh báo tự động.\nGõ /tat để tạm tắt thông báo, /status để xem tình trạng bể.',
    );
    return;
  }

  const [command, ...rest] = text.split(/\s+/);
  const code = rest[0];

  if (command === '/start' && code) {
    const target = db.findUserByLinkCode(code.toUpperCase());
    if (!target) {
      await sendToChat(chatId, '❌ Mã liên kết không đúng hoặc đã hết hạn.\nLấy mã mới trên trang web.');
      return;
    }
    db.bindTelegramChat(target.id, chatId);
    pendingMute.delete(chatId);
    const devices = db.listDevices(target.id);
    await sendToChat(
      chatId,
      [
        `👋 Đã liên kết với tài khoản ${target.username}.`,
        devices.length
          ? `Thiết bị đang theo dõi: ${devices.map((d) => d.name || d.deviceId).join(', ')}`
          : 'Tài khoản chưa có thiết bị nào. Liên hệ quản trị viên để được cấp.',
        '',
        'Bạn sẽ nhận thông báo khi thông số vào vùng vàng hoặc đỏ, và được nhắc lại',
        'mỗi 30 phút (vàng) / 10 phút (đỏ) chừng nào còn xấu.',
        'Gõ /tat để tạm tắt thông báo, /status để xem tình trạng bể.',
        `Bảng điều khiển: ${config.telegram.publicUrl}`,
      ].join('\n'),
    );
    console.log(`[telegram] ${target.username} đã liên kết chat ${chatId}`);
    return;
  }

  if (command === '/stop') {
    if (!user) {
      await sendToChat(chatId, 'Chat này chưa liên kết tài khoản nào.');
      return;
    }
    db.unbindTelegram(user.id);
    pendingMute.delete(chatId);
    await sendToChat(chatId, 'Đã ngắt liên kết. Bạn sẽ không nhận cảnh báo nữa.');
    return;
  }

  if (command === '/tat' || command === '/thongbao') {
    if (!user) {
      await sendToChat(chatId, 'Chat này chưa liên kết tài khoản nào. Gửi /start <mã> để liên kết.');
      return;
    }
    const minutes = Number.parseInt(rest[0] ?? '', 10);
    if (minutes > 0) {
      db.setNotifyMute(user.id, Date.now() + minutes * 60000);
      await sendToChat(chatId, `🔕 Đã tắt thông báo trong ${minutes} phút.`);
      return;
    }
    await sendToChat(
      chatId,
      [
        muteStatusText(user),
        '',
        'Nhấn để chọn thời gian tắt thông báo, hoặc gõ /tat <số phút>:',
      ].join('\n'),
      muteKeyboard(muteInfo(user).muted),
    );
    return;
  }

  if (command === '/bat' || command === '/batlai') {
    if (!user) {
      await sendToChat(chatId, 'Chat này chưa liên kết tài khoản nào. Gửi /start <mã> để liên kết.');
      return;
    }
    db.setNotifyMute(user.id, 0);
    pendingMute.delete(chatId);
    await sendToChat(chatId, '🔔 Đã bật lại thông báo.');
    return;
  }

  if (command === '/huy') {
    pendingMute.delete(chatId);
    await sendToChat(chatId, 'Đã bỏ thao tác đang chờ.');
    return;
  }

  if (command === '/status') {
    if (!user) {
      await sendToChat(chatId, 'Chat này chưa liên kết tài khoản nào. Gửi /start <mã> để liên kết.');
      return;
    }
    const devices = db.listDevices(user.id);
    if (!devices.length) {
      await sendToChat(chatId, 'Tài khoản chưa có thiết bị nào.');
      return;
    }
    const lines = devices.map((d) => {
      const reading = db.latestReading(d.deviceId);
      const age = reading ? Math.round((Date.now() - reading.receivedAt) / 60000) : null;
      const keys = ['temperature', 'ph', 'tds'];
      const parts = keys
        .filter((k) => reading?.[k] != null)
        .map((k) => `${PARAMS[k].short} ${reading[k].toFixed(PARAMS[k].decimals)}${PARAMS[k].unit}`);
      return `• ${d.name || d.deviceId}: ${d.online ? 'trực tuyến' : 'mất kết nối'}${parts.length ? ` · ${parts.join(' · ')}` : ''}${age != null ? ` · ${age} phút trước` : ''}`;
    });
    await sendToChat(chatId, ['📊 Tình trạng hiện tại', '', ...lines, '', muteStatusText(user)].join('\n'));
    return;
  }

  await sendToChat(
    chatId,
    [
      'Lệnh dùng được:',
      '/status — xem tình trạng bể',
      '/tat [số phút] — tạm tắt thông báo',
      '/bat — bật lại thông báo',
      '/stop — ngắt liên kết',
      '/start <mã> — liên kết tài khoản',
    ].join('\n'),
  );
}

async function pollUpdates() {
  if (polling || !state.enabled) return;
  polling = true;
  try {
    const updates = await callTelegram('getUpdates', {
      offset,
      timeout: 25,
      limit: 20,
      allowed_updates: ['message', 'callback_query'],
    });
    for (const update of updates ?? []) {
      offset = Math.max(offset, (update.update_id ?? 0) + 1);
      try {
        await handleUpdate(update);
      } catch (err) {
        console.warn('[telegram] Lỗi xử lý tin nhắn:', err.message);
      }
    }
  } catch (err) {
    // Lỗi mạng tạm thời là bình thường; ghi lại rồi thử tiếp ở vòng sau.
    state.lastError = err.message;
    if (!/timeout|aborted/i.test(err.message)) {
      console.warn('[telegram] Không lấy được tin nhắn:', err.message);
    }
  } finally {
    polling = false;
  }
}

function schedulePolling() {
  if (!state.enabled) return;
  const loop = async () => {
    await pollUpdates();
    if (pollTimer) pollTimer = setTimeout(loop, 1000);
  };
  pollTimer = setTimeout(loop, 0);
  pollTimer.unref?.();
}

/** Map `deviceId|chatId` -> Map(param -> {level, lastSentAt}) đang xấu. */
const active = new Map();
let onReading = null;

export function startTelegram() {
  if (!state.enabled) {
    console.log('[telegram] Bỏ qua: chưa có TELEGRAM_BOT_TOKEN.');
    return;
  }

  onReading = ({ deviceId, issues, reading }) => {
    const device = db.getDevice(deviceId);
    const user = device?.ownerId ? db.getUserById(device.ownerId) : null;
    if (!user?.telegramChatId || user.disabled) return;

    // Đang tắt thông báo: không gửi và cũng không tích luỹ trạng thái.
    if (muteInfo(user).muted) return;

    const key = `${deviceId}|${user.telegramChatId}`;
    const { next, sends } = planNotifications(active.get(key) ?? new Map(), issues, Date.now(), {
      minLevel: config.telegram.notifyLevel,
      repeatMs: config.telegram.repeatMs,
    });
    active.set(key, next);
    if (!sends.length) return;

    for (const { issue, reminder } of sends) {
      sendToChat(
        user.telegramChatId,
        formatAlert(issue, {
          deviceId,
          deviceName: device.name || deviceId,
          ts: reading?.ts,
          reminder,
        }),
        muteKeyboard(true),
      ).catch((err) => {
        state.lastError = err.message;
        console.warn('[telegram] Gửi thất bại:', err.message);
      });
    }
  };
  bus.on(EVENTS.reading, onReading);

  // Lấy tên bot để hiện trong hướng dẫn liên kết.
  callTelegram('getMe', {})
    .then((me) => {
      if (me?.username) {
        state.botUsername = me.username;
        console.log(`[telegram] Bot @${me.username} đã sẵn sàng.`);
      }
    })
    .catch((err) => console.warn('[telegram] Không lấy được thông tin bot:', err.message));

  schedulePolling();
  console.log(`[telegram] Đã bật, mức thông báo: ${config.telegram.notifyLevel}.`);
}

export function stopTelegram() {
  if (onReading) bus.off(EVENTS.reading, onReading);
  onReading = null;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  active.clear();
  pendingMute.clear();
}
