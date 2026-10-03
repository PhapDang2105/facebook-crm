// Nhật ký hoạt động của NGƯỜI DÙNG CRM (chủ shop yêu cầu lưu dấu vết toàn bộ thao tác nhân viên):
// ai nhắn tin, ai xem hội thoại, ai lên/sửa/hủy đơn, ai sửa khách/thẻ/bật tắt bot, ai sửa cài
// đặt, đăng nhập/đăng xuất/đăng nhập sai. Việc tự động của bot/đồng bộ KHÔNG ghi ở đây (đã có
// journal và nhật ký quyết định).
//
// Lưu: data/processed/audit-log/YYYY-MM-DD.jsonl (ngày theo giờ Việt Nam; AUDIT_LOG_DIR ghi đè),
// mỗi dòng một bản ghi, ghi nối tiếp qua hàng đợi promise (không chặn request; lỗi chỉ warn).
// Giữ 365 ngày: tệp cũ hơn bị xóa ở lần ghi đầu tiên mỗi ngày. SĐT/email trong summary được che
// bằng maskPersonal (cùng hàm với nhật ký quyết định của bot).
//
// Bản ghi: { id, at, actor, actorName, role, action, target: { type, id, name }, conversationId,
// orderId, summary (≤ 200 ký tự), ip, details? (object nhỏ tùy chọn) }.
// Ngoại lệ "chỉ người dùng": thẻ / bật-tắt bot / phân công của hội thoại ghi cả khi bot hay hệ thống
// tự làm (actor 'bot' / 'system') để lịch sử hội thoại đầy đủ như Pancake.
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { maskPersonal, vnDateKey } from './processing/decision-log.mjs';

export const auditKeepDays = 365;
export const AUDIT_SUMMARY_MAX = 200;
export const AUDIT_QUERY_MAX = 500;
export const VIEW_DEDUPE_MS = 30 * 60 * 1000;

/** Danh mục hành động → nhãn tiếng Việt (giao diện Nhật ký hiện nhãn, lọc theo tiền tố mã). */
export const AUDIT_ACTIONS = Object.freeze({
  'auth.login': 'Đăng nhập',
  'auth.login_failed': 'Đăng nhập sai',
  'auth.logout': 'Đăng xuất',
  'conversation.view': 'Xem hội thoại',
  'conversation.read': 'Đánh dấu đã đọc',
  'conversation.unread': 'Đánh dấu chưa đọc',
  'conversation.mute': 'Tắt/bật thông báo hội thoại',
  'conversation.labels': 'Gắn/gỡ thẻ hội thoại',
  'conversation.bot': 'Bật/tắt bot hội thoại',
  'conversation.bot_error': 'Xóa lỗi bot',
  'conversation.assign': 'Phân công nhân viên',
  'conversation.sync': 'Đồng bộ hội thoại',
  'message.send': 'Gửi tin nhắn',
  'comment.reply': 'Trả lời bình luận',
  'comment.private_reply': 'Nhắn riêng người bình luận',
  'customer.update': 'Sửa thông tin khách',
  'customer.labels': 'Gắn/gỡ thẻ khách',
  'customer.note': 'Ghi chú khách',
  'customer.export': 'Tải danh sách khách',
  'report.export': 'Tải CSV báo cáo',
  'report.lark_conversation': 'Gửi báo cáo Lark',
  'order.create': 'Tạo đơn',
  'order.update': 'Sửa đơn',
  'order.status': 'Đổi trạng thái đơn',
  'order.cancel': 'Hủy đơn',
  'order.hide': 'Ẩn/hiện đơn trong bảng',
  'order.delete': 'Xóa đơn',
  'order.resend_receipt': 'Gửi lại phiếu đơn',
  'order.push_pos': 'Đẩy đơn sang POS',
  'order.export': 'Xuất file đơn',
  'order.import': 'Nhập file đơn',
  'landing.sync_pos': 'Kéo đơn landing từ POS',
  'followup.run': 'Chạy bám đuổi (Gửi ngay)',
  'followup.queue': 'Xử lý hàng chờ bám đuổi',
  'followup.batch': 'Lấy lô bám đuổi (trạm Pancake)',
  'followup.batch_results': 'Báo kết quả lô bám đuổi',
  'followup.prune': 'Dọn hàng chờ bám đuổi',
  'shipping.settings': 'Bật/tắt tự nhắn khách hành trình vận đơn',
  'shipping.notice_batch': 'Lấy tin báo vận đơn gửi qua Pancake',
  'shipping.notice_result': 'Báo kết quả gửi tin vận đơn',
  'shipping.notice_send': 'Gửi tin vận đơn cho khách',
  'campaign.sync': 'Đồng bộ số liệu quảng cáo',
  'campaign.insights': 'Phân tích chiến dịch bằng AI',
  'settings.chatbot': 'Sửa cài đặt chatbot',
  'settings.golden': 'Bộ test vàng của bot',
  'settings.gifts': 'Sửa quà tặng / phí ship',
  'settings.products': 'Sửa sản phẩm',
  'settings.messages': 'Sửa mẫu trả lời / thẻ',
  'settings.staff': 'Sửa nhân sự',
  'settings.qr': 'Sửa mã QR',
  'settings.channels': 'Sửa kênh kết nối',
  'settings.pos': 'Sửa kết nối POS'
});

