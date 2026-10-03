import { stat } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { readJsonFile, writeJsonAtomic } from './json-store.mjs';
import { GENDER_SOURCE_RANK, genderFromName } from './processing/customer-info.mjs';

// META_CONVERSATIONS_PATH lets the integration test run without touching real customer data.
const messagingStorePath = process.env.META_CONVERSATIONS_PATH
  || path.join(projectRoot, 'data', 'processed', 'meta-conversations.json');
const maximumMessagesPerConversation = 500;

let cachedStore = null;
let writeQueue = Promise.resolve();

function emptyStore() {
  return { conversations: [], messages: {}, commentIndex: {} };
}

// Order confirmations recorded before the Messenger receipt template existed were
// stored either as the long plain-text confirmation or, for the template echo, as
// the generic "unsupported attachment" label. Both describe an order the timeline
// already draws as a card, so they are retagged once when the store is loaded.
const legacyReceiptAttachmentText = 'Đã gửi một tệp đính kèm chưa hỗ trợ';
const legacyReceiptTextPrefix = 'XÁC NHẬN ĐƠN ĐẶT HÀNG GIỌT NẮNG #';
const receiptPreview = 'Đã gửi xác nhận đơn hàng';

function isLegacyReceiptText(value) {
  const text = String(value || '');
  return text === legacyReceiptAttachmentText || text.startsWith(legacyReceiptTextPrefix);
}

function migrateLegacyReceipts(store) {
  for (const list of Object.values(store.messages)) {
    if (!Array.isArray(list)) continue;
    for (const message of list) {
      if (message?.direction !== 'outgoing' || !isLegacyReceiptText(message.text)) continue;
      message.type = 'order-receipt';
      message.text = receiptPreview;
    }
  }
  for (const conversation of store.conversations) {
    if (conversation?.lastMessageDirection !== 'outgoing') continue;
    if (isLegacyReceiptText(conversation.lastMessagePreview)) conversation.lastMessagePreview = receiptPreview;
  }
  return store;
}

function normalizeStore(value) {
  if (!value || typeof value !== 'object') return emptyStore();
  const store = migrateLegacyReceipts({
    conversations: Array.isArray(value.conversations) ? value.conversations : [],
    messages: value.messages && typeof value.messages === 'object' && !Array.isArray(value.messages) ? value.messages : {},
    // comment id → conversation id, so the Page's own replies (which arrive
    // with only a parent id) and later edits find their thread.
    commentIndex: value.commentIndex && typeof value.commentIndex === 'object' ? value.commentIndex : {}
  });
  pruneCommentIndex(store);
  // Hội thoại chưa có giới tính: đoán theo tên (bảng tên riêng mới rộng hơn
  // "Thị/Văn"), rồi dồn giới tính tốt nhất của cùng một khách cho mọi luồng.
  for (const conversation of store.conversations) {
    if (conversation && !conversation.gender) applyGenderGuess(conversation, genderFromName(conversation.name), 'name');
  }
  reconcileAllCustomerGenders(store);
  return store;
}

/**
 * reconcileCustomerGender cho cả kho trong một lượt: gom luồng theo (pageId, psid) MỘT lần thay vì lọc lại
 * cả mảng cho từng hội thoại (O(n²): ~225 ms mỗi lần nạp kho 2.200 hội thoại). Map lồng nhau giữ đúng phép
 * so === của bản cũ ("123" và 123 là hai khách). Kết quả như gọi reconcileCustomerGender cho từng hội thoại:
 * applyGenderGuess chỉ ghi khi nguồn mạnh hơn hẳn nên chạy lại trên cùng nhóm không đổi gì thêm.
 */
export function reconcileAllCustomerGenders(store) {
  const groups = new Map();
  for (const conversation of store.conversations) {
    if (!conversation?.psid) continue;
    let byPsid = groups.get(conversation.pageId);
    if (!byPsid) groups.set(conversation.pageId, byPsid = new Map());
    const siblings = byPsid.get(conversation.psid);
    if (siblings) siblings.push(conversation);
    else byPsid.set(conversation.psid, [conversation]);
  }
  const changed = [];
  for (const byPsid of groups.values()) {
    for (const siblings of byPsid.values()) {
      if (siblings.length < 2) continue;
      const best = siblings.filter(item => item.gender).sort((first, second) => (genderRank[second.genderSource] || 0) - (genderRank[first.genderSource] || 0))[0];
      if (!best) continue;
      for (const item of siblings) if (item !== best && applyGenderGuess(item, best.gender, best.genderSource)) changed.push(item);
    }
  }
  return changed;
}

