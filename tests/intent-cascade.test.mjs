import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syntheticDataset } from './helpers/intent-synthetic.mjs';
import { ANSWER_SUBGROUPS, CASCADE_FINE_GROUPS, CASCADE_GROUPS, GROUP_OF_TEMPLATE, SUBGROUP_OF_TEMPLATE, cascadeFromRaw, cascadeSafeTemplates, fineGroupOf, groupOf, isIntentionalOther, loadCascadeFrom, predictCascade, predictCascadeWith, probabilitiesOf, subGroupOf, sumByGroup } from '../app/processing/intent-cascade.mjs';
import { intentSafeTemplates, loadIntentModelFrom, predictIntentWith } from '../app/processing/intent-model.mjs';
import { trainClassifier } from '../tools-intent/train-intent.mjs';
import { prepareCascadeRows, trainCascade, trainCascadeModels } from '../tools-intent/train-cascade.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(path.join(tmpdir(), 'intent-cascade-'));
const run = (script, args, env = {}) => spawnSync(process.execPath, [path.join(root, 'tools-intent', script), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CRM_TEST_VERBOSE: '1', ...env } });
test.after(() => rmSync(directory, { recursive: true, force: true }));

const ADDRESS_ROW = { text: '<sdt> 3 lê lợi phường 7 quận 5', source: 'inbox', lastTemplate: 'ORDER_ADDRESS', lastWasOrderStep: true, hasBasket: true, prevBotAsks: 'phone_address', phoneInText: true, addressInText: true, bagCount: 0 };
const PRICE_ROW = { text: 'giá bao nhiêu vậy', source: 'inbox', lastTemplate: '' };
const STATUS_ROW = { text: 'đơn em tới đâu rồi', source: 'inbox', lastTemplate: '', hasOrder: true, orderAgeMin: 1440 };

