// Đơn đổ về từ form landing page (Webcake và các nền tảng tương tự) qua webhook.
//
// Mỗi nền tảng đặt tên trường một kiểu ("name"/"họ tên"/"full_name",
// "phone"/"sđt"/"số điện thoại"...), và có thể bọc trong data/fields/form_data.
// Module này làm phẳng payload, nhận dạng trường theo nghĩa, khớp sản phẩm với
// danh mục rồi đưa qua normalizeCustomerOrder — cùng một đường với đơn chatbot,
// nên ba cấp địa chỉ, giá và SKU kho đều được xử lý y hệt. Payload gốc của
// những lần gọi gần nhất được giữ lại để đối chiếu khi một trường chưa được
// nhận ra.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { projectRoot } from './config.mjs';
import { normalizeCustomerOrder } from './conversation-orders.mjs';
import { findProductBySku, matchProduct, normalizeText } from './processing/catalog.mjs';
import { priceBasket, unitPriceInBasket } from './processing/pricing.mjs';
import { extractVietnamesePhone } from './processing/customer-info.mjs';
import { attachPhoneWarning, fetchPosCustomerAddresses, toLocalPhoneLoose } from './phone-warnings.mjs';
import { STAFF_EDIT_GROUPS, addProcessingFlag, moneyText, removeProcessingFlag, spreadPaidPrices, staffEditedGroups } from './order-edits.mjs';
import { isUsableStreet, lostHouseNumbers, normalizeLocationKey, resolveAddress } from './processing/locations.mjs';
import { inferAddress } from './processing/address-ai.mjs';
import { appendOrderToArchive, archiveMonth } from './order-archive.mjs';
import { createWriteQueue, readJsonFile, writeJsonAtomic } from './json-store.mjs';

const landingOrdersPath = process.env.LANDING_ORDERS_PATH
  || path.join(projectRoot, 'data', 'processed', 'landing-orders.json');

// Đơn đẩy ra khỏi kho chính (quá trần) được cất NGUYÊN BẢN theo tháng đặt đơn (giờ VN)
// vào thư mục này; listLandingOrders đọc cả hai nên báo cáo/Tổng quan/Chiến dịch không
// mất doanh thu cũ. Mặc định nằm cạnh landing-orders.json (test trỏ LANDING_ORDERS_PATH
// vào thư mục tạm là thư mục lưu trữ cũng theo).
const landingArchiveDirectory = process.env.LANDING_ARCHIVE_PATH
  || path.join(path.dirname(landingOrdersPath), 'landing-orders-archive');

export const LANDING_SOURCE = 'Landing page';
// Trần của kho chính (tệp ghi lại toàn bộ sau mỗi webhook). ~70 đơn/ngày → chạm trần
// khoảng đầu tháng 12/2026; đơn cũ hơn được chuyển sang kho lưu trữ theo tháng, không bỏ.
export const LANDING_ACTIVE_LIMIT = 5000;
let maximumOrders = LANDING_ACTIVE_LIMIT;
/** Chỉ cho test: hạ trần để thử đường chuyển đơn sang kho lưu trữ. */
export function setLandingActiveLimitForTest(limit) {
  maximumOrders = Math.max(1, Number(limit) || LANDING_ACTIVE_LIMIT);
}
// Payload gốc được giữ cho mọi đơn gần đây, để tính lại đơn khi bộ nhận dạng thay đổi.
const maximumRecent = 1000;
const duplicateWindowMs = 10 * 60 * 1000;

let cachedStore = null;
const enqueueWrite = createWriteQueue();

function emptyStore() {
  return { orders: [], recent: [] };
}

function normalizeStore(value) {
  const orders = Array.isArray(value.orders) ? value.orders : [];
  for (const order of orders) {
    if (order && isFieldLabelAddress(order.address)) {
      order.address = 'Chưa có địa chỉ';
      order.street = '';
    }
  }
  return {
    orders,
    recent: Array.isArray(value.recent) ? value.recent : []
  };
}

/**
 * Chưa có tệp → kho rỗng; tệp hỏng → cất sang `.corrupt-*` rồi kho rỗng; lỗi đọc khác
 * (EBUSY, EACCES…) → ném lỗi và KHÔNG nhớ kho rỗng (lần ghi sau không đè mất đơn thật).
 */
export async function readLandingStore() {
  if (cachedStore) return cachedStore;
  cachedStore = await readJsonFile(landingOrdersPath, { fallback: emptyStore, normalize: normalizeStore, label: 'Kho đơn landing' });
  return cachedStore;
}

async function persistStore(store) {
  await writeJsonAtomic(landingOrdersPath, store);
}

/** Ghi tuần tự để hai webhook đến cùng lúc không ghi đè nhau. */
export function updateLandingStore(mutate) {
  return enqueueWrite(async () => {
    const store = await readLandingStore();
    const result = await mutate(store);
    // R13-fix (T3): cờ "⚠ Có thể trùng đơn LP-…" tự gỡ khi đơn gốc đã hủy/xoá/xác nhận hay đơn mang cờ đã chốt —
    // mọi đường ghi kho (PATCH, DELETE, hủy theo POS) đều qua đây.
    sweepDuplicateFlags(store.orders);
    await moveOverflowToArchive(store);
    await persistStore(store);
    return result;
  });
}

// ===== Kho lưu trữ đơn landing (đơn quá trần của kho chính) =====
//
// Vì sao không chỉ dựa vào order-archive.mjs: bản ghi ở đó rút gọn (không có trạng thái
// POS, ẩn/hủy, nguồn chiến dịch…), báo cáo không dựng lại được doanh thu từ nó. Ở đây giữ
// nguyên đơn đầy đủ. Tệp tháng chỉ được ghi khi có đơn bị đẩy ra (hiếm), và luôn ghi
// TRƯỚC khi kho chính bỏ đơn: sự cố giữa chừng chỉ làm đơn có ở cả hai nơi (đọc thì
// bản ở kho chính thắng), không bao giờ mất.
let archivedCache = null; // Map id → đơn

async function readArchiveMonth(month) {
  const file = path.join(landingArchiveDirectory, `${month}.json`);
  return readJsonFile(file, {
    fallback: () => ({ orders: [] }),
    normalize: value => ({ orders: Array.isArray(value.orders) ? value.orders : [] }),
    label: `Kho lưu trữ đơn landing ${month}`
  });
}

async function moveOverflowToArchive(store) {
  if (store.orders.length <= maximumOrders) return;
  const overflow = store.orders.slice(maximumOrders);
  const byMonth = new Map();
  for (const order of overflow) {
    const month = archiveMonth(Number(order?.createdAt) || Date.now());
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(order);
  }
  try {
    for (const [month, orders] of byMonth) {
      const current = await readArchiveMonth(month);
      const ids = new Set(orders.map(order => String(order?.id)));
      const merged = [...orders, ...current.orders.filter(order => !ids.has(String(order?.id)))]
        .sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
      await writeJsonAtomic(path.join(landingArchiveDirectory, `${month}.json`), { orders: merged });
      if (archivedCache) for (const order of orders) archivedCache.set(String(order?.id), order);
    }
  } catch (error) {
    // Không cất được thì GIỮ đơn trong kho chính (vượt trần tạm thời), thử lại lần ghi sau.
    console.error(`Không chuyển được đơn landing cũ sang kho lưu trữ (${error?.message || error}); giữ lại trong kho chính.`);
    return;
  }
  store.orders = store.orders.slice(0, maximumOrders);
}

