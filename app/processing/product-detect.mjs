// Ported from the n8n nodes "Xử lý Content" and "Xử lý sản phẩm".
// Order matters: the first table that matches wins, and the tables deliberately
// avoid bare colour words ("xanh", "vàng", "nâu", "cam") because the marketing
// copy is full of them — "bột chuối xanh", "hạt bí xanh" — and a bare match
// would name the wrong product. "Yến mạch" alone is excluded for the same
// reason: granola lists it as an ingredient.

export function normalizeDetectText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

const productKeywords = [
  ['Túi Xanh', ['túi xanh', 'granola túi xanh', 'granola xanh', '#granolatuixanh']],
  ['Túi Vàng', ['túi vàng', 'granola túi vàng', 'granola vàng', 'granola nhiều hạt quả', 'nhiều hạt quả 350g', 'nhiều hạt quả 350 g', '#granolatuivang']],
  ['Túi Nâu', ['túi nâu', 'granola túi nâu', 'granola nâu', 'granola cacao', 'granola vị cacao', 'granola vị ca cao', 'granola ca cao', 'vị cacao 350g', 'vị cacao 350 g', 'vị ca cao 350g', 'vị ca cao 350 g', '#granolatuinau']],
  ['Túi Cam', ['túi cam', 'granola túi cam', 'granola cam', 'granola bơ hạt điều', 'granola vị bơ hạt điều', 'vị bơ hạt điều', '#granolatuicam']],
  ['Hạt An Lành dạng hũ', ['hạt an lành']],
  ['Yến Mạch Úc Nguyên Cám', ['yến mạch úc', 'yến mạch úc nguyên cám', 'yến mạch nguyên cám', 'yến mạch cán dẹt', 'yến mạch cán dẹt úc', 'yến mạch úc cán dẹt', 'yến mạch cán dẹt giọt nắng', 'yến mạch giọt nắng', 'túi yến mạch', 'yến mạch 500g', 'yến mạch 500 g']],
  ['Granola', ['granola giọt nắng', 'granola']]
].map(([product, keywords]) => ({ product, keywords: keywords.map(normalizeDetectText) }));

export const unknownProduct = 'Không xác định';

/** Returns the product name a piece of text refers to, or 'Không xác định'. */
export function detectProduct(text) {
  const content = normalizeDetectText(text);
  if (!content) return unknownProduct;
  const match = productKeywords.find(entry => entry.keywords.some(keyword => content.includes(keyword)));
  return match ? match.product : unknownProduct;
}

/**
 * Picks the product for a conversation. The ad or post the customer came from
 * is the stronger signal — they clicked it on purpose — but anything they name
 * themselves afterwards overrides it.
 */
export function resolveConversationProduct({ messageText = '', adTitle = '', referralRef = '' } = {}) {
  const fromMessage = detectProduct(messageText);
  if (fromMessage !== unknownProduct) return { product: fromMessage, source: 'message' };
  const fromAd = detectProduct([adTitle, referralRef].filter(Boolean).join(' '));
  if (fromAd !== unknownProduct) return { product: fromAd, source: 'ad' };
  return { product: unknownProduct, source: '' };
}

/** The one-line hint handed to the model, mirroring n8n's thongBaoHeThong. */
export function productHint(product) {
  const name = String(product || '').trim();
  if (!name || name === unknownProduct) return '';
  return `Hệ thống chú ý khách hàng đang tương tác với ${name}`;
}