test('groupOf 4 nhóm tầng 1 (ANSWER = PRICE ∪ INFO ∪ SOCIAL), subGroupOf PRICE/INFO/SOCIAL hoặc null, fineGroupOf 6 lớp; COMMENT_*/mã lạ/TRIAL_PRICE → OTHER', () => {
  assert.deepEqual(CASCADE_GROUPS, ['ORDER', 'SUPPORT', 'ANSWER', 'OTHER']);
  assert.deepEqual(CASCADE_FINE_GROUPS, ['ORDER', 'SUPPORT', 'PRICE', 'INFO', 'SOCIAL', 'OTHER']);
  assert.deepEqual(ANSWER_SUBGROUPS, ['PRICE', 'INFO', 'SOCIAL']);
  assert.equal(groupOf('PRICE_QUOTE'), 'ANSWER');
  assert.equal(groupOf('GENERAL_INFO'), 'ANSWER', 'PRICE_QUOTE ↔ GENERAL_INFO cùng nhóm tầng 1');
  assert.equal(groupOf('BAG_COMPARISON_XANH_VANG'), 'ANSWER');
  assert.equal(groupOf('THANK_YOU'), 'ANSWER');
  assert.equal(groupOf('ORDER_STATUS'), 'SUPPORT');
  assert.equal(groupOf('CSKH_HANDOFF'), 'SUPPORT');
  assert.equal(groupOf('ORDER_ADDRESS_PARTIAL'), 'ORDER');
  assert.equal(groupOf('ORDER_HELP'), 'ORDER');
  assert.equal(groupOf('ASK_FLAVOR'), 'ORDER');
  assert.equal(groupOf('TRIAL_PRICE'), 'OTHER', 'trial-flow quyết, không nằm trong bảng');
  assert.equal(groupOf('COMMENT_PUBLIC_REPLY'), 'OTHER');
  assert.equal(groupOf('OTHER'), 'OTHER');
  assert.equal(groupOf('XYZ_KHONG_CO'), 'OTHER', 'mã không có trong bảng');
  assert.equal(groupOf('SHOP_ORDER_RECEIVED'), 'ORDER', 'giỏ Facebook Shop là bước đơn (vòng 12)');
  assert.equal(groupOf(''), 'OTHER');
  assert.equal(groupOf(undefined), 'OTHER');
  assert.equal(subGroupOf('PRICE_QUOTE'), 'PRICE');
  assert.equal(subGroupOf('GENERAL_INFO'), 'PRICE');
  assert.equal(subGroupOf('WEIGHT_EXPIRY'), 'INFO');
  assert.equal(subGroupOf('WELCOME'), 'SOCIAL');
  assert.equal(subGroupOf('ORDER_ADDRESS'), null, 'ngoài ANSWER → null');
  assert.equal(subGroupOf('CSKH_HANDOFF'), null);
  assert.equal(subGroupOf('OTHER'), null);
  assert.equal(fineGroupOf('ORDER_ADDRESS'), 'ORDER');
  assert.equal(fineGroupOf('WEIGHT_EXPIRY'), 'INFO');
  assert.equal(fineGroupOf('XYZ'), 'OTHER');
  // R13 (gộp, 02/10): +4 mẫu engine tự chọn vừa vào seed (SHOP_CART_UNKNOWN/STAFF → SUPPORT, SHOP_CART_ACK / GIFT_SWAP_NOTED
  // → ORDER) nên số mục bảng nhóm 103 → 107; không mẫu nào vào ANSWER (kiểm ở tests/r13-glue-core.test.mjs).
  // R14: +2 mẫu engine tự chọn (STAFF_WAIT_OPEN / STAFF_WAIT_CLOSED — báo bạn phụ trách trả lời theo giờ hành chính).
  assert.equal(Object.keys(GROUP_OF_TEMPLATE).length, 109, 'vòng 12 (r12): +19 mẫu mới; vòng 13: +4; vòng 14: +2 mẫu engine tự chọn');
  assert.equal(Object.keys(SUBGROUP_OF_TEMPLATE).length, 109);
  assert.ok(Object.values(GROUP_OF_TEMPLATE).every(group => ['ORDER', 'SUPPORT', 'ANSWER'].includes(group)));
  assert.ok(Object.isFrozen(GROUP_OF_TEMPLATE) && Object.isFrozen(SUBGROUP_OF_TEMPLATE));
  assert.ok(cascadeSafeTemplates.has('PRICE_QUOTE') && cascadeSafeTemplates.has('THANK_YOU') && cascadeSafeTemplates.has('WEIGHT_EXPIRY'));
  assert.ok(!cascadeSafeTemplates.has('ASK_FLAVOR'), 'ASK_FLAVOR thuộc ORDER → không an toàn cho tầng');
  assert.ok(!cascadeSafeTemplates.has('WHOLESALE_CTV_CONTACT'), 'SUPPORT → không an toàn');
  assert.ok([...cascadeSafeTemplates].every(templateId => intentSafeTemplates.has(templateId) && groupOf(templateId) === 'ANSWER'));
  assert.deepEqual(sumByGroup({ PRICE_QUOTE: 0.5, GENERAL_INFO: 0.2, ORDER_ADDRESS: 0.3 }, groupOf), [{ group: 'ANSWER', p: 0.7 }, { group: 'ORDER', p: 0.3 }]);
  assert.deepEqual(sumByGroup({ PRICE_QUOTE: 0.5, THANK_YOU: 0.2, ORDER_ADDRESS: 0.3 }, subGroupOf), [{ group: 'PRICE', p: 0.5 }, { group: 'SOCIAL', p: 0.2 }], 'nhóm null bị bỏ');
});

