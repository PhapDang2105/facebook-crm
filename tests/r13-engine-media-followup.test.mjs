// Vòng 13 (02/10) — tệp/video kèm chữ và ảnh bill (out-inbox3 F4), tin nhắc giỏ khi địa chỉ thiếu phường/xã và lý do không
// bám đuổi (out-inbox2 C2, out-inbox3 F10).
import assert from 'node:assert/strict';
import test from 'node:test';
import { utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('r13-engine-fu-');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(directory, 'follow-ups.json');
process.env.INBOX_SETTINGS_PATH = path.join(directory, 'inbox-settings.json');
writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({ conversations: [], messages: {}, commentIndex: {} }));

const { Sim, PHONE, XANH, basket, seedTemplates } = await import('./helpers/r13-engine-sim.mjs');
const { normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');
const followUp = await import('../app/follow-up.mjs');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

test('tệp / video gửi kèm tin chữ chưa trả lời: xử lý theo Ý CỦA TIN CHỮ (trước đây chỉ ảnh mới được gộp)', async () => {
  for (const type of ['attachment', 'video']) {
    const sim = new Sim({ settings: { ruleIntent: 'off' } });
    const inbox = sim.inbox();
    sim.history(inbox, 'incoming', 'Túi vàng giá sao em', 10 * 1000);
    const turn = await sim.send(inbox, type === 'attachment' ? '[Tệp đính kèm]' : '', { type, message: type === 'video' ? { dataUrl: 'https://content.pancake.vn/v/a.mp4' } : {}, llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Vàng 350g' } });
    assert.equal(turn.result.templateId, 'PRICE_QUOTE', `${type}: ${JSON.stringify(turn.result)}`);
    assert.equal(turn.asked.length, 1);
    assert.equal(turn.asked[0].message.text, 'Túi vàng giá sao em', 'mô hình nhận chữ của khách, không phải "[Tệp đính kèm]"');
    assert.match(turn.sent.map(item => item.text).join(' '), /Túi Vàng/);
    assert.ok(inbox.labels.includes('handoff'), 'thẻ để nhân viên xem tệp');
    assert.equal(turn.record.text, 'Túi vàng giá sao em');
  }
  // Tệp trơ trọi (không có tin chữ kèm): vẫn "đã nhận hình" + thẻ như cũ.
  const alone = new Sim({ settings: { ruleIntent: 'off' } });
  const aloneInbox = alone.inbox();
  const only = await alone.send(aloneInbox, '[Tệp đính kèm]', { type: 'attachment', llm: () => { throw new Error('không hỏi mô hình cho tệp trơ trọi'); } });
  assert.equal(only.result.templateId, 'IMAGE_RECEIVED');
});

test('ảnh bill tới 3 phút sau khi khách nói đã chuyển khoản: báo đã nhận, nhân viên kiểm tra — không gửi bảng giá', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 2 * MIN });
  sim.history(inbox, 'incoming', 'Mình chuyển khoản luôn nha shop', 3 * MIN);
  sim.history(inbox, 'outgoing', 'Dạ vâng ạ 💛', 3 * MIN - 5000, { sender: 'bot' });
  const turn = await sim.send(inbox, '', { type: 'image', message: { dataUrl: 'https://content.pancake.vn/a/bill.jpg' }, llm: () => { throw new Error('ảnh bill không cần mô hình'); } });
  assert.equal(turn.result.templateId, 'PAYMENT_RECEIVED_CHECK', JSON.stringify(turn.result));
  assert.ok(inbox.labels.includes('handoff'));
  // Câu HỎI về chuyển khoản rồi gửi ảnh (2 phút sau) không phải bill.
  const question = new Sim({ settings: { ruleIntent: 'off' } });
  const questionInbox = question.inbox({ botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: Date.now() - MIN });
  question.history(questionInbox, 'incoming', 'chuyển khoản được không em?', 2 * MIN);
  question.history(questionInbox, 'outgoing', 'Dạ được ạ', 2 * MIN - 5000, { sender: 'bot' });
  const notBill = await question.send(questionInbox, '', { type: 'image', message: { dataUrl: 'https://content.pancake.vn/a/tui.jpg' } });
  assert.notEqual(notBill.result.templateId, 'PAYMENT_RECEIVED_CHECK');
  // Quá 5 phút: không còn coi là bill.
  const stale = new Sim({ settings: { ruleIntent: 'off' } });
  const staleInbox = stale.inbox({ botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: Date.now() - 9 * MIN });
  stale.history(staleInbox, 'incoming', 'Mình chuyển khoản luôn nha shop', 10 * MIN);
  stale.history(staleInbox, 'outgoing', 'Dạ vâng ạ', 9 * MIN, { sender: 'bot' });
  const late = await stale.send(staleInbox, '', { type: 'image', message: { dataUrl: 'https://content.pancake.vn/a/x.jpg' } });
  assert.notEqual(late.result.templateId, 'PAYMENT_RECEIVED_CHECK');
});

