import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildDashboard, dashboardRange, dashboardTodo, normalizeDashboardCustomRange, normalizeDashboardDays } from '../app/dashboard.mjs';

// 29/09/2026 10:00 giờ Việt Nam: 7 ngày = 23/09 → 29/09, kỳ trước 16/09 → 22/09.
const now = Date.parse('2026-09-29T03:00:00Z');
const at = (date, hour = 10) => Date.parse(`${date}T00:00:00Z`) + (hour - 7) * 60 * 60 * 1000;
const address = { address: '12 Lê Lợi, Phường 1, Quận 3, TP Hồ Chí Minh', street: '12 Lê Lợi', ward: 'Phường 1', district: 'Quận 3', province: 'TP Hồ Chí Minh' };
const order = (id, date, total, extra = {}) => ({
  id, createdAt: at(date), total, status: 'Mới', source: 'Facebook', automatic: true, employee: 'Chatbot AI', phone: '0912345678',
  products: [{ sku: 'GX', name: 'Granola Xanh', quantity: 1, price: total }], ...address, ...extra
});
const incoming = (date, hour = 10) => ({ direction: 'incoming', createdAt: at(date, hour), text: 'hi' });
const outgoing = (date, hour = 10) => ({ direction: 'outgoing', createdAt: at(date, hour), text: 'chào' });

function fixture() {
  const conversations = [
    // Khách A: đơn đầu tiên 10/09 (trước cả kỳ trước), đơn 28/09 → không phải khách mới.
    { id: 'p:a', pageId: 'p', psid: 'a', source: 'inbox', lastCustomerMessageAt: at('2026-09-28'), labels: [], customerOrders: [
      order('a1', '2026-09-10', 100000, { phone: '0911111111' }),
      order('a2', '2026-09-28', 298000, { phone: '0911111111', products: [{ sku: 'GX', name: 'Granola Xanh', quantity: 2, price: 149000 }] })
    ] },
    // Khách B: đơn đầu 29/09 (mới), một đơn hủy cùng ngày (không tính), nhân viên lên tay.
    { id: 'p:b', pageId: 'p', psid: 'b', source: 'inbox', lastCustomerMessageAt: at('2026-09-29', 9), labels: ['consulting'], customerOrders: [
      order('b1', '2026-09-29', 159000, { phone: '0922222222', automatic: false, employee: 'Lan', products: [{ sku: 'GV', name: 'Granola Vàng', quantity: 1, price: 159000 }] }),
      order('b2', '2026-09-29', 999000, { phone: '0922222222', processingStatus: 'cancelled', status: 'Hủy' })
    ] },
    // Khách C: kỳ trước (20/09), khách mới của kỳ trước; đơn POS.
    { id: 'p:c', pageId: 'p', psid: 'c', source: 'inbox', lastCustomerMessageAt: at('2026-09-20'), labels: ['complaint'], customerOrders: [
      order('c1', '2026-09-20', 200000, { phone: '0933333333', source: 'POS', automatic: false, employee: 'Hà' })
    ] },
    // Chỉ nhắn tin trong kỳ, không mua.
    { id: 'p:d', pageId: 'p', psid: 'd', source: 'inbox', lastCustomerMessageAt: at('2026-09-26'), labels: [] },
    // Luồng bình luận: không tính là cuộc trò chuyện.
    { id: 'p:comment:e:post', pageId: 'p', psid: 'e', source: 'comment', lastCustomerMessageAt: at('2026-09-27'), labels: ['consulting'] },
    // Tin khách cũ: bỏ qua nhanh.
    { id: 'p:f', pageId: 'p', psid: 'f', source: 'inbox', lastCustomerMessageAt: at('2026-08-01'), labels: [] }
  ];
  const messages = {
    'p:a': [incoming('2026-09-10'), outgoing('2026-09-10'), incoming('2026-09-27'), incoming('2026-09-28'), outgoing('2026-09-28')],
    'p:b': [incoming('2026-09-18'), incoming('2026-09-29', 9)],
    'p:c': [incoming('2026-09-20')],
    // Chỉ Page nhắn trong kỳ + tin khách trong kỳ.
    'p:d': [outgoing('2026-09-24'), incoming('2026-09-26')],
    'p:comment:e:post': [incoming('2026-09-27')],
    'p:f': [incoming('2026-08-01')]
  };
  const landingOrders = [
    // Landing mới 27/09, khách mới; địa chỉ thiếu → việc "thiếu thông tin".
    { id: 'l1', createdAt: at('2026-09-27'), total: 447000, status: 'Mới', source: 'Landing page', employee: 'Landing page', phone: '0944444444', address: 'Chưa có địa chỉ',
      products: [{ sku: 'GX', name: 'Granola Xanh', quantity: 3, price: 149000 }], landing: { needsAddress: true, campaign: 'utm_campaign=c1' } },
    // Form bỏ dở: không tính doanh thu, là việc "thiếu thông tin".
    { id: 'l2', createdAt: at('2026-09-28'), total: 149000, status: 'Chưa hoàn tất', source: 'Landing page', employee: 'Landing page', phone: '0955555555', ...address,
      products: [{ sku: 'GX', name: 'Granola Xanh', quantity: 1, price: 149000 }], landing: { incomplete: true } },
    // Đủ thông tin nhưng máy tự điền sản phẩm → cần duyệt.
    { id: 'l3', createdAt: at('2026-09-29', 8), total: 149000, status: 'Mới', source: 'Landing page', employee: 'Landing page', phone: '0966666666', ...address,
      products: [{ sku: 'GX', name: 'Granola Xanh', quantity: 1, price: 149000 }], landing: { autoFilled: { product: 'Granola Xanh x1' } } },
    // Đã xác nhận: không còn là việc.
    { id: 'l4', createdAt: at('2026-09-29', 8), total: 149000, status: 'Đã xác nhận', processingStatus: 'confirmed', source: 'Landing page', employee: 'Landing page', phone: '0977777777', address: 'Chưa có địa chỉ',
      products: [{ sku: 'GX', name: 'Granola Xanh', quantity: 1, price: 149000 }], landing: {} }
  ];
  const adStore = {
    syncedAt: now - 1000,
    campaigns: {
      c1: { id: 'c1', name: 'Granola chuyển đổi', status: 'ACTIVE' },
      c2: { id: 'c2', name: 'Cũ', status: 'PAUSED' }
    },
    ads: { a1: { campaignId: 'c1' }, a2: { campaignId: 'c2' } },
    daily: [
      { date: '2026-09-28', campaignId: 'c1', adId: 'a1', spend: 100000 },
      { date: '2026-09-29', campaignId: 'c1', adId: 'a1', spend: 50000 },
      { date: '2026-09-20', campaignId: 'c2', adId: 'a2', spend: 40000 }
    ]
  };
  const labels = [{ id: 'consulting', auto: 'handoff' }, { id: 'complaint', auto: 'complaint' }, { id: 'customer', auto: 'order' }];
  return { conversations, messages, landingOrders, adStore, labels };
}

