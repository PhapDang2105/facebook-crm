import { renderChatbotReply } from './chatbot-templates.mjs';

export function parseDifyAnswer(answer) {
  const raw = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch { return { template_id: 'CSKH_HANDOFF' }; }
}

export function buildChatbotQuery({ conversation, message, recentMessages = [], settings }) {
  const history = recentMessages.slice(-12).map(item => `${item.direction === 'incoming' ? 'Khách' : 'Giọt Nắng'}: ${item.text || `[${item.type}]`}`).join('\n');
  return [
    `KÊNH: Facebook Messenger`,
    `KHÁCH HÀNG: ${conversation.name || 'Khách Facebook'}`,
    settings.instructions ? `HƯỚNG DẪN BỔ SUNG: ${settings.instructions}` : '',
    history ? `LỊCH SỬ GẦN NHẤT:\n${history}` : '',
    `TIN NHẮN CẦN TRẢ LỜI: ${message.text || `[Khách gửi ${message.type || 'tệp'}]`}`
  ].filter(Boolean).join('\n\n');
}

export async function requestDifyReply({ settings, conversation, message, recentMessages = [], fetchImpl = fetch }) {
  if (!settings.apiKey) throw new Error('Chatbot chưa có khóa API Dify.');
  const request = async conversationId => {
    const response = await fetchImpl(settings.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {},
        query: buildChatbotQuery({ conversation, message, recentMessages, settings }),
        response_mode: 'blocking',
        conversation_id: conversationId || '',
        user: conversation.psid
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || `Dify trả về lỗi ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return payload;
  };
  let payload;
  try {
    payload = await request(conversation.botConversationId);
  } catch (error) {
    if (error.status !== 404 || !conversation.botConversationId) throw error;
    payload = await request('');
  }
  return {
    ...renderChatbotReply(parseDifyAnswer(payload.answer)),
    conversationId: String(payload.conversation_id || '')
  };
}

export async function processChatbotChanges(changes, dependencies) {
  const { readSettings, listMessages, saveBotState, sendMessage, requestReply = requestDifyReply } = dependencies;
  const settings = await readSettings();
  if (!settings.enabled) return [];
  const results = [];
  for (const change of changes) {
    if (change.type !== 'message' || change.message?.direction !== 'incoming' || change.conversation?.botEnabled !== true) continue;
    const conversation = change.conversation;
    try {
      const keywords = settings.handoffKeywords.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
      const asksForHuman = keywords.some(keyword => String(change.message.text || '').toLowerCase().includes(keyword));
      const reply = asksForHuman || change.message.type !== 'text'
        ? renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' })
        : await requestReply({ settings, conversation, message: change.message, recentMessages: await listMessages(conversation.id) });
      if (settings.responseMode === 'automatic') {
        for (const text of reply.messages) await sendMessage(conversation, { text });
      }
      await saveBotState(conversation.id, {
        botConversationId: reply.conversationId || conversation.botConversationId || '',
        botLastTemplateId: reply.templateId,
        botLastReplyAt: Date.now(),
        botDraft: settings.responseMode === 'draft' ? reply.messages.join('\n\n') : '',
        ...(reply.handoff ? { botEnabled: false } : {})
      });
      results.push({ conversationId: conversation.id, mode: settings.responseMode, templateId: reply.templateId });
    } catch (error) {
      await saveBotState(conversation.id, { botLastError: error.message, botLastErrorAt: Date.now() });
      results.push({ conversationId: conversation.id, error: error.message });
    }
  }
  return results;
}
