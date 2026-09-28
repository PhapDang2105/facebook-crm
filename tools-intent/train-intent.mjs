// Huấn luyện mô hình ra quyết định (tin khách + ngữ cảnh → mã mẫu, kèm xác suất).
// Thuần JS: TF-IDF trên n-gram ký tự + từ + đặc trưng giao ngữ cảnh (intent-features.mjs, hợp đồng
// dữ liệu v2), hồi quy logistic softmax (SGD, L2, label smoothing, trọng số mẫu).
// Chia theo thời gian: 20% tin mới nhất để đánh giá và hiệu chuẩn.
// Vòng 6 (28/09):
//   - dòng nhân viên (labelSource 'staff' / corrected) được MIỄN bộ lọc nhiễu và nặng ×2;
//     dòng yếu (weak / labelSource 'llm') nhẹ ×0,7;
//   - bỏ dòng nhãn OTHER và dòng thuộc lớp < 4 mẫu (in danh sách), không gom về OTHER nữa;
//   - hiệu chuẩn CHỈ nhiệt độ (1 tham số) trên phần giữ-out, in ECE 10 ngăn + bảng p/đúng;
//   - đánh giá riêng tập rule-miss (ruleTemplate rỗng/thiếu: luật ổn định không bắt → phần mô hình thật sự quyết);
//   - ghi meta.calibration / trainedAt / rows / ruleMiss vào JSON (v5 top-level temperature vẫn ghi để tương thích).
// Vòng 7 (28/09, mô hình tầng): phần huấn luyện tách thành `trainClassifier(rows, options)` dùng chung với
//   tools-intent/train-cascade.mjs (mỗi mô hình con của tầng là một mô hình định dạng intent-model.json);
//   CLI giữ nguyên đầu ra.
// Vòng 12 (28/09):
//   - mỗi dòng đi qua intentRowFromRecord (intent-features.intentRowOf — MỘT định nghĩa row với engine) trước khi lấy
//     đặc trưng: mã con → mã engine lưu, lastWasOrderStep/prevBotAsks/hasOrder (< 24 giờ) như lúc chạy;
//   - bỏ dòng bình luận (source comment) và nhãn COMMENT_* / LIVESTREAM_COMMENT khỏi mô hình hộp thư (--include-comments để giữ);
//   - meta.trainIds (băm FNV-1a id các dòng dataset) để replay-golden biết mô hình đã thấy mục golden nào;
//     --golden <golden.json>: meta.goldenExcluded { source, goldenIds, matchedRows, matchedIds, byKind } và meta.sawGolden
//     (true = dataset CHỨA mục golden → mô hình không dùng để đo); không có --golden → sawGolden null (không rõ).
// Dùng: node tools-intent/train-intent.mjs <dataset.jsonl> [out-model.json] [--holdout 0.2] [--golden golden.json] [--include-comments] [--quiet]
//   --quiet: không in nhật ký/bảng, chỉ một dòng "saved …" (hay lỗi).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { featuresOf, intentRowFromRecord } from '../app/processing/intent-features.mjs';
import { cliFail, parseCliArgs, readJsonl } from './dataset-context.mjs';
import { goldenIndex, goldenMatch } from './merge-labels.mjs';

export const MIN_CLASS = 4;
const EPOCHS = 25;
const RATE = 0.5;
const L2 = 1e-4;
const SMOOTHING = 0.1;

/** Dòng nhân viên (quý nhất) và dòng nhân viên sửa bot: nặng ×2; nhãn yếu / do LLM gán: ×0,7. */
export function sampleWeight(row) {
  if (row.corrected || row.labelSource === 'staff') return 2;
  if (row.weak || row.labelSource === 'llm') return 0.7;
  return 1;
}
export const isStaffRow = row => Boolean(row.corrected) || row.labelSource === 'staff';
export const isRuleMiss = row => !row.ruleTemplate;
/** Dòng bình luận (nguồn comment hay nhãn luồng bình luận): không thuộc mô hình hộp thư. */
export const isCommentRow = row => row?.source === 'comment' || /^COMMENT_/.test(String(row?.label || '')) || row?.label === 'LIVESTREAM_COMMENT';

