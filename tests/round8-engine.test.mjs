import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { clearExternalOrderCache, commentBasket, intentMatchMark, isNudgeMessage, processChatbotChanges, shadowRuleLine, splitMessageText, textSimilarity, withFallbackTemplates } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';

// Vòng 8: các tình huống từ 214 hội thoại 26–28/09 (xem báo cáo cùng ngày).
const seed = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const templates = withFallbackTemplates(seed);
const settings = extra => async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 1, messageTemplates: seed, ...extra });
const now = () => Date.now();

async function run(conversation, text, { reply, recent = [], extraDeps = {}, extraSettings = {}, type = 'text', message = {} } = {}) {
  const sent = [];
  const saved = [];
  const asked = [];
  const created = [];
  const results = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, ...conversation },
    message: { id: 'm-new', mid: 'm-new', direction: 'incoming', type, text, createdAt: now(), ...message }
  }], {
    readSettings: settings(extraSettings),
    listMessages: async () => recent,
    saveBotState: async (_id, state) => { saved.push({ id: _id, ...state }); },
    sendMessage: async (_c, payload) => { sent.push(payload.text || `[ảnh ${payload.imageUrls?.length || 1}]`); return { message: { mid: 'x' } }; },
    createOrder: async (_c, order) => { created.push(order); return { order: { id: 'new', ...order }, created: true }; },
    requestReply: async payload => { asked.push(payload); return typeof reply === 'function' ? reply(payload, asked.length) : reply; },
    ...extraDeps
  });
  return { sent, saved, asked, created, results };
}
const outgoing = (text, agoMs, extra = {}) => ({ id: `o-${agoMs}`, direction: 'outgoing', type: 'text', text, createdAt: now() - agoMs, ...extra });
const incoming = (text, agoMs, extra = {}) => ({ id: `i-${agoMs}`, direction: 'incoming', type: 'text', text, createdAt: now() - agoMs, ...extra });
const generalInfo = () => renderChatbotReply({ template_id: 'GENERAL_INFO' }, templates, {});
const basket2Xanh = () => ({ items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 2 }], key: 'GRA-XANH-Z450=2', at: now() - 60000, phone: '', address: '', addressAsks: 0 });

test('1. Page vừa tự gửi bảng 3 giá dưới quảng cáo: "xin giá" chỉ nhận bảng giá Túi Xanh, không bảng chung lần hai; ghép chung + chi tiết thì bỏ câu "quan tâm loại nào"', async () => {
  const adAuto = 'Dạ chào chị, bảng giá hiện nay gồm:\n💚 Túi Xanh 450g: 174.000đ\n💛 Túi Vàng 350g: 174.000đ\n🤎 Túi Nâu 350g: 164.000đ';
  const after = await run({ botLastTemplateId: 'WELCOME', botLastReplyAt: now() - 5 * 60000 }, 'xin giá', { recent: [outgoing(adAuto, 5 * 60000)], reply: generalInfo() });
  assert.equal(after.results[0].templateId, 'PRICE_QUOTE');
  assert.doesNotMatch(after.sent.join('\n'), /hiện tại nhà em đang có/);
  assert.equal(after.sent.filter(text => /Bảng giá Granola/.test(text)).length, 1);
  const fresh = await run({}, 'cho mình hỏi giá với ạ', { reply: generalInfo() });
  assert.equal(fresh.results[0].templateId, 'GENERAL_INFO');
  assert.match(fresh.sent.join('\n'), /hiện tại nhà em đang có/);
  assert.match(fresh.sent.join('\n'), /Bảng giá Granola Túi Xanh 450g/);
  assert.doesNotMatch(fresh.sent.join('\n'), /quan tâm loại nào/, 'bảng chi tiết đi ngay sau thì không hỏi "quan tâm loại nào"');
});

test('2. "đã gửi ở trên" chỉ khi khách lặp câu (≥ 80%) hay giục; mô hình tự chọn nudge cho câu hỏi mới → hỏi lại với hint, vẫn nudge → chuyển người + thẻ', async () => {
  assert.ok(isNudgeMessage('sao chưa trả lời'));
  assert.ok(isNudgeMessage('???'));
  assert.ok(isNudgeMessage('Shop ơi'));
  assert.ok(isNudgeMessage('có ai không ạ'));
  assert.ok(!isNudgeMessage('túi xanh có yến mạch không?'));
  assert.ok(textSimilarity('Shop ơi giá sao', 'shop oi gia sao') >= 0.8);
  assert.ok(textSimilarity('giá sao', 'túi xanh có yến mạch không') < 0.8);
  // Vòng 9: mô hình không còn được chọn REPLY_ALREADY_SENT* (prompt bỏ), nên không gọi lại lần hai
  // — vẫn chọn thì chuyển người + thẻ ngay (xem tests/round9-engine.test.mjs).
  const stubborn = await run({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: now() - 60000 }, 'túi xanh có yến mạch không?', { reply: renderChatbotReply({ template_id: 'REPLY_ALREADY_SENT_INFO' }, templates, {}) });
  assert.equal(stubborn.results[0].templateId, 'CSKH_HANDOFF');
  assert.ok(stubborn.saved.at(-1).addLabelEvents.includes('handoff'));
});

