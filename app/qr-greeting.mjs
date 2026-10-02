// Chào khách vừa quét mã QR thẻ cảm ơn (tách khỏi server.mjs để test được).
//
// Khách quét → mở m.me?ref=<mã> → về CRM theo một trong ba đường:
//  - Meta bắn `messaging_referrals`/postback kèm ref (Page nối app Meta);
//  - Botcake (bot của Pancake) tự chào, tin của Page mang "Mã thẻ: #mã" dội về
//    qua webhook Pancake (`type: BOTCAKE_OPTIN`);
//  - khách gửi tin soạn sẵn mang "#mã" (`type: PREFILL_TEXT`).
// Ba đường có thể về cùng một lượt quét, thứ tự không đoán được. Quy tắc:
// CRM chỉ chào khi chưa ai chào; hẹn giờ vài giây rồi mới gửi, và trong lúc
// chờ mà Botcake đã chào thì HỦY hẹn — không thì khách nhận hai tin ưu đãi
// giống nhau cách nhau mười giây.
import { qrCodeFromRef } from './qr-bridge.mjs';
import { isKnownQrCode } from './qr-scans.mjs';

/**
 * Khách đến từ phiếu cảm ơn (link m.me), phân biệt với khách bấm quảng cáo.
 * Mã phải là mã đã tạo ở Cài đặt → Mã QR (có trong kho): "#123456" khách gõ
 * trong tin thường không phải mã thẻ.
 */
export function isCardScan(change, { known = isKnownQrCode } = {}) {
  return change?.referral?.source === 'SHORTLINK' && known(qrCodeFromRef(change.referral.ref));
}

/**
 * Vì sao một change CÓ referral lại không được coi là lượt quét thẻ ('' = là lượt quét, hoặc không có
 * referral). Dùng để ghi log: trước đây referral về mà bị bỏ thì im lặng, không phân biệt được
 * "Meta không gửi" với "gửi mà CRM bỏ".
 */
export function cardScanSkipReason(change, { known = isKnownQrCode } = {}) {
  const referral = change?.referral;
  if (!referral) return '';
  if (referral.source !== 'SHORTLINK') return `nguồn ${referral.source || 'trống'}, không phải link m.me (SHORTLINK)`;
  if (!String(referral.ref || '').trim()) return 'referral không mang ref';
  const code = qrCodeFromRef(referral.ref);
  if (!code) return 'ref không phải dạng mã thẻ';
  if (!known(code)) return `mã "${code}" chưa tạo ở Cài đặt → Mã QR`;
  return '';
}

/**
 * Trả quyền giữ luồng về app mặc định của Page sau khi CRM xử lý xong một sự kiện Meta (xem
 * releaseThreadControl ở meta-graph.mjs). `shouldRelease(change)` quyết định có trả hay không (nơi gọi
 * truyền: chỉ Page vận hành ở Pancake, sự kiện ở `messaging` chứ không phải standby). Lỗi bị nuốt và ghi
 * log — CRM không giữ luồng thì Meta trả lỗi, chuyện bình thường khi chưa bật định tuyến liên kết; cùng
 * một lý do lỗi chỉ ghi một dòng mỗi `errorLogWindowMs`.
 */
