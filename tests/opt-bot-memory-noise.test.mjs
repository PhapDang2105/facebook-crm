// Tối ưu chatbot (P6): lịch sử mặc định (contextTrim.memory tắt, memoryWindow giữ nguyên) bỏ tin quảng cáo, biên nhận đơn,
// tệp đính kèm và tin hệ thống (memoryNoise) như bản gọn.
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { requestDirectModelReply } from '../app/chatbot-engine.mjs';
import { templates } from './helpers/r13-engine-sim.mjs';

test('P6: lịch sử gửi mô hình không còn tin quảng cáo / biên nhận / tệp đính kèm / tin hệ thống', async () => {
  let historyText = '';
  const recentMessages = [
    { id: '1', direction: 'incoming', type: 'ad', text: 'Khách bấm vào quảng cáo Granola' },
    { id: '2', direction: 'incoming', type: 'text', text: 'Túi xanh giá sao shop' },
    { id: '3', direction: 'outgoing', type: 'text', text: 'Dạ túi xanh 174k ạ' },
    { id: '4', direction: 'outgoing', type: 'order-receipt', text: 'Biên nhận đơn hàng 2 túi' },
    { id: '5', direction: 'incoming', type: 'attachment', text: 'tệp pdf' },
    { id: '6', direction: 'incoming', type: 'text', text: '[Tệp đính kèm]' },
    { id: '7', direction: 'outgoing', type: 'text', text: 'Đã gửi xác nhận đơn hàng' },
    { id: '8', direction: 'outgoing', type: 'text', text: 'Bạn đang phản hồi bình luận của khách' },
    { id: '9', direction: 'incoming', type: 'text', text: 'ok lấy 2 túi' }
  ];
  await requestDirectModelReply({
    settings: {
      provider: 'vertex', directApiKey: 'token', retryCount: 0, structuredOutput: true, messageTemplates: templates, systemPrompt: 'Chỉ trả JSON',
      directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
      directModel: 'gemini-2.5-flash', memoryWindow: 50
    },
    conversation: { psid: '123', name: 'Khách' },
    message: { id: '10', type: 'text', text: 'giao về quận 1 nha' },
    recentMessages,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      historyText = body.contents.slice(0, -1).map(content => content.parts.map(part => part.text).join(' ')).join('\n');
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"template_id":"WELCOME"}' }] } }] }) };
    }
  });
  assert.match(historyText, /Túi xanh giá sao shop/);
  assert.match(historyText, /Dạ túi xanh 174k ạ/);
  assert.match(historyText, /ok lấy 2 túi/);
  for (const noise of ['quảng cáo', 'Biên nhận', 'tệp pdf', 'Tệp đính kèm', 'Đã gửi xác nhận', 'Bạn đang phản hồi']) {
    assert.ok(!historyText.includes(noise), `${noise} trong: ${historyText}`);
  }
});
