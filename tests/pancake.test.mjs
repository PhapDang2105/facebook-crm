import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Hộp thư thử riêng: storePancakeEvents ghi vào messaging-store.
process.env.META_CONVERSATIONS_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pancake-')), 'meta-conversations.json');
const {
  handlePancakeWebhook, isPancakeWebhookTokenValid, normalizePancakeWebhook, pancakeMessageText, pancakeTime, sendPancakeMessage
} = await import('../app/pancake.mjs');

const config = { pageId: '110', pageName: 'Test', pageAccessToken: 'pat-1', webhookToken: 'hook-1', apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false };
const incoming = (overrides = {}) => ({
  page_id: '110',
  event_type: 'messaging',
  data: {
    conversation: { id: '110_555', type: 'INBOX', from: { id: '555', name: 'Chị Mai' }, assignee_ids: [], ...(overrides.conversation || {}) },
    message: {
      id: 'm_abc', conversation_id: '110_555', page_id: '110', type: 'INBOX',
      message: '<div>Shop còn <b>Granola Xanh</b> không?</div>', original_message: '<div>Shop còn <b>Granola Xanh</b> không?</div>',
      inserted_at: '2026-09-19T02:30:00.000000', from: { id: '555', name: 'Chị Mai', page_customer_id: 'pc-1' }, attachments: [],
      ...(overrides.message || {})
    }
  }
});

test('tin inbox của khách → sự kiện cùng dạng webhook Meta: chữ sạch HTML, giờ UTC, mã hội thoại Pancake', () => {
  const [event] = normalizePancakeWebhook(incoming(), config, 1);
  assert.equal(event.pageId, '110');
  assert.equal(event.psid, '555');
  assert.equal(event.message.direction, 'incoming');
  assert.equal(event.message.text, 'Shop còn Granola Xanh không?');
  assert.equal(event.message.type, 'text');
  assert.equal(event.message.id, 'm_abc');
  assert.equal(event.message.createdAt, Date.UTC(2026, 8, 19, 2, 30));
  assert.deepEqual(event.pancake, { conversationId: '110_555', customerName: 'Chị Mai', pageCustomerId: 'pc-1', assigned: false, staff: false, staffName: '', ad: null, gender: '' });
});

test('ảnh khách gửi hiện thẳng bằng URL CDN; tin Page gõ trong Pancake là của nhân viên, tin qua Public API là của CRM', () => {
  const [photo] = normalizePancakeWebhook(incoming({ message: { id: 'm_p', message: '', original_message: '', attachments: [{ type: 'photo', url: 'https://content.pancake.vn/a.jpg', image_data: { width: 10, height: 10 } }] } }), config);
  assert.equal(photo.message.type, 'image');
  assert.equal(photo.message.dataUrl, 'https://content.pancake.vn/a.jpg');
  const [album] = normalizePancakeWebhook(incoming({ message: { id: 'm_p3', message: '', original_message: '', attachments: [{ type: 'photo', url: 'https://content.pancake.vn/1.jpg' }, { type: 'photo', url: 'https://content.pancake.vn/2.jpg' }, { type: 'photo', url: 'https://content.pancake.vn/3.jpg' }] } }), config);
  assert.deepEqual(album.message.images, ['https://content.pancake.vn/1.jpg', 'https://content.pancake.vn/2.jpg', 'https://content.pancake.vn/3.jpg'], 'khách gửi ba ảnh thì giữ đủ ba');
  const [staff] = normalizePancakeWebhook(incoming({ message: { id: 'm_s', message: 'Dạ em gửi ảnh ạ', from: { id: '110', name: 'Test', admin_name: 'Nguyễn Hồng Vy' } } }), config);
  assert.deepEqual([staff.message.direction, staff.pancake.staff, staff.pancake.staffName], ['outgoing', true, 'Nguyễn Hồng Vy']);
  const [api] = normalizePancakeWebhook(incoming({ message: { id: 'm_a', message: 'Dạ còn ạ', from: { id: '110', name: 'Test', admin_name: 'Public API' } } }), config);
  assert.deepEqual([api.message.direction, api.pancake.staff], ['outgoing', false]);
});

