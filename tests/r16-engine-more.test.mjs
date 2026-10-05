// Vòng 16 (05/10) — phần 2: mục 5–17 và việc bổ sung của điều phối (bình luận A3/A4/A5, B1, bám đuổi B6). Câu khách lấy đúng
// từ hội thoại thật (không tên, SĐT/địa chỉ giả khi không cần câu gốc).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { Sim, PHONE, XANH, VANG, NAU, basket, seedTemplates, templates } from './helpers/r13-engine-sim.mjs';
import { commentBasket, declinesBuyingMore, isExclamationOnly } from '../app/chatbot-engine.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';
import { missedBotChanges } from '../app/pancake.mjs';
import { lateInfoNeedsBot } from '../app/conversation-orders.mjs';
import { customerDeclined, followUpSkipReason } from '../app/follow-up.mjs';
import { reloadCatalog } from '../app/processing/catalog.mjs';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const X = 'Granola Túi Xanh 450g';
const codes = items => (items || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const texts = turn => turn.sent.map(item => item.text).join(' ‖ ');
const STAFF = /^STAFF_WAIT_(OPEN|CLOSED)$/;

// ---- 5. (inbox2 C1, ca …2153698503)
test('5. "Mình lấy 2 túi" / "Màu vàng nhiều hạt nhé" / "Cho về địa chỉ cũ cho mình" → giỏ 2 Túi Vàng + địa chỉ cũ, không hỏi lại vị', async () => {
  const PRICE = 'Dạ, em gửi chị Bảng giá Granola Túi Vàng 350g để mình dễ tham khảo ạ: …';
  for (const split of [true, false]) {
    const sim = new Sim({ psid: `r16m-5-${split}` });
    const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 2 * MIN });
    sim.history(inbox, 'outgoing', PRICE, 2 * MIN, { sender: 'bot' });
    if (split) { sim.history(inbox, 'incoming', 'Mình lấy 2 túi', 3000); sim.history(inbox, 'incoming', 'Màu vàng nhiều hạt nhé', 2000); }
    const turn = await sim.send(inbox, split ? 'Cho về địa chỉ cũ cho mình' : 'Mình lấy 2 túi\nMàu vàng nhiều hạt nhé\nCho về địa chỉ cũ cho mình', { llm: { template_id: 'ASK_PRODUCT' } });
    assert.equal(turn.result.templateId, 'ORDER_ADDRESS_OLD_ASK_PHONE', `${split}: ${JSON.stringify(turn.result)}`);
    assert.deepEqual(codes(inbox.pendingOrder.items), ['2 GRA-VANG-H350']);
    assert.doesNotMatch(texts(turn), /vị nào/);
  }
});

// ---- 6. (inbox5 A1, ca …0740541679)
test('6. tin muộn có SĐT + địa chỉ, sau nó chỉ có lời bot cho tin CŨ hơn → vẫn đưa bot và lên đơn; có lời nhân viên / thiếu mốc thì không', async () => {
  const sim = new Sim({ psid: 'r16m-6' });
  const firstAt = Date.now() - 3 * MIN;
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'GIFT_POLICY', botLastReplyAt: Date.now() - MIN, botAnsweredUpTo: firstAt, pendingOrder: basket([XANH(2)], MIN, { livestream: true }) });
  sim.history(inbox, 'incoming', 'Ok chị chốt 2 túi nhé có được tặng bát dừa không em😊', 3 * MIN);
  const late = sim.history(inbox, 'incoming', `${PHONE} Trường mầm non An Đạo xã Bình Phú Tỉnh Phú Thọ`, 2 * MIN);
  sim.history(inbox, 'outgoing', 'Dạ … chị cho em xin số điện thoại và địa chỉ nhận hàng nha', MIN, { sender: 'bot' });
  const store = { messages: { [inbox.id]: sim.list(inbox.id) } };
  assert.equal(missedBotChanges([{ type: 'message', conversation: inbox, message: late }], store).length, 1);
  const turn = await sim.send(inbox, '', { existing: late, change: { late: true }, llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '2', Phone_Number: PHONE, Customer_Address: 'Trường mầm non An Đạo xã Bình Phú Tỉnh Phú Thọ' } });
  assert.notEqual(turn.result.skipped, 'đã có người trả lời');
  assert.equal(turn.created.length, 1);
  assert.equal(lateInfoNeedsBot(sim.list(inbox.id), late, { answeredUpTo: 0 }), false, 'thiếu mốc (dữ liệu cũ)');
  assert.equal(lateInfoNeedsBot(sim.list(inbox.id), { ...late, text: 'cảm ơn em' }, { answeredUpTo: firstAt }), false, 'tin không mang thông tin đơn');
  sim.history(inbox, 'outgoing', 'dạ chị', 0.5 * MIN, { staff: true });
  assert.equal(lateInfoNeedsBot(sim.list(inbox.id), late, { answeredUpTo: firstAt }), false, 'có lời nhân viên sau tin');
});

