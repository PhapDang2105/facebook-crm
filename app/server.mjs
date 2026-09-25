import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { buildExportRows, exportPreviewStreets, exportedOrderData } from './order-export.mjs';
import { parseXlsx } from './xlsx-import.mjs';
import { buildPlainXlsx } from './xlsx-export.mjs';
import { getSpxTracking } from './spx-tracking.mjs';
import { buildOrderReceiptPayload, normalizeChatbotOrder, normalizeCustomerOrder } from './conversation-orders.mjs';
import { renderOrderReceiptImage } from './order-receipt-image.mjs';
import { assertUsableAiEndpoint, defaultChatbotSettings, normalizeChatbotSettings, publicChatbotSettings } from './chatbot-settings.mjs';
import { assertPublicHost } from './network-guard.mjs';
import { processChatbotChanges, requestDirectModelReply } from './chatbot-engine.mjs';
import { configureAddressAi } from './processing/address-ai.mjs';
import { applyHonorific, defaultMessageTemplates, honorific, publicImageUrl, spin } from './chatbot-templates.mjs';
import { assertUniqueSku, maximumGalleryImages, normalizeGallery, normalizeProduct, normalizeProductStore } from './products.mjs';
import { getCatalogProducts, getGifts, getShippingFee, normalizeGiftStore, reloadCatalog } from './processing/catalog.mjs';
import { priceBasket } from './processing/pricing.mjs';
import { listPipelineSteps, readPipelineStep } from './processing/pipeline.mjs';
import { deleteLandingOrder, isLandingTokenValid, landingTokenFrom, listLandingOrders, listRecentLandingPayloads, parseLandingBody, recordLandingOrder, updateLandingStore } from './landing-orders.mjs';
import { attachPhoneWarning, cachedPhoneWarning, connectPos, disconnectPos, fetchPosPhoneReport, lookupPhones, normalizeWarningPhone, posConfig, posConfigured, posRequest, posStatus } from './phone-warnings.mjs';
import { startPosSync, syncPosLandingOrders } from './pos-sync.mjs';
import { cancelPosOrder, isCrmPushedPosOrder, syncOrderToPos, updatePosOrder, updatePosOrderNote } from './pos-orders.mjs';
import { goldenLabeled, goldenSetOverview, importGoldenItems, labelGoldenItem } from './golden-set.mjs';
import { buildFollowUpBatch, followUpStatus, markFollowUpWins, pruneReturningFromQueue, recordFollowUpBatchResults, releaseFollowUpLeases, resetFollowUpActivation, resolveFollowUpQueueItem, runFollowUps, startFollowUpLoop } from './follow-up.mjs';
import { customerNote, processingNotes } from './order-notes.mjs';
import { applyCustomerOrderEdits } from './order-edits.mjs';
import { appendOrderToArchive, readOrderArchive } from './order-archive.mjs';
import { customerPhoneKey, listExportedCustomers, recordExportedOrders } from './customer-file.mjs';
import { listExports, readExportFile, recordExport } from './export-history.mjs';
import { fetchPancakeConversationInfo, handlePancakeWebhook, isPancakeConfigured, isPancakeWebhookTokenValid, startPancakeSync, syncPancakeConversations } from './pancake.mjs';
import { isValidQrCode, listQrScans, recordQrScan } from './qr-scans.mjs';
import {
  isMetaConfigured,
  isWebhookConfigured,
  landingConfig,
  metaConfig,
  missingMetaConfiguration,
  missingWebhookConfiguration,
  projectRoot,
  serverConfig, pancakeConfig } from './config.mjs';
import { decryptToken, encryptToken, getPageAccessToken, publicChannel, readChannelStore, writeChannelStore } from './channel-store.mjs';
import { fetchPageSubscription, metaRequest, sendSenderAction, subscribePageToApp, unsubscribePageFromApp } from './meta-graph.mjs';
import { processWebhookPayload, refreshCustomerProfiles, verifyWebhookSignature, verifyWebhookSubscription } from './meta-webhook.mjs';
import { customersToCsv, customersToAudienceCsv, findCustomerById, invalidateBuyersCache, listCustomers } from './customers.mjs';
import { addCustomerNote, listCustomerNotes, setCustomerLabels, updateCustomerProfile } from './customer-edits.mjs';
import { defaultConversationLabels, labelsForEvents, listLabelIcons, readInboxSettings, writeInboxSettings } from './inbox-settings.mjs';
import { moderateComment, sendConversationMessage, syncPageConversations } from './meta-sync.mjs';
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
const chatbotSettingsPath = path.join(root, 'data', 'processed', 'chatbot-settings.json');
const productsPath = path.join(root, 'data', 'processed', 'products.json');
const giftsPath = path.join(root, 'data', 'processed', 'gifts.json');
const productImagesPath = path.join(root, 'data', 'processed', 'product-images');
const exportTemplatePath = path.join(root, 'assets', 'templates', 'facebook-order-export.xlsx');
let exportTemplateBuffer = null;
const metaOauthStates = new Map();
const metaPendingPages = new Map();

async function initializeStore() {
  await mkdir(path.dirname(chatbotSettingsPath), { recursive: true });
  try { await stat(chatbotSettingsPath); } catch { await writeChatbotSettings(defaultChatbotSettings); }
  await ensureProductCatalogue();
  await ensureGifts();
}

async function readProductStore() {
  try {
    return normalizeProductStore(JSON.parse(await readFile(productsPath, 'utf8')));
  } catch {
    return { items: [], updatedAt: 0 };
  }
}

// Kho sản phẩm và kho quà là hai chỗ duy nhất còn đọc–sửa–ghi mà không xếp
// hàng: hai tab bấm gần nhau thì cả hai cùng đọc một bản, bên ghi sau xoá mất
// thay đổi của bên ghi trước. Mọi kho khác (messaging, landing, customer-file,
// customer-edits) đều đã đi qua một hàng đợi như thế này.
let productWriteQueue = Promise.resolve();

/** Đọc kho, sửa, ghi lại — trọn gói một lượt, không ai chen vào giữa. */
function updateProductStore(mutate) {
  const operation = productWriteQueue.then(async () => {
    const store = await readProductStore();
    const result = await mutate(store);
    // Mutator trả về `undefined` là "không đổi gì" (ví dụ không tìm thấy sản
    // phẩm): ghi lại cả kho khi chẳng có gì đổi chỉ tốn công và tạo cơ hội
    // hỏng tệp vô cớ.
    if (result !== undefined) await writeProductStore(store);
    return result;
  });
  productWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

let giftWriteQueue = Promise.resolve();

/** Như trên, cho kho quà: `mutate` nhận kho hiện tại và trả về kho mới. */
function updateGiftStore(mutate) {
  const operation = giftWriteQueue.then(async () => writeGiftStore(await mutate(await readGiftStore())));
  giftWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
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

/** Lays down the starter catalogue when no catalogue file exists yet. */
async function ensureProductCatalogue() {
  try {
    await stat(productsPath);
  } catch {
    const now = Date.now();
    const seed = await readSeedItems('products.seed.json');
    await writeProductStore({ items: seed.map(item => ({ ...item, createdAt: now, updatedAt: now })) });
  }
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

/** Lays down the starter gifts and shipping fee when no gift file exists yet. */
async function ensureGifts() {
  try {
    await stat(giftsPath);
  } catch {
    const raw = JSON.parse(await readFile(path.join(root, 'app', 'gifts.seed.json'), 'utf8').catch(() => '{}'));
    await writeGiftStore({ items: Array.isArray(raw?.items) ? raw.items : [], shippingFee: raw?.shippingFee });
  }
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

/** Thư viện ảnh của sản phẩm: ảnh mới (data:) lưu thành tệp, đường dẫn đã lưu giữ nguyên, tối đa 12. */
async function storeGalleryImages(images, productId) {
  const stored = [];
  for (const [index, image] of images.slice(0, maximumGalleryImages).entries()) {
    const source = typeof image === 'string' ? image : String(image?.dataUrl || image?.url || '');
    stored.push(source.startsWith('data:') ? await saveProductImage(source, `${productId}-g${index}`) : source);
  }
  return normalizeGallery(stored);
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
    botEnabled: conversation?.botEnabled !== false,
    gender: conversation?.gender || '',
    genderSource: conversation?.genderSource || '',
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
  // Số điện thoại hay bom hàng: đơn vẫn được tạo (khách đã xác nhận) nhưng
  // mang cảnh báo để nhân viên gọi lại trước khi giao.
  await attachPhoneWarning(order);
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
  if (result.created) {
    publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id });
    // Khách được bám đuổi vừa chốt: thẻ Bám đuổi thành công.
    markFollowUpWins().catch(() => {});
    await appendOrderToArchive(result.order).catch(() => {});
    // Đẩy sang Pancake POS trước khi gửi phiếu: POS tự gửi khách thẻ xác nhận
    // đơn (receipt) trong hội thoại Pancake, nên đẩy được thì CRM không gửi thêm
    // phiếu ảnh của mình (khách nhận một phiếu). Lỗi POS ghi lên đơn, không chặn bot.
    const pos = await syncOrderToPos(conversation.id, result.order.id).catch(error => ({ error: error.message, at: Date.now() }));
    if (pos) result.order.pos = pos;
  }
  return result;
}

/**
 * Khách sửa đơn vừa chốt ("ko phải", "3 gói 3 vị"): thay giỏ, SĐT, địa chỉ trên
 * chính đơn đó thay vì tạo đơn thứ hai; đơn đã sang POS thì sửa bên đó theo.
 */
async function updateChatbotCustomerOrder(conversation, orderId, input) {
  const fresh = normalizeChatbotOrder(input, conversation);
  await attachPhoneWarning(fresh);
  const keep = new Set(['id', 'createdAt', 'pos', 'chatbotSourceMessageId', 'delivery', 'processingStatus', 'hiddenFromTable', 'staffNote', 'employee', 'automatic']);
  const stamp = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const result = await updateMessagingStore(store => {
    const item = store.conversations.find(entry => entry.id === conversation.id);
    const existing = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => String(entry.id) === String(orderId));
    if (!existing) return null;
    for (const [key, value] of Object.entries(fresh)) if (!keep.has(key)) existing[key] = value;
    // Giữ lại lời khách dặn trước đó ("Khách dặn: gửi hàng mới.") khi sửa giỏ.
    const requests = String(existing.note || '').match(/Khách dặn: [^.]*\./g) || [];
    existing.note = [`Tạo tự động từ xác nhận của chatbot. Khách sửa đơn lúc ${stamp}.`, ...requests].join(' ');
    existing.updatedAt = Date.now();
    return { order: existing };
  });
  if (!result) throw new Error('Không tìm thấy đơn để sửa.');
  publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id });
  await appendOrderToArchive(result.order).catch(() => {});
  if (result.order.pos?.id) {
    const posOutcome = await updatePosOrder(result.order, { conversation })
      .then(() => ({ ...result.order.pos, updatedAt: Date.now(), error: undefined }))
      .catch(error => ({ ...result.order.pos, updatedAt: Date.now(), error: `Sửa trên POS lỗi: ${error.message}` }));
    await updateMessagingStore(store => {
      const item = store.conversations.find(entry => entry.id === conversation.id);
      const target = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => String(entry.id) === String(orderId));
      if (target) target.pos = posOutcome;
      return null;
    });
    result.order.pos = posOutcome;
  }
  return { ...result, updated: true, created: false };
}

/**
 * Khách dặn thêm cho đơn vừa đặt ("gửi hàng mới", "gọi trước khi giao"): ghi vào
 * ghi chú đơn (hiện ở Xử lý dữ liệu và đi sang POS trong ghi chú "Khách ghi").
 */
