// Vòng 18 — gói D: bám đuổi đọc ngữ cảnh + Sapo (out-cross 4.1/4.3/4.5, out-inbox1 V7, out-inbox3 V10, out-inbox4 L1).
import './helpers/seed-catalog.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { customerDeclined, orderRemindText } from '../app/follow-up.mjs';
import { shipmentNoticePlan } from '../app/sapo-tracking.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { templates } from './helpers/r13-engine-sim.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const now = Date.parse('2026-10-10T01:28:00Z');
const TROPICAL = { product: 'Granola Tropical vị Cacao 300g', code: 'GRA-MINT-Z300', quantity: 1 };
const VANG = { product: 'Granola Túi Vàng 350g', code: 'GRA-VANG-H350', quantity: 1 };
const XANH = { product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 };

test('R18 D cross 4.3 (…881444 "Giá hơi c nên c ko mua nhé"): khách từ chối không có chữ "nữa" → dừng bám đuổi', () => {
  for (const text of ['Giá hơi c nên c ko mua nhé', 'thôi k mua nha', 'Chị không lấy đâu', 'kg đặt nhé shop']) assert.equal(customerDeclined(text), true, text);
  for (const text of ['sao ko mua được vậy?', 'ko mua nhiều được không', 'Mình không mua được trên sàn', 'k lấy quạt nhé']) assert.equal(customerDeclined(text), false, text);
});

test('R18 D cross 4.1 / inbox1 V7 (…669432): giỏ 1 Tropical, sau đó khách hỏi bảng mix túi lớn (bot PRICE_MIX_TUI_LON) → không nhắc "đang giữ đơn 1 Tropical"', () => {
  const at = now - 12 * HOUR;
  const conversation = { gender: 'female', pendingOrder: { items: [TROPICAL], key: 'GRA-MINT-Z300=1', at, phone: '', address: '', upsold: true, livestream: true }, botLastTemplateId: 'PRICE_MIX_TUI_LON', botLastReplyAt: at + 214 * 1000 };
  const messages = [
    { direction: 'incoming', text: 'Em cho thông tin sp mổi túi/ màu giúp chị ba', createdAt: at + 19 * 1000 },
    { direction: 'outgoing', text: 'Dạ chị ơi, phiên live nhà em có: …', createdAt: at + 30 * 1000 },
    { direction: 'incoming', text: 'Nếu chị mua mổi màu/ bịch thì giá sao em ha', createdAt: at + 200 * 1000 },
    { direction: 'outgoing', text: 'Dạ bảng giá mix túi lớn ạ: • Xanh + Vàng: 298.000đ …', createdAt: at + 214 * 1000 }
  ];
  assert.equal(orderRemindText(conversation, templates, { now, messages }), '');
  // Đối chứng: tin bot cuối vẫn là bước giỏ → nhắc giỏ như cũ.
  assert.match(orderRemindText({ ...conversation, botLastTemplateId: 'ORDER_ADDRESS' }, templates, { now, messages }), /đang giữ đơn 1 Granola Tropical/);
  // Bot trả bảng giá KÈM câu nhắc giỏ (tin bot cuối có "đang giữ đơn") → giỏ vẫn là trọng tâm, vẫn nhắc.
  const withRemind = [...messages, { direction: 'outgoing', text: 'Dạ em vẫn đang giữ đơn 1 Granola Tropical vị Cacao 300g – tổng 219.000đ cho chị ạ', createdAt: at + 215 * 1000 }];
  assert.match(orderRemindText({ ...conversation, botLastTemplateId: 'PRICE_QUOTE' }, templates, { now, messages: withRemind }), /đang giữ đơn/);
});

