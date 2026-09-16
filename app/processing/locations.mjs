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
  [/(?:sđt|sdt|đt|dt|phone|tel|zalo)\s*[:：]?\s*(?:\+?84|0)[\d\s.\-]{8,}/giu, ''],
  [/(?<![\d\/])(?:\+?84|0)\d{9}(?![\d\/])/gu, ''],
  [/[\s,]*(?:nhé|nhe|nha|nhá|ạ|với|giúp\s+em|giùm|dùm)\s*[.!]*\s*$/iu, ''],
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
  abbreviation('tp\\s*\\.?\\s*hcm|tphcm|hcmc|hcm|sai\\s*gon|sài\\s*gòn|sg', 'Thành phố Hồ Chí Minh'),
  abbreviation('hn', 'Hà Nội'),
  [new RegExp(`${B}t\\s*\\.\\s*p\\s*\\.?\\s*`, 'giu'), 'Thành phố '],
  abbreviation('pr\\s*-?\\s*tc|prtc', 'Phan Rang - Tháp Chàm'),
  abbreviation('brvt', 'Bà Rịa - Vũng Tàu'),
  abbreviation('dak\\s*lak|daklak|dac\\s*lac|đắc\\s*lắc|đăk\\s*lăk', 'Đắk Lắk'),
  abbreviation('dak\\s*nong|daknong|đăk\\s*nông', 'Đắk Nông'),
  [new RegExp(`${B}q\\s*\\.?\\s*(\\d{1,2})${E}`, 'giu'), 'Quận $1'],
  [new RegExp(`${B}p\\s*\\.?\\s*(\\d{1,2})${E}`, 'giu'), 'Phường $1'],
  [new RegExp(`${B}q\\s*\\.\\s*`, 'giu'), 'Quận '],
  [new RegExp(`${B}p\\s*\\.\\s*`, 'giu'), 'Phường '],
  [new RegExp(`${B}h\\s*\\.\\s*`, 'giu'), 'Huyện '],
  [new RegExp(`${B}x\\s*\\.\\s*`, 'giu'), 'Xã '],
  [new RegExp(`${B}tx\\s*\\.\\s*`, 'giu'), 'Thị xã '],
  [new RegExp(`${B}tt\\s*\\.\\s*`, 'giu'), 'Thị trấn '],
  [new RegExp(`${B}tp\\s*\\.\\s*`, 'giu'), 'Thành phố '],
  // "Phường 05" → "Phường 5" (chạy sau khi P./Q. đã được bung).
  [new RegExp(`${B}(quận|phường|quan|phuong)\\s+0(\\d)${E}`, 'giu'), '$1 $2']
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

