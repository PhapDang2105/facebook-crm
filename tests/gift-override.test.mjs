// 05/10 (chủ shop): "Có thể chọn quà khác trong chức năng tạo đơn cho khách". Ca thật: khách live 2 túi (Xanh + Vàng)
// được quà tự tính "Miễn phí vận chuyển + Quạt + Bát gáo dừa", không lấy quạt, xin muỗng dừa → nhân viên đổi quà
// trong khung Tạo đơn / Sửa đơn: order.giftOverride = [{ name, sku, quantity, weight, giftId? }].
// POS dùng stub (fetchImpl), không gọi mạng.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('gift-override-');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.POS_COMBOS_PATH = path.join(directory, 'pos-combos.json');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.POS_PUSH_ORDERS = '1';
await import('./helpers/seed-catalog.mjs');

const { reloadCatalog } = await import('../app/processing/catalog.mjs');
const { normalizeGiftOverride, giftOverrideText, giftOverridePlan, applyGiftOverrideFlag, GIFT_OVERRIDE_FLAG_PREFIX } = await import('../app/gift-override.mjs');
const { normalizeCustomerOrder } = await import('../app/conversation-orders.mjs');
const { applyCustomerOrderEdits, describeOrderEdits, staffEditedGroups } = await import('../app/order-edits.mjs');
const { buildPosOrderPayload, updatePosOrder, pushOrderToPos } = await import('../app/pos-orders.mjs');
const { buildExportRows, exportFactsForOrders } = await import('../app/order-export.mjs');
const { processingNotes } = await import('../app/order-notes.mjs');

const XANH = 'GRA-XANH-Z450';
const VANG = 'GRA-VANG-H350';
const ADDRESS = '12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
const LIVE_GIFT = { id: 'qua-tang-live', name: 'Quạt + Bát gáo dừa', active: true, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 50 };
const BGD = { name: 'Bộ bát gáo dừa', sku: 'BGD', quantity: 1, weight: 10, giftId: 'bo-bat-gao-dua' };
const MUONG = { name: 'Muỗng dừa', sku: 'MUONG', quantity: 1, weight: 10, giftId: 'muong-dua' };

/** Chạy `run` với bảng quà có thêm quà live, rồi trả bảng quà gốc. */
async function withLiveGift(run) {
  const original = readFileSync(process.env.GIFTS_PATH, 'utf8');
  const gifts = JSON.parse(original);
  // Ca thật 05/10 dùng quà live gộp "Quạt + Bát gáo dừa": bỏ quà live hiện hành của bảng quà mẫu (Quạt, 08/10) để không cộng hai lần.
  gifts.items = gifts.items.filter(gift => !gift.livestreamOnly);
  gifts.items.push(LIVE_GIFT);
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  reloadCatalog();
  try { return await run(); } finally { writeFileSync(process.env.GIFTS_PATH, original); reloadCatalog(); }
}

/** Đơn tay của ca thật: live 2 túi (Xanh + Vàng), miễn ship, quà chọn tay bát + muỗng. */
const liveTwoBags = (overrides = {}) => normalizeCustomerOrder({
  id: 'go1', name: 'Chị Lan', phone: '0385805790', address: `(Live) ${ADDRESS}`,
  products: [
    { name: 'Granola Túi Xanh 450g', sku: XANH, quantity: 1, price: 149000, weight: 450 },
    { name: 'Granola Túi Vàng 350g', sku: VANG, quantity: 1, price: 149000, weight: 350 }
  ],
  freeShipping: true, shippingFee: 0, livestream: true,
  gift: 'Miễn phí vận chuyển + Quạt + Bát gáo dừa',
  giftOverride: [BGD, MUONG],
  ...overrides
}, { now: 1000 });

// Stub POS: có túi, bát, muỗng, quà live; KHÔNG có mã "QUAT".
function posStub(calls, { variations = [XANH, VANG, 'BGD', 'MUONG', 'QUA-TANG-LIVE', 'CB3-XANH-Z450+BGD+M'] } = {}) {
  return async (url, options = {}) => {
    const address = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ address, method: options.method || 'GET', body });
    if (address.includes('/products/variations')) return { ok: true, status: 200, json: async () => ({ data: variations.map(sku => ({ id: `v-${sku}`, product_id: `p-${sku}`, display_id: sku })) }) };
    if (address.includes('/warehouses')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'wh-1', name: 'Kho', province_id: '701', allow_create_order: true }] }) };
    if (address.includes('/geo/')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (options.method === 'POST' && /\/orders\?api_key=k$/.test(address)) return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'CRM-go1', system_id: 501, status_name: 'Mới' } }) };
    if (options.method === 'PUT') return { ok: true, status: 200, json: async () => ({ success: true }) };
    if (/\/orders\/[^/?]+\?api_key=k$/.test(address)) {
      const post = calls.find(call => call.method === 'POST');
      return { ok: true, status: 200, json: async () => ({ data: { items: post?.body?.items || [] } }) };
    }
    throw new Error(`gọi lạ: ${options.method || 'GET'} ${address}`);
  };
}
const config = { apiKey: 'k', shopId: '714334721', baseUrl: 'https://pos.example/api/v1' };
const giftLines = payload => payload.items.filter(item => item.is_bonus_product).map(item => `${item.variation_id}x${item.quantity}@${item.variation_info.retail_price}`);

