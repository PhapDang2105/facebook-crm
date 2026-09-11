import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatbotQuery, parseModelAnswer, processChatbotChanges, requestDirectModelReply } from '../app/chatbot-engine.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

test('đọc JSON có hàng rào markdown từ mô hình', () => {
  assert.equal(parseModelAnswer('```json\n{"template_id":"WELCOME"}\n```').template_id, 'WELCOME');
  assert.equal(parseModelAnswer('không hợp lệ').template_id, 'CSKH_HANDOFF');
});

test('ngữ cảnh gửi mô hình có lịch sử và tin nhắn hiện tại', () => {
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

test('gọi Gemini trực tiếp trên Vertex AI', async () => {
  const reply = await requestDirectModelReply({
    settings: {
      provider: 'vertex',
      directApiKey: 'google-token',
      directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
      directModel: 'gemini-2.5-flash',
      systemPrompt: 'Chỉ trả JSON',
      structuredOutput: true,
      retryCount: 0,
      messageTemplates: {}
    },
    conversation: { psid: '123', name: 'Khách' },
    message: { type: 'text', text: 'xin chào' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-2.5-flash:generateContent');
      assert.equal(options.headers.Authorization, 'Bearer google-token');
      const body = JSON.parse(options.body);
      assert.equal(body.systemInstruction.parts[0].text, 'Chỉ trả JSON');
      assert.equal(body.contents[0].role, 'user');
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"template_id":"WELCOME"}' }] } }] }) };
    }
  });
  assert.equal(reply.templateId, 'WELCOME');
});

test('gọi DeepSeek trực tiếp bằng API OpenAI-compatible', async () => {
  const reply = await requestDirectModelReply({
    settings: {
      provider: 'deepseek', directApiKey: 'deepseek-token', directEndpoint: 'https://api.deepseek.com/chat/completions',
      directModel: 'deepseek-v4-flash', systemPrompt: 'Chỉ trả JSON', structuredOutput: true, retryCount: 0, messageTemplates: {}
    },
    conversation: { psid: '123', name: 'Khách' },
    message: { type: 'text', text: 'xin chào' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer deepseek-token');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'deepseek-v4-flash');
      assert.equal(body.messages[0].role, 'system');
      assert.deepEqual(body.response_format, { type: 'json_object' });
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"template_id":"WELCOME"}' } }] }) };
    }
  });
  assert.equal(reply.templateId, 'WELCOME');
});

test('gọi Claude bằng giao thức Anthropic Messages', async () => {
  const reply = await requestDirectModelReply({
    settings: {
      provider: 'custom', directProtocol: 'anthropic', directApiKey: 'anthropic-token',
      directEndpoint: 'https://api.anthropic.com/v1/messages', directModel: 'claude-sonnet-4-6',
      systemPrompt: 'Chỉ trả JSON', retryCount: 0, messageTemplates: {}
    },
    conversation: { psid: '123', name: 'Khách' },
    message: { type: 'text', text: 'xin chào' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(options.headers['x-api-key'], 'anthropic-token');
      assert.equal(options.headers['anthropic-version'], '2023-06-01');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'claude-sonnet-4-6');
      assert.equal(body.system, 'Chỉ trả JSON');
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"template_id":"WELCOME"}' }] }) };
    }
  });
  assert.equal(reply.templateId, 'WELCOME');
});

test('tắt bộ nhớ không đưa lịch sử vào câu hỏi model', () => {
  const query = buildChatbotQuery({
    conversation: { name: 'Khách' },
    message: { text: 'tin hiện tại' },
    recentMessages: [{ direction: 'incoming', text: 'tin cũ' }],
    settings: { memoryEnabled: false }
  });
  assert.doesNotMatch(query, /tin cũ/);
});

test('chỉ tự trả lời khi cả hệ thống và hội thoại đều bật bot', async () => {
  const sent = [];
  const state = [];
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', psid: 'user', name: 'Khách', botEnabled: true },
    message: { direction: 'incoming', type: 'text', text: 'xin chào' }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', provider: 'vertex', directApiKey: 'secret', handoffKeywords: '' }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => sent.push(message.text),
    saveBotState: async (_id, value) => state.push(value),
    requestReply: async () => ({ templateId: 'WELCOME', messages: ['Xin chào'], conversationId: '', handoff: false })
  });
  assert.equal(result[0].templateId, 'WELCOME');
  assert.deepEqual(sent, ['Xin chào']);
  assert.equal(state[0].botConversationId, '');
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
