import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './helpers/seed-catalog.mjs';
import { buildRowsFromStore, readDecisionLog, rowsFromDecisionLog } from '../tools-intent/build-dataset.mjs';
import { customerTurns, hasBasketOf, basketItemsOf, maskPhone, POLICY_DRIFT } from '../tools-intent/dataset-context.mjs';
import { loadSeedTemplates, relabelRows } from '../tools-intent/relabel-policy.mjs';
import { mergeRows, trustByClass } from '../tools-intent/merge-labels.mjs';
import { labelRows, loadCache, needsLlmLabel } from '../tools-intent/label-dataset.mjs';
import { formatReport, parseJournal, summarize, summarizeJournal } from '../tools-intent/shadow-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templates = loadSeedTemplates();
const MIN = 60000;
const t0 = Date.parse('2026-09-25T10:00:00+07:00');
const msg = (direction, createdAt, text, extra = {}) => ({ id: `m${createdAt}`, direction, type: 'text', text, createdAt, ...extra });

// Kho giả: một khách hỏi giá, gộp 3 tin đặt hàng, gửi SĐT + địa chỉ ở hai tin, xác nhận, nhân viên chốt tay.
const PRICE_TEXT = 'Dạ em gửi chị bảng giá Granola Túi Xanh 450g ạ 🌾 174.000đ/túi, 2 túi 298.000đ miễn ship.';
const ADDRESS_TEXT = 'Dạ để lên đơn đúng tuyến cho đơn vị vận chuyển, chị cho em xin số điện thoại và địa chỉ trước sáp nhập để em lên đơn gửi mình cho chính xác nha ạ.';
const CONFIRM_TEXT = 'Dạ, em xin phép xác nhận lại thông tin đặt hàng của mình nha:\n🌾 Granola Túi Xanh 450g – Số lượng: 2\n📞 Số điện thoại: 0912345678\n🏡 Địa chỉ nhận hàng: 12 Nguyễn Huệ';
function fakeStore() {
  return {
    conversations: [
      { id: 'c1', source: 'inbox', customerOrders: [{ id: 'o1', createdAt: t0 + 8.5 * MIN, processingStatus: '' }] },
      { id: 'c2', source: 'inbox', customerOrders: [{ id: 'o2', createdAt: t0 - 100 * MIN, processingStatus: 'cancelled' }] },
      { id: 'c3', source: 'comment', post: { message: 'Phiên live tối nay' } }
    ],
    messages: {
      c1: [
        msg('incoming', t0 - 30 * MIN, 'Túi xanh giá sao'),
        msg('outgoing', t0 - 29 * MIN, PRICE_TEXT),
        msg('incoming', t0, 'Cho em 2 túi xanh'),
        msg('incoming', t0 + 2 * MIN, '1 túi vàng nữa'),
        msg('incoming', t0 + 3 * MIN, 'ship về quận 7'),
        msg('outgoing', t0 + 4 * MIN, ADDRESS_TEXT),
        msg('incoming', t0 + 6 * MIN, '0912 345 678'),
        msg('incoming', t0 + 7 * MIN, '12 Nguyễn Huệ, phường Bến Nghé, quận 1'),
        msg('outgoing', t0 + 8 * MIN, CONFIRM_TEXT),
        msg('incoming', t0 + 9 * MIN, 'ok đúng rồi'),
        msg('outgoing', t0 + 10 * MIN, 'Dạ em lên đơn cho chị rồi nha, mai hàng đi ạ', { staff: true, staffName: 'Lan' }),
        msg('incoming', t0 + 12 * MIN, 'Cảm ơn shop'),
        msg('outgoing', t0 + 13 * MIN, 'Dạ cảm ơn chị đã ủng hộ Giọt Nắng ạ 🌾')
      ],
      c2: [
        msg('incoming', t0, 'shop ơi'),
        msg('incoming', t0 + 15 * MIN, 'túi vàng bao nhiêu'),
        msg('outgoing', t0 + 16 * MIN, PRICE_TEXT),
        ...[1, 2, 3, 4, 5, 6].map(i => msg('incoming', t0 + 20 * MIN + i * 10000, `tin ${i}`)),
        msg('outgoing', t0 + 22 * MIN, PRICE_TEXT)
      ],
      c3: [msg('incoming', t0, 'giá sao'), msg('outgoing', t0 + MIN, 'Dạ em đã nhắn tin cho mình rồi ạ')]
    }
  };
}

