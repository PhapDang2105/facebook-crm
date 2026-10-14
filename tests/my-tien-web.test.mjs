import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
// Danh mục thử nạp TRƯỚC mọi thứ dưới app/ (file kho đọc danh mục, quà).
import './helpers/seed-catalog.mjs';
import { buildExportRows } from '../app/order-export.mjs';

// Tệp đơn Mỹ Tiền (14/10, "USER-2.xlsx"): NGÀY, MÃ ĐƠN (trống), TÊN, SDT, ĐỊA CHỈ, SỐ LƯỢNG TÚI (chữ tự do), QUÀ TẶNG,
// GIÁ TIỀN (tổng đơn), NOTE. Import đọc túi mua / hàng mua thêm / quà, chia tiền, rồi xuất file kho như đơn thường.
// Chữ sản phẩm, giá như tệp thật; tên, SĐT, địa chỉ là giả.
const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const fn = name => {
  const start = web.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `không tìm thấy hàm ${name}`);
  return web.slice(start, web.indexOf('\n}\n', start) + 3);
};
const block = (from, to) => web.slice(web.indexOf(from), web.indexOf(to, web.indexOf(from)));
const plain = value => JSON.parse(JSON.stringify(value));
const products = [
  { sku: 'GRA-XANH-Z450', name: 'Granola Túi Xanh 450g', salePrice: 174000, comboPrice: 149000 },
  { sku: 'GRA-VANG-H350', name: 'Granola Túi Vàng 350g', salePrice: 174000, comboPrice: 149000 },
  { sku: 'GRA-NAU-Z350', name: 'Granola Túi Nâu vị cacao 350g', salePrice: 164000, comboPrice: 144000 },
  { sku: 'GRA-MINT-Z300', name: 'Granola Tropical vị Cacao 300g', salePrice: 204000, comboPrice: 174000 }
];
const context = vm.createContext({ carrierLabelFor: () => '', sharedProducts: products });
vm.runInContext([
  block('const orderSourceHeader = ', '\n/** Nhà mạng theo đầu số'), fn('normalizeColumnName'), fn('compactOrderPhone'),
  block('const myTienSourceLabel = ', '\nfunction isMyTienOrderSheet('),
  ...['isMyTienOrderSheet', 'myTienText', 'myTienBagPrices', 'myTienBagsIn', 'myTienGiftsIn', 'parseMyTienOrder', 'myTienOrderSheetToTable', 'mergeMyTienRows'].map(fn),
  'this.api = { chatbotOrderHeaders, isMyTienOrderSheet, parseMyTienOrder, myTienOrderSheetToTable, mergeMyTienRows };'
].join('\n'), context);
const { api } = context;
const order = (text, gift, total) => {
  const parsed = plain(api.parseMyTienOrder(text, gift, total));
  return [...parsed.lines.map(line => `${line.sku}x${line.quantity}@${line.price}`), ...parsed.gifts.map(line => `quà ${line.sku}x${line.quantity}`), ...parsed.unknown.map(item => `?${item}`)];
};

test('nhận tệp Mỹ Tiền theo cột', () => {
  assert.equal(api.isMyTienOrderSheet(['NGÀY', 'MÃ ĐƠN', 'TÊN', 'SDT', 'ĐỊA CHỈ', 'SỐ LƯỢNG TÚI', 'QUÀ TẶNG', 'GIÁ TIỀN', 'NOTE']), true);
  assert.equal(api.isMyTienOrderSheet(['ID', 'NOTE', 'Khách hàng', 'Số điện thoại', 'SKU']), false);
});

test('đọc chữ tự do: túi mua, quà, hàng mua thêm; mua hay tặng theo GIÁ TIỀN', () => {
  assert.deepEqual(order('Combo 2X  + tặng 2 túi Yến Mạch', '', '298000'), ['GRA-XANH-Z450x2@149000', 'quà HT-YM-T500x2']);
  assert.deepEqual(order('Combo 1 Xanh MInt và 1 Vàng + tặng 2 túi yến mạch', '', '323000'), ['GRA-MINT-Z300x1@174000', 'GRA-VANG-H350x1@149000', 'quà HT-YM-T500x2']);
  assert.deepEqual(order('Combo 2 túi xanh Mint+ túi táo đỏ', '', '348000'), ['GRA-MINT-Z300x2@174000', 'quà TD-Z150x1']);
  assert.deepEqual(order('Combo 2 X+ 1 túi yến mạch và 1 bát gáo dừa', '', '298000'), ['GRA-XANH-Z450x2@149000', 'quà HT-YM-T500x1', 'quà BGDx1']);
  assert.deepEqual(order('Combo 3 X+ 1 túi xanh +1 bát muỗng dừa', '', '447000'), ['GRA-XANH-Z450x3@149000', 'quà BGDx1', 'quà MUONGx1', 'quà GRA-XANH-Z450x1']);
  assert.deepEqual(order('Combo 2 X và mua thêm bột tâm lành', '1 táo đỏ', '472000'), ['GRA-XANH-Z450x2@149000', 'TAM-LANH-H350x1@174000', 'quà TD-Z150x1']);
  assert.deepEqual(order('Combo 1V+ 1X+ yến mạch', '', '298000'), ['GRA-VANG-H350x1@149000', 'GRA-XANH-Z450x1@149000', 'quà HT-YM-T500x1']);
  assert.deepEqual(order('Combo 3 ( 2 xanh+ 1 vàng) + yến mạch mua riêng 1kg( 116K)', 'tặng 1 Vàng', '563000'), ['GRA-XANH-Z450x2@149000', 'GRA-VANG-H350x1@149000', 'CB2-HT-YM-T500x1@116000', 'quà GRA-VANG-H350x1']);
  assert.deepEqual(order('Combo 3( X+V+N)', 'Tặng 1 vàng', '447000'), ['GRA-XANH-Z450x1@149000', 'GRA-VANG-H350x1@149000', 'GRA-NAU-Z350x1@149000', 'quà GRA-VANG-H350x1']);
  assert.deepEqual(order('1 túi Xanh', 'Miễn phí vận chuyển', '174000'), ['GRA-XANH-Z450x1@174000']);
  assert.equal(api.parseMyTienOrder('1 túi Xanh', 'Miễn phí vận chuyển', '174000').freeShip, true);
  assert.deepEqual(order('combo 2 X', 'hũ hạt chia 500g', '298000'), ['GRA-XANH-Z450x2@149000', 'quà CHIA-Z500x1']);
  assert.deepEqual(order('Combo 2X', 'túi vải', '298000'), ['GRA-XANH-Z450x2@149000', '?tui vai']);
});

