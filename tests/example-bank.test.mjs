import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExampleBank, nearestExamples, formatExamples } from '../app/processing/example-bank.mjs';
import { buildChatbotQuery } from '../app/chatbot-engine.mjs';
import { normalizeChatbotSettings } from '../app/chatbot-settings.mjs';

const bank = buildExampleBank([
  { id: 'a', text: 'Dạng túi nhỏ em ơi', lastTemplate: 'GENERAL_INFO', label: 'PACKAGING_INFO' },
  { id: 'b', text: 'Có túi nhỏ ko shop', lastTemplate: '', label: 'PACKAGING_INFO' },
  { id: 'c', text: 'Lấy 2 túi giá bn', lastTemplate: '', label: 'PRICE_QUOTE_COMBO' },
  { id: 'd', text: 'Xin giá', lastTemplate: '', label: 'GENERAL_INFO' },
  { id: 'e', text: 'Xin giá', lastTemplate: '', label: 'GENERAL_INFO' },
  { id: 'f', text: 'bỏ qua', lastTemplate: '', label: 'SKIP' }
]);

test('kho ví dụ: tìm tin gần nhất theo n-gram (chịu không dấu), bỏ chính tin đang đo, không lặp câu trùng, dưới ngưỡng thì rỗng', () => {
  assert.equal(bank.size, 5, 'SKIP không vào kho');
  const near = nearestExamples(bank, { text: 'trong tui co chia tui nho ko', k: 3 });
  assert.equal(near[0].label, 'PACKAGING_INFO');
  assert.deepEqual(nearestExamples(bank, { text: 'Dạng túi nhỏ em ơi', excludeId: 'a' }).map(item => item.text)[0], 'Có túi nhỏ ko shop');
  assert.equal(nearestExamples(bank, { text: 'xin gia' }).filter(item => item.text === 'Xin giá').length, 1);
  assert.deepEqual(nearestExamples(bank, { text: 'hôm nay trời đẹp quá' }), []);
  assert.match(formatExamples(near), /VÍ DỤ ĐÃ DUYỆT[\s\S]*"Có túi nhỏ ko shop" → PACKAGING_INFO/);
  assert.equal(formatExamples([]), '');
});

test('câu hỏi gửi LLM chèn khối ví dụ ngay trước tin cần trả lời; cài đặt fewShot mặc định tắt', () => {
  const settings = normalizeChatbotSettings({});
  assert.equal(settings.fewShot, 'off');
  assert.equal(normalizeChatbotSettings({ fewShot: 'on' }).fewShot, 'on');
  const query = buildChatbotQuery({ conversation: { source: 'inbox', name: 'A' }, message: { type: 'text', text: 'có túi nhỏ k' }, settings, examples: [{ text: 'Dạng túi nhỏ em ơi', label: 'PACKAGING_INFO' }] });
  assert.match(query, /VÍ DỤ ĐÃ DUYỆT[\s\S]*→ PACKAGING_INFO\n\nTIN NHẮN CẦN TRẢ LỜI: có túi nhỏ k/);
  assert.doesNotMatch(buildChatbotQuery({ conversation: { source: 'inbox' }, message: { type: 'text', text: 'x' }, settings }), /VÍ DỤ ĐÃ DUYỆT/);
});
