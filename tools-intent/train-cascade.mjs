// Huấn luyện mô hình quyết định TẦNG (app/processing/intent-cascade.mjs):
//   tầng 1: mô hình nhóm 4 lớp ORDER / SUPPORT / ANSWER / OTHER (GIỮ dòng OTHER làm lớp từ chối);
//   tầng 2: mô hình con ORDER, SUPPORT, ANSWER (mọi mẫu giá/thông tin/xã giao) và PRICE / INFO / SOCIAL (nhóm con)
//   — hai cách chọn mẫu trong ANSWER (answerMode 'flat': mô hình con ANSWER chọn thẳng; 'subgroup': cộng p theo
//   nhóm con → mô hình con của nhóm con thắng) đều được đo trên giữ-out, cách tốt hơn ghi vào tệp.
// Mỗi mô hình con dùng chung trainClassifier của train-intent.mjs (TF-IDF + softmax, lọc nhiễu, hiệu chuẩn nhiệt độ
// trên 20% mới nhất của phần huấn luyện). Nhóm < 30 dòng hoặc < 2 lớp đủ mẫu → null (dự đoán chỉ trả nhóm).
// Đo giữ-out END-TO-END công bằng: chỉ hộp thư, chia toàn bộ dữ liệu theo thời gian (20% mới nhất), huấn luyện tầng
// và mô hình phẳng (cùng trainClassifier) trên phần cũ, so trên phần mới: đúng nhóm (kể / không kể OTHER), đối chứng
// "phẳng cộng p theo nhóm", đúng nhóm con, đúng mẫu, từ chối đúng/oan, bảng ngưỡng, đường risk–coverage cùng độ phủ,
// ECE của tích và từng tầng; tập con dòng nhân viên, tập con mẫu an toàn ANSWER, tập rule-miss (chỉ khi dataset có
// trường ruleTemplate). Bản triển khai được huấn luyện lại trên toàn bộ dữ liệu sau khi đo.
// Dùng: node tools-intent/train-cascade.mjs <dataset.jsonl> <out.json> [--holdout 0.2] [--golden golden.json] [--flat m.json]
//         [--flat-out m.json] [--include-comments] [--quiet]
// Vòng 12 (28/09):
//   - dòng đi qua intentRowFromRecord (một định nghĩa row với engine); bình luận / COMMENT_* bỏ (--include-comments giữ);
//   - model.meta: trainIds (băm id dataset), goldenExcluded / sawGolden (khi có --golden, như train-intent);
//   - --golden: kiểm tệp TRƯỚC khi huấn luyện; đo trên bộ chấm so với bản PHẲNG "m" huấn luyện CÙNG dataset, cùng
//     công thức (trainClassifier, bỏ OTHER) — không so với mô hình đang chạy (đã thấy golden). --flat <m.json> dùng bản m
//     có sẵn thay vì tự huấn luyện; --flat-out ghi bản m tự huấn luyện ra tệp (để replay-golden --model dùng lại);
//   - --quiet: không in nhật ký/bảng huấn luyện, chỉ dòng "saved …" (và bảng bộ chấm nếu có --golden).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MIN_CLASS, calibrationTable, goldenMetaOf, goldenOverlap, isCommentRow, isRuleMiss, isStaffRow, readDataset, trainClassifier, trainIdsOf } from './train-intent.mjs';
import { ANSWER_SUBGROUPS, CASCADE_FINE_GROUPS, CASCADE_GROUPS, cascadeFromRaw, cascadeSafeTemplates, fineGroupOf, groupOf, predictCascadeWith, probabilitiesOf, subModelFrom, sumByGroup } from '../app/processing/intent-cascade.mjs';
import { intentRowFromRecord } from '../app/processing/intent-features.mjs';
import { loadIntentModelFrom, predictIntentWith } from '../app/processing/intent-model.mjs';
import { cliFail, parseCliArgs } from './dataset-context.mjs';

/** Nhóm dưới ngưỡng này (hay < 2 lớp đủ mẫu) không có mô hình con: dự đoán chỉ trả nhóm, templateId null. */
export const MIN_GROUP_ROWS = 30;
const THRESHOLDS = [0.6, 0.7, 0.8, 0.85, 0.9, 0.95];
const COVERAGES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
const MARGIN = 0.25;
const MODES = ['flat', 'subgroup'];
const pct = (num, den) => (den ? `${(100 * num / den).toFixed(1)}%` : '–');

