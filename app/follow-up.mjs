// Bám đuổi: kịch bản chạy nền trong Cài đặt → Chatbot → Cấu hình chung.
//
// Khách bình luận (hay nhắn hộp thư), Page đã trả lời (bot hay nhân viên, từ CRM
// hay trong Pancake) mà khách im lặng quá N giờ thì gửi một tin theo kịch bản
// (ví dụ tặng miễn phí vận chuyển dùng thử). Luật an toàn:
// - chỉ xét lần trả lời của Page SAU khi tính năng được bật (không quét lại
//   khách cũ hàng tháng trước) và không quá 7 ngày;
// - mỗi khách mỗi kịch bản một lần, ghi ở data/processed/follow-ups.json;
// - nhân viên đã tắt bot cho hội thoại, hay khách đã có đơn, thì không bám;
// - khách bình luận: nhắn riêng vào hộp thư; không có hộp thư / gửi riêng lỗi
//   (ngoài cửa sổ 24 giờ) thì trả lời công khai dưới bình luận nếu kịch bản cho.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { readMessagingStore, updateMessagingStore } from './messaging-store.mjs';
import { publishMessagingEvent } from './message-events.mjs';
import { applyHonorific } from './chatbot-templates.mjs';
import { labelsForEvents, readInboxSettings } from './inbox-settings.mjs';

const statePath = process.env.FOLLOW_UPS_PATH || path.join(projectRoot, 'data', 'processed', 'follow-ups.json');
export const FOLLOW_UP_INTERVAL_MS = 15 * 60 * 1000;
const maxReplyAgeMs = 7 * 24 * 60 * 60 * 1000;
// Chừa 1 giờ trước hạn 24 giờ của Messenger (lượt bám đuổi chạy 15 phút một lần).
export const messengerWindowMs = 23 * 60 * 60 * 1000;
const maxSentRecords = 5000;

let cachedState = null;
let writeQueue = Promise.resolve();

function emptyState() {
  return { activatedAt: 0, sent: {}, lastRunAt: 0, lastRun: null };
}

