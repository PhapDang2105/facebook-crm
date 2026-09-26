import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Hộp thư thử riêng: storePancakeEvents ghi vào messaging-store.
process.env.META_CONVERSATIONS_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pancake-comments-')), 'meta-conversations.json');
const {
  backlogBotChanges, enrichPancakeAdContext, findPancakePost, handlePancakeWebhook, missedBotChanges, normalizePancakeWebhook, pancakeSyncPlan, sendConversationMessageViaPancake, syncPancakeConversations
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


test('nhiều ảnh gửi chung một tin Pancake (content_ids nhiều mã), hộp thư ghi một tin mang đủ ảnh', async () => {
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
  const stored = await listMessages('110:905');
  assert.equal(stored.length, 1, 'một tin cho cả cụm');
  assert.deepEqual(stored[0].images, ['https://cdn.example/1.png', 'https://cdn.example/2.png', 'https://cdn.example/3.png']);
  assert.equal(stored[0].dataUrl, 'https://cdn.example/1.png');
});

test('giới tính từ hồ sơ Pancake vào hội thoại: hơn bản đoán theo xưng hô, kém nhân viên chọn tay', async () => {
  const { applyGenderGuess } = await import('../app/messaging-store.mjs');
  const withGender = { id: '110_906', type: 'INBOX', from: { id: '906', name: 'Khách Sáu' }, assignee_ids: [], page_customer: { gender: 'female', psid: '906' } };
  await handlePancakeWebhook(inbox({ conversation: withGender, message: { id: 'm_906_1', conversation_id: '110_906', message: 'anh ơi còn hàng không', from: { id: '906', name: 'Khách Sáu' } } }), { processChatbotChanges: async () => {}, chatbotDependencies: {}, config, fetchImpl: notFound });
  const conversation = await getConversation('110:906');
  assert.deepEqual([conversation.gender, conversation.genderSource], ['female', 'pancake'], 'hồ sơ Pancake thắng bản đoán từ câu chữ');
  assert.equal(applyGenderGuess(conversation, 'male', 'message'), false, 'đoán theo xưng hô không ghi đè hồ sơ Pancake');
  assert.equal(applyGenderGuess(conversation, 'male', 'staff'), true, 'nhân viên chọn tay vẫn thắng');
  const unknown = { id: '110_907', type: 'INBOX', from: { id: '907', name: 'Khách Bảy' }, assignee_ids: [], page_customer: { gender: null } };
  await handlePancakeWebhook(inbox({ conversation: unknown, message: { id: 'm_907_1', conversation_id: '110_907', message: 'xin chào', from: { id: '907', name: 'Khách Bảy' } } }), { processChatbotChanges: async () => {}, chatbotDependencies: {}, config, fetchImpl: notFound });
  assert.notEqual((await getConversation('110:907')).genderSource, 'pancake', 'Pancake không biết thì không ghi');
});

test('đồng bộ định kỳ đưa bot tin khách mới chưa ai trả lời (webhook bỏ sót); tin cũ, tin Page đã trả lời, bot đã tắt thì không', async () => {
  const recent = new Date(Date.now() - 2 * 60 * 1000).toISOString().slice(0, 19);
  const answered = new Date(Date.now() - 3 * 60 * 1000).toISOString().slice(0, 19);
  const reply = new Date(Date.now() - 2 * 60 * 1000 + 30000).toISOString().slice(0, 19);
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const fetchMock = async url => {
    const address = String(url);
    if (address.includes('/v2/pages/110/conversations') && address.includes('type=COMMENT')) return { ok: true, status: 200, json: async () => ({ success: true, conversations: [] }) };
    if (address.includes('/v2/pages/110/conversations')) {
      return { ok: true, status: 200, json: async () => ({ success: true, conversations: [
        { id: '110_7001', type: 'INBOX', from: { id: '7001', name: 'Khách Mới' }, assignee_ids: [] },
        { id: '110_7002', type: 'INBOX', from: { id: '7002', name: 'Khách Cũ' }, assignee_ids: [] },
        { id: '110_7003', type: 'INBOX', from: { id: '7003', name: 'Khách Đã Trả Lời' }, assignee_ids: [] }
      ] }) };
    }
    if (address.includes('/conversations/110_7001/messages')) return { ok: true, status: 200, json: async () => ({ success: true, messages: [{ id: 'm_7001_1', conversation_id: '110_7001', message: 'Giá sao em', from: { id: '7001', name: 'Khách Mới' }, inserted_at: recent }] }) };
    if (address.includes('/conversations/110_7002/messages')) return { ok: true, status: 200, json: async () => ({ success: true, messages: [{ id: 'm_7002_1', conversation_id: '110_7002', message: 'Giá sao em', from: { id: '7002', name: 'Khách Cũ' }, inserted_at: old }] }) };
    if (address.includes('/conversations/110_7003/messages')) return { ok: true, status: 200, json: async () => ({ success: true, messages: [
      { id: 'm_7003_1', conversation_id: '110_7003', message: 'Giá sao em', from: { id: '7003', name: 'Khách Đã Trả Lời' }, inserted_at: answered },
      { id: 'm_7003_2', conversation_id: '110_7003', message: 'Dạ 174k ạ', from: { id: '110', name: 'Test', admin_name: 'Nhân viên' }, inserted_at: reply }
    ] }) };
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  };
  const received = [];
  const summary = await syncPancakeConversations({ limit: 60, messagePages: 1, commentLimit: 0, processChatbotChanges: async changes => { received.push(...changes); }, chatbotDependencies: {} }, config, fetchMock);
  assert.equal(summary.messages, 4);
  assert.equal(summary.bot, 1);
  assert.deepEqual(received.map(change => [change.conversation.id, change.message.text]), [['110:7001', 'Giá sao em']]);
  // Chạy lại: tin đã có, không ghi lại, không đưa bot lần hai.
  const again = await syncPancakeConversations({ limit: 60, messagePages: 1, commentLimit: 0, processChatbotChanges: async changes => { received.push(...changes); }, chatbotDependencies: {} }, config, fetchMock);
  assert.equal(again.bot, undefined);
  assert.equal(received.length, 1);
  // Bot đã tắt trong hội thoại: không đưa.
  const store = { messages: { 'c1': [] } };
  assert.deepEqual(missedBotChanges([{ type: 'message', conversation: { id: 'c1', botEnabled: false }, message: { id: 'x', direction: 'incoming', createdAt: Date.now() } }], store), []);
  assert.equal(missedBotChanges([{ type: 'message', conversation: { id: 'c1' }, message: { id: 'x', direction: 'incoming', createdAt: Date.now() } }], store).length, 1);
});

test('sau khởi động: tin khách còn treo trong 60 phút (chưa ai trả lời, bot bật) đưa bot; tin cũ / đã trả lời / bot tắt thì không', () => {
  const now = Date.now();
  const store = {
    conversations: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd', botEnabled: false }, { id: 'e' }],
    messages: {
      a: [{ id: 'a1', direction: 'incoming', type: 'text', text: 'Giá sao em', createdAt: now - 20 * 60000 }],
      b: [{ id: 'b1', direction: 'incoming', type: 'text', text: 'Giá sao em', createdAt: now - 3 * 3600000 }],
      c: [{ id: 'c1', direction: 'incoming', type: 'text', text: 'Giá sao em', createdAt: now - 20 * 60000 }, { id: 'c2', direction: 'outgoing', type: 'text', text: 'Dạ…', createdAt: now - 19 * 60000 }],
      d: [{ id: 'd1', direction: 'incoming', type: 'text', text: 'Giá sao em', createdAt: now - 20 * 60000 }],
      e: [{ id: 'e1', direction: 'incoming', type: 'order-receipt', text: 'x', createdAt: now - 20 * 60000 }]
    }
  };
  assert.deepEqual(backlogBotChanges(store, { now }).map(change => change.conversation.id), ['a']);
});

test('lịch đồng bộ thích ứng: đủ mỗi 10 phút; webhook im quá 15 phút thì thêm lượt nhanh mỗi 2 phút; webhook còn sống thì không', () => {
  const m = 60 * 1000;
  const t0 = 1_000_000_000_000;
  assert.equal(pancakeSyncPlan({ now: t0, startedAt: t0, lastFullAt: 0 }), 'full', 'chưa chạy lần nào → đủ');
  assert.equal(pancakeSyncPlan({ now: t0 + 5 * m, startedAt: t0, lastFullAt: t0, lastQuickAt: t0 }), null, 'mới khởi động 5 phút: chưa coi là im');
  assert.equal(pancakeSyncPlan({ now: t0 + 16 * m, startedAt: t0, lastFullAt: t0 + 10 * m, lastQuickAt: t0 + 10 * m, lastWebhookAt: 0 }), 'quick', 'im 16 phút, lượt nhanh cách 6 phút');
  assert.equal(pancakeSyncPlan({ now: t0 + 17 * m, startedAt: t0, lastFullAt: t0 + 10 * m, lastQuickAt: t0 + 16 * m, lastWebhookAt: 0 }), null, 'lượt nhanh vừa chạy 1 phút trước');
  assert.equal(pancakeSyncPlan({ now: t0 + 16 * m, startedAt: t0, lastFullAt: t0 + 10 * m, lastQuickAt: t0 + 10 * m, lastWebhookAt: t0 + 14 * m }), null, 'webhook vừa gọi 2 phút trước: không cần nhanh');
  assert.equal(pancakeSyncPlan({ now: t0 + 21 * m, startedAt: t0, lastFullAt: t0 + 10 * m, lastQuickAt: t0 + 20 * m, lastWebhookAt: t0 + 20 * m }), 'full', 'đến kỳ 10 phút thì đủ');
});
