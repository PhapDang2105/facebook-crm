// Vòng 17 (10/10) — gói C: luật ý định (rule-intent.mjs). Câu khách thật 08–10/10 (r17 out-inbox1..5, out-comments; đã che), không
// tên khách, không SĐT thật. Mã ca rút gọn (…6 số cuối id) trong tên test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, XANH, basket } from './helpers/r13-engine-sim.mjs';
import { commentBasket } from '../app/chatbot-engine.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';

const inbox = extra => ({ source: 'inbox', botLastTemplateId: '', botLastAgeMin: Infinity, bundleSize: 1, commentBasket, experimentalRules: 'on', candidateRules: 'shadow', ...extra });
const held = extra => inbox({ hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 2, basketCodeCount: 1, ...extra });
const tpl = result => result?.value?.template_id || null;
const said = turn => turn.sent.map(item => item.text || '').join('\n');
const MIN = 60 * 1000;
const bot = { sender: 'bot' };

test('inbox5 A5 (…559416, tái diễn r16): "2 túi ạ" + "Có tặng gì kg ạ" (live) → 2 Túi Xanh mặc định + quà theo giỏ, không hỏi vị', async () => {
  const joined = ruleIntent('2 túi ạ\nCó tặng gì kg ạ', inbox({ livestream: true }));
  assert.equal(joined?.rule, 'GIFT_BAGS_DEFAULT_XANH', JSON.stringify(joined));
  assert.deepEqual([joined.value.Product_N1, joined.value.No_A], ['Granola Túi Xanh 450g', '2']);
  const split = ruleIntent('Có tặng gì kg ạ', inbox({ livestream: true, recentCustomerTexts: [{ text: '2 túi ạ', at: Date.now() - MIN }] }));
  assert.equal(split?.rule, 'GIFT_BAGS_DEFAULT_XANH');
  // Không số túi / đã nêu vị / tin số túi quá 10 phút / đang giữ giỏ → hỏi quà như cũ.
  assert.equal(ruleIntent('Có tặng gì kg ạ', inbox({ livestream: true }))?.rule, 'GIFT_QUESTION');
  assert.equal(ruleIntent('Có tặng gì kg ạ', inbox({ recentCustomerTexts: [{ text: '2 túi ạ', at: Date.now() - 20 * MIN }] }))?.rule, 'GIFT_QUESTION');
  assert.equal(ruleIntent('Có tặng gì kg ạ', inbox({ recentCustomerTexts: [{ text: '2 túi vàng', at: Date.now() - MIN }] }))?.rule, 'GIFT_QUESTION');
  assert.notEqual(ruleIntent('2 túi ạ\nCó tặng gì kg ạ', held())?.rule, 'GIFT_BAGS_DEFAULT_XANH');
  const sim = new Sim({ psid: 'r17c-559416' });
  const box = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: Date.now() - 6 * MIN });
  sim.history(box, 'outgoing', 'Dạ chào chị', 6 * MIN, bot);
  sim.history(box, 'incoming', '2 túi ạ', 40e3);
  const turn = await sim.send(box, 'Có tặng gì kg ạ', { llm: { template_id: 'GIFT_POLICY' } });
  assert.match(said(turn), /2 Granola Túi Xanh 450g/, said(turn));
  assert.match(said(turn), /Quạt/);
  assert.doesNotMatch(said(turn), /vị nào/);
});

