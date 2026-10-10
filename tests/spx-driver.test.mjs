// 10/10 (chủ shop): tra đơn ngoài sàn ở trang Vận chuyển theo SĐT/tên, tra SPX tự động cả đơn landing, và gửi số
// điện thoại tài xế SPX cho khách trong tin "đang giao hàng" (spx.vn công khai trả driver_phone_number).
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSpxPayload } from '../app/spx-tracking.mjs';
import { renderShipmentNotice } from '../app/sapo-tracking.mjs';
import { runSapoSync } from '../app/sapo-sync.mjs';
import { lookupShippingOrders } from '../app/shipping-lookup.mjs';

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-10-10T03:00:00Z');
const spxPayload = (extra = {}) => ({ retcode: 0, data: { sls_tracking_info: { records: [{ tracking_name: 'Out For Delivery', description: 'Đang giao hàng', actual_time: 1791590000 }], ...extra } } });

test('đọc số tài xế từ spx.vn: "84…" thành "0…", không có hay lạ thì rỗng', () => {
  assert.equal(normalizeSpxPayload(spxPayload({ driver_phone_number: '84912345678' }), 'SPXVN1').driverPhone, '0912345678');
  assert.equal(normalizeSpxPayload(spxPayload({ driver_phone_number: '0987654321' }), 'SPXVN1').driverPhone, '0987654321');
  assert.equal(normalizeSpxPayload(spxPayload(), 'SPXVN1').driverPhone, '');
  assert.equal(normalizeSpxPayload(spxPayload({ driver_phone_number: '12345' }), 'SPXVN1').driverPhone, '');
});

test('tin "đang giao hàng" thêm số tài xế khi biết; mẫu có {driver_phone} thì đặt đúng chỗ; bước khác không thêm', () => {
  const shipment = { carrier: 'SPX Express', trackingNumber: 'SPXVN1', status: 'delivering', carrierStage: 'out_for_delivery', driverPhone: '0912345678' };
  const text = renderShipmentNotice(shipment, 'female', 'SHIPMENT_OUT_FOR_DELIVERY');
  assert.match(text, /Em cảm ơn chị nhiều ạ\.\n\nSố điện thoại shipper giao hàng cho chị: 0912345678$/);
  assert.doesNotMatch(renderShipmentNotice({ ...shipment, driverPhone: '' }, 'female', 'SHIPMENT_OUT_FOR_DELIVERY'), /Số điện thoại shipper/);
  const custom = renderShipmentNotice(shipment, 'male', 'SHIPMENT_OUT_FOR_DELIVERY', { SHIPMENT_OUT_FOR_DELIVERY: 'Shipper {driver_phone} đang tới {title} ạ' });
  assert.equal(custom, 'Shipper 0912345678 đang tới anh ạ');
  assert.doesNotMatch(renderShipmentNotice({ ...shipment, status: 'delivered', carrierStage: 'delivered' }, 'male', 'SHIPMENT_DELIVERED'), /Số điện thoại shipper/);
  // Tin đầu (mẫu mã vận đơn) mà vận đơn đã đang giao: cũng kèm số tài xế.
  assert.match(renderShipmentNotice(shipment, 'male', 'SHIPMENT_CREATED'), /Số điện thoại shipper giao hàng cho anh: 0912345678$/);
});

function harness({ store, landing = { orders: [] }, orders = [], trackSpx }) {
  const sent = [];
  let state = { noticesFrom: now - HOUR };
  return {
    sent,
    deps: {
      now,
      log: () => {},
      notify: true,
      listOrders: async () => ({ orders, complete: true }),
      readState: async () => state,
      writeState: async value => { state = value; },
      readMessagingStore: async () => store,
      updateMessagingStore: async mutate => mutate(store),
      readLandingStore: async () => landing,
      updateLandingStore: async mutate => mutate(landing),
      sendMessage: async (inbox, payload) => { sent.push({ inbox: inbox.id, ...payload }); return { message: { mid: 'm1' } }; },
      genderOf: inbox => inbox.gender,
      readTemplates: async () => ({}),
      trackSpx
    }
  };
}
const spxShipment = (extra = {}) => ({ provider: 'sapo', carrier: 'SPX Express', trackingNumber: 'SPXVN0001', status: 'delivering', stage: 'in_transit', createdAt: now - 30 * HOUR, matchedAt: now - 30 * HOUR, stageAt: now - 20 * HOUR, notifiedStage: 'in_transit', notices: [{ stage: 'in_transit', via: 'bot', at: now - 20 * HOUR }], ...extra });

