import test from 'node:test';
import assert from 'node:assert/strict';

// INT-13: ảnh trên đĩa (có sourceKey = đường dẫn + mtime + cỡ) nén một lần rồi dùng lại; ảnh đổi (mtime khác) nén lại.
const { fitImageForPancake, fittedImageCacheSize, pancakeUploadLimit } = await import('../app/pancake.mjs');
const { default: sharp } = await import('sharp');

test('ảnh sản phẩm nén một lần, lần sau lấy từ bộ nhớ; tệp đổi thì nén lại; ảnh không có khoá không nhớ', async () => {
  const noise = Buffer.from(Array.from({ length: 900 * 900 * 3 }, () => Math.floor(Math.random() * 256)));
  const png = await sharp(noise, { raw: { width: 900, height: 900, channels: 3 } }).png().toBuffer();
  assert.ok(png.length > pancakeUploadLimit);
  const source = { buffer: png, filename: 'xanh.png', mime: 'image/png', sourceKey: '/anh/xanh.png|1000|123' };
  const first = await fitImageForPancake(source);
  assert.ok(first.buffer.length <= pancakeUploadLimit);
  assert.equal(fittedImageCacheSize(), 1);
  const second = await fitImageForPancake({ ...source });
  assert.equal(second.buffer, first.buffer, 'cùng bytes đã nén');
  assert.deepEqual([second.filename, second.mime], ['xanh.jpg', 'image/jpeg']);
  second.filename = 'sua.jpg';
  assert.equal((await fitImageForPancake({ ...source })).filename, 'xanh.jpg', 'người gọi sửa bản trả về không làm hỏng bộ nhớ');
  const changed = await fitImageForPancake({ ...source, sourceKey: '/anh/xanh.png|2000|123' });
  assert.notEqual(changed.buffer, first.buffer);
  assert.equal(fittedImageCacheSize(), 2);
  await fitImageForPancake({ buffer: png, filename: 'ngoai.png', mime: 'image/png' });
  assert.equal(fittedImageCacheSize(), 2, 'ảnh tải từ ngoài / đính kèm không nhớ');
});