test('khoảng Tổng quan chỉ nhận 1/7/30, mặc định 7', () => {
  assert.equal(normalizeDashboardDays('1'), 1);
  assert.equal(normalizeDashboardDays('30'), 30);
  assert.equal(normalizeDashboardDays('14'), 7);
  assert.equal(normalizeDashboardDays(undefined), 7);
});

test('Tổng quan 7 ngày: KPI so với kỳ trước, hủy/bỏ dở không tính, khách mới theo đơn đầu tiên', () => {
  const ads = { connected: true, accounts: ['act_1'], syncedAt: now - 1000 };
  const result = buildDashboard({ ...fixture(), followUpQueueLength: 3, days: 7, now, ads });
  assert.deepEqual(result.range, { since: '2026-09-23', until: '2026-09-29', days: 7 });
  assert.deepEqual(result.previous, { since: '2026-09-16', until: '2026-09-22' });
  const { kpis } = result;
  // Kỳ này: a2 298k, b1 159k, l1 447k, l3 149k, l4 149k (đã xác nhận vẫn là đơn) = 1.202.000 / 5 đơn. Kỳ trước: c1 200k.
  assert.deepEqual(kpis.revenue, { value: 1202000, prev: 200000 });
  assert.deepEqual(kpis.orders, { value: 5, prev: 1 });
  assert.deepEqual(kpis.aov, { value: 240400, prev: 200000 });
  assert.deepEqual(kpis.spend, { value: 150000, prev: 40000 });
  // ROAS chung một định nghĩa với Chiến dịch: chỉ l1 (utm c1) là doanh thu quảng cáo; kỳ trước c2 tiêu 40k mà 0 đơn.
  // (Trước đây: mọi doanh thu ÷ chi phí = 8,01 / 5.)
  assert.deepEqual(kpis.roas, { value: 2.98, prev: 0 });
  // Mới kỳ này: B, landing l1, l3, l4 (A mua từ 10/09). Kỳ trước: C.
  assert.deepEqual(kpis.newCustomers, { value: 4, prev: 1 });
  // Kỳ này: a, b, d (bình luận không tính); kỳ trước: b (18/09), c.
  assert.deepEqual(kpis.conversations, { value: 3, prev: 2 });
  // Có đơn: a, b trên 3 cuộc; kỳ trước: c trên 2.
  assert.deepEqual(kpis.conversionRate, { value: 0.6667, prev: 0.5 });
  assert.deepEqual(kpis.activeCampaigns, { value: 1 });

  assert.equal(result.daily.length, 7);
  assert.deepEqual(result.daily[0], { date: '2026-09-23', revenue: 0, orders: 0, spend: 0, conversations: 0 });
  assert.deepEqual(result.daily.find(day => day.date === '2026-09-28'), { date: '2026-09-28', revenue: 298000, orders: 1, spend: 100000, conversations: 1 });
  assert.deepEqual(result.daily.at(-1), { date: '2026-09-29', revenue: 457000, orders: 3, spend: 50000, conversations: 1 });

  assert.deepEqual(result.sources, [
    { key: 'landing', label: 'Landing page', orders: 3, revenue: 745000 },
    { key: 'chatbot', label: 'Chatbot', orders: 1, revenue: 298000 },
    { key: 'import', label: 'Nhập tay', orders: 1, revenue: 159000 }
  ]);
  assert.deepEqual(result.topProducts, [
    { sku: 'GX', name: 'Granola Xanh', quantity: 7, revenue: 1043000 },
    { sku: 'GV', name: 'Granola Vàng', quantity: 1, revenue: 159000 }
  ]);
  assert.deepEqual(result.topCampaigns, [{ id: 'c1', name: 'Granola chuyển đổi', source: 'meta', spend: 150000, orders: 1, revenue: 447000, roas: 2.98 }]);
  // l1 thiếu địa chỉ + l2 bỏ dở = thiếu thông tin; l3 tự điền = cần duyệt; B (Cần người xử lý) + C (Khiếu nại) — luồng bình luận cũng tính.
  assert.deepEqual(result.todo, { ordersToReview: 1, ordersIncomplete: 2, conversationsNeedStaff: 3, followUpQueue: 3 });
  assert.deepEqual(result.ads, { connected: true, syncedAt: now - 1000 });
});

