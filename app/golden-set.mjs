// Bộ test vàng cho chatbot: tin khách thật (đã che SĐT) kèm ngữ cảnh, mô hình/LLM gợi ý một
// mã mẫu, nhân viên chấm "mẫu đúng". Chỉ dùng để ĐO (replay, ngưỡng mô hình nhỏ), không huấn luyện.
// Lưu ở data/processed/golden-set.json: { items: [{ id, text, prevCustomer, prevBot, source,
// lastTemplate, suggested, label, labeledAt, at,
//   // ngữ cảnh tuỳ chọn (hợp đồng dữ liệu v2, không bắt buộc — mục cũ không có vẫn hợp lệ):
//   hasBasket, basketItems, hasOrder, orderAgeMin, prevBotAsks, phoneInText, addressInText, bagCount }] }.
// Thiếu ngữ cảnh thì `enrichGoldenContext` dựng lại từ kho hội thoại (hoặc từ chính mục khi không có kho).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { intentRowOf, orderContextOf } from './processing/intent-features.mjs';
import { pendingOrderTtlMs } from './processing/pending-order.mjs';

const goldenPath = process.env.GOLDEN_SET_PATH || path.join(projectRoot, 'data', 'processed', 'golden-set.json');
let cached = null;
let writeQueue = Promise.resolve();

/** Các trường ngữ cảnh tuỳ chọn của một mục golden (cùng tên với hợp đồng dữ liệu v2). */
export const goldenContextFields = ['hasBasket', 'basketItems', 'hasOrder', 'orderAgeMin', 'prevBotAsks', 'phoneInText', 'addressInText', 'bagCount'];

export async function readGoldenSet() {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(await readFile(goldenPath, 'utf8'));
    cached = { items: Array.isArray(parsed?.items) ? parsed.items : [] };
  } catch {
    cached = { items: [] };
  }
  return cached;
}

