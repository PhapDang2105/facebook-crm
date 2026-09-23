import { buildTemplatePrompt, pickVariant, renderChatbotReply } from './chatbot-templates.mjs';
import { chatTimeoutMs, inferAddress } from './processing/address-ai.mjs';
import { describeDeliveryAddress, mergeAddressFragment } from './processing/locations.mjs';
import { extractVietnamesePhone } from './processing/customer-info.mjs';
import { autoLabelEventsFor, foldVietnamese } from './processing/auto-label.mjs';
import { productHint, resolveConversationProduct } from './processing/product-detect.mjs';
import { buildCatalogPrompt } from './processing/pricing.mjs';
import { isOrderStep } from './processing/pending-order.mjs';
import { findProductBySku, getCatalogProducts } from './processing/catalog.mjs';

// Giỏ Facebook Shop (attachment cart_order) mang SKU: một SKU sản phẩm → bảng
// giá sản phẩm đó; SKU combo của Shop ("CB2-XANH-Z450" = 2 Túi Xanh,
// "CB-VANGG+NAU" = Vàng + Nâu) → xin SĐT/địa chỉ với đúng giỏ. SKU lạ → để model.
export function cartQuickReply(cart, templates = {}, context = {}) {
  const items = [];
  for (const line of Array.isArray(cart) ? cart : []) {
    const sku = String(line?.sku || '').toUpperCase();
    const quantity = Math.max(1, Number(line?.quantity) || 1);
    const product = findProductBySku(sku);
    if (product) { items.push({ product: product.name, quantity }); continue; }
    const combo = sku.match(/^CB(\d*)-([A-Z0-9+]+?)(?:-Z\d+|-H\d+)?$/);
    if (!combo) return null;
    const each = Math.max(1, Number(combo[1]) || 1);
    for (const token of combo[2].split('+')) {
      const colour = token.replace(/G$/, '').toLowerCase();
      const found = getCatalogProducts().find(item => item.active !== false && /^gra-/i.test(item.sku || '') && String(item.sku || '').toLowerCase().includes(`-${colour}-`));
      if (!found) return null;
      items.push({ product: found.name, quantity: each * quantity });
    }
  }
  if (!items.length || !templates.PRICE_QUOTE) return null;
  // Khách bấm "Mua" là đã chọn: đi thẳng bước xin SĐT/địa chỉ (kèm gợi ý 2 túi
  // khi chỉ 1 túi), không gửi bảng giá rồi hỏi "cần thêm thông tin nào" —
  // giỏ 1 SKU trước đây chỉ chốt được 22%.
  const slots = ['Product_N1', 'No_A', 'Product_N2', 'No_B', 'Product_N3', 'No_C'];
  const value = { template_id: 'ORDER_ADDRESS' };
  items.slice(0, 3).forEach((item, index) => { value[slots[index * 2]] = item.product; value[slots[index * 2 + 1]] = String(item.quantity); });
  return renderChatbotReply(value, templates, context);
}
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

/** Bài đăng/quảng cáo là phiên livestream nhiều sản phẩm ("Săn deal hời", "live tối nay"): không có sản phẩm cụ thể để báo giá. */
export function isLivestreamPost(conversation) {
  const text = [conversation?.post?.message, conversation?.referral?.adTitle].filter(Boolean).join(' ');
  return /\b(live|livestream|phien live|san deal)\b/i.test(foldVietnamese(text));
}

export function parseModelAnswer(answer) {
  const raw = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Mô hình trả JSON hỏng (hay JSON hợp lệ nhưng không phải object: null, mảng,
  // chuỗi): gửi bảng giá chung thay vì chuyển người và tắt bot.
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { template_id: 'GENERAL_INFO' };
  } catch { return { template_id: 'GENERAL_INFO' }; }
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
    Array.isArray(conversation.recentComments) && conversation.recentComments.length ? `BÌNH LUẬN GẦN NHẤT CỦA KHÁCH DƯỚI BÀI: ${conversation.recentComments.map(text => `"${text}"`).join(' · ')}` : '',
    !hint && isLivestreamPost(conversation) ? 'BÀI VIẾT: phiên livestream giới thiệu nhiều sản phẩm (không có sản phẩm cụ thể); khách hỏi giá chung thì GENERAL_INFO, hỏi "hộp"/"gói nhỏ" là hộp 10 gói nhỏ (PACKAGING_INFO).' : '',
    remembered ? `DỮ LIỆU ĐÃ LƯU:\n${remembered}` : '',
    includeHistory && history ? `LỊCH SỬ GẦN NHẤT:\n${history}` : '',
    `TIN NHẮN CẦN TRẢ LỜI: ${message.text || `[Khách gửi ${message.type || 'tệp'}]`}`,
    // Khách bấm "Trả lời" một tin cụ thể rồi gõ "." hay "Ok": nêu tin gốc để model biết đang nói về gì.
    message.replyTo?.text ? `(Khách đang trả lời tin ${message.replyTo.name === 'Bạn' ? 'của Giọt Nắng' : 'của chính khách'}: "${String(message.replyTo.text).slice(0, 300)}")` : ''
  ].filter(Boolean).join('\n\n');
}

