import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureConversation,
  markOutgoingStatusUntil,
  publicConversation,
  saveMessage
} from '../app/messaging-store.mjs';

const freshStore = () => ({ conversations: [], messages: {}, commentIndex: {} });
const customer = (id, createdAt, text = 'hỏi') => ({ id, mid: id, direction: 'incoming', type: 'text', text, createdAt, status: 'received' });
const page = (id, createdAt, text = 'trả lời') => ({ id, mid: id, direction: 'outgoing', type: 'text', text, createdAt, status: 'sent' });

test('tin Page dội về (echo) cùng mid nhưng mốc giờ Meta khác: danh sách vẫn đúng thứ tự, preview là tin mới nhất', () => {
  const store = freshStore();
  saveMessage(store, { pageId: '110', psid: '1', message: customer('c1', 1000, 'hỏi giá') });
  // CRM gửi trả lời, ghi createdAt theo giờ máy (sau khi Send API trả về).
  saveMessage(store, { pageId: '110', psid: '1', message: page('m1', 1500, 'dạ 200k') });
  // Khách nhắn tiếp, tới trước khi echo của m1 về.
  saveMessage(store, { pageId: '110', psid: '1', message: customer('c2', 1450, 'ship về HN'), markUnread: true });
  // Echo của m1 mang mốc giờ Meta (sớm hơn giờ máy).
  const echoed = saveMessage(store, { pageId: '110', psid: '1', message: page('m1', 1400, 'dạ 200k') });
  assert.equal(echoed.inserted, false, 'echo gộp vào tin đã ghi');
  const list = store.messages['110:1'];
  assert.deepEqual(list.map(item => item.id), ['c1', 'm1', 'c2'], 'danh sách sắp xếp lại theo mốc giờ mới');
  assert.equal(echoed.conversation.lastMessagePreview, 'ship về HN', 'preview là tin mới nhất');
  assert.equal(echoed.conversation.lastMessageAt, 1450);
  assert.equal(echoed.conversation.lastMessageDirection, 'incoming');
});

test('echo về sau biên nhận đã đọc thì không hạ trạng thái read xuống sent', () => {
  const store = freshStore();
  saveMessage(store, { pageId: '110', psid: '1', message: page('m1', 1500) });
  markOutgoingStatusUntil(store, { conversationId: '110:1', until: 2000, status: 'read' });
  assert.equal(store.messages['110:1'][0].status, 'read');
  saveMessage(store, { pageId: '110', psid: '1', message: page('m1', 1400) });
  assert.equal(store.messages['110:1'][0].status, 'read', 'trạng thái cao hơn được giữ');
});

test('tên giữ chỗ "Khách Facebook xxxx" không ghi đè tên thật đã có', () => {
  const store = freshStore();
  ensureConversation(store, { pageId: '110', psid: '7788990011', name: 'Lan Anh' });
  const conversation = ensureConversation(store, { pageId: '110', psid: '7788990011', name: 'Khách Facebook 0011' });
  assert.equal(conversation.name, 'Lan Anh');
  // Ngược lại: tên thật thay được tên giữ chỗ.
  ensureConversation(store, { pageId: '110', psid: '2' });
  const named = ensureConversation(store, { pageId: '110', psid: '2', name: 'Minh Quân' });
  assert.equal(named.name, 'Minh Quân');
});

test('tin khách cũ hơn cả 500 tin đang giữ thì không được coi là đã chèn và không đánh dấu chưa đọc', () => {
  const store = freshStore();
  for (let index = 0; index < 500; index += 1) {
    saveMessage(store, { pageId: '110', psid: '3', message: customer(`c${index}`, 1000 + index), markUnread: true });
  }
  const conversation = store.conversations[0];
  conversation.unread = false;
  const late = saveMessage(store, { pageId: '110', psid: '3', message: customer('late', 500), markUnread: true });
  assert.equal(store.messages['110:3'].length, 500);
  assert.equal(store.messages['110:3'].some(item => item.id === 'late'), false, 'tin quá cũ bị cắt khỏi cửa sổ');
  assert.equal(late.inserted, false, 'tin không nằm trong kho thì không báo là mới');
  assert.equal(conversation.unread, false, 'không đánh dấu chưa đọc cho tin không ai thấy');
});

