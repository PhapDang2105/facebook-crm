import assert from 'node:assert/strict';
import test from 'node:test';
import { carrierInfo, fetchSapoOrdersPage, sapoConfigFrom, sapoShipment } from '../app/sapo.mjs';
import { applyCarrierStage, attachShipmentsToConversations, attachShipmentsToLandingOrders, pickShipmentOrder, renderShipmentNotice, shipmentNote, shipmentNoticePlan, shipmentStage, stageFromSpxRecords } from '../app/sapo-tracking.mjs';
import { applyShipmentLabels, listShipmentNoticeQueue, recordShipmentNoticeResult, runSapoSync } from '../app/sapo-sync.mjs';
import { defaultConversationLabels } from '../app/inbox-settings.mjs';
import { autoLabelEvents } from '../app/processing/auto-label.mjs';

import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';
import { normalizeChatbotSettings } from '../app/chatbot-settings.mjs';
import { LEGACY_SHIPMENT_TEMPLATES } from '../app/shipment-stage.mjs';
import { processingNotes } from '../app/order-notes.mjs';

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-10-03T03:00:00Z');

// Dạng đơn Facebook thật trên Sapo (nhân viên import tay từ file Pancake), dữ liệu bịa.
function sapoOrder({ id = 1, phone = '0912345678', created = now - 2 * HOUR, carrier = 'JNT_EXPRESS', number = '802835136377', url = `https://jtexpress.vn/tracking?type=track&billcode=802835136377`, status = 'picked_up', source = 'facebook', total = 298000, note = null, tags = '' } = {}) {
  return {
    id, name: `SON${id}`, source_name: source, tags, note, created_on: new Date(created).toISOString(), status: 'open', total_price: total,
    phone: null, shipping_address: { phone },
    fulfillments: number ? [{ status: 'success', shipment_status: status, tracking_info: { carrier, tracking_number: number, tracking_url: url } }] : []
  };
}

const crmOrder = (id, { phone = '0912345678', createdAt = now - 20 * HOUR, total = 298000, ...rest } = {}) => ({ id, phone, createdAt, total, status: 'Mới', products: [{ sku: 'GRA-XANH' }], ...rest });
const conversation = (id, orders, { psid = id, pageId = 'p1', source = 'inbox', lastCustomerMessageAt = now - HOUR, gender = 'female' } = {}) => ({ id, pageId, psid, source, name: `Khách ${id}`, lastCustomerMessageAt, gender, customerOrders: orders });

test('đọc vận đơn từ đơn Sapo: bỏ đơn sàn, đơn chưa có mã, chuẩn hoá hãng + link', () => {
  const jnt = sapoShipment(sapoOrder());
  assert.equal(jnt.carrier, 'J&T Express');
  assert.equal(jnt.trackingNumber, '802835136377');
  assert.equal(jnt.phoneKey, '912345678');
  assert.match(jnt.trackingUrl, /jtexpress\.vn.*billcode=802835136377/);
  const spx = sapoShipment(sapoOrder({ carrier: 'SHOPEE_XPRESS', number: 'SPXVN06005175399A', url: null }));
  assert.equal(spx.carrier, 'SPX Express');
  assert.equal(spx.trackingUrl, 'https://spx.vn/track?SPXVN06005175399A');
  assert.equal(sapoShipment(sapoOrder({ source: 'shopee', tags: 'Shopee Channel' })), null);
  assert.equal(sapoShipment(sapoOrder({ number: null })), null);
  assert.equal(sapoShipment(sapoOrder({ phone: '' })), null);
  assert.equal(carrierInfo({ carrier: 'SAPO_EXPRESS', trackingNumber: 'SPXVN1234567' }).name, 'SPX Express');
});

