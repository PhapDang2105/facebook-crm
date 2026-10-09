import { readFileSync, writeFileSync } from 'node:fs';

const path = './data/processed/gifts.json';
const content = readFileSync(path, 'utf8');
const updated = content.replace(/"sku":\s*"QUAT"/g, '"sku": "QUA-TANG-LIVE"');
writeFileSync(path, updated, 'utf8');
console.log('Updated gifts.json successfully. Checking occurrences:');
const lines = updated.split('\n');
lines.forEach((line, i) => {
  if (line.includes('QUA-TANG-LIVE')) console.log(`${i + 1}: ${line}`);
});
