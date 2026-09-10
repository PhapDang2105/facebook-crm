export const defaultChatbotSettings = Object.freeze({
  enabled: false,
  name: 'Trợ lý Giọt Nắng',
  responseMode: 'draft',
  welcomeMessage: '',
  instructions: '',
  handoffKeywords: 'gặp nhân viên, tư vấn viên, khiếu nại'
});

function cleanText(value, fallback, maximumLength) {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, maximumLength);
}

export function normalizeChatbotSettings(value = {}) {
  const responseMode = value.responseMode === 'automatic' ? 'automatic' : 'draft';
  return {
    enabled: value.enabled === true,
    name: cleanText(value.name, defaultChatbotSettings.name, 100),
    responseMode,
    welcomeMessage: cleanText(value.welcomeMessage, '', 2000),
    instructions: cleanText(value.instructions, '', 12000),
    handoffKeywords: cleanText(value.handoffKeywords, defaultChatbotSettings.handoffKeywords, 1000),
    updatedAt: Number(value.updatedAt) || Date.now()
  };
}
