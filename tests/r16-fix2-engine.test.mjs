// Vòng 16 — sửa theo phản biện engine (scratchpad r16/review-engine.md) và phần engine của phản biện luật. Câu khách lấy đúng từ hội
// thoại thật (mã ca rút gọn), SĐT/địa chỉ giả khi không cần câu gốc.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, basket, templates } from './helpers/r13-engine-sim.mjs';
import { declinesBuyingMore } from '../app/chatbot-engine.mjs';
import { customerDeclined } from '../app/follow-up.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

const MIN = 60 * 1000;
const X = 'Granola Túi Xanh 450g';
const V = 'Granola Túi Vàng 350g';
const N = 'Granola Túi Nâu vị cacao 350g';
const codes = items => (items || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const texts = turn => turn.sent.map(item => item.text).join(' ‖ ');
const STAFF = /^STAFF_WAIT_(OPEN|CLOSED)$/;
const ASK = 'Dạ bên em có 3 vị: Túi Xanh nguyên bản 450g, Túi Vàng nhiều hạt 350g và Túi Nâu cacao 350g; mix vị nào cũng được giá combo, từ 2 túi miễn phí vận chuyển ạ. Chị muốn lấy vị nào và mỗi vị mấy túi để em lên đơn nha ạ?';

// ---- N1. Giỏ "do mô hình đoán" không được chặn đơn khách đã chọn; không bao giờ im.
test('N1 ca …9939622934: "Gởi c ba vị này" sau câu hỏi vị (SĐT + địa chỉ đã giữ) → lên đơn 3 vị', async () => {
  const ADDR = '44 lê đình thám, phường hoà thuận, tp Tam Kỳ, quảng nam';
  const sim = new Sim({ psid: 'fix2-n1a' });
  const ib = sim.inbox({ botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: { items: [], key: '', at: Date.now() - 4 * MIN, phone: PHONE, address: ADDR, addressAsks: 0 } });
  sim.history(ib, 'incoming', `${ADDR} ${PHONE}`, 4 * MIN);
  sim.history(ib, 'incoming', '', 3.5 * MIN, { type: 'image' });
  sim.history(ib, 'incoming', 'Gởi c nhé', 3.4 * MIN);
  sim.history(ib, 'incoming', 'Hôm trước e tổng cho c đây', 2.5 * MIN);
  sim.history(ib, 'outgoing', ASK, 2 * MIN, { sender: 'bot' });
  sim.history(ib, 'incoming', '.', 1.5 * MIN);
  const llm = { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '1', Product_N2: V, No_B: '1', Product_N3: N, No_C: '1', Phone_Number: PHONE, Customer_Address: ADDR };
  const turn = await sim.send(ib, 'Gởi c ba vị này', { llm });
  assert.equal(turn.created.length, 1, JSON.stringify(turn.result));
  assert.deepEqual(codes(turn.created[0].items), ['1 GRA-NAU-Z350', '1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
});

test('N1 ca …9616635884: "Lấy 450g" sau ASK_PRODUCT (SĐT + địa chỉ đã giữ) → lên đơn 1 Túi Xanh', async () => {
  const ADDR = 'Hẻm 366 nguyen trung truc phú quốc';
  const sim = new Sim({ psid: 'fix2-n1b' });
  const ib = sim.inbox({ botLastTemplateId: 'ASK_PRODUCT', botLastReplyAt: Date.now() - MIN, pendingOrder: { items: [], key: '', at: Date.now() - 6 * MIN, phone: PHONE, address: ADDR, addressAsks: 0 } });
  sim.history(ib, 'incoming', `${ADDR} ${PHONE}`, 6 * MIN);
  sim.history(ib, 'incoming', 'Ủa sao thấy để túi mấy kg mà', 3 * MIN);
  sim.history(ib, 'outgoing', 'Dạ chị đang quan tâm sản phẩm nào để em gửi bảng giá chi tiết ạ?', MIN, { sender: 'bot' });
  const turn = await sim.send(ib, 'Lấy 450g', { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '1', Phone_Number: PHONE, Customer_Address: ADDR } });
  assert.equal(turn.created.length, 1, JSON.stringify(turn.result));
  assert.deepEqual(codes(turn.created[0].items), ['1 GRA-XANH-Z450']);
});

test('N1: đơn do LUẬT dựng ("Mỗi loại 1 túi", "Túi 450g nhé") sau câu hỏi vị không bị chặn (mô hình không gọi)', async () => {
  const ADDR = '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
  for (const [text, want] of [['Mỗi loại 1 túi', ['1 GRA-NAU-Z350', '1 GRA-VANG-H350', '1 GRA-XANH-Z450']], ['Túi 450g nhé', ['1 GRA-XANH-Z450']]]) {
    const sim = new Sim({ psid: `fix2-n1c-${text.length}` });
    const ib = sim.inbox({ botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: Date.now() - MIN, pendingOrder: { items: [], key: '', at: Date.now() - 2 * MIN, phone: PHONE, address: ADDR, addressAsks: 0 } });
    sim.history(ib, 'incoming', `${PHONE} ${ADDR}`, 2 * MIN);
    sim.history(ib, 'outgoing', ASK, MIN, { sender: 'bot' });
    const turn = await sim.send(ib, text, { llm: null });
    assert.equal(turn.created.length, 1, `${text}: ${JSON.stringify(turn.result)}`);
    assert.deepEqual(codes(turn.created[0].items), want, text);
  }
});

// Chủ shop 05/10 (quyết định c): khách chưa nêu vị → MẶC ĐỊNH Túi Xanh. Test cũ khẳng định "hỏi vị; lần hai STAFF_WAIT" — nay giỏ
// mô hình đoán cho lời đệm được thay bằng 1 Túi Xanh và lên đơn (kèm câu ghi rõ món để khách đổi), không hỏi lại vị.
test('N1: mô hình đoán giỏ cho lời đệm ("Gởi c nhé") sau câu hỏi vị → mặc định 1 Túi Xanh, lên đơn + câu ghi rõ món (chủ shop 05/10)', async () => {
  const ADDR = '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
  const sim = new Sim({ psid: 'fix2-n1d' });
  const ib = sim.inbox({ botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: Date.now() - MIN, pendingOrder: { items: [], key: '', at: Date.now() - 2 * MIN, phone: PHONE, address: ADDR, addressAsks: 0 } });
  sim.history(ib, 'incoming', `${PHONE} ${ADDR}`, 2 * MIN);
  sim.history(ib, 'outgoing', ASK, MIN, { sender: 'bot' });
  const guess = { template_id: 'ORDER_CONFIRMATION', Product_N1: V, No_A: '1', Phone_Number: PHONE, Customer_Address: ADDR };
  const first = await sim.send(ib, 'Gởi c nhé', { llm: guess });
  assert.deepEqual(first.created.map(order => codes(order.items)), [['1 GRA-XANH-Z450']], JSON.stringify(first.result));
  assert.match(texts(first), /em lên 1 Túi Xanh nguyên bản 450g/);
  assert.doesNotMatch(String(first.result.templateId || ''), STAFF);
});

// ---- C1. "Không lấy thêm nữa" sau lời mời lên 2 túi = từ chối lời mời, GIỮ giỏ.
const UP = 'Dạ nếu chị lấy 2 túi thì giá chỉ còn 149.000đ/túi (bớt 25.000đ/túi), miễn phí ship: tổng 298.000đ thay vì 174.000đ (đã gồm ship) cho 1 túi ạ 🌾 Chị muốn lấy 2 túi không ạ? Nếu vẫn lấy 1 túi thì em lên đơn 1 túi cho mình nha.';
test('C1: "Không lấy thêm nữa" / "ko lấy thêm nữa e" / "Thôi k cần thêm nữa" khi giữ giỏ 1 túi sau lời mời → giữ giỏ', async () => {
  for (const text of ['Không lấy thêm nữa', 'ko lấy thêm nữa e', 'Thôi k cần thêm nữa', 'ko mua thêm nữa']) {
    const sim = new Sim({ psid: `fix2-c1-${text.length}` });
    const ib = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(1)], MIN, { upsold: true }) });
    sim.history(ib, 'incoming', 'lấy 1 túi xanh', 1.5 * MIN);
    sim.history(ib, 'outgoing', `Dạ em nhận đơn 1 Granola Túi Xanh 450g ạ. ${UP}`, MIN, { sender: 'bot' });
    const turn = await sim.send(ib, text, { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '1' } });
    assert.notEqual(turn.result.templateId, 'ORDER_POSTPONED', text);
    assert.deepEqual(codes(ib.pendingOrder?.items), ['1 GRA-XANH-Z450'], text);
  }
  // Không có "thêm" → vẫn là bỏ đơn như vòng 16.
  assert.equal(declinesBuyingMore('khong lay nua', { keepsBasket: true }), true);
  assert.equal(declinesBuyingMore('Không lấy thêm nữa', { keepsBasket: true }), false);
  assert.equal(declinesBuyingMore('Không lấy thêm nữa'), true);
});

