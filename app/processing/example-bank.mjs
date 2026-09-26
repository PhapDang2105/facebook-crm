// Kho ví dụ đã duyệt (bộ chấm mẫu: tin khách → mã mẫu nhân viên chấm) và cách tìm ví dụ gần nhất
// để chèn vào câu hỏi gửi LLM ("few-shot động"): 3 tin tương tự đã có mã đúng giúp mô hình chọn
// đúng mẫu ở các ca hiếm (gói nhỏ, quà tặng, combo…) mà prompt chung hay nhầm. Chỉ tính bằng
// n-gram ký tự (không gọi API), khoảng 100 token thêm mỗi lượt.
import { normalizeIntentText } from './intent-features.mjs';
import { readGoldenSet } from '../golden-set.mjs';

function grams(text) {
  const norm = ` ${normalizeIntentText(text).slice(0, 200)} `;
  const counts = new Map();
  for (const n of [2, 3, 4]) for (let i = 0; i + n <= norm.length; i += 1) { const g = norm.slice(i, i + n); counts.set(g, (counts.get(g) || 0) + 1); }
  return counts;
}

/** Dựng kho từ danh sách {id, text, lastTemplate, label}. */
export function buildExampleBank(items = []) {
  const rows = items.filter(item => item?.text && item?.label && item.label !== 'SKIP');
  const df = new Map();
  const bags = rows.map(item => { const g = grams(item.text); for (const key of g.keys()) df.set(key, (df.get(key) || 0) + 1); return g; });
  const N = rows.length || 1;
  const idf = key => Math.log((N + 1) / ((df.get(key) || 0) + 1)) + 1;
  const vectorOf = bag => {
    const vector = new Map();
    let norm = 0;
    for (const [key, count] of bag) { const value = (1 + Math.log(count)) * idf(key); vector.set(key, value); norm += value * value; }
    norm = Math.sqrt(norm) || 1;
    for (const [key, value] of vector) vector.set(key, value / norm);
    return vector;
  };
  return { items: rows.map((item, index) => ({ id: item.id, text: item.text, lastTemplate: item.lastTemplate || '', label: item.label, vector: vectorOf(bags[index]) })), vectorOf, size: rows.length };
}

/** k ví dụ gần nhất (cosine n-gram ≥ minScore), ưu tiên nhẹ ví dụ cùng mẫu bot vừa gửi; bỏ chính tin đang đo. */
export function nearestExamples(bank, { text, lastTemplate = '', k = 3, minScore = 0.2, excludeId = '' } = {}) {
  if (!bank?.items?.length || !text) return [];
  const query = bank.vectorOf(grams(text));
  const scored = [];
  for (const item of bank.items) {
    if (excludeId && item.id === excludeId) continue;
    let dot = 0;
    for (const [key, value] of query) { const other = item.vector.get(key); if (other) dot += value * other; }
    const score = dot + (lastTemplate && item.lastTemplate === lastTemplate ? 0.05 : 0);
    if (score >= minScore) scored.push({ text: item.text, label: item.label, score });
  }
  scored.sort((a, b) => b.score - a.score);
  // Không lặp cùng một câu (bộ chấm có nhiều "Xin giá"): giữ câu đầu của mỗi nội dung.
  const seen = new Set();
  return scored.filter(item => { const key = normalizeIntentText(item.text); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, k);
}

/** Khối chữ chèn vào câu hỏi gửi LLM. */
export function formatExamples(examples = []) {
  if (!examples.length) return '';
  return `VÍ DỤ ĐÃ DUYỆT (tin khách tương tự → mã mẫu đúng, chỉ tham khảo):\n${examples.map(item => `- "${String(item.text).slice(0, 120)}" → ${item.label}`).join('\n')}`;
}

let cached = null;
/** Kho từ bộ chấm mẫu (tin đã chấm), dựng lại khi số tin chấm đổi. */
export async function loadExampleBank() {
  const state = await readGoldenSet();
  const labeled = state.items.filter(item => item.label && item.label !== 'SKIP');
  const stamp = `${labeled.length}:${labeled.reduce((max, item) => Math.max(max, Number(item.labeledAt) || 0), 0)}`;
  if (!cached || cached.stamp !== stamp) cached = { stamp, bank: buildExampleBank(labeled) };
  return cached.bank;
}
