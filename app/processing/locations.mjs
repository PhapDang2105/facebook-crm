// Ánh xạ địa chỉ khách nhắn tự nhiên vào 3 cấp hành chính chuẩn của kho.
//
// Danh mục ở database/seeds/dmhc.csv là nguồn duy nhất cho tên tỉnh, quận,
// phường mà file xuất kho chấp nhận. Địa chỉ được đọc từ cuối lên: tìm tỉnh
// trước (63 tên, gần như không nhầm), rồi quận trong đúng tỉnh đó, rồi phường
// trong đúng quận đó — vì hơn 1.300 tên phường/xã trùng nhau giữa các tỉnh nên
// không bao giờ tra phường đứng một mình. Khi thiếu một cấp, cấp đó được suy
// ra từ cấp dưới nếu chỉ có đúng một khả năng; còn mơ hồ thì để trống thay vì
// đoán bừa, để dòng đơn không bị gửi sai địa chỉ.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config.mjs';
import { NEW_WARD_UNITS_2025 } from './new-ward-names-2025.mjs';

const locationsPath = process.env.LOCATIONS_PATH
  || path.join(projectRoot, 'database', 'seeds', 'dmhc.csv');

let index = null;

// ===== Chuẩn hóa chuỗi =====

/** Bỏ dấu, viết thường, đ→d; mỗi ký tự gốc cho đúng một ký tự để giữ nguyên vị trí. */
const SEPARATORS = ',;\n';

function normalizeChar(char) {
  if (SEPARATORS.includes(char)) return char;
  const lower = char.toLowerCase();
  if (lower === 'đ') return 'd';
  const base = lower.normalize('NFD')[0] || ' ';
  return /[a-z0-9]/.test(base) ? base : ' ';
}

/** Chuỗi chuẩn hóa cùng độ dài UTF-16 với chuỗi gốc (giữ dấu phân cách đoạn), để vị trí khớp dùng được trên cả hai. */
function normalizeAligned(value) {
  const text = String(value ?? '');
  let result = '';
  for (let i = 0; i < text.length; i += 1) result += normalizeChar(text.charAt(i));
  return result;
}

export function normalizeLocationKey(value) {
  return normalizeAligned(value).replace(/[,;\n\s]+/g, ' ').trim();
}

// Tiền tố loại hình theo cấp, đã chuẩn hóa. Thứ tự dài trước để "thanh pho"
// được thử trước "tp", "thi tran" trước "tt".
const PROVINCE_PREFIXES = ['thanh pho', 'tinh', 'tp'];
const DISTRICT_PREFIXES = ['thanh pho', 'thi xa', 'quan', 'huyen', 'tp', 'tx', 'q', 'h'];
const WARD_PREFIXES = ['thi tran', 'phuong', 'xa', 'tt', 'p', 'x'];
const ALL_PREFIXES = [...new Set([...PROVINCE_PREFIXES, ...DISTRICT_PREFIXES, ...WARD_PREFIXES])].sort((a, b) => b.length - a.length);

// Sáp nhập tỉnh 1/7/2025: khách ghi tỉnh mới ("Phường Tân Đông Hiệp, Hồ Chí
// Minh") nhưng danh mục kho vẫn là 63 tỉnh cũ. Tỉnh mới → các tỉnh cũ đã nhập
// vào, để khi không tìm thấy phường/quận trong tỉnh ghi trên địa chỉ thì tìm
// tiếp ở tỉnh cũ và ghi theo tên cũ mà kho đang dùng. Khoá là tên tỉnh đã
// chuẩn hoá, bỏ tiền tố.
const MERGED_PROVINCES = {
  'ho chi minh': ['binh duong', 'ba ria vung tau'],
  'tuyen quang': ['ha giang'],
  'lao cai': ['yen bai'],
  'thai nguyen': ['bac kan'],
  'phu tho': ['vinh phuc', 'hoa binh'],
  'bac ninh': ['bac giang'],
  'hung yen': ['thai binh'],
  'hai phong': ['hai duong'],
  'ninh binh': ['ha nam', 'nam dinh'],
  'quang tri': ['quang binh'],
  'da nang': ['quang nam'],
  'quang ngai': ['kon tum'],
  'gia lai': ['binh dinh'],
  'khanh hoa': ['ninh thuan'],
  'lam dong': ['dak nong', 'binh thuan'],
  'dak lak': ['phu yen'],
  'dong nai': ['binh phuoc'],
  'tay ninh': ['long an'],
  'can tho': ['soc trang', 'hau giang'],
  'vinh long': ['ben tre', 'tra vinh'],
  'dong thap': ['tien giang'],
  'ca mau': ['bac lieu'],
  'an giang': ['kien giang']
};

// Vòng 12: tên phường/xã MỚI (sau 1/7/2025). Danh mục kho (dmhc.csv) vẫn là đơn vị cũ nên các tên này không tra
// được ở đó; khách ghi đúng tên mới (có hay không có chữ "phường/xã") + tỉnh khớp là đủ → giữ nguyên chữ khách ghi,
// nhân viên đối chiếu (ghi chú đơn).
// fix-addr (01/10): đủ 3.321 đơn vị của 34 tỉnh/thành từ 34 nghị quyết UBTVQH (trước đây chỉ 423 tên tay của 12 tỉnh,
// thiếu Đồng Nai "Trấn Biên"…) — xem nguồn trong new-ward-names-2025.mjs. Giá trị: tên bỏ loại hình, ngăn bằng "|".
const NEW_WARD_NAMES = Object.fromEntries(Object.entries(NEW_WARD_UNITS_2025)
  .map(([key, units]) => [key, units.split('|').map(unit => unit.replace(/^(?:phường|xã|đặc khu)\s+/u, '')).join('|')]));
let newWardKeys = null;
function newWardIndex() {
  if (!newWardKeys) {
    newWardKeys = new Map(Object.entries(NEW_WARD_NAMES).map(([key, names]) => [key, [...new Set(names.split('|').map(normalizeLocationKey).filter(Boolean))].sort((a, b) => b.length - a.length)]));
  }
  return newWardKeys;
}

/** Tỉnh mới (sau 2025) chứa tỉnh này: chính nó nếu là tỉnh mới, không thì tỉnh đã nhận nó. */
function newProvinceKeys(province) {
  const bare = province?.bare || '';
  if (!bare) return [];
  const keys = [bare];
  for (const [parent, members] of Object.entries(MERGED_PROVINCES)) if (members.includes(bare)) keys.push(parent);
  if (bare === 'thua thien hue') keys.push('hue');
  return keys;
}

/**
 * Tên phường/xã mới sau sáp nhập (NEW_WARD_NAMES) có trong địa chỉ không, thuộc đúng tỉnh mới
 * của `province`. `skip(start, end)` loại khoảng đã là tên quận/tỉnh (trừ khi khách ghi rõ
 * "phường/xã" trước tên). Trả tên đã chuẩn hoá hoặc ''.
 */
export function newWardMentioned(text, province, { skip = () => false, normalized = null, raw = null, typedOnly = false, locationIndex = null } = {}) {
  const expanded = normalized === null ? expandAddressAbbreviations(text) : '';
  const norm = normalized ?? normalizeAligned(expanded);
  // Tên đường trùng tên phường ("đường Bà Điểm", "phố Hoàng Mai") đã bị loại trong newWardMatches; khách gõ có dấu
  // thì phải đúng dấu tên mới (fix-addr 01/10). Không có bản gốc (chỉ có chuỗi chuẩn hoá) thì không so dấu.
  for (const match of newWardMatches(norm, raw ?? (normalized === null ? expanded : norm), province, locationIndex)) {
    if (!match.wardTyped && (typedOnly || skip(match.start, match.end))) continue;
    return match.name;
  }
  return '';
}

// fix-addr (01/10): dạng có dấu của từng tên mới, để so đúng dấu ("Đông Trạch" ≠ "Đồng Trạch").
let newWardAccents = null;
function newWardAccentIndex() {
  if (!newWardAccents) {
    newWardAccents = new Map();
    for (const [key, names] of Object.entries(NEW_WARD_NAMES)) {
      const byKey = new Map();
      for (const name of names.split('|')) {
        const norm = normalizeLocationKey(name);
        if (norm) byKey.set(norm, [...(byKey.get(norm) || []), name]);
      }
      newWardAccents.set(key, byKey);
    }
  }
  return newWardAccents;
}

// Dấu thanh (huyền, sắc, ngã, hỏi, nặng) tách khỏi dấu mũ/móc/trăng: "Hoà" và "Hòa" chỉ khác chỗ đặt dấu.
const TONE_MARKS = /[̣̀́̃̉]/g;

/** Khoá so dấu theo từng chữ: chữ có mũ/móc/trăng + dấu thanh, không phụ thuộc chỗ đặt dấu thanh. */
export function accentKey(value) {
  return String(value ?? '').normalize('NFD').toLowerCase().split(/[^\p{L}\p{N}̀-ͯ]+/u).filter(Boolean).map(word => {
    const tone = (word.match(TONE_MARKS) || []).join('');
    return `${word.replace(TONE_MARKS, '').normalize('NFC')}${tone}`;
  }).join(' ');
}

/**
 * Chữ khách gõ hợp với tên có dấu không, xét từng chữ: chữ khách gõ có dấu thì phải đúng dấu ("đông" ≠ "đồng");
 * chữ gõ không dấu thì bỏ qua ("bình chau" vẫn là "Bình Châu").
 */
export function accentCompatible(typed, name) {
  const left = accentKey(typed).split(' ');
  const right = accentKey(name).split(' ');
  if (left.length !== right.length) return !sliceHasDiacritics(typed);
  return left.every((word, index) => !sliceHasDiacritics(word) || word === right[index]);
}

/** Đoạn chữ khách gõ có dấu nào không (dấu thanh hay mũ/móc, kể cả "đ"). */
function sliceHasDiacritics(slice) {
  return /[^\x00-\x7f]/.test(String(slice || '').normalize('NFC').replace(/[^\p{L}]/gu, ''));
}

const WARD_TYPE_WORDS = ['phuong', 'xa', 'p', 'x', 'thi tran', 'tt'];

/**
 * fix-addr (01/10): mọi lần khách ghi một tên phường/xã MỚI (NEW_WARD_NAMES) của tỉnh mới chứa `province`,
 * kèm vị trí trên chuỗi chuẩn hoá: [{ name, start, end, wardTyped }]. Khách gõ có dấu thì phải đúng dấu tên mới
 * (không khớp lệch dấu, không fuzzy). Tên đứng sau từ chỉ đường mà không có chữ "phường/xã" thì không tính.
 */
function newWardMatches(norm, raw, province, locationIndex = null) {
  const matches = [];
  const index = newWardIndex();
  const accents = newWardAccentIndex();
  const keys = newProvinceKeys(province);
  if (!keys.length) return matches;
  let catalog = locationIndex;
  if (!catalog) { try { catalog = loadLocationIndex(); } catch { catalog = null; } }
  for (const key of keys) {
    const names = index.get(key) || [];
    const oldNames = catalog ? oldWardNamesOf(key, catalog) : null;
    for (const name of names) {
      // Lọc nhanh trước khi chạy biểu thức (hơn 3.000 tên): chữ cuối của tên phải có trong chuỗi.
      if (!norm.includes(name.slice(name.lastIndexOf(' ') + 1))) continue;
      const pattern = boundary(name);
      let match;
      while ((match = pattern.exec(norm))) {
        const start = match.index;
        const end = start + match[0].length;
        const slice = raw.slice(start, end);
        if (sliceHasDiacritics(slice) && !(accents.get(key)?.get(name) || []).some(official => accentCompatible(slice, official))) continue;
        const typed = prefixBefore(norm, start);
        // R13 (K4): "đặc khu Phú Quốc" cũng là khách ghi rõ loại hình cấp xã mới.
        const wardTyped = Boolean(typed && WARD_TYPE_WORDS.includes(typed.prefix)) || SPECIAL_ZONE_BEFORE.test(norm.slice(0, start));
        if (!wardTyped && streetWordBefore(norm, start)) continue;
        // R13 (K4): tên đứng ngay sau thôn/ấp/khu/xóm/tổ/khóm/chợ ("thôn Phước Hải", "ấp Mỹ Thạnh", "khu Thống Nhất 2")
        // hay sau họ người ("võ Nguyên Giáp") là tên thôn/tên đường, không phải phường/xã mới.
        if (!wardTyped && hamletOrSurnameBefore(norm, raw, start)) continue;
        // R13 (K4): tên mới chỉ là phần đầu của một tên dài hơn khách ghi ("thanh xuân bắc", "hiệp bình chánh",
        // "hải châu 2", "bình hưng hòa B") hay phần đuôi của một tên cũ dài hơn: không phải tên mới đó.
        if (partOfLongerName(norm, start, end, name, names, oldNames, wardTyped)) continue;
        // R13 (K4): tên nằm trong một tên tỉnh ("Bà Rịa - Vũng Tàu" do "brvt" mở ra ⊃ "Vũng Tàu"): là tên tỉnh.
        if (!wardTyped && catalog && insideProvinceName(norm, start, end, name, catalog)) continue;        matches.push({ name, start, end, wardTyped });
      }
    }
  }
  // R13 (K4): khách đã ghi rõ "phường/xã X" thì chỉ xét X — tên khác trùng tên mới trong câu (tên thôn, tên đường,
  // mốc: "thôn Phước Hải phường Tân Hải", "Ngõ 161 Ngọc Hồi … phường Yên Sở") không phải phường/xã của địa chỉ.
  if (matches.some(match => !match.wardTyped) && EXPLICIT_WARD_PHRASE.test(norm)) return matches.filter(match => match.wardTyped);
  return matches;
}

// "phường/xã + tên chữ" khách ghi rõ ("thị xã …" không tính; "phường 5" là phường số, không tính).
const EXPLICIT_WARD_PHRASE = /(?<![a-z0-9])(?<!thi )(?:phuong|xa|dac khu)\s+(?!hoi(?![a-z0-9]))[a-z]{2,}/;
const SPECIAL_ZONE_BEFORE = /(?:^|[^a-z0-9])dac khu\s*$/;
const HAMLET_WORDS_BEFORE = new Set(['thon', 'ap', 'xom', 'khom', 'to', 'doi', 'ban', 'lang', 'kp', 'tdp', 'khu', 'cho', 'khoi', 'khu pho', 'to dan pho']);
// Họ người hay gặp trong tên đường; khách gõ có dấu thì phải đúng dấu của họ ("khả lễ" không phải họ Lê).
const SURNAMES_BEFORE = new Map(Object.entries({ vo: 'võ', nguyen: 'nguyễn', le: 'lê', tran: 'trần', pham: 'phạm', phan: 'phan', hoang: 'hoàng', huynh: 'huỳnh', vu: 'vũ', dang: 'đặng', bui: 'bùi', ngo: 'ngô', ly: 'lý', truong: 'trương', dinh: 'đinh', ton: 'tôn' }));

function surnameAt(norm, raw, start, last) {
  const accented = SURNAMES_BEFORE.get(last);
  if (!accented) return false;
  const wordEnd = norm.slice(0, start).replace(/\s+$/, '').length;
  const typed = String(raw || '').slice(wordEnd - last.length, wordEnd);
  return !sliceHasDiacritics(typed) || accentKey(typed) === accentKey(accented);
}

function hamletOrSurnameBefore(norm, raw, start) {
  const before = norm.slice(0, start);
  const segmentStart = Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
  const words = before.slice(segmentStart).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const last = words.at(-1);
  return HAMLET_WORDS_BEFORE.has(last) || HAMLET_WORDS_BEFORE.has(words.slice(-2).join(' ')) || HAMLET_WORDS_BEFORE.has(words.slice(-3).join(' ')) || surnameAt(norm, raw, start, last);
}

// Tên phường/xã CŨ (bỏ loại hình) của mọi tỉnh cũ thuộc một tỉnh mới, để biết tên khách ghi là tên cũ dài hơn.
const oldWardNameCache = new WeakMap();
function oldWardNamesOf(newKey, locationIndex) {
  let byKey = oldWardNameCache.get(locationIndex);
  if (!byKey) { byKey = new Map(); oldWardNameCache.set(locationIndex, byKey); }
  let names = byKey.get(newKey);
  if (!names) {
    names = new Set();
    for (const province of locationIndex.provinces || []) {
      if (!newProvinceKeys(province).includes(newKey)) continue;
      for (const district of province.districts.values()) for (const ward of district.wards.values()) names.add(ward.bare);
    }
    byKey.set(newKey, names);
  }
  return names;
}

function partOfLongerName(norm, start, end, name, newNames, oldNames, wardTyped) {
  const rest = norm.slice(end);
  const stop = rest.search(/[,;\n]/);
  const after = (stop < 0 ? rest : rest.slice(0, stop)).trim().split(/\s+/).filter(Boolean);
  if (after.length) {
    // "Bình Hưng Hòa B", "Hải Châu 2", "Thường Phước 1": chữ A/B hay số một-hai chữ số liền sau là phần của tên.
    if (/^(?:[ab]|\d{1,2})$/.test(after[0]) && !(after[1] && /^\d/.test(after[1]))) return true;
    for (const count of [1, 2]) {
      if (after.length < count) break;
      const longer = `${name} ${after.slice(0, count).join(' ')}`;
      if (oldNames?.has(longer) || newNames.includes(longer)) return true;
    }
  }
  if (!wardTyped) {
    const before = norm.slice(0, start);
    const segmentStart = Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
    const words = before.slice(segmentStart).trim().split(/\s+/).filter(Boolean);
    for (const count of [1, 2]) {
      if (words.length < count) break;
      const longer = `${words.slice(-count).join(' ')} ${name}`;
      if (oldNames?.has(longer) || newNames.includes(longer)) return true;
    }
    // Tên mới chỉ GỐI lên một tên phường/xã cũ ba chữ khách ghi liền sau ("lương thế VINH THANH xuân bắc": "vĩnh thanh"
    // gối lên "Thanh Xuân Bắc"): là tình cờ ghép chữ của tên đường với tên phường cũ.
    const own = name.split(' ');
    if (oldNames && own.length >= 2) {
      if (after.length >= 2 && oldNames.has(`${own.at(-1)} ${after[0]} ${after[1]}`)) return true;
      if (after.length >= 1 && own.length === 2 && oldNames.has(`${name} ${after[0]}`)) return true;
    }
  }
  return false;
}

function insideProvinceName(norm, start, end, name, locationIndex) {
  for (const province of locationIndex.provinces || []) {
    for (const alias of province.aliases) {
      if (alias === name || !` ${alias} `.includes(` ${name} `)) continue;
      const pattern = boundary(alias);
      let match;
      while ((match = pattern.exec(norm))) {
        if (match.index <= start && match.index + match[0].length >= end) return true;
      }
    }
  }
  return false;
}

/** Các tỉnh cũ đã nhập vào tỉnh này (theo danh mục), rỗng nếu tỉnh không nhận thêm ai. */
export function mergedProvinceMembers(province, locationIndex = loadLocationIndex()) {
  const members = MERGED_PROVINCES[province?.bare] || [];
  return members.map(bare => locationIndex.provinces.find(entry => entry.bare === bare)).filter(Boolean);
}

