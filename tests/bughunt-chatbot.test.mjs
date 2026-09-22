import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { parseModelAnswer, processChatbotChanges } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';

const templates = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const fullAddress = '176/1A KP1, An Phú Đông, Quận 12, TP.HCM';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('mô hình trả JSON không phải object (null, mảng): không văng lỗi, gửi bảng giá chung', () => {
  assert.equal(parseModelAnswer('null').template_id, 'GENERAL_INFO');
  assert.equal(parseModelAnswer('[{"template_id":"WELCOME"}]').template_id, 'GENERAL_INFO');
  assert.equal(parseModelAnswer('"WELCOME"').template_id, 'GENERAL_INFO');
  assert.equal(renderChatbotReply(parseModelAnswer('null'), templates).templateId, 'GENERAL_INFO');
});

test('gợi ý 2 túi: miễn ship không bị lặp thành quà tặng ("miễn phí vận chuyển, tặng Miễn phí vận chuyển")', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '1' }, templates, { customer: { gender: 'female' } });
  assert.equal(reply.templateId, 'ORDER_ADDRESS');
  assert.match(reply.messages[1], /miễn phí vận chuyển/);
  assert.doesNotMatch(reply.messages[1], /tặng Miễn phí vận chuyển/);
  assert.equal((reply.messages[1].match(/miễn phí vận chuyển/gi) || []).length, 1);
});

test('gợi ý 2 túi chỉ một lần cho mỗi giỏ, kể cả khi bot phải hỏi thông tin tới lần thứ ba', () => {
  const first = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '1' }, templates, { customer: { gender: 'female' } });
  assert.equal(first.pendingOrder.upsold, true);
  const second = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Phone_Number: '0909123456' }, templates, { customer: { gender: 'female' }, pendingOrder: first.pendingOrder });
  assert.equal(second.messages.length, 1);
  assert.equal(second.pendingOrder.upsold, true, 'cờ đã gợi ý phải đi theo giỏ');
  const third = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Customer_Address: 'Quận 12' }, templates, { customer: { gender: 'female' }, pendingOrder: second.pendingOrder });
  assert.equal(third.messages.length, 1, 'không gợi ý lại lần ba');
});

test('đã hỏi một lần, khách trả lời địa chỉ có "xã" (chữ có dấu ở cuối từ): vẫn được nhận như "huyện"/"phường"', () => {
  const pending = { items: [{ product: 'Túi Xanh', quantity: 2 }], key: 'GRA-XANH-Z450=2', at: Date.now(), phone: '0909123456', address: 'Long An', addressAsks: 1 };
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Customer_Address: 'ấp 3, xã Abcxyz, Long An' }, templates, { pendingOrder: pending });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.match(reply.order.address, /xã Abcxyz/);
});

test('đang xin SĐT/địa chỉ mà khách đổi sang số lượng không tính được giá: hỏi vị/số lượng, không chốt giỏ cũ', () => {
  const pending = { items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }], key: 'GRA-XANH-Z450=1', at: Date.now(), phone: '', address: '', addressAsks: 0 };
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Xanh', No_A: '5', Phone_Number: '0909123456' }, templates, { pendingOrder: pending });
  assert.equal(reply.templateId, 'ASK_FLAVOR');
  assert.equal(reply.order, undefined);
  assert.equal(reply.pendingOrder.phone, '0909123456', 'SĐT vừa gửi vẫn được giữ');
  // Khách trả lời xong số lượng hợp lệ thì tiếp tục xin địa chỉ với giỏ mới.
  const next = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Xanh', No_A: '3' }, templates, { pendingOrder: reply.pendingOrder });
  assert.equal(next.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(next.pendingOrder.items.map(item => item.quantity), [3]);
});

