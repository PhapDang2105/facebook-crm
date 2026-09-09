import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseEnvironmentFile } from '../app/config.mjs';
import {
  normalizeWebhookAttachment,
  normalizeWebhookEvent,
  verifyWebhookSignature,
  verifyWebhookSubscription
} from '../app/meta-webhook.mjs';
import { normalizeGraphConversation } from '../app/meta-graph.mjs';
import { markOutgoingStatusUntil, publicConversation, saveMessage } from '../app/messaging-store.mjs';

const appSecret = 'test-app-secret';
const pageId = '100000000000001';
const psid = '7788990011';

const environment = parseEnvironmentFile([
  '# comment line',
  'META_APP_ID=123456',
  'META_APP_SECRET="quoted-secret"',
  "META_VERIFY_TOKEN='single-quoted'",
  'PUBLIC_BASE_URL=https://crm.example.com/',
  'BROKEN_LINE'
].join('\n'));
assert.equal(environment.META_APP_ID, '123456', 'Read a plain value');
assert.equal(environment.META_APP_SECRET, 'quoted-secret', 'Strip double quotes');
assert.equal(environment.META_VERIFY_TOKEN, 'single-quoted', 'Strip single quotes');
assert.equal(environment.BROKEN_LINE, undefined, 'Skip lines without a separator');

const rawBody = Buffer.from(JSON.stringify({ object: 'page' }), 'utf8');
const signature = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
assert.equal(verifyWebhookSignature(rawBody, signature, appSecret), true, 'Accept a correct signature');
assert.equal(verifyWebhookSignature(rawBody, signature, 'other-secret'), false, 'Reject a foreign secret');
assert.equal(verifyWebhookSignature(rawBody, 'sha256=deadbeef', appSecret), false, 'Reject a truncated digest');
assert.equal(verifyWebhookSignature(rawBody, '', appSecret), false, 'Reject a missing header');
assert.equal(verifyWebhookSignature(Buffer.from('{}'), signature, appSecret), false, 'Reject a modified body');

const verifyParams = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token-abc', 'hub.challenge': '99887' });
assert.equal(verifyWebhookSubscription(verifyParams, 'token-abc'), '99887', 'Return the challenge');
assert.equal(verifyWebhookSubscription(verifyParams, 'other-token'), null, 'Reject a wrong verify token');
assert.equal(verifyWebhookSubscription(verifyParams, ''), null, 'Reject an unconfigured verify token');

const incoming = normalizeWebhookEvent({
  sender: { id: psid },
  recipient: { id: pageId },
  timestamp: 1757390000000,
  message: { mid: 'mid.incoming.1', text: 'Shop còn hàng không ạ?' }
}, pageId);
assert.equal(incoming.type, 'message', 'Classify a customer message');
assert.equal(incoming.psid, psid, 'Take the PSID from the sender');
assert.equal(incoming.message.direction, 'incoming', 'Customer messages arrive as incoming');
assert.equal(incoming.message.text, 'Shop còn hàng không ạ?', 'Keep the message text');

const echo = normalizeWebhookEvent({
  sender: { id: pageId },
  recipient: { id: psid },
  timestamp: 1757390100000,
  message: { mid: 'mid.echo.1', is_echo: true, text: 'Dạ shop còn hàng ạ.' }
}, pageId);
assert.equal(echo.psid, psid, 'Take the PSID from the recipient on an echo');
assert.equal(echo.message.direction, 'outgoing', 'Page echoes are outgoing');

const withPhoto = normalizeWebhookEvent({
  sender: { id: psid },
  recipient: { id: pageId },
  timestamp: 1757390200000,
  message: { mid: 'mid.photo.1', attachments: [{ type: 'image', payload: { url: 'https://cdn.example/photo.jpg' } }] }
}, pageId);
assert.equal(withPhoto.message.type, 'image', 'Map an image attachment');
assert.equal(withPhoto.message.dataUrl, 'https://cdn.example/photo.jpg', 'Keep the attachment URL');

