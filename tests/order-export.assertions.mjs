import assert from 'node:assert/strict';
import {
  PRODUCT_RELATIONS,
  buildExportRows,
  isInvalidOrderAddress,
  normalizeExportLocation,
  resolveProductRelation,
  splitSkuForExport,
  exportPreviewStreets,
  exportedOrderData
} from '../app/order-export.mjs';

assert.ok(PRODUCT_RELATIONS.every(relation => ['single', 'combo'].includes(relation.type)));
assert.equal(resolveProductRelation('CB2-HT-YM-T500', 'CÁN DẸT 1kg').type, 'single');
assert.equal(resolveProductRelation('CB-YM-DET+VO', 'CÁN DẸT/VỠ 1KG').type, 'combo');
assert.notEqual(
  resolveProductRelation('CB2-HT-YM-T500', 'CÁN DẸT 1KG').id,
  resolveProductRelation('CB2-HT-YM-T500', 'CÁN DẸT 1KG + SHIP').id
);
assert.notEqual(
  resolveProductRelation('CB2-HT-YM-T500', 'CÁN DẸT 1KG').id,
  resolveProductRelation('CB4-HT-YM-T500', 'CÁN DẸT 2KG').id
);

assert.deepEqual(
  splitSkuForExport('CB2-HT-YM-T500', 3, 393000, false, 'Yến Mạch Úc / [CÁN DẸT] CB 1kg'),
  [
    { sku: 'HT-YM-T500', quantity: 6, price: 65500 },
    { sku: 'HU-300ML', quantity: 3, price: 0 }
  ]
);

assert.deepEqual(
  splitSkuForExport('CB-YM-DET+VO', 3, 348000, false, 'Yến Mạch CÁN DẸT/CÁN VỠ 1KG'),
  [
    { sku: 'HT-YM-T500', quantity: 3, price: 58000 },
    { sku: 'YM-VO-T500', quantity: 3, price: 58000 },
    { sku: 'HU-300ML', quantity: 3, price: 0 }
  ]
);

const headers = ['Mã đơn hàng', 'Mã mẫu mã', 'Số lượng', 'Đơn giá', 'Sản phẩm', 'Số điện thoại'];
const rows = buildExportRows({
  headers,
  rows: [['DH-1', 'CB2-HT-YM-T500', '3', '393000', 'Yến Mạch Úc / [CÁN DẸT] CB 1kg', '0901234567']]
});
assert.deepEqual(rows.map(row => [row[19], row[21]]), [['HT-YM-T500', 6], ['HU-300ML', 3]]);
// Thuế 8% điền ở mọi dòng sản phẩm, không chỉ dòng đầu của đơn.
assert.deepEqual(rows.map(row => row[28]), ['8%', '8%']);

assert.equal(normalizeExportLocation('Hồ Chí Minh'), 'TP Hồ Chí Minh');
assert.equal(normalizeExportLocation('Thành phố Thanh Hoá'), 'Thành phố Thanh Hóa');
assert.equal(normalizeExportLocation('Hà Nội'), 'Hà Nội');

const locationRows = buildExportRows({
  headers: [...headers, 'Tỉnh/Thành phố', 'Quận/Huyện', 'Phường/Xã'],
  rows: [[
    'DH-2', 'GRA-XANH-Z450', '1', '189000', 'Granola Xanh', '0901234567',
    'Hồ Chí Minh', 'Thành phố Thanh Hoá', 'Phường Đông Sơn'
  ]]
});
assert.deepEqual(locationRows[0].slice(36, 39), ['TP Hồ Chí Minh', 'Thành phố Thanh Hóa', 'Phường Đông Sơn']);

// Đơn chatbot chỉ có cột Địa chỉ: ba cấp được đọc từ đó.
const addressOnlyRows = buildExportRows({
  headers: [...headers, 'Địa chỉ', 'Tỉnh/Thành phố', 'Quận/Huyện', 'Phường/Xã'],
  rows: [['DH-5', 'GRA-XANH-Z450', '1', '189000', 'Granola Xanh', '0901234567', '45 Lê Lợi, P. Đa Kao, Q1, HCM', '', '', '']]
});
assert.deepEqual(addressOnlyRows[0].slice(35, 39), ['45 Lê Lợi, P. Đa Kao, Q1, HCM', 'TP Hồ Chí Minh', 'Quận 1', 'Phường Đa Kao']);

