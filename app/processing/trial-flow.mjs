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
// Chính sách bám đuổi 36 giờ (chủ shop 26/09): ngoài 1 túi miễn ship, khách lấy combo 2 túi lớn được tặng
// thêm 1 bộ bát gáo dừa (bảng quà chung chỉ tặng bộ bát + muỗng từ 3 túi). Quà này chỉ áp trong cửa sổ ưu đãi.
export const PROMO_BOWL_GIFT = { name: 'Bộ bát gáo dừa – ưu đãi bám đuổi', sku: 'BGD', minQuantity: 2, active: true, weight: 10 };

// Từ chối: "không", "ko cần", "thôi để sau"… — "thôi" chỉ là từ chối khi câu không nêu túi/số lượng ("lấy 1 túi thôi" là chọn).
const DECLINE = /^(khong|ko|k|kh|hong|hok|khong can|ko can|khong lay|ko lay|khong mua|ko mua|khong dau|ko dau|khong nhe|ko nhe)$|\b(khong|ko|k|kh|chua) (can|lay|mua|thich|quan tam|co nhu cau)\b|\b(de sau|khi khac|lan sau|het tien|dung nhan|dung gui|khoi)\b/;
const DECLINE_THOI = /\bthoi\b/;
const ACCEPT = /\b(ok|oke|okie|oki|okay|dong y|lay|thu|dat|mua|chot|len don|gui|ship|duoc|dc|co|u|uh|um|vang|da|nhan|muon)\b/;
// Khách nói đã mua / hủy / khiếu nại: không phải trả lời lời mời — nhờ mô hình đọc.
const NOT_OFFER = /\b(mua roi|dat roi|lay roi|huy|chua nhan|bi (moc|hoi|hu|loi)|khieu nai|tra hang|hoan)\b/;
const COMPARE = /(khac (nhau|gi|sao|ntn)|nao ngon|ngon hon|nen (chon|mua|lay) (loai|tui|vi)? ?nao|phan biet|so sanh)/;
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
  const rawStage = promo.stage || 'offered';
  // Khách đã chọn combo 2 túi (stage 'converted' + combo2) mà còn trong cửa sổ ưu đãi: vẫn giữ ưu đãi
  // (chủ shop 26/09) — đổi ý lấy 1 túi thì 1 túi đó vẫn miễn ship; coi như 'offered' chưa chọn túi.
  const combo2 = rawStage === 'converted' && Boolean(promo.combo2);
  const stage = combo2 ? 'offered' : rawStage;
  if (stage !== 'offered' && stage !== 'chosen') return null;
  const until = Math.max(Number(promo.until) || 0, stage === 'chosen' || combo2 ? Number(promo.lockedUntil) || 0 : 0);
  if (now > until) return null;
  // Đã đặt đơn (chưa hủy) sau khi nhận ưu đãi: ưu đãi đã dùng.
  const orders = Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [];
  if (orders.some(order => Number(order.createdAt) > Number(promo.at) && String(order.processingStatus || '') !== 'cancelled' && order.status !== 'Hủy')) return null;
  return { ...promo, stage, ...(combo2 ? { bag: '' } : {}) };
}

/**
 * Ưu đãi bám đuổi còn trong cửa sổ (kể cả khi khách đã chuyển sang combo 2 → stage 'converted' + combo2):
 * đơn 2 túi lớn được tặng bộ bát gáo dừa. Hết cửa sổ, đã đặt đơn sau ưu đãi, hay đã từ chối thì không.
 */
export function promoBowlActive(conversation = {}, { now = Date.now() } = {}) {
  const promo = conversation.promo;
  if (conversation.source === 'comment' || !promo?.freeShipping) return false;
  const stage = promo.stage || 'offered';
  if (!['offered', 'chosen', 'converted'].includes(stage)) return false;
  if (stage === 'converted' && !promo.combo2) return false;
  const until = Math.max(Number(promo.until) || 0, Number(promo.lockedUntil) || 0);
  if (now > until) return false;
  const orders = Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [];
  return !orders.some(order => Number(order.createdAt) > Number(promo.at) && String(order.processingStatus || '') !== 'cancelled' && order.status !== 'Hủy');
}

