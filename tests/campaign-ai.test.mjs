import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  accountBaseline,
  buildCampaignPrompt,
  campaignFlags,
  clampKind,
  generateCampaignInsights,
  parseInsightsAnswer,
  readCampaignInsights,
  ruleBasedActions,
  validateInsights
} from '../app/campaign-ai.mjs';

function days(count, perDay) {
  return Array.from({ length: count }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, '0')}`, ...perDay(index) }));
}

function makeReport() {
  const campaigns = [
    // Chi 900k, 0 đơn → tạm dừng
    { id: 'c-burn', name: 'Granola mới - tin nhắn', status: 'ACTIVE', source: 'meta', dailyBudget: 150000, spend: 900000, impressions: 40000, clicks: 500, messages: 20, orders: 0, revenue: 0, cpa: 0, roas: 0, daily: days(6, () => ({ spend: 150000, orders: 0, revenue: 0 })) },
    // ROAS 6, đều → tăng
    { id: 'c-star', name: 'Combo hạt - landing', status: 'ACTIVE', source: 'meta', dailyBudget: 200000, spend: 1400000, impressions: 60000, clicks: 900, messages: 40, orders: 20, revenue: 8400000, cpa: 70000, roas: 6, daily: days(7, () => ({ spend: 200000, orders: 3, revenue: 1200000 })) },
    // CPA cao → giảm
    { id: 'c-pricey', name: 'Retarget', status: 'ACTIVE', source: 'meta', dailyBudget: 100000, spend: 1000000, impressions: 20000, clicks: 200, messages: 10, orders: 2, revenue: 700000, cpa: 500000, roas: 0.7, daily: days(5, index => ({ spend: 200000, orders: index < 2 ? 1 : 0, revenue: index < 2 ? 350000 : 0 })) },
    // Ít dữ liệu → theo dõi
    { id: 'c-new', name: 'Thử nghiệm', status: 'ACTIVE', source: 'meta', dailyBudget: 50000, spend: 100000, impressions: 3000, clicks: 30, messages: 2, orders: 0, revenue: 0, cpa: 0, roas: 0, daily: days(2, () => ({ spend: 50000, orders: 0, revenue: 0 })) },
    // Chỉ UTM, không có chi tiêu
    { id: 'u-zalo', name: 'utm zalo', status: '', source: 'utm', dailyBudget: 0, spend: 0, impressions: 0, clicks: 0, messages: 0, orders: 3, revenue: 900000, cpa: 0, roas: 0, daily: [] }
  ];
  const spend = campaigns.reduce((sum, item) => sum + item.spend, 0);
  const orders = 25;
  const revenue = 10000000;
  return {
    range: { since: '2026-09-01', until: '2026-09-07', days: 7 },
    ads: { connected: true, accounts: 1, syncedAt: '2026-09-07T10:00:00Z' },
    totals: { spend, impressions: 123000, clicks: 1630, messages: 72, orders, revenue, cpa: spend / orders, roas: revenue / spend },
    campaigns,
    unattributed: { orders: 4, revenue: 1200000 }
  };
}

async function tempPath() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'campaign-ai-'));
  return { directory, file: path.join(directory, 'campaign-ai.json') };
}

test('Cờ luật: chi nhiều 0 đơn → tạm dừng, ROAS cao đều → tăng, CPA cao → giảm, ít dữ liệu → theo dõi', () => {
  const report = makeReport();
  const baseline = accountBaseline(report);
  const byId = Object.fromEntries(report.campaigns.map(item => [item.id, campaignFlags(item, baseline)]));
  assert.equal(byId['c-burn'].suggestion, 'pause');
  assert.ok(byId['c-burn'].flags.includes('chi-nhieu-0-don'));
  assert.equal(byId['c-star'].suggestion, 'scale');
  assert.equal(byId['c-pricey'].suggestion, 'reduce');
  assert.equal(byId['c-new'].suggestion, 'watch');
  assert.equal(byId['c-new'].judgeable, false);
  assert.equal(byId['u-zalo'].suggestion, null);
  assert.ok(byId['u-zalo'].flags.includes('khong-co-chi-tieu'));
});

test('Cờ luật: ROAS cao nhưng đơn dồn một ngày thì chưa đề xuất tăng', () => {
  const report = makeReport();
  const spiky = { ...report.campaigns[1], daily: days(7, index => ({ spend: 200000, orders: index === 0 ? 20 : 0, revenue: index === 0 ? 8400000 : 0 })) };
  const flag = campaignFlags(spiky, accountBaseline(report));
  assert.notEqual(flag.suggestion, 'scale');
  assert.ok(flag.flags.includes('roas-cao-chua-on-dinh'));
});

test('Hành động theo luật xếp tạm dừng lên đầu, không có chiến dịch UTM không chi tiêu', () => {
  const actions = ruleBasedActions(makeReport());
  assert.equal(actions[0].kind, 'pause');
  assert.deepEqual(actions.map(item => item.campaignId).sort(), ['c-burn', 'c-new', 'c-pricey', 'c-star']);
  assert.ok(actions.every(item => ['cao', 'vừa', 'thấp'].includes(item.confidence)));
});

test('Prompt chỉ có số tổng hợp, kèm cờ, cắt còn 30 chiến dịch chi nhiều nhất', () => {
  const report = makeReport();
  report.campaigns = Array.from({ length: 45 }, (_, index) => ({ id: `x${index}`, name: `C${index}`, spend: index * 10000, orders: 0, revenue: 0, daily: [] }));
  const prompt = buildCampaignPrompt(report, { days: 7 });
  const data = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.equal(data.chienDich.length, 30);
  assert.equal(data.chienDich[0].campaignId, 'x44');
  assert.equal(data.tongSoChienDich, 45);
  const full = buildCampaignPrompt(makeReport(), { days: 7 });
  assert.match(full, /chi-nhieu-0-don/);
  assert.doesNotMatch(full, /phone|psid|customer/i);
});

test('Đọc JSON có rào ``` và chữ thừa; JSON hỏng trả null', () => {
  assert.deepEqual(parseInsightsAnswer('```json\n{"summary":"ok","actions":[]}\n```'), { summary: 'ok', actions: [] });
  assert.deepEqual(parseInsightsAnswer('Đây: {"summary":"x"} hết'), { summary: 'x' });
  assert.equal(parseInsightsAnswer('{"summary": "x",'), null);
  assert.equal(parseInsightsAnswer('không có json'), null);
});

