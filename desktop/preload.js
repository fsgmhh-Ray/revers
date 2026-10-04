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
  // 上传本地视频：网络链接解析不了（风控 / 限区 / 静音版）时的兜底入口
  pickFile: () => ipcRenderer.invoke('cineflow:pick-file'),
  // 登录态：导入浏览器扩展导出的 cookies.txt（Chrome 127+ 无法直接读浏览器数据库）
  pickCookies: () => ipcRenderer.invoke('cineflow:pick-cookies'),
  cookieInfo: (payload) => ipcRenderer.invoke('cineflow:cookie-info', payload),
  // Stage 2：本地 FFmpeg 分镜逆向
  storyboard: (payload) => ipcRenderer.invoke('cineflow:storyboard', payload),
  // 完整旁白 / 语音转写（本地抽音轨 + ASR）
  narration: (payload) => ipcRenderer.invoke('cineflow:narration', payload),
  // LLM 配置自测（桌面端直连，绕开浏览器 CORS——NVIDIA 不允许浏览器直连）
  testLlm: (payload) => ipcRenderer.invoke('cineflow:test-llm', payload),
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
