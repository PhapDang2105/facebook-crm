// Vòng 18 (12/10) — GÓI A: mô hình không được dựng / sửa giỏ từ câu hỏi, câu kể đã mua, lời đính chính; câu nhắc giỏ đọc đúng giỏ
// đang giữ; giỏ mô hình dựng từ lời khách nêu > 2 giờ trước không bị coi là "đoán".
// Câu khách thật trong S\r18\out-inbox3.md N1/N3, out-cross.md R11 (đã che tên/SĐT/địa chỉ; SĐT giả PHONE).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, VANG, NAU, basket } from './helpers/r13-engine-sim.mjs';

const MIN = 60000;
const HOUR = 60 * MIN;
const itemsOf = list => (list || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const said = turn => turn.sent.map(item => item.text).join('\n');
const X = 'Granola Túi Xanh 450g', V = 'Granola Túi Vàng 350g', N = 'Granola Túi Nâu vị cacao 350g';

test('R18 A inbox3 N1 / cross R11 (…7024636): khách đã nhận hàng kể "Minh vừa mua thử 3 gói rồi" (mô hình ORDER_ADDRESS) → cảm ơn, không giỏ 3 Túi Xanh', async () => {
  const sim = new Sim({ psid: 'r18a-roi' });
  const inbox = sim.inbox({ botLastTemplateId: 'KIDS_FAMILY', botLastReplyAt: Date.now() - MIN });
  sim.history(inbox, 'incoming', 'Con mình 3 tuổi đòi ăn 2 bát rồi', 1.2 * MIN);
  const turn = await sim.send(inbox, 'Minh vừa mua thử 3 gói rồi', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '3' } });
  assert.equal(inbox.pendingOrder?.items?.length || 0, 0, said(turn));
  assert.doesNotMatch(said(turn), /đơn của|447\.000/u, said(turn));
  assert.equal(turn.result.templateId, 'THANK_YOU');
  // Mua thêm thì vẫn lên giỏ.
  const more = new Sim({ psid: 'r18a-roi2' });
  const box = more.inbox({ botLastTemplateId: 'THANK_YOU', botLastReplyAt: Date.now() - MIN });
  await more.send(box, 'Mình vừa mua 3 gói rồi, lấy thêm 2 túi xanh nữa nhé', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '2' } });
  assert.deepEqual(itemsOf(box.pendingOrder?.items), ['2 GRA-XANH-Z450']);
});

test('R18 A inbox3 N1 (…1266888): "Nói rõ giúp chị 2 túi lớn" (mô hình tự lên 2 Túi Vàng) → gọi lại mô hình trả lời thông tin, không giỏ', async () => {
  const sim = new Sim({ psid: 'r18a-noiro' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'SHIPPING_POLICY', botLastReplyAt: Date.now() - MIN });
  const turn = await sim.send(inbox, 'Nói rõ giúp chị 2 túi lớn', { llm: (_payload, call) => (call === 1 ? { template_id: 'ORDER_ADDRESS', Product_N1: V, No_A: '2' } : { template_id: 'BAG_SIZE_INFO' }) });
  assert.equal(turn.asked.length, 2, 'gọi lại mô hình');
  assert.equal(inbox.pendingOrder?.items?.length || 0, 0, said(turn));
  assert.doesNotMatch(said(turn), /đơn của/u, said(turn));
});

