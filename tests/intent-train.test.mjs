import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticDataset, syntheticLabels } from './helpers/intent-synthetic.mjs';
import { loadIntentModelFrom, predictIntentWith } from '../app/processing/intent-model.mjs';
import { decisionLabelOf } from '../app/processing/intent-features.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(path.join(tmpdir(), 'intent-train-'));
const datasetPath = path.join(directory, 'dataset.jsonl');
const modelPath = path.join(directory, 'model-v6.json');
const run = (script, args, env = {}) => spawnSync(process.execPath, [path.join(root, 'tools-intent', script), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CRM_TEST_VERBOSE: '1', ...env } });
test.after(() => rmSync(directory, { recursive: true, force: true }));
// Dữ liệu tổng hợp nhỏ: 5 vòng (epoch) là đủ cho các khẳng định dưới đây; mặc định CLI vẫn 25 (tools-intent/train-intent.mjs).
process.env.INTENT_TRAIN_EPOCHS ||= '5';
const runAsync = (script, args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'tools-intent', script), ...args], { cwd: root, env: { ...process.env, CRM_TEST_VERBOSE: '1', ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', status => resolve({ status, stdout, stderr }));
});

test('train-intent: dataset v2 tổng hợp → bỏ OTHER + lớp < 4 mẫu, trọng số staff ×2 / weak ×0,7, hiệu chuẩn nhiệt độ, meta đầy đủ, mô hình dự đoán được', () => {
  const rows = syntheticDataset(20);
  writeFileSync(datasetPath, rows.map(row => JSON.stringify(row)).join('\n'));
  const result = run('train-intent.mjs', [datasetPath, modelPath]);
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  assert.match(out, /bỏ OTHER 3/);
  assert.match(out, /bỏ lớp < 4 mẫu: VAT_INVOICE \(2\)/);
  assert.match(out, /ECE 10 ngăn: [\d.]+ \(chưa hiệu chuẩn [\d.]+\)/);
  assert.match(out, /ngăn p\s+n\s+p TB\s+đúng thật/);
  assert.match(out, /Tập rule-miss trong giữ-out \(luật ổn định không bắt\): \d+\/\d+ dòng/);
  assert.match(out, /dòng nhân viên được miễn/);
  const saved = JSON.parse(readFileSync(modelPath, 'utf8'));
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.labels, [...new Set(syntheticLabels.map(decisionLabelOf))].sort(), 'OTHER và VAT_INVOICE không nằm trong nhãn; ORDER_ADDRESS_PARTIAL (mẫu con) học như ORDER_ADDRESS');
  assert.ok(!saved.labels.includes('ORDER_ADDRESS_PARTIAL'));
  assert.ok(saved.meta && saved.meta.trainedAt && saved.meta.rows === 140);
  assert.equal(saved.meta.calibration.method, 'temperature');
  assert.ok(saved.meta.calibration.temperature >= 0.5 && saved.meta.calibration.temperature <= 3);
  assert.equal(saved.temperature, saved.meta.calibration.temperature, 'top-level temperature (v5) = meta.calibration (v6)');
  assert.equal(saved.meta.calibration.bins.length, 10);
  assert.ok(typeof saved.meta.calibration.ece === 'number' && saved.meta.calibration.ece <= saved.meta.calibration.eceRaw + 1e-9, 'hiệu chuẩn không làm ECE tệ hơn');
  assert.ok(saved.meta.ruleMiss && saved.meta.ruleMiss.n > 0 && saved.meta.ruleMiss.perLabel);
  assert.deepEqual(saved.meta.dataset.droppedClasses, [{ label: 'VAT_INVOICE', count: 2 }]);
  assert.deepEqual(saved.meta.dataset.weights, { 1: 91, 2: 21, 0.7: 28 }, 'staff/corrected ×2, weak/llm ×0,7');
  const model = loadIntentModelFrom(modelPath);
  assert.equal(model.temperature, saved.meta.calibration.temperature);
  const address = predictIntentWith(model, { text: '<sdt> 3 lê lợi phường 7 quận 5', source: 'inbox', lastTemplate: 'ORDER_ADDRESS', lastWasOrderStep: true, hasBasket: true, prevBotAsks: 'phone_address', phoneInText: true, addressInText: true, bagCount: 0 });
  assert.equal(address.templateId, 'ORDER_ADDRESS');
  const phone = predictIntentWith(model, { text: 'sđt <sdt>', source: 'inbox', lastTemplate: 'ORDER_ADDRESS', lastWasOrderStep: true, hasBasket: true, prevBotAsks: 'phone_address', phoneInText: true, addressInText: false, bagCount: 0 });
  assert.equal(phone.templateId, 'ORDER_ADDRESS', 'chỉ SĐT: mô hình quyết ORDER_ADDRESS, bộ soạn chọn mẫu con PARTIAL');
  assert.equal(predictIntentWith(model, { text: 'giá bao nhiêu vậy', source: 'inbox', lastTemplate: '' }).templateId, 'PRICE_QUOTE', 'thiếu ctx v2 vẫn đoán');
  assert.equal(address.topK.length, 3);
});

