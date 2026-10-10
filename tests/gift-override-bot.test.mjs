// 05/10 (chủ shop): khách live không lấy quạt → bot TỰ đổi quà (giỏ chờ, hay đơn bot tạo < 60 phút): giftOverride.
// R17 (chủ shop 10/10, quyết định 12 — thay 05/10 "đổi sang muỗng dừa"): combo 2 live (quà Quạt, bảng quà 08/10) bỏ quạt →
// 1 Bát gáo dừa (BGD, không muỗng); live 3 túi (Quạt + bát + muỗng) bỏ quạt → còn bát + muỗng. Bỏ cả bát / xin quà khác /
// đơn quá 60 phút → luồng GIFT_SWAP như cũ (ghi chú + xin duyệt).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { Sim, PHONE, XANH, VANG, basket } from './helpers/r13-engine-sim.mjs';
import { normalizeChatbotOrder } from '../app/conversation-orders.mjs';
import { reloadCatalog } from '../app/processing/catalog.mjs';
import { buildPosOrderPayload } from '../app/pos-orders.mjs';
import { asksSpoonIncluded, isFanToSpoonRequest } from '../app/processing/rule-intent.mjs';
import { fanToSpoonGifts } from '../app/chatbot-engine.mjs';

const LIVE_GIFT = { id: 'qua-tang-live', name: 'Quạt + Bát gáo dừa', active: true, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 50 };
async function withLiveGift(run) {
  const original = readFileSync(process.env.GIFTS_PATH, 'utf8');
  const gifts = JSON.parse(original);
  // R17: bảng quà seed đã có Quạt chỉ khách live (live-quat, 08/10) — dùng đúng bảng đó, không thêm quà live gộp cũ.
  gifts.items = gifts.items.filter(gift => gift.id !== LIVE_GIFT.id);
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  reloadCatalog();
  try { return await run(); } finally { writeFileSync(process.env.GIFTS_PATH, original); reloadCatalog(); }
}
const MIN = 60 * 1000;
const LIVE_POST = { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ' };
const ADDRESS = '12 Nguyễn Trãi, phường Bến Thành, Quận 1, TP HCM';
const SPOON = [{ name: 'Bộ bát gáo dừa', sku: 'BGD', quantity: 1, weight: 10, giftId: 'bo-bat-gao-dua' }, { name: 'Muỗng dừa', sku: 'MUONG', quantity: 1, weight: 10, giftId: 'muong-dua' }];
const BOWL = [SPOON[0]];
const skus = list => (list || []).map(item => item.sku);
const giftLines = payload => payload.items.filter(item => item.is_bonus_product).map(item => `${item.variation_id}x${item.quantity}`);

test('nhận câu "chỉ bỏ quạt" (câu khách thật) và loại câu bỏ cả bát / xin quà khác', () => {
  for (const text of ['C ko lấy quạt .bỏ ra hộ c về ko dùng phí', 'bỏ quạt', 'không cần quạt', 'đổi quạt', 'khỏi quạt', 'ko lấy quat .bỏ ra', 'Em kgg lấy quạt tặng em cái muỗng', 'Không lấy quạt, lấy bộ bát với muỗng thôi']) {
    assert.equal(isFanToSpoonRequest(text), true, text);
  }
  for (const text of ['Ok, mình ko lấy bát và quạt', 'ko lấy bát', 'đổi quạt sang cái khác được ko', 'quạt đẹp không', 'ko lấy quạt với muỗng', 'không lấy quạt, có trừ tiền không', 'Tặng quạt jì vậy', 'ko lấy quạt đổi gói nhỏ nhé', 'bỏ bát với quạt']) {
    assert.equal(isFanToSpoonRequest(text), false, text);
  }
  assert.equal(asksSpoonIncluded('có thìa dừa không'), true);
  assert.equal(asksSpoonIncluded('Có muỗng ko e'), true);
  assert.equal(asksSpoonIncluded('ko lấy muỗng'), false);
  assert.deepEqual(fanToSpoonGifts(), BOWL, 'combo 2: 1 bát gáo dừa — tên / SKU / khối lượng theo bảng quà');
  assert.deepEqual(fanToSpoonGifts(undefined, { bags: 3 }), SPOON, 'live 3 túi bỏ quạt: còn bát + muỗng');
});

test('giỏ live 1 Xanh + 1 Vàng: "C ko lấy quạt .bỏ ra hộ c về ko dùng phí" → bot tự đổi sang 1 Bát gáo dừa; chốt đơn → POS có BGD, không QUA-TANG-LIVE', async () => {
  await withLiveGift(async () => {
    const sim = new Sim();
    const inbox = sim.inbox({ labels: ['livestream'], post: LIVE_POST, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(1), VANG(1)], 2 * MIN, { livestream: true }) });
    sim.history(inbox, 'outgoing', 'Dạ chị cho em xin số điện thoại và địa chỉ nha ạ.', 2 * MIN, { sender: 'bot' });
    const turn = await sim.send(inbox, 'C ko lấy quạt .bỏ ra hộ c về ko dùng phí', { llm: () => { throw new Error('không hỏi mô hình'); } });
    assert.equal(turn.result.templateId, 'ORDER_ADDRESS_REMIND', JSON.stringify(turn.result));
    const said = turn.sent.map(item => item.text).join('\n');
    assert.match(said, /đổi quạt/);
    assert.match(said, /Quà của mình bây giờ là Bộ bát gáo dừa ạ/);
    assert.doesNotMatch(said, /Muỗng/);
    assert.match(said, /vẫn đang giữ đơn/, 'kèm câu nhắc giỏ');
    assert.doesNotMatch(said, /bộ phận phụ trách cho phép/, 'không xin duyệt');
    assert.deepEqual(skus(inbox.pendingOrder.giftOverride), ['BGD']);
    assert.deepEqual(inbox.pendingOrder.items.map(item => `${item.quantity} ${item.code}`), ['1 GRA-XANH-Z450', '1 GRA-VANG-H350'], 'giỏ giữ nguyên');
    // Chốt đơn: đơn mang giftOverride; quà chữ + POS theo 1 bát gáo dừa.
    const closed = await sim.send(inbox, `${PHONE} ${ADDRESS}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDRESS } });
    assert.equal(closed.created.length, 1, JSON.stringify(closed.result));
    assert.deepEqual(skus(closed.created[0].giftOverride), ['BGD']);
    assert.match(closed.sent.map(item => item.text).join('\n'), /Bộ bát gáo dừa/);
    assert.doesNotMatch(closed.sent.map(item => item.text).join('\n'), /Quạt|Muỗng/);
    const order = normalizeChatbotOrder(closed.created[0], inbox, { id: 'live1' });
    assert.equal(order.gift, 'Miễn phí vận chuyển + Bộ bát gáo dừa');
    assert.deepEqual(giftLines(buildPosOrderPayload(order, {})), ['BGDx1']);
  });
});

test('"Ok, mình ko lấy bát và quạt" (giỏ live) → GIFT_SWAP như cũ: ghi chú + xin duyệt, giỏ không mang quà tay', async () => {
  await withLiveGift(async () => {
    const sim = new Sim();
    const inbox = sim.inbox({ labels: ['livestream'], post: LIVE_POST, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(1), VANG(1)], 2 * MIN, { livestream: true }) });
    const turn = await sim.send(inbox, 'Ok, mình ko lấy bát và quạt', { llm: { template_id: 'GIFT_SWAP' } });
    assert.match(turn.sent.map(item => item.text).join('\n'), /bộ phận phụ trách/);
    assert.equal(inbox.pendingOrder?.giftOverride, undefined);
    assert.ok(inbox.labels.includes('handoff'));
  });
});

test('đơn bot tạo < 60 phút đang có quạt: bot sửa quà của đơn (setOrderGiftOverride); quá 60 phút → ghi chú như GIFT_SWAP', async () => {
  await withLiveGift(async () => {
    const order = minutes => ({ id: 'o1', createdAt: Date.now() - minutes * MIN, phone: PHONE, address: ADDRESS, livestream: true, gift: 'Miễn phí vận chuyển + Quạt', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1 }, { name: 'Granola Túi Vàng 350g', sku: 'GRA-VANG-H350', quantity: 1 }], status: 'Mới', total: 298000 });
    const sim = new Sim();
    const inbox = sim.inbox({ labels: ['livestream'], post: LIVE_POST, customerOrders: [order(10)], botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 10 * MIN });
    const calls = [];
    const turn = await sim.send(inbox, 'bỏ quạt giúp chị nhé', { extra: { setOrderGiftOverride: async (_conversation, id, list) => { calls.push({ id, list }); return { noted: true, order: { id } }; } }, llm: () => { throw new Error('không hỏi mô hình'); } });
    assert.equal(turn.result.templateId, 'GIFT_FAN_TO_SPOON', JSON.stringify(turn.result));
    assert.deepEqual(calls.map(call => [call.id, skus(call.list)]), [['o1', ['BGD']]]);
    assert.equal(turn.created.length, 0, 'không tạo đơn mới');
    assert.match(turn.sent.map(item => item.text).join('\n'), /đổi quạt .*Quà của mình bây giờ là Bộ bát gáo dừa ạ/);
    // Sửa không được (đơn nhân viên lên trên POS…) → ghi chú + xin duyệt.
    const failing = new Sim();
    const failInbox = failing.inbox({ labels: ['livestream'], post: LIVE_POST, customerOrders: [order(10)], botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 10 * MIN });
    const failed = await failing.send(failInbox, 'khỏi quạt nha', { extra: { setOrderGiftOverride: async () => ({ error: 'đơn nhân viên lên trên POS' }) } });
    assert.equal(failed.result.templateId, 'GIFT_SWAP', JSON.stringify(failed.result));
    assert.deepEqual(failed.notes.map(note => note.orderId), ['o1']);
    assert.ok(failInbox.labels.includes('handoff'));
    // Đơn quá 60 phút: ghi chú + xin duyệt (không tự sửa).
    const late = new Sim();
    const lateInbox = late.inbox({ labels: ['livestream'], post: LIVE_POST, customerOrders: [order(90)], botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 90 * MIN });
    const lateCalls = [];
    const lateTurn = await late.send(lateInbox, 'C ko lấy quạt .bỏ ra hộ c', { extra: { setOrderGiftOverride: async () => { lateCalls.push(1); return { noted: true }; } } });
    assert.equal(lateCalls.length, 0);
    assert.equal(lateTurn.result.templateId, 'GIFT_SWAP', JSON.stringify(lateTurn.result));
    assert.deepEqual(lateTurn.notes.map(note => note.orderId), ['o1']);
  });
});

test('khách thường giỏ 2 túi (không quà quạt): "ko lấy quạt" không đổi quà tay', async () => {
  await withLiveGift(async () => {
    const sim = new Sim();
    const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(2)], 2 * MIN) });
    const turn = await sim.send(inbox, 'ko lấy quạt đâu', { llm: { template_id: 'GIFT_POLICY' } });
    assert.notEqual(turn.result.alsoTemplateId, 'GIFT_FAN_TO_SPOON');
    assert.equal(inbox.pendingOrder?.giftOverride, undefined);
  });
});

test('máy chủ: bot đổi quà đơn qua setChatbotOrderGiftOverride (lịch sử, PUT POS như sửa đơn, lỗi POS → ghi chú xử lý)', () => {
  const server = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '');
  const body = server.slice(server.indexOf('async function setChatbotOrderGiftOverride('), server.indexOf('async function addChatbotOrderNote('));
  assert.match(body, /existing\.pos\?\.id && !isCrmOwnedPosOrder\(existing\)/);
  assert.match(body, /recordOrderHistory\(existing, \{ by: BOT_ACTOR/);
  assert.match(body, /await updatePosOrder\(updated, \{ conversation \}\)/);
  assert.match(body, /applyGiftOverrideFlag\(target, missing\)/);
  assert.match(server, /setOrderGiftOverride: setChatbotOrderGiftOverride,/);
  const seed = JSON.parse(readFileSync(new URL('../app/chatbot-templates.seed.json', import.meta.url), 'utf8'));
  assert.equal(seed.GIFT_FAN_TO_SPOON, 'Dạ em đổi quạt cho {title} nha ạ 💛 Quà của mình bây giờ là {gift} ạ.');
  assert.ok(seed.GIFT_SPOON_INCLUDED);
});
