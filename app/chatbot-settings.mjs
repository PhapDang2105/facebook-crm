import { LEGACY_SHIPMENT_TEMPLATES } from './shipment-stage.mjs';
import { defaultMessageTemplates, isProductQuoteId } from './chatbot-templates.mjs';
import { isInternalHost } from './network-guard.mjs';
import { defaultComplaintKeywords } from './processing/auto-label.mjs';

export const defaultChatbotSettings = Object.freeze({
  enabled: false,
  // Tắt thì bot vẫn tư vấn, báo giá và xác nhận, nhưng không tự tạo đơn: giỏ khách
  // chốt được giữ ở pendingOrder để nhân viên lên đơn tay.
  autoOrder: true,
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
  // R14 (quyết định 8): giỏ Facebook Shop chờ đơn POS 20 giây trước khi xin SĐT/địa chỉ.
  shopOrderWaitMs: 20000,
  // Model dự phòng khi model chính hết hạn mức (429); trống = không dùng.
  fallbackModel: 'gemini-2.5-flash',
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
  // Bám đuổi (kịch bản nền): tắt cho tới khi chủ shop bật ở Cấu hình chung.
  followUps: { enabled: false, scenarios: [] },
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

function normalizedEndpoint(value) {
  try { return new URL(String(value || '').trim()).toString(); } catch { return String(value || '').trim(); }
}

export const AI_KEY_REENTRY_ERROR = 'Đổi endpoint AI thì phải nhập lại khóa API (khóa đang lưu không được gửi sang địa chỉ mới).';

/**
 * Chặn trộm khóa AI: khóa đã lưu chỉ được gửi tới đúng endpoint lúc nhập khóa. Bản vá đổi
 * endpoint (URL khác, kể cả cùng host khác đường dẫn — cổng AI dùng chung phân tài khoản theo
 * đường dẫn) mà không kèm khóa mới → trả thông báo lỗi; ngược lại trả ''.
 * Đổi nhà cung cấp thì server tự xóa khóa cũ nên không cần chặn ở đây.
 * `next`: cấu hình SẼ lưu (đã gộp bản vá + chuẩn hóa — endpoint trống thành endpoint mặc định).
 */
export function aiKeyReentryError(current = {}, next = {}, patch = {}) {
  if (String(patch?.directApiKey || '').trim()) return '';
  if (!String(current?.directApiKey || '').trim()) return '';
  if (patch?.provider && patch.provider !== current?.provider) return '';
  return normalizedEndpoint(next?.directEndpoint) === normalizedEndpoint(current?.directEndpoint) ? '' : AI_KEY_REENTRY_ERROR;
}

// Trần số mẫu tin lưu được (seed + mẫu tự tạo).
export const maxMessageTemplates = 200;

// Giá trị "không gửi": undefined, null hay chuỗi trống (ô số để trống trên màn hình).
const isBlank = item => item === undefined || item === null || (typeof item === 'string' && !item.trim());
// Khóa số: null/"" trong bản vá = không gửi (giữ giá trị cũ), không phải "đặt về 0/mặc định".
const numericSettingKeys = new Set(['cascadeCanary', 'cascadeThreshold', 'intentThreshold', 'memoryWindow', 'retryCount', 'retryIntervalMs', 'shopOrderWaitMs']);

/**
 * Gộp bản vá cấu hình (payload POST từ màn hình) vào cấu hình hiện tại, TRƯỚC khi chuẩn hóa:
 * - khóa undefined / null = không gửi → giữ giá trị cũ (handoffKeywords, messageTemplates…);
 * - khóa số (cascadeCanary, cascadeThreshold…) mang "" cũng coi là không gửi;
 * - followUps gộp sâu: bản vá chỉ có { enabled } không xóa kịch bản / maxPerRun; kịch bản cùng id
 *   gộp trường (bản vá chỉ có { id, enabled } giữ templateId, delayHours…), danh sách theo bản vá;
 * - contextTrim gộp từng phần.
 */
export function mergeChatbotSettingsPatch(current = {}, patch = {}) {
  const base = current && typeof current === 'object' ? current : {};
  const merged = { ...base };
  for (const [key, item] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    if (item === undefined || item === null) continue;
    if (numericSettingKeys.has(key) && isBlank(item)) continue;
    if (key === 'followUps' && typeof item === 'object' && !Array.isArray(item)) {
      const before = base.followUps && typeof base.followUps === 'object' ? base.followUps : {};
      const next = { ...before };
      for (const [name, part] of Object.entries(item)) if (part !== undefined && part !== null && !(name === 'maxPerRun' && isBlank(part))) next[name] = part;
      if (Array.isArray(item.scenarios)) {
        const previous = new Map((Array.isArray(before.scenarios) ? before.scenarios : []).filter(entry => entry?.id).map(entry => [String(entry.id), entry]));
        next.scenarios = item.scenarios.map(entry => (entry && typeof entry === 'object' && previous.has(String(entry.id)) ? { ...previous.get(String(entry.id)), ...entry } : entry));
      } else if (Array.isArray(before.scenarios)) next.scenarios = before.scenarios;
      merged.followUps = next;
      continue;
    }
    // R15: bản vá cờ luật ứng viên theo từng luật ({ K1: 'on' }) gộp vào đối tượng đang lưu (không đưa các luật khác về 'shadow').
    if (key === 'candidateRules' && typeof item === 'object' && !Array.isArray(item) && base.candidateRules && typeof base.candidateRules === 'object' && !Array.isArray(base.candidateRules)) {
      merged.candidateRules = { ...base.candidateRules, ...item };
      continue;
    }
    if (key === 'contextTrim' && typeof item === 'object' && !Array.isArray(item)) {
      merged.contextTrim = { ...(base.contextTrim && typeof base.contextTrim === 'object' ? base.contextTrim : {}), ...item };
      continue;
    }
    merged[key] = item;
  }
  return merged;
}

/**
 * R13 (C2): gộp bản vá mẫu tin vào bộ đang lưu. Trước đây PUT /api/chatbot/settings thay CẢ BỘ bằng
 * `payload.messageTemplates`: một script gửi 1 mẫu (hay `{}`) là mọi mẫu đã chỉnh về mặc định mà không
 * báo gì (QR_OFFER về bản giữ chỗ → ưu đãi QR ngừng gửi). Nay: mã không gửi kèm giữ nguyên; giá trị
 * `null` = bỏ bản đã lưu (mẫu có sẵn về lời mặc định khi chuẩn hoá, mẫu tự tạo bị xoá); chuỗi rỗng vẫn
 * là "tắt mẫu" như cũ. Bản vá không phải object thì bỏ qua.
 */
export function mergeMessageTemplatesPatch(current = {}, patch = undefined) {
  const merged = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return merged;
  for (const [id, text] of Object.entries(patch)) {
    if (text === null || text === undefined) delete merged[id];
    else merged[id] = text;
  }
  return merged;
}

const candidateRuleKeys = ['K1', 'K1b', 'K3', 'K4', 'K5'];
const candidateRuleModes = ['on', 'shadow', 'off'];
/**
 * R15: cờ luật ứng viên. Chuỗi 'on' | 'shadow' | 'off' giữ nguyên (cờ chung). Đối tượng → chỉ nhận khoá K1/K1b/K3/K4/K5 với giá
 * trị on/shadow/off, thiếu khoá = 'shadow'; đối tượng không có khoá hợp lệ nào → 'shadow'. Giá trị khác → 'shadow'.
 */
export function normalizeCandidateRules(value) {
  if (typeof value === 'string') return candidateRuleModes.includes(value) ? value : 'shadow';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'shadow';
  const valid = candidateRuleKeys.filter(key => candidateRuleModes.includes(value[key]));
  if (!valid.length) return 'shadow';
  return Object.fromEntries(candidateRuleKeys.map(key => [key, candidateRuleModes.includes(value[key]) ? value[key] : 'shadow']));
}

/**
 * Chuẩn hóa cấu hình. `current` (tùy chọn): cấu hình đang lưu — khi có, `value` được coi là bản vá
 * và gộp sâu vào `current` trước (mergeChatbotSettingsPatch).
 */
export function normalizeChatbotSettings(input = {}, current = null) {
  const value = current && typeof current === 'object' ? mergeChatbotSettingsPatch(current, input) : (input || {});
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
  // 03/10: mẫu vận đơn còn đúng lời mặc định cũ (chưa ai sửa) theo lời mới của seed.
  for (const [key, text] of Object.entries(LEGACY_SHIPMENT_TEMPLATES)) if (submitted[key] === text) submitted[key] = defaultMessageTemplates()[key];
  // Texts saved before {title} existed still spell out "anh/ chị"; they are
  // rewritten to the placeholder so the bot addresses the customer properly.
  const placeholderHonorific = text => String(text ?? '')
    .replace(/(?<![\p{L}\p{N}])Anh\s*\/\s*[Cc]hị(?![\p{L}\p{N}])/gu, '{Title}')
    .replace(/(?<![\p{L}\p{N}])anh\s*\/\s*[Cc]hị(?![\p{L}\p{N}])/gu, '{title}');
  // 28/09: seed đã có 99 mẫu, cộng mẫu nhân viên tự tạo thì trần 100 sẽ âm thầm bỏ mẫu mới → nâng lên 200.
  // Bỏ giá cũ PRICE_<sản phẩm> và mã trống TRƯỚC khi cắt trần (không để mã rác chiếm chỗ); vượt trần thì
  // giữ đủ mẫu seed, cắt mẫu tự tạo ở cuối và cảnh báo (không bao giờ bỏ im lặng một mẫu seed).
  const cleaned = Object.entries(submitted)
    .map(([key, text]) => [String(key).trim().slice(0, 100), placeholderHonorific(text).trim().slice(0, 12000)])
    .filter(([key]) => key && !isProductQuoteId(key));
  const seedIds = new Set(Object.keys(defaultMessageTemplates()));
  const customEntries = cleaned.filter(([key]) => !seedIds.has(key));
  const customRoom = Math.max(0, maxMessageTemplates - (cleaned.length - customEntries.length));
  const droppedCustom = new Set(customEntries.slice(customRoom).map(([key]) => key));
  if (droppedCustom.size) console.warn(`Thiết lập tin nhắn: vượt trần ${maxMessageTemplates} mẫu, bỏ ${droppedCustom.size} mẫu tự tạo: ${[...droppedCustom].slice(0, 10).join(', ')}`);
  const messageTemplates = Object.fromEntries(cleaned.filter(([key]) => !droppedCustom.has(key)));
  // The processing pipeline is code in app/processing, not editable settings.
  return {
    enabled: value.enabled === true,
    autoOrder: value.autoOrder !== false,
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
    // Few-shot động: chèn 3 tin đã chấm gần nhất (bộ chấm mẫu) vào câu hỏi gửi LLM. Mặc định tắt (A/B trước).
    fewShot: value.fewShot === 'on' ? 'on' : 'off',
    // Luật nhận ý bằng code trước mô hình: 'on' | 'shadow' (chỉ ghi log so sánh) | 'off'.
    ruleIntent: ['on', 'shadow', 'off'].includes(value.ruleIntent) ? value.ruleIntent : 'on',
    // Luật thử nghiệm (TRIAL_ASK, ORDER_ASK, TERSE_HOW, ADDRESS_COMPLETE): 'shadow' chỉ ghi log so với mô hình.
    experimentalRules: value.experimentalRules === 'on' ? 'on' : 'shadow',
    // R13: luật ứng viên K1/K1b/K3/K4/K5 (rule-intent candidateRules) — 'shadow' (mặc định) chỉ ghi nhật ký, 'on' mới trả lời, 'off' tắt.
    // R15 (chủ shop 03/10, quyết định 12): cờ có thể theo TỪNG luật — đối tượng { K1, K1b, K3, K4, K5 } mỗi khoá 'on'|'shadow'|'off'
    // (thiếu khoá = 'shadow'; khoá lạ / giá trị lạ bỏ). Chuỗi hợp lệ giữ nguyên như trước.
    candidateRules: normalizeCandidateRules(value.candidateRules),
    // Mô hình ra quyết định trước LLM (processing/intent-model.mjs): 'shadow' chỉ ghi log so với
    // câu trả lời thật; 'on' đủ tin cậy (≥ intentThreshold) và mẫu an toàn thì trả lời thẳng.
    intentModel: ['on', 'shadow', 'off'].includes(value.intentModel) ? value.intentModel : 'shadow',
    // Mô hình tầng (processing/intent-cascade.mjs: tầng 1 nhóm ý định ORDER/SUPPORT/OTHER/ANSWER, tầng 2 mẫu trong
    // nhóm): 'shadow' (mặc định) chỉ ghi nhật ký + log so với câu trả lời thật; 'on' tự trả lời khi nhóm ANSWER
    // (hay PRICE/INFO/SOCIAL bản cũ), mẫu an toàn, pGroup ≥ 0,85, pWithin ≥ cascadeThreshold, biên trong nhóm ≥ 0,25
    // và qua các rào cứng của engine (không màu/số túi, không khiếu nại, không SĐT…); 'off' không gọi.
    // Khi cả intentModel 'on' và intentCascade 'on' thì tầng thắng — nên chỉ bật MỘT cái để so được kết quả.
    intentCascade: ['on', 'shadow', 'off'].includes(value.intentCascade) ? value.intentCascade : 'shadow',
    // Ngưỡng xác suất mẫu TRONG NHÓM (pWithin) để mô hình tầng tự trả lời; ngưỡng nhóm (pGroup ≥ 0,85) là hằng trong engine.
    // R13: mặc định 0,85 (khớp CASCADE_TEMPLATE_THRESHOLD trong engine; trước là 0,8). Cài đặt đã lưu giữ nguyên giá trị đã lưu.
    cascadeThreshold: Math.min(0.99, Math.max(0.5, Number(value.cascadeThreshold) || 0.85)),
    // Canary: khi 'on' chỉ áp cho hội thoại có hash(id) % 100 < cascadeCanary (0–100, mặc định 100 = tất cả);
    // hội thoại ngoài canary chạy như shadow (nhật ký ghi cascade.canary: false).
    // null / "" (ô để trống) = không gửi → mặc định 100 (gộp với cấu hình cũ thì giữ giá trị cũ, xem mergeChatbotSettingsPatch).
    cascadeCanary: Math.min(100, Math.max(0, isBlank(value.cascadeCanary) ? 100 : Math.round(Number(value.cascadeCanary)) || 0)),
    // Cache phần tĩnh của prompt trên Vertex (explicit context cache): 'on' mặc định (thăm dò 25/09 chạy tốt).
    promptCache: value.promptCache === 'off' ? 'off' : 'on',
    intentThreshold: Math.min(0.99, Math.max(0.5, Number(value.intentThreshold) || 0.9)),
    // Nhật ký quyết định (processing/decision-log.mjs): mỗi lượt một dòng JSONL. 'on' mặc định | 'off'.
    decisionLog: value.decisionLog === 'off' ? 'off' : 'on',
    // Gác trước LLM (khách giục / lặp câu vừa hỏi sau mẫu thông tin → "đã gửi ở trên" không cần gọi
    // mô hình): 'shadow' (mặc định, chỉ ghi so sánh) | 'on' | 'off'.
    preGuard: ['on', 'shadow', 'off'].includes(value.preGuard) ? value.preGuard : 'shadow',
    // responseSchema với enum template_id khi gọi Vertex Gemini: 'off' mặc định (A/B trước khi bật).
    responseEnum: value.responseEnum === 'on' ? 'on' : 'off',
    // Các phần rút gọn ngữ cảnh gửi mô hình (mặc định tắt cả; bật từng phần sau khi A/B đạt).
    contextTrim: Object.fromEntries(['memory', 'query', 'catalog', 'templates'].map(key => [key, value.contextTrim?.[key] === true])),
    // Mức suy nghĩ của model ('' = mặc định của model; minimal | low | medium | high).
    thinkingLevel: ['minimal', 'low', 'medium', 'high'].includes(value.thinkingLevel) ? value.thinkingLevel : '',
    retryCount: Math.max(0, Math.min(5, value.retryCount === undefined ? defaultChatbotSettings.retryCount : Number(value.retryCount) || 0)),
    fallbackModel: cleanText(value.fallbackModel ?? defaultChatbotSettings.fallbackModel, '', 200),
    retryIntervalMs: Math.max(100, Math.min(10000, Number(value.retryIntervalMs) || defaultChatbotSettings.retryIntervalMs)),
    // R14 (chủ shop 03/10, quyết định 8): giỏ Facebook Shop chờ đơn POS bao lâu (ms) trước khi xin SĐT/địa chỉ — mặc định 20 giây
    // (trước 60 giây; chỉ 1/33 giỏ thấy đơn trong lúc chờ). 0 = không chờ (đơn POS vào muộn vẫn được tra nền báo "đã nhận").
    shopOrderWaitMs: isBlank(value.shopOrderWaitMs) || !Number.isFinite(Number(value.shopOrderWaitMs)) ? defaultChatbotSettings.shopOrderWaitMs : Math.max(0, Math.min(120000, Math.round(Number(value.shopOrderWaitMs)))),
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
    followUps: normalizeFollowUps(value.followUps),
    messageTemplates,
    updatedAt: Number(value.updatedAt) || Date.now()
  };
}

// ===== Bám đuổi =====
//
// Kịch bản chạy nền: khách im lặng sau khi Page trả lời thì sau N giờ gửi một
// tin (ưu đãi dùng thử…). Hai loại mốc: khách bình luận rồi im (comment-no-reply)
// và khách nhắn hộp thư rồi im (inbox-no-reply). Mỗi khách mỗi kịch bản chỉ
// nhận một lần; nhân viên đã tắt bot hay khách đã có đơn thì không bám.
export const followUpTriggers = ['comment-no-reply', 'inbox-no-reply'];

// Lời tin của kịch bản nằm trong Thiết lập tin nhắn (mẫu mã FOLLOW_UP_…), nhóm
// "Bám đuổi"; kịch bản chỉ trỏ tới mã mẫu. Mẫu bị tắt thì kịch bản không gửi.
export const followUpTemplatePrefix = 'FOLLOW_UP_';

export function defaultFollowUpScenarios() {
  return [{
    id: 'comment-freeship',
    name: 'Bình luận không phản hồi: tặng miễn ship dùng thử',
    enabled: true,
    trigger: 'comment-no-reply',
    delayHours: 12,
    templateId: 'FOLLOW_UP_COMMENT_FREESHIP',
    publicFallback: true
  }];
}

export function normalizeFollowUps(value) {
  const source = value && typeof value === 'object' ? value : {};
  const rawScenarios = Array.isArray(source.scenarios) ? source.scenarios : defaultFollowUpScenarios();
  const seen = new Set();
  const scenarios = rawScenarios.slice(0, 20).map((item, index) => {
    const id = cleanText(item?.id, '', 60).replace(/[^\w-]/g, '') || `scenario-${index + 1}`;
    const templateId = cleanText(item?.templateId, '', 100).replace(/[^\w-]/g, '').toUpperCase();
    return {
      id,
      name: cleanText(item?.name, `Kịch bản ${index + 1}`, 120),
      enabled: item?.enabled !== false,
      trigger: followUpTriggers.includes(item?.trigger) ? item.trigger : 'comment-no-reply',
      delayHours: Math.max(1, Math.min(24 * 14, Number(item?.delayHours) || 12)),
      // Kịch bản cũ còn ghi lời trực tiếp: giữ để không mất, ưu tiên mẫu tin khi có.
      templateId: templateId.startsWith(followUpTemplatePrefix) ? templateId : '',
      message: String(item?.message ?? '').trim().slice(0, 2000),
      publicFallback: item?.publicFallback !== false,
      // Gửi cả khi đã quá 24 giờ kể từ tin cuối của khách (Pancake tự gắn thẻ tin nhắn).
      outsideWindow: item?.outsideWindow === true,
      // Tặng miễn phí vận chuyển cho đơn của khách trong N ngày sau khi nhận tin (0 = không tặng).
      freeShipDays: Math.max(0, Math.min(30, Math.round(Number(item?.freeShipDays) || 0))),
      // Xét cả khách im lặng trong N ngày trước lúc bật (0 = chỉ tính từ lúc bật).
      backlogDays: Math.max(0, Math.min(7, Math.round(Number(item?.backlogDays) || 0)))
    };
  }).filter(item => (item.templateId || item.message) && !seen.has(item.id) && seen.add(item.id));
  // Mỗi lượt (15 phút) gửi tối đa N tin: chia đều, tránh gửi dồn hàng trăm tin một lúc.
  // commentEnabled: tắt riêng mọi kịch bản bám đuổi bình luận (comment-no-reply) mà không tắt cả bám đuổi.
  // Mặc định bật (giữ hành vi cũ); chỉ false khi đặt rõ false.
  return { enabled: source.enabled === true, commentEnabled: source.commentEnabled !== false, maxPerRun: Math.max(1, Math.min(100, Math.round(Number(source.maxPerRun) || 15))), scenarios };
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
