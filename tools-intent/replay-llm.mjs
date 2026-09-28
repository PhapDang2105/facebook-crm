// Replay LLM trên bộ chấm mẫu: gọi Gemini đúng như đường trả lời thật (prompt, cache, thinking đang cài)
// cho từng tin hộp thư đã chấm, so mã mẫu LLM chọn (và luật ổn định nếu bắt) với mã nhân viên chấm.
// Chạy trên máy chủ: node --env-file=.env tools-intent/replay-llm.mjs [golden-set.json] [--limit N]
// Không gửi gì cho khách. Kết quả chi tiết ghi ra replay-llm-out.json cạnh tệp bộ chấm.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = file => import(pathToFileURL(path.join(root, file)).href);
const { botTextOf, cliFail, lastTemplateOf, parseCliArgs, positiveIntArg } = await load('tools-intent/dataset-context.mjs');
const { canonicalTemplateId } = await load('app/processing/intent-features.mjs');
const args = process.argv.slice(2);
const cli = parseCliArgs(args, ['--limit']);
// Đường dẫn tương đối tính theo thư mục gọi lệnh (rồi mới chdir về gốc dự án để nạp engine).
const goldenPath = path.resolve(cli.positional[0] || path.join(root, 'data', 'processed', 'golden-set.json'));
const limit = cli.has('--limit') ? positiveIntArg(cli.value('--limit'), '--limit') : Infinity;
if (!existsSync(goldenPath)) cliFail(`Không thấy bộ chấm: ${goldenPath}`);
process.chdir(root);
// --fewshot: chèn 3 ví dụ đã chấm gần nhất (bỏ chính tin đang đo = leave-one-out).
const fewShot = cli.has('--fewshot');
// Ghi tạm và ghi cuối vào CÙNG tệp đích: --fewshot không được đè replay-llm-out.json (tệp --trust / --gate đang dùng).
const outPath = path.join(path.dirname(goldenPath), `replay-llm-out${fewShot ? '-fewshot' : ''}.json`);
const engine = await load('app/chatbot-engine.mjs');
const { normalizeChatbotSettings } = await load('app/chatbot-settings.mjs');
const { ruleIntent } = await load('app/processing/rule-intent.mjs');
const { renderChatbotReply } = await load('app/chatbot-templates.mjs');
const { buildExampleBank, nearestExamples } = await load('app/processing/example-bank.mjs');
(await load('app/processing/catalog.mjs')).reloadCatalog();
const stored = JSON.parse(readFileSync(path.join(root, 'data', 'processed', 'chatbot-settings.json'), 'utf8'));
const settings = normalizeChatbotSettings({ ...stored, enabled: true });

