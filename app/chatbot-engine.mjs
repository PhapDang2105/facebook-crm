import { asksToAdd, buildTemplatePrompt, isProductQuoteId, isShopCartText, maxAddressAsks, pickVariant, publicImageUrl, phoneLooksShort, renderChatbotReply, renderOrderGiftReply, sanitizeModelAnswer, withoutInviteTail } from './chatbot-templates.mjs';
import { addressHint, chatTimeoutMs, inferAddress } from './processing/address-ai.mjs';
import { describeDeliveryAddress, houseNumbersOf, isUsableStreet, loadLocationIndex, lostHouseNumbers, mergeAddressFragment, resolveAddress } from './processing/locations.mjs';
import { extractVietnamesePhone } from './processing/customer-info.mjs';
import { AD_MISMATCH_COMPLAINT, autoLabelEventsFor, foldVietnamese, isComplaint, mentionsOtherSeller, shortBadTaste } from './processing/auto-label.mjs';
import { productHint, resolveConversationProduct } from './processing/product-detect.mjs';
import { buildCatalogPrompt } from './processing/pricing.mjs';
import { isBasketStep, isOrderStep, usablePendingOrder } from './processing/pending-order.mjs';
import { findProductBySku, getCatalogProducts, getGifts, isFreeShippingGift, isSwappableGift, matchProduct, parseGiftSwapChoice, parseShopCart } from './processing/catalog.mjs';
import { isLivestreamConversation, isLivestreamCustomer, isPageSystemNotice, lateInfoNeedsBot } from './conversation-orders.mjs';
// R13: LIVE_ONLY (danh sách hàng chỉ bán trên live) và FLAVOR_LIST (câu hỏi danh sách vị) dùng chung một bản của rule-intent.
import { CANCEL_ORDER, COMMENT_DISLIKE, core as ruleCore, DELIVERY_NOTE, FLAVOR_LIST, HOLD_DELIVERY, LIVE_FEEDBACK, LIVE_ONLY, ruleIntent, TROPICAL_MENTION } from './processing/rule-intent.mjs';
import { cleanAddressText, collectAddressBurst, isPaymentMessage, lookupPreviousAddress, maskMarketWord, maskPlaceGia, stripPhone } from './processing/order-flow.mjs';
import { priceBasket } from './processing/pricing.mjs';
import { stickerInfo } from './stickers.mjs';
import { activeTrial, filterTrialReply, promoBowlActive, trialBagOptions, trialModelHint, trialStep } from './processing/trial-flow.mjs';
import { intentSafeTemplates, loadIntentModel, predictIntent } from './processing/intent-model.mjs';
import { decisionLabelOf, intentRowOf } from './processing/intent-features.mjs';
import { formatExamples, loadExampleBank, nearestExamples } from './processing/example-bank.mjs';
import { appendDecisionLog } from './processing/decision-log.mjs';
import { gateCheck } from './processing/llm-router.mjs';
import { isOrderishText, scheduleStaffIdleRecheck, staffIdleDelayMs, staffIdleReason } from './processing/staff-idle.mjs';
import { messengerWindowOpen } from './messenger-window.mjs';

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
  // Chỉ mục địa giới (~1,5 s đọc CSV đồng bộ), danh mục sản phẩm và quà: nạp sẵn thay vì chặn tin địa chỉ đầu tiên.
  try { loadLocationIndex(); getCatalogProducts(); getGifts(); } catch (error) { console.warn(`Không nạp sẵn được địa giới/danh mục: ${error.message}`); }
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
  STAFF_WAIT_CLOSED: 'Dạ em đã ghi nhận câu hỏi của {title} rồi ạ 💛 Bạn phụ trách làm việc giờ hành chính từ 8h đến 17h, sẽ trả lời {title} từ 8h {when} nha ạ.',
  // R14 (chủ shop 03/10, quyết định 11): câu hỏi bệnh lý (cao huyết áp, tim mạch…) — câu thận trọng ngắn + thẻ; agent luật
  // chọn mã này, agent seed thêm cùng chữ vào seed.
  HEALTH_CAUTION: 'Dạ granola bên em là thực phẩm thông thường, không thêm đường, không phải thuốc hay thực phẩm chức năng ạ. Người đang điều trị bệnh (huyết áp, tim mạch…) {title} nên hỏi bác sĩ về khẩu phần phù hợp; nếu dùng thì ăn lượng vừa phải (2–3 muỗng), kèm sữa chua không đường nha ạ.',
  // R14 (inbox3 H4): tin hộp thư rất ngắn chê sản phẩm ("Dỡ") mà mô hình định chuyển CSKH (tắt bot) → xin lỗi, hỏi chưa ưng
  // điểm nào, bot vẫn bật + thẻ Khiếu nại.
  COMPLAINT_SORRY: 'Dạ em xin lỗi vì sản phẩm chưa làm {title} hài lòng ạ 💛 {Title} cho em biết mình chưa ưng ở điểm nào (vị, độ ngọt hay độ giòn) để em báo bạn phụ trách kiểm tra và hỗ trợ {title} ngay nha ạ.'
});

// R14: giờ hành chính của bạn phụ trách (giờ Việt Nam): 8h–17h. Ngoài giờ: trước 8h → "sáng nay", sau 17h → "sáng mai".
export const STAFF_HOURS = Object.freeze({ open: 8, close: 17 });
export const STAFF_WAIT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
// R14 (quyết định 8): giỏ Facebook Shop chờ đơn POS 20 giây trước khi xin SĐT/địa chỉ (settings.shopOrderWaitMs ghi đè).
export const SHOP_ORDER_WAIT_MS = 20000;
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
 * R14 (inbox1 N3): các lần bấm giỏ Facebook Shop trong một cụm tin (tin giỏ liền nhau chưa được trả lời, hay một tin mang
 * nhiều dòng giỏ ghép từ nhiều lần bấm — chữ có ≥ 2 dòng "Khách chọn mua từ Facebook Shop") → mỗi lần bấm một giỏ; trả giỏ
 * của lần bấm CUỐI (`lines`) và `differs` khi các lần bấm không cùng giỏ. Một tin giỏ nhiều món thật (một dòng chữ, các món
 * nối bằng "; ") vẫn là MỘT giỏ. Trước đây (r13) các dòng giỏ bị cộng: 4 lần bấm → 4 Xanh + 3 Vàng + 1 Nâu.
 */
export function shopCartOfBundle(bundle, current) {
  const linesOf = item => (Array.isArray(item?.cart) ? item.cart : []).map(line => (typeof line === 'string' ? { sku: line, quantity: 1 } : line)).filter(line => line && (line.sku || line.name));
  const clicks = [];
  const items = (Array.isArray(bundle) && bundle.length ? bundle : [current]).filter(Boolean);
  if (current && !items.some(item => item === current || (item?.id && item.id === current.id))) items.push(current);
  for (const item of items) {
    const isCurrent = item === current || Boolean(item?.id && current?.id && item.id === current.id);
    const lines = linesOf(isCurrent ? current : item);
    if (!lines.length) continue;
    const cartTexts = String((isCurrent ? current : item)?.text || '').split(/\n+/).filter(text => isShopCartText(text));
    if (cartTexts.length >= 2 && cartTexts.length === lines.length) lines.forEach(line => clicks.push([line]));
    else clicks.push(lines);
  }
  if (!clicks.length) return null;
  const keyOf = lines => lines.map(line => `${String(line.sku || line.name).trim().toUpperCase()}=${Math.max(1, Number(line.quantity) || 1)}`).sort().join('|');
  return { lines: clicks.at(-1), differs: new Set(clicks.map(keyOf)).size > 1, clicks: clicks.length };
}

/**
 * Giỏ khách ghi thẳng trong bình luận: "C 2 túi vàng", "túi vàng với túi xanh lá
 * cây", "2 xanh 1 nâu". Chỉ ba túi lớn (Xanh/Vàng/Nâu; "xanh dương" là hàng
 * live khác); cần ý mua (lấy/mua/chốt/cho em…, có số lượng, hay từ hai màu).
 */
export function commentBasket(text, detail = null) {
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
    .replace(/\b(hai|ba|bon|nam) (?=(?:tui|goi|bich|bit|bi|hop|xanh|vang|nau|cacao|mint)\b)/g, (_match, word) => `${numberWords[word]} `)
    // R15 (bình luận A5, ca …020466 "Một bị màu vàng"): "một" ĐẦU câu (± lấy/cho/mua … em/chị) ngay trước đơn vị là 1.
    .replace(/^((?:(?:cho|lay|mua|chot|dat|gui)\s+)?(?:(?:em|e|minh|chi|c|a|anh|toi|tui)\s+)?)mot (?=(?:tui|goi|bich|bit|bi)\b)/, '$11 ')
    // R15: "bị / bịt / bì" (bịch) là đơn vị túi: "1bi màu vàng" → "1 tui mau vang".
    // Chỉ khi ngay sau chữ số ("1bi", "2 bit") hay đứng trước màu ("bịt màu xanh"); "hạt bí", "bị hư" không đổi.
    .replace(/(?<=\d ?)(?:bit|bi)\b/g, ' tui').replace(/(?<!hat )\b(?:bit|bi)(?= (?:mau |loai |vi )?(?:xanh|vang|nau|cacao|mint)\b)/g, 'tui').replace(/\s+/g, ' ');
  if (/\bxanh nhat\b/.test(folded) || (/\bdâu\b/iu.test(String(text || '')) && !/\bmint\b/.test(folded))) return [];
  // R16 (inbox4 H2 ca …479835 "Tui vang khac tui xanh sao vay sop", inbox1 A5 ca …0716122894 "sao co 2loai tui xanh va tui vang"):
  // câu HỎI / so sánh (mở đầu sao/tại sao/vì sao, "khác … sao/gì/nhau", "so với") không phải đặt hàng — trừ khi có động từ mua.
  const buyVerb = /\b(?:lay|mua|chot|dat|ship)\b/.test(folded);
  if (!buyVerb && (/^(?:sao|tai sao|vi sao|the sao|khac)\b/.test(folded.trim()) || /\bkhac (?:gi|nhau|sao|cho nao|the nao|nhu the nao|(?:tui|loai|vi|mau|voi)\b)|\bso voi\b|\bso sanh\b/.test(folded))) return [];
  // "2 hộp xanh", "hộp 10 gói nâu", "1 hộp": Combo 10 gói (màu ghi kèm; không ghi thì Mix).
  // R14: "combo 10 gói xanh" / "10 gói nhỏ" là hộp 10 gói (trước đây đọc thành 10 Túi Xanh 450g).
  const boxFolded = folded.replace(/\b(?:combo|hop|set) (?:10|muoi) goi(?: nho)?\b|\b(?:10|muoi) goi(?: nho)?\b/g, 'hop');
  // R14: hộp 10 gói đi KÈM túi lớn ("Hộp 10 gói và 1 túi xanh") — không tự dựng giỏ (trước đây hộp bị bỏ, còn 1 Túi Xanh);
  // engine ghi nhận nguyên văn (commentBasketUnknown → ORDER_CUSTOM_BASKET) / để luật hộp thư xử lý.
  if (/\bhop\b/.test(boxFolded) && /\b(tui|bich)\b/.test(boxFolded)) return [];
  const boxed = /\bhop\b/.test(boxFolded) && !/\b(tui|bich)\b/.test(boxFolded);
  // R16: "N loại / N vị / N màu" (không kèm màu ngay sau) là số LOẠI, không phải số túi ("2loai tui xanh va tui vang").
  const cleaned = boxFolded.replace(/\bdau xanh\b/g, ' ').replace(/\bhop (?:10|muoi) goi(?: nho)?\b/g, 'hop')
    .replace(/(?<!\d)\d{1,2}\s*(?:loai|vi|mau)\b(?!\s*(?:xanh|vang|nau|cacao|mint)\b)/g, ' ');
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
  // R14 (bình luận N1, ca …967034): "3 túi vàng, xanh, nâu" = 3 túi, mỗi vị 1 — trước đây số 3 gán cho màu đứng ngay sau
  // (3 Vàng + 1 Xanh + 1 Nâu = 5 túi 740k). Một con số DUY NHẤT "N túi/gói/bịch" đứng trước danh sách ≥ 2 màu không kèm số
  // riêng: N = số màu → mỗi màu 1; N khác số màu → không tự dựng giỏ (engine hỏi vị, giữ N túi: `detail.askCount`).
  const numbers = [...cleaned.matchAll(/(?<!\d)\d{1,2}(?!\d)/g)];
  // Phần sau "N túi" chỉ là danh sách màu (không "một túi …", "mỗi …" — "Lấy 2 túi loại xanh với một túi vị nâu" là 2 + 1).
  const afterShared = cleaned.slice(firstNumber).replace(/^\d{1,2}\s*(?:tui|goi|bich)\b/, '');
  if (numberFirst && numbers.length === 1 && counts.size >= 2 && /^\d{1,2}\s*(?:tui|goi|bich)\b/.test(cleaned.slice(firstNumber)) && !/\b(?:tui|goi|bich|mot|moi|nua)\b/.test(afterShared)) {
    const shared = Number(numbers[0][0]);
    if (shared === counts.size) for (const colour of counts.keys()) counts.set(colour, 1);
    else {
      if (detail && typeof detail === 'object' && shared > 0) detail.askCount = shared;
      return [];
    }
  }
  // R15 (bình luận A5, ca …990595 "1xanh la"): số dính màu ("1xanh", "1 vàng") cũng là đặt — như "2xanh la" vốn đã nhận.
  const wantsIt = counts.size >= 2 || [...counts.values()].some(quantity => quantity > 1) || /\b(lay|mua|chot|dat|gui|ship|combo|cho (em|minh|chi|c|e|toi|tui|anh|a)|\d{1,2} ?(tui|goi|bich))\b/.test(folded)
    || (/(?<![\d.,])\d{1,2} ?(?:tui |goi |bich )?(?:mau |loai |vi )?(?:xanh|vang|nau|cacao|mint)\b/.test(folded)
      // Kèm món bộ đọc giỏ không biết ("1 xanh, 1 cam") → không tự dựng giỏ thiếu món (engine ghi nhận nguyên văn).
      && !/\b(?:cam|yen mach|nghe|bot ngu coc|sieu hat|hat)\b/.test(folded));
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
  'bn', 'bao', 'nhiêu', 'nhieu', 'đi', 'ạ', 'combo', 'live', 'sao', 'nào', 'gì', 'vậy',
  // R13 sửa (phản biện L3): "Còn Hàng", "Hết Hàng", "Đặt Hàng", "Tư Vấn", "Về Chưa" viết hoa đầu chữ là câu nói, không phải tên ("ship" đã có).
  'còn', 'hết', 'hàng', 'đặt', 'tư', 'vấn', 'về', 'chưa'
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
    // Bỏ tin quảng cáo / biên nhận đơn / tệp đính kèm / tin hệ thống (memoryNoise) như bản gọn — chỉ là nhiễu cho mô hình.
    return recentMessages
      .filter(item => item && item.id !== message?.id && String(item.text || '').trim()
        && !['ad', 'order-receipt', 'attachment'].includes(item.type) && !memoryNoise.test(String(item.text).replace(/\s+/g, ' ').trim()))
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

// Lượt tạo cache đang chạy theo khóa (R1-05): lô bot chạy song song 3 lượt cùng lúc sau khởi động / lúc
// cache hết hạn không tạo 3 cachedContents trùng (2 cái mồ côi tính tiền 1 giờ). Hỏng thì bỏ, lượt sau tạo lại.
const promptCacheInFlight = new Map();

export function clearPromptCaches() {
  promptCaches.clear();
  promptCacheInFlight.clear();
}

async function promptCacheFor(options) {
  const key = `${options.model}:${hashText(options.systemPrompt)}`;
  const entry = promptCaches.get(key);
  if (entry && entry.expiresAt > Date.now() + 60000) return entry.name;
  const running = promptCacheInFlight.get(key);
  if (running) return running;
  const pending = createPromptCache(options, key).finally(() => {
    if (promptCacheInFlight.get(key) === pending) promptCacheInFlight.delete(key);
  });
  promptCacheInFlight.set(key, pending);
  return pending;
}

async function createPromptCache({ endpoint, model, systemPrompt, accessToken, fetchImpl }, key) {
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
export function unansweredCustomerMessages(recentMessages, current, { maxGapMs = 0, handledAt = 0, handledId = '' } = {}) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  const lastReply = list.findLastIndex(item => item?.direction === 'outgoing');
  const now = Number(current?.createdAt) || Date.now();
  const since = list.slice(lastReply + 1).filter(item => item?.direction === 'incoming' && (item.type || 'text') === 'text'
    && String(item.text || '').trim() && now - (Number(item.createdAt) || now) <= bundleWindowMs);
  let bundle = since.some(item => item.id && item.id === current?.id) ? since : [...since, current];
  // R14 (bình luận M2, ca …029290): "Túi Vàng" (bot đã xét, tin riêng bị chặn trùng, không lời công khai) bị gộp với "Lấy chị
  // Túi xanh" 9 phút sau → giỏ Vàng + Xanh. Với bình luận (`maxGapMs`): chỉ gộp các tin liền nhau cách nhau ≤ maxGapMs, và bỏ
  // tin đã có lượt xử lý (bot đã trả lời sau tin đó — `handledAt`, hay lượt bỏ qua có chủ ý — `handledId`).
  if (maxGapMs > 0) {
    const kept = [];
    for (let index = bundle.length - 1; index >= 0; index -= 1) {
      const item = bundle[index];
      const isCurrent = item === current || Boolean(item?.id && item.id === current?.id);
      if (!isCurrent) {
        const at = Number(item?.createdAt) || 0;
        const nextAt = Number(kept[0]?.createdAt) || now;
        if (nextAt - at > maxGapMs || (handledAt && at <= handledAt) || (handledId && String(item?.id || item?.mid || '') === String(handledId))) break;
      }
      kept.unshift(item);
    }
    bundle = kept;
  }
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

/**
 * Chủ shop 03/10 (processing/staff-idle.mjs): lượt kiểm lại sau khi bot im vì "nhân viên đang xử lý" với tin đặt hàng của khách
 * (hộp thư). Đọc lại hội thoại: bot đã tắt, đã có tin Page (nhân viên hay bot) sau tin khách, hay tin khách chưa có ý đặt hàng
 * → thôi. Tin khách mới nhất chưa đủ `idleMs` → hẹn lại phần còn thiếu. Còn lại: chạy luồng trả lời thường cho tin khách mới
 * nhất (gộp các tin từ sau tin Page cuối như thường) với cờ staffIdleTakeover, ghi chú cho nhân viên.
 */
async function staffIdleRecheck(conversationId, dependencies, idleMs) {
  const { getConversation, listMessages } = dependencies;
  const conversation = getConversation ? await getConversation(conversationId).catch(() => null) : null;
  if (!conversation || conversation.botEnabled === false || conversation.source === 'comment') return null;
  const stored = await Promise.resolve(listMessages(conversationId)).catch(() => []);
  const list = (Array.isArray(stored) ? stored : []).filter(item => !isPageSystemNotice(item));
  const lastPage = list.findLastIndex(item => item?.direction === 'outgoing');
  const waiting = list.slice(lastPage + 1).filter(item => item?.direction === 'incoming' && !isSilentCustomerMessage(item));
  const latest = waiting.at(-1);
  if (!latest) return null;
  if (!waiting.some(item => (item.type || 'text') === 'text' && (isOrderishText(item.text) || commentBasket(String(item.text || '')).length > 0))) return null;
  const left = idleMs - (Date.now() - (Number(latest.createdAt) || 0));
  if (left > 1000) {
    scheduleStaffIdleRecheck(conversationId, left, () => staffIdleRecheck(conversationId, dependencies, idleMs));
    return null;
  }
  const reason = staffIdleReason(idleMs);
  console.log(`Bot nhận đơn: ${reason} (${conversationId})`);
  const results = await processChatbotChanges([{ type: 'message', conversation, message: latest, staffIdleTakeover: true, staffIdleReason: reason }], dependencies);
  const result = results.find(item => item?.conversationId === conversationId) || null;
  if (result) Object.assign(result, { staffIdleTakeover: true, reason });
  if (result && !result.skipped && !result.error) {
    await noteForStaff(dependencies, conversation, `Bot đã tự nhận đơn (${reason}): khách gửi thông tin đặt hàng mà chưa ai của Page trả lời. Nhân viên kiểm lại đơn/tin bot vừa gửi.`, reason);
  }
  return result;
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
/** Lỗi gửi mà tin có thể đã tới khách (gửi dở INT-03, hết giờ chờ Pancake): người gọi coi như đã gửi, không gửi lại. */
export const sendMaybeDelivered = error => Boolean(error?.partial || error?.unknownDelivery || error?.code === 'PANCAKE_SEND_UNCERTAIN');

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

// R14 (quyết định 10): khách nói gửi về địa chỉ cũ / như lần trước (chữ đã bỏ dấu).
const OLD_ADDRESS_WORDS = /\b(?:dia chi|dc|d c|dchi|cho) (?:cu|truoc|bua truoc|lan truoc|hom truoc|don truoc)\b|\bnhu (?:cu|lan truoc|don truoc|hom truoc)\b|\b(?:gui|goi|ship|giao) (?:ve |theo )?(?:dia chi|dc) (?:cu|truoc)\b/;
/**
 * R15 (inbox4 A3, ca …434300 "S₫t.<sđt> chợ củ tinh Biên ang giang"): "chợ cũ / chợ củ" là TÊN CHỢ trong địa chỉ, không phải
 * "chỗ cũ". Bỏ dấu thì chợ = chỗ = "cho" → xét trên chữ CÒN DẤU: thay "chợ" (đứng riêng) bằng một chữ không khớp trước khi bỏ
 * dấu. "chỗ cũ", "chổ cũ" (gõ sai) và "cho cu" không dấu vẫn là địa chỉ cũ như trước.
 */
/**
 * R15 (inbox1 A1): tin CHỈ nêu một vị túi lớn ("Ca cao", "Túi vàng", "Túi vàng nhiêu hat", "Túi nâu cacao", "còn túi xanh") — không
 * số, không từ đổi/bỏ/thêm, không câu hỏi, không Tropical. Trả 'xanh' | 'vang' | 'nau', còn lại ''.
 */
/**
 * R15-fix3 (phản biện C3): bỏ cụm KHỐI LƯỢNG túi ("350g", "450 g", "300gr", "1kg"; số trơn 300/350/450/500 khi tin có tên màu —
 * "vàng 350") để chữ số khối lượng không bị đọc thành số lượng túi.
 */
export function stripBagWeights(text) {
  let out = String(text || '').normalize('NFC')
    .replace(/(?<![\p{L}\p{N}])\d{2,4}\s?(?:g|gr|gam|gram|grams)(?![\p{L}\p{N}])/giu, ' ')
    .replace(/(?<![\p{L}\p{N}])\d{1,2}(?:[.,]\d)?\s?kg(?![\p{L}\p{N}])/giu, ' ');
  if (/xanh|vàng|vang|nâu|nau|cacao|ca cao/iu.test(out)) out = out.replace(/(?<![\p{L}\p{N}])(?:300|350|450|500)(?![\p{L}\p{N}])/gu, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * strict (R15-fix3, phản biện T3 — dùng khi xét TÁCH vị thứ hai): tin có "đi / luôn / nha / nhé / lấy / cho / thôi / đổi" ("Vàng đi",
 * "lấy vàng", "cho vàng luôn", "vàng nha") là khách ĐỔI Ý cả giỏ, không phải vị của túi thứ hai → ''. Chỉ tên vị trơn ("Ca cao",
 * "Túi vàng", "Túi vàng nhiêu hat") mới tách. Không strict (vị đầu tiên, chờ mảnh): như cũ.
 */
export function singleFlavourOf(text, { strict = false } = {}) {
  const raw = stripBagWeights(text);
  if (!raw || raw.length > 60 || /[\d?]/.test(raw)) return '';
  let s = foldVietnamese(raw).toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (strict && /\b(?:di|luon|nha|nhe|nhen|lay|cho|thoi|doi)\b/.test(s)) return '';
  // "vâng" bỏ dấu trùng "vàng": chỉ nhận vàng khi chữ còn dấu là "vàng" (hay khách gõ không dấu "vang").
  if (/\bvang\b/.test(s) && /vâng/iu.test(raw) && !/vàng/iu.test(raw)) return '';
  if (/\b(?:xanh (?:duong|bien|mint|nhat|ngoc)|mint|tropical|dau|xoai|hat dieu|combo|hop|goi nho|yen mach|nghe|nguyen ban)\b/.test(s)) return '';
  if (/\b(?:doi|thay|bo|bot|khong|ko|kg|hong|thoi|chi|huy|sua|nham|them|nua|hay|hoac|voi|va|mot|hai|ba|bon|nam|gia|bn|bao|nhieu tien|sao|nao)\b/.test(s.replace(/\bnhieu hat\b|\bnhieu hat\b/g, ' '))) return '';
  s = s.replace(/\bca cao\b|\bcacao\b|\bsocola\b|\bsoco la\b/g, ' nau ').replace(/\bnhieu hat\b/g, ' vang ');
  const colours = [...new Set(s.match(/\b(?:xanh|vang|nau)\b/g) || [])];
  if (colours.length !== 1) return '';
  const leftover = s.replace(/\b(?:xanh|vang|nau|la|cay|tui|goi|bich|bit|granola|vi|mau|loai|cho|em|e|minh|mk|m|chi|c|a|anh|lay|nha|nhe|nhen|shop|di|con|oi|ak|ah|luon|da|ok|oke|the|thi|vay|cua|to|tui)\b/g, '').trim();
  return leftover ? '' : colours[0];
}

// R15-fix4: từ đệm bỏ đi trước khi đọc câu trả lời gộp/tách (chữ thường, còn dấu). "đúng/ok/vâng/ừ/dạ" vừa là đệm vừa là lời đồng ý.
const MERGE_SPLIT_FILLERS = new Set(['ạ', 'a', 'ah', 'ak', 'ạh', 'nha', 'nhá', 'nhaa', 'nhé', 'nhe', 'nhen', 'nghen', 'nè', 'em', 'e', 'shop', 'sh', 'c', 'chị', 'chi',
  'ơi', 'oi', 'dạ', 'da', 'vâng', 'ok', 'oke', 'okê', 'okie', 'oki', 'okay', 'ừ', 'ừm', 'ừa', 'uh', 'uk', 'um', 'u', 'ờ', 'ờm', 'đúng', 'rồi', 'r',
  'luôn', 'lun', 'đi', 'giúp', 'giùm', 'dùm', 'cho', 'tiện', 'với', 'mình', 'thôi', 'vậy']);
const MERGE_SPLIT_YES = new Set(['đúng', 'ok', 'oke', 'okê', 'okie', 'oki', 'okay', 'vâng', 'ừ', 'ừm', 'ừa', 'uh', 'uk', 'um', 'u', 'ờ', 'ờm', 'dạ', 'da']);
// Lời đồng ý đứng một mình (không phải đệm khi đi với chữ khác): "có", "chốt", "phải"; "dung"/"vang" không dấu chỉ khi là cả câu
// ("dung tach" có thể là "đừng tách", "vang" có thể là Vàng).
const MERGE_SPLIT_YES_ONLY = new Set(['có', 'co', 'phải', 'phai', 'chuẩn', 'chuan', 'chốt', 'chot', 'yes', 'dung', 'vang']);
const MERGE_CORE = /^(?:(?:gop|ghep)(?: (?:chung|lai|vao|vo))*(?: (?:don|1 don|mot don))?(?: (?:cu|truoc|kia|do|nay|dang co|hom truoc|hom qua|vua dat))?|chung (?:don|1 don|mot don)|(?:gui|giao|ship|di) chung(?: (?:don|1 don|mot don))?|(?:(?:cong|them|cho|nhet) )?(?:vao|vo) don (?:cu|truoc|kia|do|nay|dang co))$/;
const SPLIT_CORE = /^(?:tach(?: (?:ra|rieng))?(?: (?:don|(?:2|hai) don))?(?: (?:moi|rieng|khac))?|(?:len |lam |tao |dat )?don (?:moi|rieng|khac)|(?:de |giao |gui |ship )?rieng(?: ra)?|(?:2|hai) don(?: rieng)?|(?:dat|mua|lay) them(?: don(?: moi)?)?)$/;
// Lời đồng ý kiểu "lên đơn / chốt đơn / đặt luôn": với lời cũ ("nhắn đúng là em lên đơn") là đồng ý; với lời mới là mơ hồ.
// R16 (inbox4 H1): "Vậy đặt đơn đó thôi", "lên đơn đó" cũng là đồng ý (vậy/thôi là đệm).
const MERGE_SPLIT_YES_PHRASE = /^(?:len don|chot don|dat|dat luon|len don luon|chot luon|(?:dat|len|chot) don (?:do|nay)(?: luon)?)$/;

/**
 * R15-fix4 (chủ shop 03/10): đọc câu khách trả lời "gộp vào đơn đang có hay tách đơn mới" — CHỈ câu ngắn và rõ. Bỏ từ đệm
 * (ạ/nha/nhé/em/shop/c/chị/dạ/vâng/ok/đúng/luôn/đi/cho tiện…), phần còn lại phải là đúng một cụm:
 * - 'merge': gộp / gộp chung / gộp vào đơn cũ / ghép (chung) / chung đơn / gửi·giao·ship chung;
 * - 'split': tách (đơn/riêng/ra) / đơn mới / đơn riêng / lên đơn mới / đặt thêm / để riêng / 2 đơn;
 * - 'yes': chỉ lời đồng ý (đúng, ok, vâng, ừ, dạ, đúng rồi, có, chốt, lên đơn…);
 * - '': mọi câu khác — phủ định ("không/đừng/khỏi"), câu hỏi ("?", "à", "làm gì", "được không", "hay"), "tùy", "hủy", tên món, số
 *   túi, SĐT/địa chỉ, người nhận khác… (engine chuyển bạn phụ trách, không tự quyết).
 */
export function readMergeSplitReply(text) {
  const raw = String(text || '').normalize('NFC').toLowerCase();
  if (!raw.trim() || /\?/.test(raw)) return '';
  const tokens = raw.replace(/[,;:.!…~"'()\-–]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 10) return '';
  let yesSeen = false;
  const kept = [];
  for (const token of tokens) {
    if (MERGE_SPLIT_FILLERS.has(token)) { if (MERGE_SPLIT_YES.has(token)) yesSeen = true; continue; }
    kept.push(token);
  }
  if (!kept.length) return yesSeen ? 'yes' : '';
  if (kept.every(token => MERGE_SPLIT_YES_ONLY.has(token))) return 'yes';
  const core = foldVietnamese(kept.join(' ')).replace(/\s+/g, ' ').trim();
  // Chữ có dấu không đổi nghĩa khi bỏ dấu ở các cụm trên, trừ "đừng"/"dừng"/"đúng" (dung) — đã không thuộc cụm nào.
  if (MERGE_CORE.test(core)) return 'merge';
  if (SPLIT_CORE.test(core)) return 'split';
  if (MERGE_SPLIT_YES_PHRASE.test(core)) return 'yes';
  return '';
}

/** R15-fix4: tin có chữ gộp/ghép/chung/hủy/đổi/không/đừng/khỏi hay "?" — không được coi là "tách bằng SĐT + địa chỉ mới". */
export function mergeSplitBlockWords(text) {
  const raw = String(text || '').normalize('NFC').toLowerCase();
  if (/\?/.test(raw)) return true;
  const masked = raw.replace(/chung\s+c[ưu]/gu, ' ');
  const accented = /(?<![\p{L}\p{N}])(?:gộp|ghép|chung|hủy|huỷ|đổi|không|đừng|khỏi|chẳng|hông|khum|thôi)(?![\p{L}\p{N}])/u;
  if (accented.test(masked)) return true;
  // Bản không dấu chỉ xét chữ gõ KHÔNG dấu (chữ "Hồng", "Đội" trong địa chỉ có dấu nên không bị bắt nhầm).
  return masked.split(/[^\p{L}\p{N}]+/u).some(token => /^[a-z]+$/.test(token) && ['gop', 'ghep', 'chung', 'huy', 'doi', 'khong', 'ko', 'kg', 'k', 'hong', 'dung', 'khoi', 'thoi'].includes(token));
}

/** R15: mode cài đặt của một luật ứng viên (K1/K1b/K3/K4/K5…) — cờ chung (chuỗi) hay theo từng luật (đối tượng). */
export function candidateModeOf(setting, rule) {
  if (typeof setting === 'string') return ['on', 'shadow', 'off'].includes(setting) ? setting : 'shadow';
  const name = String(rule || '').toUpperCase();
  const key = /^K1B/.test(name) ? 'K1b' : /^K1/.test(name) ? 'K1' : /^K3/.test(name) ? 'K3' : /^K4/.test(name) ? 'K4' : /^K5/.test(name) ? 'K5' : '';
  const value = key && setting && typeof setting === 'object' ? setting[key] : '';
  return ['on', 'shadow', 'off'].includes(value) ? value : 'shadow';
}

// R15 (bình luận A3): góp ý tiếng phiên live mà LIVE_FEEDBACK (rule-intent) chưa bắt: "nói nhỏ xíu sao nghe", "nói bé quá".
const LIVE_FEEDBACK_EXTRA = /\bnoi (?:nho|be) (?:xiu|qua|vay|the|ghe|lam)\b|\bnho xiu\b.*\bnghe\b|\b(?:sao|khong|ko|k|kg|hong) nghe (?:duoc|dc|ro|gi|thay)\b/;

export function saysOldAddress(text) {
  // Dùng chung maskMarketWord với luồng đơn (order-flow.mentionsOldAddress).
  return OLD_ADDRESS_WORDS.test(foldVietnamese(maskMarketWord(text)).replace(/\s+/g, ' '));
}
// R14: từ của lời xác nhận thông tin đơn vừa chốt ("Ok thông tin chuẩn r nhé", "đúng rồi nha shop", "chính xác ạ").
const confirmAckWords = new Set([...thanksAckWords, 'oki', 'okie', 'chuan', 'dung', 'chinh', 'xac', 'thong', 'tin', 'het', 'roi', 'r', 'nhen', 'the', 'vay', 'v', 'z', 'ha', 'ui', 'oi', 'minh', 'm', 'nhe', 'luon', 'nhan', 'don']);

/** Khách vừa nhắn thêm ngay trước khi gọi mô hình: lượt này nhường cho tin sau (không phải lỗi). */
class NewerMessageSkip extends Error {
  constructor() { super('gộp với tin sau'); this.name = 'NewerMessageSkip'; }
}

// Tin đang được bot xử lý (khóa theo hội thoại:tin) — chặn cùng một tin vào hai lần qua hai đường.
const inFlightMessages = new Set();
// R13: khách nói bấm nhầm ("Chị ấn nhấn nhầm đấy", "lỡ tay bấm") — so trên chuỗi đã bỏ dấu.
const misclickPattern = /\b(?:an|bam|nhan|click|chon|cham|dung) (?:nhan |vao )?(?:nham|lon)\b|\blo tay\b|\b(?:nham|lon) (?:thoi|day|do|roi|a|ak|nha|nhe)\b|^nham$/;
// ===== R14: săn deal / từ chối / khen (so trên chữ đã bỏ dấu, chỉ giữ chữ-số) =====
// Ca thật 02/10: "Thôi dẹp khỏi mua", "Kg có mua nhé" (từ chối), "Săn ntn ạh" (hỏi cách săn), "Mình đã mua, ăn ngon nha" (khen),
// "Mình ko săn deal trên live" (phủ định) đều từng nhận "em ghi nhận đã săn deal trên live rồi".
const huntNegation = /\b(?:khong|ko|k|kg|chua|hong|hok|cha|chang|khum) (?:co )?(?:san|mua|chot|dat|lay)\b/;
const huntHow = /\bsan (?:the nao|tn|sao|ntn|nhu nao|kieu gi|o dau|lam sao|cach nao)\b|\bcach (?:san|chot|tham gia|dat|mua)\b|\blam sao (?:de )?(?:san|chot|dat|mua)\b|\b(?:san|chot|dat|mua) (?:deal )?(?:ntn|the nao|nhu nao|sao)\b/;
const praiseWordsPattern = /\b(ngon|tuyet|tuyet voi|thich|thik|ung|gion|hop khau vi|ok lam|qua ngon|hai long)\b/;
/** Khách khen sau khi đã mua/ăn ("Mình đã mua, ăn ngon nha") — không phải báo săn deal, không phải đặt hàng. */
export function praisesAfterBuying(text) {
  const s = squashText(text);
  if (!s || s.length > 80 || /\?/.test(String(text || ''))) return false;
  return /\b(?:da|vua) (?:mua|an|dung|nhan)\b|\b(?:mua|an|dung|nhan) (?:roi|r)\b/.test(s) && praiseWordsPattern.test(s)
    && !/\b(?:lay|them|nua|gia|bn|bao nhieu|ship|ib|inbox|combo|chot|dat)\b|\d/.test(s) && !huntNegation.test(s);
}
/** Khách hỏi CÁCH săn/đặt deal ("Săn ntn ạh", "cách tham gia") — không phải đã săn. */
export function asksHowToHunt(text) {
  return huntHow.test(squashText(text));
}
/** Khách TỪ CHỐI mua ("Kg có mua nhé", "Thôi dẹp khỏi mua", "thôi ko lấy nữa") — tin ngắn, không hỏi, không điều kiện. */
export function refusesPurchase(text) {
  const raw = String(text || '');
  const s = squashText(raw);
  if (!s || s.length > 60 || /\?/.test(raw)) return false;
  if (/\b(?:thi|neu|gia|giam|bot|tru|bn|bao nhieu|sao|tui|goi|bich|xanh|vang|nau|combo)\b|\d/.test(s)) return false;
  return /\b(?:thoi |dep )+khoi (?:mua|lay|dat|chot)\b|^(?:(?:thoi|da|minh|em|e|chi|c|toi|tui|m|mk|a|anh) )*khoi (?:mua|lay|dat|chot)(?: (?:nua|luon|di|nhe|nha|a))*$/.test(s)
    || /^(?:(?:thoi|da|minh|em|e|chi|c|toi|tui|m|mk|a|anh) )*(?:k|ko|kg|khong|hong|khum|hok) (?:co )?(?:mua|lay|dat|chot)(?: (?:nua|nhe|nha|nhen|dau|a|ak|ah|roi|r|shop|em|e|c|chi|ban|hang|don))*$/.test(s)
    || /\bthoi (?:khong|ko|k|kg) (?:mua|lay|dat)\b|\bthoi dep\b/.test(s);
}
/**
 * R16 (inbox1 A5): khách nói không mua (thêm) nữa — "da nhan hang roi nen kg mua nua", "không mua nữa", "ko lấy nữa", "khong lay
 * nua nha", kể câu dài hơn refusesPurchase. Câu hỏi ("?", "không mua nữa thì sao") và câu có số/màu/giá không tính.
 */
export function declinesBuyingMore(text) {
  const raw = String(text || '');
  const s = squashText(raw);
  if (refusesPurchase(text)) return true;
  if (!s || s.length > 80 || /\?/.test(raw) || /\b(?:thi|neu|sao|gia|bn|bao nhieu|giam|xanh|vang|nau|combo)\b|\d/.test(s)) return false;
  return /\b(?:k|ko|kg|khong|hong|khum|hok) (?:can )?(?:mua|lay|dat|can) (?:them )?nua\b/.test(s);
}
/** Khách thật sự BÁO đã săn / đã đặt / đã chốt (không phủ định, không hỏi cách, không chỉ khen). */
export function claimsLiveDeal(text) {
  const s = squashText(text);
  if (!s || huntNegation.test(s) || huntHow.test(s) || refusesPurchase(text) || praisesAfterBuying(text)) return false;
  // "Dạ mua 2 bịch…" (bỏ dấu cũng là "da mua") là đặt hàng, không phải báo đã săn.
  if (/^da (?:mua|dat|lay|chot) (?:\d|mot|hai|ba)\b/.test(s)) return false;
  // Tra đơn ("đặt r mà làm sao để biết", "mới đặt mà, em kiểm tra giúp") hay chê ("đã mua … không như quảng cáo") không phải báo săn.
  if (/\b(?:lam sao|kiem tra|check|giao (?:toi|den) dau|biet|nho)\b/.test(s) || complainsAboutProduct(text)) return false;
  return /\b(?:da|vua) (?:san|mua|chot|dat)\b|\bsan (?:duoc|dc|roi|r|deal roi|deal r)\b|\b(?:chot|dat) (?:duoc|dc|roi|r)\b|\blen ma\b/.test(s);
}
/**
 * R14 (ca 02/10 "Em kiểm tra lại tin nhắn a có đặt đơn 2 túi đâu" lên giỏ 2 Tropical): "túi ĐÂU" bỏ dấu trùng "túi dâu" —
 * đổi "đâu" còn dấu thành chữ khác trước khi so TROPICAL_MENTION (cùng cách rule-intent).
 */
export function mentionsTropical(text) {
  const raw = String(text || '').normalize('NFC').replace(/(?<![\p{L}])(túi|tui|gói|goi|bịch|bich|loại|loai|vị|vi|granola)(\s+có|\s+co)?\s+đâu(?![\p{L}])/giu, '$1 where');
  return TROPICAL_MENTION.test(foldVietnamese(raw).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' '));
}
// ===== R14 (chủ shop 03/10, quyết định 4): lời chê/khiếu nại sản phẩm =====
/** Tin chỉ là "dở/dỡ" (± quá/thật/tệ…) — chữ CÒN DẤU ("do" bỏ dấu trùng quá nhiều từ). */
export function shortDislike(text) {
  return /^(?:dở|dỡ|dở ẹc|dỡ ẹc)(?:\s+(?:quá|thật|ghê|tệ|lắm|ẹc|vậy|vãi|thế|z|v|ạ|à|nha|nhé))*[\s.!…]*$/iu.test(String(text || '').normalize('NFC').trim());
}
/** Lời chê sản phẩm/quảng cáo: "không như quảng cáo", "không đúng với quoảng cáo", "mở ra (bên trong) toàn yến mạch", "dở". */
export function complainsAboutProduct(text) {
  const s = squashText(text);
  if (!s || mentionsOtherSeller(text)) return false;
  return shortDislike(text) || shortBadTaste(text) || AD_MISMATCH_COMPLAINT.test(s)
    || /\b(?:khong|ko|k|kg|chang|cha|hong) (?:duoc |dc |dung |giong |nhu )?(?:nhu |voi |giong )?(?:quo?ang cao|qc|hinh|anh quang cao)\b/.test(s)
    || /\bkhac (?:voi )?(?:quo?ang cao|qc|tren hinh)\b/.test(s)
    || /\btoan (?:la )?yen mach\b|\bmo ra .{0,20}\b(?:toan|chu yeu|it hat|it trai cay)\b/.test(s);
}
/** Bình luận là câu hỏi giá / đặt mua / hỏi đơn / đòi gặp người — mô hình chọn CSKH_HANDOFF cho câu này không phải lời chê. */
export function commentIsRequest(text) {
  const s = squashText(text);
  return /\d|\b(gia|bn|bnh|bao nhieu|nhieu tien|mua|lay|dat|chot|ship|ib|inbox|tui|goi|combo|don|huy|doi|nhan vien|tu van|goi (?:cho|lai|dien)|lien he|hotline|sdt|so dien thoai)\b/.test(s);
}
/**
 * R14 (quyết định 9): bình luận đùa / không liên quan — mô hình chỉ chọn chào/cảm ơn (WELCOME/THANK_YOU) cho một câu không
 * hỏi (không "?"), không hỏi giá/mua/đơn, không phải lời chào, không phải lời khen thật ("k đẹp" là chê đùa, không phải khen).
 */
export function commentOffTopic({ text = '', chosen = '', praise = false, emojiOnly = false } = {}) {
  if (!['WELCOME', 'THANK_YOU'].includes(String(chosen || '')) || emojiOnly) return false;
  const raw = String(text || '');
  const s = squashText(raw);
  if (!s || /\?/.test(raw) || commentIsRequest(raw)) return false;
  // Lời chào ("Chào chị", "shop ơi") → vẫn chào lại như cũ; câu hỏi (sao, nào, gì, không…) → không phải đùa.
  if (/^(?:chao|xin chao|hi|hello|helo|alo|a lo|shop oi|oi)\b/.test(s) || /\b(sao|nao|gi|khong a|the nao|ntn|co khong|duoc khong)\b/.test(s)) return false;
  const negatedPraise = /\b(?:k|ko|kg|khong|chang|cha|hong) (?:dep|ngon|thich|hay|tot)\b/.test(s);
  return !praise || negatedPraise;
}
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

// R16 (inbox4 H1, ca …011918): lời "đặt THÊM một đơn mới … đúng không" (lời cũ đang chạy) — dùng khi đơn đang có KHÔNG gộp được.
export const LEGACY_EXISTING_CONFIRM = 'Dạ {title} ơi, em thấy mình đang có đơn {existing_items} đặt lúc {existing_at}, hiện {existing_state} ạ 🌾 Mình muốn đặt THÊM một đơn mới gồm {cart} nữa đúng không ạ? {Title} nhắn "đúng" giúp em là em lên đơn liền; còn nếu là đơn cũ thì {title} cứ nhắn em kiểm tra cho mình nha ạ.';
// Mã trạng thái Pancake POS đã rời kho / đang đóng / đã giao: 2 đã gửi, 3 đã nhận, 8 đang đóng hàng, 9 chờ chuyển hàng, 16 đã thu tiền.
const POS_SHIPPED_CODES = new Set([2, 3, 8, 9, 16]);
/**
 * R16 (inbox4 H1): đơn đang có còn GỘP được không (quyết định 7 chủ shop chỉ nói đơn trong 24 giờ): đơn do bot tạo trong hội
 * thoại, chưa hủy, dưới 24 giờ, chưa gửi đi/đóng hàng. Đơn POS, đơn nhân viên/landing tạo, đơn quá 24 giờ hay đã gửi đi → không
 * hỏi gộp/tách mà hỏi "đặt thêm đơn mới đúng không" (lời cũ), "đúng / mua thêm / lấy thêm" = đơn mới.
 */
export function orderMergeable(order, now = Date.now()) {
  if (!order?.id || !isActiveOrder(order) || order.automatic !== true || order.source === 'POS' || order.landing) return false;
  if (now - (Number(order.createdAt) || 0) >= 24 * 60 * 60 * 1000) return false;
  if (POS_SHIPPED_CODES.has(Number(order.posStatus?.code))) return false;
  const status = [order.status, order.posStatus?.name, order.pos?.status].map(value => String(value || '')).join(' ');
  return !/đã giao|đang giao|đã gửi|gửi hàng|vận chuyển|chờ chuyển|chờ lấy|đóng hàng|đóng gói|đã nhận/i.test(status);
}
// R16 (bình luận A3): lời công khai khi bot GỬI LẠI tin riêng cho khách báo chưa thấy tin (mẫu chưa có trong Cài đặt).
const COMMENT_PUBLIC_RESENT_FALLBACK = 'Dạ {title} ơi, em vừa nhắn lại cho mình rồi ạ, mình xem giúp em ở mục Tin nhắn chờ nha 💛';
// R16 (inbox1 B6): lời đáp ngắn cho lời dặn giao hàng thứ hai trong 30 phút (câu ghi chú đầy đủ đã gửi).
const NOTE_ADDED_AGAIN = 'Dạ em ghi thêm vào đơn rồi ạ 💛';
// R16 (inbox5 A6): lời dự phòng khi bộ mẫu chưa có VOICE_RECEIVED (cùng ý với mẫu seed do agent mẫu thêm).
const VOICE_RECEIVED_FALLBACK = 'Dạ em chưa nghe được tin nhắn thoại, {title} nhắn chữ giúp em nha ạ';
// R16 (giỏ do mô hình suy ra): chữ khách có nêu vị/màu, số túi/"combo", hay ý mua không (đã bỏ dấu, bỏ SĐT và khối lượng 350g/450g).
// "cam"/"nghệ" chỉ khi đi với vi/tui/mau hay "nghệ lành" (tên đất "Cẩm Phả", "Nghệ An" không tính).
const CHOICE_FLAVOUR = /\b(?:xanh|vang|nau|cacao|ca cao|socola|chocolate|tropical|nguyen ban|nhieu hat|mix|(?:vi|tui|mau) cam|trai cay|nghe lanh|bot nghe|yen mach|goi nho|10 goi|mini|khong yen mach)\b/;
// "2 t ap 4 …" (r13 ca …9194039884): "t" viết tắt túi.
const CHOICE_COUNT = /\b(?:\d+|mot|hai|ba|bon|nam|sau)\s*(?:tui|tuis|tuj|goi|bich|bit|hop|b|g|t|combo|cb)\b|\bcombo\b/;
const CHOICE_BUY = /\b(?:lay|mua|dat|chot)\b/;
const choiceText = text => foldVietnamese(stripBagWeights(stripPhone(String(text || '')))).replace(/\s+/g, ' ');
/** R16 (B1 "Hix"): tin chỉ là tiếng cảm thán ngắn, không hỏi gì ("Hix", "huhu", "ôi", "à vâng", "haha"). "vàng" có dấu không tính. */
export function isExclamationOnly(text) {
  const raw = String(text || '').normalize('NFC');
  if (/vàng|\?/iu.test(raw)) return false;
  const folded = foldVietnamese(raw).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:hi+x+|hi+c+|hu+ ?hu+(?: ?hu+)*|o+i+(?: troi(?: oi)?)?|troi oi|a vang|a+|a+h|u+i+|haha+|hihi+|hehe+)(?: (?:a|ah|e|em|shop|c|chi|oi))*$/.test(folded);
}
/** Đơn của câu trả lời chỉ là thao tác trên đơn cũ (ghi chú / hủy / sửa), không phải đơn mới. */
const operationOnlyEarly = order => Boolean(order?.noteOrderId || order?.cancelOrderId || order?.updateOrderId);
/** R16: bộ mẫu cho câu hỏi "đặt thêm?" khi đơn đang có không gộp được — mẫu trong Cài đặt hỏi gộp/tách thì thay bằng lời cũ. */
function addOnlyConfirmTemplates(templates) {
  const text = String(templates?.ORDER_EXISTING_CONFIRM || '');
  if (!text.trim() || !/\b(?:gop|tach)\b/.test(foldVietnamese(text))) return templates;
  return { ...templates, ORDER_EXISTING_CONFIRM: LEGACY_EXISTING_CONFIRM };
}

// Số lượt (khách khác nhau) của một lô chạy cùng lúc.
export const CHATBOT_BATCH_CONCURRENCY = 3;

/** Bộ giới hạn nhỏ: tối đa `max` tác vụ async chạy cùng lúc, còn lại chờ theo thứ tự xin. */
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || !waiting.length) return;
    active += 1;
    const { task, resolve, reject } = waiting.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return task => new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); next(); });
}

