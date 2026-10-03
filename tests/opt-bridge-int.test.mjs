// Phần còn lại của rà soát tích hợp (03/10): phiếu đơn chỉ lùi về ảnh khi Meta từ chối rõ; gửi dở / không rõ đã tới
// không gửi lại; cửa sổ 24 giờ của tin riêng → hộp thư dùng messengerWindowOpen; web: lệnh cầu nối, lý do hụt ID.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const server = read('app/server.mjs');
const engine = read('app/chatbot-engine.mjs');
const metaSync = read('app/meta-sync.mjs');
const web = read('web/app.js');

/** Một hàm cấp đầu tệp (từ `function name(` tới dòng `}` đầu tiên). */
const topFunction = (source, name) => {
  let start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `thiếu hàm ${name}`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
};
const evalFunctions = (source, names, extra = {}) => {
  const context = { ...extra };
  vm.createContext(context);
  vm.runInContext(names.map(name => topFunction(source, name)).join('\n'), context);
  return context;
};

test('server: receiptRefused chỉ đúng khi Meta từ chối rõ; deliveryUncertain bắt hết giờ / 504 / gửi dở', () => {
  const { receiptRefused, deliveryUncertain } = evalFunctions(server, ['receiptRefused', 'deliveryUncertain']);
  assert.equal(receiptRefused({ graphMessage: '(#100) Invalid parameter', statusCode: 400 }), true);
  assert.equal(receiptRefused({ graphMessage: '', statusCode: 400 }), false);
  assert.equal(receiptRefused({ graphMessage: 'x', statusCode: 504, timeout: true }), false);
  assert.equal(receiptRefused({ graphMessage: 'x', statusCode: 500 }), false);
  assert.equal(receiptRefused({ graphMessage: 'x', statusCode: 400, unknownDelivery: true }), false);
  assert.equal(receiptRefused(new Error('mạng')), false);
  for (const error of [{ timeout: true }, { statusCode: 504 }, { partial: true }, { unknownDelivery: true }, { code: 'PANCAKE_SEND_UNCERTAIN' }]) assert.equal(deliveryUncertain(error), true);
  assert.equal(deliveryUncertain({ graphMessage: 'x', statusCode: 400 }), false);
  assert.equal(deliveryUncertain(new Error('Page chưa có token')), false);
});