test('mẫu trước là PAYMENT_METHODS / BANK_TRANSFER mà khách gửi ảnh: coi là bill', async () => {
  for (const last of ['PAYMENT_METHODS', 'BANK_TRANSFER']) {
    const sim = new Sim({ settings: { ruleIntent: 'off' } });
    const inbox = sim.inbox({ botLastTemplateId: last, botLastReplyAt: Date.now() - 4 * MIN });
    sim.history(inbox, 'outgoing', 'Dạ thông tin thanh toán bên em ạ', 4 * MIN, { sender: 'bot' });
    const turn = await sim.send(inbox, '', { type: 'image', message: { dataUrl: 'https://content.pancake.vn/a/bill.jpg' }, llm: () => { throw new Error('không cần mô hình'); } });
    assert.equal(turn.result.templateId, 'PAYMENT_RECEIVED_CHECK', `${last}: ${JSON.stringify(turn.result)}`);
  }
  // PAYMENT_METHODS đã quá 60 phút: ảnh xử lý như ảnh thường.
  const old = new Sim({ settings: { ruleIntent: 'off' } });
  const oldInbox = old.inbox({ botLastTemplateId: 'PAYMENT_METHODS', botLastReplyAt: Date.now() - 3 * HOUR });
  const turn = await old.send(oldInbox, '', { type: 'image', message: { dataUrl: 'https://content.pancake.vn/a/x.jpg' } });
  assert.notEqual(turn.result.templateId, 'PAYMENT_RECEIVED_CHECK');
});

test('tin nhắc giỏ: giỏ đủ SĐT + địa chỉ nhưng thiếu phường/xã (bot đã hỏi hết lượt) → vẫn nhắc đúng phần còn thiếu, không rỗng', () => {
  const now = Date.now();
  const templates = normalizeChatbotSettings({ enabled: true }).messageTemplates;
  const pending = { ...basket([XANH(2)], HOUR), phone: PHONE, address: 'xóm 8 Sơn Cẩm, Thái Nguyên' };
  // Bot đã hỏi 2 lần: bộ soạn đơn coi địa chỉ là chốt được nên trước đây tin nhắc giỏ RỖNG (giỏ không bao giờ được bám).
  const stuck = followUp.orderRemindText({ gender: 'female', pendingOrder: { ...pending, addressAsks: 2 } }, templates, { now });
  assert.match(stuck, /^Dạ em vẫn đang giữ đơn 2 Granola Túi Xanh 450g/);
  assert.match(stuck, /phường\/xã/);
  const once = followUp.orderRemindText({ gender: 'female', pendingOrder: { ...pending, addressAsks: 1 } }, templates, { now });
  assert.match(once, /phường\/xã/);
  // Địa chỉ đã đủ cấp + SĐT: không có gì để nhắc (đơn chờ việc khác).
  const complete = followUp.orderRemindText({ gender: 'female', pendingOrder: { ...pending, address: '12 Nguyễn Trãi, phường Bến Thành, Quận 1, TP HCM', addressAsks: 1 } }, templates, { now });
  assert.equal(complete, '');
  // Thiếu SĐT: xin SĐT như cũ.
  assert.match(followUp.orderRemindText({ gender: 'female', pendingOrder: { ...pending, phone: '' } }, templates, { now }), /số điện thoại/);
});

