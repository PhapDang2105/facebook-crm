// Suy luận địa chỉ bằng AI cho những địa chỉ bộ đọc luật (locations.mjs)
// không tách đủ ba cấp: tên cũ ("dalat"), viết dính ("Tp Thủ Đức"), gõ lỗi
// ("diichj vọng"), khu dân cư/đường mà danh mục không có. Gemini trên Vertex
// (cùng cấu hình với chatbot) được hỏi kèm tra cứu Google Search, nhưng câu
// trả lời chỉ được nhận khi ghép lại thành địa chỉ mà bộ đọc luật khớp đúng
// ba cấp trong danh mục kho — mô hình không bao giờ tự đặt ra một phường mới.
// Địa chỉ mâu thuẫn hay thiếu thông tin thì trả về null để bot hỏi lại khách.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../config.mjs';
import { getVertexAccessToken, vertexProjectId } from '../vertex-auth.mjs';
import { describeDeliveryAddress, expandAddressAbbreviations, isUsableStreet, loadLocationIndex, lostHouseNumbers, newWardMentioned, normalizeLocationKey, resolveAddress, streetForDisplay } from './locations.mjs';

// R13 (K12): phiên bản quy tắc suy luận nằm trong khoá cache. Kết quả sinh bằng prompt/phép kiểm CŨ (phường tự suy gắn
// "high", quy đổi đơn vị mới về cũ) không được dùng lại: đổi prompt hay phép kiểm thì tăng phiên bản này.
export const ADDRESS_AI_CACHE_VERSION = 'r13';
const cacheKeySuffix = `|v:${ADDRESS_AI_CACHE_VERSION}`;

const cachePath = process.env.ADDRESS_AI_CACHE_PATH || path.join(projectRoot, 'data', 'processed', 'address-ai-cache.json');
const maximumCacheEntries = 5000;
// Tra cứu Google Search có lúc mất hơn 20 giây: đơn landing (chạy nền) đợi được,
// còn chatbot đang có khách chờ thì chỉ đợi ngắn rồi hỏi lại khách như thường.
const defaultTimeoutMs = 45000;
export const chatTimeoutMs = 15000;

let dependencies = { readSettings: async () => null, fetchImpl: fetch };

/** server.mjs gọi một lần lúc khởi động để module đọc được cấu hình chatbot (endpoint, model, khoá). */
export function configureAddressAi(overrides = {}) {
  dependencies = { ...dependencies, ...overrides };
}

let cache = null;
let cacheWrite = Promise.resolve();

async function readCache() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8'));
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

// Cắt bớt NGAY TRÊN đối tượng cache đang dùng (không gán đối tượng mới): lượt tra khác đang
// chờ mô hình vẫn ghi kết quả vào đúng cache sẽ được lưu, không bị mất.
function scheduleCacheWrite() {
  cacheWrite = cacheWrite.then(async () => {
    const current = cache;
    if (!current) return;
    // Mục của phiên bản cũ (khoá không mang phiên bản hiện tại) không còn được đọc: bỏ khỏi tệp.
    for (const key of Object.keys(current)) if (!key.endsWith(cacheKeySuffix)) delete current[key];
    const keys = Object.keys(current);
    if (keys.length > maximumCacheEntries) {
      keys.sort((a, b) => (current[b].at || 0) - (current[a].at || 0));
      for (const key of keys.slice(maximumCacheEntries)) delete current[key];
    }
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(current, null, 2));
  }).catch(() => {});
  return cacheWrite;
}

/** Chỉ dùng trong kiểm thử: quên cache đang giữ trong bộ nhớ. */
export function resetAddressAiCache() {
  cache = null;
}

export function addressAiEnabled(settings) {
  return Boolean(settings) && settings.addressAi !== false && settings.provider === 'vertex';
}

