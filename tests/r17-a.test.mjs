// Vòng 17 (10/10) — GÓI A: giỏ, sửa đơn, địa chỉ. Câu khách thật trong báo cáo r17 (đã che tên/SĐT; SĐT giả PHONE).
// Mã ca rút gọn trong tên test. Báo cáo: S\r17\out-inbox1..5.md, quyết định chủ shop S\r17\DECISIONS-R17.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, VANG, basket } from './helpers/r13-engine-sim.mjs';
import { cleanAddressText, normalizeColourTypos } from '../app/processing/order-flow.mjs';
import { commentBasket } from '../app/chatbot-engine.mjs';
import { adjustOrderQuantities, distinctKindsCount, granolaBagText, soldOutBoxNamed } from '../app/chatbot-templates.mjs';
import { countBags } from '../app/processing/intent-features.mjs';

const MIN = 60000;
const X = 'Granola Túi Xanh 450g', V = 'Granola Túi Vàng 350g', N = 'Granola Túi Nâu vị cacao 350g';
const itemsOf = list => (list || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const said = turn => turn.sent.map(item => item.text).join('\n');
const P = (name, sku, quantity) => ({ name, sku, quantity });
const order = (agoMin, products, extra = {}) => ({ id: `o-${agoMin}`, automatic: true, createdAt: Date.now() - agoMin * MIN, phone: PHONE, address: 'Sơn thành, Xã Trà Sơn, Huyện Trà Bồng, Quảng Ngãi', total: 293000, products, status: 'Mới', ...extra });

// ===== inbox3 A1: dòng hệ thống Facebook đến như tin khách =====
const SYSTEM_LINE = 'Nguyễn Văn A đã trả lời về một bài viết. Xem bài viết(https://www.facebook.com/story.php?story_fbid=1664912345678&id=103549382215599)';

test('R17 A1 (…5345827): cleanAddressText bỏ dòng "… đã trả lời về một bài viết. Xem bài viết(link)"', () => {
  const block = `${SYSTEM_LINE}\nLấy túi xanh, ${PHONE}\nDC trung tính lộ 30ấp thị xã thông bình tân hồng Đồng Tháp`;
  const cleaned = cleanAddressText(block);
  assert.doesNotMatch(cleaned, /bài viết|http|facebook|Lấy túi/iu, cleaned);
  assert.match(cleaned, /thông bình tân hồng Đồng Tháp/u);
});

test('R17 A1 (…5345827): lượt của dòng hệ thống im; địa chỉ đơn không mang "bài viết"/link dù mô hình chép cả khối', async () => {
  const sim = new Sim({ psid: 'r17a-a1' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(1)], MIN, { phone: PHONE }) });
  sim.history(inbox, 'outgoing', 'Dạ đơn của anh gồm 1 Granola Túi Xanh 450g … Anh cho em xin địa chỉ nhận hàng đầy đủ để em lên đơn gửi mình nha ạ.', 1.2 * MIN, { sender: 'bot' });
  const notice = await sim.send(inbox, SYSTEM_LINE);
  assert.ok(notice.result.skipped, JSON.stringify(notice.result));
  assert.equal(notice.sent.length, 0);
  sim.history(inbox, 'incoming', `Lấy túi xanh, ${PHONE}`, 0.5 * MIN);
  const addr = 'DC trung tính lộ 30ấp thị xã thông bình tân hồng Đồng Tháp';
  const turn = await sim.send(inbox, addr, { llm: payload => ({ template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '1', Phone_Number: PHONE, Customer_Address: `${SYSTEM_LINE}\n${String(payload?.message?.text || addr)}` }) });
  assert.equal(turn.created.length, 1, JSON.stringify(turn.result));
  assert.doesNotMatch(turn.created[0].address, /bài viết|http|facebook/iu, turn.created[0].address);
  for (const asked of turn.asked) assert.doesNotMatch(String(asked?.message?.text || ''), /bài viết/u);
});

// ===== inbox1 A3: "caccao", không cắt món mô hình đọc khi khách viết từ lạ =====

