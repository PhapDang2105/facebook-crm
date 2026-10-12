// Khách để lại số điện thoại trên trang đệm QR (/q/<mã>) — 12/10 chủ shop: khách quét thẻ cảm ơn, vào Messenger
// nhưng không nhắn thì Page không được nhắn trước (Meta), CRM không biết khách là ai. Trang đệm xin SĐT (và tên nếu
// khách muốn) để "giữ ưu đãi cho đơn sau"; nhân viên gọi / nhắn Zalo rồi lên đơn. Kho riêng, không trộn vào kho đếm
// lượt quét (qr-scans) hay kho khách: khách chưa mua thì chưa phải "khách hàng" (màn Khách hàng chỉ hiện người đã nhận hàng).
//
// Cùng một số để lại lần nữa trong 30 ngày thì cập nhật dòng cũ (đếm lần, lấy tên mới), không thêm dòng.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { readJsonFile, writeJsonAtomic } from './json-store.mjs';
import { toLocalPhoneLoose } from './phone-warnings.mjs';

const leadsPath = process.env.QR_LEADS_PATH
  || path.join(projectRoot, 'data', 'processed', 'qr-leads.json');

const DAY = 24 * 60 * 60 * 1000;
export const qrLeadMergeWindowMs = 30 * DAY;
const leadKeepLimit = 5000;

// Trạng thái nhân viên chọn sau khi liên hệ. "Đã mua" không nằm ở đây: máy chủ tự suy ra từ đơn có cùng SĐT.
export const QR_LEAD_STATUSES = {
  new: 'Chưa liên hệ',
  called: 'Đã gọi',
  'no-answer': 'Không nghe máy',
  zalo: 'Đã nhắn Zalo',
  ordered: 'Đã lên đơn',
  invalid: 'Sai số / không có nhu cầu'
};

const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

let cachedStore = null;
let writeQueue = Promise.resolve();

function normalizeLead(value) {
  if (!value || typeof value !== 'object') return null;
  const phone = toLocalPhoneLoose(value.phone);
  if (!phone) return null;
  const createdAt = Number(value.createdAt) || 0;
  return {
    id: text(value.id, 60) || randomUUID(),
    code: text(value.code, 40),
    phone,
    name: text(value.name, 80),
    createdAt,
    lastAt: Number(value.lastAt) || createdAt,
    visits: Math.max(1, Math.round(Number(value.visits) || 1)),
    platform: text(value.platform, 20),
    browser: text(value.browser, 20),
    test: value.test === true,
    status: Object.hasOwn(QR_LEAD_STATUSES, value.status) ? value.status : 'new',
    note: text(value.note, 500),
    updatedAt: Number(value.updatedAt) || 0,
    updatedBy: text(value.updatedBy, 80)
  };
}

function normalizeStore(value) {
  const leads = (Array.isArray(value?.leads) ? value.leads : []).map(normalizeLead).filter(Boolean);
  return { leads: leads.slice(-leadKeepLimit) };
}

export async function readQrLeads() {
  if (cachedStore) return cachedStore;
  cachedStore = await readJsonFile(leadsPath, { fallback: () => ({ leads: [] }), normalize: normalizeStore, label: 'Kho khách để lại SĐT (QR)' });
  return cachedStore;
}

