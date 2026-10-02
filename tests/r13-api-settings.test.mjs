// R13 (api) — Cài đặt: C2 (PUT /api/chatbot/settings gộp mẫu tin), T-2 (thẻ mặc định đã xoá không tự sống lại),
// M4 (thẻ hội thoại / thẻ khách), M8 (xoá hết quà cần confirmClear), L5, L6, L7, L8, L10, L12, tên tệp theo ngày VN.
// Ca trong báo cáo out-functions: đặt QR_OFFER tuỳ biến → PUT {"messageTemplates":{"WELCOME":"…"}} (hoặc {}) → 200, vẫn
// 124 mẫu nhưng QR_OFFER đã về bản mặc định; PATCH flags {"labels":[{"a":1},12345,"x"×5000,null]} lưu nguyên;
// `labels:[]` → vẫn 13 thẻ; PUT /api/gifts {"items":[]} xoá sạch quà kể cả miễn ship.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('r13-api-settings-');
process.env.INBOX_SETTINGS_PATH = path.join(directory, 'inbox-settings.json');
process.env.CUSTOMER_EDITS_PATH = path.join(directory, 'customer-edits.json');
process.env.STAFF_PATH = path.join(directory, 'staff.json');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');

const { mergeMessageTemplatesPatch, normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');
const { defaultMessageTemplates } = await import('../app/chatbot-templates.mjs');
const { defaultConversationLabels, mergeDefaultLabels, readInboxSettings, removedDefaultLabelIds, writeInboxSettings } = await import('../app/inbox-settings.mjs');
const { sanitizeConversationLabels, setConversationFlags } = await import('../app/messaging-store.mjs');
const { setCustomerLabels } = await import('../app/customer-edits.mjs');
const { saveStaffMember } = await import('../app/staff.mjs');
const { friendlyClientError, vnDateStamp } = await import('../app/request-errors.mjs');

const server = (await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('C2: gửi 1 mẫu (hoặc {}) KHÔNG đưa các mẫu khác về mặc định; null = về mặc định / xoá mẫu tự tạo; "" vẫn là tắt mẫu', () => {
  const seed = defaultMessageTemplates();
  const current = normalizeChatbotSettings({ messageTemplates: { ...seed, QR_OFFER: 'Ưu đãi QR đã chỉnh: tặng 1 gói nhỏ', WELCOME: 'Chào cũ', TU_TAO: 'Mẫu shop tự tạo' } }).messageTemplates;
  assert.equal(current.QR_OFFER, 'Ưu đãi QR đã chỉnh: tặng 1 gói nhỏ');
  // Script chỉ gửi WELCOME.
  const one = normalizeChatbotSettings({ messageTemplates: mergeMessageTemplatesPatch(current, { WELCOME: 'Chào mới' }) }).messageTemplates;
  assert.equal(one.WELCOME, 'Chào mới');
  assert.equal(one.QR_OFFER, 'Ưu đãi QR đã chỉnh: tặng 1 gói nhỏ', 'mẫu không gửi kèm giữ nguyên (trước đây về bản mặc định có câu giữ chỗ)');
  assert.equal(one.TU_TAO, 'Mẫu shop tự tạo');
  assert.equal(Object.keys(one).length, Object.keys(current).length);
  // Gửi {} hay không gửi: không đổi gì.
  assert.deepEqual(mergeMessageTemplatesPatch(current, {}), current);
  assert.deepEqual(mergeMessageTemplatesPatch(current, undefined), current);
  assert.deepEqual(mergeMessageTemplatesPatch(current, 'rác'), current);
  // null: mẫu có sẵn về lời mặc định, mẫu tự tạo bị xoá.
  const reset = normalizeChatbotSettings({ messageTemplates: mergeMessageTemplatesPatch(current, { QR_OFFER: null, TU_TAO: null }) }).messageTemplates;
  assert.equal(reset.QR_OFFER, normalizeChatbotSettings({ messageTemplates: seed }).messageTemplates.QR_OFFER);
  assert.equal('TU_TAO' in reset, false);
  assert.equal(reset.WELCOME, 'Chào cũ');
  // Chuỗi rỗng = tắt mẫu (không phải về mặc định).
  assert.equal(normalizeChatbotSettings({ messageTemplates: mergeMessageTemplatesPatch(current, { QR_OFFER: '' }) }).messageTemplates.QR_OFFER, '');
  // Giao diện gửi ĐỦ BỘ: kết quả đúng bằng bộ gửi lên.
  const full = { ...current, WELCOME: 'Chào đủ bộ', GIFT_SWAP: 'Đổi quà mới' };
  assert.deepEqual(mergeMessageTemplatesPatch(current, full), full);
});

test('C2: route PUT /api/chatbot/settings gộp mẫu (không còn `payload.messageTemplates ?? current.messageTemplates`); web gửi null cho mẫu vừa xoá', async () => {
  assert.match(server, /messageTemplates: mergeMessageTemplatesPatch\(current\.messageTemplates, payload\.messageTemplates\),/);
  assert.doesNotMatch(server, /messageTemplates: payload\.messageTemplates \?\? current\.messageTemplates/);
  const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(web, /chatbotDeletedTemplates\.add\(id\);/);
  assert.match(web, /messageTemplates: \{ \.\.\.chatbotTemplatesState, \.\.\.Object\.fromEntries\(\[\.\.\.chatbotDeletedTemplates\]/);
  assert.match(web, /\.map\(id => \[id, null\]\)/);
});

test('T-2: xoá thẻ mặc định ở Cài đặt → Tin nhắn thì thẻ KHÔNG tự sống lại; thẻ mặc định mới của bản phát hành vẫn được thêm; thêm lại thì bỏ dấu đã xoá', async () => {
  const initial = await readInboxSettings();
  assert.equal(initial.labels.length, defaultConversationLabels.length);
  const withoutJt = initial.labels.filter(label => !['jt', 'wholesale'].includes(label.id));
  const saved = await writeInboxSettings({ labels: withoutJt, quickReplies: [] });
  assert.equal(saved.labels.some(label => label.id === 'jt'), false, 'thẻ Giao J&T đã xoá không tự thêm lại');
  assert.equal(saved.labels.some(label => label.id === 'wholesale'), false);
  assert.deepEqual([...saved.removedDefaults].sort(), ['jt', 'wholesale']);
  // Lưu lần nữa (chỉ đổi tin trả lời nhanh, gửi lại bộ thẻ đang có): vẫn không sống lại.
  const again = await writeInboxSettings({ labels: saved.labels, quickReplies: [{ shortcut: 'gia', text: 'Giá 149k' }] });
  assert.equal(again.labels.some(label => label.id === 'jt'), false);
  // Thẻ tự gắn (Đã mua hàng, Số điện thoại) vẫn còn nguyên với sự kiện của nó.
  assert.equal(again.labels.find(label => label.id === 'customer')?.auto, 'order');
  assert.equal(again.labels.find(label => label.id === 'phone')?.auto, 'phone');
  // Nhân viên thêm lại thẻ đó: hết bị coi là đã xoá.
  const restored = await writeInboxSettings({ labels: [...again.labels, { id: 'jt', name: 'Giao J&T', color: '#b0714b' }], quickReplies: [] });
  assert.equal(restored.labels.some(label => label.id === 'jt'), true);
  assert.deepEqual(restored.removedDefaults, ['wholesale']);
  // Thẻ mặc định MỚI (chưa từng có trong bộ đã lưu, chưa từng xoá) vẫn được bổ sung như trước.
  assert.equal(mergeDefaultLabels([{ id: 'consulting', name: 'Cần người xử lý', auto: 'handoff' }], ['jt']).some(label => label.id === 'phone'), true);
  assert.equal(mergeDefaultLabels([{ id: 'consulting', name: 'Cần người xử lý', auto: 'handoff' }], ['jt']).some(label => label.id === 'jt'), false);
  assert.deepEqual(removedDefaultLabelIds({ labels: [{ id: 'consulting' }, { id: 'jt' }] }, [{ id: 'consulting', name: 'Cần người xử lý' }]), ['jt']);
  // Bộ thẻ gửi lên TRỐNG = về bộ mặc định đầy đủ (hành vi cũ giữ nguyên).
  const emptied = await writeInboxSettings({ labels: [], quickReplies: [] });
  assert.equal(emptied.labels.length, defaultConversationLabels.length);
  assert.equal(emptied.removedDefaults, undefined);
});

test('M4: thẻ hội thoại — chỉ chuỗi, bỏ trùng, ≤ 20, chỉ mã có trong Cài đặt; thẻ hội thoại đang mang (kể cả mã lạ do hệ thống gắn) không bị rơi', () => {
  const allowedIds = new Set(['consulting', 'customer', 'phone', 'complaint']);
  const dirty = [{ a: 1 }, 12345, 'x'.repeat(5000), null, 'customer', 'customer', ' phone ', 'ma-khong-co', 'complaint'];
  assert.deepEqual(sanitizeConversationLabels(dirty, { allowedIds }), ['customer', 'phone', 'complaint']);
  // Hội thoại đang mang thẻ hệ thống tự gắn có mã KHÔNG còn trong Cài đặt: bật thêm thẻ khác không làm rơi nó.
  assert.deepEqual(sanitizeConversationLabels(['followup-won', 'customer', 'consulting'], { current: ['followup-won', 'customer'], allowedIds }), ['followup-won', 'customer', 'consulting']);
  // Nhân viên bỏ một thẻ: thẻ đó mất, thẻ khác giữ.
  assert.deepEqual(sanitizeConversationLabels(['customer'], { current: ['customer', 'phone'], allowedIds }), ['customer']);
  // Không truyền danh sách cho phép (không đọc được cài đặt): vẫn lọc kiểu, trùng, độ dài.
  assert.deepEqual(sanitizeConversationLabels(['a', 'a', 5, 'b']), ['a', 'b']);
  // Trần 20: thẻ đang có được giữ trước.
  const many = Array.from({ length: 30 }, (_, index) => `the-${index}`);
  const capped = sanitizeConversationLabels([...many, 'customer'], { current: ['customer'] });
  assert.equal(capped.length, 20);
  assert.ok(capped.includes('customer'));
  const store = { conversations: [{ id: 'c1', labels: ['customer'] }] };
  setConversationFlags(store, 'c1', { labels: dirty }, { allowedLabelIds: allowedIds });
  assert.deepEqual(store.conversations[0].labels, ['customer', 'phone', 'complaint']);
  assert.match(server, /return setConversationFlags\(store, id, payload, \{ allowedLabelIds \}\);/);
});

test('M4: thẻ khách — object/số bị bỏ (không thành "[object Object]"), mã lạ không nhận, thẻ tự có từ hội thoại và thẻ đã gắn từ trước được giữ', async () => {
  const allowedIds = ['customer', 'consulting', 'vip'];
  const saved = await setCustomerLabels('phone:0912345678', [{ a: 1 }, 99, 'vip', 'vip', 'ma-la', 'customer'], ['customer'], 1000, { allowedIds });
  assert.deepEqual(saved.labels, ['vip']);
  assert.deepEqual(saved.hiddenLabels, []);
  // 'legacy' đã gắn tay từ trước khi có kiểm (không còn trong Cài đặt): gửi lại thì vẫn giữ.
  await setCustomerLabels('phone:0900000002', ['legacy'], [], 1000);
  const kept = await setCustomerLabels('phone:0900000002', ['legacy', 'consulting', 'bia-ra'], [], 2000, { allowedIds });
  assert.deepEqual(kept.labels, ['legacy', 'consulting']);
  // Gỡ thẻ tự có từ hội thoại vẫn ghi vào hiddenLabels như cũ.
  const hidden = await setCustomerLabels('phone:0900000003', [], ['customer'], 3000, { allowedIds });
  assert.deepEqual(hidden.hiddenLabels, ['customer']);
  assert.match(server, /allowedIds: await allowedLabelIdSet\(\)/);
});

test('M8: PUT /api/gifts items rỗng cần confirmClear:true (giao diện hỏi lại rồi gửi kèm)', async () => {
  assert.match(server, /if \(items && !items\.length && payload\.confirmClear !== true && getGifts\(\)\.length\) return sendJson\(response, 400, \{ error: 'Danh sách quà tặng rỗng sẽ xoá toàn bộ quà \(kể cả miễn phí vận chuyển\)/);
  const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(web, /\.\.\.\(clearingAll \? \{ confirmClear: true \} : \{\}\)/);
  assert.match(web, /Xoá TOÀN BỘ quà tặng, kể cả "Miễn phí vận chuyển"\?/);
});

test('L5 + L6 + L7: GET ảnh QR không tạo mã (mã chưa có → 404); HEAD xử lý như GET; mã nguồn bước xử lý chỉ Quản trị', () => {
  const image = server.slice(server.indexOf('if (qrImageMatch && request.method === \'GET\') {'), server.indexOf("if (request.method === 'GET' && url.pathname === '/api/products') {"));
  assert.doesNotMatch(image, /registerQrCode\(/, 'GET không ghi kho mã QR');
  assert.match(image, /if \(!knownQrCode\) return sendJson\(response, 404, \{ error: 'Chưa có mã QR này\./);
  assert.match(image, /code === qrMainCode \|\| \(await listQrScans\(\)\)\.codes\.some\(entry => entry\.code === code\)/);
  assert.match(server, /if \(request\.method === 'HEAD'\) \{\n[^\n]*\/api\/messaging\/stream[^\n]*\n\s+request\.method = 'GET';\n\s+\}/);
  const step = server.slice(server.indexOf('if (pipelineStepMatch && request.method === \'GET\') {'), server.indexOf('const customerPanelMatch'));
  assert.match(step, /if \(!\(await requireManager\(request, response, 'Chỉ chủ shop hoặc Quản trị mới xem được mã nguồn bước xử lý\.'\)\)\) return;\n\s+const step = await readPipelineStep/);
});

test('L8: lỗi kỹ thuật tiếng Anh (JSON hỏng, URI sai, đọc thuộc tính của null) thành câu tiếng Việt; lỗi nghiệp vụ giữ nguyên', () => {
  let jsonError;
  try { JSON.parse('{"a":'); } catch (error) { jsonError = error; }
  assert.equal(friendlyClientError(jsonError), 'Nội dung gửi lên không phải JSON hợp lệ.');
  let emptyError;
  try { JSON.parse(''); } catch (error) { emptyError = error; }
  assert.match(String(emptyError.message), /Unexpected end of JSON input/);
  assert.equal(friendlyClientError(emptyError), 'Nội dung gửi lên không phải JSON hợp lệ.');
  let uriError;
  try { decodeURIComponent('%E0%A4%A'); } catch (error) { uriError = error; }
  assert.match(String(uriError.message), /URI malformed/);
  assert.equal(friendlyClientError(uriError), 'Đường dẫn không hợp lệ (ký tự % mã hoá sai).');
  let nullError;
  try { null.products.length; } catch (error) { nullError = error; }
  assert.match(String(nullError.message), /Cannot read properties of null/);
  assert.equal(friendlyClientError(nullError), 'Yêu cầu không hợp lệ hoặc thiếu dữ liệu. Vui lòng kiểm tra lại rồi thử lại.');
  assert.equal(friendlyClientError(new Error('Đơn hàng cần đủ tên, số điện thoại, địa chỉ và sản phẩm.')), 'Đơn hàng cần đủ tên, số điện thoại, địa chỉ và sản phẩm.');
  assert.equal(friendlyClientError(new Error('')), 'Yêu cầu không hợp lệ.');
  assert.match(server, /sendJson\(response, 400, \{ error: friendlyRequestError\(error, \{ method: request\.method, url: request\.url \}\) \}\);/);
});

test('tên tệp tải về theo ngày VIỆT NAM (00:00–06:59 sáng không còn mang ngày hôm trước)', () => {
  assert.equal(vnDateStamp(Date.parse('2026-10-01T18:30:00Z')), '2026-10-02', '01:30 sáng 02/10 giờ VN');
  assert.equal(vnDateStamp(Date.parse('2026-10-02T16:59:59Z')), '2026-10-02');
  assert.equal(vnDateStamp(Date.parse('2026-10-02T17:00:00Z')), '2026-10-03');
  assert.equal(server.split('${vnDateStamp()}').length - 1, 4, 'remarketing, khach-hang, nhap-du-lieu, don-hang');
  assert.doesNotMatch(server, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
});

test('L10: không có tài khoản chủ shop thì không hạ quyền / cho nghỉ Quản trị cuối cùng; có tài khoản chủ shop thì được', async () => {
  const admin = await saveStaffMember({ name: 'Quản trị Một', username: 'quantri1', role: 'admin', password: 'matkhau-thu-13' });
  await saveStaffMember({ name: 'Nhân viên Hai', username: 'nhanvien2', role: 'staff', password: 'matkhau-thu-13' });
  await assert.rejects(saveStaffMember({ role: 'staff' }, { id: admin.id }), /Cần ít nhất một Quản trị đang làm có mật khẩu/);
  await assert.rejects(saveStaffMember({ active: false }, { id: admin.id }), /Cần ít nhất một Quản trị đang làm có mật khẩu/);
  // Có tài khoản chủ shop (.env) thì chủ shop vẫn vào được: cho phép.
  const demoted = await saveStaffMember({ role: 'staff' }, { id: admin.id, reservedUsernames: new Set(['chushop']) });
  assert.equal(demoted.role, 'staff');
  assert.match(server, /saveStaffMember\(payload, \{ id: staffId, reservedUsernames: new Set\(envLoginUsers\.keys\(\)\) \}\)/);
});

test('L12: test tích hợp cô lập mọi kho (*_PATH / *_DIR) về thư mục tạm; máy chủ đọc CHATBOT_SETTINGS_PATH / PRODUCTS_PATH / GIFTS_PATH', async () => {
  const integration = (await readFile(new URL('./integration/meta-webhook.integration.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const wanted = ['CHATBOT_SETTINGS_PATH', 'PRODUCTS_PATH', 'GIFTS_PATH', 'STAFF_PATH', 'INBOX_SETTINGS_PATH', 'CUSTOMER_FILE_PATH', 'CUSTOMER_EDITS_PATH',
    'LANDING_ORDERS_PATH', 'LANDING_ARCHIVE_PATH', 'ORDER_ARCHIVE_PATH', 'FOLLOW_UPS_PATH', 'PHONE_WARNINGS_PATH', 'POS_CONFIG_PATH', 'POS_COMBOS_PATH',
    'EXPORT_HISTORY_PATH', 'EXPORT_FILES_DIR', 'GOLDEN_SET_PATH', 'ADDRESS_AI_CACHE_PATH', 'AD_INSIGHTS_PATH', 'CAMPAIGN_AI_PATH', 'DECISION_LOG_DIR', 'AUDIT_LOG_DIR',
    'META_CONVERSATIONS_PATH', 'META_CHANNELS_PATH', 'QR_SCANS_PATH', 'QR_SETTINGS_PATH'];
  for (const name of wanted) assert.ok(integration.includes(`${name}:`), `test tích hợp chưa đặt ${name}`);
  assert.match(integration, /\.\.\.isolatedStorePaths,/);
  assert.match(server, /const chatbotSettingsPath = process\.env\.CHATBOT_SETTINGS_PATH \|\| path\.join\(root, 'data', 'processed', 'chatbot-settings\.json'\);/);
  assert.match(server, /const productsPath = process\.env\.PRODUCTS_PATH \|\| /);
  assert.match(server, /const giftsPath = process\.env\.GIFTS_PATH \|\| /);
});
