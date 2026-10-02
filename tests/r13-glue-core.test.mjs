// Vòng 13 (02/10) — bước GỘP cuối: các việc nhỏ agent chuyển cho nhau còn sót.
// (1) LIVE_ONLY / FLAVOR_LIST một nguồn ở rule-intent; (2) mặc định cascadeThreshold 0,85; (4) order-notes đọc
// processingFlags + gợi ý phường/xã của AI hiện ℹ; (5) 6 mã mẫu mới vào seed, không thuộc nhóm mô hình tự trả lời;
// (6) colourText dùng chung normalizeColourTypos ("Túi vâng" là Túi Vàng); (7) bảng ảnh /q/brand/* một nguồn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

await import('./helpers/seed-catalog.mjs');
const { FLAVOR_LIST, LIVE_ONLY, core } = await import('../app/processing/rule-intent.mjs');
const { asksFlavourList, CASCADE_TEMPLATE_THRESHOLD, fallbackTemplates } = await import('../app/chatbot-engine.mjs');
const { normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');
const { colourCountsInText, defaultMessageTemplates, orderGiftFallbackTemplates, sanitizeModelAnswer } = await import('../app/chatbot-templates.mjs');
const { groupOf, isIntentionalOther, subGroupOf } = await import('../app/processing/intent-cascade.mjs');
const { processingNotes } = await import('../app/order-notes.mjs');
const { addProcessingFlag, orderProcessingNotes } = await import('../app/order-edits.mjs');
const { dashboardTodo } = await import('../app/dashboard.mjs');

const source = name => readFileSync(new URL(`../app/${name}`, import.meta.url), 'utf8').replace(/\r/g, '');

test('1. LIVE_ONLY và FLAVOR_LIST xuất từ rule-intent; engine dùng đúng bản đó, không còn bản chép dự phòng', () => {
  assert.ok(LIVE_ONLY instanceof RegExp && FLAVOR_LIST instanceof RegExp);
  for (const text of ['sữa hạt còn không shop', 'cho mình hũ hạt', 'đậu sấy bao nhiêu']) assert.equal(LIVE_ONLY.test(core(text)), true, text);
  assert.equal(LIVE_ONLY.test(core('2 túi xanh')), false);
  for (const text of ['Có mays lọi', 'co may loai vay shop', 'có mấy vị']) assert.equal(asksFlavourList(text), true, text);
  for (const text of ['ok em', 'gửi cho chị nha', '2 túi xanh']) assert.equal(asksFlavourList(text), false, text);
  const engine = source('chatbot-engine.mjs');
  assert.match(engine, /import \{[^}]*\bFLAVOR_LIST\b[^}]*\bLIVE_ONLY\b[^}]*\} from '\.\/processing\/rule-intent\.mjs';/);
  assert.doesNotMatch(engine, /ruleIntentExports/, 'không còn nhập cả không gian tên để dò export');
  assert.doesNotMatch(engine, /\(sua hat\|hat dieu\|hat bi\|xoai\|dau say\|hu hat\)/, 'không còn bản chép regex hàng live trong engine');
  assert.match(engine, /const liveOnlyProductPattern = LIVE_ONLY;/);
});

test('2. cascadeThreshold mặc định 0,85 (khớp hằng của engine); giá trị đã lưu giữ nguyên; chế độ shadow không đổi', () => {
  const defaults = normalizeChatbotSettings({ enabled: true });
  assert.equal(defaults.cascadeThreshold, 0.85);
  assert.equal(defaults.cascadeThreshold, CASCADE_TEMPLATE_THRESHOLD);
  assert.deepEqual([defaults.intentCascade, defaults.intentModel], ['shadow', 'shadow']);
  // Cài đặt đã lưu trên máy chủ (0,8) không bị đổi theo mặc định mới.
  assert.equal(normalizeChatbotSettings({ enabled: true, cascadeThreshold: 0.8 }).cascadeThreshold, 0.8);
  assert.equal(normalizeChatbotSettings({ cascadeThreshold: '' }, normalizeChatbotSettings({ cascadeThreshold: 0.8 })).cascadeThreshold, 0.8);
});

