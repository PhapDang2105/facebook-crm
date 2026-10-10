// 10/10 (chủ shop): khách nhắn tới từ link ref thì tự gắn thẻ Re-marketing — một lần mỗi hội thoại, không tính quảng
// cáo, quét bù chỉ 30 ngày gần đây; thẻ mặc định có sự kiện 'remarketing' và tự bổ sung vào bộ thẻ đang dùng.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRemarketingLabels, lastRefLinkAt } from '../app/remarketing-labels.mjs';
import { defaultConversationLabels, labelsForEvents, mergeDefaultLabels } from '../app/inbox-settings.mjs';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-10T04:00:00Z');

test('link ref (SHORTLINK, mã QR, MESSENGER_CODE có ref) tính; quảng cáo không tính', () => {
  assert.equal(lastRefLinkAt({ qrReferrals: [{ ref: 'remkt-10', source: 'SHORTLINK', at: now - DAY }] }), now - DAY);
  assert.equal(lastRefLinkAt({ referrals: [{ ref: 'code1', source: 'MESSENGER_CODE', at: now - 2 * DAY }] }), now - 2 * DAY);
  assert.equal(lastRefLinkAt({ referrals: [{ ref: 'x', source: 'ADS', adId: '1', at: now }] }), 0, 'quảng cáo có ref vẫn không tính');
  assert.equal(lastRefLinkAt({ referrals: [{ ref: '', source: 'ADS', adId: '1', at: now }] }), 0);
  assert.equal(lastRefLinkAt({}), 0);
});

test('gắn thẻ một lần mỗi hội thoại; nhân viên gỡ thì không gắn lại; bỏ bình luận và link ref quá 30 ngày', () => {
  const store = {
    conversations: [
      { id: 'a', source: 'inbox', labels: ['phone'], qrReferrals: [{ ref: 'remkt-10', source: 'SHORTLINK', at: now - DAY }] },
      { id: 'b', source: 'inbox', labels: [], referrals: [{ ref: '', source: 'ADS', adId: '9', at: now }] },
      { id: 'c', source: 'comment', labels: [], qrReferrals: [{ ref: 'x', source: 'SHORTLINK', at: now }] },
      { id: 'd', source: 'inbox', labels: [], qrReferrals: [{ ref: 'old', source: 'SHORTLINK', at: now - 40 * DAY }] }
    ]
  };
  const first = applyRemarketingLabels(store, { labels: ['remarketing'], now });
  assert.deepEqual(first.changes.map(change => change.conversation.id), ['a']);
  assert.deepEqual(store.conversations[0].labels, ['phone', 'remarketing']);
  store.conversations[0].labels = ['phone'];
  assert.equal(applyRemarketingLabels(store, { labels: ['remarketing'], now }).changes.length, 0, 'gỡ rồi thì không gắn lại');
  assert.deepEqual(store.conversations.slice(1).map(item => item.labels), [[], [], []]);
  // Chỉ xét các hội thoại vừa có tin.
  const fresh = { conversations: [{ id: 'e', source: 'inbox', labels: [], qrReferrals: [{ ref: 'r', source: 'SHORTLINK', at: now }] }] };
  assert.equal(applyRemarketingLabels(fresh, { labels: ['remarketing'], conversationIds: ['khac'], now }).changes.length, 0);
  assert.equal(applyRemarketingLabels(fresh, { labels: ['remarketing'], conversationIds: ['e'], now }).changes.length, 1);
});

test('thẻ mặc định Re-marketing nhận sự kiện remarketing và được bổ sung vào bộ thẻ shop đang dùng', () => {
  const preset = defaultConversationLabels.find(label => label.id === 'remarketing');
  assert.equal(preset.name, 'Re-marketing');
  assert.equal(preset.auto, 'remarketing');
  const merged = mergeDefaultLabels([{ id: 'consulting', name: 'Cần người xử lý', auto: 'handoff' }]);
  assert.deepEqual(labelsForEvents(merged, ['remarketing']), ['remarketing']);
  assert.equal(mergeDefaultLabels([{ id: 'x', name: 'X' }], ['remarketing']).some(label => label.id === 'remarketing'), false, 'shop đã xoá thẻ thì không thêm lại');
});
