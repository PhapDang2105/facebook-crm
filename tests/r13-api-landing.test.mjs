// R13 (api) — đơn landing: M5 (có thể trùng → ghi chú, không gộp), M6 (tổng form khác bảng giá), T2 (ngày tạo thật của POS).
// Ca trong báo cáo out-functions: form "Combo 3 Xanh 399.000" → tổng 399.000 nhưng paidPrice 149.000 × 3 = 447.000 và
// không có ghi chú; 19 cặp đơn landing cùng địa chỉ ≤ 10 phút trong 21 ngày (8 cặp cùng lên POS); đơn landing kéo từ
// POS sau khi khởi động lại bị dồn vào ngày đồng bộ.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('r13-api-landing-');
process.env.LANDING_ORDERS_PATH = path.join(directory, 'landing-orders.json');
process.env.LANDING_ARCHIVE_PATH = path.join(directory, 'landing-archive');
process.env.ORDER_ARCHIVE_PATH = path.join(directory, 'order-archive');
process.env.PHONE_WARNINGS_PATH = path.join(directory, 'phone-warnings.json');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
await import('./helpers/seed-catalog.mjs');

const { buildLandingOrder, flagPossibleDuplicate, landingSubmittedAt, readLandingStore, recordLandingOrder } = await import('../app/landing-orders.mjs');
const { orderProcessingNotes } = await import('../app/order-edits.mjs');

const ADDRESS = '25 Nguyễn Trãi, Phường Bến Thành, Quận 1, TP Hồ Chí Minh';
const form = (overrides = {}) => ({
  name: 'Khách landing', phone: '0912345678', address: ADDRESS,
  products: 'Granola Túi Xanh 450g: 3 x 149.000 ₫', total: 447000, status: 'Form hoàn tất', ...overrides
});
const quiet = { autoFill: false, checkPhone: false };

test('M6: tổng form 399.000đ khác bảng giá 447.000đ → ghi chú "ℹ Giá landing … khác bảng giá …" và paidPrice chia khớp tổng', () => {
  const order = buildLandingOrder(form({ products: 'Granola Túi Xanh 450g: 3 x 133.000 ₫', total: 399000 }), { now: 1_000, id: 'lp399' });
  assert.equal(order.total, 399000);
  assert.deepEqual(order.processingFlags, ['ℹ Giá landing 399.000đ khác bảng giá 447.000đ']);
  const paid = order.products.reduce((sum, item) => sum + item.paidPrice * item.quantity, 0);
  assert.equal(paid, 399000, 'Σ giá khách trả × số lượng = tổng đơn (trước đây 149.000 × 3 = 447.000)');
  assert.equal(order.products[0].paidPrice, 133000);
  assert.equal(orderProcessingNotes(order)[0], 'ℹ Giá landing 399.000đ khác bảng giá 447.000đ');
});

test('M6: tổng form đúng bảng giá, hoặc form không gửi tổng → không ghi chú, giá từng dòng như cũ', () => {
  const same = buildLandingOrder(form(), { now: 1_000, id: 'lp447' });
  assert.equal(same.total, 447000);
  assert.equal(same.processingFlags, undefined);
  assert.equal(same.products[0].paidPrice, 149000);
  const { total, ...withoutTotal } = form();
  const noTotal = buildLandingOrder(withoutTotal, { now: 1_000, id: 'lpnone' });
  assert.equal(noTotal.total, 447000);
  assert.equal(noTotal.processingFlags, undefined);
  // Sản phẩm ngoài danh mục: không có giá danh mục để so → không ghi chú.
  const unknown = buildLandingOrder(form({ products: 'Combo quà Tết: 1 x 500.000 ₫', total: 500000 }), { now: 1_000, id: 'lpx' });
  assert.equal(unknown.processingFlags, undefined);
});

test('M5: hai form HOÀN TẤT cùng SĐT cách nhau ≤ 10 phút → không gộp, đơn SAU mang "⚠ Có thể trùng đơn LP-<mã đơn trước>"', async () => {
  const first = await recordLandingOrder(form({ inserted_at: '2026-10-01 10:10:00' }), quiet);
  const second = await recordLandingOrder(form({ inserted_at: '2026-10-01 10:10:40' }), quiet);
  assert.equal(first.created, true);
  assert.equal(second.created, true, 'mỗi form là một đơn riêng — không gộp');
  const store = await readLandingStore();
  const [earlier, later] = [store.orders.find(order => order.id === first.order.id), store.orders.find(order => order.id === second.order.id)];
  assert.equal(earlier.processingFlags, undefined);
  assert.deepEqual(later.processingFlags, [`⚠ Có thể trùng đơn LP-${earlier.id}`]);
});

