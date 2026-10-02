// Nhân viên SỬA đơn trên Pancake POS (đổi SĐT, địa chỉ, sản phẩm, quà, phí ship, tiền thu)
// → chép nội dung mới về đơn CRM tương ứng. Trước 01/10 đồng bộ POS chỉ chép trạng
// thái/hủy: đơn CRM giữ nguyên bản lúc lên đơn dù POS đã sửa.
//
// Cách nhận ra "POS vừa sửa": mỗi lượt đồng bộ ghi dấu nội dung POS lên đơn CRM
// (`order.posContent = { info, items, at }`); lượt sau dấu khác là POS đã đổi. Lần đầu
// gặp một đơn chỉ ghi dấu (CRM và POS ghi cùng nội dung theo hai cách khác nhau — giỏ
// túi lẻ ↔ mã combo — nên không so trực tiếp được), trừ khi SĐT đã khác.
// Thay đổi do chính CRM đẩy sang (nhân viên sửa trong CRM → PUT POS, bổ sung dòng quà
// sau khi tạo) thì chỉ ghi dấu mới, không chép ngược.
import { createHash } from 'node:crypto';
import { findProductBySku, getGifts } from './processing/catalog.mjs';
import { toLocalPhone } from './processing/customer-info.mjs';
import { assignResolvedAddress, recordOrderHistory, staffEditedAt, staffEditedGroups } from './order-edits.mjs';
import { posComboBasket } from './pos-orders.mjs';
import { posOrderToPayload } from './pos-sync.mjs';
import { matchPosStatus } from './pos-status.mjs';

// POS đổi trong khoảng này sau lần CRM sửa/đẩy đơn: coi là thay đổi do CRM gửi sang.
const OWN_PUSH_WINDOW_MS = 3 * 60 * 1000;
export const POS_ACTOR = Object.freeze({ username: 'pos', name: 'Pancake POS' });

const money = value => Math.max(0, Math.round(Number(value) || 0));
const hash = value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const moneyText = value => `${money(value).toLocaleString('vi-VN')}đ`;

