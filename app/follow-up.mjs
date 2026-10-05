// Bám đuổi: kịch bản chạy nền trong Cài đặt → Chatbot → Cấu hình chung.
//
// Khách bình luận (hay nhắn hộp thư), Page đã trả lời (bot hay nhân viên, từ CRM
// hay trong Pancake) mà khách im lặng quá N giờ thì gửi một tin theo kịch bản
// (ví dụ tặng miễn phí vận chuyển dùng thử). Luật an toàn:
// - chỉ xét lần trả lời của Page SAU khi tính năng được bật (không quét lại
//   khách cũ hàng tháng trước) và không quá 7 ngày;
// - mỗi khách mỗi kịch bản một lần, ghi ở data/processed/follow-ups.json;
// - nhân viên đã tắt bot cho hội thoại, hay khách đã có đơn (kể cả đơn 14 ngày ở
//   hội thoại khác của cùng khách / trùng tên), thì không bám; khách đang khiếu nại,
//   chờ người thật hay nhân viên đã nhắn thì bỏ qua (đếm lý do ở lastRun.skipReasons);
// - khách đã chọn túi mà thiếu SĐT/địa chỉ: nhắc đúng giỏ (ORDER_ADDRESS_REMIND);
// - kịch bản ưu đãi gửi thẳng phải tra được Pancake/POS, không tra được thì hoãn;
// - khách bình luận: nhắn riêng vào hộp thư; không có hộp thư / gửi riêng lỗi
//   (ngoài cửa sổ 24 giờ) thì trả lời công khai dưới bình luận nếu kịch bản cho.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { readMessagingStore, updateMessagingStore } from './messaging-store.mjs';
import { publishMessagingEvent } from './message-events.mjs';
import { applyHonorific, renderChatbotReply } from './chatbot-templates.mjs';
import { labelsForEvents, readInboxSettings } from './inbox-settings.mjs';
import { activeTrial } from './processing/trial-flow.mjs';
import { AUTOMATED_ACTORS, appendLabelAudit } from './audit-log.mjs';
import { isCancelledOrder } from './order-facts.mjs';
import { describeDeliveryAddress } from './processing/locations.mjs';
import { touchPendingOrder } from './processing/pending-order.mjs';
import { randomUUID } from 'node:crypto';
import { isPageSystemNotice } from './conversation-orders.mjs';
import { MESSENGER_WINDOW_MARGIN_MS, MESSENGER_WINDOW_MS, messengerWindowOpen } from './messenger-window.mjs';

// Đơn còn hiệu lực (chưa hủy / hoàn / bom — isCancelledOrder của order-facts, cùng luật với báo cáo):
// dùng chung cho "khách đã có đơn" và "bám đuổi thành công" ở mọi chỗ.
const liveOrders = conversation => (Array.isArray(conversation?.customerOrders) ? conversation.customerOrders : [])
  .filter(order => order && !isCancelledOrder(order) && order.status !== 'Hủy');
// Giờ yên tĩnh (giờ VN): không gửi tin bám đuổi 22h–8h.
// Chủ shop 05/10: bám đuổi buổi sáng bắt đầu 8h (trước đây 7h, tin cả đêm dồn 12–15 tin gửi cùng lúc 7h).
export const FOLLOW_UP_DAY_START_HOUR_VN = 8;
export const FOLLOW_UP_DAY_END_HOUR_VN = 22;
const hourVN = now => (new Date(now).getUTCHours() + 7) % 24;
export const isQuietHourVN = (now = Date.now()) => { const hour = hourVN(now); return hour >= FOLLOW_UP_DAY_END_HOUR_VN || hour < FOLLOW_UP_DAY_START_HOUR_VN; };
/**
 * Chủ shop 05/10: tin dồn cả đêm không đi cùng một lúc đầu ngày. Giờ đầu tiên sau giờ yên tĩnh (8h–9h VN) mỗi lượt
 * (15 phút) chỉ gửi tối đa 1/3 trần `maxPerRun` (làm tròn lên) — 15 tin dồn rải ra 8h00 / 8h15 / 8h30. Ngoài giờ đó giữ trần.
 */
export function followUpRunCap(maxPerRun, now = Date.now(), quietHours = true) {
  const cap = Math.max(1, Number(maxPerRun) || 15);
  if (!quietHours || hourVN(now) !== FOLLOW_UP_DAY_START_HOUR_VN) return cap;
  return Math.max(1, Math.ceil(cap / 3));
}

const statePath = process.env.FOLLOW_UPS_PATH || path.join(projectRoot, 'data', 'processed', 'follow-ups.json');
export const FOLLOW_UP_INTERVAL_MS = 15 * 60 * 1000;
const maxReplyAgeMs = 7 * 24 * 60 * 60 * 1000;
// Chừa 1 giờ trước hạn 24 giờ của Messenger (lượt bám đuổi chạy 15 phút một lần).
export const messengerWindowMs = MESSENGER_WINDOW_MS - MESSENGER_WINDOW_MARGIN_MS;
const maxSentRecords = 5000;

let cachedState = null;
let writeQueue = Promise.resolve();

function emptyState() {
  return { activatedAt: 0, sent: {}, lastRunAt: 0, lastRun: null };
}