test('customerTurns: gộp tin như engine (≤ 10 phút, tối đa 5 tin, nối \\n)', () => {
  const turns = customerTurns(fakeStore().messages.c2);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'túi vàng bao nhiêu', 'tin "shop ơi" cách 15 phút không gộp');
  assert.equal(turns[1].bundle.length, 5);
  assert.equal(turns[1].text, 'tin 2\ntin 3\ntin 4\ntin 5\ntin 6');
});

test('build-dataset: gộp tin, ngữ cảnh v2 đúng, nhân viên > mẫu, bình luận mặc định bỏ', async () => {
  const stats = {};
  const cache = { [`c1:${t0 + 10 * MIN}`]: { label: 'CONFIRM_YES', confidence: 0.9 } };
  const rows = await buildRowsFromStore(fakeStore(), { templates, since: 0, cache, stats });
  const byId = Object.fromEntries(rows.map(row => [row.id, row]));
  assert.equal(stats.comments, 1, 'hội thoại bình luận bị bỏ');
  const first = byId[`c1:${t0 - 30 * MIN}`];
  assert.equal(first.label, 'PRICE_QUOTE');
  assert.equal(first.prevBot, '');
  assert.equal(first.hasOrder, false);
  assert.equal(first.orderAgeMin, null);
  const order = byId[`c1:${t0 + 3 * MIN}`];
  assert.equal(order.text, 'Cho em 2 túi xanh\n1 túi vàng nữa\nship về quận 7');
  assert.equal(order.label, 'ORDER_ADDRESS');
  assert.equal(order.labelSource, 'template');
  assert.equal(order.lastTemplate, 'PRICE_QUOTE');
  assert.equal(order.lastWasOrderStep, false);
  assert.equal(order.hasBasket, false);
  assert.equal(order.bagCount, 3);
  assert.equal(order.addressInText, true);
  assert.equal(order.phoneInText, false);
  assert.equal(order.prevBotAsks, '');
  assert.equal(order.bundleSize, 3);
  assert.equal(order.ruleTemplate, '');
  const address = byId[`c1:${t0 + 7 * MIN}`];
  assert.equal(address.text, '<sdt>\n12 Nguyễn Huệ, phường Bến Nghé, quận 1');
  assert.equal(address.label, 'ORDER_CONFIRMATION');
  assert.equal(address.lastTemplate, 'ORDER_ADDRESS');
  assert.equal(address.lastWasOrderStep, true);
  assert.equal(address.hasBasket, true);
  assert.equal(address.prevBotAsks, 'phone_address');
  assert.equal(address.phoneInText, true);
  assert.equal(address.addressInText, true);
  assert.equal(address.staffRepliedAfterBot, false);
  assert.equal(address.prevBotAgeMin, 3);
  const confirm = byId[`c1:${t0 + 9 * MIN}`];
  assert.equal(confirm.label, 'CONFIRM_YES');
  assert.equal(confirm.labelSource, 'staff');
  assert.equal(confirm.lastTemplate, 'ORDER_CONFIRMATION');
  assert.equal(confirm.prevBotAsks, 'confirm');
  assert.equal(confirm.hasOrder, true);
  assert.ok(confirm.orderAgeMin <= 1);
  const thanks = byId[`c1:${t0 + 12 * MIN}`];
  assert.equal(thanks.label, 'THANK_YOU');
  assert.equal(thanks.staffRepliedAfterBot, true, 'nhân viên nhắn sau lượt bot gần nhất');
  const c2 = rows.filter(row => row.id.startsWith('c2:'));
  assert.equal(c2.length, 2);
  assert.equal(c2[0].text, 'túi vàng bao nhiêu');
  assert.equal(c2[0].hasOrder, false, 'đơn đã hủy không tính');
  assert.equal(c2[1].text.split('\n').length, 5);
  for (const row of rows) for (const key of ['id', 'text', 'prevBot', 'prevCustomer', 'label', 'labelSource', 'source', 'lastTemplate', 'lastWasOrderStep', 'hasBasket', 'basketItems', 'hasOrder', 'orderAgeMin', 'livestream', 'prevBotAsks', 'phoneInText', 'addressInText', 'bagCount', 'ruleTemplate', 'at']) assert.ok(key in row, `thiếu trường ${key}`);
  const withComments = await buildRowsFromStore(fakeStore(), { templates, since: 0, includeComments: true, cache });
  assert.ok(withComments.some(row => row.source === 'comment' && row.livestream), '--include-comments giữ bình luận, livestream từ bài');
});

