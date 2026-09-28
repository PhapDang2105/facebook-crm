// Gán lại nhãn theo LUẬT hiện hành (chính sách mới nhất): với mỗi dòng dataset dựng ctx như engine truyền
// vào ruleIntent, chạy luật ổn định + luật thử nghiệm ('on'), soạn qua renderChatbotReply (mẫu seed) → ruleTemplate.
// Luật bắt được thì nhãn = ruleTemplate, labelSource 'rule' — TRỪ:
//   - dòng nhân viên (staff/corrected): nhân viên thắng luật; dòng nhân viên ≠ luật ghi ra tệp riêng (bug luật tiềm năng);
//   - mẫu luật ra KHÔNG có trong bộ mẫu (templates thiếu mã): cảnh báo, không gắn `rule` (renderChatbotReply sẽ rơi
//     GENERAL_INFO/CSKH_HANDOFF — nhãn giả);
//   - kết quả PHỤ THUỘC GIỎ (luật ra ORDER_ADDRESS / ORDER_INFO_ASK_FLAVOR / ORDER_CONFIRMATION / ASK_FLAVOR…) mà giỏ
//     không dựng lại được: dòng có giỏ (hasBasket) nhưng không đọc ra món, hay dữ liệu v1 thiếu ngữ cảnh giỏ (không có
//     prevBotAgeMin / basket) → giữ nhãn gốc, không gắn `rule`, khác nhãn thì đánh weak (ruleUncertain: true); dòng
//     nhật ký quyết định (pipeline) bước đơn giữ nguyên nhãn engine (engine đã thấy giỏ thật), không weak.
// --templates <settings.json>: mẫu gộp seed như engine đọc (normalizeChatbotSettings), không phải messageTemplates thô.
// Dùng: node tools-intent/relabel-policy.mjs <in.jsonl> <out.jsonl> [--templates <settings.json>] [--conflicts <file.jsonl>] [--stable-only]
// Giả định khi dựng ctx ngoại tuyến: xem tools-intent/README.md (mục "Giả định ctx ngoại tuyến").
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';
import { normalizeChatbotSettings } from '../app/chatbot-settings.mjs';
import { commentBasket } from '../app/chatbot-engine.mjs';
import { isComplaint } from '../app/processing/auto-label.mjs';
import { findProductBySku } from '../app/processing/catalog.mjs';
import { describeDeliveryAddress } from '../app/processing/locations.mjs';
import { canonicalTemplateId, isOrderStepContext, labelTemplateId } from '../app/processing/intent-features.mjs';
import { botTextOf, cliFail, lastTemplateOf, parseCliArgs, readJsonl, toJsonl, unmaskPhone } from './dataset-context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const loadSeedTemplates = () => JSON.parse(readFileSync(path.join(root, 'app', 'chatbot-templates.seed.json'), 'utf8'));

/**
 * Bộ mẫu từ tệp --templates như ENGINE đọc: chatbot-settings.json (hay object mẫu trần) → normalizeChatbotSettings →
 * messageTemplates (mẫu seed chưa lưu được gộp vào; chữ trống = nhân viên tắt mẫu, giữ nguyên).
 */
export function templatesFromSettings(parsed) {
  const stored = parsed && typeof parsed === 'object' ? parsed : {};
  const settings = stored.messageTemplates && typeof stored.messageTemplates === 'object' ? stored : { messageTemplates: stored };
  return normalizeChatbotSettings({ ...settings }).messageTemplates;
}
export const loadTemplatesArg = file => templatesFromSettings(JSON.parse(readFileSync(file, 'utf8')));

/**
 * Giỏ đang giữ dựng lại cho bộ soạn đơn: `basket` [{ sku, quantity }] của nhật ký quyết định (mới), không có thì
 * đọc từ câu bot trước ("đang giữ đơn 2 Túi Xanh…") khi dòng có giỏ. Không dựng được → null.
 */