test('Tổng quan hôm nay: một dòng theo ngày, kỳ trước là hôm qua; lỗi quảng cáo hiện ra', () => {
  const result = buildDashboard({ ...fixture(), days: 1, now, ads: { connected: true, syncedAt: 5, error: 'Token hết hạn' } });
  assert.deepEqual(result.range, { since: '2026-09-29', until: '2026-09-29', days: 1 });
  assert.deepEqual(result.previous, { since: '2026-09-28', until: '2026-09-28' });
  assert.equal(result.daily.length, 1);
  assert.deepEqual(result.kpis.orders, { value: 3, prev: 1 });
  assert.deepEqual(result.kpis.revenue, { value: 457000, prev: 298000 });
  // Meta Ads lỗi mà kho còn số cũ: cảnh báo "dữ liệu đến …" thay vì hiện số cũ như số mới.
  assert.equal(result.ads.error, 'Token hết hạn');
  assert.equal(result.ads.stale, true);
  assert.equal(result.ads.dataUntil, 5);
  assert.match(result.ads.notice, /dữ liệu đến 07:00 01\/01\/1970 \(Meta Ads đang lỗi\)/);
});

test('Tổng quan trống: không chia cho 0 (aov/roas/tỷ lệ null), ngày vẫn đủ', () => {
  const result = buildDashboard({ days: 30, now });
  assert.equal(result.daily.length, 30);
  assert.deepEqual(result.kpis.aov, { value: null, prev: null });
  assert.deepEqual(result.kpis.roas, { value: null, prev: null });
  assert.deepEqual(result.kpis.spend, { value: null, prev: null }, 'chưa nối quảng cáo: chi tiêu không biết, không phải 0');
  assert.deepEqual(result.kpis.conversionRate, { value: null, prev: null });
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.topCampaigns, []);
  assert.deepEqual(result.todo, { ordersToReview: 0, ordersIncomplete: 0, conversationsNeedStaff: 0, followUpQueue: 0 });
  assert.deepEqual(result.ads, { connected: false, syncedAt: null });
});

