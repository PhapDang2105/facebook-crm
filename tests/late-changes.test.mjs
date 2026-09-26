import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { processChatbotChanges } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates } from '../app/chatbot-templates.mjs';
import { missedBotChanges, backlogBotChanges, staffRepliedRecently } from '../app/pancake.mjs';

// Rà 26/09: tin đến muộn qua đồng bộ/backlog có thể đã được trả lời trong lúc chờ; cùng tin về hai đường.
const templates = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const settings = async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 1, messageTemplates: templates });

test('tin đến muộn (late) mà Page đã trả lời sau đó: bot bỏ qua; tin webhook bình thường vẫn trả lời', async () => {
  const now = Date.now();
  const message = { id: 'm1', mid: 'm1', direction: 'incoming', type: 'text', text: 'Xin giá', createdAt: now - 60000 };
  const answered = [message, { id: 'o1', direction: 'outgoing', type: 'text', text: 'Dạ bảng giá…', createdAt: now - 30000 }];
  const deps = sent => ({
    readSettings: settings,
    listMessages: async () => answered,
    saveBotState: async () => {},
    sendMessage: async (_c, m) => { sent.push(m.text); return { message: { mid: 'x' } }; },
    requestReply: async () => ({ templateId: 'GENERAL_INFO', messages: ['Bảng giá'], handoff: false })
  });
  const sentLate = [];
  const late = await processChatbotChanges([{ type: 'message', conversation: { id: 'p:u', pageId: 'p', psid: 'u', botEnabled: true }, message, late: true }], deps(sentLate));
  assert.equal(late[0].skipped, 'đã có người trả lời');
  assert.deepEqual(sentLate, []);
  const sentLive = [];
  await processChatbotChanges([{ type: 'message', conversation: { id: 'p:u', pageId: 'p', psid: 'u', botEnabled: true }, message: { ...message, id: 'm2', mid: 'm2' } }], deps(sentLive));
  assert.equal(sentLive.length > 0, true, 'tin webhook thường: trả lời như cũ');
});

test('cùng một tin vào hai lần trong lúc lượt đầu còn chạy: lượt hai bị bỏ', async () => {
  const now = Date.now();
  const message = { id: 'm9', mid: 'm9', direction: 'incoming', type: 'text', text: 'Xin giá', createdAt: now };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = [];
  const deps = {
    readSettings: settings,
    listMessages: async () => [message],
    saveBotState: async () => {},
    sendMessage: async (_c, m) => { sent.push(m.text); return { message: { mid: 'x' } }; },
    requestReply: async () => { await gate; return { templateId: 'GENERAL_INFO', messages: ['Bảng giá'], handoff: false }; }
  };
  const first = processChatbotChanges([{ type: 'message', conversation: { id: 'p:v', pageId: 'p', psid: 'v', botEnabled: true }, message }], deps);
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = await processChatbotChanges([{ type: 'message', conversation: { id: 'p:v', pageId: 'p', psid: 'v', botEnabled: true }, message, late: true }], deps);
  assert.equal(second[0].skipped, 'đang xử lý tin này');
  release();
  await first;
  // Lượt đầu gửi đủ phần của mẫu; chạy lại một tin khác cùng nội dung thì số tin gửi bằng đúng lượt đầu (không nhân đôi).
  const once = sent.length;
  assert.ok(once >= 1);
  sent.length = 0;
  await processChatbotChanges([{ type: 'message', conversation: { id: 'p:w', pageId: 'p', psid: 'w', botEnabled: true }, message: { ...message, id: 'm10', mid: 'm10' } }], { ...deps, listMessages: async () => [{ ...message, id: 'm10', mid: 'm10' }] });
  assert.equal(sent.length, once);
});

test('đồng bộ không đưa bot khi nhân viên vừa nhắn trong Pancake (60 phút) hay hội thoại đã gán nhân viên; tin đưa bot mang cờ late', () => {
  const now = Date.now();
  const staffStore = { messages: { c: [{ id: 'a', direction: 'incoming', type: 'text', createdAt: now - 10 * 60000 }, { id: 'b', direction: 'outgoing', type: 'text', staff: true, staffName: 'Thúy Hằng', createdAt: now - 9 * 60000 }] } };
  assert.equal(staffRepliedRecently(staffStore.messages.c, now), true);
  const fresh = { type: 'message', conversation: { id: 'c' }, message: { id: 'z', direction: 'incoming', createdAt: now - 60000 } };
  assert.deepEqual(missedBotChanges([fresh], staffStore, { now }), []);
  assert.deepEqual(missedBotChanges([{ ...fresh, conversation: { id: 'd', pancakeAssigned: true } }], { messages: { d: [] } }, { now }), []);
  assert.equal(missedBotChanges([{ ...fresh, conversation: { id: 'd', pancakeAssigned: true } }], { messages: { d: [] } }, { now, botWhenAssigned: true }).length, 1);
  const okChanges = missedBotChanges([{ ...fresh, conversation: { id: 'e' } }], { messages: { e: [] } }, { now });
  assert.equal(okChanges[0].late, true);
  const backlog = backlogBotChanges({ conversations: [{ id: 'c' }, { id: 'f', pancakeAssigned: true }, { id: 'g' }], messages: { ...staffStore.messages, f: [{ id: 'f1', direction: 'incoming', type: 'text', createdAt: now - 60000 }], g: [{ id: 'g1', direction: 'incoming', type: 'text', createdAt: now - 60000 }] } }, { now });
  assert.deepEqual(backlog.map(change => [change.conversation.id, change.late]), [['g', true]]);
});