test('cấu hình Sapo: bỏ đuôi .mysapo.net; báo khách theo cài đặt trừ khi .env đặt cứng', () => {
  const config = sapoConfigFrom({ SAPO_STORE: 'shop.mysapo.net', SAPO_API_KEY: 'k', SAPO_API_SECRET: 's' });
  assert.equal(config.store, 'shop');
  assert.equal(config.notifyCustomers, null);
  assert.equal(sapoConfigFrom({ SAPO_NOTIFY_CUSTOMERS: '1' }).notifyCustomers, true);
  assert.equal(sapoConfigFrom({ SAPO_NOTIFY_CUSTOMERS: '0' }).notifyCustomers, false);
});

test('gọi API Sapo: Basic auth, lọc theo modified_on_min, không truyền status', async () => {
  let seen;
  const fetchImpl = async (url, options) => { seen = { url: String(url), auth: options.headers.Authorization }; return { ok: true, status: 200, json: async () => ({ orders: [{ id: 1 }] }) }; };
  const orders = await fetchSapoOrdersPage({ modifiedSince: now, page: 2 }, { store: 'shop', apiKey: 'k', apiSecret: 's' }, fetchImpl);
  assert.equal(orders.length, 1);
  assert.equal(seen.auth, `Basic ${Buffer.from('k:s').toString('base64')}`);
  assert.match(seen.url, /^https:\/\/shop\.mysapo\.net\/admin\/orders\.json\?/);
  assert.match(seen.url, /modified_on_min=2026-10-03T03%3A00%3A00\.000Z/);
  assert.match(seen.url, /page=2/);
  assert.doesNotMatch(seen.url, /status=/);
});

test('ghép theo SĐT + thời gian; đơn quá cũ, đơn hủy, SĐT khác không ghép', () => {
  const shipment = sapoShipment(sapoOrder());
  const owner = 'p1:a';
  assert.equal(pickShipmentOrder(shipment, [{ order: crmOrder('A'), owner }]).matchedBy, 'phone+total');
  assert.equal(pickShipmentOrder(shipment, [{ order: crmOrder('A', { total: 1 }), owner }]).matchedBy, 'phone');
  assert.equal(pickShipmentOrder(shipment, [{ order: crmOrder('A', { createdAt: now - 12 * 24 * HOUR }), owner }]), null);
  assert.equal(pickShipmentOrder(shipment, [{ order: crmOrder('A', { processingStatus: 'cancelled' }), owner }]), null);
  assert.equal(pickShipmentOrder(shipment, [{ order: crmOrder('A', { phone: '0987654321' }), owner }]), null);
  // Đơn CRM tạo SAU vận đơn quá 2 giờ: không phải đơn này.
  assert.equal(pickShipmentOrder(shipment, [{ order: crmOrder('A', { createdAt: now + HOUR }), owner }]), null);
});

test('cùng SĐT ở hai khách khác nhau: chỉ ghép khi đúng một đơn trùng tổng tiền', () => {
  const shipment = sapoShipment(sapoOrder({ total: 298000 }));
  const two = [{ order: crmOrder('A', { total: 298000 }), owner: 'p1:a' }, { order: crmOrder('B', { total: 447000 }), owner: 'p2:b' }];
  assert.equal(pickShipmentOrder(shipment, two).candidate.order.id, 'A');
  const same = [{ order: crmOrder('A'), owner: 'p1:a' }, { order: crmOrder('B'), owner: 'p2:b' }];
  assert.deepEqual(pickShipmentOrder(shipment, same), { ambiguous: true });
});

test('ghi chú Sapo chứa mã đơn CRM/POS: ghép theo mã, kể cả khi SĐT khác', () => {
  const shipment = sapoShipment(sapoOrder({ note: 'Mã đơn Pancake: 4521, giao giờ HC' }));
  const pick = pickShipmentOrder(shipment, [
    { order: crmOrder('A1B2C', { phone: '0900000000', pos: { id: '4521' } }), owner: 'p1:a' },
    { order: crmOrder('ZZZ99'), owner: 'p1:b' }
  ]);
  assert.equal(pick.matchedBy, 'note');
  assert.equal(pick.candidate.order.id, 'A1B2C');
});

