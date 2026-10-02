// R13 (api) — đơn khách ĐỔI QUÀ đẩy lên Pancake POS (app/pos-orders.mjs).
// Trước đây dòng quà dựng thẳng từ bảng quà theo giỏ (giftsForKey): khách đã đổi bát + muỗng (hay quạt + bát live) lấy
// 2 gói granola nhỏ thì đơn POS vẫn lên bát + muỗng. Bộ soạn đơn nay ghi `order.giftSwap = [{ name, sku, weight }]`
// (quà thay thế) và `order.giftSwapRemoved = [tên quà bị thay]`. POS dùng stub (fetchImpl), không gọi mạng.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('r13-api-giftswap-');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.POS_COMBOS_PATH = path.join(directory, 'pos-combos.json');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.POS_PUSH_ORDERS = '1';
await import('./helpers/seed-catalog.mjs');

const { buildPosOrderPayload, posGiftSwapFlag, posGiftSwapPlan, pushOrderToPos, syncOrderToPos } = await import('../app/pos-orders.mjs');
const { updateMessagingStore, ensureConversation, readMessagingStore } = await import('../app/messaging-store.mjs');
const { orderProcessingNotes } = await import('../app/order-edits.mjs');

const config = { apiKey: 'k', shopId: '714334721', baseUrl: 'https://pos.example/api/v1' };
const SMALL_XANH = { name: 'Gói granola nhỏ Xanh 35g', sku: 'GRA-XANH-G35', weight: 35 };
const SMALL_CAM = { name: 'Gói granola nhỏ Cam 30g', sku: 'GRA-CAM-G30', weight: 30 };
const threeBags = (overrides = {}) => ({
  id: 'gs3001', name: 'Khách đổi quà', phone: '0385805700', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh',
  products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 3, price: 174000, paidPrice: 149000, weight: 450 }],
  freeShipping: true, shippingFee: 0, discount: 75000, total: 447000,
  gift: 'Miễn phí vận chuyển + 1 Gói granola nhỏ Xanh 35g + 1 Gói granola nhỏ Cam 30g (đổi quà: thay Bộ bát gáo dừa + Muỗng dừa)',
  employee: 'Chatbot AI', ...overrides
});
const ALL_SKUS = new Set(['GRA-XANH-Z450', 'GRA-VANG-H350', 'GRA-NAU-Z350', 'CB3-XANH-Z450+BGD+M', 'CB2-XANH-Z450', 'BGD', 'MUONG', 'GRA-XANH-G35', 'GRA-CAM-G30', 'GRA-NAU-G35']);
const lines = payload => payload.items.map(item => [item.variation_id, item.quantity, item.is_bonus_product, item.variation_info.retail_price]);

test('đơn KHÔNG đổi quà chạy y như cũ: 3 Xanh → mã combo POS đã gồm bát + muỗng; giỏ 3 vị → combo + dòng tặng BGD, MUONG', () => {
  assert.equal(posGiftSwapPlan(threeBags()), null);
  assert.deepEqual(lines(buildPosOrderPayload(threeBags(), { posSkus: ALL_SKUS })), [['CB3-XANH-Z450+BGD+M', 1, false, 447000]]);
  const noCombo = buildPosOrderPayload(threeBags(), { posSkus: new Set(['GRA-XANH-Z450', 'BGD', 'MUONG']) });
  assert.deepEqual(lines(noCombo), [['GRA-XANH-Z450', 3, false, 174000], ['BGD', 1, true, 0], ['MUONG', 1, true, 0]]);
  assert.doesNotMatch(noCombo.note, /Đổi quà/);
});

test('đổi quà (bát + muỗng → 1 gói Xanh + 1 gói Cam): không lên bát/muỗng, không dùng mã combo đã gồm quà, thêm 2 dòng tặng gói nhỏ; tiền không đổi', () => {
  const order = threeBags({ giftSwap: [SMALL_XANH, SMALL_CAM], giftSwapRemoved: ['Bộ bát gáo dừa', 'Muỗng dừa'] });
  const payload = buildPosOrderPayload(order, { posSkus: ALL_SKUS });
  assert.deepEqual(lines(payload), [['GRA-XANH-Z450', 3, false, 174000], ['GRA-XANH-G35', 1, true, 0], ['GRA-CAM-G30', 1, true, 0]]);
  assert.equal(payload.discount, 75000, 'đẩy từng túi + giảm giá: tổng hàng vẫn 447.000đ');
  assert.equal(payload.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0) - payload.discount, 447000);
  assert.match(payload.note, /đổi quà: thay Bộ bát gáo dừa \+ Muỗng dừa/);
  assert.doesNotMatch(payload.note, /chưa có mã POS/);
  // Hai gói cùng vị gộp một dòng số lượng 2.
  const same = buildPosOrderPayload(threeBags({ giftSwap: [SMALL_XANH, SMALL_XANH], giftSwapRemoved: ['Bộ bát gáo dừa', 'Muỗng dừa'] }), { posSkus: ALL_SKUS });
  assert.deepEqual(lines(same).slice(1), [['GRA-XANH-G35', 2, true, 0]]);
  // Chỉ đổi bát (giữ muỗng): muỗng vẫn lên.
  const bowlOnly = buildPosOrderPayload(threeBags({ giftSwap: [SMALL_XANH, SMALL_CAM], giftSwapRemoved: ['Bộ bát gáo dừa'] }), { posSkus: ALL_SKUS });
  assert.deepEqual(lines(bowlOnly).map(line => line[0]), ['GRA-XANH-Z450', 'MUONG', 'GRA-XANH-G35', 'GRA-CAM-G30']);
  // Thiếu danh sách quà bị thay (dữ liệu cũ): coi như thay mọi quà hiện vật đổi được.
  const noList = buildPosOrderPayload(threeBags({ giftSwap: [SMALL_XANH, SMALL_CAM] }), { posSkus: ALL_SKUS });
  assert.deepEqual(lines(noList).map(line => line[0]), ['GRA-XANH-Z450', 'GRA-XANH-G35', 'GRA-CAM-G30']);
});

