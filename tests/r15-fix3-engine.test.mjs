// Vòng 15 sửa lần 3 (03/10) — engine theo phản biện r15/review-engine.md (N1, N2, C1–C3, T2–T7, L1–L5, ngoài phạm vi s6b/s1c)
// + engine-probe B1 (review-rules). Câu khách dùng đúng câu trong báo cáo; SĐT/địa chỉ là số giả.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, basket, seedTemplates } from './helpers/r13-engine-sim.mjs';
import { readMergeSplitReply, singleFlavourOf, stripBagWeights } from '../app/chatbot-engine.mjs';
import { adjustOrderQuantities } from '../app/chatbot-templates.mjs';
import { boughtOnMarketplace } from '../app/follow-up.mjs';
import { normalizeChatbotSettings } from '../app/chatbot-settings.mjs';

const MIN = 60 * 1000;
const ADDR = 'Thôn Trung Toàn, Xã Tam Quang, Huyện Núi Thành, Quảng Nam';
const NEWADDR = 'Số 12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
const NEWPHONE = '0987654321';
const P = { X: 'Granola Túi Xanh 450g', V: 'Granola Túi Vàng 350g', N: 'Granola Túi Nâu vị cacao 350g' };
// Lời ORDER_EXISTING_CONFIRM CŨ đang chạy trên máy chủ (r15/settings.json) — "nhắn đúng là em lên đơn liền".
const LEGACY_CONFIRM = 'Dạ {title} ơi, em thấy mình đang có đơn {existing_items} đặt lúc {existing_at}, hiện {existing_state} ạ 🌾 Mình muốn đặt THÊM một đơn mới gồm {cart} nữa đúng không ạ? {Title} nhắn "đúng" giúp em là em lên đơn liền; còn nếu là đơn cũ thì {title} cứ nhắn em kiểm tra cho mình nha ạ.';
const codes = items => (items || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const oldOrder = (ago = 120 * MIN) => ({ id: 'o-old', createdAt: Date.now() - ago, phone: PHONE, address: ADDR, rawAddress: ADDR, total: 298000, products: [{ name: P.X, sku: 'GRA-XANH-Z450', quantity: 2 }], status: 'Mới', automatic: true });

async function askedMergeSplit(psid, { legacy = false } = {}) {
  const sim = new Sim({ psid, settings: legacy ? { messageTemplates: { ...seedTemplates, ORDER_EXISTING_CONFIRM: LEGACY_CONFIRM } } : {} });
  const inbox = sim.inbox({ botLastTemplateId: 'THANK_YOU', botLastReplyAt: Date.now() - 90 * MIN, customerOrders: [oldOrder()] });
  const ask = await sim.send(inbox, 'Cho chị thêm 2 túi vàng', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: P.V, No_A: '2' } });
  assert.equal(ask.result.templateId, 'ORDER_EXISTING_CONFIRM');
  return { sim, inbox };
}

// R15-fix4 (chủ shop 03/10, thiết kế gộp/tách mới): readMergeSplitAnswer (đọc phủ định / câu hỏi / "thôi khỏi") đã bỏ — chỉ câu NGẮN
// VÀ RÕ mới tự làm (readMergeSplitReply); câu phủ định / hỏi / "thôi khỏi" → bạn phụ trách, giữ giỏ. Hai ca dưới thay ca cũ.
test('readMergeSplitReply: chỉ câu ngắn rõ là gộp/tách; phủ định / câu hỏi / thôi khỏi → "" (bạn phụ trách)', () => {
  for (const text of ['không phải đơn mới đâu, là đơn cũ đó', 'ko, ý c là đơn cũ thôi, không đặt đơn mới', 'không tách đâu, gộp vào đơn cũ', 'thôi khỏi, không cần đơn khác',
    'gộp hay tách cái nào ship nhanh hơn?', 'tách ra 2 đơn được không em?', 'không sao, tách đơn mới nha', 'giao chung cư như cũ nha', 'C ko lấy nữa thì có giảm tiền ko']) {
    assert.equal(readMergeSplitReply(text), '', text);
  }
  assert.equal(readMergeSplitReply('tách đơn mới giúp c'), 'split');
  assert.equal(readMergeSplitReply('gộp chung luôn em'), 'merge');
});

