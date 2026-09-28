// Gán lại nhãn theo LUẬT hiện hành (chính sách mới nhất): với mỗi dòng dataset dựng ctx như engine truyền
// vào ruleIntent, chạy luật ổn định + luật thử nghiệm ('on'), soạn qua renderChatbotReply (mẫu seed) → ruleTemplate.
// Luật bắt được thì nhãn = ruleTemplate, labelSource 'rule' — TRỪ dòng nhân viên (staff/corrected): nhân viên
// thắng luật; dòng nhân viên ≠ luật được ghi ra tệp riêng (bug luật tiềm năng).
// Dùng: node tools-intent/relabel-policy.mjs <in.jsonl> <out.jsonl> [--templates <settings.json>] [--conflicts <file.jsonl>] [--stable-only]
// Giả định khi dựng ctx ngoại tuyến: xem tools-intent/README.md (mục "Giả định ctx ngoại tuyến").
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';
import { commentBasket } from '../app/chatbot-engine.mjs';
import { isComplaint } from '../app/processing/auto-label.mjs';
import { describeDeliveryAddress } from '../app/processing/locations.mjs';
import { lastWasOrderStepOf, readJsonl, toJsonl, unmaskPhone } from './dataset-context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const loadSeedTemplates = () => JSON.parse(readFileSync(path.join(root, 'app', 'chatbot-templates.seed.json'), 'utf8'));

/** Giỏ suy từ câu bot trước ("đang giữ đơn 2 Túi Xanh…"): để bộ soạn đơn có món khi luật trả ORDER_ADDRESS. */
export function pendingOrderFromPrevBot(row) {
  if (!row.hasBasket) return null;
  const items = commentBasket(String(row.prevBot || ''));
  if (!items.length) return null;
  return { key: 'offline', at: (Number(row.at) || Date.now()) - 60000, items };
}

/**
 * ctx cho ruleIntent dựng lại từ một dòng v2 — cùng tên trường như engine (chatbot-engine.mjs, chỗ gọi ruleIntentFn).
 * Trường không dựng được ngoại tuyến đặt mặc định an toàn: hasPreviousDelivery false, contextProduct '',
 * quotedProduct '', trialOffer false; SĐT đã che ("<sdt>") thay bằng SĐT giả để luật đọc được.
 */
export function offlineRuleContext(row, { complaintKeywords, experimentalRules = 'on' } = {}) {
  const text = unmaskPhone(row.text);
  const withoutPhone = text.replace(/\+?\d[\d .-]{8,13}/g, ' ').replace(/\s+/g, ' ').trim();
  const lastTemplate = String(row.lastTemplate || '');
  const orderAgeMin = row.hasOrder && Number.isFinite(Number(row.orderAgeMin)) && row.orderAgeMin !== null ? Number(row.orderAgeMin) : Infinity;
  const bundleSize = Number(row.bundleSize) || text.split('\n').filter(Boolean).length || 1;
  return {
    text,
    ctx: {
      source: row.source === 'comment' ? 'comment' : 'inbox',
      botLastTemplateId: lastTemplate,
      hasPreviousDelivery: false,
      staffRepliedAfterBot: Boolean(row.staffRepliedAfterBot),
      botLastAgeMin: Number.isFinite(Number(row.prevBotAgeMin)) && row.prevBotAgeMin !== null ? Number(row.prevBotAgeMin) : Infinity,
      hasBasket: Boolean(row.hasBasket),
      lastWasOrderStep: row.lastWasOrderStep ?? lastWasOrderStepOf(lastTemplate),
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
      addressComplete: Boolean(row.hasBasket && withoutPhone && describeDeliveryAddress(withoutPhone).complete),
      addressText: withoutPhone,
      smallPackContext: lastTemplate === 'PACKAGING_INFO' || /gói nhỏ|combo 10 gói/i.test(String(row.prevBot || ''))
    }
  };
}

