// Trộn nhãn cho tập huấn luyện mô hình nhỏ (hợp đồng v2).
// Dùng: node tools-intent/merge-labels.mjs <dataset.jsonl> <labels.jsonl> <out.jsonl> [golden-set.json] [--trust replay-llm-out.json] [--keep-other] [--golden-window 10]
// Ưu tiên: staff > rule > template/pipeline (nhãn KHÔNG thuộc POLICY_DRIFT) > llm.
//   - Nhãn LLM được nhận khi (a) trùng nhãn gốc → labelSource 'both', hoặc (b) khác nhãn gốc nhưng nhãn gốc
//     thuộc POLICY_DRIFT (câu bot đã gửi không chắc đúng: ORDER_ADDRESS, ASK_PRODUCT, GENERAL_INFO…) → 'llm'.
//   - --trust <replay-llm-out.json>: độ khớp pipeline (luật + LLM) theo lớp trên bộ chấm; lớp < 80% hoặc n < 15
//     → dòng nhãn lớp đó (không phải staff/rule) giữ nhưng weak:true (train-intent giảm trọng số). Kết quả "LỖI…"
//     (gọi model hỏng) không tính là sai: loại khỏi mẫu đếm.
//   - OTHER: dòng OTHER của NHÂN VIÊN (staff/corrected — "câu này không có mẫu") được GIỮ cho mô hình tầng (lớp từ chối);
//     OTHER khác (mẫu/LLM) bỏ, trừ khi --keep-other. train-intent vẫn tự bỏ OTHER.
//   - Bỏ dòng thuộc bộ chấm mẫu: trùng id, HOẶC cùng hội thoại và lệch ≤ 10 phút (cùng lượt, id khác cách dựng),
//     HOẶC chữ đã chuẩn hoá trùng (≥ 12 ký tự — chữ ngắn chung chung "ok", "<sdt>" không tính). Bỏ trường confidence.
//     --golden-window <phút> (mặc định 10; 0 = chỉ cùng mốc): cửa sổ "cùng hội thoại" — loại cả lượt lân cận (bảo thủ, tốn dữ liệu).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeIntentText } from '../app/processing/intent-features.mjs';
import { POLICY_DRIFT, cliFail, parseCliArgs, readJsonl, toJsonl } from './dataset-context.mjs';

export const TRUST_MIN_ACCURACY = 0.8;
export const TRUST_MIN_ROWS = 15;
export const GOLDEN_NEAR_MS = 10 * 60 * 1000;
export const GOLDEN_TEXT_MIN = 12;

/** Kết quả replay lỗi (gọi model hỏng): không phải dự đoán, không tính đúng/sai. */
export const isReplayError = value => String(value || '').startsWith('LỖI');

/** Độ khớp pipeline theo lớp từ replay-llm-out.json ([{ truth, pipeline }]) → Map nhãn → { n, agree, accuracy, weak, errors }. */
export function trustByClass(replayRows) {
  const byClass = new Map();
  for (const row of Array.isArray(replayRows) ? replayRows : []) {
    if (!row?.truth) continue;
    const entry = byClass.get(row.truth) || { n: 0, agree: 0, errors: 0 };
    byClass.set(row.truth, entry);
    if (isReplayError(row.pipeline)) { entry.errors += 1; continue; }
    entry.n += 1;
    if (row.pipeline === row.truth) entry.agree += 1;
  }
  for (const entry of byClass.values()) { entry.accuracy = entry.n ? entry.agree / entry.n : 0; entry.weak = entry.n < TRUST_MIN_ROWS || entry.accuracy < TRUST_MIN_ACCURACY; }
  return byClass;
}

/** Mã hội thoại của một id dòng/golden ("page:psid:mốc" hay "page:psid:mid") = phần trước dấu ":" cuối. */
const conversationOf = id => { const text = String(id || ''); const at = text.lastIndexOf(':'); return at > 0 ? text.slice(0, at) : ''; };

