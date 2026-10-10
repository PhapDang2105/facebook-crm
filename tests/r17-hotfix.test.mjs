// Vòng 17 (10/10) — sửa khẩn hai lỗi do bản 09/10 (3dfc9d5) gây ra, câu khách thật từ r17 out-inbox1/2/5.
// 1. prep() của rule-intent dùng \b sau "t"/"b" viết tắt: \b coi chữ có dấu là biên → "3 túi" thành "3 túiúi", luật giỏ/giá hụt.
// 2. Mẫu DISCOUNT_OATS_GIFT trong Cài đặt máy chủ còn {oats_gift} (quà yến mạch đã bỏ) → fill() bỏ dòng đầu: bot im / chỉ gửi giỏ.
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { core, prepRuleText, ruleIntent } from '../app/processing/rule-intent.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';
import { templates, basket, VANG } from './helpers/r13-engine-sim.mjs';

const female = { customer: { gender: 'female' } };
const text = reply => (reply.messages || []).join('\n');
// Lời DISCOUNT_OATS_GIFT đang chạy trên máy chủ (r17/settings.json, 10/10).
const LIVE_DISCOUNT = 'Dạ giá combo bên em đã là giá tốt nhất rồi nên em không giảm thêm được ạ 💛[?enough] Em xin tặng thêm {title} {oats_gift} làm quà ạ 🎁[/?][?invite] {Title} lấy từ combo 2 túi ({two_price}, miễn phí vận chuyển) là em tặng thêm {oats_gift} làm quà nha ạ 🌾[/?]\nGiỏ của mình: {cart} – {total} ạ.';

test('1. "N túi/bịch" có dấu không bị nhân đôi chữ; "2t"/"3b" viết tắt vẫn đọc ra túi/bịch', () => {
  for (const [raw, word] of [['Lấy 3 túi xanh bao nhiêu tiền', 'tui'], ['2 bịch xanh', 'bich'], ['tặng 2 bát hả shop', 'bat'], ['dùng được 6 tháng không', 'thang']]) {
    const s = core(prepRuleText(raw));
    assert.match(s, new RegExp(`\\b${word}\\b`), `${raw} → ${s}`);
    assert.doesNotMatch(s, /tuiui|bichich|bichat|tuihang/, `${raw} → ${s}`);
  }
  assert.match(core(prepRuleText('Lấy 2t xanh')), /\b2 tui xanh\b/);
  assert.match(core(prepRuleText('3b vàng nha')), /\b3 bich vang\b/);
});

test('1. luật lại bắt câu "N túi" có dấu như trước 09/10 (dữ liệu thật 09/10 09:51 → 10/10)', () => {
  const ctx = { source: 'inbox', botLastTemplateId: '', botLastAgeMin: Infinity, bundleSize: 1, experimentalRules: 'on' };
  for (const raw of ['Cho mình 3 túi', 'Gửi mình combo 2 túi nhé', 'Giá bao nhiêu 1 túi vậy shop']) {
    assert.ok(ruleIntent(raw, ctx), raw);
    // Câu không dấu luôn bắt được → câu có dấu phải ra cùng luật.
    assert.equal(ruleIntent(raw, ctx)?.rule, ruleIntent(raw.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd'), ctx)?.rule, raw);
  }
});

test('2. DISCOUNT_OATS_GIFT lời cũ còn {oats_gift}: chưa có giỏ vẫn trả lời "không giảm" + mời combo 2 (không im)', () => {
  const reply = renderChatbotReply({ template_id: 'DISCOUNT_OATS_GIFT' }, { ...templates, DISCOUNT_OATS_GIFT: LIVE_DISCOUNT }, { ...female, messageText: 'Chị định mua 3 combo, nhưng còn đắt quá' });
  assert.equal(reply.templateId, 'DISCOUNT_OATS_GIFT');
  assert.match(text(reply), /giá tốt nhất/);
  assert.match(text(reply), /combo 2 túi/);
  assert.doesNotMatch(text(reply), /yến mạch|oats_gift/);
});

test('2. DISCOUNT_OATS_GIFT lời cũ khi giữ 3 Túi Vàng: có câu "không giảm" chứ không chỉ "Giỏ của mình…"', () => {
  const reply = renderChatbotReply({ template_id: 'DISCOUNT_OATS_GIFT' }, { ...templates, DISCOUNT_OATS_GIFT: LIVE_DISCOUNT }, { ...female, messageText: 'K có giảm 7%?', pendingOrder: basket([VANG(3)]) });
  assert.match(text(reply), /giá tốt nhất/);
  assert.match(text(reply), /Giỏ của mình: 3 Granola Túi Vàng 350g – 447\.000đ/);
  assert.doesNotMatch(text(reply), /yến mạch|tặng thêm/);
});