test('ghép vào hội thoại: hai vận đơn cùng SĐT vào hai đơn khác nhau, lượt sau chỉ cập nhật trạng thái', () => {
  const store = { conversations: [conversation('c1', [crmOrder('A', { createdAt: now - 30 * HOUR }), crmOrder('B', { createdAt: now - 10 * HOUR, total: 447000 })])], messages: {} };
  const first = sapoShipment(sapoOrder({ id: 1, number: '802800000001', url: null, total: 298000 }));
  const second = sapoShipment(sapoOrder({ id: 2, number: '802800000002', url: null, total: 447000 }));
  const result = attachShipmentsToConversations(store, [first, second], { now });
  assert.equal(result.changes.length, 2);
  const [a, b] = store.conversations[0].customerOrders;
  assert.equal(a.shipment.trackingNumber, '802800000001');
  assert.equal(b.shipment.trackingNumber, '802800000002');
  assert.equal(a.shipment.statusLabel, 'Đã lấy hàng');
  assert.equal(a.shipment.stage, 'picked_up');

  const again = attachShipmentsToConversations(store, [sapoShipment(sapoOrder({ id: 1, number: '802800000001', url: null, status: 'delivering' }))], { now: now + HOUR });
  assert.deepEqual(again.changes, [{ conversationId: 'c1', orderId: 'A', isNew: false, statusChanged: true }]);
  assert.equal(a.shipment.statusLabel, 'Đang vận chuyển');
  assert.equal(a.shipment.stage, 'in_transit');
  assert.equal(a.shipment.matchedAt, now);
  assert.equal(attachShipmentsToConversations(store, [sapoShipment(sapoOrder({ id: 1, number: '802800000001', url: null, status: 'delivering' }))], { now }).changes.length, 0);
});

test('đơn landing nhận vận đơn khi không có hội thoại nào khớp', () => {
  const landing = { orders: [crmOrder('LP-1', { landing: { posId: '9' } })] };
  assert.equal(attachShipmentsToLandingOrders(landing, [sapoShipment(sapoOrder())], { now }), 1);
  assert.equal(landing.orders[0].shipment.carrier, 'J&T Express');
});

test('giai đoạn vận đơn: Sapo + hành trình SPX; hoàn/hủy thì dừng', () => {
  assert.equal(shipmentStage({ status: 'pending' }), 'created');
  assert.equal(shipmentStage({ status: 'picked_up' }), 'picked_up');
  assert.equal(shipmentStage({ status: 'delivering' }), 'in_transit');
  assert.equal(shipmentStage({ status: 'delivering', carrierStage: 'out_for_delivery' }), 'out_for_delivery');
  assert.equal(shipmentStage({ status: 'retry_delivery' }), 'out_for_delivery');
  assert.equal(shipmentStage({ status: 'delivered', carrierStage: 'in_transit' }), 'delivered');
  assert.equal(shipmentStage({ status: 'returned' }), null);
  assert.equal(stageFromSpxRecords([{ status: 'Enter Domestic Sorting Center' }, { status: 'Pickup From Domestic Seller' }]), 'in_transit');
  assert.equal(stageFromSpxRecords([{ status: 'Delivering' }, { status: 'Enter Domestic Sorting Center' }]), 'out_for_delivery');
  assert.equal(stageFromSpxRecords([{ status: 'Delivered' }]), 'delivered');
  assert.equal(stageFromSpxRecords([{ status: 'Pickup Done' }]), 'picked_up');
});

function linkedStore({ status = 'picked_up', lastCustomerMessageAt = now - HOUR, messages = {} } = {}) {
  const order = crmOrder('A');
  const inbox = conversation('c1', [order], { lastCustomerMessageAt });
  const store = { conversations: [inbox], messages };
  attachShipmentsToConversations(store, [sapoShipment(sapoOrder({ status }))], { now });
  return { store, inbox, order };
}

