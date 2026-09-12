// Ported from the n8n workflow "Smax - Dify AI - Smax Version 2", node
// "Hậu Xử Lý JSON cho Smax". The rules are deliberately strict: a basket that
// cannot be priced exactly produces no key at all, so the caller hands the
// conversation to a human instead of inventing a total.

const comboOnlyCodes = ['CACAO300', 'COMBO10_MIX', 'COMBO10_XANH', 'COMBO10_NAU', 'COMBO10_CAM'];
const bagCodes = ['XANH', 'VANG', 'NAU'];
const maximumQuantityPerCode = 3;

export function normalizeProductText(value) {
  return String(value ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase();
}

/**
 * Maps a free-text product name to a pricing code, or '' when unrecognised.
 *
 * Two products carry cacao: Túi Nâu 350g and Tropical Cacao 300g. The rule
 * inherited from n8n sent every mention of "cacao" to CACAO300, so "Granola Túi
 * Nâu vị cacao" — the bag's own full name — priced at 219.000đ instead of
 * 179.000đ, and contradicted product-detect.mjs, which reads the same text as
 * Túi Nâu. CACAO300 now has to be named by "tropical" or by its 300g size.
 */
export function productCode(product) {
  const name = normalizeProductText(product).replace(/ca cao/g, 'cacao');
  if (!name) return '';
  if (name.includes('combo 10') && name.includes('mix')) return 'COMBO10_MIX';
  if (name.includes('combo 10') && name.includes('xanh')) return 'COMBO10_XANH';
  if (name.includes('combo 10') && name.includes('nau')) return 'COMBO10_NAU';
  if (name.includes('combo 10') && name.includes('cam')) return 'COMBO10_CAM';
  if (name.includes('tropical') || (name.includes('cacao') && name.includes('300'))) return 'CACAO300';
  if (name.includes('xanh')) return 'XANH';
  if (name.includes('vang')) return 'VANG';
  // Bare cacao means the brown bag — the same answer product-detect.mjs gives.
  if (name.includes('nau') || name.includes('cacao')) return 'NAU';
  return '';
}

/**
 * Builds the price-table key for a basket.
 * Returns '' — meaning "cannot be priced" — when any item is unrecognised, any
 * quantity falls outside 1..3, or a combo product is mixed with anything else.
 */
export function orderKey(items = []) {
  const counts = items.reduce((result, item) => {
    const code = item?.code ?? productCode(item?.product ?? item?.name);
    const quantity = Math.round(Number(item?.quantity) || 0);
    if (!code) return { ...result, '': (result[''] || 0) + 1 };
    return { ...result, [code]: (result[code] || 0) + quantity };
  }, {});
  const codes = Object.keys(counts);
  if (!codes.length) return '';
  if (codes.some(code => !code || counts[code] < 1 || counts[code] > maximumQuantityPerCode)) return '';
  if (codes.length === 1 && comboOnlyCodes.includes(codes[0])) return `${codes[0]}=${counts[codes[0]]}`;
  if (codes.some(code => !bagCodes.includes(code))) return '';
  return bagCodes.filter(code => counts[code]).map(code => `${code}=${counts[code]}`).join('|');
}

/** Normalises loose model output into the {product, code, quantity} shape. */
export function toPricedItems(rawItems = []) {
  return rawItems
    .map(item => ({
      product: String(item?.product ?? item?.name ?? '').trim(),
      code: productCode(item?.product ?? item?.name),
      quantity: Math.round(Number(item?.quantity) || 0)
    }))
    .filter(item => item.product || item.quantity > 0);
}
