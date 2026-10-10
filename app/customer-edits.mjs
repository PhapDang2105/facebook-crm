// Nhân viên sửa thông tin khách, gắn thẻ và ghi chú ngay trong hộp chi tiết ở
// màn Khách hàng. Bản ghi khách là dữ liệu SUY RA từ hội thoại và tệp khách
// hàng (customers.mjs dựng lại mỗi lần gọi), nên không có chỗ nào để ghi đè
// lên: sửa thẳng vào bản suy ra thì lần dựng sau mất sạch. Kho này giữ riêng
// phần nhân viên tự nhập rồi phủ lên bản suy ra, cùng lối với customer-file.mjs
// và order-edits.mjs: JSON, ghi tuần tự, đổi tên nguyên khối.
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { customerPhoneKey } from './customer-file.mjs';
import { createWriteQueue, readJsonFile, writeJsonAtomic } from './json-store.mjs';
import { normalizeEditedPhone } from './order-edits.mjs';

const customerEditsPath = process.env.CUSTOMER_EDITS_PATH
  || path.join(projectRoot, 'data', 'processed', 'customer-edits.json');

let cachedStore = null;
let storeLoading = null;
const enqueueWrite = createWriteQueue();

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function emptyStore() {
  return { customers: Object.create(null) };
}

function normalizeStore(value) {
  const stored = value.customers && typeof value.customers === 'object' && !Array.isArray(value.customers) ? value.customers : {};
  // Object không prototype: khoá "__proto__" đọc lên từ JSON chỉ là một khoá
  // thường, không với tới được Object.prototype của cả tiến trình.
  return { customers: Object.assign(Object.create(null), stored) };
}

/** ENOENT → rỗng; tệp hỏng → cất `.corrupt-*`; lỗi đọc khác → ném (không nhớ kho rỗng rồi ghi đè). */
async function readStore() {
  if (cachedStore) return cachedStore;
  // Nhớ cả lượt đọc ĐANG CHẠY: hai lượt đọc đầu tiên đồng thời dùng chung một bản kho (bản đọc xong sau từng đè
  // bản đã được sửa trong hàng ghi → mất thay đổi).
  storeLoading ||= readJsonFile(customerEditsPath, { fallback: emptyStore, normalize: normalizeStore, label: 'Kho sửa thông tin khách' })
    .then(store => { cachedStore = store; return store; })
    .finally(() => { storeLoading = null; });
  return storeLoading;
}

/** Ghi tuần tự: hai nhân viên bấm cùng lúc thì lần sau đọc được kết quả lần trước. */
function updateStore(mutate) {
  return enqueueWrite(async () => {
    const store = await readStore();
    const result = await mutate(store);
    await writeJsonAtomic(customerEditsPath, store);
    return result;
  });
}

// Khoá do người dùng chi phối mà gán thẳng vào object literal thì "__proto__"
// sửa được prototype của cả tiến trình. Kho dùng object không prototype, và
// vẫn chặn sẵn ba tên này để phòng khi kho được đọc lại từ JSON.
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

function entryFor(store, key) {
  const id = text(key, 200);
  if (!id) throw new Error('Thiếu mã khách hàng.');
  if (forbiddenKeys.has(id)) throw new Error('Mã khách hàng không hợp lệ.');
  if (!Object.prototype.hasOwnProperty.call(store.customers, id)) {
    store.customers[id] = { labels: [], hiddenLabels: [], notes: [] };
  }
  const entry = store.customers[id];
  for (const field of ['labels', 'hiddenLabels', 'notes']) {
    if (!Array.isArray(entry[field])) entry[field] = [];
  }
  return entry;
}

/**
 * Trạng thái liên hệ (cột "Liên hệ" màn Khách hàng): nhân viên gọi chăm sóc / mời mua lại rồi chọn ngay trên
 * dòng khách. Khách chưa ai chọn là "Chưa liên hệ" (không lưu gì).
 */
export const CONTACT_STATUSES = Object.freeze({
  none: 'Chưa liên hệ',
  called: 'Đã gọi điện',
  unreachable: 'Không gọi được',
  offer: 'Đã gửi ưu đãi'
});
const isContactStatus = value => Object.prototype.hasOwnProperty.call(CONTACT_STATUSES, value);