test('R18 D cross 4.1 (…069730 Kimrobot "1 vàng 1 xanh", khách live): nhắc giỏ kèm quà Quạt', () => {
  const conversation = { gender: 'male', labels: ['livestream'], pendingOrder: { items: [VANG, XANH], key: 'GRA-VANG-H350=1|GRA-XANH-Z450=1', at: now - 12 * HOUR, phone: '', address: 'Số 1 đường A, phường Bến Thành, Quận 1, TP HCM', livestream: true }, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: now - 12 * HOUR };
  const text = orderRemindText(conversation, templates, { now });
  assert.match(text, /tổng 298\.000đ, tặng Quạt \+ Bát gáo dừa cho anh/, text);
  assert.match(text, /số điện thoại/);
  // Khách thường 2 túi: không có quà hiện vật → không thêm "tặng".
  const plain = orderRemindText({ ...conversation, labels: [], pendingOrder: { ...conversation.pendingOrder, livestream: false } }, templates, { now });
  assert.match(plain, /tổng 298\.000đ cho anh/, plain);
});

test('R18 D cross 4.5 (…653689 "Hôm nay c nghỉ phép. Nói họ giữ đó thứ 2 giao"): xin giữ hàng → ORDER_HOLD_STAFF (ghi chú + bạn phụ trách), không thẻ trạng thái đơn', () => {
  const ruled = ruleIntent('Hôm nay c nghỉ phép. Nói họ giữ đó thứ 2 giao', { source: 'inbox', botLastTemplateId: 'SHIPMENT_OUT_FOR_DELIVERY', botLastAgeMin: 2, bundleSize: 1, hasRecentOrder: true, orderAgeMin: 2 * 24 * 60 });
  assert.equal(ruled?.value?.template_id, 'ORDER_HOLD_STAFF', JSON.stringify(ruled));
  assert.equal(Boolean(ruled?.orderNote), true);
});

const shipped = (status, extra = {}) => ({ id: 'A', createdAt: now - 48 * HOUR, status: 'Đã xác nhận', shipment: { trackingNumber: 'SPXVN061', carrier: 'SPX Express', status, createdAt: now - 30 * HOUR, stageAt: now - 5 * MIN, notifiedStage: 'created', notifiedAt: now - 28 * HOUR, ...extra } });
const inboxOf = order => ({ id: 'p:558', pageId: 'p', psid: '558', source: 'inbox', lastCustomerMessageAt: now - 3 * MIN, customerOrders: [order] });

test('R18 D cross 4.5 / inbox3 V10 (…024636 "Nay mới nhận đc đồ của shop" 12:59 → Sapo "đang giao" 13:01): khách vừa báo đã nhận → không gửi "đang giao"', () => {
  const order = shipped('retry_delivery');
  const inbox = inboxOf(order);
  const store = { conversations: [inbox], messages: { [inbox.id]: [{ id: 'k1', direction: 'incoming', type: 'text', text: 'Nay mới nhận đc đồ của shop', createdAt: now - 3 * MIN }] } };
  const plan = shipmentNoticePlan(store, inbox, order, { now, quietHour: false });
  assert.equal(plan.action, 'mark', JSON.stringify(plan));
  // Đối chứng: khách hỏi "khi nào nhận được hàng" → vẫn báo đang giao.
  const asked = { conversations: [inbox], messages: { [inbox.id]: [{ id: 'k2', direction: 'incoming', type: 'text', text: 'khi nào mới nhận được hàng vậy shop', createdAt: now - 3 * MIN }] } };
  assert.equal(shipmentNoticePlan(asked, inbox, order, { now, quietHour: false }).action, 'send');
});

test('R18 D inbox4 L1 (…508323353 "nhận hàng thành công" 20:11 và 21:18): lời "giao thành công" đã có trong hội thoại → không gửi / không xếp hàng chờ lần nữa', () => {
  const order = shipped('delivered', { stageAt: now - 2 * HOUR });
  const inbox = inboxOf(order);
  const sent = { id: 'o1', direction: 'outgoing', type: 'text', text: 'Dạ em kiểm tra hệ thống đã ghi nhận chị nhận hàng thành công rồi ạ. Trong quá trình chị trải nghiệm…', createdAt: now - 67 * MIN };
  const plan = shipmentNoticePlan({ conversations: [inbox], messages: { [inbox.id]: [sent] } }, inbox, order, { now, quietHour: false });
  assert.equal(plan.action, 'mark', JSON.stringify(plan));
  assert.equal(shipmentNoticePlan({ conversations: [inbox], messages: { [inbox.id]: [] } }, inbox, order, { now, quietHour: false }).action, 'send');
});
