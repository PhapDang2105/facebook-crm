// Ảnh mã QR cho thẻ cảm ơn: mã hoá đúng liên kết /q/<mã> của CRM để in.
//
// SVG là bản để đưa nhà in (vector, phóng bao nhiêu cũng nét); PNG để xem
// nhanh hay dán vào thiết kế. Mức sửa lỗi Q (khôi phục ~25% ô hỏng) cho thẻ
// giấy dễ xước, vùng trắng 4 ô theo chuẩn QR — thiếu vùng trắng là camera
// đọc chập chờn dù mã in đúng.
import qrcode from 'qrcode-generator';
import sharp from 'sharp';
import { isValidQrCode } from './qr-scans.mjs';

export const QR_QUIET_ZONE = 4;

/** Liên kết mà mã QR mã hoá: luôn là lớp trung gian /q/<mã>, không bao giờ là m.me. */
export function qrTargetUrl(publicBaseUrl, code) {
  if (!isValidQrCode(code)) throw new Error('Mã QR không hợp lệ.');
  return `${String(publicBaseUrl || '').replace(/\/+$/, '')}/q/${code}`;
}

function buildModules(text, errorCorrection = 'Q') {
  const qr = qrcode(0, errorCorrection);
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const rows = [];
  for (let row = 0; row < count; row += 1) {
    const line = [];
    for (let column = 0; column < count; column += 1) line.push(qr.isDark(row, column));
    rows.push(line);
  }
  return rows;
}

/**
 * SVG vuông, viewBox tính theo ô nên `size` chỉ là gợi ý kích thước hiển thị;
 * nhà in phóng theo mm. Mỗi hàng ô đen liền nhau gộp thành một hình chữ nhật
 * để tệp nhỏ và máy in không vẽ khe hở giữa các ô.
 */
export function renderQrSvg(text, { size = 512, errorCorrection = 'Q', quietZone = QR_QUIET_ZONE } = {}) {
  const modules = buildModules(text, errorCorrection);
  const count = modules.length;
  const total = count + quietZone * 2;
  const rects = [];
  for (let row = 0; row < count; row += 1) {
    let column = 0;
    while (column < count) {
      if (!modules[row][column]) { column += 1; continue; }
      let width = 1;
      while (column + width < count && modules[row][column + width]) width += 1;
      rects.push(`M${column + quietZone} ${row + quietZone}h${width}v1h-${width}z`);
      column += width;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="#fff"/>`
    + `<path d="${rects.join('')}" fill="#000"/>`
    + '</svg>';
}

export const QR_PNG_MIN = 128;
export const QR_PNG_MAX = 4096;

/**
 * PNG từ chính SVG trên, cạnh `size` điểm ảnh (300 DPI cho 2,5 cm ≈ 300 px; để dư 1024).
 * SVG đã mang width/height = số điểm ảnh nên render ở mật độ mặc định là ra
 * đúng cỡ; KHÔNG đặt `density` cao hơn — 300 DPI với 4096 px là 17.067 px mỗi
 * cạnh, vượt giới hạn điểm ảnh của sharp và trả lỗi thay vì ảnh.
 */
export async function renderQrPng(text, { size = 1024, errorCorrection = 'Q' } = {}) {
  const pixels = Math.max(QR_PNG_MIN, Math.min(QR_PNG_MAX, Math.round(Number(size) || 1024)));
  const svg = renderQrSvg(text, { size: pixels, errorCorrection });
  return sharp(Buffer.from(svg)).resize(pixels, pixels, { kernel: 'nearest' }).png().toBuffer();
}
