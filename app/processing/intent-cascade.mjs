// Mô hình quyết định TẦNG (cascade), chạy trước LLM như intent-model.mjs nhưng tách quyết định làm hai bước:
//   tầng 1 "nhóm ý định" 4 lớp: ORDER (giỏ / bước đơn) · SUPPORT (tra đơn, khiếu nại, gặp người, sỉ) ·
//     ANSWER (trả lời được bằng mẫu: giá / thông tin / xã giao) · OTHER (lớp "từ chối": không thuộc mẫu nào);
//   tầng 2 "chuyên biệt" theo nhóm: mỗi nhóm một mô hình nhỏ chỉ biết các mẫu trong nhóm.
// Xác suất cuối p = p(nhóm) × p(mẫu | nhóm); topK gộp qua 2 nhóm đầu × 3 mẫu đầu, sắp theo p.
// Nhóm con PRICE / INFO / SOCIAL (bảng cũ) vẫn giữ trong bảng ánh xạ để BÁO CÁO (subGroupOf / fineGroupOf) và cho cách 2 của
//   ANSWER: mô hình con ANSWER cho p mọi mẫu → cộng p theo nhóm con → nhóm con thắng → mô hình con của nhóm con
//   đó chọn mẫu (answerMode 'subgroup'); cách 1 (answerMode 'flat'): mô hình con ANSWER chọn mẫu thẳng.
//   train-cascade đo cả hai trên giữ-out và ghi cách tốt hơn vào tệp.
// Lý do tách: một mô hình phẳng 43 nhãn phải phân biệt mọi thứ cùng lúc; PRICE_QUOTE ↔ GENERAL_INFO (cặp lẫn nhiều
//   nhất) nay cùng nhóm ANSWER nên tầng 1 không phải phân xử; tầng 1 có lớp OTHER để từ chối thay vì đoán bừa.
// Nhóm ORDER: engine quyết bằng máy trạng thái slot (order-flow), mô hình chỉ cần đúng nhóm; chuyên biệt ORDER
//   vẫn được huấn luyện để đo nhưng engine không tự trả lời theo nó. TRIAL_PRICE không nằm trong bảng (trial-flow quyết).
// Mỗi mô hình con là một JSON định dạng intent-model.json (huấn luyện bằng trainClassifier của
//   tools-intent/train-intent.mjs, đọc bằng predictIntentWith của intent-model.mjs) — không có bộ phân loại mới.
// Tệp mô hình: app/processing/intent-cascade.json (tools-intent/train-cascade.mjs), đổi bằng INTENT_CASCADE_PATH.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { featuresOf } from './intent-features.mjs';
import { INTENT_TOP_K, intentSafeTemplates, predictIntentWith } from './intent-model.mjs';

const cascadePath = process.env.INTENT_CASCADE_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'intent-cascade.json');
let cached = null;

/** Nhóm tầng 1. OTHER = lớp từ chối (mã không có trong bảng, nhãn OTHER). */
export const CASCADE_GROUPS = ['ORDER', 'SUPPORT', 'ANSWER', 'OTHER'];

/** Nhóm 6 lớp để báo cáo (fineGroupOf): ANSWER tách thành PRICE / INFO / SOCIAL. */
export const CASCADE_FINE_GROUPS = ['ORDER', 'SUPPORT', 'PRICE', 'INFO', 'SOCIAL', 'OTHER'];

/** Nhóm con thuộc ANSWER. */
export const ANSWER_SUBGROUPS = ['PRICE', 'INFO', 'SOCIAL'];

/** Số nhóm đầu được mở rộng sang tầng 2 khi gộp topK (2 nhóm × 3 mẫu). */
export const CASCADE_TOP_GROUPS = 2;

