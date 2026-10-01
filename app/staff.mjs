// Nhân sự (Cài đặt → Nhân sự): danh sách người dùng CRM, chuẩn bị cho đăng nhập.
// Lưu ở data/processed/staff.json (đổi bằng STAFF_PATH). Mật khẩu chỉ lưu chuỗi băm
// scrypt (hashPassword của app/auth.mjs); API và giao diện không bao giờ trả chuỗi băm.
// Nhân viên đang làm và đã đặt mật khẩu được thêm vào danh sách đăng nhập (staffLoginUsers).
// Không xoá nhân viên: chuyển "Đã nghỉ" để giữ lịch sử (đơn, tin nhắn còn ghi tên họ).
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { hashPassword } from './auth.mjs';

export const staffPath = process.env.STAFF_PATH || path.join(projectRoot, 'data', 'processed', 'staff.json');
export const STAFF_ROLES = Object.freeze({ admin: 'Quản trị', staff: 'Nhân viên' });
export const MIN_PASSWORD_LENGTH = 8;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

let writeQueue = Promise.resolve();

function emptyStore() {
  return { items: [], updatedAt: 0 };
}

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Tên trên Pancake/POS (tên nhân viên hiện ở tin nhắn và đơn), để đối chiếu người làm. */
function pancakeNamesOf(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(list.map(item => text(item, 80)).filter(Boolean))].slice(0, 5);
}

function normalizeMember(item) {
  if (!item || typeof item !== 'object') return null;
  const username = text(item.username, 32).toLowerCase();
  if (!item.id || !username) return null;
  return {
    id: String(item.id),
    name: text(item.name, 80) || username,
    username,
    role: item.role === 'admin' ? 'admin' : 'staff',
    phone: String(item.phone ?? '').replace(/[^\d+]/g, '').slice(0, 15),
    pancakeNames: pancakeNamesOf(item.pancakeNames),
    active: item.active !== false,
    passwordHash: typeof item.passwordHash === 'string' && item.passwordHash.startsWith('scrypt$') ? item.passwordHash : '',
    passwordSetAt: Number(item.passwordSetAt) || 0,
    // Phiên bản phiên đăng nhập: tăng khi đổi mật khẩu / cho nghỉ / đổi tên đăng nhập → mọi cookie cũ vô hiệu.
    sessionVersion: Math.max(0, Math.trunc(Number(item.sessionVersion) || 0)),
    createdAt: Number(item.createdAt) || 0,
    updatedAt: Number(item.updatedAt) || 0
  };
}

export async function readStaffStore() {
  try {
    const raw = JSON.parse(await readFile(staffPath, 'utf8'));
    return { items: (Array.isArray(raw?.items) ? raw.items : []).map(normalizeMember).filter(Boolean), updatedAt: Number(raw?.updatedAt) || 0 };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    throw new Error(`Không đọc được danh sách nhân sự: ${error.message}`);
  }
}

