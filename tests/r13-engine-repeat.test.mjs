// Vòng 13 (02/10) — bot im vì "lặp tin vừa gửi" khi khách hỏi ý MỚI (out-inbox1 A3, out-inbox2 A2/B4), ASK_TWO_BAGS sai
// chỗ (inbox1 B3), cờ "nhân viên trả lời sau bot" tính cả tin tự động (QR), đặc trưng addressInText / livestream của nhật ký.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, templates } from './helpers/r13-engine-sim.mjs';
import { addressWordsInText, CASCADE_TEMPLATE_THRESHOLD, decisionContext, isHumanPageMessage } from '../app/chatbot-engine.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

const MIN = 60 * 1000;
const liveGreeting = renderChatbotReply({ template_id: 'LIVESTREAM_COMMENT' }, templates, { livestream: true, customer: { gender: 'female' } }).messages;

/** Hộp thư khách live vừa nhận lời chào live `agoMs` trước (như tin nhắn riêng sau bình luận dưới bài live). */
function liveInbox(agoMs = 5 * MIN, extra = {}) {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ labels: ['livestream'], gender: 'female', botGender: 'female', botLastTemplateId: 'LIVESTREAM_COMMENT', botLastReplyAt: Date.now() - agoMs, ...extra });
  for (const text of liveGreeting) sim.history(inbox, 'outgoing', text, agoMs, { sender: 'bot' });
  return { sim, inbox };
}

test('khách live hỏi voucher / phí ship ngay sau lời chào live: trả đúng mẫu đó, không ép về lời chào live rồi im', async () => {
  const voucher = liveInbox();
  const first = await voucher.sim.send(voucher.inbox, 'Tưởng đặt trên live là giảm ạ', { llm: { template_id: 'LIVESTREAM_VOUCHER' } });
  assert.equal(first.result.templateId, 'LIVESTREAM_VOUCHER', JSON.stringify(first.result));
  assert.ok(first.sent.length > 0);
  assert.equal(first.asked.length, 1, 'không cần gọi lại mô hình');
  const ship = liveInbox();
  const second = await ship.sim.send(ship.inbox, '1 gói có mất sip nha', { llm: { template_id: 'FREESHIP_POLICY' } });
  assert.equal(second.result.templateId, 'FREESHIP_POLICY', JSON.stringify(second.result));
  assert.ok(second.sent.length > 0);
});

test('bảng giá / bảng mix cho khách live: chỉ ép về lời chào live khi chưa gửi trong 30 phút và khách chưa có đơn', async () => {
  // Vừa chào live 5 phút trước: "Lấy tui vàng và nâu thi giá sao" → trả bảng mix (mẫu gốc), không lặp lời chào.
  const recent = liveInbox(5 * MIN);
  const mix = await recent.sim.send(recent.inbox, 'Lấy tui vàng và nâu thi giá sao', { llm: { template_id: 'PRICE_MIX_TUI_LON' } });
  assert.equal(mix.result.templateId, 'PRICE_MIX_TUI_LON', JSON.stringify(mix.result));
  assert.ok(mix.sent.length > 0);
  // Chào live đã lâu (2 giờ): vẫn đổi bảng mix thành lời chào live như vòng 12.
  const old = liveInbox(2 * 60 * MIN);
  const forced = await old.sim.send(old.inbox, 'Lấy tui vàng và nâu thi giá sao', { llm: { template_id: 'PRICE_MIX_TUI_LON' } });
  assert.equal(forced.result.templateId, 'LIVESTREAM_COMMENT');
  // Khách live đã có đơn (24 giờ): không ép lời chào live (lời mời đặt) nữa.
  const ordered = liveInbox(2 * 60 * MIN, { customerOrders: [{ id: 'o1', createdAt: Date.now() - 60 * MIN, phone: '0912345678', address: 'x', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }], status: 'Mới' }] });
  const kept = await ordered.sim.send(ordered.inbox, 'Lấy thêm tui vàng và nâu thi giá sao', { llm: { template_id: 'PRICE_MIX_TUI_LON' } });
  assert.equal(kept.result.templateId, 'PRICE_MIX_TUI_LON');
});

