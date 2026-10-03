import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { buildExportRows, exportFactsForOrders, exportPreviewStreets, exportedOrderData } from './order-export.mjs';
import { listAllSystemOrders, reserveOrderIdInStore, takenOrderIds, uniqueOrderId } from './order-lookup.mjs';
import { parseXlsx } from './xlsx-import.mjs';
import { buildPlainXlsx } from './xlsx-export.mjs';
import { fillTemplateSheet } from './xlsx-template.mjs';
import { readJsonFile, writeJsonAtomic } from './json-store.mjs';
import { auditFiltersFrom, canReadAudit, contentEtag, conversationOrdersFingerprint, etagMatches, createSeenOnce, fileVersionStamp, friendlyAdsError, friendlyAdsStatus, friendlyAiTestError, friendlyCampaignInsights, createStaffNoteWriter, hasStaffSession, pancakeWebhookDecision, publicNoticePage, purchaseLabelFingerprint, qrVisitorKey, staticCacheControl } from './server-helpers.mjs';
import { getSpxTracking } from './spx-tracking.mjs';
import { friendlyClientError, vnDateStamp } from './request-errors.mjs';
import { buildOrderReceiptPayload, isLivestreamCustomer, normalizeChatbotOrder, normalizeCustomerOrder, applyPurchaseLabels } from './conversation-orders.mjs';
import { backfillPurchaseLabels } from './purchase-labels.mjs';
import { applyPhoneLabels, messageHasPhone } from './phone-labels.mjs';
import { renderOrderReceiptImage } from './order-receipt-image.mjs';
import { aiKeyReentryError, assertUsableAiEndpoint, defaultChatbotSettings, mergeChatbotSettingsPatch, mergeMessageTemplatesPatch, normalizeChatbotSettings, publicChatbotSettings } from './chatbot-settings.mjs';
import { assertPublicHost, isSafeRequestTarget } from './network-guard.mjs';
import { processChatbotChanges, requestDirectModelReply, warmUpChatbotModels } from './chatbot-engine.mjs';
import { configureAddressAi } from './processing/address-ai.mjs';
import { loadCampaignReport, normalizeRangeDays } from './campaigns.mjs';
import { loadDashboard, normalizeDashboardCustomRange, normalizeDashboardDays } from './dashboard.mjs';
import { loadReport, normalizeReportSection, reportCsvFileName, reportSectionCsv } from './reports.mjs';
import { larkReportConfig, normalizeLarkConversationReport, sendLarkConversationReport, startLarkReportScheduler } from './lark-report.mjs';
import { startAdInsightsSync, syncAdInsights } from './meta-ads.mjs';
import { configureCampaignAi, generateCampaignInsights, readCampaignInsights } from './campaign-ai.mjs';
import { applyHonorific, defaultMessageTemplates, honorific, publicImageUrl, spin, splitMessages } from './chatbot-templates.mjs';
import { assertUniqueSku, maximumGalleryImages, normalizeGallery, normalizeProduct, normalizeProductStore } from './products.mjs';
import { comboKey, getCatalogProducts, getGifts, getShippingFee, normalizeGift, normalizeGiftStore, reloadCatalog } from './processing/catalog.mjs';
import { priceBasket } from './processing/pricing.mjs';
import { listPipelineSteps, readPipelineStep } from './processing/pipeline.mjs';
import { deleteLandingOrder, isLandingTokenValid, landingTokenFrom, listLandingOrders, listRecentLandingPayloads, parseLandingBody, readLandingStore, recordLandingOrder, updateLandingStore } from './landing-orders.mjs';
import { attachPhoneWarning, cachedPhoneWarning, connectPos, disconnectPos, fetchPosPhoneReport, lookupPhones, normalizeWarningPhone, posConfig, posConfigured, posRequest, posStatus, toLocalPhoneLoose } from './phone-warnings.mjs';
import { posSyncStatus, recordPosSyncStatus, startPosSync, syncPosLandingOrders } from './pos-sync.mjs';
import { applyPosContentToConversations, finalizePosImportedOrder, isDeletedPosOrder, posGoodsItems, rememberDeletedPosOrder, repairPosImportedTotal } from './pos-content-sync.mjs';
import { applyGiftSwapFlag, cancelPosOrder, findExistingPosOrder, isCrmOwnedPosOrder, isCrmPushedPosOrder, pushOrderToPos, syncOrderToPos, updatePosOrder, updatePosOrderNote } from './pos-orders.mjs';
import { goldenSetOverview, importGoldenItems, labelGoldenItem } from './golden-set.mjs';
import { applyShipmentLabels, isQuietHourVN, listShipmentNoticeQueue, readSapoSettings, readSapoState, recordShipmentNoticeResult, startSapoSync, writeSapoSettings } from './sapo-sync.mjs';
import { isSapoConfigured } from './sapo.mjs';
import { buildFollowUpBatch, followUpGender, followUpRelayErrorText, followUpStatus, markFollowUpWins, pruneReturningFromQueue, recordFollowUpBatchResults, releaseFollowUpLeases, resetFollowUpActivation, resolveFollowUpQueueItem, runFollowUps, startFollowUpLoop } from './follow-up.mjs';
import { customerNote } from './order-notes.mjs';
import { applyCustomerOrderEdits, applyPosRepush, assertManualOrderMoney, createManualOrderGuard, describeOrderEdits, duplicateManualOrderMessage, isLiveOnPos, moneyText, needsPosRepush, orderEditAction, orderProcessingNotes, posCancelRefOf, posRepushDraft, recordOrderHistory, stampOrderCreated } from './order-edits.mjs';
import { AUDIT_ACTIONS, AUTOMATED_ACTORS, appendAudit, appendBotToggleAudit, appendLabelAudit, auditActionLabel, auditActors, createViewThrottle, labelChangeDetails, labelChangeText, queryAudit } from './audit-log.mjs';
import { BOT_ACTOR, actorOf, actorStamp, clearActorCache, clientIp, createRequireManager, isManager } from './request-actor.mjs';
import { HTML_CSP, LOGIN_SETUP_MESSAGE, allowedWithoutLoginSetup, applySecurityHeaders, createLogLimiter, debugFlagOn, installConsoleRedaction, loginGate, loginSetupPage, safeNextPath } from './security.mjs';
import { appendOrderToArchive, readOrderArchive } from './order-archive.mjs';
import { customerPhoneKey, listExportedCustomers, recordExportedOrders } from './customer-file.mjs';
import { listExports, readExportFile, recordExport } from './export-history.mjs';
import { brandImageFiles, describePancakePayload, fetchPancakeConversationInfo, fetchPancakeMessages, getPancakePageConfig, handlePancakeWebhook, isPancakeConfigured, isPancakeWebhookTokenValid, pancakeSyncStatusFor, pancakeTime, startPancakeSync, syncPancakeConversations } from './pancake.mjs';
import { countQrReferrals, countQrReferralsByDay, deleteQrCode, isValidQrCode, listQrScans, qrDayKey, recordQrOpen, recordQrScan, registerQrCode } from './qr-scans.mjs';
import { classifyUserAgent, iosMajorVersion, isLinkPreviewBot, messengerDestination, prefillMessageFor, prefillTemplateOrDefault, renderBridgePage } from './qr-bridge.mjs';
import { createBridgeClickMatcher, createLinkRoutedQrFlow, createQrGreeter, createThreadReleaser, isCardScan, lastStaffMessageAt, resolveQrOfferTemplate, withOfferCardImage } from './qr-greeting.mjs';
// Riêng cho luồng QR (vòng 13): ghi referral thẻ lên hội thoại khớp lượt bấm, ghi nốt kho sau lượt chào lúc tắt.
import { attachReferral as attachQrReferral } from './meta-webhook.mjs';
import { flushMessagingStore as flushMessagingStoreForQr } from './messaging-store.mjs';
import { qrTargetUrl, renderQrPng, renderQrSvg } from './qr-image.mjs';
import { readQrSettings, writeQrSettings } from './qr-settings.mjs';
import {
  isMetaConfigured,
  isWebhookConfigured,
  landingConfig,
  metaConfig,
  missingMetaConfiguration,
  missingWebhookConfiguration,
  projectRoot,
  serverConfig, pancakeConfig, isReferralOnlyPage, subscriptionFieldsFor, authConfig } from './config.mjs';
import { createAuth, isPublicPath, parseUsers } from './auth.mjs';
import { listStaff, saveStaffMember, staffByUsername, staffLoginAccounts, STAFF_ROLES } from './staff.mjs';
import { decryptToken, encryptToken, getPageAccessToken, publicChannel, readChannelStore, writeChannelStore } from './channel-store.mjs';
import { fetchPageSubscription, metaRequest, releaseThreadControl, sendSenderAction, subscribePageToApp, unsubscribePageFromApp } from './meta-graph.mjs';
import { processWebhookPayload, refreshCustomerProfiles, verifyWebhookSignature, verifyWebhookSubscription } from './meta-webhook.mjs';
import { archiveStatusLabel, customersToCsv, customersToAudienceCsv, findCustomerById, invalidateBuyersCache, listCustomers, orderHistoryKey } from './customers.mjs';
import { addCustomerNote, listCustomerNotes, setCustomerLabels, updateCustomerProfile } from './customer-edits.mjs';
import { defaultConversationLabels, labelsForEvents, listLabelIcons, readInboxSettings, writeInboxSettings } from './inbox-settings.mjs';
import { moderateComment, sendConversationMessage, syncPageConversations } from './meta-sync.mjs';
import { publishMessagingEvent, subscribeToMessagingEvents } from './message-events.mjs';
import {
  getConversation,
  installMessagingStoreShutdownFlush,
  listConversations,
  listMessages,
  markConversationSeen,
  publicConversation,
  readMessagingStore,
  setConversationFlags,
  updateMessagingStore
} from './messaging-store.mjs';

// Mọi dòng log của tiến trình (cả các mô-đun khác) che token/khóa trong URL: access_token=***.
installConsoleRedaction(console);

const root = projectRoot;
const webRoot = path.join(root, 'web');
// R13 (L12): ba kho này trước đây cố định dưới data/processed dù catalog.mjs / campaign-ai.mjs đã đọc theo biến môi
// trường — test tích hợp (và bản chạy thử cô lập) đặt *_PATH về thư mục tạm thì máy chủ vẫn ghi vào kho thật.
const chatbotSettingsPath = process.env.CHATBOT_SETTINGS_PATH || path.join(root, 'data', 'processed', 'chatbot-settings.json');
const productsPath = process.env.PRODUCTS_PATH || path.join(root, 'data', 'processed', 'products.json');
const giftsPath = process.env.GIFTS_PATH || path.join(root, 'data', 'processed', 'gifts.json');
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

// Chưa có tệp → kho rỗng; JSON hỏng → cất .corrupt-* rồi kho rỗng; lỗi đọc tạm (EBUSY, EACCES…) → NÉM.
// Trước 01/10 mọi lỗi đọc thành "kho rỗng" và lần lưu sản phẩm kế tiếp ghi đè mất cả danh mục.
async function readProductStore() {
  return readJsonFile(productsPath, { fallback: () => ({ items: [], updatedAt: 0 }), normalize: normalizeProductStore, label: 'Kho sản phẩm' });
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
  await writeJsonAtomic(productsPath, normalized);
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
  return readJsonFile(giftsPath, { fallback: () => ({ items: [], updatedAt: 0 }), normalize: normalizeGiftStore, label: 'Kho quà tặng' });
}