test('3a/3d. "Có" sau PACKAGING_INFO → bảng giá Combo 10 gói (màu ngữ cảnh, mặc định Xanh); ảnh hay "ck rồi" sau BANK_TRANSFER → PAYMENT_RECEIVED_CHECK + thẻ', async () => {
  const combo = await run({ botLastTemplateId: 'PACKAGING_INFO', botLastReplyAt: now() - 60000 }, 'Có ạ', { reply: { templateId: 'WELCOME', messages: ['không được hỏi mô hình'], handoff: false } });
  assert.equal(combo.asked.length, 0);
  assert.match(combo.sent.join('\n'), /Bảng giá Combo 10 gói Xanh/);
  const brown = await run({ botLastTemplateId: 'PACKAGING_INFO', botLastReplyAt: now() - 60000 }, 'ok gửi đi', { recent: [incoming('túi nâu có gói nhỏ không', 120000), outgoing(templates.PACKAGING_INFO, 60000)], reply: { templateId: 'WELCOME', messages: ['x'], handoff: false } });
  // Chủ shop 05/10: Combo 10 gói Nâu đã tắt (combo 10 gói chỉ còn Xanh) → bảng giá Combo 10 gói Xanh (test cũ khẳng định Nâu).
  assert.match(brown.sent.join('\n'), /Combo 10 gói Xanh/);
  assert.doesNotMatch(brown.sent.join('\n'), /Combo 10 gói Nâu/);
  const paidText = await run({ botLastTemplateId: 'BANK_TRANSFER', botLastReplyAt: now() - 10 * 60000 }, 'Mình ck rồi nhé', { reply: { templateId: 'WELCOME', messages: ['x'], handoff: false } });
  assert.equal(paidText.asked.length, 0);
  assert.equal(paidText.results[0].templateId, 'PAYMENT_RECEIVED_CHECK');
  assert.match(paidText.sent[0], /chuyển khoản/);
  assert.ok(paidText.saved.at(-1).addLabelEvents.includes('handoff'));
  const paidImage = await run({ botLastTemplateId: 'BANK_TRANSFER', botLastReplyAt: now() - 10 * 60000 }, '', { type: 'image', reply: { templateId: 'WELCOME', messages: ['x'], handoff: false } });
  assert.equal(paidImage.results[0].templateId, 'PAYMENT_RECEIVED_CHECK');
});

test('4. Đang giữ giỏ mà khách HỎI: trả lời câu hỏi + nhắc giỏ, không nhắc giỏ trơn; "cho xem hình bát gáo dừa" không có ảnh quà → chính sách quà + nhắc giỏ', async () => {
  const pending = basket2Xanh();
  const askText = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, { pendingOrder: pending });
  const recent = [outgoing(askText.messages[0], 60000)];
  const info = renderChatbotReply({ template_id: 'INGREDIENTS_ALLERGY' }, templates, {});
  const question = await run({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: now() - 60000, pendingOrder: pending }, 'túi này có yến mạch không?', {
    recent, reply: (payload, call) => (call === 1 ? askText : info)
  });
  assert.equal(question.asked.length, 2, 'mô hình lặp bước xin SĐT → hỏi lại với hint');
  assert.match(question.asked[1].conversation.replyHint, /Khách đang HỎI/);
  assert.equal(question.results[0].templateId, 'INGREDIENTS_ALLERGY');
  assert.match(question.sent[0], /yến mạch|dị ứng|thành phần/i);
  assert.match(question.sent.at(-1), /vẫn đang giữ đơn 2 Granola Túi Xanh 450g/);
  assert.equal(question.saved.at(-1).pendingOrder, undefined, 'giỏ giữ nguyên');
  const gift = await run({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: now() - 60000, pendingOrder: pending }, 'cho xem hình bát gáo dừa', { recent, reply: askText });
  assert.equal(gift.results[0].templateId, 'GIFT_POLICY');
  assert.match(gift.sent[0], /quà tặng/);
  assert.match(gift.sent.at(-1), /vẫn đang giữ đơn/);
});

test('5. Có đơn 2 ngày trước, "E mua 2 túi gia bao nhiu a" → bảng giá, không hỏi "đặt thêm?"; sau ASK_FLAVOR chỉ nói "xanh" mà trước đó hỏi giá → bảng giá Túi Xanh', async () => {
  const existing = { id: 'o-old', createdAt: now() - 2 * 24 * 60 * 60 * 1000, total: 298000, status: 'đang giao', products: [{ name: 'Granola Túi Xanh 450g', quantity: 2 }] };
  const confirmation = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0909123456', Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh' }, templates, {});
  const price = await run({ customerOrders: [existing] }, 'E mua 2 túi gia bao nhiu a', { reply: confirmation });
  assert.deepEqual(price.created, []);
  assert.equal(price.results[0].templateId, 'PRICE_QUOTE');
  assert.doesNotMatch(price.sent.join('\n'), /đặt THÊM/);
  assert.match(price.sent.join('\n'), /Bảng giá Granola Túi Xanh 450g/);
  const colour = await run({ botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: now() - 60000 }, 'xanh', {
    recent: [incoming('2 túi giá bao nhiêu', 120000), outgoing(templates.ASK_FLAVOR, 60000)],
    reply: { templateId: 'ORDER_ADDRESS', messages: ['không được hỏi mô hình'], handoff: false }
  });
  assert.equal(colour.asked.length, 0);
  assert.equal(colour.results[0].templateId, 'PRICE_QUOTE');
  assert.match(colour.sent.join('\n'), /Túi Xanh 450g/);
  // Không hỏi giá trước đó ("M lấy 1 túi" → "xanh"): để luật/mô hình lên đơn như cũ.
  const order = await run({ botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: now() - 60000 }, 'xanh', { recent: [incoming('M lấy 1 túi', 120000)], reply: { templateId: 'ORDER_ADDRESS', messages: ['xin SĐT'], handoff: false } });
  assert.equal(order.asked.length, 1);
});

