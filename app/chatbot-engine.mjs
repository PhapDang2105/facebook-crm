import { renderChatbotReply } from './chatbot-templates.mjs';
import { productHint, resolveConversationProduct } from './processing/product-detect.mjs';
import { getVertexAccessToken, vertexProjectId } from './vertex-auth.mjs';

export function parseModelAnswer(answer) {
  const raw = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch { return { template_id: 'CSKH_HANDOFF' }; }
}

export function buildChatbotQuery({ conversation, message, recentMessages = [], settings, includeHistory = true }) {
  const historyLimit = settings?.memoryEnabled === false ? 0 : Math.max(1, Number(settings?.memoryWindow) || 12);
  const history = historyLimit
    ? recentMessages.slice(-historyLimit).map(item => `${item.direction === 'incoming' ? 'Khách' : 'Giọt Nắng'}: ${item.text || `[${item.type}]`}`).join('\n')
    : '';
  // What the customer names beats the ad they arrived from; the ad is used only
  // when the message itself says nothing about a product.
  const { product } = resolveConversationProduct({
    messageText: message.text,
    adTitle: conversation.referral?.adTitle,
    referralRef: conversation.referral?.ref
  });
  const hint = productHint(product);
  return [
    `KÊNH: Facebook Messenger`,
    `KHÁCH HÀNG: ${conversation.name || 'Khách Facebook'}`,
    hint,
    includeHistory && history ? `LỊCH SỬ GẦN NHẤT:\n${history}` : '',
    `TIN NHẮN CẦN TRẢ LỜI: ${message.text || `[Khách gửi ${message.type || 'tệp'}]`}`
  ].filter(Boolean).join('\n\n');
}

function buildMemoryTurns({ recentMessages = [], message, settings }) {
  if (settings?.memoryEnabled === false) return [];
  const limit = Math.max(1, Number(settings?.memoryWindow) || 12);
  return recentMessages
    .filter(item => item && item.id !== message?.id && String(item.text || '').trim())
    .slice(-limit)
    .map(item => ({
      role: item.direction === 'incoming' ? 'user' : 'model',
      text: String(item.text).trim()
    }));
}