const allItems = JSON.parse(readFileSync(goldenPath, 'utf8')).items || [];
const items = allItems.filter(item => item.source !== 'comment' && item.label && item.label !== 'SKIP').slice(0, limit);
const bank = fewShot ? buildExampleBank(allItems.filter(item => item.label && item.label !== 'SKIP')) : null;
if (!items.length) { console.log('Chưa có tin hộp thư nào được chấm.'); process.exit(0); }
console.log(`${items.length} tin hộp thư đã chấm · model ${settings.directModel} · thinking ${settings.thinkingLevel || 'mặc định'} · few-shot ${fewShot ? 'BẬT (leave-one-out)' : 'tắt'}`);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = [];
for (const [index, item] of items.entries()) {
  const at = Number(item.at) || Date.now();
  // Câu bot trước là CHỮ; mã mẫu (mục dựng từ nhật ký cũ) chỉ làm botLastTemplateId, không đưa làm câu bot.
  const prevBotText = botTextOf(item);
  const lastTemplate = canonicalTemplateId(lastTemplateOf(item));
  const recentMessages = [
    ...(item.prevCustomer ? [{ direction: 'incoming', type: 'text', text: item.prevCustomer, createdAt: at - 120000 }] : []),
    ...(prevBotText ? [{ direction: 'outgoing', type: 'text', text: prevBotText, createdAt: at - 60000 }] : [])
  ];
  const conversation = { id: 'replay', name: 'Khách', source: 'inbox', botEnabled: true, botLastTemplateId: lastTemplate, botLastReplyAt: prevBotText || lastTemplate ? at - 60000 : 0 };
  let llm = 'LỖI';
  let raw = '';
  let ms = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = Date.now();
    try {
      const examples = bank ? nearestExamples(bank, { text: item.text, lastTemplate: item.lastTemplate || '', excludeId: item.id, source: item.source || 'inbox' }) : [];
      const reply = await engine.requestDirectModelReply({ settings, conversation, message: { type: 'text', text: item.text, createdAt: at }, recentMessages, rawResponse: true, context: {}, examples });
      raw = String(reply.parsed?.template_id || '');
      // So mẫu SAU khi dựng câu (renderChatbotReply): "2 túi" mà chưa rõ vị thì ORDER_ADDRESS thành ASK_FLAVOR…
      try { llm = renderChatbotReply(reply.parsed || {}, settings.messageTemplates, { messageText: item.text }).templateId || raw; } catch { llm = raw; }
      ms = Date.now() - started;
      break;
    } catch (error) {
      if (attempt === 2) llm = `LỖI ${String(error.message).slice(0, 40)}`;
      else await wait(4000);
    }
  }
  const ruled = ruleIntent(item.text, { source: 'inbox', botLastTemplateId: lastTemplate });
  const rule = ruled?.value?.template_id || '';
  out.push({ id: item.id, text: item.text.slice(0, 80), lastTemplate, truth: item.label, raw, llm, rule, pipeline: rule || llm, ms, ...(llm.startsWith('LỖI') ? { llmError: true } : {}) });
  if ((index + 1) % 20 === 0) { console.log(`${index + 1}/${items.length}`); writeFileSync(outPath, JSON.stringify(out)); }
  await wait(150);
}
writeFileSync(outPath, JSON.stringify(out));
console.log(`Ghi ${outPath}`);

const pct = (num, den) => (den ? `${(100 * num / den).toFixed(1)}%` : '–');
const ok = out.filter(row => !row.llm.startsWith('LỖI'));
const isOrder = id => /^ORDER_|^ASK_FLAVOR|^SHOP_ORDER/.test(id);
const group = (rows, name) => `${name}: LLM ${pct(rows.filter(r => r.llm === r.truth).length, rows.length)} · luật+LLM ${pct(rows.filter(r => r.pipeline === r.truth).length, rows.length)} (${rows.length} tin)`;
// Ca engine quyết trước LLM (giỏ Shop, luồng dùng thử) hoặc LLM thiếu ngữ cảnh giỏ/đơn đã lưu trong replay
// (chốt đơn, địa chỉ từng phần): tách ra để nhìn đúng phần LLM thật sự quyết.
const beforeLlm = id => /^SHOP_ORDER|^TRIAL_/.test(id);
const needsBasket = id => ['ORDER_CONFIRMATION', 'ORDER_ADDRESS_PARTIAL', 'ORDER_UPDATED'].includes(id);
const decidable = ok.filter(r => !beforeLlm(r.truth) && !needsBasket(r.truth));
console.log(group(ok, 'Tổng'));
console.log(group(decidable, 'Phần LLM thật sự quyết (bỏ giỏ Shop/dùng thử/chốt đơn thiếu ngữ cảnh)'));
console.log(group(ok.filter(r => isOrder(r.truth)), 'Nhóm lên đơn'));
console.log(group(ok.filter(r => !isOrder(r.truth)), 'Nhóm thông tin/khác'));
console.log(`Lỗi gọi model: ${out.length - ok.length} · độ trễ trung bình ${Math.round(ok.reduce((sum, r) => sum + r.ms, 0) / Math.max(1, ok.length))} ms`);
const confusion = {};
for (const row of ok) if (row.llm !== row.truth) confusion[`${row.truth} → ${row.llm}`] = (confusion[`${row.truth} → ${row.llm}`] || 0) + 1;
console.log('LLM nhầm nhiều nhất (đúng → LLM chọn):', Object.entries(confusion).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, n]) => `${key} ×${n}`).join(' · '));
console.log('\nVí dụ LLM sai:');
for (const row of ok.filter(r => r.llm !== r.truth).slice(0, 25)) console.log(`  "${row.text.slice(0, 60)}"${row.lastTemplate ? ` (bot trước ${row.lastTemplate})` : ''} → LLM ${row.llm} · đúng ${row.truth}`);
