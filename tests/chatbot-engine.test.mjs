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
  assert.equal(parseModelAnswer('không hợp lệ').template_id, 'GENERAL_INFO', 'JSON hỏng thì gửi bảng giá chung, không chuyển người');
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
  const full = 'số 5 ngõ 12, phường Xyzabc, quận Qwertyu, Hà Nội';
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Customer_Address: full }, templates, { pendingOrder: pending });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION', 'không hỏi lần hai khi khách đã ghi đủ cấp');
  assert.match(reply.order.address, /số 5 ngõ 12/, 'giữ phần khách ghi cho nhân viên đối chiếu');
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
  // Mẫu không còn: trả bảng giá chung (không chuyển người, không tắt bot).
  const reply = renderChatbotReply({ template_id: 'WELCOME' }, withoutWelcome);
  assert.equal(reply.templateId, 'GENERAL_INFO');
  assert.equal(reply.handoff, false);
  assert.doesNotMatch(reply.messages.join(' '), /Giọt Nắng xin chào/);
  const off = renderChatbotReply({ template_id: 'WELCOME' }, { ...templates, WELCOME: '' });
  assert.equal(off.templateId, 'GENERAL_INFO');
  // Không có cả GENERAL_INFO thì mới chuyển người.
  const bare = renderChatbotReply({ template_id: 'WELCOME' }, { CSKH_HANDOFF: templates.CSKH_HANDOFF });
  assert.equal(bare.templateId, 'CSKH_HANDOFF');
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
  assert.equal(partial.messages[0], 'Có số điện thoại, thiếu địa chỉ nhận hàng đầy đủ.');
  assert.match(partial.messages[1], /lấy 2 túi/, 'giỏ 1 túi kèm gợi ý lên 2 túi');
});

test('khách gửi ảnh: bot báo đã nhận hình, gắn thẻ cần người xử lý nhưng KHÔNG tắt bot; sticker thì im', async () => {
  const log = [];
  let savedState = null;
  const templatesWithImage = { ...templates, IMAGE_RECEIVED: 'Dạ em đã nhận được hình của mình ạ.' };
  const deps = {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', messageTemplates: templatesWithImage }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => { log.push(`send:${message.text}`); return { message: { mid: 'mid.bot.9' } }; },
    saveBotState: async (_id, state) => { savedState = state; },
    requestReply: async () => { throw new Error('không được gọi mô hình cho ảnh'); }
  };
  await processChatbotChanges([{ type: 'message', conversation: { id: 'page:u9', psid: 'u9', name: 'Khách', botEnabled: true }, message: { id: 'mid.img.1', mid: 'mid.img.1', direction: 'incoming', type: 'image', text: '' } }], deps);
  assert.deepEqual(log, ['send:Dạ em đã nhận được hình của mình ạ.']);
  assert.equal(savedState.botEnabled, undefined, 'bot vẫn bật');
  assert.ok((savedState.addLabelEvents || []).includes('handoff'), 'gắn thẻ cần người xử lý cho nhân viên xem');
  // Ảnh thứ hai liền sau: không nhắn lại lần nữa.
  log.length = 0;
  await processChatbotChanges([{ type: 'message', conversation: { id: 'page:u9', psid: 'u9', botEnabled: true, botLastTemplateId: 'IMAGE_RECEIVED' }, message: { id: 'mid.img.2', mid: 'mid.img.2', direction: 'incoming', type: 'image', text: '' } }], deps);
  assert.deepEqual(log, []);
  // Sticker: im lặng, không chuyển người.
  savedState = null;
  const stickerResult = await processChatbotChanges([{ type: 'message', conversation: { id: 'page:u9', psid: 'u9', botEnabled: true }, message: { id: 'mid.st.1', mid: 'mid.st.1', direction: 'incoming', type: 'sticker', text: '' } }], deps);
  assert.deepEqual(log, []);
  assert.equal(savedState, null);
  assert.equal(stickerResult[0].skipped, 'sticker');
});

