import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Chủ shop 01/10: quà không đổi sang món khác (khách xin "đổi lấy 2 bát" bị bot đáp "Dạ được ạ" → hiểu nhầm là đồng ý);
// chỉ được thay quà bát/quạt/muỗng bằng 2 gói granola nhỏ.
test('mẫu GIFT_SWAP không mở đầu bằng lời đồng ý và nói rõ không đổi sang món khác', () => {
  const seed = JSON.parse(readFileSync(new URL('../app/chatbot-templates.seed.json', import.meta.url), 'utf8'));
  const engine = readFileSync(new URL('../app/chatbot-engine.mjs', import.meta.url), 'utf8');
  for (const text of [seed.GIFT_SWAP, engine.match(/GIFT_SWAP: '([^']+)'/)[1]]) {
    assert.doesNotMatch(text, /^Dạ được/);
    assert.match(text, /không đổi sang bát, quạt hay món khác/);
    assert.match(text, /2 gói granola nhỏ/);
  }
});
