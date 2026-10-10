// Vòng 16 — quyết định chủ shop 05/10 (memory crm-decisions-r15-0310):
//  1. Granola CÓ mật thốt nốt và đường mạch nha — bot không được nói "không thêm đường"; người tiểu đường / kiêng đường / mẹ bầu: hỏi ý
//     kiến bác sĩ, dùng lượng vừa phải (không chuyển nhân viên).
//  2. Tắt Combo 10 gói Nâu và Mix (Cam đã tắt) — combo 10 gói chỉ còn Xanh.
//  3. Khách không nêu vị → MẶC ĐỊNH Túi Xanh (không hỏi lại vị), câu trả lời ghi rõ "N Túi Xanh nguyên bản 450g" để khách đổi.
//  4. Bám đuổi buổi sáng bắt đầu 8h (trước 7h), tin dồn đầu ngày rải ra vài lượt.
// Câu khách là câu thật trong hội thoại r13/r15/r16 (không tên, không SĐT thật).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Sim, PHONE, XANH, basket, templates } from './helpers/r13-engine-sim.mjs';
import { cartQuickReply, commentBasket, fallbackTemplates } from '../app/chatbot-engine.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';
import { followUpRunCap, isQuietHourVN } from '../app/follow-up.mjs';

const MIN = 60 * 1000;
const X = 'Granola Túi Xanh 450g';
const V = 'Granola Túi Vàng 350g';
const ADDR = '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
const inbox = extra => ({ source: 'inbox', botLastTemplateId: '', botLastAgeMin: Infinity, bundleSize: 1, commentBasket, experimentalRules: 'on', candidateRules: 'shadow', ...extra });
const tpl = result => result?.value?.template_id || null;
const codes = items => (items || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const said = turn => turn.sent.map(item => item.text).join('\n');
const fold = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const seed = JSON.parse(readFileSync(new URL('../app/chatbot-templates.seed.json', import.meta.url), 'utf8'));
const products = JSON.parse(readFileSync(new URL('../app/products.seed.json', import.meta.url), 'utf8')).items;
const prompt = readFileSync(new URL('../docs/system-prompt.txt', import.meta.url), 'utf8');

// ===== 1. Đường =====
// "không thêm đường / không có đường / không đường / ít đường / sugar free" nói về GRANOLA (không tính "sữa chua không đường",
// "sữa tươi không đường" — cách ăn kèm).
const SUGAR_FREE_CLAIM = /(?<!sua chua |sua tuoi |sua hat |sua )\b(?:khong (?:them |co )?duong|it duong|sugar ?free)\b/;

test('1. mẫu seed + lời dự phòng engine + prompt: không còn câu khẳng định granola "không thêm đường"', () => {
  for (const [id, text] of [...Object.entries(seed), ...Object.entries(fallbackTemplates)]) {
    assert.doesNotMatch(fold(text), SUGAR_FREE_CLAIM, id);
  }
  // Prompt chỉ còn câu CẤM ("KHÔNG nói 'không thêm đường'") và nói đúng thành phần.
  assert.doesNotMatch(fold(prompt).replace(/khong noi "khong them duong"/g, ' '), /khong them duong/);
  assert.match(prompt, /granola có mật thốt nốt và đường mạch nha/);
  for (const id of ['NO_ADDED_SUGAR', 'HEALTH_DIABETES', 'HEALTH_CONDITION', 'HEALTH_CAUTION', 'KIDS_FAMILY', 'BENEFITS']) {
    assert.match(seed[id], /mật thốt nốt và đường mạch nha/, id);
  }
  assert.match(seed.INGREDIENTS_ALLERGY, /mật thốt nốt, đường mạch nha/);
  // Không thêm thông tin chưa được xác nhận (đường tinh luyện, lượng đường, chỉ số đường huyết).
  for (const id of ['NO_ADDED_SUGAR', 'HEALTH_DIABETES', 'HEALTH_CONDITION', 'HEALTH_CAUTION']) {
    assert.doesNotMatch(fold(seed[id]), /tinh luyen|chi so duong huyet|\bgi\b|\d+ ?g duong/, id);
  }
});

test('1. câu khách thật về đường → trả lời có mật thốt nốt + đường mạch nha; tiểu đường / mẹ bầu tiểu đường thai kỳ → hỏi ý kiến bác sĩ, không chuyển nhân viên', () => {
  for (const text of ['Sản phẩm có đường ko ah', 'Hàng này có đường k shop', 'có ngọt ko bạn', 'Hạt này có đường nhièu ko e', 'Nhà mình có loại nào ko đường thì để cho ch với', 'Vị cacao có đường k bạn, dùng cho người ăn kiên đường được k']) {
    const result = ruleIntent(text, inbox({ botLastTemplateId: 'GENERAL_INFO', botLastAgeMin: 3 }));
    assert.equal(tpl(result), 'NO_ADDED_SUGAR', text);
    const reply = renderChatbotReply(result.value, templates, {}).messages.join(' ');
    assert.match(reply, /mật thốt nốt và đường mạch nha/, text);
    assert.doesNotMatch(fold(reply), SUGAR_FREE_CLAIM, text);
    assert.match(reply, /hỏi ý kiến bác sĩ/, text);
  }
  for (const text of ['Người tiểu đường an dc kg e', 'Bà bầu thai kỳ tiểu đường dùng có được ko ạ', 'Ch muốn mua cho người mắc tiểu đường ăn', 'Chị bị đường cao ko muốn ăn quá ngọt có đường nhiều thì dùng loại nào em']) {
    const result = ruleIntent(text, inbox({ botLastTemplateId: 'GENERAL_INFO', botLastAgeMin: 3 }));
    assert.equal(tpl(result), 'HEALTH_DIABETES', text);
    assert.ok(!result.attention, `${text}: không chuyển nhân viên`);
    const reply = renderChatbotReply(result.value, templates, {}).messages.join(' ');
    assert.match(reply, /mật thốt nốt và đường mạch nha/, text);
    assert.match(reply, /hỏi ý kiến bác sĩ/, text);
    assert.match(reply, /vừa phải/, text);
  }
  // Hỏi CÁCH ĂN ("với sữa chua không đường") không phải câu hỏi thành phần đường.
  for (const text of ['Loại nào ăn luôn được với sữa chua không đường', 'Buổi sáng c ăn với sữa chua ko đường loại nào dễ ăn a? C mới mua lần đầu ko biét loại nào hợp', 'Ngâm trong sữa tươi ko đường là đc đúng ko ạ']) {
    assert.notEqual(tpl(ruleIntent(text, inbox({ botLastTemplateId: 'GENERAL_INFO', botLastAgeMin: 3 }))), 'NO_ADDED_SUGAR', text);
  }
});

// ===== 2. Combo 10 gói chỉ còn Xanh =====
test('2. danh mục seed: Combo 10 gói Nâu / Mix / Cam tắt, chỉ Combo 10 gói Xanh bật; hộp không ghi màu = Combo 10 gói Xanh', () => {
  const boxes = products.filter(item => /^CB10-/.test(item.sku));
  // R17 (chủ shop 10/10, quyết định 1): Combo 10 gói Cam bán lại; Nâu / Mix vẫn tắt.
  assert.deepEqual(boxes.filter(item => item.active !== false).map(item => item.sku).sort(), ['CB10-CAM-G30', 'CB10-XANH-G35']);
  assert.deepEqual(boxes.filter(item => item.active === false).map(item => item.sku).sort(), ['CB10-MIX', 'CB10-NAU-G35']);
  assert.deepEqual(commentBasket('1 hộp'), [{ product: 'Combo 10 gói Xanh', quantity: 1 }]);
  assert.deepEqual(commentBasket('cho em 1 hộp 10 gói'), [{ product: 'Combo 10 gói Xanh', quantity: 1 }]);
  assert.deepEqual(commentBasket('lấy 1 hộp mix'), []);
  assert.deepEqual(commentBasket('lấy 1 hộp nâu'), []);
  assert.match(prompt, /Combo 10 gói Xanh \(combo 10 gói chỉ còn vị Xanh\)/);
});

test('2. giỏ Facebook Shop mang mã combo 10 gói đã tắt (CB10-MIX / CB10-NAU-G35) → ghi nhận + thẻ nhân viên, không báo giá / không đoán món', () => {
  for (const sku of ['CB10-MIX', 'CB10-NAU-G35']) {
    const reply = cartQuickReply([{ sku, quantity: 1, name: sku }], templates, {});
    assert.ok(reply, sku);
    assert.ok(['SHOP_CART_UNKNOWN', 'SHOP_CART_STAFF', 'CSKH_HANDOFF'].includes(reply.templateId), `${sku}: ${reply.templateId}`);
    assert.equal(reply.attention, true, sku);
    assert.ok(!reply.pendingOrder?.items?.length, sku);
  }
});

// ===== 3. Mặc định Túi Xanh =====
test('3. luật: không nêu vị → N Túi Xanh ("Lấy 2 túi", "Mua hai gói ngũ cốc", "2 túi bất kì", "combo 2", "C lấy 2 túi", "Mình lấy 2 túi nhé shop")', () => {
  for (const [text, n] of [['Lấy 2 túi', '2'], ['Mua hai gói ngũ cốc', '2'], ['2 túi bất kì', '2'], ['combo 2', '2'], ['lấy combo 3', '3'], ['C lấy 2 túi', '2'], ['Mình lấy 2 túi nhé shop', '2'], ['lấy 1 túi', '1'], ['Chị lấy 2 túi miễn síp nha', '2']]) {
    const result = ruleIntent(text, inbox());
    assert.deepEqual([tpl(result), result?.value?.Product_N1, result?.value?.No_A], ['ORDER_ADDRESS', X, n], text);
    assert.ok(result.defaultFlavour, `${text}: đánh dấu mặc định`);
  }
});

test('3. KHÔNG mặc định: khách nêu vị, khách hỏi, khách muốn nhiều vị chưa nêu, gói nhỏ, bảng giá sản phẩm khác, có ảnh', () => {
  // Khách nêu vị (kể cả "nguyên bản" kèm Vàng) → giỏ đúng vị.
  assert.deepEqual([tpl(ruleIntent('Đặt mua 2 gói Ngũ cốc ăn sáng màu xanh', inbox())), ruleIntent('Đặt mua 2 gói Ngũ cốc ăn sáng màu xanh', inbox()).value.Product_N1], ['ORDER_ADDRESS', X]);
  assert.equal(ruleIntent('Lấy 2 túi. 1 vàng. 1 xanh', inbox())?.defaultFlavour, undefined);
  // Hỏi → tư vấn / hỏi vị như cũ.
  assert.equal(tpl(ruleIntent('vị nào ngon', inbox())), 'RECOMMEND_BEGINNER');
  assert.equal(tpl(ruleIntent('có mấy vị', inbox())), 'GENERAL_INFO');
  assert.equal(tpl(ruleIntent('Lay 2 tui mà 2vị dc k ah', inbox())), 'ASK_FLAVOR');
  assert.equal(tpl(ruleIntent('lấy 2 túi khác vị', inbox())), 'ASK_FLAVOR');
  assert.notEqual(tpl(ruleIntent('Mua hai gói ngũ cốc giá như nào an', inbox())), 'ORDER_ADDRESS');
  assert.equal(ruleIntent('1 túi miễn ship hả', inbox())?.defaultFlavour, undefined);
  // Gói nhỏ / combo 10 gói, bảng giá sản phẩm khác (Vàng, Nghệ Lành), khách có ảnh → như cũ.
  assert.equal(ruleIntent('lấy 2 gói', inbox({ smallPackContext: true }))?.defaultFlavour, undefined);
  assert.equal(ruleIntent('lấy 1 gói nhỏ', inbox())?.defaultFlavour, undefined);
  assert.equal(ruleIntent('lấy 2 túi', inbox({ quotedProduct: V }))?.defaultFlavour, undefined);
  assert.equal(ruleIntent('lấy 2 túi', inbox({ lastQuoteName: V }))?.defaultFlavour, undefined);
  assert.equal(ruleIntent('lấy 2 gói', inbox({ contextProduct: 'Bột ngũ cốc Nghệ Lành hộp 14 gói' }))?.defaultFlavour, undefined);
  assert.equal(ruleIntent('lấy 2 túi', inbox({ customerImageRecently: true }))?.defaultFlavour, undefined);
  // Bảng giá Túi Xanh vừa gửi → vẫn Túi Xanh.
  assert.equal(ruleIntent('lấy 2 túi', inbox({ quotedProduct: X }))?.value?.Product_N1, X);
});

test('3. ca thật "Đặt mua 2 gói Ngũ cốc ăn sáng màu xanh / ĐC … / ĐT …" (…4455835868) vẫn lên đơn 2 Túi Xanh 298k, không câu mặc định', async () => {
  const sim = new Sim({ psid: 'own-kim' });
  const ib = sim.inbox();
  const turn = await sim.send(ib, `Đặt mua 2 gói Ngũ cốc ăn sáng màu xanh\nĐC: ${ADDR}\nĐT: ${PHONE}`);
  assert.deepEqual(turn.created.map(order => [codes(order.items), order.total]), [[['2 GRA-XANH-Z450'], 298000]]);
  assert.doesNotMatch(said(turn), /chưa chọn vị/);
});

test('3. "Lấy 2 túi" + SĐT + địa chỉ → đơn 2 Túi Xanh 298k, tin ghi rõ "2 Túi Xanh nguyên bản 450g"', async () => {
  const sim = new Sim({ psid: 'own-2bag' });
  const ib = sim.inbox();
  const turn = await sim.send(ib, `Lấy 2 túi\n${PHONE}\n${ADDR}`);
  assert.deepEqual(turn.created.map(order => [codes(order.items), order.total]), [[['2 GRA-XANH-Z450'], 298000]]);
  assert.match(turn.sent[0].text, /em lên 2 Túi Xanh nguyên bản 450g/);
  assert.match(said(turn), /đổi sang Túi Vàng nhiều hạt hay Túi Nâu cacao/);
});

test('3. "Mua hai gói ngũ cốc" → giỏ 2 Túi Xanh + câu ghi rõ món, xin SĐT/địa chỉ (không hỏi vị)', async () => {
  const sim = new Sim({ psid: 'own-cereal' });
  const ib = sim.inbox();
  const turn = await sim.send(ib, 'Mua hai gói ngũ cốc');
  assert.equal(turn.result.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(codes(ib.pendingOrder.items), ['2 GRA-XANH-Z450']);
  assert.match(turn.sent[0].text, /em lên 2 Túi Xanh nguyên bản 450g/);
  assert.equal(turn.asked.length, 0, 'không cần mô hình');
});

test('3. "2 túi bất kì gửi về địa chỉ cũ" (có đơn trước) → đơn 2 Túi Xanh, SĐT + địa chỉ đơn cũ', async () => {
  const sim = new Sim({ psid: 'own-old' });
  const ib = sim.inbox({ customerOrders: [{ id: 'old1', createdAt: Date.now() - 20 * 24 * 60 * MIN, phone: PHONE, address: ADDR, total: 298000, products: [{ name: V, sku: 'GRA-VANG-H350', quantity: 2 }], status: 'Đã giao' }] });
  const turn = await sim.send(ib, '2 túi bất kì gửi về địa chỉ cũ');
  assert.deepEqual(turn.created.map(order => [codes(order.items), order.phone, order.address]), [[['2 GRA-XANH-Z450'], PHONE, ADDR]]);
  assert.match(turn.sent[0].text, /em lên 2 Túi Xanh nguyên bản 450g/);
  // "Lấy 2 túi như cũ gửi địa chỉ cũ" = món như đơn trước → không mặc định Túi Xanh.
  assert.equal(ruleIntent('Lấy 2 túi như cũ gửi địa chỉ cũ nhé', inbox({ hasPreviousDelivery: true }))?.defaultFlavour, undefined);
  assert.equal(ruleIntent('2 túi bất kì gửi về địa chỉ cũ', inbox({ hasPreviousDelivery: false }))?.defaultFlavour, undefined);
});

test('3. SĐT + địa chỉ sau bảng giá chung → đơn 1 Túi Xanh; sau bảng giá Túi Vàng / lời chào → vẫn hỏi vị', () => {
  const text = `${PHONE} ${ADDR}`;
  const general = ruleIntent(text, inbox({ botLastTemplateId: 'GENERAL_INFO', botLastAgeMin: 2 }));
  assert.deepEqual([general?.rule, general?.value?.Product_N1, general?.value?.No_A, general?.value?.Phone_Number], ['ORDER_INFO_DEFAULT_XANH', X, '1', PHONE]);
  assert.equal(ruleIntent(text, inbox({ botLastTemplateId: 'GENERAL_INFO', botLastAgeMin: 2, askedBagCount: 2 }))?.value?.No_A, '2');
  assert.equal(tpl(ruleIntent(text, inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastAgeMin: 2, quotedProduct: V }))), 'ORDER_INFO_ASK_FLAVOR');
  assert.equal(tpl(ruleIntent(text, inbox({ botLastTemplateId: 'WELCOME', botLastAgeMin: 2 }))), 'ORDER_INFO_ASK_FLAVOR');
});

