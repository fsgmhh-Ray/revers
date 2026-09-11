/**
 * 内容脚本：在 reverse.cineflowing.com 上打标记，并作为页面与后台之间的消息中继。
 *
 * 页面 --window.postMessage--> content.js --chrome.runtime--> background.js
 * 回程反向透传。页面侧用 id 做请求-响应配对（见 src/services/extensionBridge.ts）。
 */

const PROTOCOL = 'CINEFLOW_EXT_V1';
const PAGE_CHANNEL = `${PROTOCOL}:page`;
const EXT_CHANNEL = `${PROTOCOL}:extension`;

// 页面据此判断插件已就绪
document.documentElement.setAttribute('data-cineflow-extension', 'true');

function reply(id, ok, data, error) {
  window.postMessage({ source: EXT_CHANNEL, id, ok, data, error }, '*');
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== PAGE_CHANNEL) return;

  chrome.runtime.sendMessage(
    { channel: PROTOCOL, action: msg.action, payload: msg.payload },
    (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reply(msg.id, false, null, err.message || '插件通信失败');
        return;
      }
      if (!response) {
        reply(msg.id, false, null, '插件无响应（后台可能被休眠，请重试）');
        return;
      }
      reply(msg.id, Boolean(response.ok), response.data, response.error);
    },
  );
});
