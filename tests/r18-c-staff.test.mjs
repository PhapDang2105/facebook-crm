// Vòng 18 (12/10) — gói C: nhân viên đang xử lý / bot tạm dừng / STAFF_WAIT đã hứa. Câu khách thật 10–11/10 (đã che).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim } from './helpers/r13-engine-sim.mjs';
import { staffPauseExpired, STAFF_IDLE_RESUME_HOURS } from '../app/chatbot-engine.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const bot = { sender: 'bot' };
const said = turn => turn.sent.map(item => item.text || '').join('\n');

test('staffPauseExpired: chỉ bot do Pancake tạm dừng, nhân viên im ≥ 2 giờ; tắt tay / chuyển CSKH / 0 giờ thì không', () => {
  assert.equal(STAFF_IDLE_RESUME_HOURS, 2);
  const paused = { botEnabled: false, botPausedAt: Date.now() - 6 * HOUR, botPausedBy: 'Vy' };
  const staffAt = ago => [{ direction: 'outgoing', staff: true, text: 'Dạ', createdAt: Date.now() - ago }];
  assert.equal(staffPauseExpired(paused, staffAt(3 * HOUR)), true);
  assert.equal(staffPauseExpired(paused, staffAt(90 * MIN)), false, 'nhân viên vừa nhắn 90 phút trước');
  assert.equal(staffPauseExpired({ ...paused, botPausedAt: Date.now() - HOUR }, []), false, 'mới tạm dừng 1 giờ');
  assert.equal(staffPauseExpired({ ...paused, botChangedBy: { at: Date.now() - 5 * HOUR, enabled: false } }, staffAt(3 * HOUR)), false, 'nhân viên tắt tay trong CRM');
  assert.equal(staffPauseExpired({ botEnabled: false }, staffAt(5 * HOUR)), false, 'bot tắt vì chuyển CSKH');
  assert.equal(staffPauseExpired(paused, staffAt(3 * HOUR), { hours: 0 }), false, 'cài đặt 0 = không tự bật');
  assert.equal(staffPauseExpired({ ...paused, botEnabled: true }, []), false);
});

test('inbox2 N5 (…731647): Pancake tạm dừng bot lúc 16:29, khách 22:25 hỏi "Combo 3 gói giá bn" → bot tự bật lại và trả lời', async () => {
  const sim = new Sim({ psid: 'r18c-731647' });
  const box = sim.inbox({ botEnabled: false, botPausedAt: Date.now() - 6 * HOUR, botPausedBy: 'Nguyễn Hồng Vy', botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: Date.now() - 7 * HOUR });
  sim.history(box, 'outgoing', 'Dạ chị cần tư vấn thêm gì không ạ', 6 * HOUR, { staff: true });
  sim.history(box, 'incoming', 'Chương trình khuyến mãi gì em', 20e3);
  const turn = await sim.send(box, 'Combo 3 gói giá bn', { llm: { template_id: 'PRICE_COUNT' } });
  assert.ok(turn.sent.length > 0, JSON.stringify(turn.result));
  assert.equal(box.botEnabled, true);
  assert.equal(box.botPausedAt, 0);
  assert.ok(Number(box.botResumedAt) > 0);
});

test('Pancake tạm dừng nhưng nhân viên vừa nhắn 30 phút trước → bot vẫn đứng ngoài', async () => {
  const sim = new Sim({ psid: 'r18c-pause-fresh' });
  const box = sim.inbox({ botEnabled: false, botPausedAt: Date.now() - 3 * HOUR, botPausedBy: 'Vy' });
  sim.history(box, 'outgoing', 'Dạ em lên đơn cho chị nha', 30 * MIN, { staff: true });
  const turn = await sim.send(box, 'Combo 3 gói giá bn', { llm: { template_id: 'PRICE_COUNT' } });
  assert.deepEqual(turn.sent, []);
  assert.equal(box.botEnabled, false);
});

// Mốc giờ hành chính (10h VN) gần nhất đã qua ít nhất `minAgo` — STAFF_WAIT gửi lúc đó là STAFF_WAIT_OPEN ("trả lời ngay trong ít phút").
const officeTimeAgo = (minAgo = 20 * MIN) => {
  const day = 24 * HOUR;
  const base = Date.now() - minAgo;
  let at = Math.floor((base + 7 * HOUR) / day) * day - 7 * HOUR + 10 * HOUR;
  while (at > base) at -= day;
  return at;
};

