// The basket a customer named and the phone/address they give afterwards almost
// never arrive in the same message. The old workflow kept the basket in static data
// for two hours; here it is stored on the conversation record so it survives a
// restart and stays scoped to one customer.

// 03/10 (ca Trang Nhi Vân): 2 giờ → 24 giờ. Khách bấm giỏ Shop 2 Túi Xanh, bot xin SĐT/địa chỉ; 2 giờ 55 phút sau khách gửi
// đủ → giỏ đã hết hạn nên bot hỏi lại vị. Giỏ vẫn chỉ dùng khi tin cuối của bot là bước đơn (usablePendingOrder/isBasketStep),
// và 24 giờ là khung Messenger cho phép nhắn khách.
export const pendingOrderTtlMs = 24 * 60 * 60 * 1000;
// Vòng 12: giỏ đã có tin nhắc giữ đơn (bám đuổi ORDER_ADDRESS_REMIND, tới 24 giờ) còn dùng được tới
// 24 giờ sau lần nhắc — khách trả lời tin nhắc bằng SĐT/địa chỉ không bị hỏi lại vị.
export const remindedPendingOrderTtlMs = 24 * 60 * 60 * 1000;
export const orderStepTemplateIds = ['ORDER_ADDRESS', 'ORDER_PHONE', 'ORDER_CONFIRMATION', 'ORDER_UPDATE'];
// Bước mà giỏ đang giữ vẫn dùng được (vòng 12: thêm tin nhắc giữ đơn, xin SĐT tra địa chỉ cũ,
// hỏi vị, giỏ chờ tính giá). Không đổi isOrderStep: renderChatbotReply dùng nó để chọn bộ soạn đơn.
export const basketStepTemplateIds = [...orderStepTemplateIds, 'ORDER_ADDRESS_REMIND', 'ORDER_ADDRESS_OLD_ASK_PHONE', 'ORDER_CUSTOM_BASKET', 'ASK_FLAVOR'];

export function isOrderStep(templateId) {
  return orderStepTemplateIds.includes(String(templateId || '').trim());
}

/** Bot vừa ở một bước của luồng đơn (kể cả nhắc giữ đơn / hỏi vị / xin SĐT tra địa chỉ cũ). */
export function isBasketStep(templateId) {
  return basketStepTemplateIds.includes(String(templateId || '').trim());
}

/** `giftSwap` của giỏ chờ đã chuẩn hoá: mảng lựa chọn (tối đa 10, chỉ giữ id/label/name/sku/weight), `true` → `[]`; không có → null. */
function giftSwapOf(value) {
  const raw = value?.giftSwap;
  if (raw === true) return [];
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, 10).map(entry => (typeof entry === 'string'
    ? entry.trim().slice(0, 80)
    : entry && typeof entry === 'object'
      ? { id: String(entry.id || '').trim(), label: String(entry.label || '').trim(), name: String(entry.name || '').trim(), sku: String(entry.sku || '').trim(), weight: Number(entry.weight) || 0 }
      : null)).filter(Boolean);
}