test('inbox5 A6 (…486347): "Cô lấy ba túi có giảm nửa kô" sau "3 túi vàng, xanh, nâu" → giỏ 1X+1V+1N 442k + "không giảm thêm", không hỏi vị', async () => {
  const recent = [{ text: 'Nếu cô mua 3 túi vàng, xanh, nâu thì giá là bn và có tặng phẩm là gì', at: Date.now() - 6 * MIN }];
  const result = ruleIntent('Cô lấy ba túi có giảm nửa kô', inbox({ livestream: true, recentCustomerTexts: recent }));
  assert.equal(result?.rule, 'DISCOUNT_ASK_NAMED', JSON.stringify(result));
  assert.equal(result.value.also, 'DISCOUNT_OATS_GIFT');
  // Tin trước chỉ 2 màu cho "ba túi" → không đoán; vẫn là mặc cả.
  assert.equal(ruleIntent('Cô lấy ba túi có giảm nửa kô', inbox({ recentCustomerTexts: [{ text: '1 xanh 1 vàng', at: Date.now() - MIN }] }))?.rule, 'DISCOUNT_ASK');
  const sim = new Sim({ psid: 'r17c-486347' });
  const box = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'PRICE_MIX_TUI_LON', botLastReplyAt: Date.now() - 5 * MIN });
  sim.history(box, 'incoming', recent[0].text, 6 * MIN);
  sim.history(box, 'outgoing', 'Dạ bảng giá mix túi lớn ạ', 5 * MIN, bot);
  const turn = await sim.send(box, 'Cô lấy ba túi có giảm nửa kô', { llm: { template_id: 'PRICE_COUNT' } });
  const text = said(turn);
  assert.match(text, /không giảm thêm/);
  assert.match(text, /442\.000đ/);
  assert.doesNotMatch(text, /vị nào|combo 2 túi \(298/);
});

test('inbox2 M7 (…900767) / inbox5 A7 (…547980) / A1: "Tron bộ Ko giảm nữa hả", "Giá cao ha", "Giá hơi đắt" → DISCOUNT_OATS_GIFT', () => {
  for (const text of ['Tron bộ Ko giảm nữa hả', 'Giá cao ha', 'Giá hơi đắt', 'đắt quá shop', 'gia cao qua']) assert.equal(tpl(ruleIntent(text, inbox())), 'DISCOUNT_OATS_GIFT', text);
  // Không phải chê giá / mặc cả.
  for (const text of ['Đặt quá', 'dat qua', 'giá cao hơn shopee', 'Giảm nửa cân được không', 'Đắt', 'giá 174k mà cao vậy']) assert.notEqual(ruleIntent(text, inbox())?.rule, 'PRICE_OBJECTION', text);
  assert.notEqual(tpl(ruleIntent('Giảm nửa cân được không', inbox())), 'DISCOUNT_OATS_GIFT');
});

test('inbox5 A8 (…634783, …094699) / inbox2 M1 (…586397) / M2 (…994812): từng túi, cả 4 loại, "Tc 3 vị", "Màu xanh gói bao nhiêu"', () => {
  for (const text of ['Xin thông tin từng túi', 'Xin gia cua ca 4 loaii', 'cho xin giá các loại']) {
    const result = ruleIntent(text, inbox());
    assert.deepEqual([tpl(result), result?.value?.listAll], ['GENERAL_INFO', '1'], text);
  }
  assert.equal(tpl(ruleIntent('Tc 3 vị thi gia ntn', inbox())), 'PRICE_MIX_TUI_LON');
  assert.equal(tpl(ruleIntent('Trọn bộ giá bao nhiêu', inbox())), 'PRICE_MIX_TUI_LON');
  assert.notEqual(ruleIntent('Tc 3 vị thi gia ntn', held())?.rule, 'PRICE_FULL_SET');
  const xanh = ruleIntent('Màu xanh gói bao nhiêu', inbox());
  assert.deepEqual([tpl(xanh), xanh?.value?.Product_N1], ['PRICE_QUOTE', 'Granola Túi Xanh 450g']);
  assert.notEqual(tpl(ruleIntent('Màu xanh gói', inbox())), 'PRICE_QUOTE');
});

