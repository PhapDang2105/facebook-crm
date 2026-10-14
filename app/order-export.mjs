import { comboKey, findProductBySku, getGifts, getLiveWarehouseSku, giftsForKey, giftSwapPlan, LIVE_GIFT_POS_SKU, livestreamGiftSkus, matchProduct, normalizeText } from './processing/catalog.mjs';
import { shippingFeeForKey, unitPriceInBasket } from './processing/pricing.mjs';
import { canonicalLocationColumns, checkLocationColumns, normalizeExportLocation, streetForDisplay } from './processing/locations.mjs';
import { isLivestreamOrder } from './conversation-orders.mjs';
import { isStandardWarehouseSku, standardComboParts } from './warehouse-skus.mjs';
import { giftOverridePlan } from './gift-override.mjs';

export { normalizeExportLocation };

/** Mã dòng của đơn hệ thống trong bảng Đơn hàng (như systemOrderRowId ở web/app.js). */
export function systemOrderRowId(order = {}) {
  return `${order.source === 'Landing page' ? 'LP' : 'CB'}-${order.id}`;
}

/**
 * Dòng quà của đơn kéo từ POS: `giftItems` (dòng tặng POS, ghi khi đồng bộ), đơn
 * kéo về trước đó chỉ có chữ `gift` ("Quà Tặng LIVE + Bộ bát gáo dừa") thì tra tên
 * (hay SKU) trong bảng quà. Quà không tra được SKU thì bỏ (kho không nhận dòng không mã).
 */
export function posGiftLines(order = {}) {
  if (Array.isArray(order.giftItems) && order.giftItems.length) {
    return order.giftItems.map(item => {
      const raw = String(item?.sku || '').trim().toUpperCase();
      const sku = raw === 'QUAT' ? 'QUA-TANG-LIVE' : raw;
      return { sku, quantity: Math.max(1, Math.round(Number(item?.quantity) || 1)), weight: Number(item?.weight) || 0 };
    }).filter(item => item.sku);
  }
  // Tên quà có thể chứa " + " ("Quạt + Bát gáo dừa"): so cả cụm giữa các dấu " + ",
  // không tách từng mảnh. Chữ là SKU (POS ghi display_id khi thiếu tên) cũng nhận.
  const text = String(order.gift || '');
  const padded = ` + ${normalizeText(text)} + `;
  const parts = new Set(text.split(' + ').map(part => part.trim().toUpperCase()).filter(Boolean));
  // 06/10: quà live "Bát gáo dừa + Muỗng dừa" dùng lại SKU BGD/MUONG của quà thường → mỗi SKU chỉ một dòng.
  const seen = new Set();
  return (getGifts() || [])
    .filter(gift => gift.sku && (padded.includes(` + ${normalizeText(gift.name)} + `) || parts.has(gift.sku)))
    .filter(gift => !seen.has(gift.sku) && seen.add(gift.sku))
    .map(gift => ({ sku: gift.sku, quantity: 1, weight: gift.weight }));
}

/**
 * Cờ của đơn hệ thống mà dòng bảng không mang, theo mã dòng ("CB-…"/"LP-…"):
 * khách live (quà live), quà ưu đãi bám đuổi, và dòng quà POS của đơn nguồn POS.
 */
export function exportFactsForOrders(orders = []) {
  const facts = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!order?.id) continue;
    facts.set(systemOrderRowId(order), {
      livestream: isLivestreamOrder(order),
      promoGift: Boolean(order.promoGift),
      // R13 (gộp): đơn khách ĐỔI QUÀ (bát/muỗng/quạt → gói granola nhỏ) — file kho lên dòng quà theo quà đã đổi.
      ...(Array.isArray(order.giftSwap) && order.giftSwap.length ? { giftSwap: { giftSwap: order.giftSwap, giftSwapRemoved: Array.isArray(order.giftSwapRemoved) ? order.giftSwapRemoved : [] } } : {}),
      ...(order.source === 'POS' ? { posGifts: posGiftLines(order) } : {}),
      // 05/10: quà nhân viên CHỌN TAY (giftOverride): file kho lên đúng các dòng quà này (mục thiếu mã thì bỏ).
      ...(order.source !== 'POS' && giftOverridePlan(order) ? { giftOverride: giftOverridePlan(order) } : {})
    });
  }
  return facts;
}

export const EXPORT_COLUMNS = [
  'STT*', 'Mã đơn hàng', 'Nguồn đơn hàng', 'Ngày đặt hàng', 'Tác động tồn kho', 'Gửi email thông báo',
  'Giá đã bao gồm thuế', 'Trạng thái thanh toán', 'Phương thức thanh toán', 'Trạng thái giao hàng',
  'Hình thức giao hàng', 'Đối tác vận chuyển', 'Phí giao hàng', 'Giảm giá đơn hàng', '', '', 'Mã phiên bản',
  'Tên sản phẩm', 'Tên phiên bản', 'SKU', 'Đơn vị', 'Số lượng*', 'Giá bán', 'Giảm giá sản phẩm', 'Khối lượng',
  'Yêu cầu vận chuyển', 'Ghi chú sản phẩm', 'Nhãn hiệu', 'Thuế', '', 'Số điện thoại', 'Email', 'Họ khách hàng',
  'Tên khách hàng', 'SĐT giao hàng', 'Địa chỉ', 'Tỉnh thành', 'Quận huyện', 'Phường xã', 'SĐT nhân viên phụ trách',
  'Ghi chú', 'Tags', 'Tham chiếu'
];

export const SKU_WEIGHTS = Object.freeze({
  'GRA-VANG-H350': 400,
  'GRA-XANH-Z450': 500,
  'GRA-NAU-Z350': 400,
  'GRA-NAU-G35': 35,
  'GRA-XANH-G35': 35,
  'GRA-CAM-G30': 30,
  'GRA-MINT-Z300': 300,
  'HT-YM-T500': 500,
  'YM-VO-T500': 500,
  'HU-300ML': 10,
  BGD: 10,
  MUONG: 10
});

