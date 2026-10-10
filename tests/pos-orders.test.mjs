import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('posorders-');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.POS_PUSH_ORDERS = '1';

await import('./helpers/seed-catalog.mjs');
const posModule = await import('../app/pos-orders.mjs');
const { buildPosOrderPayload, pushOrderToPos, isCrmPushedPosOrder, syncOrderToPos } = posModule;
const { updateMessagingStore, ensureConversation, readMessagingStore } = await import('../app/messaging-store.mjs');

const config = { apiKey: 'k', shopId: '714334721', baseUrl: 'https://pos.example/api/v1' };
const order = {
  id: 'ab12cd34', name: 'Pháp Đặng', phone: '0385805700', address: 'Khu phố 6, Phường Đông Hải, Thành phố Phan Rang – Tháp Chàm, Ninh Thuận',
  street: 'Khu phố 6', province: 'Ninh Thuận', district: 'Thành phố Phan Rang – Tháp Chàm', ward: 'Phường Đông Hải',
  products: [
    { name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2, price: 174000, paidPrice: 149000, weight: 450 },
    { name: 'Granola Túi Nâu vị cacao 350g', sku: 'GRA-NAU-Z350', quantity: 1, price: 164000, paidPrice: 144000, weight: 350 }
  ],
  freeShipping: true, shippingFee: 0, discount: 70000, total: 442000, gift: 'Miễn phí vận chuyển + Bộ bát gáo dừa + Muỗng dừa',
  note: 'Giao giờ hành chính', employee: 'Chatbot AI'
};

test('body tạo đơn POS: SKU làm mã mẫu mã, giá niêm yết + giảm combo + ship riêng, quà có SKU là sản phẩm tặng, custom_id CRM-', () => {
  const payload = buildPosOrderPayload(order, { conversation: { pageId: '936023372925639', pancakeConversationId: '936023372925639_27087458000839712' }, warehouseId: 'wh-1', shopId: '714334721', posSkus: new Set(['GRA-XANH-Z450', 'GRA-NAU-Z350', 'BGD']) });
  assert.equal(payload.shop_id, 714334721);
  assert.equal(payload.custom_id, 'CRM-ab12cd34');
  assert.equal(payload.bill_phone_number, '0385805700');
  assert.equal(payload.shipping_address.address, order.address);
  assert.equal(payload.shipping_address.province_name, 'Ninh Thuận');
  assert.deepEqual(payload.items.map(item => [item.variation_id, item.quantity, item.variation_info.retail_price, item.is_bonus_product]), [
    ['GRA-XANH-Z450', 2, 174000, false],
    ['GRA-NAU-Z350', 1, 164000, false],
    ['BGD', 1, 0, true]
  ], 'MUONG không có trong POS thì bỏ qua, không làm POS từ chối đơn');
  assert.equal(payload.discount, 70000);
  assert.equal('total_discount' in payload, false, 'POS tự tính tổng giảm giá từ discount');
  assert.equal(payload.shipping_fee, 0);
  assert.equal(payload.is_free_shipping, true);
  assert.equal(payload.warehouse_id, 'wh-1');
  assert.equal(payload.page_id, '936023372925639');
  assert.equal(payload.conversation_id, '936023372925639_27087458000839712');
  assert.match(payload.note, /Đơn CRM #ab12cd34/);
  assert.match(payload.note, /Khách ghi: Giao giờ hành chính/);
  // Tổng POS = niêm yết − giảm + ship = tổng CRM.
  const subtotal = payload.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0);
  assert.equal(subtotal - payload.discount + payload.shipping_fee, order.total);
});