export function createThreadReleaser({
  release,
  getToken,
  shouldRelease = () => true,
  errorLogWindowMs = 10 * 60 * 1000,
  now = Date.now,
  log = console.log,
  logError = console.error
} = {}) {
  const errorLoggedAt = new Map();
  // Dòng "đã trả luồng" chỉ ghi lần thành công ĐẦU của mỗi hội thoại (để chủ shop kiểm trên máy chủ mà
  // không ngập log); giữ tối đa 5000 hội thoại gần nhất.
  const releasedOnce = new Set();
  return async function releaseThread(change) {
    const conversation = change?.conversation;
    if (!conversation?.psid || !conversation.pageId || !shouldRelease(change)) return false;
    const label = conversation.name || conversation.id;
    try {
      await release({ pageId: conversation.pageId, psid: conversation.psid, pageAccessToken: await getToken(conversation.pageId), metadata: 'crm-qr' });
      if (!releasedOnce.has(conversation.id)) {
        if (releasedOnce.size >= 5000) releasedOnce.delete(releasedOnce.values().next().value);
        releasedOnce.add(conversation.id);
        log(`QR: đã trả luồng về app mặc định — ${label}`);
      }
      return true;
    } catch (error) {
      const reason = String(error?.message || error);
      const last = errorLoggedAt.get(reason);
      if (last === undefined || now() - last >= errorLogWindowMs) {
        if (errorLoggedAt.size >= 50) errorLoggedAt.clear();
        errorLoggedAt.set(reason, now());
        // (#100) "chỉ chủ sở hữu hiện tại của thread…": CRM không giữ luồng (Meta gửi referral mà không
        // chuyển quyền) — không có gì để trả, không phải lỗi.
        if (/#100\b/.test(reason)) log(`QR: không cần trả luồng (CRM không giữ) — ${label}`);
        else logError(`QR: không trả được quyền giữ luồng cho ${label}: ${reason}`);
      }
      return false;
    }
  };
}

/**
 * Luồng chào cho sự kiện Meta khi Page dùng "Định tuyến liên kết" (link m.me?ref=<mã> giao luồng cho app
 * CRM, app mặc định vẫn là Pancake). Theo Conversation Routing chỉ app đang giữ luồng gửi được tin, nên
 * thứ tự phụ thuộc đường gửi:
 *  - hội thoại CÓ `pancakeConversationId` (khách cũ, ưu đãi đi qua Pancake): TRẢ luồng ngay khi nhận sự
 *    kiện, rồi mới gửi qua Pancake; trả luồng lỗi vẫn thử gửi; Pancake gửi lỗi thì thử Send API của Meta
 *    (token Page của CRM) một lần — các phần còn lại của cùng lượt chào đi tiếp đường đó; riêng lỗi
 *    "không rõ đã gửi" của Pancake (hết giờ, 502/504) thì KHÔNG gửi thêm qua Meta kẻo khách nhận hai lần;
 *  - hội thoại KHÔNG có (khách mới): gửi qua Send API của Meta trước, xong mới trả luồng;
 *  - mọi nhánh khác (không chào, lỗi, sự kiện không phải lượt quét thẻ) đều trả luồng.
 * Chỉ áp dụng cho change mà `shouldRelease(change)` đúng (Page chỉ nghe referral, không phải standby);
 * change khác đi `sendPrimary` như cũ. `releaseThread(change)` → true khi trả được (createThreadReleaser).
 */
export function createLinkRoutedQrFlow({
  schedule,
  releaseThread,
  shouldRelease,
  sendPrimary,
  sendViaMeta,
  known = isKnownQrCode,
  log = console.log,
  logError = console.error
} = {}) {
  return function handleMetaChanges(changes) {
    const released = new Map(); // change → Promise<boolean> của lần trả luồng sớm
    const routes = new Map(); // change → { viaMeta, logged }
    for (const change of changes || []) {
      if (!change?.conversation || !shouldRelease(change)) continue;
      if (!isCardScan(change, { known })) {
        // CRM không trả lời gì cho sự kiện này: trả luồng ngay.
        if (change.type === 'message' || change.type === 'referral') releaseThread(change);
        continue;
      }
      if (change.conversation.pancakeConversationId) released.set(change, Promise.resolve().then(() => releaseThread(change)).catch(() => false));
    }
    schedule(changes, {
      send: async (conversation, payload, change) => {
        if (!shouldRelease(change)) return sendPrimary(conversation, payload);
        const label = conversation.name || conversation.id;
        const route = routes.get(change) || { viaMeta: false, logged: false };
        routes.set(change, route);
        const sent = (result, line) => {
          if (!route.logged) log(line);
          route.logged = true;
          return result;
        };
        if (!conversation.pancakeConversationId) return sent(await sendPrimary(conversation, payload), `QR: ưu đãi gửi qua Send API Meta (CRM đang giữ luồng) — ${label}`);
        // Trả luồng xong (dù được hay không) mới gửi qua Pancake.
        await released.get(change);
        if (!route.viaMeta) {
          try {
            return sent(await sendPrimary(conversation, payload), `QR: ưu đãi gửi qua Pancake (sau khi trả luồng) — ${label}`);
          } catch (error) {
            // Pancake hết giờ / cổng 502: tin có thể ĐÃ tới khách — gửi thêm qua Meta là khách nhận hai lần.
            if (error?.unknownDelivery) throw error;
            logError(`QR: gửi ưu đãi qua Pancake lỗi (${error?.message || error}), thử Send API Meta — ${label}`);
            route.viaMeta = true;
          }
        }
        return sent(await sendViaMeta(conversation, payload), `QR: ưu đãi gửi qua Send API Meta (dự phòng, Pancake lỗi) — ${label}`);
      },
      afterGreeting: async change => {
        // Đã trả sớm thành công thì thôi; chưa (khách mới, hoặc lần trả sớm lỗi) thì trả bây giờ.
        if (await released.get(change)) return;
        await releaseThread(change);
      }
    });
  };
}

/**
 * Giờ của tin gần nhất do NHÂN VIÊN gõ trong hội thoại (0 = chưa có). Chỉ tin gửi đi mang cờ `staff`
 * (nhân viên gửi từ CRM, hoặc gõ trong Pancake rồi về qua webhook/đồng bộ); tin bot, tin bám đuổi, tin tự
 * động của Pancake (Public API, POS…) và phiếu đơn máy gửi thay không tính.
 */
export function lastStaffMessageAt(messages) {
  let latest = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.direction !== 'outgoing' || message.staff !== true || message.followUp) continue;
    const at = Number(message.createdAt) || 0;
    if (at > latest) latest = at;
  }
  return latest;
}

// Câu giữ chỗ trong mẫu QR_OFFER đi kèm mã nguồn (chatbot-templates.seed.json): chưa sửa thì không được tới khách.
const offerPlaceholderPattern = /SỬA NỘI DUNG ƯU ĐÃI/iu;

/**
 * Chọn mẫu QR_OFFER để gửi. `stored` là giá trị trong Cài đặt → Tin nhắn:
 *  - không có khoá (undefined/null) → dùng mẫu mặc định `fallback`;
 *  - chuỗi rỗng → nhân viên đã cố ý để trống: KHÔNG gửi (trước đây rơi về mẫu mặc định và gửi cho khách);
 *  - còn câu giữ chỗ "SỬA NỘI DUNG ƯU ĐÃI…" (ở mẫu đã lưu hay mẫu mặc định) → chặn, không bao giờ gửi.
 * Trả `{ template }` hoặc `{ template: '', skip: 'lý do', warn?: true }`.
 */
export function resolveQrOfferTemplate({ stored, fallback = '' } = {}) {
  const template = String(stored === undefined || stored === null ? fallback || '' : stored);
  if (!template.trim()) return { template: '', skip: 'mẫu QR_OFFER để trống' };
  if (offerPlaceholderPattern.test(template.normalize('NFC'))) {
    return { template: '', skip: 'mẫu QR_OFFER còn câu giữ chỗ "SỬA NỘI DUNG ƯU ĐÃI…", hãy sửa ở Cài đặt → Tin nhắn → QR_OFFER', warn: true };
  }
  return { template };
}

