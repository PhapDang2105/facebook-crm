// Vòng 13 (02/10) — LIVE_DEAL_CLAIMED / LIVE_ONLY_PRODUCT sai chỗ (out-inbox2 B2, out-inbox1 B2, out-inbox3 F4, bình luận F6),
// quà khi đã có đơn (inbox2 B3), chọn vị quà thay sau GIFT_SWAP (inbox1 A2), quà live khi đi từ bình luận live sang hộp thư
// (inbox3 F3), số túi đã nêu không rơi ở lượt SĐT (inbox2 B1).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, VANG, NAU, basket } from './helpers/r13-engine-sim.mjs';
import { isLivestreamCustomer, normalizeChatbotOrder } from '../app/conversation-orders.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { reloadCatalog } from '../app/processing/catalog.mjs';

// Quà chỉ khách livestream (như cấu hình thật: 2 túi tặng Quạt + Bát gáo dừa) — tệp quà mẫu của test chưa có.
const LIVE_GIFT = { id: 'qua-tang-live', name: 'Quạt + Bát gáo dừa', active: true, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 50 };
async function withLiveGift(run) {
  const original = readFileSync(process.env.GIFTS_PATH, 'utf8');
  const gifts = JSON.parse(original);
  gifts.items.push(LIVE_GIFT);
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  reloadCatalog();
  try { return await run(); } finally { writeFileSync(process.env.GIFTS_PATH, original); reloadCatalog(); }
}

const MIN = 60 * 1000;
const LIVE_POST = { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ' };
const ADDRESS = '12 Nguyễn Trãi, phường Bến Thành, Quận 1, TP HCM';

test('"Chị ấn nhấn nhầm đấy" khi đang giữ giỏ Shop dưới bài live: không "em ghi nhận chị đã săn deal trên live"', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ post: LIVE_POST, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(1)], MIN) });
  sim.history(inbox, 'outgoing', 'Dạ để lên đơn đúng tuyến, chị cho em xin số điện thoại và địa chỉ nha ạ.', MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Chị ấn nhấn nhầm đấy', { llm: { template_id: 'ORDER_STATUS' } });
  assert.notEqual(turn.result.templateId, 'LIVE_DEAL_CLAIMED');
  assert.equal(turn.result.templateId, 'ORDER_POSTPONED', JSON.stringify(turn.result));
  assert.equal(inbox.pendingOrder, null, 'bấm nhầm: bỏ giỏ đang giữ');
  assert.doesNotMatch(turn.sent.map(item => item.text).join(' '), /săn deal/);
  // Ca thật thứ hai cùng hội thoại: "Ko c có ăn dc đâu" khi còn giữ giỏ → cũng không đổi thành LIVE_DEAL_CLAIMED.
  const other = new Sim({ settings: { ruleIntent: 'off' } });
  const otherInbox = other.inbox({ post: LIVE_POST, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(1)], MIN) });
  const second = await other.send(otherInbox, 'Ko c có ăn dc đâu', { llm: { template_id: 'ORDER_STATUS' } });
  assert.notEqual(second.result.templateId, 'LIVE_DEAL_CLAIMED');
  // Khách tự nói đã săn deal trên live (không giữ giỏ, chưa có đơn): vẫn ghi nhận như cũ.
  const claimed = new Sim({ settings: { ruleIntent: 'off' } });
  const claimedInbox = claimed.inbox({ post: LIVE_POST });
  const third = await claimed.send(claimedInbox, 'Chị đã săn được deal 290k trên live rồi', { llm: { template_id: 'ORDER_STATUS' } });
  assert.equal(third.result.templateId, 'LIVE_DEAL_CLAIMED');
});

