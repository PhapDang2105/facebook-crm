import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// server.mjs khởi động máy chủ ngay khi nạp, nên kiểm trên MÃ NGUỒN: mọi route ghi (POST/PUT/PATCH/
// DELETE) do người dùng gọi phải ghi nhật ký hoạt động (`audit(request` hay appendLabelAudit /
// appendBotToggleAudit). Route nào thêm mới mà quên ghi nhật ký là test này đỏ, kèm danh sách.
const server = await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8');

// Route ghi KHÔNG ghi nhật ký, có lý do. Mỗi mục: chuỗi nhận diện nằm trong khối route + lý do.
const EXEMPT = [
  { marker: 'processWebhookPayload(', reason: 'webhook Meta: máy gọi máy, tự xác thực chữ ký; việc của bot đã có journal' },
  { marker: 'handlePancakeWebhook(', reason: 'webhook Pancake: máy gọi máy; thẻ/bot/phân công tự động ghi trong pancake.mjs' },
  { marker: 'recordQrOpen(', reason: 'khách quét QR bấm nút trên trang đệm (không phải người dùng CRM)' },
  { marker: "'/api/phone-warnings/check'", reason: 'chỉ tra cứu cảnh báo SĐT, không đổi dữ liệu' },
  { marker: "'/api/chatbot/test'", reason: 'thử câu trả lời của bot (xem trước), không lưu gì' },
  { marker: "'/api/orders/price'", reason: 'tính giá giỏ cho form tạo đơn, không lưu gì' },
  { marker: "'/api/orders/export/preview'", reason: 'xem trước file xuất kho, không lưu gì (xuất thật ghi order.export)' },
  { marker: "'/api/chatbot/follow-ups/release'", reason: 'nhả giữ chỗ lô bám đuổi khi Dừng/đóng trang, không đổi dữ liệu khách' }
];

