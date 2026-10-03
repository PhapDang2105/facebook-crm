import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const { graphList, mergeAdInsights } = await import('../app/meta-ads.mjs');
const { appSecretProof, graphEndpoint } = await import('../app/meta-graph.mjs');
const { verifyWebhookSubscription } = await import('../app/meta-webhook.mjs');

test('INT-28: graphList dừng ở trần trang mà còn trang sau → đánh dấu truncated', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ data: [{ id: String(calls) }], paging: { next: `https://graph.facebook.com/next/${calls}` } }) }; };
  const items = await graphList('act_1/campaigns', {}, { config: { accessToken: 't', appSecret: '' }, fetchImpl });
  assert.equal(calls, 200);
  assert.equal(items.truncated, true);
  const done = await graphList('act_1/campaigns', {}, { config: { accessToken: 't', appSecret: '' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'x' }] }) }) });
  assert.equal(done.truncated, undefined);
});

test('INT-28: số liệu bị cắt thì không xoá dòng cũ trong khoảng, chiến dịch thiếu không bị coi là lưu trữ, có cảnh báo', () => {
  const now = Date.parse('2026-09-29T05:00:00Z');
  const store = {
    campaigns: { c1: { id: 'c1', status: 'ACTIVE', accountId: 'act_1' }, c2: { id: 'c2', status: 'ACTIVE', accountId: 'act_1' } }, ads: {},
    daily: [{ date: '2026-09-27', accountId: 'act_1', campaignId: 'c1', adId: 'a-old', spend: 500 }]
  };
  mergeAdInsights(store, [{ accountId: 'act_1', campaigns: [{ id: 'c1', status: 'ACTIVE', accountId: 'act_1' }], ads: {}, dailyTruncated: true, campaignsTruncated: true,
    daily: [{ date: '2026-09-28', accountId: 'act_1', campaignId: 'c1', adId: 'a-new', spend: 100 }] }], { since: '2026-09-23', until: '2026-09-29', now, accounts: ['act_1'] });
  assert.deepEqual(store.daily.map(row => row.adId), ['a-old', 'a-new']);
  assert.equal(store.campaigns.c2.status, 'ACTIVE');
  assert.match(store.lastError.message, /quá 200 trang/);
  // Lượt đầy đủ: thay trọn khoảng như trước, bỏ cảnh báo.
  mergeAdInsights(store, [{ accountId: 'act_1', campaigns: [{ id: 'c1', status: 'ACTIVE', accountId: 'act_1' }], ads: {},
    daily: [{ date: '2026-09-28', accountId: 'act_1', campaignId: 'c1', adId: 'a-new', spend: 100 }] }], { since: '2026-09-23', until: '2026-09-29', now, accounts: ['act_1'] });
  assert.deepEqual(store.daily.map(row => row.adId), ['a-new']);
  assert.equal(store.lastError, undefined);
});

test('INT-18: appsecret_proof dùng chung, nhận secret riêng; graphEndpoint bỏ "/" đầu', () => {
  assert.equal(appSecretProof('tok', 'bi-mat'), createHmac('sha256', 'bi-mat').update('tok').digest('hex'));
  assert.equal(String(graphEndpoint('/act_1/insights', 'v26.0')), 'https://graph.facebook.com/v26.0/act_1/insights');
});

test('INT-30: hub.verify_token so khớp (so hằng thời gian) như trước', () => {
  const params = token => new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.challenge': 'abc', ...(token === null ? {} : { 'hub.verify_token': token }) });
  assert.equal(verifyWebhookSubscription(params('dung'), 'dung'), 'abc');
  assert.equal(verifyWebhookSubscription(params('sai'), 'dung'), null);
  assert.equal(verifyWebhookSubscription(params('dun'), 'dung'), null, 'độ dài khác');
  assert.equal(verifyWebhookSubscription(params(null), 'dung'), null);
  assert.equal(verifyWebhookSubscription(params('dung'), ''), null);
});
