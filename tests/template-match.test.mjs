import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { templateSignatures, matchTemplate } from '../app/processing/template-match.mjs';

const seed = JSON.parse(readFileSync(new URL('../app/chatbot-templates.seed.json', import.meta.url), 'utf8'));
const templates = Array.isArray(seed) ? Object.fromEntries(seed.map(item => [item.id, item.text])) : Object.fromEntries(Object.entries(seed).map(([id, value]) => [id, typeof value === 'string' ? value : value?.text]));
const signatures = templateSignatures(templates);

test('nhận diện mẫu: tin bot đã gửi khớp mẫu theo đầu câu (bỏ dấu, bỏ xưng hô); mẫu dựng riêng; câu nhân viên tự viết → rỗng', () => {
  assert.equal(matchTemplate('Dạ đơn từ 2 túi bên em miễn phí vận chuyển và áp giá combo ạ; đơn 1 túi phí ship là 25.000đ ạ.', signatures), 'FREESHIP_POLICY');
  assert.equal(matchTemplate('Dạ em gửi chị Bảng giá Granola Túi Xanh 450g để mình dễ tham khảo ạ:', signatures), 'PRICE_QUOTE');
  assert.equal(matchTemplate('Dạ, em xin phép xác nhận lại thông tin đặt hàng của mình nha:', signatures), 'ORDER_CONFIRMATION');
  assert.equal(matchTemplate('Dạ em cảm ơn chị rất nhiều ạ. Chúc mình một ngày mới…', signatures), 'THANK_YOU');
  assert.equal(matchTemplate('Dạ có ạ, túi xanh 450g nha chị, mai kho gửi liền', signatures), '');
  assert.equal(matchTemplate('', signatures), '');
});
