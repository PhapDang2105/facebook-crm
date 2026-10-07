import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { keywordInText, normalizeText, productKeywords } from '../app/processing/catalog.mjs';

// Sửa giao diện 01/10 (web/app.js, staff.js, login.js, styles.css): chạy các hàm thuần trong vm
// và kiểm dây nối trên mã nguồn, như các tệp *-web.test.mjs khác (không có bước build).
const read = async file => (await readFile(new URL(`../web/${file}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const web = await read('app.js');
const staffJs = await read('staff.js');
const loginJs = await read('login.js');
const loginHtml = await read('login.html');
const html = await read('index.html');
const css = await read('styles.css');
const staffCss = await read('staff.css');
const auditJs = await read('audit.js');

const section = (source, start, length = 4000) => {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `không tìm thấy: ${start}`);
  return source.slice(at, at + length);
};
/** Cắt nguyên thân một hàm cấp cao nhất (tới dòng "}" đầu tiên ở cột 0). */
const fn = name => {
  const start = web.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `không tìm thấy hàm ${name}`);
  const end = web.indexOf('\n}\n', start);
  return web.slice(start, end + 3);
};
const run = (names, context = {}, prelude = '') => {
  vm.createContext(context);
  vm.runInContext([prelude, ...names.map(fn)].join('\n'), context);
  return context;
};

// Danh mục mẫu giống products.seed (tên, SKU, tên gọi khác).
const products = [
  { name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', salePrice: 174000, comboPrice: 149000, weight: 450, active: true, aliases: ['túi xanh', 'granola túi xanh', 'granola xanh', '#granolatuixanh'] },
  { name: 'Granola Túi Vàng 350g', sku: 'GRA-VANG-H350', salePrice: 174000, comboPrice: 149000, weight: 350, active: true, aliases: ['túi vàng', 'granola túi vàng', 'granola nhiều hạt quả'] },
  { name: 'Combo 10 gói Granola Xanh', sku: 'CB10-XANH-G35', salePrice: 299000, comboPrice: 0, weight: 350, active: true, aliases: ['combo 10 gói xanh', '10 gói xanh'] },
  { name: 'Granola Cũ', sku: 'GRA-CU', salePrice: 100000, active: false, aliases: ['túi cũ'] }
];
const catalogContext = () => run(['normalizeCatalogText', 'catalogProductKeywords', 'catalogKeywordInText', 'catalogKeywordIndex', 'findSharedProduct'],
  { sharedProducts: products }, 'let catalogIndexCache = { source: null, entries: [] };');

test('[1] findSharedProduct khớp không dấu như máy chủ: "tui xanh" là Túi Xanh, không thành dòng 0đ', () => {
  const { findSharedProduct } = catalogContext();
  assert.equal(findSharedProduct('tui xanh')?.sku, 'GRA-XANH-Z450');
  assert.equal(findSharedProduct('TÚI XANH')?.sku, 'GRA-XANH-Z450');
  assert.equal(findSharedProduct('2tui vang')?.sku, 'GRA-VANG-H350', 'chữ số đứng trước tên gọi vẫn khớp');
  assert.equal(findSharedProduct('gra-xanh-z450')?.sku, 'GRA-XANH-Z450', 'SKU không phân biệt hoa thường');
  assert.equal(findSharedProduct('combo 10 goi xanh')?.sku, 'CB10-XANH-G35', 'tên gọi dài nhất thắng (không đọc thành 1 túi xanh)');
  assert.equal(findSharedProduct('tui dau tien'), null, 'tên gọi chữ phải đứng thành từ trọn');
  assert.equal(findSharedProduct('túi cũ'), null, 'sản phẩm ngừng bán không khớp theo tên');
  assert.equal(findSharedProduct('GRA-CU')?.sku, 'GRA-CU', 'đúng SKU vẫn trả về (máy chủ báo unknown-product như cũ)');
  assert.equal(findSharedProduct('granola tui'), null, 'gõ dở trùng nhiều sản phẩm: không đoán');
  assert.equal(findSharedProduct('vang-h3')?.sku, 'GRA-VANG-H350', 'gõ dở chỉ trùng một sản phẩm: nhận');
  assert.equal(findSharedProduct(''), null);
});

test('[1] chuẩn hoá và luật khớp của form trùng với app/processing/catalog.mjs', () => {
  const { normalizeCatalogText, catalogKeywordInText, catalogProductKeywords } = catalogContext();
  for (const value of ['Túi Xanh', '  ĐẶT 2 túi   vàng\n', 'Granola Nhiều Hạt Quả 350g', 'đậu đỏ', 'Cacao 300G', 'a\\nb']) {
    assert.equal(normalizeCatalogText(value), normalizeText(value), value);
  }
  for (const [content, keyword] of [['2tui xanh', 'tui xanh'], ['tui dau tien', 'tui dau'], ['cacao 300g', 'cacao 300'], ['mua tui xanhh', 'tui xanh'], ['#granolatuixanh nha', '#granolatuixanh']]) {
    assert.equal(catalogKeywordInText(content, keyword), keywordInText(content, keyword), `${content} / ${keyword}`);
  }
  for (const product of products) {
    assert.deepEqual([...catalogProductKeywords(product)].sort(), [...productKeywords(product)].sort(), product.name);
  }
});

test('[1] tổng tiền form lấy subtotal của /api/orders/price khi giỏ chưa đổi và không có giá sửa tay', () => {
  const refresh = fn('refreshCustomerDraftPricing');
  assert.match(refresh, /customerDraftServerPricing = priced\?\.priceable && !customerDraftProducts\.some\(item => item\.manualPrice\)/);
  assert.match(refresh, /item\.sku = line\.sku/, 'dòng gõ tự do nhận SKU máy chủ khớp được');
  const totals = fn('updateCustomerOrderTotals');
  assert.match(totals, /customerDraftServerPricing\.signature === customerDraftSignature\(\) \? customerDraftServerPricing : null/);
  assert.match(totals, /const subtotal = server \? server\.subtotal : localSubtotal;/);
  assert.match(fn('renderCustomerDraftProducts'), /cell-unmatched/, 'dòng chưa khớp danh mục được đánh dấu');
});

test('[2] gửi phiếu thất bại: toast cảnh báo thay vì "Đã gửi xác nhận"', () => {
  const { customerOrderDeliveryOutcome: outcome } = run(['customerOrderDeliveryOutcome']);
  // Máy chủ cũ (không có cờ) → coi như đã gửi.
  assert.equal(outcome({ orders: [{ id: '1', delivery: { status: 'sent' } }] }, '1').failed, false);
  assert.equal(outcome({}, '1').failed, false);
  // Các dạng cờ máy chủ có thể trả.
  assert.equal(outcome({ receiptSent: false }, '1').failed, true);
  assert.equal(outcome({ receipt: { sent: false, error: 'fetch failed' } }, '1').reason, 'fetch failed');
  assert.equal(outcome({ receiptError: 'Token hết hạn' }, '1').reason, 'Token hết hạn');
  assert.equal(outcome({ orders: [{ id: '15265', delivery: { status: 'failed', error: 'fetch failed' } }] }, '15265').failed, true);
  assert.equal(outcome({ orders: [{ id: '9', delivery: { status: 'failed' } }] }, '15265').failed, false, 'chỉ xét đơn vừa tạo');
  const submit = section(web, "customerOrderForm?.addEventListener('submit'", 6000);
  assert.match(submit, /if \(delivery\.failed\) \{\s*showToast\(`Đã tạo đơn \$\{createdId\} nhưng CHƯA gửi được phiếu/);
});

