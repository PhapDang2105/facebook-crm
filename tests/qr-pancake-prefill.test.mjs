import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'qr-prefill-'));
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'conv.json');
process.env.QR_SETTINGS_PATH = path.join(directory, 'qr-settings.json');
process.env.QR_SCANS_PATH = path.join(directory, 'qr-scans.json');
process.env.PANCAKE_PAGE_ID = '103549382215599';
process.env.PANCAKE_PAGE_NAME = 'Giọt Nắng';
process.env.PANCAKE_PAGE_ACCESS_TOKEN = 't';
process.env.PANCAKE_WEBHOOK_TOKEN = 'w';

const { pancakeRef, qrCodeFromRef, qrCodeFromText, prefillMessageFor, messengerDestination, samplePrefillText } = await import('../app/qr-bridge.mjs');
const { normalizePancakeWebhook, handlePancakeWebhook } = await import('../app/pancake.mjs');
const { writeQrSettings, readQrSettings } = await import('../app/qr-settings.mjs');
const { registerQrCode, isKnownQrCode } = await import('../app/qr-scans.mjs');

// Mã lô "đã in": nhân viên tạo ở Cài đặt → Mã QR.
await registerQrCode('tmdt-01');

test('ref kiểu Pancake: base64url của pancake_utm_source=<mã>, đọc ngược ra mã; ref thô cũng ra mã', () => {
  assert.equal(pancakeRef('tmdt-01'), 'cGFuY2FrZV91dG1fc291cmNlPXRtZHQtMDE', 'khớp đường dẫn Pancake sinh ra ở Cài đặt → Công cụ');
  assert.equal(qrCodeFromRef('cGFuY2FrZV91dG1fc291cmNlPXRtZHQtMDE'), 'tmdt-01');
  assert.equal(qrCodeFromRef('tmdt-01'), 'tmdt-01');
  assert.equal(qrCodeFromRef('ZXZpbA'), '', 'chuỗi base64 không phải dạng Pancake thì bỏ');
  assert.equal(qrCodeFromRef(''), '');
});

test('mã lô trong tin khách: chỉ nhận #mã ở CUỐI tin; "#" giữa câu (số đơn, giá, hashtag) không phải mã thẻ', () => {
  assert.equal(qrCodeFromText('Mình vừa quét thẻ cảm ơn Giọt Nắng 💛 #tmdt-01'), 'tmdt-01');
  assert.equal(qrCodeFromText('Cho mình nhận quà #TMDT-01'), 'tmdt-01', 'không phân biệt hoa thường');
  assert.equal(qrCodeFromText('#tmdt-01'), 'tmdt-01', 'tin chỉ có mã');
  assert.equal(qrCodeFromText('  #tmdt-01  \n'), 'tmdt-01', 'khoảng trắng và xuống dòng cuối tin');
  assert.equal(qrCodeFromText('#TMDT-01 xin quà'), '', 'mã ở đầu, chữ theo sau: không phải tin soạn sẵn');
  assert.equal(qrCodeFromText('combo #2 giá bao nhiêu'), '');
  assert.equal(qrCodeFromText('giá bao nhiêu #1'), '1', 'đúng dạng cuối tin thì vẫn ra chuỗi — chốt "mã đã tạo" nằm ở kho QR (isKnownQrCode)');
  assert.equal(qrCodeFromText('đơn #123456 của em đâu'), '');
  assert.equal(qrCodeFromText('#giảm'), '', 'chữ có dấu không phải mã');
  assert.equal(qrCodeFromText('email a#b'), '', 'phải có khoảng trắng hoặc đầu tin trước #');
  assert.equal(qrCodeFromText('không có mã'), '');
  assert.equal(qrCodeFromText(''), '');
});

test('mã lô trong tin Page (Botcake): chỉ nhận đúng "Mã thẻ: #mã" ở cuối; tin nhân viên gõ "#..." không phải', () => {
  assert.equal(qrCodeFromText('Dạ Giọt Nắng cảm ơn anh/chị… \nMã thẻ: #tmdt-01', { outgoing: true }), 'tmdt-01');
  assert.equal(qrCodeFromText('Mã thẻ:#TMDT-01', { outgoing: true }), 'tmdt-01');
  assert.equal(qrCodeFromText('Mã đơn #4521 đã gửi', { outgoing: true }), '');
  assert.equal(qrCodeFromText('Dạ em gửi #tmdt-01', { outgoing: true }), '', 'tin Page thiếu "Mã thẻ:" thì không nhận, dù mã ở cuối');
  assert.equal(qrCodeFromText('Mã thẻ: #tmdt-01 nha ạ', { outgoing: true }), '', 'phải ở cuối tin');
});