/**
 * Lọc dữ liệu cho tầng: bỏ bình luận (source comment) và COMMENT_*; GIỮ OTHER; nhãn không có trong bảng nhóm
 * (TRIAL_PRICE, CERTIFICATION…) → đổi thành OTHER (cảnh báo) để tầng 1 học lớp từ chối.
 * @returns {{ rows: object[], dropped: { comment: number, commentLabel: number }, remapped: Record<string, number>, other: number }}
 */
export function prepareCascadeRows(inputRows, log = () => {}, { includeComments = false } = {}) {
  const dropped = { comment: 0, commentLabel: 0 };
  const remapped = {};
  let other = 0;
  const rows = [];
  for (const input of inputRows.filter(row => row && row.text && row.label).slice().sort((a, b) => (a.at || 0) - (b.at || 0))) {
    if (!includeComments && input.source === 'comment') { dropped.comment += 1; continue; }
    if (!includeComments && isCommentRow(input)) { dropped.commentLabel += 1; continue; }
    const row = intentRowFromRecord(input);
    if (row.label === 'OTHER') { other += 1; rows.push(row); continue; }
    if (groupOf(row.label) === 'OTHER') { remapped[row.label] = (remapped[row.label] || 0) + 1; other += 1; rows.push({ ...row, label: 'OTHER', labelBefore: row.label }); continue; }
    rows.push(row);
  }
  const remappedList = Object.entries(remapped).sort((a, b) => b[1] - a[1]);
  log(`Dòng: ${inputRows.length} · bỏ bình luận ${dropped.comment} · COMMENT_* ${dropped.commentLabel} · giữ OTHER ${other} (trong đó nhãn ngoài bảng nhóm → OTHER: ${remappedList.reduce((sum, [, count]) => sum + count, 0)}) → còn ${rows.length}`);
  if (remappedList.length) log(`  CẢNH BÁO nhãn không có trong bảng nhóm (coi là OTHER): ${remappedList.map(([label, count]) => `${label} (${count})`).join(', ')}`);
  return { rows, dropped, remapped, other };
}

function summarize(report) {
  return { rows: report.rows, train: report.train, test: report.test, labels: report.labels, temperature: report.temperature, heldOut: { n: report.held.n, accuracy: report.held.accuracy }, ece: report.calibration.ece, noisy: report.noisy.length, droppedClasses: report.dataset.droppedClasses };
}

/**
 * Huấn luyện mô hình nhóm (giữ OTHER) + mô hình con ORDER / SUPPORT / ANSWER / PRICE / INFO / SOCIAL trên `rows` (đã lọc).
 * @returns {{ raw: { groups: string[], groupModel: object, specialists: Record<string, object|null> }, reports: object }}
 */
export function trainCascadeModels(rows, { holdout = 0.2, log = () => {}, minGroupRows = MIN_GROUP_ROWS } = {}) {
  const prefixed = tag => (...parts) => log(`  [${tag}] ${parts.join(' ')}`);
  const groupRows = rows.map(row => ({ ...row, label: groupOf(row.label) }));
  const groupTrained = trainClassifier(groupRows, { holdout, log: prefixed('nhóm'), dropOther: false, includeComments: true, recordIds: false });
  const specialists = {};
  const reports = { group: summarize(groupTrained.report), specialists: {} };
  const keys = [['ORDER', groupOf], ['SUPPORT', groupOf], ['ANSWER', groupOf], ...ANSWER_SUBGROUPS.map(subgroup => [subgroup, fineGroupOf])];
  for (const [key, fn] of keys) {
    const subset = rows.filter(row => row.label !== 'OTHER' && fn(row.label) === key);
    const counts = subset.reduce((acc, row) => { acc[row.label] = (acc[row.label] || 0) + 1; return acc; }, {});
    const usable = Object.values(counts).filter(count => count >= MIN_CLASS).length;
    if (subset.length < minGroupRows || usable < 2) {
      specialists[key] = null;
      reports.specialists[key] = { rows: subset.length, labels: Object.keys(counts).length, skipped: subset.length < minGroupRows ? `< ${minGroupRows} dòng` : '< 2 lớp đủ mẫu' };
      log(`  [${key}] ${subset.length} dòng · ${Object.keys(counts).length} nhãn → không huấn luyện mô hình con (${reports.specialists[key].skipped})`);
      continue;
    }
    const trained = trainClassifier(subset, { holdout, log: prefixed(key), includeComments: true, recordIds: false });
    specialists[key] = trained.model;
    reports.specialists[key] = { rows: subset.length, ...summarize(trained.report) };
  }
  return { raw: { groups: groupTrained.model.labels, groupModel: groupTrained.model, specialists }, reports };
}