test('6. Không mời 2 túi khi khách nói "1 túi thôi", khi engine báo noUpsell (khiếu nại/thẻ/sỉ), hay đã mời một lần trong hội thoại', async () => {
  const declined = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '1' }, templates, { messageText: 'cho mình 1 túi thôi' });
  assert.equal(declined.templateId, 'ORDER_ADDRESS');
  assert.equal(declined.messages.length, 1);
  assert.ok(!declined.pendingOrder.upsold);
  const trial = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '1' }, templates, { messageText: 'lấy 1 túi dùng thử đã' });
  assert.equal(trial.messages.length, 1);
  const blocked = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '1' }, templates, { messageText: 'cho mình 1 túi xanh', noUpsell: true });
  assert.equal(blocked.messages.length, 1);
  const plain = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '1' }, templates, { messageText: 'cho mình 1 túi xanh' });
  assert.equal(plain.messages.length, 2, 'không có lý do chặn thì vẫn mời');
  // Engine: lần đầu mời → ghi botUpsoldAt; hội thoại đã có botUpsoldAt / thẻ khiếu nại → không mời.
  const first = await run({}, 'cho mình 1 túi xanh', { reply: ({ context }) => renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1' }, templates, context) });
  assert.ok(first.saved.at(-1).botUpsoldAt > 0);
  assert.match(first.sent.join('\n'), /lấy 2 túi thì giá chỉ còn/);
  const again = await run({ botUpsoldAt: now() - 3600000 }, 'cho mình 1 túi vàng', { reply: ({ context }) => renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1' }, templates, context) });
  assert.doesNotMatch(again.sent.join('\n'), /lấy 2 túi thì giá chỉ còn/);
  const complaint = await run({ labels: ['complaint'] }, 'cho mình 1 túi vàng', { reply: ({ context }) => renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1' }, templates, context) });
  assert.doesNotMatch(complaint.sent.join('\n'), /lấy 2 túi thì giá chỉ còn/);
});

test('7. Không dựng giỏ từ tin không phải đặt hàng: chỉ ảnh → đã nhận hình; "xem hình" → không giỏ; "xanh mint" → LIVE_ONLY_PRODUCT + thẻ; ảnh kèm chữ xử lý theo chữ', async () => {
  const orderReply = ({ context }) => renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '1' }, templates, context);
  const imageOnly = await run({}, '', { type: 'image', message: { dataUrl: 'https://content.pancake.vn/x.jpg' }, extraSettings: { provider: 'vertex' }, reply: orderReply });
  assert.equal(imageOnly.results[0].templateId, 'IMAGE_RECEIVED');
  assert.ok(!imageOnly.saved.at(-1).pendingOrder?.items?.length, 'không giỏ từ ảnh');
  const photos = await run({}, 'xem hình', { reply: orderReply });
  assert.notEqual(photos.results[0].templateId, 'ORDER_ADDRESS');
  assert.ok(!photos.saved.at(-1).pendingOrder?.items?.length);
  const mint = await run({}, 'cho mình 1 túi xanh mint', { reply: orderReply });
  // Vòng 12: "xanh mint" là Granola Tropical (danh mục) — mô hình lên giỏ Túi Nâu sai món → báo giá Tropical + thẻ, không giỏ.
  assert.equal(mint.results[0].templateId, 'PRICE_QUOTE');
  assert.match(mint.sent.join('\n'), /Tropical/);
  assert.ok(mint.saved.at(-1).addLabelEvents.includes('handoff'));
  assert.ok(!mint.saved.at(-1).pendingOrder?.items?.length);
  assert.equal(mint.saved.at(-1).botEnabled, undefined, 'bot vẫn bật');
  const captioned = await run({}, 'túi này giá bao nhiêu', { type: 'image', message: { dataUrl: 'https://content.pancake.vn/x.jpg' }, reply: renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Xanh 450g' }, templates, {}) });
  assert.equal(captioned.asked[0].message.type, 'text');
  assert.equal(captioned.results[0].templateId, 'PRICE_QUOTE');
});

test('8. Nhân viên đang xử lý: nhân viên nhắn sau bot trong 2 giờ, hay thẻ khiếu nại + nhân viên nhắn trong 24 giờ → bot im (cả bình luận đọc hộp thư); chỉ thẻ cũ thì vẫn trả lời', async () => {
  const staffReply = outgoing('Dạ chị cho em hỏi mình đặt đơn ngày nào ạ?', 5 * 60000, { staff: true, staffName: 'Thúy Hằng' });
  const quiet = await run({ botLastTemplateId: 'ORDER_STATUS', botLastReplyAt: now() - 10 * 60000 }, 'Đúng rồi', { recent: [staffReply], reply: { templateId: 'THANK_YOU', messages: ['x'], handoff: false } });
  assert.equal(quiet.results[0].skipped, 'nhân viên đang xử lý');
  assert.deepEqual(quiet.sent, []);
  const labelled = await run({ labels: ['complaint'] }, 'giá bao nhiêu', { recent: [outgoing('Em đã báo kho kiểm tra ạ', 3 * 60 * 60000, { staff: true })], reply: generalInfo() });
  assert.equal(labelled.results[0].skipped, 'nhân viên đang xử lý');
  const staleLabel = await run({ labels: ['complaint'] }, 'giá bao nhiêu', { reply: generalInfo() });
  assert.equal(staleLabel.results[0].templateId, 'GENERAL_INFO', 'thẻ cũ không có nhân viên nhắn: bot vẫn trả lời');
  // Bình luận: hộp thư cùng khách có nhân viên vừa nhắn → không nhắn riêng.
  const sent = [];
  const results = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:comment:c1:p1', pageId: 'page', psid: 'user', source: 'comment', botEnabled: true, post: { message: 'Granola túi xanh' } },
    message: { id: 'c1', mid: 'c1', direction: 'incoming', type: 'text', text: 'giá sao', createdAt: now() }
  }], {
    readSettings: settings(),
    listMessages: async id => (id === 'page:user' ? [staffReply] : []),
    getConversation: async id => (id === 'page:user' ? { id: 'page:user', pageId: 'page', psid: 'user', botEnabled: true } : null),
    saveBotState: async () => {},
    sendMessage: async (_c, payload) => { sent.push(payload.text); return { message: { mid: 'x' } }; },
    requestReply: async () => ({ templateId: 'PRICE_QUOTE', messages: ['Bảng giá'], handoff: false })
  });
  assert.equal(results[0].skipped, 'nhân viên đang xử lý');
  // Vòng 12 (B4 #4): bình luận hỏi giá/đặt hàng lúc nhân viên đang chat hộp thư → không nhắn riêng, chỉ một lời công khai
  // ngắn "bạn phụ trách nhắn mình ngay" (không để bình luận trơ trọi 35 phút).
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /Bảng giá/);
  assert.match(sent[0], /bạn phụ trách/);
});

