import { buildTemplatePrompt, isProductQuoteId, isShopCartText, maxAddressAsks, pickVariant, publicImageUrl, renderChatbotReply, sanitizeModelAnswer } from './chatbot-templates.mjs';
import { addressHint, chatTimeoutMs, inferAddress } from './processing/address-ai.mjs';
import { describeDeliveryAddress, houseNumbersOf, isUsableStreet, lostHouseNumbers, mergeAddressFragment, resolveAddress } from './processing/locations.mjs';
import { extractVietnamesePhone } from './processing/customer-info.mjs';
import { autoLabelEventsFor, foldVietnamese, isComplaint } from './processing/auto-label.mjs';
import { productHint, resolveConversationProduct } from './processing/product-detect.mjs';
import { buildCatalogPrompt } from './processing/pricing.mjs';
import { isBasketStep, isOrderStep, usablePendingOrder } from './processing/pending-order.mjs';
import { findProductBySku, getCatalogProducts, getGifts, isFreeShippingGift, matchProduct, parseGiftSwapChoice, parseShopCart } from './processing/catalog.mjs';
import { isLivestreamConversation, isLivestreamCustomer, isPageSystemNotice } from './conversation-orders.mjs';
// R13: LIVE_ONLY (danh sách hàng chỉ bán trên live) và FLAVOR_LIST (câu hỏi danh sách vị) dùng chung một bản của rule-intent.
import { CANCEL_ORDER, COMMENT_DISLIKE, core as ruleCore, DELIVERY_NOTE, FLAVOR_LIST, HOLD_DELIVERY, LIVE_FEEDBACK, LIVE_ONLY, ruleIntent, TROPICAL_MENTION } from './processing/rule-intent.mjs';
import { cleanAddressText, collectAddressBurst, isPaymentMessage, lookupPreviousAddress, stripPhone } from './processing/order-flow.mjs';
import { priceBasket } from './processing/pricing.mjs';
import { stickerInfo } from './stickers.mjs';
import { activeTrial, filterTrialReply, promoBowlActive, trialBagOptions, trialModelHint, trialStep } from './processing/trial-flow.mjs';
import { intentSafeTemplates, loadIntentModel, predictIntent } from './processing/intent-model.mjs';
import { decisionLabelOf, intentRowOf } from './processing/intent-features.mjs';
import { formatExamples, loadExampleBank, nearestExamples } from './processing/example-bank.mjs';
import { appendDecisionLog } from './processing/decision-log.mjs';
import { gateCheck } from './processing/llm-router.mjs';

// Mô hình tầng (processing/intent-cascade.mjs, đang viết): nạp động MỘT lần, thiếu tệp / lỗi nạp → null
// (engine chạy như không có). Test đưa mô hình giả qua dependencies.predictCascade (+ cascadeGroupOf).
let cascadeModulePromise = null;
function loadCascadeModule() {
  return (cascadeModulePromise ||= import('./processing/intent-cascade.mjs').catch(() => null));
}
/**
 * Nạp sẵn mô hình nhỏ + mô hình tầng (readFileSync + parse 2–3 MB mỗi tệp, ~50–60 ms chặn event loop) ngay sau khởi
 * động, thay vì ở tin khách đầu tiên (perf-analysis #12). Máy chủ gọi một lần trong callback listen; không gọi thì vẫn
 * nạp lười như cũ. Lỗi nạp không ném (engine chạy như không có mô hình). Trả { intent, cascade } đã nạp được hay chưa.
 */
export async function warmUpChatbotModels() {
  let intent = false;
  let cascade = false;
  try { intent = Boolean(loadIntentModel()); } catch (error) { console.warn(`Không nạp sẵn được mô hình nhỏ: ${error.message}`); }
  try {
    const cascadeModule = await loadCascadeModule();
    cascade = Boolean(typeof cascadeModule?.loadCascadeModel === 'function' && cascadeModule.loadCascadeModel());
  } catch (error) { console.warn(`Không nạp sẵn được mô hình tầng: ${error.message}`); }
  return { intent, cascade };
}

// Nhóm ý định mà mô hình tầng được tự trả lời khi 'on': ANSWER (tầng 1 bản mới) hay PRICE/INFO/SOCIAL (bản cũ);
// ORDER do máy trạng thái slot của engine, SUPPORT/OTHER về LLM — không bao giờ tự trả lời.
export const cascadeAutoGroups = new Set(['ANSWER', 'PRICE', 'INFO', 'SOCIAL']);
// Ngưỡng nhóm (tầng 1) cố định; ngưỡng mẫu trong nhóm lấy từ settings.cascadeThreshold.
export const CASCADE_GROUP_THRESHOLD = 0.85;
// R13 (models 3.F): ngưỡng mẫu trong nhóm khi Cài đặt không ghi cascadeThreshold (trước là 0,8). Không đổi chế độ shadow.
export const CASCADE_TEMPLATE_THRESHOLD = 0.85;
// Mẫu tầng KHÔNG được tự trả lời khi khách đã có đơn gần đây (câu trả lời chung chung sai ngữ cảnh đơn).
const cascadeNoRecentOrderTemplates = new Set(['SHIPPING_POLICY', 'WELCOME', 'DELIVERY_DELAY']);
// Mẫu loại hẳn khỏi tự trả lời của tầng (WELCOME hay bị chọn cho tin có màu/số túi).
const cascadeExcludedTemplates = new Set(['WELCOME']);

/** Hash ổn định (FNV-1a 32 bit) của mã hội thoại → 0..99, để chia canary. */
export function canaryBucket(id) {
  let hash = 0x811c9dc5;
  for (const char of String(id || '')) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash % 100;
}

// Mẫu mới vòng 8 (26–28/09): agent luật đang thêm vào seed; cài đặt chưa có thì
// dùng lời dự phòng này để bot không chuyển người / im vì "mẫu lạ". Mẫu bị chủ
// shop để trống ('') trong Cài đặt vẫn là tắt (không thay bằng dự phòng).
export const fallbackTemplates = Object.freeze({
  WAITING_STAFF: 'Dạ em đã chuyển tin của {title} cho bạn phụ trách rồi ạ, bạn ấy sẽ kiểm tra và nhắn lại {title} ngay trong tin này. {Title} chờ em ít phút nha ạ 💛',
  PAYMENT_RECEIVED_CHECK: 'Dạ em đã nhận thông tin chuyển khoản của {title} ạ. Em chuyển bạn phụ trách kiểm tra giao dịch và lên đơn gửi {title} ngay, {title} chờ em ít phút nha ạ 💛',
  COMMENT_PUBLIC_THANKS: 'Dạ em cảm ơn {title} nhiều ạ 💛 Chúc {title} ăn ngon miệng và thật nhiều năng lượng nha ạ 🌾',
  ORDER_POSTPONED: 'Dạ em đã ghi nhận rồi ạ, khi nào {title} cần thì nhắn em tên túi và số lượng kèm SĐT, địa chỉ, em lên đơn liền cho mình nha ạ 🌾',
  NO_VARIANT: 'Dạ hiện nhà em chưa có vị {ingredient} ạ. Ba vị đang bán là Túi Xanh nguyên bản, Túi Vàng nhiều hạt và Túi Nâu cacao, {title} ưng loại nào nhắn em nha ạ 💛',
  WHOLESALE_RECEIVED: 'Dạ em đã ghi nhận nhu cầu lấy sỉ/CTV của {title} ạ. Bạn phụ trách kinh doanh sẽ liên hệ lại {title} sớm trong tin này nha ạ 💛',
  ORDER_ADDRESS_OLD_ASK_PHONE: 'Dạ em chưa thấy địa chỉ cũ của {title} trong hội thoại này ạ. {Title} cho em xin số điện thoại đã đặt lần trước để em tra và gửi đúng địa chỉ đó nha ạ 💛',
  ORDER_INFO_ASK_FLAVOR: 'Dạ em đã ghi nhận SĐT/địa chỉ của {title} rồi ạ. {Title} cho em biết mình lấy loại nào (Túi Xanh nguyên bản / Túi Vàng nhiều hạt / Túi Nâu cacao) và số lượng để em lên đơn liền nha ạ 🌾',
  ASK_FLAVOR_NGUYENBAN: 'Dạ Túi Xanh nguyên bản là vị cơ bản nhất, không thêm đường, hạt và yến mạch giòn tự nhiên ạ. {Title} lấy Túi Xanh hay muốn em tư vấn thêm Túi Vàng nhiều hạt / Túi Nâu cacao ạ?',
  RECOMMEND_BEGINNER: 'Dạ mới ăn lần đầu thì {title} thử Túi Xanh nguyên bản ạ, vị dễ ăn nhất, không thêm đường 🌾 {Title} lấy 1 túi dùng thử hay combo 2 túi để được miễn ship ạ?',
  // Vòng 11: khách chỉ gửi SĐT (chưa địa chỉ) khi chưa có giỏ; câu nhắc ngắn giỏ đang giữ (khách hỏi chuyện
  // khác lúc bot đang xin SĐT/địa chỉ) — cài đặt thiếu mẫu thì bot không im.
  ORDER_PHONE_ASK_FLAVOR: 'Dạ em đã nhận SĐT của {title} rồi ạ 💛 {Title} lấy Túi Xanh nguyên bản 450g, Túi Vàng nhiều hạt 350g hay Túi Nâu cacao 350g, mỗi loại mấy túi, kèm địa chỉ nhận hàng đầy đủ để em lên đơn liền cho mình nha 🌾',
  ORDER_ADDRESS_REMIND: 'Dạ em vẫn đang giữ đơn {cart} – tổng {total} cho {title} ạ 🌾 {Title} gửi giúp em {missing} là em lên đơn liền nha.',
  CONFIRM_YES: 'Dạ vâng ạ 💛',
  COMBO3_FLAVOR: 'Dạ combo 3 túi {title} chọn vị tùy ý ạ (Xanh / Vàng / Nâu, được lấy trùng vị). {Title} nhắn em 3 túi vị gì để em lên đơn nha ạ 🌾',
  // ===== Vòng 12 (r12): mẫu mới — cài đặt production chưa có thì dùng lời này (script apply-templates.mjs thêm vào). =====
  // R14 (chủ shop 03/10): không hứa quà thay — ghi chú đơn, xin bộ phận phụ trách duyệt, nhắn khách sau.
  GIFT_SWAP: 'Dạ {title} muốn đổi quà thì em ghi chú vào đơn hàng của mình và xin bộ phận phụ trách cho phép đổi sang phần quà khác ạ 💛 Có kết quả em nhắn lại {title} ngay nha.',
  ORDER_CHANGE_STAFF: 'Dạ em đã ghi nhận {title} muốn đổi đơn thành: {cart} ạ. Để chắc đơn được sửa đúng trước khi kho đóng gói, em báo bạn phụ trách sửa lại và nhắn {title} ngay trong tin này nha ạ 💛',
  ORDER_CANCEL_STAFF: 'Dạ em đã ghi nhận {title} muốn hủy đơn ạ. Em báo bạn phụ trách kiểm tra với kho và xác nhận hủy cho {title} ngay trong tin này nha ạ 💛',
  ORDER_HOLD_STAFF: 'Dạ em đã ghi nhận {title} muốn tạm khoan giao đơn ạ. Em báo kho giữ đơn lại và bạn phụ trách sẽ nhắn {title} để hẹn ngày giao phù hợp nha ạ 💛',
  STAFF_ONLY_PRODUCT: 'Dạ {product} bên em do bạn phụ trách tư vấn và lên đơn riêng ạ. Em đã ghi nhận và báo bạn ấy nhắn {title} ngay trong tin này nha ạ 💛',
  RECEIVED_CHECK: 'Dạ {title} nhận hàng đúng loại và đủ quà chưa ạ? Nếu có gì chưa đúng {title} nhắn em kèm hình giúp em, em xử lý ngay cho mình nha 💛',
  PRICE_COUNT: 'Dạ {count} túi ({kind}) giá {total}[?ship] + phí ship {ship}[/?][?free], miễn phí vận chuyển[/?][?gift], tặng {gift}[/?] ạ 🌾 {Title} lấy {count} túi vị nào để em lên đơn liền cho mình nha?',
  PRICE_ONE_BAG: 'Dạ 1 {product} giá {price}[?ship] + phí ship {ship}[/?] = {total} ạ. Em lên đơn 1 túi cho {title} nha? (Lấy 2 túi chỉ {two_total}, miễn phí vận chuyển ạ 🌾)',
  PRICE_COMPARE: 'Dạ mỗi kênh có chương trình và voucher riêng nên giá hiển thị có lúc khác nhau ạ (giá trên sàn thường đã trừ voucher/trợ giá của sàn). Mua tại Fanpage {title} được tư vấn trực tiếp, combo 2 túi trở lên miễn phí vận chuyển và có quà tặng riêng ạ 🌾 {Title} lấy 2 túi vị nào để em lên đơn nha?',
  ASK_REORDER: 'Dạ lần này {title} muốn lấy Túi Xanh hay vẫn {previous}, mấy túi để em lên đơn liền cho mình ạ? 🌾',
  TROPICAL_CONFIRM: 'Dạ có phải {title} hỏi Granola Tropical vị Cacao 300g (túi xanh nhạt, có xoài và dâu sấy) không ạ? Hay {title} muốn Túi Xanh nguyên bản 450g (túi xanh lá) ạ?',
  WEIGHT_GAIN: 'Dạ muốn tăng cân {title} dùng granola cùng sữa tươi hoặc sữa chua có đường, thêm trái cây (chuối, xoài…) và ăn thành bữa phụ mỗi ngày nha ạ; Túi Vàng nhiều hạt cho nhiều năng lượng hơn. Granola là thực phẩm thông thường, không phải thực phẩm chức năng nên hiệu quả còn tùy chế độ ăn và cơ địa ạ.',
  HEALTH_DIABETES: 'Dạ granola bên em không thêm đường, nhưng có trái cây sấy (đường tự nhiên) và tinh bột từ yến mạch, gạo lứt ạ. Người tiểu đường hay đường huyết cao {title} nên hỏi bác sĩ về khẩu phần trước; nếu dùng thì ăn lượng nhỏ (2–3 muỗng), kèm sữa chua không đường. Đây là thực phẩm thông thường, không phải thực phẩm chức năng nên không có tác dụng điều trị ạ.',
  VEGAN_INFO: 'Dạ người ăn chay dùng được ạ: granola bên em 100% từ thực vật (yến mạch, gạo lứt, các loại hạt, trái cây sấy), vị ngọt từ mật thốt nốt ạ.',
  BENEFITS: 'Dạ granola là bữa sáng/bữa phụ tiện lợi: yến mạch, gạo lứt, hạt và trái cây sấy cho nhiều chất xơ, năng lượng và no lâu; không thêm đường, không chiên dầu ạ. Đây là thực phẩm thông thường, không phải thực phẩm chức năng nên không có công dụng chữa bệnh ạ.',
  PRODUCTION_PLACE: 'Dạ sản phẩm được sản xuất tại xưởng của Giọt Nắng: 52 Đường An Phú Đông 21, P. An Phú Đông, TP.HCM ạ. Hàng sản xuất trong nước, có hồ sơ công bố, ngày sản xuất và hạn dùng in trên bao bì ạ.',
  GIFT_POLICY_LIVE: 'Dạ khách xem live lấy 2 túi bất kỳ chỉ 298.000đ, miễn phí vận chuyển và được tặng Quạt + Bát gáo dừa ạ 🎁 {Title} lấy 2 túi vị nào để em lên đơn liền nha?',
  GIFT_POLICY_PROMO: 'Dạ trong thời gian ưu đãi của {title}, combo 2 túi được miễn phí vận chuyển và tặng 1 bát gáo dừa ạ 🎁 Từ 3 túi tặng bộ bát + muỗng dừa. {Title} lấy combo 2 túi vị nào để em lên đơn nha?',
  GIFT_POLICY_UPSELL3: 'Dạ bộ bát + muỗng dừa bên em tặng cho đơn từ 3 túi ạ (3 túi {total3}, miễn phí vận chuyển) 🎁 Đơn 2 túi hiện chưa kèm quà ạ. {Title} lấy thêm 1 túi nữa để nhận bộ bát + muỗng không ạ?',
  ASK_TWO_BAGS: 'Dạ bảng giá em gửi ngay ở trên ạ 🌾 {Title} lấy 2 túi vị nào (Xanh / Vàng / Nâu) để em lên đơn miễn phí vận chuyển cho mình nha?',
  IMAGE_WITH_PHONE: 'Dạ em đã nhận hình và SĐT của {title} rồi ạ 💛 {Title} lấy loại trong hình mấy túi ạ? Em lên đơn liền cho mình nha 🌾',
  COMMENT_PUBLIC_STAFF: 'Dạ em đã ghi nhận rồi ạ, bạn phụ trách sẽ nhắn tin cho mình ngay nha 💛###Dạ {name} ơi, em đã ghi nhận, bạn phụ trách sẽ nhắn tin cho mình ngay ạ 💛',
  COMMENT_PUBLIC_FEEDBACK: 'Dạ em cảm ơn góp ý của mình ạ 💛 Em báo bạn dẫn live chỉnh lại ngay nha.',
  // fix-bot C2 (01/10): đơn landing/POS cùng SĐT nhưng không thuộc hội thoại — hỏi "đặt thêm?" mà KHÔNG kể món/giờ/tổng
  // tiền của đơn đó (có thể là đơn của người khác). Mã gửi đi vẫn là ORDER_EXISTING_CONFIRM (luồng "đúng"/"không").
  ORDER_EXISTING_CONFIRM_PHONE: 'Dạ {title} ơi, em thấy số điện thoại này đã có một đơn đặt gần đây ạ 🌾 Mình muốn đặt THÊM một đơn mới gồm {cart} nữa đúng không ạ? {Title} nhắn "đúng" giúp em là em lên đơn liền; còn nếu là đơn cũ thì {title} cứ nhắn, bạn phụ trách sẽ kiểm tra cho mình nha ạ.',
  // fix-review (02/10): cài đặt thiếu mẫu này thì nhánh "không" của đơn ngoài hội thoại (C2) rơi về ORDER_STATUS và
  // kể chi tiết đơn của người khác; tra đơn theo SĐT thì bot im. Lời dự phòng ngắn, không kể chi tiết đơn.
  ORDER_STATUS_CHECKING: 'Dạ em đang kiểm tra lại đơn giúp {title}, bạn phụ trách sẽ nhắn lại ngay ạ 💛',
  // ===== R13 (02/10): mẫu engine tự chọn — cài đặt chưa có thì dùng lời này; mô hình không được gọi tên. =====
  // Giỏ Facebook Shop có mã bot không đọc được (mã lạ / sản phẩm đã tắt): ghi nhận + thẻ, KHÔNG để mô hình đoán món.
  SHOP_CART_UNKNOWN: 'Dạ em đã nhận giỏ hàng {title} chọn trên Facebook Shop rồi ạ 💛 Em báo bạn phụ trách kiểm tra sản phẩm và lên đơn, bạn ấy nhắn {title} ngay trong tin này nha ạ.',
  // Giỏ Shop có món nhân viên lên đơn (yến mạch…): ghi nhận đúng tên món, xin SĐT/địa chỉ, thẻ — không mời "2 túi granola".
  SHOP_CART_STAFF: 'Dạ em đã ghi nhận {title} chọn {product} trên Facebook Shop ạ 💛 {Title} cho em xin số điện thoại và địa chỉ nhận hàng, bạn phụ trách lên đơn và xác nhận với {title} ngay trong tin này nha ạ 🌾',
  // Giỏ Shop vừa tới, đơn chưa thấy trên POS: báo đã nhận giỏ rồi mới chờ kiểm đơn (khách không ngồi chờ 60 giây im lặng).
  SHOP_CART_ACK: 'Dạ em đã nhận giỏ hàng {cart} của {title} rồi ạ 💛 {Title} chờ em ít phút, em kiểm tra đơn rồi nhắn mình ngay nha.',
  // Khách chọn vị cho quà thay (sau GIFT_SWAP): ghi nhận, không hỏi lại "vị nào".
  GIFT_SWAP_NOTED: 'Dạ em đã ghi nhận thay quà của {title} bằng {gift} (không trừ tiền) ạ 💛',
  // R14 (chủ shop 03/10): bot định im vì câu trả lời trùng tin vừa gửi mà khách hỏi ý mới → báo bạn phụ trách trả lời
  // (giờ hành chính 8h–17h giờ VN; ngoài giờ hẹn 8h sáng) + thẻ cần người, tối đa 1 lần mỗi 2 giờ mỗi hội thoại.
  STAFF_WAIT_OPEN: 'Dạ em đã ghi nhận câu hỏi của {title} rồi ạ 💛 Em chuyển bạn phụ trách trả lời {title} ngay trong ít phút, {title} chờ em chút nha ạ.',
  STAFF_WAIT_CLOSED: 'Dạ em đã ghi nhận câu hỏi của {title} rồi ạ 💛 Bạn phụ trách làm việc giờ hành chính từ 8h đến 17h, sẽ trả lời {title} từ 8h {when} nha ạ.'
});

// R14: giờ hành chính của bạn phụ trách (giờ Việt Nam): 8h–17h. Ngoài giờ: trước 8h → "sáng nay", sau 17h → "sáng mai".
export const STAFF_HOURS = Object.freeze({ open: 8, close: 17 });
export const STAFF_WAIT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export function staffWaitTemplate(now = Date.now()) {
  const hour = new Date(Number(now) + 7 * 60 * 60 * 1000).getUTCHours();
  if (hour >= STAFF_HOURS.open && hour < STAFF_HOURS.close) return { templateId: 'STAFF_WAIT_OPEN', when: '' };
  return { templateId: 'STAFF_WAIT_CLOSED', when: hour < STAFF_HOURS.open ? 'sáng nay' : 'sáng mai' };
}

// R13: câu hỏi danh sách vị ("có mấy loại", cả lỗi gõ "Có mays lọi") — FLAVOR_LIST của rule-intent (so trên chuỗi đã
// chuẩn hoá bằng core()); thêm mẫu gọn không neo đầu/cuối cho câu có lời đệm ("co may loai vay shop").
const flavourListLoose = /\b(?:may|mays|bao nhieu|nhung|cac) (?:loai|loi|laoi|loaj|vi|mau)\b/;
export function asksFlavourList(text) {
  const normalized = ruleCore(String(text || ''));
  return FLAVOR_LIST.test(normalized) || flavourListLoose.test(normalized);
}

// R13: hàng chỉ bán trên live — đúng regex LIVE_ONLY của rule-intent.mjs (một nguồn).
const liveOnlyProductPattern = LIVE_ONLY;

/** Bộ mẫu để soạn câu: mẫu trong Cài đặt, mẫu mới chưa có thì lấy lời dự phòng. */
export function withFallbackTemplates(templates) {
  return { ...fallbackTemplates, ...(templates && typeof templates === 'object' ? templates : {}) };
}

// Giỏ Facebook Shop (attachment cart_order) mang SKU: một SKU sản phẩm → bảng
// giá sản phẩm đó; SKU combo của Shop ("CB2-XANH-Z450" = 2 Túi Xanh,
// "CB-VANGG+NAU" = Vàng + Nâu) → xin SĐT/địa chỉ với đúng giỏ. SKU lạ → để model.
//
// R13 (02/10): tách mã bằng parseShopCart (catalog.mjs) — một nơi đọc mã combo, không đoán món:
// - mã lạ / sản phẩm đã tắt (`unknown`) → mẫu ghi nhận SHOP_CART_UNKNOWN + thẻ Cần người xử lý (`shopCartStaff: 'unknown'`),
//   KHÔNG trả null cho mô hình đoán (ca thật: CB10-MIX bị mô hình đọc thành "Combo 10 gói Cam");
// - yến mạch (reason 'oat', nhân viên lên đơn) → SHOP_CART_STAFF: ghi nhận đúng tên món + xin SĐT/địa chỉ + thẻ, không mời
//   "2 túi granola";
// - giỏ đọc được → bước xin SĐT/địa chỉ với `fromCart: true` trong ngữ cảnh soạn (bộ soạn đơn KHÔNG chỉnh số lượng theo
//   chữ tự sinh "…(CB-VANGG+XANH)" — ca thật: Vàng + Xanh 298k bị đọc thành 1 Túi Xanh 189k).
export function cartQuickReply(cart, templates = {}, context = {}) {
  const lines = (Array.isArray(cart) ? cart : []).filter(line => line && (line.sku || line.name));
  if (!lines.length) return null;
  const parsed = parseShopCart(lines.map(line => ({ sku: line.sku, quantity: line.quantity, name: line.name }))) || {};
  const reasons = Array.isArray(parsed.reasons) ? parsed.reasons : [];
  const unknown = parsed.unknown === true || reasons.includes('unknown') || (Array.isArray(parsed.unknownSkus) && parsed.unknownSkus.length > 0);
  const items = (Array.isArray(parsed.items) ? parsed.items : []).map(item => ({ product: item.name, quantity: Math.max(1, Number(item.quantity) || 1) })).filter(item => item.product);
  const staffReply = (templateId, values, reason) => {
    // Mẫu mới chưa có trong Cài đặt → lời dự phòng của engine; chủ shop để trống ('' = tắt) → mẫu chuyển nhân viên
    // (bộ soạn trả bảng giá chung cho mã mẫu trống — không được gửi bảng giá cho giỏ bot không đọc được).
    const all = withFallbackTemplates(templates);
    const rendered = renderChatbotReply({ template_id: templateId, values }, all, context);
    const safe = rendered.templateId === templateId ? rendered : renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, all, context);
    return { ...safe, attention: true, shopCartStaff: reason };
  };
  if (unknown) return staffReply('SHOP_CART_UNKNOWN', {}, 'unknown');
  if (parsed.needsStaff || reasons.length) {
    const product = [...(Array.isArray(parsed.labels) ? parsed.labels : []), ...items.map(item => `${item.quantity} ${item.product}`)].filter(Boolean).join(' + ') || 'sản phẩm';
    return staffReply('SHOP_CART_STAFF', { product }, reasons[0] || 'staff');
  }
  if (!items.length || !templates.PRICE_QUOTE) return null;
  // Khách bấm "Mua" là đã chọn: đi thẳng bước xin SĐT/địa chỉ (kèm gợi ý 2 túi
  // khi chỉ 1 túi), không gửi bảng giá rồi hỏi "cần thêm thông tin nào" —
  // giỏ 1 SKU trước đây chỉ chốt được 22%.
  const slots = ['Product_N1', 'No_A', 'Product_N2', 'No_B', 'Product_N3', 'No_C'];
  const value = { template_id: 'ORDER_ADDRESS' };
  items.slice(0, 3).forEach((item, index) => { value[slots[index * 2]] = item.product; value[slots[index * 2 + 1]] = String(item.quantity); });
  // `fromCart`: giỏ lấy NGUYÊN từ mã Shop. Chữ tin giỏ (tự sinh, chứa mã SKU) và tin cũ của khách không được dùng để
  // chỉnh số lượng/món — bỏ khỏi ngữ cảnh soạn của riêng lượt này.
  const reply = renderChatbotReply(value, templates, { ...context, fromCart: true, messageText: '', recentCustomerTexts: [] });
  // Vòng 12 (B2 #9): 12/12 khách Shop bỏ đi sau chuỗi tin xin SĐT + mời 2 túi → gộp chữ thành MỘT tin ngắn (ảnh giữ nguyên).
  const texts = reply.messages || [];
  if (texts.length < 2) return reply;
  const joined = texts.join('\n\n');
  return { ...reply, messages: [joined], parts: [{ type: 'text', text: joined }, ...(reply.images || []).map(url => ({ type: 'image', url }))] };
}
/**
 * Giỏ khách ghi thẳng trong bình luận: "C 2 túi vàng", "túi vàng với túi xanh lá
 * cây", "2 xanh 1 nâu". Chỉ ba túi lớn (Xanh/Vàng/Nâu; "xanh dương" là hàng
 * live khác); cần ý mua (lấy/mua/chốt/cho em…, có số lượng, hay từ hai màu).
 */
export function commentBasket(text) {
  // "nấu" (sữa hạt nấu…) bỏ dấu cũng thành "nau": giữ khác "nâu" trước khi bỏ dấu.
  // "nấu" (sữa hạt nấu…) bỏ dấu cũng thành "nau": giữ khác "nâu" trước khi bỏ dấu.
  // "sô cô la / socola / chocolate" là túi Nâu cacao.
  // Vòng 12: Granola Tropical (GRA-MINT-Z300) là sản phẩm danh mục — "xanh mint/min/bạc hà/biển/ngọc/da trời/dương",
  // "tropical", "túi dâu", "dâu tây" → vị "mint". "xanh nhạt" mơ hồ (Tropical hay Túi Xanh lá) → không tự lập giỏ.
  // R13 (bình luận F5, inbox2 B1): số lượng viết bằng chữ ngay trước đơn vị/màu ("Hai túi hạt vàng", "ba xanh") đọc như chữ số.
  // "bà"/"ba" đứng trước từ khác ("bà lấy túi vàng") không đổi. "một" không đổi: "bao nhiêu một gói" là hỏi đơn giá, và
  // một túi vốn đã là số lượng mặc định.
  const numberWords = { hai: '2', ba: '3', bon: '4', nam: '5' };
  const folded = foldVietnamese(String(text || '').replace(/nấu/giu, 'nauu')).replace(/\bs[oô] ?c[oô] ?la\b|\bsocola\b|\bchocolate\b/g, 'cacao')
    .replace(/\bxanh (?:mint|min|bac ha|bien|ngoc|da troi|duong)\b|\btropical\b|\b(?:tui|goi|loai|vi) (?:co )?dau(?: tay)?\b|\bdau tay\b|\bxoai dau\b/g, 'mint').replace(/\s+/g, ' ')
    .replace(/\b(hai|ba|bon|nam) (?=(?:tui|goi|bich|hop|xanh|vang|nau|cacao|mint)\b)/g, (_match, word) => `${numberWords[word]} `);
  if (/\bxanh nhat\b/.test(folded) || (/\bdâu\b/iu.test(String(text || '')) && !/\bmint\b/.test(folded))) return [];
  // "2 hộp xanh", "hộp 10 gói nâu", "1 hộp": Combo 10 gói (màu ghi kèm; không ghi thì Mix).
  const boxed = /\bhop\b/.test(folded) && !/\b(tui|bich)\b/.test(folded);
  const cleaned = folded.replace(/\bdau xanh\b/g, ' ').replace(/\bhop (?:10|muoi) goi(?: nho)?\b/g, 'hop');
  const counts = new Map();
  // Khách viết một kiểu cho cả câu: số TRƯỚC màu ("2 xanh 1 vàng", "2 túi vàng")
  // hay số SAU màu ("vàng 2 nâu 1", "xanh lá x2"). Đọc lẫn hai kiểu thì "1 xanh
  // 2 nâu" gán nhầm số 2 cho xanh.
  const firstColour = cleaned.search(/(?<![a-z])(xanh|vang|nau|cacao|mint)(?![a-z])/);
  const firstNumber = cleaned.search(/(?<!\d)\d{1,2}(?!\d)/);
  const numberFirst = firstNumber >= 0 && firstNumber < firstColour;
  const pattern = numberFirst
    // R13: chữ đệm giữa số/đơn vị và màu ("2 túi hạt vàng", "2 túi loại xanh", "1 túi vị nâu") không làm mất số lượng.
    ? /(?:(?<!\d)(\d{1,2})\s*(?:tui|goi|bich)?\s*)?(?:(?:tui|mau|hat|loai|vi|granola)\s+){0,2}(?<![a-z])(xanh|vang|nau|cacao|mint)(?![a-z])/g
    : /(?<![a-z])(xanh|vang|nau|cacao|mint)(?![a-z])(?:\s*la(?:\s*cay)?)?(?:\s*x?\s*(\d{1,2})(?!\d|\s*(?:g|gr|gram|k)\b))?/g;
  for (const match of cleaned.matchAll(pattern)) {
    const [colourText, quantityText] = numberFirst ? [match[2], match[1]] : [match[1], match[2]];
    const colour = colourText === 'cacao' ? 'nau' : colourText;
    counts.set(colour, (counts.get(colour) || 0) + (Number(quantityText) || 1));
  }
  // Hộp 10 gói: "2 hộp xanh" → Combo 10 gói Xanh x2; "hộp mix" / "1 hộp" → Combo 10 gói Mix.
  if (boxed) {
    const boxCount = Number(cleaned.match(/(?<!\d)(\d{1,2})\s*hop\b/)?.[1] || cleaned.match(/\bhop\b[^\d]{0,12}(?<!\d)(\d{1,2})(?!\d|\s*(?:goi|g|gr|gram|k)\b)/)?.[1]) || 0;
    const colourOfBox = counts.size === 1 ? [...counts.keys()][0] : (/\bmix\b/.test(cleaned) || !counts.size ? 'mix' : '');
    if (!colourOfBox) return [];
    const wantsBox = boxCount > 0 || /\b(lay|mua|chot|dat|gui|ship|cho (em|minh|chi|c|e|toi|tui|anh|a))\b/.test(folded);
    const box = getCatalogProducts().find(item => item.active !== false && /^cb10-/i.test(item.sku || '') && String(item.sku || '').toLowerCase().includes(`-${colourOfBox}`));
    return wantsBox && box ? [{ product: box.name, quantity: boxCount || (counts.size === 1 ? [...counts.values()][0] : 1) }] : [];
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

/**
 * R13 (bình luận F8): bình luận ĐẶT HÀNG có món mà commentBasket không đọc được — "1 tui nau 1 yen mach" (yến mạch),
 * "1 xanh, 1 cam" (gói Cam chỉ có ở combo gói nhỏ), "Tui xanh va 10goi" (hộp 10 gói kèm túi lớn). Trước đây món lạ rơi
 * lặng lẽ (giỏ chỉ còn món đọc được, hay cả câu về mô hình đoán). Trả true → engine ghi nhận nguyên văn
 * (ORDER_CUSTOM_BASKET) + thẻ Cần người xử lý, không tự dựng giỏ thiếu món.
 * Phải có ý đặt (số lượng + món, hay "lấy/mua/đặt/chốt") VÀ ít nhất một món lạ đứng cạnh món/số lượng.
 */
export function commentBasketUnknown(text) {
  const folded = foldVietnamese(String(text || '').replace(/nấu/giu, 'nauu')).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!folded || folded.length > 120) return false;
  const colour = '(?:xanh|vang|nau|cacao|mint)';
  const count = '(?:\\d{1,2}|mot|hai|ba|bon|nam)';
  const unit = '(?:tui|goi|bich|hop)';
  // Món lạ: yến mạch, màu "cam", bột/nghệ, siêu hạt.
  const odd = '(?:yen mach|cam|nghe|bot ngu coc|sieu hat)';
  const oddCounted = new RegExp(`\\b${count} ?(?:${unit} )?${odd}\\b`).test(folded) && !/\bcam on\b/.test(folded);
  const oddUnit = new RegExp(`\\b${unit} ${odd}\\b`).test(folded) && !/\bcam on\b/.test(folded);
  // Hộp/combo 10 gói đi KÈM túi lớn trong cùng bình luận ("Tui xanh va 10goi").
  const tenPack = /\b10 ?goi\b|\bhop 10\b|\bcombo 10\b/.test(folded);
  const bigBag = new RegExp(`\\b(?:tui|bich) ${colour}\\b|\\b${count} ?(?:tui |bich )?${colour}\\b`).test(folded);
  const named = new RegExp(`\\b${colour}\\b|\\b${unit}\\b`).test(folded);
  const ordering = new RegExp(`\\b${count} ?(?:${unit} )?(?:${colour}|${odd})\\b|\\b(?:lay|mua|dat|chot|gui|ship|cho (?:em|minh|chi|c|e|toi|tui|anh|a))\\b`).test(folded);
  // Túi lớn + hộp 10 gói trong cùng bình luận là giỏ ghép bot không tự tính (trừ câu hỏi so sánh "… khác gì nhau").
  if (tenPack && bigBag && !/\b(khac|so voi|hay la|hoac)\b/.test(folded)) return true;
  if (!ordering || !named) return false;
  return oddCounted || oddUnit;
}

/** Vòng 12: bình luận đặt hàng / hỏi giá (giỏ, SĐT, giá, mua/lấy, ib) — cần ít nhất một lời công khai. */
export function isOrderComment(text) {
  const folded = foldVietnamese(String(text || ''));
  return commentBasket(text).length > 0 || Boolean(extractVietnamesePhone(String(text || '')))
    || /\b(gia|bn|bao nhieu|bnhiu|mua|lay|dat|chot|giam|tui|bich|combo|ib|inbox|ship)\b/.test(folded);
}

/** Vòng 12 (B4 #18): bình luận chỉ tag bạn bè / chỉ là tên người (không chữ nào khác) → không trả lời. */
export function isTagOnlyComment(message) {
  const text = String(message?.text || '').trim();
  if (!text) return false;
  const tags = Array.isArray(message?.messageTags) ? message.messageTags : Array.isArray(message?.message_tags) ? message.message_tags : [];
  let rest = text;
  for (const tag of tags) if (tag?.name) rest = rest.split(String(tag.name)).join(' ');
  rest = rest.replace(/@\S+/g, ' ').replace(/[\s.,!…]+/g, ' ').trim();
  if (tags.length && !rest) return true;
  // Chỉ 2–4 chữ viết hoa đầu (tên người, "Nguyễn Thị Lan"), không chữ thường nào khác, không số.
  if (tags.length || !/^(?:\p{Lu}[\p{Ll}]*\s+){1,3}\p{Lu}[\p{Ll}]*$/u.test(rest) || /\d/.test(rest)) return false;
  // R13 (bình luận F9): danh sách "không phải tên" trước đây so trên chữ BỎ DẤU nên tên có Anh / Chi / Minh / Em / Gia /
  // Tuyết / Lâm / Nhã ("Nguyễn Minh Anh", "Trần Gia Hân", "Lê Ánh Tuyết") bị coi là câu nói → bot trả lời bình luận tag
  // bạn. Nay so trên chữ CÒN DẤU ("mình", "chị", "giá", "tuyệt", "lắm" là lời nói; "Minh", "Chi", "Gia", "Tuyết", "Lâm"
  // là tên); chữ không dấu chỉ loại những từ không thể là tên (ib, shop, xin, mua, tui, goi, ko…).
  const words = rest.normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.some(word => tagNotNameWords.has(word))) return false;
  // Toàn đại từ xưng hô ("Anh Em", "Chị Em") không phải tên.
  return !words.every(word => ['anh', 'em', 'chi', 'chị'].includes(word));
}

