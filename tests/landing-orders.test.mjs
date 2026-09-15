import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.LANDING_ORDERS_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'landing-')), 'landing-orders.json');

await import('./helpers/seed-catalog.mjs');
const {
  buildLandingOrder,
  flattenPayload,
  isLandingTokenValid,
  normalizeLandingPayload,
  parseLandingBody,
  recordLandingOrder,
  listLandingOrders,
  deleteLandingOrder
} = await import('../app/landing-orders.mjs');

test('token: so sánh an toàn, token trống là tắt', () => {
  assert.equal(isLandingTokenValid('abc', 'abc'), true);
  assert.equal(isLandingTokenValid('abd', 'abc'), false);
  assert.equal(isLandingTokenValid('', ''), false);
  assert.equal(isLandingTokenValid('abc', ''), false);
});

test('đọc body JSON và form-urlencoded', () => {
  assert.deepEqual(parseLandingBody('{"name":"A"}', 'application/json'), { name: 'A' });
  assert.deepEqual(parseLandingBody('name=A&phone=0909123456&data[address]=12+L%C3%AA+L%E1%BB%A3i', 'application/x-www-form-urlencoded'), { name: 'A', phone: '0909123456', 'data.address': '12 Lê Lợi' });
  assert.deepEqual(parseLandingBody('', 'application/json'), {});
});

test('nhận dạng trường theo nghĩa dù tên khác nhau và bọc trong data', () => {
  const parsed = normalizeLandingPayload({
    data: { 'Họ và tên': 'Nguyễn Lan', 'Số điện thoại': '0909 123 456', 'Địa chỉ': '12 Lê Lợi', 'Phường/Xã': 'Bến Nghé', 'Quận/Huyện': 'Quận 1', 'Tỉnh/Thành phố': 'TP.HCM', 'Sản phẩm': 'Túi Xanh', 'Số lượng': '2', 'Ghi chú': 'Giao giờ hành chính' },
    utm_campaign: 'granola-t9', page_url: 'https://lp.giotnang.vn/granola'
  });
  assert.equal(parsed.name, 'Nguyễn Lan');
  assert.equal(parsed.phone, '0909123456');
  assert.equal(parsed.address, '12 Lê Lợi, Bến Nghé, Quận 1, TP.HCM');
  assert.deepEqual(parsed.lines.map(line => [line.product, line.quantity]), [['Túi Xanh', '2']]);
  assert.equal(parsed.note, 'Giao giờ hành chính');
  assert.match(parsed.campaign, /utm_campaign=granola-t9/);
  assert.deepEqual(parsed.unknown, []);
});

test('form_data dạng mảng {name, value} và danh sách sản phẩm', () => {
  const fields = flattenPayload({ form_data: [{ name: 'phone', value: '0912345678' }, { name: 'full_name', value: 'Hùng' }] });
  assert.deepEqual(fields.map(field => [field.key, field.value]), [['phone', '0912345678'], ['full name', 'Hùng']]);
  const parsed = normalizeLandingPayload({
    customer: { name: 'Mai', phone: '+84 987 654 321', address: 'Thôn 3, Xã Hoằng Đồng, Hoằng Hóa, Thanh Hóa' },
    products: [{ name: 'Túi Xanh', quantity: 1 }, { name: 'Túi Nâu', quantity: 1, price: '149000' }],
    total: '293.000đ', order_id: 'WC-1001'
  });
  assert.equal(parsed.phone, '0987654321');
  assert.deepEqual(parsed.lines.map(line => line.product), ['Túi Xanh', 'Túi Nâu']);
  assert.equal(parsed.total, 293000);
  assert.equal(parsed.externalId, 'WC-1001');
});

test('tạo đơn: khớp SKU kho, ba cấp địa chỉ, tổng theo landing', () => {
  const order = buildLandingOrder({
    name: 'Nguyễn Lan', phone: '0909123456', address: '12 Lê Lợi, P. Bến Nghé, Q1, HCM', product: 'Túi Xanh', quantity: 2, total: 298000
  }, { now: 1000, id: 'LAND01', page: 'granola' });
  assert.equal(order.id, 'LAND01');
  assert.equal(order.source, 'Landing page');
  assert.equal(order.products[0].sku, 'GRA-XANH-Z450');
  assert.equal(order.products[0].quantity, 2);
  assert.equal(order.total, 298000);
  assert.equal(order.province, 'TP Hồ Chí Minh');
  assert.equal(order.district, 'Quận 1');
  assert.equal(order.ward, 'Phường Bến Nghé');
  assert.equal(order.landing.needsAddress, false);
  assert.equal(order.landing.needsProduct, false);
  assert.equal(order.landing.page, 'granola');
});

test('thiếu địa chỉ hoặc sản phẩm lạ vẫn tạo đơn và gắn cờ; thiếu SĐT thì từ chối', () => {
  const lead = buildLandingOrder({ name: 'Khách', phone: '0912345678', product: 'Bộ quà tết đặc biệt' }, { now: 1000, id: 'LAND02' });
  assert.equal(lead.address, 'Chưa có địa chỉ');
  assert.equal(lead.landing.needsAddress, true);
  assert.equal(lead.landing.needsProduct, true);
  assert.equal(lead.products[0].name, 'Bộ quà tết đặc biệt');
  assert.throws(() => buildLandingOrder({ name: 'Khách', address: '12 Lê Lợi' }), /số điện thoại/);
});

test('lưu và chống trùng theo mã nền tảng hoặc cùng SĐT + giỏ trong 10 phút', async () => {
  const first = await recordLandingOrder({ phone: '0909123456', name: 'A', product: 'Túi Xanh', quantity: 1, order_id: 'WC-7' });
  assert.equal(first.created, true);
  const again = await recordLandingOrder({ phone: '0909123456', name: 'A', product: 'Túi Xanh', quantity: 1, order_id: 'WC-7' });
  assert.equal(again.created, false);
  assert.equal(again.order.id, first.order.id);
  const doubleClick = await recordLandingOrder({ phone: '0909123456', name: 'A', product: 'Túi Xanh', quantity: 1 });
  assert.equal(doubleClick.created, false);
  const other = await recordLandingOrder({ phone: '0909123456', name: 'A', product: 'Túi Xanh', quantity: 3 });
  assert.equal(other.created, true);
  const bad = await recordLandingOrder({ name: 'Không có số' });
  assert.equal(bad.order, null);
  assert.match(bad.error, /số điện thoại/);
  const listed = await listLandingOrders();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].conversationName, 'A');
  assert.ok(await deleteLandingOrder(first.order.id));
  assert.equal((await listLandingOrders()).length, 1);
});