async function writeGiftStore(store) {
  const normalized = normalizeGiftStore(store);
  normalized.updatedAt = Date.now();
  await writeJsonAtomic(giftsPath, normalized);
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

/** Đồng bộ quảng cáo lỗi: chủ shop thấy câu dễ hiểu; tên biến .env, mã lỗi Graph… chỉ vào nhật ký máy chủ. */
function sendAdsSyncError(response, days, error) {
  console.error(`Đồng bộ quảng cáo (${days} ngày) lỗi: ${error?.message || error}`);
  return sendJson(response, 502, { error: friendlyAdsError(error) });
}

/**
 * Như sendJson(200) nhưng có ETag theo nội dung: trình duyệt hỏi lại (If-None-Match) mà không có gì đổi thì
 * trả 304 — khỏi tải lại 1–2 MB và parse ở trình duyệt. `private, no-cache`: chỉ trình duyệt của người đang
 * đăng nhập giữ bản sao và luôn hỏi lại máy chủ trước khi dùng.
 */
function sendJsonWithEtag(request, response, value) {
  const body = JSON.stringify(value);
  const etag = contentEtag(body);
  const headers = { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'private, no-cache', ETag: etag };
  if (etagMatches(request.headers['if-none-match'], etag)) {
    response.writeHead(304, headers);
    return response.end();
  }
  response.writeHead(200, headers);
  return response.end(body);
}

function publicCustomerPanel(conversation) {
  return {
    notes: Array.isArray(conversation?.customerNotes) ? conversation.customerNotes : [],
    orders: Array.isArray(conversation?.customerOrders) ? conversation.customerOrders : [],
    botEnabled: conversation?.botEnabled !== false,
    // Ai bật/tắt bot gần nhất { username, name, at, enabled } (null khi chưa ai bấm từ khi có nhật ký).
    botChangedBy: conversation?.botChangedBy || null,
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
// R13 (M1): đơn nhân viên tạo tay cũng có chốt trùng (2 phút, cùng hội thoại + SĐT + giỏ + tổng; `force:true` để vẫn tạo).
const manualOrderGuard = createManualOrderGuard();

/**
 * Đơn nhân viên tạo tay từ form (POST …/customer-panel {type:'order'}): chuẩn hoá + kiểm, đặt mã, chống trùng.
 * Trả { order } (đã giữ chỗ trong manualOrderGuard — nơi gọi phải release khi lưu xong hay lỗi) hoặc
 * { reject: { status, body } }.
 * - L3: `order: null` / không phải object → 400 câu tiếng Việt (trước đây lộ "Cannot read properties of null");
 *   tổng 0đ và giảm giá lớn hơn tiền hàng bị chặn.
 * - M1: cùng hội thoại + SĐT + giỏ + tổng trong 2 phút → 409 kèm mã đơn cũ (bấm đúp từng ra 2 đơn CRM + 2 đơn POS);
 *   `force: true` để vẫn tạo. Kiểm và giữ chỗ liền nhau (không await ở giữa) để hai request sát nhau không cùng lọt.
 */
async function draftManualOrder(conversationId, payload, assignId) {
  let order;
  try {
    order = normalizeCustomerOrder(payload.order && typeof payload.order === 'object' && !Array.isArray(payload.order) ? payload.order : {});
    assertManualOrderMoney(order);
  } catch (error) {
    return { reject: { status: 400, body: { error: error.message } } };
  }
  // Mã đơn duy nhất do nơi gọi đặt (uniqueOrderId + takenOrderIds, xem route).
  await assignId(order);
  const currentOrders = (await getConversation(conversationId))?.customerOrders;
  const duplicate = payload.force === true ? null : manualOrderGuard.find(conversationId, currentOrders, order);
  if (duplicate) {
    return { reject: { status: 409, body: { error: duplicateManualOrderMessage(duplicate), duplicate: true, duplicateOrderId: duplicate.id, duplicateCreatedAt: duplicate.createdAt } } };
  }
  manualOrderGuard.reserve(conversationId, order);
  return { order, release: () => manualOrderGuard.release(conversationId, order) };
}
// Khóa giỏ của đơn để chống trùng: comboKey (SKU=số lượng), dòng không SKU thì theo tên.
function basketKeyOf(order) {
  const products = Array.isArray(order?.products) ? order.products : [];
  return comboKey(products.map(item => ({ sku: item.sku || item.name, quantity: item.quantity }))) || '';
}

async function createChatbotCustomerOrder(conversation, input, context = {}) {
  const sourceMessageId = String(context.sourceMessageId || '').trim();
  const order = normalizeChatbotOrder(input, conversation, context);
  // Số điện thoại hay bom hàng: đơn vẫn được tạo (khách đã xác nhận) nhưng
  // mang cảnh báo để nhân viên gọi lại trước khi giao.
  await attachPhoneWarning(order);
  // Thẻ "Đã mua hàng" gắn ngay lúc lưu đơn (01/10): trước đây chỉ gắn sau khi bot gửi xong tin xác
  // nhận, gửi lỗi (Pancake hết giờ chờ…) là đơn có mà hội thoại không có thẻ.
  const labelDefs = (await readInboxSettings().catch(() => ({ labels: [] }))).labels;
  const orderLabels = labelsForEvents(labelDefs, ['order']);
  let labelChange = null;
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
        // Cùng giỏ (SKU + số lượng): 2 Xanh và Xanh + Vàng cùng 298k là hai đơn khác nhau.
        && basketKeyOf(entry) === basketKeyOf(order)
        && order.createdAt - (Number(entry.createdAt) || 0) < duplicateChatbotOrderWindowMs);
    if (existing) return { order: existing, created: false };
    item.customerOrders.unshift(order);
    item.customerOrders = item.customerOrders.slice(0, 200);
    const before = Array.isArray(item.labels) ? [...item.labels] : [];
    if (applyPurchaseLabels(item, order, orderLabels)) labelChange = { conversation: { id: item.id, name: item.name || '' }, before, after: [...item.labels], published: publicConversation(item) };
    return { order, created: true };
  });
  if (!result) throw new Error('Không tìm thấy hội thoại để tự tạo đơn.');
  if (labelChange) {
    const { published, ...change } = labelChange;
    appendLabelAudit({ actor: AUTOMATED_ACTORS.bot, ...change, labelDefs, reason: 'bot: chốt đơn' });
    publishMessagingEvent({ type: 'conversation', conversation: published });
  }
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
  const keep = new Set(['id', 'createdAt', 'pos', 'chatbotSourceMessageId', 'delivery', 'processingStatus', 'hiddenFromTable', 'staffNote', 'employee', 'automatic', 'createdBy', 'history', 'updatedBy']);
  const stamp = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  const result = await updateMessagingStore(store => {
    const item = store.conversations.find(entry => entry.id === conversation.id);
    const existing = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => String(entry.id) === String(orderId));
    if (!existing) return null;
    for (const [key, value] of Object.entries(fresh)) if (!keep.has(key)) existing[key] = value;
    // Giỏ mới không còn quà bám đuổi / không còn là 1 túi dùng thử: bỏ cờ cũ (không thì đơn 1 túi vẫn mang quà BGD sang POS).
    for (const key of ['promoGift', 'trialFreeShip']) if (!(key in fresh)) delete existing[key];
    // Giữ lại lời khách dặn trước đó ("Khách dặn: gửi hàng mới.") khi sửa giỏ.
    const requests = String(existing.note || '').match(/Khách dặn: [^.]*\./g) || [];
    existing.note = [`Tạo tự động từ xác nhận của chatbot. Khách sửa đơn lúc ${stamp}.`, ...requests].join(' ');
    existing.updatedAt = Date.now();
    recordOrderHistory(existing, { by: BOT_ACTOR, action: 'order.update', summary: 'Khách sửa đơn qua chatbot.' });
    return { order: existing };
  });
  if (!result) throw new Error('Không tìm thấy đơn để sửa.');
  publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id });
  await appendOrderToArchive(result.order).catch(() => {});
  if (result.order.pos?.id) {
    // R13 (gộp): quà thay thế (đơn đổi quà) không lên được POS ở lần sửa này → ghi chú xử lý cho nhân viên như đường tạo
    // đơn (syncOrderToPos); sửa xong mà không còn thiếu thì gỡ ghi chú đổi quà cũ. PUT lỗi: giữ nguyên ghi chú đang có.
    let giftSwapMissing = null;
    const posOutcome = await updatePosOrder(result.order, { conversation })
      .then(updated => { giftSwapMissing = updated?.giftSwapMissing || []; return { ...result.order.pos, updatedAt: Date.now(), error: undefined }; })
      .catch(error => ({ ...result.order.pos, updatedAt: Date.now(), error: `Sửa trên POS lỗi: ${error.message}` }));
    await updateMessagingStore(store => {
      const item = store.conversations.find(entry => entry.id === conversation.id);
      const target = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => String(entry.id) === String(orderId));
      if (target) target.pos = posOutcome;
      if (target && giftSwapMissing) applyGiftSwapFlag(target, giftSwapMissing);
      return null;
    });
    result.order.pos = posOutcome;
    if (giftSwapMissing) applyGiftSwapFlag(result.order, giftSwapMissing);
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
    recordOrderHistory(existing, { by: BOT_ACTOR, action: 'order.update', summary: `Khách dặn thêm qua chatbot: ${text}`.slice(0, 200) });
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
  const stamp = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  const result = await updateMessagingStore(store => {
    const item = store.conversations.find(entry => entry.id === conversation.id);
    const existing = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => String(entry.id) === String(orderId));
    if (!existing) return null;
    existing.processingStatus = 'cancelled';
    existing.status = 'Hủy';
    existing.note = `${String(existing.note || '').trim()} Khách hủy đơn qua chatbot lúc ${stamp}.`.trim();
    existing.updatedAt = Date.now();
    recordOrderHistory(existing, { by: BOT_ACTOR, action: 'order.cancel', summary: 'Khách hủy đơn qua chatbot.' });
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
/** Mẫu tin vận đơn đang dùng (Cài đặt → Tin nhắn, đã gộp mẫu mặc định). */
async function shipmentTemplates() {
  return (await readChatbotSettings().catch(() => null))?.messageTemplates || {};
}

/** Hàng chờ báo khách vận đơn (trang Vận chuyển). */
async function shipmentNoticeQueue(now = Date.now()) {
  return listShipmentNoticeQueue(await readMessagingStore(), { now, templates: await shipmentTemplates(), genderOf: followUpGender });
}

/** Thẻ CRM cho sự kiện vận đơn: "Đã gửi mã vận đơn" (shipment-sent), "Giao hàng thành công" (delivered). */
async function shipmentLabelIds() {
  const labelDefs = (await readInboxSettings().catch(() => ({ labels: [] }))).labels;
  return { sent: labelsForEvents(labelDefs, ['shipment-sent']), delivered: labelsForEvents(labelDefs, ['delivered']), labelDefs };
}

/** Ghi nhật ký + báo hộp thư cho các thay đổi thẻ do vận đơn. */
async function publishShipmentLabelChanges(changes, labelDefs = null) {
  const defs = labelDefs || (await shipmentLabelIds()).labelDefs;
  const store = await readMessagingStore();
  for (const { reason, ...change } of changes) {
    appendLabelAudit({ actor: AUTOMATED_ACTORS.system, ...change, labelDefs: defs, reason });
    const conversation = (store.conversations || []).find(item => item.id === change.conversation.id);
    if (conversation) publishMessagingEvent({ type: 'conversation', conversation: publicConversation(conversation) });
  }
}

async function saveShipmentNoticeResults(results, now = Date.now()) {
  const touched = new Set();
  const labels = await shipmentLabelIds();
  let saved = 0;
  let labelChanges = [];
  await updateMessagingStore(store => {
    for (const result of results) {
      if (recordShipmentNoticeResult(store, result.key, { ok: result.ok === true, via: result.via, error: result.error, now })) {
        saved += 1;
        touched.add(String(result.key).split('|')[0]);
      }
    }
    // Nhân viên vừa gửi mã qua Pancake / gửi tay: gắn thẻ "Đã gửi mã vận đơn" ngay.
    if (saved) labelChanges = applyShipmentLabels(store, { sentLabels: labels.sent, deliveredLabels: labels.delivered });
    return null;
  }, { unchanged: () => saved === 0 });
  for (const conversationId of touched) publishMessagingEvent({ type: 'customer-panel', conversationId });
  if (labelChanges.length) await publishShipmentLabelChanges(labelChanges, labels.labelDefs);
  return saved;
}

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

const shouldLogSkippedPosOrder = createSeenOnce(2000);
// R13-fix (L3): hai request "Đẩy POS" sát nhau dùng chung một lượt đẩy → chỉ ghi lịch sử một lần cho mỗi (đơn, mã POS).
const shouldLogPosPush = createSeenOnce(500);
async function importPosConversationOrders(posOrders) {
  const drafts = [];
  for (const posOrder of Array.isArray(posOrders) ? posOrders : []) {
    const address = posOrder.shipping_address || {};
    // R13 (C1): dòng mã quà (BGD, MUONG, quạt/quà live…) nhân viên thêm như dòng thường KHÔNG phải tiền hàng.
    const lines = posGoodsItems(posOrder);
    // POS hay lưu SĐT mất số 0 đầu ("912345678") hoặc dạng 0084…: chuẩn hoá trước khi kiểm, kẻo đơn bị bỏ.
    const rawPhone = String(posOrder.bill_phone_number || address.phone_number || '');
    try {
      const order = normalizeCustomerOrder({
        id: `pos${posOrder.system_id || posOrder.id}`,
        name: posOrder.bill_full_name || address.full_name || 'Khách Facebook',
        phone: toLocalPhoneLoose(rawPhone) || rawPhone,
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
      // R13 (C1 + T4): tổng = tiền POS thực thu (thu hộ + chuyển khoản) khi POS có ghi; quà hiển thị là quà.
      finalizePosImportedOrder(order, posOrder);
      drafts.push({
        conversationKey: String(posOrder.conversation_id),
        posOrder,
        order: {
          ...order,
          createdAt: Date.parse(`${String(posOrder.inserted_at || '').replace(/Z?$/, 'Z')}`) || Date.now(),
          automatic: false,
          employee: posOrder.creator?.name || posOrder.assigning_seller?.name || posOrder.account_name || '',
          pos: { id: String(posOrder.id), systemId: String(posOrder.system_id || ''), status: String(posOrder.status_name || ''), importedAt: Date.now() },
          // Dòng tặng trên POS (mã + số lượng) để file xuất kho ghi đủ quà như POS: `giftItems` do finalizePosImportedOrder đặt.
          ...(Number(posOrder.status) === 6 ? { processingStatus: 'cancelled' } : {})
        }
      });
    } catch (error) {
      // Đơn thiếu SĐT/địa chỉ/sản phẩm (đơn nháp trên POS), hay SĐT dạng lạ (912…, 0084…): bỏ qua nhưng
      // ghi log (mỗi đơn một lần — đồng bộ 5 phút/lần kéo lại cùng cửa sổ 48 giờ), để còn biết đơn nào bị bỏ.
      const posKey = String(posOrder?.system_id || posOrder?.id || '?');
      if (shouldLogSkippedPosOrder(posKey)) console.warn(`Đồng bộ POS: bỏ qua đơn POS ${posKey} của hội thoại ${posOrder?.conversation_id || '?'}: ${error?.message || error}`);
    }
  }
  if (!drafts.length) return 0;
  let created = 0;
  const touched = new Set();
  // Thẻ "Đã mua hàng" cho hội thoại có đơn POS chưa hủy (đơn mới, và đơn đã kéo về trước đây mà chưa gắn).
  const labelDefs = (await readInboxSettings().catch(() => ({ labels: [] }))).labels;
  const orderLabels = labelsForEvents(labelDefs, ['order']);
  const relabeled = [];
  // Lịch sử thẻ của hội thoại: thẻ do đồng bộ POS tự gắn cũng vào nhật ký (người làm 'system').
  const labelChanges = [];
  const relabel = (conversation, order) => {
    const before = Array.isArray(conversation.labels) ? [...conversation.labels] : [];
    if (!applyPurchaseLabels(conversation, order, orderLabels)) return;
    relabeled.push(publicConversation(conversation));
    labelChanges.push({ conversation: { id: conversation.id, name: conversation.name || '' }, before, after: [...conversation.labels] });
  };
  // Đồng bộ 5 phút/lần luôn thấy lại các đơn POS 48 giờ qua: không đổi gì (kể cả cờ im lặng như
  // purchaseLabeled, khởi tạo customerOrders) thì không ghi lại cả kho ~19 MB.
  let dirty = false;
  await updateMessagingStore(store => {
    const byPancakeId = new Map(store.conversations.filter(item => item.pancakeConversationId && item.source !== 'comment').map(item => [String(item.pancakeConversationId), item]));
    const affected = [...new Set(drafts.map(draft => byPancakeId.get(draft.conversationKey)).filter(Boolean))];
    const fingerprintBefore = conversationOrdersFingerprint(affected);
    for (const { conversationKey, order, posOrder } of drafts) {
      const conversation = byPancakeId.get(conversationKey);
      if (!conversation) continue;
      if (!Array.isArray(conversation.customerOrders)) conversation.customerOrders = [];
      // R13-fix (C1): khớp theo mã POS (pos.id) TRƯỚC, rồi mới tới mã đơn CRM / mã hệ thống.
      const posId = String(posOrder.id);
      const existing = conversation.customerOrders.find(entry => entry.pos?.id && String(entry.pos.id) === posId)
        || conversation.customerOrders.find(entry => entry.id === order.id || (entry.pos?.systemId && entry.pos.systemId === order.pos.systemId));
      // R13-fix (T2): đơn POS này đã kéo về rồi bị nhân viên xoá trong CRM → không kéo về lại.
      if (!existing && isDeletedPosOrder(conversation, posOrder)) continue;
      if (existing) {
        // R13-fix (C1): đơn đã "Lên lại POS" (pos.id = CRM-…-L2, previousId = mã POS cũ) vẫn mang mã pos<system_id> của
        // ĐƠN POS CŨ đã hủy: đơn POS cũ không còn là đơn này — không hủy theo, không chỉnh tổng theo nó (từng bị hủy lại
        // mỗi lượt đồng bộ trong khi POS có đơn mới đang sống).
        const samePosOrder = !existing.pos?.id || String(existing.pos.id) === posId;
        if (!samePosOrder || String(existing.pos?.previousId || '') === posId) { relabel(conversation, existing); continue; }
        // Đã kéo về: chỉ theo trạng thái hủy của POS; sửa của nhân viên trong CRM giữ nguyên.
        // Đơn kéo về trước 01/10 chưa có dòng quà POS: bổ sung (file kho cần mã quà).
        if (!Array.isArray(existing.giftItems) && Array.isArray(order.giftItems)) existing.giftItems = order.giftItems;
        // R13 (C1): đơn kéo về trước bản sửa còn tổng cộng cả giá quà → chỉnh về tiền POS thực thu (một lần, có lịch sử).
        if (repairPosImportedTotal(existing, order, posOrder)) touched.add(conversation.id);
        if (order.processingStatus === 'cancelled' && existing.processingStatus !== 'cancelled') {
          Object.assign(existing, { processingStatus: 'cancelled', status: 'Hủy', updatedAt: Date.now() });
          recordOrderHistory(existing, { by: { username: 'pos', name: 'Pancake POS' }, action: 'order.cancel', summary: 'Đơn đã hủy trên Pancake POS, CRM hủy theo.' });
          touched.add(conversation.id);
        }
        relabel(conversation, existing);
        continue;
      }
      // Đơn nhân viên/Shop lên trên POS: người tạo là người lên đơn trên POS (nếu POS cho biết).
      order.createdBy = { username: 'pos', name: order.employee ? `${order.employee} (POS)` : 'Pancake POS' };
      conversation.customerOrders.unshift(order);
      conversation.customerOrders = conversation.customerOrders.slice(0, 200);
      relabel(conversation, order);
      created += 1;
      touched.add(conversation.id);
    }
    dirty = conversationOrdersFingerprint(affected) !== fingerprintBefore;
    return null;
  }, { unchanged: () => !dirty });
  for (const change of labelChanges) appendLabelAudit({ actor: AUTOMATED_ACTORS.system, ...change, labelDefs, reason: 'đồng bộ đơn POS' });
  for (const conversationId of touched) publishMessagingEvent({ type: 'customer-panel', conversationId });
  for (const conversation of relabeled) publishMessagingEvent({ type: 'conversation', conversation });
  if (relabeled.length) console.log(`Đồng bộ POS: gắn thẻ Đã mua hàng cho ${relabeled.length} hội thoại có đơn POS.`);
  if (created) markFollowUpWins().catch(() => {});
  return created;
}

/**
 * Gắn bù thẻ "Đã mua hàng" trong CRM (app/purchase-labels.mjs): đơn đã có mà chưa gắn, khách đặt qua
 * landing có nhắn Page (khớp SĐT), luồng bình luận của khách đã mua. Chạy lúc khởi động và mỗi 5 phút.
 */
async function runPurchaseLabelBackfill() {
  const labelDefs = (await readInboxSettings().catch(() => ({ labels: [] }))).labels;
  const orderLabels = labelsForEvents(labelDefs, ['order']);
  if (!orderLabels.length) return 0;
  const landingOrders = await listLandingOrders().catch(() => []);
  let changes = [];
  const relabeled = [];
  // Chạy 5 phút/lần: không gắn gì mới thì không ghi cả kho. So dấu vân tay (thẻ + mọi cờ "đã gắn")
  // chứ không chỉ changes.length: backfill còn đặt cờ im lặng (đơn đã có thẻ sẵn) cần ghi xuống đĩa.
  let dirty = false;
  await updateMessagingStore(store => {
    const fingerprintBefore = purchaseLabelFingerprint(store.conversations);
    changes = backfillPurchaseLabels(store, { orderLabels, landingOrders });
    for (const change of changes) {
      const conversation = store.conversations.find(item => item.id === change.conversation.id);
      if (conversation) relabeled.push(publicConversation(conversation));
    }
    dirty = changes.length > 0 || purchaseLabelFingerprint(store.conversations) !== fingerprintBefore;
    return null;
  }, { unchanged: () => !dirty });
  for (const { reason, ...change } of changes) appendLabelAudit({ actor: AUTOMATED_ACTORS.system, ...change, labelDefs, reason });
  for (const conversation of relabeled) publishMessagingEvent({ type: 'conversation', conversation });
  if (changes.length) console.log(`Thẻ Đã mua hàng: gắn bù cho ${changes.length} hội thoại (${[...new Set(changes.map(change => change.reason))].join('; ')}).`);
  return changes.length;
}

/**
 * Thẻ "Số điện thoại" (app/phone-labels.mjs): `conversationIds` = gắn ngay cho hội thoại vừa có tin
 * khách ghi SĐT; bỏ trống = quét bù mọi hội thoại (khởi động + mỗi 5 phút).
 */
async function runPhoneLabelPass(conversationIds = null) {
  const labelDefs = (await readInboxSettings().catch(() => ({ labels: [] }))).labels;
  const phoneLabels = labelsForEvents(labelDefs, ['phone']);
  if (!phoneLabels.length) return 0;
  let result = { changes: [], flagged: 0 };
  const relabeled = [];
  await updateMessagingStore(store => {
    result = applyPhoneLabels(store, { phoneLabels, conversationIds });
    for (const change of result.changes) {
      const conversation = store.conversations.find(item => item.id === change.conversation.id);
      if (conversation) relabeled.push(publicConversation(conversation));
    }
    return null;
  }, { defer: Boolean(conversationIds), unchanged: () => !result.flagged });
  for (const change of result.changes) appendLabelAudit({ actor: AUTOMATED_ACTORS.system, ...change, labelDefs, reason: 'khách để lại số điện thoại' });
  for (const conversation of relabeled) publishMessagingEvent({ type: 'conversation', conversation });
  if (result.changes.length && !conversationIds) console.log(`Thẻ Số điện thoại: gắn bù cho ${result.changes.length} hội thoại.`);
  return result.changes.length;
}

// Tin khách vừa về (webhook Meta/Pancake, đồng bộ Pancake) có ghi SĐT: gom 2 giây rồi gắn một lượt.
const pendingPhoneLabelIds = new Set();
let phoneLabelTimer = null;
function queuePhoneLabel(event) {
  if (event?.type !== 'message' || event.updated || !event.conversation?.id || !messageHasPhone(event.message)) return;
  pendingPhoneLabelIds.add(event.conversation.id);
  phoneLabelTimer ||= setTimeout(() => {
    phoneLabelTimer = null;
    const ids = [...pendingPhoneLabelIds];
    pendingPhoneLabelIds.clear();
    runPhoneLabelPass(ids).catch(error => console.warn(`Gắn thẻ Số điện thoại lỗi: ${error.message}`));
  }, 2000);
}

/**
 * R13 (M7): đơn nhân viên mở lại trong CRM sau khi đã hủy bên POS (`pos.needsRepush`) → tạo ĐƠN POS MỚI với mã
 * "CRM-<mã đơn>-L<n>" (POS dùng custom_id làm mã đơn; đơn cũ đã hủy giữ mã gốc), ghi mã mới lên đơn và bỏ ghi chú
 * "cần lên lại". Lỗi thì giữ nguyên cờ để bấm lại. Hai lần bấm sát nhau dùng chung một lượt đẩy.
 */
const posRepushInFlight = new Map();
function repushCancelledOrderToPos(conversation, order) {
  const key = String(order.id);
  if (posRepushInFlight.has(key)) return posRepushInFlight.get(key);
  const pending = (async () => {
    const draft = posRepushDraft(order);
    let created = null;
    let failure = null;
    try {
      // Lần lên lại trước báo lỗi/hết giờ: kiểm POS trước (đơn có thể đã lên), không đẩy mù thành hai đơn.
      if (order.pos?.error) {
        const existing = await findExistingPosOrder(draft.order).catch(() => null);
        if (existing && !/cancel|hủy|huỷ/i.test(String(existing.status || ''))) created = existing;
      }
      if (!created) created = await pushOrderToPos(draft.order, { conversation });
    } catch (error) {
      failure = error;
    }
    let outcome = null;
    await updateMessagingStore(store => {
      const item = store.conversations.find(entry => entry.id === conversation.id);
      const target = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => entry.id === order.id);
      if (!target) return null;
      if (created) outcome = applyPosRepush(target, created, draft);
      else {
        target.pos = { ...(target.pos || {}), error: `Lên lại POS lỗi: ${failure?.message || 'không rõ lý do'}`, updatedAt: Date.now() };
        outcome = target.pos;
      }
      return null;
    });
    publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id });
    console.log(created ? `Đơn ${order.id} (mở lại sau khi POS hủy) đã lên lại Pancake POS #${created.id} với mã ${draft.ref}.` : `Đơn ${order.id} chưa lên lại được Pancake POS: ${failure?.message || failure}`);
    return outcome || { error: failure?.message || 'Không tìm thấy đơn để lên lại POS.' };
  })().finally(() => posRepushInFlight.delete(key));
  posRepushInFlight.set(key, pending);
  return pending;
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
    recordOrderHistory(order, { by: { username: 'pos', name: 'Pancake POS' }, action: 'order.cancel', summary: 'Đơn đã hủy trên Pancake POS, CRM hủy theo.' });
  };
  const changed = [];
  const touched = new Set();
  // Đồng bộ POS gọi lại với mọi đơn đã hủy trong 48 giờ: đơn đã hủy theo từ trước thì không ghi lại kho.
  await updateMessagingStore(store => {
    let cancelledNow = 0;
    for (const conversation of store.conversations) {
      for (const order of Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []) {
        // Đơn đã lên lại POS (R13 M7) mang mã "<mã>-L<n>" ở pos.crmRef: chỉ hủy theo ĐƠN POS MỚI đó, không theo đơn cũ đã hủy.
        if (!wanted.has(posCancelRefOf(order)) || order.processingStatus === 'cancelled' || order.pos?.cancelSyncedAt || /Đã hủy trên POS/.test(String(order.note || ''))) continue;
        markCancelled(order);
        changed.push({ ...order });
        touched.add(conversation.id);
        cancelledNow += 1;
      }
    }
    return cancelledNow;
  }, { unchanged: cancelledNow => !cancelledNow });
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

// Chỉ một mã QR in lên mọi thẻ (nhiều mã theo lô/sàn làm bộ phận vận hành rối).
// Mã nằm trong đường dẫn và trong tin soạn sẵn (#mã) nên chỉ chữ thường không dấu; tên
// hiện cho nhân viên là QR_MAIN_LABEL. Mã khác còn trong kho là mã chạy thử: không tính
// vào số liệu, xoá được. tmdt-01 vì đã cài sẵn làm nguồn truy cập Pancake và Custom Ref Botcake.
const qrMainCode = String(process.env.QR_MAIN_CODE || 'tmdt-01').trim().toLowerCase();
const qrMainLabel = String(process.env.QR_MAIN_LABEL || 'Thương mại điện tử').trim();
if (!isValidQrCode(qrMainCode)) throw new Error(`QR_MAIN_CODE không hợp lệ: ${qrMainCode}`);
registerQrCode(qrMainCode).catch(error => console.error(`QR: không tạo được mã chính ${qrMainCode}: ${error.message}`));

/**
 * Page mà /q/<mã> đưa khách tới. Lấy từ Page đang kết nối trong CRM; đặt
 * QR_PAGE_ID (và QR_PAGE_NAME cho tên hiện trên trang đệm) trong .env để ghim
 * cứng nếu sau này nối thêm Page thứ hai. Nhớ lại kết quả để mỗi lượt quét
 * không phải đọc đĩa.
 */
let cachedQrPage = null;
async function resolveQrPage() {
  if (cachedQrPage) return cachedQrPage;
  // Kho kênh đọc lỗi tạm (channel-store giờ ném thay vì coi là rỗng): đã ghim QR_PAGE_ID thì vẫn phục vụ được.
  const channels = await readChannelStore().catch(error => {
    if (process.env.QR_PAGE_ID) return { items: [] };
    throw error;
  });
  const first = channels.items?.[0] || {};
  const id = String(process.env.QR_PAGE_ID || first.id || '');
  const name = String(process.env.QR_PAGE_NAME || (String(first.id) === id ? first.name : '') || process.env.PANCAKE_PAGE_NAME || '').trim();
  if (!id) return { id: '', name };
  cachedQrPage = { id, name };
  return cachedQrPage;
}

/**
 * Webhook landing đã trả 200 cho Webcake: tạo đơn ở nền (tự điền địa chỉ, tra cảnh báo SĐT có thể
 * mất vài giây). Không bao giờ ném ra ngoài (promise bỏ rơi).
 */
function processLandingWebhookInBackground(payload, page) {
  recordLandingOrder(payload, { page })
    .then(result => {
      if (result.error) {
        console.error(`Webhook landing: không tạo được đơn — ${result.error}`);
        return;
      }
      console.log(`Webhook landing: ${result.created ? 'tạo đơn' : 'đơn trùng, bỏ qua'} #${result.order.id} (${String(result.order.phone || '').replace(/\d(?=\d{3})/g, '*')})`);
      publishMessagingEvent({ type: 'landing-order', orderId: result.order.id });
    })
    .catch(error => console.error(`Webhook landing: lỗi khi tạo đơn ở nền — ${error.message}`));
}

/** Đồng bộ Pancake (định kỳ và nút Đồng bộ) đưa bot qua cùng móc như webhook. */
async function syncBotHook(changes, deps) {
  scheduleQrGreetings(changes);
  // Tin đầu của khách mới quét thẻ mà webhook bỏ sót: vẫn khớp với lượt bấm nút theo GIỜ CỦA TIN.
  const held = await considerQrBridgeClicks(changes);
  try {
    return await processChatbotChanges(changes.filter(change => !isCardScan(change)), deps);
  } finally {
    qrBridgeMatcher.botDone(held);
  }
}

/**
 * Nội dung ưu đãi lấy từ kho mẫu tin, KHÔNG viết cứng trong mã — cùng nguyên
 * tắc với mọi lời thoại khác của bot, để nhân viên sửa được ở Cài đặt → Tin
 * nhắn mà không phải triển khai lại.
 */
async function qrOfferMessage(conversation) {
  const settings = await readChatbotSettings();
  // Mẫu để trống trong Cài đặt = không gửi (không rơi về mẫu đi kèm mã nguồn); mẫu còn câu giữ chỗ
  // "SỬA NỘI DUNG ƯU ĐÃI…" bị chặn, không bao giờ tới khách (resolveQrOfferTemplate).
  const resolved = resolveQrOfferTemplate({ stored: settings.messageTemplates?.QR_OFFER, fallback: defaultMessageTemplates().QR_OFFER });
  if (resolved.skip) return resolved;
  const template = resolved.template;
  // spin: chọn ngẫu nhiên trong {a|b}. applyHonorific: thay anh/chị theo giới tính.
  const filled = applyHonorific(spin(template), conversation.gender || '').replace(/\{title\}/gi, match => (match[1] === 'T' ? honorific(conversation.gender || '').replace(/^\p{L}/u, c => c.toUpperCase()) : honorific(conversation.gender || '')));
  // Thẻ ưu đãi là ẢNH (![](https://…) trong mẫu) kèm chữ; giữ đúng thứ tự ảnh/chữ như mẫu.
  // Mẫu chỉ có chữ: CRM tự thêm ảnh thẻ (assets/branding/offers/the-uu-dai.png, phục vụ ở /q/brand/offer-card.png)
  // lên đầu như tin Botcake. Thiếu tệp, PUBLIC_BASE_URL không https, hay QR_OFFER_IMAGE=0 thì chỉ gửi chữ.
  return withOfferCardImage(splitMessages(filled).parts, {
    baseUrl: metaConfig.publicBaseUrl,
    imagePath: qrOfferCardRoute,
    enabled: String(process.env.QR_OFFER_IMAGE ?? '').trim() !== '0',
    available: await stat(qrOfferCardFile).then(info => info.isFile() && info.size > 0, () => false)
  });
}
// Ảnh thẻ ưu đãi gửi kèm tin QR_OFFER (dựng từ trang đệm, đổi ưu đãi thì dựng lại tệp này).
const qrOfferCardRoute = '/q/brand/offer-card.png';
const qrOfferCardFile = path.join(root, 'assets', 'branding', 'offers', 'the-uu-dai.png');

// Bộ chào (app/qr-greeting.mjs): hẹn giờ, hủy khi Botcake đã chào, cooldown theo hội thoại. Bot tắt hay
// hội thoại đã phân công vẫn gửi ưu đãi (chủ shop 02/10); chỉ né khi nhân viên vừa nhắn trong
// QR_GREETING_STAFF_QUIET_MS (mặc định 10 phút; 0 = không né).
const qrGreetingStaffQuietMs = (() => {
  const raw = String(process.env.QR_GREETING_STAFF_QUIET_MS ?? '').trim();
  const value = Number(raw);
  return raw && Number.isFinite(value) && value >= 0 ? value : 10 * 60 * 1000;
})();
const qrGreeter = createQrGreeter({
  offerMessage: qrOfferMessage,
  send: (conversation, payload) => sendConversationMessage(conversation, payload),
  delayMs: qrGreetingDelayMs,
  cooldownMs: qrGreetingCooldownMs,
  staffQuietMs: qrGreetingStaffQuietMs,
  staffLastMessageAt: async conversation => lastStaffMessageAt((await readMessagingStore()).messages?.[conversation.id]),
  // Mốc "đã chào" lưu bền trên hội thoại (`qrGreetedAt`): khởi động lại không chào lần hai (02/10 10:42).
  greetedStore: {
    load: async () => (await readMessagingStore()).conversations
      .filter(conversation => Number(conversation.qrGreetedAt) > 0)
      .map(conversation => [conversation.id, Number(conversation.qrGreetedAt)]),
    save: (conversation, at) => updateMessagingStore(store => {
      const stored = store.conversations.find(item => item.id === conversation.id);
      if (!stored || Number(stored.qrGreetedAt) === at) return false;
      stored.qrGreetedAt = at;
      return true;
    }, { defer: true, unchanged: changed => !changed })
  },
  // Đơn gần nhất của khách này (mọi luồng cùng Page + khách): có đơn tạo trong thời gian chờ chào lại thì thôi.
  recentOrderAt: async conversation => Math.max(0, ...(await readMessagingStore()).conversations
    .filter(item => item.pageId === conversation.pageId && item.psid === conversation.psid)
    .flatMap(item => (Array.isArray(item.customerOrders) ? item.customerOrders : []).map(order => Number(order?.createdAt) || 0)))
});
// Deploy / khởi động lại (SIGTERM) trong lúc đang hẹn chào: gửi ngay các lượt đang hẹn (tối đa 5 giây) trước
// khi thoát — timer chỉ nằm trong RAM. Đăng ký TRƯỚC installMessagingStoreShutdownFlush; lệnh thoát ở đó chờ
// lời hứa này (xem cuối tệp).
let qrGreetingShutdownFlush = null;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    // Gửi nốt xong thì ghi kho thêm một lượt: mốc `qrGreetedAt` của lượt vừa gửi là ghi gộp (defer).
    qrGreetingShutdownFlush ||= qrGreeter.flush({ timeoutMs: 5000 })
      .then(count => (count ? flushMessagingStoreForQr() : undefined))
      .catch(error => console.error(`QR: lỗi khi gửi nốt lượt chào lúc tắt: ${error.message}`));
  });
}
const scheduleQrGreetings = (changes, options) => qrGreeter.schedule(changes, options);

