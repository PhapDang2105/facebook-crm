// Số liệu báo cáo/Tổng quan/Chiến dịch (rà 01/10): ROAS chỉ chia doanh thu có
// chi phí tương ứng, đơn hủy/hoàn/bom theo trạng thái mới nhất, đơn trùng đã ẩn,
// gán click quảng cáo, thử lại khi AI lỗi tạm thời, cảnh báo số quảng cáo cũ,
// một định nghĩa ROAS và một định nghĩa khách mới. Không gọi mạng.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCampaignReport } from '../app/campaigns.mjs';
import { buildDashboard } from '../app/dashboard.mjs';
import { buildReport } from '../app/reports.mjs';
import { buildCustomers } from '../app/customers.mjs';
import { collectOrderFacts, isCancelledOrder, isValidFact } from '../app/order-facts.mjs';
import { ADS_STALE_AFTER_MS, countNewCustomers, firstOrderDates, METRIC_DEFINITIONS, roasOf, withAdsFreshness } from '../app/metrics.mjs';
import { applyPosStatus, applyPosStatusesToOrders, indexPosStatuses, matchPosStatus, posStatusUpdate } from '../app/pos-status.mjs';
import { generateCampaignInsights, isRetryableStatus, requestModelText, retryDelayMs } from '../app/campaign-ai.mjs';