function queueWrite(mutate) {
  const operation = writeQueue.then(async () => {
    const store = await readQrLeads();
    const next = { leads: store.leads.map(lead => ({ ...lead })) };
    const result = mutate(next);
    next.leads = next.leads.slice(-leadKeepLimit);
    await writeJsonAtomic(leadsPath, next);
    cachedStore = next;
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

/**
 * Kiểm ô khách gõ trên trang đệm. Trả `{ phone, name }` hoặc `{ error }` (câu tiếng Việt cho khách).
 * Chỉ nhận số di động Việt Nam (toLocalPhoneLoose: 0xxxxxxxxx, +84…, mất số 0 đầu).
 */
export function parseQrLeadInput({ phone, name } = {}) {
  const raw = text(phone, 30);
  if (!raw) return { error: 'Anh/Chị nhập số điện thoại giúp em nhé.' };
  const local = toLocalPhoneLoose(raw);
  if (!local) return { error: 'Số điện thoại chưa đúng, Anh/Chị kiểm tra lại giúp em (10 số, ví dụ 0912 345 678).' };
  return { phone: local, name: text(name, 80) };
}

/**
 * Lưu một lượt để lại SĐT. Cùng số trong 30 ngày (cùng loại thật/thử) → cập nhật dòng cũ: đếm lần, tên mới nếu có,
 * dòng đã đánh dấu "Sai số" quay về "Chưa liên hệ" (khách tự để lại lần nữa). Trả `{ lead, created }`.
 */
export async function addQrLead({ code, phone, name = '', platform = '', browser = '', test = false, now = Date.now() }) {
  const parsed = parseQrLeadInput({ phone, name });
  if (parsed.error) throw new Error(parsed.error);
  return queueWrite(store => {
    const existing = [...store.leads].reverse().find(lead => lead.phone === parsed.phone && lead.test === Boolean(test) && now - lead.lastAt <= qrLeadMergeWindowMs);
    if (existing) {
      existing.lastAt = now;
      existing.visits += 1;
      if (parsed.name) existing.name = parsed.name;
      if (code) existing.code = text(code, 40);
      if (existing.status === 'invalid') existing.status = 'new';
      return { lead: { ...existing }, created: false };
    }
    const lead = normalizeLead({ id: randomUUID(), code, phone: parsed.phone, name: parsed.name, createdAt: now, lastAt: now, platform, browser, test: Boolean(test) });
    store.leads.push(lead);
    return { lead: { ...lead }, created: true };
  });
}

/** Nhân viên đổi trạng thái / ghi chú. Trả dòng mới, hoặc null nếu không còn mã này. */
export async function updateQrLead(id, { status, note } = {}, { by = '', now = Date.now() } = {}) {
  if (status !== undefined && !Object.hasOwn(QR_LEAD_STATUSES, status)) throw new Error('Trạng thái không hợp lệ.');
  return queueWrite(store => {
    const lead = store.leads.find(item => item.id === String(id || ''));
    if (!lead) return null;
    if (status !== undefined) lead.status = status;
    if (note !== undefined) lead.note = text(note, 500);
    lead.updatedAt = now;
    lead.updatedBy = text(by, 80);
    return { ...lead };
  });
}

/** Xoá hẳn một dòng (khách nhờ xoá số, hay dòng thử). */
export async function deleteQrLead(id) {
  return queueWrite(store => {
    const before = store.leads.length;
    store.leads = store.leads.filter(item => item.id !== String(id || ''));
    return store.leads.length < before;
  });
}

/**
 * Danh sách cho màn Cài đặt → Mã QR, mới nhất trước. `purchases`: Map SĐT → mốc đơn gần nhất (ms) của mọi đơn
 * CRM biết (hội thoại, landing, POS, tệp xuất). Đơn đặt SAU lúc khách để lại số → `purchasedAt` (nhãn "Đã mua").
 */
export function qrLeadsView(leads, { purchases = new Map() } = {}) {
  return [...leads]
    .sort((first, second) => second.lastAt - first.lastAt)
    .map(lead => {
      const orderedAt = Number(purchases.get(lead.phone)) || 0;
      return { ...lead, purchasedAt: orderedAt >= lead.createdAt ? orderedAt : 0, boughtBefore: orderedAt > 0 && orderedAt < lead.createdAt };
    });
}

/**
 * Chặn gửi dồn từ một máy (băm IP, chỉ trong RAM): tối đa `max` lượt trong `windowMs`. Trang công khai, không đăng
 * nhập — không có chặn này thì một script có thể đổ hàng nghìn số rác vào bảng của nhân viên.
 */
export function createQrLeadLimiter({ max = 5, windowMs = 60 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    allow(key, now = Date.now()) {
      const id = String(key || 'unknown');
      const recent = (hits.get(id) || []).filter(at => now - at < windowMs);
      if (recent.length >= max) {
        hits.set(id, recent);
        return false;
      }
      recent.push(now);
      hits.set(id, recent);
      if (hits.size > 5000) {
        for (const [entry, times] of hits) if (!times.some(at => now - at < windowMs)) hits.delete(entry);
      }
      return true;
    }
  };
}
