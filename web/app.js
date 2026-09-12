const sidebarToggle = document.querySelector('#sidebar-toggle');
const viewNames = ['dashboard', 'messages', 'campaigns', 'orders', 'shipping', 'reports', 'settings'];
const views = new Map(viewNames.map(name => [name, document.querySelector(`#${name}-view`)]));
const navItems = [...document.querySelectorAll('.nav[data-view]')];
const messageSearchInput = document.querySelector('#message-search-input');
const conversationList = document.querySelector('.conversation-list');
const conversationEmpty = document.querySelector('#conversation-empty');
const conversationFilterButtons = [...document.querySelectorAll('[data-message-filter]')];
const messageChannelTrigger = document.querySelector('#message-channel-trigger');
const messageChannelLogo = document.querySelector('#message-channel-logo');
const messageChannelName = document.querySelector('#message-channel-name');
const messageChannelMenu = document.querySelector('#message-channel-menu');
const messageLabelFilter = document.querySelector('#message-label-filter');
const messageLabelMenu = document.querySelector('#message-label-menu');
const markUnreadButton = document.querySelector('#mark-unread-button');
const chatbotToggleButton = document.querySelector('#chatbot-toggle-button');
const messageComposerInput = document.querySelector('#message-composer-input');
const messageSendButton = document.querySelector('#message-send-button');
const messageReplyPreview = document.querySelector('#message-reply-preview');
const messageReplyTitle = document.querySelector('#message-reply-title');
const messageReplyText = document.querySelector('#message-reply-text');
const messageReplyClose = document.querySelector('#message-reply-close');
const messageImageInput = document.querySelector('#message-image-input');
const stickerButton = document.querySelector('#sticker-button');
const stickerPicker = document.querySelector('#sticker-picker');
const emojiButton = document.querySelector('#emoji-button');
const emojiPicker = document.querySelector('#emoji-picker');
const composerPreview = document.querySelector('#composer-preview');
const composerPreviewContent = document.querySelector('#composer-preview-content');
const composerPreviewRemove = document.querySelector('#composer-preview-remove');
const composerStatus = document.querySelector('#composer-status');
const audioRecordButton = document.querySelector('#audio-record-button');
const audioRecording = document.querySelector('#audio-recording');
const audioRecordingTime = document.querySelector('#audio-recording-time');
const audioRecordingCancel = document.querySelector('#audio-recording-cancel');
const audioRecordingStop = document.querySelector('#audio-recording-stop');
const chatBody = document.querySelector('.chat-body');
const imageLightbox = document.querySelector('#image-lightbox');
const imageLightboxContent = document.querySelector('#image-lightbox-content');
const imageLightboxDownload = document.querySelector('#image-lightbox-download');
const imageLightboxShare = document.querySelector('#image-lightbox-share');
const imageLightboxPrev = document.querySelector('#image-lightbox-prev');
const imageLightboxNext = document.querySelector('#image-lightbox-next');
const imageLightboxThumbnails = document.querySelector('#image-lightbox-thumbnails');
const imageLightboxZoom = document.querySelector('#image-lightbox-zoom');
const chatHeadAvatar = document.querySelector('.chat-head > .avatar');
const chatHeadName = document.querySelector('.chat-head > div:not(.chat-actions) strong');
const chatHeadMeta = document.querySelector('#chat-head-meta');
const chatHeadChannelLogo = document.querySelector('#chat-head-channel-logo');
const chatHeadChatTab = document.querySelector('#chat-head-chat-tab');
const chatHeadFileTab = document.querySelector('#chat-head-file-tab');
const chatHeadPinnedTab = document.querySelector('#chat-head-pinned-tab');
const chatHeadDocsTab = document.querySelector('#chat-head-docs-tab');
const chatPinnedPanel = document.querySelector('#chat-pinned-panel');
const chatPinnedSearch = document.querySelector('#chat-pinned-search');
const chatPinnedCount = document.querySelector('#chat-pinned-count');
const chatPinnedResults = document.querySelector('#chat-pinned-results');
const chatPinnedClose = document.querySelector('#chat-pinned-close');
const pinnedBanner = document.querySelector('#pinned-banner');
const messageDocumentInput = document.querySelector('#message-document-input');
const chatHeadAdd = document.querySelector('#chat-head-add');
const composerArea = document.querySelector('.composer-area');
const conversationSearchButton = document.querySelector('#conversation-search-button');
const conversationMenu = document.querySelector('#conversation-menu');
const contactInfoButton = document.querySelector('#contact-info-button');
const chatSearchBar = document.querySelector('#chat-search-bar');
const chatSearchInput = document.querySelector('#chat-search-input');
const chatSearchCount = document.querySelector('#chat-search-count');
const chatSearchClose = document.querySelector('#chat-search-close');
const chatSearchSender = document.querySelector('#chat-search-sender');
const chatSearchDate = document.querySelector('#chat-search-date');
const chatSearchResults = document.querySelector('#chat-search-results');
const contactPanelContent = document.querySelector('#contact-panel-content');
const customerPanelTabs = [...document.querySelectorAll('[data-customer-tab]')];
const customerPanelViews = [...document.querySelectorAll('[data-customer-panel]')];
const customerBotAlert = document.querySelector('#customer-bot-alert');
const customerNoteEmpty = document.querySelector('#customer-note-empty');
const customerNoteList = document.querySelector('#customer-note-list');
const customerNoteInput = document.querySelector('#customer-note-input');
const customerOrderCount = document.querySelector('#customer-order-count');
const customerOrderList = document.querySelector('#customer-order-list');
const customerOrderForm = document.querySelector('#customer-order-form');
const customerOrderName = document.querySelector('#customer-order-name');
const customerOrderPhone = document.querySelector('#customer-order-phone');
const customerOrderAddress = document.querySelector('#customer-order-address');
const customerOrderSavedAddress = document.querySelector('#customer-order-saved-address');
const customerOrderChip = document.querySelector('#customer-order-chip');
const customerOrderChipAvatar = document.querySelector('#customer-order-chip-avatar');
const customerOrderChipName = document.querySelector('#customer-order-chip-name');
const customerOrderChipPhone = document.querySelector('#customer-order-chip-phone');
const customerOrderChipCarrier = document.querySelector('#customer-order-chip-carrier');
const customerProductName = document.querySelector('#customer-product-name');
const customerProductQuantityLabel = document.querySelector('#customer-product-quantity-label');
const customerProductCombo = document.querySelector('#customer-product-combo');
const customerOrderWeight = document.querySelector('#customer-order-weight');
const customerProductAddButton = document.querySelector('#customer-product-add-button');
const customerProductEmpty = document.querySelector('#customer-product-empty');
const customerProductList = document.querySelector('#customer-product-list');
const customerFreeShipping = document.querySelector('#customer-free-shipping');
const customerBankTransfer = document.querySelector('#customer-bank-transfer');
const customerShippingFee = document.querySelector('#customer-shipping-fee');
const customerOrderDiscount = document.querySelector('#customer-order-discount');
const customerOrderSource = document.querySelector('#customer-order-source');
const customerOrderNote = document.querySelector('#customer-order-note');
const customerOrderSubtotal = document.querySelector('#customer-order-subtotal');
const customerOrderTotal = document.querySelector('#customer-order-total');
const customerOrderReset = document.querySelector('#customer-order-reset');
const customerOrderSubmit = document.querySelector('#customer-order-submit');
const topbarUserAvatar = document.querySelector('#topbar-user-avatar');
const topbarUserName = document.querySelector('#topbar-user-name');
const settingsForm = document.querySelector('#settings-form');
const settingsDisplayName = document.querySelector('#settings-display-name');
const settingsSendEnter = document.querySelector('#settings-send-enter');
const settingsShowContact = document.querySelector('#settings-show-contact');
const settingsCollapseSidebar = document.querySelector('#settings-collapse-sidebar');
const settingsStatus = document.querySelector('#settings-status');
const productCreateButton = document.querySelector('#product-create-button');
const productSearch = document.querySelector('#product-search');
const productCount = document.querySelector('#product-count');
const productList = document.querySelector('#product-list');
const productDialog = document.querySelector('#product-dialog');
const productForm = document.querySelector('#product-form');
const productDialogTitle = document.querySelector('#product-dialog-title');
const productImageInput = document.querySelector('#product-image-input');
const productImagePreview = document.querySelector('#product-image-preview');
const productImageRemove = document.querySelector('#product-image-remove');
const productName = document.querySelector('#product-name');
const productSku = document.querySelector('#product-sku');
const productOriginalPrice = document.querySelector('#product-original-price');
const productSalePrice = document.querySelector('#product-sale-price');
const productCombo2 = document.querySelector('#product-combo-2');
const productCombo3 = document.querySelector('#product-combo-3');
const productMixGroup = document.querySelector('#product-mix-group');
const productMixGroupOptions = document.querySelector('#product-mix-group-options');
const productActive = document.querySelector('#product-active');
const productAliases = document.querySelector('#product-aliases');
const productFormStatus = document.querySelector('#product-form-status');
const productSubmit = document.querySelector('#product-submit');
const sharedProductOptions = document.querySelector('#shared-product-options');
const chatbotSettingsForm = document.querySelector('#chatbot-settings-form');
const chatbotSettingsEnabled = document.querySelector('#chatbot-settings-enabled');
const chatbotSettingsProvider = document.querySelector('#chatbot-settings-provider');
const chatbotSettingsAuthType = document.querySelector('#chatbot-settings-auth-type');
const chatbotAuthTypeField = document.querySelector('#chatbot-auth-type-field');
const chatbotSettingsProtocol = document.querySelector('#chatbot-settings-protocol');
const chatbotProtocolField = document.querySelector('#chatbot-protocol-field');
const chatbotSettingsDirectEndpoint = document.querySelector('#chatbot-settings-direct-endpoint');
const chatbotSettingsDirectKey = document.querySelector('#chatbot-settings-direct-key');
const chatbotSettingsDirectModel = document.querySelector('#chatbot-settings-direct-model');
const chatbotEndpointLabel = document.querySelector('#chatbot-endpoint-label');
const chatbotApiKeyLabel = document.querySelector('#chatbot-api-key-label');
const chatbotSettingsSystemPrompt = document.querySelector('#chatbot-settings-system-prompt');
const chatbotSettingsSystemPromptCounter = document.querySelector('#chatbot-settings-system-prompt-counter');

function updateChatbotSystemPromptCounter() {
  if (!chatbotSettingsSystemPromptCounter || !chatbotSettingsSystemPrompt) return;
  const count = chatbotSettingsSystemPrompt.value ? chatbotSettingsSystemPrompt.value.length : 0;
  // Dify hiển thị đúng một con số ở góc khối prompt, không kèm đơn vị.
  chatbotSettingsSystemPromptCounter.textContent = count.toLocaleString('vi-VN');
  chatbotSettingsSystemPromptCounter.title = `${count.toLocaleString('vi-VN')} / 30.000 ký tự`;
}
chatbotSettingsSystemPrompt?.addEventListener('input', updateChatbotSystemPromptCounter);
const chatbotSettingsMemoryEnabled = document.querySelector('#chatbot-settings-memory-enabled');
const chatbotSettingsMemoryWindow = document.querySelector('#chatbot-settings-memory-window');
const chatbotSettingsMemoryWindowRange = document.querySelector('#chatbot-settings-memory-window-range');
const chatbotModelDisplay = document.querySelector('#chatbot-model-display');
const chatbotModelParamsButton = document.querySelector('#chatbot-model-params');
const chatbotDirectConfig = document.querySelector('#chatbot-direct-config');

/** Keeps the Dify-style summary row in step with the advanced fields behind it. */
function syncChatbotModelDisplay() {
  if (!chatbotModelDisplay) return;
  const select = document.querySelector('#chatbot-settings-direct-model');
  const label = select?.selectedOptions?.[0]?.textContent?.trim();
  if (label) chatbotModelDisplay.textContent = label;
}

function syncChatbotMemoryWindow(source) {
  if (!chatbotSettingsMemoryWindow || !chatbotSettingsMemoryWindowRange) return;
  const raw = Number(source === 'range' ? chatbotSettingsMemoryWindowRange.value : chatbotSettingsMemoryWindow.value);
  const value = Math.min(100, Math.max(1, Math.round(raw) || 1));
  chatbotSettingsMemoryWindow.value = String(value);
  chatbotSettingsMemoryWindowRange.value = String(value);
}

chatbotSettingsMemoryWindowRange?.addEventListener('input', () => syncChatbotMemoryWindow('range'));
chatbotSettingsMemoryWindow?.addEventListener('input', () => syncChatbotMemoryWindow('number'));
document.querySelector('#chatbot-settings-direct-model')?.addEventListener('change', syncChatbotModelDisplay);
chatbotModelParamsButton?.addEventListener('click', () => {
  if (!chatbotDirectConfig) return;
  chatbotDirectConfig.open = !chatbotDirectConfig.open;
  chatbotModelParamsButton.setAttribute('aria-expanded', String(chatbotDirectConfig.open));
  if (chatbotDirectConfig.open) chatbotDirectConfig.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
const chatbotSettingsStructuredOutput = document.querySelector('#chatbot-settings-structured-output');
const chatbotSettingsRetryCount = document.querySelector('#chatbot-settings-retry-count');
const chatbotSettingsRetryInterval = document.querySelector('#chatbot-settings-retry-interval');
const chatbotSettingsWelcome = document.querySelector('#chatbot-settings-welcome');
const chatbotPreviewSend = document.querySelector('#chatbot-preview-send');
const chatbotPreviewReset = document.querySelector('#chatbot-preview-reset');
const chatbotPreviewInput = document.querySelector('#chatbot-preview-input');
const chatbotPreviewResult = document.querySelector('#chatbot-preview-result');
const chatbotPreviewDialog = document.querySelector('#chatbot-preview-dialog');
const chatbotPreviewOpen = document.querySelector('#chatbot-preview-open');
const chatbotPreviewClose = document.querySelector('#chatbot-preview-close');
const chatbotPreviewDialogInput = document.querySelector('#chatbot-preview-dialog-input');
const chatbotPreviewDialogSend = document.querySelector('#chatbot-preview-dialog-send');
const chatbotWorkspaceButtons = [...document.querySelectorAll('[data-chatbot-workspace]')];
const chatbotWorkspacePanels = [...document.querySelectorAll('[data-chatbot-workspace-panel]')];
const chatbotTemplateSearch = document.querySelector('#chatbot-template-search');
const chatbotTemplateList = document.querySelector('#chatbot-template-list');
const chatbotTemplateAdd = document.querySelector('#chatbot-template-add');
const chatbotTemplateCreate = document.querySelector('#chatbot-template-create');
const chatbotTemplateNewId = document.querySelector('#chatbot-template-new-id');
const chatbotTemplateCreateCancel = document.querySelector('#chatbot-template-create-cancel');
const chatbotTemplateCreateConfirm = document.querySelector('#chatbot-template-create-confirm');
const chatbotTemplateId = document.querySelector('#chatbot-template-id');
const chatbotTemplateContent = document.querySelector('#chatbot-template-content');
const chatbotTemplateActive = document.querySelector('#chatbot-template-active');
const chatbotTemplateApply = document.querySelector('#chatbot-template-apply');
const chatbotTemplateReset = document.querySelector('#chatbot-template-reset');
const chatbotTemplateDelete = document.querySelector('#chatbot-template-delete');
const chatbotWorkflow = document.querySelector('#chatbot-workflow');
const chatbotStepCodeTitle = document.querySelector('#chatbot-step-code-title');
const chatbotStepCode = document.querySelector('#chatbot-step-code');
const chatbotStepCodeApply = document.querySelector('#chatbot-step-code-apply');
const chatbotStepSummary = document.querySelector('#chatbot-step-summary');
let chatbotTemplatesState = {};
let chatbotOriginalTemplates = {};
let chatbotDeletedTemplateIds = new Set();
let chatbotProcessingSteps = [];
let chatbotPreviewHistory = [];
let selectedChatbotTemplate = '';
let selectedChatbotStep = '';
let sharedProducts = [];
let selectedProductId = '';
let pendingProductImage = '';
let removeCurrentProductImage = false;
const facebookConnectButton = document.querySelector('#facebook-connect-button');
const zaloConnectButton = document.querySelector('#zalo-connect-button');
const facebookChannelList = document.querySelector('#facebook-channel-list');
const facebookPageDialog = document.querySelector('#facebook-page-dialog');
const facebookPageOptions = document.querySelector('#facebook-page-options');
const facebookPageDialogStatus = document.querySelector('#facebook-page-dialog-status');
const facebookPageConfirm = document.querySelector('#facebook-page-confirm');
const shippingTrackingForm = document.querySelector('#shipping-tracking-form');
const shippingTrackingInput = document.querySelector('#shipping-tracking-input');
const shippingTrackingSubmit = document.querySelector('#shipping-tracking-submit');
const shippingResult = document.querySelector('#shipping-result');
const shippingRecentList = document.querySelector('#shipping-recent-list');
const shippingClearHistory = document.querySelector('#shipping-clear-history');
const appSettingsKey = 'crm-app-settings';
const savedChatMessagesKey = 'crm-chat-messages';
const chatMessageActionsKey = 'crm-chat-message-actions';
const chatPinnedMessagesKey = 'crm-chat-pinned-messages';
const chatMessageReactionsKey = 'crm-chat-message-reactions';
const shippingHistoryKey = 'crm-spx-tracking-history';
const chatTimeBreakMs = 15 * 60 * 1000;
const unreadConversationsKey = 'crm-unread-conversations';
const mutedConversationsKey = 'crm-muted-conversations';
let currentConversationFilter = 'all';
let currentMessageLabel = 'all';
let currentMessageChannelId = 'local-facebook';
let currentChatHeadView = 'chat';
let messageChannels = [];
let appSettings = loadAppSettings();
let pendingAttachment = null;
let audioRecorder = null;
let audioStream = null;
let audioChunks = [];
let audioRecordingStartedAt = 0;
let audioRecordingTimer = null;
let discardAudioRecording = false;
let composerStatusTimer = null;
let lightboxImages = [];
let lightboxIndex = 0;
let lightboxZoom = 1;
let messageTimeTooltip = null;
let messageTimeTooltipRow = null;
let messageTimeTooltipFrame = 0;
let conversationMenuTarget = null;
let conversationSearchMatches = [];
let conversationSearchIndex = -1;
let usingRemoteConversations = false;
let messagingStream = null;
const remoteConversations = new Map();
const remoteMessages = new Map();
const syncedChannelIds = new Set();
let customerDraftProducts = [];
let customerPanelStore = { notes: {}, orders: {}, bots: {} };
let customerPanelRequestId = 0;

try {
  const savedCustomerPanel = JSON.parse(localStorage.getItem('crm-customer-panel-v1') || 'null');
  if (savedCustomerPanel && typeof savedCustomerPanel === 'object') {
    customerPanelStore = {
      notes: savedCustomerPanel.notes && typeof savedCustomerPanel.notes === 'object' ? savedCustomerPanel.notes : {},
      orders: savedCustomerPanel.orders && typeof savedCustomerPanel.orders === 'object' ? savedCustomerPanel.orders : {},
      bots: savedCustomerPanel.bots && typeof savedCustomerPanel.bots === 'object' ? savedCustomerPanel.bots : {}
    };
  }
} catch {
  localStorage.removeItem('crm-customer-panel-v1');
}

const conversationProfiles = {
  'Lan Anh': {
    status: 'Đang hoạt động',
    email: 'lananh@example.com',
    phone: '+84 912 345 678',
    order: ['#GN-240901', 'Granola tháng 9', '1', 'Đã mua', '+84 912 345 678', '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh', '890.000 đ'],
    messages: [
      { direction: 'incoming', text: 'Chào shop, mình muốn hỏi về sản phẩm Granola tháng 9 ạ.' },
      { direction: 'outgoing', text: 'Chào Lan Anh, mình hỗ trợ bạn ngay nhé.' },
      { direction: 'incoming', text: 'Sản phẩm này còn hàng không shop?' }
    ]
  }
};

getConversationItems().forEach(ensureConversationMetadata);
const orderNav = document.querySelector('.nav[data-view="orders"]');
const orderStageButtons = [...document.querySelectorAll('[data-order-stage]')];
const settingsNav = document.querySelector('.nav[data-view="settings"]');
const settingsSectionButtons = [...document.querySelectorAll('[data-settings-section]')];
const settingsPanels = new Map([...document.querySelectorAll('[data-settings-panel]')].map(panel => [panel.dataset.settingsPanel, panel]));
const orderPanels = new Map([...document.querySelectorAll('[data-order-panel]')].map(panel => [panel.dataset.orderPanel, panel]));
const orderImport = document.querySelector('#order-import');
const orderSearch = document.querySelector('#order-search');
const orderFilter = document.querySelector('#order-filter');
const orderHistoryButton = document.querySelector('#order-history-button');
const orderHistoryPanel = document.querySelector('#order-history-panel');
const customerOrdersPreview = document.querySelector('#customer-orders-preview');
const orderExport = document.querySelector('#order-export');
let orderData = { headers: [], rows: [] };
let orderImportHistory = [];
const hiddenPreviewColumns = new Set(['ma don hang', 'phuong xa', 'quan huyen', 'tinh thanh pho', 'ma mau ma']);

try {
  const savedOrderData = JSON.parse(localStorage.getItem('crm-orders') || 'null');
  if (savedOrderData && Array.isArray(savedOrderData.headers) && Array.isArray(savedOrderData.rows)) orderData = savedOrderData;
} catch {
  localStorage.removeItem('crm-orders');
}

try {
  const savedImportHistory = JSON.parse(localStorage.getItem('crm-order-import-history') || '[]');
  if (Array.isArray(savedImportHistory)) orderImportHistory = savedImportHistory;
} catch {
  localStorage.removeItem('crm-order-import-history');
}

function showView(name) {
  views.forEach((view, viewName) => view.classList.toggle('hidden', viewName !== name));
  navItems.forEach(item => item.classList.toggle('active', item.dataset.view === name));
  orderNav.setAttribute('aria-expanded', String(name === 'orders'));
  settingsNav?.setAttribute('aria-expanded', String(name === 'settings'));
  if (window.location.hash !== `#${name}`) window.location.hash = name;
  if (name === 'orders') loadCustomerOrdersManagement();
}

async function loadCustomerOrdersManagement() {
  if (!customerOrdersPreview) return;
  try {
    const result = await readApiResponse(await fetch('/api/customer-orders'));
    if (!result.items?.length) {
      customerOrdersPreview.innerHTML = '<p>Chưa có đơn nào được tạo từ hội thoại.</p>';
      return;
    }
    customerOrdersPreview.innerHTML = `<div class="customer-orders-management-list">${result.items.map(order => `<div class="customer-orders-management-row">
      <strong>#${escapeHtml(order.id)}</strong><span>${escapeHtml(order.name || order.conversationName)}</span><span>${escapeHtml(order.phone)}</span>
      <span class="customer-orders-management-status">${order.delivery?.status === 'sent' ? '✓ Đã gửi khách' : escapeHtml(order.status || 'Mới')}</span><strong>${escapeHtml(formatOrderMoney(order.total))}</strong>
    </div>`).join('')}</div>`;
  } catch (error) {
    customerOrdersPreview.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
}

function formatShippingTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(date);
}

function formatShippingDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(date);
}

function shippingVietnameseStatus(tracking) {
  if (tracking.description) return tracking.description;
  const status = String(tracking.status || '').toLowerCase();
  if (status.includes('delivered')) return 'Đã giao hàng';
  if (status.includes('out for delivery')) return 'Đang giao hàng';
  if (status.includes('transit')) return 'Đang vận chuyển';
  if (status.includes('pickup')) return 'Chờ lấy hàng';
  return tracking.status || 'Đã tiếp nhận thông tin vận đơn';
}

function shippingMilestoneIndex(tracking) {
  const text = `${tracking.status || ''} ${tracking.description || ''}`.toLowerCase();
  if (text.includes('delivered') || text.includes('đã giao hàng') || text.includes('giao hàng thành công')) return 3;
  if (text.includes('out for delivery') || text.includes('đang giao hàng')) return 2;
  if (text.includes('transit') || text.includes('vận chuyển') || text.includes('đã đến kho')) return 1;
  return 0;
}

function renderShippingMilestones(tracking) {
  const current = shippingMilestoneIndex(tracking);
  const labels = ['Chờ lấy hàng', 'Đang vận chuyển', 'Đang giao hàng', 'Đã giao hàng'];
  return `<div class="shipping-milestones" aria-label="Tiến trình giao hàng">
    ${labels.map((label, index) => {
      const state = index < current ? ' complete' : index === current ? ' current' : '';
      const icon = index < current ? 'check' : index === 2 ? 'scooter' : index === 3 ? 'delivered' : 'check';
      const item = `<div class="shipping-milestone${state}"><span class="shipping-milestone-icon icon-${icon}" aria-hidden="true"></span><span class="shipping-milestone-label">${label}</span></div>`;
      if (index === labels.length - 1) return item;
      return `${item}<span class="shipping-milestone-line${index < current ? ' complete' : ''}" aria-hidden="true"></span>`;
    }).join('')}
  </div>`;
}

function readShippingHistory() {
  try {
    const history = JSON.parse(localStorage.getItem(shippingHistoryKey) || '[]');
    return Array.isArray(history) ? history.filter(item => item && item.trackingNumber).slice(0, 8) : [];
  } catch {
    localStorage.removeItem(shippingHistoryKey);
    return [];
  }
}

function renderShippingHistory() {
  if (!shippingRecentList) return;
  const history = readShippingHistory();
  shippingClearHistory?.classList.toggle('hidden', history.length === 0);
  if (!history.length) {
    shippingRecentList.innerHTML = '<p class="shipping-recent-empty">Chưa có mã vận đơn nào.</p>';
    return;
  }
  shippingRecentList.innerHTML = history.map(item => `
    <button class="shipping-recent-item" type="button" data-tracking-number="${escapeHtml(item.trackingNumber)}">
      <span><strong>${escapeHtml(item.trackingNumber)}</strong><small>${escapeHtml(item.status || 'SPX Express')}</small></span>
      <time>${escapeHtml(formatShippingTime(item.checkedAt))}</time>
    </button>`).join('');
}

function rememberShippingLookup(tracking) {
  const history = readShippingHistory().filter(item => item.trackingNumber !== tracking.trackingNumber);
  history.unshift({
    trackingNumber: tracking.trackingNumber,
    status: shippingVietnameseStatus(tracking),
    checkedAt: new Date().toISOString()
  });
  localStorage.setItem(shippingHistoryKey, JSON.stringify(history.slice(0, 8)));
  renderShippingHistory();
}

function renderShippingLoading(trackingNumber) {
  shippingResult.innerHTML = `
    <div class="shipping-loading" role="status">
      <span class="shipping-spinner" aria-hidden="true"></span>
      <h2>Đang kiểm tra ${escapeHtml(trackingNumber)}</h2>
      <p>Đang lấy trạng thái mới nhất từ SPX Express...</p>
    </div>`;
}

function renderShippingError(message) {
  shippingResult.innerHTML = `
    <div class="shipping-error-state" role="alert">
      <span aria-hidden="true">!</span>
      <h2>Chưa tra cứu được vận đơn</h2>
      <p>${escapeHtml(message)}</p>
    </div>`;
}

function renderShippingTracking(tracking) {
  const vietnameseStatus = shippingVietnameseStatus(tracking);
  const timeline = tracking.records?.length
    ? tracking.records.map((record, index) => `
      <li class="shipping-timeline-item${index === 0 ? ' current' : ''}">
        <time class="shipping-timeline-time">${escapeHtml(formatShippingTime(record.time))}</time>
        <span class="shipping-timeline-dot" aria-hidden="true"></span>
        <div>
          <div class="shipping-timeline-head"><strong>${escapeHtml(record.description || record.status)}</strong></div>
          ${record.location ? `<small>${escapeHtml(record.location)}</small>` : ''}
        </div>
      </li>`).join('')
    : '<li class="shipping-timeline-empty">SPX chưa cập nhật hành trình chi tiết cho vận đơn này.</li>';
  shippingResult.innerHTML = `
    <header class="shipping-order-summary">
      <div class="shipping-order-title">Mã Vận Đơn: <strong>${escapeHtml(tracking.trackingNumber)}</strong><span class="shipping-status-tag">${escapeHtml(vietnameseStatus)}</span></div>
      ${tracking.customerTrackingNumber ? `<div class="shipping-customer-code">Mã khách hàng: ${escapeHtml(tracking.customerTrackingNumber)}</div>` : ''}
      ${tracking.expectedDeliveryAt ? `<div class="shipping-edd"><i class="shipping-edd-calendar" aria-hidden="true"></i><span>Ngày dự kiến giao hàng: ${escapeHtml(formatShippingDate(tracking.expectedDeliveryAt))}</span><i class="shipping-edd-info" aria-hidden="true"></i></div>` : ''}
    </header>
    ${renderShippingMilestones(tracking)}
    <ol class="shipping-timeline">${timeline}</ol>`;
}

async function lookupSpxTracking(value) {
  const trackingNumber = String(value || '').trim().toUpperCase();
  if (!trackingNumber) {
    shippingTrackingInput?.focus();
    return;
  }
  shippingTrackingInput.value = trackingNumber;
  shippingTrackingSubmit.disabled = true;
  renderShippingLoading(trackingNumber);
  try {
    const response = await fetch(`/api/shipping/spx/track?trackingNumber=${encodeURIComponent(trackingNumber)}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Không thể tra cứu vận đơn SPX.');
    renderShippingTracking(result);
    rememberShippingLookup(result);
  } catch (error) {
    renderShippingError(error.message);
  } finally {
    shippingTrackingSubmit.disabled = false;
  }
}

function loadAppSettings() {
  const defaults = {
    displayName: 'Huy Facebook',
    sendWithEnter: true,
    showContactPanel: true,
    collapseSidebar: localStorage.getItem('crm-sidebar-collapsed') === 'true'
  };
  try {
    const saved = JSON.parse(localStorage.getItem(appSettingsKey) || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return defaults;
    return {
      displayName: typeof saved.displayName === 'string' && saved.displayName.trim() ? saved.displayName.trim() : defaults.displayName,
      sendWithEnter: typeof saved.sendWithEnter === 'boolean' ? saved.sendWithEnter : defaults.sendWithEnter,
      showContactPanel: typeof saved.showContactPanel === 'boolean' ? saved.showContactPanel : defaults.showContactPanel,
      collapseSidebar: typeof saved.collapseSidebar === 'boolean' ? saved.collapseSidebar : defaults.collapseSidebar
    };
  } catch {
    localStorage.removeItem(appSettingsKey);
    return defaults;
  }
}

function saveAppSettings() {
  localStorage.setItem(appSettingsKey, JSON.stringify(appSettings));
}

function applyAppSettings() {
  const displayName = appSettings.displayName || 'Huy Facebook';
  if (topbarUserName) topbarUserName.textContent = displayName;
  if (topbarUserAvatar) topbarUserAvatar.textContent = displayName.trim().charAt(0).toUpperCase() || 'H';
  document.body.classList.toggle('hide-contact-panel', !appSettings.showContactPanel);
  if (settingsDisplayName) settingsDisplayName.value = displayName;
  if (settingsSendEnter) settingsSendEnter.checked = appSettings.sendWithEnter;
  if (settingsShowContact) settingsShowContact.checked = appSettings.showContactPanel;
  if (settingsCollapseSidebar) settingsCollapseSidebar.checked = appSettings.collapseSidebar;
  updateContactInfoButton();
}

function updateContactInfoButton() {
  if (!contactInfoButton) return;
  contactInfoButton.classList.toggle('active', appSettings.showContactPanel);
  contactInfoButton.setAttribute('aria-pressed', String(appSettings.showContactPanel));
  contactInfoButton.title = appSettings.showContactPanel ? 'Ẩn thông tin khách hàng' : 'Xem thông tin khách hàng';
}

function showOrderStage(stage) {
  showView('orders');
  orderPanels.forEach((panel, panelName) => panel.classList.toggle('hidden', panelName !== stage));
  orderStageButtons.forEach(button => button.classList.toggle('active', button.dataset.orderStage === stage));
}

function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const output = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      row.push(value);
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value);
      output.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }
  if (value || row.length) { row.push(value); output.push(row); }
  return output;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function showToast(message, type = 'error') {
  document.querySelector('.app-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = `app-toast app-toast--${type}`;
  toast.textContent = message;
  toast.setAttribute('role', 'status');
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3500);
}

async function readApiResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Không thể hoàn tất yêu cầu. Vui lòng thử lại.');
  return payload;
}

function channelAvatar(channel) {
  return channel.picture
    ? `<span class="channel-item-avatar"><img src="${escapeHtml(channel.picture)}" alt=""></span>`
    : `<span class="channel-item-avatar">${escapeHtml(channel.name.trim().charAt(0).toUpperCase() || 'f')}</span>`;
}

function renderFacebookChannels(state) {
  const items = Array.isArray(state.items) ? state.items : [];
  if (facebookConnectButton) {
    facebookConnectButton.disabled = false;
    facebookConnectButton.title = '';
  }
  if (!facebookChannelList) return;
  facebookChannelList.innerHTML = items.length ? items.map(channel => {
    const healthy = channel.status === 'connected';
    const subscriptionText = channel.subscribed
      ? 'Đã đăng ký nhận tin nhắn'
      : `Đã kết nối · ${channel.subscriptionError || 'chưa đăng ký webhook'}`;
    return `<article class="channel-item" data-channel-id="${escapeHtml(channel.id)}">
      ${channelAvatar(channel)}
      <div class="channel-item-copy"><strong>${escapeHtml(channel.name)}</strong><small><span class="channel-connected-dot${healthy ? '' : ' warning'}"></span>${escapeHtml(subscriptionText)} · ID ${escapeHtml(channel.id)}</small></div>
      <div class="channel-item-actions"><button type="button" data-channel-action="refresh">Làm mới</button><button class="channel-remove-button" type="button" data-channel-action="remove">Ngắt kết nối</button></div>
    </article>`;
  }).join('') : '<p class="channel-empty">Chưa có Facebook Page nào được kết nối.</p>';
}

async function loadFacebookChannels() {
  try {
    const state = await readApiResponse(await fetch('/api/channels'));
    renderFacebookChannels(state);
    return state;
  } catch (error) {
    if (facebookChannelList) facebookChannelList.innerHTML = `<p class="channel-empty">${escapeHtml(error.message)}</p>`;
    throw error;
  }
}

function closeFacebookPageDialog() {
  facebookPageDialog?.classList.add('hidden');
  if (facebookPageDialogStatus) facebookPageDialogStatus.textContent = '';
}

async function openPendingFacebookPages(ticket) {
  const pending = await readApiResponse(await fetch(`/api/channels/meta/pending?ticket=${encodeURIComponent(ticket)}`));
  if (!facebookPageOptions) return;
  facebookPageOptions.dataset.ticket = ticket;
  facebookPageOptions.innerHTML = pending.pages.map(page => {
    const connected = pending.connectedIds.includes(page.id);
    return `<label class="facebook-page-option">
      <input type="checkbox" value="${escapeHtml(page.id)}"${connected ? ' checked' : ''}>
      ${channelAvatar(page)}
      <span><strong>${escapeHtml(page.name)}</strong><small>Facebook Page · ID ${escapeHtml(page.id)}</small></span>
    </label>`;
  }).join('');
  facebookPageDialog?.classList.remove('hidden');
}

async function beginFacebookConnection() {
  if (!facebookConnectButton) return;
  const originalText = facebookConnectButton.innerHTML;
  facebookConnectButton.disabled = true;
  facebookConnectButton.textContent = 'Đang mở Facebook...';
  try {
    const result = await readApiResponse(await fetch('/api/channels/meta/connect'));
    window.location.assign(result.authorizationUrl);
  } catch (error) {
    showToast(error.message);
    facebookConnectButton.disabled = false;
    facebookConnectButton.innerHTML = originalText;
  }
}

async function confirmFacebookPages() {
  const selected = [...(facebookPageOptions?.querySelectorAll('input:checked') || [])].map(input => input.value);
  if (!selected.length) {
    if (facebookPageDialogStatus) facebookPageDialogStatus.textContent = 'Hãy chọn ít nhất 1 Facebook Page.';
    return;
  }
  facebookPageConfirm.disabled = true;
  if (facebookPageDialogStatus) facebookPageDialogStatus.textContent = 'Đang kết nối và đăng ký nhận tin nhắn...';
  try {
    const result = await readApiResponse(await fetch('/api/channels/meta/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: facebookPageOptions.dataset.ticket, pageIds: selected })
    }));
    closeFacebookPageDialog();
    showToast(`Đã kết nối ${result.items?.length || selected.length} Facebook Page.`, 'success');
    history.replaceState(null, '', `${window.location.pathname}#settings`);
    await loadFacebookChannels().catch(() => {});
    await loadMessageChannels().catch(() => {});
  } catch (error) {
    if (facebookPageDialogStatus) facebookPageDialogStatus.textContent = error.message;
  } finally {
    facebookPageConfirm.disabled = false;
  }
}

function renderOrderImportHistory() {
  if (!orderImportHistory.length) {
    orderHistoryPanel.innerHTML = '<p>Chưa có lịch sử Import.</p>';
    return;
  }
  orderHistoryPanel.innerHTML = orderImportHistory.map(entry => {
    const importedAt = new Date(entry.importedAt);
    const timeLabel = Number.isNaN(importedAt.getTime()) ? '' : importedAt.toLocaleString('vi-VN');
    return `<div class="order-history-item"><div><strong>${escapeHtml(entry.fileName || 'Tệp dữ liệu')}</strong><small>${escapeHtml(timeLabel)}</small></div><span>${Number(entry.rowCount) || 0} đơn</span></div>`;
  }).join('');
}

function recordOrderImport(fileName) {
  orderImportHistory.unshift({ fileName, rowCount: orderData.rows.length, importedAt: new Date().toISOString() });
  orderImportHistory = orderImportHistory.slice(0, 10);
  localStorage.setItem('crm-order-import-history', JSON.stringify(orderImportHistory));
  renderOrderImportHistory();
}

function createExportFilename(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `don-hang-facebook-${day}-${time}.xlsx`;
}

function normalizeColumnName(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getMessageChannelLogo(channel) {
  if (channel.picture) return channel.picture;
  if (channel.platform === 'zalo') return '/assets/icons/zalo.png?v=1';
  return '/assets/giot-nang-logo.webp';
}

function renderMessageChannelMenu() {
  if (!messageChannelMenu) return;
  messageChannelMenu.innerHTML = messageChannels.map(channel => `<button class="message-channel-option${channel.id === currentMessageChannelId ? ' active' : ''}" type="button" role="menuitem" data-message-channel="${escapeHtml(channel.id)}">
    <img src="${escapeHtml(getMessageChannelLogo(channel))}" alt="">
    <span><strong>${escapeHtml(channel.name)}</strong><small>${channel.platform === 'zalo' ? 'Zalo OA' : 'Facebook Page'}</small></span>
    ${channel.id === currentMessageChannelId ? '<b aria-hidden="true">✓</b>' : ''}
  </button>`).join('');
}

function updateMessageChannelTrigger() {
  const channel = messageChannels.find(item => item.id === currentMessageChannelId) || messageChannels[0];
  if (!channel) return;
  if (messageChannelLogo) messageChannelLogo.src = getMessageChannelLogo(channel);
  if (messageChannelName) messageChannelName.textContent = channel.name;
  if (messageChannelTrigger) {
    messageChannelTrigger.title = `${channel.name} · Bấm để chuyển kênh`;
    messageChannelTrigger.setAttribute('aria-label', `Chọn kênh kết nối. Kênh hiện tại: ${channel.name}`);
  }
  renderMessageChannelMenu();
}

function showEmptyChannelConversation() {
  const channel = messageChannels.find(item => item.id === currentMessageChannelId);
  const channelName = channel?.name || 'kênh này';
  clearMessageReply();
  if (chatHeadAvatar) chatHeadAvatar.textContent = channel?.platform === 'zalo' ? 'Z' : 'F';
  if (chatHeadName) chatHeadName.textContent = 'Chưa có hội thoại';
  chatHeadMeta?.classList.add('hidden');
  if (chatBody) chatBody.innerHTML = `<div class="chat-empty-state">Chưa có tin nhắn trong ${escapeHtml(channelName)}.</div>`;
  renderCustomerPanel(null);
  if (messageComposerInput) { messageComposerInput.value = ''; messageComposerInput.disabled = true; }
  if (messageSendButton) messageSendButton.disabled = true;
}

function activateCurrentMessageChannel() {
  updateMessageChannelTrigger();
  filterConversations();
  const visibleConversations = getConversationItems().filter(item => !item.classList.contains('hidden'));
  getConversationItems().forEach(item => item.classList.remove('active'));
  if (visibleConversations.length) {
    visibleConversations[0].classList.add('active');
    if (messageComposerInput) messageComposerInput.disabled = false;
    renderConversation(visibleConversations[0]);
    ensureRemoteMessages(visibleConversations[0]);
    updateMessageSendState();
  } else {
    showEmptyChannelConversation();
  }
  updateMarkUnreadButton();
}

function conversationPreviewText(conversation) {
  const preview = conversation.lastMessagePreview || 'Chưa có tin nhắn';
  return conversation.lastMessageDirection === 'outgoing' ? `Bạn: ${preview}` : preview;
}

function conversationInitial(name) {
  return String(name || '').trim().charAt(0).toUpperCase() || 'F';
}

function updateConversationElement(element, conversation) {
  element.dataset.channelId = conversation.channelId;
  element.dataset.psid = conversation.psid;
  element.dataset.source = conversation.source || 'inbox';
  element.dataset.avatar = conversation.picture || '';
  element.dataset.labels = (conversation.labels || []).join(' ');
  element.classList.toggle('unread', Boolean(conversation.unread));
  element.classList.toggle('muted', Boolean(conversation.muted));
  const avatar = element.querySelector('.avatar');
  if (avatar) {
    avatar.textContent = conversationInitial(conversation.name);
    applyAvatarPhoto(avatar, conversation.picture || '');
  }
  const name = element.querySelector('strong');
  if (name) name.textContent = conversation.name;
  const preview = element.querySelector('small');
  if (preview) preview.textContent = conversationPreviewText(conversation);
  const time = element.querySelector('time');
  if (time) time.textContent = conversation.lastMessageAt ? formatConversationActivityTime(conversation.lastMessageAt) : '';
  if (conversation.lastMessageAt) element.dataset.latestSentAt = String(conversation.lastMessageAt);
  element.dataset.initialPreview = conversationPreviewText(conversation);
  element.dataset.initialTime = time?.textContent || '';
  renderConversationSourceBadge(element);
  renderConversationMuteIcon(element);
  return element;
}

function buildConversationElement(conversation) {
  const element = document.createElement('div');
  element.className = 'conversation';
  element.setAttribute('role', 'button');
  element.tabIndex = 0;
  element.dataset.conversationId = conversation.id;
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  const copy = document.createElement('span');
  copy.className = 'conversation-copy';
  copy.append(document.createElement('strong'), document.createElement('small'));
  const time = document.createElement('time');
  const more = document.createElement('button');
  more.className = 'conversation-more';
  more.type = 'button';
  more.title = 'Tùy chọn';
  more.setAttribute('aria-label', 'Tùy chọn hội thoại');
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  const moreIcon = document.createElement('img');
  moreIcon.src = '/assets/icons/more-horizontal.svg';
  moreIcon.alt = '';
  more.appendChild(moreIcon);
  element.append(avatar, copy, time, more);
  return updateConversationElement(element, conversation);
}

function findConversationElement(conversationId) {
  return getConversationItems().find(item => item.dataset.conversationId === conversationId) || null;
}

function applyRemoteConversation(conversation) {
  remoteConversations.set(conversation.id, conversation);
  const existing = findConversationElement(conversation.id);
  if (existing) return updateConversationElement(existing, conversation);
  const element = buildConversationElement(conversation);
  element.dataset.initialOrder = String(getConversationItems().length);
  conversationList?.insertBefore(element, conversationEmpty);
  return element;
}

function renderRemoteConversations(items) {
  if (!conversationList) return;
  const activeId = getActiveConversation()?.dataset.conversationId || '';
  remoteConversations.clear();
  getConversationItems().forEach(item => item.remove());
  items.forEach((conversation, index) => {
    remoteConversations.set(conversation.id, conversation);
    const element = buildConversationElement(conversation);
    element.dataset.initialOrder = String(index);
    element.classList.toggle('active', conversation.id === activeId);
    conversationList.insertBefore(element, conversationEmpty);
  });
}

async function loadRemoteConversations(channelId) {
  const state = await readApiResponse(await fetch(`/api/messaging/conversations?channelId=${encodeURIComponent(channelId)}`));
  let items = state.items || [];
  // An empty inbox usually means the Page was connected before this build; pull its history once.
  if (!items.length && !syncedChannelIds.has(channelId)) {
    syncedChannelIds.add(channelId);
    try {
      const synced = await readApiResponse(await fetch('/api/messaging/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId })
      }));
      items = synced.items || [];
    } catch { /* An empty inbox is still a usable inbox. */ }
  }
  renderRemoteConversations(items);
  return items;
}

async function ensureRemoteMessages(conversation, { force = false } = {}) {
  const id = conversation?.dataset.conversationId;
  if (!id || (!force && remoteMessages.has(id))) return;
  if (!remoteMessages.has(id)) remoteMessages.set(id, []);
  try {
    const state = await readApiResponse(await fetch(`/api/messaging/conversations/${encodeURIComponent(id)}/messages`));
    remoteMessages.set(id, state.items || []);
    if (state.conversation) remoteConversations.set(id, state.conversation);
    if (getActiveConversation()?.dataset.conversationId === id) renderConversation(getActiveConversation());
  } catch (error) {
    showComposerStatus(error.message);
  }
}

async function markRemoteConversationRead(conversation) {
  const id = conversation?.dataset.conversationId;
  if (!id) return;
  try {
    const updated = await readApiResponse(await fetch(`/api/messaging/conversations/${encodeURIComponent(id)}/read`, { method: 'POST' }));
    remoteConversations.set(id, updated);
  } catch { /* The thread still reads as opened locally. */ }
}

async function patchRemoteConversationFlags(conversation, changes) {
  const id = conversation?.dataset.conversationId;
  if (!id) return;
  try {
    const updated = await readApiResponse(await fetch(`/api/messaging/conversations/${encodeURIComponent(id)}/flags`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes)
    }));
    remoteConversations.set(id, updated);
  } catch (error) {
    showToast(error.message);
  }
}