test('9. Sau ORDER_STATUS_CHECKING (< 24h) khách nhắn tiếp → WAITING_STAFF đúng một lần, tin sau im; nhân viên đã nhắn (> 2h) thì luồng thường', async () => {
  const wait1 = await run({ botLastTemplateId: 'ORDER_STATUS_CHECKING', botLastReplyAt: now() - 10 * 60000 }, 'sao rồi shop', { reply: { templateId: 'ORDER_STATUS', messages: ['chưa thấy đơn nào'], handoff: false } });
  assert.equal(wait1.asked.length, 0);
  assert.equal(wait1.results[0].templateId, 'WAITING_STAFF');
  assert.match(wait1.sent[0], /bạn phụ trách/);
  assert.equal(wait1.saved.at(-1).botLastTemplateId, 'WAITING_STAFF');
  const wait2 = await run({ botLastTemplateId: 'WAITING_STAFF', botLastReplyAt: now() - 5 * 60000 }, 'Buôn bán kiểu gì vậy', { reply: { templateId: 'ORDER_STATUS', messages: ['chưa thấy đơn nào'], handoff: false } });
  assert.equal(wait2.results[0].skipped, 'đang chờ nhân viên');
  assert.deepEqual(wait2.sent, []);
  const handled = await run({ botLastTemplateId: 'ORDER_STATUS_CHECKING', botLastReplyAt: now() - 5 * 60 * 60000 }, 'cho mình hỏi giá', { recent: [outgoing('Đơn chị đã giao rồi ạ', 3 * 60 * 60000, { staff: true })], reply: generalInfo() });
  assert.equal(handled.results[0].templateId, 'GENERAL_INFO');
});

test('10. Luật trả clearBasket → bỏ giỏ; luật trả values → điền vào mẫu (mẫu mới dùng lời dự phòng khi Cài đặt chưa có)', async () => {
  const pending = basket2Xanh();
  const postponed = await run({ pendingOrder: pending, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: now() - 60000 }, 'để hôm khác mình đặt nha', {
    extraSettings: { ruleIntent: 'on' },
    extraDeps: { ruleIntent: () => ({ rule: 'POSTPONE', value: { template_id: 'ORDER_POSTPONED' }, clearBasket: true }) },
    reply: { templateId: 'WELCOME', messages: ['không được hỏi mô hình'], handoff: false }
  });
  assert.equal(postponed.asked.length, 0);
  assert.equal(postponed.results[0].templateId, 'ORDER_POSTPONED');
  assert.equal(postponed.saved.at(-1).pendingOrder, null);
  const variant = await run({}, 'có vị dâu không', {
    extraSettings: { ruleIntent: 'on' },
    extraDeps: { ruleIntent: () => ({ rule: 'NO_VARIANT', value: { template_id: 'NO_VARIANT', values: { ingredient: 'dâu' } } }) },
    reply: { templateId: 'WELCOME', messages: ['x'], handoff: false }
  });
  assert.equal(variant.results[0].templateId, 'NO_VARIANT');
  assert.match(variant.sent[0], /dâu/, '{ingredient} được điền từ values');
  assert.doesNotMatch(variant.sent[0], /\{ingredient\}/);
});

