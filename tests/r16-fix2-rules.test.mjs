// Vòng 16 — sửa theo phản biện luật / giỏ / địa chỉ (scratchpad r16/review-rules.md). Câu lấy đúng từ báo cáo phản biện (câu thật r16
// hay câu đối kháng của phản biện), SĐT giả.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE } from './helpers/r13-engine-sim.mjs';
import { commentBasket } from '../app/chatbot-engine.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { cleanAddressText } from '../app/processing/order-flow.mjs';
import { trialStep } from '../app/processing/trial-flow.mjs';
import { colourCountsInText } from '../app/chatbot-templates.mjs';

const inbox = extra => ({ source: 'inbox', botLastTemplateId: '', botLastAgeMin: Infinity, bundleSize: 1, commentBasket, experimentalRules: 'on', candidateRules: 'shadow', ...extra });
const held = extra => inbox({ hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 2, basketCodeCount: 1, ...extra });
const order2d = extra => inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastAgeMin: 3000, hasRecentOrder: true, orderAgeMin: 3000, ...extra });
const tpl = result => result?.value?.template_id || null;
const codes = items => (items || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();

// ---- H1. PRICE_COUNT không báo giá granola cho sản phẩm khác (mọi số túi).
test('H1: "2 túi yến mạch giá bao nhiêu", "2 gói nghệ lành giá sao", "2 túi granola mint giá bn", "3 túi yến mạch…" → không PRICE_COUNT', () => {
  for (const text of ['2 túi yến mạch giá bao nhiêu', '2 túi bột nghệ giá bn', '2 gói nghệ lành giá sao', 'bột ngũ cốc nghệ lành 2 gói giá bao nhiêu', '2 túi mint giá bao nhiêu',
    '2 túi granola mint giá bn', '2 gói cam giá sao', '3 túi yến mạch giá bao nhiêu', '3 gói nghệ lành giá sao', '3 túi mint giá bao nhiêu', 'yến mạch 2 túi giá sao']) {
    assert.notEqual(ruleIntent(text, inbox())?.rule, 'PRICE_COUNT', text);
  }
  // Hạt điều / sữa hạt → nhân viên (LIVE_ONLY) như trước vòng 16.
  for (const text of ['2 túi hạt điều giá bn', '2 túi sữa hạt giá bn', '3 túi hạt điều giá bn']) assert.equal(ruleIntent(text, inbox())?.rule, 'LIVE_ONLY', text);
  // Granola vẫn báo giá combo; "nghe" tiểu từ, "cảm ơn" không loại.
  for (const text of ['2 túi giá sao e', 'Mua hai gói ngũ cốc giá như nào', '2 túi bao nhiêu nghe em', '2 túi giá bao nhiêu cảm ơn']) assert.equal(ruleIntent(text, inbox())?.rule, 'PRICE_COUNT', text);
});

// ---- M1. AD_VS_REALITY không bắt câu hỏi / câu đặt / câu khen; khiếu nại thật vẫn bắt.
test('M1: câu hỏi / đặt hàng / khen không phải khiếu nại; ba khiếu nại thật vẫn COMPLAINT_HANDOFF', () => {
  for (const text of ['túi xanh hơi ít hạt hả em', 'xanh hơi ít hạt nên lấy 2 túi vàng nhé', 'ít hạt quá thì lấy vàng nhé', 'vị vàng với xanh khác hoàn toàn hả em',
    '2 vị này khác hoàn toàn nhau à', 'nhưng toàn yến mạch thôi hả em?', 'hình ảnh quảng cáo đẹp quá mà giao tới HCM mất mấy ngày', 'ăn ngon lắm, đúng như quảng cáo mà nhận nhanh nữa']) {
    for (const ctx of [inbox(), held(), order2d()]) assert.notEqual(ruleIntent(text, ctx)?.rule, 'COMPLAINT_HANDOFF', text);
  }
  assert.equal(ruleIntent('loại nào nhiều hạt, loại nào hơi ít hạt', inbox())?.rule, 'COMPARE');
  for (const text of ['Quảng cáo thì hạt các loại nhiều mà nhận hàng thì toàn kiểu hạt gạo nhiều', 'Nhưng hình ảnh quảng cáo hạt đó ít, các hạt khác nhiều. Mà thực tế nhận thì khác hoàn toàn']) {
    for (const ctx of [inbox(), order2d()]) assert.equal(ruleIntent(text, ctx)?.rule, 'COMPLAINT_HANDOFF', text);
  }
  // "Nhg hơi ít hath" (ca …6281113917): khiếu nại khi khách có đơn / vừa nói đã ăn; câu trơn không ngữ cảnh thì không.
  assert.equal(ruleIntent('Nhg hơi ít hath', order2d())?.rule, 'COMPLAINT_HANDOFF');
  assert.equal(ruleIntent('Nhg hơi ít hath', inbox({ recentCustomerTexts: [{ text: 'Nay chị mới ăn nhà e', at: Date.now() - 60e3 }] }))?.rule, 'COMPLAINT_HANDOFF');
  assert.notEqual(ruleIntent('Nhg hơi ít hath', inbox())?.rule, 'COMPLAINT_HANDOFF');
});

// ---- M2. Danh sách màu không ghép qua địa danh / đuôi bỏ-hoãn-hỏi.
test('M2: "2 túi xanh, Vàng Danh, …", "lấy 2 túi xanh, vàng thì thôi", "…vàng có không", "…vàng để lần sau", "2 túi xanh vàng hết rồi à" → 2 Xanh', () => {
  for (const text of ['2 túi xanh, Vàng Danh, Uông Bí, Quảng Ninh 0912345678', 'lấy 2 túi xanh, vàng thì thôi. 12 Lê Lợi, Huế', 'lấy 2 túi xanh, vàng có không', 'lấy 2 túi xanh, vàng để lần sau', '2 túi xanh vàng hết rồi à']) {
    assert.deepEqual(colourCountsInText(text).counts, { XANH: 2 }, text);
  }
  // Danh sách thật vẫn chia: "Mua 2 túi nâu xanh" (ca …9387140891), "Lấy 2 túi xanh vàng ạ".
  assert.deepEqual(colourCountsInText('Mua 2 túi nâu xanh').counts, { NAU: 1, XANH: 1 });
  assert.deepEqual(colourCountsInText('Lấy 2 túi xanh vàng ạ').counts, { XANH: 1, VANG: 1 });
});

test('M2 qua engine: "lấy 2 túi xanh, vàng thì thôi. 12 Lê Lợi, Huế <sđt>" → đơn 2 Túi Xanh (không 1 Xanh)', async () => {
  const sim = new Sim({ psid: 'fix2-m2' });
  const ib = sim.inbox();
  const turn = await sim.send(ib, `lấy 2 túi xanh, vàng thì thôi. 12 Lê Lợi, Phường Phú Hội, Huế ${PHONE}`, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: PHONE, Customer_Address: '12 Lê Lợi, Phường Phú Hội, Huế' } });
  const items = turn.created[0]?.items || ib.pendingOrder?.items;
  assert.deepEqual(codes(items), ['2 GRA-XANH-Z450'], JSON.stringify(turn.result));
});

