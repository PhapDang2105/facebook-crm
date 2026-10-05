// Gộp nhánh chính (đổi quà, 4af7dff) vào vòng 15/16: hồi quy kết hợp trên bản gộp. Khách live giỏ 1 Xanh + 1 Vàng nhắn
// "C ko lấy quạt .bỏ ra hộ c về ko dùng phí" → bot tự đổi quạt sang muỗng dừa (GIFT_FAN_TO_SPOON, ưu tiên trước luồng
// GIFT_SWAP chung — chính sách chủ shop 05/10), giỏ mang giftOverride BGD + MUONG (giữ cờ live của vòng 13/15); chốt đơn →
// đơn đẩy lên POS (stub, không gọi mạng) có đúng dòng tặng BGD + MUONG, không QUA-TANG-LIVE. Kèm ca R15 (lời hứa yến mạch
// oatsGift) cùng quà chọn tay: cả hai đi theo giỏ, tin xác nhận có cả muỗng dừa và yến mạch.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('r16-merge-gift-');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.POS_COMBOS_PATH = path.join(directory, 'pos-combos.json');
process.env.POS_PUSH_ORDERS = '1';

const { Sim, PHONE, XANH, VANG, basket } = await import('./helpers/r13-engine-sim.mjs');
const { reloadCatalog } = await import('../app/processing/catalog.mjs');
const { normalizeChatbotOrder } = await import('../app/conversation-orders.mjs');
const { pushOrderToPos } = await import('../app/pos-orders.mjs');
const { OATS_GIFT_NAME } = await import('../app/chatbot-templates.mjs');

const MIN = 60 * 1000;
const LIVE_POST = { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ' };
const ADDRESS = '12 Nguyễn Trãi, phường Bến Thành, Quận 1, TP HCM';
const LIVE_GIFT = { id: 'qua-tang-live', name: 'Quạt + Bát gáo dừa', active: true, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 50 };
const skus = list => (list || []).map(item => item.sku);
const noModel = () => { throw new Error('không hỏi mô hình'); };

async function withLiveGift(run) {
  const original = readFileSync(process.env.GIFTS_PATH, 'utf8');
  const gifts = JSON.parse(original);
  gifts.items.push(LIVE_GIFT);
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  reloadCatalog();
  try { return await run(); } finally { writeFileSync(process.env.GIFTS_PATH, original); reloadCatalog(); }
}

// Stub POS: có túi, bát, muỗng, quà live (không có mã quạt riêng).
function posStub(calls) {
  const variations = ['GRA-XANH-Z450', 'GRA-VANG-H350', 'BGD', 'MUONG', 'QUA-TANG-LIVE'];
  return async (url, options = {}) => {
    const address = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ address, method: options.method || 'GET', body });
    if (address.includes('/products/variations')) return { ok: true, status: 200, json: async () => ({ data: variations.map(sku => ({ id: `v-${sku}`, product_id: `p-${sku}`, display_id: sku })) }) };
    if (address.includes('/warehouses')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'wh-1', name: 'Kho', province_id: '701', allow_create_order: true }] }) };
    if (address.includes('/geo/')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (options.method === 'POST' && /\/orders\?api_key=k$/.test(address)) return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'CRM-live1', system_id: 601, status_name: 'Mới' } }) };
    if (/\/orders\/[^/?]+\?api_key=k$/.test(address)) {
      const post = calls.find(call => call.method === 'POST');
      return { ok: true, status: 200, json: async () => ({ data: { items: post?.body?.items || [] } }) };
    }
    throw new Error(`gọi lạ: ${options.method || 'GET'} ${address}`);
  };
}
const config = { apiKey: 'k', shopId: '714334721', baseUrl: 'https://pos.example/api/v1' };

