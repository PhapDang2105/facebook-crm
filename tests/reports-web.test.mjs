import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Màn Báo cáo là HTML/JS thuần, không có bước build: kiểm dây nối trên mã nguồn.
const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const html = (await readFile(new URL('../web/index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const section = (source, start, length = 4000) => {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `không tìm thấy: ${start}`);
  return source.slice(at, at + length);
};
const fn = name => {
  const start = web.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `không tìm thấy hàm ${name}`);
  const end = web.indexOf('\n}\n', start);
  return web.slice(start, end + 3);
};
const markup = (() => {
  const view = section(html, '<section id="reports-view"', 6000);
  return view.slice(0, view.indexOf('<section id="settings-view"'));
})();

/** Chạy reportsRange/reportsExportUrl với "hôm nay" cố định. */
function rangeHelpers(state, today) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [today])); }
  }
  const context = { Date: FixedDate, URLSearchParams, reportsState: state };
  vm.createContext(context);
  vm.runInContext([
    'const dateKeyOf = date => { const pad = value => String(value).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };',
    fn('dateFromInput'), fn('reportsRange'), fn('reportsQuery'), fn('reportsExportUrl')
  ].join('\n'), context);
  return context;
}

test('showView mở Báo cáo thì nạp /api/reports với from/to/groupBy', () => {
  assert.match(section(web, 'function showView(name)', 1200), /if \(name === 'reports'\) loadReports\(\);/);
  const load = section(web, 'async function loadReports()', 900);
  assert.match(load, /fetch\(`\/api\/reports\?\$\{reportsQuery\(\)\}`\)/);
  assert.match(load, /requestId !== reportsRequestId/, 'chặn kết quả cũ đè kết quả mới');
  assert.match(fn('reportsQuery'), /from: range\.from, to: range\.to, groupBy: range\.groupBy/);
});

test('#reports-view có bảy thẻ, chọn khoảng, hai ô ngày cho Tùy chọn, gom theo và nút Xuất CSV', () => {
  const tabs = [...markup.matchAll(/data-report-tab="(\w+)">([^<]+)</g)].map(match => `${match[1]}:${match[2]}`);
  assert.deepEqual(tabs, ['sales:Doanh thu', 'products:Sản phẩm', 'sources:Nguồn đơn', 'customers:Khách hàng', 'staff:Nhân viên', 'campaigns:Chiến dịch', 'followUps:Bám đuổi']);
  assert.match(markup, /<select id="reports-preset"[\s\S]*value="today">Hôm nay[\s\S]*value="7d">7 ngày[\s\S]*value="30d">30 ngày[\s\S]*value="thisMonth">Tháng này[\s\S]*value="lastMonth">Tháng trước[\s\S]*value="custom">Tùy chọn/);
  assert.match(markup, /id="reports-dates"[^>]*>[\s\S]*<input[^>]*id="reports-from" type="date"[\s\S]*<input[^>]*id="reports-to" type="date"/);
  assert.match(markup, /class="[^"]*hidden[^"]*" id="reports-dates"/, 'ô ngày chỉ hiện khi chọn Tùy chọn');
  assert.match(markup, /<select id="reports-group"[\s\S]*value="day">Ngày[\s\S]*value="week">Tuần[\s\S]*value="month">Tháng/);
  assert.match(markup, /<a [^>]*id="reports-export"[^>]*download>Xuất CSV<\/a>/);
  assert.match(markup, /id="reports-body"/);
});

test('mỗi thẻ có hàm vẽ riêng; chỉ năm thẻ có mục xuất CSV', () => {
  const list = section(web, 'const reportTabList = [', 900);
  const sections = Object.fromEntries([...list.matchAll(/key: '(\w+)', label: '[^']+', section: '(\w*)'/g)].map(match => [match[1], match[2]]));
  assert.deepEqual(sections, { sales: 'sales', products: 'products', sources: 'sources', customers: '', staff: 'staff', campaigns: 'campaigns', followUps: '' });
  const renderers = section(web, 'const reportRenderers = {', 400);
  for (const key of Object.keys(sections)) assert.match(renderers, new RegExp(`${key}: renderReport`), key);
  assert.match(section(web, 'function syncReportsControls()', 1500), /reportsExport\.classList\.toggle\('hidden', !href\)/);
});

test('liên kết CSV mang đúng from/to/groupBy/section; thẻ không xuất được thì rỗng', () => {
  const h = rangeHelpers({ preset: '7d', groupBy: 'week', from: '', to: '' }, new Date(2026, 8, 29, 10));
  assert.equal(h.reportsExportUrl('products'), '/api/reports/export.csv?from=2026-09-23&to=2026-09-29&groupBy=week&section=products');
  assert.equal(h.reportsExportUrl(''), '');
});

test('khoảng ngày theo lựa chọn nhanh và Tùy chọn (đảo lại nếu ngày đầu sau ngày cuối)', () => {
  const today = new Date(2026, 8, 29, 10);
  const range = state => {
    const { from, to } = rangeHelpers({ groupBy: 'day', from: '', to: '', ...state }, today).reportsRange();
    return `${from}..${to}`;
  };
  assert.equal(range({ preset: 'today' }), '2026-09-29..2026-09-29');
  assert.equal(range({ preset: '30d' }), '2026-08-31..2026-09-29');
  assert.equal(range({ preset: 'thisMonth' }), '2026-09-01..2026-09-29');
  assert.equal(range({ preset: 'lastMonth' }), '2026-08-01..2026-08-31');
  assert.equal(range({ preset: 'custom', from: '2026-09-20', to: '2026-09-10' }), '2026-09-10..2026-09-20');
});

test('nhớ thẻ, lựa chọn khoảng và gom theo trong localStorage (có try/catch)', () => {
  assert.match(web, /const reportsStateKey = 'crm-reports-view';/);
  assert.match(fn('saveReportsState'), /writeStoredValue\(reportsStateKey, JSON\.stringify\(reportsState\)\)/);
  assert.match(web, /try \{\s*const saved = JSON\.parse\(readStoredValue\(reportsStateKey, 'null'\)\);/);
});

test('bảng báo cáo sắp xếp được và có dòng Tổng cộng; Bám đuổi so tỷ lệ chốt với nhóm đối chứng', () => {
  const table = fn('reportTableHtml');
  assert.match(table, /sortableHeadHtml\(columns, key, dir\)/);
  assert.match(table, /<tfoot>/);
  assert.match(table, /Tổng cộng/);
  const followUps = fn('renderReportFollowUps');
  assert.match(followUps, /followUps\.sentRate/);
  assert.match(followUps, /followUps\.holdoutRate/);
  assert.match(followUps, /sentRate - holdoutRate/);
});
