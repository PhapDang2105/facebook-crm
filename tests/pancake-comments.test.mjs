import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Hộp thư thử riêng: storePancakeEvents ghi vào messaging-store.
process.env.META_CONVERSATIONS_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pancake-comments-')), 'meta-conversations.json');
const {
  enrichPancakeAdContext, findPancakePost, handlePancakeWebhook, normalizePancakeWebhook, sendConversationMessageViaPancake, syncPancakeConversations
} = await import('../app/pancake.mjs');
const { getConversation, listMessages } = await import('../app/messaging-store.mjs');

const config = { pageId: '110', pageName: 'Test', pageAccessToken: 'pat-1', webhookToken: 'hook-1', apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false };
const notFound = async () => ({ ok: false, status: 404, json: async () => ({}) });
const inbox = (overrides = {}) => ({
  page_id: '110',
  event_type: 'messaging',
  data: {
    conversation: { id: '110_555', type: 'INBOX', from: { id: '555', name: 'Chị Mai' }, assignee_ids: [], ...(overrides.conversation || {}) },
    message: { id: 'm_abc', conversation_id: '110_555', page_id: '110', type: 'INBOX', message: 'Xin chào', inserted_at: '2026-09-19T02:30:00.000000', from: { id: '555', name: 'Chị Mai' }, attachments: [], ...(overrides.message || {}) }
  }
});
const commentPayload = (overrides = {}) => ({
  page_id: '110',
  event_type: 'messaging',
  data: {
    conversation: { id: '777_5001', type: 'COMMENT', post_id: '110_777', from: { id: '901', name: 'Anh Long' }, assignee_ids: [], ...(overrides.conversation || {}) },
    message: {
      id: '777_5001', conversation_id: '777_5001', type: 'COMMENT', message: '<div>Túi 350g bao nhiêu tiền?</div>', original_message: '<div>Túi 350g bao nhiêu tiền?</div>',
      from: { id: '901', name: 'Anh Long' }, parent_id: '777_5001', is_parent: true, inserted_at: '2026-09-19T00:54:16.000000', attachments: [], can_reply_privately: true,
      // Pancake: original_message là bản trước khi sửa của CHÍNH tin đó; tin khác thì không mang theo.
      ...(overrides.message?.message ? { original_message: overrides.message.message } : {}),
      ...(overrides.message || {})
    },
    post: {
      id: '110_777', message: 'Granola túi vàng 350g của Giọt Nắng, hạt điều, hạnh nhân…', type: 'photo', from: { id: '110', name: 'Test' },
      attachments: { data: [{ type: 'photo', target: { url: 'https://www.facebook.com/x', thumbnail: 'https://content.pancake.vn/t.jpg' } }] },
      ...(overrides.post || {})
    }
  }
});

test('bình luận Pancake → luồng bình luận CRM kèm bài viết; bot nhận change với source comment; trả lời của nhân viên nối vào luồng và tạm dừng bot', async () => {
  const botCalls = [];
  const processChatbotChanges = async changes => { botCalls.push(...changes); };
  const [event] = normalizePancakeWebhook(commentPayload(), config);
  assert.equal(event.type, 'comment');
  assert.deepEqual([event.commentId, event.postId, event.parentId, event.fromId, event.fromPage, event.text], ['777_5001', '110_777', '', '901', false, 'Túi 350g bao nhiêu tiền?']);
  const first = await handlePancakeWebhook(commentPayload(), { processChatbotChanges, chatbotDependencies: {}, config, fetchImpl: notFound });
  assert.deepEqual(first, { stored: 1, bot: 1 });
  const thread = await getConversation('110:comment:901:110_777');
  assert.equal(thread.source, 'comment');
  assert.equal(thread.pancakeConversationId, '777_5001');
  assert.equal(thread.lastCommentId, '777_5001');
  assert.equal(thread.name, 'Anh Long');
  assert.match(thread.post.message, /Granola túi vàng 350g/);
  assert.deepEqual([thread.post.id, thread.post.permalink, thread.post.picture], ['110_777', 'https://www.facebook.com/110_777', 'https://content.pancake.vn/t.jpg']);
  assert.equal(botCalls[0].conversation.source, 'comment');
  assert.equal(botCalls[0].message.direction, 'incoming');
  // Nhân viên trả lời dưới bình luận trong Pancake: tin đi trong cùng luồng, bot tạm dừng.
  const staffReply = commentPayload({ message: { id: '777_5002', message: 'Dạ em đã nhắn tin cho mình rồi ạ', from: { id: '110', name: 'Test', admin_name: 'Thúy Hằng' }, parent_id: '777_5001', is_parent: false } });
  const second = await handlePancakeWebhook(staffReply, { processChatbotChanges, chatbotDependencies: {}, config, fetchImpl: notFound });
  assert.equal(second.stored, 1);
  const stored = await listMessages('110:comment:901:110_777');
  assert.deepEqual(stored.map(item => [item.direction, item.text]), [['incoming', 'Túi 350g bao nhiêu tiền?'], ['outgoing', 'Dạ em đã nhắn tin cho mình rồi ạ']]);
  const paused = await getConversation('110:comment:901:110_777');
  assert.deepEqual([paused.botEnabled, paused.botPausedBy], [false, 'Thúy Hằng']);
  // Gửi lại cùng bình luận: không ghi thêm.
  assert.deepEqual(await handlePancakeWebhook(commentPayload(), { processChatbotChanges, chatbotDependencies: {}, config, fetchImpl: notFound }), { stored: 0, bot: 0 });
});

