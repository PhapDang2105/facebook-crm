import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.META_CONVERSATIONS_PATH = path.join(tempDir('opt-int-pancake-'), 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(tempDir('opt-int-pancake-fu-'), 'follow-ups.json');
const { enrichPancakeAdContext, storePancakeEvents } = await import('../app/pancake.mjs');
const { updateMessagingStore, saveMessage, readMessagingStore } = await import('../app/messaging-store.mjs');

const config = { pageId: '110', pageName: 'Test', pageAccessToken: 'pat-1', webhookToken: 'hook-1', apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false };

async function seedAdConversation(psid, adId) {
  return updateMessagingStore(store => {
    const { conversation } = saveMessage(store, { pageId: '110', psid, message: { id: `m-${psid}`, direction: 'incoming', type: 'text', text: 'Chào shop', createdAt: Date.now(), status: 'received' } });
    conversation.referral = { ref: '', source: 'ADS', adId, adTitle: '', postId: '', photoUrl: '' };
    return conversation.id;
  });
}

test('INT-02: Pancake trả tên quảng cáo rỗng → ghi mốc adLookupAt, lượt sau không tra/ghi lại', async () => {
  const id = await seedAdConversation('801', 'ad-empty');
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }; };
  const conversation = (await readMessagingStore()).conversations.find(item => item.id === id);
  assert.equal(await enrichPancakeAdContext([conversation], config, fetchImpl), 1);
  assert.equal(calls, 1);
  const stored = (await readMessagingStore()).conversations.find(item => item.id === id);
  assert.ok(stored.adLookupAt > 0, 'có mốc đã tra');
  assert.equal(stored.referral.adTitle, '');
  // Webhook kế tiếp của cùng khách: không còn "chờ tên" nên không tra, không ghi kho.
  assert.equal(await enrichPancakeAdContext([stored], config, fetchImpl), 0);
  assert.equal(calls, 1);
});

test('INT-02: có tên quảng cáo thì điền adTitle (ghi gộp) như trước', async () => {
  const id = await seedAdConversation('802', 'ad-named');
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [{ id: 'ad-named', name: 'gn ht 2705', campaign_name: 'mess Xanh', image_url: 'https://cdn/x.jpg' }] }) });
  const conversation = (await readMessagingStore()).conversations.find(item => item.id === id);
  assert.equal(await enrichPancakeAdContext([conversation], config, fetchImpl), 1);
  const stored = (await readMessagingStore()).conversations.find(item => item.id === id);
  assert.equal(stored.referral.adTitle, 'gn ht 2705 · mess Xanh');
});

test('INT-06: đồng bộ kéo lại đúng tin đã có thì không đổi gì; tin sửa nội dung (cùng mã) thì có đổi', async () => {
  const event = (text, createdAt = 1_790_000_000_000) => ({
    type: 'message', pageId: '110', psid: '803', timestamp: createdAt,
    message: { id: 'm-803-a', mid: 'm-803-a', direction: 'incoming', type: 'text', text, createdAt, status: 'received' },
    pancake: { conversationId: '110_803', assigned: false, staff: false }
  });
  const first = await storePancakeEvents([event('Cho chị 2 túi')], { deferWrite: true });
  assert.equal(first.filter(change => change.type === 'message').length, 1);
  const before = JSON.stringify(await readMessagingStore());
  const again = await storePancakeEvents([event('Cho chị 2 túi')], { deferWrite: true });
  assert.equal(again.length, 0);
  assert.equal(JSON.stringify(await readMessagingStore()), before, 'kéo lại không đổi kho');
  await storePancakeEvents([event('Cho chị 3 túi')], { deferWrite: true });
  const messages = (await readMessagingStore()).messages['110:803'];
  assert.equal(messages.find(item => item.id === 'm-803-a').text, 'Cho chị 3 túi');
});
