import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  nextBestEngine,
  resolveEngine,
  type EnginePreference,
  type ResolvedEngine,
} from '../services/engineRouter';
import { ENGINE_META, type Engine, type EngineCapabilities, type EngineKind } from '../services/types';

export interface EngineState {
  ready: boolean;
  probing: boolean;
  /** 就绪的执行引擎实例，未探测完时为 null */
  engine: Engine | null;
  active: EngineKind | null;
  activeLabel: string;
  activeTag: string;
  capabilities: EngineCapabilities[];
  /** 当前最值得推荐但仍未就绪的引擎，用于「装插件 / 下客户端」引导 */
  upgradeTo: EngineKind | null;
  detail: string;
  refresh: () => void;
}

export function useEngine(preference: EnginePreference): EngineState {
  const [state, setState] = useState<{ probing: boolean; resolved: ResolvedEngine | null }>({
    probing: true,
    resolved: null,
  });
  const versionRef = useRef(0);

  const run = useCallback((prefer: EnginePreference) => {
    const version = ++versionRef.current;
    setState((prev) => ({ probing: true, resolved: prev.resolved }));
    resolveEngine(prefer)
      .then((resolved) => {
        if (version !== versionRef.current) return;
        setState({ probing: false, resolved });
      })
      .catch(() => {
        if (version !== versionRef.current) return;
        setState({ probing: false, resolved: null });
      });
  }, []);

  useEffect(() => {
    run(preference);
  }, [preference, run]);

  const refresh = useCallback(() => run(preference), [preference, run]);

  return useMemo(() => {
    const resolved = state.resolved;
    const active = resolved?.active ?? null;
    return {
      ready: Boolean(resolved?.engine),
      probing: state.probing,
      engine: resolved?.engine ?? null,
      active,
      activeLabel: active ? ENGINE_META[active].label : '未就绪',
      activeTag: active ? ENGINE_META[active].tag : '',
      capabilities: resolved?.capabilities ?? [],
      upgradeTo: nextBestEngine(resolved?.capabilities ?? []),
      detail: resolved?.engine?.capabilities.detail ?? '',
      refresh,
    };
  }, [refresh, state.probing, state.resolved]);
}
