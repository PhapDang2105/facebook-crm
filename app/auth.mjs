// Đăng nhập của CRM: tài khoản khai trong .env (CRM_LOGIN_USERS), mật khẩu băm
// scrypt, phiên là cookie ký HMAC (không lưu phía máy chủ — khởi động lại không
// đăng xuất ai). Đổi mật khẩu thì mọi phiên cũ của tài khoản đó hết hiệu lực,
// vì chữ ký phiên gồm cả một mẩu của chuỗi băm mật khẩu. Nhân sự còn có
// sessionVersion (staff.json): tăng khi đổi mật khẩu / cho nghỉ, phiên mang
// phiên bản cũ hết hiệu lực — kể cả khi người đó đi làm lại.
//
// Khoá đăng nhập: đếm lần thử theo IP (10/15 phút) VÀ theo tên đăng nhập
// (20/15 phút). Lần thử được giữ chỗ (đếm) TRƯỚC khi chờ scrypt, nên gửi song
// song hàng trăm yêu cầu cũng chỉ có đúng số lần cho phép được chấm mật khẩu.
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
/**
 * Giá trị trong Map tài khoản: chuỗi băm (tài khoản .env) hoặc { hash, version }
 * (Nhân sự: version = sessionVersion). → { hash, version }.
 */
export function accountOf(value) {
  if (value && typeof value === 'object') return { hash: String(value.hash || ''), version: Math.max(0, Math.trunc(Number(value.version) || 0)) };
  return { hash: String(value || ''), version: 0 };
}

export const LOGIN_LIMITS = Object.freeze({ perIp: 10, perUser: 20, windowMs: 15 * 60 * 1000 });

/**
 * Bộ đếm lần thử đăng nhập theo khoá (IP hay tên). reserve() giữ chỗ đồng bộ — gọi trước
 * khi await bất cứ gì — trả false khi đã đủ lượt; release() trả lại lượt khi đăng nhập đúng.
 */
export function createAttemptLimiter({ max, windowMs, now = () => Date.now(), maxKeys = 10000 } = {}) {
  const records = new Map();
  const live = (record, at) => record && at - record.since < windowMs;
  const prune = at => {
    if (records.size <= maxKeys) return;
    for (const [key, record] of records) if (!live(record, at)) records.delete(key);
    // Vẫn quá to (bị rải tên ngẫu nhiên): bỏ bản cũ nhất.
    while (records.size > maxKeys) records.delete(records.keys().next().value);
  };
  return {
    blocked(key) {
      const record = records.get(key);
      return Boolean(live(record, now()) && record.count >= max);
    },
    reserve(key) {
      const at = now();
      const record = records.get(key);
      if (!live(record, at)) {
        records.set(key, { since: at, count: 1 });
        prune(at);
        return true;
      }
      if (record.count >= max) return false;
      record.count += 1;
      return true;
    },
    release(key) {
      const record = records.get(key);
      if (record && live(record, now()) && record.count > 0) record.count -= 1;
    },
    count(key) {
      const record = records.get(key);
      return live(record, now()) ? record.count : 0;
    }
  };
}

export function createAuth({ users = new Map(), secret = '', secure = false, now = () => Date.now(), limits = LOGIN_LIMITS } = {}) {
  const key = secret || randomBytes(32).toString('hex');
  // Đọc lại mỗi lần: users có thể được cập nhật tại chỗ (thêm nhân viên đầu tiên là bật đăng nhập ngay).
  const isEnabled = () => users.size > 0;
  // Băm mồi để tên sai tốn thời gian như tên đúng (không dò được tên tài khoản).
  const decoyHash = hashPassword(randomBytes(8).toString('hex'));
  const byIp = createAttemptLimiter({ max: limits.perIp, windowMs: limits.windowMs, now });
  const byUser = createAttemptLimiter({ max: limits.perUser, windowMs: limits.windowMs, now });

  // Dấu vân tay mật khẩu + phiên bản phiên. version 0 giữ đúng công thức cũ: cookie đang có
  // trước bản này vẫn dùng được (không bắt mọi người đăng nhập lại khi deploy).
  const fingerprint = name => {
    const { hash, version } = accountOf(users.get(name));
    return sign(key, version ? `pw:${hash}:v${version}` : `pw:${hash}`).slice(0, 12);
  };

  function issue(name) {
    const { version } = accountOf(users.get(name));
    const payload = Buffer.from(JSON.stringify({ u: name, exp: now() + SESSION_DAYS * 86400000, f: fingerprint(name), ...(version ? { v: version } : {}) })).toString('base64url');
    return `${payload}.${sign(key, payload)}`;
  }

  function readToken(token) {
    const [payload, signature] = String(token || '').split('.');
    if (!payload || !signature || !safeEqual(sign(key, payload), signature)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
    if (!data || typeof data.u !== 'string' || !(Number(data.exp) > now())) return null;
    if (!users.has(data.u) || !safeEqual(data.f, fingerprint(data.u))) return null;
    // Phiên bản ghi trong cookie phải đúng phiên bản hiện tại (đổi mật khẩu / cho nghỉ → tăng).
    if ((Math.trunc(Number(data.v) || 0)) !== accountOf(users.get(data.u)).version) return null;
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
      const name = String(username || '').trim().toLowerCase().slice(0, 64);
      const ipKey = String(clientId || '');
      const tooMany = { ok: false, status: 429, error: 'Sai quá nhiều lần. Vui lòng thử lại sau 15 phút.' };
      // Giữ chỗ ĐỒNG BỘ, trước mọi await: yêu cầu song song không cùng lọt qua một lần kiểm.
      if (byIp.blocked(ipKey) || byUser.blocked(name)) return tooMany;
      byIp.reserve(ipKey);
      byUser.reserve(name);
      const { hash: stored } = accountOf(users.get(name));
      const valid = stored
        ? await verifyPassword(password, stored)
        : (await verifyPassword(password, await decoyHash), false);
      // Tài khoản bị đổi/xoá trong lúc chờ scrypt thì coi như sai.
      if (!valid || accountOf(users.get(name)).hash !== stored) {
        return { ok: false, status: 401, error: 'Tên đăng nhập hoặc mật khẩu không đúng.' };
      }
      // Đúng mật khẩu: trả lại lượt vừa giữ (không xoá cả bộ đếm — lần sai trước đó vẫn tính).
      byIp.release(ipKey);
      byUser.release(name);
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
  return /^\/(?:q|product-images|assets\/fonts|assets\/login)\//.test(pathname)
    || /^\/api\/channels\/facebook\/[0-9]+\/picture$/.test(pathname);
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