// ---- 7. (inbox2 C2, ca …7835884664)
test('7. tin "." mà khách nhắn "Mua hạt" ngay sau → bỏ lượt "."', async () => {
  const sim = new Sim({ psid: 'r16m-7' });
  const inbox = sim.inbox();
  let calls = 0;
  const listMessages = async id => { calls += 1; const list = [...sim.list(id)]; return calls >= 2 ? [...list, { id: 'later', direction: 'incoming', type: 'text', text: 'Mua hạt', createdAt: Date.now() + 1000 }] : list; };
  const turn = await sim.send(inbox, '.', { llm: { template_id: 'GENERAL_INFO' }, extra: { listMessages } });
  assert.deepEqual(turn.sent, []);
  assert.equal(turn.result.skipped, 'gộp với tin sau');
});

// ---- 8. (inbox4 H2 ca …479835, inbox1 A5 ca …0716122894)
test('8. commentBasket: câu hỏi so sánh / "N loại" không phải giỏ; câu đặt vẫn đọc như cũ', () => {
  for (const text of ['Tui vang khac tui xanh sao vay sop', 'Túi xanh với túi vàng khác gì nhau ạ', 'sao co 2loai tui xanh va tui vang']) assert.deepEqual(commentBasket(text), [], text);
  assert.deepEqual(commentBasket('1 xanh 1 vàng').map(item => item.quantity), [1, 1]);
  assert.deepEqual(commentBasket('lấy 2 túi vàng').map(item => item.quantity), [2]);
  assert.equal(commentBasket('lấy 2 loại xanh vàng').length, 2);
});

test('8. bình luận "Tui vang khac tui xanh sao vay sop" → không mang giỏ sang hộp thư', async () => {
  const sim = new Sim({ psid: 'r16m-8a' });
  await sim.send(sim.comment(), 'Tui vang khac tui xanh sao vay sop', { llm: { template_id: 'BAG_COMPARISON_XANH_VANG' } });
  assert.ok(!sim.inbox().pendingOrder?.items?.length, JSON.stringify(sim.inbox().pendingOrder));
});