/** Chạy luật cho một dòng → { ruleName, ruleTemplate, attention } ('' khi luật không bắt; 'COMMENT_RULE' cho luật bình luận). */
export function ruleLabelOf(row, { templates, complaintKeywords, experimentalRules = 'on' } = {}) {
  const { text, ctx } = offlineRuleContext(row, { complaintKeywords, experimentalRules });
  const ruled = ruleIntent(text, ctx);
  if (!ruled) return { ruleName: '', ruleTemplate: '' };
  if (ruled.commentRule) return { ruleName: ruled.rule, ruleTemplate: 'COMMENT_RULE' };
  const replyContext = {
    pendingOrder: pendingOrderFromPrevBot(row),
    recentOrder: null,
    latestOrder: null,
    lastTemplateId: ctx.botLastTemplateId,
    previousDelivery: null,
    trial: null,
    now: Number(row.at) || Date.now(),
    recentOutgoing: row.prevBot ? [String(row.prevBot)] : [],
    recentCustomerTexts: [row.prevCustomer, text].filter(Boolean),
    messageText: text,
    noUpsell: false,
    customer: { gender: '', name: '' }
  };
  let ruleTemplate = ruled.value?.template_id || '';
  try { ruleTemplate = renderChatbotReply(ruled.value, templates, replyContext).templateId || ruleTemplate; } catch { /* mẫu thiếu: giữ template_id thô */ }
  return { ruleName: ruled.rule, ruleTemplate, attention: Boolean(ruled.attention), experimental: Boolean(ruled.experimental) };
}

export function relabelRows(rows, options = {}) {
  const out = [];
  const matrix = {};
  const conflicts = [];
  const stats = { total: rows.length, ruled: 0, relabeled: 0, staffKept: 0, comment: 0, changed: 0 };
  for (const row of rows) {
    const { ruleName, ruleTemplate, attention } = ruleLabelOf(row, options);
    const isStaff = row.labelSource === 'staff' || row.corrected;
    const next = { ...row, ruleTemplate, ...(ruleName ? { ruleName } : {}) };
    if (ruleTemplate) {
      stats.ruled += 1;
      const key = `${row.label} → ${ruleTemplate}`;
      matrix[key] = (matrix[key] || 0) + 1;
      if (ruleTemplate === 'COMMENT_RULE') stats.comment += 1;
      else if (isStaff) {
        stats.staffKept += 1;
        if (ruleTemplate !== row.label) conflicts.push({ id: row.id, text: row.text, lastTemplate: row.lastTemplate, prevBot: row.prevBot, staff: row.label, rule: ruleTemplate, ruleName, hasBasket: row.hasBasket, hasOrder: row.hasOrder });
      } else {
        stats.relabeled += 1;
        if (ruleTemplate !== row.label) stats.changed += 1;
        Object.assign(next, { label: ruleTemplate, labelSource: 'rule', ...(attention ? { attention: true } : {}) });
        delete next.weak;
      }
    }
    out.push(next);
  }
  return { rows: out, matrix, conflicts, stats };
}

async function main() {
  const args = process.argv.slice(2);
  const valueFlags = new Set(['--templates', '--conflicts']);
  const positional = args.filter((arg, index) => !arg.startsWith('--') && !valueFlags.has(args[index - 1]));
  const [inPath, outPath] = positional;
  if (!inPath || !outPath) { console.log('Dùng: node tools-intent/relabel-policy.mjs <in.jsonl> <out.jsonl> [--templates <settings.json>] [--conflicts <file.jsonl>] [--stable-only]'); process.exit(1); }
  const templatesArg = args.includes('--templates') ? args[args.indexOf('--templates') + 1] : '';
  const templates = templatesArg ? (JSON.parse(readFileSync(templatesArg, 'utf8')).messageTemplates || JSON.parse(readFileSync(templatesArg, 'utf8'))) : loadSeedTemplates();
  const conflictsPath = args.includes('--conflicts') ? args[args.indexOf('--conflicts') + 1] : outPath.replace(/\.jsonl$/, '') + '.staff-vs-rule.jsonl';
  (await import(pathToFileURL(path.join(root, 'app/processing/catalog.mjs')).href)).reloadCatalog();
  const rows = readJsonl(readFileSync(inPath, 'utf8'));
  const { rows: out, matrix, conflicts, stats } = relabelRows(rows, { templates, experimentalRules: args.includes('--stable-only') ? 'shadow' : 'on' });
  writeFileSync(outPath, toJsonl(out));
  writeFileSync(conflictsPath, toJsonl(conflicts));
  console.log(JSON.stringify(stats));
  console.log('Ma trận nhãn cũ → nhãn luật (top 40):');
  for (const [key, count] of Object.entries(matrix).sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${String(count).padStart(5)}  ${key}`);
  console.log(`Nhân viên ≠ luật: ${conflicts.length} dòng → ${conflictsPath}`);
  for (const item of conflicts.slice(0, 15)) console.log(`  "${item.text.slice(0, 60).replace(/\n/g, ' | ')}"${item.lastTemplate ? ` (bot trước ${item.lastTemplate})` : ''} → nhân viên ${item.staff} · luật ${item.ruleName}=${item.rule}`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
