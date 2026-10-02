// R13 (api) — C1 + T4 + T5: tổng đơn kéo từ POS theo tiền thực thu, dòng mã quà không tính tiền hàng,
// đồng bộ POS chạm trần trang thì cảnh báo. Số liệu theo đúng các ca trong báo cáo out-functions:
//   …s54941: bot báo 298.000đ (2 túi, miễn ship) → CRM ghi 338.000đ (+40.000 = bát 23k + muỗng 17k)
//   …s54903: 298.000đ → 321.000đ (+23.000, đơn bám đuổi tặng 1 bát)
//   …s55059: 318.000đ → 368.000đ (+50.000, quạt + bát live)
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('r13-api-pos-');
process.env.LANDING_ORDERS_PATH = path.join(directory, 'landing-orders.json');
process.env.LANDING_ARCHIVE_PATH = path.join(directory, 'landing-archive');
process.env.ORDER_ARCHIVE_PATH = path.join(directory, 'order-archive');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.PHONE_WARNINGS_PATH = path.join(directory, 'phone-warnings.json');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
await import('./helpers/seed-catalog.mjs');

const { normalizeCustomerOrder } = await import('../app/conversation-orders.mjs');
const {
  applyPosCollectedTotal, finalizePosImportedOrder, isPosGiftItem, isPosGiftSku, posCollectedTotal, posGiftItems, posGoodsItems,
  posGiftLines, posItemsToProducts, posLegacyLineTotal, repairPosImportedTotal
} = await import('../app/pos-content-sync.mjs');
const { posOrderTotal, posOrderToPayload, posSyncStatus, recordPosSyncStatus, syncPosLandingOrders } = await import('../app/pos-sync.mjs');

const line = (sku, name, quantity, price, bonus = false) => ({ quantity, is_bonus_product: bonus, variation_info: { display_id: sku, name, retail_price: price } });
const XANH = () => line('GRA-XANH-Z450', 'Granola Túi Xanh 450g', 2, 149000);
const BOWL = () => line('BGD', 'Bộ bát gáo dừa', 1, 23000);
const SPOON = () => line('MUONG', 'Muỗng dừa', 1, 17000);
const LIVE = () => line('QUA-TANG-LIVE', 'Quạt + Bát gáo dừa', 1, 50000);

/** Dựng đơn CRM y như importPosConversationOrders (server.mjs) làm với một đơn POS. */
function importOrder(posOrder) {
  const order = normalizeCustomerOrder({
    id: `pos${posOrder.system_id}`,
    name: 'Khách Facebook',
    phone: '0912345678',
    address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh',
    products: posGoodsItems(posOrder).map(item => ({ name: item.variation_info.name, sku: item.variation_info.display_id, quantity: item.quantity, price: item.variation_info.retail_price })),
    shippingFee: posOrder.shipping_fee,
    freeShipping: Boolean(posOrder.is_free_shipping) || !Number(posOrder.shipping_fee),
    discount: posOrder.total_discount,
    source: 'POS'
  });
  return finalizePosImportedOrder(order, posOrder);
}

test('C1: đơn POS 2 túi + bát + muỗng thêm như dòng thường, POS thu hộ 298.000đ → tổng CRM 298.000đ (không còn 338.000đ), quà hiện là quà', () => {
  const posOrder = { system_id: 54941, is_free_shipping: true, shipping_fee: 0, total_discount: 0, cod: 298000, items: [XANH(), BOWL(), SPOON()] };
  assert.equal(posLegacyLineTotal(posOrder), 338000, 'cách cũ: cộng cả giá quà');
  const order = importOrder(posOrder);
  assert.equal(order.total, 298000);
  assert.deepEqual(order.products.map(item => [item.sku, item.quantity]), [['GRA-XANH-Z450', 2]], 'dòng mã quà không nằm trong tiền hàng');
  assert.equal(order.gift, 'Bộ bát gáo dừa + Muỗng dừa');
  assert.deepEqual(order.giftItems.map(item => [item.sku, item.quantity]), [['BGD', 1], ['MUONG', 1]]);
  assert.equal(order.discount, 0);
});

test('C1: …s54903 (bám đuổi tặng 1 bát) 321.000đ → 298.000đ; …s55059 (quạt + bát live, có ship) 368.000đ → 318.000đ', () => {
  const bowlOnly = importOrder({ system_id: 54903, is_free_shipping: true, cod: 298000, items: [XANH(), BOWL()] });
  assert.equal(bowlOnly.total, 298000);
  assert.equal(bowlOnly.gift, 'Bộ bát gáo dừa');
  const live = { system_id: 55059, is_free_shipping: false, shipping_fee: 20000, total_discount: 0, cod: 318000, items: [XANH(), LIVE()] };
  assert.equal(posLegacyLineTotal(live), 368000);
  const liveOrder = importOrder(live);
  assert.equal(liveOrder.total, 318000);
  assert.equal(liveOrder.shippingFee, 20000);
  assert.deepEqual(liveOrder.giftItems.map(item => item.sku), ['QUA-TANG-LIVE']);
});

