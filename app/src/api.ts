import { readStore, writeStore } from './store';

export type Period = 'weekly' | 'monthly';
export type Range = '24h' | '7d' | '30d';
export type DataSel = 'all' | 'real' | 'loadtest';
export type Budget = { capCents: number | null; spendCents: number; source: string | null; limitId: string | null; unlimited: boolean };
export type Budgets = Record<'daily' | 'weekly' | 'monthly', Budget>;
export type UserRow = {
  sub: string; email: string | null; name: string; requests: number; ok: number; failed: number;
  lastSeen: string | null; models: string[]; spark: number[]; budgets: Budgets;
};
export type UsersRes = { range: Range; data: DataSel; demo: boolean; usageConnected: boolean; buckets: string[]; users: UserRow[] };
export type Recent = { ts: string; id: string; model: string; outcome: string; status: number; ms: number; cause: string | null };
export type AuditEvent = {
  id: number; at: string; actor: string; kind: 'created' | 'raised' | 'lowered' | 'removed' | 'unlimited' | 'unchanged' | 'changed';
  scopeType: string; sub: string | null; who: string; period: string; fromCents: number | null; toCents: number | null; hadBefore: boolean;
};
export type DetailRes = {
  demo: boolean; usageConnected: boolean; range: Range; data: DataSel; buckets: string[]; bucketSeconds: number;
  orgDefaults: Partial<Record<'daily' | 'weekly' | 'monthly', number | null>>;
  user: { sub: string; email: string | null; name: string; budgets: Budgets; ownLimits: Partial<Record<string, { id: string; amountCents: number | null }>> };
  series: { models: string[]; values: Record<string, number[]> };
  models: { model: string; requests: number; ok: number; p50: number | null }[];
  recent: Recent[]; audit: AuditEvent[];
};
export type CompanyRes = {
  demo: boolean; usageConnected: boolean; range: Range; data: DataSel; buckets: string[];
  totals: { requests: number; ok: number; upstream_errors: number; blocked: number; rejected: number; users: number };
  org: Partial<Record<string, { id: string; amountCents: number | null }>>; userOverrides: number; seats: number;
  spend: Record<Period, { spendCents: number; committedCents: number; uncappedUsers: number }>;
  users: { sub: string; email: string | null; requests: number }[]; series: Record<string, number[]>;
  models: { model: string; requests: number; ok: number }[];
};
export type BudgetPayload = { period: Period; action: 'set' | 'unlimited' | 'inherit'; usd?: number };

// In dev the Expo server runs on :8081; in production the API serves the app from the same origin.
const BASE = typeof window !== 'undefined' && window.location.port === '8081' ? 'http://localhost:8792' : '';
let token: string | null = readStore('token', true);
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (f: () => void) => { onUnauthorized = f; };
export const hasToken = () => !!token;
export function signOut() { token = null; writeStore('token', null, true); writeStore('me', null, true); }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-app-token': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error('Cannot reach the budget service. Is scripts/run-app.sh running?'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { signOut(); onUnauthorized(); }
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j as T;
}
export type Me = { email: string; name: string };
export const getMe = (): Me | null => { try { return JSON.parse(readStore('me', true) || 'null'); } catch { return null; } };
export async function login(password: string, email = ''): Promise<Me> {
  const j = await req<{ token: string } & Me>('POST', '/api/login', { password, email });
  token = j.token; writeStore('token', token, true); writeStore('me', JSON.stringify({ email: j.email, name: j.name }), true);
  return { email: j.email, name: j.name };
}
const qs = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString();
export const getUsers = (range: Range, data: DataSel) => req<UsersRes>('GET', '/api/users' + qs({ range, data }));
export const getUser = (sub: string, range: Range, data: DataSel) => req<DetailRes>('GET', `/api/users/${encodeURIComponent(sub)}` + qs({ range, data }));
export const getCompany = (range: Range, data: DataSel) => req<CompanyRes>('GET', '/api/company' + qs({ range, data }));
export const getAudit = () => req<{ events: AuditEvent[] }>('GET', '/api/audit?limit=200');
export const setUserBudget = (sub: string, p: BudgetPayload) => req('PUT', `/api/users/${encodeURIComponent(sub)}/budget`, p);
export const setOrgBudget = (p: BudgetPayload) => req('PUT', '/api/org/budget', p);
export const health = () => req<{ gateway: boolean; usage: boolean | null; demo: boolean; accounts: boolean }>('GET', '/api/health');
