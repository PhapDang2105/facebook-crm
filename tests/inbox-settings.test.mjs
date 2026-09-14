import './helpers/seed-catalog.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultConversationLabels,
  labelSlug,
  normalizeConversationLabels,
  normalizeInboxSettings,
  normalizeQuickReplies
} from '../app/inbox-settings.mjs';
import { processChatbotChanges } from '../app/chatbot-engine.mjs';

test('thẻ mặc định là bộ thẻ của Pancake, giữ id customer/consulting', () => {
  const ids = defaultConversationLabels.map(label => label.id);
  assert.ok(ids.includes('customer') && ids.includes('consulting'));
  assert.ok(!ids.includes('new'));
  assert.equal(defaultConversationLabels.find(label => label.id === 'customer').name, 'Đã mua hàng');
  assert.equal(defaultConversationLabels.length, 8);
});

test('tên thẻ tiếng Việt thành id ổn định, trùng tên thì tự thêm hậu tố', () => {
  assert.equal(labelSlug('Cần người xử lý'), 'can-nguoi-xu-ly');
  assert.equal(labelSlug('Giao J&T'), 'giao-j-t');
  const labels = normalizeConversationLabels([
    { name: 'Khách sỉ', color: '#CF9DE0' },
    { name: 'Khách sỉ', color: 'not-a-colour' },
    { name: '   ' },
    { id: 'customer', name: 'Đã mua hàng', color: '#e3d69b' }
  ]);
  assert.deepEqual(labels.map(label => label.id), ['khach-si', 'khach-si-2', 'customer']);
  assert.equal(labels[0].color, '#cf9de0');
  assert.equal(labels[1].color, '#6b7280');
  assert.equal(labels[0].icon, '');
});

test('mẫu trả lời nhanh: ký tự tắt không dấu cách, ảnh tải lên được lưu qua storeImage', async () => {
  const stored = [];
  const replies = await normalizeQuickReplies([
    { shortcut: '/ CB 2', text: 'Dạ em gửi {title} bảng giá combo 2 túi ạ', images: ['data:image/png;base64,AAAA', '/product-images/old-1.png', 'https://evil/x.png'] },
    { shortcut: '', text: '' },
    { id: 'qr-only-image', shortcut: 'ANH', text: '', images: ['/product-images/anh-1.jpg'] }
  ], async (dataUrl, id) => {
    stored.push({ dataUrl, id });
    return `/product-images/${id}-1.png`;
  });
  assert.equal(replies.length, 2);
  assert.equal(replies[0].shortcut, 'CB2');
  assert.match(replies[0].id, /^qr-/);
  assert.deepEqual(replies[0].images, [`/product-images/quick-${replies[0].id}-1.png`, '/product-images/old-1.png']);
  assert.equal(stored.length, 1);
  assert.deepEqual(replies[1], { id: 'qr-only-image', shortcut: 'ANH', text: '', images: ['/product-images/anh-1.jpg'] });
});

test('xóa hết thẻ thì quay về bộ mặc định', async () => {
  const settings = await normalizeInboxSettings({ labels: [], quickReplies: null });
  assert.equal(settings.labels.length, 8);
  assert.deepEqual(settings.quickReplies, []);
});

test('bot gắn thẻ Cần người xử lý khi chuyển nhân viên và Đã mua hàng khi chốt đơn', async () => {
  const state = [];
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', psid: 'user', name: 'Khách' },
    message: { direction: 'incoming', type: 'text', text: 'gặp nhân viên' }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '' }),
    listMessages: async () => [],
    sendMessage: async () => {},
    saveBotState: async (_id, value) => state.push(value),
    requestReply: async () => ({ templateId: 'CSKH_HANDOFF', messages: ['Em chuyển nhân viên ạ'], conversationId: '', handoff: true })
  });
  assert.equal(state[0].botEnabled, false);
  assert.deepEqual(state[0].addLabels, ['consulting']);
});
