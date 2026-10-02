/**
 * utils/narration.ts —— 旁白逐字稿整理。
 *
 * Whisper 之类的 ASR 常常返回「一整段、没有标点、没有分段」的文本，直接贴给用户
 * 很难读。这里做纯本地整理：切句 → 补标点 → 分段。
 *
 * 设计原则：只排版，不改字、不调用 LLM（省时省钱，也不会引入内容改写风险）。
 * 切分优先级：句末标点 > 换行 > 逗号/顿号 > 按字数（且避开英文单词中间）。
 */

/** 中英文句末标点 */
const SENTENCE_END = /[。！？!?…；;]/;
/** 中英文逗号/顿号（次级切分点） */
const CLAUSE_SEP = /[，,、]/;
/** 一行读起来舒服的字数上限 */
const MAX_CHARS_PER_SENTENCE = 32;

/**
 * 把 ASR 原始文本整理成「有断句、有分段」的逐字稿。
 *
 * @param raw                          ASR 原始文本
 * @param opts.sentencesPerParagraph   每段多少句（默认 3）
 */
export function formatNarration(raw: string, opts?: { sentencesPerParagraph?: number }): string {
  const sentencesPerParagraph = Math.max(1, opts?.sentencesPerParagraph ?? 2);

  const text = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim();
  if (!text) return '';

  const sentences = splitSentences(text);
  if (!sentences.length) return text;

  // 每 N 句一段；段内句子若无句末标点则补句号，读起来才像逐字稿
  const paragraphs: string[] = [];
  for (let i = 0; i < sentences.length; i += sentencesPerParagraph) {
    const group = sentences.slice(i, i + sentencesPerParagraph).filter(Boolean);
    if (!group.length) continue;
    const line = group
      .map((s, idx) => {
        const t = s.trim();
        if (idx === group.length - 1) return t;
        return SENTENCE_END.test(t.slice(-1)) ? t : `${t}。`;
      })
      .join('');
    paragraphs.push(line);
  }
  return paragraphs.join('\n\n');
}

/**
 * 切句：标点优先，无标点时按字数切（切点尽量落在空格/中文边界，避免切断英文单词）。
 */
function splitSentences(text: string): string[] {
  // 已有句末标点：直接按标点切
  if (SENTENCE_END.test(text)) {
    return text
      .split(/(?<=[。！？!?…；;])/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // 换行是作者/ASR 给的分段意图，优先尊重
  const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);

  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= MAX_CHARS_PER_SENTENCE) {
      out.push(line);
      continue;
    }
    // 行内有逗号/顿号：按其切成小句，逐句输出；单句仍超长再按字数切
    if (CLAUSE_SEP.test(line)) {
      const parts = line.split(/(?<=[，,、])/).map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (p.length <= MAX_CHARS_PER_SENTENCE) {
          out.push(p);
        } else {
          out.push(...splitByLength(p));
        }
      }
      continue;
    }
    // 整行无任何标点（Whisper 最常见）：按字数切
    out.push(...splitByLength(line));
  }
  return out.filter(Boolean);
}

/**
 * 按字数硬切，但切点优先落在「空格」或「中英文交界」处，避免把英文单词切成两半。
 */
function splitByLength(line: string, limit = MAX_CHARS_PER_SENTENCE): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < line.length) {
    let end = Math.min(line.length, start + limit);
    if (end < line.length) {
      // 在 [start+limit*0.6, start+limit] 区间内找一个最靠后的自然断点
      const from = Math.floor(start + limit * 0.6);
      const window = line.slice(from, end);
      const sp = window.lastIndexOf(' ');
      if (sp > 0) {
        end = from + sp;
      } else {
        // 没有空格：找中英文交界（连续 ASCII 字母/数字段的末尾）
        const m = window.match(/[A-Za-z0-9.,!?'"]+$/);
        const idx = m?.index ?? -1;
        if (idx > 0) {
          end = from + idx;
        }
      }
    }
    const piece = line.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end <= start) break;
    start = end;
  }
  return out;
}

/**
 * 带时间戳的逐字稿（按句均分估算时间，用于阅读定位；非字级对齐）。
 */
export function narrationWithTimestamps(
  raw: string,
  totalSeconds?: number,
  opts?: { sentencesPerParagraph?: number },
): string {
  const sentencesPerParagraph = Math.max(1, opts?.sentencesPerParagraph ?? 4);
  const sentences = splitSentences(String(raw || '').trim()).filter(Boolean);
  if (!sentences.length || !totalSeconds || totalSeconds <= 0) return formatNarration(raw, opts);
  const per = totalSeconds / sentences.length;
  const lines: string[] = [];
  let buf: string[] = [];
  sentences.forEach((s, i) => {
    const mm = String(Math.floor((i * per) / 60)).padStart(2, '0');
    const ss = String(Math.floor((i * per) % 60)).padStart(2, '0');
    buf.push(`[${mm}:${ss}] ${SENTENCE_END.test(s.slice(-1)) ? s : s + '。'}`);
    if (buf.length >= sentencesPerParagraph) {
      lines.push(buf.join('\n'));
      buf = [];
    }
  });
  if (buf.length) lines.push(buf.join('\n'));
  return lines.join('\n\n');
}
