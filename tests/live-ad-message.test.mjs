// 13/10 (chủ shop: ảnh "Khách bấm vào quảng cáo: «Săn deal cùng Giọt Nắng ạ»" — "đây là quảng cáo livestream"): dòng hệ
// thống khách bấm quảng cáo ghi rõ quảng cáo Live. isLiveAdMessage: tên có chữ live/săn deal, mã quảng cáo thuộc chiến dịch
// video trực tiếp (tin mới mang adId), tin cũ chưa có mã thì khớp tên với lần bấm quảng cáo Live của hội thoại.
import test from 'node:test';
import assert from 'node:assert/strict';

await import('./helpers/seed-catalog.mjs');
const { isLiveAdMessage } = await import('../app/conversation-orders.mjs');
const { setLiveAdIdsForTest } = await import('../app/live-ads.mjs');

const ad = (text, extra = {}) => ({ type: 'ad', text, ...extra });

test('tên quảng cáo có "săn deal" / "live" → quảng cáo livestream', () => {
  setLiveAdIdsForTest([]);
  assert.equal(isLiveAdMessage(ad('Khách bấm vào quảng cáo: «Săn deal cùng Giọt Nắng ạ»')), true);
  assert.equal(isLiveAdMessage(ad('Khách bấm vào quảng cáo: «Quảng cáo video trực tiếp - LIVE tối nay»')), true);
  assert.equal(isLiveAdMessage(ad('Khách bấm vào quảng cáo: «GRANOLA GIÒN RỐP – ĂN MỘT MUỖNG»')), false);
  assert.equal(isLiveAdMessage({ type: 'text', text: 'Săn deal cùng Giọt Nắng' }), false, 'chỉ tin quảng cáo');
});

test('mã quảng cáo thuộc chiến dịch video trực tiếp (tên không có chữ live) → livestream', () => {
  setLiveAdIdsForTest(['120248396147280132']);
  assert.equal(isLiveAdMessage(ad('Khách bấm vào quảng cáo: «Săn Sale 10/10 cùng Giọt Nắng»', { adId: '120248396147280132' })), true);
  assert.equal(isLiveAdMessage(ad('Khách bấm vào quảng cáo: «Săn Sale 10/10 cùng Giọt Nắng»', { adId: '999' })), false);
});

test('tin cũ chưa có mã: khớp tên với lần bấm quảng cáo Live của hội thoại', () => {
  setLiveAdIdsForTest(['120248396147280132']);
  const conversation = { referral: { adId: '120248396147280132', adTitle: 'Săn Sale 10/10 cùng Giọt Nắng' }, referrals: [{ adId: '1', adTitle: 'Granola túi xanh' }] };
  assert.equal(isLiveAdMessage(ad('Khách bấm vào quảng cáo: «Săn Sale 10/10 cùng Giọt Nắng»'), conversation), true);
  assert.equal(isLiveAdMessage(ad('Khách bấm vào quảng cáo: «Granola túi xanh»'), conversation), false, 'lần bấm quảng cáo thường của cùng khách');
  setLiveAdIdsForTest([]);
});
