import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Đơn Zalo (13/10): Import tệp "Danh sách đơn hàng" của Zalo ở Đơn hàng → chỉ giữ các cột
// chủ shop chọn (đúng tên, đúng dữ liệu), bỏ cột còn lại, nguồn đơn "Zalo".
// Như các tệp *-web.test.mjs khác: cắt hàm cấp ngoài cùng của app.js rồi chạy trong vm.
const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const fn = name => {
  const start = web.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `không tìm thấy hàm ${name}`);
  const end = web.indexOf('\n}\n', start);
  return web.slice(start, end + 3);
};
const constant = name => web.match(new RegExp(`\\nconst ${name} = [^\\n]+\\n`))[0];
const plain = value => JSON.parse(JSON.stringify(value));

const zaloHeaders = ['Số thứ tự', 'Mã đơn hàng', 'Ngày tạo đơn hàng', 'Ngày cập nhật đơn hàng', 'Tên khách hàng', 'Số điện thoại', 'Thành phố', 'Quận', 'Phường', 'Địa chỉ', 'Phí vận chuyển', 'Tổng khuyến mãi', 'Điểm tích lũy đã dùng', 'Tiền giảm từ điểm', 'Tổng giá', 'Trạng thái đơn hàng', 'Phương thức thanh toán', 'Trạng thái thanh toán', 'Ghi chú', 'Tên sản phẩm', 'Mã SKU', 'Số lượng', 'Đơn giá', 'Thành tiền', 'Khối lượng (g)'];
const zaloRows = [
  ['1', '#QKMVnNtqI5', '13/10/2026, 14:08', '13/10/2026, 14:08', 'Nguyễn Thương', '0915997245', 'Tỉnh Quảng Bình', 'Thành Phố Đồng Hới', 'Phường Phú Hải', 'Đường Lưu Hữu Phước', '30000', '36540', '0', '0', '137460', 'Chờ xác nhận', 'COD', 'Chưa thanh toán', '', 'Granola Rạng Rỡ Tươi Tắn 350 g', 'GRA-VANG-H350', '1', '174000', '174000', '400'],
  ['9', '#6ftOsIqeE1', '09/10/2026, 12:19', '09/10/2026, 12:19', 'Lý Đại Dũng', '0345536236', 'Tỉnh Bình Dương', 'Thành phố Thủ Dầu Một', 'Phường Phú Hòa', '487 Lê Hồng Phong', '30000', '138900', '0', '0', '324100', 'Chờ xác nhận', 'COD', 'Chưa thanh toán', 'Gọi trước', 'HẠT AN LÀNH', 'MIX5-H420', '1', '289000', '289000', '0'],
  ['', '#6ftOsIqeE1', '09/10/2026, 12:19', '09/10/2026, 12:19', 'Lý Đại Dũng', '0345536236', 'Tỉnh Bình Dương', 'Thành phố Thủ Dầu Một', 'Phường Phú Hòa', '487 Lê Hồng Phong', '', '', '', '', '', 'Chờ xác nhận', 'COD', 'Chưa thanh toán', '', 'Granola Không Chiên Vẫn Ngon 450 g', 'GRA-XANH-Z450', '1', '174000', '174000', '450']
];
const kept = ['Số thứ tự', 'Mã đơn hàng', 'Ngày tạo đơn hàng', 'Tên khách hàng', 'Số điện thoại', 'Thành phố', 'Quận', 'Phường', 'Địa chỉ', 'Tổng khuyến mãi', 'Tổng giá', 'Ghi chú', 'Mã SKU', 'Số lượng', 'Thành tiền'];

function zaloContext() {
  const context = {
    orderData: { headers: [], rows: [] },
    orderPanelsDirty: new Set(),
    stages: [],
    showOrderStage: stage => context.stages.push(stage),
    getRecommendedOrderStage: () => 'import',
    commitOrderData: () => {},
    normalizeImportedValue: value => String(value ?? '').trim()
  };
  vm.createContext(context);
  vm.runInContext([
    "let orderData = { headers: [], rows: [] };",
    "const orderSourceHeader = 'Nguồn đơn';", "const orderDateHeader = 'Ngày';",
    constant('zaloSourceLabel'), constant('zaloKeptColumns'),
    ...['normalizeColumnName', 'ensureOrderSourceColumn', 'isZaloOrderSheet', 'keepZaloColumns', 'applyImportedRecords', 'parseOrderRowDate'].map(fn),
    'globalThis.api = { isZaloOrderSheet, keepZaloColumns, applyImportedRecords, parseOrderRowDate, getOrderData: () => orderData };'
  ].join('\n'), context);
  return context;
}

