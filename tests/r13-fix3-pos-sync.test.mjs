// R13-fix3 — sửa theo phản biện review-api.md (C1, T1, T2, T3, L1, L3, L4, L5). Số liệu theo stub POS kịch bản S1–S12 + L1
// của bản phản biện (r13/review-api/stub2.mjs): 2 túi Xanh 174.000đ, bát BGD 23.000đ, muỗng MUONG 17.000đ.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('r13-fix3-');
process.env.LANDING_ORDERS_PATH = path.join(directory, 'landing-orders.json');
process.env.LANDING_ARCHIVE_PATH = path.join(directory, 'landing-archive');
process.env.ORDER_ARCHIVE_PATH = path.join(directory, 'order-archive');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.PHONE_WARNINGS_PATH = path.join(directory, 'phone-warnings.json');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
await import('./helpers/seed-catalog.mjs');

const { normalizeCustomerOrder } = await import('../app/conversation-orders.mjs');
const {
  applyPosContent, finalizePosImportedOrder, isDeletedPosOrder, posCollectedNote, posComputedTotal, posGiftLinePrice, posGoodsItems, posLegacyLineTotal,
  posPaidTotal, posPreferredTotal, rememberDeletedPosOrder, repairPosImportedTotal
} = await import('../app/pos-content-sync.mjs');
const { posOrderTotal, posOrderToPayload } = await import('../app/pos-sync.mjs');
const { applyCustomerOrderEdits, applyPosRepush, createManualOrderGuard, describeOrderEdits, orderEditAction } = await import('../app/order-edits.mjs');
const { DUPLICATE_FLAG_PREFIX, buildLandingOrder, flagPossibleDuplicate, sweepDuplicateFlags } = await import('../app/landing-orders.mjs');
const { dashboardTodo } = await import('../app/dashboard.mjs');

const X = (quantity, price = 174000) => ({ quantity, is_bonus_product: false, variation_info: { display_id: 'GRA-XANH-Z450', name: 'Granola Túi Xanh 450g', retail_price: price } });
const line = (sku, name, price, quantity = 1, bonus = false) => ({ quantity, is_bonus_product: bonus, variation_info: { display_id: sku, name, retail_price: price } });
const BGD = () => line('BGD', 'Bộ bát gáo dừa', 23000);
const MUONG = () => line('MUONG', 'Muỗng dừa', 17000);
let n = 0;
const pos = (fields, items) => ({ id: `ps-${++n}`, system_id: 70000 + n, status: 0, status_name: 'new', conversation_id: 'p_c', bill_full_name: `Khách ${n}`, bill_phone_number: '0987654002',
  shipping_address: { full_address: '25 Nguyễn Trãi, Phường Bến Thành, Quận 1, Hồ Chí Minh' }, is_free_shipping: true, shipping_fee: 0, total_discount: 0, cod: 0, transfer_money: 0, items, ...fields });

/** Dựng đơn CRM y như importPosConversationOrders (server.mjs). */
function importOrder(posOrder) {
  const order = normalizeCustomerOrder({
    id: `pos${posOrder.system_id}`, name: posOrder.bill_full_name, phone: posOrder.bill_phone_number, address: posOrder.shipping_address.full_address,
    products: posGoodsItems(posOrder).map(item => ({ name: item.variation_info.name, sku: item.variation_info.display_id, quantity: item.quantity, price: item.variation_info.retail_price })),
    shippingFee: posOrder.shipping_fee, freeShipping: Boolean(posOrder.is_free_shipping) || !Number(posOrder.shipping_fee), discount: posOrder.total_discount, source: 'POS'
  });
  return finalizePosImportedOrder(order, posOrder);
}

/** Đơn đã kéo về bằng BẢN CŨ (97d07bf): tổng = Σ giá mọi dòng không phải dòng tặng + ship − giảm. */
const oldImport = posOrder => ({ id: `pos${posOrder.system_id}`, source: 'POS', total: posLegacyLineTotal(posOrder), discount: posOrder.total_discount || 0, gift: '', products: posOrder.items.filter(item => !item.is_bonus_product).map(item => ({ sku: item.variation_info.display_id, quantity: item.quantity, price: item.variation_info.retail_price })) });