test('báo khách: tin đầu là mã vận đơn; giai đoạn sau mỗi giai đoạn một tin; nhảy cóc chỉ báo mới nhất', () => {
  const { store, inbox, order } = linkedStore();
  let plan = shipmentNoticePlan(store, inbox, order, { now });
  assert.equal(plan.action, 'send');
  assert.equal(plan.templateId, 'SHIPMENT_CREATED');
  assert.equal(plan.stage, 'picked_up');
  order.shipment.notifiedStage = 'picked_up';
  assert.equal(shipmentNoticePlan(store, inbox, order, { now }).action, 'skip');
  order.shipment.status = 'delivering';
  order.shipment.stageAt = now;
  applyCarrierStage(order, 'out_for_delivery', now);
  plan = shipmentNoticePlan(store, inbox, order, { now });
  assert.equal(plan.templateId, 'SHIPMENT_OUT_FOR_DELIVERY');
  order.shipment.status = 'delivered';
  assert.equal(shipmentNoticePlan(store, inbox, order, { now }).templateId, 'SHIPMENT_DELIVERED');
});

test('báo khách: ngoài 24 giờ vào hàng chờ, giờ nghỉ thì chờ, giai đoạn quá 2 ngày chỉ ghi dấu, đã gửi mã tay thì thôi', () => {
  const outside = linkedStore({ lastCustomerMessageAt: now - 30 * HOUR });
  assert.equal(shipmentNoticePlan(outside.store, outside.inbox, outside.order, { now }).action, 'queue');
  const fresh = linkedStore();
  assert.equal(shipmentNoticePlan(fresh.store, fresh.inbox, fresh.order, { now, quietHour: true }).action, 'wait');
  assert.equal(shipmentNoticePlan(fresh.store, fresh.inbox, fresh.order, { now: now + 3 * 24 * HOUR }).action, 'mark');
  const staff = linkedStore({ messages: { c1: [{ direction: 'outgoing', text: 'Mã vận đơn của chị: 802835136377 nha', createdAt: now }] } });
  assert.deepEqual(shipmentNoticePlan(staff.store, staff.inbox, staff.order, { now }), { action: 'mark', stage: 'picked_up', reason: 'đã gửi mã trong hội thoại' });
  // Đơn ở luồng bình luận: báo vào hộp thư của cùng khách.
  const order = crmOrder('B');
  const comment = conversation('t1', [order], { source: 'comment', psid: 'c1' });
  const inbox = conversation('c1', []);
  const store = { conversations: [comment, inbox], messages: {} };
  attachShipmentsToConversations(store, [sapoShipment(sapoOrder())], { now });
  assert.equal(shipmentNoticePlan(store, comment, order, { now }).inbox, inbox);
});

test('lời báo khách: mẫu mặc định, mẫu chủ shop sửa, mẫu để trống = tắt; J&T nhắc 4 số cuối SĐT', () => {
  const shipment = { carrier: 'J&T Express', trackingNumber: '802835136377', trackingUrl: 'https://jtexpress.vn/x', status: 'picked_up' };
  const text = renderShipmentNotice(shipment, 'female');
  assert.match(text, /^Dạ, Giọt Nắng báo chị đơn hàng đã được đóng gói và giao cho J&T Express rồi ạ 📦/);
  assert.match(text, /Mã vận đơn: 802835136377/);
  assert.match(text, /Trạng thái: Đã lấy hàng/);
  assert.match(text, /🔎 Theo dõi hành trình: https:\/\/jtexpress\.vn\/x/);
  assert.match(text, /4 số cuối SĐT/);
  assert.doesNotMatch(renderShipmentNotice({ ...shipment, carrier: 'SPX Express' }), /4 số cuối/);
  assert.equal(renderShipmentNotice(shipment, 'male', 'SHIPMENT_DELIVERED', { SHIPMENT_DELIVERED: 'Cảm ơn {title}!' }), 'Cảm ơn anh!');
  assert.equal(renderShipmentNotice(shipment, 'male', 'SHIPMENT_IN_TRANSIT', { SHIPMENT_IN_TRANSIT: '' }), '');
  // Mẫu mặc định nằm trong seed để chủ shop sửa ở Cài đặt → Tin nhắn.
  const seed = defaultMessageTemplates();
  for (const id of ['SHIPMENT_CREATED', 'SHIPMENT_PICKED_UP', 'SHIPMENT_IN_TRANSIT', 'SHIPMENT_OUT_FOR_DELIVERY', 'SHIPMENT_DELIVERED', 'ORDER_STATUS_SHIPPED']) assert.ok(seed[id], id);
});

