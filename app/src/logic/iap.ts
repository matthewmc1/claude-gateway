// Behind Google Identity-Aware Proxy (`/api/health` says `auth: "iap"`): no login form, the company sign-in is the identity. Pure.
export type AuthMode = 'session' | 'iap';
export type Identity = { email: string; name: string; admin: boolean };

export const parseAuthMode = (v: unknown): AuthMode => (v === 'iap' ? 'iap' : 'session');
/** Every write in iap mode carries this header: it forces a CORS preflight a cross-site page cannot get, which is what stops CSRF with the ambient IAP cookie. */
export const csrfHeaders = (mode: AuthMode, method: string): Record<string, string> => (mode === 'iap' && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' ? { 'x-app-csrf': '1' } : {});

export const NOT_ALLOWED_TEXT = 'Your company sign-in did not let you through: it may have expired, or your account is not allowed to use this app. Reload the page to sign in again; if that does not help, ask an admin to give your account access.';
export const NOT_ADMIN_TEXT = 'Only admins can change budgets. You are signed in through your company sign-in but are not on the admin list: ask an admin.';
export const REFUSED_TEXT = 'The request was refused because it did not look like it came from this page. Reload the page and try again.';
/** The sentence for a failed request in iap mode, or null to use the default handling. 401 = not let through by IAP, 403 = signed in but not an admin (or refused as cross-site). */
export function iapFailureMessage(status: number, serverText?: string): string | null {
  if (status === 401) return NOT_ALLOWED_TEXT;
  if (status === 403) return /cross-site|non-browser|cross-origin/i.test(serverText || '') ? REFUSED_TEXT : NOT_ADMIN_TEXT;
  return null;
}

export const identityLine = (id: { email: string }) => `Signed in as ${id.email} via your company sign-in`;
export const roleLine = (admin: boolean) => (admin ? 'Admin: you can change budgets' : 'Viewer: read-only. Ask an admin to change budgets');

export type GateKind = 'none' | 'session' | 'iap-denied' | 'iap-not-admin';
/** What replaces the app: the password page (session mode, private data), or a notice (iap mode: not let through, or not an admin on an admin-only deployment). */
export function gateKind(h: { auth?: string; viewAccess?: string; identity?: { admin: boolean } | null; admin?: unknown } | null, denied: boolean): GateKind {
  if (denied) return 'iap-denied';
  if (!h) return 'none';
  if (h.auth === 'iap') return h.viewAccess === 'admin' && !h.identity?.admin ? 'iap-not-admin' : 'none';
  return h.viewAccess === 'admin' && !h.admin ? 'session' : 'none';
}
