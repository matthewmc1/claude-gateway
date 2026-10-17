import { readStore, writeStore } from './store';
import { cleanBudgets, cleanSpend, finite, list } from './logic/sanitize';
import { failureMessage, isOutageStatus, retryAfterSeconds } from './logic/errors';
import { csrfHeaders, parseAuthMode, type AuthMode } from './logic/iap';
import type { AuditEvent, BudgetPayload, CompanyRes, DataSel, DetailRes, Health, ModelsRes, Override, OverridePayload, Range, UsageInfo, UsersRes } from './logic/types';
export * from './logic/types';

// In dev the Expo server runs on :8081 and the API elsewhere; in production the API serves the app from the same origin.
const DEV_API = (typeof process !== 'undefined' && (process as any).env?.EXPO_PUBLIC_API_BASE) || 'http://localhost:8792';
const BASE = typeof window !== 'undefined' && window.location.port === '8081' ? DEV_API : '';

export class ApiError extends Error {
  status: number; retryAfter: number | null;
  constructor(status: number, message: string, retryAfter: number | null = null) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
/** The gateway (or the service in front of it) is down: 502/503/504. The app keeps retrying reads and says so. */
export const isUnavailable = (e: unknown) => e instanceof ApiError && isOutageStatus(e.status);
export class Cancelled extends Error { constructor() { super('cancelled'); } }
export const isCancelled = (e: unknown) => e instanceof Cancelled;

export type Me = { email: string; name: string };
let token: string | null = readStore('token', true);
let onUnauthorized: () => void = () => {};
/** Set from /api/health. In 'iap' mode there is no token at all and every write carries x-app-csrf. */
let authMode: AuthMode = 'session';
export const getAuthMode = () => authMode;
export const setUnauthorizedHandler = (f: () => void) => { onUnauthorized = f; };
export const hasToken = () => authMode !== 'iap' && !!token;
export function signOut() { token = null; writeStore('token', null, true); writeStore('me', null, true); }
/** Revoke every session of this admin on the server (POST /api/logout), then forget the token. Failures are ignored: local state is always cleared. */
export async function logout(): Promise<void> {
  const t = token;
  signOut();
  if (!t) return;
  try { await fetch(BASE + '/api/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-token': t }, body: '{}' }); } catch { /* offline or old backend: nothing to do */ }
}
export const getMe = (): Me | null => { try { return JSON.parse(readStore('me', true) || 'null'); } catch { return null; } };

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    // The session travels in x-app-token. Never Authorization: Cloud Run IAM owns that header.
    r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token && authMode === 'session' ? { 'x-app-token': token } : {}), ...csrfHeaders(authMode, method) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'Cannot reach the budget service. Is it running?'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { signOut(); if (method === 'GET') onUnauthorized(); }   // a failed write is re-prompted by runAdmin
  if (!r.ok) {
    const retryAfter = retryAfterSeconds(r.headers.get('retry-after'));
    const special = failureMessage(r.status, method, path, retryAfter, authMode, j && j.error);
    if (special) throw new ApiError(r.status, special, retryAfter);
    throw new ApiError(r.status, (j && j.error) || `Request failed (${r.status})`, retryAfter);
  }
  return j as T;
}

export async function login(password: string, email = ''): Promise<Me> {
  const j = await req<{ token: string } & Me>('POST', '/api/login', { password, email });
  token = j.token; writeStore('token', token, true); writeStore('me', JSON.stringify({ email: j.email, name: j.name }), true);
  return { email: j.email, name: j.name };
}

const qs = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString();
// Older backends reported `usage` as a boolean; normalise so the UI only deals with { source, ok }.
const usageOf = (j: any): UsageInfo => (j && typeof j.usage === 'object' && j.usage ? j.usage : { source: j?.usageConnected === false || j?.usage === null ? 'none' : 'logs', ok: typeof j?.usage === 'boolean' ? j.usage : null });
const withUsage = <T extends { usage?: unknown }>(j: T): T & { usage: UsageInfo; usageConnected: boolean } => { const usage = usageOf(j); return { ...j, usage, usageConnected: usage.source !== 'none' }; };

