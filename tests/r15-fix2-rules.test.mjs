// Vòng 15 — r15-fix2: sửa theo phản biện luật (scratchpad r15/review-rules.md). Câu là câu khách thật (tập nhãn r13, r15
// out-inbox*) hay câu đối kháng của phản biện (adv-cases.txt / engine-probe.mjs); không tên khách, không SĐT thật.
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { commentBasket } from '../app/chatbot-engine.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { describeDeliveryAddress } from '../app/processing/locations.mjs';
import { nguyenBanMeansXanh, phoneLooksShort } from '../app/chatbot-templates.mjs';
import { mergeChatbotSettingsPatch, normalizeChatbotSettings, normalizeCandidateRules } from '../app/chatbot-settings.mjs';
import { Sim, XANH, basket } from './helpers/r13-engine-sim.mjs';

const MIN = 60 * 1000;
const inbox = extra => ({ source: 'inbox', botLastTemplateId: '', botLastAgeMin: Infinity, bundleSize: 1, commentBasket, experimentalRules: 'on', ...extra });
const held = extra => inbox({ hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 2, basketCodeCount: 1, ...extra });
const menu = id => inbox({ botLastTemplateId: id, botLastAgeMin: 2 });
const tpl = result => result?.value?.also || result?.value?.template_id || null;

test('#1 DISCOUNT_ASK: "mắc ca" (hạt), bớt đường/ngọt, giảm cân/mỡ, bớt số túi, khách quen không xin giảm, voucher live → không bắt', () => {
  // Câu thật tập nhãn r13.
  assert.notEqual(ruleIntent('Lấy c loại ít hạt mac ca nja', held())?.rule, 'DISCOUNT_ASK');
  assert.equal(tpl(ruleIntent('Loại nào có nhiều loại hạt mắc ca và hạt diều ạ', inbox())), 'INGREDIENTS_ALLERGY');
  assert.notEqual(ruleIntent('Uh! Thế đạt trên live để dc giảm cho c\nThì e điều chỉnh lại giúp c', inbox())?.rule, 'DISCOUNT_ASK');
  // Câu đối kháng của phản biện (engine-probe B1–B6, adv-cases).
  const not = ['có loại nào bớt đường không', 'granola bớt ngọt được không', 'Bớt ngọt chút được ko shop', 'ăn granola có giảm được cân không',
    'có giảm được mỡ bụng không', 'khách quen nè', 'Khách quen nè shop', 'chị là khách quen, cho chị 2 túi xanh như cũ', 'Khách quen lấy 3 túi vàng',
    'khách cũ đặt tiếp 2 túi xanh', 'Mình khách cũ nè, gửi địa chỉ cũ nha', 'giảm đi 1 túi', 'giảm bớt 1 túi', 'Giảm cho mình còn 2 túi', 'giảm còn 2 túi thôi',
    'ban cho c 2 tui 123 le loi', 'giảm ít ngọt được không', 'có bớt hạt được không', 'bớt nho khô được không', 'mình muốn bớt nho khô', 'Granola không bột hả'];
  for (const text of not) for (const ctx of [inbox(), held(), held({ basketCodeCount: 1 })]) assert.notEqual(ruleIntent(text, ctx)?.rule, 'DISCOUNT_ASK', text);
  // "chị là khách quen, cho chị 2 túi xanh như cũ": luật giỏ chạy (không trả lời giảm giá).
  // Mặc cả thật vẫn bắt.
  for (const text of ['3 tui ban cho e 400 c nha', 'Khách quen có giảm bớt k?', 'khách quen giảm chút đi em', 'cho mặc cả không shop', 'bớt chút đi em', '350k được không']) {
    assert.equal(ruleIntent(text, inbox())?.rule, 'DISCOUNT_ASK', text);
  }
});

test('#2 BOUGHT_ELSEWHERE: khiếu nại / câu nhiều ý không bị nuốt; câu ngắn "đã mua trên sàn rồi" vẫn bắt', () => {
  for (const text of ['mua trên shopee rồi mà bị mốc', 'đặt shopee rồi mà shop gửi nhầm vị', 'mình đặt trên shopee rồi nhưng muốn đặt ở đây cho nhanh',
    'Mình đặt trên tiktok rồi. Mà shop có bán hạt điều không', 'Mình mua trên tiktok rồi mà túi bị ỉu', 'mua tiktok rồi ăn bị hôi dầu', 'mình mua shopee rồi bị bể túi',
    'đặt trên tiktok rồi mà lỡ đặt nhầm', 'mình mua trên shopee rồi, ở đây có rẻ hơn không', 'Chị đặt ấp 3 rồi']) {
    for (const ctx of [inbox(), held()]) {
      const result = ruleIntent(text, ctx);
      assert.notEqual(result?.rule, 'BOUGHT_ELSEWHERE', text);
      assert.ok(!result?.clearBasket || result.rule === 'CANCEL_BASKET', `${text} ${JSON.stringify(result)}`);
    }
  }
  // Khiếu nại hàng sàn: tra đơn + thẻ như bản cũ.
  const mold = ruleIntent('mua trên shopee rồi mà bị mốc', inbox());
  assert.equal(tpl(mold), 'ORDER_STATUS');
  assert.equal(mold.attention, true);
  for (const text of ['Mình đặt của shop trên tiktok rồi', 'mình mua trên shopee rồi nhé', 'Mình chốt đơn trên tiktok rồi nha shop', 'mình mua bên sàn rồi']) {
    assert.equal(ruleIntent(text, held())?.rule, 'BOUGHT_ELSEWHERE', text);
  }
});