/** Nhóm 6 lớp của một dự đoán (tầng: subGroup ?? group; phẳng: fine). */
const fineOf = guess => (guess ? guess.fine || guess.subGroup || guess.group : null);

/** Dự đoán phẳng đưa về cùng dạng { templateId, p, margin, group, subgroup, topK } + nhóm theo cộng p (đối chứng rẻ). */
function flatGuessOf(model, row) {
  const guess = model ? predictIntentWith(model, row) : null;
  if (!guess) return null;
  const distribution = probabilitiesOf(model, row) || {};
  return { templateId: guess.templateId, p: guess.confidence, margin: guess.margin, group: groupOf(guess.templateId), fine: fineGroupOf(guess.templateId), topK: guess.topK, groupBySum: sumByGroup(distribution, groupOf)[0]?.group, fineBySum: sumByGroup(distribution, fineGroupOf)[0]?.group };
}

/** Bảng phủ/đúng theo ngưỡng (p ≥ t & biên ≥ 0,25) — mọi mẫu và riêng mẫu an toàn ANSWER (theo mẫu ĐOÁN). Phủ tính trên cả dòng OTHER (đoán ra mẫu ở dòng OTHER = sai). */
function thresholdTable(pairs, view) {
  const n = pairs.length;
  return THRESHOLDS.map(threshold => {
    const kept = pairs.filter(pair => { const g = view(pair); return g && g.templateId && g.p >= threshold && g.margin >= MARGIN; });
    const safe = kept.filter(pair => cascadeSafeTemplates.has(view(pair).templateId));
    return { threshold, n, kept: kept.length, keptHit: kept.filter(pair => view(pair).templateId === pair.truth).length, safe: safe.length, safeHit: safe.filter(pair => view(pair).templateId === pair.truth).length };
  });
}

/** Đường risk–coverage cùng độ phủ: xếp theo p giảm dần, lấy đúng c·n dòng đầu → độ đúng (so hai mô hình ở CÙNG độ phủ, không phải cùng ngưỡng danh nghĩa). */
function riskCoverage(pairs, view) {
  const n = pairs.length;
  const sorted = pairs.map(pair => ({ pair, guess: view(pair) })).filter(item => item.guess && item.guess.templateId).sort((a, b) => b.guess.p - a.guess.p);
  return COVERAGES.map(coverage => {
    const take = Math.min(sorted.length, Math.round(coverage * n));
    const kept = sorted.slice(0, take);
    const hit = kept.filter(item => item.guess.templateId === item.pair.truth).length;
    return { coverage, n: take, hit, precision: take ? Number((hit / take).toFixed(3)) : null, pMin: take ? Number(kept.at(-1).guess.p.toFixed(3)) : null };
  });
}

/** Hiệu chuẩn (ECE 10 ngăn) của một cột xác suất trên các cặp có dự đoán. */
const eceOf = items => calibrationTable(items.map(item => ({ confidence: item.p, label: item.hit ? 'a' : 'b', predicted: 'a' })));

/**
 * So tầng (cả hai answerMode) và phẳng end-to-end trên `testRows`.
 * @param {{ groups: string[], groupModel: object, specialists: object }} raw — JSON thô của tầng (trainCascadeModels)
 * @param {object|null} flat — mô hình phẳng đã nạp (loadIntentModelFrom / subModelFrom) hoặc null
 */
