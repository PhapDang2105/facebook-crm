import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createLead, getSegments, updateLead } from './domain.mjs';
import { buildExportRows } from './order-export.mjs';
import { parseXlsx } from './xlsx-import.mjs';
import { getSpxTracking } from './spx-tracking.mjs';
import { buildCustomerOrderConfirmation, buildOrderReceiptPayload, normalizeChatbotOrder, normalizeCustomerOrder } from './conversation-orders.mjs';
import { defaultChatbotSettings, normalizeChatbotSettings, publicChatbotSettings } from './chatbot-settings.mjs';
import { processChatbotChanges, requestDirectModelReply } from './chatbot-engine.mjs';
import { chatbotTemplates } from './chatbot-templates.mjs';
import { assertUniqueSku, normalizeProduct, normalizeProductStore, productSchemaVersion } from './products.mjs';
import { getGifts, normalizeGiftStore, reloadCatalog } from './processing/catalog.mjs';
import { composeSystemPrompt } from './chatbot-engine.mjs';
import { listPipelineSteps, readPipelineStep } from './processing/pipeline.mjs';
import {
  isMetaConfigured,
  isWebhookConfigured,
  metaConfig,
  missingMetaConfiguration,
  missingWebhookConfiguration,
  projectRoot,
  serverConfig
} from './config.mjs';
import { decryptToken, encryptToken, getPageAccessToken, publicChannel, readChannelStore, writeChannelStore } from './channel-store.mjs';
import { fetchPageSubscription, metaRequest, sendSenderAction, subscribePageToApp, unsubscribePageFromApp } from './meta-graph.mjs';
import { processWebhookPayload, verifyWebhookSignature, verifyWebhookSubscription } from './meta-webhook.mjs';
import { sendConversationMessage, syncPageConversations } from './meta-sync.mjs';
import { publishMessagingEvent, subscribeToMessagingEvents } from './message-events.mjs';
import {
  getConversation,
  listConversations,
  listMessages,
  publicConversation,
  readMessagingStore,
  setConversationFlags,
  updateMessagingStore
} from './messaging-store.mjs';

const root = projectRoot;
const webRoot = path.join(root, 'web');
const storePath = path.join(root, 'data', 'processed', 'crm-store.json');
const chatbotSettingsPath = path.join(root, 'data', 'processed', 'chatbot-settings.json');
const productsPath = path.join(root, 'data', 'processed', 'products.json');
const giftsPath = path.join(root, 'data', 'processed', 'gifts.json');
const productImagesPath = path.join(root, 'data', 'processed', 'product-images');
const seedPath = path.join(root, 'database', 'seeds', 'demo-store.json');
const exportTemplatePath = path.join(root, 'assets', 'templates', 'facebook-order-export.xlsx');
const metaOauthStates = new Map();
const metaPendingPages = new Map();

async function initializeStore() {
  await mkdir(path.dirname(storePath), { recursive: true });
  try { await stat(storePath); } catch { await copyFile(seedPath, storePath); }
  try { await stat(chatbotSettingsPath); } catch { await writeChatbotSettings(defaultChatbotSettings); }
  await ensureProductCatalogue();
  await ensureGifts();
}

async function readStore() {
  return JSON.parse(await readFile(storePath, 'utf8'));
}

async function writeStore(store) {
  const temporaryPath = `${storePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  await rename(temporaryPath, storePath);
}

async function readProductStore() {
  try {
    return normalizeProductStore(JSON.parse(await readFile(productsPath, 'utf8')));
  } catch {
    return { items: [], updatedAt: 0 };
  }
}

async function writeProductStore(store) {
  const normalized = normalizeProductStore(store);
  normalized.updatedAt = Date.now();
  const temporaryPath = `${productsPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(normalized, null, 2), 'utf8');
  await rename(temporaryPath, productsPath);
  // Pricing, detection and the prompt all read this catalogue through a cache.
  reloadCatalog();
  return normalized;
}

/**
 * Lays down the eight real products the first time only. Their SKU is the
 * pricing code the chatbot resolves, which is what ties an edit here to the
 * price on both hand-made and bot-made orders.
 */
async function readSeedItems(fileName) {
  try {
    const raw = JSON.parse(await readFile(path.join(root, 'app', fileName), 'utf8'));
    return Array.isArray(raw?.items) ? raw.items : [];
  } catch {
    return [];
  }
}

/**
 * Lays down the starter catalogue the first time only, and upgrades records
 * written under an older shape. Two upgrades exist: legacy pricing codes
 * (XANH, COMBO10_MIX…) become the warehouse SKU the export needs, and the old
 * per-tier combo table becomes the single combo price. Both match on the seed
 * id or the legacy code, and neither touches a price staff already changed.
 */
const legacySkuByCode = {
  XANH: 'GRA-XANH-Z450', VANG: 'GRA-VANG-H350', NAU: 'GRA-NAU-Z350', CACAO300: 'GRA-TROPICAL-300',
  COMBO10_XANH: 'CB10-XANH', COMBO10_NAU: 'CB10-NAU', COMBO10_CAM: 'CB10-CAM', COMBO10_MIX: 'CB10-MIX'
};

function upgradeProductRecord(item, seed, now) {
  const template = seed.find(entry => entry.id === item.id)
    || seed.find(entry => entry.sku === item.sku)
    || seed.find(entry => entry.sku === legacySkuByCode[item.sku]);
  const next = { ...item };
  if (legacySkuByCode[item.sku]) next.sku = legacySkuByCode[item.sku];
  if (next.comboPrice === undefined) {
    // The old shape stored totals per tier; the per-unit combo price is tier 2 halved.
    const tier2 = Number(item.comboPrices?.['2']) || 0;
    next.comboPrice = tier2 ? Math.round(tier2 / 2) : (template?.comboPrice || 0);
  }
  if (next.weight === undefined) next.weight = template?.weight || 0;
  if (!Array.isArray(next.aliases) || !next.aliases.length) next.aliases = template?.aliases || [];
  if (!Array.isArray(next.components)) next.components = template?.components || [];
  if (next.active === undefined) next.active = true;
  delete next.comboPrices;
  delete next.mixGroup;
  next.updatedAt = now;
  return next;
}