export function pendingOrderFromPrevBot(row) {
  const at = (Number(row.at) || Date.now()) - 60000;
  if (Array.isArray(row.basket) && row.basket.length) {
    const items = row.basket.map(item => { const product = findProductBySku(item.sku || item.code); return product ? { product: product.name, code: product.sku, quantity: Math.max(1, Number(item.quantity) || 1) } : null; }).filter(Boolean);
    return items.length === row.basket.length ? { key: 'offline', at, items } : null;
  }
  if (!row.hasBasket) return null;
  const items = commentBasket(botTextOf(row));
  if (!items.length) return null;
  return { key: 'offline', at, items };
}

/** Dòng biết chắc ngữ cảnh giỏ: nhật ký có `basket`, hay dòng v2 có prevBotAgeMin (v1 thiếu → hasBasket không tin được). */
export const basketContextKnown = row => Array.isArray(row.basket) || Object.prototype.hasOwnProperty.call(row, 'prevBotAgeMin');

/** Mẫu mà bộ soạn đơn quyết theo giỏ đang giữ: sai giỏ là sai mẫu. */
export const BASKET_DEPENDENT = new Set(['ORDER_ADDRESS', 'ORDER_INFO_ASK_FLAVOR', 'ORDER_CONFIRMATION', 'ORDER_UPDATE', 'ORDER_UPDATED', 'ASK_FLAVOR', 'ASK_PRODUCT']);

/**
 * ctx cho ruleIntent dựng lại từ một dòng v2 — cùng tên trường như engine (chatbot-engine.mjs, chỗ gọi ruleIntentFn).
 * Trường không dựng được ngoại tuyến đặt mặc định an toàn: hasPreviousDelivery false, contextProduct '',
 * quotedProduct '', trialOffer false; SĐT đã che ("<sdt>") thay bằng SĐT giả để luật đọc được.
 * botLastTemplateId là mã engine LƯU (mã con → ORDER_ADDRESS…); lastWasOrderStep theo intent-features.
 */
export function offlineRuleContext(row, { complaintKeywords, experimentalRules = 'on' } = {}) {
  const text = unmaskPhone(row.text);
  const withoutPhone = text.replace(/\+?\d[\d .-]{8,13}/g, ' ').replace(/\s+/g, ' ').trim();
  const lastTemplate = canonicalTemplateId(lastTemplateOf(row));
  const orderAgeMin = row.hasOrder && Number.isFinite(Number(row.orderAgeMin)) && row.orderAgeMin !== null ? Number(row.orderAgeMin) : Infinity;
  const bundleSize = Number(row.bundleSize) || text.split('\n').filter(Boolean).length || 1;
  const hasBasket = Array.isArray(row.basket) ? row.basket.length > 0 || Boolean(row.hasBasket) : Boolean(row.hasBasket);
  return {
    text,
    ctx: {
      source: row.source === 'comment' ? 'comment' : 'inbox',
      botLastTemplateId: lastTemplate,
      hasPreviousDelivery: false,
      staffRepliedAfterBot: Boolean(row.staffRepliedAfterBot),
      botLastAgeMin: Number.isFinite(Number(row.prevBotAgeMin)) && row.prevBotAgeMin !== null ? Number(row.prevBotAgeMin) : Infinity,
      hasBasket,
      lastWasOrderStep: isOrderStepContext(lastTemplate),
      hasRecentOrder: Boolean(row.hasOrder),
      orderAgeMin,
      livestream: Boolean(row.livestream),
      contextProduct: '',
      bundleSize,
      complaint: isComplaint({ text, ...(complaintKeywords ? { keywords: complaintKeywords } : {}) }),
      commentBasket,
      trialOffer: false,
      experimentalRules,
      quotedProduct: '',
      addressComplete: Boolean(hasBasket && withoutPhone && describeDeliveryAddress(withoutPhone).complete),
      addressText: withoutPhone,
      smallPackContext: lastTemplate === 'PACKAGING_INFO' || /gói nhỏ|combo 10 gói/i.test(botTextOf(row))
    }
  };
}

/**
 * Chạy luật cho một dòng → { ruleName, ruleTemplate, rawTemplate, attention, experimental, missingTemplate, basketUnknown }
 * ('' khi luật không bắt; 'COMMENT_RULE' cho luật bình luận). ruleTemplate là mã mẫu (ORDER_UPDATE → ORDER_UPDATED…).
 * missingTemplate: mã luật ra không có trong `templates` (renderChatbotReply sẽ rơi mẫu khác).
 * basketUnknown: kết quả phụ thuộc giỏ mà giỏ không dựng lại được (xem đầu tệp).
 */