// Từ (viết thường, CÒN DẤU hay kiểu gõ không dấu) không thể là một phần tên người trong bình luận viết hoa đầu chữ.
const tagNotNameWords = new Set([
  'giá', 'ib', 'inbox', 'ok', 'oke', 'okie', 'shop', 'cảm', 'ơn', 'on', 'ngon', 'cho', 'xin', 'mua', 'lấy', 'lay', 'gửi', 'gui', 'ship', 'túi', 'tui', 'gói', 'goi',
  'có', 'không', 'khong', 'ko', 'k', 'nhé', 'nhe', 'nha', 'nhá', 'dạ', 'vâng', 'tuyệt', 'vời', 'voi', 'đẹp', 'dep', 'quá', 'qua', 'thích', 'thich', 'hay', 'rồi', 'roi',
  'ơi', 'oi', 'bạn', 'giọt', 'giot', 'nắng', 'granola', 'tốt', 'tot', 'thật', 'lắm', 'làm', 'được', 'duoc', 'dc', 'xanh', 'vàng', 'nâu', 'nau', 'mình', 'chị',
  'bn', 'bao', 'nhiêu', 'nhieu', 'đi', 'ạ', 'combo', 'live', 'sao', 'nào', 'gì', 'vậy'
]);

import { getVertexAccessToken, vertexProjectId } from './vertex-auth.mjs';
import { assertPublicHost } from './network-guard.mjs';
import { normalizeWarningPhone, posConfig, posConfigured, posRequest } from './phone-warnings.mjs';
import { INCOMPLETE_LABEL, readLandingStore } from './landing-orders.mjs';

// ===== Đơn ngoài hội thoại (landing / nhân viên lên trên POS) cùng SĐT =====
// Chủ shop 28/09: 10 ca trong 7 ngày bot lên đơn trùng với đơn khách đã đặt qua landing hay
// nhân viên lên trên POS (Văn Lý: landing 15:20, bot 15:24; Nguyễn Trang: NV 20:47, bot 20:50).
// ORDER_EXISTING_CONFIRM trước đây chỉ xét customerOrders trong hội thoại. Trước khi tạo đơn
// mới: tra kho landing cục bộ và POS theo SĐT (7 ngày, chưa hủy, không bỏ dở); có thì hỏi
// khách xác nhận đặt thêm như đơn trong hội thoại. Kết quả nhớ 10 phút theo SĐT.
const externalOrderCache = new Map();
const externalOrderCacheTtlMs = 10 * 60 * 1000;
const externalOrderWindowMs = 7 * 24 * 60 * 60 * 1000;
const externalOrderTimeoutMs = 5000;

export function clearExternalOrderCache() {
  externalOrderCache.clear();
}

/**
 * Dọn Map nhớ trong RAM (01/10, tránh tăng mãi): bỏ mục hết hạn (`expired(value, key)`), rồi nếu vẫn quá `maxSize`
 * thì bỏ mục cũ nhất (Map giữ thứ tự chèn). Gọi khi ghi mục mới.
 */
export function pruneMap(map, expired, maxSize) {
  for (const [key, value] of map) if (expired(value, key)) map.delete(key);
  while (map.size > maxSize) map.delete(map.keys().next().value);
}
const externalOrderCacheMax = 2000;

