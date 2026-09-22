import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { buildChatbotQuery, parseModelAnswer, processChatbotChanges, requestDirectModelReply } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';

// The texts the bot speaks come only from Thiết lập tin nhắn; the shipped
// defaults stand in for a saved settings file here.
const templates = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));

// {title} in the shipped templates renders as the neutral form when gender is unknown.
const neutral = text => text.replaceAll('{Title}', 'Anh/chị').replaceAll('{title}', 'anh/chị');

test('đọc JSON có hàng rào markdown từ mô hình', () => {
  assert.equal(parseModelAnswer('```json\n{"template_id":"WELCOME"}\n```').template_id, 'WELCOME');
  assert.equal(parseModelAnswer('không hợp lệ').template_id, 'CSKH_HANDOFF');
});

test('ngữ cảnh gửi mô hình có lịch sử và tin nhắn hiện tại', () => {
  const query = buildChatbotQuery({
    conversation: { name: 'Lan Anh' },
    message: { text: 'Túi xanh giá bao nhiêu?' },
    recentMessages: [{ direction: 'outgoing', text: 'Giọt Nắng xin chào' }],
    settings: {}
  });
  assert.match(query, /Lan Anh/);
  assert.match(query, /Giọt Nắng xin chào/);
  assert.match(query, /Túi xanh giá bao nhiêu/);
  const remembered = buildChatbotQuery({
    conversation: { name: 'Lan Anh', pendingOrder: { items: [{ product: 'Túi Xanh', quantity: 2 }], phone: '0909123456', address: '' } },
    message: { text: '12 Lê Lợi Q1' }, settings: {}
  });
  assert.match(remembered, /DỮ LIỆU ĐÃ LƯU:\nSản phẩm đang chờ lên đơn: Túi Xanh x2\nSố điện thoại đã có: 0909123456\n\nTIN NHẮN CẦN TRẢ LỜI/);
});

test('gọi Gemini trực tiếp trên Vertex AI', async () => {
  const reply = await requestDirectModelReply({
    settings: {
      provider: 'vertex',
      directApiKey: 'google-token',
      directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
      directModel: 'gemini-2.5-flash',
      systemPrompt: 'Chỉ trả JSON',
      structuredOutput: true,
      retryCount: 0,
      messageTemplates: templates
    },
    conversation: { psid: '123', name: 'Khách' },
    message: { type: 'text', text: 'xin chào' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-2.5-flash:generateContent');
      assert.equal(options.headers.Authorization, 'Bearer google-token');
      const body = JSON.parse(options.body);
      assert.match(body.systemInstruction.parts[0].text, /^Chỉ trả JSON\n\nSẢN PHẨM \(tên chuẩn → cách khách gọi\):\n- Granola Túi Xanh 450g: túi xanh/);
      // Danh sách mẫu tin đọc từ Thiết lập tin nhắn, nối vào sau danh mục.
      assert.match(body.systemInstruction.parts[0].text, /MẪU TIN \(template_id → ý nghĩa\):[\s\S]*- BAG_COMPARISON: các túi bên em đều dùng chung[\s\S]*PRICE_QUOTE dùng cho mọi sản phẩm/);
      assert.equal(body.contents[0].role, 'user');
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"template_id":"WELCOME"}' }] } }] }) };
    }
  });
  assert.equal(reply.templateId, 'WELCOME');
});

test('gọi DeepSeek trực tiếp bằng API OpenAI-compatible', async () => {
  const reply = await requestDirectModelReply({
    settings: {
      provider: 'deepseek', directApiKey: 'deepseek-token', directEndpoint: 'https://api.deepseek.com/chat/completions',
      directModel: 'deepseek-v4-flash', systemPrompt: 'Chỉ trả JSON', structuredOutput: true, retryCount: 0, messageTemplates: templates
    },
    conversation: { psid: '123', name: 'Khách' },
    message: { type: 'text', text: 'xin chào' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer deepseek-token');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'deepseek-v4-flash');
      assert.equal(body.messages[0].role, 'system');
      assert.deepEqual(body.response_format, { type: 'json_object' });
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"template_id":"WELCOME"}' } }] }) };
    }
  });
  assert.equal(reply.templateId, 'WELCOME');
});