async function addChatbotOrderNote(conversation, orderId, note) {
  // Không để dấu chấm trong lời dặn: ghi chú tách từng lời dặn theo "Khách dặn: …."
  const text = String(note || '').replace(/\s+/g, ' ').replace(/\.+/g, ',').replace(/[,\s]+$/, '').trim().slice(0, 200);
  const result = await updateMessagingStore(store => {
    const item = store.conversations.find(entry => entry.id === conversation.id);
    const existing = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => String(entry.id) === String(orderId));
    if (!existing) return null;
    if (text && !String(existing.note || '').includes(text)) existing.note = `${String(existing.note || '').trim()} Khách dặn: ${text}.`.trim();
    existing.updatedAt = Date.now();
    return { order: { ...existing } };
  });
  if (!result) throw new Error('Không tìm thấy đơn để ghi chú.');
  publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id });
  await appendOrderToArchive(result.order).catch(() => {});
  // Đơn nhân viên/Shop tạo trên POS: không ghi đè ghi chú của nhân viên trên POS (lời dặn nằm ở CRM).
  if (result.order.pos?.id && result.order.source !== 'POS') {
    const posOutcome = await updatePosOrderNote(result.order)
      .then(() => ({ ...result.order.pos, updatedAt: Date.now(), error: undefined }))
      .catch(error => ({ ...result.order.pos, updatedAt: Date.now(), error: `Ghi chú lên POS lỗi: ${error.message}` }));
    await updateMessagingStore(store => {
      const item = store.conversations.find(entry => entry.id === conversation.id);
      const target = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => String(entry.id) === String(orderId));
      if (target) target.pos = posOutcome;
      return null;
    });
  }
  return { ...result, noted: true, created: false };
}

/** Khách nhắn hủy đơn vừa đặt: đánh dấu hủy trên chính đơn đó, hủy bên POS nếu đã đẩy. */
async function cancelChatbotCustomerOrder(conversation, orderId) {
  const stamp = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const result = await updateMessagingStore(store => {
    const item = store.conversations.find(entry => entry.id === conversation.id);
    const existing = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => String(entry.id) === String(orderId));
    if (!existing) return null;
    existing.processingStatus = 'cancelled';
    existing.status = 'Hủy';
    existing.note = `${String(existing.note || '').trim()} Khách hủy đơn qua chatbot lúc ${stamp}.`.trim();
    existing.updatedAt = Date.now();
    return { order: existing };
  });
  if (!result) throw new Error('Không tìm thấy đơn để hủy.');
  publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id });
  await appendOrderToArchive(result.order).catch(() => {});
  if (result.order.pos?.id) {
    const posOutcome = await cancelPosOrder(result.order)
      .then(() => ({ ...result.order.pos, updatedAt: Date.now(), cancelled: true, error: undefined }))
      .catch(error => ({ ...result.order.pos, updatedAt: Date.now(), error: `Hủy trên POS lỗi: ${error.message}` }));
    await updateMessagingStore(store => {
      const item = store.conversations.find(entry => entry.id === conversation.id);
      const target = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => String(entry.id) === String(orderId));
      if (target) target.pos = posOutcome;
      return null;
    });
    result.order.pos = posOutcome;
  }
  return { ...result, cancelled: true, created: false };
}

/**
 * Đơn POS của một hội thoại Facebook mà CRM không tạo (khách thanh toán qua
 * Facebook Shop, nhân viên lên đơn trong Pancake): ghi vào đúng hội thoại, nguồn
 * "POS", để bảng Đơn hàng đủ đơn và bot biết khách đã có đơn. Mã đơn cố định
 * `pos<mã POS>` nên đồng bộ lại chỉ cập nhật (hủy trên POS thì hủy theo), không
 * nhân đôi. Trả về số đơn mới ghi.
 */
/**
 * Thông tin khách cho bám đuổi (chỉ bám khách mới): hồ sơ khách Pancake/POS của
 * hội thoại, cộng lịch sử POS và bảng đơn CRM theo các SĐT khách từng để lại.
 */
async function followUpConversationInfo(pageId, conversationId) {
  const info = await fetchPancakeConversationInfo(pageId, conversationId);
  const phones = info.phones.map(phone => normalizeWarningPhone(phone)).filter(Boolean).slice(0, 3);
  let posOrders = 0;
  for (const phone of phones) {
    const report = await fetchPosPhoneReport(phone).catch(() => null);
    // Không tính đơn hoàn/hủy/bỏ dở: khách chỉ điền form dở chưa phải khách cũ.
    posOrders = Math.max(posOrders, (Number(report?.orders) || 0) - (Number(report?.failed) || 0), Number(report?.customer?.succeedOrderCount) || 0);
  }
  let crmOrders = 0;
  if (phones.length) {
    const store = await readMessagingStore();
    for (const conversation of store.conversations || []) {
      for (const order of conversation.customerOrders || []) if (phones.includes(normalizeWarningPhone(order.phone)) && String(order.processingStatus || '') !== 'cancelled' && order.status !== 'Hủy') crmOrders += 1;
    }
  }
  return { ...info, posOrders, crmOrders };
}

async function importPosConversationOrders(posOrders) {
  const drafts = [];
  for (const posOrder of Array.isArray(posOrders) ? posOrders : []) {
    const address = posOrder.shipping_address || {};
    const lines = (posOrder.items || []).filter(item => !item.is_bonus_product);
    try {
      const order = normalizeCustomerOrder({
        id: `pos${posOrder.system_id || posOrder.id}`,
        name: posOrder.bill_full_name || address.full_name || 'Khách Facebook',
        phone: posOrder.bill_phone_number || address.phone_number || '',
        address: address.full_address || [address.address, address.commune_name, address.district_name, address.province_name].filter(Boolean).join(', '),
        products: lines.map(item => ({ name: item.variation_info?.name || item.variation_info?.display_id || 'Sản phẩm', sku: item.variation_info?.display_id || '', quantity: item.quantity, price: item.variation_info?.retail_price })),
        shippingFee: posOrder.shipping_fee,
        freeShipping: Boolean(posOrder.is_free_shipping) || !Number(posOrder.shipping_fee),
        discount: posOrder.total_discount,
        gift: (posOrder.items || []).filter(item => item.is_bonus_product).map(item => item.variation_info?.name || item.variation_info?.display_id).filter(Boolean).join(' + '),
        source: 'POS',
        status: Number(posOrder.status) === 6 ? 'Hủy' : 'Mới',
        note: String(posOrder.note || '').slice(0, 500)
      }, { now: Date.parse(`${String(posOrder.inserted_at || '').replace(/Z?$/, 'Z')}`) || Date.now() });
      drafts.push({
        conversationKey: String(posOrder.conversation_id),
        order: {
          ...order,
          createdAt: Date.parse(`${String(posOrder.inserted_at || '').replace(/Z?$/, 'Z')}`) || Date.now(),
          automatic: false,
          employee: posOrder.creator?.name || posOrder.assigning_seller?.name || posOrder.account_name || '',
          pos: { id: String(posOrder.id), systemId: String(posOrder.system_id || ''), status: String(posOrder.status_name || ''), importedAt: Date.now() },
          ...(Number(posOrder.status) === 6 ? { processingStatus: 'cancelled' } : {})
        }
      });
    } catch {
      // Đơn thiếu SĐT/địa chỉ/sản phẩm (đơn nháp trên POS): bỏ qua.
    }
  }
  if (!drafts.length) return 0;
  let created = 0;
  const touched = new Set();
  await updateMessagingStore(store => {
    const byPancakeId = new Map(store.conversations.filter(item => item.pancakeConversationId && item.source !== 'comment').map(item => [String(item.pancakeConversationId), item]));
    for (const { conversationKey, order } of drafts) {
      const conversation = byPancakeId.get(conversationKey);
      if (!conversation) continue;
      if (!Array.isArray(conversation.customerOrders)) conversation.customerOrders = [];
      const existing = conversation.customerOrders.find(entry => entry.id === order.id || (entry.pos?.systemId && entry.pos.systemId === order.pos.systemId));
      if (existing) {
        // Đã kéo về: chỉ theo trạng thái hủy của POS; sửa của nhân viên trong CRM giữ nguyên.
        if (order.processingStatus === 'cancelled' && existing.processingStatus !== 'cancelled') {
          Object.assign(existing, { processingStatus: 'cancelled', status: 'Hủy', updatedAt: Date.now() });
          touched.add(conversation.id);
        }
        continue;
      }
      conversation.customerOrders.unshift(order);
      conversation.customerOrders = conversation.customerOrders.slice(0, 200);
      created += 1;
      touched.add(conversation.id);
    }
    return null;
  });
  for (const conversationId of touched) publishMessagingEvent({ type: 'customer-panel', conversationId });
  if (created) markFollowUpWins().catch(() => {});
  return created;
}

/**
 * Nhân viên hủy trên POS một đơn CRM đã đẩy sang (đơn trùng, khách đổi ý):
 * đồng bộ POS gọi hàm này để CRM hủy theo — không gọi lại POS. Trả về số đơn đã hủy.
 */
async function cancelCrmOrdersCancelledOnPos(ids) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
  if (!wanted.size) return 0;
  const stamp = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  const markCancelled = order => {
    order.processingStatus = 'cancelled';
    order.status = 'Hủy';
    order.note = `${String(order.note || '').trim()} Đã hủy trên POS (đồng bộ lúc ${stamp}).`.trim();
    order.updatedAt = Date.now();
    // Chỉ đồng bộ hủy MỘT lần: nhân viên mở lại đơn trong CRM thì lượt sau không hủy lại.
    order.pos = { ...(order.pos || {}), cancelled: true, cancelSyncedAt: Date.now(), error: undefined };
  };
  const changed = [];
  const touched = new Set();
  await updateMessagingStore(store => {
    for (const conversation of store.conversations) {
      for (const order of Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []) {
        if (!wanted.has(String(order.id)) || order.processingStatus === 'cancelled' || order.pos?.cancelSyncedAt || /Đã hủy trên POS/.test(String(order.note || ''))) continue;
        markCancelled(order);
        changed.push({ ...order });
        touched.add(conversation.id);
      }
    }
    return null;
  });
  await updateLandingStore(store => {
    for (const order of store.orders) {
      if (!wanted.has(String(order.id)) || order.processingStatus === 'cancelled' || order.pos?.cancelSyncedAt || /Đã hủy trên POS/.test(String(order.note || ''))) continue;
      markCancelled(order);
      if (!changed.some(item => item.id === order.id)) changed.push({ ...order });
    }
  });
  for (const order of changed) await appendOrderToArchive(order).catch(() => {});
  for (const conversationId of touched) publishMessagingEvent({ type: 'customer-panel', conversationId });
  return changed.length;
}

/* ---- Thử nghiệm: chào khách vừa quét mã QR ----
 *
 * Khách quét QR trên bao bì -> mở m.me?ref=... -> Meta bắn `messaging_referrals`.
 * Với hội thoại đã có sẵn, sự kiện này RESET cửa sổ 24 giờ, nên Page nhắn được
 * ngay mà khách không phải gõ gì. Đây là chỗ tận dụng điều đó.
 *
 * Giới hạn có chủ ý:
 *  - Chỉ phản hồi referral `source: SHORTLINK` (tức link m.me). Referral từ
 *    quảng cáo mang `source: ADS` và đã có luồng chào riêng — đụng vào là khách
 *    bấm quảng cáo nhận nhầm lời chào này.
 *  - Mỗi hội thoại chỉ chào lại sau QR_GREETING_COOLDOWN_MS, tránh khách quét
 *    mấy lần liền bị nhắn dồn.
 *  - Đặt QR_GREETING_TEXT rỗng trong .env là tắt hẳn, không phải sửa mã.
 */
const qrGreetingDelayMs = Number(process.env.QR_GREETING_DELAY_MS) || 10_000;
const qrGreetingCooldownMs = Number(process.env.QR_GREETING_COOLDOWN_MS) || 6 * 60 * 60 * 1000;
const qrGreetedAt = new Map();

/**
 * Page mà /q/<mã> chuyển hướng tới. Lấy từ Page đang kết nối trong CRM; đặt
 * QR_PAGE_ID trong .env để ghim cứng nếu sau này nối thêm Page thứ hai.
 * Nhớ lại kết quả để mỗi lượt quét không phải đọc đĩa.
 */
let cachedQrPageId = '';
async function resolveQrPageId() {
  if (cachedQrPageId) return cachedQrPageId;
  if (process.env.QR_PAGE_ID) return (cachedQrPageId = process.env.QR_PAGE_ID);
  const channels = await readChannelStore();
  cachedQrPageId = String(channels.items?.[0]?.id || '');
  return cachedQrPageId;
}

/** Khách đến từ phiếu cảm ơn (link m.me), phân biệt với khách bấm quảng cáo. */
function isCardScan(change) {
  return change?.referral?.source === 'SHORTLINK';
}

