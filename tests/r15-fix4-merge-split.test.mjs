// Vòng 15 sửa lần 4 (03/10) — thiết kế mới cho câu trả lời "gộp vào đơn đang có hay tách đơn mới" (chủ shop: hỏi khách, làm theo
// khách, khách không quyết được → nhân viên) + phản biện lần hai r15/rereview.md (M1–M11, "không thêm nữa"). Câu khách lấy đúng từ
// báo cáo phản biện; SĐT/địa chỉ là số giả.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, basket, seedTemplates } from './helpers/r13-engine-sim.mjs';
import { mergeSplitBlockWords, readMergeSplitReply } from '../app/chatbot-engine.mjs';
import { adjustOrderQuantities, removedBagCount } from '../app/chatbot-templates.mjs';

const MIN = 60 * 1000;
const ADDR = 'Thôn Trung Toàn, Xã Tam Quang, Huyện Núi Thành, Quảng Nam';
const NEWADDR = 'Số 12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
const NP = '0987654321';
const P = { X: 'Granola Túi Xanh 450g', V: 'Granola Túi Vàng 350g' };
// Lời ORDER_EXISTING_CONFIRM CŨ đang chạy trên máy chủ (r15/settings.json).
const LEGACY_CONFIRM = 'Dạ {title} ơi, em thấy mình đang có đơn {existing_items} đặt lúc {existing_at}, hiện {existing_state} ạ 🌾 Mình muốn đặt THÊM một đơn mới gồm {cart} nữa đúng không ạ? {Title} nhắn "đúng" giúp em là em lên đơn liền; còn nếu là đơn cũ thì {title} cứ nhắn em kiểm tra cho mình nha ạ.';
const codes = items => (items || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const oldOrder = (ago = 120 * MIN) => ({ id: 'o-old', createdAt: Date.now() - ago, phone: PHONE, address: ADDR, rawAddress: ADDR, total: 298000, products: [{ name: P.X, sku: 'GRA-XANH-Z450', quantity: 2 }], status: 'Mới', automatic: true });
// Mô hình giả xấu nhất: chốt đơn và tự điền địa chỉ CŨ khi tin không có địa chỉ.
const badModel = text => ({ template_id: 'ORDER_CONFIRMATION', Product_N1: P.V, No_A: '2', Phone_Number: text.includes(NP) ? NP : PHONE, Customer_Address: /Lê Lợi/.test(text) ? NEWADDR : ADDR });
const STAFF = /^STAFF_WAIT_(OPEN|CLOSED)$/;

async function asked(psid, { legacy = false } = {}) {
  const sim = new Sim({ psid, settings: legacy ? { messageTemplates: { ...seedTemplates, ORDER_EXISTING_CONFIRM: LEGACY_CONFIRM } } : {} });
  const inbox = sim.inbox({ botLastTemplateId: 'THANK_YOU', botLastReplyAt: Date.now() - 90 * MIN, customerOrders: [oldOrder()] });
  const ask = await sim.send(inbox, 'Cho chị thêm 2 túi vàng', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: P.V, No_A: '2' } });
  assert.equal(ask.result.templateId, 'ORDER_EXISTING_CONFIRM');
  return { sim, inbox };
}

