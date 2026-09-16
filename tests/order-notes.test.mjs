import test from 'node:test';
import assert from 'node:assert/strict';
import { customerNote, isProcessingNote, processingNotes, shortWarning, stripProcessingNotes } from '../app/order-notes.mjs';

test('đơn bỏ dở thiếu địa chỉ, máy tự điền sản phẩm, số hay bom: ghi chú nêu đủ việc phải làm', () => {
  const notes = processingNotes({
    address: 'Chưa có địa chỉ', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }],
    phoneWarning: { level: 'high', label: 'Hay bom hàng, gọi xác nhận trước khi giao', sources: ['Hệ thống Pancake: bom 5/12 đơn (42%)'] },
    landing: { incomplete: true, submittedAt: '2026-09-16 02:08:42', page: 'https://granola.giotnang.vn/', autoFilled: { product: 'Granola Túi Xanh 450g x2 (mặc định theo chiến dịch 1202, 18 đơn)' }, posId: '51938', externalId: '0368419478@2026-09-16 02:08:42' }
  });
  assert.deepEqual(notes, [
    '⏳ Bỏ dở form 02:08 16/09, gọi xác nhận',
    '⚠ Chưa có địa chỉ',
    '🤖 Tự điền SP: Granola Túi Xanh 450g x2 (theo chiến dịch)',
    '☎ Hay bom hàng: 5/12 đơn (42%), gọi xác nhận'
  ]);
});

test('địa chỉ thiếu cấp, sản phẩm chưa khớp, địa chỉ trùng tên: nêu đúng cấp thiếu', () => {
  const notes = processingNotes({ address: 'Bắc Kạn', street: '', ward: '', district: '', province: 'Bắc Kạn', products: [], locationConfidence: 'partial', landing: {} });
  assert.deepEqual(notes, ['⚠ Thiếu số nhà/đường, phường/xã, quận/huyện', '⚠ Chưa chọn sản phẩm']);
  const ambiguous = processingNotes({ address: '12 Lê Lợi, Phường 1', street: '12 Lê Lợi', ward: 'Phường 1', district: '', province: 'TP Hồ Chí Minh', locationConfidence: 'ambiguous', products: [{ name: 'Combo lạ', sku: '', quantity: 1 }] });
  assert.deepEqual(ambiguous, ['⚠ Thiếu quận/huyện', '⚠ Địa chỉ trùng tên nhiều nơi, hỏi lại', '⚠ Sản phẩm lạ: Combo lạ']);
  const unreadable = processingNotes({ address: 'Thì địa chỉ trên rồi', street: '', ward: '', district: '', province: '', locationConfidence: 'none', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1 }] });
  assert.deepEqual(unreadable, ['⚠ Địa chỉ không rõ ba cấp: "Thì địa chỉ trên rồi"']);
  assert.equal(shortWarning({ level: 'watch', sources: ['Hệ thống Pancake: bom 3/12 đơn (25%), POS có đếm cảnh báo'] }), 'Từng không nhận hàng: 3/12 đơn (25%), gọi xác nhận');
  assert.equal(shortWarning({ level: 'high', sources: ['Shop mình: hoàn/huỷ 2 đơn, giao thành công 1'] }), 'Hay bom hàng: hoàn 2 đơn ở shop, gọi xác nhận');
  assert.equal(shortWarning({ level: 'block', sources: ['POS đã chặn khách này'] }), 'POS đã chặn số này, gọi xác nhận');
  // Đơn đủ: không có gì để ghi.
  assert.deepEqual(processingNotes({ address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', street: '12 Lê Lợi', ward: 'Phường Bến Nghé', district: 'Quận 1', province: 'TP Hồ Chí Minh', locationConfidence: 'exact', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1 }] }), []);
});

test('tách lời khách khỏi mẩu máy thêm; file xuất bỏ ghi chú xử lý', () => {
  assert.equal(customerNote({ note: 'Giao giờ hành chính · Nguồn: fb · Chiến dịch: 1202 · Tự điền, cần duyệt trước khi giao' }), 'Giao giờ hành chính');
  assert.equal(customerNote({ note: 'Đơn từ landing page.' }), '');
  assert.equal(customerNote({ note: 'Tạo tự động từ xác nhận của chatbot.' }), '');
  assert.equal(customerNote({ note: 'select_1: 1 Túi Dùng Thử: 1 Túi 174k + 15k phí ship, · Giao chiều' }), 'Giao chiều', 'ô lựa chọn form không phải lời khách');
  // Note POS nhiều dòng (đơn đã đồng bộ trước khi lọc): bỏ address/select, giữ lời khách.
  assert.equal(customerNote({ note: 'address: 381/17 lò lu,\r\nselect_1: 1 Túi Dùng Thử: 1 Túi 174k + 15k phí ship,\r\nGọi trước khi giao' }), 'Gọi trước khi giao');
  assert.equal(stripProcessingNotes('⏳ Khách bỏ dở form · ⚠ Chưa có địa chỉ giao hàng · Quà: 1 túi · Giao buổi sáng'), 'Quà: 1 túi · Giao buổi sáng');
  assert.equal(isProcessingNote('☎ Hay bom hàng'), true);
  assert.equal(isProcessingNote('Giao buổi sáng'), false);
});
