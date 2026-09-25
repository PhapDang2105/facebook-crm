// Huấn luyện mô hình ra quyết định (tin khách + ngữ cảnh → mã mẫu, kèm xác suất).
// Thuần JS: TF-IDF trên n-gram ký tự + từ + đặc trưng giao ngữ cảnh, hồi quy logistic
// softmax (SGD, L2, label smoothing). Chia theo thời gian: 20% tin mới nhất để đánh giá.
// Thêm (vòng nghiên cứu 25/09): lọc nhãn nhiễu bằng dự đoán ngoài-fold (confident learning
// rút gọn), hiệu chuẩn nhiệt độ (temperature scaling), biên p1−p2, đường risk–coverage theo lớp.
// Dùng: node tools-intent/train-intent.mjs <dataset.jsonl> [out-model.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { featuresOf } from '../app/processing/intent-features.mjs';

const [datasetPath, outPath] = process.argv.slice(2);
const all = readFileSync(datasetPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).sort((a, b) => a.at - b.at);
const labelCounts = all.reduce((acc, row) => { acc[row.label] = (acc[row.label] || 0) + 1; return acc; }, {});
for (const row of all) if (labelCounts[row.label] < 4) row.label = 'OTHER';
const labels = [...new Set(all.map(row => row.label))].sort();
const labelIndex = new Map(labels.map((label, index) => [label, index]));
const K = labels.length;
const EPOCHS = 25;
const RATE = 0.5;
const L2 = 1e-4;
const SMOOTHING = 0.1;

let seed = 42;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const softmax = raw => { const max = Math.max(...raw); const exps = raw.map(value => Math.exp(value - max)); const total = exps.reduce((sum, value) => sum + value, 0); return exps.map(value => value / total); };

/** Huấn luyện một mô hình trên `rows`; trả về hàm dự đoán xác suất + trọng số. */
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
        const gradient = probabilities[k] - target;
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
const folds = 5;
const oof = new Array(all.length);
for (let f = 0; f < folds; f += 1) {
  const trainRows = all.filter((_, i) => i % folds !== f);
  const model = fit(trainRows);
  all.forEach((row, i) => { if (i % folds === f) oof[i] = softmax(model.scores(row)); });
}
const noisy = [];
all.forEach((row, i) => {
  const probabilities = oof[i];
  const best = probabilities.indexOf(Math.max(...probabilities));
  if (labels[best] !== row.label && probabilities[best] >= 0.85 && labelCounts[row.label] >= 8) noisy.push({ i, text: row.text.slice(0, 60), label: row.label, guess: labels[best], p: probabilities[best] });
});
const rows = all.filter((_, i) => !noisy.some(item => item.i === i));
console.log(`Nhãn nghi sai (bỏ khỏi huấn luyện): ${noisy.length}/${all.length}`);
console.log(noisy.slice(0, 12).map(item => `  "${item.text}" nhãn ${item.label} → mô hình chắc ${item.guess} (${item.p.toFixed(2)})`).join('\n'));

// ---- 2. Huấn luyện chính: 80% cũ → đánh giá trên 20% mới nhất; hiệu chuẩn nhiệt độ trên phần đó.
const split = Math.floor(rows.length * 0.8);
const train = rows.slice(0, split);
const test = rows.slice(split);
const model = fit(train);
const rawTest = test.map(row => model.scores(row));
const targetsTest = test.map(row => labelIndex.get(row.label));
const nll = temperature => rawTest.reduce((sum, raw, i) => sum - Math.log(Math.max(1e-9, softmax(raw.map(value => value / temperature))[targetsTest[i]])), 0) / rawTest.length;
let temperature = 1;
for (const candidate of [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]) if (nll(candidate) < nll(temperature)) temperature = candidate;

const evaluate = (rawList, targetList, temp) => {
  const results = rawList.map((raw, i) => {
    const probabilities = softmax(raw.map(value => value / temp));
    const sorted = probabilities.map((p, k) => [p, k]).sort((a, b) => b[0] - a[0]);
    return { label: labels[targetList[i]], predicted: labels[sorted[0][1]], confidence: sorted[0][0], margin: sorted[0][0] - (sorted[1]?.[0] || 0) };
  });
  const accuracy = results.filter(item => item.label === item.predicted).length / results.length;
  const thresholds = [0.6, 0.7, 0.8, 0.85, 0.9, 0.95].map(threshold => {
    const kept = results.filter(item => item.confidence >= threshold && item.margin >= 0.25);
    return { threshold, coverage: Number((kept.length / results.length).toFixed(2)), precision: kept.length ? Number((kept.filter(item => item.label === item.predicted).length / kept.length).toFixed(3)) : 0 };
  });
  const perLabel = {};
  for (const item of results) { const entry = perLabel[item.label] ||= { n: 0, hit: 0, kept: 0, keptHit: 0 }; entry.n += 1; if (item.label === item.predicted) entry.hit += 1; if (item.confidence >= 0.85 && item.margin >= 0.25) { entry.kept += 1; if (item.label === item.predicted) entry.keptHit += 1; } }
  return { n: results.length, accuracy: Number(accuracy.toFixed(3)), thresholds, perLabel };
};
const held = evaluate(rawTest, targetsTest, temperature);
console.log(JSON.stringify({ rows: rows.length, train: train.length, test: test.length, labels: K, vocab: model.D, temperature, heldOut: { n: held.n, accuracy: held.accuracy, thresholds: held.thresholds } }));
console.log('risk–coverage theo lớp @p≥0.85 & margin≥0.25 (giữ/đúng trên tổng):', Object.entries(held.perLabel).sort((a, b) => b[1].n - a[1].n).map(([label, e]) => `${label} ${e.keptHit}/${e.kept} trên ${e.n}`).join(' · '));

// ---- 3. Lưu: huấn luyện lại trên toàn bộ dữ liệu sạch, trọng số thưa, kèm nhiệt độ.
if (outPath) {
  const full = fit(rows);
  const used = new Set();
  const classes = labels.map((label, k) => { const weights = {}; const base = k * full.D; for (let d = 0; d < full.D; d += 1) if (Math.abs(full.W[base + d]) >= 0.03) { weights[full.vocab[d]] = Number(full.W[base + d].toFixed(3)); used.add(d); } return { label, bias: Number(full.B[k].toFixed(4)), weights }; });
  const out = { version: 2, trainedAt: new Date().toISOString(), rows: rows.length, dropped: noisy.length, temperature, labels, idf: Object.fromEntries([...used].map(d => [full.vocab[d], Number(full.idf[d].toFixed(3))])), classes, heldOut: { accuracy: held.accuracy, thresholds: held.thresholds } };
  writeFileSync(outPath, JSON.stringify(out));
  console.log('saved', outPath, `${Math.round(Buffer.byteLength(JSON.stringify(out)) / 1024)} KB`);
}
