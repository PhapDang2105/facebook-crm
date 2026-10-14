import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
// Danh mục thử nạp TRƯỚC mọi thứ dưới app/ (file kho đọc danh mục, quà).
import './helpers/seed-catalog.mjs';
import AdmZip from 'adm-zip';
import { buildExportRows } from '../app/order-export.mjs';
import { parseXlsx } from '../app/xlsx-import.mjs';

// Tệp đơn dạng ID/SKU (14/10, "User_input.xlsx"): cột ID, NOTE, Khách hàng, …, SKU, Số lượng, Đơn giá; dòng
// sản phẩm thứ 2+ của đơn để trống ID và thông tin khách; SĐT là ô số (mất số 0). Import đổi sang cột chuẩn
// của bảng đơn rồi xử lý như đơn thường. Tên, SĐT giả; SKU, giá, địa chỉ hành chính như tệp thật.
const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const fn = name => {
  const start = web.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `không tìm thấy hàm ${name}`);
  const end = web.indexOf('\n}\n', start);
  return web.slice(start, end + 3);
};
const block = (from, to) => {
  const start = web.indexOf(from);
  const end = web.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `không tìm thấy đoạn ${from}`);
  return web.slice(start, end);
};
const plain = value => JSON.parse(JSON.stringify(value));

const storage = new Map();
const context = vm.createContext({
  carrierLabelFor: phone => (String(phone).startsWith('09') ? 'Viettel' : ''),
  orderImportHistory: [],
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
});
vm.runInContext([
  block('const orderSourceHeader = ', '\n/** Nhà mạng theo đầu số'),
  fn('normalizeColumnName'),
  block('const compactOrderColumns = ', '\nfunction isCompactOrderSheet('),
  fn('isCompactOrderSheet'), fn('compactOrderPhone'), fn('compactOrderSheetToTable'), fn('repairCompactOrderTable'),
  'this.api = { chatbotOrderHeaders, isCompactOrderSheet, compactOrderPhone, compactOrderSheetToTable, repairCompactOrderTable };'
].join('\n'), context);
const { api } = context;

const headers = ['ID', 'NOTE', 'Khách hàng', 'Số điện thoại', 'Địa chỉ', 'Phường/Xã', 'Quận/Huyện', 'Tỉnh', 'Sản phẩm', 'SKU', 'Số lượng', 'Đơn giá'];
const line = (product, sku, quantity, price) => ['', '', '', '', '', '', '', '', product, sku, quantity, price];
const records = [
  ['57477', '', 'Khách Một', '938000001', '37 Hồ Tùng Mậu, Phường Bình An, Thành phố Dĩ An, Bình Dương', 'Phường Bình An', 'Thành phố Dĩ An', 'Bình Dương', 'Granola / Phân Loại: 1 Túi Vàng KLT 350g', 'GRA-VANG-H350', '1', '189000'],
  ['57489', 'GTC 2, ok', 'Khách Hai', '934000002', '38 Lê Hồng Phong, Phường Đông Hải 1, Quận Hải An, Hải Phòng', 'Phường Đông Hải 1', 'Quận Hải An', 'Hải Phòng', 'Granola / Phân Loại: Combo 2 Granola Xanh', 'CB2-XANH-Z450', '1', '298000'],
  line('Quà Tặng LIVE', 'QUA-TANG-LIVE', '1', '0'),
  line('Bộ Qùa Tặng / Phân Loại: Bát gáo dừa', 'BGD', '1', '0'),
  ['CRM-fc000001', '', 'Khách Ba', '84971000003', '8 đường số 8, Phường 11, Quận 6, Hồ Chí Minh', 'Phường 11', 'Quận 6', 'Hồ Chí Minh', 'Granola / Phân Loại: Combo 3 Túi Vàng', 'CB3-VANGG+BGD+M', '1', '447000'],
  Array(12).fill('')
];

