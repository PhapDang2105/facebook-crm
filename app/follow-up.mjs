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
const outgoingOf = messages => messages.filter(message => message.direction === 'outgoing');

/**
 * Các ứng viên của một kịch bản: [{ key, conversation, inbox, thread, repliedAt }].
 * `inbox` là hộp thư của khách (có thể thiếu với khách chỉ bình luận),
 * `thread` là luồng bình luận (chỉ với comment-no-reply).
 */
export function findFollowUpCandidates(store, scenario, { now = Date.now(), activatedAt = 0 } = {}) {
  const delayMs = scenario.delayHours * 60 * 60 * 1000;
  const conversations = store.conversations || [];
  const messagesOf = conversation => (Array.isArray(store.messages?.[conversation.id]) ? store.messages[conversation.id] : []);
  const inboxOf = (pageId, psid) => conversations.find(item => item.pageId === pageId && item.psid === psid && item.source !== 'comment') || null;
  const blocked = inbox => inbox && (inbox.botEnabled === false || (Array.isArray(inbox.customerOrders) && inbox.customerOrders.length > 0));
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
export async function runFollowUps({ readSettings, sendMessage, now = Date.now(), log = console.log } = {}) {
  const settings = await readSettings();
  const summary = { checked: 0, sent: 0, failed: 0, skipped: 0, disabled: false };
  if (!settings?.enabled || !settings.followUps?.enabled) return { ...summary, disabled: true };
  const state = await readFollowUpState();
  if (!state.activatedAt) await updateFollowUpState(current => { current.activatedAt = now; return null; });
  const activatedAt = state.activatedAt || now;
  const store = await readMessagingStore();
  const maxPerRun = Math.max(1, Number(settings.followUps.maxPerRun) || 15);
  for (const scenario of settings.followUps.scenarios.filter(item => item.enabled)) {
    const template = followUpScenarioText(scenario, settings.messageTemplates);
    // Mẫu tin bị tắt trong Thiết lập tin nhắn: kịch bản đứng yên.
    if (!template) continue;
    // Kịch bản xét lùi N ngày (bám lại khách đã im từ trước lúc bật).
    const since = scenario.backlogDays ? Math.min(activatedAt, now - scenario.backlogDays * 24 * 60 * 60 * 1000) : activatedAt;
    // Khách im lâu nhất được gửi trước (sắp quá 7 ngày).
    const candidates = findFollowUpCandidates(store, scenario, { now, activatedAt: since }).sort((a, b) => a.repliedAt - b.repliedAt);
    for (const candidate of candidates) {
      summary.checked += 1;
      if (state.sent[candidate.key]) { summary.skipped += 1; continue; }
      const text = renderFollowUpMessage(template, candidate.conversation);
      // Ngoài 24 giờ API Pancake/Meta từ chối (#10): không gọi, xếp hàng chờ để
      // nhân viên gửi trong Pancake (extension Pancake gửi được ngoài 24 giờ).
      if (candidate.outsideWindow) {
        await updateFollowUpState(current => {
          current.sent[candidate.key] = { scenarioId: scenario.id, conversationId: candidate.conversation.id, name: candidate.conversation.name || '', at: now, repliedAt: candidate.repliedAt, queued: true, text, pageId: candidate.inbox.pageId, psid: candidate.inbox.psid };
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
    if (scenario.freeShipDays) target.promo = { freeShipping: true, until: now + scenario.freeShipDays * 24 * 60 * 60 * 1000, scenarioId: scenario.id, at: now };
    return null;
  });
  publishMessagingEvent({ type: 'customer-panel', conversationId });
}

const pancakeConversationUrl = (pageId, psid) => `https://pancake.vn/${encodeURIComponent(pageId)}?c=${encodeURIComponent(`${pageId}_${psid}`)}`;

/**
 * Hàng chờ gửi qua Pancake: tin bám đuổi ngoài 24 giờ chưa gửi. Khách đã lên
 * tiếng lại, đã có đơn hay nhân viên tắt bot sau lúc xếp hàng thì tự rơi khỏi
 * hàng (không cần nhắn nữa).
 */
export async function followUpQueue() {
  const state = await readFollowUpState();
  const store = await readMessagingStore();
  const byId = new Map((store.conversations || []).map(item => [item.id, item]));
  return Object.entries(state.sent)
    .filter(([, item]) => item.queued)
    .filter(([, item]) => {
      const conversation = byId.get(item.conversationId);
      if (!conversation || conversation.botEnabled === false || (Array.isArray(conversation.customerOrders) && conversation.customerOrders.length)) return false;
      const messages = Array.isArray(store.messages?.[conversation.id]) ? store.messages[conversation.id] : [];
      return !incomingOf(messages).some(message => Number(message.createdAt) > item.at);
    })
    .map(([key, item]) => ({ key, conversationId: item.conversationId, name: item.name, at: item.at, repliedAt: item.repliedAt, scenarioId: item.scenarioId, text: item.text, pancakeUrl: pancakeConversationUrl(item.pageId, item.psid) }))
    .sort((first, second) => first.repliedAt - second.repliedAt);
}

/**
 * Nhân viên xử lý một tin trong hàng chờ: `sent` (đã gửi trong Pancake → gắn
 * thẻ, ghi ưu đãi) hay `skip` (bỏ qua khách này). Trả về false khi không còn trong hàng.
 */
export async function resolveFollowUpQueueItem(key, action, { readSettings, now = Date.now() } = {}) {
  const item = await updateFollowUpState(current => {
    const entry = current.sent[key];
    if (!entry?.queued) return null;
    delete entry.queued;
    if (action === 'sent') { entry.via = 'pancake'; entry.sentAt = now; } else entry.error = 'nhân viên bỏ qua';
    return { ...entry };
  });
  if (!item) return false;
  if (action === 'sent') {
    const settings = readSettings ? await readSettings() : null;
    const scenario = settings?.followUps?.scenarios?.find(entry => entry.id === item.scenarioId) || { id: item.scenarioId };
    await markConversationFollowedUp(item.conversationId, scenario, 'pancake', now);
  }
  return true;
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
  return { activatedAt: state.activatedAt || 0, lastRunAt: state.lastRunAt || 0, lastRun: state.lastRun, sentTotal: done.length, recent: recent.filter(item => !item.queued), queue: await followUpQueue() };
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