/**
 * Nội dung ưu đãi lấy từ kho mẫu tin, KHÔNG viết cứng trong mã — cùng nguyên
 * tắc với mọi lời thoại khác của bot, để nhân viên sửa được ở Cài đặt → Tin
 * nhắn mà không phải triển khai lại.
 */
async function qrOfferMessage(conversation) {
  const settings = await readChatbotSettings();
  const template = settings.messageTemplates?.QR_OFFER || defaultMessageTemplates().QR_OFFER || '';
  if (!template.trim()) return '';
  // spin: chọn ngẫu nhiên trong {a|b}. applyHonorific: thay anh/chị theo giới tính.
  return applyHonorific(spin(template), conversation.gender || '').replace(/\{title\}/g, honorific(conversation.gender || ''));
}

function scheduleQrGreetings(changes) {
  for (const change of changes) {
    // Không lọc theo `change.type`: khách cũ quét thì ra change kiểu `referral`,
    // khách mới bấm "Bắt đầu" thì ra kiểu `message` mang theo referral. Cái
    // quyết định là referral đến từ link m.me, không phải từ quảng cáo.
    if (!isCardScan(change)) continue;
    const conversation = change.conversation;
    if (!conversation?.psid) continue;
    const last = qrGreetedAt.get(conversation.id) || 0;
    if (Date.now() - last < qrGreetingCooldownMs) {
      console.log(`QR: bỏ qua chào ${conversation.id} (vừa chào cách đây ${Math.round((Date.now() - last) / 1000)}s)`);
      continue;
    }
    qrGreetedAt.set(conversation.id, Date.now());
    console.log(`QR: khách quét ref="${change.referral.ref || '-'}", sẽ chào sau ${qrGreetingDelayMs / 1000}s — ${conversation.name || conversation.id}`);
    // unref: hẹn giờ này không được giữ tiến trình sống khi tắt dịch vụ.
    setTimeout(async () => {
      try {
        const text = await qrOfferMessage(conversation);
        if (!text) {
          console.log('QR: mẫu tin QR_OFFER để trống nên không gửi gì.');
          qrGreetedAt.delete(conversation.id);
          return;
        }
        await sendConversationMessage(conversation, { text });
        console.log(`QR: đã gửi ưu đãi cho ${conversation.name || conversation.id}`);
      } catch (error) {
        // Ngoài cửa sổ 24h Meta trả lỗi ở đây — đó cũng là kết quả đáng ghi lại.
        console.error(`QR: KHÔNG gửi được ưu đãi cho ${conversation.name || conversation.id}: ${error.message}`);
        qrGreetedAt.delete(conversation.id);
      }
    }, qrGreetingDelayMs).unref?.();
  }
}

/** Sends the tappable Messenger receipt. Kept separate from creating the order so
 *  the chatbot can persist the order first and still close with the receipt. */
/** `force`: nhân viên bấm "Gửi lại cho khách" — gửi cả khi POS đã gửi thẻ, và ném lỗi thay vì chỉ ghi log. */
async function sendChatbotOrderReceipt(conversation, order, { force = false } = {}) {
  try {
    // Qua Pancake không gửi được thẻ receipt của Messenger: phiếu được vẽ
    // thành ảnh và gửi như ảnh đính kèm (bản chữ chỉ lặp lại ORDER_CONFIRMATION).
    // Đơn đã sang Pancake POS thì POS đã gửi khách thẻ xác nhận, không gửi phiếu thứ hai.
    // Bản chữ "XÁC NHẬN ĐƠN ĐẶT HÀNG…" KHÔNG BAO GIỜ gửi cho khách (yêu cầu của
    // chủ shop): phiếu chỉ là thẻ receipt của Messenger, thẻ của POS, hoặc ảnh phiếu.
    if (conversation.pancakeConversationId) {
      if (order.pos?.id && !force) return;
      await sendReceiptImage(conversation, order);
      return;
    }
    try {
      await sendConversationMessage(conversation, { template: buildOrderReceiptPayload(order, { baseUrl: metaConfig.publicBaseUrl }) });
    } catch (error) {
      // Messenger từ chối thẻ receipt: gửi ảnh phiếu thay vì bản chữ.
      console.error(`Messenger từ chối thẻ receipt của đơn ${order.id}, gửi ảnh phiếu: ${error.message}`);
      await sendReceiptImage(conversation, order);
    }
  } catch (error) {
    if (force) throw error;
    console.error(`Không gửi được hoá đơn cho đơn ${order.id}: ${error.message}`);
  }
}

async function sendReceiptImage(conversation, order) {
  const image = await renderOrderReceiptImage(order, { merchantName: pancakeConfig.pageName.replace(/\s*\(Pancake\)\s*$/i, '') || 'Giọt Nắng' });
  return sendConversationMessage(conversation, {
    attachment: { dataUrl: `data:image/png;base64,${image.toString('base64')}`, name: `phieu-don-${order.id}.png`, type: 'image' }
  });
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

configureAddressAi({ readSettings: readChatbotSettings });

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

/**
 * Thân request dạng JSON.
 *
 * Bắt buộc `Content-Type: application/json` khi có thân: trình duyệt chỉ gửi
 * được kiểu này từ một trang khác sau khi hỏi trước (preflight), mà máy chủ
 * không trả header CORS nào nên preflight luôn hỏng. Nếu nhận bừa mọi kiểu thì
 * một trang web bất kỳ gửi được lệnh ghi dưới danh nghĩa nhân viên đang đăng
 * nhập — Basic Auth không cản được vì trình duyệt tự đính kèm lại.
 * Request không có thân (ví dụ POST .../read) vẫn đi qua như cũ.
 */
async function readBody(request, maximumBytes = 32 * 1024 * 1024) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maximumBytes) throw new Error('Nội dung gửi lên vượt quá giới hạn cho phép.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('Nội dung gửi lên phải là application/json.');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Chặn lệnh ghi phát đi từ một trang web khác (CSRF).
 *
 * Trình duyệt luôn gửi `Origin` cho request ghi, kể cả cùng nguồn; thiếu hẳn
 * `Origin` là máy gọi máy (Meta, Webcake, curl) nên vẫn cho qua — hai webhook
 * đã tự xác thực bằng chữ ký và token riêng. Chỉ chặn khi có `Origin` mà khác
 * host đang phục vụ.
 */
function isCrossSiteWrite(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return false;
  const origin = request.headers.origin;
  if (!origin) return false;
  // "null" là trang trong iframe cách ly hay tài liệu data: — không có người gọi hợp lệ nào như vậy.
  if (origin === 'null') return true;
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  if (!originHost) return true;
  // Khớp với Host của request là đủ cho mọi cách chạy hiện tại. Nhận thêm địa
  // chỉ công khai đã cấu hình để phòng trường hợp reverse proxy được sửa thành
  // ghi đè Host — nếu không, một dòng cấu hình Caddy đổi đi là chặn sạch mọi
  // thao tác ghi của nhân viên mà chẳng ai đoán ra vì sao.
  if (originHost === String(request.headers.host || '')) return false;
  try {
    return originHost !== new URL(metaConfig.publicBaseUrl).host;
  } catch {
    return true;
  }
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
  // Meta requires a public privacy policy URL; Caddy lets /privacy through without a password.
  const relative = pathname === '/' ? 'index.html' : pathname === '/privacy' ? 'privacy.html' : pathname.slice(1);
  const filePath = path.resolve(webRoot, relative);
  if (!filePath.startsWith(path.resolve(webRoot) + path.sep)) return sendJson(response, 400, { error:'Invalid path.' });
  const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.webp':'image/webp', '.woff2':'font/woff2', '.ico':'image/x-icon' };
  try {
    const stats = await stat(filePath);
    let etag = `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
    let body = null;
    if (relative === 'index.html') {
      // Phiên bản app.js/styles.css gắn theo mốc sửa tệp: mỗi lần deploy trình duyệt
      // tự tải bản mới, không phụ thuộc chuỗi ?v= ghi tay trong index.html.
      const stamp = async name => { try { return Math.trunc((await stat(path.join(webRoot, name))).mtimeMs).toString(36); } catch { return ''; } };
      const [appStamp, cssStamp] = await Promise.all([stamp('app.js'), stamp('styles.css')]);
      body = Buffer.from(String(await readFile(filePath, 'utf8'))
        .replace(/app\.js\?v=[^"']*/g, `app.js?v=${appStamp}`)
        .replace(/styles\.css\?v=[^"']*/g, `styles.css?v=${cssStamp}`), 'utf8');
      etag = `W/"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
    }
    const headers = { 'Content-Type':types[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control':'no-cache', 'ETag':etag };
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, headers);
      return response.end();
    }
    if (!body) body = await readFile(filePath);
    response.writeHead(200, headers);
    response.end(body);
  } catch { sendJson(response, 404, { error:'Resource not found.' }); }
}

await initializeStore();
// Những gì bot cần để trả lời: dùng chung cho webhook Meta và webhook Pancake,
// khác nhau chỉ ở đường gửi tin (sendConversationMessage tự chọn Meta hay Pancake).
const chatbotDependencies = {
  readSettings: readChatbotSettings,
  listMessages,
  // Bot đọc lại hội thoại trước khi trả lời: tin trước trong hàng đợi có thể
  // vừa lưu giỏ hàng, hay nhân viên vừa tắt bot.
  getConversation,
  sendMessage: sendConversationMessage,
  moderateComment,
  createOrder: createChatbotCustomerOrder,
  updateOrder: updateChatbotCustomerOrder,
  cancelOrder: cancelChatbotCustomerOrder,
  addOrderNote: addChatbotOrderNote,
  // Khách hỏi đơn đã đặt và gửi SĐT: tìm đơn theo SĐT ở mọi hội thoại (đặt ở
  // trang kia, qua bình luận, đơn landing đồng bộ từ POS), mới nhất trước.
  findOrdersByPhone: async phone => {
    const wanted = String(phone || '').replace(/\D/g, '').replace(/^84/, '0');
    if (wanted.length < 9) return [];
    const store = await readMessagingStore();
    return store.conversations
      .flatMap(item => (Array.isArray(item.customerOrders) ? item.customerOrders : []))
      // Đơn quá 14 ngày (đã giao từ lâu) không phải đơn khách đang hỏi.
      .filter(order => String(order?.phone || '').replace(/\D/g, '').replace(/^84/, '0') === wanted && String(order.processingStatus || '') !== 'cancelled'
        && Date.now() - (Number(order.createdAt) || 0) < 14 * 24 * 60 * 60 * 1000)
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
      .slice(0, 3);
  },
  // Khách đặt qua Facebook Shop: Pancake tạo đơn POS (có SĐT, địa chỉ khách điền
  // lúc thanh toán) vài chục giây sau tin giỏ hàng. Tìm đơn POS của đúng hội thoại
  // này từ `since` để bot không xin lại thông tin và không lên đơn trùng.
  findShopOrder: async (conversation, { since = Date.now() - 30 * 60 * 1000 } = {}) => {
    if (!conversation?.pancakeConversationId || !posConfigured(posConfig())) return null;
    const data = await posRequest('/orders', {
      page_size: 50, page_number: 1, updateStatus: 'inserted_at', option_sort: 'inserted_at_desc',
      startDateTime: Math.floor(since / 1000), endDateTime: Math.floor(Date.now() / 1000) + 60
    }, posConfig(), fetch);
    const found = (Array.isArray(data?.data) ? data.data : []).find(order => String(order.conversation_id || '') === String(conversation.pancakeConversationId)
      && !isCrmPushedPosOrder(order) && Number(order.status) !== 6);
    if (!found) return null;
    return {
      id: String(found.system_id || found.id),
      total: Number(found.cod ?? found.total_price) || 0,
      phone: String(found.bill_phone_number || found.shipping_address?.phone_number || ''),
      items: (found.items || []).filter(item => !item.is_bonus_product).map(item => ({ name: String(item.variation_info?.name || '').trim(), sku: String(item.variation_info?.display_id || ''), quantity: Number(item.quantity) || 1 }))
    };
  },
  sendReceipt: sendChatbotOrderReceipt,
  // Bot báo về sự kiện (chốt đơn / chuyển nhân viên / khiếu nại); thẻ nào
  // nhận sự kiện là do nhân viên chọn trong Cài đặt → Tin nhắn.
  saveBotState: async (id, { addLabelEvents = [], ...botState }) => {
    const addLabels = addLabelEvents.length
      ? labelsForEvents((await readInboxSettings()).labels, addLabelEvents)
      : [];
    return updateMessagingStore(store => {
      const conversation = store.conversations.find(item => item.id === id);
      if (!conversation) return null;
      Object.assign(conversation, botState);
      if (addLabels.length) {
        const before = Array.isArray(conversation.labels) ? conversation.labels : [];
        const merged = [...new Set([...before, ...addLabels])];
        if (merged.length !== before.length) {
          conversation.labels = merged;
          publishMessagingEvent({ type: 'conversation', conversation: publicConversation(conversation) });
        }
      }
      return conversation;
    });
  }
};

