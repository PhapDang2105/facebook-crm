// Đồng bộ Marketing API theo tài liệu Meta (rà 05/10/2026): cửa sổ ngày, ghi từng cửa sổ, chia đôi khi "quá lớn",
// dừng khi bị giới hạn, thử lại lỗi tạm, dòng chênh với tổng tài khoản, ngân sách nhóm, chặn tài khoản không VND.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import {
  accountGapRows, adsGraphError, applyAdsetBudgets, checkAccountInfo, isVietnamClockTimezone, planBackgroundSync, readAdStore, runBackgroundAdSync,
  syncAdInsights, syncWindows, usagePercent
} from '../app/meta-ads.mjs';
import { buildCampaignReport } from '../app/campaigns.mjs';
import { friendlyAdsError } from '../app/server-helpers.mjs';

const directory = tempDir('meta-ads-sync-');
// 05/10/2026 10:00 giờ Việt Nam.
const now = Date.parse('2026-10-05T03:00:00Z');
const config = (overrides = {}) => ({
  accessToken: 'token-thu', accountIds: ['act_1'], graphVersion: 'v26.0', appSecret: '', windowDays: 15, sleep: async () => {},
  insightsPath: path.join(directory, `ads-${Math.random().toString(36).slice(2)}.json`), ...overrides
});
const reply = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body });

/** Meta giả: mỗi ngày trong time_range có 1 quảng cáo chi 100.000đ; tổng tài khoản = `accountSpend` mỗi ngày. */
function fakeMeta({ accountSpend = 100000, currency = 'VND', onInsights = null } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    const target = new URL(String(url));
    calls.push(target);
    const p = target.pathname;
    if (p.endsWith('/act_1')) return reply({ name: 'Giọt Nắng', currency, timezone_name: 'Asia/Ho_Chi_Minh', account_status: 1 });
    if (p.endsWith('/campaigns')) return reply({ data: [{ id: 'c1', name: 'Granola', effective_status: 'ACTIVE' }] });
    if (p.endsWith('/adsets')) return reply({ data: [{ id: 's1', campaign_id: 'c1', daily_budget: '200000', effective_status: 'ACTIVE' }] });
    if (p.endsWith('/insights')) {
      const range = JSON.parse(target.searchParams.get('time_range'));
      const custom = onInsights?.(target, range);
      if (custom) return custom;
      const days = [];
      for (let day = range.since; day <= range.until; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) days.push(day);
      if (target.searchParams.get('level') === 'account') return reply({ data: days.map(day => ({ date_start: day, spend: String(accountSpend) })) });
      return reply({ data: days.map(day => ({ date_start: day, campaign_id: 'c1', adset_id: 's1', ad_id: 'a1', ad_name: 'Video', campaign_name: 'Granola', spend: '100000', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '5' }] })) });
    }
    throw new Error(`route lạ ${target}`);
  };
  return { fetchImpl, calls };
}

const insightsRanges = calls => calls.filter(url => url.pathname.endsWith('/insights') && url.searchParams.get('level') === 'ad').map(url => JSON.parse(url.searchParams.get('time_range')));

test('cửa sổ ngày: mới trước, ≤ 15 ngày, phủ kín khoảng', () => {
  const windows = syncWindows('2026-07-08', '2026-10-05', 15);
  assert.equal(windows.length, 6);
  assert.deepEqual(windows[0], { since: '2026-09-21', until: '2026-10-05' });
  assert.deepEqual(windows.at(-1), { since: '2026-07-08', until: '2026-07-22' });
});