function stripPrefix(key, prefixes) {
  for (const prefix of prefixes) {
    if (key === prefix) return '';
    if (key.startsWith(`${prefix} `)) return key.slice(prefix.length + 1);
  }
  return key;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Cách viết tắt hay gặp trong tin nhắn. Chạy trên chuỗi gốc (các mẫu đều là
// ASCII) và thay bằng tên đầy đủ có dấu để phần địa chỉ đường phố còn lại
// vẫn đọc được.
// `\b` của JavaScript chỉ hiểu chữ ASCII nên "Ấp 2" cũng khớp `\bp`; dùng ranh
// giới theo Unicode để chữ có dấu đứng trước không bị coi là đầu từ.
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const abbreviation = (body, replacement) => [new RegExp(`${B}(?:${body})${E}`, 'giu'), replacement];
const ABBREVIATIONS = [
  // Câu dẫn, số điện thoại, chữ đệm cuối câu: không phải địa chỉ.
  [/^\s*(?:địa\s*chỉ|dia\s*chi|đ\/c|d\/c|đc|dc|giao\s+(?:đến|tới|về)|gửi\s+(?:về|đến|tới)|ship\s+(?:về|đến|tới)|nhận\s+hàng(?:\s+tại)?)\s*[:：\-]?\s*/iu, ''],
  // R13 fix2 (B3): "quê tôi ở đông anh hà nội nhưng gửi về 12 lê lợi vinh" — nơi giao là cụm SAU "gửi/giao/ship về" khi trước đó
  // khách kể một nơi khác (quê, ở, nhà) rồi nối bằng "nhưng/còn/mà"; địa chỉ thường không có cấu trúc này.
  [/^.*?(?<![\p{L}])(?:quê|que|đang\s+ở|dang\s+o|hiện\s+ở|hien\s+o|nhà\s+ở|nha\s+o|ở|o)(?![\p{L}]).*?(?<![\p{L}])(?:nhưng|nhung|còn|con|mà|ma)\s+(?:gửi|gui|giao|ship|chuyển|chuyen)\s+(?:về|ve|đến|den|tới|toi|cho)\s*[:：]?\s*/iu, ''],
  [/(?:sđt|sdt|đt|dt|phone|tel|zalo)\s*[:：]?\s*(?:\+?84|0)[\d\s.\-]{8,}/giu, ''],
  [/(?<![\d\/])(?:\+?84|0)\d{9}(?![\d\/])/gu, ''],
  // fix-addr (01/10): chữ đệm là một từ riêng — "phố Láng Hạ" không bị cắt thành "Láng H".
  [/[\s,]*(?<![\p{L}\p{N}])(?:nhé|nhe|nha|nhá|ạ|với|giúp\s+em|giùm|dùm)\s*[.!]*\s*$/iu, ''],
  // Mã bưu điện ở cuối.
  [/(?<![\d\/])\d{5,6}\s*$/u, ''],
  // Dấu "/" có khoảng trắng bên cạnh là ngăn cách đoạn; "123/45" là số nhà.
  [/\s+\/\s*|\s*\/\s+/g, ', '],
  // Tiếng Anh: Ward 7 / District 1 / City.
  [new RegExp(`${B}ward\\s*(\\d{1,2})${E}`, 'giu'), 'Phường $1'],
  [new RegExp(`${B}district\\s*(\\d{1,2})${E}`, 'giu'), 'Quận $1'],
  abbreviation('ho\\s*chi\\s*minh\\s*city|hcm\\s*city|hồ\\s*chí\\s*minh\\s*city|hochiminh', 'Thành phố Hồ Chí Minh'),
  abbreviation('hanoi|ha\\s*noi\\s*city|hà\\s*nội\\s*city', 'Hà Nội'),
  abbreviation('city|province|district|ward|town', ''),
  // R13 (K8): "phường Sài Gòn" là phường MỚI của TP.HCM — giữ tên phường, vẫn cho biết tỉnh; "Sài Gòn" trơ vẫn là TP.HCM.
  [new RegExp(`(?<=${B}(?:phường|phuong|p\\.?)\\s*)(?:sai\\s*gon|sài\\s*gòn)${E}`, 'giu'), 'Sài Gòn, Thành phố Hồ Chí Minh'],
  [new RegExp(`(?<!Sài Gòn, )${B}(?:tp\\s*\\.?\\s*hcm|tphcm|hcmc|hcm|sg)${E}`, 'giu'), 'Thành phố Hồ Chí Minh'],
  // R14 (…958786): "Saigon" là một phần TÊN tòa nhà/khu ("VPBank Saigon Tower", "Saigon Royal", "Sài Gòn Pearl") → giữ
  // nguyên; trước đây bung thành "Thành phố Hồ Chí Minh" giữa tên rồi bị cắt ("VPBank, Tower").
  [new RegExp(`(?<!(?:phường|phuong|p\\.?)\\s*)${B}(?:sai\\s*gon|sài\\s*gòn)${E}(?!, Thành phố Hồ Chí Minh)(?!\\s*(?:tower|royal|pearl|center|centre|plaza|court|building|residence|residences|square|mall|garden|gardens|bay|park|riverside|airport|apartment|mansion|gateway|land|heights|avenue|south|hotel|coop|co\\.?op|food|trade|bank)${E})`, 'giu'), 'Thành phố Hồ Chí Minh'],
  // R13 (K8): "phuong hai thi xa quang tri" = Phường 2 — số viết bằng chữ ngay sau "phường", liền sau là hết đoạn hoặc
  // một loại hình cấp trên ("phường Hai Bà Trưng", "phường Ba Đình" không đổi).
  // R13 fix2 (B2): "nha sach phuong nam", "chi phuong hai", "gui chi Phuong Tam" là tên riêng/cửa hàng không dấu, không phải phường
  // số. Chỉ đổi khi đoạn (giữa hai dấu ngắt) bắt đầu bằng chính cụm này, hoặc trước nó trong cùng đoạn có chữ số (số nhà/đường:
  // "03/01 quang trung phuong hai thi xa quang tri"); không đổi khi từ liền trước là xưng hô/cơ sở (anh, chị, shop, công ty…).
  [new RegExp(`${B}(phường|phuong)\\s+(một|mot|hai|ba|bốn|bon|năm|nam|sáu|sau|bảy|bay|tám|tam|chín|chin|mười|muoi)(?=\\s*(?:[,;.\\n]|$|(?:quận|quan|q|tp|thành\\s+phố|thanh\\s+pho|thị\\s+xã|thi\\s+xa|tx|huyện|huyen)${E}))`, 'giu'),
    (match, type, word, offset, source) => {
      const segmentStart = Math.max(source.lastIndexOf(',', offset), source.lastIndexOf(';', offset), source.lastIndexOf('.', offset), source.lastIndexOf('\n', offset)) + 1;
      const before = source.slice(segmentStart, offset).trim();
      if (before && !/\d/.test(before)) return match;
      if (/(?:^|[\s\d])(?:anh|chị|chi|cô|co|chú|chu|em|shop|công\s+ty|cong\s+ty|cty|nhà\s+sách|nha\s+sach|tiệm|tiem|quán|quan|siêu\s+thị|sieu\s+thi|cửa\s+hàng|cua\s+hang|gửi|gui)\s*$/iu.test(before)) return match;
      return `${type} ${{ một: 1, mot: 1, hai: 2, ba: 3, bốn: 4, bon: 4, năm: 5, nam: 5, sáu: 6, sau: 6, bảy: 7, bay: 7, tám: 8, tam: 8, chín: 9, chin: 9, mười: 10, muoi: 10 }[word.toLowerCase()]}`;
    }],
  abbreviation('hn', 'Hà Nội'),
  // Tên thành phố viết dính hay viết tắt hay gặp trên form.
  abbreviation('dalat|đalat', 'Đà Lạt'),
  abbreviation('tpth', 'Thành phố Thanh Hóa'),
  // R13 (K6): viết tắt/viết dính gặp trên đơn thật, không nhập nhằng: "tpst" (TP Sóc Trăng), "tpbr" (TP Bà Rịa),
  // "tpprtc" (TP Phan Rang - Tháp Chàm), "tppleiku"; "cpa" chỉ là Cẩm Phả khi liền sau là Quảng Ninh.
  // KHÔNG thêm "py" (đơn thật: "py - vĩnh phúc" = Phúc Yên, không phải Phú Yên) và "vt" ("tien cat vt phu tho" = Việt Trì).
  abbreviation('tpst', 'Thành phố Sóc Trăng'),
  abbreviation('tpbr', 'Thành phố Bà Rịa'),
  abbreviation('tp\\s*pr\\s*-?\\s*tc', 'Thành phố Phan Rang - Tháp Chàm'),
  abbreviation('tppleiku', 'Thành phố Pleiku'),
  [new RegExp(`${B}cpa(?=\\s*,?\\s*(?:quảng\\s*ninh|quang\\s*ninh)${E})`, 'giu'), 'Cẩm Phả'],
  // "TP MT tiền giang" (đơn thật "xã Mỹ phong TP MT tiền giang"): chỉ là Mỹ Tho khi liền sau là Tiền Giang.
  [new RegExp(`${B}tp\\s*\\.?\\s*mt(?=\\s*,?\\s*(?:tiền\\s*giang|tien\\s*giang)${E})`, 'giu'), 'Thành phố Mỹ Tho'],
  // "hp" chỉ là Hải Phòng khi đứng cuối địa chỉ hoặc trước dấu phẩy ("… an khánh hp").
  [new RegExp(`${B}hp(?=\\s*(?:[,;.\\n]|$))`, 'giu'), 'Hải Phòng'],
  // fix-addr (01/10): ghi chú "(cũ)", "(địa chỉ cũ)", "đc cũ" cuối địa chỉ không phải tên cấp ("… cầu giấy Hà Nội ( địa chỉ cũ )").
  // R13 (K6): khách hay gõ "củ" thay "cũ" ("bình dương ( củ)").
  [/\(\s*(?:địa\s*chỉ|dia\s*chi|đ\/c|đc|dc)?\s*(?:cũ|củ|cu)\s*\)/giu, ','],
  [/[\s,.;-]+(?:địa\s*chỉ|dia\s*chi|đ\/c|đc|dc)\s+(?:cũ|củ|cu)\s*[.!]*\s*$/iu, ''],
  // fix-addr (01/10): viết tắt/viết dính hay gặp: "hbt" (Hai Bà Trưng), "ka hp" (Kiến An), "tpvtau"/"tp vt" (TP Vũng Tàu),
  // "tt huế" cuối địa chỉ (Thừa Thiên Huế, không phải "thị trấn Huế"), "qui nhơn", "p8q11" (Phường 8, Quận 11).
  abbreviation('hbt', 'Hai Bà Trưng'),
  [new RegExp(`${B}ka(?=\\s*,?\\s*(?:hải\\s*phòng|hai\\s*phong)${E})`, 'giu'), 'Kiến An'],
  abbreviation('tp\\s*\\.?\\s*v\\s*\\.?\\s*tàu|tp\\s*\\.?\\s*vtau|tpvt|tp\\s*vt', 'Thành phố Vũng Tàu'),
  abbreviation('vtau', 'Vũng Tàu'),
  [new RegExp(`${B}(?:tt\\s*\\.?\\s*huế|tt\\s*\\.?\\s*hue|tthue|tthuế)(?=\\s*(?:[,;.\\n]|$))`, 'giu'), 'Thừa Thiên Huế'],
  abbreviation('qui\\s*nh[ơo]n', 'Quy Nhơn'),
  [new RegExp(`${B}[pf]\\s*\\.?\\s*(\\d{1,2})\\s*q\\s*\\.?\\s*(\\d{1,2})${E}`, 'giu'), 'Phường $1, Quận $2'],
  // Chữ P/Q viết hoa dính ngay tên viết hoa ("PAn Phú", "QTân Bình") là loại hình gõ thiếu dấu chấm.
  // Chỉ ở đầu đoạn: "Xã Đắk PXi" là tên thật.
  [/(?<=^|[,;]\s*)P(?=\p{Lu}\p{Ll})/gu, 'Phường '],
  [/(?<=^|[,;]\s*)Q(?=\p{Lu}\p{Ll})/gu, 'Quận '],
  // Số La Mã cuối tên phường/quận ("Hải Châu I", "Phường Bình Hưng Hòa B" không tính): danh mục ghi số Ả Rập.
  [new RegExp(`(?<=\\p{L}\\s)(I{1,3}|IV|VI{0,3}|IX|X)${E}`, 'gu'), (match) => String({ I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 }[match])],
  [new RegExp(`${B}t\\s*\\.\\s*p\\s*\\.?\\s*`, 'giu'), 'Thành phố '],
  abbreviation('pr\\s*-?\\s*tc|prtc', 'Phan Rang - Tháp Chàm'),
  abbreviation('brvt', 'Bà Rịa - Vũng Tàu'),
  abbreviation('dak\\s*lak|daklak|dac\\s*lac|đắc\\s*lắc|đăk\\s*lăk', 'Đắk Lắk'),
  abbreviation('dak\\s*nong|daknong|đăk\\s*nông', 'Đắk Nông'),
  // R14 (…766850): "20/26 đoàn văn bơ q9 q4" — hai "q + số" liền nhau: cái đầu là Phường (gõ nhầm p), cái sau là Quận
  // (trước đây ra "Quận 9, Quận 4").
  [new RegExp(`${B}q\\s*\\.?\\s*(\\d{1,2})(?=\\s*[,;]?\\s*(?:q|quận|quan)\\s*\\.?\\s*\\d{1,2}${E})`, 'giu'), 'Phường $1'],
  [new RegExp(`${B}q\\s*\\.?\\s*(\\d{1,2})${E}`, 'giu'), 'Quận $1'],
  [new RegExp(`${B}p\\s*\\.?\\s*(\\d{1,2})${E}`, 'giu'), 'Phường $1'],
  // Vòng 12: "f5", "F.14" là phường số (khách miền Nam gõ "f" thay "p").
  [new RegExp(`${B}f\\s*\\.?\\s*(\\d{1,2})${E}`, 'giu'), 'Phường $1'],
  // Vòng 12: từ loại hình gõ cụt ("huyệ. Châu Đức", "phườ Tân Mai").
  [new RegExp(`${B}huyệ${E}\\.?`, 'giu'), 'Huyện'],
  [new RegExp(`${B}quậ${E}\\.?`, 'giu'), 'Quận'],
  [new RegExp(`${B}phườ${E}\\.?`, 'giu'), 'Phường'],
  [new RegExp(`${B}q\\s*\\.\\s*`, 'giu'), 'Quận '],
  [new RegExp(`${B}p\\s*\\.\\s*`, 'giu'), 'Phường '],
  [new RegExp(`${B}h\\s*\\.\\s*`, 'giu'), 'Huyện '],
  [new RegExp(`${B}x\\s*\\.\\s*`, 'giu'), 'Xã '],
  [new RegExp(`${B}tx\\s*\\.\\s*`, 'giu'), 'Thị xã '],
  [new RegExp(`${B}tt\\s*\\.\\s*`, 'giu'), 'Thị trấn '],
  [new RegExp(`${B}tp\\s*\\.\\s*`, 'giu'), 'Thành phố '],
  // "Phường 05" → "Phường 5" (chạy sau khi P./Q. đã được bung).
  [new RegExp(`${B}(quận|phường|quan|phuong)\\s+0(\\d)${E}`, 'giu'), '$1 $2'],
  // Vòng 12: dấu chấm giữa hai cụm chữ là dấu ngăn đoạn ("Đường số6. hiệp bình.thủ đức",
  // "Tk16/36D. Nguyễn cảnh chân"). Chạy sau cùng: "P.", "Q.", "TP.", "TX." đã được bung ở trên.
  [/(?<=[\p{L}\p{N}])\s*\.(?:\s*\.)*\s*(?=\p{L})/gu, ', ']
];

export function expandAddressAbbreviations(text) {
  let result = String(text ?? '');
  for (const [pattern, replacement] of ABBREVIATIONS) result = result.replace(pattern, replacement);
  return result;
}

// ===== Danh mục =====

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { cells.push(cell); cell = ''; }
    else cell += char;
  }
  cells.push(cell);
  return cells;
}

export function parseLocationsCsv(content) {
  // Export-Csv của PowerShell ghi BOM ở đầu tệp; bỏ đi để cột đầu không lệch tên.
  const lines = String(content).replace(/^﻿/, '').split(/\r?\n/).filter(line => line.trim());
  const headers = parseCsvLine(lines[0]).map(header => header.trim());
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, i) => [header, (cells[i] || '').trim()]));
  }).filter(row => row.province && row.district && row.ward);
}