export function ruleLabelOf(row, { templates, complaintKeywords, experimentalRules = 'on' } = {}) {
  const { text, ctx } = offlineRuleContext(row, { complaintKeywords, experimentalRules });
  const ruled = ruleIntent(text, ctx);
  if (!ruled) return { ruleName: '', ruleTemplate: '', rawTemplate: '' };
  if (ruled.commentRule) return { ruleName: ruled.rule, ruleTemplate: 'COMMENT_RULE', rawTemplate: 'COMMENT_RULE' };
  const pendingOrder = pendingOrderFromPrevBot(row);
  const replyContext = {
    pendingOrder,
    recentOrder: null,
    latestOrder: null,
    lastTemplateId: ctx.botLastTemplateId,
    previousDelivery: null,
    trial: null,
    now: Number(row.at) || Date.now(),
    recentOutgoing: botTextOf(row) ? [botTextOf(row)] : [],
    recentCustomerTexts: [row.prevCustomer, text].filter(Boolean),
    messageText: text,
    noUpsell: false,
    customer: { gender: '', name: '' }
  };
  const rawTemplate = String(ruled.value?.template_id || '');
  const missingTemplate = Boolean(templates) && Boolean(rawTemplate) && templates[labelTemplateId(rawTemplate)] === undefined;
  let rendered = rawTemplate;
  try { rendered = renderChatbotReply(ruled.value, templates, replyContext).templateId || rawTemplate; } catch { /* mẫu thiếu: giữ template_id thô */ }
  const ruleTemplate = labelTemplateId(rendered);
  const basketUnknown = !pendingOrder && (BASKET_DEPENDENT.has(rawTemplate) || BASKET_DEPENDENT.has(ruleTemplate)) && (Boolean(ctx.hasBasket) || !basketContextKnown(row));
  return { ruleName: ruled.rule, ruleTemplate, rawTemplate, attention: Boolean(ruled.attention), experimental: Boolean(ruled.experimental), missingTemplate, basketUnknown };
}

const isOrderLabel = label => /^(ORDER_|ASK_FLAVOR|ASK_PRODUCT|CONFIRM_YES)/.test(String(label || ''));

export function relabelRows(rows, options = {}) {
  const out = [];
  const matrix = {};
  const conflicts = [];
  const missing = {};
  const stats = { total: rows.length, ruled: 0, relabeled: 0, staffKept: 0, comment: 0, changed: 0, missingTemplate: 0, basketUnknown: 0, basketUnknownWeak: 0, pipelineKept: 0 };
  for (const row of rows) {
    const { ruleName, ruleTemplate, rawTemplate, attention, missingTemplate, basketUnknown } = ruleLabelOf(row, options);
    const isStaff = row.labelSource === 'staff' || row.corrected;
    const next = { ...row, ruleTemplate, ...(ruleName ? { ruleName } : {}) };
    if (ruleTemplate) {
      stats.ruled += 1;
      if (ruleTemplate === 'COMMENT_RULE') { stats.comment += 1; matrix[`${row.label} → COMMENT_RULE`] = (matrix[`${row.label} → COMMENT_RULE`] || 0) + 1; out.push(next); continue; }
      if (missingTemplate) {
        // Mẫu luật ra không có trong bộ mẫu: không có chữ để soạn → không phải nhãn thật.
        stats.missingTemplate += 1;
        missing[rawTemplate] = (missing[rawTemplate] || 0) + 1;
        Object.assign(next, { ruleTemplate: '', ruleMissingTemplate: rawTemplate });
        out.push(next);
        continue;
      }
      const key = `${row.label} → ${ruleTemplate}`;
      if (isStaff) {
        matrix[key] = (matrix[key] || 0) + 1;
        stats.staffKept += 1;
        if (ruleTemplate !== row.label) conflicts.push({ id: row.id, text: row.text, lastTemplate: row.lastTemplate, prevBot: row.prevBot, staff: row.label, rule: ruleTemplate, ruleName, hasBasket: row.hasBasket, hasOrder: row.hasOrder });
      } else if (basketUnknown) {
        stats.basketUnknown += 1;
        matrix[`${row.label} → (giữ, giỏ không dựng được: luật ${ruleTemplate})`] = (matrix[`${row.label} → (giữ, giỏ không dựng được: luật ${ruleTemplate})`] || 0) + 1;
        next.ruleUncertain = true;
        if (row.labelSource === 'pipeline' && isOrderLabel(row.label)) stats.pipelineKept += 1;
        else if (ruleTemplate !== row.label) { next.weak = true; stats.basketUnknownWeak += 1; }
      } else {
        matrix[key] = (matrix[key] || 0) + 1;
        stats.relabeled += 1;
        if (ruleTemplate !== row.label) stats.changed += 1;
        Object.assign(next, { label: ruleTemplate, labelSource: 'rule', ...(attention ? { attention: true } : {}) });
        delete next.weak;
      }
    }
    out.push(next);
  }
  return { rows: out, matrix, conflicts, stats, missing };
}

