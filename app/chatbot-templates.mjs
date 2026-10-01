import { describeGiftTable, priceBasket, quoteTiers, shippingFeeForKey } from './processing/pricing.mjs';
import { comboKey, findProductBySku, getCatalogProducts, getGifts, getShippingFee, giftsForKey, isFreeShippingGift, listCombos, matchProduct, matchStaffOnlyProduct, maxComboQuantity, normalizeText } from './processing/catalog.mjs';
import { PROMO_BOWL_GIFT } from './processing/trial-flow.mjs';
import { metaConfig } from './config.mjs';
import { orderKey as buildOrderKey, toPricedItems } from './processing/order-key.mjs';
import { isOrderStep, usablePendingOrder } from './processing/pending-order.mjs';
import { extractVietnamesePhone, toLocalPhone } from './processing/customer-info.mjs';
import { describeDeliveryAddress, mergeAddressFragment } from './processing/locations.mjs';
import { cleanAddressText, extractDeliveryNote, isPaymentMessage, mentionsOldAddress } from './processing/order-flow.mjs';
import { countBags, normalizeIntentText } from './processing/intent-features.mjs';

// The bot asks for a missing or ambiguous part of the address at most this
// many times, then lets the order through with what it has (flagged on the
// order) rather than trapping the customer in a loop.
// Vòng 12: hỏi lại tối đa MỘT lần; khách trả lời gì thì nhận nguyên chữ khách ghi, đơn mang ghi chú
// để nhân viên soát phường/xã (khách bỏ đi khi bị hỏi từng cấp lần 2, lần 3).
export const maxAddressAsks = 1;
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every reply text lives in Thiết lập tin nhắn (chatbot settings →
// messageTemplates): one editable template per reply. This module only
// chooses which template answers and fills it from the catalogue, so a
// figure is never typed into a message. Template syntax, kept deliberately
// small:
//   {name}                 a value (price, product name, ...)
//   [?name]...[/?]         kept only when {name} has a value
//   [[list]]...[[/list]]   repeated once per item, each on its own line
//   ###                    starts the next message (up to three)
//   ![tên](https://...)    a picture, sent after the text
// A line whose values all came back empty is dropped, and a bare divider
// line left dangling by that is dropped with it — so a product with no combo
// price simply loses its combo rungs. app/chatbot-templates.seed.json holds
// the shipped texts; a shipped id the settings lack is read from there.
const seedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chatbot-templates.seed.json');

/** The shipped default texts — used only to seed settings that have none. */
export function defaultMessageTemplates() {
  return JSON.parse(readFileSync(seedPath, 'utf8'));
}

const isDivider = line => line.trim() !== '' && line.trim() !== '###' && !/[\p{L}\p{N}]/u.test(line);

/** Fills one template: lists, conditionals, placeholders, then line clean-up. */
/** {Dạ|Hi|Chào} — one option chosen at random, so repeated replies differ. */
export function spin(text, random = Math.random) {
  return String(text ?? '').replace(/\{([^{}]*\|[^{}]*)\}/g, (_, options) => {
    const choices = options.split('|');
    return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
  });
}

function fill(text, values = {}, lists = {}) {
  let out = spin(String(text ?? '').replace(/\\n/g, '\n'), activeCustomer.random || Math.random);
  // [[list]]body[[|]]separator[[/list]] — the separator goes between items only.
  out = out.replace(/\[\[([a-z_]+)\]\]([\s\S]*?)\[\[\/\1\]\]/gi, (_, name, body) => {
    const [itemBody, separator = ''] = body.split('[[|]]');
    return (lists[name] || []).map(item => fill(itemBody.replace(/^\n|\n$/g, ''), { ...values, ...item })).join(`\n${separator.replace(/^\n|\n$/g, '')}\n`.replace(/^\n\n$/, '\n'));
  });
  out = out.replace(/\[\?([a-z_0-9]+)\]([\s\S]*?)\[\/\?\]/gi, (_, key, body) => (values[key] ? body : ''));
  // A message break sits on its own line while lines are judged, so an empty
  // {image} at the end of a line never takes the text before it down too.
  const lines = out.replace(/###/g, '\n###\n').split('\n').map(line => {
    let missing = false;
    let used = false;
    const filled = line.replace(/\{([a-z_0-9]+)\}/gi, (_, key) => {
      used = true;
      const value = values[key];
      if (value === undefined || value === null || value === '') missing = true;
      return value ?? '';
    });
    return { text: filled, drop: used && missing };
  }).filter(line => !line.drop).map(line => line.text);
  // Two dividers in a row, a divider before a blank line, or one at the very
  // end only happen when the lines they framed were dropped.
  const cleaned = [];
  lines.forEach((line, index) => {
    if (isDivider(line) && (!cleaned.length || isDivider(cleaned.at(-1)) || !(lines[index + 1] ?? '').trim())) return;
    cleaned.push(line);
  });
  while (cleaned.length && isDivider(cleaned.at(-1))) cleaned.pop();
  return cleaned.join('\n').replace(/\n?###\n?/g, '###').replace(/[ \t]+$/gm, '').replace(/ {2,}/g, ' ').replace(/\(\s*[,.;:\s]*\)/g, '').trim();
}

const imagePattern = /!\s*\[[^\]]*\]\s*\(\s*(https?:\/\/[^\s)]+)[^)]*\)/g;

/**
 * Splits one filled template into up to three messages ("###" separates
 * them). An image written Markdown-style — ![tên](https://…) — is lifted out
 * and sent as a picture after the text, so a template can carry a product
 * photo.
 */
// "anh/ chị" written out in a template (or by the model) becomes the one
// form that fits once the customer's gender is known; the neutral pair stays
// only while it is not.
const literalHonorific = /(?<![\p{L}\p{N}])(anh)\s*\/\s*(chị)(?![\p{L}\p{N}])/giu;
export function applyHonorific(text, gender = activeCustomer.gender) {
  if (gender !== 'male' && gender !== 'female') return text;
  const title = honorific(gender);
  return String(text ?? '').replace(literalHonorific, match => (match.charAt(0) === 'A' ? title.charAt(0).toUpperCase() + title.slice(1) : title));
}

// Thứ tự gửi giữ đúng như trong mẫu: đoạn mở đầu bằng ảnh ({images}###Dạ…)
// thì ảnh đi trước chữ, ảnh đứng sau chữ thì gửi sau. `parts` là dãy gửi;
// `messages`/`images` giữ cho chỗ nào chỉ cần chữ (trả lời riêng bình luận…).
const maximumImagesPerReply = 6;
export function splitMessages(text) {
  const parts = [];
  for (const segment of applyHonorific(String(text ?? '')).split('###')) {
    const found = [];
    const content = segment.replace(imagePattern, (_match, url) => { found.push(url.trim()); return ''; }).trim();
    const imagesFirst = found.length > 0 && segment.search(imagePattern) === segment.search(/\S/);
    const imageParts = found.map(url => ({ type: 'image', url }));
    const textParts = content ? [{ type: 'text', text: content }] : [];
    parts.push(...(imagesFirst ? [...imageParts, ...textParts] : [...textParts, ...imageParts]));
  }
  let texts = 0;
  let pictures = 0;
  const kept = parts.filter(part => (part.type === 'text' ? ++texts <= 3 : ++pictures <= maximumImagesPerReply));
  return {
    messages: kept.filter(part => part.type === 'text').map(part => part.text),
    images: kept.filter(part => part.type === 'image').map(part => part.url),
    parts: kept
  };
}

/** Ảnh của một sản phẩm: thư viện gửi khách cộng ảnh chính, không trùng. */
function galleryOf(product) {
  return [...new Set([...(product?.images || []), product?.image].map(publicImageUrl).filter(Boolean))];
}

/** Rút `count` ảnh ngẫu nhiên từ một danh sách, không lặp. */
function sampleImages(pool, count, random) {
  const items = [...pool];
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [items[index], items[swap]] = [items[swap], items[index]];
  }
  return items.slice(0, count);
}

/**
 * Ảnh gửi kèm một lần tư vấn: 2 hoặc 3 ảnh ngẫu nhiên trong thư viện (ít hơn
 * thì gửi hết), viết dạng ![tên](url) để splitMessages tách thành tin ảnh.
 */
export function pickGalleryImages(product, random = activeCustomer.random || Math.random) {
  const pool = galleryOf(product);
  const count = pool.length >= 3 ? 2 + Math.floor(random() * 2) : pool.length;
  return sampleImages(pool, count, random).map(url => `![${product.name}](${url})`).join(' ');
}

/** 2–3 ảnh ngẫu nhiên trong thư viện của mọi sản phẩm đang bán (khi khách chưa nêu loại). */
function pickCatalogImages(random = activeCustomer.random || Math.random) {
  // Bảng giá chung nói về các túi chính (sản phẩm ghép combo được: Xanh, Vàng,
  // Nâu): ảnh đi kèm là ảnh đại diện của đúng các túi đó, không lấy ngẫu nhiên
  // trong thư viện mọi sản phẩm (từng gửi hũ Siêu hạt trong khi chữ nói 3 vị).
  const main = getCatalogProducts().filter(product => product.active && product.mixable && product.image).map(product => `![${product.name}](${publicImageUrl(product.image)})`);
  if (main.length) return main.slice(0, 3).join(' ');
  const pool = getCatalogProducts().filter(product => product.active).flatMap(product => galleryOf(product).map(url => `![${product.name}](${url})`));
  const count = pool.length >= 3 ? 2 + Math.floor(random() * 2) : pool.length;
  return sampleImages(pool, count, random).join(' ');
}

