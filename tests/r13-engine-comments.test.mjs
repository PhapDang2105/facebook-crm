// Vòng 13 (02/10) — bình luận (out-comments F2/F4/F5/F7/F8/F9): đọc số lượng bằng chữ và chữ đệm, không đoán vị dưới bài
// live, món lạ trong giỏ, câu mở đầu lặp, chặn trùng 30 phút nuốt câu hỏi khác, bình luận tag tên, ẩn đúng bình luận có SĐT.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE } from './helpers/r13-engine-sim.mjs';
import { commentBasket, commentBasketUnknown, isTagOnlyComment } from '../app/chatbot-engine.mjs';
import { moderateComment } from '../app/meta-sync.mjs';

const MIN = 60 * 1000;
const LIVE_POST = { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ' };
const lines = items => items.map(item => `${item.quantity} ${item.product}`).sort();

test('commentBasket đọc số bằng chữ và chữ đệm: "2 túi hạt vàng", "Hai túi hạt vàng" = 2 Túi Vàng', () => {
  assert.deepEqual(lines(commentBasket('2 túi hạt vàng')), ['2 Granola Túi Vàng 350g']);
  assert.deepEqual(lines(commentBasket('Hai túi hạt vàng')), ['2 Granola Túi Vàng 350g']);
  assert.deepEqual(lines(commentBasket('ba xanh nha shop')), ['3 Granola Túi Xanh 450g']);
  assert.deepEqual(lines(commentBasket('Lấy 2 túi loại xanh với một túi vị nâu')), ['1 Granola Túi Nâu vị cacao 350g', '2 Granola Túi Xanh 450g']);
  // Hành vi cũ giữ nguyên.
  assert.deepEqual(lines(commentBasket('2 xanh 1 vàng')), ['1 Granola Túi Vàng 350g', '2 Granola Túi Xanh 450g']);
  assert.deepEqual(lines(commentBasket('vàng 2 nâu 1')), ['1 Granola Túi Nâu vị cacao 350g', '2 Granola Túi Vàng 350g']);
  // "bà" (bỏ dấu là "ba") đứng trước từ khác không phải số 3.
  assert.deepEqual(lines(commentBasket('Bà lấy túi vàng nha')), ['1 Granola Túi Vàng 350g']);
  assert.deepEqual(commentBasket('giá bao nhiêu'), []);
});

test('commentBasketUnknown: giỏ có món bộ đọc không biết ("1 tui nau 1 yen mach", "1 xanh, 1 cam", "Tui xanh va 10goi")', () => {
  for (const text of ['1 tui nau 1 yen mach', '1 xanh, 1 cam', 'Tui xanh va 10goi']) assert.equal(commentBasketUnknown(text), true, text);
  // R17 (chủ shop 10/10: Combo 10 gói Cam vẫn bán): bộ đọc giỏ đã đọc ra túi lớn + Combo 10 gói Cam → không còn lạ.
  assert.equal(commentBasketUnknown('lấy 1 túi xanh với 2 gói cam nha'), false);
  for (const text of ['1 xanh 1 vàng', '2 túi xanh', 'cảm ơn shop', 'túi cam giá bao nhiêu', 'yến mạch có không shop', 'Xin giá', '.', 'túi xanh với hộp 10 gói khác gì nhau']) assert.equal(commentBasketUnknown(text), false, text);
});

test('bình luận đặt giỏ có món lạ: ghi nhận nguyên văn (ORDER_CUSTOM_BASKET) + thẻ, không dựng giỏ thiếu món', async () => {
  const sim = new Sim();
  const thread = sim.comment();
  const turn = await sim.send(thread, '1 tui nau 1 yen mach', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '1' } });
  assert.equal(turn.result.templateId, 'ORDER_CUSTOM_BASKET', JSON.stringify(turn.result));
  const privateText = turn.sent.find(item => item.privateReply).text;
  assert.match(privateText, /1 tui nau 1 yen mach/);
  assert.ok(thread.labels.includes('handoff'));
  assert.equal(sim.inbox().pendingOrder, undefined, 'không mang giỏ 1 Túi Nâu (thiếu yến mạch) sang hộp thư');
});