test('kho trống: kéo bù 90 ngày theo cửa sổ, ghi mốc phủ; lượt sau chỉ 3 ngày', async () => {
  const settings = config();
  const meta = fakeMeta();
  const first = await runBackgroundAdSync({ now, config: settings, fetchImpl: meta.fetchImpl });
  assert.equal(first.ranges[0].kind, 'backfill');
  assert.equal(insightsRanges(meta.calls).length, 6, '90 ngày / 15 = 6 lần gọi, không một lần gọi khổng lồ');
  const store = await readAdStore(settings.insightsPath);
  assert.deepEqual({ since: store.coverage.act_1.since, until: store.coverage.act_1.until }, { since: '2026-07-08', until: '2026-10-05' });
  assert.equal(store.daily.length, 90);
  assert.equal(store.accountInfo.act_1.currency, 'VND');
  const campaignsCall = meta.calls.find(url => url.pathname.endsWith('/campaigns'));
  assert.doesNotMatch(campaignsCall.searchParams.get('effective_status'), /DELETED/, 'Meta từ chối lọc DELETED (100/1815001)');
  assert.match(campaignsCall.searchParams.get('effective_status'), /ARCHIVED/);

  const later = fakeMeta();
  const second = await runBackgroundAdSync({ now: now + 3600000, config: settings, fetchImpl: later.fetchImpl });
  assert.equal(second.ranges[0].kind, 'recent');
  assert.deepEqual(insightsRanges(later.calls), [{ since: '2026-10-03', until: '2026-10-05' }]);
});

test('bấm Đồng bộ tay 7 ngày khi kho trống KHÔNG làm mất lượt kéo bù 90 ngày', async () => {
  const settings = config();
  await syncAdInsights({ days: 7, now, config: settings, fetchImpl: fakeMeta().fetchImpl });
  const store = await readAdStore(settings.insightsPath);
  assert.equal(store.coverage.act_1.since, '2026-09-29');
  assert.equal(planBackgroundSync(store, ['act_1'], now)[0].kind, 'backfill');
  // Tài khoản mới thêm vào META_AD_ACCOUNT_IDS cũng được kéo bù riêng.
  assert.equal(planBackgroundSync(store, ['act_1', 'act_2'], now)[1].kind, 'backfill');
});

test('lỗi giữa chừng: các cửa sổ đã kéo vẫn được ghi; "dữ liệu quá lớn" thì chia đôi cửa sổ', async () => {
  const settings = config();
  let tooBig = 0;
  const meta = fakeMeta({
    onInsights: (url, range) => {
      if (range.since === '2026-09-21' && range.until === '2026-10-05' && url.searchParams.get('level') === 'ad') {
        tooBig += 1;
        return reply({ error: { code: 100, error_subcode: 1487534, message: 'Please reduce the amount of data' } }, 400);
      }
      if (range.until === '2026-08-06') return reply({ error: { code: 190, error_subcode: 463, message: 'expired' } }, 400);
      return null;
    }
  });
  await assert.rejects(runBackgroundAdSync({ now, config: settings, fetchImpl: meta.fetchImpl }), /đã hết hạn/);
  assert.equal(tooBig, 1);
  const ranges = insightsRanges(meta.calls);
  assert.deepEqual(ranges.slice(1, 3), [{ since: '2026-09-28', until: '2026-10-05' }, { since: '2026-09-21', until: '2026-09-27' }], 'chia đôi, phần mới trước');
  const store = await readAdStore(settings.insightsPath);
  assert.equal(store.coverage.act_1.since, '2026-08-07', 'giữ phần đã kéo trước khi lỗi');
  assert.equal(store.coverage.act_1.until, '2026-10-05');
  assert.match(store.lastError.message, /hết hạn/);
  assert.equal(planBackgroundSync(store, ['act_1'], now)[0].kind, 'backfill', 'lượt sau kéo bù tiếp');
});

