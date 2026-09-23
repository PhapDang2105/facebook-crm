import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Mọi kho mà recordLandingOrder chạm tới đều trỏ vào thư mục tạm, không đụng data/processed.
const directory = mkdtempSync(path.join(tmpdir(), 'bughunt-'));
process.env.LANDING_ORDERS_PATH = path.join(directory, 'landing-orders.json');
process.env.ORDER_ARCHIVE_PATH = path.join(directory, 'order-archive');
process.env.PHONE_WARNINGS_PATH = path.join(directory, 'phone-warnings.json');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.ADDRESS_AI_CACHE_PATH = path.join(directory, 'address-ai-cache.json');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.POS_PUSH_ORDERS = '1';

await import('./helpers/seed-catalog.mjs');
const { normalizeLandingPayload, recordLandingOrder, listLandingOrders } = await import('../app/landing-orders.mjs');
const { resolveAddress, describeDeliveryAddress } = await import('../app/processing/locations.mjs');
const { syncPosLandingOrders } = await import('../app/pos-sync.mjs');
const { fetchPosPhoneReport, assessPhone } = await import('../app/phone-warnings.mjs');
const { syncOrderToPos } = await import('../app/pos-orders.mjs');
const { updateMessagingStore, ensureConversation, readMessagingStore } = await import('../app/messaging-store.mjs');

const posConfig = { apiKey: 'k', shopId: '1', baseUrl: 'https://pos.example/api/v1' };

const names = resolved => [resolved.province?.name || '', resolved.district?.name || '', resolved.ward?.name || ''];

test('landing: "id" bên trong dòng sản phẩm (variations[0].id) không phải mã đơn — hai khách mua cùng mẫu mã là hai đơn', async () => {
  const basket = [{ id: 'V1', variation_id: 'v1', product_display_name: 'Granola Túi Xanh 450g', quantity: 2, price: 149000 }];
  const first = { name: 'A', phone: '0901111111', address: '12 Lê Lợi, P. Bến Nghé, Q1, HCM', variations: basket, total: 298000 };
  const second = { ...first, name: 'B', phone: '0902222222' };
  assert.equal(normalizeLandingPayload(first).externalId, '', 'không có mã đơn cấp gốc thì không có mã form');
  // Mã đơn thật ở cấp gốc vẫn được nhận.
  assert.equal(normalizeLandingPayload({ ...first, order_id: 'WC-9' }).externalId, 'WC-9');
  assert.equal(normalizeLandingPayload({ products: [{ id: 'P1', name: 'Túi Xanh', created_at: '2026-09-16 01:00:00' }], phone: '0903333333', inserted_at: '2026-09-16 02:00:00' }).externalId, '0903333333@2026-09-16 02:00:00');
  const one = await recordLandingOrder(first, { checkPhone: false, autoFill: false });
  const two = await recordLandingOrder(second, { checkPhone: false, autoFill: false });
  assert.equal(one.created, true);
  assert.equal(two.created, true, 'đơn của khách B không được gộp vào đơn của khách A');
  assert.notEqual(two.order.id, one.order.id);
  const mine = (await listLandingOrders()).filter(order => ['0901111111', '0902222222'].includes(order.phone));
  assert.equal(mine.length, 2);
});

test('địa chỉ: "TP X" khi X vừa là tỉnh vừa là thành phố trực thuộc — tỉnh có thành phố cùng tên thì đó là quận', () => {
  // Phường 2 có ở cả Thành phố Trà Vinh lẫn Thị xã Duyên Hải: "TP Trà Vinh" phân định.
  const traVinh = resolveAddress('Phường 2, TP Trà Vinh');
  assert.deepEqual(names(traVinh), ['Trà Vinh', 'Thành phố Trà Vinh', 'Phường 2']);
  assert.equal(traVinh.confidence, 'exact');
  assert.equal(traVinh.ambiguous, null);
  assert.deepEqual(names(resolveAddress('Phường Đông Sơn, TP Thanh Hóa')), ['Thanh Hóa', 'Thành phố Thanh Hóa', 'Phường Đông Sơn']);
  assert.deepEqual(names(resolveAddress('Phường 3, tp Sóc Trăng')), ['Sóc Trăng', 'Thành phố Sóc Trăng', 'Phường 3']);
  assert.deepEqual(names(resolveAddress('Tp Bắc Ninh')), ['Bắc Ninh', 'Thành phố Bắc Ninh', '']);
  assert.equal(describeDeliveryAddress('số 5 Lê Lợi, Phường 2, TP Trà Vinh').complete, true);
  // Có ghi tỉnh riêng, hay không có chữ "TP", thì như trước.
  assert.deepEqual(names(resolveAddress('Phường 2, TP Trà Vinh, Trà Vinh')), ['Trà Vinh', 'Thành phố Trà Vinh', 'Phường 2']);
  assert.deepEqual(names(resolveAddress('Phường 1, tp Trà Vinh, tỉnh Trà Vinh')), ['Trà Vinh', 'Thành phố Trà Vinh', 'Phường 1']);
  assert.equal(resolveAddress('Phường 2, Trà Vinh').district, null, 'không có "TP" thì vẫn không đoán');
  assert.equal(resolveAddress('Bắc Ninh').district, null);
  // Huyện khác ghi rõ phía trước thì lấy huyện đó.
  assert.deepEqual(names(resolveAddress('Xã Lương Hòa, Châu Thành, TP Trà Vinh')), ['Trà Vinh', 'Huyện Châu Thành', 'Xã Lương Hòa']);
});

