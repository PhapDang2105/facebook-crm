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

test('payload đúng tên trường mặc định của Webcake', () => {
  const parsed = normalizeLandingPayload({
    full_name: 'Lê Thị Hoa', phone_number: '0977 111 222', address: '45 Trần Hưng Đạo', ward: 'Phường 2', district: 'Quận 5', country: 'Hồ Chí Minh',
    products: 'Túi Xanh x2', quantity: '', coupon: 'GIAM10', textarea_input_1: 'Giao buổi sáng',
    utm_source: 'facebook', utm_campaign: 'granola-t9', utm_term: 'granola', link: 'https://lp.giotnang.vn/granola', date: '2026-09-15', singlechoice: 'Combo 2 túi'
  });
  assert.equal(parsed.name, 'Lê Thị Hoa');
  assert.equal(parsed.phone, '0977111222');
  assert.equal(parsed.address, '45 Trần Hưng Đạo, Phường 2, Quận 5, Hồ Chí Minh');
  assert.deepEqual(parsed.lines.map(line => [line.product, line.quantity]), [['Túi Xanh', '2']]);
  assert.match(parsed.note, /Giao buổi sáng/);
  assert.match(parsed.note, /Mã giảm giá: GIAM10/);
  assert.match(parsed.note, /singlechoice: Combo 2 túi/);
  assert.match(parsed.campaign, /utm_term=granola/);
  assert.deepEqual(parsed.unknown, []);
  // "country" là quốc gia thật thì không thành tỉnh.
  assert.equal(normalizeLandingPayload({ phone_number: '0977111222', address: '45 Trần Hưng Đạo', country: 'Việt Nam' }).address, '45 Trần Hưng Đạo');
  // products dạng object và lựa chọn combo thay cho ô sản phẩm.
  assert.deepEqual(normalizeLandingPayload({ phone_number: '0977111222', products: { name: 'Túi Nâu', quantity: 3, price: 149000 } }).lines.map(line => [line.product, line.quantity]), [['Túi Nâu', '3']]);
  assert.deepEqual(normalizeLandingPayload({ phone_number: '0977111222', singlechoice: 'Túi Vàng' }).lines.map(line => line.product), ['Túi Vàng']);
});

test('payload theo cấu hình đã đặt trong Webcake (short_address, location, commune, variations, status...)', () => {
  const parsed = normalizeLandingPayload({
    name: 'Phạm Văn Nam', email: 'nam@example.com', phone: '0988 777 666',
    address: '176/1A KP1', location: '176/1A KP1, Phường An Phú Đông, Quận 12, TP Hồ Chí Minh',
    province: 'Hồ Chí Minh', district: 'Quận 12', ward: 'Phường An Phú Đông', inserted_at: '2026-09-15T10:00:00Z',
    products: [{ variation_id: 'v1', product_display_name: 'Granola Túi Xanh 450g', quantity: 2, price: 149000 }],
    status: 'new', payment_status: 'unpaid', utm_source: 'facebook', utm_campaign: 'granola-t9', total: 298000
  });
  assert.equal(parsed.name, 'Phạm Văn Nam');
  assert.equal(parsed.phone, '0988777666');
  assert.equal(parsed.address, '176/1A KP1, Phường An Phú Đông, Quận 12, Hồ Chí Minh');
  assert.deepEqual(parsed.lines.map(line => [line.product, String(line.quantity)]), [['Granola Túi Xanh 450g', '2']]);
  assert.equal(parsed.total, 298000);
  assert.deepEqual(parsed.unknown, []);
  // Không có ô địa chỉ riêng thì lấy location.
  assert.equal(normalizeLandingPayload({ phone: '0988777666', location: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh' }).address, '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh');
  const order = buildLandingOrder({ name: 'Nam', phone: '0988777666', location: '176/1A KP1, Phường An Phú Đông, Quận 12, TP Hồ Chí Minh', products: [{ name: 'Túi Xanh', quantity: 2 }], total: 298000 }, { now: 1000, id: 'LAND03' });
  assert.equal(order.ward, 'Phường An Phú Đông');
  assert.equal(order.products[0].sku, 'GRA-XANH-Z450');
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
