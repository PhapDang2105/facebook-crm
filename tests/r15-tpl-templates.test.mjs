// Vòng 15 (03/10) — mẫu mới (lời dự phòng trong mã + seed) và quyết định chủ shop 03/10 (crm-decisions-r15-0310):
// BOUGHT_ON_MARKETPLACE ("Mình đặt của shop trên tiktok rồi"), BAG_SIZE_INFO, PHONE_LOOKS_SHORT + phoneLooksShort, FRUIT_PAIRING,
// DISCOUNT_OATS_GIFT (mặc cả → tặng yến mạch từ combo 2), ORDER_ADDRESS_OLD_NOT_FOUND, SMALL_PACK_FLAVOURS (combo 10 gói chỉ Xanh),
// ORDER_EXISTING_CONFIRM hỏi gộp/tách. Seed chỉ THÊM mã mới: mẫu đang lưu trong Cài đặt giữ nguyên từng ký tự.
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { readFileSync } from 'node:fs';
import { OATS_GIFT_NAME, defaultMessageTemplates, phoneLooksShort, r15FallbackTemplates, renderChatbotReply, sanitizeModelAnswer } from '../app/chatbot-templates.mjs';
import { normalizeChatbotSettings } from '../app/chatbot-settings.mjs';
import { groupOf, isIntentionalOther } from '../app/processing/intent-cascade.mjs';
import { PHONE, VANG, XANH, basket, templates } from './helpers/r13-engine-sim.mjs';

const NEW_IDS = ['BOUGHT_ON_MARKETPLACE', 'BAG_SIZE_INFO', 'PHONE_LOOKS_SHORT', 'FRUIT_PAIRING', 'DISCOUNT_OATS_GIFT', 'ORDER_ADDRESS_OLD_NOT_FOUND', 'SMALL_PACK_FLAVOURS'];
const text = reply => reply.messages.join('\n');
const female = { customer: { gender: 'female' } };

test('mẫu mới có trong seed, cùng lời với lời dự phòng trong mã; giọng "em", kết "ạ"', () => {
  const seed = defaultMessageTemplates();
  for (const id of [...NEW_IDS, 'ORDER_EXISTING_CONFIRM']) {
    assert.equal(seed[id], r15FallbackTemplates[id], id);
    assert.match(seed[id], /\bem\b/, id);
    assert.match(seed[id], /ạ/, id);
  }
});

test('lời dự phòng: bộ mẫu thiếu mã mới vẫn trả đúng mẫu (không rơi về GENERAL_INFO); mẫu trống trong Cài đặt vẫn là tắt', () => {
  const old = Object.fromEntries(Object.entries(templates).filter(([id]) => !NEW_IDS.includes(id)));
  const reply = renderChatbotReply({ template_id: 'BOUGHT_ON_MARKETPLACE' }, old, female);
  assert.equal(reply.templateId, 'BOUGHT_ON_MARKETPLACE');
  assert.match(text(reply), /cảm ơn chị đã ủng hộ nhà Nắng trên sàn.*mã đơn/s);
  assert.equal(renderChatbotReply({ template_id: 'FRUIT_PAIRING' }, old, female).templateId, 'FRUIT_PAIRING');
  const off = renderChatbotReply({ template_id: 'FRUIT_PAIRING' }, { ...old, FRUIT_PAIRING: '' }, female);
  assert.notEqual(off.templateId, 'FRUIT_PAIRING');
});

test('BAG_SIZE_INFO: túi lớn nhất Túi Xanh 450g; combo 3 túi 1,35kg 447.000đ miễn ship + bát + muỗng (số liệu từ bảng giá)', () => {
  const reply = renderChatbotReply({ template_id: 'BAG_SIZE_INFO' }, templates, female);
  assert.equal(reply.templateId, 'BAG_SIZE_INFO');
  const said = text(reply);
  assert.match(said, /Túi Xanh 450g/);
  assert.match(said, /1,35kg/);
  assert.match(said, /447\.000đ/);
  assert.match(said, /Miễn phí vận chuyển/);
  assert.match(said, /bát gáo dừa.*Muỗng dừa/i);
});

test('FRUIT_PAIRING / SMALL_PACK_FLAVOURS / ORDER_ADDRESS_OLD_NOT_FOUND: lời ngắn, combo 10 gói chỉ nói vị Xanh', () => {
  assert.match(text(renderChatbotReply({ template_id: 'FRUIT_PAIRING' }, templates, female)), /thanh long, chuối, táo.*sữa chua hoặc sữa hạt/s);
  const pack = text(renderChatbotReply({ template_id: 'SMALL_PACK_FLAVOURS' }, templates, female));
  // R17 (chủ shop 10/10, quyết định 1): Combo 10 gói Cam bán lại (Nâu / Mix vẫn tắt).
  assert.match(pack, /có 2 vị: Xanh nguyên bản .* và Cam/);
  assert.doesNotMatch(pack, /Nâu|chỉ còn/);
  // Mẫu engine tự chọn: renderChatbotReply vẫn soạn được khi engine gọi tên.
  assert.match(text(renderChatbotReply({ template_id: 'ORDER_ADDRESS_OLD_NOT_FOUND' }, templates, female)), /chưa tìm thấy địa chỉ cũ.*địa chỉ nhận hàng/s);
});

