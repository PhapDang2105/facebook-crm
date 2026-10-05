import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import { normalizeAdAccountIds } from '../app/config.mjs';
import { adsConnectionStatus, adsGraphError, mergeAdInsights, parseInsightRow, readAdStore, resetProofMemory, syncAdInsights, vietnamDay } from '../app/meta-ads.mjs';

const directory = tempDir('meta-ads-');
// 29/09/2026 10:00 giờ Việt Nam.
const now = Date.parse('2026-09-29T03:00:00Z');

function config(overrides = {}) {
  return {
    accessToken: 'token-thu',
    accountIds: ['act_111'],
    graphVersion: 'v26.0',
    appSecret: '',
    insightsPath: path.join(directory, `ad-insights-${Math.random().toString(36).slice(2)}.json`),
    sleep: async () => {},
    ...overrides
  };
}

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

/** fetch giả: trả theo edge, ghi lại mọi URL đã gọi; không ra mạng. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(String(url));
    calls.push({ url: target, method: options.method || 'GET' });
    const route = routes.find(item => item.match(target));
    if (!route) throw new Error(`không có route giả cho ${target}`);
    return route.reply(target);
  };
  return { fetchImpl, calls };
}

const campaignsPage = {
  data: [
    { id: 'c1', name: 'Granola chuyển đổi', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '300000', objective: 'OUTCOME_ENGAGEMENT' },
    { id: 'c2', name: 'Live săn deal', status: 'PAUSED', effective_status: 'CAMPAIGN_PAUSED', lifetime_budget: '5000000', objective: 'OUTCOME_SALES' }
  ]
};
const insightsPage1 = {
  data: [
    { date_start: '2026-09-28', date_stop: '2026-09-28', campaign_id: 'c1', campaign_name: 'Granola chuyển đổi', adset_id: 's1', adset_name: 'Nữ 25-40', ad_id: 'a1', ad_name: 'Video túi xanh', spend: '150000', impressions: '12000', clicks: '340', actions: [{ action_type: 'link_click', value: '300' }, { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '25' }] }
  ],
  paging: { cursors: { after: 'X' }, next: 'https://graph.facebook.com/v26.0/act_111/insights?after=X&access_token=token-thu' }
};
const insightsPage2 = {
  data: [
    { date_start: '2026-09-29', date_stop: '2026-09-29', campaign_id: 'c1', campaign_name: 'Granola chuyển đổi', adset_id: 's1', adset_name: 'Nữ 25-40', ad_id: 'a1', ad_name: 'Video túi xanh', spend: '80000.5', impressions: '6000', clicks: '120' },
    { date_start: '2026-09-29', date_stop: '2026-09-29', campaign_id: 'c2', campaign_name: 'Live săn deal', adset_id: 's2', adset_name: 'Rộng', ad_id: 'a2', ad_name: 'Live 28/9', spend: '50000', impressions: '4000', clicks: '90', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '4' }] }
  ]
};

const standardRoutes = () => [
  { match: url => url.pathname.endsWith('/act_111'), reply: () => json({ name: 'Giọt Nắng', currency: 'VND', timezone_name: 'Asia/Ho_Chi_Minh', account_status: 1 }) },
  { match: url => url.pathname.endsWith('/act_111/adsets'), reply: () => json({ data: [] }) },
  { match: url => url.pathname.endsWith('/act_111/campaigns'), reply: () => json(campaignsPage) },
  { match: url => url.pathname.endsWith('/act_111/insights') && url.searchParams.get('after') === 'X', reply: () => json(insightsPage2) },
  { match: url => url.pathname.endsWith('/act_111/insights'), reply: () => json(insightsPage1) }
];

test('tài khoản quảng cáo: nhận có/không có tiền tố act_, bỏ trùng và giá trị rác', () => {
  assert.deepEqual(normalizeAdAccountIds(' act_111, 222 ,act_111,abc,'), ['act_111', 'act_222']);
  assert.deepEqual(normalizeAdAccountIds(''), []);
});

test('một dòng insights: tin nhắn lấy từ messaging_conversation_started_7d, số chuỗi đổi ra số', () => {
  const row = parseInsightRow(insightsPage1.data[0], 'act_111');
  assert.deepEqual(row, { date: '2026-09-28', accountId: 'act_111', campaignId: 'c1', adsetId: 's1', adId: 'a1', spend: 150000, impressions: 12000, clicks: 340, linkClicks: 0, messages: 25, newMessages: 0 });
  assert.equal(parseInsightRow({ date_start: '2026-09-28', ad_id: 'a9' }).messages, 0);
});

test('đồng bộ: đi hết các trang insights, lưu chiến dịch, bản đồ quảng cáo và số liệu theo ngày; chỉ gọi GET', async () => {
  const { fetchImpl, calls } = fakeFetch(standardRoutes());
  const settings = config();
  const summary = await syncAdInsights({ days: 7, now, config: settings, fetchImpl });
  assert.equal(summary.rows, 3);
  assert.equal(summary.since, '2026-09-23');
  assert.equal(summary.until, '2026-09-29');
  assert.ok(calls.every(call => call.method === 'GET'), 'không bao giờ gọi lệnh ghi');
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/insights')).length, 4, 'level=ad và level=account, mỗi loại đi theo paging.next');
  const insightsCall = calls.find(call => call.url.pathname.endsWith('/insights') && call.url.searchParams.get('level') === 'ad' && !call.url.searchParams.get('after'));
  assert.equal(insightsCall.url.searchParams.get('level'), 'ad');
  assert.equal(insightsCall.url.searchParams.get('time_increment'), '1');
  assert.deepEqual(JSON.parse(insightsCall.url.searchParams.get('time_range')), { since: '2026-09-23', until: '2026-09-29' });
  assert.match(insightsCall.url.searchParams.get('fields'), /campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,clicks,inline_link_clicks,actions/);
  assert.equal(insightsCall.url.searchParams.get('use_unified_attribution_setting'), 'true', 'quy chuyển đổi như Trình quản lý quảng cáo');

  const store = await readAdStore(settings.insightsPath);
  assert.equal(store.syncedAt, now);
  assert.deepEqual(store.accounts, ['act_111']);
  assert.deepEqual(store.campaigns.c1, { id: 'c1', name: 'Granola chuyển đổi', status: 'ACTIVE', dailyBudget: 300000, lifetimeBudget: null, objective: 'OUTCOME_ENGAGEMENT', accountId: 'act_111' });
  assert.equal(store.campaigns.c2.status, 'CAMPAIGN_PAUSED');
  assert.deepEqual(store.ads.a2, { campaignId: 'c2', campaignName: 'Live săn deal', adsetId: 's2', adsetName: 'Rộng', adName: 'Live 28/9' });
  assert.equal(store.daily.length, 3);
  assert.equal(store.daily.find(row => row.date === '2026-09-29' && row.adId === 'a1').spend, 80000.5);
  assert.equal(store.daily.find(row => row.adId === 'a2').messages, 4);
});

test('gộp kho: thay trọn khoảng ngày vừa kéo, giữ ngày cũ hơn, bỏ dòng quá 120 ngày, không trùng ngày+quảng cáo', () => {
  const store = {
    campaigns: {}, ads: {},
    daily: [
      { date: '2026-05-01', accountId: 'act_111', campaignId: 'c1', adId: 'a1', spend: 1 },
      { date: '2026-09-20', accountId: 'act_111', campaignId: 'c1', adId: 'a1', spend: 10 },
      { date: '2026-09-28', accountId: 'act_111', campaignId: 'c1', adId: 'a3', spend: 99 },
      { date: '2026-09-28', accountId: 'act_111', campaignId: 'c1', adId: 'a1', spend: 1 }
    ]
  };
  mergeAdInsights(store, [{ accountId: 'act_111', campaigns: [], ads: {}, daily: [{ date: '2026-09-28', accountId: 'act_111', campaignId: 'c1', adId: 'a1', spend: 150 }] }], { since: '2026-09-23', until: '2026-09-29', now, accounts: ['act_111'] });
  assert.deepEqual(store.daily.map(row => `${row.date}|${row.adId}|${row.spend}`), ['2026-09-20|a1|10', '2026-09-28|a1|150']);
});

test('lỗi Graph: token hết hạn, thiếu ads_read, bị giới hạn → câu tiếng Việt chỉ cách sửa; lỗi được ghi cho màn Chiến dịch', async () => {
  assert.match(adsGraphError({ error: { code: 190, message: 'Error validating access token: Session has expired' } }, 400).message, /hết hạn.*ads_read/);
  assert.match(adsGraphError({ error: { code: 200, message: 'Permissions error' } }, 403, 'act_111').message, /quyền ads_read.*act_111/);
  assert.match(adsGraphError({ error: { code: 17, message: 'User request limit reached' } }, 400).message, /giới hạn/);

  const settings = config();
  const { fetchImpl } = fakeFetch([{ match: () => true, reply: () => json({ error: { code: 190, message: 'expired' } }, 400) }]);
  await assert.rejects(syncAdInsights({ days: 7, now, config: settings, fetchImpl }), /hết hạn/);
  const status = await adsConnectionStatus({ config: settings });
  assert.equal(status.connected, true);
  assert.equal(status.syncedAt, null);
  assert.match(status.error, /hết hạn/);
});

test('appsecret_proof bị từ chối (token của app khác) thì gửi lại một lần không kèm proof', async () => {
  resetProofMemory();
  const settings = config({ appSecret: 'bi-mat' });
  const { fetchImpl, calls } = fakeFetch([
    { match: url => url.searchParams.has('appsecret_proof'), reply: () => json({ error: { code: 100, message: 'Invalid appsecret_proof provided in the API argument' } }, 400) },
    ...standardRoutes()
  ]);
  const summary = await syncAdInsights({ days: 7, now, config: settings, fetchImpl });
  assert.equal(summary.rows, 3);
  assert.ok(calls.some(call => call.url.searchParams.has('appsecret_proof')));
});

test('chưa cấu hình: đồng bộ báo thiếu biến môi trường, trạng thái connected=false', async () => {
  const settings = config({ accessToken: '', accountIds: [] });
  await assert.rejects(syncAdInsights({ config: settings, fetchImpl: async () => { throw new Error('không được gọi mạng'); } }), /META_ADS_ACCESS_TOKEN/);
  const status = await adsConnectionStatus({ config: settings });
  assert.deepEqual(status, { connected: false, accounts: [], syncedAt: null, missing: ['META_ADS_ACCESS_TOKEN', 'META_AD_ACCOUNT_IDS'] });
  await assert.rejects(readFile(settings.insightsPath, 'utf8'), 'không tạo tệp khi chưa cấu hình');
});

test('ngày theo giờ Việt Nam: 17:30 UTC đã là 00:30 hôm sau', () => {
  assert.equal(vietnamDay(Date.parse('2026-09-28T17:30:00Z')), '2026-09-29');
  assert.equal(vietnamDay(Date.parse('2026-09-28T16:59:00Z')), '2026-09-28');
});