/** Chữ thường, có dấu, dạng NFC, chỉ giữ chữ và số — để so dấu khi hai tên chỉ khác dấu. */
function rawKey(value) {
  return String(value ?? '').normalize('NFC').toLowerCase().replace(/đ/g, 'đ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const CANONICAL_PREFIX = { tp: 'thanh pho', q: 'quan', h: 'huyen', tx: 'thi xa', tt: 'thi tran', p: 'phuong', x: 'xa' };

function makeEntry(code, name, prefixes, extraAliases = []) {
  const key = normalizeLocationKey(name);
  const bare = stripPrefix(key, prefixes);
  const prefix = bare === key ? '' : key.slice(0, key.length - bare.length - 1);
  // Tên chỉ là số ("Quận 1", "Phường 12") bắt buộc phải đi kèm tiền tố, nếu
  // không mọi chữ số trong số nhà đều khớp.
  const numeric = /^\d+$/.test(bare);
  // Mỗi alias nhớ dạng có dấu của nó (nếu có) để phân biệt "Minh Quân" với "Minh Quán".
  const rawName = rawKey(name);
  const rawBare = prefix ? rawName.slice(prefix.length + 1) : rawName;
  const aliases = new Map([[key, rawName]]);
  if (!numeric && bare) aliases.set(bare, rawBare);
  for (const alias of extraAliases.map(normalizeLocationKey)) if (alias && !aliases.has(alias)) aliases.set(alias, '');
  return { code, name, key, bare: bare || key, prefix, numeric, aliases: [...aliases.keys()], rawByAlias: aliases };
}

// "Vũng Tàu", "Huế", "Bà Rịa" không đặt làm alias tỉnh: đó là tên thành phố
// duy nhất trên cả nước nên tra theo quận sẽ ra cả tỉnh lẫn quận.
const PROVINCE_ALIASES = {
  'ho chi minh': ['thanh pho ho chi minh', 'tp ho chi minh'],
  'ba ria vung tau': ['baria vungtau', 'ba ria vungtau'],
  'dak lak': ['dac lac', 'dak lak', 'daklak'],
  'dak nong': ['daknong']
};

// Quận/huyện đã sáp nhập (28/09, theo chủ shop): Quận 2, Quận 9 và Quận Thủ Đức
// đều là Thành phố Thủ Đức. Danh mục vẫn còn cả dòng cũ lẫn dòng mới, nên khi
// dựng chỉ mục các dòng cũ được gộp vào đơn vị mới và tên cũ thành alias của nó:
// khách ghi "Quận 9" vẫn đọc được, còn địa chỉ xuất/đẩy POS ghi "Thành phố Thủ Đức".
const MERGED_DISTRICTS = {
  'ho chi minh': { 'thanh pho thu duc': ['quan 2', 'quan 9', 'quan thu duc'] }
};

// R13 (K3/K5): cách viết khác của tên quận/huyện (POS ghi "Krông Pắk", danh mục kho "Krông Pắc"; khách gõ "krông pack").
const DISTRICT_ALIASES = {
  'dak lak': { 'huyen krong pac': ['krong pak', 'krong pack'] }
};

function mergedDistrictTarget(provinceBare, districtKey) {
  const groups = MERGED_DISTRICTS[provinceBare];
  if (!groups) return null;
  for (const [target, members] of Object.entries(groups)) if (members.includes(districtKey)) return target;
  return null;
}

export function buildLocationIndex(rows) {
  const provinces = new Map();
  // Mã của đơn vị đích trong từng tỉnh (để dòng cũ gộp đúng vào dòng mới của danh mục).
  const mergedCodes = new Map();
  for (const row of rows) {
    const provinceBare = stripPrefix(normalizeLocationKey(row.province), PROVINCE_PREFIXES);
    const groups = MERGED_DISTRICTS[provinceBare];
    if (groups && groups[normalizeLocationKey(row.district)]) mergedCodes.set(`${provinceBare}|${normalizeLocationKey(row.district)}`, row.district_code);
  }
  for (const row of rows) {
    let province = provinces.get(row.province_code);
    if (!province) {
      const provinceBare = stripPrefix(normalizeLocationKey(row.province), PROVINCE_PREFIXES);
      // Vòng 12: tên tỉnh viết dính ("soctrang", "danang", "cantho") cũng là alias.
      const joined = provinceBare.includes(' ') && provinceBare.replace(/ /g, '').length >= 6 ? [provinceBare.replace(/ /g, '')] : [];
      province = { ...makeEntry(row.province_code, row.province, PROVINCE_PREFIXES, [...(PROVINCE_ALIASES[provinceBare] || []), ...joined]), districts: new Map() };
      provinces.set(row.province_code, province);
    }
    const districtKey = normalizeLocationKey(row.district);
    const target = mergedDistrictTarget(province.bare, districtKey);
    const districtCode = target ? (mergedCodes.get(`${province.bare}|${target}`) || `merged:${target}`) : row.district_code;
    let district = province.districts.get(districtCode);
    if (!district) {
      const name = target ? rows.find(other => normalizeLocationKey(other.district) === target && other.province_code === row.province_code)?.district || row.district : row.district;
      const extraAliases = [
        ...(Object.entries(MERGED_DISTRICTS[province.bare] || {}).find(([key]) => key === (target || districtKey))?.[1] || []),
        ...(DISTRICT_ALIASES[province.bare]?.[target || districtKey] || [])
      ];
      district = { ...makeEntry(districtCode, name, DISTRICT_PREFIXES, extraAliases), province, wards: new Map() };
      province.districts.set(districtCode, district);
    }
    // Phường của quận cũ trùng tên phường của đơn vị mới (hoặc ngược lại, tùy thứ tự
    // dòng trong danh mục) thì không thêm lần hai, kẻo "Phường An Phú" thành nhập nhằng.
    const wardKey = normalizeLocationKey(row.ward);
    const inMergedGroup = Boolean(target) || Boolean(MERGED_DISTRICTS[province.bare]?.[districtKey]);
    const duplicate = inMergedGroup && [...district.wards.values()].some(ward => ward.key === wardKey);
    if (!district.wards.has(row.ward_code) && !duplicate) {
      district.wards.set(row.ward_code, { ...makeEntry(row.ward_code, row.ward, WARD_PREFIXES), district });
    }
  }
  const provinceList = [...provinces.values()];
  const districtList = provinceList.flatMap(province => [...province.districts.values()]);
  // Quận/huyện theo tên đầy đủ trên cả nước: khi khách không nêu tỉnh nhưng
  // "Thành phố Vinh" hay "Huyện Củ Chi" chỉ có một nơi, tỉnh được suy ra.
  const districtsByKey = new Map();
  for (const district of districtList) {
    for (const alias of district.aliases) districtsByKey.set(alias, [...(districtsByKey.get(alias) || []), district]);
  }
  // Mọi tên đầy đủ có tiền tố ("xa hoa binh", "quan 1"): một tên tỉnh đứng sau
  // "xã" chỉ bị loại khi "xã + tên" thật sự là một xã nào đó.
  const fullKeys = new Set();
  for (const province of provinceList) {
    fullKeys.add(province.key);
    for (const district of province.districts.values()) {
      fullKeys.add(district.key);
      for (const ward of district.wards.values()) fullKeys.add(ward.key);
    }
  }
  // Tỉnh theo alias, để chuẩn hoá tên cấp khi xuất không phải quét 63 tỉnh × alias mỗi ô.
  const provinceByAlias = new Map();
  for (const province of provinceList) {
    for (const alias of province.aliases) if (!provinceByAlias.has(alias)) provinceByAlias.set(alias, province);
  }
  return { provinces: provinceList, districts: districtList, districtsByKey, provinceByAlias, fullKeys };
}

export function loadLocationIndex() {
  if (!index) index = buildLocationIndex(parseLocationsCsv(readFileSync(locationsPath, 'utf8')));
  return index;
}

// ===== Tìm khớp =====

// Khoảng trắng trong tên khớp với một hoặc nhiều khoảng trắng của văn bản, vì
// dấu gạch ngang trong "Phan Rang – Tháp Chàm" đã thành khoảng trắng.
// Mỗi alias một RegExp biên từ, biên dịch một lần rồi dùng lại: findBest quét
// hàng nghìn alias cho mỗi địa chỉ, biên dịch lại mỗi lần là điểm nóng của
// export, nhận đơn landing và mọi tin chatbot. Cờ `g` giữ lastIndex nên đặt lại
// trước khi trao cho vòng exec.
const boundaryCache = new Map();
const boundary = key => {
  let pattern = boundaryCache.get(key);
  if (!pattern) {
    pattern = new RegExp(`(?<![a-z0-9])${key.split(' ').map(escapeRegExp).join('\\s+')}(?![a-z0-9])`, 'g');
    boundaryCache.set(key, pattern);
  }
  pattern.lastIndex = 0;
  return pattern;
};

/** Tiền tố loại hình đứng ngay trước vị trí `start` trong chuỗi chuẩn hóa, nếu có. */
function prefixBefore(norm, start) {
  const before = norm.slice(0, start).replace(/\s+$/, '');
  for (const prefix of ALL_PREFIXES) {
    if (before === prefix || before.endsWith(` ${prefix}`)) return { prefix, start: before.length - prefix.length };
  }
  return null;
}

/** Văn bản có dấu không: khách gõ có dấu thì "Sa Pa" là Sa Pa, không phải Sa Pả. */
export function hasDiacritics(raw) {
  return rawKey(raw) !== normalizeLocationKey(raw);
}

// Từ đứng ngay trước một tên cho biết đó là tên đường/địa điểm chứ không phải
// đơn vị hành chính: "đường Hà Nội", "chợ Bến Thành", "cầu Sài Gòn".
const STREET_WORDS = new Set(['duong', 'pho', 'ngo', 'ngach', 'hem', 'kiet', 'dai lo', 'quoc lo', 'tinh lo', 'ql', 'tl', 'cau', 'cho', 'ben', 'ben xe', 'nga tu', 'nga ba', 'khu', 'kdc', 'toa', 'chung cu', 'truong', 'benh vien', 'cong ty', 'cty', 'nha tho', 'chua', 'sieu thi', 'so']);

function streetWordBefore(norm, start) {
  // Chỉ xét trong đoạn hiện tại: "Tương Dương, Nghệ An" không phải "đường Nghệ An".
  const before = norm.slice(0, start);
  const segmentStart = Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
  const words = before.slice(segmentStart).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const keywordLength = STREET_WORDS.has(words.slice(-2).join(' ')) ? 2 : STREET_WORDS.has(words.at(-1)) ? 1 : 0;
  if (!keywordLength) return false;
  // Từ chỉ đường phải mở đầu cụm: đứng đầu đoạn, sau một con số ("15 đường",
  // "số 8 đường") hoặc sau một từ chỉ đường khác. Đứng sau một chữ thường
  // ("tương dương", "an dương") thì nó là phần của tên riêng.
  const previous = words.at(-keywordLength - 1);
  const previousTwo = words.slice(-keywordLength - 2, -keywordLength).join(' ');
  return previous === undefined || /\d/.test(previous) || STREET_WORDS.has(previous) || PLACE_CONTEXT_WORDS.has(previous) || PLACE_CONTEXT_WORDS.has(previousTwo);
}

/**
 * Trong đoạn hiện tại (chuỗi gốc, thẳng hàng với bản chuẩn hoá), phía trước `start` chỉ có MỘT số nhà ("12",
 * "số 5", "71/82", "sn 89"). "2/31b 3/2 Hưng Lợi" (số nhà + đường 3/2) không tính.
 */
function houseNumberBefore(raw, start) {
  const before = raw.slice(0, start);
  const segmentStart = Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
  return /^(?:số\s+nhà\s+|so\s+nha\s+|số\s+|so\s+|sn\s+)?\d+[a-z]?(?:\/\d+[a-z]?)*$/iu.test(before.slice(segmentStart).trim());
}

/** R13 fix2 (B3): trên chuỗi chuẩn hoá, phần trước `start` trong cùng đoạn chỉ là số nhà trần ("45", "kiet 5", "so 3", "hem 12/3", "lo 7"). */
function bareHouseNumberBefore(norm, start) {
  const before = norm.slice(0, start);
  const segmentStart = Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
  return /^(?:(?:so nha|so|sn|kiet|k|hem|ngo|ngach|lo|to)\s+)?\d+[a-z]?(?:\/\d+[a-z]?)*$/.test(before.slice(segmentStart).trim());
}

// Giới từ chỉ vị trí đứng trước từ chỉ đường: "gần chợ Bến Thành" là địa điểm
// tham chiếu, không phải Phường Bến Thành.
const PLACE_CONTEXT_WORDS = new Set(['gan', 'canh', 'ben canh', 'doi dien', 'sau', 'phia sau', 'truoc', 'o', 'tai', 'sat', 'ngay', 'qua', 'den', 'toi', 'tu', 'trong', 'ke', 'gan ngay']);

/**
 * Tìm mục khớp tốt nhất trong `norm` (đã chuẩn hóa) trước vị trí `limit`.
 * Điểm theo thứ tự: tiền tố (đúng loại hình 2 > cùng cấp 1 > không có 0),
 * vị trí kết thúc (sau thắng trước), độ dài tên (dài hơn = cụ thể hơn:
 * "NT Mộc Châu" thắng "Mộc Châu"), rồi dấu (khi khách gõ có dấu, tên khớp
 * dấu thắng: "Minh Quân" ≠ "Minh Quán").
 * - Tiền tố của cấp KHÁC đứng trước ("xã hòa bình" khi đang tìm tỉnh) thì
 *   loại, nhưng chỉ khi "xã + tên" là một xã có thật — để "Huyện Văn Quan
 *   Lạng Sơn" không mất tỉnh vì chữ "Quan".
 * - Tiền tố trung lập ("thành phố" vừa là tỉnh vừa là quận) được gộp vào vùng
 *   đã dùng nhưng không cộng điểm, để vị trí quyết định.
 * - Tên không có tiền tố phải đứng cuối đoạn (trước dấu phẩy hoặc trước phần
 *   đã nhận ra), nếu không "Điện Biên Phủ" trong tên đường thành tỉnh Điện Biên.
 * Hai mục khác nhau bằng điểm nhau là mơ hồ: trả về `ambiguous` để cấp trên
 * hỏi lại thay vì chọn bừa.
 */
function findBest(norm, raw, entries, { limit = norm.length, ownPrefixes, neutralPrefixes = [], foreignPrefixes, fullKeys, typedWithDiacritics = hasDiacritics(raw), notAfterHouseNumber = false }) {
  const region = norm.slice(0, limit);
  let best = null;
  let ties = [];
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const pattern = boundary(alias);
      let match;
      while ((match = pattern.exec(region))) {
        const start = match.index;
        const end = start + match[0].length;
        // Alias là tên đầy đủ (đã gồm tiền tố) tự nó là bằng chứng; không tìm
        // thêm tiền tố phía trước nữa, nếu không "Thổ Quan Quận Đống Đa" nuốt
        // mất chữ "Quan" của phường.
        const selfPrefixed = alias === entry.key && entry.key !== entry.bare;
        const prefixed = selfPrefixed ? null : prefixBefore(region, start);
        const prefix = prefixed ? (CANONICAL_PREFIX[prefixed.prefix] || prefixed.prefix) : '';
        const hasPrefix = Boolean(prefixed && ownPrefixes.includes(prefixed.prefix));
        const neutral = Boolean(prefixed && !hasPrefix && neutralPrefixes.includes(prefixed.prefix));
        const foreign = Boolean(prefixed && !hasPrefix && !neutral && foreignPrefixes.includes(prefixed.prefix)
          && (!fullKeys || fullKeys.has(`${prefix} ${alias}`)));
        if (foreign) continue;
        if (entry.numeric && !selfPrefixed && !hasPrefix) continue;
        if (!hasPrefix && !selfPrefixed && !neutral && !atSegmentEnd(region, end)) continue;
        if (!hasPrefix && !selfPrefixed && !neutral && streetWordBefore(region, start)) continue;
        // fix-addr (01/10): tên phường không loại hình đứng ngay sau số nhà ở đầu đoạn ("12 Cửa Đại", "15 Hàng Bông")
        // là tên đường — lấy làm phường thì phần đường chỉ còn số nhà, bot hỏi lại đường.
        if (notAfterHouseNumber && !hasPrefix && !selfPrefixed && !neutral && houseNumberBefore(raw, start)) continue;
        // Cả đoạn là tên đầy đủ của một đơn vị khác ("xã tả thanh oai" khi đang
        // tìm huyện Thanh Oai, "xã hòa quang nam" khi đang tìm tỉnh Quảng Nam):
        // phần đuôi trùng tên chỉ là trùng hợp.
        // Đoạn chỉ là "loại hình + tên" của chính mục này ("xã tân thạnh" với
        // Thị trấn Tân Thạnh) thì khách chỉ ghi sai loại hình, vẫn là ứng viên;
        // điểm loại hình và dấu sẽ phân định với Xã Tân Thành cùng huyện.
        if (fullKeys) {
          const segmentKey = normalizeLocationKey(segmentAround(region, start, end));
          const ownForm = hasPrefix && segmentKey === `${prefix} ${alias}`;
          if (fullKeys.has(segmentKey) && !entry.aliases.includes(segmentKey) && !ownForm) continue;
        }
        const rawSlice = raw.slice(start, end);
        const expectedRaw = entry.rawByAlias.get(alias) || '';
        const diacritics = expectedRaw && typedWithDiacritics ? (rawKey(rawSlice) === expectedRaw ? 1 : 0) : 0;
        // Có loại hình đứng trước là bằng chứng mạnh nhất; đúng loại hình chỉ
        // phân định sau cùng, sau cả dấu: "Xã Tân Thạnh" (có dấu) là Thị trấn
        // Tân Thạnh chứ không phải Xã Tân Thành cùng huyện — khách hay gọi thị
        // trấn là xã, nhưng không gõ nhầm dấu thành một tên khác.
        // Độ dài tính cả loại hình đứng trước, để alias tự có tiền tố ("xa tan
        // thanh") không dài hơn "xã" + alias trần ("tan thanh") của mục khác.
        const exactType = selfPrefixed || (hasPrefix && prefix === entry.prefix) ? 1 : 0;
        const candidateStart = (hasPrefix || neutral) ? prefixed.start : start;
        const score = [selfPrefixed || hasPrefix ? 1 : 0, end, end - candidateStart, diacritics, exactType];
        const candidate = { entry, start: candidateStart, end, score, prefixed: hasPrefix || selfPrefixed, neutral };
        const order = best ? compareScores(score, best.score) : 1;
        if (order > 0) { best = candidate; ties = []; }
        else if (order === 0 && best.entry !== entry && !ties.some(tie => tie.entry === entry)) ties.push(candidate);
      }
    }
  }
  if (best && ties.length) best.ambiguous = [best.entry, ...ties.map(tie => tie.entry)];
  return best;
}

/** Che một khoảng đã nhận ra bằng dấu phẩy (cả bản chuẩn hóa và bản gốc, hai bản thẳng hàng theo chỉ số). */
function maskRange(norm, raw, range) {
  const mask = text => text.slice(0, range.start) + ','.repeat(range.end - range.start) + text.slice(range.end);
  return { norm: mask(norm), raw: mask(raw) };
}

/** Đoạn (giữa hai dấu phẩy) chứa vị trí [start, end). */
function segmentAround(region, start, end) {
  const before = region.slice(0, start);
  const from = Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
  const rest = region.slice(end);
  const stop = rest.search(/[,;\n]/);
  return region.slice(from, stop < 0 ? region.length : end + stop);
}

function atSegmentEnd(region, end) {
  const rest = region.slice(end);
  const segmentEnd = rest.search(/[,;\n]/);
  return (segmentEnd < 0 ? rest : rest.slice(0, segmentEnd)).replace(/\b(viet nam|vietnam|vn)\b/g, '').replace(/[^a-z0-9]/g, '') === '';
}

function compareScores(a, b) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const rows = a.length + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Dấu Telex gõ sót lại sau khi bỏ dấu: tiếng Việt không có từ kết thúc bằng
 * j/s/f/r/x/w/z, nên "diichj" → "diich"; chữ gõ đúp ("aa", "dd", "ii") gộp
 * lại → "dich". Chỉ dùng cho so khớp mờ, không đụng vào bản gốc.
 */
export function cleanTelex(key) {
  return String(key || '').split(' ').map(word => word.replace(/[jsfrxwz]+$/, '').replace(/([a-z])\1+/g, '$1')).join(' ');
}

/** Sai chính tả nhẹ: 1 ký tự cho tên ≥5 ký tự, 2 ký tự cho tên ≥9 ký tự; chỉ nhận khi có đúng một tên tốt nhất. */
function fuzzyMatch(segments, entries, prefixes) {
  let best = null;
  let tie = false;
  const consider = (candidate, segment, entry, telexOnly = false) => {
    const cleaned = cleanTelex(candidate);
    if (telexOnly && cleaned === candidate) return;
    const allowed = candidate.length >= 9 ? 2 : 1;
    const distance = telexOnly ? levenshtein(cleaned, entry.bare) : Math.min(levenshtein(candidate, entry.bare), levenshtein(cleaned, entry.bare));
    if (distance > allowed) return;
    if (!best || distance < best.distance) { best = { entry, segment, distance }; tie = false; }
    else if (distance === best.distance && entry !== best.entry) tie = true;
  };
  for (const segment of segments) {
    const bare = stripPrefix(segment.key, prefixes);
    if (!bare || /^\d+$/.test(bare) || bare.length < 5) continue;
    for (const entry of entries) {
      if (entry.numeric) continue;
      consider(bare, segment, entry);
      // Đoạn dài không có dấu phẩy ("ngo 199 tran quoc hoan diichj vong"): thử
      // từng cụm từ dài bằng tên đang tìm, nhưng chỉ cụm có dấu Telex gõ sót —
      // nếu không "trần bình trọng" sẽ thành Quận Tân Bình.
      const words = bare.split(' ');
      const size = entry.bare.split(' ').length;
      if (words.length <= size || size < 2) continue;
      for (let i = 0; i + size <= words.length; i += 1) {
        const window = words.slice(i, i + size).join(' ');
        if (window.length < 5) continue;
        const offset = words.slice(0, i).join(' ').length + (i ? 1 : 0) + (segment.key.length - bare.length);
        consider(window, { ...segment, start: segment.start + offset, end: segment.start + offset + window.length }, entry, true);
      }
    }
  }
  return best && !tie ? best : null;
}

// Loại hình đứng trước một tên ("phường tây hồ", "xã Nguyệt Viên"): dùng để nhận
// ra khách ghi phường/xã theo đơn vị mới sau sáp nhập 2025 mà kho không có.
const WARD_PHRASE = /(?<![a-z0-9])(?:phuong|xa|thi tran|tt|p|x)\s+([a-z][a-z ]*)/g;
const STOP_WORDS = new Set([...ALL_PREFIXES, 'tinh', 'so', 'duong', 'ngo', 'hem', 'to', 'thon', 'ap', 'khu', 'kp', 'sdt', 'dt']);