test('readMergeSplitReply: chỉ câu ngắn rõ; còn lại "" (bạn phụ trách)', () => {
  for (const text of ['gộp', 'gop', 'Gộp ạ', 'ghép chung', 'ừ gộp', 'dạ gộp giúp chị', 'gộp vào đơn cũ', 'giao chung', 'gửi chung luôn', 'ship chung cho tiện', 'chung 1 đơn', 'đúng rồi em, gộp nhé', 'gộp chung vào đơn đó luôn em']) {
    assert.equal(readMergeSplitReply(text), 'merge', text);
  }
  for (const text of ['tách', 'tach don', 'Ừm tách nha', 'tách riêng', 'đơn mới', 'đơn riêng', 'lên đơn mới đi em', 'đặt thêm', 'ok đặt thêm', 'để riêng', '2 đơn']) {
    assert.equal(readMergeSplitReply(text), 'split', text);
  }
  for (const text of ['ok', 'đúng', 'vâng', 'ừ', 'đúng rồi', 'dạ', 'vâng ạ']) assert.equal(readMergeSplitReply(text), 'yes', text);
  // M2 "đừng" (bỏ dấu trùng "đúng"), câu hỏi tu từ, M4 hủy, M6 đổi món, M3 gửi mẹ, M11 "thôi khỏi gộp", M5 lưỡng lự, SĐT/địa chỉ.
  for (const text of ['đừng tách', 'đừng gộp', 'dung tach', 'tách làm gì em', 'tách à', 'sao lại tách', 'gộp được không', 'gộp thì ship bao nhiêu', 'hủy đơn cũ, lên đơn mới',
    'tách đi, mà đổi sang xanh hết', 'gộp đi mà đổi sang nâu', 'gộp, 3 túi vàng nhé', 'tách 1 đơn gửi mẹ c', 'thôi khỏi gộp', 'tùy em', 'sao cũng được', 'để c hỏi chồng đã',
    'không, đơn mới', 'không gộp, tách', 'khỏi tách', 'dc', 'được', 'k', NP, `tách, sđt ${NP}`, 'giao về quận 7 được không', 'giao chung cư như cũ nha']) {
    assert.equal(readMergeSplitReply(text), '', text);
  }
  assert.equal(mergeSplitBlockWords(`gửi về ${NEWADDR} sđt ${NP}`), false);
  assert.equal(mergeSplitBlockWords('Số 5 Hồng Bàng, Đội 3'), false, 'chữ có dấu trong địa chỉ không bị bắt nhầm');
  for (const text of [`gộp, giao về ${NEWADDR} ${NP}`, `không, gửi ${NEWADDR} ${NP}`, `đổi địa chỉ ${NEWADDR} ${NP}`, `${NEWADDR} ${NP}?`]) assert.equal(mergeSplitBlockWords(text), true, text);
});

test('gộp / tách rõ: làm theo khách (đơn > 60 phút: gộp → ghi chú NV; tách → đơn mới SĐT + địa chỉ cũ), cả lời cũ và lời seed', async () => {
  for (const legacy of [false, true]) {
    const merge = await asked(`f4m${legacy}`, { legacy });
    const merged = await merge.sim.send(merge.inbox, 'ship chung cho tiện', { llm: badModel('') });
    assert.equal(merged.result.templateId, 'ORDER_CHANGE_STAFF');
    assert.deepEqual(merged.created.filter(order => !order.noteOrderId), []);
    assert.deepEqual(merged.notes.map(note => note.orderId), ['o-old']);
    const split = await asked(`f4s${legacy}`, { legacy });
    const created = await split.sim.send(split.inbox, 'Ừm tách nha', { llm: badModel('') });
    assert.equal(created.result.templateId, 'ORDER_CONFIRMATION');
    assert.deepEqual(codes(created.created[0].items), ['2 GRA-VANG-H350']);
    assert.equal(created.created[0].phone, PHONE);
  }
});

