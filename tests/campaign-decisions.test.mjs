import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import { buildCampaignPrompt, decisionFollowUp, followUpWindows, generateCampaignInsights, readCampaignInsights, recordCampaignDecision } from '../app/campaign-ai.mjs';
import { buildCampaignReport } from '../app/campaigns.mjs';

const directory = tempDir('campaign-decisions-');
// 05/10/2026 10:00 giờ Việt Nam.
const now = Date.parse('2026-10-05T03:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const report = {
  range: { since: '2026-09-29', until: '2026-10-05', days: 7 },
  totals: { spend: 2000000, orders: 4, revenue: 1600000, cpa: 500000, roas: 0.8 },
  campaigns: [{ id: '120001', name: 'Granola tin nhắn', status: 'ACTIVE', source: 'meta', spend: 1500000, orders: 0, revenue: 0, daily: [] }]
};

test('ghi "đã làm" / "bỏ qua" cho đúng đề xuất của lượt phân tích, bỏ đánh dấu được', async () => {
  const file = path.join(directory, 'insights.json');
  const run = await generateCampaignInsights(report, { path: file, now, settings: {}, callModel: async () => { throw new Error('tắt AI'); } });
  assert.equal(run.actions[0].kind, 'pause');
  const updated = await recordCampaignDecision({ generatedAt: run.generatedAt, campaignId: '120001', kind: 'pause', status: 'done', by: 'Chủ shop', now }, { path: file });
  assert.deepEqual(updated.actions[0].decision, { status: 'done', at: now, by: 'Chủ shop' });
  assert.equal((await readCampaignInsights({ path: file })).actions[0].decision.status, 'done');
  assert.equal(await recordCampaignDecision({ generatedAt: run.generatedAt, campaignId: 'khac', kind: 'pause', status: 'done' }, { path: file }), null);
  await assert.rejects(recordCampaignDecision({ generatedAt: run.generatedAt, campaignId: '120001', kind: 'pause', status: 'xoá' }, { path: file }), /done/);
  const cleared = await recordCampaignDecision({ generatedAt: run.generatedAt, campaignId: '120001', kind: 'pause', status: '' }, { path: file });
  assert.equal(cleared.actions[0].decision, undefined);
});

test('khoảng so: 7 ngày trước ngày làm, sau ít nhất 3 ngày mới so, tối đa 14 ngày', () => {
  const windows = followUpWindows(now - 4 * DAY, now);
  assert.deepEqual(windows.before, { from: '2026-09-24', to: '2026-09-30', days: 7 });
  assert.deepEqual(windows.after, { from: '2026-10-01', to: '2026-10-05', days: 5 });
  assert.equal(windows.ready, true);
  assert.equal(followUpWindows(now - DAY, now).ready, false);
  assert.equal(followUpWindows(now - 30 * DAY, now).after.days, 14);
  assert.equal(followUpWindows(0, now), null);
});

test('kết quả trước/sau: tạm dừng thì xem chi/ngày, tăng ngân sách thì xem CPA', () => {
  const windows = followUpWindows(now - 4 * DAY, now);
  const row = (spend, orders, revenue) => ({ campaigns: [{ id: '120001', spend, orders, revenue }] });
  const paused = decisionFollowUp({ campaignId: '120001', kind: 'pause' }, windows, { before: row(1400000, 0, 0), after: row(0, 0, 0) });
  assert.equal(paused.before.spendPerDay, 200000);
  assert.match(paused.verdict, /giảm/);
  const scaled = decisionFollowUp({ campaignId: '120001', kind: 'scale' }, windows, { before: row(700000, 2, 600000), after: row(600000, 3, 900000) });
  assert.match(scaled.verdict, /CPA tốt lên 43%/);
  assert.equal(decisionFollowUp({ campaignId: '120001', kind: 'scale' }, followUpWindows(now - DAY, now), {}).ready, false);
});

test('báo cáo chiến dịch mang accountId để mở đúng chiến dịch trong Trình quản lý quảng cáo', () => {
  const built = buildCampaignReport({ adStore: { campaigns: { 120001: { id: '120001', name: 'X', status: 'ACTIVE', accountId: 'act_555' } }, ads: {}, daily: [] }, days: 7, now });
  assert.equal(built.campaigns[0].accountId, 'act_555');
});

test('Cố vấn chiến dịch nhận tóm tắt đối thủ (thiTruong) khi có', () => {
  assert.doesNotMatch(buildCampaignPrompt(report, { days: 7 }), /thiTruong/);
  assert.match(buildCampaignPrompt(report, { days: 7, market: { uuDaiPhoBien: ['Miễn phí vận chuyển (3 đối thủ)'] } }), /"thiTruong":\{"uuDaiPhoBien"/);
});