test('#3 NO_EAT: "dị ứng …" / thành phần không có trong granola → INGREDIENTS_ALLERGY (không "cả 3 túi đều có đậu phộng")', () => {
  for (const text of ['bé dị ứng đậu phộng có ăn được không', 'bé dị ứng đậu phộng', 'mình bị dị ứng hạt điều']) {
    const result = ruleIntent(text, inbox());
    assert.notEqual(result?.rule, 'NO_VARIANT', text);
    assert.equal(tpl(result), 'INGREDIENTS_ALLERGY', text);
  }
  assert.notEqual(ruleIntent('đậu phộng không ăn được', inbox())?.value?.values?.ingredient, 'đậu phộng');
  // Thành phần có thật vẫn NO_VARIANT (ca thật …350724).
  assert.equal(ruleIntent('vậy chị cảm ơn có trái cây sấy không ăn đc', inbox({ botLastTemplateId: 'NO_ADDED_SUGAR', botLastAgeMin: 2 }))?.rule, 'NO_VARIANT');
  assert.equal(ruleIntent('mình đang kiêng ăn hạt', inbox())?.value?.values?.ingredient, 'hạt');
});

test('#4 nguyenBanMeansXanh: "nguyên bản" thuộc cụm Vàng / bị phủ định / không có số túi riêng → không thêm Xanh', () => {
  for (const text of ['Lấy 1 túi vàng 350g nguyên bản nha', '1 túi vàng nhiều hạt nguyên bản', '1 túi vàng thôi, không lấy nguyên bản', 'túi vàng, nguyên bản nhé']) {
    assert.equal(nguyenBanMeansXanh(text), 0, text);
  }
  assert.equal(nguyenBanMeansXanh('Cho mình 1 túi nguyên bản và 1 túi vàng nhiều hạt nhé'), 1);
  assert.equal(nguyenBanMeansXanh('1 túi vàng và 1 túi nguyên bản'), 1);
});

