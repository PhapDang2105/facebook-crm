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

test('chuỗi sản phẩm thật của Webcake: biến thể combo quyết định số túi, ô trống gửi bằng tên trường bị bỏ qua', async () => {
  const { parseWebcakeProducts } = await import('../app/landing-orders.mjs');
  assert.deepEqual(
    parseWebcakeProducts('Granola Mới Ngũ Cốc Ăn Sáng Healthy Lành Mạnh Với Hạt Dinh Dưỡng Trái Cây Từ Giọt Nắng (Combo 3 Granola Xanh): 1 x 447.000 ₫').map(line => [line.sku, line.quantity]),
    [['GRA-XANH-Z450', 3]]
  );
  assert.deepEqual(parseWebcakeProducts('Granola Mới (1 Túi Granola Xanh 450g): 2 x 189.000 ₫').map(line => [line.sku, line.quantity]), [['GRA-XANH-Z450', 2]]);
  assert.deepEqual(parseWebcakeProducts('Granola Mới (Combo 2 Xanh + 1 Vàng): 1 x 447.000 ₫').map(line => [line.sku, line.quantity]), [['GRA-XANH-Z450', 2], ['GRA-VANG-H350', 1]]);
  const unknown = parseWebcakeProducts('Bộ quà Tết (Hộp lớn): 2 x 500.000 ₫');
  assert.equal(unknown[0].sku, '');
  assert.equal(unknown[0].quantity, 2);
  assert.equal(unknown[0].price, '250000');
  assert.equal(parseWebcakeProducts('Túi Xanh x2'), null);

  const payload = {
    address: 'Hateco Plaza - Lô 4A Huỳnh Thúc Kháng', district: 'Quận Đống Đa', email: 'email', inserted_at: '2026-09-16 07:52:24',
    location: 'https://granola.giotnang.vn/?fbclid=abc&utm_medium=paid&utm_source=fb&utm_campaign=120247850360290132',
    name: 'Nguyễn Thị Thu Hà', payment_status: 'payment_status.', phone: '0904636274',
    products: 'Granola Mới Ngũ Cốc Ăn Sáng Healthy Lành Mạnh Với Hạt Dinh Dưỡng Trái Cây Từ Giọt Nắng (Combo 3 Granola Xanh): 1 x 447.000 ₫',
    province: 'Hà Nội', status: 'New form', total: '447.000',
    utm_campaign: 'utm_campaign', utm_content: 'utm_content', utm_medium: 'utm_medium', utm_source: 'utm_source', utm_term: 'utm_term', ward: 'Phường Láng Hạ'
  };
  const parsed = normalizeLandingPayload(payload);
  assert.equal(parsed.address, 'Hateco Plaza - Lô 4A Huỳnh Thúc Kháng, Phường Láng Hạ, Quận Đống Đa, Hà Nội');
  assert.equal(parsed.externalId, '0904636274@2026-09-16 07:52:24');
  assert.equal(parsed.campaignSummary, 'Nguồn: fb · Chiến dịch: 120247850360290132');
  assert.equal(parsed.pageUrl, 'https://granola.giotnang.vn/');
  assert.deepEqual(parsed.unknown, []);
  const order = buildLandingOrder(payload, { now: 1000, id: 'LAND04' });
  assert.deepEqual(order.products.map(item => [item.sku, item.quantity, item.paidPrice]), [['GRA-XANH-Z450', 3, 149000]]);
  assert.equal(order.total, 447000);
  assert.equal(order.ward, 'Phường Láng Hạ');
  assert.equal(order.note, '', 'ghi chú chỉ giữ lời khách; chiến dịch nằm ở landing.campaign');
  assert.match(order.landing.campaign, /utm_campaign=120247850360290132/);
  assert.equal(order.landing.needsProduct, false);
  assert.match(order.landing.rawProducts, /Combo 3 Granola Xanh/);
  // Không có utm nào cả: không có chuỗi "utm_campaign=utm_campaign" lọt vào đâu.
  const plain = buildLandingOrder({ ...payload, location: 'https://granola.giotnang.vn/' }, { now: 1000, id: 'LAND05' });
  assert.equal(plain.note, '');
  assert.equal(plain.landing.campaign, '');
});

