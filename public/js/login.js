/** Xử lý trang đăng nhập. */
const form = document.getElementById('login-form');
const input = document.getElementById('password');
const errorEl = document.getElementById('form-error');
const submitBtn = document.getElementById('submit-btn');

input.addEventListener('input', () => {
  errorEl.textContent = '';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = input.value;
  if (!password) {
    errorEl.textContent = 'Vui lòng nhập mật khẩu.';
    input.focus();
    return;
  }

  submitBtn.disabled = true;
  errorEl.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      window.location.replace('/');
      return;
    }
    const data = await res.json().catch(() => ({}));
    errorEl.textContent = data.error || 'Đăng nhập thất bại.';
    input.select();
  } catch {
    errorEl.textContent = 'Không kết nối được máy chủ. Kiểm tra lại kết nối mạng.';
  } finally {
    submitBtn.disabled = false;
  }
});
