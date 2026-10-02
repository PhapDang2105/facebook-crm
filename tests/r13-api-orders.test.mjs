// R13 (api) — đơn tay / sửa / xoá / mở lại đơn: M1, M2, M7, L2, L3, L4, nhật ký "tổng 189000đ".
// Các ca theo báo cáo out-functions (đã chạy thử trên bản 97d07bf):
//   M1: gửi 2 lần cùng nội dung cách nhau < 1 giây → 2 đơn và 2 đơn POS;
//   M2: DELETE đơn đã có pos-1004 → 200, POS không được hủy;
//   M7: hủy → POS hủy; đặt lại processingStatus "" → đơn về "Mới" nhưng pos.cancelled vẫn true, không cảnh báo;
//   L2: processingStatus "khong-co" được lưu; L3: order:null → "Cannot read properties of null"; đơn 0đ;
//   L4: PATCH products thiếu price → tổng 0đ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

await import('./helpers/seed-catalog.mjs');
const { normalizeCustomerOrder } = await import('../app/conversation-orders.mjs');
const {
  MANUAL_ORDER_DUPLICATE_WINDOW_MS, POS_REOPEN_FLAG, addProcessingFlag, applyCustomerOrderEdits, applyPosRepush, assertManualOrderMoney,
  createManualOrderGuard, describeOrderEdits, duplicateManualOrderMessage, isLiveOnPos, moneyText, needsPosRepush, orderProcessingNotes,
  posCancelRefOf, posRepushDraft, removeProcessingFlag
} = await import('../app/order-edits.mjs');

const ADDRESS = '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
const manual = (overrides = {}) => normalizeCustomerOrder({
  id: '51234', name: 'Khách thử', phone: '0912345678', address: ADDRESS,
  products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2, price: 149000 }],
  freeShipping: true, ...overrides
});
const server = (await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('M1: đơn tay trùng (cùng hội thoại + SĐT + giỏ + tổng trong 2 phút) bị nhận ra — cả khi đơn đầu CHƯA kịp lưu', () => {
  let now = 1_000_000;
  const guard = createManualOrderGuard({ clock: () => now });
  const first = { ...manual(), id: '3b9adc', createdAt: now };
  assert.equal(guard.find('c1', [], first), null);
  guard.reserve('c1', first);
  // Request thứ hai tới < 1 giây sau, kho chưa có đơn đầu.
  const second = { ...manual(), id: '8ff9dc', createdAt: now + 400 };
  assert.deepEqual(guard.find('c1', [], second), { id: '3b9adc', createdAt: now });
  // Hội thoại khác, giỏ khác, tổng khác, SĐT khác: không trùng.
  assert.equal(guard.find('c2', [], second), null);
  assert.equal(guard.find('c1', [], { ...manual({ products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 3, price: 149000 }] }), id: 'x' }), null);
  assert.equal(guard.find('c1', [], { ...manual({ phone: '0987654321' }), id: 'x' }), null);
  // Đơn đầu lưu xong (trả chỗ): nhận ra qua đơn đã lưu trong hội thoại.
  guard.release('c1', first);
  assert.equal(guard.find('c1', [], second), null);
  assert.deepEqual(guard.find('c1', [first], second), { id: '3b9adc', createdAt: now });
  // Đơn đầu đã hủy, hay đã quá 2 phút: cho tạo.
  assert.equal(guard.find('c1', [{ ...first, processingStatus: 'cancelled' }], second), null);
  now += MANUAL_ORDER_DUPLICATE_WINDOW_MS + 1;
  assert.equal(guard.find('c1', [first], second), null);
  // Tạo lỗi (gửi phiếu Messenger hỏng → trả chỗ) thì lần bấm lại không bị chặn.
  const failed = { ...manual(), id: 'f1', createdAt: now };
  guard.reserve('c1', failed);
  guard.release('c1', failed);
  assert.equal(guard.find('c1', [], { ...manual(), id: 'f2' }), null);
});

