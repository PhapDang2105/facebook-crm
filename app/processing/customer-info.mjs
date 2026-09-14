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
// How a customer refers to themself. "a"/"c" are the usual chat shorthands
// for anh/chị; "cô"/"chú" are older customers. "bác" says nothing about gender.
// \b is ASCII-only, so word edges are checked against Unicode letters instead.
const edgeBefore = '(?<![\\p{L}\\p{N}])';
const edgeAfter = '(?![\\p{L}\\p{N}])';
const selfPronoun = '(anh|chị|cô|chú|a|c)';
const selfVerb = '(?:muốn|cần|đặt|lấy|mua|hỏi|đang|có|gửi|ở|chốt|xin|thích|không|ko|chưa|đã|thấy|ăn|dùng|uống|bị|định|tính|sẽ|vừa|mới|order|đây|nè)';
// "chị lấy 2 túi", "cô không ăn ngọt được", "a đặt 1 túi"
const subjectForm = new RegExp(`${edgeBefore}${selfPronoun}\\s+${selfVerb}${edgeAfter}`, 'iu');
// "lấy c 2 túi", "gửi cho chị", "cho anh hỏi", "của chị"
const objectForm = new RegExp(`${edgeBefore}(?:lấy|gửi|gởi|ship|giao|bán|báo|cho|của|với|giúp|để)\\s+(?:cho\\s+)?${selfPronoun}${edgeAfter}(?!\\s*(?:ơi|oi|à|ạ|nhé|nha|nhen|ei|êi|shop))`, 'iu');
// "chị ơi", "anh ơi" address the shop, never the customer.
const vocative = new RegExp(`${edgeBefore}${selfPronoun}\\s+(?:ơi|oi|ei|êi)`, 'iu');

export function genderFromMessage(text) {
  const message = String(text || '');
  const match = message.match(subjectForm) || message.match(objectForm);
  if (!match) return '';
  const word = match[1].toLowerCase();
  // "anh ơi … anh …" is the shop being addressed, so that word says nothing;
  // a single letter is only shorthand when nobody is being called by it.
  const called = message.match(vocative)?.[1]?.toLowerCase() || '';
  if (called && (called === word || word === 'a' || word === 'c')) return '';
  return word === 'anh' || word === 'chú' || word === 'a' ? 'male' : 'female';
}
