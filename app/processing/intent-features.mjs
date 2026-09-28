// Đặc trưng cho mô hình ra quyết định (dùng chung lúc huấn luyện và lúc chạy): n-gram ký tự
// 2–4 của chữ đã bỏ dấu (chịu được không dấu, sai chính tả), từ đơn/từ đôi, và vài đặc trưng
// ngữ cảnh (kênh, mẫu bot vừa gửi, đang ở bước đơn, có SĐT/số lượng/màu túi, độ dài).
// Vòng 6 (hợp đồng dữ liệu v2): thêm ngữ cảnh bot vừa xin gì (prevBotAsks), có địa chỉ trong tin,
// số túi, số màu, đơn đã chốt (hasOrder/orderAgeMin) và các đặc trưng giao tương ứng. Thiếu trường
// nào thì đặc trưng đó không phát sinh → mô hình v5 (không biết các đặc trưng này) vẫn chạy.
const fold = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

export function normalizeIntentText(text) {
  return fold(text).replace(/\+?\d[\d .-]{8,13}/g, ' <sdt> ').replace(/[^a-z0-9<> ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Từ hành chính trong địa chỉ (bỏ dấu) — cùng tinh thần ADDRESS_WORDS của rule-intent.mjs.
// "quận" chỉ tính khi kèm số/tên ("quan tam" là quan tâm); "tp" phải là "tp hcm"/"tp." dạng đầu địa danh.
// "đường" chỉ tính khi kèm tên/số ("không đường", "đường không" là đường ăn); "ấp" kèm số/tên.
export const ADDRESS_WORDS = /\b(xa|phuong|huyen|thi tran|thi xa|thanh pho|tphcm|tp hcm|hcm|ha noi|da nang|thon|khu pho|kp|ngo|hem|ngach|so nha|chung cu|tinh)\b|\b(quan|q|p|tp|ap) ?\d{1,2}\b|\bquan (?!tam\b|trong\b)[a-z]+|\btp [a-z]+|\bap [a-z]{2,}|\bduong (?!(?:khong|ko|k|nhieu|it|hoa|an|kieng|nao|gi|ngot|phen|sao)\b)[a-z0-9]+/;

const NUMBER_WORDS = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 };
const BAG_RE = /\b(\d{1,2}|mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)\s*(tui|tuy|goi|bich|bit|bao|hop|set|combo)\b/g;

/** Đếm số túi khách nêu trong chữ đã bỏ dấu ("2 túi xanh 1 nâu" → 3; không nêu → 0). */
export function countBags(text) {
  const normalized = normalizeIntentText(text);
  let total = 0;
  for (const match of normalized.matchAll(BAG_RE)) total += NUMBER_WORDS[match[1]] ?? Number(match[1]);
  return Math.min(total, 99);
}

/** Số màu túi khác nhau khách nhắc (nâu và cacao là một). */
export function countColours(text) {
  const normalized = normalizeIntentText(text);
  const set = new Set();
  for (const match of normalized.matchAll(/\b(xanh|vang|nau|cacao)\b/g)) set.add(match[1] === 'cacao' ? 'nau' : match[1]);
  return set.size;
}

// Mẫu mà chỉ nhìn mã đã biết bot vừa xin gì. ORDER_ADDRESS* điền {missing} nên phải đọc chữ.
const TEMPLATE_ASKS = {
  ORDER_PHONE: 'phone',
  ASK_FLAVOR: 'flavor', ORDER_INFO_ASK_FLAVOR: 'flavor', ASK_FLAVOR_NGUYENBAN: 'flavor', COMBO3_FLAVOR: 'flavor', RECOMMEND_BEGINNER: 'flavor',
  ORDER_CONFIRMATION: 'confirm', ORDER_EXISTING_CONFIRM: 'confirm', ORDER_UPDATED: 'confirm', UPSELL_TWO_BAGS: 'confirm',
  CONFIRM_YES: 'phone_address'
};
// Khi không đọc được chữ: mặc định theo họ mẫu.
const TEMPLATE_FALLBACK = { ORDER_ADDRESS: 'phone_address', ORDER_ADDRESS_CLARIFY: 'address', ORDER_ADDRESS_CHOOSE: 'address', ORDER_ADDRESS_REMIND: 'phone_address' };
const ASK_VERB = '(?:xin|gui|cho em|cho minh|de lai|cung cap|bo sung|nhan cho em|gui giup|gui lai)';
const ASK_PHONE = new RegExp(`\\b${ASK_VERB}\\b[^.!?\\n]{0,60}?\\b(so dien thoai|sdt|so dt|so dthoai)\\b`);
const ASK_ADDRESS = new RegExp(`\\b${ASK_VERB}\\b[^.!?\\n]{0,60}?\\b(dia chi|d\\/c|dc nhan hang)\\b`);
const ASK_CONFIRM = /\b(xac nhan lai|dung khong|dung ko|dung k|dung chua|dung chu|nhan "?dung"?|nhan dung giup)\b/;
const ASK_FLAVOR = /\b(loai nao|vi nao|tui nao|mau nao|vi gi|loai gi|hay tui (vang|nau|xanh)|lay tui (xanh|vang|nau) hay)\b/;
const ASK_QUANTITY = /\b(may tui|may goi|may bich|so luong|bao nhieu tui|moi loai may|moi vi may)\b/;

/**
 * Bot vừa xin gì ở câu trước: 'phone' | 'address' | 'phone_address' | 'flavor' | 'quantity' | 'confirm' | ''.
 * Ưu tiên mã mẫu khi mã đã nói rõ; mẫu điền {missing} (ORDER_ADDRESS…) thì đọc chữ bỏ dấu của câu bot.
 * @param {string} prevBotText
 * @param {string} [lastTemplateId]
 */
export function askedSlotOf(prevBotText, lastTemplateId = '') {
  const template = String(lastTemplateId || '').trim();
  if (TEMPLATE_ASKS[template]) return TEMPLATE_ASKS[template];
  const text = fold(prevBotText).replace(/[^a-z0-9/" ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text) {
    if (ASK_CONFIRM.test(text)) return 'confirm';
    if (ASK_FLAVOR.test(text)) return 'flavor';
    if (ASK_QUANTITY.test(text)) return 'quantity';
    const phone = ASK_PHONE.test(text) || /\b(so dien thoai|sdt) (va|\+|cung|kem) dia chi\b/.test(text);
    const address = ASK_ADDRESS.test(text) || /\b(so dien thoai|sdt) (va|\+|cung|kem) dia chi\b/.test(text);
    if (phone && address) return 'phone_address';
    if (address) return 'address';
    if (phone) return 'phone';
  }
  return TEMPLATE_FALLBACK[template] || '';
}

const bagBucket = count => (count >= 4 ? '4+' : String(Math.max(0, count)));
const colourBucket = count => (count >= 2 ? '2+' : String(Math.max(0, count)));

/**
 * @param {{ text: string, source?: string, lastTemplate?: string, lastWasOrderStep?: boolean, hasBasket?: boolean, livestream?: boolean,
 *   prevBot?: string, prevBotAsks?: string, hasOrder?: boolean, orderAgeMin?: number, phoneInText?: boolean|string, addressInText?: boolean,
 *   bagCount?: number, basketItems?: unknown[] }} row
 * @returns {Set<string>}
 */
export function featuresOf(row) {
  const set = new Set();
  const rawText = String(row.text || '');
  const text = normalizeIntentText(rawText).slice(0, 300);
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
  // phoneInText có thể là chuỗi SĐT (engine) hay boolean (dataset): chỉ cần có là tính.
  const hasPhone = text.includes('<sdt>') || Boolean(row.phoneInText);
  const hasNumber = /\b\d{1,2}\b/.test(text);
  const hasColour = /\b(xanh|vang|nau|cacao)\b/.test(text);
  const hasAddress = row.addressInText === undefined ? ADDRESS_WORDS.test(text) : Boolean(row.addressInText);
  const bags = Number.isFinite(Number(row.bagCount)) && row.bagCount !== null && row.bagCount !== '' ? Number(row.bagCount) : countBags(rawText);
  const bag = bagBucket(bags);
  if (hasPhone) set.add('has:sdt');
  if (hasNumber) set.add('has:num');
  if (hasColour) set.add('has:colour');
  if (hasAddress) set.add('has:addr');
  if (/\?/.test(rawText)) set.add('has:q');
  set.add(`bag:${bag}`);
  set.add(`colours:${colourBucket(countColours(rawText))}`);
  // Đơn đã chốt trước đó (ngữ cảnh "đơn của em sao rồi" / "sửa đơn"): chỉ khi engine/dataset đưa vào.
  const hasOrder = Boolean(row.hasOrder);
  // orderAgeMin null/thiếu (JSON không ghi được Infinity) = không biết tuổi đơn → không tính "<60m".
  const orderAge = row.orderAgeMin === null || row.orderAgeMin === undefined || row.orderAgeMin === '' ? Infinity : Number(row.orderAgeMin);
  if (hasOrder) { set.add('ctx:order'); if (Number.isFinite(orderAge) && orderAge < 60) set.add('ctx:order<60m'); }
  // Bot vừa xin gì: lấy từ trường có sẵn, không có thì đọc câu bot trước (nếu được đưa vào).
  const asks = String(row.prevBotAsks || '') || (row.prevBot ? askedSlotOf(row.prevBot, row.lastTemplate) : '');
  if (asks) {
    set.add(`ask:${asks}`);
    if (hasPhone) set.add(`x:ask:${asks}|has:sdt`);
    if (hasAddress) set.add(`x:ask:${asks}|has:addr`);
  }
  // Giao đặc trưng (kiểu Vowpal Wabbit): cùng chữ "1" / "xanh" / "ok" nhưng ý khác nhau tuỳ mẫu
  // bot vừa gửi và bước đơn — chỉ giao với từ đơn để không phình từ vựng.
  for (const word of words.slice(0, 8)) set.add(`x:${last}|${word}`);
  if (row.lastWasOrderStep) { if (hasNumber) set.add('x:orderstep|num'); if (hasColour) set.add('x:orderstep|colour'); if (hasPhone) set.add('x:orderstep|sdt'); set.add(`x:orderstep|len:${length}`); }
  if (row.hasBasket) set.add(`x:basket|bag:${bag}`);
  if (hasOrder) for (const word of words.slice(0, 5)) set.add(`x:order|${word}`);
  set.add(`x:${source}|len:${length}`);
  return set;
}
