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
 */
export function createQrGreeter({
  offerMessage,
  send,
  delayMs = 10_000,
  cooldownMs = 6 * 60 * 60 * 1000,
  skipLogWindowMs = 10 * 60 * 1000,
  staffLastMessageAt = null,
  staffQuietMs = 10 * 60 * 1000,
  now = Date.now,
  known = isKnownQrCode,
  log = console.log,
  logError = console.error
} = {}) {
  const greetedAt = new Map();
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
  function schedule(changes, { afterGreeting = null, send: scheduleSend = null } = {}) {
    pruneGreeted();
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
        const cancelled = cancel(conversation.id);
        log(`QR: Botcake đã chào khách quét ref="${change.referral.ref}"${cancelled ? ', hủy lượt chào CRM đang hẹn' : ''} — ${label}`);
        finish(change);
        continue;
      }
      const last = greetedAt.get(conversation.id) || 0;
      if (now() - last < cooldownMs) {
        log(`QR: bỏ qua chào ${label} (vừa chào cách đây ${Math.round((now() - last) / 1000)}s)`);
        finish(change);
        continue;
      }
      greetedAt.set(conversation.id, now());
      log(`QR: khách quét ref="${change.referral.ref || '-'}", sẽ chào sau ${delayMs / 1000}s — ${label}`);
      const run = async () => {
        timers.delete(conversation.id);
        pendingRuns.delete(conversation.id);
        try {
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
          for (const part of parts) {
            if (part.type === 'image') await sendPart({ imageUrl: part.url });
            else if (part.text) await sendPart({ text: part.text });
          }
          log(`QR: đã gửi ưu đãi cho ${label} (${parts.map(part => part.type === 'image' ? 'ảnh' : 'chữ').join('+')})`);
        } catch (error) {
          // Ngoài cửa sổ 24h Meta trả lỗi ở đây — đó cũng là kết quả đáng ghi lại.
          logError(`QR: KHÔNG gửi được ưu đãi cho ${label}: ${error.message}`);
          greetedAt.delete(conversation.id);
        } finally {
          pendingFinish.delete(conversation.id);
          finish(change);
        }
      };
      const timer = setTimeout(run, delayMs);
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
    greetedAt
  };
}
