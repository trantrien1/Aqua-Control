import { api } from './api.js';

const $ = (id) => document.getElementById(id);

const dom = {
  account: $('admin-account'),
  logout: $('admin-logout'),
  users: $('admin-users'),
  devices: $('admin-devices'),
  newUser: $('admin-new-user'),
  newDevice: $('admin-new-device'),
  userForm: $('admin-user-form'),
  userFormTitle: $('admin-user-form-title'),
  userName: $('admin-user-name'),
  userPass: $('admin-user-pass'),
  userPassLabel: $('admin-user-pass-label'),
  userError: $('admin-user-error'),
  userSave: $('admin-user-save'),
  userCancel: $('admin-user-cancel'),
  deviceForm: $('admin-device-form'),
  deviceOwner: $('admin-device-owner'),
  deviceName: $('admin-device-name'),
  deviceError: $('admin-device-error'),
  deviceCancel: $('admin-device-cancel'),
  secret: $('admin-secret'),
  secretId: $('admin-secret-id'),
  secretKey: $('admin-secret-key'),
  secretClose: $('admin-secret-close'),
  flash: $('admin-flash'),
};

let me = null;
let adminUsers = [];
let adminDevices = [];
let editingUserId = null;

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function flash(message, isError = false) {
  dom.flash.textContent = message;
  dom.flash.classList.toggle('admin-create-result--error', Boolean(isError));
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => {
    dom.flash.textContent = '';
    dom.flash.classList.remove('admin-create-result--error');
  }, 5000);
}

function ownerOptions() {
  const owners = adminUsers.filter((u) => u.role === 'customer' && !u.disabled);
  if (!owners.length) return '<option value="">Chưa có khách hàng đang hoạt động</option>';
  return owners.map((u) => `<option value="${u.id}">${esc(u.username)}</option>`).join('');
}

function renderAdmin() {
  dom.users.innerHTML = adminUsers.length
    ? adminUsers
        .map(
          (u) => `
          <div class="admin-row">
            <div class="admin-row__main">
              <strong>${esc(u.username)}${u.role === 'admin' ? ' · quản trị' : ''}</strong>
              <small>${u.devices.length ? esc(u.devices.map((d) => d.name || d.deviceId).join(', ')) : 'chưa có thiết bị'}</small>
            </div>
            <span class="admin-row__tag ${u.telegramLinked ? 'admin-row__tag--on' : ''}">${u.telegramLinked ? 'Telegram' : 'chưa link'}</span>
            <span class="admin-row__tag ${u.disabled ? 'admin-row__tag--off' : 'admin-row__tag--on'}">${u.disabled ? 'đã khoá' : 'hoạt động'}</span>
            <div class="admin-row__actions">
              <button class="btn btn--sm" type="button" data-user-edit="${u.id}">Sửa</button>
              ${
                u.role === 'admin'
                  ? ''
                  : `<button class="btn btn--sm" type="button" data-user-toggle="${u.id}" data-disabled="${u.disabled ? '0' : '1'}">${u.disabled ? 'Mở khoá' : 'Khoá'}</button>
                     <button class="btn btn--sm btn--off" type="button" data-user-delete="${u.id}">Xoá</button>`
              }
            </div>
          </div>`,
        )
        .join('')
    : '<p class="empty__hint">Chưa có khách hàng.</p>';

  const options = ownerOptions();
  if (dom.deviceOwner.innerHTML !== options) dom.deviceOwner.innerHTML = options;

  dom.devices.innerHTML = adminDevices.length
    ? adminDevices
        .map(
          (d) => `
          <div class="admin-row">
            <div class="admin-row__main">
              <strong>${esc(d.name || d.deviceId)}</strong>
              <small>${esc(d.deviceId)} · ${esc(d.owner || 'chưa gán')}</small>
            </div>
            <div class="admin-row__actions">
              <button class="btn btn--sm" type="button" data-device-rotate="${esc(d.deviceId)}">Đổi khoá</button>
              <button class="btn btn--sm" type="button" data-device-rename="${esc(d.deviceId)}">Đổi tên</button>
              <button class="btn btn--sm btn--off" type="button" data-device-delete="${esc(d.deviceId)}">Xoá</button>
            </div>
          </div>`,
        )
        .join('')
    : '<p class="empty__hint">Chưa cấp thiết bị nào.</p>';
}

async function loadAdmin() {
  try {
    const { users } = await api.listUsers();
    adminUsers = users;
    adminDevices = users.flatMap((u) =>
      u.devices.map((d) => ({ deviceId: d.deviceId, name: d.name, owner: u.username })),
    );
    renderAdmin();
  } catch (err) {
    flash(err.message, true);
  }
}