test('M2/M4/M6/M3/M7/M11/M5: câu không rõ → STAFF_WAIT một lần + thẻ, giữ giỏ, 0 đơn; lượt sau im + thẻ (không hỏi lại, không STAFF_WAIT lần hai)', async () => {
  let n = 0;
  for (const text of ['đừng tách', 'đừng gộp', 'tách làm gì em', 'tách à', 'hủy đơn cũ, lên đơn mới', 'tách đi, mà đổi sang xanh hết', 'gộp, 3 túi vàng nhé',
    `gộp, giao về ${NEWADDR}`, 'tách 1 đơn gửi mẹ c', 'giao về quận 7 được không', `đơn này gửi ba c nha, sđt ${NP}`, NP, 'thôi khỏi gộp', 'tùy em', 'để c hỏi chồng đã', 'khỏi đi em']) {
    for (const legacy of [false, true]) {
      const { sim, inbox } = await asked(`f4u${++n}`, { legacy });
      const first = await sim.send(inbox, text, { llm: badModel(text) });
      assert.match(String(first.result.templateId || ''), STAFF, text);
      assert.deepEqual(first.created, [], text);
      assert.deepEqual(first.notes, [], text);
      assert.deepEqual(codes(inbox.pendingOrder?.items), ['2 GRA-VANG-H350'], `${text}: giỏ giữ nguyên`);
      assert.ok(inbox.labels.includes('handoff'), text);
      for (const again of [text, 'ok', 'vâng ạ']) {
        const next = await sim.send(inbox, again, { llm: badModel(again) });
        assert.ok(next.result.skipped, `${text} → ${again}: im`);
        assert.deepEqual(next.sent, [], `${text} → ${again}`);
        assert.deepEqual(next.created, [], `${text} → ${again}: "ok" sau khi báo bạn phụ trách không phải đồng ý`);
      }
    }
  }
});

test('M10: "vâng" như "đúng" — lời seed → bạn phụ trách; lời cũ → lên đơn như "đúng"', async () => {
  const seed = await asked('f4v1');
  const vague = await seed.sim.send(seed.inbox, 'vâng', { llm: { template_id: 'THANK_YOU' } });
  assert.match(vague.result.templateId, STAFF);
  assert.deepEqual(vague.created, []);
  const legacy = await asked('f4v2', { legacy: true });
  const yes = await legacy.sim.send(legacy.inbox, 'vâng', { llm: { template_id: 'THANK_YOU' } });
  assert.equal(yes.result.templateId, 'ORDER_CONFIRMATION');
  assert.equal(yes.created[0].phone, PHONE);
});

test('lưỡng lự rồi nói rõ: "sao cũng được" → bạn phụ trách → "gộp đi" làm theo; M7b "0987654321" → "thôi gộp vào đơn cũ đi em" là gộp, không tạo đơn riêng', async () => {
  const a = await asked('f4l1');
  assert.match((await a.sim.send(a.inbox, 'sao cũng được', { llm: badModel('') })).result.templateId, STAFF);
  const merged = await a.sim.send(a.inbox, 'gộp đi', { llm: badModel('') });
  assert.equal(merged.result.templateId, 'ORDER_CHANGE_STAFF');
  const b = await asked('f4l2');
  assert.match((await b.sim.send(b.inbox, NP, { llm: badModel(NP) })).result.templateId, STAFF);
  const back = await b.sim.send(b.inbox, 'thôi gộp vào đơn cũ đi em', { llm: badModel('') });
  assert.equal(back.result.templateId, 'ORDER_CHANGE_STAFF');
  assert.deepEqual(back.created.filter(order => !order.noteOrderId), []);
});

test('tách bằng SĐT + địa chỉ đầy đủ MỚI → đơn mới đúng thông tin trong tin; M3 "gửi mẹ" rồi gửi SĐT + địa chỉ mẹ; SĐT mới + địa chỉ CŨ → bạn phụ trách', async () => {
  const a = await asked('f4n1');
  const text = `gửi về ${NEWADDR} sđt ${NP} nha`;
  const created = await a.sim.send(a.inbox, text, { llm: badModel(text) });
  assert.equal(created.result.templateId, 'ORDER_CONFIRMATION');
  assert.equal(created.created.length, 1);
  assert.equal(created.created[0].phone, NP);
  assert.match(created.created[0].address, /Lê Lợi/);
  const b = await asked('f4n2');
  assert.match((await b.sim.send(b.inbox, 'tách 1 đơn gửi mẹ c', { llm: badModel('') })).result.templateId, STAFF);
  const mom = `${NEWADDR}, sđt ${NP}`;
  const momOrder = await b.sim.send(b.inbox, mom, { llm: badModel(mom) });
  assert.equal(momOrder.created.length, 1);
  assert.equal(momOrder.created[0].phone, NP);
  assert.match(momOrder.created[0].address, /Lê Lợi/);
  // Mô hình đổi địa chỉ mới thành địa chỉ cũ → không lên đơn sai, bạn phụ trách.
  const c = await asked('f4n3');
  const wrong = await c.sim.send(c.inbox, text, { llm: { ...badModel(text), Customer_Address: ADDR } });
  assert.deepEqual(wrong.created, []);
  assert.match(wrong.result.templateId, STAFF);
  const d = await asked('f4n4');
  const oldInfo = `${NP} ${ADDR}`;
  const same = await d.sim.send(d.inbox, oldInfo, { llm: badModel(oldInfo) });
  assert.deepEqual(same.created, []);
  assert.match(same.result.templateId, STAFF);
});

