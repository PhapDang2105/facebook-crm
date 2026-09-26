import test from 'node:test';
import assert from 'node:assert/strict';

const { qrTargetUrl, renderQrSvg, renderQrPng, QR_QUIET_ZONE } = await import('../app/qr-image.mjs');

test('liên kết trong QR luôn là /q/<mã> của CRM, không bao giờ là m.me', () => {
  assert.equal(qrTargetUrl('https://fb.giotnang.vn/', 'tmdt-01'), 'https://fb.giotnang.vn/q/tmdt-01');
  assert.throws(() => qrTargetUrl('https://fb.giotnang.vn', 'TMDT 01'), /không hợp lệ/);
});

test('SVG: vuông, có vùng trắng 4 ô, ba ô định vị ở góc, cùng nội dung ra cùng ảnh', () => {
  const svg = renderQrSvg('https://fb.giotnang.vn/q/tmdt-01');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="512" height="512" viewBox="0 0 (\d+) \1"/);
  const total = Number(svg.match(/viewBox="0 0 (\d+)/)[1]);
  // Version 1 là 21 ô; liên kết này cần version lớn hơn nhưng vẫn phải là 21 + 4k.
  assert.equal((total - QR_QUIET_ZONE * 2 - 21) % 4, 0);
  // Ô định vị góc trên trái: hàng 7 ô đen bắt đầu tại (4,4) sau vùng trắng.
  assert.match(svg, /M4 4h7v1h-7z/);
  assert.equal(renderQrSvg('https://fb.giotnang.vn/q/tmdt-01'), svg, 'cùng nội dung phải ra cùng ảnh');
  assert.notEqual(renderQrSvg('https://fb.giotnang.vn/q/tmdt-02'), svg);
});

test('PNG: đúng cạnh yêu cầu, chặn kích thước vô lý', async () => {
  const png = await renderQrPng('https://fb.giotnang.vn/q/tmdt-01', { size: 256 });
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  // IHDR: width ở byte 16-19, height ở 20-23.
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  const tiny = await renderQrPng('x', { size: 1 });
  assert.equal(tiny.readUInt32BE(16), 128, 'nhỏ nhất 128 px để camera còn đọc được');
});
