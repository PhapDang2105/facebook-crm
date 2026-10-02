// fix-review (02/10):
// lỗi 2 — keepTypedHouseNumber đưa số nhà CŨ trở lại khi khách sửa số nhà / đổi địa chỉ ở tin sau (tin sửa thường
//          không ghi tỉnh nên hàm lùi về tin địa chỉ cũ). Nay chỉ xét tin MỚI NHẤT có số nhà. (Từ scratchpad/rv/housenum.mjs.)
// mẫu  — ORDER_STATUS_CHECKING có lời dự phòng trong engine: cài đặt thiếu mẫu thì bot vẫn báo "đang kiểm tra",
//          không rơi về ORDER_STATUS (kể chi tiết đơn ngoài hội thoại) hay im.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import './helpers/seed-catalog.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.ADDRESS_AI_CACHE_PATH = path.join(tempDir('fix-review-engine-'), 'address-ai-cache.json');

const { keepTypedHouseNumber, fallbackTemplates, withFallbackTemplates, processChatbotChanges } = await import('../app/chatbot-engine.mjs');
const { defaultMessageTemplates, renderChatbotReply } = await import('../app/chatbot-templates.mjs');

function keep(model, recent, message) {
  const parsed = { template_id: 'ORDER_CONFIRMATION', Customer_Address: model };
  keepTypedHouseNumber(parsed, { recentCustomerTexts: recent, messageText: message });
  return parsed;
}

test('lỗi 2: khách sửa số nhà ở tin sau (không ghi tỉnh) — giữ địa chỉ mới mô hình viết, không khôi phục số nhà cũ', () => {
  const model = '45 Lê Lợi, Phường Bến Nghé, Quận 1, Thành phố Hồ Chí Minh';
  const parsed = keep(model, ['Giao về 12 Lê Lợi, phường Bến Nghé, quận 1, TP Hồ Chí Minh nhé'], 'à em nhầm, số nhà 45 chứ không phải 12');
  assert.equal(parsed.Customer_Address, model, 'trước đây: thành "12 Lê Lợi, phường Bến Nghé, quận 1, TP Hồ Chí Minh"');
  assert.equal(parsed.addressAiCheck, undefined);
  // Tin sửa đã nằm trong lịch sử, tin hiện tại chỉ là "ok": vẫn không lùi qua tin sửa về địa chỉ cũ.
  const later = keep(model, ['Giao về 12 Lê Lợi, phường Bến Nghé, quận 1, TP Hồ Chí Minh nhé', 'à em nhầm, số nhà 45 chứ không phải 12'], 'ok em nha');
  assert.equal(later.Customer_Address, model);
  assert.equal(later.addressAiCheck, undefined);
});

test('lỗi 2: khách đổi hẳn địa chỉ (công ty / đường khác) — không đưa địa chỉ cũ trở lại', () => {
  const company = 'Tầng 9 tòa Mipec, 229 Tây Sơn, Đống Đa, Hà Nội';
  const moved = keep(company, ['Số 5 ngõ 3 Thái Hà, Đống Đa, Hà Nội'], 'thôi gửi lên công ty giúp mình: tầng 9 tòa Mipec Tây Sơn');
  assert.equal(moved.Customer_Address, company, 'trước đây: thành "Số 5 ngõ 3 Thái Hà, Đống Đa, Hà Nội"');
  assert.equal(moved.addressAiCheck, undefined);

  const other = '88 Trần Hưng Đạo, Phường 7, Quận 5, Thành phố Hồ Chí Minh';
  const changed = keep(other, ['12 Lê Lợi, phường Bến Nghé, quận 1, TP HCM'], 'chị đổi sang giao 88 Trần Hưng Đạo phường 7 quận 5 nha');
  assert.equal(changed.Customer_Address, other);
  assert.equal(changed.addressAiCheck, undefined);
});

