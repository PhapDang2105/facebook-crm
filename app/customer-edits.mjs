// Nhân viên sửa thông tin khách, gắn thẻ và ghi chú ngay trong hộp chi tiết ở
// màn Khách hàng. Bản ghi khách là dữ liệu SUY RA từ hội thoại và tệp khách
// hàng (customers.mjs dựng lại mỗi lần gọi), nên không có chỗ nào để ghi đè
// lên: sửa thẳng vào bản suy ra thì lần dựng sau mất sạch. Kho này giữ riêng
// phần nhân viên tự nhập rồi phủ lên bản suy ra, cùng lối với customer-file.mjs
// và order-edits.mjs: JSON, ghi tuần tự, đổi tên nguyên khối.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { customerPhoneKey } from './customer-file.mjs';

const customerEditsPath = process.env.CUSTOMER_EDITS_PATH
  || path.join(projectRoot, 'data', 'processed', 'customer-edits.json');

let cachedStore = null;
let writeQueue = Promise.resolve();

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function emptyStore() {
  return { customers: Object.create(null) };
}

function normalizeStore(value) {
  const stored = value && typeof value === 'object' && value.customers && typeof value.customers === 'object' ? value.customers : {};
  // Object không prototype: khoá "__proto__" đọc lên từ JSON chỉ là một khoá
  // thường, không với tới được Object.prototype của cả tiến trình.
  return { customers: Object.assign(Object.create(null), stored) };
}

async function readStore() {
  if (cachedStore) return cachedStore;
  try {
    cachedStore = normalizeStore(JSON.parse(await readFile(customerEditsPath, 'utf8')));
  } catch {
    cachedStore = emptyStore();
  }
  return cachedStore;
}

async function persistStore(store) {
  await mkdir(path.dirname(customerEditsPath), { recursive: true });
  const temporaryPath = `${customerEditsPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  await rename(temporaryPath, customerEditsPath);
}

/** Ghi tuần tự: hai nhân viên bấm cùng lúc thì lần sau đọc được kết quả lần trước. */
function updateStore(mutate) {
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    const result = await mutate(store);
    await persistStore(store);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
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
    if (!entry) continue;

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

    const notes = Array.isArray(entry.notes) ? entry.notes : [];
    // noteCount là tổng cả ghi chú bên hội thoại; staffNoteCount chỉ đếm phần
    // thêm từ hộp chi tiết, tức đúng phần listCustomerNotes trả về.
    customer.staffNoteCount = notes.length;
    if (notes.length) {
      customer.noteCount = (Number(customer.noteCount) || 0) + notes.length;
      customer.lastStaffNoteAt = notes.reduce((latest, note) => Math.max(latest, Number(note?.at) || 0), 0);
    }
    customer.editedByStaffAt = Number(entry.updatedAt) || 0;
  }
  return customers;
}

/**
 * Sửa thông tin liên hệ. Chỉ đụng tới trường có trong patch.
 * Ô để trống nghĩa là GỠ phần đã sửa, trả ô đó về dữ liệu gốc — đó là đường
 * duy nhất để sửa lại một trường lỡ nhập sai.
 */
export async function updateCustomerProfile(key, patch = {}, now = Date.now()) {
  const fields = {};

  if (patch.name !== undefined) fields.name = text(patch.name, 120);

  if (patch.phone !== undefined) {
    const phone = text(patch.phone, 20).replace(/[^\d+]/g, '');
    if (phone && phone.replace(/\D/g, '').length < 9) throw new Error('Số điện thoại không hợp lệ.');
    fields.phone = phone;
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
    return { ...entry };
  });
}

/**
 * Gắn thẻ. `labels` là bộ thẻ nhân viên muốn thấy trên dòng khách này.
 * `derivedLabels` là bộ thẻ tự có từ hội thoại — so hai bên để biết cái nào
 * là thêm vào, cái nào là gỡ đi; gỡ phải ghi lại rõ ràng, nếu không thẻ hội
 * thoại sẽ mọc lại ở lần dựng danh sách kế tiếp.
 */
export async function setCustomerLabels(key, labels = [], derivedLabels = [], now = Date.now()) {
  if (!Array.isArray(labels)) throw new Error('Danh sách thẻ không hợp lệ.');
  const clean = list => [...new Set((Array.isArray(list) ? list : []).map(label => text(label, 60)).filter(Boolean))];
  const chosen = new Set(clean(labels).slice(0, 20));
  const derived = new Set(clean(derivedLabels));
  return updateStore(store => {
    const entry = entryFor(store, key);
    entry.labels = [...chosen].filter(label => !derived.has(label));
    entry.hiddenLabels = [...derived].filter(label => !chosen.has(label));
    entry.updatedAt = now;
    return { labels: entry.labels, hiddenLabels: entry.hiddenLabels };
  });
}

/** Thêm một ghi chú. Ghi chú chỉ thêm, không sửa lại, để còn lần theo được. */
export async function addCustomerNote(key, note = {}, now = Date.now()) {
  const body = text(note.text, 1000);
  if (!body) throw new Error('Ghi chú không được để trống.');
  const by = text(note.by, 80) || 'Nhân viên';
  return updateStore(store => {
    const entry = entryFor(store, id);
    const saved = { id: `note-${now.toString(36)}-${entry.notes.length}`, text: body, by, at: now };
    entry.notes.push(saved);
    entry.updatedAt = now;
    return saved;
  });
}

/** Ghi chú của một khách, mới nhất lên đầu. */
export async function listCustomerNotes(key) {
  const store = await readStore();
  const entry = store.customers[text(key, 200)];
  const notes = entry && Array.isArray(entry.notes) ? entry.notes : [];
  return [...notes].sort((first, second) => (Number(second.at) || 0) - (Number(first.at) || 0));
}