/**
 * Một khách có nhiều luồng (hộp thư + từng bài bình luận): giới tính tin cậy
 * nhất trong các luồng đó (nhân viên chọn > Pancake > xưng hô > tên) áp cho
 * mọi luồng còn lại. Trả về các hội thoại vừa đổi.
 */
export function reconcileCustomerGender(store, conversation) {
  if (!conversation?.psid) return [];
  const siblings = store.conversations.filter(item => item.pageId === conversation.pageId && item.psid === conversation.psid);
  if (siblings.length < 2) return [];
  const best = siblings.filter(item => item.gender).sort((first, second) => (genderRank[second.genderSource] || 0) - (genderRank[first.genderSource] || 0))[0];
  if (!best) return [];
  return siblings.filter(item => item !== best && applyGenderGuess(item, best.gender, best.genderSource));
}

// Chỉ số bình luận chỉ có ghi thêm; bỏ mục trỏ tới luồng không còn hay bình luận
// đã bị cắt khỏi 500 tin cuối, để tệp kho không phình mãi.
function pruneCommentIndex(store) {
  const keptIds = new Map();
  for (const [id, list] of Object.entries(store.messages)) {
    if (Array.isArray(list)) keptIds.set(id, new Set(list.map(item => item?.commentId || item?.id)));
  }
  for (const [commentId, conversationId] of Object.entries(store.commentIndex)) {
    const ids = keptIds.get(conversationId);
    if (!ids || !ids.has(commentId)) delete store.commentIndex[commentId];
  }
  return store;
}

export function conversationId(pageId, psid) {
  return `${pageId}:${psid}`;
}

/**
 * A comment thread is one conversation per person per post — the way an inbox
 * thread is one per person — so replies land in context and the bot answers
 * the comment it was asked under.
 */
export function commentConversationId(pageId, userId, postId) {
  return `${pageId}:comment:${userId}:${postId}`;
}

// Mốc sửa của tệp lúc đọc/ghi gần nhất: tệp bị tiến trình khác ghi (script
// bảo trì, tiến trình thứ hai) thì đọc lại thay vì ghi đè bằng bản cũ trong bộ nhớ.
let cachedStoreMtimeMs = 0;
async function storeMtimeMs() {
  try {
    return (await stat(messagingStorePath)).mtimeMs;
  } catch {
    return 0;
  }
}

// ===== Gộp ghi =====
//
// Kho ~19 MB trên production: trước đây MỖI lần sửa (mỗi hội thoại của một lượt đồng bộ Pancake,
// mỗi webhook) là một lần JSON.stringify + ghi cả tệp, chặn vòng lặp sự kiện hàng trăm lần mỗi
// lượt. Giờ: sửa chạy tuần tự trong bộ nhớ (như cũ), còn ghi đĩa thì
//  - một lần ghi tại một thời điểm (tệp tạm rồi rename nguyên tử; JSON gọn từ 01/10);
//  - các lần sửa trong lúc đang ghi được gộp vào MỘT lần ghi kế tiếp;
//  - `defer: true` (đường đồng bộ): trả về ngay sau khi sửa bộ nhớ, ghi gộp sau ~1 giây
//    (chậm nhất 5 giây), hay khi flushMessagingStore() được gọi (cuối lượt đồng bộ, lúc tắt);
//  - không có gì đổi (mutationVersion không tăng) thì không ghi.
// Lời gọi thường (không defer) vẫn chỉ trả về khi thay đổi của nó đã nằm trên đĩa.
let mutationVersion = 0;
let writtenVersion = 0;
let activeWrite = null;
let flushTimer = null;
let pendingSince = 0;
const flushDelayMs = Math.max(0, Number(process.env.MESSAGING_STORE_FLUSH_MS) || 1000);
const flushMaxWaitMs = 5000;
// Mốc sửa do chính tiến trình này ghi/nạp (vài mốc gần nhất): lượt stat chạy song song với một lần
// ghi có thể thấy mốc cũ hay mốc mới — cả hai đều không phải "tiến trình khác vừa ghi".
const knownMtimes = [];
function rememberMtime(mtime) {
  if (!mtime) return;
  knownMtimes.push(mtime);
  if (knownMtimes.length > 8) knownMtimes.shift();
}
const isForeignMtime = mtime => Boolean(mtime) && mtime !== cachedStoreMtimeMs && !knownMtimes.includes(mtime);