test('dưới bài LIVE khách nêu số túi mà không nêu vị: hỏi vị (ASK_FLAVOR) và giữ số túi, không đoán vị', async () => {
  const sim = new Sim();
  const thread = sim.comment({ post: LIVE_POST });
  const turn = await sim.send(thread, 'Lấy 2 túi nha shop', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' } });
  assert.equal(turn.result.templateId, 'ASK_FLAVOR', JSON.stringify(turn.result));
  const inbox = sim.inbox();
  assert.deepEqual(inbox.pendingOrder.items, []);
  assert.equal(inbox.pendingOrder.askedBagCount, 2);
  assert.equal(inbox.botLastTemplateId, 'ASK_FLAVOR');
  // Khách nêu vị thì vẫn lên bước đơn với đúng giỏ.
  const named = new Sim({ psid: 'named' });
  const namedThread = named.comment({ post: LIVE_POST });
  const basket = await named.send(namedThread, 'Lấy 2 túi vàng nha shop', { llm: { template_id: 'GENERAL_INFO' } });
  assert.equal(basket.result.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(named.inbox().pendingOrder.items.map(item => `${item.quantity} ${item.code}`), ['2 GRA-VANG-H350']);
  // Bài một sản phẩm (không phải live): giữ hành vi cũ — theo sản phẩm của bài.
  const single = new Sim({ psid: 'single' });
  const singleThread = single.comment({ post: { id: 'p-xanh', message: 'Granola túi xanh 450g giòn rụm' } });
  const kept = await single.send(singleThread, 'Lấy 2 túi nha shop', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' } });
  assert.notEqual(kept.result.templateId, 'ASK_FLAVOR');
});

test('khách bình luận liên tiếp: tin riêng thứ hai bỏ câu mở đầu "em thấy … để lại bình luận" khi hộp thư vừa có tin Page < 30 phút', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const thread = sim.comment();
  const first = await sim.send(thread, 'túi xanh giá bao nhiêu', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Xanh 450g' } });
  assert.match(first.sent.find(item => item.privateReply).text, /để lại bình luận/);
  const second = await sim.send(thread, 'hạn sử dụng bao lâu vậy', { llm: { template_id: 'WEIGHT_EXPIRY' } });
  const privateText = second.sent.find(item => item.privateReply)?.text || '';
  assert.ok(privateText.length > 0, 'câu hỏi khác vẫn được trả lời riêng');
  assert.doesNotMatch(privateText, /để lại bình luận/);
  // Cùng nội dung y hệt (có/không câu mở đầu) trong 24 giờ thì không gửi lại.
  const again = await sim.send(thread, 'hsd bao lâu', { llm: { template_id: 'WEIGHT_EXPIRY' } });
  assert.equal(again.sent.filter(item => item.privateReply).length, 0);
  assert.equal(again.result.privateSkipped, true);
});

test('chặn trùng bảng giá 30 phút chỉ áp cho lượt hỏi giá cụt (".", "ib"); câu hỏi giá sản phẩm khác vẫn được trả lời', async () => {
  const sim = new Sim();
  const thread = sim.comment({ post: { id: 'p', message: 'Các loại granola nhà Giọt Nắng' } });
  const first = await sim.send(thread, 'ib', { llm: { template_id: 'GENERAL_INFO' } });
  assert.equal(first.sent.filter(item => item.privateReply).length, 1);
  // 5 phút sau khách để "." dưới bài: bảng giá vừa gửi → không gửi thêm bảng thứ hai.
  const dots = await sim.send(thread, '.', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Xanh 450g' } });
  assert.equal(dots.sent.filter(item => item.privateReply).length, 0, JSON.stringify(dots.result));
  // Khách hỏi giá Túi Vàng: câu hỏi KHÁC — trước đây cũng bị nuốt vì cùng "họ bảng giá".
  const yellow = await sim.send(thread, 'túi vàng nhiều hạt giá bao nhiêu shop', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Vàng 350g' } });
  assert.equal(yellow.sent.filter(item => item.privateReply).length, 1, JSON.stringify(yellow.result));
  assert.match(yellow.sent.find(item => item.privateReply).text, /Túi Vàng/);
});

test('bình luận chỉ là tên người có Anh / Chi / Minh / Gia / Tuyết: không trả lời; câu nói viết hoa đầu chữ vẫn trả lời', () => {
  for (const text of ['Nguyễn Minh Anh', 'Trần Gia Hân', 'Lê Ánh Tuyết', 'Phạm Thùy Chi', 'Minh Anh', 'Hoàng Lâm', 'Nguyen Minh Anh']) assert.equal(isTagOnlyComment({ text }), true, text);
  for (const text of ['Xin Giá', 'Cảm Ơn Shop', 'Anh Em', 'Chị Em', 'Tuyệt Vời', 'Ngon Lắm', 'Cho Mình Giá', 'Túi Xanh', 'Ib Em', 'Giá Sao Shop']) assert.equal(isTagOnlyComment({ text }), false, text);
  assert.equal(isTagOnlyComment({ text: 'Lan Anh xem nè', messageTags: [{ name: 'Lan Anh' }] }), false);
  assert.equal(isTagOnlyComment({ text: 'Lan Anh', messageTags: [{ name: 'Lan Anh' }] }), true);
});

test('gộp nhiều bình luận: ẩn ĐÚNG bình luận có SĐT (không phải bình luận cuối), like bình luận cuối', async () => {
  const sim = new Sim();
  const thread = sim.comment();
  const withPhone = sim.history(thread, 'incoming', `Lấy 2 túi xanh ${PHONE}`, 5000, { commentId: 'cm-phone' });
  const turn = await sim.send(thread, 'ship về Hà Nội nha', { llm: { template_id: 'GENERAL_INFO' }, message: { commentId: 'cm-last' } });
  const hidden = turn.moderated.filter(item => item.hide).map(item => item.id);
  assert.deepEqual(hidden, [withPhone.id], 'chỉ bình luận có SĐT bị ẩn');
  const liked = turn.moderated.filter(item => item.like).map(item => item.id);
  assert.deepEqual(liked, [turn.incoming.id], 'like bình luận cuối');
  assert.ok(!turn.moderated.some(item => item.id === turn.incoming.id && item.hide), 'bình luận cuối không có SĐT thì không ẩn');
});

test('moderateComment với Page nối qua Pancake: không gọi API nào, ghi log rõ "không ẩn được: Page nối qua Pancake"', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = message => { warnings.push(String(message)); };
  try {
    const outcome = await moderateComment({ id: 'page:comment:u:1', pageId: 'page', pancakeConversationId: 'page_u', lastCommentId: 'cm-last' }, { id: 'cm-phone', commentId: 'cm-phone', direction: 'incoming' }, { like: true, hide: true });
    assert.deepEqual(outcome, { liked: false, hidden: false, reason: 'pancake' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Bình luận cm-phone không ẩn được: Page nối qua Pancake/);
    // Chỉ like (không ẩn): không cần log.
    await moderateComment({ id: 'c', pageId: 'page', pancakeConversationId: 'page_u', lastCommentId: 'cm-last' }, { id: 'cm-2', direction: 'incoming' }, { like: true, hide: false });
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = original;
  }
});
