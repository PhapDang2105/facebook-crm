// Vòng 14 (03/10) — agent "luat": luật nhận ý (rule-intent.mjs), từ khoá khiếu nại (auto-label.mjs), Siêu Hạt (catalog.mjs).
// Mọi câu dưới đây là câu khách thật 02–03/10 (r14 out-inbox1/2/3, out-comments, out-dl); không tên khách, không SĐT thật.
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { commentBasket } from '../app/chatbot-engine.mjs';
import { COMMENT_DISLIKE, ruleIntent, TROPICAL_MENTION, core } from '../app/processing/rule-intent.mjs';
import { autoLabelEventsFor, foldVietnamese, isComplaint } from '../app/processing/auto-label.mjs';
import { matchStaffOnlyProduct } from '../app/processing/catalog.mjs';

const inbox = extra => ({ source: 'inbox', botLastTemplateId: '', botLastAgeMin: Infinity, bundleSize: 1, commentBasket, experimentalRules: 'on', ...extra });
const held = extra => inbox({ hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 2, ...extra });
const tpl = result => result?.value?.also || result?.value?.template_id || null;
const fold = text => foldVietnamese(text).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

test('#1 hỏi bỏ quà có giảm tiền không (…455261) không xóa giỏ; nhắc quà → GIFT_SWAP; "Thôi dẹp khỏi mua" là rút giỏ', () => {
  const ask = ruleIntent('C có bắt gáo dừa ròi\nC ko lấy nữa thì có giảm tiền ko', held());
  assert.equal(ask?.rule, 'GIFT_SWAP');
  assert.equal(tpl(ask), 'GIFT_SWAP');
  assert.ok(!ask.clearBasket);
  // Câu điều kiện không nhắc quà: không áp CANCEL_BASKET (để mô hình).
  const plain = ruleIntent('C ko lấy nữa thì có giảm tiền ko', held());
  assert.ok(!plain?.clearBasket, JSON.stringify(plain));
  assert.notEqual(plain?.rule, 'CANCEL_BASKET');
  for (const text of ['Thôi dẹp khỏi mua', 'thôi khỏi lấy']) {
    const cancel = ruleIntent(text, held({ livestream: true }));
    assert.equal(cancel?.rule, 'CANCEL_BASKET', text);
    assert.ok(cancel.clearBasket, text);
  }
  // Rút giỏ rõ vẫn như cũ.
  assert.equal(ruleIntent('không lấy nữa', held())?.rule, 'CANCEL_BASKET');
});

test('#2 "Dạ mua 2 bich giá 189k thôi ạ" (…762063) không phải "đã mua" → không ORDER_STATUS; "đã mua rồi sao chưa thấy" vẫn tra đơn', () => {
  const result = ruleIntent('Dạ mua 2 bich  giá 189k thôi ạ', inbox({ hasRecentOrder: true, orderAgeMin: 3000 }));
  assert.notEqual(tpl(result), 'ORDER_STATUS', JSON.stringify(result));
  assert.equal(tpl(ruleIntent('Mình đã mua rồi sao chưa thấy hàng', inbox())), 'ORDER_STATUS');
});

test('#3 LIVE_DEAL: phủ định / hỏi cách săn / tin có giỏ không phải "đã săn deal"; "Đã săn 290k" vẫn đúng', () => {
  const live = held({ livestream: true });
  for (const text of ['Mình ko săn deal trên live', 'Mình ko săn deal trên live\n1 xanh+1 nâu']) {
    assert.notEqual(ruleIntent(text, live)?.rule, 'LIVE_DEAL', text);
  }
  assert.notEqual(ruleIntent('Săn ntn ạh', { source: 'comment', livestream: true, commentBasket })?.rule, 'LIVE_DEAL');
  assert.equal(tpl(ruleIntent('Đã săn 290k', inbox({ livestream: true }))), 'LIVE_DEAL_CLAIMED');
});

test('#4 "Đặt trên ap r … giao tới đâu r / Đặt 3 bịch" (…603949) là hỏi đơn đã đặt, không phải đơn mới 3 túi', () => {
  const ctx = inbox({ botLastTemplateId: 'ORDER_STATUS', botLastAgeMin: 5 });
  for (const text of ['Gọi đt có đc đâu\nĐặt trên ap r nhưng làm sao đê biết hàng giao tới đâu r\nĐặt 3 bịch', 'Gọi đt có đc đâu\nĐặt trên ap r nhưng làm sao đê biết hàng giao tới đâu r']) {
    const result = ruleIntent(text, ctx);
    assert.equal(tpl(result), 'ORDER_STATUS', text);
    assert.ok(!result.value.Customer_Address, text);
  }
  // Tắt luật thử: luật giỏ BAGS_ADDRESS cũng không bắt.
  assert.notEqual(ruleIntent('Gọi đt có đc đâu\nĐặt trên ap r nhưng làm sao đê biết hàng giao tới đâu r\nĐặt 3 bịch', { ...ctx, experimentalRules: 'off' })?.rule, 'BAGS_ADDRESS');
  // "ấp" thật trong địa chỉ vẫn là địa chỉ.
  const address = ruleIntent('2 túi. ấp 3 xã Khánh Bình Tây huyện Trần Văn Thời Cà Mau', inbox());
  assert.equal(address?.rule, 'BAGS_ADDRESS', JSON.stringify(address));
});