export function buildLocationIndex(rows) {
  const provinces = new Map();
  for (const row of rows) {
    let province = provinces.get(row.province_code);
    if (!province) {
      province = { ...makeEntry(row.province_code, row.province, PROVINCE_PREFIXES, PROVINCE_ALIASES[stripPrefix(normalizeLocationKey(row.province), PROVINCE_PREFIXES)] || []), districts: new Map() };
      provinces.set(row.province_code, province);
    }
    let district = province.districts.get(row.district_code);
    if (!district) {
      district = { ...makeEntry(row.district_code, row.district, DISTRICT_PREFIXES), province, wards: new Map() };
      province.districts.set(row.district_code, district);
    }
    if (!district.wards.has(row.ward_code)) {
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
function findBest(norm, raw, entries, { limit = norm.length, ownPrefixes, neutralPrefixes = [], foreignPrefixes, fullKeys, typedWithDiacritics = hasDiacritics(raw) }) {
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
        // Cả đoạn là tên đầy đủ của một đơn vị khác ("xã tả thanh oai" khi đang
        // tìm huyện Thanh Oai, "xã hòa quang nam" khi đang tìm tỉnh Quảng Nam):
        // phần đuôi trùng tên chỉ là trùng hợp.
        if (fullKeys) {
          const segmentKey = normalizeLocationKey(segmentAround(region, start, end));
          if (fullKeys.has(segmentKey) && !entry.aliases.includes(segmentKey)) continue;
        }
        const prefixScore = selfPrefixed || (hasPrefix && prefix === entry.prefix) ? 2 : (hasPrefix ? 1 : 0);
        const rawSlice = raw.slice(start, end);
        const expectedRaw = entry.rawByAlias.get(alias) || '';
        const diacritics = expectedRaw && typedWithDiacritics ? (rawKey(rawSlice) === expectedRaw ? 1 : 0) : 0;
        const score = [prefixScore, end, alias.length, diacritics];
        const candidate = { entry, start: (hasPrefix || neutral) ? prefixed.start : start, end, score, prefixed: hasPrefix || selfPrefixed };
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

/** Sai chính tả nhẹ: 1 ký tự cho tên ≥5 ký tự, 2 ký tự cho tên ≥9 ký tự; chỉ nhận khi có đúng một tên tốt nhất. */
function fuzzyMatch(segments, entries, prefixes) {
  let best = null;
  let tie = false;
  for (const segment of segments) {
    const bare = stripPrefix(segment.key, prefixes);
    if (!bare || /^\d+$/.test(bare) || bare.length < 5) continue;
    const allowed = bare.length >= 9 ? 2 : 1;
    for (const entry of entries) {
      if (entry.numeric) continue;
      const distance = levenshtein(bare, entry.bare);
      if (distance > allowed) continue;
      if (!best || distance < best.distance) { best = { entry, segment, distance }; tie = false; }
      else if (distance === best.distance && entry !== best.entry) tie = true;
    }
  }
  return best && !tie ? best : null;
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
    // Bỏ mảnh rỗng và mảnh chỉ còn mỗi tiền tố loại hình ("Phường" của "Phường Ninh Bình?").
    .filter(part => /[\p{L}\p{N}]/u.test(part) && !ALL_PREFIXES.includes(normalizeLocationKey(part)))
    .join(', ');
}

/**
 * Đọc một địa chỉ tự do và trả về ba cấp chuẩn cùng phần đường phố còn lại.
 * `confidence`: 'exact' đủ ba cấp khớp trực tiếp; 'fuzzy' có cấp phải sửa
 * chính tả; 'partial' thiếu cấp; 'none' không nhận ra gì.
 * `ambiguous`: cấp còn thiếu vì có nhiều tên cùng khớp — kèm danh sách tên
 * để bot hỏi khách chọn.
 */
export function resolveAddress(text, locationIndex = loadLocationIndex()) {
  const expanded = expandAddressAbbreviations(text);
  const norm = normalizeAligned(expanded);
  const result = { province: null, district: null, ward: null, street: '', confidence: 'none', fuzzy: false, ambiguous: null };
  if (!normalizeLocationKey(norm)) return result;
  result.street = remainingStreet(expanded, norm, []);
  const segments = segmentsOf(expanded, norm);
  const consumed = [];
  const { fullKeys } = locationIndex;
  const finish = () => {
    result.street = remainingStreet(expanded, norm, consumed);
    result.confidence = !result.province || !result.district || !result.ward ? (result.province ? 'partial' : 'none') : (result.fuzzy ? 'fuzzy' : 'exact');
    return result;
  };
  const markAmbiguous = (level, hit) => {
    result.ambiguous = { level, options: hit.ambiguous.map(entry => entry.name) };
  };

  // 1. Tỉnh/thành: lấy lần xuất hiện sau cùng, vì khách viết từ nhỏ đến lớn.
  let provinceHit = findBest(norm, expanded, locationIndex.provinces, {
    ownPrefixes: ['tinh'],
    neutralPrefixes: ['thanh pho', 'tp'],
    foreignPrefixes: [...DISTRICT_PREFIXES.filter(p => !PROVINCE_PREFIXES.includes(p)), ...WARD_PREFIXES],
    fullKeys
  });
  if (provinceHit?.ambiguous) { markAmbiguous('province', provinceHit); return finish(); }
  let province = provinceHit?.entry || null;
  let districtHit = null;
  let district = null;

  let wardHit = null;
  let ward = null;
  const wardSearchOptions = extra => ({ ownPrefixes: WARD_PREFIXES, foreignPrefixes: DISTRICT_PREFIXES.filter(p => !WARD_PREFIXES.includes(p)), fullKeys, ...extra });

  // 2. Không thấy tỉnh: quận/huyện có tên duy nhất trên cả nước cho biết tỉnh.
  if (!province) {
    const national = findBest(norm, expanded, locationIndex.districts, { ownPrefixes: DISTRICT_PREFIXES, foreignPrefixes: WARD_PREFIXES, fullKeys });
    if (national && !national.ambiguous) {
      const alias = normalizeLocationKey(norm.slice(national.start, national.end));
      const sameName = locationIndex.districtsByKey.get(alias) || locationIndex.districtsByKey.get(stripPrefix(alias, DISTRICT_PREFIXES)) || [];
      const exactSegment = segments.some(segment => stripPrefix(segment.key, DISTRICT_PREFIXES) === national.entry.bare || segment.key === national.entry.key);
      // Không có chữ "huyện" và không đứng riêng đoạn ("ấp 2 xã Tân Hiệp Hóc Môn"):
      // vẫn tin khi ngay trước đó khách ghi rõ "xã/phường …" thuộc đúng huyện ấy.
      const confirming = sameName.length === 1 && !national.prefixed && !exactSegment
        ? findBest(norm, expanded, [...national.entry.wards.values()], wardSearchOptions({ limit: national.start }))
        : null;
      const confirmed = Boolean(confirming && confirming.prefixed && !confirming.ambiguous);
      if (sameName.length === 1 && (national.prefixed || exactSegment || confirmed)) {
        districtHit = national;
        district = national.entry;
        province = district.province;
        if (confirmed) { wardHit = confirming; ward = confirming.entry; }
      }
    }
  }
  if (!province) {
    const fuzzy = fuzzyMatch(segments, locationIndex.provinces, PROVINCE_PREFIXES);
    if (fuzzy) { province = fuzzy.entry; provinceHit = { start: fuzzy.segment.start, end: fuzzy.segment.end }; result.fuzzy = true; }
  }
  if (!province) return finish();
  result.province = { code: province.code, name: province.name };
  if (provinceHit) consumed.push(provinceHit);

  // 3. Quận/huyện trong tỉnh, tìm ở phần đứng trước tỉnh.
  const districts = [...province.districts.values()];
  const districtLimit = provinceHit ? provinceHit.start : norm.length;
  if (!district) {
    const districtOptions = { limit: districtLimit, ownPrefixes: DISTRICT_PREFIXES, foreignPrefixes: WARD_PREFIXES, fullKeys };
    districtHit = findBest(norm, expanded, districts, districtOptions);
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
      const wardOptions = { limit: districtHit.start, ownPrefixes: WARD_PREFIXES, foreignPrefixes: DISTRICT_PREFIXES.filter(p => !WARD_PREFIXES.includes(p)), fullKeys };
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
      fullKeys
    });
    // Chỉ tin phường/xã khi khách ghi rõ loại hình hoặc tên đứng riêng một
    // đoạn: "Số 8 Lê Lợi" là tên đường, không phải Phường Lê Lợi ở huyện khác.
    const exactSegment = hit && segments.some(segment => stripPrefix(segment.key, WARD_PREFIXES) === hit.entry.bare || segment.key === hit.entry.key);
    if (hit && (hit.prefixed || exactSegment)) {
      const owners = new Set((hit.ambiguous || [hit.entry]).map(entry => entry.district));
      if (owners.size === 1 && !hit.ambiguous) { wardHit = hit; ward = hit.entry; district = ward.district; }
      else if (owners.size === 1) { district = [...owners][0]; markAmbiguous('ward', hit); }
      else markAmbiguous('district', { ambiguous: [...owners] });
    }
  }
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
      province = hit.province;
      result.province = { code: province.code, name: province.name };
      district = hit.district;
      districtHit = hit.districtHit || null;
      if (hit.ward) { ward = hit.ward; wardHit = hit.wardHit; }
    }
  }
  if (!district && !result.ambiguous) {
    const fuzzy = fuzzyMatch(segments.filter(segment => segment.start < districtLimit), districts, DISTRICT_PREFIXES);
    if (fuzzy) { district = fuzzy.entry; districtHit = { start: fuzzy.segment.start, end: fuzzy.segment.end }; result.fuzzy = true; }
  }
  if (!district) return finish();
  result.district = { code: district.code, name: district.name };
  if (districtHit) consumed.push(districtHit);
  if (result.ambiguous) return finish();

  // 5. Phường/xã trong quận, ở phần đứng trước quận.
  const wards = [...district.wards.values()];
  if (!ward) {
    const limit = districtHit ? districtHit.start : districtLimit;
    wardHit = findBest(norm, expanded, wards, { limit, ownPrefixes: WARD_PREFIXES, foreignPrefixes: DISTRICT_PREFIXES.filter(p => !WARD_PREFIXES.includes(p)), fullKeys });
    if (wardHit?.ambiguous) { consumed.push(wardHit); markAmbiguous('ward', wardHit); return finish(); }
    ward = wardHit?.entry || null;
    if (!ward) {
      const fuzzy = fuzzyMatch(segments.filter(segment => segment.start < limit), wards, WARD_PREFIXES);
      if (fuzzy) { ward = fuzzy.entry; wardHit = { start: fuzzy.segment.start, end: fuzzy.segment.end }; result.fuzzy = true; }
    }
  }
  if (ward) {
    result.ward = { code: ward.code, name: ward.name };
    if (wardHit) consumed.push(wardHit);
  }
  return finish();
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
export function resolvedAddressFields(address, locationIndex = loadLocationIndex()) {
  const location = resolveAddress(address, locationIndex);
  return {
    address,
    street: location.street,
    province: location.province?.name || '',
    district: location.district?.name || '',
    ward: location.ward?.name || '',
    locationConfidence: location.confidence
  };
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
  const resolved = resolveAddress(text, locationIndex);
  const missing = [];
  // Quận/huyện chỉ mơ hồ giữa hai loại hình cùng tên ("Quận Thủ Đức" / "Thành
  // phố Thủ Đức"): hỏi khách chọn giữa hai cái tên đó chỉ gây khó hiểu; xin
  // phường/xã thì tự phân định được.
  const sameNameDistricts = resolved.ambiguous?.level === 'district'
    && new Set(resolved.ambiguous.options.map(name => stripPrefix(normalizeLocationKey(name), DISTRICT_PREFIXES))).size === 1;
  if (!resolved.province) missing.push('province');
  if (!resolved.district && !sameNameDistricts) missing.push('district');
  if (!resolved.ward) missing.push('ward');
  const usableStreet = isUsableStreet(resolved.street);
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
    canonical: missing.length === 0 ? formatResolvedAddress(resolved) : ''
  };
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
  if (own.province) return next;
  const old = resolveAddress(previous, locationIndex);
  // Phần khách đã viết mà chưa nhận ra được (ví dụ "Xa Hoang Dong" không dấu
  // khi có hai xã cùng tên) không được giữ lại, nếu không nó lại gây mơ hồ
  // ngay cả khi khách vừa chọn xong.
  const ambiguousKeys = (old.ambiguous?.options || []).map(name => stripPrefix(normalizeLocationKey(name), [...WARD_PREFIXES, ...DISTRICT_PREFIXES]));
  const keptStreet = String(old.street || '').split(/\s*,\s*/).filter(part => {
    const key = normalizeLocationKey(part);
    return !ambiguousKeys.some(option => option && key.endsWith(option));
  }).join(', ');
  const oldStreet = isUsableStreet(keptStreet) ? keptStreet : '';
  const candidates = [
    `${next}, ${previous}`,
    [oldStreet, next, old.ward?.name, old.district?.name, old.province?.name].filter(Boolean).join(', '),
    [oldStreet, next, old.district?.name, old.province?.name].filter(Boolean).join(', '),
    [next, old.district?.name, old.province?.name].filter(Boolean).join(', ')
  ];
  const score = text => {
    const r = resolveAddress(text, locationIndex);
    return (r.province ? 1 : 0) + (r.district ? 1 : 0) + (r.ward ? 1 : 0) + (isUsableStreet(r.street) ? 1 : 0) - (r.ambiguous ? 0.5 : 0);
  };
  let best = candidates[0];
  let bestScore = score(best);
  for (const candidate of candidates.slice(1)) {
    const value = score(candidate);
    if (value > bestScore) { best = candidate; bestScore = value; }
  }
  return best;
}