/** Hiện thông tin nạp firmware — khoá chỉ có ở đây một lần duy nhất. */
function showDeviceSecret(deviceId, deviceKey) {
  dom.secretId.textContent = deviceId;
  dom.secretKey.textContent = deviceKey;
  dom.secret.hidden = false;
  dom.secret.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function openUserForm(user) {
  editingUserId = user?.id ?? null;
  dom.userFormTitle.textContent = user ? `Sửa ${user.username}` : 'Thêm khách hàng';
  dom.userName.value = user?.username ?? '';
  dom.userName.disabled = Boolean(user);
  dom.userPass.value = '';
  dom.userPassLabel.textContent = user
    ? 'Mật khẩu mới (bỏ trống nếu giữ nguyên)'
    : 'Mật khẩu';
  dom.userError.textContent = '';
  dom.userForm.hidden = false;
  (user ? dom.userPass : dom.userName).focus();
}

dom.newUser.addEventListener('click', () => openUserForm(null));

dom.newDevice.addEventListener('click', () => {
  dom.deviceError.textContent = '';
  dom.deviceName.value = '';
  dom.deviceForm.hidden = false;
  if (!dom.deviceOwner.disabled) dom.deviceOwner.focus();
});

dom.userCancel.addEventListener('click', () => {
  dom.userForm.hidden = true;
  editingUserId = null;
});

dom.deviceCancel.addEventListener('click', () => {
  dom.deviceForm.hidden = true;
});

dom.secretClose.addEventListener('click', () => {
  dom.secret.hidden = true;
  dom.secretKey.textContent = '';
});

dom.userForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = dom.userName.value.trim();
  const password = dom.userPass.value;
  dom.userSave.disabled = true;
  dom.userError.textContent = '';
  try {
    if (editingUserId) {
      const patch = {};
      if (password) patch.password = password;
      await api.updateUser(editingUserId, patch);
      flash('Đã cập nhật tài khoản.');
    } else {
      if (!username) throw new Error('Vui lòng nhập tên đăng nhập.');
      await api.createUser(username, password);
      flash(`Đã tạo tài khoản ${username}.`);
    }
    dom.userForm.hidden = true;
    editingUserId = null;
    await loadAdmin();
  } catch (err) {
    dom.userError.textContent = err.message;
  } finally {
    dom.userSave.disabled = false;
  }
});

dom.deviceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const ownerId = Number(dom.deviceOwner.value);
  if (!ownerId) {
    dom.deviceError.textContent = 'Chưa có khách hàng để cấp thiết bị.';
    return;
  }
  dom.deviceError.textContent = '';
  try {
    const result = await api.createDevice(ownerId, dom.deviceName.value.trim());
    dom.deviceForm.hidden = true;
    showDeviceSecret(result.device.deviceId, result.deviceKey);
    flash(`Đã cấp thiết bị ${result.device.deviceId}.`);
    await loadAdmin();
  } catch (err) {
    dom.deviceError.textContent = err.message;
  }
});

dom.users.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const editId = button.dataset.userEdit;
  const toggleId = button.dataset.userToggle;
  const deleteId = button.dataset.userDelete;
  try {
    if (editId) {
      openUserForm(adminUsers.find((u) => String(u.id) === editId));
    } else if (toggleId) {
      await api.updateUser(Number(toggleId), { disabled: button.dataset.disabled === '1' });
      await loadAdmin();
    } else if (deleteId) {
      const target = adminUsers.find((u) => String(u.id) === deleteId);
      if (!confirm(`Xoá tài khoản ${target?.username ?? deleteId}?`)) return;
      await api.deleteUser(Number(deleteId));
      flash('Đã xoá tài khoản.');
      await loadAdmin();
    }
  } catch (err) {
    flash(err.message, true);
  }
});

dom.devices.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const { deviceRotate, deviceRename, deviceDelete } = button.dataset;
  try {
    if (deviceRotate) {
      if (!confirm('Đổi khoá thiết bị? Firmware đang chạy sẽ mất kết nối cho tới khi nạp khoá mới.')) return;
      const result = await api.rotateDeviceKey(deviceRotate);
      showDeviceSecret(result.deviceId, result.deviceKey);
      flash('Đã tạo khoá mới.');
    } else if (deviceRename) {
      const current = adminDevices.find((d) => d.deviceId === deviceRename);
      const name = prompt('Tên mới cho bể:', current?.name ?? '');
      if (name === null) return;
      await api.updateDevice(deviceRename, { name: name.trim() });
      await loadAdmin();
    } else if (deviceDelete) {
      if (!confirm(`Xoá thiết bị ${deviceDelete}? Số đo và nhật ký của bể này sẽ bị xoá.`)) return;
      await api.deleteDevice(deviceDelete);
      flash('Đã xoá thiết bị.');
      await loadAdmin();
    }
  } catch (err) {
    flash(err.message, true);
  }
});

dom.logout.addEventListener('click', async () => {
  try {
    await api.logout();
  } finally {
    location.replace('/login');
  }
});

async function start() {
  try {
    me = await api.me();
  } catch {
    return; // api.me tự chuyển về /login khi phiên hết hạn
  }
  if (me.role !== 'admin') {
    location.replace('/');
    return;
  }
  dom.account.textContent = `${me.username} · quản trị`;
  await loadAdmin();
}

start();
