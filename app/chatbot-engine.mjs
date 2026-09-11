import { renderChatbotReply } from './chatbot-templates.mjs';
import { getVertexAccessToken, vertexProjectId } from './vertex-auth.mjs';

export function parseModelAnswer(answer) {
  const raw = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch { return { template_id: 'CSKH_HANDOFF' }; }
}

export function buildChatbotQuery({ conversation, message, recentMessages = [], settings }) {
  const historyLimit = settings?.memoryEnabled === false ? 0 : Math.max(1, Number(settings?.memoryWindow) || 12);
  const history = historyLimit
    ? recentMessages.slice(-historyLimit).map(item => `${item.direction === 'incoming' ? 'Khách' : 'Giọt Nắng'}: ${item.text || `[${item.type}]`}`).join('\n')
    : '';
  return [
    `KÊNH: Facebook Messenger`,
    `KHÁCH HÀNG: ${conversation.name || 'Khách Facebook'}`,
    history ? `LỊCH SỬ GẦN NHẤT:\n${history}` : '',
    `TIN NHẮN CẦN TRẢ LỜI: ${message.text || `[Khách gửi ${message.type || 'tệp'}]`}`
  ].filter(Boolean).join('\n\n');
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function requestDirectModelReply({ settings, conversation, message, recentMessages = [], fetchImpl = fetch, rawResponse = false }) {
  const vertex = settings.provider === 'vertex';
  if (!settings.directApiKey && (!vertex || settings.directAuthType === 'api_key')) throw new Error('Chatbot chưa có khóa API hoặc access token của nhà cung cấp.');
  if (!settings.systemPrompt) throw new Error('Chatbot chưa có system prompt.');
  const attempts = 1 + Math.max(0, Number(settings.retryCount) || 0);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const anthropic = settings.directProtocol === 'anthropic';
      const model = settings.directModel || (vertex ? 'gemini-2.5-flash' : 'deepseek-v4-flash');
      const endpoint = vertex
        ? String(settings.directEndpoint || '').replace('PROJECT_ID', encodeURIComponent(vertexProjectId())).replace(/\/models\/[^/:]+:generateContent(?:\?.*)?$/, `/models/${encodeURIComponent(model)}:generateContent`)
        : settings.directEndpoint;
      const accessToken = vertex && settings.directAuthType !== 'api_key'
        ? (settings.directApiKey || await getVertexAccessToken({ fetchImpl }))
        : settings.directApiKey;
      const query = buildChatbotQuery({ conversation, message, recentMessages, settings });
      const body = vertex ? {
        systemInstruction: { parts: [{ text: settings.systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: query }] }],
        generationConfig: {
          temperature: 0.1,
          ...(settings.structuredOutput !== false ? { responseMimeType: 'application/json' } : {})
        }
      } : anthropic ? {
        model,
        max_tokens: 1024,
        system: settings.systemPrompt,
        messages: [{ role: 'user', content: query }]
      } : {
        model,
        messages: [{ role: 'system', content: settings.systemPrompt }, { role: 'user', content: query }],
        temperature: 0.1,
        ...(settings.structuredOutput !== false ? { response_format: { type: 'json_object' } } : {})
      };
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          ...(anthropic
            ? { 'x-api-key': settings.directApiKey, 'anthropic-version': '2023-06-01' }
            : vertex && settings.directAuthType === 'api_key'
            ? { 'x-goog-api-key': settings.directApiKey }
            : { Authorization: `Bearer ${accessToken}` }),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload?.error?.message || payload.message || `Nhà cung cấp model trả về lỗi ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      const answer = vertex
        ? payload?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim()
        : anthropic
          ? payload?.content?.map(part => part.type === 'text' ? part.text || '' : '').join('').trim()
        : payload?.choices?.[0]?.message?.content;
      if (!answer) throw new Error('Mô hình không trả về nội dung.');
      const parsedAnswer = parseModelAnswer(answer);
      if (rawResponse) return { raw: answer, parsed: parsedAnswer, conversationId: '' };
      return { ...renderChatbotReply(parsedAnswer, settings.messageTemplates), conversationId: '' };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await wait(Math.max(100, Number(settings.retryIntervalMs) || 1000));
    }
  }
  throw lastError;
}

export function requestChatbotReply(options) {
  return requestDirectModelReply(options);
}

export async function processChatbotChanges(changes, dependencies) {
  const { readSettings, listMessages, saveBotState, sendMessage, requestReply = requestChatbotReply } = dependencies;
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
        ? renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, settings.messageTemplates)
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