test('trainClassifier (tách từ train-intent): trả model định dạng intent-model.json + report; dropOther:false giữ OTHER; CLI train-intent vẫn chạy như cũ', () => {
  const rows = syntheticDataset(20);
  const lines = [];
  const { model, report } = trainClassifier(rows, { log: line => lines.push(line) });
  assert.match(lines[0], /^Dòng: 145 · bỏ OTHER 3 · bỏ lớp < 4 mẫu: VAT_INVOICE \(2\) → còn 140$/);
  assert.equal(model.version, 3);
  assert.equal(model.labels.length, 6, 'ORDER_ADDRESS_PARTIAL gộp vào ORDER_ADDRESS (nhãn quyết định)');
  assert.equal(model.meta.rows, 140);
  assert.equal(model.temperature, model.meta.calibration.temperature);
  assert.deepEqual(report.dataset.weights, { 1: 91, 2: 21, 0.7: 28 });
  assert.ok(report.held.n > 0 && report.calibration.bins.length === 10);
  const { model: skipped } = trainClassifier(rows, { full: false });
  assert.equal(skipped, null, 'full=false không huấn luyện lại toàn bộ');
  assert.throws(() => trainClassifier(rows.slice(0, 5)), /Quá ít dòng/);
  const keptOther = [];
  const withOther = trainClassifier(rows.map(row => ({ ...row, label: row.label === 'VAT_INVOICE' ? 'OTHER' : row.label })), { dropOther: false, log: line => keptOther.push(line) });
  assert.match(keptOther[0], /^Dòng: 145 · bỏ OTHER 0 · bỏ lớp < 4 mẫu: không → còn 145$/);
  assert.ok(withOther.model.labels.includes('OTHER'), 'OTHER thành một lớp thường');
  // CLI: cùng dòng dữ liệu, cùng thông điệp và tệp ra.
  const datasetPath = path.join(directory, 'dataset.jsonl');
  writeFileSync(datasetPath, rows.map(row => JSON.stringify(row)).join('\n'));
  const cliOut = path.join(directory, 'flat.json');
  const result = run('train-intent.mjs', [datasetPath, cliOut]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Dòng: 145 · bỏ OTHER 3/);
  assert.match(result.stdout, /\nsaved /);
  const saved = JSON.parse(readFileSync(cliOut, 'utf8'));
  assert.deepEqual(saved.labels, model.labels);
  assert.deepEqual(saved.classes.map(item => item.bias), model.classes.map(item => item.bias), 'cùng trọng số (huấn luyện tất định)');
  // probabilitiesOf = phân phối đầy đủ, cùng công thức với predictIntentWith.
  const loaded = loadIntentModelFrom(cliOut);
  const distribution = probabilitiesOf(loaded, PRICE_ROW);
  const guess = predictIntentWith(loaded, PRICE_ROW);
  assert.equal(Object.keys(distribution).length, 6);
  assert.ok(Math.abs(Object.values(distribution).reduce((sum, p) => sum + p, 0) - 1) < 1e-9);
  assert.ok(Math.abs(distribution[guess.templateId] - guess.confidence) < 1e-6);
});

test('predictCascadeWith: p = p(nhóm) × p(mẫu|nhóm), pWithin/marginWithin, subGroup; nhóm không có mô hình con → templateId null; cả hai answerMode', () => {
  const { rows, other } = prepareCascadeRows(syntheticDataset(20));
  assert.equal(rows.length, 145, 'GIỮ 3 dòng OTHER cho tầng 1');
  assert.equal(other, 3);
  const { raw } = trainCascadeModels(rows);
  assert.deepEqual(raw.groups, ['ANSWER', 'ORDER', 'SUPPORT'], 'OTHER chỉ 3 dòng < 4 → lớp bị bỏ trên dữ liệu tổng hợp');
  assert.ok(raw.specialists.ORDER && raw.specialists.ORDER.labels.length === 3);
  assert.deepEqual(raw.specialists.ANSWER.labels, ['PRICE_QUOTE', 'THANK_YOU'], 'ANSWER = PRICE_QUOTE + THANK_YOU (VAT_INVOICE < 4)');
  assert.equal(raw.specialists.SUPPORT, null, 'SUPPORT 20 dòng < 30 → null');
  assert.equal(raw.specialists.PRICE, null, 'PRICE 20 dòng, 1 lớp → null');
  assert.equal(raw.specialists.SOCIAL, null);
  for (const answerMode of ['flat', 'subgroup']) {
    const cascade = cascadeFromRaw({ ...raw, answerMode });
    assert.equal(cascade.answerMode, answerMode);
    const address = predictCascadeWith(cascade, ADDRESS_ROW);
    assert.equal(address.group, 'ORDER');
    assert.equal(address.subGroup, null, 'ngoài ANSWER → subGroup null');
    assert.equal(address.templateId, 'ORDER_ADDRESS');
    assert.deepEqual(address.path, ['ORDER', 'ORDER_ADDRESS']);
    assert.ok(address.pGroup > 0.5 && address.p <= address.pGroup + 1e-9, 'p tổng ≤ p nhóm');
    assert.ok(Math.abs(address.p - address.pGroup * address.pWithin) < 2e-3, 'p = p(nhóm) × pWithin');
    assert.ok(address.marginWithin > 0 && address.marginWithin <= 1);
    assert.ok(address.groupTopK.length <= 3 && address.groupTopK[0].group === 'ORDER' && address.groupTopK[0].p === address.pGroup);
    assert.ok(address.topK.length >= 1 && address.topK[0].templateId === 'ORDER_ADDRESS' && address.topK[0].p === address.p);
    assert.ok(address.topK.every((item, i) => i === 0 || address.topK[i - 1].p >= item.p), 'topK giảm dần');
    assert.ok(address.topK.every(item => item.templateId && 'subGroup' in item && item.group));
    // margin tính trên MỌI ứng viên (kể nhóm không có mô hình con, templateId null) nên ≤ p − p(topK[1]).
    assert.ok(address.margin >= 0 && address.margin <= address.p - (address.topK[1]?.p ?? 0) + 1e-9, JSON.stringify(address));
    const price = predictCascadeWith(cascade, PRICE_ROW);
    assert.equal(price.group, 'ANSWER');
    assert.equal(price.subGroup, 'PRICE');
    assert.equal(price.templateId, 'PRICE_QUOTE', `answerMode ${answerMode}: nhóm con PRICE không có mô hình riêng → lấy mẫu PRICE từ phân phối ANSWER`);
    assert.ok(price.pWithin > 0.5);
    const status = predictCascadeWith(cascade, STATUS_ROW);
    assert.equal(status.group, 'SUPPORT');
    assert.equal(status.templateId, null, 'không có mô hình con → chỉ nhóm');
    assert.equal(status.p, status.pGroup);
    assert.equal(status.pWithin, null);
    assert.deepEqual(status.path, ['SUPPORT', null]);
    assert.ok(status.topK.every(item => item.templateId), 'topK không chứa ứng viên null');
  }
  assert.equal(predictCascadeWith(null, PRICE_ROW), null);
});

