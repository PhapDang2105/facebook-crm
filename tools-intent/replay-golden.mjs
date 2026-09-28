// Replay bộ chấm mẫu: so mô hình nhỏ (và luật ổn định) với mã mẫu nhân viên đã chấm.
// Dùng: node tools-intent/replay-golden.mjs [golden-set.json] [--all] [--model <path>] [--compare <path2>] [--gate]
//   - mặc định đọc data/processed/golden-set.json, chỉ tính tin ĐÃ CHẤM (label ≠ SKIP);
//   - --all: chưa có tin chấm thì tạm dùng nhãn gợi ý (LLM) để xem sơ bộ, kết quả KHÔNG dùng để bật;
//   - --model <path> (hay INTENT_MODEL_PATH): tệp trọng số đem đo, mặc định app/processing/intent-model.json;
//   - --compare <path2>: in hai cột (mô hình 1 / mô hình 2, ví dụ v5 / v6) trên cùng bộ chấm;
//   - --gate: có tệp replay-llm-out.json cạnh bộ chấm (do replay-llm.mjs ghi) thì tính precision/recall của
//     cờ "câu LLM ∉ topK3 mô hình ∪ luật" trong việc bắt LLM sai, trên nhóm ORDER_CONFIRMATION/ORDER_UPDATE/ORDER_CANCEL*;
//   - --cascade <path>: mô hình TẦNG (train-cascade.mjs) → in bảng so sánh phẳng (mô hình 1) vs tầng, toàn bộ / rule-miss /
//     nhãn an toàn: đúng thô, đúng nhóm (kể và không kể OTHER, đối chứng phẳng cộng p), từ chối đúng/oan, phủ/đúng theo ngưỡng
//     0,6–0,95 với mẫu an toàn = ANSWER ∩ intentSafeTemplates, và đường risk–coverage cùng độ phủ.
// Mục golden thiếu ngữ cảnh v2 (hasBasket, hasOrder, prevBotAsks…) được dựng lại bằng enrichGoldenContext
// từ kho hội thoại data/processed/meta-conversations.json nếu có (không có kho vẫn chạy, suy từ chính mục).
// In ra: độ đúng tổng, đường risk–coverage theo ngưỡng (để chọn intentThreshold), tập rule-miss, tin sai ở mức chắc.
// Không gọi LLM, không gửi gì cho khách.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
const useAll = args.includes('--all');
const useGate = args.includes('--gate');
const goldenPath = args.find((arg, index) => !arg.startsWith('--') && !['--model', '--compare', '--cascade'].includes(args[index - 1])) || path.join(root, 'data', 'processed', 'golden-set.json');
const modelPath = option('--model') || process.env.INTENT_MODEL_PATH || path.join(root, 'app', 'processing', 'intent-model.json');
const comparePath = option('--compare');
const cascadePath = option('--cascade');
const { loadIntentModelFrom, predictIntentWith, intentSafeTemplates } = await import(pathToFileURL(path.join(root, 'app', 'processing', 'intent-model.mjs')).href);
const { loadCascadeFrom, predictCascadeWith, groupOf, fineGroupOf, cascadeSafeTemplates, CASCADE_FINE_GROUPS, probabilitiesOf, sumByGroup } = await import(pathToFileURL(path.join(root, 'app', 'processing', 'intent-cascade.mjs')).href);
const { ruleIntent } = await import(pathToFileURL(path.join(root, 'app', 'processing', 'rule-intent.mjs')).href);
const { describeDeliveryAddress } = await import(pathToFileURL(path.join(root, 'app', 'processing', 'locations.mjs')).href);
const { enrichGoldenContext, goldenContextFields } = await import(pathToFileURL(path.join(root, 'app', 'golden-set.mjs')).href);