function cacheRemoteMessage(conversationId, message) {
  const messages = remoteMessages.get(conversationId);
  if (!messages) return;
  const index = messages.findIndex(item => item.id === message.id || (message.mid && item.mid === message.mid));
  if (index >= 0) messages[index] = { ...messages[index], ...message, dataUrl: message.dataUrl || messages[index].dataUrl };
  else messages.push(message);
  messages.sort((first, second) => (first.createdAt || 0) - (second.createdAt || 0));
}

function handleMessagingEvent(event) {
  if (event.type === 'customer-panel') {
    const active = getActiveConversation();
    if (active?.dataset.conversationId === event.conversationId) loadCustomerPanelFromServer(active);
    return;
  }
  if (event.type === 'sync') {
    if (event.pageId === currentMessageChannelId) renderRemoteConversations(event.conversations || []);
    return;
  }
  const conversation = event.conversation;
  if (!conversation || conversation.channelId !== currentMessageChannelId) return;
  const isActive = getActiveConversation()?.dataset.conversationId === conversation.id;
  if (event.message) cacheRemoteMessage(conversation.id, event.message);
  const element = applyRemoteConversation({ ...conversation, unread: isActive ? false : conversation.unread });
  if (isActive) {
    renderConversation(element);
    if (event.message?.direction === 'incoming') markRemoteConversationRead(element);
  }
  sortConversationsByRecentActivity();
  filterConversations();
}

function connectMessagingStream() {
  if (messagingStream || typeof EventSource === 'undefined') return;
  let droppedConnection = false;
  messagingStream = new EventSource('/api/messaging/stream');
  messagingStream.addEventListener('message', event => {
    try {
      handleMessagingEvent(JSON.parse(event.data));
    } catch { /* Ignore payloads this build does not understand. */ }
  });
  messagingStream.addEventListener('error', () => { droppedConnection = true; });
  messagingStream.addEventListener('open', () => {
    if (!droppedConnection) return;
    droppedConnection = false;
    // Events sent while the stream was down are only recoverable by reloading the inbox.
    loadRemoteConversations(currentMessageChannelId)
      .then(() => {
        const active = getActiveConversation();
        if (active) ensureRemoteMessages(active, { force: true });
      })
      .catch(() => {});
  });
}

async function switchMessageChannel(channelId) {
  currentMessageChannelId = channelId;
  if (usingRemoteConversations) {
    try {
      await loadRemoteConversations(channelId);
    } catch (error) {
      showToast(error.message);
    }
  }
  activateCurrentMessageChannel();
}

async function loadMessageChannels() {
  let connected = [];
  try {
    const state = await readApiResponse(await fetch('/api/channels'));
    connected = (state.items || []).map(item => ({ id: String(item.id), name: item.name, picture: item.picture, platform: item.platform || 'facebook' }));
  } catch { /* Keep the local demo channel available while the server reconnects. */ }
  usingRemoteConversations = connected.length > 0;
  messageChannels = usingRemoteConversations ? connected : [{
    id: 'local-facebook',
    name: 'Nông Sản Giọt Nắng',
    picture: '/assets/giot-nang-logo.webp',
    platform: 'facebook'
  }];
  if (!messageChannels.some(channel => channel.id === currentMessageChannelId)) currentMessageChannelId = messageChannels[0].id;
  if (usingRemoteConversations) {
    try {
      await loadRemoteConversations(currentMessageChannelId);
    } catch (error) {
      showToast(error.message);
    }
    connectMessagingStream();
  } else {
    const labelCycle = ['new', 'consulting', 'customer'];
    getConversationItems().forEach((conversation, index) => {
      if (!conversation.dataset.channelId) conversation.dataset.channelId = currentMessageChannelId;
      if (!conversation.dataset.labels) conversation.dataset.labels = labelCycle[index % labelCycle.length];
    });
  }
  activateCurrentMessageChannel();
}

function filterConversations() {
  sortConversationsByRecentActivity();
  const query = normalizeColumnName(messageSearchInput?.value || '');
  let visibleCount = 0;
  getConversationItems().forEach(conversation => {
    const matchesSearch = !query || normalizeColumnName(conversation.textContent).includes(query);
    const matchesFilter = currentConversationFilter !== 'unread' || conversation.classList.contains('unread');
    const matchesChannel = conversation.dataset.channelId === currentMessageChannelId;
    const labels = (conversation.dataset.labels || '').split(/\s+/).filter(Boolean);
    const matchesLabel = currentMessageLabel === 'all'
      || (currentMessageLabel === 'unread' ? conversation.classList.contains('unread') : labels.includes(currentMessageLabel));
    const matches = matchesSearch && matchesFilter && matchesChannel && matchesLabel;
    conversation.classList.toggle('hidden', !matches);
    if (matches) visibleCount += 1;
  });
  conversationEmpty?.classList.toggle('hidden', visibleCount > 0);
}

function getConversationName(conversation) {
  return conversation?.querySelector('strong')?.textContent.trim() || '';
}

function getConversationStorageKey(name, conversation = getActiveConversation()) {
  if (conversation?.dataset.conversationId) return conversation.dataset.conversationId;
  const channelId = conversation?.dataset.channelId || currentMessageChannelId;
  return `${channelId}::${name}`;
}

function getConversationItems() {
  return [...document.querySelectorAll('.conversation-list .conversation')];
}

function applyAvatarPhoto(avatar, source) {
  if (!avatar) return;
  let photo = avatar.querySelector('.avatar-photo');
  if (!source) {
    photo?.remove();
    avatar.classList.remove('has-photo');
    return;
  }
  if (!photo) {
    photo = document.createElement('img');
    photo.className = 'avatar-photo';
    photo.alt = '';
    avatar.prepend(photo);
  }
  if (photo.getAttribute('src') !== source) photo.setAttribute('src', source);
  avatar.classList.add('has-photo');
}

function renderConversationSourceBadge(conversation) {
  const avatar = conversation?.querySelector('.avatar');
  if (!avatar) return;
  const source = conversation.dataset.source === 'comment' ? 'comment' : 'inbox';
  let badge = avatar.querySelector('.conversation-source-badge');
  if (!badge) {
    badge = document.createElement('img');
    badge.className = 'conversation-source-badge';
    badge.alt = '';
    avatar.appendChild(badge);
  }
  badge.src = source === 'comment' ? '/assets/icons/facebook.png' : '/assets/icons/messenger.png';
  badge.title = source === 'comment' ? 'Bình luận Facebook' : 'Inbox Messenger';
}

function ensureConversationMetadata(conversation) {
  if (!conversation?.dataset.initialPreview) {
    conversation.dataset.initialPreview = conversation?.querySelector('small')?.textContent.trim() || '';
  }
  if (!conversation?.dataset.initialTime) {
    conversation.dataset.initialTime = conversation?.querySelector('time')?.textContent.trim() || '';
  }
  if (!conversation?.dataset.initialOrder) {
    conversation.dataset.initialOrder = String(getConversationItems().indexOf(conversation));
  }
  renderConversationSourceBadge(conversation);
  return conversation;
}

function sortConversationsByRecentActivity() {
  if (!conversationList) return;
  const conversations = getConversationItems();
  const ordered = [...conversations].sort((first, second) => {
    const firstTimestamp = getChatTimestamp(first.dataset.latestSentAt);
    const secondTimestamp = getChatTimestamp(second.dataset.latestSentAt);
    if (firstTimestamp !== secondTimestamp) return secondTimestamp - firstTimestamp;
    return Number(first.dataset.initialOrder || 0) - Number(second.dataset.initialOrder || 0);
  });
  if (ordered.every((conversation, index) => conversation === conversations[index])) return;
  ordered.forEach(conversation => conversationList.insertBefore(conversation, conversationEmpty));
}

function restoreConversationActivity() {
  getConversationItems().forEach(conversation => {
    const latestMessage = getSavedChatMessages(getConversationName(conversation), conversation).at(-1);
    const latestTimestamp = getChatTimestamp(latestMessage?.createdAt);
    if (!latestTimestamp) return;
    conversation.dataset.latestSentAt = String(latestTimestamp);
    const preview = conversation.querySelector('small');
    const time = conversation.querySelector('time');
    if (preview) preview.textContent = `Bạn: ${getMessagePreview(latestMessage)}`;
    if (time) time.textContent = formatConversationActivityTime(latestTimestamp);
  });
  sortConversationsByRecentActivity();
}

function getUnreadConversations() {
  return readStoredJson(unreadConversationsKey, [], names => new Set(Array.isArray(names) ? names.filter(name => typeof name === 'string') : []));
}

function saveUnreadConversations() {
  const keys = getConversationItems().filter(item => item.classList.contains('unread')).map(item => getConversationStorageKey(getConversationName(item), item));
  writeStoredJson(unreadConversationsKey, new Set(keys), set => [...set]);
}

function getMutedConversations() {
  return readStoredJson(mutedConversationsKey, [], keys => new Set(Array.isArray(keys) ? keys.filter(key => typeof key === 'string') : []));
}

function saveMutedConversations() {
  const keys = getConversationItems().filter(item => item.classList.contains('muted')).map(item => getConversationStorageKey(getConversationName(item), item));
  writeStoredJson(mutedConversationsKey, new Set(keys), set => [...set]);
}

function renderConversationMuteIcon(conversation) {
  let icon = conversation?.querySelector('.conversation-muted-icon');
  if (!conversation?.classList.contains('muted')) {
    icon?.remove();
    return;
  }
  if (icon) return;
  icon = document.createElement('img');
  icon.className = 'conversation-muted-icon';
  icon.src = '/assets/icons/alert-off.svg';
  icon.alt = 'Đã tắt thông báo';
  icon.title = 'Đã tắt thông báo';
  conversation.querySelector('time')?.before(icon);
}

function renderMutedConversations() {
  const mutedKeys = getMutedConversations();
  getConversationItems().forEach(item => {
    const name = getConversationName(item);
    item.classList.toggle('muted', mutedKeys.has(getConversationStorageKey(name, item)) || mutedKeys.has(name));
    renderConversationMuteIcon(item);
  });
}

function updateMarkUnreadButton() {
  const isUnread = document.querySelector('.conversation.active')?.classList.contains('unread') || false;
  if (!markUnreadButton) return;
  markUnreadButton.classList.toggle('active', isUnread);
  markUnreadButton.setAttribute('aria-pressed', String(isUnread));
  markUnreadButton.title = isUnread ? 'Đã đánh dấu chưa đọc' : 'Đánh dấu là chưa đọc';
}

function renderUnreadConversations() {
  const unreadNames = getUnreadConversations();
  getConversationItems().forEach(item => {
    const name = getConversationName(item);
    item.classList.toggle('unread', unreadNames.has(getConversationStorageKey(name, item)) || unreadNames.has(name));
  });
  updateMarkUnreadButton();
}

function getActiveConversation() {
  return document.querySelector('.conversation.active');
}

/** True for threads backed by a real Facebook Page rather than the demo data. */
function isFacebookConversation(conversation = getActiveConversation()) {
  return Boolean(conversation?.dataset.conversationId);
}

const storedJsonCache = new Map();

function readStoredJson(key, fallback, normalize = value => value) {
  if (storedJsonCache.has(key)) return storedJsonCache.get(key);
  let value;
  try {
    const raw = localStorage.getItem(key);
    value = normalize(raw === null ? fallback : JSON.parse(raw));
  } catch {
    localStorage.removeItem(key);
    value = normalize(fallback);
  }
  storedJsonCache.set(key, value);
  return value;
}

function writeStoredJson(key, value, serialize = item => item) {
  storedJsonCache.set(key, value);
  localStorage.setItem(key, JSON.stringify(serialize(value)));
}

function getSavedChatMessageMap() {
  const normalizeMessages = messages => Array.isArray(messages) ? messages.map((message, index) => {
    if (typeof message === 'string') return { id: `legacy-${index}`, text: message };
    if (!message || typeof message !== 'object') return null;
    const type = ['image', 'video', 'audio', 'sticker', 'document', 'system'].includes(message.type) ? message.type : 'text';
    const normalized = {
      id: String(message.id || `saved-${index}`),
      type,
      text: typeof message.text === 'string' ? message.text : ''
    };
    const numericCreatedAt = Number(message.createdAt);
    const createdAt = Number.isFinite(numericCreatedAt) && message.createdAt !== '' && message.createdAt != null
      ? numericCreatedAt
      : Date.parse(message.createdAt || '');
    if (Number.isFinite(createdAt)) normalized.createdAt = createdAt;
    if (type === 'image' || type === 'video' || type === 'audio' || type === 'document') {
      if (typeof message.dataUrl !== 'string' || !message.dataUrl.startsWith('data:')) return null;
      normalized.dataUrl = message.dataUrl;
      normalized.name = typeof message.name === 'string' ? message.name : '';
    }
    if (type === 'audio') normalized.duration = Number(message.duration) || 0;
    if (type === 'document') normalized.size = Number(message.size) || 0;
    if (type === 'sticker') normalized.sticker = typeof message.sticker === 'string' ? message.sticker : '👍';
    if (message.replyTo && typeof message.replyTo === 'object') {
      normalized.replyTo = {
        id: String(message.replyTo.id || ''),
        name: String(message.replyTo.name || 'tin nhắn'),
        text: String(message.replyTo.text || 'tin nhắn')
      };
    }
    return normalized;
  }).filter(Boolean) : [];
  return readStoredJson(savedChatMessagesKey, {}, saved => {
    if (Array.isArray(saved)) return { 'Lan Anh': normalizeMessages(saved) };
    if (!saved || typeof saved !== 'object') return {};
    return Object.fromEntries(Object.entries(saved).map(([name, messages]) => [name, normalizeMessages(messages)]));
  });
}

function getSavedChatMessages(name = getConversationName(getActiveConversation()), conversation = getActiveConversation()) {
  // Server-backed threads live entirely on the server; never fall back to a demo thread of the same name.
  if (conversation?.dataset.conversationId) return [];
  const saved = getSavedChatMessageMap();
  return saved[getConversationStorageKey(name, conversation)] || saved[name] || [];
}

function saveChatMessage(name, message) {
  const saved = getSavedChatMessageMap();
  const key = getConversationStorageKey(name);
  saved[key] = [...(saved[key] || saved[name] || []), message].slice(-100);
  try {
    writeStoredJson(savedChatMessagesKey, saved);
    return true;
  } catch {
    showComposerStatus('Nội dung đã gửi trong phiên này nhưng tệp quá lớn để lưu lâu dài trên trình duyệt.');
    return false;
  }
}

function getChatMessageActions() {
  return readStoredJson(chatMessageActionsKey, {}, actions => actions && typeof actions === 'object' && !Array.isArray(actions) ? actions : {});
}

function getChatMessageAction(name, messageId) {
  const actions = getChatMessageActions();
  return actions[`${getConversationStorageKey(name)}:${messageId}`] || actions[`${name}:${messageId}`] || '';
}

function saveChatMessageAction(name, messageId, action) {
  const actions = getChatMessageActions();
  actions[`${getConversationStorageKey(name)}:${messageId}`] = action;
  writeStoredJson(chatMessageActionsKey, actions);
}

function getMessageStateKey(name, messageId) {
  return `${getConversationStorageKey(name)}:${messageId}`;
}

function getPinnedChatMessages() {
  return readStoredJson(chatPinnedMessagesKey, [], items => new Set(Array.isArray(items) ? items : []));
}

function togglePinnedChatMessage(name, messageId) {
  const items = getPinnedChatMessages();
  const key = getMessageStateKey(name, messageId);
  if (items.has(key)) items.delete(key);
  else items.add(key);
  writeStoredJson(chatPinnedMessagesKey, items, set => [...set]);
  return items.has(key);
}

function getChatMessageReactions() {
  return readStoredJson(chatMessageReactionsKey, {}, items => items && typeof items === 'object' && !Array.isArray(items) ? items : {});
}

function saveChatMessageReaction(name, messageId, reaction) {
  const items = getChatMessageReactions();
  const key = getMessageStateKey(name, messageId);
  if (reaction) items[key] = reaction;
  else delete items[key];
  writeStoredJson(chatMessageReactionsKey, items);
}

