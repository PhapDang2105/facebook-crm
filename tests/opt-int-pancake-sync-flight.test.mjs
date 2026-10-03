import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

// INT-11: đồng bộ Pancake chạy một lượt một lúc; cùng yêu cầu thì dùng chung, yêu cầu khác thì chờ rồi chạy đúng yêu cầu.
process.env.META_CONVERSATIONS_PATH = path.join(tempDir('opt-int-sync-'), 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(tempDir('opt-int-sync-fu-'), 'follow-ups.json');
const { syncPancakeConversations } = await import('../app/pancake.mjs');

const config = { pageId: '140', pageName: 'Test', pageAccessToken: 'pat-1', webhookToken: 'hook-1', apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false };

test('lượt nền đang chạy: lời gọi cùng tuỳ chọn dùng chung; tuỳ chọn khác chờ xong rồi chạy lượt của mình', async () => {
  const listCalls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async url => {
    const address = new URL(String(url));
    if (address.pathname.endsWith('/conversations')) {
      listCalls.push(address.searchParams.get('type'));
      if (listCalls.length === 1) await gate;
    }
    return { ok: true, status: 200, json: async () => ({ success: true, conversations: [] }) };
  };
  const background = syncPancakeConversations({ limit: 5, commentLimit: 0 }, config, fetchImpl);
  const same = syncPancakeConversations({ limit: 5, commentLimit: 0, processChatbotChanges: async () => {} }, config, fetchImpl);
  const manual = syncPancakeConversations({ limit: 7, commentLimit: 0, messagePages: 2 }, config, fetchImpl);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(listCalls.length, 1, 'lượt tay chưa chạy chồng khi lượt nền còn chạy');
  release();
  const [first, second, third] = await Promise.all([background, same, manual]);
  assert.equal(first, second, 'cùng yêu cầu dùng chung kết quả');
  assert.notEqual(third, first, 'yêu cầu khác có kết quả riêng');
  assert.equal(listCalls.length, 2, 'lượt tay đã chạy sau lượt nền');
});