const models = [{ name: comparePath ? 'mô hình 1' : 'mô hình', file: modelPath, model: loadIntentModelFrom(modelPath) }];
if (comparePath) models.push({ name: 'mô hình 2', file: comparePath, model: loadIntentModelFrom(comparePath) });
for (const entry of models) {
  if (!entry.model) { console.log(`Không đọc được ${entry.file}`); process.exit(1); }
  console.log(`${entry.name}: ${entry.file} · ${entry.model.labels.length} nhãn · ${entry.model.rows || '?'} dòng · nhiệt độ ${entry.model.temperature}${entry.model.trainedAt ? ` · huấn luyện ${entry.model.trainedAt}` : ''}`);
}
let cascade = null;
if (cascadePath) {
  cascade = loadCascadeFrom(cascadePath);
  if (!cascade) { console.log(`Không đọc được mô hình tầng ${cascadePath}`); process.exit(1); }
  const specialists = Object.entries(cascade.specialists).map(([key, model]) => `${key} ${model ? model.labels.length : 'null'}`).join(' · ');
  console.log(`mô hình tầng: ${cascadePath} · nhóm ${cascade.groups.join('/')} · answerMode ${cascade.answerMode} · mô hình con (số mẫu): ${specialists} · ${cascade.rows || '?'} dòng${cascade.trainedAt ? ` · huấn luyện ${cascade.trainedAt}` : ''}`);
}

const rawItems = (JSON.parse(readFileSync(goldenPath, 'utf8')).items || []).filter(item => item.source !== 'comment');
const graded = rawItems.filter(item => item.label && item.label !== 'SKIP').map(item => ({ ...item, truth: item.label }));
const picked = graded.length || !useAll ? graded : rawItems.filter(item => item.suggested).map(item => ({ ...item, truth: item.suggested }));
if (!picked.length) { console.log('Chưa có tin nào được chấm (Cài đặt → Thiết lập chatbot → Chấm mẫu). Thêm --all để xem sơ bộ theo nhãn gợi ý.'); process.exit(0); }
console.log(`${picked.length} tin hộp thư ${graded.length ? 'đã chấm' : 'theo nhãn gợi ý LLM (sơ bộ)'} · ${rawItems.length - picked.length} tin bỏ qua`);

// Dựng ngữ cảnh v2 cho mục thiếu trường (kho hội thoại nếu có, cùng thư mục với bộ chấm hoặc data/processed).
const missing = picked.filter(item => goldenContextFields.some(field => item[field] === undefined)).length;
const storeCandidates = [path.join(path.dirname(goldenPath), 'meta-conversations.json'), path.join(root, 'data', 'processed', 'meta-conversations.json')];
const storePath = process.env.META_CONVERSATIONS_PATH || storeCandidates.find(file => existsSync(file));
let store = null;
if (missing && storePath && existsSync(storePath)) { try { store = JSON.parse(readFileSync(storePath, 'utf8')); } catch { store = null; } }
const rows = missing ? enrichGoldenContext(picked, store) : picked;
if (missing) console.log(`Dựng ngữ cảnh v2 cho ${missing} tin thiếu trường${store ? ` (kho ${storePath})` : ' (không có kho hội thoại: không có đơn, giỏ suy từ mẫu/câu bot trước)'}`);