test('M1: câu hỏi cho nhân viên và route trả 409 kèm mã đơn cũ, có force:true', () => {
  const message = duplicateManualOrderMessage({ id: '3b9adc', createdAt: Date.UTC(2026, 9, 2, 5, 7) });
  assert.equal(message, 'Đơn giống hệt vừa tạo lúc 12:07 (mã #3b9adc) — vẫn tạo?');
  assert.match(server, /const duplicate = payload\.force === true \? null : manualOrderGuard\.find\(conversationId, currentOrders, order\);/);
  assert.match(server, /status: 409, body: \{ error: duplicateManualOrderMessage\(duplicate\), duplicate: true, duplicateOrderId: duplicate\.id, duplicateCreatedAt: duplicate\.createdAt \}/);
  assert.match(server, /manualOrderGuard\.reserve\(conversationId, order\);/);
  // Lỗi gửi phiếu và lưu xong đều trả chỗ.
  const create = server.slice(server.indexOf("if (payload.type === 'order') {"), server.indexOf("if (payload.type === 'order') {") + 4000);
  assert.match(create, /draft\.release\(\);\n\s+return sendJson\(response, 502/);
  assert.match(create, /\}\)\.finally\(draft\.release\);/);
});

test('L3: đơn tay — order:null / không phải object → câu tiếng Việt; tổng 0đ và giảm giá lớn hơn tiền hàng bị chặn', () => {
  assert.match(server, /normalizeCustomerOrder\(payload\.order && typeof payload\.order === 'object' && !Array\.isArray\(payload\.order\) \? payload\.order : \{\}\)/);
  assert.throws(() => normalizeCustomerOrder({}), /Đơn hàng cần đủ tên, số điện thoại, địa chỉ và sản phẩm\./);
  assert.doesNotThrow(() => assertManualOrderMoney(manual()));
  assert.throws(() => assertManualOrderMoney(manual({ products: [{ name: 'tui xanh', quantity: 1, price: 0 }] })), /Tổng đơn phải lớn hơn 0đ/);
  assert.throws(() => assertManualOrderMoney(manual({ discount: 400000 })), /Giảm giá \(400\.000đ\) không được lớn hơn tiền hàng \(298\.000đ\)/);
  // Giảm đúng bằng tiền hàng → tổng 0đ cũng bị chặn; giảm ít hơn thì qua.
  assert.throws(() => assertManualOrderMoney(manual({ discount: 298000 })), /Tổng đơn phải lớn hơn 0đ/);
  assert.doesNotThrow(() => assertManualOrderMoney(manual({ discount: 50000 })));
});

test('L2: processingStatus chỉ nhận mã hợp lệ ("khong-co" bị từ chối, đơn không đổi)', () => {
  const order = manual();
  assert.throws(() => applyCustomerOrderEdits(order, { processingStatus: 'khong-co' }), /Trạng thái xử lý không hợp lệ/);
  assert.equal(order.processingStatus, '');
  for (const status of ['call1', 'call2', 'call3', 'calling', 'callback', 'transfer', 'hold', 'confirmed', 'cancelled', '']) {
    assert.doesNotThrow(() => applyCustomerOrderEdits(manual(), { processingStatus: status }), `mã ${status || '(rỗng)'} phải được nhận`);
  }
});

test('L4: PATCH products thiếu giá → lấy giá danh mục theo SKU (không còn tổng 0đ); gửi rõ 0 thì vẫn là 0', () => {
  const order = manual();
  applyCustomerOrderEdits(order, { products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1 }] });
  assert.ok(order.products[0].price > 0, 'giá lấy từ danh mục');
  assert.equal(order.total, order.products[0].price);
  const blank = manual();
  applyCustomerOrderEdits(blank, { products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1, price: '' }] });
  assert.ok(blank.total > 0);
  const free = manual();
  applyCustomerOrderEdits(free, { products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1, price: 0 }, { name: 'Granola Túi Vàng 350g', sku: 'GRA-VANG-H350', quantity: 1, price: 149000 }] });
  assert.equal(free.products[0].price, 0, 'giá 0 gửi rõ (dòng tặng) được giữ');
  assert.equal(free.total, 149000);
});

