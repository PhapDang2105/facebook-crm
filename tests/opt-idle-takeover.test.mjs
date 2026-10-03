// Chủ shop 03/10: bot im vì "nhân viên đang xử lý" mà khách gửi tin ĐẶT HÀNG (SĐT / địa chỉ / số túi) và không ai của Page nhắn
// gì trong 5 phút → bot nhận đơn theo luồng thường. Khiếu nại/bảo hành, bot tắt, bình luận, tin không có ý đặt hàng: không bao giờ.
// Hẹn giờ thật nhưng ngắn (dependencies.staffIdleMs) thay cho 5 phút.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(os.tmpdir(), 'crm-opt-idle-'));
process.env.ADDRESS_AI_CACHE_PATH = path.join(directory, 'address-ai-cache.json');
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

const { Sim, PHONE } = await import('./helpers/r13-engine-sim.mjs');
const idle = await import('../app/processing/staff-idle.mjs');

const MIN = 60 * 1000;
const IDLE_MS = 40;
const ADDRESS_LINES = `Trang\n${PHONE}\nTdp bó bun\nPhường vân sơn\nTỉnh sơn la`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitIdle = async () => { await sleep(IDLE_MS * 3); await idle.settleStaffIdleRechecks(); };

/** Ca thật: thẻ Livestream + Số điện thoại; bot chào lúc 13:30, nhân viên gửi bảng giá 13:59, khách 15:50 đặt. */
function realCase(sim, extra = {}) {
  const inbox = sim.inbox({ labels: ['livestream', 'phone'], botLastTemplateId: 'LIVESTREAM_COMMENT', botLastReplyAt: Date.now() - 140 * MIN, ...extra });
  sim.history(inbox, 'incoming', 'Giá sao em', 141 * MIN);
  sim.history(inbox, 'outgoing', 'Dạ em chào chị, Granola Giọt Nắng đang có ưu đãi live ạ', 140 * MIN, { sender: 'bot' });
  sim.history(inbox, 'outgoing', 'Bảng giá: Túi Xanh 450g 149k, Túi Vàng 350g 129k…', 111 * MIN, { staff: true });
  return inbox;
}

const notesOf = () => {
  const notes = [];
  return { notes, extra: { staffIdleMs: IDLE_MS, addStaffNote: (conversation, note) => { notes.push({ id: conversation.id, note }); } } };
};

test.afterEach(() => idle.clearStaffIdleRechecks());

test('isOrderishText / staffIdleDelayMs / lý do', () => {
  for (const text of ['E 2 túi', ADDRESS_LINES, 'Tdp bó bun\nPhường vân sơn\nTỉnh sơn la', `sđt ${PHONE}`, 'lấy 3 gói nha']) assert.equal(idle.isOrderishText(text), true, text);
  for (const text of ['ok em cảm ơn', 'giá bao nhiêu vậy', 'dạ', 'để chị xem đã', 'túi xanh ngon không em']) assert.equal(idle.isOrderishText(text), false, text);
  assert.equal(idle.staffIdleDelayMs({}), 5 * MIN);
  assert.equal(idle.staffIdleDelayMs({ CHATBOT_STAFF_IDLE_MS: '0' }), 0);
  assert.equal(idle.staffIdleDelayMs({ CHATBOT_STAFF_IDLE_MS: '120000' }), 120000);
  assert.equal(idle.staffIdleDelayMs({ CHATBOT_STAFF_IDLE_MS: 'abc' }), 5 * MIN);
  assert.equal(idle.staffIdleReason(5 * MIN), 'nhân viên im 5 phút — bot nhận đơn');
  // Tắt (0) → không hẹn.
  assert.equal(idle.scheduleStaffIdleRecheck('x', 0, () => {}), false);
});