test('C1: POS KHÔNG ghi tiền thu (cod = 0, không chuyển khoản) → giữ nguyên tổng cách cũ, chỉ đổi cách hiện dòng quà', () => {
  const posOrder = { system_id: 60001, is_free_shipping: true, items: [XANH(), BOWL(), SPOON()] };
  assert.equal(posCollectedTotal(posOrder), 0);
  const order = importOrder(posOrder);
  assert.equal(order.total, 338000, 'không có tiền thu thì không đoán: tổng như trước R13');
  assert.equal(order.gift, 'Bộ bát gáo dừa + Muỗng dừa');
  // Đơn không có dòng mã quà và không có tiền thu: y hệt cách cũ.
  const plain = importOrder({ system_id: 60002, is_free_shipping: false, shipping_fee: 15000, total_discount: 0, items: [line('GRA-XANH-Z450', 'Granola Túi Xanh 450g', 1, 174000)] });
  assert.equal(plain.total, 189000);
  assert.equal(plain.gift, '');
});

test('C1 + T4: chuyển khoản tính vào tiền thực thu (đặt cọc 100k + COD 198k = 298k; chuyển khoản hết thì cod = 0)', () => {
  const deposit = importOrder({ system_id: 60003, is_free_shipping: true, cod: 198000, transfer_money: 100000, items: [XANH(), BOWL()] });
  assert.equal(deposit.total, 298000);
  assert.equal(deposit.prepaid, 100000);
  const paid = importOrder({ system_id: 60004, is_free_shipping: true, cod: 0, transfer_money: 298000, items: [XANH()] });
  assert.equal(paid.total, 298000);
  // T4: đơn landing kéo từ POS (pos-sync.posOrderTotal) trước đây chỉ lấy `cod`.
  assert.equal(posOrderTotal({ cod: 198000, transfer_money: 100000, total_price: 348000 }), 298000);
  assert.equal(posOrderTotal({ cod: 0, transfer_money: 298000, total_price: 348000, total_discount: 50000 }), 298000);
  assert.equal(posOrderTotal({ cod: 298000 }), 298000, 'chỉ COD: như cũ');
  assert.equal(posOrderTotal({ total_price: 348000, total_discount: 50000, shipping_fee: 15000 }), 313000, 'POS không ghi tiền thu: công thức cũ');
  assert.equal(posOrderTotal({ total_price: 348000, total_discount: 50000, shipping_fee: 15000, is_free_shipping: true }), 298000);
});

test('C1: nhận ra dòng quà — dòng tặng, mã BGD/MUONG/quà live, SKU bảng quà không phải sản phẩm; Túi Vàng (sản phẩm) mua thường vẫn là hàng', () => {
  assert.equal(isPosGiftSku('BGD'), true);
  assert.equal(isPosGiftSku('muong'), true);
  assert.equal(isPosGiftSku('QUA-TANG-LIVE'), true);
  assert.equal(isPosGiftSku('GRA-VANG-H350'), false, 'Túi Vàng là sản phẩm bán, dù cũng có trong bảng quà (tặng đơn 5 túi)');
  assert.equal(isPosGiftSku('CB3-XANH-Z450+BGD+M'), false, 'mã combo POS không phải mã quà');
  assert.equal(isPosGiftSku(''), false);
  assert.equal(isPosGiftItem(line('GRA-VANG-H350', 'Túi Vàng', 1, 0, true)), true, 'dòng tặng (is_bonus_product)');
  const posOrder = { items: [XANH(), BOWL(), line('GRA-VANG-H350', 'Túi Vàng', 1, 0, true)] };
  assert.deepEqual(posGoodsItems(posOrder).map(item => item.variation_info.display_id), ['GRA-XANH-Z450']);
  assert.deepEqual(posGiftItems(posOrder).map(item => item.variation_info.display_id), ['BGD', 'GRA-VANG-H350']);
  assert.deepEqual(posItemsToProducts(posOrder).map(item => item.sku), ['GRA-XANH-Z450']);
  assert.deepEqual(posGiftLines(posOrder).giftItems.map(item => item.sku), ['BGD', 'GRA-VANG-H350']);
  // Đơn chỉ toàn mã quà (gửi bù quà): giữ cách cũ, không thành đơn rỗng.
  assert.deepEqual(posGoodsItems({ items: [BOWL()] }).map(item => item.variation_info.display_id), ['BGD']);
  // Payload đơn landing dựng từ POS cũng bỏ dòng mã quà.
  const payload = posOrderToPayload({ items: [XANH(), BOWL()], shipping_address: {}, cod: 298000 });
  assert.match(payload.products, /Granola Túi Xanh 450g/);
  assert.doesNotMatch(payload.products, /bát gáo dừa/i);
  assert.equal(payload.total, 298000);
});