export function evaluateCascade(raw, flat, testRows) {
  const cascades = Object.fromEntries(MODES.map(mode => [mode, cascadeFromRaw({ ...raw, answerMode: mode })]));
  const pairs = testRows.map(row => ({
    row, truth: row.label, truthGroup: groupOf(row.label), truthFine: fineGroupOf(row.label), isOther: row.label === 'OTHER',
    guess: Object.fromEntries(MODES.map(mode => [mode, predictCascadeWith(cascades[mode], row)])),
    flat: flatGuessOf(flat, row)
  }));
  const views = { flat: pair => pair.guess.flat, subgroup: pair => pair.guess.subgroup, plain: pair => pair.flat };
  const section = subset => {
    const known = subset.filter(pair => !pair.isOther);
    const other = subset.filter(pair => pair.isOther);
    const column = view => ({
      n: subset.length, known: known.length,
      groupHit: subset.filter(pair => view(pair)?.group === pair.truthGroup).length,
      groupHitKnown: known.filter(pair => view(pair)?.group === pair.truthGroup).length,
      fineHitKnown: known.filter(pair => fineOf(view(pair)) === pair.truthFine).length,
      hit: known.filter(pair => view(pair)?.templateId === pair.truth).length,
      top3: known.filter(pair => view(pair)?.topK?.slice(0, 3).some(item => item.templateId === pair.truth)).length,
      refuseHit: other.filter(pair => view(pair)?.group === 'OTHER').length,
      refuseWrong: known.filter(pair => view(pair)?.group === 'OTHER').length,
      thresholds: thresholdTable(subset, view),
      riskCoverage: riskCoverage(subset, view)
    });
    const columns = { flat: column(views.flat), subgroup: column(views.subgroup), plain: column(views.plain) };
    // Đối chứng rẻ: phẳng cộng p theo nhóm / nhóm con (không thể ra OTHER → tính trên dòng không OTHER).
    columns.plainSum = { groupHitKnown: known.filter(pair => pair.flat?.groupBySum === pair.truthGroup).length, fineHitKnown: known.filter(pair => pair.flat?.fineBySum === pair.truthFine).length };
    // ECE: tích (mẫu đúng?), tầng 1 (nhóm đúng?), trong nhóm (mẫu đúng? khi nhóm đúng).
    columns.ece = Object.fromEntries(MODES.map(mode => {
      const view = views[mode];
      const withTemplate = subset.filter(pair => view(pair)?.templateId);
      return [mode, {
        product: eceOf(withTemplate.map(pair => ({ p: view(pair).p, hit: view(pair).templateId === pair.truth }))),
        tier1: eceOf(subset.filter(pair => view(pair)).map(pair => ({ p: view(pair).pGroup, hit: view(pair).group === pair.truthGroup }))),
        within: eceOf(withTemplate.filter(pair => view(pair).group === pair.truthGroup).map(pair => ({ p: view(pair).pWithin, hit: view(pair).templateId === pair.truth })))
      }];
    }));
    columns.ece.plain = eceOf(subset.filter(pair => pair.flat).map(pair => ({ p: pair.flat.p, hit: pair.flat.templateId === pair.truth })));
    return columns;
  };
  const perGroup = {};
  for (const subgroup of CASCADE_FINE_GROUPS) {
    const subset = pairs.filter(pair => pair.truthFine === subgroup);
    if (!subset.length) continue;
    perGroup[subgroup] = { n: subset.length, groupHit: Object.fromEntries(MODES.map(mode => [mode, subset.filter(pair => pair.guess[mode]?.group === pair.truthGroup).length])), hit: Object.fromEntries(MODES.map(mode => [mode, subset.filter(pair => pair.guess[mode]?.templateId === pair.truth).length])), flatHit: subset.filter(pair => pair.flat?.templateId === pair.truth).length };
  }
  const hasRuleField = testRows.some(row => 'ruleTemplate' in row);
  const all = section(pairs);
  const bestMode = all.subgroup.hit > all.flat.hit ? 'subgroup' : 'flat';
  return {
    all, staff: section(pairs.filter(pair => isStaffRow(pair.row))), safe: section(pairs.filter(pair => cascadeSafeTemplates.has(pair.truth))),
    ruleMiss: hasRuleField ? section(pairs.filter(pair => isRuleMiss(pair.row))) : null, perGroup, bestMode, pairs
  };
}

