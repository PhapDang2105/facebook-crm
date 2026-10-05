// Vòng 16 (05/10) — agent "rules": luật nhận ý (rule-intent.mjs), luồng đơn (order-flow.mjs), ưu đãi dùng thử (trial-flow.mjs).
// Mọi câu là câu khách thật 03–05/10 (r16 out-inbox1..5); không tên khách, không SĐT thật.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, basket } from './helpers/r13-engine-sim.mjs';
import { commentBasket } from '../app/chatbot-engine.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { cleanAddressText, collectAddressBurst, isNonAddressSegment, orderFlowStep } from '../app/processing/order-flow.mjs';
import { trialStep } from '../app/processing/trial-flow.mjs';

const inbox = extra => ({ source: 'inbox', botLastTemplateId: '', botLastAgeMin: Infinity, bundleSize: 1, commentBasket, experimentalRules: 'on', candidateRules: 'shadow', ...extra });
const held = extra => inbox({ hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 2, basketCodeCount: 1, ...extra });
const tpl = result => result?.value?.template_id || null;
const codes = items => (items || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const said = turn => turn.sent.map(item => item.text).join('\n');
const MIN = 60 * 1000;

test('#1 "ăn vặt" không phải hoá đơn VAT; hỏi xuất VAT thật vẫn VAT_INVOICE', () => {
  for (const text of ['Túi nào dùng ăn vặt ạ', 'Hạt này ăn vặt luôn ạ', 'đồ ăn vặt cho bé', 'mua về ăn vat cho vui']) {
    assert.notEqual(tpl(ruleIntent(text, inbox())), 'VAT_INVOICE', text);
    assert.notEqual(ruleIntent(text, inbox())?.value?.also, 'VAT_INVOICE', text);
  }
  for (const text of ['Có xuất VAT không', 'xuất VAT cho công ty', 'shop có xuất hóa đơn vat ko']) assert.equal(tpl(ruleIntent(text, inbox())), 'VAT_INVOICE', text);
});

test('#2 ca …4455835868 "Đặt mua 2 gói Ngũ cốc ăn sáng màu xanh / ĐC … / ĐT …" → giỏ 2 Xanh + SĐT + địa chỉ sạch', () => {
  const result = ruleIntent(`Đặt mua 2 gói Ngũ cốc ăn sáng màu xanh\nĐC 128/6 Trần Hữu Trang P 10 Q Phú Nhuận TP HCM\nĐT ${PHONE}`, inbox());
  assert.equal(result?.rule, 'BASKET_ADDRESS', JSON.stringify(result));
  assert.equal(result.value.Product_N1, 'Granola Túi Xanh 450g');
  assert.equal(result.value.No_A, '2');
  assert.equal(result.value.Phone_Number, PHONE);
  assert.ok(!/ngũ cốc|ăn sáng|xanh/iu.test(result.value.Customer_Address), result.value.Customer_Address);
  // (Nhãn "ĐC" đầu chuỗi do cleanAddressText của bộ soạn đơn bỏ — xem giả lập bên dưới.)
  assert.equal(cleanAddressText(result.value.Customer_Address), '128/6 Trần Hữu Trang P 10 Q Phú Nhuận TP HCM');
  // "Cho mình 3 bịch ngũ cốc vị cacao nhé <sđt> <đc>" → 3 Nâu (số nhà "5 Nguyễn Huệ" không bị nuốt vào cụm giỏ).
  const cacao = ruleIntent(`Cho mình 3 bịch ngũ cốc vị cacao nhé ${PHONE} 5 Nguyễn Huệ Q1 HCM`, inbox());
  assert.equal(cacao?.rule, 'BASKET_ADDRESS', JSON.stringify(cacao));
  assert.equal(cacao.value.Product_N1, 'Granola Túi Nâu vị cacao 350g');
  assert.equal(cacao.value.No_A, '3');
  assert.equal(cacao.value.Customer_Address, '5 Nguyễn Huệ Q1 HCM');
  // Không có địa chỉ: vẫn đọc giỏ.
  const plain = ruleIntent('Đặt mua 2 gói Ngũ cốc ăn sáng màu xanh', inbox());
  assert.equal(plain?.value?.Product_N1, 'Granola Túi Xanh 450g', JSON.stringify(plain));
  assert.equal(plain.value.No_A, '2');
  // "ngũ cốc" đứng riêng (chưa nêu vị — chờ chủ shop chốt mặc định): không tự thành giỏ.
  assert.notEqual(ruleIntent('1 vị ca cao, 1 ngủ cốc', inbox())?.rule, 'BASKET');
});

test('#2 giả lập: ca Kim lên đơn 2 Xanh, địa chỉ không chứa "Ngũ cốc ăn sáng màu xanh"', async () => {
  const sim = new Sim({ psid: 'r16-kim' });
  const box = sim.inbox();
  const turn = await sim.send(box, `Đặt mua 2 gói Ngũ cốc ăn sáng màu xanh\nĐC 128/6 Trần Hữu Trang P 10 Q Phú Nhuận TP HCM\nĐT ${PHONE}`, { llm: { template_id: 'ASK_FLAVOR' } });
  assert.equal(turn.created.length, 1, said(turn));
  assert.deepEqual(codes(turn.created[0].items), ['2 GRA-XANH-Z450']);
  assert.ok(!/ngũ cốc|ăn sáng/iu.test(turn.created[0].address), turn.created[0].address);
});

test('#2 "Túi bao bì màu xanh" sau ASK_FLAVOR (đã nói combo 3 túi) → 3 Xanh', () => {
  const result = ruleIntent('Túi bao bì màu xanh', inbox({ botLastTemplateId: 'ASK_FLAVOR', botLastAgeMin: 1, askedBagCount: 3 }));
  assert.equal(result?.rule, 'FLAVOR_ANSWER');
  assert.equal(result.value.Product_N1, 'Granola Túi Xanh 450g');
  assert.equal(result.value.No_A, '3');
});

test('#3 đã mua trên sàn gõ sai tên sàn → BOUGHT_ELSEWHERE; "… đúng không" không có nội dung giỏ ≠ CONFIRM_YES', () => {
  for (const text of ['E vua mua ben titok roi', 'c đặt ở shoppee bên em rồi nhé']) {
    for (const ctx of [inbox(), held()]) {
      const result = ruleIntent(text, ctx);
      assert.equal(result?.rule, 'BOUGHT_ELSEWHERE', `${text} ${JSON.stringify(result)}`);
      assert.equal(result.clearBasket, true);
    }
  }
  assert.notEqual(tpl(ruleIntent('shop đó vẫn là bên em đúng không', held())), 'CONFIRM_YES');
  assert.notEqual(tpl(ruleIntent('Hàng đc ktra trc khi tt đúng ko e?', held())), 'CONFIRM_YES');
  // Tóm tắt giỏ thật vẫn CONFIRM_YES.
  assert.equal(tpl(ruleIntent('2 túi xanh 298k miễn ship đúng không', held())), 'CONFIRM_YES');
});

test('#4 hỏi giá đúng 2 túi → PRICE_COUNT 298k miễn ship + hỏi vị (Nâu 288k, live có quà)', () => {
  for (const text of ['2 túi giá sao e', 'Mua hai gói ngũ cốc giá như nào an', 'Lấy 2 túi giá com bo', 'Mua 2g thì bn tiền']) {
    const result = ruleIntent(text, inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastAgeMin: 3 }));
    assert.equal(result?.rule, 'PRICE_COUNT', `${text} ${JSON.stringify(result)}`);
    assert.equal(result.value.values.count, '2');
    assert.equal(result.value.values.total, '298.000đ');
    assert.equal(result.value.values.free, '1');
    assert.equal(result.value.values.pick, '1');
  }
  const nau = ruleIntent('2 túi nâu giá bn', inbox());
  assert.equal(nau.value.values.total, '288.000đ');
  assert.equal(nau.value.values.named, '1');
  // (Quà live "Quạt + Bát gáo dừa" lấy từ danh mục quà thật — tệp quà mẫu của test chưa có, xem r13-engine-live-gift.)
  assert.equal(ruleIntent('2 túi giá sao e', inbox({ livestream: true }))?.rule, 'PRICE_COUNT');
  assert.equal(ruleIntent('2 túi trọng luong bn và bn tiền ạ', inbox()).value.also, 'WEIGHT_EXPIRY');
  // Không phải hỏi giá 2 túi: xác nhận giỏ, khách tự đưa giá khác, hai ý (giảm giá).
  for (const text of ['tổng cộng là 2 túi vàng', 'Dạ mua 2 bich giá 189k thôi ạ', '2 túi xanh giá sao z shop?có giảm giá ko']) assert.notEqual(ruleIntent(text, inbox())?.rule, 'PRICE_COUNT', text);
});