test('loadCascadeFrom / predictCascade / reloadCascadeModel: thiếu tệp → null; tệp hỏng → null; mô hình mặc định (nếu có) trả nhóm', async () => {
  assert.equal(loadCascadeFrom(path.join(directory, 'missing.json')), null);
  writeFileSync(path.join(directory, 'bad.json'), '{');
  assert.equal(loadCascadeFrom(path.join(directory, 'bad.json')), null);
  writeFileSync(path.join(directory, 'nogroup.json'), JSON.stringify({ version: 'cascade-2', specialists: {} }));
  assert.equal(loadCascadeFrom(path.join(directory, 'nogroup.json')), null, 'thiếu mô hình nhóm → null');
  // Mô-đun nạp lại với INTENT_CASCADE_PATH trỏ tới tệp không có → predictCascade trả null, không ném.
  const previous = process.env.INTENT_CASCADE_PATH;
  process.env.INTENT_CASCADE_PATH = path.join(directory, 'missing.json');
  try {
    const fresh = await import(`${pathToFileURL(path.join(root, 'app', 'processing', 'intent-cascade.mjs')).href}?missing`);
    assert.equal(fresh.predictCascade(PRICE_ROW), null);
    assert.equal(fresh.loadCascadeModel(), null);
    assert.equal(fresh.reloadCascadeModel(), null);
    assert.equal(fresh.reloadCascade, fresh.reloadCascadeModel);
  } finally {
    if (previous === undefined) delete process.env.INTENT_CASCADE_PATH; else process.env.INTENT_CASCADE_PATH = previous;
  }
  const deployed = path.join(root, 'app', 'processing', 'intent-cascade.json');
  if (existsSync(deployed)) {
    const guess = predictCascade({ text: 'giá bao nhiêu vậy shop', source: 'inbox', lastTemplate: '' });
    assert.ok(guess && CASCADE_GROUPS.includes(guess.group) && guess.p > 0 && guess.p <= 1, JSON.stringify(guess));
    assert.equal(guess.group, 'ANSWER');
    assert.equal(guess.subGroup, 'PRICE');
    assert.ok(['PRICE_QUOTE', 'GENERAL_INFO'].includes(guess.templateId), guess.templateId);
    assert.ok(typeof guess.pWithin === 'number' && typeof guess.marginWithin === 'number');
    assert.ok(guess.topK.length >= 1 && guess.topK.length <= 6);
    const model = loadCascadeFrom(deployed);
    assert.equal(model.version, 'cascade-2');
    assert.ok(['flat', 'subgroup'].includes(model.answerMode));
    assert.ok(model.trainedAt && model.rows > 100 && model.report);
    assert.ok(model.groups.includes('OTHER'), 'bản triển khai có lớp từ chối');
  }
});

