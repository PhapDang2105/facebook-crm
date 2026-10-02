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
import { readLandingStore, recordLandingOrder, updateLandingStore } from './landing-orders.mjs';
import { isCrmPushedPosOrder } from './pos-orders.mjs';
import { applyPosStatusesToConversations, applyPosStatusesToOrders, indexPosStatuses, matchPosStatus, posStatusUpdate } from './pos-status.mjs';
import { applyPosContentToOrders, indexPosOrders, needsPosContent, posGoodsItems } from './pos-content-sync.mjs';

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

/**
 * Số tiền khách trả của đơn POS: `cod` nếu POS có, không thì tiền hàng
 * (total_price) − giảm giá + phí ship. total_price là tiền hàng trước giảm giá,
 * lấy thẳng thì đơn landing combo ghi cao hơn số khách thật trả.
 */
export function posOrderTotal(order = {}) {
  // R13 (T4): khách đã chuyển khoản (một phần hay toàn bộ) thì tiền khách trả = thu hộ + chuyển khoản; trước đây chỉ lấy
  // `cod` nên đơn đặt cọc ghi thiếu phần đã chuyển, đơn chuyển khoản hết (cod = 0) rơi về công thức tiền hàng.
  const positive = value => { const number = Number(value); return value !== undefined && value !== null && value !== '' && Number.isFinite(number) && number > 0 ? number : 0; };
  const paid = positive(order.cod) + positive(order.transfer_money);
  if (paid > 0) return Math.round(paid);
  const goods = Number(order.total_price) || 0;
  const discount = Number(order.total_discount) || 0;
  const shipping = order.is_free_shipping ? 0 : Number(order.shipping_fee) || 0;
  return Math.max(0, Math.round(goods - discount + shipping));
}

