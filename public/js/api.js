/** Lớp gọi API dùng chung cho giao diện. */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
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

export const api = {
  getState: () => request('/api/state'),
  getHistory: (metric, range) => request(`/api/history?metric=${encodeURIComponent(metric)}&range=${encodeURIComponent(range)}`),
  getPumpEvents: (limit = 20) => request(`/api/events/pumps?limit=${limit}`),
  getAlerts: (limit = 20) => request(`/api/alerts?limit=${limit}`),
  stopAll: () => request('/api/relays/stop-all', { method: 'POST' }),
  controlPump: (pump, action, seconds) => request(`/api/pumps/${encodeURIComponent(pump)}`, {
    method: 'POST',
    body: { action, seconds },
  }),
  logout: () => request('/api/logout', { method: 'POST' }),
};
