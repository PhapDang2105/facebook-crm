// The basket a customer named and the phone/address they give afterwards almost
// never arrive in the same message. The old workflow kept the basket in static data
// for two hours; here it is stored on the conversation record so it survives a
// restart and stays scoped to one customer.

export const pendingOrderTtlMs = 2 * 60 * 60 * 1000;
export const orderStepTemplateIds = ['ORDER_ADDRESS', 'ORDER_PHONE', 'ORDER_CONFIRMATION'];

export function isOrderStep(templateId) {
  return orderStepTemplateIds.includes(String(templateId || '').trim());
}

export function normalizePendingOrder(value) {
  const items = Array.isArray(value?.items) ? value.items : [];
  const key = String(value?.key || '').trim();
  const at = Number(value?.at) || 0;
  const phone = String(value?.phone || '').trim();
  const address = String(value?.address || '').trim();
  // A record holding only a phone number is still worth keeping: customers give
  // contact details before naming products just as often as the other way round.
  if (!at || (!items.length && !phone && !address)) return null;
  return {
    key,
    at,
    // Phone and address ride along with the basket: the customer supplies each
    // in a different message, and the model only echoes back what it just heard.
    phone,
    address,
    items: items.map(item => ({
      product: String(item?.product || '').trim(),
      code: String(item?.code || '').trim(),
      quantity: Math.max(1, Math.round(Number(item?.quantity) || 1))
    })).filter(item => item.product)
  };
}

/** A basket is reusable only while the conversation is still on an order step. */
export function usablePendingOrder(value, { now = Date.now(), templateId = '' } = {}) {
  const pending = normalizePendingOrder(value);
  if (!pending) return null;
  if (!isOrderStep(templateId)) return null;
  if (now - pending.at > pendingOrderTtlMs) return null;
  return pending;
}
