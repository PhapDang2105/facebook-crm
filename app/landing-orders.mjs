// Đơn đổ về từ form landing page (Webcake và các nền tảng tương tự) qua webhook.
//
// Mỗi nền tảng đặt tên trường một kiểu ("name"/"họ tên"/"full_name",
// "phone"/"sđt"/"số điện thoại"...), và có thể bọc trong data/fields/form_data.
// Module này làm phẳng payload, nhận dạng trường theo nghĩa, khớp sản phẩm với
// danh mục rồi đưa qua normalizeCustomerOrder — cùng một đường với đơn chatbot,
// nên ba cấp địa chỉ, giá và SKU kho đều được xử lý y hệt. Payload gốc của
// những lần gọi gần nhất được giữ lại để đối chiếu khi một trường chưa được
// nhận ra.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { projectRoot } from './config.mjs';
import { normalizeCustomerOrder } from './conversation-orders.mjs';
import { findProductBySku, matchProduct, normalizeText } from './processing/catalog.mjs';
import { priceBasket, unitPriceInBasket } from './processing/pricing.mjs';
import { extractVietnamesePhone, toLocalPhone } from './processing/customer-info.mjs';

const landingOrdersPath = process.env.LANDING_ORDERS_PATH
  || path.join(projectRoot, 'data', 'processed', 'landing-orders.json');

export const LANDING_SOURCE = 'Landing page';
const maximumOrders = 5000;
// Payload gốc được giữ cho mọi đơn gần đây, để tính lại đơn khi bộ nhận dạng thay đổi.
const maximumRecent = 1000;
const duplicateWindowMs = 10 * 60 * 1000;

let cachedStore = null;
let writeQueue = Promise.resolve();

function emptyStore() {
  return { orders: [], recent: [] };
}

function normalizeStore(value) {
  if (!value || typeof value !== 'object') return emptyStore();
  return {
    orders: Array.isArray(value.orders) ? value.orders : [],
    recent: Array.isArray(value.recent) ? value.recent : []
  };
}

export async function readLandingStore() {
  if (cachedStore) return cachedStore;
  try {
    cachedStore = normalizeStore(JSON.parse(await readFile(landingOrdersPath, 'utf8')));
  } catch {
    cachedStore = emptyStore();
  }
  return cachedStore;
}

