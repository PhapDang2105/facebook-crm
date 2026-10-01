import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCampaignReport, campaignNameFromAdTitle, campaignRange, isCancelledOrder, normalizeRangeDays, referralForOrder } from '../app/campaigns.mjs';

// 29/09/2026 10:00 giờ Việt Nam; khoảng 7 ngày = 23/09 → 29/09.
const now = Date.parse('2026-09-29T03:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (date, hour = 10) => Date.parse(`${date}T${String(hour - 7).padStart(2, '0')}:00:00Z`);

const adStore = {
  syncedAt: now - HOUR,
  campaigns: {
    c1: { id: 'c1', name: 'Granola chuyển đổi', status: 'ACTIVE', dailyBudget: 300000, objective: 'OUTCOME_ENGAGEMENT', accountId: 'act_111' },
    c2: { id: 'c2', name: 'Live săn deal', status: 'PAUSED', dailyBudget: null, objective: 'OUTCOME_SALES', accountId: 'act_111' },
    c3: { id: 'c3', name: 'Chiến dịch mới', status: 'ACTIVE', dailyBudget: 100000, objective: 'OUTCOME_SALES', accountId: 'act_111' }
  },
  ads: {
    a1: { campaignId: 'c1', campaignName: 'Granola chuyển đổi', adsetId: 's1', adName: 'Video túi xanh' },
    a2: { campaignId: 'c2', campaignName: 'Live săn deal', adsetId: 's2', adName: 'Live 28/9' }
  },
  daily: [
    { date: '2026-09-28', campaignId: 'c1', adId: 'a1', spend: 150000, impressions: 12000, clicks: 340, messages: 25 },
    { date: '2026-09-29', campaignId: 'c1', adId: 'a1', spend: 50000, impressions: 6000, clicks: 120, messages: 5 },
    { date: '2026-09-29', campaignId: 'c2', adId: 'a2', spend: 80000, impressions: 4000, clicks: 90, messages: 4 },
    // Ngoài khoảng 7 ngày: không tính.
    { date: '2026-09-01', campaignId: 'c1', adId: 'a1', spend: 999999, impressions: 1, clicks: 1, messages: 1 }
  ]
};

const order = (id, createdAt, total, extra = {}) => ({ id, createdAt, total, status: 'Mới', source: 'Chatbot', products: [{ name: 'Granola', quantity: 1 }], ...extra });

test('khoảng ngày chỉ nhận 7/14/30/90, mặc định 7', () => {
  assert.equal(normalizeRangeDays('30'), 30);
  assert.equal(normalizeRangeDays('5'), 7);
  assert.equal(normalizeRangeDays(undefined), 7);
});

test('đơn hủy/hoàn không tính doanh thu; "Form hoàn tất" không phải hoàn hàng', () => {
  assert.equal(isCancelledOrder({ processingStatus: 'cancelled', status: 'Mới' }), true);
  assert.equal(isCancelledOrder({ status: 'Hủy' }), true);
  assert.equal(isCancelledOrder({ status: 'Huỷ' }), true);
  assert.equal(isCancelledOrder({ status: 'Đang hoàn' }), true);
  assert.equal(isCancelledOrder({ status: 'Form hoàn tất' }), false);
  assert.equal(isCancelledOrder({ status: 'Mới' }), false);
});

test('lần bấm quảng cáo: lấy lần gần nhất trước lúc đặt, trong vòng 7 ngày', () => {
  const conversation = { referrals: [
    { source: 'ADS', adId: 'a2', at: at('2026-09-20') },
    { source: 'ADS', adId: 'a1', at: at('2026-09-27') },
    { source: 'ADS', adId: 'a2', at: at('2026-09-29', 12) },
    { source: 'SHORTLINK', ref: 'tmdt-01', at: at('2026-09-28') }
  ] };
  assert.equal(referralForOrder(conversation, at('2026-09-28')).adId, 'a1', 'lần bấm sau lúc đặt đơn không tính');
  assert.equal(referralForOrder(conversation, at('2026-09-26')).adId, 'a2', 'lần 20/09 vẫn trong 7 ngày');
  assert.equal(referralForOrder(conversation, at('2026-09-19')), null, 'trước mọi lần bấm');
  assert.equal(referralForOrder({ referrals: [{ source: 'ADS', adId: 'a1', at: at('2026-09-10') }] }, at('2026-09-28')), null, 'quá 7 ngày');
  assert.equal(campaignNameFromAdTitle('Video túi xanh · Granola chuyển đổi'), 'Granola chuyển đổi');
  assert.equal(campaignNameFromAdTitle('Video túi xanh'), '');
});

test('báo cáo: chi tiêu theo chiến dịch, đơn hội thoại quy theo quảng cáo, đơn landing theo utm (mã rồi tên), hủy không tính', () => {
  const conversations = [
    // Bấm a1 (c1) hôm 27 rồi đặt hôm 28: về c1.
    { id: 'k1', referrals: [{ source: 'ADS', adId: 'a1', at: at('2026-09-27') }], customerOrders: [order('o1', at('2026-09-28'), 300000)] },
    // Hai đơn, một đơn hủy: chỉ tính đơn còn lại.
    { id: 'k2', referrals: [{ source: 'ADS', adId: 'a1', at: at('2026-09-28') }], customerOrders: [order('o2', at('2026-09-29'), 250000), order('o3', at('2026-09-29'), 999000, { processingStatus: 'cancelled', status: 'Hủy' })] },
    // Bấm quảng cáo quá 7 ngày trước: chưa quy được.
    { id: 'k3', referrals: [{ source: 'ADS', adId: 'a2', at: at('2026-09-10') }], customerOrders: [order('o4', at('2026-09-28'), 180000)] },
    // Không có quảng cáo: chưa quy được.
    { id: 'k4', customerOrders: [order('o5', at('2026-09-27'), 120000)] },
    // Quảng cáo lạ, tên chiến dịch đọc từ adTitle → khớp tên chiến dịch c2.
    { id: 'k5', referrals: [{ source: 'ADS', adId: 'zz', adTitle: 'Clip mới · live săn DEAL', at: at('2026-09-29', 8) }], customerOrders: [order('o6', at('2026-09-29'), 200000)] },
    // Đơn ngoài khoảng ngày: bỏ qua.
    { id: 'k6', referrals: [{ source: 'ADS', adId: 'a1', at: at('2026-09-01') }], customerOrders: [order('o7', at('2026-09-02'), 500000)] }
  ];
  const landingOrders = [
    order('l1', at('2026-09-29'), 400000, { source: 'Landing page', landing: { campaign: 'utm_source=fb; utm_campaign=c1' } }),
    order('l2', at('2026-09-28'), 350000, { source: 'Landing page', landing: { campaign: 'utm_source=fb; utm_campaign=Live Săn Deal' } }),
    order('l3', at('2026-09-28'), 150000, { source: 'Landing page', landing: { campaign: 'utm_source=tiktok; utm_campaign=tiktok-thang9' } }),
    // Form bỏ dở chưa xác nhận: chưa là đơn.
    order('l4', at('2026-09-28'), 150000, { source: 'Landing page', status: 'Chưa hoàn tất', landing: { campaign: 'utm_campaign=c1', incomplete: true } }),
    order('l5', at('2026-09-28'), 150000, { source: 'Landing page', status: 'Hủy', landing: { campaign: 'utm_campaign=c1' } })
  ];
  const ads = { connected: true, accounts: ['act_111'], syncedAt: adStore.syncedAt };
  const report = buildCampaignReport({ conversations, landingOrders, adStore, days: 7, now, ads });

  assert.deepEqual(report.range, { since: '2026-09-23', until: '2026-09-29', days: 7 });
  assert.deepEqual(report.ads, ads);
  const byId = Object.fromEntries(report.campaigns.map(row => [row.id, row]));

  const c1 = byId.c1;
  assert.equal(c1.name, 'Granola chuyển đổi');
  assert.equal(c1.source, 'meta');
  assert.equal(c1.status, 'ACTIVE');
  assert.equal(c1.dailyBudget, 300000);
  assert.equal(c1.spend, 200000);
  assert.equal(c1.impressions, 18000);
  assert.equal(c1.clicks, 460);
  assert.equal(c1.messages, 30);
  assert.equal(c1.orders, 3, 'o1, o2, l1');
  assert.equal(c1.revenue, 950000);
  assert.equal(c1.cpa, 66667);
  assert.equal(c1.roas, 4.75);
  assert.equal(c1.daily.length, 7);
  assert.deepEqual(c1.daily.at(-1), { date: '2026-09-29', spend: 50000, orders: 2, revenue: 650000 });
  assert.deepEqual(c1.daily.at(-2), { date: '2026-09-28', spend: 150000, orders: 1, revenue: 300000 });

  const c2 = byId.c2;
  assert.equal(c2.orders, 2, 'o6 theo tên trong adTitle, l2 theo tên utm');
  assert.equal(c2.revenue, 550000);
  assert.equal(c2.spend, 80000);

  const utm = byId['tiktok-thang9'];
  assert.equal(utm.source, 'utm');
  assert.equal(utm.spend, 0);
  assert.equal(utm.roas, null, 'không chi tiêu thì ROAS null');
  assert.equal(utm.cpa, null, 'không chi tiêu thì CPA null');

  // Chiến dịch đang chạy chưa tiêu đồng nào vẫn hiện, CPA null khi 0 đơn.
  assert.equal(byId.c3.spend, 0);
  assert.equal(byId.c3.cpa, null);
  assert.equal(byId.c3.roas, null);

  assert.deepEqual(report.unattributed, { orders: 2, revenue: 300000 });
  assert.deepEqual(report.campaigns.map(row => row.id), ['c1', 'c2', 'tiktok-thang9', 'c3'], 'chi tiêu giảm dần rồi doanh thu giảm dần');
  assert.deepEqual(report.totals, { spend: 280000, impressions: 22000, clicks: 550, messages: 34, orders: 6, revenue: 1650000, cpa: 46667, roas: 5.89 });
  // Toàn cảnh: cả đơn chưa quy được (o4, o5) trên toàn bộ chi tiêu.
  assert.deepEqual(report.blended, { orders: 8, revenue: 1950000, spend: 280000, cpa: 35000, roas: 6.96 });
});

test('báo cáo trống: tổng 0, CPA/ROAS null, kết nối mặc định là chưa', () => {
  const report = buildCampaignReport({ now, days: 14 });
  assert.equal(report.range.days, 14);
  assert.deepEqual(report.totals, { spend: 0, impressions: 0, clicks: 0, messages: 0, orders: 0, revenue: 0, cpa: null, roas: null });
  assert.deepEqual(report.campaigns, []);
  assert.deepEqual(report.unattributed, { orders: 0, revenue: 0 });
  assert.deepEqual(report.blended, { orders: 0, revenue: 0, spend: 0, cpa: null, roas: null });
  assert.equal(report.ads.connected, false);
});

test('dữ liệu cũ chỉ có referral (không có referrals[]) thì lấy lúc mở hội thoại làm lúc bấm', () => {
  const conversations = [{ id: 'k1', createdAt: at('2026-09-27'), referral: { source: 'ADS', adId: 'a1' }, customerOrders: [order('o1', at('2026-09-28'), 300000)] }];
  const report = buildCampaignReport({ conversations, adStore, now });
  assert.equal(report.campaigns.find(row => row.id === 'c1').orders, 1);
});

test('máy chủ nối đủ bốn route Chiến dịch và vòng đồng bộ quảng cáo', async () => {
  const server = await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /request\.method === 'GET' && url\.pathname === '\/api\/campaigns'\)[\s\S]{0,300}loadCampaignReport\(\{\s*days: normalizeRangeDays\(url\.searchParams\.get\('days'\)\),\s*from: url\.searchParams\.get\('from'\) \|\| undefined,\s*to: url\.searchParams\.get\('to'\) \|\| undefined\s*\}\)/);
  assert.match(server, /request\.method === 'POST' && url\.pathname === '\/api\/campaigns\/sync'\)[\s\S]{0,400}syncAdInsights\(\{ days \}\)[\s\S]{0,300}loadCampaignReport\(\{ days \}\)/);
  assert.match(server, /request\.method === 'GET' && url\.pathname === '\/api\/campaigns\/insights'\)[\s\S]{0,200}readCampaignInsights\(\)/);
  assert.match(server, /request\.method === 'POST' && url\.pathname === '\/api\/campaigns\/insights'\)[\s\S]{0,400}generateCampaignInsights\(report, \{ days \}\)/);
  assert.match(server, /import \{[^}]*generateCampaignInsights[^}]*readCampaignInsights[^}]*\} from '\.\/campaign-ai\.mjs'/);
  assert.match(server, /import \{[^}]*startAdInsightsSync[^}]*syncAdInsights[^}]*\} from '\.\/meta-ads\.mjs'/);
  assert.match(server, /server\.listen\([\s\S]*startAdInsightsSync\(\)/);
});

