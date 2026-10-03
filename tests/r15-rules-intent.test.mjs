// Vòng 15 (03/10) — agent "rules": luật nhận ý (rule-intent.mjs), luồng đơn (order-flow.mjs), địa chỉ (locations.mjs).
// Mọi câu là câu khách thật 02–03/10 (r15 out-inbox1..4, out-comments); không tên khách, không SĐT thật.
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { commentBasket } from '../app/chatbot-engine.mjs';
import { candidateRuleMode, LIVE_FEEDBACK, core, ruleIntent } from '../app/processing/rule-intent.mjs';
import { collectAddressBurst, mentionsOldAddress, orderFlowStep } from '../app/processing/order-flow.mjs';
import { describeDeliveryAddress } from '../app/processing/locations.mjs';

const inbox = extra => ({ source: 'inbox', botLastTemplateId: '', botLastAgeMin: Infinity, bundleSize: 1, commentBasket, experimentalRules: 'on', ...extra });
const held = extra => inbox({ hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 2, basketCodeCount: 1, ...extra });
const tpl = result => result?.value?.also || result?.value?.template_id || null;
const PHONE = '0912345678';
// Bot vừa gửi bảng giá 10 phút trước (không "fresh"): luật ứng viên K1 mới là luật bắt câu hỏi giá cụt.
const STALE = { botLastTemplateId: 'PRICE_QUOTE', botLastAgeMin: 10 };

test('#1 "Bột ngũ cốc…" không phải chửi "bot ngu" → không CSKH_HANDOFF; câu chửi thật vẫn chuyển người', () => {
  for (const text of ['Bột ngũ cốc Nghệ Lành giá sao', 'bột ngũ cốc đó bao nhiêu 1 hộp']) {
    for (const ctx of [inbox(), inbox({ botLastTemplateId: 'OTHER_PRODUCTS', botLastAgeMin: 2 })]) {
      const result = ruleIntent(text, ctx);
      assert.notEqual(result?.rule, 'COMPLAINT_HANDOFF', `${text} ${JSON.stringify(result)}`);
      assert.notEqual(tpl(result), 'CSKH_HANDOFF', text);
    }
  }
  for (const text of ['bot ngu quá', 'Bot ngu vậy']) assert.equal(ruleIntent(text, inbox())?.rule, 'COMPLAINT_HANDOFF', text);
});

test('#2 "Mình đặt của shop trên tiktok rồi" (…659307, đang giữ 2 Xanh) → BOUGHT_ELSEWHERE, bỏ giỏ; câu hỏi / than đơn sàn thì không', () => {
  for (const text of ['Mình đặt của shop trên tiktok rồi', 'mình mua trên shopee rồi nhé']) {
    const result = ruleIntent(text, held());
    assert.equal(result?.rule, 'BOUGHT_ELSEWHERE', text);
    assert.equal(result.value.template_id, 'BOUGHT_ON_MARKETPLACE');
    assert.equal(result.clearBasket, true);
    assert.ok(!result.attention, text);
    assert.equal(ruleIntent(text, inbox())?.rule, 'BOUGHT_ELSEWHERE', `${text} (không giỏ)`);
  }
  // Hỏi có bán trên sàn không: không tra đơn, không BOUGHT_ELSEWHERE.
  const ask = ruleIntent('mua trên shopee được không', inbox());
  assert.notEqual(ask?.rule, 'BOUGHT_ELSEWHERE');
  assert.notEqual(tpl(ask), 'ORDER_STATUS', JSON.stringify(ask));
  // Đơn sàn chưa tới / hỏi giao tới đâu: tra đơn như cũ.
  assert.equal(tpl(ruleIntent('Mình đặt trên shopee rồi mà chưa nhận được hàng', inbox())), 'ORDER_STATUS');
  assert.equal(tpl(ruleIntent('Đặt trên ap r nhưng làm sao để biết hàng giao tới đâu r', inbox())), 'ORDER_STATUS');
  // Kể lần trước rồi muốn mua thêm ở đây: không bỏ giỏ.
  assert.notEqual(ruleIntent('lần trước mua shopee rồi giờ lấy thêm 2 túi xanh', inbox())?.rule, 'BOUGHT_ELSEWHERE');
});