test('C1 bám đuổi: "Không lấy thêm nữa" khi đang giữ giỏ không chặn lời nhắc giỏ; không giữ giỏ / "hủy" vẫn chặn', () => {
  assert.equal(customerDeclined('Không lấy thêm nữa', { basketHeld: true }), false);
  assert.equal(customerDeclined('ko mua thêm nữa', { basketHeld: true }), false);
  assert.equal(customerDeclined('Không lấy thêm nữa'), true);
  assert.equal(customerDeclined('hủy, không lấy thêm nữa', { basketHeld: true }), true);
  assert.equal(customerDeclined('da nhan hang roi nen kg mua nua', { basketHeld: true }), true);
});

// ---- T1. Lời cảm ơn KÈM câu hỏi / yêu cầu sau lời cảm ơn của bot → không im (STAFF_WAIT + thẻ).
test('T1: "Cảm ơn e, khi nào thì giao tới vậy" / "Ok em cảm ơn, đổi giúp chị sang túi vàng nha" → STAFF_WAIT + thẻ; "Ok e cảm ơn" vẫn im', async () => {
  const run = async (text, n) => {
    const sim = new Sim({ psid: `fix2-t1-${n}` });
    const ib = sim.inbox({ botLastTemplateId: 'THANK_YOU', botLastReplyAt: Date.now() - 0.5 * MIN, customerOrders: [{ id: 'o1', automatic: true, createdAt: Date.now() - 10 * MIN, phone: PHONE, address: 'x', total: 298000, products: [], status: 'Mới' }] });
    sim.history(ib, 'outgoing', renderChatbotReply({ template_id: 'THANK_YOU' }, templates, {}).messages[0], 0.5 * MIN, { sender: 'bot' });
    return { turn: await sim.send(ib, text, { llm: { template_id: 'THANK_YOU' } }), ib };
  };
  for (const [n, text] of ['Cảm ơn e, khi nào thì giao tới vậy', 'cảm ơn em nhé, mai giao được không', 'Ok em cảm ơn, đổi giúp chị sang túi vàng nha'].entries()) {
    const { turn, ib } = await run(text, n);
    assert.match(String(turn.result.templateId || ''), STAFF, `${text}: ${JSON.stringify(turn.result)}`);
    assert.ok(ib.labels.includes('handoff'), text);
  }
  const { turn, ib } = await run('Ok e cảm ơn', 9);
  assert.deepEqual(turn.sent, []);
  assert.ok(!ib.labels.includes('handoff'));
});

