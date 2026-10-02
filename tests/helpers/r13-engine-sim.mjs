// Bộ mô phỏng nhỏ cho test vòng 13 của engine (tests/r13-engine-*.test.mjs): một "kho" hội thoại + tin trong bộ nhớ,
// chạy processChatbotChanges thật với mẫu seed + lời dự phòng của engine. Không gọi mạng, không ghi đĩa.
import './seed-catalog.mjs';
import { processChatbotChanges, withFallbackTemplates } from '../../app/chatbot-engine.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../../app/chatbot-templates.mjs';

export const seedTemplates = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
export const templates = withFallbackTemplates(seedTemplates);
export const PAGE = 'page';
export const XANH = quantity => ({ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity });
export const VANG = quantity => ({ product: 'Granola Túi Vàng 350g', code: 'GRA-VANG-H350', quantity });
export const NAU = quantity => ({ product: 'Granola Túi Nâu vị cacao 350g', code: 'GRA-NAU-Z350', quantity });
export const basket = (items, agoMs = 30000, extra = {}) => ({ items, key: items.map(item => `${item.code}=${item.quantity}`).sort().join('|'), at: Date.now() - agoMs, phone: '', address: '', addressAsks: 0, ...extra });
// Số giả cho test (đầu số hợp lệ), không phải số khách thật.
export const PHONE = '0912345678';
const settle = () => new Promise(resolve => setImmediate(resolve));
let counter = 0;

export class Sim {
  constructor({ settings = {}, psid = 'user' } = {}) {
    this.psid = psid;
    this.inboxId = `${PAGE}:${psid}`;
    this.conversations = new Map();
    this.messages = new Map();
    this.records = [];
    this.settings = {
      enabled: true, autoOrder: true, responseMode: 'automatic', handoffKeywords: '', complaintKeywords: '', fragmentWaitMs: 0, phoneFragmentWaitMs: 0,
      messageTemplates: seedTemplates, ruleIntent: 'on', experimentalRules: 'on', preGuard: 'off', intentModel: 'off', intentCascade: 'off', addressAi: false,
      commentHide: 'phone', commentLike: true, ...settings
    };
  }

  /** Hộp thư của khách (tạo nếu chưa có). */
  inbox(extra = {}) {
    return this.conversation(this.inboxId, { source: 'inbox', ...extra });
  }

  /** Luồng bình luận của khách dưới một bài (mặc định bài thường). */
  comment(extra = {}, key = 'c1') {
    const id = `${PAGE}:comment:${this.psid}:${key}`;
    return this.conversation(id, { source: 'comment', lastCommentId: `${key}-last`, post: { id: `post-${key}`, message: 'Granola Giọt Nắng giòn rụm' }, ...extra });
  }

  conversation(id, extra = {}) {
    const existing = this.conversations.get(id);
    if (existing) { Object.assign(existing, extra); return existing; }
    const created = { id, pageId: PAGE, psid: this.psid, name: 'Khách', botEnabled: true, labels: [], ...extra };
    this.conversations.set(id, created);
    if (!this.messages.has(id)) this.messages.set(id, []);
    return created;
  }

  list(id) {
    if (!this.messages.has(id)) this.messages.set(id, []);
    return this.messages.get(id);
  }

  /** Thêm một tin cũ vào lịch sử (agoMs trước bây giờ). */
  history(conversation, direction, text, agoMs, extra = {}) {
    const message = { id: `h-${++counter}`, mid: `h-${counter}`, direction, type: 'text', text, createdAt: Date.now() - agoMs, ...extra };
    this.list(conversation.id).push(message);
    this.list(conversation.id).sort((a, b) => a.createdAt - b.createdAt);
    return message;
  }

  dependencies({ llm = null, extra = {} } = {}) {
    const turn = { sent: [], saved: [], asked: [], created: [], notes: [], moderated: [] };
    const self = this;
    const deps = {
      readSettings: async () => self.settings,
      listMessages: async id => [...self.list(id)],
      getConversation: async id => self.conversations.get(id) || null,
      saveBotState: async (id, { addLabelEvents = [], ...state }) => {
        turn.saved.push({ id, state: { ...state, ...(addLabelEvents.length ? { addLabelEvents } : {}) } });
        const target = self.conversations.get(id);
        if (!target) return null;
        Object.assign(target, state);
        target.labels = [...new Set([...(target.labels || []), ...addLabelEvents])];
        return target;
      },
      sendMessage: async (conversation, payload) => {
        const privateReply = conversation.source === 'comment' && payload.privateReply === true;
        const targetId = privateReply ? self.inboxId : conversation.id;
        if (privateReply) self.inbox();
        const text = payload.text || `[ảnh ${payload.imageUrls?.length || 1}]`;
        const message = { id: `o-${++counter}`, mid: `o-${counter}`, direction: 'outgoing', type: payload.text ? 'text' : 'image', text, sender: 'bot', createdAt: Date.now(), ...(privateReply ? { privateReply: true } : {}) };
        self.list(targetId).push(message);
        turn.sent.push({ to: conversation.id, text, privateReply, ...(payload.imageUrls ? { imageUrls: payload.imageUrls } : {}) });
        return { message };
      },
      createOrder: async (conversation, order) => {
        const record = { id: `ord-${++counter}`, createdAt: Date.now(), phone: order.phone, address: order.address, total: order.total, gift: order.gift || '', products: (order.items || []).map(item => ({ name: item.product, sku: item.code, quantity: item.quantity })), status: 'Mới' };
        turn.created.push(order);
        const target = self.conversations.get(conversation.id) || conversation;
        target.customerOrders = [...(target.customerOrders || []), record];
        return { order: record, created: true };
      },
      updateOrder: async (_conversation, id, order) => { turn.created.push({ update: id, ...order }); return { order: { id, ...order }, updated: true }; },
      cancelOrder: async (_conversation, id) => ({ cancelled: true, order: { id } }),
      addOrderNote: async (_conversation, orderId, note) => { turn.notes.push({ orderId, note }); return { noted: true }; },
      moderateComment: async (_conversation, message, options) => { turn.moderated.push({ id: message?.id, ...options }); },
      requestReply: async payload => {
        turn.asked.push(payload);
        const answer = typeof llm === 'function' ? llm(payload, turn.asked.length) : llm;
        if (!answer) return { templateId: 'GENERAL_INFO', messages: ['[mô hình được gọi]'], handoff: false };
        return answer.template_id ? renderChatbotReply(answer, templates, payload.context || {}) : answer;
      },
      appendDecisionLog: record => { self.records.push(record); },
      ...extra
    };
    return { deps, turn };
  }

  /**
   * Khách gửi một tin vào `conversation` rồi chạy bot. Tuỳ chọn: `llm` (JSON mô hình hay hàm), `type`, `message` (trường
   * thêm của tin), `change` (trường thêm của change: late…), `at` (giờ tin), `extra` (dependencies thêm), `store: false`
   * (tin đã có sẵn trong lịch sử — truyền `existing`).
   */
  async send(conversation, text, { llm = null, type = 'text', message = {}, change = {}, extra = {}, existing = null } = {}) {
    const incoming = existing || { id: `m-${++counter}`, mid: `m-${counter}`, direction: 'incoming', type, text, createdAt: Date.now(), ...message };
    if (!existing) this.list(conversation.id).push(incoming);
    const { deps, turn } = this.dependencies({ llm, extra });
    const results = await processChatbotChanges([{ type: 'message', conversation: { ...conversation }, message: incoming, ...change }], deps);
    await settle();
    return { result: results[0] || {}, results, ...turn, record: this.records.at(-1) || null, incoming };
  }
}
