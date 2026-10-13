import { useCallback, useEffect, useRef, useState } from 'react';

// Fetch with stale-while-revalidate: keeps the last good data on screen while refreshing.
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 30000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const retryTimer = useRef<any>(undefined);
  const fnRef = useRef(fn); fnRef.current = fn;
  const run = useCallback(async () => {
    const id = ++seq.current; setLoading(true);
    try { const d = await fnRef.current(); if (id === seq.current) { setData(d); setError(null); } }
    catch (e: any) {
      if (id === seq.current) {
        setError(e.message || 'Failed to load');
        // An outage should heal quickly once it is over: retry sooner than the normal refresh (the server's Retry-After when it sends one).
        if (e?.status >= 500 || e?.status === 0) { clearTimeout(retryTimer.current); retryTimer.current = setTimeout(() => { if (id === seq.current) run(); }, Math.min(30, Math.max(3, e.retryAfter || 5)) * 1000); }
      }
    }
    finally { if (id === seq.current) setLoading(false); }
  }, []);
  useEffect(() => { run(); const id = intervalMs ? setInterval(run, intervalMs) : undefined; return () => { seq.current++; clearTimeout(retryTimer.current); if (id) clearInterval(id); }; }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload: run };
}

/**
 * Web only: keep keyboard focus inside a modal surface. Moves focus in when it opens (unless a field already took it with autoFocus),
 * wraps Tab at the ends, and puts focus back where it was when the surface closes. Does nothing when focus is elsewhere
 * (for example a sign-in dialog opened over a drawer), so stacked modals do not fight.
 */
export function useModalFocus(ref: { current: any }) {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = ref.current as HTMLElement | null;
    if (!root || !root.querySelectorAll) return;
    const previous = document.activeElement as HTMLElement | null;
    const SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const items = () => Array.from(root.querySelectorAll<HTMLElement>(SEL)).filter((e) => e.offsetParent !== null || e === document.activeElement);
    const t0 = setTimeout(() => {
      if (root.contains(document.activeElement)) return;
      const first = items()[0];
      if (first) first.focus(); else { root.setAttribute('tabindex', '-1'); root.focus(); }
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !root.contains(document.activeElement)) return;
      const list = items(); if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t0); document.removeEventListener('keydown', onKey); if (previous && previous.isConnected && previous.focus) previous.focus(); };
  }, [ref]);
}

/** The current time as state, refreshed on an interval, so "left" / "overdue" text stays true on a page left open. */
export function useNow(ms = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}
