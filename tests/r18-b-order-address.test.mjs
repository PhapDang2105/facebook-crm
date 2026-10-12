// Vòng 18 — Gói B: địa chỉ trên đơn bot chốt (out-inbox2 N2/N3, out-inbox3 N5/V12). Chạy engine thật (Sim) với câu khách THẬT;
// SĐT là số giả, số nhà đổi bớt.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, VANG, basket } from './helpers/r13-engine-sim.mjs';

const MIN = 60 * 1000;
const said = turn => turn.sent.map(item => item.text).join('\n');
const noModel = () => { throw new Error('luật/code phải tự xử lý, không gọi mô hình'); };

test('R18-B N2 (inbox2, …423891): sửa số túi ("6b") mà mô hình viết lại địa chỉ sang tỉnh khác → giữ địa chỉ đơn', async () => {
  const sim = new Sim({ psid: 'r18b-n2' });
  const typed = 'Số 25, đinh công tráng, phường hắc dịch, brvt';
  const inbox = sim.inbox({
    botLastTemplateId: 'ORDER_UPDATE', botLastReplyAt: Date.now() - MIN,
    customerOrders: [{ id: 'd214', automatic: true, createdAt: Date.now() - MIN, phone: PHONE, address: typed, rawAddress: typed, total: 189000, status: 'Mới', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1 }] }]
  });
  const turn = await sim.send(inbox, '6b', { llm: { template_id: 'ORDER_UPDATE', Product_N1: 'Granola Túi Xanh 450g', No_A: '6', Phone_Number: PHONE, Customer_Address: 'Số 25, đinh công tráng, Phường Tân Định, Quận 1, TP Hồ Chí Minh' } });
  const update = turn.created.find(item => item.update);
  assert.ok(update, said(turn));
  assert.doesNotMatch(`${update.address} ${update.rawAddress}`, /Tân Định|Quận 1/u, JSON.stringify(update));
  assert.match(update.rawAddress || update.address, /hắc dịch/iu);
  assert.doesNotMatch(said(turn), /Tân Định/u);
});

test('R18-B N2: lượt thường — địa chỉ mô hình có phường KHÔNG có trong chữ khách gõ → dùng chữ khách', async () => {
  const sim = new Sim({ psid: 'r18b-n2b', settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], MIN, { phone: PHONE }) });
  const turn = await sim.send(inbox, 'Số 25 đinh công tráng phường hắc dịch brvt nha', { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: PHONE, Customer_Address: 'Số 25 Đinh Công Tráng, Phường Tân Định, Quận 1, TP Hồ Chí Minh' } });
  const all = `${said(turn)}\n${turn.created.map(item => `${item.address} ${item.rawAddress}`).join('\n')}\n${String(inbox.pendingOrder?.address || '')}`;
  assert.doesNotMatch(all, /Tân Định/u, all);
  assert.match(all, /hắc dịch/iu);
  // Nhân viên được ghi chú để đối chiếu.
  assert.match(String(turn.created[0]?.addressCheck || inbox.pendingOrder?.staffCheck || ''), /không có trong tin khách/u);
});

test('R18-B N3 (inbox2, …138672): câu chat "Mình ăn nhiều rồi shop êy" không thành địa chỉ giỏ; SĐT + địa chỉ + tên → đơn sạch', async () => {
  const sim = new Sim({ psid: 'r18b-n3' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS_REMIND', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([VANG(3)], 4 * MIN) });
  await sim.send(inbox, 'Mình ăn nhiều rồi shop êy', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '3', Customer_Address: 'Mình ăn nhiều rồi shop êy' } });
  assert.doesNotMatch(String(inbox.pendingOrder?.address || ''), /ăn nhiều/u, JSON.stringify(inbox.pendingOrder));
  const turn = await sim.send(inbox, `12f đường 15 kp4 phường An khánh tphcm\n${PHONE}\nDũng`, { llm: noModel });
  assert.equal(turn.created.length, 1, said(turn));
  assert.doesNotMatch(turn.created[0].address, /ăn nhiều|Dũng/u, turn.created[0].address);
  assert.match(turn.created[0].address, /12f đường 15/u);
});