export function auditActionLabel(action) {
  return AUDIT_ACTIONS[action] || String(action || '');
}

/** Thư mục nhật ký: đọc AUDIT_LOG_DIR mỗi lần (test đặt thư mục tạm). */
export function auditLogDir() {
  return process.env.AUDIT_LOG_DIR || path.join(projectRoot, 'data', 'processed', 'audit-log');
}

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Chữ thường không dấu (đ → d) để tìm kiếm "khong dau" khớp "Không dấu". */
export function foldText(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
}

/** Mã ngắn, duy nhất (7 ký tự base64url ~ 40 bit ngẫu nhiên). */
function newId() {
  return randomBytes(5).toString('base64url');
}

export const AUDIT_DETAILS_MAX = 2000;

/**
 * `details`: object nhỏ tùy chọn (thẻ thêm/gỡ, bot bật/tắt, phân công từ → tới…). Chuỗi bị che
 * SĐT/email và cắt 200 ký tự, mảng ≤ 30 phần tử, sâu ≤ 3 cấp; JSON quá 2000 ký tự thì bỏ.
 */
function cleanDetails(value, depth = 0) {
  if (typeof value === 'string') return maskPersonal(clip(value, 200));
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (depth >= 3) return null;
  if (Array.isArray(value)) return value.slice(0, 30).map(item => cleanDetails(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 30)
      .filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key))
      .map(([key, item]) => [clip(key, 40), cleanDetails(item, depth + 1)]));
  }
  return null;
}

function normalizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const cleaned = cleanDetails(details);
  if (!Object.keys(cleaned).length) return undefined;
  return JSON.stringify(cleaned).length <= AUDIT_DETAILS_MAX ? cleaned : undefined;
}

/** Bản ghi chuẩn hóa từ đầu vào tự do của server. */
export function normalizeAuditEntry(entry = {}, now = Date.now()) {
  const target = entry.target && typeof entry.target === 'object'
    ? { type: clip(entry.target.type, 40), id: clip(entry.target.id, 200), name: maskPersonal(clip(entry.target.name, 120)) }
    : { type: '', id: '', name: '' };
  const details = normalizeDetails(entry.details);
  return {
    id: newId(),
    at: now,
    actor: clip(entry.actor, 64),
    actorName: maskPersonal(clip(entry.actorName, 80)),
    role: clip(entry.role, 20),
    action: clip(entry.action, 60),
    target,
    conversationId: clip(entry.conversationId, 200),
    orderId: clip(entry.orderId, 80),
    summary: maskPersonal(clip(entry.summary, 1000)).slice(0, AUDIT_SUMMARY_MAX),
    ip: clip(entry.ip, 64),
    ...(details ? { details } : {})
  };
}

