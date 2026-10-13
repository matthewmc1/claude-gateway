// Temporary budget boosts that revert on their own (on-call week, launch, incident). THIS CODE EDITS REAL SPEND CAPS UNATTENDED.
//
// Lifecycle:  scheduled -> active -> ended          (the normal path)
//             scheduled|active -> cancelled         (an admin cancelled it; an active boost is reverted first. Also: the creator was removed while it was still scheduled)
//             active -> superseded                  (someone changed the personal cap by hand: we leave their value alone)
//             scheduled -> failed                   (nothing to extend when it started, or it could not be applied; `retry(id)` can try again)
//
// THE INVARIANT: after every boost in a chain has ended, the user's personal cap is what it was before the FIRST boost of the chain began
// (no personal limit, unlimited, or the old cap), unless a person edited it by hand in between (then their edit wins, see below).
// It holds because
//  - A boost is never activated for a user+period while another boost for the same user+period is `active` (its revert may still be
//    pending or failing) or is mid-activation. The later boost is DEFERRED (note "waiting for ...") and retried every tick; it takes its
//    base/prev from the cap the earlier one restored, never from a still-boosted cap. If the earlier one can never be reverted the later one
//    simply expires unapplied (`failed`, "window passed") - it can never stack on top of it.
//  - Before touching the gateway we persist what we are about to do (`prev` + `targetCents`). If we crash half way, the next worker
//    looks at the gateway and finishes the job rather than starting over (which would stack the boost twice).
//  - COMPARE BEFORE WRITE: every gateway write (activate, retarget, revert) is immediately preceded by a fresh read of that user's live
//    personal cap, and happens only if it is what the plan assumed. If it is not, nothing is written: an activation that finds a changed cap
//    is `failed` ("changed by hand before the boost could start", retryable); a retarget or revert that finds one marks the boost
//    `superseded` and leaves the person's value alone. We also re-read the stored claim right before each write and stop if the lease is no
//    longer ours. RESIDUAL RACE: the gateway has no conditional write, so an edit landing in the few milliseconds between that read and the
//    write cannot be detected; it is then overwritten by the boost target and, at the end, restored to the pre-boost value.
//  - Store update functions have no side effects (the GCS store may retry them); gateway calls happen outside them.
//
// Every tick reconciles EVERY active boost against ONE listLimits() result, so no `active` record outlives its cap: the personal cap is the
// target (healthy) -> nothing; it is back at the recorded `prev` (it was restored but the final record write failed) -> the record is closed as
// `ended`; it is something else (a hand edit) -> `superseded`. An idle tick therefore costs one store read and one listLimits() call and
// performs NO store writes (it used to rewrite the whole document twice per boost). Due work is processed in batches of 20 with a time
// budget per tick (20 s, always at least one batch per phase); what is left stays due and is picked up by the next tick.
//
// Leases (L12/N5): a claim is a lease of CLAIM_MS held on the stored override. Other instances judge it with THEIR wall clock, so it is
// generous (5 min) and a lease stamped far in the future (a skewed instance) is ignored rather than honoured for hours. Our own
// worker judges its own lease with a MONOTONIC clock (it cannot be fooled by a wall-clock step in the middle of a tick), renews it per item,
// and re-reads the stored claim before every gateway write: if another worker took the item over, we stop. Even if two workers do overlap,
// every gateway step is "read live state, then act only if it matches the stored plan", so a double run converges instead of stacking.
//
// Organisation default changing mid-boost (L2): a personal cap overrides the org default. The rule is
//  - prev `none` and the base came from the org default: the boosted user is meant to be "org default + extra" for the whole boost. When an
//    admin raises/lowers the org default the boost is re-targeted to (new default + extra) at the next tick, so a boosted user is never
//    left with less than everyone else. If the org default became unlimited (or was deleted) the boost is no longer needed: it ends early
//    and the personal cap is removed. At the end the personal cap is deleted, so they follow whatever the default is by then.
//  - prev `cap` / `unlimited` (an explicit personal decision): org changes do not touch it; at the end the exact previous value is restored
//    (a personal cap that is lower than the org default is a deliberate restriction, so it is NOT silently deleted).
//
// Attribution and removed admins (F5/N11): the gateway audit shows the SYSTEM actor ('system:overrides') for automatic changes; the
// override record carries `createdBy` (the admin who asked). Automatic changes use the system write key only; in accounts mode
// (cfg.admins non-empty) there is NO fallback to any admin's personal key: no system key = fail closed. When the creator is no longer in
// cfg.admins (an offboarded admin, or a typo in APP_ADMINS) their SCHEDULED boosts are cancelled (note "creator removed"), but their
// ACTIVE boosts are NOT touched: they are bounded, so they run to their scheduled end, carry `creatorRemoved: true`, and log an
// `override.creator-removed` warning on every tick so someone can look (cancel them by hand if they should stop). A config typo must not
// instantly cut off everyone's boosted caps. Local single-admin mode (no cfg.admins) is exempt.
//
// Log events worth alerting on: override.overdue (warn, every tick while an active boost is past its end), override.error (a gateway or
// store step failed; it is retried next tick), override.lost-claim (another worker took an item over: expected rarely, a flood means
// clock trouble), override.failed (a boost could not start; look at `reason`), override.creator-removed (warn), override.superseded.
import crypto from 'node:crypto';
import { HttpError } from './http.mjs';
import { StoreError } from './store.mjs';