async function ensureProductCatalogue() {
  const existing = await readProductStore().catch(() => null);
  const seed = await readSeedItems('products.seed.json');
  const now = Date.now();
  if (existing?.items?.length) {
    if (existing.schema >= productSchemaVersion && existing.seeded) return existing;
    const items = existing.items.map(item => upgradeProductRecord(item, seed, now));
    return writeProductStore({ ...existing, items, seeded: true, schema: productSchemaVersion });
  }
  if (existing?.seeded) return existing;
  return writeProductStore({
    items: seed.map(item => ({ ...item, createdAt: now, updatedAt: now })),
    seeded: true,
    schema: productSchemaVersion
  });
}

async function readGiftStore() {
  try {
    return normalizeGiftStore(JSON.parse(await readFile(giftsPath, 'utf8')));
  } catch {
    return { items: [], updatedAt: 0 };
  }
}

async function writeGiftStore(store) {
  const normalized = normalizeGiftStore(store);
  normalized.updatedAt = Date.now();
  const temporaryPath = `${giftsPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(normalized, null, 2), 'utf8');
  await rename(temporaryPath, giftsPath);
  reloadCatalog();
  return normalized;
}

/**
 * Lays down the starter gifts the first time only. A gift list written before
 * gifts carried a warehouse SKU gets the SKU and weight from the seed, matched
 * by id, so the export can ship them; names and thresholds staff set stay.
 */
async function ensureGifts() {
  const seed = await readSeedItems('gifts.seed.json');
  let existing;
  try {
    existing = normalizeGiftStore(JSON.parse(await readFile(giftsPath, 'utf8')));
  } catch {
    return writeGiftStore({ items: seed });
  }
  if (existing.items.some(gift => gift.sku)) return existing;
  const items = existing.items.map(gift => {
    const template = seed.find(entry => entry.id === gift.id);
    return template ? { ...gift, sku: template.sku, weight: template.weight } : gift;
  });
  const missing = seed.filter(entry => entry.sku && !items.some(gift => gift.id === entry.id));
  return writeGiftStore({ items: [...items, ...missing] });
}

async function saveProductImage(dataUrl, productId) {
  if (!dataUrl) return '';
  const match = String(dataUrl).match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('Ảnh sản phẩm phải là tệp PNG, JPG hoặc WebP.');
  const image = Buffer.from(match[2], 'base64');
  if (!image.length || image.length > 5 * 1024 * 1024) throw new Error('Ảnh sản phẩm phải nhỏ hơn 5 MB.');
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[match[1]];
  const filename = `${productId}-${Date.now()}.${extension}`;
  await mkdir(productImagesPath, { recursive: true });
  await writeFile(path.join(productImagesPath, filename), image);
  return `/product-images/${filename}`;
}

function cleanExpiredMetaSessions() {
  const now = Date.now();
  for (const [key, expiresAt] of metaOauthStates) if (expiresAt < now) metaOauthStates.delete(key);
  for (const [key, pending] of metaPendingPages) if (pending.expiresAt < now) metaPendingPages.delete(key);
}

function redirect(response, location) {
  response.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  response.end();
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  response.end(JSON.stringify(value));
}

function publicCustomerPanel(conversation) {
  return {
    notes: Array.isArray(conversation?.customerNotes) ? conversation.customerNotes : [],
    orders: Array.isArray(conversation?.customerOrders) ? conversation.customerOrders : [],
    botEnabled: conversation?.botEnabled === true,
    // Surfaced so a chatbot order that failed to save is visible to staff instead
    // of sitting silently in the store while the customer believes it went through.
    botLastError: String(conversation?.botLastError || ''),
    botLastErrorAt: Number(conversation?.botLastErrorAt) || 0
  };
}

// A customer who confirms twice in slightly different words produces two model
// replies with different message ids, so the source-message guard alone still let
// the warehouse pack the same basket twice.
const duplicateChatbotOrderWindowMs = 10 * 60 * 1000;

async function createChatbotCustomerOrder(conversation, input, context = {}) {
  const sourceMessageId = String(context.sourceMessageId || '').trim();
  const order = normalizeChatbotOrder(input, conversation, context);
  const result = await updateMessagingStore(store => {
    const item = store.conversations.find(entry => entry.id === conversation.id);
    if (!item) return null;
    if (!Array.isArray(item.customerOrders)) item.customerOrders = [];
    const existing = (sourceMessageId
      ? item.customerOrders.find(entry => entry.chatbotSourceMessageId === sourceMessageId)
      : null)
      || item.customerOrders.find(entry => entry.automatic
        && entry.phone === order.phone
        && Number(entry.total) === Number(order.total)
        && order.createdAt - (Number(entry.createdAt) || 0) < duplicateChatbotOrderWindowMs);
    if (existing) return { order: existing, created: false };
    item.customerOrders.unshift(order);
    item.customerOrders = item.customerOrders.slice(0, 200);
    return { order, created: true };
  });
  if (!result) throw new Error('Không tìm thấy hội thoại để tự tạo đơn.');
  if (result.created) publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id });
  return result;
}

/** Sends the tappable Messenger receipt. Kept separate from creating the order so
 *  the chatbot can persist the order first and still close with the receipt. */
async function sendChatbotOrderReceipt(conversation, order) {
  try {
    const confirmationText = buildCustomerOrderConfirmation(order);
    await sendConversationMessage(conversation, {
      text: confirmationText,
      templateText: confirmationText,
      template: buildOrderReceiptPayload(order, { baseUrl: metaConfig.publicBaseUrl })
    });
  } catch (error) {
    console.error(`Không gửi được hoá đơn cho đơn ${order.id}: ${error.message}`);
  }
}

async function readChatbotSettings() {
  try {
    const stored = JSON.parse(await readFile(chatbotSettingsPath, 'utf8'));
    const directApiKey = stored.directApiKeyEncrypted ? decryptToken(stored.directApiKeyEncrypted) : stored.directApiKey;
    return normalizeChatbotSettings({ ...stored, directApiKey });
  } catch {
    return normalizeChatbotSettings(defaultChatbotSettings);
  }
}

async function writeChatbotSettings(settings) {
  const normalized = normalizeChatbotSettings(settings);
  const { directApiKey, ...safeSettings } = normalized;
  const stored = {
    ...safeSettings,
    ...(directApiKey ? { directApiKeyEncrypted: encryptToken(directApiKey) } : {})
  };
  const temporaryPath = `${chatbotSettingsPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(stored, null, 2), 'utf8');
  await rename(temporaryPath, chatbotSettingsPath);
  return normalized;
}