export async function readFollowUpState() {
  if (cachedState) return cachedState;
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    cachedState = { ...emptyState(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    if (!cachedState.sent || typeof cachedState.sent !== 'object') cachedState.sent = {};
  } catch {
    cachedState = emptyState();
  }
  return cachedState;
}

function updateFollowUpState(mutate) {
  const operation = writeQueue.then(async () => {
    const state = await readFollowUpState();
    const result = await mutate(state);
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporary = `${statePath}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await rename(temporary, statePath);
    return result;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

const honorificOf = gender => (gender === 'male' ? 'anh' : gender === 'female' ? 'chị' : 'anh/chị');

/** Lời của kịch bản: mẫu FOLLOW_UP_… trong Thiết lập tin nhắn (rỗng = mẫu đã tắt), không có thì lời ghi thẳng trên kịch bản. */
export function followUpScenarioText(scenario, messageTemplates = {}) {
  if (scenario.templateId) return String(messageTemplates[scenario.templateId] || '').trim();
  return String(scenario.message || '').trim();
}

/** {title}/{Title}/{name} trong lời kịch bản, chọn ngẫu nhiên một biến thể "###", rồi sửa "anh/chị" theo giới tính đã biết. */
export function renderFollowUpMessage(template, conversation = {}, random = Math.random) {
  const title = honorificOf(conversation.gender);
  const variants = String(template || '').split('###').map(part => part.trim()).filter(Boolean);
  const chosen = variants.length ? variants[Math.min(variants.length - 1, Math.floor(random() * variants.length))] : '';
  const text = chosen
    .replace(/\{Title\}/g, title.charAt(0).toUpperCase() + title.slice(1))
    .replace(/\{title\}/g, title)
    .replace(/\{name\}/g, String(conversation.name || '').trim() || title);
  return applyHonorific(text, conversation.gender).trim();
}

const lastAt = (messages, predicate) => messages.reduce((latest, message) => (predicate(message) && Number(message.createdAt) > latest ? Number(message.createdAt) : latest), 0);
const incomingOf = messages => messages.filter(message => message.direction === 'incoming');
const compactText = text => String(text || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const outgoingOf = messages => messages.filter(message => message.direction === 'outgoing');

/**
 * Các ứng viên của một kịch bản: [{ key, conversation, inbox, thread, repliedAt }].
 * `inbox` là hộp thư của khách (có thể thiếu với khách chỉ bình luận),
 * `thread` là luồng bình luận (chỉ với comment-no-reply).
 */
export function findFollowUpCandidates(store, scenario, { now = Date.now(), activatedAt = 0, boughtLabelIds = ['customer'] } = {}) {
  const delayMs = scenario.delayHours * 60 * 60 * 1000;
  const conversations = store.conversations || [];
  const messagesOf = conversation => (Array.isArray(store.messages?.[conversation.id]) ? store.messages[conversation.id] : []);
  const inboxOf = (pageId, psid) => conversations.find(item => item.pageId === pageId && item.psid === psid && item.source !== 'comment') || null;
  // Nhân viên tắt bot, khách đã có đơn trong CRM hay mang thẻ Đã mua hàng: không bám (chỉ bám khách mới).
  const bought = conversation => (Array.isArray(conversation?.labels) ? conversation.labels : []).some(label => boughtLabelIds.includes(label));
  // Đã chốt đơn trong chat mà đơn không gắn vào hội thoại (nhân viên lên tay, đơn Shop/POS).
  const closedInChat = conversation => messagesOf(conversation).some(message => message.direction === 'outgoing' && /(xác nhận lại thông tin đặt hàng|đã gửi xác nhận đơn hàng|đơn của .{1,20} đã được (tạo|lên)|mã vận đơn)/i.test(String(message.text || '')));
  const blocked = inbox => inbox && (inbox.botEnabled === false || (Array.isArray(inbox.customerOrders) && inbox.customerOrders.length > 0) || bought(inbox) || closedInChat(inbox));
  const candidates = [];
  if (scenario.trigger === 'comment-no-reply') {
    for (const thread of conversations.filter(item => item.source === 'comment' && item.psid)) {
      const inbox = inboxOf(thread.pageId, thread.psid);
      if (blocked(inbox)) continue;
      const threadMessages = messagesOf(thread);
      const inboxMessages = inbox ? messagesOf(inbox) : [];
      // Page đã trả lời (công khai dưới bình luận hay nhắn riêng) — lần cuối.
      const repliedAt = Math.max(lastAt(outgoingOf(threadMessages), () => true), lastAt(outgoingOf(inboxMessages), message => message.privateReply === true));
      if (!repliedAt || repliedAt < activatedAt || now - repliedAt > maxReplyAgeMs || now - repliedAt < delayMs) continue;
      // Khách có lên tiếng sau đó (bình luận tiếp hay nhắn hộp thư) thì thôi.
      const customerAfter = Math.max(lastAt(incomingOf(threadMessages), () => true), lastAt(incomingOf(inboxMessages), () => true));
      if (customerAfter > repliedAt) continue;
      candidates.push({ key: `${scenario.id}:${thread.pageId}:${thread.psid}`, conversation: inbox || thread, inbox, thread, repliedAt });
    }
  } else {
    for (const inbox of conversations.filter(item => item.source !== 'comment' && item.psid)) {
      if (blocked(inbox)) continue;
      const messages = messagesOf(inbox);
      const customerAt = lastAt(incomingOf(messages), () => true);
      if (!customerAt) continue;
      const repliedAt = lastAt(outgoingOf(messages), message => message.privateReply !== true);
      if (!repliedAt || repliedAt < customerAt || repliedAt < activatedAt || now - repliedAt > maxReplyAgeMs || now - repliedAt < delayMs) continue;
      // Messenger chỉ cho Page nhắn trong 24 giờ kể từ tin cuối của khách: quá mốc
      // thì bỏ qua — trừ kịch bản "ngoài 24 giờ" (xếp hàng chờ gửi qua extension Pancake).
      const outside = now - customerAt > messengerWindowMs;
      if (outside && !scenario.outsideWindow) continue;
      candidates.push({ key: `${scenario.id}:${inbox.pageId}:${inbox.psid}`, conversation: inbox, inbox, thread: null, repliedAt, outsideWindow: outside });
    }
  }
  // Một khách có nhiều luồng bình luận: một lần thôi.
  const seen = new Set();
  return candidates.filter(item => !seen.has(item.key) && seen.add(item.key));
}

/**
 * Một lượt bám đuổi: duyệt mọi kịch bản đang bật, gửi cho khách đủ điều kiện,
 * ghi lại. Trả về { checked, sent, failed, skipped }.
 */
export async function runFollowUps({ readSettings, sendMessage, conversationInfo = null, now = Date.now(), log = console.log } = {}) {
  const settings = await readSettings();
  const summary = { checked: 0, sent: 0, failed: 0, skipped: 0, disabled: false };
  // Khách được bám đuổi đã chốt đơn: ghi nhận cả khi bám đuổi đang tắt.
  await markFollowUpWins(now).catch(error => log(`Bám đuổi: lỗi ghi nhận đơn chốt: ${error.message}`));
  if (!settings?.enabled || !settings.followUps?.enabled) return { ...summary, disabled: true };
  const state = await readFollowUpState();
  if (!state.activatedAt) await updateFollowUpState(current => { current.activatedAt = now; return null; });
  const activatedAt = state.activatedAt || now;
  // Tin trong hàng chờ mà nhân viên / trạm gửi Pancake đã gửi: xác nhận trước khi xét lượt mới.
  await reconcileFollowUpQueue(now, { readSettings });
  const pruned = await pruneReturningFromQueue({ conversationInfo, now }).catch(() => ({ removed: 0 }));
  if (pruned.removed) log(`Bám đuổi: bỏ ${pruned.removed} khách cũ khỏi hàng chờ`);
  const store = await readMessagingStore();
  const maxPerRun = Math.max(1, Number(settings.followUps.maxPerRun) || 15);
  for (const scenario of settings.followUps.scenarios.filter(item => item.enabled)) {
    const template = followUpScenarioText(scenario, settings.messageTemplates);
    // Mẫu tin bị tắt trong Thiết lập tin nhắn: kịch bản đứng yên.
    if (!template) continue;
    // Kịch bản xét lùi N ngày (bám lại khách đã im từ trước lúc bật).
    const since = scenario.backlogDays ? Math.min(activatedAt, now - scenario.backlogDays * 24 * 60 * 60 * 1000) : activatedAt;
    // Khách im lâu nhất được gửi trước (sắp quá 7 ngày).
    const boughtLabelIds = labelsForEvents((await readInboxSettings().catch(() => ({ labels: [] }))).labels, ['order', 'handoff', 'complaint', 'warranty', 'cancel', 'bad', 'followup-won']);
    const candidates = findFollowUpCandidates(store, scenario, { now, activatedAt: since, boughtLabelIds: boughtLabelIds.length ? boughtLabelIds : ['customer', 'consulting', 'complaint'] }).sort((a, b) => a.repliedAt - b.repliedAt);
    for (const candidate of candidates) {
      summary.checked += 1;
      if (state.sent[candidate.key]) { summary.skipped += 1; continue; }
      // Chỉ bám khách mới: tra Pancake/POS xem khách đã từng mua chưa (khách chỉ bình luận,
      // chưa có hộp thư thì không tra được). Tra lỗi thì để lượt sau, không gửi mù.
      if (conversationInfo && candidate.inbox) {
        let info;
        try {
          info = await conversationInfo(candidate.inbox.pageId, `${candidate.inbox.pageId}_${candidate.inbox.psid}`);
        } catch (error) {
          summary.deferred = (summary.deferred || 0) + 1;
          continue;
        }
        const returning = returningCustomerReason(info);
        if (returning) {
          await updateFollowUpState(current => {
            current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, error: returning, returning: true };
            return null;
          });
          summary.returning = (summary.returning || 0) + 1;
          continue;
        }
      }
      const text = renderFollowUpMessage(template, candidate.conversation);
      // Ngoài 24 giờ API Pancake/Meta từ chối (#10): không gọi, xếp hàng chờ để
      // nhân viên gửi trong Pancake (extension Pancake gửi được ngoài 24 giờ).
      if (candidate.outsideWindow) {
        await updateFollowUpState(current => {
          current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, queued: true, text, pageId: candidate.inbox.pageId, psid: candidate.inbox.psid, freeShipDays: scenario.freeShipDays || 0, ...(conversationInfo ? { checkedAt: now } : {}) };
          return null;
        });
        summary.queued = (summary.queued || 0) + 1;
        continue;
      }
      if (summary.sent + summary.failed >= maxPerRun) { summary.deferred = (summary.deferred || 0) + 1; continue; }
      let outcome = null;
      let error = '';
      // Nhắn riêng vào hộp thư trước; không có hộp thư hay gửi riêng lỗi thì trả lời công khai dưới bình luận (nếu cho).
      if (candidate.inbox) {
        try {
          const sent = await sendMessage(candidate.inbox, { text });
          outcome = { via: 'private', messageId: String(sent?.message?.mid || sent?.message?.id || '') };
        } catch (failure) {
          error = failure.message;
        }
      }
      if (!outcome && candidate.thread && scenario.publicFallback) {
        try {
          const sent = await sendMessage(candidate.thread, { text, privateReply: false });
          outcome = { via: 'public', messageId: String(sent?.message?.mid || sent?.message?.id || '') };
        } catch (failure) {
          error = failure.message;
        }
      }
      await updateFollowUpState(current => {
        current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, ...(outcome || { error: error || 'không có kênh gửi' }) };
        const keys = Object.keys(current.sent);
        if (keys.length > maxSentRecords) for (const key of keys.slice(0, keys.length - maxSentRecords)) delete current.sent[key];
        return null;
      });
      if (outcome) {
        summary.sent += 1;
        log(`Bám đuổi "${scenario.name}": đã gửi ${outcome.via === 'public' ? 'công khai' : 'riêng'} cho ${candidate.conversation.name || candidate.conversation.id}`);
        await markConversationFollowedUp(candidate.conversation.id, scenario, outcome.via, now);
      } else {
        summary.failed += 1;
        log(`Bám đuổi "${scenario.name}": không gửi được cho ${candidate.conversation.name || candidate.conversation.id}: ${error || 'không có kênh gửi'}`);
      }
    }
  }
  await updateFollowUpState(current => { current.lastRunAt = now; current.lastRun = summary; return null; });
  return summary;
}

/**
 * Tin bám đuổi đã tới khách: gắn thẻ "Bám đuổi" (thẻ nào nhận sự kiện followup
 * do Cài đặt → Tin nhắn quyết định), ghi lịch sử, và với kịch bản tặng miễn ship
 * thì ghi ưu đãi lên hội thoại để bot tính đúng khi khách đặt — không thì lời
 * mời miễn ship mà đơn vẫn cộng ship.
 */
async function markConversationFollowedUp(conversationId, scenario, via, now) {
  const followUpLabels = labelsForEvents((await readInboxSettings().catch(() => ({ labels: [] }))).labels, ['followup']);
  await updateMessagingStore(current => {
    const target = current.conversations.find(item => item.id === conversationId);
    if (!target) return null;
    if (followUpLabels.length) target.labels = [...new Set([...(Array.isArray(target.labels) ? target.labels : []), ...followUpLabels])];
    target.followUps = [...(Array.isArray(target.followUps) ? target.followUps : []), { scenarioId: scenario.id, at: now, via }].slice(-20);
    // Ưu đãi dùng thử mở luồng riêng (processing/trial-flow.mjs) từ bước 'offered'; giỏ cũ
    // bỏ đi để không trộn với ưu đãi 1 túi.
    if (scenario.freeShipDays) {
      target.promo = { freeShipping: true, until: now + scenario.freeShipDays * 24 * 60 * 60 * 1000, scenarioId: scenario.id, at: now, stage: 'offered' };
      target.pendingOrder = null;
    }
    return null;
  });
  publishMessagingEvent({ type: 'customer-panel', conversationId });
}

const foldText = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

/**
 * Bám đuổi chỉ dành cho khách MỚI. Lý do coi là khách cũ (rỗng = khách mới), từ
 * thông tin hội thoại tra lúc gửi: hồ sơ khách Pancake/POS (số đơn, tiền đã mua,
 * ngày mua cuối, thẻ), đơn gần đây của Pancake, lịch sử POS và bảng đơn CRM theo SĐT.
 */
export function returningCustomerReason(info = {}) {
  if (Number(info.orderCount) > 0 || Number(info.purchasedAmount) > 0 || info.lastOrderAt) return 'khách cũ: đã có đơn trên Pancake/POS';
  if (Number(info.recentOrders) > 0) return 'khách cũ: có đơn gần đây trên Pancake';
  if (Number(info.posOrders) > 0) return 'khách cũ: SĐT đã có đơn trên POS';
  if (Number(info.crmOrders) > 0) return 'khách cũ: SĐT đã có đơn trong CRM';
  if ((info.tags || []).some(tag => /(da mua|khach cu|khach quen|than thiet|\bvip\b|da gui)/.test(foldText(tag)))) return 'khách cũ: thẻ khách đã mua';
  return '';
}

const followUpWinWindowMs = 14 * 24 * 60 * 60 * 1000;

/**
 * Đơn chốt sau tin bám đuổi (bot, nhân viên hay Facebook Shop, trong 14 ngày
 * kể từ tin bám đuổi đầu tiên, đơn chưa hủy): gắn thẻ "Bám đuổi thành công" và
 * ghi followUpWon lên hội thoại để đếm. Trả về số hội thoại vừa ghi nhận.
 */
export async function markFollowUpWins(now = Date.now()) {
  const wonLabels = labelsForEvents((await readInboxSettings().catch(() => ({ labels: [] }))).labels, ['followup-won']);
  const won = await updateMessagingStore(store => {
    const changed = [];
    for (const conversation of store.conversations || []) {
      if (conversation.followUpWon || !Array.isArray(conversation.followUps) || !conversation.followUps.length) continue;
      const firstAt = Math.min(...conversation.followUps.map(item => Number(item.at) || Infinity));
      const order = (Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [])
        .filter(item => String(item.processingStatus || '') !== 'cancelled' && item.status !== 'Hủy')
        .filter(item => Number(item.createdAt) > firstAt && Number(item.createdAt) - firstAt <= followUpWinWindowMs)
        .sort((first, second) => Number(first.createdAt) - Number(second.createdAt))[0];
      if (!order) continue;
      conversation.followUpWon = { orderId: String(order.id), at: Number(order.createdAt), total: Number(order.total) || 0, markedAt: now };
      if (wonLabels.length) conversation.labels = [...new Set([...(Array.isArray(conversation.labels) ? conversation.labels : []), ...wonLabels])];
      changed.push(conversation.id);
    }
    return changed;
  });
  for (const conversationId of won || []) publishMessagingEvent({ type: 'customer-panel', conversationId });
  return (won || []).length;
}

const pancakeConversationUrl =(pageId, psid) => `https://pancake.vn/${encodeURIComponent(pageId)}?c=${encodeURIComponent(`${pageId}_${psid}`)}`;

// Một lô đã giao cho trạm gửi Pancake thì giữ chỗ 45 phút: lô sau không lấy lại
// cùng khách (gửi trùng) khi lô trước còn đang chạy hay chưa báo kết quả.
const batchLeaseMs = 45 * 60 * 1000;
const maxBatchSize = 50;
const maxRelayAttempts = 2;

// Thẻ mặc định không bám: Đã mua hàng, Cần người xử lý, Khiếu nại, Bảo hành, Hủy đơn, Khách xấu, Bám đuổi thành công.
const skipLabelIds = new Set(['customer', 'consulting', 'complaint', 'warranty', 'cancelled', 'bad', 'followup-won']);
const closedOrderText = /(xác nhận lại thông tin đặt hàng|đã gửi xác nhận đơn hàng|đơn của .{1,20} đã được (tạo|lên)|mã vận đơn)/i;

function stillWanted(item, byId, store) {
  const conversation = byId.get(item.conversationId);
  if (!conversation || conversation.botEnabled === false || (Array.isArray(conversation.customerOrders) && conversation.customerOrders.length)) return false;
  if ((Array.isArray(conversation.labels) ? conversation.labels : []).some(label => skipLabelIds.has(label))) return false;
  const messages = Array.isArray(store.messages?.[conversation.id]) ? store.messages[conversation.id] : [];
  if (outgoingOf(messages).some(message => closedOrderText.test(String(message.text || '')))) return false;
  return !incomingOf(messages).some(message => Number(message.createdAt) > item.at);
}

/**
 * Hàng chờ gửi qua Pancake: tin bám đuổi ngoài 24 giờ chưa gửi. Khách đã lên
 * tiếng lại, đã có đơn hay nhân viên tắt bot sau lúc xếp hàng thì tự rơi khỏi
 * hàng (không cần nhắn nữa). `leased` = đang nằm trong một lô chưa báo kết quả.
 */
export async function followUpQueue({ now = Date.now() } = {}) {
  const state = await readFollowUpState();
  const store = await readMessagingStore();
  const byId = new Map((store.conversations || []).map(item => [item.id, item]));
  return Object.entries(state.sent)
    .filter(([, item]) => item.queued && stillWanted(item, byId, store))
    .map(([key, item]) => ({ key, conversationId: item.conversationId, name: item.name, at: item.at, repliedAt: item.repliedAt, scenarioId: item.scenarioId, text: item.text, pageId: item.pageId, psid: item.psid, attempts: item.attempts || 0, lastError: item.lastError || (item.noGlobalId ? 'Pancake chưa có ID Facebook của khách — gửi tay bằng nút Mở Pancake' : ''), noGlobalId: item.noGlobalId === true, leased: Number(item.leasedUntil) > now, pancakeUrl: pancakeConversationUrl(item.pageId, item.psid) }))
    .sort((first, second) => first.repliedAt - second.repliedAt);
}

/**
 * Xử lý một tin trong hàng chờ: `sent` (đã gửi → gắn thẻ, ghi ưu đãi) hay
 * `skip` (bỏ qua khách này, kèm lý do). Trả về false khi không còn trong hàng.
 */
export async function resolveFollowUpQueueItem(key, action, { readSettings, now = Date.now(), reason = 'nhân viên bỏ qua', via = 'pancake' } = {}) {
  const item = await updateFollowUpState(current => {
    const entry = current.sent[key];
    if (!entry?.queued) return null;
    delete entry.queued;
    delete entry.leasedUntil;
    if (action === 'sent') { entry.via = via; entry.sentAt = now; delete entry.lastError; } else entry.error = reason;
    return { ...entry };
  });
  if (!item) return false;
  if (action === 'sent') {
    const settings = readSettings ? await readSettings() : null;
    const configured = settings?.followUps?.scenarios?.find(entry => entry.id === item.scenarioId);
    const scenario = { id: item.scenarioId, freeShipDays: configured?.freeShipDays || item.freeShipDays || 0 };
    await markConversationFollowedUp(item.conversationId, scenario, via, now);
  }
  return true;
}

/**
 * Tin trong hàng chờ đã tới khách mà chưa ai bấm "Đã gửi" (nhân viên gửi tay
 * trong Pancake, hay trạm gửi chưa kịp báo): Pancake đồng bộ tin của Page về
 * CRM, thấy tin gửi đi sau lúc xếp hàng thì xác nhận luôn.
 */
export async function reconcileFollowUpQueue(now = Date.now(), { readSettings } = {}) {
  const state = await readFollowUpState();
  const queued = Object.entries(state.sent).filter(([, item]) => item.queued);
  if (!queued.length) return 0;
  const store = await readMessagingStore();
  let confirmed = 0;
  for (const [key, item] of queued) {
    const messages = Array.isArray(store.messages?.[item.conversationId]) ? store.messages[item.conversationId] : [];
    // Chỉ tính đúng lời bám đuổi (so phần đầu), không tính tin khác nhân viên nhắn.
    const head = compactText(item.text).slice(0, 40);
    const sentAfter = head && outgoingOf(messages).some(message => Number(message.createdAt) > item.at && compactText(message.text).startsWith(head));
    if (sentAfter && await resolveFollowUpQueueItem(key, 'sent', { now, via: 'pancake', readSettings })) confirmed += 1;
  }
  return confirmed;
}

/**
 * Dọn hàng chờ: tra lại khách chưa được xét (xếp hàng từ bản cũ, chưa lọc khách
 * cũ), khách đã từng mua thì bỏ khỏi hàng. Mỗi lần tối đa `limit` khách.
 */
export async function pruneReturningFromQueue({ conversationInfo, limit = 40, now = Date.now() } = {}) {
  if (!conversationInfo) return { checked: 0, removed: 0 };
  const state = await readFollowUpState();
  const pending = Object.entries(state.sent).filter(([, item]) => item.queued && !item.checkedAt && item.pageId && item.psid).slice(0, limit);
  let removed = 0;
  let checked = 0;
  for (const [key, item] of pending) {
    let info;
    try {
      info = await conversationInfo(item.pageId, `${item.pageId}_${item.psid}`);
    } catch {
      continue;
    }
    checked += 1;
    const returning = returningCustomerReason(info);
    if (returning) {
      if (await resolveFollowUpQueueItem(key, 'skip', { now, reason: returning })) removed += 1;
      continue;
    }
    await updateFollowUpState(current => { if (current.sent[key]) current.sent[key].checkedAt = now; return null; });
  }
  return { checked, removed };
}

/**
 * Lô gửi cho trạm gửi Pancake (dấu trang chạy trên pancake.vn, đưa từng tin cho
 * extension Pancake). Mỗi khách hỏi lại Pancake ngay lúc này: khách đã có đơn
 * trên Pancake/POS thì bỏ khỏi hàng; lấy ID Facebook toàn cục mà extension cần.
 */
export async function buildFollowUpBatch({ limit = 30, conversationInfo, now = Date.now(), readSettings } = {}) {
  await reconcileFollowUpQueue(now, { readSettings });
  const size = Math.max(1, Math.min(maxBatchSize, Math.round(Number(limit) || 30)));
  const queue = (await followUpQueue({ now })).filter(item => !item.leased && !item.noGlobalId);
  const items = [];
  const skipped = [];
  for (const item of queue) {
    if (items.length >= size) break;
    const conversationId = `${item.pageId}_${item.psid}`;
    let info;
    try {
      info = await conversationInfo(item.pageId, conversationId);
    } catch (error) {
      skipped.push({ key: item.key, name: item.name, reason: `Pancake lỗi: ${error.message}` });
      continue;
    }
    const returning = returningCustomerReason(info);
    if (returning) {
      await resolveFollowUpQueueItem(item.key, 'skip', { now, reason: returning });
      skipped.push({ key: item.key, name: item.name, reason: 'khách cũ đã từng mua' });
      continue;
    }
    if (!info.canInbox) {
      await resolveFollowUpQueueItem(item.key, 'skip', { now, reason: 'khách không nhận tin (chặn Page)' });
      skipped.push({ key: item.key, name: item.name, reason: 'khách chặn tin' });
      continue;
    }
    if (!info.globalId) {
      // Pancake chưa lưu ID Facebook của khách (extension cần nó): khách vẫn ở hàng
      // chờ để nhân viên gửi tay trong Pancake (giao diện Pancake tự tìm ID), chỉ
      // không vào lô tự động nữa.
      await updateFollowUpState(current => { if (current.sent[item.key]) current.sent[item.key].noGlobalId = true; return null; });
      skipped.push({ key: item.key, name: item.name, reason: 'chưa có ID Facebook (gửi tay trong Pancake)' });
      continue;
    }
    items.push({ key: item.key, pageId: item.pageId, convId: conversationId, globalUserId: info.globalId, name: item.name, text: item.text });
  }
  const keys = new Set(items.map(item => item.key));
  if (keys.size) {
    await updateFollowUpState(current => {
      for (const key of keys) if (current.sent[key]) current.sent[key].leasedUntil = now + batchLeaseMs;
      return null;
    });
  }
  return { kind: 'GIOTNANG_FOLLOWUP', version: 1, createdAt: now, delayMs: [15000, 30000], items, skipped, remaining: Math.max(0, queue.length - items.length - skipped.length) };
}

/**
 * Kết quả trạm gửi báo về: tin gửi được thì xác nhận (thẻ + ưu đãi); lỗi thì trả
 * lại hàng chờ, lỗi quá 2 lần thì thôi (ghi lỗi để nhân viên xem).
 */
export async function recordFollowUpBatchResults(results = [], { now = Date.now(), readSettings } = {}) {
  const summary = { sent: 0, failed: 0, dropped: 0 };
  for (const result of Array.isArray(results) ? results : []) {
    const key = String(result?.key || '');
    if (!key) continue;
    if (result.ok) {
      if (await resolveFollowUpQueueItem(key, 'sent', { now, via: 'pancake-relay', readSettings })) summary.sent += 1;
      continue;
    }
    const error = String(result.error || 'không rõ lỗi').slice(0, 200);
    const dropped = await updateFollowUpState(current => {
      const entry = current.sent[key];
      if (!entry?.queued) return null;
      delete entry.leasedUntil;
      entry.attempts = (entry.attempts || 0) + 1;
      entry.lastError = error;
      if (entry.attempts < maxRelayAttempts) return false;
      delete entry.queued;
      entry.error = `trạm gửi Pancake lỗi ${entry.attempts} lần: ${error}`;
      return true;
    });
    if (dropped === null) continue;
    summary.failed += 1;
    if (dropped) summary.dropped += 1;
  }
  return summary;
}

/**
 * Bật lại bám đuổi (tắt → bật): mốc tính lại từ lúc này, để không gửi dồn cho
 * mọi khách cũ đã im lặng trong 7 ngày lúc tính năng còn tắt.
 */
export async function resetFollowUpActivation(now = Date.now()) {
  await updateFollowUpState(state => { state.activatedAt = now; return null; });
}

/** Tóm tắt cho màn cài đặt: đã bật từ khi nào, lần chạy cuối, các lần gửi gần nhất. */
export async function followUpStatus() {
  const state = await readFollowUpState();
  const recent = Object.values(state.sent).sort((first, second) => second.at - first.at).slice(0, 20);
  const done = Object.values(state.sent).filter(item => !item.error && !item.queued);
  const won = ((await readMessagingStore()).conversations || []).filter(item => item.followUpWon);
  return {
    wonTotal: won.length,
    wonAmount: won.reduce((sum, item) => sum + (Number(item.followUpWon.total) || 0), 0), activatedAt: state.activatedAt || 0, lastRunAt: state.lastRunAt || 0, lastRun: state.lastRun, sentTotal: done.length, recent: recent.filter(item => !item.queued), queue: await followUpQueue() };
}

let timer = null;
/** Chạy sau 30 giây rồi mỗi 15 phút; lượt trước chưa xong thì bỏ qua lượt sau. */
export function startFollowUpLoop(dependencies) {
  if (timer) return () => clearInterval(timer);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runFollowUps(dependencies);
      if (summary.sent || summary.failed) (dependencies.log || console.log)(`Bám đuổi: xét ${summary.checked}, gửi ${summary.sent}, lỗi ${summary.failed}`);
    } catch (error) {
      (dependencies.log || console.log)(`Bám đuổi lỗi: ${error.message}`);
    } finally {
      running = false;
    }
  };
  setTimeout(run, 30000);
  timer = setInterval(run, FOLLOW_UP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