/** Absolute URL for a picture the catalogue stores, so Messenger can fetch it. */
export function publicImageUrl(image) {
  const value = String(image || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  // Version query: Messenger caches a failed fetch per URL, so a picture that
  // was once unreachable would otherwise stay blank.
  return `${metaConfig.publicBaseUrl}${value.startsWith('/') ? '' : '/'}${value}?v=${Date.now()}`;
}

function formatMoney(value) {
  return `${Math.max(0, Math.round(Number(value) || 0)).toLocaleString('vi-VN')}đ`;
}

function formatWeight(grams) {
  if (!(grams > 0)) return '';
  return grams >= 1000 ? `${Math.round(grams / 10) / 100}kg` : `${grams}g`;
}

// The customer the reply is for, set by renderChatbotReply for the duration
// of one render so every template can address them correctly.
let activeCustomer = {};
// Khách livestream của lượt đang dựng (context.livestream): giỏ/quà/bảng giá kèm
// quà chỉ khách live (Quà Tặng LIVE); khách thường không thấy quà đó.
let activeLivestream = false;
const giftContext = () => ({ livestream: activeLivestream });
// Đơn gần nhất của khách trong hội thoại, để trả lời "đơn của em tới đâu rồi".
let activeRecentOrder = null;

/** anh / chị from the Messenger profile; the neutral form when unknown. */
export function honorific(gender) {
  return gender === 'male' ? 'anh' : gender === 'female' ? 'chị' : 'anh/chị';
}

/** Placeholders every template may use: {title} / {Title}, {name} and {shipping_fee}. */
function commonValues() {
  const title = honorific(activeCustomer.gender);
  return { shipping_fee: formatMoney(getShippingFee()), title, Title: title.charAt(0).toUpperCase() + title.slice(1), name: String(activeCustomer.name || '').trim() };
}

/**
 * One of a template's ### variants at random — for the public comment reply,
 * where Facebook treats the same sentence posted under every comment as spam.
 */
export function pickVariant(reply, random = Math.random) {
  const messages = reply?.messages || [];
  if (messages.length < 2) return messages;
  return [messages[Math.min(messages.length - 1, Math.floor(random() * messages.length))]];
}

/** Shipping and gifts of one basket key as template values. */
function basketValues(key) {
  const gifts = giftsForKey(key, giftContext());
  const free = gifts.find(isFreeShippingGift);
  const shipFee = free ? 0 : shippingFeeForKey(key, giftContext());
  return {
    free_ship: free ? free.name : '',
    ship_fee: shipFee ? formatMoney(shipFee) : '',
    gift: gifts.filter(gift => !isFreeShippingGift(gift)).map(gift => gift.name).join(' + ')
  };
}

// Khách vừa chốt một đơn rồi mua tiếp ("lấy thêm 2 túi vàng"): mô hình hay
// gộp cả sản phẩm của đơn đã chốt vào giỏ mới, giỏ thành tổ hợp không có giá
// và bot chuyển nhân viên. Trong hai giờ sau đơn gần nhất, món trùng đơn đó
// bị bỏ khi khách có nêu món mới; chỉ toàn món cũ thì giữ (khách nhắc lại).
const recentOrderWindowMs = 2 * 60 * 60 * 1000;
// Đơn vừa chốt trong khoảng này còn sửa được ngay trong hội thoại (ORDER_UPDATE).
export const orderUpdateWindowMs = 60 * 60 * 1000;
// Đơn còn ghi chú / ghép đơn / đổi quà qua bot trong khoảng này (chưa giao). Hủy đơn: bot chỉ tự hủy trong
// orderUpdateWindowMs (60 phút, C4 01/10), quá hạn thì ghi nhận cho nhân viên (orderCancelStaffWindowMs).
export const orderCancelWindowMs = 24 * 60 * 60 * 1000;
// Khách xin hủy đơn đã quá 60 phút mà đơn còn trong khoảng này (như luật ORDER_CANCEL_STAFF: đơn ≤ 7 ngày):
// ORDER_CANCEL_STAFF (ghi chú vào đơn + thẻ). Cũ hơn nữa thì CSKH_HANDOFF.
const orderCancelStaffWindowMs = 7 * 24 * 60 * 60 * 1000;
// Khách xin đổi đơn đã quá hạn bot tự sửa (orderUpdateWindowMs) nhưng đơn còn mới trong khoảng
// này: bot ghi yêu cầu vào đơn và báo nhân viên, không coi là đơn mới (hỏi lại SĐT/địa chỉ).
const orderChangeStaffWindowMs = 3 * 24 * 60 * 60 * 1000;

// Lời xin đổi quà tặng (đã bỏ dấu): "đổi quà khác", "thay quà", "không lấy bát", "gáo dừa có rồi".
// "đổi qua túi vàng" (bỏ dấu trùng "đổi quà") là đổi sản phẩm: chữ ngay sau "qua" phải không phải loại túi.
const giftSwapPattern = /\b(qua (gi|j|nao|khac) (de )?thay|thay cho (bo |cai )?(bat|chen|gao dua|muong)|(doi|thay|chon|lay) (phan )?qua(?! (tui|goi|hop|bich|xanh|vang|nau|loai|vi|cacao|\d))|qua (tang )?khac|tang (c|chi|e|em|a|anh|minh)? ?(cai|mon|thu)? ?khac|(khong|ko|k|hong|kg) (lay|can|muon|thich) (bo |cai )?(bat|chen|gao dua|muong|qua)|(bat|chen|gao dua|muong dua)( [a-z]+){0,4} (co roi|du roi|nhieu roi|dung roi))\b/;
export function isGiftSwapRequest(text) {
  return giftSwapPattern.test(normalizeText(String(text || '')));
}

// Khách nói rõ muốn đổi đơn đã đặt (đã bỏ dấu): "đổi lại 1 xanh 1 vàng", "đặt nhầm, sửa đơn",
// "chuyển sang túi nâu", "thay bằng 2 túi vàng".
const orderChangePattern = /\b(doi (lai|sang|thanh|vi|loai|mau|tui|goi|san pham|sp|cho)|doi qua (tui|goi|hop|bich|xanh|vang|nau|loai|vi|cacao|\d)|doi \d|thay (bang|thanh|vao)|chuyen (sang|qua|thanh)|sua (lai )?(don|gio)|sua giup|dat nham|chon nham|bam nham|dat lon|nham (vi|loai|mau|tui|goi))\b/;
function dropRecentlyOrdered(items, recentOrder, now) {
  const at = Number(recentOrder?.createdAt) || 0;
  // Đơn đã hủy không "giữ" món nào: khách hủy 1 Xanh rồi đặt "1 xanh 1 vàng" phải ra đủ hai túi.
  const cancelled = String(recentOrder?.processingStatus || '') === 'cancelled' || recentOrder?.status === 'Hủy';
  if (!at || cancelled || now - at > recentOrderWindowMs) return items;
  const ordered = new Set((recentOrder.products || []).map(item => String(item.sku || item.code || '')).filter(Boolean));
  if (!ordered.size) return items;
  const additions = items.filter(item => !ordered.has(item.code));
  return additions.length && additions.length < items.length ? additions : items;
}

// Khách nhắn lại đúng giỏ vừa chốt ("lên đơn sớm nhé", gửi ảnh túi, hỏi "1 xanh
// 1 nâu thì sao"): mô hình vẫn chọn ORDER_UPDATE và bot báo "đã sửa lại đơn",
// gắn thẻ Đổi sản phẩm dù không có gì đổi. Cùng sản phẩm, cùng số lượng, cùng
// SĐT và địa chỉ (bỏ qua chữ thừa như "ấp") thì không phải sửa đơn.
function basketSignature(items) {
  return (Array.isArray(items) ? items : [])
    .map(item => `${String(item.sku || item.code || item.name || item.product || '').trim().toUpperCase()}x${Number(item.quantity) || 1}`)
    .sort()
    .join('+');
}
function sameAddressText(left, right) {
  const words = value => new Set(normalizeText(value).split(/[^a-z0-9]+/).filter(Boolean));
  const a = words(left);
  const b = words(right);
  if (!a.size || !b.size) return a.size === b.size;
  const within = (x, y) => [...x].every(word => y.has(word));
  return within(a, b) || within(b, a);
}
function unchangedOrder(recentOrder, orderItems, phone, address) {
  if (!recentOrder || basketSignature(recentOrder.products) !== basketSignature(orderItems)) return false;
  const phoneOf = value => toLocalPhone(value) || String(value || '').replace(/\D/g, '');
  return phoneOf(recentOrder.phone) === phoneOf(phone) && sameAddressText(recentOrder.address, address);
}

// Họ phổ biến: đầu địa chỉ là "Họ + tên" (2–4 chữ) rồi tới thôn/ấp/số nhà… là tên
// người nhận khách ghi kèm. Phải có phần đường/thôn đứng ngay sau, để tên đường
// như "Nguyễn Trãi, P.5" không bị cắt nhầm.
const surnames = 'nguyễn|trần|lê|phạm|hoàng|huỳnh|phan|vũ|võ|đặng|bùi|đỗ|hồ|ngô|dương|lý|chu|đinh|mai|trương|lương|lâm|tạ|đào|cao|hà|tô|trịnh|đoàn|lưu|châu|quách|kiều|thái|la|văn|triệu|tăng|từ|hứa';
// Tên đường cũng mang họ người ("Nguyễn Văn Linh số 12", "Trần Phú, khu 4",
// "Hoàng Diệu tổ 3"), tên tỉnh cũng vậy ("Hà Nội, số 5…"): chỉ cắt khi chắc là
// tên người — có tên đệm thị/văn, hoặc ngay sau là thôn/ấp/xóm/bản/làng (nông
// thôn không có tên đường) — và không bao giờ cắt khi sau đó là số/tổ/khu/đường.
const ruralStart = '(?:thôn|ấp|xóm|bản|làng)(?![\\p{L}])';
// Chữ của tên không được là từ chỉ địa điểm (thôn/ấp/số/tổ…), không thì "Nguyễn
// thị hằng Thôn 4" bị đọc thành tên "… hằng Thôn".
const nameWord = '(?!(?:thôn|ấp|xóm|bản|làng|số|tổ|khu|đường)(?![\\p{L}]))[\\p{L}]+';
const receiverNamePattern = new RegExp(`^((?:${surnames})(?:\\s+${nameWord}){1,3})(?:\\s*[,.\\-–:]\\s*|\\s+)(?=${ruralStart}|\\d)`, 'iu');
// Vòng 12: tên có tên đệm Thị/Văn ("Nguyễn Thị Hiền trường mn Phìn Hồ…", "Nguyễn thị hương, sn 79b…")
// rồi tới một từ chỉ nơi chốn (trường/nhà/số/sn/tổ/khu/đường/ngõ/chợ/công ty/UBND…) là tên người nhận.
const placeStart = '(?:trường|truong|nhà|số|sn|tổ|khu|kp|đường|ngõ|ngách|hẻm|kiệt|chợ|cty|công\\s+ty|ubnd|bệnh\\s+viện|tạp\\s+hóa|tạp\\s+hoá|cửa\\s+hàng|chung\\s+cư|cc|thôn|ấp|xóm|bản|làng)(?![\\p{L}])';
// Tên đúng ba chữ (họ + Thị/Văn + tên): "Nguyễn Thị Minh Khai", "Nguyễn Văn Linh số 12" là tên đường. Trước
// "số/sn/nhà" phải có dấu ngăn ("Nguyễn thị hương, sn 79b").
const placeWord = '(?:trường|truong|tổ|khu|kp|đường|ngõ|ngách|hẻm|kiệt|chợ|cty|công\\s+ty|ubnd|bệnh\\s+viện|tạp\\s+hóa|tạp\\s+hoá|cửa\\s+hàng|chung\\s+cư|cc|thôn|ấp|xóm|bản|làng)(?![\\p{L}])';
const middleNamePattern = new RegExp(`^((?:${surnames})\\s+(?:thị|thi|văn)\\s+(?!${placeStart})[\\p{L}]+)(?:\\s*[,.\\-–:]\\s*(?=${placeStart})|\\s+(?=${placeWord}))`, 'iu');
export function stripReceiverName(address) {
  const text = String(address || '');
  const middle = text.match(middleNamePattern);
  if (middle && !/(?<![\p{L}])(phường|xã|quận|huyện|tỉnh|thành phố|thị trấn)(?![\p{L}])/iu.test(middle[1]) && text.slice(middle[0].length).trim()) return text.slice(middle[0].length).trim();
  const match = text.match(receiverNamePattern);
  if (!match || /(?<![\p{L}])(phường|xã|quận|huyện|tỉnh|thành phố|thị trấn|thôn|ấp|số|đường)(?![\p{L}])/iu.test(match[1])) return text;
  const words = match[1].trim().split(/\s+/);
  const middleName = /^(thị|văn)$/iu.test(words[1] || '');
  const rest = text.slice(match[0].length);
  // Trước số nhà: chỉ cắt khi có tên đệm (Nguyễn Thị Hồng, 12 Lê Lợi) và có dấu ngăn.
  if (/^\d/.test(rest) && !(middleName && /[,.\-–:]\s*$/.test(match[0]))) return text;
  if (!/^\d/.test(rest) && words.length < 3 && !middleName) return text;
  return rest.trim();
}

/** Bộ giá đã bỏ phí ship theo ưu đãi dùng thử (quà "Miễn phí vận chuyển" đứng đầu danh sách quà). */
/** Ưu đãi bám đuổi combo 2: thêm bộ bát gáo dừa vào quà của giỏ 2 túi lớn (miễn ship đã có theo bảng quà). */
function withPromoBowl(price) {
  if (price.gifts.some(gift => /g[aá]o d[uừ]a/i.test(String(gift.name || '')))) return price;
  const gifts = [...price.gifts, { ...PROMO_BOWL_GIFT }];
  return { ...price, gifts, gift: gifts.map(gift => gift.name).join(' + ') };
}

function withPromoFreeShipping(price) {
  const gifts = [{ name: 'Miễn phí vận chuyển – ưu đãi dùng thử', sku: '', minQuantity: 1, active: true }, ...price.gifts.filter(gift => !isFreeShippingGift(gift))];
  return { ...price, total: price.total - price.shippingFee, shippingFee: 0, gifts, gift: gifts.map(gift => gift.name).join(' + ') };
}

/** Lời gợi ý 2 túi cho giỏ 1 túi: số liệu lấy từ bộ giá, không tự ghi. */
function upsellTwoBags(price, templates) {
  const line = price.lines?.[0];
  if (!line) return '';
  const two = priceBasket([{ sku: line.sku, quantity: 2 }], giftContext());
  if (!two.priceable || !two.lines?.[0]) return '';
  const saving = Math.max(0, (Number(line.unitPrice) || 0) - (Number(two.lines[0].basketUnitPrice) || 0));
  return fill(templates.UPSELL_TWO_BAGS, {
    ...commonValues(),
    product: line.name,
    // "2 hộp/combo" cho Combo 10 gói, không phải "2 túi".
    unit: String(matchProduct(line.name)?.unit || 'túi').toLowerCase(),
    two_unit: formatMoney(two.lines[0].basketUnitPrice),
    saving: saving ? formatMoney(saving) : '',
    two_total: formatMoney(two.total),
    one_total: formatMoney(price.total),
    free_ship: two.shippingFee === 0 ? 'miễn phí vận chuyển' : '',
    // Miễn ship đã ghi ở {free_ship}; {gift} chỉ còn quà thật, không lặp lại.
    gift: (two.gifts || []).filter(gift => !isFreeShippingGift(gift)).map(gift => gift.name).join(' + ')
  });
}

// ===== Vòng 12: số lượng theo đúng lời khách =====

const NUMBER_WORD = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6 };
const COLOUR_OF_WORD = { xanh: 'XANH', vang: 'VANG', nau: 'NAU', cacao: 'NAU' };
// "xanh mint/nhạt/biển/ngọc/dương/da trời/bạc hà" là Granola Tropical, không phải Túi Xanh.
const NOT_GREEN = '(?!\\s+(?:mint|min|nhat|bien|ngoc|duong|da troi|bac ha|la ma))';
const colourOfItem = item => (String(item?.code || item?.sku || '').toUpperCase().match(/^GRA-(XANH|VANG|NAU)-/) || [])[1] || '';
const numberOf = word => NUMBER_WORD[word] ?? (Number(word) || 0);
// Có nhắc tới hàng/giỏ không (màu, số túi, tên sản phẩm).
const BASKET_WORDS = /\b(tui|tuy|goi|bich|bit|hop|combo|xanh|vang|nau|cacao|mint|tropical|granola|yen mach|vi|loai|mau|\d{1,2} ?(t|b))\b/;
const ORDER_VERBS = /\b(lay|dat|mua|chot|gui|ship|cho|order|len don|an)\b/;
const QUESTION = /\?|\b(nao|gi|j|sao|khong|ko|hong|hok|k|chua|ha|hem)\s*(vay|v|z|ta|nhi|the|a|ha|shop|em|e|c|chi|ad)?\s*$|\b(loai nao|vi nao|mau nao|tui nao|cai nao|la gi|nhu nao|the nao|ntn|bao nhieu|bn)\b/;

/** Màu khách nêu kèm số túi trong tin ("2 xanh", "1 túi vàng 1 túi nâu", "túi xanh x2", "mỗi loại 1 túi"). */
export function colourCountsInText(text) {
  const s = normalizeIntentText(text);
  const counts = {};
  const mentioned = new Set();
  // "1vang" (dính số) vẫn là nhắc vị Vàng.
  for (const match of s.matchAll(new RegExp(`(?<![a-z])(xanh|vang|nau|cacao)\\b${NOT_GREEN}`, 'g'))) mentioned.add(COLOUR_OF_WORD[match[1]]);
  for (const match of s.matchAll(new RegExp(`\\b(\\d{1,2}|mot|hai|ba|bon|nam|sau)\\s*(?:tui|tuy|goi|bich|bit|b|t)?\\s*(?:mau\\s+|vi\\s+)?(xanh|vang|nau|cacao)\\b${NOT_GREEN}`, 'g'))) {
    const colour = COLOUR_OF_WORD[match[2]];
    counts[colour] = (counts[colour] || 0) + numberOf(match[1]);
  }
  for (const match of s.matchAll(new RegExp(`\\b(?:tui|goi|bich)?\\s*(xanh|vang|nau|cacao)${NOT_GREEN}\\s*x\\s?(\\d{1,2})\\b`, 'g'))) {
    const colour = COLOUR_OF_WORD[match[1]];
    if (!counts[colour]) counts[colour] = Number(match[2]) || 0;
  }
  const each = s.match(/\bmoi (?:loai|vi|mau|thu|tui|goi) (\d{1,2}|mot|hai|ba)\b|\b(\d{1,2}|mot|hai|ba) (?:tui|goi|bich) moi (?:loai|vi|mau)\b/);
  if (each) for (const colour of mentioned) if (!counts[colour]) counts[colour] = numberOf(each[1] || each[2]);
  return { counts, mentioned: [...mentioned], each: Boolean(each) };
}