function updateGoldenSet(mutate) {
  const operation = writeQueue.then(async () => {
    const state = await readGoldenSet();
    const result = await mutate(state);
    await mkdir(path.dirname(goldenPath), { recursive: true });
    const temporary = `${goldenPath}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 1), 'utf8');
    await rename(temporary, goldenPath);
    return result;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

const text = (value, limit) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
const ASK_SLOTS = new Set(['phone', 'address', 'phone_address', 'flavor', 'quantity', 'confirm']);

/** Lọc/chuẩn hoá phần ngữ cảnh tuỳ chọn của một mục; trường thiếu hay sai kiểu thì bỏ (không ghi). */
export function pickGoldenContext(raw = {}) {
  const out = {};
  if (typeof raw.hasBasket === 'boolean') out.hasBasket = raw.hasBasket;
  if (Array.isArray(raw.basketItems)) out.basketItems = raw.basketItems.slice(0, 12).map(item => (typeof item === 'string' ? text(item, 60) : item)).filter(item => item !== '' && item !== null && item !== undefined);
  if (typeof raw.hasOrder === 'boolean') out.hasOrder = raw.hasOrder;
  if (raw.orderAgeMin === null) out.orderAgeMin = null;
  else if (Number.isFinite(Number(raw.orderAgeMin)) && raw.orderAgeMin !== '' && raw.orderAgeMin !== undefined) out.orderAgeMin = Math.max(0, Math.round(Number(raw.orderAgeMin)));
  if (typeof raw.prevBotAsks === 'string' && (raw.prevBotAsks === '' || ASK_SLOTS.has(raw.prevBotAsks))) out.prevBotAsks = raw.prevBotAsks;
  if (typeof raw.phoneInText === 'boolean') out.phoneInText = raw.phoneInText;
  if (typeof raw.addressInText === 'boolean') out.addressInText = raw.addressInText;
  if (Number.isFinite(Number(raw.bagCount)) && raw.bagCount !== '' && raw.bagCount !== null && raw.bagCount !== undefined) out.bagCount = Math.max(0, Math.round(Number(raw.bagCount)));
  return out;
}

/** Nạp danh sách tin cần chấm (thêm mới theo id, giữ nhãn đã chấm; ngữ cảnh v2 tuỳ chọn được giữ nếu có). */
export async function importGoldenItems(items = []) {
  return updateGoldenSet(state => {
    const byId = new Map(state.items.map(item => [item.id, item]));
    let added = 0;
    for (const raw of Array.isArray(items) ? items : []) {
      const id = text(raw?.id, 120);
      if (!id || !text(raw?.text, 300)) continue;
      const existing = byId.get(id);
      const fresh = { id, text: text(raw.text, 300), prevCustomer: text(raw.prevCustomer, 160), prevBot: text(raw.prevBot, 240), source: raw.source === 'comment' ? 'comment' : 'inbox', lastTemplate: text(raw.lastTemplate, 60), suggested: text(raw.suggested, 60), at: Number(raw.at) || 0, ...pickGoldenContext(raw) };
      if (existing) Object.assign(existing, fresh, { label: existing.label || '', labeledAt: existing.labeledAt || 0 });
      else { state.items.push({ ...fresh, label: '', labeledAt: 0 }); byId.set(id, state.items.at(-1)); added += 1; }
    }
    return { added, total: state.items.length };
  });
}

/** Nhân viên chấm: `label` là mã mẫu đúng, 'SKIP' = không rõ / bỏ qua. */
export async function labelGoldenItem(id, label) {
  const clean = text(label, 60).toUpperCase().replace(/[^A-Z0-9_]/g, '');
  if (!clean) throw new Error('Thiếu mã mẫu.');
  return updateGoldenSet(state => {
    const item = state.items.find(entry => entry.id === id);
    if (!item) return null;
    item.label = clean;
    item.labeledAt = Date.now();
    return { ...item };
  });
}

/** Tóm tắt + lô tiếp theo cần chấm (chưa có nhãn), cùng thống kê gợi ý đúng/sai đã chấm. */
export async function goldenSetOverview({ batch = 10 } = {}) {
  const state = await readGoldenSet();
  const labeled = state.items.filter(item => item.label);
  const judged = labeled.filter(item => item.label !== 'SKIP');
  const agree = judged.filter(item => item.label === item.suggested).length;
  const pending = state.items.filter(item => !item.label).sort((a, b) => a.at - b.at).slice(0, batch);
  return { total: state.items.length, labeled: labeled.length, skipped: labeled.length - judged.length, agreeWithSuggestion: agree, judged: judged.length, pending };
}

/** Các mục đã chấm (không SKIP): dùng cho replay và đo mô hình nhỏ. */
export async function goldenLabeled() {
  const state = await readGoldenSet();
  return state.items.filter(item => item.label && item.label !== 'SKIP');
}

// ---- Dựng ngữ cảnh v2 cho mục golden cũ (chỉ có text/prevBot/lastTemplate/at) ----

/** Mẫu mà sau đó bot đang giữ giỏ (khách đã nêu sản phẩm, đang xin SĐT/địa chỉ/chốt). */
export const basketStepTemplates = new Set(['ORDER_ADDRESS', 'ORDER_PHONE', 'ORDER_CONFIRMATION', 'ORDER_UPDATE', 'ORDER_UPDATED', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET', 'ORDER_CART_LINE', 'CONFIRM_YES', 'ORDER_EXISTING_CONFIRM', 'UPSELL_TWO_BAGS']);
// Chữ ký câu bot đang giữ giỏ (có dấu hoặc bỏ dấu): "em vẫn đang giữ đơn…", "đơn của chị gồm…", "em ghi nhận đơn…".
const BASKET_SIGNATURE = /đang giữ đơn|dang giu don|đơn của .{0,40}?gồm|don cua .{0,40}?gom|ghi nhận đơn|ghi nhan don|xác nhận lại thông tin đặt hàng|xac nhan lai thong tin dat hang/i;
// Hạn giỏ = hạn runtime (pending-order.mjs, 24 giờ từ 03/10) — không để lệch giữa golden/huấn luyện và engine.
const BASKET_TTL_MIN = pendingOrderTtlMs / 60000;
const BASKET_ITEM_RE = /(\d{1,2})\s*(túi|gói|hộp|set|combo)\s*(xanh|vàng|nâu|cacao|vang|nau)?/giu;

const conversationIdOf = id => { const at = String(id || '').lastIndexOf(':'); return at > 0 ? String(id).slice(0, at) : ''; };

/**
 * Dựng các trường ngữ cảnh v2 còn thiếu cho từng mục golden. Không ghi đè trường đã có.
 * Các trường mô hình dùng (hasOrder/orderAgeMin, prevBotAsks, phoneInText, addressInText, bagCount) tính bằng
 * intentRowOf / orderContextOf của intent-features — MỘT định nghĩa với dữ liệu huấn luyện và engine.
 * - `store` = kho hội thoại ({ conversations, messages } như meta-conversations.json) hay null (không kho):
 *   hasOrder = có đơn CHƯA hủy đặt trước item.at trong 24 giờ (như engine), orderAgeMin = tuổi đơn chưa hủy gần nhất;
 *   tuổi câu bot trước lấy từ tin outgoing gần nhất trước item.at. Không có kho → không có đơn; câu bot trước coi như vừa gửi.
 * - pendingOrder không lưu lịch sử → hasBasket suy từ lastTemplate ∈ bước đơn hoặc prevBot khớp chữ ký giỏ,
 *   và câu bot trước chưa quá hạn giỏ (pendingOrderTtlMs, 24 giờ); prevBotAsks đọc {missing} trong câu bot (không biết giỏ).
 * Trả về mảng mục mới (không sửa mảng vào).
 */
export function enrichGoldenContext(items = [], store = null) {
  const conversations = new Map((Array.isArray(store?.conversations) ? store.conversations : []).map(item => [item.id, item]));
  const messagesOf = id => (Array.isArray(store?.messages?.[id]) ? store.messages[id] : []);
  return (Array.isArray(items) ? items : []).map(item => {
    const out = { ...item };
    const at = Number(item.at) || 0;
    const conversationId = conversationIdOf(item.id);
    const conversation = conversations.get(conversationId) || (at ? [...conversations.values()].find(entry => messagesOf(entry.id).some(message => message?.direction === 'incoming' && Number(message.createdAt) === at)) : null);
    const messages = conversation ? messagesOf(conversation.id) : [];
    const previousOut = at ? messages.filter(message => message?.direction === 'outgoing' && Number(message.createdAt) < at).sort((a, b) => b.createdAt - a.createdAt)[0] : null;
    const prevBotAgeMin = previousOut ? (at - Number(previousOut.createdAt)) / 60000 : 0;
    const prevBot = String(item.prevBot || previousOut?.text || '');
    const lastTemplate = String(item.lastTemplate || '');
    if (out.hasBasket === undefined) out.hasBasket = prevBotAgeMin < BASKET_TTL_MIN && (basketStepTemplates.has(lastTemplate) || BASKET_SIGNATURE.test(prevBot));
    if (out.basketItems === undefined) out.basketItems = out.hasBasket ? [...prevBot.matchAll(BASKET_ITEM_RE)].map(match => `${match[1]} ${match[2]}${match[3] ? ` ${match[3]}` : ''}`.toLowerCase()).slice(0, 12) : [];
    const orders = (Array.isArray(conversation?.customerOrders) ? conversation.customerOrders : []);
    const row = intentRowOf({ text: item.text, lastTemplateId: lastTemplate, prevBotText: prevBot, hasBasket: out.hasBasket, orders, now: at || Date.now() });
    if (out.prevBotAsks === undefined) out.prevBotAsks = row.prevBotAsks;
    if (out.hasOrder === undefined || out.orderAgeMin === undefined) {
      const order = at ? orderContextOf(orders, at) : { hasOrder: false, orderAgeMin: null };
      if (out.hasOrder === undefined) out.hasOrder = order.hasOrder;
      if (out.orderAgeMin === undefined) out.orderAgeMin = order.orderAgeMin;
    }
    if (out.phoneInText === undefined) out.phoneInText = row.phoneInText;
    if (out.addressInText === undefined) out.addressInText = row.addressInText;
    if (out.bagCount === undefined) out.bagCount = row.bagCount;
    return out;
  });
}
