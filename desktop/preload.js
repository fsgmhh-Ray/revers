/**
 * 预加载脚本：把受控的原生能力挂到 window.electronAPI 上。
 *
 * 站点代码不需要重写——页面检测到 window.CINEFLOW_RUNTIME === 'electron'
 * 就会走引擎路由的桌面端分支（见 src/services/engineRouter.ts）。
 */

// 同 main.js：electron 必须不带 node: 前缀，否则报 ERR_UNKNOWN_BUILT_IN_MODULE。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('CINEFLOW_RUNTIME', 'electron');

contextBridge.exposeInMainWorld('electronAPI', {
  hello: () => ipcRenderer.invoke('cineflow:hello'),
  parse: (payload) => ipcRenderer.invoke('cineflow:parse', payload),
  download: (payload) => ipcRenderer.invoke('cineflow:download', payload),
  cancel: (payload) => ipcRenderer.invoke('cineflow:cancel', payload),
  reveal: (payload) => ipcRenderer.invoke('cineflow:reveal', payload),
  pickDir: (payload) => ipcRenderer.invoke('cineflow:pick-dir', payload),
  defaultDir: () => ipcRenderer.invoke('cineflow:default-dir'),
  // Stage 2：本地 FFmpeg 分镜逆向
  storyboard: (payload) => ipcRenderer.invoke('cineflow:storyboard', payload),
  onStoryboardProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('cineflow:storyboard-progress', listener);
    return () => ipcRenderer.removeListener('cineflow:storyboard-progress', listener);
  },
  onDownloadProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('cineflow:download-progress', listener);
    return () => ipcRenderer.removeListener('cineflow:download-progress', listener);
  },
  // 运营投放（升级 / 广告 / 推广）+ 主站连接状态
  fetchFeed: () => ipcRenderer.invoke('cineflow:feed'),
  feedState: () => ipcRenderer.invoke('cineflow:feed-state'),
  onFeed: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('cineflow:feed', listener);
    return () => ipcRenderer.removeListener('cineflow:feed', listener);
  },
  onConnection: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('cineflow:connection', listener);
    return () => ipcRenderer.removeListener('cineflow:connection', listener);
  },
});