/**
 * Mọi đơn landing đã chuyển sang kho lưu trữ (đọc một lần rồi nhớ; ghi mới cập nhật bộ nhớ).
 * Lần nạp đầu đi qua hàng ghi (enqueueWrite): nếu đọc tệp tháng song song với moveOverflowToArchive thì có thể
 * đọc TRƯỚC lần ghi, trong khi lần chuyển bỏ qua bước cập nhật bộ nhớ (cache còn null) — đơn vừa chuyển vắng khỏi
 * báo cáo tới lúc khởi động lại. Không gọi hàm này từ bên trong một việc của hàng ghi (sẽ tự chờ chính mình).
 */
function readArchivedLandingOrders() {
  if (archivedCache) return archivedCache;
  return enqueueWrite(async () => {
    if (archivedCache) return archivedCache;
    let files = [];
    try {
      files = (await readdir(landingArchiveDirectory)).filter(name => /^\d{4}-\d{2}\.json$/.test(name)).sort();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const map = new Map();
    for (const file of files) {
      const { orders } = await readArchiveMonth(file.slice(0, 7));
      for (const order of orders) if (order?.id !== undefined) map.set(String(order.id), order);
    }
    archivedCache = map;
    return archivedCache;
  });
}

// ===== Xác thực =====

/** Token so sánh theo thời gian hằng; token trống nghĩa là webhook chưa được bật. */
export function isLandingTokenValid(provided, expected) {
  const given = Buffer.from(String(provided || ''));
  const wanted = Buffer.from(String(expected || ''));
  if (!wanted.length || given.length !== wanted.length) return false;
  return timingSafeEqual(given, wanted);
}

export function landingTokenFrom(request, url) {
  const header = String(request.headers['x-landing-token'] || request.headers['x-webhook-token'] || '').trim();
  if (header) return header;
  const authorization = String(request.headers.authorization || '').trim();
  if (/^bearer\s+/i.test(authorization)) return authorization.replace(/^bearer\s+/i, '').trim();
  return String(url.searchParams.get('token') || '').trim();
}

// ===== Đọc payload =====

/** JSON hoặc form-urlencoded; "a[b]" của form thành khóa lồng như JSON. */
export function parseLandingBody(rawBody, contentType = '') {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  if (!text.trim()) return {};
  const type = String(contentType || '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) {
    const result = {};
    for (const [key, value] of new URLSearchParams(text)) result[key.replace(/\]/g, '').replace(/\[/g, '.')] = value;
    return result;
  }
  try {
    return JSON.parse(text);
  } catch {
    // Không phải JSON: thử như form, còn không thì trả về chuỗi để ghi lại.
    if (text.includes('=')) {
      const result = {};
      for (const [key, value] of new URLSearchParams(text)) result[key] = value;
      return result;
    }
    return { text };
  }
}

// "Phường/Xã", "full_name", "so-dien-thoai" đều về "phuong xa", "full name", "so dien thoai".
const keyOf = value => normalizeText(String(value ?? '')).replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Làm phẳng thành danh sách { path, key, value }. Mảng các cặp
 * {name|label|key|field, value} (kiểu form_data) được đọc như trường có tên.
 */
export function flattenPayload(value, prefix = '', out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const label = item && typeof item === 'object' && !Array.isArray(item)
        ? (item.name ?? item.label ?? item.key ?? item.field ?? item.title)
        : undefined;
      if (label !== undefined && Object.hasOwn(item, 'value')) {
        flattenPayload(item.value, prefix ? `${prefix}.${label}` : String(label), out);
      } else {
        flattenPayload(item, prefix ? `${prefix}.${index}` : String(index), out);
      }
    });
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) flattenPayload(child, prefix ? `${prefix}.${key}` : key, out);
    return out;
  }
  const key = keyOf(prefix.split('.').at(-1));
  const text = String(value).trim();
  // Webcake gửi chính tên trường làm giá trị khi ô đó trống ("utm_source":
  // "utm_source", "email": "email", "payment_status": "payment_status."),
  // có khi bằng một tên khác cùng nghĩa ("ward": "commune", "province":
  // "city"): đó là ô trống, không phải dữ liệu.
  const valueKey = keyOf(text.replace(/[.:]+$/, ''));
  if (valueKey === key || isEmptyFieldLabel(key, valueKey)) return out;
  out.push({ path: prefix, key, fullKey: keyOf(prefix), value: text });
  return out;
}

// Tên trường mặc định của form Webcake (full_name, phone_number, address,
// country, district, ward, products, quantity, coupon, textarea_input_1,
// utm_*, singlechoice, multiplechoice, link, date) và các tên phổ biến khác.
const FIELD_PATTERNS = {
  name: [/^(ho ?ten|ho va ten|full ?name|fullname|name|ten khach( hang)?|customer ?name|ten|nguoi nhan|ten nguoi nhan)$/],
  phone: [/^(phone( ?number)?|so ?dien ?thoai|sdt|dien thoai|mobile|tel|telephone|so dt|dt)$/],
  address: [/^(dia ?chi|address|full ?address|dia chi nhan hang|dia chi giao hang|street|short ?address)$/],
  // "location" của Webcake là địa chỉ đầy đủ đã ghép sẵn; chỉ dùng khi không có ô địa chỉ riêng.
  location: [/^(location|full ?location|dia chi day du)$/],
  province: [/^(tinh( thanh)?( pho)?|province|city|state|thanh pho|tinh thanh pho)$/],
  // Ô "country" của Webcake thường là tỉnh/thành; chỉ bỏ qua khi giá trị là quốc gia.
  country: [/^(country|quoc gia)$/],
  district: [/^(quan( huyen)?|huyen|district)$/],
  ward: [/^(phuong( xa)?|xa|ward|commune)$/],
  product: [/^(san ?pham|product( ?name)?|products?|item|ten san pham|mat hang|combo|goi|goi san pham|variant|variation|sku)$/],
  choice: [/^(single ?choice( \d+)?|multiple ?choice( \d+)?|lua chon|chon( san pham)?|select( \d+)?|option( \d+)?|radio( \d+)?|checkbox( \d+)?)$/],
  quantity: [/^(so ?luong|quantity|qty|sl)$/],
  price: [/^(gia|price|unit ?price|don gia)$/],
  total: [/^(tong( tien)?|total( ?price| ?amount)?|amount|thanh tien|tong cong)$/],
  // R13-fix (L5): tiền khách đã chuyển khoản (đơn kéo từ POS: pos-sync.posOrderToPayload mang transfer_money → prepaid).
  prepaid: [/^(prepaid|tien coc|dat coc|da chuyen khoan|tra truoc)$/],
  note: [/^(ghi ?chu|note|notes|message|loi nhan|yeu cau|comment|content|noi dung|textarea( input)?( \d+)?|text ?input( \d+)?)$/],
  coupon: [/^(coupon|ma giam gia|voucher|ma khuyen mai)$/],
  id: [/^(order ?id|ma don( hang)?|id|submission ?id|entry ?id|uuid|order ?code|ma don hang)$/],
  campaign: [/^(utm ?campaign|campaign|chien dich|utm ?source|utm ?medium|utm ?content|utm ?term|landing( ?page)?( ?name)?|page ?name|page ?title|source|nguon|form ?name|form ?title|page ?url|url|link|event)$/],
  insertedAt: [/^(inserted ?at|created ?at|submitted ?at|date ?time|timestamp)$/],
  // Trạng thái form của Webcake: "Form chưa hoàn tất" / "Form hoàn tất" / "New form"…
  formStatus: [/^(status|form ?status|trang thai|order ?status)$/],
  ignored: [/^(date|time|upload|file|email|ip|user ?agent|referrer?|country ?code|captcha|updated ?at|payment ?status|transfer ?money|shipping ?fee|discount|currency|variation ?id|product ?id|id)$/]
};
/** Giá trị là một tên trường cùng loại với ô ("ward" ↔ "commune"): ô trống. */
function isEmptyFieldLabel(key, valueKey) {
  return ['address', 'province', 'district', 'ward', 'name', 'phone'].some(kind => {
    const patterns = FIELD_PATTERNS[kind];
    return patterns.some(pattern => pattern.test(key)) && patterns.some(pattern => pattern.test(valueKey));
  });
}