test('đồng bộ: hãng báo đang giao → tin "đang giao hàng" kèm số tài xế, số được lưu vào vận đơn', async () => {
  const order = { id: 'A', phone: '0912345678', createdAt: now - 40 * HOUR, total: 298000, status: 'Mới', products: [{ sku: 'GRA-XANH' }], shipment: spxShipment() };
  const store = { conversations: [{ id: 'c1', pageId: 'p1', psid: 'c1', source: 'inbox', name: 'Chị Lan', gender: 'female', lastCustomerMessageAt: now - HOUR, customerOrders: [order] }], messages: {} };
  const run = harness({ store, trackSpx: async () => normalizeSpxPayload(spxPayload({ driver_phone_number: '84933111222' }), 'SPXVN0001') });
  const summary = await runSapoSync(run.deps);
  assert.equal(summary.sent, 1);
  assert.match(run.sent[0].text, /Số điện thoại shipper giao hàng cho chị: 0933111222/);
  assert.equal(order.shipment.driverPhone, '0933111222');
  assert.equal(order.shipment.notifiedStage, 'out_for_delivery');
});

test('đồng bộ: đơn landing giao bằng SPX cũng được tra hành trình (không nhắn ai), lâu chưa tra được tra trước', async () => {
  const landingOrder = { id: 'L1', phone: '0977000111', createdAt: now - 80 * HOUR, shipment: spxShipment({ trackingNumber: 'SPXVN0009', status: 'picked_up', stage: 'picked_up', carrierCheckedAt: 0 }) };
  const store = { conversations: [], messages: {} };
  const checked = [];
  const run = harness({ store, landing: { orders: [landingOrder] }, trackSpx: async number => { checked.push(number); return { records: [{ status: 'Delivered', description: 'Giao hàng thành công' }], driverPhone: '0911000222' }; } });
  const summary = await runSapoSync(run.deps);
  assert.deepEqual(checked, ['SPXVN0009']);
  assert.equal(summary.carrierUpdated, 1);
  assert.equal(landingOrder.shipment.carrierStage, 'delivered');
  assert.equal(landingOrder.shipment.driverPhone, '0911000222');
  assert.equal(run.sent.length, 0);
});

test('tra đơn ngoài sàn: theo SĐT (đuôi số), tên không dấu, mã vận đơn, mã đơn; bỏ form landing dở; mới nhất trước', () => {
  const conversations = [{ id: 'c1', name: 'Nguyễn Thị Hoa', source: 'inbox', customerOrders: [
    { id: 'o1', phone: '0912345678', createdAt: now - 5 * HOUR, total: 298000, products: [{ name: 'Granola Túi Xanh 450g', quantity: 2 }], shipment: spxShipment({ driverPhone: '0933111222' }) },
    { id: 'o0', phone: '0912345678', createdAt: now - 50 * HOUR, total: 189000, products: [{ name: 'Granola Túi Vàng 350g', quantity: 1 }] }
  ] }];
  const landingOrders = [
    { id: 'L1', name: 'Trần Văn Nam', phone: '0977000111', createdAt: now - HOUR, total: 189000, products: [{ name: 'Granola Túi Nâu', quantity: 1 }], shipment: { carrier: 'J&T Express', trackingNumber: '802835136377', trackingUrl: 'https://jtexpress.vn/x', status: 'delivered' } },
    { id: 'L2', name: 'Bỏ Dở', phone: '0977000111', createdAt: now, landing: { incomplete: true } }
  ];
  const ids = query => lookupShippingOrders(query, { conversations, landingOrders }).map(item => item.id);
  assert.deepEqual(ids('0912 345 678'), ['o1', 'o0'], 'SĐT có dấu cách vẫn khớp; mới nhất trước');
  assert.deepEqual(ids('912345678'), ['o1', 'o0'], 'thiếu số 0 đầu vẫn khớp');
  assert.deepEqual(ids('nguyen thi hoa'), ['o1', 'o0'], 'tên không dấu, lấy tên hội thoại khi đơn không có tên');
  assert.deepEqual(ids('spxvn0001'), ['o1']);
  assert.deepEqual(ids('0977000111'), ['L1'], 'form landing bỏ dở không phải đơn');
  assert.deepEqual(ids('ab'), [], 'quá ngắn thì không tìm');
  const [first] = lookupShippingOrders('0912345678', { conversations, landingOrders });
  assert.equal(first.shipment.isSpx, true);
  assert.equal(first.shipment.driverPhone, '0933111222');
  assert.deepEqual(first.products, ['Granola Túi Xanh 450g ×2']);
  const [jnt] = lookupShippingOrders('Trần Văn Nam', { conversations, landingOrders });
  assert.equal(jnt.shipment.isSpx, false);
  assert.equal(jnt.shipment.stageLabel, 'Giao thành công');
});