test('R18 A inbox3 N1 (…3814895): đơn 1 Tropical + 1 Xanh vừa chốt, "K phải ca cao nhé" (mô hình ORDER_UPDATE 2 Xanh) → không sửa đơn, hỏi lại Tropical + thẻ', async () => {
  const sim = new Sim({ psid: 'r18a-kphai' });
  const order = { id: 'o-trop', automatic: true, createdAt: Date.now() - 2 * MIN, phone: PHONE, address: 'Số 29 đường CMT8, phường Ninh Kiều, Cần Thơ', total: 323000, status: 'Mới',
    products: [{ name: 'Granola Tropical vị Cacao 300g', sku: 'GRA-MINT-Z300', quantity: 1 }, { name: X, sku: 'GRA-XANH-Z450', quantity: 1 }] };
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - MIN, customerOrders: [order] });
  sim.history(inbox, 'incoming', 'Túi xanh dương á shop', 1.2 * MIN);
  sim.history(inbox, 'outgoing', 'Dạ, em gửi chị Bảng giá Granola Tropical vị Cacao 300g để mình dễ tham khảo ạ: …', MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'K phải ca cao nhé', { llm: { template_id: 'ORDER_UPDATE', Product_N1: X, No_A: '2' } });
  assert.equal(turn.created.filter(item => item.update).length, 0, `không sửa đơn: ${JSON.stringify(turn.created)}`);
  assert.equal(turn.result.templateId, 'TROPICAL_CONFIRM', said(turn));
  assert.ok(inbox.labels.some(label => /handoff|attention/.test(label)) || turn.saved.some(item => item.state.attention || (item.state.addLabelEvents || []).length), JSON.stringify(turn.saved.map(item => item.state)));
});

test('R18 A inbox3 N1 (…5952351): giữ Nâu + Vàng, "vàng và xanh có gì khác?" → câu nhắc đọc đúng giỏ Nâu + Vàng (không "1 Vàng + 1 Xanh")', async () => {
  const sim = new Sim({ psid: 'r18a-cmp' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([NAU(1), VANG(1)], 2 * MIN) });
  const turn = await sim.send(inbox, 'vàng và xanh có gì khác?', { llm: { template_id: 'BAG_COMPARISON_XANH_VANG', also: 'ORDER_ADDRESS_REMIND', Product_N1: V, No_A: '1', Product_N2: X, No_B: '1' } });
  assert.match(said(turn), /đang giữ đơn 1 Granola Túi Nâu vị cacao 350g \+ 1 Granola Túi Vàng 350g/u, said(turn));
  assert.doesNotMatch(said(turn), /Túi Vàng 350g \+ 1 Granola Túi Xanh/u);
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-NAU-Z350', '1 GRA-VANG-H350']);
});

test('R18 A inbox3 N3 (…7755330): khách nêu "20 túi cam + 2 túi nâu" 11 giờ trước, sáng "Tính lại đơn mới giúp c" → giỏ mô hình; gửi địa chỉ + SĐT → lên đơn, không hỏi lại vị', async () => {
  const sim = new Sim({ psid: 'r18a-11h' });
  const inbox = sim.inbox({ botLastTemplateId: 'STAFF_WAIT_CLOSED', botLastReplyAt: Date.now() - 11 * HOUR });
  sim.history(inbox, 'incoming', 'Tính lại đơn cho c luôn nhé\nC lấy 20 túi cam + 2 túi nâu', 11 * HOUR + MIN);
  sim.history(inbox, 'outgoing', 'Dạ em đã ghi nhận câu hỏi của chị rồi ạ 💛 Bạn phụ trách … từ 8h sáng mai nha ạ.', 11 * HOUR, { sender: 'bot' });
  const first = await sim.send(inbox, 'Tính lại đơn mới giúp c', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Combo 10 gói Cam', No_A: '2', Product_N2: N, No_B: '2' } });
  assert.notEqual(inbox.pendingOrder?.inferred, true, said(first));
  const address = `Đc : 8/1 Trần Phú, Phường Tuy Hoà, ( Phú Yên cũ ) Đắk Lắk\nSđt ${PHONE}`;
  const turn = await sim.send(inbox, address, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: '8/1 Trần Phú, Phường Tuy Hoà, Phú Yên' } });
  assert.notEqual(turn.result.templateId, 'ORDER_INFO_ASK_FLAVOR', said(turn));
  assert.doesNotMatch(said(turn), /lấy Túi Xanh, Vàng hay Nâu/u, said(turn));
});