// 29/09/2026 10:00 giờ Việt Nam; 7 ngày = 23/09 → 29/09.
const now = Date.parse('2026-09-29T03:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (date, hour = 10) => Date.parse(`${date}T00:00:00Z`) + (hour - 7) * HOUR;
const order = (id, date, total, extra = {}) => ({
  id, createdAt: at(date), total, status: 'Mới', source: 'Facebook', automatic: true, employee: 'Chatbot AI', phone: '0912345678',
  products: [{ sku: 'GX', name: 'Granola Xanh', quantity: 1, price: total }], ...extra
});
const landing = (id, date, total, campaign, extra = {}) => order(id, date, total, { source: 'Landing page', employee: 'Landing page', automatic: false, landing: { campaign: `utm_campaign=${campaign}` }, ...extra });
const adStore = {
  syncedAt: now - HOUR,
  campaigns: { c1: { id: 'c1', name: 'Granola chuyển đổi', status: 'ACTIVE' } },
  ads: { a1: { campaignId: 'c1' } },
  daily: [{ date: '2026-09-28', campaignId: 'c1', adId: 'a1', spend: 100000 }]
};
const ads = { connected: true, accounts: ['act_1'], syncedAt: now - HOUR };

// ===== 1. ROAS không cộng doanh thu UTM không có chi phí =====

test('ROAS: doanh thu UTM không khớp chiến dịch có chi phí hiện riêng, không thổi ROAS lên', () => {
  const landingOrders = [
    landing('l1', '2026-09-28', 200000, 'c1', { phone: '0901000001' }),
    landing('l2', '2026-09-28', 900000, 'zalo-oa', { phone: '0901000002' }),
    landing('l3', '2026-09-28', 600000, 'tiktok-t9', { phone: '0901000003' })
  ];
  const report = buildCampaignReport({ landingOrders, adStore, days: 7, now, ads });
  assert.equal(report.totals.revenue, 200000);
  assert.equal(report.totals.roas, 2, 'chỉ 200k của c1 ÷ 100k chi — trước đây (200k + 1.500k UTM) ÷ 100k = 17');
  assert.deepEqual(report.utm, { orders: 2, revenue: 1500000 });
  assert.equal(report.campaigns.find(row => row.id === 'zalo-oa').roas, null);
  assert.equal('roas' in report.blended, false, 'tổng tất cả đơn không gọi là ROAS');
  assert.equal(roasOf(300, 0), null);
  assert.equal(roasOf(0, 100), 0);
  assert.equal(roasOf(447000, 150000), 2.98);
});

test('chi tiêu không rõ chiến dịch vẫn vào tổng chi phí (không rơi mất khỏi mẫu số ROAS)', () => {
  const store = { ...adStore, daily: [...adStore.daily, { date: '2026-09-28', adId: 'lạ', spend: 100000 }] };
  const report = buildCampaignReport({ landingOrders: [landing('l1', '2026-09-28', 200000, 'c1')], adStore: store, days: 7, now, ads });
  assert.equal(report.totals.spend, 200000);
  assert.equal(report.totals.roas, 1);
  assert.equal(report.campaigns.find(row => row.id === 'meta:unknown').spend, 100000);
});

// ===== 2. Đơn hủy/hoàn/bom theo trạng thái mới nhất =====

test('hủy/hoàn/bom: trạng thái CRM, trạng thái POS lúc đẩy và trạng thái POS đồng bộ sau này', () => {
  assert.equal(isCancelledOrder({ status: 'Bom hàng' }), true);
  assert.equal(isCancelledOrder({ status: 'Boom' }), true);
  assert.equal(isCancelledOrder({ status: 'Giao hàng thất bại' }), true);
  assert.equal(isCancelledOrder({ status: 'Trả hàng' }), true);
  assert.equal(isCancelledOrder({ status: 'Form hoàn tất' }), false);
  assert.equal(isCancelledOrder({ status: 'Mới', pos: { status: 'returned' } }), true);
  // POS hủy/hoàn nhiều ngày sau lúc đặt: mã mới nhất thắng.
  assert.equal(isCancelledOrder({ status: 'Mới', posStatus: { code: 5, name: 'returned' } }), true, 'đã hoàn (bom)');
  assert.equal(isCancelledOrder({ status: 'Mới', posStatus: { code: 4, name: 'returning' } }), true, 'đang hoàn');
  assert.equal(isCancelledOrder({ status: 'Mới', posStatus: { code: 6, name: 'canceled' } }), true);
  assert.equal(isCancelledOrder({ status: 'Mới', posStatus: { code: 3, name: 'delivered' } }), false);
  assert.equal(isCancelledOrder({ status: 'Mới', pos: { status: 'canceled' }, posStatus: { code: 1, name: 'submitted' } }), false, 'POS mở lại đơn: mã mới nhất thắng trạng thái cũ');
  assert.equal(isCancelledOrder({ status: 'Mới', posStatus: { code: 15, name: 'partial_return' } }), false, 'hoàn một phần không xoá cả đơn');
});

test('đơn bom/hoàn sau 48 giờ không còn trong Doanh thu ở Tổng quan, Báo cáo, Chiến dịch; Báo cáo đếm ở cột hủy/hoàn', () => {
  const conversations = [{ id: 'p:a', pageId: 'p', psid: 'a', referrals: [{ source: 'ADS', adId: 'a1', at: at('2026-09-27') }], customerOrders: [
    order('ok', '2026-09-28', 300000, { phone: '0911111111' }),
    // Đặt 28/09, POS báo đã hoàn (bom) về sau — ngoài cửa sổ 48 giờ của lượt kéo đơn mới.
    order('bom', '2026-09-28', 500000, { phone: '0911111111', pos: { id: '9001', status: 'new' }, posStatus: { code: 5, name: 'returned', at: at('2026-09-29') } })
  ] }];
  const dashboard = buildDashboard({ conversations, adStore, days: 7, now, ads });
  assert.equal(dashboard.kpis.revenue.value, 300000);
  assert.equal(dashboard.kpis.orders.value, 1);
  const report = buildReport({ conversations, adStore, from: '2026-09-23', to: '2026-09-29', now, ads });
  assert.equal(report.sales.totals.revenue, 300000);
  assert.equal(report.sales.totals.cancelled, 1);
  assert.equal(report.sales.totals.cancelledValue, 500000);
  const campaigns = buildCampaignReport({ conversations, adStore, days: 7, now, ads });
  assert.equal(campaigns.totals.revenue, 300000);
});

test('pos-status: chép trạng thái POS mới nhất về đúng đơn (landing theo posId, đơn CRM theo custom_id, đơn kéo về theo system_id)', () => {
  const updates = [
    posStatusUpdate({ id: 501, status: 5, status_name: 'returned' }, 1),
    posStatusUpdate({ id: 502, custom_id: 'CRM-abc', status: 6, status_name: 'canceled' }, 1),
    posStatusUpdate({ id: 503, system_id: 77, status: 4, status_name: 'returning' }, 1)
  ];
  const index = indexPosStatuses(updates);
  const landingOrder = { id: 'l', landing: { posId: '501' } };
  const crmOrder = { id: 'abc' };
  const pulled = { id: 'pos77' };
  const untouched = { id: 'x', landing: { posId: '999' } };
  assert.equal(matchPosStatus(crmOrder, index).code, 6);
  assert.equal(applyPosStatusesToOrders([landingOrder, crmOrder, pulled, untouched], updates, index), 3);
  assert.deepEqual(landingOrder.posStatus, { code: 5, name: 'returned', at: 1 });
  assert.equal(pulled.posStatus.code, 4);
  assert.equal(untouched.posStatus, undefined);
  assert.equal(applyPosStatus(landingOrder, updates[0]), false, 'cùng trạng thái thì không ghi lại');
  assert.equal(isCancelledOrder(landingOrder), true);
});

// ===== 3. Đơn trùng đã ẩn =====

test('đơn trùng đã xóa khỏi bảng không đếm; đơn ẩn không có bản thay (Xóa bảng) vẫn đếm', () => {
  const conversations = [{ id: 'p:a', pageId: 'p', psid: 'a', customerOrders: [
    order('keep', '2026-09-28', 300000, { phone: '0911111111' }),
    order('dup', '2026-09-28', 300000, { phone: '0911111111', hiddenFromTable: true }),
    // Khách khác, đơn bị ẩn do "Xóa bảng": không có đơn nào đứng thay → vẫn là đơn thật.
    order('cleared', '2026-09-27', 200000, { phone: '0922222222', hiddenFromTable: true }),
    // Hai đơn cùng ẩn trong 7 ngày: giữ đơn sớm hơn, đơn sau là bản trùng.
    order('h1', '2026-09-25', 150000, { phone: '0933333333', hiddenFromTable: true }),
    order('h2', '2026-09-26', 150000, { phone: '0933333333', hiddenFromTable: true })
  ] }];
  const facts = collectOrderFacts({ conversations });
  const byId = Object.fromEntries(facts.map(fact => [fact.id, fact]));
  assert.equal(byId.dup.duplicate, true);
  assert.equal(byId.keep.duplicate, false);
  assert.equal(byId.cleared.duplicate, false);
  assert.equal(byId.h1.duplicate, false);
  assert.equal(byId.h2.duplicate, true);
  assert.equal(isValidFact(byId.dup), false);
  const dashboard = buildDashboard({ conversations, days: 7, now });
  assert.equal(dashboard.kpis.orders.value, 3);
  assert.equal(dashboard.kpis.revenue.value, 650000);
  const report = buildReport({ conversations, from: '2026-09-23', to: '2026-09-29', now });
  assert.equal(report.sales.totals.orders, 3);
  assert.equal(report.sales.totals.cancelled, 0, 'đơn trùng không vào cột hủy');
});

// ===== 4. Gán click quảng cáo =====

test('gán đơn: đơn landing đã gắn hội thoại vẫn theo utm_campaign, không bị gán cho quảng cáo tin nhắn bấm trước đó', () => {
  const store = {
    ...adStore,
    campaigns: { ...adStore.campaigns, c2: { id: 'c2', name: 'Tin nhắn', status: 'ACTIVE' } },
    ads: { ...adStore.ads, a2: { campaignId: 'c2' } }
  };
  const conversations = [{ id: 'p:a', pageId: 'p', psid: 'a', referrals: [{ source: 'ADS', adId: 'a2', at: at('2026-09-27') }] }];
  const landingOrders = [
    landing('l1', '2026-09-28', 300000, 'c1', { conversationId: 'p:a' }),
    // Không có utm: vẫn theo lần bấm quảng cáo của hội thoại.
    order('l2', '2026-09-28', 100000, { source: 'Landing page', landing: {}, conversationId: 'p:a' })
  ];
  const report = buildCampaignReport({ conversations, landingOrders, adStore: store, days: 7, now, ads });
  const byId = Object.fromEntries(report.campaigns.map(row => [row.id, row]));
  assert.equal(byId.c1.orders, 1);
  assert.equal(byId.c1.revenue, 300000);
  assert.equal(byId.c2.orders, 1);
  assert.equal(byId.c2.revenue, 100000);
  assert.deepEqual(report.unattributed, { orders: 0, revenue: 0 });
});

// ===== 5. Cố vấn AI thử lại khi lỗi tạm thời =====

const vertexKeySettings = {
  provider: 'vertex', directAuthType: 'api_key', directApiKey: 'test-key', directModel: 'gemini-2.5-flash',
  // Không có PROJECT_ID, fetch giả: không gọi mạng thật.
  directEndpoint: 'https://example.invalid/v1/models/gemini-2.5-flash:generateContent'
};
const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: name => headers[String(name).toLowerCase()] ?? null },
  json: async () => body
});
const okBody = { candidates: [{ content: { parts: [{ text: '{"summary":"ổn","actions":[]}' }] } }] };