test('giỏ khớp combo POS → một dòng mã combo như nhân viên (28/09); POS niêm yết cao hơn thì chênh thành giảm giá; POS thiếu mã combo thì túi lẻ + giảm như cũ', () => {
  const { posComboFor } = posModule;
  const twoBags = { ...order, id: '840c5ef5', products: [
    { name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1, price: 174000, weight: 450 },
    { name: 'Granola Túi Vàng 350g', sku: 'GRA-VANG-H350', quantity: 1, price: 174000, weight: 350 }
  ], discount: 50000, total: 298000 };
  const payload = buildPosOrderPayload(twoBags);
  assert.deepEqual(payload.items.filter(item => !item.is_bonus_product).map(item => [item.variation_id, item.quantity, item.variation_info.retail_price]), [['CB-VANGG+XANH', 1, 298000]]);
  assert.equal(payload.discount, 0);
  assert.equal(payload.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0) - payload.discount, 298000);
  assert.match(payload.items[0].variation_info.name, /1 Granola Túi Xanh 450g \+ 1 Granola Túi Vàng 350g/);
  // Giá niêm yết POS của combo cao hơn giá CRM: phần chênh là giảm giá để COD = CRM.
  const priced = buildPosOrderPayload(twoBags, { posPrices: new Map([['CB-VANGG+XANH', { id: 'u1', productId: 'p1', retailPrice: 308000 }]]) });
  assert.equal(priced.items[0].variation_info.retail_price, 308000);
  assert.equal(priced.discount, 10000);
  // POS không có mã combo (posSkus không chứa) → giữ từng túi + giảm 50.000đ như cũ.
  const noCombo = buildPosOrderPayload(twoBags, { posSkus: new Set(['GRA-XANH-Z450', 'GRA-VANG-H350']) });
  assert.deepEqual(noCombo.items.map(item => item.variation_id), ['GRA-XANH-Z450', 'GRA-VANG-H350']);
  assert.equal(noCombo.discount, 50000);
  // Combo 3 cùng vị: mã đã gồm bát + muỗng → không thêm dòng quà BGD/MUONG; combo 3 vị thì vẫn có dòng quà.
  const three = buildPosOrderPayload({ ...order, id: 'c3', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 3, price: 174000 }], discount: 75000, total: 447000 }, { posSkus: new Set(['GRA-XANH-Z450', 'CB3-XANH-Z450+BGD+M', 'BGD', 'MUONG']) });
  assert.deepEqual(three.items.map(item => item.variation_id), ['CB3-XANH-Z450+BGD+M']);
  assert.equal(three.discount, 0);
  const mix = buildPosOrderPayload({ ...order, id: 'c3m', products: [
    { name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1, price: 174000 },
    { name: 'Granola Túi Vàng 350g', sku: 'GRA-VANG-H350', quantity: 1, price: 174000 },
    { name: 'Granola Túi Nâu vị cacao 350g', sku: 'GRA-NAU-Z350', quantity: 1, price: 164000 }
  ], discount: 70000, total: 442000 }, { posSkus: new Set(['GRA-XANH-Z450', 'GRA-VANG-H350', 'GRA-NAU-Z350', 'CB-VANGG+XANH+NAU', 'BGD', 'MUONG']) });
  assert.deepEqual(mix.items.map(item => item.variation_id), ['CB-VANGG+XANH+NAU', 'BGD', 'MUONG']);
  // Giỏ không có combo POS (2 Xanh + 1 Vàng) → túi lẻ như cũ.
  assert.equal(posComboFor([{ sku: 'GRA-XANH-Z450', quantity: 2 }, { sku: 'GRA-VANG-H350', quantity: 1 }]), null);
  assert.equal(posComboFor([{ sku: 'GRA-XANH-Z450', quantity: 2 }]).sku, 'CB2-XANH-Z450');
});

