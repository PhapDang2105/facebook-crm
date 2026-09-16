import test from 'node:test';
import assert from 'node:assert/strict';
import { customerNote, isProcessingNote, processingNotes, stripProcessingNotes } from '../app/order-notes.mjs';

test('đơn bỏ dở thiếu địa chỉ, máy tự điền sản phẩm, số hay bom: ghi chú nêu đủ việc phải làm', () => {
  const notes = processingNotes({
    address: 'Chưa có địa chỉ', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }],
    phoneWarning: { level: 'high', label: 'Hay bom hàng, gọi xác nhận trước khi giao', sources: ['Hệ thống Pancake: bom 5/12 đơn (42%)'] },
    landing: { incomplete: true, submittedAt: '2026-09-16 02:08:42', page: 'https://granola.giotnang.vn/', autoFilled: { product: 'Granola Túi Xanh 450g x2 (mặc định theo chiến dịch 1202, 18 đơn)' }, posId: '51938', formIds: ['0368419478@2026-09-16 01:50:00'], externalId: '0368419478@2026-09-16 02:08:42' }
  });
  assert.deepEqual(notes, [
    '⏳ Khách bỏ dở form lúc 02:08 16/09, chưa bấm gửi: gọi xác nhận đơn',
    '⚠ Chưa có địa chỉ giao hàng',
    '🤖 Tự điền sản phẩm: Granola Túi Xanh 450g x2 (mặc định theo chiến dịch 1202, 18 đơn)',
    '☎ Hay bom hàng, gọi xác nhận trước khi giao: Hệ thống Pancake: bom 5/12 đơn (42%)',
    'ℹ Khách gửi form 2 lần, đã gộp thành một đơn'
  ]);
});

test('địa chỉ thiếu cấp, sản phẩm chưa khớp, địa chỉ trùng tên: nêu đúng cấp thiếu', () => {
  const notes = processingNotes({ address: 'Bắc Kạn', street: '', ward: '', district: '', province: 'Bắc Kạn', products: [], locationConfidence: 'partial', landing: {} });
  assert.deepEqual(notes, ['⚠ Địa chỉ thiếu số nhà/đường, phường/xã, quận/huyện', '⚠ Chưa chọn sản phẩm']);
  const ambiguous = processingNotes({ address: '12 Lê Lợi, Phường 1', street: '12 Lê Lợi', ward: 'Phường 1', district: '', province: 'TP Hồ Chí Minh', locationConfidence: 'ambiguous', products: [{ name: 'Combo lạ', sku: '', quantity: 1 }] });
  assert.deepEqual(ambiguous, ['⚠ Địa chỉ thiếu quận/huyện', '⚠ Địa chỉ trùng tên nhiều nơi, xác nhận lại với khách', '⚠ Sản phẩm chưa khớp danh mục: Combo lạ']);
  const unreadable = processingNotes({ address: 'Thì địa chỉ trên rồi', street: '', ward: '', district: '', province: '', locationConfidence: 'none', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1 }] });
  assert.deepEqual(unreadable, ['⚠ Địa chỉ không đọc được tỉnh/quận/phường ("Thì địa chỉ trên rồi"), hỏi lại khách']);
  // Đơn đủ: không có gì để ghi.
  assert.deepEqual(processingNotes({ address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', street: '12 Lê Lợi', ward: 'Phường Bến Nghé', district: 'Quận 1', province: 'TP Hồ Chí Minh', locationConfidence: 'exact', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1 }] }), []);
});

test('tách lời khách khỏi mẩu máy thêm; file xuất bỏ ghi chú xử lý', () => {
  assert.equal(customerNote({ note: 'Giao giờ hành chính · Nguồn: fb · Chiến dịch: 1202 · Tự điền, cần duyệt trước khi giao' }), 'Giao giờ hành chính');
  assert.equal(customerNote({ note: 'Đơn từ landing page.' }), '');
  assert.equal(customerNote({ note: 'select_1: 1 Túi Dùng Thử: 1 Túi 174k + 15k phí ship, · Giao chiều' }), 'Giao chiều', 'ô lựa chọn form không phải lời khách');
  // Note POS nhiều dòng (đơn đã đồng bộ trước khi lọc): bỏ address/select, giữ lời khách.
  assert.equal(customerNote({ note: 'address: 381/17 lò lu,\r\nselect_1: 1 Túi Dùng Thử: 1 Túi 174k + 15k phí ship,\r\nGọi trước khi giao' }), 'Gọi trước khi giao');
  assert.equal(stripProcessingNotes('⏳ Khách bỏ dở form · ⚠ Chưa có địa chỉ giao hàng · Quà: 1 túi · Giao buổi sáng'), 'Quà: 1 túi · Giao buổi sáng');
  assert.equal(isProcessingNote('☎ Hay bom hàng'), true);
  assert.equal(isProcessingNote('Giao buổi sáng'), false);
});
