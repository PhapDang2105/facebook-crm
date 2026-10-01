import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import { seed } from './helpers/temp-messaging-store.mjs';

// Trạng thái bám đuổi tạm (storePancakeEvents đối chiếu tin nhân viên với lời bám đuổi): không đọc tệp thật.
process.env.FOLLOW_UPS_PATH = path.join(tempDir('staff-attr-fu-'), 'follow-ups.json');
const {
  getConversation, listMessages, markConversationSeen, maximumSeenByPerConversation, messageSenderFields, publicConversation,
  readMessagingStore, saveMessage, staffMessageFields, updateMessagingStore
} = await import('../app/messaging-store.mjs');
const { sendConversationMessageViaPancake } = await import('../app/pancake.mjs');

const config = { pageId: '110', pageName: 'Test', pageAccessToken: 'pat-1', webhookToken: 'hook-1', apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false };
let sentCount = 0;
const fetchMock = async (url, options = {}) => {
  if (String(url).includes('/conversations/110_555/messages')) {
    sentCount += 1;
    JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ success: true, id: `m_sent_${sentCount}` }) };
  }
  throw new Error(`gọi lạ: ${url}`);
};
const conversation = { id: '110:555', pageId: '110', psid: '555', pancakeConversationId: '110_555', name: 'Chị Mai' };

test('dấu người gửi: nhân viên → sender staff + họ tên/tên đăng nhập; true cũ → "CRM"; việc máy làm thay → không cờ staff; còn lại là bot', () => {
  assert.deepEqual(staffMessageFields(false), {});
  assert.deepEqual(staffMessageFields(true), { staff: true, staffName: 'CRM' });
  assert.deepEqual(staffMessageFields({ name: ' Thúy  Hằng ', username: 'hang' }), { staff: true, staffName: 'Thúy Hằng', staffUsername: 'hang' });
  assert.deepEqual(messageSenderFields({ staff: { name: 'Thúy Hằng', username: 'hang' } }), { staff: true, staffName: 'Thúy Hằng', staffUsername: 'hang', sender: 'staff' });
  assert.deepEqual(messageSenderFields({ staff: true }), { staff: true, staffName: 'CRM', sender: 'staff' });
  assert.deepEqual(messageSenderFields({ sentBy: { name: 'Lan', username: 'lan' } }), { sender: 'staff', staffName: 'Lan', staffUsername: 'lan' });
  assert.deepEqual(messageSenderFields({}), { sender: 'bot' });
});

test('tin nhân viên gửi từ CRM qua Pancake lưu staffName = họ tên, staffUsername; bản dội về của Pancake không đè tên', async () => {
  seed({ conversations: [], messages: {} });
  const sent = await sendConversationMessageViaPancake(conversation, { text: 'Dạ em chào chị', staff: { name: 'Thúy Hằng', username: 'hang' } }, config, fetchMock);
  assert.equal(sent.message.staff, true);
  assert.equal(sent.message.staffName, 'Thúy Hằng');
  assert.equal(sent.message.staffUsername, 'hang');
  assert.equal(sent.message.sender, 'staff');
  // Pancake dội lại tin (admin_name là tài khoản Pancake chung) → gộp vào cùng tin.
  await updateMessagingStore(store => saveMessage(store, {
    pageId: '110', psid: '555',
    message: { id: sent.message.id, mid: sent.message.id, direction: 'outgoing', type: 'text', text: 'Dạ em chào chị', createdAt: Date.now(), status: 'sent', staff: true, staffName: 'Giọt Nắng Admin' }
  }));
  const [stored] = (await listMessages('110:555', 10)).filter(item => item.id === sent.message.id);
  assert.deepEqual([stored.staffName, stored.staffUsername, stored.sender, stored.staff], ['Thúy Hằng', 'hang', 'staff', true]);
});

test('tin bot / bám đuổi mang sender bot; phiếu đơn nhân viên bấm gửi mang tên người bấm mà KHÔNG có cờ staff (bot không nhường)', async () => {
  seed({ conversations: [], messages: {} });
  const bot = await sendConversationMessageViaPancake(conversation, { text: 'Dạ shop chào chị ạ' }, config, fetchMock);
  assert.deepEqual([bot.message.sender, bot.message.staff, bot.message.staffName], ['bot', undefined, undefined]);
  const followUp = await sendConversationMessageViaPancake(conversation, { text: 'Chị ơi ưu đãi riêng', followUp: true }, config, fetchMock);
  assert.deepEqual([followUp.message.sender, followUp.message.followUp], ['bot', true]);
  const receipt = await sendConversationMessageViaPancake(conversation, { text: 'Phiếu đơn', sentBy: { name: 'Lan', username: 'lan' } }, config, fetchMock);
  assert.deepEqual([receipt.message.sender, receipt.message.staffName, receipt.message.staffUsername, receipt.message.staff], ['staff', 'Lan', 'lan', undefined]);
  await updateMessagingStore(store => saveMessage(store, {
    pageId: '110', psid: '555',
    message: { id: receipt.message.id, mid: receipt.message.id, direction: 'outgoing', type: 'text', text: 'Phiếu đơn', createdAt: Date.now(), status: 'sent' }
  }));
  const [stored] = (await listMessages('110:555', 10)).filter(item => item.id === receipt.message.id);
  assert.equal(stored.staff, undefined, 'bản dội về không thêm cờ staff');
  assert.equal(stored.sender, 'staff');
});

