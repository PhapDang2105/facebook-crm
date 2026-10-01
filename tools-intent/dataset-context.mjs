// Hàm dùng chung cho bộ công cụ dữ liệu mô hình nhỏ (hợp đồng dòng dữ liệu v2):
// gộp tin khách như engine, dựng ngữ cảnh (giỏ, đơn, bot vừa xin gì…) từ lịch sử hội thoại,
// che SĐT, tập nhãn "lệch chính sách" (POLICY_DRIFT). Chỉ đọc mã app, không ghi gì.
// Vòng 12: các trường mô hình dùng (lastTemplate, lastWasOrderStep, prevBotAsks, hasOrder, phone/address/bag…) dựng
// bằng intentRowOf của app/processing/intent-features.mjs — MỘT định nghĩa với engine; che bằng maskPersonal của
// nhật ký quyết định (token "<sdt>/<email>/<so>" khớp nhật ký, số tiền không bị che).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractVietnamesePhone } from '../app/processing/customer-info.mjs';
import { maskPersonal } from '../app/processing/decision-log.mjs';
import { ADDRESS_WORDS, canonicalTemplateId, countBags, intentRowOf, isOrderStepContext, normalizeIntentText, orderContextOf, prevBotAsksOf as prevBotAsksOfRow } from '../app/processing/intent-features.mjs';
import { foldText } from '../app/processing/template-match.mjs';

/** Nhãn mà câu bot đã gửi KHÔNG chắc là câu đúng (chính sách đổi, hậu xử lý, thiếu ngữ cảnh): LLM được phép sửa. */
export const POLICY_DRIFT = new Set(['ORDER_ADDRESS', 'ASK_PRODUCT', 'ASK_FLAVOR', 'GENERAL_INFO', 'PRICE_QUOTE', 'REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO', 'ORDER_ADDRESS_REMIND', 'THANK_YOU']);

/** SĐT giả thay cho "<sdt>" khi chạy luật ngoại tuyến (luật đọc SĐT thật bằng extractVietnamesePhone). */
export const FAKE_PHONE = '0912345678';
/** Che như nhật ký quyết định (maskPersonal: SĐT → <sdt>, email → <email>, dãy ≥ 9 số → <so>), gọn khoảng trắng. */
export const maskPhone = text => maskPersonal(String(text || '')).replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
export const unmaskPhone = text => String(text || '').replace(/<sdt>/g, FAKE_PHONE);

/** Chuỗi trông như MÃ MẪU ("ORDER_ADDRESS") chứ không phải câu bot — dataset dựng từ nhật ký cũ ghi mã vào prevBot. */
export const looksLikeTemplateId = value => /^[A-Z][A-Z0-9_]*$/.test(String(value || '').trim());
/** Câu bot trước để đưa cho LLM / luật: bỏ khi trường chỉ chứa mã mẫu (không bao giờ đưa mã mẫu làm câu bot). */
export const botTextOf = row => (looksLikeTemplateId(row?.prevBot) ? '' : String(row?.prevBot || ''));
/** Mã mẫu bot trước của dòng: lastTemplate, hay mã nằm nhầm trong prevBot (nhật ký cũ). */
export const lastTemplateOf = row => String(row?.lastTemplate || (looksLikeTemplateId(row?.prevBot) ? String(row.prevBot).trim() : '') || '');

/** Bước đơn theo engine (ctx.lastWasOrderStep) — định nghĩa ở intent-features (isOrderStepContext, sau khi quy mã con). */
export const lastWasOrderStepOf = id => isOrderStepContext(id);
/** Mẫu bot mà sau đó giỏ chắc chắn đang được giữ (không gồm ASK_FLAVOR: chưa có túi nào). */
const BASKET_STEPS = /^ORDER_(ADDRESS|PHONE|CONFIRMATION|UPDATE|UPDATED|CART_LINE)|^ORDER_CUSTOM_BASKET$|^UPSELL_TWO_BAGS$/;
/** Chữ ký giỏ trong câu bot: "đang giữ đơn …", "đơn của chị gồm …". */
const BASKET_SIGNATURE = /\bdang giu don\b|\bdon (hang )?cua \S+ gom\b/;
export const basketTtlMin = 120;

