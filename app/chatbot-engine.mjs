import { buildTemplatePrompt, pickVariant, renderChatbotReply } from './chatbot-templates.mjs';
import { chatTimeoutMs, inferAddress } from './processing/address-ai.mjs';
import { describeDeliveryAddress, mergeAddressFragment } from './processing/locations.mjs';
import { extractVietnamesePhone } from './processing/customer-info.mjs';
import { autoLabelEventsFor, foldVietnamese } from './processing/auto-label.mjs';
import { productHint, resolveConversationProduct } from './processing/product-detect.mjs';
import { buildCatalogPrompt } from './processing/pricing.mjs';
import { getVertexAccessToken, vertexProjectId } from './vertex-auth.mjs';

/**
 * Địa chỉ khách nhắn mà bộ đọc luật không tách đủ ba cấp thì hỏi AI trước khi
 * bot hỏi lại khách; câu trả lời chỉ được dùng khi khớp danh mục kho. Đổi
 * thẳng Customer_Address trong JSON của mô hình nên phần sau (ghép địa chỉ,
 * hỏi lại, lên đơn) không cần biết địa chỉ đến từ đâu.
 */
export async function refineAddressWithAi(parsed, context = {}, settings = {}, fetchImpl) {
  const fresh = String(parsed?.Customer_Address || '').trim();
  const merged = mergeAddressFragment(fresh !== '0' ? fresh : '', context.pendingOrder?.address || '');
  if (!merged || describeDeliveryAddress(merged).complete) return parsed;
  const guess = await inferAddress(merged, { settings, fetchImpl, timeoutMs: chatTimeoutMs }).catch(() => null);
  if (guess?.canonical) parsed.Customer_Address = guess.canonical;
  return parsed;
}

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
    referralRef: conversation.referral?.ref,
    postText: conversation.post?.message
  });
  const hint = productHint(product);
  // What the customer already gave in earlier messages, so the model neither
  // asks for it again nor drops it from the JSON.
  const pending = conversation.pendingOrder || {};
  const remembered = [
    pending.items?.length ? `Sản phẩm đang chờ lên đơn: ${pending.items.map(item => `${item.product} x${item.quantity}`).join(', ')}` : '',
    pending.phone ? `Số điện thoại đã có: ${pending.phone}` : '',
    pending.address ? `Địa chỉ đã có: ${pending.address}${pending.addressAsks ? ' (đang hỏi khách bổ sung phần còn thiếu; khách nhắn phần nào thì ghi phần đó vào Customer_Address)' : ''}` : ''
  ].filter(Boolean).join('\n');
  return [
    `KÊNH: ${conversation.source === 'comment' ? 'Bình luận Facebook' : 'Facebook Messenger'}`,
    `KHÁCH HÀNG: ${conversation.name || 'Khách Facebook'}`,
    hint,
    remembered ? `DỮ LIỆU ĐÃ LƯU:\n${remembered}` : '',
    includeHistory && history ? `LỊCH SỬ GẦN NHẤT:\n${history}` : '',
    `TIN NHẮN CẦN TRẢ LỜI: ${message.text || `[Khách gửi ${message.type || 'tệp'}]`}`
  ].filter(Boolean).join('\n\n');
}

/**
 * The saved prompt plus the live catalogue and template blocks. Exported so
 * the settings screen can preview exactly what the model receives. The saved
 * prompt holds only the rules; products, prices, gifts and template ids are
 * appended from Cài đặt and Thiết lập tin nhắn on every request.
 */