/** Còn thay đổi trong bộ nhớ chưa ghi xuống đĩa? */
export function messagingStoreHasPendingWrites() {
  return writtenVersion < mutationVersion;
}

let loadingStore = null;
export async function readMessagingStore() {
  // Đang ghi: tệp đổi mốc là do chính mình, bộ nhớ là bản mới nhất.
  if (cachedStore && !activeWrite) {
    const mtime = await storeMtimeMs();
    if (cachedStore && !activeWrite && mtime !== cachedStoreMtimeMs) {
      if (!mtime) {
        // Tệp biến mất: còn thay đổi chưa ghi thì giữ bộ nhớ (lần ghi tới tạo lại tệp), không thì kho rỗng như cũ.
        if (!messagingStoreHasPendingWrites()) cachedStore = null;
      } else if (isForeignMtime(mtime)) {
        // Tiến trình khác (script bảo trì) ghi tệp: bản trên đĩa thắng, như trước đây.
        if (messagingStoreHasPendingWrites()) {
          console.warn('Kho hội thoại bị tiến trình khác ghi trong lúc còn thay đổi chưa ghi: đọc lại tệp, bỏ thay đổi trong bộ nhớ.');
          writtenVersion = mutationVersion;
        }
        cachedStore = null;
      }
    }
  }
  if (cachedStore) return cachedStore;
  // Nhiều lượt đọc cùng lúc lúc khởi động dùng chung một lần nạp, để không có
  // hai bản kho song song (bản ghi sau đè bản ghi trước).
  if (!loadingStore) {
    loadingStore = (async () => {
      // Chưa có tệp (lần chạy đầu) → kho rỗng. JSON hỏng (cắt dở, sửa tay) → cất sang .corrupt-* rồi kho rỗng,
      // để lượt ghi kế tiếp không đè mất bản hỏng. Lỗi đọc tạm (EACCES, EBUSY, EMFILE…) → NÉM (01/10): coi là
      // kho rỗng thì lần ghi sau xoá sạch tệp thật đang lành (app/json-store.mjs).
      const store = await readJsonFile(messagingStorePath, { fallback: emptyStore, expect: 'any', normalize: normalizeStore, label: 'Kho hội thoại' });
      cachedStoreMtimeMs = await storeMtimeMs();
      rememberMtime(cachedStoreMtimeMs);
      cachedStore = store;
      return store;
    })().finally(() => { loadingStore = null; });
  }
  return loadingStore;
}

/** Một lần ghi: bản chụp của kho trong bộ nhớ (JSON đồng bộ, nhất quán) → tệp tạm → fsync → rename nguyên tử. */
async function writeSnapshot() {
  const before = await storeMtimeMs();
  if (!cachedStore) {
    // Bộ nhớ đã bị bỏ (đọc lại tệp): không còn gì để ghi.
    writtenVersion = mutationVersion;
    return;
  }
  if (isForeignMtime(before)) {
    // Tiến trình khác vừa ghi tệp mà chưa ai đọc lại: tệp thắng (như đường đọc), không ghi đè.
    if (messagingStoreHasPendingWrites()) console.warn('Kho hội thoại bị tiến trình khác ghi: bỏ thay đổi trong bộ nhớ chưa ghi, đọc lại tệp.');
    cachedStore = null;
    writtenVersion = mutationVersion;
    return;
  }
  const version = mutationVersion;
  // JSON gọn (01/10, không thụt dòng): kho ~19 MB → ~14 MB, stringify nhanh hơn ~20%. Mọi nơi đọc đều
  // JSON.parse; công thức sed bảo trì (integrations/meta/README.md) đã sửa để khớp cả hai định dạng.
  const text = JSON.stringify(cachedStore);
  // Tệp tạm riêng theo tiến trình + fsync trước rename (app/json-store.mjs): script bảo trì chạy song song
  // không dẫm cùng tệp .tmp, mất điện giữa chừng không để lại tệp kho rỗng/cụt.
  await writeJsonAtomic(messagingStorePath, null, { text });
  cachedStoreMtimeMs = await storeMtimeMs();
  rememberMtime(cachedStoreMtimeMs);
  writtenVersion = Math.max(writtenVersion, version);
}

/**
 * Ghi xuống đĩa mọi thay đổi đã có tới lúc gọi (gộp với lần ghi đang chạy nếu có). Không có gì
 * mới thì không ghi. Lỗi ghi ném ra cho người gọi.
 */
