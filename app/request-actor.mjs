// Ai đang gọi request này: dùng cho nhật ký hoạt động (app/audit-log.mjs) và để ghi người làm
// vào chính dữ liệu (tin nhân viên gửi, đơn tạo tay, lịch sử sửa đơn, ghi chú khách).
//
// - Tài khoản chủ shop khai trong .env (CRM_LOGIN_USERS): role 'owner', roleName 'Chủ shop',
//   tên hiển thị là tên đăng nhập (.env không có họ tên).
// - Nhân viên (Cài đặt → Nhân sự): họ tên + vai trò lấy từ staff.json, nhớ 30 giây để mỗi
//   request không phải đọc đĩa (đổi tên/cho nghỉ có hiệu lực chậm nhất 30 giây, hoặc ngay khi
//   server gọi clearActorCache() sau khi lưu Nhân sự).
// - CRM chưa bật đăng nhập: { username: '', name: 'Không đăng nhập', role: 'anonymous' }.
import { STAFF_ROLES, staffByUsername } from './staff.mjs';

export const ACTOR_CACHE_MS = 30 * 1000;
export const ANONYMOUS_NAME = 'Không đăng nhập';
export const OWNER_ROLE_NAME = 'Chủ shop';
/** Người làm của việc do bot tự làm (đơn bot chốt, bot sửa/hủy đơn theo lời khách). */
export const BOT_ACTOR = Object.freeze({ username: 'bot', name: 'Chatbot AI', role: 'bot', roleName: 'Chatbot' });

const staffCache = new Map();

/** Quên bộ nhớ đệm nhân sự (sau khi lưu Nhân sự, hay trong test). */
export function clearActorCache() {
  staffCache.clear();
}

/** Kết nối tới từ chính máy này (Caddy chạy cùng máy). */
export function isLoopbackAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  return value === '::1' || value === '127.0.0.1' || value === '::ffff:127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(value);
}

/**
 * IP người dùng. Chỉ tin X-Forwarded-For khi kết nối đến từ loopback (Caddy cùng máy); khi đó lấy
 * địa chỉ CUỐI của chuỗi — địa chỉ do chính Caddy ghi (máy nối thẳng vào Caddy). Các địa chỉ đứng
 * trước do phía khách tự khai nên giả được. Kết nối từ máy khác (CRM nghe 0.0.0.0, gọi thẳng cổng
 * 8080) thì bỏ qua header, dùng địa chỉ socket — không ai tự đặt IP để né khoá đăng nhập.
 */
export function clientIp(request) {
  const remote = String(request?.socket?.remoteAddress || '');
  if (!isLoopbackAddress(remote)) return remote;
  const forwarded = String(request?.headers?.['x-forwarded-for'] || '').split(',').map(item => item.trim()).filter(Boolean);
  return forwarded.at(-1) || remote;
}

async function cachedStaff(username, lookup, now) {
  const hit = staffCache.get(username);
  if (hit && now - hit.at < ACTOR_CACHE_MS) return hit.member;
  const member = await Promise.resolve(lookup(username)).catch(() => null);
  staffCache.set(username, { member: member || null, at: now });
  // Giữ bộ nhớ đệm nhỏ: nhân sự của một shop chỉ vài chục người.
  if (staffCache.size > 500) staffCache.delete(staffCache.keys().next().value);
  return member || null;
}

/**
 * Người gọi request: { username, name, role, roleName, ip }.
 * `auth`: đối tượng của createAuth (cần .enabled và .session(request)).
 * `envLoginUsers`: Map/Set tên đăng nhập chủ shop trong .env.
 * `staffLookup`: thay staffByUsername (test).
 */
export async function actorOf(request, { auth, envLoginUsers = new Map(), staffLookup = staffByUsername, now = Date.now() } = {}) {
  const ip = clientIp(request);
  if (!auth?.enabled) return { username: '', name: ANONYMOUS_NAME, role: 'anonymous', roleName: ANONYMOUS_NAME, ip };
  const username = String(auth.session(request)?.username || '').trim().toLowerCase();
  // Đăng nhập đang BẬT mà request không có phiên: không phải 'anonymous' (vai trò đó coi như quản lý).
  if (!username) return { username: '', name: ANONYMOUS_NAME, role: 'guest', roleName: ANONYMOUS_NAME, ip };
  if (envLoginUsers?.has?.(username)) return { username, name: username, role: 'owner', roleName: OWNER_ROLE_NAME, ip };
  const member = await cachedStaff(username, staffLookup, now);
  if (!member) return { username, name: username, role: 'staff', roleName: STAFF_ROLES.staff, ip };
  const role = member.role === 'admin' ? 'admin' : 'staff';
  return { username, name: String(member.name || username), role, roleName: member.roleName || STAFF_ROLES[role], ip };
}

/**
 * Chủ shop / Quản trị / CRM chưa bật đăng nhập: được xem toàn bộ nhật ký, sửa Nhân sự và các mục Cài đặt.
 * 'anonymous' chỉ có khi đăng nhập TẮT — production (https / CRM_REQUIRE_LOGIN=1) mà chưa có tài khoản
 * thì server trả 503 trước khi tới đây, nên không ai "vô danh" ghi được Cài đặt trên máy chủ thật.
 */
export function isManager(actor) {
  return ['owner', 'admin', 'anonymous'].includes(actor?.role);
}

export const MANAGER_ONLY_ERROR = 'Chỉ chủ shop hoặc Quản trị mới được đổi mục Cài đặt này.';

/**
 * Tạo requireManager(request, response): true khi người gọi là chủ shop / Quản trị (hay CRM chưa
 * bật đăng nhập ở máy local); nếu không thì tự trả 403 và trả false. Route dùng:
 *   if (!(await requireManager(request, response))) return;
 * `resolveActor(request)` → actor (actorOf đã gắn auth); `send(response, status, body)` = sendJson.
 */
export function createRequireManager(resolveActor, send) {
  return async function requireManager(request, response, message = MANAGER_ONLY_ERROR) {
    const actor = await resolveActor(request);
    if (isManager(actor)) return true;
    send(response, 403, { error: message });
    return false;
  };
}

/** { username, name } để ghi lên dữ liệu (đơn, ghi chú, tin nhắn). */
export function actorStamp(actor) {
  const username = String(actor?.username || '').slice(0, 32);
  const name = String(actor?.name || username || ANONYMOUS_NAME).slice(0, 80);
  return { username, name };
}
