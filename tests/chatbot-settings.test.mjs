import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultChatbotSettings, normalizeChatbotSettings, publicChatbotSettings } from '../app/chatbot-settings.mjs';

test('chatbot mặc định gọi Vertex AI trực tiếp và chưa hoạt động', () => {
  const settings = normalizeChatbotSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.responseMode, 'automatic');
  assert.equal(settings.name, defaultChatbotSettings.name);
  assert.equal(settings.provider, 'vertex');
  assert.equal(settings.memoryWindow, 50);
  assert.equal(settings.retryCount, 1);
  assert.equal(settings.processingSteps.length, 6);
});

test('chuẩn hóa cấu hình chatbot trước khi lưu', () => {
  const settings = normalizeChatbotSettings({
    enabled: true,
    name: '  Bot bán hàng  ',
    responseMode: 'automatic',
    directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
    apiKey: 'app-secret',
    welcomeMessage: '  Xin chào  ',
    handoffKeywords: '  gặp người thật  '
  });
  assert.deepEqual({
    enabled: settings.enabled,
    name: settings.name,
    responseMode: settings.responseMode,
    welcomeMessage: settings.welcomeMessage,
    handoffKeywords: settings.handoffKeywords
  }, {
    enabled: true,
    name: 'Bot bán hàng',
    responseMode: 'automatic',
    welcomeMessage: 'Xin chào',
    handoffKeywords: 'gặp người thật'
  });
});

test('không trả khóa API về trình duyệt', () => {
  const settings = publicChatbotSettings({ apiKey: 'app-secret' });
  assert.equal(settings.apiKeyConfigured, true);
  assert.equal(settings.directApiKeyConfigured, true);
  assert.equal('directApiKey' in settings, false);
});

test('lưu cấu hình nhà cung cấp mô hình trực tiếp', () => {
  const settings = normalizeChatbotSettings({
    provider: 'deepseek',
    directApiKey: 'deepseek-token',
    directEndpoint: 'https://api.deepseek.com/chat/completions',
    directModel: 'deepseek-v4-flash',
    systemPrompt: 'Chỉ trả JSON',
    memoryWindow: 30,
    retryCount: 2
  });
  assert.equal(settings.provider, 'deepseek');
  assert.equal(settings.directApiKey, 'deepseek-token');
  assert.equal(settings.directModel, 'deepseek-v4-flash');
  assert.equal(settings.systemPrompt, 'Chỉ trả JSON');
  assert.equal(settings.memoryWindow, 30);
  assert.equal(settings.retryCount, 2);
});

test('hỗ trợ nhà cung cấp và giao thức tùy chọn để mở rộng', () => {
  const settings = normalizeChatbotSettings({
    provider: 'custom',
    directProtocol: 'anthropic',
    directEndpoint: 'https://api.anthropic.com/v1/messages',
    directModel: 'claude-sonnet-4-6'
  });
  assert.equal(settings.provider, 'custom');
  assert.equal(settings.directProtocol, 'anthropic');
  assert.equal(settings.directEndpoint, 'https://api.anthropic.com/v1/messages');
  assert.equal(settings.directModel, 'claude-sonnet-4-6');
});

test('chuẩn hóa các nhà cung cấp model tích hợp sẵn', () => {
  const cases = [
    ['openai', 'https://api.openai.com/v1/chat/completions', 'gpt-4.1-mini', 'openai'],
    ['anthropic', 'https://api.anthropic.com/v1/messages', 'claude-sonnet-4-6', 'anthropic'],
    ['xai', 'https://api.x.ai/v1/chat/completions', 'grok-4.5', 'openai'],
    ['groq', 'https://api.groq.com/openai/v1/chat/completions', 'openai/gpt-oss-120b', 'openai'],
    ['mistral', 'https://api.mistral.ai/v1/chat/completions', 'mistral-large-latest', 'openai'],
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions', '~openai/gpt-latest', 'openai']
  ];

  for (const [provider, endpoint, model, protocol] of cases) {
    const settings = normalizeChatbotSettings({ provider });
    assert.equal(settings.provider, provider);
    assert.equal(settings.directEndpoint, endpoint);
    assert.equal(settings.directModel, model);
    assert.equal(settings.directProtocol, protocol);
  }
});

test('chuẩn hóa mẫu tin và trạng thái từng bước xử lý', () => {
  const settings = normalizeChatbotSettings({
    messageTemplates: { WELCOME: '  Xin chào mới  ' },
    deletedTemplateIds: [' XIN_LOI ', 'XIN_LOI', 'WELCOME'],
    processingSteps: [{ id: 'duplicate_guard', enabled: false, code: 'return input.signature;' }]
  });
  assert.equal(settings.messageTemplates.WELCOME, 'Xin chào mới');
  assert.deepEqual(settings.deletedTemplateIds, ['XIN_LOI', 'WELCOME']);
  assert.equal(settings.processingSteps.find(step => step.id === 'duplicate_guard').enabled, false);
  assert.equal(settings.processingSteps.find(step => step.id === 'duplicate_guard').code, 'return input.signature;');
  assert.equal(settings.processingSteps.find(step => step.id === 'message_normalizer').enabled, true);
  assert.match(settings.processingSteps.find(step => step.id === 'message_normalizer').code, /trim/);
});
