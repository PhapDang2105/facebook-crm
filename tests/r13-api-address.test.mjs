// R13 (api) — phần địa chỉ chuyển từ agent địa chỉ sang các tệp đơn hàng:
// (1) cờ "Ô chọn khác chữ khách gõ" (order.addressCheck) phải mất sau khi nhân viên / POS sửa xong địa chỉ;
// (2) AI địa chỉ trả `suggestOnly` (phường/xã tự suy, chưa kiểm) → chỉ ghi gợi ý cho nhân viên, không tự điền;
// (3) đầu-cuối đường webhook landing: khách gõ "B15 hoang cầm p2 tp Vũng Tàu" nhưng ô chọn của form là
//     Xã Long Vĩnh, Huyện Duyên Hải, Trà Vinh → đơn có ghi chú "⚠ Ô chọn khác chữ khách gõ", ba cột lưu theo ô chọn.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('r13-api-address-');
process.env.LANDING_ORDERS_PATH = path.join(directory, 'landing-orders.json');
process.env.LANDING_ARCHIVE_PATH = path.join(directory, 'landing-archive');
process.env.ORDER_ARCHIVE_PATH = path.join(directory, 'order-archive');
process.env.PHONE_WARNINGS_PATH = path.join(directory, 'phone-warnings.json');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
await import('./helpers/seed-catalog.mjs');

const { ADDRESS_PICK_CONFLICT_REASON } = await import('../app/processing/locations.mjs');
const { autoFillLandingOrder, buildLandingOrder, parseLandingBody, readLandingStore, recordLandingOrder } = await import('../app/landing-orders.mjs');
const { applyCustomerOrderEdits, assignResolvedAddress, orderProcessingNotes } = await import('../app/order-edits.mjs');
const { applyPosContent } = await import('../app/pos-content-sync.mjs');

const TYPED = 'B15 hoang cầm p2 tp Vũng Tàu';
const PICKED = { ward: 'Xã Long Vĩnh', district: 'Huyện Duyên Hải', province: 'Trà Vinh' };
const webcakeBody = (overrides = {}) => JSON.stringify({
  name: 'Khách landing', phone: '0912345678', address: TYPED, ...PICKED,
  products: 'Granola Túi Xanh 450g: 2 x 149.000 ₫', total: 298000, status: 'Form hoàn tất', inserted_at: '2026-10-02 09:30:00', ...overrides
});

test('(3) đầu-cuối webhook landing: chữ khách gõ ở Vũng Tàu, ô chọn ở Trà Vinh → ghi chú "⚠ Ô chọn khác chữ khách gõ", ba cột theo ô chọn', async () => {
  // Đúng đường của route POST /webhooks/landing: parseLandingBody(thân thô, content-type) → recordLandingOrder(payload, { page }).
  const payload = parseLandingBody(Buffer.from(webcakeBody(), 'utf8'), 'application/json');
  const result = await recordLandingOrder(payload, { page: 'https://giotnang.vn/granola', checkPhone: false, fetchAddresses: async () => [], inferAddress: async () => null });
  assert.equal(result.created, true);
  const order = (await readLandingStore()).orders.find(item => item.id === result.order.id);
  assert.equal(order.address, `${TYPED}, Xã Long Vĩnh, Huyện Duyên Hải, Trà Vinh`);
  assert.ok(String(order.addressCheck || '').startsWith(ADDRESS_PICK_CONFLICT_REASON), `addressCheck: ${order.addressCheck}`);
  assert.equal(ADDRESS_PICK_CONFLICT_REASON, 'Ô chọn khác chữ khách gõ');
  assert.deepEqual([order.ward, order.district, order.province], ['Xã Long Vĩnh', 'Huyện Duyên Hải', 'Trà Vinh'], 'ba cột lưu theo ô chọn của form');
  const notes = orderProcessingNotes(order);
  assert.ok(notes.some(note => note.startsWith('⚠ Ô chọn khác chữ khách gõ')), `ghi chú xử lý: ${JSON.stringify(notes)}`);
  assert.match(notes.find(note => note.startsWith('⚠ Ô chọn khác chữ khách gõ')), /Vũng Tàu.*Trà Vinh/);
});

