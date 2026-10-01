// Đo độ phủ của LUẬT + máy trạng thái slot trên nhóm MUA (ORDER): với mọi tin hộp thư có nhãn thuộc
// nhóm ORDER, dựng ctx như engine (offlineRuleContext của relabel-policy), chạy ruleIntent (luật thử
// nghiệm 'on') → renderChatbotReply → so mã mẫu với nhãn. In: phủ (% tin ORDER luật bắt), đúng (trong số
// bắt), bảng theo nhãn, danh sách tin ORDER luật KHÔNG bắt / bắt sai (lỗ cần bịt), và số tin KHÔNG thuộc
// ORDER mà luật bắt thành ORDER (dương tính giả).
// Dùng: node tools-intent/order-coverage.mjs [golden.json] [dataset.jsonl] [--all] [--show N] [--json] [--templates <settings.json>]
//   - golden.json: bộ chấm (items[].label, bỏ trống/SKIP); dataset.jsonl: hợp đồng dòng v2 (tools-intent/README.md).
//   - Mặc định chỉ tính dòng TIN CẬY: golden đã chấm + dataset labelSource staff/corrected. --all: thêm dòng llm/khác
//     (in riêng, chỉ để tham khảo — nhãn LLM có thể sai).
//   - --show N: số dòng lỗ in ra (mặc định 60, 0 = không in). --json: in JSON thay bảng chữ.
//   - --templates <settings.json>: mẫu GỘP SEED như engine đọc (normalizeChatbotSettings — relabel-policy.loadTemplatesArg),
//     không phải messageTemplates thô (thiếu mẫu → renderChatbotReply rơi GENERAL_INFO, đo sai).
//   - Mã bot trước quy về mã engine lưu bằng canonicalTemplateId (intent-features) — một bảng với dữ liệu huấn luyện.
// Không gọi LLM, không ghi gì ngoài stdout.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSeedTemplates, loadTemplatesArg, offlineRuleContext, pendingOrderFromPrevBot } from './relabel-policy.mjs';
import { botTextOf, cliFail, lastWasOrderStepOf, parseCliArgs, positiveIntArg, readJsonl } from './dataset-context.mjs';
import { canonicalTemplateId, isOrderStepContext, labelTemplateId } from '../app/processing/intent-features.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Nhóm MUA: mẫu do luật + bộ soạn đơn (renderOrder) quyết định tất định. */
export const ORDER_GROUP = new Set(['ASK_FLAVOR', 'ASK_PRODUCT', 'ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_CONFIRMATION', 'ORDER_CANCELLED', 'ORDER_HELP', 'ORDER_EXISTING_CONFIRM', 'CONFIRM_YES', 'ORDER_POSTPONED', 'ORDER_INFO_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN']);
// Mã mẫu coi như một khi so: ORDER_ADDRESS_REMIND/PARTIAL/CLARIFY/CHOOSE là cùng bước "xin thông tin" (engine cũng
// ghi botLastTemplateId = ORDER_ADDRESS cho cả bốn); ORDER_INFO_ASK_FLAVOR là ASK_FLAVOR có giữ SĐT (bộ chấm chấm
// trước khi có mẫu này); ASK_PRODUCT hiển thị đúng chữ GENERAL_INFO (renderOrder).
const SAME = { ORDER_ADDRESS_REMIND: 'ORDER_ADDRESS', ORDER_ADDRESS_PARTIAL: 'ORDER_ADDRESS', ORDER_ADDRESS_CLARIFY: 'ORDER_ADDRESS', ORDER_ADDRESS_CHOOSE: 'ORDER_ADDRESS', ORDER_INFO_ASK_FLAVOR: 'ASK_FLAVOR', ASK_PRODUCT: 'GENERAL_INFO' };
const canon = id => SAME[id] || id;
// Nhãn mà bước "ORDER_ADDRESS + slot" của luật là đúng: bộ soạn đơn (giỏ thật, địa chỉ thật) mới quyết mẫu cuối —
// ngoại tuyến không dựng được giỏ từ câu bot (bị cắt 240 ký tự, câu xin địa chỉ không nêu giỏ) nên render ra ASK_PRODUCT.
const SLOT_STEP_LABELS = new Set(['ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_REMIND', 'ORDER_CONFIRMATION']);
/** Giỏ Facebook Shop ("Khách chọn mua từ Facebook Shop: …"): engine trả lời theo SKU (cartReply) TRƯỚC luật — không tính vào luật. */
const isShopCart = row => /^Khách chọn mua từ Facebook Shop/i.test(String(row.text || ''));

