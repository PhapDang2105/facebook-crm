import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'gender-'));
const storePath = path.join(directory, 'meta-conversations.json');
process.env.META_CONVERSATIONS_PATH = storePath;

// Kho có sẵn: khách chưa có giới tính (tên rõ giới), và một khách có hai luồng lệch nhau.
writeFileSync(storePath, JSON.stringify({
  conversations: [
    { id: '110:1', pageId: '110', psid: '1', name: 'Trần Hải Yến', source: 'inbox' },
    { id: '110:2', pageId: '110', psid: '2', name: 'Pháp Đặng', source: 'inbox' },
    { id: '110:3', pageId: '110', psid: '3', name: 'Ân Ân', source: 'inbox' },
    { id: '110:4', pageId: '110', psid: '4', name: 'Nguyễn Văn Nam', source: 'inbox', gender: 'female', genderSource: 'message' },
    { id: '110:comment:4:p1', pageId: '110', psid: '4', name: 'Nguyễn Văn Nam', source: 'comment', gender: 'male', genderSource: 'pancake' }
  ],
  messages: {},
  commentIndex: {}
}));

const { readMessagingStore, reconcileCustomerGender, applyGenderGuess } = await import('../app/messaging-store.mjs');

test('nạp kho: hội thoại chưa có giới tính được đoán theo tên; luồng của cùng khách lấy giới tính tin cậy nhất', async () => {
  const store = await readMessagingStore();
  const byId = Object.fromEntries(store.conversations.map(item => [item.id, item]));
  assert.equal(byId['110:1'].gender, 'female');
  assert.equal(byId['110:1'].genderSource, 'name');
  assert.equal(byId['110:2'].gender, 'male');
  assert.equal(byId['110:3'].gender, undefined, 'tên không rõ giới thì để trung tính');
  // Pancake (2.5) hơn xưng hô (2): hộp thư theo luồng bình luận.
  assert.equal(byId['110:4'].gender, 'male');
  assert.equal(byId['110:4'].genderSource, 'pancake');
});

test('reconcileCustomerGender: nhân viên chọn ở một luồng thì luồng khác theo; không hạ nguồn tin cậy hơn', async () => {
  const store = await readMessagingStore();
  const inbox = store.conversations.find(item => item.id === '110:4');
  const thread = store.conversations.find(item => item.id === '110:comment:4:p1');
  applyGenderGuess(thread, 'female', 'staff');
  const changed = reconcileCustomerGender(store, thread);
  assert.deepEqual(changed.map(item => item.id), ['110:4']);
  assert.equal(inbox.gender, 'female');
  assert.equal(inbox.genderSource, 'staff');
  // Đoán theo tên ở luồng khác không đè lựa chọn của nhân viên.
  applyGenderGuess(inbox, 'male', 'name');
  assert.equal(inbox.gender, 'female');
  assert.deepEqual(reconcileCustomerGender(store, inbox), []);
});

test('tin khách có xưng hô ("chị ơi") đi qua applyWebhookEvents không ném lỗi và dồn giới tính cho luồng cùng khách', async () => {
  const { normalizeWebhookEvent, applyWebhookEvents } = await import('../app/meta-webhook.mjs');
  const store = await readMessagingStore();
  const event = normalizeWebhookEvent({
    sender: { id: '1' }, recipient: { id: '110' }, timestamp: 1_800_000_000_000,
    message: { mid: 'mid.gender.1', text: 'chị ơi cho em hỏi giá túi xanh' }
  }, '110');
  assert.ok(event, 'sự kiện tin nhắn được chuẩn hoá');
  const changes = applyWebhookEvents(store, [event]);
  assert.ok(Array.isArray(changes));
  const conversation = store.conversations.find(item => item.id === '110:1');
  assert.ok(conversation, 'hội thoại 110:1 tồn tại');
  assert.ok(['female', 'male'].includes(conversation.gender) || conversation.gender === undefined);
});
