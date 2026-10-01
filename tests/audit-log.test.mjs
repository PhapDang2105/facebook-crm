import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import {
  AUDIT_ACTIONS, AUTOMATED_ACTORS, appendAssignAudit, appendAudit, appendBotToggleAudit, appendLabelAudit, auditActionLabel,
  auditActors, createViewThrottle, flushAudit, foldText, labelChangeDetails, queryAudit
} from '../app/audit-log.mjs';
import { vnDateKey } from '../app/processing/decision-log.mjs';

const freshDir = () => tempDir('crm-audit-');
const DAY = 24 * 60 * 60 * 1000;
// 01/10/2026 10:00 giờ VN.
const BASE = Date.UTC(2026, 9, 1, 3, 0);
const owner = { actor: 'huy', actorName: 'huy', role: 'owner', ip: '1.2.3.4' };
const hang = { actor: 'hang', actorName: 'Thúy Hằng', role: 'staff', ip: '5.6.7.8' };

test('ghi: tệp JSONL theo ngày giờ VN, bản ghi đủ trường schema, id ngắn và duy nhất', async () => {
  const dir = freshDir();
  const saved = await appendAudit({ ...hang, action: 'order.update', target: { type: 'order', id: 'A1', name: 'Chị Mai' }, conversationId: 'p:1', orderId: 'A1', summary: 'Sửa đơn' }, { dir, now: BASE });
  // 23:30 giờ VN ngày 01/10 = 16:30 UTC; 00:30 giờ VN ngày 02/10 = 17:30 UTC 01/10 → hai tệp.
  await appendAudit({ ...hang, action: 'message.send', summary: 'a' }, { dir, now: Date.UTC(2026, 9, 1, 16, 30) });
  await appendAudit({ ...hang, action: 'message.send', summary: 'b' }, { dir, now: Date.UTC(2026, 9, 1, 17, 30) });
  assert.deepEqual(readdirSync(dir).sort(), ['2026-10-01.jsonl', '2026-10-02.jsonl']);
  assert.deepEqual(Object.keys(saved).sort(), ['action', 'actor', 'actorName', 'at', 'conversationId', 'id', 'ip', 'orderId', 'role', 'summary', 'target'].sort());
  assert.equal(saved.at, BASE);
  assert.deepEqual(saved.target, { type: 'order', id: 'A1', name: 'Chị Mai' });
  assert.match(saved.id, /^[A-Za-z0-9_-]{6,10}$/);
  const line = JSON.parse(readFileSync(path.join(dir, '2026-10-01.jsonl'), 'utf8').split('\n')[0]);
  assert.deepEqual(line, saved);
  const ids = new Set();
  for (let index = 0; index < 200; index += 1) ids.add((await appendAudit({ ...owner, action: 'conversation.view' }, { dir, now: BASE + index })).id);
  assert.equal(ids.size, 200, 'id không trùng');
});

test('che SĐT/email trong summary (và tên đích), summary ≤ 200 ký tự; details nhỏ được giữ, quá lớn bị bỏ', async () => {
  const dir = freshDir();
  const saved = await appendAudit({
    ...hang,
    action: 'message.send',
    target: { type: 'conversation', id: 'p:1', name: 'Khách 0912 345 678' },
    summary: `Dạ chị gửi SĐT 0912345678 và email mai@example.com nha ${'x'.repeat(400)}`,
    details: { kind: ['chữ'], phone: '0987654321', nested: { ok: true } }
  }, { dir, now: BASE });
  assert.match(saved.summary, /SĐT <sdt> và email <email>/);
  assert.doesNotMatch(saved.summary, /0912345678|mai@example\.com/);
  assert.ok(saved.summary.length <= 200);
  assert.equal(saved.target.name, 'Khách <sdt>');
  assert.deepEqual(saved.details, { kind: ['chữ'], phone: '<sdt>', nested: { ok: true } });
  const big = await appendAudit({ ...hang, action: 'order.update', details: { list: Array.from({ length: 30 }, () => 'y'.repeat(200)) } }, { dir, now: BASE });
  assert.equal(big.details, undefined, 'details quá 2000 ký tự JSON bị bỏ');
});