test('#3 K3b: đơn bot 1 Nâu 2 phút, "Số lượng là 2" (…068500) → ORDER_UPDATE + setQuantity 2 (luật ổn định, không qua cờ ứng viên)', () => {
  const order = extra => inbox({ hasRecentOrder: true, orderAgeMin: 2, botLastTemplateId: 'ORDER_CONFIRMATION', botLastAgeMin: 2, recentOrderItems: [{ code: 'GRA-NAU-Z350', quantity: 1 }], recentOrderByBot: true, candidateRules: 'off', ...extra });
  const result = ruleIntent('Số lượng là 2', order());
  assert.equal(result?.rule, 'K3B_QTY_ORDER');
  assert.equal(result.value.template_id, 'ORDER_UPDATE');
  assert.equal(result.setQuantity, 2);
  assert.ok(!result.shadowOnly && !result.candidate);
  // Cùng số lượng đơn / đơn > 60 phút / đơn hai mã / đơn nhân viên / thiếu recentOrderItems / câu hỏi → không áp.
  assert.notEqual(ruleIntent('Số lượng là 1', order())?.rule, 'K3B_QTY_ORDER');
  assert.notEqual(ruleIntent('Số lượng là 2', order({ orderAgeMin: 75 }))?.rule, 'K3B_QTY_ORDER');
  assert.notEqual(ruleIntent('Số lượng là 2', order({ recentOrderItems: [{ code: 'GRA-NAU-Z350', quantity: 1 }, { code: 'GRA-XANH-Z450', quantity: 1 }] }))?.rule, 'K3B_QTY_ORDER');
  assert.notEqual(ruleIntent('Số lượng là 2', order({ recentOrderByBot: false }))?.rule, 'K3B_QTY_ORDER');
  assert.notEqual(ruleIntent('Số lượng là 2', order({ recentOrderItems: undefined }))?.rule, 'K3B_QTY_ORDER');
  assert.notEqual(ruleIntent('lấy 2 được không?', order())?.rule, 'K3B_QTY_ORDER');
});

test('#4 sau lời chào live / bảng nhiều vị / miễn ship, khách chỉ nêu MỘT màu → chọn vị (ORDER_ADDRESS), không gửi lại bảng giá', () => {
  // …111673: lời chào live → "Túi xanh 450 g" → 1 Túi Xanh.
  const live = ruleIntent('Túi xanh 450 g', inbox({ botLastTemplateId: 'LIVESTREAM_COMMENT', botLastAgeMin: 2, livestream: true }));
  assert.equal(live?.rule, 'FLAVOR_ANSWER', JSON.stringify(live));
  assert.equal(live.value.template_id, 'ORDER_ADDRESS');
  assert.equal(live.value.Product_N1, 'Granola Túi Xanh 450g');
  assert.equal(live.value.No_A, '1');
  // …734430: "2 túi miễn ship k ạ" → "Mình có vị gì ạ" (bảng 3 vị) → "Túi xanh 450g" = 2 Túi Xanh (engine đếm askedBagCount).
  const list = ruleIntent('Mình có vị gì ạ', inbox({ botLastTemplateId: 'FREESHIP_POLICY', botLastAgeMin: 1 }));
  assert.equal(tpl(list), 'GENERAL_INFO');
  const two = ruleIntent('Túi xanh 450g', inbox({ botLastTemplateId: 'GENERAL_INFO', botLastAgeMin: 1, askedBagCount: 2 }));
  assert.equal(two?.rule, 'FLAVOR_ANSWER');
  assert.equal(two.value.No_A, '2');
  assert.equal(ruleIntent('Túi vàng', inbox({ botLastTemplateId: 'FREESHIP_POLICY', botLastAgeMin: 1 }))?.value?.Product_N1, 'Granola Túi Vàng 350g');
  // Hỏi giá / có "?" / đuôi hỏi → vẫn báo giá túi đó (PRICE_ONE), không lên giỏ.
  for (const text of ['túi xanh giá sao', 'Túi xanh?', 'túi xanh hả']) {
    assert.notEqual(ruleIntent(text, inbox({ botLastTemplateId: 'LIVESTREAM_COMMENT', botLastAgeMin: 2 }))?.rule, 'FLAVOR_ANSWER', text);
  }
  // Bình luận dưới live (chủ shop 03/10 #10): "Màu vàng" vẫn đi luật bình luận (bảng giá), không lên giỏ.
  assert.notEqual(ruleIntent('Màu vàng', { ...inbox({ botLastTemplateId: 'LIVESTREAM_COMMENT', botLastAgeMin: 2 }), source: 'comment' })?.rule, 'FLAVOR_ANSWER');
});