test('địa chỉ: khách gọi cả tỉnh là "Huế" và ghi rõ xã/thị trấn của huyện khác — giao về huyện đó, không phải Thành phố Huế', () => {
  assert.deepEqual(names(resolveAddress('xã phong hiền, huế')), ['Thừa Thiên Huế', 'Huyện Phong Điền', 'Xã Phong Hiền']);
  const town = resolveAddress('số 3 kiệt 5, thị trấn phong điền, huế');
  assert.deepEqual(names(town), ['Thừa Thiên Huế', 'Huyện Phong Điền', 'Thị trấn Phong Điền']);
  assert.equal(town.street, 'số 3 kiệt 5');
  assert.equal(town.confidence, 'exact');
  assert.deepEqual(names(resolveAddress('phường Phú Bài, thành phố Huế')), ['Thừa Thiên Huế', 'Thị xã Hương Thủy', 'Phường Phú Bài']);
  // Phường của chính thành phố thì vẫn là thành phố; không ghi loại hình thì không suy đoán.
  assert.deepEqual(names(resolveAddress('Phường Hương Sơ, Huế')), ['Thừa Thiên Huế', 'Thành phố Huế', 'Phường Hương Sơ']);
  assert.deepEqual(names(resolveAddress('phường thuận hòa, thành phố huế')), ['Thừa Thiên Huế', 'Thành phố Huế', 'Phường Thuận Hòa']);
  assert.deepEqual(names(resolveAddress('Sịa, Huế')), ['Thừa Thiên Huế', 'Thành phố Huế', '']);
});

test('địa chỉ: hai tên chỉ khác dấu trong cùng huyện — khách gõ có dấu thì dấu thắng loại hình ("Xã Tân Thạnh" là Thị trấn Tân Thạnh, không phải Xã Tân Thành)', () => {
  assert.deepEqual(names(resolveAddress('Xã Tân Thạnh, Tân Thạnh, Long An')), ['Long An', 'Huyện Tân Thạnh', 'Thị trấn Tân Thạnh']);
  assert.deepEqual(names(resolveAddress('Xã Tân Thành, Tân Thạnh, Long An')), ['Long An', 'Huyện Tân Thạnh', 'Xã Tân Thành']);
  assert.deepEqual(names(resolveAddress('Thị trấn Tân Thạnh, Huyện Tân Thạnh, Long An')), ['Long An', 'Huyện Tân Thạnh', 'Thị trấn Tân Thạnh']);
  // Không dấu thì không phân biệt được bằng dấu: đúng loại hình ("Xã") quyết định như trước.
  assert.deepEqual(names(resolveAddress('Xa Tan Thanh, Huyen Tan Thanh, Long An')), ['Long An', 'Huyện Tân Thạnh', 'Xã Tân Thành']);
  assert.deepEqual(names(resolveAddress('Thi tran Tan Thanh, Huyen Tan Thanh, Long An')), ['Long An', 'Huyện Tân Thạnh', 'Thị trấn Tân Thạnh']);
});