test('N1: câu phủ định / câu hỏi / "thôi khỏi" sau câu gộp-tách → bạn phụ trách, KHÔNG tạo/sửa/ghi chú đơn, giữ giỏ', async () => {
  let n = 0;
  for (const text of ['không phải đơn mới đâu, là đơn cũ đó', 'ko, ý c là đơn cũ thôi, không đặt đơn mới', 'thôi khỏi, không cần đơn khác', 'gộp hay tách cái nào ship nhanh hơn?',
    'tách ra 2 đơn được không em?', 'không tách đâu, gộp vào đơn cũ']) {
    const { sim, inbox } = await askedMergeSplit(`fx3n1${++n}`);
    const turn = await sim.send(inbox, text, { llm: { template_id: 'ORDER_STATUS' } });
    assert.deepEqual(turn.created, [], text);
    assert.deepEqual(turn.notes, [], text);
    assert.match(turn.result.templateId, /^STAFF_WAIT_/, text);
    assert.deepEqual(codes(inbox.pendingOrder.items), ['2 GRA-VANG-H350'], text);
  }
});

test('N2/C1: trả lời câu gộp-tách bằng SĐT + địa chỉ MỚI → đơn mới với đúng SĐT/địa chỉ trong tin (không dùng thông tin cũ, không im)', async () => {
  let n = 0;
  for (const text of [`tách đơn riêng nha, gửi về ${NEWADDR} ${NEWPHONE}`, `Gửi cho mẹ c nha ${NEWPHONE} ${NEWADDR}`, `${NEWPHONE} ${NEWADDR}`]) {
    const { sim, inbox } = await askedMergeSplit(`fx3n2${++n}`);
    const turn = await sim.send(inbox, text, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: P.V, No_A: '2', Phone_Number: NEWPHONE, Customer_Address: NEWADDR } });
    assert.equal(turn.result.skipped, undefined, text);
    assert.equal(turn.created.length, 1, text);
    assert.equal(turn.created[0].phone, NEWPHONE);
    assert.match(turn.created[0].address, /Lê Lợi/);
  }
});

test('C1: trả lời bằng SĐT + địa chỉ CŨ / "giao chung cư như cũ" → bạn phụ trách MỘT lần (không im lượt đầu), lượt sau im + thẻ, không hỏi lại', async () => {
  // R15-fix4 (thiết kế gộp/tách mới): không bao giờ hỏi lại gộp/tách (trước: hỏi lại một lần rồi mới bạn phụ trách).
  for (const [i, text] of [`${PHONE} ${ADDR}`, 'giao chung cư như cũ nha'].entries()) {
    const { sim, inbox } = await askedMergeSplit(`fx3c1${i}`);
    const first = await sim.send(inbox, text, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: P.V, No_A: '2', Phone_Number: PHONE, Customer_Address: ADDR } });
    assert.match(String(first.result.templateId || ''), /^STAFF_WAIT_/, text);
    assert.ok(first.sent.length > 0);
    assert.equal(first.created.length, 0);
    const second = await sim.send(inbox, text, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: P.V, No_A: '2', Phone_Number: PHONE, Customer_Address: ADDR } });
    assert.ok(second.result.skipped, text);
    assert.deepEqual(second.sent, []);
    assert.equal(second.created.length, 0);
    assert.ok(inbox.labels.includes('handoff'));
  }
});

test('C2: mẫu CŨ còn chạy ("nhắn đúng là lên đơn") → "đúng rồi"/"Đúng nha" lên đơn như bản cũ; mẫu MỚI → "đúng" mơ hồ → bạn phụ trách', async () => {
  for (const [i, text] of ['đúng rồi', 'Đúng nha', 'ok em'].entries()) {
    const { sim, inbox } = await askedMergeSplit(`fx3c2l${i}`, { legacy: true });
    const turn = await sim.send(inbox, text, { llm: { template_id: 'THANK_YOU' } });
    assert.equal(turn.result.templateId, 'ORDER_CONFIRMATION', text);
    assert.deepEqual(codes(turn.created[0].items), ['2 GRA-VANG-H350']);
    assert.equal(turn.created[0].phone, PHONE);
  }
  const { sim, inbox } = await askedMergeSplit('fx3c2n');
  const turn = await sim.send(inbox, 'Đúng nha', { llm: { template_id: 'THANK_YOU' } });
  assert.match(turn.result.templateId, /^STAFF_WAIT_/);
  assert.equal(turn.created.length, 0);
  // Sau STAFF_WAIT, khách nói rõ → xử lý, không im 30 phút.
  const split = await sim.send(inbox, 'tách đơn mới nha', { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: P.V, No_A: '2', Phone_Number: PHONE, Customer_Address: ADDR } });
  assert.equal(split.result.templateId, 'ORDER_CONFIRMATION');
  assert.equal(split.created.length, 1);
});

