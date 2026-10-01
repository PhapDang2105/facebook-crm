// C1: POS trả 2xx mà không đọc được thân/không có mã → "chưa chắc", mọi lần đẩy lại kiểm POS trước,
// lần đẩy lại không xoá cờ "chưa chắc" cũ. T11: đồng bộ nội dung POS không đè địa chỉ nhân viên sửa
// trong CRM (đơn landing không PUT sang POS).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('fix-store-pos-');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.LANDING_ORDERS_PATH = path.join(directory, 'landing-orders.json');
process.env.ORDER_ARCHIVE_PATH = path.join(directory, 'order-archive');
process.env.POS_PUSH_ORDERS = '1';

await import('./helpers/seed-catalog.mjs');
const { pushOrderToPos, syncOrderToPos } = await import('../app/pos-orders.mjs');
const { applyPosContent, needsPosContent, indexPosOrders } = await import('../app/pos-content-sync.mjs');
const { applyCustomerOrderEdits } = await import('../app/order-edits.mjs');
const { updateMessagingStore, ensureConversation, readMessagingStore } = await import('../app/messaging-store.mjs');

const XANH = 'GRA-XANH-Z450';
const ADDRESS = '12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
const config = { apiKey: 'k', shopId: '714334721', baseUrl: 'https://pos.example/api/v1' };

/** POS giả: `state.post` quyết định phản hồi POST ('ok' | 'unreadable' | 'noid' | 'reject'). */
function posMock(state) {
  return async (url, options = {}) => {
    const address = String(url);
    const method = options.method || 'GET';
    state.calls.push({ address, method });
    if (address.includes('/products/variations')) return { ok: true, status: 200, json: async () => ({ data: [{ id: `v-${XANH}`, display_id: XANH }] }) };
    if (address.includes('/warehouses')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'wh-1', province_id: '701', allow_create_order: true }] }) };
    if (method === 'POST' && /\/orders\?api_key=k$/.test(address)) {
      if (state.post === 'unreadable') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
      if (state.post === 'noid') return { ok: true, status: 200, json: async () => ({ success: true }) };
      if (state.post === 'reject') return { ok: false, status: 422, json: async () => ({ success: false, message: 'custom_id đã tồn tại' }) };
      return { ok: true, status: 200, json: async () => ({ data: { id: 99001, system_id: 9, status_name: 'new' } }) };
    }
    if (method === 'GET' && /\/orders\?/.test(address) && address.includes('search=')) {
      if (state.search === 'fail') return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: state.posOrders || [] }) };
    }
    if (method === 'GET' && /\/orders\/[^?]+\?/.test(address)) return { ok: true, status: 200, json: async () => ({ data: { items: [] } }) };
    throw new Error(`gọi lạ: ${method} ${address}`);
  };
}

async function seedOrder(id, pos) {
  await updateMessagingStore(store => {
    const conversation = ensureConversation(store, { pageId: 'p9', psid: `u-${id}`, name: 'Khách POS' });
    conversation.customerOrders = [{ id, name: 'Khách POS', phone: '0385805790', address: ADDRESS, products: [{ name: 'Granola Túi Xanh 450g', sku: XANH, quantity: 1, price: 174000, weight: 450 }], shippingFee: 15000, freeShipping: false, discount: 0, total: 189000, ...(pos ? { pos } : {}) }];
    return null;
  });
  return `p9:u-${id}`;
}
const posts = state => state.calls.filter(call => call.method === 'POST').length;
const searches = state => state.calls.filter(call => call.method === 'GET' && call.address.includes('search=')).length;
const order = { id: 'c1x', name: 'Khách POS', phone: '0385805790', address: ADDRESS, products: [{ name: 'Granola Túi Xanh 450g', sku: XANH, quantity: 1, price: 174000 }], shippingFee: 15000, total: 189000 };

test('C1: POS trả 200 nhưng thân phản hồi hỏng / không có mã đơn → lỗi "chưa chắc", không phải "POS từ chối"', async () => {
  for (const post of ['unreadable', 'noid']) {
    const state = { calls: [], post };
    await assert.rejects(pushOrderToPos(order, { config, fetchImpl: posMock(state) }), error => {
      assert.equal(error.uncertain, true, post);
      assert.match(error.message, /có thể đã lên POS/);
      return true;
    });
  }
  // POS từ chối rõ ràng (4xx) vẫn là lỗi chắc chắn.
  const state = { calls: [], post: 'reject' };
  await assert.rejects(pushOrderToPos(order, { config, fetchImpl: posMock(state) }), error => error.uncertain === undefined);
});

