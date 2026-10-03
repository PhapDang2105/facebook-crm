import assert from 'node:assert/strict';
import test from 'node:test';
import { carrierInfo, fetchSapoOrdersPage, sapoConfigFrom, sapoShipment } from '../app/sapo.mjs';
import { attachShipmentsToConversations, attachShipmentsToLandingOrders, pickShipmentOrder, renderShipmentNotice, shipmentNote, shipmentNoticePlan } from '../app/sapo-tracking.mjs';
import { runSapoSync } from '../app/sapo-sync.mjs';
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

test('cấu hình Sapo: bỏ đuôi .mysapo.net, mặc định KHÔNG nhắn khách', () => {
  const config = sapoConfigFrom({ SAPO_STORE: 'shop.mysapo.net', SAPO_API_KEY: 'k', SAPO_API_SECRET: 's' });
  assert.equal(config.store, 'shop');
  assert.equal(config.notifyCustomers, false);
  assert.equal(sapoConfigFrom({ SAPO_NOTIFY_CUSTOMERS: '1' }).notifyCustomers, true);
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

  const again = attachShipmentsToConversations(store, [sapoShipment(sapoOrder({ id: 1, number: '802800000001', url: null, status: 'delivering' }))], { now: now + HOUR });
  assert.deepEqual(again.changes, [{ conversationId: 'c1', orderId: 'A', isNew: false, statusChanged: true }]);
  assert.equal(a.shipment.statusLabel, 'Đang giao');
  assert.equal(a.shipment.matchedAt, now);
  assert.equal(attachShipmentsToConversations(store, [sapoShipment(sapoOrder({ id: 1, number: '802800000001', url: null, status: 'delivering' }))], { now }).changes.length, 0);
});

test('đơn landing nhận vận đơn khi không có hội thoại nào khớp', () => {
  const landing = { orders: [crmOrder('LP-1', { landing: { posId: '9' } })] };
  assert.equal(attachShipmentsToLandingOrders(landing, [sapoShipment(sapoOrder())], { now }), 1);
  assert.equal(landing.orders[0].shipment.carrier, 'J&T Express');
});

test('nhắn khách: chỉ trong 24 giờ Messenger, ngoài giờ nghỉ, vận đơn còn mới và chưa giao', () => {
  const order = crmOrder('A');
  const inbox = conversation('c1', [order]);
  const store = { conversations: [inbox], messages: {} };
  attachShipmentsToConversations(store, [sapoShipment(sapoOrder())], { now });
  assert.equal(shipmentNoticePlan(store, inbox, order, { now }).action, 'send');
  assert.equal(shipmentNoticePlan(store, inbox, order, { now, quietHour: true }).action, 'wait');
  assert.equal(shipmentNoticePlan(store, { ...inbox, lastCustomerMessageAt: now - 30 * HOUR }, order, { now }).reason, 'ngoài 24 giờ Messenger');
  assert.equal(shipmentNoticePlan(store, inbox, { ...order, shipment: { ...order.shipment, status: 'delivered' } }, { now }).action, 'skip');
  assert.equal(shipmentNoticePlan(store, inbox, { ...order, shipment: { ...order.shipment, noticeAt: now } }, { now }).action, 'skip');
  assert.equal(shipmentNoticePlan(store, inbox, order, { now: now + 5 * 24 * HOUR }).reason, 'vận đơn đã cũ');
  // Đơn nằm ở luồng bình luận: nhắn vào hộp thư của cùng khách.
  const comment = conversation('t1', [order], { source: 'comment', psid: 'c1' });
  assert.equal(shipmentNoticePlan({ conversations: [comment, inbox], messages: {} }, comment, order, { now }).inbox, inbox);
});

test('tin báo mã vận đơn: xưng hô, link, nhắc 4 số cuối SĐT cho J&T', () => {
  const text = renderShipmentNotice({ carrier: 'J&T Express', trackingNumber: '802835136377', trackingUrl: 'https://jtexpress.vn/x' }, 'female');
  assert.match(text, /đơn hàng của chị đã được giao cho J&T Express, mã vận đơn: 802835136377/);
  assert.match(text, /Chị theo dõi hành trình đơn tại: https:\/\/jtexpress\.vn\/x/);
  assert.match(text, /4 số cuối SĐT/);
  assert.doesNotMatch(renderShipmentNotice({ carrier: 'SPX Express', trackingNumber: 'SPXVN1', trackingUrl: 'u' }), /4 số cuối/);
  assert.match(renderShipmentNotice({ carrier: 'SPX Express', trackingNumber: 'SPXVN1', trackingUrl: 'u' }), /anh\/chị/);
});

test('bảng Đơn hàng hiện hãng + mã + trạng thái giao', () => {
  const order = crmOrder('A', { address: '' });
  attachShipmentsToConversations({ conversations: [conversation('c1', [order])], messages: {} }, [sapoShipment(sapoOrder({ status: 'delivering' }))], { now });
  assert.equal(shipmentNote(order), 'ℹ J&T Express 802835136377 · Đang giao');
  assert.ok(processingNotes(order).includes('ℹ J&T Express 802835136377 · Đang giao'));
});

function memoryDeps({ store, orders, notify = false, sendMessage }) {
  const sent = [];
  let state = {};
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
      genderOf: inbox => inbox.gender
    }
  };
}

test('một lượt đồng bộ khi CHƯA bật nhắn khách: ghi mã vào đơn, chỉ đếm tin lẽ ra gửi', async () => {
  const store = { conversations: [conversation('c1', [crmOrder('A')])], messages: {} };
  const harness = memoryDeps({ store, orders: [sapoOrder(), sapoOrder({ id: 9, source: 'shopee' })] });
  const summary = await runSapoSync(harness.deps);
  assert.equal(summary.shipments, 1);
  assert.equal(summary.linked, 1);
  assert.equal(summary.wouldSend, 1);
  assert.equal(harness.sent.length, 0);
  assert.equal(store.conversations[0].customerOrders[0].shipment.noticeAt, undefined);
  assert.equal(harness.state.cursor, now);
});

test('bật nhắn khách: gửi một lần mỗi mã vận đơn; gửi lỗi thì ghi lỗi, không gửi lại', async () => {
  const store = { conversations: [conversation('c1', [crmOrder('A')])], messages: {} };
  const harness = memoryDeps({ store, orders: [sapoOrder()], notify: true });
  const summary = await runSapoSync(harness.deps);
  assert.equal(summary.sent, 1);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /mã vận đơn: 802835136377/);
  assert.equal(store.conversations[0].customerOrders[0].shipment.noticeVia, 'bot');
  await runSapoSync(harness.deps);
  assert.equal(harness.sent.length, 1);

  const failing = { conversations: [conversation('c2', [crmOrder('B')])], messages: {} };
  const broken = memoryDeps({ store: failing, orders: [sapoOrder()], notify: true, sendMessage: async () => { throw new Error('(#10) outside allowed window'); } });
  const result = await runSapoSync(broken.deps);
  assert.equal(result.failed, 1);
  const order = failing.conversations[0].customerOrders[0];
  assert.equal(order.shipment.noticeVia, 'failed');
  assert.ok(processingNotes(order).some(note => note.startsWith('⚠ Chưa nhắn được mã vận đơn')));
});
