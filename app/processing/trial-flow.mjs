// Luồng riêng cho ưu đãi bám đuổi "1 túi dùng thử miễn phí vận chuyển".
//
// Khách đang giữ ưu đãi (conversation.promo, hộp thư, còn hạn, chưa đặt đơn sau
// khi nhận) KHÔNG đi qua luồng chung: không bảng giá combo, không mời lên 2 túi,
// không "từ 2 túi miễn ship". Luồng này tự trả lời những gì chắc chắn (đồng ý,
// chọn túi, SĐT, hỏi giá/freeship, từ chối, câu hỏi thông tin ngắn); tin khó
// (có địa chỉ, ảnh…) mới nhờ mô hình, và câu trả lời của mô hình được lọc lại
// để không lọt mẫu của luồng chung.
//
// Trạng thái nằm ngay trong conversation.promo:
//   stage: offered → chosen (đã chọn túi) → ordered
//          · declined (từ chối) · converted (khách tự xin ≥ 2 túi → đơn thường, giá combo)
//   bag: tên túi đã chọn · lockedUntil: đã chọn túi trong hạn thì giữ thêm 24 giờ
//   accepted: đã mời chọn túi một lần (lần sau nhắc ngắn)
import { extractVietnamesePhone } from './customer-info.mjs';
import { getCatalogProducts } from './catalog.mjs';
import { foldVietnamese } from './auto-label.mjs';
import { core, infoRules } from './rule-intent.mjs';

const HOUR = 60 * 60 * 1000;
export const TRIAL_SCENARIO_NOTE = 'Ưu đãi dùng thử bám đuổi (1 túi miễn phí vận chuyển)';

const DECLINE = /\b(khong|ko|k|kh|chua) (can|lay|mua|an|thich|quan tam|co nhu cau)\b|\b(thoi|de sau|khi khac|lan sau|het tien|khong nhe|ko nhe|dung nhan|khoi)\b/;
const ACCEPT = /\b(ok|oke|okie|oki|okay|dong y|lay|thu|dat|mua|chot|len don|gui|ship|duoc|dc|co|u|uh|um|vang|da|nhan|muon)\b/;
const PRICE = /\b(gia|bn|bao nhieu|bnhiu|bao tien|nhieu tien|tong|het bao nhieu)\b/;
const FREESHIP = /(mien|free) ?(phi )?(ship|sip|van chuyen)|freeship|phi ship|tien ship|ship (bao nhieu|bn|nhieu|may)/;
const DISCOUNT = /(giam gia|khuyen mai|\bkm\b|uu dai|combo|\bsale\b|voucher|ma giam|qua tang|tang (gi|j))/;
const COLOURS = { xanh: 'XANH', vang: 'VANG', nau: 'NAU', cacao: 'NAU' };
// Mẫu thông tin trả thẳng được (trừ giá/ship/khuyến mãi — luồng này tự trả lời).
const PRICE_RULES = new Set(['FREESHIP', 'DISCOUNT', 'VOUCHER', 'GIFT']);
// Mẫu của luồng chung không được gửi cho khách đang giữ ưu đãi.
const BANNED = new Set(['GENERAL_INFO', 'DISCOUNT_POLICY', 'ASK_FLAVOR', 'ASK_PRODUCT', 'WELCOME', 'UPSELL_TWO_BAGS', 'PRICE_MIX_TUI_LON', 'PRICE_QUOTE_COMBO', 'PRICE_QUOTE', 'REPLY_ALREADY_SENT', 'LIVESTREAM_COMMENT', 'LIVESTREAM_VOUCHER', 'GIFT_POLICY']);

const money = value => `${Math.round(Number(value) || 0).toLocaleString('vi-VN')}đ`;
const bagProduct = colour => getCatalogProducts().find(item => item.active !== false && new RegExp(`^GRA-${colour}-`, 'i').test(item.sku || ''));

