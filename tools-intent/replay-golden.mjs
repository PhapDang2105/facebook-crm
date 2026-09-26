// Replay bộ chấm mẫu: so mô hình nhỏ (và luật ổn định) với mã mẫu nhân viên đã chấm.
// Dùng: node tools-intent/replay-golden.mjs [golden-set.json] [--all]
//   - mặc định đọc data/processed/golden-set.json, chỉ tính tin ĐÃ CHẤM (label ≠ SKIP);
//   - --all: chưa có tin chấm thì tạm dùng nhãn gợi ý (LLM) để xem sơ bộ, kết quả KHÔNG dùng để bật.
// In ra: độ đúng tổng, đường risk–coverage theo ngưỡng (để chọn intentThreshold), tin sai ở mức chắc.
// Không gọi LLM, không gửi gì cho khách.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const useAll = args.includes('--all');
const goldenPath = args.find(arg => !arg.startsWith('--')) || path.join(root, 'data', 'processed', 'golden-set.json');
const { predictIntent, intentSafeTemplates } = await import(pathToFileURL(path.join(root, 'app', 'processing', 'intent-model.mjs')).href);
const { ruleIntent } = await import(pathToFileURL(path.join(root, 'app', 'processing', 'rule-intent.mjs')).href);
const { describeDeliveryAddress } = await import(pathToFileURL(path.join(root, 'app', 'processing', 'locations.mjs')).href);

const items = (JSON.parse(readFileSync(goldenPath, 'utf8')).items || []).filter(item => item.source !== 'comment');
const graded = items.filter(item => item.label && item.label !== 'SKIP').map(item => ({ ...item, truth: item.label }));
const rows = graded.length || !useAll ? graded : items.filter(item => item.suggested).map(item => ({ ...item, truth: item.suggested }));
if (!rows.length) { console.log('Chưa có tin nào được chấm (Cài đặt → Thiết lập chatbot → Chấm mẫu). Thêm --all để xem sơ bộ theo nhãn gợi ý.'); process.exit(0); }
console.log(`${rows.length} tin hộp thư ${graded.length ? 'đã chấm' : 'theo nhãn gợi ý LLM (sơ bộ)'} · ${items.length - rows.length} tin bỏ qua`);

const ORDER_STEPS = new Set(['ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'ORDER_CONFIRMATION', 'ORDER_CART_LINE']);
const results = rows.map(item => {
  const intent = predictIntent({ text: item.text, source: item.source, lastTemplate: item.lastTemplate || '', lastWasOrderStep: ORDER_STEPS.has(item.lastTemplate), hasBasket: false, livestream: false });
  const ruled = ruleIntent(item.text, { source: item.source, botLastTemplateId: item.lastTemplate || '' });
  const ruleTemplate = ruled?.value?.template_id || (ruled?.commentRule ? 'COMMENT_RULE' : '');
  return { item, intent, ruleTemplate };
});

const pct = (num, den) => (den ? `${(100 * num / den).toFixed(1)}%` : '–');
const withIntent = results.filter(row => row.intent);
console.log(`Mô hình nhỏ có dự đoán: ${withIntent.length}/${results.length} · đúng (mọi mức): ${pct(withIntent.filter(row => row.intent.templateId === row.item.truth).length, withIntent.length)}`);
const ruledRows = results.filter(row => row.ruleTemplate && row.ruleTemplate !== 'COMMENT_RULE');
console.log(`Luật ổn định bắt: ${ruledRows.length}/${results.length} · đúng: ${pct(ruledRows.filter(row => row.ruleTemplate === row.item.truth).length, ruledRows.length)}`);

console.log('\nNgưỡng (p ≥ ngưỡng & biên ≥ 0,25 & mẫu an toàn) → phủ / đúng:');
for (const threshold of [0.6, 0.7, 0.8, 0.85, 0.9, 0.95]) {
  const kept = withIntent.filter(row => row.intent.confidence >= threshold && row.intent.margin >= 0.25 && intentSafeTemplates.has(row.intent.templateId));
  const hit = kept.filter(row => row.intent.templateId === row.item.truth).length;
  console.log(`  ${threshold.toFixed(2)}: phủ ${pct(kept.length, results.length)} (${kept.length}) · đúng ${pct(hit, kept.length)}`);
}
// Ngưỡng bảo toàn (conformal): ngưỡng nhỏ nhất sao cho phần giữ lại sai ≤ 3%.
const sorted = withIntent.filter(row => row.intent.margin >= 0.25 && intentSafeTemplates.has(row.intent.templateId)).sort((a, b) => b.intent.confidence - a.intent.confidence);
let best = null;
for (let n = sorted.length; n >= 1; n -= 1) {
  const kept = sorted.slice(0, n);
  const wrong = kept.filter(row => row.intent.templateId !== row.item.truth).length;
  if (wrong / n <= 0.03) { best = { threshold: kept.at(-1).intent.confidence, coverage: n, wrong }; break; }
}
console.log(best ? `Ngưỡng gợi ý (sai ≤ 3%): ${best.threshold.toFixed(2)} → phủ ${best.coverage}/${results.length}, sai ${best.wrong}` : 'Không có ngưỡng nào đạt sai ≤ 3%.');

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
  console.log(`
Luật thử nghiệm (luồng đơn, giả định có giỏ khi bot vừa ở bước đơn): bắt ${flowRows.length}/${results.length} · hợp nhãn ${pct(hit.length, flowRows.length)}`);
  for (const row of flowRows.filter(row => !hit.includes(row)).slice(0, 10)) console.log(`  "${row.item.text.slice(0, 60)}" → ${row.ruled.rule} ${row.ruled.value?.template_id} · đúng ${row.item.truth} · bot trước ${row.item.lastTemplate || '-'}`);
}
const ruleMiss = ruledRows.filter(row => row.ruleTemplate !== row.item.truth);
if (ruleMiss.length) {
  console.log('\nLuật ổn định sai (đang chạy thật, cần xem):');
  for (const row of ruleMiss) console.log(`  "${row.item.text.slice(0, 70)}" → luật ${row.ruleTemplate} · đúng ${row.item.truth}${row.item.lastTemplate ? ` · bot trước ${row.item.lastTemplate}` : ''}`);
}
const confident = withIntent.filter(row => row.intent.confidence >= 0.85 && row.intent.templateId !== row.item.truth).slice(0, 15);
if (confident.length) {
  console.log('\nSai ở mức chắc (p ≥ 0,85):');
  for (const row of confident) console.log(`  "${row.item.text.slice(0, 70)}" → mô hình ${row.intent.templateId} (${row.intent.confidence.toFixed(2)}) · đúng ${row.item.truth}${row.item.lastTemplate ? ` · bot trước ${row.item.lastTemplate}` : ''}`);
}