test('bảng đơn + file kho: mã đơn MT-ngày-số, SĐT thêm 0, quà ghi rõ thành dòng 0đ (kể cả combo 2 có bát + yến mạch), tổng khớp', () => {
  const headers = ['NGÀY ', 'MÃ ĐƠN ', 'TÊN', 'SDT', 'ĐỊA CHỈ', 'SỐ LƯỢNG TÚI', 'QUÀ TẶNG', 'GIÁ TIỀN', 'NOTE '];
  const records = [
    ['2026-10-13', '', 'Khách Một', '938000001', '37 Lê Văn Chí, Phường Linh Trung, Thành phố Thủ Đức, Hồ Chí Minh', 'Combo 2 X+ 1 túi yến mạch và 1 bát gáo dừa', '', '298000', ''],
    ['', '', 'Khách Hai', '938000002', '57 Nguyễn Thị Minh Khai, Phường Bến Thành, Quận 1, Hồ Chí Minh, Vietnam', '1 túi Xanh', 'Miễn phí vận chuyển', '174000', 'gọi lại'],
    ['2026-10-14', '', 'Khách Ba', '938000003', '28 Đào Duy Anh, Phường Khánh Xuân, Thành phố Buôn Ma Thuột, Đắk Lắk', 'Combo 3X+ tặng 1 túi xanh', '', '447000', '']
  ];
  const table = plain(api.myTienOrderSheetToTable(headers, records, new Date(2026, 9, 14, 17, 0)));
  const at = name => table.headers.indexOf(name);
  assert.equal(table.orders, 3);
  assert.deepEqual([...new Set(table.rows.map(row => row[at('Mã đơn hàng')]))], ['MT-1310-01', 'MT-1310-02', 'MT-1410-01']);
  assert.ok(table.rows.every(row => row[at('Nguồn đơn')] === 'Mỹ Tiền' && row[at('Ngày')] === '14/10/2026 17:00'));
  assert.equal(table.rows[0][at('Số điện thoại')], '0938000001');
  assert.equal(table.rows.find(row => row[at('Khách hàng')] === 'Khách Hai')[at('Địa chỉ')], '(Freeship) 57 Nguyễn Thị Minh Khai, Phường Bến Thành, Quận 1, Hồ Chí Minh');
  const rows = buildExportRows(table);
  const byOrder = [];
  rows.forEach(item => { if (item[0] !== '') byOrder.push([]); byOrder.at(-1).push(`${item[19]}x${item[21]}@${item[22]}`); });
  assert.deepEqual(byOrder, [
    ['GRA-XANH-Z450x2@149000', 'HT-YM-T500x1@0', 'BGDx1@0'],
    ['GRA-XANH-Z450x1@174000'],
    ['GRA-XANH-Z450x3@149000', 'GRA-XANH-Z450x1@0']
  ]);
  assert.equal(rows.reduce((sum, item) => sum + item[21] * item[22], 0), 298000 + 174000 + 447000);
});

test('Import Mỹ Tiền THÊM vào bảng: giữ đơn khác, thay đơn Mỹ Tiền cũ', () => {
  const existing = { headers: [...api.chatbotOrderHeaders], rows: [
    ['Import', '14/10/2026 15:14', '57477', 'Khách Import', '0938000009', '', '12 Lê Lợi', '', '', '', 'Túi Vàng', 'GRA-VANG-H350', '1', '189000', '', ''],
    ['Mỹ Tiền', '14/10/2026 16:00', 'MT-1310-01', 'Cũ', '0938000008', '', '12 Lê Lợi', '', '', '', 'Túi Xanh', 'GRA-XANH-Z450', '2', '149000', '', '']
  ] };
  const converted = plain(api.myTienOrderSheetToTable(['TÊN', 'SDT', 'ĐỊA CHỈ', 'SỐ LƯỢNG TÚI', 'GIÁ TIỀN'], [['Mới', '938000007', '12 Lê Lợi', 'Combo 2V', '298000']]));
  const merged = plain(api.mergeMyTienRows(existing, converted));
  assert.equal(merged.headers.at(-1), 'Quà tặng (SKU)');
  assert.deepEqual(merged.rows.map(row => [row[0], row[3]]), [['Import', 'Khách Import'], ['Mỹ Tiền', 'Mới']]);
});
