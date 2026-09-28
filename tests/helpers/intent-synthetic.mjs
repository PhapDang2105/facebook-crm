// Dataset tổng hợp nhỏ theo hợp đồng dữ liệu v2 cho test train-intent / replay-golden (không có chữ khách thật).
const PRICE = ['giá bao nhiêu', 'bao nhiêu tiền một túi', 'cho xin giá', 'giá sao shop', 'túi xanh giá nhiêu', 'xin bảng giá ạ', 'giá bn v', 'một túi bao nhiêu tiền'];
const FLAVOR = ['có vị gì', 'có mấy loại vậy', 'vị nào ngon', 'có những loại nào', 'mấy vị shop ơi', 'loại nào ít ngọt', 'có vị cacao không', 'mấy loại vậy ạ'];
const ADDRESS = ['<sdt> 12 nguyễn trãi phường 5 quận 3', 'ngô văn a <sdt> xã tân phú huyện củ chi', 'số 5 hẻm 20 phường 10 quận tân bình <sdt>', '<sdt> thôn 3 xã ea kar huyện ea kar', 'chung cư hà đô phường 12 quận 10 <sdt>', '45 đường lê lợi thị trấn củ chi <sdt>', 'ấp 4 xã bình mỹ <sdt>', '<sdt> khu phố 3 phường an phú'];
const PHONE_ONLY = ['<sdt>', 'sđt <sdt>', 'số em <sdt>', '<sdt> ạ', 'dt <sdt>', 'gọi số <sdt>', '<sdt> nha shop', 'sdt: <sdt>'];
const STATUS = ['đơn em tới đâu rồi', 'sao chưa nhận được hàng', 'bao giờ giao vậy', 'đơn mình đi chưa', 'kiểm tra đơn giúp em', 'hàng tới chưa shop', 'đã gửi hàng chưa', 'đơn của em sao rồi'];
const THANKS = ['cảm ơn shop', 'ok em cảm ơn', 'dạ cảm ơn nhiều', 'oke cảm ơn', 'thanks shop', 'cám ơn em nha', 'ok cảm ơn ạ', 'dạ em cảm ơn'];
const CANCEL = ['hủy đơn giúp em', 'em không lấy nữa', 'cho hủy đơn', 'thôi không mua nữa', 'hủy giúp mình', 'em muốn hủy', 'không lấy nữa nha', 'huỷ đơn dùm'];

const FILL = ['ạ', 'nha', 'shop ơi', 'em ơi', 'vậy', 'ha', '', ''];
const groups = [
  { label: 'PRICE_QUOTE', texts: PRICE, ctx: {} },
  { label: 'ASK_FLAVOR', texts: FLAVOR, ctx: {} },
  { label: 'ORDER_ADDRESS', texts: ADDRESS, ctx: { lastTemplate: 'ORDER_ADDRESS', lastWasOrderStep: true, hasBasket: true, prevBotAsks: 'phone_address', prevBot: 'cho em xin số điện thoại và địa chỉ', ruleTemplate: 'ORDER_ADDRESS' } },
  { label: 'ORDER_ADDRESS_PARTIAL', texts: PHONE_ONLY, ctx: { lastTemplate: 'ORDER_ADDRESS', lastWasOrderStep: true, hasBasket: true, prevBotAsks: 'phone_address', prevBot: 'cho em xin số điện thoại và địa chỉ' } },
  { label: 'ORDER_STATUS', texts: STATUS, ctx: { hasOrder: true, orderAgeMin: 1440 } },
  { label: 'THANK_YOU', texts: THANKS, ctx: {} },
  { label: 'ORDER_CANCELLED', texts: CANCEL, ctx: { hasOrder: true, orderAgeMin: 30 } }
];

/**
 * @param {number} perGroup số dòng mỗi nhãn
 * @returns {object[]} dòng JSONL theo hợp đồng v2, `at` tăng dần
 */
export function syntheticDataset(perGroup = 20) {
  const rows = [];
  let at = 1_700_000_000_000;
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < perGroup; i += 1) {
    for (const group of groups) {
      const base = group.texts[i % group.texts.length];
      const filler = FILL[Math.floor(random() * FILL.length)];
      const text = filler ? `${base} ${filler}` : base;
      const staff = i % 7 === 3;
      const weak = i % 5 === 4;
      at += 60_000;
      rows.push({
        id: `p:u${i}:${at}`, text, prevBot: group.ctx.prevBot || '', prevCustomer: '', label: group.label,
        labelSource: staff ? 'staff' : weak ? 'llm' : 'template', ...(weak ? { weak: true } : {}), ...(staff && i % 2 ? { corrected: true } : {}),
        source: 'inbox', lastTemplate: group.ctx.lastTemplate || '', lastWasOrderStep: Boolean(group.ctx.lastWasOrderStep), hasBasket: Boolean(group.ctx.hasBasket), basketItems: group.ctx.hasBasket ? ['2 túi xanh'] : [],
        hasOrder: Boolean(group.ctx.hasOrder), orderAgeMin: group.ctx.hasOrder ? group.ctx.orderAgeMin : null, livestream: false,
        prevBotAsks: group.ctx.prevBotAsks || '', phoneInText: /<sdt>/.test(text), addressInText: /phuong|quan|xa|huyen|thon|ap|hem|duong|khu pho|chung cu/.test(text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')), bagCount: 0,
        ruleTemplate: group.ctx.ruleTemplate && i % 2 ? group.ctx.ruleTemplate : '', at
      });
    }
  }
  // Vài dòng OTHER và một lớp quá nhỏ để kiểm tra bộ lọc lớp.
  for (const [k, text] of ['.', '…', 'ừ'].entries()) rows.push({ id: `p:o${k}:${at + k + 1}`, text, label: 'OTHER', labelSource: 'template', source: 'inbox', lastTemplate: '', at: at + k + 1 });
  rows.push({ id: `p:t:${at + 10}`, text: 'xuất hóa đơn vat được không', label: 'VAT_INVOICE', labelSource: 'template', source: 'inbox', lastTemplate: '', at: at + 10 });
  rows.push({ id: `p:t:${at + 11}`, text: 'có xuất vat không shop', label: 'VAT_INVOICE', labelSource: 'template', source: 'inbox', lastTemplate: '', at: at + 11 });
  return rows;
}

export const syntheticLabels = groups.map(group => group.label);