test('C2/T1: im 30 phút sau STAFF_WAIT không nuốt tin chốt/đặt/STK/chọn túi/địa chỉ; câu "hỏi lại" vẫn im', async () => {
  let n = 0;
  for (const text of ['Chốt đơn cho chị nha', 'đặt hàng', 'cho c xin stk', 'Mình lấy Tropical', 'Ấp Phú Lợi B, Long An']) {
    const sim = new Sim({ psid: `fx3t1${++n}` });
    const inbox = sim.inbox({ botLastTemplateId: 'STAFF_WAIT_OPEN', botLastReplyAt: Date.now() - 5 * MIN });
    const turn = await sim.send(inbox, text, { llm: { template_id: 'GENERAL_INFO' } });
    assert.notEqual(turn.result.skipped, 'đang chờ bạn phụ trách trả lời', text);
  }
  const sim = new Sim({ psid: 'fx3t1q' });
  const inbox = sim.inbox({ botLastTemplateId: 'STAFF_WAIT_OPEN', botLastReplyAt: Date.now() - MIN });
  const quiet = await sim.send(inbox, 'Nhưng giờ mua , choits đơn thấy khoing ghi vào nữa nên c hỏi lại', { llm: { template_id: 'ORDER_NOTE' } });
  assert.equal(quiet.result.skipped, 'đang chờ bạn phụ trách trả lời');
});

test('L4: "ok đặt thêm" sau câu gộp-tách → đơn mới với SĐT/địa chỉ đơn cũ (không xin lại); "đặt luôn em" chỉ đồng ý với lời cũ', async () => {
  // R15-fix4 (thiết kế gộp/tách mới): "đặt thêm" là TÁCH rõ; "đặt luôn" không nói gộp hay tách → với lời seed là bạn phụ trách.
  const { sim, inbox } = await askedMergeSplit('fx3l4a');
  const turn = await sim.send(inbox, 'ok đặt thêm', { llm: { template_id: 'THANK_YOU' } });
  assert.equal(turn.result.templateId, 'ORDER_CONFIRMATION');
  assert.equal(turn.created[0].phone, PHONE);
  const vague = await askedMergeSplit('fx3l4b');
  const staff = await vague.sim.send(vague.inbox, 'đặt luôn em', { llm: { template_id: 'THANK_YOU' } });
  assert.match(staff.result.templateId, /^STAFF_WAIT_/);
  assert.equal(staff.created.length, 0);
  const legacy = await askedMergeSplit('fx3l4c', { legacy: true });
  const yes = await legacy.sim.send(legacy.inbox, 'đặt luôn em', { llm: { template_id: 'THANK_YOU' } });
  assert.equal(yes.result.templateId, 'ORDER_CONFIRMATION');
  assert.equal(yes.created[0].phone, PHONE);
});

test('C3: khối lượng không phải số túi — "Túi vàng 350g" / "Túi xanh 450 g" / "vàng 350" sau đơn 2 Nâu = 1 Nâu + 1 vị mới', async () => {
  assert.equal(stripBagWeights('Túi xanh 450 g'), 'Túi xanh');
  assert.equal(stripBagWeights('vàng 350'), 'vàng');
  assert.equal(stripBagWeights('2 túi 450 g giá là 298 hả em'), '2 túi giá là 298 hả em');
  assert.equal(singleFlavourOf('Túi xanh 450g'), 'xanh');
  let n = 0;
  for (const second of ['Túi vàng 350g', 'Túi xanh 450 g', 'vàng 350']) {
    const sim = new Sim({ psid: `fx3c3${++n}` });
    const order = { id: 'o1', createdAt: Date.now() - 15000, phone: PHONE, address: ADDR, rawAddress: ADDR, total: 288000, products: [{ name: P.N, sku: 'GRA-NAU-Z350', quantity: 2 }], status: 'Mới', automatic: true };
    const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 12000, customerOrders: [order], flavourFromCount: { count: 2, code: 'GRA-NAU-Z350', at: Date.now() - 12000, orderId: 'o1' } });
    const turn = await sim.send(inbox, second, { llm: { template_id: 'ORDER_UPDATE', Product_N1: /xanh/i.test(second) ? P.X : P.V, No_A: '1', Phone_Number: PHONE, Customer_Address: ADDR } });
    assert.equal(turn.created.length, 1, second);
    assert.equal(turn.created[0].total, 293000, second);
    assert.ok(codes(turn.created[0].items).includes('1 GRA-NAU-Z350'), second);
  }
});