test('(1) ca thật: "E 2 túi" + tên/SĐT/địa chỉ, nhân viên im → bot nhận đơn (hỏi vị / lên đơn), ghi chú cho nhân viên, nhật ký có lý do', async () => {
  const sim = new Sim();
  const inbox = realCase(sim);
  const { notes, extra } = notesOf();
  const llm = { template_id: 'ORDER_INFO_ASK_FLAVOR', Phone_Number: PHONE, Customer_Address: 'Tdp bó bun, Phường vân sơn, Tỉnh sơn la', No_A: '2' };
  const first = await sim.send(inbox, 'E 2 túi', { llm, extra });
  assert.equal(first.result.skipped, 'nhân viên đang xử lý');
  assert.equal(idle.hasStaffIdleRecheck(inbox.id), true, 'đã hẹn kiểm lại');
  assert.deepEqual(first.record.staffIdle, { scheduled: true, inMs: IDLE_MS });
  const second = await sim.send(inbox, ADDRESS_LINES, { llm, extra });
  assert.equal(second.result.skipped, 'nhân viên đang xử lý');
  assert.equal(first.sent.length + second.sent.length, 0, 'lúc đầu bot vẫn im');
  await waitIdle();
  const sent = [...first.sent, ...second.sent];
  const created = [...first.created, ...second.created];
  assert.ok(sent.length > 0 || created.length > 0, 'bot đã trả lời sau khi nhân viên im');
  const takeover = sim.records.find(record => record.staffIdle?.takeover);
  assert.ok(takeover, JSON.stringify(sim.records.map(record => [record.skipped, record.final, record.staffIdle])));
  assert.equal(takeover.staffIdle.reason, 'nhân viên im 1 phút — bot nhận đơn', 'ngưỡng test 40 ms làm tròn lên 1 phút');
  assert.equal(takeover.skipped, null);
  // Gộp các tin từ sau tin Page cuối như luồng thường: mô hình (hay luật) thấy cả "E 2 túi" lẫn SĐT + địa chỉ.
  assert.match(takeover.text, /E 2 túi/);
  assert.match(takeover.text, new RegExp(PHONE));
  // Bot đang nhận đơn: hỏi vị / xin thông tin / xác nhận đơn (không phải lời chào hay bảng giá chung).
  assert.ok(created.length > 0 || /^(ORDER_|ASK_FLAVOR)/.test(String(takeover.final)), String(takeover.final));
  assert.equal(notes.length, 1);
  assert.match(notes[0].note, /Bot đã tự nhận đơn/);
  assert.equal(idle.hasStaffIdleRecheck(inbox.id), false);
});

test('(1b) cùng ca nhưng khách ghi vị ("E 2 túi xanh") → bot lên đơn 2 Túi Xanh', async () => {
  const sim = new Sim();
  const inbox = realCase(sim);
  const { notes, extra } = notesOf();
  const llm = { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: PHONE, Customer_Address: 'Tdp bó bun, Phường vân sơn, Tỉnh sơn la' };
  const first = await sim.send(inbox, 'E 2 túi xanh', { llm, extra });
  const second = await sim.send(inbox, ADDRESS_LINES, { llm, extra });
  assert.equal(second.result.skipped, 'nhân viên đang xử lý');
  await waitIdle();
  const created = [...first.created, ...second.created];
  assert.equal(created.length, 1, JSON.stringify(sim.records.map(record => [record.skipped, record.final])));
  assert.deepEqual(created[0].items.map(item => `${item.quantity} ${item.code}`),['2 GRA-XANH-Z450']);
  assert.equal(created[0].phone, PHONE);
  assert.equal(notes.length, 1);
});

test('(2) nhân viên trả lời trong 5 phút → bot vẫn im', async () => {
  const sim = new Sim();
  const inbox = realCase(sim);
  const { notes, extra } = notesOf();
  const turn = await sim.send(inbox, ADDRESS_LINES, { llm: () => { throw new Error('không được hỏi mô hình'); }, extra });
  assert.equal(idle.hasStaffIdleRecheck(inbox.id), true);
  sim.history(inbox, 'outgoing', 'Dạ chị lấy túi màu nào ạ', 0, { staff: true });
  await waitIdle();
  assert.equal(turn.sent.length, 0);
  assert.equal(turn.created.length, 0);
  assert.equal(notes.length, 0);
  assert.equal(sim.records.some(record => record.staffIdle?.takeover), false);
});

test('(3) thẻ khiếu nại + nhân viên nhắn gần đây → không bao giờ nhận thay', async () => {
  const sim = new Sim();
  const inbox = realCase(sim, { labels: ['complaint', 'livestream'] });
  const { notes, extra } = notesOf();
  const turn = await sim.send(inbox, ADDRESS_LINES, { llm: () => { throw new Error('không được hỏi mô hình'); }, extra });
  assert.equal(turn.result.skipped, 'nhân viên đang xử lý');
  assert.equal(idle.hasStaffIdleRecheck(inbox.id), false, 'không hẹn kiểm lại');
  // Kể cả có lượt nhận thay chạy (cờ) thì cổng khiếu nại vẫn chặn.
  const forced = await sim.send(inbox, 'E 2 túi', { llm: () => { throw new Error('không được hỏi mô hình'); }, extra, change: { staffIdleTakeover: true } });
  assert.equal(forced.result.skipped, 'nhân viên đang xử lý');
  await waitIdle();
  assert.equal(turn.sent.length + forced.sent.length, 0);
  assert.equal(notes.length, 0);
});

