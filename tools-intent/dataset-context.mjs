// Hàm dùng chung cho bộ công cụ dữ liệu mô hình nhỏ (hợp đồng dòng dữ liệu v2):
// gộp tin khách như engine, dựng ngữ cảnh (giỏ, đơn, bot vừa xin gì…) từ lịch sử hội thoại,
// che SĐT, tập nhãn "lệch chính sách" (POLICY_DRIFT). Chỉ đọc mã app, không ghi gì.
import { extractVietnamesePhone } from '../app/processing/customer-info.mjs';
import { ADDRESS_WORDS, askedSlotOf, countBags, normalizeIntentText } from '../app/processing/intent-features.mjs';
import { isOrderStep } from '../app/processing/pending-order.mjs';
import { foldText } from '../app/processing/template-match.mjs';

/** Nhãn mà câu bot đã gửi KHÔNG chắc là câu đúng (chính sách đổi, hậu xử lý, thiếu ngữ cảnh): LLM được phép sửa. */
export const POLICY_DRIFT = new Set(['ORDER_ADDRESS', 'ASK_PRODUCT', 'ASK_FLAVOR', 'GENERAL_INFO', 'PRICE_QUOTE', 'REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO', 'ORDER_ADDRESS_REMIND', 'THANK_YOU']);

/** SĐT giả thay cho "<sdt>" khi chạy luật ngoại tuyến (luật đọc SĐT thật bằng extractVietnamesePhone). */
export const FAKE_PHONE = '0912345678';
export const maskPhone = text => String(text || '').replace(/\+?\d[\d .-]{8,13}/g, ' <sdt> ').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
export const unmaskPhone = text => String(text || '').replace(/<sdt>/g, FAKE_PHONE);

/** Bước đơn theo engine (ctx.lastWasOrderStep): ORDER_ADDRESS/PHONE/CONFIRMATION/UPDATE + ASK_FLAVOR, ORDER_ADDRESS_REMIND, ORDER_CUSTOM_BASKET. */
export const lastWasOrderStepOf = id => isOrderStep(id) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(String(id || ''));
/** Mẫu bot mà sau đó giỏ chắc chắn đang được giữ (không gồm ASK_FLAVOR: chưa có túi nào). */
const BASKET_STEPS = /^ORDER_(ADDRESS|PHONE|CONFIRMATION|UPDATE|UPDATED|CART_LINE)|^ORDER_CUSTOM_BASKET$/;
/** Chữ ký giỏ trong câu bot: "đang giữ đơn …", "đơn của chị gồm …". */
const BASKET_SIGNATURE = /\bdang giu don\b|\bdon (hang )?cua \S+ gom\b/;
export const basketTtlMin = 120;

/** Giỏ còn hạn suy từ câu bot trước: bước đơn / chữ ký giỏ, và câu đó gửi chưa quá 120 phút. */
export function hasBasketOf({ lastTemplate = '', prevBot = '', prevBotAgeMin = Infinity } = {}) {
  const age = Number.isFinite(Number(prevBotAgeMin)) && prevBotAgeMin !== null ? Number(prevBotAgeMin) : Infinity;
  if (age >= basketTtlMin) return false;
  return BASKET_STEPS.test(String(lastTemplate || '')) || BASKET_SIGNATURE.test(foldText(prevBot));
}

/** Số túi trong giỏ bot nêu ở câu trước ("2 Granola Túi Xanh 450g, 1 Túi Vàng…" → 3); 0 khi không phải bước đơn. */
export function basketItemsOf({ lastTemplate = '', prevBot = '' } = {}) {
  const folded = foldText(prevBot);
  if (!BASKET_STEPS.test(String(lastTemplate || '')) && !BASKET_SIGNATURE.test(folded)) return 0;
  const segment = folded.replace(/^.*?\b(gom|giu don)\b/, '').replace(/\b(tong|so dien thoai|dia chi)\b.*$/, '');
  let total = 0;
  for (const match of segment.matchAll(/\b(\d{1,2}) (?:granola )?(?:tui|goi|bich|hop|combo|set)\b/g)) total += Number(match[1]);
  return Math.min(total, 99);
}

export const prevBotAsksOf = (prevBot, lastTemplate = '') => askedSlotOf(prevBot, lastTemplate);
// Tin gộp: SĐT ở dòng riêng ("0912 345 678\n12 Nguyễn Huệ…") — extractVietnamesePhone nối số qua xuống dòng và
// hỏng, nên xét cả từng dòng (mô hình nhìn chữ đã che "<sdt>", cũng theo từng SĐT).
export const phoneInTextOf = text => String(text || '').includes('<sdt>') || Boolean(extractVietnamesePhone(String(text || ''))) || String(text || '').split('\n').some(line => extractVietnamesePhone(line));
export const addressInTextOf = text => ADDRESS_WORDS.test(normalizeIntentText(text));
export const bagCountOf = text => countBags(text);

