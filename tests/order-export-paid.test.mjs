import test from 'node:test';
import assert from 'node:assert/strict';
// Danh mục thử nạp TRƯỚC mọi thứ dưới app/.
import './helpers/seed-catalog.mjs';
import { buildExportRows, splitSkuForExport } from '../app/order-export.mjs';

// Vòng rà 28/09 (V4): file xuất kho phải khớp tổng đơn CRM — giá khách trả, ship theo cờ đơn, quà bám đuổi.
const headers = ['Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Địa chỉ', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá', 'Ghi chú'];
const ADDRESS = '12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP.HCM';
const row = (id, sku, quantity, price, { address = ADDRESS, note = '', name = sku } = {}) => [id, 'A', '0385805790', address, name, sku, String(quantity), String(price), note];
const lines = rows => rows.map(item => `${item[19]}x${item[21]}@${item[22]}`);
const total = rows => rows.reduce((sum, item) => sum + Number(item[21]) * Number(item[22]), 0);

test('V4: dùng giá khách trả ở ô Đơn giá (giá gõ tay, ship nhân viên thu thêm) thay vì tính lại theo bộ giá', () => {
  // Nhân viên tạo 2 Xanh giá lẻ 174k (không giảm): trước đây file ra 149k × 2.
  assert.deepEqual(lines(buildExportRows({ headers, rows: [row('CB-st1', 'GRA-XANH-Z450', 2, 174000)] })), ['GRA-XANH-Z450x2@174000']);
  // 2 Xanh + ship 30k nhân viên thu: bảng hiện 164k/túi (149k + 15k) → file cộng đúng 328k.
  const shipped = buildExportRows({ headers, rows: [row('CB-st7', 'GRA-XANH-Z450', 2, 164000)] });
  assert.equal(total(shipped), 328000);
  // Ô trống/0 → tính theo bộ giá như cũ (1 túi = giá lẻ + ship).
  assert.deepEqual(lines(buildExportRows({ headers, rows: [row('CB-x', 'GRA-XANH-Z450', 1, 0)] })), ['GRA-XANH-Z450x1@189000']);
});

test('V4: đơn dùng thử "(Freeship) " không cộng ship vào giá khi tính theo bộ giá; giá khách trả 174k giữ nguyên', () => {
  const address = `(Freeship) ${ADDRESS}`;
  assert.deepEqual(lines(buildExportRows({ headers, rows: [row('CB-t1', 'GRA-XANH-Z450', 1, 0, { address })] })), ['GRA-XANH-Z450x1@174000']);
  assert.deepEqual(lines(buildExportRows({ headers, rows: [row('CB-t2', 'GRA-XANH-Z450', 1, 174000, { address })] })), ['GRA-XANH-Z450x1@174000']);
});

test('V4: quà bát gáo dừa bám đuổi (ghi chú đơn) → dòng BGD cho giỏ đúng 2 túi; giỏ đã sửa khác 2 túi thì không', () => {
  const note = 'Khách ghi: Tạo tự động từ xác nhận của chatbot · Ưu đãi bám đuổi combo 2 túi: tặng Bộ bát gáo dừa – ưu đãi bám đuổi.';
  const two = buildExportRows({ headers, rows: [row('CB-p1', 'GRA-XANH-Z450', 2, 149000, { note })] });
  assert.deepEqual(lines(two), ['GRA-XANH-Z450x2@149000', 'BGDx1@0']);
  assert.equal(two[1][24], 10);
  const mixed = buildExportRows({ headers, rows: [row('CB-p2', 'GRA-XANH-Z450', 1, 149000, { note }), row('CB-p2', 'GRA-NAU-Z350', 1, 144000, { note })] });
  assert.deepEqual(lines(mixed), ['GRA-XANH-Z450x1@149000', 'GRA-NAU-Z350x1@144000', 'BGDx1@0']);
  const one = buildExportRows({ headers, rows: [row('CB-p3', 'GRA-XANH-Z450', 1, 189000, { note })] });
  assert.deepEqual(lines(one), ['GRA-XANH-Z450x1@189000']);
});

test('nhẹ (b): SKU cũ CB10-XANH (đã đổi thành CB10-XANH-G35) không bị bung thành 20 túi; ký hiệu Pancake CB2-XANH vẫn là 2 túi', () => {
  const legacy = buildExportRows({ headers, rows: [row('CB-l1', 'CB10-XANH', 2, 179000, { name: 'Combo 10 gói Xanh' })] });
  assert.deepEqual(lines(legacy), ['CB10-XANH-G35x2@179000']);
  assert.equal(total(legacy), 358000);
  assert.deepEqual(splitSkuForExport('CB2-XANH', 1, 298000, true, 'Granola Túi Xanh 450g').map(item => `${item.sku}x${item.quantity}`), ['GRA-XANH-Z450x2']);
});