/**
 * Sửa số lượng mô hình trả về theo đúng lời khách (vòng 12, hội thoại thật):
 * - câu hỏi ("Loại nào có trái cây vậy") không có số/động từ đặt → không tạo/đổi giỏ ([]);
 * - tin không nhắc hàng ("Địa chỉ chưa sáp nhập") → giữ giỏ/đơn đang có, không đổi vị;
 * - "N + màu" = N túi màu đó ("2 xanh" ≠ 1 Vàng + 1 Xanh); "Vàng + xanh, mỗi loại 1 túi" = chỉ hai vị vừa nêu;
 * - "N túi" không màu mà giỏ đang giữ một màu → N túi màu đó ("thêm" thì cộng);
 * - chỉ nhắc vị, không số ("e túi xanh", "C ăn túi xanh nha") → giữ số lượng món cùng mã trong giỏ/đơn gần
 *   nhất, hoặc số túi khách đã nêu trước khi chọn vị (askedBagCount), không về 1.
 * @param {Array<{product:string, code:string, quantity:number, given?:boolean}>} items giỏ mô hình trả
 * @returns {Array<{product:string, code:string, quantity:number}>}
 */
export function adjustOrderQuantities(items, { messageText = '', heldItems = [], recentItems = [], askedBagCount = 0, adding = false, burstTexts = [] } = {}) {
  const text = String(messageText || '');
  const plain = list => list.map(({ product, code, quantity }) => ({ product, code, quantity }));
  if (!text.trim()) return plain(items);
  const s = normalizeIntentText(text);
  const bags = countBags(text);
  const { counts, mentioned, each } = colourCountsInText(text);
  const countGiven = bags > 0 || Object.keys(counts).length > 0 || each;
  const reference = heldItems.length ? heldItems : recentItems;
  if (QUESTION.test(s) && !countGiven && !ORDER_VERBS.test(s.replace(/\bcho (em|e|minh|chi|c|a|anh) hoi\b/g, ' '))) return reference.length ? plain(reference) : [];
  // Engine gộp cụm tin liền nhau cho mô hình nhưng messageText chỉ là tin cuối: tin ngay trước có nhắc
  // hàng ("2 túi xanh" rồi "đc …") thì giỏ mô hình đọc từ cả cụm là đúng — không khoá giỏ đang giữ.
  const burstNamesBasket = !recentItems.length && burstTexts.some(other => String(other || '') !== text && BASKET_WORDS.test(normalizeIntentText(other)));
  if (!BASKET_WORDS.test(s) && !countGiven) return !burstNamesBasket && reference.length ? plain(reference) : plain(items);
  let next = items.map(item => ({ ...item }));
  const allColour = next.length > 0 && next.every(item => colourOfItem(item));
  if (allColour && mentioned.length && !/\b(combo|hop|goi nho|yen mach|mix|cam)\b/.test(s)) {
    const kept = next.filter(item => mentioned.includes(colourOfItem(item)));
    if (kept.length) next = kept;
    for (const item of next) {
      const colour = colourOfItem(item);
      if (counts[colour]) item.quantity = counts[colour];
    }
  }
  // "N túi" không nêu màu, giỏ đang giữ một màu: N túi màu đó.
  const referenceCodes = [...new Set(reference.map(item => String(item.code || '').toUpperCase()).filter(Boolean))];
  if (bags > 0 && !mentioned.length && referenceCodes.length === 1 && colourOfItem(reference[0]) && (!next.length || next.every(item => colourOfItem(item)))
    && !/\b(combo|hop|goi nho|yen mach|mix|cam|mint|tropical)\b/.test(s)) {
    const base = reference[0];
    const held = reference.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
    return [{ product: base.product, code: base.code, quantity: adding ? held + bags : bags }];
  }
  if (!countGiven) {
    const quantityOf = (list, code) => list.find(item => String(item.code || '').toUpperCase() === String(code || '').toUpperCase())?.quantity || 0;
    for (const item of next) {
      if (item.given && item.quantity > 1) continue;
      const same = quantityOf(heldItems, item.code) || quantityOf(recentItems, item.code);
      if (same) item.quantity = same;
      else if (askedBagCount > 1 && next.length === 1) item.quantity = askedBagCount;
      else if (!adding && next.length === 1 && heldItems.length === 1 && colourOfItem(heldItems[0]) && colourOfItem(item)) item.quantity = Number(heldItems[0].quantity) || item.quantity;
    }
  }
  return plain(next);
}

/**
 * Số lượng mô hình ghi ở No_A/B/C. Số thập phân ("1.5", "2,5") lấy phần nguyên — trước đây ghép mọi chữ số nên
 * "1.5" thành 15 túi (T6, 01/10). Dạng khác giữ như cũ (ghép chữ số: "2+1" → 21 > trần giỏ → nhân viên tính).
 */
function modelQuantity(raw) {
  const text = String(raw ?? '');
  const decimal = text.match(/^\D*?(\d+)[.,]\d{1,2}(?!\d)\D*$/);
  if (decimal) return Number(decimal[1]) || 0;
  return Number(text.replace(/\D/g, '')) || 0;
}

/** Món đầu tiên trong giỏ là sản phẩm chỉ CSKH bán: { name } hay null. Sản phẩm danh mục theo cờ staffOnly; tên ngoài danh mục theo STAFF_ONLY_PRODUCTS. */
function staffOnlyItemOf(items) {
  for (const item of Array.isArray(items) ? items : []) {
    const product = (item?.code && findProductBySku(item.code)) || matchProduct(String(item?.product || ''));
    if (product?.staffOnly) return { name: product.name };
    const named = !product ? matchStaffOnlyProduct(String(item?.product || '')) : null;
    if (named) return { name: named.name };
  }
  return null;
}