/** Đơn còn hiệu lực (như engine.isActiveOrder). */
export const isActiveOrder = order => Boolean(order) && String(order.processingStatus || '') !== 'cancelled' && order.status !== 'Hủy';

/** Đơn gần nhất đặt TRƯỚC mốc `at` và chưa hủy → { hasOrder, orderAgeMin } (null khi không có). */
export function orderContextAt(customerOrders, at) {
  const orders = (Array.isArray(customerOrders) ? customerOrders : []).filter(order => isActiveOrder(order) && (Number(order?.createdAt) || 0) > 0 && Number(order.createdAt) < at);
  const latest = orders.reduce((best, order) => (!best || Number(order.createdAt) > Number(best.createdAt) ? order : best), null);
  return latest ? { hasOrder: true, orderAgeMin: Math.round((at - Number(latest.createdAt)) / 60000) } : { hasOrder: false, orderAgeMin: null };
}

// Gộp tin như engine (unansweredCustomerMessages): tin chữ của khách sau câu trả lời gần nhất của
// Page, trong 10 phút tính tới tin đang xử lý, nhiều nhất 5 tin, nối bằng "\n".
export const bundleWindowMs = 10 * 60 * 1000;
export const bundleLimit = 5;
const isCustomerText = item => item?.direction === 'incoming' && (item.type || 'text') === 'text' && String(item.text || '').trim();

/**
 * Cắt lịch sử (đã sắp xếp theo thời gian) thành các LƯỢT: mỗi cụm tin khách liên tiếp (tới tin Page
 * kế tiếp) là một lượt; tin cuối cụm là tin engine xử lý, `bundle` là các tin được gộp vào nó.
 * @returns {{ index:number, current:object, bundle:object[], text:string, replies:object[], before:object[] }[]}
 */
export function customerTurns(messages) {
  const list = (Array.isArray(messages) ? messages : []).slice().sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  const turns = [];
  let i = 0;
  while (i < list.length) {
    if (list[i]?.direction !== 'incoming') { i += 1; continue; }
    let j = i;
    while (j < list.length && list[j]?.direction === 'incoming') j += 1;
    const cluster = list.slice(i, j);
    const texts = cluster.filter(isCustomerText);
    if (texts.length) {
      const current = texts[texts.length - 1];
      const now = Number(current.createdAt) || 0;
      const bundle = texts.filter(item => now - (Number(item.createdAt) || now) <= bundleWindowMs).slice(-bundleLimit);
      const replies = [];
      for (let k = j; k < list.length && list[k]?.direction !== 'incoming'; k += 1) replies.push(list[k]);
      turns.push({ index: list.indexOf(current), current, bundle, text: bundle.map(item => String(item.text || '').trim()).join('\n'), replies, before: list.slice(0, i) });
    }
    i = j;
  }
  return turns;
}

/**
 * Ngữ cảnh v2 của một lượt từ lịch sử trước cụm (`before`), lúc `at`.
 * Bot = tin Page không mang cờ staff; nhân viên = tin Page có cờ staff.
 */
export function turnContext({ before, at, matchTemplateFn = () => '' }) {
  const outgoing = before.filter(item => item?.direction === 'outgoing' && item.text);
  const prevOut = outgoing[outgoing.length - 1] || null;
  const prevIn = [...before].reverse().find(isCustomerText) || null;
  const lastBot = [...outgoing].reverse().find(item => !item.staff) || null;
  const lastBotAt = Number(lastBot?.createdAt) || 0;
  const lastTemplate = prevOut ? matchTemplateFn(prevOut.text) : '';
  const prevBotAgeMin = prevOut ? Math.round((at - (Number(prevOut.createdAt) || at)) / 60000) : null;
  const prevBot = prevOut ? maskPhone(prevOut.text).slice(0, 240) : '';
  return {
    prevBot,
    prevCustomer: prevIn ? maskPhone(prevIn.text).slice(0, 160) : '',
    lastTemplate,
    lastWasOrderStep: lastWasOrderStepOf(lastTemplate),
    hasBasket: hasBasketOf({ lastTemplate, prevBot, prevBotAgeMin }),
    basketItems: basketItemsOf({ lastTemplate, prevBot }),
    prevBotAsks: prevBotAsksOf(prevBot, lastTemplate),
    prevBotAgeMin,
    staffRepliedAfterBot: outgoing.some(item => item.staff && (Number(item.createdAt) || 0) > lastBotAt + 5000)
  };
}

/** Các trường tính từ chính chữ khách (đã gộp; SĐT thật hay "<sdt>" đều tính là có). */
export function textContext(text) {
  return { phoneInText: phoneInTextOf(text), addressInText: addressInTextOf(text), bagCount: bagCountOf(text) };
}

export const readJsonl = content => String(content || '').split('\n').filter(Boolean).map(line => JSON.parse(line));
export const toJsonl = rows => rows.map(row => JSON.stringify(row)).join('\n');
