import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Dấu vết nhân viên phía giao diện (Cài đặt → Lịch sử, tên người gửi dưới bong bóng, dòng
// "… đã xem", hộp lịch sử hội thoại, người tạo/sửa đơn). HTML/JS thuần, không build: kiểm dây
// nối trên mã nguồn và chạy thử các hàm thuần trong vm.
const web = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const audit = await readFile(new URL('../web/audit.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const section = (source, start, length = 4000) => {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `không tìm thấy: ${start}`);
  return source.slice(at, at + length);
};
/** Cắt nguyên thân một hàm cấp cao nhất của app.js (tới dòng "}" đầu tiên ở cột 0). */
const fn = name => {
  const start = web.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `không tìm thấy hàm ${name}`);
  const end = web.indexOf('\n}\n', start);
  return web.slice(start, end + 3);
};
const appHelpers = (names, prelude = '') => {
  const context = {};
  vm.createContext(context);
  vm.runInContext([prelude, ...names.map(fn)].join('\n'), context);
  return context;
};
const vnDay = (value = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const shiftDay = (day, offset) => { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };

/** Chạy audit.js trong vm với DOM giả tối thiểu, ghi lại các URL fetch. */
function loadAuditScript(values = {}) {
  const fetched = [];
  const nodes = new Map();
  const node = (id = '') => {
    if (id && nodes.has(id)) return nodes.get(id);
    const classes = new Set(id === 'panel' ? ['hidden'] : []);
    const item = {
      id, value: values[id] ?? '', hidden: false, disabled: false, options: [], children: [], dataset: {},
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, force) => { const on = force ?? !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on; } },
      addEventListener() {}, removeEventListener() {}, setAttribute() {}, append(...items) { item.children.push(...items); }, replaceChildren(...items) { item.children = items; }, remove() {}, focus() {}
    };
    if (id) nodes.set(id, item);
    return item;
  };
  const panel = node('panel');
  const subnav = node('subnav');
  const context = {
    URLSearchParams,
    document: {
      querySelector: selector => (selector === '[data-settings-panel="audit"]' ? panel : selector === '[data-settings-section="audit"]' ? subnav : null),
      getElementById: id => node(id),
      createElement: () => node(),
      createDocumentFragment: () => node(),
      addEventListener() {}, removeEventListener() {},
      body: node('body')
    },
    fetch: async url => { fetched.push(String(url)); return { ok: true, status: 200, json: async () => ({ enabled: true, role: 'staff' }) }; },
    MutationObserver: class { observe() {} },
    setTimeout, clearTimeout
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(audit, context);
  return { context, fetched, subnav };
}

test('Cài đặt có mục "Lịch sử" sau "Nhân sự", bảng audit có đủ bộ lọc và bảng; tải audit.js/audit.css sau staff', () => {
  const subnav = section(html, '<div class="settings-subnav"', 1500);
  assert.match(subnav, /data-settings-section="staff">Nhân sự<\/button>\s*<button class="settings-subnav-item" type="button" data-settings-section="audit"[^>]*>Lịch sử<\/button>/);
  const panel = section(html, 'data-settings-panel="audit"', 3500);
  assert.match(panel, /<h1 id="audit-settings-title">Lịch sử<\/h1>/);
  assert.match(panel, /<select id="audit-range"[\s\S]*value="today">Hôm nay[\s\S]*value="7d" selected>7 ngày[\s\S]*value="30d">30 ngày[\s\S]*value="custom">Tùy chọn/);
  assert.match(panel, /id="audit-from" type="date"[\s\S]*id="audit-to" type="date"/);
  assert.match(panel, /<select id="audit-actor"/);
  for (const [value, label] of [['auth', 'Đăng nhập'], ['message', 'Tin nhắn'], ['order', 'Đơn hàng'], ['customer', 'Khách hàng'], ['settings', 'Cài đặt']]) {
    assert.match(panel, new RegExp(`<option value="${value}">${label}</option>`));
  }
  assert.match(panel, /id="audit-search" type="search"/);
  assert.match(panel, /<span>Thời gian<\/span><span>Nhân viên<\/span><span>Thao tác<\/span><span>Đối tượng<\/span><span>Chi tiết<\/span><span>IP<\/span>/);
  assert.match(panel, /id="audit-rows"/);
  assert.match(panel, /id="audit-more"[^>]*>Tải thêm</);
  assert.ok(html.indexOf('staff.js') < html.indexOf('audit.js') && html.indexOf('app.js') < html.indexOf('audit.js'), 'audit.js chạy sau app.js và staff.js');
  assert.match(html, /<link rel="stylesheet" href="audit\.css\?v=/);
});

test('audit.js không ghép HTML: không innerHTML/outerHTML/insertAdjacentHTML, chữ qua textContent', () => {
  const code = audit.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(audit, /node\.textContent = textValue/);
});

test('URL /api/audit theo bộ lọc: khoảng ngày giờ VN, nhân viên, nhóm thao tác (tiền tố, phẩy), chữ tìm, con trỏ before', () => {
  const { context } = loadAuditScript({ 'audit-range': '7d', 'audit-actor': 'phuonganh', 'audit-action': 'order', 'audit-search': '  GN-12 ' });
  const today = vnDay();
  const url = new URL(context.crmAudit.auditUrl(), 'http://crm.test');
  assert.equal(url.pathname, '/api/audit');
  assert.equal(url.searchParams.get('from'), shiftDay(today, -6));
  assert.equal(url.searchParams.get('to'), today);
  assert.equal(url.searchParams.get('actor'), 'phuonganh');
  assert.equal(url.searchParams.get('action'), 'order.,landing.');
  assert.equal(url.searchParams.get('q'), 'GN-12');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.has('before'), false);
  assert.equal(new URL(context.crmAudit.auditUrl('c-123'), 'http://crm.test').searchParams.get('before'), 'c-123');

  const message = loadAuditScript({ 'audit-range': 'today', 'audit-action': 'message' }).context;
  const messageUrl = new URL(message.crmAudit.auditUrl(), 'http://crm.test');
  assert.equal(messageUrl.searchParams.get('from'), today);
  assert.equal(messageUrl.searchParams.get('action'), 'message.,conversation.,comment.');
  assert.equal(messageUrl.searchParams.has('actor'), false);
  assert.equal(messageUrl.searchParams.has('q'), false);

  const custom = loadAuditScript({ 'audit-range': 'custom', 'audit-from': '2026-09-30', 'audit-to': '2026-09-01' }).context;
  const customUrl = new URL(custom.crmAudit.auditUrl(), 'http://crm.test');
  assert.equal(customUrl.searchParams.get('from'), '2026-09-01', 'từ > đến thì đảo lại');
  assert.equal(customUrl.searchParams.get('to'), '2026-09-30');
});

test('nhân viên thường (đăng nhập bật, role staff) bị ẩn nút Lịch sử; 403 báo "Chỉ Quản trị xem được lịch sử"', async () => {
  const { fetched, subnav } = loadAuditScript();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(fetched.includes('/api/auth/session'));
  assert.equal(subnav.hidden, true);
  assert.match(audit, /session\.role === 'staff'/);
  assert.match(audit, /error\.status === 403\) showMessage\('Chỉ Quản trị xem được lịch sử\.'/);
  assert.match(audit, /'auth\.login_failed'/);
  assert.match(audit, /is-failed/);
});

test('hộp "Lịch sử cập nhật hội thoại": nút đồng hồ ở đầu khung chat, năm tab gọi /api/audit theo conversationId + action', () => {
  const head = section(html, '<header class="chat-head">', 3000);
  assert.match(head, /<strong>Chưa có hội thoại<\/strong><small class="chat-head-seen hidden" id="chat-head-seen"><\/small>/);
  assert.match(head, /id="chat-head-history"[^>]*title="Lịch sử cập nhật hội thoại"/);
  const { context } = loadAuditScript();
  const url = new URL(context.crmAudit.conversationHistoryUrl('1035:abc', 'conversation.labels'), 'http://crm.test');
  assert.equal(url.pathname, '/api/audit');
  assert.equal(url.searchParams.get('conversationId'), '1035:abc');
  assert.equal(url.searchParams.get('action'), 'conversation.labels');
  for (const [label, action] of [['Thẻ hội thoại', 'conversation.labels'], ['Phân công nhân viên', 'conversation.assign'], ['Bot', 'conversation.bot'], ['Đơn hàng', 'order.'], ['Tin nhắn & xem', 'message.send,conversation.view']]) {
    assert.match(audit, new RegExp(`label: '${label}', action: '${action.replace(/\./g, '\\.')}'`));
  }
  assert.match(audit, /'Chưa có thay đổi nào'/);
  assert.match(audit, /getElementById\('chat-head-history'\)\?\.addEventListener\('click'/);
});

test('tên người gửi dưới bong bóng: nhân viên theo staffName, bot là "Chatbot", tin cũ "CRM"/không tên thì không hiện', () => {
  const context = appHelpers(['chatMessageSenderName', 'formatChatSenderTime']);
  assert.equal(context.chatMessageSenderName({ direction: 'outgoing', staff: true, staffName: 'Phương Anh', staffUsername: 'phuonganh' }), 'Phương Anh');
  assert.equal(context.chatMessageSenderName({ direction: 'outgoing', staff: true, staffName: 'CRM' }), '');
  assert.equal(context.chatMessageSenderName({ direction: 'outgoing', text: 'tin cũ' }), '');
  assert.equal(context.chatMessageSenderName({ direction: 'outgoing', bot: true }), 'Chatbot');
  assert.equal(context.chatMessageSenderName({ direction: 'outgoing', staffUsername: 'bot' }), 'Chatbot');
  assert.equal(context.chatMessageSenderName({ direction: 'incoming', staff: true, staffName: 'Khách' }), '');
  assert.equal(context.formatChatSenderTime(Date.UTC(2026, 9, 1, 7, 5)), '14:05');

  const append = section(web, 'function appendChatMessage(', 12000);
  assert.match(append, /const senderName = direction === 'outgoing' && action !== 'recalled' \? chatMessageSenderName\(item\) : '';/);
  assert.match(append, /sender\.className = 'message-sender';/);
  assert.match(append, /sender\.textContent = \[senderName, formatChatSenderTime\(sentAt\)\]\.filter\(Boolean\)\.join\(' · '\);/);
  assert.match(append, /row\.dataset\.sender = senderName;/);
  assert.match(fn('updateMessageGrouping'), /message-sender-repeat/, 'chuỗi tin cùng người gửi chỉ ghi tên ở tin cuối');
});

test('dòng "… đã xem" (seenBy) ở đầu khung chat: sau tin khách cuối, mới nhất trước, bỏ chính mình, quá 3 người gộp', () => {
  const context = appHelpers(['getChatTimestamp', 'formatChatSeenTime', 'chatSeenByText']);
  const at = (day, hour, minute) => Date.UTC(2026, 7, day, hour - 7, minute); // giờ VN = UTC+7
  const messages = [{ direction: 'incoming', createdAt: at(20, 16, 0) }, { direction: 'outgoing', createdAt: at(20, 16, 5) }];
  assert.equal(context.chatSeenByText({ hang: { name: 'Thúy Hằng', at: at(20, 16, 28) } }, messages, 'me'), 'Thúy Hằng đã xem · 20/08/2026 16:28');
  assert.equal(
    context.chatSeenByText({ anh: { name: 'Phương Anh', at: at(20, 16, 20) }, hang: { name: 'Thúy Hằng', at: at(20, 16, 28) }, me: { name: 'Tôi', at: at(20, 16, 40) } }, messages, 'me'),
    'Thúy Hằng, Phương Anh đã xem · 20/08/2026 16:28'
  );
  assert.equal(context.chatSeenByText({ cu: { name: 'Xem trước tin khách', at: at(20, 15, 0) } }, messages, 'me'), '', 'xem trước tin khách cuối thì không tính');
  assert.equal(
    context.chatSeenByText({ a: { name: 'A', at: at(20, 17, 4) }, b: { name: 'B', at: at(20, 17, 3) }, c: { name: 'C', at: at(20, 17, 2) }, d: { name: 'D', at: at(20, 17, 1) } }, messages, 'me'),
    'A, B và 2 người khác đã xem · 20/08/2026 17:04'
  );
  assert.equal(context.chatSeenByText(undefined, messages, 'me'), '');
  assert.equal(context.chatSeenByText({}, messages, 'me'), '');

  const render = fn('renderChatSeenBy');
  assert.match(render, /querySelector\('#chat-head-seen'\)/);
  assert.match(render, /remoteConversations\.get\(id\)\?\.seenBy/);
  assert.match(render, /'Chưa có người xem'/);
  assert.match(render, /sessionLoginEnabled/, '"Chưa có người xem" chỉ khi đã bật đăng nhập');
  assert.match(render, /seenBy\[sessionUsername\] = \{ name: sessionDisplayName \|\| sessionUsername, at: Date\.now\(\) \}/, 'người đang mở hội thoại cũng tính là đã xem');
  assert.match(fn('renderChatMessages'), /renderChatSeenBy\(conversation\);/);
  assert.match(section(web, 'function connectMessagingStream()', 1500), /addEventListener\('conversation'/);
});

test('thẻ đơn trong khung khách: "Tạo bởi <tên> · giờ", nút Lịch sử mở danh sách lần sửa; chữ được escape', () => {
  const context = appHelpers(['escapeHtml', 'formatCustomerPanelTime', 'customerOrderAuthorship']);
  const markup = context.customerOrderAuthorship({
    id: 'GN<1>',
    createdAt: Date.UTC(2026, 9, 1, 7, 5),
    createdBy: { username: 'phuonganh', name: 'Phương <Anh>' },
    history: [
      { at: Date.UTC(2026, 9, 1, 7, 10), by: { username: 'hang', name: 'Thúy Hằng' }, action: 'order.update', summary: 'Đổi địa chỉ' },
      { at: Date.UTC(2026, 9, 1, 8, 0), by: { username: 'bot', name: 'Chatbot AI' }, action: 'order.status', summary: 'Xác nhận' }
    ]
  });
  assert.match(markup, /Tạo bởi Phương &lt;Anh&gt; · /);
  assert.doesNotMatch(markup, /<Anh>/);
  assert.match(markup, /data-order-action="history" data-order-id="GN&lt;1&gt;" aria-expanded="false">Lịch sử \(2\)</);
  assert.match(markup, /<ol class="customer-order-history hidden" data-order-history="GN&lt;1&gt;">/);
  assert.ok(markup.indexOf('Chatbot AI') < markup.indexOf('Thúy Hằng'), 'lần sửa mới nhất trước');
  assert.equal(context.customerOrderAuthorship({ id: 'x', employee: 'Bạn' }), '', 'đơn cũ không có createdBy/history thì không thêm dòng');

  const card = fn('renderCustomerOrders');
  assert.match(card, /'NV tạo đơn', customerOrderStaff\(order\.createdBy\?\.name \|\| order\.employee/);
  assert.match(card, /'NV sửa cuối', customerOrderStaff\(order\.updatedBy\?\.name/);
  assert.match(card, /\$\{customerOrderAuthorship\(order\)\}/);
  assert.match(section(web, "customerOrderList?.addEventListener('click'", 2000), /orderAction === 'history'/);
});

test('bảng Đơn hàng: dòng đơn hệ thống có chú thích "Tạo bởi … / Sửa lần cuối bởi … lúc …" từ createdBy/updatedBy', () => {
  const context = appHelpers(['escapeHtml', 'formatCustomerPanelTime', 'rememberSystemOrderAuthors', 'systemOrderAuthorTitle'], 'const systemOrderAuthors = new Map();');
  context.rememberSystemOrderAuthors('CB-7', { createdBy: { name: 'Chatbot AI' }, updatedBy: { name: 'Thúy Hằng' }, updatedAt: Date.UTC(2026, 9, 1, 7, 5) });
  const title = context.systemOrderAuthorTitle('CB-7');
  assert.match(title, /^Tạo bởi Chatbot AI\nSửa lần cuối bởi Thúy Hằng lúc /);
  assert.equal(context.systemOrderAuthorTitle('CB-8'), '');
  context.rememberSystemOrderAuthors('CB-7', {});
  assert.equal(context.systemOrderAuthorTitle('CB-7'), '', 'đơn không còn người tạo/sửa thì bỏ chú thích');
  assert.match(fn('renderOrderTable'), /const authorTitle = orderIdIndex >= 0 \? systemOrderAuthorTitle\(entry\.row\[orderIdIndex\]\) : '';\s*return `<tr class="[^\n]*\$\{authorTitle \? ` title="\$\{escapeHtml\(authorTitle\)\}"` : ''\} data-order-row-index=/);
  assert.match(fn('mergeChatbotOrdersIntoTable'), /rememberSystemOrderAuthors\(rowId, order\);/);
});

test('mở đối tượng: app.js có openConversationById (đổi đúng Page) và openOrderById (lọc bảng Đơn hàng mọi ngày)', () => {
  assert.match(fn('openConversationById'), /openCustomerConversation\(\{ conversations: \[\{ id \}\], channelId:/);
  const order = fn('openOrderById');
  assert.match(order, /showView\('orders'\)/);
  assert.match(order, /orderSearch\.value = id;/);
  assert.match(audit, /window\.openOrderById\(orderId\)/);
  assert.match(audit, /window\.openConversationById\(conversationId\)/);
});