const fullOrder = (extra = {}) => ({
  id: 'o1', createdAt: Date.now() - 60_000, phone: '0912345678',
  address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', street: '12 Lê Lợi', ward: 'Phường Bến Nghé', district: 'Quận 1', province: 'TP Hồ Chí Minh', locationConfidence: 'exact',
  products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }], ...extra
});

test('4. processingNotes đọc order.processingFlags (trùng đơn, giá landing, lên lại POS, đổi quà, gợi ý AI) — đứng trước, không lặp', () => {
  assert.deepEqual(processingNotes(fullOrder()), []);
  const flags = ['⚠ Có thể trùng đơn LP-a1', 'ℹ Giá landing 399.000đ khác bảng giá 447.000đ', '⚠ Đơn đã hủy trên POS — cần lên lại',
    '⚠ Đổi quà: POS chưa có Gói granola nhỏ Cam 30g (GRA-CAM-G30) — nhân viên thêm quà thay thế trên POS', 'ℹ Gợi ý phường/xã (AI, chưa kiểm): Phường Linh Trung, Thành phố Thủ Đức'];
  const flagged = fullOrder({ processingFlags: flags });
  assert.deepEqual(processingNotes(flagged), flags);
  // Đơn thiếu địa chỉ: cờ đứng trước ghi chú dựng từ dữ liệu.
  const partial = fullOrder({ ward: '', processingFlags: [flags[0]] });
  assert.deepEqual(processingNotes(partial), ['⚠ Có thể trùng đơn LP-a1', '⚠ Thiếu phường/xã']);
  // Máy chủ gộp (orderProcessingNotes) + order-notes cùng đọc cờ → không ra hai lần; cờ lặp trong mảng cũng chỉ một dòng.
  assert.deepEqual(orderProcessingNotes(flagged), flags);
  assert.deepEqual(processingNotes(fullOrder({ processingFlags: [flags[0], flags[0], '', null, 7] })), [flags[0]]);
  const order = fullOrder();
  addProcessingFlag(order, flags[1]);
  assert.deepEqual(orderProcessingNotes(order), [flags[1]]);
});

test('4. ghi chú "Gợi ý phường/xã (AI, chưa kiểm)" hiện ℹ không ⚠ — kể cả khi đi trong addressCheck; trùng với cờ thì một dòng', () => {
  const hint = 'Gợi ý phường/xã (AI, chưa kiểm): Phường Linh Trung, Thành phố Thủ Đức';
  // Đơn bot: gợi ý đi theo giỏ → order.addressCheck (nối "; " với lý do soát khác).
  const bot = fullOrder({ ward: '', addressCheck: `Soát phường/xã: bot nhận nguyên chữ khách ghi; ${hint}` });
  assert.deepEqual(processingNotes(bot), ['⚠ Thiếu phường/xã', '⚠ Soát phường/xã: bot nhận nguyên chữ khách ghi', `ℹ ${hint}`]);
  assert.deepEqual(processingNotes(fullOrder({ ward: '', addressCheck: hint })), ['⚠ Thiếu phường/xã', `ℹ ${hint}`]);
  // Đơn landing: máy chủ gắn cờ "ℹ Gợi ý…" — nếu addressCheck cũng mang đúng gợi ý đó thì không lặp.
  assert.deepEqual(processingNotes(fullOrder({ ward: '', addressCheck: hint, processingFlags: [`ℹ ${hint}`] })), [`ℹ ${hint}`, '⚠ Thiếu phường/xã']);
  // Ghi chú soát thường vẫn ⚠ như cũ.
  assert.deepEqual(processingNotes(fullOrder({ addressCheck: 'Ô chọn khác chữ khách gõ' })), ['⚠ Ô chọn khác chữ khách gõ']);
});