test('M7: mở lại đơn đã hủy mà POS vẫn hủy → ghi chú "⚠ Đơn đã hủy trên POS — cần lên lại", cờ needsRepush, không bị đồng bộ hủy lại', () => {
  const order = { ...manual(), processingStatus: 'cancelled', status: 'Hủy', pos: { id: 'pos-1004', systemId: '1004', cancelled: true } };
  const changed = applyCustomerOrderEdits(order, { processingStatus: '' }, 5000);
  assert.deepEqual([...changed], ['processingStatus']);
  assert.equal(changed.posReopened, true);
  assert.equal(order.status, 'Mới');
  assert.deepEqual(order.processingFlags, [POS_REOPEN_FLAG]);
  assert.equal(POS_REOPEN_FLAG, '⚠ Đơn đã hủy trên POS — cần lên lại');
  assert.equal(order.pos.needsRepush, true);
  assert.equal(order.pos.cancelSyncedAt, 5000, 'đồng bộ POS (cancelCrmOrdersCancelledOnPos) bỏ qua đơn có cancelSyncedAt');
  assert.equal(needsPosRepush(order), true);
  assert.equal(orderProcessingNotes(order)[0], POS_REOPEN_FLAG);
  assert.match(describeOrderEdits({ processingStatus: 'cancelled', total: order.total }, order, changed), /đơn đã hủy trên POS — cần lên lại/);
  // Đẩy lại: đơn POS MỚI với mã "<mã>-L2" (mã gốc đang bị đơn đã hủy giữ), bỏ ghi chú + cờ.
  const draft = posRepushDraft(order);
  assert.equal(draft.ref, '51234-L2');
  assert.equal(draft.order.id, '51234-L2');
  assert.equal('pos' in draft.order, false);
  order.note = 'Giao giờ hành chính. Đã hủy trên POS (đồng bộ lúc 09:15).';
  applyPosRepush(order, { id: 'pos-2001', systemId: '2001', status: 'new' }, { ...draft, now: 6000 });
  assert.equal(order.pos.id, 'pos-2001');
  assert.equal(order.pos.crmRef, '51234-L2');
  assert.equal(order.pos.previousId, 'pos-1004');
  assert.equal(order.pos.cancelled, undefined);
  assert.equal(order.pos.cancelSyncedAt, undefined, 'đơn POS mới: lần hủy trên POS sau này lại được đồng bộ');
  assert.equal(order.processingFlags, undefined);
  assert.equal(order.note, 'Giao giờ hành chính.');
  assert.equal(needsPosRepush(order), false);
  // Hủy theo POS chỉ khớp ĐƠN POS MỚI, không khớp đơn cũ đã hủy.
  assert.equal(posCancelRefOf(order), '51234-L2');
  assert.equal(posCancelRefOf(manual()), '51234');
  assert.equal(posRepushDraft(order).ref, '51234-L3', 'lên lại lần nữa thì tăng số');
});

