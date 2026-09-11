import type { ApiHandler } from '../_lib/types';
import { corsPreflight, json } from '../_lib/http';

export const onRequestOptions: ApiHandler = async () => corsPreflight();

/**
 * GET /api/client-feed
 *
 * 桌面端 / 网页 / 插件共用的「运营投放中心」：
 *   - latestVersion / minVersion：升级与强制升级判定
 *   - heartbeatIntervalSec：桌面端心跳拉取频率（服务端可调控）
 *   - upgrade：版本公告（标题 / 说明 / 下载页）
 *   - banner：常驻推广条（主站 / 活动 / 广告位）
 *   - promos：可带上下架时间的推广 / 广告队列
 *
 * 运营可编辑下方 FEED 配置即可投放，无需改代码。
 * 后续可平滑替换为 KV / CMS 读取。
 */

interface PromoItem {
  id: string;
  type: 'banner' | 'toast' | 'inline';
  title: string;
  body?: string;
  image?: string;
  url?: string;
  cta?: string;
  startAt?: string; // ISO
  endAt?: string; // ISO
}

const FEED = {
  latestVersion: '0.1.0',
  minVersion: '0.1.0',
  heartbeatIntervalSec: 45,
  upgrade: {
    title: '客户端新版本 0.2.0 已发布',
    notes: '提升 YouTube 1080p+ 音视频合并稳定性，并内置分镜逆向本地抽帧。',
    url: 'https://github.com/fsgmhh-Ray/revers/releases',
  },
  // 常驻推广条：主站 / 活动 / 广告位
  banner: {
    id: 'welcome-desktop',
    type: 'banner',
    title: 'REVERSE 桌面端已就绪：本机 IP 解析 + 1080p+ 合并，彻底绕开平台风控',
    body: 'Chrome 插件适合快速抓取，桌面端适合最高画质与本地分镜逆向。',
    url: 'https://www.cineflowing.com/',
    cta: '了解主站',
  } as PromoItem,
  // 推广 / 广告队列（可带 startAt/endAt 控制上下架）
  promos: [] as PromoItem[],
};

function parseVersion(v?: string | null): [number, number, number] {
  if (!v) return [0, 0, 0];
  const parts = String(v)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export const onRequestGet: ApiHandler = async (ctx) => {
  const url = new URL(ctx.request.url);
  const current = url.searchParams.get('v') || null;
  const now = Date.now();

  const activePromos = (FEED.promos || []).filter((p) => {
    if (p.startAt && new Date(p.startAt).getTime() > now) return false;
    if (p.endAt && new Date(p.endAt).getTime() < now) return false;
    return true;
  });

  const cur = parseVersion(current);
  const latest = parseVersion(FEED.latestVersion);
  const min = parseVersion(FEED.minVersion);

  const upgradeRequired = cmp(cur, min) < 0;
  const upgradeAvailable = cmp(cur, latest) < 0;

  return json(
    {
      serverTime: new Date(now).toISOString(),
      currentVersion: current,
      latestVersion: FEED.latestVersion,
      minVersion: FEED.minVersion,
      heartbeatIntervalSec: FEED.heartbeatIntervalSec,
      connection: 'ok',
      upgrade: {
        required: upgradeRequired,
        available: upgradeAvailable,
        title: FEED.upgrade.title,
        notes: FEED.upgrade.notes,
        url: FEED.upgrade.url,
      },
      banner: FEED.banner,
      promos: activePromos,
    },
    200,
    { 'Cache-Control': 'public, max-age=30' },
  );
};