// A marker only counts when it does not sit against a letter or digit, which
// is why Messenger renders *0385805700* in bold but leaves *298.000*đ alone.
const inlineMessageFormats = [
  { tag: 'strong', pattern: /(?<![\p{L}\p{N}*])\*(\S|\S[^*\n]*?\S)\*(?![\p{L}\p{N}*])/u },
  { tag: 'em', pattern: /(?<![\p{L}\p{N}_])_(\S|\S[^_\n]*?\S)_(?![\p{L}\p{N}_])/u },
  { tag: 's', pattern: /(?<![\p{L}\p{N}~])~(\S|\S[^~\n]*?\S)~(?![\p{L}\p{N}~])/u },
  { tag: 'code', pattern: /(?<![\p{L}\p{N}`])`(\S|\S[^`\n]*?\S)`(?![\p{L}\p{N}`])/u }
];

/**
 * Renders the inline formatting Messenger applies: *bold*, _italic_, ~strike~
 * and `code`. Builds real nodes rather than HTML, so text written by a customer
 * can never reach the page as markup.
 */
function appendMessageText(target, value) {
  let rest = String(value ?? '');
  while (rest) {
    const hit = inlineMessageFormats
      .map(format => ({ format, match: rest.match(format.pattern) }))
      .filter(item => item.match)
      .sort((first, second) => first.match.index - second.match.index)[0];
    if (!hit) break;
    if (hit.match.index > 0) target.appendChild(document.createTextNode(rest.slice(0, hit.match.index)));
    const element = document.createElement(hit.format.tag);
    appendMessageText(element, hit.match[1]);
    target.appendChild(element);
    rest = rest.slice(hit.match.index + hit.match[0].length);
  }
  if (rest) target.appendChild(document.createTextNode(rest));
}

function getMessagePreview(message) {
  const item = typeof message === 'string' ? { type: 'text', text: message } : message;
  if (item?.type === 'order-receipt') return 'Đã gửi xác nhận đơn hàng';
  if (item?.type === 'image') return item.text ? `Ảnh · ${item.text}` : 'Đã gửi một ảnh';
  if (item?.type === 'video') return item.text ? `Video · ${item.text}` : 'Đã gửi một video';
  if (item?.type === 'document') return item.name ? `Tài liệu · ${item.name}` : 'Đã gửi một tài liệu';
  if (item?.type === 'audio') return 'Đã gửi một tin nhắn thoại';
  if (item?.type === 'sticker') return `Nhãn dán ${item.sticker || ''}`.trim();
  return item?.text || '';
}

function getChatTimestamp(value) {
  const numericTimestamp = Number(value);
  const timestamp = Number.isFinite(numericTimestamp) && value !== '' && value != null ? numericTimestamp : Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isSameCalendarDay(first, second) {
  return first.getFullYear() === second.getFullYear()
    && first.getMonth() === second.getMonth()
    && first.getDate() === second.getDate();
}

function formatChatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const time = date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  if (isSameCalendarDay(date, now)) return time;
  const dayDistance = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
  if (dayDistance > 0 && dayDistance < 7) return `${time} ${['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][date.getDay()]}`;
  const calendarDate = date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  return `${time} ${calendarDate}`;
}

function formatMessageHoverTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const weekday = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'][date.getDay()];
  const time = `${date.getHours() % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')}`;
  const period = date.getHours() < 12 ? 'SA' : 'CH';
  const label = `${weekday} ${time} ${period}`;
  return isSameCalendarDay(date, now) ? label : `${label} · ${date.toLocaleDateString('vi-VN')}`;
}

function hideMessageTimeTooltip() {
  window.cancelAnimationFrame(messageTimeTooltipFrame);
  messageTimeTooltipFrame = 0;
  messageTimeTooltip?.remove();
  messageTimeTooltip = null;
  messageTimeTooltipRow = null;
}

function positionMessageTimeTooltip() {
  if (!messageTimeTooltip?.isConnected || !messageTimeTooltipRow?.isConnected) return;
  const anchorRect = (messageTimeTooltipRow.querySelector('.bubble') || messageTimeTooltipRow).getBoundingClientRect();
  const tooltipRect = messageTimeTooltip.getBoundingClientRect();
  const margin = 9;
  const gap = 10.125;
  // The quick actions sit on the side of the bubble the reply comes from, so
  // put the tooltip on the opposite side or it covers the buttons it explains.
  const quickActions = messageTimeTooltipRow.querySelector('.message-quick-actions');
  const actionsWidth = quickActions ? quickActions.getBoundingClientRect().width + gap : 0;
  const preferredLeft = messageTimeTooltipRow.classList.contains('outgoing')
    ? anchorRect.left - actionsWidth - gap - tooltipRect.width
    : anchorRect.right + actionsWidth + gap;
  const maximumLeft = window.innerWidth - tooltipRect.width - margin;
  messageTimeTooltip.style.left = `${Math.max(margin, Math.min(maximumLeft, preferredLeft))}px`;
  messageTimeTooltip.style.top = `${Math.max(margin, Math.min(window.innerHeight - tooltipRect.height - margin, anchorRect.top + (anchorRect.height - tooltipRect.height) / 2))}px`;
  messageTimeTooltipFrame = window.requestAnimationFrame(positionMessageTimeTooltip);
}

function showMessageTimeTooltip(row) {
  const label = row?.dataset.hoverTime;
  if (!label) return;
  hideMessageTimeTooltip();
  const tooltip = document.createElement('div');
  tooltip.className = 'message-time-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = label;
  document.body.appendChild(tooltip);
  messageTimeTooltip = tooltip;
  messageTimeTooltipRow = row;
  positionMessageTimeTooltip();
}

function hasChatTimeBreak(previousTimestamp, currentTimestamp) {
  if (!previousTimestamp || !currentTimestamp) return false;
  const previous = new Date(previousTimestamp);
  const current = new Date(currentTimestamp);
  return currentTimestamp - previousTimestamp >= chatTimeBreakMs || !isSameCalendarDay(previous, current);
}

function appendChatTimeSeparator(timestamp) {
  if (!chatBody) return;
  const separator = document.createElement('time');
  separator.className = 'chat-time-separator';
  separator.dateTime = new Date(timestamp).toISOString();
  separator.textContent = formatChatTime(timestamp);
  chatBody.appendChild(separator);
}

function formatChatDateLabel(timestamp) {
  if (!timestamp) return 'Hôm nay';
  const date = new Date(timestamp);
  const now = new Date();
  if (isSameCalendarDay(date, now)) return 'Hôm nay';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) return 'Hôm qua';
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatConversationActivityTime(timestamp) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60000) return 'Bây giờ';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} phút`;
  const date = new Date(timestamp);
  const now = new Date();
  if (isSameCalendarDay(date, now)) return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) return 'Hôm qua';
  return date.toLocaleDateString('vi-VN', { weekday: 'short' }).replace('Th ', 'T');
}

function updateConversationTimeLabels() {
  getConversationItems().forEach(conversation => {
    const timestamp = getChatTimestamp(conversation.dataset.latestSentAt);
    const time = conversation.querySelector('time');
    if (timestamp && time) time.textContent = formatConversationActivityTime(timestamp);
  });
}

function appendChatSystemNotice(item) {
  if (!chatBody) return;
  const notice = document.createElement('div');
  notice.className = 'chat-system-notice';
  const icon = document.createElement('img');
  icon.src = '/assets/icons/pin-color.svg';
  icon.alt = '';
  const text = document.createElement('span');
  text.textContent = item.text || '';
  notice.append(icon, text);
  chatBody.appendChild(notice);
}

function appendChatMessage(message, direction = 'outgoing', initial = '', messageId = '', action = '') {
  if (action === 'deleted') return;
  const item = typeof message === 'string' ? { type: 'text', text: message } : { type: 'text', text: '', ...message };
  if (item.type === 'system') {
    appendChatSystemNotice(item);
    return;
  }
  // The receipt sent to the customer is already drawn as an order card by
  // renderConversationOrderCards, so its message record must not also appear
  // as a text bubble repeating the same order.
  if (item.type === 'order-receipt') return;
  const sentAt = getChatTimestamp(item.createdAt);
  let previousRow = chatBody?.lastElementChild || null;
  while (previousRow && !previousRow.classList.contains('message-row')) previousRow = previousRow.previousElementSibling;
  const previousSentAt = getChatTimestamp(previousRow?.dataset.sentAt);
  if (previousRow && hasChatTimeBreak(previousSentAt, sentAt)) appendChatTimeSeparator(sentAt);
  const row = document.createElement('div');
  row.className = `message-row ${direction === 'outgoing' ? 'outgoing' : 'incoming'}`;
  row.dataset.preview = getMessagePreview(item);
  // Keep the original message separately from the rendered bubble. Rendering
  // turns Messenger markers such as *bold* into elements, so reading the DOM
  // back would lose those markers when the message is copied and pasted.
  row.dataset.copyText = item.type === 'sticker' ? (item.sticker || '👍') : String(item.text ?? '');
  row.dataset.searchText = [row.dataset.preview, item.name || ''].filter(Boolean).join(' ');
  if (sentAt) {
    row.dataset.sentAt = String(sentAt);
    row.dataset.hoverTime = formatMessageHoverTime(sentAt);
  }
  if (direction !== 'outgoing') {
    const avatar = document.createElement('span');
    avatar.className = 'avatar avatar-small';
    avatar.textContent = initial;
    applyAvatarPhoto(avatar, getActiveConversation()?.dataset.avatar || '');
    row.appendChild(avatar);
  }
  const bubble = document.createElement('div');
  const isMedia = ['image', 'video', 'audio'].includes(item.type);
  const isDocument = item.type === 'document';
  const isImage = item.type === 'image';
  const isVideo = item.type === 'video';
  const isSticker = item.type === 'sticker';
  bubble.className = `bubble${isDocument ? ' bubble-document' : ''}${isMedia ? ' bubble-media' : ''}${isImage ? ' bubble-image' : ''}${isVideo ? ' bubble-video' : ''}${isSticker ? ' bubble-sticker' : ''}${action === 'recalled' ? ' bubble-recalled' : ''}`;
  if (item.status === 'sending') bubble.classList.add('bubble-sending');
  if (item.status === 'failed') {
    bubble.classList.add('bubble-failed');
    bubble.title = 'Không gửi được tin nhắn này tới Facebook.';
  }
  if (action === 'recalled') {
    bubble.textContent = 'Bạn đã thu hồi một tin nhắn';
  } else if (item.type === 'image') {
    const image = document.createElement('img');
    image.className = 'chat-image';
    image.src = item.dataUrl;
    image.alt = item.name ? `Ảnh đính kèm: ${item.name}` : 'Ảnh đính kèm';
    bubble.appendChild(image);
    if (item.text) {
      const caption = document.createElement('span');
      caption.className = 'bubble-caption';
      appendMessageText(caption, item.text);
      bubble.appendChild(caption);
    }
  } else if (item.type === 'audio') {
    const audio = document.createElement('audio');
    audio.className = 'chat-audio';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = item.dataUrl;
    bubble.appendChild(audio);
  } else if (item.type === 'video') {
    const video = document.createElement('video');
    video.className = 'chat-video';
    video.controls = true;
    video.preload = 'metadata';
    video.src = item.dataUrl;
    bubble.appendChild(video);
  } else if (item.type === 'document') {
    bubble.appendChild(buildDocumentCard(item));
    if (item.text) {
      const caption = document.createElement('span');
      caption.className = 'bubble-caption';
      appendMessageText(caption, item.text);
      bubble.appendChild(caption);
    }
  } else if (item.type === 'sticker') {
    bubble.textContent = item.sticker || '👍';
  } else {
    appendMessageText(bubble, item.text);
  }
  if (messageId) {
    row.dataset.messageId = messageId;
    bubble.tabIndex = 0;
    bubble.setAttribute('role', 'button');
    bubble.setAttribute('aria-haspopup', 'menu');
    const ownerLabel = direction === 'outgoing' ? 'Tin nhắn đã gửi' : 'Tin nhắn của khách';
    bubble.setAttribute('aria-label', action === 'recalled' ? 'Tin nhắn đã thu hồi' : `${ownerLabel}: ${getMessagePreview(item)}. Nhấp để mở tùy chọn.`);
  }
  let quickActions = null;
  if (messageId) {
    quickActions = document.createElement('div');
    quickActions.className = 'message-quick-actions';
    quickActions.setAttribute('aria-label', 'Thao tác nhanh');
    const quickActionButtons = [
      ['more', '⋮', 'Thêm thao tác'],
      ['reply', '↩', 'Trả lời'],
      ['react', '☺', 'Bày tỏ cảm xúc']
    ];
    (direction === 'outgoing' ? [...quickActionButtons].reverse() : quickActionButtons).forEach(([quickAction, symbol, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.messageQuick = quickAction;
      button.textContent = symbol;
      button.title = label;
      button.setAttribute('aria-label', label);
      quickActions.appendChild(button);
    });
    if (direction === 'outgoing') row.appendChild(quickActions);
  }
  let messageContent = bubble;
  if (item.replyTo) {
    const stack = document.createElement('div');
    stack.className = 'message-content-stack';
    const attribution = document.createElement('span');
    attribution.className = 'message-reply-attribution';
    attribution.textContent = item.replyTo.name === 'Bạn'
      ? '↩ Bạn đã trả lời chính mình'
      : `↩ Bạn đã trả lời ${item.replyTo.name}`;
    const source = document.createElement('span');
    source.className = 'message-reply-source';
    source.textContent = item.replyTo.text || 'tin nhắn';
    source.title = item.replyTo.text || 'tin nhắn';
    stack.append(attribution, source, bubble);
    messageContent = stack;
  }
  row.appendChild(messageContent);
  if (direction !== 'outgoing' && quickActions) row.appendChild(quickActions);
  if (messageId) {
    const name = getConversationName(getActiveConversation());
    const stateKey = getMessageStateKey(name, messageId);
    if (getPinnedChatMessages().has(stateKey)) {
      row.classList.add('message-pinned');
      const pin = document.createElement('span');
      pin.className = 'message-pin-badge';
      pin.textContent = 'Đã ghim';
      bubble.appendChild(pin);
    }
    const reaction = getChatMessageReactions()[stateKey];
    if (reaction) {
      const badge = document.createElement('span');
      badge.className = 'message-reaction';
      badge.textContent = reaction;
      badge.title = 'Cảm xúc ghi trong CRM. Khách không nhìn thấy trên Messenger.';
      bubble.appendChild(badge);
    }
  }
  chatBody?.appendChild(row);
}

const videoLightbox = document.querySelector('#video-lightbox');
const videoLightboxContent = document.querySelector('#video-lightbox-content');

function openVideoLightbox(video) {
  if (!videoLightbox || !videoLightboxContent || !video?.src) return;
  // Carry the playback position across so the clip does not restart.
  const resumeAt = video.currentTime;
  video.pause();
  videoLightboxContent.src = video.src;
  videoLightboxContent.currentTime = resumeAt;
  videoLightbox.classList.remove('hidden');
  document.body.classList.add('video-lightbox-open');
  videoLightboxContent.play().catch(() => { /* Autoplay may be blocked; controls still work. */ });
  videoLightbox.querySelector('.video-lightbox-close')?.focus();
}

function closeVideoLightbox() {
  if (!videoLightbox || videoLightbox.classList.contains('hidden')) return;
  videoLightbox.classList.add('hidden');
  document.body.classList.remove('video-lightbox-open');
  videoLightboxContent.pause();
  videoLightboxContent.removeAttribute('src');
  videoLightboxContent.load();
}

function getLightboxFileName(image) {
  return (image?.alt || 'anh-dinh-kem').replace(/^Ảnh đính kèm:\s*/i, '') || 'anh-dinh-kem.png';
}

function setLightboxZoom(value) {
  lightboxZoom = Math.min(4, Math.max(.5, Math.round(value * 10) / 10));
  if (imageLightboxContent) imageLightboxContent.style.transform = `scale(${lightboxZoom})`;
  if (imageLightboxZoom) imageLightboxZoom.value = `${Math.round(lightboxZoom * 100)}%`;
  imageLightbox?.classList.toggle('is-zoomed', lightboxZoom > 1);
}

function renderLightboxImage(index) {
  if (!lightboxImages.length || !imageLightboxContent) return;
  lightboxIndex = (index + lightboxImages.length) % lightboxImages.length;
  const image = lightboxImages[lightboxIndex];
  imageLightboxContent.src = image.src;
  imageLightboxContent.alt = image.alt || 'Ảnh xem kích thước lớn';
  setLightboxZoom(1);
  if (imageLightboxDownload) {
    imageLightboxDownload.href = image.src;
    imageLightboxDownload.download = getLightboxFileName(image);
  }
  imageLightboxPrev?.toggleAttribute('disabled', lightboxImages.length < 2);
  imageLightboxNext?.toggleAttribute('disabled', lightboxImages.length < 2);
  [...(imageLightboxThumbnails?.children || [])].forEach((thumbnail, thumbnailIndex) => {
    thumbnail.classList.toggle('is-active', thumbnailIndex === lightboxIndex);
    thumbnail.setAttribute('aria-current', thumbnailIndex === lightboxIndex ? 'true' : 'false');
  });
}

function renderLightboxThumbnails() {
  if (!imageLightboxThumbnails) return;
  imageLightboxThumbnails.replaceChildren();
  lightboxImages.forEach((image, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'image-lightbox-thumbnail';
    button.setAttribute('aria-label', `Xem ${getLightboxFileName(image)}`);
    const preview = document.createElement('img');
    preview.src = image.src;
    preview.alt = '';
    button.appendChild(preview);
    button.addEventListener('click', () => renderLightboxImage(index));
    imageLightboxThumbnails.appendChild(button);
  });
}

function openImageLightbox(image) {
  if (!imageLightbox || !imageLightboxContent || !image?.src) return;
  lightboxImages = [...(chatBody?.querySelectorAll('.chat-image') || [])];
  lightboxIndex = Math.max(0, lightboxImages.indexOf(image));
  renderLightboxThumbnails();
  renderLightboxImage(lightboxIndex);
  imageLightbox.classList.remove('hidden');
  document.body.classList.add('image-lightbox-open');
  imageLightbox.querySelector('.image-lightbox-close')?.focus();
}

function closeImageLightbox() {
  if (!imageLightbox || imageLightbox.classList.contains('hidden')) return;
  imageLightbox.classList.add('hidden');
  document.body.classList.remove('image-lightbox-open');
  if (imageLightboxContent) {
    imageLightboxContent.src = '';
    imageLightboxContent.alt = '';
  }
  lightboxImages = [];
  setLightboxZoom(1);
  imageLightboxThumbnails?.replaceChildren();
}

async function shareLightboxImage() {
  const image = lightboxImages[lightboxIndex];
  if (!image?.src) return;
  try {
    const response = await fetch(image.src);
    const blob = await response.blob();
    const file = new File([blob], getLightboxFileName(image), { type: blob.type || 'image/png' });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({ files: [file], title: 'Chia sẻ ảnh' });
      return;
    }
    window.open(image.src, '_blank', 'noopener,noreferrer');
  } catch {
    showComposerStatus('Không thể chia sẻ ảnh lúc này.');
  }
}

function updateMessageGrouping() {
  const rows = [...(chatBody?.querySelectorAll(':scope > .message-row') || [])];
  rows.forEach((row, index) => {
    row.classList.remove('message-group-single', 'message-group-first', 'message-group-middle', 'message-group-last', 'message-group-continued');
    const direction = row.classList.contains('outgoing') ? 'outgoing' : 'incoming';
    const previous = rows[index - 1];
    const next = rows[index + 1];
    const matches = candidate => candidate
      && (candidate.classList.contains('outgoing') ? 'outgoing' : 'incoming') === direction
      && !hasChatTimeBreak(getChatTimestamp(candidate.dataset.sentAt), getChatTimestamp(row.dataset.sentAt));
    const samePrevious = matches(previous);
    const sameNext = matches(next);
    if (!samePrevious && !sameNext) row.classList.add('message-group-single');
    else if (!samePrevious) row.classList.add('message-group-first');
    else if (!sameNext) row.classList.add('message-group-last', 'message-group-continued');
    else row.classList.add('message-group-middle', 'message-group-continued');
  });
}

function getConversationMessages(conversation) {
  const remoteId = conversation?.dataset.conversationId;
  if (remoteId) return remoteMessages.get(remoteId) || [];
  const name = getConversationName(conversation);
  if (conversationProfiles[name]?.messages) return conversationProfiles[name].messages;
  const preview = conversation?.dataset.initialPreview || '';
  if (!preview) return [];
  const isOutgoing = preview.startsWith('Bạn:');
  const text = preview.replace(/^Bạn:\s*/, '');
  return isOutgoing
    ? [{ direction: 'incoming', text: 'Chào shop, mình cần được hỗ trợ với ạ.' }, { direction: 'outgoing', text }]
    : [{ direction: 'incoming', text }];
}

function getCustomerPanelKey(conversation = getActiveConversation()) {
  if (!conversation) return '';
  return conversation.dataset.conversationId || `name:${getConversationName(conversation)}`;
}

function saveCustomerPanelStore() {
  localStorage.setItem('crm-customer-panel-v1', JSON.stringify(customerPanelStore));
}

const chatbotProviderProfiles = {
  vertex: {
    endpoint: 'https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/publishers/google/models/gemini-3-flash-preview:generateContent',
    model: 'gemini-3-flash-preview',
    models: [
      { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
      { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
      { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
      { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)' },
      { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)' },
      { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (Preview)' },
      { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' }
    ],
    endpointLabel: 'Endpoint Vertex AI', keyLabel: 'Access token Vertex AI', keyPlaceholder: 'Được cấu hình bảo mật trên máy chủ'
  },
  deepseek: {
    endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash', models: [
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { value: 'deepseek-v4-flash-vision-exp', label: 'DeepSeek V4 Flash Vision (Experimental)' }
    ], endpointLabel: 'Endpoint DeepSeek', keyLabel: 'Khóa API DeepSeek', keyPlaceholder: 'Nhập khóa API DeepSeek'
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4.1-mini', models: [
      { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { value: 'gpt-5', label: 'GPT-5' },
      { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
      { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
      { value: 'gpt-4.1', label: 'GPT-4.1' },
      { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
      { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' }
    ], endpointLabel: 'Endpoint OpenAI', keyLabel: 'Khóa API OpenAI', keyPlaceholder: 'Nhập khóa API OpenAI'
  },
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-6', models: [
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { value: 'claude-opus-5', label: 'Claude Opus 5' },
      { value: 'claude-fable-5', label: 'Claude Fable 5' },
      { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }
    ], endpointLabel: 'Endpoint Anthropic', keyLabel: 'Khóa API Anthropic', keyPlaceholder: 'Nhập khóa API Anthropic'
  },
  xai: {
    endpoint: 'https://api.x.ai/v1/chat/completions', model: 'grok-4.5', models: [
      { value: 'grok-4.5', label: 'Grok 4.5' },
      { value: 'grok-4.5-latest', label: 'Grok 4.5 Latest' }
    ], endpointLabel: 'Endpoint xAI', keyLabel: 'Khóa API xAI', keyPlaceholder: 'Nhập khóa API xAI'
  },
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b', models: [
      { value: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
      { value: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
      { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' },
      { value: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
      { value: 'groq/compound', label: 'Groq Compound' },
      { value: 'groq/compound-mini', label: 'Groq Compound Mini' }
    ], endpointLabel: 'Endpoint Groq', keyLabel: 'Khóa API Groq', keyPlaceholder: 'Nhập khóa API Groq'
  },
  mistral: {
    endpoint: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-large-latest', models: [
      { value: 'mistral-large-latest', label: 'Mistral Large (Latest)' },
      { value: 'mistral-medium-latest', label: 'Mistral Medium (Latest)' },
      { value: 'mistral-small-latest', label: 'Mistral Small (Latest)' }
    ], endpointLabel: 'Endpoint Mistral AI', keyLabel: 'Khóa API Mistral AI', keyPlaceholder: 'Nhập khóa API Mistral AI'
  },
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: '~openai/gpt-latest', models: [
      { value: '~openai/gpt-latest', label: 'OpenAI GPT Latest' },
      { value: '~anthropic/claude-sonnet-latest', label: 'Claude Sonnet Latest' },
      { value: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { value: 'x-ai/grok-4.5', label: 'Grok 4.5' },
      { value: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' }
    ], endpointLabel: 'Endpoint OpenRouter', keyLabel: 'Khóa API OpenRouter', keyPlaceholder: 'Nhập khóa API OpenRouter'
  },
  custom: {
    endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4.1-mini', models: [
      { value: 'gpt-5', label: 'GPT-5' },
      { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
      { value: 'gpt-4.1', label: 'GPT-4.1' },
      { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
      { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' }
    ], endpointLabel: 'Endpoint API tương thích OpenAI', keyLabel: 'Khóa API', keyPlaceholder: 'Nhập khóa API của nhà cung cấp'
  }
};

function getChatbotProviderProfile() {
  if (chatbotSettingsProvider?.value === 'custom' && chatbotSettingsProtocol?.value === 'anthropic') return chatbotProviderProfiles.anthropic;
  return chatbotProviderProfiles[chatbotSettingsProvider?.value] || chatbotProviderProfiles.vertex;
}

function renderChatbotModelOptions(selectedModel = '') {
  if (!chatbotSettingsDirectModel) return;
  const profile = getChatbotProviderProfile();
  const models = [...(profile.models || [])];
  const activeModel = selectedModel || profile.model;
  if (activeModel && !models.some(model => model.value === activeModel)) {
    models.push({ value: activeModel, label: `${activeModel} (đang sử dụng)` });
  }
  chatbotSettingsDirectModel.replaceChildren(...models.map(model => {
    const option = document.createElement('option');
    option.value = model.value;
    option.textContent = model.label;
    return option;
  }));
  chatbotSettingsDirectModel.value = activeModel;
}

function syncVertexEndpointModel() {
  if (chatbotSettingsProvider?.value !== 'vertex' || !chatbotSettingsDirectEndpoint || !chatbotSettingsDirectModel?.value) return;
  const currentEndpoint = chatbotSettingsDirectEndpoint.value || chatbotProviderProfiles.vertex.endpoint;
  chatbotSettingsDirectEndpoint.value = currentEndpoint.replace(/\/models\/[^:]+(?=:generateContent)/, `/models/${chatbotSettingsDirectModel.value}`);
}

function renderChatbotProvider(resetValues = false) {
  queueMicrotask(syncChatbotModelDisplay);
  const profile = getChatbotProviderProfile();
  const currentModel = chatbotSettingsDirectModel?.value || '';
  const vertex = chatbotSettingsProvider?.value === 'vertex';
  const custom = chatbotSettingsProvider?.value === 'custom';
  chatbotAuthTypeField?.classList.toggle('hidden', true);
  chatbotAuthTypeField?.remove();
  chatbotSettingsDirectKey?.closest('label')?.setAttribute('hidden', 'hidden');
  chatbotSettingsDirectKey?.parentElement?.classList.add('hidden');
  chatbotApiKeyLabel?.parentElement?.classList.add('hidden');
  chatbotApiKeyLabel?.parentElement?.remove();
  chatbotProtocolField?.classList.toggle('hidden', !custom);
  if (chatbotEndpointLabel) chatbotEndpointLabel.textContent = profile.endpointLabel;
  if (chatbotApiKeyLabel) chatbotApiKeyLabel.textContent = vertex && chatbotSettingsAuthType?.value === 'api_key' ? 'Google Cloud API key' : profile.keyLabel;
  if (chatbotSettingsDirectEndpoint) chatbotSettingsDirectEndpoint.placeholder = profile.endpoint;
  renderChatbotModelOptions(resetValues ? profile.model : currentModel || profile.model);
  if (chatbotSettingsDirectKey && !chatbotSettingsDirectKey.value) {
    chatbotSettingsDirectKey.placeholder = vertex && chatbotSettingsAuthType?.value === 'api_key' ? 'Nhập Google Cloud API key' : profile.keyPlaceholder;
  }
  if (resetValues) {
    chatbotSettingsDirectEndpoint.value = profile.endpoint;
    if (chatbotSettingsDirectKey) chatbotSettingsDirectKey.value = '';
  }
}

chatbotSettingsProvider?.addEventListener('change', () => renderChatbotProvider(true));
chatbotSettingsAuthType?.addEventListener('change', () => renderChatbotProvider());
chatbotSettingsProtocol?.addEventListener('change', () => renderChatbotProvider(true));
chatbotSettingsDirectModel?.addEventListener('change', syncVertexEndpointModel);

async function loadChatbotSettings() {
  if (!chatbotSettingsForm) return;
  try {
    const settings = await readApiResponse(await fetch('/api/chatbot/settings'));
    chatbotSettingsEnabled.checked = settings.enabled === true;
    chatbotSettingsProvider.value = settings.provider || 'vertex';
    chatbotSettingsAuthType.value = settings.directAuthType === 'api_key' ? 'api_key' : 'access_token';
    chatbotSettingsProtocol.value = settings.directProtocol === 'anthropic' ? 'anthropic' : 'openai';
    renderChatbotProvider();
    const profile = getChatbotProviderProfile();
    const migratedModel = settings.provider === 'vertex' && settings.directModel === 'gemini-2.5-flash' ? 'gemini-3-flash-preview' : (settings.directModel || profile.model);
    chatbotSettingsDirectEndpoint.value = (settings.directEndpoint || profile.endpoint).replace('gemini-2.5-flash', migratedModel);
    renderChatbotModelOptions(migratedModel);
    syncVertexEndpointModel();
    if (chatbotSettingsDirectKey) {
      chatbotSettingsDirectKey.value = '';
      chatbotSettingsDirectKey.placeholder = settings.directApiKeyConfigured ? 'Đã lưu – để trống nếu không thay đổi' : profile.keyPlaceholder;
    }
    chatbotSettingsSystemPrompt.value = settings.systemPrompt || '';
    updateChatbotSystemPromptCounter();
    chatbotSettingsMemoryEnabled.checked = settings.memoryEnabled !== false;
    chatbotSettingsMemoryWindow.value = settings.memoryWindow || 50;
    syncChatbotMemoryWindow('number');
    chatbotSettingsStructuredOutput.checked = settings.structuredOutput !== false;
    chatbotSettingsRetryCount.value = settings.retryCount ?? 1;
    chatbotSettingsRetryInterval.value = settings.retryIntervalMs || 1000;
    chatbotSettingsWelcome.value = settings.welcomeMessage || '';
    chatbotTemplatesState = { ...(settings.templates || {}) };
    chatbotOriginalTemplates = { ...(settings.templates || {}) };
    chatbotDeletedTemplateIds = new Set(settings.deletedTemplateIds || []);
    // Pipeline comes from the server modules now, not from editable settings.
    selectedChatbotTemplate = selectedChatbotTemplate && chatbotTemplatesState[selectedChatbotTemplate] !== undefined
      ? selectedChatbotTemplate
      : Object.keys(chatbotTemplatesState)[0] || '';
    selectedChatbotStep = chatbotProcessingSteps.some(step => step.id === selectedChatbotStep)
      ? selectedChatbotStep
      : chatbotProcessingSteps[0]?.id || '';
    renderChatbotTemplateList();
    renderChatbotTemplateEditor();
    loadChatbotPipeline();
  } catch (error) {
    showToast(error.message || 'Chưa tải được thiết lập chatbot.', 'error');
  }
}

function chatbotTemplateLabel(id) {
  const labels = {
    WELCOME: 'Chào mừng', GENERAL_INFO: 'Thông tin chung', CSKH_HANDOFF: 'Chuyển nhân viên', ORDER_ADDRESS: 'Xin thông tin nhận hàng',
    ORDER_CONFIRMATION: 'Xác nhận đơn hàng', ECOMMERCE_LINKS: 'Link gian hàng', BAG_COMPARISON: 'So sánh các túi', SHIPPING_POLICY: 'Chính sách giao hàng',
    BANK_TRANSFER: 'Thông tin chuyển khoản', THANK_YOU: 'Cảm ơn khách hàng'
  };
  return labels[id] || id.replace(/^PRICE_/, 'Bảng giá · ').replaceAll('_', ' ').toLowerCase().replace(/^./, value => value.toUpperCase());
}

function renderChatbotTemplateList() {
  if (!chatbotTemplateList) return;
  const keyword = (chatbotTemplateSearch?.value || '').trim().toLowerCase();
  const entries = Object.entries(chatbotTemplatesState).filter(([id, content]) => `${id} ${content}`.toLowerCase().includes(keyword));
  chatbotTemplateList.innerHTML = entries.map(([id, content]) => `
    <button class="chatbot-template-item ${id === selectedChatbotTemplate ? 'active' : ''}" type="button" data-chatbot-template-id="${escapeHtml(id)}">
      <strong>${escapeHtml(chatbotTemplateLabel(id))}</strong><small>${escapeHtml(String(content).replaceAll('###', ' · '))}</small>
    </button>`).join('') || '<p class="channel-empty">Không tìm thấy mẫu phù hợp.</p>';
}

function renderChatbotTemplateEditor() {
  const id = selectedChatbotTemplate;
  if (chatbotTemplateId) chatbotTemplateId.textContent = id || 'Chọn một mẫu tin';
  if (chatbotTemplateContent) {
    chatbotTemplateContent.disabled = !id;
    chatbotTemplateContent.value = id ? chatbotTemplatesState[id] || '' : '';
  }
  if (chatbotTemplateActive) {
    chatbotTemplateActive.disabled = !id;
    chatbotTemplateActive.checked = Boolean(id && chatbotTemplatesState[id]);
  }
  if (chatbotTemplateDelete) {
    const canDelete = Boolean(id);
    chatbotTemplateDelete.classList.toggle('hidden', !canDelete);
    chatbotTemplateDelete.disabled = !canDelete;
  }
}

function renderChatbotWorkflow() {
  if (!chatbotWorkflow) return;
  const icons = {
    message_normalizer: '/assets/icons/bot-chat.svg',
    product_extractor: '/assets/icons/data-process.svg',
    customer_extractor: '/assets/icons/person.svg',
    context_merge: '/assets/icons/merge.svg',
    template_renderer: '/assets/icons/bot-chat.svg',
    duplicate_guard: '/assets/icons/safety-check.svg'
  };
  chatbotWorkflow.innerHTML = chatbotProcessingSteps.map(step => `
    <div class="chatbot-workflow-node ${step.id === selectedChatbotStep ? 'active' : ''}" data-type="${escapeHtml(step.type)}" data-chatbot-step-node="${escapeHtml(step.id)}" role="button" tabindex="0">
      <span class="chatbot-workflow-icon"><img src="${icons[step.id] || '/assets/icons/settings.png'}" alt=""></span>
      <span class="chatbot-workflow-copy"><strong>${escapeHtml(step.name)}</strong></span>
    </div>`).join('');
}

function renderChatbotStepEditor() {
  const step = chatbotProcessingSteps.find(item => item.id === selectedChatbotStep);
  if (chatbotStepCodeTitle) chatbotStepCodeTitle.textContent = step ? `${step.name} · ${step.file || ''}` : 'Chọn một bước xử lý';
  if (chatbotStepSummary) chatbotStepSummary.textContent = step?.summary || '';
  if (chatbotStepCode) {
    chatbotStepCode.readOnly = true;
    chatbotStepCode.value = step?.code ?? (step ? 'Đang tải mã nguồn...' : '');
  }
  if (chatbotStepCodeApply) chatbotStepCodeApply.classList.add('hidden');
}

/** Fetches the module source the first time a step is opened. */
async function loadChatbotPipelineStep(id) {
  const step = chatbotProcessingSteps.find(item => item.id === id);
  if (!step || typeof step.code === 'string') return;
  try {
    const detail = await readApiResponse(await fetch(`/api/chatbot/pipeline/${encodeURIComponent(id)}`));
    step.code = String(detail.code || '');
  } catch {
    step.code = 'Không tải được mã nguồn của bước này.';
  }
  if (selectedChatbotStep === id) renderChatbotStepEditor();
}

async function loadChatbotPipeline() {
  if (!chatbotWorkflow) return;
  try {
    const result = await readApiResponse(await fetch('/api/chatbot/pipeline'));
    chatbotProcessingSteps = Array.isArray(result.items) ? result.items : [];
  } catch {
    chatbotProcessingSteps = [];
  }
  renderChatbotWorkflow();
  renderChatbotStepEditor();
}

// ===== Quà tặng (Cài đặt → Quà tặng) =====
// A gift is a name and the total quantity it unlocks at. Gifts stack: an order
// of three gets every gift whose threshold is three or lower. The chatbot reads
// the same list, so ticking a gift here changes the next confirmation it sends.
const giftRowsElement = document.querySelector('#gift-rows');
const giftAddButton = document.querySelector('#gift-add');
const giftSaveButton = document.querySelector('#gift-save');
const giftStatus = document.querySelector('#gift-status');
const giftPreview = document.querySelector('#gift-preview');
let giftItems = [];
let giftsLoaded = false;

function setGiftStatus(message, tone = '') {
  if (!giftStatus) return;
  giftStatus.textContent = message;
  giftStatus.classList.toggle('is-error', tone === 'error');
  giftStatus.classList.toggle('is-ok', tone === 'ok');
}

function renderGiftPreview() {
  if (!giftPreview) return;
  const maximum = Math.max(3, ...giftItems.filter(gift => gift.active !== false).map(gift => Number(gift.minQuantity) || 1));
  const cells = [];
  for (let quantity = 1; quantity <= Math.min(maximum, 6); quantity += 1) {
    const names = giftItems
      .filter(gift => gift.active !== false && String(gift.name || '').trim() && (Number(gift.minQuantity) || 1) <= quantity)
      .sort((a, b) => (Number(a.minQuantity) || 1) - (Number(b.minQuantity) || 1))
      .map(gift => escapeHtml(gift.name.trim()));
    cells.push(`<div class="gift-preview-cell"><strong>${quantity} sản phẩm</strong>${names.length ? `<ul>${names.map(name => `<li>${name}</li>`).join('')}</ul>` : '<em>Không có quà</em>'}</div>`);
  }
  giftPreview.innerHTML = cells.join('');
}

function renderGifts() {
  if (!giftRowsElement) return;
  if (!giftItems.length) {
    giftRowsElement.innerHTML = '<div class="gift-row gift-row-empty"><span>Chưa có quà tặng nào. Bấm “Thêm quà tặng” để bắt đầu.</span></div>';
  } else {
    giftRowsElement.innerHTML = giftItems.map((gift, index) => `<div class="gift-row${gift.active === false ? ' is-off' : ''}">
      <label class="gift-active"><input type="checkbox" data-gift-field="active" data-gift-index="${index}" ${gift.active !== false ? 'checked' : ''} aria-label="Áp dụng quà tặng"></label>
      <input type="text" data-gift-field="name" data-gift-index="${index}" value="${escapeHtml(gift.name || '')}" maxlength="200" placeholder="Ví dụ: Miễn phí vận chuyển">
      <span class="gift-quantity"><span>từ</span><input type="number" data-gift-field="minQuantity" data-gift-index="${index}" value="${Number(gift.minQuantity) || 1}" min="1" max="20" step="1"><span>sản phẩm</span></span>
      <button class="price-master-remove" type="button" data-gift-remove="${index}" aria-label="Xóa quà tặng" title="Xóa quà tặng">×</button>
    </div>`).join('');
  }
  renderGiftPreview();
}

async function loadGifts() {
  if (!giftRowsElement || giftsLoaded) return;
  try {
    const result = await readApiResponse(await fetch('/api/gifts'));
    giftItems = Array.isArray(result.items) ? result.items.map(gift => ({ ...gift })) : [];
    giftsLoaded = true;
    renderGifts();
    setGiftStatus(`${giftItems.length} quà tặng. Chatbot đang dùng danh sách này.`);
  } catch (error) {
    setGiftStatus(error.message || 'Chưa tải được quà tặng.', 'error');
  }
}

giftRowsElement?.addEventListener('input', event => {
  const field = event.target.dataset.giftField;
  const gift = giftItems[Number(event.target.dataset.giftIndex)];
  if (!field || !gift) return;
  if (field === 'name') gift.name = event.target.value;
  else if (field === 'minQuantity') gift.minQuantity = Math.min(20, Math.max(1, Math.round(Number(event.target.value) || 1)));
  renderGiftPreview();
  setGiftStatus('Có thay đổi chưa lưu. Nhớ bấm “Lưu quà tặng”.');
});

giftRowsElement?.addEventListener('change', event => {
  if (event.target.dataset.giftField !== 'active') return;
  const gift = giftItems[Number(event.target.dataset.giftIndex)];
  if (!gift) return;
  gift.active = event.target.checked;
  event.target.closest('.gift-row')?.classList.toggle('is-off', !gift.active);
  renderGiftPreview();
  setGiftStatus('Có thay đổi chưa lưu. Nhớ bấm “Lưu quà tặng”.');
});

giftRowsElement?.addEventListener('click', event => {
  const button = event.target.closest('[data-gift-remove]');
  if (!button) return;
  giftItems.splice(Number(button.dataset.giftRemove), 1);
  renderGifts();
  setGiftStatus('Đã xóa quà tặng. Nhớ bấm “Lưu quà tặng”.');
});

giftAddButton?.addEventListener('click', () => {
  // A new gift defaults to the next threshold up, which is the usual reason to add one.
  const nextQuantity = giftItems.length ? Math.max(...giftItems.map(gift => Number(gift.minQuantity) || 1)) + 1 : 2;
  giftItems.push({ id: '', name: '', minQuantity: Math.min(20, nextQuantity), active: true });
  renderGifts();
  giftRowsElement?.querySelector('.gift-row:last-child input[data-gift-field="name"]')?.focus();
});

giftSaveButton?.addEventListener('click', async () => {
  const blank = giftItems.find(gift => !String(gift.name || '').trim());
  if (blank) {
    setGiftStatus('Có quà tặng chưa đặt tên.', 'error');
    return;
  }
  giftSaveButton.disabled = true;
  try {
    const result = await readApiResponse(await fetch('/api/gifts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: giftItems })
    }));
    giftItems = Array.isArray(result.items) ? result.items.map(gift => ({ ...gift })) : giftItems;
    renderGifts();
    setGiftStatus(`Đã lưu ${giftItems.length} quà tặng. Chatbot áp dụng ngay cho đơn kế tiếp.`, 'ok');
  } catch (error) {
    setGiftStatus(error.message || 'Chưa lưu được quà tặng.', 'error');
  } finally {
    giftSaveButton.disabled = false;
  }
});

function renderProductImagePreview(source = '') {
  if (!productImagePreview) return;
  productImagePreview.innerHTML = source
    ? `<img src="${escapeHtml(source)}" alt="Ảnh sản phẩm">`
    : '<span>Ảnh sản phẩm</span><small>PNG, JPG, WebP · tối đa 5 MB</small>';
  productImageRemove?.classList.toggle('hidden', !source);
}

function syncSharedProductOptions() {
  if (!sharedProductOptions) return;
  sharedProductOptions.innerHTML = sharedProducts.map(product =>
    `<option value="${escapeHtml(product.name)}">${escapeHtml(product.sku)} · ${escapeHtml(formatOrderMoney(product.salePrice))}</option>`
  ).join('');
}

function describeComboPrices(product) {
  const tiers = Object.entries(product.comboPrices || {})
    .map(([quantity, price]) => [Number(quantity), Number(price) || 0])
    .filter(([quantity, price]) => quantity >= 2 && price > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!tiers.length) return '<em>Chưa có · tính giá bán × SL</em>';
  return tiers.map(([quantity, price]) => `<span class="product-combo-tier"><b>${quantity}</b> ${escapeHtml(formatOrderMoney(price))}</span>`).join('');
}

function renderProducts() {
  if (!productList) return;
  const query = String(productSearch?.value || '').trim().toLocaleLowerCase('vi');
  const items = query
    ? sharedProducts.filter(product => `${product.name} ${product.sku}`.toLocaleLowerCase('vi').includes(query))
    : sharedProducts;
  if (productCount) productCount.textContent = query ? `${items.length}/${sharedProducts.length} sản phẩm` : `${sharedProducts.length} sản phẩm`;
  if (!items.length) {
    productList.innerHTML = `<div class="product-empty"><img src="/assets/icons/products/empty-product.png" alt=""><strong>${query ? 'Không tìm thấy sản phẩm' : 'Chưa có sản phẩm nào'}</strong></div>`;
    return;
  }
  productList.innerHTML = items.map(product => {
    const initial = escapeHtml(String(product.name || 'S').trim().charAt(0).toUpperCase());
    const image = product.image ? `<img src="${escapeHtml(product.image)}" alt="">` : initial;
    return `<article class="product-row${product.active === false ? ' is-off' : ''}" data-product-id="${escapeHtml(product.id)}">
      <div class="product-row-main"><span class="product-row-image">${image}</span><span class="product-row-copy"><strong>${escapeHtml(product.name)}${product.active === false ? ' <span class="product-row-off">Ngừng bán</span>' : ''}</strong><small>Cập nhật ${new Date(product.updatedAt || product.createdAt || Date.now()).toLocaleDateString('vi-VN')}</small></span></div>
      <code class="product-row-sku">${escapeHtml(product.sku)}</code>
      <strong class="product-row-price product-row-sale">${escapeHtml(formatOrderMoney(product.salePrice))}</strong>
      <span class="product-row-combo">${describeComboPrices(product)}</span>
      <span class="product-row-group">${product.mixGroup ? `<code>${escapeHtml(product.mixGroup)}</code>` : '<em>Không ghép</em>'}</span>
      <span class="product-row-actions"><button type="button" data-product-action="edit" title="Sửa sản phẩm" aria-label="Sửa sản phẩm"><img src="/assets/icons/products/edit.png" alt=""></button><button type="button" data-product-action="delete" title="Xóa sản phẩm" aria-label="Xóa sản phẩm"><img src="/assets/icons/products/delete.png" alt=""></button></span>
    </article>`;
  }).join('');
}

async function loadProducts() {
  const result = await readApiResponse(await fetch('/api/products'));
  sharedProducts = Array.isArray(result.items) ? result.items : [];
  syncSharedProductOptions();
  renderProducts();
  return sharedProducts;
}

function renderProductLoadError() {
  sharedProducts = [];
  syncSharedProductOptions();
  if (productCount) productCount.textContent = '0 sản phẩm';
  if (productList) productList.innerHTML = '<div class="product-empty"><img src="/assets/icons/products/empty-product.png" alt=""><strong>Chưa tải được danh mục sản phẩm</strong></div>';
}

function openProductDialog(product = null) {
  selectedProductId = product?.id || '';
  pendingProductImage = '';
  removeCurrentProductImage = false;
  if (productDialogTitle) productDialogTitle.textContent = product ? 'Chỉnh sửa sản phẩm' : 'Thêm sản phẩm';
  if (productName) productName.value = product?.name || '';
  if (productSku) productSku.value = product?.sku || '';
  if (productOriginalPrice) productOriginalPrice.value = String(product?.originalPrice || 0);
  if (productSalePrice) productSalePrice.value = String(product?.salePrice || 0);
  if (productCombo2) productCombo2.value = product?.comboPrices?.['2'] ? String(product.comboPrices['2']) : '';
  if (productCombo3) productCombo3.value = product?.comboPrices?.['3'] ? String(product.comboPrices['3']) : '';
  if (productMixGroup) productMixGroup.value = product?.mixGroup || '';
  if (productActive) productActive.checked = product ? product.active !== false : true;
  if (productAliases) productAliases.value = Array.isArray(product?.aliases) ? product.aliases.join('\n') : '';
  if (productMixGroupOptions) {
    const groups = [...new Set(sharedProducts.map(item => item.mixGroup).filter(Boolean))];
    productMixGroupOptions.innerHTML = groups.map(group => `<option value="${escapeHtml(group)}"></option>`).join('');
  }
  if (productImageInput) productImageInput.value = '';
  if (productFormStatus) productFormStatus.textContent = '';
  renderProductImagePreview(product?.image || '');
  productDialog?.classList.remove('hidden');
  window.setTimeout(() => productName?.focus(), 0);
}

function closeProductDialog() {
  productDialog?.classList.add('hidden');
  productForm?.reset();
  selectedProductId = '';
  pendingProductImage = '';
  removeCurrentProductImage = false;
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Không thể đọc ảnh sản phẩm.'));
    reader.readAsDataURL(file);
  });
}

function showSettingsSection(name = 'channels') {
  const section = settingsPanels.has(name) ? name : 'channels';
  showView('settings');
  settingsPanels.forEach((panel, panelName) => panel.classList.toggle('hidden', panelName !== section));
  settingsSectionButtons.forEach(button => button.classList.toggle('active', button.dataset.settingsSection === section));
  if (section === 'chatbot') loadChatbotSettings();
  if (section === 'products') loadProducts().catch(error => {
    renderProductLoadError();
    showToast(error.message || 'Chưa tải được danh mục sản phẩm.', 'error');
  });
  if (section === 'gifts') loadGifts();
}

function renderChatbotToggle(conversation = getActiveConversation()) {
  if (!chatbotToggleButton) return;
  const key = getCustomerPanelKey(conversation);
  const enabled = Boolean(key && customerPanelStore.bots[key]);
  const label = enabled ? 'Tắt bot cho hội thoại này' : 'Bật bot cho hội thoại này';
  chatbotToggleButton.classList.toggle('active', enabled);
  chatbotToggleButton.setAttribute('aria-pressed', String(enabled));
  chatbotToggleButton.setAttribute('aria-label', label);
  chatbotToggleButton.title = label;
}

async function loadCustomerPanelFromServer(conversation = getActiveConversation()) {
  const conversationId = conversation?.dataset.conversationId;
  const key = getCustomerPanelKey(conversation);
  if (!conversationId || !key) return;
  const requestId = ++customerPanelRequestId;
  try {
    const panel = await readApiResponse(await fetch(`/api/messaging/conversations/${encodeURIComponent(conversationId)}/customer-panel`));
    if (requestId !== customerPanelRequestId || getCustomerPanelKey() !== key) return;
    customerPanelStore.notes[key] = Array.isArray(panel.notes) ? panel.notes : [];
    customerPanelStore.orders[key] = Array.isArray(panel.orders) ? panel.orders : [];
    customerPanelStore.bots[key] = panel.botEnabled === true;
    customerBotErrors[key] = { message: String(panel.botLastError || ''), at: Number(panel.botLastErrorAt) || 0 };
    saveCustomerPanelStore();
    renderChatbotToggle(conversation);
    renderChatbotError(conversation);
    renderCustomerNotes(conversation);
    renderCustomerOrders(conversation);
    renderConversationOrderCards(conversation);
    if (chatBody) chatBody.scrollTop = chatBody.scrollHeight;
  } catch {
    // Keep the local copy available if the server cannot be reached.
  }
}

async function saveCustomerPanelChange(conversation, payload) {
  const conversationId = conversation?.dataset.conversationId;
  const key = getCustomerPanelKey(conversation);
  if (!conversationId || !key) return;
  try {
    const panel = await readApiResponse(await fetch(`/api/messaging/conversations/${encodeURIComponent(conversationId)}/customer-panel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
    customerPanelStore.notes[key] = Array.isArray(panel.notes) ? panel.notes : [];
    customerPanelStore.orders[key] = Array.isArray(panel.orders) ? panel.orders : [];
    customerPanelStore.bots[key] = panel.botEnabled === true;
    saveCustomerPanelStore();
    renderChatbotToggle(conversation);
    if (getCustomerPanelKey() === key) {
      renderCustomerNotes(conversation);
      renderCustomerOrders(conversation);
      renderConversationOrderCards(conversation);
      if (chatBody) chatBody.scrollTop = chatBody.scrollHeight;
    }
  } catch (error) {
    showToast(error.message || 'Chưa đồng bộ được thông tin khách hàng lên máy chủ.');
  }
}

function formatOrderMoney(value) {
  return `${new Intl.NumberFormat('vi-VN').format(Math.max(0, Number(value) || 0))} đ`;
}

// Line icons drawn as inline SVG. The 16px PNGs they replaced were raster art
// upscaled by the device pixel ratio, which made every icon in the order card
// look soft and broken up on high-density screens.
const customerPanelIconPaths = {
  star: '<path d="M12 3.7l2.6 5.2 5.8.9-4.2 4.1 1 5.7-5.2-2.7-5.2 2.7 1-5.7L3.6 9.8l5.8-.9Z"/>',
  shield: '<path d="M12 3.2 5.2 6v5.4c0 4.2 2.9 8.1 6.8 9.4 3.9-1.3 6.8-5.2 6.8-9.4V6Z"/><path d="m9.2 12 2 2 3.9-3.9"/>',
  cancel: '<circle cx="12" cy="12" r="8.4"/><path d="m9.6 9.6 4.8 4.8M14.4 9.6l-4.8 4.8"/>',
  user: '<circle cx="12" cy="8" r="3.3"/><path d="M5.6 19.4c.9-3.4 3.4-5.2 6.4-5.2s5.5 1.8 6.4 5.2"/>',
  location: '<path d="M4 10.6 12 4.2l8 6.4"/><path d="M6.6 9.9V19.4h10.8V9.9"/><path d="M10.1 19.4v-4.4h3.8v4.4"/>',
  phone: '<path d="M7.3 4.6h2.1l1.4 3.3-1.7 1.3a10.4 10.4 0 0 0 5.7 5.7l1.3-1.7 3.3 1.4v2.1a2 2 0 0 1-2.2 2C11 18 6 13 5.3 6.8a2 2 0 0 1 2-2.2Z"/>',
  cart: '<path d="M3.2 4.6h2.1l2.3 10h9.4l1.9-7.1H6.6"/><circle cx="9.6" cy="18.8" r="1.4"/><circle cx="16.4" cy="18.8" r="1.4"/>',
  wallet: '<rect x="3.2" y="5.8" width="17.6" height="12.6" rx="2.2"/><path d="M3.2 10.2h17.6"/>',
  clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.1 1.9"/>',
  check: '<circle cx="12" cy="12" r="8.4"/><path d="m8.4 12.2 2.6 2.6 4.6-4.7"/>',
  document: '<path d="M6.6 3.6h6.8L17.9 8v12.4H6.6Z"/><path d="M13.3 3.7V8h4.5"/>',
  printer: '<path d="M7.6 9.2V4.1h8.8v5.1"/><rect x="4.1" y="9.2" width="15.8" height="6.8" rx="1.6"/><path d="M7.6 14.1h8.8v5.8H7.6z"/>',
  delivery: '<path d="M20.3 8.1 12 4.2 3.7 8.1l8.3 3.9Z"/><path d="M3.7 8.1v7.9l8.3 3.9 8.3-3.9V8.1"/><path d="M12 12v7.9"/>',
  calendar: '<rect x="3.8" y="5.4" width="16.4" height="14.2" rx="2"/><path d="M3.8 9.8h16.4M8.4 3.6v3.6M15.6 3.6v3.6"/>',
  tag: '<path d="M4.1 4.1h7.1l8.3 8.3-7.1 7.1L4.1 11.2Z"/><circle cx="8.4" cy="8.4" r="1.3"/>',
  list: '<path d="M4.2 7h1.6M4.2 12h1.6M4.2 17h1.6M9 7h10.8M9 12h10.8M9 17h10.8"/>',
  search: '<circle cx="10.7" cy="10.7" r="6.2"/><path d="m15.3 15.3 4.3 4.3"/>',
  plus: '<path d="M12 5.6v12.8M5.6 12h12.8"/>'
};

function customerPanelIcon(name, alt = '') {
  const paths = customerPanelIconPaths[name] || customerPanelIconPaths.document;
  const label = alt ? ` role="img" aria-label="${escapeHtml(alt)}"` : ' aria-hidden="true"';
  return `<svg class="customer-panel-icon" viewBox="0 0 24 24"${label}>${paths}</svg>`;
}

function formatCustomerPanelTime(value, includeDate = false) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '—';
  const options = includeDate
    ? { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }
    : { hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat('vi-VN', options).format(date);
}

function getCustomerPanelProfile(conversation = getActiveConversation()) {
  if (!conversation) return { name: '', phone: '', address: '', avatar: '' };
  const name = getConversationName(conversation);
  const profile = conversationProfiles[name] || {};
  // Pancake pre-fills the order form from the customer record. The nearest
  // equivalent here is the newest order already placed in this conversation,
  // which is why a repeat customer never has to retype phone and address.
  const key = getCustomerPanelKey(conversation);
  const storedOrders = key && Array.isArray(customerPanelStore.orders[key]) ? customerPanelStore.orders[key] : [];
  const latest = storedOrders.find(order => order?.phone || order?.address) || {};
  return {
    name,
    phone: profile.phone || latest.phone || '',
    address: profile.address || profile.order?.[5] || latest.address || '',
    avatar: conversation.dataset.avatar || ''
  };
}

function getSeedCustomerOrder(conversation = getActiveConversation()) {
  if (!conversation) return [];
  const profile = conversationProfiles[getConversationName(conversation)];
  if (!profile?.order?.length) return [];
  const values = profile.order;
  return [{
    id: String(values[0] || 'GN-240901').replace(/^#/, ''),
    name: getConversationName(conversation),
    phone: values[4] || profile.phone || '',
    address: values[5] || '',
    products: [{ name: values[1] || 'Sản phẩm', quantity: Number(values[2]) || 1, price: Number(String(values[6] || '').replace(/\D/g, '')) || 0 }],
    status: values[3] || 'Mới',
    shippingFee: 0,
    discount: 0,
    total: Number(String(values[6] || '').replace(/\D/g, '')) || 0,
    source: 'Facebook',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    employee: appSettings.displayName || 'Bạn'
  }];
}

function getCustomerOrders(conversation = getActiveConversation()) {
  const key = getCustomerPanelKey(conversation);
  if (!key) return [];
  if (!Array.isArray(customerPanelStore.orders[key])) customerPanelStore.orders[key] = getSeedCustomerOrder(conversation);
  return customerPanelStore.orders[key];
}

// Chatbot failures are reported per conversation by the server and are not worth
// persisting locally: a stale warning would be worse than none.
const customerBotErrors = {};

function renderChatbotError(conversation = getActiveConversation()) {
  if (!customerBotAlert) return;
  const failure = customerBotErrors[getCustomerPanelKey(conversation)];
  customerBotAlert.classList.toggle('hidden', !failure?.message);
  if (!failure?.message) return;
  const when = failure.at ? ` lúc ${formatCustomerPanelTime(failure.at, true)}` : '';
  customerBotAlert.innerHTML = `<strong>Chatbot chưa tạo được đơn${escapeHtml(when)}</strong><span>${escapeHtml(failure.message)}</span><span>Khách có thể đã nhận tin xác nhận. Kiểm tra lại và tạo đơn thủ công nếu cần.</span>`;
}

function renderCustomerNotes(conversation = getActiveConversation()) {
  if (!customerNoteList || !customerNoteEmpty) return;
  const notes = customerPanelStore.notes[getCustomerPanelKey(conversation)] || [];
  customerNoteEmpty.classList.toggle('hidden', notes.length > 0);
  customerNoteList.classList.toggle('hidden', notes.length === 0);
  customerNoteList.innerHTML = notes.map(note => `<li>${escapeHtml(note.text)}<time>${escapeHtml(formatCustomerPanelTime(note.createdAt, true))}</time></li>`).join('');
}

const vietnamCarrierPrefixes = {
  Viettel: ['032', '033', '034', '035', '036', '037', '038', '039', '086', '096', '097', '098'],
  Vinaphone: ['081', '082', '083', '084', '085', '088', '091', '094'],
  Mobifone: ['070', '076', '077', '078', '079', '089', '090', '093'],
  Vietnamobile: ['052', '056', '058', '092'],
  Gmobile: ['059', '099'],
  Itelecom: ['087']
};

function detectPhoneCarrier(phone) {
  const digits = String(phone || '').replace(/\D/g, '').replace(/^84/, '0');
  if (digits.length < 10) return '';
  const prefix = digits.slice(0, 3);
  return Object.keys(vietnamCarrierPrefixes).find(carrier => vietnamCarrierPrefixes[carrier].includes(prefix)) || '';
}

function findSharedProduct(value) {
  const query = String(value || '').trim().toLocaleLowerCase('vi');
  if (!query) return null;
  return sharedProducts.find(item => String(item.sku || '').toLocaleLowerCase('vi') === query)
    || sharedProducts.find(item => String(item.name || '').toLocaleLowerCase('vi') === query)
    || sharedProducts.find(item => `${item.name} ${item.sku}`.toLocaleLowerCase('vi').includes(query))
    || null;
}

function getProductUnitWeight(item) {
  if (Number(item?.weight) > 0) return Number(item.weight);
  const sku = String(item?.sku || '').toUpperCase();
  if (sku && Number(skuWeights[sku]) > 0) return Number(skuWeights[sku]);
  const matched = findSharedProduct(item?.sku || item?.name);
  if (Number(matched?.weight) > 0) return Number(matched.weight);
  const matchedSku = String(matched?.sku || '').toUpperCase();
  return Number(skuWeights[matchedSku]) || 0;
}

function formatGramWeight(grams) {
  const value = Math.max(0, Math.round(Number(grams) || 0));
  return `${new Intl.NumberFormat('vi-VN').format(value)} g`;
}

function describeOrderProducts(order) {
  const products = Array.isArray(order?.products) ? order.products : [];
  const quantity = products.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const weight = products.reduce((sum, item) => sum + getProductUnitWeight(item) * (Number(item.quantity) || 0), 0);
  const first = products[0] || null;
  const matched = first ? findSharedProduct(first.sku || first.name) : null;
  const sku = String(first?.sku || matched?.sku || '').trim();
  const name = String(first?.name || '').trim();
  const extra = products.length > 1 ? ` +${products.length - 1} SP` : '';
  return { products, quantity, weight, sku, name: `${name}${extra}` };
}

const customerAvatarPlaceholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Ccircle cx='20' cy='20' r='20' fill='%23e6e8ec'/%3E%3Ccircle cx='20' cy='15.5' r='6' fill='%23b6bcc6'/%3E%3Cpath d='M8.5 34c2-6 6.2-9 11.5-9s9.5 3 11.5 9z' fill='%23b6bcc6'/%3E%3C/svg%3E";

function customerOrderStaff(name, avatar) {
  const label = escapeHtml(String(name || 'Bạn'));
  return `<span class="customer-order-staff"><img src="${escapeHtml(avatar || customerAvatarPlaceholder)}" alt="">${label}</span>`;
}

function customerOrderMetaRow(icon, label, valueMarkup, link = false) {
  return `<div class="customer-order-detail">${customerPanelIcon(icon)}<span>${escapeHtml(label)}</span><span class="value${link ? ' link' : ''}">${valueMarkup}</span></div>`;
}

const customerOrderEmptyIllustration = `<svg viewBox="0 0 140 128" aria-hidden="true">
  <path d="M32 58h76l-8 46H40Z" fill="#f2f4f8" stroke="#dbe0e8" stroke-width="2" stroke-linejoin="round"></path>
  <path d="M22 46h44l-6 14H28Z" fill="#fff" stroke="#dbe0e8" stroke-width="2" stroke-linejoin="round"></path>
  <path d="M118 46H74l6 14h32Z" fill="#fff" stroke="#dbe0e8" stroke-width="2" stroke-linejoin="round"></path>
  <path d="M70 44V22M70 22l-9 8M70 22l9 8" stroke="#cfd6e0" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path>
  <circle cx="42" cy="26" r="3" fill="#e3e8ef"></circle>
  <circle cx="104" cy="34" r="2.4" fill="#e3e8ef"></circle>
  <path d="M28 36h5M114 20h5M116.5 17.5v5" stroke="#e3e8ef" stroke-width="2" stroke-linecap="round"></path>
</svg>`;

function renderCustomerOrders(conversation = getActiveConversation()) {
  if (!customerOrderList || !customerOrderCount) return;
  const orders = getCustomerOrders(conversation);
  customerOrderCount.textContent = orders.length ? `Đơn hàng (${orders.length})` : 'Đơn hàng';
  if (!orders.length) {
    customerOrderList.innerHTML = `<div class="customer-orders-empty">${customerOrderEmptyIllustration}<span>Chưa có đơn hàng trong khoảng thời gian này</span><button type="button" id="customer-order-create-new">+ Tạo mới</button></div>`;
    return;
  }
  customerOrderList.innerHTML = orders.map((order, index) => {
    const summary = describeOrderProducts(order);
    const total = Number(order.total) || summary.products.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0);
    const carrier = detectPhoneCarrier(order.phone);
    const channelIcon = String(order.source || '').toLocaleLowerCase('vi').includes('zalo') ? 'zalo' : 'facebook';
    const avatar = order.employeeAvatar || '';
    const updated = Number(order.updatedAt) && Number(order.updatedAt) !== Number(order.createdAt)
      ? customerOrderMetaRow('check', 'Cập nhật TT', escapeHtml(formatCustomerPanelTime(order.updatedAt)))
      : '';
    const productCell = summary.sku
      ? `<b class="customer-order-sku">${escapeHtml(summary.sku)}</b> <span class="customer-order-product-name">${escapeHtml(summary.name || 'Sản phẩm')}</span>`
      : `<span class="customer-order-product-name">${escapeHtml(summary.name || 'Chưa có sản phẩm')}</span>`;
    return `<details class="customer-order-card" ${index === 0 ? 'open' : ''}>
      <summary>
        ${avatar ? `<img class="order-owner" src="${escapeHtml(avatar)}" alt="">` : ''}
        <strong>${escapeHtml(String(order.id))}</strong>
        <img class="order-channel" src="/assets/icons/${channelIcon}.png" alt="${escapeHtml(order.source || 'Facebook')}">
        <span class="customer-order-actions">
          <button type="button" data-order-action="note" data-order-id="${escapeHtml(String(order.id))}" title="Ghi chú đơn" aria-label="Ghi chú đơn"><svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M8 8h8M8 12h8M8 16h5"></path></svg></button>
          <button type="button" data-order-action="share" data-order-id="${escapeHtml(String(order.id))}" title="Gửi lại cho khách" aria-label="Gửi lại cho khách"><svg viewBox="0 0 24 24"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"></path><path d="M12 16V4M8 8l4-4 4 4"></path></svg></button>
          <button type="button" data-order-action="edit" data-order-id="${escapeHtml(String(order.id))}" title="Sửa đơn" aria-label="Sửa đơn"><svg viewBox="0 0 24 24"><path d="M4 20h4L20 8l-4-4L4 16Z"></path><path d="m14 6 4 4"></path></svg></button>
        </span>
      </summary>
      <div class="customer-order-statuses">
        <span>${customerPanelIcon('star')}${escapeHtml(order.status || 'Mới')}</span><i>&rsaquo;</i><b>${customerPanelIcon('shield')}Đã xác nhận</b><i>&rsaquo;</i><span>${customerPanelIcon('cancel')}Hủy</span>
      </div>
      <div class="customer-order-details">
        <div class="customer-order-customer">
          <div class="customer-order-detail">${customerPanelIcon('user')}<span class="grow">${escapeHtml(order.name || 'Chưa có tên')}</span></div>
          <div class="customer-order-detail">${customerPanelIcon('location')}<span class="grow">${escapeHtml(order.address || 'Chưa có địa chỉ')}</span></div>
          <div class="customer-order-detail">${customerPanelIcon('phone')}<a href="tel:${escapeHtml(order.phone || '')}">${escapeHtml(order.phone || 'Chưa có số điện thoại')}</a>${carrier ? `<span class="customer-order-tag-carrier">${escapeHtml(carrier)}</span>` : ''}</div>
          <div class="customer-order-detail">${customerPanelIcon('cart')}<span class="grow">${productCell}</span><svg class="customer-order-info-dot" viewBox="0 0 24 24" fill="none" stroke="#8c8c8c" stroke-width="1.8"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5" stroke-linecap="round"></path><circle cx="12" cy="7.8" r="1" fill="#8c8c8c" stroke="none"></circle></svg><span class="customer-order-full">Đơn đủ</span></div>
          <div class="customer-order-detail">${customerPanelIcon('wallet')}<span class="customer-order-price">${escapeHtml(formatOrderMoney(total))}</span><span class="customer-order-weight">${customerPanelIcon('delivery')}${escapeHtml(summary.weight ? formatGramWeight(summary.weight) : `SL ${summary.quantity}`)}</span></div>
        </div>
        <div class="customer-order-meta">
          ${customerOrderMetaRow('clock', 'Tạo lúc', escapeHtml(formatCustomerPanelTime(order.createdAt)))}
          ${updated}
          ${order.note ? customerOrderMetaRow('document', 'Ghi chú', escapeHtml(order.note)) : customerOrderMetaRow('document', 'Ghi chú', 'Chưa có', true)}
          ${customerOrderMetaRow('printer', 'Ghi chú in', 'Chưa có', true)}
          ${customerOrderMetaRow('user', 'NV sửa cuối', customerOrderStaff(order.employee, avatar))}
          ${customerOrderMetaRow('user', 'NV tạo đơn', customerOrderStaff(order.employee, avatar))}
          ${customerOrderMetaRow('delivery', 'Dự kiến nhận hàng', 'Chưa có', true)}
        </div>
        <div class="customer-order-tags">
          <div class="customer-order-detail">${customerPanelIcon('tag')}<span class="grow">Thẻ</span><button type="button">Thêm thẻ</button></div>
          <div class="customer-order-detail">${customerPanelIcon('tag')}<span class="grow">Thẻ KH</span><button type="button">Thêm thẻ</button></div>
        </div>
      </div>
    </details>`;
  }).join('');
}

function getCustomerOrderProductImage(productName) {
  const name = normalizeColumnName(productName);
  const imageName = name.includes('combo 2') && name.includes('xanh') ? 'combo2_green'
    : name.includes('combo 2') && name.includes('vang') ? 'combo2_yellow'
      : name.includes('combo 3') && name.includes('xanh') ? 'combo3_green'
        : name.includes('combo 3') && name.includes('vang') ? 'combo3_yellow'
          : name.includes('xanh') ? 'product_green'
            : name.includes('vang') ? 'product_yellow'
              : name.includes('nau') ? 'product_brown' : '';
  return imageName ? `/assets/logos/${imageName}.png` : '';
}

function formatCustomerOrderCardTime(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '—';
  const time = date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const day = date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  return `${time} ${day}`;
}

function appendConversationOrderCard(order) {
  if (!chatBody || !order) return;
  const products = Array.isArray(order.products) ? order.products : [];
  const subtotal = products.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0);
  const total = Number(order.total) || Math.max(0, subtotal + (Number(order.shippingFee) || 0) - (Number(order.discount) || 0));
  const fullChannelName = messageChannels.find(item => item.id === currentMessageChannelId)?.name || 'Giọt Nắng';
  const channelName = fullChannelName.replace(/^Nông Sản\s+/i, '') || fullChannelName;
  const productRows = products.map(item => {
    const image = getCustomerOrderProductImage(item.name);
    const imageMarkup = image ? `<img src="${image}" alt="${escapeHtml(item.name || 'Sản phẩm')}">` : '';
    return `<div class="conversation-order-product${image ? '' : ' conversation-order-product--no-image'}">
      ${imageMarkup}
      <div><strong>${escapeHtml(item.name || 'Sản phẩm')}</strong><span>Phân loại: ${escapeHtml(item.variant || 'Sản phẩm')}</span><span>Số lượng: ${Math.max(1, Number(item.quantity) || 1)}</span><span>Đơn giá ${escapeHtml(formatOrderMoney(item.price))}</span></div>
    </div>`;
  }).join('');
  const row = document.createElement('div');
  row.className = 'conversation-order-row';
  row.dataset.orderId = String(order.id || '');
  const orderTime = getChatTimestamp(order.createdAt) || Date.now();
  row.dataset.sentAt = String(orderTime);
  row.innerHTML = `<article class="conversation-order-card" aria-label="Xác nhận đơn đặt hàng ${escapeHtml(String(order.id || ''))}">
    <header><span>Xác nhận đơn đặt hàng</span><strong>${escapeHtml(channelName)}</strong></header>
    <div class="conversation-order-card-body">
      <div class="conversation-order-products">${productRows}</div>
      <dl class="conversation-order-info">
        <div><dt>Đã đặt hàng vào</dt><dd><strong>${escapeHtml(formatCustomerOrderCardTime(order.createdAt))}</strong></dd></div>
        <div><dt>Số điện thoại</dt><dd>${escapeHtml(order.phone || 'Chưa có')}</dd></div>
        <div><dt>Đã thanh toán bằng</dt><dd>${escapeHtml(order.payment === 'Chuyển khoản' ? 'Chuyển khoản' : 'Thanh toán khi giao hàng (COD)')}</dd></div>
        <div><dt>Giao hàng đến</dt><dd><strong>${escapeHtml(order.name || 'Chưa có tên')}</strong><span>${escapeHtml(order.address || 'Chưa có địa chỉ')}</span></dd></div>
        <div><dt>Giá trị ĐH</dt><dd><strong>${escapeHtml(formatOrderMoney(total))}</strong></dd></div>
      </dl>
    </div>
  </article>`;
  const nextTimelineItem = [...chatBody.children].find(item => Number(item.dataset.sentAt) > orderTime);
  if (nextTimelineItem) chatBody.insertBefore(row, nextTimelineItem);
  else chatBody.appendChild(row);
}

function renderConversationOrderCards(conversation = getActiveConversation()) {
  if (!chatBody || !conversation || currentChatHeadView !== 'chat') return;
  chatBody.querySelectorAll(':scope > .conversation-order-row').forEach(row => row.remove());
  [...getCustomerOrders(conversation)]
    .sort((first, second) => (Number(first.createdAt) || 0) - (Number(second.createdAt) || 0))
    .forEach(appendConversationOrderCard);
}

function getCustomerDraftWeight() {
  return customerDraftProducts.reduce((sum, item) => sum + getProductUnitWeight(item) * (Number(item.quantity) || 0), 0);
}

function updateCustomerOrderTotals() {
  const subtotal = customerDraftProducts.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const quantity = customerDraftProducts.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const shipping = customerFreeShipping?.checked ? 0 : Math.max(0, Number(customerShippingFee?.value) || 0);
  const discount = Math.max(0, Number(customerOrderDiscount?.value) || 0);
  const total = Math.max(0, subtotal + shipping - discount);
  if (customerOrderSubtotal) customerOrderSubtotal.textContent = formatOrderMoney(subtotal);
  if (customerOrderTotal) customerOrderTotal.textContent = formatOrderMoney(total);
  if (customerProductQuantityLabel) customerProductQuantityLabel.textContent = `SL:${quantity}`;
  if (customerOrderWeight) customerOrderWeight.textContent = formatGramWeight(getCustomerDraftWeight());
  if (customerShippingFee) customerShippingFee.disabled = Boolean(customerFreeShipping?.checked);
  if (customerOrderSubmit) customerOrderSubmit.disabled = !customerOrderName?.value.trim() || !customerOrderPhone?.value.trim() || !customerOrderAddress?.value.trim() || !customerDraftProducts.length;
  return { subtotal, shipping, discount, total, quantity };
}

function renderCustomerDraftProducts() {
  if (!customerProductList || !customerProductEmpty) return;
  customerProductEmpty.classList.toggle('hidden', customerDraftProducts.length > 0);
  customerProductList.innerHTML = customerDraftProducts.map((item, index) => {
    const unitWeight = getProductUnitWeight(item);
    const variant = [item.variant || '', unitWeight ? formatGramWeight(unitWeight * Math.max(1, Number(item.quantity) || 1)) : '']
      .filter(Boolean);
    const subline = variant.length
      ? `<small>${escapeHtml(variant[0])}${variant[1] ? `, <em>${escapeHtml(variant[1])}</em>` : ''}</small>`
      : (item.sku ? `<small>${escapeHtml(item.sku)}</small>` : '');
    return `<div class="customer-product-row">
      <span class="cell-name"><strong>${escapeHtml(item.name)}</strong>${subline}<button type="button" data-remove-customer-product="${index}">Xóa</button></span>
      <input type="number" min="1" step="1" value="${Math.max(1, Number(item.quantity) || 1)}" data-customer-quantity="${index}" aria-label="Số lượng">
      <input type="number" min="0" step="1000" value="${Math.max(0, Number(item.price) || 0)}" data-customer-price="${index}" aria-label="Đơn giá">
      <span class="cell-total">${escapeHtml(formatOrderMoney(item.quantity * item.price))}</span>
    </div>`;
  }).join('');
  updateCustomerOrderTotals();
}

function renderCustomerOrderChip(conversation = getActiveConversation()) {
  if (!customerOrderChip) return;
  const profile = getCustomerPanelProfile(conversation);
  const name = profile.name || customerOrderName?.value.trim() || '';
  const phone = customerOrderPhone?.value.trim() || profile.phone || '';
  customerOrderChip.hidden = !name;
  if (!name) return;
  if (customerOrderChipName) customerOrderChipName.textContent = name;
  if (customerOrderChipPhone) customerOrderChipPhone.textContent = phone || 'Chưa có số điện thoại';
  if (customerOrderChipAvatar) customerOrderChipAvatar.src = profile.avatar || customerAvatarPlaceholder;
  const carrier = detectPhoneCarrier(phone);
  if (customerOrderChipCarrier) {
    customerOrderChipCarrier.hidden = !carrier;
    customerOrderChipCarrier.textContent = carrier;
  }
}

function renderCustomerSavedAddresses(conversation = getActiveConversation()) {
  if (!customerOrderSavedAddress) return;
  const profile = getCustomerPanelProfile(conversation);
  const addresses = [...new Set([profile.address, ...getCustomerOrders(conversation).map(order => order.address)].filter(Boolean))];
  const current = customerOrderSavedAddress.value;
  customerOrderSavedAddress.innerHTML = ['<option value="">Chọn địa chỉ</option>']
    .concat(addresses.map(address => `<option value="${escapeHtml(address)}">${escapeHtml(address)}</option>`))
    .join('');
  if (addresses.includes(current)) customerOrderSavedAddress.value = current;
}

function resetCustomerOrderForm(conversation = getActiveConversation()) {
  const profile = getCustomerPanelProfile(conversation);
  customerDraftProducts = [];
  if (customerOrderName) customerOrderName.value = profile.name;
  if (customerOrderPhone) customerOrderPhone.value = profile.phone;
  if (customerOrderAddress) customerOrderAddress.value = profile.address;
  if (customerProductName) customerProductName.value = '';
  if (customerFreeShipping) customerFreeShipping.checked = false;
  if (customerBankTransfer) customerBankTransfer.checked = false;
  if (customerShippingFee) customerShippingFee.value = '0';
  if (customerOrderDiscount) customerOrderDiscount.value = '0';
  if (customerOrderNote) customerOrderNote.value = '';
  renderCustomerSavedAddresses(conversation);
  renderCustomerOrderChip(conversation);
  renderCustomerDraftProducts();
}

function setCustomerPanelTab(name) {
  customerPanelTabs.forEach(tab => {
    const active = tab.dataset.customerTab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  customerPanelViews.forEach(view => view.classList.toggle('hidden', view.dataset.customerPanel !== name));
  if (name === 'create') resetCustomerOrderForm();
}

function renderCustomerPanel(conversation = getActiveConversation()) {
  renderChatbotToggle(conversation);
  renderChatbotError(conversation);
  renderCustomerNotes(conversation);
  renderCustomerOrders(conversation);
  const profile = getCustomerPanelProfile(conversation);
  if (customerOrderName) customerOrderName.value = profile.name;
  if (customerOrderPhone) customerOrderPhone.value = profile.phone;
  if (customerOrderAddress) customerOrderAddress.value = profile.address;
  renderCustomerSavedAddresses(conversation);
  renderCustomerOrderChip(conversation);
  updateCustomerOrderTotals();
  loadCustomerPanelFromServer(conversation);
}

function renderConversationHeader(conversation) {
  const name = getConversationName(conversation);
  const initial = conversation.querySelector('.avatar')?.textContent.trim() || name.charAt(0);
  const avatarPhoto = conversation.dataset.avatar || '';
  const profile = conversationProfiles[name] || {};
  const channel = messageChannels.find(item => item.id === currentMessageChannelId);
  const customerPlatform = channel?.platform === 'zalo' ? 'Khách hàng Zalo' : 'Khách hàng Facebook';

  if (chatHeadAvatar) chatHeadAvatar.textContent = initial;
  applyAvatarPhoto(chatHeadAvatar, avatarPhoto);
  if (chatHeadName) chatHeadName.textContent = name;
  chatHeadMeta?.classList.remove('hidden');
  if (chatHeadChannelLogo) chatHeadChannelLogo.src = channel?.platform === 'zalo' ? '/assets/icons/zalo.png' : '/assets/icons/facebook.png';
  if (messageComposerInput) messageComposerInput.disabled = false;
  renderCustomerPanel(conversation);
  updateChatHeadViewState();
  return { name, initial };
}

function renderConversation(conversation = getActiveConversation()) {
  if (!conversation || !chatBody) return;
  const { name, initial } = renderConversationHeader(conversation);
  chatBody.replaceChildren();
  const date = document.createElement('div');
  date.className = 'chat-date';
  date.textContent = conversation.dataset.conversationId
    ? formatChatDateLabel(getChatTimestamp(getConversationMessages(conversation)[0]?.createdAt))
    : conversation.dataset.initialTime === 'Hôm qua' ? 'Hôm qua' : 'Hôm nay';
  chatBody.appendChild(date);
  getConversationMessages(conversation).forEach((message, index) => {
    const messageId = message.id || `base-${normalizeColumnName(name)}-${index}`;
    const action = message.direction === 'outgoing' ? getChatMessageAction(name, messageId) : '';
    appendChatMessage(message, message.direction, initial, messageId, action);
  });
  const messages = getSavedChatMessages(name);
  messages.forEach(message => appendChatMessage(message, 'outgoing', initial, message.id, getChatMessageAction(name, message.id)));
  renderConversationOrderCards(conversation);
  const latestMessage = [...messages].reverse().find(message => message.type !== 'system');
  if (latestMessage) {
    const preview = conversation.querySelector('small');
    const time = conversation.querySelector('time');
    const latestAction = getChatMessageAction(name, latestMessage.id);
    if (preview && latestAction !== 'deleted') preview.textContent = latestAction === 'recalled' ? 'Bạn: Đã thu hồi một tin nhắn' : `Bạn: ${getMessagePreview(latestMessage)}`;
    const latestSentAt = getChatTimestamp(latestMessage.createdAt);
    if (latestSentAt) conversation.dataset.latestSentAt = String(latestSentAt);
    if (time) time.textContent = latestSentAt ? formatConversationActivityTime(latestSentAt) : 'Bây giờ';
  }
  updateMessageGrouping();
  chatBody.scrollTop = chatBody.scrollHeight;
  renderPinnedBanner(conversation);
  if (!chatPinnedPanel?.classList.contains('hidden')) renderPinnedPanel(conversation);
  if (!chatSearchBar?.classList.contains('hidden')) updateConversationSearch();
}

function updateChatHeadViewState() {
  const showingFiles = currentChatHeadView === 'files';
  const showingDocs = currentChatHeadView === 'docs';
  const showingChat = !showingFiles && !showingDocs;
  chatHeadChatTab?.classList.toggle('active', showingChat);
  chatHeadFileTab?.classList.toggle('active', showingFiles);
  chatHeadDocsTab?.classList.toggle('active', showingDocs);
  chatHeadChatTab?.setAttribute('aria-pressed', String(showingChat));
  chatHeadFileTab?.setAttribute('aria-pressed', String(showingFiles));
  chatHeadDocsTab?.setAttribute('aria-pressed', String(showingDocs));
  composerArea?.classList.toggle('hidden', !showingChat);
}

function formatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function getDocumentExtension(name) {
  const match = /\.([a-z0-9]+)$/i.exec(name || '');
  return match ? match[1].toLowerCase() : '';
}

const documentIcons = {
  pdf: 'file-pdf',
  doc: 'file-word',
  docx: 'file-word',
  xls: 'file-excel',
  xlsx: 'file-excel',
  csv: 'file-excel',
  ppt: 'file-powerpoint',
  pptx: 'file-powerpoint',
  zip: 'file-zip',
  txt: 'file-text'
};

function getDocumentIconSource(name) {
  return `/assets/icons/${documentIcons[getDocumentExtension(name)] || 'file-generic'}.svg`;
}

function buildDocumentIcon(name) {
  const icon = document.createElement('img');
  icon.className = 'document-icon';
  icon.src = getDocumentIconSource(name);
  icon.alt = '';
  return icon;
}

function buildDocumentCard(item) {
  const card = document.createElement('a');
  card.className = 'document-card';
  card.href = item.dataUrl || '#';
  card.download = item.name || 'tai-lieu';
  card.title = item.name || 'Tài liệu';
  const icon = buildDocumentIcon(item.name);
  const copy = document.createElement('span');
  copy.className = 'document-card-copy';
  const title = document.createElement('strong');
  title.textContent = item.name || 'Tài liệu';
  const meta = document.createElement('small');
  meta.textContent = [getDocumentExtension(item.name).toUpperCase(), formatFileSize(item.size)].filter(Boolean).join(' · ');
  copy.append(title, meta);
  card.append(icon, copy);
  return card;
}

function getConversationDocuments(conversation = getActiveConversation()) {
  if (!conversation) return [];
  const name = getConversationName(conversation);
  return [...getConversationMessages(conversation), ...getSavedChatMessages(name, conversation)]
    .filter(message => message?.type === 'document' && message.dataUrl)
    .map(message => ({
      name: message.name || 'Tài liệu',
      size: message.size || 0,
      dataUrl: message.dataUrl,
      sender: message.direction === 'incoming' ? name : 'Bạn',
      sentAt: getChatTimestamp(message.createdAt)
    }))
    .sort((first, second) => second.sentAt - first.sentAt);
}

function getPinnedConversationMessages(conversation = getActiveConversation()) {
  if (!conversation || !chatBody) return [];
  const name = getConversationName(conversation);
  const pinnedKeys = getPinnedChatMessages();
  return [...chatBody.querySelectorAll('.message-row[data-message-id]')]
    .filter(row => pinnedKeys.has(getMessageStateKey(name, row.dataset.messageId)))
    .map(row => ({
      messageId: row.dataset.messageId,
      preview: row.dataset.preview || 'Tệp đính kèm',
      sender: row.classList.contains('outgoing') ? 'Bạn' : name,
      outgoing: row.classList.contains('outgoing'),
      sentAt: getChatTimestamp(row.dataset.sentAt)
    }));
}

function jumpToChatMessage(messageId) {
  if (!messageId) return;
  const row = chatBody?.querySelector(`.message-row[data-message-id="${CSS.escape(messageId)}"]`);
  if (!row) return;
  chatBody?.querySelectorAll('.message-jump-target').forEach(item => item.classList.remove('message-jump-target'));
  row.classList.add('message-jump-target');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  window.setTimeout(() => row.classList.remove('message-jump-target'), 1600);
}

function renderPinnedBanner(conversation = getActiveConversation()) {
  if (!pinnedBanner) return;
  const pinned = currentChatHeadView === 'chat' ? getPinnedConversationMessages(conversation) : [];
  const latest = pinned.at(-1);
  pinnedBanner.classList.toggle('hidden', !latest);
  if (!latest) {
    pinnedBanner.replaceChildren();
    return;
  }
  const icon = document.createElement('img');
  icon.className = 'pinned-banner-icon';
  icon.src = '/assets/icons/pin-color.svg';
  icon.alt = '';
  const copy = document.createElement('span');
  copy.className = 'pinned-banner-copy';
  const who = document.createElement('strong');
  who.textContent = latest.sender;
  const text = document.createElement('span');
  text.textContent = latest.preview;
  copy.append(who, text);
  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'pinned-banner-jump';
  jump.title = 'Tới tin nhắn';
  jump.setAttribute('aria-label', 'Tới tin nhắn đã ghim');
  jump.innerHTML = '<img src="/assets/icons/jump.svg" alt="">';
  jump.addEventListener('click', () => jumpToChatMessage(latest.messageId));
  const openList = document.createElement('button');
  openList.type = 'button';
  openList.className = 'pinned-banner-list';
  openList.textContent = pinned.length > 1 ? `${pinned.length} tin đã ghim` : 'Xem';
  openList.addEventListener('click', openPinnedPanel);
  pinnedBanner.replaceChildren(icon, copy, openList, jump);
}

function renderPinnedPanel(conversation = getActiveConversation()) {
  if (!chatPinnedResults) return;
  const query = normalizeColumnName(chatPinnedSearch?.value || '');
  const pinned = getPinnedConversationMessages(conversation)
    .filter(item => !query || normalizeColumnName(`${item.sender} ${item.preview}`).includes(query));
  if (chatPinnedCount) chatPinnedCount.textContent = pinned.length ? `${pinned.length} tin nhắn` : '';
  if (!pinned.length) {
    const empty = document.createElement('div');
    empty.className = 'conversation-search-empty';
    const image = document.createElement('img');
    image.src = '/assets/icons/search-empty.svg';
    image.alt = '';
    const text = document.createElement('p');
    text.textContent = query
      ? 'Không tìm thấy tin nhắn đã ghim phù hợp.'
      : 'Chưa có tin nhắn nào được ghim. Nhấp vào một tin nhắn rồi chọn Ghim để thêm vào đây.';
    empty.append(image, text);
    chatPinnedResults.replaceChildren(empty);
    return;
  }
  chatPinnedResults.replaceChildren(...pinned.map(item => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'pinned-card';
    const head = document.createElement('span');
    head.className = 'pinned-card-head';
    const avatar = document.createElement('span');
    avatar.className = 'avatar avatar-small';
    avatar.textContent = item.sender.charAt(0);
    if (!item.outgoing) applyAvatarPhoto(avatar, conversation?.dataset.avatar || '');
    const who = document.createElement('span');
    who.className = 'pinned-card-who';
    const senderName = document.createElement('strong');
    senderName.textContent = item.sender;
    const posted = document.createElement('small');
    posted.textContent = item.sentAt ? `Đã ghim: ${formatConversationActivityTime(item.sentAt)}` : 'Trong hội thoại';
    who.append(senderName, posted);
    head.append(avatar, who);
    const body = document.createElement('span');
    body.className = 'pinned-card-body';
    body.textContent = item.preview;
    card.append(head, body);
    card.addEventListener('click', () => jumpToChatMessage(item.messageId));
    return card;
  }));
}

function openPinnedPanel() {
  if (currentChatHeadView !== 'chat') {
    currentChatHeadView = 'chat';
    renderConversation();
  }
  closeConversationSearch();
  document.body.classList.remove('hide-contact-panel');
  contactPanelContent?.classList.add('hidden');
  chatPinnedPanel?.classList.remove('hidden');
  chatHeadPinnedTab?.classList.add('active');
  chatHeadPinnedTab?.setAttribute('aria-pressed', 'true');
  renderPinnedPanel();
}

function closePinnedPanel() {
  if (chatPinnedPanel?.classList.contains('hidden')) return;
  chatPinnedPanel?.classList.add('hidden');
  contactPanelContent?.classList.remove('hidden');
  document.body.classList.toggle('hide-contact-panel', !appSettings.showContactPanel);
  chatHeadPinnedTab?.classList.remove('active');
  chatHeadPinnedTab?.setAttribute('aria-pressed', 'false');
  if (chatPinnedSearch) chatPinnedSearch.value = '';
  if (chatPinnedCount) chatPinnedCount.textContent = '';
}

function renderConversationDocs(conversation = getActiveConversation()) {
  if (!conversation || !chatBody) return;
  renderConversationHeader(conversation);
  const documents = getConversationDocuments(conversation);
  chatBody.replaceChildren();
  pinnedBanner?.classList.add('hidden');
  const view = document.createElement('section');
  view.className = 'conversation-docs';

  const field = document.createElement('label');
  field.className = 'conversation-docs-search';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'search-icon';
  searchIcon.setAttribute('aria-hidden', 'true');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Tìm tài liệu trong hội thoại';
  search.setAttribute('aria-label', 'Tìm tài liệu trong hội thoại');
  field.append(searchIcon, search);
  view.appendChild(field);

  const table = document.createElement('div');
  table.className = 'conversation-docs-table';
  const head = document.createElement('div');
  head.className = 'conversation-docs-row conversation-docs-head';
  ['Tiêu đề', 'Người gửi', 'Thời gian', ''].forEach(label => {
    const cell = document.createElement('span');
    cell.textContent = label;
    head.appendChild(cell);
  });
  table.appendChild(head);

  const empty = document.createElement('div');
  empty.className = 'conversation-files-empty';
  empty.textContent = 'Chưa có tài liệu nào trong hội thoại này.';

  const renderRows = () => {
    const query = normalizeColumnName(search.value || '');
    const matches = documents.filter(item => !query || normalizeColumnName(item.name).includes(query));
    table.querySelectorAll('.conversation-docs-row:not(.conversation-docs-head)').forEach(row => row.remove());
    empty.textContent = documents.length
      ? 'Không tìm thấy tài liệu phù hợp.'
      : 'Chưa có tài liệu nào trong hội thoại này.';
    empty.classList.toggle('hidden', matches.length > 0);
    matches.forEach(item => {
      const row = document.createElement('div');
      row.className = 'conversation-docs-row';
      const title = document.createElement('span');
      title.className = 'conversation-docs-title';
      const icon = buildDocumentIcon(item.name);
      const label = document.createElement('span');
      label.textContent = item.name;
      label.title = item.name;
      title.append(icon, label);
      const sender = document.createElement('span');
      sender.textContent = item.sender;
      const time = document.createElement('span');
      time.textContent = item.sentAt ? formatConversationActivityTime(item.sentAt) : '—';
      const actions = document.createElement('span');
      actions.className = 'conversation-docs-actions';
      const download = document.createElement('a');
      download.href = item.dataUrl;
      download.download = item.name;
      download.title = 'Tải xuống';
      download.setAttribute('aria-label', `Tải xuống ${item.name}`);
      download.innerHTML = '<img src="/assets/icons/download.svg" alt="">';
      actions.appendChild(download);
      row.append(title, sender, time, actions);
      table.appendChild(row);
    });
  };

  search.addEventListener('input', renderRows);
  view.append(table, empty);
  chatBody.appendChild(view);
  renderRows();
  search.focus();
}

function getConversationMedia(conversation = getActiveConversation()) {
  if (!conversation) return [];
  const name = getConversationName(conversation);
  return [...getConversationMessages(conversation), ...getSavedChatMessages(name, conversation)]
    .filter(message => ['image', 'video'].includes(message?.type) && message.dataUrl);
}

function renderConversationFiles(conversation = getActiveConversation()) {
  if (!conversation || !chatBody) return;
  renderConversationHeader(conversation);
  const media = getConversationMedia(conversation);
  chatBody.replaceChildren();
  pinnedBanner?.classList.add('hidden');
  const library = document.createElement('section');
  library.className = 'conversation-files';
  const heading = document.createElement('div');
  heading.className = 'conversation-files-head';
  const title = document.createElement('strong');
  title.textContent = 'Ảnh và video';
  const count = document.createElement('span');
  count.textContent = `${media.length} tệp`;
  heading.append(title, count);
  library.appendChild(heading);
  if (!media.length) {
    const empty = document.createElement('div');
    empty.className = 'conversation-files-empty';
    empty.textContent = 'Chưa có ảnh hoặc video nào trong hội thoại này.';
    library.appendChild(empty);
  } else {
    const grid = document.createElement('div');
    grid.className = 'conversation-files-grid';
    media.forEach((item, index) => {
      const card = document.createElement('article');
      card.className = 'conversation-file-card';
      if (item.type === 'image') {
        const image = document.createElement('img');
        image.className = 'chat-image conversation-file-preview';
        image.src = item.dataUrl;
        image.alt = item.name ? `Ảnh đính kèm: ${item.name}` : `Ảnh ${index + 1}`;
        card.appendChild(image);
      } else {
        const video = document.createElement('video');
        video.className = 'conversation-file-preview';
        video.controls = true;
        video.preload = 'metadata';
        video.src = item.dataUrl;
        card.appendChild(video);
      }
      const label = document.createElement('span');
      label.textContent = item.name || (item.type === 'image' ? `Ảnh ${index + 1}` : `Video ${index + 1}`);
      card.appendChild(label);
      grid.appendChild(card);
    });
    library.appendChild(grid);
  }
  chatBody.appendChild(library);
}

function clearConversationSearchHighlights() {
  chatBody?.querySelectorAll('.conversation-search-match, .conversation-search-current').forEach(row =>
    row.classList.remove('conversation-search-match', 'conversation-search-current')
  );
  chatSearchResults?.querySelectorAll('.active').forEach(item => item.classList.remove('active'));
  conversationSearchMatches = [];
  conversationSearchIndex = -1;
}

function selectConversationSearchMatch(index) {
  chatBody?.querySelectorAll('.conversation-search-current').forEach(row => row.classList.remove('conversation-search-current'));
  chatSearchResults?.querySelectorAll('.active').forEach(item => item.classList.remove('active'));
  if (!conversationSearchMatches.length) {
    conversationSearchIndex = -1;
    return;
  }
  conversationSearchIndex = (index + conversationSearchMatches.length) % conversationSearchMatches.length;
  const match = conversationSearchMatches[conversationSearchIndex];
  const selector = match.messageId ? `.message-row[data-message-id="${CSS.escape(match.messageId)}"]` : '.message-row';
  const candidates = [...(chatBody?.querySelectorAll(selector) || [])];
  const current = candidates.find(row => row.dataset.preview === match.preview && row.classList.contains(match.direction)) || candidates[0];
  current?.classList.add('conversation-search-current');
  current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  chatSearchResults?.children[conversationSearchIndex]?.classList.add('active');
  chatSearchResults?.children[conversationSearchIndex]?.scrollIntoView({ block: 'nearest' });
}

function messageMatchesSearchDate(timestamp, filter) {
  if (filter === 'all') return true;
  if (!timestamp) return false;
  const date = new Date(timestamp);
  const now = new Date();
  if (filter === 'today') return isSameCalendarDay(date, now);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (filter === 'yesterday') return isSameCalendarDay(date, yesterday);
  return filter === 'week' && now - date <= 7 * 86400000;
}

function renderConversationSearchEmpty(message) {
  if (!chatSearchResults) return;
  const empty = document.createElement('div');
  empty.className = 'conversation-search-empty';
  const image = document.createElement('img');
  image.src = '/assets/icons/search-empty.svg';
  image.alt = '';
  const text = document.createElement('p');
  text.textContent = message;
  empty.append(image, text);
  chatSearchResults.replaceChildren(empty);
}

function updateConversationSearch() {
  clearConversationSearchHighlights();
  const query = normalizeColumnName(chatSearchInput?.value || '');
  if (!query) {
    if (chatSearchCount) chatSearchCount.textContent = '';
    renderConversationSearchEmpty('Hãy nhập từ khóa để bắt đầu tìm kiếm tin nhắn và file trong trò chuyện.');
    return;
  }
  const senderFilter = chatSearchSender?.value || 'all';
  const dateFilter = chatSearchDate?.value || 'all';
  conversationSearchMatches = [...(chatBody?.querySelectorAll('.message-row') || [])]
    .filter(row => normalizeColumnName(row.dataset.searchText || row.dataset.preview || '').includes(query))
    .filter(row => senderFilter === 'all' || (senderFilter === 'me' ? row.classList.contains('outgoing') : row.classList.contains('incoming')))
    .filter(row => messageMatchesSearchDate(getChatTimestamp(row.dataset.sentAt), dateFilter))
    .map(row => ({
      messageId: row.dataset.messageId || '',
      preview: row.dataset.preview || '',
      direction: row.classList.contains('outgoing') ? 'outgoing' : 'incoming',
      sentAt: getChatTimestamp(row.dataset.sentAt)
    }));
  if (chatSearchCount) chatSearchCount.textContent = `${conversationSearchMatches.length} kết quả`;
  if (!conversationSearchMatches.length) {
    renderConversationSearchEmpty('Không tìm thấy tin nhắn hoặc file phù hợp.');
    return;
  }
  const customerName = getConversationName(getActiveConversation()) || 'Khách hàng';
  const resultItems = conversationSearchMatches.map((match, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-search-result';
    const meta = document.createElement('span');
    meta.className = 'conversation-search-result-meta';
    const sender = document.createElement('strong');
    sender.textContent = match.direction === 'outgoing' ? 'Bạn' : customerName;
    const time = document.createElement('time');
    time.textContent = match.sentAt ? formatConversationActivityTime(match.sentAt) : 'Trong hội thoại';
    meta.append(sender, time);
    const preview = document.createElement('span');
    preview.className = 'conversation-search-result-preview';
    preview.textContent = match.preview || 'Tệp đính kèm';
    button.append(meta, preview);
    button.addEventListener('click', () => selectConversationSearchMatch(index));
    return button;
  });
  chatSearchResults?.replaceChildren(...resultItems);
  selectConversationSearchMatch(0);
}

function selectConversation(conversation) {
  if (!conversation) return;
  closeConversationMenu();
  closeConversationSearch();
  stopAudioRecording(true);
  clearPendingAttachment();
  closeComposerPopovers();
  clearMessageReply();
  ensureConversationMetadata(conversation);
  getConversationItems().forEach(item => item.classList.toggle('active', item === conversation));
  const wasUnread = conversation.classList.contains('unread');
  conversation.classList.remove('unread');
  currentChatHeadView = 'chat';
  renderConversation(conversation);
  if (conversation.dataset.conversationId) {
    ensureRemoteMessages(conversation);
    if (wasUnread) markRemoteConversationRead(conversation);
  } else {
    saveUnreadConversations();
  }
  updateMarkUnreadButton();
  filterConversations();
}

function getConversationMenuItems(conversation) {
  const isUnread = conversation.classList.contains('unread');
  const isMuted = conversation.classList.contains('muted');
  return [
    { action: 'unread', icon: 'mail-unread', label: isUnread ? 'Đánh dấu là đã đọc' : 'Đánh dấu là chưa đọc' },
    { action: 'open', icon: 'chat', label: 'Mở phần nhắn tin' },
    { action: 'mute', icon: isMuted ? 'alert' : 'alert-off', label: isMuted ? 'Bật thông báo' : 'Tắt thông báo' },
    { action: 'profile', icon: 'person', label: 'Xem trang cá nhân' },
    { action: 'call', icon: 'call', label: 'Gọi thoại', separated: true }
  ];
}

function renderConversationMenu(conversation) {
  if (!conversationMenu) return;
  conversationMenu.replaceChildren(...getConversationMenuItems(conversation).map(item => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = `conversation-menu-item${item.separated ? ' conversation-menu-item--separated' : ''}`;
    option.setAttribute('role', 'menuitem');
    option.dataset.conversationAction = item.action;
    const icon = document.createElement('img');
    icon.src = `/assets/icons/${item.icon}.svg`;
    icon.alt = '';
    const label = document.createElement('span');
    label.textContent = item.label;
    option.append(icon, label);
    return option;
  }));
}

function positionConversationMenu(trigger) {
  if (!conversationMenu) return;
  const margin = 9;
  const gap = 4.5;
  const anchorBox = trigger.getBoundingClientRect();
  const menuBox = conversationMenu.getBoundingClientRect();
  const left = Math.min(Math.max(margin, anchorBox.right - menuBox.width), window.innerWidth - menuBox.width - margin);
  const below = anchorBox.bottom + gap;
  const top = below + menuBox.height > window.innerHeight - margin
    ? Math.max(margin, anchorBox.top - menuBox.height - gap)
    : below;
  conversationMenu.style.left = `${left}px`;
  conversationMenu.style.top = `${top}px`;
}

function openConversationMenu(trigger) {
  const conversation = trigger?.closest('.conversation');
  if (!conversation || !conversationMenu) return;
  closeConversationMenu();
  conversationMenuTarget = conversation;
  renderConversationMenu(conversation);
  conversationMenu.classList.remove('hidden');
  trigger.setAttribute('aria-expanded', 'true');
  positionConversationMenu(trigger);
  conversationMenu.querySelector('.conversation-menu-item')?.focus();
}

function closeConversationMenu() {
  if (!conversationMenu || conversationMenu.classList.contains('hidden')) return;
  conversationMenu.classList.add('hidden');
  conversationMenuTarget?.querySelector('.conversation-more')?.setAttribute('aria-expanded', 'false');
  conversationMenuTarget = null;
}

function runConversationMenuAction(action, conversation) {
  if (!conversation) return;
  if (action === 'unread') {
    const isUnread = !conversation.classList.contains('unread');
    conversation.classList.toggle('unread', isUnread);
    if (conversation.dataset.conversationId) patchRemoteConversationFlags(conversation, { unread: isUnread });
    else saveUnreadConversations();
    updateMarkUnreadButton();
    filterConversations();
    return;
  }
  if (action === 'mute') {
    const isMuted = !conversation.classList.contains('muted');
    conversation.classList.toggle('muted', isMuted);
    renderConversationMuteIcon(conversation);
    if (conversation.dataset.conversationId) patchRemoteConversationFlags(conversation, { muted: isMuted });
    else saveMutedConversations();
    return;
  }
  if (action === 'open') {
    selectConversation(conversation);
    messageComposerInput?.focus();
    return;
  }
  if (action === 'profile') {
    selectConversation(conversation);
    appSettings = { ...appSettings, showContactPanel: true };
    saveAppSettings();
    applyAppSettings();
    return;
  }
  if (action === 'call') {
    selectConversation(conversation);
    showComposerStatus(`Chưa kết nối dịch vụ gọi thoại cho ${getConversationName(conversation)}.`);
  }
}

function openConversationSearch() {
  closePinnedPanel();
  currentChatHeadView = 'chat';
  renderConversation();
  document.body.classList.remove('hide-contact-panel');
  contactPanelContent?.classList.add('hidden');
  chatSearchBar?.classList.remove('hidden');
  conversationSearchButton?.classList.add('active');
  conversationSearchButton?.setAttribute('aria-expanded', 'true');
  updateConversationSearch();
  chatSearchInput?.focus();
}

function closeConversationSearch() {
  clearConversationSearchHighlights();
  chatSearchBar?.classList.add('hidden');
  contactPanelContent?.classList.remove('hidden');
  document.body.classList.toggle('hide-contact-panel', !appSettings.showContactPanel);
  conversationSearchButton?.classList.remove('active');
  conversationSearchButton?.setAttribute('aria-expanded', 'false');
  if (chatSearchInput) chatSearchInput.value = '';
  if (chatSearchCount) chatSearchCount.textContent = '';
  if (chatSearchSender) chatSearchSender.value = 'all';
  if (chatSearchDate) chatSearchDate.value = 'all';
}

function renderSavedChatMessages() {
  renderConversation();
}

function closeComposerPopovers() {
  stickerPicker?.classList.add('hidden');
  stickerButton?.setAttribute('aria-expanded', 'false');
  emojiPicker?.classList.add('hidden');
  emojiButton?.setAttribute('aria-expanded', 'false');
}

function clearComposerStatus() {
  window.clearTimeout(composerStatusTimer);
  composerStatusTimer = null;
  if (composerStatus) composerStatus.textContent = '';
}

function showComposerStatus(message, duration = 3500) {
  clearComposerStatus();
  if (!composerStatus) return;
  composerStatus.textContent = message;
  composerStatusTimer = window.setTimeout(clearComposerStatus, duration);
}

function renderComposerPreview() {
  if (!composerPreview || !composerPreviewContent) return;
  composerPreviewContent.replaceChildren();
  composerPreview.classList.toggle('hidden', !pendingAttachment);
  if (!pendingAttachment) return;

  if (pendingAttachment.type === 'image') {
    const image = document.createElement('img');
    image.src = pendingAttachment.dataUrl;
    image.alt = 'Xem trước ảnh đính kèm';
    const label = document.createElement('span');
    label.textContent = pendingAttachment.name || 'Ảnh đính kèm';
    composerPreviewContent.append(image, label);
  } else if (pendingAttachment.type === 'audio') {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = pendingAttachment.dataUrl;
    const label = document.createElement('span');
    label.textContent = `Tin nhắn thoại · ${formatRecordingTime(pendingAttachment.duration || 0)}`;
    composerPreviewContent.append(audio, label);
  } else if (pendingAttachment.type === 'video') {
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.src = pendingAttachment.dataUrl;
    const label = document.createElement('span');
    label.textContent = pendingAttachment.name || 'Video đính kèm';
    composerPreviewContent.append(video, label);
  } else if (pendingAttachment.type === 'document') {
    const card = buildDocumentCard(pendingAttachment);
    card.removeAttribute('href');
    card.removeAttribute('download');
    composerPreviewContent.append(card);
  } else if (pendingAttachment.type === 'sticker') {
    const sticker = document.createElement('span');
    sticker.className = 'composer-preview-sticker';
    sticker.textContent = pendingAttachment.sticker;
    const label = document.createElement('span');
    label.textContent = 'Nhãn dán';
    composerPreviewContent.append(sticker, label);
  }
}

function setPendingAttachment(attachment) {
  pendingAttachment = attachment;
  clearComposerStatus();
  renderComposerPreview();
  updateMessageSendState();
}

function clearPendingAttachment() {
  pendingAttachment = null;
  renderComposerPreview();
  if (messageImageInput) messageImageInput.value = '';
  updateMessageSendState();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Không thể đọc tệp'));
    reader.readAsDataURL(file);
  });
}

function formatRecordingTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function resetAudioRecorderUi() {
  window.clearInterval(audioRecordingTimer);
  audioRecordingTimer = null;
  audioRecording?.classList.add('hidden');
  audioRecordButton?.classList.remove('active');
  audioRecordButton?.setAttribute('aria-label', 'Ghi âm');
  if (audioRecordingTime) audioRecordingTime.textContent = '0:00';
}

function stopAudioRecording(discard = false) {
  if (!audioRecorder || audioRecorder.state === 'inactive') return;
  discardAudioRecording = discard;
  audioRecorder.stop();
}

async function startAudioRecording() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showComposerStatus('Trình duyệt này chưa hỗ trợ ghi âm.');
    return;
  }
  clearComposerStatus();
  clearPendingAttachment();
  closeComposerPopovers();
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    discardAudioRecording = false;
    audioRecorder = new MediaRecorder(audioStream);
    audioRecorder.addEventListener('dataavailable', event => {
      if (event.data?.size) audioChunks.push(event.data);
    });
    audioRecorder.addEventListener('stop', async () => {
      const duration = Date.now() - audioRecordingStartedAt;
      const shouldDiscard = discardAudioRecording;
      const mimeType = audioRecorder?.mimeType || 'audio/webm';
      audioStream?.getTracks().forEach(track => track.stop());
      audioStream = null;
      resetAudioRecorderUi();
      if (shouldDiscard) {
        audioChunks = [];
        showComposerStatus('Đã hủy đoạn ghi âm.');
        return;
      }
      const blob = new Blob(audioChunks, { type: mimeType });
      audioChunks = [];
      if (!blob.size) {
        showComposerStatus('Không thu được âm thanh. Hãy thử ghi lại.');
        return;
      }
      if (blob.size > 2 * 1024 * 1024) {
        showComposerStatus('Đoạn ghi âm quá lớn. Vui lòng ghi clip ngắn hơn 90 giây.');
        return;
      }
      const dataUrl = await readFileAsDataUrl(blob);
      setPendingAttachment({ type: 'audio', dataUrl, duration, name: `ghi-am-${Date.now()}.webm` });
    });
    audioRecorder.start(250);
    audioRecordingStartedAt = Date.now();
    audioRecording?.classList.remove('hidden');
    audioRecordButton?.classList.add('active');
    audioRecordButton?.setAttribute('aria-label', 'Dừng ghi âm');
    audioRecordingTimer = window.setInterval(() => {
      const duration = Date.now() - audioRecordingStartedAt;
      if (audioRecordingTime) audioRecordingTime.textContent = formatRecordingTime(duration);
      if (duration >= 90000) stopAudioRecording(false);
    }, 250);
  } catch {
    resetAudioRecorderUi();
    showComposerStatus('Không thể dùng micro. Hãy cho phép quyền micro rồi thử lại.');
  }
}