/**
 * Đặt trạng thái liên hệ của một khách. "Chưa liên hệ" là gỡ (về mặc định); ba trạng thái kia ghi kèm lúc chọn và
 * người chọn. Trả { previous, status, at } để route ghi nhật ký "trước → sau".
 */
export async function setCustomerContactStatus(key, status, now = Date.now(), { by = null } = {}) {
  const value = text(status, 20);
  if (!isContactStatus(value)) throw new Error('Trạng thái liên hệ không hợp lệ.');
  return updateStore(store => {
    const entry = entryFor(store, key);
    const previous = isContactStatus(entry.contact?.status) ? entry.contact.status : 'none';
    if (value === 'none') delete entry.contact;
    else entry.contact = { status: value, at: now, ...(by ? { by: { username: text(by.username, 32), name: text(by.name, 80) } } : {}) };
    return { previous, status: value, at: now };
  });
}

/**
 * Toàn bộ phần nhân viên đã nhập, để customers.mjs phủ lên bản suy ra.
 * Trả bản sao nông: người gọi lỡ sửa vào đó thì chỉ hỏng bản sao, không lặng
 * lẽ đổi kho mà bỏ qua hàng đợi ghi.
 */
export async function readCustomerEdits() {
  const store = await readStore();
  return { ...store.customers };
}

/**
 * Khoá kho ghi đè. KHÔNG dùng `customer.id` vì id là dữ liệu suy ra: khách
 * landing mang id `export:<sđt>`, nhưng khi họ nhắn tin cho Page thì
 * mergeExportedCustomers gộp họ vào bản ghi Facebook và id đổi thành
 * `<pageId>:<psid>` — mọi thứ nhân viên đã nhập sẽ mất hút dưới khoá cũ.
 * Số điện thoại đã chuẩn hoá đi theo con người nên bền hơn; khách chưa có số
 * thì đành quay về id.
 */
export function customerEditKey(customer) {
  const phone = customerPhoneKey(customer?.phone);
  return phone ? `phone:${phone}` : String(customer?.id || '');
}

/**
 * Phủ phần nhân viên nhập lên danh sách khách vừa dựng (đổi tại chỗ).
 *
 * Thẻ: cộng phần nhân viên thêm, trừ phần nhân viên gỡ. Phải có danh sách gỡ
 * riêng vì thẻ đến từ hội thoại bên Tin nhắn được dựng lại mỗi lần gọi — chỉ
 * xoá khỏi kho ghi đè thì lần sau nó mọc lại.
 */
export function applyCustomerEdits(customers, edits = {}) {
  if (!Array.isArray(customers)) return customers;
  const store = edits && typeof edits === 'object' ? edits : {};
  for (const customer of customers) {
    // Tính khoá TRƯỚC khi phủ: sau khi phủ, số điện thoại có thể là số nhân
    // viên vừa sửa, lấy nó làm khoá thì lần tra sau trượt.
    const key = customerEditKey(customer);
    customer.editKey = key;
    // Thẻ gốc (chưa phủ) để route gắn thẻ biết đâu là thêm, đâu là gỡ.
    customer.derivedLabels = [...(customer.labels || [])];
    // Bản ghi từ trước khi đổi sang khoá bền vẫn phải đọc được.
    const entry = store[key] || store[customer.id];
    // Ghi chú: gộp cả khoá chính lẫn khoá hội thoại (bot ghi cho khách chưa có SĐT theo
    // `pageId:psid`), cùng phép gộp với listCustomerNotes để số đếm khớp danh sách.
    const notes = mergeNotes([store[key], store[customer.id]]);
    if (!entry && !notes.length) continue;
    applyNoteCounts(customer, notes);
    if (!entry) continue;

    // Trạng thái liên hệ: lấy lần chọn mới nhất giữa khoá chính và khoá cũ (khách chưa có SĐT lúc nhân viên chọn).
    const contact = [store[key]?.contact, store[customer.id]?.contact]
      .filter(item => item && isContactStatus(item.status))
      .sort((first, second) => (Number(second.at) || 0) - (Number(first.at) || 0))[0];
    if (contact) {
      customer.contactStatus = contact.status;
      customer.contactStatusAt = Number(contact.at) || 0;
      customer.contactStatusBy = text(contact.by?.name || contact.by?.username, 80);
    }

    if (entry.name) customer.name = entry.name;
    if (entry.phone) customer.phone = entry.phone;
    if (entry.address) customer.address = entry.address;
    if (entry.gender) {
      customer.gender = entry.gender;
      customer.genderSource = 'staff';
    }

    const hidden = new Set(Array.isArray(entry.hiddenLabels) ? entry.hiddenLabels : []);
    customer.labels = (customer.labels || []).filter(label => !hidden.has(label));
    for (const label of Array.isArray(entry.labels) ? entry.labels : []) {
      if (!customer.labels.includes(label)) customer.labels.push(label);
    }

    customer.editedByStaffAt = Number(entry.updatedAt) || 0;
  }
  return customers;
}