// Vòng 12 (28/09): rà đủ 100 mẫu seed — mẫu thông tin mới (KIDS_FAMILY, CALORIES_DIET, STORAGE, HOW_TO_USE_GRANOLA,
// STORE_ADDRESS, CERTIFICATION, ORDER_AFTER_SALE) vào INFO, giá sản phẩm riêng / quà rỗng vào PRICE, các câu bước đơn
// (dòng giỏ, nhắc giỏ, gợi ý 2 túi, sửa/ghi chú/giữ nguyên đơn, giỏ Shop…) vào ORDER, câu chuyển người / tra đơn vào
// SUPPORT. Còn lại là OTHER CÓ CHỦ Ý (CASCADE_INTENTIONAL_OTHER): luồng riêng quyết (bình luận, bám đuổi, dùng thử, QR,
// săn deal live) hay hậu xử lý (REPLY_ALREADY_SENT*) — mô hình không học các mẫu này.
// 03/10: SHIPMENT_* (báo hành trình vận đơn) và ORDER_STATUS_SHIPPED do máy chủ tự chọn, cũng OTHER có chủ ý.
const TEMPLATES_BY_SUBGROUP = {
  PRICE: ['PRICE_QUOTE', 'PRICE_QUOTE_COMBO', 'PRICE_MIX_TUI_LON', 'GENERAL_INFO', 'PRICE_ADJUSTMENT', 'PRICE_SHIP_EXPLAIN', 'DISCOUNT_POLICY', 'FREESHIP_POLICY', 'GIFT_POLICY', 'LIVESTREAM_VOUCHER', 'PRICE_YEN_MACH_UC_NGUYEN_CAM', 'GIFT_POLICY_EMPTY', 'GIFT_SWAP',
    // vòng 12 (r12): giá theo số túi / 1 túi, so giá sàn, quà theo ngữ cảnh
    'PRICE_COUNT', 'PRICE_ONE_BAG', 'PRICE_COMPARE', 'GIFT_POLICY_LIVE', 'GIFT_POLICY_PROMO', 'GIFT_POLICY_UPSELL3', 'ASK_TWO_BAGS'],
  INFO: ['BAG_COMPARISON', 'BAG_COMPARISON_XANH_VANG', 'CRUNCHY_CEREAL_INFO', 'DELIVERY_DELAY', 'ECOMMERCE_LINKS', 'FRESHNESS', 'HEALTH_CONDITION', 'INGREDIENTS_ALLERGY', 'INSPECTION_RETURN_POLICY', 'NO_ADDED_SUGAR', 'OIL_SMELL_WARRANTY', 'OTHER_PRODUCTS', 'PACKAGING_INFO', 'PRODUCT_PHOTOS', 'SHIPPING_POLICY', 'VAT_INVOICE', 'WEIGHT_EXPIRY', 'RECOMMEND_BEGINNER', 'NO_VARIANT', 'COMBO3_FLAVOR', 'PAYMENT_METHODS', 'BANK_TRANSFER', 'KIDS_FAMILY', 'CALORIES_DIET', 'STORAGE', 'HOW_TO_USE_GRANOLA', 'STORE_ADDRESS', 'CERTIFICATION', 'ORDER_AFTER_SALE',
    // vòng 12 (r12)
    'HEALTH_DIABETES', 'HEALTH_CAUTION', 'WEIGHT_GAIN', 'VEGAN_INFO', 'BENEFITS', 'PRODUCTION_PLACE', 'TROPICAL_CONFIRM'],
  SOCIAL: ['THANK_YOU', 'WELCOME'],
  SUPPORT: ['CSKH_HANDOFF', 'COMPLAINT_SORRY','ORDER_STATUS', 'ORDER_STATUS_NONE', 'WHOLESALE_CTV_CONTACT', 'WAITING_STAFF', 'PAYMENT_RECEIVED_CHECK', 'LIVE_ONLY_PRODUCT', 'CALLBACK_REQUEST', 'IMAGE_RECEIVED', 'WHOLESALE_RECEIVED', 'REFUSED_DELIVERY', 'ORDER_STATUS_CHECKING',
    // vòng 12 (r12): ghi nhận + chuyển nhân viên
    'ORDER_CANCEL_STAFF', 'ORDER_HOLD_STAFF', 'STAFF_ONLY_PRODUCT', 'RECEIVED_CHECK', 'IMAGE_WITH_PHONE',
    // vòng 13 (r13): giỏ Facebook Shop engine ghi nhận + chuyển nhân viên (mã lạ / món nhân viên lên đơn)
    'SHOP_CART_UNKNOWN', 'SHOP_CART_STAFF',
    // R15 (03/10): khách đã mua trên sàn (hỏi mã đơn sàn để kiểm tra)
    'BOUGHT_ON_MARKETPLACE',
    // R16 (05/10): tin nhắn thoại — bot không nghe được, xin khách nhắn chữ (như IMAGE_RECEIVED; không vào ANSWER)
    'VOICE_RECEIVED'],
  ORDER: ['ASK_FLAVOR', 'ASK_PRODUCT', 'ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_CONFIRMATION', 'ORDER_CANCELLED', 'ORDER_HELP', 'ORDER_EXISTING_CONFIRM', 'CONFIRM_YES', 'ORDER_POSTPONED', 'ORDER_INFO_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN',
    'ORDER_UPDATED', 'ORDER_ADDRESS_REMIND', 'ORDER_CART_LINE', 'UPSELL_TWO_BAGS', 'SHOP_ORDER_RECEIVED', 'ORDER_ADDRESS_CHOOSE', 'ORDER_ADDRESS_OLD_ASK_PHONE', 'ORDER_PHONE_ASK_FLAVOR', 'ORDER_UNCHANGED', 'ORDER_WRONG', 'ORDER_CHANGE_STAFF', 'ORDER_CUSTOM_BASKET', 'ORDER_NOTE_ADDED', 'ASK_REORDER',
    // mã engine trả (renderChatbotReply) cho ORDER_UPDATED / ORDER_CANCELLED / ORDER_NOTE_ADDED — nhãn từ nhật ký quyết định
    'ORDER_UPDATE', 'ORDER_CANCEL', 'ORDER_NOTE',
    // vòng 13 (r13): bước đơn engine tự chọn — đã nhận giỏ Shop (chờ kiểm đơn), ghi nhận quà thay của giỏ/đơn
    'SHOP_CART_ACK', 'GIFT_SWAP_NOTED', 'STAFF_WAIT_OPEN', 'STAFF_WAIT_CLOSED',
    // R15 (03/10): engine tự chọn — SĐT thiếu số, không tra được địa chỉ cũ (hỏi thẳng địa chỉ), mặc cả → tặng yến mạch theo giỏ
    'PHONE_LOOKS_SHORT', 'ORDER_ADDRESS_OLD_NOT_FOUND', 'DISCOUNT_OATS_GIFT',
    // 05/10: đổi quạt → muỗng dừa cho khách live / quà đã có muỗng (engine tự chọn)
    'GIFT_FAN_TO_SPOON', 'GIFT_SPOON_INCLUDED']
};

