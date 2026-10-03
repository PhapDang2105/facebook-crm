// Đường nhận ra khách quét thẻ KHÔNG phụ thuộc Meta: link m.me mang tin soạn sẵn kết bằng "#tmdt-01" →
// khách bấm gửi → webhook Pancake → change có referral PREFILL_TEXT → isCardScan → bộ chào gửi QR_OFFER
// (qua Pancake), tin đó không đưa cho bot. Cài đặt chưa đặt tin soạn sẵn thì dùng mẫu mặc định.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PANCAKE_PAGE_ID = '103549382215599';
process.env.PANCAKE_PAGE_NAME = 'Giọt Nắng';
process.env.PANCAKE_PAGE_ACCESS_TOKEN = 't';
process.env.PANCAKE_WEBHOOK_TOKEN = 'w';

const { messengerDestination, prefillMessageFor, prefillTemplateOrDefault, qrCodeFromText } = await import('../app/qr-bridge.mjs');
// Mẫu tin soạn sẵn dự phòng mà chủ shop có thể đặt ở Cài đặt → Mã QR (app không có mẫu mặc định — dữ liệu thử).
const defaultPrefillText = 'Mình vừa quét thẻ cảm ơn {page}, cho mình nhận ưu đãi nhé #{code}';
const { handlePancakeWebhook } = await import('../app/pancake.mjs');
const { readQrSettings } = await import('../app/qr-settings.mjs');
const { createQrGreeter, isCardScan } = await import('../app/qr-greeting.mjs');
const { registerQrCode } = await import('../app/qr-scans.mjs');

await registerQrCode('tmdt-01');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Chủ shop 02/10: không muốn khách phải gửi tin soạn sẵn — Page chủ động chào (Meta gửi referral về CRM
// từ khi công cụ Botcake thôi giữ mã). Mặc định link chỉ mang ref; tin soạn sẵn chỉ có khi Cài đặt đặt.
test('cài đặt chưa đặt tin soạn sẵn → link m.me chỉ mang ref, KHÔNG có text=; mẫu nhân viên đặt thì có text= kết bằng #mã', async () => {
  const settings = await readQrSettings();
  assert.equal(settings.prefillText, '', 'kho cài đặt mới: chưa đặt gì');
  assert.equal(prefillTemplateOrDefault(settings.prefillText), '');
  assert.equal(prefillTemplateOrDefault('   '), '');
  assert.equal(prefillTemplateOrDefault(' Cho mình nhận quà '), 'Cho mình nhận quà');
  const plain = new URL(messengerDestination({ pageId: '103549382215599', code: 'tmdt-01', pageName: 'Giọt Nắng', prefillText: prefillTemplateOrDefault(settings.prefillText) }));
  assert.equal(plain.href, 'https://m.me/103549382215599?ref=tmdt-01');
  assert.equal(plain.searchParams.has('text'), false);
  // Mẫu do nhân viên đặt (hoặc mẫu dự phòng có sẵn) vẫn chạy như cũ.
  const text = prefillMessageFor({ code: 'tmdt-01', pageName: 'Giọt Nắng', template: defaultPrefillText });
  assert.equal(text, 'Mình vừa quét thẻ cảm ơn Giọt Nắng, cho mình nhận ưu đãi nhé #tmdt-01');
  assert.ok(text.length <= 140);
  assert.equal(qrCodeFromText(text), 'tmdt-01', 'CRM đọc ngược được mã từ chính tin soạn sẵn');
  const destination = new URL(messengerDestination({ pageId: '103549382215599', code: 'tmdt-01', pageName: 'Giọt Nắng', prefillText: defaultPrefillText }));
  assert.equal(destination.origin + destination.pathname, 'https://m.me/103549382215599');
  assert.equal(destination.searchParams.get('ref'), 'tmdt-01', 'ref vẫn giữ: Meta có gửi referral thì vẫn nhận');
  assert.equal(destination.searchParams.get('text'), text);
  // Page chưa có tên: mẫu vẫn ra câu đọc được và vẫn mang mã.
  assert.equal(qrCodeFromText(prefillMessageFor({ code: 'tmdt-01', template: defaultPrefillText })), 'tmdt-01');
});

const pancakeWebhook = (text, customerId) => ({
  event_type: 'messaging',
  page_id: '103549382215599',
  data: {
    conversation: { id: `103549382215599_${customerId}`, type: 'INBOX', from: { id: customerId, name: 'Khách Quét' } },
    message: { id: `m_prefill_${customerId}_${text.length}`, message: text, type: 'INBOX', from: { id: customerId, name: 'Khách Quét' }, inserted_at: '2026-10-01T05:00:00.000000' }
  }
});

// Móc như app/server.mjs: bộ chào nhận mọi change, bot chỉ nhận change không phải lượt quét thẻ.
function wiring() {
  const sent = [];
  const logs = [];
  const botGot = [];
  const greeter = createQrGreeter({
    offerMessage: async () => 'Ưu đãi QR',
    send: async (conversation, payload) => { sent.push({ id: conversation.id, pancakeConversationId: conversation.pancakeConversationId, ...payload }); },
    delayMs: 20,
    cooldownMs: 60_000,
    log: line => logs.push(line),
    logError: line => logs.push(`ERR ${line}`)
  });
  const options = {
    processChatbotChanges: async changes => { botGot.push(...changes); },
    chatbotDependencies: {},
    beforeBot: changes => {
      greeter.schedule(changes);
      return changes.filter(change => !isCardScan(change));
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) })
  };
  return { sent, logs, botGot, greeter, options };
}

