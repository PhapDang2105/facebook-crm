import assert from 'node:assert/strict';
import {
  PRODUCT_RELATIONS,
  buildExportRows,
  isInvalidOrderAddress,
  normalizeExportLocation,
  resolveProductRelation,
  splitSkuForExport,
  exportPreviewStreets
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

console.log('PASS: order export single/combo relations');
