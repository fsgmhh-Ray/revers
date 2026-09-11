import { useCallback, useEffect, useRef, useState } from 'react';
import { IconAlert, IconCheck, IconClose } from './Icons';

export interface Toast {
  id: string;
  message: string;
  type: 'info' | 'success' | 'error';
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timer = useRef<Record<string, number>>({});

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    window.clearTimeout(timer.current[id]);
    delete timer.current[id];
  }, []);

  const push = useCallback(
    (message: string, type: Toast['type'] = 'info') => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { id, message, type }]);
      timer.current[id] = window.setTimeout(() => remove(id), 3600);
    },
    [remove],
  );

  useEffect(() => {
    const timers = timer.current;
    return () => Object.values(timers).forEach((t) => window.clearTimeout(t));
  }, []);

  return { toasts, push, remove };
}

export function Toaster({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-[320px] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex animate-fade-up items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm shadow-card backdrop-blur-xl ${
            toast.type === 'error'
              ? 'border-rose-500/30 bg-rose-950/70 text-rose-100'
              : toast.type === 'success'
                ? 'border-emerald-500/30 bg-emerald-950/70 text-emerald-100'
                : 'border-white/10 bg-ink-700/90 text-slate-200'
          }`}
        >
          <span className="mt-0.5 shrink-0">
            {toast.type === 'error' ? <IconAlert width={15} height={15} /> : <IconCheck width={15} height={15} />}
          </span>
          <p className="flex-1 leading-relaxed">{toast.message}</p>
          <button className="shrink-0 opacity-60 hover:opacity-100" onClick={() => onRemove(toast.id)}>
            <IconClose width={14} height={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