test('11. Bình luận: chê → xin lỗi công khai + thẻ; khen → cảm ơn công khai, không ib bảng giá; CSKH_HANDOFF không đòi người → bảng giá; live hỏi quà → lời chào live; giỏ "hộp"/"socola"/vị lạ', async () => {
  const comment = async (text, reply, { post = { message: 'Granola túi xanh' }, labels = [] } = {}) => {
    const sent = [];
    const saved = [];
    const results = await processChatbotChanges([{
      type: 'message',
      conversation: { id: 'page:comment:c1:p1', pageId: 'page', psid: 'user', source: 'comment', botEnabled: true, post, labels },
      message: { id: `c-${text}`, mid: `c-${text}`, direction: 'incoming', type: 'text', text, createdAt: now() }
    }], {
      readSettings: settings(),
      listMessages: async () => [],
      getConversation: async id => (id === 'page:user' ? { id: 'page:user', pageId: 'page', psid: 'user', botEnabled: true } : null),
      saveBotState: async (_id, state) => { saved.push(state); },
      sendMessage: async (_c, payload) => { sent.push(`${payload.privateReply ? 'riêng' : 'công khai'}:${payload.text}`); return { message: { mid: 'x' } }; },
      requestReply: async () => reply
    });
    return { sent, saved, results };
  };
  const bad = await comment('ăn k ngon gì hết', { templateId: 'PRICE_QUOTE', messages: ['Bảng giá'], handoff: false });
  assert.match(bad.sent.find(text => text.startsWith('công khai')), /xin lỗi vì trải nghiệm chưa tốt/);
  assert.match(bad.sent.find(text => text.startsWith('riêng')), /chuyển bạn phụ trách/);
  assert.ok(bad.saved.some(state => (state.addLabelEvents || []).includes('handoff')));
  const smelly = await comment('túi này hôi dầu quá', { templateId: 'OIL_SMELL_WARRANTY', messages: ['x'], handoff: false });
  assert.match(smelly.sent.find(text => text.startsWith('công khai')), /xin lỗi/);
  const praise = await comment('ăn ngon lắm', { templateId: 'THANK_YOU', messages: ['cảm ơn'], handoff: false });
  assert.equal(praise.sent.filter(text => text.startsWith('riêng')).length, 0, 'không nhắn riêng bảng giá cho người khen');
  assert.match(praise.sent.find(text => text.startsWith('công khai')), /cảm ơn .* nhiều/);
  const handoff = await comment('giá sao shop', { templateId: 'CSKH_HANDOFF', messages: ['x'], handoff: true });
  assert.match(handoff.sent.find(text => text.startsWith('riêng')), /Bảng giá Granola Túi Xanh 450g/);
  assert.doesNotMatch(handoff.sent.join('\n'), /chuyển bạn phụ trách/);
  const live = await comment('mua 2 túi được quà gì', renderChatbotReply({ template_id: 'GIFT_POLICY' }, templates, {}), { post: { message: 'Săn deal hời cùng Giọt Nắng' } });
  // Vòng 12: khách live hỏi quà → câu quà live (2 túi 298k miễn ship tặng Quạt + Bát gáo dừa), không phải bảng quà chung.
  assert.equal(live.results[0].templateId, 'GIFT_POLICY_LIVE');
  // R17: quà live 08/10 — 2 túi lớn tặng Quạt; từ 3 túi Quạt + Bộ bát gáo dừa + Muỗng dừa (bình luận A7: hỏi quà 3 túi).
  assert.match(live.sent.find(text => text.startsWith('riêng')), /2 túi lớn bất kỳ .*tặng Quạt/);
  assert.match(live.sent.find(text => text.startsWith('riêng')), /Từ 3 túi tặng Quạt \+ Bộ bát gáo dừa \+ Muỗng dừa/);
  // Giỏ ghi trong bình luận.
  assert.deepEqual(commentBasket('cho mình 2 túi socola'), [{ product: 'Granola Túi Nâu vị cacao 350g', quantity: 2 }]);
  assert.deepEqual(commentBasket('lấy 2 hộp xanh'), [{ product: 'Combo 10 gói Xanh', quantity: 2 }]);
  // Chủ shop 05/10: Combo 10 gói Mix đã tắt → hộp không ghi màu là Combo 10 gói Xanh (test cũ: Mix); "hộp mix" không tự dựng giỏ.
  assert.deepEqual(commentBasket('cho em 1 hộp 10 gói'), [{ product: 'Combo 10 gói Xanh', quantity: 1 }]);
  assert.deepEqual(commentBasket('lấy 1 hộp mix'), []);
  // Vòng 12: "vị dâu" / "xanh mint" là Granola Tropical (sản phẩm danh mục) → giỏ Tropical; "xanh nhạt" còn mơ hồ → không giỏ.
  assert.deepEqual(commentBasket('lấy 2 túi vị dâu'), [{ product: 'Granola Tropical vị Cacao 300g', quantity: 2 }]);
  assert.deepEqual(commentBasket('cho 1 túi xanh mint'), [{ product: 'Granola Tropical vị Cacao 300g', quantity: 1 }]);
  assert.deepEqual(commentBasket('cho 1 túi xanh nhạt'), []);
  const strange = await comment('cho mình 2 túi xanh nhạt nhé', { templateId: 'PRICE_QUOTE', messages: ['Bảng giá'], handoff: false });
  assert.ok(!strange.saved.some(state => state.pendingOrder?.items?.length));
});

