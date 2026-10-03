// Vòng 14 (03/10) — engine, bình luận: câu khách thật 02–03/10 (out-comments, out-dl). SĐT giả 0912345678.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, XANH, basket } from './helpers/r13-engine-sim.mjs';
import { commentBasket, commentOffTopic, mentionsTropical, unansweredCustomerMessages } from '../app/chatbot-engine.mjs';

const LIVE_POST = { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ', isLive: true };
const lines = items => items.map(item => `${item.quantity} ${item.product}`).sort();
const privateOf = turn => turn.sent.filter(item => item.privateReply).map(item => item.text).join('\n');
const publicOf = turn => turn.sent.filter(item => !item.privateReply && item.to.includes(':comment:')).map(item => item.text).join('\n');

test('N1 (ca …967034): "3 túi vàng, xanh, nâu" = mỗi vị 1 (3 túi), không phải 3 Vàng + 1 Xanh + 1 Nâu (740k)', () => {
  assert.deepEqual(lines(commentBasket('3 túi vàng, xanh, nâu')), ['1 Granola Túi Nâu vị cacao 350g', '1 Granola Túi Vàng 350g', '1 Granola Túi Xanh 450g']);
  assert.deepEqual(lines(commentBasket('2 túi xanh vàng')), ['1 Granola Túi Vàng 350g', '1 Granola Túi Xanh 450g']);
  const detail = {};
  assert.deepEqual(commentBasket('3 túi vàng, xanh', detail), []);
  assert.equal(detail.askCount, 3);
  // Hành vi cũ giữ nguyên.
  assert.deepEqual(lines(commentBasket('2 xanh 1 vàng')), ['1 Granola Túi Vàng 350g', '2 Granola Túi Xanh 450g']);
  assert.deepEqual(lines(commentBasket('Lấy 2 túi loại xanh với một túi vị nâu')), ['1 Granola Túi Nâu vị cacao 350g', '2 Granola Túi Xanh 450g']);
});

test('commentBasket: "combo 10 gói xanh" là hộp 10 gói (không phải 10 Túi Xanh); "Hộp 10 gói và 1 túi xanh" không dựng giỏ thiếu hộp', () => {
  assert.ok(!commentBasket('combo 10 gói xanh').some(item => /Túi Xanh 450g/.test(item.product)));
  const box = commentBasket('lấy combo 10 gói xanh');
  assert.equal(box.length, 1);
  assert.match(box[0].product, /Combo 10|10 gói/i);
  assert.equal(box[0].quantity, 1);
  assert.deepEqual(commentBasket('Hộp 10 gói và 1 túi xanh'), []);
});

test('N1: bình luận "3 túi vàng, xanh" (số túi khác số vị) → hỏi vị, giữ 3 túi sang hộp thư', async () => {
  const sim = new Sim();
  const thread = sim.comment({ post: LIVE_POST });
  const turn = await sim.send(thread, '3 túi vàng, xanh', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '3', Product_N2: 'Granola Túi Xanh 450g', No_B: '1' } });
  assert.equal(turn.result.templateId, 'ASK_FLAVOR', JSON.stringify(turn.result));
  assert.equal(sim.inbox().pendingOrder.askedBagCount, 3);
});

test('P4 (ca …853104): "1 xanh 1 vàng nhiêu tiền" là hỏi giá — không đổi thành bước xin SĐT/địa chỉ', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const thread = sim.comment();
  const turn = await sim.send(thread, '1 xanh 1 vàng nhiêu tiền', { llm: { template_id: 'PRICE_MIX_TUI_LON' } });
  assert.notEqual(turn.result.templateId, 'ORDER_ADDRESS', JSON.stringify(turn.result));
  assert.doesNotMatch(privateOf(turn), /số điện thoại và địa chỉ/);
  // Giỏ vẫn đi theo sang hộp thư.
  assert.equal(sim.inbox().pendingOrder.items.length, 2);
});

test('M3: dưới live "Săn ntn ạh" → lời chào live (không "đã săn deal"); "Mình đã mua, ăn ngon nha" → chỉ cảm ơn công khai, không nhắn riêng', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const thread = sim.comment({ post: LIVE_POST });
  const how = await sim.send(thread, 'Săn ntn ạh', { llm: { template_id: 'ORDER_STATUS' } });
  assert.notEqual(how.result.templateId, 'LIVE_DEAL_CLAIMED', JSON.stringify(how.result));
  assert.doesNotMatch(privateOf(how), /đã săn deal/);
  const sim2 = new Sim({ psid: 'p2', settings: { ruleIntent: 'off' } });
  const thread2 = sim2.comment({ post: LIVE_POST });
  const praise = await sim2.send(thread2, 'Mình đã mua, ăn ngon nha', { llm: { template_id: 'ORDER_STATUS' } });
  assert.equal(privateOf(praise), '', JSON.stringify(praise.result));
  assert.match(publicOf(praise), /cảm ơn/);
  // Báo đã săn thật vẫn được ghi nhận.
  const sim3 = new Sim({ psid: 'p3', settings: { ruleIntent: 'off' } });
  const thread3 = sim3.comment({ post: LIVE_POST });
  const claimed = await sim3.send(thread3, 'Mình đã săn được rồi nha', { llm: { template_id: 'ORDER_STATUS' } });
  assert.equal(claimed.result.templateId, 'LIVE_DEAL_CLAIMED');
});

