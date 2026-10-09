import { posConfig } from '../app/phone-warnings.mjs';

const cfg = posConfig();
const url = `${cfg.baseUrl.replace(/\/+$/, '')}/shops/${cfg.shopId}/variations?api_key=${cfg.apiKey}&page_size=100`;

console.log('Fetching POS variations from:', cfg.baseUrl, 'shopId:', cfg.shopId);
const res = await fetch(url);
const data = await res.json();
const items = data.data || [];
console.log(`Total variations retrieved: ${items.length}`);
for (const v of items) {
  const info = `${v.display_id || ''} | ${v.name || ''} | ID: ${v.id || ''}`;
  console.log(info);
}