// ---- T2. Bình luận "chưa thấy tin" chỉ gửi lại tin bot nhắn riêng TỪ BÌNH LUẬN (2 giờ), không gửi lại phiếu đơn hôm qua.
test('T2: có phiếu xác nhận đơn 20 giờ trước, bình luận "shop ơi sao k thấy ib" → không gửi lại phiếu đơn', async () => {
  const sim = new Sim({ psid: 'fix2-t2' });
  const ib = sim.inbox();
  sim.history(ib, 'outgoing', 'Dạ, em xin phép xác nhận lại thông tin đặt hàng của mình nha: 🌾 Granola Túi Xanh 450g – Số lượng: 2 … 📞 0912345678 🏡 12 Lê Lợi…', 20 * 60 * MIN, { sender: 'bot' });
  const comment = sim.comment();
  const turn = await sim.send(comment, 'shop ơi sao k thấy ib', { llm: { template_id: 'GENERAL_INFO' } });
  assert.doesNotMatch(texts(turn), /xác nhận lại thông tin đặt hàng/);
});

// ---- L3 engine. Lời cảm thán về thời gian giao ngay sau bảng thời gian giao → không "chuyển bạn phụ trách".
test('L3 ca …3440168818: "Uh ở xa quá nên hơi lâu e nhỉ" ngay sau SHIPPING_POLICY → không STAFF_WAIT, không thẻ', async () => {
  const sim = new Sim({ psid: 'fix2-l3' });
  const ib = sim.inbox({ botLastTemplateId: 'SHIPPING_POLICY', botLastReplyAt: Date.now() - 0.3 * MIN });
  sim.history(ib, 'incoming', 'E ơi, ở hà nội mình có bán ko e nhỉ', 0.4 * MIN);
  sim.history(ib, 'outgoing', renderChatbotReply({ template_id: 'SHIPPING_POLICY' }, templates, {}).messages[0], 0.3 * MIN, { sender: 'bot' });
  const turn = await sim.send(ib, 'Uh ở xa quá nên hơi lâu e nhỉ', { llm: { template_id: 'DELIVERY_DELAY' } });
  assert.doesNotMatch(String(turn.result.templateId || ''), STAFF, JSON.stringify(turn.result));
  assert.ok(!ib.labels.includes('handoff'));
});

