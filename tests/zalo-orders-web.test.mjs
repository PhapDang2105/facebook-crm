import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Đơn Zalo (13/10): trang riêng Đơn hàng → Đơn Zalo, tách hẳn bảng đơn của Nhập/Xử lý/Xuất
// dữ liệu. Import tệp "Danh sách đơn hàng" của Zalo chỉ giữ 15 cột chủ shop chọn (đúng tên,
// đúng dữ liệu). Như các tệp *-web.test.mjs khác: cắt hàm cấp ngoài cùng của app.js rồi chạy trong vm.
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

const zaloHeaders = ['Số thứ tự', 'Mã đơn hàng', 'Ngày tạo đơn hàng', 'Ngày cập nhật đơn hàng', 'Tên khách hàng', 'Số điện thoại', 'Thành phố', 'Quận', 'Phường', 'Địa chỉ', 'Phí vận chuyển', 'Tổng khuyến mãi', 'Điểm tích lũy đã dùng', 'Tiền giảm từ điểm', 'Tổng giá', 'Trạng thái đơn hàng', 'Phương thức thanh toán', 'Trạng thái thanh toán', 'Ghi chú', 'Tên sản phẩm', 'Mã SKU', 'Số lượng', 'Đơn giá', 'Thành tiền', 'Khối lượng (g)'];
const zaloRows = [
  ['1', '#QKMVnNtqI5', '13/10/2026, 14:08', '13/10/2026, 14:08', 'Nguyễn Thương', '0915997245', 'Tỉnh Quảng Bình', 'Thành Phố Đồng Hới', 'Phường Phú Hải', 'Đường Lưu Hữu Phước', '30000', '36540', '0', '0', '137460', 'Chờ xác nhận', 'COD', 'Chưa thanh toán', '', 'Granola Rạng Rỡ Tươi Tắn 350 g', 'GRA-VANG-H350', '1', '174000', '174000', '400'],
  ['9', '#6ftOsIqeE1', '09/10/2026, 12:19', '09/10/2026, 12:19', 'Lý Đại Dũng', '0345536236', 'Tỉnh Bình Dương', 'Thành phố Thủ Dầu Một', 'Phường Phú Hòa', '487 Lê Hồng Phong', '30000', '138900', '0', '0', '324100', 'Chờ xác nhận', 'COD', 'Chưa thanh toán', 'Gọi trước', 'HẠT AN LÀNH', 'MIX5-H420', '1', '289000', '289000', '0'],
  ['', '#6ftOsIqeE1', '09/10/2026, 12:19', '09/10/2026, 12:19', 'Lý Đại Dũng', '0345536236', 'Tỉnh Bình Dương', 'Thành phố Thủ Dầu Một', 'Phường Phú Hòa', '487 Lê Hồng Phong', '', '', '', '', '', 'Chờ xác nhận', 'COD', 'Chưa thanh toán', '', 'Granola Không Chiên Vẫn Ngon 450 g', 'GRA-XANH-Z450', '1', '174000', '174000', '450'],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']
];
const kept = ['Số thứ tự', 'Mã đơn hàng', 'Ngày tạo đơn hàng', 'Tên khách hàng', 'Số điện thoại', 'Thành phố', 'Quận', 'Phường', 'Địa chỉ', 'Tổng khuyến mãi', 'Tổng giá', 'Ghi chú', 'Mã SKU', 'Số lượng', 'Thành tiền'];

