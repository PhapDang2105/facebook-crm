// Đặc trưng cho mô hình ra quyết định (dùng chung lúc huấn luyện và lúc chạy): n-gram ký tự
// 2–4 của chữ đã bỏ dấu (chịu được không dấu, sai chính tả), từ đơn/từ đôi, và vài đặc trưng
// ngữ cảnh (kênh, mẫu bot vừa gửi, đang ở bước đơn, có SĐT/số lượng/màu túi, độ dài).
const fold = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

export function normalizeIntentText(text) {
  return fold(text).replace(/\+?\d[\d .-]{8,13}/g, ' <sdt> ').replace(/[^a-z0-9<> ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {{ text: string, source?: string, lastTemplate?: string, lastWasOrderStep?: boolean, hasBasket?: boolean, livestream?: boolean }} row
 * @returns {Set<string>}
 */
export function featuresOf(row) {
  const set = new Set();
  const text = normalizeIntentText(row.text).slice(0, 300);
  const padded = ` ${text} `;
  for (const n of [2, 3, 4]) for (let i = 0; i + n <= padded.length; i += 1) set.add(`c${n}:${padded.slice(i, i + n)}`);
  const words = text.split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    set.add(`w:${words[i]}`);
    if (i + 1 < words.length) set.add(`w2:${words[i]} ${words[i + 1]}`);
  }
  const length = words.length <= 2 ? 'xs' : words.length <= 5 ? 's' : words.length <= 12 ? 'm' : 'l';
  const source = row.source === 'comment' ? 'comment' : 'inbox';
  const last = row.lastTemplate || 'none';
  set.add(`len:${length}`);
  set.add(`src:${source}`);
  set.add(`last:${last}`);
  if (row.lastWasOrderStep) set.add('ctx:orderstep');
  if (row.hasBasket) set.add('ctx:basket');
  if (row.livestream) set.add('ctx:live');
  const hasPhone = text.includes('<sdt>');
  const hasNumber = /\b\d{1,2}\b/.test(text);
  const hasColour = /\b(xanh|vang|nau|cacao)\b/.test(text);
  if (hasPhone) set.add('has:sdt');
  if (hasNumber) set.add('has:num');
  if (hasColour) set.add('has:colour');
  if (/\?/.test(String(row.text || ''))) set.add('has:q');
  // Giao đặc trưng (kiểu Vowpal Wabbit): cùng chữ "1" / "xanh" / "ok" nhưng ý khác nhau tuỳ mẫu
  // bot vừa gửi và bước đơn — chỉ giao với từ đơn để không phình từ vựng.
  for (const word of words.slice(0, 8)) set.add(`x:${last}|${word}`);
  if (row.lastWasOrderStep) { if (hasNumber) set.add('x:orderstep|num'); if (hasColour) set.add('x:orderstep|colour'); if (hasPhone) set.add('x:orderstep|sdt'); set.add(`x:orderstep|len:${length}`); }
  set.add(`x:${source}|len:${length}`);
  return set;
}
