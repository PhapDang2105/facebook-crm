// Vòng 18 — gói D: nhận đúng bài live (bình luận B2, inbox3 V11).
// - Bài "Săn Sale 10/10 cùng Giọt Nắng" (…573757) là bài của quảng cáo Live 120248571622010132 (chiến dịch video trực tiếp) nhưng
//   chữ bài không có "live/săn deal" → 24 luồng bình luận nhận bảng giá thường, đơn 54490fe3 (khách …265359 "1 túi xanh 1 túi nâu
//   bnhieu") mất Quạt. Pancake cho mã bài của quảng cáo (referral.postId) → bài của quảng cáo Live là bài live.
// - Ca …755330 (Nhat Linh) 10-10 21:33: bấm quảng cáo "Săn deal cùng Giọt Nắng ạ" (bài …547261, bài live có chữ "Săn deal") nhưng
//   lượt đầu chưa có tên quảng cáo → "1 vàng, 1 xanh, 1 sô-cô-la" báo quà thiếu Quạt; bài của quảng cáo đã biết là bài live.
// - pancakePostContext giữ loại bài (video trực tiếp) để nhánh post.type 'live' chạy được.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isLivestreamConversation, isLivestreamCustomer, learnLivePosts } from '../app/conversation-orders.mjs';
import { isLivePostId, setLiveAdIdsForTest, setLivePostIdsForTest, applyLiveAdLabels } from '../app/live-ads.mjs';
import { pancakePostContext } from '../app/pancake.mjs';

const LIVE_AD = '120248571622010132';
const SALE_POST = { id: '103549382215599_1464930315573757', message: 'Săn Sale 10/10 cùng Giọt Nắng' };

test('R18 D bình luận B2: bình luận dưới bài của quảng cáo Live ("Săn Sale 10/10 cùng Giọt Nắng") là khách live', () => {
  setLiveAdIdsForTest([LIVE_AD]);
  setLivePostIdsForTest([]);
  const comment = { id: 'p:comment:27160402658265359:103549382215599_1464930315573757', source: 'comment', post: SALE_POST };
  assert.equal(isLivestreamConversation(comment), false, 'chưa biết bài của quảng cáo nào');
  // Hộp thư của một khách khác bấm quảng cáo Live — Pancake ghi mã bài của quảng cáo (dạng ngắn, không tiền tố Page).
  const store = { conversations: [
    { id: 'p:1', referrals: [{ source: 'ADS', adId: LIVE_AD, adTitle: 'Săn Sale 10/10 cùng Giọt Nắng', postId: '1464930315573757' }], referral: { source: 'ADS', adId: LIVE_AD, postId: '1464930315573757' } },
    { id: 'p:2', referral: { source: 'ADS', adId: '120251225500540380', adTitle: 'CHỌN GRANOLA PHÙ HỢP', postId: '103549382215599_1071056795457407' } },
    comment
  ] };
  learnLivePosts(store.conversations);
  assert.equal(isLivePostId('1464930315573757'), true);
  assert.equal(isLivePostId('103549382215599_1071056795457407'), false, 'bài của quảng cáo thường không phải bài live');
  assert.equal(isLivestreamConversation(comment), true);
  assert.equal(isLivestreamCustomer(comment), true);
  assert.equal(isLivestreamConversation({ source: 'comment', post: { id: '103549382215599_1071056795457407', message: 'CHỌN GRANOLA PHÙ HỢP VỚI GU' } }), false);
  setLiveAdIdsForTest([]);
  setLivePostIdsForTest([]);
});

test('R18 D: lượt quét thẻ Livestream (applyLiveAdLabels) cũng ghi bài của quảng cáo Live, kể cả hội thoại đã gắn thẻ', () => {
  setLiveAdIdsForTest([LIVE_AD]);
  setLivePostIdsForTest([]);
  applyLiveAdLabels({ conversations: [{ id: 'p:9', liveAdLabeled: true, referral: { source: 'ADS', adId: LIVE_AD, postId: '103549382215599_1464930315573757' } }] }, { labels: [] });
  assert.equal(isLivePostId('1464930315573757'), true);
  setLiveAdIdsForTest([]);
  setLivePostIdsForTest([]);
});

test('R18 D inbox3 V11 (…755330 "Mình muốn mua 1 túi vàng, 1 túi xanh và 1 túi ganola sô-cô-la"): quảng cáo chưa có tên nhưng bài của quảng cáo là bài live → khách live ngay lượt đầu', () => {
  setLiveAdIdsForTest([]);
  setLivePostIdsForTest([]);
  const inbox = { id: 'p:28552279967755330', source: 'inbox', referral: { source: 'ADS', adId: '120248575554670132', adTitle: '', postId: '1083862934547261' } };
  assert.equal(isLivestreamConversation(inbox), false);
  // Luồng bình luận dưới bài "Săn deal cùng Giọt Nắng ạ" (…547261) đã có trong kho → bài live.
  learnLivePosts([{ id: 'p:comment:x:103549382215599_1083862934547261', source: 'comment', post: { id: '103549382215599_1083862934547261', message: 'Săn deal cùng Giọt Nắng ạ' } }]);
  assert.equal(isLivestreamConversation(inbox), true);
  setLivePostIdsForTest([]);
});

test('R18 D: pancakePostContext giữ loại bài; bài video trực tiếp là bài live', () => {
  const live = pancakePostContext({ id: '1_2', message: 'Granola sáng nay', type: 'livestream', attachments: { data: [{ type: 'video_inline' }] } });
  assert.equal(live.type, 'livestream');
  assert.equal(isLivestreamConversation({ source: 'comment', post: live }), true);
  const liveByAttachment = pancakePostContext({ id: '1_3', message: 'Granola', type: 'video', attachments: { data: [{ type: 'live_video' }] } });
  assert.equal(liveByAttachment.live, true);
  assert.equal(isLivestreamConversation({ source: 'comment', post: liveByAttachment }), true);
  const plain = pancakePostContext({ id: '1_4', message: 'GRANOLA TÚI VÀNG', type: 'photo', attachments: { data: [{ type: 'photo' }] } });
  assert.equal(plain.live, undefined);
  assert.equal(isLivestreamConversation({ source: 'comment', post: plain }), false);
});