/** Giỏ còn hạn suy từ câu bot trước: bước đơn / chữ ký giỏ, và câu đó gửi chưa quá 120 phút. */
export function hasBasketOf({ lastTemplate = '', prevBot = '', prevBotAgeMin = Infinity } = {}) {
  const age = Number.isFinite(Number(prevBotAgeMin)) && prevBotAgeMin !== null ? Number(prevBotAgeMin) : Infinity;
  if (age >= basketTtlMin) return false;
  return BASKET_STEPS.test(String(lastTemplate || '')) || BASKET_SIGNATURE.test(foldText(prevBot));
}

/** Số túi trong giỏ bot nêu ở câu trước ("2 Granola Túi Xanh 450g, 1 Túi Vàng…" → 3); 0 khi không phải bước đơn. */
export function basketItemsOf({ lastTemplate = '', prevBot = '' } = {}) {
  const folded = foldText(prevBot);
  if (!BASKET_STEPS.test(String(lastTemplate || '')) && !BASKET_SIGNATURE.test(folded)) return 0;
  const segment = folded.replace(/^.*?\b(gom|giu don)\b/, '').replace(/\b(tong|so dien thoai|dia chi)\b.*$/, '');
  let total = 0;
  for (const match of segment.matchAll(/\b(\d{1,2}) (?:granola )?(?:tui|goi|bich|hop|combo|set)\b/g)) total += Number(match[1]);
  return Math.min(total, 99);
}

/** Bot vừa xin gì (ngoại tuyến: không biết giỏ → đọc chữ câu bot) — cùng prevBotAsksOf của intent-features. */
export const prevBotAsksOf = (prevBot, lastTemplate = '') => prevBotAsksOfRow({ lastTemplateId: lastTemplate, prevBotText: prevBot });
// Tin gộp: SĐT ở dòng riêng ("0912 345 678\n12 Nguyễn Huệ…") — extractVietnamesePhone nối số qua xuống dòng và
// hỏng, nên xét cả từng dòng (mô hình nhìn chữ đã che "<sdt>", cũng theo từng SĐT).
export const phoneInTextOf = text => String(text || '').includes('<sdt>') || Boolean(extractVietnamesePhone(String(text || ''))) || String(text || '').split('\n').some(line => extractVietnamesePhone(line));
export const addressInTextOf = text => ADDRESS_WORDS.test(normalizeIntentText(text));
export const bagCountOf = text => countBags(text);

/** Đơn còn hiệu lực (như engine.isActiveOrder). */
export const isActiveOrder = order => Boolean(order) && String(order.processingStatus || '') !== 'cancelled' && order.status !== 'Hủy';

/** Đơn chưa hủy gần nhất đặt trước mốc `at` → { hasOrder (< 24 giờ, như engine), orderAgeMin } — orderContextOf của intent-features. */
export function orderContextAt(customerOrders, at) {
  return orderContextOf(customerOrders, Number(at) - 1);
}

// Gộp tin như engine (unansweredCustomerMessages): tin chữ của khách sau câu trả lời gần nhất của
// Page, trong 10 phút tính tới tin đang xử lý, nhiều nhất 5 tin, nối bằng "\n".
export const bundleWindowMs = 10 * 60 * 1000;
export const bundleLimit = 5;
const isCustomerText = item => item?.direction === 'incoming' && (item.type || 'text') === 'text' && String(item.text || '').trim();

/**
 * Cắt lịch sử (đã sắp xếp theo thời gian) thành các LƯỢT: mỗi cụm tin khách liên tiếp (tới tin Page
 * kế tiếp) là một lượt; tin cuối cụm là tin engine xử lý, `bundle` là các tin được gộp vào nó.
 * @returns {{ index:number, current:object, bundle:object[], text:string, replies:object[], before:object[] }[]}
 */