test('T1: 12 kịch bản S1–S12 — tổng ưu tiên tổng POS tự tính (total_price − giảm + ship, trừ dòng mã quà); S7 trả trước MoMo giữ 348.000đ', () => {
  const S = {
    S1: pos({ cod: 348000, total_price: 388000 }, [X(2), BGD(), MUONG()]),
    S2: pos({ cod: 248000, transfer_money: 100000, total_price: 348000 }, [X(2)]),
    S3: pos({ cod: 0, transfer_money: 348000, total_price: 348000 }, [X(2)]),
    S4: pos({ cod: 447000, total_discount: 75000, total_price: 522000 }, [X(3)]),
    S5: pos({ cod: 0, total_price: 371000 }, [X(2), BGD()]),
    S6: pos({ cod: 348000, status: 6, status_name: 'canceled', total_price: 388000 }, [X(2), BGD(), MUONG()]),
    S7: pos({ cod: 248000, charged_by_momo: 100000, prepaid: 100000, total_price: 348000 }, [X(2)]),
    S8: pos({ cod: 189000, is_free_shipping: false, shipping_fee: 15000, total_price: 174000 }, [X(1)]),
    S9: pos({ cod: 348000, total_price: 388000 }, [X(2), BGD(), MUONG()]),
    S10: pos({ cod: 23000, total_price: 23000 }, [BGD()]),
    S11: pos({ cod: 1044000, total_price: 1044000 }, [X(5), line('GRA-VANG-H350', 'Granola Túi Vàng 350g', 174000), line('GRA-VANG-H350', 'Granola Túi Vàng 350g', 0, 1, true)]),
    S12: pos({ cod: 30000, total_price: 348000 }, [X(2)])
  };
  const expected = { S1: 348000, S2: 348000, S3: 348000, S4: 447000, S5: 348000, S6: 348000, S7: 348000, S8: 189000, S9: 348000, S10: 23000, S11: 1044000, S12: 348000 };
  for (const [key, posOrder] of Object.entries(S)) {
    const order = importOrder(posOrder);
    assert.equal(order.total, expected[key], `${key}: tổng`);
    assert.equal(posPaidTotal(posOrder), expected[key], `${key}: đường cập nhật (posPaidTotal) cùng một số với lượt kéo đầu (L2)`);
    assert.equal(posOrderTotal(posOrder), expected[key], `${key}: đơn landing (pos-sync) cùng công thức`);
  }
  // Trước R13-fix: S7 (cod 248k + MoMo 100k ở trường lạ) bị hạ 348.000đ → 248.000đ.
  assert.equal(importOrder(S.S7).discount, 0);
  assert.equal(importOrder(S.S7).prepaid, undefined, 'không đoán trường trả trước lạ (chủ shop xác nhận tên trường trên POS thật)');
  // ℹ (không tính vào việc cần làm) để soát: thu hộ POS khác tổng.
  assert.deepEqual(importOrder(S.S7).processingFlags, ['ℹ POS ghi thu hộ 248.000đ khác tổng 348.000đ (trả trước kênh khác / sửa tay COD?)']);
  assert.deepEqual(importOrder(S.S12).processingFlags, ['ℹ POS ghi thu hộ 30.000đ khác tổng 348.000đ (trả trước kênh khác / sửa tay COD?)']);
  assert.equal(importOrder(S.S2).processingFlags, undefined, 'cod + CK = tổng: không ghi chú');
  assert.equal(importOrder(S.S2).prepaid, 100000);
  assert.equal(importOrder(S.S3).prepaid, 348000);
  assert.equal(importOrder(S.S4).discount, 75000);
  assert.equal(importOrder(S.S8).shippingFee, 15000);
  assert.equal(importOrder(S.S1).gift, 'Bộ bát gáo dừa + Muỗng dừa');
  assert.equal(posGiftLinePrice(S.S1), 40000);
  assert.equal(posGiftLinePrice(S.S10), 0, 'đơn chỉ toàn mã quà: dòng quà là hàng');
  assert.equal(posComputedTotal({ cod: 100000 }), 0, 'không có total_price → 0');
  assert.equal(posPreferredTotal({ cod: 100000, transfer_money: 20000 }), 120000, 'không có total_price mới lấy thu hộ + CK');
  const todo = dashboardTodo({ conversations: [{ customerOrders: [{ ...importOrder(S.S7), createdAt: Date.now() }] }] });
  assert.equal(todo.ordersToReview, 0, 'ghi chú ℹ không thành việc cần làm');
});

