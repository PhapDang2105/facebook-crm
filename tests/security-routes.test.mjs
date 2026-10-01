import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// server.mjs khởi động máy chủ ngay khi nạp, nên kiểm trên MÃ NGUỒN (như tests/audit-routes.test.mjs):
// mọi route GHI của Cài đặt phải mở đầu bằng chốt quản lý, còn việc hằng ngày của nhân viên thì không.
const server = (await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const GUARD = 'if (!(await requireManager(request, response';

// Route chỉ chủ shop / Quản trị được ghi. `open`: đoạn mã mở khối route (duy nhất trong server.mjs).
const MANAGER_ONLY_ROUTES = [
  { route: 'PUT /api/qr/settings', open: "if (url.pathname === '/api/qr/settings') {\n      if (request.method === 'GET') return sendJson(response, 200, await readQrSettings());\n      if (request.method === 'PUT') {" },
  { route: 'POST /api/qr/codes', open: "if (request.method === 'POST' && url.pathname === '/api/qr/codes') {" },
  { route: 'DELETE /api/qr/codes/:code', open: "if (qrDeleteMatch && request.method === 'DELETE') {" },
  { route: 'POST /api/products', open: "if (request.method === 'POST' && url.pathname === '/api/products') {" },
  { route: 'PUT|DELETE /api/products/:id', open: "if (productMatch && ['PUT', 'DELETE'].includes(request.method)) {" },
  { route: 'POST /api/chatbot/golden/import', open: "if (request.method === 'POST' && url.pathname === '/api/chatbot/golden/import') {" },
  { route: 'POST /api/chatbot/golden/label', open: "if (request.method === 'POST' && url.pathname === '/api/chatbot/golden/label') {" },
  { route: 'POST /api/chatbot/follow-ups/run', open: "if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/run') {" },
  { route: 'POST /api/chatbot/follow-ups/queue', open: "if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/queue') {" },
  { route: 'POST /api/chatbot/follow-ups/batch', open: "if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/batch') {" },
  { route: 'POST /api/chatbot/follow-ups/prune', open: "if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/prune') {" },
  { route: 'PUT /api/chatbot/settings', open: "if (request.method === 'PUT' && url.pathname === '/api/chatbot/settings') {" },
  { route: 'POST /api/chatbot/master-switch', open: "if (request.method === 'POST' && url.pathname === '/api/chatbot/master-switch') {" },
  { route: 'POST /api/chatbot/test', open: "if (request.method === 'POST' && url.pathname === '/api/chatbot/test') {" },
  { route: 'POST /api/channels/meta/confirm', open: "if (request.method === 'POST' && url.pathname === '/api/channels/meta/confirm') {" },
  { route: 'DELETE /api/channels/facebook/:id', open: "if (request.method === 'DELETE' && channelMatch) {" },
  { route: 'POST /api/channels/facebook/:id/profiles', open: "if (request.method === 'POST' && profilesChannelMatch) {" },
  { route: 'POST /api/channels/facebook/:id/refresh', open: "if (request.method === 'POST' && refreshChannelMatch) {" },
  { route: 'POST /api/phone-warnings/pos (khóa API POS)', open: "if (request.method === 'POST' && url.pathname === '/api/phone-warnings/pos') {" },
  { route: 'DELETE /api/phone-warnings/pos', open: "if (request.method === 'DELETE' && url.pathname === '/api/phone-warnings/pos') {" },
  { route: 'PUT /api/inbox/settings', open: "if (request.method === 'PUT') {\n        if (!(await requireManager(request, response))) return;\n        const current = await readInboxSettings();" },
  { route: 'PUT /api/gifts', open: "if (request.method === 'PUT') {\n        if (!(await requireManager(request, response))) return;\n        const payload = await readBody(request);\n        // Không gửi `items`" },
  { route: 'POST /api/staff, PATCH /api/staff/:id', open: "if (creating || (request.method === 'PATCH' && staffMatch)) {" },
  // Quyết định chủ shop 01/10: tải toàn bộ danh sách khách ra tệp, đồng bộ quảng cáo và Cố vấn AI (tốn lượt gọi) chỉ Quản trị.
  { route: 'GET /api/customers/export.csv|audience.csv', open: "if (request.method === 'GET' && (url.pathname === '/api/customers/export.csv' || url.pathname === '/api/customers/audience.csv')) {" },
  { route: 'POST /api/campaigns/sync', open: "if (request.method === 'POST' && url.pathname === '/api/campaigns/sync') {" },
  { route: 'POST /api/campaigns/insights (Cố vấn AI)', open: "if (request.method === 'POST' && url.pathname === '/api/campaigns/insights') {" }
];

/** Vài dòng đầu của khối route (sau `{` mở khối). */
function routeHead(open, lines = 3) {
  const count = server.split(open).length - 1;
  assert.equal(count, 1, `không thấy (hoặc thấy ${count} lần) khối route: ${open.slice(0, 90)}`);
  const at = server.indexOf(open);
  const firstLineEnd = server.indexOf('{\n', at + open.split('\n')[0].length - 1);
  return server.slice(firstLineEnd + 2).split('\n').slice(0, lines).join('\n');
}

test('phân quyền: mọi route ghi của Cài đặt mở đầu bằng requireManager (nhân viên thường bị 403)', () => {
  const missing = [];
  for (const item of MANAGER_ONLY_ROUTES) {
    if (!routeHead(item.open).includes(GUARD)) missing.push(item.route);
  }
  assert.deepEqual(missing, [], `Route Cài đặt chưa có chốt quản lý:\n${missing.join('\n')}`);
  // Không ai lỡ xoá chốt ở chỗ khác mà danh sách vẫn xanh: đếm tổng.
  assert.ok(server.split(GUARD).length - 1 >= MANAGER_ONLY_ROUTES.length, 'số chốt requireManager ít hơn số route Cài đặt');
});

test('phân quyền: requireManager dựa trên isManager của actor (actorOf), trả 403 JSON', () => {
  assert.match(server, /const requireManager = createRequireManager\(requestActor, sendJson\);/);
  assert.match(server, /const requestActor = request => actorOf\(request, \{ auth, envLoginUsers \}\);/);
});

test('phân quyền: việc hằng ngày của nhân viên KHÔNG bị chặn (nhắn tin, gắn thẻ, lên/sửa đơn, xem hội thoại)', () => {
  const staffRoutes = [
    { route: 'POST customer-panel (lên đơn)', open: "if (payload.type === 'order') {" },
    { route: 'PATCH /api/customer-orders/:id (sửa đơn)', open: "if (customerOrderDeleteMatch && request.method === 'PATCH') {" },
    { route: 'POST /api/customer-orders/:id/pos', open: "if (customerOrderPosMatch && request.method === 'POST') {" },
    { route: 'POST read', open: "if (request.method === 'POST' && conversationReadMatch) {" },
    { route: 'PATCH flags', open: "if (request.method === 'PATCH' && conversationFlagsMatch) {" },
    { route: 'POST /api/messaging/sync', open: "if (request.method === 'POST' && url.pathname === '/api/messaging/sync') {" },
    // Đồng bộ đơn landing từ POS: vẫn cho nhân viên (quyết định 01/10).
    { route: 'POST /api/landing/sync-pos', open: "if (request.method === 'POST' && url.pathname === '/api/landing/sync-pos') {" },
    // Xem danh sách khách trên màn Khách hàng (JSON) vẫn mở; chỉ tải tệp CSV mới cần Quản trị.
    { route: 'GET /api/customers (JSON)', open: "if (request.method === 'GET' && (url.pathname === '/api/customers' || url.pathname === '/api/customers/export.csv' || url.pathname === '/api/customers/audience.csv')) {" },
    { route: 'PUT labels khách', open: "if (customerRoute[1] === 'labels' && request.method === 'PUT') {" },
    { route: 'POST /api/chatbot/follow-ups/release', open: "if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/release') {" }
  ];
  for (const item of staffRoutes) {
    const at = server.indexOf(item.open);
    assert.ok(at > 0, `không thấy route ${item.route}`);
    assert.ok(!server.slice(at, at + 600).includes('requireManager('), `${item.route} không được chặn nhân viên`);
  }
  // Đọc kết quả Cố vấn AI đã chạy (GET) vẫn cho mọi người.
  const insightsGet = server.indexOf("if (request.method === 'GET' && url.pathname === '/api/campaigns/insights') {");
  assert.ok(insightsGet > 0 && !server.slice(insightsGet, insightsGet + 200).includes('requireManager('), 'GET /api/campaigns/insights không được chặn nhân viên');
  // Gửi tin trong hội thoại: khối ngay sau "const conversationMessagesMatch".
  const send = server.slice(server.indexOf('const conversationMessagesMatch'), server.indexOf('const conversationReadMatch'));
  assert.doesNotMatch(send, /requireManager\(/);
});

test('nhật ký: /api/audit kiểm quyền và truy vấn bằng CÙNG bộ lọc đã trim (SEC-1: ?conversationId=%20 không lọt)', () => {
  const block = server.slice(server.indexOf("if (request.method === 'GET' && url.pathname === '/api/audit') {"), server.indexOf("if (url.pathname === '/api/staff' || url.pathname.startsWith('/api/staff/')) {"));
  assert.match(block, /const filters = auditFiltersFrom\(url\.searchParams\);/);
  assert.match(block, /if \(!canReadAudit\(isManager\(actor\), filters\)\) \{/);
  assert.match(block, /await queryAudit\(filters\)/);
});
