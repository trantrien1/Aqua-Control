/** Lớp gọi API dùng chung cho giao diện. */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Thiết bị đang xem. Gắn vào mọi lời gọi API để server chỉ trả dữ liệu của bể
 * đó — quyền sở hữu vẫn được server kiểm tra lại, client không tự quyết được.
 */
let deviceId = null;

export function setActiveDevice(id) {
  deviceId = id || null;
}

export function activeDevice() {
  return deviceId;
}

function scoped(path) {
  if (!deviceId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}device=${encodeURIComponent(deviceId)}`;
}

async function request(path, { method = 'GET', body } = {}) {
  const options = {
    method,
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new ApiError('Không kết nối được máy chủ.', 0);
  }

  if (res.status === 401) {
    window.location.replace('/login');
    throw new ApiError('Phiên đăng nhập đã hết hạn.', 401);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError((data && data.error) || `Yêu cầu thất bại (${res.status}).`, res.status);
  }
  return data;
}

const devicePath = (suffix) => `/api/devices/${encodeURIComponent(deviceId)}${suffix}`;

export const api = {
  me: () => request('/api/me'),
  getState: () => request(scoped('/api/state')),
  getDevices: () => request('/api/devices'),
  getHistory: (metric, range) =>
    request(scoped(`/api/history?metric=${encodeURIComponent(metric)}&range=${encodeURIComponent(range)}`)),
  getPumpEvents: (limit = 20) => request(scoped(`/api/events/pumps?limit=${limit}`)),
  getAlerts: (limit = 20) => request(scoped(`/api/alerts?limit=${limit}`)),
  saveSettings: (settings) => request(devicePath('/settings'), { method: 'PATCH', body: settings }),
  waterChange: (action, percent, confirmLevel = false) => request(devicePath('/water-change'), { method: 'POST', body: { action, percent, confirmLevel } }),
  stopAll: () => request(devicePath('/relays/stop-all'), { method: 'POST' }),
  controlPump: (pump, action, seconds) =>
    request(devicePath(`/pumps/${encodeURIComponent(pump)}`), {
      method: 'POST',
      body: { action, seconds },
    }),
  logout: () => request('/api/logout', { method: 'POST' }),

  // Telegram của chính tài khoản đang đăng nhập.
  linkTelegram: () => request('/api/telegram/link', { method: 'POST' }),
  unlinkTelegram: () => request('/api/telegram/unlink', { method: 'POST' }),
  testTelegram: () => request('/api/telegram/test', { method: 'POST' }),

  // Quản trị viên.
  listUsers: () => request('/api/admin/users'),
  createUser: (username, password) =>
    request('/api/admin/users', { method: 'POST', body: { username, password } }),
  updateUser: (id, patch) => request(`/api/admin/users/${id}`, { method: 'PATCH', body: patch }),
  deleteUser: (id) => request(`/api/admin/users/${id}`, { method: 'DELETE' }),
  createDevice: (ownerId, name) =>
    request('/api/admin/devices', { method: 'POST', body: { ownerId, name } }),
  updateDevice: (id, patch) =>
    request(`/api/admin/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  rotateDeviceKey: (id) =>
    request(`/api/admin/devices/${encodeURIComponent(id)}/rotate-key`, { method: 'POST' }),
  deleteDevice: (id) =>
    request(`/api/admin/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