function posFetch(calls, { variations = ['GRA-XANH-Z450', 'GRA-NAU-Z350', 'BGD', 'MUONG'], createStatus = 200, createBody = { id: 99001, system_id: 1234, status_name: 'new' } } = {}) {
  return async (url, options = {}) => {
    const address = String(url);
    calls.push({ address, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (address.includes('/products/variations')) return { ok: true, status: 200, json: async () => ({ data: variations.map(sku => ({ id: `v-${sku}`, display_id: sku })) }) };
    if (address.includes('/warehouses')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'wh-default', name: 'Kho mặc định', allow_create_order: true }, { id: 'wh-gn', name: 'Kho Giọt Nắng', province_id: '701', allow_create_order: true }] }) };
    // Danh mục địa lý của POS: tên quận viết "Phan Rang-Tháp Chàm" (không khoảng trắng quanh gạch) khác CRM "Phan Rang – Tháp Chàm".
    if (address.includes('/geo/provinces')) return { ok: true, status: 200, json: async () => ({ data: [{ id: '701', name: 'Hồ Chí Minh' }, { id: '705', name: 'Ninh Thuận' }] }) };
    if (address.includes('/geo/districts')) return { ok: true, status: 200, json: async () => ({ data: [{ id: '70504', name: 'Huyện Bác Ái', province_id: '705' }, { id: '70501', name: 'Thành phố Phan Rang-Tháp Chàm', province_id: '705' }] }) };
    if (address.includes('/geo/communes')) return { ok: true, status: 200, json: async () => ({ data: [{ id: '7050127', name: 'Phường Đông Hải', district_id: '70501' }, { id: '7050101', name: 'Phường Đô Vinh', district_id: '70501' }] }) };
    if (address.endsWith('/orders?api_key=k') && options.method === 'POST') return { ok: createStatus < 400, status: createStatus, json: async () => createBody };
    // Đơn vừa tạo đọc lại: POS bỏ dòng tặng (hành vi thật 26/09) → CRM PUT bổ sung.
    if (/\/orders\/99001\?api_key=k$/.test(address) && (!options.method || options.method === 'GET')) return { ok: true, status: 200, json: async () => ({ data: { id: 99001, items: [{ variation_id: 'v-GRA-XANH-Z450', quantity: 2 }, { variation_id: 'v-GRA-NAU-Z350', quantity: 1 }] } }) };
    if (/\/orders\/99001\?api_key=k$/.test(address) && options.method === 'PUT') return { ok: true, status: 200, json: async () => ({ success: true }) };
    throw new Error(`gọi lạ: ${address}`);
  };
}

test('pushOrderToPos: kiểm SKU có trong POS, chọn kho có địa chỉ, POST và trả mã đơn POS', async () => {
  const calls = [];
  const created = await pushOrderToPos(order, { config, fetchImpl: posFetch(calls) });
  assert.deepEqual(created, { id: '99001', systemId: '1234', status: 'new' });
  const post = calls.find(call => call.method === 'POST');
  assert.ok(post, 'có lời gọi POST /orders');
  assert.equal(post.body.warehouse_id, 'wh-gn');
  assert.equal(post.body.items.length, 4, 'hai sản phẩm + hai quà (cả hai có trong POS)');
  // Tạo đơn cũng gửi mã mẫu mã nội bộ (UUID): gửi SKU chữ thì POS bỏ âm thầm dòng tặng.
  assert.deepEqual(post.body.items.filter(item => item.is_bonus_product).map(item => item.variation_id), ['v-BGD', 'v-MUONG']);
  assert.ok(post.body.items.every(item => item.variation_id.startsWith('v-')));
  // Mã ba cấp của POS đi kèm để thẻ xác nhận và giao vận có địa chỉ; số nhà/đường gửi riêng.
  assert.equal(post.body.shipping_address.province_id, '705');
  assert.equal(post.body.shipping_address.district_id, '70501');
  assert.equal(post.body.shipping_address.commune_id, '7050127');
  assert.equal(post.body.shipping_address.address, 'Khu phố 6');
  assert.equal(post.body.shipping_address.full_address, order.address);
  // POS bỏ dòng tặng lúc tạo: CRM đọc lại đơn, thấy thiếu BGD/MUONG thì PUT bổ sung cùng giỏ (không gửi trường chỉ-tạo).
  const put = calls.find(call => call.method === 'PUT');
  assert.ok(put, 'có PUT bổ sung quà');
  assert.deepEqual(put.body.items.filter(item => item.is_bonus_product).map(item => item.variation_id), ['v-BGD', 'v-MUONG']);
  assert.equal('custom_id' in put.body, false);
  assert.equal('warehouse_id' in put.body, false);
});