test('8. hộp thư "da nhan hang roi nen kg mua nua" khi còn giỏ mang từ bình luận → xoá giỏ, không STAFF_WAIT / "chưa thấy đơn"', async () => {
  assert.equal(declinesBuyingMore('da nhan hang roi nen kg mua nua'), true);
  assert.equal(declinesBuyingMore('không mua nữa thì sao'), false);
  const sim = new Sim({ psid: 'r16m-8b' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS_REMIND', botLastReplyAt: Date.now() - 5 * MIN, pendingOrder: basket([XANH(2), VANG(1)], 5 * MIN, { fromComment: true }) });
  const turn = await sim.send(inbox, 'da nhan hang roi nen kg mua nua', { llm: { template_id: 'ORDER_STATUS' } });
  assert.doesNotMatch(String(turn.result.templateId || ''), /STAFF_WAIT|ORDER_STATUS/);
  assert.ok(!inbox.pendingOrder?.items?.length, 'giỏ đã xoá');
});

// ---- 9. (inbox5 A2, ca …5122488996)
test('9. giỏ live 1X+1V+1N, "combo này có tặng quạt ko" → quà của chính giỏ + nhắc giỏ, không "lấy 2 túi vị nào"', async () => {
  const original = readFileSync(process.env.GIFTS_PATH, 'utf8');
  const gifts = JSON.parse(original);
  gifts.items.push({ id: 'qua-tang-live', name: 'Quạt + Bát gáo dừa', active: true, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 50 });
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  reloadCatalog();
  try {
    const sim = new Sim({ psid: 'r16m-9' });
    const inbox = sim.inbox({ post: { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ' }, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(1), VANG(1), NAU(1)], MIN, { livestream: true }) });
    sim.history(inbox, 'outgoing', 'Dạ đơn của chị gồm 1 Xanh + 1 Vàng + 1 Nâu, tổng 442.000đ … Chị cho em xin SĐT và địa chỉ', MIN, { sender: 'bot' });
    const turn = await sim.send(inbox, 'combo này có tặng quạt ko', { llm: { template_id: 'GIFT_POLICY' } });
    assert.doesNotMatch(texts(turn), /lấy 2 túi vị nào/);
    assert.match(texts(turn), /Bộ bát gáo dừa/);
    assert.match(texts(turn), /đang giữ đơn/);
  } finally { writeFileSync(process.env.GIFTS_PATH, original); reloadCatalog(); }
});

// ---- 10. (inbox2 C3, ca …2213582582)
test('10. "6túi thì giá thế nào vậy shop" khi giữ 3 Túi Vàng → báo giá, không kèm "đang giữ đơn 6 …"', async () => {
  const sim = new Sim({ psid: 'r16m-10' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 39000, pendingOrder: basket([VANG(3)], 40000) });
  sim.history(inbox, 'incoming', 'Shop gửi mình combo 3 túi vàng nha', 40000);
  sim.history(inbox, 'outgoing', 'Dạ đơn của chị gồm 3 Granola Túi Vàng 350g...', 39000, { sender: 'bot' });
  const turn = await sim.send(inbox, '6túi thì giá thế nào vậy shop', { llm: null });
  assert.equal(turn.result.templateId, 'PRICE_COUNT');
  assert.doesNotMatch(texts(turn), /đang giữ đơn 6/);
  assert.deepEqual(codes(inbox.pendingOrder.items), ['3 GRA-VANG-H350']);
});

// ---- 11. (inbox2 C4, ca …7325666033)
test('11. đơn vừa tạo < 60 phút, "Chị gửi nhé" (mô hình GENERAL_INFO) → THANK_YOU', async () => {
  const sim = new Sim({ psid: 'r16m-11' });
  const order = { id: 'o11', createdAt: Date.now() - 2 * MIN, phone: PHONE, address: 'x', total: 894000, products: [{ name: X, sku: 'GRA-XANH-Z450', quantity: 6 }], status: 'Mới', automatic: true };
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 2 * MIN, customerOrders: [order] });
  const turn = await sim.send(inbox, 'Chị gửi nhé', { llm: { template_id: 'GENERAL_INFO' } });
  assert.equal(turn.result.templateId, 'THANK_YOU', JSON.stringify(turn.result));
});

// ---- 12. (inbox3 A5, ca …3440168818)
test('12. "Uh ở xa quá nên hơi lâu e nhỉ" khi chưa có đơn → không "xin lỗi đơn giao chậm"; có đơn 5 ngày thì vẫn DELIVERY_DELAY', async () => {
  const sim = new Sim({ psid: 'r16m-12' });
  const inbox = sim.inbox({ botLastTemplateId: 'SHIPPING_POLICY', botLastReplyAt: Date.now() - 3 * MIN });
  const turn = await sim.send(inbox, 'Uh ở xa quá nên hơi lâu e nhỉ', { llm: { template_id: 'DELIVERY_DELAY' } });
  assert.doesNotMatch(texts(turn), /xin lỗi mình vì đơn giao chậm/);
  assert.notEqual(turn.result.templateId, 'DELIVERY_DELAY');
  const sim2 = new Sim({ psid: 'r16m-12b' });
  const inbox2 = sim2.inbox({ customerOrders: [{ id: 'o', createdAt: Date.now() - 5 * DAY, phone: PHONE, address: 'x', products: [], status: 'Mới' }] });
  const turn2 = await sim2.send(inbox2, 'sao chưa nhận được hàng em', { llm: { template_id: 'DELIVERY_DELAY' } });
  assert.equal(turn2.result.templateId, 'DELIVERY_DELAY');
});

// ---- 13. (inbox1 B3, ca …9061486243)
test('13. "Ib mình" (bảng Túi Xanh) rồi "Bên em có mấy loại" (bảng 3 vị) → trả lời, không STAFF_WAIT', async () => {
  const sim = new Sim({ psid: 'r16m-13' });
  const inbox = sim.inbox();
  await sim.send(inbox, 'Ib mình', { llm: { template_id: 'GENERAL_INFO' } });
  const turn = await sim.send(inbox, 'Bên em có mấy loại', { llm: { template_id: 'GENERAL_INFO' } });
  assert.doesNotMatch(String(turn.result.templateId || ''), STAFF);
  assert.ok(turn.sent.length >= 1);
});

// ---- 14. (inbox1 B5, ca …7899534005)
test('14. "Kiểm tra hàng mới tt nha chị" sau khi chốt → INSPECTION_RETURN_POLICY, không ghi chú "hàng mới"', async () => {
  const sim = new Sim({ psid: 'r16m-14' });
  const order = { id: 'o14', createdAt: Date.now() - 2 * MIN, phone: PHONE, address: 'x', total: 298000, products: [{ name: X, sku: 'GRA-XANH-Z450', quantity: 2 }], status: 'Mới', automatic: true };
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 2 * MIN, customerOrders: [order] });
  const turn = await sim.send(inbox, 'Kiểm tra hàng mới tt nha chị', { llm: { template_id: 'INSPECTION_RETURN_POLICY' } });
  assert.equal(turn.result.templateId, 'INSPECTION_RETURN_POLICY');
  assert.deepEqual(turn.notes, []);
});

// ---- 15. (inbox5 A6, ca …0443120175)
test('15. tin thoại (một mình hay sau IMAGE_RECEIVED) → VOICE_RECEIVED + thẻ, kể cả khi Cài đặt chưa có mẫu', async () => {
  const withoutVoice = Object.fromEntries(Object.entries(seedTemplates).filter(([id]) => id !== 'VOICE_RECEIVED'));
  for (const [name, settings] of [['seed', {}], ['thieu', { messageTemplates: withoutVoice }]]) {
    for (const last of ['', 'IMAGE_RECEIVED']) {
      const sim = new Sim({ psid: `r16m-15-${name}-${last}`, settings });
      const inbox = sim.inbox(last ? { botLastTemplateId: last, botLastReplyAt: Date.now() - MIN } : {});
      const turn = await sim.send(inbox, '', { type: 'audio', llm: { template_id: 'GENERAL_INFO' } });
      assert.equal(turn.result.templateId, 'VOICE_RECEIVED', `${name}/${last}`);
      assert.match(texts(turn), /tin nhắn thoại/);
      assert.ok(inbox.labels.includes('handoff'));
    }
  }
});

// ---- 16. (inbox1 B6, ca …5994978260)
test('16. bốn lời dặn giao hàng liền nhau: ghi chú cả bốn, câu xác nhận đầy đủ chỉ một lần', async () => {
  const sim = new Sim({ psid: 'r16m-16' });
  const order = { id: 'o16', createdAt: Date.now() - 2 * MIN, phone: PHONE, address: 'x', total: 189000, products: [{ name: X, sku: 'GRA-XANH-Z450', quantity: 1 }], status: 'Mới', automatic: true };
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 2 * MIN, customerOrders: [order] });
  const sent = [];
  let notes = 0;
  for (const text of ['Giao giờ hành chính', 'Khoảng từ 11h 30 đến 14h không giao hàng nhé!', 'Nếu giao giờ đấy mình không nhận nhé!', 'Đã cẩn thận dặn shop rồi đó']) {
    const turn = await sim.send(inbox, text, { llm: { template_id: 'ORDER_NOTE' } });
    sent.push(...turn.sent.map(item => item.text));
    notes += turn.notes.length;
  }
  assert.equal(notes, 4);
  assert.equal(sent.filter(text => /em đã ghi chú yêu cầu/.test(text)).length, 1, sent.join(' ‖ '));
});