test('[3] nguồn đơn tạo tay là "Nhập tay" ở Đơn hàng, cùng luật với Báo cáo (order-facts orderSourceKey)', () => {
  const { systemOrderSourceLabel: label } = run(['systemOrderSourceLabel']);
  assert.equal(label({ source: 'Facebook', employee: 'Phương Anh' }), 'Nhập tay');
  assert.equal(label({ source: '' }), 'Nhập tay');
  assert.equal(label({ source: 'Facebook', employee: 'Chatbot AI' }), 'Chatbot');
  assert.equal(label({ source: 'Facebook', automatic: true }), 'Chatbot');
  assert.equal(label({ source: 'Landing page' }), 'Landing page');
  assert.equal(label({ source: 'Facebook', landing: {} }), 'Landing page');
  assert.equal(label({ source: 'POS' }), 'Pancake');
  assert.equal(label({ source: 'Zalo' }), 'Zalo');
  assert.match(html, /<option value="Nhập tay">/, 'bộ lọc nguồn đơn có "Nhập tay"');
});

test('[5] bảng đơn lưu ở trình duyệt không bị xoá lúc tải trang; vào thẳng Xuất dữ liệu là dựng bảng xuất', () => {
  const load = section(web, 'let savedOrderData = null;', 500);
  assert.doesNotMatch(load, /ensureOrderStaffNoteColumn/, 'không gọi hàm dùng hằng khai báo phía dưới (ReferenceError → catch xoá bảng)');
  assert.match(load, /catch \{\s*try \{ localStorage\.removeItem\('crm-orders'\); \} catch \{\}\s*\}/, 'chỉ xoá khi JSON hỏng');
  assert.match(section(web, '// Bảng đọc từ trình duyệt lúc tải', 300), /orderData = ensureOrderStaffNoteColumn\(orderData\);\n[^\n]*\nrenderOrderData\(\);/);
  assert.match(fn('showOrderStage'), /else if \(stage === 'export'\) renderExportPreview\(\);/);
});