test('bot trả lời "đơn tới đâu" bằng mã vận đơn + giai đoạn + link khi đơn đã có vận đơn', () => {
  const { order } = linkedStore({ status: 'delivering' });
  const reply = renderChatbotReply({ template_id: 'ORDER_STATUS' }, defaultMessageTemplates(), { recentOrder: order, customer: { gender: 'female' } });
  const text = reply.messages.join('\n');
  assert.match(text, /🏷️ Mã vận đơn: 802835136377/);
  assert.match(text, /\nTrạng thái: Đang vận chuyển/);
  assert.match(text, /🔎 Theo dõi hành trình: https:\/\/jtexpress\.vn/);
  assert.match(text, /\nTrang J&T hỏi số điện thoại/);
  const plain = renderChatbotReply({ template_id: 'ORDER_STATUS' }, defaultMessageTemplates(), { recentOrder: crmOrder('Z'), customer: { gender: 'female' } });
  assert.doesNotMatch(plain.messages.join('\n'), /Mã vận đơn: \d/);
  // SPX không có dòng gợi ý J&T: dòng link vẫn phải còn (fill() bỏ dòng có ô trống).
  const spx = { ...order, shipment: { ...order.shipment, carrier: 'SPX Express', trackingNumber: 'SPXVN1', trackingUrl: 'https://spx.vn/track?SPXVN1' } };
  const spxText = renderChatbotReply({ template_id: 'ORDER_STATUS' }, defaultMessageTemplates(), { recentOrder: spx, customer: { gender: 'female' } }).messages.join('\n');
  assert.match(spxText, /🔎 Theo dõi hành trình: https:\/\/spx\.vn\/track\?SPXVN1/);
  assert.doesNotMatch(spxText, /4 số cuối/);
});