function zaloContext(stored = null) {
  const storage = new Map(stored ? [['crm-zalo-orders', JSON.stringify(stored)]] : []);
  const preview = { innerHTML: '', classList: { remove() {}, add() {} } };
  const summary = { innerHTML: '' };
  const context = {
    storage, preview, summary, stages: [], toasts: [], empties: [],
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { querySelector: selector => ({ '#zalo-order-preview': preview, '#zalo-order-summary': summary })[selector] || null },
    showOrderStage: stage => { context.stages.push(stage); },
    showToast: (message, tone) => context.toasts.push([message, tone]),
    renderEmptyState: (container, message) => context.empties.push(message),
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    isSystemOrderId: id => /^(CB|LP)-/.test(String(id || ''))
  };
  vm.createContext(context);
  vm.runInContext([
    constant('zaloOrdersKey'), constant('zaloKeptColumns'),
    "const zaloOrderSearch = { value: '' }; const zaloOrderSummary = document.querySelector('#zalo-order-summary'); const zaloOrderPreview = document.querySelector('#zalo-order-preview');",
    ...['normalizeColumnName', 'readZaloOrders', 'saveZaloOrders', 'missingZaloColumns', 'isZaloOrderSheet', 'keepZaloColumns', 'applyZaloImport', 'renderZaloOrders', 'moveZaloRowsOutOfOrderTable'].map(fn),
    'let zaloOrders = readZaloOrders();',
    'globalThis.api = { isZaloOrderSheet, keepZaloColumns, applyZaloImport, renderZaloOrders, moveZaloRowsOutOfOrderTable, search: zaloOrderSearch, get zaloOrders() { return zaloOrders; } };'
  ].join('\n'), context);
  return context;
}