test('tin do Page gửi (nhân viên trả lời trong Pancake) là tin đi; bình luận, Page khác, sự kiện khác bị bỏ', () => {
  const [staff] = normalizePancakeWebhook(incoming({ message: { id: 'm_2', from: { id: '110', name: 'Giọt Nắng' }, message: 'Dạ còn ạ' } }), config);
  assert.equal(staff.message.direction, 'outgoing');
  assert.equal(staff.psid, '555', 'khách vẫn là người bên kia của hội thoại');
  assert.deepEqual(normalizePancakeWebhook(incoming({ message: { type: 'COMMENT' } }), config), []);
  assert.deepEqual(normalizePancakeWebhook({ ...incoming(), page_id: '999' }, config), []);
  assert.deepEqual(normalizePancakeWebhook({ ...incoming(), event_type: 'conversation' }, config), []);
  const [attachmentOnly] = normalizePancakeWebhook(incoming({ message: { message: '', original_message: '', attachments: [{ type: 'file', url: 'https://content.pancake.vn/a.pdf' }] } }), config);
  assert.equal(attachmentOnly.message.type, 'attachment');
  assert.equal(attachmentOnly.message.text, '[Tệp đính kèm]');
  // Rác của Facebook Shop: tin trống của khách và tin "Gửi tin nhắn" của Page không ghi.
  assert.deepEqual(normalizePancakeWebhook(incoming({ message: { id: 'm_empty', message: '<div></div>', original_message: '', attachments: [] } }), config), []);
  assert.deepEqual(normalizePancakeWebhook(incoming({ message: { id: 'm_cta', message: '<div></div>', original_message: '', from: { id: '110', name: 'Test' }, attachments: [{ id: 'm_cta', name: 'Gửi tin nhắn', type: 'attachment' }] } }), config), []);
  assert.deepEqual(normalizePancakeWebhook(incoming({ message: { id: 'm_tpl', message: '<div></div>', original_message: '', attachments: [{ type: 'template' }] } }), config), [], 'thẻ template trống');
  assert.deepEqual(normalizePancakeWebhook(incoming({ message: { id: 'm_react', message: '', original_message: '', from: { id: '110', name: 'Test' }, attachments: [{ emoji: '❤', reaction: 'other', type: 'reaction' }] } }), config), [], 'cảm xúc không kèm chữ');
});

test('khách bấm Mua ở Facebook Shop (cart_order): ghi thành chữ có tên, SKU, giá để hộp thư và bot đọc được', () => {
  const [cart] = normalizePancakeWebhook(incoming({ message: {
    id: 'm_send_cart:e0d5a31e', message: '<div></div>', original_message: '',
    attachments: [{ type: 'cart_order', order: { items: [{ quantity: 0, variation_info: { id: '2535', name: 'Granola Mới Ngũ Cốc Ăn Sáng', retail_price: 189000, retailer_id: 'GRA-XANH-Z450', images: ['https://content.pancake.vn/a.jpg'] } }] } }]
  } }), config);
  assert.equal(cart.message.type, 'text');
  assert.equal(cart.message.text, 'Khách chọn mua từ Facebook Shop: Granola Mới Ngũ Cốc Ăn Sáng (GRA-XANH-Z450) — 189.000đ');
  assert.deepEqual(cart.message.cart, [{ name: 'Granola Mới Ngũ Cốc Ăn Sáng', sku: 'GRA-XANH-Z450', quantity: 0, price: 189000, image: 'https://content.pancake.vn/a.jpg' }]);
});

test('chữ và giờ: bỏ thẻ HTML, giữ xuống dòng; giờ không múi giờ đọc là UTC', () => {
  assert.equal(pancakeMessageText({ message: '<div>Dòng 1</div><div>Dòng 2&nbsp;&amp; 3</div>' }), 'Dòng 1\nDòng 2 & 3');
  assert.equal(pancakeTime('2024-12-25T11:06:07.000000', 0), Date.UTC(2024, 11, 25, 11, 6, 7));
  assert.equal(pancakeTime('2024-12-25T18:06:07+07:00', 0), Date.UTC(2024, 11, 25, 11, 6, 7));
  assert.equal(pancakeTime('', 42), 42);
});

test('token webhook: so sánh an toàn, token trống là tắt', () => {
  assert.equal(isPancakeWebhookTokenValid('hook-1', 'hook-1'), true);
  assert.equal(isPancakeWebhookTokenValid('hook-2', 'hook-1'), false);
  assert.equal(isPancakeWebhookTokenValid('', ''), false);
});