test('đơn chưa hoàn tất: giữ làm lead có trạng thái riêng, bản hoàn tất đè lên cùng một đơn', async () => {
  const draft = await recordLandingOrder({ name: 'Nguyễn tú anh', phone: '0368419478', province: 'Bắc Kạn', status: 'Form chưa hoàn tất', inserted_at: '2026-09-16 02:08:00', location: 'https://granola.giotnang.vn/' }, { autoFill: false });
  assert.equal(draft.created, true);
  assert.equal(draft.order.status, 'Chưa hoàn tất');
  assert.equal(draft.order.landing.incomplete, true);
  assert.equal(draft.order.landing.needsProduct, true);
  // Sự kiện cập nhật dở dang tiếp theo (cùng inserted_at) chỉ đè, không tạo đơn mới.
  const draft2 = await recordLandingOrder({ name: 'Nguyễn tú anh', phone: '0368419478', province: 'Bắc Kạn', district: 'Huyện Chợ Đồn', status: 'Form chưa hoàn tất', inserted_at: '2026-09-16 02:08:00' }, { autoFill: false });
  assert.equal(draft2.created, false);
  assert.equal(draft2.updated, true);
  assert.equal(draft2.order.id, draft.order.id);
  assert.equal(draft2.order.district, 'Huyện Chợ Đồn');
  // Khách gửi xong (Webcake tạo bản ghi mới, inserted_at khác): đè lên đơn dở của cùng số điện thoại.
  const done = await recordLandingOrder({ name: 'Nguyễn Tú Anh', phone: '0368419478', address: 'Tổ 5', ward: 'Phường Sông Cầu', district: 'Thành phố Bắc Kạn', province: 'Bắc Kạn', products: 'Granola Mới (Combo 2 Granola Xanh): 1 x 298.000 ₫', total: '298.000', status: 'Form hoàn tất', inserted_at: '2026-09-16 02:15:00' });
  assert.equal(done.created, false);
  assert.equal(done.updated, true);
  assert.equal(done.order.id, draft.order.id);
  assert.equal(done.order.status, 'Mới');
  assert.equal(done.order.landing.incomplete, false);
  assert.deepEqual(done.order.products.map(item => [item.sku, item.quantity]), [['GRA-XANH-Z450', 2]]);
  // Bản dở dang đến muộn sau bản hoàn tất thì không đè ngược.
  const late = await recordLandingOrder({ name: 'Nguyễn tú anh', phone: '0368419478', province: 'Bắc Kạn', status: 'Form chưa hoàn tất', inserted_at: '2026-09-16 02:08:00' }, { autoFill: false });
  assert.equal(late.created, false);
  assert.equal(late.order.status, 'Mới');
  const listed = await listLandingOrders();
  assert.equal(listed.filter(order => order.phone === '0368419478').length, 1);
});

