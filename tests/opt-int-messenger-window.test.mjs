import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

// INT-15: một cách tính cửa sổ 24 giờ Messenger cho bám đuổi (chọn ứng viên + gửi riêng) và báo vận đơn Sapo.
process.env.META_CONVERSATIONS_PATH = path.join(tempDir('opt-int-window-'), 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(tempDir('opt-int-window-fu-'), 'follow-ups.json');
const { messengerWindowOpen, lastCustomerMessageAt } = await import('../app/messenger-window.mjs');
const { findFollowUpCandidates, inboxWindowOpen } = await import('../app/follow-up.mjs');
const { shipmentNoticePlan } = await import('../app/sapo-tracking.mjs');

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-09-19T12:00:00Z');

test('helper: lấy mốc mới hơn giữa lastCustomerMessageAt và tin khách đã lưu; chừa 1 giờ', () => {
  const inbox = { id: '1:a', lastCustomerMessageAt: now - 2 * HOUR };
  const store = { messages: { '1:a': [{ direction: 'incoming', createdAt: now - 30 * HOUR }] } };
  assert.equal(lastCustomerMessageAt(store, inbox), now - 2 * HOUR);
  assert.equal(messengerWindowOpen(store, inbox, { now }), true);
  assert.equal(messengerWindowOpen(store, { ...inbox, lastCustomerMessageAt: now - 23.5 * HOUR }, { now }), false, 'quá 23 giờ (chừa 1 giờ)');
  assert.equal(messengerWindowOpen(store, { ...inbox, lastCustomerMessageAt: now - 23.5 * HOUR }, { now, marginMs: 0 }), true);
  assert.equal(messengerWindowOpen(store, null, { now }), false);
  assert.equal(inboxWindowOpen(store, inbox, now), true);
});

test('chọn ứng viên bám đuổi hộp thư: tin khách đã lưu cũ (bị cắt) nhưng mốc lastCustomerMessageAt mới → trong cửa sổ', () => {
  // Tin khách mới nhất còn lưu: 26 giờ trước; Page trả lời 25 giờ trước; mốc trên hội thoại: khách nhắn 4 giờ trước.
  const inbox = { id: '1:b', pageId: '1', psid: 'b', source: 'inbox', name: 'B', lastCustomerMessageAt: now - 4 * HOUR };
  const store = {
    conversations: [inbox],
    messages: { '1:b': [{ id: 'x1', direction: 'incoming', createdAt: now - 26 * HOUR, text: 'hỏi' }, { id: 'x2', direction: 'outgoing', createdAt: now - 25 * HOUR, text: 'đáp' }] }
  };
  const scenario = { id: 'inbox-3h', trigger: 'inbox-no-reply', delayHours: 3 };
  const [candidate] = findFollowUpCandidates(store, scenario, { now, activatedAt: 0 });
  assert.ok(candidate);
  assert.equal(candidate.outsideWindow, false);
});

test('Sapo: hộp thư ngoài 23 giờ → hàng chờ, trong cửa sổ → tự gửi (cùng helper)', () => {
  const order = { id: 'A', createdAt: now - 20 * HOUR, shipment: { trackingNumber: '1', carrier: 'J&T Express', status: 'picked_up', stage: 'picked_up', createdAt: now - HOUR, stageAt: now - HOUR } };
  const inside = { id: 'c1', pageId: 'p', psid: 'c1', source: 'inbox', lastCustomerMessageAt: now - 2 * HOUR, customerOrders: [order] };
  const outside = { ...inside, lastCustomerMessageAt: now - 23.5 * HOUR };
  assert.equal(shipmentNoticePlan({ conversations: [inside], messages: {} }, inside, order, { now, quietHour: false }).action, 'send');
  assert.equal(shipmentNoticePlan({ conversations: [outside], messages: {} }, outside, order, { now, quietHour: false }).action, 'queue');
});