/**
 * Trong tỉnh (và các tỉnh cũ đã nhập vào nó) có phường/xã nào mang tên này
 * không, kể cả sai chính tả nhẹ. Không có nghĩa là tên theo đơn vị mới sau
 * sáp nhập — kho không quản lý đơn vị mới nên chỉ ghi chú để hỏi lại khách.
 */
export function wardNameKnownIn(name, province, locationIndex) {
  const provinces = [province, ...mergedProvinceMembers(province, locationIndex)];
  const cleaned = cleanTelex(name);
  for (const candidateProvince of provinces) {
    for (const district of candidateProvince.districts.values()) {
      for (const ward of district.wards.values()) {
        if (ward.bare === name || ward.bare === cleaned) return true;
        // Sai chính tả nhẹ chỉ tính cho tên dài; "tây hồ" không được coi là "Tây Mỗ".
        const allowed = name.length >= 14 ? 2 : name.length >= 10 ? 1 : 0;
        if (allowed && Math.min(levenshtein(name, ward.bare), levenshtein(cleaned, ward.bare)) <= allowed) return true;
      }
    }
  }
  return false;
}

export function looksPostMerger(norm, limit, province, resolvedWard, locationIndex) {
  const region = norm.slice(0, limit);
  const pattern = new RegExp(WARD_PHRASE.source, 'g');
  let match;
  while ((match = pattern.exec(region))) {
    // Tên là các từ ngay sau loại hình, dừng ở từ chỉ cấp/đường tiếp theo, tối đa 4 từ.
    const words = [];
    for (const word of match[1].trim().split(/\s+/)) {
      if (STOP_WORDS.has(word) || words.length === 4) break;
      words.push(word);
    }
    if (!words.length) continue;
    const name = words.join(' ');
    if (/^\d+$/.test(name) || name.length < 4) continue;
    if (resolvedWard && (resolvedWard.bare === name || name.startsWith(resolvedWard.bare))) continue;
    // Thử tên đủ và các tên ngắn dần (khách hay viết tiếp thành phố/quận không dấu phẩy).
    let known = false;
    for (let count = words.length; count >= 1 && !known; count -= 1) known = wardNameKnownIn(words.slice(0, count).join(' '), province, locationIndex);
    if (known) continue;
    // R13 (K8): danh mục tên MỚI đã đủ 3.321 đơn vị → "phường/xã + tên lạ" chỉ coi là sau sáp nhập khi tên đó (gần) trùng
    // một tên mới của chính tỉnh ấy ("xã Phướclong" ≈ Phước Long, "phường langbiang" ≈ Lang Biang - Đà Lạt). Tên không có
    // ở cả hai danh mục ("phường Trúc Bạch" danh mục kho thiếu, gõ sai nặng) thì để bot hỏi lại/nhân viên bổ sung.
    // "thị trấn/TT X": từ 1/7/2025 không còn thị trấn → địa chỉ kiểu cũ, không tự coi là sau sáp nhập.
    if (/^(?:thi tran|tt)\s/.test(match[0])) continue;
    let near = false;
    for (let count = words.length; count >= 1 && !near; count -= 1) near = nearNewWardName(words.slice(0, count).join(' '), province);
    if (near) return true;
  }
  return false;
}

/** Tên (đã chuẩn hoá) gần trùng một tên phường/xã MỚI của tỉnh mới chứa `province`: trùng, khác i/y, viết dính, sai 1–2 ký tự. */
function nearNewWardName(name, province) {
  const index = newWardIndex();
  const compact = value => value.replace(/ /g, '').replace(/y/g, 'i');
  const typed = compact(name);
  if (typed.length < 4) return false;
  const allowed = typed.length >= 9 ? 2 : typed.length >= 5 ? 1 : 0;
  for (const key of newProvinceKeys(province)) {
    for (const candidate of index.get(key) || []) {
      const official = compact(candidate);
      if (official === typed) return true;
      if (typed.length >= 7 && official.startsWith(typed)) return true;
      if (allowed && Math.abs(official.length - typed.length) <= allowed && levenshtein(official, typed) <= allowed) return true;
    }
  }
  return false;
}

function segmentsOf(expanded, norm) {
  const segments = [];
  const pattern = /[^,;\n]+/g;
  let match;
  while ((match = pattern.exec(norm))) {
    const key = match[0].trim();
    if (!key) continue;
    const start = match.index + match[0].indexOf(key[0]);
    segments.push({ key, start, end: start + key.length, text: expanded.slice(start, start + key.length) });
  }
  return segments;
}

// Từ đáp/đệm hay gặp trong câu trả lời ngắn (đã bỏ dấu).
const REPLY_WORDS = new Set(['da', 'vang', 'vg', 'ok', 'oke', 'okie', 'u', 'uh', 'um', 'a', 'nhe', 'nha', 'roi', 'r', 'vay', 'the', 'shop', 'em', 'e', 'chi', 'c', 'anh', 'cam', 'on', 'thanks', 'duoc', 'dc', 'co', 'khong', 'ko', 'k']);

const COUNTRY_TOKENS = /(?<![a-z0-9])(viet nam|vietnam|vn)(?![a-z0-9])/g;

function remainingStreet(expanded, norm, consumed) {
  const chars = expanded.split('');
  const normChars = norm.split('');
  for (const range of consumed) {
    for (let i = range.start; i < range.end; i += 1) { chars[i] = ','; normChars[i] = ','; }
  }
  const normLeft = normChars.join('');
  const country = new RegExp(COUNTRY_TOKENS.source, 'g');
  let match;
  while ((match = country.exec(normLeft))) for (let i = match.index; i < match.index + match[0].length; i += 1) chars[i] = ',';
  return chars.join('').split(/[,;\n]+/)
    .map(part => part.replace(/^[\s\-–.:?!]+|[\s\-–.:?!]+$/g, ''))
    // R13: ngoặc mồ côi còn lại sau khi bỏ tên cấp trong ngoặc ("Thành phố Hồ Chí Minh (" của "(brvt cũ)").
    .map(part => (part.includes('(') === part.includes(')') ? part : part.replace(/^[\s()]+|[\s()]+$/g, '')))
    // Bỏ mảnh rỗng và mảnh chỉ còn mỗi tiền tố loại hình ("Phường" của "Phường Ninh Bình?").
    // R13 (K6): mảnh chỉ còn chữ "cũ"/"( củ )" (chú thích sau tên cấp đã nhận ra) cũng bỏ.
    .filter(part => /[\p{L}\p{N}]/u.test(part) && !ALL_PREFIXES.includes(normalizeLocationKey(part)) && !/^\(?\s*c[ũủ]\s*\)?$/iu.test(part.normalize('NFC')))
    .join(', ');
}

/**
 * Đọc một địa chỉ tự do và trả về ba cấp chuẩn cùng phần đường phố còn lại.
 * `confidence`: 'exact' đủ ba cấp khớp trực tiếp; 'fuzzy' có cấp phải sửa
 * chính tả; 'partial' thiếu cấp; 'none' không nhận ra gì.
 * `ambiguous`: cấp còn thiếu vì có nhiều tên cùng khớp — kèm danh sách tên
 * để bot hỏi khách chọn.
 */
// R13 fix2 (B4): trần độ dài đầu vào của bộ đọc — địa chỉ thật dài nhất trong kho 3.120 ≈ 190 ký tự; chuỗi lặp 2.000 ký tự từng
// làm một lượt đọc mất 3–5 giây (chặn vòng lặp sự kiện khi tin về qua webhook công khai).
export const MAX_ADDRESS_LENGTH = 300;
export function clampAddressText(text) {
  const value = String(text ?? '');
  return value.length > MAX_ADDRESS_LENGTH ? value.slice(0, MAX_ADDRESS_LENGTH) : value;
}

export function resolveAddress(text, locationIndex = loadLocationIndex()) {
  const result = resolveAddressBase(text, locationIndex);
  if (!result.province || result.district || result.ward || result.postMerger) return result;
  return wardBeforeProvince(clampAddressText(text), result, locationIndex) || result;
}

// R15 (inbox2 A4, ca …660136 "142f3 Bắc Cường Lào Cai"): chỉ đọc ra TỈNH, mà ngay trước tên tỉnh (khách ghi không có chữ
// phường/xã, không có quận) là tên một phường/xã DUY NHẤT trong tỉnh đó (danh mục trước sáp nhập, tên ≥ 2 chữ) → chèn loại
// hình ("phường/xã/thị trấn") trước tên đó rồi đọc lại; chỉ nhận khi lần đọc lại ra đúng phường/xã đó, cùng tỉnh.
// Không áp khi trước tên là thôn/xóm/ấp/tổ/khu/đường/phố… (tên thôn, tên đường trùng tên phường).
const WARD_TYPE_TEXT = { phuong: 'phường', xa: 'xã', 'thi tran': 'thị trấn' };
const NOT_WARD_LEAD = new Set([...HAMLET_WORDS_BEFORE, ...STREET_WORDS, 'phuong', 'xa', 'thi tran', 'quan', 'huyen', 'thi xa', 'thanh pho', 'tp', 'tinh', 'p', 'x', 'q', 'h', 'tt', 'tx']);
function wardBeforeProvince(text, result, locationIndex) {
  const raw = String(text ?? '');
  const norm = normalizeAligned(raw);
  const province = locationIndex.provinces.find(entry => entry.code === result.province.code);
  if (!province) return null;
  // Lần xuất hiện CUỐI của tên tỉnh.
  let hit = null;
  for (const alias of province.aliases) {
    const pattern = boundary(alias);
    let match;
    while ((match = pattern.exec(norm))) if (!hit || match.index > hit.index) hit = { index: match.index, end: match.index + match[0].length };
  }
  if (!hit) return null;
  // Sau tên tỉnh chỉ còn dấu ngăn / khoảng trắng (tỉnh đứng cuối đoạn).
  if (/[a-z0-9]/.test(norm.slice(hit.end).split(/[,;\n]/)[0])) return null;
  const segmentStart = Math.max(norm.lastIndexOf(',', hit.index - 1), norm.lastIndexOf(';', hit.index - 1), norm.lastIndexOf('\n', hit.index - 1)) + 1;
  const words = [...norm.slice(segmentStart, hit.index).matchAll(/[a-z0-9]+/g)].map(match => ({ word: match[0], index: segmentStart + match.index }));
  for (const size of [3, 2]) {
    if (words.length < size) continue;
    const picked = words.slice(-size);
    const key = picked.map(item => item.word).join(' ');
    if (/\d/.test(key)) continue;
    const lead = words.length > size ? words[words.length - size - 1].word : '';
    const lead2 = words.length > size + 1 ? `${words[words.length - size - 2].word} ${lead}` : '';
    if (NOT_WARD_LEAD.has(lead) || NOT_WARD_LEAD.has(lead2)) continue;
    // R15 sửa (phản biện luật #6): chữ ngay trước là SỐ NHÀ thuần ("20 Hoàng Liên Lào Cai", "102 Hùng Vương Phú Thọ") → tên đứng
    // sau là tên ĐƯỜNG trùng tên phường/xã, không đoán ("142f3 Bắc Cường Lào Cai" — số nhà có chữ — vẫn đoán như cũ).
    if (/^\d+$/.test(lead)) continue;
    const wards = [];
    for (const district of province.districts.values()) for (const ward of district.wards.values()) if (ward.bare === key) wards.push(ward);
    const districtSameName = [...province.districts.values()].some(district => district.bare === key);
    if (wards.length !== 1 || districtSameName) continue;
    const ward = wards[0];
    const typeText = WARD_TYPE_TEXT[ward.prefix];
    if (!typeText) continue;
    const at = picked[0].index;
    // Khách gõ có dấu thì dấu phải khớp tên ("Hât môn" ≠ "Hát Môn"); hai chữ ngay trước cũng là tên một phường/xã khác của tỉnh
    // ("Mầm Non Tam Hiệp Hát Môn") thì không đoán.
    const typedSlice = raw.slice(at, picked.at(-1).index + picked.at(-1).word.length);
    if (!accentCompatible(typedSlice, ward.name.replace(/^(?:phường|xã|thị trấn)\s+/iu, ''))) continue;
    const before2 = words.slice(Math.max(0, words.length - size - 2), words.length - size).map(item => item.word).join(' ');
    const otherWard = before2.includes(' ') && [...province.districts.values()].some(district => [...district.wards.values()].some(entry => entry.bare === before2));
    if (otherWard) continue;
    const retried = resolveAddressBase(`${raw.slice(0, at)}${typeText} ${raw.slice(at)}`, locationIndex);
    if (retried.province?.code === province.code && retried.ward?.code === ward.code) return retried;
  }
  return null;
}

function resolveAddressBase(text, locationIndex = loadLocationIndex()) {
  text = clampAddressText(text);
  let first = resolveAddressOnce(text, locationIndex);
  if (first.province && (first.ward || first.postMerger)) return first;
  // R13 (K6): không ra tỉnh vì sau tên tỉnh còn mốc/ghi chú ("… hải bối đông anh hà nội quán đốp cafe", "… triệu sơn
  // thanh hóa xóm 1 thọ dân"): tên tỉnh đứng liền sau một quận/huyện của chính tỉnh đó → ngắt đoạn sau tên tỉnh rồi đọc lại.
  if (!first.province) {
    const cut = splitAfterProvince(text, locationIndex);
    if (cut !== String(text ?? '')) {
      const retried = resolveAddressOnce(cut, locationIndex);
      if (retried.province && retried.district) {
        if (retried.ward || retried.postMerger) return retried;
        first = retried;
        text = cut;
      }
    }
  }
  // Vòng 12: khách viết liền không dấu phẩy, tỉnh đứng trước phường ("83 hải phòng Dà nẵng phường
  // Hải châu"): tên không có loại hình phải đứng cuối đoạn nên cả tỉnh lẫn phường đều trượt. Thử lại
  // với dấu phẩy chèn trước mỗi từ loại hình (phường/xã/quận/huyện/thành phố/tỉnh); chỉ lấy khi
  // đọc ra nhiều cấp hơn.
  const split = splitBeforeAdminWords(text);
  if (split === String(text ?? '')) return first;
  const second = resolveAddressOnce(split, locationIndex);
  const levels = result => (result.province ? 1 : 0) + (result.district ? 1 : 0) + (result.ward ? 1 : 0) + (result.postMerger ? 0.5 : 0) - (result.ambiguous ? 0.25 : 0);
  return levels(second) > levels(first) ? second : first;
}

/**
 * Chèn dấu phẩy sau tên tỉnh (hai chữ trở lên) đứng liền sau tên một quận/huyện của chính tỉnh đó mà phía sau, trong
 * cùng đoạn, còn chữ. Không có chỗ nào như vậy thì trả nguyên văn.
 */
function splitAfterProvince(text, locationIndex) {
  const raw = String(text ?? '');
  const norm = normalizeAligned(raw);
  let cutAt = -1;
  for (const province of locationIndex.provinces) {
    for (const alias of province.aliases) {
      if (!alias.includes(' ')) continue;
      const pattern = boundary(alias);
      let match;
      while ((match = pattern.exec(norm))) {
        const end = match.index + match[0].length;
        const rest = norm.slice(end);
        const stop = rest.search(/[,;\n]/);
        if (!/[a-z0-9]/.test(stop < 0 ? rest : rest.slice(0, stop))) continue;
        const before = norm.slice(0, match.index).replace(/[\s.\-]+/g, ' ').trimEnd();
        const districtBefore = [...province.districts.values()].some(district => district.aliases.some(name => !/^\d+$/.test(name) && (before === name || before.endsWith(` ${name}`))));
        if (districtBefore && end > cutAt) cutAt = end;
      }
    }
  }
  return cutAt < 0 ? raw : `${raw.slice(0, cutAt)}, ${raw.slice(cutAt)}`;
}

// "thị xã" không bị tách thành "thị, xã"; chỉ chèn khi phía trước là chữ/số (không phải dấu phẩy sẵn).
// R13 fix2 (B2): không chèn trước "phường/phuong + số bằng chữ" ("nha sach phuong nam") — tách ra là cụm đứng đầu đoạn và luật K8 đổi
// thành Phường 5 ở lần đọc lại; để nguyên thì luật K8 thấy trước nó không có chữ số và giữ là tên riêng.
const ADMIN_SPLIT = /(?<=[\p{L}\p{N}])(?<!(?<![\p{L}])thị)(?<!(?<![\p{L}])thi)\s+(?!(?:phường|phuong)\s+(?:một|mot|hai|ba|bốn|bon|năm|nam|sáu|sau|bảy|bay|tám|tam|chín|chin|mười|muoi)(?![\p{L}\p{N}]))(?=(?:phường|phuong|xã|thị\s+trấn|thi\s+tran|quận|quan|huyện|huyen|thị\s+xã|thi\s+xa|thành\s+phố|thanh\s+pho|tỉnh|tinh|tp)(?![\p{L}\p{N}]))/giu;
function splitBeforeAdminWords(text) {
  return String(text ?? '').replace(ADMIN_SPLIT, ', ');
}

// R13 (K6): chữ "cũ"/"củ" khách chú thích sau một tên cấp ("gò vấp củ HCM", "thường tín cũ hà nội", "( an thới củ )")
// không phải tên cấp: trên bản chuẩn hoá nó thành dấu ngăn đoạn, để tên đứng trước vẫn "đứng cuối đoạn" và khớp được.
// Chỉ khi khách gõ đúng chữ có dấu (không dấu "cu" còn là "chung cư"), và không phải "Củ Chi", "Tả Củ Tỷ".
// (cả dạng dựng sẵn lẫn dạng tổ hợp: "u" + dấu ngã U+0303 / dấu hỏi U+0309)
const OLD_NOTE = /(?<![\p{L}\p{N}])(?:c[ũủ]|cu[̃̉])(?![\p{L}\p{N}\p{M}])(?!\s+(?:chi|t[yỷiỉ]̉?)(?![\p{L}\p{N}]))/giu;
function maskOldNotes(norm, raw) {
  const source = String(raw || '');
  // Bản gốc phải thẳng hàng với bản chuẩn hoá (cùng độ dài) thì mới che theo vị trí được.
  if (source.length !== norm.length) return norm;
  let masked = norm;
  for (const match of source.matchAll(OLD_NOTE)) {
    masked = masked.slice(0, match.index) + ','.repeat(match[0].length) + masked.slice(match.index + match[0].length);
  }
  return masked;
}

/**
 * R13 (K8): phường/xã của quận có tên chỉ khác chữ khách gõ ở i/y ("an qui" ↔ "An Quy"), khách ghi rõ "phường/xã/thị trấn"
 * ngay trước tên, và chỉ đúng một phường/xã khớp. Trả { entry, start, end, fuzzy: true } hoặc null.
 */
function iyWardMatch(norm, wards, limit) {
  const region = norm.slice(0, limit).replace(/y/g, 'i');
  const found = [];
  for (const entry of wards) {
    if (entry.numeric || !/[iy]/.test(entry.bare)) continue;
    const pattern = boundary(entry.bare.replace(/y/g, 'i'));
    let match;
    while ((match = pattern.exec(region))) {
      const start = match.index;
      const end = start + match[0].length;
      const typed = prefixBefore(norm, start);
      if (!typed || !WARD_PREFIXES.includes(typed.prefix)) continue;
      // Tên dài hơn khách ghi ("an qui tây") không phải tên này.
      if (!atSegmentEnd(region, end) && /^\s+[a-z]/.test(region.slice(end)) && !ALL_PREFIXES.some(prefix => region.slice(end).trimStart().startsWith(`${prefix} `))) continue;
      found.push({ entry, start: typed.start, end, fuzzy: true });
    }
  }
  return found.length === 1 ? found[0] : null;
}