/** "2026-10-01T06:12:00.000000" (UTC, POS) → ms. */
export function posTime(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const parsed = Date.parse(text.endsWith('Z') || /[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Tiền khách trả của đơn POS: tiền thu hộ + tiền đã chuyển khoản; POS không ghi thì tiền hàng − giảm + ship. */
export function posPaidTotal(posOrder = {}) {
  const cod = money(posOrder.cod);
  const transfer = money(posOrder.transfer_money);
  if (cod + transfer > 0) return cod + transfer;
  const shipping = posOrder.is_free_shipping ? 0 : money(posOrder.shipping_fee);
  return Math.max(0, money(posOrder.total_price) - money(posOrder.total_discount) + shipping);
}

/** Tiền POS THỰC THU của đơn: thu hộ + đã chuyển khoản. 0 = POS không ghi tiền thu (nơi gọi giữ cách tính cũ). */
export function posCollectedTotal(posOrder = {}) {
  return money(posOrder?.cod) + money(posOrder?.transfer_money);
}

// R13 (C1): nhân viên thêm quà vào đơn POS như một DÒNG HÀNG THƯỜNG có giá (bát 23k, muỗng 17k, quạt + bát live 50k)
// thay vì dòng tặng (is_bonus_product) → CRM cộng giá quà vào tổng đơn (6/33 đơn POS 01–02/10, lệch +226.000đ).
// Mã quà: các mã cố định dưới đây + mọi SKU trong bảng quà (Cài đặt → Quà tặng) KHÔNG phải sản phẩm bán
// (Túi Vàng/Túi Nâu tặng kèm là sản phẩm danh mục: dòng thường của nó vẫn là hàng khách mua).
const POS_GIFT_SKUS = new Set(['BGD', 'M', 'MUONG', 'QUAT', 'QUA', 'QUA-TANG-LIVE']);

/** SKU này là mã quà (không phải hàng bán)? */
export function isPosGiftSku(sku) {
  const code = String(sku || '').trim().toUpperCase();
  if (!code) return false;
  if (POS_GIFT_SKUS.has(code)) return true;
  if (findProductBySku(code)) return false;
  return (getGifts() || []).some(gift => String(gift?.sku || '').trim().toUpperCase() === code);
}

/** Dòng POS là QUÀ: dòng tặng (is_bonus_product) hoặc dòng thường mang mã quà. */
export function isPosGiftItem(item) {
  return Boolean(item?.is_bonus_product) || isPosGiftSku(item?.variation_info?.display_id);
}

/** Các dòng HÀNG của đơn POS (bỏ quà). Đơn chỉ toàn dòng mã quà (gửi bù quà…) thì giữ cách cũ: mọi dòng không phải dòng tặng. */
export function posGoodsItems(posOrder = {}) {
  const items = Array.isArray(posOrder?.items) ? posOrder.items : [];
  const goods = items.filter(item => !isPosGiftItem(item));
  return goods.length ? goods : items.filter(item => !item?.is_bonus_product);
}

/** Các dòng QUÀ của đơn POS (phần còn lại của posGoodsItems). */
export function posGiftItems(posOrder = {}) {
  const goods = new Set(posGoodsItems(posOrder));
  return (Array.isArray(posOrder?.items) ? posOrder.items : []).filter(item => !goods.has(item));
}

/**
 * R13 (C1 + T4): tổng của đơn kéo từ POS = tiền POS thực thu (thu hộ + chuyển khoản) khi POS có ghi; giảm giá
 * tính lại cho khớp (tiền hàng + ship − tổng); tiền đã chuyển khoản ghi vào `prepaid`. POS không ghi tiền thu
 * (cod = 0, không chuyển khoản) thì giữ nguyên tổng nơi gọi đã tính. Trả true nếu tổng đổi.
 */
export function applyPosCollectedTotal(order, posOrder = {}) {
  const paid = posCollectedTotal(posOrder);
  if (!order || !(paid > 0)) return false;
  const before = money(order.total);
  const subtotal = (Array.isArray(order.products) ? order.products : []).reduce((sum, item) => sum + money(item?.price) * Math.max(1, Math.round(Number(item?.quantity) || 1)), 0);
  order.total = paid;
  order.discount = Math.max(0, subtotal + (order.freeShipping ? 0 : money(order.shippingFee)) - paid);
  const transfer = money(posOrder.transfer_money);
  if (transfer > 0) order.prepaid = transfer;
  return before !== paid;
}

const quantityOf = item => Math.max(1, Math.round(Number(item?.quantity) || 1));

/** Tổng theo CÁCH CŨ (trước R13): Σ giá bán lẻ × SL của mọi dòng không phải dòng tặng + ship − giảm giá. */
export function posLegacyLineTotal(posOrder = {}) {
  const goods = (Array.isArray(posOrder?.items) ? posOrder.items : []).filter(item => !item?.is_bonus_product)
    .reduce((sum, item) => sum + money(item?.variation_info?.retail_price) * quantityOf(item), 0);
  const freeShipping = Boolean(posOrder.is_free_shipping) || !Number(posOrder.shipping_fee);
  return Math.max(0, goods + (freeShipping ? 0 : money(posOrder.shipping_fee)) - money(posOrder.total_discount));
}

/**
 * Hoàn tất tiền + quà cho đơn vừa dựng từ một đơn POS gắn hội thoại (importPosConversationOrders):
 * - POS có tiền thu → tổng = tiền thực thu (applyPosCollectedTotal);
 * - POS không ghi tiền thu → giữ đúng tổng cách cũ (kể cả giá dòng mã quà), chỉ đổi cách HIỂN THỊ dòng quà;
 * - dòng quà (dòng tặng + dòng mã quà) → `gift` (chữ) và `giftItems` (mã + SL cho file kho).
 */
export function finalizePosImportedOrder(order, posOrder = {}) {
  if (!order) return order;
  if (!applyPosCollectedTotal(order, posOrder) && !(posCollectedTotal(posOrder) > 0)) order.total = posLegacyLineTotal(posOrder);
  const gifts = posGiftItems(posOrder);
  order.gift = gifts.map(item => String(item?.variation_info?.name || item?.variation_info?.display_id || '').trim()).filter(Boolean).join(' + ').slice(0, 300);
  order.giftItems = posGiftLines(posOrder).giftItems;
  return order;
}

/**
 * Đơn POS đã kéo về TRƯỚC bản sửa R13 còn mang tổng tính theo cách cũ (cộng cả giá quà): chỉnh về tiền POS thực thu.
 * Chỉ chỉnh khi: đơn nguồn POS, POS có tiền thu, tổng đang lưu đúng bằng tổng cách cũ (chưa ai/đồng bộ nào sửa),
 * nhân viên chưa sửa giỏ/tiền trong CRM. Ghi lịch sử đơn. Trả true nếu đã chỉnh.
 */
export function repairPosImportedTotal(existing, fresh, posOrder = {}, { now = Date.now() } = {}) {
  if (!existing || !fresh || String(existing.source || '') !== 'POS') return false;
  const paid = posCollectedTotal(posOrder);
  if (!(paid > 0) || money(existing.total) === paid) return false;
  if (money(existing.total) !== posLegacyLineTotal(posOrder)) return false;
  if (staffEditedGroups(existing).has('basket')) return false;
  const before = money(existing.total);
  existing.products = fresh.products;
  existing.gift = fresh.gift;
  existing.giftItems = fresh.giftItems;
  existing.total = fresh.total;
  existing.discount = fresh.discount;
  if (fresh.prepaid) existing.prepaid = fresh.prepaid;
  existing.updatedAt = now;
  recordOrderHistory(existing, { by: POS_ACTOR, action: 'order.update', summary: `Tổng đơn chỉnh theo tiền thu trên POS: ${moneyText(before)} → ${moneyText(paid)} (quà không tính vào tiền hàng).`, at: now });
  return true;
}

/** Dòng hàng (không tính quà) của đơn POS → dòng sản phẩm CRM; mã combo POS tách lại thành túi lẻ theo danh mục. */
export function posItemsToProducts(posOrder = {}) {
  const products = [];
  for (const item of posGoodsItems(posOrder)) {
    if (item?.is_bonus_product) continue;
    const info = item?.variation_info || {};
    const sku = String(info.display_id || '').trim().toUpperCase();
    const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
    const basket = posComboBasket(sku);
    if (basket) {
      for (const bag of basket) {
        const product = findProductBySku(bag.sku);
        products.push({ name: product?.name || bag.sku, sku: bag.sku, quantity: bag.quantity * quantity, price: money(product?.unitPrice), weight: money(product?.weight) });
      }
      continue;
    }
    const product = sku ? findProductBySku(sku) : null;
    products.push({ name: product?.name || String(info.name || sku || 'Sản phẩm').trim(), sku: product?.sku || sku, quantity, price: money(info.retail_price) || money(product?.unitPrice), weight: money(product?.weight || info.weight) });
  }
  return products;
}

/** Dòng tặng của đơn POS → giftItems + chữ quà. */
export function posGiftLines(posOrder = {}) {
  const giftItems = posGiftItems(posOrder)
    .filter(item => item.variation_info?.display_id)
    .map(item => ({ sku: String(item.variation_info.display_id).trim().toUpperCase(), name: String(item.variation_info.name || ''), quantity: Math.max(1, Math.round(Number(item.quantity) || 1)) }));
  return { giftItems, gift: giftItems.map(item => item.name || item.sku).join(' + ') };
}

/** Phần nội dung đơn POS mà CRM theo dõi, chia hai dấu: thông tin khách/tiền và giỏ hàng/quà. */
export function posContentSignature(posOrder = {}) {
  const payload = posOrderToPayload(posOrder);
  const info = {
    name: payload.name,
    phone: toLocalPhone(payload.phone) || payload.phone,
    address: payload.address,
    shippingFee: posOrder.is_free_shipping ? 0 : money(posOrder.shipping_fee),
    total: posPaidTotal(posOrder)
  };
  const items = (Array.isArray(posOrder.items) ? posOrder.items : [])
    .map(item => `${item?.is_bonus_product ? '+' : ''}${String(item?.variation_info?.display_id || item?.variation_id || '').toUpperCase()}x${Math.round(Number(item?.quantity) || 0)}@${money(item?.variation_info?.retail_price)}`)
    .sort();
  return { info: hash(info), items: hash(items), values: info };
}

/** POS đổi đơn ngay sau lần CRM sửa/đẩy (PUT của chính CRM), không phải nhân viên sửa trên POS. */
function changedByCrmPush(order, posOrder) {
  const posUpdatedAt = posTime(posOrder.updated_at);
  if (!posUpdatedAt) return false;
  // Đơn lên trên POS rồi kéo về (nguồn POS) thì CRM không bao giờ gửi sửa sang.
  if (String(order.source || '') === 'POS' || order.pos?.importedAt || /^pos/i.test(String(order.id || ''))) return false;
  // Đơn CRM tự tạo: lần tạo + bổ sung dòng quà ngay sau đó cũng là CRM ghi. Đơn landing thì không (POS tạo trước).
  const createdByCrm = !order.landing && Number(order.createdAt) || 0;
  const lastCrmWrite = Math.max(Number(order.editedByStaffAt) || 0, Number(order.pos?.at) || 0, Number(order.pos?.updatedAt) || 0, createdByCrm);
  return lastCrmWrite > 0 && posUpdatedAt >= lastCrmWrite - 60 * 1000 && posUpdatedAt - lastCrmWrite <= OWN_PUSH_WINDOW_MS;
}

/**
 * Chép nội dung POS lên một đơn CRM (đổi tại chỗ). Trả về danh sách trường đã đổi
 * ([] = không đổi gì; vẫn có thể đã ghi dấu mới — xem `marked`).
 */
export function applyPosContent(order, posOrder, { now = Date.now() } = {}) {
  const result = { changed: [], marked: false };
  if (!order || !posOrder) return result;
  // Đơn đã hủy/xóa trên POS: phần hủy do đồng bộ trạng thái lo.
  if ([6, 7].includes(Number(posOrder.status))) return result;
  const signature = posContentSignature(posOrder);
  const previous = order.posContent;
  // Dấu kèm giá trị từng trường (`values`): lượt sau chỉ chép trường POS thật sự đổi, không chép
  // lại cả nhóm — đơn landing không PUT sang POS, nhân viên sửa địa chỉ trong CRM rồi POS đổi phí
  // ship thì trước đây địa chỉ bị đè về bản POS.
  const mark = () => {
    if (previous?.info === signature.info && previous?.items === signature.items && previous?.values) return;
    order.posContent = { info: signature.info, items: signature.items, values: signature.values, at: now };
    result.marked = true;
  };
  let infoChanged;
  let itemsChanged;
  if (!previous) {
    // Lần đầu gặp: chỉ chép khi SĐT đã khác (nhân viên đổi số trên POS trước bản này).
    const crmPhone = toLocalPhone(order.phone) || String(order.phone || '');
    infoChanged = Boolean(signature.values.phone) && signature.values.phone !== crmPhone;
    itemsChanged = false;
  } else {
    infoChanged = previous.info !== signature.info;
    itemsChanged = previous.items !== signature.items;
  }
  if ((!infoChanged && !itemsChanged) || changedByCrmPush(order, posOrder)) {
    mark();
    return result;
  }
  const changed = result.changed;
  const values = signature.values;
  // Trường POS có đổi so với lần ghi dấu trước không. Dấu cũ (trước khi có `values`) thì không
  // biết: coi là đổi, trừ khi nhân viên đã sửa nhóm đó trong CRM sau lần ghi dấu (sửa của CRM thắng).
  const known = previous?.values && typeof previous.values === 'object' ? previous.values : null;
  const editedGroups = staffEditedGroups(order);
  // Chỉ nhóm nhân viên THẬT SỰ sửa (staffEdited) mới chặn; ẩn dòng / đổi trạng thái / ghi chú xử lý không
  // chặn chép sửa của POS. Đơn sửa kiểu cũ (chỉ có editedByStaffAt) thì coi như sửa mọi nhóm ở mốc đó.
  const editedAfterMark = group => {
    if (!previous) return false;
    return editedGroups.has(group) && staffEditedAt(order, group) > (Number(previous.at) || 0);
  };
  const posChanged = (field, group) => (known ? known[field] !== values[field] : !editedAfterMark(group));
  if (infoChanged) {
    if (values.name && values.name !== order.name && posChanged('name', 'name')) { order.name = values.name; changed.push('tên'); }
    if (values.phone && values.phone !== (toLocalPhone(order.phone) || order.phone) && (!previous || posChanged('phone', 'phone'))) { order.phone = values.phone; changed.push('SĐT'); }
    if (values.address && values.address !== order.address && posChanged('address', 'address')) { assignResolvedAddress(order, values.address); changed.push('địa chỉ'); }
    const freeShipping = Boolean(posOrder.is_free_shipping) || values.shippingFee === 0;
    if ((values.shippingFee !== money(order.shippingFee) || freeShipping !== Boolean(order.freeShipping)) && posChanged('shippingFee', 'basket')) {
      order.shippingFee = values.shippingFee;
      order.freeShipping = freeShipping;
      changed.push('phí ship');
    }
  }
  if (itemsChanged) {
    const products = posItemsToProducts(posOrder);
    if (products.length) {
      order.products = products;
      changed.push(`sản phẩm (${products.map(item => `${item.quantity} ${item.name}`).join(' + ').slice(0, 80)})`);
    }
    const { giftItems, gift } = posGiftLines(posOrder);
    if (gift !== String(order.gift || '')) { order.gift = gift; changed.push('quà'); }
    order.giftItems = giftItems;
  }
  const total = values.total;
  if (total > 0 && total !== money(order.total) && (itemsChanged || posChanged('total', 'basket'))) {
    order.total = total;
    const subtotal = (order.products || []).reduce((sum, item) => sum + money(item.price) * (Number(item.quantity) || 1), 0);
    order.discount = Math.max(0, subtotal + (order.freeShipping ? 0 : money(order.shippingFee)) - total);
    changed.push(`tổng ${moneyText(total)}`);
  }
  mark();
  if (changed.length) {
    order.updatedAt = now;
    recordOrderHistory(order, { by: POS_ACTOR, action: 'order.update', summary: `Sửa trên Pancake POS: ${changed.join(', ')}.`, at: now });
  }
  return result;
}

/** Chỉ mục đơn POS theo mã POS, mã hệ thống và mã đơn CRM — cùng dạng matchPosStatus đọc. */
export function indexPosOrders(posOrders = []) {
  const byPosId = new Map();
  const bySystemId = new Map();
  const byCrmId = new Map();
  for (const posOrder of posOrders) {
    if (!posOrder) continue;
    if (posOrder.id) byPosId.set(String(posOrder.id), posOrder);
    if (posOrder.system_id) bySystemId.set(String(posOrder.system_id), posOrder);
    const customId = String(posOrder.custom_id || posOrder.id || '');
    if (/^CRM-/i.test(customId)) byCrmId.set(customId.replace(/^CRM-/i, ''), posOrder);
  }
  return { byPosId, bySystemId, byCrmId };
}

/** Đơn này có cần ghi (chưa có dấu, hay dấu khác bản POS vừa đọc) không — để khỏi ghi lại kho mỗi 5 phút. */
export function needsPosContent(order, index) {
  const posOrder = matchPosStatus(order, index);
  if (!posOrder || [6, 7].includes(Number(posOrder.status))) return false;
  const signature = posContentSignature(posOrder);
  // Dấu cũ chưa có `values`: ghi lại một lần để lượt sau so được từng trường.
  return order.posContent?.info !== signature.info || order.posContent?.items !== signature.items || !order.posContent?.values;
}

/** Áp nội dung POS lên đơn trong hội thoại (kho tin nhắn). Trả về số đơn đã đổi nội dung. */
export async function applyPosContentToConversations(posOrders = [], { onChanged = null } = {}) {
  if (!posOrders.length) return 0;
  const index = indexPosOrders(posOrders);
  const { updateMessagingStore } = await import('./messaging-store.mjs');
  const touched = [];
  await updateMessagingStore(store => {
    let writes = 0;
    for (const conversation of store.conversations || []) {
      if (!(conversation.customerOrders || []).some(order => needsPosContent(order, index))) continue;
      const { changedOrders, marked } = applyPosContentToOrders(conversation.customerOrders, index);
      writes += marked;
      if (changedOrders.length) touched.push({ conversationId: conversation.id, orders: changedOrders.map(order => ({ ...order })) });
    }
    return writes;
  }, { unchanged: writes => !writes });
  if (typeof onChanged === 'function') for (const entry of touched) await onChanged(entry);
  return touched.reduce((sum, entry) => sum + entry.orders.length, 0);
}

/** Áp nội dung POS lên một danh sách đơn. Trả về { changedOrders: [đơn đã đổi], marked: số đơn ghi dấu mới }. */
export function applyPosContentToOrders(orders = [], index, { now = Date.now() } = {}) {
  const changedOrders = [];
  let marked = 0;
  for (const order of Array.isArray(orders) ? orders : []) {
    const posOrder = matchPosStatus(order, index);
    if (!posOrder) continue;
    const result = applyPosContent(order, posOrder, { now });
    if (result.changed.length) changedOrders.push(order);
    if (result.marked) marked += 1;
  }
  return { changedOrders, marked };
}
