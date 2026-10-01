import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Màn Tổng quan là HTML/JS thuần, không có bước build: kiểm dây nối trên mã nguồn
// và chạy thử vài hàm thuần (định dạng số, mũi tên so kỳ, biểu đồ) trong vm.
const web = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const section = (source, start, length = 4000) => {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `không tìm thấy: ${start}`);
  return source.slice(at, at + length);
};
/** Cắt nguyên thân một hàm cấp cao nhất (tới dòng "}" đầu tiên ở cột 0). */
const fn = name => {
  const start = web.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `không tìm thấy hàm ${name}`);
  const end = web.indexOf('\n}\n', start);
  return web.slice(start, end + 3);
};
const helpers = () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext([
    "function escapeHtml(value) { return String(value).replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[c]); }",
    fn('campaignRoasText'),
    ...['isBlankNumber', 'statCount', 'statMoney', 'statShortMoney', 'ratioToPercent', 'statPercent', 'statDeltaHtml', 'niceChartMax', 'shortDateLabel', 'columnChartHtml', 'hbarListHtml', 'sortCellValue', 'sortRowsBy'].map(fn)
  ].join('\n'), context);
  return context;
};

test('showView mở Tổng quan thì nạp /api/dashboard theo khoảng đang chọn', () => {
  const view = section(web, 'function showView(name)', 1200);
  assert.match(view, /if \(name === 'dashboard'\) loadDashboard\(\);/);
  const load = section(web, 'async function loadDashboard(', 1200);
  assert.match(load, /fetch\(`\/api\/dashboard\?days=\$\{dashboardDays\(\)\}`\)/);
  assert.match(load, /requestId !== dashboardRequestId/, 'chặn kết quả cũ đè kết quả mới');
});

test('#dashboard-view có chọn Hôm nay/7 ngày/30 ngày và đủ khung số liệu', () => {
  const view = section(html, '<section id="dashboard-view"', 4000);
  const markup = view.slice(0, view.indexOf('<section id="messages-view"'));
  assert.match(markup, /data-dashboard-days="1">Hôm nay</);
  assert.match(markup, /data-dashboard-days="7">7 ngày</);
  assert.match(markup, /data-dashboard-days="30">30 ngày</);
  for (const id of ['dashboard-kpis', 'dashboard-trend', 'dashboard-todo', 'dashboard-sources', 'dashboard-top-products', 'dashboard-top-campaigns']) {
    assert.match(markup, new RegExp(`id="${id}"`), id);
  }
  assert.doesNotMatch(markup, /class="cards"/, 'bỏ bốn thẻ tĩnh cũ');
});

test('tám thẻ số theo đúng thứ tự; chi phí trung tính khi so kỳ trước', () => {
  const list = section(web, 'const dashboardKpiList = [', 900).split('];')[0];
  const keys = [...list.matchAll(/key: '(\w+)', label: '([^']+)'/g)].map(match => `${match[1]}:${match[2]}`);
  assert.deepEqual(keys, ['revenue:Doanh thu', 'orders:Đơn', 'aov:Giá trị TB/đơn', 'spend:Chi phí QC', 'roas:ROAS', 'newCustomers:Khách mới', 'conversations:Hội thoại', 'conversionRate:Tỷ lệ chốt']);
  assert.match(list, /key: 'spend'[^\n]*neutral: true/);
});

test('việc cần làm chỉ hiện mục có số > 0 và mở đúng màn', () => {
  const items = section(web, 'const dashboardTodoItems = [', 600);
  assert.match(items, /ordersToReview[\s\S]*showOrderStage\('process'\)/);
  assert.match(items, /conversationsNeedStaff[\s\S]*showView\('messages'\)/);
  assert.match(items, /followUpQueue[\s\S]*openFollowUpQueue/);
  assert.match(section(web, 'function openFollowUpQueue(', 400), /showSettingsSection\('chatbot'\)/);
  assert.match(section(web, 'function renderDashboardTodo(', 400), /Number\(todo\?\.\[item\.key\]\) > 0/);
});