// Phần bộ đọc luật đã nhận ra được kể cho mô hình để nó không đổi tỉnh/quận
// đã chắc, chỉ điền phần còn thiếu.
export function addressHint(raw) {
  const resolved = resolveAddress(raw);
  const known = [
    resolved.province ? `tỉnh/thành: ${resolved.province.name}` : '',
    resolved.district ? `quận/huyện: ${resolved.district.name}` : '',
    resolved.ward ? `phường/xã: ${resolved.ward.name}` : ''
  ].filter(Boolean);
  const ambiguous = resolved.ambiguous ? `Trùng tên ở cấp ${resolved.ambiguous.level}: ${resolved.ambiguous.options.join(' / ')}.` : '';
  return { resolved, text: [known.length ? `Bộ đọc đã nhận ra ${known.join(', ')}.` : 'Bộ đọc chưa nhận ra tỉnh/thành.', ambiguous].filter(Boolean).join(' ') };
}

export const addressAiSystemPrompt = [
  // R13 (K12): câu mở đầu từng ghi "Kho dùng… BA CẤP… TRƯỚC đợt sáp nhập… Không dùng tên tỉnh mới, không bỏ cấp quận/huyện" —
  // kéo ngược quy tắc "không quy đổi đơn vị mới về cũ" ở dưới (17 ca quy đổi, có ca sai hẳn nơi). Nay nói rõ hai kiểu.
  'Bạn chuẩn hoá địa chỉ giao hàng tại Việt Nam cho kho vận. Khách ghi địa chỉ theo một trong hai kiểu, KHÔNG được đổi kiểu này sang kiểu kia: (1) kiểu CŨ ba cấp, trước đợt sáp nhập 1/7/2025 — 63 tỉnh/thành phố; quận/huyện/thị xã/thành phố thuộc tỉnh; phường/xã/thị trấn — danh mục của kho chỉ có kiểu này; (2) kiểu MỚI hai cấp từ 1/7/2025 — phường/xã mới + tỉnh/thành mới, không có quận/huyện. Địa chỉ kiểu cũ thì điền đủ ba cấp theo danh mục cũ (không dùng tên tỉnh mới, không bỏ cấp quận/huyện). Địa chỉ kiểu mới thì giữ nguyên như khách ghi, theo quy tắc ở cuối.',
  'Nhiệm vụ: từ địa chỉ khách gõ (có thể viết tắt, thiếu dấu, sai chính tả, dùng tên cũ, ghi khu đô thị/đường/địa danh thay cho phường), xác định đúng phường/xã, quận/huyện, tỉnh/thành mà địa chỉ đó thuộc về. Nếu được tra cứu Google Search, hãy tra để biết đường, khu dân cư, địa danh nằm ở phường/quận nào.',
  'Trả về DUY NHẤT một JSON, không markdown, không giải thích ngoài JSON:',
  '{"province":"tên đầy đủ có loại hình, ví dụ Thành phố Hồ Chí Minh / Tỉnh Lâm Đồng","district":"ví dụ Quận 1 / Thành phố Đà Lạt / Huyện Chợ Đồn","ward":"ví dụ Phường Bến Nghé / Xã Hoằng Đông / Thị trấn Chợ Đồn","street":"số nhà, ngõ, tên đường, thôn/ấp còn lại (không lặp lại ba cấp)","confidence":"high|low","ambiguous":false,"reason":"một câu ngắn tiếng Việt giải thích căn cứ"}',
  // R13 (K12): phường/xã suy từ tên đường/địa danh (không có trong chữ khách) chỉ là GỢI Ý cho nhân viên.
  'Khách không ghi phường/xã mà bạn chỉ suy ra được từ tên đường, khu dân cư hay địa danh: vẫn điền "ward" nhưng đặt confidence="low" và ghi trong "reason" căn cứ suy ra (ví dụ "phường suy từ tên đường"). Không chọn bừa một phường khi tên đường chạy qua nhiều phường.',
  'Quy tắc: không bịa. Địa chỉ ghi hai tỉnh khác nhau, hoặc không đủ thông tin để biết phường/xã, thì đặt ambiguous=true và để trống cấp không chắc. Giữ nguyên tỉnh/quận mà bộ đọc đã nhận ra, chỉ điền cấp còn thiếu. Tên cũ trước 2025 (ví dụ Quận 2, Quận 9 thuộc Thành phố Thủ Đức; Hà Tây thuộc Hà Nội) ghi theo danh mục hiện hành trước 2025 (Thành phố Thủ Đức).',
  // fix-addr (01/10): quy tắc chủ shop — địa chỉ sau sáp nhập giữ nguyên như khách ghi; AI chỉ điền cấp hành chính.
  'Địa chỉ khách ghi theo đơn vị MỚI từ 1/7/2025 (phường/xã mới + tỉnh/thành mới, không ghi quận/huyện, ví dụ "phường Chánh Hưng", "phường Trấn Biên, Đồng Nai"): KHÔNG quy đổi về phường/quận cũ. Chỉ điền "province" (tỉnh/thành chứa phường/xã mới đó), để trống "ward" và "district", ghi reason "địa chỉ sau sáp nhập".',
  '"street" chép đúng phần số nhà, ngõ, tên đường, thôn/ấp khách đã gõ: không thêm, bỏ hay đổi số nhà; không thay số nhà bằng địa danh/mốc gần đó.'
].join('\n');

