/**
 * services/llmProbe.ts —— LLM 配置连通性自检（BYOK）。
 *
 * ⚠️ 必须走服务端通道，不能在浏览器里直连供应商：
 * NVIDIA 等 API 的 CORS 预检响应里没有 `Access-Control-Allow-Origin`
 * （实测只有 `Vary: Origin`），浏览器直接 fetch 必然 "Failed to fetch"，
 * 但请求本身完全合法、服务端调用也完全正常。
 * 因此：桌面端走 IPC 直连，网页版走 Pages Functions（/api/test-llm）转发。
 */
import { getElectronAPI } from './electronBridge';

export type ProbeResult = {
  ok: boolean;
  /** 人类可读的原因；失败时说明怎么改 */
  message: string;
  /** 探测耗时（毫秒） */
  ms?: number;
};

/** 统一入口：优先桌面端 IPC（直连），否则走 Pages Functions 代理 */
async function probeViaServer(kind: 'vision' | 'text', cfg: { baseUrl?: string; apiKey?: string; model?: string }): Promise<ProbeResult> {
  const baseUrl = (cfg.baseUrl || '').trim();
  const model = (cfg.model || '').trim();
  if (!baseUrl) return { ok: false, message: '未填 Base URL' };
  if (!model) return { ok: false, message: '未填 Model' };

  // 桌面端：IPC 直连，无 CORS
  const api = getElectronAPI();
  if (api?.testLlm) {
    return api.testLlm({ kind, baseUrl, apiKey: cfg.apiKey, model });
  }

  // 网页版：走 Pages Functions 转发
  try {
    const res = await fetch('/api/test-llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, baseUrl, apiKey: cfg.apiKey, model }),
    });
    const j = (await res.json().catch(() => ({}))) as ProbeResult;
    return j && typeof j.ok === 'boolean' ? j : { ok: false, message: `代理返回异常（HTTP ${res.status}）` };
  } catch (err) {
    return { ok: false, message: `代理请求失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 探测视觉 LLM（/v1/chat/completions） */
export async function probeVisionLlm(cfg: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<ProbeResult> {
  return probeViaServer('vision', cfg);
}

/** 探测文本/ASR LLM（/v1/audio/transcriptions）——发一个极短静音 WAV 验证 */
export async function probeTextLlm(cfg: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<ProbeResult> {
  return probeViaServer('text', cfg);
}
