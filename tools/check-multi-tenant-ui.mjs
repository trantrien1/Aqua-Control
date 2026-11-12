/**
 * Kiểm tra tĩnh phần giao diện đa khách hàng: mọi id mà dashboard.js tra cứu đều
 * phải có trong index.html, mọi lớp CSS mới đều đã được định nghĩa, và API mà
 * client gọi đều tồn tại trên server. Không cần trình duyệt.
 *
 *   node --no-warnings tools/check-multi-tenant-ui.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('public/index.html');
const login = read('public/login.html');
const css = read('public/styles.css');
const dashboard = read('public/js/dashboard.js');
const waterUi = read('public/js/water.js');
const apiJs = read('public/js/api.js');
const serverApi = read('server/api.js');

const problems = [];
const check = (name, ok, detail = '') => {
  if (!ok) problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

/* 1. Mọi id trong danh sách dom của dashboard.js phải tồn tại trong HTML. */
const domBlock = dashboard.slice(
  dashboard.indexOf('const dom = {'),
  dashboard.indexOf('};', dashboard.indexOf('const dom = {')),
);
const ids = [...domBlock.matchAll(/\$\((["'])([^"']+)\1\)/g)].map((m) => m[2]);
check('dashboard.js có tham chiếu DOM', ids.length > 30, `${ids.length} id`);
for (const id of ids) {
  check(`index.html thiếu #${id}`, html.includes(`id="${id}"`));
}
for (const match of waterUi.matchAll(/\$\('([^']+)'\)/g)) {
  check(`index.html thiếu phần điều khiển nước #${match[1]}`, html.includes(`id="${match[1]}"`));
}

/* 2. Các phần tử bắt buộc của luồng nhiều khách hàng. */
for (const id of [
  'device-select',
  'tank-id',
  'account-chip',
  'telegram-link',
  'telegram-unlink',
  'telegram-code',
  'telegram-command',
  'telegram-bot',
  'admin',
  'admin-users',
  'admin-devices',
  'admin-new-user',
  'admin-new-device',
  'admin-user-form',
  'admin-device-form',
  'admin-secret',
]) {
  check(`thiếu khối giao diện #${id}`, html.includes(`id="${id}"`));
}
check('trang đăng nhập có ô tên đăng nhập', login.includes('id="username"'));

/* 3. Không được có style nội tuyến (CSP chặn) hay script nội tuyến. */
check('index.html có style="..."', !/\sstyle="/.test(html));
check('login.html có style="..."', !/\sstyle="/.test(login));
check('index.html có <style>', !/<style[\s>]/.test(html));
check('index.html có script nội tuyến', !/<script(?![^>]*src=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html));

/* 4. Mọi lớp CSS mới dùng trong HTML đều phải được định nghĩa. */
const newClasses = [
  'device-select',
  'tank-label',
  'tank-id',
  'account-chip',
  'telegram-card__actions',
  'telegram-code',
  'telegram-code__hint',
  'admin-section',
  'admin-actions',
  'admin-grid',
  'admin-form',
  'admin-form__row',
  'admin-form__actions',
  'admin-secret',
  'admin-secret__warn',
  'admin-secret__list',
  'admin-row',
  'admin-row__main',
  'admin-row__tag',
  'admin-row__tag--on',
  'admin-row__tag--off',
  'admin-row__actions',
];
for (const cls of newClasses) {
  check(`styles.css thiếu .${cls}`, css.includes(`.${cls}`));
}

/* 5. Client gọi API nào thì server phải có route đó. */
const calls = [
  ...[...apiJs.matchAll(/request\(\s*(?:scoped\()?['"`]([^'"`]+)/g)].map((m) => m[1]),
  ...[...apiJs.matchAll(/devicePath\(\s*['"`]([^'"`]+)/g)].map((m) => `__DEVICE__${m[1]}`),
];
const routes = new Set(
  [...serverApi.matchAll(/(api|admin)\.(?:get|post|patch|delete)\('([^']+)'/g)].map((m) =>
    `${m[1] === 'admin' ? '/admin' : ''}${m[2]}`.replace(/:(\w+)/g, ':id'),
  ),
);

for (const call of calls) {
  const normalised = call
    .split('?')[0]
    .replace('__DEVICE__', '/api/devices/:id')
    .replace(/\$\{[^}]+\}/g, ':id')
    .replace(/^\/api/, '');
  check(`server/api.js thiếu route cho ${call}`, routes.has(normalised), normalised);
}

/* 6. Không còn dấu vết mô hình một khách hàng. */
check('dashboard.js còn đọc tg.chatId', !/tg\.chatId/.test(dashboard));
check('api.js còn gọi /api/pumps/:pump kiểu cũ', !/request\(\s*[`'"]\/api\/pumps\//.test(apiJs));
check('index.html còn nhắc DEVICE_ID', !/DEVICE_ID/.test(html));

if (problems.length) {
  console.error('Kiểm tra giao diện thất bại:');
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log(`✔ ${ids.length} id DOM khớp giữa dashboard.js và index.html`);
console.log(`✔ ${newClasses.length} lớp CSS mới đã được định nghĩa`);
console.log(`✔ ${calls.length} lời gọi API đều có route tương ứng`);
console.log('✔ không có style/script nội tuyến, không còn dấu vết mô hình một khách hàng');