// ---- L4 (luật). Khách tự chia ngay sau danh sách.
test('L4: "3 túi xanh vàng, 2 xanh 1 vàng" → 2 Xanh + 1 Vàng; "4 túi xanh nâu, xanh 3 nâu 1" → 3 Xanh + 1 Nâu; "3 túi xanh vàng" vẫn hỏi lại', () => {
  assert.deepEqual(colourCountsInText('3 túi xanh vàng, 2 xanh 1 vàng'), { counts: { XANH: 2, VANG: 1 }, mentioned: ['XANH', 'VANG'], each: false, splitAsk: 0 });
  assert.deepEqual(colourCountsInText('4 túi xanh nâu, xanh 3 nâu 1').counts, { XANH: 3, NAU: 1 });
  assert.equal(colourCountsInText('4 túi xanh nâu, xanh 3 nâu 1').splitAsk, 0);
  assert.equal(colourCountsInText('3 túi xanh vàng').splitAsk, 3);
  // Phần chia không cộng đủ N → vẫn hỏi lại.
  assert.equal(colourCountsInText('3 túi xanh vàng, 1 xanh 1 vàng').splitAsk, 3);
});

// ---- M3. Không xoá địa danh thật khỏi địa chỉ.
test('M3: "Xóm 3, Cổ Bi, Gia Lâm, Hà Nội", "Bản Đó, …", "Chợ Trên, …", "Cổ Chiên, …", "15 Hà Đô, …" giữ nguyên; chữ rác vẫn bỏ', () => {
  for (const text of ['Xóm 3, Cổ Bi, Gia Lâm, Hà Nội', 'Bản Đó, Mường Chà, Điện Biên', 'Chợ Trên, Kim Bảng, Hà Nam', 'Cổ Chiên, Mỏ Cày Nam, Bến Tre', '15 Hà Đô, Gò Vấp, HCM', 'Đá Đỏ, Ninh Phước, Ninh Thuận']) {
    assert.equal(cleanAddressText(text), text, text);
  }
  assert.equal(cleanAddressText('12 Lê Lợi, Roi ddo ak, Phường Bến Nghé, Quận 1, HCM'), '12 Lê Lợi, Phường Bến Nghé, Quận 1, HCM');
  assert.equal(cleanAddressText('Trên cho rồi, 15 Nguyễn Huệ, Quận 1, HCM'), '15 Nguyễn Huệ, Quận 1, HCM');
  assert.equal(cleanAddressText('12 Lê Lợi, Đảm bảo k hôi k chiên qua dầu chứ e, Phường Bến Nghé, Quận 1, HCM'), '12 Lê Lợi, Phường Bến Nghé, Quận 1, HCM');
  assert.equal(cleanAddressText('12 Lê Lợi, Đúng rồi e, Phường Bến Nghé, Quận 1, HCM'), '12 Lê Lợi, Phường Bến Nghé, Quận 1, HCM');
});