/**
 * Mẫu seed CỐ Ý không thuộc nhóm nào (OTHER): luồng riêng quyết hay hậu xử lý. Test kiểm mọi mẫu seed khác đều có nhóm.
 * R13: GIFT_POLICY_ORDER / GIFT_POLICY_ORDER_NONE là hậu xử lý của bộ soạn (khách ĐÃ CÓ ĐƠN hỏi quà → nói quà của đơn
 * đó) — không vào nhóm ANSWER để mô hình tầng không bao giờ tự trả lời bằng hai mẫu này.
 */
// R15 (03/10): BAG_SIZE_INFO / FRUIT_PAIRING / SMALL_PACK_FLAVOURS là mẫu thông tin MỚI chưa có nhãn trong dữ liệu huấn luyện —
// OTHER có chủ ý (không vào ANSWER để mô hình tầng không tự trả lời bằng mẫu nó chưa học); chuyển sang INFO sau khi huấn luyện lại.
// R17 (10/10): ALLERGY_HAS_INGREDIENT / INGREDIENT_NOT_INCLUDED (luật dị ứng) cùng cách.
export const isIntentionalOther = templateId => /^(COMMENT_|FOLLOW_UP_|TRIAL_|SHIPMENT_)/.test(String(templateId || '')) || ['QR_OFFER', 'LIVESTREAM_COMMENT', 'LIVE_DEAL_CLAIMED', 'REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO', 'GIFT_POLICY_ORDER', 'GIFT_POLICY_ORDER_NONE', 'ORDER_STATUS_SHIPPED', 'BAG_SIZE_INFO', 'FRUIT_PAIRING', 'SMALL_PACK_FLAVOURS', 'DEFAULT_FLAVOUR_NOTE', 'ALLERGY_HAS_INGREDIENT', 'INGREDIENT_NOT_INCLUDED'].includes(String(templateId || ''));

