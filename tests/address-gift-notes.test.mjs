import test from 'node:test';
import assert from 'node:assert/strict';
// Danh mục thử nạp TRƯỚC mọi thứ dưới app/ (file kho đọc danh mục, quà).
import './helpers/seed-catalog.mjs';
import { addressGiftNotes, buildExportRows } from '../app/order-export.mjs';

// 14/10 chủ shop: quà ghi trong ngoặc đầu địa chỉ ("(Live Tặng yến mạch 2 túi)", "( tặng bát muỗng dừa)") thì file
// kho thêm dòng quà; chỉ "(Live)" = quà Live (hiện là Quạt → QUAT), có quà khác thì nhân viên ghi khác; "đổi … lấy …"
// thì thêm quà đổi sang; dòng quà luôn 0đ.
const plain = value => JSON.parse(JSON.stringify(value));
const headers = ['Nguồn đơn', 'Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Địa chỉ', 'Tỉnh/Thành phố', 'Quận/Huyện', 'Phường/Xã', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá'];
const street = (note, id) => `${note} ${id} đường số 8, Phường 11, Quận 6, Hồ Chí Minh`;
const row = (id, note, sku, quantity, price) => ['Import', id, `Khách ${id}`, '0934000001', street(note, id), 'Hồ Chí Minh', 'Quận 6', 'Phường 11', 'Granola', sku, String(quantity), String(price)];
const lines = rows => rows.map(item => `${item[19]}x${item[21]}@${item[22]}`);

test('đọc ghi chú quà ở ngoặc đầu địa chỉ', () => {
  assert.deepEqual(plain(addressGiftNotes('(Live Tặng yến mạch 2 túi) Số 5 Đường D2')), { lines: [{ sku: 'HT-YM-T500', quantity: 2 }], unknown: [], liveOnly: false });
  assert.deepEqual(plain(addressGiftNotes('( tặng bát muỗng dừa) 360 Hùng Vương').lines), [{ sku: 'BGD', quantity: 1 }, { sku: 'MUONG', quantity: 1 }]);
  assert.deepEqual(plain(addressGiftNotes('(Tặng BGD) Tổ 9')).lines, [{ sku: 'BGD', quantity: 1 }]);
  assert.deepEqual(plain(addressGiftNotes('(Live đổi quạt lấy bát muỗng) 12 Lê Lợi').lines), [{ sku: 'BGD', quantity: 1 }, { sku: 'MUONG', quantity: 1 }]);
  assert.deepEqual(plain(addressGiftNotes('(Tặng TKQ-G20) 12 Lê Lợi').lines), [{ sku: 'TKQ-G20', quantity: 1 }]);
  assert.equal(addressGiftNotes('(Live) 46 Lê Lai').liveOnly, true);
  assert.equal(addressGiftNotes('(LIVE) Dc khu phố 5').liveOnly, true);
  assert.deepEqual(plain(addressGiftNotes('(Tặng túi vải) 12 Lê Lợi')).unknown, ['tui vai']);
  // Ngoặc giữa địa chỉ không phải ghi chú quà.
  assert.deepEqual(plain(addressGiftNotes('Lô 16a đường số 9 (giao giờ hành chánh)')), { lines: [], unknown: [], liveOnly: false });
});

test('file kho: "(Live)" 1 túi không quà, combo 2 chưa có quà → thêm QUAT + BGD (quà Live 14/10); đã có quà giữ nguyên; ghi chú tặng thêm dòng 0đ; quà Live 50.000đ thành 0đ', () => {
  const rows = buildExportRows({ headers, rows: [
    row('A1', '(Live)', 'GRA-XANH-Z450', 1, 189000),
    row('A2', '(Live)', 'CB2-XANH-Z450', 1, 298000), row('A2', '(Live)', 'QUA-TANG-LIVE', 1, 50000),
    row('A3', '(Live)', 'CB2-VANGG', 1, 298000), row('A3', '(Live)', 'BGD', 1, 0), row('A3', '(Live)', 'MUONG', 1, 0),
    row('A4', '(Live Tặng yến mạch 2 túi)', 'GRA-XANH-Z450', 2, 149000),
    row('A5', '( tặng bát muỗng dừa)', 'GRA-XANH-Z450', 3, 149000), row('A5', '( tặng bát muỗng dừa)', 'BGD', 1, 0),
    row('A6', '', 'GRA-XANH-Z450', 1, 189000)
  ] });
  const byOrder = [];
  rows.forEach(item => { if (item[0] !== '') byOrder.push([]); byOrder.at(-1).push(item); });
  assert.deepEqual(byOrder.map(lines), [
    ['GRA-XANH-Z450x1@189000'],
    ['GRA-XANH-Z450x2@149000', 'QUATx1@0', 'BGDx1@0'],
    ['GRA-VANG-H350x2@149000', 'BGDx1@0', 'MUONGx1@0'],
    ['GRA-XANH-Z450x2@149000', 'HT-YM-T500x2@0'],
    ['GRA-XANH-Z450x3@149000', 'BGDx1@0', 'MUONGx1@0'],
    ['GRA-XANH-Z450x1@189000']
  ]);
  assert.deepEqual(plain(rows.skuCheck), { unknown: [], giftNotes: [] });
});

test('luật quà theo số túi: 1 túi bỏ quà (kể cả dòng quà tệp POS); combo 2 đã tặng sản phẩm bỏ bát/muỗng/quạt; combo 3 giữ cả hai', () => {
  const rows = buildExportRows({ headers, rows: [
    row('B1', '', 'GRA-XANH-Z450', 1, 189000), row('B1', '', 'BGD', 1, 0),
    row('B2', '(Tặng yến mạch)', 'CB2-XANH-Z450', 1, 298000), row('B2', '(Tặng yến mạch)', 'QUA-TANG-LIVE', 1, 0), row('B2', '(Tặng yến mạch)', 'BGD', 1, 0),
    row('B3', '(Tặng yến mạch)', 'CB3-XANH-Z450+BGD+M', 1, 447000),
    row('B4', '(Live)', 'CB10-XANH-G35', 1, 204000)
  ] });
  const byOrder = [];
  rows.forEach(item => { if (item[0] !== '') byOrder.push([]); byOrder.at(-1).push(item); });
  assert.deepEqual(byOrder.map(lines), [
    ['GRA-XANH-Z450x1@189000'],
    ['GRA-XANH-Z450x2@149000', 'HT-YM-T500x1@0'],
    ['GRA-XANH-Z450x3@149000', 'BGDx1@0', 'MUONGx1@0', 'HT-YM-T500x1@0'],
    ['GRA-XANH-G35x10@20400']
  ]);
});

test('NOTE nhắc sản phẩm khác → đổi sản phẩm theo note; 10 gói đi kèm sản phẩm khác → giá combo', async () => {
  const { noteProductSwap } = await import('../app/order-export.mjs');
  assert.deepEqual(plain(noteProductSwap('2 XANH')), [{ sku: 'GRA-XANH-Z450', quantity: 2 }]);
  assert.deepEqual(plain(noteProductSwap('1 xanh 1 vàng')), [{ sku: 'GRA-XANH-Z450', quantity: 1 }, { sku: 'GRA-VANG-H350', quantity: 1 }]);
  assert.deepEqual(plain(noteProductSwap('GTC 2, ok')), []);
  const noted = (id, note, sku, quantity, price) => { const item = row(id, '', sku, quantity, price); return [...item, note]; };
  const rows = buildExportRows({ headers: [...headers, 'Ghi chú xử lý'], rows: [
    noted('C1', '2 XANH', 'CB2-VANGG', 1, 298000),
    noted('C2', 'GTC 2', 'CB2-VANGG', 1, 298000),
    noted('C3', '', 'GRA-XANH-Z450', 1, 149000), noted('C3', '', 'CB10-CAM-G30', 1, 189000), noted('C3', '', 'QUA-TANG-LIVE', 1, 0),
    noted('C4', '', 'CB10-CAM-G30', 2, 189000),
    noted('C5', '', 'CB10-CAM-G30', 1, 189000),
    noted('C6', '', 'GRA-XANH-Z450', 2, 174000), noted('C6', '', 'GRA-VANG-H350', 1, 174000),
    noted('C7', '', 'GRA-XANH-Z450', 1, 174000)
  ] });
  const byOrder = [];
  rows.forEach(item => { if (item[0] !== '') byOrder.push([]); byOrder.at(-1).push(item); });
  assert.deepEqual(byOrder.map(lines), [
    ['GRA-XANH-Z450x2@149000'],
    ['GRA-VANG-H350x2@149000'],
    ['GRA-XANH-Z450x1@149000', 'GRA-CAM-G30x10@17900', 'QUATx1@0'],
    ['GRA-CAM-G30x20@17900'],
    ['GRA-CAM-G30x10@18900'],
    ['GRA-XANH-Z450x2@149000', 'GRA-VANG-H350x1@149000', 'BGDx1@0', 'MUONGx1@0'],
    ['GRA-XANH-Z450x1@174000']
  ]);
});