test('đồng bộ POS: đơn bỏ dở đã kéo về, POS đổi sang hoàn tất (cùng mã đơn POS) thì bản hoàn tất đè lên, không bị bỏ qua vì "đã biết mã"', async () => {
  const base = {
    id: 77001, status: 0, is_abandoned_order: true, inserted_at: '2026-09-17T01:00:00.000000', bill_full_name: 'Trần Văn Bảy', bill_phone_number: '0912345678',
    total_price: 0, order_sources_name: 'Webcake', link: 'https://granola.giotnang.vn/?utm_campaign=camp7', items: [], note: '',
    shipping_address: { full_address: 'Hà Nội', province_name: 'Hà Nội' }
  };
  const fetchWith = orders => async () => ({ ok: true, json: async () => ({ data: orders, total_pages: 1 }) });
  const first = await syncPosLandingOrders({ config: posConfig, fetchImpl: fetchWith([base]) });
  assert.equal(first.created, 1);
  const draft = (await listLandingOrders()).find(order => order.landing?.posId === '77001');
  assert.equal(draft.landing.incomplete, true);
  // Vẫn bỏ dở thì lần sau bỏ qua như cũ.
  const still = await syncPosLandingOrders({ config: posConfig, fetchImpl: fetchWith([base]) });
  assert.equal(still.skipped, 1);
  // Khách gửi xong: Webcake cập nhật chính đơn POS đó (hết is_abandoned_order, có sản phẩm, địa chỉ).
  const done = {
    ...base, status: 1, is_abandoned_order: false, total_price: 447000,
    items: [{ quantity: 1, variation_info: { name: 'Granola Mới', detail: 'Phân Loại: Combo 3 Granola Xanh', retail_price: 447000 } }],
    shipping_address: { address: '12 Lê Lợi', commune_name: 'Phường Bến Nghé', district_name: 'Quận 1', province_name: 'Hồ Chí Minh', full_address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, Hồ Chí Minh' }
  };
  const second = await syncPosLandingOrders({ config: posConfig, fetchImpl: fetchWith([done]) });
  assert.equal(second.updated, 1, 'bản hoàn tất đè lên đơn dở');
  assert.equal(second.created, 0);
  const mine = (await listLandingOrders()).filter(order => order.phone === '0912345678');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, draft.id);
  assert.equal(mine[0].landing.incomplete, false);
  assert.equal(mine[0].ward, 'Phường Bến Nghé');
  assert.equal(mine[0].products[0].sku, 'GRA-XANH-Z450');
  // Đã hoàn tất rồi thì lần sau bỏ qua.
  const third = await syncPosLandingOrders({ config: posConfig, fetchImpl: fetchWith([done]) });
  assert.equal(third.skipped, 1);
  assert.equal(third.updated, 0);
});

test('cảnh báo SĐT: đơn landing bỏ dở (is_abandoned_order) bị huỷ trên POS không phải bom hàng', async () => {
  const fetchImpl = async url => ({
    ok: true,
    json: async () => (String(url).includes('/orders')
      ? { data: [
        { id: 1, status: 6, is_abandoned_order: true, bill_phone_number: '0911222333' },
        { id: 2, status: 0, is_abandoned_order: true, bill_phone_number: '0911222333', reports_by_phone: { '0911222333': { order_fail: 0, order_success: 4, warning: 0 } } },
        { id: 3, status: 3, bill_phone_number: '0911222333' }
      ] }
      : { data: [] })
  });
  const report = await fetchPosPhoneReport('0911222333', { config: posConfig, fetchImpl });
  assert.equal(report.failed, 0, 'form bỏ dở bị huỷ không phải đơn hoàn/huỷ');
  assert.equal(report.success, 1);
  assert.equal(report.orders, 1);
  assert.deepEqual(report.report, { fail: 0, success: 4, warning: 0 }, 'báo cáo theo số vẫn đọc được dù nằm trên đơn bỏ dở');
  assert.equal(assessPhone({ pos: report }).level, 'none');
});

test('syncOrderToPos: hai lệnh đẩy cùng lúc (bot chốt + nhân viên bấm) chỉ tạo một đơn POS', async () => {
  const order = {
    id: 'race0001', name: 'Pháp Đặng', phone: '0385805700', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, Hồ Chí Minh',
    street: '12 Lê Lợi', province: 'Hồ Chí Minh', district: 'Quận 1', ward: 'Phường Bến Nghé',
    products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1, price: 174000, paidPrice: 174000, weight: 450 }],
    freeShipping: false, shippingFee: 15000, discount: 0, total: 189000, gift: '', note: '', employee: 'Chatbot AI'
  };
  let conversationId = '';
  await updateMessagingStore(store => {
    const conversation = ensureConversation(store, { pageId: '936023372925639', psid: '27087458000839712', name: 'Pháp Đặng' });
    conversation.customerOrders = [{ ...order }];
    conversationId = conversation.id;
    return null;
  });
  const calls = [];
  let created = 0;
  const fetchImpl = async (url, options = {}) => {
    const address = String(url);
    calls.push({ address, method: options.method || 'GET' });
    if (address.includes('/products/variations')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'v1', display_id: 'GRA-XANH-Z450' }] }) };
    if (address.includes('/warehouses')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'wh-1', province_id: '701', allow_create_order: true }] }) };
    if (address.includes('/geo/')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (options.method === 'POST') {
      await new Promise(resolve => setTimeout(resolve, 30));
      created += 1;
      return { ok: true, status: 200, json: async () => ({ id: 99000 + created, system_id: created, status_name: 'new' }) };
    }
    throw new Error(`gọi lạ: ${address}`);
  };
  const config = { apiKey: 'k', shopId: '714334721', baseUrl: 'https://pos.example/api/v1' };
  const [first, second] = await Promise.all([
    syncOrderToPos(conversationId, order.id, { config, fetchImpl, log: () => {} }),
    syncOrderToPos(conversationId, order.id, { config, fetchImpl, log: () => {} })
  ]);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1, 'chỉ một POST tạo đơn');
  assert.equal(first.id, '99001');
  assert.equal(second.id, '99001');
  const saved = (await readMessagingStore()).conversations.find(item => item.id === conversationId).customerOrders[0];
  assert.equal(saved.pos.id, '99001');
});
