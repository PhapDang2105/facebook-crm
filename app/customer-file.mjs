// Tệp khách hàng của mình: mỗi lần bấm Xuất dữ liệu (file kho), khách của các
// đơn được xuất vào đây theo số điện thoại. Màn Khách hàng đọc tệp này cùng
// với hội thoại Facebook, nên khách landing hay import chưa từng nhắn tin cũng
// có mặt để theo dõi và chăm sóc lại. Kho là JSON, ghi tuần tự (atomic rename)
// như các kho khác.
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { normalizeColumnName } from './order-export.mjs';
import { toLocalPhoneLoose } from './phone-warnings.mjs';
import { createWriteQueue, readJsonFile, writeJsonAtomic } from './json-store.mjs';

const customerFilePath = process.env.CUSTOMER_FILE_PATH
  || path.join(projectRoot, 'data', 'processed', 'customer-file.json');

let cachedStore = null;
const enqueueWrite = createWriteQueue();

function emptyStore() {
  return { customers: {} };
}

function normalizeStore(value) {
  const customers = value.customers && typeof value.customers === 'object' && !Array.isArray(value.customers) ? value.customers : {};
  return { customers };
}

/** ENOENT → rỗng; tệp hỏng → cất `.corrupt-*`; lỗi đọc khác → ném (không nhớ kho rỗng rồi ghi đè). */
async function readStore() {
  if (cachedStore) return cachedStore;
  cachedStore = await readJsonFile(customerFilePath, { fallback: emptyStore, normalize: normalizeStore, label: 'Tệp khách hàng' });
  return cachedStore;
}

function updateStore(mutate) {
  return enqueueWrite(async () => {
    const store = await readStore();
    try {
      const result = await mutate(store);
      await writeJsonAtomic(customerFilePath, store);
      return result;
    } catch (error) {
      // C6: sửa dở hay ghi đĩa lỗi → bỏ bản trong bộ nhớ, lần đọc sau nạp lại tệp tốt cuối cùng (không để lần
      // ghi sau lặng lẽ lưu thay đổi mà người gọi đã được báo là lỗi).
      cachedStore = null;
      throw error;
    }
  });
}

/**
 * Số điện thoại làm khoá: dạng 0xxxxxxxxx (kể cả "912345678" mất số 0 đầu, "0084…");
 * số lạ thì giữ chuỗi số để không mất khách.
 */
export function customerPhoneKey(value) {
  return toLocalPhoneLoose(value) || String(value ?? '').replace(/\D/g, '');
}

const text = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const integer = (value, fallback) => {
  const number = Number(String(value ?? '').replace(/[^\d]/g, ''));
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const vietnamOffsetMs = 7 * 60 * 60 * 1000;

/**
 * Cột Ngày của bảng ("16/09 07:52", không có năm) → mốc thời gian; không đọc được thì lấy lúc xuất.
 * Giờ trong cột là giờ Việt Nam (+7): dựng theo UTC rồi trừ 7 giờ, không theo múi giờ máy chủ
 * (VM chạy UTC → trước đây lệch +7 giờ). Năm mặc định cũng lấy theo ngày VN của lúc xuất.
 */
export function orderedAtFromLabel(label, exportedAt) {
  const match = String(label || '').match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!match) return exportedAt;
  const exportYear = new Date(Number(exportedAt) + vietnamOffsetMs).getUTCFullYear();
  const build = year => Date.UTC(year, Number(match[2]) - 1, Number(match[1]), Number(match[4]) || 0, Number(match[5]) || 0) - vietnamOffsetMs;
  let at = build(match[3] ? Number(match[3]) : exportYear);
  // Không có năm mà rơi vào "sau hôm nay" thì là năm trước (qua Tết dương). Cho dư một
  // ngày (đơn đặt sát lúc xuất, đồng hồ lệch).
  if (!match[3] && at > exportedAt + 24 * 60 * 60 * 1000) at = build(exportYear - 1);
  return Number.isNaN(at) ? exportedAt : at;
}

/**
 * Bảng đơn (headers + rows) đem xuất → danh sách khách, mỗi khách kèm các đơn
 * (một đơn có thể nhiều dòng sản phẩm). Không có số điện thoại thì bỏ qua: không
 * có gì để chăm sóc lại.
 */
