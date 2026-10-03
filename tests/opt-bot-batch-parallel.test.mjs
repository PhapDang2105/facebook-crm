// Tối ưu chatbot (P1): lô nhiều tin — khách khác nhau chạy song song (tối đa 3), khách B không chờ lượt chậm của khách A;
// tin của cùng một khách (cùng pageId:psid) vẫn nối tiếp đúng thứ tự.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim } from './helpers/r13-engine-sim.mjs';
import { processChatbotChanges, CHATBOT_BATCH_CONCURRENCY } from '../app/chatbot-engine.mjs';

const TEXT = 'hôm qua mình xem bài đăng thấy hay quá';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function setup(convs, delays) {
  const sim = new Sim();
  const events = [];
  let running = 0;
  let maxRunning = 0;
  const changes = convs.map(([id, psid], index) => {
    const conversation = sim.conversation(id, { source: 'inbox', psid });
    const message = { id: `in-${index}`, mid: `in-${index}`, direction: 'incoming', type: 'text', text: TEXT, createdAt: Date.now() - 1000 + index };
    sim.list(id).push(message);
    return { type: 'message', conversation: { ...conversation }, message };
  });
  const { deps } = sim.dependencies({
    extra: {
      requestReply: async payload => {
        const id = payload.conversation.id;
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        events.push(`start:${id}`);
        await sleep(delays[id] || 0);
        events.push(`end:${id}`);
        running -= 1;
        return { templateId: 'GENERAL_INFO', messages: [`trả lời ${id}`], handoff: false };
      }
    }
  });
  return { changes, deps, events, maxRunning: () => maxRunning };
}

test('P1: khách B không bị chặn bởi lượt chậm của khách A; cùng khách giữ thứ tự', async () => {
  const { changes, deps, events } = setup([['page:a', 'a'], ['page:a-2', 'a'], ['page:b', 'b']], { 'page:a': 300 });
  const results = await processChatbotChanges(changes, deps);
  assert.equal(results.filter(item => item.error).length, 0, JSON.stringify(results));
  for (const id of ['page:a', 'page:a-2', 'page:b']) assert.ok(events.includes(`end:${id}`), `${id} đã gọi mô hình: ${events}`);
  // B xong trước khi lượt chậm của A xong.
  assert.ok(events.indexOf('end:page:b') < events.indexOf('end:page:a'), events.join(' '));
  // Tin thứ hai của khách A chỉ bắt đầu sau khi tin đầu xong.
  assert.ok(events.indexOf('start:page:a-2') > events.indexOf('end:page:a'), events.join(' '));
});

test('P1: không quá CHATBOT_BATCH_CONCURRENCY lượt cùng lúc', async () => {
  const convs = Array.from({ length: 7 }, (_, index) => [`page:k${index}`, `k${index}`]);
  const delays = Object.fromEntries(convs.map(([id]) => [id, 60]));
  const { changes, deps, events, maxRunning } = setup(convs, delays);
  await processChatbotChanges(changes, deps);
  assert.equal(events.filter(event => event.startsWith('end:')).length, 7);
  assert.equal(CHATBOT_BATCH_CONCURRENCY, 3);
  assert.ok(maxRunning() <= 3 && maxRunning() >= 2, `maxRunning ${maxRunning()}`);
});