let pancakeNoTokenWarnedAt = 0;
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    // Hai webhook do máy ngoài gọi và tự xác thực lấy, nên không áp luật Origin.
    const isWebhook = url.pathname === metaConfig.webhookPath || url.pathname === landingConfig.path || url.pathname === pancakeConfig.path;
    if (!isWebhook && isCrossSiteWrite(request)) {
      return sendJson(response, 403, { error: 'Yêu cầu đến từ trang khác nên bị từ chối.' });
    }
    if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { status:'ok', time:new Date().toISOString() });
    // Lớp trung gian của mã QR trên phiếu cảm ơn. Công khai (Caddy cho đi thẳng)
    // vì khách quét chưa đăng nhập gì cả. Đích đến do MÁY CHỦ quyết định, mã chỉ
    // đi vào tham số `ref` — người ngoài không thể biến nó thành chuyển hướng
    // tới địa chỉ khác.
    const qrMatch = url.pathname.match(/^\/q\/([^/]+)\/?$/);
    if (qrMatch && request.method === 'GET') {
      const code = decodeURIComponent(qrMatch[1]).toLowerCase();
      if (!isValidQrCode(code)) return sendJson(response, 404, { error: 'Mã QR không hợp lệ.' });
      // Đếm trước, nhưng không để việc ghi đĩa làm khách phải chờ.
      recordQrScan(code, { userAgent: String(request.headers['user-agent'] || '') })
        .catch(error => console.error(`QR: không ghi được lượt quét ${code}: ${error.message}`));
      const pageId = await resolveQrPageId();
      if (!pageId) {
        console.error('QR: chưa có Page nào kết nối nên không biết chuyển hướng đi đâu.');
        return sendJson(response, 503, { error: 'Chưa cấu hình Page Facebook.' });
      }
      const destination = `https://m.me/${encodeURIComponent(pageId)}?ref=${encodeURIComponent(code)}`;
      console.log(`QR: lượt quét ${code} -> chuyển hướng Messenger`);
      response.writeHead(302, { Location: destination, 'Cache-Control': 'no-store' });
      return response.end();
    }
    // Đối chiếu lượt quét với số referral Messenger thật sự nhận được.
    if (request.method === 'GET' && url.pathname === '/api/qr/stats') {
      const store = await readMessagingStore();
      const referralCounts = {};
      for (const conversation of store.conversations || []) {
        for (const referral of conversation.referrals || []) {
          if (referral?.source !== 'SHORTLINK' || !referral.ref) continue;
          referralCounts[referral.ref] = (referralCounts[referral.ref] || 0) + 1;
        }
      }
      return sendJson(response, 200, await listQrScans(referralCounts));
    }
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
      const id = randomUUID();
      const product = await updateProductStore(async store => {
        const created = normalizeProduct(payload, { id, createdAt: Date.now(), image: '' });
        assertUniqueSku(store.items, created.sku);
        if (payload.imageData) created.image = await saveProductImage(payload.imageData, id);
        if (Array.isArray(payload.images)) created.images = await storeGalleryImages(payload.images, id);
        store.items.unshift(created);
        return created;
      });
      return sendJson(response, 201, product);
    }
    const productMatch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
    if (productMatch && ['PUT', 'DELETE'].includes(request.method)) {
      const payload = request.method === 'PUT' ? await readBody(request, 8 * 1024 * 1024) : null;
      let missing = false;
      const result = await updateProductStore(async store => {
        const index = store.items.findIndex(product => product.id === productMatch[1]);
        if (index < 0) { missing = true; return undefined; }
        if (request.method === 'DELETE') return store.items.splice(index, 1)[0];
        const product = normalizeProduct(payload, store.items[index]);
        assertUniqueSku(store.items, product.sku, product.id);
        if (payload.removeImage === true) product.image = '';
        if (payload.imageData) product.image = await saveProductImage(payload.imageData, product.id);
        if (Array.isArray(payload.images)) product.images = await storeGalleryImages(payload.images, product.id);
        store.items[index] = product;
        return product;
      });
      if (missing) return sendJson(response, 404, { error: 'Không tìm thấy sản phẩm.' });
      return sendJson(response, 200, result);
    }
    // Bám đuổi: trạng thái (bật từ khi nào, lần chạy cuối, các lần gửi gần nhất) và chạy tay một lượt.
    // Bộ test vàng: lô tin cần chấm, nạp thêm tin, ghi nhãn nhân viên chấm.
    if (request.method === 'GET' && url.pathname === '/api/chatbot/golden') {
      return sendJson(response, 200, { ...(await goldenSetOverview({ batch: Math.max(1, Math.min(50, Number(url.searchParams.get('batch')) || 10)) })), templateIds: Object.keys((await readChatbotSettings()).messageTemplates || {}) });
    }
    if (request.method === 'POST' && url.pathname === '/api/chatbot/golden/import') {
      const payload = await readBody(request);
      return sendJson(response, 200, await importGoldenItems(payload.items));
    }
    if (request.method === 'POST' && url.pathname === '/api/chatbot/golden/label') {
      const payload = await readBody(request);
      try {
        const item = await labelGoldenItem(String(payload.id || ''), String(payload.label || ''));
        if (!item) return sendJson(response, 404, { error: 'Không thấy tin này trong bộ test.' });
        return sendJson(response, 200, { item, ...(await goldenSetOverview({ batch: 10 })) });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/chatbot/follow-ups') {
      return sendJson(response, 200, await followUpStatus());
    }
    if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/run') {
      const summary = await runFollowUps({ readSettings: readChatbotSettings, sendMessage: sendConversationMessage, conversationInfo: followUpConversationInfo });
      return sendJson(response, 200, { ...summary, status: await followUpStatus() });
    }
    // Hàng chờ ngoài 24 giờ: nhân viên gửi trong Pancake rồi bấm "Đã gửi" (hay "Bỏ qua").
    if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/queue') {
      const payload = await readBody(request);
      const action = payload.action === 'skip' ? 'skip' : 'sent';
      const done = await resolveFollowUpQueueItem(String(payload.key || ''), action, { readSettings: readChatbotSettings });
      if (!done) return sendJson(response, 404, { error: 'Tin này không còn trong hàng chờ.' });
      return sendJson(response, 200, await followUpStatus());
    }
    // Trạm gửi Pancake: lô gửi (ID Facebook lấy lại từ Pancake, khách đã có đơn thì bỏ)
    // và kết quả dấu trang "Gửi bám đuổi" báo về sau khi extension Pancake gửi xong.
    if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/batch') {
      const payload = await readBody(request);
      const batch = await buildFollowUpBatch({ limit: payload.limit, readSettings: readChatbotSettings, conversationInfo: followUpConversationInfo });
      return sendJson(response, 200, batch);
    }
    // Dọn hàng chờ ngay: tra lại khách chưa xét, khách cũ (đã từng mua) bỏ khỏi hàng.
    if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/prune') {
      const payload = await readBody(request);
      const result = await pruneReturningFromQueue({ conversationInfo: followUpConversationInfo, limit: Math.max(1, Math.min(300, Number(payload.limit) || 100)) });
      console.log(`Bám đuổi: dọn hàng chờ, xét ${result.checked}, bỏ ${result.removed} khách cũ`);
      return sendJson(response, 200, { ...result, status: await followUpStatus() });
    }
    if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/batch-results') {
      const payload = await readBody(request);
      const summary = await recordFollowUpBatchResults(payload.results, { readSettings: readChatbotSettings, token: String(payload.token || '') });
      console.log(`Bám đuổi qua trạm Pancake: gửi ${summary.sent}, lỗi ${summary.failed} (bỏ ${summary.dropped}${summary.rejected ? `, sai mã lô ${summary.rejected}` : ''})`);
      return sendJson(response, 200, { ...summary, status: await followUpStatus() });
    }
    // Nhân viên bấm Dừng / đóng trang giữa lô: bỏ giữ chỗ để lô sau lấy lại ngay.
    if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/release') {
      const payload = await readBody(request);
      const released = await releaseFollowUpLeases(Array.isArray(payload.keys) ? payload.keys.map(String) : null);
      return sendJson(response, 200, { released });
    }
    if (request.method === 'GET' && url.pathname === '/api/chatbot/settings') {
      const settings = await readChatbotSettings();
      return sendJson(response, 200, {
        ...publicChatbotSettings(settings),
        // Thiết lập tin nhắn: every text the bot can say, all editable.
        templates: settings.messageTemplates,
        builtInTemplateIds: Object.keys(defaultMessageTemplates())
      });
    }
    if (request.method === 'PUT' && url.pathname === '/api/chatbot/settings') {
      const current = await readChatbotSettings();
      const payload = await readBody(request);
      const directEndpoint = String(payload.directEndpoint || current.directEndpoint || '');
      try {
        assertUsableAiEndpoint(directEndpoint, {
          provider: payload.provider || current.provider,
          authType: payload.directAuthType || current.directAuthType
        });
        await assertPublicHost(new URL(directEndpoint).hostname);
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
      const providerChanged = payload.provider && payload.provider !== current.provider;
      const settings = await writeChatbotSettings({
        ...current,
        ...payload,
        messageTemplates: payload.messageTemplates ?? current.messageTemplates,
        directApiKey: String(payload.directApiKey || '').trim() || (providerChanged ? '' : current.directApiKey),
        updatedAt: Date.now()
      });
      // Bám đuổi vừa bật lại: tính từ bây giờ, không gửi dồn cho khách cũ.
      if (settings.followUps?.enabled && !current.followUps?.enabled) await resetFollowUpActivation();
      return sendJson(response, 200, {
        ...publicChatbotSettings(settings),
        templates: settings.messageTemplates,
        builtInTemplateIds: Object.keys(defaultMessageTemplates())
      });
    }
    // Nút "Cho phép chatbot hoạt động": không chỉ bật/tắt cài đặt chung mà đặt lại
    // trạng thái bot của MỌI hội thoại — bật thì mọi hội thoại đang bị tắt riêng
    // (nhân viên nhắn, POS, chuyển CSKH) được bật lại và xóa lỗi cũ; tắt thì tắt hết.
    // Giữ nguyên giỏ đang chờ, đơn, thẻ, ghi chú và lịch sử tin nhắn.
    if (request.method === 'POST' && url.pathname === '/api/chatbot/master-switch') {
      const payload = await readBody(request);
      const enabled = payload.enabled === true;
      const current = await readChatbotSettings();
      const settings = await writeChatbotSettings({ ...current, enabled, updatedAt: Date.now() });
      const summary = await updateMessagingStore(store => {
        let changed = 0;
        for (const conversation of store.conversations) {
          const before = `${conversation.botEnabled}|${conversation.botPausedBy || ''}|${conversation.botLastError || ''}|${conversation.botDraft || ''}`;
          conversation.botEnabled = enabled;
          delete conversation.botPausedBy;
          delete conversation.botPausedAt;
          conversation.botLastError = '';
          conversation.botLastErrorAt = 0;
          conversation.botDraft = '';
          if (before !== `${conversation.botEnabled}||||`) changed += 1;
        }
        return { total: store.conversations.length, changed };
      });
      console.log(`Chatbot ${enabled ? 'BẬT' : 'TẮT'} cho mọi hội thoại: ${summary.changed}/${summary.total} hội thoại được đặt lại.`);
      return sendJson(response, 200, { enabled: settings.enabled === true, conversations: summary.total, changed: summary.changed });
    }
    if (request.method === 'POST' && url.pathname === '/api/chatbot/test') {
      const current = await readChatbotSettings();
      const payload = await readBody(request, 256 * 1024);
      const text = String(payload.message || '').trim();
      // Thử ảnh: imageUrl (ảnh công khai) được đưa cho model như tin ảnh của khách.
      const imageUrl = String(payload.imageUrl || '').trim();
      if (!text && !imageUrl) return sendJson(response, 400, { error: 'Vui lòng nhập tin nhắn thử.' });
      const recentMessages = Array.isArray(payload.recentMessages)
        ? payload.recentMessages.slice(-100).map(item => ({
          id: String(item?.id || '').slice(0, 120),
          direction: item?.direction === 'outgoing' ? 'outgoing' : 'incoming',
          type: 'text',
          text: String(item?.text || '').slice(0, 12000)
        })).filter(item => item.text.trim())
        : [];
      const settings = normalizeChatbotSettings({ ...current, ...payload, enabled: true, directApiKey: '' });
      // Route này nhận endpoint do người gọi đặt (để thử trước khi lưu), nên
      // phải kiểm y như lúc lưu — nếu không, máy chủ sẽ mang access token
      // Google gửi tới bất cứ địa chỉ nào được chỉ định rồi trả nguyên văn
      // phản hồi về (`rawResponse: true` bên dưới).
      try {
        assertUsableAiEndpoint(settings.directEndpoint, { provider: settings.provider, authType: settings.directAuthType });
        await assertPublicHost(new URL(settings.directEndpoint).hostname);
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
      const reply = await requestDirectModelReply({
        settings,
        conversation: { id: 'preview', name: 'Khách xem trước', botEnabled: true },
        message: imageUrl ? { type: 'image', text, dataUrl: imageUrl } : { type: 'text', text },
        recentMessages,
        rawResponse: true
      });
      return sendJson(response, 200, { raw: reply.raw, parsed: reply.parsed });
    }
    if (request.method === 'GET' && url.pathname === '/api/channels') {
      const store = await readChannelStore();
      const nongSanPage = store.items.find(item => item.name?.includes('Giọt Nắng') && item.picture);
      const defaultPicture = nongSanPage?.picture || '/assets/giot-nang-logo.webp';
      return sendJson(response, 200, {
        metaConfigured: isMetaConfigured(),
        missingConfiguration: missingMetaConfiguration(),
        webhookConfigured: isWebhookConfigured(),
        missingWebhookConfiguration: missingWebhookConfiguration(),
        webhookUrl: metaConfig.webhookUrl,
        items: [
          ...store.items.map(publicChannel),
          // Page vận hành trong Pancake: không có token Meta, hiện như một kênh để
          // hộp thư xem được hội thoại bot đang trả lời qua Pancake.
          ...(isPancakeConfigured() ? (pancakeConfig.pages?.length ? pancakeConfig.pages : [pancakeConfig]).map(p => ({ id: p.pageId, name: p.pageName, picture: p.picture || defaultPicture, platform: 'facebook', via: 'pancake', status: 'connected', subscribed: true, subscribedFields: [], subscriptionError: '', connectedAt: 0, checkedAt: 0, syncedAt: '' })) : [])
        ],
        pancake: { configured: isPancakeConfigured(), webhookUrl: pancakeConfig.webhookUrl, pageId: pancakeConfig.pageId }
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
      // pages_read_user_content: read comments; pages_manage_engagement: reply to them and send private replies.
      // Gender is not requested: Facebook Login for Business has no pages_user_gender (Invalid Scope).
      authorizationUrl.searchParams.set('scope', 'pages_show_list,pages_read_engagement,pages_manage_metadata,pages_messaging,pages_read_user_content,pages_manage_engagement');
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
    // Cài đặt → Kênh → Tải ảnh khách: retry avatars for threads still showing a letter.
    const profilesChannelMatch = url.pathname.match(/^\/api\/channels\/facebook\/([^/]+)\/profiles$/);
    if (request.method === 'POST' && profilesChannelMatch) {
      try {
        return sendJson(response, 200, await refreshCustomerProfiles(decodeURIComponent(profilesChannelMatch[1])));
      } catch (error) {
        return sendJson(response, 502, { error: error.message });
      }
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
        // the UI instead of forcing the Page to be disconnected and re-added —
        // also when a field this build needs (feed, messaging_referrals…) is
        // missing because the Page was subscribed by an older build.
        const requiredFields = metaConfig.subscribedFields.split(',').map(field => field.trim()).filter(Boolean);
        const missingFields = requiredFields.filter(field => !subscription.fields.includes(field));
        if (!subscription.subscribed || missingFields.length) {
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
        channel.subscribedFields = subscription.fields;
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
    // Đơn từ landing page: nền tảng landing gọi bằng máy, không đăng nhập
    // được, nên đường dẫn này đi qua Caddy không cần mật khẩu và tự xác thực
    // bằng token. Luôn trả lời nhanh để bên kia không gửi lại nhiều lần.
    if (url.pathname === landingConfig.path) {
      if (request.method === 'GET') {
        return sendJson(response, 200, { status: 'ok', accepts: 'POST JSON hoặc form-urlencoded', configured: Boolean(landingConfig.token) });
      }
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Chỉ nhận POST.' });
      if (!landingConfig.token) {
        console.error('Webhook landing: từ chối vì LANDING_WEBHOOK_TOKEN chưa được đặt trong .env');
        return sendJson(response, 503, { error: 'Webhook landing chưa được bật trên máy chủ.' });
      }
      if (!isLandingTokenValid(landingTokenFrom(request, url), landingConfig.token)) {
        console.error('Webhook landing: từ chối vì token không hợp lệ');
        return sendJson(response, 401, { error: 'Token không hợp lệ.' });
      }
      const rawBody = await readRawBody(request);
      const payload = parseLandingBody(rawBody, request.headers['content-type']);
      // Webcake cho thêm ?event=... vào URL để phân biệt sự kiện; ghi nhận cùng trang gọi.
      const page = [url.searchParams.get('page') || request.headers.referer || '', url.searchParams.get('event') ? `event=${url.searchParams.get('event')}` : '']
        .filter(Boolean).join(' ').slice(0, 200);
      const result = await recordLandingOrder(payload, { page });
      if (result.error) {
        console.error(`Webhook landing: không tạo được đơn — ${result.error}`);
        return sendJson(response, 202, { accepted: false, error: result.error });
      }
      console.log(`Webhook landing: ${result.created ? 'tạo đơn' : 'đơn trùng, bỏ qua'} #${result.order.id} (${result.order.phone})`);
      publishMessagingEvent({ type: 'landing-order', orderId: result.order.id });
      return sendJson(response, result.created ? 201 : 200, { accepted: true, created: result.created, orderId: result.order.id });
    }
    // Cảnh báo số điện thoại hay bom hàng: tra một lượt cho bảng Đơn hàng, và
    // danh sách nhân viên tự đánh dấu.
    if (request.method === 'POST' && url.pathname === '/api/phone-warnings/check') {
      const payload = await readBody(request);
      const phones = Array.isArray(payload.phones) ? payload.phones : [];
      const results = await lookupPhones(phones, { force: Boolean(payload.force) });
      return sendJson(response, 200, { posConfigured: posConfigured(), results });
    }
    // Kết nối Pancake POS (Cài đặt → Kênh): khoá dán một lần, được kiểm tra với
    // POS rồi lưu riêng trên máy chủ; giao diện chỉ thấy vài ký tự đầu/cuối.
    if (request.method === 'GET' && url.pathname === '/api/phone-warnings/pos') {
      return sendJson(response, 200, posStatus());
    }
    if (request.method === 'POST' && url.pathname === '/api/phone-warnings/pos') {
      const payload = await readBody(request);
      try {
        return sendJson(response, 200, await connectPos({ apiKey: payload.apiKey, shopId: payload.shopId }));
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
    if (request.method === 'DELETE' && url.pathname === '/api/phone-warnings/pos') {
      return sendJson(response, 200, await disconnectPos());
    }
    // Kéo đơn landing từ POS ngay (mặc định 48 giờ gần nhất); bình thường chạy tự động mỗi 5 phút.
    if (request.method === 'POST' && url.pathname === '/api/landing/sync-pos') {
      const payload = await readBody(request);
      const summary = await syncPosLandingOrders({ sinceHours: Math.min(24 * 30, Math.max(1, Number(payload.sinceHours) || 48)) });
      return sendJson(response, 200, summary);
    }
    if (request.method === 'GET' && url.pathname === '/api/landing/recent') {
      return sendJson(response, 200, { webhookUrl: landingConfig.webhookUrl, configured: Boolean(landingConfig.token), items: await listRecentLandingPayloads() });
    }
    // Webhook Pancake (pages.fm): khách nhắn qua Page vận hành trong Pancake →
    // ghi hộp thư để theo dõi, bot trả lời ngược qua Public API của Pancake.
    // Pancake không ký payload nên xác thực bằng token trong URL; trả 200 ngay
    // vì Pancake tạm ngưng webhook khi lỗi hay chậm nhiều.
    if (url.pathname === pancakeConfig.path) {
      if (request.method === 'GET' || request.method === 'HEAD') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return response.end('{"status":"ok"}');
      }
      if (request.method === 'POST') {
        let payload = null;
        try {
          payload = await readBody(request);
        } catch (error) {
          console.error('Webhook Pancake thân không đọc được:', error.message);
        }
        const queryToken = url.searchParams.get('token');
        const headerToken = request.headers['x-pancake-token'] || request.headers['x-webhook-token'];
        const bodyToken = payload?.token || payload?.verify_token;
        const pageId = String(payload?.page_id || '');
        const tokenCandidates = [queryToken, headerToken, bodyToken].filter(Boolean);
        const configuredTokens = [
          pancakeConfig.webhookToken,
          ...(pancakeConfig.pages || []).map(p => p.webhookToken)
        ].filter(Boolean);
        const tokenValid = tokenCandidates.some(tok => configuredTokens.some(cfg => isPancakeWebhookTokenValid(tok, cfg)));
        // Pancake gọi webhook không kèm token (22/09/2026: mọi lần gọi thật đều
        // không có), nên ngoài token khớp còn nhận khi page_id là Page đã cấu
        // hình. Ghi log khi chỉ khớp page để còn dấu vết nếu có kẻ giả mạo.
        const pageValid = Boolean(pageId) && (pancakeConfig.pages?.length ? pancakeConfig.pages : [pancakeConfig]).some(p => String(p.pageId) === pageId);
        if (!isPancakeConfigured() || (!tokenValid && !pageValid)) {
          if (isPancakeConfigured()) console.warn('Webhook Pancake token không khớp, bỏ qua (page', pageId || '?', ')');
          response.writeHead(isPancakeConfigured() ? 401 : 503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          return response.end(isPancakeConfigured() ? 'Invalid token' : 'Pancake webhook is not configured');
        }
        // Pancake không gửi token (hành vi đã biết): ghi 1 dòng/giờ, không phủ đầy log.
        if (!tokenValid && payload?.event_type && payload.event_type !== 'verify' && Date.now() - pancakeNoTokenWarnedAt > 60 * 60 * 1000) {
          pancakeNoTokenWarnedAt = Date.now();
          console.warn('Webhook Pancake không có token, nhận theo page_id', pageId);
        }
        // Luôn trả 200 (Pancake tạm ngưng webhook khi >80% lần gọi lỗi); thân hỏng chỉ ghi log.
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('{"received":true}');
        if (!payload || !payload.event_type || payload.event_type === 'verify') return undefined;
        try {
          const summary = await handlePancakeWebhook(payload, { processChatbotChanges, chatbotDependencies });
          if (summary.stored) console.log(`Webhook Pancake: ghi ${summary.stored} tin, đưa bot ${summary.bot}`);
        } catch (error) {
          console.error('Webhook Pancake xử lý lỗi:', error.message);
        }
        return undefined;
      }
    }
    if (request.method === 'POST' && url.pathname === metaConfig.webhookPath) {
      const rawBody = await readRawBody(request);
      if (!verifyWebhookSignature(rawBody, request.headers['x-hub-signature-256'], metaConfig.appSecret)) {
        console.error(`Webhook Meta: từ chối vì chữ ký không hợp lệ (${rawBody.length} byte, header ${request.headers['x-hub-signature-256'] ? 'có' : 'thiếu'})`);
        response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return response.end('Invalid signature');
      }
      // Meta retries whenever the reply is slow, so acknowledge first and store afterwards.
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('EVENT_RECEIVED');
      try {
        const changes = await processWebhookPayload(JSON.parse(rawBody.toString('utf8')));
        scheduleQrGreetings(changes);
        // Khách quét phiếu đã có tin ưu đãi riêng; để bot chào thêm câu chung
        // nữa là khách nhận hai tin trong mười giây. Những tin sau của họ vẫn
        // đi qua bot bình thường — chỉ bỏ qua đúng sự kiện mở hội thoại.
        await processChatbotChanges(changes.filter(change => !isCardScan(change)), chatbotDependencies);
      } catch (error) {
        console.error('Webhook processing failed:', error.message);
      }
      return undefined;
    }
    // Khách hàng: every person who has messaged or commented, one row per Page.
    if (request.method === 'GET' && (url.pathname === '/api/customers' || url.pathname === '/api/customers/export.csv' || url.pathname === '/api/customers/audience.csv')) {
      const filters = Object.fromEntries([
        'q', 'channelId', 'source', 'gender', 'label', 'activeWithin',
        // Remarketing: mua trong N ngày, mua sản phẩm nào, combo mấy túi, mua mấy lần.
        'orderedWithin', 'product', 'combo', 'minOrders'
      ].map(key => [key, url.searchParams.get(key) || '']));
      const result = await listCustomers(filters);
      if (url.pathname === '/api/customers/audience.csv') {
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="remarketing-${new Date().toISOString().slice(0, 10)}.csv"`,
          'Cache-Control': 'no-store'
        });
        return response.end(customersToAudienceCsv(result.items));
      }
      if (url.pathname.endsWith('.csv')) {
        const { labels } = await readInboxSettings();
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="khach-hang-${new Date().toISOString().slice(0, 10)}.csv"`,
          'Cache-Control': 'no-store'
        });
        return response.end(customersToCsv(result.items, labels));
      }
      return sendJson(response, 200, result);
    }
    // Hộp chi tiết khách hàng: sửa thông tin, gắn thẻ, ghi chú, lịch sử đơn.
    // Mã khách có dấu hai chấm ("export:0903…") nên luôn đi qua encodeURIComponent.
    const customerRoute = url.pathname.startsWith('/api/customers/')
      ? url.pathname.slice('/api/customers/'.length).split('/')
      : [];
    if (customerRoute.length === 1 && request.method === 'PATCH') {
      const customer = await findCustomerById(decodeURIComponent(customerRoute[0]));
      if (!customer) return sendJson(response, 404, { error: 'Không tìm thấy khách hàng.' });
      try {
        await updateCustomerProfile(customer.editKey, await readBody(request));
        invalidateBuyersCache();
        return sendJson(response, 200, await findCustomerById(customer.id));
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
    if (customerRoute.length === 2) {
      const customerId = decodeURIComponent(customerRoute[0]);
      const customer = await findCustomerById(customerId);
      if (!customer) return sendJson(response, 404, { error: 'Không tìm thấy khách hàng.' });

      if (customerRoute[1] === 'labels' && request.method === 'PUT') {
        try {
          const payload = await readBody(request);
          await setCustomerLabels(customer.editKey, payload.labels || [], customer.derivedLabels);
          invalidateBuyersCache();
          return sendJson(response, 200, await findCustomerById(customer.id));
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }
      }

      if (customerRoute[1] === 'notes') {
        if (request.method === 'GET') return sendJson(response, 200, { items: await listCustomerNotes(customer.editKey) });
        if (request.method === 'POST') {
          try {
            const note = await addCustomerNote(customer.editKey, await readBody(request));
            invalidateBuyersCache();
            return sendJson(response, 200, { note, noteCount: (await findCustomerById(customer.id))?.noteCount || 0 });
          } catch (error) {
            return sendJson(response, 400, { error: error.message });
          }
        }
      }

      // Lịch sử đơn của một khách nằm ở hai chỗ: tệp khách hàng giữ đơn đã xuất
      // kho, kho lưu trữ đơn giữ đơn landing và đơn chatbot. Phải gộp cả hai vì
      // khách đến từ file xuất kho không có mặt trong kho lưu trữ và ngược lại.
      // Khớp ĐÚNG số điện thoại: tìm kiếm chung của kho còn dò cả tên và địa chỉ
      // nên dễ kéo nhầm đơn người khác.
      if (customerRoute[1] === 'orders' && request.method === 'GET') {
        const key = customerPhoneKey(customer.phone);
        if (!key) return sendJson(response, 200, { items: [] });
        const names = new Map(getCatalogProducts().map(product => [product.sku, product.name]));
        // Tên sản phẩm của chính khách này là bản dự phòng khi SKU đã rời danh mục.
        for (const product of customer.products || []) if (product?.sku) names.set(product.sku, product.name);
        const productName = (sku, name) => name || names.get(String(sku || '')) || String(sku || '');

        const byId = new Map();
        const exported = (await listExportedCustomers()).find(person => customerPhoneKey(person.phone) === key);
        for (const order of exported?.orders || []) {
          byId.set(String(order.id), {
            id: String(order.id),
            at: Number(order.orderedAt) || Number(order.exportedAt) || 0,
            status: 'Đã xuất kho',
            source: order.source || '',
            total: Number(order.total) || 0,
            products: (order.products || []).map(item => ({
              sku: String(item.sku || ''), name: productName(item.sku, item.name), quantity: Number(item.quantity) || 0
            }))
          });
        }
        // Một đơn có thể vừa nằm trong kho lưu trữ vừa đã xuất kho; bản ở tệp
        // khách hàng chi tiết hơn nên giữ, bản kho chỉ bù phần còn thiếu.
        const { items } = await readOrderArchive({ limit: 0 });
        for (const record of items) {
          if (customerPhoneKey(record.phone) !== key || byId.has(String(record.id))) continue;
          byId.set(String(record.id), {
            id: String(record.id),
            at: Number(record.at) || 0,
            status: record.st || 'Đã ghi kho',
            source: record.src || '',
            total: Number(record.total) || 0,
            products: (Array.isArray(record.items) ? record.items : []).map(([sku, quantity]) => ({
              sku: String(sku || ''), name: productName(sku, ''), quantity: Number(quantity) || 0
            }))
          });
        }
        return sendJson(response, 200, { items: [...byId.values()].sort((first, second) => second.at - first.at) });
      }
    }
    // Cài đặt → Tin nhắn: conversation labels and staff quick replies.
    if (url.pathname === '/api/inbox/settings') {
      if (request.method === 'GET') return sendJson(response, 200, { ...(await readInboxSettings()), defaultLabels: defaultConversationLabels, icons: await listLabelIcons() });
      if (request.method === 'PUT') {
        const current = await readInboxSettings();
        const payload = await readBody(request);
        try {
          const settings = await writeInboxSettings({
            labels: payload.labels ?? current.labels,
            quickReplies: payload.quickReplies ?? current.quickReplies
          }, saveProductImage);
          return sendJson(response, 200, settings);
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/messaging/conversations') {
      const items = await listConversations(url.searchParams.get('channelId') || '');
      return sendJson(response, 200, { items });
    }
    if (request.method === 'POST' && url.pathname === '/api/messaging/sync') {
      const payload = await readBody(request);
      const pageId = String(payload.channelId || '');
      if (!pageId) return sendJson(response, 400, { error: 'Thiếu channelId của Facebook Page cần đồng bộ.' });
      // Kênh Pancake: kéo lịch sử bằng API Pancake thay vì Graph của Meta.
      const isPancake = isPancakeConfigured() && (pancakeConfig.pages?.length ? pancakeConfig.pages.some(p => String(p.pageId) === pageId) : pageId === pancakeConfig.pageId);
      const summary = isPancake
        ? await syncPancakeConversations({ pageId, limit: Number(payload.limit) || 60, messagePages: 2 })
        : await syncPageConversations(pageId, { limit: Number(payload.limit) || 25 });
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
        const items = await listMessages(id, Number(url.searchParams.get('limit')) || 100);
        return sendJson(response, 200, {
          conversation: publicConversation(conversation),
          // A comment thread shows comments only; private replies live in Messenger.
          items: conversation.source === 'comment' ? items.filter(item => !item.privateReply) : items
        });
      }
      if (request.method === 'POST') {
        const payload = await readBody(request);
        const text = String(payload.text || '').trim();
        const attachment = payload.attachment?.dataUrl ? payload.attachment : null;
        const privateReply = payload.privateReply === true;
        // Pictures a quick reply carries: stored paths only, sent by URL after the text.
        const imageUrls = (Array.isArray(payload.imageUrls) ? payload.imageUrls : [])
          .filter(item => /^\/product-images\/[A-Za-z0-9-]+\.(?:png|jpe?g|webp)$/.test(String(item)))
          .filter(() => conversation.source !== 'comment' || privateReply)
          .slice(0, 6);
        if (!text && !attachment && !imageUrls.length) return sendJson(response, 400, { error: 'Nội dung tin nhắn không được để trống.' });
        try {
          // Comment threads: reply under the comment, or privately to Messenger.
          const sent = text || attachment ? await sendConversationMessage(conversation, { text, attachment, privateReply }) : null;
          const messages = sent ? [sent.message] : [];
          let last = sent;
          // A private reply lands in the person's Messenger thread; pictures follow it there.
          const imageTarget = conversation.source === 'comment' && privateReply
            ? await getConversation(sent?.conversation?.id || `${conversation.pageId}:${conversation.psid}`)
            : conversation;
          // Qua Pancake nhiều ảnh đi chung một tin (một cụm ảnh); Meta gửi từng ảnh.
          if (imageTarget && imageUrls.length && imageTarget.pancakeConversationId) {
            last = await sendConversationMessage(imageTarget, { imageUrls: imageUrls.map(publicImageUrl) });
            messages.push(last.message, ...(last.extras || []));
          } else {
            for (const imageUrl of imageTarget ? imageUrls : []) {
              last = await sendConversationMessage(imageTarget, { imageUrl: publicImageUrl(imageUrl) });
              messages.push(last.message);
            }
          }
          if (!last) return sendJson(response, 400, { error: 'Khách chưa có hội thoại Messenger để nhận ảnh.' });
          return sendJson(response, 200, { ...last, message: (sent || last).message, messages });
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
      if (conversation.source === 'comment') return sendJson(response, 200, publicConversation(conversation));
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
    // Tính giỏ hàng cho form Tạo đơn của nhân viên bằng đúng bộ giá của bot:
    // từ 2 sản phẩm giá combo, quà tặng và miễn ship theo bảng quà.
    if (request.method === 'POST' && url.pathname === '/api/orders/price') {
      const payload = await readBody(request);
      const items = (Array.isArray(payload.items) ? payload.items : []).slice(0, 50)
        .map(item => ({ sku: String(item?.sku || ''), name: String(item?.name || ''), quantity: Math.round(Number(item?.quantity) || 0) }));
      const priced = priceBasket(items);
      return sendJson(response, 200, {
        priceable: priced.priceable,
        reason: priced.reason || '',
        totalQuantity: priced.totalQuantity || 0,
        subtotal: priced.subtotal || 0,
        shippingFee: priced.priceable ? priced.shippingFee : getShippingFee(),
        total: priced.total || 0,
        gift: priced.gift || '',
        gifts: (priced.gifts || []).map(gift => ({ name: gift.name, sku: gift.sku || '', weight: Number(gift.weight) || 0 })),
        lines: (priced.lines || []).map(line => ({ sku: line.sku, name: line.name, quantity: line.quantity, unitPrice: line.unitPrice, basketUnitPrice: line.basketUnitPrice, lineTotal: line.lineTotal }))
      });
    }
    if (url.pathname === '/api/gifts') {
      // The product list rides along so the screen can offer "không áp dụng cho" choices.
      const giftResponse = () => ({
        items: getGifts(),
        shippingFee: getShippingFee(),
        products: getCatalogProducts().filter(product => product.active).map(product => ({ sku: product.sku, name: product.name }))
      });
      if (request.method === 'GET') return sendJson(response, 200, giftResponse());
      if (request.method === 'PUT') {
        const payload = await readBody(request);
        const items = Array.isArray(payload.items) ? payload.items : [];
        if (items.length > 50) return sendJson(response, 400, { error: 'Tối đa 50 quà tặng.' });
        for (const item of items) {
          if (!String(item?.name || '').trim()) return sendJson(response, 400, { error: 'Mỗi quà tặng phải có tên.' });
        }
        const shippingFee = Number(payload.shippingFee);
        if (payload.shippingFee !== undefined && (!Number.isInteger(shippingFee) || shippingFee < 0 || shippingFee > 500000)) return sendJson(response, 400, { error: 'Phí vận chuyển phải là số nguyên từ 0 đến 500.000.' });
        await updateGiftStore(current => ({
          items,
          shippingFee: payload.shippingFee !== undefined ? shippingFee : current.shippingFee
        }));
        return sendJson(response, 200, giftResponse());
      }
    }
    // What the model actually receives: the saved prompt plus the live catalogue block.
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
          const viaPancake = Boolean(conversation.pancakeConversationId);
          if (!viaPancake) {
            // Messenger trực tiếp: thẻ receipt; bị từ chối thì ảnh phiếu. Không bao giờ gửi bản chữ.
            try {
              let sent;
              try {
                sent = await sendConversationMessage(conversation, { template: buildOrderReceiptPayload(order, { baseUrl: metaConfig.publicBaseUrl }) });
              } catch (error) {
                console.error(`Messenger từ chối thẻ receipt của đơn ${order.id}, gửi ảnh phiếu: ${error.message}`);
                sent = await sendReceiptImage(conversation, order);
              }
              order.delivery = { status: 'sent', messageId: String(sent?.message?.mid || sent?.message?.id || ''), sentAt: Date.now() };
            } catch (error) {
              return sendJson(response, 502, { error: `Chưa tạo đơn: ${error.message}` });
            }
          }
          const stored = await updateMessagingStore(store => {
            const item = store.conversations.find(entry => entry.id === id);
            if (!item) return null;
            if (!Array.isArray(item.customerOrders)) item.customerOrders = [];
            item.customerOrders.unshift(order);
            item.customerOrders = item.customerOrders.slice(0, 200);
            return item;
          });
          if (!stored) return sendJson(response, 404, { error: 'Không tìm thấy hội thoại này.' });
          markFollowUpWins().catch(() => {});
          if (viaPancake) {
            // Hội thoại Pancake: không gửi bản chữ. Đẩy đơn sang Pancake POS, POS
            // gửi khách thẻ xác nhận đơn; POS lỗi thì CRM gửi phiếu ảnh của mình.
            const pos = await syncOrderToPos(id, order.id).catch(error => ({ error: error.message, at: Date.now() }));
            if (pos) order.pos = pos;
            if (!pos?.id) await sendChatbotOrderReceipt(conversation, order);
            order.delivery = { status: 'sent', messageId: '', sentAt: Date.now(), via: pos?.id ? 'pos' : 'receipt-image' };
            await updateMessagingStore(store => {
              const item = store.conversations.find(entry => entry.id === id);
              const target = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => entry.id === order.id);
              if (target) Object.assign(target, { delivery: order.delivery, ...(order.pos ? { pos: order.pos } : {}) });
              return null;
            });
          }
          const panel = await readMessagingStore().then(store => publicCustomerPanel(store.conversations.find(entry => entry.id === id)));
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
          } else if (payload.type === 'bot-error' && payload.clear === true) {
            item.botLastError = '';
            item.botLastErrorAt = 0;
          } else if (payload.type === 'gender') {
            // Staff's choice beats every guess; clearing it lets guesses back in.
            // Một người có nhiều hội thoại (hộp thư + từng bài bình luận): xưng hô
            // là của người đó, không của luồng, nên ghi cho mọi bản ghi cùng khách.
            const gender = ['male', 'female'].includes(payload.gender) ? payload.gender : '';
            for (const entry of store.conversations) {
              if (entry.pageId !== item.pageId || entry.psid !== item.psid) continue;
              entry.gender = gender;
              entry.genderSource = gender ? 'staff' : '';
              if (entry !== item) publishMessagingEvent({ type: 'conversation', conversation: publicConversation(entry) });
            }
          } else {
            throw new Error('Loại cập nhật thông tin khách hàng không hợp lệ.');
          }
          return publicCustomerPanel(item);
        });
        if (!panel) return sendJson(response, 404, { error: 'Không tìm thấy hội thoại này.' });
        return sendJson(response, 200, panel);
      }
    }
    // Bỏ (hay đưa lại) nhiều đơn hệ thống khỏi bảng Đơn hàng một lượt: nhân viên
    // xóa dòng hoặc Xóa bảng. Dấu nằm trên máy chủ nên máy khác mở CRM cũng không
    // kéo lại đơn đã xóa; hoàn tác gửi hidden:false.
    if (request.method === 'POST' && url.pathname === '/api/customer-orders/table-visibility') {
      const payload = await readBody(request);
      const ids = new Set((Array.isArray(payload.ids) ? payload.ids : []).map(String).filter(Boolean).slice(0, 5000));
      const hidden = payload.hidden !== false;
      if (!ids.size) return sendJson(response, 400, { error: 'Thiếu danh sách mã đơn.' });
      let changed = 0;
      const apply = order => { if (applyCustomerOrderEdits(order, { hiddenFromTable: hidden }).length) changed += 1; };
      await updateMessagingStore(store => {
        for (const conversation of store.conversations) {
          for (const order of Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []) if (ids.has(String(order.id))) apply(order);
        }
      });
      await updateLandingStore(store => { for (const order of store.orders) if (ids.has(String(order.id))) apply(order); });
      return sendJson(response, 200, { changed, hidden });
    }
    // Đẩy lại một đơn sang Pancake POS (khi lần đầu lỗi: mạng, POS thiếu mẫu mã…).
    const customerOrderPosMatch = url.pathname.match(/^\/api\/customer-orders\/([^/]+)\/pos$/);
    if (customerOrderPosMatch && request.method === 'POST') {
      const orderId = decodeURIComponent(customerOrderPosMatch[1]);
      const store = await readMessagingStore();
      const owner = store.conversations.find(item => (Array.isArray(item.customerOrders) ? item.customerOrders : []).some(order => order.id === orderId));
      if (!owner) return sendJson(response, 404, { error: 'Không tìm thấy đơn này trong hội thoại nào.' });
      if (!posConfigured()) return sendJson(response, 400, { error: 'Chưa kết nối Pancake POS (Cài đặt → Kênh).' });
      const outcome = await syncOrderToPos(owner.id, orderId);
      return sendJson(response, outcome?.error ? 502 : 200, { pos: outcome, error: outcome?.error || '' });
    }
    const customerOrderDeleteMatch = url.pathname.match(/^\/api\/customer-orders\/([^/]+)$/);
    // Sửa đơn từ bảng Xử lý dữ liệu: tên, số điện thoại, địa chỉ (tách lại ba
    // cấp), số lượng/đơn giá từng dòng. Server là sự thật cho đơn hệ thống nên
    // phải ghi về đây; ghi chú xử lý tự cập nhật theo dữ liệu mới.
    if (customerOrderDeleteMatch && request.method === 'PATCH') {
      const orderId = decodeURIComponent(customerOrderDeleteMatch[1]);
      const patch = await readBody(request);
      let updated = null;
      let failure = null;
      // Kiểm trên bản sao rồi mới chép đè. applyCustomerOrderEdits sửa TẠI CHỖ
      // từng trường một rồi mới ném lỗi ở trường sau, mà lỗi lại bị bắt ngay
      // trong mutator nên kho vẫn được ghi xuống đĩa — sửa thẳng thì một patch
      // bị từ chối vẫn kịp để lại nửa thay đổi, API trả 400 mà dữ liệu đã đổi.
      const apply = order => {
        const draft = structuredClone(order);
        try {
          applyCustomerOrderEdits(draft, patch);
        } catch (error) {
          failure = error;
          return;
        }
        Object.assign(order, draft);
        updated = order;
      };
      await updateMessagingStore(store => {
        for (const conversation of store.conversations) {
          const order = (Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []).find(item => item.id === orderId);
          if (!order) continue;
          apply(order);
          if (updated) publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id });
          break;
        }
      });
      if (!updated && !failure) {
        await updateLandingStore(store => {
          const order = store.orders.find(item => item.id === orderId);
          if (order) apply(order);
        });
      }
      if (failure) return sendJson(response, 400, { error: failure.message });
      if (!updated) return sendJson(response, 404, { error: 'Không tìm thấy đơn này.' });
      // Bản vừa sửa vào kho lưu trữ: dòng sau cùng của một mã đơn là bản đúng.
      await appendOrderToArchive(updated).catch(() => {});
      // Nhân viên chọn "Khách hủy"/bấm Hủy trên thẻ đơn: đơn đã sang POS thì hủy bên đó theo.
      if (patch.processingStatus === 'cancelled' && updated.pos?.id) {
        const posOutcome = await cancelPosOrder(updated)
          .then(() => ({ ...updated.pos, updatedAt: Date.now(), cancelled: true, error: undefined }))
          .catch(error => ({ ...updated.pos, updatedAt: Date.now(), error: `Hủy trên POS lỗi: ${error.message}` }));
        await updateMessagingStore(store => {
          for (const conversation of store.conversations) {
            const target = (Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []).find(order => order.id === orderId);
            if (target) { target.pos = posOutcome; publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id }); }
          }
          return null;
        });
        await updateLandingStore(store => { const target = store.orders.find(order => order.id === orderId); if (target) target.pos = posOutcome; });
        updated.pos = posOutcome;
      }
      // Đơn đã có trên Pancake POS: sửa bên đó theo (sản phẩm, địa chỉ, phí, ghi chú); lỗi ghi lên đơn.
      if (updated.pos?.id && ['name', 'phone', 'address', 'lines', 'products', 'freeShipping', 'shippingFee', 'discount', 'note', 'gift'].some(field => patch[field] !== undefined)) {
        const owner = (await readMessagingStore()).conversations.find(item => (Array.isArray(item.customerOrders) ? item.customerOrders : []).some(order => order.id === orderId));
        const posOutcome = await updatePosOrder(updated, { conversation: owner || {} })
          .then(() => ({ ...updated.pos, updatedAt: Date.now(), error: undefined }))
          .catch(error => ({ ...updated.pos, updatedAt: Date.now(), error: `Sửa trên POS lỗi: ${error.message}` }));
        await updateMessagingStore(store => {
          for (const conversation of store.conversations) {
            const target = (Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []).find(order => order.id === orderId);
            if (target) { target.pos = posOutcome; publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id }); }
          }
          return null;
        });
        await updateLandingStore(store => { const target = store.orders.find(order => order.id === orderId); if (target) target.pos = posOutcome; });
        updated.pos = posOutcome;
      }
      return sendJson(response, 200, { ...updated, processingNotes: processingNotes(updated) });
    }
    // Gửi lại phiếu xác nhận đơn cho khách (ảnh phiếu qua Pancake, thẻ receipt qua Messenger).
    const customerOrderResendMatch = url.pathname.match(/^\/api\/customer-orders\/([^/]+)\/resend$/);
    if (customerOrderResendMatch && request.method === 'POST') {
      const orderId = decodeURIComponent(customerOrderResendMatch[1]);
      const store = await readMessagingStore();
      const owner = store.conversations.find(item => (Array.isArray(item.customerOrders) ? item.customerOrders : []).some(order => order.id === orderId));
      const order = owner?.customerOrders.find(item => item.id === orderId);
      if (!owner || !order) return sendJson(response, 404, { error: 'Không tìm thấy đơn này trong hội thoại nào.' });
      try {
        await sendChatbotOrderReceipt(owner, order, { force: true });
      } catch (error) {
        return sendJson(response, 502, { error: `Chưa gửi lại được phiếu: ${error.message}` });
      }
      await updateMessagingStore(current => {
        const item = current.conversations.find(entry => entry.id === owner.id);
        const target = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => entry.id === orderId);
        if (target) target.delivery = { ...(target.delivery || {}), status: 'sent', resentAt: Date.now() };
        return null;
      });
      publishMessagingEvent({ type: 'customer-panel', conversationId: owner.id });
      return sendJson(response, 200, { ok: true });
    }
    if (customerOrderDeleteMatch && request.method === 'DELETE') {
      const orderId = decodeURIComponent(customerOrderDeleteMatch[1]);
      let removed = null;
      await updateMessagingStore(store => {
        for (const conversation of store.conversations) {
          const orders = Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [];
          const index = orders.findIndex(order => order.id === orderId);
          if (index < 0) continue;
          [removed] = orders.splice(index, 1);
          publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id });
          break;
        }
        return removed;
      });
      if (!removed) removed = await deleteLandingOrder(orderId);
      if (!removed) return sendJson(response, 404, { error: 'Không tìm thấy đơn này.' });
      // Xóa khỏi hệ thống nhưng vẫn giữ một dòng trong kho để còn tra lại.
      await appendOrderToArchive(removed, { status: 'deleted' }).catch(() => {});
      return sendJson(response, 200, removed);
    }
    // Kho lưu trữ đơn: tra lại khách, số điện thoại, sản phẩm, địa chỉ của mọi
    // đơn từng có, kể cả đơn đã hủy hay đã xóa khỏi bảng.
    if (request.method === 'GET' && url.pathname === '/api/orders/archive') {
      const query = String(url.searchParams.get('q') || '');
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200));
      return sendJson(response, 200, await readOrderArchive({ query, limit }));
    }
    if (request.method === 'GET' && url.pathname === '/api/customer-orders') {
      const messagingStore = await readMessagingStore();
      // Đơn chatbot (nằm trong hội thoại) và đơn landing page (kho riêng) cùng
      // một danh sách, cùng đi vào bảng Đơn hàng.
      const items = [
        ...messagingStore.conversations.flatMap(conversation =>
          (Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []).map(order => ({
            ...order,
            conversationId: conversation.id,
            conversationName: conversation.name || ''
          }))
        ),
        ...await listLandingOrders()
      ].sort((first, second) => (Number(second.createdAt) || 0) - (Number(first.createdAt) || 0));
      // Cảnh báo số điện thoại tính lại từ cache theo ngưỡng hiện hành (mức ghim
      // lúc tạo đơn có thể đã cũ), rồi dựng ghi chú xử lý (thiếu gì, tự điền gì,
      // số cần gọi...) cho cột Ghi chú của bảng Đơn hàng.
      const withNotes = [];
      for (const order of items) {
        const fresh = await cachedPhoneWarning(order.phone);
        const phoneWarning = fresh ? (fresh.level === 'none' && !fresh.hint ? undefined : fresh) : order.phoneWarning;
        // Ghi chú trả về chỉ còn lời khách; các mẩu máy từng chèn (nguồn, chiến dịch) bị bỏ.
        const refreshed = { ...order, phoneWarning, note: customerNote(order) };
        withNotes.push({ ...refreshed, processingNotes: processingNotes(refreshed) });
      }
      return sendJson(response, 200, { items: withNotes, total: withNotes.length });
    }
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
    // The export preview and the file come from the same function, so what
    // staff see on screen is exactly what the warehouse receives.
    if (request.method === 'POST' && url.pathname === '/api/orders/export/preview') {
      const payload = await readBody(request);
      if (!payload.orderData || !Array.isArray(payload.orderData.headers) || !Array.isArray(payload.orderData.rows)) {
        return sendJson(response, 400, { error: 'Dữ liệu đơn hàng không hợp lệ.' });
      }
      const rows = buildExportRows(payload.orderData);
      // `streets`: phần đường phố cho cột Địa chỉ của bảng xem trước; file vẫn đủ.
      // `locationCheck`: đơn nào ba cấp chưa đúng danh mục kho, để chặn xuất.
      return sendJson(response, 200, { rows, streets: exportPreviewStreets(rows), locationCheck: rows.locationCheck });
    }
    // Nút Export ở Nhập dữ liệu: tải đúng các cột/dòng đang hiển thị thành XLSX
    // thuần — không qua mẫu kho, không kiểm địa chỉ, không ghi lịch sử xuất kho.
    if (request.method === 'POST' && url.pathname === '/api/orders/export-table') {
      const payload = await readBody(request, 16 * 1024 * 1024);
      const headers = Array.isArray(payload.headers) ? payload.headers.map(item => String(item ?? '')) : [];
      const rows = Array.isArray(payload.rows) ? payload.rows.filter(Array.isArray).slice(0, 20000) : [];
      if (!headers.length || !rows.length) return sendJson(response, 400, { error: 'Bảng đang trống, không có gì để xuất.' });
      const fileName = String(payload.fileName || '').replace(/[^A-Za-z0-9._-]/g, '') || `nhap-du-lieu-${new Date().toISOString().slice(0, 10)}.xlsx`;
      return sendBinary(response, 200, buildPlainXlsx(headers, rows, { sheetName: 'Nhập dữ liệu' }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName);
    }
    if (request.method === 'POST' && url.pathname === '/api/orders/export') {
      const payload = await readBody(request);
      if (!payload.orderData || !Array.isArray(payload.orderData.headers) || !Array.isArray(payload.orderData.rows)) {
        throw new Error('Dữ liệu đơn hàng xuất không hợp lệ. Vui lòng tải lại trang và thử lại.');
      }
      const skipInvalidLocations = payload.skipInvalidLocations === true;
      const rows = buildExportRows(payload.orderData, { skipInvalidLocations });
      // Kho nhận file theo ba cột tỉnh/quận/phường: đơn nào chưa đúng danh mục
      // thì không xuất, trừ khi nhân viên chọn xuất bỏ qua các đơn đó.
      if (!skipInvalidLocations && rows.locationCheck.invalid.length) {
        return sendJson(response, 409, {
          error: `${rows.locationCheck.invalid.length} đơn có tỉnh/quận/phường chưa đúng danh mục kho. Sửa ở Xử lý dữ liệu hoặc xuất bỏ qua các đơn này.`,
          locationCheck: rows.locationCheck
        });
      }
      if (!rows.length) return sendJson(response, 400, { error: 'Không còn đơn nào đủ điều kiện xuất.' });
      // Khách của các đơn vừa xuất kho vào tệp khách hàng để màn Khách hàng chăm sóc lại.
      await recordExportedOrders(exportedOrderData(payload.orderData, rows));
      // Mẫu XLSX là file tĩnh: đọc một lần, lần xuất sau dùng lại buffer.
      exportTemplateBuffer ||= await readFile(exportTemplatePath);
      const workbook = new AdmZip(exportTemplateBuffer);
      const worksheetPath = 'xl/worksheets/sheet1.xml';
      const cleanedWorkbook = removeDataRowBackgrounds(workbook, worksheetPath);
      let worksheetXml = cleanedWorkbook.worksheetXml;
      rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
        worksheetXml = writeTemplateCell(worksheetXml, `${excelColumnName(columnIndex)}${rowIndex + 4}`, value);
      }));
      workbook.updateFile('xl/styles.xml', Buffer.from(cleanedWorkbook.stylesXml, 'utf8'));
      workbook.updateFile(worksheetPath, Buffer.from(worksheetXml, 'utf8'));
      const output = workbook.toBuffer();
      const fileName = String(payload.fileName || '').replace(/[^A-Za-z0-9._-]/g, '') || `don-hang-${new Date().toISOString().slice(0, 10)}.xlsx`;
      // Lịch sử xuất (14 ngày): ngày đơn đã chọn, số đơn (dòng có STT), số dòng, tệp để tải lại.
      await recordExport({
        day: String(payload.exportDay || ''),
        orders: new Set(rows.map(row => String(row[0] || '')).filter(Boolean)).size,
        rows: rows.length,
        skippedInvalid: skipInvalidLocations ? rows.locationCheck.invalid.length : 0,
        fileName,
        buffer: output
      }).catch(error => console.error(`Không ghi được lịch sử xuất: ${error.message}`));
      return sendBinary(response, 200, output, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName);
    }
    // Số điện thoại đã có trong tệp khách hàng (đơn đã xuất kho) kèm mã và ngày
    // các đơn: bảng Nhập dữ liệu dùng để gắn "Khách hàng cũ" và trùng đơn 7 ngày.
    if (request.method === 'GET' && url.pathname === '/api/customer-file/phones') {
      const phones = {};
      for (const person of await listExportedCustomers()) {
        const key = customerPhoneKey(person.phone);
        if (!key) continue;
        phones[key] = {
          lastExportedAt: Number(person.lastExportedAt) || 0,
          orders: person.orders.map(order => ({ id: String(order.id || ''), orderedAt: Number(order.orderedAt) || Number(order.exportedAt) || 0 }))
        };
      }
      return sendJson(response, 200, { phones });
    }
    if (request.method === 'GET' && url.pathname === '/api/orders/export/history') {
      return sendJson(response, 200, { items: await listExports() });
    }
    const exportFileMatch = url.pathname.match(/^\/api\/orders\/export\/history\/([A-Za-z0-9-]+)\/file$/);
    if (request.method === 'GET' && exportFileMatch) {
      const file = await readExportFile(exportFileMatch[1]);
      if (!file) return sendJson(response, 404, { error: 'Tệp xuất này không còn (lịch sử giữ 14 ngày).' });
      return sendBinary(response, 200, file.buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', file.fileName);
    }
    if(request.method==='GET') return serveFile(request,response,url.pathname);
    sendJson(response,404,{error:'Route not found.'});
  } catch (error) {
    // Header đã gửi rồi (route CSV, SSE) thì không đổi sang JSON lỗi được nữa:
    // gọi writeHead lần hai ném ERR_HTTP_HEADERS_SENT NGAY TRONG khối catch
    // này, thành promise bị reject mà không ai bắt, và Node 22 kết thúc cả
    // tiến trình. Đóng kết nối là đường thoát duy nhất còn lại.
    if (response.headersSent) return response.destroy();
    // Lỗi hệ thống (hết đĩa, EACCES, ENOENT, mạng đứt) không phải lỗi người
    // dùng: trả 400 kèm nguyên văn thông báo vừa nói sai vừa lộ đường dẫn nội
    // bộ ra ngoài, mà giám sát thì không bao giờ thấy 5xx để báo động.
    if (error?.code && typeof error.code === 'string') {
      console.error(`Lỗi hệ thống khi xử lý ${request.method} ${request.url}:`, error);
      return sendJson(response, 500, { error: 'Máy chủ gặp lỗi khi xử lý yêu cầu.' });
    }
    sendJson(response, 400, { error: error.message });
  }
});

