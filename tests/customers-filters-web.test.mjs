import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 10/10 (chủ shop): thanh lọc màn Khách hàng có "Số đơn hàng" và "Thời gian mua". Ô chọn trên trang không gửi
// thẳng lên API mà đổi ra minOrders/maxOrders và orderedFrom/orderedTo (ngày theo lịch Việt Nam) — cắt đúng
// các hàm đó từ web/app.js chạy riêng với giờ đóng cứng.
const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const html = (await readFile(new URL('../web/index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

const fn = name => {
  const start = web.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `không tìm thấy hàm ${name}`);
  const end = web.indexOf('\n}\n', start);
  return web.slice(start, end + 3);
};
const statement = (head, close) => {
  const start = web.indexOf(head);
  assert.ok(start >= 0, `không tìm thấy ${head}`);
  return web.slice(start, web.indexOf(close, start) + close.length);
};

/** Chạy customersQueryString với các ô lọc mang giá trị cho sẵn, đồng hồ dừng ở `nowIso`. */
function queryFor(nowIso, values = {}) {
  const fixed = Date.parse(nowIso);
  class FixedDate extends Date { static now() { return fixed; } }
  const filters = Object.fromEntries(['q', 'source', 'label', 'orders', 'bought', 'boughtFrom', 'boughtTo']
    .map(key => [key, { value: values[key] || '' }]));
  const context = vm.createContext({ Date: FixedDate, URLSearchParams, customersFilters: filters });
  vm.runInContext([
    statement('const customersDerivedKeys = ', ';\n'),
    fn('vietnamDateBack'),
    statement('const customersBoughtPresets = {', '\n};\n'),
    fn('customersQueryString')
  ].join('\n'), context);
  return vm.runInContext('customersQueryString()', context);
}

const optionValues = id => {
  const select = new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
  assert.ok(select, `trang có ô #${id}`);
  return [...select[1].matchAll(/<option value="([^"]*)"/g)].map(match => match[1]);
};

test('ô Số đơn hàng: "1-1" là đúng 1 đơn, "3-" là từ 3 đơn trở lên; giá trị ô không bị gửi thô', () => {
  const values = optionValues('customers-orders');
  assert.equal(values[0], '', 'mặc định không lọc');
  for (const value of values.slice(1)) assert.match(value, /^[1-9]\d*-(?:[1-9]\d*)?$/, `giá trị "${value}" phải là từ-đến`);
  assert.equal(queryFor('2026-10-10T01:00:00Z', { orders: '1-1' }), 'minOrders=1&maxOrders=1');
  assert.equal(queryFor('2026-10-10T01:00:00Z', { orders: '2-2' }), 'minOrders=2&maxOrders=2');
  assert.equal(queryFor('2026-10-10T01:00:00Z', { orders: '3-' }), 'minOrders=3');
  assert.equal(queryFor('2026-10-10T01:00:00Z', {}), '', 'không chọn gì thì không có tham số nào');
});

test('ô Thời gian mua: mốc sẵn đổi ra ngày lịch Việt Nam lúc gửi, "Chọn khoảng ngày" lấy hai ô ngày', () => {
  const presets = optionValues('customers-bought');
  assert.equal(presets[0], '', 'mặc định không lọc');
  assert.deepEqual(presets.slice(1), ['today', '7', '30', '90', 'over30', 'over60', 'over90', 'range']);
  const at = '2026-10-10T01:00:00Z'; // 08:00 sáng 10/10 giờ Việt Nam
  assert.equal(queryFor(at, { bought: 'today' }), 'orderedFrom=2026-10-10');
  assert.equal(queryFor(at, { bought: '7' }), 'orderedFrom=2026-10-04', '7 ngày qua gồm hôm nay và 6 ngày trước');
  assert.equal(queryFor(at, { bought: '30' }), 'orderedFrom=2026-09-11');
  assert.equal(queryFor(at, { bought: '90' }), 'orderedFrom=2026-07-13');
  assert.equal(queryFor(at, { bought: 'over30' }), 'orderedTo=2026-09-09', 'hơn 30 ngày: mua lần cuối từ 31 ngày trước trở về trước');
  assert.equal(queryFor(at, { bought: 'over60' }), 'orderedTo=2026-08-10');
  assert.equal(queryFor(at, { bought: 'over90' }), 'orderedTo=2026-07-11');
  // 01:30 sáng 10/10 giờ Việt Nam vẫn là 18:30 ngày 09/10 giờ UTC: "hôm nay" phải là 10/10.
  assert.equal(queryFor('2026-10-09T18:30:00Z', { bought: 'today' }), 'orderedFrom=2026-10-10');

  assert.equal(queryFor(at, { bought: 'range', boughtFrom: '2026-09-01', boughtTo: '2026-09-30' }), 'orderedFrom=2026-09-01&orderedTo=2026-09-30');
  assert.equal(queryFor(at, { bought: 'range', boughtTo: '2026-09-30' }), 'orderedTo=2026-09-30', 'chỉ chọn một đầu cũng lọc được');
  assert.equal(queryFor(at, { bought: 'range' }), '', 'chưa chọn ngày thì chưa lọc');
  assert.equal(queryFor(at, { bought: '', boughtFrom: '2026-09-01' }), '', 'ô ngày còn giá trị cũ nhưng đã bỏ "Chọn khoảng ngày": không lọc');
  assert.equal(queryFor(at, { q: 'lan', source: 'ads', orders: '2-', bought: '90' }), 'q=lan&source=ads&minOrders=2&orderedFrom=2026-07-13');
});

test('hai ô lọc nằm trên thanh chính, không còn bản cũ trong "Lọc thêm"', () => {
  const main = html.slice(html.indexOf('<div class="customers-toolbar">'), html.indexOf('id="customers-more-row"'));
  for (const id of ['customers-orders', 'customers-bought', 'customers-bought-from', 'customers-bought-to']) assert.match(main, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(html, /customers-ordered-within|customers-min-orders/);
  assert.match(main, /<span class="customers-date-range hidden" id="customers-bought-range">/, 'hai ô ngày ẩn cho tới khi chọn "Chọn khoảng ngày…"');
});
