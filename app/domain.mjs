import crypto from 'node:crypto';

const allowedStatuses = new Set(['new', 'assigned', 'contacting', 'qualified', 'consulting', 'waiting', 'won', 'lost', 'invalid']);

export function normalizePhone(value = '') {
  const digits = String(value).replace(/\D/g, '');
  if (digits.startsWith('84') && digits.length >= 11) return `+${digits}`;
  if (digits.startsWith('0') && digits.length >= 9) return `+84${digits.slice(1)}`;
  return digits;
}

export function createLead(input) {
  if (!String(input.name || '').trim()) throw new Error('Customer name is required.');
  const status = input.status || 'new';
  if (!allowedStatuses.has(status)) throw new Error(`Invalid lead status: ${status}`);
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    name: String(input.name).trim(),
    phone: normalizePhone(input.phone),
    email: String(input.email || '').trim().toLowerCase(),
    source: input.source || 'manual',
    campaign: String(input.campaign || ''),
    product: String(input.product || ''),
    status,
    owner: String(input.owner || ''),
    value: Number(input.value || 0),
    tags: input.tags || [],
    createdAt: now,
    updatedAt: now
  };
}

export function updateLead(lead, changes) {
  if (changes.status && !allowedStatuses.has(changes.status)) throw new Error(`Invalid lead status: ${changes.status}`);
  if (changes.status) lead.status = changes.status;
  if (Object.hasOwn(changes, 'owner')) lead.owner = String(changes.owner);
  if (Object.hasOwn(changes, 'value')) lead.value = Number(changes.value);
  lead.updatedAt = new Date().toISOString();
  return lead;
}

export function getSegments(leads) {
  const inactiveBefore = Date.now() - 30 * 86400000;
  return [
    { id: 'uncontacted', name: 'Uncontacted leads', count: leads.filter(lead => lead.status === 'new').length },
    { id: 'remarketing', name: 'Consulted, not purchased', count: leads.filter(lead => ['qualified', 'consulting', 'waiting'].includes(lead.status)).length },
    { id: 'customers', name: 'Customers', count: leads.filter(lead => lead.status === 'won').length },
    { id: 'inactive', name: 'Inactive for 30 days', count: leads.filter(lead => !['won', 'invalid'].includes(lead.status) && Date.parse(lead.updatedAt) < inactiveBefore).length },
    { id: 'exclude', name: 'Advertising exclusion', count: leads.filter(lead => ['won', 'invalid'].includes(lead.status)).length }
  ];
}