/** Giờ POS (inserted_at là UTC không có Z) → mốc ms. */
function posTimeMs(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  return Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`) || 0;
}

/**
 * Đơn 7 ngày cùng SĐT ở ngoài hội thoại: (a) kho landing cục bộ (đơn chưa hủy, không "Chưa hoàn tất");
 * (b) Pancake POS (`/orders?search=SĐT`, không hủy/hoàn, không bỏ dở, không phải đơn CRM đẩy sang).
 * Trả { orders (mới nhất trước, dạng customerOrder), error } — lỗi mạng/hết giờ POS ghi ở `error`,
 * không chặn lên đơn (bên gọi gắn thẻ để nhân viên soát trùng).
 */
export async function findExternalOrders(phone, { now = Date.now(), fetchImpl = fetch, config = null, landingStore = readLandingStore, excludeIds = [], timeoutMs = externalOrderTimeoutMs } = {}) {
  const key = normalizeWarningPhone(phone);
  if (!key) return { orders: [], error: '' };
  const cached = externalOrderCache.get(key);
  if (cached && now - cached.at < externalOrderCacheTtlMs) return cached.result;
  const excluded = new Set((excludeIds || []).map(String));
  const orders = [];
  let error = '';
  // (a) Kho landing (webhook Webcake + đồng bộ POS 5 phút): đơn đã có trong CRM.
  try {
    const store = await landingStore();
    for (const order of Array.isArray(store?.orders) ? store.orders : []) {
      if (!order || excluded.has(String(order.id)) || normalizeWarningPhone(order.phone) !== key) continue;
      if (now - (Number(order.createdAt) || 0) > externalOrderWindowMs) continue;
      if (String(order.processingStatus || '') === 'cancelled' || order.status === 'Hủy' || order.status === INCOMPLETE_LABEL || order.landing?.incomplete) continue;
      orders.push({ id: String(order.id), posId: String(order.landing?.posId || order.pos?.id || ''), createdAt: Number(order.createdAt) || 0, total: Number(order.total) || 0, status: String(order.status || ''), source: order.source || 'Landing page', phone: order.phone, address: order.address || '', products: (order.products || []).map(item => ({ name: item.name, sku: item.sku || '', quantity: Number(item.quantity) || 1 })) });
    }
  } catch (caught) {
    error = `kho landing: ${caught.message}`;
  }
  // (b) POS: đơn nhân viên lên tay / landing chưa kịp đồng bộ / Facebook Shop.
  const posSettings = config || posConfig();
  if (posConfigured(posSettings)) {
    try {
      const data = await Promise.race([
        posRequest('/orders', { search: key, page_size: 20 }, posSettings, fetchImpl),
        new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error(`hết ${timeoutMs}ms`)), timeoutMs); timer.unref?.(); })
      ]);
      for (const order of Array.isArray(data?.data) ? data.data : []) {
        if (normalizeWarningPhone(order.bill_phone_number || order.shipping_address?.phone_number) !== key) continue;
        if ([order.custom_id, order.id].some(value => String(value || '').startsWith('CRM-'))) continue;
        if (order.is_abandoned_order || Number(order.status) === 6 || /cancel|return|hủy|hoàn/i.test(String(order.status_name || ''))) continue;
        const createdAt = posTimeMs(order.inserted_at);
        if (!createdAt || now - createdAt > externalOrderWindowMs) continue;
        const id = `POS-${order.system_id || order.id}`;
        if (orders.some(item => item.posId === String(order.id))) continue;
        orders.push({
          id, posId: String(order.id), createdAt, total: Number(order.cod ?? order.total_price) || 0, status: String(order.status_name || ''), source: 'POS', phone: key,
          address: String(order.shipping_address?.full_address || ''),
          pos: { id: String(order.id), systemId: String(order.system_id || ''), status: String(order.status_name || '') },
          products: (order.items || []).filter(item => !item.is_bonus_product).map(item => {
            const sku = String(item.variation_info?.display_id || '').trim();
            return { name: findProductBySku(sku)?.name || matchProduct(String(item.variation_info?.detail || ''))?.name || String(item.variation_info?.name || '').trim() || sku || 'sản phẩm', sku, quantity: Number(item.quantity) || 1 };
          })
        });
      }
    } catch (caught) {
      error = [error, `POS: ${caught.message}`].filter(Boolean).join('; ');
    }
  }
  // Đơn landing đã đồng bộ từ POS (landing.posId) và chính đơn POS đó: giữ một bản.
  const seen = new Set();
  const unique = orders.sort((a, b) => b.createdAt - a.createdAt).filter(order => { const mark = order.posId || order.id; if (seen.has(mark)) return false; seen.add(mark); return true; });
  const result = { orders: unique, error };
  // Lỗi thì không nhớ: lượt sau tra lại.
  if (!error) {
    externalOrderCache.delete(key);
    externalOrderCache.set(key, { at: now, result });
    pruneMap(externalOrderCache, entry => now - entry.at >= externalOrderCacheTtlMs, externalOrderCacheMax);
  }
  return result;
}

const endpointHostChecks = new Map();
/** Kiểm host endpoint AI tuỳ chỉnh không trỏ vào mạng nội bộ; nhớ kết quả 60 giây. */
async function assertEndpointHost(endpoint) {
  let hostname = '';
  try { hostname = new URL(endpoint).hostname; } catch { throw new Error('Endpoint AI không hợp lệ.'); }
  const checkedAt = endpointHostChecks.get(hostname) || 0;
  if (Date.now() - checkedAt < 60 * 1000) return;
  await assertPublicHost(hostname);
  endpointHostChecks.delete(hostname);
  endpointHostChecks.set(hostname, Date.now());
  pruneMap(endpointHostChecks, at => Date.now() - at >= 60 * 1000, 100);
}

/**
 * Địa chỉ khách nhắn mà bộ đọc luật không tách đủ ba cấp thì hỏi AI trước khi
 * bot hỏi lại khách; câu trả lời chỉ được dùng khi khớp danh mục kho. Đổi
 * thẳng Customer_Address trong JSON của mô hình nên phần sau (ghép địa chỉ,
 * hỏi lại, lên đơn) không cần biết địa chỉ đến từ đâu.
 */
export async function refineAddressWithAi(parsed, context = {}, settings = {}, fetchImpl) {
  keepTypedHouseNumber(parsed, context);
  const fresh = String(parsed?.Customer_Address || '').trim();
  const merged = mergeAddressFragment(fresh !== '0' ? fresh : '', context.pendingOrder?.address || '');
  if (!merged || describeDeliveryAddress(merged).complete) return parsed;
  const guess = await inferAddress(merged, { settings, fetchImpl, timeoutMs: chatTimeoutMs }).catch(() => null);
  // R13 (địa chỉ K12): phường/xã AI TỰ SUY (không có trong chữ khách, chưa kiểm được) — kết quả `suggestOnly`, canonical rỗng.
  // KHÔNG tự điền vào đơn: bot xử lý như khi AI không ra kết quả (hỏi lại khách / nhận nguyên chữ khách), chỉ ghi gợi ý
  // cho nhân viên vào ghi chú soát đi theo giỏ → ghi chú xử lý của đơn (order.addressCheck) nếu lượt này lên đơn.
  if (guess?.suggestOnly && guess.suggestion?.ward) {
    const hint = `Gợi ý phường/xã (AI, chưa kiểm): ${[guess.suggestion.ward, guess.suggestion.district].map(part => String(part || '').trim()).filter(Boolean).join(', ')}`;
    if (!String(parsed.addressAiCheck || '').includes(hint)) parsed.addressAiCheck = [parsed.addressAiCheck, hint].filter(Boolean).join('; ');
  }
  if (!guess?.canonical) return parsed;
  // fix-addr (01/10): địa chỉ ghi theo phường/xã mới (postMerger): canonical là chính chữ khách + tên tỉnh.
  if (guess.confidence !== 'low' || guess.postMerger) {
    parsed.Customer_Address = guess.canonical;
    return parsed;
  }
  // T7 (01/10): độ tin thấp (mô hình tự báo, hay số nhà/đường không có trong chữ khách — streetInvented): chỉ nhận
  // ba cấp hành chính (đã khớp danh mục kho), phần đường giữ đúng chữ khách gõ (bỏ số nhà AI tự thêm), và ghi chú
  // "cần đối chiếu" cho nhân viên như luồng landing.
  const typedHint = addressHint(merged).resolved || {};
  const typedStreet = typedHint.streetWithoutWard ?? typedHint.street ?? '';
  const levels = [guess.ward, guess.district, guess.province].map(part => String(part || '').trim()).filter(Boolean);
  if (levels.length < 3) return parsed;
  parsed.Customer_Address = [isUsableStreet(typedStreet) ? typedStreet : '', ...levels].filter(Boolean).join(', ');
  parsed.addressAiCheck = [parsed.addressAiCheck, `Địa chỉ AI suy ra từ "${merged.replace(/\s+/g, ' ').slice(0, 120)}", cần đối chiếu`].filter(Boolean).join('; ');
  return parsed;
}

/**
 * fix-addr (01/10): mô hình chat viết lại Customer_Address mà bỏ số nhà khách đã gõ (đơn thật: "71/82 khu phố 1 phường
 * Long Bình Tân…" thành "Gần siêu thị Big C, Phường Long Bình Tân…"). Tin địa chỉ gần nhất của khách (cùng tỉnh) còn số
 * nhà mà địa chỉ mô hình trả không có → giữ chữ khách gõ, kèm ghi chú đối chiếu cho nhân viên.
 *
 * fix-review (02/10): CHỈ xét tin MỚI NHẤT của khách có số nhà. Tin đó không đọc ra tỉnh (hay khác tỉnh của địa chỉ
 * mô hình viết) thì dừng, KHÔNG lùi về tin cũ hơn: đó thường là tin khách sửa số nhà / đổi địa chỉ ("số nhà 45 chứ
 * không phải 12", "gửi lên công ty: tầng 9 tòa Mipec Tây Sơn") — lùi về tin cũ là đưa địa chỉ CŨ trở lại đơn.
 */
export function keepTypedHouseNumber(parsed, context = {}) {
  const written = String(parsed?.Customer_Address || '').trim();
  if (!written || written === '0') return parsed;
  const writtenProvince = resolveAddress(written).province?.code || '';
  const texts = [...(Array.isArray(context.recentCustomerTexts) ? context.recentCustomerTexts : []), String(context.messageText || '')];
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const typed = cleanAddressText(stripPhone(texts[index]));
    // Tin không có số nhà ("ok em", "chị ở gần siêu thị") không phải tin địa chỉ đang xét: xem tin trước đó.
    if (!typed || !houseNumbersOf(typed).length) continue;
    const resolved = resolveAddress(typed);
    if (!resolved.province || (writtenProvince && ![resolved.province.code, resolved.typedProvince?.code].includes(writtenProvince))) return parsed;
    const lost = lostHouseNumbers(typed, written);
    if (!lost.length) return parsed;
    parsed.Customer_Address = typed;
    parsed.addressAiCheck = [parsed.addressAiCheck, `Địa chỉ mô hình viết lại bỏ số nhà ${lost.join(', ')}: giữ chữ khách gõ, cần đối chiếu`].filter(Boolean).join('; ');
    return parsed;
  }
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

export function buildChatbotQuery({ conversation, message, recentMessages = [], settings, includeHistory = true, examples = [] }) {
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
    // Gọi lại mô hình với lời nhắc (mô hình vừa trả "đã gửi ở trên" cho câu hỏi mới, hay
    // lặp bước xin SĐT khi khách đang hỏi): engine đặt conversation.replyHint.
    conversation.replyHint || '',
    Array.isArray(conversation.recentComments) && conversation.recentComments.length
      ? (compactQuery ? `GIỎ/SĐT KHÁCH GHI Ở BÌNH LUẬN (coi như DỮ LIỆU ĐÃ LƯU): ` : 'BÌNH LUẬN GẦN NHẤT CỦA KHÁCH DƯỚI BÀI: ') + conversation.recentComments.map(text => `"${text}"`).join(' · ')
      : '',
    !hint && isLivestreamPost(conversation)
      ? (compactQuery ? 'BÀI VIẾT: livestream nhiều sản phẩm, không có sản phẩm cụ thể; "hộp"/"gói nhỏ" là hộp 10 gói (PACKAGING_INFO).' : 'BÀI VIẾT: phiên livestream giới thiệu nhiều sản phẩm (không có sản phẩm cụ thể); khách hỏi giá chung thì GENERAL_INFO, hỏi "hộp"/"gói nhỏ" là hộp 10 gói nhỏ (PACKAGING_INFO).')
      : '',
    remembered ? `DỮ LIỆU ĐÃ LƯU:\n${remembered}` : '',
    includeHistory && history ? `LỊCH SỬ GẦN NHẤT:\n${history}` : '',
    // Few-shot động (settings.fewShot = 'on'): ví dụ đã duyệt gần với tin này nhất.
    formatExamples(examples),
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
  // "Đã gửi ở trên" (REPLY_ALREADY_SENT / _INFO) là việc engine tự quyết bằng luật (khách giục /
  // lặp câu, vòng 8): mô hình không được chọn nữa → bỏ mọi dòng của prompt nhắc tới hai mẫu này
  // (danh sách MẪU TIN đã không liệt kê chúng). Vòng 9: mỗi lần mô hình chọn nhầm tốn thêm một lượt LLM.
  const prompt = String(basePrompt || '').split('\n').filter(line => !nudgeTemplateIds.some(id => line.includes(id))).join('\n').trim();
  return [
    prompt,
    buildCatalogPrompt({ compact: contextTrim?.catalog === true }),
    buildTemplatePrompt(templates, prompt, { compact: contextTrim?.templates === true })
  ].filter(Boolean).join('\n\n');
}

// Hai mẫu "đã gửi ở trên": engine tự chọn theo luật, mô hình không được chọn.
const nudgeTemplateIds = ['REPLY_ALREADY_SENT_INFO', 'REPLY_ALREADY_SENT'];
// Mã mẫu engine soạn riêng (không có text trong Thiết lập tin nhắn) mà mô hình vẫn được gọi tên.
const virtualModelTemplateIds = ['ORDER_ADDRESS', 'ORDER_CONFIRMATION', 'ORDER_UPDATE', 'ORDER_CANCEL', 'ORDER_NOTE', 'CSKH_HANDOFF', 'PRICE_QUOTE', 'GENERAL_INFO'];

/**
 * Mã mẫu mô hình được phép trả (cho responseSchema enum): mẫu có trong Thiết lập tin nhắn hay
 * mẫu ảo của bước đơn, VÀ được nêu tên trong prompt đã ghép (buildTemplatePrompt liệt kê mọi mẫu
 * dùng được; prompt gốc nêu cách dùng). Không gồm "đã gửi ở trên", bám đuổi, bình luận, bảng giá
 * theo sản phẩm (mô hình dùng PRICE_QUOTE + Product_N1).
 */
export function modelTemplateChoices(templates = {}, systemPrompt = '') {
  const prompt = String(systemPrompt || '');
  const banned = id => nudgeTemplateIds.includes(id) || /^(FOLLOW_UP_|COMMENT_)/.test(id) || isProductQuoteId(id);
  const ids = [...new Set([...Object.keys(templates || {}), ...virtualModelTemplateIds])]
    .map(id => String(id || '').trim())
    .filter(id => /^[A-Z0-9_]+$/.test(id) && !banned(id) && new RegExp(`(?<![A-Z0-9_])${id}(?![A-Z0-9_])`).test(prompt));
  return ids.sort();
}

/**
 * responseSchema (OpenAPI con của Vertex) cho câu trả lời JSON: template_id là enum các mẫu cho
 * phép, các trường còn lại là chuỗi tùy chọn (đúng những trường renderChatbotReply đọc).
 * Vertex không nhận additionalProperties nên mọi trường mô hình có thể trả phải kê ở đây.
 */
export function responseSchemaFor(templateIds = []) {
  const text = { type: 'string' };
  return {
    type: 'object',
    properties: {
      template_id: { type: 'string', enum: [...templateIds] },
      Product_N1: text, No_A: text, Product_N2: text, No_B: text, Product_N3: text, No_C: text,
      Phone_Number: text, Customer_Address: text, also: text, warming: text
    },
    required: ['template_id']
  };
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

// ===== Cache phần tĩnh của prompt trên Vertex (explicit context cache) =====
// Prompt hệ thống (luật + danh mục + danh sách mẫu ≈ 2.300 token, 79% mỗi lượt) giống hệt
// giữa các lượt nhưng implicit cache của Gemini 3 Flash chỉ ăn từ 4.096 token. Thăm dò 25/09:
// cachedContents chạy với gemini-3-flash-preview, token cache tính giá 1/10. Cache theo băm
// (model + prompt), TTL 1 giờ, tạo lại khi hết hạn / đổi mẫu; Vertex báo cache hỏng thì bỏ và
// gửi như thường. settings.promptCache: 'on' (mặc định) | 'off'.
const promptCaches = new Map();
const promptCacheTtlSeconds = 3600;

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
  return hash.toString(16);
}

export function clearPromptCaches() {
  promptCaches.clear();
}

async function promptCacheFor({ endpoint, model, systemPrompt, accessToken, fetchImpl }) {
  const key = `${model}:${hashText(systemPrompt)}`;
  const entry = promptCaches.get(key);
  if (entry && entry.expiresAt > Date.now() + 60000) return entry.name;
  const root = endpoint.replace(/\/publishers\/google\/models\/.*$/, '');
  const project = root.match(/\/projects\/([^/]+)\/locations\/([^/]+)/);
  if (!project) return '';
  const response = await fetchImpl(`${root}/cachedContents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `projects/${project[1]}/locations/${project[2]}/publishers/google/models/${model}`, displayName: `giotnang-${key.slice(-12)}`, systemInstruction: { parts: [{ text: systemPrompt }] }, ttl: `${promptCacheTtlSeconds}s` })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.name) throw new Error(payload?.error?.message || `cachedContents ${response.status}`);
  promptCaches.delete(key);
  promptCaches.set(key, { name: payload.name, expiresAt: Date.now() + promptCacheTtlSeconds * 1000 });
  // Mỗi lần sửa mẫu/prompt thêm một khóa: bỏ khóa hết hạn, giữ tối đa 50.
  pruneMap(promptCaches, entry => entry.expiresAt <= Date.now(), 50);
  console.log(`Cache prompt: tạo mới cho ${model} (${payload.usageMetadata?.totalTokenCount || '?'} token, 1 giờ)`);
  return payload.name;
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
  const callModel = async (model, noCache = false) => {
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
      // Ví dụ đã duyệt: replay đưa sẵn (bỏ chính tin đang đo); chạy thật lấy từ bộ chấm mẫu khi bật.
      const examples = (Array.isArray(options.examples) ? options.examples
        : settings.fewShot === 'on' && message?.type === 'text' && message.text
          // `source`: ví dụ bình luận không đưa vào hộp thư và ngược lại (example-bank lọc theo kênh).
          ? nearestExamples(await loadExampleBank(), { text: message.text, lastTemplate: conversation.botLastTemplateId || '', source: conversation.source || '' })
          : [])
        // Ví dụ chấm "đã gửi ở trên" không đưa cho mô hình: mẫu đó engine tự quyết bằng luật.
        .filter(item => !nudgeTemplateIds.includes(String(item?.label || '')));
      if (examples.length && !Array.isArray(options.examples)) console.log(`Few-shot: ${examples.length} ví dụ (${examples.map(item => item.label).join(', ')}) (${conversation.id})`);
      const query = buildChatbotQuery({ conversation, message, recentMessages, settings, includeHistory: false, examples });
      const imageParts = vertex && message?.type === 'image' ? await collectImageParts(message, fetchImpl) : [];
      // Cache prompt: chỉ Vertex + Gemini 3/2.5 (không phải khi dùng khóa API); lỗi tạo cache thì gửi như thường.
      let cachedContent = '';
      if (vertex && settings.promptCache === 'on' && settings.directAuthType !== 'api_key' && /gemini-(3|2\.5)/i.test(model) && !options.noPromptCache && !noCache) {
        try { cachedContent = await promptCacheFor({ endpoint, model, systemPrompt, accessToken, fetchImpl }); } catch (error) { console.warn(`Cache prompt: không tạo được (${String(error.message).slice(0, 80)}), gửi không cache.`); }
      }
      const body = vertex ? {
        ...(cachedContent ? { cachedContent } : { systemInstruction: { parts: [{ text: systemPrompt }] } }),
        contents: [
          ...memoryTurns.map(turn => ({ role: turn.role, parts: [{ text: turn.text }] })),
          { role: 'user', parts: [...imageParts, { text: query }] }
        ],
        generationConfig: {
          ...(settings.structuredOutput !== false ? { responseMimeType: 'application/json' } : {}),
          // settings.responseEnum = 'on': ép template_id vào enum các mẫu cho phép (không bịa mã, không
          // chọn "đã gửi ở trên"); các trường còn lại là chuỗi tùy chọn. Mặc định tắt để A/B.
          ...(settings.structuredOutput !== false && settings.responseEnum === 'on' && responseChoices.length ? { responseSchema: responseSchemaFor(responseChoices) } : {}),
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
      // Endpoint tuỳ chỉnh chỉ được kiểm SSRF lúc lưu cài đặt; DNS có thể đổi sau đó → kiểm lại (cache 60 s)
      // và không đi theo redirect để khoá/ngữ cảnh khách không bị chuyển sang máy khác.
      if (!vertex) await assertEndpointHost(endpoint);
      // T4 (01/10): hết giờ (mặc định 60 giây) thì hủy lời gọi và coi như lỗi tạm (isCapacityError) → model dự phòng /
      // chạy lại sau 60 giây như 429. Trước đây không có hạn: Vertex treo là hàng đợi của khách đứng tới ~300 giây.
      const timeoutMs = Math.max(1, Number(options.timeoutMs ?? settings.modelTimeoutMs) || modelReplyTimeoutMs);
      const controller = new AbortController();
      let timer = null;
      const timedOut = new Promise((_resolve, reject) => {
        // Không unref: lời gọi đang chờ phải giữ tiến trình sống tới khi hết giờ (luôn được clearTimeout ở finally).
        timer = setTimeout(() => { controller.abort(); reject(modelTimeoutError(model, timeoutMs)); }, timeoutMs);
      });
      timedOut.catch(() => {});
      let response;
      let payload;
      try {
        response = await Promise.race([fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            ...(anthropic
              ? { 'x-api-key': settings.directApiKey, 'anthropic-version': '2023-06-01' }
              : vertex && settings.directAuthType === 'api_key'
              ? { 'x-goog-api-key': settings.directApiKey }
              : { Authorization: `Bearer ${accessToken}` }),
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        }), timedOut]).catch(error => {
          // fetch bị hủy bởi controller (AbortError) = hết giờ.
          if (controller.signal.aborted) throw modelTimeoutError(model, timeoutMs);
          throw error;
        });
        if (response.status >= 300 && response.status < 400) throw new Error(`Endpoint AI chuyển hướng (${response.status}) — không theo để tránh lộ khóa.`);
        payload = await Promise.race([response.json().catch(() => (controller.signal.aborted ? Promise.reject(modelTimeoutError(model, timeoutMs)) : {})), timedOut]);
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        // Cache hết hạn/hỏng phía Vertex (400/403/404): bỏ cache, gửi lại một lần với prompt đầy đủ.
        if (cachedContent && [400, 403, 404].includes(response.status)) {
          promptCaches.clear();
          console.warn(`Cache prompt: Vertex từ chối (${response.status}), gửi lại không cache.`);
          return callModel(model, true);
        }
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
      if (rawResponse) return { raw: answer, parsed: parseModelAnswer(answer), usage, conversationId: '' };
      // T1 (01/10): chỉ giữ trường mô hình được trả (bỏ `values`/`orderNote`/`clearBasket`… khách có thể lái mô hình tự
      // điền) và chặn mẫu nội bộ — trước khi refineAddressWithAi đặt các trường của engine.
      const parsedAnswer = sanitizeModelAnswer(parseModelAnswer(answer), settings.systemPrompt);
      await refineAddressWithAi(parsedAnswer, options.context || {}, settings, fetchImpl);
      // Kèm số liệu lượt gọi cho nhật ký quyết định: token thật, ví dụ few-shot đã chèn, model, đã thử lại.
      return {
        ...renderChatbotReply(parsedAnswer, settings.messageTemplates, options.context || {}),
        conversationId: '',
        model,
        retried: attempt > 0 || usingFallback,
        fewShot: examples.map(item => String(item.label || '')),
        usage: usage ? { input: Number(usage.promptTokenCount) || 0, cached: Number(usage.cachedContentTokenCount) || 0, output: Number(usage.candidatesTokenCount) || 0, thinking: Number(usage.thoughtsTokenCount) || 0 } : null
      };
  };
  const responseChoices = vertex && settings.responseEnum === 'on' ? modelTemplateChoices(settings.messageTemplates, systemPrompt) : [];
  let model = primaryModel;
  let usingFallback = false;
  let attempt = 0;
  for (;;) {
    try {
      return await callModel(model);
    } catch (error) {
      const capacity = isCapacityError(error);
      attempt += 1;
      // Hết giờ: không chờ thêm lần nữa với cùng model (mỗi lần tới 60 giây) — sang dự phòng / hẹn chạy lại ngay.
      const limit = capacity ? (error?.code === 'MODEL_TIMEOUT' ? 1 : usingFallback ? 2 : capacityAttempts) : attempts;
      if (attempt < limit) {
        // Backoff mũ kèm jitter (khuyến nghị Vertex khi 429): nhiều hội thoại cùng lúc không thử lại đúng một nhịp.
        const delay = capacity ? Math.min(10000, capacityWait * 2 ** (attempt - 1)) * (0.5 + Math.random()) : baseWait;
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

/** 429 (hết hạn mức) hay 503 (quá tải), hay hết giờ chờ mô hình (T4): lỗi tạm, đáng thử lại; lỗi khác (401, prompt sai…) thì không. */
export function isCapacityError(error) {
  const status = Number(error?.status) || 0;
  return status === 429 || status === 503 || error?.code === 'MODEL_TIMEOUT' || /resource exhausted|rate limit|quota|overloaded|currently unavailable/i.test(String(error?.message || ''));
}

// T4 (01/10): hạn chờ một lời gọi mô hình trả lời khách (settings.modelTimeoutMs ghi đè). 60 giây: đủ cho lượt có
// "suy nghĩ"/prompt dài hợp lệ (25–30 giây có thể cắt nhầm — xem verify-chatbot-security T4).
export const modelReplyTimeoutMs = 60 * 1000;

function modelTimeoutError(model, timeoutMs) {
  const error = new Error(`Model ${model} không trả lời sau ${Math.round(timeoutMs / 1000)} giây (hết giờ).`);
  error.code = 'MODEL_TIMEOUT';
  error.timeout = true;
  return error;
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
        // R13: đơn POS đã báo "đã nhận" ở lượt trước (shopOrderAck) không phải đơn của giỏ đang chờ này.
        if (!found || (String(found.id || '') && String(found.id) === String(current.shopOrderAck?.id || ''))) { check(index + 1); return; }
        const reply = shopOrderReply(found);
        for (const text of reply.messages) await dependencies.sendMessage(current, { text });
        await dependencies.saveBotState?.(current.id, { pendingOrder: null, botLastTemplateId: reply.templateId, botLastReplyAt: Date.now(), ...(found.id ? { shopOrderAck: { id: String(found.id), at: Date.now() } } : {}) });
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

/** SĐT về dạng 0xxxxxxxxx để so (không kiểm đầu số). */
function toLocalPhoneDigits(value) {
  return String(value || '').replace(/\D/g, '').replace(/^84(?=\d{9}$)/, '0');
}

/**
 * Ghi chú nội bộ cho nhân viên (không gửi khách) khi bot không tự làm được — ví dụ đơn tìm theo SĐT không thuộc hội
 * thoại (C2). Máy chủ đưa dependencies.addStaffNote(conversation, note) thì ghi vào hồ sơ khách; chưa có thì chỉ
 * ghi nhật ký (không kèm địa chỉ/PII — `summary`). Lỗi ghi không chặn lượt trả lời.
 */
async function noteForStaff(dependencies, conversation, note, summary = '') {
  console.log(`Ghi chú cho nhân viên (${conversation.id})${summary ? `: ${summary}` : ''}`);
  if (typeof dependencies?.addStaffNote !== 'function') return;
  await Promise.resolve(dependencies.addStaffNote(conversation, String(note || '').slice(0, 500))).catch(error => console.warn(`Ghi chú nhân viên lỗi (${conversation.id}): ${error.message}`));
}

// Tin hệ thống của Messenger về cuộc gọi ("Bạn đã bỏ lỡ cuộc gọi…") không phải lời khách.
const callSystemMessage = /bỏ lỡ cuộc gọi|có thể gọi cho .* trong 7 ngày|đã gọi cho bạn|cuộc gọi (thoại|video) đã kết thúc|missed (a )?call/i;

/**
 * Tin khách mà lượt của chính nó không bao giờ trả lời bằng chữ: sticker/👍, tin hệ thống cuộc gọi,
 * "Notes:" đi kèm giỏ Facebook Shop. Không được làm câu hỏi chữ ngay trước đó nhường lượt (C1, 01/10).
 */
function isSilentCustomerMessage(item) {
  if (stickerInfo(item)) return true;
  const text = String(item?.text || '');
  return (item?.type || 'text') === 'text' && (callSystemMessage.test(text) || /^\s*notes?\s*:/i.test(text));
}

/**
 * R13: tin Page do NGƯỜI gõ (nhân viên) — cờ `staff`, hay tin Page không mang dấu máy gửi nào (Page nối thẳng Meta, dữ
 * liệu cũ). Tin CRM tự gửi (sender 'bot': chatbot, ưu đãi QR, phiếu đơn), tin bám đuổi (followUp), tin máy của Pancake
 * (pancakeSender: POS, Botcake, AI Pancake, Public API, ngoài Pancake), thẻ đơn / dòng quảng cáo / dòng hệ thống thì không.
 */
export function isHumanPageMessage(item) {
  if (!item || item.direction !== 'outgoing') return false;
  if (item.staff === true) return true;
  if (item.sender === 'bot' || item.pancakeSender || item.followUp === true || ['order-receipt', 'ad'].includes(item.type)) return false;
  return !isPageSystemNotice(item);
}

/** Đã có tin khách mới hơn tin đang xử lý: tin này nhường, tin sau trả lời gộp cả hai. */
export function hasNewerCustomerMessage(recentMessages, current) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  const index = list.findIndex(item => item?.id && item.id === current?.id);
  const after = index >= 0 ? list.slice(index + 1) : list.filter(item => (Number(item?.createdAt) || 0) > (Number(current?.createdAt) || Infinity));
  // Sticker / cuộc gọi / ghi chú giỏ Shop không được trả lời → không tính là "tin sau sẽ trả lời gộp".
  return after.some(item => item?.direction === 'incoming' && !isSilentCustomerMessage(item));
}

// Ảnh sản phẩm chưa gửi được sau tin nhắn riêng từ bình luận (Facebook chặn
// tới khi khách nhắn vào Messenger): giữ theo khách, gửi ngay khi khách nhắn lại.
const pendingInboxImages = new Map();
const pendingImagesTtl = 3 * 24 * 60 * 60 * 1000;
export function rememberPendingImages(pageId, psid, images) {
  if (!pageId || !psid || !images?.length) return;
  const key = `${pageId}:${psid}`;
  pendingInboxImages.delete(key);
  pendingInboxImages.set(key, { images: [...new Set(images)], at: Date.now() });
  // Khách không bao giờ nhắn lại thì mục nằm mãi: bỏ mục quá hạn, giữ tối đa 5.000 khách.
  pruneMap(pendingInboxImages, entry => Date.now() - entry.at > pendingImagesTtl, pendingInboxImagesMax);
}
const pendingInboxImagesMax = 5000;
export function takePendingImages(pageId, psid) {
  const key = `${pageId}:${psid}`;
  const entry = pendingInboxImages.get(key);
  if (!entry) return [];
  pendingInboxImages.delete(key);
  return Date.now() - entry.at > pendingImagesTtl ? [] : entry.images;
}

// Vòng 12: từ của lời đáp/cảm ơn ngắn ("OK bạn", "dạ vâng ạ", "cảm ơn shop nhiều") — chỉ những tin toàn từ này mới được THANK_YOU.
const thanksAckWords = new Set(['ok', 'oke', 'okie', 'okay', 'okela', 'oki', 'okk', 'uh', 'um', 'u', 'vang', 'da', 'cam', 'on', 'thanks', 'thank', 'you', 'tks', 'ty', 'duoc', 'dc', 'roi', 'nhe', 'nha', 'a', 'ban', 'shop', 'em', 'c', 'chi', 'anh', 'b', 'nhieu', 'luon', 'ak', 'ah', 'r']);

/** Khách vừa nhắn thêm ngay trước khi gọi mô hình: lượt này nhường cho tin sau (không phải lỗi). */
class NewerMessageSkip extends Error {
  constructor() { super('gộp với tin sau'); this.name = 'NewerMessageSkip'; }
}

// Tin đang được bot xử lý (khóa theo hội thoại:tin) — chặn cùng một tin vào hai lần qua hai đường.
const inFlightMessages = new Set();
// R13: khách nói bấm nhầm ("Chị ấn nhấn nhầm đấy", "lỡ tay bấm") — so trên chuỗi đã bỏ dấu.
const misclickPattern = /\b(?:an|bam|nhan|click|chon|cham|dung) (?:nhan |vao )?(?:nham|lon)\b|\blo tay\b|\b(?:nham|lon) (?:thoi|day|do|roi|a|ak|nha|nhe)\b|^nham$/;
// R13: lượt bỏ qua KHÔNG ghi dấu "đã xử lý" (botHandledMessageId): tin nhường cho tin sau / đã có lượt khác lo.
const unmarkedSkips = new Set(['gộp với tin sau', 'đang xử lý tin này', 'đã có người trả lời', 'đã xử lý trước khi khởi động lại']);

/** Chuỗi so lặp: bỏ dấu, chỉ giữ chữ/số, gộp khoảng trắng. */
function squashText(value) {
  return foldVietnamese(String(value || '')).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Độ giống hai câu (0–1) theo cặp ký tự liền nhau (Dice): "Shop ơi giá sao" và
 * "shop oi gia sao" ≈ 1; câu có thêm ý mới thì thấp. Dùng để nhận khách LẶP LẠI
 * câu vừa hỏi (ngưỡng 0,8) trước khi nhắc "em gửi ở trên".
 */
export function textSimilarity(left, right) {
  const a = squashText(left);
  const b = squashText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = text => { const map = new Map(); for (let i = 0; i < text.length - 1; i += 1) { const key = text.slice(i, i + 2); map.set(key, (map.get(key) || 0) + 1); } return map; };
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  for (const [key, count] of ga) shared += Math.min(count, gb.get(key) || 0);
  const total = Math.max(1, a.length - 1) + Math.max(1, b.length - 1);
  return (2 * shared) / total;
}

// Tin khách chỉ là lời giục / lặp ("sao chưa trả lời", "???", "alo", "shop ơi", "có ai không"):
// chỉ khi đó mới được nhắc "em vừa gửi ở trên" (7 ca 26–28/09 nhắc sai vì khách hỏi ý mới).
const nudgePattern = /^(?:sao (?:(?:em|e|shop|c|chi|anh|ban|ad|admin|minh|ben em) )?(?:chua|ko|khong|k|hong) (?:tra loi|rep|thay|thay rep|tl|tra loi minh|tra loi em|noi gi|phan hoi)|\?+|hello|helo|hi|alo|a lo|shop oi|shop|oi|co ai (?:khong|ko|k|hong)(?: a)?|co ai o (?:do|day) (?:khong|ko|k))$/;
export function isNudgeMessage(text) {
  const core = foldVietnamese(String(text || '')).replace(/[^a-z0-9? ]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/(?: (?:a|ạ|nha|nhe|shop|em|e|c|chi|anh|vay|z|ha|the|voi))+$/, '');
  return nudgePattern.test(core) || /^\?+$/.test(String(text || '').trim());
}

/**
 * Cắt chữ dài thành các tin ≤ limit ký tự, ưu tiên cắt ở đoạn trống, xuống dòng, rồi dấu
 * chấm — Messenger cắt cụt tin quá 2.000 ký tự ("…+ miễn phí v"). Tách gửi thay vì cắt.
 */
export function splitMessageText(text, limit = 1900) {
  const body = String(text || '');
  if (body.length <= limit) return [body];
  const chunks = [];
  let rest = body;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit / 2) cut = window.lastIndexOf('\n');
    if (cut < limit / 2) cut = window.lastIndexOf('. ');
    if (cut < limit / 2) cut = window.lastIndexOf(' ');
    if (cut < 1) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/**
 * Dòng log so luật thử với luật ổn định. Giá trị luật thử là JSON thô (ORDER_ADDRESS +
 * SĐT) — phải qua bộ soạn đơn (cùng ngữ cảnh) rồi mới so mẫu, không thì PHONE_ONLY luôn bị
 * ghi ✗ giả khi bộ soạn đơn chốt thành ORDER_CONFIRMATION.
 */
export function shadowRuleLine(shadow, stableTemplateId, render, conversationId = '') {
  const rendered = shadow?.commentRule ? stableTemplateId : shadow?.value ? render(shadow.value)?.templateId || shadow.value.template_id : shadow?.rule;
  return `Luật ${shadow?.rule} (thử): luật ${rendered} / luật ổn định ${stableTemplateId}${rendered === stableTemplateId ? ' ✓' : ' ✗'}${conversationId ? ` (${conversationId})` : ''}`;
}

/**
 * Dấu so mô hình nhỏ với câu trả lời thật: so với mẫu mô hình/luật CHỌN (trước hậu xử lý);
 * ORDER_ADDRESS_REMIND ≡ ORDER_ADDRESS, còn "đã gửi ở trên" là trung tính (~).
 */
export function intentMatchMark(predicted, chosen) {
  // Mẫu con ORDER_ADDRESS (PARTIAL/CART_LINE/REMIND…) do bộ soạn chọn theo giỏ: cùng một quyết định (decisionLabelOf).
  if (['REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO'].includes(chosen)) return '~';
  return decisionLabelOf(predicted) === decisionLabelOf(chosen) ? '✓' : '✗';
}

/**
 * Dấu so mô hình tầng với mẫu CHỌN: ✓ khi mẫu tương đương (cùng quy ước intentMatchMark, nhóm khi đó
 * cũng đúng), ~ khi "đã gửi ở trên", "nhóm✓" khi chỉ nhóm đúng (cần groupOf của mô-đun tầng), còn lại ✗.
 */
export function cascadeMatchMark(cascade, chosen, groupOf = null) {
  const mark = intentMatchMark(cascade?.templateId, chosen);
  if (mark !== '✗') return mark;
  const chosenGroup = typeof groupOf === 'function' ? (() => { try { return groupOf(chosen); } catch { return ''; } })() : '';
  return chosenGroup && chosenGroup === cascade?.group ? 'nhóm✓' : '✗';
}

/**
 * Người gác có thêm top-K của mô hình tầng làm tham chiếu: so luật / mô hình phẳng như cũ (gateCheck),
 * chưa đồng thuận thì so với top-K tầng → reason 'cascade-top1' / 'cascade-topk'; chỉ có tầng mà lệch → 'cascade-mismatch'.
 */
export function gateCheckWithCascade({ llmTemplateId = '', intentTopK = [], cascadeTopK = [], ruleTemplateId = '' } = {}) {
  const base = gateCheck({ llmTemplateId, intentTopK, ruleTemplateId });
  const topK = Array.isArray(cascadeTopK) ? cascadeTopK : [];
  if (base.agree || base.reason === 'no-llm' || !topK.length) return base;
  const viaCascade = gateCheck({ llmTemplateId, intentTopK: topK });
  if (viaCascade.agree) return { agree: true, reason: viaCascade.reason.replace('intent-', 'cascade-') };
  return base.agree === null ? { agree: false, reason: 'cascade-mismatch' } : base;
}

/** Đơn còn hiệu lực (chưa hủy qua bot, nhân viên hay POS). */
export function isActiveOrder(order) {
  return Boolean(order) && String(order.processingStatus || '') !== 'cancelled' && order.status !== 'Hủy';
}

export async function processChatbotChanges(changes, dependencies) {
  const { readSettings } = dependencies;
  const settings = await readSettings();
  if (!settings.enabled) return [];
  const results = [];
  for (const change of changes) {
    // `updated`: tin cũ vừa có thêm dữ liệu (ảnh có URL) — hộp thư vẽ lại, bot không trả lời lần hai.
    if (change.type !== 'message' || change.message?.direction !== 'incoming' || !change.conversation || change.updated) continue;
    // Cùng một tin về qua hai đường (webhook + đồng bộ/backlog) trong lúc lượt đầu còn đang chạy: bỏ.
    const inFlightKey = `${change.conversation.id}:${change.message.id || change.message.mid || change.message.createdAt}`;
    if (inFlightMessages.has(inFlightKey)) { results.push({ conversationId: change.conversation.id, skipped: 'đang xử lý tin này' }); continue; }
    inFlightMessages.add(inFlightKey);
    try {
      // Hàng đợi theo KHÁCH (pageId:psid): bình luận và hộp thư của cùng một
      // người nối tiếp nhau, hai bình luận liền nhau không chạy song song.
      const queueKey = change.conversation.pageId && change.conversation.psid ? `${change.conversation.pageId}:${change.conversation.psid}` : change.conversation.id;
      await queueForConversation(queueKey, () => answerChange(change, settings, results, dependencies));
    } catch (error) {
      // Một hội thoại hỏng (kho tin không ghi được…) không làm rơi các tin còn lại trong lô.
      results.push({ conversationId: change.conversation.id, error: error.message });
    } finally {
      inFlightMessages.delete(inFlightKey);
    }
  }
  // Bot im (nhân viên vừa trả lời, gộp tin, lặp…): ghi một dòng để rà được về sau.
  for (const item of results) if (item.skipped && item.skipped !== 'gộp với tin sau') console.log(`Bot bỏ qua: ${item.skipped} (${item.conversationId})`);
  return results;
}

async function answerChange(incomingChange, settings, results, dependencies) {
  const { listMessages, getConversation, saveBotState, sendMessage, createOrder, updateOrder, cancelOrder, sendReceipt, moderateComment, requestReply = requestDirectModelReply } = dependencies;
  // Ảnh kèm chữ ("giá bao nhiêu" + ảnh túi): xử lý theo chữ như tin thường (ảnh là phụ), không "đã nhận hình".
  // Vòng 12: nhãn dán (sticker; 👍 của Messenger về như ảnh content.pancake.vn/…/stickers/<id>) không phải ảnh.
  const sticker = stickerInfo(incomingChange?.message);
  const captioned = !sticker && incomingChange?.message?.type === 'image' && /\p{L}{2,}/u.test(String(incomingChange.message.text || ''));
  let change = captioned ? { ...incomingChange, message: { ...incomingChange.message, type: 'text', captionOfImage: true } } : incomingChange;
  // Mẫu trong Cài đặt + lời dự phòng cho mẫu mới chưa có (xem fallbackTemplates).
  const templates = withFallbackTemplates(settings.messageTemplates);
  // Luật nhận ý: test có thể đưa luật giả qua dependencies.ruleIntent (kiểm clearBasket/values).
  const ruleIntentFn = typeof dependencies.ruleIntent === 'function' ? dependencies.ruleIntent : ruleIntent;
  // Mô hình tầng: test đưa dependencies.predictCascade (+ cascadeGroupOf) giả; chạy thật nạp mô-đun động (thiếu → null).
  const cascadeMode = ['on', 'shadow', 'off'].includes(settings.intentCascade) ? settings.intentCascade : 'shadow';
  const cascadeModule = cascadeMode !== 'off' && typeof dependencies.predictCascade !== 'function' ? await loadCascadeModule() : null;
  const predictCascadeFn = typeof dependencies.predictCascade === 'function' ? dependencies.predictCascade : typeof cascadeModule?.predictCascade === 'function' ? cascadeModule.predictCascade : null;
  const cascadeGroupOf = typeof dependencies.cascadeGroupOf === 'function' ? dependencies.cascadeGroupOf : typeof cascadeModule?.groupOf === 'function' ? cascadeModule.groupOf : null;
  // Bản mới nhất của hội thoại: tin đứng trước trong hàng có thể vừa lưu giỏ
  // hàng, hay nhân viên vừa tắt bot. Every thread is answered unless staff
  // switched the bot off for it.
  const conversation = (getConversation ? await getConversation(change.conversation.id).catch(() => null) : null) || change.conversation;
  if (conversation.botEnabled === false) {
    // Vòng 12 (B4 #15): bình luận có SĐT không được nằm hiện trên bài kể cả khi bot tắt cho luồng này (trước đây thoát
    // trước bước ẩn). Chỉ ẩn, không like/không trả lời.
    if (conversation.source === 'comment' && moderateComment && ['phone', 'all'].includes(settings.commentHide) && extractVietnamesePhone(String(change.message?.text || ''))) {
      await moderateComment(conversation, change.message, { like: false, hide: true }).catch(() => {});
    }
    return;
  }
  // Vết của lượt này cho nhật ký quyết định (processing/decision-log.mjs): điền dần theo luồng,
  // ghi ở `finally` (kể cả khi bỏ qua hay lỗi). Xem buildDecisionRecord về schema.
  const startedAt = Date.now();
  const resultsBefore = results.length;
  const trace = { text: String(change.message?.text || ''), type: String(change.message?.type || 'text'), ctx: null, rule: null, shadow: [], intent: null, cascade: null, llm: null, fewShot: [], chosen: null, final: null, also: null, preGuard: null, gate: null, attention: false, handoff: false };
  // Vòng 12 (B5 #1): trạng thái bot TRƯỚC lượt này (mẫu vừa gửi, lúc gửi, bot đang hỏi gì). Trước đây nhật ký đọc
  // conversation sau khi saveBotState đã ghi đè (kho trả cùng đối tượng) → prevBot == final ở 1.096/1.106 lượt,
  // đặc trưng lastTemplate của dataset rò đáp án. Chụp ngay khi bắt đầu lượt.
  trace.prev = { templateId: String(conversation.botLastTemplateId || ''), replyAt: Number(conversation.botLastReplyAt) || 0, asks: prevBotAsks(conversation.botLastTemplateId, conversation.pendingOrder) };
  try {
    // R13 (bình luận F10): dòng hệ thống Facebook lưu như tin Page ("Bạn đang phản hồi bình luận…", "… đã trả lời một quảng
    // cáo.", "… replied to a post") không phải lời Page — bỏ khỏi mọi phép kiểm "Page đã trả lời" và khỏi lịch sử đưa mô hình.
    const recentStored = await listMessages(conversation.id);
    const recent = Array.isArray(recentStored) ? recentStored.filter(item => !isPageSystemNotice(item)) : recentStored;
    // Nhật ký: chữ tin bot gần nhất (không phải tin nhân viên), để công cụ dựng dataset không phải đoán từ mã mẫu.
    trace.prevBotText = String([...(Array.isArray(recent) ? recent : [])].reverse().find(item => item?.direction === 'outgoing' && !item.staff && item.text)?.text || '').slice(0, 300);
    // Vòng 12 (chủ shop 01/10): sticker không bao giờ đi nhánh "đã nhận hình" và không gọi mô hình đọc ảnh.
    // - 👍 (like) ngay sau câu hỏi có/không ("em lên 1 túi nha?", "đặt thêm đơn?") = ĐỒNG Ý → xử lý như "ok";
    // - 👍 sau xác nhận đơn → cảm ơn đúng một lần (mẫu cảm ơn đã gửi thì thôi); sau cảm ơn / chỗ khác → im;
    // - sticker khác: im, không chuyển người.
    if (sticker) {
      trace.sticker = { id: sticker.stickerId || '', like: Boolean(sticker.like) };
      const last = String(conversation.botLastTemplateId || '');
      const recentReply = Date.now() - (Number(conversation.botLastReplyAt) || 0) < 24 * 60 * 60 * 1000;
      const asksYesNo = ['ORDER_EXISTING_CONFIRM', 'PRICE_ONE_BAG'].includes(last) && recentReply;
      const afterClose = ['ORDER_CONFIRMATION', 'ORDER_UPDATE', 'ORDER_NOTE', 'SHOP_ORDER_RECEIVED'].includes(last) && recentReply;
      if (!sticker.like || !(asksYesNo || afterClose)) {
        results.push({ conversationId: conversation.id, skipped: sticker.like ? 'like (không cần trả lời)' : 'sticker' });
        return;
      }
      // C1: 👍 về trong lúc bot đang trả lời tin chữ ngay trước (tin chữ không còn nhường cho sticker) — bot đã trả lời
      // sau khi 👍 tới thì 👍 không còn là câu đáp cho câu hỏi cũ: im, không "ok"/cảm ơn chồng.
      const likeAt = Number(change.message?.createdAt) || 0;
      if (likeAt && recent.some(item => item?.direction === 'outgoing' && !item.staff && (Number(item.createdAt) || 0) >= likeAt)) {
        results.push({ conversationId: conversation.id, skipped: 'like (đã trả lời tin trước)' });
        return;
      }
      change = { ...change, message: { ...change.message, type: 'text', text: 'ok', likeSticker: true, dataUrl: undefined, images: undefined } };
    }
    const askedAt = Number(change.message?.createdAt) || 0;
    // Tin chạy lại (hết hạn mức) hay tin đến muộn (đồng bộ/backlog): có thể đã được trả lời trong lúc chờ.
    if ((change.delayedRetry || change.late) && recent.some(item => item?.direction === 'outgoing' && (Number(item?.createdAt) || 0) >= askedAt)) {
      results.push({ conversationId: conversation.id, skipped: 'đã có người trả lời' });
      return;
    }
    // R13 (bình luận F1): tin đến muộn (backlog sau khởi động / đồng bộ) mà bot ĐÃ xử lý — lượt trước bỏ qua có chủ ý
    // (botHandledMessageId), hay là bình luận đã được trả lời bằng tin nhắn riêng: tin riêng nằm ở HỘP THƯ của khách, lời
    // công khai có khi không đăng, nên chỉ nhìn tin của luồng bình luận thì mỗi lần khởi động lại bot trả lời lại lần nữa.
    if (change.delayedRetry || change.late) {
      const lateId = String(change.message?.id || change.message?.mid || '');
      let handled = Boolean(lateId) && String(conversation.botHandledMessageId || '') === lateId;
      if (!handled && conversation.source === 'comment' && askedAt) {
        handled = (Number(conversation.botLastReplyAt) || 0) >= askedAt;
        if (!handled && conversation.pageId && conversation.psid) {
          const inboxSent = await Promise.resolve(listMessages(`${conversation.pageId}:${conversation.psid}`)).catch(() => []);
          handled = (Array.isArray(inboxSent) ? inboxSent : []).some(item => item?.direction === 'outgoing' && item.privateReply === true && (Number(item.createdAt) || 0) >= askedAt);
        }
      }
      if (handled) {
        results.push({ conversationId: conversation.id, skipped: 'đã xử lý trước khi khởi động lại' });
        return;
      }
    }
    if (hasNewerCustomerMessage(recent, change.message)) {
      results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
      return;
    }
    // Vòng 12 (B1 #5, B2 #7, B3 #1): ảnh gửi cùng đợt với tin chữ (≤ 60 giây, chữ chưa được trả lời — lượt chữ đã nhường
    // cho ảnh): xử lý Ý CỦA TIN CHỮ ("Giá bao nhiêu vậy?", "Gửi a 1 túi vàng 1 túi nâu", SĐT, "Mình chuyển khoản"), ảnh là
    // phụ (thẻ cần người xem ảnh) — không "đã nhận hình, cần hỗ trợ gì".
    const imageAt = Number(change.message?.createdAt) || Date.now();
    const lastOutgoingIndex = recent.findLastIndex(item => item?.direction === 'outgoing');
    // R13 (inbox3 F4): mọi tin không phải chữ (ảnh, video, tệp/attachment) — không chỉ `image`. Trước đây "Giá sao em" kèm
    // một tệp/video bị mất câu hỏi (tin tệp nuốt lượt của tin chữ rồi đi nhánh "đã nhận hình").
    const mediaMessage = !sticker && !['text', 'sticker', 'ad', 'order-receipt'].includes(String(change.message.type || 'text'));
    const textsWithImage = mediaMessage
      ? recent.slice(lastOutgoingIndex + 1).filter(item => item?.direction === 'incoming' && (item.type || 'text') === 'text' && String(item.text || '').trim() && item.id !== change.message.id && Math.abs((Number(item.createdAt) || imageAt) - imageAt) <= 60 * 1000).slice(-bundleLimit)
      : [];
    // Vòng 12 (B4 #18): bình luận chỉ tag bạn bè / chỉ là tên người → chỉ like, không trả lời.
    if (conversation.source === 'comment' && change.message.type === 'text' && isTagOnlyComment(change.message)) {
      if (moderateComment) await moderateComment(conversation, change.message, { like: settings.commentLike !== false, hide: false }).catch(() => {});
      results.push({ conversationId: conversation.id, skipped: 'bình luận chỉ tag bạn bè' });
      return;
    }
    // Vòng 12 (B2 #8): tin "Notes:" Facebook Shop gửi cùng lúc với giỏ (thường trống) không phải câu hỏi mới — không chào lại
    // (trước đây bot gửi WELCOME đè lên bước xin SĐT của giỏ). Có nội dung ghi chú → giữ vào giỏ chờ + thẻ cho nhân viên.
    const shopNote = change.message.type === 'text' && String(change.message.text || '').match(/^\s*notes?\s*:\s*([\s\S]*)$/i);
    if (shopNote && recent.some(item => item?.direction === 'incoming' && item.cart?.length && Math.abs((Number(item.createdAt) || 0) - (Number(change.message.createdAt) || Date.now())) <= 3 * 60 * 1000)) {
      const note = shopNote[1].replace(/\s+/g, ' ').trim();
      if (note) await saveBotState(conversation.id, { addLabelEvents: ['handoff'], ...(conversation.pendingOrder ? { pendingOrder: { ...conversation.pendingOrder, note: note.slice(0, 200) } } : {}) }).catch(() => {});
      results.push({ conversationId: conversation.id, skipped: note ? 'ghi chú giỏ Shop (đã lưu)' : 'ghi chú giỏ Shop trống' });
      return;
    }
    const bundle = change.message.type === 'text' ? unansweredCustomerMessages(recent, change.message) : textsWithImage.length ? [...textsWithImage, change.message] : [change.message];
    const bundled = new Set(bundle.map(item => item?.id).filter(Boolean));
    // R13 (bình luận F2, lỗ phụ): khách bình luận nhiều lần liền nhau được gộp thành một lượt — trước đây chỉ bình luận CUỐI
    // được like/ẩn, nên bình luận có SĐT ở giữa cụm vẫn nằm hiện trên bài (còn bình luận cuối không có SĐT lại bị ẩn theo
    // chữ gộp). Nay: ẩn ĐÚNG từng bình luận có SĐT (hay tất cả khi commentHide = 'all'), like bình luận cuối.
    // (Page nối qua Pancake: moderateComment không gọi được API ẩn — meta-sync ghi log "không ẩn được".)
    const moderateBundledComments = async ({ like = settings.commentLike !== false, onlyHide = false } = {}) => {
      if (!moderateComment) return;
      const comments = conversation.source === 'comment' && bundle.length ? bundle : [change.message];
      for (const item of comments) {
        const isCurrent = item === change.message || Boolean(item?.id && item.id === change.message.id);
        const hide = settings.commentHide === 'all' || (settings.commentHide === 'phone' && Boolean(extractVietnamesePhone(String(item?.text || ''))));
        const wantLike = !onlyHide && like && isCurrent;
        if (!hide && !wantLike) continue;
        await Promise.resolve(moderateComment(conversation, isCurrent ? change.message : item, { like: wantLike, hide })).catch(() => {});
      }
    };
    // Có Vertex xem ảnh: giữ tin ảnh (mô hình xem ảnh) nhưng kèm chữ của khách; không xem được ảnh: xử lý như tin chữ.
    const visionOn = change.message.type === 'image' && settings.provider === 'vertex' && settings.visionEnabled !== false && Boolean(change.message.dataUrl || change.message.images?.length);
    const message = textsWithImage.length
      ? { ...change.message, ...(visionOn ? {} : { type: 'text' }), text: textsWithImage.map(item => String(item.text || '').trim()).join('\n'), withImage: true }
      : bundle.length > 1
        ? { ...change.message, text: bundle.map(item => String(item.text || '').trim()).join('\n') }
        : change.message;
    trace.text = String(message.text || '');
    trace.type = String(message.type || 'text');
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
    // Đơn gần nhất CHƯA hủy đi trước: đơn vừa hủy không được che đơn cũ còn giao (bỏ bước hỏi
    // "đặt thêm?"), không được kể là "đang chuẩn bị hàng", không làm giỏ mới bị bớt món "đã đặt".
    // Không còn đơn nào chưa hủy thì lấy đơn hủy gần nhất (để "hủy đơn" lần hai được đáp "đã hủy rồi").
    const allOrders = [...(Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []), ...(Array.isArray(inboxThread?.customerOrders) ? inboxThread.customerOrders : [])];
    const latestOf = list => list.reduce((latest, order) => ((Number(order?.createdAt) || 0) > (Number(latest?.createdAt) || 0) ? order : latest), null);
    const latestOrder = latestOf(allOrders);
    const recentOrder = latestOf(allOrders.filter(isActiveOrder)) || latestOrder;
    // Tin hệ thống của Messenger ("Bạn đã bỏ lỡ cuộc gọi…") không phải lời khách.
    if (callSystemMessage.test(String(change.message?.text || ''))) {
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
    let previousDelivery = (() => {
      const confirmation = [...recent].reverse().find(item => item?.direction === 'outgoing' && /Số điện thoại:\s*\S+/u.test(String(item.text || '')) && /Địa chỉ nhận hàng:/u.test(String(item.text || '')));
      if (!confirmation) return null;
      const phone = String(confirmation.text).match(/Số điện thoại:\s*([\d .+-]{9,16})/u)?.[1]?.replace(/[^\d+]/g, '') || '';
      const address = String(confirmation.text).match(/Địa chỉ nhận hàng:\s*([^\n]+)/u)?.[1]?.trim() || '';
      return phone && address ? { phone, address, at: Number(confirmation.createdAt) || 0 } : null;
    })();
    // Vòng 12 (B2 #2, BOT-A): bot vừa xin "SĐT đã đặt lần trước" (ORDER_ADDRESS_OLD_ASK_PHONE) hay giỏ ghi khách muốn
    // gửi địa chỉ cũ, mà tin có SĐT: tra đơn cũ cùng SĐT (đơn hội thoại + kho landing/POS đã đồng bộ, không gọi mạng).
    const oldAddressPhone = message.type === 'text' && (conversation.botLastTemplateId === 'ORDER_ADDRESS_OLD_ASK_PHONE' || conversation.pendingOrder?.wantsPrevious)
      ? extractVietnamesePhone(String(message.text || '')) : '';
    if (oldAddressPhone) {
      // Trong tiến trình test chỉ đọc kho landing khi test đưa readLandingStore (không đụng dữ liệu thật).
      const landingStore = dependencies.readLandingStore || (process.env.NODE_TEST_CONTEXT ? null : readLandingStore);
      // C2 (01/10): chỉ đơn CỦA hội thoại này (customerOrders hộp thư/bình luận cùng khách) mới được tự điền và nhắc lại
      // địa chỉ. Đơn kho landing/POS tìm theo SĐT không chứng minh được là của người đang nhắn (gõ SĐT người khác là
      // lộ địa chỉ + đơn COD tới nhà họ): không điền, không nhắc; gắn thẻ + ghi chú để nhân viên đối chiếu.
      const own = await lookupPreviousAddress(oldAddressPhone, { customerOrders: allOrders }).catch(() => null);
      if (own?.address) previousDelivery = { phone: own.phone || oldAddressPhone, address: own.address, at: Number(own.at) || 0, source: own.source || '' };
      else if (!(previousDelivery && toLocalPhoneDigits(previousDelivery.phone) === toLocalPhoneDigits(oldAddressPhone))) {
        const found = await lookupPreviousAddress(oldAddressPhone, { landingStore }).catch(() => null);
        if (found?.address) {
          previousDelivery = { phone: found.phone || oldAddressPhone, address: '', at: Number(found.at) || 0, source: found.source || '', foreign: { orderId: found.orderId || '', source: found.source || '' } };
          await noteForStaff(dependencies, conversation, `Khách xin gửi "địa chỉ cũ" theo SĐT ${oldAddressPhone}: có đơn ${found.source || 'ngoài'} ${found.orderId || ''} (không thuộc hội thoại này), địa chỉ đơn đó: ${found.address}. Bot không tự điền — nhân viên đối chiếu người nhận trước khi lên đơn.`, `đơn ${found.orderId || '?'}`);
        }
      }
    }
    // Xưng hô khóa một lần trong hội thoại (botGender): giới tính đoán từ tin/tên có thể đổi
    // giữa chừng, khách thấy "chị" rồi "anh". Nhân viên đặt tay (genderSource 'staff') vẫn thắng.
    const lockedGender = conversation.genderSource === 'staff' && conversation.gender
      ? conversation.gender
      : conversation.botGender || inboxThread?.botGender || conversation.gender || inboxThread?.gender || '';
    // Thẻ của hội thoại (bình luận đọc cả hộp thư cùng khách).
    const conversationLabels = [...(Array.isArray(conversation.labels) ? conversation.labels : []), ...(Array.isArray(inboxThread?.labels) ? inboxThread.labels : [])].map(String);
    // Không mời lên 2 túi khi hội thoại có khiếu nại/cần người xử lý, vừa nói chuyện sỉ/CTV,
    // hay đã mời một lần trong hội thoại (botUpsoldAt, hoặc lời mời còn trong lịch sử).
    const noUpsell = conversationLabels.some(label => /^(complaint|warranty|consulting|handoff)$/.test(label))
      || isComplaint({ text: message.text, keywords: settings.complaintKeywords })
      || conversation.botLastTemplateId === 'WHOLESALE_CTV_CONTACT'
      || Boolean(conversation.botUpsoldAt)
      || recent.some(item => item?.direction === 'outgoing' && /lấy 2 \S+ thì giá chỉ còn/iu.test(String(item.text || '')));
    const replyContext = { pendingOrder: conversation.pendingOrder, recentOrder, latestOrder, lastTemplateId: conversation.botLastTemplateId || '', previousDelivery, trial: trialState, trialBags: trialState ? trialBagOptions() : '', promoBowl: promoBowlActive(conversation), now: Date.now(), recentOutgoing: recent.filter(item => item?.direction === 'outgoing' && Date.now() - (Number(item.createdAt) || 0) < 30 * 60 * 1000).map(item => String(item.text || '')), messageText: String(message.text || ''), recentCustomerTexts: [...recentComments, ...recentCustomerTexts], noUpsell, customer: { gender: lockedGender, name: conversation.name || '' },
      // Khách livestream (bài live, thẻ Livestream — kể cả thẻ trong hộp thư Pancake): mẫu tính giá/quà mới kèm quà chỉ khách live.
      livestream: isLivestreamCustomer(conversation) || conversationLabels.includes('livestream') };
    // R13 (inbox1 A2): vị quà thay khách đã chọn (sau GIFT_SWAP, dưới 24 giờ) đi theo giỏ chờ tới khi lên đơn — giỏ lập sau
    // lúc chọn (hay bộ soạn đơn dựng lại giỏ) không được làm rơi lựa chọn.
    const chosenGiftSwap = Array.isArray(conversation.pendingOrder?.giftSwap) && conversation.pendingOrder.giftSwap.length
      ? conversation.pendingOrder.giftSwap
      : Array.isArray(conversation.giftSwapChoice?.choices) && conversation.giftSwapChoice.choices.length && Date.now() - (Number(conversation.giftSwapChoice.at) || 0) < 24 * 60 * 60 * 1000
        ? conversation.giftSwapChoice.choices : null;
    if (chosenGiftSwap && replyContext.pendingOrder && typeof replyContext.pendingOrder === 'object' && !replyContext.pendingOrder.giftSwap) {
      replyContext.pendingOrder = { ...replyContext.pendingOrder, giftSwap: chosenGiftSwap };
    }
    // Mốc tin Page gần nhất (nhân viên hay bot): nhân viên nhắn sau bot > 5 giây thì luật/gác coi là nhân viên đang trả lời.
    // R13 (QR): trước đây MỌI tin Page mới hơn lượt bot + 5 giây đều làm cờ "nhân viên trả lời sau bot" — kể cả tin ưu đãi
    // QR (sender 'bot'), tin bám đuổi (followUp), lời chào Botcake / AI Pancake / thẻ đơn POS (pancakeSender) → nhật ký và
    // đặc trưng mô hình ghi nhân viên đang trả lời trong khi không ai trả lời cả. Tách hai khái niệm:
    // - staffRepliedAfterBot: chỉ tin THẬT của nhân viên (cờ staff, hay tin Page không mang dấu máy gửi nào);
    // - contextChangedAfterBot: có BẤT KỲ tin Page nào sau lượt bot (nhân viên hay tin tự động: ưu đãi QR, bám đuổi…) —
    //   mẫu bot gửi lần cuối (botLastTemplateId) không còn là điều khách đang đáp, nên luật theo ngữ cảnh ("ok" sau bước
    //   đơn, SĐT trơn sau bảng giá…) không chạy với mẫu cũ. Luật nhận cờ này ở ctx.staffRepliedAfterBot như trước.
    const pageAfterBot = recent.filter(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > (Number(conversation.botLastReplyAt) || 0) + 5000);
    const staffRepliedAfterBot = pageAfterBot.some(isHumanPageMessage);
    const contextChangedAfterBot = pageAfterBot.length > 0;
    trace.ctx = decisionContext({ conversation, message, recentOrder, staffRepliedAfterBot, labels: conversationLabels, gender: lockedGender, livestream: replyContext.livestream });
    // Nhân viên đang xử lý hội thoại này (đọc 214 hội thoại 26–28/09: bot chen vào giữa lúc
    // nhân viên đang trao đổi, "Đúng rồi" của khách đáp câu hỏi của nhân viên mà bot cảm ơn):
    // nhân viên (tin Page mang cờ staff) nhắn sau lượt bot gần nhất trong 2 giờ, hay hội thoại
    // mang thẻ khiếu nại / bảo hành / cần người xử lý và nhân viên có nhắn trong 24 giờ → bot im.
    // Bình luận cũng đọc hộp thư cùng khách. Thẻ không có mốc giờ nên không im chỉ vì thẻ cũ
    // (khách quay lại mua sau nhiều tuần): cần nhân viên có nhắn mới tính.
    const staffMessagesOf = list => (Array.isArray(list) ? list : []).filter(item => item?.direction === 'outgoing' && item.staff);
    const inboxMessages = inboxThread && listMessages ? await listMessages(inboxThread.id).catch(() => []) : [];
    const staffMessages = [...staffMessagesOf(recent), ...staffMessagesOf(inboxMessages)];
    const botLastAt = Math.max(Number(conversation.botLastReplyAt) || 0, Number(inboxThread?.botLastReplyAt) || 0);
    const staffAfterBot = staffMessages.some(item => (Number(item.createdAt) || 0) >= botLastAt && Date.now() - (Number(item.createdAt) || 0) < 2 * 60 * 60 * 1000);
    // Vòng 12 (B1 #11): thẻ "cần người xử lý"/"tư vấn" (bot tự gắn rất thường: ảnh, câu khó…) chỉ giữ bot im khi nhân
    // viên nhắn trong 2 giờ; khiếu nại/bảo hành vẫn 24 giờ. Trước đây NV nhắn cuối 4,5 giờ trước + thẻ handoff → bot
    // im với "2 gói 1 vàng 1 xanh giá bn".
    const staffLabelled = conversationLabels.some(label => /^(complaint|warranty)$/.test(label));
    const staffRecently = staffMessages.some(item => Date.now() - (Number(item.createdAt) || 0) < 24 * 60 * 60 * 1000);
    const handoffLabelled = conversationLabels.some(label => /^(consulting|handoff)$/.test(label));
    const staffWithin2h = staffMessages.some(item => Date.now() - (Number(item.createdAt) || 0) < 2 * 60 * 60 * 1000);
    if (staffAfterBot || (staffLabelled && staffRecently) || (handoffLabelled && staffWithin2h)) {
      // Vòng 12 (B4 #4): bình luận ĐẶT HÀNG/hỏi giá trong lúc nhân viên đang chat hộp thư: không để bình luận trơ trọi
      // (35 phút không ai trả lời) — lời công khai ngắn "bạn phụ trách nhắn mình ngay" + thẻ cần người + ẩn SĐT.
      if (conversation.source === 'comment' && settings.responseMode === 'automatic' && message.type === 'text' && isOrderComment(message.text)) {
        const publicRecently = recent.some(item => item?.direction === 'outgoing' && Date.now() - (Number(item.createdAt) || 0) < 10 * 60 * 1000);
        await moderateBundledComments();
        const staffPublic = publicRecently ? null : renderChatbotReply({ template_id: 'COMMENT_PUBLIC_STAFF' }, templates, { customer: { gender: conversation.botGender || conversation.gender || '', name: conversation.name || '' } });
        for (const text of staffPublic?.templateId === 'COMMENT_PUBLIC_STAFF' ? pickVariant(staffPublic) : []) await sendMessage(conversation, { text }).catch(error => console.warn(`Lời công khai (NV đang xử lý) lỗi (${conversation.id}): ${error.message}`));
        // Không đổi botLastReplyAt: tin nhân viên trước mốc đó vẫn phải được tính là 'nhân viên đang xử lý' ở lượt sau.
        await saveBotState(conversation.id, { addLabelEvents: ['handoff'] }).catch(() => {});
        results.push({ conversationId: conversation.id, skipped: 'nhân viên đang xử lý', ...(staffPublic ? { publicNotice: true } : {}) });
        return;
      }
      results.push({ conversationId: conversation.id, skipped: 'nhân viên đang xử lý' });
      return;
    }
    // Bot vừa báo "nhân viên sẽ kiểm tra / nhắn lại" (ORDER_STATUS_CHECKING, CSKH_HANDOFF) dưới 24
    // giờ mà nhân viên chưa nhắn: khách nhắn tiếp → WAITING_STAFF đúng một lần, các tin sau im —
    // không bao giờ "chưa thấy đơn nào" / "em vừa gửi ở trên" (ca Hải Yến Trân → "Buôn bán kiểu gì vậy").
    const staffSinceBot = staffMessages.some(item => (Number(item.createdAt) || 0) >= (Number(conversation.botLastReplyAt) || 0));
    const waitingAge = Date.now() - (Number(conversation.botLastReplyAt) || 0);
    if (conversation.source !== 'comment' && !staffSinceBot && waitingAge < 24 * 60 * 60 * 1000 && !['sticker', 'ad'].includes(message.type)) {
      if (conversation.botLastTemplateId === 'WAITING_STAFF') {
        results.push({ conversationId: conversation.id, skipped: 'đang chờ nhân viên' });
        return;
      }
      // R13: giỏ Shop bot không tự lên đơn (mã lạ / yến mạch — đã báo "bạn phụ trách nhắn lại") cũng là đang chờ nhân viên:
      // khách gửi SĐT/địa chỉ thì không bị hỏi "lấy Túi Xanh hay Vàng". Khách bấm giỏ MỚI thì xử lý giỏ đó như thường.
      const waitingForStaff = ['ORDER_STATUS_CHECKING', 'CSKH_HANDOFF'].includes(conversation.botLastTemplateId)
        || (['SHOP_CART_STAFF', 'SHOP_CART_UNKNOWN'].includes(conversation.botLastTemplateId) && !message.cart?.length && !misclickPattern.test(foldVietnamese(String(message.text || ''))));
      if (waitingForStaff) {
        const waiting = renderChatbotReply({ template_id: 'WAITING_STAFF' }, templates, replyContext);
        if (waiting.templateId === 'WAITING_STAFF') {
          if (settings.responseMode === 'automatic') for (const text of waiting.messages) await sendMessage(conversation, { text });
          await saveBotState(conversation.id, { botLastTemplateId: 'WAITING_STAFF', botLastReplyAt: Date.now(), botDraft: settings.responseMode === 'draft' ? waiting.messages.join('\n\n') : '', addLabelEvents: ['handoff'] });
          results.push({ conversationId: conversation.id, mode: settings.responseMode, templateId: 'WAITING_STAFF' });
          return;
        }
      }
    }
    // Khách chỉ để ".", "ib", "bn", "xin giá"… dưới bài/quảng cáo có sản phẩm cụ
    // thể: gửi thẳng bảng giá sản phẩm đó, không đưa danh sách chung để khách phải chọn.
    const folded = foldVietnamese(String(message.text || '').trim()).replace(/\s+/g, ' ');
    // Tin mảnh (chỉ SĐT, "đó a", tên người…) khi đang lấy thông tin đơn, hoặc bot
    // vừa hỏi ở bước lên đơn, hoặc tin chỉ toàn số: đợi vài giây cho tin kế tiếp
    // của khách tới để gộp, tránh xin lại thứ khách vừa gửi. Bình luận liên tiếp
    // ("1 vàng 1 xanh" rồi "1 xanh 1 vàng") cũng gộp thành một câu trả lời.
    const shortText = String(message.text || '').trim();
    const digitsOnly = /^\+?\d[\d .-]{7,}$/.test(shortText);
    // Tin chỉ là lời chào ("Hi", "shop ơi"): câu hỏi thật thường tới ngay sau —
    // chờ để trả lời gộp, không chào trước rồi mới trả lời.
    const greetingOnly = /^(hi|hello|helo|alo|a lo|chao|xin chao|chao (shop|em|ban|chi|anh)|(shop|em|chi|ad|admin|ban) (oi|ơi)|oi)[.!\s]*$/i.test(foldVietnamese(shortText));
    // SĐT rồi địa chỉ (hay ngược lại) thường là hai tin liền nhau: tin chỉ SĐT ("sđt 09…", "0909… nha")
    // và tin chỉ địa chỉ (có xã/phường/quận/đường…) cũng đợi để gộp — trước đây bot gửi
    // ORDER_ADDRESS_PARTIAL rồi ORDER_CONFIRMATION cùng phút. Tin chỉ SĐT đợi lâu gấp đôi.
    const phoneFragment = message.type === 'text' && Boolean(extractVietnamesePhone(shortText)) && shortText.replace(/\+?\d[\d .-]{8,13}/g, ' ').replace(/\s+/g, ' ').trim().length < 40;
    const addressFragment = message.type === 'text' && shortText.length < 160 && /\b(xa|huyen|quan|phuong|thi tran|thi xa|tp|thanh pho|duong|thon|ap|kp|khu pho|so nha|ngo|hem|to)\b/.test(foldVietnamese(shortText))
      && (conversation.pendingOrder || isOrderStep(conversation.botLastTemplateId) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET', 'PRICE_QUOTE', 'GENERAL_INFO'].includes(conversation.botLastTemplateId));
    const waitForFragments = message.type === 'text' && (
      conversation.source === 'comment'
      || greetingOnly
      || phoneFragment
      || addressFragment
      || ((conversation.pendingOrder || isOrderStep(conversation.botLastTemplateId) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(conversation.botLastTemplateId) || digitsOnly) && shortText.length < 40)
    );
    if (waitForFragments) {
      const baseWaitMs = Number(settings.fragmentWaitMs ?? 4000);
      await new Promise(resolve => setTimeout(resolve, phoneFragment ? Number(settings.phoneFragmentWaitMs ?? baseWaitMs * 2) : baseWaitMs));
      if (hasNewerCustomerMessage(await listMessages(conversation.id), change.message)) {
        results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
        return;
      }
    }
    // Bot vừa hỏi số lượng/vị/SĐT/địa chỉ thì "1", "?"… là câu trả lời, không phải xin giá.
    const collectingOrder = isOrderStep(conversation.botLastTemplateId) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(conversation.botLastTemplateId);
    const terse = message.type === 'text' && !collectingOrder && /^(\.+|…|ib|inbox|in box|bn|gia|xin gia|gia bao nhieu|bao nhieu|bao gia|cho hoi gia|gia sao|gia the nao|gia ntn|\?|\+1|1|\.ib|ib\.)$/i.test(folded);
    const contextProduct = terse ? resolveConversationProduct({ adTitle: conversation.referral?.adTitle, referralRef: conversation.referral?.ref, postText: conversation.post?.message }).product : '';
    const quickQuote = terse && productHint(contextProduct) && templates?.PRICE_QUOTE
      ? renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: contextProduct }, templates, replyContext)
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
    // Vòng 12: ảnh tới ngay sau tin chữ bot VỪA trả lời (≤ 60 giây): không hỏi "cần hỗ trợ gì về hình" — ảnh chuyển khoản
    // thì báo đã nhận + nhân viên kiểm tra; ảnh khác: thẻ cần người xem ảnh, im.
    // R13: như phần gộp ở trên — ảnh, video, tệp đều tính (không chỉ `image`).
    const nearbyTexts = nonText && !['sticker', 'ad', 'order-receipt'].includes(message.type) && !message.withImage ? recent.filter(item => item?.direction === 'incoming' && (item.type || 'text') === 'text' && item.id !== change.message.id
      && String(item.text || '').trim() && Math.abs((Number(item.createdAt) || 0) - imageAt) <= 60 * 1000) : [];
    const paymentWords = /\b(ck|chuyen khoan|chuyen tien|bill|da thanh toan|thanh toan roi|stk)\b/;
    // R13 (inbox3 F4): ảnh bill thường tới 1–5 phút sau khi khách nói chuyển khoản (mở app ngân hàng, chụp màn hình) — trước
    // đây quá 60 giây là ảnh bị coi như ảnh sản phẩm và nhận bảng giá. Trong 60 giây: mọi tin nhắc chuyển khoản; 60 giây – 5
    // phút: tin nhắc chuyển khoản mà không phải câu hỏi ("chuyển khoản được không?" rồi gửi ảnh túi thì không phải bill).
    const paidTextBeforeImage = nonText && !['sticker', 'ad', 'order-receipt'].includes(message.type) && recent.some(item => {
      if (item?.direction !== 'incoming' || (item.type || 'text') !== 'text' || item.id === change.message.id) return false;
      const gap = imageAt - (Number(item.createdAt) || 0);
      if (gap < 0 || gap > 5 * 60 * 1000) return false;
      const said = foldVietnamese(String(item.text || ''));
      return paymentWords.test(said) && !/\?|\b(?:duoc|dc) (?:khong|ko|k|hong)\b|\b(?:khong|ko|hong)(?: (?:a|em|e|shop|ban|vay|nhi|ha))*\s*$/.test(said);
    });
    const imageAfterPaidText = nearbyTexts.some(item => paymentWords.test(foldVietnamese(item.text))) || paidTextBeforeImage;
    if (nearbyTexts.length && !imageAfterPaidText && conversation.source !== 'comment') {
      await saveBotState(conversation.id, { addLabelEvents: ['handoff'] }).catch(() => {});
      results.push({ conversationId: conversation.id, skipped: 'ảnh kèm tin chữ vừa trả lời' });
      return;
    }
    // Ảnh khách gửi: Gemini (Vertex) xem ảnh cùng lịch sử — ảnh quảng cáo/bao bì
    // thì nhận ra sản phẩm và đi tiếp (báo giá, lên đơn); model không rõ ảnh
    // là gì thì trả IMAGE_RECEIVED và bot gắn thẻ cho nhân viên xem.
    const seesImage = nonText && message.type === 'image' && settings.provider === 'vertex' && settings.visionEnabled !== false && (message.dataUrl || message.images?.length);
    // Khách đã có đơn trong 24 giờ (chưa hủy).
    const hasOrder = Boolean(recentOrder?.id) && Date.now() - (Number(recentOrder.createdAt) || 0) < 24 * 60 * 60 * 1000
      && isActiveOrder(recentOrder);
    // Ảnh model không đọc ra, khách đến từ quảng cáo/bài của MỘT sản phẩm và chưa
    // có đơn: gửi bảng giá sản phẩm đó (ảnh thường là ảnh quảng cáo chụp lại),
    // vẫn gắn thẻ để nhân viên xem ảnh. Trước đây "mình cần hỗ trợ gì về hình
    // này" làm khách im luôn.
    const adQuote = () => {
      // Vòng 12 (B2 #23, B3 #1): ảnh từ quảng cáo/bài live → lời chào live (giá + quà live), không "đã nhận hình".
      if (conversation.source !== 'comment' && !hasOrder && replyContext.livestream && templates?.LIVESTREAM_COMMENT) return renderChatbotReply({ template_id: 'LIVESTREAM_COMMENT' }, templates, replyContext);
      if (conversation.source === 'comment' || hasOrder || isLivestreamPost(conversation) || !templates?.PRICE_QUOTE) return null;
      const product = resolveConversationProduct({ adTitle: conversation.referral?.adTitle, referralRef: conversation.referral?.ref, postText: conversation.post?.message }).product;
      return productHint(product) ? renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: product }, templates, replyContext) : null;
    };
    const imageFallback = () => ({ ...(adQuote() || renderChatbotReply({ template_id: templates?.IMAGE_RECEIVED ? 'IMAGE_RECEIVED' : 'CSKH_HANDOFF' }, templates || {}, replyContext)), attention: true });
    // Khách bấm "Mua"/"Gửi giỏ hàng" ở Facebook Shop: SKU đã rõ, không cần model.
    // R13: giỏ lấy nguyên từ mã Shop → `fromCart` đi theo ngữ cảnh soạn của cả lượt (bộ soạn đơn không chỉnh món theo chữ tin giỏ).
    // (Tin giỏ về qua đường không kèm mảng cart — chữ tự sinh "Khách chọn mua từ Facebook Shop…" — cũng tính.)
    if (message.cart?.length || (message.type === 'text' && isShopCartText(message.text))) replyContext.fromCart = true;
    const cartReply = message.cart?.length ? cartQuickReply(message.cart, templates, replyContext) : null;
    // Khách thanh toán luôn trong Facebook Shop: Pancake tạo đơn POS (có SĐT, địa
    // chỉ) vài chục giây sau tin giỏ. Có đơn đó thì báo đã nhận, không xin lại
    // thông tin khách vừa điền (trước đây khách phải nhắn "chị đặt trên web rồi").
    // R13 (inbox2 B6): món và tổng tiền trong câu "đã nhận đơn … – tổng …" phải lấy từ CÙNG một nguồn là đơn POS tìm được.
    // Trước đây món lấy từ giỏ vừa bấm còn tổng lấy từ đơn POS (có khi là đơn của giỏ trước): "đã nhận đơn 1 Túi Xanh – tổng
    // 298.000đ". Đơn POS không kèm dòng hàng thì mới dùng giỏ vừa bấm.
    const shopOrderReply = found => {
      const lines = Array.isArray(found?.items) ? found.items : [];
      const parsedOrder = lines.length ? parseShopCart(lines.map(item => ({ sku: item.sku, quantity: item.quantity, name: item.name }))) : null;
      const orderLines = parsedOrder && !parsedOrder.needsStaff && !parsedOrder.unknown && parsedOrder.items?.length
        ? parsedOrder.items.map(item => `${item.quantity} ${item.name}`)
        : lines.map(item => `${item.quantity} ${findProductBySku(item.sku)?.name || item.name}`);
      const cartLines = (cartReply?.pendingOrder?.items || []).map(item => `${item.quantity} ${item.product}`);
      return {
        ...renderChatbotReply({
          template_id: 'SHOP_ORDER_RECEIVED',
          values: {
            cart: (orderLines.length ? orderLines : cartLines).join(' + '),
            total: found.total ? `${found.total.toLocaleString('vi-VN')}đ` : ''
          }
        }, templates, replyContext),
        pendingOrder: null,
        // Mã đơn POS vừa báo "đã nhận": lưu lại (shopOrderAck) để giỏ bấm sau đó không nhận lại đúng đơn này.
        shopOrderId: String(found?.id || '')
      };
    };
    // Tra một lần ngay (không bắt khách chờ); chưa có thì trả lời như thường và
    // tra lại ở nền (followUpShopOrder) — đơn Shop thường vào POS sau 0–2 phút.
    const canFindShopOrder = Boolean(cartReply && dependencies.findShopOrder && templates?.SHOP_ORDER_RECEIVED && conversation.pancakeConversationId);
    const cartSince = (Number(change.message?.createdAt) || Date.now()) - 5 * 60 * 1000;
    // R13 (inbox2 B6, ca thật 01/10 12:41): khách bấm giỏ THỨ HAI vài phút sau khi đơn của giỏ trước đã được báo "đã nhận" —
    // đơn POS tìm thấy vẫn là đơn cũ (trong cửa sổ 5 phút) → bot báo nhận đơn lần nữa với món của giỏ mới và tổng của đơn cũ.
    // Đơn đã báo nhận (conversation.shopOrderAck.id) không tính là đơn của giỏ mới.
    const ackedShopOrderId = String(conversation.shopOrderAck?.id || '');
    const freshShopOrder = found => (found && ackedShopOrderId && String(found.id || '') === ackedShopOrderId ? null : found || null);
    let shopOrder = canFindShopOrder ? freshShopOrder(await dependencies.findShopOrder(conversation, { since: cartSince }).catch(() => null)) : null;
    // Vòng 12 (B2 #9, B3 #19): đơn Shop thường vào POS sau 0–2 phút — chờ tới ~60 giây (tra mỗi 20 giây) trước khi xin SĐT, để
    // không vừa xin SĐT vừa 2 phút sau báo "không cần gửi lại SĐT". Khách nhắn thêm trong lúc chờ → nhường tin sau.
    const shopWaitMs = Number(settings.shopOrderWaitMs ?? (process.env.NODE_TEST_CONTEXT ? 0 : 60000));
    // R13 (inbox1 C8): không để khách chờ 60 giây im lặng — gửi NGAY một tin ngắn ghi nhận giỏ rồi mới chờ kiểm đơn; giỏ
    // được giữ luôn (khách gửi SĐT trong lúc chờ thì lượt sau đã có giỏ, không hỏi lại vị). Sau khi chờ: có đơn POS → "đã
    // nhận đơn, không cần gửi SĐT"; không có → mới xin SĐT/địa chỉ. Không còn cặp "xin SĐT" rồi "không cần gửi lại SĐT"
    // trong 60 giây đầu. Chỉ với giỏ bot đọc được (bước xin SĐT/địa chỉ), chế độ tự động.
    let cartAckSent = false;
    if (canFindShopOrder && !shopOrder && shopWaitMs > 0 && settings.responseMode === 'automatic' && cartReply.templateId === 'ORDER_ADDRESS'
      && cartReply.pendingOrder?.items?.length && templates?.SHOP_CART_ACK) {
      const ack = renderChatbotReply({ template_id: 'SHOP_CART_ACK', values: { cart: cartReply.pendingOrder.items.map(item => `${item.quantity} ${item.product}`).join(' + ') } }, templates, replyContext);
      if (ack.templateId === 'SHOP_CART_ACK') {
        for (const text of ack.messages) await sendMessage(conversation, { text });
        await saveBotState(conversation.id, { botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now(), pendingOrder: cartReply.pendingOrder }).catch(() => {});
        cartAckSent = true;
      }
    }
    // (Giỏ nhân viên lên đơn / mã lạ không chờ: lời "bạn phụ trách nhắn lại" đi ngay; đơn POS thấy sau thì lượt tra nền báo.)
    for (let waited = 0; canFindShopOrder && !shopOrder && !cartReply.shopCartStaff && waited < shopWaitMs; waited += 20000) {
      await wait(Math.min(20000, shopWaitMs - waited));
      if (hasNewerCustomerMessage(await listMessages(conversation.id).catch(() => recent), change.message)) {
        results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
        return;
      }
      shopOrder = freshShopOrder(await dependencies.findShopOrder(conversation, { since: cartSince }).catch(() => null));
    }
    // Dưới bình luận, câu trả lời theo luật khi không có model: bảng giá sản
    // phẩm của bài, lời chào live, hay bảng giá chung.
    const postProduct = conversation.source === 'comment'
      ? resolveConversationProduct({ adTitle: conversation.referral?.adTitle, referralRef: conversation.referral?.ref, postText: conversation.post?.message }).product
      : '';
    const commentRuleReply = () => renderChatbotReply(
      productHint(postProduct) && templates?.PRICE_QUOTE ? { template_id: 'PRICE_QUOTE', Product_N1: postProduct } : { template_id: 'GENERAL_INFO' },
      templates, replyContext
    );
    const askModel = async (extra = {}) => {
      // Vòng 12 (B5 #15): 25 lượt đã gọi LLM rồi mới gộp tin — khách đã nhắn tiếp trong lúc engine chờ gộp mảnh / tra đơn:
      // kiểm lại ngay TRƯỚC khi gọi mô hình, nhường cho tin sau (không tốn lượt LLM).
      if (hasNewerCustomerMessage(await listMessages(conversation.id).catch(() => recent), change.message)) throw new NewerMessageSkip();
      try {
        const answer = await requestReply({ settings, conversation: { ...conversationForModel, ...extra }, message, recentMessages: recent.filter(item => !bundled.has(item?.id)), context: replyContext });
        // Nhật ký: lượt LLM gần nhất (hint: lý do gọi lại — giỏ đang giữ mà khách hỏi; dùng thử).
        trace.llm = {
          templateId: answer?.templateId || '',
          retried: Boolean(answer?.retried),
          hint: extra.hintLabel || (extra.replyHint ? 'basket-question' : extra.trialHint ? 'trial' : ''),
          usage: answer?.usage || null,
          model: answer?.model || '',
          calls: (trace.llm?.calls || 0) + 1
        };
        if (Array.isArray(answer?.fewShot)) trace.fewShot = answer.fewShot;
        return answer;
      } catch (error) {
        // Model hết hạn mức/quá tải dưới bình luận: không để bình luận rơi —
        // trả lời theo luật (bảng giá bài viết / lời chào live / bảng giá chung).
        if (conversation.source === 'comment' && isCapacityError(error) && templates?.GENERAL_INFO) {
          console.warn(`Model lỗi dưới bình luận (${conversation.id}): ${error.message} — trả lời theo luật.`);
          return commentRuleReply();
        }
        throw error;
      }
    };
    // Lời đáp ngắn ("ok", "dạ", "cảm ơn") của khách.
    // Lời đáp ngắn, hay chỉ emoji/sticker chữ ("💕", "🥰🥰") sau đơn: cảm ơn, không hỏi mô hình.
    // Chữ một ký tự (a/c/e/u) chỉ đứng một mình hay làm đuôi ("dạ a", "ok c"): ghép tự do
    // từng biến "ủa" (u+a), "đâu" (da+u), "ca" (c+a) thành lời cảm ơn.
    // Vòng 11 (V9): "vàng" còn dấu là chọn Túi Vàng, không phải "vâng".
    const shortAck = message.type === 'text' && !/vàng/iu.test(String(message.text || '').normalize('NFC')) && (/^(?:(?:ok|oke|okie|okay|okela|da|vang|uh|um|nhe|nha|shop|cam ?on|thanks?|tks|\.|👍|❤️)+(?:a|c|e)?|[aceu])$/i.test(folded.replace(/\s+/g, ''))
      || (/^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s.!]+$/u.test(String(message.text || '')) && /\p{Extended_Pictographic}/u.test(String(message.text || ''))));
    // "ok" ngay sau tin xác nhận/sửa đơn: cảm ơn luôn, không hỏi mô hình — mô hình
    // từng đọc lịch sử cũ và trả lời "ok" bằng tư vấn mẹ bầu/tiểu đường.
    const orderJustClosed = ['ORDER_CONFIRMATION', 'ORDER_UPDATE', 'ORDER_UNCHANGED', 'ORDER_NOTE', 'SHOP_ORDER_RECEIVED'].includes(conversation.botLastTemplateId);
    // Chỉ emoji ("🥰", "👍") ngay sau lời cảm ơn / tin đơn hàng: không cần trả lời gì thêm.
    const emojiOnly = message.type === 'text' && /^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s.!]+$/u.test(String(message.text || '')) && /\p{Extended_Pictographic}/u.test(String(message.text || ''));
    if (emojiOnly && (conversation.botLastTemplateId === 'THANK_YOU' || String(conversation.botLastTemplateId || '').startsWith('ORDER_'))) {
      results.push({ conversationId: conversation.id, skipped: 'chỉ emoji' });
      return;
    }
    const ackReply = shortAck && orderJustClosed && templates?.THANK_YOU
      ? renderChatbotReply({ template_id: 'THANK_YOU' }, templates, replyContext)
      : null;
    // Giỏ đang giữ (còn hạn) và bot vừa ở bước đơn.
    const basketHeld = Boolean(usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items?.length);
    // R13: bộ soạn mẫu biết khách đã có đơn (24 giờ, chưa hủy) — mẫu quà mời đặt đổi sang câu nói quà của chính đơn đó.
    // Đang giữ GIỎ MỚI sau đơn thì vẫn là lời mời/quà của giỏ mới.
    replyContext.hasOrder = hasOrder && !basketHeld;
    const orderStepLast = isBasketStep(conversation.botLastTemplateId) || conversation.botLastTemplateId === 'PRICE_ONE_BAG';
    // Lời "có/ok/gửi đi" sau khi bot hỏi "cần bảng giá combo gói nhỏ không?" (PACKAGING_INFO):
    // gửi bảng giá Combo 10 gói theo màu khách đang nói (mặc định Xanh), không hỏi mô hình.
    const ackCore = folded.replace(/[.!?…,]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/(?: (?:a|nha|nhe|shop|em|e|c|chi|anh|di|voi|luon))+$/, '');
    const yesAck = shortAck || (ackCore.length > 0
      && /^(?:(?:ok|oke|okie|okay|oki|da|vang|co|duoc|dc|u|uh|ua)\s*)*(?:(?:gui|xin|cho xin|cho|xem|coi)\s*)?(?:(?:di|em|minh|luon|bang gia|thu|coi|xem|cho (?:em|minh|chi|c|a|anh))\s*)*$/.test(ackCore));
    const comboQuote = (() => {
      if (!yesAck || conversation.botLastTemplateId !== 'PACKAGING_INFO' || !templates?.PRICE_QUOTE) return null;
      const mentioned = [...replyContext.recentCustomerTexts, String(message.text || '')].map(text => foldVietnamese(text)).join(' ').match(/\b(xanh|nau|cacao|cam|mix)\b/g) || [];
      const colour = (mentioned.at(-1) || 'xanh').replace('cacao', 'nau');
      const combo = getCatalogProducts().find(item => item.active !== false && /^CB10-/i.test(String(item.sku || '')) && String(item.sku || '').toLowerCase().includes(`-${colour}`))
        || getCatalogProducts().find(item => item.active !== false && /^CB10-XANH/i.test(String(item.sku || '')));
      return combo ? renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: combo.name }, templates, replyContext) : null;
    })();
    // "Ok/Dạ/👍" khi giỏ còn thiếu SĐT/địa chỉ: nhắc ngắn giỏ + phần còn thiếu, không cảm ơn suông.
    const remindAck = (() => {
      if (!shortAck || !basketHeld || !orderStepLast || orderJustClosed) return null;
      const held = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, replyContext);
      return held.remind ? { templateId: 'ORDER_ADDRESS_REMIND', messages: [held.remind], images: [], handoff: false } : null;
    })();
    // Sau khi bot gửi thông tin chuyển khoản (BANK_TRANSFER): khách gửi ảnh hay "ck rồi / chuyển xong"
    // là bill → báo đã nhận, nhân viên kiểm tra và lên đơn (gắn thẻ); không "đã nhận hình, cần hỗ trợ gì".
    const paidText = message.type === 'text' && (/\b(?:ck|chuyen khoan|chuyen tien|chuyen|thanh toan|tt)(?: tien)?(?: cho (?:em|shop|minh|ben em))? (?:roi|xong|r|thanh cong)\b/.test(folded) || /\b(?:da|vua|moi) (?:ck|chuyen khoan|chuyen tien|thanh toan|chuyen)\b/.test(folded));
    // Vòng 12 (B1 #5): ảnh kèm/ngay sau "Mình chuyển khoản" = ảnh bill (không cần mẫu trước là BANK_TRANSFER).
    const billWithImage = (message.withImage && paymentWords.test(folded)) || (nonText && imageAfterPaidText);
    // R13: mẫu trước là PAYMENT_METHODS (bot vừa nói về cách thanh toán, dưới 60 phút) mà khách gửi ảnh / "ck rồi" cũng là bill.
    const afterPaymentInfo = conversation.botLastTemplateId === 'BANK_TRANSFER'
      || (conversation.botLastTemplateId === 'PAYMENT_METHODS' && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 60 * 60 * 1000);
    const paymentReply = (afterPaymentInfo && (message.type === 'image' || paidText)) || billWithImage
      ? (() => { const paid = renderChatbotReply({ template_id: 'PAYMENT_RECEIVED_CHECK' }, templates, replyContext); return paid.templateId === 'PAYMENT_RECEIVED_CHECK' ? { ...paid, attention: true } : null; })()
      : null;
    // Đang chờ khách xác nhận đặt THÊM đơn (đã có đơn trong 7 ngày, xem ORDER_EXISTING_CONFIRM bên dưới):
    // "đúng/ok/lên đơn" → chốt giỏ đang giữ; "không/đơn cũ/kiểm tra" → kể đơn cũ, gắn thẻ cho nhân viên.
    // Chỉ đọc yes/no khi bot VỪA hỏi (mẫu gần nhất là ORDER_EXISTING_CONFIRM) và giỏ chờ còn hạn.
    // "Yes" phải là cả câu đáp ngắn ("đúng rồi e", "ok lên đơn đi"): "Dạ cảm ơn shop", "Đã đặt rồi mà"
    // mở đầu bằng dạ/đã không phải đồng ý. Tin nêu túi/số lượng/đổi giỏ/câu hỏi để luật/mô hình đọc
    // (giỏ mới sẽ được hỏi lại ở ORDER_EXISTING_CONFIRM bên dưới).
    const awaitingAsked = conversation.botLastTemplateId === 'ORDER_EXISTING_CONFIRM' && Boolean(conversation.pendingOrder?.awaitingConfirm);
    const awaitingPending = awaitingAsked ? usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' }) : null;
    // Đã hỏi "đặt thêm?" trong 30 phút (pendingOrder.at là lúc hỏi): không hỏi lại lần hai trong cùng
    // hội thoại — khách nhắn tin khác có/không thì xử lý bình thường, giữ cờ chờ (log: hỏi 2 lần trong 4 phút).
    const awaitingRecent = Boolean(conversation.pendingOrder?.awaitingConfirm) && Date.now() - (Number(conversation.pendingOrder?.at) || 0) < 30 * 60 * 1000;
    // Dấu câu bỏ hết ("Đúng rồi, lên đơn giúp chị" cũng là đồng ý); "đơn mới" không số/không màu chính là đồng ý.
    // Vòng 11 (P4): đọc có/không trên tin CUỐI của khách (không phải cụm gộp: "2 túi vàng nhé\nđúng rồi" là đồng ý).
    // Câu hỏi có chữ "không" ("bát gáo dừa có tặng không", "giao nhanh không em") KHÔNG phải trả lời "không":
    // chỉ là "không" khi tin mở đầu bằng từ phủ định, hay nói về đơn cũ (hủy, đơn cũ/trước, nhầm, kiểm tra,
    // không phải…) mà không ở dạng hỏi "có/được … không".
    const awaitingText = foldVietnamese(String(change.message?.text || '')).trim().replace(/[,;:.!…]+/g, ' ').replace(/\s+/g, ' ').trim();
    const awaitingOther = /\d|\?/.test(awaitingText) || /\b(tui|goi|bich|xanh|vang|nau|cacao|combo|doi|sua|dia chi)\b/.test(awaitingText);
    const awaitingStartsNo = /^(?:khong|ko|kg|k|hong|khum|hok|thoi|chua)\b/.test(awaitingText);
    const awaitingQuestion = !awaitingStartsNo && (/\b(?:co|duoc|dc)\b.{0,40}\b(?:khong|ko|kg|k|hong)\b/.test(awaitingText)
      || /\b(?:khong|ko|kg|hong)(?: (?:a|em|e|shop|ban|b|nhi|vay|v|z|ha|chi|c|anh))*$/.test(awaitingText));
    // Vòng 12 (B3 #7): "Mình lấy 1 đơn thôi", "chỉ 1 đơn", "bỏ bớt 1 đơn" = KHÔNG đặt thêm (chữ số "1" từng làm awaitingOther đúng).
    const onlyOneOrder = /\b(?:1|mot) don (?:thoi|la du|la duoc)\b|\bchi (?:1|mot) don\b|\bbo bot\b|\b(?:1|mot) don thoi\b/.test(awaitingText);
    const awaitingNo = Boolean(awaitingPending) && message.type === 'text' && ((!awaitingOther && !awaitingQuestion
      && (awaitingStartsNo || /\b(huy|don cu|don do|don kia|don truoc|nham|kiem tra|check|xem lai|(?:khong|ko|k|hong) phai)\b/.test(awaitingText))) || onlyOneOrder);
    const awaitingYes = Boolean(awaitingPending) && !awaitingNo && message.type === 'text' && !awaitingOther && awaitingText.length <= 40
      && /^(?:da|vang|dung|chuan|ok|oke|okie|okay|oki|co|u|uh|uk|um|uhm|phai|len don|chot|yes|dat|dat them|dat luon)(?: (?:a|roi|r|nha|nhe|nhen|em|e|shop|c|chi|anh|di|luon|nhe shop|nha shop|len don|len don moi|don moi|moi|dat them|dat|chot|dung|ok|da|vang|phai|vay|the|cho (?:em|minh|chi|anh|c|e)|giup (?:em|minh|chi|c|e)))*$/.test(awaitingText);
    const existingConfirmReply = awaitingYes
      ? renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Phone_Number: awaitingPending.phone || '0', Customer_Address: awaitingPending.address || '0' }, templates, replyContext)
      // "Không": kể lại đơn đang có — đơn trong hội thoại, hay đơn ngoài (landing/POS) đã lưu kèm giỏ chờ.
      // C2 (01/10): đơn ngoài (landing/POS theo SĐT, không thuộc hội thoại) không được kể lại — nhân viên tra (ORDER_STATUS_CHECKING).
      : awaitingNo ? (!recentOrder && conversation.pendingOrder?.externalOrder && templates?.ORDER_STATUS_CHECKING
        ? { ...renderChatbotReply({ template_id: 'ORDER_STATUS_CHECKING' }, templates, replyContext), attention: true, pendingOrder: null }
        : { ...renderChatbotReply({ template_id: 'ORDER_STATUS' }, templates, { ...replyContext, recentOrder: recentOrder || conversation.pendingOrder?.externalOrder || null }), attention: true, pendingOrder: null }) : null;
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
      ? renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: quoted.name, No_A: String(chosenQuantity) }, templates, replyContext)
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
      // C2 (01/10): hội thoại này không có đơn nào, nên đơn tìm theo SĐT là của hội thoại KHÁC — không kể món/giờ/tổng
      // tiền cho người đang nhắn (gõ SĐT người khác là đọc được đơn của họ). Báo nhân viên tra + thẻ + ghi chú.
      if (found.length) await noteForStaff(dependencies, conversation, `Khách hỏi đơn đã đặt theo SĐT ${phoneInText}: có ${found.length} đơn ở hội thoại khác (${found.map(order => order.id).join(', ')}). Bot không kể chi tiết — nhân viên đối chiếu và trả lời.`, `${found.length} đơn theo SĐT ở hội thoại khác`);
      lookupReply = templates?.ORDER_STATUS_CHECKING
        ? { ...renderChatbotReply({ template_id: 'ORDER_STATUS_CHECKING' }, templates, replyContext), attention: true }
        : null;
    }
    // Khách vừa đặt dặn thêm về giao hàng ("gửi hàng mới cho mình", "giao giờ hành
    // chính", "gọi trước khi giao"): ghi chú vào đơn, trả lời ngắn — mô hình từng
    // chọn ORDER_STATUS và gửi lại cả đoạn trạng thái đơn khách vừa đọc xong.
    // Chỉ lời dặn THUẦN: hộp thư, tin ngắn, không SĐT/số nhà/sản phẩm, không kèm
    // sửa địa chỉ, đặt thêm, bớt túi hay câu hỏi — những tin đó để mô hình xử lý.
    const deliveryNote = !nonText && hasOrder && conversation.source !== 'comment' && templates?.ORDER_NOTE_ADDED
      && folded.length <= 80 && !phoneInText && !/\d{2,}/.test(folded) && !namesProducts
      && /\b(hang moi|date moi|han (su dung |dung )?(dai|xa|moi|lau)|moi san xuat|giao (gio hanh chinh|buoi|sang|chieu|toi|cuoi tuan|truoc|sau|nhanh|som)|goi (truoc|dien truoc|cho (minh|em|chi|anh|c|e) truoc)|de (o|tai|cho) (bao ve|le tan|cong|nha ben|hang xom)|gui (som|nhanh|gap)|dong goi (can than|ky)|(ngoai )?gio hanh chinh)\b/.test(folded)
      && !/\?|\b(huy|doi|them|nua|bot|sua|lay|dat|mua|dia chi|sdt|so dien thoai|khong lay|chua nhan|bi loi|bi hu|khi nao|bao gio|duoc khong|dc khong|ko|khong)\b/.test(folded);
    const noteReply = deliveryNote ? renderChatbotReply({ template_id: 'ORDER_NOTE' }, templates, replyContext) : null;
    // R13 (inbox1 A2): bot vừa hỏi "lấy 2 gói vị nào" (GIFT_SWAP, dưới 60 phút — conversation.giftSwapAskedAt) và khách chọn
    // vị ("2g nhỏ nâu đi shop", "1 xanh 1 cam", "cam"): ghi nhận quà thay, KHÔNG hỏi lại "vị nào". Đang giữ giỏ → lưu
    // pendingOrder.giftSwap (bộ soạn đơn đổi quà khi chốt) + nhắc giỏ; đã có đơn → ghi chú vào đơn như cũ; luôn gắn thẻ.
    // "2 túi xanh" (đặt túi lớn), câu hỏi, tin có SĐT không phải chọn quà.
    const giftSwapChoice = (() => {
      const askedAt = Number(conversation.giftSwapAskedAt) || 0;
      if (nonText || conversation.source === 'comment' || !askedAt || Date.now() - askedAt > 60 * 60 * 1000 || phoneInText || asksForHuman) return null;
      if (shortText.length > 80 || /\?/.test(shortText) || /\b(gia|bao nhieu|bn)\b/.test(folded)) return null;
      if (/\b(tui|bich|hop|combo)\b/.test(folded) && !/\b(goi|nho|qua)\b|\d ?g\b/.test(folded)) return null;
      const choices = parseGiftSwapChoice(String(message.text || ''));
      return Array.isArray(choices) && choices.length ? choices : null;
    })();
    const giftChoiceReply = giftSwapChoice ? (() => {
      const counts = new Map();
      for (const choice of giftSwapChoice) counts.set(choice.name, (counts.get(choice.name) || 0) + 1);
      const giftText = [...counts.entries()].map(([name, count]) => `${count} ${name}`).join(' + ');
      const noted = renderChatbotReply({ template_id: 'GIFT_SWAP_NOTED', values: { gift: giftText } }, templates, replyContext);
      if (noted.templateId !== 'GIFT_SWAP_NOTED') return null;
      const base = { ...noted, attention: true, giftSwap: giftSwapChoice };
      if (basketHeld) {
        const pending = { ...conversation.pendingOrder, giftSwap: giftSwapChoice };
        const remind = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, { ...replyContext, pendingOrder: pending }).remind || '';
        return {
          ...base, templateId: 'ORDER_ADDRESS_REMIND', alsoTemplateId: 'GIFT_SWAP_NOTED', pendingOrder: pending,
          messages: [...noted.messages, ...(remind ? [remind] : [])],
          parts: [...noted.messages.map(text => ({ type: 'text', text })), ...(remind ? [{ type: 'text', text: remind, remind: true }] : [])]
        };
      }
      if (hasOrder && recentOrder?.id) return { ...base, order: { noteOrderId: String(recentOrder.id), note: `Khách đổi quà (2 gói nhỏ thay quà, không trừ tiền): ${giftText}` } };
      return base;
    })() : null;
    // Luật nhận ý bằng code (processing/rule-intent.mjs): tin ngắn, rõ ý (hỏi giá
    // cụt, ".", chào, giỏ ghi rõ, SĐT trơn, câu hỏi thông tin ngắn) trả thẳng mẫu,
    // không gọi mô hình. settings.ruleIntent: 'on' (mặc định) | 'shadow' (chỉ ghi
    // log so với mô hình) | 'off'.
    const ruleMode = settings.ruleIntent || 'off';
    const ruleProduct = conversation.source === 'comment' ? '' : resolveConversationProduct({ adTitle: conversation.referral?.adTitle, referralRef: conversation.referral?.ref, postText: conversation.post?.message }).product;
    // Luồng riêng cho ưu đãi 1 túi dùng thử: chạy trước mọi câu trả lời nhanh / luật /
    // mô hình của luồng chung (không bảng giá combo, không mời 2 túi). Khách tự xin
    // ≥ 2 túi thì thoát sang luồng thường (giá combo). Xin gặp người, giỏ Shop: như cũ.
    let trialPatch = null;
    let trialOutcome = null;
    if (trialState && !asksForHuman && !cartReply) {
      trialOutcome = trialStep({ text: message.text, type: message.type, trial: trialState, lastTemplateId: conversation.botLastTemplateId || '', livestream: replyContext.livestream });
      // Vòng 12 (B4 #13): khách live không nhận câu mời "1 túi dùng thử miễn ship / combo 2 tặng bát" (TRIAL_NEXT_STEP) kèm câu
      // trả lời thông tin — ưu đãi của họ là lời live (2 túi 298k tặng Quạt + Bát gáo dừa).
      if (replyContext.livestream && trialOutcome?.value?.also === 'TRIAL_NEXT_STEP') trialOutcome = { ...trialOutcome, value: { ...trialOutcome.value, also: undefined } };
      trialPatch = trialOutcome.patch || null;
      if (trialOutcome.exit) trialState = null;
      else if (trialPatch) trialState = { ...trialState, ...trialPatch };
      replyContext.trial = trialState;
      // Khách chọn combo 2 túi ngay trong lượt này: quà bát gáo dừa áp từ lượt này.
      if (trialOutcome.exit === 'combo2') replyContext.promoBowl = true;
      console.log(`Dùng thử: ${trialOutcome.exit ? `thoát (${trialOutcome.exit})` : trialOutcome.delegate ? 'nhờ mô hình' : trialOutcome.value.template_id} (${conversation.id})`);
    }
    const trialActive = Boolean(trialState && trialOutcome && !trialOutcome.exit);
    // Vòng 11 (P5): bot vừa hỏi vị — số túi khách nêu ngay trước câu hỏi ("cho chị 2 túi" → ASK_FLAVOR → "vàng"
    // = 2 túi vàng), hoặc số đã giữ trong giỏ chờ (pendingOrder.askedBagCount). Khách nói nhiều vị ("2 túi 2 vị")
    // mà chỉ trả một màu → luật để mô hình.
    const askedBag = (() => {
      if (!['ASK_FLAVOR', 'ORDER_INFO_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN', 'RECOMMEND_BEGINNER'].includes(conversation.botLastTemplateId)) return { count: 0, mixed: false };
      const lastAsk = recent.findLastIndex(item => item?.direction === 'outgoing');
      const before = [];
      // R13 (inbox2 B1): bot trả lời bằng HAI tin liền nhau (câu hỏi vị + câu kèm) thì tin ngay trước tin bot cuối cũng là tin
      // bot → trước đây dừng luôn, không thấy "Cho mình 2 túi nhé" → đơn còn 1 túi. Bỏ qua cả cụm tin bot liền nhau trước.
      let start = lastAsk - 1;
      while (start >= 0 && recent[start]?.direction === 'outgoing') start -= 1;
      for (let index = start; index >= 0 && before.length < 3; index -= 1) {
        const item = recent[index];
        if (item?.direction === 'outgoing') break;
        if (item?.direction === 'incoming' && item.type === 'text' && item.text) before.unshift(String(item.text));
      }
      const text = foldVietnamese(before.join(' '));
      return {
        count: bagCountInText(text) || Math.round(Number(conversation.pendingOrder?.askedBagCount) || 0),
        mixed: /\b\d\s*(?:vi|loai|mau)\b|\bkhac (?:vi|loai|nhau|mau)\b|\bmix\b|\bmoi (?:vi|loai|mau)\b/.test(text)
      };
    })();
    const addressBurst = message.type === 'text' && basketHeld && orderStepLast ? collectAddressBurst(recent) : null;
    const ruled = message.type === 'text' && !asksForHuman && !cartReply && ruleMode !== 'off'
      ? ruleIntentFn(message.text, {
          source: conversation.source,
          botLastTemplateId: conversation.botLastTemplateId || '',
          // Có SĐT/địa chỉ đơn cũ để "gửi địa chỉ cũ" chốt được; không có thì luật hỏi SĐT đặt lần trước.
          hasPreviousDelivery: Boolean((previousDelivery && !previousDelivery.foreign) || (recentOrder?.address && recentOrder?.phone)),
          // R13: với luật, "ngữ cảnh đã đổi" gồm cả tin tự động của Page sau lượt bot (ưu đãi QR, bám đuổi…), không chỉ nhân viên.
          staffRepliedAfterBot: contextChangedAfterBot,
          botLastAgeMin: conversation.botLastReplyAt ? (Date.now() - Number(conversation.botLastReplyAt)) / 60000 : Infinity,
          // Giỏ đang giữ chỉ tính khi còn hạn (2 giờ) — giỏ cũ quá hạn làm luật ADDRESS_COMPLETE dựng ASK_PRODUCT.
          hasBasket: Boolean(usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items?.length),
          // Vòng 12 (BOT-A): bước giỏ dùng chung isBasketStep (thêm ORDER_ADDRESS_OLD_ASK_PHONE); PRICE_ONE_BAG ("em lên 1 túi
          // nha?") giữ giỏ 1 túi → "ok" là chốt.
          lastWasOrderStep: isBasketStep(conversation.botLastTemplateId) || conversation.botLastTemplateId === 'PRICE_ONE_BAG',
          hasRecentOrder: Boolean(recentOrder?.id),
          orderAgeMin: recentOrder?.id && String(recentOrder.processingStatus || '') !== 'cancelled' ? (Date.now() - (Number(recentOrder.createdAt) || 0)) / 60000 : Infinity,
          // Vòng 11 (V11): cùng định nghĩa "khách live" với ngữ cảnh mẫu (bài live, thẻ Livestream, post.isLive).
          livestream: replyContext.livestream,
          askedBagCount: askedBag.count,
          askedMixedFlavours: askedBag.mixed,
          contextProduct: productHint(ruleProduct) ? ruleProduct : '',
          bundleSize: bundle.length,
          complaint: isComplaint({ text: message.text, keywords: settings.complaintKeywords }),
          commentBasket,
          trialOffer: Boolean(trialState),
          experimentalRules: settings.experimentalRules || 'shadow',
          // R13: luật ỨNG VIÊN K1/K1b/K3/K4/K5 có cờ RIÊNG (settings.candidateRules, mặc định 'shadow': chỉ ghi nhật ký, không
          // trả lời) — không đi theo experimentalRules (đang 'on' trên máy chủ), nếu không luật mới sẽ tự bật khi deploy.
          candidateRules: ['on', 'shadow', 'off'].includes(settings.candidateRules) ? settings.candidateRules : 'shadow',
          // Số mã hàng khác nhau trong giỏ đang giữ (K3: "Lấy 2 túi" chỉ đổi số lượng khi giỏ có MỘT mã).
          basketCodeCount: new Set((usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items || []).map(item => String(item.code || item.product || ''))).size,
          // Khách vừa bấm giỏ Facebook Shop (30 phút) mà giỏ chưa thành giỏ chờ (đang kiểm đơn / giỏ nhân viên lên đơn): để luật
          // "bấm nhầm" (CANCEL_BASKET_MISCLICK) chạy được.
          shopCart: !basketHeld && recent.some(item => item?.direction === 'incoming' && item.id !== change.message.id && ((Array.isArray(item.cart) && item.cart.length > 0) || isShopCartText(item.text)) && Date.now() - (Number(item.createdAt) || 0) < 30 * 60 * 1000),
          quotedProduct: quotedName || '',
          // Vòng 11: stripPhone giữ số nhà ngay sau SĐT ("0912345678 12 Lê Lợi…" không mất "12").
          // Vòng 12 (B2 #4, BOT-A): địa chỉ gửi thành nhiều tin liền ("Tổ 6" / "Thôn ba dùi" / … / SĐT) khi đang giữ giỏ ở bước
          // đơn → gom thành một khối để bộ soạn đơn đọc đủ cấp.
          addressComplete: Boolean(message.type === 'text' && conversation.pendingOrder?.items?.length && describeDeliveryAddress(addressBurst?.text || stripPhone(message.text).trim()).complete),
          addressText: addressBurst?.text || stripPhone(message.text).replace(/\s+/g, ' ').trim(),
          // Vòng 12 (B5 #3): chỉ khi CHÍNH KHÁCH (tin này / giỏ) nói tới gói nhỏ, hay bot vừa gửi PACKAGING_INFO. Trước đây quét
          // tin bot 30 phút ("gói nhỏ"/"combo 10 gói" có trong lời chào live, bảng giá chung) → tắt luật giỏ với khách live.
          smallPackContext: conversation.botLastTemplateId === 'PACKAGING_INFO'
            || (Array.isArray(conversation.pendingOrder?.items) ? conversation.pendingOrder.items : []).some(item => /^CB10|combo 10/i.test(String(item?.code || item?.product || '')))
            || /\b(goi nho|combo 10|hop 10|10 goi|cb10)\b/.test(folded)
        })
      : null;
    // Luật trả `clearBasket` (khách hoãn: ORDER_POSTPONED) → bỏ giỏ đang giữ; `values` trong value
    // (NO_VARIANT {ingredient}) do renderChatbotReply điền vào mẫu.
    // Vòng 11 (V8): SĐT (± địa chỉ) trước khi nêu vị (ORDER_INFO): giữ SĐT + địa chỉ vào giỏ chờ (chưa có món)
    // để lượt "2 túi xanh" chốt luôn, không xin lại địa chỉ khách vừa gửi.
    const orderInfoPending = ruled?.rule === 'ORDER_INFO' && ruled.value?.Phone_Number
      // R13 (inbox2 B1): giỏ chờ dựng lại ở lượt SĐT không được làm rơi số túi khách đã nêu (askedBagCount: "Cho mình 2 túi" →
      // hỏi vị → SĐT → "vàng" phải là 2 Túi Vàng), lựa chọn quà thay (giftSwap) và cờ khách live của giỏ trước.
      ? { pendingOrder: {
          items: [], key: '', at: Date.now(), phone: String(ruled.value.Phone_Number), address: String(ruled.value.Customer_Address || '').trim(), addressAsks: 0,
          ...(Number(conversation.pendingOrder?.askedBagCount) > 0 ? { askedBagCount: Math.round(Number(conversation.pendingOrder.askedBagCount)) } : askedBag.count > 0 ? { askedBagCount: askedBag.count } : {}),
          ...(Array.isArray(conversation.pendingOrder?.giftSwap) ? { giftSwap: conversation.pendingOrder.giftSwap } : {}),
          ...(conversation.pendingOrder?.livestream === true ? { livestream: true } : {})
        } }
      : {};
    // R13 (luật QUANTITY_ONLY / K3): luật trả `setQuantity` khi khách chỉ nêu SỐ LƯỢNG lúc đang giữ giỏ một mã ("Lấy 2 túi",
    // "Chị lấy 2 mà") → bước đơn với đúng mã đang giữ và số lượng mới (không để bộ soạn đoán lại từ chữ).
    const ruledHeldItems = usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items || [];
    const ruledValue = ruled?.value && Number(ruled.setQuantity) > 0 && ruledHeldItems.length === 1 && isOrderStep(String(ruled.value.template_id || '')) && !ruled.value.Product_N1
      ? { ...ruled.value, Product_N1: ruledHeldItems[0].product, No_A: String(Math.round(Number(ruled.setQuantity))) }
      : ruled?.value;
    // R13 (luật ORDER_POSTPONED chỉ hẹn dịp khác — `keepBasket`): GIỮ giỏ chờ, đánh dấu `postponed` để bám đuổi không nhắc
    // giỏ; khách gửi SĐT/địa chỉ sau đó thì chốt bình thường (cờ được bỏ khi giỏ được lưu lại ở lượt đặt hàng).
    const postponedPending = ruled?.keepBasket && conversation.pendingOrder && typeof conversation.pendingOrder === 'object' && Array.isArray(conversation.pendingOrder.items) && conversation.pendingOrder.items.length
      ? { pendingOrder: { ...conversation.pendingOrder, postponed: true } } : {};
    let ruleReply = ruled
      ? (ruled.commentRule ? commentRuleReply() : { ...renderChatbotReply(ruledValue, templates, replyContext), ...(ruled.attention ? { attention: true } : {}), ...(ruled.clearBasket || ruled.value?.clearBasket ? { pendingOrder: null } : {}), ...postponedPending, ...orderInfoPending })
      : null;
    // Vòng 12: luật báo giá 1 túi ("em lên 1 túi nha?") giữ luôn giỏ 1 túi để "ok"/👍 lượt sau là chốt.
    if (ruleReply && ruled?.holdBasket && !ruleReply.handoff) {
      const held = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: ruled.holdBasket.product, No_A: String(ruled.holdBasket.quantity || 1) }, templates, replyContext);
      if (held.pendingOrder?.items?.length) ruleReply = { ...ruleReply, pendingOrder: held.pendingOrder };
    }
    // Vòng 12: hủy / khoan giao đơn quá 60 phút → ghi chú vào đúng đơn đó (nhân viên xử lý, thẻ cần người).
    if (ruleReply && ruled?.orderNote && recentOrder?.id && isActiveOrder(recentOrder) && !ruleReply.order) {
      ruleReply = { ...ruleReply, order: { noteOrderId: String(recentOrder.id), note: `${ruled.orderNote}: ${String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 150)}` } };
    }
    // Luật thử nghiệm: chỉ dùng khi settings.experimentalRules = 'on'; còn lại ghi log so với mô hình.
    // Mô hình ra quyết định (nhỏ, học từ hội thoại shop): đoán mẫu + xác suất trước khi hỏi LLM.
    // Chế độ 'shadow' (mặc định) chỉ ghi log so với câu trả lời thật ở cuối lượt.
    const intentMode = settings.intentModel || 'shadow';
    // Chỉ hộp thư: bình luận đi luồng riêng (mẫu COMMENT_*), so sánh không có nghĩa.
    const intentEligible = message.type === 'text' && conversation.source !== 'comment' && !asksForHuman && !cartReply && !trialActive;
    // Row chung cho mô hình phẳng và mô hình tầng: intentRowOf — CÙNG định nghĩa với dữ liệu huấn luyện và bộ chấm
    // (trước đây engine tự dựng: thiếu ask:confirm sau ORDER_CONFIRMATION, ask:flavor đọc từ câu bot, bước đơn sau
    // ASK_FLAVOR/ORDER_ADDRESS_REMIND, addressInText/bagCount khác định nghĩa → mô hình chạy thật kém hơn số đo).
    // pendingOrder null (không phải undefined) = biết là không có giỏ: họ ORDER_ADDRESS xin theo giỏ như prevBotAsks.
    const intentRow = intentEligible ? {
      ...intentRowOf({
        text: message.text, source: conversation.source, lastTemplateId: conversation.botLastTemplateId || '', prevBotText: trace.prevBotText,
        pendingOrder: conversation.pendingOrder ?? null, now: Date.now(),
        // R13 (models 3.E-3): cùng định nghĩa "khách live" với luật, mẫu, nhật ký và dataset (bài live HOẶC thẻ Livestream).
        livestream: Boolean(replyContext.livestream),
        hasOrder: Boolean(hasOrder), orderAgeMin: trace.ctx?.orderAgeMin ?? null, phoneInText: Boolean(phoneInText),
        staffRepliedAfterBot: Boolean(staffRepliedAfterBot)
      }),
      hasRecentOrder: Boolean(trace.ctx?.hasRecentOrder)
    } : null;
    const intent = intentMode !== 'off' && intentRow ? predictIntent(intentRow) : null;
    const intentThreshold = Number(settings.intentThreshold) || 0.9;
    const intentUsable = Boolean(intent) && intentMode === 'on' && intent.confidence >= intentThreshold && intent.margin >= 0.25 && intentSafeTemplates.has(intent.templateId) && templates?.[intent.templateId] !== undefined
      && !phoneInText && conversation.source !== 'comment';
    const intentReply = intentUsable ? renderChatbotReply({ template_id: intent.templateId, ...(intent.templateId === 'PRICE_QUOTE' && productHint(ruleProduct) ? { Product_N1: ruleProduct } : {}) }, templates, replyContext) : null;
    // Mô hình tầng: cùng `row`, cùng điều kiện với mô hình phẳng; lỗi mô-đun → như không có. 'on' chỉ tự trả
    // lời nhóm ANSWER (hay PRICE/INFO/SOCIAL) với mẫu an toàn, pGroup ≥ 0,85, pWithin ≥ cascadeThreshold, biên trong
    // nhóm ≥ 0,25, cùng rào của mô hình phẳng (không SĐT, không bình luận, không dùng thử/giỏ Shop qua intentEligible)
    // và rào cứng: không màu/số túi trong tin, không khiếu nại, có đơn gần đây thì không SHIPPING_POLICY/WELCOME/
    // DELIVERY_DELAY, loại hẳn WELCOME; ORDER/SUPPORT/OTHER không bao giờ. Canary: ngoài phần hash → chạy như shadow.
    const cascade = cascadeMode !== 'off' && intentRow && predictCascadeFn
      ? (() => { try { const out = predictCascadeFn(intentRow); return out && typeof out === 'object' && out.group ? out : null; } catch (error) { console.warn(`Mô hình tầng lỗi: ${String(error?.message || error).slice(0, 120)}`); return null; } })()
      : null;
    // pWithin/marginWithin (xác suất mẫu trong nhóm) là chuẩn; mô-đun cũ chưa trả thì dùng p/margin (ghi log một lần mỗi tiến trình).
    const cascadeWithin = cascade ? { p: Number(cascade.pWithin ?? cascade.p) || 0, margin: Number(cascade.marginWithin ?? cascade.margin) || 0, fallback: cascade.pWithin === undefined || cascade.marginWithin === undefined } : null;
    if (cascadeWithin?.fallback && !cascadeWithinWarned) { cascadeWithinWarned = true; console.log('Mô hình tầng: kết quả chưa có pWithin/marginWithin — dùng p/margin thay (mô-đun cũ)'); }
    const cascadeCanary = cascadeMode === 'on' ? canaryBucket(conversation.id) < (settings.cascadeCanary === undefined ? 100 : Number(settings.cascadeCanary) || 0) : null;
    const cascadeColourNumber = /\b(xanh|vang|nau|cacao)\b/.test(folded) && /\d/.test(folded.replace(/\+?\d[\d .-]{8,13}/g, ' '));
    const cascadeComplaint = isComplaint({ text: message.text, keywords: settings.complaintKeywords }) || conversationLabels.some(label => /^(complaint|warranty)$/.test(label));
    const cascadeHardBlock = Boolean(cascade) && (
      (Number(trace.ctx?.bagCount) || 0) > 0 || cascadeColourNumber || cascadeComplaint
      || (Boolean(trace.ctx?.hasRecentOrder) && cascadeNoRecentOrderTemplates.has(cascade.templateId))
      || cascadeExcludedTemplates.has(cascade.templateId)
    );
    const cascadeUsable = Boolean(cascade) && cascadeMode === 'on' && cascadeCanary === true && cascadeAutoGroups.has(String(cascade.group))
      && Number(cascade.pGroup) >= CASCADE_GROUP_THRESHOLD && cascadeWithin.p >= (Number(settings.cascadeThreshold) || CASCADE_TEMPLATE_THRESHOLD) && cascadeWithin.margin >= 0.25
      && intentSafeTemplates.has(cascade.templateId) && templates?.[cascade.templateId] !== undefined && !phoneInText && conversation.source !== 'comment' && !cascadeHardBlock;
    const cascadeReply = cascadeUsable ? renderChatbotReply({ template_id: cascade.templateId, ...(cascade.templateId === 'PRICE_QUOTE' && productHint(ruleProduct) ? { Product_N1: ruleProduct } : {}) }, templates, replyContext) : null;
    const ruleUsable = Boolean(ruled) && !ruled.shadowOnly;
    const ruleShadow = Boolean(ruled) && (ruleMode === 'shadow' || !ruleUsable);
    if (ruled) console.log(`Luật ${ruled.rule}${ruleShadow ? ' (thử)' : ''} → ${ruleReply.templateId} (${conversation.id})`);
    // Luật thử nghiệm đính kèm một luật ổn định: ghi log so với luật ổn định, không đổi câu trả lời.
    // Giá trị luật thử là JSON thô: soạn qua renderChatbotReply (cùng ngữ cảnh) rồi mới so mẫu.
    if (ruled?.shadow) console.log(shadowRuleLine(ruled.shadow, ruleReply.templateId, value => renderChatbotReply(value, templates, replyContext), conversation.id));
    // Nhật ký: luật ổn định đang dùng thật, luật thử (kèm luật ổn định khi chỉ chạy ẩn), mô hình nhỏ (top-K).
    const ruleLive = Boolean(ruled) && ruleUsable && ruleMode === 'on';
    trace.rule = ruleLive ? { name: ruled.rule, templateId: ruleReply.templateId } : null;
    // R13: luật ứng viên (K1/K1b/K3/K4/K5) ghi vào trường riêng của nhật ký — ở 'shadow' chỉ để so với câu trả lời thật.
    trace.candidateRule = ruled?.candidate ? { name: ruled.rule, templateId: ruleReply?.templateId || '', mode: ruled.shadowOnly ? 'shadow' : 'on', ...(ruled.setQuantity ? { setQuantity: Number(ruled.setQuantity) } : {}) } : null;
    trace.shadow = [
      ...(ruled && !ruleLive ? [{ name: ruled.rule, templateId: ruleReply.templateId }] : []),
      ...(ruled?.shadow ? [{ name: ruled.shadow.rule, templateId: ruled.shadow.commentRule ? ruleReply.templateId : ruled.shadow.value ? renderChatbotReply(ruled.shadow.value, templates, replyContext)?.templateId || '' : '' }] : [])
    ];
    trace.intent = intent ? { templateId: intent.templateId, p: round2(intent.confidence), margin: round2(intent.margin), topK: intentTopK(intent) } : null;
    trace.cascade = cascade ? { ...cascadeTrace(cascade), canary: cascadeCanary } : null;
    // Sau ASK_PRODUCT/ASK_FLAVOR, khách chỉ nêu MỘT màu mà trước đó đang hỏi giá ("2 túi giá bao nhiêu"
    // → "xanh"): báo giá màu đó, không lên đơn 1 túi (ca Đào Bia). Không hỏi giá trước → để luật/mô hình.
    const priceAsk = /\b(gia|bao nhieu|bao nhiu|bn|bnhiu|nhieu tien|nhiu tien|bao tien|bao gia)\b/;
    const colourQuote = (() => {
      if (nonText || !['ASK_PRODUCT', 'ASK_FLAVOR'].includes(conversation.botLastTemplateId) || phoneInText || /\d/.test(folded) || !templates?.PRICE_QUOTE) return null;
      const colours = [...new Set((folded.match(/\b(xanh|vang|nau|cacao)\b/g) || []).map(colour => (colour === 'cacao' ? 'nau' : colour)))];
      const leftover = folded.replace(/\b(xanh|vang|nau|cacao|la|cay|tui|goi|bich|granola|vi|mau|loai|cho|em|minh|chi|c|e|a|anh|lay|nha|nhe|shop|di)\b/g, '').replace(/[^a-z]/g, '');
      if (colours.length !== 1 || leftover) return null;
      const earlier = replyContext.recentCustomerTexts.filter(text => squashText(text) !== squashText(message.text)).slice(-3);
      if (!earlier.some(text => priceAsk.test(foldVietnamese(text)))) return null;
      const product = getCatalogProducts().find(item => item.active !== false && /^gra-/i.test(item.sku || '') && String(item.sku || '').toLowerCase().includes(`-${colours[0]}-`));
      return product ? renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: product.name }, templates, replyContext) : null;
    })();
    // Khách lặp lại câu vừa hỏi, hay chỉ giục ("sao chưa trả lời", "???", "alo"): chỉ khi đó mới
    // được nhắc "em vừa gửi ở trên". Tin có ý mới / dấu hỏi thì không.
    const previousIncoming = [...recent].reverse().find(item => item?.direction === 'incoming' && item.id !== message.id && (!message.mid || item.mid !== message.mid) && !bundled.has(item.id));
    const customerRepeats = Boolean(previousIncoming) && textSimilarity(previousIncoming.text, message.text) >= 0.8;
    const nudgeLike = message.type === 'text' && isNudgeMessage(message.text);
    // Gác trước LLM (settings.preGuard: 'shadow' mặc định | 'on' | 'off'): hộp thư, tin chữ không SĐT/địa
    // chỉ, khách chỉ giục hay lặp y câu (≥ 80%, trong 10 phút, câu trước không có dấu hỏi) ngay sau một
    // mẫu THÔNG TIN của bot mà bot chưa nhắc lần nào → "đã gửi ở trên" không cần hỏi mô hình. 'shadow'
    // vẫn hỏi mô hình, chỉ ghi so sánh vào nhật ký (guards.preGuard) + log; 'on' trả luôn.
    const preGuardMode = ['on', 'shadow', 'off'].includes(settings.preGuard) ? settings.preGuard : 'shadow';
    const preGuard = (() => {
      if (preGuardMode === 'off' || nonText || conversation.source === 'comment' || asksForHuman || cartReply || trialActive || phoneInText || trace.ctx?.addressInText) return null;
      // Vòng 12 (B5 #13): "1 túi vàng" sau báo giá từng bị định trả "đã gửi" — tin có số túi / có chữ số không bao giờ là lặp.
      if ((Number(trace.ctx?.bagCount) || 0) > 0 || /\d/.test(folded)) return null;
      const last = String(conversation.botLastTemplateId || '');
      if (!last || isOrderStep(last) || /^(ORDER_|TRIAL_|COMMENT_|FOLLOW_UP_)/.test(last) || preGuardExcludedLast.has(last)) return null;
      if (Date.now() - (Number(conversation.botLastReplyAt) || 0) >= 24 * 60 * 60 * 1000 || contextChangedAfterBot) return null;
      const prevAt = Number(previousIncoming?.createdAt) || 0;
      const repeatsPlain = Boolean(previousIncoming) && customerRepeats && prevAt <= (Number(conversation.botLastReplyAt) || 0)
        && (Number(message.createdAt) || Date.now()) - prevAt <= 10 * 60 * 1000 && !/\?/.test(String(previousIncoming.text || ''));
      if (!nudgeLike && !repeatsPlain) return null;
      const nudgeId = priceFamilyTemplates.has(last) && !hasOrder ? 'REPLY_ALREADY_SENT' : 'REPLY_ALREADY_SENT_INFO';
      if (!templates?.[nudgeId]) return null;
      const rendered = renderChatbotReply({ template_id: nudgeId }, templates, replyContext);
      if (rendered.templateId !== nudgeId) return null;
      return { decision: nudgeId, reason: nudgeLike ? 'nudge' : 'repeat', reply: { ...rendered, attention: nudgeId === 'REPLY_ALREADY_SENT_INFO' } };
    })();
    trace.preGuard = preGuard ? { decision: preGuard.decision, reason: preGuard.reason, mode: preGuardMode, matched: null } : null;
    // So khớp lỏng lời vừa gửi: bỏ khoảng trắng thừa và câu mở đầu của tin riêng sau bình luận ("Dạ em thấy … để lại bình
    // luận…"), xưng hô cũng bỏ ("anh/chị" lượt trước, "chị" lượt sau vẫn là cùng một câu).
    const normalizeSent = value => String(value || '').replace(/^Dạ em thấy .*? để lại bình luận[^\n]*\n+/u, '')
      .replace(/(?<![\p{L}])(anh\s*\/\s*chị|anh chị|chị|anh|bạn|cô|chú)(?![\p{L}])/giu, '~').replace(/\s+/g, ' ').trim();
    /** Câu đầu `text` đã nằm trong một tin Page gửi trong `windowMs` gần đây? */
    const sentRecently = (text, windowMs) => {
      const line = normalizeSent(text);
      return line.length > 20 && recent.some(item => item?.direction === 'outgoing' && Date.now() - (Number(item.createdAt) || 0) < windowMs && normalizeSent(item.text).includes(line));
    };
    // ===== Vòng 12: quà / giá theo ngữ cảnh khách (live, ưu đãi bám đuổi, giỏ 2 túi) =====
    const partsOfReply =item => item?.parts || [...(item?.messages || []).map(text => ({ type: 'text', text })), ...(item?.images || []).map(url => ({ type: 'image', url }))];
    const wantsGiftPhotos = Boolean(ruled?.giftPhotos) || /\b(hinh|anh|xem|coi|ntn|the nao|nhu nao)\b/.test(folded);
    const withGiftPhotos = item => {
      const urls = [...new Set(getGifts().filter(gift => gift.active !== false).flatMap(gift => [gift.image, ...(Array.isArray(gift.images) ? gift.images : [])].filter(Boolean).slice(0, 2)).map(publicImageUrl).filter(Boolean))].slice(0, 4);
      if (!urls.length) return item;
      return { ...item, images: [...(item.images || []), ...urls], parts: [...partsOfReply(item), ...urls.map(url => ({ type: 'image', url }))] };
    };
    const heldItems = basketHeld ? usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items || [] : [];
    const heldQuantity = heldItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    // GIFT_POLICY: khách live (2 túi → Quạt + Bát gáo dừa), cửa sổ ưu đãi bám đuổi (combo 2 tặng bộ bát), giỏ 2 túi mà đòi bát/
    // muỗng (mời lên 3 túi); còn lại bảng quà chung (≥ 3 túi bát + muỗng; 5/10 túi theo bảng quà của chủ shop) + ảnh quà khi hỏi.
    // Khách live hỏi giá / miễn ship / giảm giá / bảng mix → lời chào live (giá + quà live), trừ khi đang nói Tropical / gói nhỏ.
    const contextualReply = item => {
      if (!item || item.handoff) return item;
      const keep = { ...(item.attention ? { attention: true } : {}), ...(item.pendingOrder !== undefined ? { pendingOrder: item.pendingOrder } : {}), ...(item.order ? { order: item.order } : {}) };
      if (item.templateId === 'GIFT_POLICY') {
        let out = item;
        const total3 = (() => { const first = heldItems[0]; const priced = first ? priceBasket([...heldItems.map(entry => ({ sku: entry.code, product: entry.product, quantity: entry.quantity })), { sku: first.code, product: first.product, quantity: 1 }]) : null; return priced?.priceable ? `${Number(priced.total).toLocaleString('vi-VN')}đ` : ''; })();
        // R13 (inbox2 B3): khách ĐÃ có đơn (24 giờ, chưa hủy; không đang giữ giỏ mới) hỏi lại quà → bộ soạn tự đổi mẫu mời đặt
        // (GIFT_POLICY_LIVE / PROMO / UPSELL3: "lấy 2 túi vị nào để em lên đơn liền") sang câu nói quà của CHÍNH ĐƠN ĐÓ
        // (GIFT_POLICY_ORDER) nhờ replyContext.hasOrder — mã mẫu giữ nguyên, thêm `variant`.
        const giftId =replyContext.livestream && templates.GIFT_POLICY_LIVE ? 'GIFT_POLICY_LIVE'
          : replyContext.promoBowl && templates.GIFT_POLICY_PROMO ? 'GIFT_POLICY_PROMO'
            // Đòi cả bát lẫn thìa/muỗng ("tặng kèm cái bát cà cái thìa") với giỏ 2 túi → mời lên 3 túi (quà bát + muỗng).
            : heldQuantity === 2 && /\bbat\b/.test(folded) && /\b(muong|thia)\b/.test(folded) && !/\b(hinh|anh|xem|coi)\b/.test(folded) && templates.GIFT_POLICY_UPSELL3 && total3 ? 'GIFT_POLICY_UPSELL3' : '';
        if (giftId) {
          const rendered = renderChatbotReply({ template_id: giftId, values: { total3 } }, templates, replyContext);
          if (rendered.templateId === giftId) out = { ...rendered, ...keep };
        }
        return wantsGiftPhotos ? withGiftPhotos(out) : out;
      }
      // R13 (inbox2 A2, inbox1 A3): ép về lời chào live làm khách live hỏi voucher / phí ship / giảm giá nhận LẠI lời chào
      // vừa gửi rồi bị chống lặp cho im (8 lượt trong 3 ngày). Nay:
      // - LIVESTREAM_VOUCHER và FREESHIP_POLICY là câu trả lời đúng cho câu hỏi đó → không ép nữa;
      // - chỉ ép (bảng giá / giảm giá / bảng mix) khi khách CHƯA có đơn và lời chào live chưa gửi trong 30 phút;
      // - ép xong mà trùng tin vừa gửi thì trả mẫu gốc.
      if (replyContext.livestream && templates.LIVESTREAM_COMMENT && ['PRICE_QUOTE', 'DISCOUNT_POLICY', 'PRICE_MIX_TUI_LON'].includes(item.templateId)
        && !/Tropical|Combo 10|gói nhỏ|Yến mạch|Nghệ/i.test((item.messages || []).join(' ')) && !hasOrder) {
        const live = renderChatbotReply({ template_id: 'LIVESTREAM_COMMENT' }, templates, replyContext);
        const liveGreetedRecently = (conversation.botLastTemplateId === 'LIVESTREAM_COMMENT' && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 30 * 60 * 1000)
          || sentRecently(live.messages?.[0], 30 * 60 * 1000);
        if (live.templateId !== 'LIVESTREAM_COMMENT' || liveGreetedRecently) return item;
        return { ...live, ...keep };
      }
      return item;
    };
    // Ý phụ (alsoPart) của câu trả lời ghép: soạn lại theo ngữ cảnh, giữ phần chính.
    const contextualAlso = item => {
      if (!item?.alsoPart) return item;
      const adjusted = contextualReply({ ...item.alsoPart });
      if (adjusted === item.alsoPart || (adjusted.templateId === item.alsoPart.templateId && adjusted.messages?.join('\n') === item.alsoPart.messages?.join('\n') && (adjusted.images || []).length === (item.alsoPart.images || []).length)) return item;
      const key = part => `${part.type}:${part.text || part.url}`;
      const alsoKeys = new Set(partsOfReply(item.alsoPart).map(key));
      const mainParts = partsOfReply(item).filter(part => !alsoKeys.has(key(part)));
      const parts = isOrderStep(item.templateId) || item.templateId === 'ORDER_CUSTOM_BASKET' ? [...partsOfReply(adjusted), ...mainParts] : [...mainParts, ...partsOfReply(adjusted)];
      return { ...item, parts, messages: parts.filter(part => part.type === 'text').map(part => part.text), images: parts.filter(part => part.type === 'image').map(part => part.url), alsoTemplateId: adjusted.templateId, alsoPart: { templateId: adjusted.templateId, messages: adjusted.messages, images: adjusted.images || [], parts: partsOfReply(adjusted) } };
    };
    let reply = asksForHuman
      ? renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, templates, replyContext)
      : cartReply
        // Khách giữ ưu đãi dùng thử mà đặt qua giỏ Shop (Shop tự cộng ship): gắn thẻ
        // để nhân viên sửa đơn miễn ship trên POS.
        ? (trialState ? { ...(shopOrder ? shopOrderReply(shopOrder) : cartReply), attention: true } : shopOrder ? shopOrderReply(shopOrder) : cartReply)
        // Bill chuyển khoản sau BANK_TRANSFER, rồi khách vừa được hỏi "đặt thêm đơn?" mà đáp đúng/không:
        // xử lý trước cả luồng dùng thử.
        : paymentReply || existingConfirmReply || (trialOutcome?.value
          ? renderChatbotReply(trialOutcome.value, templates, replyContext)
          : trialActive
            ? (nonText && !seesImage
              ? { ...renderChatbotReply({ template_id: templates?.IMAGE_RECEIVED ? 'IMAGE_RECEIVED' : 'CSKH_HANDOFF' }, templates, replyContext), attention: true }
              // R13: luồng dùng thử nhờ mô hình (delegate) mà LUẬT ĐƠN đã khớp (SĐT / địa chỉ / giỏ + địa chỉ → bước đơn) thì
              // dùng kết quả luật, không tốn lượt mô hình (và không để mô hình đọc lại địa chỉ khác đi).
              : trialOutcome?.delegate && ruleMode === 'on' && ruleUsable && ruleReply && !ruled.commentRule && isOrderStep(String(ruled.value?.template_id || '')) && !ruleReply.handoff
                ? ruleReply
                : await askModel({ trialHint: trialModelHint(trialState) }))
            : nonText
              ? (seesImage ? await askModel() : imageFallback())
              : ackReply || comboQuote || remindAck || noteReply || lookupReply || giftChoiceReply || choiceReply || colourQuote || quickQuote || (ruleMode === 'on' && ruleUsable ? ruleReply : null) || (cascadeReply?.templateId === cascade?.templateId ? cascadeReply : null) || (intentReply?.templateId === intent?.templateId ? intentReply : null) || (preGuardMode === 'on' && preGuard ? preGuard.reply : null) || await askModel());
    // Mẫu mô hình/luật CHỌN, trước mọi hậu xử lý (để log so mô hình nhỏ không bị ✗ giả).
    const chosenTemplateId = reply.templateId;
    trace.chosen = chosenTemplateId;
    // Người gác (processing/llm-router.mjs): LLM có cùng nhóm với mô hình nhỏ (top-K) / luật ổn định không — chỉ ghi.
    // Tham chiếu gộp: top-K mô hình phẳng + top-K mô hình tầng (reason 'cascade-top1'/'cascade-topk').
    trace.gate = trace.llm ? gateCheckWithCascade({ llmTemplateId: trace.llm.templateId, intentTopK: trace.intent?.topK || [], cascadeTopK: trace.cascade?.topK || [], ruleTemplateId: trace.rule?.templateId || '' }) : null;
    // Mô hình trả lời khách đang giữ ưu đãi bằng mẫu của luồng chung (bảng giá, combo,
    // mời 2 túi, "từ 2 túi miễn ship"): đổi sang mẫu dùng thử.
    if (trialActive && !trialOutcome.value) {
      const replacement = filterTrialReply(reply, trialState, isProductQuoteId);
      if (replacement && replyContext.livestream && replacement.also === 'TRIAL_NEXT_STEP') delete replacement.also;
      if (replacement) reply = renderChatbotReply(replacement, templates, replyContext);
    }
    // Mô hình vẫn chọn "đã gửi ở trên" cho một câu hỏi mới (prompt đã bỏ hai mẫu này khỏi lựa chọn):
    // chuyển nhân viên (gắn thẻ), KHÔNG gọi lại mô hình lần hai (vòng 8 gọi lại tốn 2 lượt LLM mỗi ca)
    // — không bảo khách "xem ở trên" lần nữa.
    if (nudgeTemplateIds.includes(reply.templateId) && !customerRepeats && !nudgeLike && !nonText) {
      reply = { ...renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, templates, replyContext), attention: true };
    }
    // Đang giữ giỏ mà khách HỎI ("cho xem hình bát", "túi nào ngon", "có yến mạch không?"): phải trả lời
    // câu hỏi rồi kèm nhắc giỏ (ORDER_ADDRESS_REMIND), không được trả nhắc giỏ trơn. Ảnh quà (bát gáo
    // dừa) chỉ gửi khi quà có ảnh trong Cài đặt; không có thì kể chính sách quà.
    // Vòng 11 (P1, ca thật 13:07): đang giữ giỏ (bot đang xin SĐT/địa chỉ, hay vừa CONFIRM_YES) mà khách hỏi thông
    // tin (quà, miễn ship, đường, ship mấy ngày, sức khỏe, so sánh, thanh toán…): luật/mô hình trả bước đơn + ý phụ
    // ({ORDER_ADDRESS, also X}). Trước đây chống lặp (ORDER_ADDRESS < 60 giây) hay nhắc giỏ nuốt mất câu trả lời X.
    // Nay: gửi câu trả lời X + câu nhắc ngắn giỏ (ORDER_ADDRESS_REMIND, nêu đúng phần còn thiếu), KHÔNG lưu lại giỏ
    // (tin không mang giỏ/SĐT/địa chỉ mới → addressAsks không tăng, không tự chốt địa chỉ thiếu cấp), không qua
    // chống lặp. Ý phụ không soạn được (mẫu thiếu/tắt): hỏi mô hình trả lời câu hỏi một lần.
    const heldPending = basketHeld ? usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' }) : null;
    const ruleAskedAlso = ruleLive && reply === ruleReply && Boolean(ruled?.value?.also);
    const keepsHeld = pending => !pending || (String(pending.key || '') === String(heldPending?.key || '') && String(pending.address || '') === String(heldPending?.address || ''));
    let infoWhileHeld = false;
    let answeredWhileHeld = false;
    // Xin xem ảnh quà (bát gáo dừa): để nhánh basketQuestion bên dưới gửi ảnh quà.
    const asksGiftPhoto = /\b(hinh|anh|xem|coi)\b/.test(folded) && /\b(bat|gao dua|qua|muong|dua)\b/.test(folded);
    if (heldPending && !asksGiftPhoto && !nonText && !phoneInText && !awaitingAsked && !cartReply && !asksForHuman && !trialActive && !nudgeLike && !shortAck
      && (orderStepLast || conversation.botLastTemplateId === 'CONFIRM_YES')
      && reply.templateId === 'ORDER_ADDRESS' && !reply.order && !reply.handoff && (reply.alsoTemplateId || ruleAskedAlso)
      && keepsHeld(reply.pendingOrder)) {
      let answer = reply.alsoPart || null;
      if (!answer) {
        const orderishId = id => isOrderStep(id) || ['ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET', 'ASK_FLAVOR', 'ASK_PRODUCT', 'THANK_YOU', 'WELCOME'].includes(id);
        const again = await askModel({ replyHint: 'LƯU Ý: giỏ hàng của khách ĐÃ LƯU, engine sẽ tự nhắc SĐT/địa chỉ. Khách đang HỎI — chọn mẫu thông tin trả lời đúng câu hỏi (không chọn ORDER_ADDRESS/ORDER_CONFIRMATION/ASK_*).' });
        answer = again && !orderishId(again.templateId) && !again.handoff && !again.order ? again : null;
      }
      const remind = reply.remind || renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, replyContext).remind || '';
      // Cùng quy tắc mẫu live như câu trả lời thường (bên dưới): khách live hỏi quà/giảm giá → lời chào live;
      // khách thường không nhận mẫu voucher live.
      // Vòng 12: cùng hàm theo ngữ cảnh như câu trả lời thường (quà live/ưu đãi/giỏ 2 túi, giá live) — không còn đòi từ khóa.
      const heldLive = replyContext.livestream;
      if (answer) answer = contextualReply(answer);
      if (answer && !heldLive && answer.templateId === 'LIVESTREAM_VOUCHER' && templates?.DISCOUNT_POLICY) answer = renderChatbotReply({ template_id: 'DISCOUNT_POLICY' }, templates, replyContext);
      if (answer) {
        const partsOf = item => item.parts || [...(item.messages || []).map(text => ({ type: 'text', text })), ...(item.images || []).map(url => ({ type: 'image', url }))];
        // Không có mẫu nhắc (chủ shop tắt): gửi câu trả lời kèm nguyên câu xin thông tin của bước đơn.
        const tail = remind ? [{ type: 'text', text: remind, remind: true }] :partsOf(reply).filter(part => !partsOf(answer).some(own => own.type === part.type && (own.text || own.url) === (part.text || part.url)));
        reply = {
          templateId: 'ORDER_ADDRESS_REMIND',
          messages: [...(answer.messages || []), ...tail.filter(part => part.type === 'text').map(part => part.text)],
          parts: [...partsOf(answer), ...tail],
          images: [...(answer.images || []), ...tail.filter(part => part.type === 'image').map(part => part.url)],
          alsoTemplateId: answer.templateId,
          handoff: false,
          ...(answer.attention ? { attention: true } : {}),
          pendingOrder: undefined,
          order: undefined
        };
        infoWhileHeld = true;
        answeredWhileHeld = true;
      } else if (remind) {
        // Không trả lời được câu hỏi: nhắc giỏ + gắn thẻ để nhân viên trả lời phần khách hỏi.
        reply = { templateId: 'ORDER_ADDRESS_REMIND', messages: [remind], images: [], parts: undefined, handoff: false, attention: true, pendingOrder: undefined, order: undefined };
        infoWhileHeld = true;
      }
    }
    const basketQuestion = !infoWhileHeld && !nonText && basketHeld && orderStepLast && !phoneInText && !awaitingAsked && !cartReply && !asksForHuman && !nudgeLike && !shortAck
      && (/\?/.test(String(message.text || '')) || /\b(cho xem|xem|coi|nao|sao|khac gi|duoc (khong|ko|k)|co (khong|ko|k)|bao nhieu|bn)\b/.test(folded))
      && !describeDeliveryAddress(String(message.text || '')).complete;
    const giftPhotoAsk = basketQuestion && /\b(hinh|anh|xem|coi)\b/.test(folded) && /\b(bat|gao dua|qua|muong|dua)\b/.test(folded);
    if (basketQuestion && !reply.order && !reply.handoff) {
      const remind = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, replyContext).remind || '';
      const orderish = item => isOrderStep(item.templateId) || ['ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET', 'ASK_FLAVOR', 'ASK_PRODUCT', 'THANK_YOU', 'WELCOME'].includes(item.templateId);
      let answer = null;
      if (giftPhotoAsk) {
        const giftImages = getGifts().filter(gift => gift.active !== false && (gift.image || (Array.isArray(gift.images) && gift.images.length)));
        answer = giftImages.length && templates?.PRODUCT_PHOTOS
          ? renderChatbotReply({ template_id: 'PRODUCT_PHOTOS', values: { products: giftImages.map(gift => gift.name).join(', '), images: giftImages.flatMap(gift => [gift.image, ...(Array.isArray(gift.images) ? gift.images : [])].filter(Boolean).slice(0, 2).map(url => `![${gift.name}](${url})`)).join(' ') } }, templates, replyContext)
          : renderChatbotReply({ template_id: 'GIFT_POLICY' }, templates, replyContext);
        if (answer.handoff) answer = null;
      } else if (orderish(reply) && !reply.alsoTemplateId) {
        // Luật/mô hình lặp bước xin SĐT: hỏi lại mô hình, nhắc rằng giỏ đã lưu và khách đang hỏi.
        const again = await askModel({ replyHint: 'LƯU Ý: giỏ hàng của khách ĐÃ LƯU, engine sẽ tự nhắc SĐT/địa chỉ. Khách đang HỎI — chọn mẫu thông tin trả lời đúng câu hỏi (không chọn ORDER_ADDRESS/ORDER_CONFIRMATION/ASK_*).' });
        answer = !orderish(again) && !again.handoff && !again.order ? again : null;
      } else if (!orderish(reply)) {
        answer = reply;
      }
      if (answer) {
        const partsOf = item => item.parts || [...item.messages.map(text => ({ type: 'text', text })), ...(item.images || []).map(url => ({ type: 'image', url }))];
        reply = remind
          ? { ...answer, messages: [...answer.messages, remind], parts: [...partsOf(answer), { type: 'text', text: remind }], alsoTemplateId: 'ORDER_ADDRESS_REMIND', pendingOrder: undefined, order: undefined }
          : { ...answer, pendingOrder: undefined, order: undefined };
      } else if (remind && !reply.alsoTemplateId && conversation.botLastTemplateId !== 'ORDER_ADDRESS_REMIND') {
        // Không trả lời được câu hỏi: nhắc giỏ nhưng gắn thẻ để nhân viên trả lời phần khách hỏi
        // (vừa nhắc lượt trước rồi thì để cơ chế chống lặp im + gắn thẻ).
        reply = { templateId: 'ORDER_ADDRESS_REMIND', messages: [remind], images: [], parts: undefined, handoff: false, attention: true };
      }
    }
    // Bảng giá chung (3 vị, giá lẻ chưa ship) một mình làm khách rối và thấy đắt: trong
    // hộp thư gửi kèm luôn bảng giá chi tiết Túi Xanh (1 túi / combo 2 / combo 3 + quà,
    // kèm ảnh). Không áp cho bình luận, phiên live, khách đang giữ ưu đãi dùng thử; bảng
    // Túi Xanh vừa gửi trong 30 phút thì cơ chế ý phụ tự bỏ, không gửi lại.
    const defaultQuoteProduct = findProductBySku('GRA-XANH-Z450')?.name || '';
    // Vòng 12: khách hỏi danh sách vị ("có mấy loại", "giá các mặt hàng" — listAll) giữ nguyên bảng 3 vị (trước đây bị thay
    // bằng bảng một Túi Xanh khi tin chào QC đã có giá); khách live → lời chào live (bên dưới).
    const listAll = reply === ruleReply && Boolean(ruled?.value?.listAll);
    // R13: tin có phải HỎI GIÁ không (chữ hỏi giá, tin cụt ".", "ib", hay luật báo giá đã khớp) — điều kiện của ASK_TWO_BAGS.
    const priceLikeText = !nonText && (terse || priceAsk.test(folded) || /^(?:\.+|…|\?+|ib|inbox|bn)$/.test(folded) || /PRICE|DOTS|TERSE/.test(String(ruled?.rule || '')));
    let staleGeneralInfo = false;
    if (reply.templateId === 'GENERAL_INFO' && !reply.alsoTemplateId && !trialActive && defaultQuoteProduct && !listAll && !replyContext.livestream
      && conversation.source !== 'comment' && !isLivestreamPost(conversation) && templates?.PRICE_QUOTE) {
      const quote = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: defaultQuoteProduct }, templates, replyContext);
      const opening = String(quote.messages?.[0] || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const justSent = opening && replyContext.recentOutgoing.some(text => String(text).replace(/\s+/g, ' ').includes(opening));
      // Pancake tự chào khách bấm quảng cáo bằng bảng 3 giá (có khi cùng phút, chưa kịp vào kho tin):
      // khách đến từ quảng cáo mà bot chưa trả lời gì cũng coi như đã có bảng 3 giá.
      const adGreeted = Boolean(conversation.referral?.adTitle || conversation.referral?.ref) && !conversation.botLastTemplateId;
      // Tin tự động của Page dưới quảng cáo đã liệt kê 3 giá ("bảng giá hiện nay gồm", "Túi Xanh … 174.000đ")
      // trong 30 phút (≈50 ca 26–28/09 nhận bảng 3 giá hai lần): chỉ gửi bảng giá túi mặc định.
      const priceListSent = adGreeted || replyContext.recentOutgoing.some(text => (/174\.000đ/.test(text) && /Túi Vàng/i.test(text) && !/Bảng giá Granola/i.test(text))
        || /bảng giá (hiện nay|hiện tại|bên em|nhà em|của (shop|em))|bảng giá[^\n]{0,40}gồm|Túi Xanh[\s\S]{0,80}174/iu.test(text));
      if (quote.templateId === 'PRICE_QUOTE' && !justSent && priceListSent) reply = { ...quote, ...(reply.attention ? { attention: true } : {}) };
      // Vòng 12 (B2 #10): bảng 3 giá (tin chào QC) VÀ bảng Túi Xanh đều vừa gửi trong 30 phút → không gửi lại bảng giá nào,
      // chỉ câu chốt ngắn "lấy 2 túi vị nào".
      // R13 (inbox1 B3): câu "bảng giá em gửi ngay ở trên, lấy 2 túi vị nào" chỉ đúng khi khách HỎI GIÁ ("Báo giá giúp mình",
      // ".", "túi hơn cân giá"). Tin không hỏi giá mà mô hình trả bảng giá chung ("Có mấy loại") thì không phải lúc mời chốt:
      // coi như sắp lặp bảng giá vừa gửi — phần chống lặp bên dưới gọi lại mô hình một lần (không chọn lại bảng giá).
      else if (justSent && priceListSent && templates.ASK_TWO_BAGS && priceLikeText) reply = { ...renderChatbotReply({ template_id: 'ASK_TWO_BAGS' }, templates, replyContext), ...(reply.attention ? { attention: true } : {}) };
      else if (justSent && priceListSent) staleGeneralInfo = true;
      else if (quote.templateId === 'PRICE_QUOTE' && !justSent) {
        const partsOf = item => item.parts || [...item.messages.map(text => ({ type: 'text', text })), ...(item.images || []).map(url => ({ type: 'image', url }))];
        // Bảng giá chi tiết đi ngay sau: bỏ đoạn cuối "quan tâm loại nào / cần thêm thông tin nào" của bảng
        // chung (hỏi rồi tự trả lời), và không gửi hai bộ ảnh bảng giá cùng lúc (giữ ảnh của bảng chung).
        const closing = /quan tâm loại nào|cần thêm thông tin nào|lấy 2 túi vị nào|vị nào để em lên đơn/iu;
        const generalParts = partsOf(reply).filter((part, index, list) => !(part.type === 'text' && closing.test(part.text) && index === list.findLastIndex(item => item.type === 'text')));
        const generalMessages = reply.messages.filter((text, index) => !(closing.test(text) && index === reply.messages.length - 1));
        const quoteParts = (reply.images || []).length ? partsOf(quote).filter(part => part.type !== 'image') : partsOf(quote);
        const quoteImages = (reply.images || []).length ? [] : quote.images || [];
        reply = { ...reply, messages: [...generalMessages, ...quote.messages], parts: [...generalParts, ...quoteParts], images: [...(reply.images || []), ...quoteImages], alsoTemplateId: 'PRICE_QUOTE' };
      }
    }
    // Cùng mẫu dùng thử vừa gửi lượt trước: nhắc ngắn thay vì gửi lại nguyên văn.
    if (trialActive && String(reply.templateId).startsWith('TRIAL_') && reply.templateId !== 'TRIAL_REMIND'
      && conversation.botLastTemplateId === reply.templateId && templates?.TRIAL_REMIND) {
      reply = renderChatbotReply({ template_id: 'TRIAL_REMIND', values: { bags: trialBagOptions() } }, templates, replyContext);
    }
    if (ruleShadow) console.log(`Luật ${ruled.rule} (thử): luật ${ruleReply.templateId} / mô hình ${reply.templateId}${ruleReply.templateId === reply.templateId ? ' ✓' : ' ✗'} (${conversation.id})`);
    if (seesImage && !trialActive && (reply.templateId === 'IMAGE_RECEIVED' || reply.templateId === 'CSKH_HANDOFF')) reply = imageFallback();
    // "Cảm ơn" mà khách chưa có đơn: ảnh (thường là ảnh sản phẩm, không phải
    // bill) → xử lý như ảnh; "đã đặt rồi" → tra đơn. Không cảm ơn suông rồi thôi.
    if (reply.templateId === 'THANK_YOU' && !hasOrder && !ackReply) {
      if (nonText) reply = imageFallback();
      else if (asksAboutOrder) reply = renderChatbotReply({ template_id: 'ORDER_STATUS' }, templates, replyContext);
    }
    // Vòng 12 (B2 #12): THANK_YOU chỉ cho lời đáp ngắn / emoji / lời cảm ơn thật. "M mua 2 túi", "nhận hàng bận quá h mới bóc
    // xem", "Lần này mà ko ok là chị nghỉ chơi" từng nhận lời cảm ơn: hỏi lại mô hình một lần (không THANK_YOU); vẫn cảm ơn →
    // im + thẻ cần người.
    const ackWordsOnly = message.type === 'text' && (() => { const words = folded.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean); return words.length > 0 && words.length <= 6 && words.every(word => thanksAckWords.has(word)); })();
    const genuineThanks = shortAck || emojiOnly || ackWordsOnly || ruled?.rule === 'THANKS' || /\b(cam on|camon|thank|thanks|tks)\b/.test(folded) && folded.length <= 60 && !/\?/.test(folded);
    if (reply.templateId === 'THANK_YOU' && conversation.source !== 'comment' && !nonText && !genuineThanks && !message.likeSticker) {
      const again = await askModel({ replyHint: 'LƯU Ý: khách KHÔNG chỉ cảm ơn/đáp lời — chọn mẫu trả lời đúng ý khách (không chọn THANK_YOU).' });
      if (again && again.templateId !== 'THANK_YOU') reply = again;
      else {
        await saveBotState(conversation.id, { addLabelEvents: ['handoff'] }).catch(() => {});
        results.push({ conversationId: conversation.id, skipped: 'mô hình cảm ơn tin không phải lời cảm ơn' });
        return;
      }
    }
    // Vòng 12 (BOT-A): tin thanh toán ("gửi stk", "ck rồi", "lên đơn 0đ") không bao giờ là sửa đơn.
    if (reply.order?.updateOrderId && isPaymentMessage(message.text)) {
      const paidNow = paidText || /\b(da|vua|moi) (ck|chuyen)\b|\bck (roi|xong)\b/.test(folded);
      const paymentId = paidNow ? 'PAYMENT_RECEIVED_CHECK' : templates.BANK_TRANSFER ? 'BANK_TRANSFER' : 'PAYMENT_RECEIVED_CHECK';
      reply = { ...renderChatbotReply({ template_id: paymentId }, templates, replyContext), attention: true, order: undefined, pendingOrder: undefined };
    }
    // Vòng 12 (BOT-A): không tra được địa chỉ cũ → nhân viên tra (thẻ), không hỏi từng cấp.
    if (reply.oldAddressMissing && !reply.attention) reply = { ...reply, attention: true };
    // C2: SĐT khách gửi trùng đơn landing/POS ngoài hội thoại (địa chỉ không tự điền): luôn gắn thẻ cho nhân viên.
    if (previousDelivery?.foreign && !reply.attention) reply = { ...reply, attention: true };
    // R14 (chủ shop 03/10, thay quy tắc 01/10 "2 gói nhỏ"): khách muốn đổi quà → bot KHÔNG hứa quà thay; ghi chú vào đơn
    // đang mở (≤ 24 giờ), chưa có đơn thì ghi chú hồ sơ khách; luôn gắn thẻ để bộ phận phụ trách duyệt rồi nhắn khách.
    if ((reply.templateId === 'GIFT_SWAP' || reply.alsoTemplateId === 'GIFT_SWAP') && !reply.order) {
      const asked = String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 150);
      const note = `Khách muốn đổi quà (chờ bộ phận phụ trách duyệt rồi nhắn khách): ${asked}`;
      if (hasOrder && recentOrder?.id) reply = { ...reply, attention: true, order: { noteOrderId: String(recentOrder.id), note } };
      else {
        reply = { ...reply, attention: true };
        if (conversation.source !== 'comment') await noteForStaff(dependencies, conversation, note, 'đổi quà');
      }
    }
    // Vòng 12 (B1 #5, B2 #7, B3 #1): tin chữ đi cùng ảnh — SĐT → hỏi loại trong hình mấy túi; "3 bịch này" → báo giá 3 túi + hỏi
    // vị; luôn gắn thẻ để nhân viên xem ảnh.
    if (message.withImage && !reply.handoff) {
      if (ruled?.rule === 'ORDER_INFO' && reply === ruleReply && templates.IMAGE_WITH_PHONE) {
        reply = { ...renderChatbotReply({ template_id: 'IMAGE_WITH_PHONE' }, templates, replyContext), pendingOrder: ruleReply.pendingOrder };
      } else if (['ASK_FLAVOR', 'ORDER_INFO_ASK_FLAVOR'].includes(reply.templateId) && bagCountInText(message.text) >= 2) {
        const count = bagCountInText(message.text);
        const priced = priceBasket([{ sku: 'GRA-XANH-Z450', quantity: count }], { livestream: replyContext.livestream });
        if (priced?.priceable && templates.PRICE_COUNT) {
          const gift = (priced.gifts || []).filter(item => !isFreeShippingGift(item)).map(item => item.name).join(' + ');
          const rendered = renderChatbotReply({ template_id: 'PRICE_COUNT', values: { count: String(count), total: `${Number(priced.total).toLocaleString('vi-VN')}đ`, ship: priced.shippingFee ? `${Number(priced.shippingFee).toLocaleString('vi-VN')}đ` : '', free: priced.shippingFee ? '' : '1', gift, kind: 'mix vị tùy ý' } }, templates, replyContext);
          if (rendered.templateId === 'PRICE_COUNT') reply = { ...rendered, pendingOrder: reply.pendingOrder };
        }
      }
      reply = { ...reply, attention: true };
    }
    // Vòng 12 (B1 #17): đang giữ giỏ mà khách bấm quảng cáo khác / chào lại → không chào lại bảng giá, nhắc giỏ đang giữ.
    // R13 (inbox1 B3): "có mấy loại" gõ lỗi ("Có mays lọi", "co may loi") cũng là câu hỏi danh sách vị — không thay bằng câu nhắc giỏ.
    if (basketHeld && orderStepLast && ['WELCOME', 'GENERAL_INFO'].includes(reply.templateId) && !reply.alsoTemplateId && !/\b(gia|bao nhieu|bn|loai|vi|mau)\b/.test(folded) && !asksFlavourList(message.text)) {
      const held = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, replyContext);
      if (held.remind) reply = { templateId: 'ORDER_ADDRESS_REMIND', messages: [held.remind], images: [], parts: undefined, handoff: false };
    }
    // "Chưa nhận được hàng" mà hội thoại không có đơn (đơn ở trang kia, nhân viên
    // lên tay…): bot chỉ xin SĐT được — gắn thẻ để nhân viên tra ngay.
    if (reply.templateId === 'ORDER_STATUS' && !recentOrder?.id && !lookupReply && !reply.attention) reply = { ...reply, attention: true };
    // Vòng 12 (B3 #7): đơn POS còn "Mới" quá 2 ngày = đơn kẹt → thẻ cần người (nhân viên kiểm kho/giao).
    if (reply.templateId === 'ORDER_STATUS' && recentOrder?.id && /^mới$/i.test(String(recentOrder.pos?.status || recentOrder.status || '').trim())
      && Date.now() - (Number(recentOrder.createdAt) || Date.now()) > 2 * 24 * 60 * 60 * 1000) {
      console.log(`Đơn kẹt ${recentOrder.id} còn "Mới" quá 2 ngày (${conversation.id})`);
      reply = { ...reply, attention: true };
    }
    // Khách than giao chậm / chưa nhận: luôn gắn thẻ để nhân viên tra vận đơn.
    if (reply.templateId === 'DELIVERY_DELAY' && !reply.attention) reply = { ...reply, attention: true };
    // Dưới bình luận không bao giờ chuyển người (khách chưa vào hộp thư): trả
    // bảng giá chung và mời nhắn tin. WELCOME/xác nhận đơn/"đã nhận hình" dưới
    // bình luận cũng vô nghĩa (khách đã hỏi giá rồi) → bảng giá sản phẩm của bài.
    // Riêng bình luận là khiếu nại/hủy/đổi đơn/chưa nhận hàng (khách đã là người
    // mua): không chào hàng — nhắn riêng rằng nhân viên sẽ kiểm tra, gắn thẻ.
    // Lời chê dưới bài ("hôi", "không ngon", "ăn k ngon", từ khóa khiếu nại): công khai xin lỗi + gắn thẻ,
    // nhắn riêng nhân viên kiểm tra — bất kể mô hình chọn mẫu gì. "hôi" so trên chữ CÒN DẤU (bỏ dấu
    // trùng "hỏi": "cho hỏi giá").
    const commentComplaint = conversation.source === 'comment' && (
      isComplaint({ text: message.text, keywords: settings.complaintKeywords })
      || /hôi/iu.test(String(message.text || ''))
      || /\b(khong|ko|k|kg|hong|cha|chang) (co |thay |an )?ngon\b|\b(te|do|chan) (qua|that|ghe|ec|lam)\b|\bkem (chat luong|qua)\b/.test(folded)
      // Vòng 12 (B4 #1, #2, #10): "Hok ngon nha", "ăn món này ối luôn", "không nuốt nổi", "khó ăn", "ngọt quá", "toàn gãy nứt".
      || COMMENT_DISLIKE.test(folded.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim())
      || /(?<![\p{L}\p{N}])(?:ối|ói)(?![\p{L}\p{N}])/iu.test(String(message.text || '').normalize('NFC')));
    // Vòng 12 (B4 #9): góp ý phiên live (nghe không rõ, nói nhanh, "như đọc rap", lag) → cảm ơn góp ý công khai + thẻ, không bảng giá.
    const liveFeedback = conversation.source === 'comment' && !commentComplaint && LIVE_FEEDBACK.test(folded.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim());
    if (liveFeedback && templates.COMMENT_PUBLIC_FEEDBACK) reply = { ...reply, attention: true };
    // Vòng 12 (B4 #12): "Tôi thích sản phẩm này" (câu gợi ý của FB Live) dưới live = quan tâm sản phẩm → lời chào live riêng.
    const liveInterest = conversation.source === 'comment' && (replyContext.livestream || isLivestreamPost(conversation)) && /^toi thich san pham nay/.test(folded.trim()) && templates.LIVESTREAM_COMMENT;
    if (liveInterest) reply = renderChatbotReply({ template_id: 'LIVESTREAM_COMMENT' }, templates, replyContext);
    const commentNeedsStaff = conversation.source === 'comment'
      && (commentComplaint || /\b(huy|doi don|khieu nai|chua nhan|khong thay (gui|hang)|chua thay (gui|hang)|bi loi|bi hu|sai don|giao sai)\b/.test(folded));
    // Mô hình tự chọn CSKH_HANDOFF dưới bình luận: chỉ chuyển nhân viên khi khách thật sự đòi người /
    // hủy / khiếu nại; còn lại về bảng giá của bài (không "nhân viên sẽ nhắn lại" cho câu hỏi giá).
    const commentWantsPerson = conversation.source === 'comment'
      && /\b(nhan vien|tu van vien|gap (nguoi|ai|nhan vien|admin)|goi (cho|lai|dien)|ai (tra loi|truc|ib)|lien he (lai|voi)|phan anh|so hotline|hotline)\b/.test(folded);
    // Hủy/tra đơn dưới bình luận chỉ được bot tự lo khi có đơn thật; đơn đặt trên
    // web/landing (không có trong hội thoại) thì báo nhân viên, không "chưa thấy đơn".
    // Dưới bình luận bot KHÔNG hủy/sửa/ghi chú/tạo đơn được (chỉ nhắn riêng một
    // lần): "đã hủy đơn" hay "xác nhận đơn" gửi qua bình luận là hứa suông — báo
    // nhân viên, gắn thẻ; giỏ + SĐT + địa chỉ khách ghi đi theo sang hộp thư.
    const commentOrderOp = conversation.source === 'comment' && Boolean(reply.order);
    if (conversation.source === 'comment' && templates?.COMMENT_STAFF_FOLLOWUP && (commentNeedsStaff || commentOrderOp || (reply.templateId === 'CSKH_HANDOFF' && !asksForHuman && commentWantsPerson))
      && !(reply.templateId === 'ORDER_STATUS' && recentOrder?.id)) {
      const carriedOrder = reply.templateId === 'ORDER_CONFIRMATION' && reply.order?.items?.length
        ? { items: reply.order.items.map(item => ({ product: item.product, code: item.code, quantity: item.quantity })), key: reply.order.orderKey || '', at: Date.now(), phone: reply.order.phone || '', address: reply.order.rawAddress || reply.order.address || '', addressAsks: 0 }
        : undefined;
      reply = { ...renderChatbotReply({ template_id: 'COMMENT_STAFF_FOLLOWUP' }, templates, replyContext), attention: true, ...(carriedOrder ? { pendingOrder: carriedOrder } : {}) };
    }
    const commentBlocked = new Set(['CSKH_HANDOFF', 'WELCOME', 'ASK_PRODUCT', 'IMAGE_RECEIVED']);
    if (commentBlocked.has(reply.templateId) && !asksForHuman && conversation.source === 'comment' && templates?.GENERAL_INFO) {
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
      const orderReply = renderChatbotReply(value, templates, replyContext);
      const asksInfo = /\?|\b(gia|bn|bao nhieu|khac|sao|ntn|the nao|gam|gram|ngon|nao)\b/.test(folded);
      reply = asksInfo ? { ...reply, pendingOrder: orderReply.pendingOrder } : orderReply;
    }
    // R13 (bình luận F8): bình luận đặt hàng có món bộ đọc giỏ không biết ("1 tui nau 1 yen mach", "1 xanh, 1 cam", "Tui xanh
    // va 10goi") → ghi nhận nguyên văn (ORDER_CUSTOM_BASKET) + thẻ, không dựng giỏ thiếu món / không để mô hình đoán.
    const unknownBasketComment = conversation.source === 'comment' && !commentNeedsStaff && !commentOrderOp && Boolean(templates?.ORDER_CUSTOM_BASKET) && commentBasketUnknown(message.text);
    if (unknownBasketComment) {
      const said = String(message.text || '').replace(/\+?\d[\d .-]{8,13}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
      const custom = renderChatbotReply({ template_id: 'ORDER_CUSTOM_BASKET', values: { cart: `"${said}"`, missing: 'số điện thoại và địa chỉ nhận hàng' } }, templates, replyContext);
      if (custom.templateId === 'ORDER_CUSTOM_BASKET') reply = { ...custom, attention: true, pendingOrder: undefined, order: undefined };
    }
    // R13 (bình luận F5): dưới bài LIVE (nhiều sản phẩm) khách nêu số túi mà không nêu vị ("Lấy 2 túi", "chốt 2 túi nha") —
    // mô hình hay tự chọn một vị rồi dựng giỏ. Giỏ rỗng mà câu trả lời là bước đơn → hỏi vị (ASK_FLAVOR), giữ số túi khách
    // nêu (askedBagCount đi theo sang hộp thư) — không đoán vị.
    const guessedFlavour = conversation.source === 'comment' && (isLivestreamPost(conversation) || replyContext.livestream) && !basket.length && !unknownBasketComment
      && !commentNeedsStaff && (Boolean(reply.pendingOrder?.items?.length) || isOrderStep(reply.templateId)) && Boolean(templates?.ASK_FLAVOR)
      && !/\b(xanh|vang|nau|cacao|mint|tropical|hop|goi nho|yen mach|nghe)\b|\b10 ?goi\b/.test(folded) && !matchProduct(String(message.text || ''));
    if (guessedFlavour) {
      const ask = renderChatbotReply({ template_id: 'ASK_FLAVOR' }, templates, replyContext);
      const count = bagCountInText(message.text);
      if (ask.templateId === 'ASK_FLAVOR') {
        reply = { ...ask, ...(reply.attention ? { attention: true } : {}), order: undefined, pendingOrder: { items: [], key: '', at: Date.now(), phone: String(reply.pendingOrder?.phone || extractVietnamesePhone(String(message.text || '')) || ''), address: String(reply.pendingOrder?.address || ''), addressAsks: 0, ...(count > 0 ? { askedBagCount: count } : {}) } };
      }
    }
    // Phiên live: khách báo "đã săn/đã mua 290k", hỏi "săn thế nào", mà chưa có
    // đơn → ghi nhận và xin loại, số lượng, SĐT, địa chỉ (trước đây nhận "chưa
    // thấy đơn nào" hay mẫu voucher sàn, không ai chốt).
    // Khiếu nại/hủy/chưa nhận hàng dưới live không phải "vừa săn deal".
    const saysMisclick = !nonText && misclickPattern.test(folded);
    const liveDeal = isLivestreamPost(conversation) && !recentOrder?.id && !basket.length && !commentNeedsStaff && templates?.LIVE_DEAL_CLAIMED
      && !/\b(chua (nhan|thay|giao)|huy|khieu nai|bi loi|bi hu)\b/.test(folded)
      // Vòng 12 (B4 #7): không còn "mã gì" ("Hộp nhựa là mã gì" là hỏi sản phẩm, không phải vừa săn deal).
      // R13 (inbox2 B2): mô hình trả ORDER_STATUS cho tin KHÔNG nói gì về săn deal ("Chị ấn nhấn nhầm đấy", "Ko c có ăn dc
      // đâu" sau khi bấm giỏ Shop) từng bị đổi thành "em ghi nhận chị đã săn deal trên live". ORDER_STATUS chỉ được đổi khi
      // khách không đang giữ giỏ và không nói bấm nhầm; khách tự nói "đã săn/đã mua trên live" thì vẫn ghi nhận như cũ.
      && (/\b(da (san|mua|chot|dat)|san (duoc|deal|the nao|tn|sao|ntn)|len ma|cach (san|chot|tham gia|dat|mua))\b/.test(folded)
        || (reply.templateId === 'ORDER_STATUS' && !basketHeld && !saysMisclick));
    if (liveDeal) reply = { ...renderChatbotReply({ template_id: 'LIVE_DEAL_CLAIMED' }, templates, replyContext), attention: true };
    // Khách nói bấm nhầm khi đang giữ giỏ (chưa có đơn) mà mô hình kể trạng thái đơn: ghi nhận, bỏ giỏ — không "chưa thấy đơn".
    else if (saysMisclick && basketHeld && !recentOrder?.id && conversation.source !== 'comment' && reply.templateId === 'ORDER_STATUS' && !reply.order && templates?.ORDER_POSTPONED) {
      const postponed = renderChatbotReply({ template_id: 'ORDER_POSTPONED' }, templates, replyContext);
      if (postponed.templateId === 'ORDER_POSTPONED') reply = { ...postponed, pendingOrder: null };
    }
    // Dưới phiên livestream nhiều sản phẩm, "hỏi giá chung" không nên là bảng
    // 3 vị khô khan: dùng lời chào live (nêu các vị có trên live, ưu đãi live,
    // hỏi khách quan tâm loại nào) nếu chủ shop có soạn mẫu LIVESTREAM_COMMENT.
    // Câu hỏi không phải hỏi giá (mẹ bầu, cho bé, yến mạch, hạt điều) thì trả đúng mẫu.
    if (reply.templateId === 'GENERAL_INFO' && templates?.LIVESTREAM_COMMENT && (isLivestreamPost(conversation) || replyContext.livestream)) {
      const routed = [
        [/\b(me bau|bau bi|dang bau|tieu duong|benh)\b/, 'HEALTH_CONDITION'],
        [/\b(cho be|be an|tre em|tre nho|con nho)\b/, 'KIDS_FAMILY'],
        [/\byen mach\b/, 'PRICE_YEN_MACH_UC_NGUYEN_CAM'],
        [/\b(hat dieu|hat bi|sua hat|xoai|dau say)\b/, 'LIVE_ONLY_PRODUCT']
      ].find(([pattern, id]) => pattern.test(folded) && templates?.[id]);
      reply = renderChatbotReply({ template_id: routed ? routed[1] : 'LIVESTREAM_COMMENT' }, templates, replyContext);
    }
    // Khách đến từ live (bài live hay thẻ Livestream) hỏi giá / số túi / quà: lời chào live (nêu vị, ưu đãi
    // live) thay cho chính sách quà / voucher sàn / bảng mix.
    // Vòng 11 (V11): cùng định nghĩa khách live với luật/mẫu (isLivestreamCustomer: bài live, thẻ, post.isLive).
    const liveContext = isLivestreamCustomer(conversation) || conversationLabels.includes('livestream');
    // Vòng 12 (B4 #5, B2 #13, B3 #4): PRICE_QUOTE / GIFT_POLICY / FREESHIP_POLICY / giảm giá cho khách live → lời live (2 túi 298k
    // miễn ship tặng Quạt + Bát gáo dừa), GIFT_POLICY bỏ điều kiện từ khóa; ý phụ (alsoTemplateId) cũng vậy; ảnh quà khi hỏi.
    reply = contextualAlso(contextualReply(reply));
    // Mô hình chọn mẫu live cho khách không đến từ live: đổi về mẫu thường.
    if (!liveContext && conversation.source !== 'comment') {
      if (reply.templateId === 'LIVESTREAM_COMMENT' && templates?.GENERAL_INFO) reply = renderChatbotReply({ template_id: 'GENERAL_INFO' }, templates, replyContext);
      else if (reply.templateId === 'LIVESTREAM_VOUCHER' && templates?.DISCOUNT_POLICY) reply = renderChatbotReply({ template_id: 'DISCOUNT_POLICY' }, templates, replyContext);
    }
    // R13 (inbox1 B2, inbox3 F4, bình luận F6): LIVE_ONLY_PRODUCT ("chỉ bán theo giá ưu đãi trên phiên live… em giữ giá live")
    // chỉ dùng khi khách là khách live VÀ tin nêu đúng món trong danh sách hàng live (regex LIVE_ONLY của rule-intent: sữa
    // hạt, hạt điều, hạt bí, xoài, dâu sấy, hũ hạt). Còn lại (món shop không bán — "Hạt thông bóc vỏ của Nga", ảnh sản phẩm
    // lạ, khách không đến từ live): không hứa "giữ giá live" —
    // - tin nêu Granola Tropical (đã có trong danh mục) → bảng giá Tropical;
    // - ảnh/tệp (không biết khách hỏi gì) → như ảnh thường: "đã nhận hình" / lời chào live + thẻ, bot vẫn bật, không chuyển CSKH;
    // - chữ → mẫu chuyển nhân viên có sẵn (STAFF_ONLY_PRODUCT; bình luận: COMMENT_STAFF_FOLLOWUP) + thẻ, bot vẫn bật.
    // LIVE_ONLY_PRODUCT / OTHER_PRODUCTS luôn gắn thẻ Cần người xử lý (trước đây bình luận hỏi món lạ không ai thấy).
    if (reply.templateId === 'LIVE_ONLY_PRODUCT') {
      const liveListed = !nonText && liveOnlyProductPattern.test(folded) && !/\bxoai dau\b/.test(folded);
      const tropicalProduct = !nonText && TROPICAL_MENTION.test(folded.replace(/[^a-z0-9 ]+/g, ' ')) ? findProductBySku('GRA-MINT-Z300') : null;
      if (tropicalProduct && tropicalProduct.active !== false && templates?.PRICE_QUOTE) {
        reply = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: tropicalProduct.name }, templates, replyContext);
      } else if (nonText) {
        reply = imageFallback();
      } else if (!(liveListed && (liveContext || conversation.source === 'comment'))) {
        const staffId = conversation.source === 'comment' && templates?.COMMENT_STAFF_FOLLOWUP ? 'COMMENT_STAFF_FOLLOWUP' : 'STAFF_ONLY_PRODUCT';
        const staff = renderChatbotReply({ template_id: staffId, values: { product: 'sản phẩm mình hỏi' } }, templates, replyContext);
        // Mẫu bị tắt trong Cài đặt (bộ soạn trả bảng giá chung cho mã mẫu trống) → chuyển người như trước đây.
        const safe = staff.templateId === staffId ? staff : renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, templates, replyContext);
        reply = { ...safe, attention: true, pendingOrder: undefined, order: undefined };
      }
    }
    if (['LIVE_ONLY_PRODUCT', 'OTHER_PRODUCTS'].includes(reply.templateId) && !reply.attention) reply = { ...reply, attention: true };
    // KHÔNG dựng giỏ/đơn từ tin không phải đặt hàng (Vy Hoang: ảnh + "xanh mint" bị lên nhầm Túi Nâu):
    // - tin chỉ ảnh (không chữ) mà khách chưa từng nêu sản phẩm → báo đã nhận hình / bảng giá quảng cáo;
    // - tin chỉ "hình / ảnh 2 / xem hình" → ảnh sản phẩm, không giỏ;
    // - tin nêu vị chỉ bán trên live (xanh mint, dâu, tropical, hạt điều…) → LIVE_ONLY_PRODUCT + thẻ, không giỏ.
    const createsBasket = item => Boolean(item.order) || Boolean(item.pendingOrder?.items?.length) || isOrderStep(item.templateId) || item.templateId === 'ORDER_CUSTOM_BASKET';
    const earlierTexts = replyContext.recentCustomerTexts.filter(text => squashText(text) !== squashText(message.text));
    const namedProductBefore = earlierTexts.some(text => /\b(tui|goi|bich|hop|combo|xanh|vang|nau|cacao|granola|lay|dat|mua|chot)\b/.test(foldVietnamese(text)));
    const photoOnly = !nonText && /^(?:(?:cho|shop|em|e|minh|m|c|chi|a|anh|toi)\s+)*(?:(?:xem|coi|gui|cho xem|cho coi|xin)\s+)?(?:hinh|anh|hinh anh)(?:\s+(?:\d+|that|san pham|tui|goi|mau|san pham that))*(?:\s+(?:xem|coi|di|nha|nhe|a|voi|duoc khong|dc ko|dc k|ntn|sao|nao|cai|shop|em|e))*$/.test(folded);
    // Vòng 12: Tropical (xanh mint/dương/biển, dâu) là sản phẩm danh mục → giỏ hợp lệ; "xanh nhạt" mơ hồ thì không dựng giỏ.
    const liveOnlyMention = /\b(hat dieu|hat bi|sua hat|dau say|hu hat|xanh nhat)\b/.test(folded) || (/\bxoai\b/.test(folded) && !/\bxoai dau\b/.test(folded));
    const mintBasket = (reply.order?.items || reply.pendingOrder?.items || []).some(item => /mint|tropical/i.test(String(item.code || item.sku || item.product || item.name || '')));
    // Vòng 12: khách nêu Tropical mà giỏ (mô hình) không có Tropical → báo giá Tropical, không dựng giỏ sai món.
    const tropicalNamed = !nonText && TROPICAL_MENTION.test(folded.replace(/[^a-z0-9 ]+/g, ' '));
    if (tropicalNamed && createsBasket(reply) && !mintBasket) {
      const tropical = findProductBySku('GRA-MINT-Z300');
      if (tropical) reply = { ...renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: tropical.name }, templates, replyContext), attention: true, pendingOrder: undefined, order: undefined };
    }
    if (nonText && !paymentReply && createsBasket(reply) && !namedProductBefore && !(message.withImage && /\b(tui|goi|bich|hop|combo|xanh|vang|nau|cacao|lay|dat|mua|chot)\b/.test(folded))) reply = imageFallback();
    else if (photoOnly && createsBasket(reply)) reply = { ...renderChatbotReply({ template_id: 'PRODUCT_PHOTOS', ...(productHint(ruleProduct) ? { Product_N1: ruleProduct } : {}) }, templates, replyContext), pendingOrder: undefined, order: undefined };
    else if (!nonText && liveOnlyMention && createsBasket(reply) && !mintBasket) {
      const liveOnly = renderChatbotReply({ template_id: 'LIVE_ONLY_PRODUCT' }, templates, replyContext);
      reply = { ...(liveOnly.templateId === 'LIVE_ONLY_PRODUCT' ? liveOnly : renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, templates, replyContext)), attention: true, pendingOrder: undefined, order: undefined };
    }
    // Bình luận nêu vị lạ (dâu, mint): nhân viên xem, không dựng giỏ thiếu.
    if (conversation.source === 'comment' && liveOnlyMention && !reply.attention) reply = { ...reply, attention: true };
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
    // (normalizeSent khai báo ở trên, dùng chung với sentRecently.)
    const firstLine = normalizeSent(reply.messages?.[0] || '');
    const repeatsText = staleGeneralInfo || firstLine.length > 20 && recent.some(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo && normalizeSent(item.text).includes(firstLine));
    const noRepeatTemplates = new Set(['WELCOME', 'THANK_YOU', 'CSKH_HANDOFF', 'ORDER_CONFIRMATION', 'ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'GENERAL_INFO', 'LIVESTREAM_COMMENT']);
    const repeatsTemplate = noRepeatTemplates.has(reply.templateId) && conversation.botLastTemplateId === reply.templateId && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 60 * 1000;
    // Giỏ mới khác giỏ đang giữ (giỏ Shop mới, khách đổi vị/số túi, nhận lời gợi
    // ý 2 túi): là thay đổi thật, không phải lặp — trước đây bot im và giỏ mới mất.
    const changedCart = Boolean(reply.pendingOrder?.key) && reply.pendingOrder.key !== conversation.pendingOrder?.key;
    // Ghi chú/hủy/sửa đơn là thao tác thật (lời dặn thứ hai khác lời dặn đầu dù câu
    // trả lời giống nhau): không coi là lặp.
    const orderAction = Boolean(reply.order?.noteOrderId || reply.order?.cancelOrderId || reply.order?.updateOrderId);
    // Vòng 11 (P1): câu trả lời cho câu hỏi khách vừa hỏi khi đang giữ giỏ không phải lặp.
    // Vòng 12 (B5 #2): tin mang thông tin MỚI (SĐT, địa chỉ, "địa chỉ cũ", hủy/khoan giao, ghi chú giao hàng) không phải lặp —
    // ca "2 túi này ak\n<sđt>\nĐc:… Bến Tre\nĐc cũ" bị im 4 lần vì câu trả lời trùng ASK_FLAVOR vừa gửi. Vẫn trả lời (kèm thẻ
    // cần người); hỏi vị lần nữa thì ghi nhận SĐT trước (ORDER_INFO_ASK_FLAVOR) và giữ SĐT vào giỏ chờ.
    const isComment = conversation.source === 'comment';
    const newInfoText = !nonText && !isComment && (Boolean(phoneInText) || Boolean(trace.ctx?.addressInText)
      || /\b(?:dia chi|dc|d c|dchi) cu\b|\bnhu (?:cu|lan truoc)\b/.test(folded)
      || CANCEL_ORDER.test(folded) || HOLD_DELIVERY.test(folded) || DELIVERY_NOTE.test(folded));
    // R13: lời xin SĐT/địa chỉ của giỏ Shop sau tin "đã nhận giỏ, chờ em kiểm tra" (cartAckSent) không phải lặp.
    const repeatsBeforeInfo = (repeatsText || repeatsTemplate) && !changedCart && !orderAction && !answeredWhileHeld && !cartAckSent;
    if (repeatsBeforeInfo && newInfoText) {
      console.log(`Tin có thông tin mới (SĐT/địa chỉ/hủy/ghi chú) trùng câu vừa gửi: vẫn trả lời + thẻ (${conversation.id})`);
      if (['ASK_FLAVOR', 'ORDER_INFO_ASK_FLAVOR'].includes(reply.templateId) && phoneInText) {
        const asked = renderChatbotReply({ template_id: 'ORDER_INFO_ASK_FLAVOR', Phone_Number: phoneInText }, templates, replyContext);
        const wantsPrevious = /\b(?:dia chi|dc|d c|dchi) cu\b|\bnhu (?:cu|lan truoc)\b/.test(folded);
        reply = { ...asked, pendingOrder: { ...(conversation.pendingOrder || {}), items: conversation.pendingOrder?.items || [], key: conversation.pendingOrder?.key || '', at: Date.now(), phone: phoneInText, address: conversation.pendingOrder?.address || '', addressAsks: Number(conversation.pendingOrder?.addressAsks) || 0, ...(wantsPrevious ? { wantsPrevious: true } : {}) } };
      }
      reply = { ...reply, attention: true };
    }
    const repeatsLast = repeatsBeforeInfo && !newInfoText;
    const repeatsHandoff = reply.templateId === 'CSKH_HANDOFF' && conversation.botLastTemplateId === 'CSKH_HANDOFF'
      && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 24 * 60 * 60 * 1000;
    if (repeatsLast || repeatsHandoff) {
      // Chỉ im lặng với lời đáp ngắn ("ok", "dạ") hay khi đã chuyển người; khách
      // nhắn có nội dung mà bot sắp lặp lại tin vừa gửi thì không để khách chờ:
      // - bước đơn (xin SĐT/địa chỉ): nhắc ngắn giỏ + tổng + phần còn thiếu;
      // - bảng giá: nhắc "đã gửi ở trên" và mời chốt (chỉ khi chưa có đơn);
      // - thông tin khác: nói đã gửi ở trên, gắn thẻ để nhân viên giải thích thêm.
      const substantive = !shortAck && message.type === 'text' && folded.replace(/\s+/g, '').length >= 2;
      const informational = !isOrderStep(reply.templateId) && !['ASK_FLAVOR', 'ASK_PRODUCT', 'THANK_YOU', 'WELCOME', 'CSKH_HANDOFF', 'ORDER_UNCHANGED', 'ORDER_CUSTOM_BASKET'].includes(reply.templateId);
      const priceFamily = priceFamilyTemplates;
      const remindOrder = repeatsLast && !repeatsHandoff && substantive && Boolean(reply.remind) && conversation.botLastTemplateId !== 'ORDER_ADDRESS_REMIND' && !isComment;
      // Khách đã đặt đơn (24 giờ, chưa hủy) mà hỏi lại điều vừa kèm trong tin xác
      // nhận ("Hà Nội mấy ngày tới?"): trả lời lại đúng thông tin đó, trừ khi
      // chính nó là tin bot vừa gửi.
      const answerAgain = repeatsLast && !repeatsHandoff && informational && substantive && hasOrder
        && conversation.botLastTemplateId !== reply.templateId && !isComment;
      const nudgeId = priceFamily.has(reply.templateId) && !hasOrder ? 'REPLY_ALREADY_SENT' : 'REPLY_ALREADY_SENT_INFO';
      // Nhắc 'đã gửi ở trên' chỉ khi CHÍNH KHÁCH lặp lại câu vừa hỏi (giống ≥ 80%) hay chỉ giục
      // ("sao chưa trả lời", "???", "alo"). Đọc 361 hội thoại 24–25/09 + 7 ca 26–28/09: mọi lần nhắc
      // cho tin có ý mới / dấu hỏi đều sai → tin đó im và gắn thẻ để nhân viên trả lời.
      const canNudge = repeatsLast && !answerAgain && !remindOrder && informational && substantive && (customerRepeats || nudgeLike) && templates?.[nudgeId]
        && !['REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO'].includes(conversation.botLastTemplateId) && !isComment;
      // R13 (inbox1 A3, inbox2 B4 — 53 lượt "lặp tin vừa gửi" trong 3 ngày, ~30 lượt là câu hỏi có nội dung): câu trả lời
      // trùng tin vừa gửi mà khách hỏi ý MỚI (tin có nội dung, không lặp câu trước, không phải giục) → gọi lại mô hình MỘT
      // lần với gợi ý "KHÔNG chọn lại <mẫu vừa gửi>" (tiền lệ: THANK_YOU cho tin không phải lời cảm ơn). Chỉ nhận câu trả lời
      // thông tin khác hẳn (không lên/sửa/hủy đơn, không chuyển người, không lặp tin vừa gửi); vẫn trùng → im + thẻ như cũ.
      // Khách hỏi lại GIÁ bằng lời khác mà bảng giá vừa gửi thì không gọi lại (mô hình bị ép chọn mẫu khác sẽ lạc đề).
      let rescued = null;
      const canRetryDifferent = !canNudge && !answerAgain && !remindOrder && repeatsLast && !repeatsHandoff && substantive && !customerRepeats && !nudgeLike
        && !isComment && !nonText && !asksForHuman && !cartReply && !trialActive && !message.likeSticker
        && !(priceFamily.has(reply.templateId) && priceLikeText && !staleGeneralInfo);
      if (canRetryDifferent) {
        const avoid = [...new Set([reply.templateId, reply.alsoTemplateId, chosenTemplateId, conversation.botLastTemplateId, ...(staleGeneralInfo ? ['GENERAL_INFO', 'PRICE_QUOTE'] : [])]
          .map(id => String(id || '')).filter(id => /^[A-Z0-9_]+$/.test(id) && !isOrderStep(id) && id !== 'ORDER_ADDRESS_REMIND'))];
        const names = avoid.join(', ') || reply.templateId;
        const again = await askModel({ replyHint: `LƯU Ý: bot VỪA GỬI khách mẫu ${names} rồi. Khách đang hỏi ý KHÁC — chọn mẫu trả lời đúng câu khách vừa hỏi (KHÔNG chọn lại ${names}).`, hintLabel: 'no-repeat' })
          .then(answer => (answer ? contextualAlso(contextualReply(answer)) : null))
          .catch(error => { if (error instanceof NewerMessageSkip) throw error; console.warn(`Gọi lại mô hình (tránh lặp) lỗi (${conversation.id}): ${String(error?.message || error).slice(0, 120)}`); return null; });
        const againLine = normalizeSent(again?.messages?.[0] || '');
        const unusable = !again || again.handoff || Boolean(again.order) || avoid.includes(again.templateId) || nudgeTemplateIds.includes(again.templateId)
          || ['THANK_YOU', 'WELCOME', 'CSKH_HANDOFF', 'IMAGE_RECEIVED', 'LIVE_DEAL_CLAIMED', 'LIVE_ONLY_PRODUCT', 'ASK_PRODUCT'].includes(again.templateId)
          || (again.templateId === 'GENERAL_INFO' && !priceLikeText)
          || (isOrderStep(again.templateId) && !(again.pendingOrder?.key && again.pendingOrder.key !== conversation.pendingOrder?.key))
          || (createsBasket(again) && (tropicalNamed || liveOnlyMention || photoOnly))
          || (againLine.length > 20 && recent.some(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo && normalizeSent(item.text).includes(againLine)));
        if (!unusable) {
          console.log(`Trùng tin vừa gửi (${reply.templateId}) mà khách hỏi ý mới: mô hình chọn lại ${again.templateId} (${conversation.id})`);
          rescued = again.templateId === 'OTHER_PRODUCTS' ? { ...again, attention: true } : again;
        }
      }
      // R14 (chủ shop 03/10): 25 lượt/ngày bot im vì trùng tin vừa gửi, 7 khách chờ hơn 1 giờ (phần lớn buổi tối). Khách
      // hộp thư nhắn có nội dung mà không cứu được bằng câu khác → báo bạn phụ trách trả lời (trong giờ 8h–17h: ngay; ngoài
      // giờ: từ 8h sáng) + thẻ cần người. Mỗi hội thoại tối đa 1 lần mỗi 2 giờ; đã chuyển người trong 24 giờ thì vẫn im.
      const staffWaitDue = !rescued && !canNudge && !answerAgain && !remindOrder && repeatsLast && !repeatsHandoff && substantive
        && !isComment && !nonText && !message.likeSticker
        && Date.now() - (Number(conversation.staffWaitAt) || 0) >= STAFF_WAIT_COOLDOWN_MS;
      if (staffWaitDue) {
        const wait = staffWaitTemplate();
        const waitReply = renderChatbotReply({ template_id: wait.templateId, values: { when: wait.when } }, templates, replyContext);
        if (waitReply.templateId === wait.templateId && waitReply.messages?.length) {
          console.log(`Trùng tin vừa gửi (${reply.templateId}) mà khách hỏi ý mới: báo bạn phụ trách trả lời (${wait.templateId}) (${conversation.id})`);
          rescued = { ...waitReply, pendingOrder: reply.pendingOrder, attention: true, staffWait: true };
        }
      }
      if (rescued) reply = rescued;
      else if (!canNudge && !answerAgain && !remindOrder) {
        // Im lặng nhưng không bỏ rơi: giỏ mới vẫn được lưu; khách nhắn có nội
        // dung thì gắn thẻ để nhân viên thấy có người đang chờ.
        if (saveBotState && !isComment) {
          await saveBotState(conversation.id, {
            ...(reply.pendingOrder !== undefined ? { pendingOrder: reply.pendingOrder } : {}),
            ...(substantive && !repeatsHandoff ? { addLabelEvents: ['handoff'] } : {}),
            // R13 (F1): dấu bền "bot đã xét tin này và chủ ý im" — backlog sau khởi động không đưa lại (hết 10 phút chống
            // lặp thì lần đưa lại sẽ gửi đúng câu đã gửi).
            ...(change.message?.id || change.message?.mid ? { botHandledMessageId: String(change.message.id || change.message.mid) } : {})
          }).catch(() => {});
        }
        // Vòng 12 (B5 #2): bình luận có nội dung/SĐT bị bỏ ("O<sđt>", "Ib", "Như đọc ráp") → thẻ cần người xem; bình luận có
        // SĐT vẫn được ẩn (không nằm hiện trên bài).
        if (isComment) {
          const commentPhone = Boolean(extractVietnamesePhone(String(message.text || '')));
          if (saveBotState && (substantive || commentPhone)) await saveBotState(conversation.id, { addLabelEvents: ['handoff'] }).catch(() => {});
          if (commentPhone && ['phone', 'all'].includes(settings.commentHide)) await moderateBundledComments();
        }
        results.push({ conversationId: conversation.id, skipped: repeatsLast ? 'lặp tin vừa gửi' : 'đã chuyển người trong 24 giờ' });
        return;
      }
      if (remindOrder) reply = { ...reply, templateId: 'ORDER_ADDRESS_REMIND', messages: [reply.remind], parts: undefined, images: [] };
      else if (canNudge) reply = { ...renderChatbotReply({ template_id: nudgeId }, templates, replyContext), pendingOrder: reply.pendingOrder, attention: nudgeId === 'REPLY_ALREADY_SENT_INFO' };
    }
    // Trong lúc chờ mô hình khách nhắn thêm (chữ hay ảnh): bỏ câu này, tin sau trả lời gộp.
    const latestMessages = await listMessages(conversation.id);
    if (hasNewerCustomerMessage(latestMessages, change.message)) {
      results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
      return;
    }
    // Vòng 12 (B2 #22, B3 #22): nhân viên vừa trả lời khách trong lúc bot soạn → không gửi chồng (bình luận: tin công khai NV).
    const askedAtMs = Number(change.message?.createdAt) || 0;
    if (askedAtMs && (Array.isArray(latestMessages) ? latestMessages : []).some(item => item?.direction === 'outgoing' && item.staff && (Number(item.createdAt) || 0) >= askedAtMs)) {
      results.push({ conversationId: conversation.id, skipped: 'nhân viên vừa trả lời' });
      return;
    }
    // Nhân viên vừa nhận khách (tắt bot) trong lúc model chạy: không lên đơn trùng
    // với đơn nhân viên đang lên, không gửi chuỗi xác nhận thứ hai. T2 (01/10): đọc lại cho MỌI lượt
    // (cả tin không có đơn, cả bình luận) — trước đây chỉ khi có đơn nên bot vẫn gửi 1 tin thừa.
    if (getConversation) {
      const latest = await getConversation(conversation.id).catch(() => null);
      if (latest?.botEnabled === false) {
        results.push({ conversationId: conversation.id, skipped: 'nhân viên đã nhận khách' });
        return;
      }
    }
    // Khách đang có đơn trong 7 ngày (chưa hủy) mà sắp lên đơn MỚI: chưa tạo — kể đơn đang có và hỏi
    // khách xác nhận đặt thêm; khách "đúng" thì lượt sau chốt giỏ đang giữ (chủ shop 26/09: Mai Tran bị
    // tạo đơn thứ hai trong khi đơn 24/09 còn đang giao).
    const existingRecent = recentOrder?.id && Date.now() - (Number(recentOrder.createdAt) || 0) < 7 * 24 * 60 * 60 * 1000 && isActiveOrder(recentOrder) ? recentOrder : null;
    // Chỉ lời "đúng" tường minh cho câu hỏi vừa gửi mới được bỏ bước hỏi; giỏ mới (luật giỏ / mô hình)
    // trong lúc đang chờ, hay cờ chờ còn sót khi giỏ đã quá hạn, đều hỏi lại với giỏ mới.
    const explicitYes = awaitingYes && reply === existingConfirmReply;
    // Tin là câu hỏi GIÁ ("E mua 2 túi giá bao nhiêu?") mà mô hình chốt đơn: báo giá, không hỏi "đặt thêm?"
    // (ca Đào Bia bị hỏi xác nhận đặt thêm 2 Xanh). Một loại → bảng giá loại đó; nhiều loại → bảng mix.
    const newOrderReply = Boolean(reply.order) && !reply.order.updateOrderId && !reply.order.cancelOrderId && !reply.order.noteOrderId && !isComment;
    // Đơn ngoài hội thoại cùng SĐT (landing / nhân viên lên trên POS) trong 7 ngày: hỏi xác nhận đặt thêm
    // như đơn trong hội thoại (10 ca trùng đơn 21–28/09). POS lỗi/hết giờ → vẫn lên đơn nhưng gắn thẻ soát trùng.
    let outsideOrder = null;
    // Chỉ tra khi môi trường có POS/kho landing (server đưa findShopOrder) hay test đưa rõ fetchImpl/posConfig/readLandingStore.
    const canLookupOutside = typeof dependencies.findShopOrder === 'function' || dependencies.fetchImpl || dependencies.posConfig || dependencies.readLandingStore;
    if (newOrderReply && !existingRecent && !explicitYes && !awaitingRecent && canLookupOutside && templates?.ORDER_EXISTING_CONFIRM && reply.order.phone) {
      const found = await findExternalOrders(reply.order.phone, {
        fetchImpl: dependencies.fetchImpl || fetch,
        config: dependencies.posConfig || null,
        landingStore: dependencies.readLandingStore || readLandingStore,
        excludeIds: allOrders.map(order => String(order?.id || ''))
      }).catch(caught => ({ orders: [], error: caught.message }));
      outsideOrder = found.orders[0] || null;
      if (found.error) {
        console.warn(`Tra POS lỗi (${normalizeWarningPhone(reply.order.phone)}, ${conversation.id}): ${found.error} — vẫn lên đơn, gắn thẻ soát trùng`);
        reply = { ...reply, attention: true };
      } else if (outsideOrder) console.log(`Đơn ngoài hội thoại ${outsideOrder.id} (${outsideOrder.source}) cùng SĐT: hỏi khách xác nhận trước (${conversation.id})`);
    }
    // Đang chờ xác nhận vì đơn ngoài (landing/POS) đã lưu kèm giỏ chờ: lượt này không tra lại nhưng vẫn là "đang có đơn".
    const existingAny = existingRecent || outsideOrder || (awaitingRecent ? conversation.pendingOrder?.externalOrder || null : null);
    if (newOrderReply && existingAny && !explicitYes && !phoneInText && priceAsk.test(folded)) {
      const names = [...new Set((reply.order.items || []).map(item => String(item.product || item.name || '')).filter(Boolean))];
      const quoteValue = names.length === 1 && templates?.PRICE_QUOTE ? { template_id: 'PRICE_QUOTE', Product_N1: names[0] }
        : names.length > 1 && templates?.PRICE_MIX_TUI_LON ? { template_id: 'PRICE_MIX_TUI_LON' } : { template_id: 'GENERAL_INFO' };
      const quoted = renderChatbotReply(quoteValue, templates, replyContext);
      if (!quoted.handoff) reply = { ...quoted, order: undefined, pendingOrder: undefined };
    }
    // Vòng 11 (P4/E7): đang chờ "đặt thêm?" (< 30 phút) mà tin CUỐI của khách nhắc lại ĐÚNG giỏ đang chờ ("2 túi vàng
    // nhé") = đồng ý → lên đơn luôn. Giỏ khác: lần đầu vẫn giữ giỏ + gắn thẻ + im (không hỏi lại ngay, log vòng 8);
    // lần sau (đã im một lần, heldSilently) thì hỏi lại với giỏ đang giữ — không im mãi ("shop ơi").
    const namesBasketNow = /\b(tui|goi|bich|xanh|vang|nau|cacao|combo)\b/.test(foldVietnamese(String(change.message?.text || '')));
    const restatesAsked = awaitingRecent && namesBasketNow && Boolean(reply.order?.orderKey) && reply.order.orderKey === String(conversation.pendingOrder?.key || '');
    if (restatesAsked) console.log(`Khách nhắc lại đúng giỏ đang chờ xác nhận đặt thêm: coi như đồng ý, lên đơn (${conversation.id})`);
    if (reply.order && !reply.order.updateOrderId && !reply.order.cancelOrderId && !reply.order.noteOrderId && !isComment && existingAny && !explicitYes && !restatesAsked && templates?.ORDER_EXISTING_CONFIRM) {
      const cart = `${(reply.order.items || []).map(item => `${Number(item.quantity) || 1} ${item.product || item.name}`).join(' + ')}${reply.order.total ? ` – tổng ${Number(reply.order.total).toLocaleString('vi-VN')}đ` : ''}`;
      // Đã hỏi "đặt thêm?" trong 30 phút: không hỏi lại ngay — giữ giỏ mới với cờ chờ, gắn thẻ, im (một lần).
      if (awaitingRecent && !conversation.pendingOrder?.heldSilently) {
        console.log(`Đơn mới khi đang chờ xác nhận đặt thêm (đã hỏi < 30 phút): giữ giỏ, không hỏi lại (${conversation.id})`);
        if (saveBotState) {
          await saveBotState(conversation.id, {
            pendingOrder: { items: (reply.order.items || []).map(item => ({ product: item.product || item.name, code: item.code || item.sku || '', quantity: Number(item.quantity) || 1 })), key: reply.order.orderKey || '', at: Number(conversation.pendingOrder?.at) || Date.now(), phone: reply.order.phone || '', address: reply.order.rawAddress || reply.order.address || '', addressAsks: maxAddressAsks, awaitingConfirm: true, heldSilently: true, ...(conversation.pendingOrder?.externalOrder ? { externalOrder: conversation.pendingOrder.externalOrder } : {}) },
            addLabelEvents: ['handoff']
          }).catch(() => {});
        }
        results.push({ conversationId: conversation.id, skipped: 'đang chờ xác nhận đặt thêm' });
        return;
      }
      // Đơn ngoài hội thoại: giỏ/giờ đơn cũ lấy từ đơn landing/POS (recentOrder tạm cho mẫu).
      // C2 (01/10): đơn ngoài hội thoại (landing/POS tìm theo SĐT) có thể là của người khác: hỏi mà không kể chi tiết đơn,
      // gắn thẻ + ghi chú cho nhân viên đối chiếu. Đơn trong hội thoại thì kể như cũ.
      const outside = existingAny !== existingRecent;
      const ask = outside && templates?.ORDER_EXISTING_CONFIRM_PHONE
        ? { ...renderChatbotReply({ template_id: 'ORDER_EXISTING_CONFIRM_PHONE', values: { cart } }, templates, replyContext), templateId: 'ORDER_EXISTING_CONFIRM' }
        : renderChatbotReply({ template_id: 'ORDER_EXISTING_CONFIRM', cart }, templates, { ...replyContext, recentOrder: existingAny });
      if (outside && ask.templateId === 'ORDER_EXISTING_CONFIRM') await noteForStaff(dependencies, conversation, `Khách lên đơn mới với SĐT ${reply.order.phone || ''} trùng đơn ${existingAny.source || 'ngoài'} ${existingAny.id || ''} (không thuộc hội thoại này). Bot hỏi "đặt thêm?" không nêu chi tiết đơn đó — nhân viên đối chiếu có phải cùng người không.`, `đơn ngoài ${existingAny.id || '?'}`);
      if (ask.templateId === 'ORDER_EXISTING_CONFIRM') {
        console.log(`Đơn mới khi đang có đơn ${existingAny.id}: hỏi khách xác nhận trước (${conversation.id})`);
        // addressAsks = tối đa: địa chỉ này đã được bộ soạn đơn chấp nhận (có khi sau 2 lần hỏi) —
        // lượt "đúng" không được hỏi lại phường/xã lần nữa. Đơn ngoài lưu kèm giỏ chờ để "không" kể lại được.
        reply = { ...ask, order: undefined, attention: outside, pendingOrder: { items: (reply.order.items || []).map(item => ({ product: item.product || item.name, code: item.code || item.sku || '', quantity: Number(item.quantity) || 1 })), key: reply.order.orderKey || '', at: Date.now(), phone: reply.order.phone || '', address: reply.order.rawAddress || reply.order.address || '', addressAsks: maxAddressAsks, awaitingConfirm: true, ...(outside ? { externalOrder: existingAny, staffCheck: [String(conversation.pendingOrder?.staffCheck || ''), `SĐT trùng đơn ${existingAny.source || 'ngoài'} ${existingAny.id || ''} không thuộc hội thoại, đối chiếu người nhận`].filter(Boolean).join('; ').slice(0, 300) } : {}) } };
      }
    }
    // Sắp tự lên đơn mới mà hội thoại đã có đơn POS trong giờ qua (khách đặt qua
    // Facebook Shop, hay nhân viên vừa lên): không tạo đơn trùng, báo đã nhận đơn.
    if (reply.order && !reply.order.updateOrderId && !reply.order.cancelOrderId && !reply.order.noteOrderId && !isComment && dependencies.findShopOrder && templates?.SHOP_ORDER_RECEIVED) {
      const lookedUp = await dependencies.findShopOrder(conversation, { since: Date.now() - 60 * 60 * 1000 }).then(found => ({ found }), error => ({ error }));
      // POS lỗi (429/5xx/hết giờ) ≠ không có đơn Shop: vẫn lên đơn nhưng gắn thẻ để nhân viên soát trùng.
      if (lookedUp.error) { console.warn(`Tra đơn Shop lỗi (${String(lookedUp.error?.message || lookedUp.error).slice(0, 80)}) — gắn thẻ soát trùng (${conversation.id})`); reply = { ...reply, attention: true }; }
      const existing = lookedUp.found || null;
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
    // autoOrder chỉ chặn TẠO đơn mới; hủy / sửa / ghi chú đơn đã có vẫn phải làm thật — bot đã nói
    // "em đã hủy đơn" với khách.
    // Ghi chú / hủy / sửa mà thiếu hàm tương ứng: không bao giờ rơi xuống TẠO đơn mới từ đối tượng ghi chú.
    const operationOnly = Boolean(reply.order?.noteOrderId || reply.order?.cancelOrderId || reply.order?.updateOrderId);
    // R13 (inbox3 F3): đơn soạn theo ngữ cảnh khách live (kể cả khách đi từ bình luận bài live sang hộp thư) mang cờ
    // livestream → normalizeChatbotOrder giữ quà live, địa chỉ "(Live) …". Chỉ thêm cờ khi đúng là khách live.
    if (reply.order && !operationOnly && replyContext.livestream && reply.order.livestream === undefined) reply = { ...reply, order: { ...reply.order, livestream: true } };
    else if (reply.order?.updateOrderId && replyContext.livestream && reply.order.livestream === undefined) reply = { ...reply, order: { ...reply.order, livestream: true } };
    const outcome = settings.responseMode === 'automatic' && reply.order && !isComment && (wantsNote || wantsCancel || wantsUpdate || (settings.autoOrder !== false && createOrder && !operationOnly))
      ? (wantsNote
        ? await dependencies.addOrderNote(conversation, reply.order.noteOrderId, reply.order.note)
        : wantsCancel
          ? await cancelOrder(conversation, reply.order.cancelOrderId)
          : wantsUpdate
            ? await updateOrder(conversation, reply.order.updateOrderId, reply.order)
            : await createOrder(conversation, reply.order, { sourceMessageId: String(change.message.mid || change.message.id || '') }))
      : null;
    // (R13: lựa chọn quà thay của giỏ chờ — pendingOrder.giftSwap — do bộ soạn đơn áp vào đơn: order.gift ghi "(đổi quà: thay …)",
    // order.giftSwap / giftSwapRemoved cho kho và POS; engine không ghi chú thêm.)
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
      const intro = renderChatbotReply({ template_id: 'COMMENT_PRIVATE_REPLY' }, templates, replyContext);
      const introMessages = intro.templateId === 'COMMENT_PRIVATE_REPLY' ? intro.messages : [];
      // R13 (bình luận F4): khách bình luận 3–4 lần liền nhau nhận 3–4 tin riêng cùng mở đầu "Dạ em thấy … để lại bình luận".
      // Hộp thư đã có tin của Page (bot / nhân viên, không tính dòng hệ thống) dưới 30 phút thì bỏ câu mở đầu, chỉ gửi nội dung.
      const inboxPageRecently = inboxMessages.some(item => item?.direction === 'outgoing' && !isPageSystemNotice(item) && Date.now() - (Number(item.createdAt) || 0) < 30 * 60 * 1000);
      const joinPrivate = parts => parts.join('\n\n')
        // Mẫu mở đầu kết bằng "Dạ," rồi mẫu sau lại "Dạ": chỉ giữ một.
        .replace(/Dạ,?\s*\n\n\s*Dạ,?/g, 'Dạ,');
      const privateWithIntro = joinPrivate([...introMessages, ...reply.messages]);
      const privateText = inboxPageRecently ? joinPrivate([...reply.messages]) : privateWithIntro;
      // Messenger can refuse the private reply — most often error #10, another
      // app holding the thread (Handover Protocol). Telling the customer to
      // check an inbox that stays empty loses the lead, so the public reply
      // then asks them to message the Page instead, and the error is kept
      // for the customer panel.
      // Khách bình luận nhiều lần dưới cùng bài ("cho coi combo", "combo đó mấy
      // gói"): cùng một tin riêng đã gửi trong 24 giờ thì không gửi lại — khách
      // nhận ba lần bảng giá y hệt là spam. Chỉ trả lời công khai ngắn.
      // Lời khen / tán gẫu dưới bài ("ngon", "tuyệt", "ăn ngon lắm", mô hình chọn THANK_YOU): chỉ cảm ơn
      // công khai, không nhắn riêng bảng giá cho người vừa khen.
      // Vòng 12 (B4 #2): THANK_YOU của mô hình chỉ là khen khi tin có từ khen thật (không chê — commentComplaint đã loại).
      const praiseWords = /\b(ngon|tuyet|tuyet voi|thich|thik|dinh|hop ly|ok lam|qua ngon|ung|dung y|cam on|thanks|dep|xinh)\b/.test(folded);
      const commentPraise = !commentComplaint && !liveInterest && !liveFeedback && !basket.length && !extractVietnamesePhone(message.text || '') && !reply.order && templates?.COMMENT_PUBLIC_THANKS
        && ((reply.templateId === 'THANK_YOU' && (praiseWords || emojiOnly)) || (praiseWords
          && !/\?|\b(nao|sao|khong|ko|k|gia|bn|bao nhieu|hon|the nao|ntn|khac|lay|dat|mua|cho|xin|ib|inbox|giam|ship|tui|goi|combo|bao)\b/.test(folded)));
      if (commentPraise || liveFeedback) privateSkipped = true;
      if (privateText && !privateSkipped && getConversation && listMessages) {
        const inbox = await getConversation(`${conversation.pageId}:${conversation.psid}`).catch(() => null);
        const sentBefore = inbox ? await listMessages(inbox.id).catch(() => []) : [];
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        // R13: so cả bản có và không có câu mở đầu (lần trước gửi kèm mở đầu, lần này bỏ — vẫn là cùng một tin).
        const sameAsSent = text => [privateText, privateWithIntro].some(candidate => normalize(text) === normalize(candidate));
        privateSkipped = sentBefore.some(item => item?.direction === 'outgoing' && (Number(item?.createdAt) || 0) > dayAgo && sameAsSent(item.text));
        // Khách bình luận ở nhiều bài trong vài phút: bảng giá khác nhau (bài Túi
        // Xanh, bài chung…) vẫn là bảng giá — hộp thư vừa nhận bảng giá dưới 30
        // phút thì không gửi thêm bảng thứ hai, thứ ba.
        const priceFamily = new Set(['PRICE_QUOTE', 'GENERAL_INFO', 'LIVESTREAM_COMMENT', 'PRICE_MIX_TUI_LON']);
        // R13 (bình luận F7): chặn này từng nuốt cả câu hỏi KHÁC ("túi vàng giá bao nhiêu" sau khi vừa nhận bảng giá chung) —
        // chỉ áp cho lượt hỏi giá cụt đi theo luật (".", "ib", "giá": luật DOTS / TERSE_PRICE hay bảng giá nhanh của bài).
        const terseTurn = terse || (ruleLive && /^(DOTS|TERSE_PRICE)$/.test(String(ruled?.rule || '')));
        if (!privateSkipped && inbox && !basket.length && terseTurn && priceFamily.has(reply.templateId) && priceFamily.has(inbox.botLastTemplateId)
          && Date.now() - (Number(inbox.botLastReplyAt) || 0) < 30 * 60 * 1000) privateSkipped = true;
      }
      // Tin riêng ghép (mở đầu + bảng giá + chính sách) quá 1.900 ký tự bị Messenger cắt cụt ("…+ miễn phí v"):
      // phần đầu (≤ 1.900) đi qua tin riêng của bình luận, phần còn lại gửi tiếp vào hộp thư của khách.
      const privateChunks = privateText ? splitMessageText(privateText, 1900) : [];
      if (privateText && !privateSkipped) {
        try {
          await sendMessage(conversation, { text: privateChunks[0], privateReply: true });
        } catch (error) {
          // Lỗi tạm (aborted, #0, #1, mạng): thử lại một lần sau 3 giây. Khách
          // chặn tin (#10903), đã trả lời (#10900), ngoài cửa sổ (#10/#551): không.
          const permanent = /#10903|#10900|#551|\(#10\)|chưa có mã Pancake/i.test(error.message || '');
          // Vòng 12 (F-SYNC): gửi hết giờ mà không biết tin đã tới chưa (PANCAKE_SEND_UNCERTAIN / unknownDelivery): coi như đã gửi —
          // không gửi lại, không đăng lời công khai dự phòng "mình ib cho Page" (mâu thuẫn với tin riêng có thể đã tới).
          if (error?.unknownDelivery || error?.code === 'PANCAKE_SEND_UNCERTAIN') console.warn(`Tin riêng bình luận không rõ đã tới (${conversation.id}): coi như đã gửi`);
          // #10900: bình luận ĐÃ được nhắn riêng (Pancake/nhân viên) — không phải
          // lỗi; không đăng "mình ib cho Page giúp em".
          else if (/#10900/.test(error.message || '')) privateSkipped = true;
          else if (permanent) privateError = error.message;
          else {
            await wait(3000);
            try {
              await sendMessage(conversation, { text: privateChunks[0], privateReply: true });
            } catch (again) {
              if (!again?.unknownDelivery && again?.code !== 'PANCAKE_SEND_UNCERTAIN') privateError = again.message;
            }
          }
        }
        // Phần còn lại: tin thường vào hộp thư (bị chặn khi khách chưa nhắn Page thì bỏ, không báo lỗi).
        if (!privateError && !privateSkipped && privateChunks.length > 1 && getConversation) {
          const inbox = await getConversation(`${conversation.pageId}:${conversation.psid}`).catch(() => null);
          for (const chunk of privateChunks.slice(1)) {
            if (!inbox) break;
            const ok = await sendMessage(inbox, { text: chunk }).then(() => true).catch(error => { console.warn(`Phần sau tin riêng không gửi được (${conversation.id}): ${error.message}`); return false; });
            if (!ok) break;
          }
        }
      }
      // Giỏ hàng khách nêu trong bình luận ("1 xanh 1 vàng", SĐT kèm theo) đi
      // theo khách sang hộp thư: khi khách nhắn địa chỉ vào Messenger, bot đã
      // có sẵn sản phẩm để chốt thay vì hỏi lại từ đầu.
      // R13 (inbox3 F3): bình luận dưới bài LIVE → hộp thư của khách mang cờ khách live (livestreamCustomer) + thẻ Livestream,
      // giỏ đi theo mang `livestream: true`. Hộp thư thường đã có bài/quảng cáo khác nên không kế thừa bài live: trước đây
      // khách chốt ở hộp thư bị mất quà live (Quạt + Bát gáo dừa) và giá live.
      const liveCarry = replyContext.livestream === true;
      const carried = reply.pendingOrder && (reply.pendingOrder.items?.length || reply.pendingOrder.phone || reply.pendingOrder.askedBagCount)
        ? { ...reply.pendingOrder, ...(liveCarry ? { livestream: true } : {}), fromComment: true } : null;
      // Giỏ khách vừa nêu trong hộp thư (dưới 30 phút) mới hơn bình luận: không ghi đè. Giỏ hộp thư do bình luận TRƯỚC mang
      // sang (fromComment) thì bình luận mới hơn được thay: ca thật 02/10 "1xanh la" rồi 70 giây sau "2xanh la" — bot báo
      // "đơn gồm 2 túi" nhưng giỏ hộp thư vẫn 1 túi nên khách gửi địa chỉ là chốt đơn 1 túi.
      const inboxBasketFresh = inboxThread?.pendingOrder?.items?.length && inboxThread.pendingOrder.fromComment !== true
        && Date.now() - (Number(inboxThread.pendingOrder.at) || 0) < 30 * 60 * 1000;
      const liveInboxState = liveCarry ? { livestreamCustomer: true, addLabelEvents: ['livestream'] } : {};
      if (!privateError && !privateSkipped && saveBotState) {
        // Hộp thư biết mẫu vừa gửi riêng: khách nhắn tiếp thì bot không gửi lại y nguyên.
        await saveBotState(`${conversation.pageId}:${conversation.psid}`, {
          botLastTemplateId: reply.templateId,
          botLastReplyAt: Date.now(),
          ...(carried && !inboxBasketFresh ? { pendingOrder: carried } : {}),
          ...(!inboxThread?.botGender && (lockedGender === 'male' || lockedGender === 'female') ? { botGender: lockedGender } : {}),
          ...liveInboxState
        }).catch(() => {});
      } else if (liveCarry && saveBotState && inboxThread && inboxThread.livestreamCustomer !== true) {
        // Lần này không nhắn riêng (đã gửi rồi / lỗi) nhưng hộp thư đã có: vẫn ghi cờ khách live.
        await saveBotState(`${conversation.pageId}:${conversation.psid}`, liveInboxState).catch(() => {});
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
      // Bất kể mẫu riêng là gì: khách chê là xin lỗi công khai + gắn thẻ.
      const complaintPublic = Boolean(templates?.COMMENT_PUBLIC_SORRY)
        && (commentComplaint || isComplaint({ text: message.text, templateId: reply.templateId, keywords: settings.complaintKeywords }));
      if (complaintPublic && !reply.attention) reply = { ...reply, attention: true };
      // Vòng 12 (B4 #8): khách đã có tin riêng tới được hộp thư trong 24 giờ (bot/nhân viên đã nhắn) mà lần này gửi riêng lỗi →
      // không đăng "mình ib cho Page giúp em" (mâu thuẫn với "em vừa ib" vài phút trước): nhắc đã gửi trong tin nhắn.
      const inboxReachable = inboxMessages.some(item => item?.direction === 'outgoing' && Date.now() - (Number(item.createdAt) || 0) < 24 * 60 * 60 * 1000);
      const fallbackPublic = privateError && !inboxReachable;
      const publicId = fallbackPublic ? 'COMMENT_PUBLIC_FALLBACK'
        : complaintPublic ? 'COMMENT_PUBLIC_SORRY'
          : liveFeedback && templates?.COMMENT_PUBLIC_FEEDBACK ? 'COMMENT_PUBLIC_FEEDBACK'
            : commentPraise ? 'COMMENT_PUBLIC_THANKS'
              : (privateSkipped || privateError) && templates?.COMMENT_PUBLIC_REPEAT ? 'COMMENT_PUBLIC_REPEAT' : 'COMMENT_PUBLIC_REPLY';
      if (privateError && !fallbackPublic && !reply.attention) reply = { ...reply, attention: true };
      // Luồng vừa có lời công khai trong 10 phút (khách bình luận liền 3–4 lần): không đăng thêm lời công khai nào nữa —
      // vòng 12: kể cả khi lần này gửi riêng lỗi (trước đây lỗi thì đăng thêm "mình ib cho Page" ngay sau "em vừa ib").
      const publicRecently = recent.some(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo);
      // Ẩn bình luận có SĐT trước khi đăng lời công khai: lời công khai có thể
      // chạm hết thời gian chờ, bình luận có SĐT không được nằm hiện trên bài.
      // Like the comment so the customer sees it was noticed; hide it when it
      // carries a phone number (or always, per settings) so competitors
      // cannot lift the lead from the post.
      await moderateBundledComments();
      const publicReply = publicRecently ? { messages: [] } : renderChatbotReply({ template_id: publicId }, templates, replyContext);
      // Vòng 12 (B4 #11): câu hỏi sức khỏe / dị ứng / ăn kiêng ("Sợ ỉa chảy") → lời công khai trung tính, không emoji.
      const neutralPublic = ['HEALTH_CONDITION', 'HEALTH_DIABETES', 'INGREDIENTS_ALLERGY', 'CALORIES_DIET', 'WEIGHT_GAIN', 'COMMENT_STAFF_FOLLOWUP'].includes(reply.templateId);
      const stripEmoji = text => String(text).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s{2,}/g, ' ').trim();
      for (const text of pickVariant(publicReply).map(text => (neutralPublic ? stripEmoji(text) : text))) {
        // Hết thời gian chờ khi đăng (Pancake vẫn đăng được): không coi là lỗi của cả lượt.
        // 02/10: Pancake hết giờ chờ giờ báo PANCAKE_SEND_UNCERTAIN ("không rõ đã nhận tin"), không còn chữ "abort" —
        // ném lỗi ra là bỏ qua lưu trạng thái/gắn thẻ và hiện "Bot chưa trả lời được" dù lời công khai đã lên bài.
        await sendMessage(conversation, { text }).catch(error => {
          if (!error?.unknownDelivery && error?.code !== 'PANCAKE_SEND_UNCERTAIN' && !/abort/i.test(error.message || '')) throw error;
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
      // Câu nhắc giỏ kèm câu trả lời (vòng 11) chỉ bỏ khi y hệt đã gửi trong 10 phút: khách hỏi tiếp sau đó vẫn được nhắc.
      const recentSentTexts = new Set(recent.filter(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo).map(item => String(item.text || '').replace(/\s+/g, ' ').trim()));
      parts = parts.filter((part, index) => index === 0 || part.type !== 'text' || !(part.remind ? recentSentTexts : sentTexts).has(String(part.text || '').replace(/\s+/g, ' ').trim()));
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
      // Vòng 12 (B1 #17, B2 #25): không gửi biên nhận thứ hai cùng lúc — đã có [order-receipt] trong 2 phút (lượt trùng /
      // nhân viên vừa xác nhận) hay đơn này đã có biên nhận (order.receiptSentAt) thì bỏ.
      const receiptRecently = (await listMessages(conversation.id).catch(() => recent)).some(item => item?.direction === 'outgoing' && item.type === 'order-receipt' && Date.now() - (Number(item.createdAt) || 0) < 2 * 60 * 1000);
      if (order && sendReceipt && !outcome?.updated && !order.receiptSentAt && !receiptRecently) await sendReceipt(conversation, order);
      else if (order && sendReceipt && !outcome?.updated) console.log(`Bỏ biên nhận trùng cho đơn ${order.id} (${conversation.id})`);
    }
    // Mô hình nhỏ so với câu trả lời thật (luật / LLM): đọc log để quyết định bật.
    // So với mẫu mô hình/luật CHỌN (chosenTemplateId, trước hậu xử lý ORDER_ADDRESS→REMIND, GENERAL_INFO→PRICE_QUOTE…).
    if (intent) console.log(`Mô hình nhỏ${intentUsable && reply === intentReply ? '' : ' (thử)'}: ${intent.templateId} (${intent.confidence.toFixed(2)}, biên ${intent.margin.toFixed(2)}) / thật ${chosenTemplateId}${reply.templateId !== chosenTemplateId ? ` → ${reply.templateId}` : ''} ${intentMatchMark(intent.templateId, chosenTemplateId)} (${conversation.id})`);
    // Mô hình tầng: "NHÓM p / MẪU p (biên) / thật Y ✓|✗|~|nhóm✓" — cùng quy ước, thêm "nhóm✓" khi chỉ đúng nhóm.
    if (cascade) console.log(`Mô hình tầng${cascadeUsable && reply === cascadeReply ? '' : ' (thử)'}: ${cascade.group} ${(Number(cascade.pGroup) || 0).toFixed(2)} / ${cascade.templateId} ${(Number(cascade.p) || 0).toFixed(2)} (biên ${(Number(cascade.margin) || 0).toFixed(2)}) / thật ${chosenTemplateId}${reply.templateId !== chosenTemplateId ? ` → ${reply.templateId}` : ''} ${cascadeMatchMark(cascade, chosenTemplateId, cascadeGroupOf)} (${conversation.id})`);
    const labelEvents = autoLabelEventsFor({
      order,
      // Ảnh khách gửi: thẻ "Cần người xử lý" để nhân viên xem, bot vẫn bật.
      handoff: reply.handoff || Boolean(reply.attention),
      text: message.text,
      templateId: reply.templateId,
      keywords: settings.complaintKeywords,
      // Khách đổi/hủy đơn, đến từ phiên live, số hay bom hàng: thẻ tương ứng.
      // Xin đổi đơn mà bot không tự sửa được (reply.orderChange): vẫn gắn thẻ Đổi sản phẩm cho nhân viên.
      updated: Boolean(outcome?.updated) || Boolean(reply.orderChange),
      cancelled: Boolean(outcome?.cancelled),
      livestream: isLivestreamPost(conversation),
      phoneWarningLevel: outcome?.order?.phoneWarning?.level || ''
    });
    // Ưu đãi dùng thử: lưu bước (đã chọn túi, đã mời, từ chối, chuyển đơn thường) và
    // đóng ưu đãi khi đơn dùng thử đã tạo (không dùng lại được).
    // Vòng 11 (P5): bot hỏi vị mà khách đã nêu số túi ("gửi mình 2 túi nhé, <địa chỉ>"): giữ số túi trong giỏ chờ để
    // lượt trả lời một màu lên đúng số túi.
    const askedBagsNow = reply.templateId === 'ASK_FLAVOR' && reply.pendingOrder && typeof reply.pendingOrder === 'object' ? bagCountInText(message.text) : 0;
    if (askedBagsNow > 0) reply = { ...reply, pendingOrder: { ...reply.pendingOrder, askedBagCount: askedBagsNow } };
    const trialOrdered = Boolean(order && (order.trialFreeShip || reply.order?.trial));
    const promoUpdate = conversation.promo && (trialPatch || trialOrdered)
      ? { ...conversation.promo, ...(trialPatch || {}), ...(trialOrdered ? { stage: 'ordered', orderId: String(order.id), endedAt: Date.now() } : {}) }
      : null;
    // R13: giỏ chờ sắp lưu giữ lại lựa chọn quà thay (giftSwap) và cờ khách live (livestream) của giỏ trước — bộ soạn đơn
    // dựng giỏ mới từ bản đã chuẩn hoá nên hai trường này rơi mất nếu không chép lại.
    if (reply.pendingOrder && typeof reply.pendingOrder === 'object' && !isComment) {
      const carriedFields = {
        ...(chosenGiftSwap && !reply.pendingOrder.giftSwap ? { giftSwap: chosenGiftSwap } : {}),
        ...((conversation.pendingOrder?.livestream === true || replyContext.livestream) && reply.pendingOrder.livestream === undefined ? { livestream: true } : {})
      };
      if (Object.keys(carriedFields).length) reply = { ...reply, pendingOrder: { ...reply.pendingOrder, ...carriedFields } };
      // R13: giỏ được lưu lại ở một lượt KHÔNG phải lượt hoãn (khách gửi SĐT/địa chỉ, đổi giỏ, chọn quà…) → khách đã quay
      // lại với đơn: bỏ cờ `postponed` để chốt và bám đuổi bình thường.
      if (reply.pendingOrder.postponed && !(ruled?.keepBasket && reply.templateId === 'ORDER_POSTPONED')) {
        const { postponed: _postponed, ...resumed } = reply.pendingOrder;
        reply = { ...reply, pendingOrder: resumed };
      }
    }
    // R14 (chủ shop 03/10): GIFT_SWAP không còn hỏi "lấy 2 gói vị nào" — không đặt mốc chờ khách chọn vị quà thay.
    const gaveGiftSwapAsk = false;
    await saveBotState(conversation.id, {
      ...(promoUpdate ? { promo: promoUpdate } : {}),
      // R13: bot vừa hỏi "lấy 2 gói vị nào" (GIFT_SWAP) → mốc để lượt sau đọc vị khách chọn; khách đã chọn → lưu lựa chọn
      // (24 giờ) và bỏ mốc hỏi. Đơn đã tạo thì lựa chọn đã vào đơn/ghi chú: xoá.
      ...(gaveGiftSwapAsk ? { giftSwapAskedAt: Date.now() } : {}),
      ...(reply.giftSwap ? { giftSwapChoice: { choices: reply.giftSwap, at: Date.now() }, giftSwapAskedAt: 0 } : {}),
      ...(order && chosenGiftSwap ? { giftSwapChoice: null, giftSwapAskedAt: 0 } : {}),
      // R13: đơn Shop (POS) vừa báo "đã nhận" — giỏ bấm sau đó không nhận lại đúng đơn này.
      ...(reply.shopOrderId ? { shopOrderAck: { id: String(reply.shopOrderId), at: Date.now() } } : {}),
      // R14: mốc "đã báo bạn phụ trách trả lời" — 2 giờ không báo lại.
      ...(reply.staffWait ? { staffWaitAt: Date.now() } : {}),
      botConversationId: reply.conversationId || conversation.botConversationId || '',
      botLastTemplateId: reply.templateId,
      botLastReplyAt: Date.now(),
      botDraft: settings.responseMode === 'draft' ? reply.messages.join('\n\n') : '',
      botLastError: privateError ? `Không nhắn riêng được: ${privateError}` : '',
      botLastErrorAt: privateError ? Date.now() : 0,
      // undefined leaves the stored basket alone; null clears it once ordered.
      // undefined để nguyên giỏ đang giữ; null xóa khi đã lên đơn. Tắt tự động
      // lên đơn thì giỏ khách vừa chốt được giữ lại thay vì xóa.
      // Đang chờ khách xác nhận đặt thêm mà khách nói chuyện khác (không yes/no, không giỏ mới):
      // bỏ cờ chờ — lượt sau mọi đơn mới đều được hỏi lại, không có "đồng ý ngầm".
      // Vừa hỏi "đặt thêm?" dưới 30 phút (awaitingRecent) thì giữ cờ chờ: khách hỏi chuyện khác xong vẫn có
      // thể "đúng rồi" để chốt, và bot không hỏi lại lần hai.
      ...(!isComment && !order && reply.order && !outcome && settings.autoOrder === false
        ? { pendingOrder: { ...(conversation.pendingOrder || {}), ...reply.order, at: Date.now(), awaitingConfirm: false } }
        : reply.pendingOrder !== undefined && !isComment ? { pendingOrder: reply.pendingOrder }
          : !isComment && conversation.pendingOrder?.awaitingConfirm && !awaitingYes && !awaitingNo && !awaitingRecent ? { pendingOrder: { ...conversation.pendingOrder, awaitingConfirm: false } } : {}),
      ...(reply.handoff ? { botEnabled: false } : {}),
      // Xưng hô khóa lại từ lần đầu biết giới tính; đã mời 2 túi thì ghi mốc để không mời lại trong hội thoại.
      ...(!isComment && !conversation.botGender && (lockedGender === 'male' || lockedGender === 'female') ? { botGender: lockedGender } : {}),
      ...(!isComment && reply.pendingOrder?.upsold && !conversation.pendingOrder?.upsold && !conversation.botUpsoldAt ? { botUpsoldAt: Date.now() } : {}),
      // Thẻ tự động: bot chỉ nói chuyện gì vừa xảy ra (chốt đơn / chuyển nhân
      // viên / khách khiếu nại); thẻ nào được gắn là do Cài đặt → Tin nhắn.
      // Thẻ được cộng thêm, không bao giờ xoá thẻ nhân viên đã gắn.
      ...(labelEvents.length ? { addLabelEvents: labelEvents } : {})
    });
    // Giỏ Shop chưa thấy đơn POS lúc trả lời: tra lại ở nền vài lần; thấy thì báo
    // khách đã nhận đơn (khỏi gửi lại SĐT/địa chỉ) và bỏ giỏ đang chờ.
    // So theo mẫu + mã giỏ, không so tham chiếu: khách giữ ưu đãi dùng thử nhận bản sao của cartReply (kèm thẻ).
    const cartReplySent = Boolean(cartReply) && reply.templateId === cartReply.templateId && (reply.pendingOrder?.key || '') === (cartReply.pendingOrder?.key || '');
    if (canFindShopOrder && !shopOrder && cartReplySent && settings.responseMode === 'automatic') {
      followUpShopOrder({ conversation, since: cartSince, settings, dependencies, cartKey: cartReply.pendingOrder?.key || '', shopOrderReply });
    }
    trace.final = reply.templateId;
    trace.also = reply.alsoTemplateId || null;
    trace.attention = Boolean(reply.attention);
    trace.handoff = Boolean(reply.handoff);
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
    if (error instanceof NewerMessageSkip) {
      results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
      return;
    }
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
  } finally {
    // Nhật ký quyết định: một dòng cho lượt này (kể cả bỏ qua / lỗi). Kết quả của lượt là mục
    // results vừa đẩy trong lượt (skipped / templateId / error). Gác trước ở chế độ thử: so với mẫu gửi thật.
    const mine = results.length > resultsBefore ? results[results.length - 1] : null;
    const final = trace.final ?? (mine?.templateId || null);
    // R13 (bình luận F1): lượt bot bỏ qua CÓ CHỦ Ý (bình luận chỉ tag bạn bè, lặp tin vừa gửi, nhân viên đang xử lý, sticker…)
    // ghi dấu bền `botHandledMessageId` để backlog sau khởi động / đồng bộ muộn không đưa lại đúng tin đó (pancake.mjs
    // botAlreadyHandled). Không ghi khi tin nhường cho tin sau hay đang được xử lý ở lượt khác.
    // Chỉ luồng BÌNH LUẬN ghi ở đây (câu trả lời của bình luận không nằm trong luồng nên backlog không tự biết); hộp thư ghi
    // dấu ngay trong lần lưu của nhánh "lặp tin vừa gửi" (các lượt bỏ qua khác của hộp thư đã có tin Page / nhân viên chặn).
    const handledId = String(change?.message?.id || change?.message?.mid || '');
    if (conversation.source === 'comment' && mine?.skipped && handledId && !unmarkedSkips.has(String(mine.skipped)) && typeof saveBotState === 'function' && String(conversation.botHandledMessageId || '') !== handledId) {
      await Promise.resolve(saveBotState(conversation.id, { botHandledMessageId: handledId })).catch(() => {});
    }
    if (trace.preGuard) {
      trace.preGuard.matched = final === trace.preGuard.decision;
      console.log(`Gác trước${trace.preGuard.mode === 'on' ? '' : ' (thử)'}: ${trace.preGuard.decision} / thật ${final || (mine?.skipped ? `bỏ qua (${mine.skipped})` : 'lỗi')}${trace.preGuard.matched ? ' ✓' : ' ✗'} (${conversation.id})`);
    }
    // Trong tiến trình test (node --test) chỉ ghi khi test đưa writer riêng — không đụng thư mục dữ liệu thật.
    const writer = typeof dependencies.appendDecisionLog === 'function' ? dependencies.appendDecisionLog : process.env.NODE_TEST_CONTEXT ? null : appendDecisionLog;
    if (settings.decisionLog !== 'off' && writer) {
      const record = buildDecisionRecord({ conversation, change, trace, result: mine, final, startedAt });
      Promise.resolve().then(() => writer(record)).catch(error => console.warn(`Nhật ký quyết định: ${String(error?.message || error).slice(0, 120)}`));
    }
  }
}

// ===== Nhật ký quyết định =====
// Mẫu bot vừa gửi thuộc nhóm bảng giá: khách giục sau đó thì nhắc "đã gửi ở trên" (chưa có đơn) thay vì _INFO.
const priceFamilyTemplates = new Set(['PRICE_QUOTE', 'GENERAL_INFO', 'PRICE_MIX_TUI_LON', 'DISCOUNT_POLICY', 'LIVESTREAM_COMMENT', 'PRICE_QUOTE_COMBO']);
// Mẫu bot vừa gửi mà gác trước KHÔNG được nhắc "đã gửi ở trên": bot đang hỏi/chờ/đã nhắc/đã chuyển người.
const preGuardExcludedLast = new Set(['ASK_FLAVOR', 'ASK_PRODUCT', 'ORDER_INFO_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN', 'THANK_YOU', 'WELCOME', 'CSKH_HANDOFF', 'WAITING_STAFF', 'IMAGE_RECEIVED', 'REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO', 'BANK_TRANSFER', 'PAYMENT_RECEIVED_CHECK', 'SHOP_ORDER_RECEIVED', 'LIVE_DEAL_CLAIMED', 'CALLBACK_REQUEST', 'WHOLESALE_CTV_CONTACT', 'WHOLESALE_RECEIVED', 'DELIVERY_DELAY', 'OIL_SMELL_WARRANTY', 'REFUSED_DELIVERY', 'QR_OFFER']);

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;
const minutesSince = at => (Number(at) ? Math.round(((Date.now() - Number(at)) / 60000) * 10) / 10 : null);

/** Top-K của mô hình nhỏ: dùng `topK` khi intent-model trả, còn lại [best, second] (p của second = p1 − biên). */
export function intentTopK(intent) {
  if (!intent) return [];
  if (Array.isArray(intent.topK) && intent.topK.length) return intent.topK.map(item => ({ templateId: String(item.templateId || item), p: round2(item.p ?? item.confidence) }));
  const best = { templateId: intent.templateId, p: round2(intent.confidence) };
  return intent.second ? [best, { templateId: intent.second, p: round2(intent.confidence - intent.margin) }] : [best];
}

// Đã nhắc "thiếu pWithin/marginWithin" chưa (một lần mỗi tiến trình).
let cascadeWithinWarned = false;

/**
 * Phần `cascade` của nhật ký từ kết quả predictCascade: { group, subGroup, pGroup, templateId, p, margin,
 * pWithin, marginWithin, topK, path } — subGroup (PRICE/INFO/SOCIAL dưới ANSWER) và pWithin/marginWithin null khi mô-đun không trả.
 */
export function cascadeTrace(cascade) {
  if (!cascade || typeof cascade !== 'object') return null;
  const topK = (Array.isArray(cascade.topK) ? cascade.topK : []).map(item => ({ templateId: typeof item === 'string' ? item : String(item?.templateId || ''), p: round2(item?.p) })).filter(item => item.templateId);
  const optional = value => (value === undefined || value === null ? null : round2(value));
  return {
    group: String(cascade.group || ''), subGroup: cascade.subGroup ? String(cascade.subGroup) : null, pGroup: round2(cascade.pGroup),
    templateId: String(cascade.templateId || ''), p: round2(cascade.p), margin: round2(cascade.margin),
    pWithin: optional(cascade.pWithin), marginWithin: optional(cascade.marginWithin), topK, path: cascade.path ?? null
  };
}

/** Bot vừa hỏi gì (suy từ mẫu bot trước + giỏ đang giữ còn thiếu gì). */
export function prevBotAsks(templateId, pending = null) {
  const id = String(templateId || '');
  if (['ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(id)) {
    const hasPhone = Boolean(pending?.phone);
    const hasAddress = Boolean(pending?.address);
    return !hasPhone && !hasAddress ? 'phone_address' : !hasPhone ? 'phone' : 'address';
  }
  if (['ORDER_PHONE', 'ORDER_ADDRESS_OLD_ASK_PHONE'].includes(id)) return 'phone';
  if (['ASK_FLAVOR', 'ASK_PRODUCT', 'ORDER_INFO_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN', 'COMBO3_FLAVOR'].includes(id)) return 'flavor';
  if (id === 'ORDER_EXISTING_CONFIRM') return 'confirm';
  if (id === 'ASK_QUANTITY') return 'quantity';
  return '';
}

/** Số túi khách nêu trong tin ("2 túi xanh", "combo 3", "hai bịch"); không rõ thì 0. */
export function bagCountInText(text) {
  const folded = foldVietnamese(String(text || '')).replace(/\s+/g, ' ');
  const words = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5 };
  let total = 0;
  for (const match of folded.matchAll(/\b(\d{1,2}|mot|hai|ba|bon|nam)\s*(?:tui|goi|bich|hop)\b/g)) total += Number(match[1]) || words[match[1]] || 0;
  for (const match of folded.matchAll(/\b(?:tui|goi|bich|hop)\s*(?:xanh|vang|nau|cacao)?\s*x?\s*(\d{1,2})\b/g)) total += Number(match[1]) || 0;
  if (!total) for (const match of folded.matchAll(/\bcombo\s*(\d)\b/g)) total += Number(match[1]) || 0;
  return total;
}

/**
 * Tin chữ của khách có vẻ mang địa chỉ (từ cấp hành chính/đường/số nhà + một chữ số ngoài SĐT) — đặc trưng `addressInText`
 * của nhật ký, cũng là điều kiện của gác trước và "tin có thông tin mới".
 * R13 (models 3.E-6): so trên chữ bỏ dấu nên "Hạt Dinh Dưỡng" (dưỡng → duong) trong tin giỏ Facebook Shop bị đọc là
 * "đường" → 59 tin giỏ Shop ghi nhầm có địa chỉ. Nay: tin giỏ Shop (có `cart` / chữ tự sinh "Khách chọn mua từ Facebook
 * Shop") không bao giờ là địa chỉ; "dưỡng", "quan tâm/quan trọng/liên quan", "đường" nghĩa là đường ăn ("không đường",
 * "ít đường", "tiểu đường", "đường huyết"…) bị che trước khi dò.
 */
export function addressWordsInText(message) {
  if (!message || message.type !== 'text' || (Array.isArray(message.cart) && message.cart.length)) return false;
  const raw = String(message.text || '');
  if (!raw.trim() || /^\s*Khách chọn mua từ Facebook Shop/u.test(raw)) return false;
  const masked = raw.normalize('NFC')
    .replace(/dưỡng/giu, ' ')
    .replace(/(?:quan\s+(?:tâm|trọng|ngại)|liên\s+quan|quan\s+tam|lien\s+quan)/giu, ' ')
    .replace(/(?:không|ko|k|ít|it|có|co|tiểu|tieu|thêm|them|nhiều|nhieu|bỏ|bo|lượng|luong|chất|chat)\s+(?:đường|duong)(?![\p{L}\p{N}])|(?:đường|duong)\s+(?:huyết|huyet|phèn|kính|cát|mía|thốt|ăn kiêng|tự nhiên|tu nhien)/giu, ' ');
  const folded = foldVietnamese(masked);
  return /\b(xa|huyen|quan|phuong|thi tran|thi xa|thanh pho|duong|thon|ap|kp|khu pho|so nha|ngo|hem|to \d)\b/.test(folded) && /\d/.test(folded.replace(/\+?\d[\d .-]{8,13}/g, ' '));
}

/** Ngữ cảnh của lượt (phần `ctx` trong nhật ký). */
export function decisionContext({ conversation, message, recentOrder = null, staffRepliedAfterBot = false, labels = [], gender = '', livestream = undefined }) {
  const pending = conversation.pendingOrder || null;
  const last = String(conversation.botLastTemplateId || '');
  const text = message?.type === 'text' ? String(message.text || '') : '';
  const folded = foldVietnamese(text);
  return {
    hasBasket: Boolean(usablePendingOrder(pending, { templateId: 'ORDER_ADDRESS' })?.items?.length),
    basketAgeMin: pending?.items?.length ? minutesSince(pending.at) : null,
    basketItems: (Array.isArray(pending?.items) ? pending.items : []).reduce((sum, item) => sum + (Number(item?.quantity) || 0), 0),
    // Giỏ đang giữ (còn hạn) để công cụ dựng dataset dựng lại được giỏ: [{ sku, quantity }], không giữ thì [].
    basket: (usablePendingOrder(pending, { templateId: 'ORDER_ADDRESS' })?.items || []).map(item => ({ sku: String(item.code || ''), quantity: Number(item.quantity) || 1 })),
    hasRecentOrder: Boolean(recentOrder?.id),
    orderAgeMin: recentOrder?.id ? minutesSince(recentOrder.createdAt) : null,
    staffRepliedAfterBot: Boolean(staffRepliedAfterBot),
    lastWasOrderStep: isBasketStep(last) || last === 'PRICE_ONE_BAG',
    // R13 (models 3.E-3): khách live = bài live HOẶC thẻ Livestream / cờ khách live — engine đưa vào (cùng giá trị với đặc
    // trưng của mô hình và luật); gọi thuần (test) thì tự suy từ hội thoại + thẻ.
    livestream: livestream !== undefined ? Boolean(livestream) : isLivestreamCustomer(conversation) || (Array.isArray(labels) ? labels : []).map(String).includes('livestream'),
    phoneInText: Boolean(text && extractVietnamesePhone(text)),
    addressInText: addressWordsInText(message),
    bagCount: bagCountInText(text),
    attentionOpen: (Array.isArray(labels) ? labels : []).some(label => /^(handoff|complaint|warranty)$/.test(String(label))),
    gender: String(gender || '')
  };
}

/**
 * Bản ghi nhật ký quyết định (schema v1) — xem docs trong báo cáo vòng 9:
 * { v, at, conversationId, source, mid, text, type, prevBot, prevBotAgeMin, prevBotAsks, ctx, rule, shadow,
 *   intent, cascade, llm, fewShot, chosen, final, also, skipped, guards: { preGuard, gate }, attention, handoff, ms }.
 * `cascade` (mô hình tầng, null khi không gọi / thiếu mô-đun): { group, subGroup, pGroup, templateId, p, margin,
 *   pWithin, marginWithin, topK, path, canary } — canary true/false khi intentCascade 'on' (ngoài canary chạy như shadow), null khi shadow.
 */
export function buildDecisionRecord({ conversation, change, trace, result = null, final = null, startedAt = Date.now() }) {
  const source = conversation.source === 'comment' ? 'comment' : 'inbox';
  // Vòng 12: trạng thái trước lượt (trace.prev, chụp lúc bắt đầu). Thiếu (gọi thuần trong test) → đọc conversation.
  const prev = trace.prev || { templateId: String(conversation.botLastTemplateId || ''), replyAt: Number(conversation.botLastReplyAt) || 0, asks: prevBotAsks(conversation.botLastTemplateId, conversation.pendingOrder) };
  const receivedAt = Number(change?.message?.createdAt) || 0;
  return {
    // v2 (vòng 12): prevBot/lastTemplate/prevBotAgeMin/prevBotAsks là trạng thái TRƯỚC lượt; v1 ghi sau khi trả lời
    // (build-dataset bỏ các trường đó ở bản ghi v1). receivedAt: lúc khách gửi tin (`at` là lúc kết thúc lượt).
    v: 2,
    at: new Date().toISOString(),
    receivedAt: receivedAt ? new Date(receivedAt).toISOString() : null,
    conversationId: String(conversation.id || ''),
    source,
    mid: String(change?.message?.mid || change?.message?.id || ''),
    text: String(trace.text || ''),
    type: String(trace.type || 'text'),
    prevBot: prev.templateId,
    lastTemplate: prev.templateId, // trùng prevBot (mã mẫu), để công cụ dựng dataset đọc thẳng
    // Chữ tin bot gần nhất (≤ 300 ký tự; decision-log che SĐT như chuỗi tự do). prevBot/lastTemplate chỉ là mã mẫu.
    prevBotText: String(trace.prevBotText || '').slice(0, 300),
    prevBotAgeMin: minutesSince(prev.replyAt),
    prevBotAsks: prev.asks,
    ctx: trace.ctx || decisionContext({ conversation, message: change?.message }),
    rule: trace.rule || null,
    shadow: Array.isArray(trace.shadow) ? trace.shadow : [],
    intent: trace.intent || null,
    cascade: trace.cascade || null,
    llm: trace.llm ? { templateId: trace.llm.templateId, retried: trace.llm.retried, hint: trace.llm.hint, usage: trace.llm.usage, model: trace.llm.model, calls: trace.llm.calls } : null,
    fewShot: Array.isArray(trace.fewShot) ? trace.fewShot : [],
    chosen: trace.chosen || null,
    final: final || null,
    also: trace.also || null,
    skipped: result?.skipped ? String(result.skipped) : result?.error ? `lỗi: ${String(result.error).slice(0, 160)}` : null,
    guards: {
      preGuard: trace.preGuard ? { decision: trace.preGuard.decision, reason: trace.preGuard.reason, mode: trace.preGuard.mode, matched: trace.preGuard.matched } : null,
      gate: trace.gate || null
    },
    attention: Boolean(trace.attention),
    handoff: Boolean(trace.handoff),
    // Vòng 12: tin là sticker ({ id, like }) — chỉ ghi khi có, giữ nguyên schema các lượt thường.
    ...(trace.sticker ? { sticker: trace.sticker } : {}),
    // R13: luật ứng viên đã khớp ở lượt này ({ name, templateId, mode: 'shadow' | 'on', setQuantity? }) — chỉ ghi khi có.
    ...(trace.candidateRule ? { candidateRule: trace.candidateRule } : {}),
    ms: Date.now() - startedAt
  };
}
