// Nhân viên sửa đơn ngay trên bảng Xử lý dữ liệu (tên, số điện thoại, địa chỉ,
// số lượng, đơn giá từng dòng). Bản trên server là sự thật cho đơn hệ thống
// (chatbot, landing) nên sửa phải ghi về đây, nếu không lần đồng bộ sau bảng
// lại lấy bản cũ. Địa chỉ mới được tách ba cấp lại và ghi chú xử lý tự cập nhật
// vì order-notes.mjs dựng ghi chú từ chính dữ liệu đơn.
import { resolvedAddressFields } from './processing/locations.mjs';
import { findProductBySku } from './processing/catalog.mjs';
import { priceBasket } from './processing/pricing.mjs';
import { isLivestreamOrder } from './conversation-orders.mjs';

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function money(value) {
  // Giá VND là số nguyên; dấu chấm là phân cách hàng nghìn ("149.000"), không phải thập phân.
  const number = Number(String(value ?? '').replace(/\D/g, ''));
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

/** Giỏ theo SKU + số lượng (không xét giá): đổi số lượng/sản phẩm mới là "giỏ đổi". */
function basketSignature(products) {
  return (Array.isArray(products) ? products : [])
    .map(item => `${String(item?.sku || item?.name || '').trim().toUpperCase()}=${Math.round(Number(item?.quantity) || 0)}`)
    .sort().join('|');
}

const trialGiftText = 'Miễn phí vận chuyển – ưu đãi dùng thử';

/**
 * Tính lại tiền cả đơn theo bộ giá (priceBasket) sau khi nhân viên sửa dòng ở
 * bảng Xử lý dữ liệu — cùng công thức bot dùng khi chốt đơn: giá niêm yết từng
 * dòng, giảm giá = niêm yết − giá combo, phí ship/miễn ship và quà theo bảng
 * quà (quà chỉ khách live theo cờ đơn). Dòng nhân viên đã gõ giá khách trả
 * (`customPrice`) giữ đúng giá đó, không có giảm combo. Trả về false khi giỏ có
 * sản phẩm ngoài danh mục hay không định giá được (nơi gọi dùng cách cũ).
 */
function repriceFromCatalog(order, products, { basketChanged }) {
  if (!products.length || !products.every(item => findProductBySku(item?.sku))) return false;
  const priced = priceBasket(products.map(item => ({ sku: item.sku, quantity: item.quantity })), { livestream: isLivestreamOrder(order) });
  if (!priced.priceable) return false;
  const basketUnit = new Map(priced.lines.map(line => [line.sku, line.basketUnitPrice]));
  // Đơn dùng thử bám đuổi (1 túi miễn ship) giữ miễn ship của ưu đãi.
  const shippingFee = order.trialFreeShip ? 0 : priced.shippingFee;
  let discount = 0;
  let subtotal = 0;
  products.forEach((item, index) => {
    const product = findProductBySku(item.sku);
    const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
    // Như normalizeChatbotOrder: phí ship gộp vào giá khách trả của dòng đầu.
    const shipShare = index === 0 && shippingFee ? Math.round(shippingFee / quantity) : 0;
    if (item.customPrice) {
      const paid = Number(item.paidPrice) || 0;
      item.price = Math.max(0, paid - shipShare);
      item.paidPrice = paid;
    } else {
      const unit = basketUnit.get(product.sku) || product.unitPrice;
      item.price = product.unitPrice;
      item.paidPrice = unit + shipShare;
      discount += Math.max(0, product.unitPrice - unit) * quantity;
    }
    if (!item.weight && product.weight) item.weight = product.weight;
    subtotal += item.price * quantity;
  });
  order.shippingFee = shippingFee;
  order.freeShipping = shippingFee === 0;
  order.discount = discount;
  order.total = Math.max(0, subtotal + shippingFee - discount);
  if (basketChanged) {
    // Bát ưu đãi bám đuổi chỉ cho combo đúng 2 túi, và không cộng với quà live (đã có bát).
    if (priced.totalQuantity !== 2 || priced.gifts.some(gift => gift.livestreamOnly)) delete order.promoGift;
    order.gift = [order.trialFreeShip && priced.shippingFee > 0 ? trialGiftText : '', priced.gift, order.promoGift || ''].filter(Boolean).join(' + ');
  }
  return true;
}

/**
 * Giá khách trả từng đơn vị (paidPrice) cho đơn sửa từ form (giá dòng + giảm giá +
 * ship riêng): chia giảm giá theo tỷ lệ giá dòng, dòng đầu nhận phí ship và phần
 * làm tròn — Σ paidPrice × số lượng = tổng đơn, như ô Đơn giá của bảng và file kho.
 */
function spreadPaidPrices(order) {
  const products = Array.isArray(order.products) ? order.products : [];
  if (!products.length) return;
  const quantityOf = item => Math.max(1, Math.round(Number(item?.quantity) || 1));
  const listSum = products.reduce((sum, item) => sum + (Number(item.price) || 0) * quantityOf(item), 0);
  const discount = Math.max(0, Number(order.discount) || 0);
  const units = products.map(item => {
    const price = Math.max(0, Number(item.price) || 0);
    return listSum ? Math.max(0, Math.round(price - (discount * price) / listSum)) : price;
  });
  const rest = units.reduce((sum, value, index) => (index ? sum + value * quantityOf(products[index]) : sum), 0);
  units[0] = Math.max(0, Math.round(((Number(order.total) || 0) - rest) / quantityOf(products[0])));
  products.forEach((item, index) => { item.paidPrice = units[index]; });
}

/** Quà ưu đãi bám đuổi (bộ bát gáo dừa) chỉ dành cho combo đúng 2 túi: giỏ khác 2 túi thì bỏ. */
function dropStalePromoGift(order) {
  if (!order.promoGift) return;
  const bags = (Array.isArray(order.products) ? order.products : []).reduce((sum, item) => sum + (Math.round(Number(item?.quantity) || 0)), 0);
  if (bags === 2) return;
  const promo = String(order.promoGift);
  delete order.promoGift;
  if (order.gift) order.gift = String(order.gift).split(' + ').filter(part => part.trim() !== promo).join(' + ');
}

/**
 * Áp các sửa đổi lên một đơn (đổi tại chỗ) và trả về danh sách trường đã đổi.
 * patch: { name?, phone?, address?, lines?: [{ sku?, name?, quantity?, price? }] }
 */
export function applyCustomerOrderEdits(order, patch = {}, now = Date.now()) {
  if (!order || typeof order !== 'object') throw new Error('Không tìm thấy đơn.');
  const changed = [];

  if (patch.name !== undefined) {
    const name = text(patch.name, 120);
    if (!name) throw new Error('Tên khách không được để trống.');
    if (name !== order.name) { order.name = name; changed.push('name'); }
  }

  if (patch.phone !== undefined) {
    const phone = text(patch.phone, 20).replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 9) throw new Error('Số điện thoại không hợp lệ.');
    if (phone !== order.phone) { order.phone = phone; changed.push('phone'); }
  }

  if (patch.address !== undefined) {
    const address = text(patch.address, 500);
    if (!address) throw new Error('Địa chỉ không được để trống.');
    if (address !== order.address) {
      Object.assign(order, resolvedAddressFields(address));
      // Nhân viên đã tự tay ghi địa chỉ: không còn là "máy tự điền" hay "thiếu địa chỉ".
      if (order.landing && typeof order.landing === 'object') {
        order.landing.needsAddress = false;
        if (order.landing.autoFilled?.address) delete order.landing.autoFilled.address;
        if (order.landing.autoFilled && !Object.keys(order.landing.autoFilled).length) delete order.landing.autoFilled;
      }
      changed.push('address');
    }
  }

  if (Array.isArray(patch.lines) && patch.lines.length) {
    const products = Array.isArray(order.products) ? order.products : [];
    const basketBefore = basketSignature(products);
    let linesChanged = false;
    for (const line of patch.lines) {
      const sku = text(line?.sku, 60);
      const name = text(line?.name, 200);
      const product = products.find(item => (sku && String(item?.sku || '') === sku) || (!sku && name && String(item?.name || '') === name));
      if (!product) continue;
      // Đổi sang sản phẩm khác trong danh mục đã cài: đổi SKU và tên, giá tính lại
      // theo bộ giá (repriceFromCatalog); đơn không còn "cần chọn sản phẩm".
      if (line.product !== undefined) {
        const catalogProduct = findProductBySku(line.product);
        if (!catalogProduct) throw new Error('Sản phẩm không có trong danh mục.');
        if (catalogProduct.sku !== product.sku) {
          product.sku = catalogProduct.sku;
          product.name = catalogProduct.name;
          product.matched = true;
          if (catalogProduct.weight) product.weight = catalogProduct.weight;
          // Giá khách trả gõ tay là của sản phẩm cũ: đổi sản phẩm thì tính lại theo bộ giá.
          delete product.customPrice;
          linesChanged = true;
          if (order.landing && typeof order.landing === 'object') {
            order.landing.needsProduct = false;
            if (order.landing.autoFilled?.product) delete order.landing.autoFilled.product;
            if (order.landing.autoFilled && !Object.keys(order.landing.autoFilled).length) delete order.landing.autoFilled;
          }
        }
      }
      if (line.quantity !== undefined) {
        const quantity = Math.max(1, Math.round(Number(line.quantity) || 0));
        if (quantity !== product.quantity) { product.quantity = quantity; linesChanged = true; }
      }
      // Ô Đơn giá của bảng hiện GIÁ KHÁCH TRẢ một đơn vị (paidPrice, đã gồm phần
      // ship gộp vào dòng đầu): số nhân viên gõ là giá khách trả, không phải giá
      // niêm yết — dòng đó không còn giảm combo (không trừ giảm giá lần hai).
      if (line.price !== undefined && String(line.price).trim() !== '') {
        const price = money(line.price);
        const shown = Number(product.paidPrice) || Number(product.price) || 0;
        if (price !== null && price !== shown) {
          product.price = price;
          product.paidPrice = price;
          product.customPrice = true;
          linesChanged = true;
        }
      }
    }
    if (linesChanged) {
      const basketChanged = basketSignature(products) !== basketBefore;
      if (!repriceFromCatalog(order, products, { basketChanged })) {
        // Giỏ có sản phẩm ngoài danh mục (đơn POS mã combo, SKU cũ): giữ cách tính
        // cũ theo giá từng dòng, nhưng giỏ đã đổi thì giảm giá cũ không còn đúng giỏ mới.
        if (basketChanged) order.discount = 0;
        const subtotal = products.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0);
        order.total = Math.max(0, subtotal + (Number(order.shippingFee) || 0) - (Number(order.discount) || 0));
      }
      if (basketChanged) dropStalePromoGift(order);
      changed.push('lines');
    }
  }

  // Sửa đơn từ form Tạo đơn trong hộp thư: thay cả danh sách sản phẩm (thêm/bớt
  // dòng), phí ship, giảm giá, thanh toán, quà, ghi chú khách; tổng tính lại.
  let moneyChanged = false;
  if (Array.isArray(patch.products)) {
    const products = patch.products.slice(0, 100).map(item => ({
      name: text(item?.name, 200),
      sku: text(item?.sku, 80),
      variant: text(item?.variant, 120),
      image: text(item?.image, 500),
      weight: Math.max(0, Math.round(Number(item?.weight) || 0)),
      quantity: Math.max(1, Math.round(Number(item?.quantity) || 1)),
      price: money(item?.price) ?? 0,
      paidPrice: money(item?.price) ?? 0
    })).filter(item => item.name);
    if (!products.length) throw new Error('Đơn cần ít nhất một sản phẩm.');
    if (JSON.stringify(products) !== JSON.stringify(order.products)) { order.products = products; changed.push('products'); moneyChanged = true; }
  }
  if (patch.freeShipping !== undefined) {
    const freeShipping = patch.freeShipping === true;
    if (freeShipping !== Boolean(order.freeShipping)) { order.freeShipping = freeShipping; changed.push('freeShipping'); moneyChanged = true; }
  }
  if (patch.shippingFee !== undefined) {
    const shippingFee = order.freeShipping ? 0 : (money(patch.shippingFee) ?? 0);
    if (shippingFee !== (Number(order.shippingFee) || 0)) { order.shippingFee = shippingFee; changed.push('shippingFee'); moneyChanged = true; }
  }
  if (patch.discount !== undefined) {
    const discount = money(patch.discount) ?? 0;
    if (discount !== (Number(order.discount) || 0)) { order.discount = discount; changed.push('discount'); moneyChanged = true; }
  }
  if (patch.payment !== undefined) {
    const payment = text(patch.payment, 80) || 'COD';
    if (payment !== String(order.payment || '')) { order.payment = payment; changed.push('payment'); }
  }
  if (patch.gift !== undefined) {
    const gift = text(patch.gift, 300);
    if (gift !== String(order.gift || '')) { order.gift = gift; changed.push('gift'); }
  }
  if (patch.note !== undefined) {
    const note = text(patch.note, 1000);
    if (note !== String(order.note || '')) { order.note = note; changed.push('note'); }
  }
  if (moneyChanged) {
    // Form đổi giỏ khác 2 túi: quà bát gáo dừa của ưu đãi bám đuổi không còn (POS/kho khỏi đóng nhầm).
    if (changed.includes('products')) dropStalePromoGift(order);
    const subtotal = (Array.isArray(order.products) ? order.products : []).reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0);
    if (order.freeShipping) order.shippingFee = 0;
    order.total = Math.max(0, subtotal + (Number(order.shippingFee) || 0) - (Number(order.discount) || 0));
    spreadPaidPrices(order);
  }

  // Trạng thái xử lý nhân viên chọn ở cột Trạng thái (mã: calling, callback,
  // transfer, confirmed, cancelled; rỗng là chưa xử lý).
  if (patch.processingStatus !== undefined) {
    const processingStatus = text(patch.processingStatus, 40);
    if (processingStatus !== String(order.processingStatus || '')) {
      order.processingStatus = processingStatus;
      changed.push('processingStatus');
      // Trạng thái hiển thị trên thẻ đơn đi theo: hủy → "Hủy", xác nhận → "Đã xác nhận", bỏ chọn → "Mới".
      if (processingStatus === 'cancelled') order.status = 'Hủy';
      else if (processingStatus === 'confirmed') order.status = 'Đã xác nhận';
      else if (['Hủy', 'Đã xác nhận'].includes(String(order.status || ''))) order.status = 'Mới';
    }
  }

  // Đã bỏ khỏi bảng Đơn hàng (nhân viên xóa dòng / Xóa bảng). Ghi trên máy chủ
  // để máy nào mở CRM cũng không kéo lại đơn này; hoàn tác xóa thì bỏ dấu.
  if (patch.hiddenFromTable !== undefined) {
    const hidden = patch.hiddenFromTable === true;
    if (hidden !== Boolean(order.hiddenFromTable)) {
      if (hidden) { order.hiddenFromTable = true; order.hiddenFromTableAt = now; }
      else { delete order.hiddenFromTable; delete order.hiddenFromTableAt; }
      changed.push('hiddenFromTable');
    }
  }

  // Ghi chú xử lý của nhân viên (cột "Ghi chú xử lý" ở Xử lý dữ liệu): chữ tự
  // do, được xoá trống, không đi vào file xuất kho.
  if (patch.staffNote !== undefined) {
    const staffNote = text(patch.staffNote, 500);
    if (staffNote !== String(order.staffNote || '')) { order.staffNote = staffNote; changed.push('staffNote'); }
  }

  if (changed.length) {
    order.updatedAt = now;
    order.editedByStaffAt = now;
  }
  return changed;
}