test('resolvePosGeo: khớp tên bỏ dấu và gạch nối; thiếu cấp nào thì dừng ở cấp đó', async () => {
  const { resolvePosGeo, geoNameKey } = await import('../app/pos-orders.mjs');
  assert.equal(geoNameKey('Thành phố Phan Rang – Tháp Chàm'), geoNameKey('Thành phố Phan Rang-Tháp Chàm'));
  const geo = await resolvePosGeo({ province: 'Ninh Thuận', district: 'Thành phố Phan Rang – Tháp Chàm', ward: 'Phường Đông Hải' }, config, posFetch([]));
  assert.deepEqual(geo, { provinceId: '705', districtId: '70501', communeId: '7050127' });
  const partial = await resolvePosGeo({ province: 'Ninh Thuận', district: 'Huyện Không Có', ward: 'Phường Đông Hải' }, config, posFetch([]));
  assert.deepEqual(partial, { provinceId: '705' });
  assert.deepEqual(await resolvePosGeo({ province: '' }, config, posFetch([])), {});
});

test('pushOrderToPos: sản phẩm không có mẫu mã trong POS thì báo lỗi rõ, không tạo đơn; POS từ chối thì ném lỗi', async () => {
  const calls = [];
  await assert.rejects(pushOrderToPos({ ...order, products: [{ name: 'Hạt An Lành', sku: 'MIX5-H420', quantity: 1, price: 269000 }] }, { config, fetchImpl: posFetch(calls) }), /POS không có mẫu mã: MIX5-H420/);
  assert.ok(!calls.some(call => call.method === 'POST'));
  await assert.rejects(pushOrderToPos(order, { config, fetchImpl: posFetch([], { createStatus: 422, createBody: { success: false, message: 'invalid phone' } }) }), /không nhận đơn \(422\): invalid phone/);
});

test('syncOrderToPos ghi kết quả lên đơn trong hội thoại (mã POS hay lỗi) và không đẩy lần hai', async () => {
  await updateMessagingStore(store => {
    const conversation = ensureConversation(store, { pageId: '936023372925639', psid: '27087458000839712', name: 'Pháp Đặng' });
    conversation.pancakeConversationId = '936023372925639_27087458000839712';
    conversation.customerOrders = [{ ...order }];
    return null;
  });
  const calls = [];
  const logs = [];
  const outcome = await syncOrderToPos('936023372925639:27087458000839712', order.id, { config, fetchImpl: posFetch(calls), log: message => logs.push(message) });
  assert.equal(outcome.id, '99001');
  const store = await readMessagingStore();
  const saved = store.conversations[0].customerOrders[0];
  assert.equal(saved.pos.id, '99001');
  assert.ok(saved.pos.at > 0);
  assert.match(logs[0], /#99001/);
  const again = await syncOrderToPos('936023372925639:27087458000839712', order.id, { config, fetchImpl: posFetch(calls) });
  assert.equal(again.id, '99001');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1, 'đã có mã POS thì không POST lại');
});

test('đơn POS do CRM đẩy sang (custom_id CRM-…) được nhận ra để đồng bộ POS không kéo ngược', () => {
  assert.equal(isCrmPushedPosOrder({ custom_id: 'CRM-ab12cd34' }), true);
  assert.equal(isCrmPushedPosOrder({ id: 'CRM-03873', system_id: 52682 }), true, 'POS lấy custom_id làm id và không trả custom_id');
  assert.equal(isCrmPushedPosOrder({ custom_id: 'Ma0001' }), false);
  assert.equal(isCrmPushedPosOrder({}), false);
});

test('updatePosOrder: PUT lên đúng đơn POS với sản phẩm/địa chỉ/phí mới, không gửi lại custom_id/shop_id', async () => {
  const { updatePosOrder } = await import('../app/pos-orders.mjs');
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const address = String(url);
    if (options.method === 'PUT') { calls.push({ address, body: JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ id: 'CRM-ab12cd34' }) }; }
    return posFetch([])(url, options);
  };
  const edited = { ...order, pos: { id: 'CRM-ab12cd34' }, products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 3, price: 149000 }], discount: 0, total: 447000 };
  assert.deepEqual(await updatePosOrder(edited, { config, fetchImpl }), { id: 'CRM-ab12cd34' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].address, /\/shops\/714334721\/orders\/CRM-ab12cd34\?api_key=k$/);
  assert.equal(calls[0].body.custom_id, undefined);
  assert.equal(calls[0].body.shop_id, undefined);
  // Sửa đơn gửi mã mẫu mã nội bộ của POS (UUID), không gửi SKU chữ: POS trả 400
  // "Server internal error" với SKU chữ khi sửa (dù lúc tạo đơn thì nhận).
  assert.deepEqual(calls[0].body.items.map(item => [item.variation_id, item.quantity, item.is_bonus_product]), [['v-GRA-XANH-Z450', 3, false], ['v-BGD', 1, true], ['v-MUONG', 1, true]]);
  assert.equal(calls[0].body.shipping_address.commune_id, '7050127');
  await assert.rejects(updatePosOrder({ ...order }, { config, fetchImpl }), /chưa có trên POS/);
});