test('lỗi 2: ca gốc của fix-addr vẫn giữ — mô hình bỏ số nhà, các tin sau không có số nhà thì khôi phục chữ khách gõ', () => {
  const typed = '71/82 khu phố 1 phường Long Bình Tân Biên Hòa Đồng Nai';
  const parsed = keep('Gần siêu thị Big C, Phường Long Bình Tân, Biên Hòa, Đồng Nai', [typed, 'Chị ở gần sthị big c'], 'ok em');
  assert.equal(parsed.Customer_Address, typed);
  assert.match(parsed.addressAiCheck, /71\/82/);
  // Tin mới nhất có số nhà chính là tin địa chỉ đầy đủ (cùng tỉnh): vẫn khôi phục.
  const direct = keep('Gần siêu thị Big C, Phường Long Bình Tân, Biên Hòa, Đồng Nai', [], typed);
  assert.equal(direct.Customer_Address, typed);
  // Số lượng ("2 túi") không phải số nhà: tin đặt thêm không chặn việc khôi phục.
  const quantity = keep('Gần siêu thị Big C, Phường Long Bình Tân, Biên Hòa, Đồng Nai', [typed], 'lấy thêm 2 túi xanh nha');
  assert.equal(quantity.Customer_Address, typed);
});

// ===== Mẫu dự phòng ORDER_STATUS_CHECKING =====

test('ORDER_STATUS_CHECKING: có trong mẫu mặc định (seed) và có lời dự phòng trong engine', () => {
  assert.ok(String(defaultMessageTemplates().ORDER_STATUS_CHECKING || '').trim(), 'seed có mẫu');
  assert.equal(fallbackTemplates.ORDER_STATUS_CHECKING, 'Dạ em đang kiểm tra lại đơn giúp {title}, bạn phụ trách sẽ nhắn lại ngay ạ 💛');
  assert.equal(withFallbackTemplates({}).ORDER_STATUS_CHECKING, fallbackTemplates.ORDER_STATUS_CHECKING);
  // Mẫu trong Cài đặt thắng lời dự phòng; chủ shop để trống ('') vẫn là tắt.
  assert.equal(withFallbackTemplates({ ORDER_STATUS_CHECKING: 'Mẫu riêng' }).ORDER_STATUS_CHECKING, 'Mẫu riêng');
  assert.equal(withFallbackTemplates({ ORDER_STATUS_CHECKING: '' }).ORDER_STATUS_CHECKING, '');
  // Lời dự phòng không kể chi tiết đơn (không có chỗ điền món / tổng tiền / địa chỉ).
  assert.doesNotMatch(fallbackTemplates.ORDER_STATUS_CHECKING, /\{(?:cart|total|address|order|products?)\}/i);
});

test('ORDER_STATUS_CHECKING: cài đặt THIẾU mẫu — khách hỏi đơn + SĐT (đơn ở hội thoại khác) vẫn nhận câu "đang kiểm tra", không kể chi tiết đơn', async () => {
  const seed = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
  delete seed.ORDER_STATUS_CHECKING;
  const templates = withFallbackTemplates(seed);
  const conversation = { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, botLastTemplateId: 'ORDER_STATUS', botLastReplyAt: Date.now() - 60000 };
  const incoming = { id: 'm-1', mid: 'm-1', direction: 'incoming', type: 'text', text: 'mình đã đặt rồi 0909123456', createdAt: Date.now() };
  const recent = [incoming];
  const sent = []; const staffNotes = [];
  const other = { id: 'x9', createdAt: Date.now() - 3 * 60 * 60 * 1000, total: 298000, products: [{ name: 'Granola Túi Xanh 450g', quantity: 2 }], phone: '0909123456' };
  const results = await processChatbotChanges([{ type: 'message', conversation: { ...conversation }, message: incoming }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', complaintKeywords: '', fragmentWaitMs: 0, phoneFragmentWaitMs: 0, messageTemplates: seed, ruleIntent: 'on', experimentalRules: 'on', preGuard: 'off', intentModel: 'off', intentCascade: 'off' }),
    listMessages: async () => [...recent],
    getConversation: async () => conversation,
    saveBotState: async (_id, state) => { Object.assign(conversation, state); },
    sendMessage: async (_c, payload) => { sent.push(payload.text || ''); return { message: { mid: 'x' } }; },
    addStaffNote: async (_c, note) => { staffNotes.push(note); },
    findOrdersByPhone: async () => [other],
    requestReply: async payload => renderChatbotReply({ template_id: 'ORDER_STATUS' }, templates, payload.context || {}),
    appendDecisionLog: () => {}
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(results[0]?.templateId, 'ORDER_STATUS_CHECKING', 'trước đây: thiếu mẫu thì không có câu báo kiểm tra');
  assert.match(sent.join(' '), /đang kiểm tra lại đơn/);
  assert.doesNotMatch(sent.join(' '), /Granola Túi Xanh 450g|298\.000/);
  assert.match(staffNotes.join(' '), /x9/);
});