test('AI: 429/5xx/rớt mạng thì thử lại có lùi (tôn trọng Retry-After); 400 thì không', async () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(501), false);
  assert.equal(retryDelayMs(1, { baseDelayMs: 1000 }), 1000);
  assert.equal(retryDelayMs(2, { baseDelayMs: 1000 }), 2000);
  assert.equal(retryDelayMs(1, { retryAfter: '3' }), 3000);
  assert.equal(retryDelayMs(1, { retryAfter: '999' }), 10000, 'chặn trên');

  const waits = [];
  const sleep = async ms => { waits.push(ms); };
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) return reply(429, { error: { message: 'Resource exhausted' } }, { 'retry-after': '2' });
    if (calls === 2) throw new TypeError('fetch failed');
    return reply(200, okBody);
  };
  const answer = await requestModelText({ system: 's', prompt: 'p', settings: vertexKeySettings, fetchImpl: flaky, sleep, baseDelayMs: 100 });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 200]);
  assert.match(answer.text, /ổn/);

  let badCalls = 0;
  const bad = async () => { badCalls += 1; return reply(400, { error: { message: 'Sai tham số' } }); };
  await assert.rejects(requestModelText({ system: 's', prompt: 'p', settings: vertexKeySettings, fetchImpl: bad, sleep }), /Sai tham số/);
  assert.equal(badCalls, 1, 'lỗi cấu hình không thử lại');

  let busyCalls = 0;
  const busy = async () => { busyCalls += 1; return reply(503, { error: { message: 'Quá tải' } }); };
  await assert.rejects(requestModelText({ system: 's', prompt: 'p', settings: vertexKeySettings, fetchImpl: busy, sleep, retries: 2 }), /Quá tải/);
  assert.equal(busyCalls, 3, '1 lần + 2 lần thử lại rồi mới bỏ');
});

