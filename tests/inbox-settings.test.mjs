import './helpers/seed-catalog.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultConversationLabels,
  labelSlug,
  labelsForEvents,
  normalizeConversationLabels,
  normalizeInboxSettings,
  normalizeQuickReplies
} from '../app/inbox-settings.mjs';
import { isComplaint } from '../app/processing/auto-label.mjs';
import { processChatbotChanges } from '../app/chatbot-engine.mjs';

test('thẻ mặc định là bộ thẻ của Pancake, giữ id customer/consulting', () => {
  const ids = defaultConversationLabels.map(label => label.id);
  assert.ok(ids.includes('customer') && ids.includes('consulting'));
  assert.ok(!ids.includes('new'));
  assert.equal(defaultConversationLabels.find(label => label.id === 'customer').name, 'Đã mua hàng');
  assert.equal(defaultConversationLabels.length, 11, "8 thẻ Pancake + Đổi sản phẩm + Hủy đơn + Bám đuổi");
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
  assert.equal(settings.labels.length, 11);
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
  assert.deepEqual(state[0].addLabelEvents, ['handoff']);
});

test('mỗi sự kiện chỉ gắn cho một thẻ, thẻ nào nhận sự kiện nào là do nhân viên chọn', () => {
  const labels = normalizeConversationLabels([
    { name: 'Đã mua hàng', auto: 'order' },
    { name: 'Khách quen', auto: 'order' },
    { name: 'Cần người xử lý', auto: 'handoff' },
    { name: 'Khiếu nại', auto: 'khong-co-su-kien-nay' }
  ]);
  assert.deepEqual(labels.map(label => label.auto), ['order', '', 'handoff', '']);
  assert.deepEqual(labelsForEvents(labels, ['order', 'handoff', 'complaint']), ['da-mua-hang', 'can-nguoi-xu-ly']);
  assert.deepEqual(labelsForEvents(labels, []), []);
});

test('nhận diện khiếu nại theo cụm từ, không bắt nhầm câu hỏi thường', () => {
  for (const text of [
    'dầu bị hôi dầu rồi shop ơi',
    'Gói granola nhận về bị ẩm hết',
    'shop giao sai hàng cho mình nhé',
    'mình muốn hoàn tiền',
    'giao chậm quá mình chưa nhận được hàng'
  ]) assert.equal(isComplaint({ text }), true, text);
  for (const text of [
    'shop còn hàng không ạ',
    'shop có ship về Cần Thơ không',
    'cho em hỏi túi xanh bao nhiêu',
    'iu shop nhiều lắm',
    'cho chị 2 túi granola'
  ]) assert.equal(isComplaint({ text }), false, text);
  assert.equal(isComplaint({ text: 'ok shop', templateId: 'OIL_SMELL_WARRANTY' }), true);
  assert.equal(isComplaint({ text: 'hàng lỗi', keywords: '' }), false);
});

test('thẻ mặc định mới và sự kiện tự động mới được bổ sung vào bộ thẻ nhân viên đang dùng, không đè lựa chọn cũ', async () => {
  const { mergeDefaultLabels } = await import('../app/inbox-settings.mjs');
  const { autoLabelEventsFor } = await import('../app/processing/auto-label.mjs');
  const merged = mergeDefaultLabels([
    { id: 'consulting', name: 'Cần người xử lý', color: '#8f7ad0', icon: 'person-raising-hand', auto: 'handoff' },
    { id: 'warranty', name: 'Bảo hành', color: '#d9866f', icon: 'hammer-and-wrench', auto: '' },
    { id: 'customer', name: 'Đã mua hàng', color: '#5fa871', icon: 'shopping-bags', auto: 'order' },
    { id: 'vip', name: 'VIP', color: '#c79a2c', icon: 'crown', auto: 'livestream' }
  ]);
  const byId = Object.fromEntries(merged.map(label => [label.id, label]));
  assert.equal(byId.exchange?.auto, 'update', 'thẻ Đổi sản phẩm thêm mới');
  assert.equal(byId.cancelled?.auto, 'cancel', 'thẻ Hủy đơn thêm mới');
  assert.equal(byId.warranty.auto, 'warranty', 'thẻ Bảo hành có sẵn được gắn sự kiện');
  assert.equal(byId.vip.auto, 'livestream', 'nhân viên đã gắn livestream cho VIP thì giữ');
  assert.equal(byId.livestream, undefined, 'không thêm thẻ Livestream mặc định vì sự kiện đã có thẻ khác');
  // Sự kiện phát ra từ ngữ cảnh.
  assert.deepEqual(autoLabelEventsFor({ updated: true, livestream: true }), ['update', 'livestream']);
  assert.deepEqual(autoLabelEventsFor({ cancelled: true }), ['cancel']);
  assert.deepEqual(autoLabelEventsFor({ text: 'Bên mình có bảo hành không, túi bị mốc' }), ['complaint', 'warranty']);
  assert.deepEqual(autoLabelEventsFor({ text: 'Em muốn lấy sỉ về bán' }), ['wholesale']);
  assert.deepEqual(autoLabelEventsFor({ templateId: 'WHOLESALE_CTV_CONTACT' }), ['wholesale']);
  assert.deepEqual(autoLabelEventsFor({ order: { id: 'x', phoneWarning: { level: 'high' } } }), ['order', 'handoff', 'bad']);
  assert.deepEqual(autoLabelEventsFor({ order: { id: 'x', phoneWarning: { level: 'watch' } } }), ['order']);
});
