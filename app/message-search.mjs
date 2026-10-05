// 05/10 (chủ shop: "Chức năng tìm kiếm chưa tìm được số điện thoại hay tin nhắn cũ"): tìm trên TOÀN BỘ kho hội thoại —
// tên khách, SĐT (trong tin nhắn, đơn của hội thoại, giỏ đang chờ, hồ sơ khách nhân viên sửa) và nội dung tin nhắn
// (bỏ dấu, không phân biệt hoa thường). Trước đây ô "Tìm kiếm…" chỉ lọc chữ đang hiện ở dòng danh sách (tên + tin cuối).
//
// Chỉ mục trong bộ nhớ, dựng LƯỜI ở lần tìm đầu và soát lại mỗi lần tìm theo từng hội thoại: mảng tin đổi (tham chiếu,
// độ dài, tin cuối) hay thông tin hội thoại đổi (tên, SĐT đơn/giỏ) thì dựng lại riêng hội thoại đó. Kho đọc lại từ đĩa
// (đối tượng kho mới) thì mọi mục tự lệch tham chiếu và được dựng lại. Mỗi hội thoại giữ MỘT chuỗi đã bỏ dấu ghép mọi
// tin (cách nhau bằng \u0001) cùng vị trí bắt đầu từng tin → tìm chữ là một lần lastIndexOf (tin mới nhất khớp trước).
import { messagingStoreVersion, readMessagingStore } from './messaging-store.mjs';
import { readCustomerEdits } from './customer-edits.mjs';

export const MAX_SEARCH_RESULTS = 50;
const SNIPPET_LENGTH = 120;
const SEPARATOR = '\u0001';
const MARKS = /[\u0300-\u036f]/g;

// Bảng gấp chữ cho từng mã UTF-16 (dựng một lần): "Ế" → "e", "đ" → "d", khoảng trắng → " ". Mã nào gấp ra
// không đúng MỘT ký tự thì giữ nguyên (chỉ hạ chữ thường nếu được) — độ dài luôn bằng bản gốc. Gấp từng mã qua bảng
// nhanh hơn normalize('NFD') ~20 lần (200.000 tin: ~0,9 giây → vài chục ms).
let foldTable = null;
function buildFoldTable() {
  const table = new Uint16Array(65536);
  for (let code = 0; code < 65536; code += 1) {
    table[code] = code;
    if (code >= 0xd800 && code <= 0xdfff) continue; // nửa cặp thay thế (emoji…): giữ nguyên
    const char = String.fromCharCode(code);
    if (code === 1) continue; // ký tự tách tin (SEPARATOR) giữ nguyên: truy vấn không bao giờ khớp vắt qua hai tin
    if (/\s/.test(char)) { table[code] = 32; continue; }
    let folded = char.normalize('NFD').replace(MARKS, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
    if (folded.length !== 1) folded = char.toLowerCase();
    if (folded.length === 1) table[code] = folded.charCodeAt(0);
  }
  return table;
}
const decoder = new TextDecoder('utf-16le');
function foldCodes(text) {
  foldTable ||= buildFoldTable();
  const length = text.length;
  if (!length) return '';
  const codes = new Uint16Array(length);
  for (let index = 0; index < length; index += 1) codes[index] = foldTable[text.charCodeAt(index)];
  return decoder.decode(codes);
}

/**
 * Bỏ dấu + chữ thường, GIỮ NGUYÊN độ dài so với bản NFC (để cắt đoạn trích đúng chỗ trên chữ gốc).
 * Trả { text: bản NFC gốc, folded }.
 */
export function foldAligned(value) {
  let text = String(value ?? '');
  // Chỉ chữ có dấu tổ hợp rời (gõ kiểu NFD) mới cần ghép về NFC; tin Messenger gần như luôn là NFC sẵn.
  if (/[\u0300-\u036f]/.test(text)) text = text.normalize('NFC');
  return { text, folded: foldCodes(text) };
}

/** Chữ người dùng gõ → dạng so khớp (bỏ dấu, thường, gộp khoảng trắng). */
export function foldQuery(value) {
  return foldAligned(value).folded.replace(/\s+/g, ' ').trim();
}

/** "0912.345.678", "+84 912 345 678", "0084912345678", "912345678" → "0912345678"; số ngắn giữ nguyên chữ số. */
export function normalizeSearchPhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('0084')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('84') && digits.length >= 11) digits = `0${digits.slice(2)}`;
  else if (digits.length === 9 && /^[35789]/.test(digits)) digits = `0${digits}`;
  return digits;
}

