import { describeGiftTable, priceBasket, quoteTiers, shippingFeeForKey } from './processing/pricing.mjs';
import { applyGiftSwap, comboKey, findProductBySku, getCatalogProducts, getGifts, getShippingFee, giftsForKey, isFreeShippingGift, listCombos, matchProduct, matchStaffOnlyProduct, maxComboQuantity, normalizeGiftSwapChoices, normalizeText } from './processing/catalog.mjs';
import { PROMO_BOWL_GIFT } from './processing/trial-flow.mjs';
import { giftOverrideItemText, normalizeGiftOverride } from './gift-override.mjs';
import { metaConfig } from './config.mjs';
import { orderKey as buildOrderKey, toPricedItems } from './processing/order-key.mjs';
import { isOrderStep, usablePendingOrder } from './processing/pending-order.mjs';
import { extractVietnamesePhone, toLocalPhone } from './processing/customer-info.mjs';
import { dedupeAddressSegments, describeDeliveryAddress, mergeAddressFragment } from './processing/locations.mjs';
import { cleanAddressText, extractDeliveryNote, isPaymentMessage, mentionsOldAddress } from './processing/order-flow.mjs';
import { countBags, normalizeIntentText } from './processing/intent-features.mjs';
// Vòng 13: một nơi sửa lỗi gõ màu / nhận tin chỉ nêu số lượng — dùng chung với bộ luật.
import { normalizeColourTypos, quantityOnlyRequest } from './processing/rule-intent.mjs';

// The bot asks for a missing or ambiguous part of the address at most this
// many times, then lets the order through with what it has (flagged on the
// order) rather than trapping the customer in a loop.
// Vòng 12: hỏi lại tối đa MỘT lần; khách trả lời gì thì nhận nguyên chữ khách ghi, đơn mang ghi chú
// để nhân viên soát phường/xã (khách bỏ đi khi bị hỏi từng cấp lần 2, lần 3).
export const maxAddressAsks = 1;
import { LEGACY_SHIPMENT_TEMPLATES, shipmentStage, shipmentTemplateValues } from './shipment-stage.mjs';
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

// Tệp mẫu gốc chỉ đổi khi deploy (khởi động lại): đọc + parse một lần, mỗi lần gọi trả bản sao riêng.
let seedTemplates = null;