function mergeAnthropicTurns(turns) {
  const merged = [];
  for (const turn of turns) {
    const role = turn.role === 'user' ? 'user' : 'assistant';
    const previous = merged.at(-1);
    if (previous?.role === role) previous.content += `\n${turn.text}`;
    else merged.push({ role, content: turn.text });
  }
  return merged;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function requestDirectModelReply(options) {
  const { settings, conversation, message, recentMessages = [], fetchImpl = fetch, rawResponse = false } = options;
  const vertex = settings.provider === 'vertex';
  if (!settings.directApiKey && (!vertex || settings.directAuthType === 'api_key')) throw new Error('Chatbot chưa có khóa API hoặc access token của nhà cung cấp.');
  if (!settings.systemPrompt) throw new Error('Chatbot chưa có system prompt.');
  const attempts = 1 + Math.max(0, Number(settings.retryCount) || 0);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const anthropic = settings.directProtocol === 'anthropic';
      const model = settings.directModel || (vertex ? 'gemini-2.5-flash' : 'deepseek-v4-flash');
      const configuredEndpoint = String(settings.directEndpoint || '');
      const endpoint = vertex
        ? (configuredEndpoint.includes('PROJECT_ID')
            ? configuredEndpoint.replace('PROJECT_ID', encodeURIComponent(vertexProjectId()))
            : configuredEndpoint)
          .replace(/\/models\/[^/:]+:generateContent(?:\?.*)?$/, `/models/${encodeURIComponent(model)}:generateContent`)
        : settings.directEndpoint;
      const accessToken = vertex && settings.directAuthType !== 'api_key'
        ? (settings.directApiKey || await getVertexAccessToken({ fetchImpl }))
        : settings.directApiKey;
      const memoryTurns = buildMemoryTurns({ recentMessages, message, settings });
      const query = buildChatbotQuery({ conversation, message, recentMessages, settings, includeHistory: false });
      const body = vertex ? {
        systemInstruction: { parts: [{ text: settings.systemPrompt }] },
        contents: [
          ...memoryTurns.map(turn => ({ role: turn.role, parts: [{ text: turn.text }] })),
          { role: 'user', parts: [{ text: query }] }
        ],
        generationConfig: {
          ...(settings.structuredOutput !== false ? { responseMimeType: 'application/json' } : {})
        }
      } : anthropic ? {
        model,
        max_tokens: 1024,
        system: settings.systemPrompt,
        messages: mergeAnthropicTurns([...memoryTurns, { role: 'user', text: query }])
      } : {
        model,
        messages: [
          { role: 'system', content: settings.systemPrompt },
          ...memoryTurns.map(turn => ({ role: turn.role === 'model' ? 'assistant' : 'user', content: turn.text })),
          { role: 'user', content: query }
        ],
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
      return { ...renderChatbotReply(parsedAnswer, settings.messageTemplates, settings.deletedTemplateIds, options.context || {}), conversationId: '' };
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

/** Strips Vietnamese tone marks so a handoff keyword still matches when the
 *  customer types without diacritics, which is how most people type on a phone. */
export function foldVietnamese(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

export async function processChatbotChanges(changes, dependencies) {
  const { readSettings, listMessages, saveBotState, sendMessage, createOrder, sendReceipt, requestReply = requestChatbotReply } = dependencies;
  const settings = await readSettings();
  if (!settings.enabled) return [];
  const results = [];
  for (const change of changes) {
    if (change.type !== 'message' || change.message?.direction !== 'incoming' || change.conversation?.botEnabled !== true) continue;
    const conversation = change.conversation;
    try {
      const keywords = settings.handoffKeywords.split(',').map(item => foldVietnamese(item.trim())).filter(Boolean);
      const incomingText = foldVietnamese(change.message.text);
      const asksForHuman = keywords.some(keyword => incomingText.includes(keyword));
      // The basket the customer named earlier travels with the request so a later
      // "0385805790" alone is still enough to close the same order.
      const replyContext = { pendingOrder: conversation.pendingOrder, now: Date.now() };
      const reply = asksForHuman || change.message.type !== 'text'
        ? renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, settings.messageTemplates, settings.deletedTemplateIds, replyContext)
        : await requestReply({ settings, conversation, message: change.message, recentMessages: await listMessages(conversation.id), context: replyContext });
      // The order is persisted BEFORE anything is sent. Sending first meant a
      // failed order left the customer holding a confirmation for an order that
      // did not exist, and a retried webhook sent the whole reply a second time.
      const outcome = settings.responseMode === 'automatic' && reply.order && createOrder
        ? await createOrder(conversation, reply.order, {
            sourceMessageId: String(change.message.mid || change.message.id || '')
          })
        : null;
      const order = outcome?.order || null;
      const alreadyHandled = Boolean(outcome) && outcome.created === false;
      if (settings.responseMode === 'automatic' && !alreadyHandled) {
        for (const text of reply.messages) await sendMessage(conversation, { text });
        // The receipt closes the exchange, so it is sent after the reply text and
        // never before it — the order itself was already persisted above.
        if (order && sendReceipt) await sendReceipt(conversation, order);
      }
      await saveBotState(conversation.id, {
        botConversationId: reply.conversationId || conversation.botConversationId || '',
        botLastTemplateId: reply.templateId,
        botLastReplyAt: Date.now(),
        botDraft: settings.responseMode === 'draft' ? reply.messages.join('\n\n') : '',
        botLastError: '',
        botLastErrorAt: 0,
        // undefined leaves the stored basket alone; null clears it once ordered.
        ...(reply.pendingOrder !== undefined ? { pendingOrder: reply.pendingOrder } : {}),
        ...(reply.handoff ? { botEnabled: false } : {})
      });
      results.push({
        conversationId: conversation.id,
        mode: settings.responseMode,
        templateId: reply.templateId,
        ...(order ? { orderId: order.id } : {}),
        ...(alreadyHandled ? { duplicate: true } : {})
      });
    } catch (error) {
      await saveBotState(conversation.id, { botLastError: error.message, botLastErrorAt: Date.now() });
      results.push({ conversationId: conversation.id, error: error.message });
    }
  }
  return results;
}
