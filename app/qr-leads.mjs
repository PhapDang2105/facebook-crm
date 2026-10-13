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
  // 13/10 chủ shop: tin ưu đãi QR đã gửi tới hội thoại Messenger của khách + hội thoại mang thẻ Re-marketing → tự chuyển.
  messaged: 'Đã gửi mess',
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
    // Kênh khách bấm sau khi nhập số (trang đệm 12/10: nút Messenger hay đường Zalo; 'form' = máy tắt JavaScript).
    channel: ['messenger', 'zalo', 'form'].includes(value.channel) ? value.channel : '',
    test: value.test === true,
    status: Object.hasOwn(QR_LEAD_STATUSES, value.status) ? value.status : 'new',
    note: text(value.note, 500),
    updatedAt: Number(value.updatedAt) || 0,
    updatedBy: text(value.updatedBy, 80),
    // Hội thoại Messenger của khách (nối tự động, linkQrLeads) và lúc tin ưu đãi QR được gửi tới đó.
    conversationId: text(value.conversationId, 120),
    messagedAt: Number(value.messagedAt) || 0
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
export async function addQrLead({ code, phone, name = '', platform = '', browser = '', channel = '', test = false, now = Date.now() }) {
  const parsed = parseQrLeadInput({ phone, name });
  if (parsed.error) throw new Error(parsed.error);
  return queueWrite(store => {
    const existing = [...store.leads].reverse().find(lead => lead.phone === parsed.phone && lead.test === Boolean(test) && now - lead.lastAt <= qrLeadMergeWindowMs);
    if (existing) {
      // Bấm lại trong 2 phút (bấm hai lần, quay lại trang bấm tiếp) là cùng một lượt, không đếm thêm.
      if (now - existing.lastAt > 2 * 60 * 1000) existing.visits += 1;
      existing.lastAt = now;
      if (['messenger', 'zalo', 'form'].includes(channel)) existing.channel = channel;
      if (parsed.name) existing.name = parsed.name;
      if (code) existing.code = text(code, 40);
      if (existing.status === 'invalid') existing.status = 'new';
      return { lead: { ...existing }, created: false };
    }
    const lead = normalizeLead({ id: randomUUID(), code, phone: parsed.phone, name: parsed.name, createdAt: now, lastAt: now, platform, browser, channel, test: Boolean(test) });
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

// Khách nhập số trên trang đệm rồi bấm Messenger: Meta báo lượt quét (qrReferrals) vài giây sau. Cửa sổ nối theo giờ.
const linkBeforeMs = 2 * 60 * 1000;
const linkAfterMs = 15 * 60 * 1000;
const phoneKey9 = value => String(value || '').replace(/\D/g, '').slice(-9);
const phoneKeysIn = text => {
  const keys = new Set();
  for (const match of String(text || '').matchAll(/(?<!\d)(?:\+?84|0)(?:[ .-]?\d){9}(?!\d)/g)) keys.add(phoneKey9(match[0]));
  return keys;
};

/**
 * 13/10 chủ shop: khách để lại SĐT trên trang quét, rồi hội thoại Messenger của khách đã nhận tin ưu đãi QR (Botcake hay
 * CRM chào — `qrGreetedAt`) và mang thẻ Re-marketing → dòng của khách chuyển "Đã gửi mess". Hàm thuần, trả danh sách cập nhật
 * `[{ id, conversationId, messagedAt }]`; chỉ xét dòng "Chưa liên hệ" chưa nối (không đè trạng thái nhân viên chọn).
 *
 * Nối dòng ↔ hội thoại theo một trong hai cách:
 *  - SĐT: số khách để lại có trong tin khách gửi / đơn / giỏ của hội thoại (chắc chắn nhất);
 *  - Giờ: lượt quét thẻ của hội thoại (qrReferrals) đến trong khoảng −2 … +15 phút quanh lúc khách để lại số qua nút
 *    Messenger. Hai dòng cùng tranh một hội thoại, hay một dòng khớp hai hội thoại → bỏ (không đoán), trừ khi có khớp SĐT.
 */
export function linkQrLeads(leads, { conversations = [], messages = {}, remarketingLabels = [], now = Date.now() } = {}) {
  const tags = new Set((Array.isArray(remarketingLabels) ? remarketingLabels : []).map(String));
  if (!tags.size) return [];
  const candidates = (Array.isArray(conversations) ? conversations : []).filter(conversation => conversation
    && conversation.source !== 'comment'
    && Number(conversation.qrGreetedAt) > 0
    && (Array.isArray(conversation.labels) ? conversation.labels : []).some(label => tags.has(String(label))));
  if (!candidates.length) return [];
  const phonesOf = conversation => {
    const keys = new Set();
    for (const message of Array.isArray(messages?.[conversation.id]) ? messages[conversation.id] : []) {
      if (message?.direction === 'incoming') for (const key of phoneKeysIn(message.text)) keys.add(key);
    }
    for (const order of Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []) if (order?.phone) keys.add(phoneKey9(order.phone));
    if (conversation.pendingOrder?.phone) keys.add(phoneKey9(conversation.pendingOrder.phone));
    return keys;
  };
  const phoneIndex = new Map(candidates.map(conversation => [conversation.id, phonesOf(conversation)]));
  const open = (Array.isArray(leads) ? leads : []).filter(lead => lead && !lead.test && lead.status === 'new' && !lead.conversationId && now - (Number(lead.lastAt) || 0) < 30 * 24 * 60 * 60 * 1000);
  const taken = new Set((Array.isArray(leads) ? leads : []).map(lead => lead?.conversationId).filter(Boolean));
  const result = [];
  const timeMatches = new Map();
  for (const lead of open) {
    const key = phoneKey9(lead.phone);
    const byPhone = candidates.find(conversation => !taken.has(conversation.id) && phoneIndex.get(conversation.id).has(key));
    if (byPhone) {
      taken.add(byPhone.id);
      result.push({ id: lead.id, conversationId: byPhone.id, messagedAt: Number(byPhone.qrGreetedAt) });
      continue;
    }
    if (lead.channel && lead.channel !== 'messenger') continue;
    const times = [Number(lead.createdAt) || 0, Number(lead.lastAt) || 0].filter(Boolean);
    const near = candidates.filter(conversation => (Array.isArray(conversation.qrReferrals) ? conversation.qrReferrals : [])
      .some(referral => times.some(at => (Number(referral?.at) || 0) >= at - linkBeforeMs && (Number(referral?.at) || 0) <= at + linkAfterMs)));
    timeMatches.set(lead.id, near);
  }
  const claims = new Map();
  for (const [leadId, near] of timeMatches) if (near.length === 1) claims.set(near[0].id, [...(claims.get(near[0].id) || []), leadId]);
  for (const [conversationId, leadIds] of claims) {
    if (leadIds.length !== 1 || taken.has(conversationId)) continue;
    const conversation = candidates.find(item => item.id === conversationId);
    taken.add(conversationId);
    result.push({ id: leadIds[0], conversationId, messagedAt: Number(conversation.qrGreetedAt) });
  }
  return result;
}

/** Ghi kết quả linkQrLeads: chỉ dòng vẫn còn "Chưa liên hệ" và chưa nối (nhân viên vừa đổi thì thôi). Trả số dòng đổi. */
export async function applyQrLeadLinks(links, { now = Date.now() } = {}) {
  if (!Array.isArray(links) || !links.length) return 0;
  return queueWrite(store => {
    let changed = 0;
    for (const link of links) {
      const lead = store.leads.find(item => item.id === link.id);
      if (!lead || lead.status !== 'new' || lead.conversationId) continue;
      lead.status = 'messaged';
      lead.conversationId = text(link.conversationId, 120);
      lead.messagedAt = Number(link.messagedAt) || now;
      lead.updatedAt = now;
      lead.updatedBy = 'Tự động';
      changed += 1;
    }
    return changed;
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