test('T3: "2 túi" → "xanh" → "Vàng đi" / "lấy vàng" / "cho vàng luôn" / "vàng nha" = đổi ý cả giỏ (2 Vàng); "Túi vàng" trơn vẫn tách', async () => {
  for (const text of ['Vàng đi', 'vàng nha', 'lấy vàng', 'cho vàng luôn']) assert.equal(singleFlavourOf(text, { strict: true }), '', text);
  for (const text of ['Ca cao', 'Túi vàng', 'Túi vàng nhiêu hat']) assert.notEqual(singleFlavourOf(text, { strict: true }), '', text);
  let n = 0;
  for (const [text, want] of [['Vàng đi', ['2 GRA-VANG-H350']], ['cho vàng luôn', ['2 GRA-VANG-H350']], ['Túi vàng', ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']]]) {
    const sim = new Sim({ psid: `fx3t3${++n}` });
    const inbox = sim.inbox();
    await sim.send(inbox, 'Lấy em 2 túi', { llm: { template_id: 'ASK_FLAVOR' } });
    await sim.send(inbox, 'xanh', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: P.X, No_A: '2' } });
    await sim.send(inbox, text, { llm: { template_id: 'ORDER_ADDRESS', Product_N1: P.V, No_A: '2' } });
    assert.deepEqual(codes(inbox.pendingOrder.items), want, text);
  }
});

test('T4: giữ 2 Xanh, "đổi 1 túi sang vàng được ko" (mô hình trả 2 Vàng) → 1 Xanh + 1 Vàng, không 2 Vàng', async () => {
  const sim = new Sim({ psid: 'fx3t4' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(2)], 2 * MIN) });
  await sim.send(inbox, 'đổi 1 túi sang vàng được ko', { llm: (payload, call) => call === 1 ? { template_id: 'ORDER_ADDRESS', Product_N1: P.V, No_A: '2' } : { template_id: 'GENERAL_INFO' } });
  assert.deepEqual(codes(inbox.pendingOrder.items), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
});

test('T6: mặc cả (hứa yến mạch) rồi giảm còn 1 túi → đơn 1 túi KHÔNG ghi chú "Tặng yến mạch"', async () => {
  const sim = new Sim({ psid: 'fx3t6' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], MIN) });
  await sim.send(inbox, 'giảm giá cho chị đi', { llm: { template_id: 'GENERAL_INFO' } });
  assert.equal(inbox.pendingOrder.oatsGift, true);
  await sim.send(inbox, 'thôi lấy 1 túi xanh thôi', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: P.X, No_A: '1' } });
  assert.notEqual(inbox.pendingOrder.oatsGift, true);
  const turn = await sim.send(inbox, `${PHONE} ${ADDR}`, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: P.X, No_A: '1', Phone_Number: PHONE, Customer_Address: ADDR } });
  assert.doesNotMatch(String(turn.created[0].addressCheck || ''), /yến mạch/i);
});

