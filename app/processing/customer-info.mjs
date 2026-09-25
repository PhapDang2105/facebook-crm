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
  const raw = String(text ?? '');
  const joined = raw.replace(/(\d)[\s.\-()]+(\d)/g, '$1$2');
  // Thử bản đã nối ("0912 345 678") trước, rồi bản gốc: SĐT đứng ngay trước số
  // nhà ("0912345678 3a2/109 đường…") nối vào nhau sẽ hỏng, nhưng nhóm gốc vẫn đúng.
  const groups = [...(joined.match(/\+?\d+/g) || []), ...(raw.match(/\+?\d+/g) || [])];
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
const femaleGivenNames = new Set(('nhung yến loan lệ hân thảo hương lan hoa hạnh thủy thuỷ trang thúy thuý huyền mai dung nga hằng oanh quỳnh trinh diễm kiều nhi '
  + 'tuyết thùy thuỳ my ly vân đào cúc huệ liên nhàn uyên nương hồng thơm nụ bích trâm thắm thu ánh nguyệt hường tiên thư vy vi lài xuyến thoa hiền '
  + 'phượng phụng ngân nhã như quyên sương linh hà châu mỹ mĩ thi yên duyên tuyền hảo hạ nhiên thục thủy kim-anh lan-anh vân-anh mai-anh phương-anh tú-anh thùy-linh thuỳ-linh khánh-linh diệu-linh phương-thảo thanh-thảo thu-thảo thu-hà thu-hương thu-trang huyền-trang quỳnh-anh')
  .split(/\s+/));
const maleGivenNames = new Set(('hùng dũng tuấn nam đức hải quân sơn long phong cường thắng tùng khoa việt thành tiến trung hiếu kiên lâm toàn tài phúc vinh đạt đông hưng '
  + 'huy kha lộc mạnh nghĩa nhật phát quang quốc sang tân thái thịnh trí trọng vũ duy khang đăng kiệt thiện tín tuân vương luân minh công thọ hào khôi khải '
  + 'lực nhân quý sáng thuận triều trường tuyên văn vỹ vĩ đại điền định hiển huân huấn hữu khiêm lợi luật nhất phước quyền sỹ sĩ thạch thăng pháp hoàng-anh tuấn-anh việt-anh đức-anh quốc-anh minh-anh hải-anh duy-anh')
  .split(/\s+/));
const familyNames = new Set('nguyễn trần lê phạm hoàng huỳnh phan vũ võ đặng bùi đỗ hồ ngô dương lý đinh đoàn lương trịnh mai cao tạ lâm hà tô tăng trương quách đào vương phùng kiều thái tôn hứa lưu chu châu diệp lại mạc nghiêm ninh ông thân tiêu triệu từ vi giang'.split(' '));
const femaleMiddleNames = new Set(['thị']);
const maleMiddleNames = new Set(['văn', 'hữu', 'công', 'đình', 'đức', 'quang', 'bá', 'duy', 'xuân']);

const stripDiacritics = value => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
const withKeys = set => { const map = new Map(); for (const item of set) map.set(stripDiacritics(item), item); return map; };
const femaleAscii = withKeys(femaleGivenNames);
const maleAscii = withKeys(maleGivenNames);
const familyAscii = withKeys(familyNames);

/**
 * Giới tính đoán từ tên, để xưng anh/chị mà không cần quyền của Facebook.
 * Tên đệm "Thị" là nữ, "Văn/Hữu/Công/Đình…" là nam; còn lại nhìn tên riêng:
 * chỉ những tên gần như luôn một giới (Nhung, Yến, Loan… nữ; Hùng, Tuấn, Sơn…
 * nam), tên hai giới đều dùng (Anh, Ngọc, Phương, Khánh…) để trung tính.
 * Tên riêng là từ cuối ("Trần Hải Yến"); Facebook hay ghi ngược ("Nhung Vũ",
 * "Pháp Đặng"): từ cuối là họ và từ đầu không phải họ thì tên riêng là từ đầu.
 * Tên gõ không dấu ("Vy Nguyen") chỉ so bản không dấu khi cả tên không có dấu.
 */
export function genderFromName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean).map(word => word.toLowerCase());
  if (words.length < 2) return '';
  const middle = words.slice(1, -1);
  if (middle.some(word => femaleMiddleNames.has(word))) return 'female';
  if (middle.some(word => maleMiddleNames.has(word))) return 'male';
  const ascii = words.every(word => word === stripDiacritics(word));
  const isFamily = word => (ascii ? familyAscii.has(stripDiacritics(word)) : familyNames.has(word));
  const western = isFamily(words.at(-1)) && !isFamily(words[0]);
  const given = western ? words[0] : words.at(-1);
  const pair = western ? `${words[0]}-${words[1]}` : `${words.at(-2)}-${words.at(-1)}`;
  const lookup = (set, map, word) => (ascii ? map.has(stripDiacritics(word)) : set.has(word));
  if (lookup(femaleGivenNames, femaleAscii, pair)) return 'female';
  if (lookup(maleGivenNames, maleAscii, pair)) return 'male';
  if (lookup(femaleGivenNames, femaleAscii, given)) return 'female';
  if (lookup(maleGivenNames, maleAscii, given)) return 'male';
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
  // "lấy cho anh nhà mình", "tặng chị của em", "gửi cho anh ấy": nói về người khác, không phải khách.
  const message = String(text || '').replace(/(?:cho|tặng|gửi|gởi|của|với)\s+(?:anh|chị|cô|chú|a|c)\s+(?:nhà|xã|mình|ấy|em|tôi|con|bạn)(?![\p{L}])/giu, ' ');
  const match = message.match(subjectForm) || message.match(objectForm);
  if (!match) return '';
  const word = match[1].toLowerCase();
  // "anh ơi … anh …" is the shop being addressed, so that word says nothing;
  // a single letter is only shorthand when nobody is being called by it.
  const called = message.match(vocative)?.[1]?.toLowerCase() || '';
  if (called && (called === word || word === 'a' || word === 'c')) return '';
  return word === 'anh' || word === 'chú' || word === 'a' ? 'male' : 'female';
}