test('4. Tổng quan (dashboardTodo) thấy ghi chú mới: đơn có cờ ⚠ vào "đơn cần soát", cờ ℹ thì không', () => {
  const conversation = orders => [{ id: 'c1', psid: 'u1', pageId: 'p1', customerOrders: orders }];
  assert.equal(dashboardTodo({ conversations: conversation([fullOrder()]) }).ordersToReview, 0);
  assert.equal(dashboardTodo({ conversations: conversation([fullOrder({ processingFlags: ['⚠ Có thể trùng đơn LP-a1'] })]) }).ordersToReview, 1);
  assert.equal(dashboardTodo({ landingOrders: [fullOrder({ processingFlags: ['⚠ Đơn đã hủy trên POS — cần lên lại'] })] }).ordersToReview, 1);
  assert.equal(dashboardTodo({ conversations: conversation([fullOrder({ processingFlags: ['ℹ Giá landing 399.000đ khác bảng giá 447.000đ'] })]) }).ordersToReview, 0);
});

const NEW_IDS = ['SHOP_CART_UNKNOWN', 'SHOP_CART_STAFF', 'SHOP_CART_ACK', 'GIFT_SWAP_NOTED', 'GIFT_POLICY_ORDER', 'GIFT_POLICY_ORDER_NONE'];

test('5. sáu mã mẫu mới có trong seed (đúng lời dự phòng của engine / bộ soạn) để chủ shop sửa ở Cài đặt → Tin nhắn', () => {
  const seed = defaultMessageTemplates();
  for (const id of NEW_IDS) assert.ok(String(seed[id] || '').trim(), `seed thiếu ${id}`);
  for (const id of ['SHOP_CART_UNKNOWN', 'SHOP_CART_STAFF', 'SHOP_CART_ACK', 'GIFT_SWAP_NOTED']) assert.equal(seed[id], fallbackTemplates[id], id);
  for (const id of ['GIFT_POLICY_ORDER', 'GIFT_POLICY_ORDER_NONE']) assert.equal(seed[id], orderGiftFallbackTemplates[id], id);
});

test('5. cài đặt đã lưu trên máy chủ (không có 6 mã này) vẫn nhận mặc định từ seed; mẫu chủ shop đã sửa / đã tắt giữ nguyên', () => {
  const seed = defaultMessageTemplates();
  const stored = { WELCOME: 'Dạ shop chào mình ạ', THANK_YOU: '' };
  const merged = normalizeChatbotSettings({ enabled: true, messageTemplates: stored }).messageTemplates;
  for (const id of NEW_IDS) assert.equal(merged[id], seed[id].trim(), id);
  assert.equal(merged.WELCOME, 'Dạ shop chào mình ạ');
  assert.equal(merged.THANK_YOU, '', 'mẫu đã tắt không bật lại');
  // Chủ shop sửa lời mẫu mới rồi lưu: giữ lời đã sửa; để trống = tắt.
  const edited = normalizeChatbotSettings({ enabled: true, messageTemplates: { ...merged, GIFT_SWAP_NOTED: 'Dạ em ghi nhận đổi quà {gift} ạ', SHOP_CART_ACK: '' } }).messageTemplates;
  assert.equal(edited.GIFT_SWAP_NOTED, 'Dạ em ghi nhận đổi quà {gift} ạ');
  assert.equal(edited.SHOP_CART_ACK, '');
});