test('gửi tin: đúng URL v1, token trên query, body reply_inbox; lỗi của Pancake được nêu rõ', async () => {
  const calls = [];
  const fetchOk = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ success: true, id: 'm_sent' }) }; };
  const sent = await sendPancakeMessage({ pageId: '110', conversationId: '110_555', text: 'Dạ còn ạ' }, config, fetchOk);
  assert.equal(sent.id, 'm_sent');
  assert.equal(calls[0].url, 'https://pages.fm/api/public_api/v1/pages/110/conversations/110_555/messages?page_access_token=pat-1');
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'reply_inbox', message: 'Dạ còn ạ' });
  const fetchFail = async () => ({ ok: false, status: 401, json: async () => ({ success: false, message: 'Invalid access_token' }) });
  await assert.rejects(sendPancakeMessage({ pageId: '110', conversationId: '110_555', text: 'x' }, config, fetchFail), /Invalid access_token/);
  await assert.rejects(sendPancakeMessage({ pageId: '110', conversationId: '', text: 'x' }, config, fetchOk), /chưa có mã Pancake/);
});

test('webhook đầu tới cuối: ghi hộp thư, đưa bot; hội thoại đã có nhân viên nhận thì bot đứng ngoài; gửi lặp không ghi hai lần', async () => {
  const botCalls = [];
  const processChatbotChanges = async changes => { botCalls.push(changes); };
  const first = await handlePancakeWebhook(incoming(), { processChatbotChanges, chatbotDependencies: {}, config });
  assert.deepEqual(first, { stored: 1, bot: 1 });
  assert.equal(botCalls[0][0].conversation.pancakeConversationId, '110_555');
  assert.equal(botCalls[0][0].conversation.name, 'Chị Mai');
  assert.equal(botCalls[0][0].conversation.picture, 'https://pancake.vn/api/v1/pages/110/avatar/555', 'ảnh khách lấy qua đường công khai của Pancake');
  assert.equal(botCalls[0][0].message.text, 'Shop còn Granola Xanh không?');
  // Pancake gửi lại cùng tin (cập nhật): không ghi thêm, không gọi bot lần nữa.
  const again = await handlePancakeWebhook(incoming(), { processChatbotChanges, chatbotDependencies: {}, config });
  assert.deepEqual(again, { stored: 0, bot: 0 });
  // Nhân viên đã nhận hội thoại: tin mới vẫn ghi nhưng bot không trả lời.
  const assigned = await handlePancakeWebhook(incoming({ message: { id: 'm_3', message: 'Cho em hỏi giá' }, conversation: { assignee_ids: ['staff-1'] } }), { processChatbotChanges, chatbotDependencies: {}, config });
  assert.deepEqual(assigned, { stored: 1, bot: 0 });
  assert.equal(botCalls.length, 1);
  // Cho phép bot nói cả khi đã gán.
  const allowed = await handlePancakeWebhook(incoming({ message: { id: 'm_4', message: 'Còn không ạ' }, conversation: { assignee_ids: ['staff-1'] } }), { processChatbotChanges, chatbotDependencies: {}, config: { ...config, botWhenAssigned: true } });
  assert.deepEqual(allowed, { stored: 1, bot: 1 });
});

test('đồng bộ lịch sử: kéo hội thoại inbox rồi tin của từng hội thoại, ghi theo thứ tự thời gian, chạy lại không ghi trùng, không đưa bot', async () => {
  const { syncPancakeConversations, fetchPancakeConversations } = await import('../app/pancake.mjs');
  const calls = [];
  const fetchMock = async url => {
    const address = String(url);
    calls.push(address);
    if (address.includes('/v2/pages/110/conversations')) {
      return { ok: true, status: 200, json: async () => ({ success: true, conversations: [
        { id: '110_901', type: 'INBOX', from: { id: '901', name: 'Anh Long' }, assignee_ids: [], updated_at: '2026-09-18T10:00:00' },
        { id: '110_post_1', type: 'COMMENT', from: { id: '902', name: 'Người bình luận' } }
      ] }) };
    }
    if (address.includes('/conversations/110_901/messages')) {
      return { ok: true, status: 200, json: async () => ({ success: true, messages: [
        { id: 'm_h2', type: 'INBOX', message: '<div>Dạ còn ạ</div>', inserted_at: '2026-09-18T10:00:00', from: { id: '110', name: 'Giọt Nắng Healthy' } },
        { id: 'm_h1', type: 'INBOX', message: 'Còn túi xanh không?', inserted_at: '2026-09-18T09:59:00', from: { id: '901', name: 'Anh Long' } }
      ] }) };
    }
    return { ok: false, status: 404, json: async () => ({ success: false, message: 'không có' }) };
  };
  const conversations = await fetchPancakeConversations({ limit: 60 }, config, fetchMock);
  assert.deepEqual(conversations.map(item => item.id), ['110_901'], 'bình luận bị bỏ, chỉ giữ inbox');
  assert.ok(calls[0].includes('page_access_token=pat-1') && calls[0].includes('type=INBOX'));
  const first = await syncPancakeConversations({ limit: 60, messagePages: 1, commentLimit: 0 }, config, fetchMock);
  assert.deepEqual(first, { conversations: 1, messages: 2 });
  const again = await syncPancakeConversations({ limit: 60, messagePages: 1, commentLimit: 0 }, config, fetchMock);
  assert.deepEqual(again, { conversations: 1, messages: 0 }, 'chạy lại không ghi trùng');
  const { listMessages } = await import('../app/messaging-store.mjs');
  const stored = await listMessages('110:901');
  assert.deepEqual(stored.map(item => [item.direction, item.text]), [['incoming', 'Còn túi xanh không?'], ['outgoing', 'Dạ còn ạ']], 'tin cũ đứng trước tin mới');
  assert.deepEqual(await syncPancakeConversations({}, { ...config, pageAccessToken: '' }, fetchMock), { conversations: 0, messages: 0, skipped: 'chưa cấu hình' });
});

