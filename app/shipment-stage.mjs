// Giai đoạn vận đơn, lời báo khách và ghi chú bảng Đơn hàng. Tách khỏi sapo-tracking.mjs để
// order-notes / chatbot-templates dùng được mà không kéo theo order-facts → landing-orders → order-notes (vòng).
import { shipmentStatusLabel } from './sapo.mjs';

// Như honorific() của chatbot-templates (không import để khỏi vòng).
const honorific = gender => gender === 'male' ? 'anh' : gender === 'female' ? 'chị' : 'anh/chị';

export const SHIPMENT_STAGES = ['created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered'];
const STAGE_LABELS = { created: 'Chờ bên vận chuyển lấy hàng', picked_up: 'Đã lấy hàng', in_transit: 'Đang vận chuyển', out_for_delivery: 'Đang giao hàng', delivered: 'Giao thành công' };
export const STAGE_TEMPLATES = { created: 'SHIPMENT_CREATED', picked_up: 'SHIPMENT_PICKED_UP', in_transit: 'SHIPMENT_IN_TRANSIT', out_for_delivery: 'SHIPMENT_OUT_FOR_DELIVERY', delivered: 'SHIPMENT_DELIVERED' };
const SAPO_STAGE = { pending: 'created', picked_up: 'picked_up', delivering: 'in_transit', retry_delivery: 'out_for_delivery', delivered: 'delivered' };
const STOPPED = new Set(['returning', 'returned', 'cancelled']);
const stageIndex = stage => SHIPMENT_STAGES.indexOf(stage);
export const shipmentStageLabel = stage => STAGE_LABELS[stage] || 'Đã tạo vận đơn';

/** Giai đoạn hiện tại: cao nhất giữa Sapo và hành trình của hãng (carrierStage); null khi hoàn/hủy. */
export function shipmentStage(shipment) {
  if (!shipment || shipment.cancelled || STOPPED.has(shipment.status) || STOPPED.has(shipment.carrierStage)) return null;
  const fromSapo = SAPO_STAGE[shipment.status] || 'created';
  const fromCarrier = SHIPMENT_STAGES.includes(shipment.carrierStage) ? shipment.carrierStage : 'created';
  return stageIndex(fromCarrier) > stageIndex(fromSapo) ? fromCarrier : fromSapo;
}

/** Mốc hành trình SPX (records của spx-tracking.mjs) → giai đoạn. */
export function stageFromSpxRecords(records = []) {
  const text = (Array.isArray(records) ? records : []).map(record => `${record.status || ''} ${record.description || ''}`.toLowerCase());
  if (text.some(line => /(delivered|giao hàng thành công|đã giao hàng|giao thành công)/.test(line) && !/fail|không thành công|thất bại/.test(line))) return 'delivered';
  if (text.some(line => /(return|hoàn hàng|trả hàng về)/.test(line))) return 'returning';
  if (text.some(line => /(out for delivery|on delivery|đang giao|giao hàng cho khách|delivering)/.test(line))) return 'out_for_delivery';
  if (text.some(line => /(sorting|hub|transit|vận chuyển|trung tâm|bưu cục)/.test(line))) return 'in_transit';
  if (text.some(line => /(pickup|picked|lấy hàng)/.test(line))) return 'picked_up';
  return 'created';
}

/** Mẫu mặc định (Cài đặt → Tin nhắn sửa được lời; để trống = tắt giai đoạn đó). */
// Lời theo kiểu tin shop vẫn gửi (03/10): "Dạ," mở đầu, mỗi ý một dòng, ngăn bằng ━━━, kết 💛/🌾.
// Ít icon (chủ shop: nhiều icon trông như AI): chỉ 🏷️ mã vận đơn, 🔎 link tra, một icon cuối câu đầu.
export const DEFAULT_SHIPMENT_TEMPLATES = {
  SHIPMENT_CREATED: "Dạ, Giọt Nắng báo {title} đơn hàng đã được đóng gói và giao cho {carrier} rồi ạ 📦\n━━━━━━━━━━━━\n🏷️ Mã vận đơn: {tracking_number}\n━━━━━━━━━━━━\nTrạng thái: {status}\n━━━━━━━━━━━━\n🔎 Theo dõi hành trình: {tracking_url}{tracking_hint}\n\nEm cảm ơn {title} đã ủng hộ Giọt Nắng, có gì cần hỗ trợ {title} nhắn em nhé ạ 💛",
  SHIPMENT_PICKED_UP: "Dạ, đơn hàng của {title} đã được {carrier} lấy hàng thành công rồi ạ\n━━━━━━━━━━━━\n🏷️ Mã vận đơn: {tracking_number}\n━━━━━━━━━━━━\nTrạng thái: {status}\n\nEm sẽ báo {title} ngay khi đơn bắt đầu giao nha 🌾",
  SHIPMENT_IN_TRANSIT: "Dạ, đơn hàng của {title} đang trên đường vận chuyển tới khu vực của mình rồi ạ\n━━━━━━━━━━━━\n🏷️ Mã vận đơn: {tracking_number}\n━━━━━━━━━━━━\n🔎 Theo dõi hành trình: {tracking_url}\n\n{Title} chờ em thêm chút nha, có gì em báo ngay ạ 🌾",
  SHIPMENT_OUT_FOR_DELIVERY: "Dạ, shipper đang giao đơn hàng tới {title} rồi ạ 🛵\n━━━━━━━━━━━━\n🏷️ Mã vận đơn: {tracking_number}\n\n{Title} để ý điện thoại giúp em nha, em cảm ơn {title} nhiều ạ 💛",
  SHIPMENT_DELIVERED: "Dạ, đơn hàng đã giao thành công tới {title} rồi ạ 🎉\n━━━━━━━━━━━━\n🏷️ Mã vận đơn: {tracking_number}\n\nEm cảm ơn {title} đã tin tưởng ủng hộ Giọt Nắng, chúc {title} ăn ngon miệng ạ. {Title} dùng thấy thế nào nhắn em biết với nha, cần hỗ trợ gì em luôn ở đây ạ 💛"
};

