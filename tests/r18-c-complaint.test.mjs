// Vòng 18 (12/10) — gói C: khiếu nại (hộp thư + bình luận). Câu khách thật 10–12/10 (đã che), mã ca rút gọn 8 số cuối.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, XANH, VANG } from './helpers/r13-engine-sim.mjs';
import { COMMENT_DISLIKE } from '../app/processing/rule-intent.mjs';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const bot = { sender: 'bot' };
const said = turn => turn.sent.map(item => item.text || '').join('\n');
const deliveredOrder = (agoMs, items = [XANH(1), VANG(1)]) => ({ id: 'ord-old', createdAt: Date.now() - agoMs, automatic: true, status: 'Đã giao', phone: '0912345678', address: 'Q1, TP.HCM', products: items.map(item => ({ name: item.product, sku: item.code, quantity: item.quantity })) });

test('inbox4 N3 (…65000235): "mình đặt 1 vàng 1 nâu mà giao 1 vàng 1 xanh" (đơn đã giao) → CSKH + thẻ Khiếu nại, không "nhắn loại đúng để em sửa đơn"', async () => {
  const sim = new Sim({ psid: 'r18c-65000235' });
  const box = sim.inbox({ labels: ['livestream', 'delivered'], customerOrders: [deliveredOrder(5 * DAY)], botLastTemplateId: '', botLastReplyAt: Date.now() - 3 * DAY });
  sim.history(box, 'outgoing', 'Dạ em kiểm tra hệ thống đã ghi nhận chị nhận hàng thành công rồi ạ.', 3 * DAY, { sender: 'bot', followUp: true });
  const turn = await sim.send(box, 'Hi shop mình đặt 1 vàng 1 nâu mà giao 1 vàng 1 xanh', { llm: { template_id: 'ORDER_WRONG' } });
  assert.equal(turn.result.templateId, 'CSKH_HANDOFF', JSON.stringify(turn.result));
  assert.ok(box.labels.includes('complaint'), JSON.stringify(box.labels));
  assert.equal(box.botEnabled, false);
  assert.doesNotMatch(said(turn), /sửa lại đơn/);
});

test('inbox4 N3: mô hình chọn ORDER_WRONG cho đơn đã quá 60 phút → CSKH; đơn bot vừa tạo 10 phút → giữ ORDER_WRONG', async () => {
  const sim = new Sim({ psid: 'r18c-wrong-late' });
  const box = sim.inbox({ customerOrders: [{ ...deliveredOrder(3 * 60 * MIN), status: 'Mới' }], botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 3 * 60 * MIN });
  const late = await sim.send(box, 'Sai đơn rồi em', { llm: { template_id: 'ORDER_WRONG' } });
  assert.equal(late.result.templateId, 'CSKH_HANDOFF', JSON.stringify(late.result));
  const sim2 = new Sim({ psid: 'r18c-wrong-fresh' });
  const box2 = sim2.inbox({ customerOrders: [{ ...deliveredOrder(10 * MIN), status: 'Mới' }], botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 10 * MIN });
  const fresh = await sim2.send(box2, 'Sai đơn rồi em', { llm: { template_id: 'ORDER_WRONG' } });
  assert.equal(fresh.result.templateId, 'ORDER_WRONG', JSON.stringify(fresh.result));
});

test('inbox2 N8 (…978260): "Chị không nhận đx hàng em nhé!" (có đơn, thẻ khiếu nại) → CSKH, không "đang thúc vận chuyển"', async () => {
  const sim = new Sim({ psid: 'r18c-978260' });
  const box = sim.inbox({ labels: ['shipment-sent', 'complaint'], customerOrders: [{ ...deliveredOrder(3 * DAY), status: 'Đang giao' }] });
  sim.history(box, 'outgoing', 'Dạ em cảm ơn chị đã thông cảm ạ', 41 * 60 * MIN, { staff: true });
  const turn = await sim.send(box, 'Chị không nhận đx hàng em nhé!', { llm: { template_id: 'DELIVERY_DELAY' } });
  assert.equal(turn.result.templateId, 'CSKH_HANDOFF', JSON.stringify(turn.result));
  assert.doesNotMatch(said(turn), /thúc/);
});