test('inbox1 N1 (…27839177859004227): STAFF_WAIT_OPEN đã hứa mà 15 phút không có nhân viên → tin kế tiếp bot trả lời như thường + thẻ', async () => {
  const sim = new Sim({ psid: 'r18c-27839177' });
  const box = sim.inbox({ botLastTemplateId: 'STAFF_WAIT_OPEN', botLastReplyAt: Date.now() - 20 * MIN, staffWaitAt: officeTimeAgo(20 * MIN) });
  sim.history(box, 'outgoing', 'Dạ em đã ghi nhận câu hỏi của chị rồi ạ 💛 Em chuyển bạn phụ trách trả lời chị ngay trong ít phút, chị chờ em chút nha ạ.', 20 * MIN, bot);
  const turn = await sim.send(box, 'Vậy hôm nay có ưu đãi gì không em', { llm: { template_id: 'DISCOUNT_POLICY' } });
  assert.equal(turn.result.templateId, 'DISCOUNT_POLICY', JSON.stringify(turn.result));
  assert.ok(box.labels.includes('handoff'));
  // Trong 15 phút: vẫn chờ bạn phụ trách như cũ (im + thẻ).
  const sim2 = new Sim({ psid: 'r18c-grace' });
  const box2 = sim2.inbox({ botLastTemplateId: 'STAFF_WAIT_OPEN', botLastReplyAt: Date.now() - 5 * MIN, staffWaitAt: Date.now() - 5 * MIN });
  sim2.history(box2, 'outgoing', 'Dạ em chuyển bạn phụ trách trả lời chị ngay trong ít phút', 5 * MIN, bot);
  const waiting = await sim2.send(box2, 'Vậy hôm nay có ưu đãi gì không em', { llm: { template_id: 'DISCOUNT_POLICY' } });
  assert.equal(waiting.result.skipped, 'đang chờ bạn phụ trách trả lời', JSON.stringify(waiting.result));
  // Nhân viên đã nhắn sau lời hứa → không coi là lỡ hẹn.
  const sim3 = new Sim({ psid: 'r18c-staff-came' });
  const box3 = sim3.inbox({ botLastTemplateId: 'STAFF_WAIT_OPEN', botLastReplyAt: Date.now() - 20 * MIN, staffWaitAt: officeTimeAgo(20 * MIN) });
  sim3.history(box3, 'outgoing', 'Dạ em chuyển bạn phụ trách trả lời chị ngay trong ít phút', 20 * MIN, bot);
  sim3.history(box3, 'outgoing', 'Dạ chị ơi em đây ạ', 10 * MIN, { staff: true });
  const came = await sim3.send(box3, 'Vậy hôm nay có ưu đãi gì không em', { llm: { template_id: 'DISCOUNT_POLICY' } });
  assert.deepEqual(came.sent, [], JSON.stringify(came.result));
});

test('cross 1.2: lời hứa đã lỡ mà câu trả lời vẫn trùng tin vừa gửi (không câu khác) → báo lại STAFF_WAIT + thẻ, không im 2 giờ', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' }, psid: 'r18c-lapsed-repeat' });
  const box = sim.inbox({ gender: 'female', botGender: 'female' });
  await sim.send(box, 'Giá sao shop', { llm: { template_id: 'PRICE_QUOTE' } });
  const zip = await sim.send(box, 'Đắt hơn túi zip à shop', { llm: { template_id: 'PRICE_QUOTE' } });
  assert.match(String(zip.result.templateId), /^STAFF_WAIT_/);
  box.staffWaitAt = officeTimeAgo(20 * MIN);
  const again = await sim.send(box, 'Túi zip bên kia rẻ hơn mà', { llm: { template_id: 'PRICE_QUOTE' } });
  assert.match(String(again.result.templateId || ''), /^STAFF_WAIT_/, JSON.stringify(again.result));
  assert.ok(again.sent.length > 0);
  assert.ok(Date.now() - Number(box.staffWaitAt) < MIN, 'mốc báo mới');
});

const idle = await import('../app/processing/staff-idle.mjs');
const { staffComplaintKind } = await import('../app/chatbot-engine.mjs');

test('staffComplaintKind: dọa hủy / mua chỗ khác = threat; than chờ, khiếu nại = wait; câu thường = ""', () => {
  for (const text of ['Sáng mai không nhận được hàng là chị hủy đơn nhé', 'Chị hủy đơn này với shop nhé', 'Ko để mình đặt hàng bên khác']) assert.equal(staffComplaintKind(text), 'threat', text);
  for (const text of ['Chị đang sốt ruột chờ', 'Chả thấy giao', 'Chị đợi điện thoại từ sáng, không ai gọi luôn', 'Em ship k giao hàng cho chị, cả ngày chị đợi mà k thấy đến giao']) assert.equal(staffComplaintKind(text), 'wait', text);
  for (const text of ['Combo 3 gói giá bn', 'ok em', 'Có bạn chị muốn mua dùng thử, em giao theo địa chỉ này nhé']) assert.equal(staffComplaintKind(text), '', text);
});