test('đổi quà mà POS CHƯA có mã gói nhỏ, hay khách chưa chọn vị → KHÔNG đoán mã khác: không lên bát/muỗng, ghi chú đơn POS + ghi chú xử lý cho nhân viên', () => {
  const posSkus = new Set(['GRA-XANH-Z450', 'BGD', 'MUONG', 'GRA-XANH-G35']);
  const order = threeBags({ giftSwap: [SMALL_XANH, SMALL_CAM], giftSwapRemoved: ['Bộ bát gáo dừa', 'Muỗng dừa'] });
  const plan = posGiftSwapPlan(order, posSkus);
  assert.deepEqual(plan.lines.map(line => [line.sku, line.quantity]), [['GRA-XANH-G35', 1]]);
  assert.deepEqual(plan.missing, ['Gói granola nhỏ Cam 30g (GRA-CAM-G30)']);
  const payload = buildPosOrderPayload(order, { posSkus });
  assert.deepEqual(lines(payload), [['GRA-XANH-Z450', 3, false, 174000], ['GRA-XANH-G35', 1, true, 0]]);
  assert.match(payload.note, /⚠ Đổi quà: chưa có mã POS cho Gói granola nhỏ Cam 30g \(GRA-CAM-G30\) — nhân viên thêm quà thay thế/);
  assert.match(payload.note, /đổi quà: thay Bộ bát gáo dừa \+ Muỗng dừa/, 'ghi chú "đổi quà: …" của đơn vẫn giữ');
  assert.equal(posGiftSwapFlag(plan.missing), '⚠ Đổi quà: POS chưa có Gói granola nhỏ Cam 30g (GRA-CAM-G30) — nhân viên thêm quà thay thế trên POS');
  // Khách chưa chọn vị (sku rỗng): cả hai gói đều thiếu, vẫn không lên bát/muỗng.
  const unchosen = threeBags({ giftSwap: [{ name: 'Gói granola nhỏ (vị khách chọn)', sku: '', weight: 35 }, { name: 'Gói granola nhỏ (vị khách chọn)', sku: '', weight: 35 }], giftSwapRemoved: ['Bộ bát gáo dừa', 'Muỗng dừa'] });
  const unchosenPayload = buildPosOrderPayload(unchosen, { posSkus: ALL_SKUS });
  assert.deepEqual(lines(unchosenPayload), [['GRA-XANH-Z450', 3, false, 174000]]);
  assert.match(unchosenPayload.note, /chưa có mã POS cho Gói granola nhỏ \(vị khách chọn\) — nhân viên thêm quà thay thế/);
});

test('đơn 2 túi có bát ưu đãi bám đuổi (promoGift) mà khách đổi bát lấy gói nhỏ: không đẩy bát', () => {
  const twoBags = {
    id: 'gs2001', name: 'Khách bám đuổi', phone: '0385805701', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh',
    products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2, price: 174000, weight: 450 }],
    freeShipping: true, shippingFee: 0, discount: 50000, total: 298000, promoGift: 'Bộ bát gáo dừa'
  };
  const posSkus = new Set(['GRA-XANH-Z450', 'BGD', 'MUONG', 'GRA-XANH-G35', 'GRA-CAM-G30']);
  assert.deepEqual(lines(buildPosOrderPayload(twoBags, { posSkus })).map(line => line[0]), ['GRA-XANH-Z450', 'BGD'], 'không đổi quà: bát ưu đãi vẫn lên như cũ');
  const swapped = buildPosOrderPayload({ ...twoBags, giftSwap: [SMALL_XANH, SMALL_CAM], giftSwapRemoved: ['Bộ bát gáo dừa'] }, { posSkus });
  assert.deepEqual(lines(swapped).map(line => line[0]), ['GRA-XANH-Z450', 'GRA-XANH-G35', 'GRA-CAM-G30']);
});

