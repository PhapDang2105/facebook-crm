// Nhân viên sửa đơn ngay trên bảng Xử lý dữ liệu (tên, số điện thoại, địa chỉ,
// số lượng, đơn giá từng dòng). Bản trên server là sự thật cho đơn hệ thống
// (chatbot, landing) nên sửa phải ghi về đây, nếu không lần đồng bộ sau bảng
// lại lấy bản cũ. Địa chỉ mới được tách ba cấp lại và ghi chú xử lý tự cập nhật
// vì order-notes.mjs dựng ghi chú từ chính dữ liệu đơn.
import { resolvedAddressFields } from './processing/locations.mjs';
import { findProductBySku } from './processing/catalog.mjs';

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function money(value) {
  // Giá VND là số nguyên; dấu chấm là phân cách hàng nghìn ("149.000"), không phải thập phân.
  const number = Number(String(value ?? '').replace(/\D/g, ''));
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
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
    let linesChanged = false;
    for (const line of patch.lines) {
      const sku = text(line?.sku, 60);
      const name = text(line?.name, 200);
      const product = products.find(item => (sku && String(item?.sku || '') === sku) || (!sku && name && String(item?.name || '') === name));
      if (!product) continue;
      // Đổi sang sản phẩm khác trong danh mục đã cài: đổi SKU và tên, giữ giá
      // đang có (nhân viên sửa giá riêng nếu cần); đơn không còn "cần chọn sản phẩm".
      if (line.product !== undefined) {
        const catalogProduct = findProductBySku(line.product);
        if (!catalogProduct) throw new Error('Sản phẩm không có trong danh mục.');
        if (catalogProduct.sku !== product.sku) {
          product.sku = catalogProduct.sku;
          product.name = catalogProduct.name;
          product.matched = true;
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
      if (line.price !== undefined) {
        const price = money(line.price);
        if (price !== null && price !== product.price) { product.price = price; product.paidPrice = price; linesChanged = true; }
      }
    }
    if (linesChanged) {
      const subtotal = products.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0);
      order.total = Math.max(0, subtotal + (Number(order.shippingFee) || 0) - (Number(order.discount) || 0));
      changed.push('lines');
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
