// Fictional cast for demo mode (APP_DEMO=1) and tests. Shared by the in-memory gateway seed and the synthetic traffic generator so
// the budgets, spend and request history tell one consistent story. Everyone is made up; emails use example.com.
//
// profile.weight   relative request volume          profile.mix        share of requests per model alias (sums to 1)
// profile.errorRate fraction of requests the provider fails (quota / permission)           profile.hours  [start, end) local working hours (UTC)
// budget.weeklyPct / monthlyPct  how much of the effective cap is already spent (can exceed 1 for a user at their limit)
// budget.personal  personal caps in cents (null = inherit the company default)  ·  budget.unlimited  personal override of "no limit"
export const DEMO_ORG = { weeklyCents: 15000, monthlyCents: 50000 };

export const DEMO_USERS = [
  { sub: 'demo-ada',    email: 'ada@example.com',    name: 'Ada Okafor',     profile: { weight: 1.7, mix: { sonnet: 0.62, opus: 0.30, haiku: 0.08 }, errorRate: 0.02, hours: [8, 17] },  budget: { weeklyPct: 0.55, monthlyPct: 0.48, personal: null } },
  { sub: 'demo-ben',    email: 'ben@example.com',    name: 'Ben Hartley',    profile: { weight: 1.2, mix: { sonnet: 0.20, opus: 0.74, haiku: 0.06 }, errorRate: 0.01, hours: [9, 18] },  budget: { weeklyPct: 0.91, monthlyPct: 0.74, personal: null } },
  { sub: 'demo-chen',   email: 'chen@example.com',   name: 'Chen Wei',       profile: { weight: 1.0, mix: { sonnet: 0.80, opus: 0.05, haiku: 0.15 }, errorRate: 0.01, hours: [7, 16] },  budget: { weeklyPct: 0.38, monthlyPct: 0.41, personal: null } },
  { sub: 'demo-dara',   email: 'dara@example.com',   name: 'Dara Ncube',     profile: { weight: 0.9, mix: { sonnet: 0.70, opus: 0.20, haiku: 0.10 }, errorRate: 0.22, hours: [10, 19] }, budget: { weeklyPct: 0.30, monthlyPct: 0.36, personal: null } },
  { sub: 'demo-eli',    email: 'eli@example.com',    name: 'Eli Moreau',     profile: { weight: 1.4, mix: { sonnet: 0.55, opus: 0.35, haiku: 0.10 }, errorRate: 0.02, hours: [8, 17] },  budget: { weeklyPct: 1.0,  monthlyPct: 0.83, personal: null } },
  { sub: 'demo-fatima', email: 'fatima@example.com', name: 'Fatima Rahman',  profile: { weight: 0.5, mix: { sonnet: 0.60, opus: 0.10, haiku: 0.30 }, errorRate: 0.01, hours: [9, 17] },  budget: { weeklyPct: 0.14, monthlyPct: 0.19, personal: null } },
  { sub: 'demo-gus',    email: 'gus@example.com',    name: 'Gus Lindqvist',  profile: { weight: 1.1, mix: { sonnet: 0.58, opus: 0.32, haiku: 0.10 }, errorRate: 0.03, hours: [6, 15] },  budget: { weeklyPct: 0.62, monthlyPct: 0.58, personal: { weeklyCents: 25000, monthlyCents: 80000 } } },
  { sub: 'demo-hana',   email: 'hana@example.com',   name: 'Hana Sato',      profile: { weight: 0.8, mix: { sonnet: 0.72, opus: 0.18, haiku: 0.10 }, errorRate: 0.02, hours: [11, 20] }, budget: { weeklyPct: 0.27, monthlyPct: 0.33, personal: { weeklyCents: 8000, monthlyCents: 30000 } } },
  { sub: 'demo-ivo',    email: 'ivo@example.com',    name: 'Ivo Petrov',     profile: { weight: 1.3, mix: { sonnet: 0.50, opus: 0.40, haiku: 0.10 }, errorRate: 0.02, hours: [8, 17] },  budget: { weeklyPct: 0.47, monthlyPct: 0.52, unlimited: true } },
  { sub: 'demo-june',   email: 'june@example.com',   name: 'June Alvarez',   profile: { weight: 0.3, mix: { sonnet: 0.85, opus: 0.00, haiku: 0.15 }, errorRate: 0.00, hours: [9, 15] },  budget: { weeklyPct: 0.06, monthlyPct: 0.09, personal: null } },
];

// Who administers the demo.
export const DEMO_ADMIN = { email: 'admin@example.com', name: 'Demo Admin', password: 'demo-admin' };