/** "( an thới củ )": khách chú thích tên phường/xã cũ trong ngoặc — trả { name, start, end } trên chuỗi gốc. */
const OLD_WARD_NOTE = /\(\s*([^()]{2,40}?)\s+c[ũủ]\s*\)/giu;

// Thành phố thuộc tỉnh mà khách hay dùng tên để gọi cả tỉnh ("… Phú Lộc TP Huế", "… Long Điền Vũng Tàu").
const CITY_NAMED_PROVINCES = new Set(['hue', 'vung tau', 'ba ria']);

/** Lần ghi tên tỉnh (alias dài hơn tên quận) bao trọn khoảng `hit` trên chuỗi chuẩn hoá: { start, end } hoặc null. */
function provinceNameAround(norm, province, hit) {
  for (const alias of province.aliases) {
    if (alias.length <= hit.end - hit.start) continue;
    const pattern = boundary(alias);
    let match;
    while ((match = pattern.exec(norm))) {
      const end = match.index + match[0].length;
      if (match.index <= hit.start && end >= hit.end && end - match.index > hit.end - hit.start) return { start: match.index, end };
    }
  }
  return null;
}

/** Tên tỉnh này có được ghi (đúng biên từ) ở sau vị trí `from` trên chuỗi chuẩn hoá không. */
function provinceWrittenAfter(norm, province, from) {
  for (const alias of province.aliases) {
    const pattern = boundary(alias);
    let match;
    while ((match = pattern.exec(norm))) if (match.index >= from) return true;
  }
  return false;
}