test('bảng nhóm phủ mọi mẫu seed: mẫu nào cũng có nhóm, trừ mẫu OTHER CÓ CHỦ Ý (bình luận, bám đuổi, dùng thử, QR, săn deal, hậu xử lý)', () => {
  const seed = JSON.parse(readFileSync(path.join(root, 'app', 'chatbot-templates.seed.json'), 'utf8'));
  const unmapped = Object.keys(seed).filter(templateId => groupOf(templateId) === 'OTHER' && !isIntentionalOther(templateId));
  assert.deepEqual(unmapped, [], 'mẫu seed rơi OTHER ngoài ý muốn');
  for (const templateId of Object.keys(seed)) {
    const group = groupOf(templateId);
    assert.ok(CASCADE_GROUPS.includes(group), templateId);
    if (isIntentionalOther(templateId)) assert.equal(group, 'OTHER', `${templateId} cố ý OTHER`);
    else assert.ok(['ORDER', 'SUPPORT', 'ANSWER'].includes(group), templateId);
  }
  for (const templateId of ['KIDS_FAMILY', 'CALORIES_DIET', 'STORAGE', 'HOW_TO_USE_GRANOLA', 'STORE_ADDRESS', 'CERTIFICATION']) assert.deepEqual([groupOf(templateId), subGroupOf(templateId)], ['ANSWER', 'INFO'], templateId);
  for (const templateId of ['ORDER_UPDATED', 'ORDER_ADDRESS_REMIND', 'ORDER_CART_LINE', 'UPSELL_TWO_BAGS', 'SHOP_ORDER_RECEIVED', 'ORDER_UPDATE', 'ORDER_CANCEL']) assert.equal(groupOf(templateId), 'ORDER', templateId);
  assert.equal(groupOf('LIVE_ONLY_PRODUCT'), 'SUPPORT');
  for (const templateId of ['COMMENT_PUBLIC_REPLY', 'FOLLOW_UP_INBOX_REMIND', 'TRIAL_PRICE', 'QR_OFFER', 'REPLY_ALREADY_SENT', 'LIVE_DEAL_CLAIMED']) assert.equal(groupOf(templateId), 'OTHER', templateId);
});