function updateMessageSendState() {
  if (messageSendButton) messageSendButton.disabled = !messageComposerInput?.value.trim() && !pendingAttachment;
}

async function sendRemoteMessage(conversation, text, attachment) {
  const conversationId = conversation.dataset.conversationId;
  const pending = {
    id: globalThis.crypto?.randomUUID?.() || `pending-${Date.now()}`,
    direction: 'outgoing',
    type: attachment?.type || 'text',
    text: text || '',
    createdAt: Date.now(),
    status: 'sending',
    ...(attachment ? { dataUrl: attachment.dataUrl, name: attachment.name || '', size: attachment.size || 0 } : {})
  };
  cacheRemoteMessage(conversationId, pending);
  renderConversation(conversation);
  try {
    const result = await readApiResponse(await fetch(`/api/messaging/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, attachment })
    }));
    // Drop the optimistic copy before caching the saved one. The stream may
    // already have delivered the same message under Meta's id, and leaving the
    // placeholder behind would show the reply twice.
    const messages = remoteMessages.get(conversationId) || [];
    const index = messages.findIndex(item => item.id === pending.id);
    if (index >= 0) messages.splice(index, 1);
    // Keep the local preview so an uploaded image still renders before Meta echoes its own URL.
    cacheRemoteMessage(conversationId, { ...result.message, dataUrl: result.message.dataUrl || pending.dataUrl || '' });
    if (result.conversation) applyRemoteConversation(result.conversation);
  } catch (error) {
    const messages = remoteMessages.get(conversationId) || [];
    const failed = messages.find(item => item.id === pending.id);
    if (failed) {
      failed.status = 'failed';
      failed.text = failed.text || 'Không gửi được';
    }
    showComposerStatus(error.message, 6000);
  }
  renderConversation(conversation);
  sortConversationsByRecentActivity();
  filterConversations();
  if (chatBody) chatBody.scrollTop = chatBody.scrollHeight;
}

function sendCurrentMessage() {
  const text = messageComposerInput?.value.trim();
  if (!text && !pendingAttachment) return;
  const activeConversation = getActiveConversation();
  const conversationName = getConversationName(activeConversation);
  if (!conversationName) return;
  if (activeConversation?.dataset.conversationId) {
    const attachment = pendingAttachment && pendingAttachment.type !== 'sticker' ? pendingAttachment : null;
    const outgoingText = pendingAttachment?.type === 'sticker' ? [text, pendingAttachment.sticker].filter(Boolean).join(' ') : text;
    messageComposerInput.value = '';
    clearMessageReply();
    clearPendingAttachment();
    updateMessageSendState();
    messageComposerInput.focus();
    sendRemoteMessage(activeConversation, outgoingText, attachment);
    return;
  }
  const replyTo = messageComposerInput?.dataset.replyTo
    ? {
        id: messageComposerInput.dataset.replyTo,
        name: messageComposerInput.dataset.replyName || conversationName,
        text: messageComposerInput.dataset.replyText || 'tin nhắn'
      }
    : null;
  const message = {
    id: globalThis.crypto?.randomUUID?.() || `message-${Date.now()}`,
    type: pendingAttachment?.type || 'text',
    text: text || '',
    createdAt: Date.now(),
    ...(pendingAttachment || {}),
    ...(replyTo ? { replyTo } : {})
  };
  appendChatMessage(message, 'outgoing', '', message.id);
  updateMessageGrouping();
  saveChatMessage(conversationName, message);
  messageComposerInput.value = '';
  clearMessageReply();
  clearPendingAttachment();
  updateMessageSendState();
  const preview = activeConversation?.querySelector('small');
  const time = activeConversation?.querySelector('time');
  if (preview) preview.textContent = `Bạn: ${getMessagePreview(message)}`;
  if (activeConversation) activeConversation.dataset.latestSentAt = String(message.createdAt);
  if (time) time.textContent = formatConversationActivityTime(message.createdAt);
  sortConversationsByRecentActivity();
  if (chatBody) chatBody.scrollTop = chatBody.scrollHeight;
  messageComposerInput.focus();
}

/** Message text as shown, without the pin and reaction badges layered on top. */
function getMessageRowText(row) {
  const bubble = row?.querySelector('.bubble');
  if (!bubble || bubble.classList.contains('bubble-recalled')) return '';
  if (row?.dataset.copyText !== undefined) return row.dataset.copyText.trim();
  const copy = bubble.cloneNode(true);
  copy.querySelectorAll('.message-pin-badge, .message-reaction').forEach(badge => badge.remove());
  return copy.textContent.trim();
}

async function copyMessageText(row) {
  const text = getMessageRowText(row);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showComposerStatus('Đã sao chép tin nhắn.');
  } catch {
    // The Clipboard API needs a secure context; fall back for plain HTTP.
    const carrier = document.createElement('textarea');
    carrier.value = text;
    carrier.setAttribute('readonly', '');
    carrier.style.position = 'fixed';
    carrier.style.opacity = '0';
    document.body.appendChild(carrier);
    carrier.select();
    const copied = document.execCommand('copy');
    carrier.remove();
    showComposerStatus(copied ? 'Đã sao chép tin nhắn.' : 'Trình duyệt không cho phép sao chép.');
  }
}

function closeChatMessageMenu() {
  const openRow = chatBody?.querySelector('.message-row.message-menu-open');
  openRow?.classList.remove('message-menu-open');
  openRow?.querySelector('.message-actions-menu')?.remove();
}

function closeMessageReactionPicker() {
  document.querySelector('.message-reaction-picker')?.remove();
  document.querySelector('.message-row.message-reaction-open')?.classList.remove('message-reaction-open');
}

function openMessageReactionPicker(row) {
  const name = getConversationName(getActiveConversation());
  const messageId = row?.dataset.messageId;
  if (!name || !messageId) return;
  const wasOpen = Boolean(row.querySelector('.message-reaction-picker'));
  closeMessageReactionPicker();
  closeChatMessageMenu();
  if (wasOpen) return;
  const picker = document.createElement('div');
  picker.className = 'message-reaction-picker';
  picker.setAttribute('role', 'menu');
  ['👍', '❤️', '😂', '😮', '😢', '😡'].forEach(reaction => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = reaction;
    button.setAttribute('aria-label', `Thả cảm xúc ${reaction}`);
    button.addEventListener('click', event => {
      event.stopPropagation();
      saveChatMessageReaction(name, messageId, reaction);
      renderConversation(getActiveConversation());
      // No toast here: reacting is a frequent, low-stakes action and a notice
      // on every tap is noise. The badge carries the explanation on hover.
    });
    picker.appendChild(button);
  });
  // The row stretches to 75% of the chat width whatever the bubble size, so
  // anchoring to its edge threw the picker far from the message. Centre it on
  // the bubble instead. It cannot live inside the bubble: media bubbles clip
  // their overflow to keep the rounded corners.
  // Float above the page rather than inside the chat body: the chat clips its
  // overflow, and the picker is wider than the gap left by the contact panel,
  // so anchoring it inside pushed it back over the bubble.
  document.body.appendChild(picker);
  row.classList.add('message-reaction-open');
  const reactButton = row.querySelector('[data-message-quick="react"]');
  if (reactButton) {
    const buttonBounds = reactButton.getBoundingClientRect();
    const pickerBounds = picker.getBoundingClientRect();
    const margin = 9;
    // Open away from the bubble: rightwards for incoming, leftwards for
    // outgoing. If that would run off screen, flip to the other side of the
    // button rather than sliding the picker away from it.
    const openRight = buttonBounds.left;
    const openLeft = buttonBounds.right - pickerBounds.width;
    const fits = candidate => candidate >= margin && candidate + pickerBounds.width <= window.innerWidth - margin;
    const preferred = row.classList.contains('outgoing') ? openLeft : openRight;
    const fallback = row.classList.contains('outgoing') ? openRight : openLeft;
    const wanted = fits(preferred) ? preferred : fits(fallback) ? fallback : preferred;
    const largestLeft = window.innerWidth - pickerBounds.width - margin;
    picker.style.left = `${Math.max(margin, Math.min(largestLeft, wanted))}px`;
    picker.style.top = `${Math.max(margin, buttonBounds.top - pickerBounds.height - 6.75)}px`;
  }
  picker.querySelector('button')?.focus();
}

function prepareMessageReply(row) {
  if (!messageComposerInput) return;
  const preview = row?.dataset.preview || 'tin nhắn';
  const customerName = getConversationName(getActiveConversation()) || 'khách hàng';
  const replyName = row?.classList.contains('incoming') ? customerName : 'Bạn';
  messageComposerInput.dataset.replyTo = row?.dataset.messageId || '';
  messageComposerInput.dataset.replyName = replyName;
  messageComposerInput.dataset.replyText = preview;
  messageComposerInput.placeholder = 'Aa';
  if (messageReplyTitle) messageReplyTitle.textContent = `Đang trả lời ${replyName}`;
  if (messageReplyText) messageReplyText.textContent = preview;
  messageReplyPreview?.classList.remove('hidden');
  messageComposerInput.focus();
  clearComposerStatus();
}

function clearMessageReply() {
  if (messageComposerInput) {
    delete messageComposerInput.dataset.replyTo;
    delete messageComposerInput.dataset.replyName;
    delete messageComposerInput.dataset.replyText;
    messageComposerInput.placeholder = 'Aa';
  }
  messageReplyPreview?.classList.add('hidden');
  if (messageReplyTitle) messageReplyTitle.textContent = 'Đang trả lời';
  if (messageReplyText) messageReplyText.textContent = '';
}

function prepareForwardMessage(row) {
  if (!messageComposerInput) return;
  messageComposerInput.value = row?.dataset.preview || '';
  messageComposerInput.dispatchEvent(new Event('input', { bubbles: true }));
  messageComposerInput.focus();
  showComposerStatus('Đã đưa nội dung vào ô soạn để chuyển tiếp.');
}

function syncConversationPreview(conversation = getActiveConversation()) {
  if (!conversation) return;
  const preview = conversation.querySelector('small');
  const time = conversation.querySelector('time');
  const visibleOutgoing = [...(chatBody?.querySelectorAll('.message-row.outgoing .bubble') || [])].at(-1);
  if (preview) {
    preview.textContent = visibleOutgoing
      ? `Bạn: ${visibleOutgoing.classList.contains('bubble-recalled') ? 'Đã thu hồi một tin nhắn' : visibleOutgoing.closest('.message-row')?.dataset.preview || visibleOutgoing.textContent}`
      : conversation.dataset.initialPreview;
  }
  if (time) time.textContent = visibleOutgoing ? 'Bây giờ' : conversation.dataset.initialTime;
}

function openChatMessageMenu(row) {
  const conversation = getActiveConversation();
  const name = getConversationName(conversation);
  const messageId = row?.dataset.messageId;
  if (!name || !messageId) return;
  hideMessageTimeTooltip();
  const wasOpen = row.classList.contains('message-menu-open');
  closeMessageReactionPicker();
  closeChatMessageMenu();
  if (wasOpen) return;

  const menu = document.createElement('div');
  menu.className = 'message-actions-menu';
  menu.setAttribute('role', 'menu');
  const isRecalled = row.querySelector('.bubble')?.classList.contains('bubble-recalled');
  const isOutgoing = row.classList.contains('outgoing');
  const isPinned = getPinnedChatMessages().has(getMessageStateKey(name, messageId));
  const actions = isRecalled
    ? [['deleted', 'Xóa']]
    : [
        ...(isOutgoing ? [['recalled', 'Thu hồi']] : []),
        ['forward', 'Chuyển tiếp'],
        // Only offer copying when there is text to copy.
        ...(getMessageRowText(row) ? [['copy', 'Sao chép']] : []),
        ['pin', isPinned ? 'Bỏ ghim' : 'Ghim'],
        ['report', 'Báo cáo']
      ];
  actions.forEach(([action, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (action === 'forward') {
        closeChatMessageMenu();
        prepareForwardMessage(row);
        return;
      }
      if (action === 'pin') {
        const pinned = togglePinnedChatMessage(name, messageId);
        saveChatMessage(name, {
          id: `system-${Date.now()}`,
          type: 'system',
          text: pinned ? 'Bạn đã ghim một tin nhắn' : 'Bạn đã bỏ ghim một tin nhắn',
          createdAt: Date.now()
        });
        closeChatMessageMenu();
        renderConversation(conversation);
        renderPinnedBanner();
        if (!chatPinnedPanel?.classList.contains('hidden')) renderPinnedPanel();
        return;
      }
      if (action === 'copy') {
        closeChatMessageMenu();
        copyMessageText(row);
        return;
      }
      if (action === 'report') {
        closeChatMessageMenu();
        showComposerStatus('Đã ghi nhận báo cáo cho tin nhắn này.');
        return;
      }
      saveChatMessageAction(name, messageId, action);
      closeChatMessageMenu();
      renderConversation(conversation);
      syncConversationPreview(conversation);
      // Meta gives Pages no way to unsend, so this only hides the bubble here.
      if (action === 'recalled' && isFacebookConversation(conversation)) {
        showComposerStatus('Đã ẩn tin nhắn trong CRM. Facebook không cho Page thu hồi nên khách vẫn thấy tin gốc.', 6000);
      }
    });
    menu.appendChild(button);
  });
  const quickActions = row.querySelector('.message-quick-actions');
  (quickActions || row).appendChild(menu);
  row.classList.add('message-menu-open');
  const chatRect = chatBody.getBoundingClientRect();
  const bubbleRect = row.querySelector('.bubble').getBoundingClientRect();
  menu.classList.toggle('message-actions-menu--above', bubbleRect.bottom + 237.5 > chatRect.bottom);
  menu.querySelector('button')?.focus();
}

function normalizeExportLocation(value) {
  const location = String(value ?? '').trim();
  return ({
    'Hồ Chí Minh': 'TP Hồ Chí Minh',
    'Thành phố Thanh Hoá': 'Thành phố Thanh Hóa'
  })[location] || location;
}

function getPreviewValue(value, header) {
  if (normalizeColumnName(header) !== 'san pham') return value;
  const text = String(value);
  const marker = text.match(/phân\s*loại\s*:\s*/iu) || text.match(/phan\s*loai\s*:\s*/i);
  return normalizeProductName(marker ? text.slice(marker.index + marker[0].length).trim() : text);
}

function normalizeProductName(value) {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const words = [
    ['combo', 'Combo'],
    ['granola', 'Granola'],
    ['túi', 'Túi'],
    ['tui', 'Túi'],
    ['vàng', 'Vàng'],
    ['vang', 'Vàng'],
    ['xanh', 'Xanh'],
    ['nâu', 'Nâu'],
    ['nau', 'Nâu'],
    ['klt', 'KLT']
  ];
  words.forEach(([source, replacement]) => {
    text = text.replace(new RegExp(`\\b${source}\\b`, 'giu'), replacement);
  });
  text = text.replace(/\bGranola\s+(?=(?:Xanh|Vàng|Nâu)\b)/giu, 'Túi ');
  text = text.replace(/\bTúi\s+Túi\b/giu, 'Túi');
  return text;
}

function normalizeImportedValue(value, header) {
  const text = String(value ?? '').trim();
  if (normalizeColumnName(header) === 'san pham') return normalizeProductName(text);
  if (normalizeColumnName(header) !== 'so dien thoai') return text;
  return text.replace(/^\+84(?:[\s-]*)/u, '0');
}

function getInvalidOrderRows(data = orderData) {
  const addressIndex = data.headers.findIndex(header => normalizeColumnName(header) === 'dia chi');
  if (addressIndex < 0) return [];
  return data.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => isInvalidOrderAddress(row[addressIndex]));
}

function getRecommendedOrderStage(data = orderData) {
  if (!data.rows.length) return 'import';
  return getOrdersNeedingProcessing(data).length ? 'process' : 'export';
}

function getDuplicateOrderRowIndexes(data = orderData) {
  const ignoredColumns = new Set(['stt', 'ma don hang']);
  const comparableIndexes = data.headers
    .map((header, index) => ({ index, name: normalizeColumnName(header) }))
    .filter(column => !ignoredColumns.has(column.name))
    .map(column => column.index);
  if (!comparableIndexes.length) return new Set();
  const indexesBySignature = new Map();
  data.rows.forEach((row, index) => {
    const signature = JSON.stringify(comparableIndexes.map(columnIndex =>
      String(row[columnIndex] ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi')
    ));
    const indexes = indexesBySignature.get(signature) || [];
    indexes.push(index);
    indexesBySignature.set(signature, indexes);
  });
  return new Set([...indexesBySignature.values()].filter(indexes => indexes.length > 1).flat());
}

function getDuplicatePhoneRowIndexes(data = orderData) {
  const phoneIndex = data.headers.findIndex(header => ['so dien thoai', 'sdt', 'dien thoai'].includes(normalizeColumnName(header)));
  if (phoneIndex < 0) return new Set();
  const indexesByPhone = new Map();
  data.rows.forEach((row, index) => {
    let phone = String(row[phoneIndex] ?? '').replace(/\D/g, '');
    if (phone.startsWith('84')) phone = `0${phone.slice(2)}`;
    if (!phone) return;
    const indexes = indexesByPhone.get(phone) || [];
    indexes.push(index);
    indexesByPhone.set(phone, indexes);
  });
  return new Set([...indexesByPhone.values()].filter(indexes => indexes.length > 1).flat());
}

function getOrdersNeedingProcessing(data = orderData) {
  const invalidRowIndexes = new Set(getInvalidOrderRows(data).map(entry => entry.index));
  const duplicateRowIndexes = getDuplicateOrderRowIndexes(data);
  const duplicatePhoneRowIndexes = getDuplicatePhoneRowIndexes(data);
  return data.rows
    .map((row, index) => ({ row, index }))
    .filter(({ index }) => invalidRowIndexes.has(index)
      || duplicateRowIndexes.has(index)
      || duplicatePhoneRowIndexes.has(index));
}

function isInvalidOrderAddress(value) {
  return String(value ?? '').trim().toUpperCase().startsWith('GXN');
}

function renderPreviewCell(value, header) {
  const previewValue = getPreviewValue(value, header);
  const column = normalizeColumnName(header);
  if (column === 'don gia') {
    const price = String(previewValue ?? '').trim();
    return price && !/[đ₫]$/iu.test(price) ? `${escapeHtml(price)} đ` : escapeHtml(price);
  }
  if (column === 'san pham') {
    const productName = normalizeColumnName(previewValue);
    const isSingleBag = productName.includes('1 tui');
    const imageName = productName.includes('combo 2') && productName.includes('xanh') ? 'combo2_green'
      : productName.includes('combo 2') && productName.includes('vang') ? 'combo2_yellow'
      : productName.includes('combo 3') && productName.includes('xanh') ? 'combo3_green'
        : productName.includes('combo 3') && productName.includes('vang') ? 'combo3_yellow'
          : isSingleBag && productName.includes('xanh') ? 'product_green'
            : isSingleBag && productName.includes('vang') ? 'product_yellow'
              : isSingleBag && productName.includes('nau') ? 'product_brown' : '';
    if (imageName) {
      const imageAlt = ({
        combo2_green: 'Combo 2 Túi Xanh',
        combo2_yellow: 'Combo 2 Túi Vàng',
        combo3_green: 'Combo 3 Túi Xanh',
        combo3_yellow: 'Combo 3 Túi Vàng',
        product_green: '1 Túi Xanh',
        product_yellow: '1 Túi Vàng',
        product_brown: '1 Túi Nâu'
      })[imageName];
      const imageClass = imageName.startsWith('combo2_') ? ' product-image--combo2' : imageName.startsWith('combo3_') ? ' product-image--combo3' : '';
      return `<span class="product-with-image">${escapeHtml(previewValue)}<img class="${imageClass.trim()}" src="/assets/logos/${imageName}.png" alt="${imageAlt}"></span>`;
    }
  }
  const network = normalizeColumnName(previewValue);
  if (column === 'nha mang' && network === 'i telecom') {
    return '<img class="network-logo network-logo--itel" src="/assets/logos/itel-hq.png" alt="iTel">';
  }
  if (column === 'nha mang' && ['viettel', 'mobifone', 'vinaphone'].includes(network)) {
    const label = network === 'viettel' ? 'Viettel' : network === 'mobifone' ? 'Mobifone' : 'Vinaphone';
    if (network === 'vinaphone') {
      return `<span class="network-logo network-logo--vinaphone"><img src="/assets/logos/${network}.png" alt="${label}"></span>`;
    }
    if (network === 'viettel') {
      return `<span class="network-logo network-logo--viettel"><img src="/assets/logos/${network}.png?v=3" alt="${label}"></span>`;
    }
    const logoClass = network === 'mobifone' ? ' network-logo--mobifone' : '';
    return `<img class="network-logo${logoClass}" src="/assets/logos/${network}.png" alt="${label}">`;
  }
  return escapeHtml(previewValue);
}

function renderOrderTable(preview, headers, rowEntries, emptyMessage, rowClassName = () => '') {
  if (!rowEntries.length) {
    preview.innerHTML = `<p>${escapeHtml(emptyMessage)}</p>`;
    return;
  }
  const visibleColumns = headers
    .map((header, index) => ({ index, name: normalizeColumnName(header) }))
    .filter(column => !hiddenPreviewColumns.has(column.name));
  const productColumn = visibleColumns.find(column => column.name === 'san pham');
  let orderedColumns = visibleColumns.filter(column => column !== productColumn);
  if (productColumn) {
    const carrierPosition = orderedColumns.findIndex(column => column.name === 'nha mang');
    const addressPosition = orderedColumns.findIndex(column => column.name === 'dia chi');
    const insertPosition = carrierPosition >= 0 && (addressPosition < 0 || carrierPosition < addressPosition)
      ? carrierPosition + 1
      : addressPosition >= 0 ? addressPosition : orderedColumns.length;
    orderedColumns.splice(insertPosition, 0, productColumn);
  }
  const trailingColumnNames = ['so luong', 'don gia', 'dia chi'];
  const trailingColumns = trailingColumnNames
    .map(name => orderedColumns.find(column => column.name === name))
    .filter(Boolean);
  orderedColumns = orderedColumns
    .filter(column => !trailingColumnNames.includes(column.name))
    .concat(trailingColumns);
  const visibleIndexes = orderedColumns.map(column => column.index);
  const columnTemplate = orderedColumns.map(column => column.name === 'dia chi' ? 'minmax(360px, 1fr)' : column.name === 'san pham' ? 'minmax(180px, max-content)' : 'max-content').join(' ');
  const previewClassName = index => {
    const columnName = normalizeColumnName(headers[index]);
    return columnName === 'dia chi' ? 'preview-address'
      : columnName === 'so luong' ? 'preview-quantity'
        : columnName === 'so dien thoai' ? 'preview-phone' : '';
  };
  const previewHeaderClassName = index => normalizeColumnName(headers[index]) === 'san pham'
    ? `${previewClassName(index)} preview-product-heading`.trim()
    : previewClassName(index);
  const head = visibleIndexes.map(index => `<th class="${previewHeaderClassName(index)}">${escapeHtml(headers[index])}</th>`).join('');
  const body = rowEntries.map(entry => `<tr class="${rowClassName(entry)}">${visibleIndexes.map(index => `<td class="${previewClassName(index)}">${renderPreviewCell(entry.row[index] || '', headers[index])}</td>`).join('')}</tr>`).join('');
  preview.innerHTML = `<table style="--preview-template: ${columnTemplate}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderOrderData() {
  const { headers } = orderData;
  let { rows } = orderData;
  if (rows.length) {
    orderData.rows = rows.map(row => row.map((value, index) => normalizeImportedValue(value, headers[index])));
    rows = orderData.rows;
    localStorage.setItem('crm-orders', JSON.stringify(orderData));
  }
  const allRows = rows.map((row, index) => ({ row, index }));
  const invalidRows = getInvalidOrderRows();
  const invalidRowIndexes = new Set(invalidRows.map(entry => entry.index));
  const duplicateRowIndexes = getDuplicateOrderRowIndexes();
  const duplicatePhoneRowIndexes = getDuplicatePhoneRowIndexes();
  const processingRows = allRows.filter(({ index }) => invalidRowIndexes.has(index)
    || duplicateRowIndexes.has(index)
    || duplicatePhoneRowIndexes.has(index));
  const processingRowIndexes = new Set(processingRows.map(entry => entry.index));
  const filterValue = orderFilter?.value || 'all';
  let importRows = filterValue === 'valid' ? allRows.filter(entry => !processingRowIndexes.has(entry.index))
    : filterValue === 'invalid' ? processingRows
      : filterValue === 'duplicate' ? allRows.filter(entry => duplicateRowIndexes.has(entry.index))
        : filterValue === 'duplicate-phone' ? allRows.filter(entry => duplicatePhoneRowIndexes.has(entry.index))
          : allRows;
  const searchValue = normalizeColumnName(orderSearch?.value || '');
  if (searchValue) {
    importRows = importRows.filter(entry => normalizeColumnName(entry.row.join(' ')).includes(searchValue));
  }
  renderExportPreview();
  orderExport.disabled = buildExportRows().length === 0;

  renderOrderTable(
    document.querySelector('#order-import-preview'), headers, importRows,
    rows.length ? 'Không tìm thấy đơn hàng phù hợp.' : 'Import một tệp CSV hoặc XLSX để xem toàn bộ dữ liệu.',
    ({ index }) => duplicateRowIndexes.has(index)
      ? 'order-row-duplicate'
      : duplicatePhoneRowIndexes.has(index) ? 'order-row-duplicate-phone' : ''
  );
  renderOrderTable(
    document.querySelector('#order-preview'), headers, processingRows,
    'Không có đơn hàng cần xử lý.', ({ index }) => duplicateRowIndexes.has(index)
      ? 'order-row-duplicate'
      : duplicatePhoneRowIndexes.has(index) ? 'order-row-duplicate-phone' : 'order-row-invalid'
  );
}

const exportColumns = [
  'STT*', 'Mã đơn hàng', 'Nguồn đơn hàng', 'Ngày đặt hàng', 'Tác động tồn kho', 'Gửi email thông báo',
  'Giá đã bao gồm thuế', 'Trạng thái thanh toán', 'Phương thức thanh toán', 'Trạng thái giao hàng',
  'Hình thức giao hàng', 'Đối tác vận chuyển', 'Phí giao hàng', 'Giảm giá đơn hàng', '', '', 'Mã phiên bản',
  'Tên sản phẩm', 'Tên phiên bản', 'SKU', 'Đơn vị', 'Số lượng*', 'Giá bán', 'Giảm giá sản phẩm', 'Khối lượng',
  'Yêu cầu vận chuyển', 'Ghi chú sản phẩm', 'Nhãn hiệu', 'Thuế', '', 'Số điện thoại', 'Email', 'Họ khách hàng',
  'Tên khách hàng', 'SĐT giao hàng', 'Địa chỉ', 'Tỉnh thành', 'Quận huyện', 'Phường xã', 'SĐT nhân viên phụ trách',
  'Ghi chú', 'Tags', 'Tham chiếu'
];
const exportHeaderFills = [0,3,2,3,2,3,2,3,2,3,3,3,3,3,0,0,3,3,3,2,3,2,2,3,2,4,3,3,3,0,3,3,3,2,2,2,2,2,2,3,3,3,3];
const exportPreviewIndexes = [0,2,4,6,8,19,21,22,24,28,33,34,35,36,37,38];
const exportPreviewGroups = [
  { label:'STT', span:1, fill:2, rowspan:2 },
  { label:'Thông tin đơn hàng', span:4, fill:3 },
  { label:'Thông tin mua hàng', span:5, fill:3 },
  { label:'Địa chỉ giao hàng', span:6, fill:3 }
];
const exportPreviewWidths = [55,130,135,155,165,175,95,110,105,105,165,145,255,145,155,145];

const skuWeights = {
  'GRA-VANG-H350': 400,
  'GRA-XANH-Z450': 500,
  'GRA-NAU-Z350': 400,
  'GRA-NAU-G35': 35,
  'GRA-XANH-G35': 35,
  'GRA-CAM-G30': 30,
  'HT-YM-T500': 500,
  'YM-VO-T500': 500,
  'HU-300ML': 10,
  'BGD': 10,
  'MUONG': 10
};

const skuPrices = {
  'GRA-NAU-Z350': { single:179000, combo:144000 },
  'GRA-VANG-H350': { single:189000, combo:149000 },
  'GRA-XANH-Z450': { single:189000, combo:149000 }
};

function normalizeSkuToken(symbol) {
  return String(symbol || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function getSkuPrice(sku, isCombo, fallbackPrice) {
  const configuredPrice = skuPrices[sku];
  if (configuredPrice) return isCombo ? configuredPrice.combo : configuredPrice.single;
  return Number(fallbackPrice) || 0;
}

function getOatUnitPrice(bagCount, descriptor, orderPrice) {
  const normalizedDescriptor = normalizeSkuToken(descriptor);
  const calculatedPrice = bagCount ? Math.round((Number(orderPrice) || 0) / bagCount) : 0;
  if (bagCount === 2) {
    if (normalizedDescriptor.includes('SHIP') || (calculatedPrice > 0 && calculatedPrice <= 60000)) return 58000;
    return 65500;
  }
  if (bagCount === 4) return 55500;
  if (bagCount === 6) return 49800;
  return calculatedPrice;
}

function mapSingleSku(symbol) {
  const value = String(symbol || '').trim();
  const upper = normalizeSkuToken(value);
  if (upper === 'HU-300ML' || upper.includes('HU 300ML')) return 'HU-300ML';
  if (upper === 'HT-YM-T500' || (upper.includes('YEN MACH') && upper.includes('CAN DET'))) return 'HT-YM-T500';
  if (upper === 'YM-VO-T500' || (upper.includes('YEN MACH') && upper.includes('CAN VO'))) return 'YM-VO-T500';
  if (upper.endsWith('G35') && upper.includes('NAU')) return 'GRA-NAU-G35';
  if (upper.endsWith('G35') && upper.includes('XANH')) return 'GRA-XANH-G35';
  if (upper.endsWith('G30') && upper.includes('CAM')) return 'GRA-CAM-G30';
  if (upper.includes('VANGG') || upper.includes('VANG')) return 'GRA-VANG-H350';
  if (upper.includes('XANH')) return 'GRA-XANH-Z450';
  if (upper.includes('NAU')) return 'GRA-NAU-Z350';
  if (upper === 'BGD') return 'BGD';
  if (upper === 'M' || upper === 'MUONG') return 'MUONG';
  return value;
}

function splitSkuForExport(symbol, orderQuantity, orderPrice, useComboPricing = false, productLabel = '') {
  const raw = String(symbol || productLabel || '').trim();
  const quantity = Math.max(1, Number(orderQuantity) || 1);
  const price = Number(orderPrice) || 0;
  if (!raw) return [{ sku:'', quantity, price }];

  const parts = raw.split('+').map(part => part.trim()).filter(Boolean);
  const comboMatch = parts[0].match(/^CB\s*(\d+)\s*(?:-|\s)\s*(.*)$/i);
  const descriptor = `${raw} ${productLabel}`;
  const normalizedDescriptor = normalizeSkuToken(descriptor);
  const kgMatch = normalizedDescriptor.match(/\b([123])\s*KG\b/);
  const oatBundleMatch = normalizeSkuToken(raw).match(/^CB\s*(\d+)\s*(?:-|\s)\s*(HT-YM-T500|YM-VO-T500)$/);
  const isMixedOat = normalizeSkuToken(raw) === 'CB-YM-DET+VO'
    || (normalizedDescriptor.includes('CAN DET') && normalizedDescriptor.includes('CAN VO'))
    || (normalizedDescriptor.includes('HT-YM-T500') && normalizedDescriptor.includes('YM-VO-T500'));

  if (comboMatch && Number(comboMatch[1]) === 10 && comboMatch[2].toUpperCase() === 'MIX') {
    const unitPrice = Math.round(price / 10);
    return [
      { sku:'GRA-NAU-G35', quantity:3 * quantity, price:unitPrice },
      { sku:'GRA-XANH-G35', quantity:4 * quantity, price:unitPrice },
      { sku:'GRA-CAM-G30', quantity:3 * quantity, price:unitPrice }
    ];
  }

  if (isMixedOat) {
    const kilograms = kgMatch ? Number(kgMatch[1]) : 1;
    const totalBags = comboMatch ? Number(comboMatch[1]) : kilograms * 2;
    const itemQuantity = Math.max(1, Math.round(totalBags / 2)) * quantity;
    const unitPrice = totalBags === 2 ? 58000 : getOatUnitPrice(totalBags, descriptor, price);
    return [
      { sku:'HT-YM-T500', quantity:itemQuantity, price:unitPrice },
      { sku:'YM-VO-T500', quantity:itemQuantity, price:unitPrice },
      { sku:'HU-300ML', quantity:Math.max(1, Math.round(totalBags / 2)) * quantity, price:0 }
    ];
  }

  const directOatSku = mapSingleSku(raw);
  const oatBagCount = oatBundleMatch
    ? Number(oatBundleMatch[1])
    : (kgMatch && (directOatSku === 'HT-YM-T500' || directOatSku === 'YM-VO-T500') ? Number(kgMatch[1]) * 2 : 0);
  if (oatBagCount && (directOatSku === 'HT-YM-T500' || directOatSku === 'YM-VO-T500' || oatBundleMatch)) {
    const oatSku = oatBundleMatch ? oatBundleMatch[2] : directOatSku;
    return [
      { sku:oatSku, quantity:oatBagCount * quantity, price:getOatUnitPrice(oatBagCount, descriptor, price) },
      { sku:'HU-300ML', quantity:Math.max(1, Math.round(oatBagCount / 2)) * quantity, price:0 }
    ];
  }

  if (comboMatch) {
    const baseSku = mapSingleSku(comboMatch[2]);
    if (baseSku && (skuWeights[baseSku] !== undefined || baseSku !== comboMatch[2])) {
      const multiplier = Number(comboMatch[1]);
      const extraSkus = parts.slice(1).map(mapSingleSku);
      const productSkus = [baseSku, ...extraSkus.filter(sku => skuPrices[sku])];
      const giftSkus = extraSkus.filter(sku => !skuPrices[sku]);
      const totalUnits = multiplier * quantity;
      const items = productSkus.map((sku, index) => {
        const itemQuantity = productSkus.length === 1
          ? totalUnits
          : (index === 0 ? totalUnits - quantity * (productSkus.length - 1) : quantity);
        return {
          sku,
          quantity:Math.max(quantity, itemQuantity),
          price:getSkuPrice(sku, true, Math.round(price / multiplier))
        };
      });
      giftSkus.forEach(giftSku => {
        if (!items.some(item => item.sku === giftSku)) items.push({ sku:giftSku, quantity, price:0 });
      });
      if (multiplier === 3) {
        ['BGD', 'MUONG'].forEach(giftSku => {
          if (!items.some(item => item.sku === giftSku)) items.push({ sku:giftSku, quantity, price:0 });
        });
      }
      return items;
    }
  }

  if (parts.length > 1) {
    const mappedParts = parts.map(part => mapSingleSku(part.replace(/^CB-/i, '')));
    const allMapped = mappedParts.every(sku => sku && (skuWeights[sku] !== undefined || skuPrices[sku]));
    if (allMapped) {
      const productSkus = mappedParts.filter(sku => sku !== 'BGD' && sku !== 'MUONG');
      const fallbackPrice = productSkus.length ? Math.round(price / productSkus.length) : 0;
      return mappedParts.map(sku => ({
        sku,
        quantity,
        price:sku === 'BGD' || sku === 'MUONG' ? 0 : getSkuPrice(sku, true, fallbackPrice)
      }));
    }
  }

  const singleSku = mapSingleSku(raw);
  return [{ sku:singleSku, quantity, price:getSkuPrice(singleSku, useComboPricing, price) }];
}

function buildExportRows() {
  const sourceIndex = new Map(orderData.headers.map((header, index) => [normalizeColumnName(header), index]));
  const value = (row, header) => { const index = sourceIndex.get(normalizeColumnName(header)); return index === undefined ? '' : row[index] || ''; };
  const exportableRows = orderData.rows.filter(row => !isInvalidOrderAddress(value(row, 'Địa chỉ')));
  const outputRows = [];
  const seenOrders = new Set();
  const bagQuantityByOrder = new Map();
  let orderNumber = 0;

  exportableRows.forEach((row, rowIndex) => {
    const sourceOrderId = value(row, 'Mã đơn hàng');
    const orderKey = sourceOrderId ? `id:${sourceOrderId}` : `row:${rowIndex}`;
    const items = splitSkuForExport(
      value(row, 'Mã mẫu mã'),
      value(row, 'Số lượng'),
      value(row, 'Đơn giá'),
      false,
      value(row, 'Sản phẩm')
    );
    const bagQuantity = items
      .filter(item => skuPrices[item.sku])
      .reduce((total, item) => total + (Number(item.quantity) || 0), 0);
    bagQuantityByOrder.set(orderKey, (bagQuantityByOrder.get(orderKey) || 0) + bagQuantity);
  });

  exportableRows.forEach((row, rowIndex) => {
    const phone = value(row, 'Số điện thoại');
    const sourceOrderId = value(row, 'Mã đơn hàng');
    const orderKey = sourceOrderId ? `id:${sourceOrderId}` : `row:${rowIndex}`;
    const isFirstOrderLine = !seenOrders.has(orderKey);
    if (isFirstOrderLine) {
      seenOrders.add(orderKey);
      orderNumber += 1;
    }

    const items = splitSkuForExport(
      value(row, 'Mã mẫu mã'),
      value(row, 'Số lượng'),
      value(row, 'Đơn giá'),
      (bagQuantityByOrder.get(orderKey) || 0) >= 2,
      value(row, 'Sản phẩm')
    );
    items.forEach((item, itemIndex) => {
      const isFirstExportLine = isFirstOrderLine && itemIndex === 0;
      const output = Array(exportColumns.length).fill('');
      if (isFirstExportLine) {
        output[0] = orderNumber;
        output[2] = 'Facebook';
        output[4] = 'Có';
        output[6] = 'Có';
        output[8] = 'Thanh toán COD';
        output[28] = '8%';
        output[30] = phone;
        output[33] = value(row, 'Khách hàng');
        output[34] = phone;
        output[35] = value(row, 'Địa chỉ');
        output[36] = normalizeExportLocation(value(row, 'Tỉnh/Thành phố'));
        output[37] = normalizeExportLocation(value(row, 'Quận/Huyện'));
        output[38] = normalizeExportLocation(value(row, 'Phường/Xã'));
      }
      output[19] = item.sku;
      output[21] = item.quantity;
      output[22] = item.price;
      output[24] = skuWeights[item.sku] ?? '';
      outputRows.push(output);
    });
  });
  return outputRows;
}

function renderExportPreview() {
  const preview = document.querySelector('#order-export-preview');
  if (!preview) return;
  const rows = buildExportRows();
  if (!rows.length) {
    preview.innerHTML = '<p>Chưa có dữ liệu xuất.</p>';
    return;
  }
  const groupHead = exportPreviewGroups.map(group => `<th class="export-fill-${group.fill}" colspan="${group.span}"${group.rowspan ? ` rowspan="${group.rowspan}"` : ''}>${escapeHtml(group.label)}</th>`).join('');
  const columnHead = exportPreviewIndexes.filter(index => index !== 0).map(index => {
    const label = index === 28 ? 'Thuế (Tỷ lệ)' : exportColumns[index];
    return `<th class="export-fill-${exportHeaderFills[index]}">${escapeHtml(label)}</th>`;
  }).join('');
  const tableWidth = exportPreviewWidths.reduce((total, width) => total + width, 0);
  const columns = exportPreviewWidths.map(width => `<col style="width:${width}px">`).join('');
  const body = rows.map(row => `<tr>${exportPreviewIndexes.map(index => `<td>${escapeHtml(row[index])}</td>`).join('')}</tr>`).join('');
  preview.innerHTML = `<table class="export-template-table" style="width:${tableWidth}px"><colgroup>${columns}</colgroup><thead><tr class="export-group-row">${groupHead}</tr><tr>${columnHead}</tr></thead><tbody>${body}</tbody></table>`;
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggle.textContent = collapsed ? '›' : '‹';
  sidebarToggle.title = collapsed ? 'Mở rộng' : 'Thu gọn';
  sidebarToggle.setAttribute('aria-label', sidebarToggle.title);
  localStorage.setItem('crm-sidebar-collapsed', String(collapsed));
}

sidebarToggle.onclick = () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  setSidebarCollapsed(collapsed);
  appSettings.collapseSidebar = collapsed;
  saveAppSettings();
};
setSidebarCollapsed(appSettings.collapseSidebar);
applyAppSettings();

navItems.forEach(item => {
  item.onclick = () => item.dataset.view === 'orders' ? showOrderStage(getRecommendedOrderStage()) : showView(item.dataset.view);
});

shippingTrackingForm?.addEventListener('submit', event => {
  event.preventDefault();
  lookupSpxTracking(shippingTrackingInput?.value);
});
shippingRecentList?.addEventListener('click', event => {
  const item = event.target.closest('[data-tracking-number]');
  if (!item) return;
  lookupSpxTracking(item.dataset.trackingNumber);
});
shippingClearHistory?.addEventListener('click', () => {
  localStorage.removeItem(shippingHistoryKey);
  renderShippingHistory();
});

settingsForm?.addEventListener('submit', event => {
  event.preventDefault();
  appSettings = {
    displayName: settingsDisplayName?.value.trim() || 'Huy Facebook',
    sendWithEnter: Boolean(settingsSendEnter?.checked),
    showContactPanel: Boolean(settingsShowContact?.checked),
    collapseSidebar: Boolean(settingsCollapseSidebar?.checked)
  };
  saveAppSettings();
  applyAppSettings();
  setSidebarCollapsed(appSettings.collapseSidebar);
  if (settingsStatus) settingsStatus.textContent = 'Đã lưu cài đặt.';
});

facebookConnectButton?.addEventListener('click', beginFacebookConnection);
zaloConnectButton?.addEventListener('click', () => {
  showToast('Cần cấu hình ứng dụng Zalo Official Account trước khi kết nối.');
});
facebookPageConfirm?.addEventListener('click', confirmFacebookPages);
document.querySelectorAll('[data-close-channel-dialog]').forEach(button => button.addEventListener('click', closeFacebookPageDialog));
facebookPageOptions?.addEventListener('change', event => {
  if (!event.target.matches('input[type="checkbox"]')) return;
  if (facebookPageDialogStatus) facebookPageDialogStatus.textContent = '';
});
facebookChannelList?.addEventListener('click', async event => {
  const actionButton = event.target.closest('[data-channel-action]');
  const channelItem = actionButton?.closest('[data-channel-id]');
  if (!actionButton || !channelItem) return;
  const pageId = channelItem.dataset.channelId;
  const pageName = channelItem.querySelector('.channel-item-copy strong')?.textContent || 'Facebook Page';
  if (actionButton.dataset.channelAction === 'remove' && !window.confirm(`Ngắt kết nối “${pageName}”? Tin nhắn mới từ Page này sẽ không được đồng bộ.`)) return;
  actionButton.disabled = true;
  try {
    const endpoint = actionButton.dataset.channelAction === 'refresh'
      ? `/api/channels/facebook/${encodeURIComponent(pageId)}/refresh`
      : `/api/channels/facebook/${encodeURIComponent(pageId)}`;
    await readApiResponse(await fetch(endpoint, { method: actionButton.dataset.channelAction === 'refresh' ? 'POST' : 'DELETE' }));
    await loadFacebookChannels();
    showToast(actionButton.dataset.channelAction === 'refresh' ? 'Đã làm mới trạng thái Page.' : 'Đã ngắt kết nối Page.', 'success');
  } catch (error) {
    showToast(error.message);
  } finally {
    actionButton.disabled = false;
  }
});

orderStageButtons.forEach(button => {
  button.onclick = () => showOrderStage(button.dataset.orderStage);
});

settingsSectionButtons.forEach(button => {
  button.onclick = () => showSettingsSection(button.dataset.settingsSection);
});

productCreateButton?.addEventListener('click', () => openProductDialog());
productSearch?.addEventListener('input', renderProducts);
document.querySelectorAll('[data-close-product-dialog]').forEach(button => button.addEventListener('click', closeProductDialog));
productImageInput?.addEventListener('change', async () => {
  const file = productImageInput.files?.[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    productFormStatus.textContent = 'Chỉ hỗ trợ ảnh PNG, JPG hoặc WebP.';
    productImageInput.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    productFormStatus.textContent = 'Ảnh sản phẩm phải nhỏ hơn 5 MB.';
    productImageInput.value = '';
    return;
  }
  try {
    pendingProductImage = await readImageFile(file);
    removeCurrentProductImage = false;
    productFormStatus.textContent = '';
    renderProductImagePreview(pendingProductImage);
  } catch (error) {
    productFormStatus.textContent = error.message;
  }
});
productImageRemove?.addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  pendingProductImage = '';
  removeCurrentProductImage = true;
  if (productImageInput) productImageInput.value = '';
  renderProductImagePreview();
});
productForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const payload = {
    name: productName.value.trim(),
    sku: productSku.value.trim(),
    originalPrice: Number(productOriginalPrice.value),
    salePrice: Number(productSalePrice.value),
    comboPrices: {
      ...(Number(productCombo2?.value) > 0 ? { 2: Number(productCombo2.value) } : {}),
      ...(Number(productCombo3?.value) > 0 ? { 3: Number(productCombo3.value) } : {})
    },
    mixGroup: productMixGroup?.value.trim() || '',
    active: productActive ? productActive.checked : true,
    aliases: productAliases?.value || '',
    imageData: pendingProductImage,
    removeImage: removeCurrentProductImage
  };
  productSubmit.disabled = true;
  productFormStatus.textContent = '';
  try {
    const endpoint = selectedProductId ? `/api/products/${encodeURIComponent(selectedProductId)}` : '/api/products';
    await readApiResponse(await fetch(endpoint, {
      method: selectedProductId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
    const wasEditing = Boolean(selectedProductId);
    closeProductDialog();
    await loadProducts();
    showToast(wasEditing ? 'Đã cập nhật sản phẩm.' : 'Đã thêm sản phẩm.', 'success');
  } catch (error) {
    productFormStatus.textContent = error.message || 'Chưa lưu được sản phẩm.';
  } finally {
    productSubmit.disabled = false;
  }
});
productList?.addEventListener('click', async event => {
  const action = event.target.closest('[data-product-action]');
  const row = action?.closest('[data-product-id]');
  const product = sharedProducts.find(item => item.id === row?.dataset.productId);
  if (!action || !product) return;
  if (action.dataset.productAction === 'edit') return openProductDialog(product);
  if (!window.confirm(`Xóa sản phẩm “${product.name}”? Sản phẩm sẽ không còn xuất hiện trong danh mục dùng chung.`)) return;
  action.disabled = true;
  try {
    await readApiResponse(await fetch(`/api/products/${encodeURIComponent(product.id)}`, { method: 'DELETE' }));
    await loadProducts();
    showToast('Đã xóa sản phẩm.', 'success');
  } catch (error) {
    action.disabled = false;
    showToast(error.message || 'Chưa xóa được sản phẩm.', 'error');
  }
});

customerProductName?.addEventListener('change', () => {
  const value = customerProductName.value.trim().toLocaleLowerCase('vi');
  const product = sharedProducts.find(item => item.name.toLocaleLowerCase('vi') === value || item.sku.toLocaleLowerCase('vi') === value);
  if (product) addCustomerDraftProduct(product.sku || product.name);
});

chatbotWorkspaceButtons.forEach(button => {
  button.addEventListener('click', () => {
    const workspace = button.dataset.chatbotWorkspace;
    chatbotWorkspaceButtons.forEach(item => item.classList.toggle('active', item === button));
    chatbotWorkspacePanels.forEach(panel => panel.classList.toggle('hidden', panel.dataset.chatbotWorkspacePanel !== workspace));
    if (workspace === 'processing' && !chatbotProcessingSteps.length) loadChatbotPipeline();
  });
});

chatbotTemplateSearch?.addEventListener('input', renderChatbotTemplateList);
chatbotTemplateList?.addEventListener('click', event => {
  const button = event.target.closest('[data-chatbot-template-id]');
  if (!button) return;
  selectedChatbotTemplate = button.dataset.chatbotTemplateId;
  renderChatbotTemplateList();
  renderChatbotTemplateEditor();
});

function closeChatbotTemplateCreator() {
  chatbotTemplateCreate?.classList.add('hidden');
  if (chatbotTemplateNewId) chatbotTemplateNewId.value = '';
}

chatbotTemplateAdd?.addEventListener('click', () => {
  chatbotTemplateCreate?.classList.remove('hidden');
  chatbotTemplateNewId?.focus();
});

chatbotTemplateCreateCancel?.addEventListener('click', closeChatbotTemplateCreator);

function createChatbotTemplate() {
  const id = String(chatbotTemplateNewId?.value || '').trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/Đ/g, 'D')
    .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!id) return showToast('Nhập mã cho mẫu tin nhắn mới.', 'error');
  if (Object.hasOwn(chatbotTemplatesState, id)) return showToast('Mã mẫu tin này đã tồn tại.', 'error');
  chatbotTemplatesState[id] = '';
  chatbotOriginalTemplates[id] = '';
  chatbotDeletedTemplateIds.delete(id);
  selectedChatbotTemplate = id;
  closeChatbotTemplateCreator();
  renderChatbotTemplateList();
  renderChatbotTemplateEditor();
  chatbotTemplateContent?.focus();
}

chatbotTemplateCreateConfirm?.addEventListener('click', createChatbotTemplate);
chatbotTemplateNewId?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    createChatbotTemplate();
  }
});

