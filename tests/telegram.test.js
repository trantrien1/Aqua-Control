/**
 * Kiểm tra logic thông báo của bot Telegram:
 *   - báo khi một tham số vào vùng vàng/đỏ,
 *   - nhắc lại theo chu kỳ (vàng 30 phút, đỏ 10 phút) chừng nào còn xấu,
 *   - trạng thái tắt thông báo.
 *
 *   node --no-warnings tests/telegram.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planNotifications, muteInfo, formatAlert, MUTE_FOREVER } from '../server/telegram.js';

const MIN = 60000;
const OPTS = { minLevel: 'warn', repeatMs: { warn: 30 * MIN, critical: 10 * MIN } };
const issue = (param, level = 'critical') => ({
  param,
  level,
  value: 1,
  label: param,
  message: `${param} vượt ngưỡng.`,
});

const params = (sends) => sends.map((s) => s.issue.param);

test('báo khi tham số mới vào vùng vàng', () => {
  const { next, sends } = planNotifications(new Map(), [issue('ph', 'warn')], 1000, OPTS);
  assert.deepEqual(params(sends), ['ph']);
  assert.equal(sends[0].reminder, false);
  assert.equal(next.get('ph').level, 'warn');
});

test('không báo lại trước khi hết chu kỳ', () => {
  const first = planNotifications(new Map(), [issue('ph')], 1000, OPTS);
  const again = planNotifications(first.next, [issue('ph')], 1000 + 9 * MIN, OPTS);
  assert.deepEqual(again.sends, []);
  assert.equal(again.next.get('ph').lastSentAt, 1000);
});

test('nhắc lại sau 10 phút với mức đỏ, 30 phút với mức vàng', () => {
  const start = new Map([['ph', { level: 'critical', lastSentAt: 1000 }]]);
  const at10 = planNotifications(start, [issue('ph')], 1000 + 10 * MIN, OPTS);
  assert.deepEqual(params(at10.sends), ['ph']);
  assert.equal(at10.sends[0].reminder, true);

  const warn = new Map([['tds', { level: 'warn', lastSentAt: 1000 }]]);
  assert.deepEqual(planNotifications(warn, [issue('tds', 'warn')], 1000 + 20 * MIN, OPTS).sends, []);
  assert.deepEqual(params(planNotifications(warn, [issue('tds', 'warn')], 1000 + 30 * MIN, OPTS).sends), ['tds']);
});

test('vàng lên đỏ thì báo ngay, không chờ hết chu kỳ', () => {
  const warn = new Map([['ph', { level: 'warn', lastSentAt: 1000 }]]);
  const { sends } = planNotifications(warn, [issue('ph', 'critical')], 1000 + MIN, OPTS);
  assert.deepEqual(params(sends), ['ph']);
  assert.equal(sends[0].reminder, true);
});

test('hết xấu thì quên, quay lại thì báo như tin mới', () => {
  const cleared = planNotifications(new Map([['ph', { level: 'critical', lastSentAt: 0 }]]), [], 1000, OPTS);
  assert.equal(cleared.next.size, 0);
  const back = planNotifications(cleared.next, [issue('ph')], 2000, OPTS);
  assert.deepEqual(params(back.sends), ['ph']);
  assert.equal(back.sends[0].reminder, false);
});

test('mức "critical" bỏ qua cảnh báo vàng', () => {
  const { sends, next } = planNotifications(new Map(), [issue('turbidity', 'warn')], 1000, {
    ...OPTS,
    minLevel: 'critical',
  });
  assert.deepEqual(sends, []);
  assert.equal(next.size, 0);
});

test('trạng thái tắt thông báo', () => {
  const now = 1_000_000;
  assert.equal(muteInfo({ notifyMutedUntil: 0 }, now).muted, false);
  assert.equal(muteInfo({ notifyMutedUntil: now - 1 }, now).muted, false); // hết hạn thì tự bật lại

  const timed = muteInfo({ notifyMutedUntil: now + 30 * MIN }, now);
  assert.equal(timed.muted, true);
  assert.equal(timed.forever, false);
  assert.equal(timed.remainingMs, 30 * MIN);

  const forever = muteInfo({ notifyMutedUntil: MUTE_FOREVER }, now);
  assert.equal(forever.muted, true);
  assert.equal(forever.forever, true);
});

test('tin nhắn có tên thông số, giờ, link dashboard và dấu nhắc lại', () => {
  const text = formatAlert(issue('ph'), { deviceId: 'esp32-beca-01', ts: Date.now() });
  assert.match(text, /ph vượt ngưỡng/);
  assert.match(text, /NGUY HIỂM/);
  assert.match(text, /esp32-beca-01/);
  assert.match(text, /Mở bảng điều khiển: http/);
  assert.doesNotMatch(text, /Nhắc lại/);
  assert.match(formatAlert(issue('ph'), { reminder: true }), /🔁 Nhắc lại/);
});