test('đọc: mới nhất trước, lọc người / hành động (tiền tố, nhiều tiền tố) / hội thoại / đơn / ngày / tìm không dấu', async () => {
  const dir = freshDir();
  await appendAudit({ ...owner, action: 'auth.login', summary: 'Đăng nhập CRM.' }, { dir, now: BASE - 2 * DAY });
  await appendAudit({ ...hang, action: 'conversation.view', conversationId: 'p:1', target: { type: 'conversation', id: 'p:1', name: 'Chị Mai' }, summary: 'Xem hội thoại Chị Mai.' }, { dir, now: BASE - DAY });
  await appendAudit({ ...hang, action: 'order.update', conversationId: 'p:1', orderId: 'A1', summary: 'trạng thái: Chưa xử lý → Đã xác nhận' }, { dir, now: BASE });
  await appendAudit({ ...owner, action: 'order.cancel', orderId: 'B2', summary: 'Khách hủy' }, { dir, now: BASE + 1000 });
  await appendAudit({ ...hang, action: 'message.send', conversationId: 'p:2', summary: 'Không dấu thử' }, { dir, now: BASE + 2000 });

  const all = await queryAudit({}, { dir });
  assert.deepEqual(all.items.map(item => item.action), ['message.send', 'order.cancel', 'order.update', 'conversation.view', 'auth.login']);
  assert.equal(all.next, null);
  assert.deepEqual((await queryAudit({ actor: 'HANG' }, { dir })).items.map(item => item.action), ['message.send', 'order.update', 'conversation.view']);
  assert.deepEqual((await queryAudit({ action: 'order.' }, { dir })).items.map(item => item.action), ['order.cancel', 'order.update']);
  assert.deepEqual((await queryAudit({ action: 'order.cancel' }, { dir })).items.map(item => item.orderId), ['B2']);
  assert.deepEqual((await queryAudit({ action: 'message.send,conversation.view' }, { dir })).items.map(item => item.action), ['message.send', 'conversation.view']);
  assert.deepEqual((await queryAudit({ action: 'order.,auth.' }, { dir })).items.map(item => item.action), ['order.cancel', 'order.update', 'auth.login']);
  assert.deepEqual((await queryAudit({ conversationId: 'p:1' }, { dir })).items.map(item => item.action), ['order.update', 'conversation.view']);
  assert.deepEqual((await queryAudit({ orderId: 'A1' }, { dir })).items.map(item => item.action), ['order.update']);
  const today = vnDateKey(BASE);
  assert.deepEqual((await queryAudit({ from: today, to: today }, { dir })).items.length, 3);
  assert.deepEqual((await queryAudit({ to: vnDateKey(BASE - DAY) }, { dir })).items.map(item => item.action), ['conversation.view', 'auth.login']);
  // Tìm không dấu: trong summary, tên đích, tên người làm.
  assert.deepEqual((await queryAudit({ q: 'khong dau' }, { dir })).items.map(item => item.action), ['message.send']);
  assert.deepEqual((await queryAudit({ q: 'chi mai' }, { dir })).items.map(item => item.action), ['conversation.view']);
  assert.equal((await queryAudit({ q: 'thuy hang' }, { dir })).items.length, 3);
  assert.equal((await queryAudit({ q: 'da xac nhan' }, { dir })).items[0].orderId, 'A1');
  assert.equal(foldText('Đã XÁC nhận'), 'da xac nhan');
});