test('việc cần làm: đơn quá 30 ngày hay đã ẩn khỏi bảng không tính; không có cài đặt thẻ thì dùng thẻ mặc định', () => {
  const todo = dashboardTodo({
    conversations: [{ id: 'x', labels: ['consulting'], customerOrders: [
      { id: 'old', createdAt: at('2026-08-01'), address: 'Chưa có địa chỉ', products: [] },
      { id: 'hidden', createdAt: at('2026-09-28'), hiddenFromTable: true, address: 'Chưa có địa chỉ', products: [] }
    ] }],
    now
  });
  assert.deepEqual(todo, { ordersToReview: 0, ordersIncomplete: 0, conversationsNeedStaff: 1, followUpQueue: 0 });
});

test('máy chủ nối route /api/dashboard', async () => {
  const server = (await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(server, /import \{ loadDashboard, normalizeDashboardCustomRange, normalizeDashboardDays \} from '\.\/dashboard\.mjs'/);
  const start = server.indexOf("url.pathname === '/api/dashboard')");
  assert.ok(start >= 0);
  const route = server.slice(start, start + 700);
  assert.match(route, /url\.searchParams\.get\('from'\)[\s\S]*url\.searchParams\.get\('to'\)/);
  // from/to có mà sai → 400, không lặng lẽ rơi về 7 ngày.
  assert.match(route, /\(from \|\| to\) && !normalizeDashboardCustomRange\(from, to\)\)[\s\S]{0,80}sendJson\(response, 400/);
  assert.match(route, /loadDashboard\(\{ days: normalizeDashboardDays\(url\.searchParams\.get\('days'\)\), from, to \}\)/);
});

test('chưa nối quảng cáo: chi tiêu và ROAS là null dù kho còn số cũ; tỷ lệ là số 0..1', () => {
  const result = buildDashboard({ ...fixture(), days: 7, now, ads: { connected: false, syncedAt: null } });
  assert.deepEqual(result.kpis.spend, { value: null, prev: null });
  assert.deepEqual(result.kpis.roas, { value: null, prev: null });
  assert.ok(result.kpis.conversionRate.value > 0 && result.kpis.conversionRate.value <= 1);
  assert.equal(result.ads.connected, false);
});

test('khoảng tự chọn: kiểm hợp lệ, đổi chỗ khi đảo ngược, không quá hôm nay, tối đa 366 ngày', () => {
  assert.deepEqual(normalizeDashboardCustomRange('2026-09-01', '2026-09-10', now), { since: '2026-09-01', until: '2026-09-10', days: 10, custom: true });
  assert.deepEqual(normalizeDashboardCustomRange('2026-09-10', '2026-09-01', now), { since: '2026-09-01', until: '2026-09-10', days: 10, custom: true }, 'đảo ngược → đổi chỗ');
  assert.deepEqual(normalizeDashboardCustomRange('2026-09-05', '2026-09-05', now), { since: '2026-09-05', until: '2026-09-05', days: 1, custom: true }, 'một ngày');
  // Hôm nay giờ Việt Nam là 29/09: ngày cuối sau đó lùi về hôm nay; cả khoảng ở tương lai thành hôm nay.
  assert.deepEqual(normalizeDashboardCustomRange('2026-09-25', '2026-10-15', now), { since: '2026-09-25', until: '2026-09-29', days: 5, custom: true });
  assert.deepEqual(normalizeDashboardCustomRange('2026-10-05', '2026-10-15', now), { since: '2026-09-29', until: '2026-09-29', days: 1, custom: true });
  // Dài quá 366 ngày: cắt phía đầu.
  assert.deepEqual(normalizeDashboardCustomRange('2020-01-01', '2026-09-29', now), { since: '2025-09-29', until: '2026-09-29', days: 366, custom: true });
  for (const [from, to] of [['2026-09-01', undefined], [undefined, '2026-09-01'], ['2026-02-30', '2026-03-01'], ['01/09/2026', '2026-09-10'], ['2026-9-1', '2026-09-10'], ['', '']]) {
    assert.equal(normalizeDashboardCustomRange(from, to, now), null, `${from} → ${to}`);
  }
});

test('dashboardRange: kỳ trước cùng độ dài liền trước; preset giữ nguyên; from/to sai thì về days', () => {
  assert.deepEqual(dashboardRange({ from: '2026-09-01', to: '2026-09-10', now }), {
    range: { since: '2026-09-01', until: '2026-09-10', days: 10, custom: true },
    previous: { since: '2026-08-22', until: '2026-08-31' }
  });
  // Qua cuối tháng 2.
  assert.deepEqual(dashboardRange({ from: '2026-03-01', to: '2026-03-03', now }).previous, { since: '2026-02-26', until: '2026-02-28' });
  assert.deepEqual(dashboardRange({ days: 30, now }), { range: { since: '2026-08-31', until: '2026-09-29', days: 30 }, previous: { since: '2026-08-01', until: '2026-08-30' } });
  assert.deepEqual(dashboardRange({ days: 7, from: 'xấu', to: '2026-09-10', now }).range, { since: '2026-09-23', until: '2026-09-29', days: 7 });
  // 23:30 giờ Việt Nam ngày 29/09 (16:30 UTC) vẫn là 29/09; 00:30 ngày 30/09 (17:30 UTC) đã sang 30/09.
  assert.equal(normalizeDashboardCustomRange('2026-09-29', '2026-09-30', Date.parse('2026-09-29T16:30:00Z')).until, '2026-09-29');
  assert.equal(normalizeDashboardCustomRange('2026-09-29', '2026-09-30', Date.parse('2026-09-29T17:30:00Z')).until, '2026-09-30');
});

test('Tổng quan khoảng tự chọn: mọi thẻ tính trong khoảng, so với kỳ liền trước cùng độ dài', () => {
  const ads = { connected: true, accounts: ['act_1'], syncedAt: now - 1000 };
  // 27/09 → 28/09 (2 ngày, tính cả 28/09); kỳ trước 25/09 → 26/09.
  const result = buildDashboard({ ...fixture(), from: '2026-09-27', to: '2026-09-28', now, ads });
  assert.deepEqual(result.range, { since: '2026-09-27', until: '2026-09-28', days: 2, custom: true });
  assert.deepEqual(result.previous, { since: '2026-09-25', until: '2026-09-26' });
  // Kỳ này: l1 447k (27/09), a2 298k (28/09); l2 bỏ dở không tính. Kỳ trước không có đơn.
  assert.deepEqual(result.kpis.revenue, { value: 745000, prev: 0 });
  assert.deepEqual(result.kpis.orders, { value: 2, prev: 0 });
  assert.deepEqual(result.kpis.aov, { value: 372500, prev: null });
  assert.deepEqual(result.kpis.spend, { value: 100000, prev: 0 });
  // l1 mới; A đã mua từ 10/09.
  assert.deepEqual(result.kpis.newCustomers, { value: 1, prev: 0 });
  // Kỳ này: a (27, 28/09); kỳ trước: d (26/09).
  assert.deepEqual(result.kpis.conversations, { value: 1, prev: 1 });
  assert.deepEqual(result.kpis.conversionRate, { value: 1, prev: 0 });
  assert.deepEqual(result.daily.map(day => day.date), ['2026-09-27', '2026-09-28']);
  assert.deepEqual(result.daily[1], { date: '2026-09-28', revenue: 298000, orders: 1, spend: 100000, conversations: 1 });
  assert.deepEqual(result.sources.map(source => source.key), ['landing', 'chatbot']);
  assert.deepEqual(result.topProducts, [{ sku: 'GX', name: 'Granola Xanh', quantity: 5, revenue: 745000 }]);
  assert.deepEqual(result.topCampaigns.map(row => [row.id, row.spend, row.orders, row.revenue]), [['c1', 100000, 1, 447000]]);
  assert.equal(result.kpis.roas.value, 4.47);
  // Kỳ dài hơn: 16/09 → 29/09 (14 ngày) so với 02/09 → 15/09; a1 10/09 rơi vào kỳ trước.
  const long = buildDashboard({ ...fixture(), from: '2026-09-16', to: '2026-09-29', now, ads });
  assert.deepEqual(long.previous, { since: '2026-09-02', until: '2026-09-15' });
  assert.deepEqual(long.kpis.orders, { value: 6, prev: 1 });
  assert.deepEqual(long.kpis.revenue, { value: 1402000, prev: 100000 });
  assert.equal(long.daily.length, 14);
});