/** Băm FNV-1a 32 bit (hex) của một id dòng — meta.trainIds gọn mà vẫn so được với id golden. */
export function hashId(id) {
  let hash = 2166136261;
  const value = String(id || '');
  for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
/** meta.trainIds: băm id mọi dòng dataset đem huấn luyện (kể cả dòng bị lọc sau đó — mô hình đã "thấy" dataset). */
export const trainIdsOf = rows => ({ hash: 'fnv1a32', n: rows.length, ids: [...new Set(rows.filter(row => row?.id).map(row => hashId(row.id)))].sort() });

/**
 * Dataset có chứa mục golden không (goldenMatch của merge-labels: id / cùng hội thoại ±10 phút / trùng chữ).
 * @returns {{ source: string, goldenIds: number, matchedRows: number, matchedIds: number, byKind: Record<string, number> }}
 */
export function goldenOverlap(rows, goldenItems, source = '') {
  const index = goldenIndex(goldenItems);
  const byKind = {};
  const matchedIds = new Set();
  let matchedRows = 0;
  for (const row of rows) {
    const kind = goldenMatch(row, index);
    if (!kind) continue;
    matchedRows += 1;
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (kind === 'id') matchedIds.add(row.id);
  }
  return { source, goldenIds: index.size, matchedRows, matchedIds: matchedIds.size, byKind };
}

/** meta.goldenExcluded / meta.sawGolden từ goldenOverlap (null = không có bộ chấm để so → không rõ). */
export const goldenMetaOf = overlap => (overlap ? { goldenExcluded: { ...overlap, excluded: Math.max(0, overlap.goldenIds - overlap.matchedIds) }, sawGolden: overlap.matchedRows > 0 } : { goldenExcluded: null, sawGolden: null });

const softmax = raw => { const max = Math.max(...raw); const exps = raw.map(value => Math.exp(value - max)); const total = exps.reduce((sum, value) => sum + value, 0); return exps.map(value => value / total); };

/** Đọc dataset JSONL: bỏ dòng thiếu text/label và dòng hỏng (ghi dở — đếm vào stats.bad), sắp theo thời gian. */
export function readDataset(file, stats = {}) {
  return readJsonl(readFileSync(file, 'utf8'), stats).filter(row => row && row.text && row.label).sort((a, b) => (a.at || 0) - (b.at || 0));
}

/** ECE 10 ngăn + bảng p-dự-đoán / đúng-thật theo ngăn. */
export function calibrationTable(results, bins = 10) {
  const table = Array.from({ length: bins }, (_, b) => ({ lo: Number((b / bins).toFixed(2)), hi: Number(((b + 1) / bins).toFixed(2)), n: 0, pSum: 0, hit: 0 }));
  for (const item of results) {
    const b = Math.min(bins - 1, Math.floor(item.confidence * bins));
    table[b].n += 1; table[b].pSum += item.confidence; if (item.label === item.predicted) table[b].hit += 1;
  }
  const total = results.length || 1;
  let ece = 0;
  const rows = table.map(bin => { const meanP = bin.n ? bin.pSum / bin.n : 0; const accuracy = bin.n ? bin.hit / bin.n : 0; ece += (bin.n / total) * Math.abs(accuracy - meanP); return { lo: bin.lo, hi: bin.hi, n: bin.n, meanP: Number(meanP.toFixed(3)), accuracy: Number(accuracy.toFixed(3)) }; });
  return { ece: Number(ece.toFixed(4)), bins: rows };
}

/**
 * Huấn luyện MỘT bộ phân loại softmax trên `inputRows` (hợp đồng v2, đã hoặc chưa sắp theo `at`):
 * bỏ OTHER và lớp < minClass, lọc nhãn nhiễu ngoài-fold (miễn dòng nhân viên), chia theo thời gian
 * (holdout mới nhất) để đánh giá + hiệu chuẩn nhiệt độ, rồi huấn luyện lại trên toàn bộ dòng sạch.
 * `log` nhận các dòng nhật ký giống CLI train-intent (mặc định im lặng). `dropOther: false` giữ nhãn OTHER làm
 * một lớp thường (mô hình nhóm của tầng cần lớp "từ chối").
 * @param {object[]} inputRows
 * Dòng bình luận / COMMENT_* bị bỏ (includeComments: true để giữ); mọi dòng đi qua intentRowFromRecord.
 * `recordIds` (mặc định true): ghi meta.trainIds; `meta` (object) được gộp vào meta của mô hình.
 * @param {{ holdout?: number, minClass?: number, log?: (...parts: string[]) => void, full?: boolean, dropOther?: boolean, includeComments?: boolean, recordIds?: boolean, meta?: object }} [options]
 * @returns {{ model: object | null, report: object }} model = JSON định dạng intent-model.json (null khi full=false)
 * @throws {Error} khi còn < 10 dòng sau khi lọc ('Quá ít dòng để huấn luyện.')
 */
export function trainClassifier(inputRows, options = {}) {
  const HOLDOUT = options.holdout ?? 0.2;
  const minClass = options.minClass ?? MIN_CLASS;
  const log = options.log || (() => {});
  const full = options.full ?? true;
  const dropOther = options.dropOther ?? true;

  const includeComments = options.includeComments ?? false;
  // ---- 0. Bỏ bình luận, OTHER và lớp quá nhỏ, gán trọng số mẫu; ngữ cảnh dựng lại như lúc chạy (intentRowOf).
  const valid = inputRows.filter(row => row && row.text && row.label);
  const commentRows = includeComments ? [] : valid.filter(isCommentRow);
  const loaded = (includeComments ? valid : valid.filter(row => !isCommentRow(row))).map(intentRowFromRecord).sort((a, b) => (a.at || 0) - (b.at || 0));
  const otherRows = dropOther ? loaded.filter(row => row.label === 'OTHER') : [];
  const kept = dropOther ? loaded.filter(row => row.label !== 'OTHER') : loaded;
  const labelCounts = kept.reduce((acc, row) => { acc[row.label] = (acc[row.label] || 0) + 1; return acc; }, {});
  const droppedClasses = Object.entries(labelCounts).filter(([, count]) => count < minClass).map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label));
  const droppedSet = new Set(droppedClasses.map(item => item.label));
  const all = kept.filter(row => !droppedSet.has(row.label));
  log(`Dòng: ${loaded.length + commentRows.length}${commentRows.length ? ` · bỏ bình luận/COMMENT_* ${commentRows.length}` : ''} · bỏ OTHER ${otherRows.length} · bỏ lớp < ${minClass} mẫu: ${droppedClasses.length ? droppedClasses.map(item => `${item.label} (${item.count})`).join(', ') : 'không'} → còn ${all.length}`);
  if (all.length < 10) throw new Error('Quá ít dòng để huấn luyện.');
  const labels = [...new Set(all.map(row => row.label))].sort();
  const labelIndex = new Map(labels.map((label, index) => [label, index]));
  const K = labels.length;

  let seed = 42;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  /** Huấn luyện một mô hình trên `rows` (có trọng số mẫu); trả về hàm tính điểm + trọng số. */
  function fit(rows) {
    const featureSets = rows.map(row => featuresOf(row));
    const df = new Map();
    for (const set of featureSets) for (const feature of set) df.set(feature, (df.get(feature) || 0) + 1);
    const vocab = [...df.entries()].filter(([, count]) => count >= 2).map(([feature]) => feature);
    const index = new Map(vocab.map((feature, i) => [feature, i]));
    const idf = vocab.map(feature => Math.log((rows.length + 1) / (df.get(feature) + 1)) + 1);
    const D = vocab.length;
    const vectorOf = set => {
      const entries = [];
      for (const feature of set) { const i = index.get(feature); if (i !== undefined) entries.push([i, idf[i]]); }
      const norm = Math.sqrt(entries.reduce((sum, [, value]) => sum + value * value, 0)) || 1;
      return entries.map(([i, value]) => [i, value / norm]);
    };
    const vectors = featureSets.map(vectorOf);
    const targets = rows.map(row => labelIndex.get(row.label));
    const weights = rows.map(sampleWeight);
    const W = new Float64Array(K * D);
    const B = new Float64Array(K);
    const scoresOf = vector => { const out = new Float64Array(K); for (let k = 0; k < K; k += 1) { let sum = B[k]; const base = k * D; for (const [i, value] of vector) sum += W[base + i] * value; out[k] = sum; } return Array.from(out); };
    seed = 42;
    for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
      const order = vectors.map((_, i) => i).sort(() => random() - 0.5);
      const rate = RATE / (1 + epoch * 0.15);
      for (const i of order) {
        const probabilities = softmax(scoresOf(vectors[i]));
        for (let k = 0; k < K; k += 1) {
          // Label smoothing: đích = (1−ε)·one-hot + ε/K → xác suất bớt cực đoan, hiệu chuẩn tốt hơn.
          const target = (k === targets[i] ? 1 - SMOOTHING : 0) + SMOOTHING / K;
          // Trọng số mẫu nhân vào gradient (SGD có trọng số) — không cần lặp dòng.
          const gradient = (probabilities[k] - target) * weights[i];
          if (Math.abs(gradient) < 1e-6) continue;
          const base = k * D;
          for (const [i2, value] of vectors[i]) W[base + i2] -= rate * (gradient * value + L2 * W[base + i2]);
          B[k] -= rate * gradient;
        }
      }
    }
    return { vocab, idf, W, B, D, scores: row => scoresOf(vectorOf(featuresOf(row))) };
  }

  // ---- 1. Lọc nhãn nhiễu: dự đoán ngoài-fold (5 phần); cặp mà mô hình rất chắc là nhãn KHÁC → bỏ.
  //         Dòng nhân viên (staff/corrected) được miễn: chính là chỗ mô hình đang sai chứ không phải nhãn sai.
  const folds = 5;
  const oof = new Array(all.length);
  for (let f = 0; f < folds; f += 1) {
    const trainRows = all.filter((_, i) => i % folds !== f);
    const model = fit(trainRows);
    all.forEach((row, i) => { if (i % folds === f) oof[i] = softmax(model.scores(row)); });
  }
  const noisy = [];
  let exempt = 0;
  all.forEach((row, i) => {
    const probabilities = oof[i];
    const best = probabilities.indexOf(Math.max(...probabilities));
    if (labels[best] === row.label || probabilities[best] < 0.85 || labelCounts[row.label] < 8) return;
    if (isStaffRow(row)) { exempt += 1; return; }
    noisy.push({ i, text: String(row.text).slice(0, 60), label: row.label, guess: labels[best], p: probabilities[best] });
  });
  const noisySet = new Set(noisy.map(item => item.i));
  const rows = all.filter((_, i) => !noisySet.has(i));
  log(`Nhãn nghi sai (bỏ khỏi huấn luyện): ${noisy.length}/${all.length} · dòng nhân viên được miễn: ${exempt}`);
  if (noisy.length) log(noisy.slice(0, 12).map(item => `  "${item.text}" nhãn ${item.label} → mô hình chắc ${item.guess} (${item.p.toFixed(2)})`).join('\n'));

  // ---- 2. Huấn luyện chính: (1−HOLDOUT) cũ → đánh giá trên phần mới nhất; hiệu chuẩn nhiệt độ trên phần đó.
  const split = Math.max(1, Math.floor(rows.length * (1 - HOLDOUT)));
  const train = rows.slice(0, split);
  const test = rows.slice(split);
  const model = fit(train);
  const rawTest = test.map(row => model.scores(row));
  const targetsTest = test.map(row => labelIndex.get(row.label));
  // Chỉ MỘT tham số (nhiệt độ), chọn theo NLL trên phần giữ-out; không bias theo lớp để không "học" lại phần giữ-out.
  const nll = temperature => rawTest.reduce((sum, raw, i) => sum - Math.log(Math.max(1e-9, softmax(raw.map(value => value / temperature))[targetsTest[i]])), 0) / Math.max(1, rawTest.length);
  let temperature = 1;
  if (rawTest.length) {
    const grid = [];
    for (let t = 0.5; t <= 3.0001; t += 0.05) grid.push(Number(t.toFixed(2)));
    for (const candidate of grid) if (nll(candidate) < nll(temperature) - 1e-12) temperature = candidate;
  }

  const evaluate = (rawList, targetList, temp) => {
    const results = rawList.map((raw, i) => {
      const probabilities = softmax(raw.map(value => value / temp));
      const sorted = probabilities.map((p, k) => [p, k]).sort((a, b) => b[0] - a[0]);
      return { label: labels[targetList[i]], predicted: labels[sorted[0][1]], confidence: sorted[0][0], margin: sorted[0][0] - (sorted[1]?.[0] || 0) };
    });
    const n = results.length;
    const accuracy = n ? results.filter(item => item.label === item.predicted).length / n : 0;
    const thresholds = [0.6, 0.7, 0.8, 0.85, 0.9, 0.95].map(threshold => {
      const kept = results.filter(item => item.confidence >= threshold && item.margin >= 0.25);
      return { threshold, coverage: n ? Number((kept.length / n).toFixed(2)) : 0, precision: kept.length ? Number((kept.filter(item => item.label === item.predicted).length / kept.length).toFixed(3)) : 0 };
    });
    const perLabel = {};
    for (const item of results) { const entry = perLabel[item.label] ||= { n: 0, hit: 0, pSum: 0, kept: 0, keptHit: 0 }; entry.n += 1; entry.pSum += item.confidence; if (item.label === item.predicted) entry.hit += 1; if (item.confidence >= 0.85 && item.margin >= 0.25) { entry.kept += 1; if (item.label === item.predicted) entry.keptHit += 1; } }
    return { n, accuracy: Number(accuracy.toFixed(3)), thresholds, perLabel, results };
  };

  const held = evaluate(rawTest, targetsTest, temperature);
  const heldRaw = evaluate(rawTest, targetsTest, 1);
  const calibration = calibrationTable(held.results);
  const calibrationRaw = calibrationTable(heldRaw.results);
  const ruleMissIndex = test.map((row, i) => (isRuleMiss(row) ? i : -1)).filter(i => i >= 0);
  const ruleMiss = evaluate(ruleMissIndex.map(i => rawTest[i]), ruleMissIndex.map(i => targetsTest[i]), temperature);
  const staffIndex = test.map((row, i) => (isStaffRow(row) ? i : -1)).filter(i => i >= 0);
  const staffHeld = evaluate(staffIndex.map(i => rawTest[i]), staffIndex.map(i => targetsTest[i]), temperature);
  const weightSummary = rows.reduce((acc, row) => { const w = sampleWeight(row); acc[w] = (acc[w] || 0) + 1; return acc; }, {});
  const report = {
    holdout: HOLDOUT, rows: rows.length, train: train.length, test: test.length, labels, K, vocab: model.D, temperature,
    nll: Number(nll(temperature).toFixed(4)), nllRaw: Number(nll(1).toFixed(4)), weights: weightSummary,
    dataset: { loaded: loaded.length, comments: commentRows.length, other: otherRows.length, droppedClasses, noisy: noisy.length, staffExempt: exempt, weights: weightSummary },
    held, heldRaw, calibration, calibrationRaw, ruleMiss, staffHeld, noisy
  };
  if (!full) return { model: null, report };

  // ---- 3. Huấn luyện lại trên toàn bộ dữ liệu sạch, trọng số thưa, kèm meta hiệu chuẩn.
  const fullModel = fit(rows);
  const used = new Set();
  const classes = labels.map((label, k) => { const weights = {}; const base = k * fullModel.D; for (let d = 0; d < fullModel.D; d += 1) if (Math.abs(fullModel.W[base + d]) >= 0.03) { weights[fullModel.vocab[d]] = Number(fullModel.W[base + d].toFixed(3)); used.add(d); } return { label, bias: Number(fullModel.B[k].toFixed(4)), weights }; });
  const trainedAt = new Date().toISOString();
  const strip = evaluation => ({ n: evaluation.n, accuracy: evaluation.accuracy, thresholds: evaluation.thresholds, perLabel: Object.fromEntries(Object.entries(evaluation.perLabel).map(([label, e]) => [label, { n: e.n, hit: e.hit, meanP: Number((e.pSum / e.n).toFixed(3)) }])) });
  const meta = {
    version: 3,
    trainedAt,
    rows: rows.length,
    dataset: report.dataset,
    holdout: HOLDOUT,
    calibration: { method: 'temperature', temperature, heldOut: held.n, nll: report.nll, nllRaw: report.nllRaw, ece: calibration.ece, eceRaw: calibrationRaw.ece, bins: calibration.bins },
    heldOut: strip(held),
    ruleMiss: strip(ruleMiss),
    staffHeldOut: { n: staffHeld.n, accuracy: staffHeld.accuracy },
    ...(options.recordIds === false ? {} : { trainIds: trainIdsOf(valid) }),
    ...(options.meta || {})
  };
  const out = {
    version: 3, trainedAt, rows: rows.length, dropped: noisy.length, temperature, labels,
    idf: Object.fromEntries([...used].map(d => [fullModel.vocab[d], Number(fullModel.idf[d].toFixed(3))])),
    classes,
    heldOut: { accuracy: held.accuracy, thresholds: held.thresholds },
    meta
  };
  return { model: out, report };
}