test('cross 1.1 (…29195518906707502): nhân viên nhận ca, khách dọa hủy → một câu xin lỗi + báo gấp (STAFF_WAIT_COMPLAINT) + thẻ; lần sau im', async () => {
  const sim = new Sim({ psid: 'r18c-707502' });
  const box = sim.inbox({ labels: ['shipment-sent', 'complaint'], botEnabled: false, botPausedAt: Date.now() - 9 * HOUR, botPausedBy: 'NV', botLastTemplateId: 'DELIVERY_DELAY', botLastReplyAt: Date.now() - 11 * HOUR });
  sim.history(box, 'outgoing', 'Dạ, sẽ có 1 ca giao hàng cho anh trong 12 tiếng tiếp theo ạ', 8 * HOUR, { staff: true });
  const notes = [];
  const extra = { addStaffNote: (conversation, note) => { notes.push(note); } };
  const turn = await sim.send(box, 'Sáng mai không nhận được hàng là chị hủy đơn nhé', { llm: { template_id: 'DELIVERY_DELAY' }, extra });
  assert.equal(turn.result.templateId, 'STAFF_WAIT_COMPLAINT', JSON.stringify(turn.result));
  assert.match(said(turn), /xin lỗi/);
  assert.match(said(turn), /bạn phụ trách/);
  assert.ok(box.labels.includes('handoff'));
  assert.ok(Number(box.staffComplaintAt) > 0);
  assert.equal(notes.length, 1);
  assert.equal(box.botLastTemplateId, 'DELIVERY_DELAY', 'không đổi mẫu bot cuối (nhân viên vẫn đang xử lý)');
  const again = await sim.send(box, 'Chị hủy đơn này với shop nhé', { llm: { template_id: 'DELIVERY_DELAY' }, extra });
  assert.deepEqual(again.sent, [], JSON.stringify(again.result));
});

test('cross 1.1: Pancake vừa tạm dừng bot (nhân viên nhắn 1 giờ trước), khách dọa mua chỗ khác → vẫn xin lỗi một lần, bot vẫn tắt', async () => {
  const sim = new Sim({ psid: 'r18c-960004' });
  const box = sim.inbox({ botEnabled: false, botPausedAt: Date.now() - HOUR, botPausedBy: 'NV' });
  sim.history(box, 'outgoing', 'Dạ em kiểm tra với bên vận chuyển ạ', HOUR, { staff: true });
  const turn = await sim.send(box, 'Giao không thành công thì để mình đặt hàng bên khác', { llm: { template_id: 'DELIVERY_DELAY' } });
  assert.equal(turn.result.templateId, 'STAFF_WAIT_COMPLAINT', JSON.stringify(turn.result));
  assert.equal(box.botEnabled, false);
});

test('cross 1.1 (…28673885808912698): "Chị đang sốt ruột chờ / Chả thấy giao" khi nhân viên vừa nhắn → im; chờ quá hạn không ai nhắn → xin lỗi', async () => {
  const sim = new Sim({ psid: 'r18c-912698', settings: { staffComplaintWaitMs: 40 } });
  const box = sim.inbox({ labels: ['complaint'], botLastTemplateId: 'STAFF_WAIT_OPEN', botLastReplyAt: Date.now() - 4 * HOUR });
  sim.history(box, 'outgoing', 'Dạ hiện đơn này em đang khiếu nại giao lại đơn hàng cho mình rồi ạ', 4 * MIN, { staff: true });
  const first = await sim.send(box, 'Chị đang sốt ruột chờ', { llm: { template_id: 'DELIVERY_DELAY' } });
  assert.equal(first.result.skipped, 'nhân viên đang xử lý', JSON.stringify(first.result));
  assert.equal(idle.hasStaffIdleRecheck(`${box.id}:complaint`), true);
  await new Promise(resolve => setTimeout(resolve, 120));
  await idle.settleStaffIdleRechecks();
  assert.match(said(first), /xin lỗi/, 'lượt kiểm lại đã gửi');
  // Nhân viên trả lời trước hạn → lượt kiểm lại thôi.
  const sim2 = new Sim({ psid: 'r18c-912698b', settings: { staffComplaintWaitMs: 60 } });
  const box2 = sim2.inbox({ labels: ['complaint'] });
  sim2.history(box2, 'outgoing', 'Dạ em đang kiểm tra ạ', 4 * MIN, { staff: true });
  const waiting = await sim2.send(box2, 'Chả thấy giao', { llm: { template_id: 'DELIVERY_DELAY' } });
  sim2.history(box2, 'outgoing', 'Dạ em gọi shipper rồi ạ', 0, { staff: true });
  await new Promise(resolve => setTimeout(resolve, 150));
  await idle.settleStaffIdleRechecks();
  assert.deepEqual(waiting.sent, []);
  idle.clearStaffIdleRechecks();
});