test('ORDER_STATUS: kể lại đơn gần nhất trong hội thoại; không có đơn thì xin SĐT để tra', () => {
  const withOrder = renderChatbotReply({ template_id: 'ORDER_STATUS' }, templates, {
    recentOrder: { id: 'A1', createdAt: Date.UTC(2026, 8, 21, 15, 9), total: 298000, products: [{ name: 'Granola Túi Xanh 450g', quantity: 1 }, { name: 'Granola Túi Vàng 350g', quantity: 1 }] },
    customer: { gender: 'female' }
  });
  assert.equal(withOrder.templateId, 'ORDER_STATUS');
  assert.equal(withOrder.handoff, false);
  assert.match(withOrder.messages[0], /Granola Túi Xanh 450g x1, Granola Túi Vàng 350g x1/);
  assert.match(withOrder.messages[0], /22:09 ngày 21\/09/);
  assert.match(withOrder.messages[0], /đã được ghi nhận/);
  const noOrder = renderChatbotReply({ template_id: 'ORDER_STATUS' }, templates, { customer: { gender: 'female' } });
  assert.equal(noOrder.templateId, 'ORDER_STATUS');
  assert.match(noOrder.messages[0], /chưa thấy đơn nào/);
  // Xin gọi điện: vẫn chuyển người nhưng có lời hẹn rõ.
  const callback = renderChatbotReply({ template_id: 'CALLBACK_REQUEST' }, templates, { customer: { gender: 'male' } });
  assert.equal(callback.handoff, true);
  assert.match(callback.messages[0], /gọi lại cho mình/);
});

test('SĐT nằm chung dòng với tên và địa chỉ mà mô hình bỏ sót: đọc từ tin khách, không hỏi lại', () => {
  const reply = renderChatbotReply({
    template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '1', Phone_Number: '0',
    Customer_Address: '3a2/109/52 đường Miếu Hai Xã, phường Dư Hàng Kênh, quận Lê Chân, Hải Phòng'
  }, templates, { messageText: 'ĐỊA CHỈ GỬI HÀNG Vũ Thanh Hải - 0912345678 3a2/109/52 đường Miếu Hai Xã, phường Dư Hàng Kênh, quận Lê Chân, Hải Phòng' });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.equal(reply.order.phone, '0912345678');
});

test('khách để "." hay "ib" dưới bài về một sản phẩm: gửi thẳng bảng giá sản phẩm đó, không hỏi mô hình', async () => {
  const log = [];
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:dot', psid: 'dot', name: 'Khách', botEnabled: true, post: { message: 'GRANOLA TÚI XANH 450g giòn rụm, ưu đãi hôm nay' } },
    message: { id: 'mid.dot.1', mid: 'mid.dot.1', direction: 'incoming', type: 'text', text: '.' }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', messageTemplates: templates }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => { log.push(message.text || '[ảnh]'); return { message: { mid: 'mid.bot.d' } }; },
    saveBotState: async () => {},
    requestReply: async () => { throw new Error('không được gọi mô hình'); }
  });
  assert.equal(result[0].templateId, 'PRICE_QUOTE');
  assert.ok(log.some(text => /Bảng giá Granola Túi Xanh 450g/.test(text)), 'bảng giá đúng sản phẩm của bài viết');
});

test('mã mẫu lạ từ mô hình và giỏ không tính được giá: không chuyển người, không tắt bot', () => {
  const unknown = renderChatbotReply({ template_id: 'MAU_KHONG_TON_TAI' }, templates, { customer: { gender: 'female' } });
  assert.equal(unknown.templateId, 'GENERAL_INFO');
  assert.equal(unknown.handoff, false);
  const flavor = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '5', Phone_Number: '0909123456', Customer_Address: fullAddress }, templates, { customer: { gender: 'female' } });
  assert.equal(flavor.templateId, 'ASK_FLAVOR', '5 túi vượt combo: hỏi vị/số lượng thay vì chuyển người');
  assert.equal(flavor.handoff, false);
  assert.equal(flavor.pendingOrder.phone, '0909123456', 'SĐT đã có vẫn được giữ');
});