test('R17 inbox1 A3 (…2763200): "caccao" = cacao; "1 granola caccao" → giỏ 1 Xanh + 1 Nâu 293k', async () => {
  assert.match(normalizeColourTypos('Lấy 1 caccao 1 tự nhiên được ko e'), /cacao/u);
  const sim = new Sim({ psid: 'r17a-cc' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(1)], MIN) });
  const turn = await sim.send(inbox, 'C lấy 1 granola túi xanh và 1 granola caccao', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '1', Product_N2: N, No_B: '1' } });
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-NAU-Z350', '1 GRA-XANH-Z450'], said(turn));
  assert.match(said(turn), /293\.000đ/u);
});

test('R17 inbox1 A3 (…2763200): "Lấy 1 caccao 1 tự nhiên" — món mô hình đọc cho phần "1 tự nhiên" không bị lọc mất', () => {
  const items = adjustOrderQuantities([{ product: N, code: 'GRA-NAU-Z350', quantity: 1 }, { product: X, code: 'GRA-XANH-Z450', quantity: 1 }], { messageText: 'Lấy 1 caccao 1 tự nhiên được ko e', heldItems: [{ product: X, code: 'GRA-XANH-Z450', quantity: 1 }] });
  assert.deepEqual(itemsOf(items), ['1 GRA-NAU-Z350', '1 GRA-XANH-Z450']);
  // Không có "số + từ lạ": vẫn lọc theo màu khách nêu như cũ.
  assert.deepEqual(itemsOf(adjustOrderQuantities([{ product: N, code: 'GRA-NAU-Z350', quantity: 1 }, { product: X, code: 'GRA-XANH-Z450', quantity: 1 }], { messageText: 'lấy 1 túi nâu nhé' })), ['1 GRA-NAU-Z350']);
});

// ===== inbox1 A5, inbox3 A6, inbox5 A2: rác trong địa chỉ =====

test('R17 địa chỉ (inbox1 A5 …294082/…407078/…137033/…732559, inbox3 A6 …967696/…801048): bỏ câu thanh toán/đặt/hỏi quà, "Giao giúp c", chữ lẻ, nhãn "Điện thoại", "1 bọc"', () => {
  assert.equal(cleanAddressText('Minh ck trước, Thế thì cho mình 1tui thôi, Bản nà ngò xã Nà Phặc huyện Ngân Sơn Bắc Kạn'), 'Bản nà ngò xã Nà Phặc huyện Ngân Sơn Bắc Kạn');
  assert.equal(cleanAddressText('805 trần hưng đạo, tpmt, Tặng quạt gì vậy chị, P5, Mỹ Tho'), '805 trần hưng đạo, tpmt, P5, Mỹ Tho');
  assert.equal(cleanAddressText('Giao giúp c 207/2A đường số 8 phường Linh Xuân Thủ Đức'), '207/2A đường số 8 phường Linh Xuân Thủ Đức');
  assert.equal(cleanAddressText('26 tân hải, t, phường 1 Vũng Tàu'), '26 tân hải, phường 1 Vũng Tàu');
  assert.equal(cleanAddressText(`thôn Cửu lợi xã cam hoà huyện cam lâm Khánh hoà\nĐiện thoại ${PHONE}`), 'thôn Cửu lợi xã cam hoà huyện cam lâm Khánh hoà');
  assert.equal(cleanAddressText(`1 bọc 704/37a nguyễn đình chiều phường bàn cờ q3 tphcm ${PHONE}`), '704/37a nguyễn đình chiều phường bàn cờ q3 tphcm');
  // Không đụng địa chỉ thật: "Đường ĐT 741", "Khu A", tên đường có chữ "điện thoại" giữa câu không có.
  assert.equal(cleanAddressText('Đường ĐT 741 xã Tân Lập huyện Đồng Phú Bình Phước'), 'Đường ĐT 741 xã Tân Lập huyện Đồng Phú Bình Phước');
  assert.equal(cleanAddressText('Khu A, 12 Lê Lợi, phường 1, Vũng Tàu'), 'Khu A, 12 Lê Lợi, phường 1, Vũng Tàu');
});

