// Huấn luyện mô hình ra quyết định (tin khách + ngữ cảnh → mã mẫu, kèm xác suất).
// Thuần JS, không thư viện: đặc trưng n-gram ký tự (2–4) + từ (1–2) + ngữ cảnh, TF-IDF,
// hồi quy logistic softmax (SGD, L2). Chia theo thời gian: 20% tin mới nhất để đánh giá.
// Dùng: node tools-intent/train-intent.mjs <dataset.jsonl> <out-model.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { featuresOf } from '../app/processing/intent-features.mjs';

const [datasetPath, outPath] = process.argv.slice(2);
const rows = readFileSync(datasetPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).sort((a, b) => a.at - b.at);
// Nhãn quá hiếm (< 4 mẫu) không học được: gộp vào nhãn "OTHER" (mô hình sẽ không đủ tin cậy → LLM).
const labelCounts = rows.reduce((acc, row) => { acc[row.label] = (acc[row.label] || 0) + 1; return acc; }, {});
for (const row of rows) if (labelCounts[row.label] < 4) row.label = 'OTHER';
const labels = [...new Set(rows.map(row => row.label))].sort();
const labelIndex = new Map(labels.map((label, index) => [label, index]));

// Từ vựng: đặc trưng xuất hiện ≥ 2 lần trong tập huấn luyện.
const split = Math.floor(rows.length * 0.8);
const train = rows.slice(0, split);
const test = rows.slice(split);
const df = new Map();
const trainFeatures = train.map(row => { const set = featuresOf(row); for (const feature of set) df.set(feature, (df.get(feature) || 0) + 1); return set; });
const vocab = [...df.entries()].filter(([, count]) => count >= 2).map(([feature]) => feature);
const vocabIndex = new Map(vocab.map((feature, index) => [feature, index]));
const idf = new Float64Array(vocab.length);
for (const [feature, index] of vocabIndex) idf[index] = Math.log((train.length + 1) / (df.get(feature) + 1)) + 1;

function vectorOf(set) {
  const entries = [];
  for (const feature of set) { const index = vocabIndex.get(feature); if (index !== undefined) entries.push([index, idf[index]]); }
  const norm = Math.sqrt(entries.reduce((sum, [, value]) => sum + value * value, 0)) || 1;
  return entries.map(([index, value]) => [index, value / norm]);
}

const K = labels.length;
const D = vocab.length;
const weights = new Float64Array(K * D);
const bias = new Float64Array(K);
const vectors = trainFeatures.map(vectorOf);
const targets = train.map(row => labelIndex.get(row.label));
const epochs = 25;
const learningRate = 0.5;
const l2 = 1e-4;

function scores(vector) {
  const out = new Float64Array(K);
  for (let k = 0; k < K; k += 1) { let sum = bias[k]; const base = k * D; for (const [index, value] of vector) sum += weights[base + index] * value; out[k] = sum; }
  return out;
}
function softmax(raw) {
  const max = Math.max(...raw);
  const exps = raw.map(value => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map(value => value / total);
}
// Xáo trộn cố định để lặp lại được.
let seed = 42;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let epoch = 0; epoch < epochs; epoch += 1) {
  const order = vectors.map((_, index) => index).sort(() => random() - 0.5);
  const rate = learningRate / (1 + epoch * 0.15);
  for (const i of order) {
    const probabilities = softmax(Array.from(scores(vectors[i])));
    for (let k = 0; k < K; k += 1) {
      const gradient = probabilities[k] - (k === targets[i] ? 1 : 0);
      if (Math.abs(gradient) < 1e-6) continue;
      const base = k * D;
      for (const [index, value] of vectors[i]) weights[base + index] -= rate * (gradient * value + l2 * weights[base + index]);
      bias[k] -= rate * gradient;
    }
  }
}