test('bản gộp: khách live 1 Xanh + 1 Vàng "C ko lấy quạt .bỏ ra hộ c về ko dùng phí" → GIFT_FAN_TO_SPOON, giỏ BGD + MUONG; chốt đơn → POS stub BGD + MUONG', async () => {
  await withLiveGift(async () => {
    const sim = new Sim();
    const inbox = sim.inbox({ labels: ['livestream'], post: LIVE_POST, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(1), VANG(1)], 2 * MIN, { livestream: true }) });
    sim.history(inbox, 'outgoing', 'Dạ chị cho em xin số điện thoại và địa chỉ nha ạ.', 2 * MIN, { sender: 'bot' });
    const turn = await sim.send(inbox, 'C ko lấy quạt .bỏ ra hộ c về ko dùng phí', { llm: noModel });
    assert.equal(turn.result.templateId, 'ORDER_ADDRESS_REMIND', JSON.stringify(turn.result));
    const said = turn.sent.map(item => item.text).join('\n');
    // Câu GIFT_FAN_TO_SPOON (ý phụ kèm nhắc giỏ) — đổi quạt → muỗng đi trước luồng GIFT_SWAP chung.
    assert.match(said, /đổi quạt sang muỗng dừa cho .* Combo 2 túi của mình được tặng Bát gáo dừa \+ Muỗng dừa/);
    assert.doesNotMatch(said, /bộ phận phụ trách cho phép/, 'không xin duyệt như GIFT_SWAP');
    assert.ok(!inbox.labels.includes('handoff'), 'không chuyển người');
    assert.deepEqual(skus(inbox.pendingOrder.giftOverride), ['BGD', 'MUONG']);
    assert.equal(inbox.pendingOrder.livestream, true, 'giỏ giữ cờ khách live');
    assert.equal(inbox.pendingOrder.giftSwap, undefined, 'không áp đổi quà kiểu cũ');
    assert.deepEqual(inbox.pendingOrder.items.map(item => `${item.quantity} ${item.code}`), ['1 GRA-XANH-Z450', '1 GRA-VANG-H350']);

    const closed = await sim.send(inbox, `${PHONE} ${ADDRESS}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDRESS } });
    assert.equal(closed.created.length, 1, JSON.stringify(closed.result));
    assert.deepEqual(skus(closed.created[0].giftOverride), ['BGD', 'MUONG']);
    const confirmText = closed.sent.map(item => item.text).join('\n');
    assert.match(confirmText, /Muỗng dừa/);
    assert.doesNotMatch(confirmText, /Quạt/);
    const order = normalizeChatbotOrder(closed.created[0], inbox, { id: 'live1' });
    assert.equal(order.gift, 'Miễn phí vận chuyển + Bộ bát gáo dừa + Muỗng dừa');

    const calls = [];
    const pushed = await pushOrderToPos(order, { config, fetchImpl: posStub(calls) });
    const post = calls.find(call => call.method === 'POST');
    assert.ok(post, 'đã POST đơn lên POS stub');
    assert.deepEqual(post.body.items.filter(item => item.is_bonus_product).map(item => [item.variation_id, item.quantity]), [['v-BGD', 1], ['v-MUONG', 1]]);
    assert.ok(!post.body.items.some(item => item.variation_id === 'v-QUA-TANG-LIVE'), 'không đẩy quà live (quạt)');
    assert.deepEqual(pushed.giftOverrideMissing, []);
  });
});

test('bản gộp: giỏ live đã hứa tặng yến mạch (R15 oatsGift) + đổi quạt → muỗng: giỏ giữ cả hai, tin xác nhận có muỗng dừa và yến mạch', async () => {
  await withLiveGift(async () => {
    const sim = new Sim();
    const inbox = sim.inbox({ labels: ['livestream'], post: LIVE_POST, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(1), VANG(1)], 2 * MIN, { livestream: true, oatsGift: true }) });
    const turn = await sim.send(inbox, 'bỏ quạt giúp chị nhé', { llm: noModel });
    assert.match(turn.sent.map(item => item.text).join('\n'), /đổi quạt sang muỗng dừa/, JSON.stringify(turn.result));
    assert.deepEqual(skus(inbox.pendingOrder.giftOverride), ['BGD', 'MUONG']);
    assert.equal(inbox.pendingOrder.oatsGift, true, 'lời hứa yến mạch vẫn đi theo giỏ');
    const closed = await sim.send(inbox, `${PHONE} ${ADDRESS}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDRESS } });
    assert.equal(closed.created.length, 1, JSON.stringify(closed.result));
    assert.deepEqual(skus(closed.created[0].giftOverride), ['BGD', 'MUONG']);
    const confirmText = closed.sent.map(item => item.text).join('\n');
    assert.match(confirmText, /Muỗng dừa/);
    assert.ok(confirmText.includes(OATS_GIFT_NAME), confirmText);
    assert.doesNotMatch(confirmText, /Quạt/);
  });
});
