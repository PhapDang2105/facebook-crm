// Các chốt bảo mật dùng chung cho app/server.mjs (tách riêng để test được mà không
// phải khởi động máy chủ): header bảo mật, chặn mở toang khi chưa cấu hình đăng nhập,
// đường dẫn ?next= an toàn, che token trong log, và cờ chẩn đoán có giới hạn tần suất.
import { formatWithOptions } from 'node:util';

/*
 * CSP cho trang HTML của web/ (index, login, privacy). Đã kiểm web/*.html + web/*.js:
 * - không có <script> nội tuyến, không onclick=…, không eval/new Function → script-src 'self';
 * - có style="…" trong chuỗi innerHTML (app.js) và <style> trong privacy.html → style-src cần 'unsafe-inline';
 * - ảnh/video/âm thanh khách gửi đến từ CDN Facebook/Pancake (https:), ảnh xem trước data:/blob:;
 * - app.js fetch(image.src) để chia sẻ ảnh khách (CDN ngoài) → connect-src 'self' https:;
 * - font tự phục vụ (/assets/fonts); không iframe, không form gửi ra ngoài.
 * Trang đệm QR (/q/…, app/qr-bridge.mjs) có <script> nội tuyến nên KHÔNG gắn CSP này.
 */
export const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

/** Header bảo mật cho MỌI phản hồi (đặt bằng setHeader trước khi route chạy; route vẫn ghi đè được). */
export function securityHeaders({ https = false } = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    ...(https ? { 'Strict-Transport-Security': 'max-age=31536000' } : {})
  };
}

export function applySecurityHeaders(response, options) {
  for (const [name, value] of Object.entries(securityHeaders(options))) response.setHeader(name, value);
}

/**
 * Đường dẫn quay về sau đăng nhập: chỉ nhận đường dẫn NỘI BỘ. Chặn "//host", "/\host",
 * "/%09/host" (trình duyệt bỏ tab/xuống dòng trong URL → "//host"), "https://…", "javascript:…",
 * ký tự điều khiển, khoảng trắng và dấu "\" ở bất kỳ đâu. Giống hệt safeNext() trong web/login.js.
 */
export function safeNextPath(value, fallback = '/') {
  const next = String(value ?? '');
  if (!next || next.length > 2000) return fallback;
  if (next[0] !== '/') return fallback;
  if (/[\u0000- \u007f-\u009f\\]/.test(next)) return fallback;
  if (next[1] === '/') return fallback;
  // Dạng mã hoá của các ký tự trên (%2F%2F, %5C, %09…) ngay sau dấu "/" đầu tiên cũng không nhận.
  if (/^\/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(next)) return fallback;
  try {
    const parsed = new URL(next, 'https://crm.invalid');
    if (parsed.origin !== 'https://crm.invalid') return fallback;
  } catch {
    return fallback;
  }
  return next;
}

/**
 * Cổng đăng nhập: 'open' (chưa có tài khoản, không bắt buộc → CRM chạy không đăng nhập ở máy
 * local), 'setup-required' (bắt buộc đăng nhập mà chưa có tài khoản → 503), 'auth' (kiểm phiên).
 */
export function loginGate({ enabled, required }) {
  if (enabled) return 'auth';
  return required ? 'setup-required' : 'open';
}

/** Đường vẫn chạy khi đăng nhập chưa cấu hình (máy ngoài gọi, khách quét QR, chính sách, health). */
export function allowedWithoutLoginSetup(pathname, { isWebhook = false } = {}) {
  if (isWebhook) return true;
  if (['/api/health', '/privacy', '/privacy.html', '/assets/giot-nang-logo.webp'].includes(pathname)) return true;
  return /^\/(?:q|product-images|assets\/fonts)\//.test(pathname);
}

export const LOGIN_SETUP_MESSAGE = 'Chưa cấu hình đăng nhập: máy chủ bắt buộc đăng nhập nhưng chưa có tài khoản nào (CRM_LOGIN_USERS trong .env hoặc Nhân sự có mật khẩu).';

export function loginSetupPage() {
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chưa cấu hình đăng nhập</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#1f2937;line-height:1.5}h1{font-size:22px}code{background:#f3f4f6;padding:1px 4px;border-radius:4px}</style>
</head><body>
<h1>Chưa cấu hình đăng nhập</h1>
<p>CRM đang chạy ở chế độ bắt buộc đăng nhập nhưng chưa có tài khoản nào, nên tạm khoá để không mở dữ liệu khách cho người ngoài.</p>
<p>Người quản trị máy chủ: khai <code>CRM_LOGIN_USERS</code> trong <code>.env</code> (băm mật khẩu bằng <code>node app/auth.mjs hash-password</code>) rồi khởi động lại dịch vụ.</p>
</body></html>`;
}

/* ---- Che bí mật trong log ---- */

const SECRET_PARAM = /([?&;\s"'(,]|^)((?:page_)?access_token|api_key|apikey|client_secret|appsecret_proof|token|key|password|secret|code|fb_exchange_token)=([^&\s"'#)<>,]+)/gi;

/** access_token=abc → access_token=***; "Bearer xyz" → "Bearer ***". Không đổi phần còn lại. */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(SECRET_PARAM, (_, lead, name) => `${lead}${name}=***`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***');
}

/**
 * Bọc console.log/info/warn/error/debug: định dạng như console (util.format) rồi che bí mật.
 * Gọi MỘT lần ở app/server.mjs — phủ cả log của các mô-đun khác (URL Graph/POS/Pancake có token
 * trong query, lỗi fetch kèm URL, request.url của webhook mang ?token=…).
 */
export function installConsoleRedaction(target = console) {
  if (target.__crmRedacted) return target;
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = target[level]?.bind(target);
    if (!original) continue;
    target[level] = (...args) => original(redactSecrets(formatWithOptions({ colors: false }, ...args)));
  }
  Object.defineProperty(target, '__crmRedacted', { value: true, enumerable: false });
  return target;
}

/* ---- Cờ chẩn đoán (WEBHOOK_DEBUG_KEYS, PANCAKE_DEBUG_KEYS) ---- */

/** Chỉ "1"/"true"/"on" mới bật (trước đây giá trị bất kỳ, kể cả "0", cũng bật). Mặc định tắt. */
export function debugFlagOn(name, environment = process.env) {
  return ['1', 'true', 'on', 'yes'].includes(String(environment[name] ?? '').trim().toLowerCase());
}

/** Giới hạn tần suất: tối đa `max` lần mỗi `windowMs`; quá thì bỏ (trả false). */
export function createLogLimiter({ max = 20, windowMs = 60 * 1000, now = () => Date.now() } = {}) {
  let since = 0;
  let count = 0;
  return () => {
    const at = now();
    if (at - since >= windowMs) { since = at; count = 0; }
    if (count >= max) return false;
    count += 1;
    return true;
  };
}
