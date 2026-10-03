// Vòng 13 (02/10) — bình luận bị xử lý lại sau mỗi lần khởi động lại (out-comments F1), dòng hệ thống Facebook lưu như tin
// Page (F10), hạn chờ gửi Pancake cho bình luận (F3), ảnh /q/brand/* đọc từ đĩa.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PAGE } from './helpers/r13-engine-sim.mjs';
import { backlogBotChanges, botAlreadyHandled, brandImageFiles, missedBotChanges, pancakeMessageEvent, pancakeSendTimeoutMs, readImageForUpload, sendPancakeMessage } from '../app/pancake.mjs';
import { isPageSystemNotice, isPageSystemNoticeText } from '../app/conversation-orders.mjs';
import { metaConfig } from '../app/config.mjs';

const MIN = 60 * 1000;
const storeOf = sim => ({ conversations: [...sim.conversations.values()], messages: Object.fromEntries(sim.messages) });

test('khởi động lại sau khi chỉ nhắn riêng: bình luận đã trả lời bằng tin riêng (không có lời công khai) KHÔNG được đưa bot lại', async () => {
  const sim = new Sim();
  const thread = sim.comment();
  // Luồng vừa có lời công khai < 10 phút (bình luận trước của khách) → lượt này chỉ nhắn riêng, không đăng công khai.
  sim.history(thread, 'incoming', 'gia bao nhiêu vay em', 6 * MIN);
  sim.history(thread, 'outgoing', 'Dạ em đã nhắn tin cho mình rồi ạ', 5 * MIN);
  const turn = await sim.send(thread, 'Còn túi vàng thì sao', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Vàng 350g' } });
  assert.equal(turn.result.templateId, 'PRICE_QUOTE');
  assert.equal(turn.sent.filter(item => item.privateReply).length, 1, 'có tin nhắn riêng');
  assert.equal(turn.sent.filter(item => !item.privateReply).length, 0, 'không có lời công khai (vừa đăng < 10 phút)');
  // Trạng thái đúng như lỗi thật: tin CUỐI của luồng bình luận là của khách, không có tin Page nào sau nó.
  assert.equal(sim.list(thread.id).at(-1).direction, 'incoming');
  const store = storeOf(sim);
  assert.equal(botAlreadyHandled(thread, turn.incoming, store), true);
  assert.deepEqual(backlogBotChanges(store).map(change => change.conversation.id), [], 'backlog sau khởi động bỏ qua luồng này');
  assert.deepEqual(missedBotChanges([{ type: 'message', conversation: thread, message: turn.incoming }], store), [], 'đồng bộ muộn cũng bỏ qua');
  // Tin riêng nằm ở hộp thư là đủ, kể cả khi botLastReplyAt của luồng không được ghi (lượt lưu trạng thái hỏng).
  const withoutMark = { ...store, conversations: store.conversations.map(item => (item.id === thread.id ? { ...item, botLastReplyAt: 0 } : item)) };
  assert.equal(botAlreadyHandled({ ...thread, botLastReplyAt: 0 }, turn.incoming, withoutMark), true, 'hộp thư có tin riêng sau thời điểm bình luận');
  // Chốt trong engine: tin đến muộn (late) của đúng bình luận đó bị bỏ, không gửi gì, không gọi mô hình.
  const again = await sim.send(thread, '', { existing: turn.incoming, change: { late: true }, llm: () => { throw new Error('không được gọi mô hình'); } });
  assert.equal(again.result.skipped, 'đã xử lý trước khi khởi động lại');
  assert.deepEqual(again.sent, []);
  assert.equal(again.asked.length, 0);
});

test('bình luận MỚI sau lượt bot trả lời vẫn được đưa bot (không chặn nhầm cả luồng)', async () => {
  const sim = new Sim();
  const thread = sim.comment({ botLastReplyAt: Date.now() - 10 * MIN });
  sim.history(thread, 'incoming', 'Xin giá', 11 * MIN);
  const fresh = sim.history(thread, 'incoming', 'Cho mình 2 túi xanh', 2 * MIN);
  const store = storeOf(sim);
  assert.equal(botAlreadyHandled(thread, fresh, store), false);
  assert.deepEqual(backlogBotChanges(store).map(change => change.message.id), [fresh.id]);
});

test('bình luận tag tên không bị xét lại: lượt bỏ qua có chủ ý ghi botHandledMessageId, backlog không đưa lại', async () => {
  const sim = new Sim();
  const thread = sim.comment();
  const turn = await sim.send(thread, 'Nguyễn Minh Anh');
  assert.equal(turn.result.skipped, 'bình luận chỉ tag bạn bè');
  assert.equal(thread.botHandledMessageId, turn.incoming.id, 'dấu bền trên hội thoại');
  assert.equal(thread.botLastReplyAt, undefined, 'không giả là đã trả lời');
  assert.deepEqual(backlogBotChanges(storeOf(sim)), []);
  // Nhân viên đang xử lý ở hộp thư: bình luận không phải đặt hàng bị bỏ có chủ ý → cũng ghi dấu.
  const busy = new Sim({ psid: 'busy' });
  const busyThread = busy.comment();
  const busyInbox = busy.inbox({ botLastReplyAt: Date.now() - 30 * MIN });
  busy.history(busyInbox, 'outgoing', 'Dạ chị chờ em kiểm tra nha', 5 * MIN, { staff: true });
  const skipped = await busy.send(busyThread, 'ngon quá shop ơi');
  assert.equal(skipped.result.skipped, 'nhân viên đang xử lý');
  assert.equal(busyThread.botHandledMessageId, skipped.incoming.id);
  assert.deepEqual(backlogBotChanges(storeOf(busy)), []);
});

test('hộp thư: lượt "lặp tin vừa gửi" ghi dấu ngay trong lần lưu thẻ; tin đưa lại sau khởi động bị bỏ', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  // R14: vừa báo bạn phụ trách trả lời (trong 2 giờ) → lượt lặp tiếp theo im như cũ (đường được kiểm ở test này).
  const inbox = sim.inbox({ staffWaitAt: Date.now() - 10 * 60 * 1000 });
  const first = await sim.send(inbox, 'có giấy chứng nhận không', { llm: { template_id: 'CERTIFICATION' } });
  assert.equal(first.result.templateId, 'CERTIFICATION');
  // Ca thật 30/09: mô hình trả lại đúng mẫu vừa gửi (cả khi được nhắc chọn mẫu khác) → im + thẻ.
  const second = await sim.send(inbox, 'Mình thấy có 2 giọt nắng này', { llm: { template_id: 'CERTIFICATION' } });
  assert.equal(second.result.skipped, 'lặp tin vừa gửi');
  assert.equal(inbox.botHandledMessageId, second.incoming.id);
  assert.deepEqual(second.saved.at(-1).state.addLabelEvents, ['handoff'], 'vẫn một lần lưu (thẻ + dấu), không thêm lần lưu riêng');
  const late = await sim.send(inbox, '', { existing: second.incoming, change: { late: true }, llm: () => { throw new Error('không được gọi mô hình'); } });
  assert.equal(late.result.skipped, 'đã xử lý trước khi khởi động lại');
});