/* ---- Thẻ / bot / phân công tự động ----
 * Nhật ký chỉ ghi thao tác người dùng, NGOẠI TRỪ ba loại này: lịch sử thẻ, bật/tắt bot, phân công
 * của một hội thoại phải đầy đủ như "Lịch sử cập nhật hội thoại" của Pancake, nên khi bot hay hệ
 * thống (đồng bộ POS, bám đuổi, Pancake) tự đổi thì cũng ghi, người làm là 'bot' / 'system'.
 */
export const AUTOMATED_ACTORS = Object.freeze({
  bot: Object.freeze({ username: 'bot', name: 'Chatbot AI', role: 'bot' }),
  system: Object.freeze({ username: 'system', name: 'Hệ thống', role: 'system' })
});

/**
 * Thẻ thêm/gỡ giữa hai bộ mã thẻ, đổi ra TÊN thẻ theo Cài đặt → Tin nhắn (`labelDefs`: [{ id, name }]).
 * Trả { added: [tên], removed: [tên], addedIds, removedIds }.
 */
export function labelChangeDetails(before = [], after = [], labelDefs = []) {
  const names = new Map((Array.isArray(labelDefs) ? labelDefs : []).map(label => [String(label?.id), String(label?.name || label?.id)]));
  const previous = (Array.isArray(before) ? before : []).map(String);
  const next = (Array.isArray(after) ? after : []).map(String);
  const addedIds = next.filter(id => !previous.includes(id));
  const removedIds = previous.filter(id => !next.includes(id));
  const name = id => names.get(id) || id;
  return { added: addedIds.map(name), removed: removedIds.map(name), addedIds, removedIds };
}

/** "+Đã mua hàng, −Khiếu nại". */
export function labelChangeText({ added = [], removed = [] } = {}) {
  return [...added.map(name => `+${name}`), ...removed.map(name => `−${name}`)].join(', ');
}

const actorFields = actor => ({ actor: actor?.username || '', actorName: actor?.name || actor?.username || '', role: actor?.role || '', ip: actor?.ip || '' });

/**
 * Ghi conversation.labels cho một lần đổi thẻ (người dùng hay tự động). Không đổi gì thì không ghi
 * (trả null). `reason`: câu ngắn vì sao (ví dụ "bot chốt đơn", "đồng bộ POS").
 */
export function appendLabelAudit({ actor, conversation, before = [], after = [], labelDefs = [], reason = '' } = {}, options) {
  const change = labelChangeDetails(before, after, labelDefs);
  if (!change.addedIds.length && !change.removedIds.length) return null;
  return appendAudit({
    ...actorFields(actor),
    action: 'conversation.labels',
    target: { type: 'conversation', id: conversation?.id || '', name: conversation?.name || '' },
    conversationId: conversation?.id || '',
    summary: `Thẻ: ${labelChangeText(change)}${reason ? ` (${reason})` : ''}`,
    details: { added: change.added, removed: change.removed }
  }, options);
}

/** Ghi conversation.bot (bật/tắt bot của một hội thoại), details { enabled }. */
export function appendBotToggleAudit({ actor, conversation, enabled, reason = '' } = {}, options) {
  return appendAudit({
    ...actorFields(actor),
    action: 'conversation.bot',
    target: { type: 'conversation', id: conversation?.id || '', name: conversation?.name || '' },
    conversationId: conversation?.id || '',
    summary: `${enabled ? 'Bật' : 'Tắt'} bot cho hội thoại${reason ? ` (${reason})` : ''}.`,
    details: { enabled: Boolean(enabled) }
  }, options);
}

