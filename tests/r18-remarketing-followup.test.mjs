// Vòng 18 — chủ shop 12/10: khách thẻ Re-marketing (vào từ link ref / QR thẻ cảm ơn, đã mua) nhận câu bám đuổi riêng
// FOLLOW_UP_REMARKETING thay lời "còn phân vân loại nào" (ca Nhi Luu 12/10). Kho tạm, sendMessage là stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import './helpers/seed-catalog.mjs';

const directory = tempDir('r18-remarketing-');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(directory, 'follow-ups.json');
process.env.INBOX_SETTINGS_PATH = path.join(directory, 'inbox-settings.json');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.parse('2026-10-12T04:00:00Z');
const page = '103';
const message = (direction, createdAt, extra = {}) => ({ id: `m${createdAt}${direction}${extra.text || ''}`.slice(0, 60), mid: '', direction, type: 'text', text: 'x', createdAt, status: 'sent', ...extra });
const QR_OFFER = 'Thân gửi Chị, Giọt Nắng cảm ơn chị đã tin tưởng và ủng hộ ạ 💛 Em gửi chị ưu đãi cho đơn tiếp theo tại Fanpage: miễn phí vận chuyển; Combo 2 tặng 2 túi Yến mạch. Chị nhắn em là lên đơn liền nha.';
const RM_TEXT = 'Dạ chị lưu lần sau mua hàng là em áp dụng ưu đãi này cho chị luôn ạ. Em cảm ơn chị đã mua hàng nhà Nắng ạ';
const pending = { items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 2 }], key: 'GRA-XANH-Z450=2', at: now - 5 * HOUR, phone: '', address: '' };
const conv = (psid, extra = {}) => ({ id: `${page}:${psid}`, pageId: page, psid, name: `Khách ${psid}`, source: 'inbox', gender: 'female', genderSource: 'name', botLastTemplateId: 'QR_OFFER', botLastReplyAt: now - 4 * HOUR, ...extra });

writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({
  conversations: [
    // Nhi Luu (12/10): QR thẻ cảm ơn → bot gửi ưu đãi đơn sau → khách im 4 giờ → câu Re-marketing.
    conv('rm', { labels: ['remarketing'] }),
    // Khách Re-marketing đã nhận câu này 5 ngày trước, nay lại im sau tin bot → không gửi lại.
    conv('rmsent', { labels: ['remarketing'] }),
    // Khách Re-marketing đang giữ giỏ 2 túi → vẫn nhắc giỏ (chăm sóc đơn), không cảm ơn.
    conv('rmcart', { labels: ['remarketing'], botLastTemplateId: 'ORDER_ADDRESS', pendingOrder: pending }),
    // Đối chứng: không thẻ → lời nhắc hộp thư thường.
    conv('plain', { labels: [], botLastTemplateId: 'PRICE_QUOTE' })
  ],
  messages: {
    [`${page}:rm`]: [message('incoming', now - 4 * HOUR - 60000, { text: 'QR' }), message('outgoing', now - 4 * HOUR, { text: QR_OFFER, sender: 'bot' })],
    [`${page}:rmsent`]: [
      message('outgoing', now - 5 * DAY, { text: RM_TEXT, sender: 'bot', followUp: true }),
      message('incoming', now - 4 * HOUR - 60000, { text: 'shop ơi giá túi vàng' }),
      message('outgoing', now - 4 * HOUR, { text: 'Dạ Túi Vàng 350g giá 174.000đ ạ.', sender: 'bot' })
    ],
    [`${page}:rmcart`]: [message('incoming', now - 5 * HOUR - 60000, { text: 'lấy 2 túi xanh' }), message('outgoing', now - 4 * HOUR, { text: 'Dạ chị cho em xin số điện thoại và địa chỉ trước sáp nhập nha ạ.', sender: 'bot' })],
    [`${page}:plain`]: [message('incoming', now - 4 * HOUR - 60000, { text: 'giá sao shop' }), message('outgoing', now - 4 * HOUR, { text: 'Dạ Túi Xanh 450g giá 174.000đ ạ.', sender: 'bot' })]
  },
  commentIndex: {}
}));
writeFileSync(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 30 * DAY, sent: {} }));

const { runFollowUps, remarketingFollowUpTemplate, isRemarketingCandidate } = await import('../app/follow-up.mjs');
const { normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');
const scenarios = [{ id: 'inbox-remind', name: 'Hộp thư im 3 giờ', trigger: 'inbox-no-reply', delayHours: 3, templateId: 'FOLLOW_UP_INBOX_REMIND' }];

test('R18: mẫu FOLLOW_UP_REMARKETING có trong seed (cài đặt cũ tự nhận), rỗng = tắt', () => {
  const settings = normalizeChatbotSettings({ enabled: true });
  assert.match(settings.messageTemplates.FOLLOW_UP_REMARKETING, /lưu lần sau mua hàng là em áp dụng ưu đãi này/);
  assert.match(remarketingFollowUpTemplate({}), /cảm ơn \{title\} đã mua hàng nhà Nắng/);
  assert.equal(remarketingFollowUpTemplate({ FOLLOW_UP_REMARKETING: '' }), '');
  assert.equal(isRemarketingCandidate({ conversation: { labels: ['followup'] }, inbox: { labels: ['remarketing'] } }), true);
  assert.equal(isRemarketingCandidate({ conversation: { labels: ['followup'] } }), false);
});

test('R18 vòng bám đuổi: khách Re-marketing nhận câu cảm ơn (không tra khách quen), đã nhận → bỏ, đang giữ giỏ → nhắc giỏ, khách thường là khách cũ → bỏ như trước', async () => {
  const sent = [];
  // Pancake báo mọi khách là khách cũ: khách thường bị bỏ (returning), khách Re-marketing vẫn nhận câu cảm ơn.
  const conversationInfo = async () => ({ succeedOrderCount: 1 });
  const settings = normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios } });
  const summary = await runFollowUps({ readSettings: async () => settings, conversationInfo, sendMessage: async (c, p) => { sent.push({ id: c.id, text: p.text }); return { message: { mid: `x${c.id}` } }; }, now, quietHours: false, log: () => {} });
  const byId = Object.fromEntries(sent.map(item => [item.id.split(':')[1], item.text]));
  assert.equal(byId.rm, RM_TEXT, JSON.stringify({ sent, reasons: summary.skipReasons }));
  assert.equal(byId.rmsent, undefined);
  assert.equal(summary.skipReasons.remarketingSent, 1, JSON.stringify(summary.skipReasons));
  assert.match(byId.rmcart || '', /^Dạ em vẫn đang giữ đơn 2 Granola Túi Xanh 450g/);
  assert.equal(byId.plain, undefined, 'khách thường mà Pancake báo khách cũ → bỏ như trước');
  assert.ok((summary.returning || 0) >= 1, JSON.stringify(summary));
});