export async function flushMessagingStore() {
  const target = mutationVersion;
  while (writtenVersion < target) {
    if (activeWrite) {
      await activeWrite.catch(() => {});
      continue;
    }
    activeWrite = writeSnapshot().finally(() => { activeWrite = null; });
    await activeWrite;
  }
}

function scheduleFlush(delayMs = flushDelayMs) {
  const now = Date.now();
  if (!pendingSince) pendingSince = now;
  if (flushTimer) clearTimeout(flushTimer);
  const delay = Math.max(0, Math.min(delayMs, pendingSince + flushMaxWaitMs - now));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    pendingSince = 0;
    flushMessagingStore().catch(error => {
      console.error(`Không ghi được kho hội thoại (sẽ thử lại): ${error.message}`);
      scheduleFlush(5000);
    });
  }, delay);
  // Không giữ tiến trình sống chỉ vì hẹn ghi; lúc tắt có flush riêng (beforeExit / SIGTERM).
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Sửa kho tuần tự (webhook dồn dập không đè nhau). `mutate(store)` sửa tại chỗ và trả kết quả.
 * Tuỳ chọn:
 *  - `defer: true`: trả về ngay khi bộ nhớ đã sửa, ghi đĩa gộp sau (đường đồng bộ lịch sử);
 *  - `unchanged(result)`: trả true khi mutate không đổi gì → không đánh dấu cần ghi.
 */
export function updateMessagingStore(mutate, { defer = false, unchanged = null } = {}) {
  const mutation = writeQueue.then(async () => {
    const store = await readMessagingStore();
    let result;
    try {
      result = await mutate(store);
    } catch (error) {
      // Sửa dở giữa chừng: không còn gì chưa ghi thì bỏ bản trong bộ nhớ, lần sau đọc lại từ tệp
      // đã ghi tốt (như trước). Còn thay đổi của lời gọi khác chưa ghi thì giữ, kẻo mất tin khách.
      if (!messagingStoreHasPendingWrites() && !activeWrite) cachedStore = null;
      throw error;
    }
    if (typeof unchanged === 'function' && unchanged(result)) return { result, changed: false };
    // Trong lúc mutate còn chờ, một lượt đọc thường có thể đã nạp lại tệp (mốc sửa đổi bên
    // ngoài) vào cache; bản vừa sửa mới là sự thật, kẻo lượt ghi sau đè mất.
    cachedStore = store;
    mutationVersion += 1;
    return { result, changed: true };
  });
  writeQueue = mutation.then(() => undefined, () => undefined);
  return mutation.then(async ({ result, changed }) => {
    if (changed) {
      if (defer) scheduleFlush();
      else await flushMessagingStore();
    }
    return result;
  });
}

let exitFlushTried = false;
process.on('beforeExit', () => {
  if (exitFlushTried || !messagingStoreHasPendingWrites()) return;
  exitFlushTried = true;
  flushMessagingStore().catch(error => console.error(`Không ghi được kho hội thoại lúc thoát: ${error.message}`));
});

/**
 * Lúc tắt (C5): chờ các lượt sửa đang xếp hàng chạy xong (kể cả lượt chúng xếp thêm), rồi ghi tới khi không còn
 * thay đổi nào chưa ghi. Trước đây chỉ ghi các thay đổi có tới lúc gọi: lượt sửa đến sau (webhook vừa nhận) mất.
 */
export async function drainMessagingStore({ rounds = 5 } = {}) {
  for (let round = 0; round < rounds; round += 1) {
    const queued = writeQueue;
    await queued;
    await flushMessagingStore();
    if (queued === writeQueue && !messagingStoreHasPendingWrites()) return;
  }
}

let shutdownInstalled = false;
/**
 * Tắt tiến trình (systemd gửi SIGTERM khi restart/deploy): ghi nốt thay đổi còn trong bộ nhớ rồi
 * mới thoát (chờ tối đa `timeoutMs`). Gọi một lần từ server.mjs.
 * `prepare` chỉ được tối đa `prepareTimeoutMs` (R1-04): quá thì bỏ chờ và ghi kho hội thoại luôn — kho này
 * (vài chục MB, nhiều lượt ghi gộp: mốc bám đuổi, báo vận đơn…) quan trọng hơn các việc dọn dẹp trong prepare.
 * `timeoutMs` 30 giây: còn xa dưới hạn dừng mặc định 90 giây của systemd (deploy/facebook-crm.service).
 */