const ORDER_STEPS = new Set(['ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'ORDER_CONFIRMATION', 'ORDER_CART_LINE']);
const contextOf = item => ({
  text: item.text, prevBot: item.prevBot || '', prevCustomer: item.prevCustomer || '', source: item.source, lastTemplate: item.lastTemplate || '',
  lastWasOrderStep: ORDER_STEPS.has(item.lastTemplate), hasBasket: item.hasBasket ?? ORDER_STEPS.has(item.lastTemplate), basketItems: item.basketItems || [],
  hasOrder: item.hasOrder, orderAgeMin: item.orderAgeMin, livestream: false, prevBotAsks: item.prevBotAsks, phoneInText: item.phoneInText, addressInText: item.addressInText, bagCount: item.bagCount
});
const results = rows.map(item => {
  const intents = models.map(entry => predictIntentWith(entry.model, contextOf(item)));
  const ruled = ruleIntent(item.text, { source: item.source, botLastTemplateId: item.lastTemplate || '' });
  const ruleTemplate = ruled?.value?.template_id || (ruled?.commentRule ? 'COMMENT_RULE' : '');
  const tiered = cascade ? predictCascadeWith(cascade, contextOf(item)) : null;
  return { item, intent: intents[0], intents, ruleTemplate, cascade: tiered };
});

const pct = (num, den) => (den ? `${(100 * num / den).toFixed(1)}%` : '–');
const ruledRows = results.filter(row => row.ruleTemplate && row.ruleTemplate !== 'COMMENT_RULE');
console.log(`Luật ổn định bắt: ${ruledRows.length}/${results.length} · đúng: ${pct(ruledRows.filter(row => row.ruleTemplate === row.item.truth).length, ruledRows.length)}`);

/** Bảng độ đúng + ngưỡng cho một tập kết quả; nhiều mô hình → nhiều cột. */
function report(subset, title) {
  console.log(`\n${title}: ${subset.length} tin`);
  const columns = models.map((entry, m) => {
    const withIntent = subset.filter(row => row.intents[m]);
    const hit = withIntent.filter(row => row.intents[m].templateId === row.item.truth).length;
    const thresholds = [0.6, 0.7, 0.8, 0.85, 0.9, 0.95].map(threshold => {
      const kept = withIntent.filter(row => row.intents[m].confidence >= threshold && row.intents[m].margin >= 0.25);
      const keptHit = kept.filter(row => row.intents[m].templateId === row.item.truth).length;
      const safe = kept.filter(row => intentSafeTemplates.has(row.intents[m].templateId));
      const safeHit = safe.filter(row => row.intents[m].templateId === row.item.truth).length;
      return { threshold, kept: kept.length, keptHit, safe: safe.length, safeHit };
    });
    const top3 = withIntent.filter(row => row.intents[m].topK.some(candidate => candidate.templateId === row.item.truth)).length;
    return { name: entry.name, n: withIntent.length, hit, top3, thresholds };
  });
  const cell = value => String(value).padStart(28);
  console.log(`  ${''.padEnd(34)}${columns.map(column => cell(column.name)).join('')}`);
  console.log(`  ${'có dự đoán'.padEnd(34)}${columns.map(column => cell(`${column.n}/${subset.length}`)).join('')}`);
  console.log(`  ${'đúng thô (mọi mức)'.padEnd(34)}${columns.map(column => cell(`${pct(column.hit, column.n)} (${column.hit})`)).join('')}`);
  console.log(`  ${'đúng trong top-3'.padEnd(34)}${columns.map(column => cell(pct(column.top3, column.n))).join('')}`);
  console.log('  ngưỡng p (biên ≥ 0,25) → phủ / đúng   [mẫu an toàn: phủ / đúng]');
  for (let t = 0; t < 6; t += 1) {
    const threshold = columns[0].thresholds[t].threshold;
    console.log(`  ${`  ${threshold.toFixed(2)}`.padEnd(34)}${columns.map(column => { const e = column.thresholds[t]; return cell(`${pct(e.kept, subset.length)}/${pct(e.keptHit, e.kept)} [${pct(e.safe, subset.length)}/${pct(e.safeHit, e.safe)}]`); }).join('')}`);
  }
  return columns;
}

/** Bảng theo nhãn (n, đúng, p TB) cho mô hình m trên một tập. */
function perLabel(subset, m, title) {
  const table = {};
  for (const row of subset) { const intent = row.intents[m]; if (!intent) continue; const entry = table[row.item.truth] ||= { n: 0, hit: 0, pSum: 0 }; entry.n += 1; entry.pSum += intent.confidence; if (intent.templateId === row.item.truth) entry.hit += 1; }
  console.log(`\n${title} — theo nhãn (n · đúng · p TB):`);
  for (const [label, entry] of Object.entries(table).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${label.padEnd(28)} ${String(entry.n).padStart(4)} ${String(entry.hit).padStart(5)}   ${(entry.pSum / entry.n).toFixed(2)}`);
}

report(results, 'Toàn bộ tin đã chấm');
// Tập rule-miss: luật ổn định không bắt → phần mô hình nhỏ (hay LLM) thật sự phải quyết.
const ruleMissRows = results.filter(row => !row.ruleTemplate || row.ruleTemplate === 'COMMENT_RULE');
report(ruleMissRows, 'Tập rule-miss (luật ổn định không bắt)');
models.forEach((entry, m) => perLabel(ruleMissRows, m, `Rule-miss · ${entry.name}`));

// Ngưỡng bảo toàn (conformal): ngưỡng nhỏ nhất sao cho phần giữ lại (mẫu an toàn) sai ≤ 3%.
models.forEach((entry, m) => {
  const sorted = results.filter(row => row.intents[m] && row.intents[m].margin >= 0.25 && intentSafeTemplates.has(row.intents[m].templateId)).sort((a, b) => b.intents[m].confidence - a.intents[m].confidence);
  let best = null;
  for (let n = sorted.length; n >= 1; n -= 1) {
    const kept = sorted.slice(0, n);
    const wrong = kept.filter(row => row.intents[m].templateId !== row.item.truth).length;
    if (wrong / n <= 0.03) { best = { threshold: kept.at(-1).intents[m].confidence, coverage: n, wrong }; break; }
  }
  console.log(`\n${entry.name} · ${best ? `ngưỡng gợi ý (sai ≤ 3%, mẫu an toàn): ${best.threshold.toFixed(2)} → phủ ${best.coverage}/${results.length}, sai ${best.wrong}` : 'không có ngưỡng nào đạt sai ≤ 3%.'}`);
});

// --cascade: phẳng (mô hình 1) vs tầng trên cùng bộ chấm, cùng cách đo với train-cascade:
//   - nhãn chấm ngoài bảng nhóm (OTHER, SHOP_ORDER_RECEIVED, CALORIES_DIET…) → nhóm OTHER: "đúng mẫu" tính trên tin CÓ mẫu
//     (cả hai mô hình đều không có lớp đó), tầng được chấm thêm "từ chối đúng" (nhóm OTHER ở tin OTHER) / "từ chối oan";
//   - "đúng nhóm" của phẳng = groupOf(mẫu đoán); đối chứng rẻ "phẳng cộng p theo nhóm" in cạnh (phẳng không thể ra OTHER);
//   - mẫu an toàn = ANSWER ∩ intentSafeTemplates, áp cho CẢ hai cột; phủ theo ngưỡng tính trên mọi tin (kể OTHER);
//   - đường risk–coverage: cùng ĐỘ PHỦ (10–60% tin, xếp theo p) thay vì cùng ngưỡng danh nghĩa (p tầng là tích nên thấp hơn);
//   - tập con: rule-miss, nhãn thật ∈ mẫu an toàn ANSWER (bộ chấm không có labelSource → không tách dòng nhân viên).
if (cascade) {
  const flatView = row => {
    const intent = row.intents[0];
    if (!intent) return null;
    const distribution = probabilitiesOf(models[0].model, contextOf(row.item)) || {};
    return { templateId: intent.templateId, p: intent.confidence, margin: intent.margin, group: groupOf(intent.templateId), fine: fineGroupOf(intent.templateId), topK: intent.topK, groupBySum: sumByGroup(distribution, groupOf)[0]?.group, fineBySum: sumByGroup(distribution, fineGroupOf)[0]?.group };
  };
  const tierView = row => (row.cascade ? { templateId: row.cascade.templateId, p: row.cascade.p, margin: row.cascade.margin, group: row.cascade.group, fine: row.cascade.subGroup || row.cascade.group, pGroup: row.cascade.pGroup, topK: row.cascade.topK.slice(0, 3) } : null);
  const COVERAGES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  const column = (subset, view) => {
    const pairs = subset.map(row => ({ truth: row.item.truth, truthGroup: groupOf(row.item.truth), truthFine: fineGroupOf(row.item.truth), guess: view(row) }));
    const known = pairs.filter(pair => pair.truthGroup !== 'OTHER');
    const other = pairs.filter(pair => pair.truthGroup === 'OTHER');
    const thresholds = [0.6, 0.7, 0.8, 0.85, 0.9, 0.95].map(threshold => {
      const kept = pairs.filter(pair => pair.guess && pair.guess.templateId && pair.guess.p >= threshold && pair.guess.margin >= 0.25);
      const safe = kept.filter(pair => cascadeSafeTemplates.has(pair.guess.templateId));
      return { threshold, kept: kept.length, keptHit: kept.filter(pair => pair.guess.templateId === pair.truth).length, safe: safe.length, safeHit: safe.filter(pair => pair.guess.templateId === pair.truth).length };
    });
    const ranked = pairs.filter(pair => pair.guess && pair.guess.templateId).sort((a, b) => b.guess.p - a.guess.p);
    const riskCoverage = COVERAGES.map(coverage => { const take = Math.min(ranked.length, Math.round(coverage * pairs.length)); const kept = ranked.slice(0, take); return { coverage, n: take, hit: kept.filter(pair => pair.guess.templateId === pair.truth).length, pMin: take ? kept.at(-1).guess.p : null }; });
    return {
      n: pairs.filter(pair => pair.guess).length, known: known.length, other: other.length,
      hit: known.filter(pair => pair.guess?.templateId === pair.truth).length,
      groupHit: pairs.filter(pair => pair.guess?.group === pair.truthGroup).length,
      groupHitKnown: known.filter(pair => pair.guess?.group === pair.truthGroup).length,
      groupBySum: known.filter(pair => pair.guess?.groupBySum === pair.truthGroup).length,
      fineHitKnown: known.filter(pair => pair.guess?.fine === pair.truthFine).length,
      fineBySum: known.filter(pair => pair.guess?.fineBySum === pair.truthFine).length,
      refuseHit: other.filter(pair => pair.guess?.group === 'OTHER').length,
      refuseWrong: known.filter(pair => pair.guess?.group === 'OTHER').length,
      top3: known.filter(pair => pair.guess?.topK.some(candidate => candidate.templateId === pair.truth)).length,
      thresholds, riskCoverage
    };
  };
  const compare = (subset, title) => {
    const flat = column(subset, flatView);
    const tier = column(subset, tierView);
    const cell = value => String(value).padStart(32);
    console.log(`\n--cascade · ${title}: ${subset.length} tin (${flat.known} có mẫu, ${flat.other} nhóm OTHER)`);
    console.log(`  ${''.padEnd(34)}${cell('phẳng (mô hình 1)')}${cell(`tầng (ANSWER-${cascade.answerMode})`)}`);
    console.log(`  ${'có dự đoán'.padEnd(34)}${cell(`${flat.n}/${subset.length}`)}${cell(`${tier.n}/${subset.length}`)}`);
    console.log(`  ${'đúng thô (tin có mẫu)'.padEnd(34)}${cell(`${pct(flat.hit, flat.known)} (${flat.hit})`)}${cell(`${pct(tier.hit, tier.known)} (${tier.hit})`)}`);
    console.log(`  ${'đúng nhóm tầng 1 (kể OTHER)'.padEnd(34)}${cell(`${pct(flat.groupHit, subset.length)} (${flat.groupHit})`)}${cell(`${pct(tier.groupHit, subset.length)} (${tier.groupHit})`)}`);
    console.log(`  ${'đúng nhóm tầng 1 (tin có mẫu)'.padEnd(34)}${cell(`${pct(flat.groupHitKnown, flat.known)} · cộng p ${pct(flat.groupBySum, flat.known)}`)}${cell(pct(tier.groupHitKnown, tier.known))}`);
    console.log(`  ${'đúng nhóm 6 lớp (tin có mẫu)'.padEnd(34)}${cell(`${pct(flat.fineHitKnown, flat.known)} · cộng p ${pct(flat.fineBySum, flat.known)}`)}${cell(pct(tier.fineHitKnown, tier.known))}`);
    console.log(`  ${'đúng trong top-3 (tin có mẫu)'.padEnd(34)}${cell(pct(flat.top3, flat.known))}${cell(pct(tier.top3, tier.known))}`);
    console.log(`  ${'từ chối đúng (tin OTHER)'.padEnd(34)}${cell('phẳng không có OTHER')}${cell(`${pct(tier.refuseHit, tier.other)} (${tier.refuseHit}/${tier.other})`)}`);
    console.log(`  ${'từ chối oan (tin có mẫu)'.padEnd(34)}${cell('–')}${cell(`${pct(tier.refuseWrong, tier.known)} (${tier.refuseWrong})`)}`);
    console.log('  ngưỡng p (biên ≥ 0,25) → phủ / đúng   [mẫu an toàn ANSWER: phủ / đúng]   (phủ trên mọi tin)');
    for (let t = 0; t < 6; t += 1) {
      const fmt = e => `${pct(e.kept, subset.length)}/${pct(e.keptHit, e.kept)} [${pct(e.safe, subset.length)}/${pct(e.safeHit, e.safe)}]`;
      console.log(`  ${`  ${flat.thresholds[t].threshold.toFixed(2)}`.padEnd(34)}${cell(fmt(flat.thresholds[t]))}${cell(fmt(tier.thresholds[t]))}`);
    }
    console.log('  risk–coverage cùng độ phủ → đúng (p nhỏ nhất trong phần giữ)');
    for (let c = 0; c < COVERAGES.length; c += 1) {
      const fmt = e => (e.n ? `${pct(e.hit, e.n)} (${e.hit}/${e.n}, p≥${e.pMin.toFixed(2)})` : '–');
      console.log(`  ${`  phủ ${(100 * COVERAGES[c]).toFixed(0)}%`.padEnd(34)}${cell(fmt(flat.riskCoverage[c]))}${cell(fmt(tier.riskCoverage[c]))}`);
    }
    return { flat, tier };
  };
  compare(results, 'toàn bộ tin đã chấm');
  compare(ruleMissRows, 'tập rule-miss (luật ổn định không bắt)');
  compare(results.filter(row => cascadeSafeTemplates.has(row.item.truth)), 'tập con nhãn thật ∈ mẫu an toàn ANSWER');
  console.log('  (bộ chấm không có labelSource → không tách tập con dòng nhân viên)');
  // Theo nhóm 6 lớp thật: tầng đúng nhóm tầng 1 bao nhiêu, và đúng mẫu tầng / phẳng.
  console.log('\n--cascade · theo nhóm 6 lớp thật (n · tầng đúng nhóm tầng 1 · tầng đúng mẫu · phẳng đúng mẫu):');
  for (const fine of CASCADE_FINE_GROUPS) {
    const subset = results.filter(row => fineGroupOf(row.item.truth) === fine);
    if (!subset.length) continue;
    const groupHit = subset.filter(row => row.cascade?.group === groupOf(row.item.truth)).length;
    const hit = subset.filter(row => row.cascade?.templateId === row.item.truth).length;
    const flatHit = subset.filter(row => row.intents[0]?.templateId === row.item.truth).length;
    console.log(`  ${fine.padEnd(8)} ${String(subset.length).padStart(4)}   ${pct(groupHit, subset.length).padStart(6)}   ${pct(hit, subset.length).padStart(6)}   ${pct(flatHit, subset.length).padStart(6)}`);
  }
  // Ngưỡng bảo toàn cho tầng (mẫu an toàn, sai ≤ 3%), cùng cách với mô hình phẳng ở trên.
  const sorted = results.filter(row => row.cascade && row.cascade.templateId && row.cascade.margin >= 0.25 && cascadeSafeTemplates.has(row.cascade.templateId)).sort((a, b) => b.cascade.p - a.cascade.p);
  let best = null;
  for (let n = sorted.length; n >= 1; n -= 1) {
    const kept = sorted.slice(0, n);
    const wrong = kept.filter(row => row.cascade.templateId !== row.item.truth).length;
    if (wrong / n <= 0.03) { best = { threshold: kept.at(-1).cascade.p, coverage: n, wrong }; break; }
  }
  console.log(`\ntầng · ${best ? `ngưỡng gợi ý (sai ≤ 3%, mẫu an toàn): ${best.threshold.toFixed(2)} → phủ ${best.coverage}/${results.length}, sai ${best.wrong}` : 'không có ngưỡng nào đạt sai ≤ 3%.'}`);
  const wrongGroup = results.filter(row => row.cascade && row.cascade.pGroup >= 0.85 && row.cascade.group !== groupOf(row.item.truth)).slice(0, 12);
  if (wrongGroup.length) {
    console.log('\ntầng · sai NHÓM ở mức chắc (p nhóm ≥ 0,85):');
    for (const row of wrongGroup) console.log(`  "${row.item.text.slice(0, 70)}" → ${row.cascade.group} (${row.cascade.pGroup.toFixed(2)}) · đúng ${groupOf(row.item.truth)}/${row.item.truth}${row.item.lastTemplate ? ` · bot trước ${row.item.lastTemplate}` : ''}`);
  }
  const wrongTemplate = results.filter(row => row.cascade && row.cascade.templateId && row.cascade.p >= 0.85 && row.cascade.templateId !== row.item.truth).slice(0, 15);
  if (wrongTemplate.length) {
    console.log('\ntầng · sai MẪU ở mức chắc (p ≥ 0,85):');
    for (const row of wrongTemplate) console.log(`  "${row.item.text.slice(0, 70)}" → ${row.cascade.path.join(' › ')} (${row.cascade.p.toFixed(2)}, trong nhóm ${row.cascade.pWithin?.toFixed(2)}) · đúng ${row.item.truth}${row.item.lastTemplate ? ` · bot trước ${row.item.lastTemplate}` : ''}`);
  }
}

// Luật thử nghiệm / luồng đơn (order-flow): giả định có giỏ khi bot vừa ở bước đơn; giá trị ORDER_ADDRESS
// do bộ soạn đơn quyết tiếp nên "đúng" = nhãn chấm là một bước đơn (xin phần thiếu / chốt).
const ORDER_TRUTHS = new Set(['ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'ORDER_CONFIRMATION']);
const flowRows = rows.map(item => {
  const stripped = String(item.text || '').replace(/\+?\d[\d .-]{8,13}/g, ' ').replace(/<sdt>/g, ' ').trim();
  const lastWasOrderStep = ORDER_STEPS.has(item.lastTemplate) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(item.lastTemplate);
  const ruled = ruleIntent(item.text, { source: item.source, botLastTemplateId: item.lastTemplate || '', hasBasket: lastWasOrderStep, lastWasOrderStep, addressComplete: lastWasOrderStep && Boolean(stripped) && describeDeliveryAddress(stripped).complete, addressText: stripped, experimentalRules: 'on', commentBasket: () => [] });
  return { item, ruled };
}).filter(row => row.ruled?.experimental);
if (flowRows.length) {
  const hit = flowRows.filter(row => (row.ruled.value?.template_id === 'ORDER_ADDRESS' ? ORDER_TRUTHS.has(row.item.truth) : row.ruled.value?.template_id === row.item.truth));
  console.log(`\nLuật thử nghiệm (luồng đơn, giả định có giỏ khi bot vừa ở bước đơn): bắt ${flowRows.length}/${results.length} · hợp nhãn ${pct(hit.length, flowRows.length)}`);
  for (const row of flowRows.filter(row => !hit.includes(row)).slice(0, 10)) console.log(`  "${row.item.text.slice(0, 60)}" → ${row.ruled.rule} ${row.ruled.value?.template_id} · đúng ${row.item.truth} · bot trước ${row.item.lastTemplate || '-'}`);
}
const ruleWrong = ruledRows.filter(row => row.ruleTemplate !== row.item.truth);
if (ruleWrong.length) {
  console.log('\nLuật ổn định sai (đang chạy thật, cần xem):');
  for (const row of ruleWrong) console.log(`  "${row.item.text.slice(0, 70)}" → luật ${row.ruleTemplate} · đúng ${row.item.truth}${row.item.lastTemplate ? ` · bot trước ${row.item.lastTemplate}` : ''}`);
}
models.forEach((entry, m) => {
  const confident = results.filter(row => row.intents[m] && row.intents[m].confidence >= 0.85 && row.intents[m].templateId !== row.item.truth).slice(0, 15);
  if (!confident.length) return;
  console.log(`\n${entry.name} · sai ở mức chắc (p ≥ 0,85):`);
  for (const row of confident) console.log(`  "${row.item.text.slice(0, 70)}" → ${row.intents[m].templateId} (${row.intents[m].confidence.toFixed(2)}) · đúng ${row.item.truth}${row.item.lastTemplate ? ` · bot trước ${row.item.lastTemplate}` : ''}${row.item.prevBotAsks ? ` · bot xin ${row.item.prevBotAsks}` : ''}`);
});

// --gate: cờ "câu LLM ∉ topK3 mô hình ∪ luật" có bắt được LLM sai không (trên nhóm lên đơn nhạy cảm)?
if (useGate) {
  const llmPath = path.join(path.dirname(goldenPath), 'replay-llm-out.json');
  if (!existsSync(llmPath)) console.log(`\n--gate: không thấy ${llmPath} (chạy replay-llm.mjs trước).`);
  else {
    const llmOut = JSON.parse(readFileSync(llmPath, 'utf8'));
    const llmById = new Map(llmOut.map(row => [row.id, row]));
    const GATE_GROUP = /^ORDER_(CONFIRMATION|UPDATE|CANCEL)/;
    models.forEach((entry, m) => {
      const joined = results.map(row => ({ row, llm: llmById.get(row.item.id) })).filter(pair => pair.llm && pair.llm.llm && !String(pair.llm.llm).startsWith('LỖI') && pair.row.intents[m]);
      const scope = joined.filter(pair => GATE_GROUP.test(pair.row.item.truth) || GATE_GROUP.test(pair.llm.llm));
      const flagged = pair => !pair.row.intents[m].topK.some(candidate => candidate.templateId === pair.llm.llm) && pair.row.ruleTemplate !== pair.llm.llm;
      const wrong = pair => pair.llm.llm !== pair.row.item.truth;
      const tally = list => { const f = list.filter(flagged); const w = list.filter(wrong); const tp = f.filter(wrong).length; return { n: list.length, flagged: f.length, wrong: w.length, tp, precision: pct(tp, f.length), recall: pct(tp, w.length) }; };
      const inScope = tally(scope);
      const overall = tally(joined);
      console.log(`\n--gate · ${entry.name} · cờ "LLM ∉ top-3 ∪ luật" (LLM từ ${path.basename(llmPath)}, ${joined.length} tin ghép được):`);
      console.log(`  nhóm ORDER_CONFIRMATION/UPDATE/CANCEL* (nhãn chấm hoặc câu LLM): ${inScope.n} tin · LLM sai ${inScope.wrong} · cờ bật ${inScope.flagged} · bắt đúng ${inScope.tp} → precision ${inScope.precision} · recall ${inScope.recall}`);
      console.log(`  toàn bộ: ${overall.n} tin · LLM sai ${overall.wrong} · cờ bật ${overall.flagged} · bắt đúng ${overall.tp} → precision ${overall.precision} · recall ${overall.recall}`);
      for (const pair of scope.filter(pair => flagged(pair) && !wrong(pair)).slice(0, 8)) console.log(`  cờ oan: "${pair.row.item.text.slice(0, 60)}" LLM ${pair.llm.llm} đúng · top-3 ${pair.row.intents[m].topK.map(candidate => candidate.templateId).join('/')} · luật ${pair.row.ruleTemplate || '-'}`);
      for (const pair of scope.filter(pair => !flagged(pair) && wrong(pair)).slice(0, 8)) console.log(`  lọt: "${pair.row.item.text.slice(0, 60)}" LLM ${pair.llm.llm} · đúng ${pair.row.item.truth} · top-3 ${pair.row.intents[m].topK.map(candidate => candidate.templateId).join('/')}`);
    });
  }
}
