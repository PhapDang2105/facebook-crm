// Vòng 16 (05/10) — mẫu / danh mục / prompt:
// - VOICE_RECEIVED (inbox5 A6: tin nhắn thoại bị coi là ảnh) — lời dự phòng trong mã + seed + nhóm SUPPORT (không vào ANSWER).
// - PRICE_COUNT cho 2 túi (inbox3: hỏi giá đúng 2 túi không có luật bắt) — mẫu hiện có trả "2 túi … 298.000đ, miễn phí vận chuyển".
// - Combo 10 gói Cam tắt trong seed (chủ shop 03/10: combo 10 gói chỉ còn Xanh).
// - ORDER_UPDATED seed có dòng quà; prompt: "ngũ cốc" không phải tên vị, giá từng loại, tin thoại.
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { readFileSync } from 'node:fs';
import { defaultMessageTemplates, r16FallbackTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';
import { normalizeChatbotSettings } from '../app/chatbot-settings.mjs';
import { groupOf, subGroupOf, fineGroupOf, isIntentionalOther } from '../app/processing/intent-cascade.mjs';
import { templates } from './helpers/r13-engine-sim.mjs';

const female = { customer: { gender: 'female' } };
const text = reply => reply.messages.join('\n');
// Mẫu PRICE_COUNT ĐANG CHẠY trên máy chủ (r16/settings.json, 05/10) — chưa có khối [?named]/[?pick] của R15.
const LIVE_PRICE_COUNT = 'Dạ {count} túi ({kind}) giá {total}[?ship] + phí ship {ship}[/?][?free], miễn phí vận chuyển[/?][?gift], tặng {gift}[/?] ạ 🌾 {Title} lấy {count} túi vị nào để em lên đơn liền cho mình nha?';

test('VOICE_RECEIVED: có trong seed (cùng lời dự phòng), nhóm SUPPORT (không ANSWER), xin khách nhắn chữ', () => {
  const seed = defaultMessageTemplates();
  assert.equal(seed.VOICE_RECEIVED, r16FallbackTemplates.VOICE_RECEIVED);
  assert.equal(seed.VOICE_RECEIVED, 'Dạ em chưa nghe được tin nhắn thoại ạ, {title} nhắn chữ giúp em nha ạ 💛');
  assert.equal(subGroupOf('VOICE_RECEIVED'), null, 'không thuộc nhóm con ANSWER');
  assert.equal(fineGroupOf('VOICE_RECEIVED'), 'SUPPORT');
  assert.equal(groupOf('VOICE_RECEIVED'), 'SUPPORT');
  assert.equal(isIntentionalOther('VOICE_RECEIVED'), false);
  const reply = renderChatbotReply({ template_id: 'VOICE_RECEIVED' }, templates, female);
  assert.equal(reply.templateId, 'VOICE_RECEIVED');
  assert.equal(text(reply), 'Dạ em chưa nghe được tin nhắn thoại ạ, chị nhắn chữ giúp em nha ạ 💛');
  assert.equal(reply.handoff, false);
});

test('VOICE_RECEIVED: bộ mẫu thiếu mã (máy chủ chưa thêm) vẫn trả lời dự phòng; mẫu trống trong Cài đặt là tắt', () => {
  const old = Object.fromEntries(Object.entries(templates).filter(([id]) => id !== 'VOICE_RECEIVED'));
  assert.equal(renderChatbotReply({ template_id: 'VOICE_RECEIVED' }, old, female).templateId, 'VOICE_RECEIVED');
  assert.notEqual(renderChatbotReply({ template_id: 'VOICE_RECEIVED' }, { ...old, VOICE_RECEIVED: '' }, female).templateId, 'VOICE_RECEIVED');
});

test('seed chỉ THÊM mã mới: mẫu đang lưu trong Cài đặt (ORDER_UPDATED cũ không có {gift}) giữ nguyên, VOICE_RECEIVED được thêm', () => {
  const saved = 'Dạ em đã sửa lại đơn cho mình như sau ạ: {total}';
  const normalized = normalizeChatbotSettings({ messageTemplates: { ORDER_UPDATED: saved } });
  const merged = normalized.messageTemplates || normalized.templates || {};
  assert.equal(merged.ORDER_UPDATED, saved);
  assert.equal(merged.VOICE_RECEIVED, r16FallbackTemplates.VOICE_RECEIVED);
  assert.match(defaultMessageTemplates().ORDER_UPDATED, /\[\?gift\]\n🎁 Tặng kèm: \{gift\}\[\/\?\]/);
});

test('PRICE_COUNT 2 túi (giá trị luật đưa vào): "2 túi … 298.000đ, miễn phí vận chuyển" — mẫu seed và mẫu đang chạy', () => {
  const values = { count: '2', kind: 'Granola Túi Xanh 450g', total: '298.000đ', ship: '', free: '1', gift: '', named: '1' };
  const seeded = text(renderChatbotReply({ template_id: 'PRICE_COUNT', values }, templates, female));
  assert.match(seeded, /^Dạ 2 túi \(Granola Túi Xanh 450g\) giá 298\.000đ, miễn phí vận chuyển ạ 🌾/);
  assert.match(seeded, /lấy luôn 2 Granola Túi Xanh 450g/);
  assert.doesNotMatch(seeded, /phí ship|tặng/);
  const picked = text(renderChatbotReply({ template_id: 'PRICE_COUNT', values: { ...values, kind: 'túi Xanh / Vàng mix tùy ý', named: '' } }, templates, female));
  assert.match(picked, /^Dạ 2 túi \(túi Xanh \/ Vàng mix tùy ý\) giá 298\.000đ, miễn phí vận chuyển ạ 🌾 Chị lấy 2 túi vị nào/);
  const live = text(renderChatbotReply({ template_id: 'PRICE_COUNT', values }, { ...templates, PRICE_COUNT: LIVE_PRICE_COUNT }, female));
  assert.match(live, /^Dạ 2 túi \(Granola Túi Xanh 450g\) giá 298\.000đ, miễn phí vận chuyển ạ 🌾/);
});

test('products.seed.json: Combo 10 gói Cam (CB10-CAM-G30) bán lại (R17, chủ shop 10/10), Combo 10 gói Xanh còn bán', () => {
  const products = JSON.parse(readFileSync(new URL('../app/products.seed.json', import.meta.url), 'utf8'));
  const list = Array.isArray(products) ? products : products.items || products.products;
  assert.equal(list.find(item => item.sku === 'CB10-CAM-G30').active, true);
  assert.equal(list.find(item => item.sku === 'CB10-XANH-G35').active, true);
});

test('prompt (docs/system-prompt.txt): "ngũ cốc" không phải tên vị; giá từng loại → GENERAL_INFO; tin thoại → VOICE_RECEIVED', () => {
  const prompt = readFileSync(new URL('../docs/system-prompt.txt', import.meta.url), 'utf8');
  assert.match(prompt, /"Ngũ cốc", "hạt ngũ cốc" không phải tên vị/);
  assert.match(prompt, /Hỏi giá từng loại\/mỗi loại\/các loại, "đồng giá không": GENERAL_INFO/);
  assert.match(prompt, /Tin nhắn thoại\/ghi âm: VOICE_RECEIVED\./);
});
