/**
 * 浏览器插件自动化测试（零依赖，纯 Node）。
 *
 * 用 vm 搭一个仿真浏览器环境，加载**真实的** content.js 与 background.js，
 * 跑通「页面 → content script → background → 平台解析 → 回程」整条链路。
 *
 * 覆盖：
 *   1. manifest.json 结构、权限、引用文件与图标是否齐全
 *   2. 三个脚本的语法与文件存在性
 *   3. 前后端契约交叉核对（协议名 / 通道名 / action 集合）
 *   4. 中继链路：HELLO / PARSE / 未知指令 / 无接收方
 *   5. document_start 时 <html> 尚不存在的容错
 *   6. YouTube 播放器数据解析（含嵌套花括号与字符串内花括号）
 *
 * 用法：node extension/test/relay.test.js
 * 退出码：0=全部通过，1=有失败
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(EXT_DIR, '..');

let passed = 0;
const failures = [];

function section(name) {
  console.log('\n--- ' + name + ' ---');
}

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('  \u2713 ' + label);
  } else {
    failures.push(label + (detail !== undefined ? ' -> ' + detail : ''));
    console.log('  \u2717 ' + label + (detail !== undefined ? ' -> ' + detail : ''));
  }
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(EXT_DIR, rel));
}

/* ================================================================== */
/* 仿真浏览器环境                                                      */
/* ================================================================== */

function createEnv({ documentElementInitiallyNull = false } = {}) {
  const bgListeners = [];
  const pageListeners = [];
  const posted = [];
  const attrs = {};
  const docListeners = [];
  const state = { fetchImpl: null, cookies: {}, downloadsEnabled: true };

  const documentElement = {
    setAttribute(k, v) {
      attrs[k] = v;
    },
    getAttribute(k) {
      return k in attrs ? attrs[k] : null;
    },
  };

  const document = {
    documentElement: documentElementInitiallyNull ? null : documentElement,
    readyState: 'loading',
    addEventListener(type, fn) {
      docListeners.push({ type, fn });
    },
  };

  const window = {
    addEventListener(type, fn) {
      if (type === 'message') pageListeners.push(fn);
    },
    postMessage(data) {
      posted.push(data);
      // 同窗口广播：content script 自己的监听器也会收到（靠 source 字段过滤）
      for (const fn of pageListeners) fn({ source: window, data });
    },
    setTimeout,
    clearTimeout,
  };

  const observers = [];
  class MutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    trigger() {
      if (!this.disconnected) this.cb();
    }
  }

  const runtime = {
    onMessage: { addListener: (fn) => bgListeners.push(fn) },
    lastError: undefined,
    sendMessage(msg, cb) {
      let responded = false;
      const sendResponse = (res) => {
        responded = true;
        if (cb) cb(res);
      };

      let kept = false;
      for (const fn of bgListeners) {
        if (fn(msg, {}, sendResponse) === true) kept = true;
      }

      // 没有异步保活且没有任何响应 —— 模拟 Chrome 的"接收方不存在"
      if (!kept && !responded) {
        setTimeout(() => {
          runtime.lastError = {
            message: 'Could not establish connection. Receiving end does not exist.',
          };
          if (cb) cb(undefined);
          runtime.lastError = undefined;
        }, 0);
      }
    },
  };

  const chrome = {
    runtime,
    cookies: {
      async getAll({ domain }) {
        return state.cookies[domain] || [];
      },
    },
    downloads: state.downloadsEnabled
      ? {
          download(_opts, cb) {
            setTimeout(() => cb(42), 0);
          },
          search(_q, cb) {
            setTimeout(() => cb([{ state: 'complete', bytesReceived: 100, totalBytes: 100 }]), 0);
          },
          cancel(_id, cb) {
            setTimeout(() => cb(), 0);
          },
        }
      : undefined,
  };

  // 真实浏览器里 content script 与 service worker 是两个隔离环境
  //（各自独立的作用域），所以这里也必须用两个 vm 上下文，只共享 chrome / window 桩。
  const bgSandbox = {
    chrome,
    fetch: (...args) => {
      if (!state.fetchImpl) throw new Error('测试未提供 fetch 实现');
      return state.fetchImpl(...args);
    },
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
  };

  const csSandbox = {
    window,
    document,
    chrome,
    MutationObserver,
    console,
    setTimeout,
    clearTimeout,
  };

  const bgCtx = vm.createContext(bgSandbox);
  const csCtx = vm.createContext(csSandbox);

  return {
    ctx: bgCtx,
    window,
    document,
    attrs,
    posted,
    state,
    observers,
    docListeners,
    documentElement,
    bgListeners,
    /** 让 <html> 出现，并触发 observer / DOMContentLoaded */
    materializeDocumentElement() {
      document.documentElement = documentElement;
      for (const o of observers) o.trigger();
      for (const l of docListeners) l.fn();
    },
    run(scriptPath) {
      const name = path.basename(scriptPath);
      // content script 走 DOM 上下文，其余（background）走 worker 上下文
      const ctx = name === 'background.js' ? bgCtx : csCtx;
      vm.runInContext(read(scriptPath), ctx, { filename: name });
    },
  };
}