test('tin soạn sẵn: mẫu rỗng → không có; điền {page}/{code}, thiếu #mã thì tự nối, cắt 140 ký tự', () => {
  assert.equal(prefillMessageFor({ code: 'tmdt-01', pageName: 'Giọt Nắng' }), '', 'mặc định không có tin soạn sẵn: Botcake tự chào theo ref');
  assert.equal(prefillMessageFor({ code: 'tmdt-01', pageName: 'Giọt Nắng', template: samplePrefillText }), 'Mình vừa quét thẻ cảm ơn Giọt Nắng, cho mình nhận hướng dẫn và quà nhé 💛 #tmdt-01');
  assert.equal(prefillMessageFor({ code: 'tmdt-02', pageName: 'Giọt Nắng', template: 'Em ơi cho mình nhận quà' }), 'Em ơi cho mình nhận quà #tmdt-02');
  assert.ok(prefillMessageFor({ code: 'x', template: 'a'.repeat(200) }).length <= 140);
});

test('đích m.me: ref = chính mã lô (Botcake Custom Ref Parameter); text chỉ khi có tin soạn sẵn', () => {
  assert.equal(messengerDestination({ pageId: '103549382215599', code: 'tmdt-01', pageName: 'Giọt Nắng' }), 'https://m.me/103549382215599?ref=tmdt-01');
  const withText = messengerDestination({ pageId: '103549382215599', code: 'tmdt-01', pageName: 'Giọt Nắng', prefillText: 'Cho mình nhận quà' });
  assert.match(withText, /^https:\/\/m\.me\/103549382215599\?ref=tmdt-01&text=/);
  assert.match(decodeURIComponent(withText.split('&text=')[1]), /#tmdt-01$/);
});

const webhook = (text, { fromPage = false, customerId = '777' } = {}) => ({
  event_type: 'messaging',
  page_id: '103549382215599',
  data: {
    conversation: { id: `103549382215599_${customerId}`, type: 'INBOX', from: { id: customerId, name: 'Khách Quét' } },
    message: {
      id: `m_${Math.random().toString(36).slice(2)}`,
      message: text,
      type: 'INBOX',
      from: fromPage ? { id: '103549382215599', name: 'Giọt Nắng', admin_name: 'Public API' } : { id: customerId, name: 'Khách Quét' },
      inserted_at: '2026-09-26T05:00:00.000000'
    }
  }
});

test('webhook Pancake: tin khách kết bằng #mã đã tạo → PREFILL_TEXT; tin Page "Mã thẻ: #mã" → BOTCAKE_OPTIN; mã lạ hay "#" giữa câu → không', () => {
  assert.equal(isKnownQrCode('tmdt-01'), true);
  assert.equal(isKnownQrCode('tmdt-99'), false);
  const [event] = normalizePancakeWebhook(webhook('Mình vừa quét thẻ cảm ơn Giọt Nắng 💛 #tmdt-01'));
  assert.deepEqual(event.referral, { ref: 'tmdt-01', source: 'SHORTLINK', type: 'PREFILL_TEXT' });
  const [plain] = normalizePancakeWebhook(webhook('Cho mình hỏi giá'));
  assert.equal(plain.referral, undefined);
  const [orderNumber] = normalizePancakeWebhook(webhook('đơn của em là #123456'));
  assert.equal(orderNumber.referral, undefined, 'số đơn ở cuối tin nhưng không phải mã đã tạo');
  const [unknown] = normalizePancakeWebhook(webhook('Cho mình nhận quà #tmdt-99'));
  assert.equal(unknown.referral, undefined, 'mã chưa tạo ở Cài đặt → Mã QR thì không phải thẻ thật');
  const [botcake] = normalizePancakeWebhook(webhook('Dạ Giọt Nắng cảm ơn anh/chị… \nMã thẻ: #tmdt-01', { fromPage: true }));
  assert.deepEqual(botcake.referral, { ref: 'tmdt-01', source: 'SHORTLINK', type: 'BOTCAKE_OPTIN' });
  assert.equal(botcake.message.direction, 'outgoing');
  const [staff] = normalizePancakeWebhook(webhook('Mã đơn #4521 đã gửi', { fromPage: true }));
  assert.equal(staff.referral, undefined);
});

test('handlePancakeWebhook: móc beforeBot nhận thay đổi mang referral; referral QR vào qrReferrals riêng, không đè referral quảng cáo', async () => {
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
  const conversation = seen[0].conversation;
  assert.equal(conversation?.qrReferrals?.[0]?.ref, 'tmdt-01', 'hội thoại ghi referral QR để thống kê đếm được');
  assert.ok(Number(conversation?.qrReferrals?.[0]?.at) > 0, 'có mốc thời gian để khử trùng theo ngày');
  assert.equal(conversation?.referral, undefined, 'referral QR không chiếm ô referral (bối cảnh quảng cáo của bot)');
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
