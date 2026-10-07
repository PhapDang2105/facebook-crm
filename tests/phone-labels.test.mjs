import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPhoneLabels, messageHasPhone } from '../app/phone-labels.mjs';
import { defaultConversationLabels, labelsForEvents, mergeDefaultLabels } from '../app/inbox-settings.mjs';

const now = Date.UTC(2026, 9, 2, 3);
const incoming = (text, at = now - 60 * 1000) => ({ direction: 'incoming', text, createdAt: at });

test('chỉ tin khách ghi đúng SĐT mới tính', () => {
  assert.ok(messageHasPhone(incoming('sđt em 0912 345 678 nha')));
  assert.ok(messageHasPhone(incoming('+84912345678')));
  assert.ok(!messageHasPhone({ direction: 'outgoing', text: 'Hotline 0912345678' }));
  assert.ok(!messageHasPhone(incoming('lấy 2 túi, 298k')));
  assert.ok(!messageHasPhone(incoming('mã đơn 123456789012')));
});

test('gắn thẻ Số điện thoại một lần, nhân viên gỡ thì không gắn lại', () => {
  const store = {
    conversations: [
      { id: 'a', name: 'A', labels: ['livestream'] },
      { id: 'b', name: 'B', labels: [] },
      { id: 'c', name: 'C', source: 'comment', labels: [] },
      { id: 'd', name: 'D', labels: [] }
    ],
    messages: {
      a: [incoming('chị ơi'), incoming('0987654321')],
      b: [incoming('còn hàng không')],
      c: [incoming('Inbox e 0912.345.678')],
      d: [incoming('0987654321', now - 40 * 24 * 60 * 60 * 1000)]
    }
  };
  const first = applyPhoneLabels(store, { phoneLabels: ['phone'], now });
  assert.deepEqual(first.changes.map(change => change.conversation.id), ['a']);
  assert.deepEqual(store.conversations[0].labels, ['livestream', 'phone']);
  assert.deepEqual(store.conversations[2].labels, [], 'bình luận không gắn thẻ');
  assert.deepEqual(store.conversations[3].labels, []);
  store.conversations[0].labels = ['livestream'];
  const second = applyPhoneLabels(store, { phoneLabels: ['phone'], now });
  assert.equal(second.changes.length, 0);
  assert.deepEqual(store.conversations[0].labels, ['livestream']);
});

test('chỉ xét hội thoại được chỉ định khi gắn ngay', () => {
  const store = { conversations: [{ id: 'a' }, { id: 'b' }], messages: { a: [incoming('0987654321')], b: [incoming('0987654321')] } };
  const result = applyPhoneLabels(store, { phoneLabels: ['phone'], conversationIds: ['b'], now });
  assert.deepEqual(result.changes.map(change => change.conversation.id), ['b']);
  assert.ok(!store.conversations[0].phoneLabeled);
});

test('bộ thẻ có sẵn được bổ sung thẻ Số điện thoại', () => {
  assert.ok(defaultConversationLabels.some(label => label.id === 'phone' && label.auto === 'phone'));
  const merged = mergeDefaultLabels([{ id: 'customer', name: 'Đã mua hàng', auto: 'order' }]);
  assert.deepEqual(labelsForEvents(merged, ['phone']), ['phone']);
});