test('M5: cùng ĐỊA CHỈ khác SĐT cũng cảnh báo; form dở, đơn đã hủy, cách > 10 phút, địa chỉ quá ngắn thì không', () => {
  const base = { id: 'a1', phone: '0911111111', address: ADDRESS, createdAt: 1_000_000, landing: {} };
  const sameAddress = { id: 'a2', phone: '0922222222', address: '25 nguyen trai, phuong ben thanh, quan 1, tp ho chi minh', createdAt: 1_000_000 + 5 * 60_000, landing: {} };
  assert.equal(flagPossibleDuplicate([base, sameAddress], sameAddress), sameAddress);
  assert.deepEqual(sameAddress.processingFlags, ['⚠ Có thể trùng đơn LP-a1']);
  const incomplete = { id: 'a3', phone: '0911111111', address: ADDRESS, createdAt: 1_000_000 + 60_000, landing: { incomplete: true } };
  assert.equal(flagPossibleDuplicate([base, incomplete], incomplete), null);
  const fresh = { id: 'a4', phone: '0911111111', address: ADDRESS, createdAt: 1_000_000 + 60_000, landing: {} };
  assert.equal(flagPossibleDuplicate([incomplete, fresh], fresh), null, 'bản kia là form dở: không tính');
  assert.equal(flagPossibleDuplicate([{ ...base, processingStatus: 'cancelled' }, fresh], fresh), null, 'bản kia đã hủy');
  const late = { id: 'a5', phone: '0911111111', address: ADDRESS, createdAt: 1_000_000 + 11 * 60_000, landing: {} };
  assert.equal(flagPossibleDuplicate([base, late], late), null);
  const vague = { id: 'a6', phone: '0933333333', address: 'Hà Nội', createdAt: 1_000_000, landing: {} };
  const vague2 = { id: 'a7', phone: '0944444444', address: 'Hà Nội', createdAt: 1_000_000 + 1000, landing: {} };
  assert.equal(flagPossibleDuplicate([vague, vague2], vague2), null, 'địa chỉ quá ngắn (chỉ tỉnh) không dùng để dò trùng');
  // Đơn kéo từ POS mang ngày tạo thật CŨ hơn đơn đang giữ: đơn sau (đang giữ) nhận ghi chú.
  const held = { id: 'h1', phone: '0955555555', address: ADDRESS, createdAt: 2_000_000, landing: {} };
  const pulled = { id: 'p1', phone: '0955555555', address: ADDRESS, createdAt: 2_000_000 - 30_000, landing: {} };
  assert.equal(flagPossibleDuplicate([held, pulled], pulled), held);
  assert.deepEqual(held.processingFlags, ['⚠ Có thể trùng đơn LP-p1']);
  assert.equal(pulled.processingFlags, undefined);
});

test('T2: đơn landing kéo từ POS lấy ngày tạo thật (inserted_at giờ VN), webhook vẫn lấy lúc nhận', async () => {
  const now = Date.now();
  assert.equal(landingSubmittedAt('2026-09-28 07:52:24', Date.parse('2026-10-02T03:00:00Z')), Date.parse('2026-09-28T00:52:24Z'));
  assert.equal(landingSubmittedAt('', 123), 123);
  assert.equal(landingSubmittedAt('không phải ngày', 123), 123);
  assert.equal(landingSubmittedAt('2031-01-01 00:00:00', now), now, 'ngày ở tương lai → lúc nhận');
  assert.equal(landingSubmittedAt('2020-01-01 00:00:00', now), now, 'quá cũ (> 120 ngày) → lúc nhận');
  // Hai ngày trước, theo giờ Việt Nam.
  const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000 + 7 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const pulled = await recordLandingOrder(form({ phone: '0966666666', address: '9 Trần Phú, Phường 4, Quận 5, TP Hồ Chí Minh', inserted_at: twoDaysAgo }), { ...quiet, posId: 'pos-777' });
  assert.equal(pulled.created, true);
  assert.ok(Math.abs(pulled.order.createdAt - (now - 2 * 24 * 60 * 60 * 1000)) < 2000, `createdAt = ngày tạo trên POS, không phải lúc đồng bộ (${new Date(pulled.order.createdAt).toISOString()})`);
  const hook = await recordLandingOrder(form({ phone: '0977777777', address: '3 Hai Bà Trưng, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', inserted_at: twoDaysAgo }), quiet);
  assert.ok(Math.abs(hook.order.createdAt - now) < 5000, 'webhook (không có posId): lúc nhận như cũ');
});
