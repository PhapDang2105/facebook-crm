import test from 'node:test';
import assert from 'node:assert/strict';
import { saveMessage } from '../app/messaging-store.mjs';

const freshStore = () => ({ conversations: [], messages: {}, commentIndex: {} });
const customer = (id, createdAt, text = 'hỏi') => ({ id, mid: id, direction: 'incoming', type: 'text', text, createdAt, status: 'received' });
const page = (id, createdAt, text = 'trả lời') => ({ id, mid: id, direction: 'outgoing', type: 'text', text, createdAt, status: 'sent' });

test('khách nhắn thì chưa đọc; Page trả lời sau đó (bot hay nhân viên, kể cả tin dội về qua webhook) thì hết chưa đọc', () => {
  const store = freshStore();
  const first = saveMessage(store, { pageId: '110', psid: '1', message: customer('c1', 1000), markUnread: true });
  assert.equal(first.conversation.unread, true);
  const replied = saveMessage(store, { pageId: '110', psid: '1', message: page('p1', 2000) });
  assert.equal(replied.conversation.unread, false, 'Page nhắn sau cùng thì không còn gì chờ đọc');
  const again = saveMessage(store, { pageId: '110', psid: '1', message: customer('c2', 3000), markUnread: true });
  assert.equal(again.conversation.unread, true, 'khách nhắn tiếp thì lại chưa đọc');
});

test('tin khách kéo về muộn (đồng bộ lịch sử) mà Page đã trả lời rồi thì không đánh dấu chưa đọc', () => {
  const store = freshStore();
  saveMessage(store, { pageId: '110', psid: '2', message: page('p1', 5000) });
  const late = saveMessage(store, { pageId: '110', psid: '2', message: customer('c0', 4000), markUnread: true });
  assert.equal(late.conversation.unread, false, 'tin khách cũ hơn lời Page: đã được trả lời');
  // Tin Page dội về sau tin khách mới hơn thì không xoá dấu chưa đọc của tin đó.
  saveMessage(store, { pageId: '110', psid: '2', message: customer('c9', 9000), markUnread: true });
  const echoed = saveMessage(store, { pageId: '110', psid: '2', message: page('p2', 6000) });
  assert.equal(echoed.conversation.unread, true, 'khách vẫn là người nhắn sau cùng');
});
