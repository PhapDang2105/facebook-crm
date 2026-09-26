import test from 'node:test';
import assert from 'node:assert/strict';

process.env.META_REFERRAL_ONLY_PAGES = ' 103549382215599 , 42 ';
const { metaConfig, isReferralOnlyPage, subscriptionFieldsFor } = await import('../app/config.mjs');

test('Page vận hành ở Pancake chỉ đăng ký referral và postback; Page thường đủ bộ', () => {
  assert.deepEqual(metaConfig.referralOnlyPageIds, ['103549382215599', '42']);
  assert.equal(isReferralOnlyPage('103549382215599'), true);
  assert.equal(isReferralOnlyPage(42), true, 'so sánh theo chuỗi');
  assert.equal(isReferralOnlyPage('110068281327307'), false);
  assert.equal(subscriptionFieldsFor('103549382215599'), 'messaging_postbacks,messaging_referrals');
  assert.equal(subscriptionFieldsFor('110068281327307'), metaConfig.subscribedFields);
  assert.match(metaConfig.subscribedFields, /messaging_referrals/);
  assert.doesNotMatch(metaConfig.referralOnlyFields, /\bmessages\b/, 'không được nhận tin khách hai lần');
});
