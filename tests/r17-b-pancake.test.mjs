// Vòng 17 (10/10) — GÓI B, phần Pancake: hội thoại nhân viên đã nhận (inbox4 T4, ca …3578931563; chủ shop quyết định 10).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.META_CONVERSATIONS_PATH = path.join(tempDir('r17b-pancake-'), 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(tempDir('r17b-pancake-fu-'), 'follow-ups.json');
const { handlePancakeWebhook } = await import('../app/pancake.mjs');
const { recordSkippedChange } = await import('../app/chatbot-engine.mjs');

const config = { pageId: '110', pageName: 'Test', pageAccessToken: 'pat-1', webhookToken: 'hook-1', apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false };
let counter = 0;
const assignedMessage = (text, at) => {
  counter += 1;
  return {
    page_id: '110',
    event_type: 'messaging',
    data: {
      conversation: { id: '110_7788', type: 'INBOX', from: { id: '7788', name: 'Khách' }, assignee_ids: ['staff-1'] },
      message: {
        id: `r17b-m${counter}`, conversation_id: '110_7788', page_id: '110', type: 'INBOX', message: text, original_message: text,
        inserted_at: new Date(at).toISOString().replace('Z', ''), from: { id: '7788', name: 'Khách', page_customer_id: 'pc-7788' }, attachments: []
      }
    }
  };
};

test('B10. hội thoại NV đã nhận: TRONG giờ → bot đứng ngoài nhưng ghi dòng bỏ qua vào nhật ký; NGOÀI giờ "Ship đi nha" / SĐT → đưa bot', async () => {
  const calls = [];
  const skips = [];
  const records = [];
  const processChatbotChanges = async changes => { calls.push(...changes); };
  const chatbotDependencies = { recordBotSkip: (change, reason) => { skips.push(reason); records.push(recordSkippedChange(change, reason, { appendDecisionLog: () => {} })); } };
  const inHours = Date.UTC(2026, 9, 9, 3, 0); // 10:00 VN
  const first = await handlePancakeWebhook(assignedMessage('Ship đi nha', inHours), { processChatbotChanges, chatbotDependencies, config, now: inHours });
  assert.equal(first.bot, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(skips, ['nhân viên Pancake đã nhận hội thoại']);
  assert.equal(records[0].skipped, 'nhân viên Pancake đã nhận hội thoại');
  assert.equal(records[0].text, 'Ship đi nha');
  const evening = Date.UTC(2026, 9, 9, 13, 2); // 20:02 VN
  const second = await handlePancakeWebhook(assignedMessage('Ship đi nha', evening), { processChatbotChanges, chatbotDependencies, config, now: evening });
  assert.equal(second.bot, 1, 'ngoài giờ: tin đặt hàng đưa bot');
  assert.equal(calls.at(-1).message.text, 'Ship đi nha');
  const third = await handlePancakeWebhook(assignedMessage('Cho em hỏi giá', evening + 60000), { processChatbotChanges, chatbotDependencies, config, now: evening + 60000 });
  assert.equal(third.bot, 0, 'ngoài giờ: câu hỏi suông vẫn để nhân viên');
  assert.equal(skips.length, 2);
});
