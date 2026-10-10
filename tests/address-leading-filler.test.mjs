// 10/10 (đơn 52e6390a): khách gõ "Dạ sđt <số>\nĐịa chỉ Địa chỉ số 9A, Đường Tô Ký Phường Trung Mỹ Tây Quận 12" → địa chỉ trên
// đơn "(Live) Dạ Địa chỉ Địa chỉ số 9A…". Lời đệm đầu câu ("Dạ", "Vâng", "Ok") và nhãn "Địa chỉ" lặp phải bỏ hết.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanAddressText } from '../app/processing/order-flow.mjs';

test('bỏ lời đệm đầu câu và nhãn "Địa chỉ" lặp; không cắt nhầm tên địa danh', () => {
  assert.equal(cleanAddressText('Dạ sđt 0901234567\nĐịa chỉ Địa chỉ số 9A, Đường Tô Ký Phường Trung Mỹ Tây Quận 12'), 'số 9A, Đường Tô Ký Phường Trung Mỹ Tây Quận 12');
  assert.equal(cleanAddressText('Dạ, số 9A Đường Tô Ký Quận 12'), 'số 9A Đường Tô Ký Quận 12');
  assert.equal(cleanAddressText('Vâng ạ, 12 Lê Lợi, Quận 1'), '12 Lê Lợi, Quận 1');
  assert.equal(cleanAddressText('Ok 45 Nguyễn Trãi Hà Nội'), '45 Nguyễn Trãi Hà Nội');
  assert.equal(cleanAddressText('Da Nang, 12 Bạch Đằng'), 'Da Nang, 12 Bạch Đằng', 'Đà Nẵng gõ không dấu');
  assert.equal(cleanAddressText('Dạ Lạt, Lâm Đồng'), 'Dạ Lạt, Lâm Đồng', 'Đà Lạt gõ nhầm dấu');
  assert.equal(cleanAddressText('Okinawa 12'), 'Okinawa 12');
});

test('form landing: bỏ nhãn "Đc / Địa chỉ" đứng đầu ô địa chỉ, không đụng địa danh bắt đầu bằng "Đ"', async () => {
  const { normalizeLandingPayload } = await import('../app/landing-orders.mjs');
  const address = value => normalizeLandingPayload({ name: 'A', phone: '0901234567', address: value }).address;
  assert.equal(address('Đc: ấp 3'), 'ấp 3');
  assert.equal(address('đc 31/47 lê lai p3 gò vấp'), '31/47 lê lai p3 gò vấp');
  assert.equal(address('Địa chỉ nhận hàng: 12 Lê Lợi'), '12 Lê Lợi');
  assert.equal(address('dc 5 Nguyễn Huệ'), '5 Nguyễn Huệ');
  assert.equal(address('dia chi: 7 Hai Bà Trưng'), '7 Hai Bà Trưng');
  assert.equal(address('Đồng Xoài, Bình Phước'), 'Đồng Xoài, Bình Phước');
  assert.equal(address('Dcầu Mới, Thủ Đức'), 'Dcầu Mới, Thủ Đức');
});