test('train-cascade CLI: dữ liệu tổng hợp → JSON đúng cấu trúc (cascade-2, answerMode, groupModel, 6 mô hình con, report), báo cáo giữ-out tầng (2 cách) vs phẳng', () => {
  const rows = syntheticDataset(20);
  const datasetPath = path.join(directory, 'dataset-cascade.jsonl');
  writeFileSync(datasetPath, rows.map(row => JSON.stringify(row)).join('\n'));
  const outPath = path.join(directory, 'cascade.json');
  const result = run('train-cascade.mjs', [datasetPath, outPath, '--holdout', '0.2']);
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  assert.match(out, /^Dòng: 145 · bỏ bình luận 0 · COMMENT_\* 0 · giữ OTHER 3 \(trong đó nhãn ngoài bảng nhóm → OTHER: 0\) → còn 145/);
  assert.match(out, /Theo nhóm tầng 1: ORDER 80 · SUPPORT 20 · ANSWER 42 · OTHER 3 · 6 lớp: ORDER 80 · SUPPORT 20 · PRICE 20 · INFO 2 · SOCIAL 20 · OTHER 3/);
  assert.match(out, /Đo giữ-out: huấn luyện trên 116 dòng cũ, đo trên 29 dòng mới nhất \(20%, chỉ hộp thư\)/);
  assert.match(out, /\[SUPPORT\] 16 dòng · 1 nhãn → không huấn luyện mô hình con \(< 30 dòng\)/);
  assert.match(out, /Giữ-out end-to-end: 29 dòng \(26 có mẫu, 3 OTHER\)/);
  assert.match(out, /tầng ANSWER-flat\s+tầng ANSWER-subgroup\s+phẳng/);
  assert.match(out, /đúng nhóm tầng 1 \(kể OTHER\)/);
  assert.match(out, /đúng nhóm tầng 1 \(không OTHER\)\s+[\d.]+%\s+[\d.]+%\s+[\d.]+% · cộng p [\d.]+%/, 'đối chứng phẳng cộng p theo nhóm');
  assert.match(out, /đúng mẫu end-to-end \(không OTHER\)/);
  assert.match(out, /từ chối đúng \(dòng OTHER\)/);
  assert.match(out, /risk–coverage cùng độ phủ/);
  assert.match(out, /phủ 30%\s+[\d.]+% \(p≥[\d.]+\)/);
  assert.match(out, /ECE 10 ngăn · tích: [\d.]+ \/ [\d.]+ \/ phẳng [\d.]+ · tầng 1: [\d.]+ · trong nhóm: [\d.]+ \/ [\d.]+/);
  assert.match(out, /ngăn p của TẦNG 1 — n · p TB · đúng nhóm:\n\s+p 0\.\d–/);
  assert.match(out, /theo nhóm 6 lớp thật/);
  assert.match(out, /tập con dòng nhân viên \(staff\/corrected\): 7 dòng/);
  assert.match(out, /tập con nhãn thật ∈ mẫu an toàn ANSWER: \d+ dòng/);
  assert.match(out, /tập rule-miss \(ruleTemplate rỗng\): \d+ dòng/, 'dataset tổng hợp có trường ruleTemplate');
  assert.match(out, /→ answerMode chọn: (flat|subgroup)/);
  assert.match(out, /Huấn luyện bản triển khai trên toàn bộ 145 dòng/);
  assert.match(out, /saved .*cascade\.json \d+ KB · nhóm ANSWER\/ORDER\/SUPPORT · answerMode (flat|subgroup) · mô hình con: ORDER 3 mẫu · SUPPORT null · ANSWER 2 mẫu · PRICE null · INFO null · SOCIAL null/);
  const saved = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(saved.version, 'cascade-2');
  assert.ok(saved.trainedAt && saved.rows === 145);
  assert.deepEqual(saved.groups, ['ANSWER', 'ORDER', 'SUPPORT']);
  assert.deepEqual(saved.groupModel.labels, saved.groups);
  assert.equal(saved.groupModel.version, 3, 'mô hình nhóm định dạng intent-model.json');
  assert.ok(saved.groupModel.meta.calibration.temperature >= 0.5);
  assert.deepEqual(Object.keys(saved.specialists), ['ORDER', 'SUPPORT', 'ANSWER', 'PRICE', 'INFO', 'SOCIAL']);
  assert.deepEqual(saved.specialists.ORDER.labels, ['ASK_FLAVOR', 'ORDER_ADDRESS', 'ORDER_CANCELLED'], 'mẫu con PARTIAL học như ORDER_ADDRESS');
  assert.equal(saved.specialists.SUPPORT, null);
  assert.ok(['flat', 'subgroup'].includes(saved.answerMode) && saved.answerMode === saved.report.heldOut.bestMode);
  const held = saved.report.heldOut.all;
  assert.ok(held.n === 29 && held.known === 26);
  for (const key of ['flat', 'subgroup', 'plain']) assert.ok(typeof held[key].hit === 'number' && held[key].thresholds.length === 6 && held[key].riskCoverage.length === 6, key);
  assert.ok(typeof held.plainSum.groupHitKnown === 'number');
  assert.ok(typeof held.ece.flat.product === 'number' && typeof held.ece.flat.tier1 === 'number' && typeof held.ece.plain === 'number');
  assert.ok(saved.report.heldOut.ruleMiss && saved.report.heldOut.ruleMiss.n > 0);
  assert.ok(saved.report.heldOut.staff && saved.report.heldOut.staff.n === 7);
  assert.ok(saved.report.heldOut.flat && saved.report.heldOut.flat.labels.length === 6);
  assert.equal(saved.report.subModels.specialists.SUPPORT.skipped, '< 30 dòng');
  assert.equal(saved.report.dataset.groupCounts.ORDER, 80);
  assert.equal(saved.report.dataset.other, 3);
  // Nạp bằng loader thật và dự đoán.
  const cascade = loadCascadeFrom(outPath);
  assert.equal(predictCascadeWith(cascade, ADDRESS_ROW).templateId, 'ORDER_ADDRESS');
  assert.deepEqual([saved.meta.sawGolden, saved.meta.goldenExcluded, saved.meta.trainIds.hash, saved.meta.trainIds.ids.length], [null, null, 'fnv1a32', 145], 'không có --golden → không rõ; băm id dataset');
  // --quiet im thật: chỉ dòng saved.
  const quiet = run('train-cascade.mjs', [datasetPath, outPath, '--quiet']);
  assert.equal(quiet.status, 0);
  assert.deepEqual(quiet.stdout.trim().split('\n').length, 1, quiet.stdout);
  assert.match(quiet.stdout, /^saved /);
  // Thiếu đối số → hướng dẫn, mã 1; --golden không tồn tại → lỗi TRƯỚC khi huấn luyện (không ghi tệp).
  const usage = run('train-cascade.mjs', [datasetPath]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Dùng: node tools-intent\/train-cascade\.mjs/);
  const noGoldenOut = path.join(directory, 'cascade-no-golden.json');
  const missingGolden = run('train-cascade.mjs', [datasetPath, noGoldenOut, '--golden', path.join(directory, 'khong-co.json')]);
  assert.equal(missingGolden.status, 1);
  assert.match(missingGolden.stderr, /Không thấy bộ chấm --golden/);
  assert.ok(!existsSync(noGoldenOut), 'không huấn luyện khi --golden hỏng');
  assert.equal(run('train-cascade.mjs', [datasetPath, outPath, '--holdout']).status, 1, 'cờ thiếu giá trị');
});

