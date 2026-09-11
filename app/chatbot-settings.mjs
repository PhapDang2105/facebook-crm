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
  messageTemplates: {},
  deletedTemplateIds: [],
  processingSteps: [
    { id: 'message_normalizer', name: 'Xử lý bình luận và tin nhắn', type: 'transform', enabled: true, code: "const text = String(input.message?.text || '').trim();\nreturn { ...input, text };" },
    { id: 'product_extractor', name: 'Xử lý sản phẩm', type: 'transform', enabled: true, code: "const products = ['Túi Xanh', 'Túi Vàng', 'Túi Nâu'];\nreturn { ...input, products: products.filter(name => input.text?.includes(name)) };" },
    { id: 'customer_extractor', name: 'Xử lý xưng hô và số điện thoại', type: 'transform', enabled: true, code: "const phone = input.text?.match(/(?:\\+84|0)\\d{9}/)?.[0] || '';\nreturn { ...input, phone };" },
    { id: 'context_merge', name: 'Gộp dữ liệu đầu vào', type: 'merge', enabled: true, code: "return { ...input, context: { ...input.customer, ...input.conversation } };" },
    { id: 'template_renderer', name: 'Hậu xử lý mẫu tin', type: 'transform', enabled: true, code: "return { ...input, reply: String(input.answer || '').trim() };" },
    { id: 'duplicate_guard', name: 'Chặn phản hồi trùng', type: 'guard', enabled: true, code: "return { ...input, signature: `${input.senderId}:${input.reply}` };" }
  ]
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
  const messageTemplates = Object.fromEntries(Object.entries(value.messageTemplates || {})
    .slice(0, 100)
    .map(([key, text]) => [String(key).trim().slice(0, 100), String(text ?? '').trim().slice(0, 12000)])
    .filter(([key]) => key));
  const deletedTemplateIds = [...new Set((Array.isArray(value.deletedTemplateIds) ? value.deletedTemplateIds : [])
    .map(id => String(id || '').trim().slice(0, 100))
    .filter(Boolean))].slice(0, 100);
  const submittedSteps = new Map((Array.isArray(value.processingSteps) ? value.processingSteps : []).map(step => [step?.id, step]));
  const processingSteps = defaultChatbotSettings.processingSteps.map(step => ({
    ...step,
    enabled: submittedSteps.has(step.id) ? submittedSteps.get(step.id)?.enabled !== false : step.enabled,
    code: String(submittedSteps.get(step.id)?.code ?? step.code).slice(0, 30000)
  }));
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
    deletedTemplateIds,
    processingSteps,
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
