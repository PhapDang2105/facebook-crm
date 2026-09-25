import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.GOLDEN_SET_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'golden-')), 'golden-set.json');
const { importGoldenItems, labelGoldenItem, goldenSetOverview, goldenLabeled } = await import('../app/golden-set.mjs');

test('bộ test vàng: nạp tin (không trùng id, giữ nhãn đã chấm), chấm nhãn, bỏ qua, tóm tắt gợi ý đúng/sai', async () => {
  const items = [
    { id: 'c1:1', text: 'giá bao nhiêu', source: 'inbox', suggested: 'GENERAL_INFO', at: 1 },
    { id: 'c1:2', text: 'túi xanh có ngọt không', source: 'inbox', suggested: 'NO_ADDED_SUGAR', prevBot: 'Dạ bảng giá…', lastTemplate: 'GENERAL_INFO', at: 2 },
    { id: 'c2:1', text: '.', source: 'comment', suggested: 'COMMENT_PUBLIC_REPLY', at: 3 }
  ];
  assert.deepEqual(await importGoldenItems(items), { added: 3, total: 3 });
  assert.deepEqual(await importGoldenItems(items), { added: 0, total: 3 }, 'nạp lại không nhân đôi');
  let overview = await goldenSetOverview({ batch: 10 });
  assert.equal(overview.pending.length, 3);
  assert.equal((await labelGoldenItem('c1:1', 'general_info')).label, 'GENERAL_INFO');
  assert.equal((await labelGoldenItem('c1:2', 'BAG_COMPARISON')).label, 'BAG_COMPARISON');
  assert.equal((await labelGoldenItem('c2:1', 'SKIP')).label, 'SKIP');
  assert.equal(await labelGoldenItem('khong:co', 'X'), null);
  await assert.rejects(() => labelGoldenItem('c1:1', ''), /Thiếu mã mẫu/);
  overview = await goldenSetOverview({ batch: 10 });
  assert.deepEqual([overview.total, overview.labeled, overview.skipped, overview.judged, overview.agreeWithSuggestion, overview.pending.length], [3, 3, 1, 2, 1, 0]);
  assert.deepEqual((await goldenLabeled()).map(item => [item.id, item.label]), [['c1:1', 'GENERAL_INFO'], ['c1:2', 'BAG_COMPARISON']]);
  // Nạp lại sau khi chấm: nhãn giữ nguyên.
  await importGoldenItems([{ id: 'c1:1', text: 'giá bao nhiêu', source: 'inbox', suggested: 'PRICE_QUOTE', at: 1 }]);
  assert.equal((await goldenLabeled())[0].label, 'GENERAL_INFO');
});