test('LIVE_ONLY_PRODUCT chỉ cho khách live nêu đúng hàng live; món lạ / khách thường → mẫu chuyển nhân viên + thẻ, không hứa "giữ giá live"', async () => {
  // Khách live hỏi món shop không bán ("Hạt thông bóc vỏ của Nga" — ca thật 02/10, sau mốc).
  const live = new Sim({ settings: { ruleIntent: 'off' } });
  const liveInbox = live.inbox({ labels: ['livestream'], post: LIVE_POST });
  const strange = await live.send(liveInbox, 'Hạt thông bóc vỏ của Nga', { llm: { template_id: 'LIVE_ONLY_PRODUCT' } });
  assert.equal(strange.result.templateId, 'STAFF_ONLY_PRODUCT', JSON.stringify(strange.result));
  assert.doesNotMatch(strange.sent.map(item => item.text).join(' '), /giữ giá live|phiên live/);
  assert.ok(liveInbox.labels.includes('handoff'));
  assert.notEqual(liveInbox.botEnabled, false, 'bot vẫn bật');
  // Khách live nêu sữa hạt. R15 — sửa khẳng định cũ theo quyết định chủ shop 03/10 (#4): hạt điều / sữa hạt / hũ hạt khách
  // live hỏi cũng chuyển nhân viên (STAFF_ONLY_PRODUCT + thẻ), không còn LIVE_ONLY_PRODUCT "giữ giá live".
  const listed = new Sim({ settings: { ruleIntent: 'off' } });
  const listedInbox = listed.inbox({ labels: ['livestream'], post: LIVE_POST });
  const milk = await listed.send(listedInbox, 'sữa hạt trên live còn không em', { llm: { template_id: 'LIVE_ONLY_PRODUCT' } });
  assert.equal(milk.result.templateId, 'STAFF_ONLY_PRODUCT');
  assert.ok(listedInbox.labels.includes('handoff'));
  // Khách thường (không live) hỏi hàng live: không nói "chỉ bán trên live", không tắt bot (trước đây CSKH_HANDOFF tắt bot).
  const plain = new Sim({ settings: { ruleIntent: 'off' } });
  const plainInbox = plain.inbox();
  const cashew = await plain.send(plainInbox, 'bên em có bán hạt điều rang không', { llm: { template_id: 'LIVE_ONLY_PRODUCT' } });
  assert.equal(cashew.result.templateId, 'STAFF_ONLY_PRODUCT');
  assert.notEqual(plainInbox.botEnabled, false);
  assert.ok(plainInbox.labels.includes('handoff'));
  // OTHER_PRODUCTS luôn gắn thẻ.
  const others = new Sim({ settings: { ruleIntent: 'off' } });
  const othersInbox = others.inbox();
  const more = await others.send(othersInbox, 'ngoài granola shop còn gì nữa', { llm: { template_id: 'OTHER_PRODUCTS' } });
  assert.equal(more.result.templateId, 'OTHER_PRODUCTS');
  assert.ok(othersInbox.labels.includes('handoff'));
});

test('ảnh mà mô hình trả LIVE_ONLY_PRODUCT (túi Tropical, sản phẩm lạ): như ảnh thường — không chuyển CSKH, không hứa giá live', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off', provider: 'vertex' } });
  const inbox = sim.inbox();
  const turn = await sim.send(inbox, '', { type: 'image', message: { dataUrl: 'https://content.pancake.vn/a/b.jpg' }, llm: { template_id: 'LIVE_ONLY_PRODUCT' } });
  assert.ok(['IMAGE_RECEIVED', 'PRICE_QUOTE', 'GENERAL_INFO'].includes(turn.result.templateId), JSON.stringify(turn.result));
  assert.notEqual(inbox.botEnabled, false, 'không tắt bot');
  assert.ok(inbox.labels.includes('handoff'), 'thẻ để nhân viên xem ảnh');
  assert.doesNotMatch(turn.sent.map(item => item.text).join(' '), /giữ giá live|chuyển bộ phận chăm sóc/);
  // Khách gõ tên Tropical mà mô hình trả LIVE_ONLY_PRODUCT: Tropical đã có trong danh mục → báo giá Tropical.
  const named = new Sim({ settings: { ruleIntent: 'off' } });
  const namedInbox = named.inbox();
  const tropical = await named.send(namedInbox, 'túi tropical bao nhiêu vậy', { llm: { template_id: 'LIVE_ONLY_PRODUCT' } });
  assert.equal(tropical.result.templateId, 'PRICE_QUOTE', JSON.stringify(tropical.result));
  assert.match(tropical.sent.map(item => item.text).join(' '), /Tropical/);
});

test('khách live ĐÃ có đơn hỏi lại quà: nói quà của đơn, không mời "lấy 2 túi vị nào để em lên đơn liền"', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const order = { id: 'o1', createdAt: Date.now() - 20 * MIN, phone: PHONE, address: ADDRESS, livestream: true, gift: 'Miễn phí vận chuyển + Quạt + Bát gáo dừa', products: [{ name: 'Granola Túi Vàng 350g', sku: 'GRA-VANG-H350', quantity: 2 }], status: 'Mới', total: 298000 };
  const inbox = sim.inbox({ labels: ['livestream'], customerOrders: [order], botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 20 * MIN });
  const turn = await sim.send(inbox, 'Đơn của chị có được tặng quà gì không em', { llm: { template_id: 'GIFT_POLICY' } });
  const said = turn.sent.map(item => item.text).join('\n');
  assert.match(said, /Quạt/);
  assert.match(said, /đơn/i);
  assert.doesNotMatch(said, /lấy 2 túi vị nào|lên đơn liền/);
  // Khách live CHƯA có đơn: vẫn lời mời live như vòng 12.
  const fresh = new Sim({ settings: { ruleIntent: 'off' } });
  const freshInbox = fresh.inbox({ labels: ['livestream'] });
  const invite = await fresh.send(freshInbox, 'mua có được tặng quà gì không em', { llm: { template_id: 'GIFT_POLICY' } });
  assert.equal(invite.result.templateId, 'GIFT_POLICY_LIVE');
  assert.match(invite.sent.map(item => item.text).join('\n'), /2 túi/);
});

