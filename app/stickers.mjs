// Nhãn dán (sticker) của Messenger: Pancake gửi như một ảnh (URL https://content.pancake.vn/2.1/stickers/<id>),
// Meta gửi ảnh kèm `sticker_id`. Hộp thư vẫn vẽ ảnh, nhưng tin mang thêm `sticker: true`, `stickerId` và
// `like: true` với nút 👍 của Messenger — để bot không trả lời "em đã nhận được hình" cho một cái like.

// Nút like của Messenger: cỡ nhỏ (👍 mặc định), cỡ vừa, cỡ lớn (giữ nút lâu).
export const LIKE_STICKER_IDS = new Set(['369239263222822', '369239343222814', '369239383222810']);

const idFromUrl = url => String(url || '').match(/\/stickers\/(\d+)/)?.[1] || '';

/**
 * Thông tin sticker của một tin (đã lưu hay vừa chuẩn hoá) hoặc một attachment thô: { sticker: true,
 * stickerId, like } hay null khi không phải sticker. Nhận ra cả tin cũ đã lưu trước khi có cờ `sticker`
 * (dataUrl / images chứa "/stickers/", hay name 'sticker' do webhook Meta ghi).
 */
export function stickerInfo(message) {
  if (!message || typeof message !== 'object') return null;
  const urls = [message.dataUrl, message.url, message.payload?.url, ...(Array.isArray(message.images) ? message.images : [])];
  const stickerId = String(message.stickerId || message.sticker_id || message.payload?.sticker_id || '').trim()
    || urls.map(idFromUrl).find(Boolean) || '';
  const flagged = message.sticker === true || String(message.type || '').toLowerCase() === 'sticker' || message.name === 'sticker';
  if (!stickerId && !flagged) return null;
  return { sticker: true, stickerId, like: LIKE_STICKER_IDS.has(stickerId) };
}

/** Trường gắn lên tin lưu: { sticker: true, stickerId, like? } hay {} khi không phải sticker. */
export function stickerFields(message) {
  const info = stickerInfo(message);
  if (!info) return {};
  return { sticker: true, ...(info.stickerId ? { stickerId: info.stickerId } : {}), ...(info.like ? { like: true } : {}) };
}