/**
 * Tạo bộ chào: `schedule(changes)` nhận thay đổi từ webhook/đồng bộ, hẹn gửi
 * QR_OFFER cho khách quét thẻ. `offerMessage(conversation)` trả nội dung (chuỗi, dãy phần; rỗng
 * = tắt; `{ skip: 'lý do', warn }` = không gửi kèm lý do ghi log), `send(conversation, { text })` gửi tin.
 * Chủ shop 02/10: bot tắt hay hội thoại đã phân công cho nhân viên VẪN gửi ưu đãi (chỉ đúng tin ưu
 * đãi, không bật lại bot); chỉ bỏ qua khi nhân viên vừa nhắn trong `staffQuietMs` — đang trò chuyện dở.
 * `staffLastMessageAt(conversation)` trả giờ tin nhân viên gần nhất (xem lastStaffMessageAt).
 *
 * Mốc "đã chào" (vòng 13): trước đây chỉ nằm trong RAM nên mỗi lần khởi động lại khách có thể nhận ưu đãi
 * lần hai (02/10 10:42, hội thoại đã chốt đơn). Giờ lưu bền theo hội thoại:
 *  - `greetedStore.save(conversation, at)` ghi mốc khi gửi xong ưu đãi (hoặc Botcake đã chào);
 *  - `greetedStore.load()` → dãy [conversationId, at] đọc lại lúc dựng bộ chào;
 *  - trường `qrGreetedAt` trên chính hội thoại của change (bản trong kho) cũng được tính.
 * `recentOrderAt(conversation)` → giờ tạo của đơn gần nhất: hội thoại có đơn tạo trong `cooldownMs` qua thì
 * không gửi ưu đãi (khách vừa chốt đơn, quét/khởi động lại không chào lại).
 */
