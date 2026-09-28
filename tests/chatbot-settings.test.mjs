import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { defaultChatbotSettings, normalizeChatbotSettings, publicChatbotSettings } from '../app/chatbot-settings.mjs';

test('chatbot mặc định gọi Vertex AI trực tiếp và chưa hoạt động', () => {
  const settings = normalizeChatbotSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.autoOrder, true);
  assert.equal(settings.responseMode, 'automatic');
  assert.equal(settings.name, defaultChatbotSettings.name);
  assert.equal(settings.provider, 'vertex');
  assert.equal(settings.memoryWindow, 50);
  assert.equal(settings.retryCount, 1);
  // The processing pipeline is code in app/processing, not a setting.
  assert.equal(settings.processingSteps, undefined);
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

test('mẫu tin: giữ đúng text đã gửi, bỏ giá cũ ghi dưới mã sản phẩm, không nhận mã trống', () => {
  const settings = normalizeChatbotSettings({
    messageTemplates: {
      WELCOME: '  Xin chào mới  ', GENERAL_INFO: 'Có {count} sản phẩm', PRICE_QUOTE: 'Giá {price_1}',
      // Text cũ lưu dưới mã của một sản phẩm có trong danh mục: bỏ; giá không có trong danh mục thì giữ.
      PRICE_TUI_XANH: 'Dạ Túi Xanh 450g: 1 túi 174.000đ', PRICE_YEN_MACH_UC_NGUYEN_CAM: 'Dạ Yến Mạch 1kg 116.000đ'
    },
    deletedTemplateIds: ['WELCOME'],
    processingSteps: [{ id: 'duplicate_guard', enabled: false }]
  });
  assert.equal(settings.messageTemplates.WELCOME, 'Xin chào mới');
  assert.equal(settings.messageTemplates.GENERAL_INFO, 'Có {count} sản phẩm');
  assert.equal(settings.messageTemplates.PRICE_QUOTE, 'Giá {price_1}');
  assert.equal(settings.messageTemplates.PRICE_TUI_XANH, undefined);
  assert.equal(settings.messageTemplates.PRICE_YEN_MACH_UC_NGUYEN_CAM, 'Dạ Yến Mạch 1kg 116.000đ');
  assert.equal(settings.deletedTemplateIds, undefined);
  assert.equal(settings.processingSteps, undefined);
});

test('mẫu mặc định bổ sung cho mọi mã còn thiếu; mẫu đã tắt (để trống) không quay lại', () => {
  const settings = normalizeChatbotSettings({});
  assert.ok(settings.messageTemplates.WELCOME);
  assert.ok(settings.messageTemplates.ORDER_CONFIRMATION.includes('{total}'));
  assert.ok(settings.messageTemplates.GENERAL_INFO.includes('[[products]]'));
  // File cũ chỉ có 22 mẫu: giữ mẫu đã sửa, thêm PRICE_QUOTE... của bản mới.
  const partial = normalizeChatbotSettings({ messageTemplates: { WELCOME: 'Chào riêng', CSKH_HANDOFF: 'Chuyển', STORE_ADDRESS: '' } });
  assert.equal(partial.messageTemplates.WELCOME, 'Chào riêng');
  assert.ok(partial.messageTemplates.PRICE_QUOTE);
  assert.equal(partial.messageTemplates.STORE_ADDRESS, '');
});

test('trần mẫu tin: bỏ PRICE_ cũ TRƯỚC khi cắt; vượt trần thì giữ đủ mẫu seed, cắt mẫu tự tạo và cảnh báo', async () => {
  const { defaultMessageTemplates } = await import('../app/chatbot-templates.mjs');
  const { maxMessageTemplates } = await import('../app/chatbot-settings.mjs');
  const seedIds = Object.keys(defaultMessageTemplates());
  const room = maxMessageTemplates - seedIds.length;
  const custom = count => Object.fromEntries(Array.from({ length: count }, (_, index) => [`CUSTOM_${String(index).padStart(3, '0')}`, `Mẫu ${index}`]));
  // Vừa đủ trần sau khi bỏ giá cũ: không mất mẫu tự tạo nào (bản cũ cắt 200 trước khi lọc → mất mẫu cuối).
  const exact = normalizeChatbotSettings({ messageTemplates: { PRICE_TUI_XANH: 'giá cũ', ...custom(room) } });
  assert.equal(exact.messageTemplates.PRICE_TUI_XANH, undefined);
  assert.equal(exact.messageTemplates[`CUSTOM_${String(room - 1).padStart(3, '0')}`], `Mẫu ${room - 1}`);
  // Vượt trần 5 mẫu: mẫu seed còn đủ, 5 mẫu tự tạo cuối bị cắt, có console.warn.
  const warnings = [];
  const original = console.warn;
  console.warn = message => warnings.push(String(message));
  let over;
  try {
    over = normalizeChatbotSettings({ messageTemplates: { ...custom(room + 5) } });
  } finally { console.warn = original; }
  for (const id of seedIds) assert.ok(Object.hasOwn(over.messageTemplates, id), `mẫu seed ${id} phải còn`);
  assert.equal(Object.keys(over.messageTemplates).length, maxMessageTemplates);
  assert.equal(over.messageTemplates[`CUSTOM_${String(room + 4).padStart(3, '0')}`], undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bỏ 5 mẫu tự tạo/);
});

test('cascadeCanary / cascadeThreshold null hay "" = không gửi: mặc định khi không có cấu hình cũ, giữ giá trị cũ khi gộp', async () => {
  const { mergeChatbotSettingsPatch } = await import('../app/chatbot-settings.mjs');
  assert.equal(normalizeChatbotSettings({ cascadeCanary: null }).cascadeCanary, 100);
  assert.equal(normalizeChatbotSettings({ cascadeCanary: '' }).cascadeCanary, 100);
  assert.equal(normalizeChatbotSettings({ cascadeCanary: 0 }).cascadeCanary, 0, '0 là giá trị thật');
  const current = normalizeChatbotSettings({ cascadeCanary: 30, cascadeThreshold: 0.9, handoffKeywords: 'gặp người thật' });
  const saved = normalizeChatbotSettings({ cascadeCanary: null, cascadeThreshold: '' }, current);
  assert.equal(saved.cascadeCanary, 30);
  assert.equal(saved.cascadeThreshold, 0.9);
  assert.equal(saved.handoffKeywords, 'gặp người thật', 'bản vá không có handoffKeywords thì giữ');
  const merged = mergeChatbotSettingsPatch(current, { cascadeCanary: '', handoffKeywords: null, name: 'Bot mới' });
  assert.equal(merged.cascadeCanary, 30);
  assert.equal(merged.handoffKeywords, 'gặp người thật');
  assert.equal(merged.name, 'Bot mới');
});

test('followUps gộp sâu: bản vá một phần không xóa kịch bản, maxPerRun; kịch bản cùng id gộp trường', async () => {
  const { mergeChatbotSettingsPatch } = await import('../app/chatbot-settings.mjs');
  const current = normalizeChatbotSettings({ followUps: { enabled: true, maxPerRun: 7, scenarios: [
    { id: 'inbox-3h', name: 'Hộp thư 3 giờ', trigger: 'inbox-no-reply', delayHours: 3, templateId: 'FOLLOW_UP_INBOX_3H' },
    { id: 'comment-freeship', trigger: 'comment-no-reply', delayHours: 12, templateId: 'FOLLOW_UP_COMMENT_FREESHIP', freeShipDays: 3 }
  ] } });
  // Chỉ tắt bám đuổi: kịch bản và maxPerRun giữ nguyên.
  const off = normalizeChatbotSettings({ followUps: { enabled: false } }, current);
  assert.equal(off.followUps.enabled, false);
  assert.equal(off.followUps.maxPerRun, 7);
  assert.deepEqual(off.followUps.scenarios.map(item => item.id), ['inbox-3h', 'comment-freeship']);
  // Gửi danh sách kịch bản chỉ có { id, enabled }: giữ templateId, delayHours, freeShipDays.
  const patched = normalizeChatbotSettings(mergeChatbotSettingsPatch(current, { followUps: { scenarios: [{ id: 'comment-freeship', enabled: false }] } }));
  assert.equal(patched.followUps.enabled, true);
  assert.deepEqual(patched.followUps.scenarios.map(item => item.id), ['comment-freeship']);
  assert.equal(patched.followUps.scenarios[0].enabled, false);
  assert.equal(patched.followUps.scenarios[0].templateId, 'FOLLOW_UP_COMMENT_FREESHIP');
  assert.equal(patched.followUps.scenarios[0].freeShipDays, 3);
  assert.equal(patched.followUps.scenarios[0].delayHours, 12);
});
