// Tra đơn ngoài sàn ở trang Vận chuyển (chủ shop 10/10): nhân viên thường chỉ có số điện thoại hay tên khách, không
// có mã vận đơn. Tìm trong đơn CRM — đơn trong hội thoại (bot / nhân viên / POS) và đơn landing — theo SĐT, tên, mã đơn
// hay mã vận đơn; mỗi đơn kèm vận đơn Sapo đã ghép (hãng, mã, giai đoạn) để bấm xem hành trình SPX.
import { customerPhoneKey } from './customer-file.mjs';
import { shipmentStage, shipmentStageLabel } from './shipment-stage.mjs';
import { isCancelledOrder, isIncompleteOrder } from './order-facts.mjs';

const fold = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
const MAX_RESULTS = 30;

function shipmentView(shipment) {
  if (!shipment?.trackingNumber) return null;
  const stage = shipmentStage(shipment);
  return {
    carrier: String(shipment.carrier || ''),
    trackingNumber: String(shipment.trackingNumber),
    trackingUrl: String(shipment.trackingUrl || ''),
    stage: stage || 'stopped',
    stageLabel: stage ? shipmentStageLabel(stage) : (/return/.test(String(shipment.status || shipment.carrierStage || '')) ? 'Hoàn hàng' : 'Đã hủy / dừng'),
    deliveredAt: Number(shipment.deliveredAt) || 0,
    driverPhone: String(shipment.driverPhone || ''),
    isSpx: /SPX/i.test(String(shipment.carrier || '')) || /^SPXVN/i.test(String(shipment.trackingNumber))
  };
}

function orderView(order, { source, name }) {
  const products = (Array.isArray(order.products) ? order.products : [])
    .map(item => `${String(item?.name || item?.sku || '').trim()} ×${Math.max(1, Math.round(Number(item?.quantity) || 1))}`)
    .filter(text => !text.startsWith(' ×'));
  return {
    id: String(order.id || ''),
    source,
    name: String(order.name || name || '').trim(),
    phone: customerPhoneKey(order.phone),
    address: String(order.address || '').trim(),
    createdAt: Number(order.createdAt) || 0,
    total: Number(order.total) || 0,
    products,
    cancelled: isCancelledOrder(order),
    shipment: shipmentView(order.shipment)
  };
}

/**
 * Đơn khớp `query`: SĐT (từ 6 số, khớp đuôi số), mã vận đơn / mã đơn (đúng nguyên mã, không phân biệt hoa thường),
 * hay tên khách (không dấu, chứa cụm gõ vào, từ 3 ký tự). Form landing bỏ dở không phải đơn nên bỏ. Mới nhất trước.
 */
export function lookupShippingOrders(query, { conversations = [], landingOrders = [] } = {}) {
  const text = String(query || '').trim();
  const digits = text.replace(/\D/g, '');
  const isPhone = digits.length >= 6 && digits.length === text.replace(/[\s.+-]/g, '').length;
  const code = text.toUpperCase();
  const folded = fold(text);
  if (!isPhone && folded.length < 3) return [];
  const phoneTail = isPhone ? customerPhoneKey(digits).replace(/^0/, '') : '';
  const matches = order => {
    if (isPhone) return customerPhoneKey(order.phone).endsWith(phoneTail);
    if (String(order.shipment?.trackingNumber || '').toUpperCase() === code || String(order.id || '').toUpperCase() === code) return true;
    return fold(order.name).includes(folded);
  };
  const seen = new Set();
  const results = [];
  for (const conversation of conversations) {
    for (const order of Array.isArray(conversation?.customerOrders) ? conversation.customerOrders : []) {
      if (!order || seen.has(String(order.id)) || isIncompleteOrder(order)) continue;
      const withName = order.name ? order : { ...order, name: conversation.name };
      if (!matches(withName)) continue;
      seen.add(String(order.id));
      results.push(orderView(order, { source: order.landing ? 'Landing page' : (conversation.source === 'comment' ? 'Bình luận' : 'Tin nhắn'), name: conversation.name }));
    }
  }
  for (const order of landingOrders) {
    if (!order || seen.has(String(order.id)) || isIncompleteOrder(order) || !matches(order)) continue;
    seen.add(String(order.id));
    results.push(orderView(order, { source: 'Landing page' }));
  }
  return results.sort((first, second) => second.createdAt - first.createdAt).slice(0, MAX_RESULTS);
}