export function createQrGreeter({
  offerMessage,
  send,
  delayMs = 10_000,
  cooldownMs = 6 * 60 * 60 * 1000,
  skipLogWindowMs = 10 * 60 * 1000,
  staffLastMessageAt = null,
  staffQuietMs = 10 * 60 * 1000,
  greetedStore = null,
  recentOrderAt = null,
  now = Date.now,
  known = isKnownQrCode,
  log = console.log,
  logError = console.error
} = {}) {
  const greetedAt = new Map();
  // Mốc đã lưu bền (đọc lại lúc khởi động + các lần ghi của tiến trình này). Tách khỏi `greetedAt` vì
  // `greetedAt` còn được đặt TẠM lúc hẹn giờ (và xoá khi không gửi được).
  const persistedAt = new Map();
  const restored = greetedStore?.load
    ? Promise.resolve().then(() => greetedStore.load()).then(entries => {
        let count = 0;
        for (const [conversationId, at] of entries || []) {
          const value = Number(at) || 0;
          if (!conversationId || value <= 0 || now() - value >= cooldownMs) continue;
          if (value > (persistedAt.get(conversationId) || 0)) persistedAt.set(conversationId, value);
          count += 1;
        }
        if (count) log(`QR: đọc lại ${count} mốc đã chào còn hiệu lực từ kho`);
      }).catch(error => logError(`QR: không đọc được mốc đã chào từ kho: ${error?.message || error}`))
    : Promise.resolve();
  const persistGreeted = (conversation, at) => {
    persistedAt.set(conversation.id, at);
    if (!greetedStore?.save) return;
    Promise.resolve().then(() => greetedStore.save(conversation, at)).catch(error => logError(`QR: không lưu được mốc đã chào của ${conversation.name || conversation.id}: ${error?.message || error}`));
  };
  /** Mốc chào bền gần nhất của hội thoại: kho đã đọc lại, lần ghi của tiến trình này, hay trường trên hội thoại. */
  const persistedGreetedAt = conversation => Math.max(persistedAt.get(conversation.id) || 0, Number(conversation.qrGreetedAt) || 0);
  const timers = new Map();
  // Việc phải làm khi lượt chào đang hẹn kết thúc (gửi xong hoặc bị hủy): xem `afterGreeting` ở schedule.
  const pendingFinish = new Map();
  // Lượt chào đang hẹn, chạy ngay được khi dịch vụ sắp tắt (flush) thay vì mất theo timer.
  const pendingRuns = new Map();

  function cancel(conversationId) {
    const timer = timers.get(conversationId);
    if (!timer) return false;
    clearTimeout(timer);
    timers.delete(conversationId);
    pendingRuns.delete(conversationId);
    const finishPending = pendingFinish.get(conversationId);
    pendingFinish.delete(conversationId);
    finishPending?.();
    return true;
  }

  // Mục quá thời gian chờ không còn tác dụng (lần quét sau đã được chào lại): dọn mỗi lần
  // hẹn, nếu không Map giữ mọi hội thoại từng quét tới khi khởi động lại.
  function pruneGreeted() {
    const current = now();
    for (const [conversationId, at] of greetedAt) {
      if (current - at >= cooldownMs && !timers.has(conversationId)) greetedAt.delete(conversationId);
    }
    for (const [conversationId, at] of persistedAt) {
      if (current - at >= cooldownMs) persistedAt.delete(conversationId);
    }
  }

  // Referral bị bỏ qua: mỗi cặp (ref, lý do) chỉ ghi một dòng trong `skipLogWindowMs` — khách bấm quảng
  // cáo cũng mang referral (nguồn ADS), đồng bộ Pancake kéo lại cùng tin mỗi 10 phút; không để ngập log.
  const skipLoggedAt = new Map();
  const maximumSkipKeys = 200;
  function logSkippedReferral(change) {
    const reason = cardScanSkipReason(change, { known });
    if (!reason) return;
    // ref do bên ngoài gửi tới: chỉ giữ ký tự in được, cắt ngắn trước khi đưa vào log.
    const ref = String(change.referral.ref || '').replace(/[^ -~]/g, '?').slice(0, 60);
    const key = `${ref}|${reason}`;
    const current = now();
    const last = skipLoggedAt.get(key);
    if (last !== undefined && current - last < skipLogWindowMs) return;
    skipLoggedAt.delete(key);
    skipLoggedAt.set(key, current);
    while (skipLoggedAt.size > maximumSkipKeys) skipLoggedAt.delete(skipLoggedAt.keys().next().value);
    log(`QR: bỏ qua referral ref="${ref || '-'}" (${reason}) — ${change.conversation?.name || change.conversation?.id || 'không rõ hội thoại'}`);
  }

  // `afterGreeting(change)`: gọi một lần cho mỗi lượt quét thẻ khi CRM đã xong việc với nó — sau khi gửi
  // ưu đãi (kể cả gửi lỗi), hoặc ngay khi quyết định không chào. Webhook Meta dùng để trả quyền giữ luồng.
  // `send(conversation, payload, change)` (tuỳ chọn): đường gửi riêng cho lượt hẹn này thay cho `send` chung.
  // `delayMs` (tuỳ chọn): độ trễ riêng cho lượt hẹn này (khách mới khớp lượt bấm đã chờ sẵn một quãng).
  function schedule(changes, { afterGreeting = null, send: scheduleSend = null, delayMs: scheduleDelayMs = null } = {}) {
    pruneGreeted();
    const waitMs = Number.isFinite(scheduleDelayMs) && scheduleDelayMs !== null ? Math.max(0, Number(scheduleDelayMs)) : delayMs;
    const finish = change => {
      if (!afterGreeting) return;
      Promise.resolve().then(() => afterGreeting(change)).catch(error => logError(`QR: lỗi sau khi chào: ${error?.message || error}`));
    };
    for (const change of changes || []) {
      // Không lọc theo `change.type`: khách cũ quét thì ra change kiểu `referral`,
      // khách mới bấm "Bắt đầu" thì ra kiểu `message` mang theo referral. Cái
      // quyết định là referral đến từ link m.me với mã đã in.
      if (!isCardScan(change, { known })) {
        logSkippedReferral(change);
        continue;
      }
      const conversation = change.conversation;
      if (!conversation?.psid) continue;
      const label = conversation.name || conversation.id;
      // Botcake đã chào: ghi dấu, và hủy lượt chào CRM đang hẹn (tin Botcake có
      // thể về SAU referral Meta hay sau tin soạn sẵn của khách).
      if (change.referral?.type === 'BOTCAKE_OPTIN') {
        greetedAt.set(conversation.id, now());
        persistGreeted(conversation, now());
        const cancelled = cancel(conversation.id);
        log(`QR: Botcake đã chào khách quét ref="${change.referral.ref}"${cancelled ? ', hủy lượt chào CRM đang hẹn' : ''} — ${label}`);
        finish(change);
        continue;
      }
      const last = Math.max(greetedAt.get(conversation.id) || 0, persistedGreetedAt(conversation));
      if (now() - last < cooldownMs) {
        log(`QR: bỏ qua chào ${label} (vừa chào cách đây ${Math.round((now() - last) / 1000)}s)`);
        finish(change);
        continue;
      }
      const scheduledAt = now();
      greetedAt.set(conversation.id, scheduledAt);
      log(`QR: khách quét ref="${change.referral.ref || '-'}", sẽ chào sau ${waitMs / 1000}s — ${label}`);
      const run = async () => {
        timers.delete(conversation.id);
        pendingRuns.delete(conversation.id);
        try {
          // Mốc đã chào lưu trong kho (đọc lại lúc khởi động) có thể về SAU khi hẹn giờ: xét lại lúc gửi.
          await restored;
          const persisted = persistedGreetedAt(conversation);
          if (persisted > 0 && now() - persisted < cooldownMs) {
            log(`QR: bỏ qua chào ${label} (đã chào cách đây ${Math.round((now() - persisted) / 60000)} phút, mốc lưu trong kho)`);
            greetedAt.set(conversation.id, persisted);
            return;
          }
          // Hội thoại vừa có đơn (trong thời gian chờ chào lại): khách đã chốt, không gửi ưu đãi nữa.
          if (recentOrderAt) {
            const orderAt = Number(await Promise.resolve().then(() => recentOrderAt(conversation)).catch(error => {
              logError(`QR: không đọc được đơn của ${label}: ${error?.message || error}`);
              return 0;
            })) || 0;
            if (orderAt > 0 && now() - orderAt < cooldownMs) {
              log(`QR: không chào ${label} (hội thoại có đơn tạo ${Math.max(0, Math.round((now() - orderAt) / 60000))} phút trước)`);
              greetedAt.delete(conversation.id);
              return;
            }
          }
          // Nhân viên vừa nhắn (đang trò chuyện dở): không chen tin ưu đãi vào. Xét lúc GỬI, không phải lúc
          // hẹn — nhân viên có thể trả lời ngay trong mấy giây chờ. Không đọc được thì vẫn gửi.
          if (staffLastMessageAt && staffQuietMs > 0) {
            const staffAt = Number(await Promise.resolve().then(() => staffLastMessageAt(conversation)).catch(error => {
              logError(`QR: không đọc được tin nhân viên của ${label}: ${error?.message || error}`);
              return 0;
            })) || 0;
            const since = now() - staffAt;
            if (staffAt > 0 && since < staffQuietMs) {
              log(`QR: không chào ${label} (nhân viên vừa nhắn ${Math.max(0, Math.round(since / 60000))} phút trước)`);
              greetedAt.delete(conversation.id);
              return;
            }
          }
          // offerMessage trả chuỗi (chỉ chữ) hoặc dãy phần [{type:'text'|'image'}] —
          // thẻ ưu đãi là ảnh, gửi theo đúng thứ tự trong mẫu.
          const offer = await offerMessage(conversation);
          if (offer && typeof offer === 'object' && !Array.isArray(offer) && offer.skip) {
            (offer.warn ? logError : log)(`QR: KHÔNG gửi ưu đãi cho ${label}: ${offer.skip}`);
            greetedAt.delete(conversation.id);
            return;
          }
          const parts = typeof offer === 'string' ? (offer ? [{ type: 'text', text: offer }] : []) : (Array.isArray(offer) ? offer : []);
          if (!parts.length) {
            log('QR: mẫu tin QR_OFFER để trống nên không gửi gì.');
            greetedAt.delete(conversation.id);
            return;
          }
          const sendPart = scheduleSend ? payload => scheduleSend(conversation, payload, change) : payload => send(conversation, payload);
          const sentKinds = [];
          for (const part of parts) {
            if (part.type === 'image') {
              try {
                await sendPart({ imageUrl: part.url });
                sentKinds.push('ảnh');
              } catch (error) {
                // Ảnh thẻ CRM tự thêm (`optional`): không tải/gửi được thì vẫn gửi phần chữ, không bỏ cả ưu đãi.
                if (!part.optional) throw error;
                logError(`QR: không gửi được ảnh thẻ cho ${label} (${error?.message || error}), gửi phần chữ`);
              }
            } else if (part.text) {
              await sendPart({ text: part.text });
              sentKinds.push('chữ');
            }
          }
          if (!sentKinds.length) throw new Error('không phần nào của ưu đãi gửi được');
          greetedAt.set(conversation.id, now());
          persistGreeted(conversation, now());
          log(`QR: đã gửi ưu đãi cho ${label} (${sentKinds.join('+')})`);
        } catch (error) {
          // Ngoài cửa sổ 24h Meta trả lỗi ở đây — đó cũng là kết quả đáng ghi lại.
          logError(`QR: KHÔNG gửi được ưu đãi cho ${label}: ${error.message}`);
          greetedAt.delete(conversation.id);
        } finally {
          pendingFinish.delete(conversation.id);
          finish(change);
        }
      };
      const timer = setTimeout(run, waitMs);
      pendingRuns.set(conversation.id, run);
      pendingFinish.set(conversation.id, () => finish(change));
      // unref: hẹn giờ này không được giữ tiến trình sống khi tắt dịch vụ.
      timer.unref?.();
      timers.set(conversation.id, timer);
    }
  }

  /**
   * Dịch vụ sắp tắt (SIGTERM khi deploy/khởi động lại): gửi NGAY các lượt chào đang hẹn thay vì để mất theo
   * timer trong RAM. Chờ tối đa `timeoutMs` rồi trả về dù chưa xong; không bao giờ ném lỗi.
   */
  async function flush({ timeoutMs = 5000 } = {}) {
    const runs = [...pendingRuns.entries()];
    if (!runs.length) return 0;
    for (const [conversationId] of runs) clearTimeout(timers.get(conversationId));
    log(`QR: dịch vụ sắp tắt, gửi ngay ${runs.length} lượt chào đang hẹn`);
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); });
    await Promise.race([Promise.allSettled(runs.map(([, run]) => run())), timeout]);
    clearTimeout(timer);
    return runs.length;
  }

  return {
    schedule,
    flush,
    /** Đang hẹn chào hội thoại này? (cho test và chẩn đoán) */
    isPending: conversationId => timers.has(conversationId),
    greetedAt,
    /** Xong việc đọc lại mốc đã chào từ kho (cho test và lúc khởi động). */
    ready: restored
  };
}