test('nhân viên trả lời trong Pancake thì bot tắt cho hội thoại đó; tin CRM gửi và lịch sử kéo về không tắt', async () => {
  const { storePancakeEvents } = await import('../app/pancake.mjs');
  const { getConversation } = await import('../app/messaging-store.mjs');
  const staffConversation = { id: '110_777', type: 'INBOX', from: { id: '777', name: 'Anh Ba' }, assignee_ids: [] };
  const processChatbotChanges = async () => {};
  await handlePancakeWebhook(incoming({ conversation: staffConversation, message: { id: 'm_777_1', conversation_id: '110_777', message: 'Cho em hỏi giá', from: { id: '777', name: 'Anh Ba' } } }), { processChatbotChanges, chatbotDependencies: {}, config });
  await handlePancakeWebhook(incoming({ conversation: staffConversation, message: { id: 'm_777_2', conversation_id: '110_777', message: 'Dạ em gửi ảnh ạ', from: { id: '110', name: 'Test', admin_name: 'Nguyễn Hồng Vy' } } }), { processChatbotChanges, chatbotDependencies: {}, config });
  const paused = await getConversation('110:777');
  assert.deepEqual([paused.botEnabled, paused.botPausedBy], [false, 'Nguyễn Hồng Vy']);
  // Tin dội lại của CRM (Public API) ở hội thoại khác: bot vẫn bật.
  const apiConversation = { id: '110_778', type: 'INBOX', from: { id: '778', name: 'Chị Tư' }, assignee_ids: [] };
  await handlePancakeWebhook(incoming({ conversation: apiConversation, message: { id: 'm_778_1', conversation_id: '110_778', message: 'Dạ còn ạ', from: { id: '110', name: 'Test', admin_name: 'Public API' } } }), { processChatbotChanges, chatbotDependencies: {}, config });
  assert.notEqual((await getConversation('110:778')).botEnabled, false);
  // Lịch sử kéo về (không phải webhook) có tin nhân viên: không tắt.
  const historyConversation = { id: '110_779', type: 'INBOX', from: { id: '779', name: 'Cô Năm' }, assignee_ids: [] };
  const [old] = normalizePancakeWebhook(incoming({ conversation: historyConversation, message: { id: 'm_779_1', conversation_id: '110_779', message: 'Dạ em gửi rồi ạ', from: { id: '110', name: 'Test', admin_name: 'Nguyễn Hồng Vy' } } }), config);
  await storePancakeEvents([old]);
  assert.notEqual((await getConversation('110:779')).botEnabled, false);
});

