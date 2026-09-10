import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatbotQuery, parseDifyAnswer, processChatbotChanges, requestDifyReply } from '../app/chatbot-engine.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

test('đọc JSON có hàng rào markdown từ Dify', () => {
  assert.equal(parseDifyAnswer('```json\n{"template_id":"WELCOME"}\n```').template_id, 'WELCOME');
  assert.equal(parseDifyAnswer('không hợp lệ').template_id, 'CSKH_HANDOFF');
});

test('ngữ cảnh gửi Dify có lịch sử và tin nhắn hiện tại', () => {
  const query = buildChatbotQuery({
    conversation: { name: 'Lan Anh' },
    message: { text: 'Túi xanh giá bao nhiêu?' },
    recentMessages: [{ direction: 'outgoing', text: 'Giọt Nắng xin chào' }],
    settings: {}
  });
  assert.match(query, /Lan Anh/);
  assert.match(query, /Giọt Nắng xin chào/);
  assert.match(query, /Túi xanh giá bao nhiêu/);
});

test('gọi Dify và chuyển template thành tin nhắn', async () => {
  const reply = await requestDifyReply({
    settings: { apiKey: 'secret', endpoint: 'https://api.dify.ai/v1/chat-messages' },
    conversation: { psid: '123', name: 'Khách' },
    message: { type: 'text', text: 'xin chào' },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer secret');
      return { ok: true, json: async () => ({ answer: '{"template_id":"WELCOME"}', conversation_id: 'dify-1' }) };
    }
  });
  assert.equal(reply.templateId, 'WELCOME');
  assert.equal(reply.conversationId, 'dify-1');
  assert.match(reply.messages[0], /Giọt Nắng xin chào/);
});

test('chỉ tự trả lời khi cả hệ thống và hội thoại đều bật bot', async () => {
  const sent = [];
  const state = [];
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', psid: 'user', name: 'Khách', botEnabled: true },
    message: { direction: 'incoming', type: 'text', text: 'xin chào' }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', apiKey: 'secret', endpoint: 'https://api.dify.ai/v1/chat-messages', handoffKeywords: '' }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => sent.push(message.text),
    saveBotState: async (_id, value) => state.push(value),
    requestReply: async () => ({ templateId: 'WELCOME', messages: ['Xin chào'], conversationId: 'dify-1', handoff: false })
  });
  assert.equal(result[0].templateId, 'WELCOME');
  assert.deepEqual(sent, ['Xin chào']);
  assert.equal(state[0].botConversationId, 'dify-1');
});

test('xác nhận đơn dùng giá nội bộ khi đủ dữ liệu', () => {
  const reply = renderChatbotReply({
    template_id: 'ORDER_CONFIRMATION',
    Product_N1: 'Túi Xanh', No_A: '2',
    Phone_Number: '0909123456', Customer_Address: 'Quận 12, TP.HCM',
    order_key: 'XANH=2'
  });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.equal(reply.order.total, 298000);
  assert.match(reply.messages[0], /298\.000đ/);
});

test('mẫu tin chỉnh trong Smax nội bộ ghi đè mẫu mặc định', () => {
  const reply = renderChatbotReply({ template_id: 'WELCOME' }, { WELCOME: 'Xin chào từ mẫu tùy chỉnh' });
  assert.deepEqual(reply.messages, ['Xin chào từ mẫu tùy chỉnh']);
});
