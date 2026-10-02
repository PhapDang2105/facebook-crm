import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The portable Windows runtime when present, otherwise whatever node is running this test.
const nodePath = process.platform === 'win32' ? path.join(projectRoot, 'tools', 'node', 'node.exe') : process.execPath;
// The test writes to a throwaway store so a real inbox is never touched.
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'crm-webhook-test-'));
const storePath = path.join(temporaryDirectory, 'meta-conversations.json');
const port = Number(process.argv[2]) || 8123;
const appSecret = 'integration-app-secret';
const verifyToken = 'integration-verify-token';
const pageId = '100000000000001';
const psid = '55667788';
const baseUrl = `http://127.0.0.1:${port}`;
const checks = [];

function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail });
}

function signPayload(payload) {
  return `sha256=${createHmac('sha256', appSecret).update(Buffer.from(payload, 'utf8')).digest('hex')}`;
}

function postWebhook(payload, signature) {
  return fetch(`${baseUrl}/webhooks/facebook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Hub-Signature-256': signature } : {}) },
    body: payload
  });
}

async function waitForServer(attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return true;
    } catch { /* The server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('CRM server did not start in time.');
}

const server = spawn(nodePath, [path.join(projectRoot, 'app', 'server.mjs'), String(port)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    META_APP_ID: pageId,
    META_APP_SECRET: appSecret,
    META_GRAPH_VERSION: 'v21.0',
    META_VERIFY_TOKEN: verifyToken,
    PUBLIC_BASE_URL: 'https://crm.example.com',
    META_CONVERSATIONS_PATH: storePath,
    // PUBLIC_BASE_URL https bật bắt buộc đăng nhập (fail-closed) → mọi /api trả 503 khi chưa có tài khoản;
    // bài test gọi API không đăng nhập nên tắt hẳn ở đây.
    CRM_REQUIRE_LOGIN: '0',
    // Kho mã QR / kênh cũng về thư mục tạm: gói standby mang referral thẻ QR không được chạm kho thật.
    QR_SCANS_PATH: path.join(temporaryDirectory, 'qr-scans.json'),
    META_CHANNELS_PATH: path.join(temporaryDirectory, 'meta-channels.json'),
    QR_SETTINGS_PATH: path.join(temporaryDirectory, 'qr-settings.json'),
    QR_PAGE_ID: pageId,
    QR_PAGE_NAME: 'Giọt Nắng',
    // Không để server thử chạm POS/Pancake/landing thật hay ghi vào kho thật khi máy có .env thật.
    POS_SYNC_DISABLED: '1',
    POS_API_KEY: '',
    POS_SHOP_ID: '',
    PANCAKE_PAGE_ID: '',
    PANCAKE_PAGES: '',
    PANCAKE_PAGE_ACCESS_TOKEN: '',
    LANDING_WEBHOOK_TOKEN: ''
  },
  stdio: ['ignore', 'ignore', 'inherit']
});

try {
  await waitForServer();

  const verified = await fetch(`${baseUrl}/webhooks/facebook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=CHALLENGE123`);
  check('Webhook verification returns the challenge', verified.status === 200 && (await verified.text()) === 'CHALLENGE123');
  check('Webhook verification rejects a wrong token',
    (await fetch(`${baseUrl}/webhooks/facebook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=X`)).status === 403);

  const payload = JSON.stringify({
    object: 'page',
    entry: [{
      id: pageId,
      time: Date.now(),
      messaging: [{
        sender: { id: psid },
        recipient: { id: pageId },
        timestamp: Date.now(),
        message: { mid: 'mid.integration.1', text: 'Cho mình hỏi giá combo 3 với ạ' }
      }]
    }]
  });
  const signature = signPayload(payload);

  check('Unsigned delivery is rejected', (await postWebhook(payload)).status === 401);
  check('Tampered delivery is rejected', (await postWebhook(payload.replace('combo 3', 'combo 9'), signature)).status === 401);

  const accepted = await postWebhook(payload, signature);
  check('Signed delivery is accepted', accepted.status === 200 && (await accepted.text()) === 'EVENT_RECEIVED');
  await postWebhook(payload, signature);
  await new Promise(resolve => setTimeout(resolve, 600));

  const conversations = await (await fetch(`${baseUrl}/api/messaging/conversations?channelId=${pageId}`)).json();
  const conversation = conversations.items?.[0];
  check('Delivery creates one conversation', conversations.items?.length === 1, JSON.stringify(conversations.items));
  check('New conversation is unread', conversation?.unread === true);
  check('Preview shows the customer message', conversation?.lastMessagePreview === 'Cho mình hỏi giá combo 3 với ạ');

  const messages = await (await fetch(`${baseUrl}/api/messaging/conversations/${encodeURIComponent(conversation.id)}/messages`)).json();
  check('Meta retries do not duplicate a message', messages.items?.length === 1, JSON.stringify(messages.items));
  check('Customer message is stored as incoming', messages.items?.[0]?.direction === 'incoming');

  const flags = await (await fetch(`${baseUrl}/api/messaging/conversations/${encodeURIComponent(conversation.id)}/flags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ muted: true, labels: ['consulting'] })
  })).json();
  check('Conversation flags can be updated', flags.muted === true && flags.labels?.[0] === 'consulting', JSON.stringify(flags));

  // Handover Protocol: app khác là Primary Receiver thì Meta gửi sự kiện trong `standby`. Referral của thẻ QR
  // (m.me?ref) và tin khách vẫn được ghi nhận; hội thoại mở ra cho khách chỉ có referral.
  const standbyPsid = '99887766';
  const standbyPayload = JSON.stringify({
    object: 'page',
    entry: [{
      id: pageId,
      time: Date.now(),
      standby: [
        { sender: { id: standbyPsid }, recipient: { id: pageId }, timestamp: Date.now(), referral: { ref: 'tmdt-01', source: 'SHORTLINK', type: 'OPEN_THREAD' } },
        { sender: { id: standbyPsid }, recipient: { id: pageId }, timestamp: Date.now() + 1, postback: { mid: 'mid.integration.standby.1', title: 'Bắt đầu', referral: { ref: 'tmdt-01', source: 'SHORTLINK', type: 'OPEN_THREAD' } } }
      ]
    }]
  });
  const standbyAccepted = await postWebhook(standbyPayload, signPayload(standbyPayload));
  check('Standby delivery is accepted', standbyAccepted.status === 200);
  await new Promise(resolve => setTimeout(resolve, 600));
  const afterStandby = await (await fetch(`${baseUrl}/api/messaging/conversations?channelId=${pageId}`)).json();
  const standbyConversation = afterStandby.items?.find(item => item.id === `${pageId}:${standbyPsid}`);
  check('Standby events are stored (referral + Get Started postback)', Boolean(standbyConversation) && standbyConversation.lastMessagePreview === 'Bắt đầu', JSON.stringify(afterStandby.items?.map(item => [item.id, item.lastMessagePreview])));

  // Trang đệm /q/<mã>: Android Chrome vẫn 302 thẳng sang m.me?ref; iPhone trong Zalo nhận trang có hướng dẫn
  // mở bằng Safari (x-safari-https trỏ về chính trang này kèm from=inapp, không đếm thêm lượt quét).
  const androidChrome = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36';
  const zaloIos = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo iOS/640 ZaloTheme/light ZaloLanguage/vn';
  const iosSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1';
  const redirected = await fetch(`${baseUrl}/q/tmdt-01`, { headers: { 'User-Agent': androidChrome }, redirect: 'manual' });
  // Cài đặt chưa đặt tin soạn sẵn: link chỉ mang ref (chủ shop 02/10: Page chủ động chào, khách không phải gửi tin soạn sẵn).
  const location = redirected.status === 302 ? new URL(redirected.headers.get('location')) : null;
  check('QR bridge: Android Chrome is still redirected to m.me?ref', location?.origin === 'https://m.me' && location.pathname === `/${pageId}` && location.searchParams.get('ref') === 'tmdt-01', `${redirected.status} ${redirected.headers.get('location')}`);
  check('QR bridge: the m.me link carries no prefilled text by default', location?.searchParams.has('text') === false, location?.searchParams.get('text'));
  const inApp = await fetch(`${baseUrl}/q/tmdt-01`, { headers: { 'User-Agent': zaloIos }, redirect: 'manual' });
  const inAppHtml = await inApp.text();
  check('QR bridge: iOS inside Zalo gets the open-in-Safari guide', inApp.status === 200
    && inAppHtml.includes('class="hint hint-ios"')
    && inAppHtml.includes('href="x-safari-https://crm.example.com/q/tmdt-01?from=inapp"')
    && inAppHtml.includes('data-link="https://crm.example.com/q/tmdt-01?from=inapp"')
    && inAppHtml.includes(`href="https://m.me/${pageId}?ref=tmdt-01"`));
  const reopened = await fetch(`${baseUrl}/q/tmdt-01?from=inapp`, { headers: { 'User-Agent': iosSafari }, redirect: 'manual' });
  const reopenedHtml = await reopened.text();
  check('QR bridge: reopened in Safari shows the plain page', reopened.status === 200 && !reopenedHtml.includes('hint-ios') && reopenedHtml.includes(`href="https://m.me/${pageId}?ref=tmdt-01"`));
  const escapeBeacon = await fetch(`${baseUrl}/q/tmdt-01/open?to=safari`, { method: 'POST', headers: { 'User-Agent': zaloIos } });
  check('QR bridge: open-in-Safari beacon is acknowledged', escapeBeacon.status === 204, String(escapeBeacon.status));

  const channels = await (await fetch(`${baseUrl}/api/channels`)).json();
  check('Webhook reports as configured', channels.webhookConfigured === true, JSON.stringify(channels.missingWebhookConfiguration));
  check('Callback URL follows PUBLIC_BASE_URL', channels.webhookUrl === 'https://crm.example.com/webhooks/facebook', channels.webhookUrl);
} finally {
  server.kill();
  await rm(temporaryDirectory, { recursive: true, force: true });
}

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok || !item.detail ? '' : ` -> ${item.detail}`}`);
const failed = checks.filter(item => !item.ok).length;
console.log(failed ? `\n${failed} of ${checks.length} webhook checks failed.` : `\nPASS: ${checks.length} webhook integration checks`);
process.exit(failed ? 1 : 0);