export const getUsers = (range: Range, data: DataSel) => req<UsersRes>('GET', '/api/users' + qs({ range, data })).then((j) => ({ ...withUsage(j), users: list(j.users).map((u) => ({ ...u, budgets: cleanBudgets(u.budgets), requests: finite(u.requests), ok: finite(u.ok), failed: finite(u.failed), spark: list(u.spark).map((x) => finite(x)), models: list(u.models), overrides: j.overridesError ? [] : list(u.overrides) })) }));
export const getUser = (sub: string, range: Range, data: DataSel) => req<DetailRes>('GET', `/api/users/${encodeURIComponent(sub)}` + qs({ range, data }))
  .then((j) => ({ ...withUsage(j), user: { ...j.user, budgets: cleanBudgets(j.user?.budgets), ownLimits: j.user?.ownLimits ?? {} }, overrides: j.overridesError ? [] : list(j.overrides), recent: list(j.recent), audit: list(j.audit), models: list(j.models), coach: j.coach ?? { summary: null, insights: [] } }));
export const getCompany = (range: Range, data: DataSel) => req<CompanyRes>('GET', '/api/company' + qs({ range, data })).then((j) => ({ ...withUsage(j), overrides: j.overridesError ? { active: 0, scheduled: 0 } : (j.overrides ?? { active: 0, scheduled: 0 }), spend: { weekly: cleanSpend(j.spend?.weekly), monthly: cleanSpend(j.spend?.monthly) }, users: list(j.users), models: list(j.models), seats: finite(j.seats), userOverrides: finite(j.userOverrides), totals: { requests: finite(j.totals?.requests), ok: finite(j.totals?.ok), upstream_errors: finite(j.totals?.upstream_errors), blocked: finite(j.totals?.blocked), rejected: finite(j.totals?.rejected), users: finite(j.totals?.users) } }));
export const getModels = (range: Range, data: DataSel) => req<ModelsRes>('GET', '/api/models' + qs({ range, data }));
export const getAudit = () => req<{ events: AuditEvent[] }>('GET', '/api/audit?limit=200');
export const getOverrides = (status?: string) => req<{ overrides: Override[]; overridesError?: boolean }>('GET', '/api/overrides' + (status ? qs({ status }) : '')).then((j) => ({ ...j, overrides: j.overridesError ? [] : list(j.overrides) }));
export const setUserBudget = (sub: string, p: BudgetPayload) => req('PUT', `/api/users/${encodeURIComponent(sub)}/budget`, p);
export const setOrgBudget = (p: BudgetPayload) => req('PUT', '/api/org/budget', p);
export const createOverride = (p: OverridePayload) => req<Override>('POST', '/api/overrides', p);
export const cancelOverride = (id: string) => req<Override>('DELETE', `/api/overrides/${encodeURIComponent(id)}`);
/** POST /api/overrides/:id/retry. Older backends answer 404; callers hide the Retry button when `isMissing(e)`. */
export const retryOverride = (id: string) => req<Override>('POST', `/api/overrides/${encodeURIComponent(id)}/retry`);
export const isMissing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405);
export const health = () => req<any>('GET', '/api/health').then((j): Health => {
  authMode = parseAuthMode(j.auth);
  if (authMode === 'iap' && token) signOut();       // a leftover password session means nothing behind IAP
  return {
  auth: authMode, identity: j.identity && j.identity.email ? { email: String(j.identity.email), name: String(j.identity.name || j.identity.email), admin: !!j.identity.admin } : null,
  gateway: !!j.gateway, usage: usageOf(j), demo: !!j.demo, accounts: !!j.accounts, viewAccess: j.viewAccess === 'admin' ? 'admin' : 'open', admin: j.admin && j.admin.email ? { email: j.admin.email, name: j.admin.name || j.admin.email } : null,
  ...(Number.isFinite(j.maxOverrideDays) ? { maxOverrideDays: Number(j.maxOverrideDays) } : {}),
  };
});
