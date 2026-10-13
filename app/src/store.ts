// localStorage/sessionStorage can throw (private mode, blocked data): every access is guarded.
export function readStore(k: string, session = false): string | null {
  try { return (session ? sessionStorage : localStorage).getItem('gwb:' + k); } catch { return null; }
}
export function writeStore(k: string, v: string | null, session = false) {
  try { const s = session ? sessionStorage : localStorage; v === null ? s.removeItem('gwb:' + k) : s.setItem('gwb:' + k, v); } catch { /* ignore */ }
}
