import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const nodePath = path.join(projectRoot, 'tools', 'node', 'node.exe');
// The test writes to a throwaway store so a real inbox is never touched.
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'crm-webhook-test-'));
const storePath = path.join(temporaryDirectory, 'meta-conversations.json');
const port = Number(process.argv[2]) || 8123;
const appSecret = 'integration-app-secret';
const verifyToken = 'integration-verify-token';
const pageId = '100000000000001';
const psid = '55667788';
const baseUrl = `http://127.0.0.1:${port}`;
const checks = [];

function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail });
}

function signPayload(payload) {
  return `sha256=${createHmac('sha256', appSecret).update(Buffer.from(payload, 'utf8')).digest('hex')}`;
}

function postWebhook(payload, signature) {
  return fetch(`${baseUrl}/webhooks/facebook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Hub-Signature-256': signature } : {}) },
    body: payload
  });
}

async function waitForServer(attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return true;
    } catch { /* The server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('CRM server did not start in time.');
}

const server = spawn(nodePath, [path.join(projectRoot, 'app', 'server.mjs'), String(port)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    META_APP_ID: pageId,
    META_APP_SECRET: appSecret,
    META_GRAPH_VERSION: 'v21.0',
    META_VERIFY_TOKEN: verifyToken,
    PUBLIC_BASE_URL: 'https://crm.example.com',
    META_CONVERSATIONS_PATH: storePath
  },
  stdio: ['ignore', 'ignore', 'inherit']
});

try {
  await waitForServer();

  const verified = await fetch(`${baseUrl}/webhooks/facebook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=CHALLENGE123`);
  check('Webhook verification returns the challenge', verified.status === 200 && (await verified.text()) === 'CHALLENGE123');
  check('Webhook verification rejects a wrong token',
    (await fetch(`${baseUrl}/webhooks/facebook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=X`)).status === 403);

  const payload = JSON.stringify({
    object: 'page',
    entry: [{
      id: pageId,
      time: Date.now(),
      messaging: [{
        sender: { id: psid },
        recipient: { id: pageId },
        timestamp: Date.now(),
        message: { mid: 'mid.integration.1', text: 'Cho mình hỏi giá combo 3 với ạ' }
      }]
    }]
  });
  const signature = signPayload(payload);

  check('Unsigned delivery is rejected', (await postWebhook(payload)).status === 401);
  check('Tampered delivery is rejected', (await postWebhook(payload.replace('combo 3', 'combo 9'), signature)).status === 401);

  const accepted = await postWebhook(payload, signature);
  check('Signed delivery is accepted', accepted.status === 200 && (await accepted.text()) === 'EVENT_RECEIVED');
  await postWebhook(payload, signature);
  await new Promise(resolve => setTimeout(resolve, 600));

  const conversations = await (await fetch(`${baseUrl}/api/messaging/conversations?channelId=${pageId}`)).json();
  const conversation = conversations.items?.[0];
  check('Delivery creates one conversation', conversations.items?.length === 1, JSON.stringify(conversations.items));
  check('New conversation is unread', conversation?.unread === true);
  check('Preview shows the customer message', conversation?.lastMessagePreview === 'Cho mình hỏi giá combo 3 với ạ');

  const messages = await (await fetch(`${baseUrl}/api/messaging/conversations/${encodeURIComponent(conversation.id)}/messages`)).json();
  check('Meta retries do not duplicate a message', messages.items?.length === 1, JSON.stringify(messages.items));
  check('Customer message is stored as incoming', messages.items?.[0]?.direction === 'incoming');

  const flags = await (await fetch(`${baseUrl}/api/messaging/conversations/${encodeURIComponent(conversation.id)}/flags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ muted: true, labels: ['consulting'] })
  })).json();
  check('Conversation flags can be updated', flags.muted === true && flags.labels?.[0] === 'consulting', JSON.stringify(flags));

  const channels = await (await fetch(`${baseUrl}/api/channels`)).json();
  check('Webhook reports as configured', channels.webhookConfigured === true, JSON.stringify(channels.missingWebhookConfiguration));
  check('Callback URL follows PUBLIC_BASE_URL', channels.webhookUrl === 'https://crm.example.com/webhooks/facebook', channels.webhookUrl);
} finally {
  server.kill();
  await rm(temporaryDirectory, { recursive: true, force: true });
}

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok || !item.detail ? '' : ` -> ${item.detail}`}`);
const failed = checks.filter(item => !item.ok).length;
console.log(failed ? `\n${failed} of ${checks.length} webhook checks failed.` : `\nPASS: ${checks.length} webhook integration checks`);
process.exit(failed ? 1 : 0);
