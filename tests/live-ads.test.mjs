// 10/10: khách bấm quảng cáo "Săn Sale 10/10 cùng Giọt Nắng" (thuộc "Chiến dịch video trực tiếp - 09:54 10/10/26") không
// được tính là khách Live → mất quà Live. Mã quảng cáo thuộc chiến dịch / nhóm / quảng cáo video trực tiếp → khách Live.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isLiveAdId, isLiveAdName, liveAdIdsFrom, setLiveAdIdsForTest } from '../app/live-ads.mjs';
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