/** "Túi Xanh 450g 174.000đ, Túi Vàng 350g 174.000đ hay Túi Nâu vị cacao 350g 164.000đ" từ danh mục. */
export function trialBagOptions() {
  const bags = ['XANH', 'VANG', 'NAU']
    .map(bagProduct)
    .filter(Boolean)
    .map(item => `${String(item.name).replace(/^Granola\s+/i, '')} ${money(item.unitPrice || item.salePrice || item.originalPrice)}`);
  return bags.length > 1 ? `${bags.slice(0, -1).join(', ')} hay ${bags.at(-1)}` : bags.join('');
}

/** Ưu đãi còn hiệu lực của hội thoại, hay null. */
export function activeTrial(conversation = {}, { now = Date.now() } = {}) {
  const promo = conversation.promo;
  if (conversation.source === 'comment' || !promo?.freeShipping) return null;
  const stage = promo.stage || 'offered';
  if (stage !== 'offered' && stage !== 'chosen') return null;
  const until = Math.max(Number(promo.until) || 0, stage === 'chosen' ? Number(promo.lockedUntil) || 0 : 0);
  if (now > until) return null;
  // Đã đặt đơn (chưa hủy) sau khi nhận ưu đãi: ưu đãi đã dùng.
  const orders = Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [];
  if (orders.some(order => Number(order.createdAt) > Number(promo.at) && String(order.processingStatus || '') !== 'cancelled' && order.status !== 'Hủy')) return null;
  return { ...promo, stage };
}

/** Túi khách nêu trong tin: Map màu → số lượng ("xanh", "2 túi vàng", "vàng x2"). */
function bagPicks(raw) {
  const folded = foldVietnamese(String(raw || '').replace(/n[âa]u\s+(v[ịi]\s+)?ca\s*cao/giu, 'nâu').replace(/ca\s+cao/giu, 'cacao'))
    .replace(/xanh (duong|la cay)|dau xanh/g, ' ').replace(/\+?\d{9,11}/g, ' ');
  const picks = new Map();
  for (const match of folded.matchAll(/(?:\b(\d{1,2})\s*(?:tui|goi|bich|x)?\s*)?\b(xanh|vang|nau|cacao)\b(?:\s*(?:x\s*)?(\d{1,2})\b)?/g)) {
    const colour = COLOURS[match[2]];
    const quantity = Math.max(1, Math.min(20, Number(match[1] || match[3]) || 1));
    picks.set(colour, Math.max(picks.get(colour) || 0, quantity));
  }
  // "lấy 2 túi" không nêu màu: vẫn là xin nhiều túi.
  const loose = folded.match(/\b(\d{1,2})\s*(tui|goi|bich)\b/);
  return { picks, looseQuantity: loose ? Number(loose[1]) : 0 };
}

/**
 * Một bước của luồng dùng thử cho tin khách vừa nhắn. Trả về:
 * - { value, patch }: mẫu trả lời (render bằng renderChatbotReply với context.trial)
 * - { delegate: true, patch }: tin khó, nhờ mô hình (câu trả lời lọc bằng filterTrialReply)
 * - { exit: 'converted', patch }: khách tự xin ≥ 2 túi → luồng thường, giá combo
 */
