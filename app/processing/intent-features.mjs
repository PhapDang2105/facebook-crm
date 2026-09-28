// Đặc trưng cho mô hình ra quyết định (dùng chung lúc huấn luyện và lúc chạy): n-gram ký tự
// 2–4 của chữ đã bỏ dấu (chịu được không dấu, sai chính tả), từ đơn/từ đôi, và vài đặc trưng
// ngữ cảnh (kênh, mẫu bot vừa gửi, đang ở bước đơn, có SĐT/số lượng/màu túi, độ dài).
// Vòng 6 (hợp đồng dữ liệu v2): thêm ngữ cảnh bot vừa xin gì (prevBotAsks), có địa chỉ trong tin,
// số túi, số màu, đơn đã chốt (hasOrder/orderAgeMin) và các đặc trưng giao tương ứng. Thiếu trường
// nào thì đặc trưng đó không phát sinh → mô hình v5 (không biết các đặc trưng này) vẫn chạy.
// Vòng 12 (28/09): `intentRowOf` — MỘT định nghĩa row cho mô hình nhỏ/tầng, dùng chung lúc dựng dữ liệu
// (tools-intent/dataset-context, build-dataset), đo (golden-set.enrichGoldenContext, replay-golden), huấn luyện
// (train-intent/train-cascade qua intentRowFromRecord) và lúc chạy (engine gọi thay cho intentRow tự dựng).
// Che SĐT/email/dãy số dài bằng maskPersonal của nhật ký quyết định: chữ trong nhật ký (đã che) và chữ thật lúc
// chạy ra cùng token; số tiền "1.250.000" không bị coi là SĐT.
import { maskPersonal } from './decision-log.mjs';
import { isOrderStep, usablePendingOrder } from './pending-order.mjs';

const fold = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

