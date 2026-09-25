import { buildTemplatePrompt, isProductQuoteId, pickVariant, renderChatbotReply } from './chatbot-templates.mjs';
import { chatTimeoutMs, inferAddress } from './processing/address-ai.mjs';
import { describeDeliveryAddress, mergeAddressFragment } from './processing/locations.mjs';
import { extractVietnamesePhone } from './processing/customer-info.mjs';
import { autoLabelEventsFor, foldVietnamese, isComplaint } from './processing/auto-label.mjs';
import { productHint, resolveConversationProduct } from './processing/product-detect.mjs';
import { buildCatalogPrompt } from './processing/pricing.mjs';
import { isOrderStep } from './processing/pending-order.mjs';
import { findProductBySku, getCatalogProducts, matchProduct } from './processing/catalog.mjs';
import { isLivestreamConversation } from './conversation-orders.mjs';
import { ruleIntent } from './processing/rule-intent.mjs';
import { activeTrial, filterTrialReply, trialBagOptions, trialModelHint, trialStep } from './processing/trial-flow.mjs';

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
/**
 * Giỏ khách ghi thẳng trong bình luận: "C 2 túi vàng", "túi vàng với túi xanh lá
 * cây", "2 xanh 1 nâu". Chỉ ba túi lớn (Xanh/Vàng/Nâu; "xanh dương" là hàng
 * live khác); cần ý mua (lấy/mua/chốt/cho em…, có số lượng, hay từ hai màu).
 */