function renderOrder(value, templates, context = {}) {
  const now = Number(context.now) || Date.now();
  const templateId = String(value.template_id || '').trim();
  const products = [value.Product_N1, value.Product_N2, value.Product_N3];
  const quantities = [value.No_A, value.No_B, value.No_C];
  // Khách sửa đơn vừa chốt ("ko phải", "3 gói 3 vị khác nhau"): giỏ mới thay
  // cho giỏ cũ của đúng đơn đó, không tạo đơn thứ hai, không bỏ món "đã đặt".
  const recentOrder = context.recentOrder || null;
  const messageWords = normalizeText(String(context.messageText || ''));
  // Vòng 12: tin thanh toán ("gửi stk để mình ck… lên đơn 0đ") không bao giờ là sửa đơn.
  const paymentMessage = isPaymentMessage(context.messageText || '');
  // Khách nêu loại mà không nói số ("C đặt nhé" sau khi được báo giá): tính là 1 — trừ khi giỏ/đơn
  // gần nhất đã có món đó hay khách đã nêu số túi trước (adjustOrderQuantities, vòng 12).
  const rawNamed = toPricedItems(products.map((product, index) => ({
    product: String(product || '').trim(),
    quantity: modelQuantity(quantities[index]) || 1
  })).filter(item => item.product && item.product !== '0'))
    .map((item, index) => ({ ...item, given: /\d/.test(String(quantities[index] || '')) && modelQuantity(quantities[index]) > 1 }));
  const heldForQuantity = usablePendingOrder(context.pendingOrder, { now, templateId: 'ORDER_ADDRESS' })?.items || [];
  const recentForQuantity = recentOrder && !(String(recentOrder.processingStatus || '') === 'cancelled' || recentOrder.status === 'Hủy')
    && now - (Number(recentOrder.createdAt) || 0) < recentOrderWindowMs
    ? (recentOrder.products || []).map(item => ({ product: String(item.name || item.product || ''), code: String(item.sku || item.code || ''), quantity: Number(item.quantity) || 1 })).filter(item => item.product)
    : [];
  // Tin thanh toán sau khi chốt: đơn còn sửa được → nhắc lại đúng đơn (ORDER_UNCHANGED); đơn đã quá hạn sửa
  // → không nêu giỏ nào (không tạo đơn thứ hai trùng đơn vừa chốt).
  const paymentAfterOrder = paymentMessage && recentForQuantity.length > 0;
  const recentEditable = paymentAfterOrder && recentOrder.source !== 'POS' && recentOrder.automatic !== false
    && !/đã giao|đang giao|đã gửi/i.test(String(recentOrder.status || '')) && now - (Number(recentOrder.createdAt) || 0) < orderUpdateWindowMs;
  const namedItems = paymentAfterOrder
    ? (recentEditable ? recentForQuantity : [])
    : adjustOrderQuantities(rawNamed, {
      messageText: context.messageText,
      heldItems: heldForQuantity,
      recentItems: recentForQuantity,
      askedBagCount: Number(context.pendingOrder?.askedBagCount) || 0,
      burstTexts: Array.isArray(context.recentCustomerTexts) ? context.recentCustomerTexts.slice(-2) : [],
      adding: String(value.add_to_basket || '') === '1' || /\b(them|nua|cong them)\b/.test(messageWords)
    });
  // "Lấy thêm 1 túi vàng ghép đơn": bot chỉ tự gộp vào đơn cũ trong 60 phút như mọi lần sửa đơn
  // (chủ shop 01/10 — sau đó kho có thể đã đóng gói); quá hạn thì ghi chú + thẻ cho nhân viên
  // (ORDER_CHANGE_STAFF), không tạo đơn riêng tính thêm phí ship.
  const mergeRequest = /\b(ghep (don|chung|vao)|gop (don|chung|vao)|them vao don)\b/.test(messageWords);
  const shipped = /đã giao|đang giao|đã gửi/i.test(String(recentOrder?.status || ''));
  // Đơn nhân viên/Facebook Shop tạo trên POS (source 'POS'): bot không tự sửa — nhân viên lo.
  const recentOpen = Boolean(recentOrder?.id) && !shipped && recentOrder.source !== 'POS'
    && now - (Number(recentOrder.createdAt) || 0) < orderUpdateWindowMs
    && String(recentOrder.processingStatus || '') !== 'cancelled';
  // Mô hình vẫn chọn ORDER_CONFIRMATION/ORDER_ADDRESS khi khách sửa hay thêm vào
  // đơn bot vừa chốt (dưới 60 phút) → trước đây tạo đơn thứ hai, thứ ba. Nay: khách
  // nói rõ "đơn khác / người khác / địa chỉ khác" mới là đơn mới; "thêm / nữa /
  // gộp / ghép" là cộng vào đơn cũ; còn lại là sửa giỏ của đơn cũ.
  const separateOrder = /\b(don khac|don moi|nguoi khac|dia chi khac|gui cho (ban|me|chi|em|anh)|tach don)\b/.test(messageWords);
  // "luôn" KHÔNG phải cộng thêm: "gửi e 2 túi luôn c nha" (đơn 1 túi) là đổi thành 2 túi.
  const addsToOrder = /\b(them|nua|gop|ghep|cong them)\b/.test(messageWords);
  const implicitUpdate = !separateOrder && recentOpen && recentOrder.automatic !== false && namedItems.length > 0
    && ['ORDER_CONFIRMATION', 'ORDER_ADDRESS'].includes(templateId);
  // Tin thanh toán chỉ được nhắc lại đơn (namedItems = đúng đơn gần nhất → ORDER_UNCHANGED), không sửa.
  const updating = ((templateId === 'ORDER_UPDATE' && recentOpen) || implicitUpdate) && !(paymentMessage && !recentForQuantity.length);
  // Khách nói rõ muốn đổi đơn đã đặt mà bot không tự sửa được (quá 60 phút — kho có thể đã đóng
  // gói; đơn nhân viên/POS lên; đơn đang giao): trước đây rơi xuống nhánh đơn MỚI, bot hỏi lại
  // SĐT/địa chỉ và mời thêm túi. Nay: ghi giỏ khách muốn vào ghi chú đơn, gắn thẻ Đổi sản phẩm +
  // Cần người xử lý để nhân viên sửa. Đang giữ giỏ mới hơn đơn (khách đang đặt đơn khác) thì thôi.
  const heldNewer = Number(context.pendingOrder?.at) > (Number(recentOrder?.createdAt) || 0) && (context.pendingOrder?.items || []).length > 0;
  if (!updating && !separateOrder && namedItems.length && recentOrder?.id && templates.ORDER_CHANGE_STAFF
    && (mergeRequest || orderChangePattern.test(messageWords)) && !isGiftSwapRequest(context.messageText) && !heldNewer
    && String(recentOrder.processingStatus || '') !== 'cancelled' && recentOrder.status !== 'Hủy'
    && !/đã giao|giao thành công|hoàn thành/i.test(String(recentOrder.status || ''))
    && now - (Number(recentOrder.createdAt) || 0) < orderChangeStaffWindowMs) {
    const items = namedItems.map(item => `${item.quantity} ${matchProduct(item.product)?.name || item.product}`).join(" + ");
    // Ghép đơn quá 60 phút: món khách nêu là món THÊM, không phải cả đơn mới.
    const cart = mergeRequest ? `đơn đã đặt + ${items}` : items;
    return {
      templateId: 'ORDER_CHANGE_STAFF',
      ...splitMessages(fill(templates.ORDER_CHANGE_STAFF, { ...commonValues(), cart })),
      handoff: false,
      attention: true,
      orderChange: true,
      pendingOrder: null,
      order: { noteOrderId: String(recentOrder.id), note: mergeRequest ? `Khách xin ghép thêm vào đơn: ${items}` : `Khách xin đổi đơn thành: ${items}` }
    };
  }
  if (templateId === 'ORDER_UPDATE' && !updating && !namedItems.length && templates.ORDER_WRONG) {
    return { templateId: 'ORDER_WRONG', ...splitMessages(fill(templates.ORDER_WRONG, commonValues())), handoff: false };
  }
  // Cộng thêm vào đơn cũ: giỏ = món đã đặt + món vừa nêu (cùng món thì cộng số lượng).
  const mergedItems = () => {
    const byName = new Map();
    const add = (product, quantity) => { const key = normalizeText(product); const current = byName.get(key); byName.set(key, { product, quantity: (current?.quantity || 0) + quantity }); };
    for (const item of Array.isArray(recentOrder?.products) ? recentOrder.products : []) add(String(item.name || item.product || ''), Number(item.quantity) || 1);
    for (const item of namedItems) add(item.product, Number(item.quantity) || 1);
    return toPricedItems([...byName.values()].filter(item => item.product));
  };
  // Mô hình đã trả giỏ ĐẦY ĐỦ (gồm mọi món của đơn cũ, số lượng không ít hơn)
  // kèm chữ "thêm": không cộng lần nữa, không thì giỏ bị đếm hai lần.
  const coversOldOrder = () => {
    const named = new Map(namedItems.map(item => [String(item.code || '').toUpperCase(), Number(item.quantity) || 1]));
    const old = Array.isArray(recentOrder?.products) ? recentOrder.products : [];
    return old.length > 0 && old.every(item => (named.get(String(item.sku || item.code || '').toUpperCase()) || 0) >= (Number(item.quantity) || 1));
  };
  const baseItems = updating ? (implicitUpdate && addsToOrder && !coversOldOrder() ? mergedItems() : namedItems) : dropRecentlyOrdered(namedItems, recentOrder, now);
  if (updating && !baseItems.length && templates.ORDER_WRONG) {
    return { templateId: 'ORDER_WRONG', ...splitMessages(fill(templates.ORDER_WRONG, commonValues())), handoff: false };
  }
  const pending = usablePendingOrder(context.pendingOrder, { now, templateId });
  // Vòng 11 (P7): đang giữ giỏ (chưa có đơn để sửa) mà khách "lấy thêm 1 túi nâu": cộng món vừa nêu vào giỏ đang
  // giữ, không thay giỏ (giỏ 2 Xanh → 2 Xanh + 1 Nâu). Luật giỏ đánh dấu add_to_basket (món vừa nêu chắc chắn là
  // phần thêm); mô hình thì chỉ cộng khi tin có "thêm/nữa" và giỏ trả về chưa phủ giỏ đang giữ (mô hình đã trả giỏ
  // đầy đủ thì không cộng lần hai). "đổi/thay/chỉ lấy/bớt/không lấy" là giỏ mới.
  const heldItems = !updating && pending?.items?.length ? pending.items : [];
  const itemKey = item => String(item.code || '').toUpperCase() || normalizeText(item.product);
  const coversHeld = () => {
    const named = new Map(baseItems.map(item => [itemKey(item), Number(item.quantity) || 1]));
    return heldItems.every(item => (named.get(itemKey(item)) || 0) >= (Number(item.quantity) || 1));
  };
  const replacesHeld = /\b(doi|thay|chi (lay|can|mua)|bot|khong lay|ko lay|k lay)\b/.test(messageWords);
  const addsToHeld = heldItems.length > 0 && baseItems.length > 0 && isOrderStep(templateId) && !replacesHeld
    && (String(value.add_to_basket || '') === '1' || (/\b(them|nua|cong them)\b/.test(messageWords) && !coversHeld()));
  const mergeHeld = () => {
    const byKey = new Map();
    for (const item of [...heldItems, ...baseItems]) {
      const key = itemKey(item);
      const current = byKey.get(key);
      byKey.set(key, { product: current?.product || item.product, quantity: (current?.quantity || 0) + (Number(item.quantity) || 1) });
    }
    return toPricedItems([...byKey.values()]);
  };
  const freshItems = addsToHeld ? mergeHeld() : baseItems;

  // The price comes from the basket itself, never from a key the model
  // declared: an order_key the model invented used to price three bags as one.
  const freshKey = buildOrderKey(freshItems);
  const freshPrice = freshKey ? priceBasket(freshItems, giftContext()) : null;
  const trialBagItem = context.trial?.stage === 'chosen' && context.trial.bag && !freshItems.length && !pending?.items?.length ? [{ product: context.trial.bag, quantity: 1 }] : [];
  const items = freshItems.length ? freshItems : (pending?.items?.length ? pending.items : trialBagItem);
  const key = freshKey || pending?.key || '';
  // C3 (01/10): sản phẩm chỉ CSKH bán (staffOnly: Hạt An Lành hũ, Siêu Hạt…) — bot không lên đơn / không giữ giỏ,
  // kể cả khi mô hình tự nêu tên (lượt trước bot vừa nói tên sản phẩm). Chặn ở phía bot, không ở priceBasket
  // (đơn nhân viên/landing/POS vẫn tính giá được theo SKU).
  const staffOnlyItem = staffOnlyItemOf(items);
  if (staffOnlyItem && templates.STAFF_ONLY_PRODUCT) {
    const heldStaffOnly = Boolean(staffOnlyItemOf(pending?.items));
    return {
      templateId: 'STAFF_ONLY_PRODUCT',
      ...splitMessages(fill(templates.STAFF_ONLY_PRODUCT, { ...commonValues(), product: staffOnlyItem.name })),
      handoff: false,
      attention: true,
      // Giỏ đang giữ có món staffOnly thì bỏ; giỏ khác (hợp lệ) để nguyên.
      ...(heldStaffOnly ? { pendingOrder: null } : {})
    };
  }
  const priced = items.length ? priceBasket(items, giftContext()) : null;
  // Khách đã nhận ưu đãi miễn phí vận chuyển (tin bám đuổi "1 túi dùng thử vẫn
  // miễn ship", còn hạn): đơn không cộng phí ship, ghi rõ quà để kho và khách thấy.
  // Chỉ luồng dùng thử (processing/trial-flow.mjs) đặt context.trial; ưu đãi áp đúng
  // 1 túi. Khách tự xin nhiều túi là đơn thường (giá combo, vốn đã miễn ship).
  const trial = context.trial || null;
  // Ưu đãi chỉ cho 1 túi lớn Xanh / Vàng / Nâu (không cho combo gói nhỏ hay sản phẩm khác).
  const trialBag = items.length === 1 && /^GRA-(XANH|VANG|NAU)-/i.test(String(items[0]?.code || items[0]?.sku || priced?.lines?.[0]?.sku || ''));
  const trialPriced = Boolean(priced?.priceable && trial && trialBag && priced.totalQuantity === 1 && priced.shippingFee > 0);
  // Combo 2 túi lớn trong cửa sổ ưu đãi bám đuổi (context.promoBowl): tặng bộ bát gáo dừa.
  // Sửa đơn đã có quà bám đuổi (khách đổi vị, vẫn 2 túi): giữ quà; đổi số túi thì quà theo giỏ mới.
  const promoBowl = Boolean((context.promoBowl || (updating && recentOrder?.promoGift)) && priced?.priceable && priced.totalQuantity === 2 && (priced.lines || []).length && priced.lines.every(line => /^GRA-(XANH|VANG|NAU)-/i.test(String(line.sku || ''))));
  const price = trialPriced ? withPromoFreeShipping(priced) : promoBowl ? withPromoBowl(priced) : priced?.priceable ? priced : null;

  // Mô hình bỏ sót SĐT nằm chung dòng với tên/địa chỉ ("Vũ Thanh Hải - 09xx… 3a2/109 đường…"):
  // đọc thẳng từ tin khách vừa nhắn thay vì hỏi lại thứ khách đã đưa.
  const freshPhone = toLocalPhone(value.Phone_Number) || extractVietnamesePhone(value.Phone_Number) || extractVietnamesePhone(context.messageText || '')
    // SĐT khách gửi ở một tin riêng trước đó (hay tin bị mô hình bỏ qua): đọc lại, không hỏi nữa.
    || (Array.isArray(context.recentCustomerTexts) ? context.recentCustomerTexts.map(text => extractVietnamesePhone(text)).find(Boolean) || '' : '');
  // Khách quen "gửi về địa chỉ cũ / như lần trước": SĐT và địa chỉ lấy từ đơn
  // gần nhất của khách thay vì hỏi lại.
  // Cùng bộ từ với OLD_ADDRESS của order-flow.mjs ("như/giống lần/hôm trước", "chỗ cũ").
  // Cũng nhận "gởi địa chỉ củ", "dc cũ", "đc cũ", "gửi dc trước rồi", "như đơn trước", "đơn cũ / lần trước / hôm trước".
  // Vòng 11 (P8): "bữa trước ăn ngon, lấy thêm 2 túi xanh" từng bị hiểu là địa chỉ cũ (tự chốt về địa chỉ đơn trước).
  // Nay: bộ từ OLD_ADDRESS của order-flow.mjs, hoặc vế cũ nhưng chỉ khi tin có từ giao hàng/địa chỉ (gửi/ship/giao/về/đc).
  // Bỏ "cho cu" (trùng "gửi cho cụ").
  const previousWords = normalizeText(String(context.messageText || ''));
  const saysPrevious = mentionsOldAddress(context.messageText || '')
    || (/(dia chi|d\/c|dc|d c) (cu|truoc|nhu cu|lan truoc|hom truoc|do|day|kia|hom bua)|(dia chi|dc) (nhu|giong) (cu|truoc)|(nhu|giong|theo|y) (don |lan |hom |dot |bua |ky )?(truoc|cu)|nhu cu|(don|dot|ky|bua) (cu|truoc)\b|(gui|ship|giao) (dc|dia chi|d\/c) (truoc|cu) (roi|r|do|day)|(ve|toi|den) (dc|dia chi) (cu|truoc)/.test(previousWords)
      && /\b(gui|goi|ship|giao|ve|dia chi|dc|d c|d\/c|dchi)\b/.test(previousWords));
  // Vòng 12: bot vừa xin "SĐT đã đặt lần trước để lấy lại địa chỉ cũ" (ORDER_ADDRESS_OLD_ASK_PHONE) và khách
  // trả lời SĐT, hay khách đã nói "địa chỉ cũ / như mấy lần" ở tin đặt trước (giỏ nhớ wantsPrevious).
  const wantsPrevious = saysPrevious || context.lastTemplateId === 'ORDER_ADDRESS_OLD_ASK_PHONE' || Boolean(context.pendingOrder?.wantsPrevious);
  const previous = (wantsPrevious || updating) && context.recentOrder ? context.recentOrder : (wantsPrevious && context.previousDelivery ? context.previousDelivery : null);
  // Mô hình ghi "0" khi khách không đưa địa chỉ: coi như trống để lấy địa chỉ đơn trước.
  // Tên người nhận khách ghi đầu địa chỉ ("Nguyễn thị Hằng Thôn 4, …") không lên phiếu giao.
  // Vòng 12: lọc nhãn/chữ thừa ("shop.đc", "Linh:", "1 trước ạ.", "sdt", "nhé") trước khi lên phiếu.
  const typedAddress = String(value.Customer_Address || '').trim();
  const deliveryNote = typedAddress && typedAddress !== '0' ? extractDeliveryNote(typedAddress) : '';
  const givenAddress = typedAddress && typedAddress !== '0' ? stripReceiverName(cleanAddressText(typedAddress)) : typedAddress;
  const freshAddress = (givenAddress && givenAddress !== '0' ? givenAddress : '') || (previous?.address ? String(previous.address) : '');
  const phone = freshPhone || pending?.phone || (previous?.phone ? toLocalPhone(previous.phone) || String(previous.phone) : '');
  // A fragment the customer sends after being asked ("phường 5", "số 12 Lê
  // Lợi") is merged into the saved address; a whole new address replaces it.
  const address = mergeAddressFragment(freshAddress !== '0' ? freshAddress : '', pending?.address || '');
  const hasPhone = Boolean(phone);
  const hasAddress = Boolean(address);
  // The address is checked against the warehouse list: three levels plus a
  // street. What is missing or ambiguous is asked back, up to maxAddressAsks.
  const delivery = hasAddress ? describeDeliveryAddress(address) : null;
  const addressAsks = pending?.addressAsks || 0;
  // Đã hỏi một lần mà khách trả lời bằng một địa chỉ đầy đủ (có ghi phường/xã,
  // quận/huyện) nhưng máy vẫn không khớp được danh mục: không hỏi lại y câu cũ,
  // nhận địa chỉ khách ghi và để nhân viên đối chiếu ở Xử lý dữ liệu.
  // \b chỉ biết chữ ASCII nên "xã"/"thị xã" (kết thúc bằng chữ có dấu) không bao giờ khớp; dùng biên chữ Unicode.
  const answeredInFull = addressAsks >= 1 && /(?<![\p{L}\p{N}])(huyện|quận|thị xã|thành phố|tp|phường|xã|thị trấn|tt)(?![\p{L}\p{N}])/iu.test(freshAddress) && freshAddress.split(/[,\n]/).filter(part => part.trim()).length >= 2;
  // Tên phường/xã MỚI sau sáp nhập ("phường Hạc Thành, Thanh Hóa", "xã Tây Phương,
  // Hà Nội") không có trong danh mục cũ: khách đã ghi rõ phường/xã, tỉnh khớp, có
  // số nhà/đường → nhận luôn (nhân viên đối chiếu ở Xử lý dữ liệu), không hỏi lại
  // đúng cấp khách vừa ghi — khách từng gắt "Mới cũ đcj mà".
  // Phải là một đoạn riêng (sau dấu phẩy) mở bằng phường/xã/thị trấn, không số
  // nhà: "12 Xã Đàn" là tên đường, "thị xã X" là cấp huyện.
  const postMergerWard = Boolean(delivery?.resolved?.province) && !delivery?.resolved?.ward && !delivery?.missing?.includes('street')
    && address.split(/[,\n;]/).slice(1).some(part => /^\s*(phường|xã|thị trấn|p\.|x\.)\s*\p{L}{2,}/iu.test(part) && !/\d/.test(part) && !/thị xã/iu.test(part));
  // Vòng 12: đã hỏi đủ maxAddressAsks (1) lần mà khách gửi thêm phần địa chỉ ở tin này → nhận nguyên chữ
  // (đơn mang ghi chú soát phường/xã). Lượt khách hỏi chuyện khác (không gửi địa chỉ) không tự chốt.
  // (Giỏ chờ khách xác nhận đặt thêm — engine đặt addressAsks = maxAddressAsks + awaitingConfirm — đã nhận địa chỉ rồi.)
  const answeredAfterAsk = addressAsks >= maxAddressAsks && (Boolean(givenAddress && givenAddress !== '0') || Boolean(context.pendingOrder?.awaitingConfirm) || addressAsks >= 2);
  const addressAccepted = Boolean(delivery) && (delivery.complete || answeredAfterAsk || answeredInFull || postMergerWard);
  // Nhận khi chưa đủ cấp: nhân viên soát lại (ghi chú đơn ⚠).
  const addressCheck = addressAccepted && !delivery.complete ? 'Soát phường/xã: bot nhận nguyên chữ khách ghi' : (delivery?.wardUnverified ? 'Thiếu phường/xã: nhân viên bổ sung' : '');
  // Ghi chú soát đi theo giỏ tới khi lên đơn: địa chỉ AI suy ra độ tin thấp (T7, engine đặt value.addressAiCheck)
  // và SĐT trùng đơn landing/POS không thuộc hội thoại (C2, previousDelivery.foreign).
  const foreignCheck = previous?.foreign ? `SĐT trùng đơn ${previous.foreign.source || 'ngoài'} ${previous.foreign.orderId || ''} không thuộc hội thoại, đối chiếu người nhận`.replace(/\s+/g, ' ') : '';
  const staffCheck = [...new Set([String(value.addressAiCheck || '').trim(), foreignCheck, ...String(pending?.staffCheck || '').split('; ')].filter(Boolean))].join('; ').slice(0, 300);

  // Remember a priceable basket, plus whatever contact detail has arrived so
  // far, so the customer never has to repeat something already given.
  const freshPriceable = Boolean(freshItems.length && freshPrice?.priceable);
  const nextPending = freshPriceable || pending || hasPhone || hasAddress
    ? {
        items: freshPriceable ? freshItems : (pending?.items || []),
        key: freshPriceable ? freshKey : (pending?.key || ''),
        at: freshPriceable ? now : (pending?.at || now),
        phone,
        address,
        addressAsks,
        // Cờ "đã gợi ý 2 túi" đi theo giỏ: giỏ mới (khác giỏ đang giữ) thì bỏ.
        ...(pending?.upsold && (!freshPriceable || freshKey === pending.key) ? { upsold: true } : {}),
        // Vòng 12: khách muốn gửi về địa chỉ cũ mà chưa tra ra (chưa có SĐT/đơn cũ): nhớ cho lượt sau.
        ...(wantsPrevious && !previous?.address && !address ? { wantsPrevious: true } : {}),
        ...(staffCheck ? { staffCheck } : {}),
        // Vòng 12: số túi khách đã nêu khi chưa chọn vị — giữ tới khi giỏ có hàng.
        ...(!freshPriceable && !(pending?.items || []).length && Number(context.pendingOrder?.askedBagCount) ? { askedBagCount: Number(context.pendingOrder.askedBagCount) } : {})
      }
    : null;

  const confirmed = isOrderStep(templateId) && Boolean(price) && hasPhone && hasAddress && addressAccepted;

  // Everything else is in hand but the address cannot be placed on the
  // delivery map: ask for exactly the missing piece, or offer the choice
  // between same-named places, instead of shipping to a guess.
  if (isOrderStep(templateId) && Boolean(price) && hasPhone && hasAddress && !addressAccepted) {
    const asked = { ...nextPending, addressAsks: addressAsks + 1 };
    const choose = delivery.choices && templates.ORDER_ADDRESS_CHOOSE;
    const template = choose ? templates.ORDER_ADDRESS_CHOOSE : templates.ORDER_ADDRESS_CLARIFY;
    const values = {
      ...commonValues(),
      address,
      known: delivery.known,
      missing: delivery.missingLabel,
      level: delivery.choices?.label || '',
      options: delivery.choices ? delivery.choices.options.join(' hay ') : ''
    };
    if (template) {
      // Vòng 11 (P1): câu nhắc ngắn cho lượt khách hỏi chuyện khác khi địa chỉ còn thiếu cấp — nêu đúng phần
      // địa chỉ còn thiếu (engine gửi kèm câu trả lời, không lưu lại giỏ nên addressAsks không tăng).
      const remindMissing = choose ? `${delivery.choices.label || 'địa chỉ'} (${delivery.choices.options.join(' hay ')})` : (delivery.missingLabel || 'địa chỉ nhận hàng đầy đủ');
      const remind = templates.ORDER_ADDRESS_REMIND ? fill(templates.ORDER_ADDRESS_REMIND, {
        ...commonValues(),
        cart: price.lines.map(line => `${line.quantity} ${line.name}`).join(' + '),
        total: formatMoney(price.total),
        free_ship: price.gifts.find(isFreeShippingGift)?.name || '',
        ship_fee: price.shippingFee ? formatMoney(price.shippingFee) : '',
        gift: price.gifts.filter(gift => !isFreeShippingGift(gift)).map(gift => gift.name).join(' + '),
        missing: remindMissing
      }) : '';
      return { templateId: 'ORDER_ADDRESS', ...splitMessages(fill(template, values)), remind, handoff: false, pendingOrder: asked };
    }
    // No text configured for the question: fall through and accept the address as is.
  }

  // Muốn mua nhưng chưa nêu sản phẩm (và cũng chưa có giỏ hàng chờ): hỏi
  // sản phẩm trước, không xin SĐT/địa chỉ cho một đơn chưa biết bán gì.
  // SĐT/địa chỉ khách lỡ đưa vẫn được giữ cho lần chốt sau.
  if (!items.length) {
    // Khách đang giữ ưu đãi dùng thử: mời chọn 1 túi, không gửi bảng giá chung.
    if (trial && templates.TRIAL_ACCEPT) {
      return { templateId: 'TRIAL_ACCEPT', ...splitMessages(fill(templates.TRIAL_ACCEPT, { ...commonValues(), bags: context.trialBags || '' })), handoff: false, pendingOrder: nextPending };
    }
    // Khách nêu số lượng mà chưa nói vị ("M lấy 1 túi", "ship mình 2 gói"): hỏi vị, không gửi bảng giá chung.
    if (templates.ASK_FLAVOR && /\b(\d{1,2}|mot|hai|ba)\s*(tui|goi|bich|bit)\b/.test(normalizeText(String(context.messageText || '')))) {
      // Vòng 12: nhớ số túi khách vừa nêu ("Cho mình 2 túi" + SĐT) để tin trả lời vị sau ("Túi vàng") đủ 2 túi.
      const askedBagCount = countBags(context.messageText || '');
      const asked = askedBagCount ? { ...(nextPending || { items: [], key: '', at: now, phone: '', address: '', addressAsks: 0 }), askedBagCount } : nextPending;
      return { templateId: 'ASK_FLAVOR', ...splitMessages(fill(templates.ASK_FLAVOR, commonValues())), handoff: false, pendingOrder: asked };
    }
    const text = templates.GENERAL_INFO ? renderGeneralInfo(templates) : fill(templates.ASK_PRODUCT, commonValues());
    return { templateId: 'ASK_PRODUCT', ...splitMessages(text), handoff: false, pendingOrder: nextPending };
  }

  if (!confirmed && !(isOrderStep(templateId) && Boolean(price) && hasPhone && hasAddress)) {
    // Only a request to close the order is escalated. While still collecting
    // details the bot keeps asking rather than dropping the customer on a human.
    const missing = hasPhone && !hasAddress ? 'địa chỉ nhận hàng đầy đủ'
      : !hasPhone && hasAddress ? 'số điện thoại'
      : 'số điện thoại và địa chỉ nhận hàng đầy đủ';
    const known = hasPhone ? 'số điện thoại' : hasAddress ? 'địa chỉ' : '';
    if (items.length && !price) {
      // Giỏ nhận ra đủ sản phẩm nhưng không có trong bảng combo (túi lớn + hộp
      // 10 gói, 4 túi…): hỏi lại vị là sai (khách đã nói rõ) và bot từng im luôn.
      // Giữ giỏ, xin phần còn thiếu, gắn thẻ để nhân viên tính giá.
      if (['not-a-combo', 'too-many'].includes(priced?.reason) && templates.ORDER_CUSTOM_BASKET) {
        const cart = items.map(item => `${item.quantity} ${matchProduct(item.product)?.name || item.product}`).join(' + ');
        const text = fill(templates.ORDER_CUSTOM_BASKET, { ...commonValues(), cart, missing: hasPhone && hasAddress ? '' : missing });
        return { templateId: 'ORDER_CUSTOM_BASKET', ...splitMessages(text), handoff: false, attention: true, pendingOrder: { phone, address, addressAsks, ...(nextPending || {}), items, key, at: now } };
      }
      // Giỏ chưa tính được giá ("combo 3 túi" chưa nói vị…): hỏi vị và số lượng
      // thay vì chuyển người; SĐT/địa chỉ đã có vẫn được giữ. Cả khi đang xin
      // SĐT/địa chỉ: khách vừa đổi sang giỏ không tính được giá mà vẫn hỏi tiếp
      // thì đơn chốt sau đó là giỏ cũ, sai ý khách.
      const text = templates.ASK_FLAVOR ? fill(templates.ASK_FLAVOR, commonValues()) : renderGeneralInfo(templates);
      return { templateId: templates.ASK_FLAVOR ? 'ASK_FLAVOR' : 'GENERAL_INFO', ...splitMessages(text), handoff: false, pendingOrder: nextPending };
    }
    // One wording when nothing has arrived yet, another once part of it has.
    const template = known ? templates.ORDER_ADDRESS_PARTIAL : templates.ORDER_ADDRESS;
    // Khách lấy 1 túi: nhân lúc xin thông tin, gợi ý lên 2 túi (giá combo, miễn
    // ship, quà) đúng một lần cho mỗi giỏ; khách vẫn lấy 1 túi thì đơn đi tiếp.
    // Không mời khi khách đã nói rõ chỉ lấy 1 ("1 túi thôi", "chỉ lấy 1", "dùng thử đã"), khi engine
    // báo không mời (context.noUpsell: hội thoại có khiếu nại/cần người xử lý, vừa nói sỉ/CTV, đã mời
    // một lần trong hội thoại), hay giỏ này đã được mời (pending.upsold).
    const declinesUpsell = /\b(thoi|chi (lay|mua|can|lay thu)|(1|mot) (tui|goi|hop|bich) (thoi|la du|da|truoc)|(dung|an|lay|mua) thu (thoi|da|truoc))\b/.test(messageWords);
    const upsell = price?.totalQuantity === 1 && !trial && templates.UPSELL_TWO_BAGS && !pending?.upsold && !context.noUpsell && !declinesUpsell ? upsellTwoBags(price, templates) : '';
    // Nêu lại giỏ và tổng tiền trước câu xin SĐT/địa chỉ: nhân viên từng phải gõ
    // tay "Dạ đơn của mình gồm…" và khách hỏi "tổng bao nhiêu" thì không có số.
    // Lời gợi ý 2 túi đã có số tiền thì thôi, không lặp.
    const cartValues = price ? {
      ...commonValues(),
      cart: price.lines.map(line => `${line.quantity} ${line.name}`).join(' + '),
      total: formatMoney(price.total),
      free_ship: price.gifts.find(isFreeShippingGift)?.name || '',
      ship_fee: price.shippingFee ? formatMoney(price.shippingFee) : '',
      gift: price.gifts.filter(gift => !isFreeShippingGift(gift)).map(gift => gift.name).join(' + '),
      missing
    } : null;
    const cartLine = cartValues && !upsell && templates.ORDER_CART_LINE ? fill(templates.ORDER_CART_LINE, cartValues) : '';
    const askText = fill(template, { ...commonValues(), missing, known });
    const ask = splitMessages(cartLine ? `${cartLine}\n${askText.replace(/^Dạ,?\s+(\p{L})/u, (_, first) => first.toUpperCase())}` : askText);
    return {
      templateId: 'ORDER_ADDRESS',
      ...ask,
      // Engine gửi theo `parts`: lời gợi ý 2 túi phải vào cả `parts`, không thì
      // cờ upsold được bật mà khách chưa từng nhận lời gợi ý.
      ...(upsell ? { messages: [...ask.messages, ...splitMessages(upsell).messages], parts: [...(ask.parts || []), ...(splitMessages(upsell).parts || [])] } : {}),
      // Câu nhắc ngắn khi khách nhắn tiếp mà bot sắp gửi lại y câu xin thông tin.
      remind: cartValues && templates.ORDER_ADDRESS_REMIND ? fill(templates.ORDER_ADDRESS_REMIND, cartValues) : '',
      handoff: false,
      // Vòng 12: khách muốn gửi về địa chỉ cũ, đã có SĐT mà không tra ra địa chỉ (engine đã tra đơn
      // CRM/landing/POS cục bộ theo SĐT — lookupPreviousAddress): cần người xem, không hỏi từng cấp.
      ...(wantsPrevious && hasPhone && !hasAddress ? { attention: true, oldAddressMissing: true } : {}),
      // C2: địa chỉ cũ thuộc đơn ngoài hội thoại (không điền) — luôn gắn thẻ cho nhân viên đối chiếu.
      ...(previous?.foreign ? { attention: true, oldAddressMissing: true } : {}),
      pendingOrder: upsell && nextPending ? { ...nextPending, upsold: true } : nextPending
    };
  }

  const total = price.total;
  // Vòng 12: ghi chú cho nhân viên đi kèm đơn (order-notes.mjs đọc addressCheck/deliveryNote; cần
  // conversation-orders.normalizeChatbotOrder chép hai trường này sang bản ghi đơn).
  const fullCheck = [addressCheck, staffCheck].filter(Boolean).join('; ');
  const orderNoteFields = { ...(fullCheck ? { addressCheck: fullCheck } : {}), ...(deliveryNote ? { deliveryNote } : {}) };
  // Catalogue names, not the customer's wording, so the confirmation and the
  // order record agree on what is being shipped.
  const orderItems = price.lines.map(line => ({ product: line.name, code: line.sku, quantity: line.quantity }));
  // The confirmation repeats the address in the warehouse's own wording
  // (ward, district, province spelled out) so the customer checks exactly what
  // will be shipped to; the order keeps what they typed as rawAddress.
  const deliveryAddress = delivery?.canonical || address;
  const confirmation = fill(templates.ORDER_CONFIRMATION, {
    ...commonValues(),
    phone,
    address: deliveryAddress,
    shipping: price.shippingFee ? formatMoney(price.shippingFee) : '',
    subtotal: formatMoney(price.subtotal),
    total: formatMoney(total),
    // Free shipping is written next to the total; other gifts get their own line.
    free_ship: price.gifts.find(isFreeShippingGift)?.name || '',
    gift: price.gifts.filter(gift => !isFreeShippingGift(gift)).map(gift => gift.name).join(' + ')
  }, { items: orderItems.map(item => ({ product: item.product, quantity: item.quantity })) });
  if (updating && templates.ORDER_UNCHANGED && unchangedOrder(recentOrder, orderItems, phone, deliveryAddress)) {
    // Không có gì để sửa: nhắc lại đơn đã lên, không gọi sửa đơn, không gắn thẻ.
    const unchanged = fill(templates.ORDER_UNCHANGED, {
      ...commonValues(),
      phone,
      address: deliveryAddress,
      total: formatMoney(total),
      free_ship: price.gifts.find(isFreeShippingGift)?.name || '',
      gift: price.gifts.filter(gift => !isFreeShippingGift(gift)).map(gift => gift.name).join(' + ')
    }, { items: orderItems.map(item => ({ product: item.product, quantity: item.quantity })) });
    return { templateId: 'ORDER_UNCHANGED', ...splitMessages(unchanged), images: [], handoff: false, pendingOrder: null };
  }
  if (updating) {
    // Sửa đơn: một tin ngắn nêu giỏ mới, không lặp lại chính sách giao/đổi trả.
    const updated = fill(templates.ORDER_UPDATED || templates.ORDER_CONFIRMATION, {
      ...commonValues(),
      phone,
      address: deliveryAddress,
      shipping: price.shippingFee ? formatMoney(price.shippingFee) : '',
      subtotal: formatMoney(price.subtotal),
      total: formatMoney(total),
      free_ship: price.gifts.find(isFreeShippingGift)?.name || '',
      gift: price.gifts.filter(gift => !isFreeShippingGift(gift)).map(gift => gift.name).join(' + ')
    }, { items: orderItems.map(item => ({ product: item.product, quantity: item.quantity })) });
    return {
      templateId: 'ORDER_UPDATE',
      ...splitMessages(updated),
      images: [],
      handoff: false,
      pendingOrder: null,
      order: { items: orderItems, phone, address: deliveryAddress, rawAddress: address, total, subtotal: price.subtotal, shippingFee: price.shippingFee, orderKey: key, gift: price.gift, updateOrderId: String(recentOrder.id), ...(trialPriced ? { trial: true } : {}), ...(promoBowl ? { promoGift: PROMO_BOWL_GIFT.name } : {}), ...orderNoteFields }
    };
  }
  return {
    templateId: 'ORDER_CONFIRMATION',
    // The confirmation, then the delivery policy and the after-sale note —
    // each one is a template of its own so staff can rewrite or blank it.
    messages: [confirmation, fill(templates.SHIPPING_POLICY, commonValues()), fill(templates.ORDER_AFTER_SALE, commonValues())].flatMap(text => splitMessages(text).messages).slice(0, 3),
    images: [],
    handoff: false,
    // Cleared: the basket has become a real order.
    pendingOrder: null,
    order: { items: orderItems, phone, address: deliveryAddress, rawAddress: address, total, subtotal: price.subtotal, shippingFee: price.shippingFee, orderKey: key, gift: price.gift, ...(trialPriced ? { trial: true } : {}), ...(promoBowl ? { promoGift: PROMO_BOWL_GIFT.name } : {}), ...orderNoteFields }
  };
}