test('T1c: chỉnh một lần đơn cũ CHỈ khi chênh đúng bằng giá dòng mã quà; S7 bản cũ 348.000đ giữ nguyên; chênh lý do khác → giữ + log', () => {
  const s1 = pos({ cod: 348000, total_price: 388000 }, [X(2), BGD(), MUONG()]);
  const old1 = oldImport(s1);
  assert.equal(old1.total, 388000);
  assert.equal(repairPosImportedTotal(old1, importOrder(s1), s1, { now: 1000, log: () => {} }), true);
  assert.equal(old1.total, 348000);
  assert.equal(old1.history.at(-1).summary, 'Tổng đơn chỉnh: bỏ giá dòng quà (BGD 23.000đ + MUONG 17.000đ) khỏi tiền hàng: 388.000đ → 348.000đ.');
  assert.equal(repairPosImportedTotal(old1, importOrder(s1), s1, { log: () => {} }), false, 'không dao động');
  // S7: bản cũ đã đúng 348.000đ → không đụng, không lịch sử nói về "quà".
  const s7 = pos({ cod: 248000, prepaid: 100000, total_price: 348000 }, [X(2)]);
  const old7 = oldImport(s7);
  assert.equal(old7.total, 348000);
  assert.equal(repairPosImportedTotal(old7, importOrder(s7), s7, { log: () => {} }), false);
  assert.equal(old7.history, undefined);
  // S5 (POS không ghi tiền thu, có total_price): 371.000đ → 348.000đ vì chênh = BGD 23.000đ.
  const s5 = pos({ cod: 0, total_price: 371000 }, [X(2), BGD()]);
  const old5 = oldImport(s5);
  assert.equal(repairPosImportedTotal(old5, importOrder(s5), s5, { log: () => {} }), true);
  assert.equal(old5.total, 348000);
  // Chênh KHÔNG bằng giá dòng quà (POS tính tổng khác Σ dòng): giữ nguyên, log một lần để soát tay.
  const odd = pos({ cod: 300000, total_price: 300000 }, [X(2), BGD()]);
  const oldOdd = oldImport(odd); // 371.000đ, POS 277.000đ, chênh 94.000đ ≠ 23.000đ
  const logs = [];
  assert.equal(repairPosImportedTotal(oldOdd, importOrder(odd), odd, { log: line => logs.push(line) }), false);
  assert.equal(repairPosImportedTotal(oldOdd, importOrder(odd), odd, { log: line => logs.push(line) }), false);
  assert.equal(oldOdd.total, 371000);
  assert.equal(logs.length, 1, 'log một lần mỗi đơn');
  assert.match(logs[0], /371\.000đ.*277\.000đ.*giữ nguyên/);
});