/**
 * Khối lượng (g) chỉ để ghi cột Khối lượng của file kho — KHÔNG thêm vào SKU_WEIGHTS, vì bảng đó còn
 * quyết định cách đọc ký hiệu combo Pancake cũ ("CB3-XANH+QUAT"…). Bảng quà chủ shop đưa 14/10
 * (TAM-LANH-G25 = 10g theo bảng, thay số 25g nhắn trước đó) và mã bán trên Zalo ngoài danh mục.
 */
export const EXTRA_SKU_WEIGHTS = Object.freeze({
  QUAT: 10,
  'MHD-G15': 10,
  'CHIA-G10': 10,
  'NGHE-G25': 25,
  XMRC: 10,
  'QUA-4TRA-G3': 10,
  'TAM-LANH-G25': 10,
  '100-NB-PRE-H420': 500
});

/** Khối lượng mặc định (g) một đơn vị hàng (không phải quà) của đơn Zalo khi mã chưa có khối lượng ở đâu cả. */
export const ZALO_DEFAULT_WEIGHT = 500;

const SKU_PRICES = Object.freeze({
  'GRA-NAU-Z350': { single: 179000, combo: 144000 },
  'GRA-VANG-H350': { single: 189000, combo: 149000 },
  'GRA-XANH-Z450': { single: 189000, combo: 149000 },
  // 14/10 chủ shop: Mint (Tropical) 300g bán lẻ 219.000đ, combo 174.000đ/túi.
  'GRA-MINT-Z300': { single: 219000, combo: 174000 }
});

/**
 * SKU ghi vào file kho: quà Live lên POS là mã chung QUA-TANG-LIVE, còn kho ghi mã quà đang tặng
 * (Cài đặt → Quà tặng → "SKU kho quà Live", chủ shop 14/10: hiện là QUAT).
 */
export function warehouseSku(sku) {
  if (String(sku || '').trim().toUpperCase() !== LIVE_GIFT_POS_SKU) return sku;
  return getLiveWarehouseSku() || LIVE_GIFT_POS_SKU;
}

function components(mainSku, mainQuantity, unitPrice, jarQuantity) {
  return Object.freeze([
    Object.freeze({ sku: mainSku, quantity: mainQuantity, price: unitPrice }),
    Object.freeze({ sku: 'HU-300ML', quantity: jarQuantity, price: 0 })
  ]);
}

function mixedComponents(quantity, unitPrice) {
  return Object.freeze([
    Object.freeze({ sku: 'HT-YM-T500', quantity, price: unitPrice }),
    Object.freeze({ sku: 'YM-VO-T500', quantity, price: unitPrice }),
    Object.freeze({ sku: 'HU-300ML', quantity, price: 0 })
  ]);
}

// Mỗi biến thể là một quan hệ riêng để định mức hoặc giá có thể thay đổi độc lập.
export const PRODUCT_RELATIONS = Object.freeze([
  Object.freeze({ id: 'oat-flat-1kg', type: 'single', variant: '1kg', saleSku: 'CB2-HT-YM-T500', components: components('HT-YM-T500', 2, 65500, 1) }),
  Object.freeze({ id: 'oat-flat-1kg-ship', type: 'single', variant: '1kg-ship', saleSku: 'CB2-HT-YM-T500', components: components('HT-YM-T500', 2, 58000, 1) }),
  Object.freeze({ id: 'oat-flat-2kg', type: 'single', variant: '2kg', saleSku: 'CB4-HT-YM-T500', components: components('HT-YM-T500', 4, 55500, 2) }),
  Object.freeze({ id: 'oat-flat-3kg', type: 'single', variant: '3kg', saleSku: 'CB6-HT-YM-T500', components: components('HT-YM-T500', 6, 49800, 3) }),
  Object.freeze({ id: 'oat-broken-1kg', type: 'single', variant: '1kg', saleSku: 'CB2-YM-VO-T500', components: components('YM-VO-T500', 2, 65500, 1) }),
  Object.freeze({ id: 'oat-broken-1kg-ship', type: 'single', variant: '1kg-ship', saleSku: 'CB2-YM-VO-T500', components: components('YM-VO-T500', 2, 58000, 1) }),
  Object.freeze({ id: 'oat-broken-2kg', type: 'single', variant: '2kg', saleSku: 'CB4-YM-VO-T500', components: components('YM-VO-T500', 4, 55500, 2) }),
  Object.freeze({ id: 'oat-broken-3kg', type: 'single', variant: '3kg', saleSku: 'CB6-YM-VO-T500', components: components('YM-VO-T500', 6, 49800, 3) }),
  Object.freeze({ id: 'oat-mixed-1kg', type: 'combo', variant: '1kg', saleSku: 'CB-YM-DET+VO', components: mixedComponents(1, 58000) }),
  Object.freeze({ id: 'oat-mixed-1kg-ship', type: 'combo', variant: '1kg-ship', saleSku: 'CB-YM-DET+VO', components: mixedComponents(1, 58000) }),
  Object.freeze({ id: 'oat-mixed-2kg', type: 'combo', variant: '2kg', saleSku: 'CB-YM-DET+VO', components: mixedComponents(2, 55500) }),
  Object.freeze({ id: 'oat-mixed-3kg', type: 'combo', variant: '3kg', saleSku: 'CB-YM-DET+VO', components: mixedComponents(3, 49800) })
]);

export function normalizeColumnName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Ô "Nguồn đơn" của dòng là Zalo (đơn trang Đơn Zalo): file kho ghi nguồn Zalo thay vì Facebook. */
export function isZaloSource(value) {
  return normalizeColumnName(value) === 'zalo';
}