test('#5 mặc cả / khách quen xin giảm → DISCOUNT_ASK (DISCOUNT_OATS_GIFT), không PRICE_COUNT; hỏi chương trình chung vẫn DISCOUNT_POLICY', () => {
  for (const text of ['3 tui ban cho e 400 c nha', 'Khong bot à c', 'Trước mình lấy 3 túi xanh rồi. Khách quen có giảm bớt k?', 'Giảm thêm k', 'bớt chút đi em', 'giảm giá cho chị nha']) {
    for (const ctx of [inbox(), held({ basketCodeCount: 1 })]) {
      const result = ruleIntent(text, ctx);
      assert.equal(result?.rule, 'DISCOUNT_ASK', `${text} ${JSON.stringify(result)}`);
      assert.equal(result.value.template_id, 'DISCOUNT_OATS_GIFT');
    }
  }
  assert.equal(tpl(ruleIntent('có chương trình giảm giá không', inbox())), 'DISCOUNT_POLICY');
  assert.equal(tpl(ruleIntent('có giảm giá không em', inbox())), 'DISCOUNT_POLICY');
  // "bớt 1 túi", "bột ngũ cốc" không phải mặc cả.
  assert.notEqual(ruleIntent('bớt 1 túi xanh', held())?.rule, 'DISCOUNT_ASK');
  assert.notEqual(ruleIntent('Bột ngũ cốc giá bao nhiêu', inbox())?.rule, 'DISCOUNT_ASK');
  // PRICE_COUNT đã nêu màu → named (mẫu không hỏi lại vị); chưa nêu → pick.
  assert.equal(ruleIntent('3 túi xanh bao nhiêu', inbox())?.value?.values?.named, '1');
  assert.equal(ruleIntent('3 túi bn', inbox())?.value?.values?.pick, '1');
  // RECOMMEND_BEGINNER không bắt câu đã nêu vị (…937383).
  assert.notEqual(tpl(ruleIntent('ngu coc ca cao loại nào ngon e', inbox())), 'RECOMMEND_BEGINNER');
  assert.equal(tpl(ruleIntent('mới tập ăn thì lấy loại nào', inbox())), 'RECOMMEND_BEGINNER');
});

test('#B mẹ bầu tiểu đường thai kỳ → HEALTH_DIABETES (khuyên hỏi bác sĩ), không gắn thẻ', () => {
  const result = ruleIntent('Bà bầu thai kỳ tiểu đường', inbox());
  assert.equal(tpl(result), 'HEALTH_DIABETES');
  assert.ok(!result.attention);
});

test('#6 LIVE_FEEDBACK nhận "nói nhỏ xíu sao nghe" (…076080); "Ibox" như "ib"', () => {
  for (const text of ['Bán mà nói nhỏ xíu sao nghe', 'Nói nhỏ quá không nghe gì', 'sao nghe được']) assert.ok(LIVE_FEEDBACK.test(core(text)), text);
  assert.ok(!LIVE_FEEDBACK.test(core('túi nhỏ xíu vậy')));
  assert.equal(ruleIntent('Ibox', inbox())?.rule, 'TERSE_PRICE');
});

test('#7 đang giữ 3 Xanh, "Túi có dâu để ăn thử" (…762063) → THÊM 1 Tropical (add_to_basket); không có chữ thử/thêm → chỉ báo giá, không thay giỏ', () => {
  const add = ruleIntent('Túi có dâu  để ăn thử', held());
  assert.equal(add?.rule, 'TROPICAL_ADD', JSON.stringify(add));
  assert.equal(add.value.add_to_basket, '1');
  assert.equal(add.value.No_A, '1');
  assert.match(add.value.Product_N1, /Tropical/);
  const quote = ruleIntent('Túi có dâu', held());
  assert.equal(quote?.value?.template_id, 'PRICE_QUOTE');
  assert.ok(!quote.value.also);
  // Không giữ giỏ: báo giá Tropical như cũ.
  assert.equal(ruleIntent('Túi có dâu để ăn thử', inbox())?.value?.template_id, 'PRICE_QUOTE');
});

