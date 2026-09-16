import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'possync-'));
process.env.LANDING_ORDERS_PATH = path.join(directory, 'landing-orders.json');
process.env.PHONE_WARNINGS_PATH = path.join(directory, 'phone-warnings.json');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');

await import('./helpers/seed-catalog.mjs');
const { posOrderToPayload, posTimeToWebcake, isLandingPosOrder, syncPosLandingOrders } = await import('../app/pos-sync.mjs');
const { recordLandingOrder, listLandingOrders } = await import('../app/landing-orders.mjs');

const posOrder = (overrides = {}) => ({
  id: 51946, status: 1, status_name: 'submitted', is_abandoned_order: false, inserted_at: '2026-09-16T00:52:24.000000',
  bill_full_name: 'Nguyễn Thị Thu Hà', bill_phone_number: '0904636274', total_price: 447000,
  order_sources_name: 'Webcake', link: 'https://granola.giotnang.vn/?fbclid=abc&utm_campaign=camp1',
  p_utm_source: 'fb', p_utm_campaign: 'camp1', p_utm_medium: null,
  shipping_address: { address: 'Hateco Plaza - Lô 4A Huỳnh Thúc Kháng', commune_name: 'Phường Láng Hạ', district_name: 'Quận Đống Đa', province_name: 'Hà Nội', full_address: 'Hateco Plaza - Lô 4A Huỳnh Thúc Kháng, Phường Láng Hạ, Quận Đống Đa, Hà Nội', phone_number: '0904636274' },
  items: [{ quantity: 1, variation_info: { name: 'Granola Mới Ngũ Cốc Ăn Sáng Healthy Lành Mạnh Với Hạt Dinh Dưỡng Trái Cây Từ Giọt Nắng', detail: 'Phân Loại: Combo 3 Granola Xanh', retail_price: 447000 } }],
  note: 'link: https://granola.giotnang.vn/?x\nIP: 1.2.3.4\nOrder ID: 48136',
  ...overrides
});

test('giờ POS (UTC) đổi sang giờ Việt Nam đúng định dạng Webcake, để trùng khóa với webhook', () => {
  assert.equal(posTimeToWebcake('2026-09-16T00:52:24.000000'), '2026-09-16 07:52:24');
  assert.equal(posTimeToWebcake('2026-09-15T19:08:42.000000'), '2026-09-16 02:08:42');
  assert.equal(posTimeToWebcake(''), '');
});

test('đơn POS → payload giống Webcake: chuỗi sản phẩm có phân loại, địa chỉ đầy đủ, trạng thái theo is_abandoned_order', () => {
  const payload = posOrderToPayload(posOrder());
  assert.equal(payload.name, 'Nguyễn Thị Thu Hà');
  assert.equal(payload.phone, '0904636274');
  assert.equal(payload.address, 'Hateco Plaza - Lô 4A Huỳnh Thúc Kháng, Phường Láng Hạ, Quận Đống Đa, Hà Nội');
  assert.match(payload.products, /^Granola Mới .* \(Combo 3 Granola Xanh\): 1 x 447\.000 ₫$/);
  assert.equal(payload.status, 'Form hoàn tất');
  assert.equal(payload.inserted_at, '2026-09-16 07:52:24');
  assert.equal(payload.utm_campaign, 'camp1');
  assert.equal(payload.note, '');
  const abandoned = posOrderToPayload(posOrder({ id: 51938, is_abandoned_order: true, items: [], total_price: 0, shipping_address: { full_address: 'Bắc Kạn', province_name: 'Bắc Kạn' } }));
  assert.equal(abandoned.status, 'Form chưa hoàn tất');
  assert.equal(abandoned.products, '');
  assert.equal(abandoned.address, 'Bắc Kạn');
  // Đơn bỏ dở: Webcake chèn "GXN " trước địa chỉ gửi POS, note giữ nguyên văn khách gõ.
  const prefixed = posOrderToPayload(posOrder({ is_abandoned_order: true, note: ['address: 73/37 bằng liệt bằng A,', 'link: https://granola.giotnang.vn/?x', 'IP: 1.2.3.4', 'Order ID: 48011'].join('\r\n'), shipping_address: { address: 'GXN 73/37 bằng liệt bằng A', commune_name: 'Phường Hoàng Liệt', district_name: 'Quận Hoàng Mai', province_name: 'Hà Nội', full_address: 'GXN 73/37 bằng liệt bằng A, Phường Hoàng Liệt, Quận Hoàng Mai, Hà Nội' } }));
  assert.equal(prefixed.address, '73/37 bằng liệt bằng A, Phường Hoàng Liệt, Quận Hoàng Mai, Hà Nội');
  assert.equal(prefixed.note, '');
  assert.equal(isLandingPosOrder(posOrder()), true);
  assert.equal(isLandingPosOrder({ order_sources_name: 'Facebook', link: '' }), false);
});