test('nhận ra tệp đơn Zalo theo tên cột; tệp Pancake / bảng chuẩn thì không', () => {
  const { api } = zaloContext();
  assert.equal(api.isZaloOrderSheet(zaloHeaders), true);
  assert.equal(api.isZaloOrderSheet(['Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Địa chỉ', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá']), false);
});

test('chỉ giữ đúng 15 cột Zalo đã chọn, tên cột và dữ liệu giữ nguyên', () => {
  const { api } = zaloContext();
  const zalo = api.keepZaloColumns(zaloHeaders, zaloRows);
  assert.deepEqual(plain(zalo.headers), kept);
  assert.deepEqual(plain(zalo.rows[0]), ['1', '#QKMVnNtqI5', '13/10/2026, 14:08', 'Nguyễn Thương', '0915997245', 'Tỉnh Quảng Bình', 'Thành Phố Đồng Hới', 'Phường Phú Hải', 'Đường Lưu Hữu Phước', '36540', '137460', '', 'GRA-VANG-H350', '1', '174000']);
  // Dòng thứ hai của đơn nhiều sản phẩm: STT, tiền đơn để trống như trong tệp.
  assert.deepEqual(plain(zalo.rows[2]), ['', '#6ftOsIqeE1', '09/10/2026, 12:19', 'Lý Đại Dũng', '0345536236', 'Tỉnh Bình Dương', 'Thành phố Thủ Dầu Một', 'Phường Phú Hòa', '487 Lê Hồng Phong', '', '', '', 'GRA-XANH-Z450', '1', '174000']);
});

test('Import tệp Zalo: bảng gồm Nguồn đơn "Zalo" + 15 cột Zalo; ngày lọc theo "Ngày tạo đơn hàng"', () => {
  const { api } = zaloContext();
  const zalo = api.keepZaloColumns(zaloHeaders, zaloRows);
  api.applyImportedRecords(zalo.headers, zalo.rows, 'Zalo');
  const data = api.getOrderData();
  assert.deepEqual(plain(data.headers), ['Nguồn đơn', ...kept]);
  assert.deepEqual(plain(data.rows.map(row => row[0])), ['Zalo', 'Zalo', 'Zalo']);
  const ordered = api.parseOrderRowDate(data.rows[1], data);
  assert.deepEqual([ordered.getFullYear(), ordered.getMonth() + 1, ordered.getDate(), ordered.getHours(), ordered.getMinutes()], [2026, 10, 9, 12, 19]);
});

test('Import tệp Zalo dừng ở Nhập dữ liệu; đơn hệ thống gộp vào thêm cột "Ngày" trống thì dòng Zalo vẫn lấy "Ngày tạo đơn hàng"', () => {
  const context = zaloContext();
  const { api } = context;
  const zalo = api.keepZaloColumns(zaloHeaders, zaloRows);
  context.getRecommendedOrderStage = () => 'export';
  api.applyImportedRecords(zalo.headers, zalo.rows, 'Zalo', 'import');
  assert.deepEqual(plain(context.stages), ['import']);
  const data = { headers: ['Nguồn đơn', 'Ngày', ...kept], rows: [] };
  const zaloRow = ['Zalo', '', ...zalo.rows[0]];
  const landingRow = ['Landing page', '08/10 09:15', ...kept.map(() => '')];
  const day = row => { const date = api.parseOrderRowDate(row, data, new Date(2026, 9, 13, 15)); return [date.getMonth() + 1, date.getDate(), date.getHours()]; };
  assert.deepEqual(day(zaloRow), [10, 13, 14]);
  assert.deepEqual(day(landingRow), [10, 8, 9]);
});

test('Import thường vẫn ghi nguồn "Import"; Import gọi luồng Zalo trước; bộ lọc nguồn có Zalo', async () => {
  const { api } = zaloContext();
  api.applyImportedRecords(['Mã đơn hàng', 'Khách hàng'], [['P1', 'An']]);
  assert.equal(api.getOrderData().rows[0][0], 'Import');
  assert.match(web, /if \(isZaloOrderSheet\(result\.headers \|\| \[\]\)\) \{\n\s*const zalo = keepZaloColumns\(result\.headers, result\.rows \|\| \[\]\);\n\s*applyImportedRecords\(zalo\.headers, zalo\.rows, zaloSourceLabel, 'import'\);/);
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/<option value="Zalo">Zalo<\/option>/g) || []).length, 2);
});
