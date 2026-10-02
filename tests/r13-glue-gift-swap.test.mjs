// Vòng 13 (02/10) — bước GỘP cuối, mục 8: đơn khách ĐỔI QUÀ (bát/muỗng/quạt → 2 gói granola nhỏ).
// - File kho (order-export.mjs): dòng quà theo quà đã đổi (bỏ giftSwapRemoved, thêm gói nhỏ); đơn thường như cũ.
// - Khách sửa đơn < 60 phút (updateChatbotCustomerOrder → PUT POS): quà thay thế thiếu mã POS → ghi chú xử lý như đường
//   tạo đơn. POS dùng stub (fetchImpl), không gọi mạng.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('r13-glue-giftswap-');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.POS_COMBOS_PATH = path.join(directory, 'pos-combos.json');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.POS_PUSH_ORDERS = '1';
await import('./helpers/seed-catalog.mjs');

const { giftSwapPlan, reloadCatalog } = await import('../app/processing/catalog.mjs');
const { buildExportRows, exportFactsForOrders } = await import('../app/order-export.mjs');
const { applyGiftSwapFlag, posGiftSwapFlag, posGiftSwapPlan, updatePosOrder } = await import('../app/pos-orders.mjs');
const { processingNotes } = await import('../app/order-notes.mjs');