assert.equal(isInvalidOrderAddress('  gxn cần chuẩn hóa'), true);
assert.equal(isInvalidOrderAddress('12 Nguyễn Huệ'), false);

const partitionedRows = buildExportRows({
  headers: [...headers, 'Địa chỉ'],
  rows: [
    ['DH-3', 'GRA-XANH-Z450', '1', '189000', 'Granola Xanh', '0901234567', 'GXN cần chuẩn hóa'],
    ['DH-4', 'GRA-XANH-Z450', '1', '189000', 'Granola Xanh', '0901234568', '12 Nguyễn Huệ']
  ]
});
assert.equal(partitionedRows.length, 1);
assert.equal(partitionedRows[0][34], '0901234568');
// Bảng xem trước: cột Địa chỉ chỉ còn số nhà/đường; file vẫn giữ nguyên địa chỉ đầy đủ.
const fullRows = buildExportRows({ headers: [...headers, 'Địa chỉ'], rows: [['DH-5', 'GRA-XANH-Z450', '1', '189000', 'Granola Xanh', '0901234569', '12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP.HCM']] });
assert.equal(fullRows[0][35], '12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP.HCM');
assert.deepEqual(exportPreviewStreets(fullRows), ['12 Nguyễn Huệ']);


// ===== Kiểm tra ba cấp trước khi xuất =====
{
  const headers3 = ['Mã đơn hàng', 'Mã mẫu mã', 'Số lượng', 'Đơn giá', 'Sản phẩm', 'Số điện thoại', 'Khách hàng', 'Địa chỉ', 'Tỉnh/Thành phố', 'Quận/Huyện', 'Phường/Xã'];
  const good = ['DH-A', 'GRA-XANH-Z450', '1', '189000', 'Granola Xanh', '0901234561', 'An', '12 Nguyễn Huệ', 'TP Hồ Chí Minh', 'Quận 1', 'Phường Bến Nghé'];
  const wrongWard = ['DH-B', 'GRA-XANH-Z450', '2', '189000', 'Granola Xanh', '0901234562', 'Bình', '5 Lê Lợi', 'TP Hồ Chí Minh', 'Quận 1', 'Phường Không Có'];
  const noWard = ['DH-C', 'GRA-XANH-Z450', '1', '189000', 'Granola Xanh', '0901234563', 'Cúc', 'Hà Nội', 'Hà Nội', '', ''];
  const checked = buildExportRows({ headers: headers3, rows: [good, wrongWard, noWard] });
  assert.equal(checked.locationCheck.checked, 3);
  assert.deepEqual(checked.locationCheck.invalid.map(item => item.sourceOrderId), ['DH-B', 'DH-C'], 'đơn sai phường và đơn thiếu cấp bị báo');
  assert.match(checked.locationCheck.invalid[0].issues.join(' '), /Phường\/xã "Phường Không Có" không thuộc Quận 1/);
  assert.match(checked.locationCheck.invalid[1].issues.join(' '), /Thiếu quận\/huyện/);
  assert.equal(checked.locationCheck.invalid[0].orderNumber, 2, 'số thứ tự trong file để tô dòng xem trước');
  assert.equal(checked.filter(row => row[0]).length, 3, 'xem trước vẫn dựng đủ ba đơn');

  const skipped = buildExportRows({ headers: headers3, rows: [good, wrongWard, noWard] }, { skipInvalidLocations: true });
  assert.deepEqual(skipped.map(row => row[0]).filter(Boolean), [1], 'chỉ đơn chuẩn vào file, STT liền mạch');
  assert.equal(skipped[0][36], 'TP Hồ Chí Minh');
  assert.equal(skipped[0][38], 'Phường Bến Nghé');
  assert.equal(skipped.locationCheck.invalid.length, 2);
  const kept = exportedOrderData({ headers: headers3, rows: [good, wrongWard, noWard] }, skipped);
  assert.deepEqual(kept.rows.map(row => row[0]), ['DH-A'], 'tệp khách hàng chỉ ghi đơn đã vào file');
}
