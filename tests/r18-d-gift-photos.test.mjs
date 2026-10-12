// Vòng 18 — gói D: khách xin xem quà → gửi ẢNH THẬT của quà (chủ shop gửi ảnh 12/10: bát gáo dừa, muỗng dừa, bộ bát + muỗng),
// không gửi ảnh túi (inbox3 V2). Quạt chưa có ảnh → trả lời bằng chữ + thẻ để bạn phụ trách gửi ảnh.
// Câu thật: #94 [10-10 20:00] "Cho chị xem quạ để chị chốt đơn" → ảnh Túi Xanh; #33 [10-11 14:47] "Tặng sp gì" + "Chụp c zem" → ảnh Túi Vàng.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sim, XANH, basket } from './helpers/r13-engine-sim.mjs';
import { brandImageFiles } from '../app/pancake.mjs';
import { giftPhotoKinds, GIFT_PHOTO_ROUTES } from '../app/gift-photos.mjs';

const MIN = 60 * 1000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const said = turn => turn.sent.map(item => item.text).join('\n');
const images = turn => turn.sent.flatMap(item => item.imageUrls || []).join(' ');
// Mô hình chọn PRODUCT_PHOTOS (ảnh túi) như máy chủ ghi (danh mục test không có ảnh nên dựng sẵn câu trả lời).
const bagPhotos = name => {
  const text = `Dạ em gửi chị hình ảnh ${name} nhà Giọt Nắng ạ 🌾`;
  const url = 'https://example.test/product-images/tui.jpg';
  return { templateId: 'PRODUCT_PHOTOS', messages: [text], images: [url], parts: [{ type: 'text', text }, { type: 'image', url }], handoff: false };
};

test('R18 D: ảnh quà phục vụ công khai ở /q/brand/gift-*.jpg (bảng brandImageFiles), tệp có trong assets/branding/gifts', () => {
  for (const route of Object.values(GIFT_PHOTO_ROUTES)) {
    assert.ok(brandImageFiles[route], route);
    assert.ok(existsSync(path.join(root, 'assets', 'branding', ...brandImageFiles[route].split('/'))), brandImageFiles[route]);
  }
  // Dòng cũ giữ nguyên.
  assert.equal(brandImageFiles['/q/brand/offer-card.png'], 'offers/the-uu-dai.png');
});

test('R18 D: nhận loại quà khách muốn xem', () => {
  assert.deepEqual(giftPhotoKinds('Cho chị xem quạ để chị chốt đơn'), ['quat']);
  assert.deepEqual(giftPhotoKinds('cho xem hình bát gáo dừa'), ['bat']);
  assert.deepEqual(giftPhotoKinds('Chụp c xem cái muỗng với'), ['muong']);
  assert.deepEqual(giftPhotoKinds('xem bộ bát muỗng dừa'), ['bo']);
  assert.deepEqual(giftPhotoKinds('Tặng sp gì\nChụp c zem'), ['bo']);
  assert.deepEqual(giftPhotoKinds('Tặng sp gì\nChụp c zem', { livestream: true }), ['quat', 'bo']);
  for (const text of ['cho chị xem bảng giá', 'anh xem giúp đơn', 'túi xanh có ngọt không', 'quà tặng là gì vậy']) assert.deepEqual(giftPhotoKinds(text), [], text);
});

test('R18 D inbox3 V2 (#33 "Tặng sp gì / Chụp c zem"): gửi ảnh bộ bát + muỗng, không gửi ảnh túi', async () => {
  const sim = new Sim({ psid: 'r18d-gift-bo' });
  const inbox = sim.inbox({});
  const turn = await sim.send(inbox, 'Tặng sp gì\nChụp c zem', { llm: bagPhotos('Granola Túi Vàng 350g') });
  assert.match(images(turn), /gift-bo-bat-muong-dua\.jpg/, JSON.stringify(turn.sent));
  assert.doesNotMatch(images(turn) + said(turn), /Túi Vàng|Túi Xanh/);
});

test('R18 D inbox3 V2 (#94 "Cho chị xem quạ để chị chốt đơn", đang giữ giỏ live 2 túi): Quạt chưa có ảnh → nói chữ + thẻ, kèm nhắc giỏ', async () => {
  const sim = new Sim({ psid: 'r18d-gift-quat' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 3 * MIN, pendingOrder: basket([XANH(2)], 3 * MIN, { livestream: true }) });
  const turn = await sim.send(inbox, 'Cho chị xem quạ để chị chốt đơn', { llm: bagPhotos('Granola Túi Xanh 450g') });
  assert.equal(images(turn), '', 'không gửi ảnh túi');
  assert.match(said(turn), /Quạt/);
  assert.match(said(turn), /bạn phụ trách gửi ảnh/);
  assert.match(said(turn), /đang giữ đơn 2 Granola Túi Xanh/);
  assert.ok(inbox.labels.includes('attention') || turn.saved.some(item => (item.state.addLabelEvents || []).length), JSON.stringify(turn.saved.map(item => item.state.addLabelEvents)));
});

test('R18 D: "cho xem hình bát gáo dừa" (khách thường, không giỏ) → ảnh bát gáo dừa', async () => {
  const sim = new Sim({ psid: 'r18d-gift-bat' });
  const inbox = sim.inbox({});
  const turn = await sim.send(inbox, 'cho xem hình bát gáo dừa', { llm: { template_id: 'GIFT_POLICY' } });
  assert.match(images(turn), /gift-bat-gao-dua\.jpg/, JSON.stringify(turn.sent));
  assert.match(said(turn), /Bát gáo dừa/);
});