test('replay-golden: --model/--compare in hai cột, tập rule-miss, --gate precision/recall từ replay-llm-out.json; thiếu ctx thì dựng từ kho', () => {
  const at = 1_800_000_000_000;
  const goldenPath = path.join(directory, 'golden-set.json');
  writeFileSync(goldenPath, JSON.stringify({ items: [
    { id: `p:a:${at + 1}`, text: 'giá bao nhiêu vậy', source: 'inbox', lastTemplate: '', prevBot: '', label: 'PRICE_QUOTE', at: at + 1 },
    { id: `p:a:${at + 2}`, text: '<sdt> 12 nguyễn trãi phường 5 quận 3', source: 'inbox', lastTemplate: 'ORDER_ADDRESS', prevBot: 'Dạ chị cho em xin số điện thoại và địa chỉ', label: 'ORDER_ADDRESS', at: at + 2 },
    { id: `p:b:${at + 3}`, text: 'đơn em tới đâu rồi', source: 'inbox', lastTemplate: '', prevBot: '', label: 'ORDER_STATUS', at: at + 3 },
    { id: `p:b:${at + 4}`, text: 'hủy đơn giúp em', source: 'inbox', lastTemplate: '', prevBot: '', label: 'ORDER_CANCELLED', at: at + 4 },
    { id: `p:c:${at + 5}`, text: 'cảm ơn shop', source: 'inbox', lastTemplate: '', prevBot: '', label: 'THANK_YOU', at: at + 5 },
    { id: `p:c:${at + 6}`, text: 'ib', source: 'comment', label: 'COMMENT_PUBLIC_REPLY', at: at + 6 },
    { id: `p:c:${at + 7}`, text: 'có vị gì', source: 'inbox', label: 'SKIP', at: at + 7 }
  ] }));
  writeFileSync(path.join(directory, 'meta-conversations.json'), JSON.stringify({ conversations: [{ id: 'p:b', customerOrders: [{ id: 'o1', createdAt: at - 3_600_000 }] }], messages: {} }));
  writeFileSync(path.join(directory, 'replay-llm-out.json'), JSON.stringify([
    { id: `p:b:${at + 3}`, llm: 'ORDER_STATUS' }, { id: `p:b:${at + 4}`, llm: 'ORDER_UPDATE' }, { id: `p:a:${at + 1}`, llm: 'GENERAL_INFO' }
  ]));
  // Kho hội thoại nằm cạnh bộ chấm; chỉ rõ đường dẫn vì quiet-console trỏ META_CONVERSATIONS_PATH về thư mục tạm.
  const result = run('replay-golden.mjs', [goldenPath, '--model', modelPath, '--compare', path.join(root, 'app', 'processing', 'intent-model.json'), '--gate'], { META_CONVERSATIONS_PATH: path.join(directory, 'meta-conversations.json') });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  assert.match(out, /mô hình 1: .*model-v6\.json · 6 nhãn/, 'ORDER_ADDRESS_PARTIAL gộp vào ORDER_ADDRESS (nhãn quyết định)');
  assert.match(out, /mô hình 2: .*intent-model\.json/);
  assert.match(out, /5 tin hộp thư đã chấm · 1 tin bỏ qua/);
  assert.match(out, /Dựng ngữ cảnh v2 cho 5 tin thiếu trường \(kho /);
  assert.match(out, /Toàn bộ tin đã chấm: 5 tin/);
  assert.match(out, /Tập rule-miss \(luật ổn định không bắt\): \d+ tin/);
  assert.match(out, /Rule-miss · mô hình 1 — theo nhãn/);
  assert.match(out, /đúng trong top-3/);
  assert.match(out, /--gate · mô hình 1 · cờ "LLM ∉ top-3 ∪ luật"/);
  assert.match(out, /nhóm ORDER_CONFIRMATION\/UPDATE\/CANCEL\* \(nhãn chấm hoặc câu LLM\): 1 tin · LLM sai 1 · cờ bật 1 · bắt đúng 1 → precision [\d.]+% · recall [\d.]+%/);
  // Chỉ một mô hình, đọc từ INTENT_MODEL_PATH; không có replay-llm-out → báo thiếu.
  rmSync(path.join(directory, 'replay-llm-out.json'));
  const single = run('replay-golden.mjs', [goldenPath, '--gate'], { INTENT_MODEL_PATH: modelPath });
  assert.equal(single.status, 0, single.stderr);
  assert.match(single.stdout, /^mô hình: .*model-v6\.json/m);
  assert.match(single.stdout, /--gate: không thấy/);
});

test('train-intent (vòng 12): --golden ghi meta.sawGolden/goldenExcluded, meta.trainIds; bỏ bình luận; --quiet im; replay-golden cảnh báo rò golden và không lấy mốc hỏng', async () => {
  const rows = syntheticDataset(20);
  rows.push({ id: 'cm:1:1', text: 'giá sao ib', label: 'COMMENT_PUBLIC_REPLY', labelSource: 'template', source: 'comment', lastTemplate: '', at: 5 });
  rows.push({ id: 'cm:1:2', text: 'ib em', label: 'COMMENT_PUBLIC_REPLY', labelSource: 'template', source: 'inbox', lastTemplate: '', at: 6 });
  rows.push({ id: 'solo:1:777', text: 'shop có bán trên tiki không vậy', label: 'ECOMMERCE_LINKS', labelSource: 'template', source: 'inbox', lastTemplate: '', at: 7 });
  const leakDataset = path.join(directory, 'dataset-leak.jsonl');
  writeFileSync(leakDataset, rows.map(row => JSON.stringify(row)).join('\n') + '\n{"id":"ghi dở');
  const leaked = rows.at(-1);
  const goldenPath = path.join(directory, 'golden-leak.json');
  writeFileSync(goldenPath, JSON.stringify({ items: [
    { id: leaked.id, text: leaked.text, source: 'inbox', lastTemplate: leaked.lastTemplate, prevBot: '', label: leaked.label, at: leaked.at },
    { id: 'z:9:1', text: 'mình ở nước ngoài có ship không', source: 'inbox', lastTemplate: '', prevBot: '', label: 'SHIPPING_POLICY', at: 1_800_000_000_000 }
  ] }));
  const leakModel = path.join(directory, 'model-leak.json');
  // Bản "m" sạch golden: dataset bỏ dòng golden. Hai lần huấn luyện độc lập → chạy song song.
  const cleanDataset = path.join(directory, 'dataset-clean.jsonl');
  writeFileSync(cleanDataset, rows.filter(row => row.id !== leaked.id).map(row => JSON.stringify(row)).join('\n'));
  const cleanModel = path.join(directory, 'model-clean.json');
  const [trained, quiet] = await Promise.all([
    runAsync('train-intent.mjs', [leakDataset, leakModel, '--golden', goldenPath]),
    runAsync('train-intent.mjs', [cleanDataset, cleanModel, '--golden', goldenPath, '--quiet'])
  ]);
  assert.equal(trained.status, 0, trained.stderr);
  assert.match(trained.stdout, /bỏ bình luận\/COMMENT_\* 2/);
  assert.match(trained.stderr, /Bỏ 1 dòng hỏng/);
  assert.match(trained.stderr, /CẢNH BÁO dataset CHỨA 1 dòng thuộc bộ chấm/);
  const saved = JSON.parse(readFileSync(leakModel, 'utf8'));
  assert.equal(saved.meta.sawGolden, true);
  assert.deepEqual([saved.meta.goldenExcluded.goldenIds, saved.meta.goldenExcluded.matchedIds, saved.meta.goldenExcluded.excluded, saved.meta.goldenExcluded.source], [2, 1, 1, goldenPath]);
  assert.equal(saved.meta.trainIds.hash, 'fnv1a32');
  assert.equal(saved.meta.dataset.comments, 2);
  assert.ok(!saved.labels.includes('COMMENT_PUBLIC_REPLY'), 'bình luận không vào mô hình hộp thư');
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout.trim().split('\n').length, 1, '--quiet: chỉ dòng saved');
  assert.match(quiet.stdout, /^saved .*sawGolden false/);
  assert.equal(JSON.parse(readFileSync(cleanModel, 'utf8')).meta.sawGolden, false);
  // replay-golden: mốc "m" sạch → tính chênh; mốc đã thấy golden → không tính.
  // Bốn lần chạy CLI chỉ đọc, độc lập → chạy song song.
  const [valid, deployed, fair, missing] = await Promise.all([
    runAsync('replay-golden.mjs', [goldenPath, '--model', cleanModel, '--compare', leakModel]),
    runAsync('replay-golden.mjs', [goldenPath, '--model', path.join(root, 'app', 'processing', 'intent-model.json'), '--compare', cleanModel]),
    runAsync('replay-golden.mjs', [goldenPath, '--model', cleanModel, '--compare', cleanModel]),
    // --golden không tồn tại → lỗi trước khi huấn luyện.
    runAsync('train-intent.mjs', [cleanDataset, path.join(directory, 'x.json'), '--golden', path.join(directory, 'khong-co.json')])
  ]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /^mô hình 1: .*model-clean\.json .* · sạch golden \(0\/2 id\)/m);
  assert.match(valid.stdout, /^mô hình 2: .*model-leak\.json .* · ĐÃ THẤY golden \(1\/2 id trong dataset huấn luyện\)/m);
  assert.match(valid.stdout, /CẢNH BÁO mô hình 2 đã học mục của bộ chấm/);
  assert.match(valid.stdout, /MỐC SO KHÔNG HỢP LỆ: mô hình 2/);
  assert.match(valid.stdout, /Chênh \(mô hình 2 − mô hình 1\): KHÔNG tính/);
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.match(deployed.stdout, /không rõ đã thấy golden chưa .* — mô hình ĐANG CHẠY/);
  assert.match(deployed.stdout, /MỐC SO KHÔNG HỢP LỆ: mô hình 1/);
  assert.match(fair.stdout, /Chênh \(mô hình 2 − mốc mô hình 1\): rule-miss \+0\.0 điểm/);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Không thấy bộ chấm --golden/);
});
