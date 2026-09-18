// Nhân viên sửa thông tin khách, gắn thẻ và ghi chú ngay trong hộp chi tiết ở
// màn Khách hàng. Bản ghi khách là dữ liệu SUY RA từ hội thoại và tệp khách
// hàng (customers.mjs dựng lại mỗi lần gọi), nên không có chỗ nào để ghi đè
// lên: sửa thẳng vào bản suy ra thì lần dựng sau mất sạch. Kho này giữ riêng
// phần nhân viên tự nhập rồi phủ lên bản suy ra, cùng lối với customer-file.mjs
// và order-edits.mjs: JSON, ghi tuần tự, đổi tên nguyên khối.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';

const customerEditsPath = process.env.CUSTOMER_EDITS_PATH
  || path.join(projectRoot, 'data', 'processed', 'customer-edits.json');

let cachedStore = null;
let writeQueue = Promise.resolve();

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function emptyStore() {
  return { customers: {} };
}

function normalizeStore(value) {
  const customers = value && typeof value === 'object' && value.customers && typeof value.customers === 'object' ? value.customers : {};
  return { customers };
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

function entryFor(store, id) {
  const key = text(id, 200);
  if (!key) throw new Error('Thiếu mã khách hàng.');
  if (!store.customers[key]) store.customers[key] = { labels: [], notes: [] };
  const entry = store.customers[key];
  if (!Array.isArray(entry.labels)) entry.labels = [];
  if (!Array.isArray(entry.notes)) entry.notes = [];
  return entry;
}

/** Toàn bộ phần nhân viên đã nhập, để customers.mjs phủ lên bản suy ra. */
export async function readCustomerEdits() {
  const store = await readStore();
  return store.customers;
}

/**
 * Phủ phần nhân viên nhập lên danh sách khách vừa dựng (đổi tại chỗ).
 * Thẻ thì gộp chứ không thay: thẻ gắn ở hội thoại bên Tin nhắn vẫn giữ nguyên.
 */
export function applyCustomerEdits(customers, edits = {}) {
  if (!Array.isArray(customers) || !edits || typeof edits !== 'object') return customers;
  for (const customer of customers) {
    const entry = edits[customer.id];
    if (!entry) continue;
    if (entry.name) customer.name = entry.name;
    if (entry.phone) customer.phone = entry.phone;
    if (entry.address) customer.address = entry.address;
    if (entry.gender) {
      customer.gender = entry.gender;
      customer.genderSource = 'staff';
    }
    for (const label of Array.isArray(entry.labels) ? entry.labels : []) {
      if (!customer.labels.includes(label)) customer.labels.push(label);
    }
    const notes = Array.isArray(entry.notes) ? entry.notes : [];
    if (notes.length) {
      customer.noteCount = (Number(customer.noteCount) || 0) + notes.length;
      customer.lastNoteAt = notes.reduce((latest, note) => Math.max(latest, Number(note?.at) || 0), 0);
    }
    customer.editedByStaffAt = Number(entry.updatedAt) || 0;
  }
  return customers;
}

/** Sửa thông tin liên hệ. Chỉ nhận trường có trong patch, ô để trống là xoá phần đã sửa. */
export async function updateCustomerProfile(id, patch = {}, now = Date.now()) {
  const fields = {};

  if (patch.name !== undefined) {
    const name = text(patch.name, 120);
    if (!name) throw new Error('Tên khách không được để trống.');
    fields.name = name;
  }

  if (patch.phone !== undefined) {
    const phone = text(patch.phone, 20).replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 9) throw new Error('Số điện thoại không hợp lệ.');
    fields.phone = phone;
  }

  if (patch.address !== undefined) {
    const address = text(patch.address, 500);
    if (!address) throw new Error('Địa chỉ không được để trống.');
    fields.address = address;
  }

  if (patch.gender !== undefined) {
    const gender = text(patch.gender, 10);
    if (gender && gender !== 'male' && gender !== 'female') throw new Error('Giới tính không hợp lệ.');
    fields.gender = gender;
  }

  if (!Object.keys(fields).length) throw new Error('Không có gì để sửa.');

  return updateStore(store => {
    const entry = entryFor(store, id);
    Object.assign(entry, fields);
    entry.updatedAt = now;
    return { ...entry };
  });
}

/** Gắn thẻ: danh sách mã thẻ nhân viên chọn trong hộp chi tiết. */
export async function setCustomerLabels(id, labels = [], now = Date.now()) {
  if (!Array.isArray(labels)) throw new Error('Danh sách thẻ không hợp lệ.');
  const cleaned = [...new Set(labels.map(label => text(label, 60)).filter(Boolean))].slice(0, 20);
  return updateStore(store => {
    const entry = entryFor(store, id);
    entry.labels = cleaned;
    entry.updatedAt = now;
    return { labels: entry.labels };
  });
}

/** Thêm một ghi chú. Ghi chú chỉ thêm, không sửa lại, để còn lần theo được. */
export async function addCustomerNote(id, note = {}, now = Date.now()) {
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
export async function listCustomerNotes(id) {
  const store = await readStore();
  const entry = store.customers[text(id, 200)];
  const notes = entry && Array.isArray(entry.notes) ? entry.notes : [];
  return [...notes].sort((first, second) => (Number(second.at) || 0) - (Number(first.at) || 0));
}