test('mẫu vận đơn còn đúng lời mặc định cũ thì tự đổi sang lời mới; lời chủ shop đã sửa giữ nguyên', () => {
  const shipment = { carrier: 'SPX Express', trackingNumber: 'SPXVN1', trackingUrl: 'u', status: 'picked_up' };
  const legacy = renderShipmentNotice(shipment, 'female', 'SHIPMENT_PICKED_UP', { SHIPMENT_PICKED_UP: LEGACY_SHIPMENT_TEMPLATES.SHIPMENT_PICKED_UP });
  assert.match(legacy, /^Dạ, đơn hàng của chị đã được SPX Express lấy hàng thành công rồi ạ\n/);
  assert.equal(renderShipmentNotice(shipment, 'female', 'SHIPMENT_PICKED_UP', { SHIPMENT_PICKED_UP: 'Lời riêng {tracking_number}' }), 'Lời riêng SPXVN1');
  const settings = normalizeChatbotSettings({ messageTemplates: { SHIPMENT_DELIVERED: LEGACY_SHIPMENT_TEMPLATES.SHIPMENT_DELIVERED, ORDER_STATUS_SHIPPED: LEGACY_SHIPMENT_TEMPLATES.ORDER_STATUS_SHIPPED } });
  assert.equal(settings.messageTemplates.SHIPMENT_DELIVERED, defaultMessageTemplates().SHIPMENT_DELIVERED);
  assert.equal(settings.messageTemplates.ORDER_STATUS_SHIPPED, defaultMessageTemplates().ORDER_STATUS_SHIPPED);

  // Giao thành công (SHIPMENT_DELIVERED): tự động hóa xưng hô theo giới tính Anh/Chị/Mình
  assert.equal(renderShipmentNotice(shipment, 'male', 'SHIPMENT_DELIVERED'),
    'Dạ em kiểm tra hệ thống đã ghi nhận anh nhận hàng thành công rồi ạ. Trong quá trình anh trải nghiệm, nếu gặp vấn đề gì về sản phẩm hay không hài lòng về sản phẩm anh nhắn em nhé, em hỗ trợ cho mình ngay ạ. Em cảm ơn anh đã tin tưởng ủng hộ Giọt Nắng, chúc anh ăn ngon miệng ạ.');
  assert.equal(renderShipmentNotice(shipment, 'female', 'SHIPMENT_DELIVERED'),
    'Dạ em kiểm tra hệ thống đã ghi nhận chị nhận hàng thành công rồi ạ. Trong quá trình chị trải nghiệm, nếu gặp vấn đề gì về sản phẩm hay không hài lòng về sản phẩm chị nhắn em nhé, em hỗ trợ cho mình ngay ạ. Em cảm ơn chị đã tin tưởng ủng hộ Giọt Nắng, chúc chị ăn ngon miệng ạ.');
  assert.equal(renderShipmentNotice(shipment, '', 'SHIPMENT_DELIVERED'),
    'Dạ em kiểm tra hệ thống đã ghi nhận Anh/Chị nhận hàng thành công rồi ạ. Trong quá trình Anh/Chị trải nghiệm, nếu gặp vấn đề gì về sản phẩm hay không hài lòng về sản phẩm Anh/Chị nhắn em nhé, em hỗ trợ cho mình ngay ạ. Em cảm ơn Anh/Chị đã tin tưởng ủng hộ Giọt Nắng, chúc Anh/Chị ăn ngon miệng ạ.');
});

test('bảng Đơn hàng hiện hãng + mã + giai đoạn giao', () => {
  const { order } = linkedStore({ status: 'delivering' });
  assert.equal(shipmentNote(order), 'ℹ J&T Express 802835136377 · Đang vận chuyển');
  assert.ok(processingNotes(order).includes('ℹ J&T Express 802835136377 · Đang vận chuyển'));
});

function memoryDeps({ store, orders, notify = true, sendMessage, state: initial = { noticesFrom: now - HOUR }, trackSpx }) {
  const sent = [];
  let state = initial;
  return {
    sent,
    get state() { return state; },
    deps: {
      now,
      log: () => {},
      notify,
      listOrders: async () => ({ orders, complete: true }),
      readState: async () => state,
      writeState: async value => { state = value; },
      readMessagingStore: async () => store,
      updateMessagingStore: async mutate => mutate(store),
      readLandingStore: async () => ({ orders: [] }),
      updateLandingStore: async mutate => mutate({ orders: [] }),
      sendMessage: sendMessage || (async (inbox, payload) => { sent.push({ inbox: inbox.id, ...payload }); return { message: { mid: 'm1' } }; }),
      genderOf: inbox => inbox.gender,
      readTemplates: async () => ({}),
      trackSpx
    }
  };
}

test('đồng bộ khi TẮT báo khách: chỉ ghi mã vào đơn, không gửi', async () => {
  const store = { conversations: [conversation('c1', [crmOrder('A')])], messages: {} };
  const harness = memoryDeps({ store, orders: [sapoOrder(), sapoOrder({ id: 9, source: 'shopee' })], notify: false });
  const summary = await runSapoSync(harness.deps);
  assert.equal(summary.shipments, 1);
  assert.equal(summary.linked, 1);
  assert.equal(harness.sent.length, 0);
  assert.equal(store.conversations[0].customerOrders[0].shipment.notifiedStage, undefined);
  assert.equal(harness.state.cursor, now);
});