/**
 * Thêm ẢNH THẺ ưu đãi lên đầu tin QR_OFFER khi mẫu không tự chứa ảnh (`![](…)`), để tin CRM gửi giống tin
 * Botcake (ảnh thẻ + chữ). Ảnh phục vụ công khai ở `/q/brand/offer-card.png`; Messenger/Pancake cần URL
 * https tuyệt đối nên base không https (chạy trên máy mình) hay thiếu tệp thì chỉ gửi chữ. Phần ảnh mang
 * `optional: true`: gửi ảnh lỗi thì bộ chào vẫn gửi phần chữ.
 */
export function withOfferCardImage(parts, { baseUrl = '', imagePath = '/q/brand/offer-card.png', available = true, enabled = true } = {}) {
  if (!enabled || !available || !Array.isArray(parts) || !parts.length) return parts;
  if (parts.some(part => part?.type === 'image')) return parts;
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) return parts;
  return [{ type: 'image', url: `${base}${imagePath}`, optional: true }, ...parts];
}

// ===== Khách MỚI quét thẻ: khớp lượt bấm nút trên trang đệm với hội thoại mới (vòng 13) =====
//
// Khách chưa từng nhắn Page thì Meta không báo `ref` cho ai cả (02/10: 0 webhook, kể cả standby); họ phải
// bấm "Bắt đầu"/câu gợi ý/gõ một tin, và tin đó về CRM qua webhook Pancake như một hội thoại mới bình thường.
// Dấu vết duy nhất của thẻ là lượt bấm nút "Mở Messenger" trên trang đệm (beacon POST /q/<mã>/open) ngay
// trước đó. Ca thật 02/10: tin đầu "Cho chị xem sản phẩm mới" đến 49 giây sau lượt bấm.