export function normalizeIntentText(text) {
  return fold(maskPersonal(String(text || ''))).replace(/<(sdt|email|so)>/g, ' <$1> ').replace(/[^a-z0-9<> ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Từ hành chính trong địa chỉ (bỏ dấu) — cùng tinh thần ADDRESS_WORDS của rule-intent.mjs.
// "quận" chỉ tính khi kèm số/tên ("quan tam" là quan tâm); "tp" phải là "tp hcm"/"tp." dạng đầu địa danh.
// "đường" chỉ tính khi kèm tên/số ("không đường", "đường không" là đường ăn); "ấp" kèm số/tên.
export const ADDRESS_WORDS = /\b(xa|phuong|huyen|thi tran|thi xa|thanh pho|tphcm|tp hcm|hcm|ha noi|da nang|thon|khu pho|kp|ngo|hem|ngach|so nha|chung cu|tinh)\b|\b(quan|q|p|tp|ap) ?\d{1,2}\b|\bquan (?!tam\b|trong\b)[a-z]+|\btp [a-z]+|\bap [a-z]{2,}|\bduong (?!(?:khong|ko|k|nhieu|it|hoa|an|kieng|nao|gi|ngot|phen|sao)\b)[a-z0-9]+/;

const NUMBER_WORDS = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 };
const BAG_RE = /\b(\d{1,2}|mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)\s*(tui|tuy|goi|bich|bit|bao|hop|set|combo)\b/g;

/**
 * Đếm số túi khách nêu trong chữ đã bỏ dấu ("2 túi xanh 1 nâu" → 3; không nêu → 0). Gộp cả hai kiểu engine
 * (bagCountInText) đọc thêm: số SAU túi ("túi xanh x2") và "combo 3" khi không có kiểu nào khác.
 */
export function countBags(text) {
  const normalized = normalizeIntentText(text);
  let total = 0;
  for (const match of normalized.matchAll(BAG_RE)) total += NUMBER_WORDS[match[1]] ?? Number(match[1]);
  for (const match of normalized.matchAll(/\b(?:tui|goi|bich|hop)(?: (?:xanh|vang|nau|cacao))? x ?(\d{1,2})\b/g)) total += Number(match[1]) || 0;
  if (!total) for (const match of normalized.matchAll(/\bcombo ?(\d)\b(?! (?:tui|tuy|goi|bich|bit|bao|hop|set))/g)) total += Number(match[1]) || 0;
  return Math.min(total, 99);
}

/** Số màu túi khác nhau khách nhắc (nâu và cacao là một). */
export function countColours(text) {
  const normalized = normalizeIntentText(text);
  const set = new Set();
  for (const match of normalized.matchAll(/\b(xanh|vang|nau|cacao)\b/g)) set.add(match[1] === 'cacao' ? 'nau' : match[1]);
  return set.size;
}

// Mẫu mà chỉ nhìn mã đã biết bot vừa xin gì. ORDER_ADDRESS* điền {missing} nên phải đọc chữ.
const TEMPLATE_ASKS = {
  ORDER_PHONE: 'phone',
  ASK_FLAVOR: 'flavor', ORDER_INFO_ASK_FLAVOR: 'flavor', ASK_FLAVOR_NGUYENBAN: 'flavor', COMBO3_FLAVOR: 'flavor', RECOMMEND_BEGINNER: 'flavor',
  ORDER_CONFIRMATION: 'confirm', ORDER_EXISTING_CONFIRM: 'confirm', ORDER_UPDATED: 'confirm', ORDER_UPDATE: 'confirm', UPSELL_TWO_BAGS: 'confirm',
  CONFIRM_YES: 'phone_address'
};
// Khi không đọc được chữ: mặc định theo họ mẫu.
const TEMPLATE_FALLBACK = { ORDER_ADDRESS: 'phone_address', ORDER_ADDRESS_CLARIFY: 'address', ORDER_ADDRESS_CHOOSE: 'address', ORDER_ADDRESS_REMIND: 'phone_address' };
const ASK_VERB = '(?:xin|gui|cho em|cho minh|de lai|cung cap|bo sung|nhan cho em|gui giup|gui lai)';
const ASK_PHONE = new RegExp(`\\b${ASK_VERB}\\b[^.!?\\n]{0,60}?\\b(so dien thoai|sdt|so dt|so dthoai)\\b`);
const ASK_ADDRESS = new RegExp(`\\b${ASK_VERB}\\b[^.!?\\n]{0,60}?\\b(dia chi|d\\/c|dc nhan hang)\\b`);
const ASK_CONFIRM = /\b(xac nhan lai|dung khong|dung ko|dung k|dung chua|dung chu|nhan "?dung"?|nhan dung giup)\b/;
const ASK_FLAVOR = /\b(loai nao|vi nao|tui nao|mau nao|vi gi|loai gi|hay tui (vang|nau|xanh)|lay tui (xanh|vang|nau) hay)\b/;
const ASK_QUANTITY = /\b(may tui|may goi|may bich|so luong|bao nhieu tui|moi loai may|moi vi may)\b/;

/**
 * Bot vừa xin gì ở câu trước: 'phone' | 'address' | 'phone_address' | 'flavor' | 'quantity' | 'confirm' | ''.
 * Ưu tiên mã mẫu khi mã đã nói rõ; mẫu điền {missing} (ORDER_ADDRESS…) thì đọc chữ bỏ dấu của câu bot.
 * @param {string} prevBotText
 * @param {string} [lastTemplateId]
 */
export function askedSlotOf(prevBotText, lastTemplateId = '') {
  const template = String(lastTemplateId || '').trim();
  if (TEMPLATE_ASKS[template]) return TEMPLATE_ASKS[template];
  const text = fold(prevBotText).replace(/[^a-z0-9/" ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text) {
    if (ASK_CONFIRM.test(text)) return 'confirm';
    if (ASK_FLAVOR.test(text)) return 'flavor';
    if (ASK_QUANTITY.test(text)) return 'quantity';
    const phone = ASK_PHONE.test(text) || /\b(so dien thoai|sdt) (va|\+|cung|kem) dia chi\b/.test(text);
    const address = ASK_ADDRESS.test(text) || /\b(so dien thoai|sdt) (va|\+|cung|kem) dia chi\b/.test(text);
    if (phone && address) return 'phone_address';
    if (address) return 'address';
    if (phone) return 'phone';
  }
  return TEMPLATE_FALLBACK[template] || '';
}

// ---- Row dùng chung cho mô hình (hợp đồng v2) ----

/** Khách có đơn (chưa hủy) trong cửa sổ này thì hasOrder (như engine: đơn < 24 giờ). */
export const ORDER_WINDOW_MIN = 24 * 60;

/**
 * Mã con → mã engine LƯU vào botLastTemplateId (renderChatbotReply trả mã gộp): dòng giỏ / gợi ý 2 túi / xin thêm
 * cấp địa chỉ / nhắc giỏ đều là một lượt ORDER_ADDRESS; câu "đã cập nhật đơn" là ORDER_UPDATE, "đã hủy" là
 * ORDER_CANCEL, "đã ghi chú" là ORDER_NOTE. Khớp chữ ngoại tuyến (matchTemplate) ra mã con → quy về mã engine.
 */
export const STORED_TEMPLATE_ID = Object.freeze({
  ORDER_ADDRESS_PARTIAL: 'ORDER_ADDRESS', ORDER_ADDRESS_CLARIFY: 'ORDER_ADDRESS', ORDER_ADDRESS_CHOOSE: 'ORDER_ADDRESS',
  ORDER_CART_LINE: 'ORDER_ADDRESS', UPSELL_TWO_BAGS: 'ORDER_ADDRESS', ORDER_ADDRESS_REMIND: 'ORDER_ADDRESS',
  ORDER_UPDATED: 'ORDER_UPDATE', ORDER_CANCELLED: 'ORDER_CANCEL', ORDER_NOTE_ADDED: 'ORDER_NOTE'
});

/** Mã engine trả (renderChatbotReply) → mã mẫu dùng làm NHÃN (khớp nhãn chấm/chữ ký mẫu): ORDER_UPDATE → ORDER_UPDATED… */
export const LABEL_OF_ENGINE_ID = Object.freeze({ ORDER_UPDATE: 'ORDER_UPDATED', ORDER_CANCEL: 'ORDER_CANCELLED', ORDER_NOTE: 'ORDER_NOTE_ADDED' });
export const labelTemplateId = templateId => { const id = String(templateId || '').trim(); return LABEL_OF_ENGINE_ID[id] || id; };

/** Mã mẫu bot trước theo cách engine lưu (xem STORED_TEMPLATE_ID). */
export function canonicalTemplateId(templateId) {
  const id = String(templateId || '').trim();
  return STORED_TEMPLATE_ID[id] || id;
}

// Bước đơn theo engine (ctx.lastWasOrderStep của luật/nhật ký): isOrderStep (ORDER_ADDRESS/PHONE/CONFIRMATION/UPDATE)
// + ASK_FLAVOR, ORDER_ADDRESS_REMIND, ORDER_CUSTOM_BASKET.
const ORDER_STEP_EXTRA = new Set(['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET']);

/** Bot vừa ở bước đơn (sau khi quy mã con về mã engine lưu). */
export function isOrderStepContext(templateId) {
  const id = canonicalTemplateId(templateId);
  return isOrderStep(id) || ORDER_STEP_EXTRA.has(id);
}

const ASKS_PHONE_ADDRESS = new Set(['ORDER_ADDRESS', 'ORDER_CUSTOM_BASKET']);
const ASKS_PHONE = new Set(['ORDER_PHONE', 'ORDER_ADDRESS_OLD_ASK_PHONE']);
const ASKS_FLAVOR = new Set(['ASK_FLAVOR', 'ASK_PRODUCT', 'ORDER_INFO_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN', 'COMBO3_FLAVOR']);

/**
 * Bot vừa xin gì — ưu tiên mã mẫu + giỏ như engine.prevBotAsks, rơi về askedSlotOf (đọc chữ câu bot):
 * - họ ORDER_ADDRESS: có `pendingOrder` (kể cả null = biết là không có giỏ) → theo SĐT/địa chỉ giỏ đã giữ như engine;
 *   `pendingOrder` undefined (ngoại tuyến, không biết giỏ) → đọc {missing} trong câu bot, không có chữ → 'phone_address';
 * - ORDER_PHONE… → 'phone'; ASK_FLAVOR/ASK_PRODUCT/ORDER_INFO_ASK_FLAVOR… → 'flavor'; ORDER_EXISTING_CONFIRM → 'confirm';
 * - còn lại → askedSlotOf(chữ bot, mã) (ORDER_CONFIRMATION → 'confirm'; câu nhân viên → đọc chữ).
 */
export function prevBotAsksOf({ lastTemplateId = '', pendingOrder, prevBotText = '' } = {}) {
  const id = canonicalTemplateId(lastTemplateId);
  if (ASKS_PHONE_ADDRESS.has(id)) {
    if (pendingOrder !== undefined) {
      const hasPhone = Boolean(pendingOrder?.phone);
      const hasAddress = Boolean(pendingOrder?.address);
      return !hasPhone && !hasAddress ? 'phone_address' : !hasPhone ? 'phone' : 'address';
    }
    return askedSlotOf(prevBotText, '') || TEMPLATE_FALLBACK[String(lastTemplateId || '').trim()] || 'phone_address';
  }
  if (ASKS_PHONE.has(id)) return 'phone';
  if (ASKS_FLAVOR.has(id)) return 'flavor';
  if (id === 'ORDER_EXISTING_CONFIRM') return 'confirm';
  if (id === 'ASK_QUANTITY') return 'quantity';
  return askedSlotOf(prevBotText, id);
}

const isActiveOrder = order => Boolean(order) && String(order.processingStatus || '') !== 'cancelled' && order.status !== 'Hủy';
const finiteOrNull = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/**
 * Đơn của khách lúc `now`: đơn CHƯA hủy gần nhất đặt trước `now` → { hasOrder: tuổi < 24 giờ, orderAgeMin } (như engine:
 * recentOrder chưa hủy, hasOrder = < 24 giờ). Không có đơn chưa hủy → { hasOrder: false, orderAgeMin: null }.
 */
export function orderContextOf(orders, now = Date.now()) {
  const at = Number(now) || Date.now();
  const active = (Array.isArray(orders) ? orders : []).filter(order => isActiveOrder(order) && Number(order?.createdAt) > 0 && Number(order.createdAt) <= at);
  const latest = active.reduce((best, order) => (!best || Number(order.createdAt) > Number(best.createdAt) ? order : best), null);
  if (!latest) return { hasOrder: false, orderAgeMin: null };
  const orderAgeMin = Math.max(0, Math.round((at - Number(latest.createdAt)) / 60000));
  return { hasOrder: orderAgeMin < ORDER_WINDOW_MIN, orderAgeMin };
}

/**
 * Row cho mô hình nhỏ / mô hình tầng — ĐỊNH NGHĨA DUY NHẤT, dùng lúc dựng dữ liệu, đo và lúc chạy.
 * - lastTemplate: mã bot trước đã quy như engine lưu (canonicalTemplateId); lastWasOrderStep = isOrderStepContext.
 * - hasBasket: có `pendingOrder` (engine) → giỏ còn hạn có món (usablePendingOrder); không (ngoại tuyến) → `hasBasket` đưa vào.
 * - prevBotAsks: `prevBotAsks` đưa vào (khác rỗng: engine đã tính theo giỏ) hay prevBotAsksOf(mã, giỏ, chữ bot).
 * - hasOrder/orderAgeMin: có `orders` → orderContextOf(orders, now); không → giá trị đưa vào, hasOrder chỉ khi đơn < 24 giờ
 *   (orderAgeMin biết được).
 * - phoneInText: `phoneInText` đưa vào (chuỗi SĐT hay boolean) HOẶC chữ có SĐT (normalizeIntentText ra <sdt>);
 *   addressInText = ADDRESS_WORDS trên chữ đã chuẩn hoá; bagCount = countBags(chữ) — luôn tính từ chữ.
 * @param {{ text: string, lastTemplateId?: string, prevBotText?: string, pendingOrder?: object|null, orders?: object[],
 *   now?: number, source?: string, phoneInText?: string|boolean, hasBasket?: boolean, hasOrder?: boolean, orderAgeMin?: number|null,
 *   prevBotAsks?: string, livestream?: boolean, staffRepliedAfterBot?: boolean }} input
 */
export function intentRowOf({ text = '', lastTemplateId = '', prevBotText = '', pendingOrder, orders, now = Date.now(), source = 'inbox', phoneInText, hasBasket, hasOrder, orderAgeMin, prevBotAsks, livestream, staffRepliedAfterBot } = {}) {
  const rawText = String(text || '');
  const normalized = normalizeIntentText(rawText);
  const lastTemplate = canonicalTemplateId(lastTemplateId);
  const at = Number(now) || Date.now();
  let order;
  if (Array.isArray(orders)) order = orderContextOf(orders, at);
  else {
    const age = finiteOrNull(orderAgeMin);
    order = { hasOrder: Boolean(hasOrder) && (age === null || age < ORDER_WINDOW_MIN), orderAgeMin: age };
  }
  const basket = pendingOrder !== undefined ? Boolean(usablePendingOrder(pendingOrder, { now: at, templateId: 'ORDER_ADDRESS' })?.items?.length) : Boolean(hasBasket);
  const asks = typeof prevBotAsks === 'string' && prevBotAsks ? prevBotAsks : prevBotAsksOf({ lastTemplateId, pendingOrder, prevBotText });
  return {
    text: rawText,
    source: source === 'comment' ? 'comment' : 'inbox',
    lastTemplate,
    lastWasOrderStep: isOrderStepContext(lastTemplate),
    hasBasket: basket,
    livestream: Boolean(livestream),
    hasOrder: order.hasOrder,
    orderAgeMin: order.orderAgeMin,
    prevBotAsks: asks,
    phoneInText: Boolean(phoneInText) || normalized.includes('<sdt>'),
    addressInText: ADDRESS_WORDS.test(normalized),
    bagCount: countBags(rawText),
    ...(staffRepliedAfterBot !== undefined ? { staffRepliedAfterBot: Boolean(staffRepliedAfterBot) } : {})
  };
}

/**
 * Dòng dữ liệu v2 (dataset/golden đã dựng) → dòng cho mô hình: giữ mọi trường (nhãn, trọng số…), dựng lại các trường
 * ngữ cảnh bằng intentRowOf để dữ liệu cũ (v1, mã con, hasOrder không giới hạn 24 giờ) khớp lúc chạy. Idempotent.
 */
export function intentRowFromRecord(row) {
  if (!row) return row;
  return {
    ...row,
    ...intentRowOf({
      text: row.text, source: row.source, lastTemplateId: row.lastTemplate, prevBotText: row.prevBot,
      hasBasket: row.hasBasket, livestream: row.livestream, hasOrder: row.hasOrder, orderAgeMin: row.orderAgeMin,
      prevBotAsks: row.prevBotAsks, phoneInText: row.phoneInText, now: Number(row.at) || Date.now()
    })
  };
}

const bagBucket = count => (count >= 4 ? '4+' : String(Math.max(0, count)));
const colourBucket = count => (count >= 2 ? '2+' : String(Math.max(0, count)));

/**
 * @param {{ text: string, source?: string, lastTemplate?: string, lastWasOrderStep?: boolean, hasBasket?: boolean, livestream?: boolean,
 *   prevBot?: string, prevBotAsks?: string, hasOrder?: boolean, orderAgeMin?: number, phoneInText?: boolean|string, addressInText?: boolean,
 *   bagCount?: number, basketItems?: unknown[] }} row
 * @returns {Set<string>}
 */
export function featuresOf(row) {
  const set = new Set();
  const rawText = String(row.text || '');
  const text = normalizeIntentText(rawText).slice(0, 300);
  const padded = ` ${text} `;
  for (const n of [2, 3, 4]) for (let i = 0; i + n <= padded.length; i += 1) set.add(`c${n}:${padded.slice(i, i + n)}`);
  const words = text.split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    set.add(`w:${words[i]}`);
    if (i + 1 < words.length) set.add(`w2:${words[i]} ${words[i + 1]}`);
  }
  const length = words.length <= 2 ? 'xs' : words.length <= 5 ? 's' : words.length <= 12 ? 'm' : 'l';
  const source = row.source === 'comment' ? 'comment' : 'inbox';
  const last = row.lastTemplate || 'none';
  set.add(`len:${length}`);
  set.add(`src:${source}`);
  set.add(`last:${last}`);
  if (row.lastWasOrderStep) set.add('ctx:orderstep');
  if (row.hasBasket) set.add('ctx:basket');
  if (row.livestream) set.add('ctx:live');
  // phoneInText có thể là chuỗi SĐT (engine) hay boolean (dataset): chỉ cần có là tính.
  const hasPhone = text.includes('<sdt>') || Boolean(row.phoneInText);
  const hasNumber = /\b\d{1,2}\b/.test(text);
  const hasColour = /\b(xanh|vang|nau|cacao)\b/.test(text);
  const hasAddress = row.addressInText === undefined ? ADDRESS_WORDS.test(text) : Boolean(row.addressInText);
  const bags = Number.isFinite(Number(row.bagCount)) && row.bagCount !== null && row.bagCount !== '' ? Number(row.bagCount) : countBags(rawText);
  const bag = bagBucket(bags);
  if (hasPhone) set.add('has:sdt');
  if (hasNumber) set.add('has:num');
  if (hasColour) set.add('has:colour');
  if (hasAddress) set.add('has:addr');
  if (/\?/.test(rawText)) set.add('has:q');
  set.add(`bag:${bag}`);
  set.add(`colours:${colourBucket(countColours(rawText))}`);
  // Đơn đã chốt trước đó (ngữ cảnh "đơn của em sao rồi" / "sửa đơn"): chỉ khi engine/dataset đưa vào.
  const hasOrder = Boolean(row.hasOrder);
  // orderAgeMin null/thiếu (JSON không ghi được Infinity) = không biết tuổi đơn → không tính "<60m".
  const orderAge = row.orderAgeMin === null || row.orderAgeMin === undefined || row.orderAgeMin === '' ? Infinity : Number(row.orderAgeMin);
  if (hasOrder) { set.add('ctx:order'); if (Number.isFinite(orderAge) && orderAge < 60) set.add('ctx:order<60m'); }
  // Bot vừa xin gì: lấy từ trường có sẵn, không có thì đọc câu bot trước (nếu được đưa vào).
  const asks = String(row.prevBotAsks || '') || (row.prevBot ? askedSlotOf(row.prevBot, row.lastTemplate) : '');
  if (asks) {
    set.add(`ask:${asks}`);
    if (hasPhone) set.add(`x:ask:${asks}|has:sdt`);
    if (hasAddress) set.add(`x:ask:${asks}|has:addr`);
  }
  // Giao đặc trưng (kiểu Vowpal Wabbit): cùng chữ "1" / "xanh" / "ok" nhưng ý khác nhau tuỳ mẫu
  // bot vừa gửi và bước đơn — chỉ giao với từ đơn để không phình từ vựng.
  for (const word of words.slice(0, 8)) set.add(`x:${last}|${word}`);
  if (row.lastWasOrderStep) { if (hasNumber) set.add('x:orderstep|num'); if (hasColour) set.add('x:orderstep|colour'); if (hasPhone) set.add('x:orderstep|sdt'); set.add(`x:orderstep|len:${length}`); }
  if (row.hasBasket) set.add(`x:basket|bag:${bag}`);
  if (hasOrder) for (const word of words.slice(0, 5)) set.add(`x:order|${word}`);
  set.add(`x:${source}|len:${length}`);
  return set;
}
