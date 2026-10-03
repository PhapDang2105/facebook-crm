import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Chủ shop 01/10: mẫu GIFT_SWAP không mở đầu bằng "Dạ được" (khách xin "đổi lấy 2 bát" hiểu nhầm là đồng ý).
// R14 (chủ shop 03/10): đổi quà → ghi chú đơn, xin bộ phận phụ trách cho phép đổi, nhắn khách sau; không hứa 2 gói nhỏ.
test('mẫu GIFT_SWAP không mở đầu bằng lời đồng ý, không hứa quà thay, nói rõ ghi chú + xin bộ phận phụ trách', () => {
  const seed = JSON.parse(readFileSync(new URL('../app/chatbot-templates.seed.json', import.meta.url), 'utf8'));
  const engine = readFileSync(new URL('../app/chatbot-engine.mjs', import.meta.url), 'utf8');
  for (const text of [seed.GIFT_SWAP, engine.match(/GIFT_SWAP: '([^']+)'/)[1]]) {
    assert.doesNotMatch(text, /^Dạ được/);
    assert.doesNotMatch(text, /2 gói granola nhỏ/);
    assert.match(text, /ghi chú vào đơn hàng/);
    assert.match(text, /bộ phận phụ trách cho phép đổi sang phần quà khác/);
  }
});
