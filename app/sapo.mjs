// Sapo (kho đóng gói + đẩy hãng): CRM CHỈ ĐỌC đơn để lấy mã vận đơn, hãng, link
// tra và trạng thái giao. Ứng dụng riêng trên Sapo chỉ cấp quyền "Đơn hàng: Chỉ
// đọc" (SAPO_STORE / SAPO_API_KEY / SAPO_API_SECRET trong .env).
//
// Dữ liệu thật (03/10/2026): ~2.300 đơn/ngày, gần hết Shopee/TikTok (bỏ qua). Đơn
// Facebook do nhân viên xuất file từ Pancake rồi import tay lên Sapo: source_name
// "facebook", KHÔNG mang mã đơn Pancake/CRM, chỉ có SĐT người nhận
// (shipping_address.phone). Mã vận đơn nằm ở fulfillments[].tracking_info
// { carrier: JNT_EXPRESS | SHOPEE_XPRESS | SAPO_EXPRESS…, tracking_number, tracking_url }
// và trạng thái giao ở fulfillments[].shipment_status.
//
// Lưu ý API: `status=any` trả danh sách RỖNG ở cửa hàng này — không truyền status.
// Giới hạn 40 lần gọi (header x-sapo-api-call-limit "n/40"), 250 đơn mỗi trang.

const MARKETPLACE = /tiktok|shopee|lazada|tiki/i;
const PAGE_LIMIT = 250;
const ORDER_FIELDS = 'id,name,source_name,source,tags,note,created_on,modified_on,cancelled_on,status,total_price,phone,shipping_address,fulfillments';

export function sapoConfigFrom(environment = process.env) {
  return {
    store: String(environment.SAPO_STORE || '').trim().replace(/\.mysapo\.net.*$/i, ''),
    apiKey: String(environment.SAPO_API_KEY || '').trim(),
    apiSecret: String(environment.SAPO_API_SECRET || '').trim(),
    // Mặc định CHỈ ghi mã vận đơn vào đơn CRM; tự nhắn khách chỉ bật khi SAPO_NOTIFY_CUSTOMERS=1.
    notifyCustomers: environment.SAPO_NOTIFY_CUSTOMERS === '1',
    disabled: Boolean(environment.SAPO_SYNC_DISABLED)
  };
}

export const sapoConfig = sapoConfigFrom();

export function isSapoConfigured(config = sapoConfig) {
  return Boolean(config.store && config.apiKey && config.apiSecret);
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Một trang đơn sửa từ `modifiedSince` (ms), cũ → mới không đảm bảo; trả về mảng đơn thô. */
export async function fetchSapoOrdersPage({ modifiedSince, page = 1 }, config = sapoConfig, fetchImpl = fetch) {
  if (!isSapoConfigured(config)) throw new Error('Chưa cấu hình Sapo (SAPO_STORE / SAPO_API_KEY / SAPO_API_SECRET).');
  const url = new URL(`https://${config.store}.mysapo.net/admin/orders.json`);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  url.searchParams.set('page', String(page));
  url.searchParams.set('fields', ORDER_FIELDS);
  if (modifiedSince) url.searchParams.set('modified_on_min', new Date(modifiedSince).toISOString());
  const authorization = `Basic ${Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64')}`;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(url, { headers: { Authorization: authorization, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (response.status === 429 && attempt < 3) { await pause(5000 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(`Sapo trả ${response.status} khi đọc đơn.`);
    const body = await response.json();
    return Array.isArray(body?.orders) ? body.orders : [];
  }
}

/** Mọi đơn sửa từ `modifiedSince`, nghỉ giữa các trang để không chạm giới hạn 40 lần gọi. */
export async function listSapoOrdersModifiedSince(modifiedSince, { config = sapoConfig, fetchImpl = fetch, maxPages = 60, pauseMs = 700 } = {}) {
  const orders = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await fetchSapoOrdersPage({ modifiedSince, page }, config, fetchImpl);
    orders.push(...batch);
    if (batch.length < PAGE_LIMIT) return { orders, complete: true };
    if (pauseMs) await pause(pauseMs);
  }
  return { orders, complete: false };
}

export const isMarketplaceOrder = order => MARKETPLACE.test(`${order?.source_name || ''} ${order?.tags || ''}`);

export function phoneKey(value) {
  return String(value || '').replace(/\D/g, '').slice(-9);
}

const CARRIERS = [
  { test: (carrier, number) => /JNT|J&T/i.test(carrier) || /^\d{12}$/.test(number), name: 'J&T Express', url: number => `https://jtexpress.vn/tracking?type=track&billcode=${encodeURIComponent(number)}` },
  { test: (carrier, number) => /SHOPEE|SPX/i.test(carrier) || /^SPXVN/i.test(number), name: 'SPX Express', url: number => `https://spx.vn/track?${encodeURIComponent(number)}` }
];

/** Tên hãng + link tra cho khách. Link Sapo đưa (J&T có sẵn) được dùng trước. */
export function carrierInfo({ carrier = '', carrierName = '', trackingNumber = '', trackingUrl = '' } = {}) {
  const known = CARRIERS.find(item => item.test(String(carrier), String(trackingNumber)));
  return {
    name: known?.name || String(carrierName || carrier || '').trim() || 'đơn vị vận chuyển',
    url: String(trackingUrl || '').trim() || (known && trackingNumber ? known.url(trackingNumber) : '')
  };
}

const STATUS_LABELS = {
  pending: 'Chờ lấy hàng',
  picked_up: 'Đã lấy hàng',
  delivering: 'Đang giao',
  retry_delivery: 'Giao lại',
  delivered: 'Đã giao',
  returning: 'Đang hoàn',
  returned: 'Đã hoàn',
  cancelled: 'Đã hủy'
};

export function shipmentStatusLabel(status) {
  return STATUS_LABELS[String(status || '')] || String(status || '') || 'Đã tạo vận đơn';
}

/**
 * Đơn Sapo → vận đơn rút gọn để ghép với đơn CRM; null khi là đơn sàn, chưa có mã
 * vận đơn hay không có SĐT người nhận.
 */
export function sapoShipment(order) {
  if (!order || isMarketplaceOrder(order)) return null;
  const fulfillment = (Array.isArray(order.fulfillments) ? order.fulfillments : [])
    .filter(item => item && item.status !== 'cancelled' && !item.cancelled_on)
    .map(item => ({ item, info: item.tracking_info || {} }))
    .find(({ item, info }) => info.tracking_number || item.tracking_number);
  if (!fulfillment) return null;
  const { item, info } = fulfillment;
  const trackingNumber = String(info.tracking_number || item.tracking_number || '').trim();
  const phone = phoneKey(order.shipping_address?.phone || order.phone);
  if (!trackingNumber || phone.length !== 9) return null;
  const carrier = carrierInfo({ carrier: info.carrier, carrierName: info.carrier_name || item.tracking_company, trackingNumber, trackingUrl: info.tracking_url || item.tracking_url });
  return {
    sapoId: String(order.id),
    sapoName: String(order.name || ''),
    sourceName: String(order.source_name || ''),
    createdAt: Date.parse(order.created_on) || 0,
    phoneKey: phone,
    total: Number(order.total_price) || 0,
    note: String(order.note || ''),
    cancelled: Boolean(order.cancelled_on) || order.status === 'cancelled',
    carrier: carrier.name,
    trackingNumber,
    trackingUrl: carrier.url,
    status: String(item.shipment_status || ''),
    deliveredAt: Date.parse(item.delivered_on) || 0
  };
}