test('dòng hệ thống Facebook lưu như tin Page: mang cờ system, không tính là "Page đã trả lời"', async () => {
  for (const text of [
    'Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình. Xem bình luận.(https://facebook.com/reel/1/?comment_id=2)',
    'Khách Lạ đã trả lời một quảng cáo.',
    'Khách Lạ đã trả lời về một bài viết. Xem bài viết(https://www.facebook.com/x/videos/1/)',
    'Khach La replied to a post. View post(https://www.facebook.com/x/videos/1/)'
  ]) assert.equal(isPageSystemNoticeText(text), true, text);
  for (const text of ['Dạ em đã nhắn tin cho mình rồi ạ', 'Dạ chị đã trả lời em rồi mà', '']) assert.equal(isPageSystemNoticeText(text), false, text);
  const event = pancakeMessageEvent(PAGE, { id: `${PAGE}_user`, from: { id: 'user', name: 'Khách' } }, { id: 'n1', from: { id: PAGE }, message: 'Khách đã trả lời một quảng cáo.', inserted_at: '2026-10-02T03:00:00' });
  assert.equal(event.message.system, true);
  assert.equal(event.message.type, 'text', 'giữ type text: giao diện và dữ liệu cũ vẫn đọc được');
  assert.equal(event.message.staff, undefined);
  const normal = pancakeMessageEvent(PAGE, { id: `${PAGE}_user`, from: { id: 'user', name: 'Khách' } }, { id: 'n2', from: { id: PAGE, admin_name: 'Public API' }, message: 'Dạ em gửi bảng giá ạ', inserted_at: '2026-10-02T03:00:00' });
  assert.equal(normal.message.system, undefined);
  assert.equal(isPageSystemNotice({ direction: 'outgoing', type: 'text', text: 'Khách đã trả lời một quảng cáo.' }), true, 'tin cũ chưa có cờ: nhận theo chữ');
  assert.equal(isPageSystemNotice({ direction: 'incoming', type: 'text', text: 'Khách đã trả lời một quảng cáo.' }), false);

  // Hộp thư: khách nhắn rồi Facebook chèn dòng "… đã trả lời một quảng cáo." SAU tin khách → vẫn là tin chưa ai trả lời.
  const sim = new Sim();
  const inbox = sim.inbox();
  const asked = sim.history(inbox, 'incoming', 'Giá sao em', 3 * MIN);
  sim.history(inbox, 'outgoing', 'Khách đã trả lời một quảng cáo.', 3 * MIN - 2000, { pancakeSender: 'Ngoài Pancake' });
  assert.deepEqual(backlogBotChanges(storeOf(sim)).map(change => change.message.id), [asked.id], 'backlog vẫn đưa tin khách');
  const late = await sim.send(inbox, '', { existing: asked, change: { late: true }, llm: { template_id: 'GENERAL_INFO' } });
  assert.notEqual(late.result.skipped, 'đã có người trả lời');
  assert.ok(late.sent.length > 0, 'bot trả lời tin đến muộn');
  assert.equal(late.record.ctx.staffRepliedAfterBot, false, 'dòng hệ thống không phải nhân viên trả lời');
});