const AUDIT_CALL = /\baudit\(request\b|\bappendAudit\(|\bappendLabelAudit\(|\bappendBotToggleAudit\(|\bappendAssignAudit\(/;

/**
 * Vị trí `}` đóng khối mở ở `open` (source[open] === '{'). Bỏ qua chuỗi '…' "…", template `…${…}…`
 * (lồng nhau), chú thích, ký tự thoát và regex literal (đoán theo ký tự đứng trước dấu /).
 */
function blockEnd(source, open) {
  let i = open;
  const skipString = (start, quote) => {
    let j = start + 1;
    while (j < source.length && source[j] !== quote) j += source[j] === '\\' ? 2 : 1;
    return j;
  };
  const skipRegex = start => {
    let j = start + 1;
    let inClass = false;
    while (j < source.length) {
      const ch = source[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) return j;
      else if (ch === '\n') return start; // không phải regex
      j += 1;
    }
    return j;
  };
  const regexAllowedAfter = position => {
    let k = position - 1;
    while (k >= 0 && /\s/.test(source[k])) k -= 1;
    if (k < 0) return true;
    if ('(,=:[!&|?{};+-*%<>~^'.includes(source[k])) return true;
    return /\b(?:return|typeof|case|in|of|void|delete|throw|new)$/.test(source.slice(Math.max(0, k - 8), k + 1));
  };
  // Đọc mã tới `}` làm depth về 0; dùng lại cho phần ${…} của template.
  const scanCode = start => {
    let depth = 0;
    let j = start;
    while (j < source.length) {
      const ch = source[j];
      const next = source[j + 1];
      if (ch === '\'' || ch === '"') j = skipString(j, ch);
      else if (ch === '`') j = scanTemplate(j);
      else if (ch === '/' && next === '/') { j = source.indexOf('\n', j); if (j < 0) return source.length; }
      else if (ch === '/' && next === '*') { j = source.indexOf('*/', j + 2) + 1; }
      else if (ch === '/' && regexAllowedAfter(j)) j = skipRegex(j);
      else if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) return j; }
      j += 1;
    }
    return j;
  };
  const scanTemplate = start => {
    let j = start + 1;
    while (j < source.length) {
      const ch = source[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '`') return j;
      if (ch === '$' && source[j + 1] === '{') { j = scanCode(j + 1) + 1; continue; }
      j += 1;
    }
    return j;
  };
  i = scanCode(open);
  return i;
}

/** Mọi khối `if (… request.method === 'POST|PUT|PATCH|DELETE' …) { … }` của bộ xử lý request. */
function writeRoutes(source) {
  const start = source.indexOf('async function handleAuth(');
  assert.ok(start > 0, 'không thấy handleAuth trong server.mjs');
  const routes = [];
  const pattern = /request\.method === '(POST|PUT|PATCH|DELETE)'|\[('(?:PUT|POST|PATCH|DELETE)'(?:, '[A-Z]+')*)\]\.includes\(request\.method\)/g;
  pattern.lastIndex = start;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    const ifAt = source.lastIndexOf('if (', match.index);
    // `const creating = request.method === 'POST' && …` không phải điều kiện if: khối if dùng nó được bắt riêng.
    if (ifAt < lineStart) continue;
    // Điều kiện kết thúc ở `)` khớp với `if (`; sau đó phải là `{` (route), không phải câu lệnh một dòng.
    let depth = 0;
    let close = ifAt + 3;
    for (; close < source.length; close += 1) {
      if (source[close] === '(') depth += 1;
      else if (source[close] === ')') { depth -= 1; if (depth === 0) break; }
    }
    const open = source.indexOf('{', close);
    if (source.slice(close + 1, open).trim() !== '') continue;
    const end = blockEnd(source, open);
    const block = source.slice(ifAt, end + 1);
    if (routes.some(route => route.ifAt === ifAt)) continue;
    routes.push({ ifAt, condition: source.slice(ifAt, close + 1), block, line: source.slice(0, ifAt).split('\n').length });
  }
  return routes;
}

test('nhật ký: bộ tách khối route đọc đúng (khối khép kín, đủ số route ghi)', () => {
  const routes = writeRoutes(server);
  assert.ok(routes.length >= 45, `chỉ tách được ${routes.length} route ghi — bộ tách hỏng?`);
  for (const route of routes) {
    assert.ok(route.block.endsWith('}'), `khối route dòng ${route.line} không khép`);
    assert.ok(route.block.length < 20000, `khối route dòng ${route.line} dài bất thường (${route.block.length}) — tách sai?`);
  }
});

test('nhật ký: MỌI route POST/PUT/PATCH/DELETE của người dùng đều ghi nhật ký (trừ danh sách ngoại lệ có lý do)', () => {
  const missing = [];
  const usedExemptions = new Set();
  for (const route of writeRoutes(server)) {
    if (AUDIT_CALL.test(route.block)) continue;
    const exemption = EXEMPT.find(item => route.block.includes(item.marker));
    if (exemption) { usedExemptions.add(exemption.marker); continue; }
    missing.push(`dòng ${route.line}: ${route.condition.slice(0, 140)}`);
  }
  assert.deepEqual(missing, [], `Route ghi chưa có nhật ký hoạt động:\n${missing.join('\n')}`);
  // Danh sách ngoại lệ không được cũ: mục nào không còn khớp route nào thì xoá.
  const stale = EXEMPT.filter(item => !usedExemptions.has(item.marker)).map(item => item.marker);
  assert.deepEqual(stale, [], `Ngoại lệ không còn khớp route nào: ${stale.join(', ')}`);
});

test('nhật ký: đăng nhập / đăng nhập sai / đăng xuất; xem hội thoại gộp 30 phút; seenBy cập nhật khi mở và khi đọc', () => {
  const login = server.slice(server.indexOf("url.pathname === '/api/auth/login'"), server.indexOf("url.pathname === '/api/auth/logout'"));
  assert.match(login, /audit\(request, 'auth\.login_failed'/);
  assert.match(login, /audit\(request, 'auth\.login'/);
  assert.doesNotMatch(login, /summary:[^\n]*password/, 'không ghi mật khẩu');
  assert.match(server, /audit\(request, 'auth\.logout'/);
  const view = server.slice(server.indexOf('const conversationMessagesMatch'), server.indexOf("if (request.method === 'POST') {", server.indexOf('const conversationMessagesMatch')));
  assert.match(view, /recordConversationSeen\(id, actor\)/);
  assert.match(view, /if \(shouldAuditView\(actor\.username \|\| actor\.ip, id\)\) audit\(request, 'conversation\.view'/);
  const read = server.slice(server.indexOf('const conversationReadMatch'), server.indexOf('const conversationFlagsMatch'));
  assert.match(read, /markConversationSeen\(store, id, \{ username: actor\.username, name: actor\.name \}\)/);
  assert.match(read, /publishMessagingEvent\(\{ type: 'conversation'/);
  assert.match(server, /const shouldStoreSeen = createViewThrottle\(\{ windowMs: 60 \* 1000 \}\)/);
});

test('nhật ký: tin nhân viên gửi mang họ tên người gửi; đơn tạo tay có createdBy; sửa đơn ghi history', () => {
  const send = server.slice(server.indexOf("// Ảnh/tài liệu/ghi âm ≤ 2 MB"), server.indexOf('const conversationReadMatch'));
  assert.match(send, /const staff = actor\.username \? actorStamp\(actor\) : true;/);
  assert.doesNotMatch(send, /staff: true \}/, 'không còn gửi cờ staff trơn (tên CRM)');
  assert.match(send, /'comment\.private_reply' : 'comment\.reply'\) : 'message\.send'/);
  const create = server.slice(server.indexOf("if (payload.type === 'order') {"), server.indexOf("if (payload.type === 'order') {") + 3000);
  assert.match(create, /stampOrderCreated\(order, creator/);
  assert.match(create, /audit\(request, 'order\.create'/);
  const patch = server.slice(server.indexOf('if (customerOrderDeleteMatch && request.method === \'PATCH\')'), server.indexOf('// Gửi lại phiếu xác nhận đơn cho khách'));
  assert.match(patch, /recordOrderHistory\(draft, \{ by: actorStamp\(actor\), action: edit\.action, summary: edit\.summary \}\)/);
  assert.match(patch, /orderEditAction\(changed, draft\)/);
});

test('API /api/audit: chủ shop/Quản trị xem hết; nhân viên thường chỉ khi lọc theo hội thoại hay đơn; trả label/actors/actions', () => {
  const route = server.slice(server.indexOf("url.pathname === '/api/audit'"), server.indexOf("url.pathname === '/api/staff' || url.pathname.startsWith('/api/staff/')"));
  assert.match(route, /if \(!isManager\(actor\) && !filters\.conversationId && !filters\.orderId\)/);
  assert.match(route, /sendJson\(response, 403, \{ error:/);
  assert.match(route, /label: auditActionLabel\(item\.action\)/);
  assert.match(route, /next: result\.next/);
  assert.match(route, /actors:/);
  assert.match(route, /actions: Object\.entries\(AUDIT_ACTIONS\)/);
  for (const key of ['from', 'to', 'actor', 'action', 'q', 'conversationId', 'orderId', 'limit', 'before']) assert.match(route, new RegExp(`'${key}'`));
});
