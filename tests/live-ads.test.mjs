// 10/10: khách bấm quảng cáo "Săn Sale 10/10 cùng Giọt Nắng" (thuộc "Chiến dịch video trực tiếp - 09:54 10/10/26") không
// được tính là khách Live → mất quà Live. Mã quảng cáo thuộc chiến dịch / nhóm / quảng cáo video trực tiếp → khách Live.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLiveAdLabels, isLiveAdId, isLiveAdName, liveAdIdsFrom, setLiveAdIdsForTest } from '../app/live-ads.mjs';
import { isLivestreamConversation, isLivestreamCustomer } from '../app/conversation-orders.mjs';

test('tên chiến dịch / nhóm / quảng cáo video trực tiếp là Live; quảng cáo thường thì không', () => {
  assert.equal(isLiveAdName('Chiến dịch video trực tiếp - 09:54 10/10/26'), true);
  assert.equal(isLiveAdName('', 'Nhóm quảng cáo video trực tiếp - Săn Deal Hời'), true);
  assert.equal(isLiveAdName('Livestream tối thứ 7'), true);
  assert.equal(isLiveAdName('Granola xanh', 'mess Xanh', 'gn ht 2705'), false);
  assert.equal(isLiveAdName('Delivery test'), false, '"live" phải đứng riêng một từ');
  const ids = liveAdIdsFrom({ ads: {
    a1: { campaignName: 'Chiến dịch video trực tiếp - 09:54 10/10/26', adName: 'Quảng cáo video trực tiếp - 09:54 10/10/26' },
    a2: { campaignName: 'Granola xanh', adName: 'Xanh | scale - 1' }
  } });
  assert.deepEqual([...ids], ['a1']);
});

test('hội thoại từ quảng cáo Live (tên hiển thị không có chữ live) là khách Live', () => {
  setLiveAdIdsForTest(['120248571622010132']);
  const conversation = { referral: { source: 'ADS', adId: '120248571622010132', adTitle: 'Săn Sale 10/10 cùng Giọt Nắng' } };
  assert.equal(isLiveAdId('120248571622010132'), true);
  assert.equal(isLivestreamConversation(conversation), true);
  assert.equal(isLivestreamCustomer(conversation), true);
  assert.equal(isLivestreamConversation({ referral: { source: 'ADS', adId: 'khac', adTitle: 'Săn Sale 10/10 cùng Giọt Nắng' } }), false);
  setLiveAdIdsForTest([]);
});

test('thẻ Livestream: hội thoại vào từ quảng cáo Live được gắn một lần, kể cả khi bot tắt; khách cũ / quảng cáo thường thì không', () => {
  const now = Date.parse('2026-10-10T08:00:00Z');
  setLiveAdIdsForTest(['120248571622010132']);
  const live = (id, extra = {}) => ({ id, name: id, labels: [], lastCustomerMessageAt: now - 60_000, referral: { source: 'ADS', adId: '120248571622010132', adTitle: 'Săn Sale 10/10 cùng Giọt Nắng' }, ...extra });
  const store = { conversations: [
    live('bot-tat', { botEnabled: false, labels: ['consulting'] }),
    live('da-co-the', { labels: ['livestream'] }),
    live('khach-cu', { lastCustomerMessageAt: now - 5 * 24 * 60 * 60 * 1000 }),
    live('qc-thuong', { referral: { source: 'ADS', adId: 'khac', adTitle: 'Granola xanh' } }),
    live('nv-da-go', { liveAdLabeled: true })
  ] };
  const result = applyLiveAdLabels(store, { labels: ['livestream'], now });
  assert.deepEqual(result.changes.map(change => change.conversation.id), ['bot-tat']);
  assert.deepEqual(store.conversations[0].labels, ['consulting', 'livestream']);
  assert.equal(result.flagged, 2, 'hội thoại đã có thẻ chỉ đánh dấu, không ghi thay đổi');
  assert.equal(store.conversations[2].labels.length + store.conversations[3].labels.length + store.conversations[4].labels.length, 0);
  // Nhân viên gỡ thẻ: lượt sau không gắn lại.
  store.conversations[0].labels = ['consulting'];
  assert.equal(applyLiveAdLabels(store, { labels: ['livestream'], now }).changes.length, 0);
  // Chỉ các hội thoại vừa có tin.
  const fresh = { conversations: [live('a'), live('b')] };
  assert.deepEqual(applyLiveAdLabels(fresh, { labels: ['livestream'], conversationIds: ['b'], now }).changes.map(change => change.conversation.id), ['b']);
  setLiveAdIdsForTest([]);
});