/** Chỉ mục bộ chấm: id, (hội thoại → mốc giờ), chữ chuẩn hoá (≥ GOLDEN_TEXT_MIN ký tự). */
export function goldenIndex(items = [], { windowMs = GOLDEN_NEAR_MS } = {}) {
  const ids = new Set();
  const times = new Map();
  const texts = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    if (item.id) ids.add(String(item.id));
    const conversation = conversationOf(item.id);
    const at = Number(item.at) || 0;
    if (conversation && at) (times.get(conversation) || times.set(conversation, []).get(conversation)).push(at);
    const text = normalizeIntentText(item.text);
    if (text.length >= GOLDEN_TEXT_MIN) texts.add(text);
  }
  return { ids, times, texts, size: ids.size, windowMs };
}

/** Dòng có thuộc bộ chấm không → 'id' | 'near' | 'text' | '' . `golden` là goldenIndex hay Set id (cũ). */
export function goldenMatch(row, golden) {
  if (!golden) return '';
  if (golden instanceof Set) return golden.has(row.id) ? 'id' : '';
  if (golden.ids.has(String(row.id))) return 'id';
  const at = Number(row.at) || 0;
  const near = at && golden.times.get(conversationOf(row.id));
  if (near && near.some(value => Math.abs(value - at) <= (golden.windowMs ?? GOLDEN_NEAR_MS))) return 'near';
  const text = normalizeIntentText(row.text);
  if (text.length >= GOLDEN_TEXT_MIN && golden.texts.has(text)) return 'text';
  return '';
}

const isStaffLabel = row => row.labelSource === 'staff' || Boolean(row.corrected);

/** Trộn một dòng với nhãn LLM (nếu có) → dòng mới (null = bỏ). `stats` cộng dồn. */
export function mergeRow(row, llm, { golden = null, trust = null, keepOther = false, stats = {} } = {}) {
  const bump = key => { stats[key] = (stats[key] || 0) + 1; };
  const hit = goldenMatch(row, golden);
  if (hit) { bump('golden'); if (hit !== 'id') bump(hit === 'near' ? 'goldenNear' : 'goldenText'); return null; }
  const { confidence, ...base } = row;
  let out = base;
  const source = row.labelSource;
  if (source === 'staff' || row.corrected) { bump('staff'); }
  else if (source === 'rule') { bump('rule'); }
  else if (llm?.label && !llm.error) {
    if (llm.label === row.label) { bump('both'); out = { ...base, labelSource: 'both' }; }
    else if (POLICY_DRIFT.has(row.label)) {
      bump('llm');
      const pair = `${row.label} → ${llm.label}`;
      stats.changed = stats.changed || {};
      stats.changed[pair] = (stats.changed[pair] || 0) + 1;
      out = { ...base, label: llm.label, labelSource: 'llm', labelBefore: row.label };
    } else { bump('keptOverLlm'); }
  } else { bump('noLlm'); }
  if (!out.label) { bump('other'); return null; }
  if (out.label === 'OTHER') {
    // OTHER của nhân viên = "không mẫu nào thay được câu này": lớp từ chối quý cho mô hình tầng.
    if (!(keepOther || isStaffLabel(out))) { bump('other'); return null; }
    bump('otherKept');
    return out;
  }
  // Độ tin cậy theo lớp: nhãn lớp yếu (không phải nhân viên/luật) giữ nhưng đánh dấu weak.
  if (trust && !(isStaffLabel(out) || out.labelSource === 'rule')) {
    const entry = trust.get(out.label);
    if (!entry || entry.weak) { bump('weak'); out = { ...out, weak: true }; }
    else if (out.weak) { const { weak, ...rest } = out; out = rest; }
  }
  return out;
}