export function composeSystemPrompt(basePrompt, templates = {}) {
  return [String(basePrompt || '').trim(), buildCatalogPrompt(), buildTemplatePrompt(templates)].filter(Boolean).join('\n\n');
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
  // The catalogue is appended on every request, never baked into the saved
  // prompt: a product added in settings is known to the model on its next reply.
  const systemPrompt = composeSystemPrompt(settings.systemPrompt, settings.messageTemplates);
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
        systemInstruction: { parts: [{ text: systemPrompt }] },
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
        system: systemPrompt,
        messages: mergeAnthropicTurns([...memoryTurns, { role: 'user', text: query }])
      } : {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
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
      await refineAddressWithAi(parsedAnswer, options.context || {}, settings, fetchImpl);
      return { ...renderChatbotReply(parsedAnswer, settings.messageTemplates, options.context || {}), conversationId: '' };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await wait(Math.max(100, Number(settings.retryIntervalMs) || 1000));
    }
  }
  throw lastError;
}

// Mỗi hội thoại một hàng đợi: tin thứ hai của cùng một khách chờ tin thứ nhất
// được trả lời xong. Pancake bắn mỗi tin một webhook (Meta cũng có lúc tách),
// nên không có hàng này thì hai lần gọi mô hình chạy song song, không thấy
// nhau, và khách nhận hai câu mâu thuẫn ("chị quan tâm loại nào?" rồi ngay
// sau đó "cho em xin địa chỉ").
const conversationQueues = new Map();
function queueForConversation(id, task) {
  const previous = conversationQueues.get(id) || Promise.resolve();
  const run = previous.then(task, task);
  const tracked = run.catch(() => {}).then(() => { if (conversationQueues.get(id) === tracked) conversationQueues.delete(id); });
  conversationQueues.set(id, tracked);
  return run;
}

// Tin liền nhau của khách ("C đặt 2 gói" / "Giảm ko e") gộp thành một câu hỏi
// cho mô hình: chỉ tin chữ, gửi sau câu trả lời gần nhất của Page, trong vòng
// mười phút, nhiều nhất năm tin.
const bundleWindowMs = 10 * 60 * 1000;
const bundleLimit = 5;

/** Tin khách chưa được trả lời, tính cả tin đang xử lý; tin cũ đứng trước. */
export function unansweredCustomerMessages(recentMessages, current) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  const lastReply = list.findLastIndex(item => item?.direction === 'outgoing');
  const now = Number(current?.createdAt) || Date.now();
  const since = list.slice(lastReply + 1).filter(item => item?.direction === 'incoming' && (item.type || 'text') === 'text'
    && String(item.text || '').trim() && now - (Number(item.createdAt) || now) <= bundleWindowMs);
  const bundle = since.some(item => item.id && item.id === current?.id) ? since : [...since, current];
  return bundle.slice(-bundleLimit);
}

/** Đã có tin khách mới hơn tin đang xử lý: tin này nhường, tin sau trả lời gộp cả hai. */
export function hasNewerCustomerMessage(recentMessages, current) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  const index = list.findIndex(item => item?.id && item.id === current?.id);
  const after = index >= 0 ? list.slice(index + 1) : list.filter(item => (Number(item?.createdAt) || 0) > (Number(current?.createdAt) || Infinity));
  return after.some(item => item?.direction === 'incoming');
}

export async function processChatbotChanges(changes, dependencies) {
  const { readSettings } = dependencies;
  const settings = await readSettings();
  if (!settings.enabled) return [];
  const results = [];
  for (const change of changes) {
    if (change.type !== 'message' || change.message?.direction !== 'incoming' || !change.conversation) continue;
    await queueForConversation(change.conversation.id, () => answerChange(change, settings, results, dependencies));
  }
  return results;
}

