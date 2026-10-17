// Turning HTTP failures into sentences people can act on. Pure.
import { iapFailureMessage, type AuthMode } from './iap.ts';
export const UNAVAILABLE_TEXT = 'The gateway is unavailable right now, retrying automatically.';
export const UNAVAILABLE_WRITE_TEXT = 'The gateway is unavailable right now. The change may not have been applied: check the page, then try again.';
/** Retry-After header (delta seconds) -> whole seconds, or null. */
export function retryAfterSeconds(h: string | null | undefined): number | null {
  const n = Number(h);
  return h !== null && h !== undefined && h !== '' && Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}
export const isOutageStatus = (s: number) => s === 502 || s === 503 || s === 504;
/** The message for a failed request, or null to use the server's own `error` text. */
export function failureMessage(status: number, method: string, path: string, retryAfter: number | null, mode: AuthMode = 'session', serverText?: string): string | null {
  if (mode === 'iap') { const m = iapFailureMessage(status, serverText); if (m) return m; }
  if (status === 429 && path === '/api/login') return retryAfter ? `Too many attempts, try again in ${retryAfter} s.` : 'Too many attempts, try again in a little while.';
  if (isOutageStatus(status)) return method === 'GET' ? UNAVAILABLE_TEXT : UNAVAILABLE_WRITE_TEXT;
  return null;
}