/**
 * 从"页面侧"发一条消息给插件，返回回程消息。
 * 通过劫持 window.postMessage 捕获插件回包（与真实链路一致：回程也走 postMessage）。
 */
function askExtension(env, id, action, payload, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(action + ' 回程超时')), timeoutMs);
    const original = env.window.postMessage;

    env.window.postMessage = (data) => {
      original(data);
      if (data && data.source === 'CINEFLOW_EXT_V1:extension' && data.id === id) {
        clearTimeout(timer);
        env.window.postMessage = original;
        resolve(data);
      }
    };

    env.window.postMessage({ source: 'CINEFLOW_EXT_V1:page', id, action, payload });
  });
}

/* ================================================================== */
/* 1. manifest 校验                                                    */
/* ================================================================== */

section('1. manifest.json 校验');

const manifestPath = path.join(EXT_DIR, 'manifest.json');
let manifest = null;
try {
  manifest = JSON.parse(read(manifestPath));
  check('manifest.json 可解析', true);
} catch (err) {
  check('manifest.json 可解析', false, err.message);
}

if (manifest) {
  check('manifest_version === 3', manifest.manifest_version === 3, String(manifest.manifest_version));
  check('name 非空', typeof manifest.name === 'string' && manifest.name.length > 0);
  check('version 非空', typeof manifest.version === 'string' && manifest.version.length > 0);

  const perms = manifest.permissions || [];
  check('permissions 含 downloads', perms.includes('downloads'));
  check('permissions 含 cookies', perms.includes('cookies'), perms.join(','));

  const sw = manifest.background && manifest.background.service_worker;
  check('声明了 background.service_worker', Boolean(sw), String(sw));
  check('background.service_worker 文件存在', sw ? exists(sw) : false, String(sw));

  const cs = (manifest.content_scripts || [])[0];
  check('声明了 content_scripts', Boolean(cs));
  if (cs) {
    check('content_scripts 匹配 reverse.cineflowing.com', (cs.matches || []).some((m) => m.includes('reverse.cineflowing.com')));
    check('content_scripts 匹配 localhost', (cs.matches || []).some((m) => m.includes('localhost')));
    check('content_scripts 的 js 文件都存在', (cs.js || []).every((f) => exists(f)), (cs.js || []).join(','));
    check('run_at === "document_start"', cs.run_at === 'document_start', String(cs.run_at));
  }

  const popup = manifest.action && manifest.action.default_popup;
  check('声明了 action.default_popup', Boolean(popup), String(popup));
  check('popup 文件存在', popup ? exists(popup) : false, String(popup));

  const hosts = manifest.host_permissions || [];
  for (const need of ['youtube.com', 'instagram.com', 'tiktok.com', 'googlevideo.com', 'cdninstagram.com']) {
    check('host_permissions 覆盖 ' + need, hosts.some((h) => h.includes(need)));
  }

  const icons = manifest.icons || {};
  const iconSizes = Object.keys(icons);
  check('icons 字段已声明', iconSizes.length > 0, iconSizes.join(','));
  for (const size of iconSizes) {
    check('图标 ' + size + '.png 存在', exists(icons[size]), icons[size]);
  }
  check('包含 128 尺寸图标（商店强制要求）', iconSizes.includes('128'));
}

/* ================================================================== */
/* 2. 脚本语法与存在性                                                 */
/* ================================================================== */