// ---- M4. PRICE_EACH không nuốt câu hỏi khối lượng / sức khoẻ.
test('M4: "Mỗi túi bao nhiêu gam" → WEIGHT_EXPIRY; "các loại túi giá bao nhiêu, có loại nào cho người tiểu đường không" → HEALTH_DIABETES', () => {
  assert.equal(ruleIntent('Mỗi túi bao nhiêu gam', inbox())?.rule, 'WEIGHT_EXPIRY');
  assert.equal(ruleIntent('các loại túi giá bao nhiêu, có loại nào cho người tiểu đường không', inbox())?.rule, 'DIABETES');
  assert.equal(ruleIntent('Cho mình giá của từng loại', inbox())?.rule, 'PRICE_EACH');
  assert.equal(ruleIntent('các loại giá bao nhiêu, ship về Đà Nẵng mất mấy ngày', inbox())?.rule, 'PRICE_EACH');
});

// ---- L1 / L2.
test('L1: "đường 5g bao nhiêu", "2g đường bao nhiêu calo", "1 thìa 5g bao nhiêu calo" không phải N gói; "Mua 2g thì bn tiền" vẫn 2 gói', () => {
  for (const text of ['đường 5g bao nhiêu', '2g đường bao nhiêu calo', '1 thìa 5g bao nhiêu calo']) assert.notEqual(ruleIntent(text, inbox())?.rule, 'PRICE_COUNT', text);
  assert.equal(ruleIntent('2g đường bao nhiêu calo', inbox())?.rule, 'CALORIES');
  assert.equal(ruleIntent('Mua 2g thì bn tiền', inbox())?.rule, 'PRICE_COUNT');
});

test('L2: "ăn giảm 10 phần trăm mỡ không", "đường giảm 30% so với loại thường à" không phải mặc cả; "Giám 10phan tram o em" vẫn là mặc cả', () => {
  for (const text of ['ăn giảm 10 phần trăm mỡ không', 'đường giảm 30% so với loại thường à']) assert.notEqual(tpl(ruleIntent(text, inbox())), 'DISCOUNT_OATS_GIFT', text);
  assert.equal(tpl(ruleIntent('Giám 10phan tram o em', inbox())), 'DISCOUNT_OATS_GIFT');
});

// ---- L3. Ưu đãi dùng thử: "nhận hàng" chỉ là "đơn đang giao" khi khách chưa chọn túi.
test('L3: "Lấy 1 túi xanh, nhận hàng giờ hành chính nhé" / "Ok gửi chị 1 túi vàng, giao shipper gọi trước nhé" → bước đơn; "E nhận hàng" → mô hình', () => {
  const now = Date.now();
  const trial = { stage: 'offered', until: now + 36 * 3600e3, at: now - 60e3 };
  for (const text of ['Lấy 1 túi xanh, nhận hàng giờ hành chính nhé', 'lấy túi xanh nhé, chị nhận hàng ở công ty', 'Ok gửi chị 1 túi vàng, giao shipper gọi trước nhé']) {
    assert.equal(trialStep({ text, trial, now }).value?.template_id, 'ORDER_ADDRESS', text);
  }
  assert.equal(trialStep({ text: 'ok em, nhận hàng rồi trả tiền shipper nhé', trial, now }).value?.template_id, 'PAYMENT_METHODS');
  for (const text of ['E nhận hàng', 'Shipper gửi cho hàng xóm nha em', 'nhận được hàng rồi']) assert.equal(trialStep({ text, trial, now }).delegate, true, text);
});