/** Túi khách nêu trong tin: Map màu → số lượng ("xanh", "2 túi vàng", "vàng x2"). */
function bagPicks(raw) {
  const folded = foldVietnamese(String(raw || '').replace(/n[âa]u\s+(v[ịi]\s+)?ca\s*cao/giu, 'nâu').replace(/ca\s+cao/giu, 'cacao'))
    .replace(/xanh (duong|la cay)|dau xanh/g, ' ').replace(/\+?\d{9,11}/g, ' ');
  const picks = new Map();
  let explicitQuantity = false;
  for (const match of folded.matchAll(/(?:\b(\d{1,2})\s*(?:tui|goi|bich|x)?\s*)?\b(xanh|vang|nau|cacao)\b(?:\s*(?:x\s*)?(\d{1,2})\b)?/g)) {
    const colour = COLOURS[match[2]];
    if (match[1] || match[3]) explicitQuantity = true;
    const quantity = Math.max(1, Math.min(20, Number(match[1] || match[3]) || 1));
    picks.set(colour, Math.max(picks.get(colour) || 0, quantity));
  }
  // "lấy 2 túi" không nêu màu: vẫn là xin nhiều túi.
  const loose = folded.match(/\b(\d{1,2})\s*(tui|goi|bich)\b/);
  return { picks, looseQuantity: loose ? Number(loose[1]) : 0, explicitQuantity: explicitQuantity || Boolean(loose) };
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
  const { picks, looseQuantity, explicitQuantity } = bagPicks(raw);
  const quantity = [...picks.values()].reduce((sum, value) => sum + value, 0);
  const chosen = trial?.stage === 'chosen' && trial.bag;
  const orderStep = chosen ? { template_id: 'ORDER_ADDRESS', Product_N1: trial.bag, No_A: '1' } : null;
  // Đã mua / hủy / khiếu nại: không phải trả lời lời mời — mô hình đọc (kèm gợi ý).
  // "đã lấy/đặt" so trên chữ CÒN DẤU: bỏ dấu thì "Dạ lấy túi xanh" (đồng ý) thành "da lay".
  if (NOT_OFFER.test(s) || /đã\s+(đặt|mua|nhận|lấy|chốt)/iu.test(raw)) return { delegate: true };
  // Khất ("để mình hỏi chồng đã", "để em xem lại", "suy nghĩ thêm"): không phải đồng ý, không đóng ưu đãi — mô hình đáp mềm.
  if (/\b(de (minh|em|e|chi|c|toi|m|mk) (hoi|xem|tinh|suy nghi|coi|nghi|can nhac)|hoi (chong|vo|ba xa|ong xa|nha|me|bo)|suy nghi (da|them|lai)|(xem|tinh|coi) (da|them|lai))\b/.test(s)) return { delegate: true };
  // Từ chối. "thôi" chỉ là từ chối khi không kèm túi/số lượng/lời đồng ý ("lấy 1 túi thôi" là chọn).
  const declines = DECLINE.test(s) || (DECLINE_THOI.test(s) && !picks.size && !looseQuantity && !ACCEPT.test(s.replace(/\bthoi\b/g, '')));
  if (declines && !phone) return { value: { template_id: 'TRIAL_DECLINED' }, patch: { stage: 'declined', endedAt: now } };
  // Câu hỏi (so sánh, ngọt không, bao nhiêu gam…) trả lời trước; nêu màu trong câu hỏi
  // chưa phải chọn. Câu hỏi giá / ship / khuyến mãi thì luồng này tự trả lời.
  // Câu hỏi: dấu "?", so sánh, hay kết bằng "không/ko/k" ("ship về Đà Nẵng bao lâu vậy" cũng là hỏi → mô hình).
  const asks = raw.includes('?') || COMPARE.test(s) || /\b(khong|ko|k|hong|hok|vay|ha)$/.test(s) || /\b(bao lau|may ngay|khi nao|o dau|the nao|ntn|lam sao|co (giao|ship) (duoc|dc))\b/.test(s);
  // Tôn trọng điều kiện loại trừ của từng luật (WEIGHT_EXPIRY bỏ khi có hỏi giá…) như rule-intent.
  const info = s.length <= 90 && infoRules.find(([rule, pattern, , exclude]) => !PRICE_RULES.has(rule) && pattern.test(s) && !(exclude && exclude(s, {})));
  if (info && !phone) return { value: { template_id: info[2], also: 'TRIAL_NEXT_STEP', values: { bags } } };
  if (asks && picks.size >= 2 && !phone) return { value: { template_id: 'BAG_COMPARISON', also: 'TRIAL_NEXT_STEP', values: { bags } } };
  if (FREESHIP.test(s)) return { value: { template_id: 'TRIAL_FREESHIP_INFO', values: { bags } } };
  // Đúng 2 túi lớn ("1 xanh 1 vàng", "2 túi xanh", "combo 2", "lấy combo 2 túi xanh"): rời luồng 1 túi nhưng giữ
  // ưu đãi combo 2 → tặng bát gáo dừa (renderOrder đọc context.promoBowl). Xét TRƯỚC câu hỏi giá/khuyến mãi:
  // chữ "combo" nằm trong DISCOUNT, mà mẫu mời ghi "Combo 2 Túi bất kỳ" nên khách trả lời đúng chữ đó là chọn,
  // không phải hỏi. "combo 2" không nêu màu vẫn là 2 túi. Từ 3 túi: đơn thường (bảng quà chung đã có bộ bát + muỗng).
  const total = quantity || looseQuantity || (/\bcombo\s*2\b/.test(s) ? 2 : 0);
  if (!asks && !PRICE.test(s) && (total === 2 || (picks.size === 2 && quantity === 2))) return { exit: 'combo2', patch: { stage: 'converted', combo2: true, endedAt: now, lockedUntil: Math.max(Number(trial?.until) || 0, now + 24 * HOUR) } };
  if (DISCOUNT.test(s) || PRICE.test(s)) return { value: { template_id: 'TRIAL_PRICE', values: { bags } } };
  if (picks.size >= 2 || quantity >= 2 || looseQuantity >= 2) return { exit: 'converted', patch: { stage: 'converted', endedAt: now } };
  if (picks.size === 1 && !asks) {
    const product = bagProduct([...picks.keys()][0]);
    if (!product) return { delegate: true };
    // Khách đã chọn combo 2 túi ("lấy 2 túi", "combo 2") rồi nêu một màu không kèm số ("xanh nha"): là vị
    // cho combo, không phải đổi về 1 túi — mô hình đọc giỏ/lịch sử. Nói rõ "1 túi xanh" mới là 1 túi.
    if (trial?.combo2 && !explicitQuantity) return { delegate: true };
    const patch = { stage: 'chosen', bag: product.name, lockedUntil: Math.max(Number(trial?.until) || 0, now + 24 * HOUR) };
    // Kèm SĐT / địa chỉ: mô hình đọc địa chỉ; giá vẫn là 1 túi miễn ship.
    if (phone || longText) return { delegate: true, patch };
    return { value: { template_id: 'ORDER_ADDRESS', Product_N1: product.name, No_A: '1' }, patch };
  }
  // SĐT (± địa chỉ) khi đã chọn túi: bước đơn (SĐT trơn thì bộ soạn đơn tự đọc); chưa
  // chọn túi mà đã gửi SĐT/địa chỉ: mô hình đọc, giữ SĐT cho bước sau.
  if (phone && chosen && raw.replace(/[\s.+()-]/g, '').replace(/^\D*/, '').length <= 13) return { value: orderStep };
  if (phone || (chosen && longText)) return { delegate: true };
  // Đồng ý / lời đáp ngắn ("ok", "dạ", emoji, "1"): mời chọn túi, hay bước đơn nếu đã chọn.
  const shortAck = /^[\s.…!?1👍❤️🥰😍]*$/u.test(raw) || /^(da|vang|ok|oke|oki|okie|okay|u|uh|um|ua|uk|ukm)( (a|ah|em|e|shop|chi|c|nha|nhe))*$/.test(s);
  // Đồng ý chỉ với câu ngắn (≤ 25 ký tự): "để mình hỏi chồng đã" (có "đã") không phải đồng ý.
  if (!asks && (shortAck || (s.length <= 25 && (ACCEPT.test(s) || looseQuantity === 1)))) {
    if (orderStep) return { value: orderStep };
    return { value: { template_id: trial?.accepted ? 'TRIAL_REMIND' : 'TRIAL_ACCEPT', values: { bags } }, patch: { accepted: true } };
  }
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
  if (id === 'FREESHIP_POLICY') return { template_id: 'TRIAL_FREESHIP_INFO', values: { bags: trialBagOptions() } };
  // Đã chọn combo 2 túi: hỏi vị cho combo (ASK_FLAVOR) là hợp lệ.
  if (trial?.combo2 && id === 'ASK_FLAVOR') return null;
  if (!banned(id) && !banned(also) && also !== 'FREESHIP_POLICY') return null;
  // Câu trả lời chính dùng được, chỉ ý phụ bị cấm (bảng giá, combo…): giữ câu chính, đổi ý phụ.
  if (!banned(id) && id) return { template_id: id, also: 'TRIAL_NEXT_STEP', values: { bags: trialBagOptions() } };
  if (trial?.stage === 'chosen' && trial.bag) return { template_id: 'ORDER_ADDRESS', Product_N1: trial.bag, No_A: '1' };
  return { template_id: 'TRIAL_PRICE', values: { bags: trialBagOptions() } };
}

/** Gợi ý cho mô hình khi phải nhờ mô hình (tin có địa chỉ, ảnh…). */
export function trialModelHint(trial = {}) {
  return `KHÁCH ĐANG GIỮ ƯU ĐÃI BÁM ĐUỔI${trial.bag ? ` (đã chọn ${trial.bag})` : trial.combo2 ? ' (đã chọn combo 2 túi, đang xin vị/SĐT/địa chỉ)' : ''}: 1 túi dùng thử MIỄN PHÍ VẬN CHUYỂN (giá túi, không cộng ship), hoặc combo 2 túi lớn được tặng thêm bộ bát gáo dừa. Không báo giá combo 3, không mời thêm sản phẩm khác.`;
}
