// Vòng 16 (05/10) — sửa engine theo báo cáo r16 out-inbox1..5 / out-comments. Câu khách lấy đúng từ hội thoại thật (không tên,
// SĐT/địa chỉ giả khi không cần câu gốc). Mỗi test ghi mã ca rút gọn.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, VANG, NAU, basket, seedTemplates, templates } from './helpers/r13-engine-sim.mjs';
import { readMergeSplitReply, orderMergeable, LEGACY_EXISTING_CONFIRM } from '../app/chatbot-engine.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const X = 'Granola Túi Xanh 450g';
const V = 'Granola Túi Vàng 350g';
const codes = items => (items || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const texts = turn => turn.sent.map(item => item.text).join(' ‖ ');
const STAFF = /^STAFF_WAIT_(OPEN|CLOSED)$/;

// ---- 1. (inbox4 H1, ca …011918) khách có đơn cũ 3 ngày đã chuyển kho đặt thêm: không hỏi gộp/tách, "mua thêm"/"đúng" = đơn mới.
test('1. readMergeSplitReply: "mua thêm"/"lấy thêm" là tách; "Vậy đặt đơn đó thôi"/"lên đơn đó" là đồng ý', () => {
  for (const text of ['C mua thêm', 'mua thêm nha e', 'lấy thêm', 'đặt thêm']) assert.equal(readMergeSplitReply(text), 'split', text);
  for (const text of ['Vậy đặt đơn đó thôi', 'lên đơn đó', 'Đúng']) assert.equal(readMergeSplitReply(text), 'yes', text);
  for (const text of ['mua thêm được không', 'không mua thêm']) assert.equal(readMergeSplitReply(text), '', text);
});

test('1. orderMergeable: chỉ đơn bot tạo < 24 giờ chưa gửi đi', () => {
  const base = { id: 'o', automatic: true, createdAt: Date.now() - 2 * 60 * MIN, status: 'Mới' };
  assert.equal(orderMergeable(base), true);
  assert.equal(orderMergeable({ ...base, createdAt: Date.now() - 3.3 * DAY }), false, 'quá 24 giờ');
  assert.equal(orderMergeable({ ...base, posStatus: { code: 2, name: 'Đã gửi hàng' } }), false, 'đã gửi');
  assert.equal(orderMergeable({ ...base, automatic: false }), false, 'nhân viên tạo');
  assert.equal(orderMergeable({ ...base, source: 'POS' }), false, 'đơn POS');
});

const OLD_ADDR = 'Toà hateco paloma số 4A huỳnh thuc kháng, phường Láng Thượng, Đống Đa, HN';
async function askAddOn(psid, tpl) {
  const sim = new Sim({ psid, settings: { messageTemplates: tpl } });
  const old = { id: 'old', createdAt: Date.now() - 3.3 * DAY, phone: PHONE, address: 'Thôn Trung Toàn, Xã Tam Quang, Huyện Núi Thành, Quảng Nam', total: 894000, products: [{ name: V, sku: 'GRA-VANG-H350', quantity: 3 }], status: 'Đã xác nhận' };
  const inbox = sim.inbox({ customerOrders: [old], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(3)], MIN, { phone: PHONE }) });
  const llm = { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '3', Phone_Number: PHONE, Customer_Address: OLD_ADDR };
  const ask = await sim.send(inbox, `${OLD_ADDR} đt ${PHONE}`, { llm });
  assert.equal(ask.result.templateId, 'ORDER_EXISTING_CONFIRM');
  assert.match(texts(ask), /đặt THÊM một đơn mới/);
  assert.doesNotMatch(texts(ask), /gộp/);
  return { sim, inbox, llm };
}

test('1. ca …011918: "C mua thêm" sau câu hỏi đặt thêm → lên đơn (mẫu seed và mẫu đang chạy); "Đúng" cũng lên đơn', async () => {
  for (const [name, tpl] of [['seed', seedTemplates], ['live', { ...seedTemplates, ORDER_EXISTING_CONFIRM: LEGACY_EXISTING_CONFIRM }]]) {
    for (const answer of ['C mua thêm', 'mua thêm nha e', 'lấy thêm', 'Đúng', 'Vậy đặt đơn đó thôi']) {
      const { sim, inbox, llm } = await askAddOn(`r16-1-${name}-${answer.length}`, tpl);
      const turn = await sim.send(inbox, answer, { llm });
      assert.equal(turn.result.templateId, 'ORDER_CONFIRMATION', `${name} «${answer}»: ${JSON.stringify(turn.result)}`);
      assert.deepEqual(codes(turn.created[0].items), ['3 GRA-XANH-Z450']);
    }
  }
});