test('gửi ảnh qua Pancake: tải lên upload_contents rồi gửi content_ids; ảnh sản phẩm nhớ mã, tệp đính kèm gửi chữ sau', async () => {
  const { sendConversationMessageViaPancake } = await import('../app/pancake.mjs');
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    const address = String(url);
    if (address.startsWith('https://cdn.example/')) {
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: new Headers({ 'content-type': 'image/png' }) };
    }
    if (address.includes('/upload_contents')) {
      assert.ok(options.body instanceof FormData, 'tải lên dạng multipart');
      assert.ok(options.body.get('file') instanceof Blob);
      calls.push('upload');
      return { ok: true, status: 200, json: async () => ({ success: true, id: `c${calls.length}`, attachment_type: 'PHOTO' }) };
    }
    if (address.includes('/conversations/110_555/messages')) {
      const body = JSON.parse(options.body);
      calls.push(body.content_ids ? `send:${body.content_ids.join(',')}` : `text:${body.message}`);
      assert.ok(!(body.content_ids && body.message), 'không gửi message cùng content_ids');
      return { ok: true, status: 200, json: async () => ({ success: true, id: `m_${calls.length}` }) };
    }
    throw new Error(`gọi lạ: ${address}`);
  };
  const conversation = { pageId: '110', psid: '555', pancakeConversationId: '110_555' };
  const image = await sendConversationMessageViaPancake(conversation, { imageUrl: 'https://cdn.example/xanh.png?v=1' }, config, fetchMock);
  assert.deepEqual([image.message.type, image.message.dataUrl], ['image', 'https://cdn.example/xanh.png?v=1']);
  await sendConversationMessageViaPancake(conversation, { imageUrl: 'https://cdn.example/xanh.png?v=2' }, config, fetchMock);
  assert.deepEqual(calls, ['upload', 'send:c1', 'upload', 'send:c3'], 'mỗi lần gửi tải ảnh mới: mã dùng lại bị Facebook từ chối');
  calls.length = 0;
  const file = await sendConversationMessageViaPancake(conversation, { text: 'Ảnh đây ạ', attachment: { dataUrl: 'data:image/jpeg;base64,/9j/4AAQ', name: 'mau.jpg', type: 'image' } }, config, fetchMock);
  assert.deepEqual(calls, ['upload', 'send:c1', 'text:Ảnh đây ạ']);
  assert.deepEqual([file.message.type, file.message.name, file.message.dataUrl], ['image', 'mau.jpg', '']);
});

test('ảnh lớn hơn 500 KB được thu nhỏ và nén sang JPEG trước khi tải lên Pancake; ảnh nhỏ giữ nguyên', async () => {
  const { fitImageForPancake, pancakeUploadLimit } = await import('../app/pancake.mjs');
  const { default: sharp } = await import('sharp');
  const small = { buffer: Buffer.alloc(1000, 1), filename: 'nho.png', mime: 'image/png' };
  assert.equal(await fitImageForPancake(small), small);
  // Ảnh nhiễu 1600×1600 nén PNG vẫn vài MB, giống ảnh sản phẩm chụp thật.
  const noise = Buffer.from(Array.from({ length: 1600 * 1600 * 3 }, () => Math.floor(Math.random() * 256)));
  const bigPng = await sharp(noise, { raw: { width: 1600, height: 1600, channels: 3 } }).png().toBuffer();
  assert.ok(bigPng.length > pancakeUploadLimit, `ảnh thử phải lớn hơn giới hạn (${bigPng.length})`);
  const fitted = await fitImageForPancake({ buffer: bigPng, filename: 'xanh.png', mime: 'image/png' });
  assert.ok(fitted.buffer.length <= pancakeUploadLimit, `sau nén ${fitted.buffer.length} bytes`);
  assert.deepEqual([fitted.filename, fitted.mime], ['xanh.jpg', 'image/jpeg']);
  const meta = await sharp(fitted.buffer).metadata();
  assert.ok(meta.width <= 1080 && meta.height <= 1080);
});

test('ảnh PNG nền trong suốt nén sang JPEG thì nền thành trắng, không đen', async () => {
  const { fitImageForPancake } = await import('../app/pancake.mjs');
  const { default: sharp } = await import('sharp');
  // Ảnh trong suốt lớn (nhiễu ở kênh màu, alpha = 0) để chắc chắn phải nén.
  const size = 1400;
  const raw = Buffer.alloc(size * size * 4);
  for (let i = 0; i < raw.length; i += 4) { raw[i] = Math.random() * 255; raw[i + 1] = Math.random() * 255; raw[i + 2] = Math.random() * 255; raw[i + 3] = 0; }
  const png = await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  const fitted = await fitImageForPancake({ buffer: png, filename: 'trong.png', mime: 'image/png' });
  const { data, info } = await sharp(fitted.buffer).raw().toBuffer({ resolveWithObject: true });
  const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  assert.ok(data[center] > 240 && data[center + 1] > 240 && data[center + 2] > 240, `điểm giữa phải trắng, được ${data[center]},${data[center + 1]},${data[center + 2]}`);
});