test('nhận ra tệp đơn Zalo theo tên cột; tệp Pancake / bảng chuẩn thì không', () => {
  const { api } = zaloContext();
  assert.equal(api.isZaloOrderSheet(zaloHeaders), true);
  assert.equal(api.isZaloOrderSheet(['Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Địa chỉ', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá']), false);
});

test('chỉ giữ đúng 15 cột Zalo đã chọn, tên cột và dữ liệu giữ nguyên, bỏ dòng trống', () => {
  const { api } = zaloContext();
  const zalo = api.keepZaloColumns(zaloHeaders, zaloRows);
  assert.deepEqual(plain(zalo.headers), kept);
  assert.equal(zalo.rows.length, 3);
  assert.deepEqual(plain(zalo.rows[0]), ['1', '#QKMVnNtqI5', '13/10/2026, 14:08', 'Nguyễn Thương', '0915997245', 'Tỉnh Quảng Bình', 'Thành Phố Đồng Hới', 'Phường Phú Hải', 'Đường Lưu Hữu Phước', '36540', '137460', '', 'GRA-VANG-H350', '1', '174000']);
  // Dòng thứ hai của đơn nhiều sản phẩm: STT, tiền đơn để trống như trong tệp.
  assert.deepEqual(plain(zalo.rows[2]), ['', '#6ftOsIqeE1', '09/10/2026, 12:19', 'Lý Đại Dũng', '0345536236', 'Tỉnh Bình Dương', 'Thành phố Thủ Dầu Một', 'Phường Phú Hòa', '487 Lê Hồng Phong', '', '', '', 'GRA-XANH-Z450', '1', '174000']);
});

test('Import Zalo lưu kho riêng crm-zalo-orders, mở trang Đơn Zalo; không đụng bảng đơn crm-orders', () => {
  const context = zaloContext();
  context.api.applyZaloImport('don_hang_13_10_2026.xlsx', { headers: zaloHeaders, rows: zaloRows });
  assert.deepEqual(plain(context.stages), ['zalo']);
  assert.equal(context.storage.has('crm-orders'), false);
  const saved = JSON.parse(context.storage.get('crm-zalo-orders'));
  assert.deepEqual(saved.headers, kept);
  assert.equal(saved.rows.length, 3);
  assert.equal(saved.fileName, 'don_hang_13_10_2026.xlsx');
  assert.match(context.toasts[0][0], /^Đã nhập 2 đơn Zalo \(3 dòng\)/);
  // Tệp khác loại: báo thiếu cột, kho Zalo giữ nguyên.
  assert.throws(() => context.api.applyZaloImport('pancake.xlsx', { headers: ['Mã đơn hàng', 'Khách hàng'], rows: [] }), /thiếu cột: Số thứ tự, Ngày tạo đơn hàng/);
  assert.equal(context.api.zaloOrders.rows.length, 3);
});

test('trang Đơn Zalo vẽ đúng 15 cột, tìm kiếm không dấu, bảng trống có lời nhắc', () => {
  const empty = zaloContext();
  empty.api.renderZaloOrders();
  assert.match(empty.empties[0], /Chưa có đơn Zalo/);

  const context = zaloContext({ ...zaloContext().api.keepZaloColumns(zaloHeaders, zaloRows), fileName: 'f.xlsx' });
  context.api.renderZaloOrders();
  assert.equal((context.preview.innerHTML.match(/<th>/g) || []).length, 15);
  assert.equal((context.preview.innerHTML.match(/<tr>/g) || []).length, 4);
  assert.match(context.preview.innerHTML, /--preview-template: repeat\(15, max-content\)/);
  assert.match(context.summary.innerHTML, /Đơn Zalo: <strong>2<\/strong> · Dòng: <strong>3<\/strong> · f\.xlsx/);
  context.api.search.value = 'ly dai dung';
  context.api.renderZaloOrders();
  assert.equal((context.preview.innerHTML.match(/<tr>/g) || []).length, 3);
  assert.match(context.summary.innerHTML, /Dòng: <strong>2\/3<\/strong>/);
});

test('bảng đơn đã bị bản cũ Import Zalo đè: dòng Zalo sang trang Đơn Zalo, bảng đơn về trống; bảng chuẩn giữ nguyên', () => {
  const polluted = { headers: ['Nguồn đơn', 'Ngày', ...zaloHeaders, 'Nhà mạng', 'Ghi chú xử lý'], rows: [
    ['Import', '', ...zaloRows[0], 'Vinaphone', ''],
    ['Chatbot', '13/10 08:11', ...zaloHeaders.map((header, index) => (header === 'Mã đơn hàng' ? 'CB-77' : (header === 'Số điện thoại' ? '0981947750' : '')) || (index < 0 ? '' : '')), 'Viettel', '']
  ] };
  const context = zaloContext();
  const result = context.api.moveZaloRowsOutOfOrderTable(polluted);
  assert.deepEqual(plain(result), { headers: [], rows: [] });
  assert.equal(context.storage.get('crm-orders'), JSON.stringify({ headers: [], rows: [] }));
  assert.equal(context.api.zaloOrders.rows.length, 1);
  assert.equal(context.api.zaloOrders.rows[0][1], '#QKMVnNtqI5');

  const standard = { headers: ['Nguồn đơn', 'Ngày', 'Mã đơn hàng', 'Khách hàng', 'Số điện thoại'], rows: [['Chatbot', '13/10 08:11', 'CB-1', 'An', '0901']] };
  assert.equal(zaloContext().api.moveZaloRowsOutOfOrderTable(standard), standard);
});

test('giao diện: mục Đơn Zalo trong menu Đơn hàng, trang riêng; Import ở Nhập dữ liệu chuyển tệp Zalo sang trang này', () => {
  assert.match(html, /<button class="order-subnav-item" type="button" data-order-stage="zalo">Đơn Zalo<\/button>/);
  assert.match(html, /data-order-panel="zalo">[\s\S]*?id="zalo-order-import"[\s\S]*?id="zalo-order-clear"[\s\S]*?id="zalo-order-preview"/);
  // Bộ lọc nguồn của bảng đơn chung không có Zalo (hai luồng tách hẳn).
  assert.doesNotMatch(html, /<option value="Zalo">/);
  assert.match(web, /if \(isZaloOrderSheet\(result\.headers \|\| \[\]\)\) \{ applyZaloImport\(file\.name, result\); return; \}\n\s*applyImportedRecords\(result\.headers \|\| \[\], result\.rows \|\| \[\]\);/);
  assert.match(fn('showOrderStage'), /if \(stage === 'zalo'\) \{ renderZaloOrders\(\); return; \}/);
  assert.match(web, /orderData = ensureOrderStaffNoteColumn\(moveZaloRowsOutOfOrderTable\(orderData\)\);/);
});