test('splitChosen cũ (cờ 24 giờ) không còn bỏ qua câu hỏi gộp/tách; cờ mới gắn với đúng giỏ + 30 phút', async () => {
  const sim = new Sim({ psid: 'f4sc' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, customerOrders: [oldOrder()],
    pendingOrder: basket([XANH(1)], 3 * 60 * MIN, { splitChosen: true, splitChosenKey: 'GRA-XANH-Z450=1', splitChosenAt: Date.now() - 3 * 60 * MIN }) });
  const turn = await sim.send(inbox, `cho chị 2 túi vàng, ${PHONE} ${ADDR}`, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: P.V, No_A: '2', Phone_Number: PHONE, Customer_Address: ADDR } });
  assert.deepEqual(turn.created, []);
  assert.equal(turn.result.templateId, 'ORDER_EXISTING_CONFIRM');
});

test('M1 (NGHIÊM TRỌNG): "bố" ≠ "bỏ" — giỏ/đơn 3 Xanh + "gửi bố 2 túi thôi nha" / "cho bố mẹ 2 túi" / "giao bố 2 túi nhé" → 2 túi; "bỏ 1 túi" / "giảm đi 1 túi" → 2; "1 túi thôi" → 1', async () => {
  const X = quantity => ({ product: P.X, code: 'GRA-XANH-Z450', quantity });
  for (const [text, model, want] of [['gửi bố 2 túi thôi nha', 2, 2], ['cho bố mẹ 2 túi', 2, 2], ['giao bố 2 túi nhé', 2, 2], ['bỏ 1 túi', 1, 2], ['giảm đi 1 túi', 1, 2], ['1 túi thôi', 1, 1], ['cho bo 2 tui', 2, 2]]) {
    assert.deepEqual(adjustOrderQuantities([X(model)], { messageText: text, heldItems: [X(3)] }).map(item => item.quantity), [want], text);
  }
  assert.equal(removedBagCount('bớt 1'), 1);
  assert.equal(removedBagCount('gửi bố 2 túi'), 0);
  for (const text of ['gửi bố 2 túi thôi nha', 'cho bố mẹ 2 túi', 'giao bố 2 túi nhé']) {
    const sim = new Sim({ psid: `f4m1${text}` });
    const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(3)], 2 * MIN) });
    await sim.send(inbox, text, { llm: { template_id: 'ORDER_ADDRESS', Product_N1: P.X, No_A: '2' } });
    assert.deepEqual(codes(inbox.pendingOrder.items), ['2 GRA-XANH-Z450'], text);
  }
  const sim = new Sim({ psid: 'f4m1o' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 5 * MIN,
    customerOrders: [{ id: 'o1', createdAt: Date.now() - 10 * MIN, phone: PHONE, address: ADDR, rawAddress: ADDR, total: 447000, products: [{ name: P.X, sku: 'GRA-XANH-Z450', quantity: 3 }], status: 'Mới', automatic: true }] });
  const turn = await sim.send(inbox, 'gửi bố 2 túi thôi nha', { llm: { template_id: 'ORDER_UPDATE', Product_N1: P.X, No_A: '2', Phone_Number: PHONE, Customer_Address: ADDR } });
  assert.deepEqual(turn.created.map(order => [order.updateOrderId, codes(order.items)]), [['o1', ['2 GRA-XANH-Z450']]]);
});