test('khách lấy 1 túi: lúc xin SĐT/địa chỉ có gợi ý lên 2 túi với số liệu từ bộ giá, chỉ một lần', () => {
  const first = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '1' }, templates, { customer: { gender: 'female' } });
  assert.equal(first.templateId, 'ORDER_ADDRESS');
  assert.equal(first.messages.length, 2);
  assert.match(first.messages[1], /lấy 2 túi thì giá chỉ còn 149\.000đ\/túi/);
  assert.match(first.messages[1], /miễn phí vận chuyển/);
  assert.match(first.messages[1], /tổng 298\.000đ thay vì 189\.000đ/);
  assert.equal(first.pendingOrder.upsold, true);
  // Đã gợi ý rồi thì lần hỏi tiếp không nhắc lại.
  const second = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Phone_Number: '0909123456' }, templates, { customer: { gender: 'female' }, pendingOrder: first.pendingOrder });
  assert.equal(second.templateId, 'ORDER_ADDRESS');
  assert.equal(second.messages.length, 1);
  // Khách lấy 2 túi thì không có gợi ý.
  const two = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '2' }, templates, { customer: { gender: 'female' } });
  assert.equal(two.messages.length, 1);
});

test('không gửi lại y nguyên tin bot vừa gửi trong 10 phút; SĐT ở tin khách trước đó được đọc lại', async () => {
  const log = [];
  const sameText = 'Dạ em đã nhận được địa chỉ của mình rồi ạ. Chị cho em xin số điện thoại để em lên đơn gửi mình nha ạ.';
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:rep', psid: 'rep', name: 'Khách', botEnabled: true, gender: 'female' },
    message: { id: 'mid.rep.2', mid: 'mid.rep.2', direction: 'incoming', type: 'text', text: 'Gửi rồi mà em' }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', messageTemplates: templates }),
    listMessages: async () => [
      { id: 'mid.rep.0', direction: 'incoming', type: 'text', text: '0909123456', createdAt: Date.now() - 120000 },
      { id: 'mid.bot.r', direction: 'outgoing', type: 'text', text: sameText, createdAt: Date.now() - 60000 },
      { id: 'mid.rep.2', direction: 'incoming', type: 'text', text: 'Gửi rồi mà em', createdAt: Date.now() }
    ],
    sendMessage: async (_conversation, message) => { log.push(message.text); return { message: { mid: 'mid.bot.r2' } }; },
    saveBotState: async () => {},
    requestReply: async () => ({ templateId: 'ORDER_ADDRESS', messages: [sameText], handoff: false })
  });
  assert.deepEqual(log, [], 'câu hỏi y hệt vừa gửi thì không gửi lại');
  assert.equal(result[0].skipped, 'lặp tin vừa gửi');
  const reply = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '2', Phone_Number: '0', Customer_Address: fullAddress }, templates, { customer: { gender: 'female' }, recentCustomerTexts: ['176/1A KP1', '0909123456', 'Gửi rồi mà em'] });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.equal(reply.order.phone, '0909123456');
});