export async function processChatbotChanges(changes, dependencies) {
  const { readSettings } = dependencies;
  const settings = await readSettings();
  if (!settings.enabled) return [];
  const results = [];
  // Lô nhiều tin (đồng bộ bù, backlog sau khởi động, webhook nhiều sự kiện): khách KHÁC NHAU chạy song song, tối đa
  // CHATBOT_BATCH_CONCURRENCY lượt cùng lúc (giữ hạn mức Vertex) — khách B không phải chờ lượt chậm của khách A
  // (chờ gộp tin, chờ giỏ Shop, LLM thử lại). Tin của CÙNG một khách vẫn nối tiếp đúng thứ tự qua hàng đợi theo khách:
  // xếp hàng ngay khi duyệt lô, chỉ xin chỗ chạy khi tới lượt trong hàng của khách đó.
  const limit = createLimiter(CHATBOT_BATCH_CONCURRENCY);
  const runs = [];
  for (const change of changes) {
    // `updated`: tin cũ vừa có thêm dữ liệu (ảnh có URL) — hộp thư vẽ lại, bot không trả lời lần hai.
    if (change.type !== 'message' || change.message?.direction !== 'incoming' || !change.conversation || change.updated) continue;
    // Cùng một tin về qua hai đường (webhook + đồng bộ/backlog) trong lúc lượt đầu còn đang chạy: bỏ.
    const inFlightKey = `${change.conversation.id}:${change.message.id || change.message.mid || change.message.createdAt}`;
    if (inFlightMessages.has(inFlightKey)) { results.push({ conversationId: change.conversation.id, skipped: 'đang xử lý tin này' }); continue; }
    inFlightMessages.add(inFlightKey);
    // Hàng đợi theo KHÁCH (pageId:psid): bình luận và hộp thư của cùng một
    // người nối tiếp nhau, hai bình luận liền nhau không chạy song song.
    const queueKey = change.conversation.pageId && change.conversation.psid ? `${change.conversation.pageId}:${change.conversation.psid}` : change.conversation.id;
    runs.push(queueForConversation(queueKey, () => limit(() => answerChange(change, settings, results, dependencies)))
      // Một hội thoại hỏng (kho tin không ghi được…) không làm rơi các tin còn lại trong lô.
      .catch(error => { results.push({ conversationId: change.conversation.id, error: error.message }); })
      .finally(() => { inFlightMessages.delete(inFlightKey); }));
  }
  await Promise.all(runs);
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
    // R15 (inbox1 A9): lượt giỏ Shop chạy lại sau khởi động (resumeShopCart, pancake.backlogBotChanges) — tin Page sau tin giỏ
    // chỉ là tin ack của chính lượt bị cắt ngang, không phải "đã có người trả lời".
    const resumeShopCart = Boolean(change.resumeShopCart) && Number(conversation.shopCartAckPendingAt) > 0 && Array.isArray(change.message?.cart) && change.message.cart.length > 0;
    // R16 (inbox5 A1): tin hộp thư đến muộn có SĐT/địa chỉ/số túi/vị mà lời sau nó chỉ là của bot trả lời tin CŨ hơn (bot chưa
    // đọc tới tin này — mốc botAnsweredUpTo) → không phải "đã có người trả lời".
    const lateInfoForBot = change.late && conversation.source !== 'comment'
      && lateInfoNeedsBot(recent, change.message, { answeredUpTo: conversation.botAnsweredUpTo });
    if ((change.delayedRetry || change.late) && !resumeShopCart && !lateInfoForBot && recent.some(item => item?.direction === 'outgoing' && (Number(item?.createdAt) || 0) >= askedAt)) {
      results.push({ conversationId: conversation.id, skipped: 'đã có người trả lời' });
      return;
    }
    // R13 (bình luận F1): tin đến muộn (backlog sau khởi động / đồng bộ) mà bot ĐÃ xử lý — lượt trước bỏ qua có chủ ý
    // (botHandledMessageId), hay là bình luận đã được trả lời bằng tin nhắn riêng: tin riêng nằm ở HỘP THƯ của khách, lời
    // công khai có khi không đăng, nên chỉ nhìn tin của luồng bình luận thì mỗi lần khởi động lại bot trả lời lại lần nữa.
    // R13 sửa (phản biện T1): cùng phép xét với pancake.commentReplyCovers — chỉ nhìn dấu vết trong CHÍNH luồng bình luận:
    // botHandledMessageId (ghi ở mọi lượt trả lời bình luận) → tin đứng trước tin đã xử lý là tin đã gộp; dữ liệu cũ mới dùng mốc
    // botLastReplyAt (lệch giờ 5 giây, tin phải là tin khách duy nhất chưa trả lời). Không nhìn tin riêng ở hộp thư nữa (tin
    // riêng của bài KHÁC làm bình luận bài này bị bỏ).
    if (change.delayedRetry || change.late) {
      const lateId = String(change.message?.id || change.message?.mid || '');
      const handledId = String(conversation.botHandledMessageId || '');
      let handled = Boolean(lateId) && handledId === lateId;
      if (!handled && conversation.source === 'comment' && askedAt) {
        const thread = Array.isArray(recentStored) ? recentStored : [];
        const idOf = item => String(item?.id || item?.mid || '');
        const handledMessage = handledId ? thread.find(item => idOf(item) === handledId) : null;
        if (handledMessage) handled = (Number(handledMessage.createdAt) || 0) >= askedAt;
        else {
          const replyAt = Number(conversation.botLastReplyAt) || 0;
          const skew = 5000;
          if (replyAt && askedAt <= replyAt - skew) {
            const customerAt = item => (item?.direction === 'incoming' && idOf(item) !== lateId ? Number(item.createdAt) || 0 : 0);
            const previousPublic = thread.reduce((latest, item) => (item?.direction === 'outgoing' && !isPageSystemNotice(item) && (Number(item.createdAt) || 0) < askedAt ? Math.max(latest, Number(item.createdAt) || 0) : latest), 0);
            const floor = Math.max(previousPublic, replyAt - 30 * 60 * 1000);
            handled = thread.some(item => customerAt(item) > askedAt && customerAt(item) <= replyAt - skew)
              || !thread.some(item => customerAt(item) > floor && customerAt(item) < askedAt);
          }
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
    const commentBundleRules = conversation.source === 'comment' ? { maxGapMs: 60 * 1000, handledAt: Number(conversation.botLastReplyAt) || 0, handledId: String(conversation.botHandledMessageId || '') } : {};
    const bundle = change.message.type === 'text' ? unansweredCustomerMessages(recent, change.message, commentBundleRules) :textsWithImage.length ? [...textsWithImage, change.message] : [change.message];
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
    // R15 (inbox4 A4): tin chữ tới sau ảnh/tệp chưa được trả lời (≤ 60 giây — lượt ảnh đã nhường): chữ mang ngữ cảnh ảnh.
    const mediaBeforeText = change.message.type === 'text' && conversation.source !== 'comment' && recent.slice(lastOutgoingIndex + 1).some(item => item?.direction === 'incoming'
      && !['text', 'sticker', 'ad', 'order-receipt'].includes(String(item.type || 'text')) && item.id !== change.message.id && !stickerInfo(item)
      && imageAt - (Number(item.createdAt) || 0) >= 0 && imageAt - (Number(item.createdAt) || 0) <= 60 * 1000);
    const message = textsWithImage.length
      ? { ...change.message, ...(visionOn ? {} : { type: 'text' }), text: textsWithImage.map(item => String(item.text || '').trim()).join('\n'), withImage: true }
      : bundle.length > 1
        ? { ...change.message, text: bundle.map(item => String(item.text || '').trim()).join('\n'), ...(mediaBeforeText ? { withImage: true } : {}) }
        : mediaBeforeText ? { ...change.message, withImage: true } : change.message;
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
    // R15 (inbox1 A3, bình luận A6, ca …6422098884): câu trả lời của bình luận đi bằng TIN RIÊNG vào hộp thư — ý phụ (also) chỉ bị
    // bỏ khi trùng tin của chính luồng bình luận nên bình luận "Túi vàng <sđt>" nhận lại nguyên câu 445 Kcal vừa gửi 3 phút trước.
    // Ý phụ của bình luận cũng so với tin Page gửi vào hộp thư cùng khách trong 30 phút.
    if (conversation.source === 'comment' && inboxMessages.length) {
      replyContext.recentOutgoing = [...replyContext.recentOutgoing, ...inboxMessages.filter(item => item?.direction === 'outgoing' && Date.now() - (Number(item.createdAt) || 0) < 30 * 60 * 1000).map(item => String(item.text || ''))];
    }
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
    // Chủ shop 03/10 (processing/staff-idle.mjs): lượt kiểm lại "nhân viên im 5 phút" sau tin đặt hàng của khách (hộp thư) bỏ qua
    // phần "nhân viên nhắn sau bot / thẻ cần người + nhân viên nhắn trong 2 giờ"; khiếu nại/bảo hành vẫn giữ bot im.
    const staffIdleTakeover = change.staffIdleTakeover === true && conversation.source !== 'comment';
    if (staffIdleTakeover) trace.staffIdle = { takeover: true, reason: String(change.staffIdleReason || staffIdleReason()) };
    if ((staffLabelled && staffRecently) || (!staffIdleTakeover && (staffAfterBot || (handoffLabelled && staffWithin2h)))) {
      // Vòng 12 (B4 #4): bình luận ĐẶT HÀNG/hỏi giá trong lúc nhân viên đang chat hộp thư: không để bình luận trơ trọi
      // (35 phút không ai trả lời) — lời công khai ngắn "bạn phụ trách nhắn mình ngay" + thẻ cần người + ẩn SĐT.
      if (conversation.source === 'comment' && settings.responseMode === 'automatic' && message.type === 'text' && isOrderComment(message.text)) {
        const publicRecently = recent.some(item => item?.direction === 'outgoing' && Date.now() - (Number(item.createdAt) || 0) < 10 * 60 * 1000);
        await moderateBundledComments();
        const staffPublic = publicRecently ? null : renderChatbotReply({ template_id: 'COMMENT_PUBLIC_STAFF' }, templates, { customer: { gender: conversation.botGender || conversation.gender || '', name: conversation.name || '' } });
        for (const text of staffPublic?.templateId === 'COMMENT_PUBLIC_STAFF' ? pickVariant(staffPublic) : []) await sendMessage(conversation, { text }).catch(error => console.warn(`Lời công khai (NV đang xử lý) lỗi (${conversation.id}): ${error.message}`));
        // Không đổi botLastReplyAt: tin nhân viên trước mốc đó vẫn phải được tính là 'nhân viên đang xử lý' ở lượt sau.
        await saveBotState(conversation.id, { addLabelEvents: ['handoff'] }).catch(() => {});
        // R14 (bình luận C3, ca …330895 chờ ~20 giờ): nhân viên làm ở HỘP THƯ (bot hộp thư do nhân viên tắt) không thấy thẻ của
        // luồng bình luận → gắn thẻ cần người + ghi chú nội dung bình luận vào hộp thư của khách để bạn phụ trách nhắn đúng lời hứa.
        if (conversation.pageId && conversation.psid) {
          const inboxId = `${conversation.pageId}:${conversation.psid}`;
          await Promise.resolve(saveBotState(inboxId, { addLabelEvents: ['handoff'] })).catch(() => {});
          const said = String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
          await noteForStaff(dependencies, inboxThread || { id: inboxId, pageId: conversation.pageId, psid: conversation.psid }, `Khách vừa bình luận dưới bài (bot đã hứa công khai "bạn phụ trách sẽ nhắn tin ngay"): "${said}". Nhân viên nhắn khách trong hộp thư này.`, 'bình luận khi nhân viên đang xử lý');
        }
        results.push({ conversationId: conversation.id, skipped: 'nhân viên đang xử lý', ...(staffPublic ? { publicNotice: true } : {}) });
        return;
      }
      // Hộp thư, không phải khiếu nại/bảo hành, khách vừa gửi tin đặt hàng: hẹn kiểm lại — nhân viên im 5 phút thì bot nhận đơn.
      if (conversation.source !== 'comment' && !(staffLabelled && staffRecently) && !staffIdleTakeover && message.type === 'text'
        && bundle.some(item => isOrderishText(item?.text) || commentBasket(String(item?.text || '')).length > 0)) {
        const idleMs = Number(dependencies.staffIdleMs ?? staffIdleDelayMs());
        if (scheduleStaffIdleRecheck(conversation.id, idleMs, () => staffIdleRecheck(conversation.id, dependencies, idleMs))) trace.staffIdle = { scheduled: true, inMs: idleMs };
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
      // R15 (bình luận A2, ca …540695): bot vừa báo "bạn phụ trách trả lời" (STAFF_WAIT_*, < 30 phút) mà nhân viên chưa nhắn —
      // khách nói tiếp cùng chuyện ("Nhưng giờ mua, chốt đơn thấy không ghi vào nữa nên c hỏi lại") → im + thẻ, không để mô hình
      // hứa "đã ghi chú vào đơn và báo kho". Tin mang việc mới (SĐT, địa chỉ, chọn túi/số lượng, hỏi giá, hủy) vẫn xử lý như thường.
      // R15-fix3 (phản biện C2/T1): tin nói gộp/tách/đơn mới/lên đơn/chốt/đặt/mua/lấy, STK/chuyển khoản, địa chỉ (ấp, khu phố, TP…),
      // ghi chú giao hàng, hay trả lời câu gộp/tách ("thôi khỏi") cũng là việc mới — xử lý như thường, không im.
      // Tin nối tiếp câu hỏi cũ ("… nên c hỏi lại", "sao chưa ghi") vẫn im dù có chữ mua/chốt — chỉ thông tin cứng (số, SĐT, giỏ,
      // tên túi, địa chỉ, hủy) mới cho qua.
      const staffWaitText = foldVietnamese(String(change.message?.text || '')).replace(/[,;:.!…]+/g, ' ').replace(/\s+/g, ' ');
      // R15-fix4 (phản biện M9): lời than / giục tiếp ("c đặt từ hôm qua rồi mà", "lâu vậy em, c đang chờ mua đây", "ủa c muốn lấy
      // mà sao im vậy", "c chốt rồi mà, quà đâu em") có chữ đặt/mua/lấy/chốt nhưng vẫn là cùng chuyện đang chờ → im + thẻ.
      const asksAgain = /\b(?:hoi lai|nen (?:c|chi|minh|e|em|a|anh|t|toi) hoi|sao (?:chua|khong|ko|k)|van chua|chua (?:thay|ghi|tra loi|rep)|(?:khong|ko|k|khoing|hong) (?:thay )?ghi)\b/.test(staffWaitText)
        || /\b(?:roi ma|sao im|im (?:vay|the|luon|re)|lau (?:vay|the|qua|z|v)|(?:qua|don|hang) dau|dau (?:em|e|shop|vay|v|roi|r|a|het)|tu hom qua|hom qua roi|chua (?:nhan|giao|thay don))\b/.test(staffWaitText);
      // R15-fix4: đang chờ câu trả lời gộp/tách — câu trả lời RÕ (readMergeSplitReply) là việc mới; câu khác để khối gộp/tách xử lý
      // (đã báo bạn phụ trách → im + thẻ).
      const newBusiness = !asksAgain && (/\b(?:goi|tropical|mix|ap|kp|khu pho|tp|thanh pho|thi tran|so nha|ngo|hem|gop|ghep|tach|rieng|don moi|don khac|len don|chot|dat|mua|lay|stk|so tk|tai khoan|chuyen khoan|ck|thanh toan)\b/.test(staffWaitText)
        || DELIVERY_NOTE.test(staffWaitText) || Boolean(conversation.pendingOrder?.awaitingConfirm && readMergeSplitReply(change.message?.text)));
      if (String(conversation.botLastTemplateId || '').startsWith('STAFF_WAIT_') && waitingAge < 30 * 60 * 1000 && change.message?.type === 'text'
        && !extractVietnamesePhone(String(change.message?.text || '')) && !change.message?.cart?.length
        && !/\d|\b(?:tui|bich|bit|hop|combo|xanh|vang|nau|cacao|gia|bao nhieu|bn|huy|dia chi|phuong|xa|quan|huyen|tinh|duong|thon|xom)\b/.test(staffWaitText)
        && !newBusiness) {
        await saveBotState(conversation.id, { addLabelEvents: ['handoff'], ...(change.message?.id || change.message?.mid ? { botHandledMessageId: String(change.message.id || change.message.mid) } : {}) }).catch(() => {});
        results.push({ conversationId: conversation.id, skipped: 'đang chờ bạn phụ trách trả lời' });
        return;
      }
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
    const greetingOnly = /^(hi|hello|helo|alo|a lo|chao|xin chao|chao (shop|em|ban|chi|anh)|(shop|em|chi|ad|admin|ban) (oi|ơi)|oi|[.…]+)[.!\s]*$/i.test(foldVietnamese(shortText));
    // R16 (inbox2 C2): tin chỉ "." / "…" cũng là lời gọi — câu hỏi thật tới sau 6–9 giây (đã thêm vào greetingOnly).
    // SĐT rồi địa chỉ (hay ngược lại) thường là hai tin liền nhau: tin chỉ SĐT ("sđt 09…", "0909… nha")
    // và tin chỉ địa chỉ (có xã/phường/quận/đường…) cũng đợi để gộp — trước đây bot gửi
    // ORDER_ADDRESS_PARTIAL rồi ORDER_CONFIRMATION cùng phút. Tin chỉ SĐT đợi lâu gấp đôi.
    const phoneFragment = message.type === 'text' && Boolean(extractVietnamesePhone(shortText)) && shortText.replace(/\+?\d[\d .-]{8,13}/g, ' ').replace(/\s+/g, ' ').trim().length < 40;
    const addressFragment = message.type === 'text' && shortText.length < 160 && /\b(xa|huyen|quan|phuong|thi tran|thi xa|tp|thanh pho|duong|thon|xom|tinh|ap|kp|khu pho|so nha|ngo|hem|to)\b/.test(foldVietnamese(shortText))
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
      // R14 (inbox3 L1, inbox2 M9: 4 + 3 ca): tin CHỈ địa chỉ (chưa kèm SĐT) chờ lâu như tin chỉ SĐT (8 giây) — khách gửi địa chỉ
      // và SĐT thành hai tin cách nhau ~5–20 giây, bot từng chen câu "đã nhận địa chỉ, xin SĐT" ngay trước phiếu xác nhận.
      const addressOnly = addressFragment && !phoneFragment && !extractVietnamesePhone(shortText);
      const fragmentWaitMs = Number(settings.phoneFragmentWaitMs ?? baseWaitMs * 2);
      // R15 (inbox3 A8: …797807 15 giây, …541740 12 giây): đang GIỮ GIỎ mà tin chỉ có SĐT hay chỉ có địa chỉ → phần kia thường tới
      // sau 8–15 giây; chờ 12 giây (gấp 1,5 lần mức chờ SĐT) để không xin lại thứ khách vừa gửi.
      const heldBasketNow = Boolean(usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items?.length);
      // R15 (inbox1 A1): bot vừa hỏi vị khi khách đã nói "N túi" (N ≥ 2), tin trả lời chỉ một vị → vị thứ hai hay tới ngay sau.
      const flavourAfterCount = ['ASK_FLAVOR', 'ORDER_INFO_ASK_FLAVOR'].includes(conversation.botLastTemplateId) && Number(conversation.pendingOrder?.askedBagCount) >= 2
        && singleFlavourOf(shortText) !== '';
      const waitMs = (phoneFragment || addressOnly) && heldBasketNow ? Math.round(fragmentWaitMs * 1.5)
        : phoneFragment || addressOnly || flavourAfterCount ? fragmentWaitMs : baseWaitMs;
      await new Promise(resolve => setTimeout(resolve, waitMs));
      if (hasNewerCustomerMessage(await listMessages(conversation.id), change.message)) {
        results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
        return;
      }
    }
    // R15 (inbox4 A4, ca …905690 [tệp] rồi 11 giây sau "Giá bao nhiêu vậy?", …885410 [ảnh] rồi "Bn 1 túi này e ơi"): ảnh / video /
    // tệp ở hộp thư chờ ~12 giây — chữ của khách thường tới ngay sau. Có tin mới thì bỏ lượt ảnh; lượt chữ trả lời theo chữ và
    // mang ngữ cảnh ảnh (withImage + thẻ cho nhân viên xem ảnh), không "đã nhận hình, cần hỗ trợ gì".
    const mediaTurn = conversation.source !== 'comment' && !['text', 'sticker', 'ad', 'order-receipt'].includes(String(change.message.type || 'text'));
    const mediaWaitMs = Number(settings.mediaWaitMs ?? (process.env.NODE_TEST_CONTEXT ? 0 : 12000));
    // R15-fix3 (phản biện T2): ngay sau thông tin thanh toán (PAYMENT_METHODS / BANK_TRANSFER < 60 phút) hay khách vừa nói chuyển
    // khoản (< 10 phút), ảnh là BILL → không chờ: báo đã nhận bill (PAYMENT_RECEIVED_CHECK) như bản cũ; "ok" / "e gửi nha" theo sau
    // xử lý như trước khi có bước chờ ảnh.
    const billContext = mediaTurn && (['BANK_TRANSFER', 'PAYMENT_METHODS'].includes(conversation.botLastTemplateId) && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 60 * 60 * 1000
      || recent.some(item => item?.direction === 'incoming' && item?.type === 'text' && Date.now() - (Number(item.createdAt) || 0) < 10 * 60 * 1000
        && /\b(?:ck|chuyen khoan|chuyen tien|thanh toan|stk|so tai khoan|bill)\b/.test(foldVietnamese(String(item.text || '')))));
    if (mediaTurn && mediaWaitMs > 0 && !billContext) {
      await new Promise(resolve => setTimeout(resolve, mediaWaitMs));
      if (hasNewerCustomerMessage(await listMessages(conversation.id).catch(() => recent), change.message)) {
        results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
        return;
      }
    }
    // Bot vừa hỏi số lượng/vị/SĐT/địa chỉ thì "1", "?"… là câu trả lời, không phải xin giá.
    const collectingOrder = isOrderStep(conversation.botLastTemplateId) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(conversation.botLastTemplateId);
    // R15 (inbox3 A10, ca …179261): "Ibox" như "ib".
    const terse = message.type === 'text' && !collectingOrder && /^(\.+|…|ib|ibox|inbox|in box|bn|gia|xin gia|gia bao nhieu|bao nhieu|bao gia|cho hoi gia|gia sao|gia the nao|gia ntn|\?|\+1|1|\.ib|ib\.)$/i.test(folded);
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
    // R16 (inbox5 A6, ca …0443120175): tin nhắn THOẠI không phải ảnh — bot không nghe được: xin khách nhắn chữ (VOICE_RECEIVED;
    // mẫu chưa có trong Cài đặt thì dùng lời dự phòng, mẫu trống = tắt) + thẻ Cần người xử lý. Không bị nuốt bởi "ảnh liền nhau".
    const voiceReply = message.type === 'audio' && conversation.source !== 'comment' ? (() => {
      const voiceTemplates = templates && Object.hasOwn(templates, 'VOICE_RECEIVED') ? templates : { ...(templates || {}), VOICE_RECEIVED: VOICE_RECEIVED_FALLBACK };
      if (!String(voiceTemplates.VOICE_RECEIVED || '').trim()) return null;
      const voice = renderChatbotReply({ template_id: 'VOICE_RECEIVED' }, voiceTemplates, replyContext);
      return voice.templateId === 'VOICE_RECEIVED' && voice.messages?.length ? { ...voice, attention: true } : null;
    })() : null;
    if (nonText && conversation.botLastTemplateId === 'IMAGE_RECEIVED' && !voiceReply) {
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
    if (nearbyTexts.length && !imageAfterPaidText && !voiceReply && conversation.source !== 'comment') {
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
    // R14 (inbox1 N3, ca …764130: 4 lần bấm → 8 túi 1.187.000đ): khách bấm giỏ Shop nhiều lần liền nhau là CHỌN LẠI, không
    // cộng dồn. Chỉ lấy giỏ CUỐI (shopCartOfBundle); các lần bấm khác nhau → giỏ cuối + thẻ cần người xem.
    const shopBundle = message.cart?.length ? shopCartOfBundle(bundle, change.message) : null;
    const cartReply = shopBundle?.lines?.length ? (() => {
      const quick = cartQuickReply(shopBundle.lines, templates, replyContext);
      return quick && shopBundle.differs ? { ...quick, attention: true } : quick;
    })() : null;
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
    // R14 (chủ shop 03/10, quyết định 8): chỉ 1/33 giỏ Shop tìm thấy đơn POS trong lúc chờ 60 giây → chờ 20 giây
    // (SHOP_ORDER_WAIT_MS); đơn POS vào muộn hơn thì lượt tra nền (followUpShopOrder) báo "đã nhận đơn". Cài đặt vẫn đặt được.
    const shopWaitMs = Number(settings.shopOrderWaitMs ?? (process.env.NODE_TEST_CONTEXT ? 0 : SHOP_ORDER_WAIT_MS));
    // R13 (inbox1 C8): không để khách chờ 60 giây im lặng — gửi NGAY một tin ngắn ghi nhận giỏ rồi mới chờ kiểm đơn; giỏ
    // được giữ luôn (khách gửi SĐT trong lúc chờ thì lượt sau đã có giỏ, không hỏi lại vị). Sau khi chờ: có đơn POS → "đã
    // nhận đơn, không cần gửi SĐT"; không có → mới xin SĐT/địa chỉ. Không còn cặp "xin SĐT" rồi "không cần gửi lại SĐT"
    // trong 60 giây đầu. Chỉ với giỏ bot đọc được (bước xin SĐT/địa chỉ), chế độ tự động.
    // R15: lượt chạy lại sau khởi động — ack đã gửi ở lượt bị cắt ngang: không gửi lại, đi thẳng bước kiểm đơn / xin SĐT.
    let cartAckSent = resumeShopCart && Boolean(cartReply);
    if (resumeShopCart) console.log(`Giỏ Shop chạy lại sau khởi động: bỏ tin ack, kiểm đơn / xin SĐT (${conversation.id})`);
    // R15-fix3 (phản biện T5): khách bấm lại ĐÚNG giỏ đang giữ (cùng khoá, bot trả lời < 30 phút) → không gửi ack / không ghi đè
    // mẫu cuối, để bước sameCartAgain bên dưới nhắc giỏ một lần rồi im (trước đây ack ghi ORDER_ADDRESS nên bước đó không bao giờ chạy).
    const heldCartKey = String(usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.key || '');
    const sameCartEarly = Boolean(cartReply) && !resumeShopCart && Boolean(heldCartKey) && String(cartReply?.pendingOrder?.key || '') === heldCartKey
      && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 30 * 60 * 1000;
    if (!cartAckSent && !sameCartEarly && canFindShopOrder && !shopOrder && shopWaitMs > 0 && settings.responseMode === 'automatic' && cartReply.templateId === 'ORDER_ADDRESS'
      && cartReply.pendingOrder?.items?.length && templates?.SHOP_CART_ACK) {
      // R13 sửa (phản biện T3): khách bấm "Mua" hai lần liền (hai tin giỏ cách nhau vài giây) → tin ack đầu nói giỏ cũ rồi tin ack
      // sau nói giỏ khác. Chờ một nhịp ngắn (≤ 2 giây) và kiểm tin mới hơn NGAY TRƯỚC khi ack: có giỏ mới hơn thì nhường, lượt
      // của giỏ cuối ack một lần đúng giỏ cuối.
      await wait(Math.min(2000, Math.max(0, Math.round(shopWaitMs / 3))));
      if (hasNewerCustomerMessage(await listMessages(conversation.id).catch(() => recent), change.message)) {
        results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
        return;
      }
      const ack = renderChatbotReply({ template_id: 'SHOP_CART_ACK', values: { cart: cartReply.pendingOrder.items.map(item => `${item.quantity} ${item.product}`).join(' + ') } }, templates, replyContext);
      if (ack.templateId === 'SHOP_CART_ACK') {
        for (const text of ack.messages) await sendMessage(conversation, { text });
        await saveBotState(conversation.id, { botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now(), pendingOrder: cartReply.pendingOrder,
          // R15 (inbox1 A9): mốc "đã ack, đang chờ kiểm đơn" — khởi động lại giữa chừng thì backlog chạy tiếp lượt này; xoá khi lượt xong.
          shopCartAckPendingAt: Date.now(), shopCartAckMessageId: String(change.message?.id || change.message?.mid || '') }).catch(() => {});
        cartAckSent = true;
      }
    }
    // (Giỏ nhân viên lên đơn / mã lạ không chờ: lời "bạn phụ trách nhắn lại" đi ngay; đơn POS thấy sau thì lượt tra nền báo.)
    for (let waited = 0; canFindShopOrder && !shopOrder && !cartReply.shopCartStaff && !sameCartEarly && waited < shopWaitMs; waited += 20000) {
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
    // R14 (dl P9, ca …764130): "Ok thông tin chuẩn r nhé" ngay sau tin xác nhận đơn là lời xác nhận — mô hình chọn THANK_YOU
    // nhưng bị bác ("không phải lời cảm ơn") nên khách chờ 14 giờ. Câu toàn từ xác nhận (ok/chuẩn/đúng rồi/thông tin…), không
    // số, không sửa/hủy/hỏi → cảm ơn luôn.
    const confirmAck = message.type === 'text' && orderJustClosed && !/\d|\?/.test(String(message.text || '')) && (() => {
      const words = folded.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
      return words.length > 0 && words.length <= 8 && words.some(word => ['ok', 'oke', 'okie', 'oki', 'okay', 'chuan', 'dung', 'chinh', 'xac'].includes(word)) && words.every(word => confirmAckWords.has(word));
    })();
    const ackReply = (shortAck || confirmAck) && orderJustClosed && templates?.THANK_YOU
      ? renderChatbotReply({ template_id: 'THANK_YOU' }, templates, replyContext)
      : null;
    // Giỏ đang giữ (còn hạn) và bot vừa ở bước đơn.
    const basketHeld = Boolean(usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items?.length);
    // R13: bộ soạn mẫu biết khách đã có đơn (24 giờ, chưa hủy) — mẫu quà mời đặt đổi sang câu nói quà của chính đơn đó.
    // Đang giữ GIỎ MỚI sau đơn thì vẫn là lời mời/quà của giỏ mới.
    replyContext.hasOrder = hasOrder && !basketHeld;
    // R13 sửa (phản biện C1): "đổi quà / không lấy quà" chỉ có nghĩa khi giỏ đang giữ (hay đơn gần nhất, không giữ giỏ mới) THỰC
    // SỰ có quà hiện vật đổi được (bát, muỗng, quạt — catalog.isSwappableGift). Giỏ 1–2 túi khách thường chỉ có miễn ship:
    // bot từng hứa "thay bằng 2 gói nhỏ", rồi "nâu" / "đổi sang nâu" bị ghi là chọn quà (khách muốn đổi VỊ TÚI) mà đơn không có
    // gói nhỏ nào. null = chưa có giỏ/đơn để xét (giữ lời GIFT_SWAP chung).
    const giftSwapApplies = (() => {
      const swappable = items => {
        const priced = priceBasket(items, { livestream: replyContext.livestream || conversation.pendingOrder?.livestream === true });
        return priced.priceable && (priced.gifts || []).some(isSwappableGift);
      };
      const held = basketHeld ? usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items || [] : [];
      if (held.length) return swappable(held.map(item => ({ sku: item.code, product: item.product, quantity: item.quantity })));
      if (!hasOrder || !recentOrder?.id) return null;
      const lines = Array.isArray(recentOrder.products) ? recentOrder.products.filter(item => item && (item.sku || item.code || item.name || item.product)) : [];
      if (lines.length) return swappable(lines.map(item => ({ sku: item.sku || item.code, product: item.name || item.product, quantity: Number(item.quantity) || 1 })));
      return /\b(bat|quat|muong|thia)\b/.test(foldVietnamese(String(recentOrder.gift || '')));
    })();
    // Bộ soạn mẫu (GIFT_POLICY → GIFT_SWAP khi tin xin đổi quà) cũng cần biết để giữ GIFT_POLICY.
    replyContext.giftSwappable = giftSwapApplies;
    const orderStepLast = isBasketStep(conversation.botLastTemplateId) || conversation.botLastTemplateId === 'PRICE_ONE_BAG';
    // Lời "có/ok/gửi đi" sau khi bot hỏi "cần bảng giá combo gói nhỏ không?" (PACKAGING_INFO):
    // gửi bảng giá Combo 10 gói theo màu khách đang nói (mặc định Xanh), không hỏi mô hình.
    const ackCore = folded.replace(/[.!?…,]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/(?: (?:a|nha|nhe|shop|em|e|c|chi|anh|di|voi|luon))+$/, '');
    const yesAck = shortAck || (ackCore.length > 0
      // R14 (inbox1 C4, ca …029290): "Cần e" (đáp "cần bảng giá combo gói nhỏ không?") cũng là đồng ý.
      && /^(?:(?:ok|oke|okie|okay|oki|da|vang|co|can|duoc|dc|u|uh|ua)\s*)*(?:(?:gui|xin|cho xin|cho|xem|coi)\s*)?(?:(?:di|em|minh|luon|bang gia|thu|coi|xem|cho (?:em|minh|chi|c|a|anh))\s*)*$/.test(ackCore));
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
    // R14 (inbox3 S1, ca …762063): bot hỏi "đặt thêm?" rồi gửi tin khác xen giữa (bảng giá Tropical…) — "Ok" của khách không còn
    // được tính là đồng ý vì chỉ xét mẫu bot gửi CUỐI → bot cảm ơn rồi thôi, không có đơn. Nay dựa vào cờ chờ xác nhận còn hạn
    // 30 phút (pendingOrder.awaitingConfirm, pendingOrder.at = lúc hỏi), không dựa vào tin cuối của bot.
    const awaitingAsked = Boolean(conversation.pendingOrder?.awaitingConfirm) && (conversation.botLastTemplateId === 'ORDER_EXISTING_CONFIRM'
      || Date.now() - (Number(conversation.pendingOrder?.at) || 0) < 30 * 60 * 1000);
    const awaitingPending = awaitingAsked ? usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' }) : null;
    // Đã hỏi "đặt thêm?" trong 30 phút (pendingOrder.at là lúc hỏi): không hỏi lại lần hai trong cùng
    // hội thoại — khách nhắn tin khác có/không thì xử lý bình thường, giữ cờ chờ (log: hỏi 2 lần trong 4 phút).
    const awaitingRecent = Boolean(conversation.pendingOrder?.awaitingConfirm) && Date.now() - (Number(conversation.pendingOrder?.at) || 0) < 30 * 60 * 1000;
    // R15-fix4 (chủ shop 03/10: "hỏi khách gộp hay tách, làm theo khách, khách không quyết được → nhân viên"). Thay cách đọc
    // từng biến thể (readMergeSplitAnswer / splitByInfo / reasked / "không" kể đơn cũ / "thôi khỏi" bỏ giỏ — đã sinh lỗi 3 vòng:
    // "đừng tách" thành tách, "tách gửi mẹ" dùng địa chỉ cũ, "hủy đơn cũ, lên đơn mới" thành hai đơn, im ↔ hỏi lại xen kẽ…).
    // Bot CHỈ tự làm khi câu trả lời NGẮN VÀ RÕ (readMergeSplitReply):
    // - 'merge' ("gộp", "ghép chung", "gửi/giao/ship chung", "gộp vào đơn cũ"…) → đơn bot ≤ 60 phút: cộng vào đơn; quá 60 phút:
    //   ghi chú ghép cho nhân viên (ORDER_CHANGE_STAFF); đơn ngoài hội thoại: bạn phụ trách;
    // - 'split' ("tách", "đơn mới", "đơn riêng", "lên đơn mới", "(ok) đặt thêm"…) → đơn mới, SĐT + địa chỉ của giỏ chờ / đơn cũ;
    // - tin có SĐT + địa chỉ ĐẦY ĐỦ, địa chỉ KHÁC đơn cũ, không có chữ gộp/ghép/chung/hủy/đổi/không/đừng/khỏi/"?" → tách với thông
    //   tin mới (luồng đơn thường; đơn ra phải đúng SĐT trong tin và không mang địa chỉ cũ, không thì bạn phụ trách);
    // - 'yes' ("đúng/ok/vâng/ừ/dạ/đúng rồi"…): mẫu ORDER_EXISTING_CONFIRM đang chạy còn LỜI CŨ ("… nhắn "đúng" là em lên đơn"), hay
    //   mẫu đơn ngoài ORDER_EXISTING_CONFIRM_PHONE (cũng "nhắn đúng") → tách như bản cũ (an toàn C2); lời mới (hỏi gộp/tách) → mơ hồ;
    // - MỌI câu khác (phủ định, câu hỏi, "tùy", "hủy", tên món/số túi, SĐT hay địa chỉ thiếu, "gửi mẹ" không kèm địa chỉ…) → bạn
    //   phụ trách (STAFF_WAIT_*) + thẻ, giỏ mới GIỮ NGUYÊN, không tạo/sửa/hủy đơn. STAFF_WAIT chỉ gửi MỘT lần cho giỏ chờ này
    //   (cờ staffAsked); lượt sau trong lúc chờ: im + thẻ, trừ câu rõ như trên → làm theo. Không bao giờ hỏi lại gộp/tách.
    const awaitingMessage = change.message && typeof change.message === 'object' ? { ...change.message, type: message.type } : message;
    const awaitingTextRaw = String(awaitingMessage.text || '');
    const awaitingTextual = Boolean(awaitingPending) && message.type === 'text' && conversation.source !== 'comment';
    const mergeSplitKind = awaitingTextual ? readMergeSplitReply(awaitingTextRaw) : '';
    const awaitingOrderRef = recentOrder?.id && isActiveOrder(recentOrder) ? recentOrder : null;
    const legacyExistingAsk = (() => {
      // Câu hỏi đơn NGOÀI hội thoại dùng ORDER_EXISTING_CONFIRM_PHONE (lời "nhắn đúng") khi có mẫu đó.
      // (usablePendingOrder bỏ trường externalOrder — đọc trên giỏ chờ gốc.)
      if (conversation.pendingOrder?.externalOrder && !awaitingOrderRef && templates?.ORDER_EXISTING_CONFIRM_PHONE) return true;
      // R16 (inbox4 H1): đơn đang có không gộp được → bot đã hỏi bằng lời cũ "đặt thêm đúng không" (cờ addOnlyAsk).
      if (conversation.pendingOrder?.addOnlyAsk) return true;
      const asked = foldVietnamese(String(templates?.ORDER_EXISTING_CONFIRM || ''));
      return /\bnhan\b/.test(asked) && /\bdung\b/.test(asked) && !/\b(?:gop|tach)\b/.test(asked);
    })();
    const squashInfo = value => foldVietnamese(String(value || '').replace(/^\((?:live|freeship)\)\s*/i, '')).replace(/[^a-z0-9]+/g, '');
    const knownAwaitAddresses = [awaitingPending?.address, awaitingOrderRef?.rawAddress, awaitingOrderRef?.address].map(squashInfo).filter(value => value.length >= 8);
    const sameAsKnownAddress = value => { const typed = squashInfo(value); return typed.length > 0 && knownAwaitAddresses.some(known => known.includes(typed) || typed.includes(known)); };
    const awaitingPhoneNow = awaitingTextual ? extractVietnamesePhone(awaitingTextRaw) : '';
    const awaitingAddressText = awaitingPhoneNow ? stripPhone(awaitingTextRaw).trim() : '';
    // Tách bằng thông tin mới: SĐT + địa chỉ đầy đủ (describeDeliveryAddress) khác đơn cũ, không chữ phủ định/gộp/hủy/đổi/câu hỏi.
    const splitByNewInfo = awaitingTextual && !mergeSplitKind && Boolean(awaitingPhoneNow) && awaitingAddressText.length <= 500
      && !mergeSplitBlockWords(awaitingTextRaw) && describeDeliveryAddress(awaitingAddressText).complete && !sameAsKnownAddress(awaitingAddressText);
    const awaitingYes = mergeSplitKind === 'yes';
    const awaitingNo = false;
    // Sau khi đã báo bạn phụ trách (staffAsked), "ok/ừ/vâng" là đáp lời "chờ em chút" — không còn là đồng ý câu hỏi cũ.
    const awaitingSplit = mergeSplitKind === 'split' || (awaitingYes && legacyExistingAsk && !conversation.pendingOrder?.staffAsked);
    const awaitingMerge = mergeSplitKind === 'merge';
    const awaitingUnclear = awaitingTextual && !awaitingSplit && !awaitingMerge && !splitByNewInfo;
    const staffWaitReply = () => {
      const wait = staffWaitTemplate();
      const staff = renderChatbotReply({ template_id: wait.templateId, values: { when: wait.when } }, templates, replyContext);
      return staff.templateId === wait.templateId
        ? { ...staff, attention: true, staffWait: true, order: undefined, pendingOrder: { ...(conversation.pendingOrder || {}), awaitingConfirm: true, staffAsked: true, at: Date.now() } }
        : null;
    };
    // Đã báo bạn phụ trách cho giỏ chờ này: câu không rõ tiếp theo → im + thẻ (không gửi STAFF_WAIT lần hai, không hỏi lại).
    if (awaitingUnclear && conversation.pendingOrder?.staffAsked) {
      console.log(`Đang chờ bạn phụ trách (câu gộp/tách chưa rõ): im + thẻ (${conversation.id})`);
      await saveBotState(conversation.id, { addLabelEvents: ['handoff'], ...(change.message?.id || change.message?.mid ? { botHandledMessageId: String(change.message.id || change.message.mid) } : {}) }).catch(() => {});
      results.push({ conversationId: conversation.id, skipped: 'đang chờ bạn phụ trách (gộp/tách)' });
      return;
    }
    const pendingValue = pending => {
      const slots = ['Product_N1', 'No_A', 'Product_N2', 'No_B', 'Product_N3', 'No_C'];
      const value = {};
      (pending?.items || []).slice(0, 3).forEach((item, index) => { value[slots[index * 2]] = item.product; value[slots[index * 2 + 1]] = String(Number(item.quantity) || 1); });
      return value;
    };
    const mergeReply = awaitingMerge ? (() => {
      if (!awaitingOrderRef || conversation.pendingOrder?.externalOrder) return staffWaitReply();
      // Chữ soạn đơn nêu rõ món thêm ("ghép vào đơn thêm 1 Granola Túi Vàng 350g") để bộ soạn cộng đúng món vào đơn cũ.
      const addedText = (awaitingPending.items || []).map(item => `${Number(item.quantity) || 1} ${item.product}`).join(' và ');
      const merged = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', ...pendingValue(awaitingPending) }, templates, { ...replyContext, pendingOrder: null, messageText: `ghép vào đơn thêm ${addedText}` });
      if (merged.order?.updateOrderId || merged.templateId === 'ORDER_CHANGE_STAFF') {
        console.log(`Khách chọn GỘP vào đơn ${awaitingOrderRef.id}: ${merged.templateId} (${conversation.id})`);
        return { ...merged, pendingOrder: null };
      }
      return staffWaitReply();
    })() : null;
    const splitReply = awaitingSplit ? (() => {
      const phone = awaitingPending.phone || awaitingOrderRef?.phone || '';
      const address = awaitingPending.address || awaitingOrderRef?.rawAddress || awaitingOrderRef?.address || '';
      const created = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', ...pendingValue(awaitingPending), Phone_Number: phone || '0', Customer_Address: String(address).replace(/^\((?:live|freeship)\)\s*/i, '') || '0' }, templates, { ...replyContext, messageText: 'tách đơn mới' });
      console.log(`Khách chọn TÁCH đơn mới (dùng lại SĐT/địa chỉ đơn cũ): ${created.templateId} (${conversation.id})`);
      return created;
    })() : null;
    if (awaitingUnclear) console.log(`Câu trả lời gộp/tách chưa rõ ("${awaitingTextRaw.slice(0, 40)}"): bạn phụ trách, giữ giỏ (${conversation.id})`);
    const existingConfirmReply = mergeReply || splitReply || (awaitingUnclear ? staffWaitReply() : null);
    // Ngay sau bảng giá một sản phẩm, "dùng thử" / "combo 2" / "3 túi" là khách đã
    // chọn: lên bước xin SĐT/địa chỉ với đúng sản phẩm vừa báo giá. Mô hình hay
    // gửi lại bảng giá vì chữ "dùng thử" có sẵn trong bảng (khách bỏ đi).
    const quoteAge = Date.now() - (Number(conversation.botLastReplyAt) || 0);
    // R15 (inbox4 A6, ca …653811): bảng giá bot ĐOÁN từ ảnh khách gửi (ảnh → PRICE_QUOTE Túi Vàng) không phải "sản phẩm vừa báo
    // giá" để "1 túi" chọn luôn — khách muốn Túi Xanh. Chỉ tính bảng giá trả lời TIN CHỮ (tin khách ngay trước bảng giá có chữ).
    const quoteAnsweredText = (() => {
      const quoteIndex = recent.findLastIndex(item => item?.direction === 'outgoing' && /Bảng giá (.+?) để/u.test(String(item.text || '')));
      if (quoteIndex < 0) return false;
      let index = quoteIndex - 1;
      while (index >= 0 && recent[index]?.direction === 'outgoing') index -= 1;
      const asked = [];
      for (; index >= 0 && recent[index]?.direction === 'incoming'; index -= 1) asked.push(recent[index]);
      // Không thấy tin khách nào (lịch sử ngắn / tin chào QC) → như trước (tính).
      if (!asked.length) return true;
      return asked.some(item => (item.type || 'text') === 'text' && String(item.text || '').trim() && !isShopCartText(item.text));
    })();
    const quotedName = !nonText && quoteAnsweredText && (conversation.botLastTemplateId === 'PRICE_QUOTE' || (conversation.botLastTemplateId === 'GENERAL_INFO' && recent.some(item => item?.direction === 'outgoing' && /Bảng giá (.+?) để/u.test(String(item.text || '')) && Date.now() - (Number(item.createdAt) || 0) < 30 * 60 * 1000))) && quoteAge < 30 * 60 * 1000
      ? [...recent].reverse().filter(item => item?.direction === 'outgoing').map(item => String(item.text || '').match(/Bảng giá (.+?) để/u)?.[1]).find(Boolean) || ''
      : '';
    const quoted = quotedName ? matchProduct(quotedName) : null;
    const choice = folded.trim().replace(/[.!]+$/, '').replace(/(\s+(nha|nhe|a|shop|em|e|nha shop|nhe shop|luon|di))+$/, '');
    const lead = '^(?:(?:cho|lay|dat|gui|ship|mua)\\s+)?(?:(?:em|minh|chi|c|e|a|anh|to|tui)\\s+)?(?:(?:lay|dat|mua)\\s+)?';
    const chosenQuantity = !quoted ? 0
      : new RegExp(`${lead}(?:(?:1|mot)\\s+(?:tui|goi|bich|hop)\\s+)?(?:dung thu|lay thu|an thu|mua thu)$`).test(choice) ? 1
        // 03/10 (ca Giáng Hương): bảng giá Túi Xanh vừa gửi → "1 goi" / "1 túi" là chọn 1 túi loại vừa báo; trước đây bot hỏi lại vị.
        : new RegExp(`${lead}(?:1|mot)\\s*(?:tui|goi|bich|hop)(?:\\s+(?:thoi|truoc|da))?$`).test(choice) ? 1
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
      && !/\?|\b(huy|doi|them|nua|bot|sua|lay|dat|mua|dia chi|sdt|so dien thoai|khong lay|chua nhan|bi loi|bi hu|khi nao|bao gio|duoc khong|dc khong|ko|khong)\b/.test(folded)
      // R16 (inbox1 B5, ca …7899534005 "Kiểm tra hàng mới tt nha chị"): "kiểm tra hàng (rồi) mới thanh toán / đồng kiểm" là hỏi
      // KIỂM HÀNG khi nhận (INSPECTION_RETURN_POLICY), không phải lời dặn "hàng mới".
      && !/\b(?:kiem tra|kiem|xem|check) hang\b|\bdong kiem\b|\b(?:moi|roi|xong) (?:tt|thanh toan|tra tien)\b/.test(folded);
    const noteReply = deliveryNote ? renderChatbotReply({ template_id: 'ORDER_NOTE' }, templates, replyContext) : null;
    // R13 (inbox1 A2): bot vừa hỏi "lấy 2 gói vị nào" (GIFT_SWAP, dưới 60 phút — conversation.giftSwapAskedAt) và khách chọn
    // vị ("2g nhỏ nâu đi shop", "1 xanh 1 cam", "cam"): ghi nhận quà thay, KHÔNG hỏi lại "vị nào". Đang giữ giỏ → lưu
    // pendingOrder.giftSwap (bộ soạn đơn đổi quà khi chốt) + nhắc giỏ; đã có đơn → ghi chú vào đơn như cũ; luôn gắn thẻ.
    // "2 túi xanh" (đặt túi lớn), câu hỏi, tin có SĐT không phải chọn quà.
    const giftSwapChoice = (() => {
      const askedAt = Number(conversation.giftSwapAskedAt) || 0;
      if (nonText || conversation.source === 'comment' || !askedAt || Date.now() - askedAt > 60 * 60 * 1000 || phoneInText || asksForHuman) return null;
      // R13 sửa (C1): giỏ/đơn không có quà hiện vật → không có quà để chọn vị; "nâu", "đổi sang nâu" là đổi vị túi (đường giỏ).
      if (giftSwapApplies === false) return null;
      if (shortText.length > 80 || /\?/.test(shortText) || /\b(gia|bao nhieu|bn)\b/.test(folded)) return null;
      // Màu kèm túi/bịch/hộp/combo/gói lớn là đặt túi lớn, không phải chọn vị quà (gói nhỏ / quà / "35g" mới là quà).
      if (/\b(tui|bich|hop|combo|goi (lon|to|bu))\b/.test(folded) && !/\b(goi nho|nho|qua)\b|\d ?g\b/.test(folded)) return null;
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
    // R15 (inbox2 A1, ca …111673 / …734430): lời chào live, bảng giá chung (danh sách vị) và câu miễn ship đều kết bằng "chọn
    // loại và số lượng / lấy 2 túi vị nào" — khách trả lời một vị sau đó cũng là trả lời câu hỏi vị: đếm số túi khách đã nêu
    // trước đó ("2 túi miễn ship k ạ" → "Mình có vị gì ạ" → "Túi xanh 450g" = 2 túi). Với 3 mẫu này được đọc lùi qua MỘT cụm
    // tin bot nữa (trong 15 phút) — số túi thường nằm hai lượt trước.
    const invitesFlavour = ['LIVESTREAM_COMMENT', 'GENERAL_INFO', 'FREESHIP_POLICY'].includes(conversation.botLastTemplateId);
    const askedBag = (() => {
      if (!['ASK_FLAVOR', 'ORDER_INFO_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN', 'RECOMMEND_BEGINNER'].includes(conversation.botLastTemplateId) && !invitesFlavour) return { count: 0, mixed: false };
      const lastAsk = recent.findLastIndex(item => item?.direction === 'outgoing');
      const before = [];
      // R13 (inbox2 B1): bot trả lời bằng HAI tin liền nhau (câu hỏi vị + câu kèm) thì tin ngay trước tin bot cuối cũng là tin
      // bot → trước đây dừng luôn, không thấy "Cho mình 2 túi nhé" → đơn còn 1 túi. Bỏ qua cả cụm tin bot liền nhau trước.
      let start = lastAsk - 1;
      while (start >= 0 && recent[start]?.direction === 'outgoing') start -= 1;
      let botBlocks = invitesFlavour ? 1 : 0;
      for (let index = start; index >= 0 && before.length < 3; index -= 1) {
        const item = recent[index];
        if (item?.direction === 'outgoing') {
          if (botBlocks <= 0 || Date.now() - (Number(item.createdAt) || 0) > 15 * 60 * 1000 || bagCountInText(before.join(' '))) break;
          botBlocks -= 1;
          while (index - 1 >= 0 && recent[index - 1]?.direction === 'outgoing') index -= 1;
          continue;
        }
        if (item?.direction === 'incoming' && item.type === 'text' && item.text) before.unshift(String(item.text));
      }
      const text = foldVietnamese(before.join(' '));
      return {
        count: bagCountInText(text) || Math.round(Number(conversation.pendingOrder?.askedBagCount) || 0),
        mixed: /\b\d\s*(?:vi|loai|mau)\b|\bkhac (?:vi|loai|nhau|mau)\b|\bmix\b|\bmoi (?:vi|loai|mau)\b/.test(text)
      };
    })();
    // ===== R15 (inbox1 A1, bình luận A1 — NGHIÊM TRỌNG): "N túi" rồi nêu từng vị trong từng tin riêng =====
    // Ca thật …5962076080: "Chốt chị 2tui" + SĐT + địa chỉ → bot hỏi vị → "Ca cao" (lên đơn 2 Nâu) → 11 giây sau "Túi vàng" →
    // mô hình ORDER_UPDATE sửa đơn thành 1 Vàng 189k (mất túi cacao, mất quà live). Ca …9280803337: "Lây em 2 túi" → "Túi vàng
    // nhiêu hat" (2 Vàng) → "Túi nâu cacao" (thành 2 Nâu). Ý khách: 1 + 1.
    // Lượt vị ĐẦU: giỏ/đơn N túi một vị dựng từ "N túi" đã nêu → ghi dấu `flavourFromCount` (xem cuối lượt). Lượt sau, trong 3 phút,
    // tin chỉ nêu MỘT vị KHÁC (không số, không đổi/bỏ/thêm): N = 2 → tách 1 + 1 (giỏ: bước đơn; đơn ≤ 60 phút do bot tạo: sửa
    // đơn); N ≥ 3 → hỏi lại vị và số túi từng vị (không đoán), giỏ/đơn giữ nguyên.
    const splitMarker = conversation.flavourFromCount && typeof conversation.flavourFromCount === 'object' ? conversation.flavourFromCount : null;
    const flavourSplitReply = (() => {
      if (!splitMarker || nonText || conversation.source === 'comment' || asksForHuman || cartReply || trialActive || phoneInText) return null;
      if (Date.now() - (Number(splitMarker.at) || 0) > 3 * 60 * 1000) return null;
      const colour = singleFlavourOf(message.text, { strict: true });
      const markerColour = String(splitMarker.code || '').match(/^GRA-(XANH|VANG|NAU)-/i)?.[1]?.toLowerCase() || '';
      const count = Math.round(Number(splitMarker.count) || 0);
      if (!colour || !markerColour || colour === markerColour || count < 2) return null;
      const sameLines = lines => lines.length === 1 && String(lines[0].code || lines[0].sku || '').toUpperCase() === String(splitMarker.code).toUpperCase() && Number(lines[0].quantity) === count;
      const order = splitMarker.orderId ? allOrders.find(item => String(item?.id || '') === String(splitMarker.orderId)) : null;
      const orderEditable = Boolean(order) && recentOrder?.id === order.id && isActiveOrder(order) && order.source !== 'POS' && order.automatic !== false
        && Date.now() - (Number(order.createdAt) || 0) < 60 * 60 * 1000 && sameLines((order.products || []).map(item => ({ code: item.sku || item.code, quantity: item.quantity })));
      const held = usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items || [];
      const basketEditable = !splitMarker.orderId && sameLines(held);
      if (!orderEditable && !basketEditable) return null;
      if (count >= 3) {
        const ask = renderChatbotReply({ template_id: 'ASK_FLAVOR' }, templates, replyContext);
        console.log(`Vị thứ hai sau "${count} túi" (đã lên ${count} ${splitMarker.code}): hỏi lại vị từng túi (${conversation.id})`);
        return ask.templateId === 'ASK_FLAVOR' ? { ...ask, attention: true, pendingOrder: undefined, flavourSplit: 'ask' } : null;
      }
      const other = getCatalogProducts().find(item => item.active !== false && !item.staffOnly && String(item.sku || '').toUpperCase().startsWith(`GRA-${colour.toUpperCase()}-`));
      const first = findProductBySku(splitMarker.code);
      if (!other || !first) return null;
      const value = { template_id: orderEditable ? 'ORDER_UPDATE' : 'ORDER_ADDRESS', Product_N1: first.name, No_A: '1', Product_N2: other.name, No_B: '1' };
      // Chữ tin ("Túi vàng") không được lọc lại giỏ 2 vị về một vị: soạn với messageText rỗng (giỏ lấy đúng Product_N*/No_*).
      const rendered = renderChatbotReply(value, templates, { ...replyContext, messageText: '' });
      const items = rendered.order?.items || rendered.pendingOrder?.items || [];
      if (rendered.handoff || items.length !== 2) return null;
      if (orderEditable && !rendered.order?.updateOrderId) return null;
      console.log(`Vị thứ hai sau "2 túi": tách 1 ${splitMarker.code} + 1 ${other.sku} (${orderEditable ? `sửa đơn ${order.id}` : 'giỏ'}) (${conversation.id})`);
      return { ...rendered, flavourSplit: 'split' };
    })();
    if (flavourSplitReply) trace.flavourSplit = flavourSplitReply.flavourSplit;
    const addressBurst = message.type === 'text' && basketHeld && orderStepLast ? collectAddressBurst(recent) : null;
    // R15 (giao diện K3b): đơn gần nhất chưa hủy do bot tạo (automatic) — [{ code, quantity }] cho luật, rỗng nếu không có.
    const botOrder = recentOrder?.id && isActiveOrder(recentOrder) && recentOrder.automatic === true && recentOrder.source !== 'POS' ? recentOrder : null;
    const recentOrderItemsOf = order => (Array.isArray(order?.products) ? order.products : []).map(item => ({ code: String(item?.sku || item?.code || '').toUpperCase(), quantity: Number(item?.quantity) || 1 })).filter(item => item.code);
    const botOrderItems = recentOrderItemsOf(botOrder);
    // R15 (chủ shop 03/10, quyết định 1 — giao diện với bộ soạn DISCOUNT_OATS_GIFT): tổng túi LỚN (GRA-…) của giỏ đang giữ; không giữ
    // giỏ thì của đơn bot tạo ≤ 60 phút. Bộ soạn đọc context.bagCount; cờ đã hứa tặng yến mạch nằm ở pendingOrder.oatsGift.
    const bigBags = list => (Array.isArray(list) ? list : []).filter(item => /^GRA-/i.test(String(item?.code || item?.sku || ''))).reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
    const heldForOats = usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items || [];
    const oatsOrder = !heldForOats.length && botOrder && Date.now() - (Number(botOrder.createdAt) || 0) < 60 * 60 * 1000 ? botOrder : null;
    replyContext.bagCount = heldForOats.length ? bigBags(heldForOats) : oatsOrder ? bigBags(botOrderItems) : 0;
    replyContext.oatsGift = conversation.pendingOrder?.oatsGift === true;
    let ruleCtxUsed = null;
    const ruledFirst = message.type === 'text' && !asksForHuman && !cartReply && ruleMode !== 'off'
      ? ((text, ctx) => { ruleCtxUsed = ctx; return ruleIntentFn(text, ctx); })(message.text, {
          source: conversation.source,
          botLastTemplateId: conversation.botLastTemplateId || '',
          // Có SĐT/địa chỉ đơn cũ để "gửi địa chỉ cũ" chốt được; không có thì luật hỏi SĐT đặt lần trước.
          hasPreviousDelivery: Boolean((previousDelivery && !previousDelivery.foreign) || (recentOrder?.address && recentOrder?.phone)),
          // R13: với luật, "ngữ cảnh đã đổi" gồm cả tin tự động của Page sau lượt bot (ưu đãi QR, bám đuổi…), không chỉ nhân viên.
          staffRepliedAfterBot: contextChangedAfterBot,
          botLastAgeMin: conversation.botLastReplyAt ? (Date.now() - Number(conversation.botLastReplyAt)) / 60000 : Infinity,
          // Giỏ đang giữ chỉ tính khi còn hạn (2 giờ) — giỏ cũ quá hạn làm luật ADDRESS_COMPLETE dựng ASK_PRODUCT.
          hasBasket: Boolean(usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items?.length),
          // R13 sửa (C1): giỏ/đơn đang xét có quà hiện vật đổi được không (false → luật GIFT_SWAP trả GIFT_POLICY).
          giftSwappable: giftSwapApplies,
          // Vòng 12 (BOT-A): bước giỏ dùng chung isBasketStep (thêm ORDER_ADDRESS_OLD_ASK_PHONE); PRICE_ONE_BAG ("em lên 1 túi
          // nha?") giữ giỏ 1 túi → "ok" là chốt.
          lastWasOrderStep: isBasketStep(conversation.botLastTemplateId) || conversation.botLastTemplateId === 'PRICE_ONE_BAG',
          hasRecentOrder: Boolean(recentOrder?.id),
          orderAgeMin: recentOrder?.id && String(recentOrder.processingStatus || '') !== 'cancelled' ? (Date.now() - (Number(recentOrder.createdAt) || 0)) / 60000 : Infinity,
          // R15 (giao diện K3b, inbox4 A1): món của đơn gần nhất CHƯA HỦY + đơn đó có phải bot tạo (false: đơn nhân viên/POS) —
          // luật "Số lượng là 2" sau khi chốt chỉ sửa đơn bot tạo.
          recentOrderItems: recentOrderItemsOf(recentOrder?.id && isActiveOrder(recentOrder) ? recentOrder : null),
          recentOrderByBot: Boolean(botOrder),
          // R15 (giao diện chặn K1): khách vừa gửi ảnh/tệp (≤ 2 phút) — "Bn 1 túi này" hỏi giá MÓN trong ảnh.
          recentCustomerMedia: recent.some(item => item?.direction === 'incoming' && item.id !== change.message.id && !['text', 'sticker', 'ad', 'order-receipt'].includes(String(item.type || 'text'))
            && !stickerInfo(item) && Date.now() - (Number(item.createdAt) || 0) <= 2 * 60 * 1000),
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
          // R15 (giao diện 3): chuỗi chung HOẶC đối tượng theo từng luật { K1, K1b, K3, K4, K5: 'on'|'shadow'|'off' } — truyền
          // nguyên giá trị (chatbot-settings đã chuẩn hoá); luật tự đọc mode của mình.
          candidateRules: settings.candidateRules && typeof settings.candidateRules === 'object' && !Array.isArray(settings.candidateRules)
            ? settings.candidateRules
            : ['on', 'shadow', 'off'].includes(settings.candidateRules) ? settings.candidateRules : 'shadow',
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
            || /\b(goi nho|combo 10|hop 10|10 goi|cb10)\b/.test(folded),
          // R16 (giao diện cho luật BAGS_NAMED_BEFORE / BAGS_NO_FLAVOR): các tin CHỮ của khách trong 15 phút gần nhất, TRỪ tin đang
          // xét, cũ → mới, dạng { text, at }.
          recentCustomerTexts: recent.filter(item => item?.direction === 'incoming' && (item.type || 'text') === 'text' && item.text && item.id !== change.message.id
            && Date.now() - (Number(item.createdAt) || 0) <= 15 * 60 * 1000).map(item => ({ text: String(item.text), at: Number(item.createdAt) || 0 })),
          // R16 (giao diện luật ASK_FLAVOR_NGUYENBAN): số túi bot đang hỏi "nguyên bản hay nhiều hạt" (giỏ chờ ghi).
          nguyenBanAsk: conversation.pendingOrder?.nguyenBanAsk
        })
      : null;
    // R16 (inbox2 C1, ca …2153698503): "Mình lấy 2 túi" / "Màu vàng nhiều hạt nhé" / "Cho về địa chỉ cũ cho mình" (3 tin chưa trả
    // lời, gộp thành một lượt) — luật đọc cả cụm ra null nên mô hình hỏi lại vị. Tin CUỐI là "địa chỉ cũ" mà luật không dựng giỏ:
    // chạy lại luật trên các tin TRƯỚC của cụm (bỏ dòng địa chỉ cũ); dựng được giỏ thì giỏ đó + địa chỉ cũ (như BASKET_OLD_ADDRESS).
    const ruled = (() => {
      // Cụm nhiều tin, hay MỘT tin nhiều dòng ("Mình lấy 2 túi\nMàu vàng nhiều hạt nhé\nCho về địa chỉ cũ cho mình").
      const pieces = bundle.length >= 2 ? bundle.map(item => String(item?.text || '')) : String(message.text || '').split(/\n+/);
      if (!ruleCtxUsed || pieces.length < 2 || conversation.source === 'comment' || (ruledFirst?.value && ruledFirst.value.Product_N1)) return ruledFirst;
      const lastText = String(pieces[pieces.length - 1] || '');
      if (!saysOldAddress(lastText) || extractVietnamesePhone(lastText)) return ruledFirst;
      const earlier = pieces.slice(0, -1).map(text => text.trim()).filter(text => text && !saysOldAddress(text));
      if (!earlier.length) return ruledFirst;
      const again = ruleIntentFn(earlier.join('\n'), ruleCtxUsed);
      const value = again?.value;
      if (!value?.Product_N1 || !['ORDER_ADDRESS', 'ORDER_CONFIRMATION'].includes(String(value.template_id || ''))) return ruledFirst;
      console.log(`Cụm tin có giỏ (${again.rule}) + tin cuối "địa chỉ cũ": giỏ từ cả cụm, gửi địa chỉ cũ (${conversation.id})`);
      return { rule: 'BURST_BASKET_OLD_ADDRESS', value: { ...value, template_id: 'ORDER_ADDRESS', Phone_Number: value.Phone_Number || '0', Customer_Address: '0' } };
    })();
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
    // R15 (giao diện K3b, inbox4 A1 ca …068500 "Số lượng là 2" sau đơn 1 Nâu): luật trả ORDER_UPDATE + setQuantity khi có đơn bot
    // tạo ≤ 60 phút một mã → SỬA đơn đó (bộ soạn đơn: updateOrderId), không tạo đơn mới; SĐT/địa chỉ lấy từ đơn.
    const updateQuantity = ruled?.value && Number(ruled.setQuantity) > 0 && String(ruled.value.template_id || '') === 'ORDER_UPDATE' && !ruled.value.Product_N1
      && botOrderItems.length === 1 && Date.now() - (Number(botOrder?.createdAt) || 0) < 60 * 60 * 1000 ? findProductBySku(botOrderItems[0].code) : null;
    const ruledValue = updateQuantity
      ? { ...ruled.value, Product_N1: updateQuantity.name, No_A: String(Math.round(Number(ruled.setQuantity))) }
      : ruled?.value && Number(ruled.setQuantity) > 0 && ruledHeldItems.length === 1 && isOrderStep(String(ruled.value.template_id || '')) && !ruled.value.Product_N1
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
    // R15: `mode` là mode THỰC của đúng luật ứng viên ở lượt này (cờ theo từng luật → luật tự đặt shadowOnly).
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
    // R14 (inbox3 H1, ca …216841): "tỉnh gia lai", "Gia Lâm/Lộc/Nghĩa…" bỏ dấu trùng "giá" — che địa danh (maskPlaceGia)
    // trước khi dò câu hỏi giá.
    const asksPriceText = text => priceAsk.test(foldVietnamese(maskPlaceGia(String(text || ''))).replace(/\s+/g, ' '));
    const colourQuote = (() => {
      if (nonText || !['ASK_PRODUCT', 'ASK_FLAVOR'].includes(conversation.botLastTemplateId) || phoneInText || /\d/.test(folded) || !templates?.PRICE_QUOTE) return null;
      const colours = [...new Set((folded.match(/\b(xanh|vang|nau|cacao)\b/g) || []).map(colour => (colour === 'cacao' ? 'nau' : colour)))];
      const leftover = folded.replace(/\b(xanh|vang|nau|cacao|la|cay|tui|goi|bich|granola|vi|mau|loai|cho|em|minh|chi|c|e|a|anh|lay|nha|nhe|shop|di)\b/g, '').replace(/[^a-z]/g, '');
      if (colours.length !== 1 || leftover) return null;
      const earlier = replyContext.recentCustomerTexts.filter(text => squashText(text) !== squashText(message.text)).slice(-3);
      if (!earlier.some(text => asksPriceText(text))) return null;
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
      // R13 sửa (C1): GIFT_SWAP ("em thay bằng 2 gói nhỏ… lấy vị nào") cho giỏ/đơn KHÔNG có quà hiện vật → nói chính sách quà
      // (GIFT_POLICY theo ngữ cảnh bên dưới), không hứa gói nhỏ, không ghi chú đổi quà vào đơn, không mở lượt chọn vị.
      if (item.templateId === 'GIFT_SWAP' && giftSwapApplies === false && templates?.GIFT_POLICY) {
        const policy = renderChatbotReply({ template_id: 'GIFT_POLICY' }, templates, replyContext);
        if (policy.templateId === 'GIFT_POLICY') item = { ...policy, ...(item.pendingOrder !== undefined ? { pendingOrder: item.pendingOrder } : {}) };
      }
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
        // R16 (inbox5 A2, ca …5122488996 "combo này có tặng quạt ko" khi giữ giỏ live 3 túi): khách live ĐANG GIỮ GIỎ (chưa có đơn
        // 24 giờ — có đơn thì bộ soạn đã nói quà của đơn) hỏi quà → nói quà của CHÍNH giỏ (bảng quà tính trên giỏ, quà live theo
        // giá live), bỏ đuôi mời "lấy 2 túi vị nào", ghép câu nhắc giỏ + phần còn thiếu.
        const giftBasket = Array.isArray(item.pendingOrder?.items) && item.pendingOrder.items.length ? item.pendingOrder.items : heldItems;
        if (giftId === 'GIFT_POLICY_LIVE' && giftBasket.length && !hasOrder && conversation.source !== 'comment') {
          const own = renderOrderGiftReply(templates, { ...replyContext, recentOrder: { products: giftBasket.map(entry => ({ sku: entry.code, name: entry.product, quantity: entry.quantity })), livestream: true } });
          if (own?.messages?.length) {
            const closing = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, { ...replyContext, pendingOrder: item.pendingOrder && typeof item.pendingOrder === 'object' ? item.pendingOrder : conversation.pendingOrder, lastTemplateId: 'ORDER_ADDRESS' });
            const lines = [...own.messages.map(withoutInviteTail).filter(text => text.trim()), ...(closing.remind ? [closing.remind] : [])];
            out = { ...item, templateId: 'GIFT_POLICY', variant: 'basket', messages: lines, images: [], parts: undefined, ...keep };
            return wantsGiftPhotos ? withGiftPhotos(out) : out;
          }
        }
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
        : voiceReply || paymentReply || existingConfirmReply || (trialOutcome?.value
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
              : flavourSplitReply || ackReply || comboQuote || remindAck || noteReply || lookupReply || giftChoiceReply || choiceReply || colourQuote || quickQuote || (ruleMode === 'on' && ruleUsable ? ruleReply : null) || (cascadeReply?.templateId === cascade?.templateId ? cascadeReply : null) || (intentReply?.templateId === intent?.templateId ? intentReply : null) || (preGuardMode === 'on' && preGuard ? preGuard.reply : null) || await askModel());
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
    // R14 (inbox3 H4, ca …017802): mô hình chọn CSKH_HANDOFF (tắt bot) cho tin hộp thư rất ngắn ("Dỡ") rồi không ai trả lời.
    // Prompt đã dặn "không chuyển người vì tin ngắn": tin ≤ 3 chữ, khách không đòi gặp người → KHÔNG tắt bot:
    // - lời chê ngắn ("dở", "dỡ quá") → xin lỗi + hỏi chưa ưng điểm nào (COMPLAINT_SORRY) + thẻ Khiếu nại;
    // - còn lại → báo bạn phụ trách sẽ trả lời (STAFF_WAIT_*) + thẻ cần người.
    if (conversation.source !== 'comment' && !nonText && !asksForHuman && chosenTemplateId === 'CSKH_HANDOFF' && reply.templateId === 'CSKH_HANDOFF' && reply.handoff
      && squashText(message.text).split(' ').filter(Boolean).length <= 3 && !trialActive
      // Khách tự đòi gặp người ("gặp nhân viên", "gọi cho mình", "admin") → vẫn chuyển như mô hình chọn.
      && !/\b(nhan vien|nguoi that|admin|ad|chu shop|quan ly|tu van vien|gap|goi (?:cho|lai|dien|minh|em|toi)|hotline|sdt shop|khieu nai|huy|hoan tien|tra hang|doi tra)\b/.test(squashText(message.text))) {
      const wait = staffWaitTemplate();
      const softId = complainsAboutProduct(message.text) && templates?.COMPLAINT_SORRY ? 'COMPLAINT_SORRY' : wait.templateId;
      const soft = renderChatbotReply({ template_id: softId, values: { when: wait.when } }, templates, replyContext);
      if (soft.templateId === softId && soft.messages?.length) {
        console.log(`Mô hình chuyển CSKH vì tin ngắn: không tắt bot, gửi ${softId} + thẻ (${conversation.id})`);
        reply = { ...soft, handoff: false, attention: true, ...(softId === 'COMPLAINT_SORRY' ? { complaint: true } : { staffWait: true }) };
      }
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
    // R15 (inbox2 A2, ca …111673): đang giữ 1 Xanh + 1 Vàng, khách "Lấy 2 bịt xanh được ko" — câu hỏi dạng "được không" nhưng là
    // ĐỔI GIỎ: luật/mô hình trả giỏ mới khác giỏ đang giữ và tin có động từ chọn/đổi (lấy, đổi, thay, chuyển, thêm, bớt) hay số
    // túi kèm màu → lưu giỏ mới, không coi là câu hỏi (trước đây bot nhắc lại giỏ cũ).
    // R15-fix3 (phản biện T4): câu hỏi điều kiện với MỘT PHẦN giỏ ("đổi 1 túi sang vàng được ko" khi giữ 2 Xanh) không phải đổi cả
    // giỏ: đọc được "đổi N túi sang <màu>" từ giỏ một vị → giỏ (M−N) cũ + N mới; không đọc được → để bước hỏi lại mô hình như cũ.
    // Tuyệt đối không thay cả giỏ bằng màu mới.
    const heldItemsNow = basketHeld ? usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items || [] : [];
    const heldBagTotal = heldItemsNow.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
    const conditionalAsk = /\?/.test(String(message.text || '')) || /\b(?:duoc|dc) (?:khong|ko|k|kg|hong|ha)\b|\bthi sao\b|\bco duoc\b/.test(folded);
    const partialCount = (() => {
      const found = folded.match(/\b(\d{1,2}|mot|hai)\s*(?:tui|goi|bich|bit|bi)\b/);
      return found ? ({ mot: 1, hai: 2 })[found[1]] || Number(found[1]) || 0 : 0;
    })();
    // R15-fix4 (phản biện M8): câu THÊM ("thêm 1 túi vàng được không em", "lấy thêm 1 túi xanh nữa được ko") không phải câu hỏi
    // về một phần giỏ — để giỏ mới (2 Xanh + 1 Vàng / 3 Xanh) như 8c20fe3.
    const partialQuestion = basketHeld && !nonText && conditionalAsk && partialCount > 0 && partialCount < heldBagTotal && !/\b(?:them|nua)\b/.test(folded);
    const partialSwap = (() => {
      if (!partialQuestion || heldItemsNow.length !== 1) return null;
      const swap = folded.match(/\b(?:doi|thay|chuyen)\s+(\d{1,2}|mot)\s*(?:tui|goi|bich|bit|bi)?\s*(?:sang|thanh|qua|lay|ra)?\s*(?:tui |vi |mau )?(xanh|vang|nau|cacao)\b/);
      if (!swap) return null;
      const count = ({ mot: 1 })[swap[1]] || Number(swap[1]) || 0;
      const colour = swap[2] === 'cacao' ? 'nau' : swap[2];
      const held = heldItemsNow[0];
      const heldCode = String(held.code || '').toUpperCase();
      if (!heldCode.startsWith('GRA-') || heldCode.startsWith(`GRA-${colour.toUpperCase()}-`) || count <= 0 || count >= (Number(held.quantity) || 1)) return null;
      const other = getCatalogProducts().find(item => item.active !== false && !item.staffOnly && String(item.sku || '').toUpperCase().startsWith(`GRA-${colour.toUpperCase()}-`));
      if (!other) return null;
      const rendered = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: held.product, No_A: String((Number(held.quantity) || 1) - count), Product_N2: other.name, No_B: String(count) }, templates, { ...replyContext, messageText: '' });
      const items = rendered.pendingOrder?.items || [];
      if (rendered.handoff || items.length !== 2) return null;
      console.log(`Đổi ${count} túi trong giỏ ${held.quantity} ${heldCode} sang ${other.sku} (câu hỏi điều kiện) (${conversation.id})`);
      return rendered;
    })();
    if (partialSwap) reply = partialSwap;
    const changesBasket = Boolean(partialSwap) || (basketHeld && !partialQuestion && Boolean(reply.pendingOrder?.key) && String(reply.pendingOrder.key) !== String(conversation.pendingOrder?.key || '')
      && isOrderStep(reply.templateId) && !reply.handoff
      && (/\b(?:lay|doi|thay|chuyen|them|bot|chot|dat)\b/.test(folded) || /\b\d{1,2}\s*(?:tui|goi|bich|bit|bi|hop)?\s*(?:xanh|vang|nau|cacao)\b/.test(folded)));
    const basketQuestion = !infoWhileHeld && !changesBasket && !nonText && basketHeld && orderStepLast && !phoneInText && !awaitingAsked && !cartReply && !asksForHuman && !nudgeLike && !shortAck
      && (/\?/.test(String(message.text || '')) || /\b(cho xem|xem|coi|nao|sao|khac gi|duoc (khong|ko|k)|co (khong|ko|k)|bao nhieu|bn)\b/.test(folded))
      // R13 fix2 (B4): tin dài hơn 500 ký tự không phải địa chỉ (địa chỉ thật dài nhất ≈ 190) — không đưa vào bộ đọc địa chỉ.
      && !(String(message.text || '').length <= 500 && describeDeliveryAddress(String(message.text || '')).complete);
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
      // R16 (inbox2 C3, ca …2213582582 "6túi thì giá thế nào vậy shop" khi giữ 3 Túi Vàng): báo giá N túi khác số túi đang giữ →
      // không kèm câu nhắc giỏ (câu nhắc đọc số túi của câu hỏi: "đang giữ đơn 6 Granola Túi Vàng" trong khi giỏ là 3).
      const heldCountNow = (usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
      const askedCountNow = bagCountInText(message.text);
      const remindMismatch = Boolean(answer) && answer.templateId === 'PRICE_COUNT' && askedCountNow > 0 && askedCountNow !== heldCountNow;
      if (remindMismatch) console.log(`Báo giá ${askedCountNow} túi khác giỏ đang giữ ${heldCountNow} túi: bỏ câu nhắc giỏ (${conversation.id})`);
      if (answer) {
        const partsOf = item => item.parts || [...item.messages.map(text => ({ type: 'text', text })), ...(item.images || []).map(url => ({ type: 'image', url }))];
        reply = remind && !remindMismatch
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
    // R16 (inbox4 H4, ca …473537 "Cho mình giá của từng loại", "Đồng giá bằng nhau hả bạn?"): mô hình chọn GENERAL_INFO cho câu hỏi
    // về CÁC loại / từng loại / đồng giá → giữ bảng 3 vị (như cờ listAll của luật), không thay bằng bảng Túi Xanh.
    // ("Hồ Tùng Mậu" trong địa chỉ không tính; tin có SĐT không tính.)
    const listAllText = !nonText && !phoneInText && /(?<!\bho )\b(?:tung|moi|cac|tat ca(?: cac)?|may|nhung) (?:loai|vi|mau)\b|\bdong gia\b|\bbang nhau\b|\bgia (?:co )?khac\b/.test(folded);
    const listAll = (reply === ruleReply && Boolean(ruled?.value?.listAll)) || (reply.templateId === 'GENERAL_INFO' && listAllText);
    // R13: tin có phải HỎI GIÁ không (chữ hỏi giá, tin cụt ".", "ib", hay luật báo giá đã khớp) — điều kiện của ASK_TWO_BAGS.
    const priceLikeText = !nonText && (terse || asksPriceText(message.text) || /^(?:\.+|…|\?+|ib|inbox|bn)$/.test(folded) || /PRICE|DOTS|TERSE/.test(String(ruled?.rule || '')));
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
    const genuineThanks = shortAck || confirmAck || emojiOnly || ackWordsOnly || ruled?.rule === 'THANKS' || /\b(cam on|camon|thank|thanks|tks)\b/.test(folded) && folded.length <= 60 && !/\?/.test(folded);
    // R16 (bình luận/hộp thư B1 "Hix"): tin cảm thán ngắn không hỏi gì → im, không thẻ (không hỏi lại mô hình).
    if (reply.templateId === 'THANK_YOU' && conversation.source !== 'comment' && !nonText && !genuineThanks && isExclamationOnly(message.text)) {
      if (change.message?.id || change.message?.mid) await saveBotState(conversation.id, { botHandledMessageId: String(change.message.id || change.message.mid) }).catch(() => {});
      results.push({ conversationId: conversation.id, skipped: 'tin cảm thán ngắn' });
      return;
    }
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
    // R15 (inbox1 A1): sửa đơn làm GIẢM tổng số túi trong khi tin khách không có con số nào và không nói bớt/bỏ ("Túi vàng"
    // ngay sau đơn 2 Nâu → mô hình sửa thành 1 Vàng 189k) → không áp; hỏi lại loại túi và số lượng (ORDER_WRONG) + thẻ.
    if (reply.order?.updateOrderId && recentOrder?.id && String(reply.order.updateOrderId) === String(recentOrder.id) && templates?.ORDER_WRONG) {
      const bagsOf = list => (Array.isArray(list) ? list : []).reduce((sum, item) => sum + (Number(item?.quantity) || 1), 0);
      const before = bagsOf(recentOrder.products);
      const after = bagsOf(reply.order.items);
      // R15-fix3 (C3): khối lượng ("Túi vàng 350g", "Túi xanh 450 g", "vàng 350") không phải số túi.
      const saysCount = /\d/.test(stripBagWeights(stripPhone(String(message.text || '')))) || /\b(?:mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)\s*(?:tui|goi|bich|bit|hop)\b/.test(folded);
      // R15-fix3 (L1): "chỉ vàng" (còn dấu, hay "chi <màu>" đầu tin) là chọn bớt vị — không hỏi lại.
      // ("chị lấy" bỏ dấu cũng là "chi lay", "địa chỉ" không tính.)
      const saysOnly = /(?<![\p{L}])chỉ(?![\p{L}])/iu.test(String(message.text || '').normalize('NFC').replace(/địa\s*chỉ/giu, ' ')) || /^chi (?:xanh|vang|nau|cacao|ca cao)\b/.test(folded);
      // R15-fix4 (M1): "bỏ" xét chữ CÒN DẤU — "bố" bỏ dấu cũng là "bo" ("Túi vàng cho bố" không phải bớt).
      const saysDrop = /(?<![\p{L}])bỏ(?![\p{L}])/u.test(String(message.text || '').normalize('NFC').toLowerCase());
      const saysReduce = saysOnly || saysDrop || /\b(?:bot|bo bot|khong lay|ko lay|k lay|kg lay|chi lay|chi can|chi mua|chi dat|thoi|huy|tru|giam|it lai|con lai)\b/.test(folded);
      // Ngoài phạm vi diff (phản biện s6b): tin nói THÊM ("thêm 1 túi vàng nữa nha") mà đơn sửa lại ÍT túi hơn → không áp, dù tin có số.
      // R15-fix4: "không thêm nữa" / "khỏi thêm" / "không lấy thêm" là phủ định, không phải nói thêm (asksToAdd).
      const saysAdd = asksToAdd(folded) && !saysDrop && !/\b(?:bot|khong lay|ko lay|huy|giam|it lai)\b/.test(folded);
      if (before > 0 && after > 0 && after < before && ((!saysCount && !saysReduce) || saysAdd)) {
        const wrong = renderChatbotReply({ template_id: 'ORDER_WRONG' }, templates, replyContext);
        if (wrong.templateId === 'ORDER_WRONG') {
          console.log(`Sửa đơn giảm ${before} → ${after} túi mà tin không có số / không nói bớt: không áp, hỏi lại (${conversation.id})`);
          reply = { ...wrong, attention: true, order: undefined, pendingOrder: undefined };
        }
      }
    }
    // Vòng 12 (BOT-A): không tra được địa chỉ cũ → nhân viên tra (thẻ), không hỏi từng cấp.
    if (reply.oldAddressMissing && !reply.attention) reply = { ...reply, attention: true };
    // R14 (chủ shop 03/10, quyết định 10; inbox1 C3a ca …929527 bị xin "SĐT và địa chỉ" 3 lần): khách cũ "gửi địa chỉ cũ" mà
    // bot không tra được → xin SĐT đã đặt MỘT lần (ORDER_ADDRESS_OLD_ASK_PHONE, mốc oldAddressAskedAt); đã xin rồi (hay khách đã
    // đưa SĐT mà vẫn không tra ra) → báo bạn phụ trách tìm địa chỉ cũ (STAFF_WAIT_* + thẻ + ghi chú), không xin lần ba.
    const wantsOldAddress = !nonText && conversation.source !== 'comment' && (saysOldAddress(message.text) || Boolean(conversation.pendingOrder?.wantsPrevious)
      || Boolean(reply.pendingOrder?.wantsPrevious) || conversation.botLastTemplateId === 'ORDER_ADDRESS_OLD_ASK_PHONE');
    // (SĐT trùng đơn landing/POS ngoài hội thoại — previousDelivery.foreign — đã có thẻ + ghi chú C2 và câu xin địa chỉ: giữ nguyên.)
    // R16 (inbox4 H3, ca …949494 "Hạn sứ dung đến khi nào vay e" khi bot đang chờ SĐT): tin có câu hỏi thông tin (ý phụ /
    // trả lời câu hỏi khi đang giữ giỏ) mà KHÔNG có SĐT → trả lời câu hỏi (kèm nhắc giỏ), không vào nhánh địa chỉ cũ.
    const infoQuestionNoPhone = !phoneInText && !reply.oldAddressMissing && (infoWhileHeld || Boolean(reply.alsoTemplateId));
    const oldAddressAsk = wantsOldAddress && !infoQuestionNoPhone && !reply.order && !reply.handoff && !previousDelivery?.address && !previousDelivery?.foreign
      // Khách gõ địa chỉ mới (đọc ra tỉnh) thì không còn là "địa chỉ cũ".
      && !describeDeliveryAddress(stripPhone(String(message.text || ''))).resolved?.province
      && (reply.oldAddressMissing || ['ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_REMIND', 'ORDER_ADDRESS_OLD_ASK_PHONE'].includes(reply.templateId));
    let oldAddressAskedNow = false;
    if (oldAddressAsk) {
      const askedBefore = Date.now() - (Number(conversation.oldAddressAskedAt) || 0) < 24 * 60 * 60 * 1000 || conversation.botLastTemplateId === 'ORDER_ADDRESS_OLD_ASK_PHONE';
      const keepPending = reply.pendingOrder !== undefined ? { pendingOrder: reply.pendingOrder && typeof reply.pendingOrder === 'object' ? { ...reply.pendingOrder, wantsPrevious: true } : reply.pendingOrder } : {};
      if (!askedBefore && !phoneInText && !reply.oldAddressMissing && templates?.ORDER_ADDRESS_OLD_ASK_PHONE) {
        const ask = renderChatbotReply({ template_id: 'ORDER_ADDRESS_OLD_ASK_PHONE' }, templates, replyContext);
        if (ask.templateId === 'ORDER_ADDRESS_OLD_ASK_PHONE') { reply = { ...ask, ...keepPending }; oldAddressAskedNow = true; }
      } else if (templates?.ORDER_ADDRESS_OLD_NOT_FOUND) {
        // R15 (chủ shop 03/10, quyết định 8; inbox1 A4 ca …3002593259 chờ nhân viên 89 phút): không tra được địa chỉ cũ → bot HỎI
        // THẲNG địa chỉ nhận hàng (mẫu ORDER_ADDRESS_OLD_NOT_FOUND), không STAFF_WAIT, không thẻ; giỏ (kèm SĐT) giữ nguyên.
        const notFound = renderChatbotReply({ template_id: 'ORDER_ADDRESS_OLD_NOT_FOUND' }, templates, replyContext);
        if (notFound.templateId === 'ORDER_ADDRESS_OLD_NOT_FOUND') {
          console.log(`Địa chỉ cũ không tra được: hỏi thẳng địa chỉ (${conversation.id})`);
          const pendingNow = keepPending.pendingOrder !== undefined ? keepPending.pendingOrder : conversation.pendingOrder;
          const askPending = pendingNow && typeof pendingNow === 'object'
            ? { ...pendingNow, ...(phoneInText && !pendingNow.phone ? { phone: phoneInText } : {}), wantsPrevious: false }
            : pendingNow;
          reply = { ...notFound, attention: false, ...(askPending !== undefined ? { pendingOrder: askPending } : {}) };
          await noteForStaff(dependencies, conversation, `Khách muốn gửi về địa chỉ cũ nhưng bot không tra được${phoneInText ? ` (SĐT khách đưa: ${phoneInText})` : ''} — bot đã hỏi lại địa chỉ.`, 'địa chỉ cũ không tra được');
        }
      } else {
        const wait = staffWaitTemplate();
        const staff = renderChatbotReply({ template_id: wait.templateId, values: { when: wait.when } }, templates, replyContext);
        if (staff.templateId === wait.templateId) {
          console.log(`Địa chỉ cũ không tra được (đã xin SĐT): chuyển bạn phụ trách tìm (${conversation.id})`);
          reply = { ...staff, ...keepPending, attention: true, staffWait: true };
          await noteForStaff(dependencies, conversation, `Khách muốn gửi về địa chỉ cũ nhưng bot không tra được${phoneInText ? ` (SĐT khách đưa: ${phoneInText})` : ''}. Nhân viên tìm đơn cũ theo tên/Facebook và lên đơn giúp khách. Tin khách: "${String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 150)}"`, 'địa chỉ cũ không tra được');
        }
      }
    }
    // C2: SĐT khách gửi trùng đơn landing/POS ngoài hội thoại (địa chỉ không tự điền): luôn gắn thẻ cho nhân viên.
    if (previousDelivery?.foreign && !reply.attention) reply = { ...reply, attention: true };
    // R15 (chủ shop 03/10, quyết định 1; inbox1 A5): khách mặc cả / khách quen xin giảm → không giảm giá; giỏ/đơn từ 2 túi lớn thì
    // tặng yến mạch. Bộ soạn trả DISCOUNT_OATS_GIFT (câu + dòng quà); engine giữ lời hứa:
    // - đang giữ giỏ: pendingOrder.oatsGift = true (đi theo giỏ tới khi lên đơn, giỏ dựng lại vẫn giữ — xem carriedFields);
    // - đơn bot tạo ≤ 60 phút: sửa đơn (cùng món) để dòng quà có yến mạch + ghi chú xử lý cho nhân viên thêm dòng quà trên POS
    //   (CHƯA có mã POS cho yến mạch tặng).
    // R15 (inbox2 A7, ca …766850 "Dt. 090259563" — 9 số): bước đơn mà tin có SĐT THIẾU số (phoneLooksShort, không có SĐT hợp lệ)
    // và giỏ chưa có SĐT → báo khách kiểm tra lại số (PHONE_LOOKS_SHORT), không xin SĐT chung chung như thể khách chưa gửi.
    const shortPhone = !nonText && conversation.source !== 'comment' && !phoneInText ? phoneLooksShort(String(message.text || '')) : '';
    if (shortPhone && !reply.order && !reply.handoff && (isOrderStep(reply.templateId) || reply.templateId === 'ORDER_ADDRESS_REMIND')
      && !(reply.pendingOrder?.phone || conversation.pendingOrder?.phone) && templates?.PHONE_LOOKS_SHORT) {
      const short = renderChatbotReply({ template_id: 'PHONE_LOOKS_SHORT', values: { phone: shortPhone } }, templates, replyContext);
      if (short.templateId === 'PHONE_LOOKS_SHORT' && short.messages?.length) {
        console.log(`SĐT thiếu số (${shortPhone.length} chữ số): hỏi lại số (${conversation.id})`);
        reply = { ...short, ...(reply.pendingOrder !== undefined ? { pendingOrder: reply.pendingOrder } : {}) };
      }
    }
    const oatsNote = '⚠ Tặng yến mạch khách mặc cả — thêm dòng quà trên POS';
    if ((reply.templateId === 'DISCOUNT_OATS_GIFT' || reply.alsoTemplateId === 'DISCOUNT_OATS_GIFT') && !nonText && conversation.source !== 'comment' && Number(replyContext.bagCount) >= 2 && !reply.order) {
      if (heldForOats.length) {
        const base = reply.pendingOrder && typeof reply.pendingOrder === 'object' ? reply.pendingOrder : usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' }) || conversation.pendingOrder;
        reply = { ...reply, pendingOrder: { ...base, oatsGift: true } };
        console.log(`Khách mặc cả, giỏ ${replyContext.bagCount} túi: hứa tặng yến mạch (giỏ mang oatsGift) (${conversation.id})`);
      } else if (oatsOrder) {
        const lines = (oatsOrder.products || []).map(item => ({ product: findProductBySku(item.sku || item.code)?.name || item.name || item.product, quantity: Number(item.quantity) || 1 })).filter(item => item.product).slice(0, 3);
        const slots = ['Product_N1', 'No_A', 'Product_N2', 'No_B', 'Product_N3', 'No_C'];
        const value = { template_id: 'ORDER_UPDATE' };
        lines.forEach((item, index) => { value[slots[index * 2]] = item.product; value[slots[index * 2 + 1]] = String(item.quantity); });
        const updated = lines.length ? renderChatbotReply(value, templates, { ...replyContext, messageText: '', pendingOrder: { items: [], key: '', at: Date.now(), phone: '', address: '', addressAsks: 0, oatsGift: true } }) : null;
        // Bộ soạn coi "cùng món, cùng SĐT/địa chỉ" là ORDER_UNCHANGED (không so dòng quà) → soạn lại đơn như đơn mới (giỏ chờ mang
        // oatsGift + SĐT/địa chỉ của đơn) rồi gắn updateOrderId của đơn đó.
        const rebuilt = () => {
          const fresh = renderChatbotReply({ ...value, template_id: 'ORDER_CONFIRMATION' }, templates, { ...replyContext, messageText: '', recentOrder: null, latestOrder: null, hasOrder: false,
            pendingOrder: { items: [], key: '', at: Date.now(), phone: String(oatsOrder.phone || ''), address: String(oatsOrder.rawAddress || oatsOrder.address || '').replace(/^\((?:live|freeship)\)\s*/i, ''), addressAsks: maxAddressAsks, oatsGift: true } });
          return fresh.order && !fresh.order.updateOrderId ? { ...fresh.order, updateOrderId: String(oatsOrder.id), ...(oatsOrder.livestream === true ? { livestream: true } : {}) } : null;
        };
        const order = updated?.order?.updateOrderId ? updated.order : lines.length ? rebuilt() : null;
        reply = order
          ? { ...reply, attention: true, order: { ...order, addressCheck: [String(order.addressCheck || ''), oatsNote].filter(Boolean).join('; ') } }
          : { ...reply, attention: true, order: { noteOrderId: String(oatsOrder.id), note: oatsNote } };
        console.log(`Khách mặc cả, đơn ${oatsOrder.id} ${replyContext.bagCount} túi: thêm quà yến mạch (${order ? 'sửa đơn' : 'ghi chú'}) (${conversation.id})`);
      }
    }
    // Giỏ mang lời hứa tặng yến mạch lên đơn: ghi chú xử lý cho nhân viên (chưa có mã POS).
    // R15-fix3 (phản biện T6): chỉ khi đơn cuối còn ≥ 2 túi lớn — khách giảm còn 1 túi thì bỏ lời hứa (quà từ combo 2 túi).
    if (reply.order && !reply.order.noteOrderId && !reply.order.cancelOrderId && conversation.pendingOrder?.oatsGift === true && bigBags(reply.order.items) >= 2 && !String(reply.order.addressCheck || '').includes(oatsNote)) {
      reply = { ...reply, attention: true, order: { ...reply.order, addressCheck: [String(reply.order.addressCheck || ''), oatsNote].filter(Boolean).join('; ') } };
    }
    // R15 (bình luận A2, inbox1 A8, ca …9603540695): ORDER_NOTE ("đã ghi chú yêu cầu vào đơn và báo kho") chỉ dành cho LỜI DẶN
    // GIAO HÀNG. Mô hình chọn ORDER_NOTE cho câu nói/hỏi về quà ("Lúc c mới hỏi … tặng quạt và bát dừa", "… nên c hỏi lại") → khách
    // hiểu là shop đã đồng ý tặng. Nay: nói về quà → GIFT_SWAP (ghi chú + xin bộ phận phụ trách duyệt, thẻ); câu hỏi / "hỏi lại"
    // khác → báo bạn phụ trách trả lời (STAFF_WAIT_*) + thẻ, không ghi chú vào đơn.
    if (reply.templateId === 'ORDER_NOTE' && reply !== noteReply && !nonText) {
      // "k có thời gian trả hàng" là lời dặn, không phải hỏi: chỉ "hỏi lại", dấu hỏi, "sao/chưa/không ghi|thấy", "được không".
      const asksBack = /\?|\bhoi lai\b|\b(?:sao|khong|ko|k|chua)\s+(?:ghi|thay)\b|\b(?:duoc|dc)\s+(?:khong|ko|k)\s*(?:a|em|e|shop|c|chi|nhi|ha)?\s*$/.test(folded);
      // R15-fix3 (phản biện L3, r15 …083958786 "2 gói nhỏ tặng kèm lấy nâu nhé"): chọn VỊ của gói quà tặng kèm là lời dặn cho đơn —
      // giữ ORDER_NOTE như bản cũ (không GIFT_SWAP / bạn phụ trách).
      const giftFlavourChoice = !asksBack && /\bgoi\b/.test(folded) && /\b(?:xanh|vang|nau|cacao|ca cao|mix|dau|xoai)\b/.test(folded) && /\b(?:lay|chon|cho|de)\b/.test(folded);
      const giftTalk = !giftFlavourChoice && /\b(?:quat|bat|muong|thia|qua|tang|gao dua)\b/.test(folded);
      if (giftTalk && templates?.GIFT_SWAP && giftSwapApplies !== false) {
        const swap = renderChatbotReply({ template_id: 'GIFT_SWAP' }, templates, replyContext);
        if (swap.templateId === 'GIFT_SWAP') { console.log(`ORDER_NOTE cho câu nói về quà → GIFT_SWAP (${conversation.id})`); reply = { ...swap, attention: true, order: undefined, pendingOrder: undefined }; }
      } else if (giftTalk || asksBack) {
        const wait = staffWaitTemplate();
        const staff = renderChatbotReply({ template_id: wait.templateId, values: { when: wait.when } }, templates, replyContext);
        if (staff.templateId === wait.templateId) { console.log(`ORDER_NOTE cho câu hỏi → ${wait.templateId} (${conversation.id})`); reply = { ...staff, attention: true, staffWait: true, order: undefined, pendingOrder: undefined }; }
      }
    }
    // R13 sửa (C1): giỏ/đơn không có quà hiện vật → GIFT_SWAP (mô hình hay luật chọn) đổi thành GIFT_POLICY trước khi ghi chú/thẻ.
    if ((reply.templateId === 'GIFT_SWAP' || reply.alsoTemplateId === 'GIFT_SWAP') && giftSwapApplies === false) reply = contextualAlso(contextualReply(reply));
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
          const rendered = renderChatbotReply({ template_id: 'PRICE_COUNT', values: { count: String(count), total: `${Number(priced.total).toLocaleString('vi-VN')}đ`, ship: priced.shippingFee ? `${Number(priced.shippingFee).toLocaleString('vi-VN')}đ` : '', free: priced.shippingFee ? '' : '1', gift, kind: 'mix vị tùy ý',
            // R15 (giao diện với luật PRICE_COUNT): tin đã nêu màu → mẫu không hỏi lại vị (named); chưa nêu → hỏi vị (pick).
            ...(/\b(?:xanh|vang|nau|cacao)\b/.test(folded) ? { named: '1' } : { pick: '1' }) } }, templates, replyContext);
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
    // R14 (inbox2 M3, ca …807322: đơn 27/09, 5 ngày chưa nhận, bot trả "kho đang chuẩn bị hàng"): ORDER_STATUS với đơn đã quá
    // 4 ngày (chưa giao xong), hay khách than "mãi/lâu/chưa nhận" → DELIVERY_DELAY (xin lỗi, theo dõi giao) + thẻ cần người.
    const orderStatusText = String(recentOrder?.pos?.status || recentOrder?.status || '');
    const orderDone = /giao thành công|đã giao|da giao|đã nhận|hoàn thành|delivered|completed|hoàn|hủy|huy/i.test(orderStatusText);
    const complainsLate = /(?<![\p{L}])mãi(?![\p{L}])/iu.test(String(message.text || '').normalize('NFC'))
      || /\b(?:lau (?:qua|vay|the|roi|ghe|lam)|bao lau roi|chua (?:nhan|thay|toi|den|ve)(?: duoc| dc)?(?: hang| don)?|van chua (?:nhan|thay|giao|toi))\b/.test(folded);
    if (reply.templateId === 'ORDER_STATUS' && recentOrder?.id && isActiveOrder(recentOrder) && !orderDone && templates?.DELIVERY_DELAY && !reply.order
      && (Date.now() - (Number(recentOrder.createdAt) || Date.now()) > 4 * 24 * 60 * 60 * 1000 || complainsLate)) {
      const delay = renderChatbotReply({ template_id: 'DELIVERY_DELAY' }, templates, replyContext);
      if (delay.templateId === 'DELIVERY_DELAY' && !delay.handoff) reply = { ...delay, attention: true };
    }
    // R16 (inbox3 A5 ca …3440168818 "Uh ở xa quá nên hơi lâu e nhỉ", A11): khách KHÔNG có đơn nào (chưa hủy) trong 14 ngày mà mô hình
    // chọn "xin lỗi đơn giao chậm" → mẫu chính sách giao hàng (thời gian giao), không thẻ khiếu nại / cần người.
    const orderIn14Days = allOrders.some(order => isActiveOrder(order) && Date.now() - (Number(order?.createdAt) || 0) < 14 * 24 * 60 * 60 * 1000);
    if (reply.templateId === 'DELIVERY_DELAY' && !orderIn14Days && !reply.order && templates?.SHIPPING_POLICY) {
      const policy = renderChatbotReply({ template_id: 'SHIPPING_POLICY' }, templates, replyContext);
      if (policy.templateId === 'SHIPPING_POLICY' && !policy.handoff) {
        console.log(`DELIVERY_DELAY khi khách chưa có đơn 14 ngày: đổi sang SHIPPING_POLICY (${conversation.id})`);
        reply = { ...policy, ...(reply.pendingOrder !== undefined ? { pendingOrder: reply.pendingOrder } : {}) };
      }
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
    // R14: câu chê hàng CHỖ KHÁC ("bữa mua ở chỗ khác … dở") không phải khiếu nại với shop (mentionsOtherSeller, auto-label).
    // R15 (bình luận A3, ca …076080 "Bán mà nói nhỏ xíu sao nghe"): góp ý phiên live tính TRƯỚC lời chê — mô hình chọn
    // CSKH_HANDOFF cho câu góp ý thì không còn bị coi là khiếu nại (xin lỗi công khai + "chuyển bạn phụ trách đơn hàng").
    // Chủ shop 03/10 (quyết định 11): góp ý live chỉ cảm ơn công khai, không nhắn riêng.
    const liveFeedbackText = conversation.source === 'comment' && (() => {
      const plain = folded.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
      return LIVE_FEEDBACK.test(plain) || LIVE_FEEDBACK_EXTRA.test(plain);
    })();
    const commentComplaint = conversation.source === 'comment' && !mentionsOtherSeller(message.text) && (
      isComplaint({ text: message.text, keywords: settings.complaintKeywords })
      || /(?<![\p{L}\p{N}])hôi(?![\p{L}\p{N}])/iu.test(String(message.text || '').normalize('NFC'))
      || /\b(khong|ko|k|kg|hong|cha|chang) (co |thay |an )?ngon\b|\b(te|do|chan) (qua|that|ghe|ec|lam)\b|\bkem (chat luong|qua)\b/.test(folded)
      // Vòng 12 (B4 #1, #2, #10): "Hok ngon nha", "ăn món này ối luôn", "không nuốt nổi", "khó ăn", "ngọt quá", "toàn gãy nứt".
      || COMMENT_DISLIKE.test(folded.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim())
      || /(?<![\p{L}\p{N}])(?:ối|ói)(?![\p{L}\p{N}])/iu.test(String(message.text || '').normalize('NFC'))
      // R14 (quyết định 4; bình luận C1, dl P2): "Không như quảng cáo", "không đúng với quoảng cáo", "mua về mở ra toàn yến
      // mạch", "Dỡ" — mô hình chọn đúng CSKH_HANDOFF nhưng bình luận bị ép về bảng giá + "em đã nhắn tin cho mình rồi".
      || complainsAboutProduct(message.text)
      // Mô hình chọn CSKH_HANDOFF cho bình luận không phải câu hỏi giá/mua/đơn, không đòi gặp người: là lời chê/khiếu nại.
      || (chosenTemplateId === 'CSKH_HANDOFF' && reply.templateId === 'CSKH_HANDOFF' && !asksForHuman && !commentIsRequest(message.text) && !liveFeedbackText));
    // Vòng 12 (B4 #9): góp ý phiên live (nghe không rõ, nói nhanh, "như đọc rap", lag) → cảm ơn góp ý công khai + thẻ, không bảng giá.
    const liveFeedback = liveFeedbackText && !commentComplaint;
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
      reply = { ...renderChatbotReply({ template_id: 'COMMENT_STAFF_FOLLOWUP' }, templates, replyContext), attention: true, ...(carriedOrder ? { pendingOrder: carriedOrder } : {}), ...(commentComplaint ? { complaint: true } : {}) };
    }
    const commentBlocked = new Set(['CSKH_HANDOFF', 'WELCOME', 'ASK_PRODUCT', 'IMAGE_RECEIVED']);
    if (commentBlocked.has(reply.templateId) && !asksForHuman && conversation.source === 'comment' && templates?.GENERAL_INFO) {
      reply = commentRuleReply();
    }
    // Bình luận nêu rõ giỏ ("C 2 túi vàng", "túi vàng với túi xanh lá") mà model
    // trả bảng giá/so sánh: lên bước xin SĐT/địa chỉ với giỏ đó. Có kèm câu hỏi
    // ("combo 2 túi vàng bn") thì vẫn trả lời câu hỏi, nhưng giỏ đi theo khách
    // sang hộp thư để khách nhắn địa chỉ là chốt được.
    const basketDetail = {};
    const basket = conversation.source === 'comment' && !commentNeedsStaff && !commentOrderOp ? commentBasket(message.text, basketDetail) : [];
    const softForBasket = new Set(['PRICE_QUOTE', 'PRICE_MIX_TUI_LON', 'BAG_COMPARISON', 'BAG_COMPARISON_XANH_VANG', 'GENERAL_INFO', 'LIVESTREAM_COMMENT', 'LIVESTREAM_VOUCHER', 'COMMENT_STAFF_FOLLOWUP', 'ORDER_STATUS']);
    if (basket.length && softForBasket.has(reply.templateId) && !(reply.templateId === 'ORDER_STATUS' && recentOrder?.id)) {
      const slots = ['Product_N1', 'No_A', 'Product_N2', 'No_B', 'Product_N3', 'No_C'];
      const value = { template_id: 'ORDER_ADDRESS' };
      basket.slice(0, 3).forEach((item, index) => { value[slots[index * 2]] = item.product; value[slots[index * 2 + 1]] = String(item.quantity); });
      const orderReply = renderChatbotReply(value, templates, replyContext);
      // R14 (dl P4, ca …853104): "1 xanh 1 vàng nhiêu tiền" là HỎI GIÁ giỏ (mô hình chọn đúng PRICE_MIX_TUI_LON) — trước đây
      // thiếu "nhieu tien/bnh/tong" nên bị đổi thành bước xin SĐT/địa chỉ. "gia" của địa danh (Gia Lai…) không tính.
      const asksInfo = /\?|\b(gia|bn|bnh|bnhieu|bnhiu|bao nhieu|bao nhiu|nhieu tien|nhiu tien|het bao nhieu|tong|khac|sao|ntn|the nao|gam|gram|ngon|nao)\b/.test(foldVietnamese(maskPlaceGia(String(message.text || ''))));
      // R16 (inbox4 H2, inbox1 A5): câu HỎI chỉ mang giỏ sang hộp thư khi có số túi / chữ số lượng / động từ mua ("combo 2 túi vàng
      // bn", "lấy 1 xanh 1 vàng giá sao") — câu so sánh "túi vàng khác túi xanh sao" không lập giỏ (bám đuổi từng nhắc "giữ đơn").
      const askFolded = foldVietnamese(maskPlaceGia(String(message.text || ''))).replace(/\s+/g, ' ');
      const basketIntent = /\b(?:lay|mua|chot|dat|ship|combo|cho (?:em|minh|chi|c|e|toi|tui|anh|a))\b/.test(askFolded)
        || /(?<![\d.,])\d{1,2} ?(?:tui|goi|bich|hop)\b/.test(askFolded) || /\b(?:hai|ba|bon|nam) (?:tui|goi|bich|hop)\b/.test(askFolded)
        || /(?<![\d.,])\d{1,2} ?(?:mau |vi )?(?:xanh|vang|nau|cacao)\b/.test(askFolded);
      reply = asksInfo ? (basketIntent ? { ...reply, pendingOrder: orderReply.pendingOrder } : reply) : orderReply;
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
    // R14 (bình luận N1): "3 túi vàng, xanh" — số túi không khớp số vị (commentBasket không tự chia) → hỏi vị, giữ 3 túi.
    const askSplit = conversation.source === 'comment' && !basket.length && !unknownBasketComment && !commentNeedsStaff && Number(basketDetail.askCount) > 0 && Boolean(templates?.ASK_FLAVOR);
    if (guessedFlavour || askSplit) {
      const ask = renderChatbotReply({ template_id: 'ASK_FLAVOR' }, templates, replyContext);
      const count = askSplit ? Number(basketDetail.askCount) : bagCountInText(message.text);
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
      // R14 (inbox1 C2, inbox2 M2, bình luận M3): CHỈ khi khách thật sự báo đã săn/đã đặt (claimsLiveDeal) — không còn đổi mọi
      // ORDER_STATUS của mô hình: "Thôi dẹp khỏi mua", "Kg có mua nhé" (từ chối), "Săn ntn ạh" (hỏi cách săn), "Mình đã mua,
      // ăn ngon nha" (khen) từng nhận "em ghi nhận đã săn deal trên live".
      && claimsLiveDeal(message.text);
    const refusal = !nonText && refusesPurchase(message.text);
    const praiseAfterBuy = !nonText && praisesAfterBuying(message.text);
    const howToHunt = !nonText && asksHowToHunt(message.text);
    if (liveDeal) reply = { ...renderChatbotReply({ template_id: 'LIVE_DEAL_CLAIMED' }, templates, replyContext), attention: true };
    // Khách nói bấm nhầm / TỪ CHỐI mua khi đang giữ giỏ (chưa có đơn) mà mô hình kể trạng thái đơn / luật ghi nhận săn deal:
    // ghi nhận, bỏ giỏ — không "chưa thấy đơn", không "đã săn deal".
    else if ((saysMisclick || refusal) && basketHeld && !recentOrder?.id && conversation.source !== 'comment' && ['ORDER_STATUS', 'LIVE_DEAL_CLAIMED', 'ORDER_ADDRESS', 'ORDER_ADDRESS_REMIND'].includes(reply.templateId) && !reply.order && templates?.ORDER_POSTPONED) {
      const postponed = renderChatbotReply({ template_id: 'ORDER_POSTPONED' }, templates, replyContext);
      if (postponed.templateId === 'ORDER_POSTPONED') reply = { ...postponed, pendingOrder: null };
    } else if (reply.templateId === 'LIVE_DEAL_CLAIMED' && !claimsLiveDeal(message.text)) {
      // Luật/mô hình chọn "đã săn deal" cho tin không báo đã săn: từ chối → hoãn; khen sau khi mua → cảm ơn (bình luận: chỉ cảm
      // ơn công khai, không nhắn riêng); hỏi cách săn / còn lại → lời chào live (vị, giá, ưu đãi, mời chọn loại + số lượng).
      const routedId = refusal && templates?.ORDER_POSTPONED ? 'ORDER_POSTPONED'
        : praiseAfterBuy && templates?.THANK_YOU ? 'THANK_YOU'
          : templates?.LIVESTREAM_COMMENT && (isLivestreamPost(conversation) || replyContext.livestream) ? 'LIVESTREAM_COMMENT' : 'ORDER_HELP';
      const routed = renderChatbotReply({ template_id: routedId }, templates, replyContext);
      if (!routed.handoff) reply = { ...routed, ...(routedId === 'ORDER_POSTPONED' && basketHeld ? { pendingOrder: null } : {}), ...(howToHunt || routedId === 'ORDER_HELP' ? { attention: true } : {}) };
    } else if (reply.templateId === 'ORDER_STATUS' && !recentOrder?.id && !reply.order && (isLivestreamPost(conversation) || replyContext.livestream)) {
      // Dưới live, mô hình kể "trạng thái đơn" cho câu không hỏi đơn: hỏi cách săn → lời chào live; khen → cảm ơn; từ chối → hoãn.
      const routedId = howToHunt && templates?.LIVESTREAM_COMMENT ? 'LIVESTREAM_COMMENT' : praiseAfterBuy && templates?.THANK_YOU ? 'THANK_YOU' : refusal && templates?.ORDER_POSTPONED ? 'ORDER_POSTPONED' : '';
      const routed = routedId ? renderChatbotReply({ template_id: routedId }, templates, replyContext) : null;
      if (routed && !routed.handoff) reply = routed;
    }
    // R16 (inbox1 A5 ca …0716122894 "da nhan hang roi nen kg mua nua"; bình luận D): khách nói KHÔNG mua nữa khi bot còn giữ giỏ
    // (thường là giỏ mang từ bình luận) → xoá giỏ (bám đuổi không nhắc giỏ nữa), đáp cảm ơn / hẹn dịp khác, không "chưa thấy đơn",
    // không chuyển bạn phụ trách.
    if (!nonText && conversation.source !== 'comment' && !reply.order && !reply.staffWait && !conversation.pendingOrder?.awaitingConfirm && declinesBuyingMore(message.text)
      && (basketHeld || ['ORDER_STATUS', 'ORDER_ADDRESS_REMIND', 'ORDER_ADDRESS', 'LIVE_DEAL_CLAIMED'].includes(reply.templateId))) {
      const receivedAlready = /\b(?:da )?nhan (?:duoc )?hang roi\b|\bda mua roi\b|\bmua roi\b/.test(foldVietnamese(String(message.text || '')));
      const declineId = receivedAlready && templates?.THANK_YOU ? 'THANK_YOU' : templates?.ORDER_POSTPONED ? 'ORDER_POSTPONED' : 'THANK_YOU';
      const declined = renderChatbotReply({ template_id: declineId }, templates, replyContext);
      if (!declined.handoff && declined.messages?.length) {
        console.log(`Khách nói không mua nữa khi còn giỏ: xoá giỏ, ${declineId} (${conversation.id})`);
        reply = { ...declined, pendingOrder: null, declinedBasket: true };
      }
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
    // R15 (inbox1 A3, bình luận A6, ca …6422098884): ý phụ (also) do mô hình thêm mà CÙNG MẪU đã gửi tới khách dưới 30 phút (hộp
    // thư hay tin riêng từ bình luận — mẫu cuối của hộp thư) và tin khách không phải câu hỏi → bỏ ý phụ, chỉ gửi phần chính
    // ("Túi vàng <sđt>" 3 phút sau câu calo không nhận lại nguyên đoạn 445 Kcal).
    if (reply.alsoPart && reply.alsoTemplateId && !answeredWhileHeld && !/\?/.test(String(message.text || ''))) {
      const sentWithin = record => record && record.botLastTemplateId === reply.alsoTemplateId && Date.now() - (Number(record.botLastReplyAt) || 0) < 30 * 60 * 1000;
      if (sentWithin(conversation) || sentWithin(inboxThread)) {
        const key = part => `${part.type}:${part.text || part.url}`;
        const alsoKeys = new Set((reply.alsoPart.parts || [...(reply.alsoPart.messages || []).map(text => ({ type: 'text', text })), ...(reply.alsoPart.images || []).map(url => ({ type: 'image', url }))]).map(key));
        const parts = partsOfReply(reply).filter(part => !alsoKeys.has(key(part)));
        if (parts.some(part => part.type === 'text')) {
          console.log(`Bỏ ý phụ ${reply.alsoTemplateId}: cùng mẫu vừa gửi tới khách < 30 phút (${conversation.id})`);
          reply = { ...reply, parts, messages: parts.filter(part => part.type === 'text').map(part => part.text), images: parts.filter(part => part.type === 'image').map(part => part.url), alsoTemplateId: undefined, alsoPart: undefined };
        }
      }
    }
    // R16 (inbox2 C4, ca …9939622934 "Dễ ăn ko e / Có dừa khô k", …7325666033 "Chị gửi nhé" ngay sau phiếu xác nhận): đơn bot vừa
    // tạo < 60 phút (không giữ giỏ mới) — (a) bỏ câu kèm mời mua (RECOMMEND_BEGINNER, mời 2 túi, hỏi vị…) khi tin không hỏi giá /
    // đặt thêm; (b) tin đáp ngắn ("gửi nhé", "ok", "vâng", "cảm ơn", "chị gửi") mà mô hình chọn bảng giá / lời chào live / hỏi vị
    // → lời cảm ơn.
    const freshOrder = conversation.source !== 'comment' && Boolean(recentOrder?.id) && isActiveOrder(recentOrder) && Date.now() - (Number(recentOrder.createdAt) || 0) < 60 * 60 * 1000
      && !reply.order && !basketHeld && !(Array.isArray(reply.pendingOrder?.items) && reply.pendingOrder.items.length);
    if (freshOrder && !asksPriceText(message.text) && !asksToAdd(folded)) {
      const inviteAlso = new Set(['RECOMMEND_BEGINNER', 'ASK_FLAVOR_NGUYENBAN', 'COMBO3_FLAVOR', 'UPSELL_TWO_BAGS', 'ASK_TWO_BAGS', 'ASK_REORDER', 'PRICE_COUNT', 'ASK_FLAVOR', 'ASK_PRODUCT', 'PRICE_QUOTE', 'GENERAL_INFO']);
      if (reply.alsoPart && inviteAlso.has(String(reply.alsoTemplateId || ''))) {
        const key = part => `${part.type}:${part.text || part.url}`;
        const alsoKeys = new Set(partsOfReply(reply.alsoPart).map(key));
        const parts = partsOfReply(reply).filter(part => !alsoKeys.has(key(part)));
        if (parts.some(part => part.type === 'text')) {
          console.log(`Đơn vừa tạo < 60 phút: bỏ câu kèm mời mua ${reply.alsoTemplateId} (${conversation.id})`);
          reply = { ...reply, parts, messages: parts.filter(part => part.type === 'text').map(part => part.text), images: parts.filter(part => part.type === 'image').map(part => part.url), alsoTemplateId: undefined, alsoPart: undefined };
        }
      }
      const shortReplyText = foldVietnamese(String(message.text || '')).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
      const ackOnly = message.type === 'text' && shortReplyText.length > 0 && shortReplyText.length <= 30
        && /^(?:(?:ok|oke|okie|okay|vang|da|u|uh|um|cam on|camon|thanks|thank|tks|nhe|nha|nhen|a|ah|e|em|shop|c|chi|minh|anh|gui|di|luon|roi|r|duoc|dc|vay|the|nhe)\s*)+$/.test(shortReplyText);
      if (ackOnly && ['LIVESTREAM_COMMENT', 'GENERAL_INFO', 'ASK_FLAVOR', 'ASK_PRODUCT', 'PRICE_QUOTE', 'PRICE_MIX_TUI_LON'].includes(reply.templateId) && templates?.THANK_YOU) {
        const thanks = renderChatbotReply({ template_id: 'THANK_YOU' }, templates, replyContext);
        if (thanks.templateId === 'THANK_YOU') { console.log(`Đơn vừa tạo, tin đáp ngắn: ${reply.templateId} → THANK_YOU (${conversation.id})`); reply = thanks; }
      }
    }
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
      // R15 (chủ shop 03/10, quyết định 4; inbox3 A4 ca …734014): hạt điều / hạt bí / sữa hạt / hũ hạt — khách live hỏi cũng chuyển
      // nhân viên (STAFF_ONLY_PRODUCT + thẻ) như khách thường, không "giữ giá live, lên đơn".
      const nutsAsked = !nonText && /\b(?:hat dieu|hat bi|sua hat|hu hat)\b/.test(folded);
      const liveListed = !nonText && !nutsAsked && liveOnlyProductPattern.test(folded) && !/\bxoai dau\b/.test(folded);
      const tropicalProduct = !nonText && mentionsTropical(message.text) ? findProductBySku('GRA-MINT-Z300') : null;
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
    // R14 (bình luận C2; ca …039804 "Mua sao shop ơi", …918439 ".", …551125 "Bên em đang xác nhận đơn không đúng"): khách
    // vừa bấm giỏ Shop / đang được giữ giỏ ở hộp thư (< 24 giờ) hay vừa có đơn mà bình luận hỏi giá / "." / "mua sao" → tin
    // riêng là câu NHẮC GIỎ đang giữ (giỏ + tổng + phần còn thiếu), không gửi bảng giá live chung (174k lệch 189k của giỏ làm
    // khách rối). Có đơn mới (24 giờ) → kể đơn đang có. ORDER_WRONG lúc hộp thư có giỏ/giỏ Shop/đơn → bạn phụ trách nhắn
    // (COMMENT_STAFF_FOLLOWUP) + thẻ, không "nhắn giúp em loại túi và số lượng đúng".
    // R15 (bình luận A4, ca …024372 "Combo 2 túi vàng giá bao nhiêu được tặng gì e" khi hộp thư đang giữ giỏ 2 Vàng): bình luận
    // hỏi giá / quà mà hộp thư đang giữ giỏ (< 24 giờ) — giỏ trong bình luận (nếu có) trùng giỏ đang giữ → tin riêng là câu quà
    // (khách live: Quạt + Bát gáo dừa; bỏ câu mời chọn) + nhắc giỏ đang giữ và phần còn thiếu, không gửi cả bảng giá live.
    let commentHeldReminded = false;
    if (conversation.source === 'comment' && inboxThread && !unknownBasketComment && !commentNeedsStaff && !reply.order && !liveFeedback && !extractVietnamesePhone(String(message.text || ''))) {
      const heldInbox = Array.isArray(inboxThread.pendingOrder?.items) && inboxThread.pendingOrder.items.length && !inboxThread.pendingOrder.postponed
        && Date.now() - (Number(inboxThread.pendingOrder.at) || 0) < 24 * 60 * 60 * 1000 ? inboxThread.pendingOrder : null;
      const keyOf = items => (items || []).map(item => `${String(item.code || matchProduct(String(item.product || ''))?.sku || item.product || '').toUpperCase()}=${Number(item.quantity) || 1}`).sort().join('|');
      const sameAsHeld = !basket.length || (heldInbox && keyOf(basket) === keyOf(heldInbox.items));
      const asksGift = /\b(?:qua|tang|khuyen mai|km)\b/.test(folded);
      const asksPrice = asksPriceText(message.text);
      if (heldInbox && sameAsHeld && (asksGift || asksPrice) && (commentPriceFamily.has(reply.templateId) || /^GIFT_POLICY/.test(reply.templateId) || isOrderStep(reply.templateId))) {
        const heldContext = { ...replyContext, pendingOrder: heldInbox, lastTemplateId: 'ORDER_ADDRESS' };
        const remind = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, heldContext).remind || '';
        const giftId = replyContext.livestream && templates?.GIFT_POLICY_LIVE ? 'GIFT_POLICY_LIVE' : templates?.GIFT_POLICY ? 'GIFT_POLICY' : '';
        const gift = asksGift && giftId ? renderChatbotReply({ template_id: giftId }, templates, heldContext) : null;
        const giftLines = gift?.templateId === giftId ? gift.messages.map(text => withoutInviteTail(text)).filter(text => /\p{L}/u.test(text)) : [];
        if (remind) {
          reply = { templateId: 'ORDER_ADDRESS_REMIND', messages: [...giftLines, remind], images: [], parts: undefined, handoff: false, ...(giftLines.length ? { alsoTemplateId: giftId } : {}) };
          commentHeldReminded = true;
        }
      }
    }
    if (conversation.source === 'comment' && inboxThread && !commentHeldReminded && !basket.length && !unknownBasketComment && !commentNeedsStaff && !reply.order && !reply.pendingOrder?.items?.length) {
      const dayMs = 24 * 60 * 60 * 1000;
      const inboxPending = Array.isArray(inboxThread.pendingOrder?.items) && inboxThread.pendingOrder.items.length && !inboxThread.pendingOrder.postponed
        && Date.now() - (Number(inboxThread.pendingOrder.at) || 0) < dayMs ? inboxThread.pendingOrder : null;
      const inboxShopCart = inboxMessages.some(item => item?.direction === 'incoming' && ((Array.isArray(item.cart) && item.cart.length) || isShopCartText(item.text)) && Date.now() - (Number(item.createdAt) || 0) < dayMs);
      // Bình luận hỏi giá một món cụ thể ("túi vàng bn") vẫn được báo giá món đó.
      const priceLike = commentPriceFamily.has(reply.templateId) && !/\b(xanh|vang|nau|cacao|socola|mint|tropical|hop|goi nho|10 goi|yen mach)\b/.test(folded);
      if (reply.templateId === 'ORDER_WRONG' && (inboxPending || inboxShopCart || hasOrder) && templates?.COMMENT_STAFF_FOLLOWUP) {
        reply = { ...renderChatbotReply({ template_id: 'COMMENT_STAFF_FOLLOWUP' }, templates, replyContext), attention: true };
      } else if (priceLike && inboxPending) {
        const remind = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, { ...replyContext, pendingOrder: inboxPending, lastTemplateId: 'ORDER_ADDRESS' }).remind || '';
        if (remind) reply = { templateId: 'ORDER_ADDRESS_REMIND', messages: [remind], images: [], parts: undefined, handoff: false };
      } else if (priceLike && hasOrder && recentOrder?.id && templates?.ORDER_STATUS) {
        const status = renderChatbotReply({ template_id: 'ORDER_STATUS' }, templates, replyContext);
        if (status.templateId === 'ORDER_STATUS' && !status.handoff) reply = status;
      }
    }
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
    const tropicalNamed = !nonText && mentionsTropical(message.text);
    if (tropicalNamed && createsBasket(reply) && !mintBasket) {
      const tropical = findProductBySku('GRA-MINT-Z300');
      if (tropical) reply = { ...renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: tropical.name }, templates, replyContext), attention: true, pendingOrder: undefined, order: undefined };
    }
    if (nonText && !paymentReply && createsBasket(reply) && !namedProductBefore && !(message.withImage && /\b(tui|goi|bich|hop|combo|xanh|vang|nau|cacao|lay|dat|mua|chot)\b/.test(folded))) reply = imageFallback();
    else if (photoOnly && createsBasket(reply)) reply = { ...renderChatbotReply({ template_id: 'PRODUCT_PHOTOS', ...(productHint(ruleProduct) ? { Product_N1: ruleProduct } : {}) }, templates, replyContext), pendingOrder: undefined, order: undefined };
    else if (!nonText && liveOnlyMention && createsBasket(reply) && !mintBasket) {
      // R15 (quyết định 4): hạt (điều/bí/sữa hạt/hũ hạt) → bạn phụ trách (STAFF_ONLY_PRODUCT), kể cả khách live.
      const nutsId = /\b(?:hat dieu|hat bi|sua hat|hu hat)\b/.test(folded) && templates?.STAFF_ONLY_PRODUCT ? 'STAFF_ONLY_PRODUCT' : 'LIVE_ONLY_PRODUCT';
      const liveOnly = renderChatbotReply({ template_id: nutsId, values: { product: 'sản phẩm mình hỏi' } }, templates, replyContext);
      reply = { ...(liveOnly.templateId === nutsId ? liveOnly : renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, templates, replyContext)), attention: true, pendingOrder: undefined, order: undefined };
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
    // R16 (inbox1 B3 ca …9061486243 "Bên em có mấy loại" → bảng 3 vị khác bảng Túi Xanh vừa gửi dù cùng mã GENERAL_INFO): "lặp tin
    // vừa gửi" so bằng CHỮ đã soạn — cùng mã mẫu mà câu đầu khác tin Page vừa gửi (60 giây) thì không phải lặp.
    const sameTextJustSent = !firstLine || recent.some(item => item?.direction === 'outgoing' && Date.now() - (Number(item.createdAt) || 0) < 2 * 60 * 1000 && normalizeSent(item.text).includes(firstLine));
    const repeatsTemplate = noRepeatTemplates.has(reply.templateId) && conversation.botLastTemplateId === reply.templateId && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 60 * 1000
      && sameTextJustSent;
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
    // R15 (inbox3 A3, ca …027555): bình luận live "Hai xanh lá <sđt>" được Facebook đẩy thêm đúng câu đó vào hộp thư → bot trả
    // lời hai lần y hệt (+ thẻ). SĐT / địa chỉ chỉ là thông tin MỚI khi khác SĐT / địa chỉ của giỏ đang giữ (hay đơn gần nhất).
    const heldForInfo = conversation.pendingOrder && typeof conversation.pendingOrder === 'object' ? conversation.pendingOrder : null;
    const knownPhones = [heldForInfo?.phone, hasOrder ? recentOrder?.phone : ''].map(toLocalPhoneDigits).filter(Boolean);
    const newPhoneInText = Boolean(phoneInText) && !knownPhones.includes(toLocalPhoneDigits(phoneInText));
    const squashAddress = value => foldVietnamese(String(value || '')).replace(/[^a-z0-9]+/g, '');
    const typedAddressNow = squashAddress(stripPhone(String(message.text || '')));
    const knownAddresses = [heldForInfo?.address, hasOrder ? recentOrder?.rawAddress || recentOrder?.address : ''].map(squashAddress).filter(value => value.length >= 8);
    const newAddressInText = Boolean(trace.ctx?.addressInText) && !knownAddresses.some(known => known.includes(typedAddressNow) || typedAddressNow.includes(known));
    // Bản sao của tin vừa xử lý: cùng SĐT (± cùng địa chỉ) với giỏ/đơn, bot vừa trả lời (≤ 2 phút), và tin y hệt bình luận /
    // tin trước của khách hay giỏ đi từ bình luận sang (fromComment) — im, không thẻ, không nhắc giỏ.
    const sameTextBefore = [...recentComments, ...recentCustomerTexts.slice(0, -1)].some(text => squashText(text) === squashText(message.text));
    const echoOfHandled = !nonText && !isComment && Boolean(phoneInText) && !newPhoneInText && !newAddressInText && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 2 * 60 * 1000
      && (sameTextBefore || heldForInfo?.fromComment === true);
    const newInfoText = !nonText && !isComment && (newPhoneInText || newAddressInText
      || /\b(?:dia chi|dc|d c|dchi) cu\b|\bnhu (?:cu|lan truoc)\b/.test(folded)
      || CANCEL_ORDER.test(folded) || HOLD_DELIVERY.test(folded) || DELIVERY_NOTE.test(folded));
    // R13: lời xin SĐT/địa chỉ của giỏ Shop sau tin "đã nhận giỏ, chờ em kiểm tra" (cartAckSent) không phải lặp.
    // R15: câu hỏi lại vị khi khách nêu vị thứ hai sau "N ≥ 3 túi" (flavourSplit 'ask') là câu hỏi mới, không phải lặp.
    const repeatsBeforeInfo = (repeatsText || repeatsTemplate) && !changedCart && !orderAction && !answeredWhileHeld && !cartAckSent && !reply.flavourSplit;
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
    // R16 (inbox3 A4, ca …8987226913: khách gửi SĐT hai lần → hai câu "đã nhận SĐT… lấy vị nào" giống hệt): câu hỏi vị y nguyên đã
    // gửi trong 10 phút → không gửi lại (SĐT/địa chỉ mới vẫn lưu vào giỏ chờ).
    if (!isComment && ['ASK_FLAVOR', 'ORDER_INFO_ASK_FLAVOR'].includes(reply.templateId) && !reply.order && !repeatsLast && normalizeSent(reply.messages?.[0] || "").length > 20
      && recent.some(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo && normalizeSent(item.text).includes(normalizeSent(reply.messages[0])))) {
      console.log(`Câu hỏi vị y nguyên đã gửi < 10 phút: không gửi lại, giữ thông tin mới (${conversation.id})`);
      reply = { ...reply, messages: [], parts: [], images: [] };
    }
    const repeatsHandoff = reply.templateId === 'CSKH_HANDOFF' && conversation.botLastTemplateId === 'CSKH_HANDOFF'
      && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 24 * 60 * 60 * 1000;
    // R15 (inbox4 A2): khách bấm lại ĐÚNG giỏ Shop đang giữ (cùng khoá giỏ) — nhắc giỏ tối đa một lần mỗi 30 phút; đã nhắc thì
    // im, không thẻ cần người (bấm giỏ không phải câu hỏi chờ người trả lời).
    const sameCartAgain = Boolean(cartReply) && !shopOrder && basketHeld && Boolean(cartReply.pendingOrder?.key)
      && String(cartReply.pendingOrder.key) === String(conversation.pendingOrder?.key || '') && reply.templateId === cartReply.templateId;
    if (sameCartAgain && conversation.botLastTemplateId === 'ORDER_ADDRESS_REMIND' && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 30 * 60 * 1000) {
      if (change.message?.id || change.message?.mid) await saveBotState(conversation.id, { botHandledMessageId: String(change.message.id || change.message.mid) }).catch(() => {});
      results.push({ conversationId: conversation.id, skipped: 'giỏ Shop trùng giỏ đang giữ (đã nhắc)' });
      return;
    }
    if (repeatsLast || repeatsHandoff) {
      // Chỉ im lặng với lời đáp ngắn ("ok", "dạ") hay khi đã chuyển người; khách
      // nhắn có nội dung mà bot sắp lặp lại tin vừa gửi thì không để khách chờ:
      // - bước đơn (xin SĐT/địa chỉ): nhắc ngắn giỏ + tổng + phần còn thiếu;
      // - bảng giá: nhắc "đã gửi ở trên" và mời chốt (chỉ khi chưa có đơn);
      // - thông tin khác: nói đã gửi ở trên, gắn thẻ để nhân viên giải thích thêm.
      // R15: bản sao tin vừa xử lý (echoOfHandled) không phải tin có nội dung mới — im, không nhắc, không thẻ.
      const substantive = !shortAck && message.type === 'text' && folded.replace(/\s+/g, '').length >= 2 && !echoOfHandled;
      // R16 (inbox4 H5 ca …527762 "Cảm ơn em" sau lời cảm ơn; vòng 16 bình luận B1 "Hix"): lời cảm ơn / chào trùng câu vừa gửi, hay
      // tin cảm thán ngắn không hỏi gì ("Hix", "huhu", "ôi", "à vâng") → im, KHÔNG báo bạn phụ trách, không thẻ cần người.
      const exclaimOnly = message.type === 'text' && isExclamationOnly(message.text);
      const courtesyRepeat = ['THANK_YOU', 'WELCOME'].includes(reply.templateId) || ruled?.rule === 'THANKS' || exclaimOnly;
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
      // R15 (inbox2 A6, ca …990595 "Goi nho du vi ko" → mẫu bao bì → "Goi nho du vi"): khách HỎI LẠI đúng câu ngay sau câu trả lời
      // THÔNG TIN của bot tức là câu trả lời trước chưa đúng ý — không bảo "em vừa gửi ở tin ngay trên"; báo bạn phụ trách trả
      // lời (STAFF_WAIT_* bên dưới, 1 lần/2 giờ + thẻ) như vòng 14. Chỉ giục ("???", "alo") hay hỏi lại GIÁ sau bảng giá thì như cũ.
      const repeatsUnanswered = customerRepeats && !nudgeLike && nudgeId === 'REPLY_ALREADY_SENT_INFO';
      const canNudge = repeatsLast && !answerAgain && !remindOrder && informational && substantive && (customerRepeats || nudgeLike) && templates?.[nudgeId]
        && !['REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO'].includes(conversation.botLastTemplateId) && !isComment && !repeatsUnanswered;
      // R13 (inbox1 A3, inbox2 B4 — 53 lượt "lặp tin vừa gửi" trong 3 ngày, ~30 lượt là câu hỏi có nội dung): câu trả lời
      // trùng tin vừa gửi mà khách hỏi ý MỚI (tin có nội dung, không lặp câu trước, không phải giục) → gọi lại mô hình MỘT
      // lần với gợi ý "KHÔNG chọn lại <mẫu vừa gửi>" (tiền lệ: THANK_YOU cho tin không phải lời cảm ơn). Chỉ nhận câu trả lời
      // thông tin khác hẳn (không lên/sửa/hủy đơn, không chuyển người, không lặp tin vừa gửi); vẫn trùng → im + thẻ như cũ.
      // Khách hỏi lại GIÁ bằng lời khác mà bảng giá vừa gửi thì không gọi lại (mô hình bị ép chọn mẫu khác sẽ lạc đề).
      let rescued = null;
      const lastQuotedProduct = () => { const name = [...recent].reverse().filter(item => item?.direction === 'outgoing' && Date.now() - (Number(item.createdAt) || 0) < 30 * 60 * 1000).map(item => String(item.text || '').match(/Bảng giá (.+?) để/u)?.[1]).find(Boolean); return name ? matchProduct(name) : null; };
      // R16 (inbox4 T3, ca …558147 "Màu xanh min ạ" ngay sau bảng giá Tropical): trùng bảng giá CÙNG món vừa báo mà tin chỉ nêu
      // tên/màu món (không hỏi giá, không "?") = khách CHỌN món đó → bước đơn 1 túi (bộ soạn kèm lời mời 2 túi), không STAFF_WAIT.
      if (repeatsLast && !repeatsHandoff && !isComment && reply.templateId === 'PRICE_QUOTE' && conversation.botLastTemplateId === 'PRICE_QUOTE' && lastQuotedProduct()?.name
        && !asksPriceText(message.text) && !/\?/.test(String(message.text || '')) && folded.length <= 40 && !basketHeld
        && (CHOICE_FLAVOUR.test(choiceText(message.text)) || /\b(?:min|mint|bac ha)\b/.test(folded))) {
        const picked = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: lastQuotedProduct().name, No_A: '1' }, templates, replyContext);
        if (picked.templateId === 'ORDER_ADDRESS' && !picked.handoff && picked.messages?.length) {
          console.log(`Trùng bảng giá ${lastQuotedProduct().name} vừa báo, tin chỉ nêu món: khách chọn món → bước đơn 1 túi (${conversation.id})`);
          rescued = picked;
        }
      }
      const canRetryDifferent = !rescued && !canNudge && !answerAgain && !remindOrder && repeatsLast && !repeatsHandoff && substantive && !customerRepeats && !nudgeLike
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
        // R13 sửa (phản biện T2): câu lần hai không đi qua khối hậu xử lý (LIVESTREAM_* → mẫu thường khi không phải khách live;
        // gác đơn) → chặn thẳng ở đây: lời live cho khách không live, mọi mẫu nói về đơn đã có / sửa đơn / báo nhân viên sửa.
        const unusable = !again || again.handoff || Boolean(again.order) || Boolean(again.orderChange) || avoid.includes(again.templateId) || nudgeTemplateIds.includes(again.templateId)
          || ['THANK_YOU', 'WELCOME', 'CSKH_HANDOFF', 'IMAGE_RECEIVED', 'LIVE_DEAL_CLAIMED', 'LIVE_ONLY_PRODUCT', 'ASK_PRODUCT'].includes(again.templateId)
          || (['LIVESTREAM_COMMENT', 'LIVESTREAM_VOUCHER'].includes(again.templateId) && !liveContext)
          || ['ORDER_UNCHANGED', 'ORDER_UPDATE', 'ORDER_WRONG', 'ORDER_CHANGE_STAFF', 'ORDER_NOTE_ADDED', 'ORDER_CANCELLED'].includes(again.templateId)
          || String(again.templateId || '').startsWith('ORDER_EXISTING_CONFIRM')
          || (again.templateId === 'GENERAL_INFO' && !priceLikeText)
          || (isOrderStep(again.templateId) && !(again.pendingOrder?.key && again.pendingOrder.key !== conversation.pendingOrder?.key))
          || (createsBasket(again) && (tropicalNamed || liveOnlyMention || photoOnly))
          || (againLine.length > 20 && recent.some(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo && normalizeSent(item.text).includes(againLine)));
        if (!unusable) {
          console.log(`Trùng tin vừa gửi (${reply.templateId}) mà khách hỏi ý mới: mô hình chọn lại ${again.templateId} (${conversation.id})`);
          rescued = again.templateId === 'OTHER_PRODUCTS' ? { ...again, attention: true } : again;
        }
      }
      // R16 (bình luận B1, ca …486243 "Bên em có mấy loại" khi bảng 3 vị vừa gửi): câu hỏi chung "mấy/những loại" trùng bảng vị
      // vừa gửi mà hỏi lại mô hình không ra câu khác → nhắc "em đã gửi ở tin ngay trên" (REPLY_ALREADY_SENT), không chuyển người.
      if (!rescued && repeatsLast && !repeatsHandoff && !isComment && reply.templateId === 'GENERAL_INFO' && /\b(?:may|nhung|cac|bao nhieu) (?:loai|vi|mau)\b/.test(folded)
        && !['REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO'].includes(conversation.botLastTemplateId) && templates?.REPLY_ALREADY_SENT) {
        const nudged = renderChatbotReply({ template_id: 'REPLY_ALREADY_SENT' }, templates, replyContext);
        if (nudged.templateId === 'REPLY_ALREADY_SENT' && !nudged.handoff) rescued = { ...nudged, pendingOrder: reply.pendingOrder };
      }
      // R14 (chủ shop 03/10): 25 lượt/ngày bot im vì trùng tin vừa gửi, 7 khách chờ hơn 1 giờ (phần lớn buổi tối). Khách
      // hộp thư nhắn có nội dung mà không cứu được bằng câu khác → báo bạn phụ trách trả lời (trong giờ 8h–17h: ngay; ngoài
      // giờ: từ 8h sáng) + thẻ cần người. Mỗi hội thoại tối đa 1 lần mỗi 2 giờ; đã chuyển người trong 24 giờ thì vẫn im.
      // R15 (inbox4 A2, ca …195669 bấm CB-XANH+NAU 3 lần): tin giỏ Shop không phải câu hỏi — lần bấm thứ ba không "đã ghi nhận
      // câu hỏi, chuyển bạn phụ trách" (cartReply loại ra; giỏ trùng giỏ đang giữ thì im, không thẻ — xem nhánh im bên dưới).
      const staffWaitDue = !rescued && !canNudge && !answerAgain && !remindOrder && repeatsLast && !repeatsHandoff && substantive
        && !isComment && !nonText && !message.likeSticker && !cartReply && !courtesyRepeat
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
            ...(substantive && !repeatsHandoff && !sameCartAgain && !echoOfHandled && !courtesyRepeat ? { addLabelEvents: ['handoff'] } : {}),
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
    // R16 (inbox1 A3 ca …6011240055, inbox3 A4 ca …8987226913, inbox4 T6 ca …304408): giỏ do MÔ HÌNH tự suy ra mà khách chưa hề chọn
    // món → không lên đơn, hỏi vị (ORDER_INFO_ASK_FLAVOR), giữ SĐT + địa chỉ (+ số túi khách đã nêu) trong giỏ chờ.
    // R16 (inbox1 B6, ca …5994978260: 4 lần liền "em đã ghi chú yêu cầu… và báo kho rồi ạ"): lời dặn mới vẫn GHI vào đơn, nhưng
    // câu xác nhận ghi chú giống hệt câu đã gửi trong 30 phút thì không gửi lại.
    if (reply.order?.noteOrderId && !isComment && Array.isArray(reply.messages) && reply.messages.length) {
      const noteLine = normalizeSent(reply.messages[0]);
      const sentNoteRecently = noteLine.length > 20 && recent.some(item => item?.direction === 'outgoing' && Date.now() - (Number(item.createdAt) || 0) < 30 * 60 * 1000 && normalizeSent(item.text) === noteLine);
      if (sentNoteRecently) {
        // Lần dặn thứ hai: đáp ngắn "em ghi thêm rồi" MỘT lần; đã đáp ngắn trong 30 phút thì chỉ ghi chú, không gửi gì.
        const shortLine = normalizeSent(NOTE_ADDED_AGAIN);
        const shortSent = recent.some(item => item?.direction === 'outgoing' && Date.now() - (Number(item.createdAt) || 0) < 30 * 60 * 1000 && normalizeSent(item.text) === shortLine);
        console.log(`Câu xác nhận ghi chú đã gửi < 30 phút: ghi chú vào đơn, ${shortSent ? 'không gửi gì' : 'đáp ngắn'} (${conversation.id})`);
        reply = shortSent ? { ...reply, messages: [], parts: [], images: [] } : { ...reply, messages: [NOTE_ADDED_AGAIN], parts: undefined, images: [] };
      }
    }
    const customerChoice = (() => {
      const list = Array.isArray(recent) ? recent : [];
      const lastOutgoingAt = Math.max(0, ...list.filter(item => item?.direction === 'outgoing' && item.id !== change.message?.id).map(item => Number(item.createdAt) || 0));
      const incoming = list.filter(item => item?.direction === 'incoming' && item.type === 'text' && item.text && item.id !== change.message?.id
        && Date.now() - (Number(item.createdAt) || 0) <= 2 * 60 * 60 * 1000);
      const nowText = choiceText(message.text);
      const allTexts = [...incoming.map(item => choiceText(item.text)), ...recentComments.map(choiceText), nowText];
      return {
        afterAsk: [...incoming.filter(item => (Number(item.createdAt) || 0) > lastOutgoingAt).map(item => choiceText(item.text)), nowText],
        infoOnly: Boolean(phoneInText || trace.ctx?.addressInText) && !CHOICE_FLAVOUR.test(nowText) && !CHOICE_COUNT.test(nowText),
        namedNothing: !allTexts.some(text => CHOICE_FLAVOUR.test(text) || CHOICE_COUNT.test(text) || CHOICE_BUY.test(text))
      };
    })();
    const inferredBasket = (() => {
      if (isComment || cartReply || shopOrder || trialState || !reply.order || reply.order.updateOrderId || reply.order.cancelOrderId || reply.order.noteOrderId) return null;
      const held = conversation.pendingOrder && typeof conversation.pendingOrder === 'object' ? conversation.pendingOrder : null;
      if (held?.fromComment || held?.fromCart || held?.fromShop) return null;
      const heldItems = Array.isArray(held?.items) ? held.items : [];
      // (a) bot vừa hỏi vị, giỏ chờ chưa có món, khách chưa nêu vị nào sau câu hỏi đó.
      if (['ASK_FLAVOR', 'ORDER_INFO_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN', 'ASK_PRODUCT'].includes(conversation.botLastTemplateId) && !heldItems.length
        && !customerChoice.afterAsk.some(text => CHOICE_FLAVOUR.test(text))) return 'hỏi vị chưa được trả lời';
      // (b) khách CHỈ gửi SĐT/địa chỉ, cả cuộc (2 giờ, kể bình luận) chưa hề nêu vị, số túi, "combo" hay ý mua, và giỏ là của mô hình
      // (lượt này mô hình dựng, hay giỏ chờ mang cờ inferred do mô hình dựng ở lượt trước).
      if ((!heldItems.length || held?.inferred === true) && customerChoice.infoOnly && customerChoice.namedNothing) return 'khách chưa chọn món';
      return null;
    })();
    if (inferredBasket && templates?.ORDER_INFO_ASK_FLAVOR) {
      const asked = renderChatbotReply({ template_id: 'ORDER_INFO_ASK_FLAVOR', Phone_Number: reply.order.phone || phoneInText || '' }, templates, replyContext);
      if (asked.templateId === 'ORDER_INFO_ASK_FLAVOR' && asked.messages?.length) {
        console.log(`Giỏ do mô hình suy ra (${inferredBasket}): không lên đơn, hỏi vị (${conversation.id})`);
        const askLine = normalizeSent(asked.messages[0]);
        const askedAlready = askLine.length > 20 && recent.some(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo && normalizeSent(item.text).includes(askLine));
        const held = conversation.pendingOrder && typeof conversation.pendingOrder === 'object' ? conversation.pendingOrder : {};
        reply = { ...asked, order: undefined, pendingOrder: {
          items: [], key: '', at: Date.now(), phone: String(reply.order.phone || phoneInText || held.phone || ''), address: String(reply.order.rawAddress || reply.order.address || held.address || '').replace(/^\((?:live|freeship)\)\s*/i, ''),
          addressAsks: Number(held.addressAsks) || 0,
          ...(Number(held.askedBagCount) > 0 ? { askedBagCount: Math.round(Number(held.askedBagCount)) } : {}),
          ...(Array.isArray(held.giftSwap) ? { giftSwap: held.giftSwap } : {}),
          ...(held.livestream === true ? { livestream: true } : {})
        } };
        // Câu hỏi vị y nguyên vừa gửi (< 10 phút): không gửi lại, chỉ lưu SĐT/địa chỉ.
        if (askedAlready) reply = { ...reply, messages: [], parts: [], images: [] };
      }
    } else if (!isComment && !cartReply && !trialState && !ruleLive && !reply.order && customerChoice.namedNothing && reply.pendingOrder && typeof reply.pendingOrder === 'object'
      && Array.isArray(reply.pendingOrder.items) && reply.pendingOrder.items.length && String(reply.pendingOrder.key || '') !== String(conversation.pendingOrder?.key || '')) {
      // Giỏ mô hình dựng khi khách chưa nêu gì về món: đánh dấu để lượt SĐT/địa chỉ sau không tự chốt giỏ này (nhánh (b) ở trên).
      reply = { ...reply, pendingOrder: { ...reply.pendingOrder, inferred: true } };
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
    // R15: "tách đơn mới" (splitReply) cũng là lời quyết tường minh cho câu hỏi gộp/tách.
    // R15-fix4: khách tách bằng SĐT + địa chỉ đầy đủ MỚI (splitByNewInfo) → đơn thường lên với đúng thông tin đó. Đơn ra phải mang
    // đúng SĐT trong tin và KHÔNG mang địa chỉ cũ (mô hình điền lại địa chỉ cũ / sửa đơn cũ → bạn phụ trách). Bộ soạn còn hỏi thêm
    // (phường/xã…) → cờ splitChosenKey gắn với ĐÚNG giỏ đó, 30 phút: lượt bổ sung lên đơn không hỏi gộp/tách lại; giỏ đổi, đơn đã
    // tạo (giỏ chờ xoá), quá 30 phút hay tin có chữ gộp/hủy/đổi/không… thì cờ hết hiệu lực (không sống 24 giờ như splitChosen cũ).
    const splitChosenLive = !isComment && Boolean(conversation.pendingOrder?.splitChosenKey) && Boolean(reply.order?.orderKey)
      && String(reply.order.orderKey) === String(conversation.pendingOrder.splitChosenKey)
      && Date.now() - (Number(conversation.pendingOrder.splitChosenAt) || 0) < 30 * 60 * 1000
      && message.type === 'text' && !mergeSplitBlockWords(String(change.message?.text || ''));
    const explicitYes = ((awaitingYes || awaitingSplit) && reply === existingConfirmReply) || (splitByNewInfo && !existingConfirmReply) || splitChosenLive;
    if (splitByNewInfo && !existingConfirmReply) {
      const editsOld = Boolean(reply.order?.updateOrderId || reply.order?.cancelOrderId || reply.order?.noteOrderId);
      const wrongInfo = Boolean(reply.order) && (toLocalPhoneDigits(reply.order.phone) !== toLocalPhoneDigits(awaitingPhoneNow) || sameAsKnownAddress(reply.order.rawAddress || reply.order.address));
      if (editsOld || wrongInfo) {
        console.log(`Tách bằng SĐT/địa chỉ mới nhưng đơn ra ${editsOld ? 'sửa đơn cũ' : 'sai SĐT/địa chỉ'}: bạn phụ trách (${conversation.id})`);
        const staff = staffWaitReply();
        if (staff) reply = staff;
      } else if (!reply.order && reply.pendingOrder && typeof reply.pendingOrder === 'object' && reply.pendingOrder.key) {
        reply = { ...reply, pendingOrder: { ...reply.pendingOrder, awaitingConfirm: false, staffAsked: false, splitChosenKey: String(reply.pendingOrder.key), splitChosenAt: Date.now() } };
      }
    }
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
    // R14: luật địa chỉ (ADDRESS_* / PHONE_ADDRESS*) đã nhận tin là ĐỊA CHỈ giao hàng → không bao giờ là câu hỏi giá.
    const addressRule = /^(ADDRESS_|PHONE_ADDRESS)/.test(String(ruled?.rule || '')) && ruleLive;
    if (newOrderReply && existingAny && !explicitYes && !phoneInText && !addressRule && asksPriceText(message.text)) {
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
            pendingOrder: { items: (reply.order.items || []).map(item => ({ product: item.product || item.name, code: item.code || item.sku || '', quantity: Number(item.quantity) || 1 })), key: reply.order.orderKey || '', at: Number(conversation.pendingOrder?.at) || Date.now(), phone: reply.order.phone || '', address: reply.order.rawAddress || reply.order.address || '', addressAsks: maxAddressAsks, awaitingConfirm: true, heldSilently: true, ...(conversation.pendingOrder?.addOnlyAsk ? { addOnlyAsk: true } : {}), ...(conversation.pendingOrder?.externalOrder ? { externalOrder: conversation.pendingOrder.externalOrder } : {}) },
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
      // R16 (inbox4 H1): đơn không gộp được (quá 24 giờ / đã gửi đi / POS, nhân viên tạo) → lời "đặt thêm đúng không", không hỏi gộp/tách.
      const addOnly = !orderMergeable(existingAny);
      const ask = outside && templates?.ORDER_EXISTING_CONFIRM_PHONE
        ? { ...renderChatbotReply({ template_id: 'ORDER_EXISTING_CONFIRM_PHONE', values: { cart } }, templates, replyContext), templateId: 'ORDER_EXISTING_CONFIRM' }
        : renderChatbotReply({ template_id: 'ORDER_EXISTING_CONFIRM', cart }, addOnly ? addOnlyConfirmTemplates(templates) : templates, { ...replyContext, recentOrder: existingAny });
      if (outside && ask.templateId === 'ORDER_EXISTING_CONFIRM') await noteForStaff(dependencies, conversation, `Khách lên đơn mới với SĐT ${reply.order.phone || ''} trùng đơn ${existingAny.source || 'ngoài'} ${existingAny.id || ''} (không thuộc hội thoại này). Bot hỏi "đặt thêm?" không nêu chi tiết đơn đó — nhân viên đối chiếu có phải cùng người không.`, `đơn ngoài ${existingAny.id || '?'}`);
      if (ask.templateId === 'ORDER_EXISTING_CONFIRM') {
        console.log(`Đơn mới khi đang có đơn ${existingAny.id}: hỏi khách xác nhận trước (${conversation.id})`);
        // addressAsks = tối đa: địa chỉ này đã được bộ soạn đơn chấp nhận (có khi sau 2 lần hỏi) —
        // lượt "đúng" không được hỏi lại phường/xã lần nữa. Đơn ngoài lưu kèm giỏ chờ để "không" kể lại được.
        reply = { ...ask, order: undefined, attention: outside, pendingOrder: { items: (reply.order.items || []).map(item => ({ product: item.product || item.name, code: item.code || item.sku || '', quantity: Number(item.quantity) || 1 })), key: reply.order.orderKey || '', at: Date.now(), phone: reply.order.phone || '', address: reply.order.rawAddress || reply.order.address || '', addressAsks: maxAddressAsks, awaitingConfirm: true, ...(addOnly ? { addOnlyAsk: true } : {}), ...(outside ? { externalOrder: existingAny, staffCheck: [String(conversation.pendingOrder?.staffCheck || ''), `SĐT trùng đơn ${existingAny.source || 'ngoài'} ${existingAny.id || ''} không thuộc hội thoại, đối chiếu người nhận`].filter(Boolean).join('; ').slice(0, 300) } : {}) } };
      }
    }
    // R15 (chủ shop 03/10, quyết định 7; inbox2 A9 ca …990595 đơn 19:50 rồi 21:11 "1goi nho" → bot xin lại địa chỉ): khách có đơn
    // chưa hủy < 24 giờ (quá 60 phút — trong 60 phút bộ soạn tự cộng vào đơn) mà lập GIỎ MỚI chưa đủ SĐT/địa chỉ → hỏi gộp vào đơn
    // đang có hay tách đơn mới (gửi cùng địa chỉ cũ), không xin lại địa chỉ. Giỏ giữ với cờ chờ xác nhận.
    const newBasketNow = reply.templateId === 'ORDER_ADDRESS' && !reply.order && Array.isArray(reply.pendingOrder?.items) && reply.pendingOrder.items.length
      && String(reply.pendingOrder.key || '') !== String(conversation.pendingOrder?.key || '');
    if (newBasketNow && !isComment && !cartReply && existingRecent && orderMergeable(existingRecent) && Date.now() - (Number(existingRecent.createdAt) || 0) < 24 * 60 * 60 * 1000
      && !awaitingRecent && !(reply.pendingOrder.phone && reply.pendingOrder.address) && templates?.ORDER_EXISTING_CONFIRM
      // Khách đã nói rõ đơn riêng ("đơn khác gửi cho mẹ", "địa chỉ khác") → không hỏi gộp/tách, đi bước đơn mới như cũ.
      && !/\b(?:don khac|don moi|don rieng|tach don|nguoi khac|dia chi khac|gui (?:cho )?(?:me|ba|bo|chi|em|ban|anh|nguoi))\b/.test(folded)) {
      const items = reply.pendingOrder.items;
      const priced = priceBasket(items.map(item => ({ sku: item.code, product: item.product, quantity: item.quantity })), { livestream: replyContext.livestream });
      const cart = `${items.map(item => `${Number(item.quantity) || 1} ${item.product}`).join(' + ')}${priced?.priceable && priced.total ? ` – tổng ${Number(priced.total).toLocaleString('vi-VN')}đ` : ''}`;
      const ask = renderChatbotReply({ template_id: 'ORDER_EXISTING_CONFIRM', cart }, templates, { ...replyContext, recentOrder: existingRecent });
      if (ask.templateId === 'ORDER_EXISTING_CONFIRM' && ask.messages?.length) {
        console.log(`Giỏ mới khi đang có đơn ${existingRecent.id} (< 24 giờ): hỏi gộp hay tách (${conversation.id})`);
        reply = { ...ask, order: undefined, pendingOrder: { ...reply.pendingOrder, at: Date.now(), awaitingConfirm: true, staffAsked: false, splitChosenKey: '' } };
      }
    }
    // R14 (inbox3 S1): giỏ đã bị giữ IM LẶNG một lần (đang chờ "đặt thêm?") — lượt sau (khách hỏi chuyện khác: bảng giá
    // Tropical…) phải hỏi lại "đặt thêm đơn … đúng không" kèm câu trả lời, không im tiếp rồi để "Ok" thành lời cảm ơn suông.
    const heldBefore = conversation.pendingOrder;
    if (!isComment && heldBefore?.heldSilently && Array.isArray(heldBefore.items) && heldBefore.items.length && awaitingRecent && !awaitingYes && !awaitingNo
      && !reply.order && !reply.handoff && reply.templateId !== 'ORDER_EXISTING_CONFIRM' && reply.pendingOrder === undefined && templates?.ORDER_EXISTING_CONFIRM) {
      const heldCart = heldBefore.items.map(item => `${Number(item.quantity) || 1} ${item.product || item.name}`).join(' + ');
      const outsideHeld = !existingRecent && heldBefore.externalOrder;
      const ask = outsideHeld && templates?.ORDER_EXISTING_CONFIRM_PHONE
        ? { ...renderChatbotReply({ template_id: 'ORDER_EXISTING_CONFIRM_PHONE', values: { cart: heldCart } }, templates, replyContext), templateId: 'ORDER_EXISTING_CONFIRM' }
        : renderChatbotReply({ template_id: 'ORDER_EXISTING_CONFIRM', cart: heldCart }, heldBefore.addOnlyAsk ? addOnlyConfirmTemplates(templates) : templates, { ...replyContext, recentOrder: existingAny || recentOrder });
      if (ask.templateId === 'ORDER_EXISTING_CONFIRM' && ask.messages?.length) {
        console.log(`Giỏ đã giữ im lặng một lần: hỏi lại "đặt thêm?" kèm câu trả lời (${conversation.id})`);
        const partsOf = item => item.parts || [...(item.messages || []).map(text => ({ type: 'text', text })), ...(item.images || []).map(url => ({ type: 'image', url }))];
        reply = {
          ...reply,
          messages: [...(reply.messages || []), ...ask.messages],
          parts: [...partsOf(reply), ...ask.messages.map(text => ({ type: 'text', text }))],
          alsoTemplateId: reply.alsoTemplateId || 'ORDER_EXISTING_CONFIRM',
          attention: true,
          pendingOrder: { ...heldBefore, heldSilently: false, awaitingConfirm: true, at: Date.now() }
        };
      }
    }
    // R14 (inbox3 S1): khách còn giỏ có món mà CHƯA có đơn cho giỏ đó → "Ok"/lời đáp không được kết bằng lời cảm ơn suông:
    // giỏ đủ SĐT + địa chỉ thì chốt (bộ soạn đơn), thiếu thì nhắc giỏ + phần còn thiếu.
    const openBasket = !isComment && settings.autoOrder !== false && Array.isArray(heldBefore?.items) && heldBefore.items.length && !heldBefore.postponed && !heldBefore.awaitingConfirm
      && Date.now() - (Number(heldBefore.at) || 0) < 24 * 60 * 60 * 1000 && !(recentOrder?.id && (Number(recentOrder.createdAt) || 0) >= (Number(heldBefore.at) || 0));
    if (reply.templateId === 'THANK_YOU' && openBasket && !nonText && !reply.order && !awaitingNo && !reply.declinedBasket) {
      const closing = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, { ...replyContext, pendingOrder: heldBefore, lastTemplateId: 'ORDER_ADDRESS' });
      if (closing.order && !closing.handoff && !existingAny) reply = closing;
      else if (closing.remind) reply = { templateId: 'ORDER_ADDRESS_REMIND', messages: [closing.remind], images: [], parts: undefined, handoff: false };
      console.log(`"${String(message.text || '').slice(0, 30)}" khi còn giỏ chưa lên đơn: ${reply.templateId} thay lời cảm ơn (${conversation.id})`);
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
    // R16 (inbox1 A3 ca …6011240055: "Túi mầu vàng" tới 6 giây trước khi phiếu gửi): ngay trước khi TẠO đơn mới, đọc lại tin —
    // khách vừa nhắn thêm (tra POS / hỏi đặt thêm mất vài giây) thì bỏ lượt này, tin sau trả lời gộp.
    if (reply.order && !operationOnlyEarly(reply.order) && !isComment && settings.responseMode === 'automatic') {
      const beforeCreate = await listMessages(conversation.id).catch(() => null);
      if (beforeCreate && hasNewerCustomerMessage(beforeCreate, change.message)) {
        console.log(`Khách nhắn thêm ngay trước khi tạo đơn: bỏ lượt, gộp với tin sau (${conversation.id})`);
        results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
        return;
      }
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
    let privateViaInbox = false;
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
      // R16 (bình luận A3, ca …637488 "chưa thấy tin nhắn em"): khách báo CHƯA THẤY tin riêng → gửi LẠI tin riêng bot đã gửi
      // (24 giờ; bình luận mới cho phép một tin riêng) thay vì chỉ "em đã gửi trong tin nhắn rồi", và lời công khai chỉ chỗ
      // "Tin nhắn chờ".
      const notSeenPrivate = /\b(?:chua|khong|ko|k|kg|hong|khg) (?:thay|nhan|co|duoc|xem duoc) (?:duoc )?(?:tin|ib|inbox|nhan|mess)\b|\bsao (?:chua|khong|ko|k) (?:nhan|ib|inbox|rep|tra loi|thay)\b/.test(folded);
      const lastPrivate = notSeenPrivate ? [...inboxMessages].reverse().find(item => item?.direction === 'outgoing' && !item.staff && !isPageSystemNotice(item) && item.text
        && Date.now() - (Number(item.createdAt) || 0) < 24 * 60 * 60 * 1000) : null;
      const resendPrivate = Boolean(lastPrivate) && !reply.attention && !commentComplaint;
      const privateText = resendPrivate ? String(lastPrivate.text) : inboxPageRecently ? joinPrivate([...reply.messages]) : privateWithIntro;
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
      // R16 (bình luận A5 "Nhai ròn thật"): giòn / ròn cũng là lời khen.
      const praiseWords = /\b(ngon|tuyet|tuyet voi|thich|thik|dinh|hop ly|ok lam|qua ngon|ung|dung y|cam on|thanks|dep|xinh|gion|ron|gion tan)\b/.test(folded);
      const commentPraise = !commentComplaint && !liveInterest && !liveFeedback && !basket.length && !extractVietnamesePhone(message.text || '') && !reply.order && templates?.COMMENT_PUBLIC_THANKS
        && ((reply.templateId === 'THANK_YOU' && (praiseWords || emojiOnly)) || praiseAfterBuy || (praiseWords
          && !/\?|\b(nao|sao|khong|ko|k|gia|bn|bao nhieu|hon|the nao|ntn|khac|lay|dat|mua|cho|xin|ib|inbox|giam|ship|tui|goi|combo|bao)\b/.test(folded)));
      if (commentPraise || liveFeedback) privateSkipped = true;
      // R14 (chủ shop 03/10, quyết định 9; bình luận T1): bình luận đùa / không liên quan ("Mặc quần k đẹp", "Xong ăn thêm bát
      // phở nữa") mà mô hình chỉ chào/cảm ơn (WELCOME/THANK_YOU): CHỈ like — không nhắn riêng bảng giá/lời chúc, không đăng
      // "em đã nhắn tin cho mình rồi".
      // R16 (bình luận A5, ca …715572 "Thời giờ ăn gáo dừa còn bác thì k ăn"): câu đùa nhắc tới món quà (gáo dừa, bát…) mà không
      // hỏi gì (không "?", quà/tặng, giá, mua, "gì/nào/sao/được không") — mô hình chọn bảng quà: không nhắn riêng chính sách quà.
      const giftJoke = /^GIFT_POLICY/.test(String(reply.templateId || '')) && !/\?/.test(String(message.text || ''))
        && !/\b(?:qua|tang|khuyen mai|km|gi|nao|sao|bn|gia|bao nhieu|lay|mua|dat|chot|ship|duoc khong|co khong|dc khong|ntn|the nao|tui|goi|combo)\b/.test(folded);
      if (!commentPraise && (giftJoke || commentOffTopic({ text: message.text, chosen: chosenTemplateId, praise: praiseWords, emojiOnly }))
        && !commentComplaint && !liveInterest && !liveFeedback && !basket.length && !unknownBasketComment && !reply.order && !reply.attention) {
        await moderateBundledComments();
        results.push({ conversationId: conversation.id, skipped: 'bình luận đùa/không liên quan (chỉ like)' });
        return;
      }
      if (privateText && !privateSkipped && !resendPrivate && getConversation && listMessages) {
        const inbox = await getConversation(`${conversation.pageId}:${conversation.psid}`).catch(() => null);
        const sentBefore = inbox ? await listMessages(inbox.id).catch(() => []) : [];
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        // R13: so cả bản có và không có câu mở đầu (lần trước gửi kèm mở đầu, lần này bỏ — vẫn là cùng một tin).
        const sameAsSent = text => [privateText, privateWithIntro].some(candidate => normalize(text) === normalize(candidate));
        privateSkipped = sentBefore.some(item => item?.direction === 'outgoing' && (Number(item?.createdAt) || 0) > dayAgo && sameAsSent(item.text));
        // R16 (bình luận A4, ca …105688): bình luận TRÙNG câu khách vừa gửi ở hộp thư (< 5 phút) — hộp thư đã/đang trả lời câu đó:
        // không nhắn riêng lần hai (hai câu trả lời mâu thuẫn), chỉ lời công khai.
        const commentSquash = squashText(message.text);
        // Chỉ khi hộp thư ĐÃ có lời Page sau tin đó (Facebook có khi đẩy chính bình luận vào hộp thư — lượt hộp thư đó im vì
        // trùng bình luận, R15 inbox3 A3 — thì bình luận vẫn phải nhắn riêng).
        const answeredInInbox = item => sentBefore.some(other => other?.direction === 'outgoing' && !isPageSystemNotice(other) && (Number(other.createdAt) || 0) > (Number(item.createdAt) || 0));
        if (!privateSkipped && commentSquash.length >= 4 && sentBefore.some(item => item?.direction === 'incoming' && Date.now() - (Number(item?.createdAt) || 0) < 5 * 60 * 1000
          && (squashText(item.text) === commentSquash || textSimilarity(item.text, message.text) >= 0.8) && answeredInInbox(item))) {
          console.log(`Bình luận trùng tin khách vừa gửi ở hộp thư: không nhắn riêng (${conversation.id})`);
          privateSkipped = true;
        }
        // R16 (inbox2 M6, ca …0025552483): giỏ trong bình luận TRÙNG giỏ hộp thư vừa xác nhận (< 30 phút, cùng khoá giỏ) → không
        // gửi tin xác nhận giỏ thứ hai (hai câu chỉ đảo thứ tự món nên bộ so chữ không bắt).
        if (!privateSkipped && inbox && reply.pendingOrder?.key && String(inbox.pendingOrder?.key || '') === String(reply.pendingOrder.key)
          && Date.now() - (Number(inbox.botLastReplyAt) || 0) < 30 * 60 * 1000 && (isBasketStep(inbox.botLastTemplateId) || inbox.botLastTemplateId === 'ORDER_ADDRESS_REMIND')) {
          console.log(`Bình luận cùng giỏ hộp thư vừa xác nhận: không gửi tin xác nhận lần hai (${conversation.id})`);
          privateSkipped = true;
        }
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
          // R14 (bình luận M1, ca …853104): "(#100, 1893060) Invalid parameter" thử lại cũng lỗi y hệt → lỗi vĩnh viễn.
          const permanent = /#10903|#10900|#551|\(#10\)|\(#100\b|chưa có mã Pancake/i.test(error.message || '');
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
        // R14 (bình luận M1): tin riêng lỗi mà khách còn trong cửa sổ 24 giờ của Messenger (khách nhắn hộp thư Page < 24 giờ):
        // gửi câu trả lời như tin thường vào hộp thư — khách vẫn nhận được, lời công khai "em đã nhắn tin" là đúng.
        if (privateError && getConversation) {
          const inbox = inboxThread || await getConversation(`${conversation.pageId}:${conversation.psid}`).catch(() => null);
          // INT-15: cùng một cách tính cửa sổ 24 giờ như bám đuổi / vận đơn (mốc khách của hộp thư + tin đã lưu, chừa 1 giờ).
          const windowOpen = Boolean(inbox) && messengerWindowOpen({ messages: { [inbox.id]: inboxMessages } }, inbox);
          if (inbox && windowOpen) {
            const viaInbox = await (async () => {
              for (const chunk of splitMessageText(joinPrivate([...reply.messages]), 1900)) {
                // Gửi dở / không rõ đã tới (hết giờ chờ): coi như đã gửi — như lời công khai; gửi lại là khách nhận trùng.
                await sendMessage(inbox, { text: chunk }).catch(error => {
                  if (!sendMaybeDelivered(error)) throw error;
                  console.warn(`Tin vào hộp thư không rõ đã tới (${conversation.id}): coi như đã gửi — ${error.message}`);
                });
              }
              return true;
            })().catch(error => { console.warn(`Tin riêng lỗi, gửi vào hộp thư cũng lỗi (${conversation.id}): ${error.message}`); return false; });
            if (viaInbox) {
              console.log(`Tin riêng bình luận lỗi (${privateError.slice(0, 60)}): đã gửi câu trả lời vào hộp thư (${conversation.id})`);
              privateError = '';
              privateViaInbox = true;
            }
          }
        }
        // Phần còn lại: tin thường vào hộp thư (bị chặn khi khách chưa nhắn Page thì bỏ, không báo lỗi).
        if (!privateError && !privateSkipped && !privateViaInbox && privateChunks.length > 1 && getConversation) {
          const inbox = await getConversation(`${conversation.pageId}:${conversation.psid}`).catch(() => null);
          for (const chunk of privateChunks.slice(1)) {
            if (!inbox) break;
            const ok = await sendMessage(inbox, { text: chunk }).then(() => true).catch(error => {
              if (sendMaybeDelivered(error)) { console.warn(`Phần sau tin riêng không rõ đã tới (${conversation.id}): coi như đã gửi — ${error.message}`); return true; }
              console.warn(`Phần sau tin riêng không gửi được (${conversation.id}): ${error.message}`);
              return false;
            });
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
              : resendPrivate && !privateSkipped && !privateError ? 'COMMENT_PUBLIC_RESENT'
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
      // R14 (bình luận M1, ca …853104): tin riêng lỗi và khách không nhận được gì ở hộp thư → lời dự phòng "mời nhắn Page" vẫn
      // đăng dù luồng vừa có lời công khai trong 10 phút (trước đây khách không nhận được gì cả); chỉ không đăng lại chính lời
      // dự phòng đã đăng trong 10 phút.
      // R16 (bình luận A3): lời công khai khi gửi lại tin riêng — mẫu COMMENT_PUBLIC_RESENT (chưa có trong Cài đặt thì lời dự phòng).
      const publicTemplates = publicId === 'COMMENT_PUBLIC_RESENT' && !Object.hasOwn(templates || {}, 'COMMENT_PUBLIC_RESENT') ? { ...(templates || {}), COMMENT_PUBLIC_RESENT: COMMENT_PUBLIC_RESENT_FALLBACK } : templates;
      const renderedPublic = renderChatbotReply({ template_id: publicId }, publicTemplates, replyContext);
      const fallbackPostedRecently = fallbackPublic && (renderedPublic.messages || []).flatMap(text => String(text).split('###')).some(line => {
        const wanted = normalizeSent(line);
        return wanted.length > 20 && recent.some(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo && normalizeSent(item.text) === wanted);
      });
      const publicReply = (publicRecently && !fallbackPublic) || fallbackPostedRecently ? { messages: [] } : renderedPublic;
      // Vòng 12 (B4 #11): câu hỏi sức khỏe / dị ứng / ăn kiêng ("Sợ ỉa chảy") → lời công khai trung tính, không emoji.
      const neutralPublic = ['HEALTH_CAUTION', 'HEALTH_CONDITION', 'HEALTH_DIABETES', 'INGREDIENTS_ALLERGY', 'CALORIES_DIET', 'WEIGHT_GAIN', 'COMMENT_STAFF_FOLLOWUP'].includes(reply.templateId);
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
      // R16 (inbox2 C2, ca …7835884664 "." rồi "Mua hạt" 6 giây sau): lượt trả lời nhanh cho tin cụt (luật DOTS / TERSE_PRICE, tin
      // chỉ "."/"…") — đọc lại tin ngay trước khi gửi; khách đã nhắn câu thật thì bỏ lượt này, tin sau trả lời.
      const terseOnly = !outcome && (/^(?:DOTS|TERSE_PRICE)$/.test(String(ruled?.rule || '')) || /^[.…\s]+$/.test(String(message.text || '')));
      if (terseOnly && hasNewerCustomerMessage(await listMessages(conversation.id).catch(() => []), change.message)) {
        console.log(`Tin cụt mà khách vừa nhắn thêm: bỏ lượt, gộp với tin sau (${conversation.id})`);
        results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
        return;
      }
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
    // R14 (chủ shop 03/10, quyết định 12): giá/quà live cho hộp 10 gói giữ cách tính hiện tại, chỉ gắn thẻ cần người để nhân
    // viên xem lại khi giỏ/đơn của khách live có hộp 10 gói (ca …221660: hộp 10 gói + 1 túi tính 328k, lời live nói 298k).
    const liveBoxItems = [...(Array.isArray(reply.order?.items) ? reply.order.items : []), ...(Array.isArray(reply.pendingOrder?.items) ? reply.pendingOrder.items : [])];
    if ((replyContext.livestream || isLivestreamPost(conversation)) && !reply.attention
      && liveBoxItems.some(item => /^CB10/i.test(String(item?.code || item?.sku || '')) || /combo 10|hộp 10|10 gói/i.test(String(item?.product || item?.name || '')))) {
      console.log(`Giỏ khách live có hộp 10 gói: gắn thẻ cho nhân viên xem giá/quà (${conversation.id})`);
      reply = { ...reply, attention: true };
    }
    // R15-fix3 (phản biện L2, r13 …790172878 "Nói chả nghe gì vậy"): góp ý phiên live luôn gắn thẻ cho nhân viên (như bản cũ),
    // kể cả khi mô hình chọn CSKH_HANDOFF và câu trả lời bị đổi về lời live / bảng giá (các bước đó dựng lại câu, mất cờ).
    if (liveFeedback && !reply.attention) reply = { ...reply, attention: true };
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
    // R14 (quyết định 4): lời chê/khiếu nại engine tự nhận ra (bình luận "không như quảng cáo", hộp thư "Dỡ") → thẻ Khiếu nại
    // dù từ khóa khiếu nại trong Cài đặt không có cụm đó.
    if (reply.complaint && !labelEvents.includes('complaint')) labelEvents.push('complaint');
    // Ưu đãi dùng thử: lưu bước (đã chọn túi, đã mời, từ chối, chuyển đơn thường) và
    // đóng ưu đãi khi đơn dùng thử đã tạo (không dùng lại được).
    // Vòng 11 (P5): bot hỏi vị mà khách đã nêu số túi ("gửi mình 2 túi nhé, <địa chỉ>"): giữ số túi trong giỏ chờ để
    // lượt trả lời một màu lên đúng số túi.
    // R15 (inbox1 A1, ca …5962076080 "Chốt chị 2tui" + SĐT + địa chỉ): mô hình trả ASK_FLAVOR không kèm giỏ chờ → số túi (và SĐT)
    // rơi mất, lượt vị sau không biết khách đã nói 2 túi. Hộp thư: dựng giỏ chờ rỗng mang askedBagCount (+ SĐT trong tin).
    const askedBagsNow = reply.templateId === 'ASK_FLAVOR' && ((reply.pendingOrder && typeof reply.pendingOrder === 'object') || (!isComment && reply.pendingOrder === undefined)) ? bagCountInText(message.text) : 0;
    if (askedBagsNow > 0) {
      const basePending = reply.pendingOrder && typeof reply.pendingOrder === 'object' ? reply.pendingOrder
        : conversation.pendingOrder && typeof conversation.pendingOrder === 'object' && !(conversation.pendingOrder.items || []).length ? conversation.pendingOrder
          : { items: [], key: '', at: Date.now(), phone: '', address: '', addressAsks: 0 };
      // R15-fix3 (phản biện s1c): địa chỉ gửi cùng tin ("Chốt chị 2tui" + SĐT + địa chỉ, mỗi thứ một dòng) cũng giữ trong giỏ chờ,
      // để lượt chọn vị sau lên đơn luôn. Chỉ lấy dòng không có SĐT mà bộ đọc địa chỉ nhận ra tỉnh/đủ cấp.
      const typedAddress = (() => {
        if (basePending.address || nonText) return '';
        const lines = String(message.text || '').split(/\n+/).map(line => line.trim()).filter(Boolean);
        const candidates = lines.length > 1 ? lines.filter(line => !extractVietnamesePhone(line) && bagCountInText(line) === 0) : [];
        const found = candidates.find(line => { const read = describeDeliveryAddress(line); return Boolean(read.complete || read.resolved?.province); });
        return found ? found.slice(0, 300) : '';
      })();
      reply = { ...reply, pendingOrder: { ...basePending, ...(!basePending.phone && phoneInText ? { phone: phoneInText } : {}), ...(typedAddress ? { address: typedAddress } : {}), askedBagCount: askedBagsNow } };
    }
    const trialOrdered = Boolean(order && (order.trialFreeShip || reply.order?.trial));
    const promoUpdate = conversation.promo && (trialPatch || trialOrdered)
      ? { ...conversation.promo, ...(trialPatch || {}), ...(trialOrdered ? { stage: 'ordered', orderId: String(order.id), endedAt: Date.now() } : {}) }
      : null;
    // R13: giỏ chờ sắp lưu giữ lại lựa chọn quà thay (giftSwap) và cờ khách live (livestream) của giỏ trước — bộ soạn đơn
    // dựng giỏ mới từ bản đã chuẩn hoá nên hai trường này rơi mất nếu không chép lại.
    if (reply.pendingOrder && typeof reply.pendingOrder === 'object' && !isComment) {
      const carriedFields = {
        ...(chosenGiftSwap && !reply.pendingOrder.giftSwap ? { giftSwap: chosenGiftSwap } : {}),
        ...((conversation.pendingOrder?.livestream === true || replyContext.livestream) && reply.pendingOrder.livestream === undefined ? { livestream: true } : {}),
        // R15 (quyết định 1): lời hứa tặng yến mạch đi theo giỏ dựng lại (vẫn từ 2 túi lớn).
        ...(conversation.pendingOrder?.oatsGift === true && reply.pendingOrder.oatsGift === undefined && bigBags(reply.pendingOrder.items) >= 2 ? { oatsGift: true } : {})
      };
      if (Object.keys(carriedFields).length) reply = { ...reply, pendingOrder: { ...reply.pendingOrder, ...carriedFields } };
      // R15-fix3 (T6): giỏ còn dưới 2 túi lớn (có món) → bỏ cờ hứa tặng yến mạch.
      if (reply.pendingOrder.oatsGift === true && (reply.pendingOrder.items || []).length && bigBags(reply.pendingOrder.items) < 2) {
        const { oatsGift: _oats, ...withoutOats } = reply.pendingOrder;
        reply = { ...reply, pendingOrder: withoutOats };
      }
      // R13: giỏ được lưu lại ở một lượt KHÔNG phải lượt hoãn (khách gửi SĐT/địa chỉ, đổi giỏ, chọn quà…) → khách đã quay
      // lại với đơn: bỏ cờ `postponed` để chốt và bám đuổi bình thường.
      if (reply.pendingOrder.postponed && !(ruled?.keepBasket && reply.templateId === 'ORDER_POSTPONED')) {
        const { postponed: _postponed, ...resumed } = reply.pendingOrder;
        reply = { ...reply, pendingOrder: resumed };
      }
    }
    // R14 (chủ shop 03/10): GIFT_SWAP không còn hỏi "lấy 2 gói vị nào" — không đặt mốc chờ khách chọn vị quà thay.
    const gaveGiftSwapAsk = false;
    // R15: khách báo đã mua trên sàn (BOUGHT_ON_MARKETPLACE — luật hay mô hình) → bỏ giỏ đang giữ.
    if (reply.templateId === 'BOUGHT_ON_MARKETPLACE' && !isComment && reply.pendingOrder === undefined && conversation.pendingOrder) reply = { ...reply, pendingOrder: null };
    // R15 (inbox1 A1): dấu "giỏ/đơn N túi một vị dựng từ số túi khách nêu trước + tin chỉ một vị" (xem flavourSplitReply).
    const flavourMarker = (() => {
      if (isComment || nonText || reply.flavourSplit) return null;
      const heldBefore = conversation.pendingOrder && typeof conversation.pendingOrder === 'object' ? conversation.pendingOrder : null;
      const count = Math.max(askedBag.count, !(heldBefore?.items || []).length ? Math.round(Number(heldBefore?.askedBagCount) || 0) : 0);
      const colour = singleFlavourOf(message.text);
      if (count < 2 || !colour) return null;
      const created = Boolean(order) && !outcome?.updated && Boolean(reply.order) && !reply.order.updateOrderId;
      const lines = created ? reply.order.items || [] : reply.pendingOrder?.items || [];
      const code = String(lines[0]?.code || lines[0]?.sku || '').toUpperCase();
      if (lines.length !== 1 || Number(lines[0].quantity) !== count || !code.startsWith(`GRA-${colour.toUpperCase()}-`)) return null;
      return { count, code, at: Date.now(), orderId: created ? String(order.id || '') : '' };
    })();
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
      // R15 (giao diện với luật BOUGHT_ELSEWHERE): khách báo đã mua trên sàn → mốc để bám đuổi không nhắc giỏ / không bám.
      ...(reply.templateId === 'BOUGHT_ON_MARKETPLACE' && !isComment ? { boughtElsewhereAt: Date.now() } : {}),
      // R15 (inbox1 A9): lượt giỏ Shop đã xong → bỏ mốc ack chờ kiểm đơn.
      ...(cartAckSent || conversation.shopCartAckPendingAt ? { shopCartAckPendingAt: 0, shopCartAckMessageId: '' } : {}),
      // R15: dấu tách vị (3 phút) — lượt khác thì xoá.
      ...(flavourMarker ? { flavourFromCount: flavourMarker } : conversation.flavourFromCount ? { flavourFromCount: null } : {}),
      // R14 (quyết định 10): mốc đã xin SĐT để tra địa chỉ cũ — lần sau không tra được thì chuyển bạn phụ trách.
      ...(oldAddressAskedNow || reply.templateId === 'ORDER_ADDRESS_OLD_ASK_PHONE' ? { oldAddressAskedAt: Date.now() } : {}),
      botConversationId: reply.conversationId || conversation.botConversationId || '',
      botLastTemplateId: reply.templateId,
      botLastReplyAt: Date.now(),
      // R13 sửa (T1): luồng bình luận ghi mã bình luận vừa trả lời ở MỌI lượt trả lời (không chỉ lượt bỏ qua) — backlog / đồng bộ
      // muộn / thử lại sau 429 phân biệt được bình luận đã trả lời với bình luận MỚI tới trong lúc bot đang soạn.
      ...(isComment && (change?.message?.id || change?.message?.mid) ? { botHandledMessageId: String(change.message.id || change.message.mid) } : {}),
      // R16 (inbox5 A1): mốc giờ tin khách MỚI NHẤT đã nằm trong lượt trả lời này (hộp thư) — tin đến muộn có giờ sau mốc này
      // là tin bot CHƯA đọc, dù lời bot gửi sau giờ của tin đó.
      ...(!isComment ? { botAnsweredUpTo: Math.max(Number(change.message?.createdAt) || 0, ...bundle.map(item => Number(item?.createdAt) || 0)) } : {}),
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
// R14: câu trả lời "bảng giá / lời chào live" dưới bình luận — thay bằng nhắc giỏ khi hộp thư đang giữ giỏ.
const commentPriceFamily = new Set([...priceFamilyTemplates, 'LIVESTREAM_VOUCHER', 'ASK_TWO_BAGS', 'PRICE_COUNT', 'PRICE_ONE_BAG', 'FREESHIP_POLICY', 'ORDER_HELP']);
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
    // Chủ shop 03/10: lượt bot nhận đơn vì nhân viên im ({ takeover, reason }) hay lượt im đã hẹn kiểm lại ({ scheduled, inMs }).
    ...(trace.staffIdle ? { staffIdle: trace.staffIdle } : {}),
    ms: Date.now() - startedAt
  };
}