test('đơn cũ còn SKU đã đổi trong danh mục (CB10-XANH): đẩy POS bằng SKU hiện tại tra theo tên', async () => {
  const { posSkuFor, buildPosOrderPayload } = await import('../app/pos-orders.mjs');
  assert.equal(posSkuFor({ sku: 'CB10-XANH', name: 'Combo 10 gói Xanh' }), 'CB10-XANH-G35');
  assert.equal(posSkuFor({ sku: 'GRA-XANH-Z450', name: 'Granola Túi Xanh 450g' }), 'GRA-XANH-Z450');
  assert.equal(posSkuFor({ sku: 'LA-LUNG', name: 'Sản phẩm lạ' }), 'LA-LUNG');
  const payload = buildPosOrderPayload({ id: 'x1', name: 'A', phone: '0909123456', address: 'Q1', products: [{ sku: 'CB10-XANH', name: 'Combo 10 gói Xanh', quantity: 2, price: 189000 }], total: 378000 });
  assert.deepEqual(payload.items.map(item => item.variation_id), ['CB10-XANH-G35']);
});

test('Quà Tặng LIVE (đúng 2 túi, SKU QUA-TANG-LIVE): dòng tặng POS giá 0 không đổi tổng, tra được UUID theo display_id; 3 túi chỉ bát + muỗng', async () => {
  const { reloadCatalog } = await import('../app/processing/catalog.mjs');
  const { withPosVariationIds } = await import('../app/pos-orders.mjs');
  const original = readFileSync(process.env.GIFTS_PATH, 'utf8');
  const gifts = JSON.parse(original);
  gifts.items.push({ id: 'qua-tang-live', name: 'Quà Tặng LIVE', active: true, minQuantity: 2, maxQuantity: 2, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 50 });
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  reloadCatalog();
  try {
    const twoBags = {
      ...order, id: 'live2',
      products: [
        { name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1, price: 174000, weight: 450 },
        { name: 'Granola Túi Vàng 350g', sku: 'GRA-VANG-H350', quantity: 1, price: 174000, weight: 350 }
      ],
      discount: 50000, total: 298000, gift: 'Miễn phí vận chuyển + Quà Tặng LIVE'
    };
    const posSkus = new Set(['GRA-XANH-Z450', 'GRA-VANG-H350', 'GRA-NAU-Z350', 'BGD', 'MUONG', 'QUA-TANG-LIVE']);
    const two = buildPosOrderPayload(twoBags, { posSkus });
    assert.deepEqual(two.items.map(item => [item.variation_id, item.quantity, item.variation_info.retail_price, item.is_bonus_product]), [
      ['GRA-XANH-Z450', 1, 174000, false],
      ['GRA-VANG-H350', 1, 174000, false],
      ['QUA-TANG-LIVE', 1, 0, true]
    ]);
    assert.deepEqual(two.items[2].variation_info, { name: 'Quà Tặng LIVE', retail_price: 0, weight: 50 });
    // Quà giá 0 nên tổng POS (niêm yết − giảm + ship) vẫn bằng tổng CRM.
    assert.equal(two.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0) - two.discount + two.shipping_fee, 298000);
    assert.match(two.note, /Quà: Miễn phí vận chuyển \+ Quà Tặng LIVE/);
    // POS chưa có mẫu mã QUA-TANG-LIVE thì bỏ dòng quà, không làm POS từ chối đơn.
    assert.equal(buildPosOrderPayload(twoBags, { posSkus: new Set(['GRA-XANH-Z450', 'GRA-VANG-H350']) }).items.some(item => item.variation_id === 'QUA-TANG-LIVE'), false);
    // 3 túi: bát + muỗng, không kèm quà Live (không đơn nào có cả hai).
    assert.deepEqual(buildPosOrderPayload(order, { posSkus }).items.filter(item => item.is_bonus_product).map(item => item.variation_id), ['BGD', 'MUONG']);
    // Tra UUID theo display_id "QUA-TANG-LIVE" (loadVariations khoá theo display_id viết hoa) — giữ nguyên cờ tặng và giá 0.
    const ids = new Map([['QUA-TANG-LIVE', { id: 'v-QUA-TANG-LIVE', productId: 'p-live' }], ['GRA-XANH-Z450', { id: 'v-GRA-XANH-Z450', productId: 'p-xanh' }]]);
    const mapped = withPosVariationIds(two.items, ids);
    assert.deepEqual(mapped.map(item => [item.variation_id, item.product_id || '', item.is_bonus_product, item.variation_info.retail_price]), [
      ['v-GRA-XANH-Z450', 'p-xanh', false, 174000],
      ['GRA-VANG-H350', '', false, 174000],
      ['v-QUA-TANG-LIVE', 'p-live', true, 0]
    ]);
  } finally {
    writeFileSync(process.env.GIFTS_PATH, original);
    reloadCatalog();
  }
});