/**
 * The saved prompt plus the live catalogue and template blocks. Exported so
 * the settings screen can preview exactly what the model receives. The saved
 * prompt holds only the rules; products, prices, gifts and template ids are
 * appended from Cài đặt and Thiết lập tin nhắn on every request.
 */
export function composeSystemPrompt(basePrompt, templates = {}) {
  return [String(basePrompt || '').trim(), buildCatalogPrompt(), buildTemplatePrompt(templates, basePrompt)].filter(Boolean).join('\n\n');
}

function buildMemoryTurns({ recentMessages = [], message, settings }) {
  if (settings?.memoryEnabled === false) return [];
  const limit = Math.max(1, Number(settings?.memoryWindow) || 12);
  return recentMessages
    .filter(item => item && item.id !== message?.id && String(item.text || '').trim())
    .slice(-limit)
    // Tiết kiệm token: tin của Page (bảng giá, xác nhận đơn dài vài trăm chữ) chỉ
    // giữ đoạn đầu — model chỉ cần biết đã gửi gì; tin khách giữ tối đa 300 ký tự.
    .map(item => {
      const text = String(item.text).replace(/\s+/g, ' ').trim();
      const limit = item.direction === 'incoming' ? 300 : 160;
      return { role: item.direction === 'incoming' ? 'user' : 'model', text: text.length > limit ? `${text.slice(0, limit)}…` : text };
    });
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

// Ảnh khách gửi (ảnh quảng cáo, bao bì, bill chuyển khoản…) đưa thẳng cho
// Gemini xem cùng câu hỏi: model nhận ra sản phẩm trong ảnh thay vì bot chỉ
// đáp "đã nhận hình". Tối đa 3 ảnh, mỗi ảnh nén dưới 500 KB; ảnh không tải
// được thì bỏ qua, chữ vẫn gửi.
export async function collectImageParts(message, fetchImpl = fetch) {
  const urls = [...new Set([message?.dataUrl, ...(Array.isArray(message?.images) ? message.images : [])].map(item => String(item || '').trim()).filter(Boolean))].slice(0, 3);
  if (!urls.length) return [];
  const parts = [];
  for (const url of urls) {
    try {
      let file;
      const inline = url.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
      if (inline) file = { buffer: Buffer.from(inline[2].replace(/\s+/g, ''), 'base64'), mime: inline[1].toLowerCase() };
      else {
        const { readImageForUpload, fitImageForPancake } = await import('./pancake.mjs');
        file = await fitImageForPancake(await readImageForUpload(url, fetchImpl));
      }
      if (!file?.buffer?.length || !/^image\//.test(file.mime || '')) continue;
      parts.push({ inlineData: { mimeType: file.mime, data: file.buffer.toString('base64') } });
    } catch (error) {
      console.warn(`Không đọc được ảnh khách gửi để đưa cho model: ${error.message}`);
    }
  }
  return parts;
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
  const primaryModel = settings.directModel || (vertex ? 'gemini-2.5-flash' : 'deepseek-v4-flash');
  // Model xem trước (gemini-3-flash-preview) dùng hạn mức chia sẻ, giờ cao điểm
  // Vertex trả 429 "Resource exhausted" hàng loạt. Khi đó: thử lại ít nhất 3 lần,
  // nghỉ lùi dần (2s → 4s → 8s), vẫn hỏng thì gọi model dự phòng (GA, hạn mức riêng).
  const fallbackModel = String(settings.fallbackModel ?? (vertex ? 'gemini-2.5-flash' : '')).trim();
  const capacityAttempts = Math.max(attempts, 3);
  const baseWait = Math.max(100, Number(settings.retryIntervalMs) || 1000);
  const capacityWait = Math.max(10, Number(settings.capacityWaitMs) || 2000);
  const callModel = async model => {
      const anthropic = settings.directProtocol === 'anthropic';
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
      const imageParts = vertex && message?.type === 'image' ? await collectImageParts(message, fetchImpl) : [];
      const body = vertex ? {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [
          ...memoryTurns.map(turn => ({ role: turn.role, parts: [{ text: turn.text }] })),
          { role: 'user', parts: [...imageParts, { text: query }] }
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
  };
  let model = primaryModel;
  let usingFallback = false;
  let attempt = 0;
  for (;;) {
    try {
      return await callModel(model);
    } catch (error) {
      const capacity = isCapacityError(error);
      attempt += 1;
      const limit = capacity ? (usingFallback ? 2 : capacityAttempts) : attempts;
      if (attempt < limit) {
        const delay = capacity ? Math.min(10000, capacityWait * 2 ** (attempt - 1)) : baseWait;
        if (capacity) console.warn(`Model ${model} hết hạn mức/quá tải (${String(error.message).slice(0, 60)}), thử lại sau ${delay}ms (lần ${attempt}).`);
        await wait(delay);
        continue;
      }
      if (capacity && !usingFallback && fallbackModel && fallbackModel !== primaryModel) {
        console.warn(`Model ${model} vẫn hết hạn mức sau ${attempt} lần, chuyển sang model dự phòng ${fallbackModel}.`);
        usingFallback = true;
        model = fallbackModel;
        attempt = 0;
        continue;
      }
      throw error;
    }
  }
}

/** 429 (hết hạn mức) hay 503 (quá tải): lỗi tạm, đáng thử lại; lỗi khác (401, prompt sai…) thì không. */
export function isCapacityError(error) {
  const status = Number(error?.status) || 0;
  return status === 429 || status === 503 || /resource exhausted|rate limit|quota|overloaded|currently unavailable/i.test(String(error?.message || ''));
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

// Ảnh sản phẩm chưa gửi được sau tin nhắn riêng từ bình luận (Facebook chặn
// tới khi khách nhắn vào Messenger): giữ theo khách, gửi ngay khi khách nhắn lại.
const pendingInboxImages = new Map();
const pendingImagesTtl = 3 * 24 * 60 * 60 * 1000;
export function rememberPendingImages(pageId, psid, images) {
  if (!pageId || !psid || !images?.length) return;
  pendingInboxImages.set(`${pageId}:${psid}`, { images: [...new Set(images)], at: Date.now() });
}
export function takePendingImages(pageId, psid) {
  const key = `${pageId}:${psid}`;
  const entry = pendingInboxImages.get(key);
  if (!entry) return [];
  pendingInboxImages.delete(key);
  return Date.now() - entry.at > pendingImagesTtl ? [] : entry.images;
}

export async function processChatbotChanges(changes, dependencies) {
  const { readSettings } = dependencies;
  const settings = await readSettings();
  if (!settings.enabled) return [];
  const results = [];
  for (const change of changes) {
    // `updated`: tin cũ vừa có thêm dữ liệu (ảnh có URL) — hộp thư vẽ lại, bot không trả lời lần hai.
    if (change.type !== 'message' || change.message?.direction !== 'incoming' || !change.conversation || change.updated) continue;
    try {
      // Hàng đợi theo KHÁCH (pageId:psid): bình luận và hộp thư của cùng một
      // người nối tiếp nhau, hai bình luận liền nhau không chạy song song.
      const queueKey = change.conversation.pageId && change.conversation.psid ? `${change.conversation.pageId}:${change.conversation.psid}` : change.conversation.id;
      await queueForConversation(queueKey, () => answerChange(change, settings, results, dependencies));
    } catch (error) {
      // Một hội thoại hỏng (kho tin không ghi được…) không làm rơi các tin còn lại trong lô.
      results.push({ conversationId: change.conversation.id, error: error.message });
    }
  }
  return results;
}

async function answerChange(change, settings, results, dependencies) {
  const { listMessages, getConversation, saveBotState, sendMessage, createOrder, updateOrder, cancelOrder, sendReceipt, moderateComment, requestReply = requestDirectModelReply } = dependencies;
  // Bản mới nhất của hội thoại: tin đứng trước trong hàng có thể vừa lưu giỏ
  // hàng, hay nhân viên vừa tắt bot. Every thread is answered unless staff
  // switched the bot off for it.
  const conversation = (getConversation ? await getConversation(change.conversation.id).catch(() => null) : null) || change.conversation;
  if (conversation.botEnabled === false) return;
  try {
    const recent = await listMessages(conversation.id);
    const askedAt = Number(change.message?.createdAt) || 0;
    if (change.delayedRetry && recent.some(item => item?.direction === 'outgoing' && (Number(item?.createdAt) || 0) >= askedAt)) {
      results.push({ conversationId: conversation.id, skipped: 'đã có người trả lời' });
      return;
    }
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
    // Luồng bình luận đọc hộp thư cùng khách: xưng hô nhân viên đã chọn, và đơn
    // khách đã đặt trong Messenger (bình luận "đã đặt", "hủy đơn" phải thấy đơn thật).
    const inboxThread = conversation.source === 'comment' && getConversation
      ? await getConversation(`${conversation.pageId}:${conversation.psid}`).catch(() => null)
      : null;
    const recentOrder = [...(Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []), ...(Array.isArray(inboxThread?.customerOrders) ? inboxThread.customerOrders : [])]
      .reduce((latest, order) => ((Number(order?.createdAt) || 0) > (Number(latest?.createdAt) || 0) ? order : latest), null);
    // Tin hệ thống của Messenger ("Bạn đã bỏ lỡ cuộc gọi…") không phải lời khách.
    if (/bỏ lỡ cuộc gọi|có thể gọi cho .* trong 7 ngày|missed (a )?call/i.test(String(change.message?.text || ''))) {
      results.push({ conversationId: conversation.id, skipped: 'tin hệ thống cuộc gọi' });
      return;
    }
    // Vài tin chữ gần nhất của khách: SĐT/địa chỉ khách gửi ở tin riêng trước đó
    // được đọc lại thay vì hỏi lần nữa.
    const recentCustomerTexts = recent.filter(item => item?.direction === 'incoming' && item.type === 'text' && item.text).slice(-5).map(item => String(item.text));
    // Khách đi từ bình luận sang Messenger: bình luận gần nhất của khách dưới
    // bài ("1 xanh 1 vàng", "cho mình 2 túi") là ngữ cảnh model cần thấy — hộp
    // thư không chứa bình luận.
    const commentThreadId = conversation.source !== 'comment' && String(conversation.post?.inheritedFrom || '').includes(':comment:') ? conversation.post.inheritedFrom : '';
    const recentComments = commentThreadId && listMessages
      ? (await listMessages(commentThreadId).catch(() => [])).filter(item => item?.direction === 'incoming' && item.text).slice(-2).map(item => String(item.text).replace(/\s+/g, ' ').trim().slice(0, 200))
      : [];
    const conversationForModel = recentComments.length ? { ...conversation, recentComments } : conversation;
    const replyContext = { pendingOrder: conversation.pendingOrder, recentOrder, now: Date.now(), messageText: String(message.text || ''), recentCustomerTexts: [...recentComments, ...recentCustomerTexts], customer: { gender: conversation.gender || inboxThread?.gender || '', name: conversation.name || '' } };
    // Tin mảnh (chỉ SĐT, "đó a", tên người…) khi đang lấy thông tin đơn, hoặc bot
    // vừa hỏi ở bước lên đơn, hoặc tin chỉ toàn số: đợi vài giây cho tin kế tiếp
    // của khách tới để gộp, tránh xin lại thứ khách vừa gửi. Bình luận liên tiếp
    // ("1 vàng 1 xanh" rồi "1 xanh 1 vàng") cũng gộp thành một câu trả lời.
    const shortText = String(message.text || '').trim();
    const digitsOnly = /^\+?\d[\d .-]{7,}$/.test(shortText);
    const waitForFragments = message.type === 'text' && (
      conversation.source === 'comment'
      || ((conversation.pendingOrder || isOrderStep(conversation.botLastTemplateId) || conversation.botLastTemplateId === 'ASK_FLAVOR' || digitsOnly) && shortText.length < 40)
    );
    if (waitForFragments) {
      await new Promise(resolve => setTimeout(resolve, Number(settings.fragmentWaitMs ?? 4000)));
      if (hasNewerCustomerMessage(await listMessages(conversation.id), change.message)) {
        results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
        return;
      }
    }
    // Khách chỉ để ".", "ib", "bn", "xin giá"… dưới bài/quảng cáo có sản phẩm cụ
    // thể: gửi thẳng bảng giá sản phẩm đó, không đưa danh sách chung để khách phải chọn.
    const folded = foldVietnamese(String(message.text || '').trim()).replace(/\s+/g, ' ');
    // Bot vừa hỏi số lượng/vị/SĐT/địa chỉ thì "1", "?"… là câu trả lời, không phải xin giá.
    const collectingOrder = isOrderStep(conversation.botLastTemplateId) || conversation.botLastTemplateId === 'ASK_FLAVOR';
    const terse = message.type === 'text' && !collectingOrder && /^(\.+|…|ib|inbox|in box|bn|gia|xin gia|gia bao nhieu|bao nhieu|bao gia|cho hoi gia|gia sao|gia the nao|gia ntn|\?|\+1|1|\.ib|ib\.)$/i.test(folded);
    const contextProduct = terse ? resolveConversationProduct({ adTitle: conversation.referral?.adTitle, referralRef: conversation.referral?.ref, postText: conversation.post?.message }).product : '';
    const quickQuote = terse && productHint(contextProduct) && settings.messageTemplates?.PRICE_QUOTE
      ? renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: contextProduct }, settings.messageTemplates, replyContext)
      : null;
    // Sticker/biểu tượng: không cần trả lời, càng không cần chuyển người.
    // Dòng ghi "khách bấm quảng cáo" cũng không phải tin để trả lời.
    if (message.type === 'sticker' || message.type === 'ad') {
      results.push({ conversationId: conversation.id, skipped: message.type });
      return;
    }
    // Ảnh, video, tệp: trước đây mọi tin không phải chữ đều chuyển nhân viên và
    // tắt bot (nguồn chuyển CSKH lớn nhất). Giờ bot báo đã nhận hình, gắn thẻ
    // để nhân viên xem, nhưng vẫn bật để trả lời tin chữ tiếp theo; nhiều ảnh
    // liền nhau chỉ báo một lần.
    const nonText = message.type !== 'text';
    if (nonText && conversation.botLastTemplateId === 'IMAGE_RECEIVED') {
      results.push({ conversationId: conversation.id, skipped: 'ảnh liền nhau' });
      return;
    }
    // Ảnh khách gửi: Gemini (Vertex) xem ảnh cùng lịch sử — ảnh quảng cáo/bao bì
    // thì nhận ra sản phẩm và đi tiếp (báo giá, lên đơn); model không rõ ảnh
    // là gì thì trả IMAGE_RECEIVED và bot gắn thẻ cho nhân viên xem.
    const seesImage = nonText && message.type === 'image' && settings.provider === 'vertex' && settings.visionEnabled !== false && (message.dataUrl || message.images?.length);
    const imageFallback = () => ({ ...renderChatbotReply({ template_id: settings.messageTemplates?.IMAGE_RECEIVED ? 'IMAGE_RECEIVED' : 'CSKH_HANDOFF' }, settings.messageTemplates || {}, replyContext), attention: true });
    // Khách bấm "Mua"/"Gửi giỏ hàng" ở Facebook Shop: SKU đã rõ, không cần model.
    const cartReply = message.cart?.length ? cartQuickReply(message.cart, settings.messageTemplates, replyContext) : null;
    // Dưới bình luận, câu trả lời theo luật khi không có model: bảng giá sản
    // phẩm của bài, lời chào live, hay bảng giá chung.
    const postProduct = conversation.source === 'comment'
      ? resolveConversationProduct({ adTitle: conversation.referral?.adTitle, referralRef: conversation.referral?.ref, postText: conversation.post?.message }).product
      : '';
    const commentRuleReply = () => renderChatbotReply(
      productHint(postProduct) && settings.messageTemplates?.PRICE_QUOTE ? { template_id: 'PRICE_QUOTE', Product_N1: postProduct } : { template_id: 'GENERAL_INFO' },
      settings.messageTemplates, replyContext
    );
    const askModel = async () => {
      try {
        return await requestReply({ settings, conversation: conversationForModel, message, recentMessages: recent.filter(item => !bundled.has(item?.id)), context: replyContext });
      } catch (error) {
        // Model hết hạn mức/quá tải dưới bình luận: không để bình luận rơi —
        // trả lời theo luật (bảng giá bài viết / lời chào live / bảng giá chung).
        if (conversation.source === 'comment' && isCapacityError(error) && settings.messageTemplates?.GENERAL_INFO) {
          console.warn(`Model lỗi dưới bình luận (${conversation.id}): ${error.message} — trả lời theo luật.`);
          return commentRuleReply();
        }
        throw error;
      }
    };
    let reply = asksForHuman
      ? renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, settings.messageTemplates, replyContext)
      : cartReply
        ? cartReply
        : nonText
          ? (seesImage ? await askModel() : imageFallback())
          : quickQuote || await askModel();
    if (seesImage && (reply.templateId === 'IMAGE_RECEIVED' || reply.templateId === 'CSKH_HANDOFF')) reply = imageFallback();
    // Dưới bình luận không bao giờ chuyển người (khách chưa vào hộp thư): trả
    // bảng giá chung và mời nhắn tin. WELCOME/xác nhận đơn/"đã nhận hình" dưới
    // bình luận cũng vô nghĩa (khách đã hỏi giá rồi) → bảng giá sản phẩm của bài.
    // Riêng bình luận là khiếu nại/hủy/đổi đơn/chưa nhận hàng (khách đã là người
    // mua): không chào hàng — nhắn riêng rằng nhân viên sẽ kiểm tra, gắn thẻ.
    const commentNeedsStaff = conversation.source === 'comment'
      && /\b(huy|doi don|khieu nai|chua nhan|khong thay (gui|hang)|chua thay (gui|hang)|bi loi|bi hu|sai don|giao sai)\b/.test(folded);
    if (conversation.source === 'comment' && settings.messageTemplates?.COMMENT_STAFF_FOLLOWUP && (commentNeedsStaff || (reply.templateId === 'CSKH_HANDOFF' && !asksForHuman))
      && !['ORDER_CANCEL', 'ORDER_STATUS'].includes(reply.templateId)) {
      reply = { ...renderChatbotReply({ template_id: 'COMMENT_STAFF_FOLLOWUP' }, settings.messageTemplates, replyContext), attention: true };
    }
    const commentBlocked = new Set(['CSKH_HANDOFF', 'WELCOME', 'ASK_PRODUCT', 'IMAGE_RECEIVED']);
    if (commentBlocked.has(reply.templateId) && !asksForHuman && conversation.source === 'comment' && settings.messageTemplates?.GENERAL_INFO) {
      reply = commentRuleReply();
    }
    // Dưới phiên livestream nhiều sản phẩm, "hỏi giá chung" không nên là bảng
    // 3 vị khô khan: dùng lời chào live (nêu các vị có trên live, ưu đãi live,
    // hỏi khách quan tâm loại nào) nếu chủ shop có soạn mẫu LIVESTREAM_COMMENT.
    if (reply.templateId === 'GENERAL_INFO' && settings.messageTemplates?.LIVESTREAM_COMMENT && isLivestreamPost(conversation)) {
      reply = renderChatbotReply({ template_id: 'LIVESTREAM_COMMENT' }, settings.messageTemplates, replyContext);
    }
    // Không gửi lại y nguyên tin bot vừa gửi trong 10 phút (hỏi SĐT lần ba, cảm ơn
    // hai lần), và không chuyển người lần hai trong 24 giờ.
    // Cùng lời (câu đầu của mẫu) đã gửi trong 10 phút, hay cùng một mẫu "không
    // nên lặp" (chào, cảm ơn, xin SĐT, xác nhận đơn…) vừa gửi chưa đầy 60 giây
    // (hai tin của khách tới cùng lô webhook): không gửi lần hai.
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    // So khớp lỏng: bỏ khoảng trắng thừa và câu mở đầu của tin riêng sau bình
    // luận ("Dạ em thấy … để lại bình luận…"), để lời vừa gửi riêng qua bình
    // luận cũng được nhận ra khi khách nhắn tiếp vào hộp thư.
    const normalizeSent = value => String(value || '').replace(/^Dạ em thấy .*? để lại bình luận[^\n]*\n+/u, '').replace(/\s+/g, ' ').trim();
    const firstLine = normalizeSent(reply.messages?.[0] || '');
    const repeatsText = firstLine.length > 20 && recent.some(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo && normalizeSent(item.text).includes(firstLine));
    const noRepeatTemplates = new Set(['WELCOME', 'THANK_YOU', 'CSKH_HANDOFF', 'ORDER_CONFIRMATION', 'ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'GENERAL_INFO', 'LIVESTREAM_COMMENT']);
    const repeatsTemplate = noRepeatTemplates.has(reply.templateId) && conversation.botLastTemplateId === reply.templateId && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 60 * 1000;
    // Giỏ Shop mới khác giỏ đang giữ: là thay đổi thật, không phải lặp.
    const changedCart = Boolean(cartReply?.pendingOrder?.key) && cartReply.pendingOrder.key !== conversation.pendingOrder?.key;
    const repeatsLast = (repeatsText || repeatsTemplate) && !changedCart;
    const repeatsHandoff = reply.templateId === 'CSKH_HANDOFF' && conversation.botLastTemplateId === 'CSKH_HANDOFF'
      && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 24 * 60 * 60 * 1000;
    if (repeatsLast || repeatsHandoff) {
      // Chỉ im lặng với lời đáp ngắn ("ok", "dạ") hay khi đã chuyển người; khách
      // hỏi tiếp mà bot sắp lặp lại tin vừa gửi thì nhắc ngắn thông tin đã ở trên
      // và mời chốt — không để khách chờ không ai trả lời.
      const shortAck = /^(ok|oke|okie|okay|da|vang|u|uh|um|\.|👍|❤️)+$/i.test(folded.replace(/\s+/g, ''));
      // Chỉ nhắc khi thứ sắp lặp là THÔNG TIN (bảng giá, lời chào live, tư vấn);
      // câu hỏi bước đơn (xin SĐT/địa chỉ, hỏi vị) lặp lại thì vẫn im như cũ.
      const informational = !isOrderStep(reply.templateId) && !['ASK_FLAVOR', 'ASK_PRODUCT', 'THANK_YOU', 'WELCOME', 'CSKH_HANDOFF'].includes(reply.templateId);
      const canNudge = repeatsLast && informational && !shortAck && settings.messageTemplates?.REPLY_ALREADY_SENT && conversation.botLastTemplateId !== 'REPLY_ALREADY_SENT' && conversation.source !== 'comment';
      if (!canNudge) {
        results.push({ conversationId: conversation.id, skipped: repeatsLast ? 'lặp tin vừa gửi' : 'đã chuyển người trong 24 giờ' });
        return;
      }
      reply = { ...renderChatbotReply({ template_id: 'REPLY_ALREADY_SENT' }, settings.messageTemplates, replyContext), pendingOrder: reply.pendingOrder };
    }
    // Trong lúc chờ mô hình khách nhắn thêm: bỏ câu này, tin sau trả lời gộp.
    if (message.type === 'text' && hasNewerCustomerMessage(await listMessages(conversation.id), change.message)) {
      results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
      return;
    }
    // The order is persisted BEFORE anything is sent. Sending first meant a
    // failed order left the customer holding a confirmation for an order that
    // did not exist, and a retried webhook sent the whole reply a second time.
    const isComment = conversation.source === 'comment';
    // "Tự động lên đơn" tắt (settings.autoOrder === false): bot vẫn xác nhận với
    // khách nhưng không tạo đơn; giỏ được giữ ở pendingOrder cho nhân viên.
    // Khách sửa đơn vừa chốt: cập nhật đúng đơn đó (updateOrder), không tạo đơn mới.
    const wantsUpdate = Boolean(reply.order?.updateOrderId) && typeof updateOrder === 'function';
    // Khách hủy đơn vừa đặt: đánh dấu hủy đúng đơn đó (không tạo, không sửa).
    const wantsCancel = Boolean(reply.order?.cancelOrderId) && typeof cancelOrder === 'function';
    const outcome = settings.responseMode === 'automatic' && settings.autoOrder !== false && reply.order && (wantsCancel || wantsUpdate || createOrder) && !isComment
      ? (wantsCancel
        ? await cancelOrder(conversation, reply.order.cancelOrderId)
        : wantsUpdate
          ? await updateOrder(conversation, reply.order.updateOrderId, reply.order)
          : await createOrder(conversation, reply.order, { sourceMessageId: String(change.message.mid || change.message.id || '') }))
      : null;
    // Đơn vừa hủy không phải "đơn mới" cho nhãn/phiếu.
    const order = outcome?.cancelled ? null : outcome?.order || null;
    const alreadyHandled = Boolean(outcome) && outcome.created === false && !outcome.updated && !outcome.cancelled;
    let privateError = '';
    let privateSkipped = false;
    if (settings.responseMode === 'automatic' && isComment) {
      // Under a comment: the full answer goes to the person's Messenger as a
      // private reply (Facebook allows one per comment, so the messages are
      // joined), and one short public reply tells them to check their inbox.
      // Orders are never created from a comment — the customer is asked to
      // continue in Messenger, where the address exchange is private.
      const intro = renderChatbotReply({ template_id: 'COMMENT_PRIVATE_REPLY' }, settings.messageTemplates, replyContext);
      const privateText = [...(intro.templateId === 'COMMENT_PRIVATE_REPLY' ? intro.messages : []), ...reply.messages].join('\n\n')
        // Mẫu mở đầu kết bằng "Dạ," rồi mẫu sau lại "Dạ": chỉ giữ một.
        .replace(/Dạ,?\s*\n\n\s*Dạ,?/g, 'Dạ,');
      // Messenger can refuse the private reply — most often error #10, another
      // app holding the thread (Handover Protocol). Telling the customer to
      // check an inbox that stays empty loses the lead, so the public reply
      // then asks them to message the Page instead, and the error is kept
      // for the customer panel.
      // Khách bình luận nhiều lần dưới cùng bài ("cho coi combo", "combo đó mấy
      // gói"): cùng một tin riêng đã gửi trong 24 giờ thì không gửi lại — khách
      // nhận ba lần bảng giá y hệt là spam. Chỉ trả lời công khai ngắn.
      if (privateText && getConversation && listMessages) {
        const inbox = await getConversation(`${conversation.pageId}:${conversation.psid}`).catch(() => null);
        const sentBefore = inbox ? await listMessages(inbox.id).catch(() => []) : [];
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        privateSkipped = sentBefore.some(item => item?.direction === 'outgoing' && (Number(item?.createdAt) || 0) > dayAgo && normalize(item.text) === normalize(privateText));
      }
      if (privateText && !privateSkipped) {
        try {
          await sendMessage(conversation, { text: privateText, privateReply: true });
        } catch (error) {
          // Lỗi tạm (aborted, #0, #1, mạng): thử lại một lần sau 3 giây. Khách
          // chặn tin (#10903), đã trả lời (#10900), ngoài cửa sổ (#10/#551): không.
          const permanent = /#10903|#10900|#551|\(#10\)|chưa có mã Pancake/i.test(error.message || '');
          // #10900: bình luận ĐÃ được nhắn riêng (Pancake/nhân viên) — không phải
          // lỗi; không đăng "mình ib cho Page giúp em".
          if (/#10900/.test(error.message || '')) privateSkipped = true;
          else if (permanent) privateError = error.message;
          else {
            await wait(3000);
            try {
              await sendMessage(conversation, { text: privateText, privateReply: true });
            } catch (again) {
              privateError = again.message;
            }
          }
        }
      }
      // Giỏ hàng khách nêu trong bình luận ("1 xanh 1 vàng", SĐT kèm theo) đi
      // theo khách sang hộp thư: khi khách nhắn địa chỉ vào Messenger, bot đã
      // có sẵn sản phẩm để chốt thay vì hỏi lại từ đầu.
      const carried = reply.pendingOrder && (reply.pendingOrder.items?.length || reply.pendingOrder.phone) ? reply.pendingOrder : null;
      // Giỏ khách vừa nêu trong hộp thư (dưới 30 phút) mới hơn bình luận: không ghi đè.
      const inboxBasketFresh = inboxThread?.pendingOrder?.items?.length && Date.now() - (Number(inboxThread.pendingOrder.at) || 0) < 30 * 60 * 1000;
      if (!privateError && !privateSkipped && saveBotState) {
        // Hộp thư biết mẫu vừa gửi riêng: khách nhắn tiếp thì bot không gửi lại y nguyên.
        await saveBotState(`${conversation.pageId}:${conversation.psid}`, {
          botLastTemplateId: reply.templateId,
          botLastReplyAt: Date.now(),
          ...(carried && !inboxBasketFresh ? { pendingOrder: carried } : {})
        }).catch(() => {});
      }
      // Ảnh của mẫu (ảnh sản phẩm) đi sau tin nhắn riêng như tin Messenger
      // thường vào hộp thư của khách. Facebook chỉ cho một tin nhắn riêng mỗi
      // bình luận nên tin đó phải là bảng giá; ảnh gửi thêm được thì tốt, bị
      // chặn (khách chưa nhắn lại) thì bỏ qua, không báo lỗi.
      if (!privateError && !privateSkipped && reply.images?.length && getConversation) {
        const inbox = await getConversation(`${conversation.pageId}:${conversation.psid}`).catch(() => null);
        const sentImages = inbox
          ? await sendMessage(inbox, { imageUrls: reply.images }).then(() => true).catch(error => { console.error(`Ảnh sau tin nhắn riêng không gửi được (${conversation.id}): ${error.message}`); return false; })
          : false;
        // Chưa gửi được (khách chưa mở Messenger với Page): giữ lại, gửi khi khách nhắn.
        if (!sentImages) rememberPendingImages(conversation.pageId, conversation.psid, reply.images);
      }
      const publicId = privateError ? 'COMMENT_PUBLIC_FALLBACK' : privateSkipped && settings.messageTemplates?.COMMENT_PUBLIC_REPEAT ? 'COMMENT_PUBLIC_REPEAT' : 'COMMENT_PUBLIC_REPLY';
      // Tin riêng đã bỏ vì trùng mà 10 phút trước đã trả lời công khai rồi:
      // không đăng thêm "em đã ib" lần nữa dưới bài.
      const publicRecently = privateSkipped && recent.some(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo);
      const publicReply = publicRecently ? { messages: [] } : renderChatbotReply({ template_id: publicId }, settings.messageTemplates, replyContext);
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
      let parts = reply.parts || [...reply.messages.map(text => ({ type: 'text', text })), ...(reply.images || []).map(url => ({ type: 'image', url }))];
      // Ảnh còn nợ từ tin nhắn riêng sau bình luận: gửi trước câu trả lời, bỏ
      // ảnh trùng trong câu trả lời để khách không nhận hai lần.
      const owed = conversation.source === 'comment' ? [] : takePendingImages(conversation.pageId, conversation.psid);
      if (owed.length) {
        const owedSet = new Set(owed);
        parts = [{ type: 'owed', urls: owed }, ...parts.filter(part => part.type !== 'image' || !owedSet.has(part.url))];
      }
      // Ảnh không gửi được (Pancake/Facebook từ chối tệp) thì bỏ ảnh đó, chữ
      // vẫn phải tới khách; lỗi ảnh ghi lại cho panel khách thay vì chặn cả câu.
      // Ảnh liền nhau gộp thành một tin nhiều ảnh (Pancake gửi một cụm; Meta tự tách từng ảnh).
      // Đoạn phụ (chính sách giao, đổi trả…) y hệt đã gửi trong 24 giờ thì bỏ:
      // chốt hai đơn liền nhau không lặp lại cả chuỗi "luyên thuyên". Đoạn đầu
      // (câu trả lời chính) luôn gửi.
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const sentTexts = new Set(recent.filter(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > dayAgo).map(item => String(item.text || '').replace(/\s+/g, ' ').trim()));
      parts = parts.filter((part, index) => index === 0 || part.type !== 'text' || !sentTexts.has(String(part.text || '').replace(/\s+/g, ' ').trim()));
      const imageErrors = [];
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part.type === 'owed') {
          await sendMessage(conversation, { imageUrls: part.urls }).catch(error => imageErrors.push(error.message));
          continue;
        }
        if (part.type !== 'image') { await sendMessage(conversation, { text: part.text }); continue; }
        const urls = [part.url];
        while (parts[index + 1]?.type === 'image') urls.push(parts[++index].url);
        try {
          await sendMessage(conversation, { imageUrls: urls });
        } catch (error) {
          imageErrors.push(error.message);
        }
      }
      if (imageErrors.length) privateError = privateError || `ảnh không gửi được: ${imageErrors[0]}`;
      // The receipt closes the exchange, so it is sent after the reply text and
      // never before it — the order itself was already persisted above.
      // Sửa đơn: không gửi lại phiếu (POS/khách đã có), chỉ tin sửa đơn ở trên.
      if (order && sendReceipt && !outcome?.updated) await sendReceipt(conversation, order);
    }
    const labelEvents = autoLabelEventsFor({
      order,
      // Ảnh khách gửi: thẻ "Cần người xử lý" để nhân viên xem, bot vẫn bật.
      handoff: reply.handoff || Boolean(reply.attention),
      text: message.text,
      templateId: reply.templateId,
      keywords: settings.complaintKeywords,
      // Khách đổi/hủy đơn, đến từ phiên live, số hay bom hàng: thẻ tương ứng.
      updated: Boolean(outcome?.updated),
      cancelled: Boolean(outcome?.cancelled),
      livestream: isLivestreamPost(conversation),
      phoneWarningLevel: outcome?.order?.phoneWarning?.level || ''
    });
    await saveBotState(conversation.id, {
      botConversationId: reply.conversationId || conversation.botConversationId || '',
      botLastTemplateId: reply.templateId,
      botLastReplyAt: Date.now(),
      botDraft: settings.responseMode === 'draft' ? reply.messages.join('\n\n') : '',
      botLastError: privateError ? `Không nhắn riêng được: ${privateError}` : '',
      botLastErrorAt: privateError ? Date.now() : 0,
      // undefined leaves the stored basket alone; null clears it once ordered.
      // undefined để nguyên giỏ đang giữ; null xóa khi đã lên đơn. Tắt tự động
      // lên đơn thì giỏ khách vừa chốt được giữ lại thay vì xóa.
      ...(!isComment && !order && reply.order && settings.autoOrder === false
        ? { pendingOrder: { ...(conversation.pendingOrder || {}), ...reply.order, at: Date.now() } }
        : reply.pendingOrder !== undefined && !isComment ? { pendingOrder: reply.pendingOrder } : {}),
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
      ...(privateSkipped ? { privateSkipped: true } : {}),
      ...(order ? { orderId: order.id } : {}),
      ...(alreadyHandled ? { duplicate: true } : {})
    });
  } catch (error) {
    console.error(`Bot không trả lời được (${conversation.id}): ${error.message}`);
    await saveBotState(conversation.id, { botLastError: error.message, botLastErrorAt: Date.now() }).catch(() => {});
    // Hết hạn mức/quá tải sau mọi lần thử: hẹn chạy lại tin này sau một phút
    // (một lần). Lúc chạy lại, tin đã được trả lời (nhân viên, hay tin sau của
    // khách gộp vào) thì bỏ qua. Cài đặt đọc lại lúc chạy: nhân viên đã tắt bot
    // trong lúc chờ thì không trả lời nữa.
    const retryDelay = Number(settings.capacityRetryDelayMs ?? 60000);
    if (isCapacityError(error) && !change.delayedRetry && retryDelay > 0) {
      const timer = setTimeout(() => {
        queueForConversation(conversation.id, async () => {
          const latest = dependencies.readSettings ? await dependencies.readSettings().catch(() => settings) : settings;
          if (!latest?.enabled) return;
          await answerChange({ ...change, delayedRetry: true }, latest, [], dependencies);
        }).catch(() => {});
      }, retryDelay);
      timer.unref?.();
      results.push({ conversationId: conversation.id, error: error.message, retryLater: true });
      return;
    }
    results.push({ conversationId: conversation.id, error: error.message });
  }
}