function resolveAddressOnce(text, locationIndex = loadLocationIndex()) {
  const expanded = expandAddressAbbreviations(text);
  // Bản chuẩn hoá được che dần các phần đã nhận ra; bản gốc giữ nguyên để so dấu.
  let norm = maskOldNotes(normalizeAligned(expanded), expanded);
  const result = { province: null, district: null, ward: null, street: '', confidence: 'none', fuzzy: false, ambiguous: null, postMerger: false };
  if (!normalizeLocationKey(norm)) return result;
  result.street = remainingStreet(expanded, norm, []);
  let segments = segmentsOf(expanded, norm);
  const consumed = [];
  const { fullKeys } = locationIndex;
  let province = null;
  let ward = null;
  let provinceHit = null;
  let districtHit = null;
  let district = null;
  let wardHit = null;
  // "TP X" (X vừa là tỉnh vừa là thành phố trực thuộc): khách đã ghi quận là thành phố đó.
  let sameNameCityRef = null;
  // R13 (K10): lần khớp phường/xã trùng tên ở nhiều quận (bước 4) — để biết khách có ghi "phường/xã + tên mới" ở đó không.
  let ambiguousWardHit = null;
  // fix-addr (01/10): tên phường/xã MỚI trùng/gần trùng tên phường/xã CŨ. Khách ghi "phường Bình Lợi Trung, TPHCM",
  // "phường Thanh Xuân, Hà Nội", "P. Nam Hoa Lư, Ninh Bình", "phường Trấn Biên, Biên Hòa": bộ đọc từng gán phường/quận
  // cũ (Xã Bình Lợi - Bình Chánh, Xã Thanh Xuân - Sóc Sơn, Huyện Hoa Lư, Phường Tân Biên) vào cột lưu và gửi POS.
  // Tên mới khớp đúng (cả dấu) ở chỗ máy đọc ra phường cũ thì:
  // - phường cũ chắc chắn sai (tên mới dài hơn, khớp mờ, lệch dấu, khách ghi "phường" mà cũ là "xã"): bỏ phường cũ;
  //   bỏ cả quận cũ (và quay về tỉnh khách ghi nếu máy đã sang tỉnh cũ đã nhập vào) khi khách không tự ghi quận.
  // - tên mới trùng hẳn tên cũ, khách không ghi quận: bỏ phường cũ (phường mới thường gộp nhiều phường cũ), giữ quận
  //   cũ làm gợi ý; postMerger để giữ nguyên chữ khách, cột lưu không ghi phường/quận cũ (resolvedAddressFields).
  // Quận/huyện máy đọc ra nằm gọn trong một tên phường mới dài hơn ("Nam Hoa Lư" ⊃ "Hoa Lư") cũng không phải quận khách ghi.
  const applyNewWardNames = () => {
    const typed = mergedFrom || province;
    if (!typed || result.ambiguous || (!result.ward && !result.district)) return;
    const matches = newWardMatches(fullNorm, expanded, typed, locationIndex);
    if (!matches.length) return;
    const unconsume = hit => { const at = hit ? consumed.indexOf(hit) : -1; if (at >= 0) consumed.splice(at, 1); };
    // Cả cụm "phường + tên mới" thôi là phần đường phố (không để sót "Trung" của "Bình Lợi Trung").
    const consumeName = match => { const typedPrefix = prefixBefore(fullNorm, match.start); consumed.push({ start: match.wardTyped && typedPrefix ? typedPrefix.start : match.start, end: match.end }); };
    const realHit = hit => Boolean(hit && Number.isFinite(hit.start));
    let districtTyped = Boolean(result.district) && (realHit(districtHit) || (Boolean(sameNameCityRef) && district === sameNameCityRef));
    if (districtTyped && realHit(districtHit) && matches.some(match => match.start <= districtHit.start && match.end >= districtHit.end && match.end - match.start > districtHit.end - districtHit.start)) {
      districtTyped = false;
      if (!result.ward) {
        const inside = matches.find(match => match.start <= districtHit.start && match.end >= districtHit.end);
        const name = inside.name;
        unconsume(districtHit);
        consumeName(inside);
        district = null; districtRef = null; districtHit = null; result.district = null;
        if (mergedFrom) { province = mergedFrom; result.province = { code: province.code, name: province.name }; mergedFrom = null; }
        result.postMerger = true;
        result.newWard = name;
        return;
      }
    }
    if (!result.ward || !realHit(wardHit)) return;
    // Tên mới phải phủ cả tên phường cũ (bắt đầu từ đầu tên cũ trở về trước): "Long Bình Tân" cũ không bị "Bình Tân" che.
    const oldNameStart = wardHit.fuzzy ? wardHit.end : wardHit.end - ward.bare.length;
    const covering = matches
      .filter(match => match.start >= wardHit.start && match.start <= oldNameStart && match.end >= wardHit.end)
      .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    if (!covering) return;
    // Khách ghi "thị trấn X": từ 1/7/2025 không còn thị trấn → địa chỉ cũ, giữ phường/thị trấn cũ.
    const typedPrefix = prefixBefore(fullNorm, covering.start);
    if (typedPrefix && ['thi tran', 'tt'].includes(typedPrefix.prefix)) return;
    const typedSlice = expanded.slice(covering.start, covering.end);
    const oldRaw = ward.rawByAlias?.get(ward.bare) || '';
    const accentDiffers = Boolean(oldRaw) && !accentCompatible(typedSlice, oldRaw);
    const typedType = (() => { const before = prefixBefore(fullNorm, covering.start); return before ? (CANONICAL_PREFIX[before.prefix] || before.prefix) : ''; })();
    const typeDiffers = ['phuong', 'xa'].includes(typedType) && ['phuong', 'xa'].includes(ward.prefix) && typedType !== ward.prefix;
    // R13 (K8): "An Qui"/"An Quy" chỉ khác cách viết i/y — không phải khớp mờ sang một tên khác.
    const sameSpelling = covering.name.replace(/y/g, 'i') === ward.bare.replace(/y/g, 'i');
    const longer = covering.end > wardHit.end || (covering.name !== ward.bare && !sameSpelling);
    // R13 (K1/K3): khách ghi "Phường X" mà danh mục cũ là "Xã X" (xã đã lên phường, danh mục kho chưa cập nhật) nhưng
    // CHÍNH khách/ô chọn ghi quận/huyện chứa X ("Phường Phước Tân, Thành phố Biên Hòa") → địa chỉ ba cấp cũ, giữ mã.
    const districtWritten = Boolean(result.district) && realHit(districtHit);
    const wrong = longer || (wardHit.fuzzy === true && !sameSpelling) || accentDiffers || (typeDiffers && !districtWritten);
    if (!wrong && districtTyped) return;
    result.postMerger = true;
    result.newWard = covering.name;
    // Tên mới trùng hẳn tên cũ: phường mới thường gộp nhiều phường cũ ("Cầu Ông Lãnh" mới gồm cả Cầu Kho cũ) nên
    // không giữ phường cũ; quận cũ chứa nó vẫn để làm gợi ý (cột lưu không ghi vì khách không ghi quận).
    unconsume(wardHit);
    consumeName(covering);
    ward = null; wardHit = null; result.ward = null;
    if (!wrong) return;
    if (!districtTyped) {
      unconsume(districtHit);
      district = null; districtRef = null; districtHit = null; result.district = null;
      if (mergedFrom) { province = mergedFrom; result.province = { code: province.code, name: province.name }; mergedFrom = null; }
    }
  };
  const finish = () => {
    // R13 (K10): khách ghi "phường/xã X" + tỉnh, không ghi quận; X trùng hai phường/xã CŨ khác quận (mơ hồ) nhưng X cũng
    // là tên phường/xã MỚI của tỉnh đó ("phường đông sơn tỉnh Thanh Hoá") → địa chỉ theo đơn vị mới: giữ nguyên chữ
    // khách, coi là đủ, không hỏi "quận nào" (khách ở đơn vị mới không trả lời được).
    if (ambiguousWardHit && result.ambiguous && !district && province) {
      const typedNew = newWardMatches(fullNorm, expanded, mergedFrom || province, locationIndex)
        .find(match => match.wardTyped && match.start < ambiguousWardHit.end && match.end > ambiguousWardHit.start);
      if (typedNew) {
        const typedPrefix = prefixBefore(fullNorm, typedNew.start);
        consumed.push({ start: typedPrefix ? typedPrefix.start : typedNew.start, end: typedNew.end });
        result.ambiguous = null;
      }
    }
    applyNewWardNames();
    // Tên đã nhận ra mà khách còn lặp lại chỗ khác (form nối ba cấp chuẩn sau
    // phần khách gõ tay) cũng được che, để phần đường phố không kéo theo tên cấp.
    // R13: tên tỉnh MỚI chứa tỉnh đã nhận ra mà khách ghi kèm ("…, TPhcm (brvt cũ)") cũng không phải phần đường phố.
    const parents = province ? locationIndex.provinces.filter(entry => entry !== province && (MERGED_PROVINCES[entry.bare] || []).includes(province.bare)) : [];
    consumeRepeats(norm, consumed, [province, ...parents, mergedFrom, result.district && districtEntry(), ward].filter(Boolean));
    result.street = remainingStreet(expanded, norm, consumed);
    result.confidence = !result.province || !result.district || !result.ward ? (result.province ? 'partial' : 'none') : (result.fuzzy ? 'fuzzy' : 'exact');
    // Thiếu phường/xã (hoặc cả quận) mà khách có ghi "phường X" với X không phải
    // phường nào của tỉnh: nhiều khả năng là đơn vị mới sau sáp nhập 1/7/2025.
    if (province && !result.ambiguous && !result.ward) {
      // applyNewWardNames có thể đã đặt postMerger (tên mới trùng tên cũ): không ghi đè.
      result.postMerger = result.postMerger || looksPostMerger(norm, provinceHit ? provinceHit.start : norm.length, province, null, locationIndex);
      // Vòng 12: tên phường/xã MỚI hay gặp ("phường Thành Vinh", "Hòa Cường, tp Đà Nẵng", "bà điểm
      // Tphcm") — kể cả không có chữ "phường/xã" — thuộc đúng tỉnh khách ghi: địa chỉ sau sáp nhập.
      const typedProvince = mergedFrom || province;
      const overlaps = (start, end) => consumed.some(range => start < range.end && end > range.start);
      const name = newWardMentioned('', typedProvince, { normalized: fullNorm, raw: expanded, skip: overlaps, locationIndex });
      if (name) { result.postMerger = true; result.newWard = name; }
      if (result.postMerger) {
        // Phần đường phố không tính đoạn chỉ là tên phường/xã ("Phường hải châu", "Hòa Cường"): để biết
        // khách có ghi số nhà/đường thật không (ghép địa chỉ nhiều tin, hỏi thiếu số nhà).
        const wardOnly = new RegExp(`^(?:(?:phuong|xa|p|x|thi tran|tt) [a-z ]+|${name ? escapeRegExp(name) : '\\0'})$`);
        result.streetWithoutWard = result.street.split(/\s*,\s*/).filter(part => !wardOnly.test(normalizeLocationKey(part))).join(', ');
      }
    }
    // Khách ghi "phường X" mà danh mục cũ là "Xã X" (hay ngược lại): xã đã lên phường sau sáp nhập →
    // giữ nguyên chữ khách ghi trên phiếu ("phường nam Sơn thành phố Bắc ninh" ≠ "Xã Nam Sơn").
    if (ward && wardHit && Number.isFinite(wardHit.start)) {
      const typed = fullNorm.slice(wardHit.start, wardHit.end).trim();
      const typedType = /^(phuong|p)\s/.test(typed) ? 'phuong' : /^(xa|x)\s/.test(typed) ? 'xa' : '';
      if (typedType && ward.prefix && typedType !== ward.prefix && ['phuong', 'xa'].includes(ward.prefix)) {
        result.typeMismatch = true;
        // R13 (K1): chính khách/ô chọn ghi quận/huyện chứa phường đó ("Phường Nghi Phú, Thành phố Vinh" ↔ danh mục
        // "Xã Nghi Phú", TP Vinh): chỉ khác loại hình vì danh mục kho cũ hơn → cột lưu vẫn giữ mã phường/quận.
        // "TP X" trùng tên tỉnh ("phường Nam Sơn thành phố Bắc Ninh") không tính là đã ghi quận.
        if (result.district && districtHit && Number.isFinite(districtHit.start) && !districtHit.fuzzy) result.wardConfirmedByDistrict = true;
      }
    }
    if (mergedFrom) {
      result.typedProvince = { code: mergedFrom.code, name: mergedFrom.name };
      // R13 (K2): khách gõ tỉnh MỚI ("tỉnh Tây Ninh") nhưng trong địa chỉ có đủ bộ phường–quận–tỉnh CŨ khớp danh mục
      // (ô chọn của form: "Xã Mỹ Hạnh Nam, Huyện Đức Hòa, Long An") và tỉnh cũ thuộc tỉnh mới đó → giữ ba cột cũ.
      const written = hit => Boolean(hit) && Number.isFinite(hit.start) && !hit.fuzzy;
      if (ward && district && province && written(wardHit) && written(districtHit) && provinceWrittenAfter(fullNorm, province, Math.max(wardHit.end, districtHit.end))) result.oldTripleTyped = true;
    }
    return result;
  };
  // Bản chuẩn hoá chưa che gì (cùng vị trí với `norm`), cho các bước dò tên trên toàn câu.
  const fullNorm = norm;
  // Tỉnh khách ghi khi máy phải chuyển sang tỉnh cũ đã nhập vào (bước 4b).
  let mergedFrom = null;
  let districtRef = null;
  const districtEntry = () => districtRef;
  const markAmbiguous = (level, hit) => {
    result.ambiguous = { level, options: hit.ambiguous.map(entry => entry.name) };
  };

  // 1. Tỉnh/thành: lấy lần xuất hiện sau cùng, vì khách viết từ nhỏ đến lớn.
  const provinceOptions = {
    ownPrefixes: ['tinh'],
    neutralPrefixes: ['thanh pho', 'tp'],
    foreignPrefixes: [...DISTRICT_PREFIXES.filter(p => !PROVINCE_PREFIXES.includes(p)), ...WARD_PREFIXES],
    fullKeys
  };
  provinceHit = findBest(norm, expanded, locationIndex.provinces, provinceOptions);
  if (provinceHit?.ambiguous) { markAmbiguous('province', provinceHit); return finish(); }
  // Khách gõ "xã A tỉnh Cao Bằng" rồi form nối ", Xã A, Huyện B, Cao Bằng": lần
  // có chữ "tỉnh" thắng điểm nhưng đứng trước, khiến quận/phường phía sau bị
  // bỏ qua. Cùng một tỉnh xuất hiện lại phía sau thì dời mốc về lần sau cùng.
  if (provinceHit) {
    let masked = maskRange(norm, expanded, provinceHit);
    let later = findBest(masked.norm, masked.raw, [provinceHit.entry], provinceOptions);
    let moved = false;
    while (later && !later.ambiguous && later.end > provinceHit.end) {
      // Lần xuất hiện sớm bị che hẳn, để "tỉnh Thanh Hoá" không bị đọc lại thành Thành phố Thanh Hóa.
      consumed.push(provinceHit);
      norm = maskRange(norm, expanded, provinceHit).norm;
      provinceHit = later;
      masked = maskRange(masked.norm, masked.raw, later);
      later = findBest(masked.norm, masked.raw, [provinceHit.entry], provinceOptions);
      moved = true;
    }
    if (moved) segments = segmentsOf(expanded, norm);
  }
  province = provinceHit?.entry || null;
  // Tỉnh đã nhận ra được che khỏi các bước sau, để "tỉnh Phú Thọ" không bị đọc
  // lại thành Thị xã Phú Thọ khi phải tìm quận ở cả phần sau tỉnh.
  if (provinceHit) {
    norm = maskRange(norm, expanded, provinceHit).norm;
    segments = segmentsOf(expanded, norm);
  }
  // districtHit / district / wardHit khai báo phía trên (applyNewWardNames trong finish dùng đến).
  let newNameRanges = null;
  const onNewWardName = segment => {
    newNameRanges ||= newWardMatches(fullNorm, expanded, mergedFrom || province, locationIndex);
    return newNameRanges.some(match => match.start < segment.end && match.end > segment.start);
  };
  const wardSearchOptions = extra => ({ ownPrefixes: WARD_PREFIXES, foreignPrefixes: DISTRICT_PREFIXES.filter(p => !WARD_PREFIXES.includes(p)), fullKeys, notAfterHouseNumber: true, ...extra });

  // 2. Không thấy tỉnh: quận/huyện có tên duy nhất trên cả nước cho biết tỉnh.
  if (!province) {
    const national = findBest(norm, expanded, locationIndex.districts, { ownPrefixes: DISTRICT_PREFIXES, foreignPrefixes: WARD_PREFIXES, fullKeys });
    if (national && !national.ambiguous) {
      const alias = normalizeLocationKey(norm.slice(national.start, national.end));
      const typed = prefixBefore(norm, national.start + (alias.length - stripPrefix(alias, DISTRICT_PREFIXES).length));
      const typedPrefix = typed ? (CANONICAL_PREFIX[typed.prefix] || typed.prefix) : '';
      let sameName = locationIndex.districtsByKey.get(alias) || locationIndex.districtsByKey.get(stripPrefix(alias, DISTRICT_PREFIXES)) || [];
      // "Tp Thủ Đức" là Thành phố Thủ Đức, không phải Quận Thủ Đức cũ: loại hình khách ghi phân định.
      if (sameName.length > 1 && typedPrefix) {
        const byType = sameName.filter(entry => entry.prefix === typedPrefix);
        if (byType.length === 1) sameName = byType;
      }
      const exactSegment = segments.some(segment => stripPrefix(segment.key, DISTRICT_PREFIXES) === national.entry.bare || segment.key === national.entry.key);
      // Không có chữ "huyện" và không đứng riêng đoạn ("ấp 2 xã Tân Hiệp Hóc Môn"):
      // vẫn tin khi ngay trước đó khách ghi rõ "xã/phường …" thuộc đúng huyện ấy.
      const confirming = sameName.length === 1 && !national.prefixed && !exactSegment
        ? findBest(norm, expanded, [...national.entry.wards.values()], wardSearchOptions({ limit: national.start }))
        : null;
      const confirmed = Boolean(confirming && confirming.prefixed && !confirming.ambiguous);
      // Vòng 12: tên quận/huyện hai chữ trở lên, duy nhất cả nước, đứng cuối hẳn địa chỉ sau phần
      // đường phố ("236 đường linh trung thủ đức"): là quận khách ghi, không phải tên đường.
      const atTextEnd = !national.prefixed && national.entry.bare.includes(' ') && national.start > 0
        && !/[a-z0-9]/.test(norm.slice(national.end).replace(COUNTRY_TOKENS, ''))
        && /[a-z]/.test(norm.slice(0, national.start));
      if (sameName.length === 1 && (national.prefixed || exactSegment || confirmed || atTextEnd)) {
        districtHit = national;
        district = national.entry;
        province = district.province;
        if (confirmed) { wardHit = confirming; ward = confirming.entry; }
        // "…, thị trấn Sịa, huyện Quảng Điền, thành phố Huế": khách gọi cả tỉnh
        // bằng tên thành phố (Thừa Thiên Huế là "Thành phố Huế" từ 2025, cũng như
        // "Vũng Tàu", "Bà Rịa"). Một huyện khác của tỉnh ghi rõ phía trước thì đó
        // mới là nơi giao; tên thành phố chỉ còn vai trò chỉ tỉnh.
        if (!confirmed) {
          const others = [...province.districts.values()].filter(entry => entry !== district);
          const other = findBest(norm, expanded, others, { limit: national.start, ownPrefixes: DISTRICT_PREFIXES, foreignPrefixes: WARD_PREFIXES, fullKeys });
          const otherExact = other && segments.some(segment => stripPrefix(segment.key, DISTRICT_PREFIXES) === other.entry.bare || segment.key === other.entry.key);
          // R13 (K5): "phong điền tp huế", "Phú Lộc TP Huế": tên huyện/thị xã khác đứng LIỀN trước tên thành phố mà
          // khách dùng để gọi cả tỉnh (Huế, Vũng Tàu, Bà Rịa) → đó mới là quận/huyện, không phải Thành phố Huế.
          // R13 fix2 (B3): "45 Phong Điền, TP Huế", "kiệt 5 Hương Thủy TP Huế" — trước tên huyện trong cùng đoạn chỉ là số nhà trần và
          // không có loại hình (huyện/thị xã/tx/h.) → đó là tên đường, thành phố đã là cấp quận hợp lệ: giữ chữ khách như trước.
          const otherAdjacent = Boolean(other) && CITY_NAMED_PROVINCES.has(national.entry.bare)
            && !/[a-z0-9]/.test(norm.slice(other.end, national.start).replace(/(?<![a-z0-9])(?:thanh pho|tp|tinh)(?![a-z0-9])/g, ''))
            && !(!other.prefixed && bareHouseNumberBefore(norm, other.start));
          if (other && !other.ambiguous && (other.prefixed || otherExact || otherAdjacent)) {
            consumed.push(national);
            provinceHit = national;
            districtHit = other;
            district = other.entry;
          } else if (!findBest(norm, expanded, [...district.wards.values()], wardSearchOptions({ limit: national.start }))) {
            // "xã Phong Hiền, Huế": thành phố không có phường/xã đó, nhưng khách
            // ghi rõ loại hình và tên đó chỉ có ở một huyện khác của tỉnh → giao
            // về huyện ấy. Không ghi loại hình ("Sịa, Huế") thì không suy đoán.
            const elsewhere = findBest(norm, expanded, others.flatMap(entry => [...entry.wards.values()]), wardSearchOptions({ limit: national.start }));
            if (elsewhere && !elsewhere.ambiguous && elsewhere.prefixed) {
              consumed.push(national);
              provinceHit = national;
              districtHit = null;
              district = elsewhere.entry.district;
              ward = elsewhere.entry;
              wardHit = elsewhere;
            }
          }
        }
      }
    }
  }
  if (!province) {
    // fix-addr (01/10): câu đáp ngắn ("Dạ vâng ạ" ≈ "da nang") không được sửa chính tả thành tên tỉnh.
    // R13: đoạn mở đầu bằng loại hình cấp quận/phường ("quan binh" = "quận Bình [Thạnh]" gõ cụt) không sửa thành tên tỉnh
    // (từng ra Quảng Bình).
    const lowerLevel = /^(?:quan|huyen|phuong|xa|thi xa|thi tran|q|h|p|x|tx|tt) \S+(?: \S+)?$/;
    const fuzzy = fuzzyMatch(segments.filter(segment => !segment.key.split(' ').every(word => REPLY_WORDS.has(word)) && !lowerLevel.test(segment.key)), locationIndex.provinces, PROVINCE_PREFIXES);
    if (fuzzy) { province = fuzzy.entry; provinceHit = { start: fuzzy.segment.start, end: fuzzy.segment.end }; result.fuzzy = true; }
  }
  if (!province) return finish();
  result.province = { code: province.code, name: province.name };
  if (provinceHit) consumed.push(provinceHit);

  // 3. Quận/huyện trong tỉnh, tìm ở phần đứng trước tỉnh. Khách gõ tỉnh giữa
  // câu rồi form nối phường/quận phía sau ("… tỉnh Phú Thọ, Phường Khai Quang,
  // Thành phố Vĩnh Yên") thì tìm cả phần sau tỉnh.
  const districts = [...province.districts.values()];
  const tailHasText = provinceHit ? /[a-z]/.test(norm.slice(provinceHit.end).replace(COUNTRY_TOKENS, '')) : false;
  const districtLimit = provinceHit && !tailHasText ? provinceHit.start : norm.length;
  // "Phường 2, TP Trà Vinh": "TP Trà Vinh" vừa được đọc là tỉnh, vừa là Thành
  // phố Trà Vinh của chính tỉnh đó. Không thấy quận nào khác thì thành phố cùng
  // tên là quận, thay vì hỏi lại khách hay để mơ hồ giữa các phường trùng số.
  const sameNameCity = provinceHit?.neutral ? districts.find(entry => entry.bare === province.bare && entry.prefix === 'thanh pho') || null : null;
  sameNameCityRef = sameNameCity;
  if (!district) {
    const districtOptions = { limit: districtLimit, ownPrefixes: DISTRICT_PREFIXES, foreignPrefixes: WARD_PREFIXES, fullKeys };
    districtHit = findBest(norm, expanded, districts, districtOptions);
    // R13 (K5): tên quận/huyện chỉ là một phần của tên tỉnh khách ghi lặp ("Krong pắc Đăk lăk, Đắk Lắk" — "Lắk" của
    // "Đắk Lắk" không phải Huyện Lắk): che lần ghi tên tỉnh đó rồi tìm lại.
    for (let guard = 0; guard < 3 && districtHit && !districtHit.ambiguous && !districtHit.prefixed; guard += 1) {
      const around = provinceNameAround(norm, province, districtHit);
      if (!around) break;
      consumed.push(around);
      norm = maskRange(norm, expanded, around).norm;
      segments = segmentsOf(expanded, norm);
      districtHit = findBest(norm, expanded, districts, districtOptions);
    }
    // Khách lặp tên tỉnh ("… Tam Điệp- Ninh Bình Đt: …, Ninh Bình"): lần lặp
    // không có "thành phố" đứng trước bị hiểu thành thành phố trùng tên tỉnh.
    // Che lần lặp rồi tìm lại: có huyện khác thì lấy huyện đó, không thì giữ
    // nguyên để "Ninh Bình, Ninh Bình" vẫn là Thành phố Ninh Bình.
    if (districtHit && !districtHit.ambiguous && !districtHit.prefixed && districtHit.entry.bare === province.bare) {
      const masked = maskRange(norm, expanded, districtHit);
      const retry = findBest(masked.norm, masked.raw, districts, districtOptions);
      if (retry && !retry.ambiguous) {
        consumed.push(districtHit);
        districtHit = retry;
      }
    }
    if (districtHit?.ambiguous) {
      // "Thủ Đức" là Quận Thủ Đức hay Thành phố Thủ Đức, "Cai Lậy" là thị xã
      // hay huyện: phường/xã khách ghi nằm ở đúng một trong hai thì chọn nơi đó.
      const wardOptions = { limit: districtHit.start, ownPrefixes: WARD_PREFIXES, foreignPrefixes: DISTRICT_PREFIXES.filter(p => !WARD_PREFIXES.includes(p)), fullKeys, notAfterHouseNumber: true };
      let withWard = districtHit.ambiguous
        .map(candidate => ({ candidate, hit: findBest(norm, expanded, [...candidate.wards.values()], wardOptions) }))
        .filter(item => item.hit && !item.hit.ambiguous);
      if (withWard.length > 1) {
        // Cả hai đều có phường đó (Thành phố Thủ Đức gồm luôn các phường của
        // Quận Thủ Đức cũ): lấy nơi khớp phường tốt hơn, còn bằng nhau thì lấy
        // đơn vị lớn hơn — là đơn vị mới sau sáp nhập.
        withWard.sort((a, b) => compareScores(b.hit.score, a.hit.score) || (b.candidate.wards.size - a.candidate.wards.size));
        if (compareScores(withWard[0].hit.score, withWard[1].hit.score) !== 0 || withWard[0].candidate.wards.size !== withWard[1].candidate.wards.size) withWard = [withWard[0]];
      }
      if (withWard.length === 1) {
        district = withWard[0].candidate;
        ward = withWard[0].hit.entry;
        wardHit = withWard[0].hit;
        districtHit = { ...districtHit, entry: district };
      } else {
        // Tên quận đã nhận ra dù chưa biết loại hình: không để nó lẫn vào phần đường phố.
        consumed.push(districtHit);
        markAmbiguous('district', districtHit);
        return finish();
      }
    }
    district = district || districtHit?.entry || null;
  }

  // 4. Không thấy quận: phường/xã có tên duy nhất trong tỉnh cho biết quận.
  if (!district) {
    const allWards = districts.flatMap(entry => [...entry.wards.values()]);
    const hit = findBest(norm, expanded, allWards, {
      limit: districtLimit,
      ownPrefixes: WARD_PREFIXES,
      foreignPrefixes: DISTRICT_PREFIXES.filter(p => !WARD_PREFIXES.includes(p)),
      fullKeys,
      notAfterHouseNumber: true
    });
    // Chỉ tin phường/xã khi khách ghi rõ loại hình hoặc tên đứng riêng một
    // đoạn: "Số 8 Lê Lợi" là tên đường, không phải Phường Lê Lợi ở huyện khác.
    const exactSegment = hit && segments.some(segment => stripPrefix(segment.key, WARD_PREFIXES) === hit.entry.bare || segment.key === hit.entry.key);
    if (hit && (hit.prefixed || exactSegment)) {
      const owners = new Set((hit.ambiguous || [hit.entry]).map(entry => entry.district));
      if (owners.size === 1 && !hit.ambiguous) { wardHit = hit; ward = hit.entry; district = ward.district; }
      else if (owners.size === 1) { district = [...owners][0]; markAmbiguous('ward', hit); }
      else if (sameNameCity && owners.has(sameNameCity)) {
        district = sameNameCity;
        ward = hit.ambiguous.find(entry => entry.district === sameNameCity);
        wardHit = { ...hit, entry: ward, ambiguous: undefined };
      }
      else { markAmbiguous('district', { ambiguous: [...owners] }); ambiguousWardHit = hit; }
    }
  }
  if (!district && !result.ambiguous && sameNameCity) district = sameNameCity;
  // 4b. Tỉnh mới sau sáp nhập ("Phường Tân Đông Hiệp, Hồ Chí Minh"): quận hay
  // phường không có trong tỉnh ghi trên địa chỉ nhưng có ở đúng một tỉnh cũ đã
  // nhập vào → chuyển sang tỉnh cũ, đúng tên ba cấp mà kho đang dùng.
  if (!district && !result.ambiguous) {
    const found = [];
    for (const member of mergedProvinceMembers(province, locationIndex)) {
      const memberDistricts = [...member.districts.values()];
      const districtInMember = findBest(norm, expanded, memberDistricts, { limit: districtLimit, ownPrefixes: DISTRICT_PREFIXES, foreignPrefixes: WARD_PREFIXES, fullKeys });
      if (districtInMember && !districtInMember.ambiguous
        && (districtInMember.prefixed || segments.some(segment => stripPrefix(segment.key, DISTRICT_PREFIXES) === districtInMember.entry.bare))) {
        found.push({ province: member, district: districtInMember.entry, districtHit: districtInMember });
        continue;
      }
      const wardInMember = findBest(norm, expanded, memberDistricts.flatMap(entry => [...entry.wards.values()]), wardSearchOptions({ limit: districtLimit }));
      if (wardInMember && !wardInMember.ambiguous
        && (wardInMember.prefixed || segments.some(segment => stripPrefix(segment.key, WARD_PREFIXES) === wardInMember.entry.bare))) {
        found.push({ province: member, district: wardInMember.entry.district, ward: wardInMember.entry, wardHit: wardInMember });
      }
    }
    if (found.length === 1) {
      const [hit] = found;
      mergedFrom = province;
      province = hit.province;
      result.province = { code: province.code, name: province.name };
      district = hit.district;
      districtHit = hit.districtHit || null;
      if (hit.ward) { ward = hit.ward; wardHit = hit.wardHit; }
    }
  }
  if (!district && !result.ambiguous) {
    const fuzzy = fuzzyMatch(segments.filter(segment => segment.start < districtLimit), districts, DISTRICT_PREFIXES);
    if (fuzzy && !onNewWardName(fuzzy.segment)) { district = fuzzy.entry; districtHit = { start: fuzzy.segment.start, end: fuzzy.segment.end, fuzzy: true }; result.fuzzy = true; }
  }
  if (!district) return finish();
  result.district = { code: district.code, name: district.name };
  districtRef = district;
  if (districtHit) consumed.push(districtHit);
  if (result.ambiguous) return finish();

  // 5. Phường/xã trong quận, ở phần đứng trước quận.
  const wards = [...district.wards.values()];
  // 3. Huyện đảo chỉ có một đơn vị mang chính tên huyện (Côn Đảo, Cồn Cỏ, Bạch
  // Long Vĩ): tỉnh + huyện là đủ, cột phường lấy đúng dòng danh mục của kho.
  if (!ward && wards.length === 1 && islandUnit(wards[0], district)) ward = wards[0];
  if (!ward) {
    const limit = districtHit ? districtHit.start : districtLimit;
    wardHit = findBest(norm, expanded, wards, { limit, ownPrefixes: WARD_PREFIXES, foreignPrefixes: DISTRICT_PREFIXES.filter(p => !WARD_PREFIXES.includes(p)), fullKeys, notAfterHouseNumber: true });
    if (wardHit?.ambiguous) { consumed.push(wardHit); markAmbiguous('ward', wardHit); return finish(); }
    // fix-addr (01/10): khách ghi phường SAU quận/tỉnh ("… thành phố vinh nghệ an phường hưng phúc"): chỉ nhận khi có chữ
    // "phường/xã/thị trấn" đứng trước tên (tên trơ sau quận dễ là tên đường/mốc).
    if (!wardHit && districtHit && Number.isFinite(districtHit.end)) {
      const after = findBest(norm, expanded, wards, { ownPrefixes: WARD_PREFIXES, foreignPrefixes: DISTRICT_PREFIXES.filter(p => !WARD_PREFIXES.includes(p)), fullKeys, notAfterHouseNumber: true });
      if (after && after.prefixed && !after.ambiguous && after.start >= districtHit.end) wardHit = after;
    }
    ward = wardHit?.entry || null;
    // R13 (K8): tên chỉ khác cách viết i/y ("xã An Qui" ↔ Xã An Quy), khách ghi rõ loại hình, đúng một phường/xã của quận.
    if (!ward) {
      const spelled = iyWardMatch(norm, wards, limit);
      if (spelled) { ward = spelled.entry; wardHit = spelled; result.fuzzy = true; }
    }
    if (!ward) {
      // fix-addr (01/10): đoạn chứa đúng một tên phường/xã MỚI của tỉnh khách ghi thì không sửa chính tả về tên cũ ("Trấn Biên" ≠ Tân Biên).
      let fuzzy = fuzzyMatch(segments.filter(segment => segment.start < limit), wards, WARD_PREFIXES);
      // R13: cụm đã được sửa chính tả thành tên quận/huyện ("dfooong hưng" → Đông Hưng) không dùng lại làm tên phường.
      if (fuzzy && districtHit?.fuzzy && fuzzy.segment.start < districtHit.end && fuzzy.segment.end > districtHit.start) fuzzy = null;
      if (fuzzy && !onNewWardName(fuzzy.segment)) { ward = fuzzy.entry; wardHit = { start: fuzzy.segment.start, end: fuzzy.segment.end, fuzzy: true }; result.fuzzy = true; }
    }
  }
  // R13 (K6): "( an thới củ )", "xã châu hồng ( châu tiến cũ)" — khách chú thích tên phường/xã CŨ trong ngoặc và tên đó
  // là đúng một phường/xã của quận đã nhận ra. Danh mục kho là đơn vị cũ nên lấy tên trong chú thích khi chưa đọc ra
  // phường nào, hoặc khi chú thích đứng LIỀN sau tên phường vừa đọc ("xã A (B cũ)": A là tên mới, B là tên cũ).
  for (const note of expanded.matchAll(OLD_WARD_NOTE)) {
    const noteKey = normalizeLocationKey(note[1]);
    const bareKey = stripPrefix(noteKey, WARD_PREFIXES);
    // R13 fix2 (B1): "xã Hòa Khánh Đông (Đức Hòa cũ)" — tên trong ngoặc là HUYỆN cũ (cách ghi sau khi bỏ cấp huyện), không phải
    // phường cũ; thị trấn huyện lỵ trùng tên huyện từng được gán thay xã khách ghi. Trùng tên quận/huyện nào của tỉnh → bỏ qua.
    if (!bareKey || districts.some(entry => entry.bare === bareKey || entry.key === noteKey)) continue;
    const named = wards.filter(entry => entry.key === noteKey || (!entry.numeric && entry.bare === bareKey));
    if (named.length !== 1 || named[0] === ward) continue;
    // R13 fix2 (B1): đã đọc ra phường đúng danh mục (không mờ) thì giữ phường khách ghi; chú thích chỉ dùng khi CHƯA đọc ra phường,
    // hoặc phường đọc ra là khớp mờ đứng liền trước chú thích.
    const typedHit = wardHit && Number.isFinite(wardHit.start) ? wardHit : null;
    if (ward && !(typedHit?.fuzzy && typedHit.end <= note.index && !/[a-z0-9]/.test(fullNorm.slice(typedHit.end, note.index)))) continue;
    // R13 fix2 (B7): cụm liền trước chú thích là tên phường/xã MỚI của tỉnh ("xã Châu Hồng (Châu Tiến cũ)") → giữ tên mới khách ghi
    // (postMerger + newWard, nhân viên thấy ghi chú), không gán mã đơn vị cũ.
    if (!ward) {
      newNameRanges ||= newWardMatches(fullNorm, expanded, mergedFrom || province, locationIndex);
      if (newNameRanges.some(match => match.end <= note.index && !/[a-z0-9]/.test(fullNorm.slice(match.end, note.index)))) continue;
    }
    if (typedHit) consumed.push({ start: typedHit.start, end: typedHit.end });
    ward = named[0];
    wardHit = { entry: ward, start: note.index, end: note.index + note[0].length };
    break;
  }
  if (ward) {
    result.ward = { code: ward.code, name: ward.name };
    if (wardHit) consumed.push(wardHit);
  }
  return finish();
}