chatbotTemplateApply?.addEventListener('click', () => {
  if (!selectedChatbotTemplate) return;
  chatbotTemplatesState[selectedChatbotTemplate] = chatbotTemplateActive.checked ? chatbotTemplateContent.value.trim() : '';
  renderChatbotTemplateList();
});

chatbotTemplateReset?.addEventListener('click', () => {
  if (!selectedChatbotTemplate) return;
  chatbotTemplatesState[selectedChatbotTemplate] = chatbotOriginalTemplates[selectedChatbotTemplate] || '';
  renderChatbotTemplateList();
  renderChatbotTemplateEditor();
});

chatbotTemplateDelete?.addEventListener('click', () => {
  const id = selectedChatbotTemplate;
  if (!id) return;
  if (!window.confirm(`Xóa mẫu tin ${id}? Thao tác này không thể hoàn tác sau khi lưu.`)) return;
  delete chatbotTemplatesState[id];
  delete chatbotOriginalTemplates[id];
  chatbotDeletedTemplateIds.add(id);
  selectedChatbotTemplate = Object.keys(chatbotTemplatesState)[0] || '';
  renderChatbotTemplateList();
  renderChatbotTemplateEditor();
  chatbotSettingsForm?.requestSubmit();
});

function selectChatbotWorkflowStep(target) {
  const node = target.closest?.('[data-chatbot-step-node]');
  if (!node || target.matches?.('input')) return;
  selectedChatbotStep = node.dataset.chatbotStepNode;
  renderChatbotWorkflow();
  renderChatbotStepEditor();
  loadChatbotPipelineStep(selectedChatbotStep);
}