test('[7] tự đổi mật khẩu: máy chủ cấp lại cookie → ở lại CRM; đổi tên đăng nhập không kèm mật khẩu / tự cho nghỉ → về /login', () => {
  assert.match(staffJs, /const endsOwnSession = self && \(deactivatingSelf \|\| \(usernameChanged && !body\.password\)\);/);
  assert.match(staffJs, /if \(ownQuestion && !window\.confirm\(ownQuestion\)\) return;/);
  assert.match(staffJs, /Máy này vẫn giữ đăng nhập/);
  assert.match(staffJs, /location\.assign\(`\/login\?reason=expired&next=/);
  assert.doesNotMatch(staffJs, /reason=\$\{body\.password/, 'không còn đá về /login khi chỉ đổi mật khẩu của mình');
  assert.match(loginHtml, /id="login-notice" role="status" hidden/);
  assert.match(fn('redirectToLogin'), /reason=expired/, '401 (phiên cũ hết hiệu lực) → /login?reason=expired');
});

test('[8] chi tiết khách: tên Page lấy từ danh sách kênh, lịch sử đơn gộp đơn trong hội thoại', () => {
  const { customerChannelName: name } = run(['customerChannelName'], { messageChannels: [{ id: '103549382215599', name: 'Giọt Nắng' }] });
  assert.equal(name({ channelId: '103549382215599' }), 'Giọt Nắng');
  assert.equal(name({ channelId: '1', channelName: 'Page A' }), 'Page A');
  assert.equal(name({ channelId: '999' }), '999');
  assert.match(fn('openCustomerDialog'), /customerConversationOrders\(customer\)/);
  assert.match(fn('customerConversationOrders'), /\/customer-panel`/);
});

test('[11] Page đồng bộ lỗi: chấm đỏ + giờ lỗi; đồng bộ lại thành công thì hết', () => {
  const { channelSyncError: syncError } = run(['channelSyncError', 'formatOrderDate']);
  assert.equal(syncError({ status: 'connected' }), '');
  assert.match(syncError({ syncError: 'fetch failed', syncErrorAt: new Date(2026, 9, 1, 15, 18).getTime() }), /^Lỗi đồng bộ lúc 01\/10 15:18: fetch failed$/);
  assert.match(syncError({ sync: { ok: false } }), /Đồng bộ thất bại/);
  assert.equal(syncError({ syncError: 'x', syncErrorAt: 1000, syncedAt: 2000 }), '');
  assert.match(fn('renderFacebookChannels'), /syncError \|\| channel\.status === 'error' \? ' error'/);
  assert.match(css, /\.channel-connected-dot\.error \{ background: #d92d20; \}/);
});

test('[12] không gọi API trùng: hashchange do showView tự đặt bị bỏ qua, phiên/kênh/POS dùng chung lần gọi', () => {
  assert.match(fn('showView'), /hashSetByShowView = name;\s*window\.location\.hash = name;/);
  assert.match(section(web, "window.addEventListener('hashchange'", 400), /if \(setByCode && setByCode === name\) return;/);
  assert.match(web, /window\.crmSessionRequest = crmSessionRequest;/);
  assert.equal((web.match(/fetch\('\/api\/channels'\)/g) || []).length, 1, 'chỉ một chỗ gọi /api/channels');
  assert.match(fn('loadPosChannel'), /if \(posChannelRequest\) return posChannelRequest;/);
  assert.match(auditJs, /window\.crmSessionRequest \|\|/, 'audit.js dùng lại lần hỏi phiên của app.js');
});

test('[13] SL/phí âm, SĐT tại ô, thông báo chuông chỉ giữ tin quan trọng, định dạng chung', () => {
  const { customerPhoneProblem: phone } = run(['customerPhoneProblem']);
  assert.equal(phone(''), '');
  assert.equal(phone('0912 345 678'), '');
  assert.equal(phone('+84912345678'), '');
  assert.notEqual(phone('12345abc'), '');
  assert.notEqual(phone('09123'), '');
  assert.match(section(web, "customerProductList?.addEventListener('input'", 1500), /startsWith\('-'\)\) field\.value = String\(isQuantity \? item\.quantity : item\.price\)/);
  assert.match(web, /const NOTIFICATION_STORED_TYPES = new Set\(\['error', 'critical'\]\);/);
  const { formatVnDate, formatVnMoney, formatOrderMoney, formatCustomerMoney } = run(['formatVnDate', 'formatVnMoney', 'formatOrderMoney', 'formatCustomerMoney']);
  assert.equal(formatVnDate(new Date(2026, 8, 5)), '05/09/2026');
  assert.equal(formatVnDate(''), '');
  assert.equal(formatVnMoney(149000), '149.000đ');
  assert.equal(formatOrderMoney(447000), '447.000đ');
  assert.equal(formatCustomerMoney(0), '—');
  assert.match(fn('chatbotTemplateLabel'), /COMMENT_PUBLIC_REPEAT: '/, 'mẫu bình luận có tên tiếng Việt');
  assert.match(staffJs, /'Họ tên', 'Tên đăng nhập', 'Vai trò'/, 'Nhân sự có hàng tiêu đề cột');
  assert.match(staffJs, /Số điện thoại chưa đúng/);
});

test('[14] SSE: sắp xếp đủ nhưng chỉ dời dòng lệch chỗ; thứ tự cuối luôn đúng', () => {
  // Danh sách giả: mảng con + insertBefore, đếm số lần dời.
  const makeList = items => {
    const list = { children: [...items], moves: 0 };
    list.insertBefore = (node, anchor) => {
      list.moves += 1;
      list.children.splice(list.children.indexOf(node), 1);
      const at = anchor ? list.children.indexOf(anchor) : list.children.length;
      list.children.splice(at, 0, node);
    };
    return list;
  };
  const context = run(['moveConversationsIntoOrder', 'longestIncreasingRun'], {});
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 200; round += 1) {
    const size = 1 + Math.floor(random() * 40);
    const nodes = Array.from({ length: size }, (_, index) => ({ id: index }));
    const empty = { id: 'empty' };
    const list = makeList([...nodes, empty]);
    const ordered = [...nodes].sort(() => random() - 0.5);
    Object.assign(context, { conversationList: list, conversationEmpty: Object.assign(empty, { parentNode: list }) });
    context.moveConversationsIntoOrder([...nodes], ordered);
    assert.deepEqual(list.children.slice(0, -1).map(node => node.id), ordered.map(node => node.id));
    assert.equal(list.children.at(-1), empty, 'ô "Không tìm thấy" vẫn đứng cuối');
  }
  // Một hội thoại nhảy lên đầu: đúng một lần chèn (trước đây chèn lại cả danh sách).
  const nodes = Array.from({ length: 2200 }, (_, index) => ({ id: index }));
  const empty = { id: 'empty' };
  const list = makeList([...nodes, empty]);
  Object.assign(context, { conversationList: list, conversationEmpty: Object.assign(empty, { parentNode: list }) });
  context.moveConversationsIntoOrder([...nodes], [nodes[1500], ...nodes.filter((_, index) => index !== 1500)]);
  assert.equal(list.moves, 1);
  assert.match(fn('sortConversationsByRecentActivity'), /moveConversationsIntoOrder\(conversations, ordered\);/);
  assert.match(fn('filterConversations'), /conversationSearchKey\(conversation\)\.includes\(query\)/, 'chuỗi tìm kiếm bỏ dấu được lưu sẵn');
  assert.match(css, /\.conversation-list \.conversation \{ content-visibility: auto;/);
});

test('[10] tự mở lại hội thoại cũ: tin mới không bị đánh dấu đã đọc cho tới khi nhân viên thao tác', () => {
  assert.match(fn('reopenLastConversation'), /autoReopenedConversationId = element\.dataset\.conversationId \|\| '';/);
  assert.match(fn('selectConversation'), /autoReopenedConversationId = '';/);
  const handle = fn('handleMessagingEvent');
  assert.match(handle, /const attended = isActive && !isUnattendedConversation\(activeElement\);/);
  assert.match(handle, /if \(attended && event\.message\?\.direction === 'incoming'\) markRemoteConversationRead\(element\);/);
});

test('[6][9][15] nút Quản trị ẩn bằng CSS cho nhân viên; bố cục hẹp; CSS chết đã xoá', () => {
  assert.match(css, /body\.role-staff \.is-staff-readonly :is\(\[data-channel-action\]/);
  assert.match(css, /\.order-import-summary \{ flex-wrap: wrap;/);
  assert.match(css, /\.chatbot-template-editor \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  for (const dead of ['.chatbot-provider-card', '.chatbot-llm-options', '.follow-up-queue-item', '.follow-up-queue-actions', '.follow-up-queue-error', '.follow-up-status ']) {
    assert.ok(!css.includes(dead), `còn ${dead}`);
  }
  assert.ok(!staffCss.includes('.staff-login-note') && !staffCss.includes('.staff-field-hint'));
  assert.match(css, /\.follow-up-queue-head \{/, 'class còn dùng thì giữ');
});

test('[nối tiếp 1] nhân viên: ẩn/khoá Xuất danh sách khách, Tệp remarketing, Đồng bộ quảng cáo, AI phân tích', () => {
  assert.match(css, /body\.role-staff :is\(\.customers-export, #campaigns-sync, #campaigns-ai-run, #competitors-sync, #competitors-ai-run, \.campaigns-ai-decide button, \[data-competitor-remove\], \[data-competitor-ad-remove\]\) \{ display: none !important; \}/);
  assert.match(fn('syncCampaigns'), /if \(campaignsSyncing \|\| isStaffReadOnly\(\)\) return;/);
  assert.match(fn('analyzeCampaigns'), /if \(campaignsAnalyzing \|\| isStaffReadOnly\(\)\) return;/);
  assert.match(section(web, "customersExportButton?.addEventListener('click'", 300), /if \(isStaffReadOnly\(\)\) return;/);
  assert.match(html, /class="customers-export"/);
  assert.match(html, /id="campaigns-sync"/);
  assert.match(html, /id="campaigns-ai-run"/);
});

test('[nối tiếp 2] PATCH khách / đơn trả warnings → toast vàng + dòng cảnh báo dưới SĐT, không chặn', () => {
  const toasts = [];
  const context = run(['saveWarnings', 'showSaveWarnings'], { showToast: (...args) => toasts.push(args) });
  assert.deepEqual([...context.saveWarnings({ warnings: ['SĐT lạ', '', ' Số đã có ở khách khác '] })], ['SĐT lạ', 'Số đã có ở khách khác']);
  assert.equal(context.saveWarnings({}).length, 0);
  assert.equal(context.showSaveWarnings([]), false);
  assert.equal(context.showSaveWarnings(['SĐT lạ']), true);
  assert.equal(toasts[0][1], 'warning', 'vàng, không vào chuông');
  assert.match(fn('saveCustomerSheet'), /const warnings = kind === 'profile' \? saveWarnings\(result\) : \[\];/);
  assert.match(fn('renderCustomerSheet'), /class="field-warning"/);
  assert.match(section(web, "customerOrderForm?.addEventListener('submit'", 3000), /showSaveWarnings\(saveWarnings\(updated\)/);
  assert.match(css, /\.field-warning \{/);
});

test('[nối tiếp 3] đọc đúng receiptSent / receiptVia / receiptError và delivery {status:"failed", error, failedAt} của máy chủ', () => {
  const { customerOrderDeliveryOutcome: outcome } = run(['customerOrderDeliveryOutcome']);
  const failed = { receiptSent: false, receiptVia: 'receipt-image', receiptError: 'Chưa gửi được phiếu xác nhận cho khách (Pancake không nhận tin).', createdOrderId: '15265',
    orders: [{ id: '15265', delivery: { status: 'failed', messageId: '', failedAt: 1, via: 'receipt-image', error: 'fetch failed' } }] };
  assert.deepEqual({ ...outcome(failed, '15265') }, { failed: true, reason: failed.receiptError });
  assert.equal(outcome({ orders: [{ id: '7', delivery: { status: 'failed', failedAt: 1, error: 'fetch failed' } }] }, '7').reason, 'fetch failed', 'chỉ có delivery của đơn cũng nhận ra');
  for (const via of ['pos', 'receipt-image', 'messenger']) {
    assert.equal(outcome({ receiptSent: true, receiptVia: via, receiptError: '', orders: [{ id: '1', delivery: { status: 'sent', via } }] }, '1').failed, false, via);
  }
  assert.match(section(web, "customerOrderForm?.addEventListener('submit'", 6000), /panel\.receiptVia === 'pos'/);
});

test('[nối tiếp 4] /api/channels: syncError + syncErrorAt (ms) + syncedAt (ISO) → chấm đỏ đúng', () => {
  const { channelSyncError: syncError } = run(['channelSyncError', 'formatOrderDate']);
  const errorAt = new Date(2026, 9, 1, 15, 18).getTime();
  // Dạng máy chủ trả khi chưa đồng bộ lần nào / đang ổn.
  assert.equal(syncError({ status: 'connected', syncedAt: '', syncError: '', syncErrorAt: 0 }), '');
  assert.equal(syncError({ syncedAt: new Date(errorAt).toISOString(), syncError: '', syncErrorAt: 0 }), '');
  // Lỗi mới hơn lần đồng bộ thành công cuối (ISO) → báo lỗi.
  assert.match(syncError({ syncedAt: new Date(errorAt - 600000).toISOString(), syncError: 'fetch failed', syncErrorAt: errorAt }), /^Lỗi đồng bộ lúc 01\/10 15:18: fetch failed$/);
  // Đồng bộ thành công (ISO) sau lỗi → hết lỗi.
  assert.equal(syncError({ syncedAt: new Date(errorAt + 600000).toISOString(), syncError: 'fetch failed', syncErrorAt: errorAt }), '');
});

test('bộ lọc nhãn tin nhắn: chọn nhiều nhãn theo cơ chế AND và hiển thị số nhãn', () => {
  const context = {
    selectedMessageLabels: new Set(),
    currentMessageLabel: 'all'
  };
  run(['conversationMatchesSelectedLabels'], context);
  const { conversationMatchesSelectedLabels: match } = context;

  const convA = { classList: { contains: c => c === 'unread' }, dataset: { source: 'inbox', labels: 'livestream consulting' } };
  const convB = { classList: { contains: () => false }, dataset: { source: 'comment', labels: 'wholesale livestream' } };
  const convC = { classList: { contains: () => false }, dataset: { source: 'inbox', labels: '' } };

  // Chưa chọn nhãn nào -> Tất cả -> match mọi hội thoại
  assert.equal(match(convA, ['livestream', 'consulting'], 'inbox'), true);
  assert.equal(match(convB, ['wholesale', 'livestream'], 'comment'), true);
  assert.equal(match(convC, [], 'inbox'), true);

  // Chọn 1 nhãn 'wholesale'
  context.selectedMessageLabels.add('wholesale');
  assert.equal(match(convA, ['livestream', 'consulting'], 'inbox'), false);
  assert.equal(match(convB, ['wholesale', 'livestream'], 'comment'), true);

  // Chọn thêm nhãn 'livestream' -> Cơ chế AND: chỉ hội thoại có CẢ livestream VÀ wholesale mới khớp
  context.selectedMessageLabels.add('livestream');
  assert.equal(match(convA, ['livestream', 'consulting'], 'inbox'), false, 'convA thiếu wholesale nên không khớp');
  assert.equal(match(convB, ['wholesale', 'livestream'], 'comment'), true, 'convB có cả wholesale và livestream nên khớp');
  assert.equal(match(convC, [], 'inbox'), false);

  // Kiểm tra nhãn đặc biệt: unread AND livestream
  context.selectedMessageLabels.clear();
  context.selectedMessageLabels.add('unread');
  context.selectedMessageLabels.add('livestream');
  assert.equal(match(convA, ['livestream', 'consulting'], 'inbox'), true, 'convA vừa unread vừa có livestream');
  assert.equal(match(convB, ['wholesale', 'livestream'], 'comment'), false, 'convB có livestream nhưng không unread');

  // Kiểm tra toggle và nút hiển thị trên mã nguồn
  assert.match(fn('updateMessageLabelFilterUI'), /Nhãn \(\$\{count\}\)/);
  assert.match(web, /selectedMessageLabels\.add\(labelId\)/);
  assert.match(web, /selectedMessageLabels\.delete\(labelId\)/);
  assert.match(css, /\.message-label-menu button\.active::after \{ content: '✓';/);
});
