/** 客户端 / 网页 / 插件共用的运营投放（feed）数据契约，对应 /api/client-feed。 */

export interface PromoItem {
  id: string;
  type: 'banner' | 'toast' | 'inline';
  title: string;
  body?: string;
  image?: string;
  url?: string;
  cta?: string;
}

export interface ClientUpgrade {
  required: boolean;
  available: boolean;
  title: string;
  notes?: string;
  url?: string;
}

export interface ClientFeed {
  serverTime: string;
  currentVersion: string | null;
  latestVersion: string;
  minVersion: string;
  heartbeatIntervalSec: number;
  connection: string;
  upgrade: ClientUpgrade;
  banner: PromoItem | null;
  promos: PromoItem[];
}

export interface ConnectionState {
  online: boolean;
  at: number;
}

export interface FeedState {
  online: boolean;
  lastSync: number;
  interval: number;
}
