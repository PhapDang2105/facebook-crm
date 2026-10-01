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
 * Tạo bộ chào: `schedule(changes)` nhận thay đổi từ webhook/đồng bộ, hẹn gửi
 * QR_OFFER cho khách quét thẻ. `offerMessage(conversation)` trả nội dung (rỗng
 * = tắt), `send(conversation, { text })` gửi tin.
 */
export function createQrGreeter({
  offerMessage,
  send,
  delayMs = 10_000,
  cooldownMs = 6 * 60 * 60 * 1000,
  now = Date.now,
  known = isKnownQrCode,
  log = console.log,
  logError = console.error
} = {}) {
  const greetedAt = new Map();
  const timers = new Map();

  function cancel(conversationId) {
    const timer = timers.get(conversationId);
    if (!timer) return false;
    clearTimeout(timer);
    timers.delete(conversationId);
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

  function schedule(changes) {
    pruneGreeted();
    for (const change of changes || []) {
      // Không lọc theo `change.type`: khách cũ quét thì ra change kiểu `referral`,
      // khách mới bấm "Bắt đầu" thì ra kiểu `message` mang theo referral. Cái
      // quyết định là referral đến từ link m.me với mã đã in.
      if (!isCardScan(change, { known })) continue;
      const conversation = change.conversation;
      if (!conversation?.psid) continue;
      const label = conversation.name || conversation.id;
      // Botcake đã chào: ghi dấu, và hủy lượt chào CRM đang hẹn (tin Botcake có
      // thể về SAU referral Meta hay sau tin soạn sẵn của khách).
      if (change.referral?.type === 'BOTCAKE_OPTIN') {
        greetedAt.set(conversation.id, now());
        const cancelled = cancel(conversation.id);
        log(`QR: Botcake đã chào khách quét ref="${change.referral.ref}"${cancelled ? ', hủy lượt chào CRM đang hẹn' : ''} — ${label}`);
        continue;
      }
      // Bot tắt hay nhân viên đang nhận trong Pancake: không chen tin ưu đãi vào.
      if (conversation.botEnabled === false || conversation.pancakeAssigned) {
        log(`QR: không chào ${label} (${conversation.botEnabled === false ? 'bot tắt' : 'nhân viên đang nhận'})`);
        continue;
      }
      const last = greetedAt.get(conversation.id) || 0;
      if (now() - last < cooldownMs) {
        log(`QR: bỏ qua chào ${label} (vừa chào cách đây ${Math.round((now() - last) / 1000)}s)`);
        continue;
      }
      greetedAt.set(conversation.id, now());
      log(`QR: khách quét ref="${change.referral.ref || '-'}", sẽ chào sau ${delayMs / 1000}s — ${label}`);
      const timer = setTimeout(async () => {
        timers.delete(conversation.id);
        try {
          // offerMessage trả chuỗi (chỉ chữ) hoặc dãy phần [{type:'text'|'image'}] —
          // thẻ ưu đãi là ảnh, gửi theo đúng thứ tự trong mẫu.
          const offer = await offerMessage(conversation);
          const parts = typeof offer === 'string' ? (offer ? [{ type: 'text', text: offer }] : []) : (Array.isArray(offer) ? offer : []);
          if (!parts.length) {
            log('QR: mẫu tin QR_OFFER để trống nên không gửi gì.');
            greetedAt.delete(conversation.id);
            return;
          }
          for (const part of parts) {
            if (part.type === 'image') await send(conversation, { imageUrl: part.url });
            else if (part.text) await send(conversation, { text: part.text });
          }
          log(`QR: đã gửi ưu đãi cho ${label} (${parts.map(part => part.type === 'image' ? 'ảnh' : 'chữ').join('+')})`);
        } catch (error) {
          // Ngoài cửa sổ 24h Meta trả lỗi ở đây — đó cũng là kết quả đáng ghi lại.
          logError(`QR: KHÔNG gửi được ưu đãi cho ${label}: ${error.message}`);
          greetedAt.delete(conversation.id);
        }
      }, delayMs);
      // unref: hẹn giờ này không được giữ tiến trình sống khi tắt dịch vụ.
      timer.unref?.();
      timers.set(conversation.id, timer);
    }
  }

  return {
    schedule,
    /** Đang hẹn chào hội thoại này? (cho test và chẩn đoán) */
    isPending: conversationId => timers.has(conversationId),
    greetedAt
  };
}
