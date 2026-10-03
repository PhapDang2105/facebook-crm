// Vòng 14 (03/10) — chủ shop: khi bot định im vì câu trả lời trùng tin vừa gửi mà khách hỏi ý mới, bot báo "bạn phụ trách
// sẽ trả lời" theo giờ hành chính 8h–17h (giờ VN); ngoài giờ hẹn 8h sáng. Tối đa 1 lần mỗi 2 giờ mỗi hội thoại.
// Ca thật 02/10: "Đắt hơn túi zip à shop" sau bảng giá → bot im 12 giờ.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, templates } from './helpers/r13-engine-sim.mjs';
import { STAFF_WAIT_COOLDOWN_MS, staffWaitTemplate } from '../app/chatbot-engine.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

const MIN = 60 * 1000;
// Giờ VN = UTC+7: 10h VN = 03:00 UTC, 7h VN = 00:00 UTC, 20h VN = 13:00 UTC, 17h VN = 10:00 UTC.
const vn = hour => Date.UTC(2026, 9, 3, hour - 7);

test('giờ hành chính 8h–17h: trong giờ báo trả lời ngay; trước 8h hẹn sáng nay; từ 17h hẹn sáng mai', () => {
  assert.deepEqual(staffWaitTemplate(vn(10)), { templateId: 'STAFF_WAIT_OPEN', when: '' });
  assert.deepEqual(staffWaitTemplate(vn(8)), { templateId: 'STAFF_WAIT_OPEN', when: '' });
  assert.deepEqual(staffWaitTemplate(vn(16) + 59 * MIN), { templateId: 'STAFF_WAIT_OPEN', when: '' });
  assert.deepEqual(staffWaitTemplate(vn(17)), { templateId: 'STAFF_WAIT_CLOSED', when: 'sáng mai' });
  assert.deepEqual(staffWaitTemplate(vn(20)), { templateId: 'STAFF_WAIT_CLOSED', when: 'sáng mai' });
  assert.deepEqual(staffWaitTemplate(vn(7)), { templateId: 'STAFF_WAIT_CLOSED', when: 'sáng nay' });
  const closed = renderChatbotReply({ template_id: 'STAFF_WAIT_CLOSED', values: { when: 'sáng mai' } }, templates, { customer: { gender: 'female' } });
  assert.match(closed.messages.join(' '), /8h đến 17h.*8h sáng mai/);
  assert.doesNotMatch(closed.messages.join(' '), /\{when\}/);
});

test('"Đắt hơn túi zip à shop" sau bảng giá: không im, báo bạn phụ trách + thẻ; 2 giờ sau mới báo lại', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ gender: 'female', botGender: 'female' });
  const first = await sim.send(inbox, 'Giá sao shop', { llm: { template_id: 'PRICE_QUOTE' } });
  assert.equal(first.result.templateId, 'PRICE_QUOTE');
  const zip = await sim.send(inbox, 'Đắt hơn túi zip à shop', { llm: { template_id: 'PRICE_QUOTE' } });
  assert.match(zip.result.templateId, /^STAFF_WAIT_(OPEN|CLOSED)$/, JSON.stringify(zip.result));
  assert.ok(zip.sent.length > 0);
  assert.match(zip.sent.map(item => item.text).join(' '), /bạn phụ trách/);
  assert.ok(inbox.labels.includes('handoff'));
  assert.ok(Number(inbox.staffWaitAt) > 0);
  assert.notEqual(inbox.botEnabled, false, 'không tắt bot');
  // Ngay sau đó khách hỏi tiếp, bot vẫn trùng: im (đã báo trong 2 giờ).
  const again = await sim.send(inbox, 'Túi zip bên kia rẻ hơn mà', { llm: { template_id: 'PRICE_QUOTE' } });
  assert.equal(again.result.skipped, 'lặp tin vừa gửi', JSON.stringify(again.result));
  assert.deepEqual(again.sent, []);
  // Quá 2 giờ: báo lại được.
  inbox.staffWaitAt = Date.now() - STAFF_WAIT_COOLDOWN_MS - MIN;
  const later = await sim.send(inbox, 'Giá túi zip là bao nhiêu', { llm: { template_id: 'PRICE_QUOTE' } });
  assert.notEqual(later.result.skipped, 'lặp tin vừa gửi', JSON.stringify(later.result));
});

test('lời đáp ngắn ("ok", "dạ") trùng tin vừa gửi vẫn im như cũ, không báo bạn phụ trách', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox();
  await sim.send(inbox, 'có giấy chứng nhận không', { llm: { template_id: 'CERTIFICATION' } });
  const ok = await sim.send(inbox, 'ok', { llm: { template_id: 'CERTIFICATION' } });
  assert.doesNotMatch(String(ok.result.templateId || ''), /STAFF_WAIT/, JSON.stringify(ok.result));
});