test('#8 gom địa chỉ nhiều tin dừng ở "Gửi địa chỉ cũ cho c" (…660136): địa chỉ không chứa "cũ cho c"', () => {
  const now = Date.now();
  const messages = [
    { direction: 'incoming', type: 'text', text: 'Gửi địa chỉ cũ cho c', createdAt: now - 60000 },
    { direction: 'incoming', type: 'text', text: `C Ngọc 142f3 Bắc Cường Lào Cai ${PHONE}`, createdAt: now - 40000 },
    { direction: 'incoming', type: 'text', text: 'Phường Cam Đường', createdAt: now - 10000 }
  ];
  const burst = collectAddressBurst(messages);
  assert.ok(burst, 'vẫn gom hai tin địa chỉ');
  assert.doesNotMatch(burst.text, /cũ cho c|Gửi địa chỉ/i);
  assert.match(burst.text, /Bắc Cường/);
  assert.equal(burst.phone, PHONE);
});

test('#9 "chợ củ/chợ cũ" là tên chợ, không phải "chỗ cũ" (…434300); "chỗ cũ", "địa chỉ cũ", "như cũ" vẫn là địa chỉ cũ', () => {
  const text = `S₫t.${PHONE} chợ củ tinh Biên ang giang`;
  assert.equal(mentionsOldAddress(text), false);
  const flow = orderFlowStep(text, { hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', hasPreviousDelivery: false });
  assert.ok(!flow || !['OLD_ADDRESS', 'OLD_ADDRESS_ASK'].includes(flow.rule), JSON.stringify(flow));
  for (const old of ['gửi về chỗ cũ nha', 'Gửi địa chỉ cũ cho c', 'như cũ nha em', 'địa chỉ như lần trước']) assert.equal(mentionsOldAddress(old), true, old);
  // Giỏ + "về chợ cũ" (địa danh) không phải BASKET_OLD_ADDRESS.
  assert.notEqual(ruleIntent('2 túi xanh về chợ cũ', inbox({ hasPreviousDelivery: true }))?.rule, 'BASKET_OLD_ADDRESS');
});

test('#10 PRICE_SHIP_EXPLAIN không bắt câu so gói nhỏ / túi zip / đắt hơn (…734430); câu 174k vs 189k vẫn bắt', () => {
  assert.notEqual(ruleIntent('Đắt hơn túi zip à shop\nTúi zip 450g mà 189.000(đã có ship)', inbox())?.rule, 'PRICE_SHIP_EXPLAIN');
  assert.equal(ruleIntent('TN trước 1 túi xanh là 174.000₫ mà shop', inbox())?.rule, 'PRICE_SHIP_EXPLAIN');
});

test('#11 NO_VARIANT: "có trái cây sấy không ăn đc" (…350724), kiêng / dị ứng thành phần; câu chê không thuộc luật', () => {
  const result = ruleIntent('vậy chị cảm ơn có trái cây sấy không ăn đc', inbox({ botLastTemplateId: 'NO_ADDED_SUGAR', botLastAgeMin: 2 }));
  assert.equal(result?.rule, 'NO_VARIANT', JSON.stringify(result));
  assert.equal(result.value.values.ingredient, 'trái cây sấy');
  assert.equal(ruleIntent('mình kiêng đậu phộng', inbox())?.value?.values?.ingredient, 'đậu phộng');
  assert.equal(ruleIntent('con dị ứng hạt điều', inbox())?.value?.values?.ingredient, 'hạt điều');
  assert.notEqual(ruleIntent('ăn không được, dở quá', inbox())?.rule, 'NO_VARIANT');
});

test('#12 BASKET bắt "1 xanh+1 nâu" (…958786), "1xanh,1vàng" (…018879)', () => {
  const a = ruleIntent('1 xanh+1 nâu', inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastAgeMin: 3 }));
  assert.equal(a?.rule, 'BASKET');
  assert.deepEqual([a.value.Product_N1, a.value.No_A, a.value.Product_N2, a.value.No_B], ['Granola Túi Xanh 450g', '1', 'Granola Túi Nâu vị cacao 350g', '1']);
  const b = ruleIntent('1xanh,1vàng', inbox({ botLastTemplateId: 'GENERAL_INFO', botLastAgeMin: 3 }));
  assert.equal(b?.rule, 'BASKET');
  assert.deepEqual([b.value.Product_N1, b.value.Product_N2], ['Granola Túi Xanh 450g', 'Granola Túi Vàng 350g']);
});

