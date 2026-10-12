// Vòng 18 (12/10) — gói C: gộp tin khách tách đôi (Pancake đẩy webhook chậm 4–8 giây) và không chào WELCOME giữa luồng.
// Câu khách thật 10–11/10 (đã che), mã ca rút gọn 8 số cuối.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, XANH, basket, PHONE } from './helpers/r13-engine-sim.mjs';

const MIN = 60 * 1000;
const bot = { sender: 'bot' };
const said = turn => turn.sent.map(item => item.text || '').join('\n');
let counter = 0;

/** Tin thứ hai của khách "vào kho" sau `afterMs` (như webhook Pancake tới chậm) trong lúc lượt của tin thứ nhất còn chạy. */
function arriveLater(sim, conversation, text, afterMs) {
  return new Promise(resolve => setTimeout(() => {
    const message = { id: `late-${++counter}`, mid: `late-${counter}`, direction: 'incoming', type: 'text', text, createdAt: Date.now() - 1000 };
    sim.list(conversation.id).push(message);
    resolve(message);
  }, afterMs));
}

test('inbox1 V1 (…45486082): "C lấy 1 túi dùng thử nhé" rồi "Màu vàng" tới chậm → một câu trả lời gộp (1 Túi Vàng), không 3 tin Xanh/Vàng chồng nhau', async () => {
  // Lượt khởi động (nạp danh mục / địa giới lần đầu mất ~1–2 giây) để lượt đo không vượt khoảng lặng.
  const warm = new Sim({ psid: 'r18c-warm' });
  await warm.send(warm.inbox(), `C lấy 1 túi xanh\nTổ 2, phường Long Bình, Biên Hoà, Đồng Nai\n${PHONE}`);
  const sim = new Sim({ psid: 'r18c-45486082', settings: { orderQuietMs: 1500 } });
  const box = sim.inbox({ botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: Date.now() - 2 * MIN });
  sim.history(box, 'outgoing', 'Dạ bảng giá Granola Giọt Nắng ạ', 2 * MIN, bot);
  const late = arriveLater(sim, box, 'Màu vàng', 30);
  const first = await sim.send(box, 'C lấy 1 túi dùng thử nhé');
  assert.equal(first.result.skipped, 'gộp với tin sau', JSON.stringify(first.result));
  assert.deepEqual(first.sent, []);
  const second = await sim.send(box, 'Màu vàng', { existing: await late });
  assert.match(said(second), /Túi Vàng/, said(second));
  assert.doesNotMatch(said(second), /Túi Xanh/);
});

test('inbox3 V8 (…57333455): "Lấy 3 túi 3 vị để dùng thử" rồi địa chỉ + SĐT tới chậm → không xin "SĐT và địa chỉ" khách vừa gửi', async () => {
  const sim = new Sim({ psid: 'r18c-57333455', settings: { orderQuietMs: 1500 } });
  const box = sim.inbox({ botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: Date.now() - 2 * MIN });
  const late = arriveLater(sim, box, `Tổ 2, khu phố 2a, phường Long Bình, Biên Hoà, Đồng Nai\n${PHONE}`, 30);
  const first = await sim.send(box, 'Lấy 3 túi 3 vị để dùng thử');
  assert.equal(first.result.skipped, 'gộp với tin sau', JSON.stringify(first.result));
  const second = await sim.send(box, '', { existing: await late });
  assert.doesNotMatch(said(second), /cho em xin (số điện thoại|SĐT)/i, said(second));
});

test('tin hỏi thông tin (không phải chuyện đơn) không phải chờ khoảng lặng', async () => {
  const sim = new Sim({ psid: 'r18c-quiet-info', settings: { orderQuietMs: 5000 } });
  const box = sim.inbox();
  const started = Date.now();
  const turn = await sim.send(box, 'Granola có hạn sử dụng bao lâu vậy shop', { llm: { template_id: 'WEIGHT_EXPIRY' } });
  assert.ok(turn.sent.length > 0);
  assert.ok(Date.now() - started < 3000, 'không chờ 5 giây');
});

test('cross R9 (…926962142 "Alo" khi đang có đơn giao lỗi; …37190005 "Vậy shop" ngay sau câu thành phần): không chào lại bằng WELCOME', async () => {
  const sim = new Sim({ psid: 'r18c-alo' });
  const order = { id: 'o1', createdAt: Date.now() - 2 * 24 * 60 * MIN, automatic: true, status: 'Đang giao', phone: PHONE, address: 'x', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }] };
  const box = sim.inbox({ customerOrders: [order], botLastTemplateId: 'SHIPMENT_OUT_FOR_DELIVERY', botLastReplyAt: Date.now() - 20 * 60 * MIN });
  const alo = await sim.send(box, 'Alo', { llm: { template_id: 'WELCOME' } });
  assert.equal(alo.result.templateId, 'GREETING_SHORT', JSON.stringify(alo.result));
  assert.doesNotMatch(said(alo), /xin chào/i);
  const sim2 = new Sim({ psid: 'r18c-37190005' });
  const box2 = sim2.inbox({ botLastTemplateId: 'INGREDIENTS_ALLERGY', botLastReplyAt: Date.now() - 10e3 });
  sim2.history(box2, 'outgoing', 'Dạ granola gồm gạo lứt, yến mạch…', 10e3, bot);
  const vay = await sim2.send(box2, 'Vậy shop', { llm: { template_id: 'WELCOME' } });
  assert.equal(vay.result.templateId, 'GREETING_SHORT', JSON.stringify(vay.result));
  // Đang giữ giỏ: nhắc giỏ thay vì chào.
  const sim3 = new Sim({ psid: 'r18c-held-greet' });
  const box3 = sim3.inbox({ pendingOrder: basket([XANH(2)], 5 * MIN), botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 5 * MIN });
  const held = await sim3.send(box3, 'Shop ơi', { llm: { template_id: 'WELCOME' } });
  assert.notEqual(held.result.templateId, 'WELCOME', JSON.stringify(held.result));
  assert.match(said(held), /giữ đơn|2 Granola Túi Xanh/, said(held));
  // Khách mới, lần đầu: vẫn WELCOME.
  const sim4 = new Sim({ psid: 'r18c-new-greet' });
  const fresh = await sim4.send(sim4.inbox(), 'Alo', { llm: { template_id: 'WELCOME' } });
  assert.equal(fresh.result.templateId, 'WELCOME', JSON.stringify(fresh.result));
});

test('cross R9 (…310420343): "Shop ơi" rồi "Ship cho c 4 túi hạt nhé" tới chậm → lời gọi chờ lâu hơn (2,5 × mức chờ) và nhường lượt, không WELCOME', async () => {
  const sim = new Sim({ psid: 'r18c-310420343', settings: { fragmentWaitMs: 200 } });
  const box = sim.inbox();
  const late = arriveLater(sim, box, 'Ship cho c 4 túi hạt nhé', 300);
  const first = await sim.send(box, 'Shop ơi', { llm: { template_id: 'WELCOME' } });
  await late;
  assert.equal(first.result.skipped, 'gộp với tin sau', JSON.stringify(first.result));
  assert.deepEqual(first.sent, []);
});
