// Hash routing and page metadata. Pure.
export type Tab = 'people' | 'my-usage' | 'company' | 'models' | 'activity';
export const TAB_META: { key: Tab; label: string; title: string; sub: string }[] = [
  { key: 'people', label: 'People', title: 'People', sub: 'Usage, budget caps and temporary boosts for each person using Claude through the gateway. Open a card to manage their budget.' },
  { key: 'my-usage', label: 'My usage & coach', title: 'My usage & cost coach', sub: 'Your spend against your budgets, how your recent requests went, and practical tips for getting more from them.' },
  { key: 'company', label: 'Company', title: 'Company', sub: 'Default per-person budgets, committed exposure and fleet-wide usage across the organization.' },
  { key: 'models', label: 'Models', title: 'Models', sub: 'The Claude models people can use through the gateway, who they are for, and how much traffic each carries.' },
  { key: 'activity', label: 'Activity', title: 'Budget activity', sub: 'Every temporary boost and every change to a spend cap, from the gateway audit log.' },
];
export const TABS: Tab[] = TAB_META.map((t) => t.key);
export function parseHash(hash: string): { tab: Tab; sub: string | null } {
  const h = hash.replace(/^#\/?/, '').split('/');
  const tab = TABS.find((x) => x === h[0]) ?? 'people';
  let sub: string | null = null;
  if (tab === 'people' && h[1]) { try { sub = decodeURIComponent(h[1]); } catch { sub = h[1]; } }
  return { tab, sub };
}
export const hashFor = (tab: Tab, sub?: string | null) => `/${tab}${sub ? '/' + encodeURIComponent(sub) : ''}`;
export const pageTitle = (tab: Tab) => `${TAB_META.find((t) => t.key === tab)!.title} · Gateway Budgets`;
/** `?theme=light|dark` forces a theme (used for screenshots); anything else is ignored. */
export function themeFromSearch(search: string): 'light' | 'dark' | null {
  const v = new URLSearchParams(search).get('theme');
  return v === 'light' || v === 'dark' ? v : null;
}
/** Remembered person if still listed, else the signed-in admin if they are a user, else the first user. */
export function pickDefaultUser(users: { sub: string; email: string | null }[], remembered: string | null, adminEmail: string | null): string | null {
  if (!users.length) return null;
  if (remembered && users.some((u) => u.sub === remembered)) return remembered;
  if (adminEmail) { const me = users.find((u) => u.email && u.email.toLowerCase() === adminEmail.toLowerCase()); if (me) return me.sub; }
  return users[0].sub;
}
/** Read access is admin-only on the backend and nobody is signed in: show the sign-in page instead of data. */
export const needsGate = (viewAccess: string | undefined, admin: unknown) => viewAccess === 'admin' && !admin;