test('#4 hỏi giá từng loại / đồng giá → bảng 3 vị (GENERAL_INFO listAll); "2 túi 2 vị được không" → ASK_FLAVOR; "3 tuis"', () => {
  for (const text of ['Cho mình giá của từng loại', 'Ý mình hỏi giá của từng loại thế nào', 'Đồng giá bằng nhau hả bạn?', 'Có mấy loại organic ạ\nGiá sao ạ']) {
    const result = ruleIntent(text, inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastAgeMin: 5 }));
    assert.equal(tpl(result), 'GENERAL_INFO', text);
    assert.equal(result.value.listAll, '1', text);
  }
  assert.notEqual(tpl(ruleIntent('Xin bảng giá từng tủi nhỏ ăn kiêng?', inbox())), 'GENERAL_INFO');
  for (const text of ['Lay 2 tui mà 2vị dc k ah', '2 túi 2 vị được ko e']) {
    const result = ruleIntent(text, inbox());
    assert.equal(result?.rule, 'TWO_FLAVOURS_ASK', text);
    assert.equal(tpl(result), 'ASK_FLAVOR');
    assert.ok(!result.value.Product_N1);
  }
  assert.equal(tpl(ruleIntent('3 tuis', inbox())), 'ASK_FLAVOR');
});

test('#5 chê hàng khác quảng cáo / ít hạt → COMPLAINT_HANDOFF (CSKH + thẻ), như luật khiếu nại hiện có', () => {
  for (const text of ['Quảng cáo thì hạt các loại nhiều mà nhận hàng thì toàn kiểu hạt gạo nhiều', 'Nhưng hình ảnh quảng cáo hạt đó ít, các hạt khác nhiều. Mà thực tế nhận thì khác hoàn toàn', 'Nhg hơi ít hath']) {
    const result = ruleIntent(text, inbox());
    assert.equal(result?.rule, 'COMPLAINT_HANDOFF', `${text} ${JSON.stringify(result)}`);
    assert.equal(tpl(result), 'CSKH_HANDOFF');
    assert.equal(result.attention, true);
  }
  // Chọn vị "ít hạt" không phải khiếu nại.
  assert.notEqual(ruleIntent('Lấy c loại ít hạt nha', inbox())?.rule, 'COMPLAINT_HANDOFF');
});

