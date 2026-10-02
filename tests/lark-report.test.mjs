import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLarkReportScheduler, formatLarkConversationReport, formatLarkReport,
  larkConversationPayload, larkReportConfig, larkTextPayload, normalizeLarkConversationReport,
  normalizeLarkReportTime, normalizeLarkWebhook, previousDay, sendLarkConversationReport, sendLarkReport
} from '../app/lark-report.mjs';

const report = {
  range: { from: '2026-10-01', to: '2026-10-01', groupBy: 'day' },
  sales: { totals: { orders: 5, revenue: 1250000, cancelled: 1, cancelledValue: 149000, aov: 250000, spend: 200000, adRevenue: 800000, roas: 4 } },
  customers: { new: 3, returning: 2, repeatRate: 0.4 },
  products: [{ sku: 'GX', name: 'Granola xanh', quantity: 4, revenue: 596000 }],
  sources: [{ key: 'chatbot', label: 'Chatbot', orders: 3, revenue: 750000 }]
};

test('cấu hình Lark chỉ nhận webhook chính thức và giờ HH:MM', () => {
  const url = 'https://open.larksuite.com/open-apis/bot/v2/hook/test_123-abc';
  assert.equal(normalizeLarkWebhook(` ${url} `), url);
  for (const bad of ['http://open.larksuite.com/open-apis/bot/v2/hook/a', 'https://example.com/open-apis/bot/v2/hook/a', 'https://open.larksuite.com/open-apis/bot/v2/hook/a?x=1']) {
    assert.throws(() => normalizeLarkWebhook(bad), /Webhook/);
  }
  assert.equal(normalizeLarkReportTime('23:59'), '23:59');
  assert.equal(normalizeLarkReportTime('24:00'), '08:00');
  const config = larkReportConfig({ LARK_REPORT_WEBHOOK_URL: url, LARK_REPORT_ENABLED: '0', LARK_REPORT_TIME: '07:30' });
  assert.deepEqual({ enabled: config.enabled, webhookUrl: config.webhookUrl, time: config.time }, {
    enabled: false, webhookUrl: url, time: '07:30'
  });
  assert.match(config.statePath, /lark-report-state\.json$/);
});

test('ngày trước xử lý đúng đầu tháng/năm và năm nhuận', () => {
  assert.equal(previousDay('2026-10-01'), '2026-09-30');
  assert.equal(previousDay('2026-01-01'), '2025-12-31');
  assert.equal(previousDay('2024-03-01'), '2024-02-29');
});

test('nội dung báo cáo Lark có các số chính, top sản phẩm và nguồn', () => {
  const text = formatLarkReport(report);
  assert.match(text, /01\/10\/2026/);
  assert.match(text, /Đơn thành công: 5/);
  assert.match(text, /Doanh thu: 1\.250\.000 ₫/);
  assert.match(text, /ROAS: 4/);
  assert.match(text, /Tỷ lệ mua lại: 40%/);
  assert.match(text, /Granola xanh/);
  assert.match(text, /Chatbot/);
  assert.deepEqual(larkTextPayload(report), { msg_type: 'text', content: { text } });
});

test('gửi webhook dùng payload text và kiểm mã phản hồi Lark', async () => {
  const webhookUrl = 'https://open.larksuite.com/open-apis/bot/v2/hook/test';
  let request;
  const result = await sendLarkReport(report, {
    webhookUrl,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ code: 0, msg: 'success' }) };
    }
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(request.url, webhookUrl);
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), larkTextPayload(report));
  await assert.rejects(sendLarkReport(report, {
    webhookUrl,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 19021 }) })
  }), /mã 19021/);
});

test('báo cáo hội thoại: giữ xuống dòng, thêm tiêu đề/người gửi và chặn nội dung rỗng/quá dài', async () => {
  const input = { title: '  Khách cần hỗ trợ   gấp ', conversation: ' Khách: Alo\r\nShop: Dạ em đây ạ ' };
  assert.deepEqual(normalizeLarkConversationReport(input), {
    title: 'Khách cần hỗ trợ gấp', conversation: 'Khách: Alo\nShop: Dạ em đây ạ'
  });
  const text = formatLarkConversationReport(input, { reporter: 'Thúy Hằng', now: Date.parse('2026-10-02T02:15:00Z') });
  assert.match(text, /^📝 BÁO CÁO HỘI THOẠI · Khách cần hỗ trợ gấp/m);
  assert.match(text, /👤 Người gửi: Thúy Hằng/);
  assert.match(text, /09:15 02\/10\/2026/);
  assert.match(text, /Khách: Alo\nShop: Dạ em đây ạ$/);
  assert.throws(() => normalizeLarkConversationReport({ conversation: '   ' }), /dán đoạn hội thoại/);
  assert.throws(() => normalizeLarkConversationReport({ conversation: 'x'.repeat(12001) }), /12\.000 ký tự/);

  let payload;
  await sendLarkConversationReport(input, {
    reporter: 'Thúy Hằng', now: Date.parse('2026-10-02T02:15:00Z'),
    webhookUrl: 'https://open.larksuite.com/open-apis/bot/v2/hook/test',
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ StatusCode: 0 }) };
    }
  });
  assert.deepEqual(payload, larkConversationPayload(input, { reporter: 'Thúy Hằng', now: Date.parse('2026-10-02T02:15:00Z') }));
});

test('lịch gửi bù một lần sau 08:00, lưu ngày và không gửi trùng', async () => {
  const state = { lastSentDay: '', sentAt: 0 };
  const calls = [];
  const scheduler = createLarkReportScheduler({
    config: { enabled: true, webhookUrl: 'https://open.larksuite.com/open-apis/bot/v2/hook/test', time: '08:00', statePath: 'memory' },
    loadReport: async query => { calls.push(['load', query]); return report; },
    send: async (_report, options) => calls.push(['send', options]),
    readState: async () => state,
    writeState: async (_path, value) => Object.assign(state, value)
  });
  // 01:01 UTC = 08:01 tại Việt Nam, ngày 02/10/2026.
  const at = Date.parse('2026-10-02T01:01:00Z');
  assert.deepEqual(await scheduler.runTick(at), { status: 'sent', reportDay: '2026-10-01' });
  assert.equal(state.lastSentDay, '2026-10-01');
  assert.equal(calls.filter(([kind]) => kind === 'send').length, 1);
  assert.deepEqual(await scheduler.runTick(at + 60000), { status: 'already-sent', reportDay: '2026-10-01' });
  assert.equal(calls.filter(([kind]) => kind === 'send').length, 1);
  // 00:59 UTC = 07:59 tại Việt Nam ngày kế tiếp: chưa đến giờ.
  assert.deepEqual(await scheduler.runTick(Date.parse('2026-10-03T00:59:00Z')), { status: 'not-time' });
});
