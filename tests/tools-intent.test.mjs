import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './helpers/seed-catalog.mjs';
import { buildRowsFromStore, decisionLabelOf, parseSinceDate, readDecisionLog, rowsFromDecisionLog } from '../tools-intent/build-dataset.mjs';
import { customerTurns, hasBasketOf, basketItemsOf, maskPhone, POLICY_DRIFT, readJsonl } from '../tools-intent/dataset-context.mjs';
import { basketContextKnown, loadSeedTemplates, relabelRows, templatesFromSettings } from '../tools-intent/relabel-policy.mjs';
import { goldenIndex, goldenMatch, mergeRows, trustByClass } from '../tools-intent/merge-labels.mjs';
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
  assert.match(report, /\| Luật ổn \| Luật ổn định \(ẩn\) \| Luật thử \|/);
  assert.match(report, /2026-09-25 \| 3 \| 2 \| 1 \| 1 \| – \| 1✓\/0✗ \| 1✓\/1✗ \| 1✓\/0✗ \| – \| 1✓\/0✗ \| 1\/1 \| 1500\/400\/75\/10 \| 1500\/75 \| 50% \| 0\.002/);
  assert.match(report, /Bỏ qua theo lý do: nhân viên đang xử lý ×1/);
});

test('shadow-report (vòng 12): "~" loại khỏi n cho mô hình nhỏ và tầng; tầng đoán OTHER vẫn đếm nhóm; tách luật ổn định ẩn / luật thử', () => {
  const groupOf = id => (/^ORDER_/.test(id) ? 'ORDER' : /^(PRICE_|GENERAL_INFO)/.test(id) ? 'ANSWER' : 'OTHER');
  const llm = { templateId: 'X', usage: { input: 10, cached: 0, output: 1, thinking: 0 } };
  const items = [
    // "đã gửi ở trên" (trung tính): không vào n của mô hình nhỏ lẫn tầng.
    { day: '2026-09-27', entry: { rule: null, shadow: [], intent: { templateId: 'PRICE_QUOTE', p: 0.95, margin: 0.5 }, cascade: { group: 'ANSWER', templateId: 'PRICE_QUOTE', p: 0.95 }, llm, chosen: 'REPLY_ALREADY_SENT_INFO', final: 'REPLY_ALREADY_SENT_INFO' } },
    { day: '2026-09-27', entry: { rule: null, shadow: [], intent: { templateId: 'PRICE_QUOTE', p: 0.95, margin: 0.5 }, cascade: { group: 'ANSWER', templateId: 'PRICE_QUOTE', p: 0.95 }, llm, chosen: 'REPLY_ALREADY_SENT', final: 'REPLY_ALREADY_SENT' } },
    // Tầng đoán OTHER (không mẫu), thật là mẫu ngoài bảng → nhóm ✓, không vào cột mẫu.
    { day: '2026-09-27', entry: { rule: null, shadow: [], intent: null, cascade: { group: 'OTHER', templateId: null, p: 0.9 }, llm, chosen: 'TRIAL_PRICE', final: 'TRIAL_PRICE' } },
    // Luật ổn định chạy ẩn (không dùng thật) + luật thử đính kèm.
    { day: '2026-09-27', entry: { rule: null, shadow: [{ name: 'TERSE_PRICE', templateId: 'GENERAL_INFO' }, { name: 'PHONE_ONLY', templateId: 'ORDER_ADDRESS' }], intent: null, llm, chosen: 'GENERAL_INFO', final: 'GENERAL_INFO' } },
    // Có luật thật: mục shadow là luật thử, so với luật thật.
    { day: '2026-09-27', entry: { rule: { name: 'BASKET', templateId: 'ORDER_ADDRESS' }, shadow: [{ name: 'X', templateId: 'ORDER_CONFIRMATION' }], intent: null, llm: null, chosen: 'ORDER_ADDRESS', final: 'ORDER_ADDRESS' } }
  ];
  const day = summarize(items, undefined, { groupOf })['2026-09-27'];
  assert.deepEqual(day.intent['0.9'], { n: 0, ok: 0, bad: 0 }, '"~" không vào n của mô hình nhỏ');
  assert.deepEqual(day.cascade.tpl['0.9'], { n: 0, ok: 0, bad: 0 }, '"~" và tầng không mẫu không vào cột mẫu');
  assert.deepEqual(day.cascade.group, { n: 1, ok: 1, bad: 0, danger: 0 }, 'tầng đoán OTHER vẫn đếm nhóm');
  assert.equal(day.cascade.byGroup.OTHER.refused, 1);
  assert.deepEqual(day.ruleHidden, { n: 1, ok: 1, bad: 0 }, 'luật ổn định ẩn so với mẫu đã chọn');
  assert.deepEqual(day.ruleShadow, { n: 2, ok: 0, bad: 2 }, 'luật thử so với luật ổn định (ẩn hay thật)');
  const report = formatReport({ '2026-09-27': day });
  assert.match(report, /^2026-09-27 \| 5 \| 4 \| 0 \| 1 \| 1✓\/0✗ \| 0✓\/2✗ \|/m);
  assert.match(report, /OTHER 1 \(nhóm 100%, mẫu 0✓\/0✗, không mẫu 1\)/);
});