test('server: phiếu đơn (bot + tạo tay) lùi về ảnh phiếu chỉ khi receiptRefused; không rõ đã tới thì vẫn tạo đơn, không gửi phiếu thứ hai', async () => {
  const receipt = topFunction(server, 'sendChatbotOrderReceipt');
  assert.match(receipt, /if \(!receiptRefused\(error\)\) throw error;\n\s+console\.error\(`Messenger từ chối thẻ receipt/);
  assert.match(receipt, /deliveryUncertain\(error\) \? \{ unknown: true \}/);
  // Chạy thật hàm phiếu đơn tạo tay với gửi giả.
  const calls = [];
  const make = failure => evalFunctions(server, ['receiptRefused', 'deliveryUncertain', 'sendDirectOrderReceipt'], {
    console: { error: () => {}, warn: () => {} },
    metaConfig: { publicBaseUrl: 'https://x' },
    buildOrderReceiptPayload: () => ({ template_type: 'receipt' }),
    sendConversationMessage: async () => { calls.push('card'); throw failure; },
    sendReceiptImage: async () => { calls.push('image'); return { message: { id: 'img-1' } }; }
  });
  const order = {};
  calls.length = 0;
  assert.deepEqual({ ...(await make(Object.assign(new Error('Facebook (Meta) không phản hồi trong 30 giây'), { statusCode: 504, timeout: true, unknownDelivery: true })).sendDirectOrderReceipt({}, order, null)) }, { uncertain: true });
  assert.deepEqual(calls, ['card'], 'hết giờ chờ: không gửi thêm ảnh phiếu');
  assert.equal(order.delivery.status, 'unknown');
  calls.length = 0;
  const refused = {};
  assert.deepEqual({ ...(await make(Object.assign(new Error('từ chối'), { graphMessage: '(#100) bad field', statusCode: 400 })).sendDirectOrderReceipt({}, refused, null)) }, {});
  assert.deepEqual(calls, ['card', 'image'], 'Meta từ chối rõ: ảnh phiếu thay thế');
  assert.equal(refused.delivery.status, 'sent');
  const plain = await make(new Error('Page chưa có token')).sendDirectOrderReceipt({}, {}, null);
  assert.match(plain.error.message, /token/, 'lỗi chắc chắn chưa gửi: route trả 502 "Chưa tạo đơn"');
  const route = server.slice(server.indexOf("if (payload.type === 'order') {"), server.indexOf("if (payload.type === 'order') {") + 4000);
  assert.match(route, /sendDirectOrderReceipt\(conversation, order/);
  assert.match(route, /receiptUncertain\n\s+\? \{ receiptSent: false/);
});

test('meta-sync (R1-02): thẻ không kèm chữ mà Meta hết giờ chờ → lỗi mang unknownDelivery (gắn cờ trước khi xét text)', () => {
  const tag = metaSync.indexOf('if (!isGraphRefusal(error)) throw Object.assign(error, { unknownDelivery: true });');
  const noText = metaSync.indexOf('if (!text) throw error;');
  assert.ok(tag > 0 && noText > tag, 'gắn cờ unknownDelivery trước nhánh "không có chữ"');
});

test('server: tin nhân viên gửi dở (phần đầu đã tới) trả 200 kèm cảnh báo, không báo lỗi để gửi lại cả cụm', () => {
  const send = server.slice(server.indexOf('// Ảnh/tài liệu/ghi âm ≤ 2 MB'), server.indexOf('const conversationReadMatch'));
  assert.match(send, /if \(error\?\.saved\?\.message\) \{ messages\.push\(error\.saved\.message\); last = error\.saved; \}/);
  assert.match(send, /if \(messages\.length\) \{\n\s+return sendJson\(response, 200, \{ \.\.\.\(last \|\| \{\}\), message: messages\[0\], messages, partial: true, warning:/);
  assert.match(send, /if \(deliveryUncertain\(error\)\) return sendJson\(response, 502, \{ error: `Không rõ tin đã tới khách chưa/);
  assert.match(web, /if \(result\.warning\) showComposerStatus\(result\.warning, 8000\);/);
  const resend = server.slice(server.indexOf('const customerOrderResendMatch'), server.indexOf('if (customerOrderDeleteMatch && request.method === \'DELETE\')'));
  assert.match(resend, /if \(deliveryUncertain\(error\)\) return sendJson\(response, 502, \{ error: `Không rõ phiếu đã tới khách chưa/);
});

test('chatbot-engine: tin riêng lỗi → hộp thư dùng messengerWindowOpen; gửi dở / không rõ đã tới coi như đã gửi', async () => {
  const { sendMaybeDelivered } = await import('../app/chatbot-engine.mjs');
  assert.equal(sendMaybeDelivered({ partial: true }), true);
  assert.equal(sendMaybeDelivered({ unknownDelivery: true }), true);
  assert.equal(sendMaybeDelivered({ code: 'PANCAKE_SEND_UNCERTAIN' }), true);
  assert.equal(sendMaybeDelivered(new Error('(#551) not available')), false);
  assert.match(engine, /import \{ messengerWindowOpen \} from '\.\/messenger-window\.mjs';/);
  assert.match(engine, /const windowOpen = Boolean\(inbox\) && messengerWindowOpen\(\{ messages: \{ \[inbox\.id\]: inboxMessages \} \}, inbox\);/);
  assert.doesNotMatch(engine, /const windowOpen = inboxMessages\.some/);
  const viaInbox = engine.slice(engine.indexOf('const viaInbox = await (async () => {'), engine.indexOf('if (viaInbox) {'));
  assert.match(viaInbox, /if \(!sendMaybeDelivered\(error\)\) throw error;/);
  const rest = engine.slice(engine.indexOf('for (const chunk of privateChunks.slice(1)) {'), engine.indexOf('for (const chunk of privateChunks.slice(1)) {') + 600);
  assert.match(rest, /if \(sendMaybeDelivered\(error\)\) \{ console\.warn\(.*\); return true; \}/);
});

test('web: lệnh cầu nối mang dữ liệu Pancake khi cần tìm ID; lý do hụt ID gộp theo chữ (bỏ số)', () => {
  const start = web.indexOf('const bridgeLookupReason = ');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${topFunction(web, 'bridgeItem')}\n${web.slice(start, web.indexOf('\n', start))}\nglobalThis.bridgeLookupReason = bridgeLookupReason;`, context);
  const lookupItem = context.bridgeItem({ key: 'k', pageId: '1', convId: '1_2', needsGlobalId: true, text: 't', name: 'n', pancakeName: 'P', pancakeUpdatedAt: 5, threadId: '', threadKey: 't_1', extra: 'bỏ' });
  assert.equal(lookupItem.pancakeName, 'P');
  assert.equal(lookupItem.threadKey, 't_1');
  assert.equal(lookupItem.key, 'k');
  assert.equal(lookupItem.extra, undefined);
  assert.equal(context.bridgeItem({ key: 'k', pageId: '1', convId: '1_2', globalUserId: '9', text: 't', name: 'n', pancakeName: 'P' }).pancakeName, undefined);
  assert.equal(context.bridgeLookupReason('hụt ID khách 12345 sau 60 giây'), context.bridgeLookupReason('hụt ID khách 999 sau 61 giây'));
  // Lô: hụt ID không tính vào "3 lỗi liền"; dòng trạng thái đang gửi có lỗi gần nhất; trước khi gửi báo số khách cần tìm ID.
  const run = topFunction(web, 'runFollowUpBridge');
  assert.match(run, /else if \(lookupFailed\) \{\n\s+run\.lookupFailed \+= 1;/);
  assert.match(run, /if \(lookupReasons\.get\(reason\) >= 2\) skipLookups = reason;/);
  assert.match(run, /lỗi gần nhất: \$\{shortBridgeError\(run\.lastError\)\}/);
  assert.match(run, /khách cần tìm ID Facebook qua extension Pancake/);
  assert.match(run, /if \(result\.bridgeGone\)/);
});

test('R1-03 vận đơn: gửi lại tin "chưa rõ" đã xác nhận → force: true; giữ chỗ máy chủ = giữ tin trên trình duyệt (1 giờ)', () => {
  const notices = read('web/shipping-notices.js');
  assert.match(notices, /const \{ sent, skippedReasons \} = await sendViaBridge\(\[item\.key\], \{ force: uncertain \}\);/);
  assert.match(notices, /JSON\.stringify\(\{ keys, \.\.\.\(force \? \{ force: true \} : \{\}\) \}\)/);
  assert.match(notices, /const UNCERTAIN_HOLD_MS = 60 \* 60 \* 1000;/);
  assert.match(server, /const shipmentBridgeLeases = createLeaseBook\(60 \* 60 \* 1000\);/);
  assert.match(server, /if \(shipmentBridgeLeases\.take\(item\.key, \{ force: payload\.force === true \}\)\) return true;/);
});
