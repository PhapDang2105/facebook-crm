// Đăng nhập của CRM: tài khoản khai trong .env (CRM_LOGIN_USERS), mật khẩu băm
// scrypt, phiên là cookie ký HMAC (không lưu phía máy chủ — khởi động lại không
// đăng xuất ai). Đổi mật khẩu thì mọi phiên cũ của tài khoản đó hết hiệu lực,
// vì chữ ký phiên gồm cả một mẩu của chuỗi băm mật khẩu.
//
// Tạo chuỗi băm: node app/auth.mjs hash-password
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 32;
export const SESSION_COOKIE = 'crm_session';
const SESSION_DAYS = 30;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(String(password), salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltText, keyText] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, 'base64url');
  const actual = await scrypt(String(password), Buffer.from(saltText, 'base64url'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** "huy:scrypt$..$..,lan:scrypt$..$.." → Map(tên → chuỗi băm). Tên không phân biệt hoa thường. */
export function parseUsers(value) {
  const users = new Map();
  for (const entry of String(value || '').split(',')) {
    const separator = entry.indexOf(':');
    if (separator < 1) continue;
    const name = entry.slice(0, separator).trim().toLowerCase();
    const hash = entry.slice(separator + 1).trim();
    if (name && hash) users.set(name, hash);
  }
  return users;
}

function sign(secret, text) {
  return createHmac('sha256', secret).update(text).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * users: Map tên → chuỗi băm. secret: khoá ký phiên; để trống thì sinh ngẫu
 * nhiên (khởi động lại là mọi người phải đăng nhập lại).
 */
export function createAuth({ users = new Map(), secret = '', secure = false, now = () => Date.now() } = {}) {
  const key = secret || randomBytes(32).toString('hex');
  // Đọc lại mỗi lần: users có thể được cập nhật tại chỗ (thêm nhân viên đầu tiên là bật đăng nhập ngay).
  const isEnabled = () => users.size > 0;
  // Băm mồi để tên sai tốn thời gian như tên đúng (không dò được tên tài khoản).
  const decoyHash = hashPassword(randomBytes(8).toString('hex'));
  const failures = new Map();
  const MAX_FAILURES = 10;
  const WINDOW_MS = 15 * 60 * 1000;

  const fingerprint = name => sign(key, `pw:${users.get(name) || ''}`).slice(0, 12);

  function issue(name) {
    const payload = Buffer.from(JSON.stringify({ u: name, exp: now() + SESSION_DAYS * 86400000, f: fingerprint(name) })).toString('base64url');
    return `${payload}.${sign(key, payload)}`;
  }

  function readToken(token) {
    const [payload, signature] = String(token || '').split('.');
    if (!payload || !signature || !safeEqual(sign(key, payload), signature)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
    if (!data || typeof data.u !== 'string' || !(Number(data.exp) > now())) return null;
    if (!users.has(data.u) || !safeEqual(data.f, fingerprint(data.u))) return null;
    return { username: data.u };
  }

  function cookieValue(request) {
    for (const part of String(request.headers.cookie || '').split(';')) {
      const separator = part.indexOf('=');
      if (separator > 0 && part.slice(0, separator).trim() === SESSION_COOKIE) return part.slice(separator + 1).trim();
    }
    return '';
  }

  function cookie(value, maxAgeSeconds) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
  }

  return {
    get enabled() { return isEnabled(); },
    /** Phiên của request, hoặc null. Khi chưa khai tài khoản nào thì mọi người coi như đã vào. */
    session(request) {
      if (!isEnabled()) return { username: '' };
      return readToken(cookieValue(request));
    },
    /** Trả { ok, cookie, username } hoặc { ok:false, status, error }. */
    async login({ username, password, clientId = '' }) {
      if (!isEnabled()) return { ok: false, status: 400, error: 'CRM chưa bật đăng nhập.' };
      const record = failures.get(clientId);
      if (record && now() - record.since < WINDOW_MS && record.count >= MAX_FAILURES) {
        return { ok: false, status: 429, error: 'Sai quá nhiều lần. Vui lòng thử lại sau 15 phút.' };
      }
      const name = String(username || '').trim().toLowerCase();
      const stored = users.get(name);
      const valid = stored
        ? await verifyPassword(password, stored)
        : (await verifyPassword(password, await decoyHash), false);
      if (!valid) {
        const fresh = !record || now() - record.since >= WINDOW_MS;
        failures.set(clientId, { since: fresh ? now() : record.since, count: fresh ? 1 : record.count + 1 });
        return { ok: false, status: 401, error: 'Tên đăng nhập hoặc mật khẩu không đúng.' };
      }
      failures.delete(clientId);
      return { ok: true, username: name, cookie: cookie(issue(name), SESSION_DAYS * 86400) };
    },
    logoutCookie: () => cookie('', 0)
  };
}

/**
 * Đường đi thẳng không cần đăng nhập: máy ngoài gọi (webhook), khách quét QR,
 * ảnh Messenger tải, trang chính sách cho Meta, và chính trang đăng nhập.
 */
export function isPublicPath(pathname, { webhookPaths = [] } = {}) {
  if (webhookPaths.includes(pathname)) return true;
  if (['/api/health', '/api/auth/login', '/api/auth/logout', '/api/auth/session',
    '/privacy', '/privacy.html', '/login', '/login.html', '/login.css', '/login.js',
    '/assets/giot-nang-logo.webp'].includes(pathname)) return true;
  return /^\/(?:q|product-images|assets\/fonts|assets\/login)\//.test(pathname);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === 'hash-password') {
  const { createInterface } = await import('node:readline/promises');
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const password = await input.question('Mật khẩu: ');
  input.close();
  if (password.length < 8) {
    console.error('Mật khẩu cần ít nhất 8 ký tự.');
    process.exit(1);
  }
  console.log(await hashPassword(password));
}