test('M7: không phải trường hợp POS hủy thì không gắn gì; route Đẩy POS gọi lên lại khi needsPosRepush', () => {
  const plain = { ...manual(), processingStatus: 'cancelled', status: 'Hủy', pos: { id: 'pos-1', error: 'Hủy trên POS lỗi: mạng' } };
  const changed = applyCustomerOrderEdits(plain, { processingStatus: '' });
  assert.equal(changed.posReopened, undefined);
  assert.equal(plain.processingFlags, undefined);
  assert.equal(needsPosRepush(plain), false);
  const noPos = { ...manual(), processingStatus: 'cancelled', status: 'Hủy' };
  applyCustomerOrderEdits(noPos, { processingStatus: 'confirmed' });
  assert.equal(noPos.pos, undefined);
  assert.match(server, /const outcome = needsPosRepush\(reopened\) \? await repushCancelledOrderToPos\(owner, reopened\) : await syncOrderToPos\(owner\.id, orderId\);/);
  assert.match(server, /created = await pushOrderToPos\(draft\.order, \{ conversation \}\);/);
  assert.match(server, /if \(!wanted\.has\(posCancelRefOf\(order\)\) \|\| order\.processingStatus === 'cancelled' \|\| order\.pos\?\.cancelSyncedAt/);
});

test('M2: xoá đơn đã lên POS chưa hủy → 409 "Hãy hủy đơn trước khi xoá" (không tự hủy POS); đơn đã hủy / chưa lên POS / landing xoá như cũ', () => {
  assert.equal(isLiveOnPos({ id: 'ea0b2', pos: { id: 'pos-1004' } }), true);
  assert.equal(isLiveOnPos({ id: 'ea0b2', pos: { id: 'pos-1004', cancelled: true } }), false);
  assert.equal(isLiveOnPos({ id: 'ea0b2', pos: { id: 'pos-1004' }, processingStatus: 'cancelled' }), false);
  assert.equal(isLiveOnPos({ id: 'ea0b2', pos: { id: 'pos-1004' }, status: 'Hủy' }), false);
  assert.equal(isLiveOnPos({ id: 'ea0b2', pos: { id: 'pos-1004' }, posStatus: { code: 6 } }), false, 'POS báo đã hủy');
  assert.equal(isLiveOnPos({ id: 'ea0b2', pos: { error: 'chưa đẩy được' } }), false);
  assert.equal(isLiveOnPos({ id: 'lp1', landing: { posId: '777' } }), false, 'đơn landing (form) xoá như cũ');
  assert.equal(isLiveOnPos(null), false);
  const route = server.slice(server.indexOf("if (customerOrderDeleteMatch && request.method === 'DELETE') {"), server.indexOf('// Kho lưu trữ đơn: tra lại khách'));
  assert.match(route, /if \(isLiveOnPos\(orders\[index\]\)\) \{ liveOnPos = orders\[index\]; return null; \}/);
  assert.match(route, /return sendJson\(response, 409, \{ error: `Đơn này đã lên Pancake POS[^`]*Hãy hủy đơn trước khi xoá\.`/);
  assert.doesNotMatch(route, /cancelPosOrder\(/, 'xoá không tự hủy đơn bên POS');
});

test('ghi chú xử lý gắn trên đơn (processingFlags): không trùng, có trần, gỡ được, đứng trước ghi chú dựng từ dữ liệu', () => {
  const order = manual();
  assert.equal(addProcessingFlag(order, '⚠ Có thể trùng đơn LP-abc'), true);
  assert.equal(addProcessingFlag(order, '⚠ Có thể trùng đơn LP-abc'), false);
  assert.equal(addProcessingFlag(order, ''), false);
  for (let index = 0; index < 12; index += 1) addProcessingFlag(order, `ℹ ghi chú ${index}`);
  assert.equal(order.processingFlags.length, 8);
  assert.equal(removeProcessingFlag(order, 'ℹ ghi chú 11'), true);
  assert.equal(removeProcessingFlag(order, 'không có'), false);
  const noted = { ...manual({ address: 'abc' }), processingFlags: ['ℹ Giá landing 399.000đ khác bảng giá 447.000đ'] };
  const notes = orderProcessingNotes(noted);
  assert.equal(notes[0], 'ℹ Giá landing 399.000đ khác bảng giá 447.000đ');
  assert.ok(notes.length > 1, 'vẫn còn ghi chú dựng từ dữ liệu (địa chỉ không rõ)');
  assert.deepEqual(orderProcessingNotes(manual()).filter(note => /trùng|landing/.test(note)), []);
  assert.match(server, /processingNotes: orderProcessingNotes\(refreshed\)/);
  assert.match(server, /processingNotes: orderProcessingNotes\(updated\)/);
});

test('nhật ký: "tổng 189000đ" → "tổng 189.000đ" (tạo đơn tay, nhật ký tạo, xoá đơn)', () => {
  assert.equal(moneyText(189000), '189.000đ');
  assert.equal(moneyText(''), '0đ');
  // Hai chỗ: mục lịch sử "Tạo đơn tay: …" trên đơn và dòng nhật ký "Tạo đơn #… cho …".
  assert.equal(server.split(', tổng ${moneyText(order.total)}.`').length - 1, 2);
  assert.match(server, /stampOrderCreated\(order, creator, \{ summary: `Tạo đơn tay: /);
  assert.match(server, /\(tổng \$\{moneyText\(removed\.total\)\}\) khỏi hệ thống\.`/);
  assert.doesNotMatch(server, /tổng \$\{order\.total\}đ/);
  assert.doesNotMatch(server, /tổng \$\{Number\(removed\.total\) \|\| 0\}đ/);
});