/** Cột quà của đơn Zalo: SKU quà nhân viên nhập ở trang Đơn Zalo, áp cho mọi đơn của tệp. */
export const ZALO_GIFT_COLUMN = 'Quà tặng (SKU)';

/**
 * "BGD, MUONG x2" → [{ sku: 'BGD', quantity: 1 }, { sku: 'MUONG', quantity: 2 }]. Ngăn bằng dấu phẩy,
 * chấm phẩy, dấu + hay xuống dòng; số lượng viết "x2", "×2" hoặc "*2". Phần không đọc được nằm ở `invalid`.
 */
export function parseGiftSkus(value) {
  const lines = [];
  const invalid = [];
  for (const part of String(value || '').split(/[,;+\n]+/).map(item => item.trim()).filter(Boolean)) {
    const match = part.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[x×*]\s*(\d{1,3}))?$/i);
    if (!match) { invalid.push(part); continue; }
    const sku = match[1].toUpperCase();
    const quantity = Math.max(1, Number(match[2]) || 1);
    const existing = lines.find(line => line.sku === sku);
    if (existing) existing.quantity += quantity;
    else lines.push({ sku, quantity });
  }
  return Object.assign(lines, { invalid });
}

export function isInvalidOrderAddress(value) {
  return String(value ?? '').trim().toUpperCase().startsWith('GXN');
}