test('phoneLooksShort: 9 số mở bằng 0 hay 8 số sau +84/84; SĐT đủ / số khác → rỗng', () => {
  assert.equal(phoneLooksShort('sđt chị 091234567 nha'), '091234567');
  assert.equal(phoneLooksShort('0912 345 67'), '091234567');
  assert.equal(phoneLooksShort('+8491234567'), '+8491234567');
  assert.equal(phoneLooksShort('84912345 67'), '8491234567');
  assert.equal(phoneLooksShort(`sđt ${PHONE}`), '');
  assert.equal(phoneLooksShort('2 túi 298000'), '');
  assert.equal(phoneLooksShort('số 012345678 đường 5'), '');
  assert.equal(phoneLooksShort('mã đơn 0912345678912'), '');
});

test('PHONE_LOOKS_SHORT: {phone} từ engine (values.phone) hay đọc từ tin; mô hình không được tự gọi (mẫu nội bộ)', () => {
  const fromEngine = renderChatbotReply({ template_id: 'PHONE_LOOKS_SHORT', values: { phone: '091234567' } }, templates, female);
  assert.equal(text(fromEngine), 'Dạ số điện thoại 091234567 hình như còn thiếu 1 số, chị kiểm tra lại giúp em nha ạ.');
  const fromText = renderChatbotReply({ template_id: 'PHONE_LOOKS_SHORT' }, templates, { ...female, messageText: 'sdt 0912 345 67' });
  assert.match(text(fromText), /091234567 hình như còn thiếu 1 số/);
  assert.equal(sanitizeModelAnswer({ template_id: 'PHONE_LOOKS_SHORT' }).template_id, 'GENERAL_INFO');
});

test('DISCOUNT_OATS_GIFT: không giảm giá; giỏ từ 2 túi → báo miễn ship + nhắc giỏ; dưới 2 túi → mời combo 2 túi 298k miễn ship (không tặng yến mạch)', () => {
  const two = renderChatbotReply({ template_id: 'DISCOUNT_OATS_GIFT' }, templates, { ...female, now: Date.now(), pendingOrder: basket([XANH(1), VANG(1)]) });
  const twoText = text(two);
  assert.equal(two.templateId, 'DISCOUNT_OATS_GIFT');
  assert.match(twoText, /giá tốt nhất/);
  assert.match(twoText, /miễn phí vận chuyển/);
  assert.doesNotMatch(twoText, /yến mạch/i);
  assert.match(twoText, /Giỏ của mình: 1 Granola Túi Xanh 450g \+ 1 Granola Túi Vàng 350g – 298\.000đ/);
  assert.doesNotMatch(twoText, /500g/);
  const one = text(renderChatbotReply({ template_id: 'DISCOUNT_OATS_GIFT' }, templates, { ...female, now: Date.now(), pendingOrder: basket([VANG(1)]) }));
  assert.match(one, /lấy từ combo 2 túi \(298\.000đ, miễn phí vận chuyển\)/);
  assert.doesNotMatch(one, /yến mạch/i);
});

test('pendingOrder.oatsGift: không tặng yến mạch, không có dòng quà yến mạch trên giỏ hay đơn', () => {
  const address = '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
  const context = oats => ({ ...female, now: Date.now(), pendingOrder: { ...basket([XANH(1), VANG(1)]), phone: PHONE, address, ...(oats ? { oatsGift: true } : {}) }, messageText: 'ok chốt' });
  const plain = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION' }, templates, context(false));
  const gifted = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION' }, templates, context(true));
  assert.equal(gifted.templateId, 'ORDER_CONFIRMATION', JSON.stringify(gifted));
  assert.equal(gifted.order.total, plain.order.total);
  assert.doesNotMatch(String(gifted.order?.gift || ''), /Yến mạch/i);
  assert.doesNotMatch(text(gifted), /Yến mạch/i);
  const cart = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, { ...female, now: Date.now(), pendingOrder: { ...basket([XANH(2)]), oatsGift: true }, messageText: 'lấy 2 túi xanh' });
  assert.doesNotMatch(text(cart), /Yến mạch/i);
  const single = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION' }, templates, { ...female, now: Date.now(), pendingOrder: { ...basket([XANH(1)]), phone: PHONE, address, oatsGift: true }, messageText: 'ok' });
  assert.doesNotMatch(String(single.order?.gift || ''), /Yến mạch/i);
});