test('(3) đối chứng: chữ khách gõ và ô chọn cùng một nơi → không có ghi chú mâu thuẫn', async () => {
  const payload = parseLandingBody(Buffer.from(webcakeBody({ phone: '0987654321', address: '12 Lê Lợi', ward: 'Phường Bến Nghé', district: 'Quận 1', province: 'Hồ Chí Minh' }), 'utf8'), 'application/json');
  const result = await recordLandingOrder(payload, { checkPhone: false, fetchAddresses: async () => [], inferAddress: async () => null });
  assert.equal(result.order.addressCheck, undefined);
  assert.equal(orderProcessingNotes(result.order).some(note => note.includes('Ô chọn khác chữ khách gõ')), false);
});

test('(1) nhân viên sửa xong địa chỉ → cờ "Ô chọn khác chữ khách gõ" mất; ghi chú soát khác (không phải cờ này) giữ nguyên', () => {
  const order = buildLandingOrder(JSON.parse(webcakeBody()), { now: 1000, id: 'lpaddr1' });
  assert.ok(String(order.addressCheck).startsWith(ADDRESS_PICK_CONFLICT_REASON));
  const changed = applyCustomerOrderEdits(order, { address: 'B15 Hoàng Cầm, Phường 2, Thành phố Vũng Tàu, Bà Rịa-Vũng Tàu' });
  assert.deepEqual([...changed], ['address']);
  assert.equal(order.addressCheck, undefined, 'địa chỉ mới không còn mâu thuẫn thì bỏ cờ');
  assert.equal(orderProcessingNotes(order).some(note => note.includes('Ô chọn khác chữ khách gõ')), false);
  assert.deepEqual([order.ward, order.district, order.province], ['Phường 2', 'Thành phố Vũng Tàu', 'Bà Rịa-Vũng Tàu']);
  // Sửa sang một địa chỉ VẪN mâu thuẫn: cờ mới theo địa chỉ mới.
  const still = buildLandingOrder(JSON.parse(webcakeBody()), { now: 1000, id: 'lpaddr2' });
  applyCustomerOrderEdits(still, { address: 'B15 hoàng cầm p2 tp Vũng Tàu, Xã Long Vĩnh, Huyện Duyên Hải, Trà Vinh' });
  assert.ok(String(still.addressCheck).startsWith(ADDRESS_PICK_CONFLICT_REASON));
  // Ghi chú soát khác của đơn (bot nhận địa chỉ sau một lần hỏi…) không bị xoá khi sửa địa chỉ.
  const other = { address: 'abc', addressCheck: 'Địa chỉ nhận sau một lần hỏi — nhân viên soát' };
  assignResolvedAddress(other, '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh');
  assert.equal(other.addressCheck, 'Địa chỉ nhận sau một lần hỏi — nhân viên soát');
});

