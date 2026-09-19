// Phiếu xác nhận đơn hàng dạng ảnh, vẽ y hệt thẻ "Xác nhận đơn đặt hàng"
// trong hộp thư CRM (web/styles.css: .conversation-order-card…), ở tỉ lệ 3×
// cho nét: cùng font Roboto, cùng cỡ chữ, màu, khoảng cách, viền bo góc.
// Messenger có thẻ receipt riêng (gửi qua Meta), còn Public API của Pancake
// chỉ gửi được chữ và tệp, nên với hội thoại Pancake phiếu này được gửi như
// ảnh đính kèm sau tin ORDER_CONFIRMATION. Chữ vẽ bằng sharp (Pango) với
// font của dự án, không phụ thuộc font cài trên máy chủ.
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { formatOrderMoney } from './conversation-orders.mjs';
import { findProductBySku, matchProduct } from './processing/catalog.mjs';

const fontsDirectory = path.join(projectRoot, 'web', 'assets', 'fonts');
const productImagesPath = path.join(projectRoot, 'data', 'processed', 'product-images');
const scale = 3;
const dpi = 72 * scale;
const px = value => Math.round(value * scale);

// Số đo lấy từ CSS của thẻ (đơn vị px ở 1×).
const css = {
  width: 250, border: 1, radius: [12, 4, 4, 12], borderColor: '#e1e3e6', rule: '#f0f0f0',
  header: { minHeight: 58, padding: 10, label: { size: 12, line: 19, color: '#90949c' }, name: { size: 17, line: 24, color: '#303642', weight: 600 } },
  body: { padding: 10 },
  product: { image: 70, imageBorder: '#d8d8d8', gap: 10, margin: 5, marginNoImage: 8, name: { size: 14, line: 19, color: '#111', weight: 600 }, meta: { size: 12, line: 18, color: '#8d949e' } },
  info: { marginTop: 8, paddingTop: 9, gap: 7, itemGap: 1, valueGap: 2, label: { size: 12, line: 18, color: '#90949c' }, value: { size: 12, line: 18, color: '#111' } }
};
// Cao tự nhiên của một dòng Pango (px ở 3×) theo cỡ chữ, đo bằng Roboto.
const naturalLine = { 12: 43, 14: 50, 17: 61 };

const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = value => formatOrderMoney(Math.max(0, Math.round(Number(value) || 0))).replace(/đ$/, ' đ');

/** Nội dung phiếu, tách riêng để kiểm thử không cần vẽ. */
export function receiptContent(order, { merchantName = 'Giọt Nắng' } = {}) {
  const items = Array.isArray(order.products) ? order.products : [];
  const products = items.map(item => {
    const catalog = findProductBySku(item.code || item.sku || '') || matchProduct(item.name || '');
    return {
      name: String(item.name || 'Sản phẩm'),
      variant: String(item.variant || 'Sản phẩm'),
      quantity: Math.max(1, Math.round(Number(item.quantity) || 1)),
      unitPrice: money(item.price),
      image: String(item.image || catalog?.image || '')
    };
  });
  const subtotal = items.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0);
  const total = Number(order.total) || Math.max(0, subtotal + (Number(order.shippingFee) || 0) - (Number(order.discount) || 0));
  const at = new Date(Number(order.createdAt) || Date.now());
  const time = at.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
  const day = at.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }).replace('/', '-');
  return {
    heading: 'Xác nhận đơn đặt hàng',
    merchantName,
    products,
    // Cùng thứ tự và cùng chữ đậm/thường như thẻ trong hộp thư.
    sections: [
      { label: 'Đã đặt hàng vào', lines: [{ text: `${time} ${day}`, bold: true }] },
      { label: 'Số điện thoại', lines: [{ text: String(order.phone || 'Chưa có') }] },
      { label: 'Đã thanh toán bằng', lines: [{ text: order.payment === 'Chuyển khoản' ? 'Chuyển khoản' : 'Thanh toán khi giao hàng (COD)' }] },
      { label: 'Giao hàng đến', lines: [{ text: String(order.name || 'Chưa có tên'), bold: true }, { text: String(order.address || 'Chưa có địa chỉ') }] },
      { label: 'Giá trị ĐH', lines: [{ text: money(total), bold: true }] }
    ]
  };
}