test('quyết định 4 (C1/P2): "Không như quảng cáo", "mua về mở ra toàn yến mạch", "Dỡ" dưới bài → xin lỗi công khai, nhân viên nhắn riêng, thẻ Khiếu nại, không bảng giá', async () => {
  const cases = [
    ['Không như quảng cáo', 'CSKH_HANDOFF'],
    ['Em đã từng mua không đúng với quoảng cáo', 'CSKH_HANDOFF'],
    ['Quảng cáo thì nhìn ngon, mua về mở ra toàn yến mạch', 'PRICE_QUOTE'],
    ['Dỡ', 'CSKH_HANDOFF']
  ];
  for (const [index, [text, chosen]] of cases.entries()) {
    const sim = new Sim({ psid: `c${index}`, settings: { ruleIntent: 'off' } });
    const thread = sim.comment();
    const turn = await sim.send(thread, text, { llm: { template_id: chosen } });
    assert.equal(turn.result.templateId, 'COMMENT_STAFF_FOLLOWUP', `${text}: ${JSON.stringify(turn.result)}`);
    assert.match(publicOf(turn), /xin lỗi/, text);
    assert.doesNotMatch(privateOf(turn), /Bảng giá|174\.000/, text);
    assert.ok(thread.labels.includes('complaint'), text);
  }
  // Mô hình chọn CSKH_HANDOFF cho câu hỏi giá thì vẫn trả bảng giá như cũ (không xin lỗi).
  const sim = new Sim({ psid: 'price', settings: { ruleIntent: 'off' } });
  const thread = sim.comment();
  const price = await sim.send(thread, 'giá bao nhiêu shop', { llm: { template_id: 'CSKH_HANDOFF' } });
  assert.notEqual(price.result.templateId, 'COMMENT_STAFF_FOLLOWUP');
  assert.doesNotMatch(publicOf(price), /xin lỗi/);
});

test('quyết định 9 (T1): bình luận đùa/không liên quan → chỉ like, không nhắn riêng, không lời công khai', async () => {
  assert.equal(commentOffTopic({ text: 'Mặc quần k đẹp', chosen: 'WELCOME', praise: true }), true);
  assert.equal(commentOffTopic({ text: 'Chào chị', chosen: 'WELCOME' }), false);
  assert.equal(commentOffTopic({ text: 'cảm ơn shop', chosen: 'THANK_YOU', praise: true }), false);
  for (const [text, chosen] of [['Mặc quần k đẹp', 'WELCOME'], ['Xong ăn thêm bát phở nữa', 'THANK_YOU']]) {
    const sim = new Sim({ settings: { ruleIntent: 'off' } });
    const thread = sim.comment({ post: LIVE_POST });
    const turn = await sim.send(thread, text, { llm: { template_id: chosen } });
    assert.deepEqual(turn.sent, [], `${text}: ${JSON.stringify(turn.result)}`);
    assert.ok(turn.moderated.some(item => item.like), text);
  }
});

test('C2 (ca …039804, …918439): hộp thư đang giữ giỏ Shop mà khách bình luận "Mua sao shop ơi" / "." → tin riêng nhắc giỏ, không bảng giá live', async () => {
  for (const text of ['Mua sao shop ơi', '.']) {
    const sim = new Sim({ settings: { ruleIntent: 'off' } });
    sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 60000, pendingOrder: basket([XANH(2)], 60000) });
    const thread = sim.comment({ post: LIVE_POST });
    const turn = await sim.send(thread, text, { llm: { template_id: 'GENERAL_INFO' } });
    assert.equal(turn.result.templateId, 'ORDER_ADDRESS_REMIND', `${text}: ${JSON.stringify(turn.result)}`);
    assert.match(privateOf(turn), /2 Granola Túi Xanh 450g/);
    assert.doesNotMatch(privateOf(turn), /phiên live nhà em có/);
  }
  // ORDER_WRONG khi hộp thư vừa có giỏ Shop → bạn phụ trách nhắn (ca …551125).
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox();
  sim.history(inbox, 'incoming', 'Khách chọn mua từ Facebook Shop: Granola (CB-VANGG+XANH) — 298.000đ', 5 * 60000, { cart: [{ sku: 'CB-VANGG+XANH', quantity: 1 }] });
  const thread = sim.comment();
  const wrong = await sim.send(thread, 'Bên em đang xác nhận đơn không đúng', { llm: { template_id: 'ORDER_WRONG' } });
  assert.equal(wrong.result.templateId, 'COMMENT_STAFF_FOLLOWUP', JSON.stringify(wrong.result));
});