/** In bảng so sánh tầng (hai cách) / phẳng. */
export function printComparison(evaluation, log = console.log, { title = 'Giữ-out end-to-end', flatName = 'phẳng' } = {}) {
  const cell = value => String(value).padStart(30);
  const block = (section, heading) => {
    const { flat, subgroup, plain, plainSum, ece } = section;
    log(`\n${heading}: ${flat.n} dòng (${flat.known} có mẫu, ${flat.n - flat.known} OTHER)`);
    log(`  ${''.padEnd(34)}${cell('tầng ANSWER-flat')}${cell('tầng ANSWER-subgroup')}${cell(flatName)}`);
    log(`  ${'đúng nhóm tầng 1 (kể OTHER)'.padEnd(34)}${cell(pct(flat.groupHit, flat.n))}${cell(pct(subgroup.groupHit, subgroup.n))}${cell(pct(plain.groupHit, plain.n))}`);
    log(`  ${'đúng nhóm tầng 1 (không OTHER)'.padEnd(34)}${cell(pct(flat.groupHitKnown, flat.known))}${cell(pct(subgroup.groupHitKnown, subgroup.known))}${cell(`${pct(plain.groupHitKnown, plain.known)} · cộng p ${pct(plainSum.groupHitKnown, plain.known)}`)}`);
    log(`  ${'đúng nhóm 6 lớp (không OTHER)'.padEnd(34)}${cell(pct(flat.fineHitKnown, flat.known))}${cell(pct(subgroup.fineHitKnown, subgroup.known))}${cell(`${pct(plain.fineHitKnown, plain.known)} · cộng p ${pct(plainSum.fineHitKnown, plain.known)}`)}`);
    log(`  ${'đúng mẫu end-to-end (không OTHER)'.padEnd(34)}${cell(`${pct(flat.hit, flat.known)} (${flat.hit})`)}${cell(`${pct(subgroup.hit, subgroup.known)} (${subgroup.hit})`)}${cell(`${pct(plain.hit, plain.known)} (${plain.hit})`)}`);
    log(`  ${'đúng trong top-3'.padEnd(34)}${cell(pct(flat.top3, flat.known))}${cell(pct(subgroup.top3, subgroup.known))}${cell(pct(plain.top3, plain.known))}`);
    log(`  ${'từ chối đúng (dòng OTHER)'.padEnd(34)}${cell(pct(flat.refuseHit, flat.n - flat.known))}${cell(pct(subgroup.refuseHit, subgroup.n - subgroup.known))}${cell('phẳng không có OTHER')}`);
    log(`  ${'từ chối oan (dòng có mẫu)'.padEnd(34)}${cell(pct(flat.refuseWrong, flat.known))}${cell(pct(subgroup.refuseWrong, subgroup.known))}${cell('–')}`);
    log('  ngưỡng p (biên ≥ 0,25) → phủ / đúng   [mẫu an toàn ANSWER: phủ / đúng]   (phủ trên mọi dòng kể OTHER)');
    const fmt = e => `${pct(e.kept, e.n)}/${pct(e.keptHit, e.kept)} [${pct(e.safe, e.n)}/${pct(e.safeHit, e.safe)}]`;
    flat.thresholds.forEach((entry, t) => log(`  ${`  ${entry.threshold.toFixed(2)}`.padEnd(34)}${cell(fmt(entry))}${cell(fmt(subgroup.thresholds[t]))}${cell(fmt(plain.thresholds[t]))}`));
    log('  risk–coverage cùng độ phủ → đúng (p nhỏ nhất trong phần giữ)');
    const fmtRc = e => (e.n ? `${pct(e.hit, e.n)} (p≥${e.pMin.toFixed(2)})` : '–');
    flat.riskCoverage.forEach((entry, c) => log(`  ${`  phủ ${(100 * entry.coverage).toFixed(0)}%`.padEnd(34)}${cell(fmtRc(entry))}${cell(fmtRc(subgroup.riskCoverage[c]))}${cell(fmtRc(plain.riskCoverage[c]))}`));
    log(`  ECE 10 ngăn · tích: ${ece.flat.product.ece} / ${ece.subgroup.product.ece} / phẳng ${ece.plain.ece} · tầng 1: ${ece.flat.tier1.ece} · trong nhóm: ${ece.flat.within.ece} / ${ece.subgroup.within.ece}`);
  };
  block(evaluation.all, title);
  log('  ngăn p của TÍCH (ANSWER-flat) — n · p TB · đúng thật:');
  for (const bin of evaluation.all.ece.flat.product.bins) if (bin.n) log(`    p ${bin.lo.toFixed(1)}–${bin.hi.toFixed(1)}  ${String(bin.n).padStart(4)}   ${bin.meanP.toFixed(3)}   ${pct(bin.accuracy, 1)}`);
  log('  ngăn p của TẦNG 1 — n · p TB · đúng nhóm:');
  for (const bin of evaluation.all.ece.flat.tier1.bins) if (bin.n) log(`    p ${bin.lo.toFixed(1)}–${bin.hi.toFixed(1)}  ${String(bin.n).padStart(4)}   ${bin.meanP.toFixed(3)}   ${pct(bin.accuracy, 1)}`);
  log('  theo nhóm 6 lớp thật (n · đúng nhóm tầng 1 flat/subgroup · đúng mẫu flat/subgroup · đúng mẫu phẳng):');
  for (const [subgroup, entry] of Object.entries(evaluation.perGroup)) log(`    ${subgroup.padEnd(8)} ${String(entry.n).padStart(4)}   ${pct(entry.groupHit.flat, entry.n).padStart(6)}/${pct(entry.groupHit.subgroup, entry.n).padStart(6)}   ${pct(entry.hit.flat, entry.n).padStart(6)}/${pct(entry.hit.subgroup, entry.n).padStart(6)}   ${pct(entry.flatHit, entry.n).padStart(6)}`);
  if (evaluation.staff.flat.n) block(evaluation.staff, `${title} · tập con dòng nhân viên (staff/corrected)`);
  else log('\n  (không có dòng nhân viên trong tập đo)');
  if (evaluation.safe.flat.n) block(evaluation.safe, `${title} · tập con nhãn thật ∈ mẫu an toàn ANSWER`);
  if (evaluation.ruleMiss) block(evaluation.ruleMiss, `${title} · tập rule-miss (ruleTemplate rỗng)`);
  else log('\n  tập rule-miss: không đo (dataset không có trường ruleTemplate)');
  log(`\n  → answerMode chọn: ${evaluation.bestMode} (đúng mẫu ${pct(evaluation.all[evaluation.bestMode].hit, evaluation.all.flat.known)})`);
}