test('shadow-report CLI: giá không phải số / --journal không tồn tại / --since sai → lỗi gọn, mã 1', () => {
  const script = path.join(root, 'tools-intent', 'shadow-report.mjs');
  const runIt = extra => spawnSync(process.execPath, [script, ...extra], { cwd: root, encoding: 'utf8' });
  const price = runIt(['--price-in', 'abc']);
  assert.equal(price.status, 1);
  assert.match(price.stderr, /--price-in phải là số/);
  const journal = runIt(['--journal', path.join(os.tmpdir(), 'khong-co-journal.txt')]);
  assert.equal(journal.status, 1);
  assert.match(journal.stderr, /Không thấy tệp journal/);
  assert.doesNotMatch(journal.stderr, /at .*node:internal/, 'không in stack');
  assert.equal(runIt(['--since', '28/09/2026']).status, 1);
  assert.equal(runIt(['--dir']).status, 1, 'cờ thiếu giá trị');
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

test('shadow-report: cột mô hình tầng từ trường `cascade` (nhóm ✓, mẫu ✓ theo ngưỡng, theo nhóm; chỉ lượt LLM) + journal "Mô hình tầng (thử)"', () => {
  const groupOf = id => (/^(PRICE_|GENERAL_INFO|DISCOUNT_POLICY)/.test(id) ? 'PRICE' : /^ORDER_/.test(id) ? 'ORDER' : 'INFO');
  const items = [
    // Lượt luật: có cascade nhưng không đo (như mô hình nhỏ).
    { day: '2026-09-26', entry: { rule: { name: 'BASKET', templateId: 'ORDER_ADDRESS' }, shadow: [], intent: null, cascade: { group: 'ORDER', pGroup: 0.99, templateId: 'ORDER_ADDRESS', p: 0.95, margin: 0.7, topK: [], path: 'ORDER>ORDER_ADDRESS' }, llm: null, chosen: 'ORDER_ADDRESS', final: 'ORDER_ADDRESS' } },
    // Lượt LLM, mẫu đúng (chosen = GENERAL_INFO, final đổi sang PRICE_QUOTE ở hậu xử lý) → ✓ ở 0,7/0,8, không tới 0,9.
    { day: '2026-09-26', entry: { rule: null, shadow: [], intent: null, cascade: { group: 'PRICE', pGroup: 0.96, templateId: 'GENERAL_INFO', p: 0.85, margin: 0.5, topK: [], path: 'PRICE>GENERAL_INFO' }, llm: { templateId: 'GENERAL_INFO', usage: { input: 1000, cached: 0, output: 50, thinking: 0 } }, chosen: 'GENERAL_INFO', final: 'PRICE_QUOTE' } },
    // Lượt LLM, chỉ đúng nhóm (PRICE_QUOTE dự đoán, thật DISCOUNT_POLICY) → nhóm ✓, mẫu ✗ ở 0,7/0,8/0,9.
    { day: '2026-09-26', entry: { rule: null, shadow: [], intent: null, cascade: { group: 'PRICE', pGroup: 0.9, templateId: 'PRICE_QUOTE', p: 0.92, margin: 0.4, topK: [], path: 'PRICE>PRICE_QUOTE' }, llm: { templateId: 'DISCOUNT_POLICY', usage: { input: 1000, cached: 0, output: 50, thinking: 0 } }, chosen: 'DISCOUNT_POLICY', final: 'DISCOUNT_POLICY' } },
    // Lượt LLM, sai cả nhóm (INFO dự đoán, thật ORDER_ADDRESS) → nhóm ✗, mẫu ✗ ở 0,7 (p 0,75).
    { day: '2026-09-26', entry: { rule: null, shadow: [], intent: null, cascade: { group: 'INFO', pGroup: 0.6, templateId: 'PACKAGING_INFO', p: 0.75, margin: 0.3, topK: [], path: 'INFO>PACKAGING_INFO' }, llm: { templateId: 'ORDER_ADDRESS', usage: { input: 1000, cached: 0, output: 50, thinking: 0 } }, chosen: 'ORDER_ADDRESS', final: 'ORDER_ADDRESS' } }
  ];
  const day = summarize(items, undefined, { groupOf })['2026-09-26'];
  assert.deepEqual([day.turns, day.llm], [4, 3]);
  assert.deepEqual(day.cascade.group, { n: 3, ok: 2, bad: 1, danger: 1 }, 'nhóm ✓ khi mẫu tương đương hay chỉ đúng nhóm; ✗ vào ORDER là nguy hiểm');
  assert.deepEqual(day.cascade.tpl['0.7'], { n: 3, ok: 1, bad: 2 });
  assert.deepEqual(day.cascade.tpl['0.8'], { n: 2, ok: 1, bad: 1 });
  assert.deepEqual(day.cascade.tpl['0.9'], { n: 1, ok: 0, bad: 1 });
  assert.deepEqual(day.cascade.byGroup, { PRICE: { n: 2, groupOk: 2, tplOk: 1, tplBad: 1, danger: 0 }, INFO: { n: 1, groupOk: 0, tplOk: 0, tplBad: 1, danger: 1 } });
  const report = formatReport({ '2026-09-26': day });
  assert.match(report, /\| Tầng nhóm \| Tầng≥0,7 \| Tầng≥0,8 \| Tầng≥0,9$/m);
  assert.match(report, /^2026-09-26 \| 4 \| 3 \|.*\| 2✓\/1✗ ⚠1 \| 1✓\/2✗ \| 1✓\/1✗ \| 0✓\/1✗$/m);
  assert.match(report, /Mô hình tầng theo nhóm \(lượt LLM\): PRICE 2 \(nhóm 100%, mẫu 1✓\/1✗\) · INFO 1 \(nhóm 0%, mẫu 0✓\/1✗, ⚠1 vào ORDER\/SUPPORT\)/);
  assert.match(report, /Mô hình tầng ✗ nguy hiểm \(thật là ORDER\/SUPPORT mà tầng đoán nhóm khác\): 1/);
  // Không có groupOf (thiếu mô-đun tầng): vẫn đếm mẫu ✓; nhóm chỉ ✓ khi mẫu tương đương; không kết luận được ✗ nguy hiểm.
  const blind = summarize(items, undefined, { groupOf: () => '' })['2026-09-26'];
  assert.deepEqual(blind.cascade.group, { n: 3, ok: 1, bad: 2, danger: 0 });
  // Journal: dòng "Mô hình tầng (thử)" đi sau dòng "Mô hình nhỏ" cùng hội thoại dùng chung kết luận lượt luật/LLM; dấu lấy từ dòng log.
  const journal = [
    '2026-09-26T09:00:00+07:00 crm node[1]: Luật BASKET → ORDER_ADDRESS (c1)',
    '2026-09-26T09:00:01+07:00 crm node[1]: Mô hình nhỏ (thử): ORDER_ADDRESS (0.93, biên 0.50) / thật ORDER_ADDRESS ✓ (c1)',
    '2026-09-26T09:00:01+07:00 crm node[1]: Mô hình tầng (thử): ORDER 0.99 / ORDER_ADDRESS 0.95 (biên 0.70) / thật ORDER_ADDRESS ✓ (c1)',
    '2026-09-26T09:01:00+07:00 crm node[1]: Token gemini-3-flash-preview: vào 1200 (cache 900) · ra 40 · suy nghĩ 0',
    '2026-09-26T09:01:01+07:00 crm node[1]: Mô hình tầng (thử): PRICE 0.90 / PRICE_QUOTE 0.92 (biên 0.40) / thật DISCOUNT_POLICY nhóm✓ (c2)',
    '2026-09-26T09:02:00+07:00 crm node[1]: Token gemini-3-flash-preview: vào 1200 (cache 900) · ra 40 · suy nghĩ 0',
    '2026-09-26T09:02:01+07:00 crm node[1]: Mô hình tầng: INFO 0.96 / BAG_COMPARISON 0.93 (biên 0.60) / thật BAG_COMPARISON → CSKH_HANDOFF ✓ (c3)',
    '2026-09-26T09:03:01+07:00 crm node[1]: Mô hình tầng (thử): INFO 0.60 / PACKAGING_INFO 0.75 (biên 0.30) / thật ORDER_ADDRESS ✗ (c4)'
  ].join('\n');
  const parsed = parseJournal(journal, { year: 2026 });
  assert.equal(parsed.length, 8);
  assert.deepEqual(parsed[2].entry.cascade, { group: 'ORDER', pGroup: 0.99, templateId: 'ORDER_ADDRESS', p: 0.95, margin: 0.7 });
  assert.equal(parsed[2].entry.llm, null, 'c1 là lượt luật');
  assert.deepEqual([parsed[4].entry.mark, parsed[4].entry.chosen, parsed[6].entry.final], ['nhóm✓', 'DISCOUNT_POLICY', 'CSKH_HANDOFF']);
  const d = summarizeJournal(parsed)['2026-09-26'];
  assert.deepEqual([d.turns, d.llm, d.ruleStable], [3, 2, 1], 'lượt = 1 luật + 2 dòng Token');
  assert.deepEqual([d.cascade.group.n, d.cascade.group.ok, d.cascade.group.bad], [3, 2, 1], 'lượt luật c1 không tính');
  assert.ok(d.cascade.group.danger === 0 || d.cascade.group.danger === 1, 'journal: ✗ nguy hiểm chỉ đếm được khi có mô-đun tầng (c4 thật ORDER_ADDRESS)');
  assert.deepEqual(d.cascade.tpl['0.9'], { n: 2, ok: 1, bad: 1 });
  assert.deepEqual(d.cascade.tpl['0.7'], { n: 3, ok: 1, bad: 2 });
});

// ---- Vòng 12: T1/T3/T4/V2/V3/V4 + CLI ----

test('build-dataset --from-decision-log (vòng 12): prevBot là MÃ MẪU → lastTemplate; prevBotText/basket; nhãn chosen sau gác; khử trùng; đếm hỏng/trước since', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crm-dlog12-'));
  try {
    const base = { v: 1, conversationId: 'c7', source: 'inbox', type: 'text', ctx: { hasBasket: true, hasRecentOrder: false, orderAgeMin: null, lastWasOrderStep: true, livestream: false, phoneInText: true, addressInText: false, bagCount: 0 } };
    const entries = [
      { ...base, at: t0, mid: 'm1', text: '0912 345 678', prevBot: 'ORDER_CART_LINE', prevBotText: 'Dạ đơn của chị gồm 2 Granola Túi Xanh 450g, chị cho em xin <sdt> và địa chỉ', basket: [{ sku: 'GRA-XANH-Z450', quantity: 2 }], prevBotAsks: 'phone_address', chosen: 'ORDER_ADDRESS', final: 'ORDER_ADDRESS' },
      { ...base, at: t0 + MIN, mid: 'm2', text: 'giá sao', prevBot: 'PRICE_QUOTE', chosen: 'PRICE_QUOTE', final: 'REPLY_ALREADY_SENT', ctx: {} },
      { ...base, at: t0 + 2 * MIN, mid: 'm2', text: 'giá sao', prevBot: 'PRICE_QUOTE', chosen: 'PRICE_QUOTE', final: 'REPLY_ALREADY_SENT', ctx: {} },
      { ...base, at: t0 + 3 * MIN, mid: 'm3', text: 'sửa lại 3 túi', prevBot: 'ORDER_CONFIRMATION', chosen: 'ORDER_UPDATE', final: 'ORDER_UPDATE', ctx: {} },
      { ...base, at: t0 - 5 * 24 * 60 * MIN, mid: 'm0', text: 'cũ', prevBot: '', final: 'GENERAL_INFO', ctx: {} }
    ];
    mkdirSync(path.join(dir, 'log'));
    writeFileSync(path.join(dir, 'log', '2026-09-25.jsonl'), entries.map(item => JSON.stringify(item)).join('\n') + '\n{"v":1,"at":');
    const readStats = {};
    const logged = readDecisionLog(path.join(dir, 'log'), { stats: readStats });
    assert.deepEqual([logged.length, readStats.bad, readStats.files], [5, 1, 1], 'dòng ghi dở bỏ và đếm');
    const stats = {};
    const rows = rowsFromDecisionLog(logged, { templates, stats, since: t0 - 60 * MIN });
    assert.deepEqual([rows.length, stats.duplicates, stats.beforeSince], [3, 1, 1]);
    const [cart, already, update] = rows;
    assert.deepEqual([cart.lastTemplate, cart.prevBot.startsWith('Dạ đơn của chị gồm'), cart.prevBotAsks, cart.hasBasket, cart.basketItems, cart.lastWasOrderStep], ['ORDER_ADDRESS', true, 'phone_address', true, 2, true], 'mã con quy về mã engine; câu bot từ prevBotText');
    assert.deepEqual(cart.basket, [{ sku: 'GRA-XANH-Z450', quantity: 2 }]);
    assert.equal(cart.text, '<sdt>');
    assert.deepEqual([already.label, already.prevBot, already.lastTemplate, already.final], ['PRICE_QUOTE', '', 'PRICE_QUOTE', 'REPLY_ALREADY_SENT'], 'nhãn = chosen khi final là mẫu gác; không đưa mã mẫu làm câu bot');
    assert.equal(update.label, 'ORDER_UPDATED', 'mã engine ORDER_UPDATE → mã mẫu');
    assert.equal(decisionLabelOf({ final: 'ORDER_ADDRESS_REMIND', chosen: 'SHIPPING_POLICY' }), 'SHIPPING_POLICY');
    assert.equal(decisionLabelOf({ final: 'GENERAL_INFO', chosen: 'PRICE_QUOTE' }), 'GENERAL_INFO', 'hậu xử lý thường: nhãn = final');
    assert.ok(Number.isNaN(parseSinceDate('28/09/2026')) && Number.isNaN(parseSinceDate('2026-02-30')));
    assert.equal(parseSinceDate('2026-09-28'), Date.parse('2026-09-28T00:00:00+07:00'));
    // CLI: --since sai / thiếu thư mục → lỗi rõ, mã 1; --since mặc định in ra.
    writeFileSync(path.join(dir, 'chatbot-settings.json'), JSON.stringify({ messageTemplates: {} }));
    const cli = extra => spawnSync(process.execPath, ['tools-intent/build-dataset.mjs', path.join(dir, 'out.jsonl'), ...extra], { cwd: root, env: { ...process.env, CRM_DATA_DIR: dir }, encoding: 'utf8' });
    const badSince = cli(['--from-decision-log', path.join(dir, 'log'), '--since', 'hôm qua']);
    assert.equal(badSince.status, 1);
    assert.match(badSince.stderr, /--since sai định dạng/);
    const noDir = cli(['--from-decision-log']);
    assert.equal(noDir.status, 1);
    assert.match(noDir.stderr, /Thiếu giá trị cho --from-decision-log/);
    assert.equal(cli(['--from-decision-log', path.join(dir, 'khong-co')]).status, 1);
    const ok = cli(['--from-decision-log', path.join(dir, 'log')]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Từ ngày 2026-09-18 \(giờ Việt Nam\) — mặc định/);
    assert.match(ok.stdout, /hỏng \(bỏ\) 1 · trước 2026-09-18 0 · trùng id 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('relabel-policy (vòng 12): --templates gộp seed như engine (T1); giỏ không dựng được → giữ nhãn gốc, weak, không `rule` (T4); dòng nhật ký bước đơn giữ nguyên; giỏ từ basket[sku]', () => {
  // T1: settings chỉ lưu vài mẫu → vẫn đủ mẫu seed (không rơi GENERAL_INFO/CSKH_HANDOFF).
  const partial = templatesFromSettings({ messageTemplates: { GENERAL_INFO: 'Dạ bảng giá {x}' } });
  assert.ok(partial.ASK_FLAVOR && partial.ORDER_INFO_ASK_FLAVOR && partial.PRICE_QUOTE, 'mẫu seed gộp vào');
  assert.equal(partial.GENERAL_INFO, 'Dạ bảng giá {x}', 'mẫu đã lưu thắng seed');
  const at = Date.now();
  const v1 = extra => ({ id: 'v', text: 'Cho mình 2 túi', prevBot: '', lastTemplate: '', label: 'ORDER_ADDRESS', labelSource: 'llm', source: 'inbox', hasBasket: false, lastWasOrderStep: false, at, ...extra });
  const rows = [
    v1({ id: 'v1' }), // v1 (không prevBotAgeMin): BAGS_NO_FLAVOR → ASK_FLAVOR phụ thuộc giỏ không biết → giữ ORDER_ADDRESS, weak
    v1({ id: 'v2', text: 'Gửi chung nguyễn xóm 7 thôn độ chàng xã Đại Thành quốc oai Hà Nội <sdt>', label: 'ORDER_CONFIRMATION', lastTemplate: 'ORDER_ADDRESS', prevBot: 'Dạ để lên đơn đúng tuyến, chị cho em xin số điện thoại và địa chỉ' }),
    v1({ id: 'v3', prevBotAgeMin: null }), // v2 biết chắc không có giỏ → luật thắng (ASK_FLAVOR)
    v1({ id: 'p1', text: '<sdt>', label: 'ORDER_CONFIRMATION', labelSource: 'pipeline', lastTemplate: 'ORDER_ADDRESS', hasBasket: true, prevBotAgeMin: 2 }), // nhật ký, có giỏ mà không dựng được → giữ nhãn engine
    v1({ id: 'b1', text: '<sdt>', label: 'ORDER_ADDRESS', labelSource: 'pipeline', lastTemplate: 'ORDER_ADDRESS', hasBasket: true, prevBotAgeMin: 2, basket: [{ sku: 'GRA-XANH-Z450', quantity: 2 }] })
  ];
  const { rows: out, stats } = relabelRows(rows, { templates });
  const byId = Object.fromEntries(out.map(row => [row.id, row]));
  assert.deepEqual([byId.v1.label, byId.v1.labelSource, byId.v1.weak, byId.v1.ruleUncertain], ['ORDER_ADDRESS', 'llm', true, true]);
  assert.deepEqual([byId.v2.label, byId.v2.labelSource, byId.v2.weak], ['ORDER_CONFIRMATION', 'llm', true], 'ORDER_CONFIRMATION → ORDER_INFO_ASK_FLAVOR không còn');
  assert.deepEqual([byId.v3.label, byId.v3.labelSource], ['ASK_FLAVOR', 'rule']);
  assert.deepEqual([byId.p1.label, byId.p1.labelSource, byId.p1.weak], ['ORDER_CONFIRMATION', 'pipeline', undefined], 'nhật ký bước đơn: giữ nhãn engine, không weak');
  assert.deepEqual([byId.b1.labelSource, byId.b1.ruleUncertain], ['rule', undefined], 'giỏ dựng từ basket[sku] → luật gắn được');
  assert.ok(stats.basketUnknown >= 3 && stats.pipelineKept === 1);
  assert.ok(basketContextKnown({ prevBotAgeMin: null }) && !basketContextKnown({}) && basketContextKnown({ basket: [] }));
  // Mẫu luật ra không có trong bộ mẫu → không gắn rule, ghi lý do.
  const noTemplates = relabelRows([{ id: 'x', text: 'Xin giá', label: 'PRICE_QUOTE', labelSource: 'template', source: 'inbox', at }], { templates: { ASK_FLAVOR: 'x' } });
  assert.deepEqual([noTemplates.rows[0].labelSource, noTemplates.rows[0].ruleMissingTemplate, noTemplates.stats.missingTemplate], ['template', 'GENERAL_INFO', 1]);
});

test('merge-labels (vòng 12): loại golden theo id / cùng hội thoại ±10 phút / chữ trùng; giữ OTHER nhân viên; --trust bỏ LỖI; CLI --trust {} không crash', () => {
  const at = 1_800_000_000_000;
  const golden = goldenIndex([{ id: `p:u1:${at}`, text: 'cho mình hỏi túi xanh với túi vàng khác nhau chỗ nào', at }, { id: 'p:u9:1', text: 'ok', at: 1 }]);
  assert.equal(goldenMatch({ id: `p:u1:${at}` }, golden), 'id');
  assert.equal(goldenMatch({ id: 'p:u1:mid_abc', at: at + 5 * MIN, text: 'khác' }, golden), 'near', 'cùng hội thoại, lệch 5 phút');
  assert.equal(goldenMatch({ id: 'p:u1:mid_abc', at: at + 30 * MIN, text: 'khác' }, golden), '');
  assert.equal(goldenMatch({ id: 'p:u2:1', at: 5, text: 'Cho mình hỏi túi Xanh với túi Vàng khác nhau chỗ nào?' }, golden), 'text');
  assert.equal(goldenMatch({ id: 'p:u3:1', at: 5, text: 'ok' }, golden), '', 'chữ ngắn chung chung không tính');
  const rows = [
    { id: 'a', text: 'không có mẫu', label: 'OTHER', labelSource: 'staff' },
    { id: 'b', text: 'x', label: 'OTHER', labelSource: 'template' },
    { id: 'c', text: 'y', label: 'GENERAL_INFO', labelSource: 'template' }
  ];
  const kept = mergeRows(rows, [], {});
  assert.deepEqual(kept.rows.map(row => row.id), ['a', 'c'], 'OTHER nhân viên giữ, OTHER khác bỏ');
  assert.deepEqual(mergeRows(rows, [], { keepOther: true }).rows.map(row => row.id), ['a', 'b', 'c'], '--keep-other');
  const trust = trustByClass([...Array.from({ length: 16 }, () => ({ truth: 'GENERAL_INFO', pipeline: 'GENERAL_INFO' })), ...Array.from({ length: 10 }, () => ({ truth: 'GENERAL_INFO', pipeline: 'LỖI fetch failed' }))]);
  assert.deepEqual([trust.get('GENERAL_INFO').n, trust.get('GENERAL_INFO').errors, trust.get('GENERAL_INFO').weak], [16, 10, false], 'LỖI không tính là sai');
  assert.equal(trustByClass({}).size, 0, 'không phải mảng → rỗng');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crm-merge12-'));
  try {
    writeFileSync(path.join(dir, 'd.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n{"id":"hỏng');
    writeFileSync(path.join(dir, 'l.jsonl'), '');
    writeFileSync(path.join(dir, 'trust.json'), '{}');
    const cli = extra => spawnSync(process.execPath, ['tools-intent/merge-labels.mjs', path.join(dir, 'd.jsonl'), path.join(dir, 'l.jsonl'), path.join(dir, 'o.jsonl'), ...extra], { cwd: root, encoding: 'utf8' });
    const ok = cli(['--trust', path.join(dir, 'trust.json')]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /không phải mảng kết quả replay-llm: bỏ qua --trust/);
    assert.match(ok.stderr, /Bỏ 1 dòng hỏng/);
    const missing = cli(['--trust']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Thiếu giá trị cho --trust/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readJsonl: dòng ghi dở bỏ qua và đếm; label-dataset / replay-llm: --limit/--concurrency không phải số → lỗi (không gọi mạng)', () => {
  const stats = {};
  assert.deepEqual(readJsonl('{"a":1}\n\n{"b":\n{"c":3}', stats), [{ a: 1 }, { c: 3 }]);
  assert.deepEqual([stats.bad, stats.badLines], [1, [3]]);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crm-cli12-'));
  try {
    writeFileSync(path.join(dir, 'in.jsonl'), '');
    const label = spawnSync(process.execPath, ['tools-intent/label-dataset.mjs', path.join(dir, 'in.jsonl'), path.join(dir, 'out.jsonl'), '--limit', 'mười'], { cwd: root, encoding: 'utf8' });
    assert.equal(label.status, 1);
    assert.match(label.stderr, /--limit phải là số nguyên dương/);
    const concurrency = spawnSync(process.execPath, ['tools-intent/label-dataset.mjs', path.join(dir, 'in.jsonl'), path.join(dir, 'out.jsonl'), '--concurrency', '0'], { cwd: root, encoding: 'utf8' });
    assert.equal(concurrency.status, 1);
    writeFileSync(path.join(dir, 'golden.json'), JSON.stringify({ items: [] }));
    const replay = spawnSync(process.execPath, ['tools-intent/replay-llm.mjs', path.join(dir, 'golden.json'), '--limit', 'abc'], { cwd: root, encoding: 'utf8' });
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /--limit phải là số nguyên dương/);
    const relabel = spawnSync(process.execPath, ['tools-intent/relabel-policy.mjs', path.join(dir, 'in.jsonl'), path.join(dir, 'o.jsonl'), '--templates'], { cwd: root, encoding: 'utf8' });
    assert.equal(relabel.status, 1);
    assert.match(relabel.stderr, /Thiếu giá trị cho --templates/);
    const golden = spawnSync(process.execPath, ['tools-intent/replay-golden.mjs', path.join(dir, 'golden.json'), '--model'], { cwd: root, encoding: 'utf8' });
    assert.equal(golden.status, 1);
    assert.match(golden.stderr, /Thiếu giá trị cho --model/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