// ---- Giỏ Facebook Shop mã đã tắt (CB10-CAM-G30) → ghi nhận + thẻ nhân viên, không hỏi vị granola (ca …9873460116).
test('ca …9873460116: giữ giỏ Combo 10 gói đã tắt (R17: Cam bán lại 10/10 → thử bằng Nâu) + SĐT → SHOP_CART_STAFF + thẻ, giữ SĐT, không ASK_FLAVOR', async () => {
  const sim = new Sim({ psid: 'fix2-cam' });
  const ib = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN,
    pendingOrder: { items: [{ product: 'Combo 10 gói Nâu', code: 'CB10-NAU-G35', quantity: 1 }], key: 'CB10-NAU-G35=1', at: Date.now() - 2 * MIN, phone: '', address: 'Kim van ấp 6 phú thịnh tân phú đồng nai', addressAsks: 0 } });
  sim.history(ib, 'incoming', 'Mình lấy 1 combo ăn thử nha shop', 3 * MIN);
  sim.history(ib, 'incoming', 'Kim van ấp 6 phú thịnh tân phú đồng nai', 1.2 * MIN);
  sim.history(ib, 'outgoing', 'Dạ em đã nhận được địa chỉ của mình rồi ạ. Chị cho em xin số điện thoại để em lên đơn gửi mình nha', MIN, { sender: 'bot' });
  const turn = await sim.send(ib, PHONE, { llm: { template_id: 'ORDER_CONFIRMATION' } });
  assert.equal(turn.result.templateId, 'SHOP_CART_STAFF', JSON.stringify(turn.result));
  assert.match(texts(turn), /Combo 10 gói Nâu/);
  assert.ok(ib.labels.includes('handoff'));
  assert.equal(ib.pendingOrder.phone, PHONE);
});

// ---- L4 engine. Tin "Đúng rồi e" tới ngay sau tin địa chỉ không bị ghép vào địa chỉ đơn.
test('L4: SĐT + địa chỉ, ngay sau đó "Đúng rồi e" → địa chỉ đơn không có "Đúng rồi e"', async () => {
  const ADDR = '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
  const sim = new Sim({ psid: 'fix2-l4' });
  const ib = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], 2 * MIN) });
  sim.history(ib, 'incoming', 'lấy 2 túi xanh', 2 * MIN);
  sim.history(ib, 'outgoing', 'Dạ đơn của chị gồm 2 Granola Túi Xanh 450g … chị cho em xin SĐT và địa chỉ nha', MIN, { sender: 'bot' });
  const later = { id: 'later', mid: 'later', direction: 'incoming', type: 'text', text: 'Đúng rồi e', createdAt: Date.now() + 2000 };
  let calls = 0;
  const listMessages = async id => { calls += 1; const list = [...sim.list(id)]; return calls >= 3 && id === ib.id ? [...list, later] : list; };
  await sim.send(ib, `${PHONE} ${ADDR}`, { llm: { template_id: 'ORDER_CONFIRMATION' }, extra: { listMessages } });
  sim.list(ib.id).push(later);
  const turn = await sim.send(ib, 'Đúng rồi e', { existing: later, llm: { template_id: 'ORDER_CONFIRMATION' } });
  assert.equal(turn.created.length, 1, JSON.stringify(turn.result));
  assert.doesNotMatch(turn.created[0].address, /Đúng rồi/);
});