/** Ghi conversation.assign (phân công nhân viên), details { from, to } là TÊN người/nhóm. */
export function appendAssignAudit({ actor, conversation, from = '', to = '', reason = '' } = {}, options) {
  return appendAudit({
    ...actorFields(actor),
    action: 'conversation.assign',
    target: { type: 'conversation', id: conversation?.id || '', name: conversation?.name || '' },
    conversationId: conversation?.id || '',
    summary: `Phân công: ${from || 'Chưa phân công'} → ${to || 'Chưa phân công'}${reason ? ` (${reason})` : ''}.`,
    details: { from: from || '', to: to || '' }
  }, options);
}

// Hàng đợi ghi và ngày đã dọn tệp cũ, theo từng thư mục (test dùng thư mục tạm riêng).
const queues = new Map();
const prunedDay = new Map();
// Người đã xuất hiện trong nhật ký, theo thư mục: nạp một lượt khi được hỏi, cập nhật khi ghi.
const actorIndex = new Map();

async function pruneOldFiles(dir, now) {
  const names = await readdir(dir).catch(() => []);
  const threshold = vnDateKey(now - auditKeepDays * 24 * 60 * 60 * 1000);
  for (const name of names) {
    const match = name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (match && match[1] < threshold) await unlink(path.join(dir, name)).catch(() => {});
  }
}

/**
 * Ghi một bản ghi vào tệp của ngày hiện tại. Không chặn (người gọi không cần đợi), không bao giờ
 * ném lỗi: trả promise của lần ghi, giải ra bản ghi đã lưu (hoặc null khi lỗi).
 */
export function appendAudit(entry, { dir = auditLogDir(), now = Date.now() } = {}) {
  const record = normalizeAuditEntry(entry, now);
  if (!record.action) return Promise.resolve(null);
  const previous = queues.get(dir) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const day = vnDateKey(now);
    await mkdir(dir, { recursive: true });
    if (prunedDay.get(dir) !== day) {
      prunedDay.set(dir, day);
      await pruneOldFiles(dir, now);
    }
    await appendFile(path.join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
    const index = actorIndex.get(dir);
    if (index && record.actor && record.role) index.set(record.actor, record.actorName || record.actor);
    return record;
  }).catch(error => {
    console.warn(`Nhật ký hoạt động: không ghi được (${String(error?.message || error).slice(0, 120)})`);
    return null;
  });
  queues.set(dir, run);
  return run;
}

/** Đợi mọi lần ghi đang chờ xong (test, tắt máy chủ). */
export function flushAudit(dir = auditLogDir()) {
  return queues.get(dir) || Promise.resolve();
}

async function dayFiles(dir) {
  const names = await readdir(dir).catch(() => []);
  return names.map(name => name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1]).filter(Boolean).sort().reverse();
}

async function readDay(dir, day) {
  const raw = await readFile(path.join(dir, `${day}.jsonl`), 'utf8').catch(() => '');
  const items = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item && typeof item === 'object' && item.action) items.push(item);
    } catch { /* Dòng ghi dở (mất điện giữa chừng): bỏ qua. */ }
  }
  return items;
}

/** Thứ tự mới → cũ: theo `at`, cùng mốc thì theo id (tổng thứ tự cố định để con trỏ không lặp/sót). */
function newerFirst(a, b) {
  return (Number(b.at) || 0) - (Number(a.at) || 0) || (String(b.id) < String(a.id) ? -1 : String(b.id) > String(a.id) ? 1 : 0);
}

function parseCursor(value) {
  const text = String(value || '');
  const separator = text.indexOf(':');
  if (separator < 1) return null;
  const at = Number(text.slice(0, separator));
  if (!Number.isFinite(at)) return null;
  return { at, id: text.slice(separator + 1) };
}

