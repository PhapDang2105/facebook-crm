import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'posorders-'));
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.POS_PUSH_ORDERS = '1';

await import('./helpers/seed-catalog.mjs');
const { buildPosOrderPayload, pushOrderToPos, isCrmPushedPosOrder, syncOrderToPos } = await import('../app/pos-orders.mjs');
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
  assert.equal(payload.total_discount, 70000);
  assert.equal(payload.shipping_fee, 0);
  assert.equal(payload.is_free_shipping, true);
  assert.equal(payload.warehouse_id, 'wh-1');
  assert.equal(payload.page_id, '936023372925639');
  assert.equal(payload.conversation_id, '936023372925639_27087458000839712');
  assert.match(payload.note, /Đơn CRM #ab12cd34/);
  assert.match(payload.note, /Khách ghi: Giao giờ hành chính/);
  // Tổng POS = niêm yết − giảm + ship = tổng CRM.
  const subtotal = payload.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0);
  assert.equal(subtotal - payload.total_discount + payload.shipping_fee, order.total);
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
  // Mã ba cấp của POS đi kèm để thẻ xác nhận và giao vận có địa chỉ; số nhà/đường gửi riêng.
  assert.equal(post.body.shipping_address.province_id, '705');
  assert.equal(post.body.shipping_address.district_id, '70501');
  assert.equal(post.body.shipping_address.commune_id, '7050127');
  assert.equal(post.body.shipping_address.address, 'Khu phố 6');
  assert.equal(post.body.shipping_address.full_address, order.address);
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
  await assert.rejects(pushOrderToPos({ ...order, products: [{ name: 'Hạt An Lành', sku: 'HAL-HU', quantity: 1, price: 269000 }] }, { config, fetchImpl: posFetch(calls) }), /POS không có mẫu mã: HAL-HU/);
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