test('inbox5 A9 (…343771) / inbox3 A9 (…140699): xin miễn ship 1 túi → PRICE_ONE_BAG (189k gồm ship, 2 túi 298k) + giữ giỏ 1 túi', async () => {
  for (const text of ['Cho thử 1 túi xanh miễn ship nhé', 'dc miễn ship C ko C đặt 1 dùng thử', 'Mua 1 túi miễn phí sip nha']) {
    const result = ruleIntent(text, inbox());
    assert.equal(result?.rule, 'ONE_BAG_FREESHIP_ASK', text);
    assert.deepEqual(result.holdBasket, { product: 'Granola Túi Xanh 450g', quantity: 1 });
    assert.equal(result.value.values.total, '189.000đ');
  }
  // Câu HỎI chính sách giữ FREESHIP_POLICY; ưu đãi dùng thử / đang giữ giỏ / 2 túi → như cũ.
  for (const text of ['1 túi miễn ship', 'Một túi có miễn Sip không em', 'Một túi miễn sip à']) assert.notEqual(ruleIntent(text, inbox())?.rule, 'ONE_BAG_FREESHIP_ASK', text);
  assert.notEqual(ruleIntent('Cho thử 1 túi xanh miễn ship nhé', inbox({ trialOffer: true }))?.rule, 'ONE_BAG_FREESHIP_ASK');
  assert.notEqual(ruleIntent('Cho thử 1 túi xanh miễn ship nhé', held())?.rule, 'ONE_BAG_FREESHIP_ASK');
  const sim = new Sim({ psid: 'r17c-343771' });
  const turn = await sim.send(sim.inbox(), 'Cho thử 1 túi xanh miễn ship nhé', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1' } });
  assert.match(said(turn), /15\.000đ = 189\.000đ/);
  assert.match(said(turn), /298\.000đ, miễn phí vận chuyển/);
  assert.equal(sim.conversations.get(sim.inboxId).pendingOrder?.items?.[0]?.code, 'GRA-XANH-Z450');
});

test('inbox5 A10 (…501569, …486347): "350 thì bao t" / "450 bao t"; "cách bảo quản và thời hạn sử dụng" → STORAGE + WEIGHT_EXPIRY', () => {
  const x = ruleIntent('450 bao t', inbox());
  assert.deepEqual([tpl(x), x?.value?.Product_N1], ['PRICE_QUOTE', 'Granola Túi Xanh 450g']);
  assert.deepEqual([tpl(ruleIntent('350 thì bao t', inbox())), ruleIntent('350 thì bao t', inbox())?.value?.listAll], ['GENERAL_INFO', '1']);
  const storage = ruleIntent('Cho biết cách bảo quản và thời hạn sử dụng', inbox());
  assert.deepEqual([tpl(storage), storage?.value?.also], ['STORAGE', 'WEIGHT_EXPIRY']);
  assert.equal(ruleIntent('bảo quản thế nào', inbox())?.value?.also, undefined);
});

test('inbox5 A12 (…221709): "chị đặt trên mua hàng rồi" / "trên fb" → tra đơn + thẻ, không "ủng hộ trên sàn"', () => {
  const first = ruleIntent('chị đặt trên mua hàng rồi', inbox());
  assert.deepEqual([first?.rule, tpl(first), first?.attention], ['ORDER_ASK_FACEBOOK', 'ORDER_STATUS', true]);
  const second = ruleIntent('trên fb', inbox({ botLastTemplateId: 'ORDER_STATUS', botLastAgeMin: 1 }));
  assert.deepEqual([tpl(second), second?.attention], ['WAITING_STAFF', true]);
  assert.equal(ruleIntent('trên fb', inbox()), null, 'không ngữ cảnh tra đơn, không động từ đặt → để mô hình');
  assert.equal(tpl(ruleIntent('Mình đặt của shop trên tiktok rồi', inbox())), 'BOUGHT_ON_MARKETPLACE');
});

test('inbox2 C5 (…077228): "Đặt trên shoppe có chuẩn hàng bên mình không ạ" không phải tra đơn', () => {
  for (const text of ['Đặt trên shoppe có chuẩn hàng bên mình không ạ', 'Mua trên shopee có phải hàng chính hãng không']) assert.notEqual(tpl(ruleIntent(text, inbox())), 'ORDER_STATUS', text);
  assert.equal(tpl(ruleIntent('Mình đặt trên shopee rồi sao chưa thấy giao', inbox())), 'ORDER_STATUS');
});

test('inbox1 B3 (…564838, …529162, …717482, …294082): km ≠ thời gian giao; "Hộp 10g nhỏ"; "Túi nhiều hạt" đổi mặc định Xanh; "ck trước" → CSKH', () => {
  assert.notEqual(tpl(ruleIntent('Khi nào có chương trình km shop ới tớ nhá', inbox({ livestream: true }))), 'SHIPPING_POLICY');
  assert.equal(tpl(ruleIntent('Bao lâu thì nhận được hàng', inbox())), 'SHIPPING_POLICY');
  for (const text of ['Hộp 10g nhỏ giá sao', '10g nhỏ giá sao']) assert.equal(ruleIntent(text, inbox())?.value?.Product_N1, 'Combo 10 gói Xanh', text);
  const swap = ruleIntent('Túi nhiều hạt', held({ defaultFlavourSwap: { quantity: 2, target: 'basket' } }));
  assert.deepEqual([swap?.rule, swap?.value?.Product_N1, swap?.value?.No_A], ['DEFAULT_FLAVOUR_SWAP', 'Granola Túi Vàng 350g', '2']);
  assert.notEqual(ruleIntent('Túi nhiều hạt?', held({ defaultFlavourSwap: { quantity: 2, target: 'basket' } }))?.rule, 'DEFAULT_FLAVOUR_SWAP');
  // Quyết định chủ shop 10/10 mục 6: muốn chuyển khoản trước → CSKH + thẻ, không gửi STK / câu COD.
  for (const text of ['Minh ck trước', 'Cho chị stk chị ck luôn nha', 'chuyển khoản trước được không em']) {
    const result = ruleIntent(text, held());
    assert.deepEqual([tpl(result), result?.attention], ['CSKH_HANDOFF', true], text);
  }
  assert.notEqual(tpl(ruleIntent('Chị ck rồi nhé', held())), 'CSKH_HANDOFF');
});

test('inbox3 A7 (…731359): "Không\\nChị bị nhầm" khi có giỏ Shop → xoá giỏ (ORDER_POSTPONED); "Không nhầm đâu" thì không', () => {
  assert.equal(ruleIntent('Không\nChị bị nhầm', inbox({ shopCart: true }))?.rule, 'CANCEL_BASKET_MISCLICK');
  assert.notEqual(ruleIntent('không nhầm đâu', inbox({ hasBasket: true }))?.rule, 'CANCEL_BASKET_MISCLICK');
});

test('inbox2 C3 (…591700): "Uh em" sau TROPICAL_CONFIRM → bảng giá Tropical; "xanh lá" → Túi Xanh; "vàng" thì không', () => {
  const ctx = inbox({ botLastTemplateId: 'TROPICAL_CONFIRM', botLastAgeMin: 1 });
  assert.equal(ruleIntent('Uh em', ctx)?.value?.Product_N1, 'Granola Tropical vị Cacao 300g');
  assert.equal(ruleIntent('xanh lá nha', ctx)?.value?.Product_N1, 'Granola Túi Xanh 450g');
  assert.notEqual(ruleIntent('Vàng', ctx)?.rule, 'TROPICAL_CONFIRM_ANSWER');
  assert.notEqual(ruleIntent('Uh em', inbox())?.rule, 'TROPICAL_CONFIRM_ANSWER');
});

test('inbox2 M3 (…996276): "Túi có hoa quả sấy thăng hoa?" → Tropical; "đậu sấy thăng hoa" (bỏ dấu "dau") không', () => {
  assert.equal(ruleIntent('Túi có hoa quả sấy thăng hoa?', inbox())?.value?.Product_N1, 'Granola Tropical vị Cacao 300g');
  assert.notEqual(ruleIntent('Dau say thang hoa la loại nào ak', inbox())?.rule, 'TROPICAL');
});

test('dị ứng (inbox1 A7 …387486, inbox4 H3 …967248): có trong 3 túi → "không nên dùng", bỏ giỏ, không lặp; không có → xác nhận', async () => {
  const coconut = ruleIntent('Cái này dừa khô nhiều kg chi bi dị ứng dừa', held());
  assert.deepEqual([tpl(coconut), coconut?.value?.values?.ingredient, coconut?.clearBasket], ['ALLERGY_HAS_INGREDIENT', 'dừa sấy', true]);
  const soy = ruleIntent('E ko ăn đc đậu nành', inbox());
  assert.deepEqual([tpl(soy), soy?.value?.values?.ingredient], ['INGREDIENT_NOT_INCLUDED', 'đậu nành']);
  assert.equal(ruleIntent('mẹ không ăn được mè', inbox())?.value?.values?.ingredient, 'mè (vừng)');
  // "mẹ" bỏ dấu không phải mè; sữa chua ăn kèm không phải dị ứng sữa; xin bỏ thành phần vẫn NO_VARIANT.
  assert.notEqual(tpl(ruleIntent('không ăn được cho mẹ', inbox())), 'INGREDIENT_NOT_INCLUDED');
  assert.notEqual(tpl(ruleIntent('ăn với sữa chua không đường được không', inbox())), 'INGREDIENT_NOT_INCLUDED');
  assert.equal(tpl(ruleIntent('Mình ko ăn đc hạt bí mình muốn mua mà ko có hạt bí trong đó có đc ko e', inbox())), 'NO_VARIANT');
  // Nhắc lại trong 30 phút → câu cảm ơn ngắn, không gửi lại bảng thành phần.
  assert.equal(tpl(ruleIntent('Chị dị ứng dừa', inbox({ botLastTemplateId: 'ALLERGY_HAS_INGREDIENT', botLastAgeMin: 2 }))), 'THANK_YOU');
  // Lời mẫu: thành phần đúng nguyên văn INGREDIENTS_ALLERGY.
  const seed = defaultMessageTemplates();
  const absent = renderChatbotReply({ template_id: 'INGREDIENT_NOT_INCLUDED', values: { ingredient: 'đậu nành' } }, seed, {}).messages.join(' ');
  assert.match(absent, /không có đậu nành/);
  assert.ok(seed.INGREDIENTS_ALLERGY.includes('gạo lứt, yến mạch, hạt bí, hạnh nhân, hạt điều, nho khô, xoài sấy, nam việt quất sấy, dừa sấy, mật thốt nốt, đường mạch nha và muối hồng Himalaya'));
  assert.ok(absent.includes('gạo lứt, yến mạch, hạt bí, hạnh nhân, hạt điều, nho khô, xoài sấy, nam việt quất sấy, dừa sấy, mật thốt nốt, đường mạch nha và muối hồng Himalaya'));
  // Giả lập: giỏ 1 Xanh bị bỏ, không câu nhắc giỏ; tin nhắc lại → không gửi bảng thành phần.
  const sim = new Sim({ psid: 'r17c-387486' });
  const box = sim.inbox({ pendingOrder: basket([XANH(1)], 3 * MIN), botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN });
  const first = await sim.send(box, 'Cái này dừa khô nhiều kg chi bi dị ứng dừa', { llm: { template_id: 'INGREDIENTS_ALLERGY' } });
  assert.match(said(first), /đều có dừa sấy/);
  assert.doesNotMatch(said(first), /giữ đơn|số điện thoại/);
  assert.ok(!sim.conversations.get(sim.inboxId).pendingOrder?.items?.length);
  const again = await sim.send(sim.inbox(), 'Chị dị ứng dừa', { llm: { template_id: 'INGREDIENTS_ALLERGY' } });
  assert.doesNotMatch(said(again), /thành phần granola nhà em gồm|giữ đơn/);
});

test('bình luận A8 (…561388): "Lấy 1 hộp ko yến mạch nha" dưới live → không bảng giá Yến Mạch Úc', async () => {
  const sim = new Sim({ psid: 'r17c-561388' });
  const turn = await sim.send(sim.comment({ post: { id: 'post-live', message: 'Săn deal cùng Giọt Nắng ạ' } }), 'Lấy 1 hộp ko yến mạch nha', { llm: { template_id: 'ASK_PRODUCT' } });
  assert.doesNotMatch(said(turn), /Yến Mạch Úc/);
});