test('Vertex hết hạn mức (429): thử lại lùi dần, vẫn hỏng thì chuyển model dự phòng; lỗi khác không đổi model', async () => {
  const urls = [];
  const settings = (overrides = {}) => ({
    provider: 'vertex', directApiKey: 'google-token', systemPrompt: 'Chỉ trả JSON', structuredOutput: true,
    directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-3-flash-preview:generateContent',
    directModel: 'gemini-3-flash-preview', retryCount: 1, retryIntervalMs: 100, capacityWaitMs: 10, messageTemplates: templates, ...overrides
  });
  const exhausted = { ok: false, status: 429, json: async () => ({ error: { code: 429, message: 'Resource exhausted. Please try again later.' } }) };
  const fine = { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"template_id":"WELCOME"}' }] } }] }) };
  // Lần 3 mới được: vẫn model chính.
  let calls = 0;
  const reply = await requestDirectModelReply({ settings: settings(), conversation: { psid: '1' }, message: { type: 'text', text: 'hi' }, fetchImpl: async url => { urls.push(url); calls += 1; return calls < 3 ? exhausted : fine; } });
  assert.equal(reply.templateId, 'WELCOME');
  assert.equal(urls.length, 3);
  assert.ok(urls.every(url => url.includes('gemini-3-flash-preview')));
  // Model chính hết hạn mức cả 3 lần: sang gemini-2.5-flash.
  urls.length = 0;
  const fallback = await requestDirectModelReply({ settings: settings(), conversation: { psid: '1' }, message: { type: 'text', text: 'hi' }, fetchImpl: async url => { urls.push(url); return url.includes('gemini-2.5-flash') ? fine : exhausted; } });
  assert.equal(fallback.templateId, 'WELCOME');
  assert.deepEqual(urls.map(url => url.includes('gemini-2.5-flash') ? 'dự phòng' : 'chính'), ['chính', 'chính', 'chính', 'dự phòng']);
  // Không đặt model dự phòng: ném lỗi 429 sau 3 lần.
  urls.length = 0;
  await assert.rejects(requestDirectModelReply({ settings: settings({ fallbackModel: '' }), conversation: { psid: '1' }, message: { type: 'text', text: 'hi' }, fetchImpl: async url => { urls.push(url); return exhausted; } }), /Resource exhausted/);
  assert.equal(urls.length, 3);
  // Lỗi 401 không phải hết hạn mức: theo retryCount (2 lần), không đổi model.
  urls.length = 0;
  await assert.rejects(requestDirectModelReply({ settings: settings(), conversation: { psid: '1' }, message: { type: 'text', text: 'hi' }, fetchImpl: async url => { urls.push(url); return { ok: false, status: 401, json: async () => ({ error: { message: 'Unauthenticated' } }) }; } }), /Unauthenticated/);
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => url.includes('gemini-3-flash-preview')));
});

test('hết hạn mức sau mọi lần thử: hẹn chạy lại sau; lúc đó đã có người trả lời thì thôi', async () => {
  const log = [];
  let failures = 1;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deps = (recent = []) => ({
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', capacityRetryDelayMs: 30 }),
    listMessages: async () => recent,
    sendMessage: async (_conversation, message) => { log.push(`send:${message.text}`); return { message: { mid: 'mid.bot' } }; },
    saveBotState: async (_id, state) => { if (state.botLastError) log.push(`error:${state.botLastError}`); },
    requestReply: async () => {
      if (failures-- > 0) throw Object.assign(new Error('Resource exhausted. Please try again later.'), { status: 429 });
      return { templateId: 'WELCOME', messages: ['Dạ em đây ạ'], handoff: false };
    }
  });
  const change = { type: 'message', conversation: { id: 'page:user', psid: 'user', name: 'Khách', botEnabled: true }, message: { id: 'mid.c1', mid: 'mid.c1', direction: 'incoming', type: 'text', text: 'giá sao', createdAt: 1000 } };
  const result = await processChatbotChanges([change], deps());
  assert.equal(result[0].retryLater, true);
  assert.deepEqual(log, ['error:Resource exhausted. Please try again later.']);
  await wait(120);
  assert.deepEqual(log, ['error:Resource exhausted. Please try again later.', 'send:Dạ em đây ạ'], 'chạy lại sau và trả lời được');
  // Nhân viên đã trả lời trong lúc chờ: lần chạy lại bỏ qua.
  log.length = 0;
  failures = 1;
  await processChatbotChanges([change], deps([change.message, { id: 'mid.staff', direction: 'outgoing', type: 'text', text: 'Dạ 174k ạ', createdAt: 2000 }]));
  await wait(120);
  assert.deepEqual(log, ['error:Resource exhausted. Please try again later.']);
});

