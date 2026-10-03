// R13 (api) — giao diện: các mục trong bảng tồn đọng của out-functions (đọc MÃ NGUỒN web/, như các test fix-web-*):
// Nhân sự hiện hai hàng tiêu đề + màn hẹp không nhãn cột; "Tìm kiếm Ctrl K" và Sao chép/Mở rộng prompt, Tạo khách mới /
// Chọn khách không có xử lý; công tắc chatbot tổng cần nói rõ hệ quả; đơn tay trùng phải hỏi lại; đơn mở lại sau khi POS hủy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async name => (await readFile(new URL(`../web/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const [html, app, staff, staffCss, quick, quickCss, styles] = await Promise.all(['index.html', 'app.js', 'staff.js', 'staff.css', 'quick-search.js', 'quick-search.css', 'styles.css'].map(read));

test('Nhân sự: đúng MỘT hàng tiêu đề (staff.js vẽ, index.html không có hàng tĩnh); màn ≤ 1100px mỗi ô tự mang nhãn cột', () => {
  // 03/10: hai lần sửa "tiêu đề lặp" bỏ ở hai nơi khác nhau → không còn hàng nào; nay thống nhất staff.js vẽ một hàng.
  assert.equal(html.split('staff-table-head').length - 1, 0);
  assert.equal(staff.split("el('div', 'staff-row staff-table-head')").length - 1, 1, 'staff.js vẽ đúng một hàng tiêu đề');
  // Nhãn cột lấy từ MỘT danh sách (cùng chữ với hàng tiêu đề) và gắn cho từng ô qua data-label.
  assert.ok(staff.includes("const columns = ['Họ tên', 'Tên đăng nhập', 'Vai trò', 'Số điện thoại', 'Tên trên Pancake/POS', 'Mật khẩu', 'Trạng thái'];"));
  for (const name of ['loginLabel', 'roleLabel', 'phoneLabel', 'pancakeLabel', 'passwordLabel', 'statusLabel']) {
    assert.ok(staff.includes(`cell(${name},`), `ô ${name} phải mang data-label`);
  }
  assert.match(staff, /node\.dataset\.label = label;/);
  const narrow = staffCss.slice(staffCss.indexOf('@media (max-width: 1100px)'));
  assert.match(narrow, /\.staff-table-head \{ display: none; \}/);
  assert.match(narrow, /\.staff-row > span\[data-label\]::before \{ content: attr\(data-label\) ": ";/);
});

test('Tìm kiếm Ctrl K: tệp riêng nạp sau app.js; tìm khách/hội thoại và đơn bằng API sẵn có; mở hội thoại / hồ sơ / đơn', () => {
  assert.match(html, /<script src="quick-search\.js\?v=[^"]+"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="quick-search\.css\?v=[^"]+">/);
  assert.ok(html.indexOf('quick-search.js') > html.indexOf('src="app.js'), 'quick-search.js chạy sau app.js (dùng hàm toàn cục của app.js)');
  assert.match(quick, /document\.querySelector\('\.search-trigger'\)/);
  assert.match(quick, /getJson\(`\/api\/customers\?q=\$\{encoded\}`\)/);
  assert.match(quick, /getJson\(`\/api\/orders\/archive\?q=\$\{encoded\}&limit=\$\{PER_GROUP\}`\)/);
  assert.match(quick, /String\(event\.key\)\.toLowerCase\(\) !== 'k'/);
  assert.match(quick, /\(event\.ctrlKey \|\| event\.metaKey\)/);
  assert.match(quick, /openCustomerConversation\(customer\)/);
  assert.match(quick, /openCustomerDialog\(customer\)/);
  assert.match(quick, /openOrderById\(order\.id\)/);
  // Chữ của người dùng không ghép vào innerHTML.
  assert.doesNotMatch(quick, /innerHTML/);
  for (const name of ['openCustomerConversation', 'openCustomerDialog', 'openOrderById', 'showView']) assert.match(app, new RegExp(`\\nfunction ${name}\\(|\\nasync function ${name}\\(`), `app.js phải còn hàm toàn cục ${name}`);
  assert.match(quickCss, /\.quick-search\.hidden \{ display: none; \}/);
  // Không tự vẽ icon mới: ô tìm nhanh không có thẻ <svg>.
  assert.doesNotMatch(quick, /<svg|createElementNS/);
});

test('Sao chép / Mở rộng prompt và Tạo khách mới / Chọn khách có xử lý', () => {
  assert.match(app, /const chatbotPromptCopy = document\.querySelector\('#chatbot-prompt-copy'\);/);
  assert.match(app, /await navigator\.clipboard\.writeText\(text\);/);
  assert.match(app, /chatbotPromptExpand\?\.addEventListener\('click', \(\) => setChatbotPromptExpanded\(/);
  assert.match(styles, /\.llm-prompt\.is-expanded \{ position: fixed; inset: 24px;/);
  assert.match(app, /document\.querySelector\('#customer-order-new'\)\?\.addEventListener\('click'/);
  assert.match(app, /document\.querySelector\('#customer-order-pick'\)\?\.addEventListener\('click'/);
  assert.match(app, /window\.crmQuickSearch\.pickCustomer\(customer => \{/);
  assert.match(quick, /window\.crmQuickSearch = \{ open: \(\) => open\(\), pickCustomer: callback => open\(\{ pick: callback \}\) \};/);
  for (const id of ['chatbot-prompt-copy', 'chatbot-prompt-expand', 'customer-order-new', 'customer-order-pick']) assert.ok(html.includes(`id="${id}"`), `index.html phải còn nút #${id}`);
});

test('công tắc chatbot tổng: hộp xác nhận nói rõ "sẽ đặt lại trạng thái bot của mọi hội thoại" cho cả bật lẫn tắt', () => {
  const block = app.slice(app.indexOf("chatbotSettingsEnabled?.addEventListener('change'"), app.indexOf("fetch('/api/chatbot/master-switch'"));
  assert.equal(block.split('sẽ đặt lại trạng thái bot của mọi hội thoại').length - 1, 2);
  assert.match(block, /if \(!window\.confirm\(question\)\) \{\n\s+chatbotSettingsEnabled\.checked = !desired;\n\s+return;/);
});

test('đơn tay trùng (409): hỏi lại bằng câu của máy chủ, đồng ý thì gửi lại kèm force; đơn mở lại sau khi POS hủy có nút "Lên lại POS"', () => {
  assert.match(app, /if \(createResponse\.status === 409\) \{/);
  assert.match(app, /if \(!window\.confirm\(conflict\.error \|\| 'Đơn giống hệt vừa tạo — vẫn tạo\?'\)\) \{/);
  assert.match(app, /createResponse = await postOrder\(true\);/);
  assert.match(app, /JSON\.stringify\(\{ type: 'order', order, \.\.\.\(force \? \{ force: true \} : \{\}\) \}\)/);
  assert.match(app, /if \(pos\?\.needsRepush && pos\?\.cancelled && String\(order\.processingStatus \|\| ''\) !== 'cancelled'\) \{/);
  assert.match(app, /Đã hủy trên POS — cần lên lại/);
  assert.match(app, /data-order-action="pos" data-order-id="\$\{escapeHtml\(String\(order\.id\)\)\}">Lên lại POS<\/button>/);
});

test('cảnh báo đồng bộ POS (chạm trần trang) hiện ở Cài đặt → Kênh; lỗi thử chatbot không còn tiền tố "Test lỗi"', () => {
  assert.match(app, /function posSyncNotice\(sync\) \{/);
  assert.match(app, /\$\{posSyncNotice\(pos\.sync\)\}/);
  assert.doesNotMatch(app, /Test lỗi:/);
});