test('R17 inbox3 A6 (…967696): "Điện thoại <sđt>" khi giỏ đã có địa chỉ → đơn không có chữ "Điện thoại" trong địa chỉ', async () => {
  const sim = new Sim({ psid: 'r17a-dt' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 0.5 * MIN, pendingOrder: basket([XANH(2)], MIN, { address: 'thôn Cửu lợi xã cam hoà huyện cam lâm Khánh hoà' }) });
  sim.history(inbox, 'incoming', 'Địa chỉ thôn Cửu lợi xã cam hoà huyện cam lâm Khánh hoà', 0.6 * MIN);
  sim.history(inbox, 'outgoing', 'Dạ … Chị cho em xin số điện thoại để em lên đơn gửi mình nha ạ.', 0.5 * MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, `Điện thoại ${PHONE}`);
  assert.equal(turn.created.length, 1, JSON.stringify(turn.result));
  assert.doesNotMatch(turn.created[0].address, /điện thoại/iu, turn.created[0].address);
});

test('R17 inbox3 A6 (…837108): "Có tặng cốc thủy tinh không em" khi giữ giỏ → không phải địa chỉ ("thủy tinh" ≠ tỉnh)', async () => {
  const sim = new Sim({ psid: 'r17a-tt' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(2)], 2 * MIN) });
  const turn = await sim.send(inbox, 'Có tặng cốc thủy tinh không em', { llm: { template_id: 'GIFT_POLICY' } });
  assert.notEqual(turn.record?.rule?.name, 'ADDRESS_PARTIAL');
  assert.equal(inbox.pendingOrder?.address || '', '');
  assert.doesNotMatch(said(turn), /đã nhận được địa chỉ/u, said(turn));
});

test('R17 inbox5 A2 (…711817): "2tui xanh 450g + bình thủy tinh" → giỏ 2 Xanh, KHÔNG lưu "bình thủy tinh" làm địa chỉ (Quận Bình Thủy)', async () => {
  const sim = new Sim({ psid: 'r17a-btt' });
  const inbox = sim.inbox({ labels: ['livestream'] });
  const turn = await sim.send(inbox, '2tui xanh 450g + bình thủy tinh', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '2' } });
  assert.notEqual(turn.record?.rule?.name, 'BASKET_ADDRESS');
  assert.equal(inbox.pendingOrder?.address || '', '');
  assert.doesNotMatch(said(turn), /đã nhận được địa chỉ|Bình Thủy/u, said(turn));
});

test('R17 inbox3 A6 (…807434): "Một xanh dương một xanh đậm gjá 2, túi ạ" — câu nêu màu không phải địa chỉ (không BAGS_ADDRESS)', async () => {
  const sim = new Sim({ psid: 'r17a-xd' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 30 * MIN });
  const turn = await sim.send(inbox, 'Một xanh dương một xanh đậm gjá 2, túi ạ');
  assert.notEqual(turn.record?.rule?.name, 'BAGS_ADDRESS');
  assert.equal(inbox.pendingOrder?.address || '', '');
});

// ===== inbox3 A6/A12: "bọc", "bị" là đơn vị túi =====

test('R17 inbox3 A12 (…967696): "Lấy hai bị" → mặc định 2 Túi Xanh (như "lấy hai bịch"), không hỏi vị', async () => {
  const sim = new Sim({ psid: 'r17a-bi' });
  const inbox = sim.inbox({ botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: Date.now() - MIN });
  const turn = await sim.send(inbox, 'Lấy hai bị', { llm: { template_id: 'ASK_FLAVOR' } });
  assert.equal(turn.asked.length, 0, 'không gọi mô hình');
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['2 GRA-XANH-Z450']);
});

test('R17 inbox3 A6 (…801048): "1 bọc 704/37a … <sđt>" → đơn 1 Túi Xanh mặc định, địa chỉ không có "1 bọc", không hỏi "mỗi loại mấy túi"', async () => {
  const sim = new Sim({ psid: 'r17a-boc' });
  const inbox = sim.inbox({});
  const turn = await sim.send(inbox, `1 bọc 704/37a nguyễn đình chiều phường bàn cờ q3 tphcm ${PHONE}`);
  assert.equal(turn.created.length, 1, said(turn));
  assert.deepEqual(itemsOf(turn.created[0].items), ['1 GRA-XANH-Z450']);
  assert.doesNotMatch(turn.created[0].address, /bọc/iu);
});

// ===== inbox2 N2 / C1 =====