export function commentBasket(text) {
  // "nấu" (sữa hạt nấu…) bỏ dấu cũng thành "nau": giữ khác "nâu" trước khi bỏ dấu.
  // "nấu" (sữa hạt nấu…) bỏ dấu cũng thành "nau": giữ khác "nâu" trước khi bỏ dấu.
  const folded = foldVietnamese(String(text || '').replace(/nấu/giu, 'nauu')).replace(/\s+/g, ' ');
  // "Xanh dương" là hàng live khác: giỏ có nó thì để model/nhân viên, không tự lập
  // giỏ thiếu món. "Đậu xanh" là thành phần, không phải túi.
  if (/\bxanh duong\b/.test(folded)) return [];
  const cleaned = folded.replace(/\bdau xanh\b/g, ' ');
  const counts = new Map();
  // Khách viết một kiểu cho cả câu: số TRƯỚC màu ("2 xanh 1 vàng", "2 túi vàng")
  // hay số SAU màu ("vàng 2 nâu 1", "xanh lá x2"). Đọc lẫn hai kiểu thì "1 xanh
  // 2 nâu" gán nhầm số 2 cho xanh.
  const firstColour = cleaned.search(/(?<![a-z])(xanh|vang|nau|cacao)(?![a-z])/);
  const firstNumber = cleaned.search(/(?<!\d)\d{1,2}(?!\d)/);
  const numberFirst = firstNumber >= 0 && firstNumber < firstColour;
  const pattern = numberFirst
    ? /(?:(?<!\d)(\d{1,2})\s*(?:tui|goi|bich)?\s*)?(?:(?:tui|mau)\s+)?(?<![a-z])(xanh|vang|nau|cacao)(?![a-z])/g
    : /(?<![a-z])(xanh|vang|nau|cacao)(?![a-z])(?:\s*la(?:\s*cay)?)?(?:\s*x?\s*(\d{1,2})(?!\d|\s*(?:g|gr|gram|k)\b))?/g;
  for (const match of cleaned.matchAll(pattern)) {
    const [colourText, quantityText] = numberFirst ? [match[2], match[1]] : [match[1], match[2]];
    const colour = colourText === 'cacao' ? 'nau' : colourText;
    counts.set(colour, (counts.get(colour) || 0) + (Number(quantityText) || 1));
  }
  if (!counts.size) return [];
  const wantsIt = counts.size >= 2 || [...counts.values()].some(quantity => quantity > 1) || /\b(lay|mua|chot|dat|gui|ship|combo|cho (em|minh|chi|c|e|toi|tui|anh|a)|\d{1,2} ?(tui|goi|bich))\b/.test(folded);
  if (!wantsIt) return [];
  const items = [];
  for (const [colour, quantity] of counts) {
    const product = getCatalogProducts().find(item => item.active !== false && /^gra-/i.test(item.sku || '') && String(item.sku || '').toLowerCase().includes(`-${colour}-`));
    if (!product) return [];
    items.push({ product: product.name, quantity });
  }
  return items;
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
  return isLivestreamConversation(conversation);
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
  // Bản gọn (settings.contextTrim.query, mặc định TẮT — A/B 25/09 cho thấy gộp
  // các khối gọn lại làm mô hình kém ổn định hơn mức lệch tự nhiên): chỉ ghi kênh
  // khi là bình luận, không gửi tên khách, thêm MẪU VỪA GỬI.
  const compactQuery = settings?.contextTrim?.query === true;
  const lastTemplate = compactQuery && conversation.botLastTemplateId && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 24 * 60 * 60 * 1000
    ? conversation.botLastTemplateId : '';
  return [
    compactQuery ? (conversation.source === 'comment' ? 'KÊNH: Bình luận Facebook' : '') : `KÊNH: ${conversation.source === 'comment' ? 'Bình luận Facebook' : 'Facebook Messenger'}`,
    compactQuery ? '' : `KHÁCH HÀNG: ${conversation.name || 'Khách Facebook'}`,
    compactQuery ? hint : productHint(product, { legacy: true }),
    lastTemplate ? `MẪU VỪA GỬI: ${lastTemplate}` : '',
    // Khách đang giữ ưu đãi 1 túi dùng thử (luồng riêng nhờ mô hình đọc tin khó).
    conversation.trialHint || '',
    Array.isArray(conversation.recentComments) && conversation.recentComments.length
      ? (compactQuery ? `GIỎ/SĐT KHÁCH GHI Ở BÌNH LUẬN (coi như DỮ LIỆU ĐÃ LƯU): ` : 'BÌNH LUẬN GẦN NHẤT CỦA KHÁCH DƯỚI BÀI: ') + conversation.recentComments.map(text => `"${text}"`).join(' · ')
      : '',
    !hint && isLivestreamPost(conversation)
      ? (compactQuery ? 'BÀI VIẾT: livestream nhiều sản phẩm, không có sản phẩm cụ thể; "hộp"/"gói nhỏ" là hộp 10 gói (PACKAGING_INFO).' : 'BÀI VIẾT: phiên livestream giới thiệu nhiều sản phẩm (không có sản phẩm cụ thể); khách hỏi giá chung thì GENERAL_INFO, hỏi "hộp"/"gói nhỏ" là hộp 10 gói nhỏ (PACKAGING_INFO).')
      : '',
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
export function composeSystemPrompt(basePrompt, templates = {}, contextTrim = {}) {
  return [
    String(basePrompt || '').trim(),
    buildCatalogPrompt({ compact: contextTrim?.catalog === true }),
    buildTemplatePrompt(templates, basePrompt, { compact: contextTrim?.templates === true })
  ].filter(Boolean).join('\n\n');
}

// Tin hệ thống/nhiễu trong lịch sử: không giúp chọn mẫu (17% ký tự lịch sử).
const memoryNoise = /^(Bạn đang phản hồi bình luận|Dạ em đã (ib|nhắn tin nhờ)|Đã gửi xác nhận đơn hàng|Khách bấm vào quảng cáo|\[Tệp đính kèm\]|.{0,60} đã trả lời một quảng cáo\.?$)/u;

/**
 * Một lượt của Page, gọn: đầu tin (đang nói về gì: "Bảng giá Túi Xanh…") + câu
 * hỏi cuối (bot vừa hỏi gì: "…lấy 2 túi không ạ?"). Cắt 160 ký tự đầu như trước
 * làm mất câu hỏi ở 18% tin dài — khách đáp "ok" mà model không biết ok với gì.
 */
export function compressPageTurn(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').replace(/^Dạ,?\s*/u, '').trim();
  if (clean.length <= 160) return clean;
  const head = clean.slice(0, 70).replace(/\s+\S*$/, '');
  const mark = clean.lastIndexOf('?');
  if (mark < 70) return `${head}…`;
  const start = Math.max(70, mark - 80, clean.lastIndexOf('. ', mark - 1) + 2, clean.lastIndexOf('! ', mark - 1) + 2);
  return `${head}… ${clean.slice(start, mark + 1).trim()}`;
}

function buildMemoryTurns({ recentMessages = [], message, settings }) {
  if (settings?.memoryEnabled === false) return [];
  const limit = Math.max(1, Number(settings?.memoryWindow) || 12);
  // Bản cũ (mặc định): từng tin, tin Page cắt 160 ký tự, tin khách 300. Bản gọn
  // (settings.contextTrim.memory) chưa bật: A/B 25/09 chưa chứng minh giữ độ chính xác.
  if (settings?.contextTrim?.memory !== true) {
    return recentMessages
      .filter(item => item && item.id !== message?.id && String(item.text || '').trim())
      .slice(-limit)
      .map(item => {
        const text = String(item.text).replace(/\s+/g, ' ').trim();
        const cut = item.direction === 'incoming' ? 300 : 160;
        return { role: item.direction === 'incoming' ? 'user' : 'model', text: text.length > cut ? `${text.slice(0, cut)}…` : text };
      });
  }
  // Bỏ tin hệ thống, gộp các tin liền nhau của cùng một bên thành một lượt (bảng
  // giá + lời mời, xác nhận + chính sách giao/đổi trả), rồi nén lượt của Page;
  // cửa sổ đếm theo lượt đã gộp. Tin khách giữ tối đa 300 ký tự.
  const turns = [];
  for (const item of recentMessages) {
    const text = String(item?.text || '').replace(/\s+/g, ' ').trim();
    if (!item || item.id === message?.id || !text || ['ad', 'order-receipt', 'attachment'].includes(item.type) || memoryNoise.test(text)) continue;
    const role = item.direction === 'incoming' ? 'user' : 'model';
    const previous = turns.at(-1);
    if (previous?.role === role) previous.parts.push(text);
    else turns.push({ role, parts: [text] });
  }
  return turns.slice(-limit).map(turn => {
    const text = turn.parts.join(' ');
    if (turn.role === 'model') return { role: 'model', text: compressPageTurn(text) };
    return { role: 'user', text: text.length > 300 ? `${text.slice(0, 300)}…` : text };
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

/** thinkingConfig theo đời model: Gemini 3 nhận thinkingLevel, 2.5 nhận thinkingBudget (số token). */
export function thinkingConfigFor(model, level) {
  const wanted = String(level || '').trim().toLowerCase();
  if (!['minimal', 'low', 'medium', 'high'].includes(wanted)) return null;
  if (/gemini-2\.5/i.test(String(model || ''))) {
    return { thinkingBudget: { minimal: 0, low: 512, medium: 2048, high: 8192 }[wanted] };
  }
  return { thinkingLevel: wanted };
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
  const systemPrompt = composeSystemPrompt(settings.systemPrompt, settings.messageTemplates, settings.contextTrim);
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
          ...(settings.structuredOutput !== false ? { responseMimeType: 'application/json' } : {}),
          // Mức "suy nghĩ" (token suy nghĩ tính giá như đầu ra, đắt gấp 6 lần đầu vào).
          // Gemini 3 dùng thinkingLevel; 2.5 dùng thinkingBudget. Để trống = mặc định của model.
          ...(thinkingConfigFor(model, settings.thinkingLevel) ? { thinkingConfig: thinkingConfigFor(model, settings.thinkingLevel) } : {})
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
      // Số token thật mỗi lượt (đầu vào, phần được cache, đầu ra, "suy nghĩ"): để đo
      // tối ưu prompt bằng số liệu thật thay vì ước lượng. Xem bằng journalctl | grep "Token".
      const usage = payload?.usageMetadata || null;
      if (usage && !rawResponse) {
        console.log(`Token ${model}: vào ${usage.promptTokenCount ?? '?'} (cache ${usage.cachedContentTokenCount ?? 0}) · ra ${usage.candidatesTokenCount ?? '?'} · suy nghĩ ${usage.thoughtsTokenCount ?? 0}`);
      }
      const parsedAnswer = parseModelAnswer(answer);
      if (rawResponse) return { raw: answer, parsed: parsedAnswer, usage, conversationId: '' };
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

/**
 * Giỏ Facebook Shop: bot đã xin SĐT/địa chỉ vì lúc đó POS chưa có đơn. Khách
 * thanh toán trong Shop thì Pancake tạo đơn POS sau 0–2 phút: tra lại ở nền
 * (30 giây, 1,5 phút, 3,5 phút); thấy đơn thì nhắn "đã nhận đơn… không cần gửi
 * lại" và bỏ giỏ chờ. Dừng khi nhân viên đã nhận khách, khách đã lên đơn khác,
 * hay giỏ đã đổi. Chạy trong hàng đợi của khách, không chen tin khác.
 */
function followUpShopOrder({ conversation, since, settings, dependencies, cartKey, shopOrderReply }) {
  const delays = Array.isArray(settings.shopOrderFollowUpMs) ? settings.shopOrderFollowUpMs : [30000, 60000, 120000];
  const queueKey = conversation.pageId && conversation.psid ? `${conversation.pageId}:${conversation.psid}` : conversation.id;
  const check = index => {
    if (index >= delays.length) return;
    const timer = setTimeout(() => {
      queueForConversation(queueKey, async () => {
        const latest = dependencies.getConversation ? await dependencies.getConversation(conversation.id).catch(() => null) : null;
        const current = latest || conversation;
        if (current.botEnabled === false) return;
        if ((current.customerOrders || []).some(order => (Number(order?.createdAt) || 0) >= since)) return;
        if (latest && cartKey && current.pendingOrder?.key !== cartKey) return;
        const found = await dependencies.findShopOrder(current, { since }).catch(() => null);
        if (!found) { check(index + 1); return; }
        const reply = shopOrderReply(found);
        for (const text of reply.messages) await dependencies.sendMessage(current, { text });
        await dependencies.saveBotState?.(current.id, { pendingOrder: null, botLastTemplateId: reply.templateId, botLastReplyAt: Date.now() });
      }).catch(error => console.warn(`Tra đơn Shop ở nền lỗi (${conversation.id}): ${error.message}`));
    }, Number(delays[index]) || 0);
    timer.unref?.();
  };
  check(0);
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
  // Bot im (nhân viên vừa trả lời, gộp tin, lặp…): ghi một dòng để rà được về sau.
  for (const item of results) if (item.skipped && item.skipped !== 'gộp với tin sau') console.log(`Bot bỏ qua: ${item.skipped} (${item.conversationId})`);
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
    if (/bỏ lỡ cuộc gọi|có thể gọi cho .* trong 7 ngày|đã gọi cho bạn|cuộc gọi (thoại|video) đã kết thúc|missed (a )?call/i.test(String(change.message?.text || ''))) {
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
    // Ưu đãi bám đuổi 1 túi dùng thử (processing/trial-flow.mjs): chỉ hộp thư, còn hạn,
    // chưa đặt đơn sau khi nhận. Chỉ luồng dùng thử đặt context.trial (miễn ship 1 túi).
    let trialState = activeTrial(conversation);
    // "Gửi về địa chỉ cũ" mà đơn không gắn vào hội thoại (nhân viên lên tay, đơn cũ): đọc SĐT +
    // địa chỉ từ tin xác nhận đơn gần nhất trong lịch sử thay vì hỏi lại khách.
    const previousDelivery = (() => {
      const confirmation = [...recent].reverse().find(item => item?.direction === 'outgoing' && /Số điện thoại:\s*\S+/u.test(String(item.text || '')) && /Địa chỉ nhận hàng:/u.test(String(item.text || '')));
      if (!confirmation) return null;
      const phone = String(confirmation.text).match(/Số điện thoại:\s*([\d .+-]{9,16})/u)?.[1]?.replace(/[^\d+]/g, '') || '';
      const address = String(confirmation.text).match(/Địa chỉ nhận hàng:\s*([^\n]+)/u)?.[1]?.trim() || '';
      return phone && address ? { phone, address, at: Number(confirmation.createdAt) || 0 } : null;
    })();
    const replyContext = { pendingOrder: conversation.pendingOrder, recentOrder, previousDelivery, trial: trialState, trialBags: trialState ? trialBagOptions() : '', now: Date.now(), recentOutgoing: recent.filter(item => item?.direction === 'outgoing' && Date.now() - (Number(item.createdAt) || 0) < 30 * 60 * 1000).map(item => String(item.text || '')), messageText: String(message.text || ''), recentCustomerTexts: [...recentComments, ...recentCustomerTexts], customer: { gender: conversation.gender || inboxThread?.gender || '', name: conversation.name || '' } };
    // Tin mảnh (chỉ SĐT, "đó a", tên người…) khi đang lấy thông tin đơn, hoặc bot
    // vừa hỏi ở bước lên đơn, hoặc tin chỉ toàn số: đợi vài giây cho tin kế tiếp
    // của khách tới để gộp, tránh xin lại thứ khách vừa gửi. Bình luận liên tiếp
    // ("1 vàng 1 xanh" rồi "1 xanh 1 vàng") cũng gộp thành một câu trả lời.
    const shortText = String(message.text || '').trim();
    const digitsOnly = /^\+?\d[\d .-]{7,}$/.test(shortText);
    // Tin chỉ là lời chào ("Hi", "shop ơi"): câu hỏi thật thường tới ngay sau —
    // chờ để trả lời gộp, không chào trước rồi mới trả lời.
    const greetingOnly = /^(hi|hello|helo|alo|a lo|chao|xin chao|chao (shop|em|ban|chi|anh)|(shop|em|chi|ad|admin|ban) (oi|ơi)|oi)[.!\s]*$/i.test(foldVietnamese(shortText));
    const waitForFragments = message.type === 'text' && (
      conversation.source === 'comment'
      || greetingOnly
      || ((conversation.pendingOrder || isOrderStep(conversation.botLastTemplateId) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(conversation.botLastTemplateId) || digitsOnly) && shortText.length < 40)
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
    const collectingOrder = isOrderStep(conversation.botLastTemplateId) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(conversation.botLastTemplateId);
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
    // Khách đã có đơn trong 24 giờ (chưa hủy).
    const hasOrder = Boolean(recentOrder?.id) && Date.now() - (Number(recentOrder.createdAt) || 0) < 24 * 60 * 60 * 1000
      && String(recentOrder.processingStatus || '') !== 'cancelled';
    // Ảnh model không đọc ra, khách đến từ quảng cáo/bài của MỘT sản phẩm và chưa
    // có đơn: gửi bảng giá sản phẩm đó (ảnh thường là ảnh quảng cáo chụp lại),
    // vẫn gắn thẻ để nhân viên xem ảnh. Trước đây "mình cần hỗ trợ gì về hình
    // này" làm khách im luôn.
    const adQuote = () => {
      if (conversation.source === 'comment' || hasOrder || isLivestreamPost(conversation) || !settings.messageTemplates?.PRICE_QUOTE) return null;
      const product = resolveConversationProduct({ adTitle: conversation.referral?.adTitle, referralRef: conversation.referral?.ref, postText: conversation.post?.message }).product;
      return productHint(product) ? renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: product }, settings.messageTemplates, replyContext) : null;
    };
    const imageFallback = () => ({ ...(adQuote() || renderChatbotReply({ template_id: settings.messageTemplates?.IMAGE_RECEIVED ? 'IMAGE_RECEIVED' : 'CSKH_HANDOFF' }, settings.messageTemplates || {}, replyContext)), attention: true });
    // Khách bấm "Mua"/"Gửi giỏ hàng" ở Facebook Shop: SKU đã rõ, không cần model.
    const cartReply = message.cart?.length ? cartQuickReply(message.cart, settings.messageTemplates, replyContext) : null;
    // Khách thanh toán luôn trong Facebook Shop: Pancake tạo đơn POS (có SĐT, địa
    // chỉ) vài chục giây sau tin giỏ. Có đơn đó thì báo đã nhận, không xin lại
    // thông tin khách vừa điền (trước đây khách phải nhắn "chị đặt trên web rồi").
    const shopOrderReply = found => ({
      ...renderChatbotReply({
        template_id: 'SHOP_ORDER_RECEIVED',
        values: {
          cart: (cartReply?.pendingOrder?.items?.length ? cartReply.pendingOrder.items.map(item => `${item.quantity} ${item.product}`) : found.items.map(item => `${item.quantity} ${findProductBySku(item.sku)?.name || item.name}`)).join(' + '),
          total: found.total ? `${found.total.toLocaleString('vi-VN')}đ` : ''
        }
      }, settings.messageTemplates, replyContext),
      pendingOrder: null
    });
    // Tra một lần ngay (không bắt khách chờ); chưa có thì trả lời như thường và
    // tra lại ở nền (followUpShopOrder) — đơn Shop thường vào POS sau 0–2 phút.
    const canFindShopOrder = Boolean(cartReply && dependencies.findShopOrder && settings.messageTemplates?.SHOP_ORDER_RECEIVED && conversation.pancakeConversationId);
    const cartSince = (Number(change.message?.createdAt) || Date.now()) - 5 * 60 * 1000;
    const shopOrder = canFindShopOrder ? await dependencies.findShopOrder(conversation, { since: cartSince }).catch(() => null) : null;
    // Dưới bình luận, câu trả lời theo luật khi không có model: bảng giá sản
    // phẩm của bài, lời chào live, hay bảng giá chung.
    const postProduct = conversation.source === 'comment'
      ? resolveConversationProduct({ adTitle: conversation.referral?.adTitle, referralRef: conversation.referral?.ref, postText: conversation.post?.message }).product
      : '';
    const commentRuleReply = () => renderChatbotReply(
      productHint(postProduct) && settings.messageTemplates?.PRICE_QUOTE ? { template_id: 'PRICE_QUOTE', Product_N1: postProduct } : { template_id: 'GENERAL_INFO' },
      settings.messageTemplates, replyContext
    );
    const askModel = async (extra = {}) => {
      try {
        return await requestReply({ settings, conversation: { ...conversationForModel, ...extra }, message, recentMessages: recent.filter(item => !bundled.has(item?.id)), context: replyContext });
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
    // Lời đáp ngắn ("ok", "dạ", "cảm ơn") của khách.
    // Lời đáp ngắn, hay chỉ emoji/sticker chữ ("💕", "🥰🥰") sau đơn: cảm ơn, không hỏi mô hình.
    const shortAck = message.type === 'text' && (/^(ok|oke|okie|okay|okela|da|vang|u|uh|um|a|c|e|nhe|nha|shop|cam ?on|thanks?|tks|\.|👍|❤️)+$/i.test(folded.replace(/\s+/g, ''))
      || (/^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s.!]+$/u.test(String(message.text || '')) && /\p{Extended_Pictographic}/u.test(String(message.text || ''))));
    // "ok" ngay sau tin xác nhận/sửa đơn: cảm ơn luôn, không hỏi mô hình — mô hình
    // từng đọc lịch sử cũ và trả lời "ok" bằng tư vấn mẹ bầu/tiểu đường.
    const orderJustClosed = ['ORDER_CONFIRMATION', 'ORDER_UPDATE', 'ORDER_UNCHANGED', 'ORDER_NOTE', 'SHOP_ORDER_RECEIVED'].includes(conversation.botLastTemplateId);
    const ackReply = shortAck && orderJustClosed && settings.messageTemplates?.THANK_YOU
      ? renderChatbotReply({ template_id: 'THANK_YOU' }, settings.messageTemplates, replyContext)
      : null;
    // Ngay sau bảng giá một sản phẩm, "dùng thử" / "combo 2" / "3 túi" là khách đã
    // chọn: lên bước xin SĐT/địa chỉ với đúng sản phẩm vừa báo giá. Mô hình hay
    // gửi lại bảng giá vì chữ "dùng thử" có sẵn trong bảng (khách bỏ đi).
    const quoteAge = Date.now() - (Number(conversation.botLastReplyAt) || 0);
    const quotedName = !nonText && (conversation.botLastTemplateId === 'PRICE_QUOTE' || (conversation.botLastTemplateId === 'GENERAL_INFO' && recent.some(item => item?.direction === 'outgoing' && /Bảng giá (.+?) để/u.test(String(item.text || '')) && Date.now() - (Number(item.createdAt) || 0) < 30 * 60 * 1000))) && quoteAge < 30 * 60 * 1000
      ? [...recent].reverse().filter(item => item?.direction === 'outgoing').map(item => String(item.text || '').match(/Bảng giá (.+?) để/u)?.[1]).find(Boolean) || ''
      : '';
    const quoted = quotedName ? matchProduct(quotedName) : null;
    const choice = folded.trim().replace(/[.!]+$/, '').replace(/(\s+(nha|nhe|a|shop|em|e|nha shop|nhe shop|luon|di))+$/, '');
    const lead = '^(?:(?:cho|lay|dat|gui|ship|mua)\\s+)?(?:(?:em|minh|chi|c|e|a|anh|to|tui)\\s+)?(?:(?:lay|dat|mua)\\s+)?';
    const chosenQuantity = !quoted ? 0
      : new RegExp(`${lead}(?:(?:1|mot)\\s+(?:tui|goi|bich|hop)\\s+)?(?:dung thu|lay thu|an thu|mua thu)$`).test(choice) ? 1
        : new RegExp(`${lead}(?:combo\\s*2(?:\\s*(?:tui|goi|bich|hop))?|2\\s*(?:tui|goi|bich|hop))$`).test(choice) ? 2
          : new RegExp(`${lead}(?:combo\\s*3(?:\\s*(?:tui|goi|bich|hop))?|combo gia dinh|3\\s*(?:tui|goi|bich|hop))$`).test(choice) ? 3 : 0;
    const choiceReply = chosenQuantity
      ? renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: quoted.name, No_A: String(chosenQuantity) }, settings.messageTemplates, replyContext)
      : null;
    // Khách hỏi đơn đã đặt và gửi SĐT: tra đơn theo SĐT ở mọi hội thoại (đơn đặt
    // ở trang kia, qua bình luận…) thay vì coi SĐT là thông tin cho đơn MỚI.
    // Không gồm "xác nhận đơn"/"mua rồi": "xác nhận đơn giúp chị: 2 túi xanh, SĐT…"
    // và "mua rồi thấy ngon, lấy thêm 2 túi" là ĐẶT đơn mới, không phải tra đơn.
    const asksAboutOrder = /\b(da dat|dat roi|da mua|da chot|chua (thay|nhan)( duoc)? (hang|don)|don (toi|den) dau|gui hang chua|kiem tra don|tra don)\b/.test(folded);
    // "gói" bỏ dấu trùng "gọi" ("gọi trước khi giao"): chỉ tính khi có số hay "gói nhỏ".
    const namesProducts = /\b(tui|\d+ ?goi|goi nho|bich|hop|combo|xanh|vang|nau|cacao|lay them)\b/.test(folded);
    const phoneInText = nonText ? '' : extractVietnamesePhone(message.text || '');
    let lookupReply = null;
    if (phoneInText && !recentOrder?.id && !namesProducts && (asksAboutOrder || conversation.botLastTemplateId === 'ORDER_STATUS') && dependencies.findOrdersByPhone) {
      const found = (await dependencies.findOrdersByPhone(phoneInText).catch(() => [])) || [];
      lookupReply = found.length
        ? renderChatbotReply({ template_id: 'ORDER_STATUS' }, settings.messageTemplates, { ...replyContext, recentOrder: found[0] })
        : settings.messageTemplates?.ORDER_STATUS_CHECKING
          ? { ...renderChatbotReply({ template_id: 'ORDER_STATUS_CHECKING' }, settings.messageTemplates, replyContext), attention: true }
          : null;
    }
    // Khách vừa đặt dặn thêm về giao hàng ("gửi hàng mới cho mình", "giao giờ hành
    // chính", "gọi trước khi giao"): ghi chú vào đơn, trả lời ngắn — mô hình từng
    // chọn ORDER_STATUS và gửi lại cả đoạn trạng thái đơn khách vừa đọc xong.
    // Chỉ lời dặn THUẦN: hộp thư, tin ngắn, không SĐT/số nhà/sản phẩm, không kèm
    // sửa địa chỉ, đặt thêm, bớt túi hay câu hỏi — những tin đó để mô hình xử lý.
    const deliveryNote = !nonText && hasOrder && conversation.source !== 'comment' && settings.messageTemplates?.ORDER_NOTE_ADDED
      && folded.length <= 80 && !phoneInText && !/\d{2,}/.test(folded) && !namesProducts
      && /\b(hang moi|date moi|han (su dung |dung )?(dai|xa|moi|lau)|moi san xuat|giao (gio hanh chinh|buoi|sang|chieu|toi|cuoi tuan|truoc|sau|nhanh|som)|goi (truoc|dien truoc|cho (minh|em|chi|anh|c|e) truoc)|de (o|tai|cho) (bao ve|le tan|cong|nha ben|hang xom)|gui (som|nhanh|gap)|dong goi (can than|ky)|(ngoai )?gio hanh chinh)\b/.test(folded)
      && !/\?|\b(huy|doi|them|nua|bot|sua|lay|dat|mua|dia chi|sdt|so dien thoai|khong lay|chua nhan|bi loi|bi hu|khi nao|bao gio|duoc khong|dc khong|ko|khong)\b/.test(folded);
    const noteReply = deliveryNote ? renderChatbotReply({ template_id: 'ORDER_NOTE' }, settings.messageTemplates, replyContext) : null;
    // Luật nhận ý bằng code (processing/rule-intent.mjs): tin ngắn, rõ ý (hỏi giá
    // cụt, ".", chào, giỏ ghi rõ, SĐT trơn, câu hỏi thông tin ngắn) trả thẳng mẫu,
    // không gọi mô hình. settings.ruleIntent: 'on' (mặc định) | 'shadow' (chỉ ghi
    // log so với mô hình) | 'off'.
    const ruleMode = settings.ruleIntent || 'off';
    const lastOutgoingAt = Math.max(0, ...recent.filter(item => item?.direction === 'outgoing').map(item => Number(item.createdAt) || 0));
    const ruleProduct = conversation.source === 'comment' ? '' : resolveConversationProduct({ adTitle: conversation.referral?.adTitle, referralRef: conversation.referral?.ref, postText: conversation.post?.message }).product;
    // Luồng riêng cho ưu đãi 1 túi dùng thử: chạy trước mọi câu trả lời nhanh / luật /
    // mô hình của luồng chung (không bảng giá combo, không mời 2 túi). Khách tự xin
    // ≥ 2 túi thì thoát sang luồng thường (giá combo). Xin gặp người, giỏ Shop: như cũ.
    let trialPatch = null;
    let trialOutcome = null;
    if (trialState && !asksForHuman && !cartReply) {
      trialOutcome = trialStep({ text: message.text, type: message.type, trial: trialState, lastTemplateId: conversation.botLastTemplateId || '' });
      trialPatch = trialOutcome.patch || null;
      if (trialOutcome.exit) trialState = null;
      else if (trialPatch) trialState = { ...trialState, ...trialPatch };
      replyContext.trial = trialState;
      console.log(`Dùng thử: ${trialOutcome.exit ? `thoát (${trialOutcome.exit})` : trialOutcome.delegate ? 'nhờ mô hình' : trialOutcome.value.template_id} (${conversation.id})`);
    }
    const trialActive = Boolean(trialState && trialOutcome && !trialOutcome.exit);
    const ruled = message.type === 'text' && !asksForHuman && !cartReply && ruleMode !== 'off'
      ? ruleIntent(message.text, {
          source: conversation.source,
          botLastTemplateId: conversation.botLastTemplateId || '',
          staffRepliedAfterBot: lastOutgoingAt > (Number(conversation.botLastReplyAt) || 0) + 5000,
          botLastAgeMin: conversation.botLastReplyAt ? (Date.now() - Number(conversation.botLastReplyAt)) / 60000 : Infinity,
          hasBasket: Boolean(conversation.pendingOrder?.items?.length),
          lastWasOrderStep: isOrderStep(conversation.botLastTemplateId) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(conversation.botLastTemplateId),
          hasRecentOrder: Boolean(recentOrder?.id),
          orderAgeMin: recentOrder?.id && String(recentOrder.processingStatus || '') !== 'cancelled' ? (Date.now() - (Number(recentOrder.createdAt) || 0)) / 60000 : Infinity,
          livestream: isLivestreamPost(conversation),
          contextProduct: productHint(ruleProduct) ? ruleProduct : '',
          bundleSize: bundle.length,
          complaint: isComplaint({ text: message.text, keywords: settings.complaintKeywords }),
          commentBasket,
          trialOffer: Boolean(trialState),
          experimentalRules: settings.experimentalRules || 'shadow',
          quotedProduct: quotedName || '',
          addressComplete: Boolean(message.type === 'text' && conversation.pendingOrder?.items?.length && describeDeliveryAddress(String(message.text || '').replace(/\+?\d[\d .-]{8,13}/g, ' ').trim()).complete),
          addressText: String(message.text || '').replace(/\+?\d[\d .-]{8,13}/g, ' ').replace(/\s+/g, ' ').trim(),
          smallPackContext: conversation.botLastTemplateId === 'PACKAGING_INFO'
            || (conversation.pendingOrder?.items || []).some(item => /^CB10|combo 10/i.test(String(item.code || item.product || '')))
            || replyContext.recentOutgoing.some(text => /gói nhỏ|combo 10 gói/i.test(text))
        })
      : null;
    const ruleReply = ruled
      ? (ruled.commentRule ? commentRuleReply() : { ...renderChatbotReply(ruled.value, settings.messageTemplates, replyContext), ...(ruled.attention ? { attention: true } : {}) })
      : null;
    // Luật thử nghiệm: chỉ dùng khi settings.experimentalRules = 'on'; còn lại ghi log so với mô hình.
    const ruleUsable = Boolean(ruled) && !ruled.shadowOnly;
    const ruleShadow = Boolean(ruled) && (ruleMode === 'shadow' || !ruleUsable);
    if (ruled) console.log(`Luật ${ruled.rule}${ruleShadow ? ' (thử)' : ''} → ${ruleReply.templateId} (${conversation.id})`);
    // Luật thử nghiệm đính kèm một luật ổn định: ghi log so với luật ổn định, không đổi câu trả lời.
    if (ruled?.shadow) console.log(`Luật ${ruled.shadow.rule} (thử): luật ${ruled.shadow.value?.template_id || ruled.shadow.rule} / luật ổn định ${ruleReply.templateId}${(ruled.shadow.value?.template_id || '') === ruleReply.templateId ? ' ✓' : ' ✗'} (${conversation.id})`);
    let reply = asksForHuman
      ? renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, settings.messageTemplates, replyContext)
      : cartReply
        // Khách giữ ưu đãi dùng thử mà đặt qua giỏ Shop (Shop tự cộng ship): gắn thẻ
        // để nhân viên sửa đơn miễn ship trên POS.
        ? (trialState ? { ...(shopOrder ? shopOrderReply(shopOrder) : cartReply), attention: true } : shopOrder ? shopOrderReply(shopOrder) : cartReply)
        : trialOutcome?.value
          ? renderChatbotReply(trialOutcome.value, settings.messageTemplates, replyContext)
          : trialActive
            ? (nonText && !seesImage
              ? { ...renderChatbotReply({ template_id: settings.messageTemplates?.IMAGE_RECEIVED ? 'IMAGE_RECEIVED' : 'CSKH_HANDOFF' }, settings.messageTemplates, replyContext), attention: true }
              : await askModel({ trialHint: trialModelHint(trialState) }))
            : nonText
              ? (seesImage ? await askModel() : imageFallback())
              : ackReply || noteReply || lookupReply || choiceReply || quickQuote || (ruleMode === 'on' && ruleUsable ? ruleReply : null) || await askModel();
    // Mô hình trả lời khách đang giữ ưu đãi bằng mẫu của luồng chung (bảng giá, combo,
    // mời 2 túi, "từ 2 túi miễn ship"): đổi sang mẫu dùng thử.
    if (trialActive && !trialOutcome.value) {
      const replacement = filterTrialReply(reply, trialState, isProductQuoteId);
      if (replacement) reply = renderChatbotReply(replacement, settings.messageTemplates, replyContext);
    }
    // Bảng giá chung (3 vị, giá lẻ chưa ship) một mình làm khách rối và thấy đắt: trong
    // hộp thư gửi kèm luôn bảng giá chi tiết Túi Xanh (1 túi / combo 2 / combo 3 + quà,
    // kèm ảnh). Không áp cho bình luận, phiên live, khách đang giữ ưu đãi dùng thử; bảng
    // Túi Xanh vừa gửi trong 30 phút thì cơ chế ý phụ tự bỏ, không gửi lại.
    const defaultQuoteProduct = findProductBySku('GRA-XANH-Z450')?.name || '';
    if (reply.templateId === 'GENERAL_INFO' && !reply.alsoTemplateId && !trialActive && defaultQuoteProduct
      && conversation.source !== 'comment' && !isLivestreamPost(conversation) && settings.messageTemplates?.PRICE_QUOTE) {
      const quote = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: defaultQuoteProduct }, settings.messageTemplates, replyContext);
      const opening = String(quote.messages?.[0] || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const justSent = opening && replyContext.recentOutgoing.some(text => String(text).replace(/\s+/g, ' ').includes(opening));
      // Pancake tự chào khách bấm quảng cáo bằng bảng 3 giá (có khi cùng phút, chưa kịp vào kho tin):
      // khách đến từ quảng cáo mà bot chưa trả lời gì cũng coi như đã có bảng 3 giá.
      const adGreeted = Boolean(conversation.referral?.adTitle || conversation.referral?.ref) && !conversation.botLastTemplateId;
      const priceListSent = adGreeted || replyContext.recentOutgoing.some(text => /174\.000đ/.test(text) && /Túi Vàng/i.test(text) && !/Bảng giá Granola/i.test(text));
      if (quote.templateId === 'PRICE_QUOTE' && !justSent && priceListSent) reply = { ...quote, ...(reply.attention ? { attention: true } : {}) };
      else if (quote.templateId === 'PRICE_QUOTE' && !justSent) {
        const partsOf = item => item.parts || [...item.messages.map(text => ({ type: 'text', text })), ...(item.images || []).map(url => ({ type: 'image', url }))];
        reply = { ...reply, messages: [...reply.messages, ...quote.messages], parts: [...partsOf(reply), ...partsOf(quote)], images: [...(reply.images || []), ...(quote.images || [])], alsoTemplateId: 'PRICE_QUOTE' };
      }
    }
    // Cùng mẫu dùng thử vừa gửi lượt trước: nhắc ngắn thay vì gửi lại nguyên văn.
    if (trialActive && String(reply.templateId).startsWith('TRIAL_') && reply.templateId !== 'TRIAL_REMIND'
      && conversation.botLastTemplateId === reply.templateId && settings.messageTemplates?.TRIAL_REMIND) {
      reply = renderChatbotReply({ template_id: 'TRIAL_REMIND', values: { bags: trialBagOptions() } }, settings.messageTemplates, replyContext);
    }
    if (ruleShadow) console.log(`Luật ${ruled.rule} (thử): luật ${ruleReply.templateId} / mô hình ${reply.templateId}${ruleReply.templateId === reply.templateId ? ' ✓' : ' ✗'} (${conversation.id})`);
    if (seesImage && !trialActive && (reply.templateId === 'IMAGE_RECEIVED' || reply.templateId === 'CSKH_HANDOFF')) reply = imageFallback();
    // "Cảm ơn" mà khách chưa có đơn: ảnh (thường là ảnh sản phẩm, không phải
    // bill) → xử lý như ảnh; "đã đặt rồi" → tra đơn. Không cảm ơn suông rồi thôi.
    if (reply.templateId === 'THANK_YOU' && !hasOrder && !ackReply) {
      if (nonText) reply = imageFallback();
      else if (asksAboutOrder) reply = renderChatbotReply({ template_id: 'ORDER_STATUS' }, settings.messageTemplates, replyContext);
    }
    // "Chưa nhận được hàng" mà hội thoại không có đơn (đơn ở trang kia, nhân viên
    // lên tay…): bot chỉ xin SĐT được — gắn thẻ để nhân viên tra ngay.
    if (reply.templateId === 'ORDER_STATUS' && !recentOrder?.id && !lookupReply && !reply.attention) reply = { ...reply, attention: true };
    // Khách than giao chậm / chưa nhận: luôn gắn thẻ để nhân viên tra vận đơn.
    if (reply.templateId === 'DELIVERY_DELAY' && !reply.attention) reply = { ...reply, attention: true };
    // Dưới bình luận không bao giờ chuyển người (khách chưa vào hộp thư): trả
    // bảng giá chung và mời nhắn tin. WELCOME/xác nhận đơn/"đã nhận hình" dưới
    // bình luận cũng vô nghĩa (khách đã hỏi giá rồi) → bảng giá sản phẩm của bài.
    // Riêng bình luận là khiếu nại/hủy/đổi đơn/chưa nhận hàng (khách đã là người
    // mua): không chào hàng — nhắn riêng rằng nhân viên sẽ kiểm tra, gắn thẻ.
    const commentNeedsStaff = conversation.source === 'comment'
      && /\b(huy|doi don|khieu nai|chua nhan|khong thay (gui|hang)|chua thay (gui|hang)|bi loi|bi hu|sai don|giao sai)\b/.test(folded);
    // Hủy/tra đơn dưới bình luận chỉ được bot tự lo khi có đơn thật; đơn đặt trên
    // web/landing (không có trong hội thoại) thì báo nhân viên, không "chưa thấy đơn".
    // Dưới bình luận bot KHÔNG hủy/sửa/ghi chú/tạo đơn được (chỉ nhắn riêng một
    // lần): "đã hủy đơn" hay "xác nhận đơn" gửi qua bình luận là hứa suông — báo
    // nhân viên, gắn thẻ; giỏ + SĐT + địa chỉ khách ghi đi theo sang hộp thư.
    const commentOrderOp = conversation.source === 'comment' && Boolean(reply.order);
    if (conversation.source === 'comment' && settings.messageTemplates?.COMMENT_STAFF_FOLLOWUP && (commentNeedsStaff || commentOrderOp || (reply.templateId === 'CSKH_HANDOFF' && !asksForHuman))
      && !(reply.templateId === 'ORDER_STATUS' && recentOrder?.id)) {
      const carriedOrder = reply.templateId === 'ORDER_CONFIRMATION' && reply.order?.items?.length
        ? { items: reply.order.items.map(item => ({ product: item.product, code: item.code, quantity: item.quantity })), key: reply.order.orderKey || '', at: Date.now(), phone: reply.order.phone || '', address: reply.order.rawAddress || reply.order.address || '', addressAsks: 0 }
        : undefined;
      reply = { ...renderChatbotReply({ template_id: 'COMMENT_STAFF_FOLLOWUP' }, settings.messageTemplates, replyContext), attention: true, ...(carriedOrder ? { pendingOrder: carriedOrder } : {}) };
    }
    const commentBlocked = new Set(['CSKH_HANDOFF', 'WELCOME', 'ASK_PRODUCT', 'IMAGE_RECEIVED']);
    if (commentBlocked.has(reply.templateId) && !asksForHuman && conversation.source === 'comment' && settings.messageTemplates?.GENERAL_INFO) {
      reply = commentRuleReply();
    }
    // Bình luận nêu rõ giỏ ("C 2 túi vàng", "túi vàng với túi xanh lá") mà model
    // trả bảng giá/so sánh: lên bước xin SĐT/địa chỉ với giỏ đó. Có kèm câu hỏi
    // ("combo 2 túi vàng bn") thì vẫn trả lời câu hỏi, nhưng giỏ đi theo khách
    // sang hộp thư để khách nhắn địa chỉ là chốt được.
    const basket = conversation.source === 'comment' && !commentNeedsStaff && !commentOrderOp ? commentBasket(message.text) : [];
    const softForBasket = new Set(['PRICE_QUOTE', 'PRICE_MIX_TUI_LON', 'BAG_COMPARISON', 'BAG_COMPARISON_XANH_VANG', 'GENERAL_INFO', 'LIVESTREAM_COMMENT', 'LIVESTREAM_VOUCHER', 'COMMENT_STAFF_FOLLOWUP', 'ORDER_STATUS']);
    if (basket.length && softForBasket.has(reply.templateId) && !(reply.templateId === 'ORDER_STATUS' && recentOrder?.id)) {
      const slots = ['Product_N1', 'No_A', 'Product_N2', 'No_B', 'Product_N3', 'No_C'];
      const value = { template_id: 'ORDER_ADDRESS' };
      basket.slice(0, 3).forEach((item, index) => { value[slots[index * 2]] = item.product; value[slots[index * 2 + 1]] = String(item.quantity); });
      const orderReply = renderChatbotReply(value, settings.messageTemplates, replyContext);
      const asksInfo = /\?|\b(gia|bn|bao nhieu|khac|sao|ntn|the nao|gam|gram|ngon|nao)\b/.test(folded);
      reply = asksInfo ? { ...reply, pendingOrder: orderReply.pendingOrder } : orderReply;
    }
    // Phiên live: khách báo "đã săn/đã mua 290k", hỏi "săn thế nào", mà chưa có
    // đơn → ghi nhận và xin loại, số lượng, SĐT, địa chỉ (trước đây nhận "chưa
    // thấy đơn nào" hay mẫu voucher sàn, không ai chốt).
    // Khiếu nại/hủy/chưa nhận hàng dưới live không phải "vừa săn deal".
    const liveDeal = isLivestreamPost(conversation) && !recentOrder?.id && !basket.length && !commentNeedsStaff && settings.messageTemplates?.LIVE_DEAL_CLAIMED
      && !/\b(chua (nhan|thay|giao)|huy|khieu nai|bi loi|bi hu)\b/.test(folded)
      && (/\b(da (san|mua|chot|dat)|san (duoc|deal|the nao|tn|sao|ntn)|len ma|ma gi|cach (san|chot|tham gia|dat|mua))\b/.test(folded) || reply.templateId === 'ORDER_STATUS');
    if (liveDeal) reply = { ...renderChatbotReply({ template_id: 'LIVE_DEAL_CLAIMED' }, settings.messageTemplates, replyContext), attention: true };
    // Dưới phiên livestream nhiều sản phẩm, "hỏi giá chung" không nên là bảng
    // 3 vị khô khan: dùng lời chào live (nêu các vị có trên live, ưu đãi live,
    // hỏi khách quan tâm loại nào) nếu chủ shop có soạn mẫu LIVESTREAM_COMMENT.
    // Câu hỏi không phải hỏi giá (mẹ bầu, cho bé, yến mạch, hạt điều) thì trả đúng mẫu.
    if (reply.templateId === 'GENERAL_INFO' && settings.messageTemplates?.LIVESTREAM_COMMENT && isLivestreamPost(conversation)) {
      const routed = [
        [/\b(me bau|bau bi|dang bau|tieu duong|benh)\b/, 'HEALTH_CONDITION'],
        [/\b(cho be|be an|tre em|tre nho|con nho)\b/, 'KIDS_FAMILY'],
        [/\byen mach\b/, 'PRICE_YEN_MACH_UC_NGUYEN_CAM'],
        [/\b(hat dieu|hat bi|sua hat|xoai|dau say)\b/, 'LIVE_ONLY_PRODUCT']
      ].find(([pattern, id]) => pattern.test(folded) && settings.messageTemplates?.[id]);
      reply = renderChatbotReply({ template_id: routed ? routed[1] : 'LIVESTREAM_COMMENT' }, settings.messageTemplates, replyContext);
    }
    // Mô hình chọn mẫu live cho khách không đến từ live: đổi về mẫu thường.
    if (!isLivestreamPost(conversation) && conversation.source !== 'comment') {
      if (reply.templateId === 'LIVESTREAM_COMMENT' && settings.messageTemplates?.GENERAL_INFO) reply = renderChatbotReply({ template_id: 'GENERAL_INFO' }, settings.messageTemplates, replyContext);
      else if (reply.templateId === 'LIVESTREAM_VOUCHER' && settings.messageTemplates?.DISCOUNT_POLICY) reply = renderChatbotReply({ template_id: 'DISCOUNT_POLICY' }, settings.messageTemplates, replyContext);
      // Sản phẩm ngoài danh mục bot (hạt bí xanh, bơ hạt điều…) trong hộp thư: không nói "chỉ bán trên live" — nhân viên báo giá.
      else if (reply.templateId === 'LIVE_ONLY_PRODUCT') reply = { ...renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, settings.messageTemplates, replyContext), attention: true };
    }
    // Bình luận có SĐT: nhân viên cần thấy để gọi chốt.
    if (conversation.source === 'comment' && extractVietnamesePhone(message.text || '')) reply = { ...reply, attention: true };
    // Không gửi lại y nguyên tin bot vừa gửi trong 10 phút (hỏi SĐT lần ba, cảm ơn
    // hai lần), và không chuyển người lần hai trong 24 giờ.
    // Cùng lời (câu đầu của mẫu) đã gửi trong 10 phút, hay cùng một mẫu "không
    // nên lặp" (chào, cảm ơn, xin SĐT, xác nhận đơn…) vừa gửi chưa đầy 60 giây
    // (hai tin của khách tới cùng lô webhook): không gửi lần hai.
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    // So khớp lỏng: bỏ khoảng trắng thừa và câu mở đầu của tin riêng sau bình
    // luận ("Dạ em thấy … để lại bình luận…"), để lời vừa gửi riêng qua bình
    // luận cũng được nhận ra khi khách nhắn tiếp vào hộp thư.
    // Xưng hô cũng bỏ: "anh/chị" lượt trước, "chị" lượt sau vẫn là cùng một câu.
    const normalizeSent = value => String(value || '').replace(/^Dạ em thấy .*? để lại bình luận[^\n]*\n+/u, '')
      .replace(/(?<![\p{L}])(anh\s*\/\s*chị|anh chị|chị|anh|bạn|cô|chú)(?![\p{L}])/giu, '~').replace(/\s+/g, ' ').trim();
    const firstLine = normalizeSent(reply.messages?.[0] || '');
    const repeatsText = firstLine.length > 20 && recent.some(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo && normalizeSent(item.text).includes(firstLine));
    const noRepeatTemplates = new Set(['WELCOME', 'THANK_YOU', 'CSKH_HANDOFF', 'ORDER_CONFIRMATION', 'ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'GENERAL_INFO', 'LIVESTREAM_COMMENT']);
    const repeatsTemplate = noRepeatTemplates.has(reply.templateId) && conversation.botLastTemplateId === reply.templateId && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 60 * 1000;
    // Giỏ mới khác giỏ đang giữ (giỏ Shop mới, khách đổi vị/số túi, nhận lời gợi
    // ý 2 túi): là thay đổi thật, không phải lặp — trước đây bot im và giỏ mới mất.
    const changedCart = Boolean(reply.pendingOrder?.key) && reply.pendingOrder.key !== conversation.pendingOrder?.key;
    // Ghi chú/hủy/sửa đơn là thao tác thật (lời dặn thứ hai khác lời dặn đầu dù câu
    // trả lời giống nhau): không coi là lặp.
    const orderAction = Boolean(reply.order?.noteOrderId || reply.order?.cancelOrderId || reply.order?.updateOrderId);
    const repeatsLast = (repeatsText || repeatsTemplate) && !changedCart && !orderAction;
    const repeatsHandoff = reply.templateId === 'CSKH_HANDOFF' && conversation.botLastTemplateId === 'CSKH_HANDOFF'
      && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 24 * 60 * 60 * 1000;
    const isComment = conversation.source === 'comment';
    if (repeatsLast || repeatsHandoff) {
      // Chỉ im lặng với lời đáp ngắn ("ok", "dạ") hay khi đã chuyển người; khách
      // nhắn có nội dung mà bot sắp lặp lại tin vừa gửi thì không để khách chờ:
      // - bước đơn (xin SĐT/địa chỉ): nhắc ngắn giỏ + tổng + phần còn thiếu;
      // - bảng giá: nhắc "đã gửi ở trên" và mời chốt (chỉ khi chưa có đơn);
      // - thông tin khác: nói đã gửi ở trên, gắn thẻ để nhân viên giải thích thêm.
      const substantive = !shortAck && message.type === 'text' && folded.replace(/\s+/g, '').length >= 2;
      const informational = !isOrderStep(reply.templateId) && !['ASK_FLAVOR', 'ASK_PRODUCT', 'THANK_YOU', 'WELCOME', 'CSKH_HANDOFF', 'ORDER_UNCHANGED', 'ORDER_CUSTOM_BASKET'].includes(reply.templateId);
      const priceFamily = new Set(['PRICE_QUOTE', 'GENERAL_INFO', 'PRICE_MIX_TUI_LON', 'DISCOUNT_POLICY', 'LIVESTREAM_COMMENT', 'PRICE_QUOTE_COMBO']);
      const remindOrder = repeatsLast && !repeatsHandoff && substantive && Boolean(reply.remind) && conversation.botLastTemplateId !== 'ORDER_ADDRESS_REMIND' && !isComment;
      // Khách đã đặt đơn (24 giờ, chưa hủy) mà hỏi lại điều vừa kèm trong tin xác
      // nhận ("Hà Nội mấy ngày tới?"): trả lời lại đúng thông tin đó, trừ khi
      // chính nó là tin bot vừa gửi.
      const answerAgain = repeatsLast && !repeatsHandoff && informational && substantive && hasOrder
        && conversation.botLastTemplateId !== reply.templateId && !isComment;
      const nudgeId = priceFamily.has(reply.templateId) && !hasOrder ? 'REPLY_ALREADY_SENT' : 'REPLY_ALREADY_SENT_INFO';
      // Nhắc 'đã gửi ở trên' chỉ khi CHÍNH KHÁCH lặp lại câu vừa hỏi (đọc 361 hội thoại 24–25/09:
      // 11/11 lần nhắc đều sai — khách hỏi ý mới, đưa SĐT tra đơn… mà bị bảo 'xem ở trên').
      const previousIncoming = [...recent].reverse().find(item => item?.direction === 'incoming' && item.id !== message.id && (!message.mid || item.mid !== message.mid));
      const squashText = value => foldVietnamese(String(value || '')).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
      const customerRepeats = Boolean(previousIncoming) && (() => { const before = squashText(previousIncoming.text); const current = squashText(message.text); return Boolean(before) && (before === current || (current.length >= 12 && before.startsWith(current.slice(0, 20)))); })();
      // Khách hỏi ý khác chủ đề vừa trả lời (có SĐT, nêu sản phẩm, hỏi đơn, hay luật nhận ra một
      // mẫu khác): không nhắc "ở trên" — im và gắn thẻ để nhân viên trả lời.
      const sameTopic = !phoneInText && !namesProducts && !asksAboutOrder
        && (!ruled?.value?.template_id || ruled.value.template_id === reply.templateId || ruled.value.also === reply.templateId || (ruled.value.template_id === 'GENERAL_INFO' && priceFamily.has(reply.templateId)));
      const canNudge = repeatsLast && !answerAgain && !remindOrder && informational && substantive && (customerRepeats || sameTopic) && settings.messageTemplates?.[nudgeId]
        && !['REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO'].includes(conversation.botLastTemplateId) && !isComment;
      if (!canNudge && !answerAgain && !remindOrder) {
        // Im lặng nhưng không bỏ rơi: giỏ mới vẫn được lưu; khách nhắn có nội
        // dung thì gắn thẻ để nhân viên thấy có người đang chờ.
        if (saveBotState && !isComment) {
          await saveBotState(conversation.id, {
            ...(reply.pendingOrder !== undefined ? { pendingOrder: reply.pendingOrder } : {}),
            ...(substantive && !repeatsHandoff ? { addLabelEvents: ['handoff'] } : {})
          }).catch(() => {});
        }
        results.push({ conversationId: conversation.id, skipped: repeatsLast ? 'lặp tin vừa gửi' : 'đã chuyển người trong 24 giờ' });
        return;
      }
      if (remindOrder) reply = { ...reply, templateId: 'ORDER_ADDRESS_REMIND', messages: [reply.remind], parts: undefined, images: [] };
      else if (canNudge) reply = { ...renderChatbotReply({ template_id: nudgeId }, settings.messageTemplates, replyContext), pendingOrder: reply.pendingOrder, attention: nudgeId === 'REPLY_ALREADY_SENT_INFO' };
    }
    // Trong lúc chờ mô hình khách nhắn thêm (chữ hay ảnh): bỏ câu này, tin sau trả lời gộp.
    if (hasNewerCustomerMessage(await listMessages(conversation.id), change.message)) {
      results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
      return;
    }
    // Nhân viên vừa nhận khách (tắt bot) trong lúc model chạy: không lên đơn trùng
    // với đơn nhân viên đang lên, không gửi chuỗi xác nhận thứ hai.
    if (reply.order && !isComment && getConversation) {
      const latest = await getConversation(conversation.id).catch(() => null);
      if (latest?.botEnabled === false) {
        results.push({ conversationId: conversation.id, skipped: 'nhân viên đã nhận khách' });
        return;
      }
    }
    // Sắp tự lên đơn mới mà hội thoại đã có đơn POS trong giờ qua (khách đặt qua
    // Facebook Shop, hay nhân viên vừa lên): không tạo đơn trùng, báo đã nhận đơn.
    if (reply.order && !reply.order.updateOrderId && !reply.order.cancelOrderId && !reply.order.noteOrderId && !isComment && dependencies.findShopOrder && settings.messageTemplates?.SHOP_ORDER_RECEIVED) {
      const existing = await dependencies.findShopOrder(conversation, { since: Date.now() - 60 * 60 * 1000 }).catch(() => null);
      // Chỉ coi là trùng khi CÙNG SĐT và khách không nói tách/thêm đơn ("đơn khác",
      // "gửi mẹ", "thêm", "nữa"); khác thì vẫn lên đơn nhưng gắn thẻ cho nhân viên soát.
      const separate = /\b(don khac|don moi|nguoi khac|dia chi khac|gui (cho )?(me|ba|bo|chi|em|ban|anh|nguoi)|tach don|them|nua)\b/.test(folded);
      const digits = value => String(value || '').replace(/\D/g, '').slice(-9);
      const samePhone = existing && digits(existing.phone) && digits(existing.phone) === digits(reply.order.phone);
      const skuOf = value => String(value || '').trim().toUpperCase();
      const basketOf = list => (Array.isArray(list) ? list : []).map(item => `${skuOf(item.sku || item.code)}=${Number(item.quantity) || 1}`).sort().join(',');
      const sameBasket = existing && (!Array.isArray(existing.items) || !existing.items.length || basketOf(existing.items) === basketOf(reply.order.items));
      if (existing && samePhone && !separate && sameBasket) reply = shopOrderReply(existing);
      else if (existing) reply = { ...reply, attention: true };
    }
    // The order is persisted BEFORE anything is sent. Sending first meant a
    // failed order left the customer holding a confirmation for an order that
    // did not exist, and a retried webhook sent the whole reply a second time.
    // "Tự động lên đơn" tắt (settings.autoOrder === false): bot vẫn xác nhận với
    // khách nhưng không tạo đơn; giỏ được giữ ở pendingOrder cho nhân viên.
    // Khách sửa đơn vừa chốt: cập nhật đúng đơn đó (updateOrder), không tạo đơn mới.
    const wantsUpdate = Boolean(reply.order?.updateOrderId) && typeof updateOrder === 'function';
    // Khách hủy đơn vừa đặt: đánh dấu hủy đúng đơn đó (không tạo, không sửa).
    const wantsCancel = Boolean(reply.order?.cancelOrderId) && typeof cancelOrder === 'function';
    // Khách dặn thêm cho đơn vừa đặt ("gửi hàng mới", "gọi trước khi giao"): ghi vào đơn.
    const wantsNote = Boolean(reply.order?.noteOrderId) && typeof dependencies.addOrderNote === 'function';
    const outcome = settings.responseMode === 'automatic' && settings.autoOrder !== false && reply.order && (wantsNote || wantsCancel || wantsUpdate || createOrder) && !isComment
      ? (wantsNote
        ? await dependencies.addOrderNote(conversation, reply.order.noteOrderId, reply.order.note)
        : wantsCancel
          ? await cancelOrder(conversation, reply.order.cancelOrderId)
          : wantsUpdate
            ? await updateOrder(conversation, reply.order.updateOrderId, reply.order)
            : await createOrder(conversation, reply.order, { sourceMessageId: String(change.message.mid || change.message.id || '') }))
      : null;
    // Đơn vừa hủy hay chỉ thêm ghi chú không phải "đơn mới" cho nhãn/phiếu.
    const order = outcome?.cancelled || outcome?.noted ? null : outcome?.order || null;
    const alreadyHandled = Boolean(outcome) && outcome.created === false && !outcome.updated && !outcome.cancelled && !outcome.noted;
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
        // Khách bình luận ở nhiều bài trong vài phút: bảng giá khác nhau (bài Túi
        // Xanh, bài chung…) vẫn là bảng giá — hộp thư vừa nhận bảng giá dưới 30
        // phút thì không gửi thêm bảng thứ hai, thứ ba.
        const priceFamily = new Set(['PRICE_QUOTE', 'GENERAL_INFO', 'LIVESTREAM_COMMENT', 'PRICE_MIX_TUI_LON']);
        if (!privateSkipped && inbox && !basket.length && priceFamily.has(reply.templateId) && priceFamily.has(inbox.botLastTemplateId)
          && Date.now() - (Number(inbox.botLastReplyAt) || 0) < 30 * 60 * 1000) privateSkipped = true;
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
      // Lời chê/khiếu nại dưới bài: công khai xin lỗi, không "em đã ib 🥰".
      const complaintPublic = reply.templateId === 'COMMENT_STAFF_FOLLOWUP' && settings.messageTemplates?.COMMENT_PUBLIC_SORRY
        && isComplaint({ text: message.text, templateId: reply.templateId, keywords: settings.complaintKeywords });
      const publicId = privateError ? 'COMMENT_PUBLIC_FALLBACK'
        : complaintPublic ? 'COMMENT_PUBLIC_SORRY'
          : privateSkipped && settings.messageTemplates?.COMMENT_PUBLIC_REPEAT ? 'COMMENT_PUBLIC_REPEAT' : 'COMMENT_PUBLIC_REPLY';
      // Luồng vừa có lời công khai trong 10 phút (khách bình luận liền 3–4 lần):
      // không đăng thêm "em đã ib" lần nữa dưới bài — trừ khi lần trước lỗi.
      const publicRecently = !privateError && recent.some(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo);
      // Ẩn bình luận có SĐT trước khi đăng lời công khai: lời công khai có thể
      // chạm hết thời gian chờ, bình luận có SĐT không được nằm hiện trên bài.
      // Like the comment so the customer sees it was noticed; hide it when it
      // carries a phone number (or always, per settings) so competitors
      // cannot lift the lead from the post.
      if (moderateComment) {
        const hide = settings.commentHide === 'all' || (settings.commentHide === 'phone' && Boolean(extractVietnamesePhone(message.text)));
        await moderateComment(conversation, change.message, { like: settings.commentLike !== false, hide }).catch(() => {});
      }
      const publicReply = publicRecently ? { messages: [] } : renderChatbotReply({ template_id: publicId }, settings.messageTemplates, replyContext);
      for (const text of pickVariant(publicReply)) {
        // Hết thời gian chờ khi đăng (Pancake vẫn đăng được): không coi là lỗi của cả lượt.
        await sendMessage(conversation, { text }).catch(error => {
          if (!/abort/i.test(error.message || '')) throw error;
          console.warn(`Lời công khai hết thời gian chờ (${conversation.id}): ${error.message}`);
        });
      }
    } else if (settings.responseMode === 'automatic' && !alreadyHandled) {
      // Theo đúng thứ tự của mẫu: ảnh đặt đầu mẫu đi trước bảng giá, ảnh đặt
      // cuối đi sau chữ. Mẫu không có dãy gửi thì chữ trước, ảnh sau.
      let parts = reply.parts || [...reply.messages.map(text => ({ type: 'text', text })), ...(reply.images || []).map(url => ({ type: 'image', url }))];
      // Cùng một đoạn chữ / ảnh xuất hiện hai lần trong một lượt: gửi một lần.
      const seenParts = new Set();
      parts = parts.filter(part => { const key = `${part.type}:${String(part.text || part.url || '').replace(/\s+/g, ' ').trim()}`; if (seenParts.has(key)) return false; seenParts.add(key); return true; });
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
    // Ưu đãi dùng thử: lưu bước (đã chọn túi, đã mời, từ chối, chuyển đơn thường) và
    // đóng ưu đãi khi đơn dùng thử đã tạo (không dùng lại được).
    const trialOrdered = Boolean(order && (order.trialFreeShip || reply.order?.trial));
    const promoUpdate = conversation.promo && (trialPatch || trialOrdered)
      ? { ...conversation.promo, ...(trialPatch || {}), ...(trialOrdered ? { stage: 'ordered', orderId: String(order.id), endedAt: Date.now() } : {}) }
      : null;
    await saveBotState(conversation.id, {
      ...(promoUpdate ? { promo: promoUpdate } : {}),
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
    // Giỏ Shop chưa thấy đơn POS lúc trả lời: tra lại ở nền vài lần; thấy thì báo
    // khách đã nhận đơn (khỏi gửi lại SĐT/địa chỉ) và bỏ giỏ đang chờ.
    if (canFindShopOrder && !shopOrder && reply === cartReply && settings.responseMode === 'automatic') {
      followUpShopOrder({ conversation, since: cartSince, settings, dependencies, cartKey: cartReply.pendingOrder?.key || '', shopOrderReply });
    }
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
        queueForConversation(conversation.pageId && conversation.psid ? `${conversation.pageId}:${conversation.psid}` : conversation.id, async () => {
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