section('2. 脚本语法与存在性');

const SCRIPTS = ['background.js', 'content.js', 'popup.js'];
for (const f of SCRIPTS) {
  const p = path.join(EXT_DIR, f);
  if (!fs.existsSync(p)) {
    check(f + ' 存在', false, '文件缺失');
    continue;
  }
  try {
    new vm.Script(read(p), { filename: f });
    check(f + ' 语法正确', true);
  } catch (err) {
    check(f + ' 语法正确', false, err.message);
  }
}
check('popup.html 存在', exists('popup.html'));

/* ================================================================== */
/* 3. 契约交叉核对                                                     */
/* ================================================================== */

section('3. 前后端契约交叉核对');

const bgSrc = read(path.join(EXT_DIR, 'background.js'));
const csSrc = read(path.join(EXT_DIR, 'content.js'));
const bridgeSrc = read(path.join(REPO_ROOT, 'src', 'services', 'extensionBridge.ts'));

function grabProtocol(src) {
  const m = /const PROTOCOL = '([^']+)'/.exec(src);
  return m ? m[1] : null;
}

const pBg = grabProtocol(bgSrc);
const pCs = grabProtocol(csSrc);
const pBridge = grabProtocol(bridgeSrc);

check('background.js 声明了 PROTOCOL', Boolean(pBg), String(pBg));
check('content.js 声明了 PROTOCOL', Boolean(pCs), String(pCs));
check('extensionBridge.ts 声明了 PROTOCOL', Boolean(pBridge), String(pBridge));
check('三处协议名一致', pBg && pBg === pCs && pCs === pBridge, [pBg, pCs, pBridge].join(' / '));

// 通道后缀
check('content.js 使用 :page 通道', csSrc.includes('${PROTOCOL}:page'));
check('content.js 使用 :extension 通道', csSrc.includes('${PROTOCOL}:extension'));
check('extensionBridge.ts 使用 :page 通道', bridgeSrc.includes('${PROTOCOL}:page'));
check('extensionBridge.ts 使用 :extension 通道', bridgeSrc.includes('${PROTOCOL}:extension'));

// 就绪标记
const MARKER = 'data-cineflow-extension';
check('content.js 使用就绪标记 ' + MARKER, csSrc.includes(MARKER));
check('extensionBridge.ts 读取同一标记', bridgeSrc.includes(MARKER));