// Tin cho thấy hội thoại hộp thư mở ra từ một BÌNH LUẬN (nhắn riêng cho người bình luận, tin hệ thống của
// Messenger/Pancake) — số liệu 2 ngày (r13): 61 "Bạn đang phản hồi bình luận…", 59 "…để lại bình luận…",
// 15 "…đã trả lời về một bài viết", 1 "replied to a post".
const commentSourcePattern = /để lại bình luận|đang phản hồi bình luận|đã trả lời về một bài viết|replied to (?:a|your) (?:post|comment)/iu;
const shopCartPattern = /^Khách chọn mua từ Facebook Shop/u;

/** Giờ bấm quảng cáo gần nhất ghi trên hội thoại (0 = không có referral quảng cáo; -1 = có nhưng không rõ giờ). */
function latestAdClickAt(conversation) {
  const history = (Array.isArray(conversation?.referrals) ? conversation.referrals : []).filter(item => item?.source === 'ADS' || item?.adId);
  const single = conversation?.referral?.source === 'ADS' || conversation?.referral?.adId ? conversation.referral : null;
  if (!single && !history.length) return 0;
  const at = Math.max(0, Number(single?.lastAt) || 0, Number(single?.firstAt) || 0, ...history.map(item => Number(item?.at) || 0));
  return at || -1;
}

/**
 * Vì sao một tin khách KHÔNG phải "tin đầu của hội thoại hộp thư mới không dấu nguồn" ('' = đủ điều kiện để
 * khớp với lượt bấm nút trang đệm). `conversation` + `messages` là bản TRONG KHO (không chỉ gói webhook),
 * `commentAt` = giờ hoạt động gần nhất của luồng bình luận cùng khách (0 = không có).
 *  - `phase: 'arrival'` (lúc tin về): hội thoại phải chưa có tin nào khác;
 *  - `phase: 'resolve'` (lúc sắp chào, sau câu trả lời của bot): chỉ xét dấu nguồn — tin bấm quảng cáo, giỏ
 *    Shop, tin nhắn riêng từ bình luận có thể về SAU tin đầu vài giây.
 * Referral quảng cáo / bình luận cũ hơn `sourceFreshMs` không tính là nguồn của lượt này: ca thật 02/10
 * (…895462) mang referral ADS do Pancake ghi từ 27 ngày trước.
 */
export function bridgeSourceMarker({ conversation, messages = [], message, commentAt = 0, phase = 'arrival', sourceFreshMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!conversation || !message) return 'thiếu hội thoại';
  if (conversation.source === 'comment') return 'luồng bình luận';
  if (message.direction !== 'incoming') return 'không phải tin khách';
  const messageId = String(message.id || message.mid || '');
  const others = (Array.isArray(messages) ? messages : []).filter(item => item && String(item.id || item.mid || '') !== messageId);
  if (phase === 'arrival' && others.length) return 'hội thoại đã có tin trước đó';
  const at = Number(message.createdAt) || 0;
  const all = [message, ...others];
  if (all.some(item => item.type === 'ad')) return 'khách bấm quảng cáo';
  const adAt = latestAdClickAt(conversation);
  if (adAt === -1) return 'referral quảng cáo (không rõ giờ bấm)';
  if (adAt > 0 && Math.abs(at - adAt) < sourceFreshMs) return `referral quảng cáo (bấm ${Math.max(0, Math.round((at - adAt) / 60000))} phút trước)`;
  if (all.some(item => (Array.isArray(item.cart) && item.cart.length) || shopCartPattern.test(String(item.text || '')))) return 'giỏ Facebook Shop';
  if (all.some(item => item.privateReply || commentSourcePattern.test(String(item.text || '')))) return 'nhắn riêng từ bình luận';
  if (Number(commentAt) > 0 && Math.abs(at - Number(commentAt)) < sourceFreshMs) return 'khách vừa bình luận dưới bài viết';
  // Meta đã báo referral / Botcake đã chào / tin soạn sẵn mang #mã cho chính lượt này: đường đó lo việc chào.
  if ((Array.isArray(conversation.qrReferrals) ? conversation.qrReferrals : []).some(item => Math.abs(at - (Number(item?.at) || 0)) < sourceFreshMs)) return 'đã có referral thẻ QR (đường khác xử lý)';
  return '';
}

/**
 * Khớp lượt bấm nút trang đệm với TIN ĐẦU của hội thoại hộp thư mới trên Page QR.
 *  - `noteClick({ code, visitor })`: beacon bấm nút (hoặc lượt quét được chuyển hướng thẳng sang m.me) —
 *    ghi một "lượt bấm chờ khớp" trong RAM; cùng một máy bấm lại thì chỉ là một lượt (lấy giờ mới nhất).
 *  - `consider(changes)` (gọi ở móc trước bot của webhook/đồng bộ Pancake): tin khách đầu tiên của hội thoại
 *    mới, không dấu nguồn (bridgeSourceMarker), đến trong `windowMs` sau một lượt bấm còn trống → GIỮ lượt bấm
 *    đó (khớp 1–1 theo thứ tự thời gian). Trả về mã các hội thoại vừa giữ.
 *  - `botDone(ids)`: bot đã xử lý xong tin đó. Khi cả hai điều kiện đủ — đã qua `ambiguityMs` kể từ lúc tin
 *    về VÀ bot xong — kiểm lại dấu nguồn rồi gọi `greet(change, { delayMs })` với referral
 *    { ref: mã, source: 'SHORTLINK', type: 'BRIDGE_CLICK' }; ưu đãi đi sau câu trả lời của bot ít nhất `greetDelayMs`.
 *  - Mơ hồ: trong lúc còn giữ mà có hội thoại mới khác cũng đủ điều kiện, cách nhau ≤ `ambiguityMs`, và không
 *    còn lượt bấm trống cho nó → không biết ai là người quét: KHÔNG chào ai, lượt bấm bị tiêu.
 * `inspect(change)` → { conversation, messages, commentAt } đọc từ kho. Mọi quyết định đều ghi log.
 */