async function writeStaffStore(store) {
  await mkdir(path.dirname(staffPath), { recursive: true });
  const temporary = `${staffPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(temporary, staffPath);
}

/** Một lần sửa kho tại một thời điểm (hai người lưu cùng lúc không đè nhau). */
function updateStaffStore(mutate) {
  const run = writeQueue.then(async () => {
    const store = await readStaffStore();
    const result = await mutate(store);
    store.updatedAt = Date.now();
    await writeStaffStore(store);
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

/** Bản gửi ra giao diện: không có chuỗi băm, chỉ biết đã đặt mật khẩu chưa. */
export function publicMember(member) {
  const { passwordHash, sessionVersion, ...rest } = member;
  return { ...rest, roleName: STAFF_ROLES[member.role], hasPassword: Boolean(passwordHash) };
}

export async function listStaff() {
  return (await readStaffStore()).items.map(publicMember)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'vi'));
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * Còn ít nhất một quản trị đang làm có mật khẩu (khi không có tài khoản .env) để không ai bị khoá ngoài.
 * Đã có ai đặt mật khẩu (đăng nhập dựa vào Nhân sự) thì không cho cho nghỉ/hạ quyền quản trị cuối cùng:
 * hết tài khoản là đăng nhập tự tắt và CRM mở cho mọi người.
 */
function keepsAnAdmin(items, reservedUsernames) {
  if (reservedUsernames.size) return true;
  if (!items.some(item => item.passwordHash)) return true;
  return items.some(item => item.active && item.role === 'admin' && item.passwordHash);
}

/**
 * Thêm (không có id) hoặc sửa nhân viên. `password` trống = giữ mật khẩu cũ.
 * reservedUsernames: tên đăng nhập đã dùng ở .env (CRM_LOGIN_USERS), không được trùng.
 */
export async function saveStaffMember(input = {}, { id = '', reservedUsernames = new Set(), now = Date.now() } = {}) {
  const password = input.password === undefined || input.password === null ? '' : String(input.password);
  if (password && password.length < MIN_PASSWORD_LENGTH) throw badRequest(`Mật khẩu cần ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`);
  const passwordHash = password ? await hashPassword(password) : '';
  return updateStaffStore(store => {
    const existing = id ? store.items.find(item => item.id === id) : null;
    if (id && !existing) throw Object.assign(new Error('Không tìm thấy nhân viên này.'), { statusCode: 404 });
    const name = input.name === undefined ? existing?.name : text(input.name, 80);
    if (!name) throw badRequest('Nhập họ tên nhân viên.');
    const username = input.username === undefined ? existing?.username : text(input.username, 32).toLowerCase();
    if (!USERNAME_PATTERN.test(username || '')) throw badRequest('Tên đăng nhập 3–32 ký tự, chỉ chữ thường không dấu, số và . _ -');
    if (reservedUsernames.has(username)) throw badRequest(`Tên đăng nhập "${username}" đã dùng cho tài khoản chủ shop.`);
    if (store.items.some(item => item.username === username && item.id !== existing?.id)) throw badRequest(`Tên đăng nhập "${username}" đã có người dùng.`);
    const next = normalizeMember({
      ...(existing || { id: `st_${randomBytes(6).toString('hex')}`, createdAt: now, active: true }),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.pancakeNames !== undefined ? { pancakeNames: input.pancakeNames } : {}),
      ...(input.active !== undefined ? { active: input.active !== false } : {}),
      name,
      username,
      ...(passwordHash ? { passwordHash, passwordSetAt: now } : {}),
      updatedAt: now
    });
    // Thu hồi phiên phía máy chủ: đổi mật khẩu, cho nghỉ (hay đi làm lại), đổi tên đăng nhập.
    if (existing && (passwordHash || next.active !== existing.active || next.username !== existing.username)) {
      next.sessionVersion = (existing.sessionVersion || 0) + 1;
    }
    const items = existing ? store.items.map(item => (item.id === existing.id ? next : item)) : [...store.items, next];
    if (!keepsAnAdmin(items, reservedUsernames)) throw badRequest('Cần ít nhất một Quản trị đang làm có mật khẩu, để còn người vào được trang Nhân sự.');
    store.items = items;
    return publicMember(next);
  });
}

/** Tên đăng nhập → chuỗi băm của nhân viên đang làm đã đặt mật khẩu (cho app/auth.mjs). */
export async function staffLoginUsers() {
  const store = await readStaffStore().catch(() => emptyStore());
  return new Map(store.items.filter(item => item.active && item.passwordHash).map(item => [item.username, item.passwordHash]));
}

/**
 * Như staffLoginUsers nhưng kèm phiên bản phiên: tên → { hash, version } (cho createAuth).
 * KHÔNG nuốt lỗi đọc kho: người gọi giữ danh sách cũ khi đĩa trục trặc, thay vì xoá hết
 * tài khoản (xoá hết = đăng nhập tắt).
 */
export async function staffLoginAccounts() {
  const store = await readStaffStore();
  return new Map(store.items.filter(item => item.active && item.passwordHash)
    .map(item => [item.username, { hash: item.passwordHash, version: item.sessionVersion || 0 }]));
}

/** Nhân viên theo tên đăng nhập (đang làm), để biết vai trò của phiên. */
export async function staffByUsername(username) {
  const name = String(username || '').trim().toLowerCase();
  if (!name) return null;
  const member = (await readStaffStore().catch(() => emptyStore())).items.find(item => item.username === name && item.active);
  return member ? publicMember(member) : null;
}
