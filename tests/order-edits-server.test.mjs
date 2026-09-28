import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// server.mjs khởi động máy chủ ngay khi nạp (và ghi cấu hình chatbot thật), nên các nhánh
// dưới đây được kiểm trên mã nguồn; logic thuần nằm ở module riêng có test hành vi
// (order-edits-reprice, pos-orders-combo, conversation-orders).
const server = await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8');
const web = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const section = (source, start, length = 4000) => {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `không tìm thấy: ${start}`);
  return source.slice(at, at + length);
};

test('N2: PATCH sửa đơn chỉ PUT sang POS khi đơn do CRM tạo (isCrmOwnedPosOrder), đơn nguồn POS thì không', () => {
  assert.match(server, /updated\.pos\?\.id && isCrmOwnedPosOrder\(updated\) && \['name'/);
  assert.match(server, /import \{[^}]*isCrmOwnedPosOrder[^}]*\} from '\.\/pos-orders\.mjs'/);
});

test('nhẹ (f): chống trùng đơn bot so thêm giỏ (comboKey) — khác giỏ cùng tổng không coi là trùng', () => {
  const guard = section(server, 'async function createChatbotCustomerOrder', 2500);
  assert.match(guard, /Number\(entry\.total\) === Number\(order\.total\)/);
  assert.match(guard, /basketKeyOf\(entry\) === basketKeyOf\(order\)/);
  assert.match(server, /function basketKeyOf\(order\)[\s\S]{0,300}comboKey\(/);
});

test('V7/W1: /api/orders/price nhận cờ livestream (ưu tiên) hoặc conversationId (suy như bot) và truyền priceBasket', () => {
  const route = section(server, "url.pathname === '/api/orders/price'", 2500);
  assert.match(route, /typeof payload\.livestream === 'boolean'/);
  assert.match(route, /payload\.conversationId/);
  assert.match(route, /isLivestreamCustomer\(conversation\)/);
  assert.match(route, /priceBasket\(items, \{ livestream \}\)/);
  assert.match(route, /livestream,/, 'trả cờ về cho form để đơn tạo mới mang cờ');
  // Form gửi conversationId; đơn live đang sửa gửi thẳng cờ; đơn tạo mới mang cờ livestream.
  assert.match(web, /function customerDraftPricingBody\(items\)[\s\S]{0,300}conversationId[\s\S]{0,200}livestream: true/);
  assert.equal((web.match(/customerDraftPricingBody\(/g) || []).length >= 3, true, 'cả hai chỗ gọi /api/orders/price dùng chung body');
  assert.match(web, /customerDraftPricedLivestream \? \{ livestream: true \} : \{\}/);
});

test('G1: PUT /api/gifts — thiếu items giữ quà cũ; phí ship null/"" → 400; tên quà trùng → 400; tên không phải chữ → 400', () => {
  const route = section(server, "if (url.pathname === '/api/gifts')", 4500);
  assert.match(route, /const hasItems = payload\.items !== undefined;/);
  assert.match(route, /items: items \|\| current\.items/);
  assert.match(route, /typeof item\?\.name !== 'string'/);
  assert.match(route, /Tên quà trùng/);
  assert.match(route, /payload\.shippingFee === null/);
});

test('G2: PUT /api/chatbot/settings gộp sâu bằng mergeChatbotSettingsPatch; chỉ tra DNS khi kết nối AI đổi; form không gửi handoffKeywords rỗng', () => {
  const route = section(server, "request.method === 'PUT' && url.pathname === '/api/chatbot/settings'", 3000);
  assert.match(route, /\.\.\.mergeChatbotSettingsPatch\(current, payload\)/);
  assert.doesNotMatch(route, /\.\.\.current,\s*\.\.\.payload/);
  assert.match(route, /if \(connectionChanged\) \{[\s\S]{0,400}assertPublicHost/);
  const form = section(web, 'welcomeMessage: chatbotSettingsWelcome.value,', 600);
  assert.doesNotMatch(form, /handoffKeywords: ''/);
  assert.doesNotMatch(form, /maxPerRun:/);
});

test('web: Hoàn tác sửa đơn chỉ gửi lại ô vừa sửa (không gửi Đơn giá khi chỉ sửa số lượng)', () => {
  const undo = section(web, "pushUndo('sửa đơn'", 2000);
  assert.match(undo, /line\.quantity !== undefined \? \{ quantity: cellOf\('so luong'\) \} : \{\}/);
  assert.match(undo, /line\.price !== undefined \? \{ price: cellOf\('don gia'\) \} : \{\}/);
});

test('web W2: nháp ô soạn tin giữ theo mã hội thoại (Map), không theo phần tử DOM; bỏ autosizeComposer thừa', () => {
  assert.match(web, /const composerDrafts = new Map\(\);/);
  assert.doesNotMatch(web, /composerDrafts = new WeakMap/);
  assert.doesNotMatch(web, /autosizeComposer\(\);\s*\n\s*autosizeComposer\(\);/);
});

test('G2: bản vá chỉ { complaintKeywords } (như route PUT: normalize(merge(current, payload))) giữ nguyên followUps, cascadeCanary, handoffKeywords', async () => {
  const { mergeChatbotSettingsPatch, normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');
  const current = normalizeChatbotSettings({
    handoffKeywords: 'gặp nhân viên, khiếu nại',
    cascadeCanary: 30,
    followUps: { enabled: true, maxPerRun: 7, scenarios: [{ id: 'inbox-3h', enabled: true, delayHours: 3, templateId: 'FOLLOW_UP_INBOX' }] }
  });
  const saved = normalizeChatbotSettings({ ...mergeChatbotSettingsPatch(current, { complaintKeywords: 'hàng lỗi, bị mốc' }), updatedAt: 1 });
  assert.deepEqual(saved.followUps, current.followUps);
  assert.equal(saved.cascadeCanary, current.cascadeCanary);
  assert.equal(saved.handoffKeywords, current.handoffKeywords);
  assert.notEqual(saved.complaintKeywords, current.complaintKeywords);
  // Form cấu hình AI gửi followUps chỉ { enabled, scenarios }: maxPerRun đang lưu được giữ.
  const toggled = normalizeChatbotSettings(mergeChatbotSettingsPatch(current, { followUps: { enabled: false, scenarios: current.followUps.scenarios } }));
  assert.equal(toggled.followUps.enabled, false);
  assert.equal(toggled.followUps.maxPerRun, current.followUps.maxPerRun);
});

test('giờ ghi vào ghi chú đơn (khách sửa/hủy qua bot, POS hủy) theo giờ Việt Nam: máy chủ chạy UTC nên mọi toLocaleTimeString phải có timeZone', () => {
  const calls = server.match(/toLocaleTimeString\([^)]*\)/g) || [];
  assert.ok(calls.length >= 3);
  for (const call of calls) assert.match(call, /timeZone: 'Asia\/Ho_Chi_Minh'/, call);
});