export function createBridgeClickMatcher({
  greet,
  inspect,
  pageId = '',
  windowMs = 90_000,
  ambiguityMs = 15_000,
  clickSkewMs = 3000,
  retainMs = 15 * 60 * 1000,
  greetDelayMs = 10_000,
  maxBotWaitMs = 60_000,
  maximumClicks = 50,
  known = isKnownQrCode,
  now = Date.now,
  log = console.log,
  logError = console.error
} = {}) {
  const clicks = []; // { code, at, visitor, via, reservedBy, consumed }
  const candidates = new Map(); // conversationId → { id, label, at, arrivedAt, change, click, state, botDoneAt, holdOver, timer }
  const enabled = () => windowMs > 0;
  const shortId = value => `…${String(value || '').slice(-6)}`;
  const labelOf = conversation => `${conversation.name || 'khách'} (${shortId(conversation.id)})`;

  function prune() {
    const current = now();
    for (let index = clicks.length - 1; index >= 0; index -= 1) {
      const click = clicks[index];
      if (current - click.at > windowMs + retainMs && !click.reservedBy) clicks.splice(index, 1);
    }
    for (const [id, candidate] of candidates) {
      if (candidate.state !== 'held' && current - candidate.arrivedAt > windowMs + retainMs) candidates.delete(id);
    }
  }

  function noteClick({ code, visitor = '', via = 'beacon', at = now() } = {}) {
    const key = String(code || '').toLowerCase();
    if (!enabled() || !key || !known(key)) return false;
    prune();
    const visitorKey = visitor ? String(visitor).slice(0, 128) : '';
    // Cùng một máy bấm lại (lần đầu Messenger không mở): vẫn là một người — dời giờ, không thêm lượt.
    const same = visitorKey ? clicks.find(click => click.code === key && click.visitor === visitorKey && !click.reservedBy && !click.consumed) : null;
    if (same) {
      same.at = at;
      log(`QR: lượt bấm ${key} của cùng một máy, dời mốc chờ khớp (cửa sổ ${Math.round(windowMs / 1000)}s)`);
      return true;
    }
    clicks.push({ code: key, at, visitor: visitorKey, via, reservedBy: '', consumed: false });
    // Beacon là đường công khai: gửi dồn không được làm phình bộ nhớ — bỏ lượt cũ nhất chưa giữ cho ai.
    while (clicks.length > maximumClicks) {
      const index = clicks.findIndex(click => !click.reservedBy);
      if (index < 0) break;
      clicks.splice(index, 1);
    }
    log(`QR: ghi lượt bấm ${key} chờ khớp với hội thoại mới (${via === 'redirect' ? 'chuyển hướng thẳng' : 'nút trang đệm'}, cửa sổ ${Math.round(windowMs / 1000)}s)`);
    return true;
  }

  // Giờ khách gửi tin: giờ của tin (Pancake) khi hợp lý, không thì giờ nhận — webhook về trễ không làm lệch cửa sổ.
  function messageTime(message) {
    const created = Number(message?.createdAt) || 0;
    const current = now();
    return created > 0 && created <= current + clickSkewMs ? created : current;
  }

  const usableClicks = at => clicks
    .filter(click => !click.consumed && click.at <= at + clickSkewMs && at - click.at <= windowMs)
    .sort((first, second) => first.at - second.at);

  function drop(candidate, { consume }) {
    candidate.state = 'dropped';
    clearTimeout(candidate.timer);
    if (candidate.click) {
      candidate.click.reservedBy = '';
      if (consume) candidate.click.consumed = true;
    }
  }

  async function resolve(candidate) {
    if (candidate.state !== 'held') return;
    candidate.state = 'resolving';
    clearTimeout(candidate.timer);
    const { change, click } = candidate;
    try {
      const facts = await inspect(change);
      const reason = bridgeSourceMarker({ ...facts, message: change.message, phase: 'resolve' });
      if (candidate.state !== 'resolving') return; // bị hủy vì mơ hồ trong lúc đọc kho
      if (reason) {
        click.reservedBy = '';
        candidate.state = 'dropped';
        log(`QR: bỏ khớp lượt bấm ${click.code} với ${candidate.label}: ${reason}`);
        return;
      }
      click.reservedBy = '';
      click.consumed = true;
      candidate.state = 'greeted';
      const delayMs = Math.max(0, (candidate.botDoneAt || now()) + greetDelayMs - now());
      log(`QR: chào khách mới ${candidate.label} theo lượt bấm ${click.code} (ưu đãi gửi sau câu trả lời của bot)`);
      greet({ ...change, conversation: facts?.conversation || change.conversation, referral: { ref: click.code, source: 'SHORTLINK', type: 'BRIDGE_CLICK' } }, { delayMs });
    } catch (error) {
      click.reservedBy = '';
      candidate.state = 'dropped';
      logError(`QR: lỗi khi khớp lượt bấm với ${candidate.label}: ${error?.message || error}`);
    }
  }

  function maybeResolve(candidate) {
    if (candidate.state === 'held' && candidate.holdOver && candidate.botDoneAt) resolve(candidate);
  }

  async function consider(changes) {
    const held = [];
    if (!enabled()) return held;
    const list = (changes || []).filter(change => change?.type === 'message' && !change.updated && !change.standby && !change.referral
      && change.conversation && change.conversation.source !== 'comment' && change.message?.direction === 'incoming');
    if (!list.length) return held;
    prune();
    // Không có lượt bấm nào đang chờ: không có gì để khớp, khỏi đọc kho.
    if (!clicks.some(click => !click.consumed)) return held;
    const page = String(typeof pageId === 'function' ? await pageId() : pageId || '');
    list.sort((first, second) => (Number(first.message.createdAt) || 0) - (Number(second.message.createdAt) || 0));
    for (const change of list) {
      const conversation = change.conversation;
      if (!page || String(conversation.pageId) !== page) continue;
      if (candidates.has(conversation.id)) continue;
      const at = messageTime(change.message);
      const usable = usableClicks(at);
      const label = labelOf(conversation);
      let facts;
      try {
        facts = await inspect(change);
      } catch (error) {
        logError(`QR: không đọc được kho để khớp lượt bấm với ${label}: ${error?.message || error}`);
        continue;
      }
      const reason = bridgeSourceMarker({ ...facts, message: change.message, phase: 'arrival' });
      if (reason) {
        // Khách cũ nhắn (ca thường gặp nhất) thì im; hội thoại MỚI nhưng mang dấu nguồn khác thì ghi lại.
        if (usable.length && reason !== 'hội thoại đã có tin trước đó') log(`QR: hội thoại mới ${label} không tính là quét thẻ: ${reason}`);
        continue;
      }
      if (!usable.length) {
        const latest = clicks.filter(click => !click.consumed && click.at <= at + clickSkewMs).sort((first, second) => second.at - first.at)[0];
        if (latest) log(`QR: hội thoại mới ${label} không khớp lượt bấm nào (lượt bấm ${latest.code} gần nhất cách ${Math.round((at - latest.at) / 1000)}s, quá cửa sổ ${Math.round(windowMs / 1000)}s)`);
        continue;
      }
      const free = usable.find(click => !click.reservedBy);
      if (!free) {
        // Hết lượt bấm trống: hội thoại này tranh với hội thoại đang giữ lượt bấm.
        const rivals = [...candidates.values()].filter(other => other.state === 'held' && usable.includes(other.click) && Math.abs(other.at - at) <= ambiguityMs);
        if (rivals.length) {
          for (const rival of rivals) {
            drop(rival, { consume: true });
            log(`QR: lượt bấm ${rival.click.code} có 2 hội thoại mới cùng lúc, không chào để tránh nhầm — ${rival.label} và ${label} (cách nhau ${Math.round(Math.abs(rival.at - at) / 1000)}s)`);
          }
        } else {
          const owner = [...candidates.values()].find(other => usable.includes(other.click) && other.state !== 'dropped');
          log(`QR: hội thoại mới ${label} không được chào: lượt bấm ${usable[0].code} đã khớp với ${owner?.label || 'hội thoại khác'} trước đó`);
        }
        // Ghi nhớ để tin kế tiếp của hội thoại này không xét lại.
        candidates.set(conversation.id, { id: conversation.id, label, at, arrivedAt: now(), change, click: null, state: 'dropped', botDoneAt: 0, holdOver: true, timer: null });
        continue;
      }
      free.reservedBy = conversation.id;
      const candidate = { id: conversation.id, label, at, arrivedAt: now(), change, click: free, state: 'held', botDoneAt: 0, holdOver: false, timer: null };
      candidates.set(conversation.id, candidate);
      held.push(conversation.id);
      log(`QR: khớp lượt bấm ${free.code} với hội thoại mới ${label} (sau ${Math.max(0, Math.round((at - free.at) / 1000))}s), chờ ${Math.round(ambiguityMs / 1000)}s xem có hội thoại mới khác`);
      const afterHold = () => {
        candidate.holdOver = true;
        if (candidate.state !== 'held') return;
        if (candidate.botDoneAt) return void resolve(candidate);
        // Bot chưa xong (mô hình chậm): chờ thêm, quá `maxBotWaitMs` thì chào luôn kẻo mất lượt.
        candidate.timer = setTimeout(() => {
          if (candidate.state !== 'held') return;
          candidate.botDoneAt = now();
          resolve(candidate);
        }, maxBotWaitMs);
        candidate.timer.unref?.();
      };
      candidate.timer = setTimeout(afterHold, Math.max(0, ambiguityMs));
      candidate.timer.unref?.();
    }
    return held;
  }

  /** Bot đã xử lý xong lượt webhook mang các hội thoại này (đã trả lời, hoặc quyết định im). */
  function botDone(ids) {
    for (const id of ids || []) {
      const candidate = candidates.get(id);
      if (!candidate || candidate.botDoneAt) continue;
      candidate.botDoneAt = now();
      maybeResolve(candidate);
    }
  }

  return {
    noteClick,
    consider,
    botDone,
    /** Số lượt bấm còn chờ khớp (cho test và chẩn đoán). */
    pendingClicks: () => { prune(); return clicks.filter(click => !click.consumed && !click.reservedBy).length; },
    /** Trạng thái một hội thoại đang/đã xét: 'held' | 'greeted' | 'dropped' | '' (cho test). */
    stateOf: id => candidates.get(id)?.state || ''
  };
}