test('gọi Claude bằng giao thức Anthropic Messages', async () => {
  const reply = await requestDirectModelReply({
    settings: {
      provider: 'custom', directProtocol: 'anthropic', directApiKey: 'anthropic-token',
      directEndpoint: 'https://api.anthropic.com/v1/messages', directModel: 'claude-sonnet-4-6',
      systemPrompt: 'Chỉ trả JSON', retryCount: 0, messageTemplates: templates
    },
    conversation: { psid: '123', name: 'Khách' },
    message: { type: 'text', text: 'xin chào' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(options.headers['x-api-key'], 'anthropic-token');
      assert.equal(options.headers['anthropic-version'], '2023-06-01');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'claude-sonnet-4-6');
      assert.match(body.system, /^Chỉ trả JSON\n\nSẢN PHẨM \(tên chuẩn → cách khách gọi\):\n- Granola Túi Xanh 450g: túi xanh/);
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"template_id":"WELCOME"}' }] }) };
    }
  });
  assert.equal(reply.templateId, 'WELCOME');
});

test('tắt bộ nhớ không đưa lịch sử vào câu hỏi model', () => {
  const query = buildChatbotQuery({
    conversation: { name: 'Khách' },
    message: { text: 'tin hiện tại' },
    recentMessages: [{ direction: 'incoming', text: 'tin cũ' }],
    settings: { memoryEnabled: false }
  });
  assert.doesNotMatch(query, /tin cũ/);
});

test('chỉ tự trả lời khi cả hệ thống và hội thoại đều bật bot', async () => {
  const sent = [];
  const state = [];
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', psid: 'user', name: 'Khách', botEnabled: true },
    message: { direction: 'incoming', type: 'text', text: 'xin chào' }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', provider: 'vertex', directApiKey: 'secret', handoffKeywords: '' }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => sent.push(message.text),
    saveBotState: async (_id, value) => state.push(value),
    requestReply: async () => ({ templateId: 'WELCOME', messages: ['Xin chào'], conversationId: '', handoff: false })
  });
  assert.equal(result[0].templateId, 'WELCOME');
  assert.deepEqual(sent, ['Xin chào']);
  assert.equal(state[0].botConversationId, '');
});

test('đơn được lưu trước, rồi mới gửi xác nhận và receipt sau cùng', async () => {
  const log = [];
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', psid: 'user', name: 'Khách', botEnabled: true },
    message: { id: 'mid.customer.1', mid: 'mid.customer.1', direction: 'incoming', type: 'text', text: 'chốt đơn' }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '' }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => { log.push(`send:${message.text}`); return { message: { mid: 'mid.bot.1' } }; },
    sendReceipt: async (_conversation, order) => { log.push(`receipt:${order.id}`); },
    saveBotState: async () => {},
    requestReply: async () => ({
      templateId: 'ORDER_CONFIRMATION', messages: ['Xác nhận đơn'], handoff: false,
      order: { items: [{ product: 'Túi Xanh', code: 'GRA-XANH-Z450', quantity: 2 }], phone: '0909123456', address: 'Quận 12', total: 298000, shippingFee: 0 }
    }),
    createOrder: async (_conversation, order, context) => {
      log.push(`create:${context.sourceMessageId}`);
      return { order: { id: 'AUTO-01', ...order }, created: true };
    }
  });
  assert.deepEqual(log, ['create:mid.customer.1', 'send:Xác nhận đơn', 'receipt:AUTO-01']);
  assert.equal(result[0].orderId, 'AUTO-01');
});

