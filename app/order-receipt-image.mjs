// Phiếu xác nhận đơn hàng dạng ảnh, bố cục y như thẻ "Xác nhận đơn đặt hàng"
// trong hộp thư CRM: ảnh sản phẩm + tên, phân loại, số lượng, đơn giá; rồi
// giờ đặt, số điện thoại, hình thức thanh toán, giao hàng đến, giá trị đơn.
// Messenger có thẻ receipt riêng (gửi qua Meta), còn Public API của Pancake
// chỉ gửi được chữ và tệp, nên với hội thoại Pancake phiếu được vẽ thành PNG
// rồi gửi như ảnh đính kèm. Chữ vẽ bằng sharp (Pango markup) với font Roboto
// của dự án, không phụ thuộc font cài trên máy chủ.
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { formatOrderMoney } from './conversation-orders.mjs';

const fontsDirectory = path.join(projectRoot, 'web', 'assets', 'fonts');
const productImagesPath = path.join(projectRoot, 'data', 'processed', 'product-images');
const width = 640;
const padding = 32;
const thumbnail = 104;
const border = '#e5e7eb';
const muted = '#6b7280';
const ink = '#111827';

const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = value => formatOrderMoney(Math.max(0, Math.round(Number(value) || 0))).replace(/đ$/, ' đ');

/** Nội dung phiếu, tách riêng để kiểm thử không cần vẽ. */
export function receiptContent(order, { merchantName = 'Giọt Nắng' } = {}) {
  const products = (Array.isArray(order.products) ? order.products : []).map(item => {
    const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
    return {
      name: String(item.name || 'Sản phẩm'),
      variant: String(item.variant || 'Sản phẩm'),
      quantity,
      unitPrice: money(item.price),
      image: String(item.image || '')
    };
  });
  const subtotal = (Array.isArray(order.products) ? order.products : []).reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0);
  const total = Number(order.total) || Math.max(0, subtotal + (Number(order.shippingFee) || 0) - (Number(order.discount) || 0));
  const at = new Date(Number(order.createdAt) || Date.now());
  const time = at.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
  const day = at.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }).replace('/', '-');
  return {
    heading: 'Xác nhận đơn đặt hàng',
    merchantName,
    products,
    sections: [
      { label: 'Đã đặt hàng vào', value: `${time} ${day}` },
      { label: 'Số điện thoại', value: String(order.phone || '') },
      { label: 'Đã thanh toán bằng', value: order.payment === 'Chuyển khoản' ? 'Chuyển khoản' : 'Thanh toán khi giao hàng (COD)' },
      { label: 'Giao hàng đến', value: [order.name, order.address].filter(Boolean).join('\n') },
      ...(Number(order.shippingFee) > 0 ? [{ label: 'Phí vận chuyển', value: money(order.shippingFee) }] : []),
      ...(order.gift ? [{ label: 'Quà tặng', value: String(order.gift) }] : []),
      { label: 'Giá trị ĐH', value: money(total) }
    ]
  };
}

/** Vẽ phiếu thành PNG (rộng 640px, cao theo nội dung). */
export async function renderOrderReceiptImage(order, options = {}) {
  const { default: sharp } = await import('sharp');
  const content = receiptContent(order, options);
  const textWidth = width - padding * 2;
  const block = async (text, { font = 'Roboto-Regular.ttf', dpi = 110, width: blockWidth = textWidth } = {}) => {
    const buffer = await sharp({ text: { text, font: 'Roboto', fontfile: path.join(fontsDirectory, font), width: blockWidth, dpi, rgba: true } }).png().toBuffer();
    const { height } = await sharp(buffer).metadata();
    return { buffer, height };
  };
  const layers = [];
  let top = padding;
  const place = (layer, left, gap = 0) => {
    layers.push({ input: layer.buffer, top, left });
    top += layer.height + gap;
  };
  const rule = () => {
    layers.push({ input: { create: { width: textWidth, height: 1, channels: 3, background: border } }, top, left: padding });
    top += 1 + 18;
  };

  place(await block(`<span foreground="${muted}">${escape(content.heading)}</span>`, { dpi: 100 }), padding, 6);
  place(await block(escape(content.merchantName), { font: 'Roboto-Bold.ttf', dpi: 150 }), padding, 18);
  rule();
  for (const item of content.products) {
    let picture = null;
    const file = item.image.match(/^\/product-images\/([A-Za-z0-9-]+\.(?:png|jpg|webp))$/);
    if (file) {
      try {
        picture = await sharp(path.join(productImagesPath, file[1])).resize({ width: thumbnail, height: thumbnail, fit: 'cover' }).png().toBuffer();
      } catch {
        picture = null;
      }
    }
    const textLeft = padding + (picture ? thumbnail + 18 : 0);
    const details = await block(
      `<span foreground="${ink}"><b>${escape(item.name)}</b></span>\n<span foreground="${muted}">Phân loại: ${escape(item.variant)}\nSố lượng: ${item.quantity}\nĐơn giá: ${escape(item.unitPrice)}</span>`,
      { font: 'Roboto-Medium.ttf', dpi: 112, width: width - textLeft - padding }
    );
    if (picture) layers.push({ input: picture, top, left: padding });
    layers.push({ input: details.buffer, top, left: textLeft });
    top += Math.max(picture ? thumbnail : 0, details.height) + 18;
  }
  rule();
  for (const [index, section] of content.sections.entries()) {
    place(await block(`<span foreground="${muted}">${escape(section.label)}</span>`, { dpi: 100 }), padding, 4);
    place(await block(`<span foreground="${ink}">${escape(section.value)}</span>`, { font: 'Roboto-Bold.ttf', dpi: 112 }), padding, index === content.sections.length - 1 ? 0 : 16);
  }
  const height = top + padding;
  const card = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).composite(layers).png().toBuffer();
  // Viền mảnh quanh thẻ.
  return sharp({ create: { width: width + 2, height: height + 2, channels: 3, background: border } })
    .composite([{ input: card, top: 1, left: 1 }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}
