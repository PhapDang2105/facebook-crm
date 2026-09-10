import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultChatbotSettings, normalizeChatbotSettings } from '../app/chatbot-settings.mjs';

test('chatbot mặc định ở chế độ gợi ý và chưa hoạt động', () => {
  const settings = normalizeChatbotSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.responseMode, 'draft');
  assert.equal(settings.name, defaultChatbotSettings.name);
});

test('chuẩn hóa cấu hình chatbot trước khi lưu', () => {
  const settings = normalizeChatbotSettings({
    enabled: true,
    name: '  Bot bán hàng  ',
    responseMode: 'automatic',
    welcomeMessage: '  Xin chào  ',
    instructions: '  Chỉ trả lời về sản phẩm.  ',
    handoffKeywords: '  gặp người thật  '
  });
  assert.deepEqual({
    enabled: settings.enabled,
    name: settings.name,
    responseMode: settings.responseMode,
    welcomeMessage: settings.welcomeMessage,
    instructions: settings.instructions,
    handoffKeywords: settings.handoffKeywords
  }, {
    enabled: true,
    name: 'Bot bán hàng',
    responseMode: 'automatic',
    welcomeMessage: 'Xin chào',
    instructions: 'Chỉ trả lời về sản phẩm.',
    handoffKeywords: 'gặp người thật'
  });
});