test('C3 (ca …330895): bình luận nhường "nhân viên đang xử lý" → thẻ + ghi chú nội dung bình luận vào HỘP THƯ', async () => {
  const notes = [];
  const sim = new Sim();
  const inbox = sim.inbox({ botEnabled: false });
  sim.history(inbox, 'outgoing', 'Dạ chị chờ em chút nha', 30 * 60000, { staff: true });
  const thread = sim.comment({ post: LIVE_POST });
  const turn = await sim.send(thread, 'Mua mầu vàng bn e', { extra: { addStaffNote: async (conversation, note) => { notes.push({ id: conversation.id, note }); } } });
  assert.equal(turn.result.skipped, 'nhân viên đang xử lý', JSON.stringify(turn.result));
  assert.ok(inbox.labels.includes('handoff'), 'thẻ ở hộp thư');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, inbox.id);
  assert.match(notes[0].note, /Mua mầu vàng bn e/);
});

test('M1 (ca …853104): tin riêng lỗi #100 → không thử lại; khách còn trong cửa sổ 24 giờ → gửi câu trả lời vào hộp thư', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox();
  sim.history(inbox, 'incoming', 'Tặng quạt gì', 5 * 60000);
  const thread = sim.comment({ post: LIVE_POST });
  sim.history(thread, 'outgoing', 'Dạ em đã nhắn tin cho mình rồi ạ', 3 * 60000);
  let privateTries = 0;
  const sent = [];
  const sendMessage = async (conversation, payload) => {
    if (payload.privateReply) { privateTries += 1; throw new Error('Pancake: (#100, 1893060) Invalid parameter'); }
    sent.push({ to: conversation.id, text: payload.text });
    return { message: { id: `x${sent.length}` } };
  };
  const turn = await sim.send(thread, 'Màu trắng dâu nhieu', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Tropical vị Cacao 300g' }, extra: { sendMessage } });
  assert.equal(privateTries, 1, 'lỗi #100 là vĩnh viễn — không thử lại');
  assert.ok(sent.some(item => item.to === inbox.id && /Tropical/.test(item.text)), JSON.stringify(sent));
  assert.ok(!inbox.botLastError, 'đã tới khách qua hộp thư');
  // Không có cửa sổ 24 giờ (khách chưa nhắn hộp thư): vẫn đăng lời dự phòng mời nhắn Page dù vừa có lời công khai.
  const sim2 = new Sim({ psid: 'p2', settings: { ruleIntent: 'off' } });
  const thread2 = sim2.comment({ post: LIVE_POST });
  sim2.history(thread2, 'outgoing', 'Dạ em đã nhắn tin cho mình rồi ạ', 3 * 60000);
  const sent2 = [];
  const turn2 = await sim2.send(thread2, 'Màu trắng dâu nhieu', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Tropical vị Cacao 300g' }, extra: { sendMessage: async (conversation, payload) => { if (payload.privateReply) throw new Error('(#10903) This person isn\'t available'); sent2.push(payload.text); return { message: { id: 'y' } }; } } });
  assert.match(sent2.join('\n'), /Messenger|ib cho Page/, JSON.stringify(turn2.result));
});

test('M2 (ca …029290): bình luận đã có lượt xử lý / cách quá 60 giây không bị gộp với bình luận sau', () => {
  const now = Date.now();
  const list = [
    { id: 'a', direction: 'incoming', type: 'text', text: 'Túi Vàng', createdAt: now - 9 * 60000 },
    { id: 'b', direction: 'incoming', type: 'text', text: 'Lấy chị Túi xanh', createdAt: now }
  ];
  assert.deepEqual(unansweredCustomerMessages(list, list[1]).map(item => item.id), ['a', 'b'], 'hộp thư: như cũ');
  assert.deepEqual(unansweredCustomerMessages(list, list[1], { maxGapMs: 60000 }).map(item => item.id), ['b']);
  const close = [{ ...list[0], createdAt: now - 20000 }, list[1]];
  assert.deepEqual(unansweredCustomerMessages(close, close[1], { maxGapMs: 60000 }).map(item => item.id), ['a', 'b']);
  assert.deepEqual(unansweredCustomerMessages(close, close[1], { maxGapMs: 60000, handledAt: now - 10000 }).map(item => item.id), ['b'], 'bot đã trả lời sau tin a');
  assert.deepEqual(unansweredCustomerMessages(close, close[1], { maxGapMs: 60000, handledId: 'a' }).map(item => item.id), ['b']);
});

test('"túi ĐÂU" không phải "túi dâu" (Tropical)', () => {
  assert.equal(mentionsTropical('Em kiểm tra lại tin nhắn a có đặt đơn 2 túi đâu'), false);
  assert.equal(mentionsTropical('Túi có dâu để ăn thử'), true);
  assert.equal(mentionsTropical('Màu trắng dâu nhieu'), true);
});
