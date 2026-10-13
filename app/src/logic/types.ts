// API contract types (see docs/ARCHITECTURE.md). Pure TypeScript: no react-native imports, so Node can run the logic tests.
export type Period = 'weekly' | 'monthly';
export type Range = '24h' | '7d' | '30d';
export type DataSel = 'all' | 'real' | 'loadtest';
export type Outcome = 'ok' | 'spend_cap' | 'upstream_error' | 'rejected';

export type Budget = { capCents: number | null; spendCents: number; source: string | null; limitId: string | null; unlimited: boolean };
export type Budgets = Record<'daily' | 'weekly' | 'monthly', Budget>;

export type OverrideStatus = 'scheduled' | 'active' | 'ended' | 'cancelled' | 'superseded' | 'failed';
export type Override = {
  id: string; sub: string; email: string | null; name: string; period: Period; extraCents: number; baseCents: number | null; targetCents: number | null;
  startsAt: string; endsAt: string; reason: string; createdBy: string; createdAt: string; status: OverrideStatus;
  prev: null | { kind: 'none' | 'unlimited' | 'cap'; cents?: number }; appliedAt: string | null; endedAt: string | null; note: string | null;
  /** Optional (newer backends): an active boost whose end has passed without the cap being restored, and by how long. */
  overdue?: boolean; overdueMs?: number;
  /** Optional: the admin who granted it is no longer an admin; the boost still runs to its end. */
  creatorRemoved?: boolean;
};

export type UsageInfo = { source: string; ok: boolean | null };
export type Health = {
  gateway: boolean; usage: UsageInfo; demo: boolean; accounts: boolean; viewAccess: 'open' | 'admin'; admin: { email: string; name: string } | null;
  /** Optional: the server's longest boost in days. The app assumes 90 when absent. */
  maxOverrideDays?: number;
};

export type UserRow = {
  sub: string; email: string | null; name: string; requests: number; ok: number; failed: number;
  lastSeen: string | null; models: string[]; spark: number[]; budgets: Budgets; overrides: Override[];
};
/** Optional on every response that carries boosts: the stored boost state was unreadable, so `overrides` is empty and not to be trusted. */
export type OverridesFlag = { overridesError?: boolean };
export type UsersRes = OverridesFlag & { range: Range; data: DataSel; demo: boolean; usage: UsageInfo; usageConnected: boolean; buckets: string[]; users: UserRow[] };

export type Recent = { ts: string; id: string; sub?: string; email?: string | null; model: string; outcome: string; status: number; ms: number; lt?: boolean; cause: string | null };
export type AuditEvent = {
  id: number; at: string; actor: string; kind: 'created' | 'raised' | 'lowered' | 'removed' | 'unlimited' | 'unchanged' | 'changed';
  scopeType: string; sub: string | null; who: string; period: string; fromCents: number | null; toCents: number | null; hadBefore: boolean;
};

export type Severity = 'info' | 'medium' | 'high';
export type Insight = { id: string; severity: Severity; category: 'model' | 'reliability' | 'budget' | 'telemetry' | string; title: string; description: string; action: string | null; impact: string | null };
export type Coach = { summary: string | null; insights: Insight[] };

export type DetailRes = OverridesFlag & {
  demo: boolean; usage: UsageInfo; usageConnected: boolean; range: Range; data: DataSel; buckets: string[]; bucketSeconds: number;
  orgDefaults: Partial<Record<'daily' | 'weekly' | 'monthly', number | null>>;
  user: { sub: string; email: string | null; name: string; budgets: Budgets; ownLimits: Partial<Record<string, { id: string; amountCents: number | null }>> };
  series: { models: string[]; values: Record<string, number[]> };
  models: { model: string; requests: number; ok: number; p50: number | null }[];
  recent: Recent[]; audit: AuditEvent[]; overrides: Override[]; coach: Coach;
  /** Optional: the gateway audit is capped (500 events), so this person's history may be incomplete. */
  auditTruncated?: boolean;
};
export type CompanyRes = OverridesFlag & {
  demo: boolean; usage: UsageInfo; usageConnected: boolean; range: Range; data: DataSel; buckets: string[];
  totals: { requests: number; ok: number; upstream_errors: number; blocked: number; rejected: number; users: number };
  org: Partial<Record<string, { id: string; amountCents: number | null }>>; userOverrides: number; seats: number;
  spend: Record<Period, { spendCents: number; committedCents: number; uncappedUsers: number }>;
  users: { sub: string; email: string | null; requests: number }[]; series: Record<string, number[]>;
  models: { model: string; requests: number; ok: number }[]; overrides: { active: number; scheduled: number; overdue?: number };
  /** Optional: number of PEOPLE with a personal cap (userOverrides counts limit rows, one person can have several). */
  usersWithOverrides?: number;
};

export type Tier = 'default' | 'upgrade' | 'fast' | string;
export type PriceHint = { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
export type ModelInfo = { alias: string; id: string; label: string; tier: Tier; description: string; enabled: boolean; pricePerMTok: PriceHint | null };
export type ModelsRes = { default: string; models: ModelInfo[]; usage: { model: string; requests: number; ok: number }[] };

export type BudgetPayload = { period: Period; action: 'set' | 'unlimited' | 'inherit'; usd?: number };
export type OverridePayload = { sub: string; period: Period; extraUsd: number; startsAt?: string; endsAt: string; reason: string };