test('normalizeGiftOverride: ≤10 mục, tên ≤120, SKU chữ in hoa, số lượng 1–10, gộp trùng; không phải mảng → []', () => {
  assert.deepEqual(normalizeGiftOverride(null), []);
  assert.deepEqual(normalizeGiftOverride('BGD'), []);
  assert.deepEqual(normalizeGiftOverride([{ name: '  Muỗng   dừa ', sku: ' muong ', quantity: 99, weight: '10', giftId: 'muong-dua' }, { sku: 'X' }, null]),
    [{ name: 'Muỗng dừa', sku: 'MUONG', quantity: 10, weight: 10, giftId: 'muong-dua' }]);
  assert.deepEqual(normalizeGiftOverride([{ name: 'Muỗng dừa', sku: 'MUONG', quantity: 0 }, { name: 'Muỗng dừa', sku: 'muong', quantity: 2 }]), [{ name: 'Muỗng dừa', sku: 'MUONG', quantity: 3, weight: 0 }]);
  assert.equal(normalizeGiftOverride([{ name: 'x'.repeat(300), sku: { a: 1 } }])[0].name.length, 120);
  assert.equal(normalizeGiftOverride([{ name: 'x'.repeat(300), sku: { a: 1 } }])[0].sku, '');
  assert.equal(normalizeGiftOverride(Array.from({ length: 20 }, (_, index) => ({ name: `Quà ${index}`, sku: `Q${index}` }))).length, 10);
  assert.equal(giftOverrideText([BGD, { ...MUONG, quantity: 2 }], { freeShipping: true }), 'Miễn phí vận chuyển + Bộ bát gáo dừa + 2 Muỗng dừa');
  assert.equal(giftOverrideText([BGD]), 'Bộ bát gáo dừa');
});

test('tạo đơn tay có quà chọn tay: order.gift chữ dựng từ danh sách (+ miễn ship), không ghi chú khi đủ mã', () => {
  const order = liveTwoBags();
  assert.deepEqual(order.giftOverride, [BGD, MUONG]);
  assert.equal(order.gift, 'Miễn phí vận chuyển + Bộ bát gáo dừa + Muỗng dừa');
  assert.equal(order.processingFlags, undefined);
  // Không chọn tay: y như cũ (chữ quà form gửi, không có trường giftOverride).
  const plain = liveTwoBags({ giftOverride: [] });
  assert.equal(plain.giftOverride, undefined);
  assert.equal(plain.gift, 'Miễn phí vận chuyển + Quạt + Bát gáo dừa');
  // Đơn không miễn ship: chữ quà không có "Miễn phí vận chuyển".
  assert.equal(liveTwoBags({ freeShipping: false, shippingFee: 15000 }).gift, 'Bộ bát gáo dừa + Muỗng dừa');
});

test('POS: đơn có quà chọn tay → dòng tặng đúng BGD + MUONG giá 0, KHÔNG có QUA-TANG-LIVE (kể cả đơn live đủ quà live)', async () => {
  await withLiveGift(async () => {
    const order = liveTwoBags();
    const payload = buildPosOrderPayload(order, { posSkus: new Set([XANH, VANG, 'BGD', 'MUONG', 'QUA-TANG-LIVE']) });
    assert.deepEqual(giftLines(payload), ['BGDx1@0', 'MUONGx1@0']);
    assert.ok(!payload.items.some(item => item.variation_id === 'QUA-TANG-LIVE'));
    assert.match(payload.note, /Quà: Miễn phí vận chuyển \+ Bộ bát gáo dừa \+ Muỗng dừa/);
    // Đơn y hệt không chọn tay: vẫn quà live như cũ.
    const plain = buildPosOrderPayload(liveTwoBags({ giftOverride: [] }), { posSkus: new Set([XANH, VANG, 'BGD', 'MUONG', 'QUA-TANG-LIVE']) });
    assert.deepEqual(giftLines(plain), ['QUA-TANG-LIVEx1@0']);
    // Tạo đơn thật qua stub: body POST có đúng dòng quà, kết quả báo không thiếu mã.
    const calls = [];
    const created = await pushOrderToPos(order, { config, fetchImpl: posStub(calls) });
    const post = calls.find(call => call.method === 'POST');
    assert.deepEqual(post.body.items.filter(item => item.is_bonus_product).map(item => [item.variation_id, item.quantity]), [['v-BGD', 1], ['v-MUONG', 1]]);
    assert.deepEqual(created.giftOverrideMissing, []);
  });
});

