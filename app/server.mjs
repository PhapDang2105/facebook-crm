import http from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { createLead, getSegments, updateLead } from './domain.mjs';
import { buildExportRows } from './order-export.mjs';
import { parseXlsx } from './xlsx-import.mjs';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(appDirectory);
const webRoot = path.join(root, 'web');
const storePath = path.join(root, 'data', 'processed', 'crm-store.json');
const seedPath = path.join(root, 'database', 'seeds', 'demo-store.json');
const exportTemplatePath = path.join(root, 'assets', 'templates', 'facebook-order-export.xlsx');
const channelStorePath = path.join(root, 'data', 'processed', 'meta-channels.json');
const port = Number(process.argv[2] || 8080);
const metaConfig = {
  appId: process.env.META_APP_ID || '',
  appSecret: process.env.META_APP_SECRET || '',
  graphVersion: process.env.META_GRAPH_VERSION || '',
  redirectUri: process.env.META_REDIRECT_URI || `http://localhost:${port}/api/channels/meta/callback`
};
const metaOauthStates = new Map();
const metaPendingPages = new Map();

async function initializeStore() {
  await mkdir(path.dirname(storePath), { recursive: true });
  try { await stat(storePath); } catch { await copyFile(seedPath, storePath); }
}

async function readStore() {
  return JSON.parse(await readFile(storePath, 'utf8'));
}

async function writeStore(store) {
  const temporaryPath = `${storePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  await rename(temporaryPath, storePath);
}

function isMetaConfigured() {
  return Boolean(metaConfig.appId && metaConfig.appSecret && metaConfig.graphVersion && metaConfig.redirectUri);
}

async function readChannelStore() {
  try {
    const value = JSON.parse(await readFile(channelStorePath, 'utf8'));
    return Array.isArray(value.items) ? value : { items: [] };
  } catch {
    return { items: [] };
  }
}

async function writeChannelStore(store) {
  await mkdir(path.dirname(channelStorePath), { recursive: true });
  const temporaryPath = `${channelStorePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  await rename(temporaryPath, channelStorePath);
}

function tokenKey() {
  return createHash('sha256').update(metaConfig.appSecret).digest();
}

function encryptToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), value: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decryptToken(encrypted) {
  const decipher = createDecipheriv('aes-256-gcm', tokenKey(), Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.value, 'base64')), decipher.final()]).toString('utf8');
}

function publicChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    picture: channel.picture || '',
    platform: 'facebook',
    status: channel.status || 'connected',
    subscribed: Boolean(channel.subscribed),
    connectedAt: channel.connectedAt,
    checkedAt: channel.checkedAt || channel.connectedAt
  };
}

function cleanExpiredMetaSessions() {
  const now = Date.now();
  for (const [key, expiresAt] of metaOauthStates) if (expiresAt < now) metaOauthStates.delete(key);
  for (const [key, pending] of metaPendingPages) if (pending.expiresAt < now) metaPendingPages.delete(key);
}

async function metaRequest(pathname, options = {}) {
  const endpoint = new URL(`https://graph.facebook.com/${metaConfig.graphVersion}/${pathname.replace(/^\//, '')}`);
  const method = options.method || 'GET';
  if (options.query) Object.entries(options.query).forEach(([key, value]) => endpoint.searchParams.set(key, value));
  const response = await fetch(endpoint, {
    method,
    headers: options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
    body: options.body ? new URLSearchParams(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.error?.message || `Meta trả về lỗi ${response.status}.`);
  return payload;
}

function redirect(response, location) {
  response.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  response.end();
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  response.end(JSON.stringify(value));
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

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
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
    if (request.method === 'GET' && url.pathname === '/api/channels') {
      const store = await readChannelStore();
      return sendJson(response, 200, {
        metaConfigured: isMetaConfigured(),
        missingConfiguration: isMetaConfigured() ? [] : [
          !metaConfig.appId && 'META_APP_ID',
          !metaConfig.appSecret && 'META_APP_SECRET',
          !metaConfig.graphVersion && 'META_GRAPH_VERSION'
        ].filter(Boolean),
        items: store.items.map(publicChannel)
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/channels/meta/connect') {
      if (!isMetaConfigured()) return sendJson(response, 503, {
        error: 'Chưa cấu hình Meta App để kết nối Facebook Page.',
        missingConfiguration: [
          !metaConfig.appId && 'META_APP_ID',
          !metaConfig.appSecret && 'META_APP_SECRET',
          !metaConfig.graphVersion && 'META_GRAPH_VERSION'
        ].filter(Boolean)
      });
      const store = await readChannelStore();
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
        try {
          await metaRequest(`${page.id}/subscribed_apps`, { method: 'POST', body: {
            subscribed_fields: 'messages,messaging_postbacks,messaging_optins,message_deliveries,message_reads',
            access_token: page.accessToken
          } });
          subscribed = true;
        } catch {
          subscribed = false;
        }
        connected.push({
          id: page.id,
          name: page.name,
          picture: page.picture,
          status: 'connected',
          subscribed,
          token: encryptToken(page.accessToken),
          connectedAt: store.items.find(item => item.id === page.id)?.connectedAt || now,
          checkedAt: now
        });
      }
      store.items = [...retained, ...connected];
      await writeChannelStore(store);
      metaPendingPages.delete(payload.ticket);
      return sendJson(response, 200, { items: store.items.map(publicChannel) });
    }
    const channelMatch = url.pathname.match(/^\/api\/channels\/facebook\/([^/]+)$/);
    if (request.method === 'DELETE' && channelMatch) {
      const store = await readChannelStore();
      const pageId = decodeURIComponent(channelMatch[1]);
      const channel = store.items.find(item => item.id === pageId);
      if (!channel) return sendJson(response, 404, { error: 'Không tìm thấy Facebook Page đã kết nối.' });
      try {
        await metaRequest(`${pageId}/subscribed_apps`, { method: 'DELETE', body: { access_token: decryptToken(channel.token) } });
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
        const page = await metaRequest(pageId, { query: { fields: 'id,name,picture{url}', access_token: decryptToken(channel.token) } });
        channel.name = page.name || channel.name;
        channel.picture = page.picture?.data?.url || channel.picture;
        channel.status = 'connected';
      } catch {
        channel.status = 'needs_attention';
      }
      channel.checkedAt = new Date().toISOString();
      await writeChannelStore(store);
      return sendJson(response, 200, publicChannel(channel));
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

server.listen(port, '127.0.0.1', () => console.log(`CRM running at http://localhost:${port}/`));
