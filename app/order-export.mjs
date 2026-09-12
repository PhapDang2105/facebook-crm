import { findProductBySku } from './processing/catalog.mjs';
import { giftsFor, shippingFeeFor, unitPriceInBasket } from './processing/pricing.mjs';

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
  'HT-YM-T500': 500,
  'YM-VO-T500': 500,
  'HU-300ML': 10,
  BGD: 10,
  MUONG: 10
});

const SKU_PRICES = Object.freeze({
  'GRA-NAU-Z350': { single: 179000, combo: 144000 },
  'GRA-VANG-H350': { single: 189000, combo: 149000 },
  'GRA-XANH-Z450': { single: 189000, combo: 149000 }
});

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

export function normalizeExportLocation(value) {
  const location = String(value ?? '').trim();
  return ({
    'Hồ Chí Minh': 'TP Hồ Chí Minh',
    'Thành phố Thanh Hoá': 'Thành phố Thanh Hóa'
  })[location] || location;
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

/** Weight of any SKU: the catalogue first, then the legacy table. */
export function skuWeight(sku) {
  const product = findProductBySku(sku);
  if (product?.weight) return product.weight;
  return SKU_WEIGHTS[sku] ?? '';
}

/**
 * A row whose "Mã mẫu mã" is a catalogue SKU — every order the chatbot or the
 * manual form creates — is expanded from the catalogue: its components (a
 * Combo 10 gói ships as ten small bags) at the single or combo price, with
 * the weight staff entered. The legacy Pancake symbols below stay untouched.
 */
function splitCatalogSku(product, quantity, useComboPricing, shippingFee = 0) {
  const unit = unitPriceInBasket(product, useComboPricing ? 2 : 1);
  const components = product.components.length ? product.components : [{ sku: product.sku, quantity: 1 }];
  const unitsPerProduct = components.reduce((sum, component) => sum + component.quantity, 0) || 1;
  // Shipping is folded into the price of the shipped units: one bag leaves
  // at 189.000đ (174.000đ + 15.000đ), which is what the order must show.
  const shipPerUnit = shippingFee ? Math.round(shippingFee / (unitsPerProduct * quantity)) : 0;
  return components.map(component => ({
    sku: component.sku,
    quantity: component.quantity * quantity,
    price: Math.round(unit / unitsPerProduct) + shipPerUnit,
    catalog: true
  }));
}

export function splitSkuForExport(symbol, orderQuantity, orderPrice, useComboPricing = false, productLabel = '', shippingFee = 0) {
  const raw = String(symbol || productLabel || '').trim();
  const quantity = Math.max(1, Number(orderQuantity) || 1);
  const price = Number(orderPrice) || 0;
  if (!raw) return [{ sku: '', quantity, price }];

  const catalogProduct = findProductBySku(symbol);
  if (catalogProduct) return splitCatalogSku(catalogProduct, quantity, useComboPricing, shippingFee);

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

export function buildExportRows(orderData = {}) {
  const headers = Array.isArray(orderData.headers) ? orderData.headers : [];
  const rows = Array.isArray(orderData.rows) ? orderData.rows : [];
  const sourceIndex = new Map(headers.map((header, index) => [normalizeColumnName(header), index]));
  const value = (row, header) => {
    const index = sourceIndex.get(normalizeColumnName(header));
    return index === undefined ? '' : row[index] || '';
  };
  const exportableRows = rows.filter(row => !isInvalidOrderAddress(value(row, 'Địa chỉ')));
  const outputRows = [];
  const seenOrders = new Set();
  const bagQuantityByOrder = new Map();
  let orderNumber = 0;

  const catalogQuantityByOrder = new Map();
  const lastRowIndexByOrder = new Map();
  exportableRows.forEach((row, rowIndex) => {
    const sourceOrderId = value(row, 'Mã đơn hàng');
    const orderKey = sourceOrderId ? `id:${sourceOrderId}` : `row:${rowIndex}`;
    lastRowIndexByOrder.set(orderKey, rowIndex);
    const symbol = value(row, 'Mã mẫu mã');
    if (findProductBySku(symbol)) {
      // Catalogue products count as sold units for combo pricing and gifts.
      catalogQuantityByOrder.set(orderKey, (catalogQuantityByOrder.get(orderKey) || 0) + (Number(value(row, 'Số lượng')) || 1));
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
    const isFirstOrderLine = !seenOrders.has(orderKey);
    if (isFirstOrderLine) { seenOrders.add(orderKey); orderNumber += 1; }
    const catalogQuantity = catalogQuantityByOrder.get(orderKey) || 0;
    const useComboPricing = (bagQuantityByOrder.get(orderKey) || 0) + catalogQuantity >= 2;
    // Shipping (when the order has not earned free shipping) rides on the
    // order's first catalogue line only.
    const shippingFee = catalogQuantity && isFirstOrderLine ? shippingFeeFor(catalogQuantity) : 0;
    const items = splitSkuForExport(value(row, 'Mã mẫu mã'), value(row, 'Số lượng'), value(row, 'Đơn giá'), useComboPricing, value(row, 'Sản phẩm'), shippingFee);
    // Gifts from Cài đặt → Quà tặng, once per order, after its last product line.
    if (catalogQuantity && lastRowIndexByOrder.get(orderKey) === rowIndex) {
      for (const gift of giftsFor(catalogQuantity)) {
        if (gift.sku && !items.some(item => item.sku === gift.sku)) items.push({ sku: gift.sku, quantity: 1, price: 0, weight: gift.weight });
      }
    }
    items.forEach((item, itemIndex) => {
      const output = Array(EXPORT_COLUMNS.length).fill('');
      if (isFirstOrderLine && itemIndex === 0) {
        output[0] = orderNumber; output[2] = 'Facebook'; output[4] = 'Có'; output[6] = 'Có';
        output[8] = 'Thanh toán COD'; output[28] = '8%'; output[30] = phone;
        output[33] = value(row, 'Khách hàng'); output[34] = phone; output[35] = value(row, 'Địa chỉ');
        output[36] = normalizeExportLocation(value(row, 'Tỉnh/Thành phố'));
        output[37] = normalizeExportLocation(value(row, 'Quận/Huyện'));
        output[38] = normalizeExportLocation(value(row, 'Phường/Xã'));
      }
      output[19] = item.sku; output[21] = item.quantity; output[22] = item.price; output[24] = item.weight || skuWeight(item.sku);
      outputRows.push(output);
    });
  });
  return outputRows;
}