test('12. Tin riêng ghép quá 1.900 ký tự: tách gửi (phần đầu qua tin riêng, phần sau vào hộp thư), không cắt cụt', async () => {
  const paragraph = 'Dạ em gửi bảng giá chi tiết cho mình ạ, combo 2 túi miễn phí vận chuyển. '.repeat(25).trim();
  const chunks = splitMessageText([paragraph, paragraph].join('\n\n'), 1900);
  assert.ok(chunks.length >= 2 && chunks.every(chunk => chunk.length <= 1900));
  const sent = [];
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:comment:c1:p1', pageId: 'page', psid: 'user', source: 'comment', botEnabled: true, post: { message: 'Granola túi xanh' } },
    // Câu không cụt ("giá sao" là câu cụt → bảng giá của bài, không hỏi mô hình).
    message: { id: 'c-long', mid: 'c-long', direction: 'incoming', type: 'text', text: 'cho mình hỏi giá combo với ạ', createdAt: now() }
  }], {
    readSettings: settings(),
    listMessages: async () => [],
    getConversation: async id => (id === 'page:user' ? { id: 'page:user', pageId: 'page', psid: 'user', botEnabled: true } : null),
    saveBotState: async () => {},
    sendMessage: async (conversation, payload) => { sent.push({ to: conversation.id, privateReply: Boolean(payload.privateReply), text: payload.text || '' }); return { message: { mid: 'x' } }; },
    requestReply: async () => ({ templateId: 'PRICE_QUOTE', messages: [paragraph, paragraph], handoff: false })
  });
  const privateOnes = sent.filter(item => item.privateReply);
  assert.equal(privateOnes.length, 1);
  assert.ok(privateOnes[0].text.length <= 1900);
  const inboxOnes = sent.filter(item => !item.privateReply && item.to === 'page:user');
  assert.ok(inboxOnes.length >= 1, 'phần còn lại vào hộp thư');
  const joined = [privateOnes[0].text, ...inboxOnes.map(item => item.text)].join(' ').replace(/\s+/g, ' ');
  assert.ok(joined.includes('miễn phí vận chuyển.'), 'không mất chữ cuối');
});

test('13. Tin chỉ SĐT ("sđt 0909… nha") rồi địa chỉ ở tin sau: tin SĐT nhường, tin sau trả lời gộp', async () => {
  const pending = basket2Xanh();
  let calls = 0;
  const phoneMessage = { id: 'm-phone', mid: 'm-phone', direction: 'incoming', type: 'text', text: 'sđt 0909123456 nha', createdAt: now() };
  const addressMessage = { id: 'm-addr', mid: 'm-addr', direction: 'incoming', type: 'text', text: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', createdAt: now() + 10 };
  const sent = [];
  const first = await processChatbotChanges([{ type: 'message', conversation: { id: 'page:user', pageId: 'page', psid: 'user', botEnabled: true, botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: now() - 60000, pendingOrder: pending }, message: phoneMessage }], {
    readSettings: settings(),
    listMessages: async () => { calls += 1; return calls === 1 ? [phoneMessage] : [phoneMessage, addressMessage]; },
    saveBotState: async () => {},
    sendMessage: async (_c, payload) => { sent.push(payload.text); return { message: { mid: 'x' } }; },
    requestReply: async () => ({ templateId: 'ORDER_ADDRESS', messages: ['xin địa chỉ'], handoff: false })
  });
  assert.equal(first[0].skipped, 'gộp với tin sau');
  assert.deepEqual(sent, []);
  const second = await run({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: now() - 60000, pendingOrder: pending }, addressMessage.text, {
    recent: [phoneMessage, addressMessage], message: { id: 'm-addr', mid: 'm-addr' },
    reply: ({ context, message }) => renderChatbotReply({ template_id: 'ORDER_ADDRESS', Phone_Number: '0909123456', Customer_Address: addressMessage.text }, templates, { ...context, messageText: message.text })
  });
  assert.equal(second.results[0].bundled, 2);
  assert.equal(second.results[0].templateId, 'ORDER_CONFIRMATION');
});

test('14. ctx.hasPreviousDelivery vào luật; "gởi dc củ" / "gửi dc trước rồi" / "như đơn trước" dùng SĐT+địa chỉ đơn cũ để chốt', async () => {
  const seen = [];
  const recentOrder = { id: 'o1', createdAt: now() - 3 * 24 * 60 * 60 * 1000, phone: '0909123456', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }] };
  await run({ customerOrders: [recentOrder] }, 'cho 2 túi vàng', { extraSettings: { ruleIntent: 'on' }, extraDeps: { ruleIntent: (_text, ctx) => { seen.push(ctx.hasPreviousDelivery); return null; } }, reply: generalInfo() });
  await run({}, 'cho 2 túi vàng', { extraSettings: { ruleIntent: 'on' }, extraDeps: { ruleIntent: (_text, ctx) => { seen.push(ctx.hasPreviousDelivery); return null; } }, reply: generalInfo() });
  assert.deepEqual(seen, [true, false]);
  for (const text of ['gởi dc củ nha', 'gửi dc trước rồi đó', 'như đơn trước nhé', 'đc cũ nha shop']) {
    const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '2' }, templates, { recentOrder, messageText: text, now: now() });
    assert.equal(reply.templateId, 'ORDER_CONFIRMATION', text);
    assert.equal(reply.order.phone, '0909123456');
  }
});