test('C1: đơn POS đã kéo về trước bản sửa (tổng 338.000đ theo cách cũ) được chỉnh về 298.000đ một lần, có lịch sử; đơn nhân viên đã sửa giỏ thì không đụng', () => {
  const posOrder = { system_id: 54941, is_free_shipping: true, cod: 298000, items: [XANH(), BOWL(), SPOON()] };
  const fresh = importOrder(posOrder);
  const stored = { id: 'pos54941', source: 'POS', total: 338000, discount: 0, gift: '', products: [{ sku: 'GRA-XANH-Z450', quantity: 2, price: 149000 }, { sku: 'BGD', quantity: 1, price: 23000 }, { sku: 'MUONG', quantity: 1, price: 17000 }] };
  assert.equal(repairPosImportedTotal(stored, fresh, posOrder, { now: 1000 }), true);
  assert.equal(stored.total, 298000);
  assert.deepEqual(stored.products.map(item => item.sku), ['GRA-XANH-Z450']);
  assert.equal(stored.gift, 'Bộ bát gáo dừa + Muỗng dừa');
  assert.match(stored.history.at(-1).summary, /338\.000đ → 298\.000đ/);
  assert.equal(repairPosImportedTotal(stored, fresh, posOrder), false, 'đã đúng thì không sửa lần hai');
  // Tổng đang lưu KHÔNG phải tổng cách cũ (nhân viên / đồng bộ khác đã sửa): không đụng.
  assert.equal(repairPosImportedTotal({ id: 'pos54941', source: 'POS', total: 300000, products: [] }, fresh, posOrder), false);
  // Nhân viên đã sửa giỏ trong CRM: không đụng.
  assert.equal(repairPosImportedTotal({ id: 'pos54941', source: 'POS', total: 338000, products: [], staffEdited: { basket: 5 }, editedByStaffAt: 5 }, fresh, posOrder), false);
  // Đơn không phải nguồn POS, hay POS không có tiền thu: không đụng.
  assert.equal(repairPosImportedTotal({ id: 'x', source: 'Facebook', total: 338000 }, fresh, posOrder), false);
  assert.equal(repairPosImportedTotal({ id: 'pos54941', source: 'POS', total: 338000 }, fresh, { ...posOrder, cod: 0 }), false);
  assert.equal(applyPosCollectedTotal({ total: 338000, products: [] }, { cod: 0 }), false);
});

test('C1: importPosConversationOrders (server.mjs) dùng posGoodsItems + finalizePosImportedOrder + repairPosImportedTotal', async () => {
  const server = (await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const block = server.slice(server.indexOf('async function importPosConversationOrders('), server.indexOf('/**\n * Gắn bù thẻ "Đã mua hàng"'));
  assert.match(block, /const lines = posGoodsItems\(posOrder\);/);
  assert.match(block, /finalizePosImportedOrder\(order, posOrder\);/);
  assert.match(block, /if \(repairPosImportedTotal\(existing, order, posOrder\)\) touched\.add\(conversation\.id\);/);
  assert.doesNotMatch(block, /filter\(item => !item\.is_bonus_product\)/, 'không còn tự lọc dòng tặng (bỏ sót dòng mã quà)');
});

test('T5: đồng bộ POS chạm trần trang → summary.truncated + cảnh báo, ghi vào trạng thái đồng bộ; không chạm trần thì không cảnh báo', async () => {
  const config = { baseUrl: 'http://pos.stub', apiKey: 'k', shopId: '1' };
  const page = () => Array.from({ length: 100 }, (_, index) => ({ id: `o${Math.random().toString(36).slice(2)}${index}`, status: 0, custom_id: `CRM-x${index}`, inserted_at: '2026-10-01T03:00:00.000000' }));
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ success: true, data: page(), total_pages: 7 }) };
  };
  const summary = await syncPosLandingOrders({ config, fetchImpl, maxPages: 2, sinceHours: 48 });
  assert.equal(summary.truncated, true);
  assert.equal(summary.warnings.length, 2, 'cả lượt theo ngày tạo và lượt theo ngày cập nhật');
  assert.match(summary.warnings[0], /chạm trần 2 trang \(200 đơn, POS báo 7 trang\).*ngày tạo.*48 giờ/);
  assert.equal(calls.length, 4);
  const status = recordPosSyncStatus(summary, { at: 123 });
  assert.equal(status.truncated, true);
  assert.equal(posSyncStatus().at, 123);
  assert.equal(posSyncStatus().warnings.length, 2);
  // Đủ trang: không cảnh báo.
  const small = await syncPosLandingOrders({ config, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [], total_pages: 1 }) }), maxPages: 2 });
  assert.equal(small.truncated, false);
  assert.deepEqual(small.warnings, []);
  assert.equal(recordPosSyncStatus(small).truncated, false);
  const server = (await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(server, /sendJson\(response, 200, \{ \.\.\.posStatus\(\), sync: posSyncStatus\(\) \}\)/);
});
