import { describeGiftTable, priceBasket, renderPriceQuote } from './processing/pricing.mjs';
import { getCatalogProducts, getGifts, getShippingFee, matchProduct } from './processing/catalog.mjs';
import { orderKey as buildOrderKey, toPricedItems } from './processing/order-key.mjs';
import { isOrderStep, usablePendingOrder } from './processing/pending-order.mjs';
import { extractVietnamesePhone, toLocalPhone } from './processing/customer-info.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every reply text lives in Thiết lập tin nhắn (chatbot settings →
// messageTemplates); this module only chooses which template answers and
// fills its placeholders. Nothing is typed here, so what staff edit on screen
// is the whole truth. app/chatbot-templates.seed.json is copied into the
// settings once, the first time they are read with no templates at all.
// Replies that carry a price or a gift are not templates: they are composed
// from Cài đặt → Sản phẩm and Cài đặt → Quà tặng at reply time (see
// dynamicTemplateRenderers), so a figure can never be typed in and go stale.
const seedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chatbot-templates.seed.json');

/** The shipped default texts — used only to seed settings that have none. */
export function defaultMessageTemplates() {
  return JSON.parse(readFileSync(seedPath, 'utf8'));
}

/** Fills {name} placeholders; a placeholder with no value disappears. */
function fill(text, values = {}) {
  return String(text ?? '').replace(/\{([a-z_]+)\}/gi, (_, key) => (values[key] ?? ''));
}

/** Splits one stored template into up to three messages ("###" separates them). */
function splitMessages(text) {
  return String(text ?? '').replace(/\\n/g, '\n').split('###').map(item => item.trim()).filter(Boolean).slice(0, 3);
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
      return { templateId: 'CSKH_HANDOFF', messages: splitMessages(templates.CSKH_HANDOFF), handoff: true, pendingOrder: null };
    }
    const missing = hasPhone && !hasAddress ? 'địa chỉ nhận hàng đầy đủ'
      : !hasPhone && hasAddress ? 'số điện thoại'
      : 'số điện thoại và địa chỉ nhận hàng đầy đủ';
    const known = hasPhone ? 'số điện thoại' : hasAddress ? 'địa chỉ' : '';
    // One wording when nothing has arrived yet, another once part of it has.
    const template = known ? templates.ORDER_ADDRESS_PARTIAL : templates.ORDER_ADDRESS;
    return {
      templateId: 'ORDER_ADDRESS',
      messages: splitMessages(fill(template, { missing, known })),
      handoff: false,
      pendingOrder: nextPending
    };
  }

  const total = price.total;
  // Catalogue names, not the customer's wording, so the confirmation and the
  // order record agree on what is being shipped.
  const orderItems = price.lines.map(line => ({ product: line.name, code: line.sku, quantity: line.quantity }));
  const confirmation = fill(templates.ORDER_CONFIRMATION, {
    items: orderItems.map(item => `🌾 ${item.product} – Số lượng: ${item.quantity}`).join('\n'),
    phone,
    address,
    shipping: price.shippingFee ? `🚚 Phí vận chuyển: ${formatMoney(price.shippingFee)}\n━━━━━━━━━━━━\n` : '',
    subtotal: formatMoney(price.subtotal),
    total: formatMoney(total),
    gift: price.gift ? `\n━━━━━━━━━━━━\n🎁 ${price.gift}` : ''
  });
  return {
    templateId: 'ORDER_CONFIRMATION',
    // The confirmation, then the delivery policy and the after-sale note —
    // each one is a template of its own so staff can rewrite or blank it.
    messages: [confirmation, templates.SHIPPING_POLICY, templates.ORDER_AFTER_SALE].flatMap(splitMessages).slice(0, 3),
    handoff: false,
    // Cleared: the basket has become a real order.
    pendingOrder: null,
    order: { items: orderItems, phone, address, total, subtotal: price.subtotal, shippingFee: price.shippingFee, orderKey: key, gift: price.gift }
  };
}

// ===== Replies written from the catalogue at reply time =====
// Each renderer returns the reply text for the current catalogue, or the
// ask-for-product line when the catalogue has nothing to say. PRICE_<name>
// ids resolve the product from Product_N1 first and then from the id itself
// (PRICE_TUI_XANH → "tui xanh" → the product's alias), so a new product needs
// no new template: PRICE_QUOTE + its name is enough.

function formatMoney(value) {
  return `${Math.max(0, Math.round(Number(value) || 0)).toLocaleString('vi-VN')}đ`;
}

function renderGeneralInfo(templates) {
  const products = getCatalogProducts().filter(product => product.active && product.unitPrice > 0);
  if (!products.length) return templates.ASK_PRODUCT;
  const lines = products.map(product => `🌾 ${product.name}: ${formatMoney(product.unitPrice)}`);
  const fee = getShippingFee();
  const shipText = fee ? ` Giá trên là giá mua lẻ, chưa gồm phí vận chuyển ${formatMoney(fee)}; combo và các tổ hợp được miễn ship theo chương trình.` : ' Giá trên là giá mua lẻ.';
  return `Dạ hiện tại nhà em có ${products.length} sản phẩm ạ:\n${lines.join('\n')}${shipText} Anh/chị đang quan tâm loại nào để em gửi bảng giá combo chi tiết ạ?`;
}