test('#6 ưu đãi dùng thử: "E nhận hàng" / "nhận được hàng rồi" / shipper → mô hình, không TRIAL_ACCEPT', () => {
  const trial = { stage: 'offered', freeShipping: true, until: Date.now() + 3600e3 };
  for (const text of ['E nhận hàng', 'Em nhận được hàng rồi', 'Shipper gửi cho hàng xóm nha em']) {
    const step = trialStep({ text, trial });
    assert.equal(step.delegate, true, `${text} ${JSON.stringify(step)}`);
  }
  assert.equal(trialStep({ text: 'ok', trial }).value?.template_id, 'TRIAL_ACCEPT');
});

test('#6 "Hạt mới và như quảng cáo mới nhận hàng nhé" (chưa có đơn) không phải RECEIVED_CHECK; "vừa nhận hàng" vẫn là', () => {
  assert.notEqual(ruleIntent('Hạt mới và như quảng cáo mới nhận hàng nhé', inbox())?.rule, 'RECEIVED_CHECK');
  assert.equal(ruleIntent('Chị vừa nhận hàg thấy 2 vị nguyên bản', inbox())?.rule, 'RECEIVED_CHECK');
});

test('#7 "giảm 10%" là mặc cả (DISCOUNT_OATS_GIFT); "chưa rao cho chị à" có đơn ≤ 14 ngày → ORDER_STATUS + thẻ', () => {
  for (const text of ['giảm 10% đi em', 'Giám 10phan tram o em', 'giảm 10 phần trăm được ko']) assert.equal(tpl(ruleIntent(text, inbox())), 'DISCOUNT_OATS_GIFT', text);
  const order = inbox({ hasRecentOrder: true, orderAgeMin: 3977, botLastTemplateId: 'ORDER_CONFIRMATION', botLastAgeMin: 3977 });
  for (const text of ['Em ơi chưa rao cho chị à', 'chưa giao cho chị hả']) {
    const result = ruleIntent(text, order);
    assert.equal(tpl(result), 'ORDER_STATUS', text);
    assert.equal(result.attention, true);
  }
  // Không có đơn / đơn quá 14 ngày: để mô hình.
  assert.equal(ruleIntent('Em ơi chưa rao cho chị à', inbox()), null);
  assert.notEqual(ruleIntent('Em ơi chưa rao cho chị à', inbox({ hasRecentOrder: true, orderAgeMin: 15 * 24 * 60 }))?.rule, 'ORDER_NOT_DELIVERED');
});