test('POS: quà chọn tay bỏ quà ưu đãi bám đuổi và đổi quà của bot; số lượng >1 đi đúng số lượng', () => {
  const order = liveTwoBags({ livestream: false, address: ADDRESS, giftOverride: [{ ...MUONG, quantity: 2 }] });
  order.promoGift = 'Bộ bát gáo dừa';
  order.giftSwap = [{ name: 'Gói granola nhỏ Xanh 35g', sku: 'GRA-XANH-G35', weight: 35 }];
  order.giftSwapRemoved = ['Bộ bát gáo dừa'];
  const payload = buildPosOrderPayload(order, { posSkus: new Set([XANH, VANG, 'BGD', 'MUONG', 'GRA-XANH-G35']) });
  assert.deepEqual(giftLines(payload), ['MUONGx2@0']);
});

test('POS: mục thiếu SKU / POS chưa có mã → không đoán, ghi chú đơn POS + ghi chú xử lý cho nhân viên', async () => {
  const order = liveTwoBags({ giftOverride: [MUONG, { name: 'Quạt cầm tay', sku: '', quantity: 1 }, { name: 'Quạt giấy', sku: 'QUAT', quantity: 1 }] });
  // Lúc lưu (chưa biết mẫu mã POS): mục không SKU đã có ghi chú xử lý.
  assert.deepEqual(order.processingFlags, [`${GIFT_OVERRIDE_FLAG_PREFIX}: Quạt cầm tay — nhân viên thêm trên POS`]);
  const payload = buildPosOrderPayload(order, { posSkus: new Set([XANH, VANG, 'BGD', 'MUONG']) });
  assert.deepEqual(giftLines(payload), ['MUONGx1@0']);
  assert.match(payload.note, /⚠ Quà đổi tay chưa có mã POS: Quạt cầm tay, Quạt giấy \(QUAT\) — nhân viên thêm trên POS/);
  const outcome = await updatePosOrder({ ...order, pos: { id: '77001' } }, { config, fetchImpl: posStub([]) });
  assert.deepEqual(outcome, { id: '77001', giftOverrideMissing: ['Quạt cầm tay', 'Quạt giấy (QUAT)'] });
  assert.equal(applyGiftOverrideFlag(order, outcome.giftOverrideMissing), true);
  assert.deepEqual(processingNotes(order).filter(note => note.startsWith(GIFT_OVERRIDE_FLAG_PREFIX)), [`${GIFT_OVERRIDE_FLAG_PREFIX}: Quạt cầm tay, Quạt giấy (QUAT) — nhân viên thêm trên POS`]);
  assert.equal(applyGiftOverrideFlag(order, outcome.giftOverrideMissing), false, 'không lặp');
  assert.equal(applyGiftOverrideFlag(order, []), true);
  assert.equal(order.processingFlags, undefined);
  // Đơn không chọn tay: kết quả sửa POS như cũ.
  assert.deepEqual(await updatePosOrder({ ...liveTwoBags({ giftOverride: [] }), pos: { id: '77001' } }, { config, fetchImpl: posStub([]) }), { id: '77001' });
});

test('POS: combo gồm sẵn bát + muỗng (CB3-…+BGD+M) — quà chọn tay khác (chỉ muỗng) thì không dùng mã combo; có đủ bát + muỗng thì giữ combo, không đẩy trùng', () => {
  const three = overrides => normalizeCustomerOrder({ id: 'go3', name: 'A', phone: '0385805790', address: ADDRESS, products: [{ name: 'Granola Túi Xanh 450g', sku: XANH, quantity: 3, price: 149000, weight: 450 }], freeShipping: true, ...overrides });
  const posSkus = new Set([XANH, 'BGD', 'MUONG', 'CB3-XANH-Z450+BGD+M']);
  const plain = buildPosOrderPayload(three({}), { posSkus });
  assert.equal(plain.items[0].variation_id, 'CB3-XANH-Z450+BGD+M', 'đơn thường: mã combo như cũ');
  const spoonOnly = buildPosOrderPayload(three({ giftOverride: [{ ...MUONG, quantity: 2 }] }), { posSkus });
  assert.equal(spoonOnly.items[0].variation_id, XANH);
  assert.deepEqual(giftLines(spoonOnly), ['MUONGx2@0']);
  const both = buildPosOrderPayload(three({ giftOverride: [BGD, { ...MUONG, quantity: 2 }] }), { posSkus });
  assert.equal(both.items[0].variation_id, 'CB3-XANH-Z450+BGD+M');
  assert.deepEqual(giftLines(both), ['MUONGx1@0'], 'combo đã gồm 1 bát + 1 muỗng: chỉ đẩy phần muỗng thêm');
});

