export const defaultChatbotSettings = Object.freeze({
  enabled: false,
  name: 'Trợ lý Giọt Nắng',
  responseMode: 'draft',
  provider: 'dify',
  endpoint: 'https://api.dify.ai/v1/chat-messages',
  apiKey: '',
  welcomeMessage: '',
  instructions: '',
  handoffKeywords: 'gặp nhân viên, tư vấn viên, khiếu nại',
  messageTemplates: {},
  processingSteps: [
    { id: 'webhook', name: 'Webhook Facebook', type: 'trigger', enabled: true },
    { id: 'message_normalizer', name: 'Xử lý bình luận và tin nhắn', type: 'transform', enabled: true },
    { id: 'product_extractor', name: 'Xử lý sản phẩm', type: 'transform', enabled: true },
    { id: 'customer_extractor', name: 'Xử lý xưng hô và số điện thoại', type: 'transform', enabled: true },
    { id: 'context_merge', name: 'Gộp dữ liệu đầu vào', type: 'merge', enabled: true },
    { id: 'dify', name: 'Gọi Dify AI', type: 'ai', enabled: true },
    { id: 'template_renderer', name: 'Hậu xử lý mẫu tin', type: 'transform', enabled: true },
    { id: 'duplicate_guard', name: 'Chặn phản hồi trùng', type: 'guard', enabled: true },
    { id: 'meta_sender', name: 'Gửi trả Facebook', type: 'output', enabled: true }
  ]
});

function cleanText(value, fallback, maximumLength) {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, maximumLength);
}

export function normalizeChatbotSettings(value = {}) {
  const responseMode = value.responseMode === 'automatic' ? 'automatic' : 'draft';
  const messageTemplates = Object.fromEntries(Object.entries(value.messageTemplates || {})
    .slice(0, 100)
    .map(([key, text]) => [String(key).trim().slice(0, 100), String(text ?? '').trim().slice(0, 12000)])
    .filter(([key]) => key));
  const submittedSteps = new Map((Array.isArray(value.processingSteps) ? value.processingSteps : []).map(step => [step?.id, step]));
  const processingSteps = defaultChatbotSettings.processingSteps.map(step => ({
    ...step,
    enabled: submittedSteps.has(step.id) ? submittedSteps.get(step.id)?.enabled !== false : step.enabled
  }));
  return {
    enabled: value.enabled === true,
    name: cleanText(value.name, defaultChatbotSettings.name, 100),
    responseMode,
    provider: 'dify',
    endpoint: cleanText(value.endpoint, defaultChatbotSettings.endpoint, 500),
    apiKey: cleanText(value.apiKey, '', 1000),
    welcomeMessage: cleanText(value.welcomeMessage, '', 2000),
    instructions: cleanText(value.instructions, '', 12000),
    handoffKeywords: cleanText(value.handoffKeywords, defaultChatbotSettings.handoffKeywords, 1000),
    messageTemplates,
    processingSteps,
    updatedAt: Number(value.updatedAt) || Date.now()
  };
}

export function publicChatbotSettings(value = {}) {
  const settings = normalizeChatbotSettings(value);
  const { apiKey, messageTemplates, ...visible } = settings;
  return { ...visible, apiKeyConfigured: Boolean(apiKey) };
}