export function installMessagingStoreShutdownFlush({ signals = ['SIGTERM', 'SIGINT'], timeoutMs = 30000, prepareTimeoutMs = 4000, exit = code => process.exit(code), prepare = null } = {}) {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  let stopping = false;
  for (const signal of signals) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      const timer = setTimeout(() => {
        console.error('Hết giờ chờ ghi kho hội thoại lúc tắt, thoát.');
        exit(1);
      }, timeoutMs);
      // `prepare` (server.mjs): ngừng nhận request, chờ các kho nhỏ ghi xong… — lỗi ở đó không chặn việc ghi kho này.
      let prepareTimer = null;
      const prepareDeadline = new Promise(resolve => {
        prepareTimer = setTimeout(() => {
          console.error('Chuẩn bị tắt quá lâu, bỏ chờ và ghi kho hội thoại.');
          resolve();
        }, prepareTimeoutMs);
      });
      Promise.resolve()
        .then(() => Promise.race([Promise.resolve(typeof prepare === 'function' ? prepare() : undefined), prepareDeadline]))
        .catch(error => console.error(`Lỗi khi chuẩn bị tắt: ${error?.message || error}`))
        .finally(() => clearTimeout(prepareTimer))
        .then(() => drainMessagingStore())
        .then(() => exit(0), error => {
          console.error(`Không ghi được kho hội thoại lúc tắt: ${error.message}`);
          exit(1);
        })
        .finally(() => clearTimeout(timer));
    });
  }
}

export function messagePreview(message) {
  if (!message) return '';
  if (message.type === 'order-receipt') return receiptPreview;
  if (message.type === 'image') return message.text ? `Ảnh · ${message.text}` : 'Đã gửi một ảnh';
  if (message.type === 'video') return message.text ? `Video · ${message.text}` : 'Đã gửi một video';
  if (message.type === 'audio') return 'Đã gửi một tin nhắn thoại';
  if (message.type === 'document') return message.name ? `Tài liệu · ${message.name}` : 'Đã gửi một tài liệu';
  return message.text || '';
}

function findConversation(store, id) {
  return store.conversations.find(item => item.id === id) || null;
}

function isPlaceholderName(name) {
  return /^Khách Facebook \d*$/.test(String(name || ''));
}

export function ensureConversation(store, { pageId, psid, name, picture, id: explicitId, source = 'inbox', post }) {
  const id = explicitId || conversationId(pageId, psid);
  let conversation = findConversation(store, id);
  if (!conversation) {
    conversation = {
      id,
      pageId: String(pageId),
      psid: String(psid),
      name: name || `Khách Facebook ${String(psid).slice(-4)}`,
      picture: picture || '',
      source,
      ...(post ? { post } : {}),
      unread: false,
      muted: false,
      labels: [],
      lastMessageAt: 0,
      lastMessagePreview: '',
      lastMessageDirection: '',
      lastCustomerMessageAt: 0,
      createdAt: Date.now()
    };
    store.conversations.push(conversation);
    store.messages[id] = [];
  }
  // Tên giữ chỗ ("Khách Facebook 1234", do Graph không trả tên) không được đè
  // lên tên thật đã tra được hay Pancake đã biết.
  if (name && conversation.name !== name && !(isPlaceholderName(name) && conversation.name && !isPlaceholderName(conversation.name))) conversation.name = name;
  if (picture) conversation.picture = picture;
  if (!Array.isArray(store.messages[id])) store.messages[id] = [];
  return conversation;
}

function applyLatestMessage(conversation, messages, saved) {
  const latest = messages.at(-1);
  if (!latest) return;
  conversation.lastMessageAt = latest.createdAt;
  conversation.lastMessagePreview = messagePreview(latest);
  conversation.lastMessageDirection = latest.direction;
  // Tin khách tới muộn (webhook lệch thứ tự, đồng bộ lịch sử) vẫn mở cửa sổ
  // trả lời 24h, dù tin mới nhất trong luồng là của Page.
  for (const item of [latest, saved]) {
    if (item?.direction === 'incoming') conversation.lastCustomerMessageAt = Math.max(conversation.lastCustomerMessageAt || 0, Number(item.createdAt) || 0);
  }
}

const statusRank = { sent: 0, received: 0, delivered: 1, read: 2 };

function placeSorted(messages, message) {
  const position = messages.findIndex(item => item.createdAt > message.createdAt);
  if (position < 0) messages.push(message);
  else messages.splice(position, 0, message);
}