chatbotWorkflow?.addEventListener('click', event => selectChatbotWorkflowStep(event.target));
chatbotWorkflow?.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectChatbotWorkflowStep(event.target);
  }
});

chatbotStepCode?.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const start = chatbotStepCode.selectionStart;
  chatbotStepCode.setRangeText('  ', start, chatbotStepCode.selectionEnd, 'end');
  chatbotStepCode.dispatchEvent(new Event('input'));
});

chatbotSettingsForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter || chatbotSettingsForm.querySelector('button[type="submit"]');
  const submitLabel = submit.textContent;
  submit.disabled = true;
  submit.textContent = 'Đang lưu...';
  try {
    const settings = await readApiResponse(await fetch('/api/chatbot/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: chatbotSettingsEnabled.checked,
        responseMode: 'automatic',
        provider: chatbotSettingsProvider.value,
        directAuthType: chatbotSettingsAuthType.value,
        directProtocol: chatbotSettingsProtocol.value,
        directEndpoint: chatbotSettingsDirectEndpoint.value,
        directApiKey: chatbotSettingsDirectKey?.value || '',
        directModel: chatbotSettingsDirectModel.value,
        systemPrompt: chatbotSettingsSystemPrompt.value,
        memoryEnabled: chatbotSettingsMemoryEnabled.checked,
        memoryWindow: chatbotSettingsMemoryWindow.value,
        structuredOutput: chatbotSettingsStructuredOutput.checked,
        retryCount: chatbotSettingsRetryCount.value,
        retryIntervalMs: chatbotSettingsRetryInterval.value,
        welcomeMessage: chatbotSettingsWelcome.value,
        handoffKeywords: '',
        messageTemplates: chatbotTemplatesState,
        deletedTemplateIds: [...chatbotDeletedTemplateIds]
      })
    }));
    chatbotSettingsEnabled.checked = settings.enabled === true;
    if (chatbotSettingsDirectKey) chatbotSettingsDirectKey.value = '';
    const profile = getChatbotProviderProfile();
    if (chatbotSettingsDirectKey) chatbotSettingsDirectKey.placeholder = settings.directApiKeyConfigured ? 'Đã lưu – để trống nếu không thay đổi' : profile.keyPlaceholder;
    showToast('Đã lưu cấu hình AI thành công.', 'success');
  } catch (error) {
    showToast(error.message || 'Chưa lưu được thiết lập chatbot.', 'error');
  } finally {
    submit.disabled = false;
    submit.textContent = submitLabel;
  }
});

