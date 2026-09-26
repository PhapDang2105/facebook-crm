// Trộn nhãn LLM vào tập huấn luyện mô hình nhỏ.
// Dùng: node tools-intent/merge-labels.mjs <dataset.jsonl> <labels.jsonl> <out.jsonl> [golden-set.json]
// Quy tắc: LLM tin cậy ≥ 0,8 → lấy nhãn LLM; LLM và nhãn gốc (câu bot đã trả lời) trùng → giữ;
// còn lại (LLM không chắc mà khác nhãn gốc) → bỏ, vì không biết bên nào đúng.
// Có golden-set.json → bỏ các tin nằm trong bộ chấm mẫu khỏi tập huấn luyện (bộ chấm chỉ để ĐO).
import { readFileSync, writeFileSync } from 'node:fs';
const [datasetPath, labelsPath, outPath, goldenPath] = process.argv.slice(2);
const rows = readFileSync(datasetPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const labels = new Map(readFileSync(labelsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.label && !item.error).map(item => [item.id, item]));
const golden = new Set(goldenPath ? (JSON.parse(readFileSync(goldenPath, 'utf8')).items || []).map(item => item.id) : []);
const stats = { total: rows.length, llmHigh: 0, agree: 0, dropped: 0, noLabel: 0, changed: 0, golden: 0 };
const out = [];
for (const row of rows) {
  if (golden.has(row.id)) { stats.golden += 1; continue; }
  const llm = labels.get(row.id);
  if (!llm) { stats.noLabel += 1; out.push(row); continue; }
  if (llm.confidence >= 0.8) { stats.llmHigh += 1; if (llm.label !== row.label) stats.changed += 1; out.push({ ...row, label: llm.label, labelSource: 'llm' }); continue; }
  if (llm.label === row.label) { stats.agree += 1; out.push({ ...row, labelSource: 'both' }); continue; }
  stats.dropped += 1;
}
writeFileSync(outPath, out.map(row => JSON.stringify(row)).join('\n'));
const counts = out.reduce((acc, row) => { acc[row.label] = (acc[row.label] || 0) + 1; return acc; }, {});
console.log(JSON.stringify({ ...stats, kept: out.length, top: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15) }));
