import { useCallback, useEffect, useRef, useState } from 'react';

// Fetch with stale-while-revalidate: keeps the last good data on screen while refreshing.
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 30000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fnRef = useRef(fn); fnRef.current = fn;
  const run = useCallback(async () => {
    const id = ++seq.current; setLoading(true);
    try { const d = await fnRef.current(); if (id === seq.current) { setData(d); setError(null); } }
    catch (e: any) { if (id === seq.current) setError(e.message || 'Failed to load'); }
    finally { if (id === seq.current) setLoading(false); }
  }, []);
  useEffect(() => { run(); const id = intervalMs ? setInterval(run, intervalMs) : undefined; return () => { seq.current++; if (id) clearInterval(id); }; }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload: run };
}