test('C1: lần đẩy đầu 200-không-đọc-được → hỏi lại POS ngay; đẩy lại thấy đơn trên POS thì nhận mã, không POST lần hai', async () => {
  const conversationId = await seedOrder('c1a');
  const state = { calls: [], post: 'unreadable', posOrders: [] };
  const first = await syncOrderToPos(conversationId, 'c1a', { config, fetchImpl: posMock(state), log: () => {} });
  assert.equal(first.uncertain, true);
  assert.equal(posts(state), 1);
  assert.equal(searches(state), 1, 'hỏi lại POS ngay sau phản hồi hỏng');
  state.posOrders = [{ id: 'CRM-c1a', custom_id: 'CRM-c1a', note: 'Đơn CRM #c1a', status: 0 }];
  state.post = 'ok';
  const retry = await syncOrderToPos(conversationId, 'c1a', { config, fetchImpl: posMock(state), log: () => {} });
  assert.equal(retry.id, 'CRM-c1a');
  assert.equal(posts(state), 1, 'không tạo đơn POS thứ hai');
});

test('C1: đơn có lỗi cũ (kể cả lỗi "chắc chắn") → đẩy lại luôn kiểm POS trước; đã có thì nhận mã', async () => {
  const conversationId = await seedOrder('c1b', { error: 'Pancake POS không nhận đơn (200): không rõ lý do', at: 1 });
  const state = { calls: [], post: 'ok', posOrders: [{ id: 'CRM-c1b', custom_id: 'CRM-c1b', status: 0 }] };
  const retry = await syncOrderToPos(conversationId, 'c1b', { config, fetchImpl: posMock(state), log: () => {} });
  assert.equal(retry.id, 'CRM-c1b');
  assert.equal(retry.recovered, true);
  assert.equal(posts(state), 0);
  // Lỗi cũ chắc chắn, POS chưa có đơn → đẩy bình thường.
  const other = await seedOrder('c1c', { error: 'POS không có mẫu mã', at: 1 });
  const fresh = { calls: [], post: 'ok', posOrders: [] };
  const pushed = await syncOrderToPos(other, 'c1c', { config, fetchImpl: posMock(fresh), log: () => {} });
  assert.equal(pushed.id, '99001');
  assert.equal(searches(fresh) >= 1 && posts(fresh), 1);
});

test('C1: lần đẩy lại bị POS từ chối rõ ràng không xoá cờ "chưa chắc" của lần trước', async () => {
  const conversationId = await seedOrder('c1d', { error: 'Pancake POS không phản hồi', uncertain: true, at: 1 });
  const state = { calls: [], post: 'reject', posOrders: [] };
  const outcome = await syncOrderToPos(conversationId, 'c1d', { config, fetchImpl: posMock(state), log: () => {} });
  assert.match(outcome.error, /422/);
  assert.equal(outcome.uncertain, true, 'vẫn "chưa chắc": lần trước có thể đã tạo đơn');
  const saved = (await readMessagingStore()).conversations.find(item => item.id === conversationId).customerOrders[0];
  assert.equal(saved.pos.uncertain, true);
});

// ===== T11 =====

