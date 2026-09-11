/**
 * 预加载脚本：把受控的原生能力挂到 window.electronAPI 上。
 *
 * 站点代码不需要重写——页面检测到 window.CINEFLOW_RUNTIME === 'electron'
 * 就会走引擎路由的桌面端分支（见 src/services/engineRouter.ts）。
 */

const { contextBridge, ipcRenderer } = require('node:electron');

contextBridge.exposeInMainWorld('CINEFLOW_RUNTIME', 'electron');

contextBridge.exposeInMainWorld('electronAPI', {
  hello: () => ipcRenderer.invoke('cineflow:hello'),
  parse: (payload) => ipcRenderer.invoke('cineflow:parse', payload),
  download: (payload) => ipcRenderer.invoke('cineflow:download', payload),
  cancel: (payload) => ipcRenderer.invoke('cineflow:cancel', payload),
  reveal: (payload) => ipcRenderer.invoke('cineflow:reveal', payload),
  pickDir: () => ipcRenderer.invoke('cineflow:pick-dir'),
  onDownloadProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('cineflow:download-progress', listener);
    return () => ipcRenderer.removeListener('cineflow:download-progress', listener);
  },
});