test('ô số kiểu "9.38377311E8", "57477.0" đọc ra như Excel hiện; số thập phân thật giữ nguyên', () => {
  const zip = new AdmZip();
  zip.addFile('xl/workbook.xml', Buffer.from('<workbook xmlns:r="r"><sheets><sheet name="Trang tính1" sheetId="1" r:id="rId1"/></sheets></workbook>'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<worksheet><sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>ID</t></is></c><c r="B1" t="inlineStr"><is><t>Số điện thoại</t></is></c><c r="C1" t="inlineStr"><is><t>Đơn giá</t></is></c><c r="D1" t="inlineStr"><is><t>Thuế</t></is></c></row>
    <row r="2"><c r="A2" t="n"><v>57477.0</v></c><c r="B2" t="n"><v>9.38377311E8</v></c><c r="C2"><v>189000.0</v></c><c r="D2"><v>0.08</v></c></row>
  </sheetData></worksheet>`));
  assert.deepEqual(parseXlsx(zip.toBuffer()).rows, [['57477', '938377311', '189000', '0.08']]);
});

test('nhận đúng tệp ID/SKU, không nhận bảng đơn chuẩn hay tệp Zalo', () => {
  assert.equal(api.isCompactOrderSheet(headers), true);
  assert.equal(api.isCompactOrderSheet(['Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Địa chỉ', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá']), false);
  assert.equal(api.isCompactOrderSheet(['Số thứ tự', 'Mã đơn hàng', 'Tên khách hàng', 'Số điện thoại', 'Mã SKU', 'Số lượng', 'Đơn giá']), false);
});

test('SĐT ô số được thêm số 0, đầu 84 đổi về 0, số đã đúng giữ nguyên', () => {
  assert.equal(api.compactOrderPhone('938377311'), '0938377311');
  assert.equal(api.compactOrderPhone('84938377311'), '0938377311');
  assert.equal(api.compactOrderPhone('0938377311'), '0938377311');
  assert.equal(api.compactOrderPhone(''), '');
});

test('đổi sang cột chuẩn: dòng không ID đi theo đơn trên, NOTE vào Ghi chú xử lý, Ngày = lúc Import', () => {
  const table = plain(api.compactOrderSheetToTable(headers, records, new Date(2026, 9, 14, 15, 5)));
  assert.deepEqual(table.headers, plain(api.chatbotOrderHeaders));
  assert.equal(table.orders, 3);
  assert.equal(table.rows.length, 5);
  const at = name => table.headers.indexOf(name);
  assert.deepEqual(table.rows.map(row => [row[at('Mã đơn hàng')], row[at('Số điện thoại')], row[at('Tỉnh/Thành phố')], row[at('Mã mẫu mã')], row[at('Đơn giá')], row[at('Ghi chú xử lý')]]), [
    ['57477', '0938000001', 'Bình Dương', 'GRA-VANG-H350', '189000', ''],
    ['57489', '0934000002', 'Hải Phòng', 'CB2-XANH-Z450', '298000', 'GTC 2, ok'],
    ['57489', '0934000002', 'Hải Phòng', 'QUA-TANG-LIVE', '0', ''],
    ['57489', '0934000002', 'Hải Phòng', 'BGD', '0', ''],
    ['CRM-fc000001', '0971000003', 'Hồ Chí Minh', 'CB3-VANGG+BGD+M', '447000', '']
  ]);
  assert.ok(table.rows.every(row => row[at('Nguồn đơn')] === 'Import' && row[at('Ngày')] === '14/10/2026 15:05'));
  assert.equal(table.rows[3][at('Khách hàng')], 'Khách Hai');
  assert.equal(table.rows[0][at('Nhà mạng')], 'Viettel');
});

test('file kho dựng từ bảng đã đổi như đơn thường: một đơn một STT, giá theo Đơn giá, quà không ghi trùng', () => {
  const table = plain(api.compactOrderSheetToTable(headers, records, new Date(2026, 9, 14, 15, 5)));
  const rows = buildExportRows(table);
  const orderStarts = rows.filter(row => row[0] !== '');
  assert.equal(orderStarts.length, 3);
  assert.deepEqual(orderStarts.map(row => [row[30], row[33]]), [['0938000001', 'Khách Một'], ['0934000002', 'Khách Hai'], ['0971000003', 'Khách Ba']]);
  const paid = rows.reduce((sum, row) => sum + (Number(row[21]) || 0) * (Number(row[22]) || 0), 0);
  assert.equal(paid, 189000 + 298000 + 447000);
  // Đơn 2: bát gáo dừa có sẵn trong tệp, không thêm dòng thứ hai.
  const second = rows.slice(rows.indexOf(orderStarts[1]), rows.indexOf(orderStarts[2]));
  assert.equal(second.filter(row => row[19] === 'BGD').length, 1);
});

test('bảng đã lưu từ lần Import bằng bản cũ (cột ID/SKU, đơn hệ thống mất mã) được sửa lúc tải trang', () => {
  // Như bảng trên trình duyệt chủ shop 14/10: cột tệp + Nguồn đơn/Ngày/Nhà mạng/Ghi chú xử lý, đơn landing gộp vào không mã.
  const broken = {
    headers: ['Nguồn đơn', 'Ngày', 'ID', 'NOTE', 'Khách hàng', 'Số điện thoại', 'Nhà mạng', 'Địa chỉ', 'Phường/Xã', 'Quận/Huyện', 'Tỉnh', 'Sản phẩm', 'SKU', 'Số lượng', 'Đơn giá', 'Ghi chú xử lý'],
    rows: [
      ['Import', '', '57489', 'GTC 2', 'Khách Hai', '934000002', '', '38 Lê Hồng Phong', 'Phường Đông Hải 1', 'Quận Hải An', 'Hải Phòng', 'Combo 2 Xanh', 'CB2-XANH-Z450', '1', '298000', ''],
      ['Import', '', '', '', '', '', '', '', '', '', '', 'Quà Tặng LIVE', 'QUA-TANG-LIVE', '1', '0', ''],
      ['Landing page', '14/10 15:03', '', '', 'Khách landing', '0965000000', 'Viettel', '12 Lê Lợi', '', '', '', 'Túi Xanh', '', '1', '149000', '']
    ]
  };
  const history = [{ importedAt: '2026-10-14T08:20:00.000Z', headers: broken.headers }];
  const fixed = plain(api.repairCompactOrderTable(broken, history));
  assert.deepEqual(fixed.headers, plain(api.chatbotOrderHeaders));
  const at = name => fixed.headers.indexOf(name);
  assert.equal(fixed.rows.length, 2);
  assert.deepEqual(fixed.rows.map(row => [row[at('Nguồn đơn')], row[at('Mã đơn hàng')], row[at('Khách hàng')], row[at('Số điện thoại')], row[at('Mã mẫu mã')], row[at('Ghi chú xử lý')]]), [
    ['Import', '57489', 'Khách Hai', '0934000002', 'CB2-XANH-Z450', 'GTC 2'],
    ['Import', '57489', 'Khách Hai', '0934000002', 'QUA-TANG-LIVE', '']
  ]);
  assert.match(fixed.rows[0][at('Ngày')], /^14\/10\/2026 \d\d:20$/);
  assert.deepEqual(JSON.parse(storage.get('crm-orders')), fixed);
  // Bảng chuẩn thì giữ nguyên.
  const normal = { headers: [...api.chatbotOrderHeaders], rows: [] };
  assert.equal(api.repairCompactOrderTable(normal, history), normal);
});