test('Kiểm câu trả lời: bỏ id lạ, kẹp kind/confidence, không cho kết luận chiến dịch ít dữ liệu', () => {
  const report = makeReport();
  const checked = validateInsights({
    summary: 'Tóm tắt',
    actions: [
      { campaignId: 'khong-ton-tai', kind: 'pause', reason: 'x', confidence: 'cao' },
      { campaignId: 'c-burn', kind: 'PAUSE', reason: 'Chi 900k 0 đơn', confidence: 'high' },
      { campaignId: 'c-star', kind: 'double-budget', reason: 'y', confidence: 'rất cao' },
      { campaignId: 'c-new', kind: 'scale', reason: 'z', confidence: 'cao' },
      { campaignId: 'u-zalo', kind: 'reduce', reason: 'w', confidence: 'vừa' },
      { campaignId: 'c-burn', kind: 'pause', reason: 'trùng', confidence: 'cao' }
    ]
  }, report);
  assert.equal(checked.summary, 'Tóm tắt');
  assert.deepEqual(checked.actions.map(item => [item.campaignId, item.kind, item.confidence]), [
    ['c-burn', 'pause', 'cao'],
    ['c-star', 'watch', 'thấp'],
    ['c-new', 'watch', 'thấp'],
    ['u-zalo', 'watch', 'thấp']
  ]);
  assert.equal(checked.actions[0].campaignName, 'Granola mới - tin nhắn');
  assert.equal(clampKind('creative'), 'creative');
  assert.equal(validateInsights({ foo: 1 }, report), null);
});

test('AI trả lời hợp lệ: dùng câu trả lời của mô hình, lưu lại và đọc được lần gần nhất', async () => {
  const { directory, file } = await tempPath();
  try {
    let seenPrompt = '';
    const result = await generateCampaignInsights(makeReport(), {
      days: 7, path: file, settings: { directModel: 'gemini-test' },
      callModel: async ({ system, prompt }) => {
        seenPrompt = prompt;
        assert.match(system, /Giọt Nắng/);
        return '```json\n{"summary":"Dừng c-burn, tăng nhẹ c-star.","actions":[{"campaignId":"c-star","kind":"scale","reason":"ROAS 6","confidence":"vừa"}]}\n```';
      }
    });
    assert.match(seenPrompt, /c-star/);
    assert.equal(result.model, 'gemini-test');
    assert.equal(result.days, 7);
    assert.equal(result.source, 'ai');
    assert.deepEqual(result.actions.map(item => item.kind), ['scale']);
    assert.deepEqual(await readCampaignInsights({ path: file }), result);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('JSON hỏng hoặc mô hình lỗi: rơi về hành động theo luật, tóm tắt báo AI không dùng được', async () => {
  const { directory, file } = await tempPath();
  try {
    const broken = await generateCampaignInsights(makeReport(), { path: file, settings: {}, callModel: async () => 'xin lỗi, tôi không biết' });
    assert.equal(broken.source, 'rules');
    assert.equal(broken.model, 'rules');
    assert.match(broken.summary, /AI tạm thời không dùng được/);
    assert.deepEqual(broken.actions, ruleBasedActions(makeReport()));
    const failed = await generateCampaignInsights(makeReport(), { path: file, settings: {}, callModel: async () => { throw new Error('429 quota'); } });
    assert.equal(failed.source, 'rules');
    assert.match(failed.summary, /429 quota/);
    assert.equal(failed.days, 7);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Lưu trữ: chỉ giữ 20 lần gần nhất, đọc trả về lần mới nhất; chưa có tệp thì null', async () => {
  const { directory, file } = await tempPath();
  try {
    assert.equal(await readCampaignInsights({ path: file }), null);
    for (let index = 0; index < 23; index += 1) {
      await generateCampaignInsights(makeReport(), { path: file, now: Date.UTC(2026, 8, 1, 0, index), settings: {}, callModel: async () => `{"summary":"lần ${index}","actions":[]}` });
    }
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(stored.runs.length, 20);
    const latest = await readCampaignInsights({ path: file });
    assert.equal(latest.summary, 'lần 22');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Không có chiến dịch: không gọi mô hình, trả lời rỗng có tóm tắt', async () => {
  const { directory, file } = await tempPath();
  try {
    const result = await generateCampaignInsights({ range: { days: 7 }, campaigns: [] }, { path: file, callModel: async () => { throw new Error('không được gọi'); } });
    assert.deepEqual(result.actions, []);
    assert.match(result.summary, /Chưa có số liệu/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