export function trialStep({ text = '', type = 'text', trial, now = Date.now(), lastTemplateId = '' } = {}) {
  if (type !== 'text') return { delegate: true };
  const raw = String(text || '').trim();
  const s = core(raw);
  // Khách quan tâm gói nhỏ / combo 10 gói / sản phẩm khác (ưu đãi chỉ cho túi lớn),
  // hay đang trả lời câu hỏi về gói nhỏ bot vừa hỏi: sang luồng thường.
  if (/\b(goi nho|chia goi|combo 10|hop 10|10 goi|tung bua|tropical|bot nghe|nghe lanh|hat an lanh|hu hat)\b/.test(s) || lastTemplateId === 'PACKAGING_INFO') {
    return { exit: 'converted', patch: { stage: 'converted', endedAt: now, reason: 'khách quan tâm sản phẩm khác' } };
  }
  const phone = extractVietnamesePhone(raw);
  const longText = s.length > 60;
  const bags = trialBagOptions();
  if (DECLINE.test(s) && !phone) return { value: { template_id: 'TRIAL_DECLINED' }, patch: { stage: 'declined', endedAt: now } };
  const { picks, looseQuantity } = bagPicks(raw);
  const quantity = [...picks.values()].reduce((sum, value) => sum + value, 0);
  if (picks.size >= 2 || quantity >= 2 || looseQuantity >= 2) return { exit: 'converted', patch: { stage: 'converted', endedAt: now } };
  if (picks.size === 1) {
    const product = bagProduct([...picks.keys()][0]);
    if (!product) return { delegate: true };
    const patch = { stage: 'chosen', bag: product.name, lockedUntil: Math.max(Number(trial?.until) || 0, now + 24 * HOUR) };
    // Kèm SĐT / địa chỉ: mô hình đọc địa chỉ; giá vẫn là 1 túi miễn ship.
    if (phone || longText) return { delegate: true, patch };
    return { value: { template_id: 'ORDER_ADDRESS', Product_N1: product.name, No_A: '1' }, patch };
  }
  const chosen = trial?.stage === 'chosen' && trial.bag;
  const orderStep = chosen ? { template_id: 'ORDER_ADDRESS', Product_N1: trial.bag, No_A: '1' } : null;
  // Đã chọn túi, khách gửi SĐT (và/hoặc địa chỉ): bước đơn. SĐT trơn thì bộ soạn đơn tự đọc.
  if (chosen && phone && raw.replace(/[\s.+()-]/g, '').replace(/^\D*/, '').length <= 13) return { value: orderStep };
  if (chosen && (phone || longText)) return { delegate: true };
  if (FREESHIP.test(s)) return { value: { template_id: 'TRIAL_FREESHIP_INFO', values: { bags } } };
  if (DISCOUNT.test(s) || PRICE.test(s)) return { value: { template_id: 'TRIAL_PRICE', values: { bags } } };
  const asks = raw.includes('?') || s.length > 25;
  const info = s.length <= 70 && infoRules.find(([rule, pattern]) => !PRICE_RULES.has(rule) && pattern.test(s));
  if (info) return { value: { template_id: info[2], also: 'TRIAL_NEXT_STEP', values: { bags } } };
  if (!asks && (ACCEPT.test(s) || /^[\s.…!?1👍❤️🥰😍]*$/u.test(raw) || s.length <= 12)) {
    if (orderStep) return { value: orderStep };
    return { value: { template_id: trial?.accepted ? 'TRIAL_REMIND' : 'TRIAL_ACCEPT', values: { bags } }, patch: { accepted: true } };
  }
  if (phone && !chosen) return { delegate: true };
  return { delegate: true };
}

/**
 * Câu trả lời của mô hình cho khách đang giữ ưu đãi: mẫu của luồng chung (bảng
 * giá, combo, mời 2 túi, chào hàng) đổi thành mẫu dùng thử. Trả về giá trị mới để
 * render lại, hay null khi câu trả lời dùng được.
 */
export function filterTrialReply(reply = {}, trial = {}, isProductQuoteId = () => false) {
  const id = String(reply.templateId || '');
  const also = String(reply.alsoTemplateId || '');
  const banned = value => BANNED.has(value) || isProductQuoteId(value);
  if (id === 'FREESHIP_POLICY' || also === 'FREESHIP_POLICY') return { template_id: 'TRIAL_FREESHIP_INFO', values: { bags: trialBagOptions() } };
  if (!banned(id) && !banned(also)) return null;
  if (trial?.stage === 'chosen' && trial.bag) return { template_id: 'ORDER_ADDRESS', Product_N1: trial.bag, No_A: '1' };
  return { template_id: 'TRIAL_PRICE', values: { bags: trialBagOptions() } };
}

/** Gợi ý cho mô hình khi phải nhờ mô hình (tin có địa chỉ, ảnh…). */
export function trialModelHint(trial = {}) {
  return `KHÁCH ĐANG GIỮ ƯU ĐÃI 1 TÚI DÙNG THỬ MIỄN PHÍ VẬN CHUYỂN${trial.bag ? ` (đã chọn ${trial.bag})` : ''}: chỉ 1 túi, giá túi không cộng ship; không báo giá combo, không mời lấy 2 túi.`;
}