const XANH = 'GRA-XANH-Z450';
const ADDRESS = '12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
const SMALL_XANH = { name: 'Gói granola nhỏ Xanh 35g', sku: 'GRA-XANH-G35', weight: 35 };
const SMALL_CAM = { name: 'Gói granola nhỏ Cam 30g', sku: 'GRA-CAM-G30', weight: 30 };
const LIVE_GIFT = { id: 'qua-tang-live', name: 'Quạt + Bát gáo dừa', active: true, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 50 };
const headers = ['Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Địa chỉ', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá', 'Ghi chú'];
const row = (id, sku, quantity, price, { note = '' } = {}) => [id, 'A', '0385805790', ADDRESS, sku, sku, String(quantity), String(price), note];
const lines = rows => rows.map(item => `${item[19]}x${item[21]}@${item[22]}`);
const exported = (rowsIn, orders) => lines(buildExportRows({ headers, rows: rowsIn }, { orderFacts: exportFactsForOrders(orders) }));

/** Chạy `run` với bảng quà đã sửa bởi `edit`, rồi trả bảng quà gốc. */
async function withGifts(edit, run) {
  const original = readFileSync(process.env.GIFTS_PATH, 'utf8');
  const gifts = JSON.parse(original);
  edit(gifts);
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  reloadCatalog();
  try { return await run(); } finally { writeFileSync(process.env.GIFTS_PATH, original); reloadCatalog(); }
}

test('giftSwapPlan (catalog) là một nguồn: POS (posGiftSwapPlan) và file kho dùng chung; đơn không đổi quà → null', () => {
  assert.equal(giftSwapPlan({ id: 'x' }), null);
  assert.equal(posGiftSwapPlan({ giftSwap: [] }), null);
  const order = { giftSwap: [SMALL_XANH, SMALL_CAM, SMALL_CAM, { name: 'Gói granola nhỏ (vị khách chọn)', sku: '', weight: 35 }], giftSwapRemoved: ['Bộ bát gáo dừa', 'Muỗng dừa'] };
  const plan = posGiftSwapPlan(order, new Set(['GRA-XANH-G35', 'GRA-CAM-G30']));
  assert.deepEqual(plan.lines, [{ sku: 'GRA-XANH-G35', name: SMALL_XANH.name, weight: 35, quantity: 1 }, { sku: 'GRA-CAM-G30', name: SMALL_CAM.name, weight: 30, quantity: 2 }]);
  assert.deepEqual(plan.missing, ['Gói granola nhỏ (vị khách chọn)']);
  assert.equal(plan.removes({ name: 'Bộ bát gáo dừa', sku: 'BGD' }), true);
  assert.equal(plan.removes({ name: 'Túi tặng', sku: 'GRA-VANG-H350' }), false);
  assert.deepEqual(giftSwapPlan(order).lines, plan.lines);
});

test('xuất kho: đơn 3 túi đã đổi quà → KHÔNG có bát + muỗng, có 2 dòng gói nhỏ giá 0; đơn 3 túi thường vẫn bát + muỗng như cũ', () => {
  const plain = { id: 'g1', source: 'Facebook', products: [{ sku: XANH, quantity: 3 }] };
  assert.deepEqual(exported([row('CB-g1', XANH, 3, 149000)], [plain]), ['GRA-XANH-Z450x3@149000', 'BGDx1@0', 'MUONGx1@0']);
  const swapped = { ...plain, id: 'g2', giftSwap: [SMALL_XANH, SMALL_CAM], giftSwapRemoved: ['Bộ bát gáo dừa', 'Muỗng dừa'] };
  assert.deepEqual(exported([row('CB-g2', XANH, 3, 149000)], [swapped]), ['GRA-XANH-Z450x3@149000', 'GRA-XANH-G35x1@0', 'GRA-CAM-G30x1@0']);
  // Hai gói cùng vị gộp một dòng số lượng 2, đúng khối lượng gói nhỏ.
  const same = buildExportRows({ headers, rows: [row('CB-g3', XANH, 3, 149000)] }, { orderFacts: exportFactsForOrders([{ ...swapped, id: 'g3', giftSwap: [SMALL_CAM, SMALL_CAM] }]) });
  assert.deepEqual(lines(same), ['GRA-XANH-Z450x3@149000', 'GRA-CAM-G30x2@0']);
  assert.equal(same[1][24], 30);
  // Trong cùng một file: đơn đổi quà và đơn thường không lẫn nhau.
  assert.deepEqual(exported([row('CB-g1', XANH, 3, 149000), row('CB-g2', XANH, 3, 149000)], [plain, swapped]),
    ['GRA-XANH-Z450x3@149000', 'BGDx1@0', 'MUONGx1@0', 'GRA-XANH-Z450x3@149000', 'GRA-XANH-G35x1@0', 'GRA-CAM-G30x1@0']);
  // Không có orderFacts (file ngoài hệ thống): như cũ.
  assert.deepEqual(lines(buildExportRows({ headers, rows: [row('CB-g2', XANH, 3, 149000)] })), ['GRA-XANH-Z450x3@149000', 'BGDx1@0', 'MUONGx1@0']);
});

test('xuất kho: gói thay thế chưa chọn vị (không SKU) không lên dòng, quà đã đổi vẫn bị bỏ; chỉ đổi một phần quà thì quà còn lại giữ', () => {
  const unknown = { id: 'g4', source: 'Facebook', giftSwap: [{ name: 'Gói granola nhỏ (vị khách chọn)', sku: '', weight: 35 }, { name: 'Gói granola nhỏ (vị khách chọn)', sku: '', weight: 35 }], giftSwapRemoved: ['Bộ bát gáo dừa', 'Muỗng dừa'] };
  assert.deepEqual(exported([row('CB-g4', XANH, 3, 149000)], [unknown]), ['GRA-XANH-Z450x3@149000']);
  const bowlOnly = { id: 'g5', source: 'Facebook', giftSwap: [SMALL_XANH, SMALL_XANH], giftSwapRemoved: ['Bộ bát gáo dừa'] };
  assert.deepEqual(exported([row('CB-g5', XANH, 3, 149000)], [bowlOnly]), ['GRA-XANH-Z450x3@149000', 'MUONGx1@0', 'GRA-XANH-G35x2@0']);
});

test('xuất kho: khách live 2 túi đổi quạt + bát → gói nhỏ, không quà live, không thêm bát ưu đãi bám đuổi; đơn 2 túi bám đuổi đổi bát → không lên BGD', async () => {
  await withGifts(gifts => gifts.items.push(LIVE_GIFT), () => {
    const live = { id: 'g6', source: 'Facebook', livestream: true, promoGift: 'Bộ bát gáo dừa', giftSwap: [SMALL_XANH, SMALL_CAM], giftSwapRemoved: ['Quạt + Bát gáo dừa'] };
    assert.deepEqual(exported([row('CB-g6', XANH, 2, 149000)], [live]), ['GRA-XANH-Z450x2@149000', 'GRA-XANH-G35x1@0', 'GRA-CAM-G30x1@0']);
    // Đơn live không đổi quà: như cũ.
    assert.deepEqual(exported([row('CB-g7', XANH, 2, 149000)], [{ id: 'g7', source: 'Facebook', livestream: true }]), ['GRA-XANH-Z450x2@149000', 'QUA-TANG-LIVEx1@0']);
  });
  const promo = { id: 'g8', source: 'Facebook', promoGift: 'Bộ bát gáo dừa', giftSwap: [SMALL_XANH, SMALL_XANH], giftSwapRemoved: ['Bộ bát gáo dừa'] };
  assert.deepEqual(exported([row('CB-g8', XANH, 2, 149000)], [promo]), ['GRA-XANH-Z450x2@149000', 'GRA-XANH-G35x2@0']);
  assert.deepEqual(exported([row('CB-g9', XANH, 2, 149000)], [{ id: 'g9', source: 'Facebook', promoGift: 'Bộ bát gáo dừa' }]), ['GRA-XANH-Z450x2@149000', 'BGDx1@0'], 'đơn bám đuổi không đổi quà: bát như cũ');
});

// Stub POS cho PUT sửa đơn: có GRA-XANH-G35, KHÔNG có GRA-CAM-G30.
function posStub(calls) {
  const variations = ['GRA-XANH-Z450', 'CB3-XANH-Z450+BGD+M', 'BGD', 'MUONG', 'GRA-XANH-G35'];
  return async (url, options = {}) => {
    const address = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ address, method: options.method || 'GET', body });
    if (address.includes('/products/variations')) return { ok: true, status: 200, json: async () => ({ data: variations.map(sku => ({ id: `v-${sku}`, product_id: `p-${sku}`, display_id: sku })) }) };
    if (address.includes('/warehouses')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'wh-1', name: 'Kho', province_id: '701', allow_create_order: true }] }) };
    if (address.includes('/geo/')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (/\/orders\/77001\?api_key=k$/.test(address) && options.method === 'PUT') return { ok: true, status: 200, json: async () => ({ success: true }) };
    throw new Error(`gọi lạ: ${options.method || 'GET'} ${address}`);
  };
}
const config = { apiKey: 'k', shopId: '714334721', baseUrl: 'https://pos.example/api/v1' };
const threeBags = (overrides = {}) => ({
  id: 'gu3001', name: 'Khách đổi quà', phone: '0385805700', address: ADDRESS, pos: { id: '77001' },
  products: [{ name: 'Granola Túi Xanh 450g', sku: XANH, quantity: 3, price: 174000, paidPrice: 149000, weight: 450 }],
  freeShipping: true, shippingFee: 0, discount: 75000, total: 447000, employee: 'Chatbot AI', ...overrides
});