test('3. sau câu mặc định khách nêu vị khác → đổi cả N túi ("vàng", "đổi sang túi vàng nha"); vị thứ hai trong 3 phút vẫn tách 1 + 1', async () => {
  for (const text of ['vàng', 'đổi sang túi vàng nha']) {
    const sim = new Sim({ psid: `own-swap-${text.length}` });
    const ib = sim.inbox();
    await sim.send(ib, 'Lấy 2 túi');
    const turn = await sim.send(ib, text);
    assert.deepEqual(codes(ib.pendingOrder.items), ['2 GRA-VANG-H350'], text);
    assert.doesNotMatch(said(turn), /chưa chọn vị/);
  }
  // Ca thật …9280803337: "Lây em 2 túi" → "Túi vàng nhiêu hat" → "Túi nâu cacao" = 1 Vàng + 1 Nâu.
  const sim = new Sim({ psid: 'own-split' });
  const ib = sim.inbox();
  await sim.send(ib, 'Lây em 2 túi');
  await sim.send(ib, 'Túi vàng nhiêu hat', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: V, No_A: '2' } });
  await sim.send(ib, 'Túi nâu cacao', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '2' } });
  assert.deepEqual(codes(ib.pendingOrder.items), ['1 GRA-NAU-Z350', '1 GRA-VANG-H350']);
});