test('khách xác nhận lần hai không tạo đơn trùng và không gửi lại', async () => {
  const log = [];
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', psid: 'user', name: 'Khách', botEnabled: true },
    message: { id: 'mid.customer.2', mid: 'mid.customer.2', direction: 'incoming', type: 'text', text: 'ok chốt' }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '' }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => { log.push(`send:${message.text}`); },
    sendReceipt: async () => { log.push('receipt'); },
    saveBotState: async () => {},
    requestReply: async () => ({ templateId: 'ORDER_CONFIRMATION', messages: ['Xác nhận đơn'], handoff: false, order: { items: [], phone: '0909123456', address: 'x', total: 1 } }),
    createOrder: async () => ({ order: { id: 'AUTO-01' }, created: false })
  });
  assert.deepEqual(log, []);
});

test('tắt tự động lên đơn: bot vẫn trả lời nhưng không gọi createOrder và không gửi receipt', async () => {
  const log = [];
  let savedState = null;
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', psid: 'user', name: 'Khách', botEnabled: true },
    message: { id: 'mid.customer.1', mid: 'mid.customer.1', direction: 'incoming', type: 'text', text: 'chốt đơn' }
  }], {
    readSettings: async () => ({ enabled: true, autoOrder: false, responseMode: 'automatic', handoffKeywords: '' }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => { log.push(`send:${message.text}`); return { message: { mid: 'mid.bot.1' } }; },
    sendReceipt: async (_conversation, order) => { log.push(`receipt:${order.id}`); },
    saveBotState: async (_id, state) => { savedState = state; },
    requestReply: async () => ({
      templateId: 'ORDER_CONFIRMATION', messages: ['Xác nhận đơn'], handoff: false,
      order: { items: [{ product: 'Túi Xanh', code: 'GRA-XANH-Z450', quantity: 2 }], phone: '0909123456', address: 'Quận 12', total: 298000, shippingFee: 0 }
    }),
    createOrder: async (_conversation, _order, context) => {
      log.push(`create:${context.sourceMessageId}`);
      return { order: { id: 'AUTO-01' }, created: true };
    }
  });
  assert.deepEqual(log, ['send:Xác nhận đơn']);
  assert.equal(result[0].orderId, undefined);
  assert.equal(savedState.pendingOrder.phone, '0909123456');
  assert.equal(savedState.pendingOrder.address, 'Quận 12');
});

const fullAddress = '176/1A KP1, An Phú Đông, Quận 12, TP.HCM';

test('xác nhận đơn tính giá từ danh mục: 2 túi giá combo, miễn ship', () => {
  const reply = renderChatbotReply({
    template_id: 'ORDER_CONFIRMATION',
    Product_N1: 'Túi Xanh', No_A: '2',
    Phone_Number: '0909123456', Customer_Address: fullAddress
  }, templates);
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.equal(reply.order.total, 298000);
  assert.equal(reply.order.items[0].code, 'GRA-XANH-Z450');
  assert.match(reply.messages[0], /298\.000đ/);
  assert.doesNotMatch(reply.messages[0], /Phí vận chuyển/);
  // Địa chỉ trong tin xác nhận và trên đơn là tên chuẩn của kho; bản khách gõ giữ ở rawAddress.
  assert.match(reply.messages[0], /176\/1A KP1, Phường An Phú Đông, Quận 12, TP Hồ Chí Minh/);
  assert.equal(reply.order.address, '176/1A KP1, Phường An Phú Đông, Quận 12, TP Hồ Chí Minh');
  assert.equal(reply.order.rawAddress, fullAddress);
});