// ===== Replies filled from the catalogue =====
// GENERAL_INFO, GIFT_POLICY, PRICE_MIX_TUI_LON and PRICE_QUOTE are ordinary
// editable templates; what makes them special is only the values they are
// filled with, all read from Cài đặt → Sản phẩm / Quà tặng at reply time.

function renderGeneralInfo(templates) {
  const products = getCatalogProducts().filter(product => product.active && product.unitPrice > 0);
  if (!products.length) return fill(templates.ASK_PRODUCT, commonValues());
  return fill(templates.GENERAL_INFO, { ...commonValues(), count: products.length, images: pickCatalogImages() }, {
    products: products.map(product => ({ product: product.name, price: formatMoney(product.unitPrice) }))
  });
}

/** One line per distinct gift set: which combinations earn it (same wording the model reads). */
function renderGiftPolicy(templates) {
  if (!getGifts().some(gift => gift.active)) return fill(templates.GIFT_POLICY_EMPTY, commonValues());
  const gifts = describeGiftTable()
    .map(line => line.replace(/^- /, ''))
    .map(line => {
      const at = line.indexOf(': ');
      // `combos` kept as an alias so a saved GIFT_POLICY template written for the old table still fills.
      return at > 0 ? { gifts: line.slice(0, at), rule: line.slice(at + 2), combos: line.slice(at + 2) } : null;
    })
    .filter(Boolean);
  if (!gifts.length) return fill(templates.GIFT_POLICY_EMPTY, commonValues());
  return fill(templates.GIFT_POLICY, commonValues(), { gifts });
}

