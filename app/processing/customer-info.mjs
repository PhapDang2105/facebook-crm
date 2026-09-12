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