test('bị giới hạn (17/2446079): dừng ngay, không gọi dồn; lỗi tạm (mã 2) thử lại', async () => {
  const settings = config();
  let throttled = 0;
  const meta = fakeMeta({ onInsights: () => { throttled += 1; return reply({ error: { code: 17, error_subcode: 2446079, message: 'User request limit reached' } }, 400); } });
  await assert.rejects(syncAdInsights({ days: 30, now, config: settings, fetchImpl: meta.fetchImpl }), /giới hạn/);
  assert.equal(throttled, 1);

  let flaky = 0;
  const retry = fakeMeta({ onInsights: url => (url.searchParams.get('level') === 'ad' && flaky++ === 0 ? reply({ error: { code: 2, message: 'Service temporarily unavailable', is_transient: true } }, 500) : null) });
  const summary = await syncAdInsights({ days: 7, now, config: config(), fetchImpl: retry.fetchImpl });
  assert.equal(summary.rows, 7);
  assert.equal(flaky, 2);
});

test('header giới hạn ≥ 75%: dừng lượt sau cửa sổ đang chạy, ghi lý do', async () => {
  assert.equal(usagePercent(new Headers({ 'x-fb-ads-insights-throttle': '{"app_id_util_pct":12,"acc_id_util_pct":81}' })), 81);
  assert.equal(usagePercent(new Headers({ 'x-business-use-case-usage': '{"1":[{"type":"ads_insights","call_count":5,"total_cputime":40,"total_time":9}]}' })), 40);
  assert.equal(usagePercent(undefined), 0);
  const settings = config();
  const meta = fakeMeta({ onInsights: (url, range) => (url.searchParams.get('level') === 'account' ? null : null) });
  const hot = async url => {
    const response = await meta.fetchImpl(url);
    return new URL(String(url)).pathname.endsWith('/insights') ? { ...response, headers: new Headers({ 'x-fb-ads-insights-throttle': '{"acc_id_util_pct":90}' }) } : response;
  };
  const summary = await runBackgroundAdSync({ now, config: settings, fetchImpl: hot });
  assert.match(summary.stoppedEarly, /90%/);
  assert.equal(insightsRanges(meta.calls).length, 1);
  assert.match((await readAdStore(settings.insightsPath)).lastError.message, /tạm dừng/);
});

test('chi tiêu quảng cáo đã xoá: tổng tài khoản lớn hơn tổng dòng quảng cáo → dòng chênh vào "chưa rõ chiến dịch"', async () => {
  assert.deepEqual(accountGapRows([{ date_start: '2026-10-05', spend: '150000' }], [{ date: '2026-10-05', spend: 100000 }], 'act_1').map(row => [row.adId, row.spend]), [['gap:act_1', 50000]]);
  assert.equal(accountGapRows([{ date_start: '2026-10-05', spend: '100000.4' }], [{ date: '2026-10-05', spend: 100000 }], 'act_1').length, 0, 'lệch làm tròn bỏ qua');

  const settings = config();
  await syncAdInsights({ days: 7, now, config: settings, fetchImpl: fakeMeta({ accountSpend: 130000 }).fetchImpl });
  const store = await readAdStore(settings.insightsPath);
  const report = buildCampaignReport({ adStore: store, days: 7, now });
  assert.equal(report.totals.spend, 7 * 130000, 'tổng chi khớp Trình quản lý quảng cáo');
  assert.equal(report.campaigns.find(row => row.id === 'meta:unknown').spend, 7 * 30000);
  assert.equal(report.campaigns.find(row => row.id === 'c1').dailyBudget, 200000, 'ngân sách lấy từ nhóm quảng cáo');
  assert.equal(report.campaigns.find(row => row.id === 'c1').budgetLevel, 'adset');
});

test('ngân sách nhóm: chỉ cộng nhóm đang chạy, không đè ngân sách chiến dịch', () => {
  const [own, fromAdsets, none] = applyAdsetBudgets(
    [{ id: 'c1', dailyBudget: 500000, lifetimeBudget: null }, { id: 'c2', dailyBudget: null, lifetimeBudget: null }, { id: 'c3', dailyBudget: null, lifetimeBudget: null }],
    [
      { campaign_id: 'c1', daily_budget: '1', effective_status: 'ACTIVE' },
      { campaign_id: 'c2', daily_budget: '100000', effective_status: 'ACTIVE' },
      { campaign_id: 'c2', daily_budget: '50000', effective_status: 'ACTIVE' },
      { campaign_id: 'c2', daily_budget: '999999', effective_status: 'PAUSED' }
    ]
  );
  assert.equal(own.dailyBudget, 500000);
  assert.equal(fromAdsets.dailyBudget, 150000);
  assert.equal(none.dailyBudget, null);
});