test('R17 inbox2 N2 (…2934055): "1 hộp dừa sấy và 2 túi 2 màu" → số túi granola là 2 (không 3); trả lời "Túi nâu cacao" → 2 Nâu', async () => {
  assert.equal(countBags(granolaBagText('Ship chj 1 hộp dừa sấy và 2 túi 2 màu nhé')), 2);
  const sim = new Sim({ psid: 'r17a-ds' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'STAFF_ONLY_PRODUCT', botLastReplyAt: Date.now() - MIN });
  sim.history(inbox, 'incoming', 'Ship chj 1 hộp dừa sấy và 2 túi 2 màu nhé', 1.2 * MIN);
  sim.history(inbox, 'outgoing', 'Dạ sản phẩm mình hỏi bên em do bạn phụ trách tư vấn và lên đơn riêng ạ.', MIN, { sender: 'bot' });
  await sim.send(inbox, `Đ/c Thanh Tình số nhà 87 đường D15 khu công nghiệp mỹ phước 1 BẾN CÁT Bình Dương ĐT ${PHONE}`, { llm: { template_id: 'ORDER_INFO_ASK_FLAVOR' } });
  const turn = await sim.send(inbox, 'Túi nâu cacao em nhé', { llm: { template_id: 'ASK_FLAVOR' } });
  const items = turn.created[0]?.items || inbox.pendingOrder?.items;
  assert.deepEqual(itemsOf(items), ['2 GRA-NAU-Z350'], said(turn));
});

test('R17 inbox2 C1 (…7802265): "2 túi 2 vị e nhé!" → hỏi vị (ASK_FLAVOR), không để mô hình chọn 2 Xanh', async () => {
  assert.equal(distinctKindsCount('2 túi 2 vị e nhé!'), 2);
  assert.equal(distinctKindsCount('3 túi 2 vị nhé'), 0);
  const sim = new Sim({ psid: 'r17a-22' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(1)], MIN) });
  const turn = await sim.send(inbox, '2 túi 2 vị e nhé!', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '2' } });
  assert.equal(turn.result.templateId, 'ASK_FLAVOR', said(turn));
  assert.equal(turn.created.length, 0);
});

// ===== inbox2 N3: "Xanh và vàng" sau đơn 2 Xanh; CONFIRM_YES mâu thuẫn =====