/** Mã mẫu → nhóm 6 lớp (bảng đã chốt, PRICE/INFO/SOCIAL tách). Mã không có trong bảng và COMMENT_* không có mục. */
export const SUBGROUP_OF_TEMPLATE = Object.freeze(Object.fromEntries(Object.entries(TEMPLATES_BY_SUBGROUP).flatMap(([subgroup, templates]) => templates.map(templateId => [templateId, subgroup]))));

/** Mã mẫu → nhóm tầng 1 (PRICE/INFO/SOCIAL gộp thành ANSWER). */
export const GROUP_OF_TEMPLATE = Object.freeze(Object.fromEntries(Object.entries(SUBGROUP_OF_TEMPLATE).map(([templateId, subgroup]) => [templateId, ANSWER_SUBGROUPS.includes(subgroup) ? 'ANSWER' : subgroup])));

/** Nhóm con trong ANSWER của một mã mẫu: 'PRICE' | 'INFO' | 'SOCIAL'; mã không thuộc ANSWER → null. */
export function subGroupOf(templateId) {
  const fine = SUBGROUP_OF_TEMPLATE[String(templateId || '')];
  return fine && ANSWER_SUBGROUPS.includes(fine) ? fine : null;
}

/** Nhóm 6 lớp để BÁO CÁO (ORDER / SUPPORT / PRICE / INFO / SOCIAL / OTHER) = subGroupOf ?? groupOf. */
export function fineGroupOf(templateId) {
  return subGroupOf(templateId) || groupOf(templateId);
}

/** @returns {'ORDER'|'SUPPORT'|'ANSWER'|'OTHER'} */
export function groupOf(templateId) {
  return GROUP_OF_TEMPLATE[String(templateId || '')] || 'OTHER';
}

/** Nhóm con → nhóm tầng 1. */
export const groupOfSubgroup = subgroup => (ANSWER_SUBGROUPS.includes(subgroup) ? 'ANSWER' : CASCADE_GROUPS.includes(subgroup) ? subgroup : 'OTHER');

/** Nhóm tầng 1 mà mô hình tầng được phép tự trả lời khi bật (ORDER do máy trạng thái slot quyết; SUPPORT chuyển người/tra đơn). */
export const CASCADE_SAFE_GROUPS = new Set(['ANSWER']);

/** Mẫu an toàn của tầng = mẫu thuộc ANSWER (PRICE/INFO/SOCIAL) ∩ intentSafeTemplates (bỏ ASK_FLAVOR, WHOLESALE_CTV_CONTACT…). */
export const cascadeSafeTemplates = new Set([...intentSafeTemplates].filter(templateId => CASCADE_SAFE_GROUPS.has(groupOf(templateId))));

/** JSON định dạng intent-model.json (v5 top-level temperature / v6 meta.calibration) → mô hình chạy được với predictIntentWith. */
export function subModelFrom(raw) {
  if (!raw || !Array.isArray(raw.labels) || !Array.isArray(raw.classes) || !raw.idf) return null;
  const calibrated = Number(raw.meta?.calibration?.temperature);
  const legacy = Number(raw.temperature);
  return {
    labels: raw.labels,
    idf: raw.idf,
    classes: raw.classes.map(item => ({ label: item.label, bias: item.bias, weights: item.weights })),
    temperature: calibrated > 0 ? calibrated : legacy > 0 ? legacy : 1,
    trainedAt: raw.meta?.trainedAt || raw.trainedAt,
    rows: raw.meta?.rows ?? raw.rows,
    meta: raw.meta || null
  };
}

/**
 * Phân phối xác suất ĐẦY ĐỦ của một mô hình con (cùng công thức với predictIntentWith, vốn chỉ trả top-3):
 * cần để cộng p theo nhóm con (answerMode 'subgroup') và cho đối chứng "phẳng cộng p theo nhóm" của train-cascade.
 * @returns {Record<string, number> | null}
 */