test('ảnh sau tin nhắn riêng từ bình luận bị Facebook chặn: nhớ lại, gửi ngay khi khách nhắn vào Messenger (không gửi trùng)', async () => {
  const { rememberPendingImages, takePendingImages } = await import('../app/chatbot-engine.mjs');
  const log = [];
  const base = {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '' }),
    listMessages: async () => [],
    saveBotState: async () => {},
    getConversation: async id => (id === 'page:user' ? { id: 'page:user', pageId: 'page', psid: 'user', botEnabled: true } : null),
    sendMessage: async (conversation, message) => {
      if (message.imageUrls && conversation.id === 'page:user' && !log.includes('inbox-open')) throw new Error('Pancake không nhận tin (200): (#551) Người này hiện không có mặt.');
      log.push(message.imageUrls ? `img:${conversation.id}:${message.imageUrls.join(',')}` : `text:${conversation.id}:${message.text}`);
      return { message: { mid: `m${log.length}` } };
    },
    requestReply: async () => ({ templateId: 'PRICE_QUOTE', messages: ['Bảng giá ạ'], images: ['https://cdn/xanh.jpg'], handoff: false })
  };
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:comment:c1:p1', pageId: 'page', psid: 'user', source: 'comment', name: 'Khách', botEnabled: true },
    message: { id: 'c1', mid: 'c1', direction: 'incoming', type: 'text', text: 'giá sao', createdAt: 1 }
  }], base);
  assert.ok(log.some(item => item.startsWith('text:page:comment:c1:p1:')), 'tin nhắn riêng bằng chữ vẫn đi');
  assert.ok(!log.some(item => item.startsWith('img:')), 'ảnh bị chặn');
  // Khách nhắn vào Messenger: ảnh nợ đi trước, ảnh trùng trong câu trả lời bị bỏ.
  log.length = 0;
  log.push('inbox-open');
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true },
    message: { id: 'm1', mid: 'm1', direction: 'incoming', type: 'text', text: '1 túi miễn ship ha', createdAt: 2 }
  }], base);
  assert.deepEqual(log.slice(1), ['img:page:user:https://cdn/xanh.jpg', 'text:page:user:Bảng giá ạ']);
  assert.deepEqual(takePendingImages('page', 'user'), [], 'đã gửi thì không còn nợ');
  rememberPendingImages('page', 'khac', ['a.jpg', 'a.jpg']);
  assert.deepEqual(takePendingImages('page', 'khac'), ['a.jpg']);
});

test('khách gửi ảnh: Gemini nhận ảnh (inlineData) cùng câu hỏi; ảnh không đọc được thì vẫn gửi chữ', async () => {
  const { collectImageParts } = await import('../app/chatbot-engine.mjs');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  let body;
  const reply = await requestDirectModelReply({
    settings: {
      provider: 'vertex', directApiKey: 'google-token', directModel: 'gemini-2.5-flash', systemPrompt: 'Chỉ trả JSON', structuredOutput: true, retryCount: 0, messageTemplates: templates,
      directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-2.5-flash:generateContent'
    },
    conversation: { psid: '1', name: 'Khách' },
    message: { type: 'image', text: '', dataUrl: `data:image/png;base64,${png}` },
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"template_id":"PRICE_QUOTE","Product_N1":"Granola Túi Xanh 450g"}' }] } }] }) };
    }
  });
  const userParts = body.contents.at(-1).parts;
  assert.deepEqual(userParts[0], { inlineData: { mimeType: 'image/png', data: png } });
  assert.match(userParts[1].text, /TIN NHẮN CẦN TRẢ LỜI: \[Khách gửi image\]/);
  assert.equal(reply.templateId, 'PRICE_QUOTE');
  assert.deepEqual(await collectImageParts({ type: 'image', dataUrl: 'data:text/plain;base64,aGk=' }), [], 'không phải ảnh thì bỏ');
});