/** Bản ghi nằm SAU con trỏ (cũ hơn) theo thứ tự newerFirst. */
function isOlderThan(item, cursor) {
  const at = Number(item.at) || 0;
  return at < cursor.at || (at === cursor.at && String(item.id) < cursor.id);
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Đọc nhật ký, mới nhất trước. Bộ lọc: from/to (YYYY-MM-DD giờ VN, gồm cả hai đầu), actor (tên đăng
 * nhập), action (khớp tiền tố: "order." gồm mọi order.*; nhiều tiền tố cách dấu phẩy), q (không dấu, trong summary/target.name/
 * actorName), conversationId, orderId, limit (≤ 500), before (con trỏ "at:id" của trang trước).
 * Trả { items, next } — next là con trỏ trang sau, null khi hết.
 */
export async function queryAudit(filters = {}, { dir = auditLogDir() } = {}) {
  await flushAudit(dir);
  const from = dayPattern.test(String(filters.from || '')) ? String(filters.from) : '';
  const to = dayPattern.test(String(filters.to || '')) ? String(filters.to) : '';
  const actor = String(filters.actor || '').trim().toLowerCase();
  // Nhiều tiền tố cách dấu phẩy ("order.,landing." / "message.send,conversation.view"): khớp bất kỳ.
  const actions = String(filters.action || '').split(',').map(item => item.trim()).filter(Boolean);
  const q = foldText(String(filters.q || '').trim());
  const conversationId = String(filters.conversationId || '').trim();
  const orderId = String(filters.orderId || '').trim();
  const limit = Math.max(1, Math.min(AUDIT_QUERY_MAX, Math.round(Number(filters.limit)) || 100));
  const cursor = parseCursor(filters.before);
  const cursorDay = cursor ? vnDateKey(cursor.at) : '';

  const matches = item => {
    if (cursor && !isOlderThan(item, cursor)) return false;
    if (actor && String(item.actor || '').toLowerCase() !== actor) return false;
    if (actions.length && !actions.some(prefix => String(item.action || '').startsWith(prefix))) return false;
    if (conversationId && item.conversationId !== conversationId) return false;
    if (orderId && item.orderId !== orderId) return false;
    if (q && !foldText(`${item.summary || ''} ${item.target?.name || ''} ${item.actorName || ''}`).includes(q)) return false;
    return true;
  };

  const items = [];
  for (const day of await dayFiles(dir)) {
    if (to && day > to) continue;
    if (from && day < from) break;
    if (cursorDay && day > cursorDay) continue;
    const found = (await readDay(dir, day)).filter(matches).sort(newerFirst);
    items.push(...found);
    if (items.length > limit) break;
  }
  const page = items.slice(0, limit);
  const last = page.at(-1);
  return { items: page, next: items.length > limit && last ? `${last.at}:${last.id}` : null };
}

/**
 * Mọi người đã có trong nhật ký: [{ username, name }] (tên mới nhất). Bỏ tên gõ ở lần đăng nhập
 * sai (không có vai trò) để danh sách lọc không đầy tên gõ nhầm.
 */
export async function auditActors({ dir = auditLogDir() } = {}) {
  await flushAudit(dir);
  let index = actorIndex.get(dir);
  if (!index) {
    index = new Map();
    // Đọc cũ → mới để tên mới nhất đè tên cũ.
    for (const day of (await dayFiles(dir)).reverse()) {
      for (const item of await readDay(dir, day)) if (item.actor && item.role) index.set(item.actor, item.actorName || item.actor);
    }
    actorIndex.set(dir, index);
  }
  return [...index].map(([username, name]) => ({ username, name }));
}

/**
 * Gộp "xem hội thoại": cùng người + cùng hội thoại chỉ ghi một lần mỗi `windowMs` (30 phút).
 * Bộ nhớ đệm trong RAM (khởi động lại thì ghi lại lần đầu — chấp nhận được).
 */
export function createViewThrottle({ windowMs = VIEW_DEDUPE_MS, maxEntries = 20000 } = {}) {
  const seen = new Map();
  return function shouldRecordView(who, conversationId, now = Date.now()) {
    const key = `${who}\u0000${conversationId}`;
    const last = seen.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    seen.delete(key);
    seen.set(key, now);
    if (seen.size > maxEntries) {
      for (const [entryKey, at] of seen) {
        if (seen.size <= maxEntries && now - at < windowMs) break;
        if (now - at >= windowMs || seen.size > maxEntries) seen.delete(entryKey);
      }
    }
    return true;
  };
}