// ---- 2. (inbox4 H5, ca …527762) lời cảm ơn trùng lời cảm ơn vừa gửi → im, không STAFF_WAIT, không thẻ.
test('2. "Cảm ơn em" / "cảm ơn shop nhiều nha" / "Ok em, cảm ơn" sau lời cảm ơn của bot → im, không thẻ', async () => {
  for (const text of ['Cảm ơn em', 'cảm ơn shop nhiều nha', 'Ok em, cảm ơn', 'Hix']) {
    const sim = new Sim({ psid: `r16-2-${text.length}` });
    const inbox = sim.inbox({ botLastTemplateId: 'THANK_YOU', botLastReplyAt: Date.now() - 0.3 * MIN, customerOrders: [{ id: 'o1', createdAt: Date.now() - 3 * MIN, phone: PHONE, address: 'x', total: 189000, products: [], status: 'Mới', automatic: true }] });
    sim.history(inbox, 'outgoing', renderChatbotReply({ template_id: 'THANK_YOU' }, templates, {}).messages[0], 0.3 * MIN, { sender: 'bot' });
    const turn = await sim.send(inbox, text, { llm: { template_id: 'THANK_YOU' } });
    assert.deepEqual(turn.sent, [], text);
    assert.doesNotMatch(String(turn.result.templateId || ''), STAFF, text);
    assert.ok(!inbox.labels.includes('handoff'), `${text}: không thẻ`);
  }
});

// ---- 3. (inbox4 H3, ca …949494) hỏi hạn dùng khi bot đang chờ SĐT để tra địa chỉ cũ → trả lời hạn dùng.
test('3. "Hạn sứ dung đến khi nào vay e" khi bot vừa xin SĐT đặt lần trước → trả lời hạn dùng, không "chưa tìm thấy địa chỉ cũ"', async () => {
  const sim = new Sim({ psid: 'r16-3' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS_OLD_ASK_PHONE', botLastReplyAt: Date.now() - 29 * MIN, pendingOrder: basket([XANH(2), VANG(1)], 29 * MIN, { wantsPrevious: true }) });
  sim.history(inbox, 'incoming', 'Lay C 2 tui xanh\n1 tui vang\nGiao ĐC củ nhe', 29 * MIN);
  sim.history(inbox, 'outgoing', 'Dạ chị cho em xin SĐT đã đặt lần trước ạ', 29 * MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Hạn sứ dung đến khi nào vay e', { llm: { template_id: 'WEIGHT_EXPIRY' } });
  assert.match(texts(turn), /Hạn sử dụng/);
  assert.doesNotMatch(texts(turn), /chưa tìm thấy địa chỉ cũ/);
  assert.doesNotMatch(String(turn.result.templateId || ''), /ORDER_ADDRESS_OLD_NOT_FOUND|STAFF_WAIT/);
});

// ---- 4. Giỏ chỉ do mô hình suy ra → hỏi vị, không tạo đơn.
const QUOTE_X = 'Dạ em thấy anh/chị để lại bình luận dưới bài viết của Giọt Nắng ạ 💛 Dạ, em gửi anh/chị Bảng giá Granola Túi Xanh 450g để mình dễ tham khảo ạ: 1 Túi dùng thử (450g) 174.000đ ... Combo 2 Túi 298.000đ';
// Chủ shop 05/10 (quyết định c): khách chưa nêu vị → MẶC ĐỊNH Túi Xanh (không hỏi lại vị). Hai test dưới trước đây khẳng định
// "hỏi vị, không lên đơn" (R16 N1); nay giỏ mô hình đoán / số túi không vị được thay bằng N Túi Xanh và lên đơn, kèm câu ghi rõ
// "em lên N Túi Xanh nguyên bản 450g… muốn đổi vị nhắn em".
test('4. ca …6011240055: chỉ gửi địa chỉ rồi SĐT sau bảng giá Túi Xanh → mặc định 1 Túi Xanh, lên đơn + câu ghi rõ món (chủ shop 05/10)', async () => {
  const sim = new Sim({ psid: 'r16-4a' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - MIN });
  sim.history(inbox, 'outgoing', QUOTE_X, MIN, { sender: 'bot' });
  const address = 'Số nhà 25 ngách 5/186 đường Lê Thánh Tông, tổ 12 phường Hữu Nghị, Tp Hòa Bình';
  const first = await sim.send(inbox, address, { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '1', Customer_Address: address } });
  assert.deepEqual(first.created, []);
  const phone = await sim.send(inbox, PHONE, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '1', Phone_Number: PHONE, Customer_Address: address } });
  assert.deepEqual(phone.created.map(order => codes(order.items)), [['1 GRA-XANH-Z450']], JSON.stringify(phone.result));
  assert.match(phone.sent[0].text, /em lên 1 Túi Xanh nguyên bản 450g/);
});

