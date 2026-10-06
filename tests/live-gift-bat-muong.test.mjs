// 06/10 (chủ shop): quà live combo 2 túi đổi "Quạt + Bát gáo dừa" → "Bát gáo dừa + Muỗng dừa". Bảng quà máy chủ: quạt
// tắt; thêm 2 dòng quà live (đúng 2 túi) dùng SKU BGD / MUONG; bát + muỗng thường (từ 3 túi) giữ cho mọi khách.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { Sim, PHONE, XANH, basket } from './helpers/r13-engine-sim.mjs';
import { normalizeChatbotOrder } from '../app/conversation-orders.mjs';
import { giftsForKey, reloadCatalog } from '../app/processing/catalog.mjs';
import { buildPosOrderPayload } from '../app/pos-orders.mjs';
import { posGiftLines } from '../app/order-export.mjs';

const LIVE_ROWS = [
  { id: 'qua-tang-live', name: 'Quạt + Bát gáo dừa', active: false, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 50 },
  { id: 'live-bat-gao-dua', name: 'Bát gáo dừa', active: true, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'BGD', weight: 10 },
  { id: 'live-muong-dua', name: 'Muỗng dừa', active: true, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'MUONG', weight: 10 }
];
async function withBatMuong(run) {
  const original = readFileSync(process.env.GIFTS_PATH, 'utf8');
  const gifts = JSON.parse(original);
  gifts.items.push(...LIVE_ROWS);
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  reloadCatalog();
  try { return await run(); } finally { writeFileSync(process.env.GIFTS_PATH, original); reloadCatalog(); }
}
const MIN = 60 * 1000;
const LIVE_POST = { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ' };
const ADDRESS = '12 Nguyễn Trãi, phường Bến Thành, Quận 1, TP HCM';
const names = list => list.map(gift => gift.name);
const giftLines = payload => payload.items.filter(item => item.is_bonus_product).map(item => `${item.variation_id}x${item.quantity}`);

test('bảng quà: live 2 túi → miễn ship + Bát + Muỗng; live 3 túi và khách thường 3 túi → bát + muỗng thường; khách thường 2 túi → miễn ship', async () => {
  await withBatMuong(() => {
    assert.deepEqual(names(giftsForKey('GRA-XANH-Z450=2', { livestream: true })), ['Miễn phí vận chuyển', 'Bát gáo dừa', 'Muỗng dừa']);
    assert.deepEqual(names(giftsForKey('GRA-XANH-Z450=3', { livestream: true })), ['Miễn phí vận chuyển', 'Bộ bát gáo dừa', 'Muỗng dừa']);
    assert.deepEqual(names(giftsForKey('GRA-XANH-Z450=3')), ['Miễn phí vận chuyển', 'Bộ bát gáo dừa', 'Muỗng dừa']);
    assert.deepEqual(names(giftsForKey('GRA-XANH-Z450=2')), ['Miễn phí vận chuyển']);
    // Đơn POS chỉ có chữ quà: mỗi SKU một dòng (dòng live và dòng thường cùng SKU MUONG).
    assert.deepEqual(posGiftLines({ gift: 'Miễn phí vận chuyển + Bát gáo dừa + Muỗng dừa' }).map(line => line.sku).sort(), ['BGD', 'MUONG']);
  });
});

test('khách live chốt 2 Túi Xanh → xác nhận "Bát gáo dừa + Muỗng dừa", không quạt; POS lên BGD + MUONG', async () => {
  await withBatMuong(async () => {
    const sim = new Sim();
    const inbox = sim.inbox({ labels: ['livestream'], post: LIVE_POST, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(2)], 2 * MIN, { livestream: true }) });
    sim.history(inbox, 'outgoing', 'Dạ anh cho em xin số điện thoại và địa chỉ nha ạ.', 2 * MIN, { sender: 'bot' });
    const closed = await sim.send(inbox, `${PHONE} ${ADDRESS}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDRESS } });
    assert.equal(closed.created.length, 1, JSON.stringify(closed.result));
    const said = closed.sent.map(item => item.text).join('\n');
    assert.match(said, /Bát gáo dừa \+ Muỗng dừa/);
    assert.doesNotMatch(said, /Quạt/);
    const order = normalizeChatbotOrder(closed.created[0], inbox, { id: 'live-bm' });
    assert.equal(order.gift, 'Miễn phí vận chuyển + Bát gáo dừa + Muỗng dừa');
    assert.deepEqual(giftLines(buildPosOrderPayload(order, {})), ['BGDx1', 'MUONGx1']);
  });
});

test('giỏ live không còn quạt: "ko lấy quạt" không trả lời "đổi quạt sang muỗng"', async () => {
  await withBatMuong(async () => {
    const sim = new Sim();
    const inbox = sim.inbox({ labels: ['livestream'], post: LIVE_POST, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(2)], 2 * MIN, { livestream: true }) });
    const turn = await sim.send(inbox, 'ko lấy quạt đâu', { llm: { template_id: 'GIFT_POLICY' } });
    assert.notEqual(turn.result.alsoTemplateId, 'GIFT_FAN_TO_SPOON');
    assert.equal(inbox.pendingOrder?.giftOverride, undefined);
  });
});