function sendBinary(response, statusCode, body, contentType, filename) {
  response.writeHead(statusCode, { 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control':'no-store' });
  response.end(body);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function excelColumnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function excelColumnIndex(name) {
  return [...name].reduce((value, character) => (value * 26) + character.charCodeAt(0) - 64, 0) - 1;
}

function findDataCellStyle(xml, column) {
  const cellPattern = new RegExp(`<c\\b([^>]*\\br="${column}(\\d+)"[^>]*)`, 'g');
  for (const match of xml.matchAll(cellPattern)) {
    if (Number(match[2]) < 4) continue;
    const style = match[1].match(/\bs="(\d+)"/);
    if (style) return style[1];
  }
  return null;
}

function writeTemplateCell(xml, address, value) {
  if (value === '' || value === null || value === undefined) return xml;
  const cellPattern = new RegExp(`<c([^>]*\\br="${address}"[^>]*)(?:\\/>|>[\\s\\S]*?<\\/c>)`);
  const match = xml.match(cellPattern);
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  const createCell = attributes => isNumber
    ? `<c${attributes}><v>${value}</v></c>`
    : `<c${attributes} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;

  if (match) {
    const attributes = match[1].replace(/\s+t="[^"]*"/g, '');
    return xml.replace(cellPattern, createCell(attributes));
  }

  const addressParts = address.match(/^([A-Z]+)(\d+)$/);
  if (!addressParts) throw new Error(`Invalid Excel cell address: ${address}`);
  const [, column, rowText] = addressParts;
  const rowNumber = Number(rowText);
  const style = findDataCellStyle(xml, column);
  const newCell = createCell(` r="${address}"${style ? ` s="${style}"` : ''}`);
  const rowPattern = new RegExp(`<row([^>]*\\br="${rowNumber}"[^>]*)>([\\s\\S]*?)<\\/row>`);
  const rowMatch = xml.match(rowPattern);

  if (rowMatch) {
    const targetColumn = excelColumnIndex(column);
    let insertAt = rowMatch[2].length;
    const cells = /<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g;
    for (const cell of rowMatch[2].matchAll(cells)) {
      if (excelColumnIndex(cell[1]) > targetColumn) { insertAt = cell.index; break; }
    }
    const rowContent = `${rowMatch[2].slice(0, insertAt)}${newCell}${rowMatch[2].slice(insertAt)}`;
    return xml.replace(rowPattern, `<row${rowMatch[1]}>${rowContent}</row>`);
  }

  const newRow = `<row r="${rowNumber}">${newCell}</row>`;
  const sheetDataEnd = xml.indexOf('</sheetData>');
  if (sheetDataEnd < 0) throw new Error('Excel template sheet data was not found.');
  let updatedXml = `${xml.slice(0, sheetDataEnd)}${newRow}${xml.slice(sheetDataEnd)}`;
  updatedXml = updatedXml.replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"\/>/, (tag, start, endColumn, endRow) =>
    Number(endRow) < rowNumber ? `<dimension ref="${start}:${endColumn}${rowNumber}"/>` : tag);
  return updatedXml;
}

function removeDataRowBackgrounds(workbook, worksheetPath) {
  const stylesPath = 'xl/styles.xml';
  const stylesEntry = workbook.getEntry(stylesPath);
  const worksheetEntry = workbook.getEntry(worksheetPath);
  if (!stylesEntry || !worksheetEntry) throw new Error('Excel template styles were not found.');

  let stylesXml = stylesEntry.getData().toString('utf8');
  let worksheetXml = worksheetEntry.getData().toString('utf8');
  const cellXfsMatch = stylesXml.match(/<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/);
  if (!cellXfsMatch) throw new Error('Excel template cell styles were not found.');

  const cellXfsBlock = cellXfsMatch[0];
  const openingTag = cellXfsBlock.match(/^<cellXfs\b[^>]*>/)[0];
  const originalStyles = [...cellXfsBlock.matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map(match => match[0]);
  const usedStyleIds = new Set();
  for (const match of worksheetXml.matchAll(/<c\b([^>]*)>/g)) {
    const address = match[1].match(/\br="([A-Z]+)(\d+)"/);
    const style = match[1].match(/\bs="(\d+)"/);
    if (address && Number(address[2]) >= 4 && style) usedStyleIds.add(Number(style[1]));
  }

  const styleMap = new Map();
  const addedStyles = [];
  for (const styleId of usedStyleIds) {
    const style = originalStyles[styleId];
    if (!style || !/\bfillId="(?!0")\d+"/.test(style)) continue;
    const noFillStyle = style
      .replace(/\bfillId="\d+"/, 'fillId="0"')
      .replace(/\s+applyFill="1"/, '');
    styleMap.set(styleId, originalStyles.length + addedStyles.length);
    addedStyles.push(noFillStyle);
  }

  if (!styleMap.size) return { stylesXml, worksheetXml };
  const allStyles = [...originalStyles, ...addedStyles];
  const updatedOpeningTag = openingTag.replace(/count="\d+"/, `count="${allStyles.length}"`);
  const updatedCellXfs = `${updatedOpeningTag}${allStyles.join('')}</cellXfs>`;
  stylesXml = stylesXml.replace(cellXfsBlock, updatedCellXfs);
  worksheetXml = worksheetXml.replace(/<c\b([^>]*)>/g, (cellTag, attributes) => {
    const address = attributes.match(/\br="([A-Z]+)(\d+)"/);
    const style = attributes.match(/\bs="(\d+)"/);
    if (!address || Number(address[2]) < 4 || !style) return cellTag;
    const mappedStyle = styleMap.get(Number(style[1]));
    return mappedStyle === undefined ? cellTag : cellTag.replace(/\bs="\d+"/, ` s="${mappedStyle}"`);
  });
  return { stylesXml, worksheetXml };
}

async function readBody(request, maximumBytes = 32 * 1024 * 1024) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maximumBytes) throw new Error('Nội dung gửi lên vượt quá giới hạn cho phép.');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/** Meta signs the exact bytes it sent, so the webhook body must stay unparsed. */
async function readRawBody(request, maximumBytes = 1024 * 1024) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maximumBytes) throw new Error('Webhook payload vượt quá giới hạn cho phép.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBinaryBody(request, maximumBytes = 25 * 1024 * 1024) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maximumBytes) throw new Error('Tệp XLSX vượt quá giới hạn 25 MB.');
    chunks.push(chunk);
  }
  if (!chunks.length) throw new Error('Tệp XLSX không có dữ liệu.');
  return Buffer.concat(chunks);
}

async function serveFile(request, response, pathname) {
  if (pathname === '/assets/giot-nang-logo.webp') {
    try {
      const body = await readFile(path.join(root, 'assets', 'branding', 'logos', 'giot-nang-logo.webp'));
      response.writeHead(200, { 'Content-Type':'image/webp', 'Cache-Control':'public, max-age=3600' });
      return response.end(body);
    } catch { return sendJson(response, 404, { error:'Resource not found.' }); }
  }
  if (pathname.startsWith('/product-images/')) {
    const filename = pathname.slice('/product-images/'.length);
    if (!/^[A-Za-z0-9-]+\.(?:png|jpg|webp)$/.test(filename)) return sendJson(response, 400, { error:'Invalid product image path.' });
    const imagePath = path.join(productImagesPath, filename);
    const types = { '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp' };
    try {
      const body = await readFile(imagePath);
      response.writeHead(200, { 'Content-Type':types[path.extname(filename)], 'Cache-Control':'public, max-age=86400' });
      return response.end(body);
    } catch { return sendJson(response, 404, { error:'Resource not found.' }); }
  }
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(webRoot, relative);
  if (!filePath.startsWith(path.resolve(webRoot))) return sendJson(response, 400, { error:'Invalid path.' });
  const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.webp':'image/webp' };
  try {
    const stats = await stat(filePath);
    const etag = `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
    const headers = { 'Content-Type':types[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control':'no-cache', 'ETag':etag };
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, headers);
      return response.end();
    }
    const body = await readFile(filePath);
    response.writeHead(200, headers);
    response.end(body);
  } catch { sendJson(response, 404, { error:'Resource not found.' }); }
}

await initializeStore();
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { status:'ok', time:new Date().toISOString() });
    if (request.method === 'GET' && url.pathname === '/api/products') {
      const store = await readProductStore();
      const query = String(url.searchParams.get('q') || '').trim().toLocaleLowerCase('vi');
      const items = query
        ? store.items.filter(product => `${product.name} ${product.sku}`.toLocaleLowerCase('vi').includes(query))
        : store.items;
      return sendJson(response, 200, { items, total: items.length, updatedAt: store.updatedAt });
    }
    if (request.method === 'POST' && url.pathname === '/api/products') {
      const payload = await readBody(request, 8 * 1024 * 1024);
      const store = await readProductStore();
      const id = randomUUID();
      const product = normalizeProduct(payload, { id, createdAt: Date.now(), image: '' });
      assertUniqueSku(store.items, product.sku);
      if (payload.imageData) product.image = await saveProductImage(payload.imageData, id);
      store.items.unshift(product);
      await writeProductStore(store);
      return sendJson(response, 201, product);
    }
    const productMatch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
    if (productMatch && ['PUT', 'DELETE'].includes(request.method)) {
      const store = await readProductStore();
      const index = store.items.findIndex(product => product.id === productMatch[1]);
      if (index < 0) return sendJson(response, 404, { error: 'Không tìm thấy sản phẩm.' });
      if (request.method === 'DELETE') {
        const [removed] = store.items.splice(index, 1);
        await writeProductStore(store);
        return sendJson(response, 200, removed);
      }
      const payload = await readBody(request, 8 * 1024 * 1024);
      const product = normalizeProduct(payload, store.items[index]);
      assertUniqueSku(store.items, product.sku, product.id);
      if (payload.removeImage === true) product.image = '';
      if (payload.imageData) product.image = await saveProductImage(payload.imageData, product.id);
      store.items[index] = product;
      await writeProductStore(store);
      return sendJson(response, 200, product);
    }
    if (request.method === 'GET' && url.pathname === '/api/chatbot/settings') {
      const settings = await readChatbotSettings();
      const templates = { ...chatbotTemplates, ...settings.messageTemplates };
      for (const id of settings.deletedTemplateIds) delete templates[id];
      return sendJson(response, 200, {
        ...publicChatbotSettings(settings),
        templates
      });
    }
    if (request.method === 'PUT' && url.pathname === '/api/chatbot/settings') {
      const current = await readChatbotSettings();
      const payload = await readBody(request);
      const directEndpoint = String(payload.directEndpoint || current.directEndpoint || '');
      if (!directEndpoint.startsWith('https://')) return sendJson(response, 400, { error: 'Endpoint AI phải bắt đầu bằng https://.' });
      const providerChanged = payload.provider && payload.provider !== current.provider;
      const settings = await writeChatbotSettings({
        ...current,
        ...payload,
        directApiKey: String(payload.directApiKey || '').trim() || (providerChanged ? '' : current.directApiKey),
        updatedAt: Date.now()
      });
      const templates = { ...chatbotTemplates, ...settings.messageTemplates };
      for (const id of settings.deletedTemplateIds) delete templates[id];
      return sendJson(response, 200, {
        ...publicChatbotSettings(settings),
        templates
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/chatbot/test') {
      const current = await readChatbotSettings();
      const payload = await readBody(request, 256 * 1024);
      const text = String(payload.message || '').trim();
      if (!text) return sendJson(response, 400, { error: 'Vui lòng nhập tin nhắn thử.' });
      const recentMessages = Array.isArray(payload.recentMessages)
        ? payload.recentMessages.slice(-100).map(item => ({
          id: String(item?.id || '').slice(0, 120),
          direction: item?.direction === 'outgoing' ? 'outgoing' : 'incoming',
          type: 'text',
          text: String(item?.text || '').slice(0, 12000)
        })).filter(item => item.text.trim())
        : [];
      const settings = normalizeChatbotSettings({ ...current, ...payload, enabled: true, directApiKey: '' });
      const reply = await requestDirectModelReply({
        settings,
        conversation: { id: 'preview', name: 'Khách xem trước', botEnabled: true },
        message: { type: 'text', text },
        recentMessages,
        rawResponse: true
      });
      return sendJson(response, 200, { raw: reply.raw, parsed: reply.parsed });
    }
    if (request.method === 'GET' && url.pathname === '/api/channels') {
      const store = await readChannelStore();
      return sendJson(response, 200, {
        metaConfigured: isMetaConfigured(),
        missingConfiguration: missingMetaConfiguration(),
        webhookConfigured: isWebhookConfigured(),
        missingWebhookConfiguration: missingWebhookConfiguration(),
        webhookUrl: metaConfig.webhookUrl,
        items: store.items.map(publicChannel)
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/channels/meta/connect') {
      if (!isMetaConfigured()) return sendJson(response, 503, {
        error: 'Chưa cấu hình Meta App để kết nối Facebook Page.',
        missingConfiguration: missingMetaConfiguration()
      });
      cleanExpiredMetaSessions();
      const state = randomUUID();
      metaOauthStates.set(state, Date.now() + 10 * 60 * 1000);
      const authorizationUrl = new URL(`https://www.facebook.com/${metaConfig.graphVersion}/dialog/oauth`);
      authorizationUrl.searchParams.set('client_id', metaConfig.appId);
      authorizationUrl.searchParams.set('redirect_uri', metaConfig.redirectUri);
      authorizationUrl.searchParams.set('state', state);
      authorizationUrl.searchParams.set('response_type', 'code');
      authorizationUrl.searchParams.set('scope', 'pages_show_list,pages_read_engagement,pages_manage_metadata,pages_messaging');
      return sendJson(response, 200, { authorizationUrl: authorizationUrl.toString() });
    }
    if (request.method === 'GET' && url.pathname === '/api/channels/meta/callback') {
      cleanExpiredMetaSessions();
      const state = url.searchParams.get('state') || '';
      const code = url.searchParams.get('code') || '';
      const metaError = url.searchParams.get('error_description') || '';
      if (metaError) return redirect(response, `/?meta_error=${encodeURIComponent(metaError)}#settings`);
      if (!code || !state || !metaOauthStates.has(state)) return redirect(response, '/?meta_error=Phi%C3%AAn%20k%E1%BA%BFt%20n%E1%BB%91i%20Facebook%20kh%C3%B4ng%20h%E1%BB%A3p%20l%E1%BB%87%20ho%E1%BA%B7c%20%C4%91%C3%A3%20h%E1%BA%BFt%20h%E1%BA%A1n.#settings');
      metaOauthStates.delete(state);
      try {
        const tokenResult = await metaRequest('oauth/access_token', { query: {
          client_id: metaConfig.appId,
          client_secret: metaConfig.appSecret,
          redirect_uri: metaConfig.redirectUri,
          code
        } });
        const pagesResult = await metaRequest('me/accounts', { query: {
          fields: 'id,name,picture{url},access_token,tasks',
          limit: '100',
          access_token: tokenResult.access_token
        } });
        const pages = (pagesResult.data || []).filter(page => page.id && page.access_token).map(page => ({
          id: String(page.id),
          name: page.name || `Facebook Page ${page.id}`,
          picture: page.picture?.data?.url || '',
          accessToken: page.access_token,
          tasks: Array.isArray(page.tasks) ? page.tasks : []
        }));
        if (!pages.length) return redirect(response, '/?meta_error=T%C3%A0i%20kho%E1%BA%A3n%20Facebook%20n%C3%A0y%20kh%C3%B4ng%20c%C3%B3%20Page%20%C4%91%E1%BB%A7%20quy%E1%BB%81n%20qu%E1%BA%A3n%20l%C3%BD.#settings');
        const ticket = randomUUID();
        metaPendingPages.set(ticket, { pages, expiresAt: Date.now() + 10 * 60 * 1000 });
        return redirect(response, `/?meta_ticket=${encodeURIComponent(ticket)}#settings`);
      } catch (error) {
        return redirect(response, `/?meta_error=${encodeURIComponent(error.message)}#settings`);
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/channels/meta/pending') {
      cleanExpiredMetaSessions();
      const pending = metaPendingPages.get(url.searchParams.get('ticket') || '');
      if (!pending) return sendJson(response, 404, { error: 'Phiên chọn Facebook Page đã hết hạn. Vui lòng kết nối lại.' });
      const store = await readChannelStore();
      return sendJson(response, 200, {
        connectedIds: store.items.map(item => item.id),
        pages: pending.pages.map(page => ({ id: page.id, name: page.name, picture: page.picture, tasks: page.tasks }))
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/channels/meta/confirm') {
      cleanExpiredMetaSessions();
      const payload = await readBody(request);
      const pending = metaPendingPages.get(payload.ticket || '');
      if (!pending) return sendJson(response, 404, { error: 'Phiên chọn Facebook Page đã hết hạn. Vui lòng kết nối lại.' });
      const selectedIds = [...new Set(Array.isArray(payload.pageIds) ? payload.pageIds.map(String) : [])];
      if (!selectedIds.length) return sendJson(response, 400, { error: 'Hãy chọn ít nhất 1 Facebook Page.' });
      const selectedPages = selectedIds.map(id => pending.pages.find(page => page.id === id));
      if (selectedPages.some(page => !page)) return sendJson(response, 400, { error: 'Danh sách Facebook Page được chọn không hợp lệ.' });
      const store = await readChannelStore();
      const retained = store.items.filter(item => !selectedIds.includes(item.id));
      const now = new Date().toISOString();
      const connected = [];
      for (const page of selectedPages) {
        let subscribed = false;
        let subscriptionError = '';
        try {
          await subscribePageToApp(page.id, page.accessToken);
          subscribed = true;
        } catch (error) {
          subscriptionError = error.message;
        }
        connected.push({
          id: page.id,
          name: page.name,
          picture: page.picture,
          status: 'connected',
          subscribed,
          subscriptionError,
          token: encryptToken(page.accessToken),
          connectedAt: store.items.find(item => item.id === page.id)?.connectedAt || now,
          checkedAt: now
        });
      }
      store.items = [...retained, ...connected];
      await writeChannelStore(store);
      metaPendingPages.delete(payload.ticket);
      // Import existing threads so the inbox is populated before the first webhook arrives.
      for (const page of connected) {
        try {
          await syncPageConversations(page.id);
          page.syncedAt = new Date().toISOString();
        } catch { /* The Page stays connected even when the first import fails. */ }
      }
      await writeChannelStore(store);
      return sendJson(response, 200, { items: store.items.map(publicChannel) });
    }
    const channelMatch = url.pathname.match(/^\/api\/channels\/facebook\/([^/]+)$/);
    if (request.method === 'DELETE' && channelMatch) {
      const store = await readChannelStore();
      const pageId = decodeURIComponent(channelMatch[1]);
      const channel = store.items.find(item => item.id === pageId);
      if (!channel) return sendJson(response, 404, { error: 'Không tìm thấy Facebook Page đã kết nối.' });
      try {
        await unsubscribePageFromApp(pageId, await getPageAccessToken(pageId));
      } catch { /* The local connection can still be removed if Meta is unavailable. */ }
      store.items = store.items.filter(item => item.id !== pageId);
      await writeChannelStore(store);
      return sendJson(response, 200, { items: store.items.map(publicChannel) });
    }
    const refreshChannelMatch = url.pathname.match(/^\/api\/channels\/facebook\/([^/]+)\/refresh$/);
    if (request.method === 'POST' && refreshChannelMatch) {
      const store = await readChannelStore();
      const pageId = decodeURIComponent(refreshChannelMatch[1]);
      const channel = store.items.find(item => item.id === pageId);
      if (!channel) return sendJson(response, 404, { error: 'Không tìm thấy Facebook Page đã kết nối.' });
      try {
        const pageAccessToken = await getPageAccessToken(pageId);
        const page = await metaRequest(pageId, { query: { fields: 'id,name,picture{url}', access_token: pageAccessToken } });
        channel.name = page.name || channel.name;
        channel.picture = page.picture?.data?.url || channel.picture;
        channel.status = 'connected';
        let subscription = await fetchPageSubscription(pageId, pageAccessToken);
        // Retry the subscription here so a failed connect can be repaired from
        // the UI instead of forcing the Page to be disconnected and re-added.
        if (!subscription.subscribed) {
          try {
            await subscribePageToApp(pageId, pageAccessToken);
            subscription = await fetchPageSubscription(pageId, pageAccessToken);
            channel.subscriptionError = '';
          } catch (subscribeError) {
            channel.subscriptionError = subscribeError.message;
          }
        } else {
          channel.subscriptionError = '';
        }
        channel.subscribed = subscription.subscribed;
      } catch (error) {
        channel.status = 'needs_attention';
        channel.subscriptionError = error.message;
      }
      channel.checkedAt = new Date().toISOString();
      await writeChannelStore(store);
      return sendJson(response, 200, publicChannel(channel));
    }
    if (request.method === 'GET' && url.pathname === metaConfig.webhookPath) {
      const challenge = verifyWebhookSubscription(url.searchParams, metaConfig.verifyToken);
      if (challenge === null) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return response.end('Forbidden');
      }
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return response.end(challenge);
    }
    if (request.method === 'POST' && url.pathname === metaConfig.webhookPath) {
      const rawBody = await readRawBody(request);
      if (!verifyWebhookSignature(rawBody, request.headers['x-hub-signature-256'], metaConfig.appSecret)) {
        response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return response.end('Invalid signature');
      }
      // Meta retries whenever the reply is slow, so acknowledge first and store afterwards.
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('EVENT_RECEIVED');
      try {
        const changes = await processWebhookPayload(JSON.parse(rawBody.toString('utf8')));
        await processChatbotChanges(changes, {
          readSettings: readChatbotSettings,
          listMessages,
          sendMessage: sendConversationMessage,
          createOrder: createChatbotCustomerOrder,
          sendReceipt: sendChatbotOrderReceipt,
          saveBotState: (id, botState) => updateMessagingStore(store => {
            const conversation = store.conversations.find(item => item.id === id);
            if (!conversation) return null;
            Object.assign(conversation, botState);
            return conversation;
          })
        });
      } catch (error) {
        console.error('Webhook processing failed:', error.message);
      }
      return undefined;
    }
    if (request.method === 'GET' && url.pathname === '/api/messaging/conversations') {
      const items = await listConversations(url.searchParams.get('channelId') || '');
      return sendJson(response, 200, { items });
    }
    if (request.method === 'POST' && url.pathname === '/api/messaging/sync') {
      const payload = await readBody(request);
      const pageId = String(payload.channelId || '');
      if (!pageId) return sendJson(response, 400, { error: 'Thiếu channelId của Facebook Page cần đồng bộ.' });
      const summary = await syncPageConversations(pageId, { limit: Number(payload.limit) || 25 });
      return sendJson(response, 200, { ...summary, items: await listConversations(pageId) });
    }
    if (request.method === 'GET' && url.pathname === '/api/messaging/stream') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive'
      });
      response.write(': connected\n\n');
      const unsubscribe = subscribeToMessagingEvents(event => response.write(`data: ${JSON.stringify(event)}\n\n`));
      const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 25000);
      request.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return undefined;
    }
    const conversationMessagesMatch = url.pathname.match(/^\/api\/messaging\/conversations\/([^/]+)\/messages$/);
    if (conversationMessagesMatch) {
      const id = decodeURIComponent(conversationMessagesMatch[1]);
      const conversation = await getConversation(id);
      if (!conversation) return sendJson(response, 404, { error: 'Không tìm thấy hội thoại này.' });
      if (request.method === 'GET') {
        return sendJson(response, 200, {
          conversation: publicConversation(conversation),
          items: await listMessages(id, Number(url.searchParams.get('limit')) || 100)
        });
      }
      if (request.method === 'POST') {
        const payload = await readBody(request);
        const text = String(payload.text || '').trim();
        const attachment = payload.attachment?.dataUrl ? payload.attachment : null;
        if (!text && !attachment) return sendJson(response, 400, { error: 'Nội dung tin nhắn không được để trống.' });
        try {
          const sent = await sendConversationMessage(conversation, { text, attachment });
          return sendJson(response, 200, sent);
        } catch (error) {
          return sendJson(response, error.statusCode === 400 ? 400 : 502, { error: error.message });
        }
      }
    }
    const conversationReadMatch = url.pathname.match(/^\/api\/messaging\/conversations\/([^/]+)\/read$/);
    if (request.method === 'POST' && conversationReadMatch) {
      const id = decodeURIComponent(conversationReadMatch[1]);
      const conversation = await updateMessagingStore(store => setConversationFlags(store, id, { unread: false }));
      if (!conversation) return sendJson(response, 404, { error: 'Không tìm thấy hội thoại này.' });
      try {
        await sendSenderAction({
          pageId: conversation.pageId,
          psid: conversation.psid,
          action: 'mark_seen',
          pageAccessToken: await getPageAccessToken(conversation.pageId)
        });
      } catch { /* Marking the thread seen on Facebook is best effort. */ }
      return sendJson(response, 200, publicConversation(conversation));
    }
    const conversationFlagsMatch = url.pathname.match(/^\/api\/messaging\/conversations\/([^/]+)\/flags$/);
    if (request.method === 'PATCH' && conversationFlagsMatch) {
      const id = decodeURIComponent(conversationFlagsMatch[1]);
      const payload = await readBody(request);
      const conversation = await updateMessagingStore(store => setConversationFlags(store, id, payload));
      if (!conversation) return sendJson(response, 404, { error: 'Không tìm thấy hội thoại này.' });
      return sendJson(response, 200, publicConversation(conversation));
    }
    if (url.pathname === '/api/gifts') {
      if (request.method === 'GET') return sendJson(response, 200, { items: getGifts() });
      if (request.method === 'PUT') {
        const payload = await readBody(request);
        const items = Array.isArray(payload.items) ? payload.items : [];
        if (items.length > 50) return sendJson(response, 400, { error: 'Tối đa 50 quà tặng.' });
        for (const item of items) {
          if (!String(item?.name || '').trim()) return sendJson(response, 400, { error: 'Mỗi quà tặng phải có tên.' });
          const quantity = Number(item?.minQuantity);
          if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return sendJson(response, 400, { error: `Quà “${item.name}”: số lượng áp dụng phải từ 1 đến 20.` });
        }
        const store = await writeGiftStore({ items });
        return sendJson(response, 200, { items: store.items, updatedAt: store.updatedAt });
      }
    }
    // What the model actually receives: the saved prompt plus the live catalogue block.
    if (url.pathname === '/api/chatbot/system-prompt' && request.method === 'GET') {
      const settings = await readChatbotSettings();
      return sendJson(response, 200, { prompt: composeSystemPrompt(settings.systemPrompt) });
    }
    if (url.pathname === '/api/chatbot/pipeline' && request.method === 'GET') {
      return sendJson(response, 200, { items: listPipelineSteps() });
    }
    const pipelineStepMatch = url.pathname.match(/^\/api\/chatbot\/pipeline\/([a-z_]+)$/);
    if (pipelineStepMatch && request.method === 'GET') {
      const step = await readPipelineStep(pipelineStepMatch[1]);
      if (!step) return sendJson(response, 404, { error: 'Không có bước xử lý này.' });
      return sendJson(response, 200, step);
    }
    const customerPanelMatch = url.pathname.match(/^\/api\/messaging\/conversations\/([^/]+)\/customer-panel$/);
    if (customerPanelMatch) {
      const id = decodeURIComponent(customerPanelMatch[1]);
      const conversation = await getConversation(id);
      if (!conversation) return sendJson(response, 404, { error: 'Không tìm thấy hội thoại này.' });
      if (request.method === 'GET') return sendJson(response, 200, publicCustomerPanel(conversation));
      if (request.method === 'POST') {
        const payload = await readBody(request);
        if (payload.type === 'order') {
          let order;
          try {
            order = normalizeCustomerOrder(payload.order);
          } catch (error) {
            return sendJson(response, 400, { error: error.message });
          }
          try {
            const confirmationText = buildCustomerOrderConfirmation(order);
            const sent = await sendConversationMessage(conversation, {
              text: confirmationText,
              templateText: confirmationText,
              template: buildOrderReceiptPayload(order, { baseUrl: metaConfig.publicBaseUrl })
            });
            order.delivery = {
              status: 'sent',
              messageId: String(sent?.message?.mid || sent?.message?.id || ''),
              sentAt: Date.now()
            };
          } catch (error) {
            return sendJson(response, 502, { error: `Chưa tạo đơn: ${error.message}` });
          }
          const panel = await updateMessagingStore(store => {
            const item = store.conversations.find(entry => entry.id === id);
            if (!item) return null;
            if (!Array.isArray(item.customerOrders)) item.customerOrders = [];
            item.customerOrders.unshift(order);
            item.customerOrders = item.customerOrders.slice(0, 200);
            return publicCustomerPanel(item);
          });
          if (!panel) return sendJson(response, 404, { error: 'Không tìm thấy hội thoại này.' });
          return sendJson(response, 201, panel);
        }
        const panel = await updateMessagingStore(store => {
          const item = store.conversations.find(entry => entry.id === id);
          if (!item) return null;
          if (payload.type === 'note') {
            const text = String(payload.text || '').trim().slice(0, 2000);
            if (!text) throw new Error('Nội dung ghi chú không được để trống.');
            if (!Array.isArray(item.customerNotes)) item.customerNotes = [];
            item.customerNotes.unshift({ id: randomUUID(), text, createdAt: Date.now() });
            item.customerNotes = item.customerNotes.slice(0, 100);
          } else if (payload.type === 'bot') {
            item.botEnabled = payload.enabled === true;
          } else {
            throw new Error('Loại cập nhật thông tin khách hàng không hợp lệ.');
          }
          return publicCustomerPanel(item);
        });
        if (!panel) return sendJson(response, 404, { error: 'Không tìm thấy hội thoại này.' });
        return sendJson(response, 200, panel);
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/customer-orders') {
      const messagingStore = await readMessagingStore();
      const items = messagingStore.conversations.flatMap(conversation =>
        (Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []).map(order => ({
          ...order,
          conversationId: conversation.id,
          conversationName: conversation.name || ''
        }))
      ).sort((first, second) => (Number(second.createdAt) || 0) - (Number(first.createdAt) || 0));
      return sendJson(response, 200, { items, total: items.length });
    }
    if (request.method === 'GET' && url.pathname === '/api/dashboard') {
      const { leads } = await readStore();
      return sendJson(response, 200, { total:leads.length, new:leads.filter(x=>x.status==='new').length, active:leads.filter(x=>['assigned','contacting','qualified','consulting','waiting'].includes(x.status)).length, won:leads.filter(x=>x.status==='won').length, revenue:leads.filter(x=>x.status==='won').reduce((sum,x)=>sum+Number(x.value||0),0), segments:getSegments(leads) });
    }
    if (request.method === 'GET' && url.pathname === '/api/leads') {
      let { leads } = await readStore(); const status=url.searchParams.get('status'); const query=(url.searchParams.get('q')||'').toLowerCase();
      if(status) leads=leads.filter(x=>x.status===status); if(query) leads=leads.filter(x=>[x.name,x.phone,x.campaign].some(v=>String(v||'').toLowerCase().includes(query)));
      return sendJson(response, 200, { items:leads, total:leads.length });
    }
    if (request.method === 'POST' && url.pathname === '/api/leads') { const store=await readStore(); const lead=createLead(await readBody(request)); store.leads.push(lead); await writeStore(store); return sendJson(response,201,lead); }
    const match=url.pathname.match(/^\/api\/leads\/([^/]+)$/);
    if(request.method==='PATCH'&&match){const store=await readStore();const lead=store.leads.find(x=>x.id===match[1]);if(!lead)return sendJson(response,404,{error:'Lead not found.'});updateLead(lead,await readBody(request));await writeStore(store);return sendJson(response,200,lead);}
    if(request.method==='GET'&&url.pathname==='/api/segments'){const {leads}=await readStore();return sendJson(response,200,{items:getSegments(leads)});}
    if (request.method === 'GET' && url.pathname === '/api/shipping/spx/track') {
      try {
        const tracking = await getSpxTracking(url.searchParams.get('trackingNumber'));
        return sendJson(response, 200, tracking);
      } catch (error) {
        return sendJson(response, error.statusCode || 502, { error: error.message });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/orders/import/xlsx') {
      const workbook = await readBinaryBody(request);
      return sendJson(response, 200, parseXlsx(workbook));
    }
    if (request.method === 'POST' && url.pathname === '/api/orders/export') {
      const payload = await readBody(request);
      if (!payload.orderData || !Array.isArray(payload.orderData.headers) || !Array.isArray(payload.orderData.rows)) {
        throw new Error('Dữ liệu đơn hàng xuất không hợp lệ. Vui lòng tải lại trang và thử lại.');
      }
      const rows = buildExportRows(payload.orderData);
      const template = await readFile(exportTemplatePath);
      const workbook = new AdmZip(template);
      const worksheetPath = 'xl/worksheets/sheet1.xml';
      const cleanedWorkbook = removeDataRowBackgrounds(workbook, worksheetPath);
      let worksheetXml = cleanedWorkbook.worksheetXml;
      rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
        worksheetXml = writeTemplateCell(worksheetXml, `${excelColumnName(columnIndex)}${rowIndex + 4}`, value);
      }));
      workbook.updateFile('xl/styles.xml', Buffer.from(cleanedWorkbook.stylesXml, 'utf8'));
      workbook.updateFile(worksheetPath, Buffer.from(worksheetXml, 'utf8'));
      const output = workbook.toBuffer();
      return sendBinary(response, 200, output, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `don-hang-${new Date().toISOString().slice(0, 10)}.xlsx`);
    }
    if(request.method==='GET') return serveFile(request,response,url.pathname);
    sendJson(response,404,{error:'Route not found.'});
  } catch(error) { sendJson(response,400,{error:error.message}); }
});

server.listen(serverConfig.port, serverConfig.host, () => {
  console.log(`CRM running at http://${serverConfig.host}:${serverConfig.port}/`);
  console.log(`Meta webhook callback URL: ${metaConfig.webhookUrl}`);
  const missing = missingWebhookConfiguration();
  if (missing.length) console.log(`Webhook chưa sẵn sàng, còn thiếu: ${missing.join(', ')}`);
});
