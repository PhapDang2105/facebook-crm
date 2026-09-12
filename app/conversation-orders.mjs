import { randomUUID } from 'node:crypto';

function text(value, maximum) {
  return String(value || '').trim().slice(0, maximum);
}

function money(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

export function normalizeCustomerOrder(input = {}, { now = Date.now(), id = randomUUID().slice(0, 8) } = {}) {
  const products = Array.isArray(input.products) ? input.products.slice(0, 100).map(item => ({
    name: text(item?.name, 200),
    sku: text(item?.sku, 80),
    variant: text(item?.variant, 120),
    image: text(item?.image, 500),
    weight: Math.max(0, Math.round(Number(item?.weight) || 0)),
    quantity: Math.max(1, Math.round(Number(item?.quantity) || 1)),
    price: money(item?.price)
  })).filter(item => item.name) : [];
  const name = text(input.name, 200);
  const phone = text(input.phone, 40).replace(/[\s.-]/g, '');
  const address = text(input.address, 500);
  if (!name || !phone || !address || !products.length) {
    throw new Error('Đơn hàng cần đủ tên, số điện thoại, địa chỉ và sản phẩm.');
  }
  if (!/^(?:\+?84|0)\d{8,10}$/.test(phone)) throw new Error('Số điện thoại không hợp lệ.');
  const subtotal = products.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const freeShipping = Boolean(input.freeShipping);
  const shippingFee = freeShipping ? 0 : money(input.shippingFee);
  const discount = money(input.discount);
  return {
    id: text(input.id || id, 40).replace(/[^\w-]/g, ''),
    name,
    phone,
    address,
    products,
    status: text(input.status || 'Mới', 80),
    source: text(input.source || 'Facebook', 80),
    payment: text(input.payment || 'COD', 80),
    freeShipping,
    shippingFee,
    discount,
    total: Math.max(0, subtotal + shippingFee - discount),
    note: text(input.note, 1000),
    employee: text(input.employee || 'Bạn', 120),
    createdAt: Number(input.createdAt) || now,
    updatedAt: now
  };
}

export function normalizeChatbotOrder(input = {}, conversation = {}, {
  now = Date.now(),
  id = randomUUID().slice(0, 8),
  sourceMessageId = '',
  deliveryMessageId = ''
} = {}) {
  const items = Array.isArray(input.items) ? input.items.slice(0, 100).map(item => ({
    name: text(item?.name || item?.product, 200),
    quantity: Math.max(1, Math.round(Number(item?.quantity) || 1))
  })).filter(item => item.name) : [];
  const total = money(input.total);
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const averageUnitPrice = totalQuantity ? Math.round(total / totalQuantity) : 0;
  const order = normalizeCustomerOrder({
    name: text(conversation.name || 'Khách Facebook', 200),
    phone: input.phone,
    address: input.address,
    products: items.map(item => ({ ...item, price: averageUnitPrice })),
    status: 'Mới',
    source: 'Facebook',
    payment: 'COD',
    freeShipping: true,
    note: 'Tạo tự động từ xác nhận của chatbot.',
    employee: 'Chatbot AI'
  }, { now, id });
  if (total) order.total = total;
  order.chatbotSourceMessageId = text(sourceMessageId, 200);
  order.automatic = true;
  order.delivery = {
    status: 'sent',
    messageId: text(deliveryMessageId, 200),
    sentAt: now
  };
  return order;
}

export function formatOrderMoney(value) {
  return `${new Intl.NumberFormat('vi-VN').format(Number(value) || 0)}đ`;
}

export function buildCustomerOrderConfirmation(order) {
  const products = order.products.map(item => `• ${item.name} — SL ${item.quantity} × ${formatOrderMoney(item.price)}`).join('\n');
  const payment = order.payment === 'Chuyển khoản' ? 'Chuyển khoản' : 'Thanh toán khi giao hàng (COD)';
  return [
    `XÁC NHẬN ĐƠN ĐẶT HÀNG GIỌT NẮNG #${order.id}`,
    products,
    `📞 Số điện thoại: ${order.phone}`,
    `📍 Giao đến: ${order.name} — ${order.address}`,
    `💳 Thanh toán: ${payment}`,
    `💰 Tổng đơn: ${formatOrderMoney(order.total)}`,
    'Giọt Nắng đã nhận đơn. Bạn vui lòng kiểm tra lại thông tin và phản hồi ngay nếu cần điều chỉnh. Cảm ơn bạn!'
  ].join('\n\n');
}

function splitDeliveryAddress(address) {
  const parts = String(address || '').split(',').map(part => part.trim()).filter(Boolean);
  if (!parts.length) return { street_1: 'Chưa có địa chỉ', city: '—', postal_code: '00000', state: '—', country: 'VN' };
  const street = parts[0];
  const state = parts.length > 1 ? parts[parts.length - 1] : '—';
  const city = parts.length > 2 ? parts[parts.length - 2] : (parts.length > 1 ? parts[parts.length - 1] : '—');
  return { street_1: street, city, postal_code: '00000', state, country: 'VN' };
}

function publicImageUrl(value, baseUrl) {
  const raw = String(value || '').trim();
  if (/^https:\/\//i.test(raw)) return raw;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!raw || !base.startsWith('https://')) return '';
  return `${base}/${raw.replace(/^\/+/, '')}`;
}

/**
 * Builds the Messenger Receipt Template for an order. Messenger renders this as a
 * compact "Xác nhận đơn đặt hàng" bubble that opens the full receipt when tapped.
 * Docs: Messenger Platform → Templates → Receipt Template.
 */
export function buildOrderReceiptPayload(order, { merchantName = 'Giọt Nắng', baseUrl = '', orderUrl = '' } = {}) {
  const subtotal = order.products.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const elements = order.products.slice(0, 100).map(item => {
    const image = publicImageUrl(item.image, baseUrl);
    return {
      title: text(item.name, 80) || 'Sản phẩm',
      subtitle: text(item.variant || item.sku || merchantName, 80),
      quantity: Math.max(1, Math.round(Number(item.quantity) || 1)),
      price: money(item.price),
      currency: 'VND',
      ...(image ? { image_url: image } : {})
    };
  });
  const payload = {
    template_type: 'receipt',
    recipient_name: text(order.name, 80) || 'Khách hàng',
    order_number: String(order.id),
    currency: 'VND',
    payment_method: order.payment === 'Chuyển khoản' ? 'Chuyển khoản' : 'Thanh toán khi giao hàng (COD)',
    timestamp: String(Math.floor((Number(order.createdAt) || Date.now()) / 1000)),
    address: splitDeliveryAddress(order.address),
    summary: {
      subtotal: money(subtotal),
      shipping_cost: money(order.shippingFee),
      total_tax: 0,
      total_cost: money(order.total)
    },
    elements
  };
  if (money(order.discount) > 0) {
    payload.adjustments = [{ name: 'Giảm giá', amount: -money(order.discount) }];
  }
  const url = publicImageUrl(orderUrl, baseUrl);
  if (url) payload.order_url = url;
  return payload;
}
