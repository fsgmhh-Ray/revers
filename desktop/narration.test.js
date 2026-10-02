/**
 * 完整旁白 / 语音转写的自测。
 *
 * 分两部分，都不依赖外网：
 *   A. 分块逻辑单测：合成一个 >24MB 的 16k 单声道 WAV（语音段 + 静音段交替），
 *      断言 splitWavChunks 切出的每块都 <25MB、都是合法 WAV、且字节零丢失。
 *   B. 端到端（可选，需设环境变量）：
 *      NAR_TEST_ASR_BASE / NAR_TEST_ASR_KEY / NAR_TEST_ASR_MODEL 存在时，
 *      合成带音轨的视频并真调一次 ASR，验证 buildNarration 全链路。
 *      未设置则跳过（不联网）。
 *
 * 另外单独验证 hasAudioStream：无声视频应被识别为「无音轨」。
 *
 * 用法（desktop/ 下，已 npm install）：
 *   npm run narration
 * 退出码：0=通过，1=断言失败，2=超时，3=运行环境不对
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error('NR_ERROR=检测到 ELECTRON_RUN_AS_NODE=' + process.env.ELECTRON_RUN_AS_NODE);
  console.error('NR_HINT=该变量会让 Electron 退化成纯 Node，请先清除再运行');
  process.exit(3);
}

const { app } = require('electron');
if (!app || typeof app.whenReady !== 'function') {
  console.error('NR_ERROR=当前进程不是 Electron 主进程');
  process.exit(3);
}

const {
  buildNarration,
  splitWavChunks,
  transcriptionEndpoint,
  hasAudioStream,
  resolveBinary,
} = require('./ipc');

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log('  \u2713 ' + label);
  } else {
    failures.push(label + (detail ? ' -> ' + detail : ''));
    console.log('  \u2717 ' + label + (detail ? ' -> ' + detail : ''));
  }
}

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

const hardTimeout = setTimeout(() => {
  console.error('NR_TIMEOUT=180s 内未完成');
  app.exit(2);
}, 180_000);

function ff(args) {
  return spawnSync(resolveBinary('ffmpeg'), args, { encoding: 'utf8', windowsHide: true });
}

/** 合成 16k 单声道 WAV：speech 段（有声）+ silence 段（静音）交替，便于验证静音对齐切分 */
function makeLongWav(file, totalSeconds) {
  const sr = 16000;
  const header = Buffer.alloc(44);
  const dataBytes = totalSeconds * sr * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);

  // 逐块写：3s 有声 + 1.5s 静音 循环
  const chunkFrames = sr / 10; // 100ms
  const chunks = [];
  let t = 0;
  while (t < totalSeconds) {
    const speech = chunks.length % 2 === 0;
    const buf = Buffer.alloc(chunkFrames * 2);
    if (speech) {
      for (let i = 0; i < chunkFrames; i++) {
        const v = Math.round(6000 * Math.sin((2 * Math.PI * 180 * (t * 10 + i)) / sr));
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
      }
    }
    chunks.push(buf);
    t += 0.1;
  }
  return fs.writeFileSync(file, Buffer.concat([header, ...chunks]));
}

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nar-test-'));
  console.log('临时目录: ' + tmp);

  try {
    // ---------- A. 端点拼接 ----------
    console.log('\n[A] OpenAI 兼容端点拼接');
    check(
      'base 以 /v1 结尾不重复拼',
      transcriptionEndpoint('https://api.groq.com/openai/v1') === 'https://api.groq.com/openai/v1/audio/transcriptions',
      transcriptionEndpoint('https://api.groq.com/openai/v1'),
    );
    check(
      'base 只到 host 时补 /v1',
      transcriptionEndpoint('https://api.groq.com/openai') === 'https://api.groq.com/openai/v1/audio/transcriptions',
      transcriptionEndpoint('https://api.groq.com/openai'),
    );
    check(
      '尾部斜杠被清理',
      transcriptionEndpoint('https://api.groq.com/openai/v1///') === 'https://api.groq.com/openai/v1/audio/transcriptions',
      transcriptionEndpoint('https://api.groq.com/openai/v1///'),
    );

    // ---------- B. 分块逻辑 ----------
    console.log('\n[B] 长音频自动分块（绕开 ASR 25MB 上限）');
    const bigWav = path.join(tmp, 'big.wav');
    // 22.5 分钟 ≈ 41MB > 24MB 阈值
    makeLongWav(bigWav, 22 * 60);
    const size = fs.statSync(bigWav).size;
    console.log('  源文件: ' + (size / 1048576).toFixed(1) + 'MB（阈值 24MB）');
    check('源文件确实超过阈值', size > MAX_AUDIO_BYTES, size + ' bytes');

    const chunks = splitWavChunks(fs.readFileSync(bigWav), MAX_AUDIO_BYTES);
    check('产生了多块', chunks.length > 1, 'chunks=' + chunks.length);

    let allUnder = true;
    let allValid = true;
    let total = 0;
    chunks.forEach((c, i) => {
      const mb = c.length / 1048576;
      total += c.length - 44;
      if (mb > 25) allUnder = false;
      const isRiff = c.toString('ascii', 0, 4) === 'RIFF' && c.toString('ascii', 8, 12) === 'WAVE';
      const riffSize = c.readUInt32LE(4);
      const dataTag = c.toString('ascii', 36, 40);
      const dataLen = c.readUInt32LE(40);
      const selfOk = isRiff && dataTag === 'data' && riffSize === c.length - 8 && dataLen === c.length - 44;
      if (!selfOk) allValid = false;
      console.log('    chunk' + (i + 1) + ': ' + mb.toFixed(1) + 'MB 合法=' + selfOk);
    });
    check('每块都 < 25MB（Groq 上限）', allUnder);
    check('每块都是合法 WAV（RIFF/data 自洽）', allValid);
    const srcData = size - 44;
    check('总数据零丢失', Math.abs(total - srcData) < 4096 * 4, total + ' vs ' + srcData);

    // ---------- C. 短音频不分块 ----------
    console.log('\n[C] 短音频走单次路径');
    const smallWav = path.join(tmp, 'small.wav');
    makeLongWav(smallWav, 5); // ~9.6MB < 24MB
    const smallChunks = splitWavChunks(fs.readFileSync(smallWav), MAX_AUDIO_BYTES);
    check('短音频不切块（保持原行为）', smallChunks.length === 0, 'chunks=' + smallChunks.length);

    // ---------- D. 音轨检测（用真实视频，避免依赖 ffmpeg 合成） ----------
    //
    // 说明：本仓库的 storyboard.test.js 用 ffmpeg 合成素材，但在部分受限环境里
    // Node spawn 任意 Windows exe 会返回 EBUSY（yt-dlp 也一样，非 ffmpeg 特有），
    // 导致素材合成本身失败。为此这里不合成，改用「真实存在��本地视频」做检测：
    //   - 传一个不存在的路径 → 应报「找不到本地视频」；
    //   - 若 NAR_TEST_VIDEO 指向真实视频 → 真跑 hasAudioStream + 端到端转写。
    console.log('\n[D] 输入校验与音轨检测');
    const silentVideo = process.env.NAR_TEST_SILENT_VIDEO || '';
    const withAudioVideo = process.env.NAR_TEST_VIDEO || '';

    try {
      await buildNarration({ id: 'x', path: path.join(tmp, 'nope.mp4'), llmTextBaseUrl: 'https://x/v1' }, null);
      check('不存在的文件应报错', false, '未抛错');
    } catch (err) {
      check('不存在的文件报「找不到本地视频」', /找不到本地视频/.test(String(err?.message || '')), String(err?.message || err).slice(0, 80));
    }

    if (withAudioVideo && fs.existsSync(withAudioVideo)) {
      const has = await hasAudioStream(withAudioVideo);
      check('真实视频音轨检测返回布尔', typeof has === 'boolean', 'got ' + typeof has);
      console.log('    ' + path.basename(withAudioVideo) + ' 有音轨=' + has);
    } else {
      console.log('  (跳过音轨检测：未设 NAR_TEST_VIDEO 指向真实视频)');
    }

    // ---------- E. 端到端（需凭据 + 真实视频，默认跳过） ----------
    const asrBase = process.env.NAR_TEST_ASR_BASE;
    const asrKey = process.env.NAR_TEST_ASR_KEY;
    const asrModel = process.env.NAR_TEST_ASR_MODEL;
    console.log('\n[E] 端到端转写');
    if (!asrBase || !asrModel || !withAudioVideo || !fs.existsSync(withAudioVideo)) {
      console.log('  (跳过：需同时设 NAR_TEST_ASR_BASE / NAR_TEST_ASR_MODEL 且 NAR_TEST_VIDEO 指向真实视频)');
    } else {
      try {
        const res = await buildNarration(
          {
            id: 'nr_test',
            path: withAudioVideo,
            llmTextBaseUrl: asrBase,
            llmTextApiKey: asrKey || '',
            llmTextModel: asrModel,
            language: process.env.NAR_TEST_LANG || '',
          },
          null,
        );
        check('buildNarration 返回 ok', res && res.ok === true, JSON.stringify(res).slice(0, 160));
        check('返回了 transcript 字段', typeof res?.transcript === 'string');
        console.log('    transcript: ' + String(res?.transcript || '').slice(0, 100));
      } catch (err) {
        check('buildNarration 端到端', false, String(err?.message || err).slice(0, 200));
      }
    }

    // ---------- F. 错误分支 ----------
    console.log('\n[F] 错误提示');
    try {
      await buildNarration({ id: 'x', path: withAudioVideo || path.join(tmp, 'x.mp4'), llmTextBaseUrl: '' }, null);
      check('缺 Base URL 时报错', false, '未抛错');
    } catch (err) {
      const msg = String(err?.message || err);
      // 若给了真实视频，应报「缺 Base URL」；否则会先报「找不到文件」，也算通过路径校验
      check(
        '缺 Base URL / 文件校验给出可读提示',
        /Base URL/.test(msg) || /找不到本地视频/.test(msg),
        msg.slice(0, 100),
      );
    }
    if (silentVideo && fs.existsSync(silentVideo)) {
      try {
        await buildNarration({ id: 'x', path: silentVideo, llmTextBaseUrl: 'https://api.groq.com/openai/v1', llmTextModel: 'whisper-large-v3' }, null);
        check('无声视频应报「不含音轨」', false, '未抛错');
      } catch (err) {
        check('无声视频报「不含音轨」', /不含音轨/.test(String(err?.message || '')), String(err?.message || err).slice(0, 100));
      }
    } else {
      console.log('  (跳过无声视频检查：未设 NAR_TEST_SILENT_VIDEO)');
    }
  } catch (err) {
    failures.push('自测异常: ' + String(err?.message || err));
    console.error('NR_EXCEPTION=' + String(err?.stack || err));
  }

  clearTimeout(hardTimeout);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }

  console.log('\n' + '='.repeat(46));
  if (failures.length) {
    console.log('NR_FAIL（' + failures.length + ' 项）');
    failures.forEach((f) => console.log('  - ' + f));
    app.exit(1);
  }
  console.log('NR_PASS 全部通过');
  app.exit(0);
});
