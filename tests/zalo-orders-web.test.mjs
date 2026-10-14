import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
// Danh mục thử nạp TRƯỚC mọi thứ dưới app/ (file kho đọc danh mục, quà).
import './helpers/seed-catalog.mjs';
import { buildExportRows, parseGiftSkus } from '../app/order-export.mjs';

// Đơn Zalo (13/10): trang riêng Đơn hàng → Đơn Zalo, tách hẳn bảng đơn của Nhập/Xử lý dữ liệu.
// Import tệp "Danh sách đơn hàng" của Zalo chỉ giữ 15 cột chủ shop chọn. Tiền: mức giảm của đơn
// (Tổng khuyến mãi / Thành tiền) từ mức nhân viên nhập (mặc định 21%) trở lên → giữ giá Zalo,
// thấp hơn → tính lại theo mức nhân viên nhập; còn lại như đơn thường và tự vào Xuất dữ liệu.
// Như các tệp *-web.test.mjs khác: cắt hàm cấp ngoài cùng của app.js rồi chạy trong vm.
const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const fn = name => {
  const start = web.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `không tìm thấy hàm ${name}`);
  const end = web.indexOf('\n}\n', start);
  return web.slice(start, end + 3);
};
const constant = name => web.match(new RegExp(`\\nconst ${name} = [^\\n]+\\n`))[0];
const plain = value => JSON.parse(JSON.stringify(value));

// Cùng số tiền, SKU, địa chỉ hành chính với tệp Zalo 13/10; tên và số điện thoại là giả.
const zaloHeaders = ['Số thứ tự', 'Mã đơn hàng', 'Ngày tạo đơn hàng', 'Ngày cập nhật đơn hàng', 'Tên khách hàng', 'Số điện thoại', 'Thành phố', 'Quận', 'Phường', 'Địa chỉ', 'Phí vận chuyển', 'Tổng khuyến mãi', 'Điểm tích lũy đã dùng', 'Tiền giảm từ điểm', 'Tổng giá', 'Trạng thái đơn hàng', 'Phương thức thanh toán', 'Trạng thái thanh toán', 'Ghi chú', 'Tên sản phẩm', 'Mã SKU', 'Số lượng', 'Đơn giá', 'Thành tiền', 'Khối lượng (g)'];
const order = (stt, id, date, name, phone, [province, district, ward, street], promo, total, note, sku, quantity, amount) =>
  [stt, id, date, date, name, phone, province, district, ward, street, stt ? '30000' : '', promo, stt ? '0' : '', stt ? '0' : '', total, 'Chờ xác nhận', 'COD', 'Chưa thanh toán', note, 'Tên Zalo', sku, quantity, amount, amount, '0'];
const zaloRows = [
  order('1', '#Z1', '13/10/2026, 14:08', 'Khách Một', '0901000001', ['Tỉnh Quảng Bình', 'Thành Phố Đồng Hới', 'Phường Phú Hải', 'Đường Lưu Hữu Phước'], '36540', '137460', '', 'GRA-VANG-H350', '1', '174000'),
  order('2', '#Z2', '13/10/2026, 13:58', 'Khách Hai', '+84901000002', ['Tỉnh Khánh Hòa', 'Thành phố Nha Trang', 'Phường Xương Huân', '48 Nguyễn Bỉnh Khiêm'], '52200', '295800', 'Giao giờ hành chính', 'CB2-XANH-Z450', '1', '348000'),
  order('3', '#Z3', '12/10/2026, 20:22', 'Khách Ba', '0901000003', ['Tỉnh Tiền Giang', 'Huyện Cái Bè', 'Thị trấn Cái Bè', '420 huyện lộ 74'], '21800', '87200', '', 'CHIA-Z500', '1', '109000'),
  order('4', '#Z4', '12/10/2026, 11:36', 'Khách Bốn', '0901000004', ['Thành phố Hồ Chí Minh', 'Thành phố Thủ Đức', 'Phường Trường Thọ', '11 đường 3'], '0', '348000', '', 'CB2-XANH-Z450', '1', '348000'),
  order('5', '#Z5', '09/10/2026, 12:19', 'Khách Năm', '0901000005', ['Tỉnh Bình Dương', 'Thành phố Thủ Dầu Một', 'Phường Phú Hòa', '487 Lê Hồng Phong'], '138900', '324100', '', 'MIX5-H420', '1', '289000'),
  order('', '#Z5', '09/10/2026, 12:19', 'Khách Năm', '0901000005', ['Tỉnh Bình Dương', 'Thành phố Thủ Dầu Một', 'Phường Phú Hòa', '487 Lê Hồng Phong'], '', '', '', 'GRA-XANH-Z450', '1', '174000'),
  Array(25).fill('')
];
const kept = ['Số thứ tự', 'Mã đơn hàng', 'Ngày tạo đơn hàng', 'Tên khách hàng', 'Số điện thoại', 'Thành phố', 'Quận', 'Phường', 'Địa chỉ', 'Tổng khuyến mãi', 'Tổng giá', 'Ghi chú', 'Mã SKU', 'Số lượng', 'Thành tiền'];
const products = [
  { sku: 'GRA-XANH-Z450', name: 'Granola Túi Xanh 450g' },
  { sku: 'GRA-VANG-H350', name: 'Granola Túi Vàng 350g' },
  { sku: 'MIX5-H420', name: 'Hạt An Lành dạng hũ' },
  { sku: 'CB10-XANH-G35', name: 'Combo 10 gói Xanh' }
];

