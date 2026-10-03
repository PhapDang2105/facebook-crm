// Tối ưu chatbot (B1): "hôi" trong bình luận chỉ là lời chê khi đứng thành TỪ RIÊNG — "thôi", "Khôi" không phải khiếu nại.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim } from './helpers/r13-engine-sim.mjs';

const LLM = { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Xanh' };

async function commentLabels(text) {
  const sim = new Sim();
  const c = sim.comment();
  const r = await sim.send(c, text, { llm: LLM });
  return { templateId: r.result.templateId, labels: sim.conversations.get(c.id).labels || [] };
}

for (const text of ['Lấy 2 túi xanh thôi', 'Khôi đặt 1 túi xanh', 'giá sao shop, thôi để mai đặt']) {
  test(`B1: bình luận "${text}" không bị coi là khiếu nại`, async () => {
    const { templateId, labels } = await commentLabels(text);
    assert.notEqual(templateId, 'COMMENT_STAFF_FOLLOWUP');
    assert.ok(!labels.includes('complaint'), JSON.stringify(labels));
  });
}

for (const text of ['túi bị hôi', 'Hôi quá shop ơi', 'túi bị hôi'.normalize('NFD')]) {
  test(`B1: bình luận chê thật "${text}" vẫn là khiếu nại`, async () => {
    const { labels } = await commentLabels(text);
    assert.ok(labels.includes('complaint'), JSON.stringify(labels));
  });
}