function appendInlinePreviewBubble(kind, text) {
  if (!chatbotPreviewResult) return null;
  chatbotPreviewResult.querySelector('.chatbot-preview-empty')?.remove();
  const bubble = document.createElement('div');
  bubble.className = kind === 'user' ? 'chatbot-preview-user' : 'chatbot-preview-bot';
  bubble.textContent = text;
  chatbotPreviewResult.appendChild(bubble);
  chatbotPreviewResult.scrollTop = chatbotPreviewResult.scrollHeight;
  return bubble;
}

chatbotPreviewReset?.addEventListener('click', () => {
  chatbotPreviewResult.innerHTML = '<div class="chatbot-preview-empty"><img src="/assets/icons/bot-chat.svg" alt=""><span>Nhập nội dung vào hộp bên dưới để bắt đầu gỡ lỗi Chatbot</span></div>';
  chatbotPreviewInput.value = '';
  chatbotPreviewHistory = [];
  chatbotPreviewInput.focus();
});

chatbotPreviewSend?.addEventListener('click', async () => {
  const message = chatbotPreviewInput.value.trim();
  if (!message) return;
  chatbotPreviewSend.disabled = true;
  appendInlinePreviewBubble('user', message);
  const pendingBubble = appendInlinePreviewBubble('bot', 'Đang xử lý…');
  chatbotPreviewInput.value = '';
  try {
    const result = await readApiResponse(await fetch('/api/chatbot/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: chatbotSettingsProvider.value, directEndpoint: chatbotSettingsDirectEndpoint.value, directModel: chatbotSettingsDirectModel.value, systemPrompt: chatbotSettingsSystemPrompt.value.trim() || 'Bạn là trợ lý chăm sóc khách hàng. Trả lời ngắn gọn, thân thiện bằng tiếng Việt.', structuredOutput: chatbotSettingsStructuredOutput.checked, directAuthType: 'access_token', message, recentMessages: chatbotPreviewHistory })
    }));
    const answerText = JSON.stringify(result.parsed || result.raw || {}, null, 2);
    if (pendingBubble) pendingBubble.textContent = answerText;
    chatbotPreviewHistory.push({ id: `preview-user-${Date.now()}`, direction: 'incoming', text: message }, { id: `preview-bot-${Date.now()}`, direction: 'outgoing', text: answerText });
  } catch (error) {
    if (pendingBubble) pendingBubble.textContent = `Test lỗi: ${error.message}`;
  } finally { chatbotPreviewSend.disabled = false; }
});