test('sửa đơn: sửa giỏ GIỮ quà chọn tay; xoá override (Theo bảng quà) thì tự tính lại; lịch sử ghi "đổi quà: … → …"', async () => {
  await withLiveGift(() => {
    const order = liveTwoBags();
    // Sửa giỏ (form Sửa đơn gửi cả chữ quà tự tính cũ): quà chọn tay giữ nguyên, chữ quà theo danh sách.
    const before1 = structuredClone(order);
    const changed = applyCustomerOrderEdits(order, { products: [{ name: 'Granola Túi Xanh 450g', sku: XANH, quantity: 2, price: 149000 }, { name: 'Granola Túi Vàng 350g', sku: VANG, quantity: 1, price: 149000 }], gift: 'Miễn phí vận chuyển + Bộ bát gáo dừa + Muỗng dừa' });
    assert.ok(changed.includes('products'));
    assert.deepEqual(order.giftOverride, [BGD, MUONG]);
    assert.equal(order.gift, 'Miễn phí vận chuyển + Bộ bát gáo dừa + Muỗng dừa');
    assert.ok(!describeOrderEdits(before1, order, changed).includes('đổi quà'));
    // Bảng Xử lý dữ liệu sửa số lượng (đường `lines`, tính lại theo bộ giá): vẫn giữ.
    applyCustomerOrderEdits(order, { lines: [{ sku: XANH, quantity: 1 }] });
    assert.deepEqual(order.giftOverride, [BGD, MUONG]);
    assert.equal(order.gift, 'Miễn phí vận chuyển + Bộ bát gáo dừa + Muỗng dừa');
    // Đổi quà tay sang chỉ muỗng: lịch sử ghi trước → sau; nhóm sửa "basket" (form hoàn tất landing không đè).
    const before2 = structuredClone(order);
    const changed2 = applyCustomerOrderEdits(order, { giftOverride: [MUONG] });
    assert.deepEqual(changed2, ['giftOverride']);
    assert.equal(order.gift, 'Miễn phí vận chuyển + Muỗng dừa');
    assert.equal(describeOrderEdits(before2, order, changed2), 'đổi quà: Bộ bát gáo dừa + Muỗng dừa → Muỗng dừa');
    assert.ok(staffEditedGroups(order).has('basket'));
    // Gửi lại đúng danh sách cũ: không đổi gì.
    assert.deepEqual(applyCustomerOrderEdits(order, { giftOverride: [MUONG] }), []);
    // "Theo bảng quà" (giftOverride: []) không kèm chữ quà: tự tính lại theo giỏ (live 2 túi → quà live).
    const before3 = structuredClone(order);
    const changed3 = applyCustomerOrderEdits(order, { giftOverride: [] });
    assert.deepEqual(changed3, ['giftOverride']);
    assert.equal(order.giftOverride, undefined);
    assert.equal(order.gift, 'Miễn phí vận chuyển + Quạt + Bát gáo dừa');
    assert.equal(describeOrderEdits(before3, order, changed3), 'đổi quà (theo bảng quà): Muỗng dừa → Quạt + Bát gáo dừa');
    // POS quay lại quà theo bảng.
    assert.deepEqual(giftLines(buildPosOrderPayload(order, {})), ['QUA-TANG-LIVEx1@0']);
  });
});

test('sửa đơn: đặt quà chọn tay mục thiếu SKU → ghi chú xử lý; bỏ chọn tay → gỡ ghi chú', () => {
  const order = liveTwoBags({ giftOverride: [] });
  applyCustomerOrderEdits(order, { giftOverride: [{ name: 'Quạt cầm tay', quantity: 1 }] });
  assert.deepEqual(order.processingFlags, [`${GIFT_OVERRIDE_FLAG_PREFIX}: Quạt cầm tay — nhân viên thêm trên POS`]);
  applyCustomerOrderEdits(order, { giftOverride: null, gift: 'Miễn phí vận chuyển' });
  assert.equal(order.processingFlags, undefined);
  assert.equal(order.gift, 'Miễn phí vận chuyển');
});

