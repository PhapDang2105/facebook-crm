import { defaultMessageTemplates, isDynamicTemplate } from './chatbot-templates.mjs';

export const defaultChatbotSettings = Object.freeze({
  enabled: false,
  name: 'Trợ lý Giọt Nắng',
  responseMode: 'automatic',
  provider: 'vertex',
  directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/publishers/google/models/gemini-3-flash-preview:generateContent',
  directApiKey: '',
  directAuthType: 'access_token',
  directProtocol: 'vertex',
  directModel: 'gemini-3-flash-preview',
  systemPrompt: '',
  memoryEnabled: true,
  memoryWindow: 50,
  structuredOutput: true,
  retryCount: 1,
  retryIntervalMs: 1000,
  welcomeMessage: '',
  handoffKeywords: '',
  messageTemplates: {}
});

function cleanText(value, fallback, maximumLength) {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, maximumLength);
}

export function normalizeChatbotSettings(value = {}) {
  const responseMode = 'automatic';
  const requestedProvider = value.provider === 'openai_compatible' ? 'custom' : value.provider;
  const supportedProviders = ['vertex', 'openai', 'anthropic', 'deepseek', 'xai', 'groq', 'mistral', 'openrouter', 'custom'];
  const provider = supportedProviders.includes(requestedProvider) ? requestedProvider : 'vertex';
  const directProtocol = provider === 'vertex' ? 'vertex' : provider === 'anthropic' || (provider === 'custom' && value.directProtocol === 'anthropic') ? 'anthropic' : 'openai';
  const providerDefaults = {
    vertex: { endpoint: defaultChatbotSettings.directEndpoint, model: defaultChatbotSettings.directModel },
    openai: { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4.1-mini' },
    anthropic: { endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-6' },
    deepseek: { endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash' },
    xai: { endpoint: 'https://api.x.ai/v1/chat/completions', model: 'grok-4.5' },
    groq: { endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b' },
    mistral: { endpoint: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-large-latest' },
    openrouter: { endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: '~openai/gpt-latest' },
    custom: directProtocol === 'anthropic'
      ? { endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-6' }
      : { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4.1-mini' }
  }[provider];
  const submittedDirectEndpoint = String(value.directEndpoint ?? '').trim();
  const submittedDirectModel = String(value.directModel ?? '').trim();
  const migratedDirectModel = provider === 'vertex' && submittedDirectModel === 'gemini-2.5-flash'
    ? 'gemini-3-flash-preview'
    : submittedDirectModel;
  const directEndpoint = cleanText(submittedDirectEndpoint, providerDefaults.endpoint, 500);
  const directModel = cleanText(migratedDirectModel, providerDefaults.model, 200);
  // Thiết lập tin nhắn is the only place reply text lives. What is stored is
  // what the bot says — a blank text switches that template off. A shipped
  // id the settings do not hold yet (a new release added it, or the settings
  // predate the texts moving here) is read in from the seed underneath the
  // stored texts; the screen turns a shipped template off rather than
  // dropping it, so nothing staff switched off ever comes back. Ids staff
  // created themselves are theirs alone: removed on screen, gone. Catalogue-
  // written ids (GENERAL_INFO, PRICE_QUOTE, ...) never store text.
  const stored = value.messageTemplates && typeof value.messageTemplates === 'object' ? value.messageTemplates : {};
  const submitted = { ...defaultMessageTemplates(), ...stored };
  const messageTemplates = Object.fromEntries(Object.entries(submitted)
    .slice(0, 100)
    .map(([key, text]) => [String(key).trim().slice(0, 100), String(text ?? '').trim().slice(0, 12000)])
    .filter(([key]) => key && !isDynamicTemplate(key, submitted)));
  // The processing pipeline is code in app/processing, not editable settings.
  return {
    enabled: value.enabled === true,
    name: cleanText(value.name, defaultChatbotSettings.name, 100),
    responseMode,
    provider,
    directEndpoint,
    directApiKey: cleanText(value.directApiKey ?? value.apiKey, '', 1000),
    directAuthType: provider === 'vertex' && value.directAuthType === 'api_key' ? 'api_key' : 'access_token',
    directProtocol,
    directModel,
    systemPrompt: String(value.systemPrompt ?? '').trim().slice(0, 30000),
    memoryEnabled: value.memoryEnabled !== false,
    memoryWindow: Math.max(1, Math.min(100, Number(value.memoryWindow) || defaultChatbotSettings.memoryWindow)),
    structuredOutput: value.structuredOutput !== false,
    retryCount: Math.max(0, Math.min(5, value.retryCount === undefined ? defaultChatbotSettings.retryCount : Number(value.retryCount) || 0)),
    retryIntervalMs: Math.max(100, Math.min(10000, Number(value.retryIntervalMs) || defaultChatbotSettings.retryIntervalMs)),
    welcomeMessage: cleanText(value.welcomeMessage, '', 2000),
    handoffKeywords: cleanText(value.handoffKeywords, defaultChatbotSettings.handoffKeywords, 1000),
    messageTemplates,
    updatedAt: Number(value.updatedAt) || Date.now()
  };
}

export function publicChatbotSettings(value = {}) {
  const settings = normalizeChatbotSettings(value);
  const { directApiKey, messageTemplates, ...visible } = settings;
  return {
    ...visible,
    apiKeyConfigured: Boolean(directApiKey),
    directApiKeyConfigured: Boolean(directApiKey)
  };
}
