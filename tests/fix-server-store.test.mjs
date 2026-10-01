// Kho hội thoại + webhook (01/10): gom nhóm giới tính một lượt, JSON gọn, webhook Pancake / trạng thái Meta
// ghi gộp, bộ nhớ đệm có giới hạn, ghi chú nội bộ của bot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('fix-server-store-');
const storePath = path.join(directory, 'meta-conversations.json');
process.env.META_CONVERSATIONS_PATH = storePath;
process.env.FOLLOW_UPS_PATH = path.join(directory, 'follow-ups.json');
process.env.MESSAGING_STORE_FLUSH_MS = '50';
writeFileSync(storePath, JSON.stringify({ conversations: [], messages: {}, commentIndex: {} }));

const store = await import('../app/messaging-store.mjs');
const { handlePancakeWebhook, fetchPancakeAds, pancakeAdCacheSize, rememberPancakeAd } = await import('../app/pancake.mjs');
const { processWebhookPayload, logProfileMiss, loggedProfileMissCount } = await import('../app/meta-webhook.mjs');
const { createStaffNoteWriter, BOT_NOTE_AUTHOR } = await import('../app/server-helpers.mjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('#6 giới tính: gom nhóm một lượt cho kết quả y như gọi reconcileCustomerGender cho từng hội thoại; "123" và 123 là hai khách', () => {
  const sources = ['', 'name', 'message', 'pancake', 'staff'];
  let seed = 7;
  const random = count => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % count; };
  const build = () => {
    seed = 7;
    const conversations = [];
    for (let index = 0; index < 400; index += 1) {
      const source = sources[random(sources.length)];
      conversations.push({
        id: `c${index}`,
        pageId: random(3) === 0 ? 123 : '123',
        psid: String(random(60)),
        ...(source ? { gender: random(2) ? 'male' : 'female', genderSource: source } : {})
      });
    }
    conversations.push({ id: 'nopsid', pageId: '123', psid: '' }, { id: 'nopsid2', pageId: '123', psid: '', gender: 'male', genderSource: 'staff' });
    return { conversations, messages: {} };
  };
  const old = build();
  for (const conversation of old.conversations) store.reconcileCustomerGender(old, conversation);
  const fresh = build();
  store.reconcileAllCustomerGenders(fresh);
  assert.deepEqual(fresh.conversations, old.conversations);
  // Khoá so === như bản cũ: pageId số và chuỗi không gộp.
  const split = { conversations: [
    { id: 'a', pageId: 123, psid: '1', gender: 'male', genderSource: 'staff' },
    { id: 'b', pageId: '123', psid: '1' },
    { id: 'c', pageId: '123', psid: '1', gender: 'female', genderSource: 'name' }
  ] };
  store.reconcileAllCustomerGenders(split);
  assert.deepEqual(split.conversations.map(item => item.gender), ['male', 'female', 'female']);
});

test('#5 kho ghi JSON gọn; #4 webhook Pancake ghi gộp (trả về trước khi ghi đĩa, bot vẫn thấy tin ngay)', async () => {
  const before = statSync(storePath).mtimeMs;
  const seen = [];
  const summary = await handlePancakeWebhook({
    page_id: '110', event_type: 'messaging',
    data: {
      conversation: { id: '110_555', type: 'INBOX', from: { id: '555', name: 'Chị Mai' }, assignee_ids: [] },
      message: { id: 'm_fix1', conversation_id: '110_555', page_id: '110', type: 'INBOX', message: 'Xin chào', inserted_at: '2026-09-19T02:30:00.000000', from: { id: '555', name: 'Chị Mai' }, attachments: [] }
    }
  }, {
    processChatbotChanges: async changes => { seen.push(...changes); },
    chatbotDependencies: {},
    config: { pageId: '110', pageName: 'Test', pageAccessToken: 'pat', webhookToken: 'hook', apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false },
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) })
  });
  assert.equal(summary.stored, 1);
  assert.equal(seen.length, 1, 'bot nhận tin');
  assert.equal((await store.listMessages('110:555')).length, 1, 'đọc trong tiến trình thấy ngay');
  assert.equal(store.messagingStoreHasPendingWrites(), true, 'chưa ghi đĩa ngay');
  assert.equal(statSync(storePath).mtimeMs, before);
  await store.flushMessagingStore();
  const text = readFileSync(storePath, 'utf8');
  assert.equal(text, JSON.stringify(await store.readMessagingStore()), 'tệp là JSON gọn');
  assert.equal(JSON.parse(text).messages['110:555'].length, 1);
});