export async function readFollowUpState() {
  if (cachedState) return cachedState;
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    cachedState = { ...emptyState(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    if (!cachedState.sent || typeof cachedState.sent !== 'object') cachedState.sent = {};
  } catch {
    cachedState = emptyState();
  }
  return cachedState;
}

function updateFollowUpState(mutate) {
  const operation = writeQueue.then(async () => {
    const state = await readFollowUpState();
    const result = await mutate(state);
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporary = `${statePath}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await rename(temporary, statePath);
    return result;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

const honorificOf = gender => (gender === 'male' ? 'anh' : gender === 'female' ? 'chị' : 'anh/chị');

const wordPattern = word => new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'iu');
const callsChi = wordPattern('chị');
const callsAnh = wordPattern('anh');
const callsBoth = /anh\s*\/\s*chị|chị\s*\/\s*anh/iu;

/**
 * Cách Page (bot / nhân viên) đang gọi khách trong vài tin gần nhất: 'female' khi chỉ gọi "chị",
 * 'male' khi chỉ gọi "anh", '' khi chưa rõ ("anh/chị", hay chưa có tin).
 */
export function honorificFromPageMessages(messages = []) {
  const outgoing = (Array.isArray(messages) ? messages : []).filter(message => message?.direction === 'outgoing' && message.text);
  for (const message of outgoing.slice(-5).reverse()) {
    const text = String(message.text).normalize('NFC').replace(callsBoth, ' ');
    const chi = callsChi.test(text);
    const anh = callsAnh.test(text);
    if (chi && !anh) return 'female';
    if (anh && !chi) return 'male';
  }
  return '';
}

/**
 * Giới tính dùng để xưng hô trong tin bám đuổi: như bot (chatbot-engine lockedGender) — nhân viên
 * đặt tay thắng, rồi giới đã khóa của bot (botGender, khách đã nghe "chị" suốt hội thoại), rồi cách
 * Page đang gọi khách trong tin gần nhất (`messages` của hội thoại), cuối cùng giới đoán.
 */
export function followUpGender(conversation = {}, messages = null) {
  if (conversation?.genderSource === 'staff' && conversation.gender) return conversation.gender;
  return conversation?.botGender || (messages ? honorificFromPageMessages(messages) : '') || conversation?.gender || '';
}

// ===== Ưu đãi chỉ ở kịch bản 36 giờ (chủ shop chốt 01/10) =====
export const FOLLOW_UP_OFFER_MIN_DELAY_HOURS = 36;
// Mẫu mang lời ưu đãi (miễn ship dùng thử / combo tặng bát).
const offerTemplateIds = new Set(['FOLLOW_UP_COMMENT_FREESHIP', 'FOLLOW_UP_TRIAL_FREESHIP']);
// Lời nhắc thường thay cho lời ưu đãi ở kịch bản sớm (khi Thiết lập tin nhắn chưa có mẫu riêng).
const fallbackReminders = {
  'comment-no-reply': 'Dạ {title} ơi, em thấy {title} có quan tâm sản phẩm nhà Giọt Nắng ạ 💛 {Title} còn cần em tư vấn thêm gì thì nhắn em nha ạ 🌾',
  'inbox-no-reply': 'Dạ {title} ơi, {title} còn cần em tư vấn thêm gì không ạ? 🌾'
};

/** Số ngày miễn ship kịch bản được tặng: chỉ kịch bản bám đuổi từ 36 giờ trở lên; sớm hơn = 0 (chỉ nhắc). */
export function scenarioOfferDays(scenario) {
  return Number(scenario?.delayHours) >= FOLLOW_UP_OFFER_MIN_DELAY_HOURS ? Math.max(0, Number(scenario?.freeShipDays) || 0) : 0;
}

/**
 * Kịch bản sẽ chạy thật: `scenario` với freeShipDays đã chặn theo luật 36 giờ (không đặt promo / trial
 * 'offered' ở kịch bản sớm), và `template` — kịch bản sớm mà dùng mẫu ưu đãi (hay có freeShipDays) thì
 * đổi sang lời nhắc thường: FOLLOW_UP_COMMENT_REMIND / FOLLOW_UP_INBOX_REMIND trong Thiết lập tin nhắn,
 * không có thì lời nhắc dự phòng. Rỗng = mẫu đã tắt, kịch bản đứng yên.
 */
export function followUpPlan(configured, messageTemplates = {}) {
  const offerDays = scenarioOfferDays(configured);
  const scenario = { ...configured, freeShipDays: offerDays };
  const own = followUpScenarioText(configured, messageTemplates);
  if (!own || offerDays || !(offerTemplateIds.has(String(configured?.templateId || '')) || Number(configured?.freeShipDays) > 0)) return { scenario, template: own };
  const reminderId = configured.trigger === 'comment-no-reply' ? 'FOLLOW_UP_COMMENT_REMIND' : 'FOLLOW_UP_INBOX_REMIND';
  const stored = messageTemplates?.[reminderId];
  const template = stored === undefined ? fallbackReminders[configured.trigger] || fallbackReminders['inbox-no-reply'] : String(stored || '').trim();
  return { scenario, template };
}

/** Lời của kịch bản: mẫu FOLLOW_UP_… trong Thiết lập tin nhắn (rỗng = mẫu đã tắt), không có thì lời ghi thẳng trên kịch bản. */
export function followUpScenarioText(scenario, messageTemplates = {}) {
  if (scenario.templateId) return String(messageTemplates[scenario.templateId] || '').trim();
  return String(scenario.message || '').trim();
}

/**
 * {title}/{Title}/{name} trong lời kịch bản, chọn ngẫu nhiên một biến thể "###", rồi sửa "anh/chị" theo
 * giới tính đã biết. `messages`: tin của hội thoại (xưng hô theo cách Page đang gọi khách);
 * `families`: dòng sản phẩm khách quan tâm — có biến thể nói đúng dòng đó thì chọn trong số đó.
 */
export function renderFollowUpMessage(template, conversation = {}, random = Math.random, { messages = null, families = null } = {}) {
  const gender = followUpGender(conversation, messages);
  const title = honorificOf(gender);
  const all = String(template || '').split('###').map(part => part.trim()).filter(Boolean);
  const wanted = families?.size ? all.filter(variant => [...productFamiliesIn(variant)].some(family => families.has(family))) : [];
  const variants = wanted.length ? wanted : all;
  const chosen = variants.length ? variants[Math.min(variants.length - 1, Math.floor(random() * variants.length))] : '';
  const text = chosen
    .replace(/\{Title\}/g, title.charAt(0).toUpperCase() + title.slice(1))
    .replace(/\{title\}/g, title)
    .replace(/\{name\}/g, String(conversation.name || '').trim() || title);
  // Truyền '' chứ không undefined: applyHonorific(text, gender = activeCustomer.gender) sẽ lấy
  // giới tính của khách TRƯỚC ĐÓ còn trong trạng thái module (khách chưa rõ giới tính bị gọi "chị").
  return applyHonorific(text, gender).trim();
}

const lastAt = (messages, predicate) => messages.reduce((latest, message) => (predicate(message) && Number(message.createdAt) > latest ? Number(message.createdAt) : latest), 0);
const incomingOf = messages => messages.filter(message => message.direction === 'incoming');
const compactText = text => String(text || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
// R13: dòng hệ thống Facebook lưu như tin Page ("Bạn đang phản hồi bình luận…", "… đã trả lời một quảng cáo.") không phải
// lời Page: không làm mốc "Page đã trả lời" của kịch bản bám đuổi.
const outgoingOf = messages => messages.filter(message => message.direction === 'outgoing' && !isPageSystemNotice(message));
const messagesIn = (store, conversation) => (conversation && Array.isArray(store?.messages?.[conversation.id]) ? store.messages[conversation.id] : []);

// Thẻ mặc định không bám (ngoài thẻ Đã mua): Khiếu nại, Bảo hành, Cần người xử lý, Khách sỉ.
// R14 (quyết định 6, …916619): khách sỉ đã được chuyển bộ phận sỉ/CTV — không nhận lời "lấy từ 2 túi giá combo".
const defaultSkipLabelIds = ['complaint', 'warranty', 'consulting', 'handoff', 'wholesale'];
// Bot vừa chuyển người / đang tra đơn / nhân viên sẽ liên hệ: khách đang chờ người thật, không nhắc mua.
const handoffTemplateIds = new Set(['CSKH_HANDOFF', 'ORDER_STATUS_CHECKING', 'COMMENT_STAFF_FOLLOWUP']);
// Giỏ khách đã chọn còn nhắc được (giỏ bot dùng chỉ 2 giờ; nhắc lại tới 24 giờ, sau đó khách đã quên).
const pendingOrderRemindMs = 24 * 60 * 60 * 1000;
// Đơn vừa chốt (ở hội thoại khác của cùng khách, hay đơn trùng tên) trong 14 ngày: không bám.
const recentOrderMs = 14 * 24 * 60 * 60 * 1000;

// Thẻ khiếu nại / bảo hành / khách sỉ: không bám trong MỌI trường hợp (kể cả đang giữ giỏ).
const hardSkipLabelIds = ['complaint', 'warranty', 'wholesale'];

// R15: khách báo đã mua trên sàn (TikTok/Shopee/web): mẫu cuối của bot là BOUGHT_ON_MARKETPLACE, hay mốc boughtElsewhereAt
// (engine ghi) trong 14 ngày.
const boughtElsewhereMs = 14 * 24 * 60 * 60 * 1000;
export function boughtOnMarketplace(record, now = Date.now()) {
  if (!record) return false;
  if (String(record.botLastTemplateId || '') === 'BOUGHT_ON_MARKETPLACE') return true;
  const at = Number(record.boughtElsewhereAt) || 0;
  // R15-fix3 (phản biện L5): khách lập GIỎ MỚI sau mốc (vừa nói đã mua trên sàn rồi đặt luôn ở đây, bot trả lời < 60 giây) → hết chặn.
  const basket = record.pendingOrder && typeof record.pendingOrder === 'object' ? record.pendingOrder : null;
  if (at > 0 && Array.isArray(basket?.items) && basket.items.length && (Number(basket.at) || 0) > at) return false;
  // Bot đã trả lời chuyện khác sau đó (khách quay lại hỏi mua) → mốc cũ không chặn nữa.
  return at > 0 && now - at < boughtElsewhereMs && (Number(record.botLastReplyAt) || 0) <= at + 60 * 1000;
}

// ===== Ngữ cảnh khách (01/10) =====
// Dòng sản phẩm nhận ra trong một đoạn chữ (đã bỏ dấu): để không bám khách hỏi yến mạch bằng câu granola.
const productFamilyPatterns = {
  granola: /\b(granola|tui (xanh|vang|nau)|cacao|tropical)\b/,
  yenmach: /\byen mach\b/,
  nghelanh: /\b(nghe lanh|bot ngu coc|ngu coc)\b/,
  hatanlanh: /\bhat an lanh\b/
};
const templateFamilies = { YEN_MACH: 'yenmach', NGHE_LANH: 'nghelanh', AN_LANH: 'hatanlanh', GRANOLA: 'granola', TUI_XANH: 'granola', TUI_VANG: 'granola', TUI_NAU: 'granola' };

/** Các dòng sản phẩm được nhắc trong `text`: Set('granola' | 'yenmach' | 'nghelanh' | 'hatanlanh'). */
export function productFamiliesIn(text) {
  const folded = foldText(text).replace(/[^a-z0-9]+/g, ' ');
  return new Set(Object.entries(productFamilyPatterns).filter(([, pattern]) => pattern.test(folded)).map(([family]) => family));
}

/**
 * Dòng sản phẩm khách đang quan tâm: chữ khách nhắn (hộp thư + bình luận), bài viết / quảng cáo khách
 * bấm, mẫu bot vừa trả lời (PRICE_YEN_MACH_… → yến mạch), giỏ đang giữ.
 */
export function customerProductFamilies(store, candidate) {
  const records = [candidate.inbox, candidate.thread].filter(Boolean);
  const texts = [];
  for (const record of records) {
    texts.push(...incomingOf(messagesIn(store, record)).slice(-20).map(message => message.text || ''));
    texts.push(record.post?.message || '', record.referral?.adTitle || '');
    for (const item of Array.isArray(record.pendingOrder?.items) ? record.pendingOrder.items : []) texts.push(item?.product || '');
  }
  const families = productFamiliesIn(texts.join(' \n '));
  for (const record of records) {
    const templateId = String(record.botLastTemplateId || '').toUpperCase();
    for (const [marker, family] of Object.entries(templateFamilies)) if (templateId.includes(marker)) families.add(family);
  }
  return families;
}

/** Tin khách chỉ có dấu câu / emoji ("." "..," "👍"): không có chữ hay số nào. */
export function isTrivialCustomerText(text) {
  const value = String(text ?? '').normalize('NFC');
  return !/[\p{L}\p{N}]/u.test(value);
}

// Khách bảo dừng: "khoan giao", "hủy đơn", "không lấy nữa"… (so trên chữ có dấu để "Huy" — tên người — không khớp).
const declinePattern = /(?<![\p{L}\p{N}])(khoan|đừng)\s+(đã\s+)?(giao|gửi|ship|đặt|lên đơn)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])h(ủy|uỷ)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(không|ko|k|hông)\s+(lấy|mua|đặt)\s+nữa(?![\p{L}\p{N}])/iu;
/** Khách nói dừng / hủy trong tin này? */
// R16 (bình luận B6b, ca …0716122894 "da nhan hang roi nen kg mua nua"): khách gõ KHÔNG dấu — so thêm trên chữ đã bỏ dấu
// ("kg/ko/k/khong/hong/khum mua|lay|dat nua", "đã nhận hàng rồi", "đã mua rồi"). "huy" không dấu không tính (tên người).
const declineFoldedPattern = /\b(?:k|ko|kg|khg|khong|hong|khum|hok) (?:can )?(?:lay|mua|dat) (?:them )?nua\b|\bda nhan (?:duoc )?hang roi\b|\b(?:da|vua) mua roi\b/;
// R16-fix2 (phản biện C1): đang giữ giỏ mà khách "không lấy THÊM nữa" = từ chối lời mời thêm, vẫn giữ giỏ → vẫn nhắc giỏ.
export function customerDeclined(text, { basketHeld = false } = {}) {
  const value = String(text ?? '').normalize('NFC');
  const folded = foldText(value).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ');
  if (basketHeld && /\bthem\b/.test(folded) && !/\b(?:huy|khoan|dung)\b/.test(folded)) return false;
  if (declinePattern.test(value)) return true;
  return !/\?/.test(value) && declineFoldedPattern.test(folded);
}

// Khách chỉ đáp lời cho xong: "OK bạn", "dạ vâng ạ", "cảm ơn shop"… (tối đa vài từ, chỉ từ đáp lời).
const ackWords = new Set(['ok', 'oke', 'okie', 'okay', 'okela', 'oki', 'okk', 'uh', 'um', 'u', 'vang', 'da', 'cam', 'on', 'thanks', 'thank', 'you', 'tks', 'ty', 'duoc', 'dc', 'roi', 'nhe', 'nha', 'a', 'ban', 'shop', 'em', 'c', 'chi', 'anh', 'b', 'nhieu', 'luon']);
export function isAckText(text) {
  const words = foldText(text).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 6 && words.every(word => ackWords.has(word));
}

const thanksText = /c(ả|á)m\s+ơn/iu;

/**
 * Lý do KHÔNG bám một ứng viên (rỗng = bám được): nhân viên tắt bot, thẻ khiếu nại /
 * bảo hành / cần người xử lý, đang chờ người thật (attention mở, hay bot vừa chuyển
 * người), nhân viên đã nhắn sau tin khách. Xét cả hộp thư lẫn luồng bình luận.
 * Thêm (01/10):
 *  - `basketHeld` (khách đang giữ giỏ, có lời nhắc giỏ): thẻ "cần người xử lý", cờ attention và mẫu
 *    chuyển người KHÔNG chặn nữa (bot gắn thẻ khi nhắc giỏ / khách quen → giỏ không bao giờ được nhắc);
 *    khiếu nại / bảo hành, nhân viên đã trả lời, bot tắt vẫn chặn;
 *  - tin cuối của khách chỉ là dấu câu / emoji → 'customerTrivial';
 *  - khách đã nói "khoan giao" / "hủy" / "không lấy nữa" (7 ngày) → 'customerDeclined';
 *  - khách đáp "OK bạn" rồi Page cảm ơn (hội thoại đã khép) → 'customerClosed' (trừ khi đang giữ giỏ).
 */
export function followUpSkipReason(candidate, store, { skipLabelIds = defaultSkipLabelIds, hardLabelIds = hardSkipLabelIds, basketHeld = false, now = Date.now() } = {}) {
  const records = [candidate.inbox, candidate.thread, candidate.conversation].filter(Boolean);
  if (records.some(item => item.botEnabled === false)) return 'botOff';
  // R15 (inbox3 A2, ca …659307 "Mình đặt của shop trên tiktok rồi" → 3 giờ sau vẫn nhận "em vẫn đang giữ đơn…"): khách báo đã
  // mua trên sàn (bot trả BOUGHT_ON_MARKETPLACE, bỏ giỏ; engine ghi mốc boughtElsewhereAt) → không bám, kể cả lời nhắc giỏ.
  if (records.some(item => boughtOnMarketplace(item, now))) return 'boughtElsewhere';
  const labels = new Set(records.flatMap(item => (Array.isArray(item.labels) ? item.labels : [])));
  if ((basketHeld ? hardLabelIds : skipLabelIds).some(id => labels.has(id))) return 'label';
  // attention: true hay { open: true } / chưa đóng — nhân viên đang xử lý.
  const attentionOpen = item => item.attention === true || (item.attention && typeof item.attention === 'object' && item.attention.open !== false && !item.attention.closedAt && !item.attention.resolvedAt);
  if (!basketHeld && records.some(attentionOpen)) return 'attention';
  if (!basketHeld && records.some(item => handoffTemplateIds.has(String(item.botLastTemplateId || '')))) return 'handoffTemplate';
  // R16 (bình luận B6a, ca …949494: nhắc "em vẫn đang giữ đơn" ngay sau "chuyển bạn phụ trách trả lời" mà chưa ai trả lời → khách
  // trách "Sao e kg trả lời"): tin bot cuối là báo chờ bạn phụ trách (STAFF_WAIT_*, COMMENT_STAFF_FOLLOWUP) — kể cả khi đang giữ
  // giỏ — thì không bám (nhân viên đã trả lời sau đó thì 'staffReplied' bên dưới cũng chặn).
  if (records.some(item => /^STAFF_WAIT_/.test(String(item.botLastTemplateId || '')) || String(item.botLastTemplateId || '') === 'COMMENT_STAFF_FOLLOWUP')) return 'waitingStaff';
  for (const record of records) {
    const messages = messagesIn(store, record);
    const customerAt = lastAt(incomingOf(messages), () => true);
    if (outgoingOf(messages).some(message => message.staff === true && Number(message.createdAt) > customerAt)) return 'staffReplied';
  }
  // Tin khách / tin Page của mọi luồng, theo thời gian.
  const seen = new Set();
  const all = [...new Set(records)].flatMap(record => messagesIn(store, record))
    .filter(message => message && !seen.has(message) && seen.add(message))
    .sort((first, second) => (Number(first.createdAt) || 0) - (Number(second.createdAt) || 0));
  const incoming = all.filter(message => message.direction === 'incoming');
  const last = incoming.at(-1);
  if (last && (last.type || 'text') === 'text' && isTrivialCustomerText(last.text)) return 'customerTrivial';
  if (incoming.some(message => now - (Number(message.createdAt) || 0) <= maxReplyAgeMs && customerDeclined(message.text, { basketHeld }))) return 'customerDeclined';
  if (!basketHeld && last && isAckText(last.text)) {
    const after = all.filter(message => message.direction === 'outgoing' && (Number(message.createdAt) || 0) >= (Number(last.createdAt) || 0));
    if (after.some(message => thanksText.test(String(message.text || ''))) || records.some(item => item.botLastTemplateId === 'THANK_YOU')) return 'customerClosed';
  }
  return '';
}

/**
 * Khách đã chọn túi (pendingOrder còn hàng, chưa quá 24 giờ) mà im lặng: nhắc đúng
 * giỏ đang giữ và phần còn thiếu (mẫu ORDER_ADDRESS_REMIND, dựng bởi renderOrder với
 * {cart}/{total}/{missing}) thay vì lời "còn phân vân loại nào". Rỗng = không có giỏ
 * nhắc được (không giỏ, quá 24 giờ, mẫu tắt, giỏ đủ SĐT+địa chỉ hay không tính được giá).
 */
export function orderRemindText(conversation, templates = {}, { now = Date.now(), messages = null } = {}) {
  const pending = conversation?.pendingOrder;
  // R15: khách đã mua trên sàn → không nhắc giỏ (giỏ còn sót cũng không nhắc).
  if (boughtOnMarketplace(conversation, now)) return '';
  const items = Array.isArray(pending?.items) ? pending.items.filter(item => item?.product) : [];
  if (!items.length || !templates.ORDER_ADDRESS_REMIND) return '';
  // R13: khách đã hẹn dịp khác ("để bữa khác chốt") — bot giữ giỏ với cờ `postponed`; không nhắc giỏ ("em vẫn đang giữ đơn…").
  if (pending.postponed) return '';
  const at = Number(pending.at) || 0;
  if (!at || now - at > pendingOrderRemindMs) return '';
  const gender = followUpGender(conversation, messages);
  try {
    // `at: now` để giỏ qua hạn 2 giờ của bot vẫn dựng được; không có recentOrder/trial nên chỉ ra bước xin thông tin.
    const remindFor = basket => {
      const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, {
        pendingOrder: basket,
        now,
        lastTemplateId: 'ORDER_ADDRESS',
        customer: { gender, name: conversation.name || '' }
      });
      return reply.templateId === 'ORDER_ADDRESS' && reply.remind ? String(reply.remind) : '';
    };
    let remind = remindFor({ ...pending, items, at: now });
    // R13 (inbox2 C2): giỏ đã có SĐT + địa chỉ nhưng địa chỉ còn THIẾU CẤP (phường/xã…) mà bot đã hỏi hết lượt
    // (addressAsks): bộ soạn đơn coi địa chỉ là "chốt được" nên không còn câu nhắc → trước đây tin nhắc giỏ rỗng, giỏ
    // không bao giờ được bám (khách chỉ còn thiếu đúng một phường/xã là thành đơn). Dựng lại câu nhắc như lần hỏi đầu để
    // nêu đúng phần còn thiếu. Địa chỉ đã đủ cấp thì vẫn không nhắc (đơn chờ việc khác: xác nhận đặt thêm, tắt tự lên đơn…).
    if (!remind && pending.phone && pending.address) {
      let delivery = null;
      try { delivery = describeDeliveryAddress(String(pending.address)); } catch {}
      if (delivery && delivery.complete === false) remind = remindFor({ ...pending, items, at: now, addressAsks: 0 });
    }
    if (!remind) return '';
    // R13: bot đã hỏi phần địa chỉ còn thiếu một lần rồi thì tin nhắc VẪN nêu đúng phần đó ("gửi giúp em phường/xã") —
    // lời nhắc chung "nhắn em khi tiện" (01/10) không cho khách biết đơn chỉ còn thiếu gì.
    return applyHonorific(remind, gender).trim();
  } catch {
    return '';
  }
}

/**
 * Đơn chốt trong 14 ngày mà không nằm trong customerOrders của chính hội thoại này:
 * ở hội thoại chị em (cùng Page + psid: luồng bình luận / hộp thư) hay đơn trùng tên
 * khách (đơn nhân viên lên tay, landing, POS gắn vào hội thoại khác). Rỗng = không có.
 */
export function recentOrderElsewhere(store, conversation, now = Date.now()) {
  if (!conversation) return '';
  const recent = order => Number(order.createdAt) > 0 && now - Number(order.createdAt) <= recentOrderMs;
  const name = foldText(conversation.name).replace(/\s+/g, ' ').trim();
  for (const other of store?.conversations || []) {
    if (!other || other.id === conversation.id) continue;
    const orders = liveOrders(other).filter(recent);
    if (!orders.length) continue;
    if (other.pageId === conversation.pageId && other.psid && other.psid === conversation.psid) return 'khách vừa có đơn (hội thoại khác cùng khách)';
    // Tên ít nhất 2 chữ mới so (tránh "Minh", "Hoa" trùng người lạ).
    if (name && name.includes(' ') && orders.some(order => foldText(order.name).replace(/\s+/g, ' ').trim() === name)) return 'khách vừa có đơn (trùng tên)';
  }
  return '';
}

/**
 * Các ứng viên của một kịch bản: [{ key, conversation, inbox, thread, repliedAt }].
 * `inbox` là hộp thư của khách (có thể thiếu với khách chỉ bình luận),
 * `thread` là luồng bình luận (chỉ với comment-no-reply).
 */
export function findFollowUpCandidates(store, scenario, { now = Date.now(), activatedAt = 0, boughtLabelIds = ['customer'], onExcluded = null } = {}) {
  const delayMs = scenario.delayHours * 60 * 60 * 1000;
  const conversations = store.conversations || [];
  const messagesOf = conversation => (Array.isArray(store.messages?.[conversation.id]) ? store.messages[conversation.id] : []);
  // INT-07: hộp thư theo page:psid dựng một lần (giữ mục đầu tiên như find), không find cho từng luồng bình luận.
  let inboxIndex = null;
  const inboxOf = (pageId, psid) => {
    if (!inboxIndex) {
      inboxIndex = new Map();
      for (const item of conversations) {
        const key = `${item.pageId}\u0000${item.psid}`;
        if (item.source !== 'comment' && !inboxIndex.has(key)) inboxIndex.set(key, item);
      }
    }
    return inboxIndex.get(`${pageId}\u0000${psid}`) || null;
  };
  // Khách đã có đơn trong CRM hay mang thẻ Đã mua hàng: không bám (chỉ bám khách mới).
  // Bot tắt, thẻ khiếu nại / cần người xử lý, nhân viên đã nhắn…: xét ở vòng gửi (followUpSkipReason) để đếm lý do.
  const bought = conversation => (Array.isArray(conversation?.labels) ? conversation.labels : []).some(label => boughtLabelIds.includes(label));
  // Đã chốt đơn trong chat mà đơn không gắn vào hội thoại (nhân viên lên tay, đơn Shop/POS).
  const closedInChat = conversation => boughtInChat(messagesOf(conversation));
  const blocked = inbox => inbox && (liveOrders(inbox).length > 0 || bought(inbox) || closedInChat(inbox));
  // Tin bám đuổi trước đó không tính là "Page trả lời": kịch bản 36 giờ tính từ lần Page trả lời
  // thật, không phải từ tin nhắc 3 giờ. Nhận bằng cờ `followUp: true` trên chính tin (gắn khi gửi
  // thẳng, và khi đồng bộ Pancake khớp lời bám đuổi trạm gửi đã gửi); dự phòng: khớp giờ followUps[].at.
  const isFollowUpSend = (conversation, message) => message?.followUp === true
    || (Array.isArray(conversation?.followUps) ? conversation.followUps : []).some(item => Math.abs(Number(message.createdAt) - Number(item.at)) < 2 * 60 * 1000);
  const candidates = [];
  if (scenario.trigger === 'comment-no-reply') {
    for (const thread of conversations.filter(item => item.source === 'comment' && item.psid)) {
      const inbox = inboxOf(thread.pageId, thread.psid);
      if (blocked(inbox)) continue;
      const threadMessages = messagesOf(thread);
      const inboxMessages = inbox ? messagesOf(inbox) : [];
      // Page đã trả lời (công khai dưới bình luận hay nhắn riêng) — lần cuối.
      const repliedAt = Math.max(lastAt(outgoingOf(threadMessages), () => true), lastAt(outgoingOf(inboxMessages), message => message.privateReply === true));
      if (!repliedAt || repliedAt < activatedAt || now - repliedAt > maxReplyAgeMs || now - repliedAt < delayMs) continue;
      // Khách có lên tiếng sau đó (bình luận tiếp hay nhắn hộp thư) thì thôi.
      const customerAfter = Math.max(lastAt(incomingOf(threadMessages), () => true), lastAt(incomingOf(inboxMessages), () => true));
      if (customerAfter > repliedAt) continue;
      candidates.push({ key: `${scenario.id}:${thread.pageId}:${thread.psid}`, conversation: inbox || thread, inbox, thread, repliedAt });
    }
  } else {
    // R13: `onExcluded(inbox, lý do)` (tuỳ chọn) — vì sao một hộp thư KHÔNG vào diện bám của kịch bản này; lượt bám đuổi
    // dùng để ghi log cho khách đang giữ giỏ ("5 giỏ không bám đuổi, không rõ lý do").
    const excluded = (inbox, reason) => { if (typeof onExcluded === 'function') onExcluded(inbox, reason); };
    for (const inbox of conversations.filter(item => item.source !== 'comment' && item.psid)) {
      // Khách đã mua / khách quen mà đang giữ GIỎ MỚI (sau đơn cuối): vẫn là ứng viên để nhắc đúng giỏ.
      if (blocked(inbox) && !basketAfterOrders(inbox, messagesOf(inbox), now)) { excluded(inbox, 'đã có đơn / thẻ đã mua'); continue; }
      // Khách đang giữ ưu đãi dùng thử (luồng riêng): kịch bản khác (nhắc combo 3 giờ) không chen vào.
      if (!scenario.freeShipDays && activeTrial(inbox, { now })) { excluded(inbox, 'đang giữ ưu đãi dùng thử'); continue; }
      const messages = messagesOf(inbox);
      const customerAt = lastAt(incomingOf(messages), () => true);
      if (!customerAt) continue;
      const repliedAt = lastAt(outgoingOf(messages), message => message.privateReply !== true && !isFollowUpSend(inbox, message));
      if (!repliedAt || repliedAt < customerAt) { excluded(inbox, 'Page chưa trả lời tin cuối của khách'); continue; }
      if (repliedAt < activatedAt) { excluded(inbox, 'trước mốc bật bám đuổi'); continue; }
      if (now - repliedAt > maxReplyAgeMs) { excluded(inbox, 'quá 7 ngày'); continue; }
      if (now - repliedAt < delayMs) { excluded(inbox, `chưa đủ ${scenario.delayHours} giờ`); continue; }
      // Messenger chỉ cho Page nhắn trong 24 giờ kể từ tin cuối của khách: quá mốc
      // thì bỏ qua — trừ kịch bản "ngoài 24 giờ" (xếp hàng chờ gửi qua extension Pancake).
      // INT-15: cùng cách tính với inboxWindowOpen/Sapo (cả mốc lastCustomerMessageAt của hộp thư, chừa 1 giờ).
      const outside = !messengerWindowOpen(store, inbox, { now });
      if (outside && !scenario.outsideWindow) { excluded(inbox, 'ngoài 24 giờ Messenger'); continue; }
      candidates.push({ key: `${scenario.id}:${inbox.pageId}:${inbox.psid}`, conversation: inbox, inbox, thread: null, repliedAt, outsideWindow: outside });
    }
  }
  // Một khách có nhiều luồng bình luận: một lần thôi.
  const seen = new Set();
  return candidates.filter(item => !seen.has(item.key) && seen.add(item.key));
}

/**
 * Một lượt bám đuổi: duyệt mọi kịch bản đang bật, gửi cho khách đủ điều kiện,
 * ghi lại. Trả về { checked, sent, failed, skipped }.
 */
// Vòng 15 phút và nút "Chạy ngay" không chạy chồng: sent[key] chỉ ghi sau khi gửi, hai lượt song song sẽ gửi trùng.
let activeFollowUpRun = null;
export function runFollowUps(options = {}) {
  if (activeFollowUpRun) return activeFollowUpRun;
  activeFollowUpRun = runFollowUpsOnce(options).finally(() => { activeFollowUpRun = null; });
  return activeFollowUpRun;
}

async function runFollowUpsOnce({ readSettings, sendMessage, conversationInfo = null, now = Date.now(), log = console.log, quietHours = true, readLandingOrders = defaultReadLandingOrders } = {}) {
  const settings = await readSettings();
  // skipped = tổng bỏ qua; skipReasons đếm theo loại (alreadySent, botOff, label, attention, handoffTemplate, staffReplied, noInbox).
  const summary = { checked: 0, sent: 0, failed: 0, skipped: 0, skipReasons: {}, disabled: false };
  // R13 (inbox2 C2, inbox3 F10): ngoài số đếm, giữ MÃ hội thoại (6 số cuối) theo từng lý do để biết vì sao một khách không
  // được bám — ghi một dòng log tổng hợp mỗi lượt (chỉ khi khác lượt trước) và lưu vào lastRun.skipDetails.
  const skipDetails = {};
  const noteSkip = (reason, conversation) => {
    if (!conversation) return;
    const list = (skipDetails[reason] ||= []);
    const mark = `…${String(conversation.psid || conversation.id || '').slice(-6)}`;
    if (list.length < 12 && !list.includes(mark)) list.push(mark);
  };
  const skip = (reason, conversation = null) => {
    summary.skipped += 1;
    summary.skipReasons[reason] = (summary.skipReasons[reason] || 0) + 1;
    // "Đã gửi / đã xét rồi" lặp lại mỗi 15 phút với hàng trăm khách: chỉ đếm, không kê mã.
    if (reason !== 'alreadySent') noteSkip(reason, conversation);
  };
  // Khách được bám đuổi đã chốt đơn: ghi nhận cả khi bám đuổi đang tắt.
  await markFollowUpWins(now).catch(error => log(`Bám đuổi: lỗi ghi nhận đơn chốt: ${error.message}`));
  // Hàng chờ ngoài 24 giờ: mục quá 7 ngày dọn mỗi lượt (có giới hạn), kể cả lúc bám đuổi tắt / giờ yên
  // tĩnh — trước đây chỉ dọn khi có người lập lô cho trạm gửi, nên tồn hàng trăm mục cũ.
  const expired = await expireFollowUpQueue({ now }).catch(error => { log(`Bám đuổi: lỗi dọn hàng chờ quá hạn: ${error.message}`); return 0; });
  if (expired) {
    summary.expired = expired;
    log(`Bám đuổi: bỏ ${expired} tin quá 7 ngày khỏi hàng chờ`);
  }
  if (!settings?.enabled || !settings.followUps?.enabled) return { ...summary, disabled: true };
  // 22h–8h giờ VN: không nhắn khách (tin 3 giờ sau lời Page lúc 22h sẽ đi từ 8h, rải theo followUpRunCap).
  if (quietHours && isQuietHourVN(now)) return { ...summary, quiet: true };
  const state = await readFollowUpState();
  if (!state.activatedAt) await updateFollowUpState(current => { current.activatedAt = now; return null; });
  const activatedAt = state.activatedAt || now;
  // Tin trong hàng chờ mà nhân viên / trạm gửi Pancake đã gửi: xác nhận trước khi xét lượt mới.
  await reconcileFollowUpQueue(now, { readSettings });
  const pruned = await pruneReturningFromQueue({ conversationInfo, now }).catch(() => ({ removed: 0 }));
  if (pruned.removed) log(`Bám đuổi: bỏ ${pruned.removed} khách cũ khỏi hàng chờ`);
  const store = await readMessagingStore();
  // Trần mỗi lượt theo cài đặt; giờ đầu ngày (8h–9h VN) rải bớt — followUpRunCap.
  const maxPerRun = followUpRunCap(settings.followUps.maxPerRun, now, quietHours);
  const inboxLabels = (await readInboxSettings().catch(() => ({ labels: [] }))).labels;
  // Thẻ Đã mua / Hủy đơn / Khách xấu / Bám đuổi thành công: không phải ứng viên.
  const boughtLabelIds = labelsForEvents(inboxLabels, ['order', 'cancel', 'bad', 'followup-won']);
  // Thẻ Khiếu nại / Bảo hành / Cần người xử lý (theo cài đặt thẻ, cộng mã mặc định): bỏ qua, có đếm lý do.
  const skipReasonLabelIds = [...new Set([...labelsForEvents(inboxLabels, ['handoff', 'complaint', 'warranty', 'wholesale']), ...defaultSkipLabelIds])];
  // Khiếu nại / Bảo hành / Khách sỉ: chặn cả lời nhắc giỏ.
  const hardReasonLabelIds = [...new Set([...labelsForEvents(inboxLabels, ['complaint', 'warranty', 'wholesale']), ...hardSkipLabelIds])];
  // R14 (…039804): hai kịch bản (bình luận 12h + hộp thư 3h) cùng nhắm MỘT hộp thư → 2 tin y hệt cùng phút (khóa sent
  // theo `kịch bản:page:psid`). Mỗi khách (page + psid) chỉ một tin trong một lượt và trong `followUpSpacingMs`.
  const touchedThisRun = new Set();
  const sentIndex = followUpSentIndex(state);
  // R14 (quyết định 6, …897712): khách đã có đơn landing cùng SĐT (kho landing cục bộ, không gọi mạng) — đọc một lần mỗi lượt.
  let landingOrdersCache = null;
  const landingOrdersOnce = async () => {
    if (!landingOrdersCache) landingOrdersCache = Promise.resolve().then(() => readLandingOrders()).then(store => (Array.isArray(store?.orders) ? store.orders : Array.isArray(store) ? store : [])).catch(() => []);
    return landingOrdersCache;
  };
  // Tắt riêng bám đuổi bình luận (followUps.commentEnabled = false): kịch bản comment-no-reply đứng yên.
  const commentEnabled = settings.followUps.commentEnabled !== false;
  for (const configured of settings.followUps.scenarios.filter(item => item.enabled && (commentEnabled || item.trigger !== 'comment-no-reply'))) {
    // Mẫu tin bị tắt trong Thiết lập tin nhắn: kịch bản đứng yên.
    if (!followUpScenarioText(configured, settings.messageTemplates)) continue;
    // Chủ shop 01/10: ưu đãi (1 túi dùng thử miễn ship, combo 2 tặng bát) CHỈ chào ở kịch bản 36 giờ.
    // Kịch bản sớm hơn (hộp thư 3h, bình luận 12h…) chỉ nhắc lại: không đặt promo/trial, lời ưu đãi đổi
    // sang lời nhắc thường (followUpPlan).
    const { scenario, template } = followUpPlan(configured, settings.messageTemplates);
    if (!template) continue;
    // Kịch bản xét lùi N ngày (bám lại khách đã im từ trước lúc bật).
    const since = scenario.backlogDays ? Math.min(activatedAt, now - scenario.backlogDays * 24 * 60 * 60 * 1000) : activatedAt;
    // Khách im lâu nhất được gửi trước (sắp quá 7 ngày).
    // R13: hộp thư đang giữ giỏ (≤ 24 giờ) mà không vào diện bám của kịch bản này → ghi lý do (chỉ kê mã, không đếm vào skipped).
    const onExcluded = (inbox, reason) => {
      const pending = inbox?.pendingOrder;
      if (!Array.isArray(pending?.items) || !pending.items.length || now - (Number(pending.at) || 0) > pendingOrderRemindMs) return;
      if (state.sent[`${scenario.id}:${inbox.pageId}:${inbox.psid}`]) return;
      noteSkip(`giỏ đang giữ – ${reason}`, inbox);
    };
    const candidates = findFollowUpCandidates(store, scenario, { now, activatedAt: since, boughtLabelIds: boughtLabelIds.length ? boughtLabelIds : ['customer', 'cancelled', 'bad', 'followup-won'], onExcluded }).sort((a, b) => a.repliedAt - b.repliedAt);
    for (const candidate of candidates) {
      summary.checked += 1;
      if (state.sent[candidate.key]) { skip('alreadySent'); continue; }
      // R14 (…039804): khách vừa nhận (hay đang xếp hàng) một tin bám đuổi của kịch bản khác trong lượt này / 12 giờ qua.
      // Kịch bản chỉ nhắc (không ưu đãi): ghi bỏ qua luôn (lời nhắc thứ hai y hệt vô ích); kịch bản ưu đãi: để lượt sau.
      const customerKey = customerKeyOf(candidate.conversation);
      if (touchedThisRun.has(customerKey) || now - lastFollowUpAt(state, store, candidate, customerKey, sentIndex) < followUpSpacingMs) {
        if (!scenario.freeShipDays) {
          await updateFollowUpState(current => {
            current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, error: 'khách vừa nhận tin bám đuổi khác', skipped: 'sameCustomer' };
            return null;
          });
        }
        skip('sameCustomer', candidate.conversation);
        continue;
      }
      // Khách đã không nhận được tin (#551…) và chưa nhắn lại Page từ đó: bỏ qua luôn, không gọi Pancake.
      const blockedEntry = undeliverableBlock(state, candidate, store);
      if (blockedEntry) {
        await updateFollowUpState(current => {
          current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, error: `khách không nhận được tin: ${blockedEntry.error}`, skipped: 'undeliverable' };
          return null;
        });
        skip('undeliverable', candidate.conversation);
        continue;
      }
      // Khách đã chọn túi mà chưa gửi SĐT/địa chỉ: nhắc đúng giỏ đang giữ (ORDER_ADDRESS_REMIND) thay lời
      // "còn phân vân loại nào". Chỉ khi nhắn riêng vào hộp thư và kịch bản không phải ưu đãi dùng thử;
      // bot mới hỏi vị (ASK_FLAVOR, chưa có giỏ) thì lời kịch bản như cũ. Xưng hô theo cách Page đang gọi khách.
      const inboxMessages = candidate.inbox ? messagesIn(store, candidate.inbox) : [];
      const remind = candidate.inbox && !scenario.freeShipDays ? orderRemindText(candidate.inbox, settings.messageTemplates, { now, messages: inboxMessages }) : '';
      // Khách đang khiếu nại / chờ người thật / nhân viên đã nhắn / bot tắt / đã nói dừng: không chen tin bám đuổi.
      // Đang giữ giỏ: thẻ "cần người xử lý" / attention không chặn lời nhắc giỏ (nhân viên chưa trả lời).
      const skipReason = followUpSkipReason(candidate, store, { skipLabelIds: skipReasonLabelIds, hardLabelIds: hardReasonLabelIds, basketHeld: Boolean(remind), now });
      if (skipReason) { skip(skipReason, candidate.conversation); continue; }
      // Lời theo ngữ cảnh: chọn biến thể nói đúng dòng sản phẩm khách hỏi; lời kịch bản nói dòng khác
      // (khách hỏi yến mạch, kịch bản mời granola) thì không bám bằng câu lạc đề.
      const families = customerProductFamilies(store, candidate);
      const text = renderFollowUpMessage(template, candidate.conversation, Math.random, { messages: candidate.inbox ? inboxMessages : messagesIn(store, candidate.conversation), families });
      if (!remind && families.size) {
        const spoken = productFamiliesIn(text);
        if (spoken.size && ![...spoken].some(family => families.has(family))) { skip('productMismatch', candidate.conversation); continue; }
      }
      // Đơn 14 ngày ở hội thoại khác của cùng khách hay trùng tên (đơn không gắn vào hội thoại này): khách vừa mua, không bám.
      const elsewhere = recentOrderElsewhere(store, candidate.conversation, now);
      if (elsewhere) {
        await updateFollowUpState(current => {
          current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, error: elsewhere, returning: true };
          return null;
        });
        summary.returning = (summary.returning || 0) + 1;
        noteSkip('returning', candidate.conversation);
        continue;
      }
      // R14 (quyết định 6, …897712): SĐT khách để lại trong CRM (giỏ, tin nhắn) trùng đơn landing 14 ngày → khách đã mua.
      // Đang nhắc giỏ: chỉ tính đơn landing đặt SAU lúc chọn giỏ (khách quen mua lần mới vẫn được nhắc).
      const landingSince = remind ? Number(candidate.inbox?.pendingOrder?.at) || 0 : 0;
      const landingLocal = landingOrderReason(await landingOrdersOnce(), customerPhonesOf(store, candidate), { now, since: landingSince });
      if (landingLocal) {
        await updateFollowUpState(current => {
          current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, error: landingLocal, returning: true };
          return null;
        });
        summary.returning = (summary.returning || 0) + 1;
        noteSkip('returning', candidate.conversation);
        continue;
      }
      // Kịch bản ưu đãi (miễn ship dùng thử) gửi thẳng: phải tra được Pancake/POS trước, không tra được thì hoãn
      // (khách vừa mua 3 túi ở POS mà đơn không gắn vào hội thoại từng nhận ưu đãi). Hàng chờ ngoài 24 giờ tra lúc lập lô.
      // Khách chỉ bình luận, chưa có hộp thư: không bao giờ tra được → không hoãn mãi (mỗi 15 phút đếm "hoãn"),
      // ghi bỏ qua 'noInbox' MỘT lần (lượt sau tính alreadySent).
      if (scenario.freeShipDays && !candidate.outsideWindow && !candidate.inbox) {
        await updateFollowUpState(current => {
          current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, error: 'khách chỉ bình luận, chưa có hộp thư để tra Pancake/POS', skipped: 'noInbox' };
          return null;
        });
        skip('noInbox', candidate.conversation);
        continue;
      }
      // Bám đuổi bình luận nhắn vào hộp thư: Messenger chỉ cho Page nhắn trong 24 giờ kể từ tin cuối
      // của KHÁCH ở hộp thư (hộp thư mở bằng tin nhắn riêng mà khách chưa nhắn = chưa mở cửa sổ → #551).
      // Hết hạn và kịch bản không cho trả lời công khai → bỏ qua một lần, không gọi API, không tính trần.
      const inboxOpen = Boolean(candidate.inbox) && (candidate.thread ? inboxWindowOpen(store, candidate.inbox, now) : true);
      if (candidate.thread && !inboxOpen && !scenario.publicFallback) {
        await updateFollowUpState(current => {
          current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, error: candidate.inbox ? 'ngoài 24 giờ Messenger (khách chưa nhắn hộp thư gần đây)' : 'khách chỉ bình luận, chưa có hộp thư', skipped: 'outsideWindow' };
          return null;
        });
        skip('outsideWindow', candidate.conversation);
        continue;
      }
      if (scenario.freeShipDays && !candidate.outsideWindow && !conversationInfo) { summary.deferred = (summary.deferred || 0) + 1; continue; }
      // Nhóm đối chứng 10% (theo psid, cố định): KHÔNG gửi, để đo bám đuổi có thêm đơn thật không
      // (so tỷ lệ đơn 14 ngày giữa nhóm gửi và nhóm không gửi).
      if (isFollowUpHoldout(candidate.conversation.psid)) {
        await updateFollowUpState(current => { current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, error: 'nhóm đối chứng (không gửi để đo hiệu quả)', holdout: true }; return null; });
        await updateMessagingStore(current => { const target = current.conversations.find(item => item.id === candidate.conversation.id); if (target && !target.followUpHoldout) target.followUpHoldout = { scenarioId: scenario.id, at: now }; return null; }, { defer: true });
        summary.holdout = (summary.holdout || 0) + 1;
        noteSkip('holdout', candidate.conversation);
        continue;
      }
      // Đủ số tin mỗi lượt: hoãn TRƯỚC khi tra Pancake/POS (không tốn lượt gọi API cho khách sẽ không gửi).
      // Tin ngoài 24 giờ chỉ xếp hàng chờ, không tính vào trần.
      if (!candidate.outsideWindow && summary.sent + summary.failed >= maxPerRun) { summary.deferred = (summary.deferred || 0) + 1; continue; }
      // Chỉ bám khách mới: tra Pancake/POS xem khách đã từng mua chưa (khách chỉ bình luận,
      // chưa có hộp thư thì không tra được). Tra lỗi thì để lượt sau, không gửi mù.
      // Nhắc giỏ đang giữ là chăm sóc đơn, không phải mời mua: khách quen cũng được nhắc, không tra.
      if (conversationInfo && candidate.inbox && !remind) {
        let info;
        try {
          info = await conversationInfo(candidate.inbox.pageId, `${candidate.inbox.pageId}_${candidate.inbox.psid}`);
        } catch (error) {
          summary.deferred = (summary.deferred || 0) + 1;
          continue;
        }
        // R14: SĐT Pancake của hội thoại trùng đơn landing (đơn landing không gắn vào hội thoại, POS chưa kịp đồng bộ).
        const returning = returningCustomerReason(info) || landingOrderReason(await landingOrdersOnce(), new Set((Array.isArray(info?.phones) ? info.phones : []).map(phoneKey).filter(Boolean)), { now });
        if (returning) {
          await updateFollowUpState(current => {
            current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, error: returning, returning: true };
            return null;
          });
          summary.returning = (summary.returning || 0) + 1;
        noteSkip('returning', candidate.conversation);
          continue;
        }
      }
      // Ngoài 24 giờ API Pancake/Meta từ chối (#10): không gọi, xếp hàng chờ để
      // nhân viên gửi trong Pancake (extension Pancake gửi được ngoài 24 giờ).
      if (candidate.outsideWindow) {
        await updateFollowUpState(current => {
          current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, queued: true, text, pageId: candidate.inbox.pageId, psid: candidate.inbox.psid, freeShipDays: scenario.freeShipDays || 0, ...(conversationInfo ? { checkedAt: now } : {}) };
          return null;
        });
        summary.queued = (summary.queued || 0) + 1;
        touchedThisRun.add(customerKey);
        continue;
      }
      let outcome = null;
      let error = '';
      let undeliverable = false;
      // Nhắn riêng vào hộp thư trước (chỉ khi cửa sổ 24 giờ còn mở); không có hộp thư hay gửi riêng lỗi thì
      // trả lời công khai dưới bình luận (nếu kịch bản cho — như trước, không thêm đường gửi công khai nào).
      // `followUp: true`: tin lưu mang cờ bám đuổi (không tính là "Page trả lời", không phải nhân viên).
      if (candidate.inbox && inboxOpen) {
        try {
          const sent = await sendMessage(candidate.inbox, { text: remind || text, followUp: true });
          outcome = { via: 'private', messageId: String(sent?.message?.mid || sent?.message?.id || ''), text: remind || text, ...(remind ? { templateId: 'ORDER_ADDRESS_REMIND' } : {}) };
        } catch (failure) {
          // INT-04: "không rõ đã gửi" (hết giờ chờ Pancake, gửi dở) = coi như ĐÃ gửi: ghi lời bám đuổi (để bản dội về
          // mang cờ bám đuổi, giãn cách 12 giờ tính cả lần này), gắn thẻ, không gửi công khai dự phòng, không gửi lại.
          if (failure?.unknownDelivery) outcome = { via: 'private', messageId: '', text: remind || text, uncertain: true, ...(remind ? { templateId: 'ORDER_ADDRESS_REMIND' } : {}) };
          else {
            error = failure.message;
            undeliverable = isUndeliverableError(failure);
          }
        }
      } else if (candidate.inbox) {
        error = 'ngoài 24 giờ Messenger (khách chưa nhắn hộp thư gần đây)';
      }
      if (!outcome && candidate.thread && scenario.publicFallback) {
        try {
          const sent = await sendMessage(candidate.thread, { text, privateReply: false, followUp: true });
          outcome = { via: 'public', messageId: String(sent?.message?.mid || sent?.message?.id || ''), text };
        } catch (failure) {
          if (failure?.unknownDelivery) outcome = { via: 'public', messageId: '', text, uncertain: true };
          else error = failure.message;
        }
      }
      await updateFollowUpState(current => {
        current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, ...(outcome || { error: error || 'không có kênh gửi', ...(undeliverable ? { skipped: 'undeliverable' } : {}) }) };
        trimSentRecords(current.sent);
        // Khách không nhận được tin (#551 / chặn / ngoài cửa sổ): mọi kịch bản bỏ qua khách này cho tới khi khách nhắn lại.
        if (!outcome && undeliverable) {
          current.undeliverable = current.undeliverable && typeof current.undeliverable === 'object' ? current.undeliverable : {};
          current.undeliverable[customerKeyOf(candidate.conversation)] = { at: now, error: String(error).slice(0, 200), scenarioId: scenario.id };
          const entries = Object.keys(current.undeliverable);
          if (entries.length > maxSentRecords) for (const key of entries.slice(0, entries.length - maxSentRecords)) delete current.undeliverable[key];
        }
        return null;
      });
      if (outcome) {
        touchedThisRun.add(customerKey);
        summary.sent += 1;
        log(`Bám đuổi "${scenario.name}": ${outcome.uncertain ? 'không rõ đã tới (coi như đã gửi)' : 'đã gửi'} ${outcome.via === 'public' ? 'công khai' : 'riêng'} cho ${candidate.conversation.name || candidate.conversation.id}`);
        await markConversationFollowedUp(candidate.conversation.id, scenario, outcome.via, now, { remindedBasket: outcome.templateId === 'ORDER_ADDRESS_REMIND' });
      } else if (undeliverable) {
        // Không tính vào trần mỗi lượt (maxPerRun): trước đây 100% lỗi #551 ăn hết trần, khách gửi được phải chờ.
        summary.undeliverable = (summary.undeliverable || 0) + 1;
        skip('undeliverable', candidate.conversation);
        log(`Bám đuổi "${scenario.name}": khách ${candidate.conversation.name || candidate.conversation.id} không nhận được tin, bỏ qua từ nay: ${error}`);
      } else {
        summary.failed += 1;
        log(`Bám đuổi "${scenario.name}": không gửi được cho ${candidate.conversation.name || candidate.conversation.id}: ${error || 'không có kênh gửi'}`);
      }
    }
  }
  // R13: một dòng tổng hợp lý do không bám theo từng khách (6 số cuối mã) — chỉ ghi khi khác lượt trước (lượt chạy 15 phút
  // một lần, cùng một danh sách thì không lặp log). Chi tiết lượt gần nhất nằm ở lastRun.skipDetails.
  if (Object.keys(skipDetails).length) {
    summary.skipDetails = skipDetails;
    const line = Object.entries(skipDetails).map(([reason, marks]) => `${reason} ×${Math.max(marks.length, summary.skipReasons[reason] || 0)} (${marks.join(', ')})`).join('; ');
    if (line !== lastSkipLogLine) {
      lastSkipLogLine = line;
      log(`Bám đuổi: không bám — ${line}`);
    }
  }
  await updateFollowUpState(current => { current.lastRunAt = now; current.lastRun = summary; return null; });
  return summary;
}
// Dòng log lý do không bám của lượt trước (không lặp lại y nguyên mỗi 15 phút).
let lastSkipLogLine = '';

/**
 * Tin bám đuổi đã tới khách: gắn thẻ "Bám đuổi" (thẻ nào nhận sự kiện followup
 * do Cài đặt → Tin nhắn quyết định), ghi lịch sử, và với kịch bản tặng miễn ship
 * thì ghi ưu đãi lên hội thoại để bot tính đúng khi khách đặt — không thì lời
 * mời miễn ship mà đơn vẫn cộng ship.
 */
async function markConversationFollowedUp(conversationId, scenario, via, now, { remindedBasket = false } = {}) {
  const labelDefs = (await readInboxSettings().catch(() => ({ labels: [] }))).labels;
  const followUpLabels = labelsForEvents(labelDefs, ['followup']);
  let labelChange = null;
  await updateMessagingStore(current => {
    const target = current.conversations.find(item => item.id === conversationId);
    if (!target) return null;
    // Vừa nhắc "em vẫn đang giữ đơn…": giỏ phải thật sự còn giữ khi khách trả lời. Giỏ của bot chỉ sống
    // 2 giờ tính từ `at`; touchPendingOrder ghi remindedAt → giỏ đã nhắc dùng được thêm 24 giờ (pending-order.mjs).
    if (remindedBasket) touchPendingOrder(target, now);
    const before = Array.isArray(target.labels) ? [...target.labels] : [];
    if (followUpLabels.length) target.labels = [...new Set([...before, ...followUpLabels])];
    if ((target.labels || []).length !== before.length) labelChange = { conversation: { id: target.id, name: target.name || '' }, before, after: [...target.labels] };
    target.followUps = [...(Array.isArray(target.followUps) ? target.followUps : []), { scenarioId: scenario.id, at: now, via }].slice(-20);
    // Ưu đãi dùng thử mở luồng riêng (processing/trial-flow.mjs) từ bước 'offered'; giỏ cũ
    // bỏ đi để không trộn với ưu đãi 1 túi.
    // Khách đã chọn túi trong ưu đãi còn hạn (đang ở giữa bước đơn): giữ nguyên, không đặt lại.
    const midway = target.promo?.stage === 'chosen' && Math.max(Number(target.promo.until) || 0, Number(target.promo.lockedUntil) || 0) > now;
    if (scenario.freeShipDays && !midway) {
      target.promo = { freeShipping: true, until: now + scenario.freeShipDays * 24 * 60 * 60 * 1000, scenarioId: scenario.id, at: now, stage: 'offered' };
      target.pendingOrder = null;
    }
    return null;
  }, { defer: true });
  // Lịch sử thẻ của hội thoại (nhật ký hoạt động): thẻ Bám đuổi do hệ thống tự gắn.
  if (labelChange) appendLabelAudit({ actor: AUTOMATED_ACTORS.system, ...labelChange, labelDefs, reason: 'bám đuổi' });
  publishMessagingEvent({ type: 'customer-panel', conversationId });
}

const foldText = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

/**
 * Bám đuổi chỉ dành cho khách MỚI. Lý do coi là khách cũ (rỗng = khách mới), từ
 * thông tin hội thoại tra lúc gửi: hồ sơ khách Pancake/POS (số đơn, tiền đã mua,
 * ngày mua cuối, thẻ), đơn gần đây của Pancake, lịch sử POS và bảng đơn CRM theo SĐT.
 */
export function returningCustomerReason(info = {}) {
  // order_count của Pancake gồm cả đơn landing bỏ dở / hủy: chỉ tin đơn thành công, tiền đã mua, ngày mua cuối.
  if (Number(info.succeedOrderCount) > 0 || Number(info.purchasedAmount) > 0 || info.lastOrderAt) return 'khách cũ: đã có đơn trên Pancake/POS';
  if (Number(info.recentOrders) > 0) return 'khách cũ: có đơn gần đây trên Pancake';
  if (Number(info.posOrders) > 0) return 'khách cũ: SĐT đã có đơn trên POS';
  if (Number(info.crmOrders) > 0) return 'khách cũ: SĐT đã có đơn trong CRM';
  if ((info.tags || []).some(tag => /(da mua|khach cu|khach quen|than thiet|\bvip\b|da gui)/.test(foldText(tag)))) return 'khách cũ: thẻ khách đã mua';
  return '';
}

const followUpWinWindowMs = 14 * 24 * 60 * 60 * 1000;

/** Khách thuộc nhóm đối chứng 10% (băm psid, cố định theo khách). */
export function isFollowUpHoldout(psid) {
  const text = String(psid || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return text.length > 0 && hash % 10 === 0;
}

/** Đơn chốt trong 14 ngày sau mốc `at` (dùng cho cả nhóm gửi và nhóm đối chứng). */
const wonAfter = (conversation, at) => liveOrders(conversation).some(order => Number(order.createdAt) > at && Number(order.createdAt) - at <= followUpWinWindowMs);

/**
 * Đơn chốt sau tin bám đuổi (bot, nhân viên hay Facebook Shop, trong 14 ngày
 * kể từ tin bám đuổi đầu tiên, đơn chưa hủy): gắn thẻ "Bám đuổi thành công" và
 * ghi followUpWon lên hội thoại để đếm. Trả về số hội thoại vừa ghi nhận.
 */
const wonOrderOf = conversation => {
  if (conversation.followUpWon || !Array.isArray(conversation.followUps) || !conversation.followUps.length) return null;
  const firstAt = Math.min(...conversation.followUps.map(item => Number(item.at) || Infinity));
  return liveOrders(conversation)
    .filter(item => Number(item.createdAt) > firstAt && Number(item.createdAt) - firstAt <= followUpWinWindowMs)
    .sort((first, second) => Number(first.createdAt) - Number(second.createdAt))[0] || null;
};

export async function markFollowUpWins(now = Date.now()) {
  // Đọc trước, chỉ ghi kho khi có khách vừa chốt (chạy mỗi 15 phút, không ghi thừa).
  const snapshot = await readMessagingStore();
  if (!(snapshot.conversations || []).some(wonOrderOf)) return 0;
  const labelDefs = (await readInboxSettings().catch(() => ({ labels: [] }))).labels;
  const wonLabels = labelsForEvents(labelDefs, ['followup-won']);
  const labelChanges = [];
  const won = await updateMessagingStore(store => {
    const changed = [];
    for (const conversation of store.conversations || []) {
      const order = wonOrderOf(conversation);
      if (!order) continue;
      conversation.followUpWon = { orderId: String(order.id), at: Number(order.createdAt), total: Number(order.total) || 0, markedAt: now };
      const before = Array.isArray(conversation.labels) ? [...conversation.labels] : [];
      if (wonLabels.length) conversation.labels = [...new Set([...before, ...wonLabels])];
      if ((conversation.labels || []).length !== before.length) labelChanges.push({ conversation: { id: conversation.id, name: conversation.name || '' }, before, after: [...conversation.labels] });
      changed.push(conversation.id);
    }
    return changed;
  });
  for (const change of labelChanges) appendLabelAudit({ actor: AUTOMATED_ACTORS.system, ...change, labelDefs, reason: 'bám đuổi thành công' });
  for (const conversationId of won || []) publishMessagingEvent({ type: 'customer-panel', conversationId });
  return (won || []).length;
}

const pancakeConversationUrl =(pageId, psid) => `https://pancake.vn/${encodeURIComponent(pageId)}?c=${encodeURIComponent(`${pageId}_${psid}`)}`;

// Một lô đã giao cho trạm gửi Pancake thì giữ chỗ 45 phút: lô sau không lấy lại
// cùng khách (gửi trùng) khi lô trước còn đang chạy hay chưa báo kết quả.
const batchLeaseMs = 45 * 60 * 1000;
const queueMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const maxBatchSize = 50;
const maxRelayAttempts = 2;
// Extension Pancake không tìm được ID Facebook của khách (lệnh GET_GLOBAL_ID_FOR_CONV): không phải lần gửi lỗi —
// khách KHÔNG bị bỏ khỏi hàng (không tính vào maxRelayAttempts), được đánh dấu "cần gửi tay" và chỉ nhờ extension
// tìm lại sau 24 giờ (03/10: 29 lần hụt liền, cả hàng 137 khách bị bỏ dần mà chưa ai được gửi).
export const followUpLookupRetryMs = 24 * 60 * 60 * 1000;
const lookupBlocked = (entry, now) => Number(entry?.lookupFailedAt) > 0 && now - Number(entry.lookupFailedAt) < followUpLookupRetryMs;

// Thẻ mặc định không bám: Đã mua hàng, Cần người xử lý, Khiếu nại, Bảo hành, Hủy đơn, Khách xấu, Bám đuổi thành công.
const skipLabelIds = new Set(['customer', 'consulting', 'complaint', 'warranty', 'cancelled', 'bad', 'followup-won']);
// Đã mua theo lịch sử chat: tin xác nhận đơn / phiếu đơn của Page, hay chính khách nói đã mua / đã nhận hàng.
const closesOrder = message => (message?.direction === 'outgoing' && (message.type === 'order-receipt' || closedOrderText.test(String(message.text || '')))) || (message?.direction === 'incoming' && customerBoughtText(message.text));
const boughtInChat = messages => (Array.isArray(messages) ? messages : []).some(closesOrder);

/**
 * Giỏ đang giữ (còn hạn nhắc 24 giờ) được chọn SAU đơn cuối cùng của khách (đơn còn hiệu lực, phiếu
 * đơn / lời chốt trong chat): khách quen đang mua lần mới — vẫn nhắc giỏ dù hội thoại mang dấu "đã mua".
 */
export function basketAfterOrders(inbox, messages = [], now = Date.now()) {
  const pending = inbox?.pendingOrder;
  const items = Array.isArray(pending?.items) ? pending.items.filter(item => item?.product) : [];
  const at = Number(pending?.at) || 0;
  if (!items.length || !at || now - at > pendingOrderRemindMs) return false;
  const lastOrderAt = Math.max(0, ...liveOrders(inbox).map(order => Number(order.createdAt) || 0), lastAt(Array.isArray(messages) ? messages : [], closesOrder));
  return at > lastOrderAt;
}
const customerBoughtPattern = /(đã mua|mua rồi|đã nhận|vừa nhận|nhận được hàng rồi|đã đặt rồi|đặt rồi)/i;
// R14 (quyết định 6, …659307 "Mình đặt của shop trên tiktok rồi", …897712 "Anh đặt trên trang của mình 477k"): khách nói
// đã mua / đặt ở kênh khác (sàn, web, landing). So trên chữ bỏ dấu; câu hỏi ("đặt trên shopee được không?") không tính.
const elsewhereChannels = '(tiktok|tik tok|tiktokshop|shopee|shoppe|lazada|san|web|website|trang|landing|app)';
const elsewhereQuestion = /\?|\b(duoc|dc|khong|ko|k|hong|hem|chua|sao|nao|the nao|bao nhieu|bn|co|ha|hay|re hon)\s*(a|ah|vay|nhi|shop|em|e|c|chi|ban)?\s*$/;
const elsewherePatterns = [
  new RegExp(`\\b(mua|dat|order|lay)\\b[^.?!\\n]{0,30}\\b(tren|o|qua|ben)\\s+(shop\\s+)?${elsewhereChannels}\\b`),
  new RegExp(`\\b(mua|dat|order)\\b[^.?!\\n]{0,20}\\b(tiktok|tik tok|shopee|shoppe|lazada)\\b[^?\\n]{0,15}\\b(roi|r)\\b`)
];
/** R14: khách nói đã mua / đặt trên sàn, web, landing ("đặt trên tiktok rồi") — không bám đuổi, không nhắc giỏ. */
export function boughtElsewhereText(text) {
  const folded = foldText(String(text ?? '').normalize('NFC')).replace(/\s+/g, ' ').trim();
  return elsewherePatterns.some(pattern => pattern.test(folded)) && !elsewhereQuestion.test(folded);
}
// R14 (…897712 "Anh mua 3 túi rồi mà"): "mua/đặt <số> túi rồi" — trước đây chỉ bắt "mua rồi" liền nhau.
const boughtQuantityPattern = /\b(mua|dat|lay)\s+(\d+|mot|hai|ba|bon|nam)\s*(tui|goi|hop|bich|combo)\s+(roi|r)\b(?!\s*(thi|gui|ship|giao|lam|moi|cho|nhan|ck|chuyen)\b)/;
/** Khách nói đã mua / đã nhận / đã đặt (ở chat này hay kênh khác). */
export function customerBoughtText(text) {
  const value = String(text ?? '').normalize('NFC');
  if (customerBoughtPattern.test(value)) return true;
  if (boughtElsewhereText(value)) return true;
  return boughtQuantityPattern.test(foldText(value).replace(/\s+/g, ' '));
}
const closedOrderText = /(xác nhận lại thông tin đặt hàng|đã gửi xác nhận đơn hàng|đơn của .{1,20} đã được (tạo|lên)|mã vận đơn|quét mã QR|sau khi nhận hàng mình giúp em kiểm tra|đã nhận được hàng)/i;

/** Khóa khách (Page + psid) dùng cho danh sách "không nhận được tin". */
const customerKeyOf = conversation => `${conversation?.pageId}:${conversation?.psid}`;

// ===== R14: một khách một tin bám đuổi trong khoảng ngắn; khách đã có đơn landing =====
// Hai kịch bản khác nhau không gửi cho cùng một khách trong 12 giờ (…039804: 2 tin y hệt cùng phút).
export const followUpSpacingMs = 12 * 60 * 60 * 1000;

/**
 * Lần gần nhất khách (page + psid) nhận / đang chờ nhận một tin bám đuổi: mục đã gửi (via) hay đang xếp hàng
 * trong follow-ups.json của MỌI kịch bản, và followUps[] ghi trên hộp thư / luồng bình luận. 0 = chưa có.
 */
export function lastFollowUpAt(state, store, candidate, customerKey = customerKeyOf(candidate?.conversation), sentIndex = null) {
  let latest = 0;
  if (sentIndex) latest = sentIndex.get(customerKey) || 0;
  else {
    for (const [key, entry] of Object.entries(state?.sent || {})) {
      if (!entry || !(entry.via || entry.queued) || !key.endsWith(`:${customerKey}`)) continue;
      latest = Math.max(latest, Number(entry.sentAt) || Number(entry.at) || 0);
    }
  }
  for (const record of [candidate?.inbox, candidate?.thread, candidate?.conversation].filter(Boolean)) {
    for (const item of Array.isArray(record.followUps) ? record.followUps : []) latest = Math.max(latest, Number(item?.at) || 0);
  }
  return latest;
}

/**
 * INT-07: Map<"page:psid", mốc bám đuổi gần nhất> dựng MỘT lần mỗi lượt từ follow-ups.json (khoá "kịch bản:page:psid"),
 * thay vì duyệt tới 5000 mục cho từng ứng viên. Mục ghi thêm trong lượt đã được `touchedThisRun` chặn riêng.
 */
function followUpSentIndex(state) {
  const index = new Map();
  for (const [key, entry] of Object.entries(state?.sent || {})) {
    if (!entry || !(entry.via || entry.queued)) continue;
    const parts = key.split(':');
    if (parts.length < 3) continue;
    const customerKey = parts.slice(-2).join(':');
    index.set(customerKey, Math.max(index.get(customerKey) || 0, Number(entry.sentAt) || Number(entry.at) || 0));
  }
  return index;
}

/** SĐT dạng 0xxxxxxxxx (10 số) hay '' — so khớp đơn landing. */
export function phoneKey(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('84') && digits.length === 11) digits = `0${digits.slice(2)}`;
  return /^0\d{9}$/.test(digits) ? digits : '';
}
const phoneInTextPattern = /(?:\+?84|0)(?:[\s.-]?\d){9}(?!\d)/g;

/** Các SĐT khách đã để lại trong CRM: giỏ đang giữ, trường phone của hội thoại, đơn của hội thoại, tin khách nhắn. */
export function customerPhonesOf(store, candidate) {
  const phones = new Set();
  const add = value => { const key = phoneKey(value); if (key) phones.add(key); };
  for (const record of [candidate?.inbox, candidate?.thread, candidate?.conversation].filter(Boolean)) {
    add(record.pendingOrder?.phone);
    add(record.phone);
    add(record.customerPhone);
    for (const message of incomingOf(messagesIn(store, record))) for (const match of String(message.text || '').match(phoneInTextPattern) || []) add(match);
  }
  return phones;
}

/**
 * Đơn landing 14 ngày (chưa hủy, không bỏ dở "Chưa hoàn tất") trùng một SĐT trong `phones`, đặt từ `since` trở đi →
 * lý do không bám; '' = không có.
 */
export function landingOrderReason(landingOrders, phones, { now = Date.now(), since = 0 } = {}) {
  if (!phones?.size || !Array.isArray(landingOrders)) return '';
  for (const order of landingOrders) {
    if (!order || !phones.has(phoneKey(order.phone))) continue;
    const createdAt = Number(order.createdAt) || 0;
    if (!createdAt || now - createdAt > recentOrderMs || createdAt < since) continue;
    if (isCancelledOrder(order) || order.status === 'Hủy' || order.status === 'Chưa hoàn tất' || order.landing?.incomplete) continue;
    return 'khách cũ: SĐT đã có đơn landing';
  }
  return '';
}

// Kho landing cục bộ (webhook Webcake + đồng bộ POS). Nạp động: follow-up không kéo cả landing-orders khi chỉ dùng hàm khác.
// Trong tiến trình test không đọc kho thật (trừ khi test trỏ LANDING_ORDERS_PATH hay truyền readLandingOrders).
async function defaultReadLandingOrders() {
  if (process.env.NODE_TEST_CONTEXT && !process.env.LANDING_ORDERS_PATH) return [];
  const { readLandingStore } = await import('./landing-orders.mjs');
  return readLandingStore();
}

/**
 * Lỗi gửi nghĩa là khách KHÔNG nhận được tin dù thử lại (không phải lỗi mạng tạm): #551 "người này
 * hiện không có mặt" (hộp thư chưa mở / khách chặn), (#10) ngoài cửa sổ, #10903 khách chặn tin,
 * hội thoại chưa có mã Pancake.
 */
export function isUndeliverableError(error) {
  const text = String(error?.message || error || '');
  return /#551\b|"code"\s*:\s*551\b|\(#10\)|#10903\b|isn'?t available|is not available right now|outside (of )?(the )?allowed window|chưa có mã Pancake/i.test(text);
}

/** Cửa sổ 24 giờ của hộp thư còn mở: khách nhắn hộp thư trong `messengerWindowMs` (23 giờ, chừa 1 giờ). */
export function inboxWindowOpen(store, inbox, now = Date.now()) {
  return messengerWindowOpen(store, inbox, { now });
}

/** Khách nằm trong danh sách "không nhận được tin" và chưa nhắn lại Page từ lúc đó → mục chặn; không thì null. */
function undeliverableBlock(state, candidate, store) {
  const entry = state.undeliverable?.[customerKeyOf(candidate.conversation)];
  if (!entry) return null;
  const records = [candidate.inbox, candidate.thread].filter(Boolean);
  const lastCustomer = Math.max(0, ...records.map(record => Math.max(Number(record.lastCustomerMessageAt) || 0, lastAt(incomingOf(messagesIn(store, record)), () => true))));
  return lastCustomer > (Number(entry.at) || 0) ? null : entry;
}

/**
 * Dọn hàng chờ ngoài 24 giờ: mục quá 7 ngày (tính từ lần Page trả lời, như lúc lập lô) không còn hợp
 * ngữ cảnh → rời hàng chờ, ghi lý do. Mỗi lần tối đa `limit` mục; mục đang nằm trong lô (giữ chỗ) để
 * yên. Lịch sử đã xử lý quá `maxSentRecords` thì bỏ bớt mục cũ nhất (mục còn chờ giữ nguyên).
 */
export async function expireFollowUpQueue({ now = Date.now(), limit = 200 } = {}) {
  const state = await readFollowUpState();
  const entries = Object.entries(state.sent || {});
  const stale = entries
    .filter(([, item]) => item?.queued && !(Number(item.leasedUntil) > now) && now - (Number(item.repliedAt) || Number(item.at) || 0) > queueMaxAgeMs)
    .slice(0, limit);
  if (!stale.length && entries.length <= maxSentRecords) return 0;
  return updateFollowUpState(current => {
    let removed = 0;
    for (const [key] of stale) {
      const entry = current.sent[key];
      if (!entry?.queued) continue;
      delete entry.queued;
      delete entry.leasedUntil;
      entry.error = 'quá 7 ngày trong hàng chờ';
      entry.expiredAt = now;
      removed += 1;
    }
    trimSentRecords(current.sent);
    return removed;
  });
}

/**
 * Lịch sử bám đuổi quá `maxSentRecords`: bỏ mục ĐÃ XỬ LÝ cũ nhất (theo `at`); mục còn trong hàng chờ ngoài 24 giờ
 * (queued, kể cả đang nằm trong lô) giữ nguyên (INT-14: trước đây lượt gửi cắt theo thứ tự khoá, xoá cả mục còn chờ).
 */
function trimSentRecords(sent) {
  const keys = Object.keys(sent);
  if (keys.length <= maxSentRecords) return 0;
  const done = keys.filter(key => !sent[key]?.queued).sort((first, second) => (Number(sent[first]?.at) || 0) - (Number(sent[second]?.at) || 0));
  const drop = done.slice(0, keys.length - maxSentRecords);
  for (const key of drop) delete sent[key];
  return drop.length;
}

function stillWanted(item, byId, store) {
  const conversation = byId.get(item.conversationId);
  if (!conversation || conversation.botEnabled === false || (Array.isArray(conversation.customerOrders) && conversation.customerOrders.length)) return false;
  if ((Array.isArray(conversation.labels) ? conversation.labels : []).some(label => skipLabelIds.has(label))) return false;
  const messages = Array.isArray(store.messages?.[conversation.id]) ? store.messages[conversation.id] : [];
  if (boughtInChat(messages)) return false;
  return !incomingOf(messages).some(message => Number(message.createdAt) > item.at);
}

/**
 * Hàng chờ gửi qua Pancake: tin bám đuổi ngoài 24 giờ chưa gửi. Khách đã lên
 * tiếng lại, đã có đơn hay nhân viên tắt bot sau lúc xếp hàng thì tự rơi khỏi
 * hàng (không cần nhắn nữa). `leased` = đang nằm trong một lô chưa báo kết quả.
 */
export async function followUpQueue({ now = Date.now() } = {}) {
  const state = await readFollowUpState();
  const store = await readMessagingStore();
  const byId = new Map((store.conversations || []).map(item => [item.id, item]));
  return Object.entries(state.sent)
    .filter(([, item]) => item.queued && stillWanted(item, byId, store))
    .map(([key, item]) => ({ key, conversationId: item.conversationId, name: item.name, at: item.at, repliedAt: item.repliedAt, scenarioId: item.scenarioId, text: item.text, pageId: item.pageId, psid: item.psid, globalId: item.globalId || '', attempts: item.attempts || 0, lastError: item.lastError || (item.noGlobalId ? 'Pancake chưa có ID Facebook của khách — gửi tay bằng nút Mở Pancake' : ''), noGlobalId: item.noGlobalId === true, lookupFailedAt: Number(item.lookupFailedAt) || 0, lookupError: item.lookupError || '', needsManual: !item.globalId && lookupBlocked(item, now), leased: Number(item.leasedUntil) > now, pancakeUrl: pancakeConversationUrl(item.pageId, item.psid) }))
    .sort((first, second) => first.repliedAt - second.repliedAt);
}

/**
 * Xử lý một tin trong hàng chờ: `sent` (đã gửi → gắn thẻ, ghi ưu đãi) hay
 * `skip` (bỏ qua khách này, kèm lý do). Trả về false khi không còn trong hàng.
 */
export async function resolveFollowUpQueueItem(key, action, { readSettings, now = Date.now(), reason = 'nhân viên bỏ qua', via = 'pancake' } = {}) {
  const item = await updateFollowUpState(current => {
    const entry = current.sent[key];
    if (!entry?.queued) return null;
    delete entry.queued;
    delete entry.leasedUntil;
    if (action === 'sent') { entry.via = via; entry.sentAt = now; delete entry.lastError; } else entry.error = reason;
    return { ...entry };
  });
  if (!item) return false;
  if (action === 'sent') {
    const settings = readSettings ? await readSettings() : null;
    const configured = settings?.followUps?.scenarios?.find(entry => entry.id === item.scenarioId);
    // Ưu đãi chỉ ở kịch bản 36 giờ: kịch bản trong cài đặt sớm hơn 36 giờ thì không bật ưu đãi (kể cả tin
    // xếp hàng từ bản cũ có ghi số ngày); không còn kịch bản trong cài đặt thì theo số ngày ghi lúc xếp hàng.
    const freeShipDays = configured
      ? (Number(configured.delayHours) >= FOLLOW_UP_OFFER_MIN_DELAY_HOURS ? configured.freeShipDays || item.freeShipDays || 0 : 0)
      : item.freeShipDays || 0;
    const scenario = { id: item.scenarioId, freeShipDays };
    await markConversationFollowedUp(item.conversationId, scenario, via, now);
  }
  return true;
}

/**
 * Tin trong hàng chờ đã tới khách mà chưa ai bấm "Đã gửi" (nhân viên gửi tay
 * trong Pancake, hay trạm gửi chưa kịp báo): Pancake đồng bộ tin của Page về
 * CRM, thấy tin gửi đi sau lúc xếp hàng thì xác nhận luôn.
 */
export async function reconcileFollowUpQueue(now = Date.now(), { readSettings } = {}) {
  const state = await readFollowUpState();
  const queued = Object.entries(state.sent).filter(([, item]) => item.queued);
  if (!queued.length) return 0;
  const store = await readMessagingStore();
  let confirmed = 0;
  for (const [key, item] of queued) {
    const messages = Array.isArray(store.messages?.[item.conversationId]) ? store.messages[item.conversationId] : [];
    // Chỉ tính đúng lời bám đuổi (so phần đầu), không tính tin khác nhân viên nhắn.
    const head = compactText(item.text).slice(0, 40);
    const sentAfter = head && outgoingOf(messages).some(message => Number(message.createdAt) > item.at && compactText(message.text).startsWith(head));
    if (sentAfter && await resolveFollowUpQueueItem(key, 'sent', { now, via: 'pancake', readSettings })) confirmed += 1;
  }
  return confirmed;
}

const followUpEchoWindowMs = 24 * 60 * 60 * 1000;

/**
 * Lời bám đuổi đã xếp hàng / đã gửi gần đây, theo hội thoại CRM: Map<conversationId, [{ text, at, queued }]>
 * (text đã chuẩn hóa khoảng trắng). Dùng khi đồng bộ Pancake: trạm gửi (extension Pancake) gửi tin bám
 * đuổi dưới tên nhân viên đang mở trình duyệt, Pancake ghi admin_name là tên người đó — tin khớp lời
 * bám đuổi thì không phải nhân viên nhắn (không tắt bot, không đếm staffReplied).
 * Giữ: mục còn trong hàng chờ, hay mục có mốc xếp/lập lô/gửi trong 24 giờ trước `now`.
 */
export async function recentFollowUpTexts({ now = Date.now() } = {}) {
  const state = await readFollowUpState();
  const byConversation = new Map();
  for (const item of Object.values(state.sent || {})) {
    const text = compactText(item?.text);
    if (!text || !item.conversationId) continue;
    const at = Math.max(Number(item.at) || 0, Number(item.batchedAt) || 0, Number(item.sentAt) || 0);
    if (!item.queued && now - at > followUpEchoWindowMs) continue;
    const list = byConversation.get(item.conversationId) || [];
    list.push({ text, at, queued: item.queued === true });
    byConversation.set(item.conversationId, list);
  }
  return byConversation;
}

/**
 * Tin Page `message` (của hội thoại `conversationId`) là lời bám đuổi đã xếp/gửi? So nguyên văn sau khi
 * chuẩn hóa khoảng trắng; mục đã gửi chỉ khớp tin trong 24 giờ quanh mốc gửi.
 */
export function matchesFollowUpText(entries, message) {
  const text = compactText(message?.text);
  if (!text || !Array.isArray(entries)) return false;
  const at = Number(message?.createdAt) || 0;
  return entries.some(entry => entry.text === text && (entry.queued || !at || Math.abs(at - entry.at) <= followUpEchoWindowMs));
}

/**
 * Dọn hàng chờ: tra lại khách chưa được xét (xếp hàng từ bản cũ, chưa lọc khách
 * cũ), khách đã từng mua thì bỏ khỏi hàng. Mỗi lần tối đa `limit` khách.
 */
export async function pruneReturningFromQueue({ conversationInfo, limit = 40, now = Date.now() } = {}) {
  if (!conversationInfo) return { checked: 0, removed: 0 };
  const state = await readFollowUpState();
  const pending = Object.entries(state.sent).filter(([, item]) => item.queued && !item.checkedAt && item.pageId && item.psid).slice(0, limit);
  let removed = 0;
  let checked = 0;
  for (const [key, item] of pending) {
    let info;
    try {
      info = await conversationInfo(item.pageId, `${item.pageId}_${item.psid}`);
    } catch {
      continue;
    }
    checked += 1;
    const returning = returningCustomerReason(info);
    if (returning) {
      if (await resolveFollowUpQueueItem(key, 'skip', { now, reason: returning })) removed += 1;
      continue;
    }
    await updateFollowUpState(current => { if (current.sent[key]) current.sent[key].checkedAt = now; return null; });
  }
  return { checked, removed };
}

/**
 * Lô gửi cho trạm gửi Pancake (dấu trang chạy trên pancake.vn, đưa từng tin cho
 * extension Pancake). Mỗi khách hỏi lại Pancake ngay lúc này: khách đã có đơn
 * trên Pancake/POS thì bỏ khỏi hàng; lấy ID Facebook toàn cục mà extension cần.
 */
// Hai nhân viên/tab tạo lô gần nhau: lô sau chờ lô trước ghi lease xong mới chọn khách, không trùng.
let activeBatchBuild = Promise.resolve();
export function buildFollowUpBatch(options = {}) {
  const operation = activeBatchBuild.then(() => buildFollowUpBatchOnce(options));
  activeBatchBuild = operation.then(() => undefined, () => undefined);
  return operation;
}

async function buildFollowUpBatchOnce({ limit = 30, conversationInfo, now = Date.now(), readSettings } = {}) {
  await reconcileFollowUpQueue(now, { readSettings });
  const size = Math.max(1, Math.min(maxBatchSize, Math.round(Number(limit) || 30)));
  // Khách Pancake chưa lưu ID Facebook: vẫn vào lô (tối đa 10/lô), cầu nối nhờ extension
  // Pancake tìm ID theo tên + thời điểm hội thoại trước khi gửi.
  const maxLookups = 10;
  let lookups = 0;
  const queue = (await followUpQueue({ now })).filter(item => !item.leased);
  const token = randomUUID();
  // Lời gửi dựng lại theo mẫu HIỆN TẠI (mẫu đổi sau lúc xếp hàng thì khách nhận lời mới).
  const settings = readSettings ? await readSettings().catch(() => null) : null;
  const store = await readMessagingStore();
  const currentText = item => {
    const scenario = settings?.followUps?.scenarios?.find(entry => entry.id === item.scenarioId);
    const template = scenario ? followUpPlan(scenario, settings.messageTemplates).template : '';
    const conversation = (store.conversations || []).find(entry => entry.id === item.conversationId) || { name: item.name };
    return template ? renderFollowUpMessage(template, conversation) : item.text;
  };
  const texts = new Map();
  const items = [];
  const skipped = [];
  // Chưa im đủ số giờ của kịch bản HIỆN TẠI (đổi 24 → 36 giờ sau lúc xếp hàng): chờ tiếp.
  const due = item => {
    const scenario = settings?.followUps?.scenarios?.find(entry => entry.id === item.scenarioId);
    return !scenario || now - Number(item.repliedAt) >= scenario.delayHours * 60 * 60 * 1000;
  };
  for (const item of queue) {
    // Khách im quá 7 ngày: ưu đãi dùng thử không còn hợp ngữ cảnh, bỏ khỏi hàng thay vì gửi.
    if (now - Number(item.repliedAt) > queueMaxAgeMs) {
      await resolveFollowUpQueueItem(item.key, 'skip', { now, reason: 'quá 7 ngày trong hàng chờ' });
      skipped.push({ key: item.key, name: item.name, reason: 'quá 7 ngày' });
      continue;
    }
    if (items.length >= size) break;
    if (!due(item)) continue;
    const conversationId = `${item.pageId}_${item.psid}`;
    let info;
    try {
      info = await conversationInfo(item.pageId, conversationId);
    } catch (error) {
      skipped.push({ key: item.key, name: item.name, reason: `Pancake lỗi: ${error.message}` });
      continue;
    }
    const returning = returningCustomerReason(info);
    if (returning) {
      await resolveFollowUpQueueItem(item.key, 'skip', { now, reason: returning });
      skipped.push({ key: item.key, name: item.name, reason: 'khách cũ đã từng mua' });
      continue;
    }
    if (!info.canInbox) {
      await resolveFollowUpQueueItem(item.key, 'skip', { now, reason: 'khách không nhận tin (chặn Page)' });
      skipped.push({ key: item.key, name: item.name, reason: 'khách chặn tin' });
      continue;
    }
    const globalId = info.globalId || item.globalId || '';
    if (!globalId) {
      // Pancake chưa lưu ID Facebook: ghi dấu, đưa vào lô (có hạn) để extension tự tìm ID.
      if (!item.noGlobalId) await updateFollowUpState(current => { if (current.sent[item.key]) current.sent[item.key].noGlobalId = true; return null; });
      // Extension đã hụt ID khách này trong 24 giờ qua: không nhờ tìm lại (vẫn ở hàng chờ, "cần gửi tay").
      if (lookupBlocked(item, now)) { skipped.push({ key: item.key, name: item.name, reason: 'cần gửi tay (extension Pancake chưa tìm được ID Facebook, thử lại sau 24 giờ)' }); continue; }
      if (lookups >= maxLookups) { skipped.push({ key: item.key, name: item.name, reason: 'chờ lô sau (tìm ID Facebook tối đa 10 khách/lô)' }); continue; }
      lookups += 1;
    }
    const text = currentText(item);
    texts.set(item.key, text);
    const conversation = (store.conversations || []).find(entry => entry.id === item.conversationId);
    const updatedTime = Math.max(Number(conversation?.lastMessageAt) || 0, ...((store.messages?.[item.conversationId] || []).map(message => Number(message.createdAt) || 0)));
    // Khách cần tìm ID: kèm tên / mốc / mã luồng PANCAKE đang giữ (cầu nối ưu tiên dùng, thiếu thì lùi về PSID / tên / mốc CRM).
    const lookupHints = globalId ? {} : { pancakeName: String(info.name || ''), pancakeUpdatedAt: Number(info.updatedAt) || 0, threadId: String(info.threadId || ''), threadKey: String(info.threadKey || '') };
    items.push({ key: item.key, pageId: item.pageId, convId: conversationId, globalUserId: globalId, needsGlobalId: !globalId, updatedTime, name: item.name, text, ...lookupHints });
  }
  // Khách phải tìm ID xếp cuối lô: không làm lô dừng sớm vì 3 lần tìm ID lỗi liền.
  items.sort((first, second) => Number(first.needsGlobalId) - Number(second.needsGlobalId));
  const keys = new Set(items.map(item => item.key));
  if (keys.size) {
    await updateFollowUpState(current => {
      // Ghi lại lời sẽ gửi (tự xác nhận so đầu tin đồng bộ về khớp lời mới) và mã lô (kết quả
      // báo về phải mang đúng mã này).
      for (const key of keys) if (current.sent[key]) Object.assign(current.sent[key], { leasedUntil: now + batchLeaseMs, batchToken: token, batchedAt: now, text: texts.get(key) || current.sent[key].text });
      return null;
    });
  }
  return { kind: 'GIOTNANG_FOLLOWUP', version: 2, token, createdAt: now, delayMs: [15000, 30000], items, skipped, remaining: Math.max(0, queue.length - items.length - skipped.length) };
}

/** Bỏ giữ chỗ (nhân viên bấm Dừng / đóng trang giữa lô): khách chưa gửi về lại hàng chờ ngay. */
export async function releaseFollowUpLeases(keys = null) {
  if (Array.isArray(keys) && !keys.length) return 0;
  return updateFollowUpState(current => {
    let released = 0;
    for (const [key, entry] of Object.entries(current.sent)) {
      if (!entry.queued || !entry.leasedUntil || (Array.isArray(keys) && keys.length && !keys.includes(key))) continue;
      delete entry.leasedUntil;
      released += 1;
    }
    return released;
  });
}

/**
 * R14: lý do lỗi của một lô trạm gửi Pancake cho dòng log máy chủ — mỗi lý do rút gọn 80 ký tự, che SĐT (9–11 số,
 * kể cả viết cách), gộp lý do trùng (×N), tối đa 3 lý do. Kết quả ok / unknown (chờ xác nhận) không tính. Rỗng = không có.
 */
export function followUpRelayErrorText(results = [], { limit = 3, width = 80 } = {}) {
  const counts = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    if (!result || result.ok || result.unknown === true) continue;
    const reason = String(result.error || 'không rõ lỗi')
      .replace(/(?:\+?84|0)(?:[\s.-]?\d){8,10}(?!\d)/g, '<sđt>')
      .replace(/\d{9,}/g, '<số>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, width) || 'không rõ lỗi';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  const reasons = [...counts.entries()].map(([reason, count]) => (count > 1 ? `${reason} ×${count}` : reason));
  return reasons.slice(0, limit).join('; ') + (reasons.length > limit ? `; +${reasons.length - limit} lý do khác` : '');
}

/**
 * Kết quả trạm gửi báo về: tin gửi được thì xác nhận (thẻ + ưu đãi); lỗi thì trả
 * lại hàng chờ, lỗi quá 2 lần thì thôi (ghi lỗi để nhân viên xem).
 */
export async function recordFollowUpBatchResults(results = [], { now = Date.now(), readSettings, token = '' } = {}) {
  const summary = { sent: 0, failed: 0, dropped: 0 };
  const state = await readFollowUpState();
  for (const result of Array.isArray(results) ? results : []) {
    const key = String(result?.key || '');
    if (!key) continue;
    // Kết quả phải mang đúng mã lô đã cấp (chống link #followup-results giả).
    // lookupFailed: true = extension Pancake không tìm được ID Facebook (chưa gửi gì) — xem nhánh riêng ở dưới.
    const entry = state.sent[key];
    if (!entry?.queued || (entry.batchToken ? entry.batchToken !== String(token || '') : Boolean(token))) { summary.rejected = (summary.rejected || 0) + 1; continue; }
    // Extension vừa tìm được ID Facebook: ghi lại để lần sau khỏi tìm.
    if (/^\d{5,25}$/.test(String(result.globalId || ''))) await updateFollowUpState(current => { const target = current.sent[key]; if (target) { target.globalId = String(result.globalId); delete target.noGlobalId; delete target.lookupFailedAt; delete target.lookupError; } return null; });
    if (result.ok) {
      if (await resolveFollowUpQueueItem(key, 'sent', { now, via: 'pancake-relay', readSettings })) summary.sent += 1;
      continue;
    }
    if (result.unknown === true) {
      // Cầu nối hết giờ chờ mà extension có thể đã gửi: KHÔNG trả về hàng chờ ngay
      // (lô sau gửi trùng), không tính lần lỗi. Giữ chỗ thêm 45 phút; đồng bộ
      // Pancake kéo tin về thì reconcileFollowUpQueue xác nhận, không thấy thì
      // hết giữ chỗ tự về hàng chờ. Kết quả ok:true đến trễ vẫn ghi được.
      const held = await updateFollowUpState(current => {
        const target = current.sent[key];
        if (!target?.queued) return null;
        target.leasedUntil = now + batchLeaseMs;
        target.lastError = 'trạm gửi không trả lời — chờ đồng bộ Pancake xác nhận';
        return true;
      });
      if (held) summary.unknown = (summary.unknown || 0) + 1;
      continue;
    }
    const error = String(result.error || 'không rõ lỗi').slice(0, 200);
    if (result.lookupFailed === true) {
      // Hụt ID Facebook (chưa gửi gì cho khách): giữ trong hàng chờ, không tính lần lỗi, đánh dấu "cần gửi tay";
      // lô sau không nhờ extension tìm lại trong 24 giờ (buildFollowUpBatch / lookupBlocked).
      const marked = await updateFollowUpState(current => {
        const target = current.sent[key];
        if (!target?.queued) return null;
        delete target.leasedUntil;
        target.noGlobalId = true;
        target.lookupFailedAt = now;
        target.lookupError = error;
        target.lastError = `cần gửi tay — extension Pancake không tìm được ID Facebook: ${error}`;
        return true;
      });
      if (marked) summary.lookupFailed = (summary.lookupFailed || 0) + 1;
      continue;
    }
    const dropped = await updateFollowUpState(current => {
      const entry = current.sent[key];
      if (!entry?.queued) return null;
      delete entry.leasedUntil;
      entry.attempts = (entry.attempts || 0) + 1;
      entry.lastError = error;
      if (entry.attempts < maxRelayAttempts) return false;
      delete entry.queued;
      entry.error = `trạm gửi Pancake lỗi ${entry.attempts} lần: ${error}`;
      return true;
    });
    if (dropped === null) continue;
    summary.failed += 1;
    if (dropped) summary.dropped += 1;
  }
  return summary;
}

/**
 * Bật lại bám đuổi (tắt → bật): mốc tính lại từ lúc này, để không gửi dồn cho
 * mọi khách cũ đã im lặng trong 7 ngày lúc tính năng còn tắt.
 */
export async function resetFollowUpActivation(now = Date.now()) {
  await updateFollowUpState(state => { state.activatedAt = now; return null; });
}

/** Tóm tắt cho màn cài đặt: đã bật từ khi nào, lần chạy cuối, các lần gửi gần nhất. */
/**
 * Đơn "bám đuổi thành công" còn hiệu lực của hội thoại: { orderId, total } hay null. Đơn đã ghi nhận
 * (followUpWon.orderId) còn trong hội thoại mà đã hủy / hoàn / bom → thay bằng đơn hợp lệ khác trong
 * 14 ngày sau tin bám đuổi đầu (nếu có). Đơn không còn trong hội thoại (dữ liệu cũ) → giữ như đã ghi.
 */
export function currentFollowUpWin(conversation) {
  const recorded = conversation?.followUpWon;
  if (!recorded) return null;
  const orders = Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [];
  const order = orders.find(item => String(item?.id) === String(recorded.orderId));
  if (!order) return { orderId: String(recorded.orderId || ''), total: Number(recorded.total) || 0 };
  if (!isCancelledOrder(order) && order.status !== 'Hủy') return { orderId: String(order.id), total: Number(order.total) || Number(recorded.total) || 0 };
  const firstAt = Math.min(...(Array.isArray(conversation.followUps) ? conversation.followUps : []).map(item => Number(item.at) || Infinity));
  if (!Number.isFinite(firstAt)) return null;
  const other = liveOrders(conversation)
    .filter(item => Number(item.createdAt) > firstAt && Number(item.createdAt) - firstAt <= followUpWinWindowMs)
    .sort((first, second) => Number(first.createdAt) - Number(second.createdAt))[0];
  return other ? { orderId: String(other.id), total: Number(other.total) || 0 } : null;
}

export async function followUpStatus() {
  const state = await readFollowUpState();
  const recent = Object.values(state.sent).sort((first, second) => second.at - first.at).slice(0, 20);
  const done = Object.values(state.sent).filter(item => !item.error && !item.queued);
  const conversations = (await readMessagingStore()).conversations || [];
  // Doanh thu / số đơn "bám đuổi thành công" tính lại theo trạng thái HIỆN TẠI của đơn: đơn đã ghi nhận
  // mà sau đó hủy / hoàn / bom (isCancelledOrder) thì không tính — trừ khi còn đơn khác hợp lệ trong 14 ngày.
  const wins = conversations.map(item => ({ conversation: item, win: currentFollowUpWin(item) })).filter(entry => entry.win);
  const won = wins.map(entry => entry.conversation);
  const followed = conversations.filter(item => Array.isArray(item.followUps) && item.followUps.length);
  const holdout = conversations.filter(item => item.followUpHoldout);
  return {
    // Hiệu quả: tỷ lệ chốt đơn 14 ngày của nhóm được gửi so với nhóm đối chứng không gửi.
    lift: {
      sent: { n: followed.length, won: won.length },
      holdout: { n: holdout.length, won: holdout.filter(item => wonAfter(item, Number(item.followUpHoldout.at) || 0)).length }
    },
    wonTotal: won.length,
    wonAmount: wins.reduce((sum, entry) => sum + entry.win.total, 0), activatedAt: state.activatedAt || 0, lastRunAt: state.lastRunAt || 0, lastRun: state.lastRun, sentTotal: done.length, recent: recent.filter(item => !item.queued), queue: await followUpQueue() };
}

let timer = null;
/** Chạy sau 30 giây rồi mỗi 15 phút; lượt trước chưa xong thì bỏ qua lượt sau. */
export function startFollowUpLoop(dependencies) {
  if (timer) return () => clearInterval(timer);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runFollowUps(dependencies);
      if (summary.sent || summary.failed) (dependencies.log || console.log)(`Bám đuổi: xét ${summary.checked}, gửi ${summary.sent}, lỗi ${summary.failed}`);
    } catch (error) {
      (dependencies.log || console.log)(`Bám đuổi lỗi: ${error.message}`);
    } finally {
      running = false;
    }
  };
  setTimeout(run, 30000);
  timer = setInterval(run, FOLLOW_UP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