export const OVERRIDE_PERIODS = ['weekly', 'monthly'];
export const OVERRIDE_STATUSES = ['scheduled', 'active', 'ended', 'cancelled', 'superseded', 'failed'];
const SUB_RE = /^[A-Za-z0-9_-]{1,200}$/;
const LIVE = new Set(['scheduled', 'active']);
const HOUR = 3600e3, DAY = 86400e3;
const CLAIM_MS = 5 * 60e3, MAX_ATTEMPTS = 4, KEEP_MS = 180 * DAY, MAX_USD = 100000, MAX_FUTURE_START_MS = 366 * DAY, PAST_SLACK_MS = 5 * 60e3;
const BATCH = 20, DEFAULT_BUDGET_MS = 20e3;
const DOC = 'overrides', EMPTY = { items: [] };
const WAIT_NOTE = 'waiting for an earlier boost for this user to finish reverting';
// control characters, zero-width and bidirectional override/isolate characters: never stored or rendered in a reason
const UNSAFE_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]', 'g');

const rid = (n = 6) => crypto.randomBytes(n).toString('hex');
const toCents = (usd) => Math.round(usd * 100);
// Only plain decimal numbers with at most two decimals: no "1e3", "0x10", " 12 ", 1.005.
const parseUsd = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? v : NaN;
  return typeof v === 'string' && /^\d{1,6}(\.\d{1,2})?$/.test(v) ? Number(v) : NaN;
};
const parseDate = (v) => (typeof v === 'string' && v.length <= 40 ? Date.parse(v) : NaN);
const personalScope = (sub) => ({ type: 'user', user_id: sub });
const kindOf = (limit) => (!limit ? { kind: 'none' } : limit.amount === null ? { kind: 'unlimited' } : { kind: 'cap', cents: Number(limit.amount) });
const sameState = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind !== 'cap' || a.cents === b.cents);
const hasPlan = (o) => !!o.prev && o.targetCents !== null && o.targetCents !== undefined;
// The live personal cap is "ours" if it equals the target of this boost, or a target we were in the middle of moving away from (retarget).
const holds = (state, o) => state.kind === 'cap' && (state.cents === o.targetCents || (o.prevTargets || []).includes(state.cents));
// What an ACTIVE boost's live personal cap says about it: still in force / already back at the pre-boost value / changed by someone.
const verdict = (state, o) => (holds(state, o) ? 'healthy' : !hasPlan(o) || sameState(state, o.prev) ? 'restored' : 'changed');
const msg = (e) => String(e?.message || e).slice(0, 200);
const defaultLog = (o) => console.log(JSON.stringify(o));
const leaseLive = (claim, t) => !!claim && Math.abs(t - claim.at) < CLAIM_MS;
const same = (a, b) => a.sub === b.sub && a.period === b.period;
const docShape = (d) => !!d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.items) && d.items.every((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string' && typeof x.sub === 'string');
const SHAPE = { shape: docShape };
const badShape = () => new StoreError('the overrides document has an unexpected shape (valid JSON, but not what the app writes)');
class LostClaim extends Error { constructor() { super('lease lost'); this.name = 'LostClaim'; } }

export function createOverrides({ store, gateway, cfg, now = () => Date.now(), log = defaultLog, mono = () => performance.now(), budgetMs = DEFAULT_BUDGET_MS }) {
  const isoNow = () => new Date(now()).toISOString();
  const pub = ({ claim, attempts, prevTargets, creatorRemoved, ...o }) => {
    const t = now(), overdueMs = o.status === 'active' ? Math.max(0, t - Date.parse(o.endsAt)) : 0;
    return { ...o, creatorRemoved: !!creatorRemoved, overdue: overdueMs > 0, overdueMs, retryable: o.status === 'failed' && Date.parse(o.endsAt) > t };   // additive fields (not all stored)
  };
  const sysWho = () => {
    const accounts = !!cfg.admins?.length;
    // accounts mode: ONLY the system key (never borrow an admin's personal key: the audit would blame a person for automatic changes)
    const key = cfg.systemKey || (accounts ? '' : cfg.writeKey) || (cfg.demo ? 'demo-system' : '');
    if (!key) throw new HttpError(500, 'no gateway write key is configured for automatic changes (set GATEWAY_SYSTEM_WRITE_KEY)');
    return { key, actor: 'system:overrides' };
  };

  // ---- reading the stored document / the gateway ----
  const readDoc = async () => { const d = await store.get(DOC, EMPTY, SHAPE); if (!docShape(d)) throw badShape(); return d; };
  const upd = (fn) => store.update(DOC, (doc) => { if (!docShape(doc)) throw badShape(); return fn(doc); }, EMPTY, SHAPE);
  const get = async (id) => (await readDoc()).items.find((o) => o.id === id) || null;

  const stateFromLimits = (limits, sub, period) => {
    const limit = limits.find((l) => l.scope?.type === 'user' && l.scope.user_id === sub && l.period === period) || null;
    return { ...kindOf(limit), limit };
  };
  // One small call: the effective row says where the cap comes from. source.type 'user' = a personal limit exists (amount null = unlimited).
  async function effRow(sub, period) {
    const row = (await gateway.effective([sub])).find((r) => r.scope?.user_id === sub && r.period === period);
    if (!row) throw new Error('the gateway returned no effective row for this user and period');   // never read "no row" as "no personal limit"
    const personal = row.source?.type === 'user';
    const state = personal ? { ...kindOf({ amount: row.amount ?? null }), limit: { id: row.spend_limit_id } } : { kind: 'none', limit: null };
    return { state, cap: row.amount !== null && row.amount !== undefined ? Number(row.amount) : null, hasLimit: !!row.source, source: row.source?.type || null, actor: row.actor || null };
  }

  // ---- leases ----
  const leases = new Map();                                        // claimId -> monotonic time of our last renewal (we judge OUR lease by this, not by the wall clock)
  async function claim(kind, select, limit = Infinity) {
    const t = now(), claimId = rid(), claimed = [];
    await upd((doc) => {
      claimed.length = 0;
      doc.items = doc.items.filter((o) => LIVE.has(o.status) || t - Date.parse(o.endedAt || o.endsAt) < KEEP_MS);   // prune old history
      const ctx = { started: new Set() };
      for (const o of doc.items) {
        if (claimed.length >= limit) break;
        if (!select(o, t, doc, ctx) || leaseLive(o.claim, t)) continue;
        o.claim = { id: claimId, at: t, kind };
        claimed.push(o.id);
      }
      return doc;
    });
    if (claimed.length) leases.set(claimId, mono());
    return claimed.map((id) => ({ id, claimId }));
  }
  // Start selection: due, and never while another boost for the same user+period is active / mid-activation (H1).
  const selectStart = (only, skip) => (o, t, doc, ctx) => {
    if (o.status !== 'scheduled' || Date.parse(o.startsAt) > t || skip?.has(o.id) || (only && !only.has(o.id))) return false;
    if (Date.parse(o.endsAt) <= t && !hasPlan(o)) return true;              // window already over: it will just fail, touching nothing
    const key = o.sub + '|' + o.period;
    const blocked = ctx.started.has(key) || doc.items.some((x) => x !== o && same(x, o) &&
      (x.status === 'active' || (x.status === 'scheduled' && (hasPlan(x) || (x.claim?.kind === 'start' && leaseLive(x.claim, t))))));
    if (blocked) { if (!hasPlan(o) && o.note !== WAIT_NOTE) o.note = WAIT_NOTE; return false; }
    ctx.started.add(key);
    return true;
  };
  const selectEnd = (only, skip) => (o, t) => o.status === 'active' && Date.parse(o.endsAt) <= t && !skip?.has(o.id) && (!only || only.has(o.id));
  const selectId = (id) => (o, t) => o.id === id && o.status === 'active' && Date.parse(o.endsAt) > t;
  const mutate = async (id, claimId, patch, { keepClaim = false } = {}) => {
    let ok = false;
    await upd((doc) => {
      ok = false;
      const o = doc.items.find((x) => x.id === id);
      if (!o || o.claim?.id !== claimId) return doc;
      Object.assign(o, typeof patch === 'function' ? patch(o) : patch);
      if (keepClaim) o.claim.at = now(); else delete o.claim;
      ok = true;
      return doc;
    });
    if (!ok) log({ evt: 'override.lost-claim', id });
    else if (keepClaim) leases.set(claimId, mono()); else leases.delete(claimId);
    return ok;
  };
  const renew = (id, claimId) => mutate(id, claimId, {}, { keepClaim: true });   // a long tick keeps the leases it still has to work on alive
  // Right before a gateway write: is this item still ours? (our monotonic lease not run out, and the stored claim is still our claim)
  async function mine(id, claimId) {
    const since = leases.get(claimId);
    if (since === undefined) throw new LostClaim();
    if (mono() - since > CLAIM_MS / 2) { if (!(await renew(id, claimId))) throw new LostClaim(); return; }
    const o = await get(id);
    if (o?.claim?.id !== claimId) { log({ evt: 'override.lost-claim', id }); throw new LostClaim(); }
  }

  // ---- gateway work (always: mine() -> fresh read of the live cap -> compare -> write) ----
  async function restore(o, st) {
    const who = sysWho();
    if (o.prev?.kind === 'none') await gateway.remove(st.limit.id, who);
    else await gateway.upsert(personalScope(o.sub), o.period, o.prev?.kind === 'cap' ? o.prev.cents : null, who);
  }

  // Revert a boost (or settle one that may have been half applied). `final` is the status to record when it reverts cleanly.
  async function revert(o, claimId, final, why = null) {
    await mine(o.id, claimId);
    const st = (await effRow(o.sub, o.period)).state;               // read the live cap right before acting on it
    let status = final, note = null, did = false;
    if (!hasPlan(o)) {                                             // never got as far as touching the gateway
      note = null;
    } else if (holds(st, o)) {
      await restore(o, st); did = true;
    } else if (sameState(st, o.prev)) {
      note = 'the personal limit was already back at its previous value';
    } else {
      status = final === 'cancelled' ? 'cancelled' : 'superseded';
      note = 'the personal limit was changed by hand during the boost, so it was left as it is';
    }
    if (why) note = note ? `${why}; ${note}` : why;
    const ok = await mutate(o.id, claimId, { status, endedAt: isoNow(), note });
    if (ok) log({ evt: 'override.ended', id: o.id, sub: o.sub, period: o.period, status, restored: did, prev: o.prev?.kind ?? null, ...(why ? { why } : {}) });
    return { ok, status };
  }

  const failStart = async (o, claimId, note, reason) => {
    const ok = await mutate(o.id, claimId, { status: 'failed', prev: null, targetCents: null, endedAt: isoNow(), note });
    log({ evt: 'override.failed', id: o.id, sub: o.sub, reason });
    return ok ? 'failed' : 'lost';
  };
  const markActive = (o, claimId, extra = {}) => mutate(o.id, claimId, { status: 'active', appliedAt: o.appliedAt || isoNow(), note: null, ...extra });

  // The atomic form of "never activate while another boost for this user+period is active or mid-activation": the plan is only
  // written if, in the same store update, no sibling is active or holds a plan. (The claim-time check can be stale: a worker's wall
  // clock may have jumped, or two workers may have claimed siblings in turn.)
  async function planStart(o, claimId, intent) {
    let result = 'lost';
    await upd((doc) => {
      result = 'lost';
      const x = doc.items.find((y) => y.id === o.id);
      if (!x || x.claim?.id !== claimId) return doc;
      if (doc.items.some((y) => y !== x && same(y, x) && (y.status === 'active' || (y.status === 'scheduled' && hasPlan(y))))) {
        delete x.claim; if (x.note !== WAIT_NOTE) x.note = WAIT_NOTE; result = 'deferred'; return doc;
      }
      Object.assign(x, { ...intent, prevTargets: [] }); x.claim.at = now(); result = 'planned';
      return doc;
    });
    if (result === 'lost') log({ evt: 'override.lost-claim', id: o.id });
    else if (result === 'planned') leases.set(claimId, mono()); else leases.delete(claimId);
    return result;
  }

  async function activate(o, claimId) {
    let intent = hasPlan(o) ? { prev: o.prev, baseCents: o.baseCents, targetCents: o.targetCents } : null;
    let row = null;
    if (intent) {                                                  // a previous attempt got part way: look at what the gateway says
      row = await effRow(o.sub, o.period);
      if (holds(row.state, o)) {
        const ok = await markActive(o, claimId);
        if (ok) log({ evt: 'override.applied', id: o.id, sub: o.sub, period: o.period, targetCents: intent.targetCents, recovered: true });
        return ok ? 'applied' : 'lost';
      }
      if (!sameState(row.state, intent.prev)) return failStart(o, claimId, 'the personal limit was changed by hand before the boost could start', 'changed-before-start');
    }
    if (now() >= Date.parse(o.endsAt)) return failStart(o, claimId, 'the boost window passed before it could start', 'window-elapsed');
    if (!intent) {
      row = await effRow(o.sub, o.period);
      if (row.cap === null) return failStart(o, claimId, row.hasLimit ? 'the user is unlimited now, so there is no cap to extend' : 'the user has no budget cap to extend', 'no-cap');
      const st = row.state;
      intent = { prev: { kind: st.kind, ...(st.kind === 'cap' ? { cents: st.cents } : {}) }, baseCents: row.cap, baseSource: row.source, targetCents: row.cap + o.extraCents };
      const planned = await planStart(o, claimId, intent);       // persist the plan BEFORE changing anything
      if (planned === 'lost') return 'lost';
      if (planned === 'deferred') return 'deferred';
    }
    await mine(o.id, claimId);
    const cur = (await effRow(o.sub, o.period)).state;             // compare before write: the plan was made from older reads
    if (holds(cur, { targetCents: intent.targetCents })) { const ok = await markActive(o, claimId); return ok ? 'applied' : 'lost'; }
    if (!sameState(cur, intent.prev)) return failStart({ ...o, ...intent }, claimId, 'the personal limit was changed by hand before the boost could start', 'changed-before-start');
    await gateway.upsert(personalScope(o.sub), o.period, intent.targetCents, sysWho());
    const ok = await markActive(o, claimId);
    if (ok) log({ evt: 'override.applied', id: o.id, sub: o.sub, period: o.period, baseCents: intent.baseCents, targetCents: intent.targetCents, prev: intent.prev.kind });
    return ok ? 'applied' : 'lost';
  }

  // After a gateway error: release the lease so the next tick retries; give up on a start only once we can prove nothing was applied.
  // A start that gave up is `failed` but `retryable` (see retry()).
  async function onStartError(o0, claimId, e) {
    const o = (await get(o0.id).catch(() => null)) || o0;           // reload: the attempt may have stored its plan before failing
    const attempts = (o.attempts || 0) + 1;
    log({ evt: 'override.error', id: o.id, phase: 'start', attempts, error: msg(e) });
    let failedFinal = false;
    if (attempts >= MAX_ATTEMPTS) {
      try {
        const st = (await effRow(o.sub, o.period)).state;
        if (hasPlan(o) && holds(st, o)) return markActive(o, claimId, { attempts: 0 }).then(() => 'applied');
        failedFinal = await mutate(o.id, claimId, { status: 'failed', prev: null, targetCents: null, attempts, endedAt: isoNow(), note: 'could not apply: ' + msg(e) });
        if (failedFinal) log({ evt: 'override.failed', id: o.id, sub: o.sub, reason: 'gateway-error', retryable: true });
      } catch { /* cannot read the gateway: keep retrying rather than risk leaving a boost behind */ }
    }
    if (!failedFinal) await mutate(o.id, claimId, { attempts, note: 'will retry: ' + msg(e) }).catch(() => {});
    return failedFinal ? 'failed' : 'error';
  }
  async function onEndError(o0, claimId, e) {
    const o = (await get(o0.id).catch(() => null)) || o0;
    const attempts = (o.attempts || 0) + 1;
    log({ evt: 'override.error', id: o.id, phase: 'end', attempts, error: msg(e) });
    await mutate(o.id, claimId, { attempts, note: 'will retry reverting: ' + msg(e) }).catch(() => {});
    return 'error';
  }

  // L2: move a boost that sits on the org default to (current org default + extra). Plan first (the old target still counts as ours),
  // then compare-before-write, then write. A changed cap is never overwritten: the boost is `superseded`.
  async function retarget(o, claimId, want) {
    await mine(o.id, claimId);
    const planned = await mutate(o.id, claimId, (x) => ({ prevTargets: [...new Set([...(x.prevTargets || []), x.targetCents])].filter((v) => v !== want), baseCents: want - o.extraCents, targetCents: want }), { keepClaim: true });
    if (!planned) return;
    await mine(o.id, claimId);
    const st = (await effRow(o.sub, o.period)).state;
    const planO = { ...o, targetCents: want, prevTargets: [...new Set([...(o.prevTargets || []), o.targetCents])].filter((v) => v !== want) };
    const v = verdict(st, planO);
    if (v !== 'healthy') {
      await mutate(o.id, claimId, v === 'restored' ? { status: 'ended', endedAt: isoNow(), note: 'the personal limit was already back at its previous value' } : { status: 'superseded', endedAt: isoNow(), note: 'the personal limit was changed by hand, so the boost no longer applies' });
      log({ evt: v === 'restored' ? 'override.ended' : 'override.superseded', id: o.id, sub: o.sub, period: o.period, phase: 'retarget' });
      return;
    }
    if (st.cents !== want) await gateway.upsert(personalScope(o.sub), o.period, want, sysWho());
    await mutate(o.id, claimId, {});
    log({ evt: 'override.retargeted', id: o.id, sub: o.sub, period: o.period, baseCents: want - o.extraCents, targetCents: want });
  }

  // Close records in one store write (no gateway calls): zombies, hand-edited boosts, orphaned scheduled boosts, creatorRemoved flags.
  async function applyFinals(finals) {
    if (!finals.size) return [];
    const applied = [], t = now();
    await upd((doc) => {
      applied.length = 0;
      for (const [id, f] of finals) {
        const x = doc.items.find((y) => y.id === id);
        if (!x || x.status !== f.from || leaseLive(x.claim, t)) continue;       // someone is working on it, or it moved on: leave it
        Object.assign(x, f.patch); applied.push({ id, o: x, f });
      }
      return doc;
    });
    return applied;
  }

  let running = null;
  async function runTick() {
    const res = { applied: 0, ended: 0, failed: 0 };
    const t0 = mono(), over = () => mono() - t0 > budgetMs;
    let doc = await readDoc();
    const t = now();
    const live = doc.items.filter((o) => LIVE.has(o.status));
    if (!live.length) return res;                                  // nothing to do and nothing to write
    let wrote = false;
    const attempted = new Set();
    const admins = cfg.admins?.length ? new Set(cfg.admins.map((a) => String(a.email).toLowerCase())) : null;
    const orphan = (o) => !!admins && !admins.has(String(o.createdBy).toLowerCase());

    // 1. reconcile every active boost against one listLimits() result; close records that no longer match their cap
    let L = null;
    if (live.some((o) => o.status === 'active')) L = await gateway.listLimits().catch((e) => { log({ evt: 'override.error', phase: 'list-limits', error: msg(e) }); return null; });
    const finals = new Map(), rebaseQ = [], orphanQ = new Set();
    const addFinal = (o, patch) => { const f = finals.get(o.id) || { from: o.status, patch: {} }; Object.assign(f.patch, patch); finals.set(o.id, f); };
    for (const o of live) {
      const leased = leaseLive(o.claim, t);
      if (o.status === 'scheduled') {
        if (orphan(o) && !leased) { if (hasPlan(o)) orphanQ.add(o.id); else addFinal(o, { status: 'cancelled', endedAt: isoNow(), note: 'creator removed' }); }
        continue;
      }
      if (orphan(o)) { log({ evt: 'override.creator-removed', level: 'warn', id: o.id, sub: o.sub, period: o.period, by: o.createdBy, endsAt: o.endsAt }); if (!o.creatorRemoved) addFinal(o, { creatorRemoved: true }); }
      else if (o.creatorRemoved) addFinal(o, { creatorRemoved: false });
      if (leased || Date.parse(o.endsAt) <= t || !L) continue;      // due ones go through the end path below
      const st = stateFromLimits(L, o.sub, o.period), v = verdict(st, o);
      if (v === 'restored') addFinal(o, { status: 'ended', endedAt: isoNow(), note: 'the personal limit was already back at its previous value' });
      else if (v === 'changed') addFinal(o, { status: 'superseded', endedAt: isoNow(), note: 'the personal limit was changed by hand, so the boost no longer applies' });
      else if (o.prev?.kind === 'none' && o.baseSource === 'organization') {
        const org = L.find((l) => l.scope?.type === 'organization' && l.period === o.period);
        const newBase = org && org.amount !== null && org.amount !== undefined ? Number(org.amount) : null;
        if (newBase === null) rebaseQ.push({ o, end: true });                    // everyone is unlimited now: nothing left to boost
        else if (newBase + o.extraCents !== o.targetCents || st.cents !== o.targetCents) rebaseQ.push({ o, want: newBase + o.extraCents });
      }
    }
    for (const a of await applyFinals(finals)) {
      wrote = true;
      if (a.f.patch.status) log({ evt: a.f.patch.status === 'ended' ? 'override.ended' : a.f.patch.status === 'superseded' ? 'override.superseded' : 'override.cancelled', id: a.id, sub: a.o.sub, period: a.o.period, status: a.f.patch.status, restored: false, why: a.f.patch.note });
      if (a.f.patch.status === 'ended') res.ended++;
    }

    // a work phase: claim a batch, process it, repeat while there is budget (always at least one batch, so progress is guaranteed).
    // Before the first claim, probe a fresh copy of the document: if nothing is claimable there is NO store write (only notes of deferred boosts are saved).
    const phase = async (kind, select, work) => {
      const probe = await readDoc(), tp = now(), ctx = { started: new Set() }, notes = new Map(probe.items.map((x) => [x.id, x.note]));
      const any = probe.items.some((o) => !attempted.has(kind + o.id) && select(o, tp, probe, ctx) && !leaseLive(o.claim, tp));
      if (!any) {
        const noted = probe.items.filter((x) => x.note !== notes.get(x.id));
        if (noted.length) { await applyFinals(new Map(noted.map((x) => [x.id, { from: x.status, patch: { note: x.note } }]))); wrote = true; }
        return;
      }
      do {
        const batch = await claim(kind, (o, tt, d, c) => !attempted.has(kind + o.id) && select(o, tt, d, c), BATCH);
        if (!batch.length) break;
        wrote = true;
        for (const { id, claimId } of batch) {
          attempted.add(kind + id);
          const o = await get(id).catch(() => null); if (!o) { leases.delete(claimId); continue; }
          try { if (!(await renew(id, claimId))) continue; await work(o, claimId); }
          catch (e) { if (e instanceof LostClaim) continue; await work.onError(o, claimId, e); }
        }
      } while (!over());
    };
    const doEnds = (only) => phase('end', selectEnd(only), Object.assign(async (o, c) => { const r = await revert(o, c, 'ended'); if (r.ok) res.ended++; }, { onError: async (o, c, e) => { await onEndError(o, c, e); res.failed++; } }));

    // 2. orphaned scheduled boosts that already hold a plan: cancel through the revert path
    if (orphanQ.size) await phase('creator', (o) => orphanQ.has(o.id) && o.status === 'scheduled', Object.assign(async (o, c) => { const r = await revert(o, c, 'cancelled', 'creator removed'); if (r.ok) res.ended++; }, { onError: async (o, c, e) => { await onEndError(o, c, e); res.failed++; } }));

    // 3. end what is due (first: a boost that starts the instant another ends sees the restored cap)
    if (live.some((o) => o.status === 'active' && Date.parse(o.endsAt) <= t)) await doEnds(null);

    // 4. start what is due
    const started = new Set();
    if (live.some((o) => o.status === 'scheduled' && Date.parse(o.startsAt) <= t)) await phase('start', selectStart(null, null), Object.assign(async (o, c) => {
      const r = await activate(o, c);
      if (r === 'applied') { res.applied++; started.add(o.id); } else if (r === 'failed') res.failed++;
    }, { onError: async (o, c, e) => { const r = await onStartError(o, c, e); if (r === 'applied') { res.applied++; started.add(o.id); } else res.failed++; } }));
    if (started.size) await doEnds(started);                        // catches a boost that was applied after its window had already closed

    // 5. org default moved: re-target (or end) boosts that sit on it
    for (const q of rebaseQ) {
      if (over()) break;
      const [c] = await claim('rebase', selectId(q.o.id), 1); if (!c) continue;
      wrote = true;
      try {
        const o = await get(q.o.id); if (!o || o.status !== 'active') { leases.delete(c.claimId); continue; }
        if (q.end) { const r = await revert(o, c.claimId, 'ended', 'the organization default is now unlimited, so the boost was no longer needed'); if (r.ok) res.ended++; }
        else await retarget(o, c.claimId, q.want);
      } catch (e) {
        if (e instanceof LostClaim) continue;
        log({ evt: 'override.error', id: q.o.id, phase: 'retarget', error: msg(e) }); await mutate(q.o.id, c.claimId, {}).catch(() => {});
      }
    }

    // 6. overdue boosts are loud on every tick
    if (wrote) doc = await readDoc();
    const tNow = now();
    for (const o of doc.items) {
      if (o.status === 'active' && Date.parse(o.endsAt) < tNow) log({ evt: 'override.overdue', level: 'warn', id: o.id, sub: o.sub, period: o.period, overdueMs: tNow - Date.parse(o.endsAt), note: o.note || null });
    }
    return res;
  }

  function validate(input, t) {
    const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (typeof i.sub !== 'string' || !SUB_RE.test(i.sub)) throw new HttpError(400, 'bad user id');
    if (!OVERRIDE_PERIODS.includes(i.period)) throw new HttpError(400, 'period must be weekly or monthly');
    const extraUsd = parseUsd(i.extraUsd);
    if (!Number.isFinite(extraUsd) || extraUsd <= 0 || extraUsd > MAX_USD) throw new HttpError(400, `extra amount must be more than 0 and at most ${MAX_USD} USD, with at most 2 decimals`);
    const extraCents = toCents(extraUsd);
    if (extraCents < 1) throw new HttpError(400, 'extra amount must be at least 0.01 USD');
    const reason = typeof i.reason === 'string' ? i.reason.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim() : '';
    if (reason.length < 3 || reason.length > 200) throw new HttpError(400, 'reason is required (3 to 200 characters)');
    const startMs = i.startsAt === undefined || i.startsAt === null ? t : parseDate(i.startsAt);
    if (!Number.isFinite(startMs)) throw new HttpError(400, 'startsAt must be an ISO date');
    const endMs = parseDate(i.endsAt);
    if (!Number.isFinite(endMs)) throw new HttpError(400, 'endsAt must be an ISO date');
    if (startMs < t - PAST_SLACK_MS) throw new HttpError(400, 'startsAt is in the past');
    if (startMs > t + MAX_FUTURE_START_MS) throw new HttpError(400, 'startsAt is too far in the future');
    if (endMs <= t) throw new HttpError(400, 'endsAt must be in the future');
    if (endMs <= startMs) throw new HttpError(400, 'endsAt must be after startsAt');
    const maxMs = Math.max(1, Number(cfg.maxOverrideDays) || 90) * DAY;
    if (endMs - startMs < HOUR) throw new HttpError(400, 'a boost must last at least 1 hour');
    if (endMs - startMs > maxMs) throw new HttpError(400, `a boost can last at most ${Math.max(1, Number(cfg.maxOverrideDays) || 90)} days`);
    return { sub: i.sub, period: i.period, extraCents, reason, startMs, endMs };
  }

  const api = {
    async list({ status } = {}) {
      const want = status ? new Set([].concat(status).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean)) : null;
      if (want) for (const s of want) if (!OVERRIDE_STATUSES.includes(s)) throw new HttpError(400, `unknown status ${s.slice(0, 20)}`);
      const items = (await readDoc()).items.filter((o) => !want || want.has(o.status));
      return items.map(pub).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    },
    async forUser(sub) { return (await api.list()).filter((o) => o.sub === sub); },

    async create(input, admin) {
      const t = now();
      const v = validate(input, t);
      sysWho();                                                    // fail closed now rather than leave a boost that can never start
      const eff = await effRow(v.sub, v.period);
      if (eff.cap === null) throw new HttpError(400, eff.hasLimit ? 'that user is unlimited for this period, so there is no cap to extend' : 'that user has no budget cap to extend for this period');
      const email = eff.actor?.email_address || null;
      const o = {
        id: 'ovr_' + rid(), sub: v.sub, email, name: eff.actor?.name || (email ? email.split('@')[0] : v.sub.slice(0, 8)),
        period: v.period, extraCents: v.extraCents, baseCents: eff.cap, targetCents: null,
        startsAt: new Date(v.startMs).toISOString(), endsAt: new Date(v.endMs).toISOString(), reason: v.reason,
        createdBy: admin?.email || 'unknown', createdAt: new Date(t).toISOString(), status: 'scheduled', prev: null, appliedAt: null, endedAt: null, note: null,
      };
      await upd((doc) => {                                         // the overlap check and the insert are one serialised step
        const clash = doc.items.find((x) => LIVE.has(x.status) && same(x, o) && Date.parse(x.startsAt) < v.endMs && v.startMs < Date.parse(x.endsAt));
        if (clash) throw new HttpError(409, 'this user already has a boost for that period that overlaps those times');
        doc.items.push(o);
        return doc;
      });
      log({ evt: 'override.created', id: o.id, sub: o.sub, period: o.period, extraCents: o.extraCents, startsAt: o.startsAt, endsAt: o.endsAt, by: o.createdBy });
      if (v.startMs <= now()) await api.tick().catch((e) => log({ evt: 'override.error', id: o.id, phase: 'create-tick', error: msg(e) }));
      return pub((await get(o.id)) || o);
    },

    async cancel(id, admin) {
      const t = now(), claimId = rid();
      let found = null, busy = false;
      await upd((doc) => {
        found = null; busy = false;
        const o = doc.items.find((x) => x.id === id);
        if (!o) return doc;
        found = { status: o.status };
        if (!LIVE.has(o.status)) return doc;
        if (leaseLive(o.claim, t)) { busy = true; return doc; }
        o.claim = { id: claimId, at: t, kind: 'cancel' };
        return doc;
      });
      if (!found) throw new HttpError(404, 'no such override');
      if (!LIVE.has(found.status)) throw new HttpError(409, `this boost is already ${found.status}`);
      if (busy) throw new HttpError(409, 'this boost is being applied or reverted right now, try again in a moment');
      leases.set(claimId, mono());
      const o = await get(id);
      try { await revert(o, claimId, 'cancelled'); }
      catch (e) { await mutate(id, claimId, {}).catch(() => {}); if (e instanceof LostClaim) throw new HttpError(409, 'this boost is being applied or reverted right now, try again in a moment'); throw e; }   // release the lease; the boost stays as it was so it can be retried
      log({ evt: 'override.cancelled', id, by: admin?.email || 'unknown' });
      return pub(await get(id));
    },

    // L10: a boost whose start failed (after the retry budget) is not stranded: an admin can put it back in the queue while its window is open.
    // Routes: POST /api/overrides/:id/retry (admin) -> Override.
    async retry(id, admin) {
      const t = now();
      let found = null, problem = null;
      await upd((doc) => {
        found = null; problem = null;
        const o = doc.items.find((x) => x.id === id);
        if (!o) return doc;
        found = true;
        if (o.status !== 'failed') { problem = [409, `only a failed boost can be retried (this one is ${o.status})`]; return doc; }
        if (Date.parse(o.endsAt) <= t) { problem = [409, 'the boost window has already passed: create a new boost instead']; return doc; }
        if (doc.items.some((x) => x !== o && LIVE.has(x.status) && same(x, o) && Date.parse(x.startsAt) < Date.parse(o.endsAt) && Date.parse(o.startsAt) < Date.parse(x.endsAt))) { problem = [409, 'this user already has a boost for that period that overlaps those times']; return doc; }
        Object.assign(o, { status: 'scheduled', prev: null, targetCents: null, attempts: 0, prevTargets: [], appliedAt: null, endedAt: null, note: 'retry requested' });
        delete o.claim;
        return doc;
      });
      if (!found) throw new HttpError(404, 'no such override');
      if (problem) throw new HttpError(problem[0], problem[1]);
      log({ evt: 'override.retry', id, by: admin?.email || 'unknown' });
      const o = await get(id);
      if (Date.parse(o.startsAt) <= now()) await api.tick().catch((e) => log({ evt: 'override.error', id, phase: 'retry-tick', error: msg(e) }));
      return pub((await get(id)) || o);
    },

    // Called after an admin edits a user's personal cap by hand: any active boost that no longer matches is closed right away
    // (superseded; or ended if the cap was put back to its pre-boost value). Returns how many were closed.
    async reconcile(sub) {
      const t = now();
      const active = (await readDoc()).items.filter((o) => o.sub === sub && o.status === 'active' && !leaseLive(o.claim, t));
      const finals = new Map();
      for (const o of active) {
        const v = verdict((await effRow(o.sub, o.period)).state, o);
        if (v === 'changed') finals.set(o.id, { from: 'active', patch: { status: 'superseded', endedAt: isoNow(), note: 'the personal limit was changed by hand, so the boost no longer applies' } });
        else if (v === 'restored') finals.set(o.id, { from: 'active', patch: { status: 'ended', endedAt: isoNow(), note: 'the personal limit was already back at its previous value' } });
      }
      const done = await applyFinals(finals);
      for (const a of done) log({ evt: a.f.patch.status === 'ended' ? 'override.ended' : 'override.superseded', id: a.id, sub: a.o.sub, period: a.o.period });
      return done.length;
    },

    // Apply what is due, revert what has expired, reconcile the rest. Safe to call as often as you like, from any number of instances.
    tick() {
      if (running) return running;
      running = runTick().finally(() => { running = null; });
      return running;
    },
  };
  return api;
}