test('inbox3 N4 (…7076876): "xoài sấy có những hạt trắng dính quanh là do mốc à shop" → CSKH + thẻ Khiếu nại, không giải thích viên ngũ cốc', async () => {
  const sim = new Sim({ psid: 'r18c-7076876' });
  const box = sim.inbox({ botLastTemplateId: 'WELCOME', botLastReplyAt: Date.now() - MIN });
  sim.history(box, 'outgoing', 'Dạ Giọt Nắng xin chào anh/chị ạ 👋', MIN, bot);
  const turn = await sim.send(box, 'Mình đang thấy xoài sấy có những hạt trắng dính quanh là do mốc à shop', { llm: { template_id: 'CRUNCHY_CEREAL_INFO' } });
  assert.equal(turn.result.templateId, 'CSKH_HANDOFF', JSON.stringify(turn.result));
  assert.ok(box.labels.includes('complaint'));
});

test('R2 (…42952406): "sợ hat bi hôi bua mua cung bi hôi" khi đang giữ giỏ → CSKH (khiếu nại), không "sản phẩm do bạn phụ trách tư vấn riêng"', async () => {
  const sim = new Sim({ psid: 'r18c-42952406' });
  const box = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS_REMIND', botLastReplyAt: Date.now() - 20e3 });
  sim.history(box, 'outgoing', 'Dạ em vẫn đang giữ đơn 1 Granola Túi Vàng 350g + 1 Granola Túi Nâu vị cacao 350g – tổng 293.000đ', 20e3, bot);
  const turn = await sim.send(box, 'sợ hat bi hôi bua mua cung bi hôi', { llm: { template_id: 'OIL_SMELL_WARRANTY' } });
  assert.equal(turn.result.templateId, 'CSKH_HANDOFF', JSON.stringify(turn.result));
  assert.doesNotMatch(said(turn), /tư vấn và lên đơn riêng/);
});

test('câu hỏi trước khi mua về mốc / mùi (không đơn) không bị coi là khiếu nại', async () => {
  for (const text of ['Để lâu có bị mốc không shop', 'Liệu bóc ra có mùi hôi ko']) {
    const sim = new Sim({ psid: `r18c-q-${text.length}` });
    const box = sim.inbox();
    const turn = await sim.send(box, text, { llm: { template_id: 'OIL_SMELL_WARRANTY' } });
    assert.notEqual(turn.result.templateId, 'CSKH_HANDOFF', `${text}: ${JSON.stringify(turn.result)}`);
  }
});

test('bình luận B3 (…459478): "Có ngọt quá k b" là câu hỏi, không xin lỗi / không chuyển bạn phụ trách', async () => {
  assert.equal(COMMENT_DISLIKE.test('co ngot qua k b'), false);
  assert.equal(COMMENT_DISLIKE.test('ngot qua'), true);
  assert.equal(COMMENT_DISLIKE.test('ngot qua khong an duoc'), true);
  const sim = new Sim({ psid: 'r18c-459478' });
  const thread = sim.comment();
  const turn = await sim.send(thread, 'Có ngọt quá k b', { llm: { template_id: 'NO_ADDED_SUGAR' } });
  assert.notEqual(turn.result.templateId, 'COMMENT_STAFF_FOLLOWUP', JSON.stringify(turn.result));
  assert.doesNotMatch(said(turn), /xin lỗi|bạn phụ trách/);
});

test('bình luận B3 (…914120): "Nhìn thấy ngon o biết có đúng như trong quảng cáo" không phải lời khen → vẫn nhắn riêng câu trả lời', async () => {
  const sim = new Sim({ psid: 'r18c-914120' });
  const thread = sim.comment();
  const turn = await sim.send(thread, 'Nhìn thấy ngon o biết có đúng như trong quảng cáo', { llm: { template_id: 'CERTIFICATION' } });
  assert.notEqual(turn.result.templateId, 'COMMENT_PUBLIC_THANKS', JSON.stringify(turn.result));
  assert.ok(turn.sent.some(item => item.privateReply), JSON.stringify(turn.sent));
});
