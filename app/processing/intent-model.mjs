// Mô hình ra quyết định chạy trước LLM: từ tin khách + ngữ cảnh đoán mã mẫu kèm xác suất,
// không giải thích. Trọng số học từ hội thoại thật của shop (tools-intent/train-intent.mjs),
// lưu ở app/processing/intent-model.json. Chế độ (settings.intentModel):
//   'shadow' (mặc định): chỉ ghi log so với câu trả lời thật, không đổi gì;
//   'on': đủ tin cậy và mẫu thuộc nhóm an toàn thì trả lời thẳng, không gọi LLM;
//   'off': tắt.
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

export function loadIntentModel() {
  if (cached !== null) return cached || null;
  try {
    const raw = JSON.parse(readFileSync(modelPath, 'utf8'));
    cached = {
      labels: raw.labels,
      idf: raw.idf,
      classes: raw.classes.map(item => ({ label: item.label, bias: item.bias, weights: item.weights })),
      trainedAt: raw.trainedAt,
      rows: raw.rows
    };
  } catch {
    cached = false;
  }
  return cached || null;
}

/** Nạp lại (sau khi huấn luyện lại) mà không cần khởi động lại. */
export function reloadIntentModel() {
  cached = null;
  return loadIntentModel();
}

/**
 * @returns {{ templateId: string, confidence: number, second?: string } | null}
 */
export function predictIntent(row) {
  const model = loadIntentModel();
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
  const max = Math.max(...scores);
  const exps = scores.map(value => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  const probabilities = exps.map(value => value / total);
  let best = 0;
  let second = -1;
  for (let k = 1; k < probabilities.length; k += 1) {
    if (probabilities[k] > probabilities[best]) { second = best; best = k; } else if (second < 0 || probabilities[k] > probabilities[second]) second = k;
  }
  return { templateId: model.labels[best], confidence: probabilities[best], second: second >= 0 ? model.labels[second] : undefined };
}