// ---- 17. ngữ cảnh luật.
test('17. ruleIntent nhận recentCustomerTexts ({ text, at }, ≤ 15 phút, trừ tin đang xét) và nguyenBanAsk', async () => {
  const sim = new Sim({ psid: 'r16m-17' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - MIN, pendingOrder: { items: [], key: '', at: Date.now() - MIN, nguyenBanAsk: 2 } });
  sim.history(inbox, 'incoming', 'cũ quá', 20 * MIN);
  sim.history(inbox, 'incoming', 'Túi xanh', 2 * MIN);
  let seen = null;
  await sim.send(inbox, 'Ok lấy cho chị 2 túi nha', { llm: null, extra: { ruleIntent: (text, ctx) => { seen = ctx; return null; } } });
  assert.deepEqual(seen.recentCustomerTexts.map(item => item.text), ['Túi xanh']);
  assert.ok(seen.recentCustomerTexts[0].at > 0);
  assert.equal(seen.nguyenBanAsk, 2);
});

// ---- Bổ sung điều phối.
test('A3. bình luận "chưa thấy tin nhắn em" khi tin riêng đã gửi < 24 giờ → gửi LẠI tin riêng', async () => {
  const sim = new Sim({ psid: 'r16m-a3' });
  const inbox = sim.inbox();
  sim.history(inbox, 'outgoing', 'Dạ, em gửi anh/chị Bảng giá Granola Túi Xanh 450g để mình dễ tham khảo ạ: 1 Túi 174.000đ', 60 * MIN, { sender: 'bot', privateReply: true });
  const turn = await sim.send(sim.comment(), 'chưa thấy tin nhắn em', { llm: { template_id: 'GENERAL_INFO' } });
  const privateSent = turn.sent.filter(item => item.privateReply);
  assert.equal(privateSent.length, 1, JSON.stringify(turn.sent));
  assert.match(privateSent[0].text, /Bảng giá Granola Túi Xanh/);
});

