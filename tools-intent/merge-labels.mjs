// Trộn nhãn cho tập huấn luyện mô hình nhỏ (hợp đồng v2).
// Dùng: node tools-intent/merge-labels.mjs <dataset.jsonl> <labels.jsonl> <out.jsonl> [golden-set.json] [--trust replay-llm-out.json]
// Ưu tiên: staff > rule > template/pipeline (nhãn KHÔNG thuộc POLICY_DRIFT) > llm.
//   - Nhãn LLM được nhận khi (a) trùng nhãn gốc → labelSource 'both', hoặc (b) khác nhãn gốc nhưng nhãn gốc
//     thuộc POLICY_DRIFT (câu bot đã gửi không chắc đúng: ORDER_ADDRESS, ASK_PRODUCT, GENERAL_INFO…) → 'llm'.
//   - --trust <replay-llm-out.json>: độ khớp pipeline (luật + LLM) theo lớp trên bộ chấm; lớp < 80% hoặc n < 15
//     → dòng nhãn lớp đó (không phải staff/rule) giữ nhưng weak:true (train-intent có thể giảm trọng số).
//   - Bỏ dòng OTHER, bỏ dòng thuộc bộ chấm mẫu (theo id), bỏ trường confidence.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { POLICY_DRIFT, readJsonl, toJsonl } from './dataset-context.mjs';

export const TRUST_MIN_ACCURACY = 0.8;
export const TRUST_MIN_ROWS = 15;

/** Độ khớp pipeline theo lớp từ replay-llm-out.json ([{ truth, pipeline }]) → Map nhãn → { n, agree, accuracy, weak }. */
export function trustByClass(replayRows) {
  const byClass = new Map();
  for (const row of replayRows || []) {
    if (!row?.truth) continue;
    const entry = byClass.get(row.truth) || { n: 0, agree: 0 };
    entry.n += 1;
    if (row.pipeline === row.truth) entry.agree += 1;
    byClass.set(row.truth, entry);
  }
  for (const entry of byClass.values()) { entry.accuracy = entry.n ? entry.agree / entry.n : 0; entry.weak = entry.n < TRUST_MIN_ROWS || entry.accuracy < TRUST_MIN_ACCURACY; }
  return byClass;
}

/** Trộn một dòng với nhãn LLM (nếu có) → dòng mới (null = bỏ). `stats` cộng dồn. */
export function mergeRow(row, llm, { golden = new Set(), trust = null, stats = {} } = {}) {
  const bump = key => { stats[key] = (stats[key] || 0) + 1; };
  if (golden.has(row.id)) { bump('golden'); return null; }
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
  if (out.label === 'OTHER' || !out.label) { bump('other'); return null; }
  // Độ tin cậy theo lớp: nhãn lớp yếu (không phải nhân viên/luật) giữ nhưng đánh dấu weak.
  if (trust && !(out.labelSource === 'staff' || out.corrected || out.labelSource === 'rule')) {
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

function main() {
  const args = process.argv.slice(2);
  const valueFlags = new Set(['--trust']);
  const positional = args.filter((arg, index) => !arg.startsWith('--') && !valueFlags.has(args[index - 1]));
  const [datasetPath, labelsPath, outPath, goldenPath] = positional;
  if (!datasetPath || !labelsPath || !outPath) { console.log('Dùng: node tools-intent/merge-labels.mjs <dataset.jsonl> <labels.jsonl> <out.jsonl> [golden-set.json] [--trust replay-llm-out.json]'); process.exit(1); }
  const rows = readJsonl(readFileSync(datasetPath, 'utf8'));
  const labels = readJsonl(readFileSync(labelsPath, 'utf8'));
  const golden = new Set(goldenPath ? (JSON.parse(readFileSync(goldenPath, 'utf8')).items || []).map(item => item.id) : []);
  const trustPath = args.includes('--trust') ? args[args.indexOf('--trust') + 1] : '';
  const trust = trustPath ? trustByClass(JSON.parse(readFileSync(trustPath, 'utf8'))) : null;
  const { rows: out, stats } = mergeRows(rows, labels, { golden, trust });
  writeFileSync(outPath, toJsonl(out));
  const counts = out.reduce((acc, row) => { acc[row.label] = (acc[row.label] || 0) + 1; return acc; }, {});
  const { changed, ...rest } = stats;
  console.log(JSON.stringify({ ...rest, top: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15) }));
  if (trust) console.log('Lớp yếu (pipeline < 80% hoặc n < 15):', [...trust.entries()].filter(([, entry]) => entry.weak).map(([label, entry]) => `${label} ${entry.agree}/${entry.n}`).join(' · ') || 'không');
  if (changed) console.log('LLM đổi nhãn (gốc → LLM):', Object.entries(changed).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([pair, n]) => `${pair} ×${n}`).join(' · '));
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