test('4. ca …8987226913 / …304408: số túi không vị + địa chỉ/SĐT (bot hỏi vị hay chưa) → mặc định N Túi Xanh, lên đơn (chủ shop 05/10)', async () => {
  const sim = new Sim({ psid: 'r16-4b' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 2 * MIN });
  sim.history(inbox, 'outgoing', QUOTE_X, 2 * MIN, { sender: 'bot' });
  const turns = [];
  turns.push(await sim.send(inbox, 'Cho mình 2 túi nhé. Số nhà 14 ngách 211/85 Khương trung thanh Xuân nhé', { llm: null }));
  assert.match(turns[0].sent[0].text, /em lên 2 Túi Xanh nguyên bản 450g/);
  turns.push(await sim.send(inbox, '0987654321', { llm: null }));
  turns.push(await sim.send(inbox, 'Số dt dưới là số đúng nhé', { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '2', Phone_Number: '0987654321', Customer_Address: 'Số nhà 14 ngách 211/85 Khương trung thanh Xuân' } }));
  const created = turns.flatMap(turn => turn.created).filter(order => !order.updateOrderId);
  assert.deepEqual(created.map(order => codes(order.items)), [['2 GRA-XANH-Z450']], JSON.stringify(turns.map(turn => turn.result)));

  const sim2 = new Sim({ psid: 'r16-4c' });
  const ib = sim2.inbox({ botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: Date.now() - MIN, pendingOrder: { items: [], key: '', at: Date.now() - MIN, askedBagCount: 2, phone: '', address: '' } });
  sim2.history(ib, 'incoming', '2 goi ạ', 1.2 * MIN);
  sim2.history(ib, 'outgoing', 'Dạ bên em có 3 vị ... Chị muốn lấy vị nào và mỗi vị mấy túi để em lên đơn nha ạ?', MIN, { sender: 'bot' });
  const turn = await sim2.send(ib, `Đc .xóm nguyễn huệ son thành yên thành nghệ an ( xã hop minh ) Sdt ${PHONE}`, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '2', Phone_Number: PHONE, Customer_Address: 'xóm nguyễn huệ, xã Sơn Thành, huyện Yên Thành, Nghệ An' } });
  assert.deepEqual(turn.created.map(order => codes(order.items)), [['2 GRA-XANH-Z450']], JSON.stringify(turn.result));
  assert.match(turn.sent[0].text, /em lên 2 Túi Xanh nguyên bản 450g/);
});

test('4. đối chứng: khách đã nói "cho chị 2 túi xanh" rồi gửi SĐT + địa chỉ → vẫn lên đơn', async () => {
  const sim = new Sim({ psid: 'r16-4d' });
  const ib = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], MIN) });
  sim.history(ib, 'incoming', 'cho chị 2 túi xanh', 1.2 * MIN);
  const turn = await sim.send(ib, `xóm nguyễn huệ, xã Sơn Thành, huyện Yên Thành, Nghệ An ${PHONE}`, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '2', Phone_Number: PHONE, Customer_Address: 'xóm nguyễn huệ, xã Sơn Thành, huyện Yên Thành, Nghệ An' } });
  assert.equal(turn.created.length, 1);
});

test('4. khách nhắn thêm ngay trước khi tạo đơn → bỏ lượt (tin sau trả lời gộp)', async () => {
  const sim = new Sim({ psid: 'r16-4e' });
  const ib = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], MIN) });
  sim.history(ib, 'incoming', 'cho chị 2 túi xanh', 1.2 * MIN);
  let calls = 0;
  // Lần đọc tin thứ hai trở đi (sau mô hình) đã có tin mới của khách.
  const listMessages = async id => { calls += 1; const list = [...sim.list(id)]; return calls >= 3 ? [...list, { id: 'late', direction: 'incoming', type: 'text', text: 'Túi mầu vàng', createdAt: Date.now() + 1000 }] : list; };
  const turn = await sim.send(ib, `xóm nguyễn huệ, xã Sơn Thành, huyện Yên Thành, Nghệ An ${PHONE}`, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '2', Phone_Number: PHONE, Customer_Address: 'xóm nguyễn huệ, xã Sơn Thành, huyện Yên Thành, Nghệ An' }, extra: { listMessages } });
  assert.deepEqual(turn.created, []);
  assert.equal(turn.result.skipped, 'gộp với tin sau');
});
