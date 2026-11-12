/** Xử lý trang đăng nhập. */
const form = document.getElementById('login-form');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const errorEl = document.getElementById('form-error');
const submitBtn = document.getElementById('submit-btn');

for (const input of [usernameInput, passwordInput]) {
  input.addEventListener('input', () => {
    errorEl.textContent = '';
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username) {
    errorEl.textContent = 'Vui lòng nhập tên đăng nhập.';
    usernameInput.focus();
    return;
  }
  if (!password) {
    errorEl.textContent = 'Vui lòng nhập mật khẩu.';
    passwordInput.focus();
    return;
  }

  submitBtn.disabled = true;
  errorEl.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      window.location.replace('/');
      return;
    }
    const data = await res.json().catch(() => ({}));
    errorEl.textContent = data.error || 'Đăng nhập thất bại.';
    passwordInput.select();
  } catch {
    errorEl.textContent = 'Không kết nối được máy chủ. Kiểm tra lại kết nối mạng.';
  } finally {
    submitBtn.disabled = false;
  }
});
