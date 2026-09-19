import { defaultMessageTemplates, isProductQuoteId } from './chatbot-templates.mjs';
import { isInternalHost } from './network-guard.mjs';
import { defaultComplaintKeywords } from './processing/auto-label.mjs';

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
  // Lời khách có những từ này thì hội thoại được gắn thẻ khiếu nại.
  complaintKeywords: defaultComplaintKeywords,
  // Comments: like the customer's comment; hide it when it holds a phone number.
  commentLike: true,
  commentHide: 'phone',
  // Địa chỉ bộ đọc luật không tách đủ ba cấp thì hỏi Gemini (kèm tra cứu
  // Google Search); chỉ nhận câu trả lời khớp danh mục kho.
  addressAi: true,
  addressAiSearch: true,
  messageTemplates: {}
});

function cleanText(value, fallback, maximumLength) {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, maximumLength);
}

/**
 * Kiểm endpoint AI trước khi máy chủ gọi tới đó. Ném lỗi có lời tiếng Việt để
 * route trả thẳng cho người dùng. Host không được là mạng nội bộ: máy chủ sẽ
 * tự gọi tới đó kèm giấy tờ tuỳ thân (dịch vụ metadata của VM, cổng quản trị
 * chỉ mở trong LAN...). Hàm này chặn theo TÊN; route gọi thêm `assertPublicHost`
 * (tra DNS) trước khi gọi thật, để tên miền công khai trỏ về IP nội bộ cũng bị chặn.
 *
 * Luật quan trọng nhất: với Vertex dùng access token, thứ gửi kèm là giấy tờ
 * của CẢ dự án Google Cloud chứ không phải khoá riêng của endpoint — nên chỉ
 * được gửi về chính Google. Các provider khác gửi khoá do nhân viên tự nhập
 * cho endpoint của họ, nên chỉ cần chặn mạng nội bộ.
 */
export function assertUsableAiEndpoint(endpoint, { provider = '', authType = '' } = {}) {
  let parsed;
  try {
    parsed = new URL(String(endpoint || '').trim());
  } catch {
    throw new Error('Endpoint AI không hợp lệ.');
  }
  if (parsed.protocol !== 'https:') throw new Error('Endpoint AI phải bắt đầu bằng https://.');
  const host = parsed.hostname.toLowerCase();
  if (isInternalHost(host)) throw new Error('Endpoint AI không được trỏ vào địa chỉ nội bộ.');
  if (provider === 'vertex' && authType !== 'api_key' && !/(^|\.)googleapis\.com$/.test(host)) {
    throw new Error('Vertex dùng access token thì endpoint phải thuộc googleapis.com.');
  }
  return parsed.toString();
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
  // created themselves are theirs alone: removed on screen, gone. A text
  // stored under an old PRICE_<sản phẩm> id is a stale price: dropped.
  const stored = value.messageTemplates && typeof value.messageTemplates === 'object' ? value.messageTemplates : {};
  const submitted = { ...defaultMessageTemplates(), ...stored };
  // Texts saved before {title} existed still spell out "anh/ chị"; they are
  // rewritten to the placeholder so the bot addresses the customer properly.
  const placeholderHonorific = text => String(text ?? '')
    .replace(/(?<![\p{L}\p{N}])Anh\s*\/\s*[Cc]hị(?![\p{L}\p{N}])/gu, '{Title}')
    .replace(/(?<![\p{L}\p{N}])anh\s*\/\s*[Cc]hị(?![\p{L}\p{N}])/gu, '{title}');
  const messageTemplates = Object.fromEntries(Object.entries(submitted)
    .slice(0, 100)
    .map(([key, text]) => [String(key).trim().slice(0, 100), placeholderHonorific(text).trim().slice(0, 12000)])
    .filter(([key]) => key && !isProductQuoteId(key)));
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
    // Chuỗi rỗng là một lựa chọn: tắt hẳn việc đoán khiếu nại theo từ khoá.
    complaintKeywords: value.complaintKeywords === undefined
      ? defaultChatbotSettings.complaintKeywords
      : String(value.complaintKeywords).trim().slice(0, 2000),
    commentLike: value.commentLike !== false,
    commentHide: ['none', 'phone', 'all'].includes(value.commentHide) ? value.commentHide : defaultChatbotSettings.commentHide,
    addressAi: value.addressAi !== false,
    addressAiSearch: value.addressAiSearch !== false,
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