export function buildAddressQuery(raw, hint) {
  return `Địa chỉ khách gõ: "${String(raw).trim()}"\n${hint}`;
}

export function parseAddressAnswer(answer) {
  const raw = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function vertexEndpoint(settings) {
  const configured = String(settings.directEndpoint || '');
  const model = settings.directModel || 'gemini-2.5-flash';
  return (configured.includes('PROJECT_ID') ? configured.replace('PROJECT_ID', encodeURIComponent(vertexProjectId())) : configured)
    .replace(/\/models\/[^/:]+:generateContent(?:\?.*)?$/, `/models/${encodeURIComponent(model)}:generateContent`);
}

/** Gọi Gemini trên Vertex; trả về chữ mô hình viết và các trang web đã tra (nếu có). */
export async function requestAddressGuess({ raw, hint, settings, fetchImpl = dependencies.fetchImpl, timeoutMs = defaultTimeoutMs }) {
  const useApiKey = settings.directAuthType === 'api_key';
  if (useApiKey && !settings.directApiKey) throw new Error('Chatbot chưa có khoá API Vertex.');
  const accessToken = useApiKey ? '' : (settings.directApiKey || await getVertexAccessToken({ fetchImpl }));
  const body = {
    systemInstruction: { parts: [{ text: addressAiSystemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: buildAddressQuery(raw, hint) }] }],
    // Chế độ JSON không đi cùng công cụ tra cứu, nên JSON được cắt ra từ chữ mô hình trả về.
    ...(settings.addressAiSearch !== false ? { tools: [{ googleSearch: {} }] } : {}),
    generationConfig: { temperature: 0 }
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(vertexEndpoint(settings), {
      method: 'POST',
      headers: {
        ...(useApiKey ? { 'x-goog-api-key': settings.directApiKey } : { Authorization: `Bearer ${accessToken}` }),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Vertex trả về lỗi ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    const candidate = payload?.candidates?.[0];
    const answer = candidate?.content?.parts?.map(part => part.text || '').join('').trim() || '';
    const sources = (candidate?.groundingMetadata?.groundingChunks || [])
      .map(chunk => chunk?.web?.uri || '')
      .filter(Boolean)
      .slice(0, 5);
    return { answer, sources };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kiểm tra câu trả lời của mô hình bằng chính bộ đọc luật: ghép bốn phần
 * thành một địa chỉ, đọc lại, và chỉ nhận khi ra đúng ba cấp trong danh mục,
 * không trùng tên, không đổi tỉnh/quận mà bộ đọc đã chắc từ trước.
 */
export function validateAddressGuess(guess, raw, hint = addressHint(raw)) {
  if (!guess || guess.ambiguous === true) return { ok: false, reason: 'mô hình báo địa chỉ mơ hồ' };
  const parts = ['street', 'ward', 'district', 'province'].map(key => String(guess[key] ?? '').trim());
  const [street, ward, district, province] = parts;
  const known = hint.resolved;
  // fix-addr (01/10): địa chỉ khách ghi theo đơn vị mới (tên phường/xã mới của tỉnh): giữ nguyên chữ khách, AI chỉ được
  // bổ sung tên tỉnh ("332 ta quang Bửu phường chánh hưng" → "…, TP Hồ Chí Minh"), không quy đổi về Phường 5, Quận 8.
  const typedNew = known.postMerger ? null : newAddressAnswer(raw, province, known, district);
  if (typedNew) return typedNew;
  if (!ward || !district || !province) return { ok: false, reason: 'mô hình không điền đủ ba cấp' };
  const resolved = resolveAddress(parts.filter(Boolean).join(', '));
  if (!resolved.province || !resolved.district || !resolved.ward || resolved.ambiguous) return { ok: false, reason: 'ba cấp không khớp danh mục kho' };
  if (known.province && known.province.code !== resolved.province.code) return { ok: false, reason: 'mô hình đổi tỉnh đã nhận ra' };
  if (known.district && known.district.code !== resolved.district.code) return { ok: false, reason: 'mô hình đổi quận/huyện đã nhận ra' };
  if (known.ward && known.ward.code !== resolved.ward.code) return { ok: false, reason: 'mô hình đổi phường/xã đã nhận ra' };
  // Bộ đọc đã coi là địa chỉ sau sáp nhập (phường/xã mới): không quy đổi về phường/quận cũ.
  if (known.postMerger) return { ok: false, reason: 'địa chỉ sau sáp nhập: giữ nguyên chữ khách' };
  // fix-addr (01/10): phần đường LUÔN lấy chữ khách gõ (phần bộ đọc để lại, bỏ đoạn chỉ là tên phường); AI chỉ điền
  // cấp hành chính. Chỉ khi khách không gõ đường/số nhà mới dùng phần đường của mô hình.
  const typedStreet = String(known.streetWithoutWard ?? known.street ?? '').trim();
  // Bỏ tên cấp hành chính còn dính cuối phần đường (bộ đọc không nhận ra nên để lại: "12 Lê Lợi, Nguyễn Thái Bình").
  const trimmedStreet = typedStreet ? streetForDisplay(typedStreet, { province: resolved.province.name, district: resolved.district.name, ward: resolved.ward.name }) : '';
  const fromText = isUsableStreet(trimmedStreet) ? trimmedStreet : (isUsableStreet(typedStreet) ? typedStreet : '');
  const finalStreet = fromText || (isUsableStreet(resolved.street) ? resolved.street : street);
  const canonical = [finalStreet, resolved.ward.name, resolved.district.name, resolved.province.name].filter(Boolean).join(', ');
  // Phần đường của mô hình có số nhà không có trong chữ khách (ví dụ địa chỉ một cửa hàng): vẫn nhận nhưng đánh dấu để
  // nhân viên đối chiếu trước khi giao (khách chỉ ghi "phường chánh hưng" mà mô hình thêm "332 …").
  const streetInvented = !fromText && /\d/.test(finalStreet) && lostHouseNumbers(finalStreet, raw).length > 0;
  // Độ tin "high" chỉ khi phường/xã AI trả có trong chữ khách (so bỏ dấu) hay trùng phường bộ đọc đã nhận ra: phường
  // bịa ra (cùng quận, có trong danh mục) từng được nhận "high" 20/20 ca đo giả lập.
  // R13 (K12): cũng tính là "có trong chữ khách" khi kiểm được bằng danh mục — khách đã ghi quận/huyện và trong quận đó
  // chỉ đúng MỘT phường/xã có tên gần trùng một cụm khách gõ (gõ lỗi, viết dính, i/y) và đó chính là phường AI trả.
  const wardInText = Boolean(known.ward) || wardNameInText(resolved.ward.name, raw) || wardCheckedByCatalog(resolved, known, raw);
  return { ok: true, canonical, street: finalStreet, ward: resolved.ward.name, district: resolved.district.name, province: resolved.province.name, streetInvented, wardInText };
}

/**
 * R13 (K12): khách đã ghi quận/huyện (bộ đọc nhận ra) và trong quận đó chỉ đúng một phường/xã có tên gần trùng một cụm
 * khách gõ — sai 1 ký tự (2 với tên ≥ 9 ký tự), viết dính, khác i/y — và đó là phường mô hình trả. Phường số không tính.
 */
function wardCheckedByCatalog(resolved, known, raw) {
  if (!known.district || known.district.code !== resolved.district.code) return false;
  const index = loadLocationIndex();
  const district = index.districts.find(entry => entry.code === resolved.district.code && entry.province.code === resolved.province.code);
  if (!district) return false;
  // Chỉ xét phần đường phố bộ đọc để lại (đã bỏ tên quận/tỉnh): "phù CÁT BÌNH định" không phải "Cát Minh" gõ lỗi.
  const words = normalizeLocationKey(known.streetWithoutWard ?? known.street ?? '').split(' ').filter(Boolean);
  const compact = value => value.replace(/ /g, '').replace(/y/g, 'i');
  const near = entry => {
    if (entry.numeric || entry.bare.length < 5) return false;
    const target = compact(entry.bare);
    const allowed = target.length >= 9 ? 2 : 1;
    const size = entry.bare.split(' ').length;
    // Cụm cùng số chữ với tên, hoặc một chữ viết dính ("tanmai").
    for (const count of new Set([size, 1])) {
      for (let i = 0; i + count <= words.length; i += 1) {
        const window = compact(words.slice(i, i + count).join(' '));
        if (Math.abs(window.length - target.length) <= allowed && editDistance(window, target) <= allowed) return true;
      }
    }
    return false;
  };
  const matches = [...district.wards.values()].filter(near);
  return matches.length === 1 && matches[0].code === resolved.ward.code;
}

function editDistance(a, b) {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}

/** Tên phường/xã (bỏ loại hình, trừ phường số) có trong chữ khách gõ không, so bỏ dấu. */
function wardNameInText(name, raw) {
  const text = normalizeLocationKey(expandAddressAbbreviations(raw));
  const key = normalizeLocationKey(name);
  const bare = key.replace(/^(?:thi tran|thi xa|thanh pho|phuong|xa|quan|huyen)\s+/, '');
  const wanted = /^\d+$/.test(bare) ? key : bare;
  return new RegExp(`(?<![a-z0-9])${wanted.replace(/ /g, '\\s+')}(?![a-z0-9])`).test(text);
}

/**
 * Chữ khách có tên phường/xã MỚI của tỉnh (tỉnh khách ghi, hay tỉnh mô hình trả khi khách không ghi) và khách không ghi
 * quận/huyện: nhận nguyên chữ khách + tên tỉnh, không phường/quận cũ. null khi không phải trường hợp này.
 */
function newAddressAnswer(raw, provinceName, known, modelDistrict = '') {
  if (known.district) return null;
  const index = loadLocationIndex();
  const fromModel = provinceName ? resolveAddress(provinceName).province : null;
  const code = known.typedProvince?.code || known.province?.code || fromModel?.code;
  const entry = code ? index.provinces.find(item => item.code === code) : null;
  if (!entry || (known.province && fromModel && fromModel.code !== known.province.code && fromModel.code !== known.typedProvince?.code)) return null;
  // Chỉ khi khách ghi rõ "phường/xã + tên mới" và không ghi quận/huyện cũ mô hình trả ("bồ đề long biên" là địa chỉ cũ).
  if (!newWardMentioned(raw, entry, { typedOnly: true })) return null;
  if (modelDistrict && wardNameInText(modelDistrict, raw)) return null;
  const typed = String(raw || '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/[\s.,;]+$/u, '').trim();
  const canonical = resolveAddress(typed).province ? typed : `${typed}, ${entry.name}`;
  const street = String(known.streetWithoutWard ?? known.street ?? '').trim();
  return { ok: true, postMerger: true, canonical, street, ward: '', district: '', province: entry.name, streetInvented: false, wardInText: true };
}

/**
 * Suy luận một địa chỉ. Trả về null khi tắt tính năng, không dùng Vertex, địa
 * chỉ đã đủ, hoặc mô hình không đưa ra được câu trả lời khớp danh mục. Kết quả
 * (kể cả null) được nhớ theo địa chỉ gốc để cùng chuỗi không hỏi lại.
 */
export async function inferAddress(raw, options = {}) {
  const text = String(raw || '').trim();
  if (!text || /^chưa có địa chỉ$/i.test(text)) return null;
  const settings = options.settings || await dependencies.readSettings();
  if (!addressAiEnabled(settings)) return null;
  // fix-addr (01/10): `allowWardUnverified` — địa chỉ luật đã nhận (đủ đường + quận + tỉnh) nhưng thiếu phường/xã: vẫn hỏi
  // AI để gợi ý phường. Chỉ landing dùng (chạy nền, đơn vào Xử lý dữ liệu); chatbot không (khách đang chờ, thêm ~15 giây).
  const described = describeDeliveryAddress(text);
  if (described.complete && !(options.allowWardUnverified === true && described.wardUnverified)) return null;
  const hint = addressHint(text);
  const key = `${normalizeLocationKey(text)}|${settings.addressAiSearch !== false ? 's' : 'n'}${cacheKeySuffix}`;
  const store = await readCache();
  if (options.force !== true && key in store) return store[key].result;
  // Hỏi mô hình mất tới hàng chục giây: ghi kết quả vào cache đọc lại SAU khi chờ (cache có thể
  // đã được nạp/đặt lại trong lúc đó), không vào `store` cũ.
  const remember = async entry => {
    (await readCache())[key] = entry;
    scheduleCacheWrite();
  };
  let result = null;
  try {
    const { answer, sources } = await requestAddressGuess({ raw: text, hint: hint.text, settings, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
    const guess = parseAddressAnswer(answer);
    const checked = validateAddressGuess(guess, text, hint);
    if (checked.ok && !checked.postMerger && !checked.wardInText) {
      // R13 (K12): phường/xã mô hình tự suy (không có trong chữ khách, không kiểm được bằng danh mục) — 21 ngày: 84/171
      // kết quả, khoảng 1/10 bị nhân viên đổi phường trên POS. KHÔNG tự điền vào đơn: `canonical` rỗng (nơi gọi chỉ
      // điền khi có canonical), kết quả mang `suggestion` để ghi gợi ý cho nhân viên đối chiếu.
      result = {
        canonical: '',
        street: checked.street,
        ward: '',
        district: '',
        province: '',
        suggestOnly: true,
        suggestion: { canonical: checked.canonical, ward: checked.ward, district: checked.district, province: checked.province },
        reason: `Gợi ý (AI tự suy, chưa kiểm được): ${checked.ward}, ${checked.district}${guess.reason ? ` — ${String(guess.reason).trim()}` : ''}`.slice(0, 300),
        confidence: 'low',
        sources,
        model: settings.directModel || ''
      };
    } else if (checked.ok) {
      result = {
        canonical: checked.canonical,
        street: checked.street,
        ward: checked.ward,
        district: checked.district,
        province: checked.province,
        reason: String(guess.reason || '').trim().slice(0, 300),
        // fix-addr (01/10): "high" chỉ khi phường có trong chữ khách (hay bộ đọc đã nhận ra) và không tự thêm số nhà.
        confidence: guess.confidence === 'low' || checked.streetInvented || !checked.wardInText ? 'low' : 'high',
        ...(checked.postMerger ? { postMerger: true } : {}),
        sources,
        model: settings.directModel || ''
      };
    } else if (options.explain) {
      result = null;
      await remember({ at: Date.now(), result, rejected: checked.reason, guess });
      return { rejected: checked.reason, guess, sources };
    }
  } catch (error) {
    // Lỗi mạng/hạn mức thì không nhớ, để lần sau thử lại.
    if (options.explain) return { error: error.message };
    return null;
  }
  await remember({ at: Date.now(), result });
  return result;
}

/** Đợi cache ghi xong (dùng trong script và kiểm thử). */
export function flushAddressAiCache() {
  return cacheWrite;
}