test('bot vừa hỏi số túi/SĐT: khách trả lời "1" không bị hiểu là xin bảng giá', async () => {
  const log = [];
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: {
      id: 'page:one', psid: 'one', name: 'Khách', botEnabled: true, botLastTemplateId: 'ORDER_ADDRESS',
      pendingOrder: { items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }], key: 'GRA-XANH-Z450=1', at: Date.now(), phone: '', address: '' },
      post: { message: 'GRANOLA TÚI XANH 450g giòn rụm' }
    },
    message: { id: 'mid.one.1', mid: 'mid.one.1', direction: 'incoming', type: 'text', text: '1' }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 0, messageTemplates: templates }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => { log.push(message.text || '[ảnh]'); return { message: { mid: 'mid.bot' } }; },
    saveBotState: async () => {},
    requestReply: async () => ({ templateId: 'ORDER_ADDRESS', messages: ['Dạ cho em xin địa chỉ ạ'], handoff: false })
  });
  assert.equal(result[0].templateId, 'ORDER_ADDRESS');
  assert.deepEqual(log, ['Dạ cho em xin địa chỉ ạ']);
});

test('tin riêng đã gửi trong 24 giờ chỉ khác khoảng trắng: vẫn tính là đã gửi, không nhắn riêng lại', async () => {
  const log = [];
  const privateText = 'Dạ em thấy anh/chị để lại bình luận ạ\n\nDạ nhà em có 3 vị ạ';
  const inboxMessages = [{ id: 'p1', direction: 'outgoing', type: 'text', text: privateText.replace('\n\n', ' \n\n '), createdAt: Date.now() - 60000 }];
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:comment:c2:p1', pageId: 'page', psid: 'user', source: 'comment', name: 'Tiên', botEnabled: true },
    message: { id: 'c2', mid: 'c2', direction: 'incoming', type: 'text', text: 'combo đó mấy gói em', createdAt: Date.now() }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', messageTemplates: { ...templates, COMMENT_PRIVATE_REPLY: 'Dạ em thấy {title} để lại bình luận ạ', COMMENT_PUBLIC_REPLY: 'Dạ em vừa ib cho mình rồi ạ', COMMENT_PUBLIC_REPEAT: 'Dạ em đã gửi trong tin nhắn rồi ạ' } }),
    listMessages: async id => (id === 'page:user' ? inboxMessages : []),
    getConversation: async id => (id === 'page:user' ? { id: 'page:user', pageId: 'page', psid: 'user', botEnabled: true } : null),
    saveBotState: async () => {},
    sendMessage: async (_conversation, message) => { log.push(`${message.privateReply ? 'riêng' : 'công khai'}:${message.text}`); return { message: { mid: 'm' } }; },
    requestReply: async () => ({ templateId: 'GENERAL_INFO', messages: ['Dạ nhà em có 3 vị ạ'], handoff: false })
  });
  assert.equal(result[0].privateSkipped, true);
  assert.deepEqual(log, ['công khai:Dạ em đã gửi trong tin nhắn rồi ạ']);
});

test('hẹn chạy lại sau khi hết hạn mức: lúc chạy lại bot đã bị tắt trong Cài đặt thì không trả lời', async () => {
  const log = [];
  let enabled = true;
  let failures = 1;
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:off', psid: 'off', name: 'Khách', botEnabled: true },
    message: { id: 'mid.off.1', mid: 'mid.off.1', direction: 'incoming', type: 'text', text: 'giá sao', createdAt: 1000 }
  }], {
    readSettings: async () => ({ enabled, responseMode: 'automatic', handoffKeywords: '', capacityRetryDelayMs: 30 }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => { log.push(`send:${message.text}`); return { message: { mid: 'mid.bot' } }; },
    saveBotState: async () => {},
    requestReply: async () => {
      if (failures-- > 0) throw Object.assign(new Error('Resource exhausted'), { status: 429 });
      return { templateId: 'WELCOME', messages: ['Dạ em đây ạ'], handoff: false };
    }
  });
  assert.equal(result[0].retryLater, true);
  enabled = false;
  await wait(120);
  assert.deepEqual(log, [], 'bot đã tắt thì lần chạy lại không gửi gì');
});
