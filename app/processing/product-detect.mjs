import { getCatalogProducts, matchProduct, normalizeText } from './catalog.mjs';

function productByAdColour(adTitle) {
  const text = ` ${normalizeText(adTitle || '')} `;
  const match = text.match(/ (?:mess|mes|qc|ads?) [^a-z]*(xanh|vang|nau) | (xanh|vang|nau) [^a-z]*(?:mess|mes|qc|ads?) /);
  const colour = match ? (match[1] || match[2]) : '';
  if (!colour) return '';
  const product = getCatalogProducts().find(item => item.active !== false && /^gra-/i.test(item.sku || '') && String(item.sku || '').toLowerCase().includes(`-${colour}-`));
  return product?.name || '';
}

// Which product a conversation is about, read from the catalogue's names and
// aliases. The keyword table this file used to carry is now the "Tên gọi khác"
// field on each product, so a new product is detected the moment it is saved.
// The old rule still holds through the seeded aliases: no bare colour words,
// because marketing copy is full of "bột chuối xanh" and "hạt bí xanh".

export const unknownProduct = 'Không xác định';

/** Returns the catalogue name of the product the text refers to, or 'Không xác định'. */
export function detectProduct(text) {
  return matchProduct(text)?.name || unknownProduct;
}

/**
 * Picks the product for a conversation. Anything the customer names
 * themselves wins; otherwise the ad they clicked, then the Page post they
 * commented under (or came from into Messenger) — both are things they chose
 * to react to, so the product in them is what they are asking about.
 */
export function resolveConversationProduct({ messageText = '', adTitle = '', referralRef = '', postText = '' } = {}) {
  const fromMessage = detectProduct(messageText);
  if (fromMessage !== unknownProduct) return { product: fromMessage, source: 'message' };
  const fromAd = detectProduct([adTitle, referralRef].filter(Boolean).join(' '));
  if (fromAd !== unknownProduct) return { product: fromAd, source: 'ad' };
  // Tên quảng cáo nội bộ chỉ ghi màu túi ("qc mess 2504 · mess Xanh", "xanh mes"):
  // màu đứng cạnh chữ mess/mes/qc là túi lớn màu đó.
  const fromAdColour = productByAdColour(adTitle);
  if (fromAdColour) return { product: fromAdColour, source: 'ad' };
  const fromPost = detectProduct(postText);
  if (fromPost !== unknownProduct) return { product: fromPost, source: 'post' };
  return { product: unknownProduct, source: '' };
}

/** The one-line hint handed to the model. */
export function productHint(product, { legacy = false } = {}) {
  const name = String(product || '').trim();
  if (!name || name === unknownProduct) return '';
  // Bản cũ khớp chữ "đang tương tác với…" trong prompt đang chạy; bản gọn khớp "Khách đang xem".
  return legacy ? `Hệ thống chú ý khách hàng đang tương tác với ${name}` : `Khách đang xem: ${name}`;
}
