// Replay bộ chấm mẫu: so mô hình nhỏ (và luật ổn định) với mã mẫu nhân viên đã chấm.
// Dùng: node tools-intent/replay-golden.mjs [golden-set.json] [--all] [--model <path>] [--compare <path2>] [--gate]
//   - mặc định đọc data/processed/golden-set.json, chỉ tính tin ĐÃ CHẤM (label ≠ SKIP);
//   - --all: chưa có tin chấm thì tạm dùng nhãn gợi ý (LLM) để xem sơ bộ, kết quả KHÔNG dùng để bật;
//   - --model <path> (hay INTENT_MODEL_PATH): tệp trọng số đem đo, mặc định app/processing/intent-model.json;
//   - --compare <path2>: in hai cột (mô hình 1 / mô hình 2, ví dụ v5 / v6) trên cùng bộ chấm;
//   - --gate: có tệp replay-llm-out.json cạnh bộ chấm (do replay-llm.mjs ghi) thì tính precision/recall của
//     cờ "câu LLM ∉ topK3 mô hình ∪ luật" trong việc bắt LLM sai, trên nhóm ORDER_CONFIRMATION/ORDER_UPDATE/ORDER_CANCEL*.
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
const goldenPath = args.find((arg, index) => !arg.startsWith('--') && !['--model', '--compare'].includes(args[index - 1])) || path.join(root, 'data', 'processed', 'golden-set.json');
const modelPath = option('--model') || process.env.INTENT_MODEL_PATH || path.join(root, 'app', 'processing', 'intent-model.json');
const comparePath = option('--compare');
const { loadIntentModelFrom, predictIntentWith, intentSafeTemplates } = await import(pathToFileURL(path.join(root, 'app', 'processing', 'intent-model.mjs')).href);
const { ruleIntent } = await import(pathToFileURL(path.join(root, 'app', 'processing', 'rule-intent.mjs')).href);
const { describeDeliveryAddress } = await import(pathToFileURL(path.join(root, 'app', 'processing', 'locations.mjs')).href);
const { enrichGoldenContext, goldenContextFields } = await import(pathToFileURL(path.join(root, 'app', 'golden-set.mjs')).href);

const models = [{ name: comparePath ? 'mô hình 1' : 'mô hình', file: modelPath, model: loadIntentModelFrom(modelPath) }];
if (comparePath) models.push({ name: 'mô hình 2', file: comparePath, model: loadIntentModelFrom(comparePath) });
for (const entry of models) {
  if (!entry.model) { console.log(`Không đọc được ${entry.file}`); process.exit(1); }
  console.log(`${entry.name}: ${entry.file} · ${entry.model.labels.length} nhãn · ${entry.model.rows || '?'} dòng · nhiệt độ ${entry.model.temperature}${entry.model.trainedAt ? ` · huấn luyện ${entry.model.trainedAt}` : ''}`);
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
  return { item, intent: intents[0], intents, ruleTemplate };
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