// R14 (chủ shop 03/10, thay quy tắc 01/10 "quà thay = 2 gói nhỏ"): bot không hỏi vị quà thay nữa — ghi chú, bộ phận
// phụ trách duyệt rồi nhắn khách. Phần áp lựa chọn đã lưu (giftSwapAskedAt cũ, test bên dưới) giữ cho dữ liệu đang dở.
test('sau GIFT_SWAP: không đặt mốc chờ chọn vị quà thay, giỏ giữ nguyên; chốt đơn quà như thường (nhân viên đổi sau)', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  // Giỏ 3 túi (quà bát + muỗng) đang chờ SĐT/địa chỉ.
  const inbox = sim.inbox({ gender: 'female', botGender: 'female', botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(3)], 2 * MIN) });
  sim.history(inbox, 'outgoing', 'Dạ chị cho em xin số điện thoại và địa chỉ nha ạ.', 2 * MIN, { sender: 'bot' });
  const ask = await sim.send(inbox, 'Chị không lấy bát đâu, đổi quà khác được không', { llm: { template_id: 'GIFT_SWAP' } });
  assert.ok(ask.result.templateId === 'GIFT_SWAP' || ask.result.templateId === 'ORDER_ADDRESS_REMIND', JSON.stringify(ask.result));
  assert.match(ask.sent.map(item => item.text).join('\n'), /bộ phận phụ trách/);
  assert.ok(!(Number(inbox.giftSwapAskedAt) > 0), 'không chờ khách chọn vị quà thay');
  assert.ok(inbox.labels.includes('handoff'));
  assert.deepEqual(inbox.pendingOrder.items.map(item => `${item.quantity} ${item.code}`), ['3 GRA-XANH-Z450'], 'giỏ giữ nguyên');
  const closed = await sim.send(inbox, `${PHONE} ${ADDRESS}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDRESS } });
  assert.equal(closed.created.length, 1, JSON.stringify(closed.result));
  assert.equal(closed.created[0].giftSwap, undefined, 'bot không tự đổi quà trên đơn');
  assert.equal(closed.created[0].total, 447000);
});

test('chọn vị quà thay khi ĐÃ có đơn: ghi chú vào đơn như cũ; "2 túi xanh" (đặt túi lớn) và câu hỏi không bị coi là chọn quà', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const order = { id: 'o9', createdAt: Date.now() - 30 * MIN, phone: PHONE, address: ADDRESS, gift: 'Bộ bát gáo dừa + Muỗng dừa', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 3 }], status: 'Mới', total: 447000 };
  const inbox = sim.inbox({ customerOrders: [order], botLastTemplateId: 'GIFT_SWAP', botLastReplyAt: Date.now() - MIN, giftSwapAskedAt: Date.now() - MIN });
  const turn = await sim.send(inbox, '1 xanh 1 cam nha em', { llm: () => { throw new Error('không hỏi mô hình'); } });
  assert.equal(turn.result.templateId, 'GIFT_SWAP_NOTED', JSON.stringify(turn.result));
  assert.deepEqual(turn.notes.map(note => note.orderId), ['o9']);
  assert.match(turn.notes[0].note, /Khách đổi quà.*1 Gói granola nhỏ Xanh 35g \+ 1 Gói granola nhỏ Cam 30g/);
  // Không phải chọn quà: đặt túi lớn, câu hỏi, tin có SĐT.
  for (const text of ['cho chị 2 túi xanh nữa', 'gói nâu là vị gì vậy em?', `${PHONE} nâu`]) {
    const other = new Sim({ settings: { ruleIntent: 'off' } });
    const otherInbox = other.inbox({ botLastTemplateId: 'GIFT_SWAP', botLastReplyAt: Date.now() - MIN, giftSwapAskedAt: Date.now() - MIN });
    const result = await other.send(otherInbox, text, { llm: { template_id: 'GENERAL_INFO' } });
    assert.notEqual(result.result.templateId, 'GIFT_SWAP_NOTED', text);
    assert.equal(otherInbox.giftSwapChoice, undefined, text);
  }
});

test('bình luận dưới bài LIVE → nhắn riêng: hộp thư mang cờ khách live + thẻ, giỏ đi theo mang livestream; đơn chốt ở hộp thư giữ quà live', () => withLiveGift(async () => {
  const sim = new Sim();
  // Hộp thư của khách đã có từ trước, gắn với một bài/quảng cáo THƯỜNG (không kế thừa bài live).
  const inbox = sim.inbox({ post: { id: 'ad-1', message: 'Granola túi xanh giòn rụm, ăn sáng tiện lợi' } });
  const thread = sim.comment({ post: LIVE_POST });
  assert.equal(isLivestreamCustomer(inbox), false);
  const comment = await sim.send(thread, 'Lấy 1 xanh 1 vàng nha shop', { llm: { template_id: 'GENERAL_INFO' } });
  assert.equal(comment.result.templateId, 'ORDER_ADDRESS', JSON.stringify(comment.result));
  assert.equal(inbox.livestreamCustomer, true);
  assert.ok(inbox.labels.includes('livestream'));
  assert.equal(inbox.pendingOrder.livestream, true);
  assert.equal(isLivestreamCustomer(inbox), true);
  // Khách vào hộp thư gửi SĐT + địa chỉ → đơn 2 túi có quà live (Quạt + Bát gáo dừa), cờ livestream.
  const closed = await sim.send(inbox, `${PHONE} ${ADDRESS}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDRESS } });
  assert.equal(closed.created.length, 1, JSON.stringify(closed.result));
  assert.match(String(closed.created[0].gift), /Quạt/);
  assert.equal(closed.created[0].livestream, true);
  assert.equal(closed.record.ctx.livestream, true);
  const stored = normalizeChatbotOrder(closed.created[0], { name: 'Khách', post: { message: 'bài thường' } });
  assert.equal(stored.livestream, true, 'đơn lưu giữ cờ live dù hội thoại gắn bài thường');
  assert.match(stored.address, /^\(Live\) /);
  // Đối chứng: bình luận dưới bài THƯỜNG không gắn cờ live cho hộp thư.
  const plain = new Sim({ psid: 'plain' });
  const plainInbox = plain.inbox();
  const plainThread = plain.comment();
  await plain.send(plainThread, 'Lấy 1 xanh 1 vàng nha shop', { llm: { template_id: 'GENERAL_INFO' } });
  assert.notEqual(plainInbox.livestreamCustomer, true);
  assert.equal(plainInbox.pendingOrder?.livestream, undefined);
}));