export function customersFromExport(orderData, exportedAt = Date.now()) {
  const headers = Array.isArray(orderData?.headers) ? orderData.headers : [];
  const rows = Array.isArray(orderData?.rows) ? orderData.rows : [];
  const column = new Map(headers.map((header, index) => [normalizeColumnName(header), index]));
  const cell = (row, name) => { const index = column.get(name); return index === undefined ? '' : String(row[index] ?? '').trim(); };
  const phoneIndex = ['so dien thoai', 'sdt', 'dien thoai'].map(name => column.get(name)).find(index => index !== undefined);
  if (phoneIndex === undefined) return [];
  const customers = new Map();
  rows.forEach((row, rowIndex) => {
    const phone = customerPhoneKey(row[phoneIndex]);
    if (phone.length < 9) return;
    const orderId = cell(row, 'ma don hang') || `row:${rowIndex}`;
    const customer = customers.get(phone) || {
      phone,
      name: '',
      address: '',
      province: '',
      district: '',
      ward: '',
      source: '',
      orders: new Map()
    };
    // Tên, địa chỉ: lấy giá trị có nội dung gần nhất trong bảng.
    const name = text(cell(row, 'khach hang'));
    if (name) customer.name = name;
    const address = text(cell(row, 'dia chi'), 500);
    if (address && !/^chưa có địa chỉ$/i.test(address)) customer.address = address;
    for (const [field, columnName] of [['province', 'tinh thanh pho'], ['district', 'quan huyen'], ['ward', 'phuong xa']]) {
      const value = text(cell(row, columnName));
      if (value) customer[field] = value;
    }
    const source = text(cell(row, 'nguon don'), 60);
    if (source) customer.source = source;
    const order = customer.orders.get(orderId) || {
      id: orderId,
      source,
      orderedAt: orderedAtFromLabel(cell(row, 'ngay'), exportedAt),
      exportedAt,
      products: [],
      total: 0
    };
    const productName = text(cell(row, 'san pham'));
    const sku = text(cell(row, 'ma mau ma'), 60);
    if (productName || sku) {
      const quantity = integer(cell(row, 'so luong'), 1);
      const price = integer(cell(row, 'don gia'), 0);
      order.products.push({ sku, name: productName || sku, quantity, price });
      order.total += quantity * price;
    }
    customer.orders.set(orderId, order);
    customers.set(phone, customer);
  });
  return [...customers.values()].map(customer => ({ ...customer, orders: [...customer.orders.values()] }));
}

/**
 * Ghi khách của một lần xuất vào tệp. Xuất lại cùng đơn không tạo bản thứ hai:
 * đơn ghi đè theo mã, chỉ mốc "xuất lần đầu" được giữ.
 */
export async function recordExportedOrders(orderData, now = Date.now()) {
  const people = customersFromExport(orderData, now);
  if (!people.length) return { customers: 0, orders: 0 };
  return updateStore(store => {
    let orders = 0;
    for (const person of people) {
      const existing = store.customers[person.phone] || {
        phone: person.phone,
        name: '',
        address: '',
        province: '',
        district: '',
        ward: '',
        source: '',
        firstExportedAt: now,
        lastExportedAt: now,
        orders: {}
      };
      for (const field of ['name', 'address', 'province', 'district', 'ward', 'source']) {
        if (person[field]) existing[field] = person[field];
      }
      existing.lastExportedAt = now;
      for (const order of person.orders) {
        const previous = existing.orders[order.id];
        existing.orders[order.id] = { ...order, exportedAt: previous?.exportedAt || now };
        orders += 1;
      }
      store.customers[person.phone] = existing;
    }
    return { customers: people.length, orders };
  });
}

const withSortedOrders = customer => ({
  ...customer,
  orders: Object.values(customer.orders || {}).sort((first, second) => (second.orderedAt || 0) - (first.orderedAt || 0))
});

/**
 * Một khách theo SĐT (P13): kho đã khoá theo customerPhoneKey nên tra thẳng; khoá cũ lệch dạng thì dò tuần tự —
 * không chép và sắp đơn của MỌI khách như listExportedCustomers (hộp chi tiết khách gọi mỗi lần mở).
 */
export async function findExportedCustomer(phone) {
  const key = customerPhoneKey(phone);
  if (!key) return null;
  const store = await readStore();
  const customer = Object.hasOwn(store.customers, key) ? store.customers[key] : Object.values(store.customers).find(item => customerPhoneKey(item?.phone) === key);
  return customer ? withSortedOrders(customer) : null;
}

/** Danh sách khách trong tệp, đơn xếp mới nhất trước. */
export async function listExportedCustomers() {
  const store = await readStore();
  return Object.values(store.customers).map(withSortedOrders);
}