test('đầu-cuối: khách bấm gửi tin soạn sẵn mặc định → webhook Pancake → PREFILL_TEXT → chào một lần qua hội thoại Pancake, bot không nhận tin đó', async () => {
  const { sent, logs, botGot, options } = wiring();
  const text = prefillMessageFor({ code: 'tmdt-01', pageName: 'Giọt Nắng', template: defaultPrefillText });
  const summary = await handlePancakeWebhook(pancakeWebhook(text, '9001'), options);
  assert.equal(summary.stored, 1);
  assert.equal(botGot.length, 0, 'tin soạn sẵn không đưa cho bot: khách nhận QR_OFFER, không nhận thêm câu chào chung');
  assert.ok(logs.some(line => /QR: khách quét ref="tmdt-01", sẽ chào sau/.test(line)), logs.join('\n'));
  await pause(80);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, '103549382215599:9001');
  assert.equal(sent[0].text, 'Ưu đãi QR');
  assert.ok(sent[0].pancakeConversationId, 'hội thoại mang mã Pancake → sendConversationMessage gửi qua Pancake, không cần Send API của Meta');
  // Khách bấm gửi lần nữa (hoặc đồng bộ Pancake kéo lại tin): trong thời gian chờ không chào lại.
  await handlePancakeWebhook(pancakeWebhook(`${text} `, '9001'), options);
  await pause(80);
  assert.equal(sent.length, 1);
});

test('đầu-cuối: khách sửa lời nhưng giữ "#tmdt-01" ở cuối vẫn được chào; xoá mã hay nhắn thường thì đi bot như mọi tin', async () => {
  const { sent, botGot, options } = wiring();
  await handlePancakeWebhook(pancakeWebhook('Shop ơi cho mình ưu đãi với #TMDT-01', '9002'), options);
  await handlePancakeWebhook(pancakeWebhook('Mình vừa quét thẻ cảm ơn Giọt Nắng, cho mình nhận ưu đãi nhé', '9003'), options);
  await handlePancakeWebhook(pancakeWebhook('Mình hỏi mã #tmdt-99', '9004'), options);
  await pause(80);
  assert.deepEqual(sent.map(item => item.id), ['103549382215599:9002']);
  assert.deepEqual(botGot.map(change => change.conversation.id).sort(), ['103549382215599:9003', '103549382215599:9004']);
});
