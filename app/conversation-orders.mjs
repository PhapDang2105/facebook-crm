import { randomUUID } from 'node:crypto';
import { toLocalPhone } from './processing/customer-info.mjs';
import { matchProduct, findProductBySku } from './processing/catalog.mjs';
import { priceBasket, unitPriceInBasket } from './processing/pricing.mjs';
import { resolveAddress, resolvedAddressFields } from './processing/locations.mjs';
import { normalizeText } from './processing/catalog.mjs';

/** Hội thoại đến từ phiên livestream: bài viết hay tên quảng cáo có "live", "săn deal". */
// Có bài viết thì chỉ xét BÀI VIẾT đó: tên quảng cáo là quảng cáo khách bấm lần
// nào đó trước (hay mang sang từ hộp thư), không phải bài khách đang bình luận —
// ghép cả hai khiến khách từng bấm quảng cáo "Săn deal hời" rồi bình luận dưới
// bài thường vẫn nhận lời chào live kèm "quà live" (quà chỉ áp dụng cho live).
// Không có bài viết (khách vào thẳng từ quảng cáo) thì mới dùng tên quảng cáo.
export function isLivestreamConversation(conversation = {}) {
  const postText = String(conversation?.post?.message || '').trim();
  const source = postText || String(conversation?.referral?.adTitle || '');
  return /\b(live|livestream|phien live|san deal|phat truc tiep|video truc tiep)\b/i.test(normalizeText(source));
}

function text(value, maximum) {
  return String(value || '').trim().slice(0, maximum);
}

function money(value) {
  // Số thì dùng thẳng. Chuỗi tiền VND hay mang dấu chấm ngăn nghìn ("149.000")
  // mà Number("149.000") ra 149 chứ không phải NaN — sai âm thầm, đơn giá tụt
  // từ 149.000đ xuống 149đ và tổng đơn sai theo. Bỏ ký tự không phải chữ số
  // trước khi đọc, cùng cách với order-edits.mjs và landing-orders.mjs.
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(/\D/g, ''));
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