const pct = value => `${(100 * value).toFixed(1)}%`;
const thresholdLine = thresholds => thresholds.map(item => `p≥${item.threshold}: phủ ${pct(item.coverage)} đúng ${pct(item.precision)}`).join(' · ');

/** In báo cáo giữ-out / hiệu chuẩn / rule-miss như CLI train-intent (dùng lại cho từng mô hình con của tầng). */
export function printTrainingReport(report, log = console.log) {
  const { held, calibration, calibrationRaw, ruleMiss, staffHeld, temperature } = report;
  log(`\nGiữ-out (${pct(report.holdout)} mới nhất theo thời gian): ${held.n} dòng · đúng thô ${pct(held.accuracy)} · nhiệt độ ${temperature} (NLL ${report.nll.toFixed(3)}, chưa hiệu chuẩn ${report.nllRaw.toFixed(3)})`);
  log(`  ${thresholdLine(held.thresholds)}`);
  log(`  ECE 10 ngăn: ${calibration.ece} (chưa hiệu chuẩn ${calibrationRaw.ece})`);
  log('  ngăn p        n   p TB    đúng thật');
  for (const bin of calibration.bins) if (bin.n) log(`  [${bin.lo.toFixed(1)}–${bin.hi.toFixed(1)})  ${String(bin.n).padStart(4)}   ${bin.meanP.toFixed(3)}   ${pct(bin.accuracy)}`);
  log(`\nTập rule-miss trong giữ-out (luật ổn định không bắt): ${ruleMiss.n}/${held.n} dòng · đúng thô ${ruleMiss.n ? pct(ruleMiss.accuracy) : '–'}`);
  if (ruleMiss.n) {
    log(`  ${thresholdLine(ruleMiss.thresholds)}`);
    log('  nhãn                          n   đúng   p TB');
    for (const [label, entry] of Object.entries(ruleMiss.perLabel).sort((a, b) => b[1].n - a[1].n)) log(`  ${label.padEnd(28)} ${String(entry.n).padStart(4)}   ${String(entry.hit).padStart(4)}   ${(entry.pSum / entry.n).toFixed(2)}`);
  }
  if (staffHeld.n) log(`\nDòng nhân viên trong giữ-out: ${staffHeld.n} · đúng thô ${pct(staffHeld.accuracy)}`);
  log(`\nrisk–coverage theo lớp @p≥0.85 & margin≥0.25 (giữ/đúng trên tổng): ${Object.entries(held.perLabel).sort((a, b) => b[1].n - a[1].n).map(([label, e]) => `${label} ${e.keptHit}/${e.kept} trên ${e.n}`).join(' · ')}`);
  log(JSON.stringify({ rows: report.rows, train: report.train, test: report.test, labels: report.K, vocab: report.vocab, temperature, weights: report.weights, heldOut: { n: held.n, accuracy: held.accuracy }, ruleMiss: { n: ruleMiss.n, accuracy: ruleMiss.accuracy } }));
}

