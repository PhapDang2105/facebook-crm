import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultChatbotSettings, normalizeChatbotSettings, publicChatbotSettings } from '../app/chatbot-settings.mjs';

test('chatbot mặc định ở chế độ gợi ý và chưa hoạt động', () => {
  const settings = normalizeChatbotSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.responseMode, 'draft');
  assert.equal(settings.name, defaultChatbotSettings.name);
  assert.equal(settings.processingSteps.length, 9);
});

test('chuẩn hóa cấu hình chatbot trước khi lưu', () => {
  const settings = normalizeChatbotSettings({
    enabled: true,
    name: '  Bot bán hàng  ',
    responseMode: 'automatic',
    endpoint: 'https://api.dify.ai/v1/chat-messages',
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
  assert.equal('apiKey' in settings, false);
});

test('chuẩn hóa mẫu tin và trạng thái từng bước xử lý', () => {
  const settings = normalizeChatbotSettings({
    messageTemplates: { WELCOME: '  Xin chào mới  ' },
    processingSteps: [{ id: 'dify', enabled: false, code: 'return input.answer;' }]
  });
  assert.equal(settings.messageTemplates.WELCOME, 'Xin chào mới');
  assert.equal(settings.processingSteps.find(step => step.id === 'dify').enabled, false);
  assert.equal(settings.processingSteps.find(step => step.id === 'dify').code, 'return input.answer;');
  assert.equal(settings.processingSteps.find(step => step.id === 'webhook').enabled, true);
  assert.match(settings.processingSteps.find(step => step.id === 'webhook').code, /receivedAt/);
});