chatbotPreviewInput?.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  chatbotPreviewSend?.click();
});

chatbotPreviewOpen?.addEventListener('click', () => chatbotPreviewDialog?.showModal());
chatbotPreviewClose?.addEventListener('click', () => chatbotPreviewDialog?.close());
chatbotPreviewDialog?.addEventListener('click', event => { if (event.target === chatbotPreviewDialog) chatbotPreviewDialog.close(); });
chatbotPreviewDialogSend?.addEventListener('click', async () => {
  const message = chatbotPreviewDialogInput.value.trim();
  const chat = chatbotPreviewDialog.querySelector('.chatbot-preview-chat');
  if (!message) return;
  chatbotPreviewDialogSend.disabled = true;
  chat.innerHTML += `<div class="chatbot-preview-user">${escapeHtml(message)}</div><div class="chatbot-preview-bot">Đang xử lý…</div>`;
  try {
    const result = await readApiResponse(await fetch('/api/chatbot/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: chatbotSettingsProvider.value, directEndpoint: chatbotSettingsDirectEndpoint.value, directModel: chatbotSettingsDirectModel.value, systemPrompt: chatbotSettingsSystemPrompt.value.trim() || 'Bạn là trợ lý chăm sóc khách hàng. Trả lời bằng JSON hợp lệ.', structuredOutput: chatbotSettingsStructuredOutput.checked, directAuthType: 'access_token', message }) }));
    chat.lastElementChild.textContent = JSON.stringify(result.parsed || result.raw || {}, null, 2);
  } catch (error) { chat.lastElementChild.textContent = `Lỗi: ${error.message}`; }
  finally { chatbotPreviewDialogSend.disabled = false; }
});

function applyImportedRecords(sourceHeaders, records) {
  sourceHeaders = sourceHeaders.map((header, index) => String(header).trim() || `Cột ${index + 1}`);
  const retainedIndexes = sourceHeaders.map((_, index) => index);
  const headers = retainedIndexes.map(index => sourceHeaders[index]);
  const nonEmptyRows = records.filter(row => row.some(value => String(value ?? '').trim()));
  orderData = {
    headers,
    rows: nonEmptyRows.map(row => retainedIndexes.map(index => normalizeImportedValue(row[index] || '', sourceHeaders[index])))
  };
  localStorage.setItem('crm-orders', JSON.stringify(orderData));
  renderOrderData();
  showOrderStage(getRecommendedOrderStage());
}

orderImport.onchange = async () => {
  const file = orderImport.files[0];
  if (!file) return;
  try {
    if (file.name.toLowerCase().endsWith('.xlsx')) {
      const response = await fetch('/api/orders/import/xlsx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        body: file
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Không thể đọc tệp XLSX.');
      applyImportedRecords(result.headers || [], result.rows || []);
    } else {
      const records = parseCsv((await file.text()).replace(/^\uFEFF/, ''));
      applyImportedRecords(records.shift() || [], records);
    }
    recordOrderImport(file.name);
  } catch (error) {
    showToast(error.message);
  } finally {
    orderImport.value = '';
  }
};

orderHistoryButton.addEventListener('click', () => {
  const willOpen = orderHistoryPanel.classList.contains('hidden');
  orderHistoryPanel.classList.toggle('hidden', !willOpen);
  orderHistoryButton.setAttribute('aria-expanded', String(willOpen));
});

let orderSearchTimer;
orderSearch.addEventListener('input', () => {
  window.clearTimeout(orderSearchTimer);
  orderSearchTimer = window.setTimeout(renderOrderData, 120);
});
orderFilter.addEventListener('change', renderOrderData);

messageChannelTrigger?.addEventListener('click', event => {
  event.stopPropagation();
  const willOpen = messageChannelMenu?.classList.contains('hidden');
  messageChannelMenu?.classList.toggle('hidden', !willOpen);
  messageLabelMenu?.classList.add('hidden');
  messageChannelTrigger.setAttribute('aria-expanded', String(willOpen));
  messageLabelFilter?.setAttribute('aria-expanded', 'false');
});
messageChannelMenu?.addEventListener('click', event => {
  const option = event.target.closest('[data-message-channel]');
  if (!option) return;
  messageChannelMenu.classList.add('hidden');
  messageChannelTrigger?.setAttribute('aria-expanded', 'false');
  switchMessageChannel(option.dataset.messageChannel);
});
messageLabelFilter?.addEventListener('click', event => {
  event.stopPropagation();
  const willOpen = messageLabelMenu?.classList.contains('hidden');
  messageLabelMenu?.classList.toggle('hidden', !willOpen);
  messageChannelMenu?.classList.add('hidden');
  messageLabelFilter.setAttribute('aria-expanded', String(willOpen));
  messageChannelTrigger?.setAttribute('aria-expanded', 'false');
});
messageLabelMenu?.addEventListener('click', event => {
  const option = event.target.closest('[data-message-label]');
  if (!option) return;
  currentMessageLabel = option.dataset.messageLabel || 'all';
  messageLabelMenu.querySelectorAll('[data-message-label]').forEach(item => item.classList.toggle('active', item === option));
  messageLabelFilter.innerHTML = `${currentMessageLabel === 'all' ? 'Nhãn' : 'Nhãn (1)'} <span aria-hidden="true">▾</span>`;
  messageLabelFilter.classList.toggle('active', currentMessageLabel !== 'all');
  messageLabelMenu.classList.add('hidden');
  messageLabelFilter.setAttribute('aria-expanded', 'false');
  activateCurrentMessageChannel();
});
document.addEventListener('click', event => {
  if (!event.target.closest('.message-channel-picker')) {
    messageChannelMenu?.classList.add('hidden');
    messageChannelTrigger?.setAttribute('aria-expanded', 'false');
  }
  if (!event.target.closest('.message-label-picker')) {
    messageLabelMenu?.classList.add('hidden');
    messageLabelFilter?.setAttribute('aria-expanded', 'false');
  }
  if (!event.target.closest('#conversation-menu') && !event.target.closest('.conversation-more')) closeConversationMenu();
});

messageSearchInput?.addEventListener('input', filterConversations);
messageSearchInput?.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  messageSearchInput.value = '';
  filterConversations();
  messageSearchInput.blur();
});

conversationFilterButtons.forEach(button => {
  button.addEventListener('click', () => {
    currentConversationFilter = button.dataset.messageFilter || 'all';
    conversationFilterButtons.forEach(item => item.classList.toggle('active', item === button));
    filterConversations();
  });
});

conversationList?.addEventListener('click', event => {
  if (event.target.closest('.conversation-more')) return;
  const conversation = event.target.closest('.conversation');
  if (!conversation || !conversationList.contains(conversation)) return;
  selectConversation(conversation);
});

conversationList?.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target.closest('.conversation-more')) return;
  const conversation = event.target.closest('.conversation');
  if (!conversation || !conversationList.contains(conversation)) return;
  event.preventDefault();
  selectConversation(conversation);
});

conversationList?.addEventListener('scroll', closeConversationMenu);

conversationList?.addEventListener('click', event => {
  const trigger = event.target.closest('.conversation-more');
  if (!trigger) return;
  event.stopPropagation();
  const conversation = trigger.closest('.conversation');
  if (conversationMenuTarget === conversation) closeConversationMenu();
  else openConversationMenu(trigger);
});

conversationMenu?.addEventListener('click', event => {
  const item = event.target.closest('[data-conversation-action]');
  if (!item) return;
  event.stopPropagation();
  const conversation = conversationMenuTarget;
  closeConversationMenu();
  runConversationMenuAction(item.dataset.conversationAction, conversation);
});

window.addEventListener('resize', closeConversationMenu);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeConversationMenu();
});

markUnreadButton?.addEventListener('click', () => {
  const activeConversation = document.querySelector('.conversation.active');
  if (!activeConversation) return;
  activeConversation.classList.add('unread');
  if (activeConversation.dataset.conversationId) patchRemoteConversationFlags(activeConversation, { unread: true });
  else saveUnreadConversations();
  updateMarkUnreadButton();
  filterConversations();
});

messageImageInput?.addEventListener('change', async () => {
  const file = messageImageInput.files?.[0];
  if (!file) return;
  clearComposerStatus();
  closeComposerPopovers();
  const type = file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'image' : '';
  if (!type) {
    showComposerStatus('Vui lòng chọn một tệp ảnh hoặc video.');
    messageImageInput.value = '';
    return;
  }
  const sizeLimit = type === 'video' ? 20 * 1024 * 1024 : 2 * 1024 * 1024;
  if (file.size > sizeLimit) {
    showComposerStatus(type === 'video' ? 'Video quá lớn. Vui lòng chọn video dưới 20 MB.' : 'Ảnh quá lớn. Vui lòng chọn ảnh dưới 2 MB.');
    messageImageInput.value = '';
    return;
  }
  try {
    const dataUrl = await readFileAsDataUrl(file);
    setPendingAttachment({ type, dataUrl, name: file.name });
    messageComposerInput?.focus();
  } catch {
    showComposerStatus('Không thể đọc tệp này. Vui lòng chọn tệp khác.');
  }
});

chatHeadChatTab?.addEventListener('click', () => {
  currentChatHeadView = 'chat';
  renderConversation();
});

chatHeadFileTab?.addEventListener('click', () => {
  closeConversationSearch();
  closePinnedPanel();
  currentChatHeadView = 'files';
  renderConversationFiles();
});

chatHeadDocsTab?.addEventListener('click', () => {
  closeConversationSearch();
  closePinnedPanel();
  currentChatHeadView = 'docs';
  renderConversationDocs();
});

chatHeadPinnedTab?.addEventListener('click', () => {
  if (chatPinnedPanel?.classList.contains('hidden')) openPinnedPanel();
  else closePinnedPanel();
});

chatPinnedClose?.addEventListener('click', closePinnedPanel);
chatPinnedSearch?.addEventListener('input', () => renderPinnedPanel());
chatPinnedSearch?.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  closePinnedPanel();
  chatHeadPinnedTab?.focus();
});

messageDocumentInput?.addEventListener('change', async () => {
  const file = messageDocumentInput.files?.[0];
  if (!file) return;
  clearComposerStatus();
  closeComposerPopovers();
  if (file.size > 2 * 1024 * 1024) {
    showComposerStatus('Tài liệu quá lớn. Vui lòng chọn tệp dưới 2 MB.');
    messageDocumentInput.value = '';
    return;
  }
  try {
    const dataUrl = await readFileAsDataUrl(file);
    setPendingAttachment({ type: 'document', dataUrl, name: file.name, size: file.size });
    messageDocumentInput.value = '';
    updateMessageSendState();
    messageComposerInput?.focus();
  } catch {
    showComposerStatus('Không thể đọc tệp này. Vui lòng chọn tệp khác.');
  }
});

chatHeadAdd?.addEventListener('click', () => {
  currentChatHeadView = 'chat';
  renderConversation();
  messageImageInput?.click();
});

conversationSearchButton?.addEventListener('click', () => {
  if (chatSearchBar?.classList.contains('hidden')) openConversationSearch();
  else closeConversationSearch();
});

chatSearchInput?.addEventListener('input', updateConversationSearch);
chatSearchSender?.addEventListener('change', updateConversationSearch);
chatSearchDate?.addEventListener('change', updateConversationSearch);
chatSearchInput?.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeConversationSearch();
    conversationSearchButton?.focus();
  } else if (event.key === 'Enter' && conversationSearchMatches.length) {
    event.preventDefault();
    selectConversationSearchMatch(conversationSearchIndex + (event.shiftKey ? -1 : 1));
  }
});
chatSearchClose?.addEventListener('click', closeConversationSearch);

customerPanelTabs.forEach(tab => tab.addEventListener('click', () => setCustomerPanelTab(tab.dataset.customerTab)));

customerNoteInput?.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  const text = customerNoteInput.value.trim();
  const conversation = getActiveConversation();
  const key = getCustomerPanelKey(conversation);
  if (!text || !key) return;
  const notes = customerPanelStore.notes[key] || [];
  notes.unshift({ text, createdAt: Date.now() });
  customerPanelStore.notes[key] = notes.slice(0, 50);
  saveCustomerPanelStore();
  customerNoteInput.value = '';
  renderCustomerNotes();
  saveCustomerPanelChange(conversation, { type: 'note', text });
});

function addCustomerDraftProduct(query) {
  const raw = String(query || '').trim();
  if (!raw) {
    showToast('Nhập tên hoặc mã sản phẩm để thêm vào đơn.');
    return false;
  }
  const matched = findSharedProduct(raw);
  const existing = matched
    ? customerDraftProducts.find(item => item.sku && item.sku === matched.sku)
    : customerDraftProducts.find(item => item.name === raw);
  if (existing) {
    existing.quantity = Math.max(1, Number(existing.quantity) || 1) + 1;
  } else {
    customerDraftProducts.push({
      name: matched?.name || raw,
      sku: matched?.sku || '',
      variant: matched?.variant || matched?.category || '',
      image: matched?.image || getCustomerOrderProductImage(matched?.name || raw) || '',
      weight: Number(matched?.weight) || 0,
      quantity: 1,
      price: Math.max(0, Number(matched?.salePrice ?? matched?.originalPrice) || 0)
    });
  }
  if (customerProductName) customerProductName.value = '';
  renderCustomerDraftProducts();
  customerProductName?.focus();
  return true;
}

customerProductAddButton?.addEventListener('click', () => {
  addCustomerDraftProduct(customerProductName?.value);
});

customerProductName?.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  addCustomerDraftProduct(customerProductName.value);
});

customerProductCombo?.addEventListener('click', () => {
  if (!customerProductName) return;
  customerProductName.value = 'combo';
  customerProductName.focus();
  showToast('Đang lọc sản phẩm dạng combo trong kho.');
});

customerProductList?.addEventListener('click', event => {
  const button = event.target.closest('[data-remove-customer-product]');
  if (!button) return;
  customerDraftProducts.splice(Number(button.dataset.removeCustomerProduct), 1);
  renderCustomerDraftProducts();
});

customerProductList?.addEventListener('input', event => {
  const field = event.target.closest('[data-customer-quantity], [data-customer-price]');
  if (!field) return;
  const isQuantity = field.hasAttribute('data-customer-quantity');
  const index = Number(isQuantity ? field.dataset.customerQuantity : field.dataset.customerPrice);
  const item = customerDraftProducts[index];
  if (!item) return;
  if (isQuantity) item.quantity = Math.max(1, Math.round(Number(field.value) || 1));
  else item.price = Math.max(0, Math.round(Number(field.value) || 0));
  const row = field.closest('.customer-product-row');
  const totalCell = row?.querySelector('.cell-total');
  if (totalCell) totalCell.textContent = formatOrderMoney(item.quantity * item.price);
  updateCustomerOrderTotals();
});

customerOrderSavedAddress?.addEventListener('change', () => {
  if (!customerOrderSavedAddress.value || !customerOrderAddress) return;
  customerOrderAddress.value = customerOrderSavedAddress.value;
  updateCustomerOrderTotals();
});

customerOrderList?.addEventListener('click', event => {
  if (event.target.closest('#customer-order-create-new')) {
    setCustomerPanelTab('create');
    return;
  }
  const action = event.target.closest('[data-order-action]');
  if (!action) return;
  event.preventDefault();
  const labels = { note: 'Ghi chú đơn', share: 'Gửi lại xác nhận cho khách', edit: 'Sửa đơn' };
  showToast(`${labels[action.dataset.orderAction] || 'Thao tác'} — đơn ${action.dataset.orderId}. Chức năng này chưa được nối.`);
});

[customerOrderName, customerOrderPhone, customerOrderAddress, customerShippingFee, customerOrderDiscount]
  .filter(Boolean)
  .forEach(input => input.addEventListener('input', updateCustomerOrderTotals));
[customerOrderName, customerOrderPhone].filter(Boolean)
  .forEach(input => input.addEventListener('input', () => renderCustomerOrderChip()));
customerFreeShipping?.addEventListener('change', updateCustomerOrderTotals);
customerOrderReset?.addEventListener('click', () => resetCustomerOrderForm());

customerOrderForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const conversation = getActiveConversation();
  const key = getCustomerPanelKey(conversation);
  const totals = updateCustomerOrderTotals();
  if (!key || customerOrderSubmit?.disabled) {
    showToast('Điền đủ thông tin khách hàng và thêm ít nhất một sản phẩm.');
    return;
  }
  const now = Date.now();
  const order = {
    id: String(now).slice(-5),
    name: customerOrderName.value.trim(),
    phone: customerOrderPhone.value.trim(),
    address: customerOrderAddress.value.trim(),
    products: customerDraftProducts.map(item => ({ ...item, weight: getProductUnitWeight(item) })),
    status: 'Mới',
    source: customerOrderSource?.value || 'Facebook',
    payment: customerBankTransfer?.checked ? 'Chuyển khoản' : 'COD',
    freeShipping: Boolean(customerFreeShipping?.checked),
    shippingFee: totals.shipping,
    discount: totals.discount,
    total: totals.total,
    note: customerOrderNote?.value.trim() || '',
    createdAt: now,
    updatedAt: now,
    employee: appSettings.displayName || topbarUserName?.textContent || 'Bạn'
  };
  customerOrderSubmit.disabled = true;
  const originalLabel = customerOrderSubmit.textContent;
  customerOrderSubmit.textContent = 'Đang gửi...';
  try {
    const panel = await readApiResponse(await fetch(`/api/messaging/conversations/${encodeURIComponent(conversation.dataset.conversationId)}/customer-panel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'order', order })
    }));
    customerPanelStore.orders[key] = Array.isArray(panel.orders) ? panel.orders : [];
    saveCustomerPanelStore();
    renderCustomerOrders(conversation);
    await ensureRemoteMessages(conversation, { force: true });
    setCustomerPanelTab('info');
    showToast(`Đã gửi xác nhận cho khách và tạo đơn ${order.id}.`, 'success');
  } catch (error) {
    showToast(error.message || 'Chưa gửi được xác nhận cho khách. Đơn chưa được tạo.');
  } finally {
    customerOrderSubmit.textContent = originalLabel;
    updateCustomerOrderTotals();
  }
});

chatbotToggleButton?.addEventListener('click', async () => {
  const conversation = getActiveConversation();
  const conversationId = conversation?.dataset.conversationId;
  const key = getCustomerPanelKey(conversation);
  if (!key || chatbotToggleButton.disabled) return;
  const enabled = !Boolean(customerPanelStore.bots[key]);
  if (!conversationId) {
    customerPanelStore.bots[key] = enabled;
    saveCustomerPanelStore();
    renderChatbotToggle(conversation);
    showToast(enabled ? 'Đã bật bot cho hội thoại này.' : 'Đã tắt bot cho hội thoại này.', 'success');
    return;
  }
  chatbotToggleButton.disabled = true;
  try {
    const panel = await readApiResponse(await fetch(`/api/messaging/conversations/${encodeURIComponent(conversationId)}/customer-panel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bot', enabled })
    }));
    customerPanelStore.bots[key] = panel.botEnabled === true;
    saveCustomerPanelStore();
    renderChatbotToggle(conversation);
    showToast(panel.botEnabled ? 'Đã bật bot cho hội thoại này.' : 'Đã tắt bot cho hội thoại này.', 'success');
  } catch (error) {
    showToast(error.message || 'Chưa cập nhật được trạng thái bot.');
  } finally {
    chatbotToggleButton.disabled = false;
  }
});

contactInfoButton?.addEventListener('click', () => {
  if (!chatSearchBar?.classList.contains('hidden')) {
    closeConversationSearch();
    appSettings = { ...appSettings, showContactPanel: true };
    saveAppSettings();
    applyAppSettings();
    return;
  }
  appSettings = { ...appSettings, showContactPanel: !appSettings.showContactPanel };
  saveAppSettings();
  applyAppSettings();
});

stickerButton?.addEventListener('click', event => {
  event.stopPropagation();
  const willOpen = stickerPicker?.classList.contains('hidden');
  closeComposerPopovers();
  stickerPicker?.classList.toggle('hidden', !willOpen);
  stickerButton.setAttribute('aria-expanded', String(willOpen));
});
stickerPicker?.addEventListener('click', event => {
  event.stopPropagation();
  if (event.target.closest('[data-close-composer-popover]')) {
    closeComposerPopovers();
    return;
  }
  const option = event.target.closest('[data-sticker]');
  if (!option) return;
  setPendingAttachment({ type: 'sticker', sticker: option.dataset.sticker || '👍' });
  closeComposerPopovers();
});

emojiButton?.addEventListener('click', event => {
  event.stopPropagation();
  if (!messageComposerInput || messageComposerInput.disabled) return;
  const willOpen = emojiPicker?.classList.contains('hidden');
  closeComposerPopovers();
  emojiPicker?.classList.toggle('hidden', !willOpen);
  emojiButton.setAttribute('aria-expanded', String(willOpen));
});
emojiPicker?.addEventListener('click', event => {
  event.stopPropagation();
  if (event.target.closest('[data-close-composer-popover]')) {
    closeComposerPopovers();
    return;
  }
  const option = event.target.closest('[data-emoji]');
  if (!option || !messageComposerInput || messageComposerInput.disabled) return;
  const emoji = option.dataset.emoji || '😊';
  const start = messageComposerInput.selectionStart ?? messageComposerInput.value.length;
  const end = messageComposerInput.selectionEnd ?? start;
  messageComposerInput.setRangeText(emoji, start, end, 'end');
  messageComposerInput.dispatchEvent(new Event('input', { bubbles: true }));
  messageComposerInput.focus();
});

composerPreviewRemove?.addEventListener('click', () => {
  clearPendingAttachment();
  clearComposerStatus();
  messageComposerInput?.focus();
});
messageReplyClose?.addEventListener('click', () => {
  clearMessageReply();
  messageComposerInput?.focus();
});
audioRecordButton?.addEventListener('click', () => {
  if (audioRecorder?.state === 'recording') stopAudioRecording(false);
  else startAudioRecording();
});
audioRecordingStop?.addEventListener('click', () => stopAudioRecording(false));
audioRecordingCancel?.addEventListener('click', () => stopAudioRecording(true));

messageComposerInput?.addEventListener('input', updateMessageSendState);
messageComposerInput?.addEventListener('keydown', event => {
  if (!appSettings.sendWithEnter || event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  sendCurrentMessage();
});
messageSendButton?.addEventListener('click', sendCurrentMessage);
chatBody?.addEventListener('mousemove', event => {
  const row = event.target.closest('.message-row[data-hover-time]');
  if (!row) {
    hideMessageTimeTooltip();
    return;
  }
  if (row === messageTimeTooltipRow && messageTimeTooltip?.isConnected) return;
  showMessageTimeTooltip(row);
});
chatBody?.addEventListener('mouseleave', hideMessageTimeTooltip);
chatBody?.addEventListener('scroll', () => {
  hideMessageTimeTooltip();
  // The picker is fixed to the viewport, so it would drift away when scrolling.
  closeMessageReactionPicker();
}, { passive: true });
chatBody?.addEventListener('click', event => {
  const image = event.target.closest('.chat-image');
  if (image) {
    event.stopPropagation();
    openImageLightbox(image);
    return;
  }
  const video = event.target.closest('.chat-video');
  if (video) {
    event.stopPropagation();
    // Only enlarge a clip that is already playing, and ignore clicks that land
    // on the player controls along the bottom edge.
    const bounds = video.getBoundingClientRect();
    if (!video.paused && event.clientY < bounds.bottom - 45) openVideoLightbox(video);
    return;
  }
  const quickAction = event.target.closest('[data-message-quick]');
  if (quickAction) {
    event.stopPropagation();
    const row = quickAction.closest('.message-row');
    if (quickAction.dataset.messageQuick === 'more') openChatMessageMenu(row);
    if (quickAction.dataset.messageQuick === 'reply') prepareMessageReply(row);
    if (quickAction.dataset.messageQuick === 'react') openMessageReactionPicker(row);
    return;
  }
  const bubble = event.target.closest('.message-row .bubble');
  if (bubble) openChatMessageMenu(bubble.closest('.message-row'));
});
chatBody?.addEventListener('keydown', event => {
  if (!['Enter', ' '].includes(event.key)) return;
  const imageBubble = event.target.closest('.bubble-image');
  if (imageBubble) {
    event.preventDefault();
    openImageLightbox(imageBubble.querySelector('.chat-image'));
    return;
  }
  const bubble = event.target.closest('.message-row .bubble');
  if (!bubble) return;
  event.preventDefault();
  openChatMessageMenu(bubble.closest('.message-row'));
});
document.addEventListener('click', event => {
  if (!event.target.closest('.message-row')) closeChatMessageMenu();
  // The picker now lives outside the row, so it must exclude itself too.
  if (!event.target.closest('.message-row') && !event.target.closest('.message-reaction-picker')) closeMessageReactionPicker();
  if (!event.target.closest('#sticker-picker') && !event.target.closest('#sticker-button') && !event.target.closest('#emoji-picker') && !event.target.closest('#emoji-button')) closeComposerPopovers();
});
document.querySelectorAll('[data-close-image-lightbox]').forEach(button => button.addEventListener('click', closeImageLightbox));
document.querySelectorAll('[data-close-video-lightbox]').forEach(button => button.addEventListener('click', closeVideoLightbox));
imageLightboxPrev?.addEventListener('click', () => renderLightboxImage(lightboxIndex - 1));
imageLightboxNext?.addEventListener('click', () => renderLightboxImage(lightboxIndex + 1));
imageLightboxShare?.addEventListener('click', shareLightboxImage);
imageLightboxContent?.addEventListener('dblclick', () => setLightboxZoom(1));
imageLightbox?.addEventListener('wheel', event => {
  if (imageLightbox.classList.contains('hidden')) return;
  event.preventDefault();
  setLightboxZoom(lightboxZoom + (event.deltaY < 0 ? .2 : -.2));
}, { passive: false });
document.addEventListener('keydown', event => {
  if (!imageLightbox?.classList.contains('hidden') && event.key === 'ArrowLeft') renderLightboxImage(lightboxIndex - 1);
  if (!imageLightbox?.classList.contains('hidden') && event.key === 'ArrowRight') renderLightboxImage(lightboxIndex + 1);
  if (event.key === 'Escape') {
    closeChatMessageMenu();
    closeMessageReactionPicker();
    closeComposerPopovers();
    closeImageLightbox();
    closeVideoLightbox();
    closeProductDialog();
  }
});

orderExport.onclick = async () => {
  orderExport.disabled = true;
  const originalLabel = orderExport.textContent;
  orderExport.textContent = 'Đang xuất...';
  try {
    const response = await fetch('/api/orders/export', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ orderData }) });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || 'Không thể tạo file Excel.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const filename = createExportFilename();
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Đã tải ${filename}.`, 'success');
  } catch (error) {
    showToast(error.message);
  } finally {
    orderExport.textContent = originalLabel;
    orderExport.disabled = buildExportRows().length === 0;
  }
};

const initialView = viewNames.includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : 'dashboard';
const metaConnectionParams = new URLSearchParams(window.location.search);
renderOrderImportHistory();
renderShippingHistory();
renderUnreadConversations();
renderMutedConversations();
restoreConversationActivity();
renderSavedChatMessages();
updateMessageSendState();
window.setInterval(updateConversationTimeLabels, 30000);
if (initialView === 'orders') {
  if (orderData.rows.length) renderOrderData();
  showOrderStage(getRecommendedOrderStage());
}
else showView(initialView);
loadFacebookChannels().catch(() => {});
loadMessageChannels().catch(() => {});
loadProducts().catch(renderProductLoadError);
if (metaConnectionParams.has('meta_error')) {
  showToast(metaConnectionParams.get('meta_error'));
  history.replaceState(null, '', `${window.location.pathname}#settings`);
}
if (metaConnectionParams.has('meta_ticket')) {
  openPendingFacebookPages(metaConnectionParams.get('meta_ticket')).catch(error => showToast(error.message));
}