test('#4 webhook Meta chỉ có trạng thái đã giao/đã xem: không có tin nào đổi thì không ghi; có đổi thì ghi gộp', async () => {
  await store.flushMessagingStore();
  const before = statSync(storePath).mtimeMs;
  const delivery = (watermark, psid = '999') => ({ object: 'page', entry: [{ id: 'p1', time: watermark, messaging: [{ sender: { id: psid }, recipient: { id: 'p1' }, timestamp: watermark, delivery: { watermark } }] }] });
  await processWebhookPayload(delivery(Date.now()));
  assert.equal(store.messagingStoreHasPendingWrites(), false, 'hội thoại không tồn tại: không đổi, không ghi');
  // Tin gửi đi của Page rồi gói "đã giao": đổi trạng thái, ghi gộp.
  await store.updateMessagingStore(value => store.saveMessage(value, { pageId: 'p1', psid: '999', message: { id: 'out1', mid: 'out1', direction: 'outgoing', type: 'text', text: 'hi', createdAt: Date.now() - 1000, status: 'sent' } }));
  const afterSend = statSync(storePath).mtimeMs;
  assert.notEqual(afterSend, before);
  await processWebhookPayload(delivery(Date.now()));
  assert.equal(store.messagingStoreHasPendingWrites(), true, 'trạng thái đổi → chờ ghi gộp');
  assert.equal((await store.listMessages('p1:999'))[0].status, 'delivered');
  await wait(400);
  assert.equal(store.messagingStoreHasPendingWrites(), false, 'ghi gộp đã chạy');
});

test('#14 bộ nhớ đệm có giới hạn: quảng cáo Pancake ≤ 2000 mục, lý do lỗi ảnh ≤ 200', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [{ id: 'ad-real', name: 'QC Xanh' }] }) });
  const config = { pageId: '110', pageAccessToken: 'pat', apiBase: 'https://pages.fm/api/public_api' };
  const fetched = await fetchPancakeAds(['ad-real', 'ad-missing'], config, fetchImpl);
  assert.equal(fetched['ad-real'].name, 'QC Xanh');
  assert.equal(fetched['ad-missing'].name, '');
  // Đường ghi của fetchPancakeAds (gọi API thật mỗi 20 mã thì chậm): ghi thẳng 2.300 mục.
  for (let index = 0; index < 2300; index += 1) rememberPancakeAd(`ad${index}`, { at: Date.now(), name: '', imageUrl: '', campaignName: '' });
  assert.equal(pancakeAdCacheSize(), 2000);
  for (let index = 0; index < 260; index += 1) logProfileMiss('user', String(index), `lỗi ${index}`);
  assert.equal(loggedProfileMissCount(), 200);
});

test('ghi chú nội bộ của bot (addStaffNote): vào hồ sơ khách theo khoá bền, tác giả "Chatbot AI"', async () => {
  const notes = [];
  const published = [];
  const write = createStaffNoteWriter({
    findCustomerById: async id => (id === '110:555' ? { id, editKey: 'phone:912345678' } : null),
    addCustomerNote: async (key, note) => { notes.push({ key, note }); return { id: 'n1', text: note.text, by: note.author.name }; },
    onSaved: ({ conversation }) => published.push(conversation.id)
  });
  const saved = await write({ id: '110:555', pageId: '110', psid: '555' }, '  SĐT trùng đơn L1 của hội thoại khác — đối chiếu. ');
  assert.deepEqual(notes, [{ key: 'phone:912345678', note: { text: 'SĐT trùng đơn L1 của hội thoại khác — đối chiếu.', author: { ...BOT_NOTE_AUTHOR } } }]);
  assert.equal(saved.by, 'Chatbot AI');
  assert.deepEqual(published, ['110:555']);
  // Khách chưa có hồ sơ (chưa dựng danh sách) → khoá pageId:psid; ghi chú rỗng → không ghi.
  await write({ id: 'x', pageId: '1', psid: '2' }, 'ghi chú');
  assert.equal(notes.at(-1).key, '1:2');
  assert.equal(await write({ id: 'x', pageId: '1', psid: '2' }, '   '), null);
  assert.equal(notes.length, 2);
});

test('kho đọc lỗi tạm (không phải JSON hỏng) thì NÉM, không cất .corrupt-* và không coi là kho rỗng', async () => {
  // Tiến trình con: META_CONVERSATIONS_PATH trỏ vào một THƯ MỤC → readFile EISDIR (giống EACCES/EBUSY).
  const { execFileSync } = await import('node:child_process');
  const folder = path.join(tempDir('fix-server-store-dir-'), 'meta-conversations.json');
  (await import('node:fs')).mkdirSync(folder);
  const script = "const s = await import(process.argv[1]); try { await s.readMessagingStore(); console.log('read-ok'); } catch (error) { console.log('threw', error.code || ''); }";
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, new URL('../app/messaging-store.mjs', import.meta.url).href], {
    env: { ...process.env, META_CONVERSATIONS_PATH: folder, CRM_SKIP_ENV_FILE: '1' }, encoding: 'utf8'
  });
  assert.match(output, /^threw/m);
  assert.ok(existsSync(folder), 'không đổi tên/cất đi');
  assert.equal((await import('node:fs')).readdirSync(path.dirname(folder)).filter(name => name.includes('.corrupt-')).length, 0);
});
