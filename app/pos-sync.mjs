// Đồng bộ đơn landing từ Pancake POS về CRM.
//
// Mọi landing của Webcake đều đổ đơn về POS (kể cả đơn khách bỏ dở,
// `is_abandoned_order`), nên kéo từ POS là cách chắc chắn nhất để không sót
// đơn nào dù landing đó chưa gắn webhook về CRM. Mỗi đơn POS được dựng thành
// payload y như Webcake gửi qua webhook (cùng tên trường, cùng định dạng
// chuỗi sản phẩm "Tên (Phân loại): sl x giá", cùng inserted_at giờ Việt Nam)
// rồi đi qua recordLandingOrder: trùng webhook thì gộp, đơn dở thì tự điền,
// số bom hàng thì cảnh báo — một luồng duy nhất.
import { posConfig, posConfigured, posRequest } from './phone-warnings.mjs';
import { absorbDuplicateOrders, readLandingStore, recordLandingOrder } from './landing-orders.mjs';

export const POS_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const LANDING_SOURCES = /webcake|landing/i;

/** "2026-09-16T00:52:24.000000" (UTC) → "2026-09-16 07:52:24" như Webcake gửi. */
export function posTimeToWebcake(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text.endsWith('Z') || /[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return text;
  const local = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const pad = number => String(number).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}

/**
 * Số nhà/đường khách gõ. Với đơn bỏ dở, Webcake chèn mã "GXN " vào trước địa
 * chỉ gửi sang POS (kể cả khi khách chưa gõ gì: địa chỉ chỉ còn "GXN") nhưng
 * ghi nguyên văn khách gõ trong note ("address: …"); lấy bản trong note khi
 * phần POS chỉ khác ở tiền tố đó, còn lại bỏ tiền tố.
 */
export function posStreet(order) {
  const address = order.shipping_address || {};
  const street = String(address.address || '').trim();
  const typed = String((String(order.note || '').match(/^address:\s*(.*?)\s*,?\s*$/mi) || [])[1] || '').trim();
  if (typed && street !== typed && street.endsWith(typed)) return typed;
  return street.replace(/^GXN\b[\s,.-]*/i, '').trim();
}

/** Một đơn POS → payload cùng dạng với webhook Webcake. */
export function posOrderToPayload(order) {
  const address = order.shipping_address || {};
  const items = (Array.isArray(order.items) ? order.items : []).filter(item => !item.is_bonus_product);
  const products = items.map(item => {
    const info = item.variation_info || {};
    const variant = String(info.detail || '').replace(/^phân loại:\s*/i, '').trim()
      || (Array.isArray(info.fields) ? info.fields.map(field => field.value).filter(Boolean).join(' ') : '');
    const price = Number(info.retail_price) || 0;
    return `${String(info.name || '').trim()}${variant ? ` (${variant})` : ''}: ${Math.max(1, Number(item.quantity) || 1)} x ${price.toLocaleString('vi-VN')} ₫`;
  }).join('\n');
  const street = posStreet(order);
  const fullAddress = street !== String(address.address || '').trim() || !address.full_address
    ? [street, address.commune_name, address.district_name, address.province_name].filter(Boolean).join(', ')
    : String(address.full_address).trim();
  return {
    name: String(order.bill_full_name || address.full_name || '').trim(),
    phone: String(order.bill_phone_number || address.phone_number || '').trim(),
    address: fullAddress,
    products,
    total: Number(order.total_price) || 0,
    status: order.is_abandoned_order ? 'Form chưa hoàn tất' : 'Form hoàn tất',
    inserted_at: posTimeToWebcake(order.inserted_at),
    location: String(order.link || ''),
    utm_source: order.p_utm_source || '',
    utm_medium: order.p_utm_medium || '',
    utm_campaign: order.p_utm_campaign || '',
    utm_content: order.p_utm_content || '',
    utm_term: order.p_utm_term || '',
    note: String(order.note || '').split(/\r?\n/).filter(line => !/^(address|link|IP|Order ID):/i.test(line.trim())).join('\n').trim()
  };
}

export function isLandingPosOrder(order) {
  return LANDING_SOURCES.test(String(order.order_sources_name || '')) || /giotnang\.vn/i.test(String(order.link || ''));
}

/**
 * Kéo đơn POS tạo trong `sinceHours` giờ gần nhất (mặc định 48) và ghi vào
 * CRM theo thứ tự khách gửi (cũ trước) để bản hoàn tất đè lên bản dở dang.
 * Trả về thống kê. Không ném lỗi mạng: log rồi thử lại ở lần sau.
 */
export async function syncPosLandingOrders({ sinceHours = 48, config = posConfig(), fetchImpl = fetch, maxPages = 10 } = {}) {
  const summary = { checked: 0, landing: 0, created: 0, updated: 0, absorbed: 0, skipped: 0, rejected: 0, errors: [] };
  if (!posConfigured(config)) return { ...summary, disabled: true };
  const store = await readLandingStore();
  const knownPosIds = new Set(store.orders.flatMap(order => [order.landing?.posId, ...(order.landing?.posIds || [])]).filter(Boolean).map(String));
  const start = Math.floor((Date.now() - sinceHours * 60 * 60 * 1000) / 1000);
  const end = Math.floor(Date.now() / 1000) + 60;
  const fetched = [];
  for (let page = 1; page <= maxPages; page += 1) {
    let data;
    try {
      data = await posRequest('/orders', { page_size: 100, page_number: page, updateStatus: 'inserted_at', startDateTime: start, endDateTime: end, option_sort: 'inserted_at_desc' }, config, fetchImpl);
    } catch (error) {
      summary.errors.push(error.message);
      break;
    }
    const orders = Array.isArray(data?.data) ? data.data : [];
    fetched.push(...orders);
    if (orders.length < 100 || page >= Number(data?.total_pages || 1)) break;
  }
  fetched.sort((first, second) => String(first.inserted_at || '').localeCompare(String(second.inserted_at || '')) || Number(first.id) - Number(second.id));
  for (const order of fetched) {
    summary.checked += 1;
    if (!isLandingPosOrder(order)) continue;
    summary.landing += 1;
    if (knownPosIds.has(String(order.id))) { summary.skipped += 1; continue; }
    const payload = posOrderToPayload(order);
    const result = await recordLandingOrder(payload, { page: payload.location.split('?')[0], posId: order.id });
    if (result.error) summary.rejected += 1;
    else if (result.created) summary.created += 1;
    else if (result.updated) summary.updated += 1;
    else if (result.absorbed) summary.absorbed += 1;
    else summary.skipped += 1;
  }
  summary.absorbed += await absorbDuplicateOrders();
  return summary;
}

let timer = null;

/** Chạy ngay một lần rồi lặp mỗi 5 phút; chỉ khi POS đã kết nối. */
export function startPosSync({ log = console.log } = {}) {
  const run = async () => {
    try {
      const summary = await syncPosLandingOrders();
      if (summary.disabled) return;
      if (summary.created || summary.updated || summary.absorbed || summary.errors.length) {
        log(`Đồng bộ POS: ${summary.landing} đơn landing trong ${summary.checked} đơn, tạo ${summary.created}, cập nhật ${summary.updated}, gộp ${summary.absorbed}, bỏ qua ${summary.skipped}${summary.rejected ? `, từ chối ${summary.rejected}` : ''}${summary.errors.length ? `, lỗi: ${summary.errors.join('; ')}` : ''}`);
      }
    } catch (error) {
      log(`Đồng bộ POS lỗi: ${error.message}`);
    }
  };
  run();
  timer = setInterval(run, POS_SYNC_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
