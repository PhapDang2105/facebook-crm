import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCustomerOrderEdits } from '../app/order-edits.mjs';
import { processingNotes } from '../app/order-notes.mjs';
import { getCatalogProducts } from '../app/processing/catalog.mjs';

await import('./helpers/seed-catalog.mjs');

test('đổi sản phẩm sang mã khác trong danh mục: đổi SKU và tên, giữ giá, bỏ cờ cần chọn sản phẩm', () => {
  const [first, second] = getCatalogProducts();
  assert.ok(first && second, 'danh mục thử phải có ít nhất hai sản phẩm');
  const order = sample();
  order.products = [{ name: 'Chưa rõ sản phẩm (kiểm tra form landing)', sku: first.sku, quantity: 2, price: 149000 }];
  order.landing.needsProduct = true;
  order.landing.autoFilled.product = 'Granola Túi Xanh 450g x2 (mặc định theo chiến dịch)';
  const changed = applyCustomerOrderEdits(order, { lines: [{ sku: first.sku, product: second.sku }] });
  assert.deepEqual(changed, ['lines']);
  assert.equal(order.products[0].sku, second.sku);
  assert.equal(order.products[0].name, second.name);
  assert.equal(order.products[0].price, 149000, 'giá giữ nguyên, nhân viên sửa riêng nếu cần');
  assert.equal(order.landing.needsProduct, false);
  assert.equal(order.landing.autoFilled.product, undefined);
  assert.throws(() => applyCustomerOrderEdits(sample(), { lines: [{ sku: 'GRA-XANH-Z450', product: 'KHONG-CO' }] }), /danh mục/);
});

const sample = () => ({
  id: 'abc12345',
  name: 'Khách landing page',
  phone: '0901234567',
  address: 'Quảng Bình',
  street: '',
  ward: '',
  district: '',
  province: 'Quảng Bình',
  locationConfidence: 'partial',
  products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1, price: 189000 }],
  shippingFee: 0,
  discount: 0,
  total: 189000,
  landing: { needsAddress: true, autoFilled: { address: '12 Lê Lợi (từ POS)' } }
});

test('sửa địa chỉ: tách lại ba cấp, bỏ cờ thiếu/tự điền, ghi chú xử lý tự hết', () => {
  const order = sample();
  assert.deepEqual(processingNotes(order), ['⚠ Thiếu số nhà, phường/xã, quận/huyện', '🤖 Tự điền địa chỉ: 12 Lê Lợi (từ POS)']);
  const changed = applyCustomerOrderEdits(order, { address: '12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP.HCM' }, 1000);
  assert.deepEqual(changed, ['address']);
  assert.equal(order.street, '12 Nguyễn Huệ');
  assert.deepEqual([order.ward, order.district, order.province], ['Phường Bến Nghé', 'Quận 1', 'TP Hồ Chí Minh']);
  assert.equal(order.locationConfidence, 'exact');
  assert.equal(order.landing.needsAddress, false);
  assert.equal(order.landing.autoFilled, undefined);
  assert.deepEqual(processingNotes(order), []);
  assert.equal(order.updatedAt, 1000);
});

test('sửa tên, số điện thoại, số lượng và đơn giá từng dòng; tổng tính lại', () => {
  const order = sample();
  const changed = applyCustomerOrderEdits(order, {
    name: '  Nguyễn  Văn A ', phone: '0987 654 321',
    lines: [{ sku: 'GRA-XANH-Z450', quantity: '3', price: '149.000' }]
  });
  assert.deepEqual(changed, ['name', 'phone', 'lines']);
  assert.equal(order.name, 'Nguyễn Văn A');
  assert.equal(order.phone, '0987654321');
  assert.equal(order.products[0].quantity, 3);
  assert.equal(order.products[0].price, 149000);
  assert.equal(order.total, 447000);
  // Không đổi gì thì không ghi dấu sửa.
  assert.deepEqual(applyCustomerOrderEdits(sample(), { name: 'Khách landing page' }), []);
});

test('từ chối tên trống, số điện thoại ngắn, địa chỉ trống', () => {
  assert.throws(() => applyCustomerOrderEdits(sample(), { name: '  ' }), /Tên khách/);
  assert.throws(() => applyCustomerOrderEdits(sample(), { phone: '12345' }), /Số điện thoại/);
  assert.throws(() => applyCustomerOrderEdits(sample(), { address: '' }), /Địa chỉ/);
});

test('ghi chú xử lý của nhân viên: lưu, cắt 500 ký tự, xoá trống được, không đổi gì khác', () => {
  const order = sample();
  assert.deepEqual(applyCustomerOrderEdits(order, { staffNote: '  Gọi lại sau 17h  ' }), ['staffNote']);
  assert.equal(order.staffNote, 'Gọi lại sau 17h');
  assert.deepEqual(applyCustomerOrderEdits(order, { staffNote: 'Gọi lại sau 17h' }), [], 'cùng nội dung thì không tính là đổi');
  assert.deepEqual(applyCustomerOrderEdits(order, { staffNote: '' }), ['staffNote']);
  assert.equal(order.staffNote, '');
  assert.equal(applyCustomerOrderEdits(order, { staffNote: 'x'.repeat(600) }).length, 1);
  assert.equal(order.staffNote.length, 500);
  assert.equal(order.name, 'Khách landing page');
});

test('trạng thái xử lý: lưu mã trạng thái, đổi về rỗng được, không đụng trường khác', () => {
  const order = sample();
  assert.deepEqual(applyCustomerOrderEdits(order, { processingStatus: 'calling' }), ['processingStatus']);
  assert.equal(order.processingStatus, 'calling');
  assert.deepEqual(applyCustomerOrderEdits(order, { processingStatus: 'calling' }), [], 'cùng trạng thái thì không tính là đổi');
  assert.deepEqual(applyCustomerOrderEdits(order, { processingStatus: 'cancelled' }), ['processingStatus']);
  assert.deepEqual(applyCustomerOrderEdits(order, { processingStatus: '' }), ['processingStatus']);
  assert.equal(order.processingStatus, '');
  assert.equal(order.name, 'Khách landing page');
});