// ---- CLI (chỉ chạy khi gọi trực tiếp; import từ train-cascade / test thì không).
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const cli = parseCliArgs(args, ['--holdout', '--golden']);
  const [datasetPath, outPath] = cli.positional;
  if (!datasetPath) cliFail('Dùng: node tools-intent/train-intent.mjs <dataset.jsonl> [out-model.json] [--holdout 0.2] [--golden golden.json] [--include-comments] [--quiet]');
  if (!existsSync(datasetPath)) cliFail(`Không thấy dataset: ${datasetPath}`);
  const holdoutRaw = cli.value('--holdout');
  if (holdoutRaw && !(Number(holdoutRaw) > 0 && Number(holdoutRaw) < 1)) cliFail(`--holdout phải là số trong (0, 1) (nhận "${holdoutRaw}").`);
  const HOLDOUT = holdoutRaw ? Math.min(0.5, Math.max(0.05, Number(holdoutRaw))) : 0.2;
  const goldenPath = cli.value('--golden');
  if (goldenPath && !existsSync(goldenPath)) cliFail(`Không thấy bộ chấm --golden: ${goldenPath}`);
  const quiet = cli.has('--quiet');
  const log = quiet ? () => {} : (...parts) => console.log(...parts);
  const readStats = {};
  const dataset = readDataset(datasetPath, readStats);
  if (readStats.bad) console.warn(`Bỏ ${readStats.bad} dòng hỏng trong ${datasetPath}`);
  let goldenMeta = goldenMetaOf(null);
  if (goldenPath) {
    let items;
    try { items = JSON.parse(readFileSync(goldenPath, 'utf8')).items; } catch (error) { cliFail(`Bộ chấm ${goldenPath} không đọc được: ${String(error.message).slice(0, 80)}`); }
    goldenMeta = goldenMetaOf(goldenOverlap(dataset, Array.isArray(items) ? items : [], goldenPath));
    const overlap = goldenMeta.goldenExcluded;
    if (goldenMeta.sawGolden) console.warn(`CẢNH BÁO dataset CHỨA ${overlap.matchedRows} dòng thuộc bộ chấm (${JSON.stringify(overlap.byKind)}): mô hình này KHÔNG dùng để đo trên ${goldenPath} (meta.sawGolden = true).`);
    else log(`Bộ chấm ${goldenPath}: ${overlap.goldenIds} mục, dataset không chứa mục nào (meta.sawGolden = false).`);
  }
  let trained;
  try {
    trained = trainClassifier(dataset, { holdout: HOLDOUT, log, full: Boolean(outPath), includeComments: cli.has('--include-comments'), meta: goldenMeta });
  } catch (error) {
    if (error.message !== 'Quá ít dòng để huấn luyện.') throw error;
    cliFail(error.message);
  }
  printTrainingReport(trained.report, log);
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(trained.model));
    console.log('saved', outPath, `${Math.round(Buffer.byteLength(JSON.stringify(trained.model)) / 1024)} KB`, `· sawGolden ${goldenMeta.sawGolden === null ? 'không rõ (không có --golden)' : goldenMeta.sawGolden}`);
  }
}