test('Pancake: phân công đổi → nhật ký conversation.assign (tên người); nhân viên nhắn trong Pancake → conversation.bot tắt (người làm system)', async () => {
  const { normalizePancakeWebhook, storePancakeEvents } = await import('../app/pancake.mjs');
  const { flushAudit, queryAudit } = await import('../app/audit-log.mjs');
  seed({ conversations: [], messages: {} });
  const payload = (id, conversationExtra, message = {}) => ({
    page_id: '110', event_type: 'messaging',
    data: {
      conversation: { id: '110_555', type: 'INBOX', from: { id: '555', name: 'Chị Mai' }, ...conversationExtra },
      message: { id, conversation_id: '110_555', page_id: '110', type: 'INBOX', message: 'Shop ơi', inserted_at: new Date().toISOString().replace('Z', ''), from: { id: '555', name: 'Chị Mai' }, attachments: [], ...message }
    }
  });
  await storePancakeEvents(normalizePancakeWebhook(payload('a1', { assignee_ids: [] }), config), { fromWebhook: true });
  await storePancakeEvents(normalizePancakeWebhook(payload('a2', { assignee_ids: ['u1'], current_assign_users: [{ id: 'u1', name: 'Thúy Hằng' }] }), config), { fromWebhook: true });
  // Gói không kèm danh sách phân công: không ghi nhầm "bỏ phân công".
  await storePancakeEvents(normalizePancakeWebhook(payload('a3', {}), config), { fromWebhook: true });
  // Nhân viên gõ trả lời trong Pancake (tin của Page, admin_name là người thật) → bot tự tắt.
  await storePancakeEvents(normalizePancakeWebhook(payload('a4', { assignee_ids: ['u1'], current_assign_users: [{ id: 'u1', name: 'Thúy Hằng' }] }, { from: { id: '110', name: 'Test', admin_name: 'Thúy Hằng' }, message: 'Dạ em đây ạ' }), config), { fromWebhook: true });
  await flushAudit();
  const { items } = await queryAudit({ conversationId: '110:555' });
  const assign = items.filter(item => item.action === 'conversation.assign');
  assert.equal(assign.length, 1);
  assert.deepEqual([assign[0].actor, assign[0].details], ['system', { from: '', to: 'Thúy Hằng' }]);
  const bot = items.filter(item => item.action === 'conversation.bot');
  assert.equal(bot.length, 1);
  assert.deepEqual([bot[0].actor, bot[0].details], ['system', { enabled: false }]);
  assert.match(bot[0].summary, /Thúy Hằng nhắn trong Pancake/);
});

test('ghi chú / sửa / gắn thẻ khách mang người làm: author thắng tên gõ tay; updatedBy', async () => {
  const { addCustomerNote, listCustomerNotes, setCustomerLabels, updateCustomerProfile } = await import('../app/customer-edits.mjs');
  const note = await addCustomerNote('phone:0909123456', { text: 'Khách hẹn chiều gọi', by: 'ai đó', author: { username: 'hang', name: 'Thúy Hằng' } }, 1000);
  assert.deepEqual([note.by, note.author], ['Thúy Hằng', { username: 'hang', name: 'Thúy Hằng' }]);
  const legacy = await addCustomerNote('phone:0909123456', { text: 'Ghi chú cũ', by: 'Lan' }, 2000);
  assert.deepEqual([legacy.by, legacy.author], ['Lan', undefined], 'chưa bật đăng nhập: giữ tên gõ tay');
  assert.equal((await listCustomerNotes('phone:0909123456'))[1].author.username, 'hang');
  const profile = await updateCustomerProfile('phone:0909123456', { name: 'Chị Mai' }, 3000, { by: { username: 'hang', name: 'Thúy Hằng' } });
  assert.deepEqual(profile.updatedBy, { username: 'hang', name: 'Thúy Hằng' });
  await setCustomerLabels('phone:0909123456', ['vip'], [], 4000, { by: { username: 'lan', name: 'Lan' } });
});

test('seenBy: người đã đăng nhập mở/đọc hội thoại → { [username]: { name, at } }, mốc mới nhất, tối đa 30 người; chưa đăng nhập thì không ghi', async () => {
  seed({ conversations: [{ id: '110:555', pageId: '110', psid: '555', name: 'Chị Mai', source: 'inbox' }], messages: { '110:555': [] } });
  assert.equal(await updateMessagingStore(store => markConversationSeen(store, '110:555', { username: '', name: 'Không đăng nhập' })), null);
  assert.equal(publicConversation(await getConversation('110:555')).seenBy, undefined, 'chưa ai xem: không có seenBy');
  await updateMessagingStore(store => markConversationSeen(store, '110:555', { username: 'hang', name: 'Thúy Hằng', at: 1000 }));
  await updateMessagingStore(store => markConversationSeen(store, '110:555', { username: 'lan', name: 'Lan', at: 2000 }));
  await updateMessagingStore(store => markConversationSeen(store, '110:555', { username: 'hang', name: 'Thúy Hằng', at: 3000 }));
  const seenBy = publicConversation(await getConversation('110:555')).seenBy;
  assert.deepEqual(seenBy, { hang: { name: 'Thúy Hằng', at: 3000 }, lan: { name: 'Lan', at: 2000 } });
  assert.equal(await updateMessagingStore(store => markConversationSeen(store, 'khong-co', { username: 'hang', at: 1 })), null);
  for (let index = 0; index < 40; index += 1) await updateMessagingStore(store => markConversationSeen(store, '110:555', { username: `nv${index}`, name: `NV ${index}`, at: 10000 + index }));
  const crowded = (await readMessagingStore()).conversations.find(item => item.id === '110:555').seenBy;
  assert.equal(Object.keys(crowded).length, maximumSeenByPerConversation);
  assert.ok(crowded.nv39 && !crowded.hang, 'giữ người xem gần nhất, bỏ người xem lâu nhất');
});