/** Đơn vị duy nhất của một huyện đảo mang chính tên huyện ("Côn Đảo", "Đảo Cồn Cỏ"). */
function islandUnit(unit, district) {
  const unitName = unit.bare.replace(/^dao /, '');
  const districtName = district.bare.replace(/^dao /, '');
  return unitName === districtName;
}

/**
 * Che mọi lần xuất hiện khác của các tên đã nhận ra (kèm loại hình đứng
 * trước nếu có), với cùng điều kiện khi tìm: có loại hình hoặc đứng cuối đoạn,
 * không đứng sau từ chỉ đường ("đường Lê Lợi" khi phường là Lê Lợi).
 */
function consumeRepeats(norm, consumed, entries) {
  const overlaps = (start, end) => consumed.some(range => start < range.end && end > range.start);
  // R13: "cả đoạn chỉ là tên đó" xét sau khi bỏ các phần đã nhận ra ("Cần thơ ( an thới củ )" còn lại đúng "Cần thơ").
  const left = consumed.filter(range => Number.isFinite(range.start) && Number.isFinite(range.end)).reduce((text, range) => maskRange(text, text, range).norm, norm);
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const pattern = boundary(alias);
      let match;
      while ((match = pattern.exec(norm))) {
        const start = match.index;
        const end = start + match[0].length;
        if (overlaps(start, end)) continue;
        const prefixed = alias === entry.key && entry.key !== entry.bare ? null : prefixBefore(norm, start);
        // Không có loại hình thì cả đoạn phải chỉ là tên đó (", Cao Bằng"), để
        // "12 Lê Lợi" của Phường Lê Lợi vẫn là tên đường.
        if (!prefixed && normalizeLocationKey(segmentAround(left, start, end)) !== alias) continue;
        consumed.push({ start: prefixed ? prefixed.start : start, end });
      }
    }
  }
}

// Từ chỉ đường đứng ngay trước một tên cấp cho biết đó là tên đường ("đường Hà Nội").
const STREET_WORD_BEFORE = /(?:^|[\s,])(duong|pho|ngo|ngach|hem|kiet|so|dai lo|quoc lo|tinh lo|ql|tl|cau|cho|ben|kdc|kp|to|thon|ap|xom|khu|khu pho|to dan pho|tdp)\s*$/;

/**
 * Phần đường phố để hiển thị: khách hay gõ cả phường/huyện/tỉnh vào một ô
 * không dấu phẩy ("Sau thương thanh cao lương son hoa bình"), rồi form nối
 * thêm ba cấp chuẩn phía sau. Sau khi bộ đọc bỏ ba cấp chuẩn, hàm này cắt
 * tiếp các tên cấp còn dính ở cuối, lớn trước nhỏ sau, mỗi tên kèm loại hình
 * tuỳ ý ("tt hùng sơn"). Không cắt khi tên chỉ là số mà thiếu loại hình
 * ("Ngách 15" với Phường 15), khi phía trước là từ chỉ đường ("đường Hà Nội"),
 * hay khi cắt xong không còn chữ nào ("33/63/239 lê lợi" ở Phường Lê Lợi).
 */
export function streetForDisplay(address, hints = {}, locationIndex = loadLocationIndex()) {
  const text = String(address || '').trim();
  if (!text) return '';
  const resolved = resolveAddress(text, locationIndex);
  const names = [
    resolved.province?.name || hints.province,
    resolved.district?.name || hints.district,
    resolved.ward?.name || hints.ward
  ].map(name => stripPrefix(normalizeLocationKey(name || ''), ALL_PREFIXES)).filter(Boolean);
  // Gạch ngang có khoảng trắng kề bên là dấu ngăn đoạn ("khu 10 - Lâm Thao - Phú Thọ").
  let street = resolved.street.replace(/\s+[-–]\s*|\s*[-–]\s+/g, ', ');
  const prefixGroup = `(?:(?:${ALL_PREFIXES.join('|')})\\s+)`;
  const trimEnd = value => value.replace(/[\s,;.\-–]+$/u, '');
  let changed = true;
  while (changed && names.length) {
    changed = false;
    street = trimEnd(street);
    const norm = normalizeAligned(street).toLowerCase();
    for (const bare of names) {
      const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const numeric = /^\d+$/.test(bare);
      const pattern = new RegExp(`(?<![a-z0-9])(${prefixGroup}${numeric ? '' : '?'})${escaped}\\s*$`, 'u');
      const match = pattern.exec(norm);
      if (!match) continue;
      const prefixed = Boolean(match[1]);
      const rest = street.slice(0, match.index);
      if (!prefixed && STREET_WORD_BEFORE.test(norm.slice(0, match.index))) continue;
      if (!prefixed && !/\p{L}/u.test(rest)) continue;
      street = rest;
      changed = true;
      break;
    }
  }
  return trimEnd(street).split(/\s*[,;]\s*/).map(part => part.trim()).filter(Boolean).join(', ');
}

/** Địa chỉ đầy đủ theo tên chuẩn: "số nhà đường, Phường, Quận, Tỉnh". */
/**
 * Các trường ba cấp ghi lên một đơn từ địa chỉ khách gõ: dùng chung cho đơn
 * chatbot lúc tạo và cho nhân viên sửa địa chỉ sau này, để hai nơi không lệch nhau.
 */
/**
 * Khách có tự ghi quận/huyện này trong địa chỉ không (khác với quận/huyện máy suy
 * ra từ tên phường). Dùng để tôn trọng địa chỉ ghi theo đơn vị sau sáp nhập 2025
 * (chỉ phường/xã + tỉnh): không tự chèn quận/huyện cũ vào.
 */
export function districtMentioned(text, district) {
  if (!district?.name) return false;
  const norm = normalizeLocationKey(expandAddressAbbreviations(String(text || '')));
  const key = normalizeLocationKey(district.name);
  const bare = stripPrefix(key, DISTRICT_PREFIXES);
  const candidates = [key, ...(bare && !/^\d+$/.test(bare) ? [bare] : [])];
  // Tên cũ đã gộp là alias của quận (Quận 2/Quận 9/Quận Thủ Đức → Thành phố Thủ
  // Đức): khách ghi "Quận 9" là đã ghi quận, không phải máy tự suy từ phường.
  let aliases = Array.isArray(district.aliases) ? district.aliases : null;
  if (!aliases) {
    try {
      const entry = loadLocationIndex().districts.find(item => (district.code && item.code === district.code) || item.key === key);
      aliases = entry?.aliases || [];
    } catch { aliases = []; }
  }
  for (const alias of aliases) if (alias && !/^\d+$/.test(alias) && !candidates.includes(alias)) candidates.push(alias);
  return candidates.some(alias => new RegExp(`(?<![a-z0-9])${escapeRegExp(alias)}(?![a-z0-9])`).test(norm));
}

export function resolvedAddressFields(address, locationIndex = loadLocationIndex()) {
  address = clampAddressText(address);
  const location = resolveAddress(address, locationIndex);
  // Địa chỉ ghi theo đơn vị mới sau sáp nhập (phường/xã không có trong danh mục cũ):
  // giữ nguyên như khách ghi, không suy ngược về phường/quận cũ (28/09, chủ shop).
  const postMerger = location.postMerger === true;
  // fix-addr (01/10): cũng giữ nguyên chữ khách khi khách ghi "phường" mà danh mục cũ là "xã" (typeMismatch) hay ghi
  // tỉnh mới mà máy phải tìm ở tỉnh cũ đã nhập vào (typedProvince): không ghi phường/quận cũ máy đoán vào cột lưu —
  // POS không có mã phường thì nhận cả địa chỉ chữ (pos-orders buildPosOrderPayload), thay vì số nhà + phường/quận sai.
  // R13 (K2): tỉnh mới khách gõ + bộ phường–quận–tỉnh cũ có ghi đủ trong địa chỉ → ba cột theo bộ cũ (có mã).
  // R13 (K1): khác loại hình Phường/Xã nhưng khách ghi đúng quận chứa phường → vẫn giữ mã phường/quận.
  const typedElsewhere = Boolean(location.typedProvince) && location.oldTripleTyped !== true;
  const keepTyped = postMerger || typedElsewhere || (location.typeMismatch === true && location.wardConfirmedByDistrict !== true);
  // R13 (K7): phần khách tự gõ đọc ra đủ ba cấp nhưng đuôi ô chọn (form landing / POS) là tỉnh hoặc quận KHÁC → không
  // tự chọn bên nào (ba cột vẫn như bộ đọc ra), chỉ thêm `addressCheck` để order-notes hiện "⚠ Ô chọn khác chữ khách
  // gõ" ở Xử lý dữ liệu. Chỉ có khoá này khi có mâu thuẫn (không ghi đè ghi chú soát khác của đơn khi không có).
  let pickConflict = null;
  try { pickConflict = addressTailConflict(address, locationIndex); } catch { pickConflict = null; }
  return {
    ...(pickConflict ? { addressCheck: pickConflict.detail.slice(0, 300) } : {}),
    address,
    street: location.street,
    province: (typedElsewhere ? location.typedProvince?.name : '') || location.province?.name || '',
    district: typedElsewhere ? '' : (!keepTyped || districtMentioned(address, location.district) ? (location.district?.name || '') : ''),
    ward: keepTyped ? '' : (location.ward?.name || ''),
    locationConfidence: location.confidence,
    postMerger: location.postMerger === true
  };
}

// ===== R13 (K7): chữ khách gõ ↔ ô chọn của form / đuôi POS =====

export const ADDRESS_PICK_CONFLICT_REASON = 'Ô chọn khác chữ khách gõ';

// Quận/huyện đã đổi tên/nhập vào đơn vị khác mà danh mục kho chưa cập nhật (ô chọn POS ghi tên mới): không phải mâu thuẫn.
const RENAMED_DISTRICTS = {
  'lam dong': { 'huyen da teh': 'huyen da huoai', 'huyen cat tien': 'huyen da huoai' }
};

/**
 * Khách tự gõ địa chỉ đủ ba cấp trong ô địa chỉ nhưng ô chọn tỉnh/quận của form (hay đuôi ba cấp trên POS) lại là nơi
 * KHÁC ở cấp tỉnh hoặc quận/huyện ("B15 hoàng cầm p2 tp Vũng Tàu" ↔ ô chọn "Xã Long Vĩnh, Huyện Duyên Hải, Trà Vinh").
 * Hàm thuần: KHÔNG chọn bên nào — chỉ trả lý do để nơi gọi gắn `order.addressCheck` (đơn vào Xử lý dữ liệu, nhân viên
 * đối chiếu). Trả null khi không mâu thuẫn hoặc không đủ chắc:
 * - chữ khách gõ phải TỰ đọc ra đủ ba cấp, khớp trực tiếp (không sửa chính tả, không mơ hồ, không phải địa chỉ sau sáp nhập);
 * - khác phường/xã trong cùng quận không tính (đổi tên đơn vị: Cầu Kho → Cầu Ông Lãnh; khách chọn nhầm xã lân cận);
 * - quận/huyện đổi tên/nhập (Đạ Tẻh → Đạ Huoai), hay cùng tên phường/xã ở hai bên, không tính;
 * - ô chọn ghi tỉnh MỚI chứa tỉnh khách gõ (đuôi hai cấp kiểu mới của POS) không tính là khác tỉnh.
 * @param {string} typedText phần khách tự gõ (không kèm đuôi ô chọn)
 * @param {{province?: string, district?: string, ward?: string}} picked giá trị ô chọn / đuôi POS
 */
export function typedVsPickedConflict(typedText, picked = {}, locationIndex = loadLocationIndex()) {
  const typedRaw = String(typedText ?? '').trim();
  const given = { ward: String(picked?.ward ?? '').trim(), district: String(picked?.district ?? '').trim(), province: String(picked?.province ?? '').trim() };
  const pickedText = [given.ward, given.district, given.province].filter(Boolean).join(', ');
  if (!typedRaw || !given.province) return null;
  const typed = resolveAddress(typedRaw, locationIndex);
  if (typed.confidence !== 'exact' || typed.fuzzy || typed.ambiguous || typed.postMerger || !typed.province || !typed.district || !typed.ward) return null;
  const chosen = resolveAddress(pickedText, locationIndex);
  if (!chosen.province || chosen.ambiguous?.level === 'province') return null;
  const names = result => [result.ward?.name, result.district?.name, (result.typedProvince || result.province)?.name].filter(Boolean).join(', ');
  const conflict = level => ({
    reason: ADDRESS_PICK_CONFLICT_REASON,
    level,
    typed: { ward: typed.ward.name, district: typed.district.name, province: typed.province.name },
    picked: given,
    detail: `${ADDRESS_PICK_CONFLICT_REASON}: khách gõ "${names(typed)}" ↔ ô chọn "${pickedText}"`
  });
  const codes = result => [result.province?.code, result.typedProvince?.code].filter(Boolean);
  const sameProvince = codes(typed).some(code => codes(chosen).includes(code));
  if (!sameProvince) {
    // Ô chọn chỉ có tỉnh MỚI (hay phường + tỉnh mới) chứa tỉnh khách gõ: cùng một nơi theo hai cách gọi.
    if (!given.district && mergedParentOf(typed, chosen, locationIndex)) return null;
    // R13 fix2 (B6): ô chọn ghi tỉnh mẹ sau sáp nhập KÈM quận VÀ phường trùng tên với chữ khách gõ ("… thị trấn Tân Phú huyện Đồng Phú
    // Bình Phước" ↔ "Thị trấn Tân Phú, Huyện Đồng Phú, Đồng Nai"): cùng một nơi, không cờ. Chỉ trùng tên quận thì chưa đủ: hai tỉnh
    // cũ nhập vào nhau có thể cùng có một "Huyện Châu Thành" (đơn thật: khách gõ Xã Mong Thọ, Châu Thành, Kiên Giang ↔ ô chọn Xã Hòa
    // Bình Thạnh, Châu Thành, An Giang — mâu thuẫn thật, vẫn phải cờ).
    const sameBareName = (left, right, prefixes) => {
      const keyOf = value => stripPrefix(normalizeLocationKey(value || ''), prefixes);
      const a = keyOf(left);
      return Boolean(a) && !/^\d+$/.test(a) && a === keyOf(right);
    };
    if (given.district && mergedParentOf(typed, chosen, locationIndex)
      && sameBareName(given.district, typed.district.name, DISTRICT_PREFIXES)
      && (!given.ward || sameBareName(given.ward, typed.ward.name, WARD_PREFIXES))) return null;
    return conflict('province');
  }
  // Ô chọn không có quận/huyện (đuôi hai cấp kiểu mới) thì không có gì để so ở cấp quận.
  if (!given.district || !chosen.district || chosen.ambiguous) return null;
  if (chosen.district.code === typed.district.code) return null;
  const typedProvinceEntry = locationIndex.provinces.find(entry => entry.code === typed.province.code);
  const renamed = RENAMED_DISTRICTS[typedProvinceEntry?.bare || '']?.[normalizeLocationKey(typed.district.name)];
  if (renamed && renamed === normalizeLocationKey(chosen.district.name)) return null;
  // Cùng tên phường/xã ở hai bên: huyện đổi tên/nhập, không phải khách ở nơi khác. Phường số ("Phường 13" có ở nhiều
  // quận) không tính.
  const bareWard = name => stripPrefix(normalizeLocationKey(name || ''), WARD_PREFIXES);
  if (given.ward && !/^\d+$/.test(bareWard(given.ward)) && bareWard(given.ward) === bareWard(typed.ward.name)) return null;
  return conflict('district');
}

/** Tỉnh ô chọn là tỉnh mới đã nhận tỉnh khách gõ (hoặc ngược lại). */
function mergedParentOf(typed, chosen, locationIndex) {
  const entry = result => locationIndex.provinces.find(item => item.code === result.province?.code);
  const left = entry(typed);
  const right = entry(chosen);
  if (!left || !right) return false;
  return (MERGED_PROVINCES[right.bare] || []).includes(left.bare) || (MERGED_PROVINCES[left.bare] || []).includes(right.bare);
}

/**
 * Như typedVsPickedConflict nhưng nhận CẢ địa chỉ đã ghép "phần khách gõ, Phường/Xã, Quận/Huyện, Tỉnh" (địa chỉ đơn
 * landing, địa chỉ POS): tự tách đuôi ô chọn (ba cấp, quận + tỉnh, hay chỉ tỉnh) ở cuối. Không có đuôi chuẩn → null.
 */
export function addressTailConflict(address, locationIndex = loadLocationIndex()) {
  const segments = String(address ?? '').split(',').map(part => part.trim());
  if (segments.length < 2) return null;
  const last = segments.at(-1);
  // Đuôi ô chọn là tên chuẩn: tên tỉnh đứng riêng một đoạn, viết đúng tên (không kèm chữ khác).
  const provinceEntry = locationIndex.provinceByAlias.get(normalizeLocationKey(last)) || null;
  if (!provinceEntry || !last || /\d/.test(last)) return null;
  const typeOf = (segment, prefixes) => { const key = normalizeLocationKey(segment); return prefixes.some(prefix => key.startsWith(`${prefix} `)); };
  const districtTypes = ['quan', 'huyen', 'thi xa', 'thanh pho'];
  const wardTypes = ['phuong', 'xa', 'thi tran', 'dac khu'];
  const second = segments.at(-2) || '';
  const third = segments.at(-3) || '';
  let picked;
  let head;
  if (segments.length >= 4 && typeOf(second, districtTypes) && typeOf(third, wardTypes)) {
    picked = { ward: third, district: second, province: last };
    head = segments.slice(0, -3);
  } else if (segments.length >= 3 && typeOf(second, districtTypes)) {
    picked = { ward: '', district: second, province: last };
    head = segments.slice(0, -2);
  } else if (segments.length >= 3 && typeOf(second, wardTypes)) {
    picked = { ward: second, district: '', province: last };
    head = segments.slice(0, -2);
  } else {
    picked = { ward: '', district: '', province: last };
    head = segments.slice(0, -1);
  }
  const typedText = head.join(', ').trim();
  if (!typedText) return null;
  return typedVsPickedConflict(typedText, picked, locationIndex);
}

export function formatResolvedAddress(resolved) {
  return [resolved.street, resolved.ward?.name, resolved.district?.name, resolved.province?.name].filter(Boolean).join(', ');
}

/**
 * Tên chuẩn cho ba cột tỉnh/quận/phường của một dòng đơn (import Pancake hoặc
 * chatbot). Ba cột có gì thì tra theo đó; cột trống thì đọc từ địa chỉ.
 * Không nhận ra được thì giữ nguyên giá trị gốc chứ không bỏ trống.
 */
export function canonicalLocationColumns({ province = '', district = '', ward = '', address = '' } = {}, locationIndex = loadLocationIndex()) {
  const given = [ward, district, province].map(value => String(value ?? '').trim());
  const fromColumns = given.some(Boolean) ? resolveAddress(given.filter(Boolean).join(', '), locationIndex) : null;
  const fromAddress = String(address ?? '').trim() ? resolveAddress(address, locationIndex) : null;
  // Ba cột là nguồn chính; địa chỉ chỉ bù cấp còn thiếu khi cùng một tỉnh,
  // để một địa chỉ ghi nhầm không kéo đơn sang tỉnh khác.
  let primary = fromColumns?.province ? fromColumns : fromAddress;
  let filler = fromColumns?.province ? fromAddress : null;
  if (filler && filler.province?.code !== primary?.province?.code) filler = null;
  const pick = level => primary?.[level] || filler?.[level] || null;
  return {
    province: pick('province')?.name || normalizeExportLocation(given[2], locationIndex),
    district: pick('district')?.name || normalizeExportLocation(given[1], locationIndex),
    ward: pick('ward')?.name || normalizeExportLocation(given[0], locationIndex)
  };
}