test('Quà Tặng LIVE chỉ khách livestream (livestreamOnly): đơn khách thường 2 túi KHÔNG có dòng QUA-TANG-LIVE; đơn order.livestream / liveOrder / địa chỉ "(Live)" có', async () => {
  const { reloadCatalog } = await import('../app/processing/catalog.mjs');
  const original = readFileSync(process.env.GIFTS_PATH, 'utf8');
  const gifts = JSON.parse(original);
  // R17: quà live 08/10 — bảng quà seed đã có Quạt (live-quat, cùng SKU QUA-TANG-LIVE); test giữ quà sống 28/09 nên bỏ live-quat.
  gifts.items = gifts.items.filter(gift => gift.id !== 'live-quat');
  gifts.items.push({ id: 'qua-tang-live', name: 'Quà Tặng LIVE', active: true, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 50 });
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  reloadCatalog();
  try {
    const twoBags = {
      ...order, id: 'live3',
      products: [
        { name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1, price: 174000, weight: 450 },
        { name: 'Granola Túi Vàng 350g', sku: 'GRA-VANG-H350', quantity: 1, price: 174000, weight: 350 }
      ],
      discount: 50000, total: 298000, gift: 'Miễn phí vận chuyển'
    };
    const posSkus = new Set(['GRA-XANH-Z450', 'GRA-VANG-H350', 'GRA-NAU-Z350', 'BGD', 'MUONG', 'QUA-TANG-LIVE']);
    const bonus = payload => payload.items.filter(item => item.is_bonus_product).map(item => item.variation_id);
    // Lỗi 28/09: đơn 2 túi của khách thường (không cờ) nhận quà live → giờ không còn.
    assert.deepEqual(bonus(buildPosOrderPayload(twoBags, { posSkus })), []);
    assert.deepEqual(bonus(buildPosOrderPayload({ ...twoBags, livestream: false }, { posSkus })), []);
    // Đơn khách livestream: cờ mới order.livestream, cờ cũ liveOrder, hay địa chỉ nhân viên ghi "(Live) ".
    const live = buildPosOrderPayload({ ...twoBags, livestream: true, gift: 'Miễn phí vận chuyển + Quà Tặng LIVE' }, { posSkus });
    assert.deepEqual(bonus(live), ['QUA-TANG-LIVE']);
    assert.deepEqual(live.items[2].variation_info, { name: 'Quà Tặng LIVE', retail_price: 0, weight: 50 });
    assert.equal(live.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0) - live.discount + live.shipping_fee, 298000);
    assert.deepEqual(bonus(buildPosOrderPayload({ ...twoBags, liveOrder: true }, { posSkus })), ['QUA-TANG-LIVE']);
    assert.deepEqual(bonus(buildPosOrderPayload({ ...twoBags, address: `(Live) ${twoBags.address}` }, { posSkus })), ['QUA-TANG-LIVE']);
    // Khách live 3 túi: trần 2 túi vẫn giữ → bát + muỗng, không quà live.
    assert.deepEqual(bonus(buildPosOrderPayload({ ...order, livestream: true }, { posSkus })), ['BGD', 'MUONG']);
    // POS chưa có mẫu mã QUA-TANG-LIVE thì bỏ dòng quà dù là đơn live.
    assert.deepEqual(bonus(buildPosOrderPayload({ ...twoBags, livestream: true }, { posSkus: new Set(['GRA-XANH-Z450', 'GRA-VANG-H350']) })), []);
  } finally {
    writeFileSync(process.env.GIFTS_PATH, original);
    reloadCatalog();
  }
});