test('build-dataset CLI: chạy trên kho giả trong tmp (CRM_DATA_DIR)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crm-dataset-test-'));
  try {
    writeFileSync(path.join(dir, 'meta-conversations.json'), JSON.stringify(fakeStore()));
    writeFileSync(path.join(dir, 'chatbot-settings.json'), JSON.stringify({ messageTemplates: templates }));
    const out = path.join(dir, 'dataset.jsonl');
    const result = spawnSync(process.execPath, ['tools-intent/build-dataset.mjs', out, '--since', '2026-09-01'], { cwd: root, env: { ...process.env, CRM_DATA_DIR: dir }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const rows = readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(rows.length >= 5, `chỉ ${rows.length} dòng`);
    assert.ok(rows.every(row => !/\d{9,}/.test(row.text)), 'SĐT đã che');
    assert.match(result.stdout, /"bundled":/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('build-dataset --from-decision-log: nhãn = final, labelSource pipeline, ctx lấy nguyên', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crm-dlog-test-'));
  try {
    const entries = [
      { v: 1, at: t0, conversationId: 'c9', source: 'inbox', mid: 'm1', text: 'cho em 2 túi xanh', type: 'text', prevBot: PRICE_TEXT, prevBotAgeMin: 4, prevBotAsks: '', ctx: { hasBasket: false, basketItems: [], hasRecentOrder: true, orderAgeMin: 30, staffRepliedAfterBot: false, lastWasOrderStep: false, livestream: false, phoneInText: '', addressInText: false, bagCount: 2 }, rule: { name: 'BASKET', templateId: 'ORDER_ADDRESS' }, shadow: [], intent: null, llm: null, chosen: 'ORDER_ADDRESS', final: 'ORDER_ADDRESS', skipped: '' },
      { v: 1, at: t0 + MIN, conversationId: 'c9', source: 'inbox', mid: 'm2', text: 'ảnh', type: 'image', final: 'IMAGE_RECEIVED' },
      { v: 1, at: t0 + 2 * MIN, conversationId: 'c9', source: 'inbox', mid: 'm3', text: 'đúng rồi', type: 'text', skipped: 'nhân viên đang xử lý' },
      { v: 1, at: t0 + 3 * MIN, conversationId: 'c8', source: 'comment', mid: 'm4', text: 'giá', type: 'text', final: 'COMMENT_PUBLIC_REPLY', ctx: {} }
    ];
    mkdirSync(path.join(dir, 'log'));
    writeFileSync(path.join(dir, 'log', '2026-09-25.jsonl'), entries.map(item => JSON.stringify(item)).join('\n') + '\n{hỏng');
    const stats = {};
    const rows = rowsFromDecisionLog(readDecisionLog(path.join(dir, 'log')), { templates, stats });
    assert.equal(rows.length, 1);
    assert.equal(stats.skipped, 2);
    assert.equal(stats.comments, 1);
    const row = rows[0];
    assert.equal(row.id, 'c9:m1');
    assert.equal(row.label, 'ORDER_ADDRESS');
    assert.equal(row.labelSource, 'pipeline');
    assert.equal(row.lastTemplate, 'PRICE_QUOTE', 'suy từ prevBot khi nhật ký không ghi');
    assert.equal(row.hasOrder, true);
    assert.equal(row.orderAgeMin, 30);
    assert.equal(row.bagCount, 2);
    assert.equal(row.ruleTemplate, 'ORDER_ADDRESS');
    assert.equal(row.ruleName, 'BASKET');
    assert.equal(readDecisionLog(path.join(dir, 'log'), { since: Date.parse('2026-09-26') }).length, 0, '--since lọc theo tên tệp');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dataset-context: giỏ suy từ câu bot trước, che SĐT', () => {
  const prevBot = 'Dạ em vẫn đang giữ đơn 2 Granola Túi Xanh 450g, 1 Granola Túi Vàng 350g – tổng 447.000đ cho chị ạ';
  assert.equal(hasBasketOf({ lastTemplate: '', prevBot, prevBotAgeMin: 30 }), true);
  assert.equal(hasBasketOf({ lastTemplate: '', prevBot, prevBotAgeMin: 130 }), false, 'giỏ quá 120 phút');
  assert.equal(hasBasketOf({ lastTemplate: 'ASK_FLAVOR', prevBot: '', prevBotAgeMin: 1 }), false, 'ASK_FLAVOR chưa có túi');
  assert.equal(hasBasketOf({ lastTemplate: 'ORDER_ADDRESS', prevBot: '', prevBotAgeMin: 1 }), true);
  assert.equal(basketItemsOf({ lastTemplate: 'ORDER_ADDRESS_REMIND', prevBot }), 3);
  assert.equal(maskPhone('sđt 0912 345 678 nha\n12 Nguyễn Huệ'), 'sđt <sdt> nha\n12 Nguyễn Huệ');
});

test('relabel-policy: luật thật gán lại nhãn, nhân viên thắng luật, dòng nhân viên ≠ luật vào danh sách riêng', () => {
  const at = Date.now();
  const basketBot = 'Dạ đơn của chị gồm 2 Granola Túi Xanh 450g, tổng 298.000đ ạ 🌾 Chị cho em xin số điện thoại và địa chỉ';
  const rows = [
    { id: 'a', text: 'Xin giá', prevBot: '', lastTemplate: '', label: 'PRICE_QUOTE', labelSource: 'template', source: 'inbox', at, weak: true },
    { id: 'b', text: '<sdt>', prevBot: basketBot, lastTemplate: 'ORDER_ADDRESS', hasBasket: true, lastWasOrderStep: true, prevBotAgeMin: 2, label: 'ASK_PRODUCT', labelSource: 'template', source: 'inbox', at },
    { id: 'c', text: '<sdt>\n12 Nguyễn Huệ, phường Bến Nghé, quận 1, TP.HCM', prevBot: basketBot, lastTemplate: 'ORDER_ADDRESS', hasBasket: true, lastWasOrderStep: true, prevBotAgeMin: 2, label: 'ORDER_ADDRESS', labelSource: 'template', source: 'inbox', at },
    { id: 'd', text: 'Cảm ơn shop', label: 'ORDER_STATUS', labelSource: 'staff', source: 'inbox', at },
    { id: 'e', text: 'Túi này ăn có béo không, mình đang giảm cân, ăn buổi tối có được không ạ, tư vấn giúp mình với', label: 'CALORIES_DIET', labelSource: 'template', source: 'inbox', at },
    { id: 'f', text: 'giá sao', label: 'COMMENT_PUBLIC_REPLY', labelSource: 'template', source: 'comment', at }
  ];
  const { rows: out, matrix, conflicts, stats } = relabelRows(rows, { templates });
  const byId = Object.fromEntries(out.map(row => [row.id, row]));
  assert.deepEqual([byId.a.label, byId.a.labelSource, byId.a.ruleName], ['GENERAL_INFO', 'rule', 'TERSE_PRICE']);
  assert.equal(byId.a.weak, undefined, 'nhãn luật không còn weak');
  assert.deepEqual([byId.b.label, byId.b.ruleName], ['ORDER_ADDRESS', 'PHONE_ONLY'], 'SĐT trơn khi giữ giỏ: bộ soạn đơn giữ giỏ suy từ câu bot trước');
  assert.deepEqual([byId.c.label, byId.c.ruleName], ['ORDER_CONFIRMATION', 'PHONE_ADDRESS'], 'luật thử nghiệm bật (experimentalRules on)');
  assert.deepEqual([byId.d.label, byId.d.labelSource, byId.d.ruleTemplate], ['ORDER_STATUS', 'staff', 'THANK_YOU']);
  assert.deepEqual([byId.e.label, byId.e.labelSource, byId.e.ruleTemplate], ['CALORIES_DIET', 'template', '']);
  assert.deepEqual([byId.f.label, byId.f.ruleTemplate], ['COMMENT_PUBLIC_REPLY', 'COMMENT_RULE'], 'luật bình luận không đổi nhãn');
  assert.equal(matrix['PRICE_QUOTE → GENERAL_INFO'], 1);
  assert.equal(conflicts.length, 1);
  assert.deepEqual([conflicts[0].id, conflicts[0].staff, conflicts[0].rule], ['d', 'ORDER_STATUS', 'THANK_YOU']);
  assert.equal(stats.staffKept, 1);
});

test('merge-labels: staff > rule > mẫu ngoài POLICY_DRIFT > llm; bỏ OTHER/golden; weak theo --trust', () => {
  const rows = [
    { id: '1', text: 'a', label: 'ORDER_STATUS', labelSource: 'staff', confidence: 0.9 },
    { id: '2', text: 'b', label: 'GENERAL_INFO', labelSource: 'rule' },
    { id: '3', text: 'c', label: 'ORDER_CONFIRMATION', labelSource: 'template' },
    { id: '4', text: 'd', label: 'PRICE_QUOTE', labelSource: 'template' },
    { id: '5', text: 'e', label: 'GENERAL_INFO', labelSource: 'template' },
    { id: '6', text: 'f', label: 'OTHER', labelSource: 'template' },
    { id: '7', text: 'g', label: 'GENERAL_INFO', labelSource: 'template' },
    { id: '8', text: 'h', label: 'ASK_FLAVOR', labelSource: 'pipeline' },
    { id: '9', text: 'i', label: 'ORDER_STATUS', labelSource: 'template' }
  ];
  const labels = [
    { id: '1', label: 'THANK_YOU' }, { id: '2', label: 'PRICE_QUOTE' }, { id: '3', label: 'ORDER_STATUS' }, { id: '4', label: 'GENERAL_INFO' },
    { id: '5', label: 'GENERAL_INFO' }, { id: '8', label: 'OTHER' }, { id: '9', error: 'fetch failed' }
  ];
  const trust = trustByClass([
    ...Array.from({ length: 20 }, (_, i) => ({ truth: 'GENERAL_INFO', pipeline: i === 0 ? 'PRICE_QUOTE' : 'GENERAL_INFO' })),
    ...Array.from({ length: 5 }, () => ({ truth: 'ORDER_STATUS', pipeline: 'ORDER_STATUS' })),
    ...Array.from({ length: 20 }, (_, i) => ({ truth: 'ORDER_CONFIRMATION', pipeline: i < 10 ? 'ORDER_CONFIRMATION' : 'ORDER_ADDRESS' }))
  ]);
  assert.equal(trust.get('GENERAL_INFO').weak, false);
  assert.equal(trust.get('ORDER_STATUS').weak, true, 'n < 15');
  assert.equal(trust.get('ORDER_CONFIRMATION').weak, true, '50% < 80%');
  const { rows: out, stats } = mergeRows(rows, labels, { golden: new Set(['7']), trust });
  const byId = Object.fromEntries(out.map(row => [row.id, row]));
  assert.deepEqual([byId[1].label, byId[1].labelSource, 'confidence' in byId[1]], ['ORDER_STATUS', 'staff', false]);
  assert.deepEqual([byId[2].label, byId[2].labelSource], ['GENERAL_INFO', 'rule']);
  assert.deepEqual([byId[3].label, byId[3].labelSource, byId[3].weak], ['ORDER_CONFIRMATION', 'template', true], 'mẫu ngoài POLICY_DRIFT thắng LLM, lớp yếu → weak');
  assert.deepEqual([byId[4].label, byId[4].labelSource, byId[4].labelBefore, byId[4].weak], ['GENERAL_INFO', 'llm', 'PRICE_QUOTE', undefined]);
  assert.deepEqual([byId[5].label, byId[5].labelSource], ['GENERAL_INFO', 'both']);
  assert.equal(byId[6], undefined, 'OTHER bị bỏ');
  assert.equal(byId[7], undefined, 'golden bị bỏ');
  assert.equal(byId[8], undefined, 'LLM trả OTHER cho nhãn lệch → bỏ');
  assert.deepEqual([byId[9].label, byId[9].labelSource, byId[9].weak], ['ORDER_STATUS', 'template', true], 'nhãn LLM lỗi → giữ gốc');
  assert.equal(stats.golden, 1);
  assert.equal(stats.changed['PRICE_QUOTE → GENERAL_INFO'], 1);
  assert.deepEqual(stats.bySource, { staff: 1, rule: 1, template: 2, llm: 1, both: 1 });
  assert.ok(POLICY_DRIFT.has('ORDER_ADDRESS') && !POLICY_DRIFT.has('ORDER_CONFIRMATION'));
});

test('label-dataset: chọn dòng cần LLM, cache theo promptVersion, thử lại lỗi tạm rồi đi tiếp', async () => {
  assert.equal(needsLlmLabel({ text: 'a', label: 'PRICE_QUOTE', labelSource: 'rule' }), false);
  assert.equal(needsLlmLabel({ text: 'a', label: 'PRICE_QUOTE', labelSource: 'template', corrected: true }), false);
  assert.equal(needsLlmLabel({ text: 'a', label: 'ORDER_CONFIRMATION', labelSource: 'template' }, { onlyDrift: true }), false);
  assert.equal(needsLlmLabel({ text: 'a', label: 'ORDER_ADDRESS', labelSource: 'template' }, { onlyDrift: true }), true);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crm-llm-cache-'));
  try {
    const cachePath = path.join(dir, 'llm-labels.json');
    writeFileSync(cachePath, JSON.stringify({ promptVersion: 'old', items: { x: { label: 'A' } } }));
    assert.deepEqual(loadCache(cachePath, 'old').items, { x: { label: 'A' } });
    const fresh = loadCache(cachePath, 'new');
    assert.deepEqual([fresh.items, fresh.stale.promptVersion], [{}, 'old'], 'đổi prompt → cache cũ bị bỏ');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const cache = { promptVersion: 'v', items: { done: { label: 'GENERAL_INFO' } } };
  const calls = {};
  let flushes = 0;
  const callModel = async row => {
    calls[row.id] = (calls[row.id] || 0) + 1;
    if (row.id === 'flaky' && calls[row.id] < 2) throw new Error('fetch failed');
    if (row.id === 'dead') throw new Error('HeadersTimeoutError: Headers Timeout Error');
    if (row.id === 'bad') throw new Error('Chatbot chưa có system prompt.');
    return { label: 'PRICE_QUOTE', raw: 'PRICE_QUOTE' };
  };
  const rows = ['done', 'flaky', 'dead', 'bad', ...Array.from({ length: 21 }, (_, i) => `r${i}`)].map(id => ({ id, text: 'x' }));
  const stats = await labelRows(rows, { cache, callModel, concurrency: 2, retries: 3, wait: async () => {}, flush: () => { flushes += 1; } });
  assert.equal(calls.done, undefined, 'đã có cache thì không gọi');
  assert.equal(calls.flaky, 2);
  assert.equal(calls.dead, 3, 'lỗi tạm thử 3 lần');
  assert.equal(calls.bad, 1, 'lỗi không tạm: không thử lại');
  assert.equal(cache.items.flaky.label, 'PRICE_QUOTE');
  assert.match(cache.items.dead.error, /Timeout/);
  assert.deepEqual([stats.cached, stats.called, stats.errors], [1, 24, 2]);
  assert.ok(flushes >= 2, 'ghi cache sau mỗi 20 dòng và lúc kết thúc');
});

test('shadow-report: bảng theo ngày từ nhật ký quyết định giả', () => {
  const items = [
    { day: '2026-09-25', entry: { rule: { name: 'BASKET', templateId: 'ORDER_ADDRESS' }, shadow: [], intent: { templateId: 'ORDER_ADDRESS', p: 0.95, margin: 0.5 }, llm: null, chosen: 'ORDER_ADDRESS', final: 'ORDER_ADDRESS' } },
    { day: '2026-09-25', entry: { rule: null, shadow: [{ name: 'TERSE_HOW', templateId: 'GENERAL_INFO' }], intent: { templateId: 'GENERAL_INFO', p: 0.85, margin: 0.4 }, llm: { templateId: 'GENERAL_INFO', usage: { input: 1000, cached: 800, output: 50, thinking: 20 } }, chosen: 'GENERAL_INFO', final: 'PRICE_QUOTE', guards: { preGuard: { decision: 'pass', matched: true }, gate: { agree: true, reason: '' } } } },
    { day: '2026-09-25', entry: { skipped: 'nhân viên đang xử lý' } },
    { day: '2026-09-25', entry: { rule: null, shadow: [], intent: { templateId: 'ORDER_STATUS', p: 0.75, margin: 0.2 }, llm: { templateId: 'THANK_YOU', usage: { input: 2000, cached: 0, output: 100, thinking: 0 } }, chosen: 'THANK_YOU', final: 'THANK_YOU', guards: { gate: { agree: false, reason: 'ngoài mẫu' } }, handoff: false, attention: true } }
  ];
  const days = summarize(items);
  const day = days['2026-09-25'];
  assert.deepEqual([day.turns, day.llm, day.skipped['nhân viên đang xử lý'], day.ruleStable], [3, 2, 1, 1]);
  assert.deepEqual(day.ruleShadow, { n: 1, ok: 1, bad: 0 });
  assert.deepEqual(day.intent['0.7'], { n: 2, ok: 1, bad: 1 }, 'mô hình nhỏ chỉ đo trên lượt LLM');
  assert.deepEqual(day.intent['0.8'], { n: 1, ok: 1, bad: 0 });
  assert.deepEqual(day.intent['0.9'], { n: 0, ok: 0, bad: 0 });
  assert.deepEqual([day.preGuard.ok, day.preGuard.bad, day.preGuard.decisions.pass], [1, 0, 1]);
  assert.deepEqual([day.gate.agree, day.gate.outside, day.gate.byTemplate.THANK_YOU.outside, day.gate.reasons['ngoài mẫu']], [1, 1, 1, 1]);
  assert.equal(day.thinkingTurns, 1);
  assert.ok(Math.abs(day.cost - 0.00165) < 1e-9, `chi phí ${day.cost}`);
  const report = formatReport(days);
  assert.match(report, /2026-09-25 \| 3 \| 2 \| 1 \| 1 \| 1✓\/0✗ \| 1✓\/1✗ \| 1✓\/0✗ \| – \| 1✓\/0✗ \| 1\/1 \| 1500\/400\/75\/10 \| 1500\/75 \| 50% \| 0\.002/);
  assert.match(report, /Bỏ qua theo lý do: nhân viên đang xử lý ×1/);
});

test('shadow-report --journal: đọc log journalctl cũ', () => {
  const journal = [
    '2026-09-25T13:40:01+07:00 crm node[1]: Luật BASKET → ORDER_ADDRESS (c1)',
    '2026-09-25T13:40:02+07:00 crm node[1]: Mô hình nhỏ (thử): ORDER_ADDRESS (0.93, biên 0.50) / thật ORDER_ADDRESS ✓ (c1)',
    '2026-09-25T13:41:00+07:00 crm node[1]: Token gemini-3-flash-preview: vào 1200 (cache 900) · ra 40 · suy nghĩ 0',
    '2026-09-25T13:41:01+07:00 crm node[1]: Mô hình nhỏ (thử): PRICE_QUOTE (0.81, biên 0.30) / thật GENERAL_INFO → PRICE_QUOTE ✗ (c2)',
    '2026-09-25T13:41:02+07:00 crm node[1]: Luật TERSE_HOW (thử): luật GENERAL_INFO / luật ổn định GENERAL_INFO ✓ (c2)',
    'Sep 26 08:00:00 crm node[1]: Token gemini-3-flash-preview: vào 800 (cache 0) · ra 30 · suy nghĩ 200'
  ].join('\n');
  const items = parseJournal(journal, { year: 2026 });
  assert.equal(items.length, 6);
  const days = summarizeJournal(items);
  const d25 = days['2026-09-25'];
  assert.deepEqual([d25.turns, d25.llm, d25.ruleStable], [2, 1, 1]);
  assert.deepEqual(d25.intent['0.8'], { n: 1, ok: 0, bad: 1 }, 'lượt luật (c1) không tính; lượt LLM (c2) ✗');
  assert.deepEqual(d25.ruleShadow, { n: 1, ok: 1, bad: 0 });
  assert.deepEqual(d25.tokens.input, [1200]);
  const d26 = days['2026-09-26'];
  assert.deepEqual([d26.llm, d26.thinkingTurns], [1, 1]);
});