export function customerTurns(messages) {
  const list = (Array.isArray(messages) ? messages : []).slice().sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  const turns = [];
  let i = 0;
  while (i < list.length) {
    if (list[i]?.direction !== 'incoming') { i += 1; continue; }
    let j = i;
    while (j < list.length && list[j]?.direction === 'incoming') j += 1;
    const cluster = list.slice(i, j);
    const texts = cluster.filter(isCustomerText);
    if (texts.length) {
      const current = texts[texts.length - 1];
      const now = Number(current.createdAt) || 0;
      const bundle = texts.filter(item => now - (Number(item.createdAt) || now) <= bundleWindowMs).slice(-bundleLimit);
      const replies = [];
      for (let k = j; k < list.length && list[k]?.direction !== 'incoming'; k += 1) replies.push(list[k]);
      turns.push({ index: list.indexOf(current), current, bundle, text: bundle.map(item => String(item.text || '').trim()).join('\n'), replies, before: list.slice(0, i) });
    }
    i = j;
  }
  return turns;
}

/**
 * Ngữ cảnh v2 của một lượt từ lịch sử trước cụm (`before`), lúc `at`.
 * Bot = tin Page không mang cờ staff; nhân viên = tin Page có cờ staff.
 * `lastTemplate` là mã engine LƯU (mã con → ORDER_ADDRESS…, canonicalTemplateId); mã khớp chữ gốc ghi ở
 * `lastTemplateMatched` khi khác. `prevBotAsks` / `lastWasOrderStep` theo intentRowOf.
 */
export function turnContext({ before, at, matchTemplateFn = () => '' }) {
  const outgoing = before.filter(item => item?.direction === 'outgoing' && item.text);
  const prevOut = outgoing[outgoing.length - 1] || null;
  const prevIn = [...before].reverse().find(isCustomerText) || null;
  const lastBot = [...outgoing].reverse().find(item => !item.staff) || null;
  const lastBotAt = Number(lastBot?.createdAt) || 0;
  const matched = prevOut ? String(matchTemplateFn(prevOut.text) || '') : '';
  const lastTemplate = canonicalTemplateId(matched);
  const prevBotAgeMin = prevOut ? Math.round((at - (Number(prevOut.createdAt) || at)) / 60000) : null;
  const prevBot = prevOut ? maskPhone(prevOut.text).slice(0, 240) : '';
  const hasBasket = hasBasketOf({ lastTemplate: matched || lastTemplate, prevBot, prevBotAgeMin });
  const row = intentRowOf({ text: '', lastTemplateId: matched, prevBotText: prevBot, hasBasket, now: at });
  return {
    prevBot,
    prevCustomer: prevIn ? maskPhone(prevIn.text).slice(0, 160) : '',
    lastTemplate,
    ...(matched && matched !== lastTemplate ? { lastTemplateMatched: matched } : {}),
    lastWasOrderStep: row.lastWasOrderStep,
    hasBasket,
    basketItems: basketItemsOf({ lastTemplate: matched || lastTemplate, prevBot }),
    prevBotAsks: row.prevBotAsks,
    prevBotAgeMin,
    staffRepliedAfterBot: outgoing.some(item => item.staff && (Number(item.createdAt) || 0) > lastBotAt + 5000)
  };
}

/** Các trường tính từ chính chữ khách (đã gộp; SĐT thật hay "<sdt>" đều tính là có) — như intentRowOf. */
export function textContext(text) {
  const row = intentRowOf({ text, phoneInText: phoneInTextOf(text) });
  return { phoneInText: row.phoneInText, addressInText: row.addressInText, bagCount: row.bagCount };
}

/**
 * Đọc JSONL: bỏ dòng trống; dòng hỏng (ghi dở, JSON sai) BỎ QUA và đếm vào `stats.bad` (không ném lỗi).
 * @param {string} content
 * @param {{ bad?: number, badLines?: number[] }} [stats]
 */