test('tin khách tới muộn (sau lời Page) vẫn mở cửa sổ trả lời 24h', () => {
  const store = freshStore();
  saveMessage(store, { pageId: '110', psid: '4', message: page('p1', 5000) });
  const late = saveMessage(store, { pageId: '110', psid: '4', message: customer('c0', 4000), markUnread: true });
  assert.equal(late.conversation.lastCustomerMessageAt, 4000);
  assert.equal(publicConversation(late.conversation).replyWindowEndsAt, 4000 + 24 * 60 * 60 * 1000);
});

test('biên nhận delivery mang mids: tin CRM gửi có createdAt (giờ máy) muộn hơn watermark Meta vẫn được đánh dấu đã giao', async () => {
  const { applyWebhookEvents, normalizeWebhookEvent } = await import('../app/meta-webhook.mjs');
  const store = freshStore();
  // Send API trả về xong CRM mới lấy Date.now(): muộn hơn mốc giờ Meta gán cho tin.
  saveMessage(store, { pageId: '110', psid: '5', message: page('m.sent.1', 1500) });
  const delivery = normalizeWebhookEvent({
    sender: { id: '5' }, recipient: { id: '110' }, timestamp: 1600,
    delivery: { mids: ['m.sent.1'], watermark: 1400 }
  }, '110');
  assert.equal(delivery.type, 'delivery');
  assert.deepEqual(delivery.mids, ['m.sent.1'], 'giữ danh sách mid đã giao');
  const changes = applyWebhookEvents(store, [delivery]);
  assert.equal(store.messages['110:5'][0].status, 'delivered');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'status');
});

// config.mjs đọc env lúc import nên chạy trong tiến trình con với env riêng.
async function loadConfigWith(env) {
  const { execFileSync } = await import('node:child_process');
  const script = "const { pancakeConfig, metaConfig, landingConfig } = await import('../app/config.mjs'); console.log(JSON.stringify({ pages: pancakeConfig.pages.map(p => p.pageId), pageId: pancakeConfig.pageId, webhookPath: metaConfig.webhookPath, webhookUrl: metaConfig.webhookUrl, landingPath: landingConfig.path, landingUrl: landingConfig.webhookUrl, pancakePath: pancakeConfig.path, pancakeUrl: pancakeConfig.webhookUrl }));";
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, PANCAKE_PAGE_ID: '', PANCAKE_PAGE_ACCESS_TOKEN: '', ...env },
    encoding: 'utf8'
  });
  return JSON.parse(output.trim().split('\n').at(-1));
}

test('PANCAKE_PAGES: phần tử null hay pageId trống không làm rớt các Page hợp lệ phía sau', async () => {
  const config = await loadConfigWith({
    PANCAKE_PAGES: JSON.stringify([{ pageId: '123', pageAccessToken: '' }, { pageId: ' ', pageAccessToken: 't' }, null, { pageId: 9, pageAccessToken: ' t9 ' }])
  });
  assert.deepEqual(config.pages, ['9']);
  assert.equal(config.pageId, '9');
});

test('đường dẫn webhook cấu hình thiếu "/" đầu vẫn khớp url.pathname và tạo URL đúng', async () => {
  const config = await loadConfigWith({ PUBLIC_BASE_URL: 'https://crm.example.com/', META_WEBHOOK_PATH: 'webhooks/fb', LANDING_WEBHOOK_PATH: 'webhooks/landing', PANCAKE_WEBHOOK_PATH: 'webhooks/pc' });
  assert.equal(config.webhookPath, '/webhooks/fb');
  assert.equal(config.webhookUrl, 'https://crm.example.com/webhooks/fb');
  assert.equal(config.landingPath, '/webhooks/landing');
  assert.equal(config.landingUrl, 'https://crm.example.com/webhooks/landing');
  assert.equal(config.pancakePath, '/webhooks/pc');
  assert.equal(config.pancakeUrl, 'https://crm.example.com/webhooks/pc');
});
