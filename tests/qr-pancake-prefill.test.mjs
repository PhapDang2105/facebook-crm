import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'qr-prefill-'));
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'conv.json');
process.env.QR_SETTINGS_PATH = path.join(directory, 'qr-settings.json');
process.env.PANCAKE_PAGE_ID = '103549382215599';
process.env.PANCAKE_PAGE_NAME = 'Giọt Nắng';
process.env.PANCAKE_PAGE_ACCESS_TOKEN = 't';
process.env.PANCAKE_WEBHOOK_TOKEN = 'w';

const { pancakeRef, qrCodeFromRef, qrCodeFromText, prefillMessageFor, messengerDestination } = await import('../app/qr-bridge.mjs');
const { normalizePancakeWebhook, handlePancakeWebhook } = await import('../app/pancake.mjs');
const { writeQrSettings, readQrSettings } = await import('../app/qr-settings.mjs');

test('ref kiểu Pancake: base64url của pancake_utm_source=<mã>, đọc ngược ra mã; ref thô cũng ra mã', () => {
  assert.equal(pancakeRef('tmdt-01'), 'cGFuY2FrZV91dG1fc291cmNlPXRtZHQtMDE', 'khớp đường dẫn Pancake sinh ra ở Cài đặt → Công cụ');
  assert.equal(qrCodeFromRef('cGFuY2FrZV91dG1fc291cmNlPXRtZHQtMDE'), 'tmdt-01');
  assert.equal(qrCodeFromRef('tmdt-01'), 'tmdt-01');
  assert.equal(qrCodeFromRef('ZXZpbA'), '', 'chuỗi base64 không phải dạng Pancake thì bỏ');
  assert.equal(qrCodeFromRef(''), '');
});

test('mã lô trong tin soạn sẵn: #tmdt-01 ở bất kỳ đâu, không dính chữ sau', () => {
  assert.equal(qrCodeFromText('Mình vừa quét thẻ cảm ơn Giọt Nắng 💛 #tmdt-01'), 'tmdt-01');
  assert.equal(qrCodeFromText('#TMDT-01 xin quà'), 'tmdt-01');
  assert.equal(qrCodeFromText('giá bao nhiêu #1'), '1');
  assert.equal(qrCodeFromText('không có mã'), '');
  assert.equal(qrCodeFromText(''), '');
});

test('tin soạn sẵn điền {page}/{code}, thiếu #mã thì tự nối, cắt 140 ký tự; đích m.me có ref Pancake và text', () => {
  assert.equal(prefillMessageFor({ code: 'tmdt-01', pageName: 'Giọt Nắng' }), 'Mình vừa quét thẻ cảm ơn Giọt Nắng, cho mình nhận hướng dẫn và quà nhé 💛 #tmdt-01');
  assert.equal(prefillMessageFor({ code: 'tmdt-02', pageName: 'Giọt Nắng', template: 'Em ơi cho mình nhận quà' }), 'Em ơi cho mình nhận quà #tmdt-02');
  assert.ok(prefillMessageFor({ code: 'x', template: 'a'.repeat(200) }).length <= 140);
  const destination = messengerDestination({ pageId: '103549382215599', code: 'tmdt-01', pageName: 'Giọt Nắng' });
  assert.match(destination, /^https:\/\/m\.me\/103549382215599\?ref=cGFuY2FrZV91dG1fc291cmNlPXRtZHQtMDE&text=/);
  assert.match(decodeURIComponent(destination.split('&text=')[1]), /#tmdt-01$/);
});

const webhook = (text, { fromPage = false } = {}) => ({
  event_type: 'messaging',
  page_id: '103549382215599',
  data: {
    conversation: { id: '103549382215599_777', type: 'INBOX', from: { id: '777', name: 'Khách Quét' } },
    message: {
      id: `m_${Math.random().toString(36).slice(2)}`,
      message: text,
      type: 'INBOX',
      from: fromPage ? { id: '103549382215599', name: 'Giọt Nắng', admin_name: 'Public API' } : { id: '777', name: 'Khách Quét' },
      inserted_at: '2026-09-26T05:00:00.000000'
    }
  }
});

test('webhook Pancake: tin khách mang #mã thành referral SHORTLINK; tin của Page thì không', () => {
  const [event] = normalizePancakeWebhook(webhook('Mình vừa quét thẻ cảm ơn Giọt Nắng 💛 #tmdt-01'));
  assert.deepEqual(event.referral, { ref: 'tmdt-01', source: 'SHORTLINK', type: 'PREFILL_TEXT' });
  const [plain] = normalizePancakeWebhook(webhook('Cho mình hỏi giá'));
  assert.equal(plain.referral, undefined);
  const [echo] = normalizePancakeWebhook(webhook('Dạ em gửi ưu đãi #tmdt-01', { fromPage: true }));
  assert.equal(echo.referral, undefined, 'Page nhắc lại mã không phải khách quét');
});

test('handlePancakeWebhook: móc beforeBot nhận thay đổi mang referral và quyết định bot bỏ qua tin đó', async () => {
  const seen = [];
  const botGot = [];
  const summary = await handlePancakeWebhook(webhook('Mình vừa quét thẻ cảm ơn Giọt Nắng 💛 #tmdt-01'), {
    processChatbotChanges: async changes => { botGot.push(...changes); },
    chatbotDependencies: {},
    beforeBot: changes => {
      seen.push(...changes);
      return changes.filter(change => change?.referral?.source !== 'SHORTLINK');
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) })
  });
  assert.equal(summary.stored, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].referral?.ref, 'tmdt-01');
  assert.equal(seen[0].conversation?.referral?.ref, 'tmdt-01', 'hội thoại ghi referral để thống kê QR đếm được');
  assert.equal(botGot.length, 0, 'tin soạn sẵn không đưa cho bot: khách đã có QR_OFFER');
});

test('cài đặt QR: tin soạn sẵn lưu riêng, không đụng liên kết Zalo, quá 140 ký tự bị từ chối', async () => {
  await writeQrSettings({ zaloUrl: 'https://zalo.me/g/abc' });
  await writeQrSettings({ prefillText: '  Em ơi   cho mình nhận quà  ' });
  const settings = await readQrSettings();
  assert.equal(settings.zaloUrl, 'https://zalo.me/g/abc');
  assert.equal(settings.prefillText, 'Em ơi cho mình nhận quà');
  await assert.rejects(writeQrSettings({ prefillText: 'x'.repeat(141) }), /140/);
});
