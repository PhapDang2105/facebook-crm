import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptContent, renderOrderReceiptImage } from '../app/order-receipt-image.mjs';

const order = {
  id: 'da7aabe2',
  createdAt: Date.UTC(2026, 8, 19, 4, 41),
  name: 'Pháp Đặng',
  phone: '0385805700',
  address: 'Khu phố 6, Phường Đông Hải, Thành phố Phan Rang – Tháp Chàm, Ninh Thuận',
  products: [{ name: 'Granola Túi Nâu vị cacao 350g', quantity: 2, price: 164000, image: '/product-images/khong-co.png' }],
  shippingFee: 0,
  discount: 0,
  gift: 'Miễn phí vận chuyển',
  total: 288000,
  payment: 'COD'
};

test('nội dung phiếu giống thẻ xác nhận trong hộp thư: sản phẩm, giờ đặt, SĐT, thanh toán, giao đến, giá trị đơn', () => {
  const content = receiptContent(order, { merchantName: 'Giọt Nắng Healthy' });
  assert.equal(content.merchantName, 'Giọt Nắng Healthy');
  assert.deepEqual(content.products, [{ name: 'Granola Túi Nâu vị cacao 350g', variant: 'Sản phẩm', quantity: 2, unitPrice: '164.000 đ', image: '/product-images/khong-co.png' }]);
  assert.deepEqual(content.sections.map(section => [section.label, section.value]), [
    ['Đã đặt hàng vào', '11:41 19-09'],
    ['Số điện thoại', '0385805700'],
    ['Đã thanh toán bằng', 'Thanh toán khi giao hàng (COD)'],
    ['Giao hàng đến', 'Pháp Đặng\nKhu phố 6, Phường Đông Hải, Thành phố Phan Rang – Tháp Chàm, Ninh Thuận'],
    ['Quà tặng', 'Miễn phí vận chuyển'],
    ['Giá trị ĐH', '288.000 đ']
  ]);
});

test('vẽ phiếu thành PNG rộng 642px (kể cả viền), nhẹ hơn 500 KB, ảnh sản phẩm không có thì vẫn vẽ', async () => {
  const { default: sharp } = await import('sharp');
  const image = await renderOrderReceiptImage({ ...order, name: 'Anh <Ba> & Chị Tư' }, { merchantName: 'Giọt Nắng Healthy' });
  const meta = await sharp(image).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 642);
  assert.ok(meta.height > 500 && meta.height < 1600, `cao ${meta.height}px`);
  assert.ok(image.length < 500 * 1024, `${image.length} bytes`);
});