test('#5 "sữa chua không đường" không phải hỏi đường; tin đặt "Hộp 10 gói và 1 túi xanh" không ra PACKAGING_INFO / không mất hộp; "bn tiền" không chỉ trả trọng lượng', () => {
  const live = inbox({ livestream: true, botLastTemplateId: 'LIVESTREAM_COMMENT', botLastAgeMin: 5 });
  assert.notEqual(tpl(ruleIntent('Loại nào ăn luôn được với sữa chua không đường', live)), 'NO_ADDED_SUGAR');
  assert.equal(tpl(ruleIntent('Granola có đường không', inbox())), 'NO_ADDED_SUGAR');
  const order = ruleIntent('Hộp 10 gói  và 1 túi xanh nguyên bản', inbox());
  assert.notEqual(tpl(order), 'PACKAGING_INFO', JSON.stringify(order));
  assert.ok(!(order?.value?.Product_N1 && !order.value.Product_N2), 'không lên giỏ chỉ 1 Túi Xanh (mất hộp 10 gói)');
  // "combo 10 gói xanh" từng thành 10 Túi Xanh.
  assert.notEqual(ruleIntent('combo 10 gói xanh', inbox())?.value?.No_A, '10');
  assert.equal(ruleIntent('lấy 1 hộp 10 gói xanh', inbox())?.value?.Product_N1, 'Combo 10 gói Xanh');
  assert.equal(tpl(ruleIntent('có hộp 10 gói không', inbox())), 'PACKAGING_INFO');
  // R16 (sửa test cũ — inbox3 A7): nay luật trả lời CẢ HAI ý — PRICE_COUNT (giá 2 túi) + ý phụ WEIGHT_EXPIRY; ý test giữ nguyên
  // ("bn tiền" không CHỈ trả trọng lượng).
  const weightPrice = ruleIntent('2 túi trọng luong bn và bn tiền ạ', inbox({ botLastTemplateId: 'GENERAL_INFO', botLastAgeMin: 5 }));
  assert.equal(weightPrice?.value?.template_id, 'PRICE_COUNT');
  assert.equal(weightPrice?.value?.also, 'WEIGHT_EXPIRY');
  assert.equal(tpl(ruleIntent('túi xanh bao nhiêu gram', inbox())), 'WEIGHT_EXPIRY');
});

test('#6 TROPICAL: câu so sánh / ý đặt thêm không trả bảng giá Tropical; "trắng dâu", "xanh premium", "granola premium 300g" là Tropical (không phải Siêu Hạt)', () => {
  assert.notEqual(ruleIntent('Loại màu nâu và xanh mịn là như nào e', held({ livestream: true }))?.rule, 'TROPICAL');
  assert.notEqual(ruleIntent('Thêm 1 túi màu  xanh nhe em là 3 tui\nTúi có dâu  để ăn thử', inbox({ hasRecentOrder: true, orderAgeMin: 30 }))?.rule, 'TROPICAL');
  for (const text of ['Túi xanh Premium ạ', 'Mình mún mua granola premium 300g', 'Túi có dâu để ăn thử']) {
    const result = ruleIntent(text, inbox({ botLastTemplateId: 'WELCOME', botLastAgeMin: 5 }));
    assert.equal(result?.rule, 'TROPICAL', text);
    assert.equal(result.value.Product_N1, 'Granola Tropical vị Cacao 300g', text);
  }
  assert.equal(ruleIntent('lấy 2 túi dâu', inbox())?.rule, 'TROPICAL_BASKET');
  // Bình luận: engine đọc TROPICAL_MENTION trên chữ bỏ dấu.
  assert.ok(TROPICAL_MENTION.test(fold('Màu trắng dâu nhieu')));
  assert.ok(!TROPICAL_MENTION.test(fold('xem trang đầu')));
  assert.equal(matchStaffOnlyProduct('Mình mún mua granola premium 300g'), null);
  assert.equal(matchStaffOnlyProduct('Granola Siêu Hạt Premium 420g giá sao')?.id, 'sieu-hat-premium');
  assert.equal(matchStaffOnlyProduct('granola premium bao nhiêu')?.id, 'sieu-hat-premium');
  // "a có đặt đơn 2 túi đâu" (đâu = phủ định) từng lên giỏ 2 Tropical.
  assert.notEqual(ruleIntent('Em kiểm tra lại tin nhắn a có đặt đơn 2 túi đâu', inbox())?.rule, 'TROPICAL_BASKET');
});

