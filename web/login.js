// Trang đăng nhập: gửi tên + mật khẩu, máy chủ đặt cookie phiên rồi quay về
// trang đang xem dở (?next=, chỉ nhận đường dẫn nội bộ).
const form = document.querySelector('#login-form');
const errorBox = document.querySelector('#login-error');
const submitButton = document.querySelector('#login-submit');
const passwordInput = document.querySelector('#login-password');
const passwordToggle = document.querySelector('#login-password-toggle');

// Chỉ nhận đường dẫn NỘI BỘ: "/x" được; "//host", "/\host", "/%09/host" (trình duyệt bỏ tab/xuống
// dòng → "//host"), "https://…", ký tự điều khiển, khoảng trắng hay "\" thì quay về "/".
// Giống hệt safeNextPath() trong app/security.mjs (tests/security.test.mjs chạy cả hai).
function safeNext(value) {
  const next = String(value == null ? '' : value);
  if (!next || next.length > 2000 || next[0] !== '/' || next[1] === '/') return '/';
  if (/[\u0000- \u007f-\u009f\\]/.test(next)) return '/';
  if (/^\/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(next)) return '/';
  try {
    if (new URL(next, 'https://crm.invalid').origin !== 'https://crm.invalid') return '/';
  } catch {
    return '/';
  }
  return next;
}

function nextPath() {
  return safeNext(new URLSearchParams(location.search).get('next'));
}

// Lý do bị đưa về đây (?reason=): báo để người dùng không tưởng là lỗi.
const loginReasons = {
  'password-changed': 'Mật khẩu đã đổi. Đăng nhập lại bằng mật khẩu mới.',
  expired: 'Phiên đăng nhập đã hết hạn hoặc bị đăng xuất từ nơi khác. Vui lòng đăng nhập lại.'
};
const notice = document.querySelector('#login-notice');
const reasonText = loginReasons[new URLSearchParams(location.search).get('reason') || ''] || '';
if (notice && reasonText) {
  notice.textContent = reasonText;
  notice.hidden = false;
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