// Lời mặc định cũ (1931224): mẫu còn đúng y lời cũ (chưa ai sửa) được đổi sang lời mới khi đọc cài đặt.
export const LEGACY_SHIPMENT_TEMPLATES = {
  SHIPMENT_CREATED: "Dạ Giọt Nắng báo {title}: đơn hàng của {title} đã được đóng gói và tạo vận đơn {carrier} ạ 📦\nMã vận đơn: {tracking_number}\nTrạng thái: {status}\n{Title} theo dõi hành trình đơn tại: {tracking_url}{tracking_hint}",
  SHIPMENT_PICKED_UP: "Dạ đơn hàng của {title} (mã vận đơn {carrier} {tracking_number}) đã được bên vận chuyển lấy hàng thành công ạ 🚚 Em sẽ báo {title} khi đơn đang được giao nha.",
  SHIPMENT_IN_TRANSIT: "Dạ đơn hàng của {title} (mã vận đơn {tracking_number}) đang trên đường vận chuyển tới khu vực của {title} ạ. {Title} theo dõi hành trình tại: {tracking_url}",
  SHIPMENT_OUT_FOR_DELIVERY: "Dạ đơn hàng của {title} (mã vận đơn {tracking_number}) đang được shipper giao tới {title} ạ 🛵 {Title} để ý điện thoại giúp em nha, cảm ơn {title} nhiều ạ!",
  SHIPMENT_DELIVERED: "Dạ đơn hàng (mã vận đơn {tracking_number}) đã giao thành công tới {title} rồi ạ 🎉 Giọt Nắng cảm ơn {title} đã tin tưởng ủng hộ. {Title} dùng thấy thế nào nhắn em biết với nha, cần hỗ trợ gì em luôn ở đây ạ 💛",
  ORDER_STATUS_SHIPPED: "Dạ em kiểm tra thấy đơn của mình gồm {items}, đặt lúc {ordered_at}, đã giao cho {carrier} với mã vận đơn {tracking_number}, hiện {status} ạ. {Title} theo dõi hành trình đơn tại: {tracking_url}{tracking_hint}"
};

/** Giá trị điền vào mẫu tin vận đơn: {title} {Title} {carrier} {tracking_number} {tracking_url} {status} {tracking_hint}. */
export function shipmentTemplateValues(shipment, gender = '') {
  const title = honorific(gender);
  return {
    title,
    Title: title.charAt(0).toUpperCase() + title.slice(1),
    carrier: shipment.carrier || 'đơn vị vận chuyển',
    tracking_number: shipment.trackingNumber,
    tracking_url: shipment.trackingUrl || '',
    status: shipmentStageLabel(shipmentStage(shipment) || 'created'),
    // J&T hỏi 4 số cuối SĐT khi tra trên web: nhắc khách trước.
    tracking_hint: /J&T/i.test(shipment.carrier || '') ? `\n━━━━━━━━━━━━\nTrang J&T hỏi số điện thoại thì ${title} nhập 4 số cuối SĐT nhận hàng nhé` : ''
  };
}

export function fillShipmentTemplate(template, values) {
  return String(template || '').replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match)
    .replace(/[ \t]+\n/g, '\n').trim();
}

/** Lời báo khách theo mẫu (`templates` = mẫu trong Cài đặt; chưa có mẫu đó thì dùng mặc định). */
export function renderShipmentNotice(shipment, gender = '', templateId = STAGE_TEMPLATES.created, templates = {}) {
  const stored = templates && Object.hasOwn(templates, templateId) ? templates[templateId] : undefined;
  const template = stored === undefined || stored === LEGACY_SHIPMENT_TEMPLATES[templateId] ? DEFAULT_SHIPMENT_TEMPLATES[templateId] : stored;
  if (!String(template || '').trim()) return '';
  return fillShipmentTemplate(template, shipmentTemplateValues(shipment, gender));
}

/** Ghi chú cho bảng Đơn hàng: "ℹ J&T Express 8028… · Đang vận chuyển". */
export function shipmentNote(order) {
  const shipment = order?.shipment;
  if (!shipment?.trackingNumber) return '';
  const stage = shipmentStage(shipment);
  const label = shipment.cancelled ? 'Vận đơn đã hủy' : stage ? shipmentStageLabel(stage) : shipment.statusLabel || shipmentStatusLabel(shipment.status);
  return `ℹ ${shipment.carrier} ${shipment.trackingNumber} · ${label}`;
}