/** Vẽ phiếu thành PNG (750px = 250px × 3, cao theo nội dung, góc bo, nền trong suốt quanh thẻ). */
export async function renderOrderReceiptImage(order, options = {}) {
  const { default: sharp } = await import('sharp');
  const content = receiptContent(order, options);
  const width = px(css.width);
  const innerLeft = px(css.border + css.body.padding);
  const innerWidth = width - innerLeft * 2;
  const layers = [];

  /** Một khối chữ theo cỡ/độ dày CSS, xếp trong dòng cao `line` px (1×); trả về chiều cao chiếm chỗ (3×). */
  const text = async ({ text: value, size, line, color, weight = 400, width: boxWidth = innerWidth, top, left = innerLeft }) => {
    const natural = naturalLine[size] || Math.round(size * scale * 1.19);
    const pitch = px(line);
    const fontfile = path.join(fontsDirectory, weight >= 600 ? 'Roboto-SemiBold.ttf' : 'Roboto-Regular.ttf');
    // Cả hai tệp font đều đã nạp vào fontconfig trong tiến trình, nên phải nói
    // rõ độ dày: chỉ đổi fontfile thì Pango vẫn lấy bản Regular.
    const markup = `<span size="${size * 1024}" weight="${weight >= 600 ? '600' : '400'}" foreground="${color}">${escape(value)}</span>`;
    const family = weight >= 600 ? 'Roboto SemiBold' : 'Roboto';
    const buffer = await sharp({ text: { text: markup, font: family, fontfile, width: boxWidth, dpi, rgba: true, spacing: Math.max(0, pitch - natural) } }).png().toBuffer();
    const { height } = await sharp(buffer).metadata();
    const lines = Math.max(1, Math.round((height - naturalLine[size] * 0.86) / pitch) + 1);
    layers.push({ input: buffer, top: Math.round(top + (pitch - natural) / 2 + (natural - naturalLine[size] * 0.86) / 2), left });
    return lines * pitch;
  };
  const rule = (top, left = px(css.border), ruleWidth = width - px(css.border) * 2) => {
    layers.push({ input: { create: { width: ruleWidth, height: px(css.border), channels: 4, background: css.rule } }, top, left });
    return px(css.border);
  };

  // Header: nhãn nhỏ rồi tên Page, canh giữa theo chiều dọc trong 58px.
  const headerContent = css.header.label.line + css.header.name.line;
  let y = px(css.border) + px((css.header.minHeight - headerContent) / 2);
  y += await text({ text: content.heading, ...css.header.label, top: y, width: width - px(css.border + css.header.padding) * 2, left: px(css.border + css.header.padding) });
  y += await text({ text: content.merchantName, ...css.header.name, top: y, width: width - px(css.border + css.header.padding) * 2, left: px(css.border + css.header.padding) });
  y = px(css.border + css.header.minHeight);
  y += rule(y);

  // Sản phẩm: ảnh 70×70 (viền, contain) + tên đậm và ba dòng xám.
  for (const item of content.products) {
    let picture = null;
    const file = item.image.match(/^\/product-images\/([A-Za-z0-9-]+\.(?:png|jpg|webp))$/);
    if (file) {
      try {
        const size = px(css.product.image);
        const inner = size - px(css.border) * 2;
        const photo = await sharp(path.join(productImagesPath, file[1])).resize({ width: inner, height: inner, fit: 'contain', background: '#ffffff' }).png().toBuffer();
        picture = await sharp({ create: { width: size, height: size, channels: 4, background: css.product.imageBorder } })
          .composite([{ input: { create: { width: inner, height: inner, channels: 4, background: '#ffffff' } }, top: px(css.border), left: px(css.border) }, { input: photo, top: px(css.border), left: px(css.border) }])
          .png().toBuffer();
      } catch {
        picture = null;
      }
    }
    y += px(picture ? css.product.margin : css.product.marginNoImage);
    const rowTop = y;
    const textLeft = innerLeft + (picture ? px(css.product.image + css.product.gap) : 0);
    const textWidth = innerWidth - (picture ? px(css.product.image + css.product.gap) : 0);
    let rowText = 0;
    rowText += await text({ text: item.name, ...css.product.name, top: rowTop + rowText, left: textLeft, width: textWidth });
    for (const meta of [`Phân loại: ${item.variant}`, `Số lượng: ${item.quantity}`, `Đơn giá ${item.unitPrice}`]) {
      rowText += await text({ text: meta, ...css.product.meta, top: rowTop + rowText, left: textLeft, width: textWidth });
    }
    if (picture) layers.push({ input: picture, top: rowTop, left: innerLeft });
    y = rowTop + Math.max(picture ? px(css.product.image) : 0, rowText) + px(css.product.margin);
  }

  // Thông tin đơn: kẻ ngăn, từng cặp nhãn xám / giá trị đen.
  y += px(css.info.marginTop);
  y += rule(y, innerLeft, innerWidth);
  y += px(css.info.paddingTop) - px(css.border);
  for (const [index, section] of content.sections.entries()) {
    y += await text({ text: section.label, ...css.info.label, top: y });
    y += px(css.info.itemGap);
    for (const [lineIndex, line] of section.lines.entries()) {
      if (lineIndex) y += px(css.info.valueGap);
      y += await text({ text: line.text, ...css.info.value, weight: line.bold ? 600 : 400, top: y });
    }
    if (index < content.sections.length - 1) y += px(css.info.gap);
  }
  const height = y + px(css.body.padding + css.border);

  // Khung thẻ: nền trắng, viền 1px, bo góc 12/4/4/12 như CSS; ngoài thẻ trong suốt.
  const [tl, tr, br, bl] = css.radius.map(px);
  const b = px(css.border) / 2;
  const w = width - b;
  const h = height - b;
  const frame = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <path d="M${b + tl} ${b} H${w - tr} A${tr} ${tr} 0 0 1 ${w} ${b + tr} V${h - br} A${br} ${br} 0 0 1 ${w - br} ${h} H${b + bl} A${bl} ${bl} 0 0 1 ${b} ${h - bl} V${b + tl} A${tl} ${tl} 0 0 1 ${b + tl} ${b} Z" fill="#ffffff" stroke="${css.borderColor}" stroke-width="${px(css.border)}"/>
  </svg>`;
  return sharp(Buffer.from(frame)).png().composite(layers).png({ compressionLevel: 9 }).toBuffer();
}