test('C1: đơn pos<system_id> đã "Lên lại POS" (pos.id = CRM-…-L2) không bị đồng bộ hủy theo đơn POS cũ status 6', async () => {
  const server = (await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const block = server.slice(server.indexOf('async function importPosConversationOrders'), server.indexOf('async function importPosConversationOrders') + 9000);
  assert.match(block, /find\(entry => entry\.pos\?\.id && String\(entry\.pos\.id\) === posId\)/, 'khớp theo pos.id trước');
  assert.match(block, /const samePosOrder = !existing\.pos\?\.id \|\| String\(existing\.pos\.id\) === posId;/);
  assert.match(block, /if \(!samePosOrder \|\| String\(existing\.pos\?\.previousId \|\| ''\) === posId\) \{ relabel\(conversation, existing\); continue; \}/);
  assert.match(block, /if \(!existing && isDeletedPosOrder\(conversation, posOrder\)\) continue;/, 'T2');
  // Logic như server: đơn đã lên lại → bỏ qua đơn POS cũ.
  const order = { id: 'pos70003', source: 'POS', processingStatus: '', pos: { id: 'CRM-pos70003-L2', systemId: '70103', crmRef: 'pos70003-L2', previousId: 'ps-S3' } };
  const oldPos = { id: 'ps-S3', system_id: 70003, status: 6 };
  const samePosOrder = !order.pos?.id || String(order.pos.id) === String(oldPos.id);
  assert.equal(samePosOrder, false);
  assert.equal(String(order.pos.previousId) === String(oldPos.id), true);
  // L4: applyPosRepush bỏ dấu nội dung POS cũ → lượt sau chỉ ghi dấu, không ghi "Sửa trên Pancake POS" giả.
  const repushed = { id: 'pos70003', source: 'POS', name: 'Khách S3', phone: '0987654002', address: '25 Nguyễn Trãi, Phường Bến Thành, Quận 1, Hồ Chí Minh', products: [{ sku: 'GRA-XANH-Z450', quantity: 2, price: 174000 }], total: 348000, shippingFee: 0, freeShipping: true,
    pos: { id: 'ps-S3', systemId: '70003', cancelled: true, needsRepush: true }, posContent: { info: 'x', items: 'y', values: {}, at: 1 } };
  applyPosRepush(repushed, { id: 'CRM-pos70003-L2', systemId: '70103', status: 'new' }, { ref: 'pos70003-L2', attempt: 1, now: 5 });
  assert.equal(repushed.posContent, undefined);
  assert.equal(repushed.pos.previousId, 'ps-S3');
  const fresh = { id: 'CRM-pos70003-L2', system_id: 70103, status: 0, updated_at: '2026-10-02T03:00:00.000000', bill_full_name: 'Khách S3', bill_phone_number: '0987654002', is_free_shipping: true, shipping_fee: 0,
    shipping_address: { full_address: '25 Nguyễn Trãi, Phường Bến Thành, Quận 1, Hồ Chí Minh' }, items: [X(2)], cod: 348000, total_price: 348000 };
  const result = applyPosContent(repushed, fresh, { now: 10 });
  assert.deepEqual(result.changed, [], 'lần đầu gặp đơn POS mới: chỉ ghi dấu');
  assert.equal(result.marked, true);
  assert.equal(repushed.history, undefined);
});

test('T2: đơn POS kéo về đã xoá được nhớ trong hội thoại (90 ngày) và không kéo về lại — kể cả đơn đã lên lại POS', () => {
  const conversation = { id: 'c1', customerOrders: [] };
  const removed = { id: 'pos70006', source: 'POS', pos: { id: 'ps-S6', systemId: '70006', importedAt: 1 } };
  assert.equal(rememberDeletedPosOrder(conversation, removed, 1000), true);
  assert.equal(isDeletedPosOrder(conversation, { id: 'ps-S6', system_id: 70006 }, 2000), true);
  assert.equal(isDeletedPosOrder(conversation, { id: 'ps-S7', system_id: 70007 }, 2000), false);
  assert.equal(isDeletedPosOrder(conversation, { id: 'ps-S6', system_id: 70006 }, 1000 + 91 * 24 * 3600 * 1000), false, 'quá 90 ngày thì thôi');
  // Đơn đã lên lại POS rồi xoá: đơn POS gốc (ps-S3 / 70003) cũng không kéo về lại.
  rememberDeletedPosOrder(conversation, { id: 'pos70003', source: 'POS', pos: { id: 'CRM-pos70003-L2', systemId: '70103', previousId: 'ps-S3' } }, 3000);
  assert.equal(isDeletedPosOrder(conversation, { id: 'ps-S3', system_id: 70003 }, 4000), true);
  // Đơn CRM tạo rồi đẩy sang POS (không phải kéo về): không ghi.
  assert.equal(rememberDeletedPosOrder(conversation, { id: 'ab12', source: 'Facebook', pos: { id: 'CRM-ab12' } }), false);
  assert.equal(conversation.deletedPosOrders.length, 2);
});

test('T3: cờ "⚠ Có thể trùng đơn LP-<mã>" gỡ khi đơn gốc hủy/xoá/xác nhận hay đơn mang cờ đã chốt; nhân viên gỡ qua PATCH processingFlags', () => {
  const now = Date.now();
  const order = (id, minutes) => ({ id, phone: '0977000404', address: '45 Nguyễn Huệ, Phường Bến Nghé, Quận 1, Hồ Chí Minh', street: '45 Nguyễn Huệ', ward: 'Phường Bến Nghé', district: 'Quận 1', province: 'Hồ Chí Minh',
    products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 3, price: 149000 }], total: 447000, createdAt: now + minutes * 60000, status: 'Mới', processingStatus: '', landing: {} });
  const a = order('912b0e45', 0);
  const b = order('d85f93e3', 2);
  const orders = [a, b];
  assert.equal(flagPossibleDuplicate(orders, b), b);
  assert.deepEqual(b.processingFlags, [`${DUPLICATE_FLAG_PREFIX}912b0e45`]);
  assert.equal(sweepDuplicateFlags(orders), 0, 'cả hai còn mở: giữ cờ');
  // Đơn gốc hủy → gỡ.
  a.processingStatus = 'cancelled'; a.status = 'Hủy';
  assert.equal(sweepDuplicateFlags(orders), 1);
  assert.equal(b.processingFlags, undefined);
  // Đơn gốc bị xoá → gỡ.
  a.processingStatus = ''; a.status = 'Mới';
  flagPossibleDuplicate(orders, b);
  assert.equal(sweepDuplicateFlags([b]), 1);
  assert.equal(b.processingFlags, undefined);
  // Đơn mang cờ được Đã xác nhận → gỡ; đơn gốc Đã xác nhận → gỡ.
  flagPossibleDuplicate(orders, b);
  b.processingStatus = 'confirmed';
  assert.equal(sweepDuplicateFlags(orders), 1);
  b.processingStatus = '';
  flagPossibleDuplicate(orders, b);
  a.processingStatus = 'confirmed';
  assert.equal(sweepDuplicateFlags(orders), 1);
  a.processingStatus = '';
  // Nhân viên gỡ tay: PATCH processingFlags = danh sách giữ lại; không thêm được cờ mới qua API.
  flagPossibleDuplicate(orders, b);
  b.processingFlags.push('ℹ Giá landing 399.000đ khác bảng giá 447.000đ');
  const changed = applyCustomerOrderEdits(b, { processingFlags: ['ℹ Giá landing 399.000đ khác bảng giá 447.000đ', '⚠ Cờ bịa'] });
  assert.deepEqual([...changed], ['processingFlags']);
  assert.deepEqual(b.processingFlags, ['ℹ Giá landing 399.000đ khác bảng giá 447.000đ']);
  assert.equal(orderEditAction(['processingFlags'], b), 'order.update');
  assert.equal(describeOrderEdits(b, b, ['processingFlags']), 'gỡ cờ ghi chú xử lý');
  assert.deepEqual([...applyCustomerOrderEdits(b, { processingFlags: ['ℹ Giá landing 399.000đ khác bảng giá 447.000đ'] })], [], 'không đổi gì thì không ghi');
  // Tổng quan: sau khi gỡ, đơn không còn là việc cần soát.
  flagPossibleDuplicate(orders, b);
  assert.equal(dashboardTodo({ landingOrders: orders, now }).ordersToReview, 1);
  a.processingStatus = 'cancelled';
  sweepDuplicateFlags(orders);
  assert.equal(dashboardTodo({ landingOrders: orders, now }).ordersToReview, 0);
});