test('L1 + ngoài phạm vi (s6b): "chỉ vàng" áp đơn; "thêm 1 túi vàng nữa nha" mà đơn sửa ra ít túi hơn → không áp (ORDER_WRONG)', async () => {
  const sim = new Sim({ psid: 'fx3l1' });
  const order = { id: 'o1', createdAt: Date.now() - 5 * MIN, phone: PHONE, address: ADDR, rawAddress: ADDR, products: [{ name: P.N, sku: 'GRA-NAU-Z350', quantity: 1 }, { name: P.V, sku: 'GRA-VANG-H350', quantity: 1 }], status: 'Mới', automatic: true };
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 4 * MIN, customerOrders: [order] });
  const only = await sim.send(inbox, 'chỉ vàng', { llm: { template_id: 'ORDER_UPDATE', Product_N1: P.V, No_A: '1', Phone_Number: PHONE, Customer_Address: ADDR } });
  assert.equal(only.result.templateId, 'ORDER_UPDATE');
  const sim2 = new Sim({ psid: 'fx3s6b' });
  const order2 = { id: 'o2', createdAt: Date.now() - 5 * MIN, phone: PHONE, address: ADDR, rawAddress: ADDR, products: [{ name: P.X, sku: 'GRA-XANH-Z450', quantity: 2 }], status: 'Mới', automatic: true };
  const inbox2 = sim2.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 4 * MIN, customerOrders: [order2] });
  const more = await sim2.send(inbox2, 'thêm 1 túi vàng nữa nha', { llm: { template_id: 'ORDER_UPDATE', Product_N1: P.X, No_A: '2', Product_N2: P.V, No_B: '1', Phone_Number: PHONE, Customer_Address: ADDR } });
  assert.ok(!more.created.some(o => o.total === 189000), JSON.stringify(more.created));
});

test('ngoài phạm vi (s1c): "Chốt chị 2tui" + SĐT + địa chỉ → hỏi vị, giỏ chờ giữ cả địa chỉ; "Ca cao" lên đơn luôn', async () => {
  const sim = new Sim({ psid: 'fx3s1c' });
  const inbox = sim.inbox();
  const addr = 'Thôn Trung toàn xã tam quang huyện núi thành tỉnh quang nam';
  await sim.send(inbox, `Chốt  chị  2tui\n${PHONE}\n${addr}`, { llm: { template_id: 'ASK_FLAVOR', No_A: '2', Phone_Number: PHONE, Customer_Address: addr } });
  assert.equal(inbox.pendingOrder.address, addr);
  const turn = await sim.send(inbox, 'Ca cao', { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: P.N, No_A: '2', Phone_Number: PHONE, Customer_Address: addr } });
  assert.equal(turn.created.length, 1);
});

test('L5: vừa báo mua trên sàn rồi lập giỏ mới → hết chặn bám đuổi', () => {
  const at = Date.now() - 30000;
  assert.equal(boughtOnMarketplace({ botLastTemplateId: 'ORDER_ADDRESS', boughtElsewhereAt: at, botLastReplyAt: at + 10000 }), true);
  assert.equal(boughtOnMarketplace({ botLastTemplateId: 'ORDER_ADDRESS', boughtElsewhereAt: at, botLastReplyAt: at + 10000, pendingOrder: basket([XANH(2)], 10000) }), false);
});

test('T2/L6: mediaWaitMs chuẩn hoá 0–20000, trống = không ghi khoá (engine dùng 12000)', () => {
  assert.equal(normalizeChatbotSettings({ mediaWaitMs: 50000 }).mediaWaitMs, 20000);
  assert.equal(normalizeChatbotSettings({ mediaWaitMs: '5000' }).mediaWaitMs, 5000);
  assert.equal('mediaWaitMs' in normalizeChatbotSettings({}), false);
});

test('T2: ảnh bill ngay sau BANK_TRANSFER không chờ 12 giây → PAYMENT_RECEIVED_CHECK như bản cũ', async () => {
  const sim = new Sim({ psid: 'fx3t2', settings: { mediaWaitMs: 300 } });
  const inbox = sim.inbox({ botLastTemplateId: 'BANK_TRANSFER', botLastReplyAt: Date.now() - 2 * MIN });
  const image = { id: 'img-1', mid: 'img-1', direction: 'incoming', type: 'image', text: '', images: ['https://example.invalid/bill.jpg'], createdAt: Date.now() };
  sim.list(inbox.id).push(image);
  const pending = sim.send(inbox, '', { existing: image });
  await new Promise(resolve => setTimeout(resolve, 60));
  const follow = { id: 'f-1', mid: 'f-1', direction: 'incoming', type: 'text', text: 'ok', createdAt: Date.now() };
  sim.list(inbox.id).push(follow);
  const turn = await pending;
  assert.equal(turn.result.templateId, 'PAYMENT_RECEIVED_CHECK');
});