test('5. mẫu mới KHÔNG thuộc nhóm mô hình tự trả lời (ANSWER); mô hình gọi tên thì bị đổi về GENERAL_INFO', () => {
  for (const id of NEW_IDS) {
    assert.notEqual(groupOf(id), 'ANSWER', id);
    assert.equal(subGroupOf(id), null, id);
  }
  assert.deepEqual(['SHOP_CART_UNKNOWN', 'SHOP_CART_STAFF'].map(groupOf), ['SUPPORT', 'SUPPORT']);
  assert.deepEqual(['SHOP_CART_ACK', 'GIFT_SWAP_NOTED'].map(groupOf), ['ORDER', 'ORDER']);
  for (const id of ['GIFT_POLICY_ORDER', 'GIFT_POLICY_ORDER_NONE']) assert.deepEqual([groupOf(id), isIntentionalOther(id)], ['OTHER', true], id);
  for (const id of NEW_IDS) assert.equal(sanitizeModelAnswer({ template_id: id }, '').template_id, 'GENERAL_INFO', id);
});

test('6. colourText dùng chung normalizeColourTypos: "Túi vâng" là Túi Vàng; "vâng lấy 2 túi xanh" chỉ là 2 Xanh; "Vâng" không là vị nào', () => {
  // Ca thật: bot hỏi vị, khách đáp "Túi vâng" (gõ nhầm dấu của "vàng") — trước đây phần lọc riêng xoá "vâng" nên mất vị.
  const typo = colourCountsInText('Túi vâng');
  assert.equal(typo.mentioned.length, 1, JSON.stringify(typo));
  assert.deepEqual(typo.mentioned, colourCountsInText('Túi vàng').mentioned);
  const agree = colourCountsInText('vâng lấy 2 túi xanh');
  assert.deepEqual(agree.mentioned, colourCountsInText('lấy 2 túi xanh').mentioned);
  assert.deepEqual(agree.counts, colourCountsInText('lấy 2 túi xanh').counts);
  assert.equal(Object.values(agree.counts).reduce((sum, value) => sum + value, 0), 2);
  for (const text of ['Vâng', 'Dạ vâng ạ', 'vâng shop', 'mua về nấu sữa hạt']) assert.deepEqual(colourCountsInText(text).mentioned, [], text);
  // Lỗi gõ khác vẫn đọc như trước ("1 xanh / 1 vangd", "lấy 2 naau", "2 câco").
  assert.equal(colourCountsInText('1 xanh\n1 vangd').mentioned.length, 2);
  assert.deepEqual(colourCountsInText('lấy 2 naau').counts, colourCountsInText('lấy 2 nâu').counts);
  assert.deepEqual(colourCountsInText('2 câco').counts, colourCountsInText('2 cacao').counts);
  assert.doesNotMatch(source('chatbot-templates.mjs').match(/function colourText\(text\) \{[\s\S]*?\n\}/)[0], /replace\(/, 'colourText không còn phần lọc riêng');
});

test('7. bảng ảnh /q/brand/* một nguồn: server dùng brandImageFiles của pancake.mjs, có offer-card.png', () => {
  const server = source('server.mjs');
  const pancake = source('pancake.mjs');
  assert.match(server, /import \{ brandImageFiles, [^}]*\} from '\.\/pancake\.mjs';/);
  assert.match(server, /const qrBrandFiles = brandImageFiles;/);
  assert.equal((server.match(/'\/q\/brand\/[a-z0-9-]+\.(?:webp|png)': '/g) || []).length, 0, 'server.mjs không còn bảng chép');
  const table = pancake.match(/export const brandImageFiles = Object\.freeze\(\{([\s\S]*?)\}\);/)[1];
  const entries = [...table.matchAll(/'(\/q\/brand\/[^']+)': '([^']+)'/g)].map(match => [match[1], match[2]]);
  assert.equal(entries.length, 8);
  assert.deepEqual(entries.find(([route]) => route === '/q/brand/offer-card.png'), ['/q/brand/offer-card.png', 'offers/the-uu-dai.png']);
  // Mọi tệp trong bảng có thật trên đĩa (route công khai không trả 404).
  for (const [, file] of entries) assert.ok(readFileSync(new URL(`../assets/branding/${file}`, import.meta.url)).length > 0, file);
});