test('khoảng ngày được nhớ trong localStorage có try/catch; tự làm mới 60 giây khi màn đang mở', () => {
  assert.match(fn('readStoredValue'), /try \{[\s\S]*localStorage\.getItem[\s\S]*catch/);
  assert.match(fn('writeStoredValue'), /try \{[\s\S]*localStorage\.setItem[\s\S]*catch/);
  assert.match(web, /const dashboardRefreshMs = 60000;/);
  assert.match(web, /window\.setInterval\(\(\) => \{\s*if \(document\.hidden \|\| !dashboardView \|\| dashboardView\.classList\.contains\('hidden'\)\) return;\s*loadDashboard\(\{ quiet: true \}\);/);
});

test('bấm dòng chiến dịch ở Tổng quan mở màn Quản lý chiến dịch', () => {
  assert.match(web, /closest\('tr\[data-dashboard-campaign\]'\)[\s\S]{0,80}openCampaignFromDashboard/);
});

test('định dạng: rỗng là "—", 0 vẫn là số; mũi tên tăng xanh/giảm đỏ/chi phí trung tính', () => {
  const h = helpers();
  assert.equal(h.statCount(null), '—');
  assert.equal(h.statCount(0), '0');
  assert.equal(h.statMoney(undefined), '—');
  assert.equal(h.statPercent(0.125), '12,5%');
  assert.equal(h.statPercent(null), '—');
  assert.match(h.statShortMoney(12500000), /^12,5 triệu$/);
  assert.match(h.statDeltaHtml(120, 100), /is-up[^>]*>▲ 20%/);
  assert.match(h.statDeltaHtml(80, 100), /is-down[^>]*>▼ 20%/);
  assert.match(h.statDeltaHtml(120, 100, { neutral: true }), /is-flat/);
  assert.equal(h.statDeltaHtml(5, 0), '', 'kỳ trước bằng 0 thì không có phần trăm');
  assert.equal(h.statDeltaHtml(null, 10), '');
});

test('biểu đồ cột: mỗi ngày một cột và một ô chú thích <title>, đường chi phí đi qua đủ điểm', () => {
  const h = helpers();
  const rows = [
    { date: '2026-09-27', revenue: 1000000, spend: 200000 },
    { date: '2026-09-28', revenue: 0, spend: 300000 },
    { date: '2026-09-29', revenue: 2500000, spend: 100000 }
  ];
  const svg = h.columnChartHtml(rows, {
    bars: [{ key: 'revenue', cls: 'is-revenue' }],
    line: { key: 'spend', cls: 'is-spend' },
    label: row => h.shortDateLabel(row.date),
    tip: row => `${row.date} <b>`
  });
  assert.equal((svg.match(/class="is-revenue"/g) || []).length, 2, 'ngày doanh thu 0 không vẽ cột');
  assert.equal((svg.match(/<title>/g) || []).length, 3);
  assert.match(svg, /&lt;b&gt;/, 'chú thích được escape');
  assert.equal(svg.match(/<polyline class="is-spend" points="([^"]+)"/)[1].split(' ').length, 3);
  assert.match(svg, /<span>29\/09<\/span>/);
  assert.equal(h.niceChartMax(2500000), 2500000);
  assert.equal(h.niceChartMax(2600000), 5000000);
});

test('sắp xếp: số rỗng luôn nằm cuối, chuỗi so theo tiếng Việt', () => {
  const h = helpers();
  const rows = [{ v: 2 }, { v: null }, { v: 5 }];
  assert.deepEqual([...h.sortRowsBy(rows, 'v', -1).map(row => row.v)], [5, 2, null]);
  assert.deepEqual([...h.sortRowsBy(rows, 'v', 1).map(row => row.v)], [2, 5, null]);
  assert.deepEqual([...h.sortRowsBy([{ n: 'Bưởi' }, { n: 'Ạ' }], 'n', 1).map(row => row.n)], ['Ạ', 'Bưởi']);
});
