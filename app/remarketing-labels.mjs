// Thẻ "Re-marketing" (thẻ nhận sự kiện 'remarketing') — chỉ thẻ CRM, không đụng thẻ Pancake.
// 10/10 (chủ shop): khách nhắn tới từ link ref (m.me/<Page>?ref=…: link chăm sóc lại, mã QR thẻ cảm ơn…) thì tự
// gắn thẻ Re-marketing. Link ref về CRM thành referral không phải quảng cáo: Meta gửi `source: SHORTLINK` (lưu ở
// `qrReferrals`), hay nguồn khác có `ref` (MESSENGER_CODE…, lưu ở `referrals`). Quảng cáo (`source: ADS`) không tính.
// Gắn ngay khi tin về (server nghe sự kiện hộp thư) và quét bù mỗi 5 phút. Mỗi hội thoại chỉ gắn MỘT lần (cờ
// remarketingLabeled): nhân viên gỡ thẻ thì không gắn lại.
const DAY = 24 * 60 * 60 * 1000;
// Quét bù chỉ xét link ref gần đây: không gắn hàng loạt cho lịch sử cũ.
export const remarketingLabelWindowMs = 30 * DAY;

/** Lần gần nhất khách vào từ link ref (ms), 0 nếu chưa từng. */
export function lastRefLinkAt(conversation) {
  const fromLinks = [
    ...(Array.isArray(conversation?.qrReferrals) ? conversation.qrReferrals : []),
    ...(Array.isArray(conversation?.referrals) ? conversation.referrals : []).filter(item => String(item?.ref || '').trim() && item?.source !== 'ADS')
  ];
  return fromLinks.reduce((latest, item) => Math.max(latest, Number(item?.at) || Number(item?.lastAt) || 0), 0);
}

/**
 * Chạy trong updateMessagingStore (sửa `store` tại chỗ). `conversationIds`: chỉ xét các hội thoại này (gắn ngay khi
 * tin về); bỏ trống = quét mọi hội thoại (lượt bù). Trả về `{ changes: [{ conversation, before, after }], flagged }`.
 */
export function applyRemarketingLabels(store, { labels = [], conversationIds = null, now = Date.now() } = {}) {
  const ids = (Array.isArray(labels) ? labels : []).filter(Boolean);
  const result = { changes: [], flagged: 0 };
  if (!ids.length || !Array.isArray(store?.conversations)) return result;
  const only = conversationIds ? new Set(conversationIds) : null;
  for (const conversation of store.conversations) {
    if (!conversation || conversation.remarketingLabeled || conversation.source === 'comment') continue;
    if (only && !only.has(conversation.id)) continue;
    const at = lastRefLinkAt(conversation);
    if (!at || at <= now - remarketingLabelWindowMs) continue;
    conversation.remarketingLabeled = true;
    result.flagged += 1;
    const before = Array.isArray(conversation.labels) ? conversation.labels : [];
    const merged = [...new Set([...before, ...ids])];
    if (merged.length === before.length) continue;
    conversation.labels = merged;
    result.changes.push({ conversation: { id: conversation.id, name: conversation.name || '' }, before: [...before], after: [...merged] });
  }
  return result;
}