test('AI: generateCampaignInsights qua được một lần 429 nhờ thử lại (fetch giả, không lưu tệp)', async () => {
  const report = {
    range: { since: '2026-09-23', until: '2026-09-29', days: 7 },
    totals: { spend: 1000000, orders: 5, revenue: 3000000, roas: 3, cpa: 200000 },
    campaigns: [{ id: 'c1', name: 'A', source: 'meta', spend: 1000000, orders: 5, revenue: 3000000, roas: 3, cpa: 200000, daily: [] }]
  };
  let calls = 0;
  const fetchImpl = async () => (++calls === 1 ? reply(429, { error: { message: 'Resource exhausted' } }) : reply(200, okBody));
  const result = await generateCampaignInsights(report, { settings: vertexKeySettings, fetchImpl, sleep: async () => {}, persist: false, now });
  assert.equal(calls, 2);
  assert.equal(result.source, 'ai');
});

// ===== 6. Số quảng cáo cũ khi Meta Ads mất kết nối =====

test('Meta Ads lỗi / mất kết nối / lâu chưa đồng bộ: cờ stale + "dữ liệu đến <thời điểm>"; còn mới thì giữ nguyên', () => {
  const syncedAt = Date.parse('2026-09-29T01:30:00Z'); // 08:30 giờ Việt Nam
  const fresh = { connected: true, syncedAt };
  assert.equal(withAdsFreshness(fresh, syncedAt + HOUR), fresh, 'mới đồng bộ: không thêm gì');
  const late = withAdsFreshness(fresh, syncedAt + ADS_STALE_AFTER_MS + 1);
  assert.equal(late.stale, true);
  assert.match(late.notice, /dữ liệu đến 08:30 29\/09\/2026/);
  assert.match(withAdsFreshness({ connected: true, syncedAt, error: 'Token hết hạn' }, syncedAt + 1000).notice, /Meta Ads đang lỗi/);
  assert.match(withAdsFreshness({ connected: false, syncedAt }, syncedAt + 1000).notice, /mất kết nối/);
  assert.deepEqual(withAdsFreshness({ connected: true, syncedAt: null, error: 'x' }, now), { connected: true, syncedAt: null, error: 'x' }, 'chưa có số nào thì không có gì "cũ"');

  const report = buildCampaignReport({ adStore, days: 7, now, ads: { connected: true, syncedAt: now - 5 * HOUR, error: 'Meta đang giới hạn' } });
  assert.equal(report.ads.stale, true);
  const full = buildReport({ adStore, from: '2026-09-23', to: '2026-09-29', now, ads: { connected: false, syncedAt: now - DAY } });
  assert.equal(full.ads.stale, true);
  assert.match(full.ads.notice, /dữ liệu đến/);
});