test('khách sửa đơn (PUT POS): quà thay thế thiếu mã POS → updatePosOrder trả giftSwapMissing; đơn không đổi quà trả { id } như cũ', async () => {
  const calls = [];
  const swapped = threeBags({ giftSwap: [SMALL_XANH, SMALL_CAM], giftSwapRemoved: ['Bộ bát gáo dừa', 'Muỗng dừa'] });
  const outcome = await updatePosOrder(swapped, { config, fetchImpl: posStub(calls) });
  assert.deepEqual(outcome, { id: '77001', giftSwapMissing: ['Gói granola nhỏ Cam 30g (GRA-CAM-G30)'] });
  const put = calls.find(call => call.method === 'PUT');
  assert.deepEqual(put.body.items.map(item => [item.variation_id, item.quantity, item.is_bonus_product]), [['v-GRA-XANH-Z450', 3, false], ['v-GRA-XANH-G35', 1, true]]);
  assert.deepEqual(await updatePosOrder(threeBags(), { config, fetchImpl: posStub([]) }), { id: '77001' });
  // Đủ mã POS: không thiếu gì.
  assert.deepEqual(await updatePosOrder(threeBags({ giftSwap: [SMALL_XANH, SMALL_XANH], giftSwapRemoved: ['Bộ bát gáo dừa', 'Muỗng dừa'] }), { config, fetchImpl: posStub([]) }), { id: '77001' });
});

test('applyGiftSwapFlag: gắn ghi chú xử lý như đường tạo đơn, không lặp; lần sửa sau hết thiếu thì gỡ; đổi món thiếu thì thay ghi chú', () => {
  const order = threeBags({ processingFlags: ['⚠ Có thể trùng đơn LP-a1'] });
  const camFlag = posGiftSwapFlag(['Gói granola nhỏ Cam 30g (GRA-CAM-G30)']);
  assert.equal(camFlag, '⚠ Đổi quà: POS chưa có Gói granola nhỏ Cam 30g (GRA-CAM-G30) — nhân viên thêm quà thay thế trên POS');
  assert.equal(applyGiftSwapFlag(order, ['Gói granola nhỏ Cam 30g (GRA-CAM-G30)']), true);
  assert.deepEqual(order.processingFlags, ['⚠ Có thể trùng đơn LP-a1', camFlag]);
  assert.equal(applyGiftSwapFlag(order, ['Gói granola nhỏ Cam 30g (GRA-CAM-G30)']), false, 'cùng ghi chú: không thêm lần hai');
  assert.equal(processingNotes(order).filter(note => note === camFlag).length, 1, 'bảng Đơn hàng / Tổng quan thấy đúng một dòng');
  // Khách sửa tiếp, quà thay thế đổi sang món khác còn thiếu: ghi chú cũ được thay.
  assert.equal(applyGiftSwapFlag(order, ['quà thay thế (chưa chọn vị)']), true);
  assert.deepEqual(order.processingFlags, ['⚠ Có thể trùng đơn LP-a1', posGiftSwapFlag(['quà thay thế (chưa chọn vị)'])]);
  // Lần sửa sau POS đã đủ mã: gỡ ghi chú đổi quà, giữ ghi chú khác.
  assert.equal(applyGiftSwapFlag(order, []), true);
  assert.deepEqual(order.processingFlags, ['⚠ Có thể trùng đơn LP-a1']);
  assert.equal(applyGiftSwapFlag(threeBags(), []), false);
  assert.equal(applyGiftSwapFlag(null, ['x']), false);
});

test('server.updateChatbotCustomerOrder nối kết quả PUT POS vào ghi chú xử lý của đơn (PUT lỗi thì không đụng ghi chú)', () => {
  const server = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '');
  const body = server.slice(server.indexOf('async function updateChatbotCustomerOrder('), server.indexOf('async function addChatbotOrderNote('));
  assert.match(body, /let giftSwapMissing = null;/);
  assert.match(body, /\.then\(updated => \{ giftSwapMissing = updated\?\.giftSwapMissing \|\| \[\];/);
  assert.match(body, /if \(target && giftSwapMissing\) applyGiftSwapFlag\(target, giftSwapMissing\);/);
  assert.match(server, /import \{ applyGiftSwapFlag, [^}]*\} from '\.\/pos-orders\.mjs';/);
});