test('có từ trước: đơn 2 túi + "1 túi thôi, không thêm nữa" / "thôi 1 túi nha, khỏi thêm" / "cho chị 1 túi thôi, không lấy thêm nữa" → 1 túi (không 3 túi 447k); "lấy 1 túi nữa thôi" vẫn cộng', async () => {
  for (const [text, want] of [['1 túi thôi, không thêm nữa', ['1 GRA-XANH-Z450']], ['thôi 1 túi nha, khỏi thêm', ['1 GRA-XANH-Z450']], ['cho chị 1 túi thôi, không lấy thêm nữa', ['1 GRA-XANH-Z450']], ['lấy 1 túi nữa thôi', ['3 GRA-XANH-Z450']]]) {
    const sim = new Sim({ psid: `f4nt${text}` });
    const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 5 * MIN,
      customerOrders: [{ id: 'o1', createdAt: Date.now() - 10 * MIN, phone: PHONE, address: ADDR, rawAddress: ADDR, total: 298000, products: [{ name: P.X, sku: 'GRA-XANH-Z450', quantity: 2 }], status: 'Mới', automatic: true }] });
    const turn = await sim.send(inbox, text, { llm: { template_id: 'ORDER_UPDATE', Product_N1: P.X, No_A: '1', Phone_Number: PHONE, Customer_Address: ADDR } });
    assert.deepEqual(turn.created.map(order => codes(order.items)), [want], text);
  }
});

test('M8: giữ 2 Xanh, "thêm 1 túi vàng được không em" → 2 Xanh + 1 Vàng; "lấy thêm 1 túi xanh nữa được ko" → 3 Xanh (câu THÊM không bị chặn là câu hỏi một phần giỏ)', async () => {
  for (const [text, llm, want] of [
    ['thêm 1 túi vàng được không em', { Product_N1: P.X, No_A: '2', Product_N2: P.V, No_B: '1' }, ['1 GRA-VANG-H350', '2 GRA-XANH-Z450']],
    ['lấy thêm 1 túi xanh nữa được ko', { Product_N1: P.X, No_A: '3' }, ['3 GRA-XANH-Z450']]
  ]) {
    const sim = new Sim({ psid: `f4m8${text}` });
    const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(2)], 2 * MIN) });
    await sim.send(inbox, text, { llm: () => ({ template_id: 'ORDER_ADDRESS', ...llm }) });
    assert.deepEqual(codes(inbox.pendingOrder.items), want, text);
  }
});

test('M9: đang chờ bạn phụ trách (STAFF_WAIT 5 phút) — lời than "c chốt rồi mà, quà đâu em" / "c đặt từ hôm qua rồi mà" / "lâu vậy em, c đang chờ mua đây" / "ủa c muốn lấy mà sao im vậy" → im + thẻ', async () => {
  for (const text of ['c đặt từ hôm qua rồi mà', 'lâu vậy em, c đang chờ mua đây', 'ủa c muốn lấy mà sao im vậy', 'c chốt rồi mà, quà đâu em']) {
    const sim = new Sim({ psid: `f4m9${text}` });
    const inbox = sim.inbox({ botLastTemplateId: 'STAFF_WAIT_OPEN', botLastReplyAt: Date.now() - 5 * MIN, staffWaitAt: Date.now() - 5 * MIN });
    const turn = await sim.send(inbox, text, { llm: { template_id: 'ORDER_NOTE' } });
    assert.equal(turn.result.skipped, 'đang chờ bạn phụ trách trả lời', text);
    assert.deepEqual(turn.sent, [], text);
    assert.ok(inbox.labels.includes('handoff'), text);
  }
});
