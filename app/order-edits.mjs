// Nhân viên sửa đơn ngay trên bảng Xử lý dữ liệu (tên, số điện thoại, địa chỉ,
// số lượng, đơn giá từng dòng). Bản trên server là sự thật cho đơn hệ thống
// (chatbot, landing) nên sửa phải ghi về đây, nếu không lần đồng bộ sau bảng
// lại lấy bản cũ. Địa chỉ mới được tách ba cấp lại và ghi chú xử lý tự cập nhật
// vì order-notes.mjs dựng ghi chú từ chính dữ liệu đơn.
import { ADDRESS_PICK_CONFLICT_REASON, resolvedAddressFields } from './processing/locations.mjs';
import { findProductBySku } from './processing/catalog.mjs';
import { priceBasket } from './processing/pricing.mjs';
import { isLivestreamOrder } from './conversation-orders.mjs';
import { toLocalPhoneLoose } from './phone-warnings.mjs';
import { processingNotes } from './order-notes.mjs';

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
export function spreadPaidPrices(order) {
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
 * Ghi địa chỉ mới lên đơn (tách lại ba cấp). R13 (K7): cờ "Ô chọn khác chữ khách gõ" (`addressCheck`, do
 * resolvedAddressFields gắn khi chữ khách gõ và ô chọn của form/POS là hai nơi khác nhau) là của ĐỊA CHỈ CŨ — địa chỉ mới
 * không còn mâu thuẫn thì xoá cờ; trước đây cờ còn lại sau khi nhân viên đã sửa xong địa chỉ. Ghi chú soát khác
 * (bot nhận địa chỉ sau một lần hỏi…) không bị đụng. Trả về các trường vừa ghi.
 */
export function assignResolvedAddress(order, address) {
  const fields = resolvedAddressFields(address);
  Object.assign(order, fields);
  if (!fields.addressCheck && String(order.addressCheck || '').startsWith(ADDRESS_PICK_CONFLICT_REASON)) delete order.addressCheck;
  return fields;
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

  let phoneWarning = '';
  if (patch.phone !== undefined) {
    const normalized = normalizeEditedPhone(patch.phone);
    if (!normalized.phone) throw new Error('Số điện thoại không hợp lệ.');
    const phone = normalized.phone;
    phoneWarning = normalized.warning;
    if (phone !== order.phone) { order.phone = phone; changed.push('phone'); }
  }

  if (patch.address !== undefined) {
    const address = text(patch.address, 500);
    if (!address) throw new Error('Địa chỉ không được để trống.');
    if (address !== order.address) {
      assignResolvedAddress(order, address);
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
    // R13 (L4): dòng không gửi giá (thiếu `price` / để trống) lấy giá danh mục theo SKU — trước đây thành 0đ
    // và cả đơn tụt tổng về 0. Gửi rõ 0 thì vẫn là 0 (dòng tặng).
    const linePrice = item => {
      const blank = item?.price === undefined || item?.price === null || String(item.price).trim() === '';
      const typed = blank ? null : money(item.price);
      return typed ?? (Number(findProductBySku(item?.sku)?.unitPrice) || 0);
    };
    const products = patch.products.slice(0, 100).map(item => ({
      name: text(item?.name, 200),
      sku: text(item?.sku, 80),
      variant: text(item?.variant, 120),
      image: text(item?.image, 500),
      weight: Math.max(0, Math.round(Number(item?.weight) || 0)),
      quantity: Math.max(1, Math.round(Number(item?.quantity) || 1)),
      price: linePrice(item),
      paidPrice: linePrice(item)
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
    // R13 (L2): chỉ nhận mã có trong ORDER_STATUS_LABELS — trước đây giá trị bất kỳ ("khong-co") cũng được lưu.
    if (!Object.hasOwn(ORDER_STATUS_LABELS, processingStatus)) throw new Error('Trạng thái xử lý không hợp lệ.');
    if (processingStatus !== String(order.processingStatus || '')) {
      // R13 (M7): mở lại đơn đã hủy mà bên POS đơn vẫn đang hủy → cảnh báo + cho đẩy lại thành đơn POS mới.
      if (String(order.processingStatus || '') === 'cancelled' && markReopenedAfterPosCancel(order, now)) changed.posReopened = true;
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
    const tracked = isTrackedStaffEdit(order);
    // Đơn đã sửa TRƯỚC khi có `staffEdited` (chỉ có `editedByStaffAt`, không biết sửa nhóm nào): ghi lại mốc
    // đó vào cờ riêng trước khi bắt đầu theo dõi nhóm, để lần sửa này không xoá mất dấu "đã sửa kiểu cũ".
    if (!tracked && Number(order.editedByStaffAt) > 0 && !order.staffEditedLegacyAt) order.staffEditedLegacyAt = Number(order.editedByStaffAt);
    order.updatedAt = now;
    order.editedByStaffAt = now;
    // Nhóm nội dung nhân viên đã tự tay sửa (địa chỉ, giỏ…): bản form hoàn tất đến sau
    // (landing-orders.mjs) không được đè các nhóm này. LUÔN có object `staffEdited` sau mỗi lần sửa:
    // object rỗng = "đã theo dõi, chưa sửa nhóm nội dung nào" (chỉ ẩn dòng / đổi trạng thái / ghi chú xử lý)
    // — trước đây thiếu object thì staffEditedGroups coi là sửa MỌI nhóm và form hoàn tất bị bỏ.
    const staffEdited = tracked ? order.staffEdited : {};
    for (const field of changed) {
      const group = STAFF_EDIT_FIELD_GROUP[field];
      if (group) staffEdited[group] = now;
    }
    order.staffEdited = staffEdited;
  }
  if (phoneWarning) changed.warnings = [phoneWarning];
  return changed;
}

/** Nhóm nội dung đơn nhân viên có thể sửa → các trường của đơn thuộc nhóm đó. */
export const STAFF_EDIT_GROUPS = Object.freeze({
  name: ['name'],
  phone: ['phone'],
  address: ['address', 'street', 'province', 'district', 'ward', 'locationConfidence', 'postMerger'],
  basket: ['products', 'total', 'discount', 'shippingFee', 'freeShipping', 'gift', 'promoGift'],
  payment: ['payment'],
  note: ['note']
});
const STAFF_EDIT_FIELD_GROUP = Object.freeze({
  name: 'name', phone: 'phone', address: 'address', lines: 'basket', products: 'basket', freeShipping: 'basket',
  shippingFee: 'basket', discount: 'basket', gift: 'basket', payment: 'payment', note: 'note'
});

const isTrackedStaffEdit = order => Boolean(order?.staffEdited) && typeof order.staffEdited === 'object' && !Array.isArray(order.staffEdited);

/**
 * Mốc lần sửa "kiểu cũ" của đơn: sửa bằng bản mã trước khi có `staffEdited`, lúc đó MỌI thay đổi (kể cả
 * đổi trạng thái) chỉ để lại `editedByStaffAt`, không biết nhân viên sửa nhóm nào. Nhận ra bằng hai dấu rõ ràng:
 * - đơn có `editedByStaffAt` mà KHÔNG có object `staffEdited` (bản mã mới luôn ghi object này, kể cả rỗng,
 *   nên đơn như vậy chắc chắn chỉ được sửa trước khi lên bản mới);
 * - cờ `staffEditedLegacyAt`: applyCustomerOrderEdits chép mốc cũ vào đây khi đơn kiểu cũ được sửa tiếp.
 * Trả 0 khi đơn không có lần sửa kiểu cũ nào.
 */
export function legacyStaffEditAt(order) {
  const flagged = Number(order?.staffEditedLegacyAt) || 0;
  if (flagged) return flagged;
  return isTrackedStaffEdit(order) ? 0 : Number(order?.editedByStaffAt) || 0;
}

/**
 * Nhóm nội dung nhân viên đã sửa trên đơn: đúng các nhóm ghi trong `staffEdited` (object rỗng = chưa sửa
 * nhóm nào — chỉ ẩn dòng, đổi trạng thái, ghi chú xử lý). Riêng đơn có lần sửa kiểu cũ (legacyStaffEditAt)
 * thì không biết nhóm nào: coi như đã sửa tất cả (an toàn: không đè).
 */
export function staffEditedGroups(order) {
  if (legacyStaffEditAt(order)) return new Set(Object.keys(STAFF_EDIT_GROUPS));
  if (!isTrackedStaffEdit(order)) return new Set();
  return new Set(Object.keys(order.staffEdited).filter(group => STAFF_EDIT_GROUPS[group]));
}

/** Mốc nhân viên sửa nhóm `group` gần nhất (0 = chưa sửa); đơn sửa kiểu cũ thì lấy mốc sửa kiểu cũ. */
export function staffEditedAt(order, group) {
  return Math.max(isTrackedStaffEdit(order) ? Number(order.staffEdited[group]) || 0 : 0, legacyStaffEditAt(order));
}

/**
 * SĐT nhân viên gõ khi sửa đơn/khách: bỏ ký tự thừa, +84/84/0084 → 0, 9 số mất số 0 đầu → thêm 0.
 * Số không giống di động VN (số bàn, gõ nhầm đầu số) vẫn lưu như gõ — chỉ kèm cảnh báo, không chặn.
 * Ít hơn 9 chữ số thì ném lỗi như trước.
 */
export function normalizeEditedPhone(value) {
  const raw = text(value, 20).replace(/[^\d+]/g, '');
  if (!raw) return { phone: '', warning: '' };
  if (raw.replace(/\D/g, '').length < 9) throw new Error('Số điện thoại không hợp lệ.');
  const local = toLocalPhoneLoose(raw);
  if (local) return { phone: local, warning: '' };
  return { phone: raw, warning: `Số ${raw} không giống số di động Việt Nam (đầu số lạ hoặc số bàn): kiểm lại trước khi giao.` };
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

/** 189000 → "189.000đ" (nhật ký, lịch sử đơn, ghi chú xử lý). */
export const moneyText = value => `${Math.round(Number(value) || 0).toLocaleString('vi-VN')}đ`;
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
  if (changed.posReopened) parts.push('đơn đã hủy trên POS — cần lên lại');
  return parts.join('; ').slice(0, 200);
}

/* ---- R13: ghi chú xử lý gắn trên đơn (processingFlags) ----
 * order-notes.mjs dựng ghi chú xử lý TỪ DỮ LIỆU đơn (thiếu địa chỉ, tự điền…). Có những cảnh báo không suy ra
 * được từ dữ liệu (đơn có thể trùng đơn khác, giá landing khác bảng giá, đơn mở lại sau khi POS đã hủy): lưu
 * thẳng trên đơn ở `order.processingFlags` — mảng chuỗi, mỗi chuỗi mở đầu bằng ký hiệu ⚠ / ℹ như ghi chú xử lý.
 */
export const PROCESSING_FLAG_LIMIT = 8;
export const POS_REOPEN_FLAG = '⚠ Đơn đã hủy trên POS — cần lên lại';

/** Thêm một ghi chú xử lý lên đơn (không trùng, tối đa PROCESSING_FLAG_LIMIT). Trả true nếu vừa thêm. */
export function addProcessingFlag(order, flag) {
  const value = String(flag || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!order || typeof order !== 'object' || !value) return false;
  const flags = Array.isArray(order.processingFlags) ? order.processingFlags.filter(item => typeof item === 'string') : [];
  if (flags.includes(value)) return false;
  order.processingFlags = [...flags, value].slice(-PROCESSING_FLAG_LIMIT);
  return true;
}

/** Bỏ các ghi chú xử lý khớp `match` (chuỗi = đúng chuỗi đó; hàm = điều kiện). Trả true nếu có bỏ. */
export function removeProcessingFlag(order, match) {
  if (!order || !Array.isArray(order.processingFlags)) return false;
  const test = typeof match === 'function' ? match : item => item === match;
  const kept = order.processingFlags.filter(item => !test(item));
  if (kept.length === order.processingFlags.length) return false;
  if (kept.length) order.processingFlags = kept; else delete order.processingFlags;
  return true;
}

/**
 * Ghi chú xử lý của đơn: cờ gắn trên đơn (processingFlags) trước, rồi ghi chú dựng từ dữ liệu.
 * R13 (gộp): order-notes.mjs processingNotes đã tự đọc processingFlags và khử trùng — hàm này chỉ còn là tên gọi cũ.
 */
export function orderProcessingNotes(order) {
  return processingNotes(order);
}

/**
 * R13 (M7): mở lại đơn đã hủy trong CRM trong khi đơn bên POS vẫn hủy (`pos.cancelled`). Trước đây đơn về "Mới",
 * không cảnh báo, nút Đẩy POS không làm gì (đơn còn `pos.id`) → đơn sống trong CRM mà không ai giao.
 * Nay: gắn ghi chú xử lý POS_REOPEN_FLAG, đặt `pos.needsRepush` (route Đẩy POS tạo ĐƠN POS MỚI) và
 * `pos.cancelSyncedAt` (đồng bộ POS không hủy lại đơn vừa mở). Trả true nếu đơn thuộc trường hợp này.
 */
export function markReopenedAfterPosCancel(order, now = Date.now()) {
  if (!order?.pos || typeof order.pos !== 'object' || order.pos.cancelled !== true) return false;
  order.pos = { ...order.pos, needsRepush: true, cancelSyncedAt: Number(order.pos.cancelSyncedAt) || now };
  addProcessingFlag(order, POS_REOPEN_FLAG);
  return true;
}

/** Đơn cần lên lại POS (mở lại sau khi POS đã hủy, chưa đẩy lại)? */
export function needsPosRepush(order) {
  return Boolean(order?.pos?.needsRepush) && order.pos.cancelled === true && String(order.processingStatus || '') !== 'cancelled';
}

/**
 * Bản sao đơn để đẩy lại POS thành đơn MỚI: mã "<mã đơn>-L<n>" (POS dùng custom_id "CRM-<mã>" làm mã đơn nên
 * đơn cũ đã hủy còn giữ mã gốc). Trả { order: bản sao không có `pos`, ref: mã dùng trên POS, attempt }.
 */
export function posRepushDraft(order) {
  const attempt = (Math.round(Number(order?.pos?.repushCount)) || 0) + 1;
  const ref = `${order.id}-L${attempt + 1}`;
  const { pos, ...rest } = order;
  return { order: { ...rest, id: ref }, ref, attempt };
}

/** Ghi kết quả đẩy lại (đơn POS mới) lên đơn: bỏ cờ cần lên lại + ghi chú xử lý. */
export function applyPosRepush(order, created, { ref, attempt, now = Date.now() } = {}) {
  const previous = order.pos || {};
  order.pos = { id: String(created.id), systemId: String(created.systemId || ''), status: String(created.status || ''), at: now, crmRef: String(ref || ''), repushCount: attempt, previousId: String(previous.id || '') };
  removeProcessingFlag(order, POS_REOPEN_FLAG);
  // Dấu "Đã hủy trên POS (đồng bộ lúc …)" của lần hủy cũ chặn đồng bộ hủy về sau: đơn POS mới thì bỏ dấu.
  if (order.note) order.note = String(order.note).replace(/\s*Đã hủy trên POS \(đồng bộ lúc [^)]*\)\.?/g, '').trim();
  order.updatedAt = now;
  return order.pos;
}

/** Mã đơn CRM mà một đơn POS "CRM-<mã>" trỏ tới có phải đơn này không (đơn đẩy lại mang mã "<mã>-L<n>" ở pos.crmRef). */
export function posCancelRefOf(order) {
  return String(order?.pos?.crmRef || order?.id || '');
}

/* ---- R13 (L3): kiểm đơn nhân viên tạo tay (form Tạo đơn) sau khi chuẩn hoá ---- */
export function assertManualOrderMoney(order) {
  const subtotal = (Array.isArray(order?.products) ? order.products : []).reduce((sum, item) => sum + (Number(item?.quantity) || 0) * (Number(item?.price) || 0), 0);
  if ((Number(order?.discount) || 0) > subtotal) throw new Error(`Giảm giá (${moneyText(order.discount)}) không được lớn hơn tiền hàng (${moneyText(subtotal)}).`);
  if (!((Number(order?.total) || 0) > 0)) throw new Error('Tổng đơn phải lớn hơn 0đ: kiểm lại đơn giá từng sản phẩm.');
}

/* ---- R13 (M1): chống tạo trùng đơn tay ----
 * Bấm "Tạo đơn" hai lần (mạng chậm, bấm đúp) từng ra 2 đơn CRM và 2 đơn POS. Cùng hội thoại + SĐT + giỏ + tổng
 * trong 2 phút → nơi gọi trả 409 kèm mã đơn cũ; người dùng chắc chắn thì gửi lại kèm `force: true`.
 */
export const MANUAL_ORDER_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

const manualOrderKey = order => `${String(order?.phone || '').replace(/\D/g, '')}|${basketSignature(order?.products)}|${Math.round(Number(order?.total) || 0)}`;

/**
 * Bộ gác đơn tay trùng cho một tiến trình. `find(conversationId, existingOrders, order)` → { id, createdAt } của
 * đơn giống hệt (đơn đã lưu chưa hủy, hoặc đơn ĐANG tạo dở ở request khác — hai request cách nhau < 1 giây cùng
 * đọc kho khi chưa đơn nào kịp lưu) hay null. `reserve` giữ chỗ trước khi lưu, `release` trả chỗ khi tạo lỗi.
 */
export function createManualOrderGuard({ windowMs = MANUAL_ORDER_DUPLICATE_WINDOW_MS, clock = Date.now } = {}) {
  const pending = new Map();
  const sweep = now => { for (const [key, entry] of pending) if (now - entry.createdAt >= windowMs) pending.delete(key); };
  return {
    find(conversationId, existingOrders, order) {
      const now = clock();
      sweep(now);
      const key = manualOrderKey(order);
      const stored = (Array.isArray(existingOrders) ? existingOrders : []).find(entry => entry
        && String(entry.processingStatus || '') !== 'cancelled' && entry.status !== 'Hủy'
        && manualOrderKey(entry) === key
        && Math.abs(now - (Number(entry.createdAt) || 0)) < windowMs);
      if (stored) return { id: String(stored.id), createdAt: Number(stored.createdAt) || now };
      const held = pending.get(`${conversationId}|${key}`);
      return held ? { id: held.id, createdAt: held.createdAt } : null;
    },
    reserve(conversationId, order) {
      pending.set(`${conversationId}|${manualOrderKey(order)}`, { id: String(order.id), createdAt: Number(order.createdAt) || clock() });
    },
    release(conversationId, order) {
      const key = `${conversationId}|${manualOrderKey(order)}`;
      if (pending.get(key)?.id === String(order.id)) pending.delete(key);
    }
  };
}

/** Câu hỏi cho nhân viên khi đơn tay trùng (giao diện hiện đúng câu này kèm nút vẫn tạo). */
export function duplicateManualOrderMessage(duplicate) {
  const time = new Date(Number(duplicate?.createdAt) || Date.now()).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  return `Đơn giống hệt vừa tạo lúc ${time} (mã #${duplicate?.id || '?'}) — vẫn tạo?`;
}

/* ---- R13 (M2): xoá đơn ---- */
/**
 * Đơn đã lên POS mà chưa hủy (xoá ở CRM sẽ để đơn POS sống → vẫn đi kiện)? Chỉ xét đơn mang `pos.id` (đơn CRM đã
 * đẩy sang POS, đơn POS kéo về hội thoại); đơn landing (form Webcake, mã ở landing.posId) xoá như cũ.
 */
export function isLiveOnPos(order) {
  if (!order?.pos?.id) return false;
  if (order.pos?.cancelled === true || String(order.processingStatus || '') === 'cancelled' || order.status === 'Hủy') return false;
  const code = Number(order.posStatus?.code);
  return !(code === 6 || code === 7);
}