/* ---- Ai đã làm gì với đơn (lịch sử ghi ngay trên đơn) ----
 * createdBy { username, name }: người tạo (đơn tạo tay = nhân viên; đơn bot = { 'bot', 'Chatbot AI' }).
 * updatedBy { username, name }: người sửa gần nhất. history: [{ at, by, action, summary }], cũ → mới,
 * tối đa 50 mục. Đơn cũ không có các trường này vẫn đọc bình thường (mảng tạo khi sửa lần đầu).
 */
export const ORDER_HISTORY_LIMIT = 50;

/** Mã trạng thái xử lý (cột Trạng thái của bảng Đơn hàng) → nhãn hiện cho người đọc. */
export const ORDER_STATUS_LABELS = Object.freeze({
  '': 'Chưa xử lý', call1: 'Gọi lần 1', call2: 'Gọi lần 2', call3: 'Gọi lần 3', calling: 'Đang gọi',
  callback: 'Hẹn gọi lại', transfer: 'Chờ chuyển khoản', hold: 'Giữ đơn', confirmed: 'Đã xác nhận', cancelled: 'Khách hủy'
});

const statusLabel = value => ORDER_STATUS_LABELS[String(value || '')] ?? String(value || '');

function stampOf(by) {
  const username = String(by?.username || '').slice(0, 32);
  return { username, name: String(by?.name || username || 'Không rõ').slice(0, 80) };
}