test('#8 gói nhỏ hỏi màu → SMALL_PACK_FLAVOURS; giá giỏ trộn hộp 10 gói + túi → ORDER_ADDRESS đủ 2 món', () => {
  for (const text of ['Gói mini có màu vàng kg e', 'gói nhỏ có vị nâu không shop']) assert.equal(tpl(ruleIntent(text, inbox())), 'SMALL_PACK_FLAVOURS', text);
  assert.equal(tpl(ruleIntent('Trong video mình thấy nhiều loại mà giờ chỉ có màu xanh thôi đúng k bạn', inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastAgeMin: 2, quotedProduct: 'Combo 10 gói Xanh' }))), 'SMALL_PACK_FLAVOURS');
  assert.notEqual(tpl(ruleIntent('Quạt mini có màu xanh không', inbox())), 'SMALL_PACK_FLAVOURS');
  const mixed = ruleIntent('Combo 1 hộp 10 gói xanh và 1 túi vàng thì giá bao nhiêu', inbox({ botLastTemplateId: 'DISCOUNT_POLICY', botLastAgeMin: 4 }));
  assert.equal(mixed?.rule, 'MIXED_PACK_PRICE', JSON.stringify(mixed));
  assert.deepEqual([mixed.value.Product_N1, mixed.value.No_A, mixed.value.Product_N2, mixed.value.No_B], ['Combo 10 gói Xanh', '1', 'Granola Túi Vàng 350g', '1']);
});

test('#8 giả lập: "Combo 1 hộp 10 gói xanh và 1 túi vàng thì giá bao nhiêu" → bộ soạn tính 328.000đ miễn ship, xin SĐT', async () => {
  const sim = new Sim({ psid: 'r16-mixed' });
  const box = sim.inbox({ botLastTemplateId: 'DISCOUNT_POLICY', botLastReplyAt: Date.now() - 4 * MIN });
  const turn = await sim.send(box, 'Combo 1 hộp 10 gói xanh và 1 túi vàng thì giá bao nhiêu', { llm: { template_id: 'CSKH_HANDOFF' } });
  assert.match(said(turn), /328\.000đ/);
  assert.match(said(turn), /Miễn phí vận chuyển/iu);
  assert.deepEqual(codes(box.pendingOrder?.items), ['1 CB10-XANH-G35', '1 GRA-VANG-H350']);
  assert.equal(turn.created.length, 0);
});