const stripSection = section => section && { n: section.flat.n, known: section.flat.known, flat: { ...section.flat }, subgroup: { ...section.subgroup }, plain: { ...section.plain }, plainSum: section.plainSum, ece: { flat: { product: section.ece.flat.product.ece, tier1: section.ece.flat.tier1.ece, within: section.ece.flat.within.ece }, subgroup: { product: section.ece.subgroup.product.ece, tier1: section.ece.subgroup.tier1.ece, within: section.ece.subgroup.within.ece }, plain: section.ece.plain.ece } };

/**
 * Huấn luyện tầng đầy đủ: đo giữ-out end-to-end (tầng vs phẳng cùng dữ liệu) rồi huấn luyện bản triển khai trên
 * toàn bộ dòng. Trả JSON mô hình { version: 'cascade-2', trainedAt, rows, groups, answerMode, groupModel, specialists, report }.
 */
export function trainCascade(inputRows, { holdout = 0.2, log = () => {}, minGroupRows = MIN_GROUP_ROWS, compareFlat = true, includeComments = false, goldenItems = null, goldenSource = '', trainFlatFull = false } = {}) {
  const { rows, dropped, remapped, other } = prepareCascadeRows(inputRows, log, { includeComments });
  if (rows.length < 10) throw new Error('Quá ít dòng để huấn luyện.');
  const groupCounts = rows.reduce((acc, row) => { const group = groupOf(row.label); acc[group] = (acc[group] || 0) + 1; return acc; }, {});
  const fineCounts = rows.reduce((acc, row) => { const fine = fineGroupOf(row.label); acc[fine] = (acc[fine] || 0) + 1; return acc; }, {});
  log(`Theo nhóm tầng 1: ${CASCADE_GROUPS.filter(group => groupCounts[group]).map(group => `${group} ${groupCounts[group]}`).join(' · ')} · 6 lớp: ${CASCADE_FINE_GROUPS.filter(fine => fineCounts[fine]).map(fine => `${fine} ${fineCounts[fine]}`).join(' · ')}`);

  // ---- 1. Đo giữ-out end-to-end: chia theo thời gian, huấn luyện tầng + phẳng trên phần cũ.
  const split = Math.max(1, Math.floor(rows.length * (1 - holdout)));
  const train = rows.slice(0, split);
  const test = rows.slice(split);
  log(`\nĐo giữ-out: huấn luyện trên ${train.length} dòng cũ, đo trên ${test.length} dòng mới nhất (${(100 * holdout).toFixed(0)}%, chỉ hộp thư)`);
  log('— Tầng (trên phần huấn luyện):');
  const evalPass = trainCascadeModels(train, { holdout, log, minGroupRows });
  let flatModel = null;
  let flatSummary = null;
  if (compareFlat) {
    log('— Phẳng (trên cùng phần huấn luyện, cùng trainClassifier, bỏ OTHER như train-intent):');
    const flatTrained = trainClassifier(train, { holdout, log: (...parts) => log(`  [phẳng] ${parts.join(' ')}`), includeComments: true, recordIds: false });
    flatModel = subModelFrom(flatTrained.model);
    flatSummary = summarize(flatTrained.report);
  }
  const evaluation = evaluateCascade(evalPass.raw, flatModel, test);
  printComparison(evaluation, log);

  // ---- 2. Bản triển khai: huấn luyện lại trên toàn bộ dòng.
  log(`\nHuấn luyện bản triển khai trên toàn bộ ${rows.length} dòng:`);
  const finalPass = trainCascadeModels(rows, { holdout, log, minGroupRows });
  // Bản phẳng "m": CÙNG dataset, cùng công thức (trainClassifier, bỏ OTHER) — mốc so công bằng trên bộ chấm.
  let flatFull = null;
  if (trainFlatFull) {
    log('\nHuấn luyện bản phẳng "m" trên cùng dataset (mốc so trên bộ chấm):');
    flatFull = trainClassifier(rows, { holdout, log: (...parts) => log(`  [phẳng m] ${parts.join(' ')}`), includeComments: true, meta: { ...goldenMetaOf(goldenItems ? goldenOverlap(inputRows, goldenItems, goldenSource) : null), trainIds: trainIdsOf(inputRows.filter(row => row && row.text && row.label)) } }).model;
  }
  const model = {
    version: 'cascade-2',
    trainedAt: new Date().toISOString(),
    meta: { trainIds: trainIdsOf(inputRows.filter(row => row && row.text && row.label)), ...goldenMetaOf(goldenItems ? goldenOverlap(inputRows, goldenItems, goldenSource) : null) },
    rows: rows.length,
    groups: finalPass.raw.groups,
    answerMode: evaluation.bestMode,
    groupModel: finalPass.raw.groupModel,
    specialists: Object.fromEntries(['ORDER', 'SUPPORT', 'ANSWER', ...ANSWER_SUBGROUPS].map(key => [key, finalPass.raw.specialists[key]])),
    report: {
      holdout, dataset: { loaded: inputRows.length, kept: rows.length, dropped, remapped, other, groupCounts, fineCounts },
      heldOut: { train: train.length, test: test.length, all: stripSection(evaluation.all), staff: stripSection(evaluation.staff), safe: stripSection(evaluation.safe), ruleMiss: stripSection(evaluation.ruleMiss), perGroup: evaluation.perGroup, bestMode: evaluation.bestMode, flat: flatSummary, subModels: evalPass.reports },
      subModels: finalPass.reports
    }
  };
  return { model, report: model.report, evaluation, flatFull };
}