test('đồng bộ: đơn webhook đã có thì gộp và ghi mã POS; đơn POS mới (kể cả bỏ dở) thì tạo, lần sau bỏ qua', async () => {
  // Webhook đã tạo đơn này trước (cùng SĐT + inserted_at giờ Việt Nam).
  const viaWebhook = await recordLandingOrder({ name: 'Nguyễn Thị Thu Hà', phone: '0904636274', address: 'Hateco Plaza - Lô 4A Huỳnh Thúc Kháng', ward: 'Phường Láng Hạ', district: 'Quận Đống Đa', province: 'Hà Nội', products: 'Granola Mới (Combo 3 Granola Xanh): 1 x 447.000 ₫', total: '447.000', status: 'Form hoàn tất', inserted_at: '2026-09-16 07:52:24' }, { checkPhone: false });
  assert.equal(viaWebhook.created, true);
  // Thu Hà bỏ dở lúc 07:20 rồi gửi xong lúc 07:52: bản dở phải gộp vào đơn hoàn tất, không thành đơn riêng.
  const pages = [posOrder(), posOrder({ id: 51940, is_abandoned_order: true, status: 0, inserted_at: '2026-09-16T00:20:00.000000', items: [], total_price: 0, shipping_address: { full_address: 'Hà Nội', province_name: 'Hà Nội' } }), posOrder({ id: 51938, bill_full_name: 'Nguyễn tú anh', bill_phone_number: '0368419478', is_abandoned_order: true, status: 0, inserted_at: '2026-09-15T19:08:42.000000', items: [], total_price: 0, shipping_address: { full_address: 'Bắc Kạn', province_name: 'Bắc Kạn' }, link: 'https://granola.giotnang.vn/?utm_campaign=camp1' }), { id: 1, order_sources_name: 'Facebook', link: '' }];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: pages, total_pages: 1 }) });
  const config = { apiKey: 'k', shopId: '1', baseUrl: 'https://pos.example/api/v1' };
  const first = await syncPosLandingOrders({ config, fetchImpl });
  assert.equal(first.checked, 4);
  assert.equal(first.landing, 3);
  assert.equal(first.created, 1, 'chỉ đơn bỏ dở của Nguyễn tú anh được tạo');
  assert.equal(first.skipped, 1, 'đơn Thu Hà đã có từ webhook');
  assert.equal(first.absorbed, 1, 'bản dở của Thu Hà gộp vào đơn hoàn tất');
  const orders = await listLandingOrders();
  assert.equal(orders.filter(order => order.phone === '0904636274').length, 1, 'Thu Hà chỉ có một đơn');
  const thuHa = orders.find(order => order.phone === '0904636274');
  assert.equal(thuHa.id, viaWebhook.order.id);
  assert.equal(thuHa.status, 'Mới');
  assert.equal(thuHa.landing.posId, '51946', 'ghi mã POS vào đơn webhook');
  assert.deepEqual([...thuHa.landing.posIds].sort(), ['51940', '51946'], 'nhớ cả mã bản dở để lần sau bỏ qua');
  const tuAnh = orders.find(order => order.phone === '0368419478');
  assert.equal(tuAnh.status, 'Chưa hoàn tất');
  assert.equal(tuAnh.landing.posId, '51938');
  assert.deepEqual(tuAnh.products.map(item => [item.sku, item.quantity]), [['GRA-XANH-Z450', 3]], 'tự điền theo chiến dịch camp1 (đơn Thu Hà)');
  assert.match(tuAnh.landing.autoFilled.product, /Granola Túi Xanh 450g x3/);
  const second = await syncPosLandingOrders({ config, fetchImpl });
  assert.equal(second.created, 0);
  assert.equal(second.absorbed, 0);
  assert.equal(second.skipped, 3);
  assert.equal((await syncPosLandingOrders({ config: { apiKey: '', shopId: '' } })).disabled, true);
});