/**
 * PRICE_MIX_TUI_LON: every two-product mix of the mixable products, then the
 * full set when all of them fit in one order — priced and gifted per the
 * combination table, so the lines change the moment a tick changes.
 */
function renderMixPricing(templates) {
  const mixable = getCatalogProducts().filter(product => product.active && product.mixable && product.comboPrice > 0);
  if (mixable.length < 2) return fill(templates.ASK_PRODUCT, commonValues());
  const combos = new Set(listCombos().map(combo => combo.key));
  const priceOf = items => formatMoney(items.reduce((sum, product) => sum + product.comboPrice, 0));
  const pairs = [];
  for (let a = 0; a < mixable.length; a += 1) {
    for (let b = a + 1; b < mixable.length; b += 1) {
      const key = comboKey([{ sku: mixable[a].sku, quantity: 1 }, { sku: mixable[b].sku, quantity: 1 }]);
      if (combos.has(key)) pairs.push({ first: mixable[a].name, second: mixable[b].name, price: priceOf([mixable[a], mixable[b]]), ...basketValues(key) });
    }
  }
  const fullKey = mixable.length >= 3 && mixable.length <= maxComboQuantity ? comboKey(mixable.map(product => ({ sku: product.sku, quantity: 1 }))) : '';
  const full = fullKey && combos.has(fullKey)
    ? { full_count: mixable.length, full_names: mixable.map(product => product.name).join(' + '), full_price: priceOf(mixable), ...Object.fromEntries(Object.entries(basketValues(fullKey)).map(([k, v]) => [`full_${k}`, v])) }
    : {};
  return fill(templates.PRICE_MIX_TUI_LON, { ...commonValues(), ...full }, { pairs });
}

/** Combining long-stroke overlay: the only way Messenger shows a struck-out price. */
function strike(text) {
  return [...String(text)].map(char => `${char}\u0336`).join('');
}

function unitSlug(unit) {
  return normalizeText(unit).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * PRICE_QUOTE for one product: the template carries every rung (1, 2, 3
 * units) with numbered values — {price_2}, {gift_3}… — and rungs the product
 * does not sell fall away by the empty-line rule. A product whose unit word
 * is "Combo" uses PRICE_QUOTE_COMBO when that template exists, so packs read
 * "2 Combo Tiện Lợi" while bags read "Combo 2 Túi bán chạy". The model's
 * old PRICE_TUI_XANH ids still work: "tui xanh" is the product's alias.
 */
function renderPriceQuote(templateId, value, templates) {
  const quote = quoteTiers(value.Product_N1 || value.product || '', giftContext())
    || quoteTiers(templateId.replace(/^PRICE_/, '').replace(/_/g, ' '), giftContext());
  if (!quote) return fill(templates.ASK_PRODUCT, commonValues());
  const { product } = quote;
  const slug = unitSlug(product.unit);
  const template = (slug && templates[`PRICE_QUOTE_${slug}`]) || templates.PRICE_QUOTE;
  const image = publicImageUrl(product.image);
  // {images}: 2–3 ảnh ngẫu nhiên trong thư viện (đặt đầu mẫu để ảnh đi trước
  // bảng giá); {image}: ảnh chính, giữ cho mẫu cũ.
  const values = { ...commonValues(), product: product.name, unit: product.unit, image: image ? `![${product.name}](${image})` : '', images: pickGalleryImages(product) };
  for (const tier of quote.tiers) {
    const n = tier.quantity;
    const key = comboKey([{ sku: product.sku, quantity: n }]);
    Object.assign(values, {
      [`weight_${n}`]: formatWeight(tier.weight),
      [`list_price_${n}`]: strike(formatMoney(tier.listPrice)),
      [`price_${n}`]: formatMoney(tier.price),
      ...Object.fromEntries(Object.entries(basketValues(key)).map(([k, v]) => [`${k}_${n}`, v]))
    });
  }
  return fill(template, values);
}

/**
 * PRODUCT_PHOTOS: khách xin ảnh/mẫu. Ảnh lấy từ Cài đặt → Sản phẩm: khách nêu
 * loại nào thì gửi ảnh loại đó, chưa nêu thì gửi ảnh các sản phẩm đang bán
 * (tối đa 3). Chưa sản phẩm nào có ảnh thì trả về '' để người thật gửi ảnh.
 */
function renderProductPhotos(value, templates) {
  // Engine đưa sẵn ảnh (ảnh quà bát gáo dừa…) qua values.images: điền thẳng, không tra danh mục.
  if (value.values && typeof value.values === 'object' && value.values.images) {
    return fill(templates.PRODUCT_PHOTOS, { ...commonValues(), products: String(value.values.products || ''), images: String(value.values.images) });
  }
  const named = matchProduct(value.Product_N1 || value.product || '');
  const random = activeCustomer.random || Math.random;
  const products = (named ? [named] : getCatalogProducts()).filter(product => product.active && galleryOf(product).length).slice(0, 3);
  if (!products.length) return '';
  // Nêu loại: 2–3 ảnh ngẫu nhiên của loại đó; chưa nêu: mỗi loại một ảnh ngẫu nhiên.
  const images = named
    ? pickGalleryImages(named, random)
    : products.map(product => `![${product.name}](${sampleImages(galleryOf(product), 1, random)[0]})`).join(' ');
  return fill(templates.PRODUCT_PHOTOS, { ...commonValues(), products: products.map(product => product.name).join(', '), images });
}

/**
 * DISCOUNT_POLICY: khách hỏi giảm giá. Túi lẻ không bớt; ưu đãi nằm ở combo,
 * đọc từ bảng giá: từng bậc 2, 3… đơn vị của sản phẩm khách nêu (hoặc của
 * mọi sản phẩm có giá combo khi chưa nêu), kèm miễn ship và quà của bậc đó.
 */
function renderDiscountPolicy(value, templates) {
  const named = matchProduct(value.Product_N1 || value.product || '');
  // Chưa nêu loại: chỉ 3 túi chủ lực (sản phẩm ghép combo được: Xanh, Vàng, Nâu),
  // mỗi túi MỘT dòng gọn "2 túi … · 3 túi …" — không liệt kê combo của mọi sản
  // phẩm trong danh mục (tin dài cả màn hình, khách khó đọc).
  if (!named) {
    const main = getCatalogProducts().filter(product => product.active && product.mixable && product.comboPrice > 0);
    const lines = main.map(product => {
      const tiers = (quoteTiers(product.sku, giftContext())?.tiers || []).filter(tier => tier.quantity >= 2 && tier.quantity <= 3);
      if (!tiers.length) return null;
      const price = tiers.map(tier => `${tier.quantity} ${String(product.unit || 'túi').toLowerCase()} ${formatMoney(tier.price)}${tier.gifts.length ? ` (tặng ${tier.gifts.join(' + ')})` : ''}`).join(' · ');
      return { label: product.name, price, list_price: '', free_ship: tiers.every(tier => tier.freeShipping) ? 'miễn phí vận chuyển' : '', gift: '' };
    }).filter(Boolean);
    if (lines.length) return fill(templates.DISCOUNT_POLICY, commonValues(), { combos: lines });
  }
  const products = (named ? [named] : getCatalogProducts()).filter(product => product.active && product.comboPrice > 0);
  const combos = products.flatMap(product => (quoteTiers(product.sku, giftContext())?.tiers || [])
    .filter(tier => tier.quantity >= 2 && (tier.price < tier.listPrice || tier.freeShipping || tier.gifts.length))
    .map(tier => ({
      // Tên đã mở đầu bằng đơn vị ("Combo 10 gói Mix"): không ghi "2 Combo Combo 10 gói Mix".
      label: normalizeText(product.name).startsWith(normalizeText(product.unit || '~'))
        ? `${tier.quantity} × ${product.name}`
        : `${tier.quantity} ${product.unit || 'sản phẩm'} ${product.name}`,
      price: formatMoney(tier.price),
      list_price: tier.price < tier.listPrice ? strike(formatMoney(tier.listPrice)) : '',
      free_ship: tier.freeShipping ? 'miễn phí vận chuyển' : '',
      gift: tier.gifts.join(' + ')
    })));
  if (!combos.length) return renderGeneralInfo(templates);
  return fill(templates.DISCOUNT_POLICY, commonValues(), { combos });
}

/**
 * "Đơn em tới đâu rồi?": kể lại đơn gần nhất trong hội thoại (món, giờ đặt,
 * đã chuyển kho hay chưa) và mốc giao dự kiến; không có đơn thì xin SĐT để tra.
 * Trước đây câu này bị chuyển nhân viên dù hệ thống đã có đủ dữ liệu.
 */
function renderOrderStatus(templates) {
  const order = activeRecentOrder;
  if (!order) return templates.ORDER_STATUS_NONE ? fill(templates.ORDER_STATUS_NONE, commonValues()) : '';
  // Vòng 12 (B2 #33, B3 #7): tên đẹp theo danh mục (POS ghi tên thô "Granola Mới Ngũ Cốc… x1").
  const items = (Array.isArray(order.products) ? order.products : [])
    .map(item => `${matchProduct(item.sku || '')?.name || matchProduct(item.name || item.product || '')?.name || item.name || item.product || item.sku || 'sản phẩm'} x${Number(item.quantity) || 1}`)
    .join(', ') || 'sản phẩm đã đặt';
  const at = new Date(Number(order.createdAt) || Date.now());
  const parts = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).formatToParts(at);
  const part = type => parts.find(item => item.type === type)?.value || '';
  const orderedAt = `${part('hour')}:${part('minute')} ngày ${part('day')}/${part('month')}`;
  // Vòng 12 (B1 #10, B3 #7): trạng thái theo POS, không coi "có mã POS" là đã chuyển kho (đơn s52903 "Mới" 9 ngày bị báo "đã
  // chuyển sang kho"; đơn vừa tạo 1 phút cũng vậy). Dưới 30 phút luôn là "đã ghi nhận".
  const status = String(order.pos?.status || order.posStatus || order.status || '');
  const ageMin = (Date.now() - (Number(order.createdAt) || Date.now())) / 60000;
  const shipped = ageMin >= 30 && /đã giao|đang giao|đã gửi|gửi hàng|vận chuyển|chờ chuyển|chờ lấy|đóng hàng|đóng gói/i.test(status);
  const confirmed = ageMin >= 30 && /đã xác nhận|xác nhận/i.test(status);
  // Đơn đã hủy (qua bot, nhân viên hay POS) không được kể là "kho đang chuẩn bị hàng".
  const cancelled = String(order.processingStatus || '') === 'cancelled' || order.status === 'Hủy';
  const state = cancelled ? 'đã hủy' : shipped ? 'đã chuyển sang kho để đóng gói và bàn giao vận chuyển' : confirmed ? 'đã được xác nhận, kho đang chuẩn bị hàng' : 'đã được ghi nhận, kho đang chuẩn bị hàng';
  const text = fill(templates.ORDER_STATUS, { ...commonValues(), items, ordered_at: orderedAt, state, total: formatMoney(Number(order.total) || 0) });
  // Đơn đã hủy: không nối đoạn "thời gian giao dự kiến… gửi mã vận đơn" (chỉ giữ câu đầu nêu trạng thái).
  return cancelled ? text.split(/(?<=ạ\.)\s+/u)[0] : text;
}