test('ORDER_EXISTING_CONFIRM (seed + dự phòng): hỏi gộp vào đơn đang có hay tách đơn mới', () => {
  const seed = defaultMessageTemplates().ORDER_EXISTING_CONFIRM;
  assert.match(seed, /gộp \{cart\} vào đơn đang có, hay tách thành đơn mới \(em gửi cùng địa chỉ cũ\)/);
});

test('bảng nhóm intent-cascade: mẫu mới không vào ANSWER', () => {
  for (const id of NEW_IDS) {
    assert.ok(!['ANSWER'].includes(groupOf(id)), id);
    assert.ok(groupOf(id) !== 'OTHER' || isIntentionalOther(id), `${id} phải có nhóm hay OTHER có chủ ý`);
  }
  assert.equal(groupOf('BOUGHT_ON_MARKETPLACE'), 'SUPPORT');
  assert.equal(groupOf('PHONE_LOOKS_SHORT'), 'ORDER');
});

test('normalize: cài đặt cũ (thiếu mã mới, mẫu đã sửa lời) giữ nguyên từng ký tự, chỉ thêm mã mới từ seed', () => {
  const seed = defaultMessageTemplates();
  const stored = Object.fromEntries(Object.entries(seed).filter(([id]) => !NEW_IDS.includes(id)).map(([id, value]) => [id, `${value} (lời chủ shop)`]));
  stored.ORDER_EXISTING_CONFIRM = 'Dạ {title} đang có đơn {existing_items}, mình muốn đặt THÊM đúng không ạ?';
  const normalized = normalizeChatbotSettings({ messageTemplates: stored }).messageTemplates;
  for (const [id, value] of Object.entries(stored)) assert.equal(normalized[id], value, id);
  for (const id of NEW_IDS) assert.equal(normalized[id], seed[id].trim(), id);
});

test('prompt mẫu (docs/system-prompt.txt): Tropical thay "xanh dương, dâu sấy → LIVE_ONLY_PRODUCT"; nêu các mẫu mới', () => {
  const prompt = readFileSync(new URL('../docs/system-prompt.txt', import.meta.url), 'utf8');
  assert.doesNotMatch(prompt, /xanh dương, dâu sấy/);
  assert.match(prompt, /dâu \(tây\) sấy = Granola Tropical vị Cacao 300g/);
  for (const id of ['BOUGHT_ON_MARKETPLACE', 'BAG_SIZE_INFO', 'FRUIT_PAIRING', 'SMALL_PACK_FLAVOURS', 'DISCOUNT_OATS_GIFT', 'LIVESTREAM_VOUCHER', 'COMPLAINT_SORRY']) assert.match(prompt, new RegExp(`\\b${id}\\b`), id);
  assert.doesNotMatch(prompt, /PHONE_LOOKS_SHORT|ORDER_ADDRESS_OLD_NOT_FOUND/);
});

test('PRICE_COUNT (inbox1 A5, "Khách quen… 3 túi xanh"): named → không hỏi lại "vị nào"; pick / không cờ → hỏi vị; mẫu cũ đang chạy vẫn soạn được', () => {
  const base = { count: '3', total: '447.000đ', ship: '', free: '1', gift: 'Bộ bát gáo dừa + Muỗng dừa' };
  const named = text(renderChatbotReply({ template_id: 'PRICE_COUNT', values: { ...base, kind: 'Granola Túi Xanh 450g', named: '1' } }, templates, female));
  assert.match(named, /3 túi \(Granola Túi Xanh 450g\) giá 447\.000đ, miễn phí vận chuyển, tặng Bộ bát gáo dừa \+ Muỗng dừa ạ/);
  assert.match(named, /Chị lấy luôn 3 Granola Túi Xanh 450g để em lên đơn/);
  assert.doesNotMatch(named, /vị nào/);
  const pick = text(renderChatbotReply({ template_id: 'PRICE_COUNT', values: { ...base, kind: 'túi Xanh / Vàng mix tùy ý', pick: '1' } }, templates, female));
  assert.match(pick, /Chị lấy 3 túi vị nào để em lên đơn/);
  // Engine gọi không kèm cờ (kind "mix vị tùy ý") → như pick.
  assert.match(text(renderChatbotReply({ template_id: 'PRICE_COUNT', values: { ...base, kind: 'mix vị tùy ý' } }, templates, female)), /lấy 3 túi vị nào/);
  const running = 'Dạ {count} túi ({kind}) giá {total}[?ship] + phí ship {ship}[/?][?free], miễn phí vận chuyển[/?][?gift], tặng {gift}[/?] ạ 🌾 {Title} lấy {count} túi vị nào để em lên đơn liền cho mình nha?';
  assert.match(text(renderChatbotReply({ template_id: 'PRICE_COUNT', values: { ...base, kind: 'Granola Túi Xanh 450g', named: '1' } }, { ...templates, PRICE_COUNT: running }, female)), /447\.000đ/);
});