function normalizeSkuToken(value) {
  return String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function canonicalSaleSku(value) {
  return normalizeSkuToken(value).replace(/[;,\s]+$/g, '');
}

function getSkuPrice(sku, isCombo, fallbackPrice) {
  const configuredPrice = SKU_PRICES[sku];
  return configuredPrice ? configuredPrice[isCombo ? 'combo' : 'single'] : Number(fallbackPrice) || 0;
}

function mapSingleSku(symbol) {
  const value = String(symbol || '').trim();
  const upper = normalizeSkuToken(value);
  if (upper === 'HU-300ML' || upper.includes('HU 300ML')) return 'HU-300ML';
  if (upper === 'HT-YM-T500' || (upper.includes('YEN MACH') && upper.includes('CAN DET'))) return 'HT-YM-T500';
  if (upper === 'YM-VO-T500' || (upper.includes('YEN MACH') && upper.includes('CAN VO'))) return 'YM-VO-T500';
  if (upper.endsWith('G35') && upper.includes('NAU')) return 'GRA-NAU-G35';
  if (upper.endsWith('G35') && upper.includes('XANH')) return 'GRA-XANH-G35';
  if (upper.endsWith('G30') && upper.includes('CAM')) return 'GRA-CAM-G30';
  if (upper.includes('MINT')) return 'GRA-MINT-Z300';
  if (upper.includes('VANGG') || upper.includes('VANG')) return 'GRA-VANG-H350';
  if (upper.includes('XANH')) return 'GRA-XANH-Z450';
  if (upper.includes('NAU')) return 'GRA-NAU-Z350';
  if (upper === 'BGD') return 'BGD';
  if (upper === 'M' || upper === 'MUONG') return 'MUONG';
  return value;
}

export function resolveProductRelation(symbol, productLabel = '') {
  const saleSku = canonicalSaleSku(symbol);
  const descriptor = normalizeSkuToken(`${symbol || ''} ${productLabel || ''}`);
  const kgMatch = descriptor.match(/\b([123])\s*KG\b/);
  const bundleMatch = saleSku.match(/^CB\s*(\d+)\s*(?:-|\s)\s*(HT-YM-T500|YM-VO-T500)$/);
  const isMixed = saleSku === 'CB-YM-DET+VO'
    || (descriptor.includes('CAN DET') && descriptor.includes('CAN VO'))
    || (descriptor.includes('HT-YM-T500') && descriptor.includes('YM-VO-T500'));
  const hasShip = descriptor.includes('SHIP');

  if (isMixed) {
    const kilograms = kgMatch ? Number(kgMatch[1]) : 1;
    const variant = `${kilograms}kg${hasShip ? '-ship' : ''}`;
    return PRODUCT_RELATIONS.find(relation => relation.type === 'combo' && relation.variant === variant) || null;
  }

  const directSku = mapSingleSku(symbol);
  const oatSku = bundleMatch ? bundleMatch[2] : directSku;
  if (oatSku !== 'HT-YM-T500' && oatSku !== 'YM-VO-T500') return null;
  const bagCount = bundleMatch ? Number(bundleMatch[1]) : (kgMatch ? Number(kgMatch[1]) * 2 : 0);
  if (!bagCount) return null;
  const variant = `${bagCount / 2}kg${hasShip ? '-ship' : ''}`;
  return PRODUCT_RELATIONS.find(relation => relation.type === 'single'
    && relation.variant === variant
    && relation.components[0].sku === oatSku) || null;
}

function expandRelation(relation, orderQuantity) {
  const quantity = Math.max(1, Number(orderQuantity) || 1);
  // Với cả hai loại, từng thành phần được giữ thành dòng riêng; type mô tả ngữ nghĩa quan hệ.
  return relation.components.map(component => ({
    sku: component.sku,
    quantity: component.quantity * quantity,
    price: component.price
  }));
}

/** Weight of any SKU: the catalogue first, then the legacy table, then the gift / Zalo table. */
export function skuWeight(sku) {
  const product = findProductBySku(sku);
  if (product?.weight) return product.weight;
  return SKU_WEIGHTS[sku] ?? EXTRA_SKU_WEIGHTS[sku] ?? '';
}

/**
 * A row whose "Mã mẫu mã" is a catalogue SKU — every order the chatbot or the
 * manual form creates — leaves as one line of that SKU at the single or combo
 * price, with the weight staff entered. The legacy Pancake symbols below stay
 * untouched.
 */
function splitCatalogSku(product, quantity, useComboPricing, shippingFee = 0, paidPrice = 0) {
  // Đơn có giá khách trả (ô Đơn giá của bảng = paidPrice, đã gộp phần ship của
  // dòng đầu và giá nhân viên gõ tay): kho nhận đúng số đó, file khớp tổng đơn.
  if (paidPrice > 0) return [{ sku: product.sku, quantity, price: Math.round(paidPrice), catalog: true }];
  const unit = unitPriceInBasket(product, useComboPricing ? 2 : 1);
  // Shipping is folded into the price of the shipped units: one bag leaves
  // at 189.000đ (174.000đ + 15.000đ), which is what the order must show.
  const shipPerUnit = shippingFee ? Math.round(shippingFee / quantity) : 0;
  return [{ sku: product.sku, quantity, price: unit + shipPerUnit, catalog: true }];
}

// Quà nhân viên hay ghi trong ngoặc đầu địa chỉ → SKU kho (chữ đã bỏ dấu, viết thường). Quạt là quà Live
// (mã chung QUA-TANG-LIVE, file kho đổi sang SKU kho quà Live). Yến mạch tặng = Yến mạch cán dẹt 500g.
const GIFT_NOTE_RULES = [
  { pattern: /\b(bat|bgd|gao dua)\b/, sku: 'BGD' },
  { pattern: /\b(muong|thia)\b/, sku: 'MUONG' },
  { pattern: /\bquat\b/, sku: LIVE_GIFT_POS_SKU },
  { pattern: /\byen mach\b/, sku: 'HT-YM-T500' },
  { pattern: /\bgoi\b.*\bxanh\b|\bxanh\b.*\bgoi\b/, sku: 'GRA-XANH-G35' },
  { pattern: /\bgoi\b.*\bnau\b|\bnau\b.*\bgoi\b/, sku: 'GRA-NAU-G35' },
  { pattern: /\bgoi\b.*\bcam\b|\bcam\b.*\bgoi\b/, sku: 'GRA-CAM-G30' },
  { pattern: /\bhu\b/, sku: 'HU-300ML' }
];

/**
 * Mã chỉ dùng làm quà (không bán): quà Live, bát, muỗng và các quà trong Cài đặt → Quà tặng không phải sản
 * phẩm danh mục (quà "1 Túi Vàng" là sản phẩm thì không tính — dòng bán của nó vẫn giữ giá).
 */
function isGiftOnlySku(sku) {
  const code = String(sku || '').trim().toUpperCase();
  if (!code) return false;
  if (code === LIVE_GIFT_POS_SKU || code === String(getLiveWarehouseSku() || '').toUpperCase() || code === 'BGD' || code === 'MUONG' || code === 'QUAT') return true;
  return !findProductBySku(code) && (getGifts() || []).some(gift => String(gift.sku || '').trim().toUpperCase() === code);
}

/**
 * Ghi chú quà ở ngoặc đầu địa chỉ (quy ước kho, chủ shop 12/10 + 14/10):
 * "(Tặng BGD) …", "( tặng bát muỗng dừa) …", "(Live Tặng yến mạch 2 túi) …" → lines [{ sku, quantity }];
 * phần sau "tặng" không nhận ra → unknown. liveOnly: chỉ ghi "(Live)" không kèm quà nào (đơn nhận quà Live).
 */
export function addressGiftNotes(address) {
  const head = String(address || '').match(/^\s*(?:\([^()\n]{1,80}\)\s*)+/)?.[0] || '';
  const notes = [...head.matchAll(/\(([^()]*)\)/g)].map(match => match[1].trim()).filter(Boolean);
  const lines = [];
  const unknown = [];
  let live = false;
  let gifted = false;
  for (const note of notes) {
    const text = normalizeText(note);
    if (/\blive\b/.test(text)) live = true;
    // "đổi quạt lấy/sang bát muỗng", "đổi bát muỗng" (chủ shop 14/10: đổi thì thêm quà đổi sang) — lấy phần quà mới.
    const swapText = text.match(/\bdoi\b(?:.*?\b(?:lay|sang|thanh|bang)\b)?\s*(.*)$/)?.[1]?.trim();
    const giftText = swapText ?? text.match(/\b(?:tang|qua tang|qua)\b[:\s]*(.*)$/)?.[1]?.trim();
    if (giftText === undefined) continue;
    gifted = true;
    for (const part of giftText.split(/\s*(?:,|\+|;|&|\bva\b|\bkem\b)\s*/).map(item => item.trim()).filter(Boolean)) {
      const quantity = Math.max(1, Number(part.match(/\b(\d{1,2})\b/)?.[1]) || Number(part.match(/x\s*(\d{1,2})\b/)?.[1]) || 1);
      // Mã kho ghi thẳng ("TKQ-G20", "HU-300ML") nhận luôn; còn lại theo bảng từ khoá.
      const typed = part.toUpperCase().split(/\s+/).filter(isStandardWarehouseSku);
      const skus = [...new Set([...GIFT_NOTE_RULES.filter(rule => rule.pattern.test(part)).map(rule => rule.sku), ...typed])];
      if (!skus.length) { unknown.push(part); continue; }
      for (const sku of skus) {
        const rule = { sku };
        const existing = lines.find(line => line.sku === rule.sku);
        if (existing) existing.quantity = Math.max(existing.quantity, quantity);
        else lines.push({ sku: rule.sku, quantity });
      }
    }
  }
  return { lines, unknown, liveOnly: live && !gifted };
}

/**
 * Combo danh mục không có trong bảng SKU chuẩn của kho (14/10: "CB10-XANH-G35" Combo 10 gói Xanh) → đúng số
 * gói lẻ mã chuẩn (10 × GRA-XANH-G35), giá một gói = giá combo chia số gói. Dòng khác giữ nguyên.
 */
function expandStandardCombo(line) {
  const parts = standardComboParts(line.sku);
  if (!parts) return line;
  return { ...line, sku: parts.sku, quantity: line.quantity * parts.units, price: Math.round((Number(line.price) || 0) / parts.units) };
}

/**
 * Sản phẩm danh mục của một dòng: theo SKU, hoặc SKU cũ đã đổi trong danh mục
 * (CB10-XANH → CB10-XANH-G35, như posSkuFor của POS) tra theo tên — chỉ nhận khi
 * SKU mới nối tiếp SKU cũ, để ký hiệu Pancake "CB2-XANH" (2 túi) không bị đọc
 * thành 1 túi GRA-XANH-Z450.
 */
function catalogProductFor(symbol, productLabel = '') {
  const direct = findProductBySku(symbol);
  if (direct) return direct;
  const sku = normalizeSkuToken(symbol);
  if (!sku || !productLabel) return null;
  const byName = matchProduct(String(productLabel));
  if (!byName?.sku) return null;
  const current = String(byName.sku).toUpperCase();
  return current.startsWith(`${sku}-`) ? byName : null;
}

export function splitSkuForExport(symbol, orderQuantity, orderPrice, useComboPricing = false, productLabel = '', shippingFee = 0, { paidPrice = false } = {}) {
  const raw = String(symbol || productLabel || '').trim();
  const quantity = Math.max(1, Number(orderQuantity) || 1);
  const price = Number(orderPrice) || 0;
  if (!raw) return [{ sku: '', quantity, price }];

  const catalogProduct = catalogProductFor(symbol, productLabel);
  if (catalogProduct) return splitCatalogSku(catalogProduct, quantity, useComboPricing, shippingFee, paidPrice ? price : 0).map(expandStandardCombo);

  const relation = resolveProductRelation(symbol, productLabel);
  if (relation) return expandRelation(relation, quantity);

  const parts = raw.split('+').map(part => part.trim()).filter(Boolean);
  const comboMatch = parts[0].match(/^CB\s*(\d+)\s*(?:-|\s)\s*(.*)$/i);
  if (comboMatch && Number(comboMatch[1]) === 10 && comboMatch[2].toUpperCase() === 'MIX') {
    const unitPrice = Math.round(price / 10);
    return [
      { sku: 'GRA-NAU-G35', quantity: 3 * quantity, price: unitPrice },
      { sku: 'GRA-XANH-G35', quantity: 4 * quantity, price: unitPrice },
      { sku: 'GRA-CAM-G30', quantity: 3 * quantity, price: unitPrice }
    ];
  }

  if (comboMatch) {
    const baseSku = mapSingleSku(comboMatch[2]);
    if (baseSku && (SKU_WEIGHTS[baseSku] !== undefined || baseSku !== comboMatch[2])) {
      const multiplier = Number(comboMatch[1]);
      const extraSkus = parts.slice(1).map(mapSingleSku);
      const productSkus = [baseSku, ...extraSkus.filter(sku => SKU_PRICES[sku])];
      const giftSkus = extraSkus.filter(sku => !SKU_PRICES[sku]);
      const totalUnits = multiplier * quantity;
      const items = productSkus.map((sku, index) => ({
        sku,
        quantity: Math.max(quantity, productSkus.length === 1 ? totalUnits : (index === 0 ? totalUnits - quantity * (productSkus.length - 1) : quantity)),
        price: getSkuPrice(sku, true, Math.round(price / multiplier))
      }));
      giftSkus.forEach(giftSku => {
        if (!items.some(item => item.sku === giftSku)) items.push({ sku: giftSku, quantity, price: 0 });
      });
      if (multiplier === 3) ['BGD', 'MUONG'].forEach(giftSku => {
        if (!items.some(item => item.sku === giftSku)) items.push({ sku: giftSku, quantity, price: 0 });
      });
      return items;
    }
  }

  if (parts.length > 1) {
    const mappedParts = parts.map(part => mapSingleSku(part.replace(/^CB-/i, '')));
    const allMapped = mappedParts.every(sku => sku && (SKU_WEIGHTS[sku] !== undefined || SKU_PRICES[sku]));
    if (allMapped) {
      const productSkus = mappedParts.filter(sku => sku !== 'BGD' && sku !== 'MUONG');
      const fallbackPrice = productSkus.length ? Math.round(price / productSkus.length) : 0;
      return mappedParts.map(sku => ({
        sku,
        quantity,
        price: sku === 'BGD' || sku === 'MUONG' ? 0 : getSkuPrice(sku, true, fallbackPrice)
      }));
    }
  }

  const singleSku = mapSingleSku(raw);
  return [{ sku: singleSku, quantity, price: getSkuPrice(singleSku, useComboPricing, price) }];
}

/**
 * Cột Địa chỉ của bảng xem trước chỉ hiện số nhà/đường: ba cấp đã có cột riêng
 * bên cạnh. File xuất vẫn ghi địa chỉ đầy đủ để kho đối chiếu.
 */
export function exportPreviewStreets(rows) {
  return rows.map(row => streetForDisplay(row[35], { province: row[36], district: row[37], ward: row[38] }));
}

/**
 * Dòng file xuất kho. `rows.locationCheck` kể lại kết quả kiểm tra ba cấp của
 * từng đơn: `invalid` là các đơn có tỉnh/quận/phường chưa đúng danh mục (kèm
 * lý do, số thứ tự đơn và chỉ số dòng nguồn). Với `skipInvalidLocations`, các
 * đơn đó bị bỏ khỏi file — và khỏi `rows.sourceRowIndexes` để nơi gọi loại
 * cùng những dòng nguồn ấy khi ghi tệp khách hàng.
 */
export function buildExportRows(orderData = {}, { skipInvalidLocations = false, orderFacts = null } = {}) {
  const headers = Array.isArray(orderData.headers) ? orderData.headers : [];
  const rows = Array.isArray(orderData.rows) ? orderData.rows : [];
  const sourceIndex = new Map(headers.map((header, index) => [normalizeColumnName(header), index]));
  // Tên cột hỏi tới là hằng ('Địa chỉ', 'Số lượng'...): chuẩn hoá một lần mỗi tên,
  // không lặp lại NFD + regex cho từng ô của hàng trăm dòng.
  const columnByLabel = new Map();
  const value = (row, header) => {
    let index = columnByLabel.get(header);
    if (index === undefined) {
      index = sourceIndex.get(normalizeColumnName(header)) ?? -1;
      columnByLabel.set(header, index);
    }
    return index < 0 ? '' : row[index] || '';
  };
  const rowIndexes = new Map(rows.map((row, index) => [row, index]));
  const exportableRows = rows.filter(row => !isInvalidOrderAddress(value(row, 'Địa chỉ')));
  const outputRows = [];
  const seenOrders = new Set();
  const skippedOrders = new Set();
  const invalidLocations = [];
  const giftNoteIssues = [];
  const giftLineOrders = new Set();
  const exportedSourceRowIndexes = [];
  const bagQuantityByOrder = new Map();
  const emittedSkusByOrder = new Map();
  let orderNumber = 0;

  // Catalogue lines of each order, so the order's combination decides its
  // gifts and shipping exactly as the chatbot did when it closed the sale.
  const catalogLinesByOrder = new Map();
  const lastRowIndexByOrder = new Map();
  exportableRows.forEach((row, rowIndex) => {
    const sourceOrderId = value(row, 'Mã đơn hàng');
    const orderKey = sourceOrderId ? `id:${sourceOrderId}` : `row:${rowIndex}`;
    lastRowIndexByOrder.set(orderKey, rowIndex);
    const symbol = value(row, 'Mã mẫu mã');
    const catalogProduct = catalogProductFor(symbol, value(row, 'Sản phẩm'));
    if (catalogProduct) {
      catalogLinesByOrder.set(orderKey, [...(catalogLinesByOrder.get(orderKey) || []), { sku: catalogProduct.sku, quantity: Number(value(row, 'Số lượng')) || 1 }]);
      return;
    }
    const items = splitSkuForExport(symbol, value(row, 'Số lượng'), value(row, 'Đơn giá'), false, value(row, 'Sản phẩm'));
    const bagQuantity = items.filter(item => SKU_PRICES[item.sku]).reduce((total, item) => total + (Number(item.quantity) || 0), 0);
    bagQuantityByOrder.set(orderKey, (bagQuantityByOrder.get(orderKey) || 0) + bagQuantity);
  });

  exportableRows.forEach((row, rowIndex) => {
    const phone = value(row, 'Số điện thoại');
    const sourceOrderId = value(row, 'Mã đơn hàng');
    const orderKey = sourceOrderId ? `id:${sourceOrderId}` : `row:${rowIndex}`;
    if (skippedOrders.has(orderKey)) return;
    const isFirstOrderLine = !seenOrders.has(orderKey);
    // Ba cấp được kiểm tra ở dòng đầu của đơn, trước khi đơn nhận số thứ tự,
    // để đơn bị bỏ không để lại lỗ trong cột STT của file.
    let location = null;
    if (isFirstOrderLine) {
      location = canonicalLocationColumns({
        province: value(row, 'Tỉnh/Thành phố'),
        district: value(row, 'Quận/Huyện'),
        ward: value(row, 'Phường/Xã'),
        address: value(row, 'Địa chỉ')
      });
      const check = checkLocationColumns(location);
      if (!check.ok) {
        invalidLocations.push({
          orderNumber: skipInvalidLocations ? null : orderNumber + 1,
          sourceOrderId,
          sourceRowIndex: rowIndexes.get(row),
          customer: value(row, 'Khách hàng'),
          phone,
          address: value(row, 'Địa chỉ'),
          ...location,
          issues: check.issues
        });
        if (skipInvalidLocations) { skippedOrders.add(orderKey); return; }
      }
    }
    exportedSourceRowIndexes.push(rowIndexes.get(row));
    if (isFirstOrderLine) { seenOrders.add(orderKey); orderNumber += 1; }
    const catalogLines = catalogLinesByOrder.get(orderKey) || [];
    const catalogQuantity = catalogLines.reduce((sum, line) => sum + line.quantity, 0);
    const basketKey = catalogLines.length ? comboKey(catalogLines) : '';
    const useComboPricing = (bagQuantityByOrder.get(orderKey) || 0) + catalogQuantity >= 2;
    // Shipping (when the combination was not given free shipping) rides on the
    // order's first catalogue line only.
    // Đơn khách livestream trong file: địa chỉ mở đầu "(Live) " (bot/nhân viên ghi)
    // hoặc cột "Livestream" = Có/true/1 — mới kèm quà chỉ khách live.
    // Đơn hệ thống (CB-/LP-…): cờ trên đơn ở máy chủ (orderFacts) — đơn nhân viên
    // tạo cho khách live có cờ livestream mà địa chỉ không mang "(Live) ".
    const facts = sourceOrderId && orderFacts?.get ? orderFacts.get(String(sourceOrderId).trim()) || null : null;
    const livestream = Boolean(facts?.livestream)
      || /^\s*\(live\)/i.test(String(value(row, 'Địa chỉ') || ''))
      || /^(co|true|1|x|yes)$/i.test(normalizeColumnName(value(row, 'Livestream')));
    // Miễn ship theo cờ đơn: đơn dùng thử bám đuổi ghi "(Freeship) " đầu địa chỉ
    // (hay cột "Miễn ship" = Có) thì không cộng phí ship dù giỏ 1 túi.
    const freeShipFlag = /^\s*(\(live\)\s*)?\(freeship\)/i.test(String(value(row, 'Địa chỉ') || ''))
      || /^(co|true|1|x|yes)$/i.test(normalizeColumnName(value(row, 'Miễn ship')));
    const shippingFee = basketKey && isFirstOrderLine && !freeShipFlag ? shippingFeeForKey(basketKey, { livestream }) : 0;
    // Ô Đơn giá của đơn hệ thống là giá khách trả (paidPrice, đã gồm ship nhân
    // viên thu và giá gõ tay): dùng thẳng; ô trống/0 thì tính theo bộ giá như cũ.
    const items = splitSkuForExport(value(row, 'Mã mẫu mã'), value(row, 'Số lượng'), value(row, 'Đơn giá'), useComboPricing, value(row, 'Sản phẩm'), shippingFee, { paidPrice: true });
    // Quà của đơn, một lần sau dòng sản phẩm cuối. Mã đã ra ở dòng trước của cùng
    // đơn (combo POS "CB3-…+BGD+M" đã gồm bát + muỗng) không ghi lại lần hai.
    const emitted = emittedSkusByOrder.get(orderKey) || new Set();
    if (lastRowIndexByOrder.get(orderKey) === rowIndex) {
      const has = sku => emitted.has(sku) || items.some(item => item.sku === sku);
      const addGift = (sku, quantity, weight) => {
        const code = String(sku || '').trim().toUpperCase();
        // Quà là túi sản phẩm (01/10: đơn 5 túi tặng 1 Túi Vàng, 10 túi thêm Túi Nâu): dòng tặng giá 0
        // riêng, kể cả khi khách cũng mua túi cùng mã — chỉ bỏ khi đã có dòng tặng (giá 0) cùng mã.
        const duplicate = findProductBySku(code) ? items.some(item => item.sku === code && !(Number(item.price) > 0)) : has(code);
        if (code && !duplicate) items.push({ sku: code, quantity: Math.max(1, Math.round(Number(quantity) || 1)), price: 0, weight: weight || skuWeight(code), gift: true });
      };
      // Đơn nguồn POS (nhân viên/Facebook Shop lên trên Pancake): quà là đúng các
      // dòng tặng trên POS (Quà Tặng LIVE nhân viên thêm tay…), không đoán lại.
      const posGifts = Array.isArray(facts?.posGifts) && facts.posGifts.length ? facts.posGifts : null;
      // R13 (gộp): đơn hệ thống khách đã ĐỔI QUÀ (facts.giftSwap — order.giftSwap / giftSwapRemoved): bỏ dòng quà khách đã
      // đổi (bát/muỗng/quạt), thêm dòng gói nhỏ thay thế giá 0 — cùng kế hoạch với đơn đẩy POS (giftSwapPlan). Gói chưa
      // chọn vị (không SKU) không lên dòng (kho không nhận dòng không mã) — nhân viên đã có ghi chú xử lý trên đơn.
      // Đơn không đổi quà (swap = null) chạy y như cũ.
      // Đơn Zalo (14/10): quà là đúng các SKU nhân viên nhập ở trang Đơn Zalo (cột "Quà tặng (SKU)"), giá 0,
      // thay quà theo giỏ; ô trống thì đơn không kèm quà.
      const zaloGifts = !posGifts && !facts?.giftOverride && isZaloSource(value(row, 'Nguồn đơn'))
        ? { lines: parseGiftSkus(value(row, ZALO_GIFT_COLUMN)).map(line => ({ sku: line.sku, quantity: line.quantity, weight: 0 })) }
        : null;
      const override = !posGifts && facts?.giftOverride ? facts.giftOverride : zaloGifts;
      const swap = !posGifts && !override && facts?.giftSwap ? giftSwapPlan(facts.giftSwap) : null;
      const basketGifts = !posGifts && !override && basketKey ? giftsForKey(basketKey, { livestream }) : [];
      if (posGifts) posGifts.forEach(gift => addGift(gift.sku, gift.quantity, gift.weight));
      // Quà chọn tay: đúng danh sách nhân viên chọn, không thêm quà theo bảng / bát ưu đãi bám đuổi.
      else if (override) override.lines.forEach(line => addGift(line.sku, line.quantity, line.weight));
      // Còn lại: quà tick cho tổ hợp giỏ trong Cài đặt → Quà tặng.
      else {
        basketGifts.filter(gift => !swap?.removes(gift)).forEach(gift => addGift(gift.sku, 1, gift.weight));
        (swap?.lines || []).forEach(line => addGift(line.sku, line.quantity, line.weight));
      }
      // Quà ưu đãi bám đuổi (bộ bát gáo dừa cho combo đúng 2 túi): cờ đơn, ghi chú
      // đơn ("Ưu đãi bám đuổi combo 2 túi: tặng …") hay cột "Quà ưu đãi" → dòng BGD.
      // Đơn đã có quà live (Quạt + Bát gáo dừa) thì không thêm bát thứ hai.
      const promo = facts?.promoGift || String(value(row, 'Quà ưu đãi') || '').trim() || /ưu đãi bám đuổi combo 2 túi: tặng/i.test(String(value(row, 'Ghi chú') || ''));
      const liveSkus = [...livestreamGiftSkus()];
      // (Đơn đổi quà: quà live đã bị thay vẫn tính là "đơn có quà live" — không thêm bát ưu đãi; bát đã đổi cũng không thêm.)
      const hasLiveGift = liveSkus.some(has) || (Boolean(swap) && basketGifts.some(gift => liveSkus.includes(String(gift.sku || '').trim().toUpperCase())));
      if (!override && promo && catalogQuantity === 2 && !hasLiveGift && !has('BGD')) {
        const bowl = (getGifts() || []).find(gift => String(gift.sku || '').trim().toUpperCase() === 'BGD');
        if (!swap?.removes(bowl || { name: '', sku: 'BGD' })) items.push({ sku: 'BGD', quantity: 1, price: 0, weight: bowl?.weight || SKU_WEIGHTS.BGD });
        const promoText = String(value(row, 'Quà ưu đãi') || value(row, 'Ghi chú') || (typeof promo === 'string' ? promo : '') || facts?.promoGift || '');
        if (/mu[oỗ]ng/i.test(promoText) && !has('MUONG')) {
          const spoon = (getGifts() || []).find(gift => String(gift.sku || '').trim().toUpperCase() === 'MUONG');
          if (!swap?.removes(spoon || { name: '', sku: 'MUONG' })) items.push({ sku: 'MUONG', quantity: 1, price: 0, weight: spoon?.weight || SKU_WEIGHTS.MUONG });
        }
      }
      // Ghi chú quà nhân viên ghi trong ngoặc đầu địa chỉ ("(Tặng BGD) …", "(Live Tặng yến mạch 2 túi) …",
      // quy ước kho 12/10): quà đơn chưa có thì thêm dòng giá 0; phần không đọc ra được thì báo ở màn Xuất.
      const noted = addressGiftNotes(value(row, 'Địa chỉ'));
      noted.lines.forEach(line => addGift(line.sku, line.quantity));
      if (noted.unknown.length) giftNoteIssues.push({ orderNumber, sourceOrderId, customer: value(row, 'Khách hàng'), text: noted.unknown.join(', ') });
      // Chỉ ghi "(Live)" (không ghi quà khác) = đơn có quà Live (hiện là Quạt, chủ shop 14/10). Chỉ thêm khi đơn
      // chưa có dòng quà nào: đơn đã có quà (đổi quạt lấy bát + muỗng, quà chọn tay…) giữ nguyên.
      const hasGiftLine = giftLineOrders.has(orderKey) || items.some(item => item.gift || !(Number(item.price) > 0));
      if (noted.liveOnly && !hasGiftLine && !override && !swap) addGift(LIVE_GIFT_POS_SKU, 1);
    }
    items.forEach(item => { if (item.sku) emitted.add(item.sku); });
    if (items.some(item => item.sku && (item.gift || !(Number(item.price) > 0)))) giftLineOrders.add(orderKey);
    emittedSkusByOrder.set(orderKey, emitted);
    items.forEach((item, itemIndex) => {
      const output = Array(EXPORT_COLUMNS.length).fill('');
      if (isFirstOrderLine && itemIndex === 0) {
        // Đơn Zalo (cột "Nguồn đơn" = Zalo, trang Đơn Zalo) ghi nguồn "zalo" (chữ thường, kho yêu cầu 14/10); còn lại "facebook" (cũng chữ thường, chủ shop 14/10).
        output[0] = orderNumber; output[2] = isZaloSource(value(row, 'Nguồn đơn')) ? 'zalo' : 'facebook'; output[4] = 'Có'; output[6] = 'Có';
        output[8] = 'Thanh toán COD'; output[30] = phone;
        output[33] = value(row, 'Khách hàng'); output[34] = phone; output[35] = value(row, 'Địa chỉ');
        // Tên tỉnh/quận/phường đúng danh mục kho (đã đọc và kiểm tra ở trên).
        output[36] = location.province;
        output[37] = location.district;
        output[38] = location.ward;
      }
      // Đơn Zalo: mã hàng (không phải quà) chưa có khối lượng ở danh mục / bảng mã → mặc định 500g (chủ shop 14/10).
      const sku = warehouseSku(item.sku);
      const knownWeight = item.weight || skuWeight(item.sku) || skuWeight(sku);
      // Quà tặng luôn 0đ trong file kho (chủ shop 14/10: tệp POS có dòng "Quà Tặng LIVE" 50.000đ).
      output[19] = sku; output[21] = item.quantity; output[22] = item.gift || isGiftOnlySku(item.sku) ? 0 : item.price;
      output[24] = knownWeight || (!item.gift && isZaloSource(value(row, 'Nguồn đơn')) ? ZALO_DEFAULT_WEIGHT : '');
      // Thuế là thuộc tính của từng dòng sản phẩm (kể cả quà), không chỉ dòng đầu đơn.
      // 13/10 (kho): cột Thuế phải là KIỂU SỐ — ghi 0.08, ô mẫu định dạng 0% nên Excel hiện "8%" (chữ "8%" kho không nhận).
      output[28] = 0.08;
      outputRows.push(output);
    });
  });
  outputRows.locationCheck = { checked: seenOrders.size + (skipInvalidLocations ? skippedOrders.size : 0), invalid: invalidLocations };
  // Mã SKU ngoài bảng chuẩn của kho (app/warehouse-skus.mjs): màn Xuất dữ liệu cảnh báo, không chặn xuất.
  outputRows.skuCheck = { unknown: [...new Set(outputRows.map(row => String(row[19] || '').trim()).filter(sku => sku && !isStandardWarehouseSku(sku)))], giftNotes: giftNoteIssues };
  outputRows.sourceRowIndexes = exportedSourceRowIndexes;
  return outputRows;
}

/** Dữ liệu nguồn chỉ còn những dòng đã vào file, để tệp khách hàng không ghi đơn bị bỏ. */
export function exportedOrderData(orderData = {}, rows) {
  const keep = new Set(rows.sourceRowIndexes || []);
  return { headers: orderData.headers, rows: (orderData.rows || []).filter((_, index) => keep.has(index)) };
}