test('A4. bình luận trùng câu khách vừa gửi ở hộp thư (hộp thư đã trả lời) → không nhắn riêng lần hai', async () => {
  const sim = new Sim({ psid: 'r16m-a4' });
  const inbox = sim.inbox();
  sim.history(inbox, 'incoming', 'Cho chị 1 túi mini và 1 combo tiện lợi', 2 * MIN);
  sim.history(inbox, 'outgoing', 'Dạ đơn của chị gồm 2 Combo 10 gói…', 1.5 * MIN, { sender: 'bot' });
  const turn = await sim.send(sim.comment(), 'Cho chị 1 túi mini và 1 combo tiện lợi', { llm: { template_id: 'ASK_FLAVOR' } });
  assert.deepEqual(turn.sent.filter(item => item.privateReply), []);
});

test('A5. "Nhai ròn thật" là lời khen; "Thời giờ ăn gáo dừa còn bác thì k ăn" không nhắn riêng bảng quà', async () => {
  const sim = new Sim({ psid: 'r16m-a5' });
  const praise = await sim.send(sim.comment({}, 'p1'), 'Nhai ròn thật', { llm: { template_id: 'THANK_YOU' } });
  assert.deepEqual(praise.sent.filter(item => item.privateReply), []);
  const joke = await sim.send(sim.comment({}, 'p2'), 'Thời giờ ăn gáo dừa còn bác thì k ăn', { llm: { template_id: 'GIFT_POLICY' } });
  assert.deepEqual(joke.sent.filter(item => item.privateReply), []);
});

test('B1. "Màu xanh min ạ" ngay sau bảng giá Tropical → chọn Tropical (bước đơn 1 túi); "Hix" là tin cảm thán', async () => {
  const sim = new Sim({ psid: 'r16m-b1' });
  const table = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'Granola Tropical vị Cacao 300g' }, templates, {});
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - MIN });
  for (const text of table.messages) sim.history(inbox, 'outgoing', text, MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Màu xanh min ạ', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Tropical vị Cacao 300g' } });
  assert.equal(turn.result.templateId, 'ORDER_ADDRESS', JSON.stringify(turn.result));
  assert.equal(inbox.pendingOrder.items[0].code, 'GRA-MINT-Z300');
  for (const text of ['Hix', 'huhu', 'à vâng']) assert.equal(isExclamationOnly(text), true, text);
  for (const text of ['Túi vàng', 'hix sao chưa giao', 'à vâng, cho chị 2 túi']) assert.equal(isExclamationOnly(text), false, text);
});

test('B6. bám đuổi: không nhắc giỏ khi đang chờ bạn phụ trách; nhận lời từ chối gõ không dấu', () => {
  for (const text of ['da nhan hang roi nen kg mua nua', 'k lay nua', 'chi da mua roi', 'không lấy nữa']) assert.equal(customerDeclined(text), true, text);
  for (const text of ['mua thêm 2 túi nữa', 'Huy', 'k lay nua a?']) assert.equal(customerDeclined(text), false, text);
  const inbox = { id: 'page:x', botLastTemplateId: 'STAFF_WAIT_OPEN', botLastReplyAt: Date.now() - 4 * 60 * MIN, labels: [] };
  const store = { messages: { 'page:x': [{ direction: 'incoming', type: 'text', text: 'Hạn sứ dung đến khi nào vay e', createdAt: Date.now() - 4 * 60 * MIN - 1000 }, { direction: 'outgoing', type: 'text', text: 'Dạ em chuyển bạn phụ trách…', createdAt: Date.now() - 4 * 60 * MIN }] } };
  assert.equal(followUpSkipReason({ inbox }, store, { basketHeld: true }), 'waitingStaff');
});
