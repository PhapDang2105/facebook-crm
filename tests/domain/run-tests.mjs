import assert from 'node:assert/strict';
import { createLead, getSegments, normalizePhone, updateLead } from '../../app/domain.mjs';

assert.equal(normalizePhone('0901 234 567'), '+84901234567', 'Normalize phone');

const lead = createLead({ name: ' Test User ', phone: '0901234567', email: 'USER@EXAMPLE.TEST' });
assert.equal(lead.name, 'Test User', 'Normalize name');
assert.equal(lead.email, 'user@example.test', 'Normalize email');
assert.equal(lead.status, 'new', 'Default status');

const updated = updateLead(lead, { status: 'won', owner: 'Hang' });
assert.equal(updated.status, 'won', 'Update pipeline');
assert.equal(updated.owner, 'Hang', 'Assign lead');
assert.equal(getSegments([updated]).find(segment => segment.id === 'customers').count, 1, 'Customer segment');

console.log('PASS: 7 domain assertions');