/** Ghi một mục lịch sử lên đơn (đổi tại chỗ) và đặt updatedBy. Trả về mục vừa ghi. */
export function recordOrderHistory(order, { by, action, summary = '', at = Date.now() } = {}) {
  if (!order || typeof order !== 'object') return null;
  const stamp = stampOf(by);
  const entry = { at, by: stamp, action: String(action || 'order.update'), summary: String(summary || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
  const history = Array.isArray(order.history) ? order.history : [];
  history.push(entry);
  order.history = history.slice(-ORDER_HISTORY_LIMIT);
  order.updatedBy = stamp;
  return entry;
}

/** Đặt người tạo cho đơn mới (không đè người tạo đã có), kèm mục lịch sử "tạo đơn". */
export function stampOrderCreated(order, by, { at = Number(order?.createdAt) || Date.now(), summary = '' } = {}) {
  if (!order || typeof order !== 'object') return order;
  if (!order.createdBy) order.createdBy = stampOf(by);
  if (!Array.isArray(order.history) || !order.history.length) {
    order.history = [{ at, by: stampOf(by), action: 'order.create', summary: String(summary || '').slice(0, 200) }];
  }
  return order;
}

const moneyText = value => `${Math.round(Number(value) || 0).toLocaleString('vi-VN')}đ`;
const basketText = products => (Array.isArray(products) ? products : [])
  .map(item => `${Math.round(Number(item?.quantity) || 0)} ${String(item?.name || item?.sku || '').trim()}`)
  .join(' + ').slice(0, 80);

/** Mã hành động nhật ký cho một lần sửa: hủy / đổi trạng thái / ẩn khỏi bảng / sửa đơn. */
export function orderEditAction(changed = [], after = {}) {
  if (changed.includes('processingStatus') && String(after.processingStatus || '') === 'cancelled') return 'order.cancel';
  const rest = changed.filter(field => !['processingStatus', 'hiddenFromTable', 'staffNote'].includes(field));
  if (!rest.length && changed.includes('processingStatus')) return 'order.status';
  if (!rest.length && !changed.includes('staffNote') && changed.includes('hiddenFromTable')) return 'order.hide';
  return 'order.update';
}

/**
 * Câu tóm tắt tiếng Việt cho một lần sửa đơn: trường nào đổi, giá trị trước → sau với những
 * trường đọc được ngay (trạng thái, giỏ, tổng tiền, phí ship, giảm giá, tên). SĐT/địa chỉ chỉ
 * nêu là đã đổi (nhật ký che SĐT; địa chỉ dài).
 */
export function describeOrderEdits(before = {}, after = {}, changed = []) {
  const parts = [];
  const has = field => changed.includes(field);
  if (has('processingStatus')) parts.push(`trạng thái: ${statusLabel(before.processingStatus)} → ${statusLabel(after.processingStatus)}`);
  if (has('lines') || has('products')) parts.push(`giỏ: ${basketText(before.products)} → ${basketText(after.products)}`);
  if (has('name')) parts.push(`tên khách → ${String(after.name || '').slice(0, 40)}`);
  if (has('phone')) parts.push('SĐT');
  if (has('address')) parts.push('địa chỉ');
  if (has('freeShipping')) parts.push(after.freeShipping ? 'miễn ship' : 'bỏ miễn ship');
  if (has('shippingFee')) parts.push(`phí ship ${moneyText(before.shippingFee)} → ${moneyText(after.shippingFee)}`);
  if (has('discount')) parts.push(`giảm giá ${moneyText(before.discount)} → ${moneyText(after.discount)}`);
  if (has('payment')) parts.push(`thanh toán → ${String(after.payment || '').slice(0, 30)}`);
  if (has('gift')) parts.push('quà');
  if (has('note')) parts.push('ghi chú khách');
  if (has('staffNote')) parts.push('ghi chú xử lý');
  if (has('hiddenFromTable')) parts.push(after.hiddenFromTable ? 'ẩn khỏi bảng' : 'hiện lại trong bảng');
  if ((Number(before.total) || 0) !== (Number(after.total) || 0)) parts.push(`tổng ${moneyText(before.total)} → ${moneyText(after.total)}`);
  return parts.join('; ').slice(0, 200);
}