function renderGiftPolicy(templates) {
  if (!getGifts().some(gift => gift.active)) return templates.GIFT_POLICY_EMPTY;
  const lines = describeGiftTable().map(line => line.replace(/^- /, '• '));
  return `Dạ chương trình quà tặng hiện tại ạ:\n${lines.join('\n')}`;
}

function renderMixPricing(templates) {
  const products = getCatalogProducts().filter(product => product.active && product.comboPrice > 0);
  if (!products.length) return templates.ASK_PRODUCT;
  const lines = products.map(product => `• ${product.name}: ${formatMoney(product.comboPrice)}/sản phẩm`);
  const mixable = products.filter(product => product.mixable);
  const [first, second] = mixable;
  const example = second ? ` Ví dụ ${first.name} + ${second.name} = ${formatMoney(first.comboPrice + second.comboPrice)}.` : '';
  return `Dạ mua từ 2 sản phẩm thì mỗi sản phẩm tính theo giá combo ạ:\n${lines.join('\n')}${example} Quà tặng theo từng tổ hợp, anh/chị chọn combo em báo quà kèm nha ạ.`;
}

function renderPriceAdjustment() {
  const fee = getShippingFee();
  const ship = fee
    ? ` Bên em vẫn giữ giá combo và hỗ trợ phí vận chuyển cho đơn một sản phẩm nên phí ship còn ${formatMoney(fee)}; các combo được miễn phí vận chuyển theo chương trình ạ.`
    : ' Bên em vẫn giữ giá combo và miễn phí vận chuyển ạ.';
  return `Dạ giá sản phẩm lẻ có điều chỉnh theo chi phí nguyên liệu.${ship}`;
}

/** The product a PRICE_* id names: PRICE_TUI_XANH → "tui xanh" → the catalogue alias. */
function renderPriceTemplate(templateId, value, templates) {
  const product = matchProduct(value.Product_N1 || value.product || '')
    || matchProduct(templateId.replace(/^PRICE_/, '').replace(/_/g, ' '));
  return product ? renderPriceQuote(product.name) : templates.ASK_PRODUCT;
}

// Ids with a fixed renderer. Any other PRICE_* id is a product quote.
const dynamicTemplateRenderers = {
  GENERAL_INFO: (value, templates) => renderGeneralInfo(templates),
  GIFT_POLICY: (value, templates) => renderGiftPolicy(templates),
  PRICE_MIX_TUI_LON: (value, templates) => renderMixPricing(templates),
  PRICE_ADJUSTMENT: () => renderPriceAdjustment(),
  PRICE_QUOTE: (value, templates) => renderPriceTemplate('PRICE_QUOTE', value, templates)
};

// PRICE_* ids the model was taught before quotes became catalogue-driven.
// Listed so the settings screen can show them; each resolves to a product
// through renderPriceTemplate.
const legacyPriceTemplateIds = ['PRICE_TUI_XANH', 'PRICE_TUI_VANG', 'PRICE_TUI_NAU', 'PRICE_TUI_XANH_NHO', 'PRICE_TUI_NAU_NHO', 'PRICE_TUI_CAM_NHO', 'PRICE_COMBO_10_GOI_MIX_3_MAU', 'PRICE_NGHE_LANH', 'PRICE_HAT_AN_LANH_DANG_HU'];

/** A dynamic id is one the catalogue writes: it has a renderer, or it is a PRICE_* quote with no stored text. */
export function isDynamicTemplate(templateId, templates = {}) {
  const id = String(templateId || '').trim();
  return Boolean(dynamicTemplateRenderers[id]) || (id.startsWith('PRICE_') && !templates[id]);
}

function renderDynamicTemplate(templateId, value, templates) {
  const id = String(templateId || '').trim();
  if (dynamicTemplateRenderers[id]) return dynamicTemplateRenderers[id](value, templates);
  return renderPriceTemplate(id, value, templates);
}

/** Every catalogue-written template with its live text — for the settings screen. */
export function listDynamicTemplates(templates = {}) {
  const result = {};
  for (const id of [...Object.keys(dynamicTemplateRenderers), ...legacyPriceTemplateIds]) {
    if (!templates[id]) result[id] = renderDynamicTemplate(id, {}, templates);
  }
  return result;
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
  if (isDynamicTemplate(templateId, templates)) {
    return { templateId, messages: [renderDynamicTemplate(templateId, value, templates)], handoff: false };
  }
  const raw = templates[templateId] || value.reply || value.message || value.text || templates.CSKH_HANDOFF;
  return {
    templateId: templates[templateId] ? templateId : 'CSKH_HANDOFF',
    messages: splitMessages(raw),
    handoff: templateId === 'CSKH_HANDOFF'
  };
}
