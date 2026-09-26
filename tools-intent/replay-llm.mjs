// Replay LLM trên bộ chấm mẫu: gọi Gemini đúng như đường trả lời thật (prompt, cache, thinking đang cài)
// cho từng tin hộp thư đã chấm, so mã mẫu LLM chọn (và luật ổn định nếu bắt) với mã nhân viên chấm.
// Chạy trên máy chủ: node --env-file=.env tools-intent/replay-llm.mjs [golden-set.json] [--limit N]
// Không gửi gì cho khách. Kết quả chi tiết ghi ra replay-llm-out.json cạnh tệp bộ chấm.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const load = file => import(pathToFileURL(path.join(root, file)).href);
const args = process.argv.slice(2);
const goldenPath = args.find(arg => !arg.startsWith('--')) || path.join(root, 'data', 'processed', 'golden-set.json');
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const engine = await load('app/chatbot-engine.mjs');
const { normalizeChatbotSettings } = await load('app/chatbot-settings.mjs');
const { ruleIntent } = await load('app/processing/rule-intent.mjs');
(await load('app/processing/catalog.mjs')).reloadCatalog();
const stored = JSON.parse(readFileSync(path.join(root, 'data', 'processed', 'chatbot-settings.json'), 'utf8'));
const settings = normalizeChatbotSettings({ ...stored, enabled: true });

const items = (JSON.parse(readFileSync(goldenPath, 'utf8')).items || []).filter(item => item.source !== 'comment' && item.label && item.label !== 'SKIP').slice(0, limit);
if (!items.length) { console.log('Chưa có tin hộp thư nào được chấm.'); process.exit(0); }
console.log(`${items.length} tin hộp thư đã chấm · model ${settings.directModel} · thinking ${settings.thinkingLevel || 'mặc định'}`);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = [];
for (const [index, item] of items.entries()) {
  const at = Number(item.at) || Date.now();
  const recentMessages = [
    ...(item.prevCustomer ? [{ direction: 'incoming', type: 'text', text: item.prevCustomer, createdAt: at - 120000 }] : []),
    ...(item.prevBot ? [{ direction: 'outgoing', type: 'text', text: item.prevBot, createdAt: at - 60000 }] : [])
  ];
  const conversation = { id: 'replay', name: 'Khách', source: 'inbox', botEnabled: true, botLastTemplateId: item.lastTemplate || '', botLastReplyAt: item.prevBot ? at - 60000 : 0 };
  let llm = 'LỖI';
  let ms = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = Date.now();
    try {
      const reply = await engine.requestDirectModelReply({ settings, conversation, message: { type: 'text', text: item.text, createdAt: at }, recentMessages, rawResponse: true, context: {} });
      llm = String(reply.parsed?.template_id || '');
      ms = Date.now() - started;
      break;
    } catch (error) {
      if (attempt === 2) llm = `LỖI ${String(error.message).slice(0, 40)}`;
      else await wait(4000);
    }
  }
  const ruled = ruleIntent(item.text, { source: 'inbox', botLastTemplateId: item.lastTemplate || '' });
  const rule = ruled?.value?.template_id || '';
  out.push({ id: item.id, text: item.text.slice(0, 80), lastTemplate: item.lastTemplate || '', truth: item.label, llm, rule, pipeline: rule || llm, ms });
  if ((index + 1) % 20 === 0) { console.log(`${index + 1}/${items.length}`); writeFileSync(path.join(path.dirname(goldenPath), 'replay-llm-out.json'), JSON.stringify(out)); }
  await wait(150);
}
writeFileSync(path.join(path.dirname(goldenPath), 'replay-llm-out.json'), JSON.stringify(out));

const pct = (num, den) => (den ? `${(100 * num / den).toFixed(1)}%` : '–');
const ok = out.filter(row => !row.llm.startsWith('LỖI'));
const isOrder = id => /^ORDER_|^ASK_FLAVOR|^SHOP_ORDER/.test(id);
const group = (rows, name) => `${name}: LLM ${pct(rows.filter(r => r.llm === r.truth).length, rows.length)} · luật+LLM ${pct(rows.filter(r => r.pipeline === r.truth).length, rows.length)} (${rows.length} tin)`;
console.log(group(ok, 'Tổng'));
console.log(group(ok.filter(r => isOrder(r.truth)), 'Nhóm lên đơn'));
console.log(group(ok.filter(r => !isOrder(r.truth)), 'Nhóm thông tin/khác'));
console.log(`Lỗi gọi model: ${out.length - ok.length} · độ trễ trung bình ${Math.round(ok.reduce((sum, r) => sum + r.ms, 0) / Math.max(1, ok.length))} ms`);
const confusion = {};
for (const row of ok) if (row.llm !== row.truth) confusion[`${row.truth} → ${row.llm}`] = (confusion[`${row.truth} → ${row.llm}`] || 0) + 1;
console.log('LLM nhầm nhiều nhất (đúng → LLM chọn):', Object.entries(confusion).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, n]) => `${key} ×${n}`).join(' · '));
console.log('\nVí dụ LLM sai:');
for (const row of ok.filter(r => r.llm !== r.truth).slice(0, 25)) console.log(`  "${row.text.slice(0, 60)}"${row.lastTemplate ? ` (bot trước ${row.lastTemplate})` : ''} → LLM ${row.llm} · đúng ${row.truth}`);
