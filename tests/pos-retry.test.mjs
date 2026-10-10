// 10/10: Pancake POS chậm vài phút → đơn bot chốt báo "Chưa đẩy được" và đứng đó tới khi có người bấm. Máy chủ tự đẩy
// lại đơn lỗi (24 giờ, mỗi 5 phút, tối đa 6 lần), luôn kiểm POS trước để không tạo đơn thứ hai.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('pos-retry-');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.PHONE_WARNINGS_PATH = path.join(directory, 'phone-warnings.json');
process.env.POS_PUSH_ORDERS = '1';

await import('./helpers/seed-catalog.mjs');
const { POS_RETRY_MAX, posRetryDue, retryFailedPosPushes, syncOrderToPos } = await import('../app/pos-orders.mjs');
const { updateMessagingStore, ensureConversation, readMessagingStore } = await import('../app/messaging-store.mjs');

const HOUR = 60 * 60 * 1000;
const config = { apiKey: 'k', shopId: '714334721', baseUrl: 'https://pos.example/api/v1' };

test('đơn đáng tự đẩy lại: lỗi, chưa có mã, trong 24 giờ, chưa hủy, chưa quá số lần, cách lần trước ≥ 5 phút', () => {
  const now = Date.now();
  const order = (pos, extra = {}) => ({ createdAt: now - HOUR, status: 'Mới', pos, ...extra });
  assert.equal(posRetryDue(order({ error: 'This operation was aborted', at: now - 10 * 60 * 1000 }), now), true);
  assert.equal(posRetryDue(order({ error: 'x', at: now - 60 * 1000 }), now), false, 'vừa lỗi chưa đầy 5 phút');
  assert.equal(posRetryDue(order({ id: '1' }), now), false, 'đã có mã POS');
  assert.equal(posRetryDue(order(undefined), now), false, 'chưa từng đẩy (đơn chưa bật đẩy POS)');
  assert.equal(posRetryDue(order({ error: 'x', at: 0 }, { status: 'Hủy' }), now), false);
  assert.equal(posRetryDue(order({ error: 'x', at: 0 }, { createdAt: now - 25 * HOUR }), now), false, 'quá 24 giờ');
  assert.equal(posRetryDue(order({ error: 'x', at: 0, retries: POS_RETRY_MAX }), now), false, 'đã thử đủ số lần');
});

test('tự đẩy lại: lần đầu POS hết giờ → lỗi (retries 0); lượt tự đẩy kiểm POS trước rồi tạo đơn một lần', async () => {
  const order = {
    id: 'retry001', name: 'Hồng Nga', phone: '0327891843', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, Hồ Chí Minh',
    street: '12 Lê Lợi', province: 'Hồ Chí Minh', district: 'Quận 1', ward: 'Phường Bến Nghé', createdAt: Date.now() - HOUR,
    products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1, price: 174000, paidPrice: 174000, weight: 450 }],
    freeShipping: false, shippingFee: 15000, discount: 0, total: 189000, gift: '', note: '', employee: 'Chatbot AI', status: 'Mới'
  };
  let conversationId = '';
  await updateMessagingStore(store => {
    const conversation = ensureConversation(store, { pageId: '936023372925639', psid: 'retry-psid', name: 'Hồng Nga' });
    conversation.customerOrders = [{ ...order }];
    conversationId = conversation.id;
    return null;
  });
  let slow = true;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const address = String(url);
    calls.push({ address, method: options.method || 'GET' });
    if (slow) { const error = new Error('This operation was aborted'); error.name = 'AbortError'; throw error; }
    if (address.includes('/products/variations')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'v1', display_id: 'GRA-XANH-Z450' }] }) };
    if (address.includes('/warehouses')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'wh-1', province_id: '701', allow_create_order: true }] }) };
    if (address.includes('/geo/')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (address.includes('/orders?') && (options.method || 'GET') === 'GET') return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (options.method === 'POST') return { ok: true, status: 200, json: async () => ({ id: 'CRM-retry001', system_id: 77, status_name: 'new' }) };
    throw new Error(`gọi lạ: ${address}`);
  };
  const first = await syncOrderToPos(conversationId, order.id, { config, fetchImpl, log: () => {} });
  assert.ok(first.error, 'POS chậm: lần đầu lỗi');
  assert.equal(first.retries, 0);

  // Chưa đủ 5 phút: lượt tự đẩy chưa đụng tới.
  assert.equal(await retryFailedPosPushes({ config, fetchImpl, log: () => {} }), 0);

  slow = false;
  calls.length = 0;
  const pushed = await retryFailedPosPushes({ now: Date.now() + 6 * 60 * 1000, config, fetchImpl, log: () => {} });
  assert.equal(pushed, 1);
  const searchedFirst = calls.findIndex(call => call.method === 'GET' && call.address.includes('/orders?'));
  const posted = calls.findIndex(call => call.method === 'POST');
  assert.ok(searchedFirst >= 0 && searchedFirst < posted, 'kiểm POS có đơn chưa trước khi tạo');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  const saved = (await readMessagingStore()).conversations.find(item => item.id === conversationId).customerOrders[0];
  assert.equal(saved.pos.id, 'CRM-retry001');
  assert.equal(saved.pos.error, undefined);
});
