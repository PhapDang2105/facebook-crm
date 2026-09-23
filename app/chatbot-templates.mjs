import { describeGiftTable, priceBasket, quoteTiers, shippingFeeForKey } from './processing/pricing.mjs';
import { comboKey, getCatalogProducts, getGifts, getShippingFee, giftsForKey, isFreeShippingGift, listCombos, matchProduct, maxComboQuantity, normalizeText } from './processing/catalog.mjs';
import { metaConfig } from './config.mjs';
import { orderKey as buildOrderKey, toPricedItems } from './processing/order-key.mjs';
import { isOrderStep, usablePendingOrder } from './processing/pending-order.mjs';
import { extractVietnamesePhone, toLocalPhone } from './processing/customer-info.mjs';
import { describeDeliveryAddress, mergeAddressFragment } from './processing/locations.mjs';

// The bot asks for a missing or ambiguous part of the address at most this
// many times, then lets the order through with what it has (flagged on the
// order) rather than trapping the customer in a loop.
export const maxAddressAsks = 2;
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
  return cleaned.join('\n').replace(/\n?###\n?/g, '###').replace(/[ \t]+$/gm, '').replace(/ {2,}/g, ' ').replace(/\(\s*\)/g, '').trim();
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
function splitMessages(text) {
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
  const gifts = giftsForKey(key);
  const free = gifts.find(isFreeShippingGift);
  return {
    free_ship: free ? free.name : '',
    ship_fee: free ? '' : (shippingFeeForKey(key) ? formatMoney(shippingFeeForKey(key)) : ''),
    gift: gifts.filter(gift => !isFreeShippingGift(gift)).map(gift => gift.name).join(' + ')
  };
}

// Khách vừa chốt một đơn rồi mua tiếp ("lấy thêm 2 túi vàng"): mô hình hay
// gộp cả sản phẩm của đơn đã chốt vào giỏ mới, giỏ thành tổ hợp không có giá
// và bot chuyển nhân viên. Trong hai giờ sau đơn gần nhất, món trùng đơn đó
// bị bỏ khi khách có nêu món mới; chỉ toàn món cũ thì giữ (khách nhắc lại).
const recentOrderWindowMs = 2 * 60 * 60 * 1000;
function dropRecentlyOrdered(items, recentOrder, now) {
  const at = Number(recentOrder?.createdAt) || 0;
  if (!at || now - at > recentOrderWindowMs) return items;
  const ordered = new Set((recentOrder.products || []).map(item => String(item.sku || item.code || '')).filter(Boolean));
  if (!ordered.size) return items;
  const additions = items.filter(item => !ordered.has(item.code));
  return additions.length && additions.length < items.length ? additions : items;
}

/** Lời gợi ý 2 túi cho giỏ 1 túi: số liệu lấy từ bộ giá, không tự ghi. */
function upsellTwoBags(price, templates) {
  const line = price.lines?.[0];
  if (!line) return '';
  const two = priceBasket([{ sku: line.sku, quantity: 2 }]);
  if (!two.priceable || !two.lines?.[0]) return '';
  const saving = Math.max(0, (Number(line.unitPrice) || 0) - (Number(two.lines[0].basketUnitPrice) || 0));
  return fill(templates.UPSELL_TWO_BAGS, {
    ...commonValues(),
    product: line.name,
    two_unit: formatMoney(two.lines[0].basketUnitPrice),
    saving: saving ? formatMoney(saving) : '',
    two_total: formatMoney(two.total),
    one_total: formatMoney(price.total),
    free_ship: two.shippingFee === 0 ? 'miễn phí vận chuyển' : '',
    // Miễn ship đã ghi ở {free_ship}; {gift} chỉ còn quà thật, không lặp lại.
    gift: (two.gifts || []).filter(gift => !isFreeShippingGift(gift)).map(gift => gift.name).join(' + ')
  });
}

function renderOrder(value, templates, context = {}) {
  const now = Number(context.now) || Date.now();
  const templateId = String(value.template_id || '').trim();
  const products = [value.Product_N1, value.Product_N2, value.Product_N3];
  const quantities = [value.No_A, value.No_B, value.No_C];
  // Khách nêu loại mà không nói số ("C đặt nhé" sau khi được báo giá): tính
  // là 1; khách muốn nhiều hơn sẽ nói ngay khi thấy xác nhận.
  const namedItems = toPricedItems(products.map((product, index) => ({
    product: String(product || '').trim(),
    quantity: Number(String(quantities[index] || '').replace(/\D/g, '')) || 1
  })).filter(item => item.product && item.product !== '0'));
  const freshItems = dropRecentlyOrdered(namedItems, context.recentOrder, now);

  // The price comes from the basket itself, never from a key the model
  // declared: an order_key the model invented used to price three bags as one.
  const freshKey = buildOrderKey(freshItems);
  const freshPrice = freshKey ? priceBasket(freshItems) : null;
  const pending = usablePendingOrder(context.pendingOrder, { now, templateId });
  const items = freshItems.length ? freshItems : (pending?.items || []);
  const key = freshKey || pending?.key || '';
  const priced = items.length ? priceBasket(items) : null;
  const price = priced?.priceable ? priced : null;

  // Mô hình bỏ sót SĐT nằm chung dòng với tên/địa chỉ ("Vũ Thanh Hải - 09xx… 3a2/109 đường…"):
  // đọc thẳng từ tin khách vừa nhắn thay vì hỏi lại thứ khách đã đưa.
  const freshPhone = toLocalPhone(value.Phone_Number) || extractVietnamesePhone(value.Phone_Number) || extractVietnamesePhone(context.messageText || '')
    // SĐT khách gửi ở một tin riêng trước đó (hay tin bị mô hình bỏ qua): đọc lại, không hỏi nữa.
    || (Array.isArray(context.recentCustomerTexts) ? context.recentCustomerTexts.map(text => extractVietnamesePhone(text)).find(Boolean) || '' : '');
  // Khách quen "gửi về địa chỉ cũ / như lần trước": SĐT và địa chỉ lấy từ đơn
  // gần nhất của khách thay vì hỏi lại.
  const wantsPrevious = /(dia chi|d\/c|dc) (cu|truoc|nhu cu|lan truoc)|nhu (lan )?truoc|cho cu|giong lan truoc|nhu cu/.test(normalizeText(String(context.messageText || '')));
  const previous = wantsPrevious && context.recentOrder ? context.recentOrder : null;
  const freshAddress = String(value.Customer_Address || '').trim() || (previous?.address ? String(previous.address) : '');
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
  const addressAccepted = Boolean(delivery) && (delivery.complete || addressAsks >= maxAddressAsks || answeredInFull);

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
        ...(pending?.upsold && (!freshPriceable || freshKey === pending.key) ? { upsold: true } : {})
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
      return { templateId: 'ORDER_ADDRESS', ...splitMessages(fill(template, values)), handoff: false, pendingOrder: asked };
    }
    // No text configured for the question: fall through and accept the address as is.
  }

  // Muốn mua nhưng chưa nêu sản phẩm (và cũng chưa có giỏ hàng chờ): hỏi
  // sản phẩm trước, không xin SĐT/địa chỉ cho một đơn chưa biết bán gì.
  // SĐT/địa chỉ khách lỡ đưa vẫn được giữ cho lần chốt sau.
  if (!items.length) {
    const text = templates.GENERAL_INFO ? renderGeneralInfo(templates) : fill(templates.ASK_PRODUCT, commonValues());
    return { templateId: 'ASK_PRODUCT', ...splitMessages(text), handoff: false, pendingOrder: nextPending };
  }

  if (!confirmed && !(isOrderStep(templateId) && Boolean(price) && hasPhone && hasAddress)) {
    // Only a request to close the order is escalated. While still collecting
    // details the bot keeps asking rather than dropping the customer on a human.
    if (items.length && !price) {
      // Giỏ chưa tính được giá ("combo 3 túi" chưa nói vị, hơn 3 túi…): hỏi vị
      // và số lượng thay vì chuyển người; SĐT/địa chỉ đã có vẫn được giữ. Cả
      // khi đang xin SĐT/địa chỉ: khách vừa đổi sang giỏ không tính được giá
      // mà vẫn hỏi tiếp thì đơn chốt sau đó là giỏ cũ, sai ý khách.
      const text = templates.ASK_FLAVOR ? fill(templates.ASK_FLAVOR, commonValues()) : renderGeneralInfo(templates);
      return { templateId: templates.ASK_FLAVOR ? 'ASK_FLAVOR' : 'GENERAL_INFO', ...splitMessages(text), handoff: false, pendingOrder: nextPending };
    }
    const missing = hasPhone && !hasAddress ? 'địa chỉ nhận hàng đầy đủ'
      : !hasPhone && hasAddress ? 'số điện thoại'
      : 'số điện thoại và địa chỉ nhận hàng đầy đủ';
    const known = hasPhone ? 'số điện thoại' : hasAddress ? 'địa chỉ' : '';
    // One wording when nothing has arrived yet, another once part of it has.
    const template = known ? templates.ORDER_ADDRESS_PARTIAL : templates.ORDER_ADDRESS;
    const ask = splitMessages(fill(template, { ...commonValues(), missing, known }));
    // Khách lấy 1 túi: nhân lúc xin thông tin, gợi ý lên 2 túi (giá combo, miễn
    // ship, quà) đúng một lần cho mỗi giỏ; khách vẫn lấy 1 túi thì đơn đi tiếp.
    const upsell = price?.totalQuantity === 1 && templates.UPSELL_TWO_BAGS && !pending?.upsold ? upsellTwoBags(price, templates) : '';
    return {
      templateId: 'ORDER_ADDRESS',
      ...ask,
      ...(upsell ? { messages: [...ask.messages, ...splitMessages(upsell).messages] } : {}),
      handoff: false,
      pendingOrder: upsell && nextPending ? { ...nextPending, upsold: true } : nextPending
    };
  }

  const total = price.total;
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
  return {
    templateId: 'ORDER_CONFIRMATION',
    // The confirmation, then the delivery policy and the after-sale note —
    // each one is a template of its own so staff can rewrite or blank it.
    messages: [confirmation, fill(templates.SHIPPING_POLICY, commonValues()), fill(templates.ORDER_AFTER_SALE, commonValues())].flatMap(text => splitMessages(text).messages).slice(0, 3),
    images: [],
    handoff: false,
    // Cleared: the basket has become a real order.
    pendingOrder: null,
    order: { items: orderItems, phone, address: deliveryAddress, rawAddress: address, total, subtotal: price.subtotal, shippingFee: price.shippingFee, orderKey: key, gift: price.gift }
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
  const quote = quoteTiers(value.Product_N1 || value.product || '')
    || quoteTiers(templateId.replace(/^PRICE_/, '').replace(/_/g, ' '));
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
  const products = (named ? [named] : getCatalogProducts()).filter(product => product.active && product.comboPrice > 0);
  const combos = products.flatMap(product => (quoteTiers(product.sku)?.tiers || [])
    .filter(tier => tier.quantity >= 2 && (tier.price < tier.listPrice || tier.freeShipping || tier.gifts.length))
    .map(tier => ({
      label: `${tier.quantity} ${product.unit || 'sản phẩm'} ${product.name}`,
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
  const items = (Array.isArray(order.products) ? order.products : [])
    .map(item => `${item.name || item.product || item.sku || 'sản phẩm'} x${Number(item.quantity) || 1}`)
    .join(', ') || 'sản phẩm đã đặt';
  const at = new Date(Number(order.createdAt) || Date.now());
  const parts = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).formatToParts(at);
  const part = type => parts.find(item => item.type === type)?.value || '';
  const orderedAt = `${part('hour')}:${part('minute')} ngày ${part('day')}/${part('month')}`;
  const shipped = Boolean(order.pos?.id || order.posOrderId || /đã giao|đang giao|đã gửi/i.test(String(order.status || '')));
  const state = shipped ? 'đã chuyển sang kho để đóng gói và bàn giao vận chuyển' : 'đã được ghi nhận, kho đang chuẩn bị hàng';
  return fill(templates.ORDER_STATUS, { ...commonValues(), items, ordered_at: orderedAt, state, total: formatMoney(Number(order.total) || 0) });
}

const catalogRenderers = {
  ORDER_STATUS: (value, templates) => renderOrderStatus(templates),
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
export function isProductQuoteId(templateId) {
  const id = String(templateId || '').trim();
  if (!id.startsWith('PRICE_') || catalogRenderers[id] || Object.hasOwn(defaultMessageTemplates(), id)) return false;
  return Boolean(matchProduct(id.replace(/^PRICE_/, '').replace(/_/g, ' ')));
}

// Templates the server picks on its own; the model never needs to name them.
const internalTemplateIds = new Set(['ASK_PRODUCT', 'FOLLOW_UP_COMMENT_FREESHIP', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'ORDER_AFTER_SALE', 'GIFT_POLICY_EMPTY', 'PRICE_QUOTE_COMBO', 'CSKH_HANDOFF', 'COMMENT_PUBLIC_REPLY', 'COMMENT_PUBLIC_FALLBACK', 'COMMENT_PUBLIC_REPEAT', 'LIVESTREAM_COMMENT', 'COMMENT_PRIVATE_REPLY', 'ORDER_ADDRESS', 'ORDER_CONFIRMATION', 'ORDER_STATUS_NONE', 'UPSELL_TWO_BAGS']);

/**
 * The template inventory as text for the model, appended to the system
 * prompt on every request next to the catalogue. Built from Thiết lập tin
 * nhắn, so a template added, renamed or switched off there changes what the
 * model may answer with — nothing about templates has to be typed into the
 * prompt itself.
 */
export function buildTemplatePrompt(templates = {}) {
  // The opening words of the template, syntax stripped: enough for the model to tell the ids apart.
  // Đoạn đầu có chữ (bỏ qua đoạn chỉ có {images}), gọn syntax.
  const gist = text => (String(text).split('###')
    .map(segment => segment.replace(/\[\[[^\]]*\]\]|\[\?[a-z_0-9]+\]|\[\/\?\]/gi, '').replace(/\{[a-z_0-9]+\}/gi, '…').trim())
    .find(segment => /\p{L}/u.test(segment)) || '')
    .replace(/^Dạ,? ?(em |mình )?/i, '').replace(/\s+/g, ' ').trim().match(/^.{0,47}(?=\s|$)/u)?.[0] || '';
  const lines = Object.entries(templates)
    .filter(([id, text]) => text && !internalTemplateIds.has(id) && !id.startsWith('FOLLOW_UP_') && !isProductQuoteId(id))
    .map(([id, text]) => `- ${id}: ${gist(text)}`);
  if (!lines.length) return '';
  return [
    'MẪU TIN (template_id → ý nghĩa):',
    ...lines,
    '- ORDER_ADDRESS: muốn mua, thiếu SĐT/địa chỉ',
    '- ORDER_CONFIRMATION: muốn mua, đủ sản phẩm+số lượng+SĐT+địa chỉ',
    '- CSKH_HANDOFF: cần người thật',
    'PRICE_QUOTE dùng cho mọi sản phẩm (kèm Product_N1); không có mẫu giá riêng từng sản phẩm.'
  ].join('\n');
}

/**
 * Turns the model's answer into the messages to send. `templates` is the
 * messageTemplates block of the chatbot settings — the only place text comes
 * from. A template whose text is blank is switched off: the bot hands over
 * to a person instead of guessing.
 */
export function renderChatbotReply(value = {}, templates = {}, context = {}) {
  activeCustomer = context.customer || {};
  activeRecentOrder = context.recentOrder || null;
  const templateId = String(value.template_id || '').trim();
  if (isOrderStep(templateId)) return renderOrder(value, templates, context);
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
    ...splitMessages(fill(raw, commonValues())),
    // Khách xin gọi điện: nhân viên phải gọi thật, nên vẫn chuyển người (kèm lời hẹn rõ).
    handoff: resolvedId === 'CSKH_HANDOFF' || resolvedId === 'CALLBACK_REQUEST'
  };
}