test('#9 địa chỉ: bỏ chữ đệm / câu hỏi / câu đặt hàng / nhãn trơ, giữ số nhà', () => {
  const cases = [
    ['Giao chị combo 2\nĐịa chỉ\n540 Đường 30/4, Kp5, P3, Tp Tây Ninh', '540 Đường 30/4, Kp5, P3, Tp Tây Ninh'],
    ['C thuý số 10 ngõ 20 phố minh đức, Đảm bảo k hôi k chiên qua dầu chứ e, Thị trấn Tiên Lãng, Hải Phòng', 'C thuý số 10 ngõ 20 phố minh đức, Thị trấn Tiên Lãng, Hải Phòng'],
    ['475/50/2 Hai Bà Trưng, Lấy 1 túi xanh và 1 túi vàng gía 293.000đ, P. Võ Thị Sáu, Quận 3, TP HCM', '475/50/2 Hai Bà Trưng, P. Võ Thị Sáu, Quận 3, TP HCM'],
    ['kdc ấp vĩnh bình a, Trên cho rồi, Xã Vĩnh Thạnh, Lấp Vò, Đồng Tháp', 'kdc ấp vĩnh bình a, Xã Vĩnh Thạnh, Lấp Vò, Đồng Tháp'],
    ['Long son,anh son ,nghe an\nRoi ddo ak', 'Long son, anh son, nghe an']
  ];
  for (const [raw, expected] of cases) assert.equal(cleanAddressText(raw), expected, raw);
  for (const segment of ['Roi ddo ak', 'Rồi đó ạ', 'đủ rồi e', 'vậy đó shop', 'Trên cho rồi', 'Địa chỉ']) assert.equal(isNonAddressSegment(segment), true, segment);
  for (const segment of ['Khu A', 'Xom 8', 'Thôn Đồng Tiến', '12 Lê Lợi', 'Long son', 'Phường Đa Kao']) assert.equal(isNonAddressSegment(segment), false, segment);
});

test('#9 ca …2290652283: "Long son,anh son ,nghe an" rồi "Roi ddo ak" → địa chỉ không chứa "Roi ddo ak"', async () => {
  const now = Date.now();
  const burst = collectAddressBurst([
    { direction: 'incoming', type: 'text', text: 'Long son,anh son ,nghe an', createdAt: now - 50000 },
    { direction: 'outgoing', type: 'text', text: 'Dạ anh/chị gửi giúp em tên đường hoặc thôn/ấp kèm số nhà là em lên đơn liền nha.', createdAt: now - 40000 },
    { direction: 'incoming', type: 'text', text: 'Roi ddo ak', createdAt: now }
  ]);
  assert.equal(burst.text, 'Long son, anh son, nghe an');
  const flow = orderFlowStep('Roi ddo ak', { hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS_REMIND', addressComplete: true, addressText: burst.text });
  assert.ok(!/roi|ddo/i.test(flow?.value?.Customer_Address || ''), JSON.stringify(flow));
  // Giả lập engine: đơn (nếu chốt) không mang "Roi ddo ak".
  const sim = new Sim({ psid: 'r16-roido' });
  const box = sim.inbox({ pendingOrder: basket([XANH(1)], MIN, { phone: PHONE, address: 'Long son,anh son ,nghe an', addressAsks: 1 }), botLastTemplateId: 'ORDER_ADDRESS_REMIND', botLastReplyAt: Date.now() - 40000 });
  sim.history(box, 'incoming', PHONE, 2 * MIN);
  sim.history(box, 'incoming', 'Long son,anh son ,nghe an', MIN);
  sim.history(box, 'outgoing', 'Dạ em vẫn đang giữ đơn 1 Granola Túi Xanh 450g – tổng 189.000đ cho anh/chị ạ 🌾 Anh/chị gửi giúp em tên đường hoặc thôn/ấp kèm số nhà là em lên đơn liền nha.', 40000);
  const turn = await sim.send(box, 'Roi ddo ak', { llm: { template_id: 'ORDER_CONFIRMATION' } });
  for (const order of turn.created) assert.ok(!/roi|ddo/i.test(order.address || ''), order.address);
  assert.ok(!/Roi ddo ak/.test(said(turn)), said(turn));
});

test('#10 "Túi xanh" rồi "Ok lấy cho chị 2 túi nha" → 2 Xanh (không hỏi lại vị); tin trước không nêu một màu → hỏi vị như cũ', () => {
  const ctx = recent => inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastAgeMin: 4, recentCustomerTexts: recent });
  const result = ruleIntent('Ok lấy cho chị 2 túi nha', ctx(['Túi xanh', 'Ok lấy cho chị 2 túi nha']));
  assert.equal(result?.rule, 'BAGS_NAMED_BEFORE');
  assert.equal(result.value.Product_N1, 'Granola Túi Xanh 450g');
  assert.equal(result.value.No_A, '2');
  assert.equal(tpl(ruleIntent('Ok lấy cho chị 2 túi nha', ctx(['Túi xanh khác túi vàng sao']))), 'ASK_FLAVOR');
  assert.equal(tpl(ruleIntent('Ok lấy cho chị 2 túi nha', ctx(['Túi xanh à']))), 'ASK_FLAVOR');
  assert.equal(tpl(ruleIntent('Ok lấy cho chị 2 túi nha', ctx([{ text: 'Túi xanh', at: Date.now() - 40 * MIN }]))), 'ASK_FLAVOR');
  assert.equal(tpl(ruleIntent('Ok lấy cho chị 2 túi nha', inbox())), 'ASK_FLAVOR');
});