test('#7 khiếu nại quảng cáo / "dở": isComplaint, COMMENT_DISLIKE, luật hộp thư; chê hàng CHỖ KHÁC không gắn Khiếu nại/Bảo hành', () => {
  for (const text of ['Không như quảng cáo', 'Em đã từng mua không đúng với quoảng cáo', 'Quảng cáo thì nhìn ngon, mua về mở ra toàn yến mạch', 'Chị đã mua 1 lần nhưng ko đc như quảng cao\nMở ra bên trong toàn yến mạch là nhiều', 'Dỡ', 'dở', 'Hơi dở', 'khác hình quá']) {
    assert.equal(isComplaint({ text }), true, text);
  }
  for (const text of ['Không như quảng cáo', 'Em đã từng mua không đúng với quoảng cáo', 'Quảng cáo thì nhìn ngon, mua về mở ra toàn yến mạch']) {
    assert.ok(COMMENT_DISLIKE.test(fold(text)), text);
  }
  for (const text of ['Đó', 'đỏ', 'bỏ dở', 'Do shop gửi', 'quảng cáo này hay quá', 'Mở ra ăn liền được không']) {
    assert.equal(isComplaint({ text }), false, text);
  }
  assert.equal(ruleIntent('Chị đã mua 1 lần nhưng ko đc như quảng cao\nMở ra bên trong toàn yến mạch là nhiều', inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastAgeMin: 30 }))?.rule, 'COMPLAINT_HANDOFF');
  assert.equal(ruleIntent('Dỡ', inbox({ botLastTemplateId: 'GENERAL_INFO', botLastAgeMin: 5 }))?.rule, 'COMPLAINT_HANDOFF');
  // Ca …727620: kể hàng chỗ khác dở/hôi dầu → không thẻ khiếu nại / bảo hành (thẻ chặn bám đuổi).
  const other = 'C lấy 1 túi đung thử đã nha. Vì c bữa mua một loại ở chổ khác mà về ăn ko ngon, ko dòn, bị hôi dầu';
  assert.equal(isComplaint({ text: other }), false);
  assert.equal(isComplaint({ text: other, templateId: 'OIL_SMELL_WARRANTY' }), false);
  assert.deepEqual(autoLabelEventsFor({ text: other, templateId: 'OIL_SMELL_WARRANTY' }), []);
  assert.ok(!COMMENT_DISLIKE.test(fold(other)));
  // Hàng shop bị hôi dầu vẫn là khiếu nại; dọa "mua bên khác" vẫn là khiếu nại.
  assert.deepEqual(autoLabelEventsFor({ text: 'túi granola bị hôi dầu' }), ['complaint', 'warranty']);
  assert.ok(isComplaint({ text: 'Bên mình không ngon, thôi mua bên khác' }));
});

test('#8 bệnh lý (cao huyết áp, tim mạch, gout, dạ dày) → HEALTH_CAUTION + thẻ; tiểu đường, mẹ bầu giữ mẫu cũ', () => {
  for (const text of ['Chị bị cao huyết áp, ăn OK không em', 'người bị tim mạch ăn được không', 'bị gout ăn được ko', 'đau dạ dày ăn được không shop', 'mua cho bố bị huyết áp cao ăn']) {
    const result = ruleIntent(text, inbox({ livestream: true, botLastTemplateId: 'GENERAL_INFO', botLastAgeMin: 5 }));
    assert.equal(tpl(result), 'HEALTH_CAUTION', text);
    assert.ok(result.attention, text);
  }
  assert.equal(tpl(ruleIntent('người tiểu đường ăn được không', inbox())), 'HEALTH_DIABETES');
  assert.equal(tpl(ruleIntent('mẹ bầu ăn được không', inbox())), 'HEALTH_CONDITION');
  // Đang giữ giỏ, ở bước đơn: giữ bước đơn + trả lời bằng ý phụ.
  assert.equal(tpl(ruleIntent('Chị bị cao huyết áp, ăn OK không em', held())), 'HEALTH_CAUTION');
});

test('#9 TRIAL_ASK: "E gui c 1 tui dùng thử nhé", câu dài có câu đầu xin dùng thử (…727620)', () => {
  const ctx = inbox({ botLastTemplateId: 'ASK_FLAVOR', botLastAgeMin: 3 });
  assert.equal(ruleIntent('E gui c 1 tui dùng thử nhé', ctx)?.rule, 'TRIAL_ASK');
  assert.equal(ruleIntent('C lấy 1 túi đung thử đã nha. Vì c bữa mua một loại ở chổ khác mà về ăn ko ngon, ko dòn, bị hôi dầu', inbox({ botLastTemplateId: 'GENERAL_INFO', botLastAgeMin: 3 }))?.rule, 'TRIAL_ASK');
  // Phần sau là câu hỏi / giá → không cắt câu đầu.
  assert.notEqual(ruleIntent('C lấy 1 túi dùng thử đã nha. Mà túi xanh với vàng giá bao nhiêu vậy em ơi cho chị hỏi', ctx)?.rule, 'TRIAL_ASK');
  assert.equal(core('E gui c 1 tui dùng thử nhé'), 'e gui c 1 tui dung thu');
});