/**
 * Khách đang có đơn trong 7 ngày mà lại đặt tiếp: kể đơn đang có và hỏi khách xác nhận đặt THÊM
 * (value.cart = giỏ mới), chưa lên đơn — chủ shop 26/09: không tự tạo đơn thứ hai khi chưa hỏi.
 */
function renderExistingOrderConfirm(value, templates) {
  const order = activeRecentOrder;
  if (!order || !templates.ORDER_EXISTING_CONFIRM) return '';
  const items = (Array.isArray(order.products) ? order.products : Array.isArray(order.items) ? order.items : [])
    .map(item => `${item.name || item.product || item.sku || 'sản phẩm'} x${Number(item.quantity) || 1}`)
    .join(', ') || 'sản phẩm đã đặt';
  const at = new Date(Number(order.createdAt) || Date.now());
  const parts = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).formatToParts(at);
  const part = type => parts.find(item => item.type === type)?.value || '';
  const shipped = Boolean(order.pos?.id || order.posOrderId || /đã giao|đang giao|đã gửi/i.test(String(order.status || '')));
  return fill(templates.ORDER_EXISTING_CONFIRM, {
    ...commonValues(),
    existing_items: items,
    existing_at: `${part('hour')}:${part('minute')} ngày ${part('day')}/${part('month')}`,
    existing_state: shipped ? 'đã chuyển sang kho / vận chuyển' : 'đã được ghi nhận, kho đang chuẩn bị hàng',
    cart: String(value.cart || 'giỏ vừa chọn')
  });
}

const catalogRenderers = {
  ORDER_STATUS: (value, templates) => renderOrderStatus(templates),
  ORDER_EXISTING_CONFIRM: (value, templates) => renderExistingOrderConfirm(value, templates),
  GENERAL_INFO: (value, templates) => renderGeneralInfo(templates),
  GIFT_POLICY: (value, templates) => renderGiftPolicy(templates),
  PRICE_MIX_TUI_LON: (value, templates) => renderMixPricing(templates),
  PRICE_QUOTE: (value, templates) => renderPriceQuote('PRICE_QUOTE', value, templates),
  PRODUCT_PHOTOS: (value, templates) => renderProductPhotos(value, templates),
  DISCOUNT_POLICY: (value, templates) => renderDiscountPolicy(value, templates)
};

/**
 * A PRICE_<sản phẩm> id from the old prompt vocabulary. It is answered
 * by PRICE_QUOTE for that product; a text stored under it (the old
 * "Dạ Túi Xanh 450g: 1 túi 174.000đ…") is stale by definition and dropped.
 */
// Mã mẫu trong seed, đọc một lần (isProductQuoteId được gọi cho từng mẫu ở mỗi lượt).
let cachedSeedIds = null;
const seedTemplateIds = () => (cachedSeedIds ||= Object.fromEntries(Object.keys(defaultMessageTemplates()).map(id => [id, true])));

export function isProductQuoteId(templateId) {
  const id = String(templateId || '').trim();
  if (!id.startsWith('PRICE_') || catalogRenderers[id] || Object.hasOwn(seedTemplateIds(), id)) return false;
  return Boolean(matchProduct(id.replace(/^PRICE_/, '').replace(/_/g, ' ')));
}

// Templates the server picks on its own; the model never needs to name them.
const internalTemplateIds = new Set(['ASK_PRODUCT', 'ORDER_EXISTING_CONFIRM', 'ORDER_PHONE_ASK_FLAVOR', 'FOLLOW_UP_COMMENT_FREESHIP', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'ORDER_AFTER_SALE', 'GIFT_POLICY_EMPTY', 'PRICE_QUOTE_COMBO', 'CSKH_HANDOFF', 'COMMENT_PUBLIC_REPLY', 'COMMENT_PUBLIC_FALLBACK', 'COMMENT_PUBLIC_REPEAT', 'LIVESTREAM_COMMENT', 'COMMENT_PRIVATE_REPLY', 'ORDER_ADDRESS', 'ORDER_CONFIRMATION', 'ORDER_UPDATED', 'ORDER_UNCHANGED', 'ORDER_CANCELLED', 'ORDER_STATUS_NONE', 'UPSELL_TWO_BAGS', 'REPLY_ALREADY_SENT', 'COMMENT_STAFF_FOLLOWUP', 'ORDER_CART_LINE', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET', 'REPLY_ALREADY_SENT_INFO', 'ORDER_STATUS_CHECKING', 'LIVE_DEAL_CLAIMED', 'COMMENT_PUBLIC_SORRY', 'SHOP_ORDER_RECEIVED', 'ORDER_NOTE_ADDED', 'QR_OFFER', 'ORDER_WRONG', 'ORDER_CHANGE_STAFF', 'GIFT_SWAP', 'TRIAL_ACCEPT', 'TRIAL_REMIND', 'TRIAL_PRICE', 'TRIAL_FREESHIP_INFO', 'TRIAL_NEXT_STEP', 'TRIAL_DECLINED',
  // Vòng 12: mẫu engine/luật tự chọn (cần số liệu điền sẵn hay ngữ cảnh) — mô hình không gọi tên.
  'PRICE_COUNT', 'PRICE_ONE_BAG', 'ASK_REORDER', 'TROPICAL_CONFIRM', 'GIFT_POLICY_LIVE', 'GIFT_POLICY_PROMO', 'GIFT_POLICY_UPSELL3', 'ASK_TWO_BAGS', 'IMAGE_WITH_PHONE',
  'COMMENT_PUBLIC_STAFF', 'COMMENT_PUBLIC_FEEDBACK', 'ORDER_CANCEL_STAFF', 'ORDER_HOLD_STAFF', 'STAFF_ONLY_PRODUCT', 'RECEIVED_CHECK',
  // fix-bot 01/10: câu "đặt thêm?" khi đơn ngoài hội thoại (engine tự chọn, không kể chi tiết đơn).
  'ORDER_EXISTING_CONFIRM_PHONE']);

// fix-bot T1 (01/10): mẫu "báo sự việc đã xảy ra" (đã nhận đơn Shop, đã hủy/sửa/ghi chú đơn, đã nhận deal live, đơn
// đang có…) — chỉ engine được chọn khi việc đó thật sự xảy ra; mô hình trả các mã này thì luôn đổi về GENERAL_INFO.
const engineFactTemplateIds = new Set(['SHOP_ORDER_RECEIVED', 'ORDER_CANCELLED', 'ORDER_UPDATED', 'ORDER_UNCHANGED', 'ORDER_NOTE_ADDED', 'LIVE_DEAL_CLAIMED', 'ORDER_EXISTING_CONFIRM', 'ORDER_EXISTING_CONFIRM_PHONE']);
// Mẫu nội bộ mà mô hình vẫn được gọi tên (bước đơn ảo + chuyển người).
const modelAllowedInternalIds = new Set(['ORDER_ADDRESS', 'ORDER_CONFIRMATION', 'ORDER_UPDATE', 'ORDER_CANCEL', 'ORDER_NOTE', 'CSKH_HANDOFF']);
// Trường JSON mô hình được trả (đúng những trường renderChatbotReply đọc từ mô hình — xem responseSchemaFor).
const modelAnswerFields = ['template_id', 'Product_N1', 'No_A', 'Product_N2', 'No_B', 'Product_N3', 'No_C', 'Phone_Number', 'Customer_Address', 'also', 'warming', 'add_to_basket', 'product'];

/**
 * fix-bot T1 (01/10): làm sạch JSON của mô hình trước khi soạn tin. Chỉ giữ các trường mô hình được trả — bỏ `values`
 * (số liệu điền mẫu: "đã nhận đơn 10 túi – tổng 1.000đ"), `orderNote`, `clearBasket`, `cart`, `addressAiCheck`… mà khách
 * có thể lái mô hình tự điền. Mã mẫu nội bộ (engine tự chọn) mà prompt của chủ shop không nhắc tới → GENERAL_INFO;
 * mẫu "báo việc đã xảy ra" → luôn GENERAL_INFO. `also` nội bộ thì bỏ.
 */
export function sanitizeModelAnswer(parsed, systemPrompt = '') {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const clean = {};
  for (const field of modelAnswerFields) if (source[field] !== undefined && typeof source[field] !== 'object') clean[field] = source[field];
  const prompt = String(systemPrompt || '');
  const mentioned = id => new RegExp(`(?<![A-Z0-9_])${id}(?![A-Z0-9_])`).test(prompt);
  const blocked = id => Boolean(id) && (engineFactTemplateIds.has(id) || (internalTemplateIds.has(id) && !modelAllowedInternalIds.has(id) && !mentioned(id)));
  const templateId = String(clean.template_id ?? '').trim();
  if (blocked(templateId)) {
    console.warn(`Mô hình trả mẫu nội bộ ${templateId}: đổi về GENERAL_INFO`);
    clean.template_id = 'GENERAL_INFO';
  }
  if (blocked(String(clean.also ?? '').trim())) delete clean.also;
  return clean;
}

/**
 * The template inventory as text for the model, appended to the system
 * prompt on every request next to the catalogue. Built from Thiết lập tin
 * nhắn, so a template added, renamed or switched off there changes what the
 * model may answer with — nothing about templates has to be typed into the
 * prompt itself.
 */
export function buildTemplatePrompt(templates = {}, basePrompt = '', { compact = false } = {}) {
  // The opening words of the template, syntax stripped: enough for the model to tell the ids apart.
  // Đoạn đầu có chữ (bỏ qua đoạn chỉ có {images}), gọn syntax.
  const gist = text => (String(text).split('###')
    .map(segment => segment.replace(/\[\[[^\]]*\]\]|\[\?[a-z_0-9]+\]|\[\/\?\]/gi, '').replace(/\{[a-z_0-9]+\}/gi, '…').trim())
    .find(segment => /\p{L}/u.test(segment)) || '')
    .replace(/^Dạ,? ?(em |mình )?/i, '').replace(/\s+/g, ' ').trim().match(/^.{0,47}(?=\s|$)/u)?.[0] || '';
  // Tiết kiệm token: mẫu mà prompt đã nêu cách dùng thì chỉ liệt kê mã; mẫu
  // prompt chưa nhắc (chủ shop tự thêm) mới kèm vài chữ đầu để model hiểu.
  const mentioned = id => new RegExp(`\\b${id}\\b`).test(String(basePrompt || ''));
  const usable = Object.entries(templates)
    .filter(([id, text]) => text && !internalTemplateIds.has(id) && !id.startsWith('FOLLOW_UP_') && !isProductQuoteId(id));
  if (!usable.length) return '';
  const orderSteps = [
    ['ORDER_ADDRESS', 'muốn mua, thiếu SĐT/địa chỉ'],
    ['ORDER_CONFIRMATION', 'muốn mua, đủ sản phẩm+số lượng+SĐT+địa chỉ'],
    ['ORDER_UPDATE', 'khách sửa đơn vừa xác nhận: giỏ ĐẦY ĐỦ mới, không tạo đơn mới'],
    ['ORDER_CANCEL', 'khách muốn hủy đơn vừa đặt'],
    ['CSKH_HANDOFF', 'cần người thật']
  ];
  // Bản cũ (mặc định): liệt kê lại mọi mã (A/B 25/09: bỏ danh sách này cùng các
  // phần gọn khác làm mô hình "suy nghĩ" nhiều hơn — chưa bật).
  if (!compact) {
    const known = [...usable.map(([id]) => id), ...orderSteps.map(([id]) => id)].filter(mentioned);
    return [
      ...(known.length ? [`MẪU TIN: ${known.join(', ')}`] : ['MẪU TIN (template_id → ý nghĩa):']),
      ...usable.filter(([id]) => !mentioned(id)).map(([id, text]) => `- ${id}: ${gist(text)}`),
      ...orderSteps.filter(([id]) => !mentioned(id)).map(([id, meaning]) => `- ${id}: ${meaning}`),
      'PRICE_QUOTE dùng cho mọi sản phẩm (kèm Product_N1).'
    ].join('\n');
  }
  // Mẫu prompt đã nêu cách dùng thì không liệt kê lại (danh sách mã lặp ~640 ký
  // tự mỗi lượt gọi); chỉ mô tả mẫu chủ shop tự thêm mà prompt chưa nhắc.
  const unmentioned = [
    ...usable.filter(([id]) => !mentioned(id)).map(([id, text]) => `- ${id}: ${gist(text)}`),
    ...orderSteps.filter(([id]) => !mentioned(id)).map(([id, meaning]) => `- ${id}: ${meaning}`)
  ];
  return [
    ...(unmentioned.length ? ['MẪU TIN (template_id → ý nghĩa):', ...unmentioned] : []),
    ...(mentioned('PRICE_QUOTE') ? [] : ['PRICE_QUOTE dùng cho mọi sản phẩm (kèm Product_N1).'])
  ].join('\n');
}