test('khoảng from/to (giờ Việt Nam) thay cho days; sai định dạng thì quay về days', () => {
  assert.deepEqual(campaignRange({ from: '2026-09-28', to: '2026-09-29', now }), { since: '2026-09-28', until: '2026-09-29', days: 2 });
  assert.deepEqual(campaignRange({ from: '2026-09-31', to: '2026-09-29', days: 14, now }), { since: '2026-09-16', until: '2026-09-29', days: 14 });
  const report = buildCampaignReport({ adStore, from: '2026-09-01', to: '2026-09-01', now });
  assert.deepEqual(report.range, { since: '2026-09-01', until: '2026-09-01', days: 1 });
  const c1 = report.campaigns.find(row => row.id === 'c1');
  assert.equal(c1.spend, 999999);
  assert.deepEqual(c1.daily, [{ date: '2026-09-01', spend: 999999, orders: 0, revenue: 0 }]);
});

test('cửa sổ quy đơn đổi được (CAMPAIGN_ATTRIBUTION_DAYS → attributionWindowMs)', () => {
  const conversations = [{ id: 'k', referrals: [{ source: 'ADS', adId: 'a1', at: at('2026-09-24') }], customerOrders: [order('o', at('2026-09-29'), 100000)] }];
  const short = buildCampaignReport({ conversations, adStore, now, attributionWindowMs: 3 * DAY });
  assert.equal(short.campaigns.find(row => row.id === 'c1').orders, 0);
  assert.deepEqual(short.unattributed, { orders: 1, revenue: 100000 });
  const long = buildCampaignReport({ conversations, adStore, now });
  assert.equal(long.campaigns.find(row => row.id === 'c1').orders, 1);
  assert.equal(referralForOrder(conversations[0], at('2026-09-29'), 3 * DAY), null);
});

test('đơn trùng mã (hai nơi) chỉ tính một lần', () => {
  const duplicate = order('dup', at('2026-09-28'), 300000);
  const conversations = [
    { id: 'k1', referrals: [{ source: 'ADS', adId: 'a1', at: at('2026-09-27') }], customerOrders: [duplicate] },
    { id: 'k2', referrals: [{ source: 'ADS', adId: 'a1', at: at('2026-09-27') }], customerOrders: [{ ...duplicate }] }
  ];
  const report = buildCampaignReport({ conversations, adStore, now });
  assert.equal(report.campaigns.find(row => row.id === 'c1').orders, 1);
});

test('config: CAMPAIGN_ATTRIBUTION_DAYS có trong config.mjs và .env.example', async () => {
  const config = await readFile(new URL('../app/config.mjs', import.meta.url), 'utf8');
  assert.match(config, /process\.env\.CAMPAIGN_ATTRIBUTION_DAYS/);
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(example, /CAMPAIGN_ATTRIBUTION_DAYS=7/);
});