async function persistStore(store) {
  await mkdir(path.dirname(landingOrdersPath), { recursive: true });
  const temporaryPath = `${landingOrdersPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  await rename(temporaryPath, landingOrdersPath);
}

/** Ghi tuần tự để hai webhook đến cùng lúc không ghi đè nhau. */
export function updateLandingStore(mutate) {
  const operation = writeQueue.then(async () => {
    const store = await readLandingStore();
    const result = await mutate(store);
    await persistStore(store);
    return result;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export function resetLandingStoreCache() {
  cachedStore = null;
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
  // "utm_source", "email": "email", "payment_status": "payment_status."):
  // đó là ô trống, không phải dữ liệu.
  if (keyOf(text.replace(/[.:]+$/, '')) === key) return out;
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
  note: [/^(ghi ?chu|note|notes|message|loi nhan|yeu cau|comment|content|noi dung|textarea( input)?( \d+)?|text ?input( \d+)?)$/],
  coupon: [/^(coupon|ma giam gia|voucher|ma khuyen mai)$/],
  id: [/^(order ?id|ma don( hang)?|id|submission ?id|entry ?id|uuid|order ?code|ma don hang)$/],
  campaign: [/^(utm ?campaign|campaign|chien dich|utm ?source|utm ?medium|utm ?content|utm ?term|landing( ?page)?( ?name)?|page ?name|page ?title|source|nguon|form ?name|form ?title|page ?url|url|link|event)$/],
  insertedAt: [/^(inserted ?at|created ?at|submitted ?at|date ?time|timestamp)$/],
  ignored: [/^(date|time|upload|file|email|ip|user ?agent|referrer?|country ?code|captcha|updated ?at|status|payment ?status|transfer ?money|shipping ?fee|discount|currency|variation ?id|product ?id|id)$/]
};
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
  const phone = toLocalPhone(phoneRaw) || extractVietnamesePhone(phoneRaw) || extractVietnamesePhone(fields.map(field => field.value).join(' '));
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
  // lựa chọn nào khớp danh mục thì là sản phẩm, còn lại ghi vào ghi chú.
  const choices = pickAll(fields, 'choice');
  const choiceNotes = [];
  for (const choice of choices) {
    const split = splitProductText(choice.value);
    if (!lines.length && matchProduct(split.product)) lines = [{ product: split.product, sku: '', quantity: split.quantity || pick(fields, 'quantity'), price: '' }];
    else choiceNotes.push(`${choice.path}: ${choice.value}`);
  }
  const total = money(pick(fields, 'total'));
  const coupon = pick(fields, 'coupon');
  const note = [...pickAll(fields, 'note').map(field => field.value), ...choiceNotes, coupon ? `Mã giảm giá: ${coupon}` : ''].filter(Boolean).join(' · ');
  // Không có mã đơn thì SĐT + thời điểm gửi form là khóa chống trùng khi Webcake gọi lại.
  const insertedAt = pick(fields, 'insertedAt');
  const externalId = pick(fields, 'id') || (insertedAt && phone ? `${phone}@${insertedAt}` : '');
  const utm = { ...(locationIsUrl ? utmFromUrl(location) : {}) };
  for (const field of pickAll(fields, 'campaign')) if (!/^(url|link|page ?url|location)$/.test(field.key)) utm[field.path.split('.').at(-1)] = field.value;
  const pageUrl = locationIsUrl ? location.split('?')[0] : (pickAll(fields, 'campaign').find(field => /^(url|link|page ?url)$/.test(field.key))?.value || '');
  const campaign = Object.entries(utm).map(([key, value]) => `${key}=${value}`).join('; ');
  // Ghi chú ngắn cho bảng đơn: nguồn và mã chiến dịch, không phải cả chuỗi utm.
  const campaignSummary = [utm.utm_source ? `Nguồn: ${utm.utm_source}` : '', utm.utm_campaign ? `Chiến dịch: ${utm.utm_campaign}` : ''].filter(Boolean).join(' · ');
  const rawProducts = pickAll(fields, 'product').map(field => field.value).join('\n');
  const recognized = Object.keys(FIELD_PATTERNS);
  const insideLineItem = field => /(^|\.)(products?|items?|line ?items?|cart|san pham|order ?items?|variations?)(\.\d+)?\.[^.]+$/.test(field.path.split('.').map(keyOf).join('.'));
  const unknown = fields
    .filter(field => field.value && !recognized.some(kind => FIELD_PATTERNS[kind].some(pattern => pattern.test(field.key))))
    .filter(field => !/^(\d+|name|title|label)$/.test(field.key) && !insideLineItem(field))
    .map(field => `${field.path}=${field.value}`);
  return { name, phone, phoneRaw, address, lines, total, note, externalId, campaign, campaignSummary, pageUrl, insertedAt, rawProducts, unknown };
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
export function buildLandingOrder(payload, { now = Date.now(), id = randomUUID().slice(0, 8), page = '' } = {}) {
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
    status: 'Mới',
    source: LANDING_SOURCE,
    payment: 'COD',
    freeShipping,
    shippingFee,
    note: [parsed.note, parsed.campaignSummary].filter(Boolean).join(' · ') || 'Đơn từ landing page.',
    employee: 'Landing page',
    createdAt: now
  }, { now, id });
  if (total) order.total = total;
  order.gift = priced?.priceable ? String(priced.gift || '') : '';
  order.landing = {
    externalId: parsed.externalId,
    page: String(page || parsed.pageUrl || '').slice(0, 200),
    campaign: parsed.campaign.slice(0, 500),
    submittedAt: parsed.insertedAt,
    rawProducts: parsed.rawProducts.slice(0, 1000),
    needsAddress: !parsed.address,
    needsProduct: !items.length || !items.every(item => item.matched),
    unknownFields: parsed.unknown.slice(0, 40)
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
export async function recordLandingOrder(payload, context = {}) {
  const receivedAt = Date.now();
  let order;
  let error = '';
  try {
    order = buildLandingOrder(payload, { ...context, now: receivedAt });
  } catch (failure) {
    error = failure.message;
  }
  return updateLandingStore(store => {
    store.recent.unshift({ at: receivedAt, page: String(context.page || ''), ok: !error, error, orderId: order?.id || '', payload });
    store.recent = store.recent.slice(0, maximumRecent);
    if (!order) return { order: null, created: false, error };
    const existing = (order.landing.externalId
      ? store.orders.find(entry => entry.landing?.externalId && entry.landing.externalId === order.landing.externalId)
      : null)
      || store.orders.find(entry => signature(entry) === signature(order) && receivedAt - (Number(entry.createdAt) || 0) < duplicateWindowMs);
    if (existing) return { order: existing, created: false, error: '' };
    store.orders.unshift(order);
    store.orders = store.orders.slice(0, maximumOrders);
    return { order, created: true, error: '' };
  });
}

export async function listLandingOrders() {
  const store = await readLandingStore();
  return store.orders.map(order => ({ ...order, conversationId: '', conversationName: order.name || '' }));
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