test('(4) bot tắt (nhân viên nhận khách) → không bao giờ nhận thay', async () => {
  // Tắt ngay từ đầu: lượt thoát trước cổng, không hẹn.
  const off = new Sim();
  const offInbox = realCase(off, { botEnabled: false });
  const { extra } = notesOf();
  const turn = await off.send(offInbox, ADDRESS_LINES, { extra });
  assert.equal(idle.hasStaffIdleRecheck(offInbox.id), false);
  // Tắt trong lúc chờ: lượt kiểm lại thấy botEnabled false → thôi.
  const sim = new Sim();
  const inbox = realCase(sim);
  const { notes, extra: extra2 } = notesOf();
  const later = await sim.send(inbox, ADDRESS_LINES, { llm: () => { throw new Error('không được hỏi mô hình'); }, extra: extra2 });
  assert.equal(idle.hasStaffIdleRecheck(inbox.id), true);
  inbox.botEnabled = false;
  await waitIdle();
  assert.equal(turn.sent.length + later.sent.length, 0);
  assert.equal(later.created.length, 0);
  assert.equal(notes.length, 0);
});

test('(5) tin không có ý đặt hàng (chuyện phiếm) → không hẹn, không nhận thay', async () => {
  const sim = new Sim();
  const inbox = realCase(sim);
  const { notes, extra } = notesOf();
  const turn = await sim.send(inbox, 'để chị hỏi chồng đã nha em', { llm: () => { throw new Error('không được hỏi mô hình'); }, extra });
  assert.equal(turn.result.skipped, 'nhân viên đang xử lý');
  assert.equal(idle.hasStaffIdleRecheck(inbox.id), false);
  await waitIdle();
  assert.equal(turn.sent.length, 0);
  assert.equal(notes.length, 0);
});

test('(6) bình luận → không nhận thay', async () => {
  const sim = new Sim();
  realCase(sim);
  const comment = sim.comment();
  const { notes, extra } = notesOf();
  const turn = await sim.send(comment, `đặt 2 túi ${PHONE}`, { llm: () => { throw new Error('không được hỏi mô hình'); }, extra });
  assert.equal(turn.result.skipped, 'nhân viên đang xử lý');
  assert.equal(idle.hasStaffIdleRecheck(comment.id), false);
  assert.equal(idle.hasStaffIdleRecheck(sim.inboxId), false);
  // Cờ nhận thay trên bình luận bị bỏ qua: cổng vẫn chặn.
  const forced = await sim.send(comment, 'Tdp bó bun Phường vân sơn Tỉnh sơn la', { llm: () => { throw new Error('không được hỏi mô hình'); }, extra, change: { staffIdleTakeover: true } });
  assert.equal(forced.result.skipped, 'nhân viên đang xử lý');
  await waitIdle();
  assert.equal(turn.created.length + forced.created.length, 0);
  assert.equal(notes.filter(item => /Bot đã tự nhận đơn/.test(item.note)).length, 0);
});

test('một lượt kiểm lại cho mỗi hội thoại; xoá được khi tắt máy; chưa tới giờ thì bot chưa trả lời', async () => {
  let runs = 0;
  assert.equal(idle.scheduleStaffIdleRecheck('c1', 20, () => { runs += 1; }), true);
  assert.equal(idle.scheduleStaffIdleRecheck('c1', 20, () => { runs += 1; }), false, 'trùng hội thoại: giữ lượt cũ');
  await sleep(60);
  await idle.settleStaffIdleRechecks();
  assert.equal(runs, 1);
  assert.equal(idle.scheduleStaffIdleRecheck('c2', 10000, () => { runs += 1; }), true);
  idle.clearStaffIdleRechecks();
  assert.equal(idle.hasStaffIdleRecheck('c2'), false);
  // Engine: ngưỡng 3 giây — chưa tới giờ thì chỉ có lượt hẹn, bot chưa trả lời.
  const sim = new Sim();
  const inbox = realCase(sim);
  const { extra } = notesOf();
  const turn = await sim.send(inbox, ADDRESS_LINES, { llm: () => { throw new Error('chưa tới lúc'); }, extra: { ...extra, staffIdleMs: 3000 } });
  assert.equal(idle.hasStaffIdleRecheck(inbox.id), true);
  assert.equal(turn.sent.length, 0);
});