async function answerChange(change, settings, results, dependencies) {
  const { listMessages, getConversation, saveBotState, sendMessage, createOrder, sendReceipt, moderateComment, requestReply = requestDirectModelReply } = dependencies;
  // Bản mới nhất của hội thoại: tin đứng trước trong hàng có thể vừa lưu giỏ
  // hàng, hay nhân viên vừa tắt bot. Every thread is answered unless staff
  // switched the bot off for it.
  const conversation = (getConversation ? await getConversation(change.conversation.id).catch(() => null) : null) || change.conversation;
  if (conversation.botEnabled === false) return;
  try {
    const recent = await listMessages(conversation.id);
    if (hasNewerCustomerMessage(recent, change.message)) {
      results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
      return;
    }
    const bundle = change.message.type === 'text' ? unansweredCustomerMessages(recent, change.message) : [change.message];
    const bundled = new Set(bundle.map(item => item?.id).filter(Boolean));
    const message = bundle.length > 1
      ? { ...change.message, text: bundle.map(item => String(item.text || '').trim()).join('\n') }
      : change.message;
    const keywords = settings.handoffKeywords.split(',').map(item => foldVietnamese(item.trim())).filter(Boolean);
    const incomingText = foldVietnamese(message.text);
    const asksForHuman = keywords.some(keyword => incomingText.includes(keyword));
    // The basket the customer named earlier travels with the request so a later
    // "0385805790" alone is still enough to close the same order.
    // Đơn gần nhất của khách: để "lấy thêm…" ngay sau khi chốt không gộp lại món đã đặt.
    const recentOrder = (Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [])
      .reduce((latest, order) => ((Number(order?.createdAt) || 0) > (Number(latest?.createdAt) || 0) ? order : latest), null);
    const replyContext = { pendingOrder: conversation.pendingOrder, recentOrder, now: Date.now(), customer: { gender: conversation.gender || '', name: conversation.name || '' } };
    const reply = asksForHuman || message.type !== 'text'
      ? renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, settings.messageTemplates, replyContext)
      : await requestReply({ settings, conversation, message, recentMessages: recent.filter(item => !bundled.has(item?.id)), context: replyContext });
    // Trong lúc chờ mô hình khách nhắn thêm: bỏ câu này, tin sau trả lời gộp.
    if (message.type === 'text' && hasNewerCustomerMessage(await listMessages(conversation.id), change.message)) {
      results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
      return;
    }
    // The order is persisted BEFORE anything is sent. Sending first meant a
    // failed order left the customer holding a confirmation for an order that
    // did not exist, and a retried webhook sent the whole reply a second time.
    const isComment = conversation.source === 'comment';
    const outcome = settings.responseMode === 'automatic' && reply.order && createOrder && !isComment
      ? await createOrder(conversation, reply.order, {
          sourceMessageId: String(change.message.mid || change.message.id || '')
        })
      : null;
    const order = outcome?.order || null;
    const alreadyHandled = Boolean(outcome) && outcome.created === false;
    let privateError = '';
    if (settings.responseMode === 'automatic' && isComment) {
      // Under a comment: the full answer goes to the person's Messenger as a
      // private reply (Facebook allows one per comment, so the messages are
      // joined), and one short public reply tells them to check their inbox.
      // Orders are never created from a comment — the customer is asked to
      // continue in Messenger, where the address exchange is private.
      const intro = renderChatbotReply({ template_id: 'COMMENT_PRIVATE_REPLY' }, settings.messageTemplates, replyContext);
      const privateText = [...(intro.templateId === 'COMMENT_PRIVATE_REPLY' ? intro.messages : []), ...reply.messages].join('\n\n');
      // Messenger can refuse the private reply — most often error #10, another
      // app holding the thread (Handover Protocol). Telling the customer to
      // check an inbox that stays empty loses the lead, so the public reply
      // then asks them to message the Page instead, and the error is kept
      // for the customer panel.
      if (privateText) {
        try {
          await sendMessage(conversation, { text: privateText, privateReply: true });
        } catch (error) {
          privateError = error.message;
        }
      }
      // Ảnh của mẫu (ảnh sản phẩm) đi sau tin nhắn riêng như tin Messenger
      // thường vào hộp thư của khách. Facebook chỉ cho một tin nhắn riêng mỗi
      // bình luận nên tin đó phải là bảng giá; ảnh gửi thêm được thì tốt, bị
      // chặn (khách chưa nhắn lại) thì bỏ qua, không báo lỗi.
      if (!privateError && reply.images?.length && getConversation) {
        const inbox = await getConversation(`${conversation.pageId}:${conversation.psid}`).catch(() => null);
        for (const imageUrl of inbox ? reply.images : []) {
          try {
            await sendMessage(inbox, { imageUrl });
          } catch {
            break;
          }
        }
      }
      const publicReply = renderChatbotReply({ template_id: privateError ? 'COMMENT_PUBLIC_FALLBACK' : 'COMMENT_PUBLIC_REPLY' }, settings.messageTemplates, replyContext);
      for (const text of pickVariant(publicReply)) await sendMessage(conversation, { text });
      // Like the comment so the customer sees it was noticed; hide it when it
      // carries a phone number (or always, per settings) so competitors
      // cannot lift the lead from the post.
      if (moderateComment) {
        const hide = settings.commentHide === 'all' || (settings.commentHide === 'phone' && Boolean(extractVietnamesePhone(message.text)));
        await moderateComment(conversation, change.message, { like: settings.commentLike !== false, hide }).catch(() => {});
      }
    } else if (settings.responseMode === 'automatic' && !alreadyHandled) {
      // Theo đúng thứ tự của mẫu: ảnh đặt đầu mẫu đi trước bảng giá, ảnh đặt
      // cuối đi sau chữ. Mẫu không có dãy gửi thì chữ trước, ảnh sau.
      const parts = reply.parts || [...reply.messages.map(text => ({ type: 'text', text })), ...(reply.images || []).map(url => ({ type: 'image', url }))];
      // Ảnh không gửi được (Pancake/Facebook từ chối tệp) thì bỏ ảnh đó, chữ
      // vẫn phải tới khách; lỗi ảnh ghi lại cho panel khách thay vì chặn cả câu.
      const imageErrors = [];
      for (const part of parts) {
        if (part.type !== 'image') { await sendMessage(conversation, { text: part.text }); continue; }
        try {
          await sendMessage(conversation, { imageUrl: part.url });
        } catch (error) {
          imageErrors.push(error.message);
        }
      }
      if (imageErrors.length) privateError = privateError || `ảnh không gửi được: ${imageErrors[0]}`;
      // The receipt closes the exchange, so it is sent after the reply text and
      // never before it — the order itself was already persisted above.
      if (order && sendReceipt) await sendReceipt(conversation, order);
    }
    const labelEvents = autoLabelEventsFor({
      order,
      handoff: reply.handoff,
      text: message.text,
      templateId: reply.templateId,
      keywords: settings.complaintKeywords
    });
    await saveBotState(conversation.id, {
      botConversationId: reply.conversationId || conversation.botConversationId || '',
      botLastTemplateId: reply.templateId,
      botLastReplyAt: Date.now(),
      botDraft: settings.responseMode === 'draft' ? reply.messages.join('\n\n') : '',
      botLastError: privateError ? `Không nhắn riêng được: ${privateError}` : '',
      botLastErrorAt: privateError ? Date.now() : 0,
      // undefined leaves the stored basket alone; null clears it once ordered.
      ...(reply.pendingOrder !== undefined && !isComment ? { pendingOrder: reply.pendingOrder } : {}),
      ...(reply.handoff ? { botEnabled: false } : {}),
      // Thẻ tự động: bot chỉ nói chuyện gì vừa xảy ra (chốt đơn / chuyển nhân
      // viên / khách khiếu nại); thẻ nào được gắn là do Cài đặt → Tin nhắn.
      // Thẻ được cộng thêm, không bao giờ xoá thẻ nhân viên đã gắn.
      ...(labelEvents.length ? { addLabelEvents: labelEvents } : {})
    });
    results.push({
      conversationId: conversation.id,
      mode: settings.responseMode,
      templateId: reply.templateId,
      ...(bundle.length > 1 ? { bundled: bundle.length } : {}),
      ...(order ? { orderId: order.id } : {}),
      ...(alreadyHandled ? { duplicate: true } : {})
    });
  } catch (error) {
    await saveBotState(conversation.id, { botLastError: error.message, botLastErrorAt: Date.now() });
    results.push({ conversationId: conversation.id, error: error.message });
  }
}