test('L1: khoá chống trùng đơn tay có địa chỉ/người nhận — cùng SĐT + giỏ + tổng nhưng KHÁC địa chỉ không còn 409', () => {
  let now = 1_000_000;
  const guard = createManualOrderGuard({ clock: () => now });
  const base = { name: 'Nguyễn Thị Thử Một', phone: '0912345001', address: '12 Lê Lợi, phường Bến Nghé, Quận 1, Hồ Chí Minh', products: [{ sku: 'GRA-XANH-Z450', quantity: 2 }], total: 298000, createdAt: now };
  const first = { ...base, id: 'a1' };
  assert.deepEqual(guard.find('c1', [first], { ...base, id: 'a2' }), { id: 'a1', createdAt: now }, 'y hệt → trùng');
  assert.equal(guard.find('c1', [first], { ...base, id: 'a3', address: '99 Trần Hưng Đạo, phường Cầu Kho, Quận 1, Hồ Chí Minh', name: 'Người nhận khác' }), null, 'khác địa chỉ/người nhận → đơn khác');
  assert.deepEqual(guard.find('c1', [first], { ...base, id: 'a4', address: '12 LÊ LỢI, Phường Bến Nghé, Quận 1, Hồ Chí Minh' }), { id: 'a1', createdAt: now }, 'khác hoa/thường → vẫn trùng');
});