test('trainCascade (hàm): bình luận / COMMENT_* bị bỏ, nhãn ngoài bảng nhóm → OTHER kèm cảnh báo, dataset không có ruleTemplate → "không đo"', () => {
  const rows = syntheticDataset(20).map(row => { const copy = { ...row }; delete copy.ruleTemplate; return copy; });
  rows.push({ id: 'x1', text: 'có chứng nhận gì không', label: 'CERTIFICATION', labelSource: 'llm', source: 'inbox', lastTemplate: '', at: 1 });
  rows.push({ id: 'x2', text: 'ib', label: 'COMMENT_PUBLIC_REPLY', labelSource: 'template', source: 'comment', lastTemplate: '', at: 2 });
  rows.push({ id: 'x3', text: 'giá', label: 'COMMENT_PUBLIC_REPLY', labelSource: 'template', source: 'inbox', lastTemplate: '', at: 3 });
  rows.push({ id: 'x4', text: 'giá dùng thử', label: 'TRIAL_PRICE', labelSource: 'llm', source: 'inbox', lastTemplate: '', at: 4 });
  const lines = [];
  const { model } = trainCascade(rows, { log: line => lines.push(line), compareFlat: false });
  assert.match(lines[0], /bỏ bình luận 1 · COMMENT_\* 1 · giữ OTHER 4 \(trong đó nhãn ngoài bảng nhóm → OTHER: 1\) → còn 147/);
  assert.match(lines[1], /CẢNH BÁO nhãn không có trong bảng nhóm \(coi là OTHER\): TRIAL_PRICE \(1\)/);
  assert.ok(lines.some(line => /tập rule-miss: không đo \(dataset không có trường ruleTemplate\)/.test(line)));
  assert.equal(model.report.heldOut.flat, null, 'compareFlat=false không huấn luyện phẳng');
  assert.equal(model.report.heldOut.ruleMiss, null);
  assert.deepEqual(model.report.dataset.remapped, { TRIAL_PRICE: 1 }, 'CERTIFICATION nay thuộc INFO');
  assert.equal(model.report.dataset.other, 4);
});

