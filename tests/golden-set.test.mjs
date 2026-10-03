import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.GOLDEN_SET_PATH = path.join(tempDir('golden-'), 'golden-set.json');
const { importGoldenItems, labelGoldenItem, goldenSetOverview, goldenLabeled, readGoldenSet, enrichGoldenContext, goldenContextFields } = await import('../app/golden-set.mjs');

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

test('schema mở rộng: ngữ cảnh v2 tuỳ chọn được giữ khi nạp (đúng kiểu), sai kiểu thì bỏ; mục cũ không có vẫn hợp lệ', async () => {
  const at = 1_800_000_000_000;
  await importGoldenItems([
    { id: 'c3:1', text: '<sdt> ạ', source: 'inbox', lastTemplate: 'ORDER_ADDRESS', at, hasBasket: true, basketItems: ['2 túi xanh'], hasOrder: false, orderAgeMin: null, prevBotAsks: 'phone_address', phoneInText: true, addressInText: false, bagCount: 0 },
    { id: 'c3:2', text: 'ok', source: 'inbox', at: at + 1, hasBasket: 'yes', prevBotAsks: 'lung tung', bagCount: 'x', orderAgeMin: 12.6 }
  ]);
  const state = await readGoldenSet();
  const first = state.items.find(item => item.id === 'c3:1');
  assert.deepEqual([first.hasBasket, first.basketItems, first.hasOrder, first.orderAgeMin, first.prevBotAsks, first.phoneInText, first.addressInText, first.bagCount], [true, ['2 túi xanh'], false, null, 'phone_address', true, false, 0]);
  const second = state.items.find(item => item.id === 'c3:2');
  assert.ok(!('hasBasket' in second) && !('prevBotAsks' in second) && !('bagCount' in second), 'sai kiểu → không ghi');
  assert.equal(second.orderAgeMin, 13);
  assert.ok(!('hasBasket' in state.items.find(item => item.id === 'c1:1')), 'mục cũ không bị thêm trường');
});

test('enrichGoldenContext: dựng ctx v2 từ kho giả (đơn theo createdAt/status, giỏ theo mẫu/chữ ký + hạn giỏ 24 giờ), không ghi đè trường đã có', async () => {
  const at = 1_800_000_000_000;
  const minute = 60_000;
  const store = {
    conversations: [
      { id: 'p:khach1', customerOrders: [{ id: 'o1', createdAt: at - 30 * minute, processingStatus: '' }, { id: 'o0', createdAt: at - 5 * 24 * 60 * minute, processingStatus: 'cancelled' }, { id: 'o9', createdAt: at + 10 * minute }] },
      { id: 'p:khach2', customerOrders: [{ id: 'o2', createdAt: at - 60 * minute, status: 'Hủy' }] },
      { id: 'p:khach3' }
    ],
    messages: {
      'p:khach1': [{ direction: 'outgoing', text: 'Dạ em vẫn đang giữ đơn 2 túi xanh – tổng 298k cho chị ạ', createdAt: at - 3 * minute }],
      'p:khach3': [{ direction: 'outgoing', text: 'Dạ em vẫn đang giữ đơn 1 túi nâu cho chị ạ', createdAt: at - 25 * 60 * minute }]
    }
  };
  const items = [
    { id: `p:khach1:${at}`, text: '<sdt> 12 nguyễn trãi phường 5 quận 3', prevBot: 'Dạ em vẫn đang giữ đơn 2 túi xanh – tổng 298k cho chị ạ', lastTemplate: '', at },
    { id: `p:khach2:${at}`, text: 'đơn em tới đâu rồi', prevBot: '', lastTemplate: '', at },
    { id: `p:khach3:${at}`, text: 'ok', prevBot: 'Dạ em vẫn đang giữ đơn 1 túi nâu cho chị ạ', lastTemplate: '', at },
    { id: `p:khach3:${at + 1}`, text: '2 túi xanh 1 túi vàng', prevBot: 'Chị cho em xin số điện thoại', lastTemplate: 'ORDER_ADDRESS_PARTIAL', at: at + 1, hasBasket: false, bagCount: 9 },
    { id: 'khong:co:trong:kho', text: 'giá bao nhiêu', prevBot: '', lastTemplate: 'ASK_FLAVOR', at }
  ];
  const out = enrichGoldenContext(items, store);
  assert.notEqual(out[0], items[0], 'không sửa mục vào');
  const [khach1, khach2, khach3Old, khach3Fixed, unknown] = out;
  assert.deepEqual([khach1.hasOrder, khach1.orderAgeMin, khach1.hasBasket, khach1.basketItems, khach1.prevBotAsks, khach1.phoneInText, khach1.addressInText, khach1.bagCount], [true, 30, true, ['2 túi xanh'], '', true, true, 0], 'đơn 30 phút (đơn hủy và đơn sau item.at không tính), giỏ theo chữ ký');
  assert.deepEqual([khach2.hasOrder, khach2.orderAgeMin, khach2.hasBasket], [false, null, false], 'chỉ có đơn hủy: không có đơn (như engine: đơn CHƯA hủy < 24 giờ)');
  assert.equal(khach3Old.hasBasket, false, 'câu bot trước quá 24 giờ → giỏ hết hạn');
  assert.deepEqual([khach3Fixed.hasBasket, khach3Fixed.bagCount, khach3Fixed.prevBotAsks, khach3Fixed.hasOrder], [false, 9, 'phone', false], 'trường đã có giữ nguyên, trường thiếu dựng thêm');
  assert.deepEqual([unknown.hasOrder, unknown.orderAgeMin, unknown.hasBasket, unknown.prevBotAsks], [false, null, false, 'flavor'], 'không có trong kho: không đơn');
  // Không có kho (API-less): vẫn dựng được từ chính mục; bước đơn → có giỏ.
  const [noStore] = enrichGoldenContext([{ id: 'x:1', text: '<sdt>', prevBot: 'Chị cho em xin số điện thoại và địa chỉ', lastTemplate: 'ORDER_ADDRESS', at }], null);
  assert.deepEqual([noStore.hasBasket, noStore.hasOrder, noStore.orderAgeMin, noStore.prevBotAsks, noStore.phoneInText], [true, false, null, 'phone_address', true]);
  assert.deepEqual(goldenContextFields, ['hasBasket', 'basketItems', 'hasOrder', 'orderAgeMin', 'prevBotAsks', 'phoneInText', 'addressInText', 'bagCount']);
});