test('đơn lẻ 1 túi có phí ship (15k): POS gộp ship vào đơn giá túi (174k + 15k = 189k) và gửi ship 0đ; đơn freeship hoặc nhiều túi thì không gộp', () => {
  // 1. Đơn 1 Túi Xanh: CRM tính 174k + 15k ship = 189k → POS nhận đơn giá 189k, ship 0đ, is_free_shipping true
  const singleGreen = {
    ...order,
    id: 'single1',
    products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1, price: 174000, weight: 450 }],
    shippingFee: 15000,
    freeShipping: false,
    discount: 0,
    total: 189000
  };
  const payloadGreen = buildPosOrderPayload(singleGreen);
  assert.equal(payloadGreen.items.length, 1);
  assert.equal(payloadGreen.items[0].variation_info.retail_price, 189000);
  assert.equal(payloadGreen.shipping_fee, 0);
  assert.equal(payloadGreen.is_free_shipping, true);
  const subtotalGreen = payloadGreen.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0);
  assert.equal(subtotalGreen - payloadGreen.discount + payloadGreen.shipping_fee, singleGreen.total);

  // 2. Đơn 1 sản phẩm khác (Túi Nâu 164k + 15k ship = 179k): tương tự gộp vào đơn giá
  const singleBrown = {
    ...order,
    id: 'single2',
    products: [{ name: 'Granola Túi Nâu vị cacao 350g', sku: 'GRA-NAU-Z350', quantity: 1, price: 164000, weight: 350 }],
    shippingFee: 15000,
    freeShipping: false,
    discount: 0,
    total: 179000
  };
  const payloadBrown = buildPosOrderPayload(singleBrown);
  assert.equal(payloadBrown.items.length, 1);
  assert.equal(payloadBrown.items[0].variation_info.retail_price, 179000);
  assert.equal(payloadBrown.shipping_fee, 0);
  assert.equal(payloadBrown.is_free_shipping, true);
  const subtotalBrown = payloadBrown.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0);
  assert.equal(subtotalBrown - payloadBrown.discount + payloadBrown.shipping_fee, singleBrown.total);

  // 3. Đơn 1 túi nhưng được miễn phí ship (freeShipping: true / shippingFee: 0): giữ nguyên đơn giá 174k
  const singleFree = {
    ...order,
    id: 'single3',
    products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1, price: 174000, weight: 450 }],
    shippingFee: 0,
    freeShipping: true,
    discount: 0,
    total: 174000
  };
  const payloadFree = buildPosOrderPayload(singleFree);
  assert.equal(payloadFree.items.length, 1);
  assert.equal(payloadFree.items[0].variation_info.retail_price, 174000);
  assert.equal(payloadFree.shipping_fee, 0);
  assert.equal(payloadFree.is_free_shipping, true);
  assert.equal(payloadFree.items[0].variation_info.retail_price, singleFree.total);

  // 4. Đơn 2 túi không gộp vào đơn giá
  const twoBags = {
    ...order,
    id: 'multi1',
    products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2, price: 174000, weight: 450 }],
    shippingFee: 0,
    freeShipping: true,
    discount: 50000,
    total: 298000
  };
  const payloadTwo = buildPosOrderPayload(twoBags, { posSkus: new Set(['GRA-XANH-Z450']) });
  assert.equal(payloadTwo.items[0].variation_info.retail_price, 174000);
});