/** Một đơn POS → payload cùng dạng với webhook Webcake. */
export function posOrderToPayload(order) {
  const address = order.shipping_address || {};
  // R13 (C1): dòng mã quà (BGD, MUONG, quà live…) nhân viên thêm trên POS như dòng thường không phải hàng khách mua.
  const items = posGoodsItems(order);
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
    total: posOrderTotal(order),
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
export async function syncPosLandingOrders({ sinceHours = 48, config = posConfig(), fetchImpl = fetch, maxPages = 10, onCrmOrdersCancelled = null, onPosConversationOrders = null, onPosStatuses = null, onPosContent = null } = {}) {
  const summary = { checked: 0, landing: 0, created: 0, updated: 0, skipped: 0, rejected: 0, cancelled: 0, conversationOrders: 0, statusUpdated: 0, contentUpdated: 0, errors: [], warnings: [], truncated: false };
  if (!posConfigured(config)) return { ...summary, disabled: true };
  const store = await readLandingStore();
  // Đơn CRM đang giữ mỗi mã POS (mã chính và các mã đã gộp).
  const knownByPosId = new Map();
  for (const order of store.orders) {
    for (const posId of [order.landing?.posId, ...(order.landing?.posIds || [])].filter(Boolean)) knownByPosId.set(String(posId), order);
  }
  const start = Math.floor((Date.now() - sinceHours * 60 * 60 * 1000) / 1000);
  const end = Math.floor(Date.now() / 1000) + 60;
  const fetchWindow = async updateStatus => {
    const list = [];
    for (let page = 1; page <= maxPages; page += 1) {
      let data;
      try {
        data = await posRequest('/orders', { page_size: 100, page_number: page, updateStatus, startDateTime: start, endDateTime: end, option_sort: 'inserted_at_desc' }, config, fetchImpl);
      } catch (error) {
        summary.errors.push(error.message);
        break;
      }
      const orders = Array.isArray(data?.data) ? data.data : [];
      list.push(...orders);
      if (orders.length < 100 || page >= Number(data?.total_pages || 1)) break;
      // R13 (T5): còn trang mà đã chạm trần — trước đây cắt IM LẶNG (đơn cũ hơn trong khoảng giờ không được đồng bộ).
      if (page >= maxPages) {
        summary.truncated = true;
        const total = Number(data?.total_pages) || 0;
        summary.warnings.push(`chạm trần ${maxPages} trang (${list.length} đơn${total ? `, POS báo ${total} trang` : ''}) khi đọc đơn theo ${updateStatus === 'updated_at' ? 'ngày cập nhật' : 'ngày tạo'} trong ${sinceHours} giờ — phần đơn cũ hơn chưa được đồng bộ`);
      }
    }
    return list;
  };
  const fetched = await fetchWindow('inserted_at');
  // Lượt thứ hai: đơn ĐỔI trạng thái trong cùng khoảng giờ dù đặt từ lâu — hủy,
  // hoàn, bom sau 48 giờ. Chỉ dùng để chép trạng thái mới nhất (và hủy đơn CRM
  // theo POS), không tạo đơn landing / đơn hội thoại từ các đơn cũ này.
  const insertedIds = new Set(fetched.map(order => String(order.id)));
  const changedLater = (await fetchWindow('updated_at')).filter(order => !insertedIds.has(String(order.id)));
  fetched.sort((first, second) => String(first.inserted_at || '').localeCompare(String(second.inserted_at || '')) || Number(first.id) - Number(second.id));
  // Đơn CRM đẩy sang POS mà nhân viên hủy ngay trên POS: CRM trước đây vẫn
  // ghi "Mới" (đơn trùng vẫn bị đếm, vẫn hiện chờ xử lý). Gom lại để CRM hủy theo.
  const cancelledCrmIds = [];
  for (const order of changedLater) {
    if (isCrmPushedPosOrder(order) && (Number(order.status) === 6 || /cancel/i.test(String(order.status_name || '')))) {
      cancelledCrmIds.push(String(order.custom_id || order.id).replace(/^CRM-/, ''));
    }
  }
  // Trạng thái mới nhất của mọi đơn POS vừa đọc → đơn CRM tương ứng (landing ở
  // đây, đơn trong hội thoại qua onPosStatuses).
  const statusUpdates = [...fetched, ...changedLater].map(order => posStatusUpdate(order));
  const statusIndex = indexPosStatuses(statusUpdates);
  if ([...knownByPosId.values()].some(order => {
    const update = matchPosStatus(order, statusIndex);
    return update && Number(order.posStatus?.code) !== update.code;
  })) {
    try {
      summary.statusUpdated += await updateLandingStore(current => applyPosStatusesToOrders(current.orders, statusUpdates, statusIndex));
    } catch (error) {
      summary.errors.push(`trạng thái POS của đơn landing: ${error.message}`);
    }
  }
  // Nhân viên SỬA đơn trên POS (SĐT, địa chỉ, giỏ, quà, ship, tiền): chép về đơn landing ở
  // đây, đơn trong hội thoại qua onPosContent. Trước đây chỉ trạng thái được chép.
  const readOrders = [...fetched, ...changedLater];
  const contentIndex = indexPosOrders(readOrders);
  if ([...new Set(knownByPosId.values())].some(order => needsPosContent(order, contentIndex))) {
    try {
      summary.contentUpdated += await updateLandingStore(current => applyPosContentToOrders(current.orders, contentIndex).changedOrders.length);
    } catch (error) {
      summary.errors.push(`nội dung POS của đơn landing: ${error.message}`);
    }
  }
  // Đơn POS gắn một hội thoại Facebook mà KHÔNG do CRM tạo: khách thanh toán qua
  // Facebook Shop (Pancake tự tạo) hay nhân viên lên đơn trong Pancake. Trước đây
  // không kéo về, nên bảng Đơn hàng thiếu (4 ngày 21–25/09: 69 đơn) dù Pancake đã
  // gắn thẻ "Đã mua hàng" cho hội thoại.
  const conversationOrders = [];
  for (const order of fetched) {
    summary.checked += 1;
    if (isCrmPushedPosOrder(order)) {
      if (Number(order.status) === 6 || /cancel/i.test(String(order.status_name || ''))) {
        cancelledCrmIds.push(String(order.custom_id || order.id).replace(/^CRM-/, ''));
      }
      continue;
    }
    if (!isLandingPosOrder(order)) {
      if (order.conversation_id) conversationOrders.push(order);
      continue;
    }
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
  if (conversationOrders.length && typeof onPosConversationOrders === 'function') {
    try {
      summary.conversationOrders = Number(await onPosConversationOrders(conversationOrders)) || 0;
    } catch (error) {
      summary.errors.push(`đơn POS của hội thoại: ${error.message}`);
    }
  }
  if (cancelledCrmIds.length && typeof onCrmOrdersCancelled === 'function') {
    try {
      summary.cancelled = Number(await onCrmOrdersCancelled(cancelledCrmIds)) || 0;
    } catch (error) {
      summary.errors.push(`hủy đơn CRM theo POS: ${error.message}`);
    }
  }
  if (readOrders.length && typeof onPosContent === 'function') {
    try {
      summary.contentUpdated += Number(await onPosContent(readOrders)) || 0;
    } catch (error) {
      summary.errors.push(`nội dung POS của đơn hội thoại: ${error.message}`);
    }
  }
  if (statusUpdates.length && typeof onPosStatuses === 'function') {
    try {
      summary.statusUpdated += Number(await onPosStatuses(statusUpdates)) || 0;
    } catch (error) {
      summary.errors.push(`trạng thái POS của đơn hội thoại: ${error.message}`);
    }
  }
  return summary;
}

// Trạng thái lượt đồng bộ POS gần nhất (GET /api/phone-warnings/pos trả kèm ở `sync`): để cảnh báo chạm trần
// trang và lỗi không chỉ nằm trong log máy chủ.
let lastSyncStatus = { at: 0, ok: null, truncated: false, warnings: [], errors: [], checked: 0 };

/** Ghi trạng thái một lượt đồng bộ (startPosSync và route đồng bộ tay gọi). */
export function recordPosSyncStatus(summary, { at = Date.now(), error = '' } = {}) {
  const errors = [...(Array.isArray(summary?.errors) ? summary.errors : []), ...(error ? [error] : [])].map(item => String(item).slice(0, 300)).slice(0, 10);
  const warnings = (Array.isArray(summary?.warnings) ? summary.warnings : []).map(item => String(item).slice(0, 300)).slice(0, 10);
  lastSyncStatus = { at, ok: !errors.length, truncated: summary?.truncated === true, warnings, errors, checked: Number(summary?.checked) || 0 };
  return lastSyncStatus;
}

export function posSyncStatus() {
  return { ...lastSyncStatus, warnings: [...lastSyncStatus.warnings], errors: [...lastSyncStatus.errors] };
}

let timer = null;

/** Chạy ngay một lần rồi lặp mỗi 5 phút; chỉ khi POS đã kết nối. */
export function startPosSync({ log = console.log, onCrmOrdersCancelled = null, onPosConversationOrders = null, onPosStatuses = applyPosStatusesToConversations, onPosContent = null } = {}) {
  // Lượt trước chưa xong (POS chậm) thì lượt sau bỏ qua, không chạy chồng.
  let running = false;
  let first = true;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      // Lượt đầu sau khi khởi động kéo 7 ngày (bù đơn Facebook trên POS chưa từng kéo về), sau đó 48 giờ.
      const summary = await syncPosLandingOrders({ onCrmOrdersCancelled, onPosConversationOrders, onPosStatuses, onPosContent, ...(first ? { sinceHours: 7 * 24, maxPages: 30 } : {}) });
      first = false;
      if (summary.disabled) return;
      recordPosSyncStatus(summary);
      if (summary.warnings?.length) log(`Đồng bộ POS CẢNH BÁO: ${summary.warnings.join('; ')}`);
      if (summary.created || summary.updated || summary.cancelled || summary.conversationOrders || summary.statusUpdated || summary.contentUpdated || summary.errors.length) {
        log(`Đồng bộ POS: ${summary.landing} đơn landing trong ${summary.checked} đơn, tạo ${summary.created}, cập nhật ${summary.updated}, bỏ qua ${summary.skipped}${summary.conversationOrders ? `, ${summary.conversationOrders} đơn Facebook/nhân viên vào hội thoại` : ''}${summary.cancelled ? `, hủy theo POS ${summary.cancelled} đơn CRM` : ''}${summary.statusUpdated ? `, cập nhật trạng thái POS ${summary.statusUpdated} đơn` : ''}${summary.contentUpdated ? `, chép ${summary.contentUpdated} đơn nhân viên sửa trên POS` : ''}${summary.rejected ? `, từ chối ${summary.rejected}` : ''}${summary.errors.length ? `, lỗi: ${summary.errors.join('; ')}` : ''}`);
      }
    } catch (error) {
      recordPosSyncStatus(null, { error: error.message });
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