test('lượt bám đuổi ghi lý do không bám theo từng khách: một dòng log tổng hợp + lastRun.skipDetails; dòng hệ thống Facebook không tính là Page trả lời', async () => {
  // 10:00 giờ VN (ngoài giờ yên tĩnh).
  const now = Date.parse('2026-09-30T03:00:00Z');
  const page = '110';
  const psids = Array.from({ length: 200 }, (_, index) => `r${index}`).filter(id => !followUp.isFollowUpHoldout(id));
  const [labelled, waiting, noticeOnly, fresh] = psids;
  const inbox = (psid, extra = {}) => ({ id: `${page}:${psid}`, pageId: page, psid, name: `Khách ${psid}`, source: 'inbox', ...extra });
  const message = (direction, createdAt, extra = {}) => ({ id: `m${createdAt}${direction}`, mid: '', direction, type: 'text', text: 'x', createdAt, status: 'sent', ...extra });
  const held = { ...basket([XANH(2)], 0), at: now - 4 * HOUR };
  writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({
    commentIndex: {},
    conversations: [
      // Thẻ khiếu nại: bỏ qua ở vòng gửi (lý do "label").
      inbox(labelled, { labels: ['complaint'] }),
      // Đang giữ giỏ, khách nhắn SAU tin Page cuối → không vào diện bám (trước đây không có dấu vết nào).
      inbox(waiting, { pendingOrder: held }),
      // Sau tin khách chỉ có dòng hệ thống "… đã trả lời một quảng cáo." → không phải Page đã trả lời.
      inbox(noticeOnly, { pendingOrder: held }),
      // Giỏ đang giữ, Page mới trả lời 1 giờ trước (chưa đủ 3 giờ).
      inbox(fresh, { pendingOrder: held })
    ],
    messages: {
      [`${page}:${labelled}`]: [message('incoming', now - 6 * HOUR), message('outgoing', now - 5 * HOUR)],
      [`${page}:${waiting}`]: [message('outgoing', now - 5 * HOUR), message('incoming', now - 4 * HOUR)],
      [`${page}:${noticeOnly}`]: [message('incoming', now - 5 * HOUR), message('outgoing', now - 5 * HOUR + 1000, { text: `Khách ${noticeOnly} đã trả lời một quảng cáo.` })],
      [`${page}:${fresh}`]: [message('incoming', now - 2 * HOUR), message('outgoing', now - HOUR)]
    }
  }));
  const at = new Date(Date.now() + 120_000);
  utimesSync(process.env.META_CONVERSATIONS_PATH, at, at);
  writeFileSync(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: {} }));
  const module = await import('../app/follow-up.mjs?r13-skip=1');
  const settings = normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios: [{ id: 'inbox-ask', name: 'Hộp thư im 3 giờ', trigger: 'inbox-no-reply', delayHours: 3, message: 'Dạ {title} còn cần em tư vấn thêm gì không ạ?' }] } });
  const logs = [];
  const sent = [];
  const run = () => module.runFollowUps({ readSettings: async () => settings, sendMessage: async (conversation, payload) => { sent.push([conversation.id, payload.text]); return { message: { mid: 'x' } }; }, now, log: line => logs.push(String(line)) });
  const summary = await run();
  assert.deepEqual(sent, [], 'không ai đủ điều kiện bám');
  assert.equal(summary.skipReasons.label, 1);
  const tail = psid => `…${psid.slice(-6)}`;
  assert.deepEqual(summary.skipDetails.label, [tail(labelled)]);
  assert.deepEqual(summary.skipDetails['giỏ đang giữ – Page chưa trả lời tin cuối của khách'].sort(), [tail(waiting), tail(noticeOnly)].sort());
  assert.deepEqual(summary.skipDetails['giỏ đang giữ – chưa đủ 3 giờ'], [tail(fresh)]);
  const line = logs.find(text => text.startsWith('Bám đuổi: không bám — '));
  assert.ok(line, logs.join('\n'));
  assert.match(line, /label ×1/);
  assert.match(line, /giỏ đang giữ – chưa đủ 3 giờ ×1/);
  const state = await module.readFollowUpState();
  assert.deepEqual(state.lastRun.skipDetails, summary.skipDetails);
  // Lượt sau y hệt: không lặp lại dòng log.
  await run();
  assert.equal(logs.filter(text => text.startsWith('Bám đuổi: không bám — ')).length, 1);
  // Mẫu seed không bị đụng (test chỉ dùng để dựng Sim).
  assert.ok(seedTemplates.ORDER_ADDRESS_REMIND);
});
