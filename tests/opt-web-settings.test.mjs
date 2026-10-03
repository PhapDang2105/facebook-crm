import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// B8 (web/app.js): công tắc "Kích thước cửa sổ" và "Tầm nhìn" ở Thiết lập chatbot nạp/lưu đúng cài đặt thật.
const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const fn = name => {
  const start = web.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `không tìm thấy hàm ${name}`);
  const end = web.indexOf('\n}\n', start);
  return web.slice(start, end + 3);
};

function memoryContext() {
  const input = () => ({ value: '', checked: true, disabled: false });
  const context = {
    chatbotSettingsMemoryWindow: input(),
    chatbotSettingsMemoryWindowRange: input(),
    chatbotSettingsMemoryWindowEnabled: input(),
    chatbotMemoryWindowMaximum: 100
  };
  vm.createContext(context);
  vm.runInContext(['syncChatbotMemoryWindow', 'syncChatbotMemoryWindowEnabled', 'applyChatbotMemoryWindowSetting', 'chatbotMemoryWindowPayload'].map(fn).join('\n'), context);
  return context;
}

test('B8: cửa sổ bộ nhớ — dưới 100 là bật (gửi số đang chọn), đủ 100 là tắt giới hạn (ô số khoá, gửi 100)', () => {
  const context = memoryContext();
  context.applyChatbotMemoryWindowSetting(30);
  assert.equal(context.chatbotSettingsMemoryWindowEnabled.checked, true);
  assert.equal(context.chatbotSettingsMemoryWindow.value, '30');
  assert.equal(context.chatbotSettingsMemoryWindowRange.value, '30');
  assert.equal(context.chatbotSettingsMemoryWindow.disabled, false);
  assert.equal(context.chatbotMemoryWindowPayload(), '30');

  context.chatbotSettingsMemoryWindowEnabled.checked = false;
  context.syncChatbotMemoryWindowEnabled();
  assert.equal(context.chatbotSettingsMemoryWindow.disabled, true);
  assert.equal(context.chatbotSettingsMemoryWindowRange.disabled, true);
  assert.equal(context.chatbotMemoryWindowPayload(), 100);

  context.applyChatbotMemoryWindowSetting(100);
  assert.equal(context.chatbotSettingsMemoryWindowEnabled.checked, false);
  assert.equal(context.chatbotSettingsMemoryWindow.disabled, true);
  context.applyChatbotMemoryWindowSetting(undefined);
  assert.equal(context.chatbotSettingsMemoryWindow.value, '50', 'không có thì mặc định 50');
});

test('B8: "Tầm nhìn" hiện đúng trạng thái thật (không ghi = bật) và gửi visionEnabled khi máy chủ hỗ trợ', () => {
  const load = web.slice(web.indexOf('applyChatbotMemoryWindowSetting(settings.memoryWindow || 50);'), web.indexOf('applyChatbotMemoryWindowSetting(settings.memoryWindow || 50);') + 900);
  assert.match(load, /chatbotSettingsVision\.checked = settings\.visionEnabled !== false;/);
  assert.match(load, /hasOwnProperty\.call\(settings, 'visionEnabled'\)/);
  assert.match(load, /chatbotSettingsVision\.disabled = !supported;/);
  const save = web.slice(web.indexOf("chatbotSettingsForm?.addEventListener('submit'"), web.indexOf("chatbotSettingsForm?.addEventListener('submit'") + 4000);
  assert.match(save, /memoryWindow: chatbotMemoryWindowPayload\(\),/);
  assert.match(save, /\.\.\.\(chatbotSettingsVision && !chatbotSettingsVision\.disabled \? \{ visionEnabled: chatbotSettingsVision\.checked \} : \{\}\),/);
  assert.match(web, /chatbotSettingsMemoryWindowEnabled\?\.addEventListener\('change', syncChatbotMemoryWindowEnabled\);/);
});