test('địa chỉ thiếu phường hoặc tên đường: bot hỏi đúng phần thiếu rồi mới chốt', () => {
  const asked = renderChatbotReply({
    template_id: 'ORDER_CONFIRMATION',
    Product_N1: 'Túi Xanh', No_A: '2',
    Phone_Number: '0909123456', Customer_Address: 'Quận 12, TP.HCM'
  }, templates);
  assert.equal(asked.templateId, 'ORDER_ADDRESS');
  assert.equal(asked.order, undefined);
  assert.match(asked.messages[0], /Quận 12, TP Hồ Chí Minh/);
  assert.match(asked.messages[0], /phường\/xã và tên đường/);
  assert.equal(asked.pendingOrder.addressAsks, 1);
  assert.equal(asked.pendingOrder.address, 'Quận 12, TP.HCM');
  // Khách trả lời phần thiếu: được ghép vào địa chỉ đã lưu và chốt đơn.
  const done = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Customer_Address: '176/1A KP1, An Phú Đông' }, templates, { pendingOrder: asked.pendingOrder });
  assert.equal(done.templateId, 'ORDER_CONFIRMATION');
  assert.equal(done.order.address, '176/1A KP1, Phường An Phú Đông, Quận 12, TP Hồ Chí Minh');
  assert.equal(done.order.total, 298000);
  // Chỉ có số nhà: vẫn hỏi tên đường.
  const numberOnly = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '2', Phone_Number: '0909123456', Customer_Address: '12, Phường Bến Nghé, Quận 1, HCM' }, templates);
  assert.equal(numberOnly.templateId, 'ORDER_ADDRESS');
  assert.match(numberOnly.messages[0], /tên đường/);
});

test('hai xã cùng tên: bot đưa hai lựa chọn, khách chọn xong thì chốt', () => {
  const asked = renderChatbotReply({
    template_id: 'ORDER_CONFIRMATION',
    Product_N1: 'Túi Xanh', No_A: '2',
    Phone_Number: '0909123456', Customer_Address: 'Thôn 3, Xa Hoang Dong, Huyen Hoang Hoa, Thanh Hoa'
  }, templates);
  assert.equal(asked.templateId, 'ORDER_ADDRESS');
  assert.match(asked.messages[0], /Xã Hoằng Đ(ồng|ông) hay Xã Hoằng Đ(ồng|ông)/);
  const done = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Customer_Address: 'Hoằng Đồng' }, templates, { pendingOrder: asked.pendingOrder });
  assert.equal(done.templateId, 'ORDER_CONFIRMATION');
  assert.equal(done.order.address, 'Thôn 3, Xã Hoằng Đồng, Huyện Hoằng Hóa, Thanh Hóa');
});

test('đã hỏi một lần, khách trả lời bằng địa chỉ đầy đủ có phường/huyện mà máy vẫn không khớp: nhận luôn, không hỏi lại y câu cũ', () => {
  const pending = { items: [{ product: 'Túi Xanh', quantity: 2 }], key: 'GRA-XANH-Z450=2', at: Date.now(), phone: '0909123456', address: 'Hà Nội', addressAsks: 1 };
  const full = 'số 5 ngõ 12, phường Hòa Bình Mới, quận Trung Tâm, Hà Nội';
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Customer_Address: full }, templates, { pendingOrder: pending });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION', 'không hỏi lần hai khi khách đã ghi đủ cấp');
  assert.equal(reply.order.address, full, 'giữ nguyên văn khách ghi cho nhân viên đối chiếu');
  // Khách chỉ nhắn một mẩu ("Hà Nội") thì vẫn hỏi tiếp như cũ.
  const fragment = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Customer_Address: 'quận Trung Tâm' }, templates, { pendingOrder: pending });
  assert.equal(fragment.templateId, 'ORDER_ADDRESS');
});

test('hỏi tối đa hai lần rồi vẫn lên đơn với địa chỉ khách đưa', () => {
  const pending = { items: [{ product: 'Túi Xanh', quantity: 2 }], key: 'GRA-XANH-Z450=2', at: Date.now(), phone: '0909123456', address: 'gần chợ Bà Chiểu', addressAsks: 2 };
  const reply = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '2', Phone_Number: '0909123456', Customer_Address: 'gần chợ Bà Chiểu' }, templates, { pendingOrder: pending });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.equal(reply.order.address, 'gần chợ Bà Chiểu');
});

