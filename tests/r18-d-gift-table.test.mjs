// Vòng 18 — gói D: bảng quà gửi khách (GIFT_POLICY / GIFT_POLICY_ORDER_NONE) không lộ mã SKU thô, không ghi "(chỉ khách
// livestream)", khách thường không thấy dòng Quạt live (inbox1 V5, inbox2 V2, inbox3 V3, inbox4 V2).
// Câu thật: …2484232 [10-11 11:38] "3 túi có được tặng gì không", …04977668 [23:15] "C lấy 2 goi tặng bát dừa và muỗng nhe" →
// "• Quạt: từ 2 sản phẩm (trừ Granola Tropical…, CB10-NAU-G35, CB10-MIX…) (chỉ khách livestream) • 1 Túi Vàng 350g: đúng 5 sản phẩm".
// Gốc: pricing.mjs describeGiftTable lọc `findProductBySku(sku)?.active !== false` → SKU không còn trong danh mục (undefined) lọt và in
// nguyên mã; bảng viết cho mô hình được in thẳng cho khách.
import './helpers/seed-catalog.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { describeGiftTable } from '../app/processing/pricing.mjs';
import { renderChatbotReply, renderOrderGiftReply } from '../app/chatbot-templates.mjs';
import { templates } from './helpers/r13-engine-sim.mjs';
import { reloadCatalog } from '../app/processing/catalog.mjs';

// Danh mục giống máy chủ: Combo 10 gói Nâu / Mix đã XOÁ khỏi products.json (không chỉ tắt) mà bảng quà còn ghi trong "trừ".
function dropProducts(skus) {
  const file = process.env.PRODUCTS_PATH;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(data) ? data : data.items || data.products;
  const kept = list.filter(item => !skus.includes(item.sku));
  writeFileSync(file, JSON.stringify(Array.isArray(data) ? kept : { ...data, [data.items ? 'items' : 'products']: kept }));
  reloadCatalog();
}

test('R18 D: bảng quà không in mã SKU của sản phẩm đã xoá khỏi danh mục (CB10-NAU-G35, CB10-MIX)', () => {
  dropProducts(['CB10-NAU-G35', 'CB10-MIX']);
  const table = describeGiftTable().join('\n');
  assert.doesNotMatch(table, /CB10-|[A-Z]{2,}\d*-[A-Z0-9]+-/, table);
  const policy = renderChatbotReply({ template_id: 'GIFT_POLICY' }, templates, { livestream: true, messageText: '3 túi có được tặng gì không' }).messages.join('\n');
  assert.doesNotMatch(policy, /CB10-|MIX5-|NGHE-H/, policy);
});

test('R18 D: GIFT_POLICY cho khách — không "(chỉ khách livestream)"; khách thường không thấy Quạt; khách live thấy Quạt', () => {
  const plain = renderChatbotReply({ template_id: 'GIFT_POLICY' }, templates, { messageText: '3 túi có được tặng gì không' }).messages.join('\n');
  assert.doesNotMatch(plain, /livestream/i, plain);
  assert.doesNotMatch(plain, /Quạt/, plain);
  assert.match(plain, /Bộ bát gáo dừa \+ Muỗng dừa: từ 3 sản phẩm/);
  const live = renderChatbotReply({ template_id: 'GIFT_POLICY' }, templates, { livestream: true, messageText: '3 túi có được tặng gì không' }).messages.join('\n');
  assert.doesNotMatch(live, /livestream/i, live);
  assert.match(live, /• Quạt: từ 2 sản phẩm \(trừ Granola Tropical/);
  // Bảng cho mô hình (describeGiftTable mặc định) vẫn ghi rõ đối tượng quà live.
  assert.ok(describeGiftTable().some(line => line.startsWith('- Quạt:') && line.endsWith('(chỉ khách livestream)')));
});

test('R18 D: GIFT_POLICY_ORDER_NONE (đơn không quà hiện vật) cũng dùng bảng cho khách', () => {
  const reply = renderOrderGiftReply(templates, { recentOrder: { id: 'o1', createdAt: Date.now(), products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1 }], gift: '' } });
  const text = reply.messages.join('\n');
  assert.doesNotMatch(text, /livestream|Quạt/i, text);
});