test('3. đơn bot vừa tạo (≤ 60 phút) từ Túi Xanh mặc định, khách "à chị lấy túi vàng nhé" → sửa đơn thành 2 Túi Vàng', async () => {
  const sim = new Sim({ psid: 'own-order-swap' });
  const at = Date.now() - 5 * MIN;
  const ib = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: at, customerOrders: [{ id: 'o1', automatic: true, createdAt: at, phone: PHONE, address: ADDR, total: 298000, products: [{ name: X, sku: 'GRA-XANH-Z450', quantity: 2 }], status: 'Mới' }] });
  sim.history(ib, 'incoming', `Lấy 2 túi ${PHONE} ${ADDR}`, 6 * MIN);
  sim.history(ib, 'outgoing', renderChatbotReply({ template_id: 'DEFAULT_FLAVOUR_NOTE', values: { count: '2' } }, templates, {}).messages[0], 5 * MIN, { sender: 'bot' });
  const turn = await sim.send(ib, 'à chị lấy túi vàng nhé');
  assert.equal(turn.result.templateId, 'ORDER_UPDATE');
  assert.deepEqual(turn.created.map(order => [order.updateOrderId, codes(order.items)]), [['o1', ['2 GRA-VANG-H350']]]);
});

test('3. "1 vị ca cao, 1 ngủ cốc" (…8040193418) → 1 Nâu + 1 Túi Xanh (phần "ngũ cốc" mặc định Xanh, mô hình đoán Vàng bị bỏ)', async () => {
  const sim = new Sim({ psid: 'own-a8' });
  const ib = sim.inbox();
  const turn = await sim.send(ib, '1 túi vị ca cao, 01 túi hạt ngũ cốc', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '1', Product_N2: V, No_B: '1' } });
  assert.deepEqual(codes(ib.pendingOrder.items), ['1 GRA-NAU-Z350', '1 GRA-XANH-Z450']);
  assert.match(turn.sent[0].text, /em lên 1 Túi Xanh nguyên bản 450g/);
});

