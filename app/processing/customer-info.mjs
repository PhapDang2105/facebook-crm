// Xử lý xưng hô và số điện thoại.
// The looser pattern the CRM used before accepted prefixes that do not exist in
// Vietnam (012, 030, 051, 001...), so a typo became a shipped order that could
// never be delivered.

const vietnamMobilePattern = /^0(3[2-9]|5[25689]|7[06-9]|8[1-9]|9[0-46-9])\d{7}$/;

export function isVietnamesePhone(value) {
  return vietnamMobilePattern.test(String(value ?? '').trim());
}

/** Rewrites +84/84 forms to the local 0-prefixed form; returns '' if unusable. */
export function toLocalPhone(value) {
  const raw = String(value ?? '').replace(/[\s.\-()]/g, '');
  if (!raw) return '';
  const local = raw.startsWith('+84') ? `0${raw.slice(3)}`
    : (raw.startsWith('84') && raw.length === 11 ? `0${raw.slice(2)}` : raw);
  return isVietnamesePhone(local) ? local : '';
}

/**
 * Pulls the first valid Vietnamese mobile number out of free text. Separators
 * inside a number are joined first, so "0385 805 790" and "0385.805.790" work.
 */
export function extractVietnamesePhone(text) {
  const joined = String(text ?? '').replace(/(\d)[\s.\-()]+(\d)/g, '$1$2');
  const groups = joined.match(/\+?\d+/g) || [];
  for (const group of groups) {
    const local = toLocalPhone(group);
    if (local) return local;
  }
  return '';
}

/**
 * Gender for anh/chị addressing, without any Facebook permission: Meta's
 * Facebook Login for Business does not offer pages_user_gender. Sources, in
 * order of trust: what staff set by hand, how the customer refers to
 * themselves at the start of a message, and the middle name — "Thị" is female
 * and "Văn" is male in practice; every other name stays neutral.
 */
export function genderFromName(name) {
  const words = String(name || '').trim().split(/\s+/);
  if (words.length < 2) return '';
  const middle = words.slice(1, -1).map(word => word.toLowerCase());
  if (middle.includes('thị')) return 'female';
  if (middle.includes('văn')) return 'male';
  return '';
}

// Only a self-reference that opens the message counts ("chị muốn đặt…");
// "chị ơi cho em hỏi" addresses the shop, not the customer.
const selfReference = /^\s*(anh|chị|cô|chú|bác)\s+(muốn|cần|đặt|lấy|mua|hỏi|đang|có|gửi|ở|chốt|xin)\b/i;

export function genderFromMessage(text) {
  const match = String(text || '').match(selfReference);
  if (!match) return '';
  const word = match[1].toLowerCase();
  return word === 'anh' || word === 'chú' ? 'male' : 'female';
}