// SĐT trong một tin (viết liền, cách bằng dấu cách/chấm/gạch, +84/84/0): vị trí trong chữ gốc + dạng chuẩn.
const PHONE_IN_TEXT = /(?<!\d)(?:\+?84|0)(?:[ .-]?\d){8,9}(?!\d)/g;
function phonesIn(text) {
  const found = [];
  for (const match of String(text || '').matchAll(PHONE_IN_TEXT)) {
    const phone = normalizeSearchPhone(match[0]);
    if (phone.length >= 10 && phone.length <= 11) found.push({ phone, start: match.index, end: match.index + match[0].length });
  }
  return found;
}

const messageText = message => {
  if (!message || typeof message !== 'object') return '';
  const text = typeof message.text === 'string' ? message.text : '';
  if (text) return text;
  return message.type === 'document' && typeof message.name === 'string' ? message.name : '';
};

function conversationPhones(conversation) {
  const phones = [];
  for (const order of Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []) {
    const phone = normalizeSearchPhone(order?.phone);
    if (phone.length >= 9) phones.push({ phone, where: 'order', at: Number(order.createdAt) || 0 });
  }
  const pending = normalizeSearchPhone(conversation.pendingOrder?.phone);
  if (pending.length >= 9) phones.push({ phone: pending, where: 'pending', at: Number(conversation.pendingOrder?.at) || 0 });
  return phones;
}

const conversationSignature = conversation => `${conversation.name || ''}\u0002${conversationPhones(conversation).map(item => item.phone).join(',')}`;

function buildEntry(conversation, messages) {
  const list = Array.isArray(messages) ? messages : [];
  const starts = new Array(list.length);
  const parts = new Array(list.length);
  const messagePhones = [];
  let offset = 0;
  for (let index = 0; index < list.length; index += 1) {
    const raw = messageText(list[index]);
    const text = raw && /[\u0300-\u036f]/.test(raw) ? raw.normalize('NFC') : raw;
    starts[index] = offset;
    parts[index] = text;
    offset += text.length + 1;
    // Phải có ≥ 9 chữ số mới có thể là SĐT: bỏ qua phần lớn tin mà không chạy biểu thức.
    if (text && /\d/.test(text) && text.replace(/\D/g, '').length >= 9) {
      for (const hit of phonesIn(text)) messagePhones.push({ ...hit, index });
    }
  }
  const otherPhones = conversationPhones(conversation);
  const allPhones = [...new Set([...messagePhones.map(item => item.phone), ...otherPhones.map(item => item.phone)])];
  return {
    conversation,
    messages: list,
    count: list.length,
    last: list[list.length - 1] || null,
    signature: conversationSignature(conversation),
    name: foldQuery(conversation.name || ''),
    // Gấp cả hội thoại một lần (một Uint16Array), ký tự tách tin được giữ nguyên.
    blob: foldCodes(parts.join(SEPARATOR)),
    starts,
    messagePhones,
    otherPhones,
    phoneBlob: `|${allPhones.join('|')}|`
  };
}

const entryValid = (entry, conversation, messages) => entry
  && entry.conversation === conversation
  && entry.messages === (Array.isArray(messages) ? messages : entry.messages)
  && entry.count === (Array.isArray(messages) ? messages.length : 0)
  && entry.last === (Array.isArray(messages) ? messages[messages.length - 1] || null : null)
  && entry.signature === conversationSignature(conversation);

/** Chỉ mục: Map id → mục, cùng danh sách mục xếp hội thoại mới nhất trước. */
export function createSearchIndex() {
  return { store: null, version: -1, entries: new Map(), ordered: [], builds: 0 };
}