/** The shipped default texts — used only to seed settings that have none. */
export function defaultMessageTemplates() {
  seedTemplates ||= JSON.parse(readFileSync(seedPath, 'utf8'));
  return structuredClone(seedTemplates);
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
const giftSwapPattern = /\b(qua (gi|j|nao|khac) (de )?thay|thay cho (bo |cai )?(bat|chen|gao dua|muong)|(doi|thay|chon|lay) (phan )?qua(?! (tui|goi|hop|bich|xanh|vang|nau|loai|vi|cacao|\d))|qua (tang )?khac|tang (c|chi|e|em|a|anh|minh)? ?(cai|mon|thu)? ?khac|(khong|ko|k|hong|kg) (lay|can|muon|thich) (bo |cai )?(bat|chen|gao dua|muong|qua)|(bat|chen|gao dua|muong dua)( [a-z]+){0,4} (co roi|du roi|nhieu roi|dung roi)|(bat(?! (dau|buoc|duoc|ky|len|tat|may|den|loa|che|mi))|chen(?! (ngang|vao|lan))|gao dua|muong)( [a-z]+){0,4} (khong|ko|k|kg|hong|hok) (lay|can|nhan|thich|dung|muon)(?! (them|nua|hang|don|tui|goi|hop)))\b/;
// R16 (inbox1 A7, ca …9053175659 "Bộ bát + muỗng dừa chị ko lấy đâu"): món quà đứng TRƯỚC, phủ định đứng SAU ("bát … ko lấy",
// "bát gáo dừa thì mình k cần") cũng là xin đổi/bỏ quà (nhánh cuối) — trước đây chỉ bắt "không lấy bát". "bắt đầu / bật / chen
// ngang" bỏ dấu cũng là "bat/chen" nên loại; "… không lấy thêm/nữa/hàng/đơn" là chuyện khác, không phải quà.
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
// Vòng 13 (inbox2 A4): địa chỉ mới CHỨA địa chỉ của đơn và thêm số nhà / tên khu ("LK B52 MB 3830 Khu Đô Thị Mới Đông
// Sơn - An Hưng - Thanh Hoá" gửi sau khi đơn chỉ có "…Phường An Hưng, Thành phố Thanh Hóa") là khách BỔ SUNG địa chỉ →
// phải sửa đơn, không trả "đơn đã lên rồi". Chữ thừa không mang thông tin (ấp/số/nhà/đường…, "(Live)") thì vẫn coi như cũ.
const ADDRESS_FILLER = new Set(['ap', 'so', 'nha', 'duong', 'pho', 'thon', 'xom', 'to', 'khu', 'ngo', 'hem', 'xa', 'phuong', 'quan', 'huyen', 'tinh', 'thanh', 'tp', 'thi', 'tran', 'live', 'freeship', 'dc', 'dia', 'chi', 'nhe', 'nha', 'a', 'viet', 'nam', 'vn']);
function addsAddressDetail(orderAddress, nextAddress) {
  const words = value => new Set(normalizeText(value).split(/[^a-z0-9]+/).filter(Boolean));
  const old = words(orderAddress);
  const next = words(nextAddress);
  if (!old.size || !next.size || ![...old].every(word => next.has(word) || ADDRESS_FILLER.has(word))) return false;
  const extras = [...next].filter(word => !old.has(word) && !ADDRESS_FILLER.has(word));
  return extras.some(word => /\d/.test(word)) || extras.length >= 2;
}
function unchangedOrder(recentOrder, orderItems, phone, address) {
  if (!recentOrder || basketSignature(recentOrder.products) !== basketSignature(orderItems)) return false;
  const phoneOf = value => toLocalPhone(value) || String(value || '').replace(/\D/g, '');
  return phoneOf(recentOrder.phone) === phoneOf(phone) && sameAddressText(recentOrder.address, address) && !addsAddressDetail(recentOrder.address, address);
}
/**
 * R15 (inbox3 A5): tin khách có SĐT KHÁC SĐT của đơn, hay địa chỉ (mô hình đọc ra, và chữ đó thật sự nằm trong tin khách)
 * KHÁC địa chỉ của đơn. Không có đơn / tin không có SĐT hay địa chỉ → false.
 * @param {object|null} order đơn gần nhất (phone, address, rawAddress)
 * @param {string} text tin khách
 * @param {string} [modelAddress] Customer_Address mô hình trả
 */
export function contactDiffersFromOrder(order, text, modelAddress = '') {
  if (!order) return false;
  const phoneOf = value => toLocalPhone(value) || String(value || '').replace(/\D/g, '');
  const textPhone = extractVietnamesePhone(String(text || ''));
  if (textPhone && order.phone && phoneOf(textPhone) !== phoneOf(order.phone)) return true;
  const typed = String(modelAddress || '').trim();
  if (!typed || typed === '0' || !(order.address || order.rawAddress)) return false;
  // Chữ địa chỉ mô hình trả phải có trong tin khách (≥ 60% số chữ), không thì là địa chỉ mô hình chép từ lịch sử.
  const words = normalizeText(typed).split(/[^a-z0-9]+/).filter(word => word.length > 1);
  const said = new Set(normalizeText(String(text || '')).split(/[^a-z0-9]+/).filter(Boolean));
  if (words.length < 2 || words.filter(word => said.has(word)).length < Math.ceil(words.length * 0.6)) return false;
  return ![order.rawAddress, order.address].filter(Boolean).some(old => sameAddressText(old, typed) && !addsAddressDetail(old, typed));
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
// R14 (C7a/M3/M7, 9 ca thật 02–03/10): tên người nhận đứng đầu địa chỉ TRÙNG tên Facebook của khách ("Kim van ấp 6…" —
// khách Kim Van; "Vũ Hoàng Anh Cụm Công nghiệp…" — Hoàng Anh; "Nguyễn Ngọc Lâm, Saigon Royal…" — Lam Ngoc Nguyen; "Lại
// Liên, xóm 11…"; "Oanh Vy Thôn…"). Cụm đầu = các chữ trước dấu phẩy / từ chỉ nơi chốn / chữ số đầu tiên, 2–4 chữ, không
// chữ nào là từ địa chỉ. Bỏ khi: ≥2 chữ trùng tên hồ sơ (không kể thứ tự, không dấu), hoặc cụm mở bằng họ + chữ cuối trùng
// chữ cuối tên hồ sơ ("Đinh Huyền tk…" — Diệu Huyền). Phần còn lại phải còn chữ.
// Từ chỉ nơi chốn, so CÒN DẤU (bỏ dấu thì "Huyền"/"huyện", "Phương"/"phường", "Dương"/"đường", "Tình"/"tỉnh" trùng nhau).
// Chữ khách gõ không dấu thì so với bản không dấu, bỏ các chữ trùng tên người.
const LEAD_STOP_WORDS = new Set(['thôn', 'ấp', 'xóm', 'số', 'sn', 'khu', 'kp', 'tk', 'tdp', 'cụm', 'đường', 'ngõ', 'ngách', 'hẻm', 'kiệt', 'trường', 'nhà', 'cty', 'ubnd', 'chung', 'cc', 'tòa', 'toà', 'phường', 'xã', 'huyện', 'tỉnh', 'tp', 'p', 'q', 'f', 'x', 'h', 'tt', 'tx', 'block', 'thửa', 'lô', 'tầng', 'quận', 'thị trấn']);
const LEAD_STOP_ASCII = new Set(['thon', 'ap', 'xom', 'so', 'sn', 'khu', 'kp', 'tk', 'tdp', 'cum', 'ngo', 'ngach', 'hem', 'kiet', 'nha', 'cty', 'ubnd', 'chung', 'cc', 'toa', 'xa', 'tp', 'p', 'q', 'f', 'x', 'h', 'tt', 'tx', 'block', 'thua']);
const SURNAME_KEYS = new Set(surnames.split('|').map(name => normalizeText(name)));
function stripProfileName(text, profileName) {
  const profile = normalizeText(profileName).split(/[^a-z0-9]+/).filter(Boolean);
  if (profile.length < 2) return text;
  // Cụm đầu: dừng ở dấu ngăn, chữ số hay từ chỉ nơi chốn đầu tiên.
  // Mỗi chữ của cụm đầu kèm vị trí kết thúc; cụm tên có thể dính liền tên tòa nhà ("Nguyễn Ngọc Lâm Saigon Royal…").
  const words = [];
  let offset = 0;
  const tokens = [...String(text).matchAll(/([\p{L}]+)|([^\p{L}]+)/gu)];
  for (const token of tokens) {
    if (token[2]) {
      if (/[,.;:\-–\n\d(]/u.test(token[2])) break;
      offset += token[0].length;
      continue;
    }
    const lower = token[1].normalize('NFC').toLowerCase();
    if (LEAD_STOP_WORDS.has(lower) || (/^[a-z]+$/.test(lower) && LEAD_STOP_ASCII.has(lower))) break;
    offset += token[0].length;
    words.push({ key: normalizeText(token[1]), end: offset });
    if (words.length >= 6) break;
  }
  const profileSet = new Set(profile);
  // Cụm tên dài nhất (2–4 chữ, kết thúc bằng một chữ của tên hồ sơ) khớp tên hồ sơ.
  for (let size = Math.min(4, words.length); size >= 2; size -= 1) {
    const lead = words.slice(0, size).map(word => word.key);
    if (!profileSet.has(lead.at(-1))) continue;
    const overlap = lead.filter(word => profileSet.has(word)).length;
    const surnameLast = size === words.length && SURNAME_KEYS.has(lead[0]) && size <= 3 && lead.at(-1) === profile.at(-1) && !profileSet.has(lead[0]) && overlap === 1;
    const sameName = overlap >= 2 && (overlap >= Math.min(profile.length, size) || overlap >= size - 1);
    if (!sameName && !surnameLast) continue;
    const rest = String(text).slice(words[size - 1].end).replace(/^[\s,.;:\-–]+/u, '');
    if (!/\p{L}/u.test(rest)) return text;
    // Cụm đó có thể là TÊN ĐƯỜNG trùng tên khách ("Nguyễn Văn Linh, Q7" — khách Linh Nguyễn): phần còn lại phải còn số nhà /
    // thôn / ấp… (bộ đọc địa chỉ không báo thiếu đường).
    if (describeDeliveryAddress(rest).missing?.includes('street')) return text;
    return rest;
  }
  return text;
}

export function stripReceiverName(address, profileName = '') {
  const text = profileName ? stripProfileName(String(address || ''), profileName) : String(address || '');
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

/** Combo 2 không tặng yến mạch, chỉ tặng quà live. */
function withOatsGift(price, on) {
  return price;
}

function withPromoFreeShipping(price) {
  const gifts = [{ name: 'Miễn phí vận chuyển – ưu đãi dùng thử', sku: '', minQuantity: 1, active: true }, ...price.gifts.filter(gift => !isFreeShippingGift(gift))];
  return { ...price, total: price.total - price.shippingFee, shippingFee: 0, gifts, gift: gifts.map(gift => gift.name).join(' + ') };
}

/**
 * Vòng 13: lựa chọn đổi quà đi theo giỏ chờ. `pendingOrder.giftSwap` là mảng lựa chọn của parseGiftSwapChoice (rỗng =
 * khách xin đổi nhưng chưa nêu vị; `true` cũng coi là rỗng). Không có trường → null (không đổi quà).
 * @returns {Array<{id:string,label:string,name:string,sku:string,weight:number}>|null}
 */
export function heldGiftSwap(pendingOrder) {
  const raw = pendingOrder?.giftSwap;
  if (raw === true) return [];
  return Array.isArray(raw) ? normalizeGiftSwapChoices(raw) : null;
}

/**
 * Vòng 13: áp đổi quà vào bộ giá của giỏ (kết quả priceBasket / withPromoBowl…). Giỏ không có quà hiện vật đổi được
 * (1–2 túi khách thường) hay `choices` null → trả nguyên. Có: bỏ bát/muỗng/quạt, thêm MỘT dòng quà gộp
 * ("1 Gói granola nhỏ Xanh 35g + 1 Gói granola nhỏ Cam 30g"), tiền không đổi; `giftSwap` = { choices, removed, added, text }
 * (added giữ từng gói kèm SKU cho kho/POS).
 */
export function withGiftSwap(price, choices) {
  if (!price || !Array.isArray(choices)) return price;
  const swapped = applyGiftSwap(price.gifts || [], choices);
  if (!swapped.removed.length || !swapped.added.length) return price;
  const kept = swapped.gifts.filter(gift => !gift.swap);
  const gifts = [...kept, { id: 'gift-swap', name: swapped.text, sku: '', weight: swapped.added.reduce((sum, gift) => sum + (Number(gift.weight) || 0), 0), active: true, swap: true }];
  return {
    ...price,
    gifts,
    gift: gifts.map(gift => gift.name).join(' + '),
    giftSwap: { choices: choices.map(option => ({ ...option })), removed: swapped.removed.map(gift => gift.name), added: swapped.added, text: swapped.text }
  };
}

/**
 * 05/10: quà CHỌN TAY đi theo giỏ chờ (`pendingOrder.giftOverride` — bot đổi quạt → muỗng dừa cho khách live). Chỉ giữ khi
 * giỏ (giá gốc) còn được quà live: khách đổi sang giỏ khác (3 túi, 1 túi…) thì quà lại theo bảng quà.
 */
export function heldGiftOverride(pendingOrder, price = null) {
  const list = normalizeGiftOverride(pendingOrder?.giftOverride);
  if (!list.length) return null;
  if (price && !(price.gifts || []).some(gift => gift?.livestreamOnly)) return null;
  return list;
}

/** 05/10: áp quà chọn tay vào bộ giá của giỏ: giữ dòng miễn ship, thay mọi quà hiện vật bằng danh sách; tiền không đổi. */
export function withGiftOverride(price, list) {
  if (!price || !Array.isArray(list) || !list.length) return price;
  const gifts = [...(price.gifts || []).filter(isFreeShippingGift), ...list.map(item => ({ id: item.giftId || 'gift-override', name: giftOverrideItemText(item), sku: item.sku, weight: item.weight, active: true, override: true }))];
  return { ...price, gifts, gift: gifts.map(gift => gift.name).join(' + '), giftOverride: list.map(item => ({ ...item })) };
}

/** Trường đơn hàng khi giỏ đã đổi quà: chữ quà ghi rõ "thay …" cho nhân viên/kho, kèm lựa chọn để POS lên đúng dòng quà. */
function giftSwapOrderFields(price) {
  // 05/10: quà chọn tay → đơn mang giftOverride (POS / kho lên đúng danh sách; chữ quà dựng ở normalizeChatbotOrder).
  if (price?.giftOverride) return { giftOverride: price.giftOverride.map(item => ({ ...item })) };
  if (!price?.giftSwap) return {};
  return {
    gift: `${price.gift} (đổi quà: thay ${price.giftSwap.removed.join(' + ')})`,
    giftSwap: price.giftSwap.added.map(gift => ({ name: gift.name, sku: gift.sku, weight: gift.weight })),
    giftSwapRemoved: price.giftSwap.removed
  };
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
// Vòng 13: "ca cao 300g" / "cacao 300" là Granola Tropical vị Cacao 300g, không phải Túi Nâu cacao 350g.
const NOT_TROPICAL = '(?!\\s*300)';
const colourOfItem = item => (String(item?.code || item?.sku || '').toUpperCase().match(/^GRA-(XANH|VANG|NAU)-/) || [])[1] || '';
const numberOf = word => NUMBER_WORD[word] ?? (Number(word) || 0);
// Có nhắc tới hàng/giỏ không (màu, số túi, tên sản phẩm).
const BASKET_WORDS = /\b(tui|tuy|goi|bich|bit|hop|combo|xanh|vang|nau|cacao|mint|tropical|granola|yen mach|vi|loai|mau|\d{1,2} ?(t|b))\b/;
const ORDER_VERBS = /\b(lay|dat|mua|chot|gui|ship|cho|order|len don|an)\b/;
const QUESTION = /\?|\b(nao|gi|j|sao|khong|ko|hong|hok|k|chua|ha|hem)\s*(vay|v|z|ta|nhi|the|a|ha|shop|em|e|c|chi|ad)?\s*$|\b(loai nao|vi nao|mau nao|tui nao|cai nao|la gi|nhu nao|the nao|ntn|bao nhieu|bn)\b/;

// ===== Vòng 13 (02/10): giỏ Facebook Shop, lỗi gõ màu, "lấy 2 mà" =====

// Chữ CRM tự sinh cho tin giỏ Facebook Shop (pancake.mjs: "Khách chọn mua từ Facebook Shop: <tên> (<SKU>) — giá").
// Không phải lời khách: không được đem đếm màu/số túi (mã "CB-VANGG+XANH" chỉ khớp chữ XANH → giỏ còn 1 Túi Xanh).
const SHOP_CART_TEXT = /^\s*khách chọn mua từ facebook shop(?![\p{L}\p{N}])/iu;
/** Tin giỏ Facebook Shop do CRM tự sinh (không phải lời khách gõ). */
export function isShopCartText(text) {
  return SHOP_CART_TEXT.test(String(text ?? '').normalize('NFC'));
}

/**
 * Chữ khách đã sửa lỗi gõ tên vị, để đếm màu/số túi: MỘT nguồn là normalizeColourTypos (processing/order-flow.mjs, xuất
 * lại ở rule-intent.mjs) — "1 túi vành" → vàng, "2ca cao" → "2 cacao", "vag/vangf/vangd", "naau", "câco", "xah"…;
 * "vâng" (dạ vâng) và "nấu" (nấu sữa hạt) không phải vị Vàng / Nâu, TRỪ "vâng" đứng ngay sau số hay túi/gói/bịch/màu/vị/loại
 * ("Túi vâng" = gõ nhầm dấu của Túi Vàng). R13 (gộp): bỏ phần lọc riêng ở đây — nó xoá "vâng" trước khi tới phần chung nên
 * "Túi vâng" mất vị.
 * @param {string} text
 * @returns {string}
 */
function colourText(text) {
  return normalizeColourTypos(String(text ?? ''));
}

/**
 * R14 (…958786): tên vị theo đặc điểm, trên chữ ĐÃ bỏ dấu — "cân bằng" là Túi Xanh ("1 Granola cân bằng"), "nhiều hạt" là
 * Túi Vàng — trừ khi đứng cạnh một màu ("Túi Vàng nhiều hạt", "xanh cân bằng") hay là lời tả ("có nhiều hạt", "nhiều hạt
 * hơn"). "nguyên bản" KHÔNG đổi: Xanh và Vàng đều được gọi là nguyên bản → bộ soạn đơn hỏi lại (ASK_FLAVOR_NGUYENBAN).
 * @param {string} s chữ đã normalizeIntentText
 */
export function flavourSynonyms(s) {
  return String(s ?? '')
    .replace(/(?<!\b(?:xanh|vang|nau|cacao|co|it|hon|la) )\bcan bang\b(?! (?:xanh|vang|nau|hon|khong|ko|k|ha|chua|dinh duong))/g, 'xanh')
    .replace(/(?<!\b(?:xanh|vang|nau|cacao|co|it|hon|la|kha|rat|qua|cung) )\bnhieu hat\b(?! (?:xanh|vang|nau|hon|qua|khong|ko|k|ha|the|vay|nhat))/g, 'vang');
}

// Chữ khách nêu "nguyên bản" mà không kèm Xanh/Vàng ("1 túi nâu 1 túi nguyên bản"): số túi phần nguyên bản (≥ 1), 0 nếu
// không mơ hồ. Câu hỏi ("nguyên bản là gì") để mô hình trả lời.
function ambiguousNguyenBan(text) {
  const s = normalizeIntentText(colourText(text));
  if (!/\bnguyen ban(?:g)?\b/.test(s)) return 0;
  if (/\b(?:xanh|vang)(?: la| (?:tui|goi|loai|vi))? nguyen ban|\bnguyen ban(?:g)? (?:xanh|vang|450|350)\b|\bnguyen ban(?:g)? (?:la )?(?:gi|sao|the nao|ntn|nhu nao)\b|\?/.test(s)) return 0;
  // R15 sửa (phản biện luật #4): "nguyên bản" là lời tả của chính món Xanh/Vàng đứng trước, cách ≤ 3 chữ không xen chữ nối / số
  // túi mới ("Lấy 1 túi vàng 350g nguyên bản nha", "1 túi vàng nhiều hạt nguyên bản"; "1 túi vàng và 1 túi nguyên bản" vẫn là
  // hai món), hay có phủ định ngay trước ("1 túi vàng thôi, không lấy nguyên bản") → không mơ hồ, không hỏi lại / thêm Xanh.
  if (/\b(?:xanh|vang)(?: (?!(?:va|voi|vs|them|cung|con|\d{1,2}|mot|hai|ba)\b)[a-z0-9]+){0,3} nguyen ban/.test(s)) return 0;
  if (/\b(?:khong|ko|k|kg|hong|dung|bo|chua)(?: (?:lay|can|mua|dat|chon|an))?(?: (?:tui|goi|bich|loai|vi|phan))? nguyen ban/.test(s)) return 0;
  const counted = s.match(/\b(\d{1,2}|mot|hai|ba)\s*(?:(?:tui|goi|bich|bit)\s+)?(?:(?:granola|vi|loai)\s+)?nguyen ban/);
  return counted ? numberOf(counted[1]) || 1 : 1;
}

/**
 * R15 (inbox1 A2, ca …8166458357 "Cho mình 1 túi nguyên bản và 1 túi vàng nhiều hạt nhé"): "nguyên bản" đứng cùng câu với
 * một món VÀNG khách nêu riêng (có số túi), không nhắc Xanh → phần nguyên bản là Túi Xanh (Vàng đã được nêu tên riêng),
 * không hỏi lại. Trả số túi Xanh (≥ 1), 0 khi không thuộc ca này ("1 túi nâu 1 túi nguyên bản" vẫn hỏi lại như R14).
 * @param {string} text
 */
export function nguyenBanMeansXanh(text) {
  const qty = ambiguousNguyenBan(text);
  if (!qty) return 0;
  // R15 sửa (phản biện luật #4): cụm Vàng / phủ định đã loại ở ambiguousNguyenBan; thêm: "nguyên bản" phải có số túi RIÊNG
  // ("1 túi nguyên bản và 1 túi vàng nhiều hạt" có; "túi vàng, nguyên bản nhé" không) mới tự hiểu là Xanh.
  const s = normalizeIntentText(colourText(text));
  if (!/\b(\d{1,2}|mot|hai|ba)\s*(?:(?:tui|goi|bich|bit)\s+)?(?:(?:granola|vi|loai)\s+)?nguyen ban/.test(s)) return 0;
  const { counts, mentioned } = colourCountsInText(text);
  return counts.VANG > 0 && !mentioned.includes('XANH') ? qty : 0;
}

/** Màu khách nêu kèm số túi trong tin ("2 xanh", "1 túi vàng 1 túi nâu", "túi xanh x2", "mỗi loại 1 túi"). */
export function colourCountsInText(text) {
  // Vòng 13: sửa lỗi gõ ("1 túi vành", "2ca cao") trước khi đếm; cho chữ đệm giữa đơn vị và màu ("2 túi hạt vàng",
  // "2 túi loại xanh", "1 gói granola nâu"). Không đơn vị thì chỉ nhận "màu/vị" như cũ ("2 loại xanh và vàng" là hai loại).
  // Vị khách nói KHÔNG lấy ("Vậy thôi đừng lấy ca cao nha mà lấy chị 2 túi xanh+ 1 túi vàng") không tính là vị được nhắc.
  // R13 sửa (phản biện T4): màu đứng ngay sau "số/tổ/ngõ/khu/ấp/thôn/hẻm/kp/đường + số" là địa danh ("tổ 2 Vàng Anh", "số 2 Vàng
  // Danh") — không đếm là túi (trước đây giỏ 2 Xanh thành 2 Vàng và địa chỉ mất "tổ 2 Vàng Anh").
  // R14: "cân bằng" = Xanh, "nhiều hạt" = Vàng (flavourSynonyms); "Ko fai 2 túi nâu" (khách đính chính giỏ sai) không tính.
  // R16 (inbox1 A2, ca …2228960004 "Vậy tổng là 5 túi, tặng 1 túi vàng + 1 bộ bát, thìa đúng ko shop"): màu đứng sau "tặng" là
  // QUÀ, không phải túi khách mua — không đếm, không tính là vị được nhắc.
  // R16-fix2 (phản biện M2): màu viết hoa sau dấu phẩy/xuống dòng và trước một chữ viết hoa khác là ĐỊA DANH ("2 túi xanh, Vàng Danh,
  // Uông Bí") — bỏ trước khi đếm (trừ khi chữ sau là lời tả vị: "Vàng Nhiều Hạt", "Xanh Nguyên Bản").
  const placeless = colourText(text).normalize('NFC').replace(/([,;\n]\s*)(?:Vàng|Xanh|Nâu|VÀNG|XANH|NÂU)(?=\s+(\p{Lu}\p{L}*))/gu, (whole, lead, next) => (
    /^(?:nhieu|hat|nguyen|ban|cacao|ca|tui|goi|bich|la|min|mint|nhat|nha|nhe|nhen|a|e|em|chi|c|anh|cho|voi|va|moi|thoi|luon|di|mot|hai|ba|x|nua|thi|de|co|khong|ko|het|lan)$/.test(normalizeIntentText(next)) ? whole : lead));
  const stripped = flavourSynonyms(normalizeIntentText(placeless))
    .replace(/\b(so|to|ngo|khu|ap|thon|hem|kp|duong|ngach|xom) (\d{1,3}) (?:xanh|vang|nau|cacao)\b/g, '$1 $2 ')
    .replace(new RegExp(`\\b(?:dung|khong|ko|hong)\\s+(?:lay|mua|gui)\\s+(?:(?:tui|goi|bich|vi|loai|mau)\\s+)?(?:xanh|vang|nau|cacao)\\b${NOT_GREEN}`, 'g'), ' ')
    .replace(/\b(?:khong|ko|k|kg|hong|kp|chu khong|chu ko)\s+(?:phai|fai|pai)\s+(?:la\s+)?(?:\d{1,2}|mot|hai|ba)?\s*(?:(?:tui|goi|bich|bit)\s+)?(?:xanh|vang|nau|cacao)\b/g, ' ')
    .replace(/\btang\s+(?:(?:kem|them|cho|c|chi|e|em|minh|a|anh)\s+)?(?:(?:\d{1,2}|mot)\s*)?(?:(?:tui|goi|bich|bit|hop)\s+)?(?:(?:mau|vi|loai)\s+)?(?:xanh|vang|nau|cacao)\b/g, ' ');
  // R16 (inbox1 A1, ca …9387140891 "Mua 2 túi nâu xanh"): MỘT số "N túi/gói/bịch" đứng trước danh sách ≥ 2 màu không kèm số
  // riêng (như R14 của commentBasket ở engine). N = số màu → mỗi màu 1 (1 Nâu + 1 Xanh 293k; trước đây số 2 gán cho màu đứng
  // ngay sau → 2 Nâu + 1 Xanh 437k). N khác số màu ("3 túi xanh vàng") → không tự chia: bỏ số khỏi màu đầu, trả `splitAsk` = N để
  // bộ soạn đơn hỏi lại vị (flavourSplitAsk). "mỗi loại 1" (each) đã nói rõ thì không áp. "hoặc" không phải danh sách.
  const listColour = `(?:xanh|vang|nau|cacao${NOT_TROPICAL})${NOT_GREEN}`;
  const listSep = '(?: (?:va|voi|vs|cung|mix|lan|ca))?(?: (?:tui|goi|loai|vi|mau))? ';
  const sharedList = new RegExp(`\\b(\\d{1,2}|hai|ba|bon|nam)\\s*(?:tui|tuy|goi|bich|bit)\\s+(?:(?:hat|loai|vi|mau|granola)\\s+)?(${listColour}(?:${listSep}${listColour}){1,3})\\b(?! ?x ?\\d)(?! \\d{1,2}\\b(?! ?(?:tui|tuy|goi|bich|bit|vi|loai|mau|xanh|vang|nau|cacao)\\b))`, 'g');
  let splitAsk = 0;
  const eachSaid = /\bmoi (?:loai|vi|mau|thu|tui|goi) (\d{1,2}|mot|hai|ba)\b|\b(\d{1,2}|mot|hai|ba) (?:tui|goi|bich) moi (?:loai|vi|mau)\b/.test(stripped);
  // R16-fix2 (phản biện L4): "3 túi xanh vàng, 2 xanh 1 vàng" / "4 túi xanh nâu, xanh 3 nâu 1" — khách tự chia ngay sau danh sách,
  // các số cộng đủ N → dùng đúng phần chia đó (không hỏi lại, không cộng dồn số N vào màu đầu).
  const spelledSplit = new RegExp(`\\b(\\d{1,2}|hai|ba|bon|nam)\\s*(?:tui|tuy|goi|bich|bit)\\s+(?:(?:hat|loai|vi|mau|granola)\\s+)?${listColour}(?:${listSep}${listColour}){1,3}\\s+((?:(?:\\d{1,2}|mot|hai|ba)\\s*(?:(?:tui|goi|bich)\\s+)?(?:xanh|vang|nau|cacao)\\b\\s*){2,4}|(?:(?:xanh|vang|nau|cacao)\\s*(?:\\d{1,2})\\b\\s*){2,4})`, 'g');
  const respelled = stripped.replace(spelledSplit, (whole, number, parts) => {
    const pairs = [...parts.matchAll(/(\d{1,2}|mot|hai|ba)\s*(?:(?:tui|goi|bich)\s+)?(xanh|vang|nau|cacao)|(xanh|vang|nau|cacao)\s*(\d{1,2})/g)]
      .map(match => (match[2] ? [numberOf(match[1]), match[2]] : [numberOf(match[4]), match[3]]));
    const total = pairs.reduce((sum, [count]) => sum + count, 0);
    return total === numberOf(number) ? ` ${pairs.map(([count, colour]) => `${count} ${colour}`).join(' ')} ` : whole;
  });
  const s = respelled.replace(sharedList, (whole, number, list, offset, all) => {
    const colours = [...new Set([...list.matchAll(/(xanh|vang|nau|cacao)/g)].map(match => COLOUR_OF_WORD[match[1]]))];
    if (colours.length < 2) return whole;
    // R16-fix2 (phản biện M2): sau danh sách là lời bỏ / hoãn / hỏi ("lấy 2 túi xanh, vàng thì thôi", "vàng để lần sau", "vàng có
    // không", "2 túi xanh vàng hết rồi à") → màu sau không phải phần chia của N túi, giữ như trước vòng 16.
    if (/^\s*(?:thi thoi|de sau|de lan sau|lan sau|het|co khong|co ko|co k|khong lay|ko lay|k lay|khoi|ha|chua)\b/.test(all.slice(offset + whole.length))) return whole;
    const shared = numberOf(number);
    if (shared === colours.length) return ` ${colours.map(colour => `1 ${({ XANH: 'xanh', VANG: 'vang', NAU: 'nau' })[colour]}`).join(' ')} `;
    if (eachSaid) return whole;
    splitAsk = splitAsk || shared;
    return ` ${list} `;
  });
  const counts = {};
  const mentioned = new Set();
  // "1vang" (dính số) vẫn là nhắc vị Vàng.
  for (const match of s.matchAll(new RegExp(`(?<![a-z])(xanh|vang|nau|cacao${NOT_TROPICAL})\\b${NOT_GREEN}`, 'g'))) mentioned.add(COLOUR_OF_WORD[match[1]]);
  // R14: "1 Granola vị ca cao và 1 Granola cân bằng" — "granola (vị/loại)" đứng giữa số và vị.
  for (const match of s.matchAll(new RegExp(`\\b(\\d{1,2}|mot|hai|ba|bon|nam|sau)\\s*(?:(?:tui|tuy|goi|bich|bit|b|t)\\s*(?:(?:hat|loai|vi|mau|granola)\\s+)?|granola\\s+(?:(?:vi|loai)\\s+)?|(?:mau|vi)\\s+)?(xanh|vang|nau|cacao${NOT_TROPICAL})\\b${NOT_GREEN}`, 'g'))) {
    const colour = COLOUR_OF_WORD[match[2]];
    counts[colour] = (counts[colour] || 0) + numberOf(match[1]);
  }
  for (const match of s.matchAll(new RegExp(`\\b(?:tui|goi|bich)?\\s*(xanh|vang|nau|cacao${NOT_TROPICAL})${NOT_GREEN}\\s*x\\s?(\\d{1,2})\\b`, 'g'))) {
    const colour = COLOUR_OF_WORD[match[1]];
    if (!counts[colour]) counts[colour] = Number(match[2]) || 0;
  }
  const each = s.match(/\bmoi (?:loai|vi|mau|thu|tui|goi) (\d{1,2}|mot|hai|ba)\b|\b(\d{1,2}|mot|hai|ba) (?:tui|goi|bich) moi (?:loai|vi|mau)\b/);
  if (each) for (const colour of mentioned) if (!counts[colour]) counts[colour] = numberOf(each[1] || each[2]);
  return { counts, mentioned: [...mentioned], each: Boolean(each), splitAsk };
}

/**
 * R16 (inbox1 A2, ca …2228960004 "Mình lấy 3 màu" khi đang giữ 3 Túi Xanh): "(lấy) N màu / N vị / N loại" không nêu tên màu nào
 * = N vị khác nhau, mỗi vị 1 túi. Trả N (2 hay 3), 0 khi không thuộc ca này: câu hỏi ("có mấy vị", "3 vị khác nhau không"),
 * "mỗi vị 2 túi", combo/hộp/gói nhỏ/Tropical/yến mạch, "3 loại hạt" (lời tả thành phần), số túi khác N ("3 túi 2 màu").
 * @param {string} text
 */
export function distinctKindsCount(text) {
  const s = normalizeIntentText(colourText(text));
  if (!s || /\?/.test(String(text || '')) || QUESTION.test(s) || /\b(?:dc|duoc|dk) (?:k|ko|khong|hong|kg|hok)\b/.test(s)) return 0;
  // Trên chữ CÒN DẤU: "2 mẫu" (bỏ dấu cũng là "2 mau") không phải "2 màu" ("Gửi hình ảnh 2 mẫu mình xem").
  if (!/(?<![\p{L}\p{N}])(?:2|3|hai|ba)\s*(?:màu|mau|vị|vi|loại|loai)(?![\p{L}\p{N}])/u.test(String(text || '').normalize('NFC').toLowerCase())) return 0;
  const eachOne = /\bmoi (?:loai|vi|mau) (?:1|mot)(?: (?:tui|goi|bich))?\b/;
  if (/(?<![a-z])(?:xanh|vang|nau|cacao)\b|\b(?:combo|hop|goi nho|mint|tropical|yen mach|cam|nguyen ban|nhieu hat|can bang)\b/.test(s)
    || /\bmoi\b/.test(s.replace(eachOne, ' '))) return 0;
  const match = s.match(/\b(2|3|hai|ba) (?:mau|vi|loai)(?! (?:hat|trai cay|qua|nao|gi|j|khac nhau (?:khong|ko|k|hong|chua)))\b/);
  if (!match) return 0;
  // Phải có ý lấy ("lấy/mua/đặt/chốt/cho/gửi…") hay cả tin chỉ là "3 màu (nhé/nha…)".
  const short = /^(?:(?:thi|vay|la|chi|c|minh|em|e|anh|a)\s+)?(?:2|3|hai|ba) (?:mau|vi|loai)(?: (?:nhe|nha|nhen|luon|thoi|di|a|ha|shop|e|em|c|chi|nhe shop|nha shop))*$/.test(s);
  if (!short && !/\b(?:lay|mua|dat|chot|cho|gui|ship|order|an|thu)\b/.test(s)) return 0;
  const kinds = numberOf(match[1]);
  const bags = countBags(s.replace(eachOne, ' '));
  return bags && bags !== kinds ? 0 : kinds;
}

/**
 * R16: số túi khách nêu mà chưa rõ chia vị thế nào → bộ soạn đơn hỏi lại vị (giữ số túi), không tự chia/không đoán:
 * - "3 túi xanh vàng" (N túi + danh sách màu không kèm số, N khác số màu — colourCountsInText.splitAsk);
 * - "lấy 2 màu/2 vị" không nêu màu nào (3 màu thì đủ cả 3 vị — adjustOrderQuantities tự lập giỏ). Không hỏi khi hai vị đã rõ
 *   từ tin ngay trước ("Lấy mình túi xanh và túi vàng ko đc à" → "2 loại") hay giỏ đang giữ đã có 2 vị.
 * @param {string} text
 * @param {{recentTexts?: string[], heldItems?: Array<{code?:string}>}} [options]
 * @returns {number}
 */
export function flavourSplitAsk(text, { recentTexts = [], heldItems = [] } = {}) {
  const { splitAsk } = colourCountsInText(text);
  if (splitAsk > 0) return splitAsk;
  if (distinctKindsCount(text) !== 2) return 0;
  const current = String(text || '');
  const earlierNamesColour = (Array.isArray(recentTexts) ? recentTexts : []).slice(-3)
    .some(other => String(other || '') !== current && !isShopCartText(other) && colourCountsInText(other).mentioned.length > 0);
  const heldColours = new Set((Array.isArray(heldItems) ? heldItems : []).map(item => colourOfItem(item)).filter(Boolean));
  return earlierNamesColour || heldColours.size >= 2 ? 0 : 2;
}

/**
 * R16 (inbox1 A8, ca …8040193418 "1 vị ca cao, 1 ngủ cốc", "1 túi vị ca cao, 01 túi hạt ngũ cốc"): "ngũ cốc" / "hạt ngũ cốc" kèm
 * số túi riêng KHÔNG phải tên vị (granola nào cũng là ngũ cốc) — chủ shop chưa chốt mặc định vị nào (mục C) → hỏi lại vị phần
 * đó (như "nguyên bản"), không để mô hình đoán Vàng. Trả số túi phần "ngũ cốc" (≥ 1), 0 khi không thuộc ca này: có màu ngay sau
 * ("2 gói ngũ cốc ăn sáng màu xanh"), "bột ngũ cốc" (sản phẩm Nghệ Lành), câu hỏi, không có số túi riêng.
 * @param {string} text
 */
export function ambiguousCerealBags(text) {
  const s = normalizeIntentText(colourText(text));
  if (!/\bngu coc\b/.test(s) || /\?/.test(String(text || ''))) return 0;
  // Hỏi giá ("Mua hai gói ngũ cốc giá như nào", "Bao nhiều một gói ngũ cốc") để luật/mô hình báo giá; kèm món khác (yến mạch,
  // "1kg", Nghệ Lành, combo/hộp/gói nhỏ…) thì bộ hỏi vị không giữ được món đó → không áp.
  if (/\b(?:gia|bao nhieu|bao nhiu|bn|nhieu tien|may tien)\b/.test(s)
    || /\b(?:yen mach|nghe|bot|combo|hop|goi nho|tropical|mint|cam|sieu hat|hat dieu|\d+ ?kg|kg)\b/.test(s)) return 0;
  let total = 0;
  for (const match of s.matchAll(/\b(\d{1,2}|mot|hai|ba)\s*(?:(?:tui|tuy|goi|bich|bit)\s+)?(?:(?:hat|vi|loai|granola)\s+)?(?<!\bbot )ngu coc\b((?: [a-z0-9]+){0,4})/g)) {
    if (/\b(?:xanh|vang|nau|cacao|nguyen ban|nhieu hat|can bang|nghe|lanh)\b/.test(match[2])) continue;
    total += numberOf(match[1]) || 1;
  }
  return total >= 1 && total <= 20 ? total : 0;
}

/**
 * R15-fix4 (phản biện M1): số túi khách BỚT — động từ bỏ/bớt/giảm/trừ (còn dấu) đứng NGAY trước số ("bỏ 1 túi", "bớt 1",
 * "giảm đi 1 túi"). Chữ không dấu "bo/bot/giam/tru" chỉ nhận khi số theo ngay sau và không đứng sau cho/gửi/giao/của/nhà/mẹ/ba
 * ("cho bo 2 tui" có thể là "cho bố 2 túi"). "bố", "bộ" có dấu khác "bỏ" nên không bao giờ là bớt. Không có → 0.
 */
export function removedBagCount(text) {
  const raw = String(text || '').normalize('NFC').toLowerCase();
  const match = raw.match(/(?<![\p{L}\p{N}])(?:(cho|gửi|gui|giao|ship|của|cua|nhà|nha|mẹ|me|ba)\s+)?(bỏ|bớt|giảm|trừ|bo|bot|giam|tru)(?:\s+(?:đi|di|ra|bớt|bot|bỏ|bo))?\s+(\d{1,2}|một|mot|hai|ba)(?![\p{L}\p{N}])/u);
  if (!match) return 0;
  if (match[1] && /^[a-z]+$/.test(match[2])) return 0;
  const count = ({ 'một': 1, mot: 1, hai: 2, ba: 3 })[match[3]] || Number(match[3]) || 0;
  return count >= 1 && count <= 20 ? count : 0;
}

// R15-fix4 (phản biện mục 4, có từ trước): "không thêm nữa", "khỏi thêm", "không lấy thêm" là PHỦ ĐỊNH — không phải đặt thêm
// ("1 túi thôi, không thêm nữa" với đơn 2 túi từng thành 3 túi 447k). Đọc trên chữ đã bỏ dấu (normalizeText).
const NEGATED_ADD_WORDS = /\b(?:khong|ko|k|kg|hong|khum|khoi|chang|dung|khoi can|khong can|ko can|k can)(?: (?:lay|can|dat|mua|gui|cho))? (?:them|nua)(?: nua)?\b/g;
export function asksToAdd(words) {
  return /\b(them|nua|cong them)\b/.test(String(words || '').replace(NEGATED_ADD_WORDS, ' '));
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
  // Vòng 13: tin giỏ Facebook Shop là chữ CRM tự sinh (tên sản phẩm + mã SKU), không phải lời khách → không đếm/lọc theo chữ.
  if (!text.trim() || isShopCartText(text)) return plain(items);
  const s = flavourSynonyms(normalizeIntentText(colourText(text)));
  const bags = countBags(text);
  // Vòng 13: "Chị lấy 2 mà" / "lấy 2 nha" / "Số lượng là 2" — chỉ nói lại số lượng.
  // R14 (…216841): "2 mà e" (không động từ, không chữ túi) cũng là nói lại số lượng.
  const quantityOnly = bags > 0 ? 0 : (quantityOnlyRequest(text) || shortQuantityReply(s));
  const { counts, mentioned, each } = colourCountsInText(text);
  const countGiven = bags > 0 || quantityOnly > 0 || Object.keys(counts).length > 0 || each;
  const reference = heldItems.length ? heldItems : recentItems;
  // R16 (inbox1 A2, ca …2228960004): "Vậy tổng là 5 túi, tặng 1 túi vàng + 1 bộ bát, thìa đúng ko shop" — khách HỎI LẠI tổng
  // giỏ (đuôi hỏi xác nhận), không đặt giỏ mới: giữ giỏ/đơn đang có (tổng khác giỏ thì câu trả lời nêu lại giỏ thật để khách
  // xem, không đổi giỏ theo con số trong câu hỏi).
  if (reference.length && bags > 0 && /\b(?:tong|tong cong|tat ca|vay la|tinh ra)\b/.test(s)
    && /\b(?:dung|phai)\s+(?:khong|ko|k|kg|hong|hok|chua|ha)\b/.test(s)) return plain(reference);
  // R16 (inbox1 A2): "Mình lấy 3 màu" (không nêu màu nào) = 3 vị, mỗi vị 1 túi — kể cả khi đang giữ 3 Xanh (trước đây giữ 3 Xanh
  // rồi cộng Vàng + Nâu thành 5 túi 740k). Đủ 3 vị túi lớn (Xanh/Vàng/Nâu), mô hình trả gì cũng vậy. "2 màu" → hỏi vị (renderOrder).
  if (distinctKindsCount(text) === 3) {
    const trio = ['XANH', 'VANG', 'NAU'].map(colour => getCatalogProducts().find(entry => entry.active && !entry.staffOnly && entry.sku.startsWith(`GRA-${colour}-`))).filter(Boolean);
    if (trio.length === 3) return trio.map(product => ({ product: product.name, code: product.sku, quantity: 1 }));
  }
  // Vòng 13: trong CÂU HỎI, "cho" chỉ là động từ đặt hàng khi khách nêu rõ món ("cho mình túi xanh được không");
  // "Cho mix vị được không?" là hỏi, không được đổi giỏ đang giữ / tự lập giỏ.
  const namesProduct = mentioned.length > 0 || /\b(combo|hop|tropical|mint)\b/.test(s);
  const verbText = s.replace(/\bcho (em|e|minh|chi|c|a|anh) hoi\b/g, ' ');
  const orderVerb = ORDER_VERBS.test(namesProduct ? verbText : verbText.replace(/\bcho\b/g, ' '));
  if (QUESTION.test(s) && !countGiven && !orderVerb) return reference.length ? plain(reference) : [];
  // Engine gộp cụm tin liền nhau cho mô hình nhưng messageText chỉ là tin cuối: tin ngay trước có nhắc
  // hàng ("2 túi xanh" rồi "đc …") thì giỏ mô hình đọc từ cả cụm là đúng — không khoá giỏ đang giữ.
  // Vòng 13: chữ tự sinh của giỏ Facebook Shop trong cụm không tính là "khách nhắc hàng" (giỏ đang giữ mới là giỏ đúng).
  const burstNamesBasket = !recentItems.length && burstTexts.some(other => String(other || '') !== text && !isShopCartText(other) && BASKET_WORDS.test(normalizeIntentText(other)));
  if (!BASKET_WORDS.test(s) && !countGiven) return !burstNamesBasket && reference.length ? plain(reference) : plain(items);
  let next = items.map(item => ({ ...item }));
  const allColour = next.length > 0 && next.every(item => colourOfItem(item));
  // R14 (…837888): "mình lấy 2 túi 1 xanh + lâu" — tổng túi khách nêu bằng tổng món mô hình đọc được thì giữ đủ các món
  // mô hình trả (vị gõ sai không có trong chữ), không lọc theo màu (trước đây còn 1 Xanh 189k).
  const modelTotal = next.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
  const keepModelColours = bags > 1 && next.length > 1 && bags === modelTotal;
  if (allColour && mentioned.length && !/\b(combo|hop|goi nho|yen mach|mix|cam)\b/.test(s)) {
    const kept = keepModelColours ? next : next.filter(item => mentioned.includes(colourOfItem(item)));
    if (kept.length) next = kept;
    for (const item of next) {
      const colour = colourOfItem(item);
      if (counts[colour]) item.quantity = counts[colour];
    }
    // Vòng 13: khách nêu số túi cho một vị mà giỏ luật/mô hình trả về thiếu vị đó ("Cho chị 1 xanh + 1 túi vành": chữ
    // "vành" không ai đọc ra → giỏ chỉ có 1 Xanh): thêm vị thiếu với đúng số khách nêu. Không làm khi tin là câu hỏi
    // hay có ý đổi/bỏ ("đổi 1 xanh thành 1 vàng", "không lấy 1 nâu").
    const missing = Object.keys(counts).filter(colour => counts[colour] > 0 && !next.some(item => colourOfItem(item) === colour));
    // R14: "Ko fai 2 túi nâu / 1 Granola vị ca cao và 1 Granola cân bằng" — lời đính chính "không phải …" không phải ý bỏ món.
    const sNoCorrection = s.replace(/\b(?:khong|ko|k|kg|hong)\s+(?:phai|fai|pai)\b/g, ' ');
    if (missing.length && !keepModelColours && kept.length === next.length && !QUESTION.test(sNoCorrection) && !/\b(doi|thay|bo|bot|huy|tru|khong|ko|k|hong|hok|kg|dung|thoi)\b/.test(sNoCorrection)) {
      for (const colour of missing) {
        const product = getCatalogProducts().find(entry => entry.active && !entry.staffOnly && entry.sku.startsWith(`GRA-${colour}-`));
        if (product) next.push({ product: product.name, code: product.sku, quantity: counts[colour] });
      }
    }
  }
  // "N túi" không nêu màu, giỏ đang giữ một màu: N túi màu đó.
  const referenceCodes = [...new Set(reference.map(item => String(item.code || '').toUpperCase()).filter(Boolean))];
  // Vòng 13: chỉ nói lại số lượng ("Chị lấy 2 mà", "Số lượng là 2") với giỏ/đơn một mã → đổi số lượng mã đó ("thêm/nữa" thì cộng).
  // Giỏ luật/mô hình trả về phải trống hoặc đúng mã đó; nhiều mã thì không đoán (giữ giỏ đang có).
  if (quantityOnly > 0 && !mentioned.length) {
    const sameCode = next.every(item => String(item.code || '').toUpperCase() === referenceCodes[0]);
    if (referenceCodes.length === 1 && sameCode) {
      const base = reference[0];
      const held = reference.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
      return [{ product: base.product, code: base.code, quantity: adding ? held + quantityOnly : quantityOnly }];
    }
    if (reference.length > 1) return plain(reference);
    if (next.length === 1 && !(next[0].given && next[0].quantity > 1)) next[0].quantity = quantityOnly;
    return plain(next);
  }
  if (bags > 0 && !mentioned.length && referenceCodes.length === 1 && colourOfItem(reference[0]) && (!next.length || next.every(item => colourOfItem(item)))
    && !/\b(combo|hop|goi nho|yen mach|mix|cam|mint|tropical)\b/.test(s)) {
    const base = reference[0];
    const held = reference.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
    // R15-fix3 (phản biện luật, engine-probe B1): "giảm đi 1 túi" / "bớt 1 túi" / "bỏ 1 túi" khi giữ 3 Xanh = BỚT 1 (còn 2), không
    // phải đặt số lượng thành 1. "bớt còn 1 túi" / "lấy 1 túi thôi" vẫn là số lượng mới.
    // R15-fix4 (phản biện M1, NGHIÊM TRỌNG): xét trên chữ CÒN DẤU — "gửi bố 2 túi" / "cho bố mẹ 2 túi" (bố bỏ dấu = "bo") từng bị
    // đọc là "bỏ 2 túi" và trừ đơn/giỏ. Chỉ trừ khi số đứng NGAY sau động từ ("bỏ 1 túi", "bớt 1", "giảm đi 1 túi").
    const removed = removedBagCount(text);
    const removing = !adding && removed > 0 && !/\b(?:con|lay|chi|de lai)\b/.test(s);
    if (removing && held - removed >= 1) return [{ product: base.product, code: base.code, quantity: held - removed }];
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
  // R14 (…216841): "C lấy combo vị ca cao nhé" ngay sau bảng giá — "combo" không kèm số là combo 2 túi (mô hình ghi 1 túi
  // 219k). Chỉ cho túi lớn (GRA-…); "Combo 10 gói" là tên sản phẩm, không nhân đôi.
  if (/\bcombo\b/.test(s) && !bags && !quantityOnly && !Object.keys(counts).length && !each && !QUESTION.test(s)
    && next.length === 1 && /^GRA-/i.test(String(next[0].code || '')) && Number(next[0].quantity) === 1) next[0].quantity = 2;
  return plain(next);
}

// R14 (…216841): "2 mà e", "2 chứ shop", "3 nha c" — chỉ số + chữ đệm (đã bỏ dấu), không động từ/chữ túi.
function shortQuantityReply(s) {
  const match = String(s || '').trim().match(/^(?:(?:thi|vay|la|chi|c|minh|em|e|anh|a)\s+)?(\d{1,2}|hai|ba|bon|nam)\s+(?:ma|chu|nha|nhe|do|day|thoi|luon|nhen)(?:\s+(?:e|em|shop|s|ban|b|c|chi|a|anh|oi|nha|nhe|ma))*$/);
  const count = match ? numberOf(match[1]) : 0;
  return count >= 1 && count <= 20 ? count : 0;
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
  // Vòng 13 (NGHIÊM TRỌNG): giỏ Facebook Shop — engine truyền context.fromCart khi tin có message.cart; chưa truyền thì
  // tự nhận ra theo tiền tố chữ CRM tự sinh ("Khách chọn mua từ Facebook Shop: … (CB-VANGG+XANH)"). Chữ đó không phải
  // lời khách: không sửa số lượng/lọc vị theo chữ (combo Vàng + Xanh 298k từng thành "1 Túi Xanh 189k"), không đọc
  // "thêm/đổi/địa chỉ cũ/thanh toán" từ tên sản phẩm. Giỏ lấy nguyên từ Product_N*/No_* engine đưa vào.
  const fromCart = context.fromCart === true || isShopCartText(context.messageText);
  const customerText = fromCart ? '' : String(context.messageText || '');
  const messageWords = normalizeText(customerText);
  // Vòng 12: tin thanh toán ("gửi stk để mình ck… lên đơn 0đ") không bao giờ là sửa đơn.
  const paymentMessage = isPaymentMessage(customerText);
  // Khách nêu loại mà không nói số ("C đặt nhé" sau khi được báo giá): tính là 1 — trừ khi giỏ/đơn
  // gần nhất đã có món đó hay khách đã nêu số túi trước (adjustOrderQuantities, vòng 12).
  // R14: mô hình chép nguyên lời khách ("Granola cân bằng", "Granola nhiều hạt") — đổi sang tên túi để danh mục nhận ra.
  const flavourName = product => {
    const text = String(product || '').trim();
    const key = normalizeIntentText(text);
    if (/\b(xanh|vang|nau|cacao|mint|tropical|combo|hop|goi)\b/.test(key)) return text;
    const mapped = flavourSynonyms(key);
    return mapped === key ? text : /\bxanh\b/.test(mapped) ? 'Granola Túi Xanh' : /\bvang\b/.test(mapped) ? 'Granola Túi Vàng' : text;
  };
  const rawNamed = toPricedItems(products.map((product, index) => ({
    product: flavourName(product),
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
  // Vòng 13 (inbox2 B1): "Cho mình 2 túi nhé" → (SĐT) → "Túi vàng nhiều hạt nhé". Số túi đã nêu nằm ở
  // pendingOrder.askedBagCount; lượt SĐT xen giữa làm engine ghi đè giỏ chờ (mất số) → dự phòng: bot vừa hỏi vị và một
  // trong 3 tin khách ngay trước có "N túi" không kèm vị thì lấy số đó.
  const askedFlavourLast = ['ASK_FLAVOR', 'ORDER_INFO_ASK_FLAVOR', 'ORDER_PHONE_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN', 'RECOMMEND_BEGINNER'].includes(String(context.lastTemplateId || ''));
  const askedBagsBefore = () => {
    if (!askedFlavourLast || !Array.isArray(context.recentCustomerTexts)) return 0;
    const earlier = context.recentCustomerTexts.map(text => String(text || '')).filter(text => text.trim() && text !== customerText && !isShopCartText(text)).slice(-3);
    for (const text of earlier.reverse()) {
      const count = countBags(text);
      if (count > 0 && !colourCountsInText(text).mentioned.length) return count;
    }
    return 0;
  };
  // R14: bot vừa hỏi nguyên bản là Xanh hay Vàng (ASK_FLAVOR_NGUYENBAN, giỏ chờ mang nguyenBanAsk = số túi phần đó).
  const askedNguyenBan = context.lastTemplateId === 'ASK_FLAVOR_NGUYENBAN' && Number(context.pendingOrder?.nguyenBanAsk) > 0;
  const adjustedItems = paymentAfterOrder
    ? (recentEditable ? recentForQuantity : [])
    : fromCart
      ? rawNamed.map(({ product, code, quantity }) => ({ product, code, quantity }))
      : adjustOrderQuantities(rawNamed, {
        messageText: customerText,
        // Trả lời "nguyên bản là Xanh/Vàng": số túi là phần nguyên bản vừa hỏi, không lấy số Xanh/Vàng đang giữ trong giỏ.
        heldItems: askedNguyenBan ? heldForQuantity.filter(item => !/^GRA-(XANH|VANG)-/i.test(String(item.code || ''))) : heldForQuantity,
        recentItems: recentForQuantity,
        askedBagCount: Number(context.pendingOrder?.askedBagCount) || askedBagsBefore(),
        burstTexts: Array.isArray(context.recentCustomerTexts) ? context.recentCustomerTexts.slice(-2) : [],
        adding: String(value.add_to_basket || '') === '1' || asksToAdd(messageWords) || askedNguyenBan
      });
  // R15 (inbox1 A2): "1 túi nguyên bản và 1 túi vàng nhiều hạt" — Vàng đã nêu riêng nên nguyên bản là Túi Xanh: thêm Xanh vào
  // giỏ khi luật/mô hình chỉ đưa phần Vàng (trước đây bot hỏi lại "nguyên bản là gì" và giỏ chờ chỉ còn 1 Vàng).
  const xanhFromNguyenBan = !fromCart && !paymentAfterOrder && !askedNguyenBan ? nguyenBanMeansXanh(customerText) : 0;
  const xanhProduct = xanhFromNguyenBan && !adjustedItems.some(item => colourOfItem(item) === 'XANH')
    ? getCatalogProducts().find(entry => entry.active && !entry.staffOnly && entry.sku.startsWith('GRA-XANH-')) : null;
  // R15 (inbox3 A5): khách gửi SĐT/địa chỉ KHÁC đơn vừa chốt (≤ 60 phút) mà mô hình chỉ trả ORDER_UPDATE không kèm món
  // ("đt 0987654321") → sửa SĐT/địa chỉ của đúng đơn đó với giỏ của đơn (trước đây: ORDER_WRONG hỏi lại, hay mô hình chọn
  // ORDER_UNCHANGED "đơn đã lên rồi" và SĐT mới bị bỏ — renderSingleReply chuyển ca đó về đây).
  const contactChange = contactDiffersFromOrder(recentOrder, customerText, value.Customer_Address);
  const contactOnlyUpdate = templateId === 'ORDER_UPDATE' && !adjustedItems.length && !fromCart && !paymentMessage
    && recentForQuantity.length > 0 && recentOrder?.automatic !== false && now - (Number(recentOrder?.createdAt) || 0) < orderUpdateWindowMs && contactChange;
  // Chủ shop 05/10 (quyết định c): "ngũ cốc" / "hạt ngũ cốc" kèm số túi riêng mà không nêu vị ("Mua hai gói ngũ cốc", "1 vị ca cao,
  // 1 ngủ cốc") → MẶC ĐỊNH Túi Xanh (trước đây hỏi lại vị phần đó bằng ASK_FLAVOR_NGUYENBAN). Giỏ = các túi khách nêu rõ màu +
  // phần "ngũ cốc" là Túi Xanh (bỏ món mô hình đoán cho phần đó). "nguyên bản" (Xanh hay Vàng) vẫn hỏi lại như cũ.
  const cerealBags = !fromCart && !paymentAfterOrder && !askedNguyenBan && !contactOnlyUpdate && isOrderStep(templateId) && !ambiguousNguyenBan(customerText)
    ? ambiguousCerealBags(customerText) : 0;
  const cerealItems = cerealBags > 0 ? (() => {
    const byCode = new Map();
    const add = (product, quantity) => {
      if (!product) return;
      const current = byCode.get(product.sku);
      byCode.set(product.sku, { product: product.name, code: product.sku, quantity: (current?.quantity || 0) + quantity });
    };
    for (const [colour, count] of Object.entries(colourCountsInText(customerText).counts)) {
      if (count > 0) add(getCatalogProducts().find(entry => entry.active && !entry.staffOnly && entry.sku.startsWith(`GRA-${colour}-`)), count);
    }
    add(getCatalogProducts().find(entry => entry.active && !entry.staffOnly && entry.sku.startsWith('GRA-XANH-')), cerealBags);
    return byCode.size ? [...byCode.values()] : null;
  })() : null;
  const namedItems = contactOnlyUpdate ? recentForQuantity
    : cerealItems ? cerealItems
    : xanhProduct ? [...adjustedItems, { product: xanhProduct.name, code: xanhProduct.sku, quantity: xanhFromNguyenBan }] : adjustedItems;
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
  const addsToOrder = asksToAdd(messageWords) || /\b(gop|ghep)\b/.test(messageWords);
  const implicitUpdate = !separateOrder && recentOpen && recentOrder.automatic !== false && namedItems.length > 0
    && ['ORDER_CONFIRMATION', 'ORDER_ADDRESS'].includes(templateId);
  // Tin thanh toán chỉ được nhắc lại đơn (namedItems = đúng đơn gần nhất → ORDER_UNCHANGED), không sửa.
  const updating = ((templateId === 'ORDER_UPDATE' && recentOpen) || implicitUpdate) && !(paymentMessage && !recentForQuantity.length);
  // Khách nói rõ muốn đổi đơn đã đặt mà bot không tự sửa được (quá 60 phút — kho có thể đã đóng
  // gói; đơn nhân viên/POS lên; đơn đang giao): trước đây rơi xuống nhánh đơn MỚI, bot hỏi lại
  // SĐT/địa chỉ và mời thêm túi. Nay: ghi giỏ khách muốn vào ghi chú đơn, gắn thẻ Đổi sản phẩm +
  // Cần người xử lý để nhân viên sửa. Đang giữ giỏ mới hơn đơn (khách đang đặt đơn khác) thì thôi.
  // 02/10 (ca Nguyễn Tuyết, đơn 1 Túi Xanh 83 phút trước): "Lấy 2goi xanh chi" — cùng MỘT món của đơn, chỉ khác số lượng, không SĐT/
  // địa chỉ, không nói "đơn khác" → là xin đổi số lượng đơn đã đặt, không phải đơn mới (trước đây bot mở đơn mới và xin lại địa chỉ).
  // Món KHÁC đơn ("cho chị 2 túi vàng" sau đơn Xanh) vẫn là đơn mới như đã chốt (order-exchange.test).
  const modelBlank = field => { const text = String(field || '').trim(); return !text || text === '0'; };
  const orderLines = (recentOrder?.products || []).map(item => ({ code: String(item.sku || item.code || ''), quantity: Number(item.quantity) || 1 })).filter(item => item.code);
  const sameItemNewQuantity = namedItems.length === 1 && orderLines.length === 1
    && (matchProduct(namedItems[0].product)?.sku || namedItems[0].code || '') === orderLines[0].code && Number(namedItems[0].quantity) !== orderLines[0].quantity;
  // R13 sửa (phản biện C2): regex SĐT từng mất dấu `\` (/d{9,}/ — chữ d lặp) nên tin có SĐT vẫn bị coi là "đổi số lượng".
  // Tin "thêm / nữa" là đặt THÊM (ORDER_EXISTING_CONFIRM hỏi đặt thêm như cũ), tin nhắc địa chỉ cũ / có từ địa chỉ là đơn
  // mới có nơi nhận; cửa sổ 3 giờ (đơn 20 giờ trước + "Mình lấy 2 túi xanh" là đơn mới hôm sau, như trước R13).
  const plainBasketWindowMs = 3 * 60 * 60 * 1000;
  const plainBasketAddressWords = /\b(dia chi|d\/c|dc|dchi|phuong|quan|huyen|tinh|thanh pho|duong|ngo|ngach|hem|thon|xom|so nha|(gui|ship|giao) (ve|den|toi|cho))\b/;
  const plainBasketTurn = sameItemNewQuantity && ['ORDER_ADDRESS', 'ORDER_CONFIRMATION'].includes(templateId) && modelBlank(value.Phone_Number)
    && modelBlank(value.Customer_Address) && !extractVietnamesePhone(customerText) && !/\d{9,}/.test(customerText.replace(/[\s.()+-]/g, ''))
    && !addsToOrder && !mentionsOldAddress(customerText) && !plainBasketAddressWords.test(messageWords)
    && !shipped && recentOrder?.source !== 'POS' && now - (Number(recentOrder?.createdAt) || 0) < plainBasketWindowMs;
  // Giỏ giữ mới hơn đơn = khách đang đặt đơn khác; riêng ca đổi số lượng cùng món, giỏ trơn (chưa có SĐT/địa chỉ riêng) không chặn.
  const heldNewer = Number(context.pendingOrder?.at) > (Number(recentOrder?.createdAt) || 0) && (context.pendingOrder?.items || []).length > 0
    && !(plainBasketTurn && !context.pendingOrder?.phone && !context.pendingOrder?.address);
  if (!updating && !separateOrder && namedItems.length && recentOrder?.id && templates.ORDER_CHANGE_STAFF
    && (mergeRequest || orderChangePattern.test(messageWords) || plainBasketTurn) && !isGiftSwapRequest(customerText) && !heldNewer
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
  // Vòng 13: giỏ Facebook Shop là giỏ khách tự bấm chọn — không bỏ món "trùng đơn vừa chốt" (lọc đó chỉ để sửa giỏ mô hình gộp nhầm).
  const baseItems = updating ? (implicitUpdate && addsToOrder && !coversOldOrder() ? mergedItems() : namedItems) : fromCart ? namedItems : dropRecentlyOrdered(namedItems, recentOrder, now);
  if (updating && !baseItems.length && templates.ORDER_WRONG) {
    return { templateId: 'ORDER_WRONG', ...splitMessages(fill(templates.ORDER_WRONG, commonValues())), handoff: false };
  }
  const pending = usablePendingOrder(context.pendingOrder, { now, templateId });
  // R14 (…958786): "1 túi nâu 1 túi nguyên bản" — Xanh và Vàng đều được gọi là nguyên bản, mô hình đoán (từng thành 2 Nâu,
  // khách bỏ đơn): hỏi lại bằng ASK_FLAVOR_NGUYENBAN. Giỏ chờ giữ phần khách đã nói rõ (1 Nâu) + số túi phần nguyên bản
  // (askedBagCount / nguyenBanAsk); khách trả lời Xanh/Vàng thì cộng vào giỏ (answersNguyenBan). Không hỏi lại lần hai.
  // R16 (inbox1 A1/A2): "3 túi xanh vàng" (số túi khác số màu) / "lấy 2 màu" (không nêu màu) → hỏi lại vị, giữ số túi
  // (askedBagCount) + SĐT/địa chỉ; giỏ cũ không còn đúng ý khách nên không chốt theo giỏ cũ hay giỏ mô hình đoán.
  const splitAsk = !updating && !fromCart && !paymentMessage && templates.ASK_FLAVOR && isOrderStep(templateId)
    ? flavourSplitAsk(customerText, { recentTexts: Array.isArray(context.recentCustomerTexts) ? context.recentCustomerTexts : [], heldItems: pending?.items || [] }) : 0;
  if (splitAsk > 0) {
    const { awaitingConfirm, heldSilently, nguyenBanAsk, ...carry } = pending || {};
    const typed = String(value.Customer_Address || '').trim();
    const typedClean = typed && typed !== '0' ? stripReceiverName(cleanAddressText(typed), String(activeCustomer.name || '')) : '';
    return {
      templateId: 'ASK_FLAVOR',
      ...splitMessages(fill(templates.ASK_FLAVOR, commonValues())),
      handoff: false,
      pendingOrder: { ...carry, items: [], key: '', at: now, phone: toLocalPhone(value.Phone_Number) || extractVietnamesePhone(customerText) || pending?.phone || '', address: typedClean || pending?.address || '', addressAsks: pending?.addressAsks || 0, askedBagCount: splitAsk }
    };
  }
  // R16 (inbox1 A8): "1 vị ca cao, 1 ngủ cốc" — phần "ngũ cốc" chưa rõ vị: hỏi lại như "nguyên bản" (giữ phần đã rõ: 1 Nâu).
  const nguyenBanQty = !updating && !fromCart && !paymentMessage && templates.ASK_FLAVOR_NGUYENBAN && !askedNguyenBan
    && context.lastTemplateId !== 'ASK_FLAVOR_NGUYENBAN' && !xanhFromNguyenBan ? (ambiguousNguyenBan(customerText) || (cerealItems ? 0 : ambiguousCerealBags(customerText))) : 0;
  if (nguyenBanQty > 0) {
    const { counts } = colourCountsInText(customerText);
    const adding = asksToAdd(messageWords);
    const stated = Object.entries(counts).filter(([, count]) => count > 0).map(([colour, count]) => {
      const product = getCatalogProducts().find(entry => entry.active && !entry.staffOnly && entry.sku.startsWith(`GRA-${colour}-`));
      return product ? { product: product.name, code: product.sku, quantity: count } : null;
    }).filter(Boolean);
    // "thêm 1 túi nâu 1 túi nguyên bản" khi đang giữ 2 Xanh: giỏ chờ = giỏ đang giữ + phần đã nói rõ (cộng theo mã).
    const merged = new Map();
    for (const item of adding ? [...(pending?.items || []), ...stated] : stated) {
      const code = String(item.code || '').toUpperCase() || item.product;
      const current = merged.get(code);
      merged.set(code, current ? { ...current, quantity: (Number(current.quantity) || 1) + (Number(item.quantity) || 1) } : { ...item });
    }
    const items = [...merged.values()];
    const key = items.length ? buildOrderKey(items) : '';
    const phone = toLocalPhone(value.Phone_Number) || extractVietnamesePhone(customerText) || pending?.phone || '';
    // Giữ các cờ khác của giỏ (wantsPrevious, staffCheck, giftSwap, livestream, fromComment…), trừ cờ chờ xác nhận đơn.
    const { awaitingConfirm, heldSilently, ...carry } = pending || {};
    return {
      templateId: 'ASK_FLAVOR_NGUYENBAN',
      ...splitMessages(fill(templates.ASK_FLAVOR_NGUYENBAN, commonValues())),
      handoff: false,
      pendingOrder: { ...carry, items: key ? items : [], key, at: now, phone, address: pending?.address || '', addressAsks: pending?.addressAsks || 0, askedBagCount: nguyenBanQty, nguyenBanAsk: nguyenBanQty }
    };
  }
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
  // R14: bot vừa hỏi "nguyên bản là Xanh hay Vàng" (giỏ chờ giữ phần đã rõ, vd 1 Nâu) — khách trả lời vị thì CỘNG vào giỏ.
  const answersNguyenBan = askedNguyenBan && baseItems.length > 0 && baseItems.every(item => /^GRA-(XANH|VANG)-/i.test(String(item.code || '')));
  const addsToHeld = heldItems.length > 0 && baseItems.length > 0 && isOrderStep(templateId) && !replacesHeld
    && (String(value.add_to_basket || '') === '1' || ((asksToAdd(messageWords) || answersNguyenBan) && !coversHeld()));
  // R16: trả lời vị cho phần "nguyên bản"/"ngũ cốc" ("Túi xanh nhé", không nêu số) = đúng số túi phần đó (nguyenBanAsk).
  // Luật FLAVOR_ANSWER / mô hình lấy số túi của CẢ tin trước ("1 túi nâu 1 túi nguyên bản" = 2) → trước đây 1 Nâu + 2-3 Xanh.
  const nguyenBanOpenQty = Math.round(Number(context.pendingOrder?.nguyenBanAsk) || 0);
  const answerItems = answersNguyenBan && nguyenBanOpenQty > 0 && baseItems.length === 1 && !countBags(customerText)
    && !Object.keys(colourCountsInText(customerText).counts).length ? [{ ...baseItems[0], quantity: nguyenBanOpenQty }] : baseItems;
  const mergeHeld = () => {
    const byKey = new Map();
    for (const item of [...heldItems, ...answerItems]) {
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
  const basePrice = trialPriced ? withPromoFreeShipping(priced) : promoBowl ? withPromoBowl(priced) : priced?.priceable ? priced : null;
  // Vòng 13 (inbox1 A2): khách đã chọn đổi quà khi giỏ còn chờ (engine đặt pendingOrder.giftSwap = parseGiftSwapChoice(tin
  // khách) sau GIFT_SWAP; mảng rỗng = chưa nêu vị): dòng quà của tin giỏ / xác nhận đơn / ghi chú đơn là 2 gói nhỏ thay cho
  // bát/quạt/muỗng (chủ shop 01/10, không trừ tiền) — không còn in "tặng Quạt + Bát" sau khi đã nhận đổi.
  const giftSwap = heldGiftSwap(context.pendingOrder);
  // R15 (chủ shop 03/10): bot đã hứa tặng yến mạch khách quen (engine đặt pendingOrder.oatsGift = true sau DISCOUNT_OATS_GIFT)
  // → dòng quà của tin giỏ / xác nhận đơn / order.gift thêm OATS_GIFT_NAME khi giỏ từ 2 túi; tiền không đổi.
  const oatsGift = context.pendingOrder?.oatsGift === true;
  // 05/10: quà chọn tay của giỏ (đổi quạt → muỗng dừa) thay cho quà theo bảng; có thì không áp đổi quà kiểu cũ.
  // Gộp: lời hứa yến mạch (R15) vẫn cộng lên trên quà chọn tay (đơn lưu dựng chữ quà từ giftOverride; nhân viên vẫn có
  // ghi chú yến mạch trong addressCheck do engine gắn).
  const giftOverride = heldGiftOverride(context.pendingOrder, basePrice);
  const price = withOatsGift(giftOverride ? withGiftOverride(basePrice, giftOverride) : withGiftSwap(basePrice, giftSwap), oatsGift);

  // Mô hình bỏ sót SĐT nằm chung dòng với tên/địa chỉ ("Vũ Thanh Hải - 09xx… 3a2/109 đường…"):
  // đọc thẳng từ tin khách vừa nhắn thay vì hỏi lại thứ khách đã đưa.
  // R15 (inbox3 A5): đang sửa đơn vừa chốt — SĐT nằm trong chính tin khách thắng SĐT mô hình điền (mô hình hay chép SĐT cũ
  // của đơn từ lịch sử → unchangedOrder → "đơn đã lên rồi", SĐT mới bị bỏ).
  const freshPhone = (updating ? extractVietnamesePhone(customerText) : '') || toLocalPhone(value.Phone_Number) || extractVietnamesePhone(value.Phone_Number) || extractVietnamesePhone(customerText)
    // SĐT khách gửi ở một tin riêng trước đó (hay tin bị mô hình bỏ qua): đọc lại, không hỏi nữa.
    || (Array.isArray(context.recentCustomerTexts) ? context.recentCustomerTexts.map(text => extractVietnamesePhone(text)).find(Boolean) || '' : '');
  // Khách quen "gửi về địa chỉ cũ / như lần trước": SĐT và địa chỉ lấy từ đơn
  // gần nhất của khách thay vì hỏi lại.
  // Cùng bộ từ với OLD_ADDRESS của order-flow.mjs ("như/giống lần/hôm trước", "chỗ cũ").
  // Cũng nhận "gởi địa chỉ củ", "dc cũ", "đc cũ", "gửi dc trước rồi", "như đơn trước", "đơn cũ / lần trước / hôm trước".
  // Vòng 11 (P8): "bữa trước ăn ngon, lấy thêm 2 túi xanh" từng bị hiểu là địa chỉ cũ (tự chốt về địa chỉ đơn trước).
  // Nay: bộ từ OLD_ADDRESS của order-flow.mjs, hoặc vế cũ nhưng chỉ khi tin có từ giao hàng/địa chỉ (gửi/ship/giao/về/đc).
  // Bỏ "cho cu" (trùng "gửi cho cụ").
  const previousWords = normalizeText(customerText);
  const saysPrevious = mentionsOldAddress(customerText)
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
  // Vòng 13: đuôi lời dặn dính sau địa chỉ ("…An Hưng- Thanh Hoá nhé b", "… nha shop ạ") làm máy không đọc ra tỉnh → cắt.
  // Chỉ cắt khi mở bằng nhé/nha/nhen/ạ (chữ "b"/"e" trơ trọi cuối địa chỉ có thể là "khu B").
  const stripCourtesyTail = text => String(text || '').replace(/(?:[\s,.;-]+(?:nhé|nhe|nha|nhá|nhen|nghen|ạ))(?:[\s,.;-]+(?:b|bạn|ban|shop|sốp|em|e|ơi|oi|ạ|nhé|nha))*[\s,.;-]*$/iu, '').trim();
  // R14: tên người nhận trùng tên Facebook của khách ở đầu địa chỉ cũng bỏ (stripReceiverName nhận tên hồ sơ).
  const profileName = String(activeCustomer.name || '');
  const givenAddress = typedAddress && typedAddress !== '0' ? (stripCourtesyTail(stripReceiverName(cleanAddressText(typedAddress), profileName)) || stripReceiverName(cleanAddressText(typedAddress), profileName)) : typedAddress;
  // Vòng 13 (inbox2 A4): đang sửa đơn vừa chốt (updating) mà khách gửi địa chỉ:
  // - đúng địa chỉ của đơn (hay một phần của nó, không thêm gì) → dùng lại địa chỉ đơn, không hỏi lại phường/xã;
  // - MỘT MẢNH chưa đủ cấp ("Khu Đô Thị Mới Đông Sơn", "số nhà 12") → ghép vào địa chỉ khách đã ghi của đơn như ghép mảnh
  //   vào giỏ chờ, không thay cả địa chỉ bằng mảnh đó. Mảnh có số nhà mà địa chỉ đơn cũng đã có số nhà (đường khác?) thì
  //   không ghép (hai số nhà trên một phiếu) — hỏi phần thiếu như cũ;
  // - địa chỉ đủ cấp → địa chỉ mới (thêm số nhà so với đơn thì sửa đơn — xem addsAddressDetail).
  const typedGiven = givenAddress && givenAddress !== '0' ? givenAddress : '';
  const orderAddressTyped = updating && typedGiven && previous?.address ? String(previous.rawAddress || previous.address).replace(/^\((?:live|freeship)\)\s*/i, '') : '';
  const repeatsOrderAddress = Boolean(orderAddressTyped) && [previous.rawAddress, previous.address].filter(Boolean)
    .some(old => sameAddressText(old, typedGiven) && !addsAddressDetail(old, typedGiven));
  const orderStreetOf = text => { const resolved = describeDeliveryAddress(text).resolved || {}; return String(resolved.streetWithoutWard ?? resolved.street ?? ''); };
  const fragmentOfOrder = Boolean(orderAddressTyped) && !repeatsOrderAddress && !pending?.address
    && !describeDeliveryAddress(typedGiven).complete && !(/\d/.test(typedGiven) && /\d/.test(orderStreetOf(orderAddressTyped)));
  const freshAddress = (repeatsOrderAddress ? '' : typedGiven) || (previous?.address ? String(previous.address) : '');
  const phone = freshPhone || pending?.phone || (previous?.phone ? toLocalPhone(previous.phone) || String(previous.phone) : '');
  // A fragment the customer sends after being asked ("phường 5", "số 12 Lê
  // Lợi") is merged into the saved address; a whole new address replaces it.
  const mergedAddress = mergeAddressFragment(freshAddress !== '0' ? freshAddress : '', pending?.address || (fragmentOfOrder ? orderAddressTyped : ''));
  const address = fragmentOfOrder ? dedupeAddressSegments(mergedAddress) : mergedAddress;
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
        // Vòng 13: lựa chọn đổi quà (engine đặt sau GIFT_SWAP) đi theo giỏ tới khi lên đơn, kể cả khi khách đổi món/số túi.
        ...(giftSwap && pending ? { giftSwap } : {}),
        // R15: lời hứa tặng yến mạch khách quen đi theo giỏ tới khi lên đơn.
        ...(oatsGift ? { oatsGift: true } : {}),
        // 05/10: quà chọn tay (đổi quạt → muỗng dừa) đi theo giỏ khi giỏ mới vẫn được quà live.
        ...(pending && heldGiftOverride(context.pendingOrder, freshPriceable ? freshPrice : basePrice) ? { giftOverride: heldGiftOverride(context.pendingOrder) } : {}),
        // Vòng 12: số túi khách đã nêu khi chưa chọn vị — giữ tới khi giỏ có hàng.
        ...(!freshPriceable && !(pending?.items || []).length && Number(context.pendingOrder?.askedBagCount) ? { askedBagCount: Number(context.pendingOrder.askedBagCount) } : {})
      }
    : null;

  // R15 (inbox1 A2): giỏ chờ còn phần "nguyên bản" chưa rõ Xanh/Vàng (nguyenBanAsk) mà tin này không nêu vị/số túi (khách gửi
  // SĐT + địa chỉ, mô hình không điền món) → KHÔNG lên đơn thiếu túi (trước đây tạo đơn 1 Túi Vàng 189k thay cho Xanh + Vàng):
  // giữ SĐT/địa chỉ vào giỏ chờ và hỏi lại phần nguyên bản. Khách nêu giỏ có số/vị, hay "đổi/chỉ lấy…" thì theo giỏ mới.
  const nguyenBanOpen = Math.round(Number(context.pendingOrder?.nguyenBanAsk) || 0);
  if (nguyenBanOpen > 0 && !updating && !fromCart && !paymentMessage && isOrderStep(templateId) && templates.ASK_FLAVOR_NGUYENBAN && pending) {
    const quantityOf = list => (list || []).reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
    const statedBasket = Object.keys(colourCountsInText(customerText).counts).length > 0 || countBags(customerText) > 0 || replacesHeld;
    if (!statedBasket && quantityOf(items) < quantityOf(pending.items) + nguyenBanOpen) {
      return {
        templateId: 'ASK_FLAVOR_NGUYENBAN',
        ...splitMessages(fill(templates.ASK_FLAVOR_NGUYENBAN, commonValues())),
        handoff: false,
        pendingOrder: { ...(nextPending || {}), items: pending.items || [], key: pending.key || '', at: pending.at || now, askedBagCount: Number(context.pendingOrder?.askedBagCount) || nguyenBanOpen, nguyenBanAsk: nguyenBanOpen }
      };
    }
  }
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
    if (templates.ASK_FLAVOR && /\b(\d{1,2}|mot|hai|ba)\s*(tui|goi|bich|bit)\b/.test(normalizeText(customerText))) {
      // Vòng 12: nhớ số túi khách vừa nêu ("Cho mình 2 túi" + SĐT) để tin trả lời vị sau ("Túi vàng") đủ 2 túi.
      const askedBagCount = countBags(customerText);
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
    // R14 (quyết định 5, ca …211779 "Lấy 1 túi 174k" → bị mời ngay trước phiếu → "Đã mua 1 mà hỏi hoài"; …580804 "1 túi dùng
    // thử"): khách nêu "1 túi + giá", "1 túi dùng/ăn thử", "dùng thử" — ở tin này hay một tin gần đây — là đã chọn 1 túi.
    const ONE_BAG_FIRM = /\b(thoi|chi (lay|mua|can|lay thu)|(1|mot) (tui|goi|hop|bich) (thoi|la du|da|truoc)|(dung|an|lay|mua) thu|(1|mot) (tui|goi|hop|bich)(?: [a-z]+){0,3} (?:\d{2,3} ?k|\d{2,3}(?:\.|,)?000|\d{2,3} ngan|dung thu|an thu))\b/;
    const recentTexts = (Array.isArray(context.recentCustomerTexts) ? context.recentCustomerTexts : []).map(text => normalizeText(String(text || ''))).slice(-6);
    const oneBagSaid = [...recentTexts, messageWords].filter(text => /\b(1|mot) (tui|goi|bich|hop)\b/.test(text)).length;
    const declinesUpsell = ONE_BAG_FIRM.test(messageWords) || recentTexts.some(text => ONE_BAG_FIRM.test(text)) || oneBagSaid >= 2;
    // Không mời khi khách đã gửi SĐT cho đơn 1 túi (lời mời tới ngay trước phiếu), hay tin đã nêu 2 túi trở lên.
    const upsell = price?.totalQuantity === 1 && !trial && templates.UPSELL_TWO_BAGS && !pending?.upsold && !context.noUpsell && !declinesUpsell
      && !hasPhone && countBags(customerText) < 2 ? upsellTwoBags(price, templates) : '';
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
    // R16 (inbox5 A8, ca …2228921202 đổi địa chỉ đơn live): mẫu ORDER_UPDATED đang chạy không có {gift} → câu "em đã sửa lại
    // đơn" bỏ mất dòng quà dù đơn vẫn giữ quà (khách tưởng mất quà). Mẫu không có {gift} mà đơn có quà hiện vật → chèn dòng
    // "🎁 Tặng kèm: …" ngay sau dòng tổng tiền (mẫu đã có {gift} thì theo mẫu).
    const updatedGift = price.gifts.filter(gift => !isFreeShippingGift(gift)).map(gift => gift.name).join(' + ');
    const updatedBase = templates.ORDER_UPDATED || templates.ORDER_CONFIRMATION;
    const updatedTemplate = updatedGift && !String(updatedBase).includes('{gift}')
      ? (/^[^\n]*\{total\}[^\n]*$/m.test(updatedBase) ? updatedBase.replace(/^([^\n]*\{total\}[^\n]*)$/m, '$1\n🎁 Tặng kèm: {gift}') : `${updatedBase}\n🎁 Tặng kèm: {gift}`)
      : updatedBase;
    const updated = fill(updatedTemplate, {
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
      order: { items: orderItems, phone, address: deliveryAddress, rawAddress: address, total, subtotal: price.subtotal, shippingFee: price.shippingFee, orderKey: key, gift: price.gift, ...giftSwapOrderFields(price), updateOrderId: String(recentOrder.id), ...(trialPriced ? { trial: true } : {}), ...(promoBowl ? { promoGift: PROMO_BOWL_GIFT.name } : {}), ...orderNoteFields }
    };
  }
  return {
    templateId: 'ORDER_CONFIRMATION',
    // The confirmation, then the delivery policy and the after-sale note —
    // each one is a template of its own so staff can rewrite or blank it.
    messages: [confirmation, fill(templates.SHIPPING_POLICY, commonValues()), fill(templates.ORDER_AFTER_SALE, commonValues())].flatMap(text => splitMessages(text).messages).slice(0, 3),
    images: [],
    handoff: false,
    // Vòng 13: đơn đã đổi quà (2 gói nhỏ thay bát/quạt/muỗng) → thẻ cho nhân viên soát dòng quà trên POS/kho.
    ...(price.giftSwap ? { attention: true } : {}),
    // Cleared: the basket has become a real order.
    pendingOrder: null,
    order: { items: orderItems, phone, address: deliveryAddress, rawAddress: address, total, subtotal: price.subtotal, shippingFee: price.shippingFee, orderKey: key, gift: price.gift, ...giftSwapOrderFields(price), ...(trialPriced ? { trial: true } : {}), ...(promoBowl ? { promoGift: PROMO_BOWL_GIFT.name } : {}), ...orderNoteFields }
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

// ===== Vòng 13 (inbox2 B3): khách ĐÃ CÓ ĐƠN hỏi quà =====
// Mẫu quà mời đặt (GIFT_POLICY_LIVE "…lấy 2 túi vị nào để em lên đơn liền nha?", GIFT_POLICY_PROMO, GIFT_POLICY_UPSELL3)
// gửi cho khách vừa chốt đơn là mời đặt lại đơn đã có. Khi khách có đơn (context.hasOrder — engine truyền; chưa truyền thì
// tự xét đơn gần nhất chưa hủy trong 24 giờ như engine) → nói quà của CHÍNH ĐƠN ĐÓ, không mời đặt.
// R14: GIFT_POLICY (seed mới kết bằng "lấy mấy túi để em lên đơn kèm quà") cũng là lời mời đặt.
const giftInviteTemplateIds = new Set(['GIFT_POLICY', 'GIFT_POLICY_LIVE', 'GIFT_POLICY_PROMO', 'GIFT_POLICY_UPSELL3']);
// Lời dự phòng (như fallbackTemplates của engine): mẫu cùng mã trong Cài đặt → Thiết lập tin nhắn thì dùng mẫu đó.
// R13 (gộp): hai mẫu này ĐÃ có trong seed (chủ shop sửa lời ở Cài đặt → Tin nhắn); bảng dưới chỉ còn dùng khi nơi gọi
// truyền bộ mẫu thiếu mã (test, cấu hình cũ chưa qua normalizeChatbotSettings). Trong intent-cascade là OTHER có chủ ý.
// Giá trị: {items} giỏ của đơn, {gift} quà hiện vật của đơn, {free_ship}, [[gifts]] bảng quà hiện hành ({gifts}: {rule}).
export const orderGiftFallbackTemplates = Object.freeze({
  GIFT_POLICY_ORDER: 'Dạ đơn {items} của {title} đã có quà tặng kèm {gift} rồi ạ 🎁 Bên em gửi quà cùng đơn cho mình nha 💛',
  GIFT_POLICY_ORDER_NONE: 'Dạ đơn {items} của {title}[?free_ship] được {free_ship}[/?] ạ; đơn này chưa kèm quà tặng hiện vật ạ 🌾 Chương trình quà hiện tại bên em:\n[[gifts]]• {gifts}: {rule}[[/gifts]]'
});
const seedTemplate = id => String(orderGiftFallbackTemplates[id] || '').trim();

// R15 (03/10): lời dự phòng cho mẫu MỚI của vòng 15 — cùng lời với seed. Máy chủ chạy theo mẫu trong Cài đặt (normalize
// chỉ thêm mã seed còn thiếu, không đè mẫu cũ); bảng này dùng khi nơi gọi đưa bộ mẫu thiếu mã (test, cấu hình cũ chưa qua
// normalizeChatbotSettings). Mẫu trống trong Cài đặt ('' = tắt) vẫn là tắt. ORDER_EXISTING_CONFIRM: lời mới (hỏi gộp/tách,
// chủ shop 03/10) chỉ dùng khi bộ mẫu thiếu mã — lời đang chạy trên máy chủ phải áp qua Cài đặt.
// Quà yến mạch khách quen (chủ shop 03/10): chưa có quy cách/mã POS → chữ chung, sửa một chỗ ở đây khi có mã.
export const OATS_GIFT_LABEL = '';
export const OATS_GIFT_NAME = '';
export const r15FallbackTemplates = Object.freeze({
  BOUGHT_ON_MARKETPLACE: 'Dạ em cảm ơn {title} đã ủng hộ nhà Nắng trên sàn ạ 💛 Đơn trên sàn mình cần hỗ trợ gì thì {title} nhắn em mã đơn để em kiểm tra giúp nha ạ.',
  BAG_SIZE_INFO: 'Dạ túi lớn nhất bên em là {product} (vị nguyên bản) ạ. {Title} cần dùng nhiều thì lấy combo 3 túi[?weight_3] ({weight_3})[/?] chỉ {price_3}[?free_ship_3] ({free_ship_3})[/?][?gift_3], tặng kèm {gift_3}[/?] nha ạ 🌾',
  PHONE_LOOKS_SHORT: 'Dạ số điện thoại [?phone]{phone} [/?]hình như còn thiếu 1 số, {title} kiểm tra lại giúp em nha ạ.',
  FRUIT_PAIRING: 'Dạ granola bên em ăn kèm trái cây nào cũng hợp ạ: thanh long, chuối, táo, dâu… Trộn thêm sữa chua hoặc sữa hạt thì càng ngon và no lâu nha {title} 🌾',
  DISCOUNT_OATS_GIFT: 'Dạ giá combo bên em đã là giá tốt nhất rồi nên em không giảm thêm được ạ 💛[?enough] Combo bên em đã được hỗ trợ miễn phí vận chuyển rồi nha {title} 🌾[?gift]\n🎁 Quà tặng kèm: {gift} ạ.[/?][/?][?invite] {Title} lấy từ combo 2 túi ({two_price}, miễn phí vận chuyển)[?two_gift] và được tặng kèm {two_gift}[/?] là tiết kiệm nhất nha ạ 🌾[/?]\nGiỏ của mình: {cart} – {total} ạ.',
  ORDER_ADDRESS_OLD_NOT_FOUND: 'Dạ em chưa tìm thấy địa chỉ cũ theo số này ạ, {title} gửi giúp em địa chỉ nhận hàng (số nhà, đường, phường/xã, tỉnh) để em lên đơn liền nha ạ.',
  SMALL_PACK_FLAVOURS: 'Dạ combo 10 gói nhỏ hiện bên em chỉ còn vị Xanh nguyên bản ạ (dễ ăn, cân bằng). {Title} cần em gửi bảng giá combo 10 gói không ạ?',
  // R15 (inbox1 A5): khách đã nêu màu ({named}) thì không hỏi lại "vị nào". Mã đã có trong seed → bảng này chỉ khi bộ mẫu thiếu mã.
  PRICE_COUNT: 'Dạ {count} túi ({kind}) giá {total}[?ship] + phí ship {ship}[/?][?free], miễn phí vận chuyển[/?][?gift], tặng {gift}[/?] ạ 🌾[?named] {Title} lấy luôn {count} {kind} để em lên đơn liền cho mình nha?[/?][?pick] {Title} lấy {count} túi vị nào để em lên đơn liền cho mình nha?[/?]',
  ORDER_EXISTING_CONFIRM: 'Dạ {title} ơi, em thấy mình đang có đơn {existing_items} đặt lúc {existing_at}, hiện {existing_state} ạ 🌾 {Title} muốn em gộp {cart} vào đơn đang có, hay tách thành đơn mới (em gửi cùng địa chỉ cũ) ạ?'
});
// R16 (05/10, inbox5 A6): mẫu MỚI — khách gửi tin nhắn thoại (bot không nghe được). Cùng lời với seed; engine chọn mẫu khi
// tin là audio. Trong intent-cascade thuộc SUPPORT (như IMAGE_RECEIVED), không vào ANSWER.
export const r16FallbackTemplates = Object.freeze({
  VOICE_RECEIVED: 'Dạ em chưa nghe được tin nhắn thoại ạ, {title} nhắn chữ giúp em nha ạ 💛'
});
const fallbackTemplateIds = [...Object.keys(r15FallbackTemplates), ...Object.keys(r16FallbackTemplates)];
/** Bộ mẫu + lời dự phòng R15/R16 cho mã còn thiếu (mẫu trong Cài đặt luôn thắng, kể cả mẫu trống = tắt). */
function withR15Fallbacks(templates) {
  const given = templates && typeof templates === 'object' ? templates : {};
  if (fallbackTemplateIds.every(id => Object.hasOwn(given, id))) return given;
  return { ...r15FallbackTemplates, ...r16FallbackTemplates, ...given };
}

/**
 * R15: SĐT khách gõ THIẾU một số — 9 chữ số mở bằng 0 (03/05/07/08/09), hay 8 chữ số sau +84/84. Tin đã có SĐT đủ thì
 * không tính. Trả số như khách gõ (chỉ chữ số, giữ +84/84), '' nếu không có. Hàm thuần — engine dùng để hỏi lại
 * (mẫu PHONE_LOOKS_SHORT), chưa nối vào engine.
 * @param {string} text
 * @returns {string}
 */
export function phoneLooksShort(text) {
  const raw = String(text ?? '');
  if (extractVietnamesePhone(raw)) return '';
  // R15 sửa (phản biện luật, THẤP): số tài khoản / mã vận đơn 9 số không phải SĐT thiếu số.
  const folded = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  if (/\b(?:stk|so tai khoan|tai khoan|tk|ma (?:van )?don|mvd|ck|chuyen khoan)\b/.test(folded)) return '';
  // Dãy số có thể chia bằng dấu chấm/gạch/một khoảng trắng ("091 234 567"); không dính chữ số / chữ cái hai đầu.
  for (const match of raw.matchAll(/(?<![\p{L}\p{N}+])(\+?)(\d(?:[.\- ]?\d)+)(?![\p{L}\p{N}])/gu)) {
    const digits = match[2].replace(/\D/g, '');
    if (/^0[35789]\d{7}$/.test(digits)) return digits;
    if (/^84[35789]\d{7}$/.test(digits)) return `${match[1]}${digits}`;
  }
  return '';
}

function hasOrderContext(context = {}) {
  if (typeof context.hasOrder === 'boolean') return context.hasOrder && Boolean(context.recentOrder);
  const order = context.recentOrder;
  const now = Number(context.now) || Date.now();
  return Boolean(order?.id) && String(order.processingStatus || '') !== 'cancelled' && order.status !== 'Hủy'
    && now - (Number(order.createdAt) || 0) < orderCancelWindowMs;
}

/**
 * Câu trả lời "quà của đơn mình" cho khách đã có đơn: "Dạ đơn 2 Granola Túi Vàng 350g của chị đã có quà tặng kèm
 * Quạt + Bát gáo dừa rồi ạ…" (mẫu GIFT_POLICY_ORDER); đơn không có quà hiện vật → GIFT_POLICY_ORDER_NONE (nêu đơn +
 * bảng quà hiện hành, không mời đặt). Quà lấy từ chữ quà đã ghi trên đơn (order.gift, kể cả quà đã đổi), không có thì
 * tính theo bảng quà cho giỏ của đơn (đơn live: kèm quà live). Không có đơn → null.
 * Engine có thể gọi thẳng (chọn mẫu quà ở contextualReply) hoặc cứ gọi renderChatbotReply với GIFT_POLICY_LIVE/PROMO/
 * UPSELL3 và context.hasOrder — bộ soạn tự đổi sang biến thể này (giữ templateId đã gọi, thêm `variant`).
 * @param {Record<string,string>} templates
 * @param {{ recentOrder?: object, customer?: object, livestream?: boolean }} context
 * @returns {{ templateId: 'GIFT_POLICY_ORDER', variant: string, messages: string[], images: string[], parts: object[], handoff: false, orderGift: string }|null}
 */
export function renderOrderGiftReply(templates = {}, context = {}) {
  const order = context.recentOrder || null;
  if (!order) return null;
  activeCustomer = context.customer || activeCustomer || {};
  const products = Array.isArray(order.products) ? order.products : Array.isArray(order.items) ? order.items : [];
  const lines = products.map(item => {
    const product = findProductBySku(item.sku || item.code) || matchProduct(String(item.name || item.product || ''));
    return { sku: product?.sku || '', name: product?.name || String(item.name || item.product || item.sku || 'sản phẩm'), quantity: Math.max(1, Math.round(Number(item.quantity) || 1)) };
  });
  const items = lines.map(line => `${line.quantity} ${line.name}`).join(' + ');
  const livestream = typeof order.livestream === 'boolean' ? order.livestream : context.livestream === true;
  const priced = lines.length && lines.every(line => line.sku) ? priceBasket(lines.map(line => ({ sku: line.sku, quantity: line.quantity })), { livestream }) : null;
  const recorded = typeof order.gift === 'string' && order.gift.trim()
    ? order.gift.replace(/\s*\(đổi quà:[^)]*\)/giu, '').split(' + ').map(part => part.trim()).filter(Boolean)
    : (priced?.priceable ? priced.gifts.map(gift => gift.name) : []);
  const promo = String(order.promoGift || '').trim();
  const names = [...new Set([...recorded, ...(promo ? [promo] : [])])];
  const freeShip = names.find(name => isFreeShippingGift({ name })) || (order.freeShipping === true ? 'Miễn phí vận chuyển' : '');
  const gift = names.filter(name => !isFreeShippingGift({ name })).join(' + ');
  const id = gift ? 'GIFT_POLICY_ORDER' : 'GIFT_POLICY_ORDER_NONE';
  const template = String(templates[id] || '').trim() || seedTemplate(id);
  if (!template) return null;
  const policy = describeGiftTable().map(line => line.replace(/^- /, '')).map(line => {
    const at = line.indexOf(': ');
    return at > 0 ? { gifts: line.slice(0, at), rule: line.slice(at + 2) } : null;
  }).filter(Boolean);
  const text = fill(template, { ...commonValues(), items: items || 'vừa đặt', gift, free_ship: freeShip }, { gifts: policy });
  if (!text) return null;
  return { templateId: 'GIFT_POLICY_ORDER', variant: id, ...splitMessages(text), handoff: false, orderGift: gift };
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
  // Đơn đã có vận đơn Sapo (app/sapo-tracking.mjs): kể hãng, mã vận đơn, giai đoạn giao và link tra
  // (mẫu ORDER_STATUS_SHIPPED; để trống mẫu đó thì nói như cũ).
  const storedShipped = String(templates.ORDER_STATUS_SHIPPED || '').trim();
  const shippedTemplate = storedShipped && storedShipped === LEGACY_SHIPMENT_TEMPLATES.ORDER_STATUS_SHIPPED ? String(defaultMessageTemplates().ORDER_STATUS_SHIPPED || '').trim() : storedShipped;
  if (!cancelled && shippedTemplate && order.shipment?.trackingNumber && shipmentStage(order.shipment)) {
    // fill() bỏ cả dòng có ô trống: {tracking_hint} (chỉ J&T có) phải nằm riêng một dòng trong mẫu, không thì
    // dòng link tra của SPX bị bỏ theo; bỏ xuống dòng đầu của gợi ý vì mẫu đã xuống dòng sẵn.
    const values = shipmentTemplateValues(order.shipment, activeCustomer.gender);
    return fill(shippedTemplate, { ...commonValues(), items, ordered_at: orderedAt, total: formatMoney(Number(order.total) || 0), ...values, tracking_hint: values.tracking_hint.replace(/^\n/, '') });
  }
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
  DISCOUNT_POLICY: (value, templates) => renderDiscountPolicy(value, templates),
  BAG_SIZE_INFO: (value, templates) => renderBagSizeInfo(templates)
};

/**
 * R15 BAG_SIZE_INFO ("túi to nhất", "loại nào nặng nhất"): túi lớn nhất = sản phẩm ghép combo đang bán có khối lượng lớn
 * nhất (Túi Xanh 450g); bậc 3 túi (khối lượng, giá, miễn ship, quà) đọc từ bảng giá như PRICE_QUOTE — không ghi cứng số.
 */
function renderBagSizeInfo(templates) {
  const biggest = getCatalogProducts().filter(product => product.active && !product.staffOnly && product.mixable && product.weight > 0)
    .sort((a, b) => b.weight - a.weight)[0];
  const quote = biggest ? quoteTiers(biggest.sku, giftContext()) : null;
  if (!quote) return fill(templates.BAG_SIZE_INFO, { ...commonValues(), product: biggest?.name || 'Túi Xanh 450g' });
  const values = { ...commonValues(), product: quote.product.name, weight: formatWeight(quote.product.weight) };
  for (const tier of quote.tiers) {
    const n = tier.quantity;
    Object.assign(values, {
      [`weight_${n}`]: formatWeight(tier.weight).replace('.', ','),
      [`price_${n}`]: formatMoney(tier.price),
      ...Object.fromEntries(Object.entries(basketValues(comboKey([{ sku: quote.product.sku, quantity: n }]))).map(([k, v]) => [`${k}_${n}`, v]))
    });
  }
  return fill(templates.BAG_SIZE_INFO, values);
}

/**
 * DISCOUNT_OATS_GIFT: khách mặc cả / xin giảm giá: không giảm thêm vì giá combo đã là giá tốt nhất.
 * Giỏ >= 2 túi: báo đã miễn ship (kèm quà nếu có); dưới 2 túi: mời lên combo 2 để được miễn ship (+ quà live nếu live).
 */
function renderDiscountOatsGift(templates, context = {}) {
  const now = Number(context.now) || Date.now();
  const held = usablePendingOrder(context.pendingOrder, { now, templateId: 'ORDER_ADDRESS' });
  const heldItems = held?.items || [];
  const heldCount = heldItems.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
  const bagCount = Number(context.bagCount) > 0 ? Number(context.bagCount) : heldCount;
  const priced = heldItems.length ? priceBasket(heldItems, giftContext()) : null;
  const firstSku = priced?.lines?.[0]?.sku || getCatalogProducts().find(product => product.active && product.mixable && !product.staffOnly)?.sku || '';
  const two = firstSku ? priceBasket([{ sku: firstSku, quantity: 2 }], giftContext()) : null;
  const enough = bagCount >= 2;
  const giftText = (priced?.gifts || []).filter(g => !isFreeShippingGift(g)).map(g => g.name).join(' + ');
  const twoGiftText = (two?.gifts || []).filter(g => !isFreeShippingGift(g)).map(g => g.name).join(' + ');
  return fill(templates.DISCOUNT_OATS_GIFT, {
    ...commonValues(),
    enough: enough ? '1' : '',
    invite: enough ? '' : '1',
    gift: giftText,
    two_gift: twoGiftText,
    two_price: two?.priceable ? formatMoney(two.total) : '298.000đ',
    cart: priced?.priceable ? priced.lines.map(line => `${line.quantity} ${line.name}`).join(' + ') : '',
    total: priced?.priceable ? formatMoney(priced.total) : ''
  });
}

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
  'ORDER_EXISTING_CONFIRM_PHONE',
  // Vòng 13: quà của đơn đã có (bộ soạn tự chọn khi khách có đơn hỏi quà).
  'GIFT_POLICY_ORDER', 'GIFT_POLICY_ORDER_NONE',
  // Vòng 13 (gộp): mẫu engine tự chọn vừa đưa vào seed — giỏ Facebook Shop (mã lạ / món nhân viên lên đơn / đã nhận giỏ),
  // ghi nhận quà thay. Mô hình không gọi tên, không hiện trong danh sách mẫu của prompt.
  'SHOP_CART_UNKNOWN', 'SHOP_CART_STAFF', 'SHOP_CART_ACK', 'GIFT_SWAP_NOTED', 'STAFF_WAIT_OPEN', 'STAFF_WAIT_CLOSED',
  // 05/10: đổi quạt → muỗng dừa (khách live) và "quà đã có muỗng" — engine tự chọn khi việc đó thật sự xảy ra.
  'GIFT_FAN_TO_SPOON', 'GIFT_SPOON_INCLUDED',
  // 03/10: báo hành trình vận đơn Sapo theo giai đoạn (app/sapo-sync.mjs) + trả lời "đơn tới đâu" khi đã có vận đơn.
  'ORDER_STATUS_SHIPPED', 'SHIPMENT_CREATED', 'SHIPMENT_PICKED_UP', 'SHIPMENT_IN_TRANSIT', 'SHIPMENT_OUT_FOR_DELIVERY', 'SHIPMENT_DELIVERED',
  // R15: engine tự chọn — SĐT thiếu số (cần {phone}), không tra được địa chỉ cũ theo SĐT.
  'PHONE_LOOKS_SHORT', 'ORDER_ADDRESS_OLD_NOT_FOUND']);

// fix-bot T1 (01/10): mẫu "báo sự việc đã xảy ra" (đã nhận đơn Shop, đã hủy/sửa/ghi chú đơn, đã nhận deal live, đơn
// đang có…) — chỉ engine được chọn khi việc đó thật sự xảy ra; mô hình trả các mã này thì luôn đổi về GENERAL_INFO.
const engineFactTemplateIds = new Set(['SHOP_ORDER_RECEIVED', 'ORDER_CANCELLED', 'ORDER_UPDATED', 'ORDER_UNCHANGED', 'ORDER_NOTE_ADDED', 'LIVE_DEAL_CLAIMED', 'ORDER_EXISTING_CONFIRM', 'ORDER_EXISTING_CONFIRM_PHONE',
  // R13 (gộp): "đã nhận giỏ Shop", "đã ghi nhận thay quà" — chỉ engine chọn khi việc đó thật sự xảy ra.
  'SHOP_CART_UNKNOWN', 'SHOP_CART_STAFF', 'SHOP_CART_ACK', 'GIFT_SWAP_NOTED', 'STAFF_WAIT_OPEN', 'STAFF_WAIT_CLOSED', 'GIFT_FAN_TO_SPOON', 'GIFT_SPOON_INCLUDED']);
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
    // R15 (inbox3 A5): nhớ mô hình đã chọn "đơn giữ nguyên" — renderSingleReply sửa đơn khi tin có SĐT/địa chỉ khác đơn.
    if (templateId === 'ORDER_UNCHANGED') clean.modelOrderUnchanged = '1';
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
// R14 (H3, ca …265828 "Chị chốt một túi xanh" + RECOMMEND_BEGINNER "lấy 1 túi thử hay combo 2?"; …919462 đã chọn 2 túi +
// FREESHIP_POLICY "lấy 2 túi vị nào"): bước đơn ĐÃ CÓ MÓN thì không ghép câu kèm mà cả câu là mời chọn túi/vị/số lượng.
const alsoInviteWhenBasket = new Set(['RECOMMEND_BEGINNER', 'ASK_FLAVOR_NGUYENBAN', 'COMBO3_FLAVOR', 'UPSELL_TWO_BAGS', 'TRIAL_NEXT_STEP', 'ASK_TWO_BAGS', 'ASK_REORDER', 'IMAGE_WITH_PHONE', 'PRICE_COUNT']);
// Câu kèm còn lại (có thông tin thật: FREESHIP_POLICY, GIFT_POLICY, KIDS_FAMILY, DISCOUNT_POLICY…) mà kết bằng câu mời chọn
// ("lấy 2 túi vị nào…", "lấy mấy túi để em lên đơn…"): giữ phần trả lời, cắt câu mời cuối.
// Một câu = chữ giữa hai dấu kết câu (. ! ? xuống dòng, emoji 🌾💛🎁✨); dấu chấm trong số tiền ("432.000đ") không kết câu.
const INVITE_SENTENCE = /(?:^|(?<=[!?\n🌾💛🎁✨]|\.(?=\s)))\s*(?:[^.!?\n🌾💛🎁✨]|\.(?=\d))*?(?<![\p{L}])(?:lấy|chọn|thử)(?![\p{L}])(?:[^.!?\n🌾💛🎁✨]|\.(?=\d))*?(?:nào|hay|mấy|không ạ|lên đơn)(?:[^.!?\n🌾💛🎁✨]|\.(?=\d))*?[.!?]?\s*(?:[🌾💛🎁✨]\s*)*$/u;
/** Câu trả lời đã bỏ câu mời chọn cuối (dùng cho câu kèm khi bước đơn đã có món). */
export function withoutInviteTail(text) {
  return trimInviteTail([{ type: 'text', text: String(text ?? '') }]).map(part => part.text).join('\n');
}
function trimInviteTail(parts) {
  const list = [...parts];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index].type !== 'text') continue;
    const trimmed = list[index].text.replace(INVITE_SENTENCE, '').trim();
    if (trimmed === list[index].text) return list;
    if (trimmed && /\p{L}/u.test(trimmed)) list[index] = { ...list[index], text: trimmed };
    else list.splice(index, 1);
    return list;
  }
  return list;
}

/**
 * R14: giỏ chờ còn hạn có đúng 1 túi → tin "đơn của mình gồm 1 …, tổng 189.000đ (đã gồm 15.000đ phí ship)" + xin phần còn
 * thiếu (ORDER_CART_LINE + ORDER_ADDRESS/ORDER_ADDRESS_PARTIAL). Không giỏ 1 túi → null.
 */
function heldOneBagReply(templates, context = {}) {
  const pending = usablePendingOrder(context.pendingOrder, { now: Number(context.now) || Date.now(), templateId: 'ORDER_ADDRESS' });
  if (!pending?.items?.length || !templates.ORDER_CART_LINE) return null;
  const price = priceBasket(pending.items, giftContext());
  if (!price?.priceable || price.totalQuantity !== 1) return null;
  const hasPhone = Boolean(pending.phone);
  const hasAddress = Boolean(pending.address);
  const missing = hasPhone && !hasAddress ? 'địa chỉ nhận hàng đầy đủ' : !hasPhone && hasAddress ? 'số điện thoại' : 'số điện thoại và địa chỉ nhận hàng đầy đủ';
  const known = hasPhone ? 'số điện thoại' : hasAddress ? 'địa chỉ' : '';
  const cartLine = fill(templates.ORDER_CART_LINE, {
    ...commonValues(),
    cart: price.lines.map(line => `${line.quantity} ${line.name}`).join(' + '),
    total: formatMoney(price.total),
    free_ship: price.gifts.find(isFreeShippingGift)?.name || '',
    ship_fee: price.shippingFee ? formatMoney(price.shippingFee) : '',
    gift: price.gifts.filter(gift => !isFreeShippingGift(gift)).map(gift => gift.name).join(' + '),
    missing
  });
  const askTemplate = hasPhone && hasAddress ? '' : (known ? templates.ORDER_ADDRESS_PARTIAL : templates.ORDER_ADDRESS) || '';
  const askText = askTemplate ? fill(askTemplate, { ...commonValues(), missing, known }) : '';
  const text = askText ? `${cartLine}\n${askText.replace(/^Dạ,?\s+(\p{L})/u, (_, first) => first.toUpperCase())}` : cartLine;
  return { templateId: 'FREESHIP_POLICY', ...splitMessages(text), handoff: false };
}

/**
 * Khách vừa đặt vừa hỏi ("cho chị 1 bịch vàng, bịch này có yến mạch không"):
 * mô hình chọn bước đơn ở template_id và câu hỏi kèm ở "also". Ý phụ là mẫu
 * thông tin có thật; đi trước câu xin SĐT/địa chỉ, sau câu trả lời thông tin.
 */
export function renderChatbotReply(value = {}, givenTemplates = {}, context = {}) {
  const templates = withR15Fallbacks(givenTemplates);
  const main = renderSingleReply(value, templates, context);
  const also = String(value?.also || '').trim();
  if (!also || also === '0' || also === main.templateId || also.startsWith('ORDER_') || alsoBlocked.has(also) || main.handoff) return main;
  if (!templates[also] && !catalogRenderers[also] && !isProductQuoteId(also)) return main;
  // R14 (H3): bước đơn đã có món → không mời chọn lại.
  const mainBasket = (isOrderStep(main.templateId) || main.templateId === 'ORDER_CUSTOM_BASKET') && (Boolean(main.pendingOrder?.items?.length) || Boolean(main.order));
  if (mainBasket && alsoInviteWhenBasket.has(also)) return main;
  const rendered = renderSingleReply({ template_id: also, Product_N1: value.Product_N1 }, templates, { ...context, alsoRender: true });
  if (rendered.handoff || rendered.templateId !== also && !isProductQuoteId(also)) return main;
  const extraParts = mainBasket ? trimInviteTail(rendered.parts || rendered.messages.map(text => ({ type: 'text', text }))) : null;
  const extra = extraParts ? { ...rendered, parts: extraParts, messages: extraParts.filter(part => part.type === 'text').map(part => part.text) } : rendered;
  if (!extra.messages.length) return main;
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
  // R13 sửa (C1): engine báo giỏ/đơn đang xét không có quà hiện vật (context.giftSwappable === false) → giữ GIFT_POLICY, không hứa đổi.
  if (templateId === 'GIFT_POLICY' && templates.GIFT_SWAP && isGiftSwapRequest(context.messageText) && context.giftSwappable !== false) {
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
  // Vòng 13 (inbox2 B3): khách đã có đơn hỏi quà → quà của chính đơn đó, không dùng mẫu mời đặt.
  if (giftInviteTemplateIds.has(templateId) && hasOrderContext(context)) {
    const orderGift = renderOrderGiftReply(templates, context);
    if (orderGift) return { ...orderGift, templateId };
  }
  // R14: mô hình chọn STAFF_ONLY_PRODUCT — {product} lấy từ Product_N1 (trống thì "sản phẩm mình hỏi"; trước đây dòng có
  // {product} trống bị bỏ → tin rỗng) và gắn thẻ cần người.
  if (templateId === 'STAFF_ONLY_PRODUCT' && templates.STAFF_ONLY_PRODUCT) {
    const named = String(value.Product_N1 || '').trim();
    const product = named && named !== '0' ? (matchStaffOnlyProduct(named)?.name || matchProduct(named)?.name || named) : 'sản phẩm mình hỏi';
    return { templateId, ...splitMessages(fill(templates.STAFF_ONLY_PRODUCT, { ...commonValues(), product })), handoff: false, attention: true };
  }
  // R14 (quyết định 5, ca …541740): hỏi phí ship khi đang giữ giỏ 1 túi → báo đúng tổng của giỏ (174k + ship = 189k) và xin
  // phần còn thiếu, không mời lại "lấy 2 túi vị nào".
  if (templateId === 'FREESHIP_POLICY' && !context.alsoRender) {
    const held = heldOneBagReply(templates, context);
    if (held) return held;
  }
  // R15 (inbox3 A5): mô hình chọn ORDER_UNCHANGED ("đơn đã lên rồi") — sanitizeModelAnswer đổi mã này về GENERAL_INFO và
  // đánh dấu modelOrderUnchanged — mà tin có SĐT/địa chỉ KHÁC đơn bot vừa chốt (≤ 60 phút, chưa giao, bot tự lên) → sửa đơn
  // (nhánh ORDER_UPDATE), không bỏ SĐT mới.
  if ((templateId === 'ORDER_UNCHANGED' || (templateId === 'GENERAL_INFO' && String(value.modelOrderUnchanged || '') === '1')) && !context.alsoRender) {
    const recent = context.recentOrder || null;
    const now = Number(context.now) || Date.now();
    const open = Boolean(recent?.id) && recent.source !== 'POS' && recent.automatic !== false && String(recent.processingStatus || '') !== 'cancelled' && recent.status !== 'Hủy'
      && !/đã giao|đang giao|đã gửi/i.test(String(recent.status || '')) && now - (Number(recent.createdAt) || 0) < orderUpdateWindowMs;
    if (open && contactDiffersFromOrder(recent, context.messageText, value.Customer_Address)) {
      return renderOrder({ ...value, template_id: 'ORDER_UPDATE', Product_N1: '0', No_A: '0', Product_N2: '0', No_B: '0', Product_N3: '0', No_C: '0' }, templates, context);
    }
  }
  // R15: mặc cả → không giảm, tặng yến mạch theo số túi (renderDiscountOatsGift).
  if (templateId === 'DISCOUNT_OATS_GIFT' && templates.DISCOUNT_OATS_GIFT) {
    return { templateId, ...splitMessages(renderDiscountOatsGift(templates, context)), handoff: false };
  }
  // R15: SĐT thiếu số — {phone} engine đưa qua values.phone, không có thì đọc từ tin khách.
  if (templateId === 'PHONE_LOOKS_SHORT' && templates.PHONE_LOOKS_SHORT) {
    const given = value.values && typeof value.values === 'object' ? String(value.values.phone || '') : '';
    return { templateId, ...splitMessages(fill(templates.PHONE_LOOKS_SHORT, { ...commonValues(), phone: given || phoneLooksShort(context.messageText) })), handoff: false };
  }
  // R15 (inbox1 A5): PRICE_COUNT — luật đưa values.named (khách ĐÃ nêu màu: "3 túi xanh") hay values.pick (chưa nêu). Nơi gọi
  // cũ không đưa cờ nào (engine "N túi mix vị tùy ý") → coi như pick (hỏi vị như trước). Mẫu cũ không có khối thì bỏ qua cờ.
  if (templateId === 'PRICE_COUNT' && templates.PRICE_COUNT && value.values && typeof value.values === 'object') {
    const given = value.values;
    const named = String(given.named || '') === '1';
    return { templateId, ...splitMessages(fill(templates.PRICE_COUNT, { ...commonValues(), ...given, named: named ? '1' : '', pick: named ? '' : '1' })), handoff: false };
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
  // R16 (inbox3 A4, ca …8987226913): địa chỉ khách đã gửi ở tin trước (giỏ chờ đã lưu, hay một tin gần đây có địa chỉ đọc
  // được) → KHÔNG dùng mẫu xin "kèm địa chỉ nhận hàng đầy đủ" (khách vừa gửi), dùng ORDER_INFO_ASK_FLAVOR ("đã nhận SĐT và
  // địa chỉ … lấy vị nào").
  const addressKnown = () => Boolean(String(context.pendingOrder?.address || '').trim())
    || (Array.isArray(context.recentCustomerTexts) ? context.recentCustomerTexts.slice(-4) : []).some(text => {
      const raw = String(text || '');
      if (!raw.trim() || raw === String(context.messageText || '') || isShopCartText(raw)) return false;
      const delivery = describeDeliveryAddress(raw);
      return Boolean(delivery?.resolved?.province && (delivery.resolved.district || delivery.resolved.ward));
    });
  if (templateId === 'ORDER_INFO_ASK_FLAVOR' && String(value.Phone_Number || '').trim() && !String(value.Customer_Address || '').trim() && templates.ORDER_PHONE_ASK_FLAVOR && !addressKnown()) {
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