// Stub POS: có GRA-XANH-G35, KHÔNG có GRA-CAM-G30 (bộ đệm mẫu mã của pos-orders giữ 1 giờ nên cả tệp dùng một danh sách).
function posStub(calls) {
  const variations = ['GRA-XANH-Z450', 'CB3-XANH-Z450+BGD+M', 'BGD', 'MUONG', 'GRA-XANH-G35'];
  const created = [];
  return async (url, options = {}) => {
    const address = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ address, method: options.method || 'GET', body });
    if (address.includes('/products/variations')) return { ok: true, status: 200, json: async () => ({ data: variations.map(sku => ({ id: `v-${sku}`, product_id: `p-${sku}`, display_id: sku })) }) };
    if (address.includes('/warehouses')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'wh-1', name: 'Kho', province_id: '701', allow_create_order: true }] }) };
    if (address.includes('/geo/')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (/\/orders\?api_key=k$/.test(address) && options.method === 'POST') {
      created.push(body);
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 88001, system_id: 4321, status_name: 'new' } }) };
    }
    // Đọc lại đơn vừa tạo: POS giữ đủ dòng (kể cả dòng tặng) → không cần PUT bổ sung.
    if (/\/orders\/88001\?api_key=k$/.test(address) && (!options.method || options.method === 'GET')) return { ok: true, status: 200, json: async () => ({ data: { id: 88001, items: created.at(-1)?.items || [] } }) };
    if (/\/orders\/88001\?api_key=k$/.test(address) && options.method === 'PUT') return { ok: true, status: 200, json: async () => ({ success: true }) };
    throw new Error(`gọi lạ: ${options.method || 'GET'} ${address}`);
  };
}

test('stub POS: đẩy đơn đổi quà — POST không có bát/muỗng, có dòng tặng gói Xanh; gói Cam POS chưa có mã → kết quả kèm giftSwapMissing và đơn CRM nhận ghi chú xử lý', async () => {
  const order = threeBags({ giftSwap: [SMALL_XANH, SMALL_CAM], giftSwapRemoved: ['Bộ bát gáo dừa', 'Muỗng dừa'] });
  const calls = [];
  const created = await pushOrderToPos(order, { config, fetchImpl: posStub(calls) });
  assert.equal(created.id, '88001');
  assert.deepEqual(created.giftSwapMissing, ['Gói granola nhỏ Cam 30g (GRA-CAM-G30)']);
  const post = calls.find(call => call.method === 'POST');
  assert.deepEqual(post.body.items.map(item => [item.variation_id, item.quantity, item.is_bonus_product]), [['v-GRA-XANH-Z450', 3, false], ['v-GRA-XANH-G35', 1, true]]);
  assert.equal(post.body.items.some(item => /BGD|MUONG/.test(item.variation_id)), false, 'bát + muỗng khách đã đổi không lên POS');
  assert.match(post.body.note, /⚠ Đổi quà: chưa có mã POS cho Gói granola nhỏ Cam 30g/);
  // Qua syncOrderToPos (đường bot chốt / nút Đẩy sang POS): ghi chú xử lý nằm trên đơn trong kho.
  await updateMessagingStore(store => {
    const conversation = ensureConversation(store, { pageId: '936023372925639', psid: 'u-giftswap', name: 'Khách đổi quà' });
    conversation.customerOrders = [{ ...order }, { ...threeBags({ id: 'gs3002' }) }];
    return null;
  });
  const outcome = await syncOrderToPos('936023372925639:u-giftswap', order.id, { config, fetchImpl: posStub([]), log: () => {} });
  assert.equal(outcome.id, '88001');
  const saved = (await readMessagingStore()).conversations[0].customerOrders.find(item => item.id === order.id);
  assert.deepEqual(saved.processingFlags, ['⚠ Đổi quà: POS chưa có Gói granola nhỏ Cam 30g (GRA-CAM-G30) — nhân viên thêm quà thay thế trên POS']);
  assert.equal(orderProcessingNotes(saved)[0], saved.processingFlags[0]);
  // Đơn không đổi quà trong cùng hội thoại: đẩy như cũ, không có ghi chú xử lý nào được thêm.
  const plainCalls = [];
  const plain = await syncOrderToPos('936023372925639:u-giftswap', 'gs3002', { config, fetchImpl: posStub(plainCalls), log: () => {} });
  assert.equal(plain.giftSwapMissing, undefined);
  assert.deepEqual(plainCalls.find(call => call.method === 'POST').body.items.map(item => item.variation_id), ['v-CB3-XANH-Z450+BGD+M']);
  assert.equal((await readMessagingStore()).conversations[0].customerOrders.find(item => item.id === 'gs3002').processingFlags, undefined);
});