test('#12 (điều phối) "Vậy tổng là 5 túi, tặng 1 túi vàng + 1 bộ bát, thìa đúng ko shop" khi giữ giỏ → CONFIRM_YES, không BIG_BASKET', () => {
  const ctx = held({ basketCodeCount: 3 });
  const result = ruleIntent('Vậy tổng là 5 túi, tặng 1 túi vàng + 1 bộ bát, thìa đúng ko shop', ctx);
  assert.notEqual(result?.rule, 'BIG_BASKET', JSON.stringify(result));
  assert.equal(tpl(result), 'CONFIRM_YES');
  // Không giữ giỏ, hỏi giá 5 túi: như cũ (báo giá / ghi nhận), màu sau "tặng" không thành vị của giỏ.
  const ask = ruleIntent('5 túi tặng 1 túi vàng giá bao nhiêu', inbox());
  assert.notEqual(ask?.value?.Product_N1, 'Granola Túi Vàng 350g', JSON.stringify(ask));
});

test('#13 (điều phối) sau ASK_FLAVOR_NGUYENBAN, "Túi xanh" = số túi phần nguyên bản (ctx.nguyenBanAsk), không phải tổng', () => {
  const result = ruleIntent('Túi xanh', inbox({ botLastTemplateId: 'ASK_FLAVOR_NGUYENBAN', botLastAgeMin: 1, askedBagCount: 3, nguyenBanAsk: 2 }));
  assert.equal(result?.rule, 'FLAVOR_ANSWER');
  assert.equal(result.value.No_A, '2');
  assert.equal(ruleIntent('Túi xanh', inbox({ botLastTemplateId: 'ASK_FLAVOR', botLastAgeMin: 1, askedBagCount: 3, nguyenBanAsk: 2 })).value.No_A, '3');
});

test('#14 (điều phối) "Gói cam bơ hạt điều. Bn e" (Gói Cam đã tắt) → SMALL_PACK_FLAVOURS, không LIVE_ONLY', () => {
  assert.equal(tpl(ruleIntent('Gói cam bơ hạt điều. Bn e', inbox({ botLastTemplateId: 'DISCOUNT_POLICY', botLastAgeMin: 3 }))), 'SMALL_PACK_FLAVOURS');
});

test('#11 "N loại/vị/màu" không phải số túi trong luật giỏ; "1 màu xanh 1 màu vàng" vẫn là giỏ', () => {
  for (const text of ['sao co 2loai tui xanh va tui vang', 'Mình lấy 2 loại túi xanh và túi vàng']) {
    const result = ruleIntent(text, inbox());
    assert.ok(!result?.value?.Product_N1, `${text} ${JSON.stringify(result)}`);
  }
  const ok = ruleIntent('Lấy chị 2 túi 1 màu xanh 1 màu vàng', inbox());
  assert.equal(ok?.rule, 'BASKET', JSON.stringify(ok));
});