// action 集合
const frontendActions = new Set();
for (const m of bridgeSrc.matchAll(/\brpc<[^>]*>\(\s*'([A-Z_]+)'/g)) frontendActions.add(m[1]);
for (const m of bridgeSrc.matchAll(/\brpc\(\s*'([A-Z_]+)'/g)) frontendActions.add(m[1]);
for (const m of read(path.join(EXT_DIR, 'popup.js')).matchAll(/action:\s*'([A-Z_]+)'/g)) frontendActions.add(m[1]);

const bgActions = new Set();
for (const m of bgSrc.matchAll(/^\s{2}async ([A-Z_]+)\(/gm)) bgActions.add(m[1]);

check('前端用到的 action 数量 > 0', frontendActions.size > 0, [...frontendActions].join(','));
check('后台 handler 数量 > 0', bgActions.size > 0, [...bgActions].join(','));

for (const a of frontendActions) {
  check('后台实现了前端调用的 ' + a, bgActions.has(a));
}

/* ================================================================== */
/* 4. 中继链路                                                         */
/* ================================================================== */

section('4. 中继链路（页面 ↔ content.js ↔ background.js）');

// 补齐 pageRpc 需要的监听通道：content.js 通过 window.addEventListener('message') 注册，
// 我们的 window.postMessage 会广播给 pageListeners（含 content.js）。
// pageRpc 里额外挂的 __replyListeners 用来让"页面"收到回程。
async function run() {
  // --- 4.1 HELLO ---
  {
    const env = createEnv();
    env.state.cookies = {
      'youtube.com': [{ name: 'SID' }, { name: 'HSID' }],
      'instagram.com': [],
      'tiktok.com': [{ name: 'sessionid' }],
    };

    env.run(path.join(EXT_DIR, 'background.js'));
    env.run(path.join(EXT_DIR, 'content.js'));

    check('content.js 已打上就绪标记', env.attrs['data-cineflow-extension'] === 'true', JSON.stringify(env.attrs));

    const reply = await askExtension(env, 'r1', 'HELLO', null);

    check('HELLO 回程 ok=true', reply.ok === true, JSON.stringify(reply).slice(0, 200));
    check('HELLO 返回 version', reply.data && reply.data.version === '0.1.0', String(reply.data && reply.data.version));
    check('HELLO 返回 platforms', Array.isArray(reply.data && reply.data.platforms) && reply.data.platforms.length === 3);
    check('HELLO 探测到 youtube 已登录', (reply.data.authed || []).includes('youtube'), JSON.stringify(reply.data.authed));
    check('HELLO 探测到 tiktok 已登录', (reply.data.authed || []).includes('tiktok'), JSON.stringify(reply.data.authed));
    check('HELLO 未把未登录的 instagram 算进去', !(reply.data.authed || []).includes('instagram'), JSON.stringify(reply.data.authed));
    check('HELLO 报告 downloadApi=true', reply.data.downloadApi === true);
  }

  // --- 4.2 PARSE（TikTok，走 TikWM，fetch 打桩）---
  {
    const env = createEnv();
    env.state.fetchImpl = async () => ({
      ok: true,
      async json() {
        return {
          code: 0,
          data: {
            id: '7300000000000000000',
            title: '测试短剧片段',
            duration: 15,
            hdplay: 'https://v16.tiktokcdn.com/hd.mp4',
            play: 'https://v16.tiktokcdn.com/sd.mp4',
            cover: 'https://p16.tiktokcdn.com/c.jpg',
            author: { unique_id: 'demo_user', avatar: 'https://p16.tiktokcdn.com/a.jpg' },
          },
        };
      },
    });

    env.run(path.join(EXT_DIR, 'background.js'));
    env.run(path.join(EXT_DIR, 'content.js'));

    const reply = await askExtension(env, 'r2', 'PARSE', {
      url: 'https://www.tiktok.com/@demo/video/7300000000000000000',
      platform: 'tiktok',
    });

    check('PARSE 回程 ok=true', reply.ok === true, JSON.stringify(reply).slice(0, 200));
    const d = reply.data || {};
    check('PARSE 返回标题', d.title === '测试短剧片段', String(d.title));
    check('PARSE 返回直链（优先 hdplay）', d.downloadUrl === 'https://v16.tiktokcdn.com/hd.mp4', String(d.downloadUrl));
    check('PARSE 返回平台 tiktok', d.platform === 'tiktok', String(d.platform));
    check('PARSE 返回时长', d.duration === 15, String(d.duration));
    check('PARSE 返回作者', d.author && d.author.name === 'demo_user', JSON.stringify(d.author));
    check('PARSE 返回封面', Boolean(d.coverUrl));
    check('PARSE provider 标记为用户 IP 通道', d.provider === 'extension:tikwm', String(d.provider));
  }

  // --- 4.3 未知指令 ---
  {
    const env = createEnv();
    env.run(path.join(EXT_DIR, 'background.js'));
    env.run(path.join(EXT_DIR, 'content.js'));

    const reply = await askExtension(env, 'r3', 'NOT_A_REAL_ACTION', null);

    check('未知指令返回 ok=false', reply.ok === false, JSON.stringify(reply).slice(0, 200));
    check('未知指令带出错误信息', typeof reply.error === 'string' && reply.error.length > 0, String(reply.error));
  }

  // --- 4.4 后台不存在（service worker 未唤醒 / 插件刚被禁用）---
  {
    const env = createEnv();
    // 刻意不加载 background.js：模拟"没有接收方"，验证不会静默挂死
    env.run(path.join(EXT_DIR, 'content.js'));

    const reply = await askExtension(env, 'r4', 'HELLO', null);

    check('无接收方时仍回程（不静默挂死）', Boolean(reply), JSON.stringify(reply).slice(0, 200));
    check('无接收方返回 ok=false', reply.ok === false, JSON.stringify(reply).slice(0, 200));
    check('无接收方带出错误信息', typeof reply.error === 'string' && reply.error.length > 0, String(reply.error));
  }

  /* ================================================================ */
  /* 5. document_start 容错                                            */
  /* ================================================================ */

  section('5. document_start 时 <html> 尚不存在的容错');

  {
    const env = createEnv({ documentElementInitiallyNull: true });
    env.run(path.join(EXT_DIR, 'background.js'));

    let threw = null;
    try {
      env.run(path.join(EXT_DIR, 'content.js'));
    } catch (err) {
      threw = err;
    }

    check('documentElement 为 null 时不抛异常', threw === null, threw ? threw.message : undefined);
    check('此时尚未打标记（等 <html> 出现）', env.attrs['data-cineflow-extension'] === undefined);
    check('已注册等待 <html> 的观察器', env.observers.length > 0, 'observers=' + env.observers.length);

    // <html> 出现
    env.materializeDocumentElement();
    check('MutationObserver 触发后补上标记', env.attrs['data-cineflow-extension'] === 'true', JSON.stringify(env.attrs));

    // 标记补上后，中继仍然可用
    const reply = await askExtension(env, 'r5', 'HELLO', null);

    check('补标后 HELLO 仍然可通', reply.ok === true, JSON.stringify(reply).slice(0, 200));
  }

  /* ================================================================ */
  /* 6. YouTube 播放器数据解析                                          */
  /* ================================================================ */

  section('6. YouTube 播放器数据解析');

  {
    const playerResponse = {
      playabilityStatus: { status: 'OK' },
      videoDetails: {
        videoId: 'abc123XYZ',
        // 标题里故意放花括号，用来考验花括号配对逻辑
        title: '短剧片段 {第一集} 反转',
        author: '演示频道',
        lengthSeconds: '42',
        thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/abc123XYZ/hq.jpg' }] },
      },
      streamingData: {
        formats: [],
        adaptiveFormats: [
          {
            url: 'https://rr1---sn-demo.googlevideo.com/videoplayback?noaudio=1',
            mimeType: 'video/mp4; codecs="avc1.4d401f"',
            width: 1920,
            height: 1080,
            bitrate: 2500000,
            videoCodec: 'avc1.4d401f',
          },
          {
            url: 'https://rr1---sn-demo.googlevideo.com/videoplayback?withaudio=1&x=1',
            mimeType: 'video/mp4; codecs="avc1.4d401e, mp4a.40.2"',
            width: 1280,
            height: 720,
            bitrate: 1200000,
            videoCodec: 'avc1.4d401e',
            audioCodec: 'mp4a.40.2',
          },
        ],
      },
    };

    const html =
      '<!doctype html><html><head><script>var ytInitialPlayerResponse = ' +
      JSON.stringify(playerResponse) +
      ';</script></head><body></body></html>';

    const env = createEnv();
    env.state.fetchImpl = async () => ({
      ok: true,
      status: 200,
      async text() {
        return html;
      },
    });

    env.run(path.join(EXT_DIR, 'background.js'));
    env.run(path.join(EXT_DIR, 'content.js'));

    const reply = await askExtension(env, 'r6', 'PARSE', {
      url: 'https://youtu.be/abc123XYZ',
      platform: 'youtube',
    });

    check('YouTube PARSE ok=true', reply.ok === true, JSON.stringify(reply).slice(0, 300));
    const d = reply.data || {};
    check('标题中的花括号未被花括号配对逻辑截断', d.title === '短剧片段 {第一集} 反转', String(d.title));
    check('解析出 videoId', d.id === 'abc123XYZ', String(d.id));
    check('时长解析正确', d.duration === 42, String(d.duration));
    check('优先选用带音轨的格式（720p）', String(d.downloadUrl).includes('withaudio=1'), String(d.downloadUrl));
    check('平台识别为 youtube', d.platform === 'youtube', String(d.platform));
    check('封面已解析', String(d.coverUrl).includes('i.ytimg.com'), String(d.coverUrl));
    check('provider 标记为扩展通道', d.provider === 'extension:user-ip', String(d.provider));
    check('带出过期时间', typeof d.expiresAt === 'number' && d.expiresAt > Date.now(), String(d.expiresAt));
  }

  /* ================================================================ */

  console.log('\n================ 结果 ================');
  console.log('通过：' + passed + '  失败：' + failures.length);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  } else {
    console.log('EXTENSION_TEST_OK');
  }
}

run().catch((err) => {
  console.error('EXTENSION_TEST_ERROR=' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