test('câu trả lời trùng tin vừa gửi mà khách hỏi ý mới: gọi lại mô hình MỘT lần với gợi ý không chọn lại mẫu đó', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ gender: 'female', botGender: 'female' });
  const first = await sim.send(inbox, 'viên ngũ cốc có giòn không em', { llm: { template_id: 'CRUNCHY_CEREAL_INFO' } });
  assert.equal(first.result.templateId, 'CRUNCHY_CEREAL_INFO');
  // Ca thật 30/09: mô hình chọn lại CRUNCHY_CEREAL_INFO → trước đây bot im. Nay hỏi lại, mô hình chọn mẫu khác → gửi.
  const second = await sim.send(inbox, 'Còn trái cây có sấy dòn không', {
    llm: (payload, call) => (call === 1 ? { template_id: 'CRUNCHY_CEREAL_INFO' } : { template_id: 'INGREDIENTS_ALLERGY' })
  });
  assert.equal(second.asked.length, 2, 'đúng một lần gọi lại');
  assert.match(second.asked[1].conversation.replyHint, /KHÔNG chọn lại .*CRUNCHY_CEREAL_INFO/);
  assert.equal(second.result.templateId, 'INGREDIENTS_ALLERGY', JSON.stringify(second.result));
  assert.ok(second.sent.length > 0);
  assert.equal(second.record.llm.hint, 'no-repeat');
  assert.equal(second.record.llm.calls, 2);
  assert.equal(second.record.chosen, 'CRUNCHY_CEREAL_INFO', 'nhật ký giữ mẫu chọn lần đầu');
  assert.equal(second.record.final, 'INGREDIENTS_ALLERGY');
});

// R14 (chủ shop 03/10): chỗ trước đây bot im lần ĐẦU nay báo bạn phụ trách trả lời (STAFF_WAIT_*) + thẻ; trong 2 giờ sau đó
// mới im như cũ (tests/r14-staff-wait.test.mjs).
test('gọi lại mà mô hình vẫn chọn mẫu vừa gửi / chuyển người / lên đơn: báo bạn phụ trách lần đầu, sau đó im + thẻ; khách lặp y câu thì không gọi lại', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox();
  await sim.send(inbox, 'có giấy chứng nhận không', { llm: { template_id: 'CERTIFICATION' } });
  const same = await sim.send(inbox, 'Vẫn là bên bạn à', { llm: { template_id: 'CERTIFICATION' } });
  assert.equal(same.asked.length, 2);
  assert.match(same.result.templateId, /^STAFF_WAIT_(OPEN|CLOSED)$/, JSON.stringify(same.result));
  assert.ok(same.sent.length > 0);
  assert.ok(inbox.labels.includes('handoff'));
  // Mô hình đổi sang chuyển người hay lên đơn ở lượt gọi lại: không nhận (không tắt bot / không tạo đơn từ lượt cứu lặp).
  const handoff = await sim.send(inbox, 'Thế có 2 trang giọt nắng hả', { llm: (payload, call) => (call === 1 ? { template_id: 'CERTIFICATION' } : { template_id: 'CSKH_HANDOFF', warming: '1' }) });
  assert.equal(handoff.result.skipped, 'lặp tin vừa gửi');
  assert.notEqual(inbox.botEnabled, false);
  // Khách lặp lại y câu vừa hỏi: không tốn lượt gọi lại.
  // R15 (inbox2 A6, ca …990595 "Goi nho du vi ko" → "Goi nho du vi"): sửa khẳng định cũ — khách hỏi lại ngay sau câu trả lời
  // THÔNG TIN tức là câu trước chưa đúng ý; không còn "em vừa gửi ở tin ngay trên" (REPLY_ALREADY_SENT_INFO) mà báo bạn phụ
  // trách trả lời (STAFF_WAIT_*) + thẻ như vòng 14.
  const repeatSim = new Sim({ settings: { ruleIntent: 'off' } });
  const repeatInbox = repeatSim.inbox();
  await repeatSim.send(repeatInbox, 'có giấy chứng nhận không', { llm: { template_id: 'CERTIFICATION' } });
  const repeated = await repeatSim.send(repeatInbox, 'có giấy chứng nhận không', { llm: { template_id: 'CERTIFICATION' } });
  assert.equal(repeated.asked.length, 1);
  assert.match(repeated.result.templateId, /^STAFF_WAIT_(OPEN|CLOSED)$/);
  assert.ok(repeatInbox.labels.includes('handoff'));
});

