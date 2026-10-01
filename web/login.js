// Trang đăng nhập: gửi tên + mật khẩu, máy chủ đặt cookie phiên rồi quay về
// trang đang xem dở (?next=, chỉ nhận đường dẫn nội bộ).
const form = document.querySelector('#login-form');
const errorBox = document.querySelector('#login-error');
const submitButton = document.querySelector('#login-submit');
const passwordInput = document.querySelector('#login-password');
const passwordToggle = document.querySelector('#login-password-toggle');

function nextPath() {
  const next = new URLSearchParams(location.search).get('next') || '/';
  // "/x" được, "//host" hay "/\host" thì không — chặn chuyển hướng ra trang ngoài.
  return /^\/(?![/\\])/.test(next) ? next : '/';
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

// CRM chưa bật đăng nhập (CRM_LOGIN_USERS trống): không có gì để làm ở đây.
fetch('/api/auth/session').then(response => response.ok ? response.json() : null).then(session => {
  if (session && !session.enabled) location.replace(nextPath());
}).catch(() => {});

// Cảnh báo Caps Lock khi gõ mật khẩu (lý do sai mật khẩu hay gặp nhất).
const capsNote = document.querySelector('#login-caps');
const submitText = document.querySelector('.login-submit-text');
function updateCaps(event) {
  if (capsNote && typeof event.getModifierState === 'function') capsNote.hidden = !event.getModifierState('CapsLock');
}
passwordInput?.addEventListener('keydown', updateCaps);
passwordInput?.addEventListener('keyup', updateCaps);
passwordInput?.addEventListener('blur', () => { if (capsNote) capsNote.hidden = true; });

function setBusy(busy) {
  submitButton.disabled = busy;
  if (submitText) submitText.textContent = busy ? 'Đang đăng nhập…' : 'Đăng nhập';
}

passwordToggle?.addEventListener('click', () => {
  const show = passwordInput.type === 'password';
  passwordInput.type = show ? 'text' : 'password';
  passwordToggle.setAttribute('aria-pressed', String(show));
  passwordToggle.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  showError('');
  const data = new FormData(form);
  if (!String(data.get('username') || '').trim() || !data.get('password')) {
    showError('Nhập tên đăng nhập và mật khẩu.');
    (String(data.get('username') || '').trim() ? passwordInput : document.querySelector('#login-username')).focus();
    return;
  }
  setBusy(true);
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: data.get('username'), password: data.get('password') })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Không đăng nhập được. Vui lòng thử lại.');
    location.replace(nextPath());
  } catch (error) {
    showError(error.message === 'Failed to fetch' ? 'Không kết nối được máy chủ.' : error.message);
    passwordInput.select();
    setBusy(false);
  }
});