// Đánh giá trên phần mới nhất: độ chính xác chung và theo ngưỡng tin cậy.
const evaluate = rowsToEval => {
  const results = rowsToEval.map(row => {
    const probabilities = softmax(Array.from(scores(vectorOf(featuresOf(row)))));
    let best = 0;
    for (let k = 1; k < K; k += 1) if (probabilities[k] > probabilities[best]) best = k;
    return { label: row.label, predicted: labels[best], confidence: probabilities[best] };
  });
  const accuracy = results.filter(item => item.label === item.predicted).length / results.length;
  const thresholds = [0.6, 0.7, 0.8, 0.9, 0.95].map(threshold => {
    const kept = results.filter(item => item.confidence >= threshold);
    return { threshold, coverage: kept.length / results.length, precision: kept.length ? kept.filter(item => item.label === item.predicted).length / kept.length : 0 };
  });
  const perLabel = {};
  for (const item of results) {
    const entry = perLabel[item.label] ||= { n: 0, hit: 0 };
    entry.n += 1;
    if (item.label === item.predicted) entry.hit += 1;
  }
  return { n: results.length, accuracy, thresholds, perLabel };
};
const held = evaluate(test);
console.log(JSON.stringify({ rows: rows.length, train: train.length, test: test.length, labels: K, vocab: D, heldOut: { n: held.n, accuracy: Number(held.accuracy.toFixed(3)), thresholds: held.thresholds.map(t => ({ ...t, coverage: Number(t.coverage.toFixed(2)), precision: Number(t.precision.toFixed(3)) })) } }));
console.log('per label (held-out):', Object.entries(held.perLabel).sort((a, b) => b[1].n - a[1].n).map(([label, e]) => `${label} ${e.hit}/${e.n}`).join(' · '));

if (outPath) {
  // Huấn luyện lại trên toàn bộ dữ liệu rồi lưu: trọng số thưa theo lớp (bỏ |w| < 0.01).
  const allFeatures = rows.map(row => featuresOf(row));
  const dfAll = new Map();
  for (const set of allFeatures) for (const feature of set) dfAll.set(feature, (dfAll.get(feature) || 0) + 1);
  const vocabAll = [...dfAll.entries()].filter(([, count]) => count >= 2).map(([feature]) => feature);
  const indexAll = new Map(vocabAll.map((feature, index) => [feature, index]));
  const idfAll = vocabAll.map(feature => Math.log((rows.length + 1) / (dfAll.get(feature) + 1)) + 1);
  const DA = vocabAll.length;
  const W = new Float64Array(K * DA);
  const B = new Float64Array(K);
  const vecs = allFeatures.map(set => { const entries = []; for (const feature of set) { const index = indexAll.get(feature); if (index !== undefined) entries.push([index, idfAll[index]]); } const norm = Math.sqrt(entries.reduce((sum, [, value]) => sum + value * value, 0)) || 1; return entries.map(([index, value]) => [index, value / norm]); });
  const tg = rows.map(row => labelIndex.get(row.label));
  seed = 42;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const order = vecs.map((_, index) => index).sort(() => random() - 0.5);
    const rate = learningRate / (1 + epoch * 0.15);
    for (const i of order) {
      const raw = new Float64Array(K);
      for (let k = 0; k < K; k += 1) { let sum = B[k]; const base = k * DA; for (const [index, value] of vecs[i]) sum += W[base + index] * value; raw[k] = sum; }
      const probabilities = softmax(Array.from(raw));
      for (let k = 0; k < K; k += 1) {
        const gradient = probabilities[k] - (k === tg[i] ? 1 : 0);
        if (Math.abs(gradient) < 1e-6) continue;
        const base = k * DA;
        for (const [index, value] of vecs[i]) W[base + index] -= rate * (gradient * value + l2 * W[base + index]);
        B[k] -= rate * gradient;
      }
    }
  }
  // Thưa: bỏ |w| < 0.03; idf chỉ giữ đặc trưng còn được lớp nào dùng (file nhỏ, nạp nhanh).
  const used = new Set();
  const sparse = labels.map((label, k) => { const entries = {}; const base = k * DA; for (let d = 0; d < DA; d += 1) if (Math.abs(W[base + d]) >= 0.03) { entries[vocabAll[d]] = Number(W[base + d].toFixed(3)); used.add(d); } return { label, bias: Number(B[k].toFixed(4)), weights: entries }; });
  const model = { version: 1, trainedAt: new Date().toISOString(), rows: rows.length, labels, idf: Object.fromEntries([...used].map(index => [vocabAll[index], Number(idfAll[index].toFixed(3))])), classes: sparse, heldOut: { accuracy: Number(held.accuracy.toFixed(3)), thresholds: held.thresholds } };
  writeFileSync(outPath, JSON.stringify(model));
  console.log('saved', outPath, `${Math.round(Buffer.byteLength(JSON.stringify(model)) / 1024)} KB`);
}