test('ASK_TWO_BAGS ("bảng giá em gửi ở trên, lấy 2 túi vị nào") chỉ khi khách HỎI GIÁ; câu khác thì không', async () => {
  const start = async () => {
    const sim = new Sim({ settings: { ruleIntent: 'off' } });
    const inbox = sim.inbox();
    const first = await sim.send(inbox, 'shop ơi tư vấn giúp mình', { llm: { template_id: 'GENERAL_INFO' } });
    assert.equal(first.result.templateId, 'GENERAL_INFO');
    return { sim, inbox };
  };
  const price = await start();
  const asksPrice = await price.sim.send(price.inbox, 'Báo giá giúp mình', { llm: { template_id: 'GENERAL_INFO' } });
  assert.equal(asksPrice.result.templateId, 'ASK_TWO_BAGS', JSON.stringify(asksPrice.result));
  // "Có mấy loại" (ca thật 01/10) từng nhận ASK_TWO_BAGS: nay hỏi lại mô hình, có mẫu khác thì gửi mẫu đó.
  const other = await start();
  const flavours = await other.sim.send(other.inbox, 'Có mấy loại', { llm: (payload, call) => (call === 1 ? { template_id: 'GENERAL_INFO' } : { template_id: 'BAG_COMPARISON' }) });
  assert.notEqual(flavours.result.templateId, 'ASK_TWO_BAGS');
  assert.equal(flavours.result.templateId, 'BAG_COMPARISON', JSON.stringify(flavours.result));
  assert.match(flavours.asked[1].conversation.replyHint, /GENERAL_INFO/);
  // Không có mẫu nào khác: không mời "lấy 2 túi vị nào" — R14: báo bạn phụ trách trả lời + thẻ (trước đây im).
  const none = await start();
  const silent = await none.sim.send(none.inbox, 'Có mấy loại', { llm: { template_id: 'GENERAL_INFO' } });
  // R16 (bình luận B1, ca …486243 "Bên em có mấy loại"): câu hỏi chung "mấy loại" trùng danh sách vị VỪA gửi → nhắc "em đã gửi ở
  // tin ngay trên" (REPLY_ALREADY_SENT), không chuyển bạn phụ trách (trước R16 test khẳng định STAFF_WAIT — chính lượt bị báo sai).
  assert.equal(silent.result.templateId, 'REPLY_ALREADY_SENT', JSON.stringify(silent.result));
});

test('tin ưu đãi QR / bám đuổi sau lượt bot không phải "nhân viên trả lời": nhật ký ghi false, luật vẫn coi ngữ cảnh đã đổi', async () => {
  assert.equal(isHumanPageMessage({ direction: 'outgoing', text: 'ưu đãi', sender: 'bot' }), false);
  assert.equal(isHumanPageMessage({ direction: 'outgoing', text: 'nhắc', followUp: true }), false);
  assert.equal(isHumanPageMessage({ direction: 'outgoing', text: 'chào', pancakeSender: 'Botcake' }), false);
  assert.equal(isHumanPageMessage({ direction: 'outgoing', type: 'order-receipt', text: 'Đã gửi xác nhận đơn hàng' }), false);
  assert.equal(isHumanPageMessage({ direction: 'outgoing', text: 'Khách đã trả lời một quảng cáo.' }), false);
  assert.equal(isHumanPageMessage({ direction: 'outgoing', text: 'Dạ chị chờ em', staff: true }), true);
  assert.equal(isHumanPageMessage({ direction: 'outgoing', text: 'tin Page không dấu máy gửi' }), true);

  const seen = [];
  const spy = { ruleIntent: (text, ctx) => { seen.push(ctx); return null; } };
  const sim = new Sim();
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 60 * MIN });
  sim.history(inbox, 'outgoing', 'Thân gửi Anh, Giọt Nắng cảm ơn anh đã tin tưởng và ủng hộ ạ 💛 Em gửi anh ưu đãi cho đơn tiếp theo tại Fanpage', 2 * MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Lấy anh 2 túi Xanh', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' }, extra: spy });
  assert.equal(turn.record.ctx.staffRepliedAfterBot, false, 'tin ưu đãi QR (sender bot) không phải nhân viên');
  assert.equal(seen.at(-1).staffRepliedAfterBot, true, 'với luật: ngữ cảnh đã đổi, không dùng mẫu bot gửi lần cuối');
  // Nhân viên thật nhắn sau bot (và bot được phép trả lời vì đã quá 2 giờ): cờ nhật ký là true.
  const staffSim = new Sim();
  const staffInbox = staffSim.inbox({ botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: Date.now() - 300 * MIN });
  staffSim.history(staffInbox, 'outgoing', 'Dạ chị cần em tư vấn thêm gì không ạ', 200 * MIN, { staff: true, staffName: 'NV' });
  const staffTurn = await staffSim.send(staffInbox, 'cho chị xin giá', { llm: { template_id: 'GENERAL_INFO' }, extra: spy });
  assert.equal(staffTurn.record.ctx.staffRepliedAfterBot, true);
});