// Một socket khách đứt giữa chừng (hay gặp nhất ở luồng SSE) làm response phát
// 'error' bất đồng bộ; không ai nghe thì Node 22 giết cả tiến trình, tức mất
// CRM của mọi người vì một trình duyệt đóng tab. Ghi log rồi chạy tiếp.
process.on('unhandledRejection', error => console.error('Promise bị bỏ rơi:', error));
// Lỗi không ai bắt thì trạng thái tiến trình không còn tin được nữa: ghi lại
// cho có dấu vết rồi thoát để systemd dựng lại bản sạch (unit đặt Restart).
process.on('uncaughtException', error => {
  console.error('Lỗi không ai bắt, thoát để khởi động lại:', error);
  process.exit(1);
});
server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  else socket.destroy();
});

server.listen(serverConfig.port, serverConfig.host, () => {
  console.log(`CRM running at http://${serverConfig.host}:${serverConfig.port}/`);
  // Đơn landing từ mọi trang Webcake (kể cả đơn bỏ dở) được kéo từ POS mỗi 5 phút.
  if (!process.env.POS_SYNC_DISABLED) startPosSync({ onCrmOrdersCancelled: cancelCrmOrdersCancelledOnPos, onPosConversationOrders: importPosConversationOrders });
  // Kênh Pancake: kéo lịch sử lúc khởi động và định kỳ, phòng lọt tin khi webhook gián đoạn.
  startPancakeSync();
  // Bám đuổi: kịch bản nền (khách im lặng sau khi Page trả lời → gửi ưu đãi), mỗi 15 phút.
  startFollowUpLoop({ readSettings: readChatbotSettings, sendMessage: sendConversationMessage, conversationInfo: followUpConversationInfo });
  console.log(`Meta webhook callback URL: ${metaConfig.webhookUrl}`);
  const missing = missingWebhookConfiguration();
  if (missing.length) console.log(`Webhook chưa sẵn sàng, còn thiếu: ${missing.join(', ')}`);
});