// ---- CLI
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const usage = 'Dùng: node tools-intent/train-cascade.mjs <dataset.jsonl> <out.json> [--holdout 0.2] [--golden golden.json] [--flat m.json] [--flat-out m.json] [--include-comments] [--quiet]';
  const cli = parseCliArgs(args, ['--holdout', '--golden', '--flat', '--flat-out'], ['--include-comments', '--quiet']);
  const [datasetPath, outPath] = cli.positional;
  if (!datasetPath || !outPath) cliFail(usage);
  if (!existsSync(datasetPath)) cliFail(`Không thấy dataset: ${datasetPath}`);
  const holdoutRaw = cli.value('--holdout');
  if (holdoutRaw && !(Number(holdoutRaw) > 0 && Number(holdoutRaw) < 1)) cliFail(`--holdout phải là số trong (0, 1) (nhận "${holdoutRaw}").`);
  const holdout = holdoutRaw ? Math.min(0.5, Math.max(0.05, Number(holdoutRaw))) : 0.2;
  const goldenPath = cli.value('--golden');
  const flatPathArg = cli.value('--flat');
  // Kiểm đầu vào TRƯỚC khi huấn luyện (huấn luyện mất vài phút).
  let goldenItems = null;
  if (goldenPath) {
    if (!existsSync(goldenPath)) cliFail(`Không thấy bộ chấm --golden: ${goldenPath}`);
    try { goldenItems = JSON.parse(readFileSync(goldenPath, 'utf8')).items; } catch (error) { cliFail(`Bộ chấm ${goldenPath} không đọc được: ${String(error.message).slice(0, 80)}`); }
    if (!Array.isArray(goldenItems)) cliFail(`Bộ chấm ${goldenPath} không có mảng items.`);
  }
  let flatGiven = null;
  if (flatPathArg) {
    if (!existsSync(flatPathArg)) cliFail(`Không thấy mô hình phẳng --flat: ${flatPathArg}`);
    flatGiven = loadIntentModelFrom(flatPathArg);
    if (!flatGiven) cliFail(`Không đọc được mô hình phẳng --flat: ${flatPathArg}`);
  }
  const quiet = cli.has('--quiet');
  // --quiet: im thật — không nhật ký/bảng huấn luyện; chỉ dòng "saved …" (và bảng bộ chấm nếu có --golden).
  const log = quiet ? () => {} : (...parts) => console.log(...parts);
  const readStats = {};
  const dataset = readDataset(datasetPath, readStats);
  if (readStats.bad) console.warn(`Bỏ ${readStats.bad} dòng hỏng trong ${datasetPath}`);
  let trained;
  try {
    trained = trainCascade(dataset, { holdout, log, includeComments: cli.has('--include-comments'), goldenItems, goldenSource: goldenPath, trainFlatFull: Boolean(goldenPath && !flatGiven) || cli.has('--flat-out') });
  } catch (error) {
    if (error.message !== 'Quá ít dòng để huấn luyện.') throw error;
    cliFail(error.message);
  }
  writeFileSync(outPath, JSON.stringify(trained.model));
  const specialistsLine = Object.entries(trained.model.specialists).map(([key, model]) => `${key} ${model ? `${model.labels.length} mẫu` : 'null'}`).join(' · ');
  const saw = trained.model.meta.sawGolden;
  console.log(`saved ${outPath} ${Math.round(Buffer.byteLength(JSON.stringify(trained.model)) / 1024)} KB · nhóm ${trained.model.groups.join('/')} · answerMode ${trained.model.answerMode} · mô hình con: ${specialistsLine} · sawGolden ${saw === null ? 'không rõ (không có --golden)' : saw}`);
  if (cli.value('--flat-out') && trained.flatFull) { writeFileSync(cli.value('--flat-out'), JSON.stringify(trained.flatFull)); console.log(`saved bản phẳng m ${cli.value('--flat-out')}`); }
  if (saw) console.warn(`CẢNH BÁO dataset CHỨA ${trained.model.meta.goldenExcluded.matchedRows} dòng thuộc bộ chấm (${JSON.stringify(trained.model.meta.goldenExcluded.byKind)}): số đo trên ${goldenPath} bị thổi phồng.`);

  // --golden: đo bản triển khai trên bộ chấm (tin hộp thư đã chấm; ngữ cảnh v2 dựng từ kho nếu có) so với bản PHẲNG "m"
  // cùng dataset, cùng công thức (hay --flat) — không so với mô hình đang chạy (đã thấy golden).
  if (goldenPath) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const { enrichGoldenContext, goldenContextFields } = await import(pathToFileURL(path.join(root, 'app', 'golden-set.mjs')).href);
    const items = goldenItems.filter(item => item && item.source !== 'comment' && item.label && item.label !== 'SKIP');
    const storePath = [path.join(path.dirname(goldenPath), 'meta-conversations.json'), path.join(root, 'data', 'processed', 'meta-conversations.json')].find(file => existsSync(file));
    let store = null;
    if (items.some(item => goldenContextFields.some(field => item[field] === undefined)) && storePath) { try { store = JSON.parse(readFileSync(storePath, 'utf8')); } catch { store = null; } }
    const rows = enrichGoldenContext(items, store).map(item => (groupOf(item.label) === 'OTHER' ? { ...item, label: 'OTHER' } : item));
    const flat = flatGiven || subModelFrom(trained.flatFull);
    const flatName = flatGiven ? `phẳng ${path.basename(flatPathArg)}` : 'phẳng m (cùng dataset)';
    const evaluation = evaluateCascade(trained.model, flat, rows);
    const flatSaw = flatGiven ? flatGiven.meta?.sawGolden : trained.flatFull?.meta?.sawGolden;
    console.log(`\nBộ chấm ${goldenPath}: ${rows.length} tin hộp thư đã chấm (nhãn ngoài bảng → OTHER) · ${flatName}${flatSaw ? ' — CẢNH BÁO: bản phẳng đã thấy golden' : flatSaw === undefined || flatSaw === null ? ' (không rõ đã thấy golden chưa)' : ''}`);
    printComparison(evaluation, console.log, { title: 'Bộ chấm', flatName });
  }
}