test('addressInText của nhật ký: tin giỏ Shop / "Hạt Dinh Dưỡng" / "quan tâm" / "không đường" không phải địa chỉ', () => {
  const text = value => ({ type: 'text', text: value });
  assert.equal(addressWordsInText({ type: 'text', text: 'Khách chọn mua từ Facebook Shop: Granola Mới Ngũ Cốc Ăn Sáng Healthy Lành Mạnh Với Hạt Dinh Dưỡng Trái Cây Từ Giọt Nắng (CB-VANGG+XANH) — 298.000đ', cart: [{ sku: 'CB-VANGG+XANH', quantity: 1 }] }), false);
  assert.equal(addressWordsInText(text('Khách chọn mua từ Facebook Shop: Granola Với Hạt Dinh Dưỡng (GRA-XANH-Z450) — 189.000đ')), false);
  assert.equal(addressWordsInText(text('2 túi hạt dinh dưỡng giá sao')), false);
  assert.equal(addressWordsInText(text('em quan tâm túi 450g')), false);
  assert.equal(addressWordsInText(text('loại không đường 2 túi')), false);
  assert.equal(addressWordsInText(text('12 đường Lê Lợi phường 3')), true);
  assert.equal(addressWordsInText(text('số nhà 5 ngõ 20 quận Tân Bình')), true);
  assert.equal(addressWordsInText(text('xã Tân Phú huyện Củ Chi')), false, 'không có chữ số ngoài SĐT: như định nghĩa cũ');
  assert.equal(addressWordsInText({ type: 'image', text: '12 đường Lê Lợi' }), false);
  // decisionContext dùng đúng hàm này.
  const ctx = decisionContext({ conversation: {}, message: { type: 'text', text: 'Khách chọn mua từ Facebook Shop: Hạt Dinh Dưỡng (X-1) — 189.000đ' } });
  assert.equal(ctx.addressInText, false);
});

test('đặc trưng livestream thống nhất (bài live HOẶC thẻ Livestream) giữa nhật ký, luật và mô hình; ngưỡng mẫu tầng mặc định 0,85', async () => {
  assert.equal(CASCADE_TEMPLATE_THRESHOLD, 0.85);
  // Gọi thuần: suy từ hội thoại + thẻ.
  assert.equal(decisionContext({ conversation: { post: { message: 'Săn deal cùng Giọt Nắng ạ' } }, message: { type: 'text', text: 'ib' } }).livestream, true);
  assert.equal(decisionContext({ conversation: {}, message: { type: 'text', text: 'ib' }, labels: ['livestream'] }).livestream, true);
  assert.equal(decisionContext({ conversation: {}, message: { type: 'text', text: 'ib' } }).livestream, false);
  // Trong engine: hộp thư mang thẻ Livestream (bài không phải live) → nhật ký và luật cùng ghi true.
  const seen = [];
  const sim = new Sim();
  const inbox = sim.inbox({ labels: ['livestream'], post: { id: 'p', message: 'Granola túi xanh giòn rụm' } });
  const turn = await sim.send(inbox, 'shop ơi cho hỏi chút', { llm: { template_id: 'WELCOME' }, extra: { ruleIntent: (text, ctx) => { seen.push(ctx); return null; } } });
  assert.equal(turn.record.ctx.livestream, true);
  assert.equal(seen.at(-1).livestream, true);
});