// Engine ghi botLastTemplateId = ORDER_ADDRESS cho dòng giỏ, gợi ý 2 túi, xin thêm cấp địa chỉ, nhắc giỏ… (một lượt
// ORDER_ADDRESS); khớp chữ ngoại tuyến ra mã con → quy mã bằng canonicalTemplateId của intent-features (một bảng với engine / dữ liệu huấn luyện).
export const engineLikeRow = row => (canonicalTemplateId(row.lastTemplate) !== String(row.lastTemplate || '') ? { ...row, lastTemplate: canonicalTemplateId(row.lastTemplate), lastWasOrderStep: isOrderStepContext(row.lastTemplate) } : row);

/** Chạy luật (thử nghiệm 'on') + render như relabel-policy.ruleLabelOf, nhưng giữ cả giá trị thô của luật. */
export function ruleOutcome(row, { templates } = {}) {
  const { text, ctx } = offlineRuleContext(row, { experimentalRules: 'on' });
  const ruled = ruleIntent(text, ctx);
  if (!ruled) return { ruleName: '', ruleTemplate: '', rawTemplate: '', value: null };
  if (ruled.commentRule) return { ruleName: ruled.rule, ruleTemplate: 'COMMENT_RULE', rawTemplate: 'COMMENT_RULE', value: null };
  const replyContext = {
    pendingOrder: pendingOrderFromPrevBot(row), recentOrder: null, latestOrder: null, lastTemplateId: ctx.botLastTemplateId, previousDelivery: null, trial: null,
    now: Number(row.at) || Date.now(), recentOutgoing: botTextOf(row) ? [botTextOf(row)] : [], recentCustomerTexts: [row.prevCustomer, text].filter(Boolean),
    messageText: text, noUpsell: false, customer: { gender: '', name: '' }
  };
  const rawTemplate = ruled.value?.template_id || '';
  let ruleTemplate = rawTemplate;
  try { ruleTemplate = renderChatbotReply(ruled.value, templates, replyContext).templateId || rawTemplate; } catch { /* mẫu thiếu: giữ template_id thô */ }
  ruleTemplate = labelTemplateId(ruleTemplate);
  return { ruleName: ruled.rule, ruleTemplate, rawTemplate, value: ruled.value, attention: Boolean(ruled.attention) };
}

/** Mục golden (đã chấm) → dòng v2 tối thiểu; ngữ cảnh thiếu dựng lại như enrichGoldenContext (không kho hội thoại). */
export async function goldenRows(goldenPath) {
  const items = (JSON.parse(readFileSync(goldenPath, 'utf8')).items || []).filter(item => item.source !== 'comment' && item.label && item.label !== 'SKIP');
  const { enrichGoldenContext } = await import(pathToFileURL(path.join(root, 'app', 'golden-set.mjs')).href);
  return enrichGoldenContext(items, null).map(item => ({
    id: item.id, text: item.text, prevBot: item.prevBot || '', prevCustomer: item.prevCustomer || '', label: item.label, labelSource: 'golden', source: 'inbox',
    lastTemplate: item.lastTemplate || '', lastWasOrderStep: lastWasOrderStepOf(item.lastTemplate || ''), hasBasket: Boolean(item.hasBasket),
    hasOrder: Boolean(item.hasOrder), orderAgeMin: item.orderAgeMin ?? null, livestream: false, at: item.at,
    // Bộ chấm không ghi tuổi câu bot: coi như bot vừa trả lời (5 phút) — đúng với đa số mục (lượt kế tiếp), và tránh
    // luật coi mọi tin là "mới" (botLastAgeMin = ∞ → fresh) như khi bỏ trống.
    prevBotAgeMin: item.prevBotAgeMin ?? (item.lastTemplate ? 5 : null)
  }));
}

export const isTrusted = row => row.labelSource === 'golden' || row.labelSource === 'staff' || Boolean(row.corrected);