test('R18-B N3 (inbox2, …686900): "<sđt>\\n<địa chỉ>\\nM gửi nhé" → địa chỉ đơn không có "M gửi"', async () => {
  const sim = new Sim({ psid: 'r18b-n3b' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS_REMIND', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([VANG(1), { product: 'Granola Túi Nâu vị cacao 350g', code: 'GRA-NAU-Z350', quantity: 1 }], 5 * MIN) });
  const turn = await sim.send(inbox, `${PHONE}\n6/5 Vũ chí thắng( cổng trường mầm non Hoa Cúc) nghĩa xá, Lê chân, Hải phòng\nM gửi nhé`, { llm: noModel });
  assert.equal(turn.created.length, 1, said(turn));
  assert.doesNotMatch(turn.created[0].address, /M gửi/u, turn.created[0].address);
});

test('R18-B N5 (inbox3 #94, …1266888): "Chị quên.Phường Gia Viên Hải Phòng" ghép vào địa chỉ trường đã gửi, không thay', async () => {
  const sim = new Sim({ psid: 'r18b-n5a' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN,
    pendingOrder: basket([VANG(2)], 3 * MIN, { phone: PHONE, address: 'Trường MN sao sáng 4 phân hiệu 2( Trường MN 20/10 cũ)', addressAsks: 1 }) });
  const turn = await sim.send(inbox, 'Chị quên.Phường Gia Viên Hải Phòng', { llm: noModel });
  assert.equal(turn.created.length, 1, said(turn));
  assert.match(turn.created[0].address, /Trường MN sao sáng 4/u, turn.created[0].address);
  assert.doesNotMatch(turn.created[0].address, /quên/u);
});

test('R18-B N5 (inbox3 #67, …7118377): "ship ngày mai hoặc sáng thứ 2 nhận nhé, hàng mới" → ghi chú đơn, không nằm trong địa chỉ (qua 2 lượt)', async () => {
  const sim = new Sim({ psid: 'r18b-n5b' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS_REMIND', botLastReplyAt: Date.now() - 4 * MIN, pendingOrder: basket([XANH(2)], 10 * MIN) });
  const first = await sim.send(inbox, `Đc 169 đường 83 thạnh mỹ lợi tphcm, ship ngày mai hoặc sáng thứ 2 nhận nhé, hàng mới ,đt${PHONE}`, { llm: noModel });
  assert.equal(first.created.length, 0, said(first));
  const turn = await sim.send(inbox, 'Quận 2 cũ hiện nay là phường cát lái cũ là thạh mỹ lợi', { llm: noModel });
  assert.equal(turn.created.length, 1, said(turn));
  assert.doesNotMatch(turn.created[0].address, /ship|hàng mới/u, turn.created[0].address);
  assert.match(String(turn.created[0].deliveryNote || ''), /ship ngày mai/u, JSON.stringify(turn.created[0]));
  assert.match(String(turn.created[0].deliveryNote || ''), /hàng mới/u);
});

test('R18-B V12 (inbox3 #37, …3814895): sửa món đơn live → phiếu "đã sửa lại đơn" không lộ "(Live)" ở địa chỉ', async () => {
  const sim = new Sim({ psid: 'r18b-v12' });
  const address = '(Live) Toà nhà xổ số kiến thiết, số 2 đường CMT8, Phường Thới Bình, Quận Ninh Kiều, Cần Thơ';
  const inbox = sim.inbox({
    botLastTemplateId: 'ORDER_UPDATE', botLastReplyAt: Date.now() - MIN, labels: ['livestream'],
    customerOrders: [{ id: 'o-live', automatic: true, createdAt: Date.now() - 2 * MIN, phone: PHONE, address, total: 298000, status: 'Mới', liveOrder: true, products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }] }]
  });
  const turn = await sim.send(inbox, '1 túi xanh dương và 1 túi xanh lá cây ạ', { llm: { template_id: 'ORDER_UPDATE', Product_N1: 'Granola Tropical vị Cacao 300g', No_A: '1', Product_N2: 'Granola Túi Xanh 450g', No_B: '1', Phone_Number: PHONE, Customer_Address: '0' } });
  assert.match(said(turn), /Toà nhà xổ số kiến thiết/u, said(turn));
  assert.doesNotMatch(said(turn), /\(Live\)/u, said(turn));
});

test('R18-B (chủ shop 12/10): sửa đơn có "(Tặng BGD)" / "(Live)" đầu địa chỉ → đơn lưu GIỮ ghi chú ở đầu, tin gửi khách không lộ', async () => {
  for (const [psid, tag] of [['r18b-tag1', '(Tặng BGD)'], ['r18b-tag2', '(Live)']]) {
    const sim = new Sim({ psid });
    const address = `${tag} Tổ 9, Phường Quang Trung, Thành phố Thái Nguyên, Thái Nguyên`;
    const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - MIN,
      customerOrders: [{ id: `o-${psid}`, automatic: true, createdAt: Date.now() - 3 * MIN, phone: PHONE, address, total: 298000, status: 'Mới', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }] }] });
    const turn = await sim.send(inbox, 'Cho chị thành 3 túi xanh nhé', { llm: { template_id: 'ORDER_UPDATE', Product_N1: 'Granola Túi Xanh 450g', No_A: '3', Phone_Number: PHONE, Customer_Address: '0' } });
    const update = turn.created.find(item => item.update);
    assert.ok(update, said(turn));
    assert.ok(String(update.address).startsWith(tag), update.address);
    assert.match(update.address, /Tổ 9/u);
    assert.ok(!said(turn).includes(tag), said(turn));
    // Sửa địa chỉ (số nhà mới) vẫn giữ ghi chú đầu.
    inbox.customerOrders[0].address = address;
    const fix = await sim.send(inbox, 'Sửa giúp chị số nhà 15 Tổ 9 phường Quang Trung TP Thái Nguyên nhé', { llm: { template_id: 'ORDER_UPDATE', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: PHONE, Customer_Address: 'số nhà 15 Tổ 9, phường Quang Trung, TP Thái Nguyên' } });
    const fixed = fix.created.find(item => item.update);
    assert.ok(fixed, said(fix));
    assert.ok(String(fixed.address).startsWith(tag), fixed.address);
    assert.match(fixed.address, /15/u);
    assert.ok(!said(fix).includes(tag), said(fix));
  }
});