test('L5: đơn landing kéo từ POS có đặt cọc mang prepaid; L3: nút Đẩy POS không ghi lịch sử khi không làm gì', async () => {
  const l1 = pos({ cod: 299000, transfer_money: 100000, total_price: 439000, order_sources_name: 'Webcake', link: 'https://giotnang.vn/lp-thu', inserted_at: '2026-10-02T02:00:00.000000', bill_phone_number: '0977000201' }, [X(3, 133000), BGD(), MUONG()]);
  const payload = posOrderToPayload(l1);
  assert.equal(payload.total, 399000);
  assert.equal(payload.prepaid, 100000);
  const order = buildLandingOrder(payload, { now: Date.now(), id: 'l1test', posId: l1.id });
  assert.equal(order.total, 399000);
  assert.equal(order.prepaid, 100000);
  assert.ok(!order.landing.unknownFields.some(field => /prepaid/.test(field)), 'prepaid là trường đã biết');
  assert.equal(posOrderToPayload(pos({ cod: 299000, total_price: 299000 }, [X(1)])).prepaid, undefined);
  const server = (await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(server, /const posIdBefore = String\(reopened\?\.pos\?\.id \|\| ''\);/);
  assert.match(server, /if \(outcome\?\.error \|\| \(String\(outcome\?\.id \|\| ''\) !== posIdBefore && shouldLogPosPush\(`\$\{orderId\}\|\$\{outcome\?\.id\}`\)\)\) \{\n\s+await addOrderHistory\(orderId, \{ by: actorStamp\(actor\), action: 'order\.push_pos'/);
  assert.match(server, /const shouldLogPosPush = createSeenOnce\(500\);/, 'hai request sát nhau chỉ ghi một dòng lịch sử');
  assert.match(server, /rememberDeletedPosOrder\(conversation, removed\);/, 'T2: DELETE nhớ mã POS đã xoá');
});

test('T1d: posCollectedNote — câu đúng thực tế, không nói về quà khi không có quà', () => {
  assert.equal(posCollectedNote({ cod: 248000 }, 348000), 'ℹ POS ghi thu hộ 248.000đ khác tổng 348.000đ (trả trước kênh khác / sửa tay COD?)');
  assert.equal(posCollectedNote({ cod: 248000, transfer_money: 100000 }, 348000), '');
  assert.equal(posCollectedNote({ cod: 0 }, 348000), '', 'POS không ghi tiền thu: không ghi chú');
  assert.equal(posCollectedNote({ cod: 200000, transfer_money: 100000 }, 348000), 'ℹ POS ghi thu hộ 200.000đ + CK 100.000đ khác tổng 348.000đ (trả trước kênh khác / sửa tay COD?)');
});
