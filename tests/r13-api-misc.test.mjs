// R13 (api) — các mục nhỏ: M3 (lịch sử đơn của khách), T9 (audience.csv), T-1 (khách mới theo kỳ), TB-3 (chiến dịch đã
// lưu trữ), T-3 (cố vấn khuyên dừng chiến dịch đã dừng), T-6b + L8 (meta-graph: hạn chờ, lỗi Graph có lời dẫn tiếng Việt).
// Ca M3 trong báo cáo out-functions: khách có 4 đơn → "Lịch sử đơn" 10 dòng: `seedbot1-2` và `CB-seedbot1-2` (Đã xuất
// kho) cho mỗi đơn, cộng 2 đơn đã xoá hiện chữ "deleted".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.META_GRAPH_VERSION ||= 'v26.0';
process.env.META_APP_SECRET ||= 'r13-api-test-secret';
const { archiveStatusLabel, audienceName, customersToAudienceCsv, orderHistoryKey } = await import('../app/customers.mjs');
const { buildReport } = await import('../app/reports.mjs');
const { mergeAdInsights } = await import('../app/meta-ads.mjs');
const { campaignFlags, campaignIsRunning, isRealMetaCampaign, ruleBasedActions, validateInsights } = await import('../app/campaign-ai.mjs');
const { GRAPH_TIMEOUT_MS, metaRequest } = await import('../app/meta-graph.mjs');