/** Chạy luật trên các dòng → { rows: [...{ruleTemplate, ruleName, ok, group}], stats, byLabel, misses, falsePositives }. */
export function measureOrderCoverage(rows, { templates } = {}) {
  const out = [];
  let shopCart = 0;
  for (const input of rows) {
    if (isShopCart(input)) { shopCart += 1; continue; }
    const row = engineLikeRow(input);
    const { ruleName, ruleTemplate, rawTemplate, value } = ruleOutcome(row, { templates });
    const isOrder = ORDER_GROUP.has(row.label);
    const caught = Boolean(ruleTemplate) && ruleTemplate !== 'COMMENT_RULE';
    // Đúng mẫu (sau render ngoại tuyến) hay đúng bước: luật trả ORDER_ADDRESS + slot, nhãn là một bước của máy
    // trạng thái. Có sản phẩm trong giá trị thì nhãn phải là bước đơn thật (không phải ASK_FLAVOR/ASK_PRODUCT).
    const namedProduct = Boolean(value?.Product_N1);
    const step = caught && rawTemplate === 'ORDER_ADDRESS' && (SLOT_STEP_LABELS.has(row.label) || (!namedProduct && ['ASK_FLAVOR', 'ASK_PRODUCT'].includes(row.label)));
    const ok = caught && (canon(ruleTemplate) === canon(row.label) || step);
    // Dương tính giả: luật ra bước MUA cho tin không thuộc nhóm MUA. Giữ bước đơn + trả lời ý phụ (`also`) không tính.
    const ruleOrder = caught && (ORDER_GROUP.has(rawTemplate) || ORDER_GROUP.has(ruleTemplate)) && !value?.also;
    out.push({ ...row, ruleName, ruleTemplate, rawTemplate, isOrder, caught, ok, ruleOrder });
  }
  const order = out.filter(row => row.isOrder);
  const caught = order.filter(row => row.caught);
  const stats = {
    rows: out.length, shopCart, order: order.length, caught: caught.length, correct: caught.filter(row => row.ok).length, groupCorrect: caught.filter(row => row.ruleOrder || row.ok).length,
    nonOrder: out.length - order.length, falsePositives: out.filter(row => !row.isOrder && row.ruleOrder).length
  };
  const byLabel = {};
  for (const row of order) {
    const entry = byLabel[row.label] || (byLabel[row.label] = { n: 0, caught: 0, correct: 0, group: 0 });
    entry.n += 1;
    if (row.caught) entry.caught += 1;
    if (row.ok) entry.correct += 1;
    if (row.ruleOrder || row.ok) entry.group += 1;
  }
  return { rows: out, stats, byLabel, misses: order.filter(row => !row.ok), falsePositives: out.filter(row => !row.isOrder && row.ruleOrder) };
}

const pct = (num, den) => (den ? `${(100 * num / den).toFixed(1)}%` : '–');
const short = (text, n = 72) => String(text || '').replace(/\s*\n\s*/g, ' | ').slice(0, n);

