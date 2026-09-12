import { describeGiftTable, priceBasket, quoteTiers, shippingFeeForKey } from './processing/pricing.mjs';
import { comboKey, getCatalogProducts, getGifts, getShippingFee, giftsForKey, isFreeShippingGift, listCombos, matchProduct, maxComboQuantity, normalizeText } from './processing/catalog.mjs';
import { metaConfig } from './config.mjs';
import { orderKey as buildOrderKey, toPricedItems } from './processing/order-key.mjs';
import { isOrderStep, usablePendingOrder } from './processing/pending-order.mjs';
import { extractVietnamesePhone, toLocalPhone } from './processing/customer-info.mjs';
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
function fill(text, values = {}, lists = {}) {
  let out = String(text ?? '').replace(/\\n/g, '\n');
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
function splitMessages(text) {
  const images = [];
  const content = String(text ?? '').replace(imagePattern, (_match, url) => {
    images.push(url.trim());
    return '';
  });
  const messages = content.split('###').map(item => item.trim()).filter(Boolean).slice(0, 3);
  return { messages, images };
}

/** Absolute URL for a picture the catalogue stores, so Messenger can fetch it. */
function publicImageUrl(image) {
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

/** Placeholders every template may use. */
function commonValues() {
  return { shipping_fee: formatMoney(getShippingFee()) };
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

function renderOrder(value, templates, context = {}) {
  const now = Number(context.now) || Date.now();
  const templateId = String(value.template_id || '').trim();
  const products = [value.Product_N1, value.Product_N2, value.Product_N3];
  const quantities = [value.No_A, value.No_B, value.No_C];
  const freshItems = toPricedItems(products.map((product, index) => ({
    product: String(product || '').trim(),
    quantity: Number(String(quantities[index] || '').replace(/\D/g, '')) || 0
  })).filter(item => item.product && item.product !== '0' && item.quantity > 0));

  // The price comes from the basket itself, never from a key the model
  // declared: an order_key the model invented used to price three bags as one.
  const freshKey = buildOrderKey(freshItems);
  const freshPrice = freshKey ? priceBasket(freshItems) : null;
  const pending = usablePendingOrder(context.pendingOrder, { now, templateId });
  const items = freshItems.length ? freshItems : (pending?.items || []);
  const key = freshKey || pending?.key || '';
  const priced = items.length ? priceBasket(items) : null;
  const price = priced?.priceable ? priced : null;

  const freshPhone = toLocalPhone(value.Phone_Number) || extractVietnamesePhone(value.Phone_Number);
  const freshAddress = String(value.Customer_Address || '').trim();
  const phone = freshPhone || pending?.phone || '';
  const address = (freshAddress && freshAddress !== '0' ? freshAddress : '') || pending?.address || '';
  const hasPhone = Boolean(phone);
  const hasAddress = Boolean(address);

  // Remember a priceable basket, plus whatever contact detail has arrived so
  // far, so the customer never has to repeat something already given.
  const freshPriceable = Boolean(freshItems.length && freshPrice?.priceable);
  const nextPending = freshPriceable || pending || hasPhone || hasAddress
    ? {
        items: freshPriceable ? freshItems : (pending?.items || []),
        key: freshPriceable ? freshKey : (pending?.key || ''),
        at: freshPriceable ? now : (pending?.at || now),
        phone,
        address
      }
    : null;

  const confirmed = isOrderStep(templateId) && Boolean(price) && hasPhone && hasAddress;

  if (!confirmed) {
    // Only a request to close the order is escalated. While still collecting
    // details the bot keeps asking rather than dropping the customer on a human.
    if (templateId === 'ORDER_CONFIRMATION' && items.length && !price) {
      return { templateId: 'CSKH_HANDOFF', ...splitMessages(fill(templates.CSKH_HANDOFF, commonValues())), handoff: true, pendingOrder: null };
    }
    const missing = hasPhone && !hasAddress ? 'địa chỉ nhận hàng đầy đủ'
      : !hasPhone && hasAddress ? 'số điện thoại'
      : 'số điện thoại và địa chỉ nhận hàng đầy đủ';
    const known = hasPhone ? 'số điện thoại' : hasAddress ? 'địa chỉ' : '';
    // One wording when nothing has arrived yet, another once part of it has.
    const template = known ? templates.ORDER_ADDRESS_PARTIAL : templates.ORDER_ADDRESS;
    return {
      templateId: 'ORDER_ADDRESS',
      ...splitMessages(fill(template, { ...commonValues(), missing, known })),
      handoff: false,
      pendingOrder: nextPending
    };
  }

  const total = price.total;
  // Catalogue names, not the customer's wording, so the confirmation and the
  // order record agree on what is being shipped.
  const orderItems = price.lines.map(line => ({ product: line.name, code: line.sku, quantity: line.quantity }));
  const confirmation = fill(templates.ORDER_CONFIRMATION, {
    ...commonValues(),
    phone,
    address,
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
    order: { items: orderItems, phone, address, total, subtotal: price.subtotal, shippingFee: price.shippingFee, orderKey: key, gift: price.gift }
  };
}

// ===== Replies filled from the catalogue =====
// GENERAL_INFO, GIFT_POLICY, PRICE_MIX_TUI_LON and PRICE_QUOTE are ordinary
// editable templates; what makes them special is only the values they are
// filled with, all read from Cài đặt → Sản phẩm / Quà tặng at reply time.

function renderGeneralInfo(templates) {
  const products = getCatalogProducts().filter(product => product.active && product.unitPrice > 0);
  if (!products.length) return fill(templates.ASK_PRODUCT, commonValues());
  return fill(templates.GENERAL_INFO, { ...commonValues(), count: products.length }, {
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
      return at > 0 ? { gifts: line.slice(0, at), combos: line.slice(at + 2) } : null;
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
  const values = { ...commonValues(), product: product.name, unit: product.unit, image: image ? `![${product.name}](${image})` : '' };
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

const catalogRenderers = {
  GENERAL_INFO: (value, templates) => renderGeneralInfo(templates),
  GIFT_POLICY: (value, templates) => renderGiftPolicy(templates),
  PRICE_MIX_TUI_LON: (value, templates) => renderMixPricing(templates),
  PRICE_QUOTE: (value, templates) => renderPriceQuote('PRICE_QUOTE', value, templates)
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
const internalTemplateIds = new Set(['ASK_PRODUCT', 'ORDER_ADDRESS_PARTIAL', 'ORDER_AFTER_SALE', 'GIFT_POLICY_EMPTY', 'PRICE_QUOTE_COMBO', 'CSKH_HANDOFF', 'ORDER_ADDRESS', 'ORDER_CONFIRMATION']);

/**
 * The template inventory as text for the model, appended to the system
 * prompt on every request next to the catalogue. Built from Thiết lập tin
 * nhắn, so a template added, renamed or switched off there changes what the
 * model may answer with — nothing about templates has to be typed into the
 * prompt itself.
 */
export function buildTemplatePrompt(templates = {}) {
  // The opening words of the template, syntax stripped: enough for the model to tell the ids apart.
  const gist = text => String(text)
    .replace(/###[\s\S]*$/, '').replace(/\[\[[^\]]*\]\]|\[\?[a-z_0-9]+\]|\[\/\?\]/gi, '').replace(/\{[a-z_0-9]+\}/gi, '…')
    .replace(/^Dạ,? ?(em |mình )?/i, '').replace(/\s+/g, ' ').trim().match(/^.{0,47}(?=\s|$)/u)?.[0] || '';
  const lines = Object.entries(templates)
    .filter(([id, text]) => text && !internalTemplateIds.has(id) && !isProductQuoteId(id))
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
  const templateId = String(value.template_id || '').trim();
  if (isOrderStep(templateId)) return renderOrder(value, templates, context);
  const catalogId = catalogRenderers[templateId] ? templateId : isProductQuoteId(templateId) ? 'PRICE_QUOTE' : '';
  if (catalogId && templates[catalogId]) {
    const text = catalogId === 'PRICE_QUOTE' ? renderPriceQuote(templateId, value, templates) : catalogRenderers[catalogId](value, templates);
    return { templateId, ...splitMessages(text), handoff: false };
  }
  const raw = (!catalogId && templates[templateId]) || value.reply || value.message || value.text || templates.CSKH_HANDOFF;
  return {
    templateId: !catalogId && templates[templateId] ? templateId : 'CSKH_HANDOFF',
    ...splitMessages(fill(raw, commonValues())),
    handoff: templateId === 'CSKH_HANDOFF'
  };
}