test('3. giỏ mô hình đoán khi khách CÓ gửi ảnh, hay đang hỏi "nguyên bản" → không mặc định (hỏi vị như cũ)', async () => {
  const sim = new Sim({ psid: 'own-img' });
  const ib = sim.inbox({ botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: Date.now() - MIN, pendingOrder: { items: [], key: '', at: Date.now() - 2 * MIN, phone: PHONE, address: ADDR, addressAsks: 0 } });
  sim.history(ib, 'incoming', '', 3 * MIN, { type: 'image' });
  sim.history(ib, 'outgoing', 'Dạ chị muốn lấy vị nào và mỗi vị mấy túi để em lên đơn nha ạ?', MIN, { sender: 'bot' });
  const turn = await sim.send(ib, 'Gởi c nhé', { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: V, No_A: '1', Phone_Number: PHONE, Customer_Address: ADDR } });
  assert.deepEqual(turn.created, []);
  assert.equal(turn.result.templateId, 'ORDER_INFO_ASK_FLAVOR');
});

// ===== 4. Bám đuổi từ 8h =====
test('4. giờ yên tĩnh bám đuổi 22h–8h VN; giờ đầu ngày (8h–9h) mỗi lượt gửi tối đa 1/3 trần, ngoài giờ đó giữ trần', () => {
  const vn = (h, m = 0) => Date.UTC(2026, 9, 5, (h - 7 + 24) % 24, m);
  assert.equal(isQuietHourVN(vn(7, 0)), true);
  assert.equal(isQuietHourVN(vn(7, 45)), true);
  assert.equal(isQuietHourVN(vn(8, 0)), false);
  assert.equal(isQuietHourVN(vn(21, 59)), false);
  assert.equal(isQuietHourVN(vn(22, 0)), true);
  assert.equal(followUpRunCap(15, vn(8, 0)), 5);
  assert.equal(followUpRunCap(15, vn(8, 45)), 5);
  assert.equal(followUpRunCap(15, vn(9, 0)), 15);
  assert.equal(followUpRunCap(15, vn(14, 0)), 15);
  assert.equal(followUpRunCap(2, vn(8, 10)), 1);
  assert.equal(followUpRunCap(undefined, vn(8, 10)), 5, 'trần mặc định 15');
  assert.equal(followUpRunCap(15, vn(8, 10), false), 15, 'Gửi ngay (bỏ giờ yên tĩnh) không rải');
});