function printReport(title, result, show) {
  const { stats, byLabel, misses, falsePositives } = result;
  console.log(`\n=== ${title}: ${stats.rows} tin hộp thư · ${stats.order} thuộc nhóm ORDER${stats.shopCart ? ` · ${stats.shopCart} giỏ Facebook Shop (engine xử lý trước luật, bỏ)` : ''} ===`);
  console.log(`Phủ (luật bắt / tin ORDER): ${stats.caught}/${stats.order} = ${pct(stats.caught, stats.order)}`);
  console.log(`Đúng (trong số bắt; đúng mẫu hoặc đúng bước ORDER_ADDRESS+slot): ${stats.correct}/${stats.caught} = ${pct(stats.correct, stats.caught)} · đúng nhóm MUA (mẫu khác cùng nhóm): ${stats.groupCorrect}/${stats.caught} = ${pct(stats.groupCorrect, stats.caught)}`);
  console.log(`Dương tính giả (tin KHÔNG ORDER mà luật ra bước MUA): ${stats.falsePositives}/${stats.nonOrder} = ${pct(stats.falsePositives, stats.nonOrder)}`);
  console.log('\nTheo nhãn:            n   bắt  đúng  đúng nhóm');
  for (const [label, entry] of Object.entries(byLabel).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${label.padEnd(22)}${String(entry.n).padStart(3)}  ${String(entry.caught).padStart(4)}  ${String(entry.correct).padStart(4)}  ${String(entry.group).padStart(5)}`);
  }
  console.log(`\nLỗ (tin ORDER luật không bắt / bắt sai): ${misses.length}`);
  for (const row of misses.slice(0, show)) {
    console.log(`  [${row.labelSource}${row.corrected ? '+c' : ''}] "${short(row.text)}" · bot trước ${row.lastTemplate || '(trống)'} · giỏ ${row.hasBasket ? 'có' : 'không'}${row.hasOrder ? ` · đơn ${row.orderAgeMin ?? '?'}p` : ''} → nhãn ${row.label} · luật ${row.ruleTemplate ? `${row.ruleName}=${row.rawTemplate}${row.ruleTemplate !== row.rawTemplate ? `→${row.ruleTemplate}` : ''}` : '(không bắt)'}`);
  }
  console.log(`\nDương tính giả: ${falsePositives.length}`);
  for (const row of falsePositives.slice(0, show)) {
    console.log(`  [${row.labelSource}${row.corrected ? '+c' : ''}] "${short(row.text)}" · bot trước ${row.lastTemplate || '(trống)'} · giỏ ${row.hasBasket ? 'có' : 'không'} → nhãn ${row.label} · luật ${row.ruleName}=${row.rawTemplate}${row.ruleTemplate !== row.rawTemplate ? `→${row.ruleTemplate}` : ''}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cli = parseCliArgs(args, ['--show', '--templates'], ['--all', '--json']);
  const goldenPath = cli.positional[0] || path.join(root, 'data', 'processed', 'golden-set.json');
  const datasetPath = cli.positional[1] || '';
  if (datasetPath && !existsSync(datasetPath)) cliFail(`Không thấy dataset: ${datasetPath}`);
  const showRaw = cli.value('--show', '60');
  const show = showRaw === '0' ? 0 : positiveIntArg(showRaw, '--show');
  const templatesArg = cli.value('--templates');
  if (templatesArg && !existsSync(templatesArg)) cliFail(`Không thấy tệp mẫu: ${templatesArg}`);
  // Mẫu gộp seed như engine đọc (normalizeChatbotSettings) — không phải messageTemplates thô (thiếu mẫu → rơi GENERAL_INFO).
  const templates = templatesArg ? loadTemplatesArg(templatesArg) : loadSeedTemplates();
  (await import(pathToFileURL(path.join(root, 'app/processing/catalog.mjs')).href)).reloadCatalog();

  const rows = [];
  if (existsSync(goldenPath)) {
    try { rows.push(...await goldenRows(goldenPath)); } catch (error) { cliFail(`Bộ chấm ${goldenPath} không đọc được: ${String(error.message).slice(0, 80)}`); }
  }
  else console.log(`Không có bộ chấm ${goldenPath} (bỏ qua).`);
  if (datasetPath) { const readStats = {}; let content = ''; try { content = readFileSync(datasetPath, 'utf8'); } catch (error) { cliFail(`Dataset ${datasetPath} không đọc được: ${error.code || error.message}`); } rows.push(...readJsonl(content, readStats).filter(row => row.source !== 'comment')); if (readStats.bad) console.warn(`Bỏ ${readStats.bad} dòng hỏng trong ${datasetPath}`); }
  if (!rows.length) { console.log('Không có dòng nào để đo. Dùng: node tools-intent/order-coverage.mjs [golden.json] [dataset.jsonl] [--all]'); process.exit(1); }

  const trusted = rows.filter(isTrusted);
  const result = measureOrderCoverage(trusted, { templates });
  const others = args.includes('--all') ? measureOrderCoverage(rows.filter(row => !isTrusted(row)), { templates }) : null;
  if (args.includes('--json')) {
    console.log(JSON.stringify({ trusted: { stats: result.stats, byLabel: result.byLabel, misses: result.misses.map(row => ({ id: row.id, text: row.text, lastTemplate: row.lastTemplate, hasBasket: row.hasBasket, label: row.label, ruleName: row.ruleName, rawTemplate: row.rawTemplate, ruleTemplate: row.ruleTemplate })) }, ...(others ? { others: { stats: others.stats, byLabel: others.byLabel } } : {}) }, null, 1));
    return;
  }
  printReport('Tập TIN CẬY (golden đã chấm + nhân viên staff/corrected)', result, show);
  if (others) printReport('Tập KHÁC (nhãn LLM/pipeline — chỉ tham khảo)', others, show);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