test('#4b engine: "Lấy 1 túi vàng 350g nguyên bản nha" → giỏ chỉ 1 Vàng, không hỏi lại nguyên bản; ca thật vẫn 1 Xanh + 1 Vàng', async () => {
  for (const [text, llm, want] of [
    ['Lấy 1 túi vàng 350g nguyên bản nha', { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1' }, [['GRA-VANG-H350', 1]]],
    ['1 túi vàng thôi, không lấy nguyên bản', { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1' }, [['GRA-VANG-H350', 1]]],
    ['Cho mình 1 túi nguyên bản và 1 túi vàng nhiều hạt nhé', { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1' }, [['GRA-VANG-H350', 1], ['GRA-XANH-Z450', 1]]]
  ]) {
    const sim = new Sim({ psid: `fix2-nb-${want.length}-${text.length}` });
    const box = sim.inbox({ gender: 'female' });
    const turn = await sim.send(box, text, { llm });
    const items = (box.pendingOrder?.items || []).map(item => [item.code, item.quantity]).sort();
    assert.deepEqual(items, want, `${text} ${JSON.stringify(turn.sent)}`);
    assert.notEqual(turn.result.templateId, 'ASK_FLAVOR_NGUYENBAN', text);
  }
});

test('#5 địa chỉ: số nhà thuần + tên đường trùng tên phường/xã → không đoán; "142f3 Bắc Cường Lào Cai" vẫn đoán', () => {
  for (const text of ['20 Hoàng Liên Lào Cai', '102 Hùng Vương Phú Thọ']) assert.ok(!describeDeliveryAddress(text).resolved?.ward, text);
  assert.equal(describeDeliveryAddress('142f3 Bắc Cường Lào Cai').resolved?.ward?.name, 'Phường Bắc Cường');
});

test('#6 FLAVOR_ANSWER sau bảng nhiều vị: câu hỏi không "?" ("Túi xanh à", "túi xanh còn", "túi nâu cho con") không lên giỏ', () => {
  for (const last of ['GENERAL_INFO', 'LIVESTREAM_COMMENT', 'FREESHIP_POLICY']) {
    for (const text of ['Túi xanh à', 'túi xanh còn', 'túi xanh còn k', 'túi nâu cho con', 'Túi vàng thì sao', 'túi xanh hả shop']) {
      assert.notEqual(ruleIntent(text, menu(last))?.rule, 'FLAVOR_ANSWER', `${last} ${text}`);
    }
    assert.equal(tpl(ruleIntent('túi nâu cho con', menu(last))), 'KIDS_FAMILY', last);
    assert.equal(ruleIntent('Túi xanh nha', menu(last))?.rule, 'FLAVOR_ANSWER', last);
  }
  // Bot vừa HỎI vị: "Túi xanh ak" (tập nhãn r13, ORDER_ADDRESS) vẫn là lời đáp.
  assert.equal(ruleIntent('Túi xanh ak', menu('ASK_FLAVOR'))?.rule, 'FLAVOR_ANSWER');
});

test('#7a TROPICAL: đang giữ giỏ, "đổi sang túi có dâu luôn" / "chỉ lấy túi dâu" / "Lấy túi dâu thôi" → giỏ thành Tropical', async () => {
  for (const text of ['đổi sang túi có dâu luôn', 'chỉ lấy túi dâu', 'Lấy túi dâu thôi']) {
    const result = ruleIntent(text, held());
    assert.equal(result?.value?.template_id, 'ORDER_ADDRESS', text);
    assert.match(result.value.Product_N1, /Tropical/);
    assert.ok(!result.value.add_to_basket, text);
  }
  const sim = new Sim({ psid: 'fix2-trop-switch' });
  const box = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 1 * MIN, pendingOrder: basket([XANH(3)], 2 * MIN) });
  await sim.send(box, 'chỉ lấy túi dâu', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Tropical vị Cacao 300g' } });
  const items = box.pendingOrder?.items || [];
  assert.ok(items.length === 1 && /Tropical/.test(items[0].product), JSON.stringify(items));
});

test('#7b PRICE_SHIP_EXPLAIN: "174k mà sao giờ 189k đắt hơn vậy" → giải thích 174k + ship; gói nhỏ / túi zip vẫn không', () => {
  const quote = inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastAgeMin: 2 });
  assert.equal(ruleIntent('174k mà sao giờ 189k đắt hơn vậy', quote)?.rule, 'PRICE_SHIP_EXPLAIN');
  assert.notEqual(ruleIntent('Đắt hơn túi zip à shop\nTúi zip 450g mà 189.000(đã có ship)', quote)?.rule, 'PRICE_SHIP_EXPLAIN');
});

test('#7c K3B: "Mua 2 túi shop ơi", "Mua 6 gói", "Lấy 2 túi" sau đơn 1 Nâu → không ghi đè số lượng; "Số lượng là 2", "2 túi" vẫn sửa', () => {
  const order = extra => inbox({ hasRecentOrder: true, orderAgeMin: 5, botLastTemplateId: 'ORDER_CONFIRMATION', botLastAgeMin: 5, recentOrderItems: [{ code: 'GRA-NAU-C350', quantity: 1 }], recentOrderByBot: true, ...extra });
  for (const text of ['Mua 2 túi shop ơi', 'Mua 2 túi nhé shop', 'Mua 6 gói', 'Cho mình 2 goi', 'Lấy 2 túi', 'Đặt 3 bịch']) assert.notEqual(ruleIntent(text, order())?.rule, 'K3B_QTY_ORDER', text);
  for (const [text, quantity] of [['Số lượng là 2', 2], ['2 túi', 2], ['lấy 2 thôi', 2]]) assert.equal(ruleIntent(text, order())?.setQuantity, quantity, text);
});

test('#7d "10xanh" không tự hiểu 10 túi lớn Xanh', () => {
  assert.notEqual(ruleIntent('10xanh', inbox())?.rule, 'BASKET');
  assert.equal(ruleIntent('2xanh+1vàng', inbox())?.rule, 'BASKET');
});

test('#7e candidateRules: vá đối tượng lên cờ chuỗi giữ chế độ chuỗi cho khoá không vá; khoá không phân biệt hoa thường', () => {
  const merged = mergeChatbotSettingsPatch({ candidateRules: 'on' }, { candidateRules: { K5: 'off' } });
  assert.deepEqual(normalizeChatbotSettings(merged).candidateRules, { K1: 'on', K1b: 'on', K3: 'on', K4: 'on', K5: 'off' });
  assert.deepEqual(normalizeCandidateRules({ k1: 'on', K1B_SHORT_PRICE_HELD: 'off' }), { K1: 'on', K1b: 'off', K3: 'shadow', K4: 'shadow', K5: 'shadow' });
  const merged2 = mergeChatbotSettingsPatch({ candidateRules: { K1: 'on', K3: 'on' } }, { candidateRules: { k3: 'off' } });
  assert.deepEqual(normalizeChatbotSettings(merged2).candidateRules, { K1: 'on', K1b: 'shadow', K3: 'off', K4: 'shadow', K5: 'shadow' });
});

test('#7f phoneLooksShort: số tài khoản / mã vận đơn 9 số không phải SĐT thiếu số', () => {
  for (const text of ['stk 091234567', 'số tài khoản 091234567', 'mã vận đơn 091234567', 'mvđ 091234567', 'ck rồi nha 091234567']) assert.equal(phoneLooksShort(text), '', text);
  assert.equal(phoneLooksShort('Dt. 091234567'), '091234567');
});