const posOrder = (extra = {}) => ({
  id: 51946, status: 1, bill_full_name: 'Lan', bill_phone_number: '0912345678', shipping_fee: 0, is_free_shipping: true, cod: 189000,
  shipping_address: { address: '12 Lê Lợi', commune_name: 'Phường Bến Nghé', district_name: 'Quận 1', province_name: 'Hồ Chí Minh', full_address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, Hồ Chí Minh' },
  items: [{ quantity: 1, variation_info: { display_id: XANH, name: 'Túi Xanh', retail_price: 189000 } }],
  updated_at: '2026-10-01T01:00:00.000000', ...extra
});
const landingOrder = () => ({
  id: 'L1', source: 'Landing page', landing: { posId: '51946' }, name: 'Lan', phone: '0912345678',
  address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, Hồ Chí Minh', total: 189000, freeShipping: true, shippingFee: 0,
  products: [{ sku: XANH, quantity: 1, price: 189000 }], createdAt: Date.parse('2026-10-01T00:00:00Z')
});
const NEW_ADDRESS = '99 Hai Bà Trưng, Phường Bến Nghé, Quận 1, Hồ Chí Minh';

test('T11: nhân viên sửa địa chỉ trong CRM (đơn landing), POS sau đó đổi phí ship → chép phí ship, KHÔNG đè địa chỉ', () => {
  const order = landingOrder();
  applyPosContent(order, posOrder(), { now: Date.parse('2026-10-01T01:01:00Z') });
  assert.ok(order.posContent.values, 'dấu kèm giá trị từng trường');
  applyCustomerOrderEdits(order, { address: NEW_ADDRESS }, Date.parse('2026-10-01T02:00:00Z'));
  const result = applyPosContent(order, posOrder({ shipping_fee: 30000, is_free_shipping: false, cod: 219000, updated_at: '2026-10-01T05:00:00.000000' }), { now: Date.parse('2026-10-01T05:01:00Z') });
  assert.equal(order.address, NEW_ADDRESS, 'địa chỉ nhân viên sửa còn nguyên');
  assert.ok(result.changed.includes('phí ship'));
  assert.equal(order.shippingFee, 30000);
  assert.ok(!result.changed.includes('địa chỉ'));
  // POS thật sự đổi địa chỉ sau đó → vẫn chép (nhân viên sửa trên POS).
  const moved = posOrder({ shipping_fee: 30000, is_free_shipping: false, cod: 219000, updated_at: '2026-10-01T07:00:00.000000', shipping_address: { address: '7 Pasteur', commune_name: 'Phường Bến Nghé', district_name: 'Quận 1', province_name: 'Hồ Chí Minh', full_address: '7 Pasteur, Phường Bến Nghé, Quận 1, Hồ Chí Minh' } });
  const again = applyPosContent(order, moved, { now: Date.parse('2026-10-01T07:01:00Z') });
  assert.ok(again.changed.includes('địa chỉ'));
  assert.match(order.address, /7 Pasteur/);
});

test('T11: dấu cũ (chưa có values) → ghi lại một lần; nếu POS đổi mà nhân viên đã sửa địa chỉ sau dấu thì giữ bản CRM', () => {
  const order = landingOrder();
  applyPosContent(order, posOrder(), { now: Date.parse('2026-10-01T01:01:00Z') });
  delete order.posContent.values; // giả dấu ghi trước bản sửa này
  assert.equal(needsPosContent(order, indexPosOrders([posOrder()])), true, 'dấu thiếu values được ghi lại');
  order.address = NEW_ADDRESS;
  order.editedByStaffAt = Date.parse('2026-10-01T02:00:00Z'); // đơn sửa trước khi có staffEdited
  applyPosContent(order, posOrder({ shipping_fee: 30000, is_free_shipping: false, cod: 219000, updated_at: '2026-10-01T05:00:00.000000' }), { now: Date.parse('2026-10-01T05:01:00Z') });
  assert.equal(order.address, NEW_ADDRESS);
  // Không biết nhân viên sửa nhóm nào (chỉ có editedByStaffAt) → giữ bản CRM cho mọi nhóm; dấu mới
  // có values nên lượt sau so được từng trường.
  assert.ok(order.posContent.values);
  // Đơn có staffEdited rõ ràng: chỉ nhóm địa chỉ được giữ, phí ship POS vẫn chép.
  const precise = landingOrder();
  applyPosContent(precise, posOrder(), { now: Date.parse('2026-10-01T01:01:00Z') });
  delete precise.posContent.values;
  applyCustomerOrderEdits(precise, { address: NEW_ADDRESS }, Date.parse('2026-10-01T02:00:00Z'));
  applyPosContent(precise, posOrder({ shipping_fee: 30000, is_free_shipping: false, cod: 219000, updated_at: '2026-10-01T05:00:00.000000' }), { now: Date.parse('2026-10-01T05:01:00Z') });
  assert.equal(precise.address, NEW_ADDRESS);
  assert.equal(precise.shippingFee, 30000);
});