test('tự điền cho đơn bỏ dở: sản phẩm mặc định theo chiến dịch, địa chỉ từ POS hoặc đơn trước, đưa vào Xử lý dữ liệu', async () => {
  const { defaultBasketForCampaign, pickAddressForPhone, autoFillLandingOrder } = await import('../app/landing-orders.mjs');
  const complete = (id, phone, products, campaign, createdAt = 1000) => ({
    id, phone, address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', createdAt,
    products: products.map(([sku, quantity]) => ({ sku, quantity })),
    landing: { campaign: `utm_campaign=${campaign}`, page: 'https://granola.giotnang.vn/' }
  });
  const history = [
    complete('a1', '0901', [['GRA-XANH-Z450', 2]], 'xanh'),
    complete('a2', '0902', [['GRA-XANH-Z450', 2]], 'xanh'),
    complete('a3', '0903', [['GRA-XANH-Z450', 3]], 'xanh'),
    complete('a4', '0904', [['GRA-VANG-H350', 1]], 'vang'),
    complete('a5', '0905', [['GRA-VANG-H350', 1]], 'vang'),
    complete('a6', '0905', [['GRA-VANG-H350', 1]], 'vang')
  ];
  const draftOrder = { id: 'd1', products: [], landing: { campaign: 'utm_campaign=xanh', page: 'https://granola.giotnang.vn/' } };
  assert.deepEqual(defaultBasketForCampaign(history, draftOrder).items, [{ sku: 'GRA-XANH-Z450', quantity: 2 }], 'combo 2 Xanh phổ biến nhất của chiến dịch xanh');
  assert.match(defaultBasketForCampaign(history, draftOrder).basis, /chiến dịch xanh/);
  const unknownCampaign = { id: 'd2', products: [], landing: { campaign: 'utm_campaign=moi', page: '' } };
  assert.deepEqual(defaultBasketForCampaign(history, unknownCampaign).items, [{ sku: 'GRA-VANG-H350', quantity: 1 }], 'chiến dịch lạ thì lấy tổ hợp phổ biến nhất chung');

  // Địa chỉ: POS trước, phải khớp tỉnh khách đã gõ.
  const posAddresses = async () => ['Tổ 5, Phường Sông Cầu, Thành phố Bắc Kạn, Bắc Kạn', '45 Trần Hưng Đạo, Phường 2, Quận 5, TP Hồ Chí Minh'];
  const typedHcm = { id: 'd3', phone: '0999', address: 'Hồ Chí Minh' };
  const picked = await pickAddressForPhone(typedHcm, [], { fetchAddresses: posAddresses });
  assert.equal(picked.address, '45 Trần Hưng Đạo, Phường 2, Quận 5, TP Hồ Chí Minh');
  assert.equal(picked.source, 'POS');
  const typedNothing = { id: 'd4', phone: '0999', address: 'Chưa có địa chỉ' };
  assert.equal((await pickAddressForPhone(typedNothing, [], { fetchAddresses: posAddresses })).address, 'Tổ 5, Phường Sông Cầu, Thành phố Bắc Kạn, Bắc Kạn', 'không gõ gì thì lấy địa chỉ mới nhất');
  const typedOther = { id: 'd5', phone: '0999', address: 'Hà Nội' };
  assert.equal(await pickAddressForPhone(typedOther, [], { fetchAddresses: posAddresses }), null, 'không có địa chỉ cùng tỉnh thì không điền');
  const fromCrm = await pickAddressForPhone(typedNothing, [complete('p1', '0999', [['GRA-XANH-Z450', 1]], 'xanh')], { fetchAddresses: async () => [] });
  assert.match(fromCrm.source, /đơn trước/);

  // Cả luồng: đơn dở chỉ có tên + SĐT + tỉnh → dựng lại đủ sản phẩm và địa chỉ, giữ id và trạng thái.
  const payload = { name: 'Nguyễn tú anh', phone: '0368419478', province: 'Bắc Kạn', status: 'Form chưa hoàn tất', inserted_at: '2026-09-16 02:08:00', location: 'https://granola.giotnang.vn/?utm_campaign=xanh' };
  const draft = buildLandingOrder(payload, { now: 5000, id: 'DRAFT1' });
  assert.equal(draft.landing.needsProduct, true);
  const filled = await autoFillLandingOrder(draft, payload, history, { fetchAddresses: posAddresses });
  assert.equal(filled.id, 'DRAFT1');
  assert.equal(filled.status, 'Chưa hoàn tất');
  assert.equal(filled.landing.incomplete, true);
  assert.deepEqual(filled.products.map(item => [item.sku, item.quantity]), [['GRA-XANH-Z450', 2]]);
  assert.equal(filled.total, 298000);
  assert.equal(filled.ward, 'Phường Sông Cầu');
  assert.equal(filled.district, 'Thành Phố Bắc Kạn');
  assert.match(filled.landing.autoFilled.product, /Granola Túi Xanh 450g x2/);
  assert.match(filled.landing.autoFilled.address, /từ POS/);
  assert.equal(filled.note, '', 'ghi chú không bị máy chèn; việc duyệt thể hiện qua landing.autoFilled');
  // Đơn đã đủ thì không đụng.
  const full = buildLandingOrder({ name: 'A', phone: '0368419478', address: '12 Lê Lợi, P. Bến Nghé, Q1, HCM', products: 'Granola Mới (Combo 2 Granola Xanh): 1 x 298.000 ₫', total: '298.000' }, { now: 5000, id: 'FULL1' });
  const untouched = await autoFillLandingOrder(full, {}, history, { fetchAddresses: posAddresses });
  assert.equal(untouched.landing.autoFilled, undefined);
});

test('đơn dở được tự điền vẫn bị bản khách gửi xong đè lên', async () => {
  const draft = await recordLandingOrder({ name: 'Mai', phone: '0977123123', province: 'Hồ Chí Minh', status: 'Form chưa hoàn tất', inserted_at: '2026-09-16 03:00:00', location: 'https://granola.giotnang.vn/?utm_campaign=xanh' }, { fetchAddresses: async () => ['45 Trần Hưng Đạo, Phường 2, Quận 5, TP Hồ Chí Minh'] });
  assert.equal(draft.created, true);
  assert.ok(draft.order.landing.autoFilled, 'đơn dở được tự điền');
  assert.equal(draft.order.status, 'Chưa hoàn tất');
  const done = await recordLandingOrder({ name: 'Mai', phone: '0977123123', address: '12 Lê Lợi', ward: 'Phường Bến Nghé', district: 'Quận 1', province: 'Hồ Chí Minh', products: 'Granola Mới (Combo 3 Granola Xanh): 1 x 447.000 ₫', total: '447.000', status: 'Form hoàn tất', inserted_at: '2026-09-16 03:05:00' });
  assert.equal(done.updated, true);
  assert.equal(done.order.id, draft.order.id);
  assert.equal(done.order.landing.autoFilled, undefined, 'dữ liệu thật thay hoàn toàn phần tự điền');
  assert.equal(done.order.ward, 'Phường Bến Nghé');
  assert.deepEqual(done.order.products.map(item => [item.sku, item.quantity]), [['GRA-XANH-Z450', 3]]);
});