test('15. Xưng hô khóa một lần: giới tính đoán đổi giữa chừng không đổi "chị" thành "anh"; nhân viên đặt tay vẫn thắng', async () => {
  const locked = await run({ gender: 'male', genderSource: 'message', botGender: 'female' }, 'túi xanh có yến mạch không', { reply: ({ context }) => renderChatbotReply({ template_id: 'INGREDIENTS_ALLERGY' }, templates, context) });
  assert.match(locked.sent[0], /chị/);
  assert.doesNotMatch(locked.sent[0], /(?<![\p{L}])anh(?![\p{L}])/u);
  const first = await run({ gender: 'female', genderSource: 'name' }, 'túi xanh có yến mạch không', { reply: ({ context }) => renderChatbotReply({ template_id: 'INGREDIENTS_ALLERGY' }, templates, context) });
  assert.equal(first.saved.at(-1).botGender, 'female');
  const staff = await run({ gender: 'male', genderSource: 'staff', botGender: 'female' }, 'túi xanh có yến mạch không', { reply: ({ context }) => renderChatbotReply({ template_id: 'INGREDIENTS_ALLERGY' }, templates, context) });
  assert.match(staff.sent[0], /(?<![\p{L}])anh(?![\p{L}])/u);
});

test('16/17. Log luật thử soạn qua bộ soạn đơn rồi mới so (PHONE_ONLY → ORDER_CONFIRMATION ✓); dấu so mô hình nhỏ coi REMIND ≡ ORDER_ADDRESS, nudge trung tính', () => {
  const pending = { ...basket2Xanh(), address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh' };
  const context = { pendingOrder: pending, lastTemplateId: 'ORDER_ADDRESS', now: now() };
  const render = value => renderChatbotReply(value, templates, context);
  const shadow = { rule: 'PHONE_ONLY', value: { template_id: 'ORDER_ADDRESS', Phone_Number: '0909123456' } };
  const line = shadowRuleLine(shadow, 'ORDER_CONFIRMATION', render, 'c1');
  assert.match(line, /luật ORDER_CONFIRMATION \/ luật ổn định ORDER_CONFIRMATION ✓/);
  assert.match(shadowRuleLine({ rule: 'X', value: { template_id: 'GIFT_POLICY' } }, 'PRICE_QUOTE', render), /✗/);
  assert.match(shadowRuleLine({ rule: 'TERSE', commentRule: true }, 'PRICE_QUOTE', render), /✓/);
  assert.equal(intentMatchMark('ORDER_ADDRESS', 'ORDER_ADDRESS_REMIND'), '✓');
  assert.equal(intentMatchMark('PRICE_QUOTE', 'REPLY_ALREADY_SENT'), '~');
  assert.equal(intentMatchMark('PRICE_QUOTE', 'GENERAL_INFO'), '✗');
});

test('20. Đơn ngoài hội thoại cùng SĐT (POS / landing, 7 ngày): hỏi xác nhận đặt thêm, không tạo trùng; "đúng" tạo, "không" kể đơn cũ; POS lỗi → vẫn tạo + thẻ; nhớ 10 phút', async () => {
  const address = '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
  const confirmation = () => renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Vàng 350g', No_A: '2', Phone_Number: '0909123456', Customer_Address: address }, templates, {});
  const insertedAt = new Date(now() - 2 * 24 * 60 * 60 * 1000).toISOString().replace(/Z$/, '');
  const posOrder = (extra = {}) => ({ id: 52903, system_id: 9001, status: 1, status_name: 'submitted', is_abandoned_order: false, inserted_at: insertedAt, bill_phone_number: '0909123456', cod: 298000, total_price: 348000, shipping_address: { full_address: address, phone_number: '0909123456' }, items: [{ quantity: 2, variation_info: { display_id: 'GRA-XANH-Z450', name: 'Granola xanh' } }, { quantity: 1, is_bonus_product: true, variation_info: { display_id: 'BGD', name: 'Bộ bát' } }], ...extra });
  const posConfig = { apiKey: 'k', shopId: '714', baseUrl: 'https://pos.test/api/v1' };
  const posFetch = (orders, calls = []) => async url => { calls.push(String(url)); return { ok: true, json: async () => ({ data: orders }) }; };
  const deps = (orders, calls) => ({ fetchImpl: posFetch(orders, calls), posConfig, readLandingStore: async () => ({ orders: [] }) });
  clearExternalOrderCache();
  const calls = [];
  const asked = await run({}, `cho 2 túi vàng, 0909123456, ${address}`, { reply: confirmation(), extraDeps: deps([posOrder()], calls) });
  assert.deepEqual(asked.created, [], 'không tạo đơn trùng với đơn POS');
  assert.equal(asked.results[0].templateId, 'ORDER_EXISTING_CONFIRM');
  // fix-bot C2 (01/10): đơn POS/landing tìm theo SĐT không thuộc hội thoại — hỏi "đặt thêm?" KHÔNG kể món/giờ/tổng tiền
  // của đơn đó (trước đây: "đang có đơn Granola Túi Xanh 450g x2 đặt lúc …"), gắn thẻ cho nhân viên đối chiếu.
  assert.doesNotMatch(asked.sent.join(' '), /Granola Túi Xanh 450g x2|348.000|đặt lúc/);
  assert.match(asked.sent.join(' '), /số điện thoại này đã có một đơn/);
  assert.match(asked.sent.join(' '), /đặt THÊM một đơn mới gồm 2 Granola Túi Vàng 350g/);
  assert.ok(asked.saved.at(-1).addLabelEvents.includes('handoff'));
  assert.match(calls[0], /\/shops\/714\/orders\?.*search=0909123456/);
  const pending = asked.saved.at(-1).pendingOrder;
  assert.equal(pending.awaitingConfirm, true);
  assert.equal(pending.externalOrder.id, 'POS-9001');
  // "Đúng rồi" → tạo đơn như thường (không tra lại).
  const yes = await run({ pendingOrder: pending, botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: now() - 60000 }, 'Đúng rồi', { reply: { templateId: 'GENERAL_INFO', messages: ['x'], handoff: false }, extraDeps: deps([posOrder()]) });
  assert.equal(yes.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.equal(yes.created.length, 1);
  // "Không" → (fix-bot C2) không kể lại đơn ngoài hội thoại: nhân viên tra, gắn thẻ, không tạo.
  // R15-fix4 (thiết kế gộp/tách mới): phủ định khi đang chờ → STAFF_WAIT_* (trước: ORDER_STATUS_CHECKING), giữ giỏ.
  const no = await run({ pendingOrder: pending, botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: now() - 60000 }, 'Không, đơn đó của chị rồi', { reply: { templateId: 'GENERAL_INFO', messages: ['x'], handoff: false }, extraDeps: deps([posOrder()]) });
  assert.match(no.results[0].templateId, /^STAFF_WAIT_(OPEN|CLOSED)$/);
  assert.deepEqual(no.created, []);
  assert.doesNotMatch(no.sent.join(' '), /Granola Túi Xanh 450g x2/);
  assert.doesNotMatch(no.sent.join(' '), /chưa thấy đơn nào/);
  assert.ok(no.saved.at(-1).addLabelEvents.includes('handoff'));
  // Nhớ 10 phút theo SĐT: lượt sau cùng SĐT không gọi POS lần nữa.
  const cachedCalls = [];
  await run({}, `cho 2 túi vàng, 0909123456, ${address}`, { reply: confirmation(), extraDeps: deps([posOrder()], cachedCalls) });
  assert.deepEqual(cachedCalls, []);
  // Đơn POS bị hủy / bỏ dở / do CRM đẩy sang / quá 7 ngày: không tính.
  clearExternalOrderCache();
  const ignored = await run({}, `cho 2 túi vàng, 0909123456, ${address}`, { reply: confirmation(), extraDeps: deps([
    posOrder({ status: 6, status_name: 'canceled' }), posOrder({ id: 1, is_abandoned_order: true }), posOrder({ id: 'CRM-abc12345' }),
    posOrder({ id: 2, inserted_at: new Date(now() - 10 * 24 * 60 * 60 * 1000).toISOString().replace(/Z$/, '') })
  ]) });
  assert.equal(ignored.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.equal(ignored.created.length, 1);
  // Kho landing cục bộ: đơn "Mới" 3 ngày trước cùng SĐT → hỏi; đơn "Chưa hoàn tất" thì không.
  clearExternalOrderCache();
  const landing = order => ({ fetchImpl: posFetch([]), posConfig, readLandingStore: async () => ({ orders: [order] }) });
  const landingOrder = { id: 'ld1', phone: '0909123456', status: 'Mới', createdAt: now() - 3 * 24 * 60 * 60 * 1000, total: 447000, products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 3 }], source: 'Landing page' };
  const fromLanding = await run({}, `cho 2 túi vàng, 0909123456, ${address}`, { reply: confirmation(), extraDeps: landing(landingOrder) });
  assert.equal(fromLanding.results[0].templateId, 'ORDER_EXISTING_CONFIRM');
  assert.doesNotMatch(fromLanding.sent.join(' '), /Granola Túi Xanh 450g x3|447.000/);
  clearExternalOrderCache();
  const incomplete = await run({}, `cho 2 túi vàng, 0909123456, ${address}`, { reply: confirmation(), extraDeps: landing({ ...landingOrder, status: 'Chưa hoàn tất', landing: { incomplete: true } }) });
  assert.equal(incomplete.results[0].templateId, 'ORDER_CONFIRMATION');
  // POS lỗi mạng: vẫn lên đơn, gắn thẻ để nhân viên soát trùng; lỗi không được nhớ.
  clearExternalOrderCache();
  const failing = await run({}, `cho 2 túi vàng, 0909123456, ${address}`, { reply: confirmation(), extraDeps: { fetchImpl: async () => { throw new Error('ECONNRESET'); }, posConfig, readLandingStore: async () => ({ orders: [] }) } });
  assert.equal(failing.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.equal(failing.created.length, 1);
  assert.ok(failing.saved.at(-1).addLabelEvents.includes('handoff'));
  // Đơn ngoài không che luồng cũ: có đơn trong hội thoại thì không tra POS.
  clearExternalOrderCache();
  const inConversationCalls = [];
  const existing = { id: 'o-2409', createdAt: now() - 2 * 24 * 60 * 60 * 1000, total: 298000, status: 'đang giao', products: [{ name: 'Granola Túi Xanh 450g', quantity: 1 }] };
  const inConversation = await run({ customerOrders: [existing] }, `cho 2 túi vàng, 0909123456, ${address}`, { reply: confirmation(), extraDeps: deps([posOrder()], inConversationCalls) });
  assert.equal(inConversation.results[0].templateId, 'ORDER_EXISTING_CONFIRM');
  assert.deepEqual(inConversationCalls, []);
});