// Khách MỚI quét thẻ (chưa từng nhắn Page): Meta không báo mã cho ai, nên khớp lượt bấm nút "Mở Messenger"
// trên trang đệm với tin đầu của hội thoại hộp thư mới không dấu nguồn (app/qr-greeting.mjs, createBridgeClickMatcher).
// QR_BRIDGE_MATCH_WINDOW_MS: cửa sổ từ lúc bấm tới tin đầu (mặc định 90 giây — ca thật 49 giây; 0 = tắt).
// QR_BRIDGE_AMBIGUITY_MS: hai hội thoại mới cách nhau trong quãng này tranh một lượt bấm → không chào ai (15 giây).
const qrBridgeEnvMs = (name, fallback) => {
  const raw = String(process.env[name] ?? '').trim();
  const value = Number(raw);
  return raw && Number.isFinite(value) && value >= 0 ? value : fallback;
};
const qrBridgeMatcher = createBridgeClickMatcher({
  windowMs: qrBridgeEnvMs('QR_BRIDGE_MATCH_WINDOW_MS', 90_000),
  ambiguityMs: qrBridgeEnvMs('QR_BRIDGE_AMBIGUITY_MS', 15_000),
  greetDelayMs: qrGreetingDelayMs,
  pageId: async () => (await resolveQrPage()).id,
  // R13 fix2 (A6): lúc chốt chào, đọc lịch sử hội thoại từ Pancake (một trang 30 tin, chờ tối đa 5 s ở bộ khớp): có tin cũ hơn
  // lượt bấm → khách cũ mà kho CRM chưa có (trước khi nối Pancake; đồng bộ chỉ kéo 60 hội thoại) → không chào. Lỗi → vẫn khớp theo kho.
  history: async conversation => {
    const conversationId = String(conversation?.pancakeConversationId || '');
    if (!conversationId) return [];
    const messages = await fetchPancakeMessages(conversationId, { pages: 1 }, getPancakePageConfig(conversation.pageId));
    return messages.map(message => ({ createdAt: pancakeTime(message?.inserted_at, 0) }));
  },
  inspect: async change => {
    const store = await readMessagingStore();
    const conversation = store.conversations.find(item => item.id === change.conversation.id) || change.conversation;
    const commentAt = Math.max(0, ...store.conversations
      .filter(item => item.source === 'comment' && item.pageId === conversation.pageId && item.psid === conversation.psid)
      .map(item => Number(item.lastMessageAt) || 0));
    return { conversation, messages: store.messages?.[conversation.id] || [], commentAt };
  },
  greet: (change, options) => {
    // Ghi như referral thẻ QR (ô qrReferrals): thống kê "vào Messenger" và nhãn nguồn dùng chung với các đường khác.
    updateMessagingStore(store => {
      const stored = store.conversations.find(item => item.id === change.conversation.id);
      if (!stored) return false;
      attachQrReferral(stored, change.referral, { messageId: change.message?.mid || change.message?.id || '', at: change.message?.createdAt });
      return true;
    }, { defer: true, unchanged: changed => !changed }).catch(error => console.error(`QR: không ghi được referral lượt bấm: ${error.message}`));
    scheduleQrGreetings([change], options);
  }
});
/** Móc trước bot: xét tin khách mới với lượt bấm đang chờ; không bao giờ ném (webhook vẫn phải đưa bot). */
const considerQrBridgeClicks = changes => qrBridgeMatcher.consider(changes).catch(error => {
  console.error(`QR: lỗi khi xét lượt bấm chờ khớp: ${error.message}`);
  return [];
});
// Page vận hành ở Pancake (chỉ nghe referral) mà sự kiện Meta về ở `messaging` chứ không phải `standby`:
// Meta đang giao luồng cho app CRM (định tuyến liên kết m.me). Xong việc — đã gửi ưu đãi QR, hoặc không
// có gì để gửi — thì trả luồng về app mặc định, kẻo tin sau của khách không tới Pancake.
const shouldReleaseQrThread = change => !change.standby && isReferralOnlyPage(change.conversation?.pageId);
const releaseQrThread = createThreadReleaser({
  release: releaseThreadControl,
  getToken: getPageAccessToken,
  shouldRelease: shouldReleaseQrThread
});
// Thứ tự trả luồng / gửi ưu đãi cho sự kiện Meta khi dùng "Định tuyến liên kết" (createLinkRoutedQrFlow):
// khách cũ (có hội thoại Pancake) trả luồng trước rồi gửi qua Pancake, Pancake lỗi thì gửi qua Send API
// Meta; khách mới gửi qua Send API Meta rồi mới trả luồng.
const handleMetaQrChanges = createLinkRoutedQrFlow({
  schedule: scheduleQrGreetings,
  releaseThread: releaseQrThread,
  shouldRelease: shouldReleaseQrThread,
  sendPrimary: (conversation, payload) => sendConversationMessage(conversation, payload),
  sendViaMeta: (conversation, payload) => sendConversationMessage({ ...conversation, pancakeConversationId: '' }, payload)
});

/** Sends the tappable Messenger receipt. Kept separate from creating the order so
 *  the chatbot can persist the order first and still close with the receipt. */
/** `force`: nhân viên bấm "Gửi lại cho khách" — gửi cả khi POS đã gửi thẻ, và ném lỗi thay vì chỉ ghi log. */
/** `sentBy` { name, username }: nhân viên đã bấm (đơn tạo tay, "Gửi lại phiếu") — tin mang sender 'staff'; không có là bot gửi. */
/**
 * Trả kết quả gửi thật (không ném khi `force` = false): { sent: true, via: 'receipt-image' | 'messenger' }
 * | { sent: false, via: 'pos' } (POS đã gửi thẻ, CRM không gửi thêm) | { sent: false, error } (gửi lỗi).
 * Trước 01/10 lỗi bị nuốt và đơn tạo tay vẫn báo "Đã gửi xác nhận cho khách".
 */
async function sendChatbotOrderReceipt(conversation, order, { force = false, sentBy = null } = {}) {
  try {
    // Qua Pancake không gửi được thẻ receipt của Messenger: phiếu được vẽ
    // thành ảnh và gửi như ảnh đính kèm (bản chữ chỉ lặp lại ORDER_CONFIRMATION).
    // Đơn đã sang Pancake POS thì POS đã gửi khách thẻ xác nhận, không gửi phiếu thứ hai.
    // Bản chữ "XÁC NHẬN ĐƠN ĐẶT HÀNG…" KHÔNG BAO GIỜ gửi cho khách (yêu cầu của
    // chủ shop): phiếu chỉ là thẻ receipt của Messenger, thẻ của POS, hoặc ảnh phiếu.
    if (conversation.pancakeConversationId) {
      if (order.pos?.id && !force) return { sent: false, via: 'pos' };
      await sendReceiptImage(conversation, order, { sentBy });
      return { sent: true, via: 'receipt-image' };
    }
    try {
      await sendConversationMessage(conversation, { template: buildOrderReceiptPayload(order, { baseUrl: metaConfig.publicBaseUrl }), sentBy });
      return { sent: true, via: 'messenger' };
    } catch (error) {
      // Messenger từ chối thẻ receipt: gửi ảnh phiếu thay vì bản chữ.
      console.error(`Messenger từ chối thẻ receipt của đơn ${order.id}, gửi ảnh phiếu: ${error.message}`);
      await sendReceiptImage(conversation, order, { sentBy });
      return { sent: true, via: 'receipt-image' };
    }
  } catch (error) {
    if (force) throw error;
    console.error(`Không gửi được hoá đơn cho đơn ${order.id}: ${error.message}`);
    return { sent: false, error: String(error?.message || error) };
  }
}

async function sendReceiptImage(conversation, order, { sentBy = null } = {}) {
  const image = await renderOrderReceiptImage(order, { merchantName: pancakeConfig.pageName.replace(/\s*\(Pancake\)\s*$/i, '') || 'Giọt Nắng' });
  return sendConversationMessage(conversation, {
    attachment: { dataUrl: `data:image/png;base64,${image.toString('base64')}`, name: `phieu-don-${order.id}.png`, type: 'image' },
    sentBy
  });
}

