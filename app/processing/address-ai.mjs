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
import { describeDeliveryAddress, isUsableStreet, normalizeLocationKey, resolveAddress } from './locations.mjs';

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

function scheduleCacheWrite() {
  cacheWrite = cacheWrite.then(async () => {
    const entries = Object.entries(cache).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, maximumCacheEntries);
    cache = Object.fromEntries(entries);
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(cache, null, 2));
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
  'Bạn chuẩn hoá địa chỉ giao hàng tại Việt Nam cho kho vận. Kho dùng đơn vị hành chính BA CẤP theo danh mục TRƯỚC đợt sáp nhập năm 2025: 63 tỉnh/thành phố; quận/huyện/thị xã/thành phố thuộc tỉnh; phường/xã/thị trấn. Không dùng tên tỉnh mới sau sáp nhập, không bỏ cấp quận/huyện.',
  'Nhiệm vụ: từ địa chỉ khách gõ (có thể viết tắt, thiếu dấu, sai chính tả, dùng tên cũ, ghi khu đô thị/đường/địa danh thay cho phường), xác định đúng phường/xã, quận/huyện, tỉnh/thành mà địa chỉ đó thuộc về. Nếu được tra cứu Google Search, hãy tra để biết đường, khu dân cư, địa danh nằm ở phường/quận nào.',
  'Trả về DUY NHẤT một JSON, không markdown, không giải thích ngoài JSON:',
  '{"province":"tên đầy đủ có loại hình, ví dụ Thành phố Hồ Chí Minh / Tỉnh Lâm Đồng","district":"ví dụ Quận 1 / Thành phố Đà Lạt / Huyện Chợ Đồn","ward":"ví dụ Phường Bến Nghé / Xã Hoằng Đông / Thị trấn Chợ Đồn","street":"số nhà, ngõ, tên đường, thôn/ấp còn lại (không lặp lại ba cấp)","confidence":"high|low","ambiguous":false,"reason":"một câu ngắn tiếng Việt giải thích căn cứ"}',
  'Quy tắc: không bịa. Địa chỉ ghi hai tỉnh khác nhau, hoặc không đủ thông tin để biết phường/xã, thì đặt ambiguous=true và để trống cấp không chắc. Giữ nguyên tỉnh/quận mà bộ đọc đã nhận ra, chỉ điền cấp còn thiếu. Tên cũ trước 2025 (ví dụ Quận 2, Quận 9 thuộc Thành phố Thủ Đức; Hà Tây thuộc Hà Nội) ghi theo danh mục hiện hành trước 2025 (Thành phố Thủ Đức).'
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
  if (!ward || !district || !province) return { ok: false, reason: 'mô hình không điền đủ ba cấp' };
  const resolved = resolveAddress(parts.filter(Boolean).join(', '));
  if (!resolved.province || !resolved.district || !resolved.ward || resolved.ambiguous) return { ok: false, reason: 'ba cấp không khớp danh mục kho' };
  const known = hint.resolved;
  if (known.province && known.province.code !== resolved.province.code) return { ok: false, reason: 'mô hình đổi tỉnh đã nhận ra' };
  if (known.district && known.district.code !== resolved.district.code) return { ok: false, reason: 'mô hình đổi quận/huyện đã nhận ra' };
  // Phần đường: lấy của mô hình, không có thì giữ phần bộ đọc để lại từ địa chỉ gốc.
  const finalStreet = isUsableStreet(resolved.street) ? resolved.street : (isUsableStreet(known.street) ? known.street : street);
  const canonical = [finalStreet, resolved.ward.name, resolved.district.name, resolved.province.name].filter(Boolean).join(', ');
  // Khách không gõ đường/số nhà mà mô hình tra ra một số nhà (ví dụ địa chỉ
  // một cửa hàng): vẫn nhận nhưng đánh dấu để nhân viên đối chiếu trước khi giao.
  const streetInvented = !isUsableStreet(known.street) && /d/.test(finalStreet) && !normalizeLocationKey(raw).includes(normalizeLocationKey(finalStreet).slice(0, 12));
  return { ok: true, canonical, street: finalStreet, ward: resolved.ward.name, district: resolved.district.name, province: resolved.province.name, streetInvented };
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
  const hint = addressHint(text);
  if (describeDeliveryAddress(text).complete) return null;
  const key = `${normalizeLocationKey(text)}|${settings.addressAiSearch !== false ? 's' : 'n'}`;
  const store = await readCache();
  if (options.force !== true && key in store) return store[key].result;
  let result = null;
  try {
    const { answer, sources } = await requestAddressGuess({ raw: text, hint: hint.text, settings, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
    const guess = parseAddressAnswer(answer);
    const checked = validateAddressGuess(guess, text, hint);
    if (checked.ok) {
      result = {
        canonical: checked.canonical,
        street: checked.street,
        ward: checked.ward,
        district: checked.district,
        province: checked.province,
        reason: String(guess.reason || '').trim().slice(0, 300),
        confidence: guess.confidence === 'low' || checked.streetInvented ? 'low' : 'high',
        sources,
        model: settings.directModel || ''
      };
    } else if (options.explain) {
      result = null;
      store[key] = { at: Date.now(), result, rejected: checked.reason, guess };
      scheduleCacheWrite();
      return { rejected: checked.reason, guess, sources };
    }
  } catch (error) {
    // Lỗi mạng/hạn mức thì không nhớ, để lần sau thử lại.
    if (options.explain) return { error: error.message };
    return null;
  }
  store[key] = { at: Date.now(), result };
  scheduleCacheWrite();
  return result;
}

/** Đợi cache ghi xong (dùng trong script và kiểm thử). */
export function flushAddressAiCache() {
  return cacheWrite;
}