/**
 * Kiểm tra ba cột tỉnh/quận/phường đã đúng danh mục kho chưa, dùng trước khi
 * xuất file: mỗi tên phải trùng khớp tên trong danh mục (đúng dấu, đúng loại
 * hình) và cấp dưới phải thuộc cấp trên. Trả về danh sách lỗi bằng tiếng Việt,
 * rỗng là đạt. Huyện đảo chỉ có một đơn vị (Côn Đảo…) thì cột phường mang
 * chính dòng đó của danh mục.
 */
export function checkLocationColumns({ province = '', district = '', ward = '' } = {}, locationIndex = loadLocationIndex()) {
  const issues = [];
  const given = { province: String(province ?? '').trim(), district: String(district ?? '').trim(), ward: String(ward ?? '').trim() };
  const sameName = (a, b) => normalizeLocationKey(a) === normalizeLocationKey(b) && String(a).normalize('NFC') === String(b).normalize('NFC');
  if (!given.province) issues.push('Thiếu tỉnh/thành');
  const provinceEntry = given.province ? [...locationIndex.provinces].find(entry => sameName(entry.name, given.province)) : null;
  if (given.province && !provinceEntry) issues.push(`Tỉnh/thành "${given.province}" không đúng tên trong danh mục`);
  if (!given.district) issues.push('Thiếu quận/huyện');
  const districtEntry = provinceEntry && given.district ? [...provinceEntry.districts.values()].find(entry => sameName(entry.name, given.district)) : null;
  if (given.district && provinceEntry && !districtEntry) issues.push(`Quận/huyện "${given.district}" không thuộc ${provinceEntry.name} hoặc sai tên`);
  if (!given.ward) issues.push('Thiếu phường/xã');
  const wardEntry = districtEntry && given.ward ? [...districtEntry.wards.values()].find(entry => sameName(entry.name, given.ward)) : null;
  if (given.ward && districtEntry && !wardEntry) issues.push(`Phường/xã "${given.ward}" không thuộc ${districtEntry.name} hoặc sai tên`);
  return { ok: issues.length === 0, issues, province: provinceEntry?.name || '', district: districtEntry?.name || '', ward: wardEntry?.name || '' };
}

/** Một tên cấp bất kỳ về dạng chuẩn của danh mục nếu tên đó chỉ có một nơi. */
export function normalizeExportLocation(value, locationIndex = loadLocationIndex()) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const key = normalizeLocationKey(expandAddressAbbreviations(raw));
  // Tên đầy đủ của tỉnh trước, rồi tên đầy đủ của quận (chỉ khi duy nhất),
  // rồi mới đến tỉnh bỏ tiền tố: "Thành phố Thanh Hóa" là quận, không phải tỉnh.
  const exactProvince = locationIndex.provinceByAlias.get(key);
  if (exactProvince) return exactProvince.name;
  const districts = locationIndex.districtsByKey.get(key) || [];
  if (districts.length === 1) return districts[0].name;
  const province = locationIndex.provinceByAlias.get(stripPrefix(key, PROVINCE_PREFIXES));
  if (province) return province.name;
  return raw;
}

// ===== Địa chỉ giao hàng đủ chưa? =====

/**
 * Phần đường phố có dùng được để giao không. Chỉ có số nhà ("12", "số 12",
 * "12/3a") thì shipper không tìm được; "Thôn Đông", "Ấp 2", "KP 3" hay
 * "12 Lê Lợi" thì được.
 */
export function isUsableStreet(street) {
  const key = normalizeLocationKey(street);
  if (!key) return false;
  return !/^(so\s+|nha\s+|so\s+nha\s+)?[\d\/\-]*\d[\d\/\-]*[a-z]?$/.test(key);
}

// fix-addr (01/10): số nhà khách gõ phải còn trên địa chỉ cuối (sau LLM, ghép mảnh, AI, điền từ POS).
// Số nhà = cụm số (có thể kèm chữ cái, "/"): "71/82", "19A", "Tk16/36D", "số 5". Không tính số của phường/quận
// ("Phường 14", "Q.1", "p8" — được chuẩn hoá thành tên), SĐT/mã bưu điện (≥ 6 chữ số), số lượng ("2 túi").
const HOUSE_NUMBER = /(?<![\p{L}\p{N}])(?:[a-z]{1,3})?\d{1,5}[a-z]?(?:\/\d{1,5}[a-z]?)*(?![\p{L}\p{N}\/])/giu;
const NUMBER_LEVEL_BEFORE = /(?:^|[^\p{L}\p{N}])(?:quận|quan|q|phường|phuong|p|f|ward|district)\s*\.?\s*$/iu;
const QUANTITY_AFTER = /^\s*(?:túi|tui|gói|goi|bịch|bich|hộp|hop|combo|set|k|nghìn|ngàn|đ|d|lần|ngày|tháng|giờ|h)(?![\p{L}])/iu;

/** Các số nhà khách gõ trong một đoạn chữ (dạng thường, để so). */
export function houseNumbersOf(text) {
  const source = String(text ?? '');
  const found = [];
  for (const match of source.matchAll(HOUSE_NUMBER)) {
    const token = match[0].toLowerCase();
    if (NUMBER_LEVEL_BEFORE.test(source.slice(0, match.index))) continue;
    if (QUANTITY_AFTER.test(source.slice(match.index + match[0].length))) continue;
    // "p14", "q1", "f5", "tp1"… là phường/quận viết tắt, không phải số nhà.
    if (/^(?:p|q|f|x|h|tt|tx|tp)\d/.test(token)) continue;
    if (!found.includes(token)) found.push(token);
  }
  return found;
}

/** Số nhà có trong `typed` mà không còn trong `final` (rỗng = không mất số nào). */
export function lostHouseNumbers(typed, final) {
  const kept = new Set(houseNumbersOf(final));
  const finalText = String(final ?? '').toLowerCase();
  return houseNumbersOf(typed).filter(token => !kept.has(token) && !finalText.includes(token));
}

/** "a", "a và b", "a, b và c". */
function listInVietnamese(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} và ${items.at(-1)}`;
}

const LEVEL_LABELS = { province: 'tỉnh/thành phố', district: 'quận/huyện', ward: 'phường/xã', street: 'tên đường hoặc thôn/ấp kèm số nhà' };

/**
 * Đánh giá một địa chỉ khách nhắn cho bước chốt đơn: đủ ba cấp và có đường
 * phố thì `complete`; thiếu gì thì `missing` liệt kê để bot hỏi đúng phần đó;
 * nhiều tên cùng khớp thì `choices` để bot hỏi khách chọn.
 */
export function describeDeliveryAddress(text, locationIndex = loadLocationIndex()) {
  text = clampAddressText(text);
  const resolved = resolveAddress(text, locationIndex);
  const missing = [];
  // Quận/huyện chỉ mơ hồ giữa hai loại hình cùng tên ("Quận Thủ Đức" / "Thành
  // phố Thủ Đức"): hỏi khách chọn giữa hai cái tên đó chỉ gây khó hiểu; xin
  // phường/xã thì tự phân định được.
  const sameNameDistricts = resolved.ambiguous?.level === 'district'
    && new Set(resolved.ambiguous.options.map(name => stripPrefix(normalizeLocationKey(name), DISTRICT_PREFIXES))).size === 1;
  // Địa chỉ ghi theo đơn vị sau sáp nhập 2025 (phường/xã mới + tỉnh, không quận/huyện):
  // khách đã ghi đủ theo cách mới → không đòi quận/huyện, không đòi lại phường, và giữ
  // nguyên chữ khách ghi làm địa chỉ giao (không ép về đơn vị cũ). Cũng giữ nguyên chữ
  // khách khi họ không ghi quận/huyện mà máy chỉ suy ra từ tên phường.
  const postMerger = resolved.postMerger === true && Boolean(resolved.province);
  // Vòng 12: tỉnh khách ghi khác tỉnh máy suy ra ("xã đất đỏ thành phố Hồ Chí Minh" → máy tìm thấy ở
  // Bà Rịa-Vũng Tàu cũ) hay khách ghi "phường" mà danh mục cũ là "xã": đơn vị đã đổi sau sáp nhập →
  // giữ nguyên chữ khách ghi, không đổi về Huyện Đất Đỏ, BR-VT / Xã Nam Sơn.
  const typedElsewhere = Boolean(resolved.typedProvince) || resolved.typeMismatch === true;
  const keepAsTyped = postMerger || typedElsewhere || (Boolean(resolved.province) && Boolean(resolved.ward) && !districtMentioned(text, resolved.district));
  const usableStreet = isUsableStreet(resolved.streetWithoutWard ?? resolved.street);
  // Vòng 12: có số nhà/đường + quận/huyện + tỉnh mà thiếu phường/xã (không mơ hồ): vẫn nhận, đơn mang
  // ghi chú để nhân viên bổ sung phường/xã ("ngách 143/300 phố Nguyễn Chính, Hoàng Mai, Hà Nội").
  // Chỉ địa chỉ phố có số nhà; "Xóm 3"/"Thôn 2"/"Ấp 1" thiếu xã thì shipper không tìm được → vẫn hỏi.
  const streetKey = normalizeLocationKey(resolved.street);
  const cityStreet = /\d/.test(streetKey) && !/^(?:xom|thon|ap|to|khu|ban|lang|kp|khu pho|doi|tdp|to dan pho)\s+\S+$/.test(streetKey)
    && !/^(?:xom|thon|ap|ban|lang|doi)\b/.test(streetKey);
  const wardUnverified = !resolved.ward && !postMerger && Boolean(resolved.province) && Boolean(resolved.district) && usableStreet && cityStreet && !resolved.ambiguous;
  if (!resolved.province) missing.push('province');
  if (!resolved.district && !sameNameDistricts && !postMerger) missing.push('district');
  if (!resolved.ward && !postMerger && !wardUnverified) missing.push('ward');
  if (!usableStreet) missing.push('street');
  const known = [resolved.ward?.name, resolved.district?.name, resolved.province?.name].filter(Boolean).join(', ');
  const choices = resolved.ambiguous && !sameNameDistricts && resolved.ambiguous.options.length > 1 && resolved.ambiguous.options.length <= 4
    ? { level: resolved.ambiguous.level, label: LEVEL_LABELS[resolved.ambiguous.level], options: resolved.ambiguous.options }
    : null;
  return {
    resolved,
    complete: missing.length === 0,
    missing,
    missingLabel: listInVietnamese(missing.map(level => LEVEL_LABELS[level])),
    known,
    choices,
    keepAsTyped,
    // Thiếu phường/xã nhưng vẫn nhận (đủ đường + quận + tỉnh): nhân viên bổ sung.
    wardUnverified,
    canonical: missing.length === 0 ? (keepAsTyped ? typedAddress(text, resolved, locationIndex) : formatResolvedAddress(resolved)) : ''
  };
}

/**
 * Địa chỉ giữ nguyên chữ khách ghi: gọn khoảng trắng/dấu phẩy, bỏ dấu chấm cuối; khách không ghi
 * tên tỉnh (máy suy ra từ quận: "…hiệp bình.thủ đức.") thì thêm tên tỉnh ở cuối cho kho/shipper.
 */
function typedAddress(text, resolved, locationIndex) {
  const typed = String(text || '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/[\s.,;]+$/u, '').trim();
  const province = resolved.typedProvince || resolved.province;
  if (!province?.name) return typed;
  const entry = locationIndex.provinces.find(item => item.code === province.code);
  const norm = normalizeLocationKey(expandAddressAbbreviations(typed));
  const mentioned = (entry?.aliases || [normalizeLocationKey(province.name)]).some(alias => alias && new RegExp(`(?<![a-z0-9])${escapeRegExp(alias)}(?![a-z0-9])`).test(norm));
  return mentioned ? typed : `${typed}, ${province.name}`;
}

/**
 * Ghép phần khách vừa nhắn thêm ("phường 5", "số 12 Lê Lợi", "Xã Hoằng Đông")
 * vào địa chỉ đã lưu. Khách nhắn hẳn một địa chỉ mới có tỉnh thì lấy địa chỉ
 * mới; còn lại thử vài cách ghép và giữ cách cho ra nhiều cấp nhất.
 */
export function mergeAddressFragment(fresh, saved, locationIndex = loadLocationIndex()) {
  const next = String(fresh ?? '').trim();
  const previous = String(saved ?? '').trim();
  if (!next) return previous;
  if (!previous || next === previous) return next;
  const own = resolveAddress(next, locationIndex);
  const old = resolveAddress(previous, locationIndex);
  // Khách chỉ bổ sung tên tỉnh ("thái nguyên") cho địa chỉ đã gửi mà chưa có tỉnh: ghép vào sau phần cũ,
  // không thay cả địa chỉ (28/09: "Xóm 3 Vô Tranh Phú Lương" + "thái nguyên" từng thành "thái nguyên").
  if (own.province && !own.district && !own.ward && !isUsableStreet(own.street) && !old.province) {
    const combined = `${previous}, ${next}`;
    const merged = resolveAddress(combined, locationIndex);
    if (merged.province && (merged.district || merged.ward || isUsableStreet(merged.street))) return combined;
  }
  // Phần khách đã viết mà chưa nhận ra được (ví dụ "Xa Hoang Dong" không dấu
  // khi có hai xã cùng tên) không được giữ lại, nếu không nó lại gây mơ hồ
  // ngay cả khi khách vừa chọn xong.
  const ambiguousKeys = (old.ambiguous?.options || []).map(name => stripPrefix(normalizeLocationKey(name), [...WARD_PREFIXES, ...DISTRICT_PREFIXES]));
  const keptStreet = String(old.streetWithoutWard ?? old.street ?? '').split(/\s*,\s*/).filter(part => {
    const key = normalizeLocationKey(part);
    return !ambiguousKeys.some(option => option && key.endsWith(option));
  }).join(', ');
  const oldStreet = isUsableStreet(keptStreet) ? keptStreet : '';
  const score = text => {
    const r = resolveAddress(text, locationIndex);
    return (r.province ? 1 : 0) + (r.district ? 1 : 0) + (r.ward || r.postMerger ? 1 : 0) + (isUsableStreet(r.street) ? 1 : 0) - (r.ambiguous ? 0.5 : 0);
  };
  const pickBest = candidates => {
    let best = candidates[0];
    let bestScore = score(best);
    for (const candidate of candidates.slice(1)) {
      const value = score(candidate);
      if (value > bestScore) { best = candidate; bestScore = value; }
    }
    return best;
  };
  if (own.province) {
    // Vòng 12 (NẶNG): khách bổ sung phường/quận/tỉnh ("Phường hải châu thành phố đà nẵng", "Quan Bình
    // Thạnh, tp, HCM nhé") cho địa chỉ đã có số nhà/đường ("83 hải phòng…", "Số13/112 ngõ 663 Trương
    // Định", "19A Huỳnh Đình Hai, P14"): phần mới không có số nhà/đường dùng được → giữ số nhà/đường cũ
    // + phần mới, thay vì thay cả địa chỉ (phiếu từng chỉ còn phường + tỉnh). Khác tỉnh = địa chỉ mới.
    if (!isUsableStreet(own.streetWithoutWard ?? own.street) && oldStreet &&(!old.province || sameNewProvince(old, own, locationIndex))) {
      // Phần mới chỉ là tên tỉnh: nối sau toàn bộ phần cũ. Phần mới có phường/quận: chỉ giữ số nhà/đường
      // cũ (phần cũ chưa đọc được thường lẫn tên tỉnh/phường viết liền, ghép cả vào là lặp).
      const appendAll = `${previous}, ${next}`;
      const keepStreet = [`${oldStreet}, ${next}`, [oldStreet, old.ward?.name, next].filter(Boolean).join(', ')];
      const lowerLevels = Boolean(own.district || own.ward || own.postMerger);
      return dedupeAddressSegments(pickBest(lowerLevels ? [...keepStreet, appendAll] : [appendAll, ...keepStreet]));
    }
    // fix-addr (01/10): mảnh KHÁC tỉnh, không số nhà/đường, không chữ phường/xã/quận/huyện/tỉnh, không tên tỉnh, không
    // phường — chỉ là một tên quận trơ trọi mà máy suy ra tỉnh ("Quà thay là gì ạ" → Thị xã La Gi) — không được thay
    // địa chỉ đã có số nhà: giữ địa chỉ cũ. Khách ghi rõ tỉnh/cấp hành chính thì vẫn là địa chỉ mới như trước.
    if (!/\d/.test(own.streetWithoutWard ?? own.street) && oldStreet && /\d/.test(oldStreet) && !own.ward && !own.postMerger) {
      const nextKey = normalizeLocationKey(expandAddressAbbreviations(next));
      const adminTyped = /(?<![a-z0-9])(?:phuong|xa|quan|huyen|tinh|thanh pho|thi tran|thi xa|tp|tx|tt|q|p|h)(?![a-z0-9])/.test(nextKey);
      const provinceEntry = locationIndex.provinces.find(item => item.code === own.province.code);
      const provinceTyped = (provinceEntry?.aliases || []).some(alias => alias && new RegExp(`(?<![a-z0-9])${escapeRegExp(alias)}(?![a-z0-9])`).test(nextKey));
      if (!adminTyped && !provinceTyped) return previous;
    }
    return next;
  }
  const candidates = [
    `${next}, ${previous}`,
    [oldStreet, next, old.ward?.name, old.district?.name, old.province?.name].filter(Boolean).join(', '),
    [oldStreet, next, old.district?.name, old.province?.name].filter(Boolean).join(', '),
    [next, old.district?.name, old.province?.name].filter(Boolean).join(', ')
  ];
  return pickBest(candidates);
}

/** Hai kết quả đọc địa chỉ cùng một tỉnh (kể cả tỉnh cũ đã nhập vào tỉnh mới kia). */
function sameNewProvince(a, b, locationIndex) {
  const codes = result => [result.province?.code, result.typedProvince?.code].filter(Boolean);
  const left = codes(a);
  const right = codes(b);
  if (left.some(code => right.includes(code))) return true;
  const keysOf = result => {
    const entry = locationIndex.provinces.find(item => item.code === result.province?.code);
    return newProvinceKeys(entry);
  };
  const leftKeys = keysOf(a);
  return keysOf(b).some(key => leftKeys.includes(key));
}

/**
 * Bỏ đoạn (giữa dấu phẩy) lặp lại sau khi ghép: trùng hẳn, hay nằm trọn trong một đoạn dài hơn
 * ("phường Hải châu" + "Phường hải châu thành phố đà nẵng"; "236 đường linh trung" lặp).
 */
export function dedupeAddressSegments(text) {
  const parts = String(text || '').split(/\s*,\s*/).map(part => part.trim()).filter(Boolean);
  const keys = parts.map(part => normalizeLocationKey(part));
  const contains = (outer, inner) => outer !== inner && inner.length >= 6 && ` ${outer} `.includes(` ${inner} `);
  return parts.filter((part, index) => {
    const key = keys[index];
    if (!key) return false;
    if (keys.indexOf(key) < index) return false;
    return !keys.some(other => contains(other, key));
  }).join(', ');
}