for (const [label, llm] of [['mô hình 1X+1V', { Product_N1: X, No_A: '1', Product_N2: V, No_B: '1' }], ['mô hình chỉ 1V', { Product_N1: V, No_A: '1' }]]) {
  test(`R17 inbox2 N3 (…3991291, ${label}): đơn 2 Xanh vừa chốt + bảng mix, "Xanh và vàng" → sửa thành 1 Xanh + 1 Vàng 298k (không 447k)`, async () => {
    const sim = new Sim({ psid: `r17a-xv-${llm.Product_N2 ? 2 : 1}` });
    const inbox = sim.inbox({ botLastTemplateId: 'PRICE_MIX_TUI_LON', botLastReplyAt: Date.now() - 50000, customerOrders: [order(1.1, [P(X, 'GRA-XANH-Z450', 2)], { total: 298000 })] });
    const turn = await sim.send(inbox, 'Xanh và vàng', { llm: { template_id: 'ORDER_UPDATE', ...llm } });
    assert.equal(turn.created.length, 1, said(turn));
    assert.deepEqual(itemsOf(turn.created[0].items), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
    assert.equal(turn.created[0].total, 298000);
  });
}

test('R17 inbox2 N3 (…3991291): "E ơi xanh vàng 298k chứ" — ORDER_UNCHANGED không kèm ý phụ CONFIRM_YES ("gửi em SĐT + địa chỉ")', async () => {
  const sim = new Sim({ psid: 'r17a-cy' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_UPDATE', botLastReplyAt: Date.now() - 50000, customerOrders: [order(2, [P(X, 'GRA-XANH-Z450', 1), P(V, 'GRA-VANG-H350', 1)], { total: 298000 })] });
  const turn = await sim.send(inbox, 'E ơi xanh vàng 298k chứ', { llm: { template_id: 'ORDER_UNCHANGED', also: 'CONFIRM_YES' } });
  assert.doesNotMatch(said(turn), /Dạ vâng ạ 💛|gửi em (?:SĐT|số điện thoại)/u, said(turn));
});

// ===== inbox3 A3: đổi một vị trong đơn; giỏ sửa sau ORDER_WRONG =====

test('R17 inbox3 A3 (…8932762): đơn 1 Xanh + 1 Nâu, "Cho dổi tui nâu lấy qua túi vàng" → đơn 1 Xanh + 1 Vàng 298k (không ORDER_WRONG)', async () => {
  const sim = new Sim({ psid: 'r17a-dv' });
  const inbox = sim.inbox({ customerOrders: [order(41, [P(X, 'GRA-XANH-Z450', 1), P(N, 'GRA-NAU-Z350', 1)])], botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 41 * MIN });
  const turn = await sim.send(inbox, 'Cho dổi tui nâu lấy qua túi vàng nxăn chị', { llm: { template_id: 'ORDER_UPDATE', Product_N1: V, No_A: '1' } });
  assert.equal(turn.result.templateId, 'ORDER_UPDATE', said(turn));
  assert.deepEqual(itemsOf(turn.created[0].items), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
  assert.equal(turn.created[0].total, 298000);
  // Hàm thuần: "đổi túi nâu sang túi vàng" thay đúng món, giữ món khác.
  assert.deepEqual(itemsOf(adjustOrderQuantities([], { messageText: 'đổi túi nâu sang túi vàng', recentItems: [{ product: X, code: 'GRA-XANH-Z450', quantity: 1 }, { product: N, code: 'GRA-NAU-Z350', quantity: 1 }] })), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
});

test('R17 inbox3 A3 (…8932762): sau ORDER_WRONG, "1tui xanh lá 1tui vàng" với đơn quá 60 phút → ORDER_CHANGE_STAFF ghi chú đổi đơn (không đơn mới)', async () => {
  const sim = new Sim({ psid: 'r17a-ow' });
  const inbox = sim.inbox({ customerOrders: [order(81, [P(X, 'GRA-XANH-Z450', 1), P(N, 'GRA-NAU-Z350', 1)])], botLastTemplateId: 'ORDER_WRONG', botLastReplyAt: Date.now() - 2 * MIN });
  const turn = await sim.send(inbox, '1tui xanh lá 1tui vàng');
  assert.equal(turn.result.templateId, 'ORDER_CHANGE_STAFF', said(turn));
  assert.equal(turn.created.length, 0);
  assert.match(JSON.stringify(turn.notes), /Túi Vàng/u);
});

// ===== inbox3 A5: hộp/sét 10 gói kèm túi lớn; inbox3 A11 "3mau" =====

test('R17 inbox3 A5 (…2054966, …7215476): "1 hộp và 1 túi vàng", "1 hộp 10 gói và 1 túi vàng", "1 nâu và sét 10 bịch" → túi lớn + Combo 10 gói Xanh', async () => {
  assert.deepEqual(commentBasket('1 nâu và sét 10 bịch').map(item => item.product).sort(), ['Combo 10 gói Xanh', N]);
  for (const [text, live, want] of [['1 hộp và 1 túi vàng', true, ['1 CB10-XANH-G35', '1 GRA-VANG-H350']], ['1 hộp 10 gói và 1 túi vàng', true, ['1 CB10-XANH-G35', '1 GRA-VANG-H350']], ['1 nâu và sét 10 bịch', false, ['1 CB10-XANH-G35', '1 GRA-NAU-Z350']]]) {
    const sim = new Sim({ psid: `r17a-h${text.length}` });
    const inbox = sim.inbox({ labels: live ? ['livestream'] : [], botLastTemplateId: 'LIVESTREAM_COMMENT', botLastReplyAt: Date.now() - 3 * MIN });
    const turn = await sim.send(inbox, text);
    assert.equal(turn.asked.length, 0, `${text}: không gọi mô hình`);
    assert.deepEqual(itemsOf(inbox.pendingOrder?.items), want, `${text}: ${said(turn)}`);
    assert.doesNotMatch(said(turn), /túi zip|Nghệ/u);
  }
});

test('R17 inbox3 A11 (…9207858): giữ 3 Xanh, "3mau" (viết dính) → 3 vị mỗi vị 1 túi 442k', async () => {
  const sim = new Sim({ psid: 'r17a-3m' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 0.2 * MIN, pendingOrder: basket([XANH(3)], 0.3 * MIN) });
  await sim.send(inbox, '3mau', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '3' } });
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-NAU-Z350', '1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
});

// ===== Chủ shop 10/10 (1): combo 10 gói Cam vẫn bán; inbox4 T5 / inbox1 B4: món đã tắt nói rõ =====

test('R17 quyết định 1 + inbox4 T5 (…5573447): "1 túi vàng 1 túi cam" → 1 Vàng + Combo 10 gói Cam; "Lấy 1 combo 10 gói cam" → Combo Cam', async () => {
  for (const [text, want] of [['1 túi vàng 1 túi cam', ['1 CB10-CAM-G30', '1 GRA-VANG-H350']], ['Lấy 1 combo 10 gói cam', ['1 CB10-CAM-G30']], ['lấy 2 hộp cam', ['2 CB10-CAM-G30']]]) {
    const sim = new Sim({ psid: `r17a-cam${text.length}` });
    const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 3 * MIN });
    const turn = await sim.send(inbox, text);
    assert.deepEqual(itemsOf(inbox.pendingOrder?.items), want, `${text}: ${said(turn)}`);
    assert.doesNotMatch(said(turn), /hết hàng/u);
  }
  // Hộp không nêu vị vẫn mặc định Xanh.
  assert.deepEqual(commentBasket('lấy 1 hộp').map(item => item.product), ['Combo 10 gói Xanh']);
});

test('R17 inbox1 B4 (…9162681): "10 gói xanh và 10 gói nâu (gói nhỏ)" → báo Combo 10 gói Nâu hết hàng, không bỏ món âm thầm', async () => {
  assert.equal(soldOutBoxNamed('10 gói nâu nữa mà')?.sku, 'CB10-NAU-G35');
  assert.equal(soldOutBoxNamed('10 gói cam nhé'), null);
  const sim = new Sim({ psid: 'r17a-hh' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 3 * MIN });
  const turn = await sim.send(inbox, '10 gói xanh và 10 gói nâu (gói nhỏ)', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Combo 10 gói Xanh', No_A: '1' } });
  assert.match(said(turn), /Combo 10 gói Nâu hiện bên em đã hết hàng/u, said(turn));
});

// ===== Chủ shop 10/10 (8): khách cũ chỉ nêu giỏ → xác nhận địa chỉ cũ một câu =====

test('R17 quyết định 8 (inbox3 …8490143): khách cũ "Cho ch 2 túi xanh nhé" (mô hình tự chép SĐT + địa chỉ đơn trước) → hỏi xác nhận, chưa lên đơn; "ok e" → lên đơn', async () => {
  const sim = new Sim({ psid: 'r17a-dcc' });
  const inbox = sim.inbox({ labels: ['customer'], botLastTemplateId: 'LIVESTREAM_COMMENT', botLastReplyAt: Date.now() - 6 * MIN });
  const old = 'Chung cư ngõ 699 Trương Định, Quận Hoàng Mai, Hà Nội';
  sim.history(inbox, 'outgoing', `Dạ, em xin phép xác nhận lại thông tin đặt hàng của mình nha: 🌾 Granola Túi Xanh 450g – Số lượng: 2 📞 Số điện thoại: ${PHONE} 🏡 Địa chỉ nhận hàng: ${old}`, 20 * 24 * 60 * MIN, { sender: 'bot' });
  const ask = await sim.send(inbox, 'Cho ch 2 túi xanh nhé', { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '2', Phone_Number: PHONE, Customer_Address: old } });
  assert.equal(ask.created.length, 0, said(ask));
  assert.match(said(ask), /địa chỉ cũ/u);
  assert.match(said(ask), /Trương Định/u);
  assert.ok(inbox.pendingOrder?.oldAddressConfirm);
  const yes = await sim.send(inbox, 'ok e');
  assert.equal(yes.created.length, 1, said(yes));
  assert.deepEqual(itemsOf(yes.created[0].items), ['2 GRA-XANH-Z450']);
  assert.match(yes.created[0].address, /Trương Định/u);
});

test('R17 quyết định 8: khách tự gửi SĐT + địa chỉ trong tin → lên đơn ngay như cũ (không hỏi xác nhận)', async () => {
  const sim = new Sim({ psid: 'r17a-dcc2' });
  const inbox = sim.inbox({});
  const addr = '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
  const turn = await sim.send(inbox, `2 túi xanh ${addr} ${PHONE}`, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '2', Phone_Number: PHONE, Customer_Address: addr } });
  assert.equal(turn.created.length, 1, said(turn));
});
