import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

// INT-16: lùi lại và gọi lại khi Pancake trả 429 nằm ở MỘT chỗ (pancakeFetch) cho gửi tin và tải tệp.
process.env.META_CONVERSATIONS_PATH = path.join(tempDir('opt-int-429-'), 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(tempDir('opt-int-429-fu-'), 'follow-ups.json');
const { sendPancakeMessage, uploadPancakeContent } = await import('../app/pancake.mjs');

const config = { pageId: '130', pageName: 'Test', pageAccessToken: 'pat-1', webhookToken: 'hook-1', apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false };

test('gửi tin: 429 một lần thì lùi lại rồi gửi lại, thành công; tải tệp cũng vậy', async () => {
  let sends = 0;
  const sendFetch = async () => {
    sends += 1;
    return sends === 1
      ? { ok: false, status: 429, json: async () => ({ message: 'Too many requests' }) }
      : { ok: true, status: 200, json: async () => ({ success: true, id: 'msg-1' }) };
  };
  const sent = await sendPancakeMessage({ pageId: '130', conversationId: '130_1', text: 'Chào' }, config, sendFetch);
  assert.equal(sent.id, 'msg-1');
  assert.equal(sends, 2);

  let uploads = 0;
  const uploadFetch = async (_url, options) => {
    uploads += 1;
    assert.ok(options.body instanceof FormData, 'gửi lại cùng FormData');
    return uploads === 1
      ? { ok: false, status: 429, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ success: true, id: 'content-1', attachment_type: 'PHOTO' }) };
  };
  const uploaded = await uploadPancakeContent({ pageId: '130', buffer: Buffer.from('abc'), filename: 'a.jpg', mime: 'image/jpeg' }, config, uploadFetch);
  assert.equal(uploaded.id, 'content-1');
  assert.equal(uploads, 2);
});