export function normalizePendingOrder(value) {
  const items = Array.isArray(value?.items) ? value.items : [];
  const key = String(value?.key || '').trim();
  const at = Number(value?.at) || 0;
  const phone = String(value?.phone || '').trim();
  const address = String(value?.address || '').trim();
  // How many times the bot has already asked for a missing part of the address,
  // so it stops asking after two tries and lets the order through.
  const addressAsks = Math.max(0, Math.round(Number(value?.addressAsks) || 0));
  // Vòng 12: số túi khách đã nêu khi chưa nói vị ("Cho mình 2 túi" → hỏi vị → "Túi vàng" = 2 Vàng).
  const askedBagCount = Math.max(0, Math.min(99, Math.round(Number(value?.askedBagCount) || 0)));
  // A record holding only a phone number is still worth keeping: customers give
  // contact details before naming products just as often as the other way round.
  if (!at || (!items.length && !phone && !address && !askedBagCount && !value?.wantsPrevious)) return null;
  const remindedAt = Number(value?.remindedAt) || 0;
  return {
    key,
    at,
    // Phone and address ride along with the basket: the customer supplies each
    // in a different message, and the model only echoes back what it just heard.
    phone,
    address,
    addressAsks,
    ...(askedBagCount ? { askedBagCount } : {}),
    // R14: bot vừa hỏi "nguyên bản" là Xanh hay Vàng — số túi phần đó; câu trả lời vị được CỘNG vào giỏ chờ.
    ...(Number(value?.nguyenBanAsk) > 0 ? { nguyenBanAsk: Math.min(20, Math.round(Number(value.nguyenBanAsk))) } : {}),
    // Vòng 12: khách đã nói "gửi địa chỉ cũ / như mấy lần" từ tin đặt đầu: nhớ để lượt sau (khi có SĐT) lấy lại.
    ...(value?.wantsPrevious ? { wantsPrevious: true } : {}),
    // 01/10 (fix-bot C2/T7): ghi chú soát cho nhân viên đi theo giỏ tới khi lên đơn (thành addressCheck của đơn).
    ...(value?.staffCheck ? { staffCheck: String(value.staffCheck).slice(0, 300) } : {}),
    // Vòng 12: lúc gửi tin nhắc giữ đơn gần nhất (follow-up gọi touchPendingOrder).
    ...(remindedAt ? { remindedAt } : {}),
    // Đã gợi ý lên 2 túi cho giỏ này rồi thì không gợi ý lại.
    ...(value?.upsold ? { upsold: true } : {}),
    // Đang chờ khách xác nhận đặt THÊM đơn (khách đã có đơn trong 7 ngày).
    ...(value?.awaitingConfirm ? { awaitingConfirm: true } : {}),
    // Vòng 13 (basket): lựa chọn đổi quà đi theo giỏ chờ — mảng của parseGiftSwapChoice; `[]` (hay `true`) = khách xin đổi
    // quà nhưng chưa nêu vị. Không có trường thì không thêm (không đổi quà).
    ...(giftSwapOf(value) ? { giftSwap: giftSwapOf(value) } : {}),
    // Vòng 13 (inbox3 F3): giỏ lập từ bình luận live / khách live → giữ quà và giá live khi khách sang hộp thư.
    ...(value?.livestream === true ? { livestream: true } : {}),
    // Vòng 13 (inbox2 A3): khách hẹn dịp khác (ORDER_POSTPONED, keepBasket) — giỏ còn giữ nhưng không nhắc bám đuổi.
    ...(value?.postponed ? { postponed: true } : {}),
    // Vòng 13 (02/10): giỏ do bình luận mang sang hộp thư — bình luận mới hơn được thay giỏ này (engine inboxBasketFresh).
    ...(value?.fromComment === true ? { fromComment: true } : {}),
    items: items.map(item => ({
      product: String(item?.product || '').trim(),
      code: String(item?.code || '').trim(),
      quantity: Math.max(1, Math.round(Number(item?.quantity) || 1))
    })).filter(item => item.product)
  };
}

/** Giỏ còn hạn tới lúc nào: 24 giờ từ khi lập, hoặc 24 giờ từ tin nhắc giữ đơn gần nhất. */
export function pendingOrderExpiresAt(pending) {
  const at = Number(pending?.at) || 0;
  const remindedAt = Number(pending?.remindedAt) || 0;
  return Math.max(at + pendingOrderTtlMs, remindedAt ? remindedAt + remindedPendingOrderTtlMs : 0);
}

/** A basket is reusable only while the conversation is still on an order step. */
export function usablePendingOrder(value, { now = Date.now(), templateId = '' } = {}) {
  const pending = normalizePendingOrder(value);
  if (!pending) return null;
  if (!isBasketStep(templateId)) return null;
  if (now > pendingOrderExpiresAt(pending)) return null;
  return pending;
}

/**
 * Vòng 12: tin nhắc giữ đơn vừa gửi (bám đuổi ORDER_ADDRESS_REMIND) — ghi mốc nhắc vào giỏ để giỏ còn
 * dùng được 24 giờ sau lần nhắc. follow-up.mjs (markConversationFollowedUp) gọi trên hội thoại trong
 * updateMessagingStore. Trả true khi có giỏ để ghi.
 */
export function touchPendingOrder(conversation, now = Date.now()) {
  const pending = conversation?.pendingOrder;
  if (!pending || typeof pending !== 'object' || !(Array.isArray(pending.items) && pending.items.length)) return false;
  conversation.pendingOrder = { ...pending, remindedAt: Number(now) || Date.now() };
  return true;
}
