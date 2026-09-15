/**
 * Stage 2 分镜逆向的真机自测（不依赖外网、不依赖真实素材）。
 *
 * 做法：先用 FFmpeg 合成一段「红 → 蓝 → 绿」三段各 2 秒的视频，
 * 场景切换是干净的全画面变化，切点必然落在 2s / 4s。
 * 然后跑真实的 buildStoryboard()，断言：
 *   - 切分点数量与位置正确；
 *   - 每帧缩略图都抽出来了（data URL）；
 *   - 时间轴首尾相接、覆盖整段时长。
 *
 * 这样连「FFmpeg 参数写错 / 路径不对 / 二进制缺失」都能在装包前暴露出来，
 * 而不是等用户点了"一键拆解"才发现。
 *
 * 用法（desktop/ 下，已 npm install）：
 *   npm run storyboard
 * 退出码：0=通过，1=断言失败，2=超时，3=运行环境不对
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error('SB_ERROR=检测到 ELECTRON_RUN_AS_NODE=' + process.env.ELECTRON_RUN_AS_NODE);
  console.error('SB_HINT=该变量会让 Electron 退化成纯 Node，请先清除再运行');
  process.exit(3);
}

const { app } = require('electron');
if (!app || typeof app.whenReady !== 'function') {
  console.error('SB_ERROR=当前进程不是 Electron 主进程');
  process.exit(3);
}

const { buildStoryboard, resolveDownloadDir, resolveBinary } = require('./ipc');

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log('  \u2713 ' + label);
  } else {
    failures.push(label + (detail ? ' -> ' + detail : ''));
    console.log('  \u2717 ' + label + (detail ? ' -> ' + detail : ''));
  }
}

const hardTimeout = setTimeout(() => {
  console.error('SB_TIMEOUT=120s 内未完成');
  app.exit(2);
}, 120_000);

function makeTestVideo(file) {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25:d=2',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=25:d=2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
    '-map', '[out]',
    '-pix_fmt', 'yuv420p',
    file,
  ];
  const res = spawnSync(resolveBinary('ffmpeg'), args, { encoding: 'utf8' });
  return { ok: res.status === 0 && fs.existsSync(file), stderr: (res.stderr || '').trim() };
}

app.whenReady().then(async () => {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cineflow-sbtest-'));
    const video = path.join(tmp, 'scenes.mp4');

    console.log('--- 测试素材 ---');
    const gen = makeTestVideo(video);
    check('合成三场景测试视频', gen.ok, gen.stderr);
    if (!gen.ok) throw new Error('测试视频生成失败，后续断言无意义');
    console.log('  SB_TEST_VIDEO=' + video + ' (' + fs.statSync(video).size + ' B)');

    console.log('--- 下载目录解析 ---');
    const wanted = path.join(tmp, 'chosen');
    const resolved = resolveDownloadDir(wanted);
    check('用户指定目录被采用', resolved === wanted, resolved);
    check('不存在的目录会被自动创建', fs.existsSync(wanted), wanted);
    const deep = path.join(tmp, 'a', 'b', 'c');
    const deepResolved = resolveDownloadDir(deep);
    check('多级目录可递归创建', fs.existsSync(deepResolved), deepResolved);
    // 用「被文件占用的路径」来验证退回逻辑 —— 比不存在的盘符更可靠，
    // 因为客户机上可能真的挂载了 Z:（映射盘 / 虚拟盘），那样断言会假失败
    const occupied = path.join(tmp, 'occupied.txt');
    fs.writeFileSync(occupied, 'not a directory');
    const bogus = resolveDownloadDir(occupied);
    check('路径不可用时自动退回可用目录', bogus !== occupied && fs.existsSync(bogus), bogus);
    console.log('  SB_FALLBACK_DIR=' + bogus);

    console.log('--- 场景切分 + 抽帧 ---');
    const t0 = Date.now();
    const sb = await buildStoryboard(
      { id: 'sb_test', path: video, sceneThreshold: 0.3, maxShots: 24, frameWidth: 240 },
      null,
    );
    console.log('  SB_ELAPSED_MS=' + (Date.now() - t0));
    check('buildStoryboard 返回 ok', sb && sb.ok === true, JSON.stringify(sb && sb.error));
    if (!sb || !sb.ok) throw new Error(sb && sb.error ? sb.error : 'buildStoryboard 失败');

    console.log('  SB_SOURCE=' + JSON.stringify(sb.source));
    console.log('  SB_STATS=' + JSON.stringify(sb.stats));
    console.log('  SB_NODES=' + sb.nodes.length);

    check('源时长约 6 秒', Math.abs(sb.source.duration / 1000 - 6) < 0.6, String(sb.source.duration));
    check('切出 3 个镜头', sb.nodes.length === 3, String(sb.nodes.length));
    check('stats.sceneCount 与节点数一致', sb.stats.sceneCount === sb.nodes.length);
    check('识别为快慢适中的节奏', typeof sb.stats.cutRhythm === 'string' && sb.stats.cutRhythm.length > 0, sb.stats.cutRhythm);

    const [n1, n2, n3] = sb.nodes;
    if (n1 && n2 && n3) {
      check('第 1 个切点落在 2s 附近', Math.abs(n1.endTime / 1000 - 2) < 0.6, String(n1.endTime));
      check('第 2 个切点落在 4s 附近', Math.abs(n2.endTime / 1000 - 4) < 0.6, String(n2.endTime));
      check('时间轴首尾相接（无空隙）', n1.endTime === n2.startTime && n2.endTime === n3.startTime);
      check('末镜头覆盖到片尾', Math.abs(n3.endTime / 1000 - 6) < 0.6, String(n3.endTime));
    } else {
      failures.push('节点不足 3 个，跳过切点位置断言');
    }

    const thumbs = sb.nodes.filter((n) => String(n.thumbnailUrl).startsWith('data:image/jpeg;base64,'));
    check('每个镜头都抽到了关键帧', thumbs.length === sb.nodes.length, thumbs.length + '/' + sb.nodes.length);
    // 用 JPEG 魔数（FF D8）校验，而不是卡体积 ——
    // 纯色测试图的 JPEG 只有几百字节，按体积断言会假失败
    const jpegOk = thumbs.every((n) => {
      const b64 = String(n.thumbnailUrl).split(',')[1] || '';
      return Buffer.from(b64, 'base64').subarray(0, 2).toString('hex') === 'ffd8';
    });
    check('缩略图是合法 JPEG（魔数校验）', jpegOk);
    check('每个节点都有镜头类型', sb.nodes.every((n) => typeof n.shotType === 'string' && n.shotType.length > 0));
    check('节点标明为推断结果（inferred）', sb.nodes.every((n) => n.inferred === true));
    check('duration 与起止时间自洽', sb.nodes.every((n) => n.duration === n.endTime - n.startTime));

    console.log('  SB_SHOT_TYPES=' + JSON.stringify(sb.nodes.map((n) => n.shotType)));

    console.log('--- 异常输入 ---');
    // 直接调用会抛异常，IPC handler 负责转成 { ok:false, error } —— 两者都算合格，
    // 关键是错误信息要指向「先下载到本机」这个可执行动作
    let missingHandled = false;
    let missingMsg = '';
    try {
      const r = await buildStoryboard({ id: 'x', path: path.join(tmp, 'nope.mp4') }, null);
      missingHandled = !!(r && r.ok === false && r.error);
      missingMsg = (r && r.error) || '';
    } catch (err) {
      missingHandled = true;
      missingMsg = (err && err.message) || '';
    }
    check('文件不存在时给出可行动的错误', missingHandled && /找不到本地视频/.test(missingMsg), missingMsg);

    // 清理
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 沙箱可能拦截，忽略 */
    }

    console.log('--- 结果 ---');
    if (failures.length === 0) {
      console.log('STORYBOARD_OK');
      clearTimeout(hardTimeout);
      app.exit(0);
    } else {
      console.error('STORYBOARD_FAIL=' + failures.length + ' 项失败');
      failures.forEach((f) => console.error('  - ' + f));
      clearTimeout(hardTimeout);
      app.exit(1);
    }
  } catch (err) {
    console.error('SB_ERROR=' + (err && err.message ? err.message : err));
    clearTimeout(hardTimeout);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {});