test('giao diện hiện cảnh báo số quảng cáo cũ ở Tổng quan, Chiến dịch, Báo cáo và chú thích định nghĩa từ máy chủ', async () => {
  const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const body = name => web.slice(web.indexOf(`function ${name}(`), web.indexOf('\n}\n', web.indexOf(`function ${name}(`)));
  assert.match(body('adsStaleNoticeHtml'), /ads\?\.stale && ads\?\.notice/);
  assert.match(body('renderDashboardNotice'), /adsStaleNoticeHtml\(ads\)/);
  assert.match(body('renderCampaignsNotice'), /adsStaleNoticeHtml\(ads\)/);
  assert.match(body('renderReportSales'), /reportAdsNoticeHtml\(data\)/);
  assert.match(body('renderReportCampaigns'), /data\.campaignTotals/);
  assert.match(body('renderDashboardKpis'), /hint: metricDefinition\(dashboardData, kpi\.key\)/);
  assert.match(body('renderCampaignsSummary'), /metricDefinition\(report, 'roas'\)/);
  assert.match(body('renderCampaignsSummary'), /Đơn UTM \(không có chi phí\)/);
});

// ===== 7. Một định nghĩa ROAS =====

test('ROAS cùng một số ở Tổng quan, Báo cáo và Chiến dịch cho cùng khoảng ngày', () => {
  const conversations = [{ id: 'p:a', pageId: 'p', psid: 'a', referrals: [{ source: 'ADS', adId: 'a1', at: at('2026-09-27') }], customerOrders: [
    order('o1', '2026-09-28', 300000, { phone: '0911111111' }),
    // Đơn tự nhiên (không quảng cáo) của khách khác: có trong Doanh thu, không trong ROAS.
  ] }, { id: 'p:b', pageId: 'p', psid: 'b', customerOrders: [order('o2', '2026-09-28', 700000, { phone: '0922222222' })] }];
  const landingOrders = [landing('l1', '2026-09-28', 900000, 'zalo-oa', { phone: '0933333333' })];
  const dashboard = buildDashboard({ conversations, landingOrders, adStore, days: 7, now, ads });
  const report = buildReport({ conversations, landingOrders, adStore, from: dashboard.range.since, to: dashboard.range.until, now, ads });
  const campaigns = buildCampaignReport({ conversations, landingOrders, adStore, from: dashboard.range.since, to: dashboard.range.until, now, ads });
  assert.equal(campaigns.totals.roas, 3);
  assert.equal(dashboard.kpis.roas.value, 3, 'trước đây Tổng quan: 1.900k ÷ 100k = 19');
  assert.equal(report.sales.totals.roas, 3, 'trước đây Báo cáo: 1.900k ÷ 100k = 19');
  assert.equal(dashboard.kpis.revenue.value, 1900000, 'Doanh thu vẫn gồm mọi đơn hợp lệ');
  assert.equal(dashboard.definitions.roas, METRIC_DEFINITIONS.roas);
  assert.equal(campaigns.definitions.roas, METRIC_DEFINITIONS.roas);
});

