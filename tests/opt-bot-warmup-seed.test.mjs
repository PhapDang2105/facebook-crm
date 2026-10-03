// Tối ưu chatbot (P4/P5): nạp sẵn địa giới + danh mục khi khởi động; mẫu gốc parse một lần, mỗi lần gọi là bản sao riêng.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import './helpers/seed-catalog.mjs';
import { warmUpChatbotModels } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates } from '../app/chatbot-templates.mjs';
import { loadLocationIndex } from '../app/processing/locations.mjs';

test('P4: warmUpChatbotModels nạp sẵn chỉ mục địa giới (lần gọi sau không đọc lại CSV)', async () => {
  await warmUpChatbotModels();
  const started = performance.now();
  const first = loadLocationIndex();
  assert.ok(performance.now() - started < 50, 'đã nạp sẵn');
  assert.ok(first.provinces.length > 30);
  assert.equal(loadLocationIndex(), first);
});

test('P5: defaultMessageTemplates trả đúng tệp mẫu gốc, bản sao riêng mỗi lần (sửa bản này không ảnh hưởng bản sau)', () => {
  const seed = JSON.parse(readFileSync(new URL('../app/chatbot-templates.seed.json', import.meta.url), 'utf8'));
  const first = defaultMessageTemplates();
  assert.deepEqual(first, seed);
  const id = Object.keys(first)[0];
  first[id] = 'đã sửa';
  delete first[Object.keys(first)[1]];
  const second = defaultMessageTemplates();
  assert.notEqual(second, first);
  assert.deepEqual(second, seed);
});