test('(1) route PATCH /api/customer-orders/:id: trường đã xoá trên bản sao cũng mất trên đơn thật (Object.assign không xoá)', async () => {
  // Chạy thử đầu-cuối (work-fixapi/run/p7): cờ mất trên bản sao nhưng đơn trong kho vẫn còn cờ — route sửa trên bản
  // sao rồi Object.assign(order, draft). Mô phỏng đúng hai dòng của route.
  const order = buildLandingOrder(JSON.parse(webcakeBody()), { now: 1000, id: 'lpaddr4' });
  order.promoGift = 'Bộ bát gáo dừa';
  const draft = structuredClone(order);
  applyCustomerOrderEdits(draft, { address: 'B15 Hoàng Cầm, Phường 2, Thành phố Vũng Tàu, Bà Rịa-Vũng Tàu', lines: [{ sku: 'GRA-XANH-Z450', quantity: 3 }] });
  for (const key of Object.keys(order)) if (!(key in draft)) delete order[key];
  Object.assign(order, draft);
  assert.equal(order.addressCheck, undefined);
  assert.equal(order.promoGift, undefined, 'quà bám đuổi của giỏ 2 túi cũng mất khi giỏ đổi sang 3 túi');
  const { readFile } = await import('node:fs/promises');
  const server = (await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(server, /for \(const key of Object\.keys\(order\)\) if \(!\(key in draft\)\) delete order\[key\];\n\s+Object\.assign\(order, draft\);/);
});

test('(1) nhân viên sửa địa chỉ trên POS (đồng bộ nội dung POS) cũng bỏ cờ mâu thuẫn', () => {
  const order = { ...buildLandingOrder(JSON.parse(webcakeBody()), { now: 1000, id: 'lpaddr3' }), landing: { posId: '9001' } };
  const posOrder = address => ({
    id: '9001', status: 0, bill_full_name: order.name, bill_phone_number: order.phone, cod: 298000, is_free_shipping: true,
    shipping_address: { full_address: address, address },
    items: [{ quantity: 2, variation_info: { display_id: 'GRA-XANH-Z450', name: 'Granola Túi Xanh 450g', retail_price: 149000 } }]
  });
  // Lượt đầu chỉ ghi dấu; lượt sau POS đổi địa chỉ → chép về đơn CRM.
  applyPosContent(order, posOrder(order.address), { now: 2000 });
  assert.ok(String(order.addressCheck).startsWith(ADDRESS_PICK_CONFLICT_REASON));
  const result = applyPosContent(order, posOrder('B15 Hoàng Cầm, Phường 2, Thành phố Vũng Tàu, Bà Rịa-Vũng Tàu'), { now: 3000 });
  assert.deepEqual(result.changed, ['địa chỉ']);
  assert.equal(order.addressCheck, undefined);
  assert.equal(order.province, 'Bà Rịa-Vũng Tàu');
});

test('(2) AI địa chỉ chỉ GỢI Ý (suggestOnly): không tự điền địa chỉ, đơn nhận ghi chú "ℹ Gợi ý phường/xã (AI, chưa kiểm): …"', async () => {
  const payload = { name: 'Khách thiếu phường', phone: '0909000111', address: '25 đường số 7, Thủ Đức', products: 'Granola Túi Xanh 450g: 2 x 149.000 ₫', total: 298000, status: 'Form hoàn tất' };
  const order = buildLandingOrder(payload, { now: 1000, id: 'lpai1' });
  assert.ok(['none', 'partial'].includes(order.locationConfidence), `cần một địa chỉ luật chưa tách đủ ba cấp (đang: ${order.locationConfidence})`);
  const suggestion = { canonical: '25 đường số 7, Phường Linh Trung, Thành phố Thủ Đức, Hồ Chí Minh', ward: 'Phường Linh Trung', district: 'Thành phố Thủ Đức', province: 'Hồ Chí Minh' };
  const context = { fetchAddresses: async () => [], inferAddress: async () => ({ canonical: '', ward: '', district: '', province: '', suggestOnly: true, suggestion, confidence: 'low' }) };
  const filled = await autoFillLandingOrder(order, payload, [], context);
  assert.equal(filled.address, order.address, 'địa chỉ khách gõ giữ nguyên');
  assert.equal(filled.landing.autoFilled, undefined, 'không đánh dấu "máy tự điền địa chỉ"');
  assert.deepEqual(filled.processingFlags, ['ℹ Gợi ý phường/xã (AI, chưa kiểm): Phường Linh Trung, Thành phố Thủ Đức']);
  assert.equal(orderProcessingNotes(filled)[0], 'ℹ Gợi ý phường/xã (AI, chưa kiểm): Phường Linh Trung, Thành phố Thủ Đức');
  // AI trả địa chỉ đã kiểm (canonical): tự điền như cũ, không thêm ghi chú gợi ý.
  const checkedOrder = buildLandingOrder(payload, { now: 1000, id: 'lpai2' });
  const auto = await autoFillLandingOrder(checkedOrder, payload, [], { fetchAddresses: async () => [], inferAddress: async () => ({ canonical: suggestion.canonical, ward: suggestion.ward, district: suggestion.district, province: suggestion.province, confidence: 'high', reason: 'đường số 7 thuộc Linh Trung' }) });
  assert.equal(auto.address, suggestion.canonical);
  assert.ok(auto.landing.autoFilled.address);
  assert.equal(auto.processingFlags, undefined);
  // AI không trả gì: đơn giữ nguyên, không ghi chú.
  const untouched = await autoFillLandingOrder(buildLandingOrder(payload, { now: 1000, id: 'lpai3' }), payload, [], { fetchAddresses: async () => [], inferAddress: async () => null });
  assert.equal(untouched.processingFlags, undefined);
});