test('hạn chờ gửi Pancake: trả lời bình luận / nhắn riêng 28 giây, tin hộp thư giữ 15 giây', async () => {
  assert.equal(pancakeSendTimeoutMs('reply_inbox'), 15000);
  assert.equal(pancakeSendTimeoutMs('reply_comment'), 28000);
  assert.equal(pancakeSendTimeoutMs('private_replies'), 28000);
  assert.equal(pancakeSendTimeoutMs(), 15000);
  // Hết giờ chờ của lời công khai vẫn báo PANCAKE_SEND_UNCERTAIN (kèm số giây đúng) — đường khác không đổi.
  const config = { apiBase: 'https://pancake.test/api', pageId: PAGE, pageAccessToken: 'token-test', pages: [] };
  const aborting = async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; };
  await assert.rejects(
    () => sendPancakeMessage({ pageId: PAGE, conversationId: 'c', text: 'Dạ em đã nhắn tin', action: 'reply_comment', commentId: 'cm1' }, config, aborting),
    error => /28 giây/.test(error.message) && (error.code === 'PANCAKE_SEND_UNCERTAIN' || error.unknownDelivery === true)
  );
  await assert.rejects(
    () => sendPancakeMessage({ pageId: PAGE, conversationId: 'c2', text: 'Dạ em gửi bảng giá' }, config, aborting),
    error => /15 giây/.test(error.message)
  );
});

test('ảnh /q/brand/* của chính máy chủ: đọc thẳng từ đĩa, không tự tải qua địa chỉ công khai', async () => {
  assert.equal(brandImageFiles['/q/brand/offer-card.png'], 'offers/the-uu-dai.png');
  const base = String(metaConfig.publicBaseUrl || '').replace(/\/+$/, '');
  const noNetwork = async () => { throw new Error('không được tải qua mạng'); };
  const file = await readImageForUpload(`${base}/q/brand/offer-card.png`, noNetwork);
  assert.equal(file.mime, 'image/png');
  assert.equal(file.filename, 'the-uu-dai.png');
  assert.ok(file.buffer.length > 1000);
  const logo = await readImageForUpload(`${base}/q/brand/logo.webp`, noNetwork);
  assert.equal(logo.mime, 'image/webp');
  // Đường /q/brand/ không có trong bảng → vẫn đi đường tải như cũ (ở đây: bị chặn vì fetch giả ném lỗi).
  await assert.rejects(() => readImageForUpload(`${base}/q/brand/khong-co.png`, noNetwork));
});