/** Soát chỉ mục với kho: dựng lại hội thoại đã đổi, bỏ hội thoại đã mất. Trả số hội thoại vừa dựng lại. */
export function refreshSearchIndex(index, store, version = 0) {
  const conversations = Array.isArray(store?.conversations) ? store.conversations : [];
  const messagesById = store?.messages && typeof store.messages === 'object' ? store.messages : {};
  let rebuilt = 0;
  const seen = new Set();
  for (const conversation of conversations) {
    if (!conversation?.id) continue;
    seen.add(conversation.id);
    const messages = messagesById[conversation.id];
    const current = index.entries.get(conversation.id);
    if (entryValid(current, conversation, messages)) continue;
    index.entries.set(conversation.id, buildEntry(conversation, messages));
    rebuilt += 1;
  }
  let removed = 0;
  for (const id of index.entries.keys()) if (!seen.has(id)) { index.entries.delete(id); removed += 1; }
  if (rebuilt || removed || index.store !== store || index.version !== version || index.ordered.length !== index.entries.size) {
    index.ordered = [...index.entries.values()].sort((first, second) => (Number(second.conversation.lastMessageAt) || 0) - (Number(first.conversation.lastMessageAt) || 0));
  }
  index.store = store;
  index.version = version;
  index.builds += rebuilt;
  return rebuilt;
}

/** Vị trí trong chuỗi ghép → số thứ tự tin (tìm nhị phân trên mảng vị trí bắt đầu). */
function messageAt(starts, position) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Đoạn trích ≤ 120 ký tự quanh [start, end) của chữ gốc, kèm vị trí tô đậm trong đoạn trích. */
export function makeSnippet(text, start, end, length = SNIPPET_LENGTH) {
  const source = String(text || '').replace(/\s/g, ' ');
  const matchLength = Math.max(0, end - start);
  if (source.length <= length) return { snippet: source, highlight: [start, end] };
  const room = Math.max(0, length - matchLength);
  let from = Math.max(0, start - Math.floor(room / 3));
  let to = Math.min(source.length, from + length);
  from = Math.max(0, to - length);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < source.length ? '…' : '';
  // Chừa chỗ cho dấu "…" để tổng không quá `length`.
  if (prefix) from += 1;
  if (suffix) to -= 1;
  const highlightStart = Math.max(0, start - from) + prefix.length;
  const highlightEnd = Math.min(to, end) - from + prefix.length;
  return { snippet: `${prefix}${source.slice(from, to)}${suffix}`, highlight: [highlightStart, Math.max(highlightStart, highlightEnd)] };
}

/** "0912345678" khớp truy vấn số: đuôi (≥ 4 số cuối) hay — truy vấn ≥ 7 số — nằm trong số. */
const phoneMatches = (phone, query) => phone.endsWith(query) || (query.length >= 7 && phone.includes(query));

/**
 * Chuẩn bị truy vấn. `phone` có khi chuỗi gõ chỉ gồm số và dấu cách/chấm/gạch/+/() với ≥ 4 chữ số.
 */
export function parseSearchQuery(raw) {
  const query = String(raw ?? '').slice(0, 100).trim();
  const compact = query.replace(/[\s.\-+()]/g, '');
  const phone = /^\d{4,}$/.test(compact) ? normalizeSearchPhone(compact) : '';
  return { query, text: foldQuery(query), phone };
}

/** Phần "hồ sơ khách" (customer-edits): SĐT nhân viên nhập theo khoá hội thoại `<pageId>:<psid>` hay theo SĐT gốc. */
function editPhoneMatchers(edits, phoneQuery) {
  const byConversation = new Map();
  const aliasOf = [];
  if (!phoneQuery || !edits || typeof edits !== 'object') return { byConversation, aliasOf };
  for (const [key, entry] of Object.entries(edits)) {
    const edited = normalizeSearchPhone(entry?.phone);
    if (edited.length < 9 || !phoneMatches(edited, phoneQuery)) continue;
    if (key.startsWith('phone:')) {
      const original = normalizeSearchPhone(key.slice(6));
      if (original && original !== edited) aliasOf.push({ original, edited });
    } else byConversation.set(key, edited);
  }
  return { byConversation, aliasOf };
}

/**
 * Tìm trên chỉ mục đã soát. Trả tối đa `limit` hội thoại (mới nhất trước), mỗi mục:
 * { id, name, channelId, psid, source, picture, lastMessageAt, matchedAt, snippet, highlight, messageId, position, reason, reasons }.
 * `position`: tin khớp là tin thứ mấy tính từ cuối (1 = tin mới nhất) — giao diện tải đủ tin để cuộn tới.
 */