export function mergeRows(rows, labels, options = {}) {
  const stats = { total: rows.length };
  const labelMap = labels instanceof Map ? labels : new Map((labels || []).filter(item => item?.id).map(item => [item.id, item]));
  const out = [];
  for (const row of rows) {
    const merged = mergeRow(row, labelMap.get(row.id), { ...options, stats });
    if (merged) out.push(merged);
  }
  stats.kept = out.length;
  stats.bySource = out.reduce((acc, row) => { acc[row.labelSource] = (acc[row.labelSource] || 0) + 1; return acc; }, {});
  return { rows: out, stats };
}

function readJsonlFile(file, what) {
  if (!existsSync(file)) cliFail(`Không thấy ${what}: ${file}`);
  const readStats = {};
  const rows = readJsonl(readFileSync(file, 'utf8'), readStats);
  if (readStats.bad) console.warn(`Bỏ ${readStats.bad} dòng hỏng trong ${file}`);
  return rows;
}

function readJsonFile(file, what) {
  if (!existsSync(file)) cliFail(`Không thấy ${what}: ${file}`);
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { cliFail(`${what} không phải JSON hợp lệ (${file}): ${String(error.message).slice(0, 80)}`); }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const cli = parseCliArgs(args, ['--trust', '--golden-window']);
  const [datasetPath, labelsPath, outPath, goldenPath] = cli.positional;
  if (!datasetPath || !labelsPath || !outPath) cliFail('Dùng: node tools-intent/merge-labels.mjs <dataset.jsonl> <labels.jsonl> <out.jsonl> [golden-set.json] [--trust replay-llm-out.json] [--keep-other] [--golden-window 10]');
  const rows = readJsonlFile(datasetPath, 'dataset');
  const labels = readJsonlFile(labelsPath, 'tệp nhãn LLM');
  const goldenItems = goldenPath ? readJsonFile(goldenPath, 'bộ chấm')?.items : [];
  const windowRaw = cli.value('--golden-window', '10');
  if (!(Number(windowRaw) >= 0)) cliFail(`--golden-window phải là số phút không âm (nhận "${windowRaw}").`);
  const golden = goldenPath ? goldenIndex(Array.isArray(goldenItems) ? goldenItems : [], { windowMs: Number(windowRaw) * 60000 }) : null;
  if (goldenPath && !golden.size) console.warn(`CẢNH BÁO bộ chấm ${goldenPath} không có mục nào: không loại được dòng golden.`);
  const trustPath = cli.value('--trust');
  let trust = null;
  if (trustPath) {
    const replay = readJsonFile(trustPath, 'tệp --trust');
    if (!Array.isArray(replay)) console.warn(`CẢNH BÁO ${trustPath} không phải mảng kết quả replay-llm: bỏ qua --trust.`);
    else trust = trustByClass(replay);
  }
  const { rows: out, stats } = mergeRows(rows, labels, { golden, trust, keepOther: cli.has('--keep-other') });
  writeFileSync(outPath, toJsonl(out));
  const counts = out.reduce((acc, row) => { acc[row.label] = (acc[row.label] || 0) + 1; return acc; }, {});
  const { changed, ...rest } = stats;
  console.log(JSON.stringify({ ...rest, top: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15) }));
  if (golden) console.log(`Bộ chấm ${goldenPath}: ${golden.size} mục · loại ${stats.golden || 0} dòng (id ${(stats.golden || 0) - (stats.goldenNear || 0) - (stats.goldenText || 0)} · cùng hội thoại ±${windowRaw} phút ${stats.goldenNear || 0} · trùng chữ ${stats.goldenText || 0})`);
  if (trust) console.log('Lớp yếu (pipeline < 80% hoặc n < 15; kết quả LỖI không tính):', [...trust.entries()].filter(([, entry]) => entry.weak).map(([label, entry]) => `${label} ${entry.agree}/${entry.n}${entry.errors ? ` (+${entry.errors} lỗi)` : ''}`).join(' · ') || 'không');
  if (changed) console.log('LLM đổi nhãn (gốc → LLM):', Object.entries(changed).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([pair, n]) => `${pair} ×${n}`).join(' · '));
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
