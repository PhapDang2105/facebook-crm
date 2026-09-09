import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.dirname(appDirectory);

export function parseEnvironmentFile(content) {
  const values = {};
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).replace(/^export\s+/, '').trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const quoted = rawValue.length > 1
      && ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'")));
    values[key] = quoted ? rawValue.slice(1, -1) : rawValue;
  }
  return values;
}

export function applyEnvironmentFile(filePath = path.join(projectRoot, '.env')) {
  let content = '';
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const values = parseEnvironmentFile(content);
  // Real environment variables win so a deployment can override the local file.
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return values;
}

applyEnvironmentFile();

function readPort() {
  const fromArgument = Number(process.argv[2]);
  if (Number.isInteger(fromArgument) && fromArgument > 0) return fromArgument;
  const fromEnvironment = Number(process.env.PORT);
  return Number.isInteger(fromEnvironment) && fromEnvironment > 0 ? fromEnvironment : 8080;
}

export const serverConfig = {
  port: readPort(),
  host: process.env.HOST || '127.0.0.1'
};

const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${serverConfig.port}`).replace(/\/+$/, '');
const webhookPath = process.env.META_WEBHOOK_PATH || '/webhooks/facebook';

export const metaConfig = {
  appId: process.env.META_APP_ID || '',
  appSecret: process.env.META_APP_SECRET || '',
  graphVersion: process.env.META_GRAPH_VERSION || '',
  verifyToken: process.env.META_VERIFY_TOKEN || '',
  publicBaseUrl,
  webhookPath,
  webhookUrl: `${publicBaseUrl}${webhookPath}`,
  redirectUri: process.env.META_REDIRECT_URI || `${publicBaseUrl}/api/channels/meta/callback`,
  // message_echoes also captures replies staff send from Facebook's own Page inbox.
  subscribedFields: 'messages,message_echoes,messaging_postbacks,messaging_optins,messaging_reactions,message_deliveries,message_reads'
};

export function missingMetaConfiguration() {
  return [
    !metaConfig.appId && 'META_APP_ID',
    !metaConfig.appSecret && 'META_APP_SECRET',
    !metaConfig.graphVersion && 'META_GRAPH_VERSION'
  ].filter(Boolean);
}

export function isMetaConfigured() {
  return missingMetaConfiguration().length === 0 && Boolean(metaConfig.redirectUri);
}

export function missingWebhookConfiguration() {
  return [
    ...missingMetaConfiguration(),
    !metaConfig.verifyToken && 'META_VERIFY_TOKEN',
    !metaConfig.publicBaseUrl.startsWith('https://') && 'PUBLIC_BASE_URL'
  ].filter(Boolean);
}

export function isWebhookConfigured() {
  return missingWebhookConfiguration().length === 0;
}