/** Ghi chú của nhiều bản ghi (khoá chính, khoá hội thoại) gộp lại, khử trùng theo id + lúc + chữ. */
function mergeNotes(entries) {
  const seen = new Set();
  const notes = [];
  for (const entry of new Set(entries.filter(Boolean))) {
    for (const note of Array.isArray(entry.notes) ? entry.notes : []) {
      const fingerprint = `${note?.id}|${note?.at}|${note?.text}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      notes.push(note);
    }
  }
  return notes;
}

// noteCount là tổng cả ghi chú bên hội thoại; staffNoteCount chỉ đếm phần thêm từ hộp chi
// tiết (và ghi chú bot), tức đúng phần listCustomerNotes trả về.
function applyNoteCounts(customer, notes) {
  customer.staffNoteCount = notes.length;
  if (notes.length) {
    customer.noteCount = (Number(customer.noteCount) || 0) + notes.length;
    customer.lastStaffNoteAt = notes.reduce((latest, note) => Math.max(latest, Number(note?.at) || 0), 0);
    // Cột "Ghi chú" màn Khách hàng hiện ghi chú MỚI NHẤT: so với ghi chú hội thoại (customers.mjs đã đặt lastNote).
    const latest = notes.reduce((best, note) => ((Number(note?.at) || 0) >= (Number(best?.at) || 0) ? note : best), null);
    const at = Number(latest?.at) || 0;
    if (latest?.text && (!customer.lastNote || at >= (Number(customer.lastNote.at) || 0))) {
      customer.lastNote = { text: String(latest.text).slice(0, 200), at, by: text(latest.author?.name || latest.by, 80) };
    }
  }
}

/**
 * Sửa thông tin liên hệ. Chỉ đụng tới trường có trong patch.
 * Ô để trống nghĩa là GỠ phần đã sửa, trả ô đó về dữ liệu gốc — đó là đường
 * duy nhất để sửa lại một trường lỡ nhập sai.
 */
export async function updateCustomerProfile(key, patch = {}, now = Date.now(), { by = null } = {}) {
  const fields = {};

  if (patch.name !== undefined) fields.name = text(patch.name, 120);

  // +84/0084 → 0, thêm số 0 đầu bị mất; số không giống di động VN vẫn lưu, kèm cảnh báo.
  let phoneWarning = '';
  if (patch.phone !== undefined) {
    const normalized = normalizeEditedPhone(patch.phone);
    fields.phone = normalized.phone;
    phoneWarning = normalized.warning;
  }

  if (patch.address !== undefined) fields.address = text(patch.address, 500);

  if (patch.gender !== undefined) {
    const gender = text(patch.gender, 10);
    if (gender && gender !== 'male' && gender !== 'female') throw new Error('Giới tính không hợp lệ.');
    fields.gender = gender;
  }

  if (!Object.keys(fields).length) throw new Error('Không có gì để sửa.');

  return updateStore(store => {
    const entry = entryFor(store, key);
    for (const [field, value] of Object.entries(fields)) {
      if (value) entry[field] = value;
      else delete entry[field];
    }
    entry.updatedAt = now;
    // Người sửa gần nhất (nhật ký hoạt động giữ đủ từng lần).
    if (by) entry.updatedBy = { username: text(by.username, 32), name: text(by.name, 80) };
    return { ...entry, ...(phoneWarning ? { warnings: [phoneWarning] } : {}) };
  });
}

/**
 * Gắn thẻ. `labels` là bộ thẻ nhân viên muốn thấy trên dòng khách này.
 * `derivedLabels` là bộ thẻ tự có từ hội thoại — so hai bên để biết cái nào
 * là thêm vào, cái nào là gỡ đi; gỡ phải ghi lại rõ ràng, nếu không thẻ hội
 * thoại sẽ mọc lại ở lần dựng danh sách kế tiếp.
 */
export async function setCustomerLabels(key, labels = [], derivedLabels = [], now = Date.now(), { by = null, allowedIds = null } = {}) {
  if (!Array.isArray(labels)) throw new Error('Danh sách thẻ không hợp lệ.');
  // R13 (M4): chỉ nhận CHUỖI (object/số/null bị bỏ, không ép thành "[object Object]"), bỏ trùng, ≤ 20 thẻ.
  const clean = list => [...new Set((Array.isArray(list) ? list : []).filter(label => typeof label === 'string').map(label => text(label, 60)).filter(Boolean))];
  const derived = new Set(clean(derivedLabels));
  // `allowedIds` (mã thẻ trong Cài đặt → Tin nhắn; null = không kiểm): mã lạ chỉ giữ khi khách ĐANG mang nó
  // (thẻ tự có từ hội thoại, hay thẻ đã gắn tay từ trước) — không rơi thẻ hệ thống, không nhận mã bịa.
  const allowed = allowedIds ? new Set(allowedIds) : null;
  return updateStore(store => {
    const entry = entryFor(store, key);
    const held = new Set([...derived, ...(Array.isArray(entry.labels) ? entry.labels : [])]);
    const chosen = new Set(clean(labels).filter(label => !allowed || allowed.has(label) || held.has(label)).slice(0, 20));
    entry.labels = [...chosen].filter(label => !derived.has(label));
    entry.hiddenLabels = [...derived].filter(label => !chosen.has(label));
    entry.updatedAt = now;
    if (by) entry.updatedBy = { username: text(by.username, 32), name: text(by.name, 80) };
    return { labels: entry.labels, hiddenLabels: entry.hiddenLabels };
  });
}

/** Thêm một ghi chú. Ghi chú chỉ thêm, không sửa lại, để còn lần theo được. */
export async function addCustomerNote(key, note = {}, now = Date.now()) {
  const body = text(note.text, 1000);
  if (!body) throw new Error('Ghi chú không được để trống.');
  // `author` { username, name }: người viết thật (server lấy từ phiên đăng nhập) — thắng `by` gõ tay.
  const author = note.author && typeof note.author === 'object'
    ? { username: text(note.author.username, 32), name: text(note.author.name, 80) || text(note.author.username, 32) }
    : null;
  const by = (author?.name) || text(note.by, 80) || 'Nhân viên';
  return updateStore(store => {
    const entry = entryFor(store, key);
    const saved = { id: `note-${now.toString(36)}-${entry.notes.length}`, text: body, by, at: now, ...(author ? { author } : {}) };
    entry.notes.push(saved);
    entry.updatedAt = now;
    return saved;
  });
}

/**
 * Ghi chú của một khách, mới nhất lên đầu. `aliases`: các khoá cũ của cùng khách — chatbot ghi
 * chú cho khách CHƯA có SĐT theo khoá `pageId:psid` (customer.id); khi khách có SĐT thì khoá
 * chính thành `phone:<sđt>` và ghi chú cũ nằm ở khoá kia. Gộp, khử trùng (cùng id + lúc + chữ).
 */
export async function listCustomerNotes(key, { aliases = [] } = {}) {
  const store = await readStore();
  const keys = [...new Set([key, ...(Array.isArray(aliases) ? aliases : [])].map(value => text(value, 200)).filter(Boolean))];
  return mergeNotes(keys.map(id => store.customers[id])).sort((first, second) => (Number(second.at) || 0) - (Number(first.at) || 0));
}