test('trả lời luồng bình luận qua Pancake: công khai bằng reply_comment, nhắn riêng bằng private_replies vào hộp thư của khách', async () => {
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ success: true, id: `m_${calls.length}` }) };
  };
  const thread = await getConversation('110:comment:901:110_777');
  const priv = await sendConversationMessageViaPancake(thread, { text: 'Dạ em gửi giá qua đây ạ', privateReply: true }, config, fetchMock);
  assert.ok(calls[0].url.includes('/conversations/777_5001/messages'));
  assert.deepEqual(calls[0].body, { action: 'private_replies', post_id: '110_777', message_id: '777_5001', from_id: '901', message: 'Dạ em gửi giá qua đây ạ' });
  assert.equal(priv.conversation.id, '110:901', 'tin nhắn riêng nằm ở hộp thư Messenger của khách');
  const inboxThread = await getConversation('110:901');
  assert.equal(inboxThread.pancakeConversationId, '110_901');
  assert.equal(inboxThread.post?.inheritedFrom, '110:comment:901:110_777');
  const pub = await sendConversationMessageViaPancake(thread, { text: 'Dạ mình kiểm tra tin nhắn giúp em nha' }, config, fetchMock);
  assert.deepEqual(calls[1].body, { action: 'reply_comment', message_id: '777_5001', message: 'Dạ mình kiểm tra tin nhắn giúp em nha' });
  assert.equal(pub.conversation.id, '110:comment:901:110_777');
  assert.equal((await listMessages('110:comment:901:110_777')).at(-1).parentId, '777_5001');
  await assert.rejects(sendConversationMessageViaPancake(thread, { imageUrl: 'https://x/1.png' }, config, fetchMock), /bằng chữ/);
});

test('khách đến từ quảng cáo: referral nguồn ADS, tên quảng cáo tra qua GET /ads, nội dung bài quảng cáo tìm theo tháng', async () => {
  const fetchMock = async url => {
    const address = String(url);
    if (address.includes('/pages/110/ads')) return { ok: true, status: 200, json: async () => ({ success: true, data: [{ id: 'ad-1', name: 'Túi Vàng - Video 01', image_url: 'https://cdn/ad.jpg', campaign_name: 'Granola T9' }] }) };
    if (address.includes('/pages/110/posts')) return { ok: true, status: 200, json: async () => ({ success: true, data: [{ id: '110_888', message: 'Bài quảng cáo Granola Túi Vàng 350g', type: 'photo' }] }) };
    return notFound();
  };
  const adConversation = { id: '110_902', type: 'INBOX', from: { id: '902', name: 'Chị Hoa' }, assignee_ids: [], ad_ids: ['ad-1'], ads: [{ ad_id: 'ad-1', post_id: '110_888', inserted_at: '2026-09-19T01:00:00' }] };
  const result = await handlePancakeWebhook(inbox({ conversation: adConversation, message: { id: 'm_902_1', conversation_id: '110_902', message: 'Còn hàng không', from: { id: '902', name: 'Chị Hoa' } } }), { processChatbotChanges: async () => {}, chatbotDependencies: {}, config, fetchImpl: fetchMock });
  assert.equal(result.stored, 1);
  const conversation = await getConversation('110:902');
  assert.deepEqual(conversation.referral, { ref: '', source: 'ADS', adId: 'ad-1', adTitle: 'Túi Vàng - Video 01 · Granola T9', postId: '110_888', photoUrl: 'https://cdn/ad.jpg' });
  assert.equal(conversation.referrals.length, 1);
  const post = await findPancakePost('110_888', { months: 1 }, config, fetchMock);
  assert.equal(post.message, 'Bài quảng cáo Granola Túi Vàng 350g');
  for (let attempt = 0; attempt < 30 && !(await getConversation('110:902')).post?.message; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await getConversation('110:902')).post?.message, 'Bài quảng cáo Granola Túi Vàng 350g');
  // Tin sau cùng quảng cáo: không ghi referral lần hai.
  await handlePancakeWebhook(inbox({ conversation: adConversation, message: { id: 'm_902_2', conversation_id: '110_902', message: 'Giá sao', from: { id: '902', name: 'Chị Hoa' } } }), { processChatbotChanges: async () => {}, chatbotDependencies: {}, config, fetchImpl: fetchMock });
  assert.equal((await getConversation('110:902')).referrals.length, 1);
  assert.equal(await enrichPancakeAdContext([], config, fetchMock), 0);
});