async function main() {
  const args = process.argv.slice(2);
  const usage = 'Dùng: node tools-intent/relabel-policy.mjs <in.jsonl> <out.jsonl> [--templates <settings.json>] [--conflicts <file.jsonl>] [--stable-only]';
  const cli = parseCliArgs(args, ['--templates', '--conflicts']);
  const [inPath, outPath] = cli.positional;
  if (!inPath || !outPath) cliFail(usage);
  if (!existsSync(inPath)) cliFail(`Không thấy tệp vào: ${inPath}`);
  const templatesArg = cli.value('--templates');
  if (templatesArg && !existsSync(templatesArg)) cliFail(`Không thấy tệp mẫu: ${templatesArg}`);
  const templates = templatesArg ? loadTemplatesArg(templatesArg) : loadSeedTemplates();
  const conflictsPath = cli.value('--conflicts') || outPath.replace(/\.jsonl$/, '') + '.staff-vs-rule.jsonl';
  (await import(pathToFileURL(path.join(root, 'app/processing/catalog.mjs')).href)).reloadCatalog();
  const readStats = {};
  const rows = readJsonl(readFileSync(inPath, 'utf8'), readStats);
  if (readStats.bad) console.warn(`Bỏ ${readStats.bad} dòng hỏng trong ${inPath} (dòng ${readStats.badLines.slice(0, 10).join(', ')})`);
  const { rows: out, matrix, conflicts, stats, missing } = relabelRows(rows, { templates, experimentalRules: cli.has('--stable-only') ? 'shadow' : 'on' });
  writeFileSync(outPath, toJsonl(out));
  writeFileSync(conflictsPath, toJsonl(conflicts));
  console.log(`Mẫu: ${templatesArg ? `${templatesArg} (gộp seed như engine)` : 'seed'} · ${Object.keys(templates).length} mã`);
  console.log(JSON.stringify(stats));
  if (stats.missingTemplate) console.warn(`CẢNH BÁO mẫu luật ra không có trong bộ mẫu (dòng giữ nhãn gốc, không gắn rule): ${Object.entries(missing).map(([id, n]) => `${id} ×${n}`).join(' · ')}`);
  if (stats.basketUnknown) console.log(`Kết quả phụ thuộc giỏ mà giỏ không dựng lại được: ${stats.basketUnknown} dòng giữ nhãn gốc (weak ${stats.basketUnknownWeak}, dòng nhật ký bước đơn giữ nguyên ${stats.pipelineKept})`);
  console.log('Ma trận nhãn cũ → nhãn luật (top 40):');
  for (const [key, count] of Object.entries(matrix).sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${String(count).padStart(5)}  ${key}`);
  console.log(`Nhân viên ≠ luật: ${conflicts.length} dòng → ${conflictsPath}`);
  for (const item of conflicts.slice(0, 15)) console.log(`  "${item.text.slice(0, 60).replace(/\n/g, ' | ')}"${item.lastTemplate ? ` (bot trước ${item.lastTemplate})` : ''} → nhân viên ${item.staff} · luật ${item.ruleName}=${item.rule}`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
