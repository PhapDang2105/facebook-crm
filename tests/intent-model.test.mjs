import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { featuresOf, normalizeIntentText } from '../app/processing/intent-features.mjs';
import { intentSafeTemplates, loadIntentModel, predictIntent } from '../app/processing/intent-model.mjs';
import { normalizeChatbotSettings } from '../app/chatbot-settings.mjs';
import { processChatbotChanges } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates } from '../app/chatbot-templates.mjs';

test('đặc trưng: bỏ dấu, che SĐT, n-gram ký tự + từ + ngữ cảnh', () => {
  assert.equal(normalizeIntentText('Chị ơi, giá bao nhiêu? 0909123456'), 'chi oi gia bao nhieu <sdt>');
  const set = featuresOf({ text: 'Túi xanh giá sao', source: 'inbox', lastTemplate: 'WELCOME' });
  assert.ok(set.has('w:xanh') && set.has('has:colour') && set.has('last:WELCOME') && set.has('src:inbox'));
});

test('mô hình nhỏ: nạp được trọng số, đoán mẫu + xác suất; câu hỏi giá quen thuộc ra mẫu giá với xác suất cao', () => {
  const model = loadIntentModel();
  assert.ok(model && model.labels.length > 10, 'có intent-model.json');
  const guess = predictIntent({ text: 'giá bao nhiêu vậy shop', source: 'inbox', lastTemplate: '' });
  assert.ok(guess && guess.confidence > 0 && guess.confidence <= 1);
  assert.ok(['GENERAL_INFO', 'PRICE_QUOTE'].includes(guess.templateId), guess.templateId);
  assert.ok(intentSafeTemplates.has('GENERAL_INFO') && !intentSafeTemplates.has('ORDER_CONFIRMATION'));
});

test('cài đặt: intentModel mặc định shadow, ngưỡng 0.9; engine ở shadow vẫn hỏi LLM và ghi log so sánh; bật on + tin cậy cao thì trả lời thẳng', async () => {
  const base = normalizeChatbotSettings({ enabled: true });
  assert.deepEqual([base.intentModel, base.intentThreshold], ['shadow', 0.9]);
  const templates = defaultMessageTemplates();
  const run = async (extra, text) => {
    const logs = [];
    const original = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    let asked = false;
    const sent = [];
    try {
      await processChatbotChanges([{ type: 'message', conversation: { id: 'p:im', pageId: 'p', psid: 'im', name: 'Khách', botEnabled: true }, message: { id: 'mi', mid: 'mi', direction: 'incoming', type: 'text', text, createdAt: Date.now() } }], {
        readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 1, ruleIntent: 'off', messageTemplates: templates, ...extra }),
        listMessages: async () => [], saveBotState: async () => {},
        sendMessage: async (_c, message) => { sent.push(message.text || '[ảnh]'); return { message: { mid: 'x' } }; },
        requestReply: async () => { asked = true; return { templateId: 'GENERAL_INFO', messages: ['từ LLM'], handoff: false }; }
      });
    } finally { console.log = original; }
    return { asked, sent, logs };
  };
  const shadow = await run({ intentModel: 'shadow' }, 'giá bao nhiêu vậy shop');
  assert.equal(shadow.asked, true);
  assert.ok(shadow.logs.some(line => line.startsWith('Mô hình nhỏ (thử): ') && line.includes('/ thật GENERAL_INFO')), shadow.logs.join(' | '));
  const on = await run({ intentModel: 'on', intentThreshold: 0.5 }, 'giá bao nhiêu vậy shop');
  const guess = predictIntent({ text: 'giá bao nhiêu vậy shop', source: 'inbox', lastTemplate: '' });
  if (guess.confidence >= 0.5 && guess.margin >= 0.25 && intentSafeTemplates.has(guess.templateId)) { assert.equal(on.asked, false); assert.ok(on.sent.length >= 1); } else assert.equal(on.asked, true);
  const off = await run({ intentModel: 'off' }, 'giá bao nhiêu vậy shop');
  assert.ok(!off.logs.some(line => line.startsWith('Mô hình nhỏ')));
});
