import { api } from './api.js';
const $ = id => document.getElementById(id);
let ready = false;
async function start() {
  try {
    const me = await api.me();
    if (me.role !== 'admin') { location.replace('/'); return; }
    $('admin-account').textContent = `${me.username} · quản trị`;
    ready = true;
  } catch {}
}
$('admin-create-user').addEventListener('submit', async event => {
  event.preventDefault();
  if (!ready || $('admin-create-submit').disabled) return;
  $('admin-create-error').textContent = '';
  $('admin-create-result').textContent = '';
  $('admin-create-submit').disabled = true;
  try {
    const result = await api.createUser($('new-username').value.trim(), $('new-password').value);
    $('admin-create-result').textContent = `Đã tạo tài khoản ${result.user.username}. Người dùng có thể đăng nhập và tự thêm bể.`;
    $('admin-create-user').reset();
    $('new-username').focus();
  } catch (err) { $('admin-create-error').textContent = err.message; }
  finally { $('admin-create-submit').disabled = false; }
});
$('admin-logout').addEventListener('click', async () => {
  try { await api.logout(); } finally { location.replace('/login'); }
});
start();
