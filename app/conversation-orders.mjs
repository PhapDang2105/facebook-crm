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