function insertMessage(messages, message) {
  const existingIndex = messages.findIndex(item => (message.mid && item.mid === message.mid) || item.id === message.id);
  if (existingIndex >= 0) {
    const existing = messages[existingIndex];
    const merged = { ...existing, ...message };
    // Cờ nhân viên gửi (từ CRM) không bị bản dội về của Pancake/Meta (không biết ai gửi) xóa mất.
    if (existing.staff && !message.staff) { merged.staff = true; if (existing.staffName && !message.staffName) merged.staffName = existing.staffName; }
    // Tin gửi từ CRM đã biết đích danh người gửi (staffUsername): bản dội về mang tên tài khoản
    // Pancake chung không được đè họ tên nhân viên.
    if (existing.staffUsername) Object.assign(merged, { staffName: existing.staffName, staffUsername: existing.staffUsername, ...(existing.staff ? { staff: true } : {}) });
    // Ai gửi (sender 'bot' / 'staff') là của CRM lúc gửi: bản dội về không biết nên không đổi.
    if (existing.sender) merged.sender = existing.sender;
    // Bản dội về (echo) không hạ trạng thái đã giao/đã đọc xuống "sent".
    if ((statusRank[existing.status] ?? 0) > (statusRank[merged.status] ?? 0)) merged.status = existing.status;
    if (merged.createdAt === existing.createdAt) {
      messages[existingIndex] = merged;
    } else {
      // Mốc giờ đổi (giờ máy → giờ Meta): đặt lại đúng chỗ để tin cuối vẫn là tin mới nhất.
      messages.splice(existingIndex, 1);
      placeSorted(messages, merged);
    }
    return { message: merged, inserted: false };
  }
  placeSorted(messages, message);
  if (messages.length > maximumMessagesPerConversation) messages.splice(0, messages.length - maximumMessagesPerConversation);
  // Tin cũ hơn cả cửa sổ đang giữ thì bị cắt ngay: không coi là đã chèn.
  return { message, inserted: messages.includes(message) };
}

/**
 * Trường ghi lên tin nhân viên gửi từ CRM. `staff`: true (cũ: chỉ biết "nhân viên", tên 'CRM')
 * hoặc { name, username } của người gửi (nhật ký hoạt động) → staffName = họ tên, staffUsername.
 */
export function staffMessageFields(staff) {
  if (!staff) return {};
  if (typeof staff !== 'object') return { staff: true, staffName: 'CRM' };
  const username = String(staff.username || '').trim().slice(0, 32);
  const name = String(staff.name || '').replace(/\s+/g, ' ').trim().slice(0, 80) || username || 'CRM';
  return { staff: true, staffName: name, ...(username ? { staffUsername: username } : {}) };
}

/**
 * Dấu người gửi ghi lên MỌI tin CRM gửi đi (giao diện hiện "Chatbot · giờ" hay tên nhân viên):
 * - nhân viên gửi từ CRM (`staff`): sender 'staff' + staff/staffName/staffUsername (staffMessageFields);
 * - việc máy làm thay nhân viên (`sentBy` { name, username }: phiếu đơn của đơn tạo tay, nút
 *   "Gửi lại phiếu"): sender 'staff' + staffName/staffUsername nhưng KHÔNG cờ staff (bot không nhường);
 * - còn lại (chatbot trả lời, bám đuổi, chào QR, phiếu đơn bot): sender 'bot'.
 */
export function messageSenderFields({ staff = false, sentBy = null } = {}) {
  if (staff) return { ...staffMessageFields(staff), sender: 'staff' };
  if (sentBy && typeof sentBy === 'object' && (sentBy.name || sentBy.username)) {
    const { staffName, staffUsername } = staffMessageFields(sentBy);
    return { sender: 'staff', staffName, ...(staffUsername ? { staffUsername } : {}) };
  }
  return { sender: 'bot' };
}

