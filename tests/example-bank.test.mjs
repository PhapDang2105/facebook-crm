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
  { id: 'f', text: 'bỏ qua', lastTemplate: '', label: 'SKIP' },
  { id: 'g', text: 'túi nhỏ giá bao nhiêu', lastTemplate: '', label: 'PACKAGING_INFO' },
  { id: 'h', text: 'túi nhỏ ib giá', lastTemplate: '', label: 'COMMENT_PUBLIC_REPLY', source: 'comment' }
]);

test('kho ví dụ: lọc theo kênh (hộp thư không lấy ví dụ bình luận) và mỗi nhãn tối đa 2 ví dụ, thiếu thì lấp thêm', () => {
  const inbox = nearestExamples(bank, { text: 'túi nhỏ giá bn', k: 3, source: 'inbox' });
  assert.ok(inbox.length >= 2);
  assert.ok(inbox.every(item => item.label !== 'COMMENT_PUBLIC_REPLY'), 'hộp thư không dùng ví dụ bình luận');
  assert.ok(inbox.filter(item => item.label === 'PACKAGING_INFO').length <= 2, 'tối đa 2 ví dụ cùng nhãn');
  const comment = nearestExamples(bank, { text: 'túi nhỏ giá bn', k: 3, source: 'comment' });
  assert.deepEqual(comment.map(item => item.label), ['COMMENT_PUBLIC_REPLY']);
  // Không giới hạn nhãn (perLabel 0) thì lấy theo điểm như trước, vẫn không có ví dụ bình luận.
  const all = nearestExamples(bank, { text: 'túi nhỏ giá bn', k: 3, minScore: 0.05, source: 'inbox', perLabel: 0 });
  assert.equal(all.length, 3);
  assert.ok(all.every(item => item.label !== 'COMMENT_PUBLIC_REPLY'));
});

test('kho ví dụ: tìm tin gần nhất theo n-gram (chịu không dấu), bỏ chính tin đang đo, không lặp câu trùng, dưới ngưỡng thì rỗng', () => {
  assert.equal(bank.size, 7, 'SKIP không vào kho');
  const near = nearestExamples(bank, { text: 'trong tui co chia tui nho ko', k: 3 });
  assert.equal(near[0].label, 'PACKAGING_INFO');
  const excluded = nearestExamples(bank, { text: 'Dạng túi nhỏ em ơi', excludeId: 'a', source: 'inbox' });
  assert.ok(excluded.length && excluded.every(item => item.text !== 'Dạng túi nhỏ em ơi'), 'bỏ chính tin đang đo');
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
