// Dựng tập huấn luyện mô hình nhỏ từ kho hội thoại: (tin khách, ngữ cảnh) → mã mẫu Page đã trả lời.
// Chạy trên máy chủ:  node --env-file=.env tools-intent/build-dataset.mjs <out.jsonl> [--since 2026-09-18] [--llm]
//   - Trả lời khớp mẫu (bot hay nhân viên bấm mẫu) → nhãn theo chữ ký mẫu (labelSource 'template').
//   - Trả lời KHÔNG khớp mẫu = nhân viên tự viết → với --llm, Gemini quy câu nhân viên về mã mẫu
//     gần nhất (labelSource 'staff'); nhân viên viết lại ngay sau bot (≤ 10 phút, khách chưa nhắn thêm)
//     thì nhãn nhân viên thay nhãn bot và đánh dấu corrected (bot trả lời sai, đây là nhãn quý nhất).
//   - Kết quả LLM lưu ở data/processed/staff-labels.json để lần sau không hỏi lại.
// Chỉ ghi chữ khách đã che SĐT; không ghi tên; không gửi gì cho khách.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = file => import(pathToFileURL(path.join(root, file)).href);
const { templateSignatures, matchTemplate, isSystemNotice } = await load('app/processing/template-match.mjs');
const args = process.argv.slice(2);
const outPath = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--since')[0];
if (!outPath) { console.log('Dùng: node tools-intent/build-dataset.mjs <out.jsonl> [--since YYYY-MM-DD] [--llm]'); process.exit(1); }
const since = Date.parse(args.includes('--since') ? args[args.indexOf('--since') + 1] : '2026-09-18T00:00:00Z');
const useLlm = args.includes('--llm');
// CRM_DATA_DIR: chỉ để chạy trên bản sao dữ liệu ở máy khác; mặc định là kho thật của app.
const dataDir = process.env.CRM_DATA_DIR || path.join(root, 'data', 'processed');
const store = JSON.parse(readFileSync(path.join(dataDir, 'meta-conversations.json'), 'utf8'));
const settings = JSON.parse(readFileSync(path.join(dataDir, 'chatbot-settings.json'), 'utf8'));
const templates = settings.messageTemplates || {};
const signatures = templateSignatures(templates);
const cachePath = path.join(dataDir, 'staff-labels.json');
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

const maskPhone = text => String(text || '').replace(/\+?\d[\d .-]{8,13}/g, ' <sdt> ').replace(/\s+/g, ' ').trim();
const isOrderStep = id => /^ORDER_(ADDRESS|CONFIRMATION|UPDATE|UPDATED|CART_LINE)/.test(id) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(id);
const SKIP_IDS = new Set(['COMMENT_PRIVATE_REPLY', 'COMMENT_PUBLIC_FALLBACK', 'COMMENT_PUBLIC_REPEAT', 'ORDER_CART_LINE', 'ORDER_ADDRESS_REMIND', 'ORDER_UNCHANGED', 'ORDER_NOTE_ADDED', 'REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO', 'UPSELL_TWO_BAGS', 'TRIAL_REMIND', 'TRIAL_NEXT_STEP', 'QR_OFFER', 'LIVE_DEAL_CLAIMED', 'COMMENT_PUBLIC_SORRY', 'COMMENT_STAFF_FOLLOWUP', 'ORDER_STATUS_CHECKING', 'ORDER_AFTER_SALE', 'GIFT_POLICY_EMPTY', 'ORDER_UPDATED']);

