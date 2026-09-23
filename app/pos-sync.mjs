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
import { readLandingStore, recordLandingOrder } from './landing-orders.mjs';
import { isCrmPushedPosOrder } from './pos-orders.mjs';

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
    // POS chèn vào note các dòng address/link/IP/Order ID và ô lựa chọn của form
    // (select_1: "Combo Bán Chạy…"); chỉ giữ lời khách thật.
    note: String(order.note || '').split(/\r?\n/).filter(line => !/^(address|link|IP|Order ID|select[ _-]?\d*|single ?choice[ _-]?\d*|multiple ?choice[ _-]?\d*)\s*:/i.test(line.trim())).join('\n').trim()
  };
}

export function isLandingPosOrder(order) {
  // Đơn CRM đã đẩy sang POS (custom_id "CRM-…") không phải đơn landing, không kéo ngược về.
  if (isCrmPushedPosOrder(order)) return false;
  return LANDING_SOURCES.test(String(order.order_sources_name || '')) || /giotnang\.vn/i.test(String(order.link || ''));
}

/**
 * Kéo đơn POS tạo trong `sinceHours` giờ gần nhất (mặc định 48) và ghi vào
 * CRM theo thứ tự khách gửi (cũ trước). Mỗi form khách gửi là một đơn riêng
 * (chỉ bản cập nhật của cùng một form mới đè lên nhau); bảng Đơn hàng hiện
 * mọi đơn cùng số điện thoại để nhân viên quyết định. Trả về thống kê. Không
 * ném lỗi mạng: log rồi thử lại ở lần sau.
 */
export async function syncPosLandingOrders({ sinceHours = 48, config = posConfig(), fetchImpl = fetch, maxPages = 10 } = {}) {
  const summary = { checked: 0, landing: 0, created: 0, updated: 0, skipped: 0, rejected: 0, errors: [] };
  if (!posConfigured(config)) return { ...summary, disabled: true };
  const store = await readLandingStore();
  // Đơn CRM đang giữ mỗi mã POS (mã chính và các mã đã gộp).
  const knownByPosId = new Map();
  for (const order of store.orders) {
    for (const posId of [order.landing?.posId, ...(order.landing?.posIds || [])].filter(Boolean)) knownByPosId.set(String(posId), order);
  }
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
    // Đã kéo về rồi thì bỏ qua — trừ khi đơn CRM còn là bản bỏ dở mà POS nay đã
    // hoàn tất (khách gửi xong, Webcake cập nhật chính đơn POS đó): xử lý lại để
    // bản hoàn tất đè lên bản dở, như webhook làm với cùng một form.
    const known = knownByPosId.get(String(order.id));
    if (known && (known.landing?.incomplete !== true || order.is_abandoned_order)) { summary.skipped += 1; continue; }
    const payload = posOrderToPayload(order);
    const result = await recordLandingOrder(payload, { page: payload.location.split('?')[0], posId: order.id });
    if (result.error) summary.rejected += 1;
    else if (result.created) summary.created += 1;
    else if (result.updated) summary.updated += 1;
    else summary.skipped += 1;
  }
  return summary;
}

let timer = null;

/** Chạy ngay một lần rồi lặp mỗi 5 phút; chỉ khi POS đã kết nối. */
export function startPosSync({ log = console.log } = {}) {
  // Lượt trước chưa xong (POS chậm) thì lượt sau bỏ qua, không chạy chồng.
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await syncPosLandingOrders();
      if (summary.disabled) return;
      if (summary.created || summary.updated || summary.errors.length) {
        log(`Đồng bộ POS: ${summary.landing} đơn landing trong ${summary.checked} đơn, tạo ${summary.created}, cập nhật ${summary.updated}, bỏ qua ${summary.skipped}${summary.rejected ? `, từ chối ${summary.rejected}` : ''}${summary.errors.length ? `, lỗi: ${summary.errors.join('; ')}` : ''}`);
      }
    } catch (error) {
      log(`Đồng bộ POS lỗi: ${error.message}`);
    } finally {
      running = false;
    }
  };
  run();
  timer = setInterval(run, POS_SYNC_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
