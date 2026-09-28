import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './helpers/seed-catalog.mjs';
import { engineLikeRow, goldenRows, isTrusted, measureOrderCoverage, ORDER_GROUP, ruleOutcome } from '../tools-intent/order-coverage.mjs';
import { loadSeedTemplates } from '../tools-intent/relabel-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templates = loadSeedTemplates();
const row = extra => ({ id: 'x', text: '', prevBot: '', prevCustomer: '', label: 'OTHER', labelSource: 'staff', source: 'inbox', lastTemplate: '', lastWasOrderStep: false, hasBasket: false, hasOrder: false, orderAgeMin: null, livestream: false, at: 1790000000000, ...extra });

test('order-coverage: đúng bước (luật ORDER_ADDRESS+slot, nhãn là bước máy trạng thái), mã tương đương, giỏ Facebook Shop bỏ, dương tính giả', () => {
  const rows = [
    // Giỏ rõ → BASKET (ORDER_ADDRESS): nhãn ORDER_ADDRESS → đúng.
    row({ text: 'Cho mình 1 xanh 1 vàng', label: 'ORDER_ADDRESS' }),
    // SĐT trơn khi bot đang xin (giỏ có) → PHONE_ONLY; ngoại tuyến không dựng được giỏ nên render ra ASK_PRODUCT, nhưng đúng BƯỚC.
    row({ text: '0912345678', label: 'ORDER_CONFIRMATION', lastTemplate: 'ORDER_ADDRESS_PARTIAL', hasBasket: true, prevBotAgeMin: 3 }),
    // SĐT + địa chỉ khi chưa có giỏ → ORDER_INFO_ASK_FLAVOR ≡ ASK_FLAVOR (bộ chấm chấm trước khi có mẫu này).
    row({ text: 'Mình ở Biên Hòa Đồng Nai 0976594931', label: 'ASK_FLAVOR', lastTemplate: 'GENERAL_INFO', prevBotAgeMin: 3 }),
    // Giỏ Facebook Shop: engine xử lý trước luật → không tính.
    row({ text: 'Khách chọn mua từ Facebook Shop: Granola (GRA-XANH-Z450) — 189.000đ', label: 'ORDER_ADDRESS' }),
    // Không ORDER, luật ra bước MUA → dương tính giả.
    row({ text: 'Cho mình 2 túi xanh', label: 'GENERAL_INFO' }),
    // Không ORDER, luật giữ bước đơn + ý phụ (also) → không tính dương tính giả.
    row({ text: 'Có miễn ship không', label: 'FREESHIP_POLICY', lastTemplate: 'ORDER_CART_LINE', hasBasket: true, prevBotAgeMin: 3 }),
    // ORDER mà luật không bắt → lỗ.
    row({ text: 'B lên đơn cho mình chưa a', label: 'ORDER_ADDRESS_PARTIAL', lastTemplate: 'ORDER_ADDRESS', hasBasket: true, prevBotAgeMin: 3 })
  ];
  const result = measureOrderCoverage(rows, { templates });
  assert.deepEqual([result.stats.rows, result.stats.shopCart, result.stats.order, result.stats.caught, result.stats.correct, result.stats.falsePositives], [6, 1, 4, 3, 3, 1]);
  assert.deepEqual(result.misses.map(item => item.text), ['B lên đơn cho mình chưa a']);
  assert.deepEqual(result.falsePositives.map(item => item.text), ['Cho mình 2 túi xanh']);
  assert.equal(result.byLabel.ORDER_CONFIRMATION.correct, 1);
});

test('order-coverage: ctx như engine (PARTIAL/CLARIFY/CART_LINE/UPSELL → ORDER_ADDRESS), giá trị thô giữ cạnh mã sau render, tin cậy = golden/staff/corrected', () => {
  assert.equal(engineLikeRow(row({ lastTemplate: 'UPSELL_TWO_BAGS' })).lastTemplate, 'ORDER_ADDRESS');
  assert.equal(engineLikeRow(row({ lastTemplate: 'UPSELL_TWO_BAGS' })).lastWasOrderStep, true);
  assert.equal(engineLikeRow(row({ lastTemplate: 'PRICE_QUOTE' })).lastTemplate, 'PRICE_QUOTE');
  const outcome = ruleOutcome(engineLikeRow(row({ text: '0912345678', lastTemplate: 'ORDER_CART_LINE', hasBasket: true, prevBotAgeMin: 3 })), { templates });
  assert.equal(outcome.rawTemplate, 'ORDER_ADDRESS');
  assert.equal(outcome.ruleName, 'PHONE_ONLY');
  assert.deepEqual([isTrusted(row({ labelSource: 'llm' })), isTrusted(row({ labelSource: 'llm', corrected: true })), isTrusted(row({ labelSource: 'golden' })), isTrusted(row({ labelSource: 'staff' }))], [false, true, true, true]);
  assert.ok(ORDER_GROUP.has('ORDER_INFO_ASK_FLAVOR') && !ORDER_GROUP.has('GENERAL_INFO'));
});

test('order-coverage: đọc bộ chấm (bỏ trống/SKIP/bình luận, dựng ctx v2) và chạy được từ dòng lệnh', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'order-coverage-'));
  const golden = path.join(dir, 'golden.json');
  writeFileSync(golden, JSON.stringify({ items: [
    { id: 'a:1:1', text: 'Cho mình 1 xanh 1 vàng', prevBot: 'Dạ bảng giá…', source: 'inbox', lastTemplate: 'GENERAL_INFO', label: 'ORDER_ADDRESS', at: 1790000000000 },
    { id: 'a:1:2', text: '0912345678', prevBot: 'Dạ em đã nhận được địa chỉ…', source: 'inbox', lastTemplate: 'ORDER_ADDRESS_PARTIAL', label: 'ORDER_CONFIRMATION', at: 1790000060000 },
    { id: 'a:1:3', text: 'bỏ qua', source: 'inbox', lastTemplate: '', label: 'SKIP', at: 1 },
    { id: 'a:1:4', text: 'chưa chấm', source: 'inbox', lastTemplate: '', label: '', at: 1 },
    { id: 'a:1:5', text: 'Xin giá', source: 'comment', lastTemplate: '', label: 'ORDER_ADDRESS', at: 1 }
  ] }));
  const rows = await goldenRows(golden);
  assert.deepEqual(rows.map(item => [item.labelSource, item.label, item.hasBasket, item.prevBotAgeMin]), [['golden', 'ORDER_ADDRESS', false, 5], ['golden', 'ORDER_CONFIRMATION', true, 5]]);
  const out = execFileSync(process.execPath, [path.join(root, 'tools-intent', 'order-coverage.mjs'), golden, '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env } });
  const parsed = JSON.parse(out);
  assert.deepEqual([parsed.trusted.stats.order, parsed.trusted.stats.caught, parsed.trusted.stats.correct], [2, 2, 2]);
});