test('đồng bộ khi BẬT: gửi tin mã vận đơn một lần; lỗi thì không tự gửi lại mà vào hàng chờ', async () => {
  const store = { conversations: [conversation('c1', [crmOrder('A')])], messages: {} };
  const harness = memoryDeps({ store, orders: [sapoOrder()] });
  assert.equal((await runSapoSync(harness.deps)).sent, 1);
  assert.match(harness.sent[0].text, /Mã vận đơn: 802835136377/);
  assert.equal(store.conversations[0].customerOrders[0].shipment.notifiedStage, 'picked_up');
  await runSapoSync(harness.deps);
  assert.equal(harness.sent.length, 1);

  const failing = { conversations: [conversation('c2', [crmOrder('B')])], messages: {} };
  const broken = memoryDeps({ store: failing, orders: [sapoOrder()], sendMessage: async () => { throw new Error('(#10) outside allowed window'); } });
  assert.equal((await runSapoSync(broken.deps)).failed, 1);
  const again = await runSapoSync(broken.deps);
  assert.equal(again.failed, 0);
  assert.equal(again.queued, 1);
  const queue = listShipmentNoticeQueue(failing, { now });
  assert.equal(queue.length, 1);
  assert.match(queue[0].error, /outside allowed window/);
  assert.equal(queue[0].key, 'c2|B|picked_up');
});

test('lần đầu bật: vận đơn cũ hơn 24 giờ chỉ ghi dấu, không nhắn dồn', async () => {
  const store = { conversations: [conversation('c1', [crmOrder('A', { createdAt: now - 60 * HOUR })]), conversation('c2', [crmOrder('B', { phone: '0987654321' })])], messages: {} };
  const harness = memoryDeps({ store, orders: [sapoOrder({ created: now - 50 * HOUR }), sapoOrder({ id: 2, phone: '0987654321', number: '802800000009', url: null })], state: {} });
  const summary = await runSapoSync(harness.deps);
  assert.equal(summary.marked, 1);
  assert.equal(summary.sent, 1);
  assert.equal(harness.sent[0].inbox, 'c2');
  assert.equal(store.conversations[0].customerOrders[0].shipment.notices[0].via, 'baseline');
  assert.ok(harness.state.noticesFrom);
});

test('tra hành trình SPX: "đang giao cho khách" báo sớm hơn Sapo', async () => {
  const store = { conversations: [conversation('c1', [crmOrder('A')])], messages: {} };
  const orders = [sapoOrder({ carrier: 'SHOPEE_XPRESS', number: 'SPXVN0001', url: null, status: 'delivering' })];
  const harness = memoryDeps({ store, orders, trackSpx: async () => ({ records: [{ status: 'Delivering' }] }) });
  await runSapoSync(harness.deps);
  const shipment = store.conversations[0].customerOrders[0].shipment;
  assert.equal(shipment.carrierStage, 'out_for_delivery');
  assert.equal(shipment.notifiedStage, 'out_for_delivery');
  assert.match(harness.sent[0].text, /SPX Express/);
});

test('hàng chờ: nhân viên gửi qua Pancake / gửi tay / bỏ qua đều ghi dấu giai đoạn', () => {
  const { store } = linkedStore({ lastCustomerMessageAt: now - 30 * HOUR });
  const [item] = listShipmentNoticeQueue(store, { now });
  assert.equal(item.inWindow, false);
  assert.match(item.text, /Mã vận đơn/);
  assert.ok(recordShipmentNoticeResult(store, item.key, { ok: true, via: 'pancake-bridge', now }));
  assert.equal(listShipmentNoticeQueue(store, { now }).length, 0);
  assert.equal(store.conversations[0].customerOrders[0].shipment.notices.at(-1).via, 'pancake-bridge');
  assert.equal(recordShipmentNoticeResult(store, 'khong|co|gi', { ok: true }), false);
});