/**
 * Turns the model's answer into the messages to send. `templates` is the
 * messageTemplates block of the chatbot settings — the only place text comes
 * from. A template whose text is blank is switched off: the bot hands over
 * to a person instead of guessing.
 */
// Mẫu không được dùng làm ý phụ ("also"): bước đơn, chuyển người, lời chào/cảm ơn.
const alsoBlocked = new Set(['CSKH_HANDOFF', 'WELCOME', 'THANK_YOU', 'IMAGE_RECEIVED', 'REPLY_ALREADY_SENT', 'CALLBACK_REQUEST', 'GENERAL_INFO', 'ASK_FLAVOR', 'ASK_PRODUCT']);

/**
 * Khách vừa đặt vừa hỏi ("cho chị 1 bịch vàng, bịch này có yến mạch không"):
 * mô hình chọn bước đơn ở template_id và câu hỏi kèm ở "also". Ý phụ là mẫu
 * thông tin có thật; đi trước câu xin SĐT/địa chỉ, sau câu trả lời thông tin.
 */
export function renderChatbotReply(value = {}, templates = {}, context = {}) {
  const main = renderSingleReply(value, templates, context);
  const also = String(value?.also || '').trim();
  if (!also || also === '0' || also === main.templateId || also.startsWith('ORDER_') || alsoBlocked.has(also) || main.handoff) return main;
  if (!templates[also] && !catalogRenderers[also] && !isProductQuoteId(also)) return main;
  const extra = renderSingleReply({ template_id: also, Product_N1: value.Product_N1 }, templates, context);
  if (extra.handoff || extra.templateId !== also && !isProductQuoteId(also)) return main;
  // Ý phụ vừa gửi trong 30 phút (bảng giá vừa gửi…): không gửi lại cả bảng/ảnh.
  const squash = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const opening = squash(extra.messages[0]);
  // Vòng 11 (E3): đang giữ giỏ mà khách hỏi lại (ý phụ là câu trả lời chính của lượt, bước đơn chỉ còn là câu
  // nhắc): không bỏ câu trả lời vì "vừa gửi < 30 phút" — khách hỏi lại tức là cần nghe lại.
  const heldBasket = isOrderStep(main.templateId) && Boolean(usablePendingOrder(context.pendingOrder, { now: Number(context.now) || Date.now(), templateId: 'ORDER_ADDRESS' })?.items?.length);
  if (!heldBasket && opening && (context.recentOutgoing || []).some(text => squash(text).startsWith(opening.slice(0, 40)) || String(text).replace(/\s+/g, ' ').includes(opening))) return main;
  const partsOf = reply => reply.parts || [...reply.messages.map(text => ({ type: 'text', text })), ...(reply.images || []).map(url => ({ type: 'image', url }))];
  const first = isOrderStep(main.templateId) || main.templateId === 'ORDER_CUSTOM_BASKET' ? [extra, main] : [main, extra];
  return {
    ...main,
    messages: [...first[0].messages, ...first[1].messages],
    parts: [...partsOf(first[0]), ...partsOf(first[1])],
    images: [...(first[0].images || []), ...(first[1].images || [])],
    alsoTemplateId: extra.templateId,
    // Hai phần riêng: engine (giữ giỏ + khách hỏi) gửi câu trả lời + câu nhắc ngắn thay cho cả đoạn xin SĐT/địa chỉ.
    alsoPart: { templateId: extra.templateId, messages: extra.messages, images: extra.images || [], parts: partsOf(extra) }
  };
}

function renderSingleReply(value = {}, templates = {}, context = {}) {
  activeCustomer = context.customer || {};
  activeLivestream = context.livestream === true;
  activeRecentOrder = context.recentOrder || null;
  const templateId = String(value.template_id || '').trim();
  // Khách xin đổi quà ("đổi quà khác được không", "bát gáo dừa có rồi"): mô hình hay chọn
  // GIFT_POLICY và bot kể lại bảng quà, không trả lời. Nay: nhận yêu cầu, gắn thẻ cho nhân
  // viên chọn quà thay, ghi vào đơn đang mở (29/09: nhân viên hứa đổi quà mà đơn không ghi,
  // khách nhận thiếu quà). Giỏ đang giữ thì giữ nguyên (không đặt pendingOrder).
  if (templateId === 'GIFT_POLICY' && templates.GIFT_SWAP && isGiftSwapRequest(context.messageText)) {
    const recent = context.recentOrder || null;
    const now = Number(context.now) || Date.now();
    const open = Boolean(recent?.id) && now - (Number(recent.createdAt) || 0) < orderCancelWindowMs && String(recent.processingStatus || '') !== 'cancelled' && recent.status !== 'Hủy';
    const note = `Khách xin đổi quà: ${String(context.messageText || '').replace(/\s+/g, ' ').trim().slice(0, 150)}`;
    return {
      templateId: 'GIFT_SWAP',
      ...splitMessages(fill(templates.GIFT_SWAP, commonValues())),
      handoff: false,
      attention: true,
      ...(open ? { order: { noteOrderId: String(recent.id), note } } : {})
    };
  }
  // Khách dặn thêm cho đơn vừa đặt (hàng mới, giờ giao, gọi trước): ghi chú vào
  // đúng đơn đó, trả lời ngắn. Không có đơn đang mở thì kể trạng thái như thường.
  if (templateId === 'ORDER_NOTE') {
    const recent = context.recentOrder || null;
    const now = Number(context.now) || Date.now();
    const shipped = /đã giao|đang giao|đã gửi/i.test(String(recent?.status || ''));
    const open = Boolean(recent?.id) && now - (Number(recent.createdAt) || 0) < orderCancelWindowMs && !shipped && String(recent.processingStatus || '') !== 'cancelled';
    if (!open || !templates.ORDER_NOTE_ADDED) return renderSingleReply({ template_id: 'ORDER_STATUS' }, templates, context);
    const note = String(context.messageText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const fresh = /\b(hang moi|date|han (su dung |dung )?|moi san xuat)/.test(normalizeText(note)) ? '1' : '';
    return {
      templateId: 'ORDER_NOTE',
      ...splitMessages(fill(templates.ORDER_NOTE_ADDED, { ...commonValues(), fresh })),
      handoff: false,
      order: { noteOrderId: String(recent.id), note }
    };
  }
  // Khách hủy đơn vừa đặt (dưới 24 giờ, chưa giao): hủy đúng đơn đó; đơn cũ hơn
  // hay đã giao thì nhân viên xử lý (CSKH_HANDOFF).
  if (templateId === 'ORDER_CANCEL') {
    const recent = context.recentOrder || null;
    const now = Number(context.now) || Date.now();
    // "Hủy đơn" lần hai ngay sau khi bot vừa hủy (đơn mới nhất đã hủy trong 30 phút, hay mẫu vừa gửi là
    // ORDER_CANCEL): đáp "đã hủy rồi", không hủy tiếp đơn cũ hơn còn giao (recentOrder ưu tiên đơn chưa hủy).
    const latest = context.latestOrder || null;
    const latestCancelled = Boolean(latest?.id) && (String(latest.processingStatus || '') === 'cancelled' || latest.status === 'Hủy')
      && (now - (Number(latest.cancelledAt) || Number(latest.updatedAt) || Number(latest.createdAt) || 0) < 30 * 60 * 1000 || context.lastTemplateId === 'ORDER_CANCEL');
    if (latestCancelled && templates.ORDER_CANCELLED) {
      const items = (Array.isArray(latest.products) ? latest.products : []).map(item => `${item.name || item.product || 'sản phẩm'} x${Number(item.quantity) || 1}`).join(', ') || 'vừa đặt';
      return { templateId: 'ORDER_CANCEL', ...splitMessages(fill(templates.ORDER_CANCELLED, { ...commonValues(), items })), handoff: false };
    }
    const shipped = /đã giao|đang giao|đã gửi/i.test(String(recent?.status || ''));
    const ageMs = now - (Number(recent?.createdAt) || 0);
    const open = Boolean(recent?.id) && recent.source !== 'POS' && !shipped && String(recent.processingStatus || '') !== 'cancelled' && recent.status !== 'Hủy';
    // C4 (01/10): bot chỉ tự hủy trong 60 phút như luật (rule-intent ORDER_CANCEL) — sau đó kho có thể đã đóng gói
    // / đơn đã lên POS. Trước đây mô hình chọn ORDER_CANCEL thì cửa sổ là 24 giờ, nên "thôi chị không lấy nữa" với
    // đơn 5 giờ bị hủy luôn cả trên POS. Quá 60 phút (≤ 7 ngày): ghi nhận + ghi chú vào đơn + thẻ cho nhân viên.
    const cancellable = open && ageMs < orderUpdateWindowMs;
    if (cancellable && templates.ORDER_CANCELLED) {
      const items = (Array.isArray(recent.products) ? recent.products : []).map(item => `${item.name || item.product || 'sản phẩm'} x${Number(item.quantity) || 1}`).join(', ') || 'đơn vừa đặt';
      return { templateId: 'ORDER_CANCEL', ...splitMessages(fill(templates.ORDER_CANCELLED, { ...commonValues(), items })), handoff: false, pendingOrder: null, order: { cancelOrderId: String(recent.id) } };
    }
    if (open && ageMs < orderCancelStaffWindowMs && templates.ORDER_CANCEL_STAFF) {
      const said = String(context.messageText || '').replace(/\s+/g, ' ').trim().slice(0, 150);
      return {
        templateId: 'ORDER_CANCEL_STAFF',
        ...splitMessages(fill(templates.ORDER_CANCEL_STAFF, commonValues())),
        handoff: false,
        attention: true,
        order: { noteOrderId: String(recent.id), note: said ? `Khách xin hủy đơn: ${said}` : 'Khách xin hủy đơn' }
      };
    }
    if (recent && String(recent.processingStatus || '') === 'cancelled' && templates.ORDER_CANCELLED) {
      return { templateId: 'ORDER_CANCEL', ...splitMessages(fill(templates.ORDER_CANCELLED, { ...commonValues(), items: 'vừa đặt' })), handoff: false };
    }
    return renderChatbotReply({ template_id: recent ? 'CSKH_HANDOFF' : 'ORDER_STATUS', warming: recent ? '1' : '0' }, templates, context);
  }
  if (isOrderStep(templateId)) return renderOrder(value, templates, context);
  // Vòng 11 (P3): PRICE_QUOTE_COMBO là mẫu con của bảng giá (đơn vị "Combo"), chỉ điền được qua renderPriceQuote:
  // gọi thẳng kèm Product_N1 (luật cũ, mô hình) → soạn như PRICE_QUOTE, không gửi bảng giá trống.
  if (templateId === 'PRICE_QUOTE_COMBO' && String(value.Product_N1 || '').trim() && templates.PRICE_QUOTE) {
    return renderSingleReply({ ...value, template_id: 'PRICE_QUOTE' }, templates, context);
  }
  // Vòng 12 (B3 #23): PRICE_QUOTE_COMBO không kèm sản phẩm → bảng khung trống ("Combo Dùng Thử: ━━ …"): gửi bảng giá chung.
  if (templateId === 'PRICE_QUOTE_COMBO' && templates.GENERAL_INFO) return renderSingleReply({ template_id: 'GENERAL_INFO' }, templates, context);
  // Vòng 11 (V8/B21): khách chỉ gửi SĐT (chưa địa chỉ) → không nói "đã nhận SĐT và địa chỉ": mẫu riêng
  // ORDER_PHONE_ASK_FLAVOR (không có thì mẫu cũ), mã mẫu vẫn là ORDER_INFO_ASK_FLAVOR cho các bước sau.
  if (templateId === 'ORDER_INFO_ASK_FLAVOR' && String(value.Phone_Number || '').trim() && !String(value.Customer_Address || '').trim() && templates.ORDER_PHONE_ASK_FLAVOR) {
    return { templateId, ...splitMessages(fill(templates.ORDER_PHONE_ASK_FLAVOR, commonValues())), handoff: false };
  }
  const catalogId = catalogRenderers[templateId] ? templateId : isProductQuoteId(templateId) ? 'PRICE_QUOTE' : '';
  if (catalogId && templates[catalogId]) {
    const text = catalogId === 'PRICE_QUOTE' ? renderPriceQuote(templateId, value, templates) : catalogRenderers[catalogId](value, templates);
    // Không soạn được (chưa sản phẩm nào có ảnh…): người thật tiếp.
    if (!text) return { templateId: 'CSKH_HANDOFF', ...splitMessages(fill(templates.CSKH_HANDOFF, commonValues())), handoff: true };
    return { templateId, ...splitMessages(text), handoff: false };
  }
  // Chữ gửi khách chỉ lấy từ mẫu trong Cài đặt; mã mẫu lạ (hay chữ tự soạn
  // của mô hình, mà khách có thể lái) đi về CSKH_HANDOFF thay vì phát nguyên văn.
  // Mã mẫu lạ (mô hình bịa): trả bảng giá chung, không chuyển người và tắt bot.
  if (!catalogId && !templates[templateId] && templateId !== 'CSKH_HANDOFF' && templates.GENERAL_INFO) {
    return { templateId: 'GENERAL_INFO', ...splitMessages(renderGeneralInfo(templates)), handoff: false };
  }
  const raw = (!catalogId && templates[templateId]) || templates.CSKH_HANDOFF;
  const resolvedId = !catalogId && templates[templateId] ? templateId : 'CSKH_HANDOFF';
  return {
    templateId: resolvedId,
    // `values`: số liệu engine đã có sẵn (giỏ Shop, tổng đơn POS…) cho mẫu tự do.
    ...splitMessages(fill(raw, { ...commonValues(), ...(value.values && typeof value.values === 'object' ? value.values : {}) })),
    // Khách xin gọi điện: nhân viên phải gọi thật, nên vẫn chuyển người (kèm lời hẹn rõ).
    handoff: resolvedId === 'CSKH_HANDOFF' || resolvedId === 'CALLBACK_REQUEST'
  };
}