test('tài khoản không phải VND / giờ Việt Nam: không kéo (số sai); tài khoản bị khoá: cảnh báo', async () => {
  assert.throws(() => checkAccountInfo({ currency: 'USD', timezone_name: 'Asia/Ho_Chi_Minh' }, 'act_9'), /dùng tiền USD/);
  assert.throws(() => checkAccountInfo({ currency: 'VND', timezone_name: 'America/Los_Angeles' }, 'act_9'), /múi giờ America\/Los_Angeles/);
  assert.match(checkAccountInfo({ currency: 'VND', timezone_name: 'Asia/Saigon', account_status: 3, name: 'GN' }, 'act_9').warning, /chưa thanh toán/);
  // Tài khoản thật của shop: Asia/Bangkok = UTC+7 quanh năm như giờ Việt Nam → nhận (05/10/2026 từng bị chặn nhầm).
  assert.equal(checkAccountInfo({ currency: 'VND', timezone_name: 'Asia/Bangkok', account_status: 1 }, 'act_542455181085610').warning, undefined);
  assert.equal(isVietnamClockTimezone('Asia/Jakarta'), true);
  assert.equal(isVietnamClockTimezone('Asia/Singapore'), false, 'UTC+8');
  assert.equal(isVietnamClockTimezone('Europe/Berlin'), false);
  assert.equal(isVietnamClockTimezone('Khong/Co'), false, 'múi giờ lạ: không coi là khớp');
  await assert.rejects(syncAdInsights({ days: 7, now, config: config(), fetchImpl: fakeMeta({ currency: 'USD' }).fetchImpl }), /dùng tiền USD/);
  assert.match(friendlyAdsError('Tài khoản quảng cáo act_9 dùng tiền USD; CRM chỉ tính được tài khoản VND. Bỏ tài khoản này khỏi META_AD_ACCOUNT_IDS.'), /^Tài khoản quảng cáo act_9 dùng tiền USD — CRM chỉ tính/);
  assert.doesNotMatch(friendlyAdsError('Tài khoản quảng cáo act_9 dùng tiền USD; Bỏ khỏi META_AD_ACCOUNT_IDS.'), /META_/);
});

test('mã lỗi Meta: phân loại lỗi tạm / giới hạn / quá lớn', () => {
  assert.equal(adsGraphError({ error: { code: 1, message: 'Please reduce the amount of data you\'re asking for, then retry your request' } }, 500).tooMuchData, true);
  assert.equal(adsGraphError({ error: { code: 1, message: 'An unknown error occurred' } }, 500).transient, true);
  assert.equal(adsGraphError({ error: { code: 80000, error_subcode: 2446079 } }, 400).throttled, true);
  assert.equal(adsGraphError({ error: { code: 190, error_subcode: 463 } }, 400).transient, false);
  assert.match(adsGraphError({ error: { code: 2635, message: 'deprecated version' } }, 400).message, /META_GRAPH_VERSION/);
});

test('bấm Đồng bộ tay trùng lượt nền: chạy lần lượt, không gọi Meta song song', async () => {
  const settings = config();
  let active = 0;
  let peak = 0;
  const meta = fakeMeta();
  const slow = async url => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    try { return await meta.fetchImpl(url); } finally { active -= 1; }
  };
  await Promise.all([
    runBackgroundAdSync({ now, config: settings, fetchImpl: slow }),
    syncAdInsights({ days: 7, now, config: settings, fetchImpl: slow })
  ]);
  assert.equal(peak, 1);
});