assert.equal(normalizeWebhookAttachment({ type: 'file', payload: { url: 'https://cdn.example/a.pdf', name: 'a.pdf' } }).type, 'document', 'Files become documents');
assert.match(normalizeWebhookAttachment({ type: 'location', payload: { coordinates: { lat: 10.7, long: 106.6 } } }).text, /10\.7/, 'Locations become readable text');

const read = normalizeWebhookEvent({
  sender: { id: psid },
  recipient: { id: pageId },
  timestamp: 1757390300000,
  read: { watermark: 1757390250000 }
}, pageId);
assert.equal(read.type, 'read', 'Classify a read receipt');
assert.equal(read.watermark, 1757390250000, 'Keep the read watermark');
assert.equal(normalizeWebhookEvent({ sender: { id: psid }, recipient: { id: pageId } }, pageId), null, 'Ignore unknown event shapes');

const store = { conversations: [], messages: {} };
const first = saveMessage(store, { pageId, psid, message: incoming.message, markUnread: true });
assert.equal(first.inserted, true, 'Store a new message');
assert.equal(first.conversation.unread, true, 'A customer message leaves the thread unread');
assert.equal(store.messages[first.conversation.id].length, 1, 'One message stored');

const duplicate = saveMessage(store, { pageId, psid, message: incoming.message, markUnread: true });
assert.equal(duplicate.inserted, false, 'Reject a repeated message id');
assert.equal(store.messages[first.conversation.id].length, 1, 'Retries do not duplicate the thread');

saveMessage(store, { pageId, psid, message: echo.message });
assert.equal(store.messages[first.conversation.id].length, 2, 'Store the page reply');
assert.equal(first.conversation.lastMessageDirection, 'outgoing', 'Latest message drives the preview');
assert.equal(first.conversation.lastMessagePreview, 'Dạ shop còn hàng ạ.', 'Preview shows the last message');

const changed = markOutgoingStatusUntil(store, { conversationId: first.conversation.id, until: 1757390200000, status: 'read' });
assert.equal(changed, 1, 'Mark outgoing messages as read up to the watermark');
assert.equal(store.messages[first.conversation.id][1].status, 'read', 'Status persisted on the message');
assert.equal(markOutgoingStatusUntil(store, { conversationId: first.conversation.id, until: 1757390200000, status: 'delivered' }), 0, 'Never downgrade read back to delivered');

const publicView = publicConversation(first.conversation);
assert.equal(publicView.channelId, pageId, 'Expose the Page as the channel');
assert.equal(publicView.replyWindowEndsAt, 1757390000000 + 86400000, 'Reply window runs 24h from the customer message');
assert.equal(publicView.canReply, false, 'An old thread is outside the reply window');

const thread = normalizeGraphConversation({
  id: 't_123',
  updated_time: '2026-09-08T10:00:00+0000',
  unread_count: 2,
  participants: { data: [{ id: pageId, name: 'Giọt Nắng' }, { id: psid, name: 'Lan Anh' }] },
  messages: {
    data: [
      { id: 'm_2', message: 'Cảm ơn shop', created_time: '2026-09-08T10:00:00+0000', from: { id: psid, name: 'Lan Anh' } },
      { id: 'm_1', message: 'Chào bạn', created_time: '2026-09-08T09:00:00+0000', from: { id: pageId, name: 'Giọt Nắng' } }
    ]
  }
}, pageId);
assert.equal(thread.psid, psid, 'Pick the customer participant');
assert.equal(thread.name, 'Lan Anh', 'Use the customer name from Graph');
assert.equal(thread.messages[0].id, 'm_1', 'Sort imported messages oldest first');
assert.equal(thread.messages[0].direction, 'outgoing', 'Page messages import as outgoing');
assert.equal(thread.messages[1].direction, 'incoming', 'Customer messages import as incoming');
assert.equal(normalizeGraphConversation({ participants: { data: [{ id: pageId }] } }, pageId), null, 'Skip threads without a customer');

console.log('PASS: 45 Meta messaging assertions');
