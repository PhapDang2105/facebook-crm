// R18 (inbox3 V2; chủ shop gửi ảnh quà 12/10): khách xin xem / hỏi hình quà → gửi ẢNH THẬT của quà, không gửi ảnh túi.
// Ảnh nằm trong assets/branding/gifts/ (vào git, deploy theo mã), phục vụ công khai ở /q/brand/gift-*.jpg (bảng brandImageFiles
// trong pancake.mjs — bộ gửi ảnh đọc thẳng từ đĩa). Quạt chưa có ảnh → trả lời bằng chữ (mẫu GIFT_FAN_PHOTO) + thẻ cần người.
// Thêm ảnh Quạt sau này: chép tệp vào assets/branding/gifts/, thêm một dòng brandImageFiles và một dòng GIFT_PHOTO_ROUTES / GIFT_PHOTO_NAMES.
export const GIFT_PHOTO_ROUTES = Object.freeze({
  bat: '/q/brand/gift-bat-gao-dua.jpg',
  muong: '/q/brand/gift-muong-dua.jpg',
  bo: '/q/brand/gift-bo-bat-muong-dua.jpg'
});
export const GIFT_PHOTO_NAMES = Object.freeze({ bat: 'Bát gáo dừa', muong: 'Muỗng dừa', bo: 'Bộ bát gáo dừa + Muỗng dừa', quat: 'Quạt' });

// Ý xin xem ảnh: so trên chữ CÒN DẤU — "anh" không dấu là xưng hô, không phải "ảnh".
const PHOTO_WORDS = /(?<![\p{L}\p{N}])(?:ảnh|hình|hinh|xem|coi|chụp|chup|zem|pic|video|clip)(?![\p{L}\p{N}])/iu;
const FAN = /(?<![\p{L}\p{N}])(?:quạt|quat|quạ)(?![\p{L}\p{N}])/iu;
const BOWL = /(?<![\p{L}\p{N}])(?:bát|bat gao|gáo dừa|gáo|gao dua|chén)(?![\p{L}\p{N}])/iu;
const SPOON = /(?<![\p{L}\p{N}])(?:muỗng|muong|thìa|thia)(?![\p{L}\p{N}])/iu;
const SET = /(?<![\p{L}\p{N}])bộ(?![\p{L}\p{N}])/iu;
const GENERIC_GIFT = /(?<![\p{L}\p{N}])(?:quà|qua tang|tặng|quà tặng)(?![\p{L}\p{N}])/iu;

/**
 * Quà khách muốn xem ảnh, theo thứ tự gửi: 'quat' | 'bat' | 'muong' | 'bo'. [] khi tin không xin xem ảnh quà.
 * Hỏi chung ("quà là gì, chụp xem") → bộ bát + muỗng (quà từ 3 túi); khách live → thêm Quạt (quà live).
 */
export function giftPhotoKinds(text, { livestream = false } = {}) {
  const value = String(text || '').normalize('NFC');
  if (!PHOTO_WORDS.test(value)) return [];
  const kinds = [];
  if (FAN.test(value)) kinds.push('quat');
  const bowl = BOWL.test(value);
  const spoon = SPOON.test(value);
  if ((bowl && spoon) || ((bowl || spoon) && SET.test(value))) kinds.push('bo');
  else if (bowl) kinds.push('bat');
  else if (spoon) kinds.push('muong');
  if (!kinds.length && GENERIC_GIFT.test(value)) kinds.push(...(livestream ? ['quat', 'bo'] : ['bo']));
  return kinds;
}

/** Ảnh markdown (`![tên](url)`) cho mẫu PRODUCT_PHOTOS; `urlOf` đổi đường /q/brand/… thành địa chỉ công khai. */
export function giftPhotoImages(kinds, urlOf = value => value) {
  return kinds.filter(kind => GIFT_PHOTO_ROUTES[kind]).map(kind => `![${GIFT_PHOTO_NAMES[kind]}](${urlOf(GIFT_PHOTO_ROUTES[kind])})`);
}