test('engine-probe B1 (adjustOrderQuantities): giữ 3 Xanh, "giảm đi 1 túi" → còn 2; "bớt còn 1 túi" → 1', () => {
  const held = [XANH(3)];
  assert.deepEqual(adjustOrderQuantities([XANH(2)], { messageText: 'giảm đi 1 túi', heldItems: held }).map(item => item.quantity), [2]);
  assert.deepEqual(adjustOrderQuantities([XANH(2)], { messageText: 'bỏ 1 túi nha', heldItems: held }).map(item => item.quantity), [2]);
  assert.deepEqual(adjustOrderQuantities([XANH(2)], { messageText: 'bớt còn 1 túi', heldItems: held }).map(item => item.quantity), [1]);
  assert.deepEqual(adjustOrderQuantities([XANH(2)], { messageText: '1 túi thôi', heldItems: held }).map(item => item.quantity), [1]);
});

test('T5: bấm lại đúng giỏ Shop đang giữ khi máy chủ chờ POS → nhắc giỏ một lần rồi im (không ack lại)', async () => {
  const shopName = 'Granola Mới Ngũ Cốc Ăn Sáng Healthy Lành Mạnh Với Hạt Dinh Dưỡng Trái Cây Từ Giọt Nắng';
  const text = `Khách chọn mua từ Facebook Shop: ${shopName} (CB-XANH+NAU) — 293.000đ`;
  const message = { cart: [{ name: shopName, sku: 'CB-XANH+NAU', quantity: 1, price: 293000, image: '' }] };
  const sim = new Sim({ psid: 'fx3t5', settings: { shopOrderWaitMs: 60, shopOrderFollowUpMs: [] } });
  const inbox = sim.inbox({ pancakeConversationId: 'page_user', gender: 'female' });
  const extra = { findShopOrder: async () => null };
  const age = ms => { for (const item of sim.list(inbox.id)) item.createdAt -= ms; inbox.botLastReplyAt -= ms; if (inbox.pendingOrder) inbox.pendingOrder.at -= ms; };
  const first = await sim.send(inbox, text, { message, extra });
  assert.ok(first.sent.length >= 2, 'lần đầu: ack + xin SĐT');
  age(2 * MIN);
  const second = await sim.send(inbox, text, { message, extra });
  assert.equal(second.result.templateId, 'ORDER_ADDRESS_REMIND');
  assert.equal(second.sent.length, 1);
  age(MIN);
  const third = await sim.send(inbox, text, { message, extra });
  assert.equal(third.sent.length, 0);
});

test('L2 (r13 …790172878): góp ý live "Nói chả nghe gì vậy" (mô hình CSKH_HANDOFF) khi bot vừa trả lời công khai → vẫn gắn thẻ như bản cũ', async () => {
  const sim = new Sim({ psid: 'fx3l2' });
  const thread = sim.comment({ labels: ['livestream'], post: { id: 'p1', message: 'Săn deal cùng Giọt Nắng ạ', isLive: true }, botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 3 * MIN });
  sim.history(thread, 'outgoing', 'Dạ chị ơi, phiên live nhà em có: Túi Xanh nguyên bản 450g', 3 * MIN, { sender: 'bot' });
  await sim.send(thread, 'Nói chả nghe gì vậy', { llm: { template_id: 'CSKH_HANDOFF' } });
  assert.ok(thread.labels.includes('handoff'));
});

test('L3 (r15 …083958786): "2 gói nhỏ tặng kèm lấy nâu nhé" (mô hình ORDER_NOTE) → ghi chú đơn như bản cũ, không STAFF_WAIT', async () => {
  const sim = new Sim({ psid: 'fx3l3' });
  const order = { id: 'o-3', createdAt: Date.now() - 10 * MIN, phone: PHONE, address: ADDR, total: 298000, products: [{ name: P.X, sku: 'GRA-XANH-Z450', quantity: 2 }], status: 'Mới', automatic: true };
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 5 * MIN, customerOrders: [order], labels: ['livestream'] });
  const turn = await sim.send(inbox, '2 gói nhỏ tặng kèm lấy nâu nhé', { llm: { template_id: 'ORDER_NOTE' } });
  assert.equal(turn.result.templateId, 'ORDER_NOTE');
});