/** Địa chỉ chỉ là nhãn ô form ('commune', 'district', 'address'…), lọt vào từ bản trước: coi như chưa có. */
export function isFieldLabelAddress(value) {
  const key = keyOf(String(value || '').replace(/[.:]+$/, ''));
  return Boolean(key) && ['address', 'province', 'district', 'ward'].some(kind => FIELD_PATTERNS[kind].some(pattern => pattern.test(key)));
}

const INCOMPLETE_STATUS = /(chua hoan tat|chua hoan thanh|incomplete|unfinished|partial|draft|in ?progress|not ?complete|dang dien)/;
export const INCOMPLETE_LABEL = 'Chưa hoàn tất';
const COUNTRY_VALUES = /^(viet ?nam|vn|vietnam)$/;

function pick(fields, kind) {
  const patterns = FIELD_PATTERNS[kind];
  const hit = fields.find(field => field.value && patterns.some(pattern => pattern.test(field.key)));
  return hit ? hit.value : '';
}

function pickAll(fields, kind) {
  const patterns = FIELD_PATTERNS[kind];
  return fields.filter(field => field.value && patterns.some(pattern => pattern.test(field.key)));
}

function money(value) {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

function quantityOf(value) {
  const number = Number(String(value ?? '').replace(/[^\d]/g, ''));
  return number > 0 ? Math.round(number) : 1;
}

/**
 * Dòng sản phẩm: danh sách "products.0.name"/"products.0.quantity" nếu có,
 * còn không thì một dòng từ trường sản phẩm + số lượng ở cấp gốc.
 */
/** "Túi Xanh x2", "Túi Xanh (x 2)", "2 x Túi Xanh" → tên và số lượng. */
function splitProductText(value) {
  const text = String(value ?? '').trim();
  const trailing = text.match(/^(.*?)\s*[\(\[]?\s*[x×*]\s*(\d{1,3})\s*[\)\]]?$/iu);
  if (trailing) return { product: trailing[1].trim(), quantity: trailing[2] };
  const leading = text.match(/^(\d{1,3})\s*[x×*]\s*(.+)$/iu);
  if (leading) return { product: leading[2].trim(), quantity: leading[1] };
  return { product: text, quantity: '' };
}

/**
 * Chuỗi sản phẩm của Webcake, mỗi dòng dạng
 *   "<Tên sản phẩm> (<Biến thể>): <số lượng> x <giá> ₫"
 * ví dụ "Granola Mới … Từ Giọt Nắng (Combo 3 Granola Xanh): 1 x 447.000 ₫".
 * Biến thể quyết định sản phẩm kho và số túi: "Combo 3 Granola Xanh" = 3 túi
 * Xanh, "1 Túi Granola Xanh 450g" = 1 túi Xanh, "Combo 2 Xanh + 1 Vàng" =
 * 2 Xanh và 1 Vàng. Không khớp danh mục thì giữ nguyên tên để nhân viên xem.
 */
export function parseWebcakeProducts(text) {
  const entries = String(text ?? '').split(/\r?\n|\s*;\s*|\s*\|\s*/).map(part => part.trim()).filter(Boolean);
  const lines = [];
  for (const entry of entries) {
    const match = entry.match(/^(.*?)(?:\s*\(([^()]*)\))?\s*:\s*(\d{1,3})\s*[x×*]\s*([\d.,]+)\s*(?:₫|đ|d|vnd|vnđ)?\s*$/iu);
    if (!match) return null;
    const [, productName, variation = '', lineQuantity, linePrice] = match;
    const quantity = Number(lineQuantity) || 1;
    // "\b" của JavaScript không hiểu chữ có dấu nên "Vàng" sẽ bị cắt tại "Và"; dùng ranh giới Unicode.
    const parts = variation ? variation.split(/\s*(?:\+|&|(?<![\p{L}\p{N}])và(?![\p{L}\p{N}]))\s*/iu).map(part => part.trim()).filter(Boolean) : [];
    const expanded = parts.map(part => {
      const counted = part.match(/^(?:combo\s*)?(\d{1,3})\s*(?:túi|tui|hộp|hop|hũ|hu|gói|goi|bịch|bich|chai|lọ|lo|set|bộ|bo)?\s*(.*)$/iu);
      const count = counted ? Number(counted[1]) : 1;
      const label = (counted ? counted[2] : part).replace(/^combo\s*/iu, '').trim() || part;
      // "Xanh" trong "Combo 2 Xanh + 1 Vàng" là túi Xanh: thử thêm tiền tố loại hình / tên dòng sản phẩm.
      const product = matchProduct(label) || matchProduct(part) || matchProduct(`túi ${label}`) || matchProduct(`granola ${label}`) || matchProduct(`${productName} ${label}`);
      return { product: product?.name || `${productName} (${part})`, sku: product?.sku || '', quantity: quantity * count, price: '' };
    });
    if (!expanded.length) {
      const product = matchProduct(productName);
      expanded.push({ product: product?.name || productName, sku: product?.sku || '', quantity, price: '' });
    }
    const unmatched = expanded.filter(item => !item.sku);
    for (const item of unmatched) item.price = String(Math.round(money(linePrice) / Math.max(1, item.quantity)));
    lines.push(...expanded);
  }
  return lines.length ? lines : null;
}

export function extractLineItems(fields) {
  // Dòng sản phẩm lồng nhau: products[0].name, products.name, items[1].quantity, cart.0.sku...
  const groups = new Map();
  for (const field of fields) {
    const segments = field.path.split('.');
    if (segments.length < 2) continue;
    const parent = segments.slice(0, -1);
    const container = /^\d+$/.test(parent.at(-1)) ? parent.slice(0, -1) : parent;
    if (!/^(products?|items?|line ?items?|cart|san pham|order ?items?)$/.test(keyOf(container.at(-1) || ''))) continue;
    const groupKey = parent.join('.');
    const group = groups.get(groupKey) || {};
    // Trong một dòng sản phẩm, "name"/"title" là tên sản phẩm chứ không phải tên khách.
    // Webcake "variations": name / variation_name / product_display_name, quantity, price, sku, variation_id.
    const kind = /^(name|title|ten|label|product ?name|display ?name|variation ?name|product ?display ?name|full ?name|variant ?name)$/.test(field.key) ? 'product'
      : Object.keys(FIELD_PATTERNS).find(name => ['product', 'quantity', 'price', 'total'].includes(name) && FIELD_PATTERNS[name].some(pattern => pattern.test(field.key)));
    if (kind === 'product' && /^sku$/.test(field.key)) group.sku = field.value;
    else if (kind === 'product' && group.product && /^(name|title|label)$/.test(field.key) === false) continue; // giữ tên đầu tiên
    else if (kind) group[kind] = field.value;
    if (Object.keys(group).length) groups.set(groupKey, group);
  }
  const items = [...groups.values()].filter(group => group.product || group.sku).map(group => ({ ...group, product: group.product || group.sku }));
  if (items.length) return items;
  const products = pickAll(fields, 'product');
  if (!products.length) return [];
  const quantity = pick(fields, 'quantity');
  const price = pick(fields, 'price');
  // Nhiều trường sản phẩm cùng lúc (ví dụ "sku" và "product") thì là một dòng.
  const named = products.find(field => !/^sku$/.test(field.key)) || products[0];
  const sku = products.find(field => /^sku$/.test(field.key))?.value || '';
  const webcake = parseWebcakeProducts(named.value);
  if (webcake) return webcake;
  const split = splitProductText(named.value);
  return [{ product: split.product, sku, quantity: quantity || split.quantity, price }];
}

/** utm_* trong URL trang ("location" của Webcake) khi các ô utm riêng để trống. */
function utmFromUrl(url) {
  try {
    const params = new URL(url).searchParams;
    return Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'].map(key => [key, params.get(key) || '']).filter(([, value]) => value));
  } catch {
    return {};
  }
}

/**
 * Đọc một payload bất kỳ thành các trường đơn hàng. `unknown` liệt kê những
 * trường có giá trị mà chưa xếp được vào đâu, để tinh chỉnh khi cần.
 */
export function normalizeLandingPayload(payload = {}) {
  const fields = flattenPayload(payload);
  const name = pick(fields, 'name');
  const phoneRaw = pick(fields, 'phone');
  // toLocalPhoneLoose: nhận thêm "912345678" (ô số làm mất số 0 đầu) và "0084…" — trước đây đơn bị bỏ.
  const phone = toLocalPhoneLoose(phoneRaw) || extractVietnamesePhone(phoneRaw) || extractVietnamesePhone(fields.map(field => field.value).join(' '));
  // "country" của Webcake là tỉnh/thành khi giá trị không phải tên quốc gia.
  const country = pick(fields, 'country');
  const province = pick(fields, 'province') || (country && !COUNTRY_VALUES.test(keyOf(country)) ? country : '');
  // "location" của Webcake là URL trang (kèm utm); nơi khác có thể là địa chỉ ghép sẵn.
  const location = pick(fields, 'location');
  const locationIsUrl = /^https?:\/\//i.test(location);
  const parts = [pick(fields, 'address') || (locationIsUrl ? '' : location), pick(fields, 'ward'), pick(fields, 'district'), province].filter(Boolean);
  const address = parts.join(', ');
  let lines = extractLineItems(fields);
  // Không có ô sản phẩm nhưng có ô lựa chọn (singlechoice "Combo 2 túi"...):
  // lựa chọn nào khớp danh mục thì là sản phẩm, còn lại bỏ qua (không phải lời khách).
  const choices = pickAll(fields, 'choice');
  for (const choice of choices) {
    const split = splitProductText(choice.value);
    if (!lines.length && matchProduct(split.product)) lines = [{ product: split.product, sku: '', quantity: split.quantity || pick(fields, 'quantity'), price: '' }];
  }
  const total = money(pick(fields, 'total'));
  const prepaid = money(pick(fields, 'prepaid'));
  const coupon = pick(fields, 'coupon');
  // Ghi chú chỉ là lời khách và mã giảm giá; ô lựa chọn của form (select_1:
  // "1 Túi Dùng Thử"...) là dữ liệu sản phẩm, không phải lời nhắn.
  const note = [...pickAll(fields, 'note').map(field => field.value), coupon ? `Mã giảm giá: ${coupon}` : ''].filter(Boolean).join(' · ');
  // Không có mã đơn thì SĐT + thời điểm gửi form là khóa chống trùng khi Webcake gọi lại.
  // Mã đơn và thời điểm gửi chỉ lấy ở cấp gốc: "id"/"created_at" nằm trong một
  // dòng sản phẩm (variations[0].id) là mã mẫu mã, giống nhau ở mọi đơn cùng
  // sản phẩm — lấy làm mã form thì đơn của khách sau bị gộp vào đơn khách trước.
  const insideLineItem = field => /(^|\.)(products?|items?|line ?items?|cart|san pham|order ?items?|variations?)(\.\d+)?\.[^.]+$/.test(field.path.split('.').map(keyOf).join('.'));
  const topLevel = fields.filter(field => !insideLineItem(field));
  const insertedAt = pick(topLevel, 'insertedAt');
  const externalId = pick(topLevel, 'id') || (insertedAt && phone ? `${phone}@${insertedAt}` : '');
  const utm = { ...(locationIsUrl ? utmFromUrl(location) : {}) };
  for (const field of pickAll(fields, 'campaign')) if (!/^(url|link|page ?url|location)$/.test(field.key)) utm[field.path.split('.').at(-1)] = field.value;
  const pageUrl = locationIsUrl ? location.split('?')[0] : (pickAll(fields, 'campaign').find(field => /^(url|link|page ?url)$/.test(field.key))?.value || '');
  const campaign = Object.entries(utm).map(([key, value]) => `${key}=${value}`).join('; ');
  // Ghi chú ngắn cho bảng đơn: nguồn và mã chiến dịch, không phải cả chuỗi utm.
  const campaignSummary = [utm.utm_source ? `Nguồn: ${utm.utm_source}` : '', utm.utm_campaign ? `Chiến dịch: ${utm.utm_campaign}` : ''].filter(Boolean).join(' · ');
  const rawProducts = pickAll(fields, 'product').map(field => field.value).join('\n');
  // Khách đang điền dở (Webcake "Đồng bộ đơn chưa hoàn tất"): vẫn giữ làm lead,
  // đánh dấu để nhân viên gọi lại; khi khách gửi xong, bản hoàn tất đè lên.
  const formStatus = pick(fields, 'formStatus');
  const incomplete = INCOMPLETE_STATUS.test(keyOf(formStatus));
  const recognized = Object.keys(FIELD_PATTERNS);
  const unknown = fields
    .filter(field => field.value && !recognized.some(kind => FIELD_PATTERNS[kind].some(pattern => pattern.test(field.key))))
    .filter(field => !/^(\d+|name|title|label)$/.test(field.key) && !insideLineItem(field))
    .map(field => `${field.path}=${field.value}`);
  return { name, phone, phoneRaw, address, lines, total, prepaid, note, externalId, campaign, campaignSummary, pageUrl, insertedAt, rawProducts, formStatus, incomplete, unknown };
}

/** Khớp từng dòng với danh mục để lấy SKU kho và giá; không khớp thì giữ tên khách chọn. */
function catalogLines(lines, total) {
  const items = lines.map(line => {
    const product = findProductBySku(line.sku) || findProductBySku(line.product) || matchProduct(line.product);
    return {
      name: product?.name || String(line.product || '').trim(),
      sku: product?.sku || '',
      image: product?.image || '',
      weight: product?.weight || 0,
      quantity: quantityOf(line.quantity),
      price: money(line.price) || product?.unitPrice || 0,
      matched: Boolean(product)
    };
  }).filter(item => item.name);
  if (!items.length) return { items: [], priced: null };
  const allMatched = items.every(item => item.matched);
  const priced = allMatched ? priceBasket(items.map(item => ({ sku: item.sku, quantity: item.quantity }))) : null;
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const shippingFee = priced?.priceable ? priced.shippingFee : 0;
  const pricedItems = items.map((item, index) => {
    const product = item.sku ? findProductBySku(item.sku) : null;
    const basketPrice = product ? (unitPriceInBasket(product, totalQuantity) || item.price) : item.price;
    // Như đơn chatbot: phí ship (nếu có) gộp vào đơn giá dòng đầu để bảng đơn
    // và file kho cộng lại đúng tổng khách trả.
    const shipShare = index === 0 && shippingFee ? Math.round(shippingFee / item.quantity) : 0;
    return { ...item, price: product ? product.unitPrice : item.price, paidPrice: basketPrice + shipShare };
  });
  // Tổng khách thấy trên landing là con số đã cam kết; nếu form không gửi
  // tổng, dùng giá combo từ danh mục.
  const grandTotal = total || (priced?.priceable ? priced.total : 0);
  return { items: pricedItems, priced, total: grandTotal };
}

/**
 * Biến payload landing thành một đơn của hệ thống. Ném lỗi khi thiếu số điện
 * thoại hợp lệ — thiếu địa chỉ hay sản phẩm thì vẫn tạo đơn và gắn cờ để nhân
 * viên bổ sung, vì một lead có số điện thoại là thứ không được để rơi.
 */
export function buildLandingOrder(payload, { now = Date.now(), id = randomUUID().slice(0, 8), page = '', posId = '' } = {}) {
  const parsed = normalizeLandingPayload(payload);
  if (!parsed.phone) throw new Error('Không tìm thấy số điện thoại hợp lệ trong dữ liệu landing page.');
  const { items, priced, total } = catalogLines(parsed.lines, parsed.total);
  const products = items.length ? items : [{ name: 'Chưa rõ sản phẩm (kiểm tra form landing)', sku: '', quantity: 1, price: parsed.total || 0, paidPrice: parsed.total || 0 }];
  const freeShipping = Boolean(priced?.priceable && priced.shippingFee === 0);
  const shippingFee = priced?.priceable ? priced.shippingFee : 0;
  const subtotal = products.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const discount = total && subtotal + shippingFee > total ? subtotal + shippingFee - total : 0;
  const order = normalizeCustomerOrder({
    id,
    name: parsed.name || 'Khách landing page',
    phone: parsed.phone,
    address: parsed.address || 'Chưa có địa chỉ',
    products,
    discount,
    status: parsed.incomplete ? INCOMPLETE_LABEL : 'Mới',
    source: LANDING_SOURCE,
    payment: 'COD',
    freeShipping,
    shippingFee,
    // R13-fix (L5): phần khách đã chuyển khoản (đơn landing kéo từ POS có đặt cọc).
    ...(parsed.prepaid > 0 ? { prepaid: parsed.prepaid } : {}),
    // Ghi chú chỉ giữ lời khách (yêu cầu giao, mã giảm giá); nguồn/chiến dịch
    // nằm ở landing.campaign, việc cần làm do order-notes.mjs dựng.
    note: parsed.note,
    employee: 'Landing page',
    createdAt: now
  }, { now, id });
  if (total) order.total = total;
  // R13 (M6): tổng form khác giá danh mục (landing chạy giá riêng, hay form ghi nhầm): ghi chú xử lý để nhân viên
  // biết, và chia lại giá khách trả từng dòng (paidPrice) cho khớp tổng — trước đây "Combo 3 Xanh 399.000" lưu
  // tổng 399.000 nhưng paidPrice 149.000 × 3 = 447.000 (bảng đơn / file kho cộng lại không ra tổng).
  if (total && priced?.priceable && Number(priced.total) > 0 && total !== priced.total) {
    addProcessingFlag(order, `ℹ Giá landing ${moneyText(total)} khác bảng giá ${moneyText(priced.total)}`);
    spreadPaidPrices(order);
  }
  order.gift = priced?.priceable ? String(priced.gift || '') : '';
  order.landing = {
    externalId: parsed.externalId,
    page: String(page || parsed.pageUrl || '').slice(0, 200),
    campaign: parsed.campaign.slice(0, 500),
    submittedAt: parsed.insertedAt,
    formStatus: parsed.formStatus,
    incomplete: parsed.incomplete,
    rawProducts: parsed.rawProducts.slice(0, 1000),
    needsAddress: !parsed.address,
    needsProduct: !items.length || !items.every(item => item.matched),
    unknownFields: parsed.unknown.slice(0, 40),
    // Đơn kéo từ Pancake POS (đồng bộ định kỳ) ghi lại mã đơn POS.
    ...(posId ? { posId: String(posId) } : {})
  };
  order.automatic = true;
  return order;
}

function signature(order) {
  return `${order.phone}|${order.products.map(item => `${item.sku || item.name}x${item.quantity}`).join(',')}`;
}

/**
 * Lưu đơn, chống trùng: cùng mã của nền tảng, hoặc cùng số điện thoại và
 * cùng giỏ trong 10 phút (form bấm gửi hai lần).
 */
// ===== Tự điền cho đơn khách bỏ dở =====

/** utm_campaign của đơn landing (không có thì trang landing); campaigns.mjs dùng để quy đơn về chiến dịch. */
export const campaignKey = order => {
  const match = String(order?.landing?.campaign || '').match(/utm_campaign=([^;]+)/);
  return (match ? match[1].trim() : '') || String(order?.landing?.page || '').trim();
};

/**
 * Sản phẩm mặc định của một chiến dịch: tổ hợp (SKU × số lượng) xuất hiện
 * nhiều nhất trong các đơn đã có sản phẩm của cùng utm_campaign hoặc cùng
 * trang landing; không có thì lấy tổ hợp phổ biến nhất của mọi đơn landing.
 * Đơn đã tự điền không được tính để không tự củng cố chính nó.
 */
export function defaultBasketForCampaign(orders, order) {
  const key = campaignKey(order);
  const candidates = orders.filter(entry => entry.id !== order.id && !entry.landing?.autoFilled?.product && entry.products.some(item => item.sku));
  const tally = list => {
    const counts = new Map();
    for (const entry of list) {
      const signature = entry.products.filter(item => item.sku).map(item => `${item.sku}x${item.quantity}`).sort().join('+');
      counts.set(signature, (counts.get(signature) || 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? { signature: best[0], count: best[1], items: best[0].split('+').map(part => { const [sku, quantity] = part.split('x'); return { sku, quantity: Number(quantity) || 1 }; }) } : null;
  };
  const sameCampaign = key ? candidates.filter(entry => campaignKey(entry) === key) : [];
  const chosen = tally(sameCampaign);
  if (chosen) return { ...chosen, basis: `chiến dịch ${key}` };
  const overall = tally(candidates);
  return overall ? { ...overall, basis: 'mọi đơn landing' } : null;
}

function addressLevels(text) {
  const resolved = resolveAddress(text);
  return { resolved, complete: Boolean(resolved.province && resolved.district && resolved.ward && isUsableStreet(resolved.street)) };
}

/**
 * Địa chỉ đầy đủ cho số điện thoại này: POS trước (hồ sơ khách + đơn trước),
 * rồi đơn landing trước trong CRM. Chỉ nhận địa chỉ khớp với phần khách đã
 * gõ (cùng tỉnh, cùng quận nếu có), để không gửi hàng về địa chỉ cũ ở nơi khác.
 */
export async function pickAddressForPhone(order, orders, { fetchAddresses = fetchPosCustomerAddresses } = {}) {
  const typed = resolveAddress(order.address === 'Chưa có địa chỉ' ? '' : order.address);
  // fix-addr (01/10): khách đã gõ số nhà/đường thì chỉ lấy địa chỉ POS/đơn trước có chứa đúng phần đường đó — không đè
  // địa chỉ khách vừa gõ ("12 Tên Lửa, phường Bình Tân") bằng địa chỉ cũ ở nơi khác ("5 Lê Lợi, Quận 1").
  const typedStreet = String(typed.streetWithoutWard ?? typed.street ?? '').split(/\s*,\s*/)[0] || '';
  const typedStreetKey = isUsableStreet(typedStreet) && /\d/.test(typedStreet) ? normalizeLocationKey(typedStreet) : '';
  const fromPos = (await fetchAddresses(order.phone)).map(address => ({ address, source: 'POS' }));
  const fromCrm = orders
    .filter(entry => entry.id !== order.id && entry.phone === order.phone && !entry.landing?.autoFilled?.address && entry.address && entry.address !== 'Chưa có địa chỉ')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(entry => ({ address: entry.address, source: 'đơn trước trong CRM' }));
  for (const candidate of [...fromPos, ...fromCrm]) {
    const { resolved, complete } = addressLevels(candidate.address);
    if (!complete) continue;
    if (typed.province && typed.province.code !== resolved.province.code) continue;
    if (typed.district && typed.district.code !== resolved.district.code) continue;
    if (typed.ward && typed.ward.code !== resolved.ward.code) continue;
    if (typedStreetKey && !` ${normalizeLocationKey(candidate.address)} `.includes(` ${typedStreetKey} `)) continue;
    return candidate;
  }
  return null;
}

/**
 * Đơn khách điền dở (Webcake "chưa hoàn tất", hoặc gửi xong nhưng thiếu sản
 * phẩm/địa chỉ): điền sản phẩm mặc định của chiến dịch và địa chỉ đã biết
 * của số điện thoại, dựng lại đơn từ payload đã vá, và đánh dấu autoFilled
 * để bảng Đơn hàng đưa vào Xử lý dữ liệu cho nhân viên duyệt.
 */
export async function autoFillLandingOrder(order, payload, orders, context = {}) {
  const needsProduct = order.landing.needsProduct;
  const needsAddress = order.landing.needsAddress || order.locationConfidence !== 'exact';
  if (!needsProduct && !needsAddress) return order;
  const patched = { ...payload };
  const autoFilled = {};
  let aiSuggestion = '';
  if (needsProduct) {
    const basket = defaultBasketForCampaign(orders, order);
    if (basket) {
      const lines = basket.items.map(item => { const product = findProductBySku(item.sku); return product ? `${product.name} x${item.quantity}` : ''; }).filter(Boolean);
      if (lines.length) {
        for (const key of Object.keys(patched)) if (/^(products?|variations?|total|total_price|quantity|sku)$/i.test(key)) delete patched[key];
        patched.products = lines.join('\n');
        autoFilled.product = `${lines.join(' + ')} (mặc định theo ${basket.basis}, ${basket.count} đơn)`;
      }
    }
  }
  if (needsAddress) {
    const picked = await pickAddressForPhone(order, orders, context);
    if (picked) {
      for (const key of Object.keys(patched)) if (/^(address|short_address|location|province|district|ward|commune|country|city|state)$/i.test(key)) delete patched[key];
      patched.address = picked.address;
      autoFilled.address = `${picked.address} (từ ${picked.source})`;
    } else if (order.address && order.address !== 'Chưa có địa chỉ' && ['none', 'partial'].includes(order.locationConfidence)) {
      // Khách có gõ địa chỉ nhưng bộ đọc luật không tách đủ ba cấp: hỏi AI.
      // Kết quả đã được đối chiếu danh mục kho; đơn vẫn vào Xử lý dữ liệu để duyệt.
      // fix-addr (01/10): cả địa chỉ luật đã nhận nhưng thiếu phường/xã (wardUnverified) — chạy nền, đơn vẫn vào Xử lý dữ liệu.
      const guess = await (context.inferAddress || inferAddress)(order.address, { allowWardUnverified: true });
      // Số nhà khách gõ phải còn trên địa chỉ AI trả (AI chỉ được điền cấp hành chính).
      if (guess?.canonical && !lostHouseNumbers(order.address, guess.canonical).length) {
        for (const key of Object.keys(patched)) if (/^(address|short_address|location|province|district|ward|commune|country|city|state)$/i.test(key)) delete patched[key];
        patched.address = guess.canonical;
        autoFilled.address = `${guess.canonical} (AI suy ra từ "${order.address}"${guess.confidence === 'low' ? ', cần đối chiếu' : ''})`;
        autoFilled.addressAi = { original: order.address, reason: guess.reason, sources: guess.sources || [] };
      } else if (guess?.suggestOnly && guess.suggestion?.ward) {
        // R13 (K12): phường/xã AI tự suy, chưa kiểm được bằng danh mục → KHÔNG tự điền, chỉ ghi gợi ý cho nhân viên đối chiếu.
        aiSuggestion = `ℹ Gợi ý phường/xã (AI, chưa kiểm): ${[guess.suggestion.ward, guess.suggestion.district].filter(Boolean).join(', ')}`;
      }
    }
  }
  if (!Object.keys(autoFilled).length) {
    if (aiSuggestion) addProcessingFlag(order, aiSuggestion);
    return order;
  }
  const rebuilt = buildLandingOrder(patched, { now: order.createdAt, id: order.id, page: order.landing.page });
  if (aiSuggestion) addProcessingFlag(rebuilt, aiSuggestion);
  rebuilt.status = order.status;
  rebuilt.phoneWarning = order.phoneWarning;
  rebuilt.landing = { ...rebuilt.landing, incomplete: order.landing.incomplete, formStatus: order.landing.formStatus, externalId: order.landing.externalId, formIds: order.landing.formIds, posId: order.landing.posId, autoFilled };
  return rebuilt;
}

/**
 * R13 (T2): thời điểm khách gửi form theo POS ("2026-09-16 07:52:24", giờ Việt Nam — pos-sync.posTimeToWebcake) → ms.
 * Không đọc được, ở tương lai, hay cũ hơn 120 ngày thì trả `fallback` (lúc nhận).
 */
export function landingSubmittedAt(insertedAt, fallback = Date.now()) {
  const match = String(insertedAt || '').trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (!match) return fallback;
  const parsed = Date.parse(`${match[1]}T${match[2].length === 5 ? `${match[2]}:00` : match[2]}+07:00`);
  if (!Number.isFinite(parsed) || parsed > fallback + 5 * 60 * 1000 || parsed < fallback - 120 * 24 * 60 * 60 * 1000) return fallback;
  return parsed;
}

/** Khoá địa chỉ để dò đơn có thể trùng: bỏ dấu, bỏ "(Live)"/"(Freeship)", chỉ chữ và số; quá ngắn (≤ 15 ký tự) thì không xét. */
function duplicateAddressKey(order) {
  const address = String(order?.address || '');
  if (!address || /^chưa có địa chỉ$/i.test(address.trim())) return '';
  const key = normalizeText(address).replace(/\(live\)|\(freeship\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  return key.length > 15 ? key : '';
}

const isCompletedLiveOrder = order => Boolean(order) && order.landing?.incomplete !== true
  && String(order.processingStatus || '') !== 'cancelled' && order.status !== 'Hủy';

/**
 * R13 (M5): đơn landing có thể trùng — cùng SĐT hoặc cùng địa chỉ, hai form HOÀN TẤT cách nhau ≤ 10 phút, chưa hủy
 * (21 ngày: 19 cặp, 8 cặp cả hai cùng lên POS). KHÔNG gộp (mỗi form là một đơn riêng, chủ ý); chỉ gắn ghi chú xử lý
 * "⚠ Có thể trùng đơn LP-<mã>" lên ĐƠN SAU của cặp. Trả về đơn vừa được gắn (hay null).
 */
export function flagPossibleDuplicate(orders, order) {
  if (!isCompletedLiveOrder(order)) return null;
  const at = Number(order.createdAt) || 0;
  const addressKey = duplicateAddressKey(order);
  const twin = (Array.isArray(orders) ? orders : []).find(entry => entry !== order && entry?.id !== order.id && isCompletedLiveOrder(entry)
    && Math.abs((Number(entry.createdAt) || 0) - at) <= duplicateWindowMs
    && ((order.phone && entry.phone === order.phone) || (addressKey && duplicateAddressKey(entry) === addressKey)));
  if (!twin) return null;
  // Đơn sau của cặp nhận ghi chú (đơn kéo từ POS mang ngày tạo thật có thể CŨ hơn đơn đang giữ).
  const [earlier, later] = (Number(twin.createdAt) || 0) > at ? [order, twin] : [twin, order];
  return addProcessingFlag(later, `${DUPLICATE_FLAG_PREFIX}${earlier.id}`) ? later : null;
}

export const DUPLICATE_FLAG_PREFIX = '⚠ Có thể trùng đơn LP-';
/** Đơn đã chốt: nhân viên đã xem — Đã xác nhận hay Hủy. */
const isSettledOrder = order => ['confirmed', 'cancelled'].includes(String(order?.processingStatus || '')) || order?.status === 'Hủy';

/**
 * R13-fix (T3): gỡ cờ "⚠ Có thể trùng đơn LP-<mã>" khi đơn gốc không còn trong kho (đã xoá), đã hủy hay Đã xác nhận,
 * hoặc chính đơn mang cờ đã Đã xác nhận/Hủy (nhân viên đã xem). Trước đây cờ không bao giờ mất, Tổng quan đếm mãi.
 * Trả về số đơn đã gỡ cờ.
 */
export function sweepDuplicateFlags(orders) {
  const list = Array.isArray(orders) ? orders : [];
  const byId = new Map(list.map(order => [String(order?.id), order]));
  let changed = 0;
  for (const order of list) {
    if (!Array.isArray(order?.processingFlags)) continue;
    const settled = isSettledOrder(order);
    const removed = removeProcessingFlag(order, flag => {
      if (!String(flag).startsWith(DUPLICATE_FLAG_PREFIX)) return false;
      if (settled) return true;
      const twin = byId.get(String(flag).slice(DUPLICATE_FLAG_PREFIX.length).trim());
      return !twin || isSettledOrder(twin);
    });
    if (removed) changed += 1;
  }
  return changed;
}

export async function recordLandingOrder(payload, context = {}) {
  const receivedAt = Date.now();
  let order;
  let error = '';
  try {
    // R13 (T2): đơn kéo từ POS lấy NGÀY TẠO THẬT trên POS (inserted_at) — trước đây lấy lúc đồng bộ, nên sau mỗi lần
    // khởi động lại (lượt đầu kéo 7 ngày) đơn cũ bị dồn vào ngày đồng bộ trong Báo cáo/Tổng quan.
    const createdAt = context.posId ? landingSubmittedAt(payload?.inserted_at, receivedAt) : receivedAt;
    order = buildLandingOrder(payload, { ...context, now: createdAt });
    // Khách điền dở: điền sản phẩm mặc định của chiến dịch và địa chỉ đã biết,
    // đơn đi vào Xử lý dữ liệu chờ nhân viên duyệt.
    if (context.autoFill !== false) order = await autoFillLandingOrder(order, payload, (await readLandingStore()).orders, context);
    // Khách hay bom hàng: đơn vẫn vào bảng, kèm cảnh báo để gọi xác nhận trước khi giao.
    if (context.checkPhone !== false) await attachPhoneWarning(order);
  } catch (failure) {
    error = failure.message;
  }
  const result = await updateLandingStore(store => {
    store.recent.unshift({ at: receivedAt, page: String(context.page || ''), ok: !error, error, orderId: order?.id || '', payload });
    store.recent = store.recent.slice(0, maximumRecent);
    if (!order) return { order: null, created: false, error };
    // Một đơn có thể gom nhiều bản ghi form của Webcake (bản dở dang rồi bản
    // hoàn tất): mọi mã đã gộp đều nhận ra đơn đó.
    const formIds = entry => [entry.landing?.externalId, ...(entry.landing?.formIds || [])].filter(Boolean);
    const sameForm = (order.landing.posId ? store.orders.find(entry => entry.landing?.posId === order.landing.posId) : null)
      || (order.landing.externalId ? store.orders.find(entry => formIds(entry).includes(order.landing.externalId)) : null);
    // Khách điền nhiều form (bỏ dở rồi gửi lại, gửi hai lần, đổi landing) thì
    // mỗi form là một đơn riêng, không tự gộp: bảng Đơn hàng hiện cả nhóm cùng
    // số điện thoại khi bấm vào đơn để nhân viên quyết định.
    const existing = sameForm;
    if (existing) {
      // Bản khách gửi xong luôn thắng bản dở dang đã được máy tự điền.
      const realBeatsAutoFilled = Boolean(existing.landing?.autoFilled) && !order.landing.incomplete && !order.landing.autoFilled;
      if (existing.landing?.incomplete && (realBeatsAutoFilled || !isLessComplete(order, existing))) {
        const index = store.orders.indexOf(existing);
        const upgraded = mergeCompletedForm(existing, order, { receivedAt, formIds: formIds(existing) });
        store.orders[index] = upgraded;
        flagPossibleDuplicate(store.orders, upgraded);
        return { order: upgraded, created: false, updated: true, error: '' };
      }
      // Đơn webhook chưa có mã POS: ghi mã POS vào để lần đồng bộ sau nhận ra ngay.
      absorbInto(existing, order);
      return { order: existing, created: false, error: '' };
    }
    // Form không có mã (không có inserted_at) gọi lại trong 10 phút với cùng giỏ
    // là cùng một lần gửi (webhook thử lại). Có mã thì đã xét ở sameForm; bản
    // máy tự điền không bao giờ bị coi là trùng với đơn khác.
    const duplicate = !order.landing.externalId && !order.landing.autoFilled
      ? store.orders.find(entry => signature(entry) === signature(order) && receivedAt - (Number(entry.createdAt) || 0) < duplicateWindowMs)
      : null;
    if (duplicate) return { order: duplicate, created: false, error: '' };
    // Quá trần thì updateLandingStore chuyển đơn cũ nhất sang kho lưu trữ (không bỏ).
    store.orders.unshift(order);
    // R13 (M5): không gộp, chỉ cảnh báo trên đơn sau của cặp có thể trùng.
    flagPossibleDuplicate(store.orders, order);
    return { order, created: true, error: '' };
  });
  // Mọi đơn đều vào kho lưu trữ, kể cả đơn sau này bị hủy hay xóa.
  if (result?.order) await appendOrderToArchive(result.order).catch(() => {});
  return result;
}


/**
 * Bản dở dang → bản khách gửi xong (cùng form). Nội dung form mới thắng, NHƯNG:
 * - mọi thứ không phải nội dung form đi theo đơn cũ: lịch sử, cờ ẩn khỏi bảng, kết quả đẩy
 *   POS (`pos`), trạng thái POS, thẻ đã mua, người tạo/sửa, ghi chú & trạng thái xử lý;
 * - nhóm nội dung nhân viên đã tự tay sửa (địa chỉ, giỏ, tên, SĐT… — order-edits ghi
 *   `staffEdited`) giữ bản nhân viên; form hoàn tất khác bản đó thì cất vào
 *   `landing.completedForm` để nhân viên đối chiếu.
 */
function mergeCompletedForm(existing, order, { receivedAt, formIds }) {
  const landing = {
    ...order.landing,
    posId: order.landing.posId || existing.landing?.posId,
    posIds: [...new Set([...(existing.landing?.posIds || []), existing.landing?.posId, order.landing.posId].filter(Boolean))],
    formIds: [...new Set([...formIds, order.landing.externalId].filter(Boolean))]
  };
  const upgraded = {
    ...existing,
    ...order,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: receivedAt,
    // Ghi chú và trạng thái nhân viên đặt cho bản dở dang đi theo bản khách gửi xong.
    staffNote: existing.staffNote || order.staffNote || '',
    processingStatus: existing.processingStatus || order.processingStatus || '',
    // Nhãn "Chưa hoàn tất" của bản dở theo bản mới; trạng thái nhân viên đã đặt (Đã xác nhận, Hủy) giữ.
    status: existing.status && existing.status !== INCOMPLETE_LABEL ? existing.status : order.status,
    landing
  };
  if (!order.phoneWarning) delete upgraded.phoneWarning;
  if (landing.autoFilled) landing.autoFilled = { ...landing.autoFilled };
  const edited = staffEditedGroups(existing);
  if (!edited.size) return upgraded;
  const completedForm = {};
  for (const group of edited) {
    for (const field of STAFF_EDIT_GROUPS[group]) {
      if (Object.hasOwn(existing, field)) upgraded[field] = existing[field];
      else delete upgraded[field];
    }
    const formValue = group === 'basket'
      ? order.products.map(item => `${item.quantity} ${item.sku || item.name}`).join(' + ')
      : ['name', 'phone', 'address', 'payment', 'note'].includes(group) ? String(order[group] ?? '') : '';
    const keptValue = group === 'basket'
      ? (existing.products || []).map(item => `${item.quantity} ${item.sku || item.name}`).join(' + ')
      : String(existing[group] ?? '');
    if (formValue && formValue !== keptValue) completedForm[group] = formValue;
  }
  if (edited.has('address')) {
    landing.needsAddress = Boolean(existing.landing?.needsAddress);
    if (landing.autoFilled?.address) delete landing.autoFilled.address;
  }
  if (edited.has('basket')) {
    landing.needsProduct = Boolean(existing.landing?.needsProduct);
    if (landing.autoFilled?.product) delete landing.autoFilled.product;
  }
  if (landing.autoFilled && !Object.keys(landing.autoFilled).length) delete landing.autoFilled;
  if (Object.keys(completedForm).length) landing.completedForm = { ...completedForm, at: receivedAt };
  return upgraded;
}

/** Ghi mã form/POS của bản cập nhật cùng form vào đơn đang giữ để lần sau nhận ra ngay. */
function absorbInto(keeper, other) {
  const landing = keeper.landing || {};
  const formIds = [...new Set([...(landing.formIds || []), other.landing?.externalId].filter(id => id && id !== landing.externalId))];
  const posIds = [...new Set([...(landing.posIds || []), landing.posId, other.landing?.posId].filter(Boolean))];
  keeper.landing = { ...landing, posId: landing.posId || other.landing?.posId, ...(formIds.length ? { formIds } : {}), ...(posIds.length ? { posIds } : {}) };
}

/** Bản mới có ít thông tin hơn bản đang giữ (sự kiện đến muộn) thì không đè. */
function isLessComplete(fresh, existing) {
  const score = order => [order.address !== 'Chưa có địa chỉ', order.ward, order.district, order.province, order.products.some(item => item.sku), order.name !== 'Khách landing page', !order.landing?.incomplete].filter(Boolean).length;
  return score(fresh) < score(existing);
}

/**
 * Đơn landing cho bảng Đơn hàng, báo cáo, Tổng quan, Chiến dịch: kho chính và (mặc định)
 * cả đơn đã chuyển sang kho lưu trữ khi quá trần, để doanh thu kỳ cũ không biến mất.
 * `includeArchived: false` khi chỉ cần đơn đang xử lý. Kho lưu trữ đọc lỗi thì log và trả
 * kho chính (không nhớ lỗi, lần sau đọc lại).
 */
export async function listLandingOrders({ includeArchived = true } = {}) {
  const store = await readLandingStore();
  const view = order => ({ ...order, conversationId: '', conversationName: order.name || '' });
  if (!includeArchived) return store.orders.map(view);
  let archived;
  try {
    archived = await readArchivedLandingOrders();
  } catch (error) {
    console.error(`Không đọc được kho lưu trữ đơn landing (${error?.message || error}); chỉ trả đơn trong kho chính.`);
    return store.orders.map(view);
  }
  // Chụp kho chính SAU khi đã có kho lưu trữ (lần nạp đầu có thể chờ sau một lần chuyển đơn): chụp trước thì
  // đơn vừa chuyển nằm ở cả hai danh sách mà không bị khử trùng.
  const active = store.orders.map(view);
  if (!archived.size) return active;
  const activeIds = new Set(store.orders.map(order => String(order?.id)));
  return [...active, ...[...archived.values()].filter(order => !activeIds.has(String(order?.id))).map(view)];
}

export async function deleteLandingOrder(orderId) {
  return updateLandingStore(store => {
    const index = store.orders.findIndex(order => order.id === orderId);
    if (index < 0) return null;
    const [removed] = store.orders.splice(index, 1);
    return removed;
  });
}

export async function listRecentLandingPayloads() {
  const store = await readLandingStore();
  return store.recent;
}