function zaloContext(stored = null, { discount = 21, exportDay = null, exportSource = '', gifts = '' } = {}) {
  const storage = new Map(stored ? [['crm-zalo-orders', JSON.stringify(stored)]] : []);
  const preview = { innerHTML: '', classList: { remove() {}, add() {} } };
  const summary = { innerHTML: '' };
  const context = {
    storage, preview, summary, stages: [], toasts: [], empties: [],
    sharedProducts: products,
    orderPanelsDirty: new Set(),
    baseExport: { headers: [], rows: [] },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { querySelector: selector => ({ '#zalo-order-preview': preview, '#zalo-order-summary': summary })[selector] || null },
    showOrderStage: stage => { context.stages.push(stage); },
    showToast: (message, tone) => context.toasts.push([message, tone]),
    renderEmptyState: (container, message) => context.empties.push(message),
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    isSystemOrderId: id => /^(CB|LP)-/.test(String(id || '')),
    carrierLabelFor: () => 'Viettel',
    exportableOrderData: () => context.baseExport,
    selectedExportDate: () => exportDay,
    selectedExportSource: () => exportSource
  };
  vm.createContext(context);
  vm.runInContext([
    "const orderSourceHeader = 'Nguồn đơn'; const orderDateHeader = 'Ngày'; const orderCarrierHeader = 'Nhà mạng'; const orderStaffNoteHeader = 'Ghi chú xử lý';",
    constant('zaloOrdersKey'), constant('zaloKeptColumns'), constant('zaloSourceLabel'), constant('chatbotOrderHeaders'), constant('zaloGiftColumn'), constant('zaloExportHeaders'),
    "const zaloOrderSearch = { value: '' }; const zaloOrderSummary = document.querySelector('#zalo-order-summary'); const zaloOrderPreview = document.querySelector('#zalo-order-preview');",
    "const orderExportSource = null; const orderExportDay = null;",
    ...['normalizeColumnName', 'readZaloOrders', 'saveZaloOrders', 'missingZaloColumns', 'isZaloOrderSheet', 'keepZaloColumns', 'applyZaloImport', 'showZaloExport', 'renderZaloOrders', 'moveZaloRowsOutOfOrderTable',
      'zaloMoney', 'zaloColumnReader', 'zaloOrderGroups', 'zaloOrderPricing', 'zaloPercent', 'zaloOrderDate', 'zaloFullAddress', 'zaloCatalogLine', 'zaloExportRows', 'zaloExportDayKey', 'zaloOrderDateKeys', 'exportOrderDataWithZalo', 'parseOrderRowDate', 'parseZaloGifts', 'zaloGiftsLabel'].map(fn),
    "const todayDateKey = () => '2026-10-13';",
    "const dateKeyOf = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;",
    'let zaloOrders = readZaloOrders();',
    `let zaloDiscount = ${discount};`,
    `let zaloGifts = ${JSON.stringify(gifts)};`,
    'globalThis.api = { isZaloOrderSheet, keepZaloColumns, applyZaloImport, renderZaloOrders, moveZaloRowsOutOfOrderTable, zaloOrderGroups, zaloOrderPricing, zaloExportRows, zaloOrderDateKeys, exportOrderDataWithZalo, parseZaloGifts, search: zaloOrderSearch, get zaloOrders() { return zaloOrders; } };'
  ].join('\n'), context);
  return context;
}
const keptData = () => zaloContext().api.keepZaloColumns(zaloHeaders, zaloRows);