test('ảnh khách gửi qua Vertex: model nhận ra sản phẩm thì trả lời tiếp; không rõ thì báo đã nhận hình và gắn thẻ', async () => {
  const log = [];
  const run = async answer => {
    log.length = 0;
    return processChatbotChanges([{
      type: 'message',
      conversation: { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true },
      message: { id: `img-${answer}`, mid: `img-${answer}`, direction: 'incoming', type: 'image', text: '', dataUrl: 'https://content.pancake.vn/ad.jpg', createdAt: 5 }
    }], {
      readSettings: async () => ({ enabled: true, responseMode: 'automatic', provider: 'vertex', handoffKeywords: '', messageTemplates: { ...templates, IMAGE_RECEIVED: 'Dạ em đã nhận được hình ạ' } }),
      listMessages: async () => [{ id: 't1', direction: 'incoming', type: 'text', text: 'cho 2 túi', createdAt: 1 }],
      saveBotState: async (_id, state) => { if (state.labels) log.push(`labels:${state.labels.join(',')}`); },
      sendMessage: async (_conversation, message) => { log.push(`text:${message.text}`); return { message: { mid: 'm' } }; },
      requestReply: async ({ message }) => {
        log.push(`model:${message.type}`);
        return answer === 'known'
          ? { templateId: 'ORDER_ADDRESS', messages: ['Dạ chị cho em xin SĐT và địa chỉ ạ'], handoff: false }
          : { templateId: 'IMAGE_RECEIVED', messages: ['(bị thay)'], handoff: false };
      }
    });
  };
  const known = await run('known');
  assert.deepEqual(log, ['model:image', 'text:Dạ chị cho em xin SĐT và địa chỉ ạ']);
  assert.equal(known[0].handoff, undefined);
  const unknown = await run('unknown');
  assert.deepEqual(log.slice(0, 2), ['model:image', 'text:Dạ em đã nhận được hình ạ']);
  assert.equal(unknown[0].templateId, 'IMAGE_RECEIVED');
});

test('khách bình luận nhiều lần dưới cùng bài: tin riêng y hệt đã gửi trong 24 giờ thì không gửi lại, chỉ trả lời công khai ngắn', async () => {
  const log = [];
  const inboxMessages = [];
  const deps = {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', messageTemplates: { ...templates, COMMENT_PRIVATE_REPLY: 'Dạ em thấy {title} để lại bình luận ạ', COMMENT_PUBLIC_REPLY: 'Dạ em vừa ib cho mình rồi ạ', COMMENT_PUBLIC_REPEAT: 'Dạ em đã gửi trong tin nhắn rồi ạ' } }),
    listMessages: async id => (id === 'page:user' ? inboxMessages : []),
    getConversation: async id => (id === 'page:user' ? { id: 'page:user', pageId: 'page', psid: 'user', botEnabled: true } : null),
    saveBotState: async () => {},
    sendMessage: async (conversation, message) => {
      log.push(`${message.privateReply ? 'riêng' : 'công khai'}:${message.text}`);
      if (message.privateReply) inboxMessages.push({ id: `p${log.length}`, direction: 'outgoing', type: 'text', text: message.text, createdAt: Date.now() });
      return { message: { mid: `m${log.length}` } };
    },
    requestReply: async () => ({ templateId: 'GENERAL_INFO', messages: ['Dạ nhà em có 3 vị ạ'], handoff: false })
  };
  const comment = (id, text) => ({ type: 'message', conversation: { id: 'page:comment:c1:p1', pageId: 'page', psid: 'user', source: 'comment', name: 'Tiên', botEnabled: true }, message: { id, mid: id, direction: 'incoming', type: 'text', text, createdAt: Date.now() } });
  await processChatbotChanges([comment('c1', 'cho chị coi combo')], deps);
  const second = await processChatbotChanges([comment('c2', 'combo đó mấy gói em')], deps);
  assert.deepEqual(log, [
    'riêng:Dạ em thấy anh/chị để lại bình luận ạ\n\nDạ nhà em có 3 vị ạ',
    'công khai:Dạ em vừa ib cho mình rồi ạ',
    'công khai:Dạ em đã gửi trong tin nhắn rồi ạ'
  ]);
  assert.equal(second[0].privateSkipped, true);
  // Tin riêng cũ hơn 24 giờ thì gửi lại được.
  inboxMessages[0].createdAt = Date.now() - 25 * 60 * 60 * 1000;
  log.length = 0;
  await processChatbotChanges([comment('c3', 'còn combo không em')], deps);
  assert.equal(log.filter(item => item.startsWith('riêng:')).length, 1);
});