test('replay-golden --cascade: bảng phẳng vs tầng (toàn bộ, rule-miss, an toàn ANSWER), OTHER là nhóm từ chối, risk–coverage, theo 6 lớp; tệp tầng hỏng → mã 1', () => {
  const rows = syntheticDataset(20);
  const datasetPath = path.join(directory, 'dataset-replay.jsonl');
  writeFileSync(datasetPath, rows.map(row => JSON.stringify(row)).join('\n'));
  const flatPath = path.join(directory, 'flat-replay.json');
  const cascadePath = path.join(directory, 'cascade-replay.json');
  assert.equal(run('train-intent.mjs', [datasetPath, flatPath]).status, 0);
  assert.equal(run('train-cascade.mjs', [datasetPath, cascadePath, '--quiet']).status, 0);
  const at = 1_800_000_000_000;
  const goldenPath = path.join(directory, 'golden-set.json');
  writeFileSync(goldenPath, JSON.stringify({ items: [
    { id: `p:a:${at + 1}`, text: 'giá bao nhiêu vậy', source: 'inbox', lastTemplate: '', prevBot: '', label: 'PRICE_QUOTE', at: at + 1 },
    { id: `p:a:${at + 2}`, text: '<sdt> 12 nguyễn trãi phường 5 quận 3', source: 'inbox', lastTemplate: 'ORDER_ADDRESS', prevBot: 'Dạ chị cho em xin số điện thoại và địa chỉ', label: 'ORDER_ADDRESS', at: at + 2 },
    { id: `p:b:${at + 3}`, text: 'đơn em tới đâu rồi', source: 'inbox', lastTemplate: '', prevBot: '', label: 'ORDER_STATUS', at: at + 3 },
    { id: `p:b:${at + 4}`, text: 'hủy đơn giúp em', source: 'inbox', lastTemplate: '', prevBot: '', label: 'ORDER_CANCELLED', at: at + 4 },
    { id: `p:c:${at + 5}`, text: 'cảm ơn shop', source: 'inbox', lastTemplate: '', prevBot: '', label: 'THANK_YOU', at: at + 5 },
    { id: `p:c:${at + 8}`, text: '.', source: 'inbox', lastTemplate: '', prevBot: '', label: 'OTHER', at: at + 8 },
    { id: `p:c:${at + 6}`, text: 'ib', source: 'comment', label: 'COMMENT_PUBLIC_REPLY', at: at + 6 },
    { id: `p:c:${at + 7}`, text: 'có vị gì', source: 'inbox', label: 'SKIP', at: at + 7 }
  ] }));
  writeFileSync(path.join(directory, 'meta-conversations.json'), JSON.stringify({ conversations: [{ id: 'p:b', customerOrders: [{ id: 'o1', createdAt: at - 3_600_000 }] }], messages: {} }));
  const result = run('replay-golden.mjs', [goldenPath, '--model', flatPath, '--cascade', cascadePath]);
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  assert.match(out, /^mô hình: .*flat-replay\.json · 6 nhãn/m);
  assert.match(out, /^mô hình tầng: .*cascade-replay\.json · nhóm ANSWER\/ORDER\/SUPPORT · answerMode (flat|subgroup) · mô hình con \(số mẫu\): ORDER 3 · SUPPORT null · ANSWER 2 · PRICE null · INFO null · SOCIAL null · 145 dòng/m);
  assert.match(out, /6 tin hộp thư đã chấm · 1 tin bỏ qua/);
  assert.match(out, /--cascade · toàn bộ tin đã chấm: 6 tin \(5 có mẫu, 1 nhóm OTHER\)/);
  assert.match(out, /phẳng \(mô hình 1\)\s+tầng \(ANSWER-(flat|subgroup)\)/);
  assert.match(out, /có dự đoán\s+6\/6\s+6\/6/);
  assert.match(out, /đúng thô \(tin có mẫu\)\s+[\d.]+% \(\d\)\s+[\d.]+% \(\d\)/);
  assert.match(out, /đúng nhóm tầng 1 \(tin có mẫu\)\s+[\d.]+% · cộng p [\d.]+%\s+100\.0%/, 'tầng đúng nhóm cả 5 tin có mẫu');
  assert.match(out, /từ chối đúng \(tin OTHER\)\s+phẳng không có OTHER\s+[\d.]+% \(\d\/1\)/);
  assert.match(out, /risk–coverage cùng độ phủ/);
  assert.match(out, /phủ 50%\s+[\d.]+% \(\d\/\d, p≥[\d.]+\)/);
  assert.match(out, /--cascade · tập rule-miss \(luật ổn định không bắt\): \d tin/);
  assert.match(out, /--cascade · tập con nhãn thật ∈ mẫu an toàn ANSWER: 2 tin/);
  assert.match(out, /--cascade · theo nhóm 6 lớp thật/);
  assert.match(out, /^\s+ORDER\s+2\s+100\.0%/m);
  assert.match(out, /^\s+OTHER\s+1\s+/m);
  assert.match(out, /^tầng · (ngưỡng gợi ý|không có ngưỡng)/m);
  assert.match(out, /Toàn bộ tin đã chấm: 6 tin/, 'báo cáo phẳng cũ vẫn in');
  // Không có --cascade: không in bảng tầng. Tệp tầng hỏng: mã 1.
  const plain = run('replay-golden.mjs', [goldenPath, '--model', flatPath]);
  assert.equal(plain.status, 0);
  assert.doesNotMatch(plain.stdout, /--cascade/);
  const missing = run('replay-golden.mjs', [goldenPath, '--model', flatPath, '--cascade', path.join(directory, 'missing.json')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Không thấy tệp --cascade/);
  writeFileSync(path.join(directory, 'broken.json'), '{ hỏng');
  const broken = run('replay-golden.mjs', [goldenPath, '--model', flatPath, '--cascade', path.join(directory, 'broken.json')]);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /Không đọc được mô hình tầng/);
  // Mô hình đo có meta.trainIds → in trạng thái rò golden (bộ chấm này không nằm trong dataset tổng hợp → sạch).
  assert.match(out, /^mô hình: .*flat-replay\.json .* · sạch golden \(0\/8 id\)/m);
  assert.match(out, /^mô hình tầng: .* · sạch golden \(0\/8 id\)/m);
});