const server = (await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('M3: khoá khử trùng lịch sử đơn bỏ tiền tố CB-/LP- (seedbot1-2 và CB-seedbot1-2 là MỘT đơn); nhãn deleted → "Đã xoá"', () => {
  assert.equal(orderHistoryKey('CB-seedbot1-2'), 'seedbot1-2');
  assert.equal(orderHistoryKey('seedbot1-2'), 'seedbot1-2');
  assert.equal(orderHistoryKey('LP-3f9a1c2d'), '3f9a1c2d');
  assert.equal(orderHistoryKey('lp-3f9a1c2d'), '3f9a1c2d');
  assert.equal(orderHistoryKey('CBX-1'), 'CBX-1', 'chỉ bỏ đúng tiền tố "CB-" / "LP-"');
  assert.equal(orderHistoryKey(51234), '51234');
  // Như route: 4 đơn đã xuất kho (mã có tiền tố) + cùng 4 đơn trong kho lưu trữ (mã trần) + 2 đơn đã xoá → 6 dòng, không phải 10.
  const exported = ['CB-seedbot1-1', 'CB-seedbot1-2', 'CB-seedbot1-3', 'LP-seedlp-1'];
  const archived = [['seedbot1-1', ''], ['seedbot1-2', 'confirmed'], ['seedbot1-3', ''], ['seedlp-1', ''], ['xoa-1', 'deleted'], ['xoa-2', 'deleted']];
  const byId = new Map();
  for (const id of exported) byId.set(orderHistoryKey(id), { id, status: 'Đã xuất kho' });
  for (const [id, st] of archived) if (!byId.has(orderHistoryKey(id))) byId.set(orderHistoryKey(id), { id, status: archiveStatusLabel(st) });
  assert.equal(byId.size, 6);
  assert.deepEqual([...byId.values()].filter(item => item.status === 'Đã xoá').map(item => item.id), ['xoa-1', 'xoa-2']);
  assert.equal(archiveStatusLabel('deleted'), 'Đã xoá');
  assert.equal(archiveStatusLabel(''), 'Đã ghi kho');
  assert.equal(archiveStatusLabel('cancelled'), 'Hủy');
  assert.equal(archiveStatusLabel('confirmed'), 'Đã xác nhận');
  const route = server.slice(server.indexOf("if (customerRoute[1] === 'orders' && request.method === 'GET') {"), server.indexOf('// Cài đặt → Tin nhắn: conversation labels'));
  assert.equal(route.split('byId.set(orderHistoryKey(').length - 1, 3, 'cả ba nguồn (tệp khách hàng, kho lưu trữ, hội thoại) dùng cùng một khoá');
  assert.match(route, /status: archiveStatusLabel\(record\.st\),/);
  assert.doesNotMatch(route, /byId\.has\(String\(/);
});

test('T9: audience.csv bỏ ký tự mở công thức ở đầu tên (= + - @, tab), không thêm dấu nháy; tên thường giữ nguyên', () => {
  assert.equal(audienceName('=HYPERLINK("http://x")'), 'HYPERLINK("http://x")');
  assert.equal(audienceName(' +-@= Lan'), 'Lan');
  assert.equal(audienceName('\t=cmd'), 'cmd');
  assert.equal(audienceName('Nguyễn Thị Lan'), 'Nguyễn Thị Lan');
  assert.equal(audienceName('Lan - Hà Nội'), 'Lan - Hà Nội', 'dấu gạch giữa tên không bị đụng');
  const csv = customersToAudienceCsv([{ name: '=Lan', phone: '0912345678' }, { name: '@Hoa', phone: '0987654321' }, { name: 'Mai', phone: '0901234567' }]);
  assert.deepEqual(csv.replace(/^﻿/, '').trim().split('\r\n'), ['phone,fn,country', '84912345678,Lan,VN', '84987654321,Hoa,VN', '84901234567,Mai,VN']);
});

test('T-1: báo cáo tuần — "khách mới" từng dòng cộng lại đúng bằng tổng khi `from` rơi giữa tuần', () => {
  const HOUR = 60 * 60 * 1000;
  const at = (date, hour = 10) => Date.parse(`${date}T00:00:00Z`) + (hour - 7) * HOUR;
  const order = (id, date, phone) => ({ id, createdAt: at(date), total: 298000, status: 'Mới', source: 'Facebook', phone, products: [{ sku: 'GX', name: 'Granola Xanh', quantity: 2, price: 149000 }] });
  // Tuần 21–27/09. Khách A mua lần đầu thứ Hai 21/09 (TRƯỚC `from` 24/09) rồi mua lại 25/09; khách B mua lần đầu 26/09.
  const conversations = [
    { id: 'p:a', pageId: 'p', psid: 'a', customerOrders: [order('a1', '2026-09-21', '0911111111'), order('a2', '2026-09-25', '0911111111')] },
    { id: 'p:b', pageId: 'p', psid: 'b', customerOrders: [order('b1', '2026-09-26', '0922222222')] }
  ];
  const report = buildReport({ conversations, from: '2026-09-24', to: '2026-09-27', groupBy: 'week', now: Date.parse('2026-09-29T03:00:00Z') });
  const rowsNew = report.customers.rows.reduce((sum, row) => sum + row.new, 0);
  const rowsReturning = report.customers.rows.reduce((sum, row) => sum + row.returning, 0);
  assert.equal(report.customers.new, 1, 'chỉ khách B là khách mới trong khoảng');
  assert.equal(report.customers.returning, 1);
  assert.equal(rowsNew, report.customers.new, 'trước R13: dòng tuần tính cả khách A là "mới" (đơn đầu cùng tuần nhưng trước from) → 2 ≠ 1');
  assert.equal(rowsReturning, report.customers.returning);
});

test('TB-3: chiến dịch của tài khoản vừa đồng bộ mà Meta không còn trả (đã lưu trữ / xoá) → ARCHIVED, không còn đếm "đang chạy"', () => {
  const now = Date.parse('2026-09-29T03:00:00Z');
  const store = {
    campaigns: {
      c1: { id: 'c1', name: 'Còn chạy', status: 'ACTIVE', accountId: 'act_1' },
      c2: { id: 'c2', name: 'Đã lưu trữ trên Meta', status: 'ACTIVE', accountId: 'act_1' },
      c3: { id: 'c3', name: 'Tài khoản khác', status: 'ACTIVE', accountId: 'act_2' },
      c4: { id: 'c4', name: 'Đã xoá từ trước', status: 'DELETED', accountId: 'act_1' }
    },
    ads: {}, daily: []
  };
  mergeAdInsights(store, [{ accountId: 'act_1', campaigns: [{ id: 'c1', name: 'Còn chạy', status: 'PAUSED', accountId: 'act_1' }], ads: {}, daily: [] }], { since: '2026-09-23', until: '2026-09-29', now, accounts: ['act_1', 'act_2'] });
  assert.equal(store.campaigns.c1.status, 'PAUSED', 'trạng thái thật Meta trả ghi đè');
  assert.equal(store.campaigns.c2.status, 'ARCHIVED');
  assert.equal(store.campaigns.c2.archivedAt, now);
  assert.equal(store.campaigns.c3.status, 'ACTIVE', 'tài khoản không đồng bộ lượt này: giữ nguyên');
  assert.equal(store.campaigns.c4.status, 'DELETED');
  // Meta trả lại chiến dịch (bỏ lưu trữ): trạng thái thật ghi đè.
  mergeAdInsights(store, [{ accountId: 'act_1', campaigns: [{ id: 'c1', status: 'ACTIVE', accountId: 'act_1' }, { id: 'c2', name: 'Đã lưu trữ trên Meta', status: 'ACTIVE', accountId: 'act_1' }], ads: {}, daily: [] }], { since: '2026-09-23', until: '2026-09-29', now, accounts: ['act_1'] });
  assert.equal(store.campaigns.c2.status, 'ACTIVE');
  // Danh sách chiến dịch RỖNG (Graph trục trặc): không kết luận gì.
  mergeAdInsights(store, [{ accountId: 'act_1', campaigns: [], ads: {}, daily: [] }], { since: '2026-09-23', until: '2026-09-29', now, accounts: ['act_1'] });
  assert.equal(store.campaigns.c1.status, 'ACTIVE');
  assert.equal(store.campaigns.c2.status, 'ACTIVE');
});

test('T-3: cố vấn theo luật không khuyên "tạm dừng / tăng / giảm" chiến dịch đã dừng hay dòng không phải một chiến dịch Meta thật', () => {
  const days = (count, perDay) => Array.from({ length: count }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, '0')}`, ...perDay(index) }));
  const burn = { id: 'c-burn', name: 'Granola mới - tin nhắn', status: 'ACTIVE', source: 'meta', spend: 900000, orders: 0, revenue: 0, daily: days(6, () => ({ spend: 150000, orders: 0, revenue: 0 })) };
  const baseline = { cpa: 100000, roas: 3 };
  assert.equal(campaignFlags(burn, baseline).suggestion, 'pause');
  const paused = campaignFlags({ ...burn, status: 'PAUSED' }, baseline);
  assert.equal(paused.suggestion, null, 'đã PAUSED thì không khuyên tạm dừng nữa');
  assert.ok(paused.flags.includes('da-dung'));
  assert.equal(campaignFlags({ ...burn, status: 'ARCHIVED' }, baseline).suggestion, null);
  assert.equal(campaignFlags({ ...burn, status: '' }, baseline).suggestion, 'pause', 'chưa biết trạng thái: không chặn');
  for (const id of ['meta:unknown', 'name:Granola tháng 9', 'utm:zalo-oa']) {
    const flag = campaignFlags({ ...burn, id }, baseline);
    assert.equal(flag.suggestion, null, `${id} không phải một chiến dịch để bấm tạm dừng`);
    assert.ok(flag.flags.includes('khong-phai-chien-dich-meta'));
  }
  assert.equal(campaignFlags({ ...burn, source: 'utm' }, baseline).suggestion, null);
  assert.equal(isRealMetaCampaign({ id: '120212345', source: 'meta' }), true);
  assert.equal(isRealMetaCampaign({ id: '' }), false);
  assert.equal(campaignIsRunning({ status: 'active' }), true);
  assert.equal(campaignIsRunning({ status: 'PAUSED' }), false);
  // "watch" (ít dữ liệu) không phải thao tác ngân sách: vẫn nêu.
  assert.equal(campaignFlags({ id: 'c-new', status: 'PAUSED', source: 'meta', spend: 100000, orders: 0, daily: days(2, () => ({ spend: 50000, orders: 0, revenue: 0 })) }, baseline).suggestion, 'watch');
  const report = { totals: { spend: 1800000, orders: 10, revenue: 5000000 }, campaigns: [burn, { ...burn, id: 'c-stopped', status: 'PAUSED' }, { ...burn, id: 'meta:unknown', name: 'Quảng cáo chưa rõ chiến dịch', status: '' }] };
  assert.deepEqual(ruleBasedActions(report).map(action => [action.campaignId, action.kind]), [['c-burn', 'pause']]);
  // Mô hình AI khuyên tạm dừng chiến dịch đã dừng: hạ về "watch".
  const checked = validateInsights({ summary: 'x', actions: [{ campaignId: 'c-stopped', kind: 'pause', reason: 'chi nhiều', confidence: 'cao' }, { campaignId: 'c-burn', kind: 'pause', reason: 'chi nhiều', confidence: 'cao' }] }, report);
  assert.deepEqual(checked.actions.map(action => [action.campaignId, action.kind, action.confidence]), [['c-stopped', 'watch', 'thấp'], ['c-burn', 'pause', 'cao']]);
});

test('T-6b + L8: meta-graph có hạn chờ (Graph treo → lỗi tiếng Việt, không treo mãi); lỗi Graph có lời dẫn tiếng Việt, giữ nguyên văn phía sau', async () => {
  assert.equal(GRAPH_TIMEOUT_MS, 30000);
  const realFetch = globalThis.fetch;
  // Bộ hẹn của AbortSignal.timeout không giữ tiến trình sống (unref): trong test cần một bộ hẹn thường để vòng lặp
  // sự kiện còn chạy tới lúc hạn chờ bắn (máy chủ thật luôn có socket đang nghe).
  const keepAlive = setTimeout(() => {}, 4000);
  try {
    // Graph không bao giờ trả lời: fetch chỉ kết thúc khi tín hiệu hạn chờ bắn.
    globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
      assert.ok(init.signal, 'mọi lời gọi Graph phải mang AbortSignal');
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
    const started = Date.now();
    await assert.rejects(metaRequest('me', { timeoutMs: 40 }), error => {
      assert.match(error.message, /^Facebook \(Meta\) không phản hồi trong \d+ giây\. Vui lòng thử lại\.$/);
      assert.equal(error.statusCode, 504);
      assert.equal(error.timeout, true);
      return true;
    });
    assert.ok(Date.now() - started < 5000);
    // Graph từ chối: lời dẫn tiếng Việt + nguyên văn (để còn mã lỗi), graphMessage = nguyên văn.
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: '(#10) This message is sent outside of allowed window.', code: 10 } }) });
    await assert.rejects(metaRequest('123/messages', { method: 'POST', body: { access_token: 't' } }), error => {
      assert.equal(error.message, 'Facebook (Meta) từ chối yêu cầu: (#10) This message is sent outside of allowed window.');
      assert.equal(error.graphMessage, '(#10) This message is sent outside of allowed window.');
      assert.equal(error.statusCode, 400);
      return true;
    });
    // Graph lỗi không kèm thông báo: câu dự phòng như cũ.
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(metaRequest('me'), /^Error: Meta trả về lỗi 503\.$/);
    // Thành công: trả nguyên payload.
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: '1' }) });
    assert.deepEqual(await metaRequest('me'), { id: '1' });
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = realFetch;
  }
  const source = (await readFile(new URL('../app/meta-graph.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(source.split('await graphFetch(').length - 1, 2, 'cả metaRequest và sendPageAttachment đi qua graphFetch có hạn chờ');
  assert.doesNotMatch(source.replace(/async function graphFetch[\s\S]*?\n}\n/, ''), /await fetch\(/, 'không còn fetch trần');
});