test('xuất kho: dòng quà theo quà chọn tay (bỏ quà live / bảng quà / bát bám đuổi); mục thiếu mã không lên dòng; đơn thường như cũ', async () => {
  const headers = ['Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Địa chỉ', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá', 'Ghi chú'];
  const row = (id, sku, quantity, price) => [id, 'A', '0385805790', ADDRESS, sku, sku, String(quantity), String(price), ''];
  const lines = (rowsIn, orders) => buildExportRows({ headers, rows: rowsIn }, { orderFacts: exportFactsForOrders(orders) }).map(item => `${item[19]}x${item[21]}@${item[22]}`);
  await withLiveGift(() => {
    const manual = { ...liveTwoBags(), id: 'e1', source: 'Facebook' };
    assert.deepEqual(lines([row('CB-e1', XANH, 1, 149000), row('CB-e1', VANG, 1, 149000)], [manual]), ['GRA-XANH-Z450x1@149000', 'GRA-VANG-H350x1@149000', 'BGDx1@0', 'MUONGx1@0']);
    const plain = { ...liveTwoBags({ giftOverride: [] }), id: 'e2', source: 'Facebook' };
    assert.deepEqual(lines([row('CB-e2', XANH, 1, 149000), row('CB-e2', VANG, 1, 149000)], [plain]), ['GRA-XANH-Z450x1@149000', 'GRA-VANG-H350x1@149000', 'QUA-TANG-LIVEx1@0']);
  });
  const promo = { ...liveTwoBags({ livestream: false, address: ADDRESS, giftOverride: [{ ...MUONG, quantity: 2 }, { name: 'Quạt cầm tay', sku: '' }] }), id: 'e3', source: 'Facebook', promoGift: 'Bộ bát gáo dừa' };
  assert.deepEqual(lines([row('CB-e3', XANH, 2, 149000)], [promo]), ['GRA-XANH-Z450x2@149000', 'MUONGx2@0']);
  // Quà là túi sản phẩm (tặng 0đ): dòng tặng riêng dù khách cũng mua túi cùng mã.
  const bag = { ...liveTwoBags({ livestream: false, address: ADDRESS, giftOverride: [{ name: 'Granola Túi Vàng 350g', sku: VANG, weight: 350 }] }), id: 'e4', source: 'Facebook' };
  assert.deepEqual(lines([row('CB-e4', VANG, 2, 149000)], [bag]), ['GRA-VANG-H350x2@149000', 'GRA-VANG-H350x1@0']);
  assert.deepEqual(giftOverridePlan(bag).lines, [{ sku: VANG, name: 'Granola Túi Vàng 350g', weight: 350, quantity: 1 }]);
});

test('máy chủ + giao diện: route nhận giftOverride, PUT POS khi đổi quà, bot sửa giỏ giữ quà tay; form có nút Đổi quà', () => {
  const server = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '');
  assert.match(server, /'note', 'gift', 'giftOverride'\]\.some\(field => patch\[field\] !== undefined\)/);
  assert.match(server, /if \(giftOverrideMissing\) applyGiftOverrideFlag\(updated, giftOverrideMissing\);/);
  assert.match(server, /if \(hasGiftOverride\(existing\)\) existing\.gift = giftOverrideText\(existing\.giftOverride/);
  assert.match(server, /gifts: \(priced\.gifts \|\| \[\]\)\.map\(gift => \(\{ \.\.\.\(gift\.id \? \{ id: String\(gift\.id\) \} : \{\}\)/);
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="customer-gift-change"[^>]*>Đổi quà<\/button>/);
  assert.match(html, /id="customer-gift-manual" hidden>\(đã đổi tay\)<\/small>/);
  assert.match(html, /id="customer-gift-picker"/);
  const web = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8').replace(/\r/g, '');
  assert.match(web, /giftOverride: customerDraftGiftOverride \|\| \[\],/, 'Sửa đơn luôn gửi danh sách ([] = theo bảng quà)');
  assert.match(web, /\.\.\.\(customerDraftGiftOverride\?\.length \? \{ giftOverride: customerDraftGiftOverride \} : \{\}\),/, 'Tạo đơn gửi khi có chọn tay');
  assert.match(web, /data-gift-picker="auto"[^>]*>Theo bảng quà<\/button>/);
  assert.match(web, /customerDraftAutoGifts = priced\?\.priceable && Array\.isArray\(priced\.gifts\)/, 'tích sẵn quà máy tự tính');
  assert.match(web, /const warn = manual && bags < 2;/, 'cảnh báo giỏ dưới 2 túi mà còn quà tay');
});
