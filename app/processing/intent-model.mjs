// Mô hình ra quyết định chạy trước LLM: từ tin khách + ngữ cảnh đoán mã mẫu kèm xác suất,
// không giải thích. Trọng số học từ hội thoại thật của shop (tools-intent/train-intent.mjs),
// lưu ở app/processing/intent-model.json. Chế độ (settings.intentModel):
//   'shadow' (mặc định): chỉ ghi log so với câu trả lời thật, không đổi gì;
//   'on': đủ tin cậy và mẫu thuộc nhóm an toàn thì trả lời thẳng, không gọi LLM;
//   'off': tắt.
// Tệp mô hình v5 (top-level `temperature`) và v6 (`meta.calibration.temperature`) đều nạp được.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { featuresOf } from './intent-features.mjs';

const modelPath = process.env.INTENT_MODEL_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'intent-model.json');
let cached = null;

/** Mẫu mô hình nhỏ được phép tự trả lời khi bật: thông tin, giá, cảm ơn, hỏi vị — không lên đơn / hủy / chuyển người. */
export const intentSafeTemplates = new Set([
  'GENERAL_INFO', 'PRICE_QUOTE', 'PRICE_MIX_TUI_LON', 'BAG_COMPARISON', 'BAG_COMPARISON_XANH_VANG', 'DISCOUNT_POLICY', 'FREESHIP_POLICY',
  'GIFT_POLICY', 'PACKAGING_INFO', 'HEALTH_CONDITION', 'KIDS_FAMILY', 'CALORIES_DIET', 'NO_ADDED_SUGAR', 'CRUNCHY_CEREAL_INFO',
  'INGREDIENTS_ALLERGY', 'WEIGHT_EXPIRY', 'SHIPPING_POLICY', 'ECOMMERCE_LINKS', 'WHOLESALE_CTV_CONTACT', 'VAT_INVOICE', 'PAYMENT_METHODS',
  'FRESHNESS', 'PRODUCT_PHOTOS', 'THANK_YOU', 'ASK_FLAVOR', 'WELCOME'
]);

/** Số dự đoán đầu trả về trong `topK` (để so với LLM: câu LLM ∉ topK ∪ luật → cờ xem lại). */
export const INTENT_TOP_K = 3;

/** Đọc tệp trọng số ở `file` (không cache): dùng cho công cụ so hai mô hình. Lỗi → null. */
export function loadIntentModelFrom(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const calibrated = Number(raw.meta?.calibration?.temperature);
    const legacy = Number(raw.temperature);
    return {
      labels: raw.labels,
      idf: raw.idf,
      classes: raw.classes.map(item => ({ label: item.label, bias: item.bias, weights: item.weights })),
      // Nhiệt độ hiệu chuẩn (temperature scaling): chia điểm trước softmax để xác suất phản ánh đúng tỷ lệ đúng.
      // v6 ghi ở meta.calibration.temperature; v5 ghi top-level temperature.
      temperature: calibrated > 0 ? calibrated : legacy > 0 ? legacy : 1,
      calibration: raw.meta?.calibration || (legacy > 0 ? { temperature: legacy } : null),
      trainedAt: raw.meta?.trainedAt || raw.trainedAt,
      rows: raw.meta?.rows ?? raw.rows,
      meta: raw.meta || null,
      version: raw.version
    };
  } catch {
    return null;
  }
}

export function loadIntentModel() {
  if (cached !== null) return cached || null;
  cached = loadIntentModelFrom(modelPath) || false;
  return cached || null;
}

/**
 * Dự đoán bằng một mô hình đã nạp (loadIntentModelFrom): dùng cho replay/so sánh nhiều mô hình.
 * @returns {{ templateId: string, confidence: number, margin: number, second?: string, topK: { templateId: string, p: number }[] } | null}
 */
export function predictIntentWith(model, row) {
  if (!model) return null;
  const entries = [];
  for (const feature of featuresOf(row)) {
    const idf = model.idf[feature];
    if (idf !== undefined) entries.push([feature, idf]);
  }
  if (!entries.length) return null;
  const norm = Math.sqrt(entries.reduce((sum, [, value]) => sum + value * value, 0)) || 1;
  const scores = model.classes.map(item => {
    let sum = item.bias;
    for (const [feature, value] of entries) { const weight = item.weights[feature]; if (weight !== undefined) sum += weight * (value / norm); }
    return sum;
  });
  const scaled = scores.map(value => value / model.temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map(value => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  const probabilities = exps.map(value => value / total);
  const ranked = probabilities.map((p, k) => ({ templateId: model.labels[k], p })).sort((a, b) => b.p - a.p);
  const topK = ranked.slice(0, INTENT_TOP_K).map(item => ({ templateId: item.templateId, p: Number(item.p.toFixed(4)) }));
  const best = ranked[0];
  const second = ranked[1];
  // margin = p1 − p2: hai mẫu gần nhau (PRICE_QUOTE / PRICE_MIX) thì không đủ chắc dù p1 cao.
  return { templateId: best.templateId, confidence: best.p, margin: best.p - (second?.p || 0), second: second?.templateId, topK };
}

/**
 * @param {Parameters<typeof featuresOf>[0]} row — ngữ cảnh theo hợp đồng v2 (các trường mới tuỳ chọn).
 * @returns {ReturnType<typeof predictIntentWith>}
 */
export function predictIntent(row) {
  return predictIntentWith(loadIntentModel(), row);
}