test('con trỏ before (at:id): trang nối tiếp không lặp, không sót, kể cả nhiều bản ghi cùng mốc giờ; limit ≤ 500', async () => {
  const dir = freshDir();
  for (let index = 0; index < 23; index += 1) {
    // 3 bản ghi cùng một mốc giờ, qua hai ngày.
    await appendAudit({ ...hang, action: 'conversation.view', summary: `v${index}` }, { dir, now: BASE - DAY + Math.floor(index / 3) * 3 * 60 * 60 * 1000 });
  }
  const seen = [];
  let before = '';
  for (let page = 0; page < 20; page += 1) {
    const result = await queryAudit({ limit: 5, before }, { dir });
    seen.push(...result.items.map(item => item.summary));
    if (!result.next) break;
    assert.match(result.next, /^\d+:.+$/);
    before = result.next;
  }
  assert.equal(seen.length, 23);
  assert.equal(new Set(seen).size, 23);
  const full = await queryAudit({ limit: 10000 }, { dir });
  assert.equal(full.items.length, 23, 'limit bị chặn ở 500 nhưng vẫn đủ 23');
  assert.deepEqual(full.items.map(item => item.summary), seen, 'cùng thứ tự với đọc theo trang');
});

test('hàng đợi ghi: 100 lần ghi không đợi nhau vẫn đủ dòng, mỗi dòng là JSON hợp lệ', async () => {
  const dir = freshDir();
  for (let index = 0; index < 100; index += 1) appendAudit({ ...hang, action: 'conversation.view', summary: `#${index}` }, { dir, now: BASE + index });
  await flushAudit(dir);
  const lines = readFileSync(path.join(dir, '2026-10-01.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 100);
  assert.deepEqual(lines.map(line => JSON.parse(line).summary), Array.from({ length: 100 }, (_, index) => `#${index}`));
  // Lỗi ghi (thư mục là một tệp) chỉ warn, không ném, trả null.
  const file = path.join(freshDir(), 'not-a-dir');
  writeFileSync(file, 'x');
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await appendAudit({ ...hang, action: 'conversation.view' }, { dir: file, now: BASE }), null);
  } finally {
    console.warn = warn;
  }
  assert.equal(await appendAudit({ ...hang, action: '' }, { dir, now: BASE }), null, 'không có action thì không ghi');
});

test('giữ 365 ngày: lần ghi đầu của ngày xóa tệp cũ hơn 365 ngày, giữ tệp trong hạn và tệp lạ', async () => {
  const dir = freshDir();
  const old = vnDateKey(BASE - 400 * DAY);
  const kept = vnDateKey(BASE - 300 * DAY);
  writeFileSync(path.join(dir, `${old}.jsonl`), '{"action":"auth.login","at":1,"id":"x"}\n');
  writeFileSync(path.join(dir, `${kept}.jsonl`), '{"action":"auth.login","at":2,"id":"y"}\n');
  writeFileSync(path.join(dir, 'ghi-chu.txt'), 'giữ');
  await appendAudit({ ...owner, action: 'auth.login' }, { dir, now: BASE });
  assert.deepEqual(readdirSync(dir).sort(), [`${kept}.jsonl`, '2026-10-01.jsonl', 'ghi-chu.txt'].sort());
});

test('danh sách người trong nhật ký: tên mới nhất, bỏ tên gõ ở lần đăng nhập sai; nhãn hành động tiếng Việt', async () => {
  const dir = freshDir();
  await appendAudit({ ...hang, actorName: 'Hằng', action: 'auth.login' }, { dir, now: BASE - DAY });
  await appendAudit({ actor: 'hacker', actorName: 'hacker', role: '', action: 'auth.login_failed' }, { dir, now: BASE });
  assert.deepEqual(await auditActors({ dir }), [{ username: 'hang', name: 'Hằng' }]);
  await appendAudit({ ...hang, action: 'message.send' }, { dir, now: BASE + 1 });
  assert.deepEqual(await auditActors({ dir }), [{ username: 'hang', name: 'Thúy Hằng' }], 'cập nhật khi ghi');
  assert.equal(auditActionLabel('order.cancel'), 'Hủy đơn');
  assert.equal(auditActionLabel('la.la'), 'la.la');
  for (const action of ['auth.login', 'auth.login_failed', 'auth.logout', 'conversation.view', 'conversation.read', 'message.send', 'comment.reply',
    'comment.private_reply', 'conversation.labels', 'conversation.bot', 'conversation.assign', 'customer.update', 'customer.note', 'order.create',
    'order.update', 'order.status', 'order.cancel', 'order.resend_receipt', 'order.push_pos', 'order.export', 'settings.chatbot', 'settings.gifts',
    'settings.products', 'settings.messages', 'settings.staff', 'settings.qr', 'settings.channels', 'settings.pos', 'followup.run']) {
    assert.ok(AUDIT_ACTIONS[action], `thiếu nhãn cho ${action}`);
  }
});

