// Vòng 15 (03/10) — engine: bình luận + ý phụ + STAFF_WAIT/ORDER_NOTE (out-comments A1–A6, out-inbox1 A3/A8). Câu khách thật.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, VANG, basket, templates } from './helpers/r13-engine-sim.mjs';
import { commentBasket } from '../app/chatbot-engine.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

const MIN = 60 * 1000;
const LIVE = { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ', isLive: true };
const priv = turn => turn.sent.filter(item => item.privateReply || !item.to.includes(':comment:')).map(item => item.text).join('\n');
const pub = turn => turn.sent.filter(item => !item.privateReply && item.to.includes(':comment:')).map(item => item.text).join('\n');

test('mục 7 (bình luận A6, inbox1 A3, ca …6422098884): bình luận "Túi vàng <sđt>" 3 phút sau câu calo — ý phụ CALORIES_DIET không gửi lại', async () => {
  const calories = renderChatbotReply({ template_id: 'CALORIES_DIET' }, templates, {}).messages.join('\n\n');
  const sim = new Sim({ psid: 'r15m7' });
  const inbox = sim.inbox({ botLastTemplateId: 'CALORIES_DIET', botLastReplyAt: Date.now() - 3 * MIN });
  sim.history(inbox, 'outgoing', calories, 3 * MIN, { sender: 'bot', privateReply: true });
  const thread = sim.comment({ post: LIVE, botLastTemplateId: 'CALORIES_DIET', botLastReplyAt: Date.now() - 3 * MIN });
  sim.history(thread, 'incoming', 'C muốn mua ăn kiêng', 3.2 * MIN);
  sim.history(thread, 'outgoing', 'Dạ em đã nhắn tin cho mình rồi ạ 🌾', 3 * MIN, { sender: 'bot' });
  const turn = await sim.send(thread, `Túi vàng ${PHONE}`, { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1', Phone_Number: PHONE, also: 'CALORIES_DIET' } });
  assert.doesNotMatch(priv(turn), /445 Kcal/);
  assert.match(priv(turn), /Granola Túi Vàng 350g/);
});

test('mục 8 (bình luận A2, inbox1 A8, ca …9603540695): vừa STAFF_WAIT mà nhân viên chưa trả lời → câu cùng chuyện im + thẻ; ORDER_NOTE cho câu về quà → GIFT_SWAP (không "đã ghi chú và báo kho")', async () => {
  const order = { id: 'o-3', createdAt: Date.now() - 10 * MIN, phone: PHONE, address: 'x', total: 447000, products: [{ name: 'Granola Túi Vàng 350g', sku: 'GRA-VANG-H350', quantity: 3 }], status: 'Mới', automatic: true };
  const sim = new Sim({ psid: 'r15m8' });
  const inbox = sim.inbox({ botLastTemplateId: 'STAFF_WAIT_OPEN', botLastReplyAt: Date.now() - MIN, customerOrders: [order], labels: ['livestream'] });
  const quiet = await sim.send(inbox, 'Nhưng giờ mua , choits đơn thấy khoing ghi vào nữa nên c hỏi lại', { llm: { template_id: 'ORDER_NOTE' } });
  assert.equal(quiet.result.skipped, 'đang chờ bạn phụ trách trả lời');
  assert.equal(quiet.sent.length, 0);
  assert.deepEqual(quiet.notes, []);
  assert.ok(inbox.labels.includes('handoff'));
  const sim2 = new Sim({ psid: 'r15m8b' });
  const box = sim2.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 5 * MIN, customerOrders: [{ ...order }], labels: ['livestream'] });
  const gift = await sim2.send(box, 'Lúc c mới hỏi combo 2 gói thì thấy trả lời tặng quạt và bát dừa', { llm: { template_id: 'ORDER_NOTE' } });
  assert.notEqual(gift.result.templateId, 'ORDER_NOTE');
  assert.doesNotMatch(gift.sent.map(item => item.text).join('\n'), /đã ghi chú yêu cầu của .* vào đơn và báo kho/);
  assert.ok(box.labels.includes('handoff'));
  // Lời dặn giao hàng thật vẫn là ORDER_NOTE.
  const sim3 = new Sim({ psid: 'r15m8c' });
  const box3 = sim3.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 5 * MIN, customerOrders: [{ ...order }] });
  const note = await sim3.send(box3, 'giao giờ hành chính giúp chị nha', { llm: { template_id: 'ORDER_NOTE' } });
  assert.equal(note.result.templateId, 'ORDER_NOTE');
});

test('mục 9a (bình luận A3, ca …076080; quyết định 11): "Bán mà nói nhỏ xíu sao nghe" (mô hình CSKH_HANDOFF) = góp ý live → chỉ cảm ơn công khai, không xin lỗi / không nhắn riêng', async () => {
  for (const text of ['Bán  mà nói  nhỏ  xíu  sao nghe', 'Nói nhỏ quá không nghe gì']) {
    const sim = new Sim({ psid: `r15m9a${text.length}` });
    const thread = sim.comment({ post: LIVE });
    const turn = await sim.send(thread, text, { llm: { template_id: 'CSKH_HANDOFF' } });
    assert.equal(priv(turn), '', text);
    assert.match(pub(turn), /cảm ơn góp ý/, text);
    assert.doesNotMatch(pub(turn), /xin lỗi/, text);
  }
});

test('mục 9b (bình luận A4, ca …024372): hộp thư giữ giỏ 2 Vàng, bình luận "Combo 2 túi vàng giá bao nhiêu được tặng gì e" → câu quà + nhắc giỏ, không cả bảng giá live', async () => {
  const sim = new Sim({ psid: 'r15m9b' });
  sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([VANG(2)], 3 * MIN), labels: ['livestream'] });
  const thread = sim.comment({ post: LIVE });
  const turn = await sim.send(thread, 'Combo 2 túi vàng giá bao nhiêu được tặng gì e', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Vàng 350g', also: 'GIFT_POLICY_LIVE' } });
  assert.equal(turn.result.templateId, 'ORDER_ADDRESS_REMIND', JSON.stringify(turn.result));
  assert.match(priv(turn), /vẫn đang giữ đơn 2 Granola Túi Vàng 350g/);
  assert.match(priv(turn), /Quạt \+ Bát gáo dừa/);
  assert.doesNotMatch(priv(turn), /phiên live nhà em có/);
});

test('mục 9c (bình luận A5, ca …020466 / …990595): commentBasket nhận "bi/bịt/bị", "1xanh", "Một bị màu vàng"; hỏi giá thì không phải giỏ', () => {
  const read = text => commentBasket(text).map(item => `${item.quantity} ${item.product}`);
  assert.deepEqual(read('1bi màu vàng'), ['1 Granola Túi Vàng 350g']);
  assert.deepEqual(read('Một bị màu vàng'), ['1 Granola Túi Vàng 350g']);
  assert.deepEqual(read('1xanh la'), ['1 Granola Túi Xanh 450g']);
  assert.deepEqual(read('2xanh la'), ['2 Granola Túi Xanh 450g']);
  assert.deepEqual(read('Bịt màu xanh nhiêu'), []);
  assert.deepEqual(read('Màu vàng'), []);
  assert.deepEqual(read('bao nhiêu một gói vậy'), []);
  assert.deepEqual(read('có hạt bí không'), []);
});