let labelStaff = null;
if (useLlm) {
  const { getVertexAccessToken, vertexProjectId } = await load('app/vertex-auth.mjs');
  const describe = text => String(text || '').replace(/\[\?[^\]]*\]|\[\/\?\]|\[\[[^\]]*\]\]/g, ' ').replace(/\{[^}]+\}/g, '…').replace(/\s+/g, ' ').trim().slice(0, 70);
  const ids = Object.keys(templates).filter(id => templates[id] && !id.startsWith('FOLLOW_UP_') && !SKIP_IDS.has(id));
  ids.push('OTHER');
  const catalogue = ids.map(id => `${id}: ${id === 'OTHER' ? 'không mã nào tương đương / cần người thật' : describe(templates[id])}`).join('\n');
  const system = `Shop granola Giọt Nắng có bộ mẫu trả lời (mã + nội dung tóm tắt). Cho một tin khách và câu NHÂN VIÊN đã trả lời, hãy chọn ĐÚNG MỘT mã mẫu mà nếu bot dùng thì thay được câu nhân viên (cùng ý, cùng thông tin). Câu nhân viên xử lý việc riêng (tra đơn cụ thể, xin lỗi sự cố, thương lượng) không có mẫu tương đương → OTHER. Chỉ trả JSON.\nDanh sách mã:\n${catalogue}`;
  const schema = { type: 'OBJECT', properties: { template_id: { type: 'STRING', enum: ids }, confidence: { type: 'NUMBER' } }, required: ['template_id', 'confidence'] };
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(vertexProjectId())}/locations/global/publishers/google/models/gemini-3-flash-preview:generateContent`;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  labelStaff = async (customerText, staffText) => {
    const user = `Khách: "${customerText}"\nNhân viên trả lời: "${staffText}"`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = await getVertexAccessToken();
      const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, thinkingConfig: { thinkingLevel: 'low' }, temperature: 0 } }) });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) { await wait(65000); continue; }
      if (response.status === 429 || response.status >= 500) { await wait(2000 * 2 ** attempt * (0.5 + Math.random())); continue; }
      if (!response.ok) return null;
      try { const parsed = JSON.parse(payload?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || ''); return { label: parsed.template_id, confidence: Number(parsed.confidence) || 0 }; } catch { return null; }
    }
    return null;
  };
}

const rows = [];
const stats = { template: 0, staff: 0, corrected: 0, staffUnlabeled: 0, llmCalls: 0 };
for (const conversation of store.conversations) {
  const messages = (store.messages?.[conversation.id] || []).slice().sort((a, b) => a.createdAt - b.createdAt);
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.direction !== 'incoming' || message.type !== 'text' || !message.text || message.createdAt < since) continue;
    // Khách nhắn liên tiếp: chỉ lấy tin cuối của cụm (bot cũng trả lời cụm đó một lần).
    const next = messages[i + 1];
    if (next && next.direction === 'incoming' && next.createdAt - message.createdAt < 60000) continue;
    // Các tin Page gửi trước khi khách nhắn tiếp.
    const replies = [];
    for (let j = i + 1; j < messages.length; j += 1) {
      if (messages[j].direction === 'incoming') break;
      if (messages[j].text && messages[j].type === 'text' && !isSystemNotice(messages[j].text)) replies.push(messages[j]);
    }
    if (!replies.length) continue;
    const first = replies[0];
    const firstLabel = matchTemplate(first.text, signatures);
    // Bot trả lời xong, nhân viên viết thêm câu không khớp mẫu trong 10 phút: coi là nhân viên sửa bot.
    // Câu nhân viên phải có nội dung (≥ 20 ký tự): "Dạ vâng ạ", "Dạ em chào chị ạ" không nói lên mẫu nào.
    const isStaffText = reply => !matchTemplate(reply.text, signatures) && String(reply.text).trim().length >= 20;
    const staffAfterBot = firstLabel ? replies.slice(1).find(reply => isStaffText(reply) && reply.createdAt - first.createdAt <= 10 * 60000) : null;
    const staffReply = !firstLabel ? (isStaffText(first) && first.createdAt - message.createdAt <= 24 * 3600000 ? first : null) : staffAfterBot;
    let label = firstLabel;
    let labelSource = firstLabel ? 'template' : '';
    let corrected = false;
    if (staffReply) {
      const key = `${conversation.id}:${staffReply.createdAt}`;
      if (!(key in cache) && labelStaff) { cache[key] = await labelStaff(maskPhone(message.text).slice(0, 300), maskPhone(staffReply.text).slice(0, 400)); stats.llmCalls += 1; }
      const mapped = cache[key];
      // Bot đã trả lời: chỉ coi là "sửa" khi nhân viên đưa ra câu có mẫu tương đương khác mẫu bot
      // (WELCOME/OTHER = không có mẫu tương đương → giữ nhãn bot).
      const substantive = mapped?.label && mapped.confidence >= 0.7 && !['WELCOME', 'OTHER'].includes(mapped.label);
      if (firstLabel && substantive && mapped.label !== firstLabel) { corrected = true; stats.corrected += 1; label = mapped.label; labelSource = 'staff'; stats.staff += 1; }
      else if (!firstLabel && mapped?.label && mapped.confidence >= 0.7) { label = mapped.label; labelSource = 'staff'; stats.staff += 1; }
      else if (!firstLabel) { stats.staffUnlabeled += 1; continue; }
    }
    if (!label) continue;
    if (labelSource === 'template') stats.template += 1;
    const previousOut = messages.slice(0, i).reverse().find(m => m.direction === 'outgoing' && m.text);
    const previousIn = messages.slice(0, i).reverse().find(m => m.direction === 'incoming' && m.type === 'text' && m.text);
    const lastTemplate = previousOut ? matchTemplate(previousOut.text, signatures) : '';
    rows.push({
      id: `${conversation.id}:${message.createdAt}`,
      prevBot: previousOut ? maskPhone(previousOut.text).slice(0, 240) : '',
      prevCustomer: previousIn ? maskPhone(previousIn.text).slice(0, 160) : '',
      text: maskPhone(message.text).slice(0, 300),
      label,
      labelSource,
      ...(corrected ? { corrected: true } : {}),
      source: conversation.source === 'comment' ? 'comment' : 'inbox',
      lastTemplate,
      lastWasOrderStep: isOrderStep(lastTemplate),
      // Lúc chạy thật engine truyền giỏ đang giữ; ở đây suy từ bước đơn của bot trước để đặc trưng ctx:basket được học.
      hasBasket: isOrderStep(lastTemplate),
      livestream: Boolean((conversation.labels || []).includes('livestream')),
      at: message.createdAt
    });
  }
}
if (useLlm) writeFileSync(cachePath, JSON.stringify(cache));
writeFileSync(outPath, rows.map(row => JSON.stringify(row)).join('\n'));
const counts = rows.reduce((acc, row) => { acc[row.label] = (acc[row.label] || 0) + 1; return acc; }, {});
console.log(JSON.stringify({ rows: rows.length, ...stats, labels: Object.keys(counts).length, top: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12) }));
if (stats.corrected) console.log('Nhân viên sửa bot (mẫu bot → mẫu nhân viên):', rows.filter(row => row.corrected).slice(0, 10).map(row => `"${row.text.slice(0, 50)}" → ${row.label}`).join(' · '));