test('đồng bộ lịch sử kéo cả luồng bình luận kèm bài viết, không đưa bot', async () => {
  const fetchMock = async url => {
    const address = String(url);
    if (address.includes('/v2/pages/110/conversations') && address.includes('type=COMMENT')) {
      return { ok: true, status: 200, json: async () => ({ success: true, conversations: [{ id: '999_6001', type: 'COMMENT', post_id: '110_999', from: { id: '903', name: 'Cô Ba' }, assignee_ids: [] }] }) };
    }
    if (address.includes('/v2/pages/110/conversations')) return { ok: true, status: 200, json: async () => ({ success: true, conversations: [] }) };
    if (address.includes('/conversations/999_6001/messages')) {
      return { ok: true, status: 200, json: async () => ({ success: true, post: { id: '110_999', message: 'Bài Túi Nâu cacao' }, messages: [
        { id: '999_6002', type: 'COMMENT', message: 'Dạ còn ạ', from: { id: '110', name: 'Test', admin_name: 'Public API' }, parent_id: '999_6001', is_parent: false, inserted_at: '2026-09-18T10:01:00' },
        { id: '999_6001', type: 'COMMENT', message: 'Còn túi nâu không', from: { id: '903', name: 'Cô Ba' }, parent_id: '999_6001', is_parent: true, inserted_at: '2026-09-18T10:00:00' }
      ] }) };
    }
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  };
  const summary = await syncPancakeConversations({ limit: 60, messagePages: 1, commentLimit: 30 }, config, fetchMock);
  assert.deepEqual(summary, { conversations: 1, messages: 2 });
  const thread = await getConversation('110:comment:903:110_999');
  assert.equal(thread.post.message, 'Bài Túi Nâu cacao');
  assert.deepEqual((await listMessages(thread.id)).map(item => [item.direction, item.text]), [['incoming', 'Còn túi nâu không'], ['outgoing', 'Dạ còn ạ']]);
  assert.notEqual(thread.botEnabled, false, 'lịch sử kéo về không tạm dừng bot');
});

test('thông báo hệ thống của Facebook khi nhắn riêng từ bình luận không vào hộp thư', () => {
  const notice = inbox({ message: { id: 'm_sys', message: 'Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của bạn.', from: { id: '110', name: 'Test' } } });
  assert.deepEqual(normalizePancakeWebhook(notice, config), []);
});

test('nhiều ảnh gửi chung một tin Pancake (content_ids nhiều mã), hộp thư ghi mỗi ảnh một bong bóng', async () => {
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    const address = String(url);
    if (address.startsWith('https://cdn.example/')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: new Headers({ 'content-type': 'image/png' }) };
    if (address.includes('/upload_contents')) { const n = calls.push('upload'); return { ok: true, status: 200, json: async () => ({ success: true, id: `c${n}`, attachment_type: 'PHOTO' }) }; }
    if (address.includes('/conversations/110_905/messages')) { const body = JSON.parse(options.body); calls.push(`send:${(body.content_ids || []).join(',')}`); return { ok: true, status: 200, json: async () => ({ success: true, id: 'm_album' }) }; }
    return notFound();
  };
  const conversation = { pageId: '110', psid: '905', pancakeConversationId: '110_905' };
  const saved = await sendConversationMessageViaPancake(conversation, { imageUrls: ['https://cdn.example/1.png', 'https://cdn.example/2.png', 'https://cdn.example/3.png'] }, config, fetchMock);
  assert.deepEqual(calls.filter(call => call.startsWith('send')), ['send:c1,c2,c3'], 'một lần gửi mang cả ba mã');
  assert.equal(calls.filter(call => call === 'upload').length, 3);
  assert.equal(saved.message.id, 'm_album');
  assert.deepEqual(saved.extras.map(item => item.id), ['m_album#1', 'm_album#2']);
  assert.deepEqual((await listMessages('110:905')).map(item => item.dataUrl), ['https://cdn.example/1.png', 'https://cdn.example/2.png', 'https://cdn.example/3.png']);
});