// ===== 8. Một định nghĩa khách mới =====

test('khách mới: Tổng quan và Báo cáo cùng số; đơn đầu bị hủy/bom không tính là đơn đầu', () => {
  const conversations = [
    // A: đơn đầu 10/09 bị bom → đơn hợp lệ đầu tiên 28/09 → khách mới của tuần này.
    { id: 'p:a', pageId: 'p', psid: 'a', customerOrders: [
      order('a0', '2026-09-10', 100000, { phone: '0911111111', posStatus: { code: 5, name: 'returned' } }),
      order('a1', '2026-09-28', 300000, { phone: '0911111111' })
    ] },
    // B: mua từ 15/09 → khách cũ.
    { id: 'p:b', pageId: 'p', psid: 'b', customerOrders: [
      order('b0', '2026-09-15', 100000, { phone: '0922222222' }),
      order('b1', '2026-09-27', 100000, { phone: '0922222222' })
    ] },
    // C: mới hôm nay.
    { id: 'p:c', pageId: 'p', psid: 'c', customerOrders: [order('c1', '2026-09-29', 100000, { phone: '0933333333' })] }
  ];
  const dashboard = buildDashboard({ conversations, days: 7, now });
  const report = buildReport({ conversations, from: dashboard.range.since, to: dashboard.range.until, now });
  assert.equal(dashboard.kpis.newCustomers.value, 2);
  assert.equal(report.customers.new, dashboard.kpis.newCustomers.value);
  const facts = collectOrderFacts({ conversations });
  assert.equal(countNewCustomers(firstOrderDates(facts, isValidFact), '2026-09-23', '2026-09-29'), 2);

  // Màn Khách hàng: mốc đơn đầu tiên cũng bỏ đơn hủy/bom.
  const [customerA] = buildCustomers({ conversations: [conversations[0]], messages: {} }, []);
  assert.equal(customerA.firstOrderAt, at('2026-09-28'));
});

// ===== Màn Khách hàng: "Tổng đã chi" và số đơn cùng luật với Báo cáo =====

test('màn Khách hàng: Tổng đã chi / số đơn / đã mua không tính đơn hủy, bom (POS sau 48 giờ), form bỏ dở, đơn trùng đã ẩn', () => {
  const conversations = [{ id: 'p:a', pageId: 'p', psid: 'a', name: 'Lan', customerOrders: [
    order('ok', '2026-09-28', 300000, { phone: '0911111111' }),
    order('huy', '2026-09-27', 999000, { phone: '0911111111', processingStatus: 'cancelled', status: 'Hủy' }),
    order('bom', '2026-09-20', 500000, { phone: '0911111111', products: [{ sku: 'GV', name: 'Granola Vàng', quantity: 1, price: 500000 }], posStatus: { code: 5, name: 'returned' } }),
    order('trung', '2026-09-28', 300000, { phone: '0911111111', hiddenFromTable: true }),
    order('do', '2026-09-26', 149000, { phone: '0911111111', status: 'Chưa hoàn tất', landing: { incomplete: true } })
  ] }];
  const [lan] = buildCustomers({ conversations, messages: {} }, []);
  assert.equal(lan.orderCount, 1);
  assert.equal(lan.orderTotal, 300000);
  assert.deepEqual(lan.products.map(item => item.sku), ['GX'], 'đơn bom Granola Vàng không phải "đã mua"');
  assert.equal(lan.firstOrderAt, at('2026-09-28'));
  assert.equal(lan.orderIds.length, 5, 'mã mọi đơn vẫn giữ để tệp xuất không cộng lại');
});