test('xác nhận đơn 1 túi cộng phí vận chuyển', () => {
  const reply = renderChatbotReply({
    template_id: 'ORDER_CONFIRMATION',
    Product_N1: 'Túi Xanh', No_A: '1',
    Phone_Number: '0909123456', Customer_Address: fullAddress
  }, templates);
  assert.equal(reply.order.total, 189000);
  assert.equal(reply.order.shippingFee, 15000);
  assert.match(reply.messages[0], /🚚 Phí vận chuyển: 15\.000đ/);
});

test('mẫu giá được soạn từ danh mục; không có text tĩnh nào để ghi đè', () => {
  // Text cũ lưu dưới mã PRICE_TUI_XANH không bao giờ được dùng: giá luôn từ danh mục.
  const quote = renderChatbotReply({ template_id: 'PRICE_TUI_XANH' }, { ...templates, PRICE_TUI_XANH: 'Túi Xanh 999.000đ' });
  assert.doesNotMatch(quote.messages[0], /999/);
  assert.equal(quote.templateId, 'PRICE_TUI_XANH');
  assert.match(quote.messages[0], /Giá niêm yết: 174\.000đ \+ Phí vận chuyển 15\.000đ[\s\S]*Giảm còn: 298\.000đ \(Miễn phí vận chuyển\)/);
  const general = renderChatbotReply({ template_id: 'GENERAL_INFO' }, templates);
  assert.match(general.messages[0], /Granola Túi Xanh 450g: 174\.000đ/);
  const unknown = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'sữa hạt' }, templates);
  assert.equal(unknown.messages[0], neutral(templates.ASK_PRODUCT));
});

test('lời bot nói đọc từ Thiết lập tin nhắn, không có bản mặc định trong code', () => {
  const reply = renderChatbotReply({ template_id: 'WELCOME' }, { ...templates, WELCOME: 'Xin chào từ thiết lập' });
  assert.deepEqual(reply.messages, ['Xin chào từ thiết lập']);
  // Không có text trong thiết lập → không có gì để nói → chuyển nhân viên.
  const empty = renderChatbotReply({ template_id: 'WELCOME' }, {});
  assert.equal(empty.templateId, 'CSKH_HANDOFF');
  assert.deepEqual(empty.messages, []);
});

test('mẫu tin bị xóa hoặc bỏ tick không còn được chatbot sử dụng', () => {
  const { WELCOME, ...withoutWelcome } = templates;
  const reply = renderChatbotReply({ template_id: 'WELCOME' }, withoutWelcome);
  assert.equal(reply.templateId, 'CSKH_HANDOFF');
  assert.deepEqual(reply.messages, [templates.CSKH_HANDOFF]);
  assert.deepEqual(reply.images, []);
  const off = renderChatbotReply({ template_id: 'WELCOME' }, { ...templates, WELCOME: '' });
  assert.equal(off.templateId, 'CSKH_HANDOFF');
});

test('tin xác nhận đơn và lời xin địa chỉ điền chỗ trống của mẫu trong thiết lập', () => {
  const custom = { ...templates, ORDER_CONFIRMATION: 'Đơn: [[items]]{product} x{quantity}[[/items]] | {phone} | {address} | {total} ({free_ship})\n🎁 {gift}', ORDER_AFTER_SALE: '', ORDER_ADDRESS_PARTIAL: 'Có {known}, thiếu {missing}.' };
  const reply = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '3', Phone_Number: '0909123456', Customer_Address: fullAddress }, custom);
  assert.deepEqual(reply.messages, [
    'Đơn: Granola Túi Xanh 450g x3 | 0909123456 | 176/1A KP1, Phường An Phú Đông, Quận 12, TP Hồ Chí Minh | 447.000đ (Miễn phí vận chuyển)\n🎁 Bộ bát gáo dừa + Muỗng dừa',
    neutral(templates.SHIPPING_POLICY)
  ]);
  assert.deepEqual(reply.images, []);
  const partial = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '1', Phone_Number: '0909123456' }, custom);
  assert.deepEqual(partial.messages, ['Có số điện thoại, thiếu địa chỉ nhận hàng đầy đủ.']);
});