test('nhận ra tệp đơn Zalo theo tên cột; tệp Pancake / bảng chuẩn thì không', () => {
  const { api } = zaloContext();
  assert.equal(api.isZaloOrderSheet(zaloHeaders), true);
  assert.equal(api.isZaloOrderSheet(['Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Địa chỉ', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá']), false);
});

test('chỉ giữ đúng 15 cột Zalo đã chọn, tên cột và dữ liệu giữ nguyên, bỏ dòng trống', () => {
  const zalo = keptData();
  assert.deepEqual(plain(zalo.headers), kept);
  assert.equal(zalo.rows.length, 6);
  assert.deepEqual(plain(zalo.rows[0]), ['1', '#Z1', '13/10/2026, 14:08', 'Khách Một', '0901000001', 'Tỉnh Quảng Bình', 'Thành Phố Đồng Hới', 'Phường Phú Hải', 'Đường Lưu Hữu Phước', '36540', '137460', '', 'GRA-VANG-H350', '1', '174000']);
  // Dòng thứ hai của đơn nhiều sản phẩm: STT, tiền đơn để trống như trong tệp.
  assert.deepEqual(plain(zalo.rows[5]).slice(0, 2), ['', '#Z5']);
  assert.deepEqual(plain(zalo.rows[5]).slice(9, 15), ['', '', '', 'GRA-XANH-Z450', '1', '174000']);
});

test('tiền đơn: giảm Zalo ≥ 21% giữ giá Zalo, thấp hơn tính lại 21% (Tổng khuyến mãi / Σ Thành tiền của đơn)', () => {
  const { api } = zaloContext(keptData());
  const result = Object.fromEntries(api.zaloOrderGroups().map(group => {
    const pricing = api.zaloOrderPricing(group, kept);
    return [group.id, [Math.round(pricing.orderRate * 1000) / 10, pricing.keepZalo, pricing.total]];
  }));
  assert.deepEqual(plain(result), {
    '#Z1': [21, true, 137460], // 36.540 / 174.000 = 21% → giữ
    '#Z2': [15, false, 274920], // 15% → 348.000 × 79%
    '#Z3': [20, false, 86110], // 20% → 109.000 × 79%
    '#Z4': [0, false, 274920], // không mã giảm → 21%
    '#Z5': [30, true, 324100] // 138.900 / (289.000 + 174.000) = 30% → giữ Tổng giá
  });
  // Nhân viên đổi mức: 15% → đơn 15%, 20%, 21%, 30% giữ giá Zalo; đơn 0% giảm 15%.
  const fifteen = zaloContext(keptData(), { discount: 15 }).api;
  assert.deepEqual(plain(fifteen.zaloOrderGroups().map(group => fifteen.zaloOrderPricing(group, kept, 15).total)), [137460, 295800, 87200, 295800, 324100]);
});

test('đơn Zalo thành dòng cột chuẩn: nguồn Zalo, CB2 = 2 túi danh mục, đơn giá = tiền thu chia theo Thành tiền, địa chỉ đủ cấp', () => {
  const { api } = zaloContext(keptData());
  const rows = plain(api.zaloExportRows());
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[1], ['Zalo', '13/10/2026 13:58', '#Z2', 'Khách Hai', '0901000002', 'Viettel',
    '48 Nguyễn Bỉnh Khiêm, Phường Xương Huân, Thành phố Nha Trang, Tỉnh Khánh Hòa', 'Tỉnh Khánh Hòa', 'Thành phố Nha Trang', 'Phường Xương Huân',
    'Granola Túi Xanh 450g', 'GRA-XANH-Z450', '2', '137460', 'Zalo giảm 15% → áp 21% · Khách ghi: Giao giờ hành chính', '', '']);
  assert.match(rows[0][14], /^Zalo giảm 21%: giữ giá Zalo$/);
  // Mã chưa có trong danh mục giữ nguyên.
  assert.deepEqual(rows[2].slice(10, 14), ['CHIA-Z500', 'CHIA-Z500', '1', '86110']);
  // Đơn hai dòng: 324.100 chia theo Thành tiền 289.000 / 174.000; ghi chú chỉ ở dòng đầu.
  assert.deepEqual(rows.slice(4).map(row => [row[11], row[12], row[13], row[14] ? 'note' : '']), [['MIX5-H420', '1', '202300', 'note'], ['GRA-XANH-Z450', '1', '121800', '']]);
  // Σ đơn giá × số lượng = tiền thu của từng đơn.
  const totals = {};
  rows.forEach(row => { totals[row[2]] = (totals[row[2]] || 0) + Number(row[12]) * Number(row[13]); });
  assert.deepEqual(totals, { '#Z1': 137460, '#Z2': 274920, '#Z3': 86110, '#Z4': 274920, '#Z5': 324100 });
});

test('Xuất dữ liệu: cả tệp Zalo (mọi ngày tạo đơn) xuất ở ngày Import, nối sau đơn của bảng chung, cùng cột', () => {
  // Tệp nhập lúc 15:30 ngày 13/10 có đơn 13/10, 12/10, 09/10: chọn ngày 13/10 phải ra đủ 5/5 đơn (trước đây 2/5).
  const stored = { ...keptData(), importedAt: new Date(2026, 9, 13, 15, 30).toISOString() };
  const day = new Date(2026, 9, 13);
  const base = { headers: ['Nguồn đơn', 'Ngày', 'Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Cột lạ'], rows: [['Chatbot', '13/10 08:11', 'CB-1', 'An', '0901', 'x']] };
  const all = zaloContext(stored, { exportDay: day });
  all.baseExport = base;
  const merged = plain(all.api.exportOrderDataWithZalo());
  assert.equal(merged.rows.length, 1 + 6);
  assert.deepEqual(merged.rows[0].slice(0, 6), ['Chatbot', '13/10 08:11', 'CB-1', 'An', '0901', 'x']);
  const at = name => merged.headers.indexOf(name);
  assert.ok(at('Mã mẫu mã') > 0 && at('Đơn giá') > 0 && at('Tỉnh/Thành phố') > 0);
  assert.deepEqual([...new Set(merged.rows.slice(1).map(row => row[at('Mã đơn hàng')]))], ['#Z1', '#Z2', '#Z3', '#Z4', '#Z5']);
  assert.deepEqual(merged.rows.slice(1, 3).map(row => [row[at('Nguồn đơn')], row[at('Mã đơn hàng')], row[at('Đơn giá')]]), [['Zalo', '#Z1', '137460'], ['Zalo', '#Z2', '137460']]);
  // Ngày khác ngày Import: không có đơn Zalo (không xuất lặp ở ngày 12/10, 09/10).
  const otherDay = zaloContext(stored, { exportDay: new Date(2026, 9, 12) });
  otherDay.baseExport = base;
  assert.equal(otherDay.api.exportOrderDataWithZalo(), base);
  // Lọc nguồn khác → không có đơn Zalo; bảng chung trống + nguồn Zalo → chỉ đơn Zalo với cột chuẩn.
  const chatbotOnly = zaloContext(stored, { exportDay: day, exportSource: 'Chatbot' });
  chatbotOnly.baseExport = base;
  assert.equal(chatbotOnly.api.exportOrderDataWithZalo(), base);
  const zaloOnly = plain(zaloContext(stored, { exportDay: day, exportSource: 'Zalo' }).api.exportOrderDataWithZalo());
  assert.equal(zaloOnly.rows.length, 6);
  assert.deepEqual(plain(zaloContext(stored).api.zaloOrderDateKeys()), ['2026-10-13']);
  assert.deepEqual(plain(zaloContext().api.zaloOrderDateKeys()), []);
});

test('quà Zalo: SKU nhân viên nhập kèm MỌI đơn, đơn giá 0, thay quà theo combo; ô trống thì không quà; đơn thường giữ quà theo giỏ', () => {
  // Đọc ô quà: dấu phẩy / chấm phẩy / +, số lượng x2 ×2 *2, SKU viết thường, gộp trùng; phần sai báo riêng.
  const parsed = parseGiftSkus('bgd, MUONG x2; BGD *1 + QUA-TANG-LIVE ×3, ??');
  assert.deepEqual(plain(parsed), [{ sku: 'BGD', quantity: 2 }, { sku: 'MUONG', quantity: 2 }, { sku: 'QUA-TANG-LIVE', quantity: 3 }]);
  assert.deepEqual(parsed.invalid, ['??']);
  assert.deepEqual(plain(zaloContext().api.parseZaloGifts('bgd, MUONG x2; BGD *1')), [{ sku: 'BGD', quantity: 2 }, { sku: 'MUONG', quantity: 2 }]);

  const headers = [...['Nguồn đơn', 'Ngày', 'Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Nhà mạng', 'Địa chỉ', 'Tỉnh/Thành phố', 'Quận/Huyện', 'Phường/Xã', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá', 'Ghi chú', 'Ghi chú xử lý'], 'Quà tặng (SKU)'];
  const withGifts = plain(zaloContext(keptData(), { gifts: 'BGD, MUONG x2' }).api.zaloExportRows());
  assert.ok(withGifts.every(row => row[16] === 'BGD x1, MUONG x2'));
  const output = buildExportRows({ headers, rows: withGifts });
  // Mỗi đơn: dòng sản phẩm như cũ rồi đúng 2 dòng quà giá 0 (không quà theo combo 2 túi Xanh của bảng quà).
  const byOrder = [];
  output.forEach(line => { if (line[0]) byOrder.push([]); byOrder.at(-1).push(`${line[19]}x${line[21]}@${line[22]}`); });
  assert.deepEqual(byOrder, [
    ['GRA-VANG-H350x1@137460', 'BGDx1@0', 'MUONGx2@0'],
    ['GRA-XANH-Z450x2@137460', 'BGDx1@0', 'MUONGx2@0'],
    ['CHIA-Z500x1@86110', 'BGDx1@0', 'MUONGx2@0'],
    ['GRA-XANH-Z450x2@137460', 'BGDx1@0', 'MUONGx2@0'],
    ['MIX5-H420x1@202300', 'GRA-XANH-Z450x1@121800', 'BGDx1@0', 'MUONGx2@0']
  ]);
  // Khối lượng mã Zalo ngoài danh mục (chủ shop đưa 14/10): 100-NB-PRE-H420 = 500g, quà TAM-LANH-G25 = 25g.
  const weighted = buildExportRows({ headers, rows: [['Zalo', '', '#W1', 'A', '0901000009', '', '11 đường 3', 'TP Hồ Chí Minh', 'Thành phố Thủ Đức', 'Phường Trường Thọ', '', '100-NB-PRE-H420', '2', '159600', '', '', 'TAM-LANH-G25']] });
  assert.deepEqual(weighted.map(line => `${line[19]}x${line[21]}@${line[22]}/${line[24]}g`), ['100-NB-PRE-H420x2@159600/500g', 'TAM-LANH-G25x1@0/25g']);
  // Ô quà trống: đơn Zalo không kèm quà nào (kể cả combo 2 túi Xanh).
  const noGifts = buildExportRows({ headers, rows: plain(zaloContext(keptData()).api.zaloExportRows()) });
  assert.equal(noGifts.filter(line => !(Number(line[22]) > 0)).length, 0);
  // Đơn thường cùng giỏ 2 túi Xanh (nguồn Chatbot): quà theo bảng quà như cũ, không lấy quà Zalo.
  const normal = withGifts.filter(row => row[2] === '#Z2').map(row => ['Chatbot', ...row.slice(1, 2), 'CB-n1', ...row.slice(3, 16), '']);
  const normalGifts = buildExportRows({ headers, rows: normal }).filter(line => !(Number(line[22]) > 0)).map(line => line[19]);
  const zaloComboGifts = byOrder[1].slice(1).map(line => line.split('x')[0]);
  assert.notDeepEqual(normalGifts, zaloComboGifts);
  assert.equal(buildExportRows({ headers, rows: normal })[0][2], 'Facebook');
});

test('file kho (buildExportRows của máy chủ) từ đơn Zalo: giá khách trả giữ nguyên, CB2 → 2 túi, ba cấp địa chỉ hợp lệ', () => {
  const { api } = zaloContext(keptData());
  const rows = plain(api.zaloExportRows());
  const headers = ['Nguồn đơn', 'Ngày', 'Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Nhà mạng', 'Địa chỉ', 'Tỉnh/Thành phố', 'Quận/Huyện', 'Phường/Xã', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá', 'Ghi chú', 'Ghi chú xử lý'];
  const output = buildExportRows({ headers, rows });
  assert.deepEqual(output.locationCheck.invalid, []);
  const productLines = output.filter(line => Number(line[22]) > 0).map(line => `${line[19]}x${line[21]}@${line[22]}`);
  assert.deepEqual(productLines, ['GRA-VANG-H350x1@137460', 'GRA-XANH-Z450x2@137460', 'CHIA-Z500x1@86110', 'GRA-XANH-Z450x2@137460', 'MIX5-H420x1@202300', 'GRA-XANH-Z450x1@121800']);
  // Tiền file kho (dòng có giá) = tổng tiền thu của 5 đơn.
  assert.equal(output.reduce((sum, line) => sum + Number(line[21] || 0) * Number(line[22] || 0), 0), 137460 + 274920 + 86110 + 274920 + 324100);
  assert.deepEqual(output.filter(line => line[0]).map(line => line[33]), ['Khách Một', 'Khách Hai', 'Khách Ba', 'Khách Bốn', 'Khách Năm']);
  // Cột "Nguồn đơn hàng" của file kho: đơn Zalo ghi "zalo" chữ thường (trước đây mọi đơn đều Facebook).
  assert.deepEqual(output.filter(line => line[0]).map(line => line[2]), ['zalo', 'zalo', 'zalo', 'zalo', 'zalo']);
  // Đơn thường (nguồn Chatbot/Landing…) trong cùng file vẫn Facebook.
  const mixed = buildExportRows({ headers, rows: [...rows, ['Chatbot', ...rows[0].slice(1, 2), 'CB-x1', ...rows[0].slice(3)]] });
  assert.deepEqual(mixed.filter(line => line[0]).map(line => line[2]), ['zalo', 'zalo', 'zalo', 'zalo', 'zalo', 'Facebook']);
});

test('Import Zalo lưu kho riêng crm-zalo-orders rồi mở Xuất dữ liệu; không đụng bảng đơn crm-orders', () => {
  const context = zaloContext();
  context.api.applyZaloImport('don_hang_13_10_2026.xlsx', { headers: zaloHeaders, rows: zaloRows });
  assert.deepEqual(plain(context.stages), ['export']);
  assert.ok(context.orderPanelsDirty.has('export'));
  assert.equal(context.storage.has('crm-orders'), false);
  const saved = JSON.parse(context.storage.get('crm-zalo-orders'));
  assert.deepEqual(saved.headers, kept);
  assert.equal(saved.rows.length, 6);
  assert.match(context.toasts[0][0], /^Đã nhập 5 đơn Zalo \(6 dòng\), giảm giá 21%: kết quả ở Xuất dữ liệu\.$/);
  // Tệp khác loại: báo thiếu cột, kho Zalo giữ nguyên.
  assert.throws(() => context.api.applyZaloImport('pancake.xlsx', { headers: ['Mã đơn hàng', 'Khách hàng'], rows: [] }), /thiếu cột: Số thứ tự, Ngày tạo đơn hàng/);
  assert.equal(context.api.zaloOrders.rows.length, 6);
});

test('trang Đơn Zalo: 15 cột + mức giảm áp dụng, tiền thu; tìm kiếm không dấu; bảng trống có lời nhắc', () => {
  const empty = zaloContext();
  empty.api.renderZaloOrders();
  assert.match(empty.empties[0], /Chưa có đơn Zalo/);

  const context = zaloContext({ ...keptData(), fileName: 'f.xlsx' });
  context.api.renderZaloOrders();
  assert.equal((context.preview.innerHTML.match(/<th>/g) || []).length, 15);
  assert.match(context.preview.innerHTML, /<th class="zalo-computed">Mức giảm áp dụng<\/th><th class="zalo-computed">Tiền thu<\/th>/);
  assert.match(context.preview.innerHTML, /--preview-template: repeat\(17, max-content\)/);
  assert.match(context.preview.innerHTML, /21% \(Zalo 15%\)<\/td><td class="zalo-computed">274\.920đ/);
  assert.match(context.preview.innerHTML, /30% \(giá Zalo\)<\/td><td class="zalo-computed">324\.100đ/);
  assert.match(context.summary.innerHTML, /Đơn Zalo: <strong>5<\/strong> · Dòng: <strong>6<\/strong> · Tiền thu: <strong>1\.097\.510đ<\/strong> · Quà mỗi đơn: <strong>Không có quà<\/strong> · f\.xlsx/);
  context.api.search.value = 'khach nam';
  context.api.renderZaloOrders();
  assert.equal((context.preview.innerHTML.match(/<tr>/g) || []).length, 3);
  assert.match(context.summary.innerHTML, /Dòng: <strong>2\/6<\/strong>/);
});

test('bảng đơn đã bị bản cũ Import Zalo đè: dòng Zalo sang trang Đơn Zalo, bảng đơn về trống; bảng chuẩn giữ nguyên', () => {
  const systemRow = zaloHeaders.map(header => ({ 'Mã đơn hàng': 'CB-77', 'Số điện thoại': '0901000077' })[header] || '');
  const polluted = { headers: ['Nguồn đơn', 'Ngày', ...zaloHeaders, 'Nhà mạng', 'Ghi chú xử lý'], rows: [
    ['Import', '', ...zaloRows[0], 'Viettel', ''],
    ['Chatbot', '13/10 08:11', ...systemRow, 'Viettel', '']
  ] };
  const context = zaloContext();
  const result = context.api.moveZaloRowsOutOfOrderTable(polluted);
  assert.deepEqual(plain(result), { headers: [], rows: [] });
  assert.equal(context.storage.get('crm-orders'), JSON.stringify({ headers: [], rows: [] }));
  assert.equal(context.api.zaloOrders.rows.length, 1);
  assert.equal(context.api.zaloOrders.rows[0][1], '#Z1');

  const standard = { headers: ['Nguồn đơn', 'Ngày', 'Mã đơn hàng', 'Khách hàng', 'Số điện thoại'], rows: [['Chatbot', '13/10 08:11', 'CB-1', 'An', '0901']] };
  assert.equal(zaloContext().api.moveZaloRowsOutOfOrderTable(standard), standard);
});

test('giao diện: mục Đơn Zalo, ô Mức giảm giá mặc định 21%; Xuất dữ liệu có nguồn Zalo và dùng dữ liệu kèm đơn Zalo', () => {
  assert.match(html, /<button class="order-subnav-item" type="button" data-order-stage="zalo">Đơn Zalo<\/button>/);
  assert.match(html, /data-order-panel="zalo">[\s\S]*?id="zalo-discount" type="number" min="0" max="100" step="0\.5" value="21"[\s\S]*?id="zalo-order-import"[\s\S]*?id="zalo-order-export"[\s\S]*?id="zalo-order-clear"[\s\S]*?id="zalo-order-preview"/);
  assert.equal(constant('zaloDefaultDiscount').trim(), 'const zaloDefaultDiscount = 21;');
  // Nguồn Zalo chỉ ở bộ lọc Xuất dữ liệu; bảng Nhập dữ liệu không có (đơn Zalo không vào đó).
  assert.match(html, /id="order-export-source"[\s\S]*?<option value="Zalo">Zalo<\/option>[\s\S]*?<\/select>/);
  assert.doesNotMatch(html.match(/id="order-source-filter"[\s\S]*?<\/select>/)[0], /Zalo/);
  assert.match(fn('fetchExportRows'), /const exportable = exportOrderDataWithZalo\(\);/);
  assert.match(fn('exportOrdersToXlsx'), /orderData: exportOrderDataWithZalo\(\)/);
  assert.match(fn('renderOrderData'), /fillOrderDayOptions\(orderExportDay, withZaloDateKeys\(dateKeys\)\);/);
  assert.match(web, /if \(isZaloOrderSheet\(result\.headers \|\| \[\]\)\) \{ applyZaloImport\(file\.name, result\); return; \}\n\s*applyImportedRecords\(result\.headers \|\| \[\], result\.rows \|\| \[\]\);/);
  assert.match(fn('showOrderStage'), /if \(stage === 'zalo'\) \{ renderZaloOrders\(\); return; \}/);
});