export function normalizeCustomerOrder(input = {}, { now = Date.now(), id = randomUUID().slice(0, 8) } = {}) {
  const products = Array.isArray(input.products) ? input.products.slice(0, 100).map(item => ({
    name: text(item?.name, 200),
    sku: text(item?.sku, 80),
    variant: text(item?.variant, 120),
    image: text(item?.image, 500),
    weight: Math.max(0, Math.round(Number(item?.weight) || 0)),
    quantity: Math.max(1, Math.round(Number(item?.quantity) || 1)),
    price: money(item?.price),
    // What the customer actually pays per unit once combo pricing applies;
    // `price` stays the list price so the receipt can show the discount.
    paidPrice: money(item?.paidPrice)
  })).filter(item => item.name) : [];
  const name = text(input.name, 200);
  const phone = text(input.phone, 40).replace(/[\s.-]/g, '');
  const address = text(input.address, 500);
  if (!name || !phone || !address || !products.length) {
    throw new Error('Đơn hàng cần đủ tên, số điện thoại, địa chỉ và sản phẩm.');
  }
  // Checked against the real Vietnamese carrier prefixes: the previous pattern
  // let 012/030/051 through, and those orders can never be delivered.
  const localPhone = toLocalPhone(phone);
  if (!localPhone) throw new Error('Số điện thoại không hợp lệ.');
  const subtotal = products.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const freeShipping = Boolean(input.freeShipping);
  const shippingFee = freeShipping ? 0 : money(input.shippingFee);
  const discount = money(input.discount);
  // Ba cấp hành chính chuẩn được đọc ngay từ địa chỉ khách nhắn, để bảng đơn
  // và file xuất kho dùng đúng tên trong danh mục mà không cần ai sửa tay.
  return {
    id: text(input.id || id, 40).replace(/[^\w-]/g, ''),
    name,
    phone: localPhone,
    ...resolvedAddressFields(address),
    products,
    status: text(input.status || 'Mới', 80),
    source: text(input.source || 'Facebook', 80),
    payment: text(input.payment || 'COD', 80),
    freeShipping,
    shippingFee,
    discount,
    total: Math.max(0, subtotal + shippingFee - discount),
    note: text(input.note, 1000),
    // Quà tặng theo bảng quà (miễn ship, bát gáo dừa…): bot và form tạo đơn đều ghi cùng chỗ.
    gift: text(input.gift, 300),
    // Ghi chú và trạng thái nhân viên đặt ở bảng Đơn hàng, giữ qua các lần dựng lại đơn.
    staffNote: text(input.staffNote, 500),
    processingStatus: text(input.processingStatus, 40),
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
  // Each line is resolved against the catalogue (Cài đặt → Sản phẩm) so the
  // order carries the warehouse SKU, weight and the same list price staff see
  // when they build an order by hand.
  const items = Array.isArray(input.items) ? input.items.slice(0, 100).map(item => {
    const product = findProductBySku(item?.code || item?.sku) || matchProduct(item?.name || item?.product);
    return {
      name: text(product?.name || item?.name || item?.product, 200),
      sku: product?.sku || '',
      image: product?.image || '',
      weight: product?.weight || 0,
      quantity: Math.max(1, Math.round(Number(item?.quantity) || 1)),
      price: money(product?.unitPrice)
    };
  }).filter(item => item.name) : [];
  const total = money(input.total);
  const totalQuantityForPricing = items.reduce((sum, item) => sum + item.quantity, 0);
  // Gift and shipping come from the basket's combination in the gift table.
  const priced = priceBasket(items.map(item => ({ sku: item.sku, quantity: item.quantity })));
  const shippingFee = input.shippingFee !== undefined ? money(input.shippingFee) : (priced.priceable ? priced.shippingFee : 0);
  const pricedItems = items.map((item, index) => {
    const product = findProductBySku(item.sku);
    const basketPrice = unitPriceInBasket(product, totalQuantityForPricing) || item.price;
    // The price the customer pays per unit. On an order that still pays
    // shipping, the fee is folded into the first line — the warehouse file
    // and the order table both show 189.000đ for one bag, never 174.000đ.
    const shipShare = index === 0 && shippingFee ? Math.round(shippingFee / item.quantity) : 0;
    return { ...item, paidPrice: basketPrice + shipShare };
  });
  // Every line priced at its own list price, or none of them. Mixing a real unit
  // price with an averaged one makes the receipt add up to a number the customer
  // cannot reconcile, which is worse than an honest average on every line.
  const listed = pricedItems.every(item => item.price > 0);
  const subtotal = pricedItems.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const averageUnitPrice = totalQuantity ? Math.round(total / totalQuantity) : 0;
  // The combo total is the price the customer agreed to. The gap between it and
  // the sum of list prices is the combo discount, shown as its own line rather
  // than silently smeared across the products.
  const comboDiscount = listed && total && subtotal + shippingFee > total ? subtotal + shippingFee - total : 0;
  const order = normalizeCustomerOrder({
    name: text(conversation.name || 'Khách Facebook', 200),
    phone: input.phone,
    address: input.address,
    products: listed ? pricedItems : items.map(item => ({ ...item, price: averageUnitPrice })),
    discount: comboDiscount,
    status: 'Mới',
    source: 'Facebook',
    payment: 'COD',
    freeShipping: shippingFee === 0,
    shippingFee,
    note: 'Tạo tự động từ xác nhận của chatbot.',
    employee: 'Chatbot AI'
  }, { now, id });
  if (total) order.total = total;
  order.gift = text(input.gift ?? (priced.priceable ? priced.gift : ''), 300);
  // Đơn chốt từ phiên livestream (bài/quảng cáo "Săn deal hời", "live tối nay"):
  // địa chỉ mang đầu "(Live) " như nhân viên vẫn ghi tay, để kho và POS biết
  // đơn live (quà live, giá live). Ba cấp tỉnh/huyện/xã đã tách xong trước đó.
  if (isLivestreamConversation(conversation) && order.address && !/^\(live\)/i.test(order.address)) {
    order.address = `(Live) ${order.address}`;
    if (order.street) order.street = `(Live) ${order.street}`;
    order.liveOrder = true;
  } else if (input.trial && order.address && !/^\(freeship\)/i.test(order.address)) {
    // Đơn ưu đãi dùng thử của tin bám đuổi (1 túi miễn ship, do luồng dùng thử
    // đánh dấu): đầu địa chỉ ghi "(Freeship) " để kho và POS biết, kèm ghi chú.
    order.address = `(Freeship) ${order.address}`;
    if (order.street) order.street = `(Freeship) ${order.street}`;
    order.trialFreeShip = true;
    order.note = 'Tạo tự động từ xác nhận của chatbot · Ưu đãi dùng thử bám đuổi (1 túi miễn phí vận chuyển).';
  }
  // Combo 2 túi trong cửa sổ bám đuổi: quà bát gáo dừa ghi rõ để kho/POS đóng kèm.
  if (input.promoGift) {
    order.promoGift = text(input.promoGift, 100);
    order.note = `${order.note ? `${order.note} · ` : 'Tạo tự động từ xác nhận của chatbot · '}Ưu đãi bám đuổi combo 2 túi: tặng ${order.promoGift}.`;
  }
  // What the customer actually typed, next to the standardised address they confirmed.
  order.rawAddress = text(input.rawAddress, 500);
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
    ...(order.gift ? [`🎁 Quà tặng: ${order.gift}`] : []),
    // Đơn bot ghi giá niêm yết từng dòng và giảm combo thành một dòng riêng: nói rõ để khách cộng lại được.
    ...(Number(order.discount) > 0 ? [`🏷️ Giảm giá: -${formatOrderMoney(order.discount)}`] : []),
    `💰 Tổng đơn: ${formatOrderMoney(order.total)}`,
    'Giọt Nắng đã nhận đơn. Bạn vui lòng kiểm tra lại thông tin và phản hồi ngay nếu cần điều chỉnh. Cảm ơn bạn!'
  ].join('\n\n');
}

function splitDeliveryAddress(address) {
  const raw = String(address || '').trim();
  if (!raw) return { street_1: 'Chưa có địa chỉ', city: '—', postal_code: '00000', state: '—', country: 'VN' };
  const location = resolveAddress(raw);
  const street = [location.street, location.ward?.name].filter(Boolean).join(', ') || raw;
  return {
    street_1: street.slice(0, 200),
    city: location.district?.name || location.province?.name || '—',
    postal_code: '00000',
    state: location.province?.name || '—',
    country: 'VN'
  };
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
    // A version query defeats Messenger's cache of an earlier failed fetch of
    // the same picture (the URL was behind the login until the proxy opened it).
    const image = publicImageUrl(item.image, baseUrl).replace(/^(https:\/\/[^?]+)$/, `$1?v=${Number(order.createdAt) || Date.now()}`);
    const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
    const price = money(item.price);
    return {
      // Messenger's receipt view on the phone draws only the title of each
      // line — subtitle, quantity and price fields exist in the payload but
      // are not shown — so quantity and unit price go into the title, one per
      // line, the way the order card in the inbox lays them out.
      title: `${text(item.name, 40) || 'Sản phẩm'}\nSố lượng: ${quantity}\nĐơn giá: ${price.toLocaleString('vi-VN')}đ`.slice(0, 80),
      subtitle: text(item.variant || item.sku || merchantName, 80),
      quantity,
      price,
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
