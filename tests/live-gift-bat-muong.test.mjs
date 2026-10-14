// 08/10 (chủ shop): đổi quà tặng live combo 2 sang Quạt và combo 3 sang Quạt + Bát gáo dừa và muỗng (chỉ áp dụng livestream).
// 14/10 chiều (chủ shop): quà live combo 2 đổi sang 1 Quạt + 1 Bát gáo dừa (bật dòng live-bat-gao-dua, đúng 2 túi); combo 3 giữ Quạt + bộ bát + muỗng.
// Bảng quà máy chủ: live-quat (min 2, liveOnly); bát + muỗng thường (từ 3 túi) giữ cho mọi khách.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { Sim, PHONE, XANH, basket } from './helpers/r13-engine-sim.mjs';
import { normalizeChatbotOrder } from '../app/conversation-orders.mjs';
import { giftsForKey, reloadCatalog } from '../app/processing/catalog.mjs';
import { buildPosOrderPayload } from '../app/pos-orders.mjs';
import { posGiftLines } from '../app/order-export.mjs';

const LIVE_ROWS = [
  { id: 'live-quat', name: 'Quạt', active: true, minQuantity: 2, maxQuantity: 0, livestreamOnly: true, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 20 },
  { id: 'qua-tang-live', name: 'Quạt + Bát gáo dừa', active: false, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 50 },
  { id: 'live-bat-gao-dua', name: 'Bát gáo dừa', active: true, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'BGD', weight: 10 },
  { id: 'live-muong-dua', name: 'Muỗng dừa', active: false, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'MUONG', weight: 10 }
];
async function withLiveGifts(run) {
  const original = readFileSync(process.env.GIFTS_PATH, 'utf8');
  const gifts = JSON.parse(original);
  // Dòng cùng mã thay tại chỗ (giữ thứ tự bảng quà: Quạt, Bát trước bộ bát + muỗng), dòng chưa có thì thêm cuối.
  gifts.items = [...gifts.items.map(gift => LIVE_ROWS.find(row => row.id === gift.id) || gift), ...LIVE_ROWS.filter(row => !gifts.items.some(gift => gift.id === row.id))];
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  reloadCatalog();
  try { return await run(); } finally { writeFileSync(process.env.GIFTS_PATH, original); reloadCatalog(); }
}
const MIN = 60 * 1000;
const LIVE_POST = { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ' };
const ADDRESS = '12 Nguyễn Trãi, phường Bến Thành, Quận 1, TP HCM';
const names = list => list.map(gift => gift.name);
const giftLines = payload => payload.items.filter(item => item.is_bonus_product).map(item => `${item.variation_id}x${item.quantity}`);

test('bảng quà: live 2 túi → miễn ship + Quạt + Bát gáo dừa; live 3 túi → miễn ship + Quạt + Bát + Muỗng; khách thường 2 túi → miễn ship; khách thường 3 túi → bát + muỗng', async () => {
  await withLiveGifts(() => {
    assert.deepEqual(names(giftsForKey('GRA-XANH-Z450=2', { livestream: true })), ['Miễn phí vận chuyển', 'Quạt', 'Bát gáo dừa']);
    assert.deepEqual(names(giftsForKey('GRA-XANH-Z450=3', { livestream: true })), ['Miễn phí vận chuyển', 'Quạt', 'Bộ bát gáo dừa', 'Muỗng dừa']);
    assert.deepEqual(names(giftsForKey('GRA-XANH-Z450=3')), ['Miễn phí vận chuyển', 'Bộ bát gáo dừa', 'Muỗng dừa']);
    assert.deepEqual(names(giftsForKey('GRA-XANH-Z450=2')), ['Miễn phí vận chuyển']);
    // Đơn POS chỉ có chữ quà: mỗi SKU một dòng.
    assert.deepEqual(posGiftLines({ gift: 'Miễn phí vận chuyển + Quạt + Bát gáo dừa' }).map(line => line.sku).sort(), ['BGD', 'QUA-TANG-LIVE']);
    assert.deepEqual(posGiftLines({ gift: 'Miễn phí vận chuyển + Quạt + Bộ bát gáo dừa + Muỗng dừa' }).map(line => line.sku).sort(), ['BGD', 'MUONG', 'QUA-TANG-LIVE']);
  });
});

test('khách live chốt 2 Túi Xanh → xác nhận "Quạt + Bát gáo dừa", không muỗng; POS lên QUA-TANG-LIVE + BGD', async () => {
  await withLiveGifts(async () => {
    const sim = new Sim();
    const inbox = sim.inbox({ labels: ['livestream'], post: LIVE_POST, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(2)], 2 * MIN, { livestream: true }) });
    sim.history(inbox, 'outgoing', 'Dạ anh cho em xin số điện thoại và địa chỉ nha ạ.', 2 * MIN, { sender: 'bot' });
    const closed = await sim.send(inbox, `${PHONE} ${ADDRESS}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDRESS } });
    assert.equal(closed.created.length, 1, JSON.stringify(closed.result));
    const said = closed.sent.map(item => item.text).join('\n');
    assert.match(said, /Quạt/);
    assert.match(said, /Quạt \+ Bát gáo dừa/);
    assert.doesNotMatch(said, /Muỗng/);
    const order = normalizeChatbotOrder(closed.created[0], inbox, { id: 'live-bm' });
    assert.equal(order.gift, 'Miễn phí vận chuyển + Quạt + Bát gáo dừa');
    assert.deepEqual(giftLines(buildPosOrderPayload(order, {})), ['QUA-TANG-LIVEx1', 'BGDx1']);
  });
});

test('khách live chốt 3 Túi Xanh → xác nhận "Quạt + Bộ bát gáo dừa + Muỗng dừa"; POS có dòng tặng QUA-TANG-LIVE', async () => {
  await withLiveGifts(async () => {
    const sim = new Sim();
    const inbox = sim.inbox({ labels: ['livestream'], post: LIVE_POST, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(3)], 2 * MIN, { livestream: true }) });
    sim.history(inbox, 'outgoing', 'Dạ anh cho em xin số điện thoại và địa chỉ nha ạ.', 2 * MIN, { sender: 'bot' });
    const closed = await sim.send(inbox, `${PHONE} ${ADDRESS}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDRESS } });
    assert.equal(closed.created.length, 1, JSON.stringify(closed.result));
    const order = normalizeChatbotOrder(closed.created[0], inbox, { id: 'live-bm3' });
    assert.equal(order.gift, 'Miễn phí vận chuyển + Quạt + Bộ bát gáo dừa + Muỗng dừa');
    const posPayload = buildPosOrderPayload(order, {});
    assert.ok(posPayload.items.some(item => item.variation_id === 'QUA-TANG-LIVE' && item.is_bonus_product));
  });
});