test('thẻ tự động: "Đã gửi mã vận đơn" khi đã báo khách, "Giao hàng thành công" khi giao xong; mỗi vận đơn một lần', async () => {
  const store = { conversations: [conversation('c1', [crmOrder('A')])], messages: {} };
  const changes = [];
  const harness = memoryDeps({ store, orders: [sapoOrder()] });
  Object.assign(harness.deps, { labelIds: async () => ({ sent: ['shipment-sent'], delivered: ['delivered'] }), onLabelChanges: list => changes.push(...list) });
  const first = await runSapoSync(harness.deps);
  assert.equal(first.sent, 1);
  assert.deepEqual(store.conversations[0].labels, ['shipment-sent']);
  assert.match(changes[0].reason, /đã gửi mã vận đơn 802835136377/);
  // Nhân viên gỡ thẻ: lượt sau không gắn lại.
  store.conversations[0].labels = [];
  harness.deps.listOrders = async () => ({ orders: [sapoOrder({ status: 'delivered' })], complete: true });
  await runSapoSync(harness.deps);
  assert.deepEqual(store.conversations[0].labels, ['delivered']);
  await runSapoSync(harness.deps);
  assert.deepEqual(store.conversations[0].labels, ['delivered']);
  assert.equal(changes.length, 2);
});

test('thẻ tự động: ghi dấu baseline không tính là đã gửi mã; gửi qua Pancake thì có thẻ ngay', () => {
  const { store } = linkedStore({ lastCustomerMessageAt: now - 30 * HOUR });
  store.conversations[0].customerOrders[0].shipment.notices = [{ stage: 'created', via: 'baseline', at: now }];
  assert.deepEqual(applyShipmentLabels(store, { sentLabels: ['shipment-sent'] }), []);
  recordShipmentNoticeResult(store, 'c1|A|picked_up', { ok: true, via: 'pancake-bridge', now });
  assert.equal(applyShipmentLabels(store, { sentLabels: ['shipment-sent'] }).length, 1);
  assert.deepEqual(store.conversations[0].labels, ['shipment-sent']);
});

test('thẻ mặc định mới có trong bộ thẻ và sự kiện tự động', () => {
  const ids = defaultConversationLabels.map(label => `${label.id}:${label.auto}`);
  assert.ok(ids.includes('shipment-sent:shipment-sent'));
  assert.ok(ids.includes('delivered:delivered'));
  assert.ok(autoLabelEvents.includes('shipment-sent') && autoLabelEvents.includes('delivered'));
});

test('gửi qua cầu nối lỗi: đếm số lần theo giai đoạn để tự gửi dừng sau 2 lần', () => {
  const { store } = linkedStore({ lastCustomerMessageAt: now - 30 * HOUR });
  const key = 'c1|A|picked_up';
  recordShipmentNoticeResult(store, key, { ok: false, error: 'extension Pancake không tìm được ID Facebook của khách', now });
  recordShipmentNoticeResult(store, key, { ok: false, error: 'extension Pancake không tìm được ID Facebook của khách', now });
  const [item] = listShipmentNoticeQueue(store, { now });
  assert.equal(item.attempts, 2);
  assert.match(item.error, /không tìm được ID Facebook/);
  recordShipmentNoticeResult(store, key, { ok: true, via: 'manual', now });
  assert.equal(store.conversations[0].customerOrders[0].shipment.noticeAttempts, undefined);
});

test('tin vận đơn ít icon: không ✅, không 🚚; chỉ 🏷️ / 🔎 và một icon đầu tin', () => {
  for (const id of ['SHIPMENT_CREATED', 'SHIPMENT_PICKED_UP', 'SHIPMENT_IN_TRANSIT', 'SHIPMENT_OUT_FOR_DELIVERY', 'SHIPMENT_DELIVERED', 'ORDER_STATUS_SHIPPED']) {
    const text = defaultMessageTemplates()[id];
    assert.doesNotMatch(text, /[✅🚚📱📞🕒📍]/u, id);
  }
});