test('#13 địa chỉ "142f3 Bắc Cường Lào Cai" (không chữ phường, không quận) → Phường Bắc Cường, TP Lào Cai; tên thôn trùng tên phường thì không', () => {
  const resolved = describeDeliveryAddress('142f3 Bắc Cường Lào Cai').resolved;
  assert.equal(resolved?.ward?.name, 'Phường Bắc Cường');
  assert.equal(resolved?.district?.name, 'Thành phố Lào Cai');
  assert.ok(!describeDeliveryAddress('thôn Bắc Cường Lào Cai').resolved?.ward);
});

test('#14 candidateRuleMode: chuỗi áp cả 5 luật; đối tượng theo từng luật (thiếu khoá = shadow); mặc định shadow', () => {
  assert.equal(candidateRuleMode('on', 'K1'), 'on');
  assert.equal(candidateRuleMode('off', 'K5'), 'off');
  assert.equal(candidateRuleMode(undefined, 'K1'), 'shadow');
  assert.equal(candidateRuleMode('lạ', 'K1'), 'shadow');
  const setting = { K1: 'on', K3: 'on', K4: 'on', K5: 'off' };
  assert.equal(candidateRuleMode(setting, 'K1'), 'on');
  assert.equal(candidateRuleMode(setting, 'K1_SHORT_PRICE'), 'on');
  assert.equal(candidateRuleMode(setting, 'K1b'), 'shadow');
  assert.equal(candidateRuleMode(setting, 'K5'), 'off');
  assert.equal(candidateRuleMode({ k3: 'on' }, 'K3'), 'on');
  // Qua ruleIntent: đối tượng {K1:'on'} → K1 trả lời thật; K1b (đang giữ giỏ) vẫn shadow.
  const k1 = ruleIntent('Giá sao', inbox({ ...STALE, candidateRules: setting }));
  assert.equal(k1?.rule, 'K1_SHORT_PRICE');
  assert.ok(!k1.shadowOnly);
  const k1b = ruleIntent('Giá sao', held({ candidateRules: setting, botLastTemplateId: 'ORDER_ADDRESS' }));
  if (k1b?.rule === 'K1B_SHORT_PRICE_HELD') assert.equal(k1b.shadowOnly, true);
  const k3 = ruleIntent('Lấy 2 túi', held({ candidateRules: setting }));
  assert.equal(k3?.rule, 'K3_QTY_HELD');
  assert.ok(!k3.shadowOnly);
  // Chuỗi 'shadow' như cũ: chỉ ghi nhật ký.
  assert.equal(ruleIntent('Giá sao', inbox({ ...STALE, candidateRules: 'shadow' }))?.shadowOnly, true);
});

test('#C K1 không bắt hỏi giá MÓN trong ảnh ("Bn 1 túi này e ơi" sau ảnh, …885410)', () => {
  const on = { candidateRules: { K1: 'on' } };
  assert.notEqual(ruleIntent('Bn 1 túi này e ơi', inbox({ ...STALE, ...on }))?.rule, 'K1_SHORT_PRICE');
  assert.notEqual(ruleIntent('Giá bao nhiêu vậy?', inbox({ ...on, botLastTemplateId: 'IMAGE_RECEIVED', botLastAgeMin: 0.2 }))?.rule, 'K1_SHORT_PRICE');
  assert.notEqual(ruleIntent('Giá bao nhiêu vậy', inbox({ ...STALE, ...on, recentCustomerMedia: true }))?.rule, 'K1_SHORT_PRICE');
  assert.equal(ruleIntent('Giá sao', inbox({ ...STALE, ...on }))?.rule, 'K1_SHORT_PRICE');
});

test('giỏ chờ giữ cờ quà yến mạch (oatsGift) qua normalizePendingOrder / usablePendingOrder; không có cờ thì không thêm', async () => {
  const { normalizePendingOrder, usablePendingOrder } = await import('../app/processing/pending-order.mjs');
  const pending = { items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 2 }], key: 'GRA-XANH-Z450=2', at: Date.now() - 60000, phone: '', address: '', addressAsks: 0, oatsGift: true };
  assert.equal(normalizePendingOrder(pending).oatsGift, true);
  assert.equal(usablePendingOrder(pending, { templateId: 'ORDER_ADDRESS' }).oatsGift, true);
  assert.ok(!('oatsGift' in normalizePendingOrder({ ...pending, oatsGift: undefined })));
  assert.ok(!('oatsGift' in normalizePendingOrder({ ...pending, oatsGift: 'yes' })));
});