test('khách bấm quảng cáo (ad_click) và thẻ địa chỉ: không còn "[Tệp đính kèm]"', () => {
  const [ad] = normalizePancakeWebhook(incoming({ message: {
    id: 'ad-2569343113366', message: '<div></div>', original_message: '',
    attachments: [{ type: 'ad_click', ad_id: '120248317644700132', click_from: 'facebook', url: 'https://www.facebook.com/1757513331967555', post_attachments: [{ description: 'Săn deal hời\nGiảm sâu hôm nay', type: 'video_direct_response', url: 'https://content.pancake.vn/ad.jpg' }] }]
  } }), config);
  assert.equal(ad.message.type, 'ad');
  assert.equal(ad.message.text, 'Khách bấm vào quảng cáo: «Săn deal hời»');
  assert.deepEqual(ad.pancake.ad, { adId: '120248317644700132', postId: '1757513331967555', adTitle: 'Săn deal hời', photoUrl: 'https://content.pancake.vn/ad.jpg' });
  const [address] = normalizePancakeWebhook(incoming({ message: {
    id: 'm_addr', message: '', original_message: '',
    attachments: [{ type: 'address', address: '161 Bình tiến', full_address: '161 Bình tiến, Xã Bắc Bình, Lâm Đồng' }]
  } }), config);
  assert.equal(address.message.type, 'text');
  assert.equal(address.message.text, '161 Bình tiến, Xã Bắc Bình, Lâm Đồng');
});

test('Facebook từ chối tệp vừa tải (invalid_upload_fb_attachments_result): tải lại, gửi thêm một lần; lỗi nêu bằng tiếng Việt', async () => {
  const { sendConversationMessageViaPancake } = await import('../app/pancake.mjs');
  const calls = [];
  let rejectSends = 1;
  const fetchMock = async (url, options = {}) => {
    const address = String(url);
    if (address.includes('/upload_contents')) {
      calls.push('upload');
      return { ok: true, status: 200, json: async () => ({ success: true, id: `c${calls.length}` }) };
    }
    if (address.includes('/messages')) {
      calls.push(`send:${JSON.parse(options.body).content_ids.join(',')}`);
      if (rejectSends-- > 0) return { ok: true, status: 200, json: async () => ({ success: false, message_code: 'invalid_upload_fb_attachments_result' }) };
      return { ok: true, status: 200, json: async () => ({ success: true, id: 'm_ok' }) };
    }
    throw new Error(`gọi lạ: ${address}`);
  };
  const conversation = { pageId: '110', psid: '555', pancakeConversationId: '110_555' };
  const sent = await sendConversationMessageViaPancake(conversation, { attachment: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', name: 'phieu-don-1.png', type: 'image' } }, config, fetchMock);
  assert.equal(sent.message.mid, 'm_ok');
  assert.deepEqual(calls, ['upload', 'send:c1', 'upload', 'send:c3'], 'lần hai tải tệp mới rồi gửi lại');
  rejectSends = 5;
  await assert.rejects(
    sendConversationMessageViaPancake(conversation, { attachment: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', name: 'phieu.png', type: 'image' } }, config, fetchMock),
    /Facebook từ chối ảnh vừa tải lên/
  );
});

test('khách "Trả lời" một tin (replied_message): ghi replyTo để hộp thư vẽ trích dẫn; trả lời tin của Page thì tên là "Bạn"', () => {
  const quoted = { id: 'm_addr', message: '<div>Thư, 55 Hùng Vương, tp Trà Vinh. 0939434123</div>', from: { id: '555', name: 'Chị Mai' }, attachments: [], type: 'replied_message' };
  const [own] = normalizePancakeWebhook(incoming({ message: { id: 'm_dot', message: '<div>.</div>', original_message: '', attachments: [quoted] } }), config);
  assert.equal(own.message.type, 'text');
  assert.equal(own.message.text, '.');
  assert.deepEqual(own.message.replyTo, { id: 'm_addr', name: 'Chị Mai', text: 'Thư, 55 Hùng Vương, tp Trà Vinh. 0939434123' });
  const [page] = normalizePancakeWebhook(incoming({ message: { id: 'm_ok', message: '<div>Ok</div>', original_message: '', attachments: [{ ...quoted, id: 'm_bot', from: { id: '110', name: 'Test' }, message: '<div>Dạ em xác nhận đơn ạ</div>' }] } }), config);
  assert.deepEqual(page.message.replyTo, { id: 'm_bot', name: 'Bạn', text: 'Dạ em xác nhận đơn ạ' });
});