export function readJsonl(content, stats = null) {
  const rows = [];
  String(content || '').split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try { rows.push(JSON.parse(line)); } catch {
      if (stats) { stats.bad = (stats.bad || 0) + 1; (stats.badLines ||= []).push(index + 1); }
    }
  });
  return rows;
}
export const toJsonl = rows => rows.map(row => JSON.stringify(row)).join('\n');

/** Lỗi dùng CLI: in gọn (không stack) rồi thoát 1. */
export function cliFail(message) {
  console.error(message);
  process.exit(1);
}

export const HELP_FLAGS = ['--help', '-h'];

/** Hướng dẫn dùng của một CLI = khối chú thích `//` liền ở đầu tệp (đã viết sẵn ở mọi công cụ). */
export function cliUsage(file = process.argv[1]) {
  let content = '';
  try { content = readFileSync(String(file).startsWith('file:') ? fileURLToPath(file) : file, 'utf8'); } catch { return ''; }
  const lines = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith('//')) break;
    lines.push(line.replace(/^\/\/ ?/, ''));
  }
  return lines.join('\n');
}

/** Đọc JSON từ tệp; tệp thiếu/hỏng → lỗi CLI gọn (không stack), exit 1. `label` nêu tệp gì trong thông báo. */
export function readJsonFileOrFail(file, label = 'Tệp JSON') {
  let content;
  try { content = readFileSync(file, 'utf8'); } catch (error) { cliFail(`${label} ${file} không đọc được: ${String(error.code || error.message).slice(0, 80)}`); }
  try { return JSON.parse(content); } catch (error) { cliFail(`${label} ${file} không phải JSON hợp lệ: ${String(error.message).slice(0, 80)}`); }
}

/**
 * Đọc đối số CLI:
 * - `--help` / `-h`: in hướng dẫn (khối chú thích đầu tệp CLI đang chạy, hay `help` truyền vào) rồi thoát 0 — không chạy gì;
 * - cờ có giá trị (`valueFlags`) thiếu giá trị (hết đối số hay giá trị bắt đầu bằng "--") → lỗi rõ, exit 1;
 * - có `booleanFlags` (mảng cờ bật/tắt): cờ "--…" không thuộc valueFlags ∪ booleanFlags → lỗi "cờ lạ", exit 1
 *   (gõ nhầm "--limt 10" trước đây bị bỏ qua lặng lẽ và chạy hết bộ dữ liệu).
 * @returns {{ positional: string[], has: (flag: string) => boolean, value: (flag: string, fallback?: string) => string }}
 */
export function parseCliArgs(args, valueFlags = [], booleanFlags = null, { help = '' } = {}) {
  const flags = new Set(valueFlags);
  if (args.some((arg, index) => HELP_FLAGS.includes(arg) && !flags.has(args[index - 1]))) {
    console.log(help || cliUsage() || 'Không có hướng dẫn cho lệnh này.');
    process.exit(0);
  }
  for (let i = 0; i < args.length; i += 1) {
    if (!flags.has(args[i])) continue;
    const next = args[i + 1];
    if (next === undefined || next === '' || next.startsWith('--')) cliFail(`Thiếu giá trị cho ${args[i]}.`);
  }
  if (Array.isArray(booleanFlags)) {
    const known = new Set([...valueFlags, ...booleanFlags]);
    const unknown = args.filter((arg, index) => arg.startsWith('--') && !known.has(arg) && !flags.has(args[index - 1]));
    if (unknown.length) cliFail(`Cờ lạ: ${unknown.join(', ')}. Cờ hợp lệ: ${[...known].sort().join(' ') || '(không có)'} — xem --help.`);
  }
  const positional = args.filter((arg, index) => !arg.startsWith('--') && !flags.has(args[index - 1]));
  return {
    positional,
    has: flag => args.includes(flag),
    value: (flag, fallback = '') => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback)
  };
}

/** Số nguyên dương từ đối số CLI (--limit, --concurrency…); sai → lỗi rõ, exit 1. */
export function positiveIntArg(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) cliFail(`${flag} phải là số nguyên dương (nhận "${raw}").`);
  return value;
}