/** Adds a message and returns the updated conversation plus whether it was new. */
export function saveMessage(store, { pageId, psid, name, picture, message, markUnread = false, id, source, post }) {
  const conversation = ensureConversation(store, { pageId, psid, name, picture, id, source, post });
  const messages = store.messages[conversation.id];
  const { message: saved, inserted } = insertMessage(messages, message);
  applyLatestMessage(conversation, messages, inserted ? saved : null);
  if (inserted) {
    const at = Number(saved.createdAt) || 0;
    if (saved.direction === 'outgoing') {
      // Page (bot hay nhân viên) vừa trả lời và đó là tin mới nhất: không còn gì chờ đọc.
      const newerCustomer = messages.some(item => item !== saved && item.direction !== 'outgoing' && (Number(item.createdAt) || 0) > at);
      if (!newerCustomer) conversation.unread = false;
    } else if (markUnread) {
      // Tin khách kéo về muộn (đồng bộ lịch sử) mà Page đã trả lời sau đó rồi
      // thì không đánh dấu chưa đọc; chỉ tin khách đứng sau lời Page mới cần.
      const answered = messages.some(item => item.direction === 'outgoing' && (Number(item.createdAt) || 0) > at);
      if (!answered) conversation.unread = true;
    }
  }
  return { conversation, message: saved, inserted };
}

export function updateMessageStatus(store, { conversationId: id, mid, status, error = '' }) {
  const messages = store.messages[id];
  if (!Array.isArray(messages)) return null;
  const message = messages.find(item => item.mid === mid || item.id === mid);
  if (!message) return null;
  message.status = status;
  if (error) message.error = error;
  else delete message.error;
  return message;
}

/** Marks every outgoing message up to `until` (and any listed in `mids`) as delivered or read. */
export function markOutgoingStatusUntil(store, { conversationId: id, until, status, mids = [] }) {
  const messages = store.messages[id];
  if (!Array.isArray(messages)) return 0;
  const ranking = { sent: 0, delivered: 1, read: 2 };
  const listed = new Set(Array.isArray(mids) ? mids : []);
  let changed = 0;
  for (const message of messages) {
    if (message.direction !== 'outgoing') continue;
    if (message.createdAt > until && !listed.has(message.mid) && !listed.has(message.id)) continue;
    if ((ranking[message.status] ?? 0) >= ranking[status]) continue;
    message.status = status;
    changed += 1;
  }
  return changed;
}

export function publicConversation(conversation) {
  // Messenger allows replies for 24 hours after the customer's last message;
  // a comment can be answered any time.
  const replyWindowEndsAt = conversation.source === 'comment'
    ? Number.MAX_SAFE_INTEGER
    : conversation.lastCustomerMessageAt ? conversation.lastCustomerMessageAt + 24 * 60 * 60 * 1000 : 0;
  return {
    id: conversation.id,
    channelId: conversation.pageId,
    psid: conversation.psid,
    name: conversation.name,
    picture: conversation.picture || '',
    source: conversation.source || 'inbox',
    ...(conversation.gender ? { gender: conversation.gender, genderSource: conversation.genderSource || '' } : {}),
    // Comment threads: which post, and the latest customer comment to reply under.
    ...(conversation.post ? { post: conversation.post } : {}),
    ...(conversation.lastCommentId ? { lastCommentId: conversation.lastCommentId } : {}),
    // The ad the customer arrived from, when Messenger told us.
    ...(conversation.referral?.adTitle || conversation.referral?.adId ? { ad: { id: conversation.referral.adId || '', title: conversation.referral.adTitle || '' } } : {}),
    unread: Boolean(conversation.unread),
    muted: Boolean(conversation.muted),
    labels: Array.isArray(conversation.labels) ? conversation.labels : [],
    lastMessageAt: conversation.lastMessageAt || 0,
    lastMessagePreview: conversation.lastMessagePreview || '',
    lastMessageDirection: conversation.lastMessageDirection || '',
    replyWindowEndsAt,
    canReply: replyWindowEndsAt > Date.now(),
    // Ai đã xem hội thoại (như "Thúy Hằng đã xem • 16:28" của Pancake): { [username]: { name, at } }.
    ...(conversation.seenBy && typeof conversation.seenBy === 'object' && Object.keys(conversation.seenBy).length ? { seenBy: conversation.seenBy } : {})
  };
}

export async function listConversations(pageId) {
  const store = await readMessagingStore();
  return store.conversations
    .filter(conversation => !pageId || conversation.pageId === String(pageId))
    .sort((first, second) => (second.lastMessageAt || 0) - (first.lastMessageAt || 0))
    .map(publicConversation);
}

export async function getConversation(id) {
  const store = await readMessagingStore();
  return findConversation(store, id);
}

export async function listMessages(id, limit = 100) {
  const store = await readMessagingStore();
  const messages = store.messages[id];
  return Array.isArray(messages) ? messages.slice(-limit) : [];
}