export function searchIndex(index, rawQuery, { limit = MAX_SEARCH_RESULTS, edits = null } = {}) {
  const { text, phone } = parseSearchQuery(rawQuery);
  const max = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(limit) || MAX_SEARCH_RESULTS));
  if (!phone && text.length < 2) return [];
  const editMatchers = editPhoneMatchers(edits, phone);
  const results = [];
  for (const entry of index.ordered) {
    const conversation = entry.conversation;
    const reasons = [];
    let hit = null;
    // 1) SĐT: tin nhắn (tin mới nhất khớp) → đơn/giỏ của hội thoại → hồ sơ khách.
    if (phone) {
      let phoneHit = null;
      if (entry.phoneBlob.includes(phone)) {
        for (let item = entry.messagePhones.length - 1; item >= 0; item -= 1) {
          const candidate = entry.messagePhones[item];
          if (phoneMatches(candidate.phone, phone)) { phoneHit = { kind: 'message', ...candidate }; break; }
        }
        if (!phoneHit) {
          const other = entry.otherPhones.find(item => phoneMatches(item.phone, phone));
          if (other) phoneHit = { kind: other.where, phone: other.phone, at: other.at };
        }
      }
      if (!phoneHit) {
        const edited = editMatchers.byConversation.get(`${conversation.pageId}:${conversation.psid}`)
          || editMatchers.aliasOf.find(alias => entry.phoneBlob.includes(`|${alias.original}|`))?.edited;
        if (edited) phoneHit = { kind: 'profile', phone: edited, at: 0 };
      }
      if (phoneHit) {
        reasons.push('phone');
        if (phoneHit.kind === 'message') {
          const message = entry.messages[phoneHit.index];
          hit = { index: phoneHit.index, message, ...makeSnippet(foldAligned(messageText(message)).text, phoneHit.start, phoneHit.end) };
        } else {
          const label = phoneHit.kind === 'order' ? 'SĐT trong đơn' : phoneHit.kind === 'pending' ? 'SĐT trong giỏ đang chờ' : 'SĐT trong hồ sơ khách';
          const snippetText = `${label}: ${phoneHit.phone}`;
          hit = { index: -1, message: null, at: phoneHit.at, snippet: snippetText, highlight: [label.length + 2, snippetText.length] };
        }
      }
    }
    // 2) Nội dung tin nhắn (bỏ dấu).
    if (text.length >= 2) {
      const position = entry.blob.lastIndexOf(text);
      if (position >= 0) {
        reasons.push('message');
        if (!hit) {
          const messageIndex = messageAt(entry.starts, position);
          const message = entry.messages[messageIndex];
          const start = position - entry.starts[messageIndex];
          hit = { index: messageIndex, message, ...makeSnippet(foldAligned(messageText(message)).text, start, start + text.length) };
        }
      }
      // 3) Tên khách.
      if (entry.name.includes(text)) reasons.push('name');
    }
    if (!reasons.length) continue;
    const message = hit?.message || null;
    results.push({
      id: conversation.id,
      name: conversation.name || '',
      channelId: String(conversation.pageId || ''),
      psid: String(conversation.psid || ''),
      source: conversation.source || 'inbox',
      picture: conversation.picture || '',
      lastMessageAt: Number(conversation.lastMessageAt) || 0,
      matchedAt: message ? Number(message.createdAt) || 0 : Number(hit?.at) || Number(conversation.lastMessageAt) || 0,
      snippet: hit ? hit.snippet : String(conversation.lastMessagePreview || '').slice(0, SNIPPET_LENGTH),
      highlight: hit ? hit.highlight : null,
      messageId: message ? String(message.id || message.mid || '') : '',
      direction: message ? String(message.direction || '') : '',
      position: message ? entry.count - hit.index : 0,
      reason: reasons[0],
      reasons
    });
    if (results.length >= max) break;
  }
  return results;
}

// Chỉ mục dùng chung của tiến trình máy chủ.
const sharedIndex = createSearchIndex();

/** Đường của API: đọc kho (bộ nhớ đệm của messaging-store), soát chỉ mục, tìm. */
export async function searchConversations(rawQuery, { limit = MAX_SEARCH_RESULTS } = {}) {
  const store = await readMessagingStore();
  const startedAt = performance.now();
  refreshSearchIndex(sharedIndex, store, messagingStoreVersion());
  const { phone } = parseSearchQuery(rawQuery);
  // Hồ sơ khách chỉ cần khi tìm theo số; lỗi đọc kho sửa thông tin khách không làm hỏng lượt tìm.
  const edits = phone ? await readCustomerEdits().catch(() => null) : null;
  const items = searchIndex(sharedIndex, rawQuery, { limit, edits });
  return { items, tookMs: Math.round((performance.now() - startedAt) * 10) / 10 };
}