test('gộp "xem hội thoại": cùng người + cùng hội thoại tối đa 1 lần / 30 phút', () => {
  const shouldRecord = createViewThrottle();
  assert.equal(shouldRecord('hang', 'p:1', 0), true);
  assert.equal(shouldRecord('hang', 'p:1', 29 * 60 * 1000), false);
  assert.equal(shouldRecord('hang', 'p:2', 29 * 60 * 1000), true, 'hội thoại khác');
  assert.equal(shouldRecord('lan', 'p:1', 29 * 60 * 1000), true, 'người khác');
  assert.equal(shouldRecord('hang', 'p:1', 30 * 60 * 1000), true, 'hết 30 phút');
  assert.equal(shouldRecord('hang', 'p:1', 31 * 60 * 1000), false, 'tính từ lần ghi gần nhất');
  // Bộ nhớ đệm không phình mãi.
  const small = createViewThrottle({ maxEntries: 10 });
  for (let index = 0; index < 50; index += 1) small('u', `c${index}`, index);
  assert.equal(small('u', 'c49', 60), false, 'mục mới nhất còn nhớ');
  assert.equal(small('u', 'c0', 60), true, 'mục cũ nhất đã bị bỏ');
});

test('thẻ / bot / phân công tự động: details mang TÊN thẻ, enabled, from/to; người làm bot/system', async () => {
  const dir = freshDir();
  const labelDefs = [{ id: 'customer', name: 'Đã mua hàng' }, { id: 'complaint', name: 'Khiếu nại' }];
  assert.deepEqual(labelChangeDetails(['complaint'], ['customer'], labelDefs), { added: ['Đã mua hàng'], removed: ['Khiếu nại'], addedIds: ['customer'], removedIds: ['complaint'] });
  assert.equal(appendLabelAudit({ actor: AUTOMATED_ACTORS.bot, conversation: { id: 'p:1' }, before: ['customer'], after: ['customer'], labelDefs }, { dir }), null, 'không đổi thì không ghi');
  const labels = await appendLabelAudit({ actor: AUTOMATED_ACTORS.system, conversation: { id: 'p:1', name: 'Chị Mai' }, before: [], after: ['customer'], labelDefs, reason: 'đồng bộ đơn POS' }, { dir, now: BASE });
  assert.equal(labels.action, 'conversation.labels');
  assert.equal(labels.actor, 'system');
  assert.equal(labels.role, 'system');
  assert.equal(labels.conversationId, 'p:1');
  assert.deepEqual(labels.details, { added: ['Đã mua hàng'], removed: [] });
  assert.match(labels.summary, /\+Đã mua hàng \(đồng bộ đơn POS\)/);
  const bot = await appendBotToggleAudit({ actor: AUTOMATED_ACTORS.bot, conversation: { id: 'p:1' }, enabled: false, reason: 'bot chuyển nhân viên' }, { dir, now: BASE + 1 });
  assert.deepEqual([bot.action, bot.actor, bot.details], ['conversation.bot', 'bot', { enabled: false }]);
  const assign = await appendAssignAudit({ actor: AUTOMATED_ACTORS.system, conversation: { id: 'p:1' }, from: '', to: 'Thúy Hằng', reason: 'Pancake' }, { dir, now: BASE + 2 });
  assert.deepEqual(assign.details, { from: '', to: 'Thúy Hằng' });
  assert.match(assign.summary, /Chưa phân công → Thúy Hằng/);
  const history = await queryAudit({ conversationId: 'p:1' }, { dir });
  assert.deepEqual(history.items.map(item => item.action), ['conversation.assign', 'conversation.bot', 'conversation.labels']);
});