test('"Cho mình 2 túi nhé" → hỏi vị (hai tin bot liền nhau) → SĐT → "vàng": đơn là 2 Túi Vàng, số túi không rơi ở lượt SĐT', async () => {
  const sim = new Sim();
  const inbox = sim.inbox();
  sim.history(inbox, 'incoming', 'Cho mình 2 túi nhé', 3 * MIN);
  sim.history(inbox, 'outgoing', 'Dạ bên em có 3 vị: Túi Xanh nguyên bản 450g, Túi Vàng nhiều hạt 350g và Túi Nâu cacao 350g ạ.', 3 * MIN - 1000, { sender: 'bot' });
  sim.history(inbox, 'outgoing', 'Chị muốn lấy vị nào và mỗi vị mấy túi để em lên đơn nha ạ?', 3 * MIN - 2000, { sender: 'bot' });
  Object.assign(inbox, { botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: Date.now() - 3 * MIN + 2000 });
  const seen = [];
  const spy = { ruleIntent: (text, ctx) => { seen.push(ctx); return null; } };
  await sim.send(inbox, 'vàng', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1' }, extra: spy });
  assert.equal(seen.at(-1).askedBagCount, 2, 'đọc được số túi khách nêu trước cụm hai tin bot');
  // Lượt SĐT (luật ORDER_INFO dựng lại giỏ chờ): askedBagCount / giftSwap / livestream của giỏ trước được chép sang.
  const info = new Sim();
  const infoInbox = info.inbox({ botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: Date.now() - MIN, pendingOrder: { items: [], key: '', at: Date.now() - MIN, phone: '', address: '', addressAsks: 0, askedBagCount: 2, livestream: true } });
  const phoneRule = { ruleIntent: () => ({ rule: 'ORDER_INFO', value: { template_id: 'ORDER_INFO_ASK_FLAVOR', Phone_Number: PHONE } }) };
  const phoneTurn = await info.send(infoInbox, PHONE, { extra: phoneRule });
  assert.equal(phoneTurn.result.templateId, 'ORDER_INFO_ASK_FLAVOR', JSON.stringify(phoneTurn.result));
  assert.equal(infoInbox.pendingOrder.phone, PHONE);
  assert.equal(infoInbox.pendingOrder.askedBagCount, 2, 'số túi còn sau lượt SĐT');
  assert.equal(infoInbox.pendingOrder.livestream, true);
});