export function probabilitiesOf(model, row) {
  if (!model) return null;
  const entries = [];
  for (const feature of featuresOf(row)) {
    const idf = model.idf[feature];
    if (idf !== undefined) entries.push([feature, idf]);
  }
  if (!entries.length) return null;
  const norm = Math.sqrt(entries.reduce((sum, [, value]) => sum + value * value, 0)) || 1;
  const scaled = model.classes.map(item => {
    let sum = item.bias;
    for (const [feature, value] of entries) { const weight = item.weights[feature]; if (weight !== undefined) sum += weight * (value / norm); }
    return sum / model.temperature;
  });
  const max = Math.max(...scaled);
  const exps = scaled.map(value => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(model.labels.map((label, k) => [label, exps[k] / total]));
}

/** Cộng p theo nhóm (hàm nhóm tuỳ chọn: groupOf, subGroupOf hay fineGroupOf), sắp giảm dần; nhóm null bị bỏ. */
export function sumByGroup(probabilities, groupFn = groupOf) {
  const sums = {};
  for (const [label, p] of Object.entries(probabilities || {})) { const group = groupFn(label); if (group) sums[group] = (sums[group] || 0) + p; }
  return Object.entries(sums).map(([group, p]) => ({ group, p: Number(p.toFixed(4)) })).sort((a, b) => b.p - a.p);
}

/**
 * JSON mô hình tầng (đã parse) → mô hình chạy được. Thiếu mô hình nhóm → null.
 * @returns {{ version: string, trainedAt?: string, rows?: number, groups: string[], answerMode: 'flat'|'subgroup', groupModel: object,
 *   specialists: Record<string, object|null>, report?: object } | null}
 */
export function cascadeFromRaw(raw) {
  const groupModel = subModelFrom(raw?.groupModel);
  if (!groupModel) return null;
  const specialists = {};
  for (const key of ['ORDER', 'SUPPORT', 'ANSWER', ...ANSWER_SUBGROUPS]) specialists[key] = subModelFrom(raw.specialists?.[key]);
  return {
    version: raw.version || 'cascade-2',
    trainedAt: raw.trainedAt,
    rows: raw.rows,
    groups: Array.isArray(raw.groups) ? raw.groups : groupModel.labels,
    answerMode: raw.answerMode === 'subgroup' ? 'subgroup' : 'flat',
    groupModel,
    specialists,
    report: raw.report || null,
    // meta.trainIds / goldenExcluded / sawGolden (train-cascade vòng 12) — replay-golden cảnh báo mô hình đã thấy golden.
    meta: raw.meta || null
  };
}

/** Đọc tệp mô hình tầng (không cache). Thiếu tệp / hỏng / thiếu mô hình nhóm → null. */
export function loadCascadeFrom(file) {
  try {
    return cascadeFromRaw(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** Mô hình mặc định (app/processing/intent-cascade.json hoặc INTENT_CASCADE_PATH), cache; thiếu tệp → null. */
export function loadCascadeModel() {
  if (cached !== null) return cached || null;
  cached = loadCascadeFrom(cascadePath) || false;
  return cached || null;
}

/** Nạp lại sau khi thay tệp trọng số, không cần khởi động lại (như reloadIntentModel). */
export function reloadCascadeModel() {
  cached = null;
  return loadCascadeModel();
}

export { loadCascadeModel as loadCascade, reloadCascadeModel as reloadCascade };

/** Ứng viên tầng 2 của một nhóm: [{ templateId, p (tích), pWithin, marginWithin, group, subGroup }]. Không có mô hình con → ứng viên null. */
function candidatesOf(model, group, pGroup, row, answerMode) {
  const empty = [{ templateId: null, p: pGroup, pWithin: null, marginWithin: null, group, subGroup: null, pSubGroup: null }];
  if (group === 'OTHER') return empty;
  const fromSpecialist = (specialist, scale, subGroup, pSubGroup) => {
    const guess = specialist ? predictIntentWith(specialist, row) : null;
    if (!guess) return null;
    return guess.topK.map(item => ({ templateId: item.templateId, p: Number((scale * item.p).toFixed(4)), pWithin: Number((item.p * (pSubGroup ?? 1)).toFixed(4)), marginWithin: Number(guess.margin.toFixed(4)), group, subGroup: subGroup || subGroupOf(item.templateId), pSubGroup }));
  };
  if (group !== 'ANSWER' || answerMode !== 'subgroup') return fromSpecialist(model.specialists[group], pGroup, null, null) || empty;
  // answerMode 'subgroup': mô hình con ANSWER → cộng p theo nhóm con → nhóm con thắng → mô hình con của nó chọn mẫu.
  const distribution = probabilitiesOf(model.specialists.ANSWER, row);
  if (!distribution) return empty;
  const ranked = sumByGroup(distribution, subGroupOf).filter(item => ANSWER_SUBGROUPS.includes(item.group));
  const best = ranked[0];
  if (!best) return empty;
  const fromSub = fromSpecialist(model.specialists[best.group], pGroup * best.p, best.group, best.p);
  if (fromSub) return fromSub;
  // Nhóm con không có mô hình riêng (ít dữ liệu): lấy mẫu trong nhóm con đó từ phân phối ANSWER.
  const inSub = Object.entries(distribution).filter(([templateId]) => subGroupOf(templateId) === best.group).sort((a, b) => b[1] - a[1]).slice(0, INTENT_TOP_K);
  if (!inSub.length) return empty;
  const second = inSub[1]?.[1] || 0;
  return inSub.map(([templateId, p]) => ({ templateId, p: Number((pGroup * p).toFixed(4)), pWithin: Number(p.toFixed(4)), marginWithin: Number((inSub[0][1] - second).toFixed(4)), group, subGroup: best.group, pSubGroup: best.p }));
}

/**
 * Dự đoán hai tầng bằng một mô hình đã nạp (loadCascadeFrom / cascadeFromRaw).
 * - Tầng 1: mô hình nhóm (ORDER / SUPPORT / ANSWER / OTHER) → groupTopK (tối đa 3, giảm dần).
 * - Tầng 2: với 2 nhóm đầu, mô hình con của nhóm → 3 mẫu đầu, p = p(nhóm) × p(mẫu | nhóm); OTHER hay nhóm không có
 *   mô hình con đóng góp ứng viên { templateId: null, p: p(nhóm) }.
 * - Gộp ứng viên qua các nhóm, sắp theo p: phần tử đầu là kết quả; margin = p1 − p2 (trên tích);
 *   pWithin / marginWithin = xác suất và biên TRONG nhóm của mẫu chọn; topK chỉ giữ ứng viên có mẫu.
 * @param {ReturnType<typeof cascadeFromRaw>} model
 * @param {Parameters<typeof predictIntentWith>[1]} row — cùng dạng featuresOf (text, lastTemplate, hasBasket, prevBot, prevBotAsks, …)
 * @returns {{ group: string, pGroup: number, groupTopK: { group: string, p: number }[], subGroup: string|null, templateId: string|null,
 *   p: number, margin: number, pWithin: number|null, marginWithin: number|null,
 *   topK: { templateId: string, p: number, pWithin: number, group: string, subGroup: string|null }[], path: [string, string|null] } | null}
 *   group cùng cấp với groupOf(templateId) (ORDER/SUPPORT/ANSWER/OTHER); subGroup cùng cấp với subGroupOf (PRICE/INFO/SOCIAL/null).
 */
export function predictCascadeWith(model, row) {
  if (!model || !model.groupModel) return null;
  const level1 = predictIntentWith(model.groupModel, row);
  if (!level1) return null;
  const groupTopK = level1.topK.map(item => ({ group: item.templateId, p: item.p }));
  const candidates = [];
  for (const entry of groupTopK.slice(0, CASCADE_TOP_GROUPS)) candidates.push(...candidatesOf(model, entry.group, entry.p, row, model.answerMode));
  candidates.sort((a, b) => b.p - a.p);
  const best = candidates[0];
  const second = candidates[1];
  const pGroup = groupTopK.find(item => item.group === best.group)?.p ?? level1.confidence;
  return {
    group: best.group,
    pGroup,
    groupTopK,
    subGroup: best.subGroup,
    templateId: best.templateId,
    p: best.p,
    margin: Number((best.p - (second?.p || 0)).toFixed(4)),
    pWithin: best.pWithin,
    marginWithin: best.marginWithin,
    topK: candidates.filter(item => item.templateId).map(item => ({ templateId: item.templateId, p: item.p, pWithin: item.pWithin, group: item.group, subGroup: item.subGroup })),
    path: [best.group, best.templateId]
  };
}

/**
 * Dự đoán bằng mô hình mặc định; thiếu tệp → null.
 * @param {Parameters<typeof predictCascadeWith>[1]} row
 */
export function predictCascade(row) {
  return predictCascadeWith(loadCascadeModel(), row);
}