async function readChatbotSettings() {
  let raw = '';
  try {
    raw = await readFile(chatbotSettingsPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('Cài đặt chatbot: không đọc được tệp:', error.message);
    return normalizeChatbotSettings(defaultChatbotSettings);
  }
  let stored;
  try {
    stored = JSON.parse(raw);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('không phải object JSON');
  } catch (error) {
    // Tệp hỏng (ghi dở, đè nhau): cách ly để còn cứu, báo to thay vì âm thầm chạy với cài đặt trống (mất prompt, mẫu, endpoint).
    const quarantined = `${chatbotSettingsPath}.corrupt-${Date.now()}`;
    await rename(chatbotSettingsPath, quarantined).catch(() => {});
    console.error(`Cài đặt chatbot: tệp hỏng (${error.message}), đã cất sang ${path.basename(quarantined)}; tạm dùng cài đặt mặc định.`);
    return normalizeChatbotSettings(defaultChatbotSettings);
  }
  // Khoá API không giải mã được (META_APP_SECRET đổi/thiếu): giữ nguyên tệp và mọi cài đặt khác, chỉ bỏ khoá.
  let directApiKey = stored.directApiKey;
  if (stored.directApiKeyEncrypted) {
    try { directApiKey = decryptToken(stored.directApiKeyEncrypted); } catch (error) {
      console.error(`Cài đặt chatbot: không giải mã được khoá API (${error.message}); giữ cài đặt, bỏ khoá — nhập lại khoá trong Cài đặt.`);
      directApiKey = '';
    }
  }
  return normalizeChatbotSettings({ ...stored, directApiKey });
}

configureAddressAi({ readSettings: readChatbotSettings });
// Cố vấn chiến dịch dùng chung mô hình với chatbot (Cài đặt → Chatbot).
configureCampaignAi({ readSettings: readChatbotSettings });

// Ghi tuần tự, tên tệp tạm duy nhất: hai yêu cầu ghi gần nhau (PUT settings + master-switch) không đè lên
// cùng một .tmp rồi rename giữa chừng thành JSON cụt.
let chatbotSettingsWriteQueue = Promise.resolve();
function writeChatbotSettings(settings) {
  const operation = chatbotSettingsWriteQueue.then(async () => {
    const normalized = normalizeChatbotSettings(settings);
    const { directApiKey, ...safeSettings } = normalized;
    const stored = {
      ...safeSettings,
      ...(directApiKey ? { directApiKeyEncrypted: encryptToken(directApiKey) } : {})
    };
    await writeJsonAtomic(chatbotSettingsPath, stored);
    return normalized;
  });
  chatbotSettingsWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function sendBinary(response, statusCode, body, contentType, filename) {
  response.writeHead(statusCode, { 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control':'no-store' });
  response.end(body);
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
async function readBody(request, maximumBytes = 1024 * 1024) {
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
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  // null / mảng / chuỗi qua được JSON.parse nhưng route truy `payload.x` sẽ ném TypeError lộ chuỗi nội bộ.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Thân yêu cầu phải là một object JSON.');
  return parsed;
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

async function serveFile(request, response, pathname, version = '') {
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
      response.writeHead(200, { 'Content-Type':types[path.extname(filename)], 'Cache-Control':'private, max-age=86400' });
      return response.end(body);
    } catch { return sendJson(response, 404, { error:'Resource not found.' }); }
  }
  // Meta requires a public privacy policy URL; Caddy lets /privacy through without a password.
  const relative = pathname === '/' ? 'index.html' : pathname === '/privacy' ? 'privacy.html' : pathname === '/login' ? 'login.html' : pathname.slice(1);
  const filePath = path.resolve(webRoot, relative);
  if (!filePath.startsWith(path.resolve(webRoot) + path.sep)) return sendJson(response, 400, { error:'Invalid path.' });
  const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.webp':'image/webp', '.woff2':'font/woff2', '.ico':'image/x-icon' };
  try {
    const stats = await stat(filePath);
    let etag = `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
    let body = null;
    if (relative === 'index.html') {
      // Phiên bản mọi tệp .js/.css cạnh index.html (app.js, styles.css, staff.js, audit.css…) gắn theo mốc sửa
      // tệp: mỗi lần deploy trình duyệt tự tải bản mới, không phụ thuộc chuỗi ?v= ghi tay; nhờ đó các tệp này
      // được cache hẳn (staticCacheControl). Tệp không có trên đĩa thì giữ nguyên chuỗi cũ.
      const stamp = async name => { try { return fileVersionStamp((await stat(path.join(webRoot, name))).mtimeMs); } catch { return ''; } };
      const source = String(await readFile(filePath, 'utf8'));
      const versioned = /(["'])([A-Za-z0-9_-]+\.(?:js|css))\?v=[^"']*/g;
      const names = [...new Set([...source.matchAll(versioned)].map(match => match[2]))];
      const stamps = new Map(await Promise.all(names.map(async name => [name, await stamp(name)])));
      body = Buffer.from(source.replace(versioned, (match, quote, name) => (stamps.get(name) ? `${quote}${name}?v=${stamps.get(name)}` : match)), 'utf8');
      etag = `W/"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
    }
    // app.js?v=<mốc sửa tệp> (index.html tự gắn): URL đổi mỗi lần deploy nên cache hẳn, khỏi hỏi lại mỗi lần
    // tải trang. ?v= ghi tay hay sai mốc, và index.html: no-cache (hỏi lại bằng ETag) như cũ.
    const cacheControl = staticCacheControl({ relative, version, stamp: fileVersionStamp(stats.mtimeMs) });
    const headers = { 'Content-Type':types[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control':cacheControl, 'ETag':etag };
    // CSP chỉ cho trang HTML của web/ (đã rà: không script nội tuyến) — lý do từng chỉ thị ở app/security.mjs.
    if (path.extname(filePath) === '.html') headers['Content-Security-Policy'] = HTML_CSP;
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
  // Ghi chú nội bộ cho nhân viên khi bot không tự làm (C2: SĐT trùng đơn của hội thoại khác, cần đối chiếu):
  // vào ghi chú hồ sơ khách, tác giả "Chatbot AI" (chatbot-engine noteForStaff).
  addStaffNote: createStaffNoteWriter({
    findCustomerById,
    addCustomerNote,
    onSaved: ({ conversation }) => {
      invalidateBuyersCache();
      publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id });
    }
  }),
  // Bot báo về sự kiện (chốt đơn / chuyển nhân viên / khiếu nại); thẻ nào
  // nhận sự kiện là do nhân viên chọn trong Cài đặt → Tin nhắn.
  saveBotState: async (id, { addLabelEvents = [], ...botState }) => {
    // Đọc cài đặt thẻ lỗi tạm (EBUSY/EACCES…, inbox-settings giờ ném thay vì trả bộ mặc định): vẫn lưu trạng
    // thái bot (giỏ, bot tắt…), chỉ bỏ gắn thẻ lần này và ghi log — mất trạng thái bot tệ hơn thiếu một thẻ.
    const labelDefs = addLabelEvents.length
      ? ((await readInboxSettings().catch(error => { console.warn(`Bot: không đọc được cài đặt thẻ, bỏ gắn ${addLabelEvents.join(', ')} cho ${id}: ${error.message}`); return null; }))?.labels || [])
      : [];
    const addLabels = addLabelEvents.length ? labelsForEvents(labelDefs, addLabelEvents) : [];
    // Thẻ bot gắn và bot tự tắt (chuyển CSKH) vào lịch sử hội thoại (nhật ký, người làm 'bot').
    let labelChange = null;
    let botOff = null;
    const saved = await updateMessagingStore(store => {
      const conversation = store.conversations.find(item => item.id === id);
      if (!conversation) return null;
      const botWasOn = conversation.botEnabled !== false;
      Object.assign(conversation, botState);
      if (botWasOn && botState.botEnabled === false) botOff = { id: conversation.id, name: conversation.name || '' };
      if (addLabels.length) {
        const before = Array.isArray(conversation.labels) ? conversation.labels : [];
        const merged = [...new Set([...before, ...addLabels])];
        if (merged.length !== before.length) {
          conversation.labels = merged;
          labelChange = { conversation: { id: conversation.id, name: conversation.name || '' }, before: [...before], after: [...merged] };
          publishMessagingEvent({ type: 'conversation', conversation: publicConversation(conversation) });
        }
      }
      return conversation;
    });
    const eventNames = { order: 'chốt đơn', handoff: 'chuyển nhân viên', complaint: 'khiếu nại', warranty: 'bảo hành', update: 'khách đổi đơn', cancel: 'khách hủy đơn', livestream: 'khách livestream', wholesale: 'khách sỉ', bad: 'khách xấu' };
    if (labelChange) appendLabelAudit({ actor: AUTOMATED_ACTORS.bot, ...labelChange, labelDefs, reason: `bot: ${addLabelEvents.map(event => eventNames[event] || event).join(', ')}` });
    if (botOff) appendBotToggleAudit({ actor: AUTOMATED_ACTORS.bot, conversation: botOff, enabled: false, reason: 'bot chuyển nhân viên' });
    return saved;
  }
};

// Tài khoản đăng nhập = tài khoản chủ shop trong .env (CRM_LOGIN_USERS) + Nhân sự đang làm đã có mật khẩu
// (Cài đặt → Nhân sự). Map dùng chung với auth và được cập nhật tại chỗ mỗi lần lưu Nhân sự: thêm người,
// đổi mật khẩu hay cho nghỉ có hiệu lực ngay (phiên cũ của người đổi mật khẩu/nghỉ hết hạn theo dấu vân tay).
const envLoginUsers = parseUsers(authConfig.users);
const loginUsers = new Map(envLoginUsers);
// Giá trị của Nhân sự là { hash, version } (sessionVersion): đổi mật khẩu / cho nghỉ → cookie cũ vô hiệu.
// Đọc kho lỗi thì NÉM (giữ danh sách cũ), không xoá hết tài khoản.
let loginUsersCheckedAt = 0;
async function refreshLoginUsers() {
  const staff = await staffLoginAccounts();
  for (const name of [...loginUsers.keys()]) if (!envLoginUsers.has(name) && !staff.has(name)) loginUsers.delete(name);
  for (const [name, account] of staff) if (!envLoginUsers.has(name)) loginUsers.set(name, account);
  loginUsersCheckedAt = Date.now();
}
// Kiểm Nhân sự còn đang làm ở mỗi request, nhớ 15 giây (staff.json sửa bằng tay/script cũng có hiệu lực).
const LOGIN_USERS_CACHE_MS = 15 * 1000;
let loginUsersRefreshing = null;
function refreshLoginUsersIfStale() {
  if (Date.now() - loginUsersCheckedAt < LOGIN_USERS_CACHE_MS) return Promise.resolve();
  loginUsersRefreshing ||= refreshLoginUsers()
    .catch(error => { loginUsersCheckedAt = Date.now(); console.warn(`Không đọc được Nhân sự cho đăng nhập (giữ danh sách cũ): ${error.message}`); })
    .finally(() => { loginUsersRefreshing = null; });
  return loginUsersRefreshing;
}
await refreshLoginUsers().catch(error => console.warn(`Không đọc được Nhân sự cho đăng nhập: ${error.message}`));
const auth = createAuth({ users: loginUsers, secret: authConfig.sessionSecret, secure: authConfig.secureCookie });

/** IP người dùng: X-Forwarded-For chỉ được tin khi kết nối từ loopback (Caddy) — app/request-actor.mjs. */
function clientAddress(request) {
  return clientIp(request);
}

/* ---- Nhật ký hoạt động (app/audit-log.mjs) ----
 * Mọi thao tác của NGƯỜI DÙNG (route do giao diện gọi) ghi một dòng sau khi thành công; thất bại
 * quan trọng (đăng nhập sai) cũng ghi. Việc tự động của bot/đồng bộ không ghi ở đây.
 * tests/audit-routes.test.mjs đọc mã nguồn: route ghi nào thiếu `audit(request` là test hỏng.
 */
/** Người gọi request: { username, name, role, roleName, ip } (nhân sự nhớ 30 giây). */
const requestActor = request => actorOf(request, { auth, envLoginUsers });
/** Người của một tên đăng nhập (lúc đăng nhập: phiên chưa có trên request). */
const actorForUsername = (request, username) => actorOf(request, { auth: { enabled: true, session: () => ({ username }) }, envLoginUsers });
/**
 * Phân quyền Cài đặt: `if (!(await requireManager(request, response))) return;` ở đầu route ghi.
 * Nhân viên thường (role staff) bị 403; chủ shop / Quản trị qua. Danh sách route có chốt này được
 * tests/security-routes.test.mjs kiểm trên mã nguồn.
 */
const requireManager = createRequireManager(requestActor, sendJson);

/**
 * Ghi một dòng nhật ký (không chặn request, lỗi chỉ warn). `details`: { target, conversationId,
 * orderId, summary }. `actor`: người đã tra sẵn (tránh tra lại), mặc định tra từ phiên.
 */
function audit(request, action, details = {}, actor = null) {
  return Promise.resolve(actor || requestActor(request))
    .then(who => appendAudit({ ...details, actor: who.username, actorName: who.name, role: who.role, ip: who.ip || clientIp(request), action }))
    .catch(error => console.warn(`Nhật ký hoạt động: ${error.message}`));
}

// Xem hội thoại: cùng người + cùng hội thoại ghi nhật ký tối đa 1 lần / 30 phút (đánh dấu đã đọc cũng vậy).
const shouldAuditView = createViewThrottle();
const shouldAuditRead = createViewThrottle();
// "Ai đã xem" trên chính hội thoại (conversation.seenBy): ghi kho tối đa 1 lần / phút / người / hội thoại.
const shouldStoreSeen = createViewThrottle({ windowMs: 60 * 1000 });

/** Ghi "người này vừa xem" lên hội thoại và báo các máy khác (SSE). Chưa bật đăng nhập thì thôi. */
async function recordConversationSeen(conversationId, actor) {
  if (!actor?.username || !shouldStoreSeen(actor.username, conversationId)) return;
  // Ghi gộp (defer): GET tin nhắn không phải chờ ghi cả kho; "ai đã xem" chỉ để hiển thị, mất tối đa
  // vài giây khi tiến trình chết là chấp nhận được. Không có hội thoại / tên đăng nhập thì không đổi gì.
  const updated = await updateMessagingStore(store => markConversationSeen(store, conversationId, { username: actor.username, name: actor.name }), { defer: true, unchanged: result => !result });
  if (updated) publishMessagingEvent({ type: 'conversation', conversation: publicConversation(updated) });
}

/** Định nghĩa thẻ (Cài đặt → Tin nhắn) để nhật ký ghi TÊN thẻ, không chỉ mã. */
async function inboxLabelDefs() {
  const { labels } = await readInboxSettings().catch(() => ({ labels: [] }));
  return Array.isArray(labels) ? labels : [];
}

/** Mã thẻ hợp lệ (Cài đặt → Tin nhắn) để kiểm thẻ nhân viên gắn; null khi không đọc được cài đặt (không kiểm, không làm rơi thẻ). */
async function allowedLabelIdSet() {
  const defs = await inboxLabelDefs();
  return defs.length ? new Set(defs.map(label => label.id)) : null;
}

/** "Sửa cài đặt chatbot: prompt, 3 mẫu tin bot, bám đuổi" — không bao giờ ghi khoá API. */
function chatbotSettingsChangeText(before = {}, after = {}, payload = {}) {
  const labels = {
    responseMode: 'chế độ trả lời', systemPrompt: 'prompt', prompt: 'prompt', welcomeMessage: 'lời chào',
    provider: 'nhà cung cấp AI', directEndpoint: 'endpoint AI', directModel: 'mô hình AI', directAuthType: 'kiểu xác thực AI',
    followUps: 'bám đuổi', handoffKeywords: 'từ khóa chuyển CSKH', complaintKeywords: 'từ khóa khiếu nại', contextTrim: 'rút gọn ngữ cảnh'
  };
  const changed = [];
  for (const key of Object.keys(payload || {})) {
    if (['messageTemplates', 'directApiKey', 'updatedAt', 'enabled'].includes(key)) continue;
    if (JSON.stringify(before?.[key]) === JSON.stringify(after?.[key])) continue;
    const label = labels[key] || key;
    if (!changed.includes(label)) changed.push(label);
  }
  const templates = Object.keys({ ...(before?.messageTemplates || {}), ...(after?.messageTemplates || {}) })
    .filter(id => JSON.stringify(before?.messageTemplates?.[id]) !== JSON.stringify(after?.messageTemplates?.[id]));
  if (templates.length) changed.push(`${templates.length} mẫu tin bot (${templates.slice(0, 4).join(', ')}${templates.length > 4 ? '…' : ''})`);
  if (String(payload?.directApiKey || '').trim()) changed.push('đổi khoá API');
  if (before?.enabled !== after?.enabled) changed.unshift(after?.enabled ? 'BẬT bot' : 'TẮT bot');
  return `Sửa cài đặt chatbot: ${changed.join(', ') || 'không đổi'}.`;
}

const orderTarget = order => ({ type: 'order', id: String(order?.id || ''), name: String(order?.name || '') });
const conversationTarget = conversation => ({ type: 'conversation', id: String(conversation?.id || ''), name: String(conversation?.name || '') });

/** Ghi một mục lịch sử lên đơn ở cả hai kho (đơn hội thoại / đơn landing). */
async function addOrderHistory(orderId, entry) {
  let found = false;
  await updateMessagingStore(store => {
    for (const conversation of store.conversations) {
      const order = (Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []).find(item => String(item.id) === String(orderId));
      if (order) { recordOrderHistory(order, entry); found = true; break; }
    }
    return null;
  });
  if (!found) await updateLandingStore(store => { const order = store.orders.find(item => String(item.id) === String(orderId)); if (order) recordOrderHistory(order, entry); });
}

/** /api/auth/*, chặn khi chưa đăng nhập. Trả true khi đã tự trả lời request. */
async function handleAuth(request, response, url, isWebhook) {
  // Nhân sự cho nghỉ / đổi mật khẩu (kể cả sửa staff.json ngoài giao diện): phiên cũ hết hiệu lực trong ≤15 giây.
  if (!isWebhook) await refreshLoginUsersIfStale();
  // Fail-closed: máy chủ thật (https / CRM_REQUIRE_LOGIN=1) mà chưa có tài khoản nào thì KHÔNG mở toang.
  if (loginGate({ enabled: auth.enabled, required: authConfig.requireLogin }) === 'setup-required' && !allowedWithoutLoginSetup(url.pathname, { isWebhook })) {
    if (url.pathname.startsWith('/api/') || request.method !== 'GET') {
      sendJson(response, 503, { error: LOGIN_SETUP_MESSAGE });
    } else {
      response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '300' });
      response.end(loginSetupPage());
    }
    return true;
  }
  if (url.pathname === '/api/auth/session' && request.method === 'GET') {
    const session = auth.session(request);
    // Kèm họ tên và vai trò trong Nhân sự để thanh trên cùng hiện đúng người đang đăng nhập.
    const member = session?.username && !envLoginUsers.has(session.username) ? await staffByUsername(session.username) : null;
    const identity = member ? { name: member.name, role: member.role, roleName: member.roleName } : (session?.username ? { roleName: 'Chủ shop' } : {});
    sendJson(response, session ? 200 : 401, session ? { enabled: auth.enabled, username: session.username, ...identity } : { error: 'Chưa đăng nhập.' });
    return true;
  }
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    const payload = await readBody(request);
    const result = await auth.login({ username: payload.username, password: payload.password, clientId: clientAddress(request) });
    if (!result.ok) {
      if (result.status === 401 || result.status === 429) {
        const typed = String(payload.username || '').trim().toLowerCase().slice(0, 40);
        console.warn(`Đăng nhập thất bại (${clientAddress(request)}): ${typed}`);
        // Đăng nhập sai: người = tên đã gõ (không ghi mật khẩu).
        audit(request, 'auth.login_failed', {
          summary: result.status === 429 ? 'Đăng nhập sai quá nhiều lần, bị khóa 15 phút.' : 'Sai tên đăng nhập hoặc mật khẩu.'
        }, { username: typed, name: typed, role: '', ip: clientAddress(request) });
      }
      sendJson(response, result.status, { error: result.error });
      return true;
    }
    console.log(`Đăng nhập: ${result.username} (${clientAddress(request)})`);
    audit(request, 'auth.login', { summary: 'Đăng nhập CRM.' }, await actorForUsername(request, result.username));
    response.setHeader('Set-Cookie', result.cookie);
    sendJson(response, 200, { username: result.username });
    return true;
  }
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    // Tra người TRƯỚC khi xóa cookie (phiên còn trên request này).
    if (auth.session(request)?.username) audit(request, 'auth.logout', { summary: 'Đăng xuất.' }, await requestActor(request));
    response.setHeader('Set-Cookie', auth.logoutCookie());
    sendJson(response, 200, { ok: true });
    return true;
  }
  const session = auth.session(request);
  if ((url.pathname === '/login' || url.pathname === '/login.html') && request.method === 'GET') {
    if (session && auth.enabled) {
      // Đã đăng nhập: về ?next= nếu là đường dẫn nội bộ an toàn, không thì về trang chủ (chống open redirect).
      response.writeHead(302, { Location: safeNextPath(url.searchParams.get('next')), 'Cache-Control': 'no-store' });
      response.end();
      return true;
    }
    return false;
  }
  if (session || isWebhook || isPublicPath(url.pathname)) return false;
  if (url.pathname.startsWith('/api/') || request.method !== 'GET') {
    sendJson(response, 401, { error: 'Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.' });
    return true;
  }
  const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname + url.search)}`;
  response.writeHead(302, { Location: `/login${next}`, 'Cache-Control': 'no-store' });
  response.end();
  return true;
}

const TRANSIENT_FILE_ERRORS = new Set(['EBUSY', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'EAGAIN']);
function friendlyRequestError(error, { method = '', url = '' } = {}) {
  const friendly = friendlyClientError(error);
  if (friendly !== String(error?.message || '')) console.warn(`Yêu cầu lỗi ${method} ${String(url).split('?')[0]}: ${error?.name || 'Error'}: ${error?.message || error}`);
  return friendly;
}
let pancakeNoTokenWarnedAt = 0;
const pancakeDebugAllowed = createLogLimiter({ max: 30, windowMs: 60 * 1000 });
const server = http.createServer(async (request, response) => {
  try {
    // Header bảo mật cho mọi phản hồi (HTML/JSON/tệp): nosniff, chống nhúng khung, Referrer, HSTS khi https.
    applySecurityHeaders(response, { https: authConfig.https });
    // R13 (L6): HEAD xử lý như GET (cùng mã trạng thái + header; Node tự bỏ thân với request HEAD) — trước đây mọi
    // đường kể cả /api/health trả 404 cho HEAD, công cụ giám sát tưởng máy chủ chết. Luồng SSE không mở cho HEAD.
    // R13 fix2 (A2): /q/<mã> cần biết phương thức gốc — HEAD (giám sát, xem trước) không phải lượt quét, không được đếm.
    const headRequest = request.method === 'HEAD';
    if (request.method === 'HEAD') {
      if (String(request.url || '').split('?')[0] === '/api/messaging/stream') { response.writeHead(405, { Allow: 'GET' }); return response.end(); }
      request.method = 'GET';
    }
    // "//q/api/…" từng vượt Basic Auth (Caddy cho /q/* đi thẳng, new URL coi "q" là host): chặn trước khi parse.
    if (!isSafeRequestTarget(request.url)) return sendJson(response, 400, { error: 'Đường dẫn không hợp lệ.' });
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    // Hai webhook do máy ngoài gọi và tự xác thực lấy, nên không áp luật Origin.
    const isWebhook = url.pathname === metaConfig.webhookPath || url.pathname === landingConfig.path || url.pathname === pancakeConfig.path;
    // Beacon "bấm nút mở Messenger" của trang đệm QR (POST /q/<mã>/open): trang đệm đặt Referrer-Policy
    // no-referrer nên trình duyệt gửi `Origin: null` — luật Origin trả 403 và số "Mở Messenger" luôn bằng 0.
    // Route này công khai, không cần đăng nhập và chỉ đếm một lượt bấm nên không cần chống CSRF.
    const isQrBeacon = request.method === 'POST' && /^\/q\/[^/]+\/open$/.test(url.pathname);
    if (!isWebhook && !isQrBeacon && isCrossSiteWrite(request)) {
      return sendJson(response, 403, { error: 'Yêu cầu đến từ trang khác nên bị từ chối.' });
    }
    if (await handleAuth(request, response, url, isWebhook)) return;
    if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { status:'ok', time:new Date().toISOString() });
    // Lớp trung gian của mã QR trên phiếu cảm ơn. Công khai (Caddy cho đi thẳng)
    // vì khách quét chưa đăng nhập gì cả. Đích đến do MÁY CHỦ quyết định, mã chỉ
    // đi vào tham số `ref` — người ngoài không thể biến nó thành chuyển hướng
    // tới địa chỉ khác.
    //
    // Chỉ Chrome hệ thống trên Android được chuyển hướng 302 thẳng sang m.me;
    // iPhone và mọi trình duyệt trong app (Zalo, Facebook…) nhận trang đệm có
    // nút "Mở Messenger", vì Safari không mở app khi tới m.me qua chuyển hướng
    // và trang web m.me nay bắt đăng nhập. Lý do đầy đủ ở app/qr-bridge.mjs.
    // Logo cho trang khách quét: /q/* là đường công khai duy nhất (Caddy), còn /assets nằm sau mật khẩu.
    // Chỉ đúng các tệp liệt kê trong bảng được phục vụ. R13 (gộp): MỘT bảng dùng chung `brandImageFiles` (pancake.mjs) —
    // route này và bộ đọc ảnh gửi đi (readImageForUpload) cùng một nguồn, gồm ảnh thẻ ưu đãi qrOfferCardRoute
    // (/q/brand/offer-card.png → offers/the-uu-dai.png; Messenger/Pancake tải từ đây nên phải công khai).
    const qrBrandFiles = brandImageFiles;
    if (request.method === 'GET' && qrBrandFiles[url.pathname]) {
      try {
        const body = await readFile(path.join(root, 'assets', 'branding', ...qrBrandFiles[url.pathname].split('/')));
        const brandTypes = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
        response.writeHead(200, { 'Content-Type': brandTypes[path.extname(qrBrandFiles[url.pathname]).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
        return response.end(body);
      } catch {
        return sendJson(response, 404, { error: 'Resource not found.' });
      }
    }
    const qrMatch = url.pathname.match(/^\/q\/([^/]+)(\/open)?\/?$/);
    if (qrMatch && (request.method === 'GET' || request.method === 'POST')) {
      const code = decodeURIComponent(qrMatch[1]).toLowerCase();
      const isOpenBeacon = Boolean(qrMatch[2]);
      // Khách quét thấy trang HTML ngắn, không phải JSON thô; beacon (POST) vẫn trả JSON.
      const sendQrNotice = (status, title, message) => {
        if (request.method !== 'GET') return sendJson(response, status, { error: message });
        response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
        return response.end(publicNoticePage({ title, message }));
      };
      if (!isValidQrCode(code)) return sendQrNotice(404, 'Mã QR không đúng', 'Mã QR này không đúng. Bạn vui lòng quét lại mã in trên thẻ, hoặc nhắn tin trực tiếp cho Giọt Nắng trên Facebook nhé.');
      // Máy nhân viên (có phiên đăng nhập CRM) quét thử / bấm thử: không vào số liệu quét thật.
      const staffScan = hasStaffSession(auth, request);
      // Mã chưa tạo ở Cài đặt → Mã QR: vẫn phục vụ (thẻ in rồi là không sửa được),
      // nhưng recordQrScan/recordQrOpen bỏ qua — kho chỉ đếm mã nhân viên đã tạo.
      if (isOpenBeacon) {
        // Beacon từ trang đệm khi khách bấm nút. Chỉ đếm, không cần thân tin.
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'Chỉ nhận POST.' });
        const to = url.searchParams.get('to');
        // Nút thoát webview trên iPhone trong app ("Mở bằng Safari", "Sao chép liên kết"): chỉ ghi log để biết
        // khách có bấm hay không — không phải lượt mở Messenger nên không vào số liệu.
        if (to === 'safari' || to === 'copy') {
          console.log(`QR: bấm "${to === 'safari' ? 'Mở bằng Safari' : 'Sao chép liên kết'}" cho mã ${code}${staffScan ? ' (máy nhân viên)' : ''}`);
          response.writeHead(204, { 'Cache-Control': 'no-store' });
          return response.end();
        }
        const target = to === 'zalo' ? 'zalo' : 'messenger';
        if (staffScan) {
          console.log(`QR: bỏ đếm lượt bấm ${target} cho mã ${code}: máy nhân viên (đã đăng nhập CRM)`);
        } else {
          console.log(`QR: bấm nút ${target} cho mã ${code}`);
          // Dấu vết ngắn hạn của máy bấm (băm IP + User-Agent, chỉ giữ trong bộ nhớ 30 phút ở qr-scans, không ghi
          // đĩa): cùng máy bấm lại / gửi beacon dồn chỉ tính một lượt.
          const visitor = qrVisitorKey(clientIp(request), request.headers['user-agent']);
          // Khách MỚI với Page: Meta không báo mã — ghi lượt bấm chờ khớp với tin đầu của hội thoại mới.
          // R13 fix2 (A4): CHỈ khi recordQrOpen ghép được beacon với một lượt trang đệm chưa dùng của cùng mã (trả mục; null = không
          // có lượt trang đệm trong 30 phút, cùng máy đã bấm, mã chưa tạo): beacon gửi dồn không quét trước không thành lượt chờ khớp.
          // Bộ khớp còn giới hạn ≤ 3 lượt/phút theo dấu vết máy và theo IP (băm, chỉ RAM).
          recordQrOpen(code, { target, visitor })
            .then(entry => {
              if (entry && target === 'messenger') qrBridgeMatcher.noteClick({ code, visitor, ip: qrVisitorKey(clientIp(request), '') });
            })
            .catch(error => console.error(`QR: không ghi được lượt bấm ${code}: ${error.message}`));
        }
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        return response.end();
      }
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Chỉ nhận GET.' });
      const userAgent = String(request.headers['user-agent'] || '');
      const classification = classifyUserAgent(userAgent);
      // R13 fix2 (A2): không còn 302 thẳng cho Chrome Android (qr-bridge.mjs shouldRedirectDirectly): mọi máy qua trang đệm, lượt
      // "bấm nút" (beacon) mới là bằng chứng người thật — HEAD của công cụ giám sát hay crawler mang UA Android từng thành lượt
      // bấm chờ khớp và khách lạ nhắn sau đó nhận ưu đãi.
      // Đếm trước, nhưng không để việc ghi đĩa làm khách phải chờ. Máy xem trước
      // liên kết (khách dán link vào Zalo/Messenger) không phải lượt quét.
      // `?from=inapp`: khách mở LẠI trang này bằng Safari từ trong Zalo/Facebook… (nút "Mở bằng Safari" hay
      // dán liên kết đã sao chép) — cùng một lượt quét, đã đếm ở lần tải đầu.
      const reopened = url.searchParams.get('from') === 'inapp';
      if (headRequest) {
        console.log(`QR: bỏ qua đếm ${code}: HEAD (giám sát / xem trước), không phải lượt quét`);
      } else if (isLinkPreviewBot(userAgent)) {
        console.log(`QR: bỏ qua đếm ${code}: máy xem trước / máy quét (${userAgent.slice(0, 60) || 'UA rỗng'})`);
      } else if (reopened) {
        console.log(`QR: mở lại ${code} bằng trình duyệt từ trong app (${classification.platform}/${classification.browser}), không đếm thêm lượt quét`);
      } else if (staffScan) {
        console.log(`QR: bỏ qua đếm ${code}: máy nhân viên (đã đăng nhập CRM) quét thử`);
      } else {
        recordQrScan(code, { userAgent, mode: 'page' })
          .catch(error => console.error(`QR: không ghi được lượt quét ${code}: ${error.message}`));
      }
      let page;
      try {
        page = await resolveQrPage();
      } catch (error) {
        console.error(`QR: không đọc được kho kênh để biết Page: ${error.message}`);
        page = { id: '' };
      }
      if (!page.id) {
        console.error('QR: chưa có Page nào kết nối nên không biết đưa khách đi đâu.');
        return sendQrNotice(503, 'Giọt Nắng', 'Trang nhắn tin đang được cập nhật. Bạn vui lòng thử lại sau ít phút, hoặc tìm "Giọt Nắng" trên Facebook để nhắn cho shop nhé.');
      }
      const { zaloUrl, prefillText } = await readQrSettings();
      // ref kiểu Pancake + tin soạn sẵn mang #mã: Pancake ghi nguồn truy cập, và
      // tin khách gửi về CRM qua webhook Pancake mang theo mã lô. Chưa đặt tin soạn sẵn thì dùng mẫu mặc
      // định — link không có `text=` là mất đường duy nhất không phụ thuộc Meta để nhận ra khách quét thẻ.
      const destination = messengerDestination({ pageId: page.id, code, pageName: page.name, prefillText: prefillTemplateOrDefault(prefillText) });
      console.log(`QR: lượt quét ${code} (${classification.platform}/${classification.browser}${classification.inApp ? ', trong app' : ''}) -> trang đệm`);
      const html = renderBridgePage({
        code,
        destination,
        pageName: page.name,
        fallbackUrl: `https://www.facebook.com/${encodeURIComponent(page.id)}`,
        zaloUrl,
        classification,
        // iPhone trong app: địa chỉ https của chính trang này cho nút "Mở bằng Safari" / "Sao chép liên kết".
        pageUrl: metaConfig.publicBaseUrl.startsWith('https://') ? `${metaConfig.publicBaseUrl}/q/${encodeURIComponent(code)}?from=inapp` : '',
        iosVersion: iosMajorVersion(userAgent)
      });
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
        'Referrer-Policy': 'no-referrer'
      });
      return response.end(html);
    }
    // Đối chiếu lượt quét với số referral Messenger thật sự nhận được.
    if (request.method === 'GET' && url.pathname === '/api/qr/stats') {
      const store = await readMessagingStore();
      // Một lượt quét = một referral, dù về CRM qua mấy đường (Meta, Botcake, tin soạn sẵn).
      const conversations = store.conversations || [];
      const stats = await listQrScans(countQrReferrals(conversations), { referralDays: countQrReferralsByDay(conversations) });
      const page = await resolveQrPage();
      const qrSettings = await readQrSettings();
      return sendJson(response, 200, {
        baseUrl: metaConfig.publicBaseUrl,
        pageId: page.id,
        pageName: page.name,
        today: qrDayKey(Date.now()),
        mainCode: qrMainCode,
        mainLabel: qrMainLabel,
        codes: stats.codes.map(entry => ({
          ...entry,
          url: qrTargetUrl(metaConfig.publicBaseUrl, entry.code),
          messengerUrl: page.id ? messengerDestination({ pageId: page.id, code: entry.code, pageName: page.name, prefillText: prefillTemplateOrDefault(qrSettings.prefillText) }) : '',
          prefillText: prefillMessageFor({ code: entry.code, pageName: page.name, template: prefillTemplateOrDefault(qrSettings.prefillText) })
        })),
        recent: stats.recent
      });
    }
    // Cấu hình trang đệm (liên kết Zalo) — Cài đặt → Mã QR.
    if (url.pathname === '/api/qr/settings') {
      if (request.method === 'GET') return sendJson(response, 200, await readQrSettings());
      if (request.method === 'PUT') {
        if (!(await requireManager(request, response))) return;
        try {
          const payload = await readBody(request);
          const saved = await writeQrSettings({
            ...(payload?.zaloUrl !== undefined ? { zaloUrl: payload.zaloUrl } : {}),
            ...(payload?.prefillText !== undefined ? { prefillText: payload.prefillText } : {})
          });
          const changed = [payload?.zaloUrl !== undefined ? 'liên kết Zalo' : '', payload?.prefillText !== undefined ? 'tin soạn sẵn' : ''].filter(Boolean);
          audit(request, 'settings.qr', { target: { type: 'qr-settings', id: 'qr', name: 'Trang đệm QR' }, summary: `Sửa trang đệm QR: ${changed.join(', ') || 'không đổi'}.` });
          return sendJson(response, 200, saved);
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }
      }
    }
    // Ảnh mã QR để in lên thẻ: mã hoá /q/<mã>. Sau mật khẩu (Caddy chỉ mở /q/*),
    // vì đây là công cụ của nhân viên, không phải của khách. SVG cho nhà in,
    // PNG (?size=, mặc định 1024) để xem nhanh hay dán vào thiết kế.
    // Tạo mã từ Cài đặt → Mã QR: mã có mặt trong bảng ngay với 0 lượt quét, không cần tải ảnh trước.
    if (request.method === 'POST' && url.pathname === '/api/qr/codes') {
      if (!(await requireManager(request, response))) return;
      try {
        const payload = await readBody(request);
        const code = String(payload?.code || '').trim().toLowerCase();
        if (!isValidQrCode(code)) return sendJson(response, 400, { error: 'Mã QR chỉ gồm chữ thường, số và gạch nối, tối đa 40 ký tự.' });
        const created = await registerQrCode(code);
        if (created) audit(request, 'settings.qr', { target: { type: 'qr-code', id: code, name: code }, summary: `Tạo mã QR ${code}.` });
        return sendJson(response, created ? 201 : 200, { code, created: Boolean(created) });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
    // Xoá mã gõ nhầm / lô không in (mất số liệu của mã đó).
    const qrDeleteMatch = url.pathname.match(/^\/api\/qr\/codes\/([^/]+)$/);
    if (qrDeleteMatch && request.method === 'DELETE') {
      if (!(await requireManager(request, response))) return;
      const code = decodeURIComponent(qrDeleteMatch[1]).toLowerCase();
      if (!isValidQrCode(code)) return sendJson(response, 400, { error: 'Mã QR chỉ gồm chữ thường, số và gạch nối, tối đa 40 ký tự.' });
      if (code === qrMainCode) return sendJson(response, 400, { error: `${code} là mã QR in trên thẻ, không xoá được.` });
      const deleted = await deleteQrCode(code);
      if (deleted) audit(request, 'settings.qr', { target: { type: 'qr-code', id: code, name: code }, summary: `Xóa mã QR ${code} (mất số liệu của mã).` });
      return sendJson(response, deleted ? 200 : 404, deleted ? { deleted: code } : { error: 'Không có mã này trong kho.' });
    }
    const qrImageMatch = url.pathname.match(/^\/api\/qr\/image\/([^/]+)\.(svg|png)$/);
    if (qrImageMatch && request.method === 'GET') {
      const code = decodeURIComponent(qrImageMatch[1]).toLowerCase();
      if (!isValidQrCode(code)) return sendJson(response, 400, { error: 'Mã QR chỉ gồm chữ thường, số và gạch nối, tối đa 40 ký tự.' });
      // R13 (L5): GET KHÔNG tạo mã nữa. Trước đây lấy ảnh = tạo mã, nên nhân viên thường (bị 403 ở POST /api/qr/codes)
      // vẫn tạo được mã bằng cách mở URL ảnh, và mở nhầm URL là sinh mã rác. Mã chính tự đăng ký lúc khởi động;
      // mã khác phải tạo ở Cài đặt → Mã QR (Quản trị) rồi mới lấy được ảnh.
      const knownQrCode = code === qrMainCode || (await listQrScans()).codes.some(entry => entry.code === code);
      if (!knownQrCode) return sendJson(response, 404, { error: 'Chưa có mã QR này. Tạo mã ở Cài đặt → Mã QR trước khi lấy ảnh.' });
      const target = qrTargetUrl(metaConfig.publicBaseUrl, code);
      const download = url.searchParams.get('download') === '1';
      const disposition = `${download ? 'attachment' : 'inline'}; filename="qr-${code}.${qrImageMatch[2]}"`;
      if (qrImageMatch[2] === 'svg') {
        response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Disposition': disposition, 'Cache-Control': 'private, max-age=3600' });
        return response.end(renderQrSvg(target));
      }
      const png = await renderQrPng(target, { size: Number(url.searchParams.get('size')) || 1024 });
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': disposition, 'Cache-Control': 'private, max-age=3600' });
      return response.end(png);
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
      if (!(await requireManager(request, response))) return;
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
      audit(request, 'settings.products', { target: { type: 'product', id: product.id, name: product.name }, summary: `Thêm sản phẩm ${product.name}${product.sku ? ` (${product.sku})` : ''}.` });
      return sendJson(response, 201, product);
    }
    const productMatch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
    if (productMatch && ['PUT', 'DELETE'].includes(request.method)) {
      if (!(await requireManager(request, response))) return;
      const payload = request.method === 'PUT' ? await readBody(request, 8 * 1024 * 1024) : null;
      let missing = false;
      let before = null;
      const result = await updateProductStore(async store => {
        const index = store.items.findIndex(product => product.id === productMatch[1]);
        if (index < 0) { missing = true; return undefined; }
        before = { ...store.items[index] };
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
      if (request.method === 'DELETE') {
        audit(request, 'settings.products', { target: { type: 'product', id: result.id, name: result.name }, summary: `Xóa sản phẩm ${result.name}${result.sku ? ` (${result.sku})` : ''}.` });
      } else {
        const fields = { name: 'tên', sku: 'mã', originalPrice: 'giá gốc', salePrice: 'giá bán', comboPrice: 'giá combo', weight: 'khối lượng', unit: 'đơn vị', aliases: 'tên gọi khác', mixable: 'cho phối', active: 'đang bán', image: 'ảnh', images: 'thư viện ảnh' };
        const changed = Object.entries(fields).filter(([key]) => JSON.stringify(before?.[key]) !== JSON.stringify(result?.[key])).map(([, label]) => label);
        const price = before?.salePrice !== result?.salePrice ? ` (giá bán ${Number(before?.salePrice) || 0} → ${Number(result?.salePrice) || 0})` : '';
        audit(request, 'settings.products', { target: { type: 'product', id: result.id, name: result.name }, summary: `Sửa sản phẩm ${result.name}: ${changed.join(', ') || 'không đổi'}${price}.` });
      }
      return sendJson(response, 200, result);
    }
    // Bám đuổi: trạng thái (bật từ khi nào, lần chạy cuối, các lần gửi gần nhất) và chạy tay một lượt.
    // Bộ test vàng: lô tin cần chấm, nạp thêm tin, ghi nhãn nhân viên chấm.
    if (request.method === 'GET' && url.pathname === '/api/chatbot/golden') {
      return sendJson(response, 200, { ...(await goldenSetOverview({ batch: Math.max(1, Math.min(50, Number(url.searchParams.get('batch')) || 10)) })), templateIds: Object.keys((await readChatbotSettings()).messageTemplates || {}) });
    }
    if (request.method === 'POST' && url.pathname === '/api/chatbot/golden/import') {
      if (!(await requireManager(request, response))) return;
      const payload = await readBody(request);
      const imported = await importGoldenItems(payload.items);
      audit(request, 'settings.golden', { summary: `Nạp ${Number(imported?.added) || 0} tin vào bộ test vàng (tổng ${Number(imported?.total) || 0}).` });
      return sendJson(response, 200, imported);
    }
    if (request.method === 'POST' && url.pathname === '/api/chatbot/golden/label') {
      if (!(await requireManager(request, response))) return;
      const payload = await readBody(request);
      try {
        const item = await labelGoldenItem(String(payload.id || ''), String(payload.label || ''));
        if (!item) return sendJson(response, 404, { error: 'Không thấy tin này trong bộ test.' });
        audit(request, 'settings.golden', { target: { type: 'golden-item', id: String(payload.id || ''), name: '' }, summary: `Chấm nhãn bộ test vàng: ${String(payload.label || '(bỏ nhãn)').slice(0, 60)}.` });
        return sendJson(response, 200, { item, ...(await goldenSetOverview({ batch: 10 })) });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/chatbot/follow-ups') {
      return sendJson(response, 200, await followUpStatus());
    }
    if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/run') {
      if (!(await requireManager(request, response))) return;
      const summary = await runFollowUps({ readSettings: readChatbotSettings, sendMessage: sendConversationMessage, conversationInfo: followUpConversationInfo });
      audit(request, 'followup.run', {
        summary: summary?.disabled ? 'Bấm Gửi ngay: bám đuổi đang tắt.' : summary?.quiet ? 'Bấm Gửi ngay: giờ yên lặng (22h–7h), không gửi.'
          : `Bấm Gửi ngay: xét ${Number(summary?.checked) || 0}, gửi ${Number(summary?.sent) || 0}, lỗi ${Number(summary?.failed) || 0}, bỏ qua ${Number(summary?.skipped) || 0}.`,
        details: { sent: Number(summary?.sent) || 0, failed: Number(summary?.failed) || 0 }
      });
      return sendJson(response, 200, { ...summary, status: await followUpStatus() });
    }
    // Hàng chờ ngoài 24 giờ: nhân viên gửi trong Pancake rồi bấm "Đã gửi" (hay "Bỏ qua").
    if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/queue') {
      if (!(await requireManager(request, response))) return;
      const payload = await readBody(request);
      const action = payload.action === 'skip' ? 'skip' : 'sent';
      const done = await resolveFollowUpQueueItem(String(payload.key || ''), action, { readSettings: readChatbotSettings });
      if (!done) return sendJson(response, 404, { error: 'Tin này không còn trong hàng chờ.' });
      audit(request, 'followup.queue', { target: { type: 'follow-up', id: String(payload.key || ''), name: '' }, summary: action === 'skip' ? 'Bỏ qua tin bám đuổi trong hàng chờ.' : 'Đánh dấu đã gửi tin bám đuổi (gửi tay trong Pancake).' });
      return sendJson(response, 200, await followUpStatus());
    }
    // Trạm gửi Pancake: lô gửi (ID Facebook lấy lại từ Pancake, khách đã có đơn thì bỏ)
    // và kết quả dấu trang "Gửi bám đuổi" báo về sau khi extension Pancake gửi xong.
    if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/batch') {
      if (!(await requireManager(request, response))) return;
      const payload = await readBody(request);
      const batch = await buildFollowUpBatch({ limit: payload.limit, readSettings: readChatbotSettings, conversationInfo: followUpConversationInfo });
      audit(request, 'followup.batch', { summary: `Lấy lô bám đuổi cho trạm Pancake: ${Array.isArray(batch?.items) ? batch.items.length : 0} khách (còn ${Number(batch?.remaining) || 0}).` });
      return sendJson(response, 200, batch);
    }
    // Dọn hàng chờ ngay: tra lại khách chưa xét, khách cũ (đã từng mua) bỏ khỏi hàng.
    if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/prune') {
      if (!(await requireManager(request, response))) return;
      const payload = await readBody(request);
      const result = await pruneReturningFromQueue({ conversationInfo: followUpConversationInfo, limit: Math.max(1, Math.min(300, Number(payload.limit) || 100)) });
      console.log(`Bám đuổi: dọn hàng chờ, xét ${result.checked}, bỏ ${result.removed} khách cũ`);
      audit(request, 'followup.prune', { summary: `Dọn hàng chờ bám đuổi: xét ${result.checked}, bỏ ${result.removed} khách cũ.` });
      return sendJson(response, 200, { ...result, status: await followUpStatus() });
    }
    if (request.method === 'POST' && url.pathname === '/api/chatbot/follow-ups/batch-results') {
      const payload = await readBody(request);
      const summary = await recordFollowUpBatchResults(payload.results, { readSettings: readChatbotSettings, token: String(payload.token || '') });
      // R14: kèm lý do lỗi (ngắn, che SĐT, tối đa 3 lý do khác nhau) — trước đây chỉ có số đếm, không biết vì sao lỗi.
      const relayErrors = summary.failed ? followUpRelayErrorText(payload.results) : '';
      console.log(`Bám đuổi qua trạm Pancake: gửi ${summary.sent}, lỗi ${summary.failed} (bỏ ${summary.dropped}${summary.rejected ? `, sai mã lô ${summary.rejected}` : ''})${relayErrors ? ` — lý do: ${relayErrors}` : ''}`);
      audit(request, 'followup.batch_results', { summary: `Trạm Pancake gửi bám đuổi: gửi ${summary.sent}, lỗi ${summary.failed}, bỏ ${summary.dropped}${summary.rejected ? `, sai mã lô ${summary.rejected}` : ''}.`, details: { sent: Number(summary.sent) || 0, failed: Number(summary.failed) || 0 } });
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
      if (!(await requireManager(request, response))) return;
      const current = await readChatbotSettings();
      const payload = await readBody(request);
      const directEndpoint = String(payload.directEndpoint || current.directEndpoint || '');
      const providerChanged = payload.provider && payload.provider !== current.provider;
      // Chỉ kiểm/tra DNS endpoint AI khi phần kết nối AI thật sự đổi: lưu từ khóa khiếu nại
      // hay bám đuổi không được hỏng vì DNS chập chờn.
      const connectionChanged = Boolean(providerChanged)
        || (payload.directEndpoint && String(payload.directEndpoint) !== String(current.directEndpoint || ''))
        || (payload.directModel && String(payload.directModel) !== String(current.directModel || ''))
        || (payload.directAuthType && String(payload.directAuthType) !== String(current.directAuthType || ''));
      if (connectionChanged) {
        try {
          assertUsableAiEndpoint(directEndpoint, {
            provider: payload.provider || current.provider,
            authType: payload.directAuthType || current.directAuthType
          });
          await assertPublicHost(new URL(directEndpoint).hostname);
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }
      }
      // Chặn trộm khóa AI: đổi endpoint mà không nhập lại khóa → khóa cũ KHÔNG được mang sang địa chỉ mới.
      const keyReentryError = aiKeyReentryError(current, normalizeChatbotSettings({ ...mergeChatbotSettingsPatch(current, payload), directApiKey: current.directApiKey }), payload);
      if (keyReentryError) return sendJson(response, 400, { error: keyReentryError });
      // Gộp sâu bản vá (followUps, contextTrim; khóa không gửi/null giữ giá trị cũ —
      // handoffKeywords không bị xóa khi form không gửi).
      const settings = await writeChatbotSettings({
        ...mergeChatbotSettingsPatch(current, payload),
        // R13 (C2): GỘP theo từng mã mẫu (mã không gửi giữ nguyên, null = về mặc định / xoá mẫu tự tạo), không thay cả bộ.
        messageTemplates: mergeMessageTemplatesPatch(current.messageTemplates, payload.messageTemplates),
        directApiKey: String(payload.directApiKey || '').trim() || (providerChanged ? '' : current.directApiKey),
        updatedAt: Date.now()
      });
      // Bám đuổi vừa bật lại: tính từ bây giờ, không gửi dồn cho khách cũ.
      if (settings.followUps?.enabled && !current.followUps?.enabled) await resetFollowUpActivation();
      audit(request, 'settings.chatbot', { target: { type: 'settings', id: 'chatbot', name: 'Cài đặt chatbot' }, summary: chatbotSettingsChangeText(current, settings, payload) });
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
      if (!(await requireManager(request, response))) return;
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
      audit(request, 'settings.chatbot', {
        target: { type: 'settings', id: 'chatbot', name: 'Công tắc chatbot' },
        summary: `${enabled ? 'BẬT' : 'TẮT'} chatbot cho mọi hội thoại (${summary.changed}/${summary.total} hội thoại được đặt lại).`,
        details: { enabled, changed: summary.changed, total: summary.total }
      });
      return sendJson(response, 200, { enabled: settings.enabled === true, conversations: summary.total, changed: summary.changed });
    }
    if (request.method === 'POST' && url.pathname === '/api/chatbot/test') {
      if (!(await requireManager(request, response))) return;
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
      let reply;
      try {
        reply = await requestDirectModelReply({
          settings,
          conversation: { id: 'preview', name: 'Khách xem trước', botEnabled: true },
          message: imageUrl ? { type: 'image', text, dataUrl: imageUrl } : { type: 'text', text },
          recentMessages,
          rawResponse: true
        });
      } catch (error) {
        // Thiếu tệp khoá Vertex (ENOENT …vertex.json), mạng, nhà cung cấp lỗi: chi tiết vào log, giao diện thấy câu chung.
        console.error('Thử chatbot: gọi mô hình lỗi:', error?.message || error);
        // Lỗi hệ thống (có .code: ENOENT, EACCES…) → câu chung; lỗi nhà cung cấp (sai mô hình, 429…) giữ để Quản trị sửa cấu hình.
        return sendJson(response, 502, { error: typeof error?.code === 'string' ? friendlyAiTestError(error) : `Chưa gọi được mô hình AI: ${error?.message || error}` });
      }
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
          // Kết quả đồng bộ gần nhất (pancake.mjs): syncedAt (ISO), syncError ('' khi ổn), syncErrorAt (ms) — token
          // hết hạn / Pancake chặn thì Cài đặt → Kênh báo lỗi thay vì chấm xanh mãi.
          ...(isPancakeConfigured() ? (pancakeConfig.pages?.length ? pancakeConfig.pages : [pancakeConfig]).map(p => ({ id: p.pageId, name: p.pageName, picture: p.picture || defaultPicture, platform: 'facebook', via: 'pancake', status: 'connected', subscribed: true, subscribedFields: [], subscriptionError: '', connectedAt: 0, checkedAt: 0, syncedAt: '', syncError: '', syncErrorAt: 0, ...(pancakeSyncStatusFor(p.pageId) || {}) })) : [])
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
      const metaError = String(url.searchParams.get('error_description') || '').slice(0, 200);
      // Chỉ hiện lỗi Meta khi state hợp lệ: link giả `?error_description=...` không đưa được thông điệp lạ vào giao diện.
      if (metaError && state && metaOauthStates.has(state)) { metaOauthStates.delete(state); return redirect(response, `/?meta_error=${encodeURIComponent(metaError)}#settings`); }
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
      if (!(await requireManager(request, response))) return;
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
          await subscribePageToApp(page.id, page.accessToken, subscriptionFieldsFor(page.id));
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
      audit(request, 'settings.channels', { target: { type: 'channel', id: connected.map(page => page.id).join(','), name: connected.map(page => page.name).join(', ') }, summary: `Kết nối Facebook Page: ${connected.map(page => `${page.name}${page.subscribed ? '' : ' (chưa đăng ký webhook)'}`).join(', ')}.` });
      return sendJson(response, 200, { items: store.items.map(publicChannel) });
    }
    const channelMatch = url.pathname.match(/^\/api\/channels\/facebook\/([^/]+)$/);
    if (request.method === 'DELETE' && channelMatch) {
      if (!(await requireManager(request, response))) return;
      const store = await readChannelStore();
      const pageId = decodeURIComponent(channelMatch[1]);
      const channel = store.items.find(item => item.id === pageId);
      if (!channel) return sendJson(response, 404, { error: 'Không tìm thấy Facebook Page đã kết nối.' });
      try {
        await unsubscribePageFromApp(pageId, await getPageAccessToken(pageId));
      } catch { /* The local connection can still be removed if Meta is unavailable. */ }
      store.items = store.items.filter(item => item.id !== pageId);
      await writeChannelStore(store);
      audit(request, 'settings.channels', { target: { type: 'channel', id: pageId, name: channel.name || '' }, summary: `Ngắt kết nối Facebook Page ${channel.name || pageId}.` });
      return sendJson(response, 200, { items: store.items.map(publicChannel) });
    }
    // Cài đặt → Kênh → Tải ảnh khách: retry avatars for threads still showing a letter.
    const profilesChannelMatch = url.pathname.match(/^\/api\/channels\/facebook\/([^/]+)\/profiles$/);
    if (request.method === 'POST' && profilesChannelMatch) {
      if (!(await requireManager(request, response))) return;
      try {
        const profilePageId = decodeURIComponent(profilesChannelMatch[1]);
        const refreshed = await refreshCustomerProfiles(profilePageId);
        audit(request, 'settings.channels', { target: { type: 'channel', id: profilePageId, name: '' }, summary: `Tải lại ảnh/tên khách cho Page ${profilePageId}.` });
        return sendJson(response, 200, refreshed);
      } catch (error) {
        return sendJson(response, 502, { error: error.message });
      }
    }
    const refreshChannelMatch = url.pathname.match(/^\/api\/channels\/facebook\/([^/]+)\/refresh$/);
    if (request.method === 'POST' && refreshChannelMatch) {
      if (!(await requireManager(request, response))) return;
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
        const requiredFields = subscriptionFieldsFor(pageId).split(',').map(field => field.trim()).filter(Boolean);
        const missingFields = requiredFields.filter(field => !subscription.fields.includes(field));
        // Page chỉ nhận referral (vận hành ở Pancake) mà đang đăng ký thừa trường
        // `messages`… thì thu lại, kẻo hộp thư nhận tin hai lần.
        const extraFields = isReferralOnlyPage(pageId) ? subscription.fields.filter(field => !requiredFields.includes(field)) : [];
        if (!subscription.subscribed || missingFields.length || extraFields.length) {
          try {
            await subscribePageToApp(pageId, pageAccessToken, subscriptionFieldsFor(pageId));
            subscription = await fetchPageSubscription(pageId, pageAccessToken);
            channel.subscriptionError = '';
          } catch (subscribeError) {
            channel.subscriptionError = subscribeError.message;
            // Page chỉ nghe referral: Meta không nhận bộ trường có `standby` thì đăng ký lại bộ cũ để vẫn
            // nhận referral của khách cũ; giữ lời báo lỗi để biết standby chưa bật được.
            if (isReferralOnlyPage(pageId) && metaConfig.referralOnlyFallbackFields !== subscriptionFieldsFor(pageId)) {
              try {
                await subscribePageToApp(pageId, pageAccessToken, metaConfig.referralOnlyFallbackFields);
                subscription = await fetchPageSubscription(pageId, pageAccessToken);
                channel.subscriptionError = `Chưa bật được kênh standby (khách mới quét thẻ chưa được chào chủ động): ${subscribeError.message}`;
                console.error(`Meta: Page ${pageId} không đăng ký được trường standby, đã đăng ký lại bộ cũ: ${subscribeError.message}`);
              } catch (fallbackError) {
                channel.subscriptionError = fallbackError.message;
              }
            }
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
      audit(request, 'settings.channels', { target: { type: 'channel', id: pageId, name: channel.name || '' }, summary: `Kiểm tra lại kết nối Page ${channel.name || pageId}: ${channel.status === 'connected' ? 'đang kết nối' : 'cần xử lý'}.` });
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
      // Token đã đúng, thân đã đọc: trả 200 NGAY rồi mới tạo đơn ở nền. Tạo đơn có tự điền địa chỉ
      // và tra cảnh báo SĐT trên POS (gọi mạng), từng làm webhook trả lời quá 5 giây → Webcake gửi lại.
      // Kết quả (tạo / trùng / lỗi) xem ở Cài đặt → landing (danh sách gói gần đây) và nhật ký máy chủ;
      // đơn lọt (máy chủ tắt giữa chừng) vẫn được đồng bộ POS 5 phút một lần kéo về.
      sendJson(response, 200, { accepted: true, queued: true });
      processLandingWebhookInBackground(payload, page);
      return undefined;
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
      // R13 (T5): kèm trạng thái lượt đồng bộ POS gần nhất (cảnh báo chạm trần trang, lỗi).
      return sendJson(response, 200, { ...posStatus(), sync: posSyncStatus() });
    }
    if (request.method === 'POST' && url.pathname === '/api/phone-warnings/pos') {
      if (!(await requireManager(request, response))) return;
      const payload = await readBody(request);
      try {
        const connected = await connectPos({ apiKey: payload.apiKey, shopId: payload.shopId });
        // Không ghi khoá API: chỉ ghi là đã kết nối (và mã shop nếu có).
        audit(request, 'settings.pos', { target: { type: 'pos', id: String(payload.shopId || ''), name: 'Pancake POS' }, summary: `Kết nối Pancake POS${payload.shopId ? ` (shop ${String(payload.shopId).slice(0, 20)})` : ''}.` });
        return sendJson(response, 200, connected);
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
    if (request.method === 'DELETE' && url.pathname === '/api/phone-warnings/pos') {
      if (!(await requireManager(request, response))) return;
      const disconnected = await disconnectPos();
      audit(request, 'settings.pos', { target: { type: 'pos', id: '', name: 'Pancake POS' }, summary: 'Ngắt kết nối Pancake POS.' });
      return sendJson(response, 200, disconnected);
    }
    // Kéo đơn landing từ POS ngay (mặc định 48 giờ gần nhất); bình thường chạy tự động mỗi 5 phút.
    if (request.method === 'POST' && url.pathname === '/api/landing/sync-pos') {
      const payload = await readBody(request);
      const sinceHours = Math.min(24 * 30, Math.max(1, Number(payload.sinceHours) || 48));
      const summary = await syncPosLandingOrders({ sinceHours });
      if (!summary?.disabled) recordPosSyncStatus(summary);
      if (summary?.warnings?.length) console.warn(`Đồng bộ POS (tay) CẢNH BÁO: ${summary.warnings.join('; ')}`);
      audit(request, 'landing.sync_pos', { summary: `Kéo đơn landing từ POS (${sinceHours} giờ): mới ${Number(summary?.created) || 0}, cập nhật ${Number(summary?.updated) || 0}, hủy ${Number(summary?.cancelled) || 0}.` });
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
          // Đường công khai, đọc thân TRƯỚC khi xác thực: giới hạn 1 MB để không bị dồn bộ nhớ (gói Pancake thường vài KB).
          payload = await readBody(request, 1024 * 1024);
        } catch (error) {
          console.error(`Webhook Pancake thân không đọc được (content-length ${request.headers['content-length'] || '?'}):`, error.message);
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
        // Gói không token: nhận theo page_id khi đường webhook là đường bí mật; ở đường mặc định (đoán được)
        // vẫn nhận kèm cảnh báo, trừ khi đã bật PANCAKE_WEBHOOK_REQUIRE_SECRET=1 (app/server-helpers.mjs).
        const decision = pancakeWebhookDecision({
          configured: isPancakeConfigured(), tokenValid, pageValid,
          secretPath: !pancakeConfig.defaultPath, strict: pancakeConfig.requireSecret
        });
        if (!decision.accept) {
          if (decision.reason === 'token-mismatch') console.warn('Webhook Pancake token không khớp, bỏ qua (page', pageId || '?', ')');
          else if (decision.reason === 'default-path-no-token' && Date.now() - pancakeNoTokenWarnedAt > 60 * 60 * 1000) {
            pancakeNoTokenWarnedAt = Date.now();
            console.warn(`Webhook Pancake không có token ở đường mặc định ${pancakeConfig.path}: bỏ qua (PANCAKE_WEBHOOK_REQUIRE_SECRET=1). Đặt PANCAKE_WEBHOOK_PATH bí mật trong .env và cùng URL đó ở Pancake → Webhook.`);
          }
          // Pancake tạm ngưng webhook khi gặp mã lỗi liên tiếp (26/09: hai lần 401 lúc khởi động lại
          // → webhook im 35 phút). Gói lạ vẫn trả 200 và bỏ qua; chỉ báo 503 khi chưa cấu hình Pancake.
          response.writeHead(decision.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          return response.end(decision.status === 503 ? '{"error":"Pancake webhook is not configured"}' : '{"received":false}');
        }
        // Pancake không gửi token (hành vi đã biết) ở đường mặc định: ghi 1 dòng/giờ, không phủ đầy log.
        if (decision.warn && payload?.event_type && payload.event_type !== 'verify' && Date.now() - pancakeNoTokenWarnedAt > 60 * 60 * 1000) {
          pancakeNoTokenWarnedAt = Date.now();
          console.warn(`Webhook Pancake không có token, nhận theo page_id ${pageId} ở đường MẶC ĐỊNH ${pancakeConfig.path} (ai biết page_id cũng gửi giả được). Đặt PANCAKE_WEBHOOK_PATH bí mật trong .env và cùng URL đó ở Pancake → Webhook.`);
        }
        // Luôn trả 200 (Pancake tạm ngưng webhook khi >80% lần gọi lỗi); thân hỏng chỉ ghi log.
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('{"received":true}');
        if (!payload || !payload.event_type || payload.event_type === 'verify') return undefined;
        // Chẩn đoán cấu trúc gói tin: chỉ PANCAKE_DEBUG_KEYS=1 mới bật, tối đa 30 dòng/phút.
        if (debugFlagOn('PANCAKE_DEBUG_KEYS') && pancakeDebugAllowed()) console.log(describePancakePayload(payload));
        // Hội thoại mới đang giữ một lượt bấm nút trang đệm (khách mới quét thẻ): chào SAU khi bot trả lời xong.
        let qrBridgeHeld = [];
        try {
          const summary = await handlePancakeWebhook(payload, {
            processChatbotChanges,
            chatbotDependencies,
            // Khách quét QR gửi tin soạn sẵn mang #mã: chào bằng QR_OFFER như
            // luồng Meta, và không đưa chính tin đó cho bot (kẻo khách nhận hai tin).
            // Khách mới khớp lượt bấm (không mang mã): bot VẪN trả lời tin đầu như thường, ưu đãi đi sau.
            beforeBot: async changes => {
              scheduleQrGreetings(changes);
              qrBridgeHeld = await considerQrBridgeClicks(changes);
              return changes.filter(change => !isCardScan(change));
            }
          });
          if (summary.stored) console.log(`Webhook Pancake: ghi ${summary.stored} tin, đưa bot ${summary.bot}`);
        } catch (error) {
          console.error('Webhook Pancake xử lý lỗi:', error.message);
        } finally {
          qrBridgeMatcher.botDone(qrBridgeHeld);
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
        // Hẹn chào khách quét thẻ và trả luồng về app mặc định (kể cả sự kiện không phải lượt quét thẻ).
        handleMetaQrChanges(changes);
        // R13 fix2 (A1): referral Meta của thẻ về → lượt bấm trang đệm của lượt quét đó không còn treo chờ hội thoại mới.
        qrBridgeMatcher.noteReferral(changes).catch(error => console.error(`QR: lỗi khi tiêu lượt bấm theo referral Meta: ${error.message}`));
        // Khách quét phiếu đã có tin ưu đãi riêng; để bot chào thêm câu chung
        // nữa là khách nhận hai tin trong mười giây. Những tin sau của họ vẫn
        // đi qua bot bình thường — chỉ bỏ qua đúng sự kiện mở hội thoại.
        // Page chỉ nghe referral (vận hành ở Pancake, META_REFERRAL_ONLY_PAGES):
        // tin khách về qua Pancake rồi; postback "Bắt đầu" từ Meta mà đưa bot
        // là trả lời chồng lên Botcake và mở hội thoại Meta song song.
        // Sự kiện tới qua `standby` (app khác là Primary Receiver, đang giữ luồng): chỉ ghi nhận và chào
        // QR ở trên, bot không trả lời.
        await processChatbotChanges(
          changes.filter(change => !change.standby && !isCardScan(change) && !isReferralOnlyPage(change.conversation?.pageId)),
          chatbotDependencies
        );
      } catch (error) {
        console.error('Webhook processing failed:', error.message);
      }
      return undefined;
    }
    // Khách hàng: every person who has messaged or commented, one row per Page.
    // Quản lý chiến dịch: chi tiêu quảng cáo (Marketing API, chỉ đọc) ghép với đơn thật → CPA/ROAS.
    if (request.method === 'GET' && url.pathname === '/api/campaigns') {
      // from/to (YYYY-MM-DD, giờ Việt Nam) nếu có thì dùng thay cho days.
      const report = await loadCampaignReport({
        days: normalizeRangeDays(url.searchParams.get('days')),
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined
      });
      // Lỗi lần đồng bộ cuối (ads.error) hiện cho chủ shop bằng câu dễ hiểu; nguyên văn đã ghi log lúc đồng bộ.
      return sendJson(response, 200, report && typeof report === 'object' ? { ...report, ads: friendlyAdsStatus(report.ads) } : report);
    }
    // Tổng quan: hôm nay / 7 / 30 ngày, hoặc from/to tự chọn (YYYY-MM-DD giờ Việt Nam,
    // tính cả ngày cuối, tối đa 366 ngày), so với kỳ liền trước cùng độ dài (dashboard.mjs).
    if (request.method === 'GET' && url.pathname === '/api/dashboard') {
      const from = url.searchParams.get('from') || undefined;
      const to = url.searchParams.get('to') || undefined;
      if ((from || to) && !normalizeDashboardCustomRange(from, to)) {
        return sendJson(response, 400, { error: 'Khoảng ngày không hợp lệ: cần cả "từ ngày" và "đến ngày" dạng YYYY-MM-DD.' });
      }
      return sendJson(response, 200, await loadDashboard({ days: normalizeDashboardDays(url.searchParams.get('days')), from, to }));
    }
    // Báo cáo: doanh số theo ngày/tuần/tháng, nguồn, sản phẩm, khách, nhân viên, chiến dịch (reports.mjs).
    if (request.method === 'GET' && (url.pathname === '/api/reports' || url.pathname === '/api/reports/export.csv')) {
      const report = await loadReport({
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        groupBy: url.searchParams.get('groupBy') || undefined
      });
      if (url.pathname === '/api/reports') return sendJson(response, 200, report);
      const section = normalizeReportSection(url.searchParams.get('section'));
      audit(request, 'report.export', { summary: `Tải CSV báo cáo "${section}" (${url.searchParams.get('from') || '…'} → ${url.searchParams.get('to') || '…'}).` });
      response.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${reportCsvFileName(section, report.range)}"`,
        'Cache-Control': 'no-store'
      });
      return response.end(reportSectionCsv(report, section));
    }
    // Báo cáo Lark thủ công: chủ shop dán một đoạn hội thoại trong Cài đặt → Báo cáo Lark.
    // Webhook chỉ ở .env phía máy chủ; nội dung hội thoại không được ghi vào audit log.
    if (request.method === 'POST' && url.pathname === '/api/reports/lark/conversation') {
      if (!(await requireManager(request, response))) return;
      const payload = await readBody(request, 32 * 1024);
      const conversationReport = normalizeLarkConversationReport(payload);
      const actor = await requestActor(request);
      const { webhookUrl } = larkReportConfig();
      if (!webhookUrl) return sendJson(response, 503, { error: 'Chưa cấu hình webhook báo cáo Lark trên máy chủ.' });
      try {
        await sendLarkConversationReport(conversationReport, { webhookUrl, reporter: actor.name });
      } catch (error) {
        console.warn(`Gửi đoạn hội thoại tới Lark lỗi: ${error.message}`);
        return sendJson(response, 502, { error: 'Chưa gửi được báo cáo tới Lark. Vui lòng thử lại.' });
      }
      audit(request, 'report.lark_conversation', {
        target: { type: 'lark-report', id: '', name: conversationReport.title || 'Đoạn hội thoại' },
        summary: `Gửi đoạn hội thoại qua Lark (${conversationReport.conversation.length} ký tự).`
      }, actor);
      return sendJson(response, 200, { ok: true, sentAt: Date.now() });
    }
    // Đồng bộ quảng cáo và Cố vấn AI (tốn lượt gọi Meta/Vertex): chỉ chủ shop / Quản trị (quyết định 01/10).
    if (request.method === 'POST' && url.pathname === '/api/campaigns/sync') {
      if (!(await requireManager(request, response))) return;
      const payload = await readBody(request);
      const days = normalizeRangeDays(payload.days);
      try {
        await syncAdInsights({ days });
      } catch (error) {
        return sendAdsSyncError(response, days, error);
      }
      audit(request, 'campaign.sync', { summary: `Đồng bộ số liệu quảng cáo ${days} ngày.` });
      const report = await loadCampaignReport({ days });
      return sendJson(response, 200, report && typeof report === 'object' ? { ...report, ads: friendlyAdsStatus(report.ads) } : report);
    }
    if (request.method === 'GET' && url.pathname === '/api/campaigns/insights') {
      return sendJson(response, 200, friendlyCampaignInsights(await readCampaignInsights()));
    }
    if (request.method === 'POST' && url.pathname === '/api/campaigns/insights') {
      if (!(await requireManager(request, response))) return;
      const payload = await readBody(request);
      const days = normalizeRangeDays(payload.days);
      const report = await loadCampaignReport({ days });
      const insights = await generateCampaignInsights(report, { days });
      if (insights?.error) console.warn(`Cố vấn AI chiến dịch: mô hình lỗi, dùng gợi ý theo luật — ${insights.error}`);
      audit(request, 'campaign.insights', { summary: `Nhờ AI phân tích chiến dịch ${days} ngày.` });
      return sendJson(response, 200, friendlyCampaignInsights(insights));
    }
    // Tải danh sách khách ra tệp (toàn bộ tên/SĐT/địa chỉ): chỉ chủ shop / Quản trị (quyết định 01/10).
    // Xem danh sách trên màn Khách hàng (/api/customers) vẫn mở cho nhân viên.
    if (request.method === 'GET' && (url.pathname === '/api/customers/export.csv' || url.pathname === '/api/customers/audience.csv')) {
      if (!(await requireManager(request, response, 'Chỉ chủ shop hoặc Quản trị mới tải được danh sách khách hàng.'))) return;
    }
    if (request.method === 'GET' && (url.pathname === '/api/customers' || url.pathname === '/api/customers/export.csv' || url.pathname === '/api/customers/audience.csv')) {
      const filters = Object.fromEntries([
        'q', 'channelId', 'source', 'gender', 'label', 'activeWithin',
        // Remarketing: mua trong N ngày, mua sản phẩm nào, combo mấy túi, mua mấy lần.
        'orderedWithin', 'product', 'combo', 'minOrders'
      ].map(key => [key, url.searchParams.get(key) || '']));
      const result = await listCustomers(filters);
      // Tải danh sách khách (dữ liệu cá nhân) ra tệp: ghi nhật ký ai tải, bao nhiêu khách, lọc gì.
      if (url.pathname.endsWith('.csv')) {
        const activeFilters = Object.entries(filters).filter(([, value]) => value).map(([key, value]) => `${key}=${String(value).slice(0, 30)}`);
        audit(request, 'customer.export', { summary: `Tải ${url.pathname.endsWith('audience.csv') ? 'tệp remarketing' : 'CSV khách hàng'}: ${(result.items || []).length} khách${activeFilters.length ? ` (lọc ${activeFilters.join(', ')})` : ''}.` });
      }
      if (url.pathname === '/api/customers/audience.csv') {
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="remarketing-${vnDateStamp()}.csv"`,
          'Cache-Control': 'no-store'
        });
        return response.end(customersToAudienceCsv(result.items));
      }
      if (url.pathname.endsWith('.csv')) {
        const { labels } = await readInboxSettings();
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="khach-hang-${vnDateStamp()}.csv"`,
          'Cache-Control': 'no-store'
        });
        return response.end(customersToCsv(result.items, labels));
      }
      return sendJsonWithEtag(request, response, result);
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
        const actor = await requestActor(request);
        const patch = await readBody(request);
        const saved = await updateCustomerProfile(customer.editKey, patch, Date.now(), { by: actorStamp(actor) });
        invalidateBuyersCache();
        const fieldNames = { name: 'tên', phone: 'SĐT', address: 'địa chỉ', gender: 'giới tính' };
        const fields = Object.keys(fieldNames).filter(key => patch[key] !== undefined).map(key => (patch[key] === '' ? `bỏ ${fieldNames[key]} đã sửa` : fieldNames[key]));
        audit(request, 'customer.update', { target: { type: 'customer', id: customer.id, name: customer.name || '' }, summary: `Sửa thông tin khách: ${fields.join(', ') || 'không đổi'}.` }, actor);
        // warnings: cảnh báo không chặn của updateCustomerProfile (SĐT lạ…), rỗng khi không có.
        const fresh = await findCustomerById(customer.id);
        return sendJson(response, 200, fresh ? { ...fresh, warnings: Array.isArray(saved?.warnings) ? saved.warnings : [] } : fresh);
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
          const actor = await requestActor(request);
          await setCustomerLabels(customer.editKey, payload.labels || [], customer.derivedLabels, Date.now(), { by: actorStamp(actor), allowedIds: await allowedLabelIdSet() });
          invalidateBuyersCache();
          const fresh = await findCustomerById(customer.id);
          const change = labelChangeDetails(customer.labels || [], fresh?.labels || [], await inboxLabelDefs());
          audit(request, 'customer.labels', {
            target: { type: 'customer', id: customer.id, name: customer.name || '' },
            summary: `Thẻ khách: ${labelChangeText(change) || 'không đổi'}.`,
            details: { added: change.added, removed: change.removed }
          }, actor);
          return sendJson(response, 200, fresh);
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }
      }

      if (customerRoute[1] === 'notes') {
        if (request.method === 'GET') return sendJson(response, 200, { items: await listCustomerNotes(customer.editKey, { aliases: [customer.id] }) });
        if (request.method === 'POST') {
          try {
            const actor = await requestActor(request);
            const payload = await readBody(request);
            // Người viết ghi chú lấy từ phiên đăng nhập (chưa bật đăng nhập thì giữ tên gõ tay `by`).
            const note = await addCustomerNote(customer.editKey, { ...payload, ...(actor.username ? { author: actorStamp(actor) } : {}) });
            invalidateBuyersCache();
            audit(request, 'customer.note', { target: { type: 'customer', id: customer.id, name: customer.name || '' }, summary: `Ghi chú khách: ${String(note.text || '').slice(0, 80)}` }, actor);
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
        // Đơn đang nằm trong chính các hội thoại của khách (đơn bot/nhân viên chưa xuất kho, chưa vào kho lưu
        // trữ): trước 01/10 "Tổng số đơn 1" mà "Lịch sử đơn (0)". Bản ở tệp khách hàng / kho lưu trữ (nếu có) thắng.
        const conversationIds = new Set((customer.conversations || []).map(item => String(item?.id || '')));
        const liveOrders = conversationIds.size
          ? (await readMessagingStore()).conversations.filter(item => conversationIds.has(String(item.id))).flatMap(item => (Array.isArray(item.customerOrders) ? item.customerOrders : []))
          : [];
        if (!key && !liveOrders.length) return sendJson(response, 200, { items: [] });
        const names = new Map(getCatalogProducts().map(product => [product.sku, product.name]));
        // Tên sản phẩm của chính khách này là bản dự phòng khi SKU đã rời danh mục.
        for (const product of customer.products || []) if (product?.sku) names.set(product.sku, product.name);
        const productName = (sku, name) => name || names.get(String(sku || '')) || String(sku || '');

        // R13 (M3): tệp khách hàng lưu mã kèm tiền tố nguồn ("CB-…", "LP-…"), kho lưu trữ và hội thoại lưu mã trần →
        // khử trùng theo mã ĐÃ BỎ tiền tố (trước đây mỗi đơn đã xuất kho hiện hai lần).
        const byId = new Map();
        const exported = key ? (await listExportedCustomers()).find(person => customerPhoneKey(person.phone) === key) : null;
        for (const order of exported?.orders || []) {
          byId.set(orderHistoryKey(order.id), {
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
        const { items } = key ? await readOrderArchive({ limit: 0 }) : { items: [] };
        for (const record of items) {
          if (customerPhoneKey(record.phone) !== key || byId.has(orderHistoryKey(record.id))) continue;
          byId.set(orderHistoryKey(record.id), {
            id: String(record.id),
            at: Number(record.at) || 0,
            status: archiveStatusLabel(record.st),
            source: record.src || '',
            total: Number(record.total) || 0,
            products: (Array.isArray(record.items) ? record.items : []).map(([sku, quantity]) => ({
              sku: String(sku || ''), name: productName(sku, ''), quantity: Number(quantity) || 0
            }))
          });
        }
        for (const order of liveOrders) {
          if (!order?.id || byId.has(orderHistoryKey(order.id))) continue;
          byId.set(orderHistoryKey(order.id), {
            id: String(order.id),
            at: Number(order.createdAt) || 0,
            status: order.processingStatus === 'cancelled' ? 'Hủy' : String(order.status || 'Mới'),
            source: String(order.source || ''),
            total: Number(order.total) || 0,
            products: (Array.isArray(order.products) ? order.products : []).map(item => ({
              sku: String(item?.sku || ''), name: productName(item?.sku, item?.name), quantity: Number(item?.quantity) || 0
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
        if (!(await requireManager(request, response))) return;
        const current = await readInboxSettings();
        // Mẫu trả lời nhanh có thể kèm ảnh base64 tới 5 MB.
        const payload = await readBody(request, 16 * 1024 * 1024);
        try {
          const settings = await writeInboxSettings({
            labels: payload.labels ?? current.labels,
            quickReplies: payload.quickReplies ?? current.quickReplies
          }, saveProductImage);
          const parts = [];
          if (payload.labels !== undefined) {
            const change = labelChangeDetails((current.labels || []).map(label => label.id), (settings.labels || []).map(label => label.id), [...(current.labels || []), ...(settings.labels || [])]);
            parts.push(`thẻ hội thoại (${(settings.labels || []).length}${change.added.length || change.removed.length ? `: ${labelChangeText(change)}` : ''})`);
          }
          if (payload.quickReplies !== undefined) parts.push(`mẫu trả lời nhanh (${(current.quickReplies || []).length} → ${(settings.quickReplies || []).length})`);
          audit(request, 'settings.messages', { target: { type: 'settings', id: 'inbox', name: 'Cài đặt → Tin nhắn' }, summary: `Sửa ${parts.join(', ') || 'cài đặt tin nhắn'}.` });
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
      // Đồng bộ thủ công cũng đưa bot tin khách mới chưa ai trả lời (như lượt định kỳ).
      const summary = isPancake
        ? await syncPancakeConversations({ pageId, limit: Number(payload.limit) || 60, messagePages: 2, processChatbotChanges: syncBotHook, chatbotDependencies })
        : await syncPageConversations(pageId, { limit: Number(payload.limit) || 25 });
      audit(request, 'conversation.sync', { target: { type: 'channel', id: pageId, name: '' }, summary: `Bấm Đồng bộ hội thoại Page ${pageId}${isPancake ? ' (Pancake)' : ''}.` });
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
        const actor = await requestActor(request);
        // "Ai đã xem" trên chính hội thoại (mốc mới nhất; ghi kho tối đa 1 lần/phút/người).
        await recordConversationSeen(id, actor).catch(error => console.warn(`Không ghi được người xem hội thoại: ${error.message}`));
        // Nhật ký: cùng người + cùng hội thoại tối đa 1 dòng / 30 phút.
        if (shouldAuditView(actor.username || actor.ip, id)) audit(request, 'conversation.view', { target: conversationTarget(conversation), conversationId: id, summary: `Xem hội thoại ${conversation.name || id}.` }, actor);
        const viewed = actor.username ? await getConversation(id).catch(() => null) : null;
        return sendJson(response, 200, {
          conversation: publicConversation(viewed || conversation),
          // A comment thread shows comments only; private replies live in Messenger.
          items: conversation.source === 'comment' ? items.filter(item => !item.privateReply) : items
        });
      }
      if (request.method === 'POST') {
        // Ảnh/tài liệu/ghi âm ≤ 2 MB, video ≤ 20 MB gửi dạng base64 trong attachment.dataUrl (×1,37).
        const payload = await readBody(request, 32 * 1024 * 1024);
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
          const actor = await requestActor(request);
          // Cờ staff + đích danh người gửi (staffName = họ tên, staffUsername); chưa bật đăng nhập thì như cũ ('CRM').
          const staff = actor.username ? actorStamp(actor) : true;
          // Comment threads: reply under the comment, or privately to Messenger.
          // Tuyến này chỉ nhân viên dùng (giao diện CRM): gắn cờ staff để bot biết nhân viên đang xử lý hội thoại.
          const sent = text || attachment ? await sendConversationMessage(conversation, { text, attachment, privateReply, staff }) : null;
          const messages = sent ? [sent.message] : [];
          let last = sent;
          // A private reply lands in the person's Messenger thread; pictures follow it there.
          const imageTarget = conversation.source === 'comment' && privateReply
            ? await getConversation(sent?.conversation?.id || `${conversation.pageId}:${conversation.psid}`)
            : conversation;
          // Qua Pancake nhiều ảnh đi chung một tin (một cụm ảnh); Meta gửi từng ảnh.
          if (imageTarget && imageUrls.length && imageTarget.pancakeConversationId) {
            last = await sendConversationMessage(imageTarget, { imageUrls: imageUrls.map(publicImageUrl), staff });
            messages.push(last.message);
          } else {
            for (const imageUrl of imageTarget ? imageUrls : []) {
              last = await sendConversationMessage(imageTarget, { imageUrl: publicImageUrl(imageUrl), staff });
              messages.push(last.message);
            }
          }
          if (!last) return sendJson(response, 400, { error: 'Khách chưa có hội thoại Messenger để nhận ảnh.' });
          // Loại tin: chữ / ảnh / tệp / tin mẫu (ảnh của mẫu trả lời nhanh, hay giao diện báo quickReplyId).
          const kinds = [
            text ? 'chữ' : '',
            attachment ? (attachment.type === 'image' ? 'ảnh' : 'tệp') : '',
            imageUrls.length || payload.quickReplyId ? 'tin mẫu' : ''
          ].filter(Boolean);
          const action = conversation.source === 'comment' ? (privateReply ? 'comment.private_reply' : 'comment.reply') : 'message.send';
          audit(request, action, {
            target: conversationTarget(conversation),
            conversationId: conversation.id,
            summary: `[${kinds.join(' + ')}] ${text ? text.slice(0, 80) : attachment ? String(attachment.name || 'tệp đính kèm').slice(0, 80) : `${imageUrls.length} ảnh mẫu`}`,
            details: { kind: kinds, ...(imageUrls.length ? { images: imageUrls.length } : {}), ...(payload.quickReplyId ? { quickReplyId: String(payload.quickReplyId).slice(0, 60) } : {}) }
          }, actor);
          return sendJson(response, 200, { ...last, message: (sent || last).message, messages });
        } catch (error) {
          return sendJson(response, error.statusCode === 400 ? 400 : 502, { error: error.message });
        }
      }
    }
    const conversationReadMatch = url.pathname.match(/^\/api\/messaging\/conversations\/([^/]+)\/read$/);
    if (request.method === 'POST' && conversationReadMatch) {
      const id = decodeURIComponent(conversationReadMatch[1]);
      const actor = await requestActor(request);
      // Đánh dấu đã đọc cũng là "đã xem": ghi seenBy ngay trong lượt ghi kho này (khi đăng nhập).
      let seenChanged = false;
      let wasUnread = false;
      // Giao diện gọi route này ở mỗi tin khách mới khi hội thoại đang mở (mỗi tab một lần): hội thoại vốn đã
      // đọc và không ghi "đã xem" thì không ghi kho; có đổi thì ghi gộp (cờ hiển thị, không ảnh hưởng bot/đơn).
      const conversation = await updateMessagingStore(store => {
        wasUnread = Boolean(store.conversations.find(item => item.id === id)?.unread);
        const flagged = setConversationFlags(store, id, { unread: false });
        if (flagged && actor.username && shouldStoreSeen(actor.username, id)) seenChanged = Boolean(markConversationSeen(store, id, { username: actor.username, name: actor.name }));
        return flagged;
      }, { defer: true, unchanged: flagged => !flagged || (!wasUnread && !seenChanged) });
      if (!conversation) return sendJson(response, 404, { error: 'Không tìm thấy hội thoại này.' });
      if (seenChanged) publishMessagingEvent({ type: 'conversation', conversation: publicConversation(conversation) });
      // Nhật ký: gộp như "xem hội thoại" (giao diện tự gọi mỗi lần mở hội thoại chưa đọc).
      if (shouldAuditRead(actor.username || actor.ip, id)) audit(request, 'conversation.read', { target: conversationTarget(conversation), conversationId: id, summary: `Đánh dấu đã đọc ${conversation.name || id}.` }, actor);
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
      let before = null;
      // R13 (M4): thẻ gửi lên chỉ nhận mã có trong Cài đặt → Tin nhắn (thẻ hội thoại đang mang thì giữ), chỉ chuỗi, bỏ trùng, ≤ 20.
      const allowedLabelIds = Array.isArray(payload.labels) ? await allowedLabelIdSet() : null;
      const conversation = await updateMessagingStore(store => {
        const current = store.conversations.find(item => item.id === id);
        if (current) before = { labels: Array.isArray(current.labels) ? [...current.labels] : [], muted: Boolean(current.muted), unread: Boolean(current.unread) };
        return setConversationFlags(store, id, payload, { allowedLabelIds });
      });
      if (!conversation) return sendJson(response, 404, { error: 'Không tìm thấy hội thoại này.' });
      const actor = await requestActor(request);
      if (Array.isArray(payload.labels)) {
        appendLabelAudit({ actor, conversation: { id: conversation.id, name: conversation.name || '' }, before: before?.labels || [], after: conversation.labels || [], labelDefs: await inboxLabelDefs() });
      }
      if (typeof payload.muted === 'boolean' && payload.muted !== before?.muted) {
        audit(request, 'conversation.mute', { target: conversationTarget(conversation), conversationId: id, summary: `${payload.muted ? 'Tắt' : 'Bật'} thông báo hội thoại ${conversation.name || id}.`, details: { muted: payload.muted } }, actor);
      }
      if (payload.unread === true && !before?.unread) {
        audit(request, 'conversation.unread', { target: conversationTarget(conversation), conversationId: id, summary: `Đánh dấu chưa đọc ${conversation.name || id}.` }, actor);
      }
      return sendJson(response, 200, publicConversation(conversation));
    }
    // Tính giỏ hàng cho form Tạo đơn của nhân viên bằng đúng bộ giá của bot:
    // từ 2 sản phẩm giá combo, quà tặng và miễn ship theo bảng quà.
    if (request.method === 'POST' && url.pathname === '/api/orders/price') {
      const payload = await readBody(request);
      const items = (Array.isArray(payload.items) ? payload.items : []).slice(0, 50)
        .map(item => ({ sku: String(item?.sku || ''), name: String(item?.name || ''), quantity: Math.round(Number(item?.quantity) || 0) }));
      // Quà "chỉ khách livestream" (Quà Tặng LIVE): cờ `livestream` gửi thẳng (form sửa đơn
      // live) được ưu tiên; không có thì suy từ hội thoại (bài live, thẻ Livestream) như bot.
      let livestream = typeof payload.livestream === 'boolean' ? payload.livestream : false;
      if (typeof payload.livestream !== 'boolean' && payload.conversationId) {
        const conversations = (await readMessagingStore()).conversations;
        const conversation = conversations.find(item => item.id === String(payload.conversationId));
        // Luồng bình luận: thẻ Livestream có thể nằm ở hộp thư cùng khách (như chatbot-engine).
        const inbox = conversation?.source === 'comment' ? conversations.find(item => item.id === `${conversation.pageId}:${conversation.psid}`) : null;
        livestream = Boolean(conversation) && (isLivestreamCustomer(conversation) || isLivestreamCustomer({ labels: inbox?.labels || [] }));
      }
      const priced = priceBasket(items, { livestream });
      return sendJson(response, 200, {
        priceable: priced.priceable,
        reason: priced.reason || '',
        totalQuantity: priced.totalQuantity || 0,
        subtotal: priced.subtotal || 0,
        shippingFee: priced.priceable ? priced.shippingFee : getShippingFee(),
        total: priced.total || 0,
        gift: priced.gift || '',
        livestream,
        gifts: (priced.gifts || []).map(gift => ({ name: gift.name, sku: gift.sku || '', weight: Number(gift.weight) || 0 })),
        lines: (priced.lines || []).map(line => ({ sku: line.sku, name: line.name, quantity: line.quantity, unitPrice: line.unitPrice, basketUnitPrice: line.basketUnitPrice, lineTotal: line.lineTotal }))
      });
    }
    // Cài đặt → Nhân sự. Ai cũng xem được danh sách (không có chuỗi băm mật khẩu); chỉ tài khoản chủ shop
    // (.env) hay Quản trị mới thêm/sửa. Chưa bật đăng nhập (chưa có tài khoản nào) chỉ xảy ra ở máy local
    // (máy chủ https trả 503 trước khi tới đây) nên cho sửa. Không có xoá: cho nghỉ (active false) để giữ lịch sử.
    // Nhật ký hoạt động (Cài đặt → Nhật ký). Chủ shop / Quản trị (hoặc CRM chưa bật đăng nhập) xem
    // toàn bộ; nhân viên thường chỉ xem lịch sử của MỘT hội thoại hay MỘT đơn (lọc conversationId/orderId).
    if (request.method === 'GET' && url.pathname === '/api/audit') {
      const actor = await requestActor(request);
      // Đã trim: chốt quyền và queryAudit dùng cùng giá trị (?conversationId=%20 từng lọt chốt rồi thành "không lọc").
      const filters = auditFiltersFrom(url.searchParams);
      if (!canReadAudit(isManager(actor), filters)) {
        return sendJson(response, 403, { error: 'Chỉ chủ shop hoặc Quản trị mới xem được toàn bộ nhật ký hoạt động.' });
      }
      const result = await queryAudit(filters);
      // Người để lọc: tài khoản chủ shop, mọi người trong Nhân sự (cả đã nghỉ) và người có trong nhật ký (bot, hệ thống).
      const people = new Map();
      for (const username of envLoginUsers.keys()) people.set(username, username);
      for (const member of await listStaff().catch(() => [])) people.set(member.username, member.name);
      for (const item of await auditActors()) if (!people.has(item.username)) people.set(item.username, item.name);
      return sendJson(response, 200, {
        items: result.items.map(item => ({ ...item, label: auditActionLabel(item.action) })),
        next: result.next,
        actors: [...people].map(([username, name]) => ({ username, name })).sort((first, second) => String(first.name).localeCompare(String(second.name), 'vi')),
        actions: Object.entries(AUDIT_ACTIONS).map(([action, label]) => ({ action, label }))
      });
    }
    if (url.pathname === '/api/staff' || url.pathname.startsWith('/api/staff/')) {
      const session = auth.session(request);
      const me = session?.username
        ? (envLoginUsers.has(session.username) ? { role: 'owner' } : await staffByUsername(session.username))
        : null;
      const canManage = !auth.enabled || me?.role === 'owner' || me?.role === 'admin';
      if (request.method === 'GET' && url.pathname === '/api/staff') {
        return sendJson(response, 200, { items: await listStaff(), loginEnabled: auth.enabled, currentUser: session?.username || '', canManage, roles: STAFF_ROLES, ownerAccounts: envLoginUsers.size });
      }
      const staffMatch = url.pathname.match(/^\/api\/staff\/([^/]+)$/);
      const creating = request.method === 'POST' && url.pathname === '/api/staff';
      if (creating || (request.method === 'PATCH' && staffMatch)) {
        if (!canManage) return sendJson(response, 403, { error: 'Chỉ Quản trị mới thêm hoặc sửa Nhân sự.' });
        if (!(await requireManager(request, response, 'Chỉ Quản trị mới thêm hoặc sửa Nhân sự.'))) return;
        try {
          const payload = await readBody(request);
          const staffId = staffMatch ? decodeURIComponent(staffMatch[1]) : '';
          const previous = staffId ? (await listStaff()).find(item => item.id === staffId) : null;
          // Tra người làm TRƯỚC khi lưu: tự đổi mật khẩu làm phiên hiện tại hết hiệu lực ngay sau saveStaffMember,
          // tra sau thì nhật ký ghi "Không đăng nhập".
          const actorBefore = await requestActor(request);
          const member = await saveStaffMember(payload, { id: staffId, reservedUsernames: new Set(envLoginUsers.keys()) });
          await refreshLoginUsers();
          // Tên/vai trò mới có hiệu lực ngay cho nhật ký và dấu người làm.
          clearActorCache();
          console.log(`Nhân sự: ${creating ? 'thêm' : 'sửa'} ${member.username} (${member.roleName}${member.active ? '' : ', đã nghỉ'})${session?.username ? ` bởi ${session.username}` : ''}`);
          // Không bao giờ ghi mật khẩu: chỉ ghi "đặt/đổi mật khẩu".
          const passwordChanged = Boolean(String(payload.password || ''));
          const changes = creating
            ? [`vai trò ${member.roleName}`, passwordChanged ? 'đặt mật khẩu' : 'chưa có mật khẩu']
            : [
              previous && previous.name !== member.name ? `tên ${previous.name} → ${member.name}` : '',
              previous && previous.username !== member.username ? `tên đăng nhập ${previous.username} → ${member.username}` : '',
              previous && previous.role !== member.role ? `vai trò ${previous.roleName} → ${member.roleName}` : '',
              previous && previous.active !== member.active ? (member.active ? 'đi làm lại' : 'cho nghỉ') : '',
              previous && previous.phone !== member.phone ? 'SĐT' : '',
              previous && JSON.stringify(previous.pancakeNames) !== JSON.stringify(member.pancakeNames) ? 'tên Pancake' : '',
              passwordChanged ? 'đổi mật khẩu' : ''
            ].filter(Boolean);
          audit(request, 'settings.staff', {
            target: { type: 'staff', id: member.id, name: member.name },
            summary: `${creating ? 'Thêm' : 'Sửa'} nhân sự ${member.name} (${member.username}): ${changes.join(', ') || 'không đổi'}.`,
            details: { passwordChanged, role: member.role, active: member.active }
          }, actorBefore);
          // Tự đổi mật khẩu / tên đăng nhập của chính mình: phiên cũ (mọi máy) đã hết hiệu lực theo phiên bản tài khoản;
          // cấp lại cookie MỚI cho đúng máy vừa đổi (đăng nhập lại bằng mật khẩu mới vừa gửi) để không bị đá ra.
          const selfEdit = !creating && session?.username && previous && session.username === previous.username;
          if (selfEdit && member.active && passwordChanged && auth.enabled) {
            const relogin = await auth.login({ username: member.username, password: String(payload.password), clientId: clientAddress(request) });
            if (relogin.ok) response.setHeader('Set-Cookie', relogin.cookie);
          }
          return sendJson(response, creating ? 201 : 200, { member, items: await listStaff(), loginEnabled: auth.enabled });
        } catch (error) {
          return sendJson(response, error.statusCode || 400, { error: error.message });
        }
      }
      return sendJson(response, 405, { error: 'Không hỗ trợ thao tác này.' });
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
        if (!(await requireManager(request, response))) return;
        const payload = await readBody(request);
        // Không gửi `items` = chỉ đổi phí ship, giữ nguyên danh sách quà (trước đây xóa sạch quà).
        const hasItems = payload.items !== undefined;
        if (hasItems && !Array.isArray(payload.items)) return sendJson(response, 400, { error: 'Danh sách quà tặng không hợp lệ.' });
        const items = hasItems ? payload.items : null;
        // R13 (M8): `items: []` từng xoá sạch quà kể cả miễn ship (2 túi thành 318.000đ có ship) — xoá hết phải kèm confirmClear:true.
        if (items && !items.length && payload.confirmClear !== true && getGifts().length) return sendJson(response, 400, { error: 'Danh sách quà tặng rỗng sẽ xoá toàn bộ quà (kể cả miễn phí vận chuyển). Nếu đúng là muốn xoá hết, hãy xác nhận (confirmClear: true).', needsConfirmClear: true });
        if (items && items.length > 50) return sendJson(response, 400, { error: 'Tối đa 50 quà tặng.' });
        const giftIds = new Set();
        for (const item of items || []) {
          if (typeof item?.name !== 'string') return sendJson(response, 400, { error: 'Tên quà tặng phải là chữ.' });
          if (!String(item?.name || '').trim()) return sendJson(response, 400, { error: 'Mỗi quà tặng phải có tên.' });
          // Hai quà ra cùng mã (cùng tên, hay cùng id gửi lên): bản lưu sẽ lặng lẽ bỏ một quà.
          const giftId = normalizeGift(item)?.id || '';
          if (giftIds.has(giftId)) return sendJson(response, 400, { error: `Tên quà trùng: "${String(item.name).trim()}".` });
          giftIds.add(giftId);
          // Tối đa (túi): bỏ trống/0 = không giới hạn; có đặt thì phải là số nguyên ≥ "Tặng từ".
          const minQuantity = Math.max(1, Math.round(Number(item?.minQuantity) || 1));
          const maxQuantity = item?.maxQuantity === undefined || item?.maxQuantity === null || item?.maxQuantity === '' ? 0 : Number(item.maxQuantity);
          if (!Number.isInteger(maxQuantity) || maxQuantity < 0 || maxQuantity > 99) return sendJson(response, 400, { error: `Quà "${String(item.name).trim()}": Tối đa (túi) phải là số nguyên từ 0 đến 99 (0 = không giới hạn).` });
          if (maxQuantity > 0 && maxQuantity < minQuantity) return sendJson(response, 400, { error: `Quà "${String(item.name).trim()}": Tối đa (túi) phải lớn hơn hoặc bằng Tặng từ (${minQuantity}).` });
          // Chỉ khách livestream: bỏ trống = không (quà cho mọi khách); có gửi thì phải là true/false.
          if (item?.livestreamOnly !== undefined && item?.livestreamOnly !== null && typeof item.livestreamOnly !== 'boolean') return sendJson(response, 400, { error: `Quà "${String(item.name).trim()}": "Chỉ khách livestream" phải là true hoặc false.` });
        }
        const shippingFee = Number(payload.shippingFee);
        // null / "" không phải 0: Number(null) = 0 từng lặng lẽ đặt phí ship về 0.
        const shippingFeeInvalid = payload.shippingFee === null || (typeof payload.shippingFee === 'string' && !payload.shippingFee.trim()) || typeof payload.shippingFee === 'boolean';
        if (payload.shippingFee !== undefined && (shippingFeeInvalid || !Number.isInteger(shippingFee) || shippingFee < 0 || shippingFee > 500000)) return sendJson(response, 400, { error: 'Phí vận chuyển phải là số nguyên từ 0 đến 500.000.' });
        const beforeGifts = getGifts();
        const beforeFee = getShippingFee();
        await updateGiftStore(current => ({
          items: items || current.items,
          shippingFee: payload.shippingFee !== undefined ? shippingFee : current.shippingFee
        }));
        const afterGifts = getGifts();
        const giftNames = list => new Set((list || []).map(gift => String(gift.name || '')));
        const added = [...giftNames(afterGifts)].filter(name => !giftNames(beforeGifts).has(name));
        const removed = [...giftNames(beforeGifts)].filter(name => !giftNames(afterGifts).has(name));
        const giftParts = [
          items ? `${afterGifts.length} quà${added.length ? `, thêm ${added.slice(0, 3).join(', ')}` : ''}${removed.length ? `, bỏ ${removed.slice(0, 3).join(', ')}` : ''}` : '',
          payload.shippingFee !== undefined && beforeFee !== getShippingFee() ? `phí ship ${beforeFee} → ${getShippingFee()}` : ''
        ].filter(Boolean);
        audit(request, 'settings.gifts', { target: { type: 'settings', id: 'gifts', name: 'Quà tặng' }, summary: `Sửa quà tặng / phí ship: ${giftParts.join('; ') || 'không đổi'}.` });
        return sendJson(response, 200, giftResponse());
      }
    }
    // What the model actually receives: the saved prompt plus the live catalogue block.
    if (url.pathname === '/api/chatbot/pipeline' && request.method === 'GET') {
      return sendJson(response, 200, { items: listPipelineSteps() });
    }
    const pipelineStepMatch = url.pathname.match(/^\/api\/chatbot\/pipeline\/([a-z_]+)$/);
    if (pipelineStepMatch && request.method === 'GET') {
      // R13 (L7): bước xử lý trả MÃ NGUỒN máy chủ — chỉ chủ shop / Quản trị xem (danh sách bước vẫn mở cho nhân viên).
      if (!(await requireManager(request, response, 'Chỉ chủ shop hoặc Quản trị mới xem được mã nguồn bước xử lý.'))) return;
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
          const draft = await draftManualOrder(id, payload, async order => { order.id = uniqueOrderId(order.id, await takenOrderIds()); });
          if (draft.reject) return sendJson(response, draft.reject.status, draft.reject.body);
          const { order } = draft;
          // Đơn tạo tay: người tạo = người đang đăng nhập (createdBy + mục lịch sử đầu tiên).
          const actor = await requestActor(request);
          const creator = actorStamp(actor);
          if (actor.username && (!order.employee || order.employee === 'Bạn')) order.employee = creator.name;
          stampOrderCreated(order, creator, { summary: `Tạo đơn tay: ${order.products.map(item => `${item.quantity} ${item.name}`).join(' + ').slice(0, 120)}, tổng ${moneyText(order.total)}.` });
          const viaPancake = Boolean(conversation.pancakeConversationId);
          if (!viaPancake) {
            // Messenger trực tiếp: thẻ receipt; bị từ chối thì ảnh phiếu. Không bao giờ gửi bản chữ.
            try {
              let sent;
              try {
                sent = await sendConversationMessage(conversation, { template: buildOrderReceiptPayload(order, { baseUrl: metaConfig.publicBaseUrl }), sentBy: actor.username ? creator : null });
              } catch (error) {
                console.error(`Messenger từ chối thẻ receipt của đơn ${order.id}, gửi ảnh phiếu: ${error.message}`);
                sent = await sendReceiptImage(conversation, order, { sentBy: actor.username ? creator : null });
              }
              order.delivery = { status: 'sent', messageId: String(sent?.message?.mid || sent?.message?.id || ''), sentAt: Date.now() };
            } catch (error) {
              draft.release();
              return sendJson(response, 502, { error: `Chưa tạo đơn: ${error.message}` });
            }
          }
          const labelDefs = (await readInboxSettings().catch(() => ({ labels: [] }))).labels;
          const orderLabels = labelsForEvents(labelDefs, ['order']);
          let relabeledConversation = null;
          let labelsBefore = [];
          const stored = await updateMessagingStore(store => {
            const item = store.conversations.find(entry => entry.id === id);
            if (!item) return null;
            if (!Array.isArray(item.customerOrders)) item.customerOrders = [];
            reserveOrderIdInStore(order, store);
            item.customerOrders.unshift(order);
            item.customerOrders = item.customerOrders.slice(0, 200);
            labelsBefore = Array.isArray(item.labels) ? [...item.labels] : [];
            // Nhân viên tạo đơn trong CRM: gắn thẻ "Đã mua hàng" như đơn bot chốt.
            if (applyPurchaseLabels(item, order, orderLabels)) relabeledConversation = publicConversation(item);
            return item;
          }).finally(draft.release);
          if (!stored) return sendJson(response, 404, { error: 'Không tìm thấy hội thoại này.' });
          audit(request, 'order.create', {
            target: orderTarget(order),
            conversationId: id,
            orderId: order.id,
            summary: `Tạo đơn #${order.id} cho ${order.name}: ${order.products.map(item => `${item.quantity} ${item.name}`).join(' + ').slice(0, 100)}, tổng ${moneyText(order.total)}.`,
            details: { total: order.total, quantity: order.products.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) }
          }, actor);
          if (relabeledConversation) {
            publishMessagingEvent({ type: 'conversation', conversation: relabeledConversation });
            appendLabelAudit({ actor, conversation: { id, name: stored.name || '' }, before: labelsBefore, after: relabeledConversation.labels, labelDefs, reason: 'tự gắn khi tạo đơn' });
          }
          markFollowUpWins().catch(() => {});
          // R13: đơn tay cũng vào kho lưu trữ ngay lúc tạo như đơn bot / landing (trước đây chỉ vào khi được sửa) —
          // ô tìm nhanh Ctrl K và "Lịch sử đơn" của khách tra đơn theo kho này.
          await appendOrderToArchive(order).catch(() => {});
          // Phiếu xác nhận có tới khách thật không (giao diện báo "Đã gửi…" hay "chưa gửi được, bấm Gửi lại").
          // Messenger trực tiếp: gửi lỗi thì đã trả 502 "Chưa tạo đơn" ở trên, tới đây là đã gửi.
          let receipt = { receiptSent: true, receiptVia: 'messenger', receiptError: '' };
          if (viaPancake) {
            // Hội thoại Pancake: không gửi bản chữ. Đẩy đơn sang Pancake POS, POS
            // gửi khách thẻ xác nhận đơn; POS lỗi thì CRM gửi phiếu ảnh của mình.
            const pos = await syncOrderToPos(id, order.id).catch(error => ({ error: error.message, at: Date.now() }));
            if (pos) order.pos = pos;
            const outcome = pos?.id ? { sent: true, via: 'pos' } : await sendChatbotOrderReceipt(conversation, order, { sentBy: actor.username ? creator : null });
            receipt = outcome.sent
              ? { receiptSent: true, receiptVia: outcome.via, receiptError: '' }
              : { receiptSent: false, receiptVia: 'receipt-image', receiptError: 'Chưa gửi được phiếu xác nhận cho khách (Pancake không nhận tin). Bấm "Gửi lại phiếu" ở đơn để thử lại.' };
            order.delivery = outcome.sent
              ? { status: 'sent', messageId: '', sentAt: Date.now(), via: outcome.via }
              : { status: 'failed', messageId: '', failedAt: Date.now(), via: 'receipt-image', error: String(outcome.error || '').slice(0, 300) };
            await updateMessagingStore(store => {
              const item = store.conversations.find(entry => entry.id === id);
              const target = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => entry.id === order.id);
              if (target) Object.assign(target, { delivery: order.delivery, ...(order.pos ? { pos: order.pos } : {}) });
              return null;
            });
          }
          const panel = await readMessagingStore().then(store => publicCustomerPanel(store.conversations.find(entry => entry.id === id)));
          // Mã đơn thật (có thể đã thêm hậu tố khi trùng) để trình duyệt báo đúng mã; receiptSent/receiptVia/
          // receiptError: phiếu xác nhận đã tới khách chưa (web báo lỗi thay vì "Đã gửi xác nhận…").
          return sendJson(response, 201, { ...panel, createdOrderId: order.id, ...receipt });
        }
        const actor = await requestActor(request);
        const author = actorStamp(actor);
        let botWasOn = null;
        const panel = await updateMessagingStore(store => {
          const item = store.conversations.find(entry => entry.id === id);
          if (!item) return null;
          if (payload.type === 'note') {
            const text = String(payload.text || '').trim().slice(0, 2000);
            if (!text) throw new Error('Nội dung ghi chú không được để trống.');
            if (!Array.isArray(item.customerNotes)) item.customerNotes = [];
            // Ghi chú mang người viết (author) để hộp chi tiết hiện "ai ghi".
            item.customerNotes.unshift({ id: randomUUID(), text, createdAt: Date.now(), ...(actor.username ? { author } : {}) });
            item.customerNotes = item.customerNotes.slice(0, 100);
          } else if (payload.type === 'bot') {
            botWasOn = item.botEnabled !== false;
            item.botEnabled = payload.enabled === true;
            // Ai bật/tắt bot gần nhất (hiện trong bảng khách); lịch sử đủ nằm ở nhật ký.
            item.botChangedBy = { ...author, at: Date.now(), enabled: item.botEnabled };
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
        const panelTarget = conversationTarget(conversation);
        if (payload.type === 'note') {
          audit(request, 'customer.note', { target: panelTarget, conversationId: id, summary: `Ghi chú khách: ${String(payload.text || '').trim().slice(0, 80)}` }, actor);
        } else if (payload.type === 'bot') {
          if (botWasOn !== (payload.enabled === true)) appendBotToggleAudit({ actor, conversation: { id, name: conversation.name || '' }, enabled: payload.enabled === true });
        } else if (payload.type === 'bot-error') {
          audit(request, 'conversation.bot_error', { target: panelTarget, conversationId: id, summary: 'Xóa lỗi bot đang hiện trên hội thoại.' }, actor);
        } else if (payload.type === 'gender') {
          const gender = ['male', 'female'].includes(payload.gender) ? payload.gender : '';
          audit(request, 'customer.update', { target: panelTarget, conversationId: id, summary: `Đặt xưng hô: ${gender === 'male' ? 'anh (nam)' : gender === 'female' ? 'chị (nữ)' : 'bỏ chọn, để bot tự đoán'}.` }, actor);
        }
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
      const actor = await requestActor(request);
      const by = actorStamp(actor);
      const changedIds = [];
      const apply = order => {
        if (!applyCustomerOrderEdits(order, { hiddenFromTable: hidden }).length) return;
        changed += 1;
        changedIds.push(String(order.id));
        recordOrderHistory(order, { by, action: 'order.hide', summary: hidden ? 'Ẩn khỏi bảng Đơn hàng.' : 'Hiện lại trong bảng Đơn hàng.' });
      };
      await updateMessagingStore(store => {
        for (const conversation of store.conversations) {
          for (const order of Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []) if (ids.has(String(order.id))) apply(order);
        }
      });
      await updateLandingStore(store => { for (const order of store.orders) if (ids.has(String(order.id))) apply(order); });
      if (changed) {
        audit(request, 'order.hide', {
          ...(changed === 1 ? { orderId: changedIds[0], target: { type: 'order', id: changedIds[0], name: '' } } : {}),
          summary: `${hidden ? 'Ẩn' : 'Hiện lại'} ${changed} đơn ${hidden ? 'khỏi' : 'trong'} bảng Đơn hàng${changed > 1 ? `: ${changedIds.slice(0, 8).join(', ')}${changed > 8 ? '…' : ''}` : ''}.`,
          details: { hidden, count: changed }
        }, actor);
      }
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
      // R13 (M7): đơn mở lại sau khi POS đã hủy → lên lại thành ĐƠN POS MỚI (đơn cũ bên POS giữ nguyên trạng thái hủy).
      const reopened = owner.customerOrders.find(order => order.id === orderId);
      const posIdBefore = String(reopened?.pos?.id || '');
      const outcome = needsPosRepush(reopened) ? await repushCancelledOrderToPos(owner, reopened) : await syncOrderToPos(owner.id, orderId);
      const actor = await requestActor(request);
      const pushed = owner.customerOrders.find(order => order.id === orderId);
      const pushSummary = outcome?.error ? `Đẩy đơn sang POS lỗi: ${String(outcome.error).slice(0, 120)}` : `Đẩy đơn sang POS${outcome?.systemId || outcome?.id ? ` (mã POS ${outcome.systemId || outcome.id})` : ''}.`;
      // R13-fix (L3): đơn đã có mã POS và không làm gì (bấm lại, hai request sát nhau) thì không ghi lịch sử/nhật ký.
      if (outcome?.error || (String(outcome?.id || '') !== posIdBefore && shouldLogPosPush(`${orderId}|${outcome?.id}`))) {
        await addOrderHistory(orderId, { by: actorStamp(actor), action: 'order.push_pos', summary: pushSummary });
        audit(request, 'order.push_pos', { target: orderTarget(pushed), conversationId: owner.id, orderId, summary: `#${orderId}: ${pushSummary}` }, actor);
      }
      return sendJson(response, outcome?.error ? 502 : 200, { pos: outcome, error: outcome?.error || '' });
    }
    const customerOrderDeleteMatch = url.pathname.match(/^\/api\/customer-orders\/([^/]+)$/);
    // Sửa đơn từ bảng Xử lý dữ liệu: tên, số điện thoại, địa chỉ (tách lại ba
    // cấp), số lượng/đơn giá từng dòng. Server là sự thật cho đơn hệ thống nên
    // phải ghi về đây; ghi chú xử lý tự cập nhật theo dữ liệu mới.
    if (customerOrderDeleteMatch && request.method === 'PATCH') {
      const orderId = decodeURIComponent(customerOrderDeleteMatch[1]);
      const patch = await readBody(request);
      const actor = await requestActor(request);
      let updated = null;
      let failure = null;
      // Dấu vết: trường đổi, câu tóm tắt và mã hành động (sửa / đổi trạng thái / hủy) cho lịch sử đơn + nhật ký.
      let edit = null;
      let editWarnings = [];
      let ownerConversationId = '';
      // Kiểm trên bản sao rồi mới chép đè. applyCustomerOrderEdits sửa TẠI CHỖ
      // từng trường một rồi mới ném lỗi ở trường sau, mà lỗi lại bị bắt ngay
      // trong mutator nên kho vẫn được ghi xuống đĩa — sửa thẳng thì một patch
      // bị từ chối vẫn kịp để lại nửa thay đổi, API trả 400 mà dữ liệu đã đổi.
      const apply = order => {
        const draft = structuredClone(order);
        let changed;
        try {
          changed = applyCustomerOrderEdits(draft, patch);
        } catch (error) {
          failure = error;
          return;
        }
        // Cảnh báo không chặn (SĐT lạ: +84 đã đổi về 0, số bàn…) để giao diện báo cạnh ô.
        if (Array.isArray(changed.warnings)) editWarnings = changed.warnings;
        if (changed.length) {
          edit = { changed, action: orderEditAction(changed, draft), summary: describeOrderEdits(order, draft, changed) };
          recordOrderHistory(draft, { by: actorStamp(actor), action: edit.action, summary: edit.summary });
        }
        // R13: trường applyCustomerOrderEdits đã XOÁ trên bản sao (cờ "Ô chọn khác chữ khách gõ" sau khi sửa địa chỉ, quà
        // bám đuổi khi giỏ đổi, dấu ẩn khỏi bảng…) cũng phải mất trên đơn thật — Object.assign chỉ chép, không xoá.
        for (const key of Object.keys(order)) if (!(key in draft)) delete order[key];
        Object.assign(order, draft);
        updated = order;
      };
      await updateMessagingStore(store => {
        for (const conversation of store.conversations) {
          const order = (Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []).find(item => item.id === orderId);
          if (!order) continue;
          apply(order);
          if (updated) { ownerConversationId = conversation.id; publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id }); }
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
      if (edit) {
        audit(request, edit.action, {
          target: orderTarget(updated),
          conversationId: ownerConversationId,
          orderId,
          summary: `#${orderId}${ownerConversationId ? '' : ' (landing)'}: ${edit.summary || edit.changed.join(', ')}`,
          details: { fields: edit.changed }
        }, actor);
      }
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
      // Chỉ đơn CRM tạo rồi đẩy sang (isCrmOwnedPosOrder): đơn nhân viên/Shop lên trên POS
      // rồi kéo về (source 'POS') thì POS là bản gốc — PUT từ CRM sẽ đè giỏ/quà/ghi chú trên POS.
      if (updated.pos?.id && isCrmOwnedPosOrder(updated) && ['name', 'phone', 'address', 'lines', 'products', 'freeShipping', 'shippingFee', 'discount', 'note', 'gift'].some(field => patch[field] !== undefined)) {
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
      // warnings: [chuỗi] cảnh báo không chặn của lần sửa (rỗng khi không có) — web hiện cạnh ô SĐT.
      return sendJson(response, 200, { ...updated, processingNotes: orderProcessingNotes(updated), warnings: editWarnings });
    }
    // Gửi lại phiếu xác nhận đơn cho khách (ảnh phiếu qua Pancake, thẻ receipt qua Messenger).
    const customerOrderResendMatch = url.pathname.match(/^\/api\/customer-orders\/([^/]+)\/resend$/);
    if (customerOrderResendMatch && request.method === 'POST') {
      const orderId = decodeURIComponent(customerOrderResendMatch[1]);
      const store = await readMessagingStore();
      const owner = store.conversations.find(item => (Array.isArray(item.customerOrders) ? item.customerOrders : []).some(order => order.id === orderId));
      const order = owner?.customerOrders.find(item => item.id === orderId);
      if (!owner || !order) return sendJson(response, 404, { error: 'Không tìm thấy đơn này trong hội thoại nào.' });
      const actor = await requestActor(request);
      try {
        await sendChatbotOrderReceipt(owner, order, { force: true, sentBy: actor.username ? actorStamp(actor) : null });
      } catch (error) {
        return sendJson(response, 502, { error: `Chưa gửi lại được phiếu: ${error.message}` });
      }
      await updateMessagingStore(current => {
        const item = current.conversations.find(entry => entry.id === owner.id);
        const target = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => entry.id === orderId);
        if (target) {
          target.delivery = { ...(target.delivery || {}), status: 'sent', resentAt: Date.now() };
          recordOrderHistory(target, { by: actorStamp(actor), action: 'order.resend_receipt', summary: 'Gửi lại phiếu xác nhận đơn cho khách.' });
        }
        return null;
      });
      publishMessagingEvent({ type: 'customer-panel', conversationId: owner.id });
      audit(request, 'order.resend_receipt', { target: orderTarget(order), conversationId: owner.id, orderId, summary: `Gửi lại phiếu đơn #${orderId} cho ${order.name || 'khách'}.` }, actor);
      return sendJson(response, 200, { ok: true });
    }
    if (customerOrderDeleteMatch && request.method === 'DELETE') {
      const orderId = decodeURIComponent(customerOrderDeleteMatch[1]);
      let removed = null;
      let removedFrom = '';
      // R13 (M2): đơn đã lên POS mà chưa hủy thì không xoá (xoá ở CRM để lại đơn POS sống → vẫn đi kiện). Không tự hủy POS.
      let liveOnPos = null;
      await updateMessagingStore(store => {
        for (const conversation of store.conversations) {
          const orders = Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [];
          const index = orders.findIndex(order => order.id === orderId);
          if (index < 0) continue;
          if (isLiveOnPos(orders[index])) { liveOnPos = orders[index]; return null; }
          [removed] = orders.splice(index, 1);
          // R13-fix (T2): đơn POS kéo về mà xoá thì nhớ mã, kẻo lượt đồng bộ 5 phút sau kéo về lại.
          rememberDeletedPosOrder(conversation, removed);
          removedFrom = conversation.id;
          publishMessagingEvent({ type: 'customer-panel', conversationId: conversation.id });
          break;
        }
        return removed;
      }, { unchanged: result => !result });
      if (liveOnPos) return sendJson(response, 409, { error: `Đơn này đã lên Pancake POS (#${liveOnPos.pos.systemId || liveOnPos.pos.id}) và chưa hủy. Hãy hủy đơn trước khi xoá.`, posId: String(liveOnPos.pos.id) });
      if (!removed) removed = await deleteLandingOrder(orderId);
      if (!removed) return sendJson(response, 404, { error: 'Không tìm thấy đơn này.' });
      // Xóa khỏi hệ thống nhưng vẫn giữ một dòng trong kho để còn tra lại.
      await appendOrderToArchive(removed, { status: 'deleted' }).catch(() => {});
      audit(request, 'order.delete', { target: orderTarget(removed), conversationId: removedFrom, orderId, summary: `Xóa đơn #${orderId} của ${removed.name || 'khách'} (tổng ${moneyText(removed.total)}) khỏi hệ thống.` });
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
        // Chỉ đơn ở kho chính: đơn landing đã lưu trữ không sửa/xoá/đồng bộ POS được (PATCH/DELETE trả 404),
        // nên không hiện ở bảng Đơn hàng. Báo cáo, Tổng quan, Chiến dịch vẫn tính cả kho lưu trữ.
        ...await listLandingOrders({ includeArchived: false })
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
        // orderProcessingNotes = cờ gắn trên đơn (có thể trùng đơn, giá landing lệch, cần lên lại POS…) + ghi chú dựng từ dữ liệu.
        withNotes.push({ ...refreshed, processingNotes: orderProcessingNotes(refreshed) });
      }
      return sendJsonWithEtag(request, response, { items: withNotes, total: withNotes.length });
    }
    // Báo khách hành trình vận đơn (Sapo): hàng chờ + bật/tắt tự nhắn + gửi qua cầu nối Pancake.
    if (request.method === 'GET' && url.pathname === '/api/shipping/notices') {
      const now = Date.now();
      const [settings, state, items] = await Promise.all([readSapoSettings(), readSapoState(), shipmentNoticeQueue(now)]);
      return sendJson(response, 200, { configured: isSapoConfigured(), settings, quietHour: isQuietHourVN(now), lastRunAt: Number(state.lastRunAt) || 0, lastSummary: state.lastSummary || null, items });
    }
    if (request.method === 'PUT' && url.pathname === '/api/shipping/settings') {
      if (!(await requireManager(request, response, 'Chỉ Quản trị mới bật/tắt tự nhắn khách.'))) return;
      const payload = await readBody(request);
      if (typeof payload.notifyCustomers !== 'boolean') return sendJson(response, 400, { error: 'Thiếu notifyCustomers (true/false).' });
      await writeSapoSettings({ notifyCustomers: payload.notifyCustomers });
      audit(request, 'shipping.settings', { summary: `${payload.notifyCustomers ? 'Bật' : 'Tắt'} tự nhắn khách hành trình vận đơn.` });
      return sendJson(response, 200, { settings: await readSapoSettings() });
    }
    // Lệnh cho cầu nối Pancake (gửi được ngoài 24 giờ): thêm ID Facebook của khách từ Pancake.
    if (request.method === 'POST' && url.pathname === '/api/shipping/notices/bridge-items') {
      const payload = await readBody(request);
      const wanted = new Set((Array.isArray(payload.keys) ? payload.keys : []).map(String).slice(0, 50));
      const queue = (await shipmentNoticeQueue()).filter(item => wanted.has(item.key));
      const items = [];
      const skipped = [];
      for (const item of queue) {
        const convId = `${item.pageId}_${item.psid}`;
        let info = null;
        try {
          info = await fetchPancakeConversationInfo(item.pageId, convId);
        } catch (error) {
          skipped.push({ key: item.key, reason: `Pancake lỗi: ${error.message}` });
          continue;
        }
        if (info && info.canInbox === false) { skipped.push({ key: item.key, reason: 'khách không nhận tin (chặn Page)' }); continue; }
        const updatedTime = Math.max(0, ...((await readMessagingStore()).messages?.[item.conversationId] || []).map(message => Number(message.createdAt) || 0));
        items.push({ key: item.key, pageId: item.pageId, convId, globalUserId: info?.globalId || '', needsGlobalId: !info?.globalId, updatedTime, name: item.name, text: item.text });
      }
      audit(request, 'shipping.notice_batch', { summary: `Lấy ${items.length} tin báo vận đơn để gửi qua Pancake${skipped.length ? `, bỏ ${skipped.length}` : ''}.` });
      return sendJson(response, 200, { items, skipped });
    }
    if (request.method === 'POST' && url.pathname === '/api/shipping/notices/results') {
      const payload = await readBody(request);
      const results = (Array.isArray(payload.results) ? payload.results : []).slice(0, 100).map(result => ({
        key: String(result?.key || ''),
        ok: result?.ok === true,
        via: ['pancake-bridge', 'manual', 'skipped'].includes(result?.via) ? result.via : 'pancake-bridge',
        error: String(result?.error || '').slice(0, 200)
      })).filter(result => result.key);
      const saved = await saveShipmentNoticeResults(results);
      const sent = results.filter(result => result.ok).length;
      audit(request, 'shipping.notice_result', { summary: `Báo vận đơn cho khách: ${sent} xong, ${results.length - sent} lỗi.`, details: { sent, failed: results.length - sent } });
      return sendJson(response, 200, { saved });
    }
    // Gửi ngay qua API (chỉ được khi khách còn trong 24 giờ Messenger).
    if (request.method === 'POST' && url.pathname === '/api/shipping/notices/send') {
      const payload = await readBody(request);
      const item = (await shipmentNoticeQueue()).find(entry => entry.key === String(payload.key || ''));
      if (!item) return sendJson(response, 404, { error: 'Không còn tin này trong hàng chờ (đã gửi hoặc vận đơn đã đổi).' });
      const store = await readMessagingStore();
      const inbox = (store.conversations || []).find(entry => entry.id === item.conversationId);
      if (!inbox) return sendJson(response, 404, { error: 'Không tìm thấy hội thoại của khách.' });
      try {
        const actor = requestActor(request);
        await sendConversationMessage(inbox, { text: item.text, staff: true, sentBy: actor.username ? actorStamp(actor) : null });
        await saveShipmentNoticeResults([{ key: item.key, ok: true, via: 'manual' }]);
        audit(request, 'shipping.notice_send', { summary: `Gửi tin vận đơn ${item.trackingNumber} (${item.stageLabel}) cho ${item.name || 'khách'}.` });
        return sendJson(response, 200, { ok: true });
      } catch (error) {
        return sendJson(response, 502, { error: `Không gửi được qua API (khách ngoài 24 giờ thì gửi qua Pancake): ${error.message}` });
      }
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
      const parsed = parseXlsx(workbook);
      audit(request, 'order.import', { summary: `Nhập tệp XLSX vào bảng Nhập dữ liệu (${Array.isArray(parsed?.rows) ? parsed.rows.length : 0} dòng, ${Math.round(workbook.length / 1024)} KB).` });
      return sendJson(response, 200, parsed);
    }
    // The export preview and the file come from the same function, so what
    // staff see on screen is exactly what the warehouse receives.
    if (request.method === 'POST' && url.pathname === '/api/orders/export/preview') {
      const payload = await readBody(request);
      if (!payload.orderData || !Array.isArray(payload.orderData.headers) || !Array.isArray(payload.orderData.rows)) {
        return sendJson(response, 400, { error: 'Dữ liệu đơn hàng không hợp lệ.' });
      }
      // Cờ của đơn hệ thống (khách live, quà ưu đãi, dòng quà POS) mà dòng bảng không mang.
      const rows = buildExportRows(payload.orderData, { orderFacts: exportFactsForOrders(await listAllSystemOrders()) });
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
      const fileName = String(payload.fileName || '').replace(/[^A-Za-z0-9._-]/g, '') || `nhap-du-lieu-${vnDateStamp()}.xlsx`;
      audit(request, 'order.export', { target: { type: 'file', id: fileName, name: fileName }, summary: `Xuất bảng Nhập dữ liệu ra XLSX: ${rows.length} dòng (${fileName}).`, details: { kind: 'table', rows: rows.length } });
      return sendBinary(response, 200, buildPlainXlsx(headers, rows, { sheetName: 'Nhập dữ liệu' }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName);
    }
    if (request.method === 'POST' && url.pathname === '/api/orders/export') {
      const payload = await readBody(request);
      if (!payload.orderData || !Array.isArray(payload.orderData.headers) || !Array.isArray(payload.orderData.rows)) {
        throw new Error('Dữ liệu đơn hàng xuất không hợp lệ. Vui lòng tải lại trang và thử lại.');
      }
      const skipInvalidLocations = payload.skipInvalidLocations === true;
      const rows = buildExportRows(payload.orderData, { skipInvalidLocations, orderFacts: exportFactsForOrders(await listAllSystemOrders()) });
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
      // Dữ liệu từ dòng 4 của mẫu, dựng sheetData một lượt (app/xlsx-template.mjs) thay vì quét lại cả XML cho từng ô.
      const worksheetXml = fillTemplateSheet(cleanedWorkbook.worksheetXml, rows, { firstRow: 4 });
      workbook.updateFile('xl/styles.xml', Buffer.from(cleanedWorkbook.stylesXml, 'utf8'));
      workbook.updateFile(worksheetPath, Buffer.from(worksheetXml, 'utf8'));
      const output = workbook.toBuffer();
      const fileName = String(payload.fileName || '').replace(/[^A-Za-z0-9._-]/g, '') || `don-hang-${vnDateStamp()}.xlsx`;
      // Lịch sử xuất (14 ngày): ngày đơn đã chọn, số đơn (dòng có STT), số dòng, tệp để tải lại.
      await recordExport({
        day: String(payload.exportDay || ''),
        orders: new Set(rows.map(row => String(row[0] || '')).filter(Boolean)).size,
        rows: rows.length,
        skippedInvalid: skipInvalidLocations ? rows.locationCheck.invalid.length : 0,
        fileName,
        buffer: output
      }).catch(error => console.error(`Không ghi được lịch sử xuất: ${error.message}`));
      const exportedOrders = new Set(rows.map(row => String(row[0] || '')).filter(Boolean)).size;
      audit(request, 'order.export', {
        target: { type: 'file', id: fileName, name: fileName },
        summary: `Xuất file kho ${fileName}: ${exportedOrders} đơn, ${rows.length} dòng${payload.exportDay ? `, ngày ${String(payload.exportDay).slice(0, 20)}` : ''}${skipInvalidLocations && rows.locationCheck.invalid.length ? `, bỏ ${rows.locationCheck.invalid.length} đơn sai địa chỉ` : ''}.`,
        details: { kind: 'warehouse', orders: exportedOrders, rows: rows.length }
      });
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
      audit(request, 'order.export', { target: { type: 'file', id: exportFileMatch[1], name: file.fileName }, summary: `Tải lại file kho đã xuất ${file.fileName}.`, details: { kind: 'history' } });
      return sendBinary(response, 200, file.buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', file.fileName);
    }
    if(request.method==='GET') return serveFile(request,response,url.pathname,url.searchParams.get('v') || '');
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
      // Đọc kho lỗi tạm (tệp đang bận/khoá, hết lượt mở tệp): các kho giờ NÉM thay vì coi là rỗng (json-store) →
      // báo "thử lại" thay cho lỗi chung; dữ liệu trên đĩa không bị đụng tới.
      if (TRANSIENT_FILE_ERRORS.has(error.code)) return sendJson(response, 503, { error: 'Máy chủ đang bận đọc dữ liệu, vui lòng thử lại sau ít giây.' });
      return sendJson(response, 500, { error: 'Máy chủ gặp lỗi khi xử lý yêu cầu.' });
    }
    // R13 (L8): lỗi kỹ thuật tiếng Anh ("Unexpected end of JSON input", "URI malformed", "Cannot read properties of
    // null…") không đưa nguyên văn ra giao diện: câu tiếng Việt, chi tiết vào log.
    sendJson(response, 400, { error: friendlyRequestError(error, { method: request.method, url: request.url }) });
  }
});

// Một socket khách đứt giữa chừng (hay gặp nhất ở luồng SSE) làm response phát
// 'error' bất đồng bộ; không ai nghe thì Node 22 giết cả tiến trình, tức mất
// CRM của mọi người vì một trình duyệt đóng tab. Ghi log rồi chạy tiếp.
process.on('unhandledRejection', error => console.error('Promise bị bỏ rơi:', error));
// Lỗi không ai bắt thì trạng thái tiến trình không còn tin được nữa: ghi lại
// cho có dấu vết rồi thoát để systemd dựng lại bản sạch (unit đặt Restart).
// CỐ Ý không ghi nốt kho hội thoại ở đây (khác SIGTERM): bộ nhớ có thể đang sửa dở nên ghi xuống là
// ghi trạng thái hỏng. Phần ghi gộp còn treo chỉ là tin/trạng thái webhook vào (≤ 5 giây) và "đã xem/
// đã đọc"; đồng bộ Pancake (10 phút) kéo lại tin khách. Đơn hàng, trạng thái bot, tin gửi đi ghi ngay.
process.on('uncaughtException', error => {
  console.error('Lỗi không ai bắt, thoát để khởi động lại:', error);
  process.exit(1);
});
// systemd restart/deploy gửi SIGTERM: ghi nốt kho hội thoại còn trong bộ nhớ (ghi gộp của đồng bộ) rồi mới thoát.
installMessagingStoreShutdownFlush({ exit: code => Promise.resolve(qrGreetingShutdownFlush).finally(() => process.exit(code)) });
server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  else socket.destroy();
});
// Sau Caddy: Node mặc định đóng kết nối rảnh sau 5 giây, Caddy có thể đang dùng lại đúng kết nối đó
// → 502 lác đác. Giữ lâu hơn thời gian rảnh của proxy; headersTimeout phải lớn hơn keepAliveTimeout.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(serverConfig.port, serverConfig.host, () => {
  console.log(`CRM running at http://${serverConfig.host}:${serverConfig.port}/`);
  // Đơn landing từ mọi trang Webcake (kể cả đơn bỏ dở) được kéo từ POS mỗi 5 phút.
  // Nhân viên sửa đơn trên POS: nội dung mới chép về đơn trong hội thoại, khung khách vẽ lại.
  const onPosContent = posOrders => applyPosContentToConversations(posOrders, {
    onChanged: async ({ conversationId, orders }) => {
      for (const order of orders) await appendOrderToArchive(order).catch(() => {});
      publishMessagingEvent({ type: 'customer-panel', conversationId });
    }
  });
  if (!process.env.POS_SYNC_DISABLED) startPosSync({ onCrmOrdersCancelled: cancelCrmOrdersCancelledOnPos, onPosConversationOrders: importPosConversationOrders, onPosContent });
  // Kênh Pancake: kéo lịch sử lúc khởi động và định kỳ, phòng lọt tin khi webhook gián đoạn.
  // Đồng bộ định kỳ cũng đưa bot tin khách mới chưa ai trả lời (webhook Pancake bỏ sót / tạm ngưng).
  // Cùng móc như webhook: chào khách quét QR và bỏ tin quét thẻ khỏi bot.
  startPancakeSync({ chatbotDependencies, processChatbotChanges: syncBotHook });
  // Bám đuổi: kịch bản nền (khách im lặng sau khi Page trả lời → gửi ưu đãi), mỗi 15 phút.
  startFollowUpLoop({ readSettings: readChatbotSettings, sendMessage: sendConversationMessage, conversationInfo: followUpConversationInfo });
  // Sapo: mã vận đơn J&T/SPX (đơn Facebook nhân viên import từ Pancake) ghép vào đơn CRM mỗi 10 phút;
  // báo khách theo giai đoạn (bật/tắt ở trang Vận chuyển): trong 24 giờ máy chủ tự gửi, ngoài 24 giờ vào hàng chờ.
  startSapoSync({
    readMessagingStore,
    updateMessagingStore,
    readLandingStore,
    updateLandingStore,
    sendMessage: sendConversationMessage,
    genderOf: followUpGender,
    readTemplates: shipmentTemplates,
    trackSpx: getSpxTracking,
    labelIds: shipmentLabelIds,
    onLabelChanges: changes => publishShipmentLabelChanges(changes).catch(error => console.warn(`Ghi thẻ vận đơn lỗi: ${error.message}`)),
    onChanged: conversationId => publishMessagingEvent({ type: 'customer-panel', conversationId })
  });
  // Quản lý chiến dịch: kéo số liệu quảng cáo mỗi 60 phút (tắt khi chưa cấu hình META_ADS_* hay đặt META_ADS_SYNC_DISABLED).
  startAdInsightsSync();
  // Báo cáo Lark: mặc định 08:00 gửi số liệu ngày hôm trước; trạng thái chống gửi trùng nằm trong data/processed.
  startLarkReportScheduler({ loadReport });
  // Thẻ "Đã mua hàng" trong CRM: gắn bù 30 giây sau khởi động rồi mỗi 5 phút.
  const purchaseLabelPass = () => runPurchaseLabelBackfill().catch(error => console.warn(`Gắn bù thẻ Đã mua hàng lỗi: ${error.message}`));
  setTimeout(purchaseLabelPass, 30 * 1000).unref?.();
  setInterval(purchaseLabelPass, 5 * 60 * 1000).unref?.();
  // Thẻ "Số điện thoại": gắn ngay khi tin khách có SĐT về, quét bù 40 giây sau khởi động rồi mỗi 5 phút.
  subscribeToMessagingEvents(queuePhoneLabel);
  const phoneLabelPass = () => runPhoneLabelPass().catch(error => console.warn(`Gắn bù thẻ Số điện thoại lỗi: ${error.message}`));
  setTimeout(phoneLabelPass, 40 * 1000).unref?.();
  setInterval(phoneLabelPass, 5 * 60 * 1000).unref?.();
  if (!auth.enabled && authConfig.requireLogin) console.error('CHƯA CẤU HÌNH ĐĂNG NHẬP: máy chủ bắt buộc đăng nhập (PUBLIC_BASE_URL https hoặc CRM_REQUIRE_LOGIN=1) mà chưa có tài khoản — giao diện/API trả 503 cho tới khi khai CRM_LOGIN_USERS hoặc Nhân sự có mật khẩu.');
  else if (!auth.enabled) console.warn('CRM_LOGIN_USERS trống: giao diện không hỏi đăng nhập. Chỉ để vậy khi chạy trên máy mình.');
  else if (!authConfig.sessionSecret) console.warn('CRM_SESSION_SECRET trống: khoá phiên sinh ngẫu nhiên, khởi động lại là mọi người phải đăng nhập lại.');
  if (isPancakeConfigured() && pancakeConfig.defaultPath) {
    console.warn(`Webhook Pancake ở đường MẶC ĐỊNH ${pancakeConfig.path}: Pancake không gửi token nên gói được nhận theo page_id (công khai) — ai biết đường này gửi tin giả được. Đặt PANCAKE_WEBHOOK_PATH bí mật (dài, ngẫu nhiên) trong .env, nhập đúng URL đó ở Pancake → Webhook, rồi bật PANCAKE_WEBHOOK_REQUIRE_SECRET=1.${pancakeConfig.requireSecret ? ' (Đang bật chặn: gói không token ở đường này bị bỏ.)' : ''}`);
  }
  // Nạp sẵn mô hình intent (readFileSync 2–3 MB mỗi tệp, ~50–60 ms) ngay sau khởi động thay vì ở tin khách đầu tiên.
  // warmUpChatbotModels (chatbot-engine) không ném; lỗi nạp tự ghi log.
  setImmediate(() => { warmUpChatbotModels().catch(() => {}); });
  console.log(`Meta webhook callback URL: ${metaConfig.webhookUrl}`);
  const missing = missingWebhookConfiguration();
  if (missing.length) console.log(`Webhook chưa sẵn sàng, còn thiếu: ${missing.join(', ')}`);
});