// Trust order of gender sources; a guess never overwrites a stronger one.
// Vòng 12 (GENDER_SOURCE_RANK): nhân viên chọn tay (3) > khách tự xưng trong tin (2.7: "Lấy chị 1 túi")
// > hồ sơ Pancake (2.5) > đoán theo tên (1). Trước đây Pancake thắng lời khách tự xưng.
export const genderRank = GENDER_SOURCE_RANK;

/** Records a guessed gender unless a more trusted source already set one. */
export function applyGenderGuess(conversation, gender, source) {
  if (!conversation || !gender) return false;
  if ((genderRank[conversation.genderSource] || 0) >= (genderRank[source] || 0) && conversation.gender) return false;
  conversation.gender = gender;
  conversation.genderSource = source;
  return true;
}

export const maximumSeenByPerConversation = 30;

/**
 * Người dùng CRM (đã đăng nhập) vừa mở / đánh dấu đã đọc hội thoại: seenBy[username] = { name, at }.
 * Giữ tối đa 30 người, bỏ người xem lâu nhất. Trả hội thoại đã đổi, null khi không có hội thoại
 * hay thiếu tên đăng nhập (CRM chưa bật đăng nhập thì không ghi).
 */
export function markConversationSeen(store, id, { username, name = '', at = Date.now() } = {}) {
  const key = String(username || '').trim().toLowerCase().slice(0, 32);
  if (!key) return null;
  const conversation = findConversation(store, id);
  if (!conversation) return null;
  const seenBy = conversation.seenBy && typeof conversation.seenBy === 'object' && !Array.isArray(conversation.seenBy)
    ? Object.assign(Object.create(null), conversation.seenBy)
    : Object.create(null);
  seenBy[key] = { name: String(name || key).replace(/\s+/g, ' ').trim().slice(0, 80), at: Number(at) || Date.now() };
  const entries = Object.entries(seenBy).sort((first, second) => (Number(second[1]?.at) || 0) - (Number(first[1]?.at) || 0)).slice(0, maximumSeenByPerConversation);
  conversation.seenBy = Object.fromEntries(entries);
  return conversation;
}

export const maximumLabelsPerConversation = 20;

/**
 * R13 (M4): bộ thẻ nhân viên gửi lên cho một hội thoại → chỉ chuỗi (≤ 60 ký tự), bỏ trùng, tối đa 20 thẻ.
 * `allowedIds` (Set mã thẻ trong Cài đặt → Tin nhắn; null = không kiểm): mã LẠ chỉ được giữ khi hội thoại ĐANG
 * mang nó (`current`) — thẻ hệ thống tự gắn (Đã mua hàng, Số điện thoại, thẻ bot) hay thẻ cũ đã xoá khỏi Cài đặt
 * không bị rơi khi nhân viên bật/tắt một thẻ khác; thẻ đang có không bao giờ bị cắt vì vượt trần.
 * Trước đây `labels: [{a:1}, 12345, "x"×5000, null]` được lưu nguyên.
 */
export function sanitizeConversationLabels(labels, { current = [], allowedIds = null } = {}) {
  const existing = new Set((Array.isArray(current) ? current : []).filter(label => typeof label === 'string'));
  const allowed = allowedIds ? new Set(allowedIds) : null;
  const kept = [];
  const seen = new Set();
  for (const item of Array.isArray(labels) ? labels : []) {
    if (typeof item !== 'string') continue;
    const label = item.trim();
    if (!label || label.length > 60 || seen.has(label)) continue;
    if (allowed && !allowed.has(label) && !existing.has(label)) continue;
    seen.add(label);
    kept.push(label);
  }
  if (kept.length <= maximumLabelsPerConversation) return kept;
  // Vượt trần: giữ thẻ đang có trước, phần còn lại theo thứ tự gửi lên.
  const held = kept.filter(label => existing.has(label));
  const fresh = kept.filter(label => !existing.has(label)).slice(0, Math.max(0, maximumLabelsPerConversation - held.length));
  const keep = new Set([...held, ...fresh]);
  return kept.filter(label => keep.has(label));
}

export function setConversationFlags(store, id, changes, { allowedLabelIds = null } = {}) {
  const conversation = findConversation(store, id);
  if (!conversation) return null;
  if (typeof changes.unread === 'boolean') conversation.unread = changes.unread;
  if (typeof changes.muted === 'boolean') conversation.muted = changes.muted;
  if (Array.isArray(changes.labels)) conversation.labels = sanitizeConversationLabels(changes.labels, { current: conversation.labels, allowedIds: allowedLabelIds });
  return conversation;
}
