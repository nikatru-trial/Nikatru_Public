#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// live-probe.mjs — THE CUSTOMER PATH, PROBED EVERY MINUTE FROM OUTSIDE CLOUDFLARE,
// AND THE PAGE WHEN IT BREAKS.
//
// ⏱ 2026-10-17 · lane live-ops-readiness (owner: "how realtime when live users, are we
// planning to handle?"). On 2026-10-16 a deploy on a stale public shell shipped /pricing with
// `__PADDLE_CLIENT_TOKEN__`. It was seen by checkout-pages-live.mjs inside ops-watch — a
// 6-hourly grid on GitHub's scheduler — and nothing else. The target is DETECT <= 5 min,
// CONTAIN <= 15 min (docs/ops/incident-response.md); this is the DETECT half and the page.
//
// PORTABLE ON PURPOSE. It runs on the box that holds the `ops` role (tooling/boxes/roles.json),
// from root's cron, every minute, and imports nothing but `node:` built-ins: the install is two
// files, this one and tooling/ops/live-probes.json (docs/ops/live-probes.md, Install). The
// register of probes is that JSON; tooling/ci/assert-live-ops.mjs holds it to the register row
// `duty.live-probe-minute`, to tooling/monitor-register.json's hosts, and the launcher judgement
// below to checkout-pages-live.mjs's on the tree's real pages.
//
// ONE RUN (`--once`, what cron calls):
//   1. every probe in the JSON, in parallel, each ONE request bounded by `alerting.timeoutMs`
//      (no in-run retry: "two consecutive failed RUNS" is the blip filter, and a retry inside a
//      run would only hide the first of them);
//   2. `decide` (PURE) folds the results into the state file and returns the alerts:
//        · a probe failing for `failuresToPage` consecutive runs           → PAGE (high)
//        · still failing `escalateAfterMinutes` after its page             → ESCALATE (urgent, says CONTAIN)
//        · then one REMIND per `remindEveryMinutes` while it stays down    → REMIND (urgent)
//        · a paged probe passing again                                     → RECOVER (default)
//      every alert of one run rides ONE message (dedup across probes);
//   3. the message goes to the owner's phone (every leg of the page channel recorded in
//      tooling/ops/alarm-chains.json `boxPageChannel`: PAGE_URL, then PAGE_URL_2) and, as one JSON line, to the lead watch: appended to
//      `<STATE_DIR>/alerts.jsonl` and POSTed to LEAD_URL (an ntfy topic the lead tails with
//      `/json`). An alert is marked SENT only when a leg of the owner page answered 2xx; an undelivered
//      one is re-sent by the next run (exit 1 meanwhile);
//   4. one JSON line per run to `<STATE_DIR>/runs.jsonl` (started over past RUNS_MAX_BYTES), and
//      `lastAllGreenAt` in state.json — the moment rollback.mjs --break-glass --probe-state
//      treats as "last seen healthy";
//   5. ONLY THEN the heartbeat (HEARTBEAT_URL_FILE): a beat says "a run completed and could
//      page", never "the site is fine" — the runner's absence watcher (duty.live-probe-minute).
//
// ⏱ 2026-11-10 · O-R52-OPS-048: a probe may EXPECT A REFUSAL — `expect.status: [401, 403]` is the kind (the row
// `page-channel-deny-anon`: an anonymous read of a throwaway ntfy topic must be refused; a 200 pages).
// ⏱ 2026-11-14 · bl-money-1-aw202611141316 (O-R53-MONEY-WEBHOOK-PROBE-SIGNED-REFUSAL): a probe may POST. The five
// payment-webhook probes sent HEAD and passed on "below-500", but the routes are POST-only, so a live route, a deleted
// one and a made-up provider all answered the router's 404 and all passed. A POST row sends its FIXED `body` (padded
// with spaces to `padTo` bytes when set) and is judged by an exact `status` list and the exact parsed `expect.json`
// — the refusal the route answers BEFORE anything is believed (services/platform test
// live-probe-webhook-refusal.test.ts drives every such row through the real Worker app). `canary: true` marks a row
// tooling/ops/gradual-deploy.mjs also sends to the pinned new version at every split.
//
// ⏱ 2026-11-21 · O-PROD-PROBES-ONE-VANTAGE-1121 (lane front-door-probes-1121; lead ruling 10:20Z): WHERE A RUN STOOD.
// The probes ran from one box and never said which Cloudflare edge answered them, so "the India book is served" was
// never asked from India. Each run now reads `/cdn-cgi/trace` ONCE (on the host of the market-book row, through the
// same liveAnswer as every probe) and prints ONE line `colo=<CODE> loc=<CC> vantage=<name>` before its probe lines;
// the line also rides runs.jsonl. `--vantage box-a|box-b` names the box (VANTAGES) — never inferred; absent, it is
// printed `vantage=undeclared`. A missing or unreadable trace is `colo=UNKNOWN loc=UNKNOWN`, never a probe failure.
// `loc` (the country the edge sees, which is the CF-IPCountry services/platform/src/routes/config.ts prices by) JUDGES
// the market; `colo` is printed only. The kind `expect.marketBook` judges `GET /config/<app>` with NO declared market:
// when `loc` is in its `byLoc` table the body must carry that market's book (`paywall.market` and every offering's
// `currency_code`); for any other loc it records the book it got without judging (tooling/ci/assert-live-ops.mjs
// holds `byLoc` to services/platform/src/config.ts MARKET_PRICE_BOOKS).
// ⏱ 2026-11-21 · review of 9b39f66e (F2, F4): A DELIBERATE "NO PRICES" IS ITS OWN VERDICT, AND A WRONG BOOK PAGES ONCE.
// A body with `purchases_paused: true`, or whose paywall offerings the Worker withheld (`offerings: []`), is
// `NO PRICES (deliberate: …)` — an ok verdict, named apart, never judged as "the wrong book". A row marked
// `alert: "once-per-state"` (every marketBook row: assert-live-ops limb 11) pages ONCE when it turns (after the same
// failuresToPage runs) and again only when its failure CHANGES (a different `why`); it never escalates or reminds,
// because a wrong book is a pricing fault to fix the same day, not an outage to CONTAIN in 15 minutes.
// DETECTION TIME (F4): the trace read runs IN PARALLEL with the probes, each bounded by the same alerting.timeoutMs,
// and the verdicts are taken after both — so a run still ends within ONE timeout (10 s today) and DETECT is unchanged:
// failuresToPage (2) x the 1-minute cron + one timeout. A trace that has not answered by then is UNKNOWN.
//
// CONFIG: /etc/nikatru/live-probe.conf (LIVE_PROBE_CONF overrides; the tests do), KEY=VALUE lines:
//   PAGE_URL=https://ntfy.sh/<owner topic>             the owner page, leg 1 = the PRIMARY (required unless --dry-run)
//   PAGE_TOKEN_FILE=<leg 1's token file>               mode 0600; optional; sent to leg 1 ONLY
//   PAGE_URL_2=https://ntfy.nikatru.com/nikatru-page   the owner page, leg 2; optional
//   PAGE_TOKEN_FILE_2=/etc/nikatru/ntfy-alert.token    mode 0600; sent to leg 2 ONLY
//   LEAD_URL=https://ntfy.nikatru.com/<lead topic>     optional; the lead watch's machine stream
//   LEAD_TOKEN_FILE=…                                  optional; default: the token of the page leg on LEAD_URL's origin, else none
// ⏱ 2026-11-13 · O-BOXB-PAGE-CHANNEL-UNDECIDED (lead ruling lead-steps-1113 step 18: both legs, ntfy.sh primary):
// this runner lives on the box that serves the self-hosted ntfy, so a page through that ntfy alone fails exactly
// when the box does. Every alert goes to EVERY leg in parallel; it counts as DELIVERED when ANY leg answered 2xx,
// and each leg's result is written to alerts.jsonl (`legs`). A token goes only to the leg it is named for.
// The recorded channel: tooling/ops/alarm-chains.json `boxPageChannel`.
//   STATE_DIR=/var/lib/nikatru/live-probe              optional
//   HEARTBEAT_URL_FILE=/etc/nikatru/live-probe.heartbeat.url   optional; mode 0600
//   PROBES_FILE=/opt/nikatru/live-probes.json          optional; default: next to this script
// No secret is ever printed: a token and the heartbeat URL are read from files and never echoed.
//
// Usage:
//   node live-probe.mjs --once [--vantage box-a|box-b] [--dry-run] [--now <ISO>] [--fixtures <file.json>]
//   --dry-run   probe and decide, print the message, send nothing and write no state.
//   --fixtures  answers from a JSON file keyed `<METHOD> <url>` -> {status, body} (tests; never the network).
// Exit: 0 the run completed and every alert it owed was delivered (a failing probe is an ALERT, not an
//       exit code: cron's exit is about the runner) · 1 an alert could not be delivered (re-sent next
//       run; no heartbeat, so the absence watcher sees it too) · 2 COVERAGE LOST — no config, an
//       unreadable probes file, or a state dir that cannot be written.
//       --dry-run: 0 every probe passed, 1 one failed.
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync, closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pageAllLegs, pageLegs, readSecretFile } from './box-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONF = '/etc/nikatru/live-probe.conf';
export const DEFAULT_STATE_DIR = '/var/lib/nikatru/live-probe';
/** runs.jsonl starts over past this size: ~1 week of minute lines, one disk-safe bound. */
// @ceiling none — a local log-rotation bound on the box, not a vendor limit
export const RUNS_MAX_BYTES = 8 * 1024 * 1024;
export const STATE_VERSION = 1;

const MIN = 60_000;

// ── the probes file ─────────────────────────────────────────────────────────

/** PURE. The structural rules the runner itself needs; assert-live-ops.mjs holds the rest. */
export function validateProbes(doc) {
  const errors = [];
  const a = doc?.alerting ?? {};
  for (const k of ['failuresToPage', 'escalateAfterMinutes', 'remindEveryMinutes', 'timeoutMs']) {
    if (!Number.isInteger(a[k]) || a[k] < 1) errors.push(`alerting.${k} must be a positive integer`);
  }
  if (Number.isInteger(a.failuresToPage) && a.failuresToPage < 2) errors.push('alerting.failuresToPage must be >= 2: one blip never pages');
  const rows = Array.isArray(doc?.rows) ? doc.rows : null;
  if (!rows || rows.length === 0) errors.push('rows must be a non-empty array');
  const seen = new Set();
  for (const r of rows ?? []) {
    const id = r?.id;
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) { errors.push(`row id ${JSON.stringify(id)} is not a slug`); continue; }
    if (seen.has(id)) errors.push(`${id}: duplicate id`);
    seen.add(id);
    if (!PROBE_METHODS.includes(r.method)) errors.push(`${id}: method must be one of ${PROBE_METHODS.join(', ')}`);
    let u = null;
    try { u = new URL(r.url); } catch { errors.push(`${id}: url does not parse`); }
    if (u && (u.protocol !== 'https:' || u.search || u.hash)) errors.push(`${id}: url must be https with no query and no fragment (a probe never names a transaction)`);
    const e = r.expect ?? {};
    if (!(e.status === 'below-500' || (Array.isArray(e.status) && e.status.length > 0 && e.status.every(Number.isInteger)))) {
      errors.push(`${id}: expect.status must be "below-500" or a non-empty array of integers`);
    }
    if (r.method === 'HEAD' && (e.bodyIncludes || e.launcher || e.json !== undefined)) errors.push(`${id}: a HEAD has no body to judge`);
    // ⏱ 2026-11-14 · bl-money-1-aw202611141316 (O-R53-MONEY-WEBHOOK-PROBE-SIGNED-REFUSAL): a status CLASS cannot fail on a
    // route the router does not know — its 404 is "below 500" — so it is a GET-only judge, and a GET row still has a body.
    if (e.status === 'below-500' && r.method !== 'GET') errors.push(`${id}: "below-500" is a GET-only judge — a ${r.method} to a route that is gone answers the router's 404, which it passes; judge the exact status and body the route answers`);
    if (r.method === 'POST') {
      if (typeof r.body !== 'string') errors.push(`${id}: a POST sends a fixed \`body\` string`);
      if (r.padTo !== undefined && !(Number.isInteger(r.padTo) && r.padTo > Buffer.byteLength(String(r.body ?? '')))) errors.push(`${id}: padTo must be an integer larger than the body`);
      if (e.json === undefined) errors.push(`${id}: a POST is judged by the exact JSON it is answered (expect.json)`);
    } else if (r.body !== undefined || r.padTo !== undefined) errors.push(`${id}: only a POST sends a body`);
    if (e.marketBook !== undefined) errors.push(...marketBookErrors(id, r.method, e.marketBook));
    if (e.json !== undefined && (e.json === null || typeof e.json !== 'object' || Array.isArray(e.json))) errors.push(`${id}: expect.json must be an object`);
    if (r.canary !== undefined && r.canary !== true) errors.push(`${id}: canary is true or absent`);
    if (r.alert !== undefined && r.alert !== 'once-per-state') errors.push(`${id}: alert is "once-per-state" or absent`);
    if (e.bodyIncludes !== undefined && !(Array.isArray(e.bodyIncludes) && e.bodyIncludes.every((s) => typeof s === 'string' && s.length > 0))) {
      errors.push(`${id}: expect.bodyIncludes must be an array of non-empty strings`);
    }
    if (e.launcher) {
      const l = e.launcher;
      if (!l.page || !l.src || !l.attr || typeof l.requireFilled !== 'boolean') errors.push(`${id}: expect.launcher needs page, src, attr and requireFilled`);
      try { new RegExp(l.shape); } catch { errors.push(`${id}: expect.launcher.shape is not a regular expression`); }
    }
  }
  return errors;
}

/** PURE. The structural rules of an `expect.marketBook` judge (O-PROD-PROBES-ONE-VANTAGE-1121). */
function marketBookErrors(id, method, mb) {
  const out = [];
  if (method !== 'GET') out.push(`${id}: a marketBook is a GET judge (the config is read, never posted)`);
  if (!mb || typeof mb !== 'object' || Array.isArray(mb)) return [...out, `${id}: expect.marketBook must be an object`];
  if (typeof mb.why !== 'string' || mb.why.trim() === '') out.push(`${id}: expect.marketBook.why must say why each loc is judged`);
  const by = mb.byLoc;
  if (!by || typeof by !== 'object' || Array.isArray(by) || Object.keys(by).length === 0) return [...out, `${id}: expect.marketBook.byLoc must be a non-empty object of loc -> {market, currency}`];
  for (const [loc, want] of Object.entries(by)) {
    if (!/^[A-Z]{2}$/.test(loc)) out.push(`${id}: marketBook.byLoc key ${JSON.stringify(loc)} is not a two-letter country code`);
    if (typeof want?.market !== 'string' || !/^[A-Z]{2}$/.test(want.market)) out.push(`${id}: marketBook.byLoc.${loc}.market must be a two-letter market`);
    if (typeof want?.currency !== 'string' || !/^[A-Z]{3}$/.test(want.currency)) out.push(`${id}: marketBook.byLoc.${loc}.currency must be a three-letter currency`);
  }
  return out;
}

/** The boxes a run may say it stands on. Named by the operator (`--vantage`), never inferred. */
export const VANTAGES = Object.freeze(['box-a', 'box-b']);

/** PURE. `colo` and `loc` out of a `/cdn-cgi/trace` answer (`k=v` lines); `UNKNOWN` for each one it does not carry. */
export function parseTrace(answer) {
  const out = { colo: 'UNKNOWN', loc: 'UNKNOWN' };
  if (!answer || answer.error || answer.status !== 200) return out;
  for (const line of String(answer.body ?? '').split(/\r?\n/)) {
    const m = /^(colo|loc)=([A-Za-z0-9]{2,8})$/.exec(line.trim());
    if (m) out[m[1]] = m[2].toUpperCase();
  }
  return out;
}

/** PURE. Where the run reads its trace: the origin of the market-book row (the edge whose country prices the book),
 *  else of the first row. */
export function traceUrlOf(doc) {
  const rows = doc?.rows ?? [];
  const r = rows.find((x) => x?.expect?.marketBook) ?? rows[0];
  return r ? `${new URL(r.url).origin}/cdn-cgi/trace` : null;
}

/** PURE. The one line a run prints before its probe lines. */
export const vantageLine = ({ colo, loc }, vantage) => `colo=${colo} loc=${loc} vantage=${vantage ?? 'undeclared'}`;

/** PURE. What one config body offers: `{noPrices: why}` for a DELIBERATE no-prices answer (purchases paused, or
 *  every offering withheld), `{market, currencies, paywallOff}` for a book, or null when it has no paywall offerings
 *  list at all (a shape this cannot read). */
function bookOf(got) {
  const pw = got?.paywall;
  if (got?.purchases_paused === true) return { noPrices: 'purchases_paused' };
  const offers = Array.isArray(pw?.offerings) ? pw.offerings : null;
  if (!pw || !offers) return null;
  if (offers.length === 0) return { noPrices: 'the Worker withheld every offering' };
  return { market: pw.market ?? null, currencies: [...new Set(offers.map((o) => o?.currency_code ?? '(none)'))].sort(), paywallOff: pw.enabled === false };
}

/** The methods a probe may send. */
export const PROBE_METHODS = Object.freeze(['GET', 'HEAD', 'POST']);

// ── judging one answer ──────────────────────────────────────────────────────

/** PURE. The exact bytes a POST row sends: its fixed `body`, padded with spaces to `padTo` bytes when set (a body over a
 *  route's bound is refused before anything reads it). Null for a row that sends no body. */
export function requestBody(row) {
  if (row?.method !== 'POST') return null;
  const body = String(row.body ?? '');
  return Number.isInteger(row.padTo) ? body + ' '.repeat(Math.max(0, row.padTo - Buffer.byteLength(body))) : body;
}

/** The request one row sends: method, body and headers (`extra` added, e.g. a version pin). Shared with gradual-deploy.mjs. */
export function requestInit(row, extra = {}) {
  const body = requestBody(row);
  return {
    method: row.method,
    headers: { 'user-agent': 'nikatru-live-probe/1', ...(body === null ? {} : { 'content-type': 'application/json' }), ...extra },
    ...(body === null ? {} : { body }),
  };
}

/** PURE. A JSON value with its object keys sorted, so two bodies compare by content, never by key order. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

const literal = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** PURE. What a served page's checkout launcher lacks; [] when it can open a checkout. Never returns the value. */
export function launcherFindings(html, l) {
  const out = [];
  const meta = /<meta\s+name="nikatru-checkout"([^>]*)>/.exec(html);
  if (!meta) out.push('carries no <meta name="nikatru-checkout"> (the launcher has no config)');
  else if (!new RegExp(`\\bdata-page="${literal(l.page)}"`).test(meta[1])) out.push(`its launcher config does not say data-page="${l.page}"`);
  if (!new RegExp(`<script\\s+type="module"\\s+src="${literal(l.src)}"\\s*>\\s*</script>`).test(html)) out.push(`does not load the launcher ${l.src}`);
  if (meta) {
    const value = new RegExp(`\\b${literal(l.attr)}="([^"]*)"`).exec(meta[1])?.[1] ?? null;
    if (value === null) out.push(`carries no ${l.attr}`);
    else if (value.startsWith('__')) { if (l.requireFilled) out.push(`still carries the placeholder for ${l.attr}: the deploy did not fill it, so the checkout cannot open`); }
    else if (!new RegExp(l.shape).test(value)) out.push(`carries ${l.attr} in a shape that is not the live world's (${value.length} chars)`);
  }
  return out;
}

/** PURE. One probe's verdict from one answer: `{ok, why}`. `answer` is {status, body} or {error}; `ctx.loc` is the
 *  run's trace country (a marketBook row judges by it; absent = UNKNOWN, not judged). */
export function judge(row, answer, ctx = {}) {
  if (!answer || answer.error) return { ok: false, why: `no answer (${answer?.error ?? 'none'})` };
  const e = row.expect;
  const statusOk = e.status === 'below-500' ? answer.status < 500 : e.status.includes(answer.status);
  if (!statusOk) return { ok: false, why: `HTTP ${answer.status}, expected ${e.status === 'below-500' ? 'below 500' : e.status.join('/')}` };
  const body = String(answer.body ?? '');
  const missing = (e.bodyIncludes ?? []).filter((s) => !body.includes(s));
  if (missing.length) return { ok: false, why: `HTTP ${answer.status} but the body lacks ${missing.map((s) => JSON.stringify(s)).join(', ')}` };
  if (e.json !== undefined) {
    let got;
    try { got = JSON.parse(body); } catch { return { ok: false, why: `HTTP ${answer.status} but the body is not JSON` }; }
    // The body is the route's refusal (a fixed error code), never a customer's data, so naming it is safe.
    if (JSON.stringify(canonical(got)) !== JSON.stringify(canonical(e.json))) return { ok: false, why: `HTTP ${answer.status} but the body is ${JSON.stringify(got).slice(0, 120)}, expected ${JSON.stringify(e.json)}` };
  }
  if (e.marketBook) {
    let got;
    try { got = JSON.parse(body); } catch { return { ok: false, why: `HTTP ${answer.status} but the config body is not JSON` }; }
    const book = bookOf(got);
    const loc = ctx.loc ?? 'UNKNOWN';
    if (book?.noPrices) return { ok: true, why: `HTTP ${answer.status}, NO PRICES (deliberate: ${book.noPrices}) at loc=${loc} — no book to judge` };
    const want = Object.prototype.hasOwnProperty.call(e.marketBook.byLoc, loc) ? e.marketBook.byLoc[loc] : null;
    const said = book ? `market=${book.market ?? 'default'} currency=${book.currencies.join('+')}${book.paywallOff ? ' (paywall off)' : ''}` : 'no paywall offerings';
    if (!want) return { ok: true, why: `HTTP ${answer.status}, book ${said} (not judged: loc=${loc})` };
    if (!book || book.market !== want.market || book.currencies.length !== 1 || book.currencies[0] !== want.currency) {
      return { ok: false, why: `HTTP ${answer.status} but loc=${loc} was served ${said}, not the ${want.market} book in ${want.currency}` };
    }
    return { ok: true, why: `HTTP ${answer.status}, loc=${loc} served the ${want.market} book (${want.currency})${book.paywallOff ? ' (paywall off)' : ''}` };
  }
  if (e.launcher) {
    const f = launcherFindings(body, e.launcher);
    if (f.length) return { ok: false, why: `HTTP ${answer.status} but the page ${f.join('; ')}` };
  }
  return { ok: true, why: `HTTP ${answer.status}` };
}

// ── deciding what to say ────────────────────────────────────────────────────

export function emptyState() {
  return { v: STATE_VERSION, probes: {}, lastRunAt: null, lastAllGreenAt: null, pending: [] };
}

/**
 * PURE. Fold one run's results into the state and return the alerts it owes.
 * `results` is [{id, ok, why}], `nowMs` the run time. Returns {state, alerts}; the caller marks
 * delivery (`markDelivered`) — an alert is never "sent" by deciding it.
 */
export function decide(prev, results, nowMs, alerting) {
  const state = structuredClone(prev ?? emptyState());
  state.v = STATE_VERSION;
  state.probes ??= {};
  state.pending ??= [];
  const at = new Date(nowMs).toISOString();
  const alerts = [];
  for (const r of results) {
    const p = (state.probes[r.id] ??= { fails: 0, firstFailAt: null, lastOkAt: null, paged: null });
    if (r.ok) {
      if (p.paged) alerts.push({ kind: 'recover', id: r.id, why: r.why, downMinutes: Math.round((nowMs - Date.parse(p.firstFailAt)) / MIN), since: p.firstFailAt });
      p.fails = 0;
      p.firstFailAt = null;
      p.lastOkAt = at;
      p.paged = null;
      continue;
    }
    p.fails += 1;
    p.firstFailAt ??= at;
    p.lastWhy = r.why;
    if (!p.paged) {
      if (p.fails >= alerting.failuresToPage) {
        alerts.push({ kind: 'page', id: r.id, why: r.why, fails: p.fails, since: p.firstFailAt });
        p.paged = { at, level: 'page', lastNotifiedAt: at, why: r.why };
      }
      continue;
    }
    // ⏱ 2026-11-21 · review of 9b39f66e F2: a once-per-state row pages again only when its failure CHANGES; it never
    // escalates or reminds (a wrong price book is fixed the same day, not CONTAINED in 15 minutes).
    if (r.oncePerState) {
      if (r.why !== p.paged.why) {
        alerts.push({ kind: 'page', id: r.id, why: r.why, fails: p.fails, since: p.firstFailAt });
        p.paged = { ...p.paged, lastNotifiedAt: at, why: r.why };
      }
      continue;
    }
    const sincePage = nowMs - Date.parse(p.paged.at);
    const sinceLast = nowMs - Date.parse(p.paged.lastNotifiedAt);
    if (p.paged.level === 'page' && sincePage >= alerting.escalateAfterMinutes * MIN) {
      alerts.push({ kind: 'escalate', id: r.id, why: r.why, downMinutes: Math.round((nowMs - Date.parse(p.firstFailAt)) / MIN), since: p.firstFailAt });
      p.paged.level = 'escalated';
      p.paged.lastNotifiedAt = at;
    } else if (p.paged.level === 'escalated' && sinceLast >= alerting.remindEveryMinutes * MIN) {
      alerts.push({ kind: 'remind', id: r.id, why: r.why, downMinutes: Math.round((nowMs - Date.parse(p.firstFailAt)) / MIN), since: p.firstFailAt });
      p.paged.lastNotifiedAt = at;
    }
  }
  // A probe that left the probes file is forgotten, never paged about forever.
  const ids = new Set(results.map((r) => r.id));
  for (const id of Object.keys(state.probes)) if (!ids.has(id)) delete state.probes[id];
  state.lastRunAt = at;
  if (results.length > 0 && results.every((r) => r.ok)) state.lastAllGreenAt = at;
  // Alerts a previous run could not deliver go out again, first, with this run's.
  const owed = [...state.pending, ...alerts.map((a) => ({ ...a, at }))];
  state.pending = owed;
  return { state, alerts: owed };
}

/** PURE. After a delivery attempt: delivered clears the queue, undelivered keeps it for the next run. */
export function markDelivered(state, delivered) {
  return delivered ? { ...state, pending: [] } : state;
}

const SEVERITY = { remind: 3, escalate: 3, page: 2, recover: 1 };
const PRIORITY = { 3: 'urgent', 2: 'high', 1: 'default' };

/** PURE. ONE message for every alert of a run: the owner's text and the lead watch's JSON line. */
export function compose(alerts, nowMs) {
  if (alerts.length === 0) return null;
  const worst = Math.max(...alerts.map((a) => SEVERITY[a.kind]));
  const down = alerts.filter((a) => a.kind !== 'recover');
  const lines = alerts.map((a) => {
    if (a.kind === 'page') return `DOWN ${a.id}: ${a.why} (${a.fails} runs since ${a.since})`;
    if (a.kind === 'escalate') return `STILL DOWN ${a.id} for ${a.downMinutes} min: ${a.why} — CONTAIN NOW: roll back (docs/ops/rollback.md)`;
    if (a.kind === 'remind') return `STILL DOWN ${a.id} for ${a.downMinutes} min: ${a.why}`;
    return `RECOVERED ${a.id} after ${a.downMinutes} min`;
  });
  const title = down.length
    ? `${worst === 3 ? 'CONTAIN' : 'DOWN'}: ${down.map((a) => a.id).join(', ')}`
    : `RECOVERED: ${alerts.map((a) => a.id).join(', ')}`;
  const tags = worst === 3 ? 'rotating_light' : worst === 2 ? 'warning' : 'white_check_mark';
  return {
    title,
    priority: PRIORITY[worst],
    tags,
    text: lines.join('\n'),
    json: { v: 1, source: 'live-probe', at: new Date(nowMs).toISOString(), severity: PRIORITY[worst], alerts },
  };
}

// ── the impure shell ────────────────────────────────────────────────────────

/** KEY=VALUE lines; `#` comments; surrounding quotes stripped. No shell evaluation. */
export function parseConf(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}


/** One probe's live answer, `{status, body}` or `{error}`. Exported for tooling/ops/owner-page-watch.mjs, the off-Cloudflare
 *  backstop that runs the same probes from GitHub's runners (T-65). */
export async function liveAnswer(row, timeoutMs) {
  try {
    const res = await fetch(row.url, { ...requestInit(row), redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const body = row.method === 'HEAD' ? '' : await res.text();
    return { status: res.status, body };
  } catch (err) {
    return { error: err?.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : (err?.cause?.code ?? err?.name ?? 'fetch failed') };
  }
}

function fixtureAnswerer(file) {
  const table = JSON.parse(readFileSync(file, 'utf8'));
  return async (row) => table[`${row.method} ${row.url}`] ?? { error: 'fixture has no answer' };
}

/** The owner page's legs: hoisted to tooling/ops/box-page.mjs (O-STD-BOX-PAGE-BOTH-LEGS-CODEMOD, 2026-11-20), the one shared
 *  legs pager; re-exported here for the importers that read it from this file (gh-budget.mjs). */
export { pageLegs };

/** The lead stream's token: its own (LEAD_TOKEN_FILE), else the token of the page leg on the SAME ORIGIN as LEAD_URL,
 *  else none. Chosen by host, never by which keys are set: a token never reaches a host it was not named for. */
export function leadTokenFile(conf) {
  if (conf.LEAD_TOKEN_FILE) return conf.LEAD_TOKEN_FILE;
  const origin = (u) => { try { return new URL(u).origin; } catch { return null; } };
  const lead = origin(conf.LEAD_URL);
  return lead ? pageLegs(conf).find((l) => origin(l.url) === lead)?.tokenFile : undefined;
}

async function post(url, body, headers, timeoutMs) {
  try {
    const res = await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? { ok: true } : { ok: false, why: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, why: err?.name ?? 'fetch failed' };
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const usage = 'usage: live-probe.mjs --once [--vantage box-a|box-b] [--dry-run] [--now <ISO>] [--fixtures <file>]';
  // Every flag is declared: an undeclared one (a mistyped --dry-run above all) is refused before any probe, page or
  // state write, so a typo can never run the real thing.
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { once: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, now: { type: 'string' }, fixtures: { type: 'string' }, vantage: { type: 'string' } }, allowPositionals: true, strict: true }));
  } catch (e) {
    console.error(`live-probe: refused, nothing probed or sent — ${e.message}\n${usage}`);
    return 2;
  }
  const arg = (n) => values[n] ?? null;
  if (!values.once) {
    console.error(usage);
    return 2;
  }
  const vantage = values.vantage ?? null;
  if (vantage !== null && !VANTAGES.includes(vantage)) {
    console.error(`live-probe: refused, nothing probed or sent — --vantage ${JSON.stringify(vantage)} is not one of ${VANTAGES.join(', ')}\n${usage}`);
    return 2;
  }
  const dry = values['dry-run'] === true;
  const nowMs = arg('now') ? Date.parse(arg('now')) : Date.now();
  const lost = (why) => { console.error(`live-probe: COVERAGE LOST — ${why}`); return 2; };

  const confPath = env.LIVE_PROBE_CONF ?? DEFAULT_CONF;
  let conf = {};
  if (existsSync(confPath)) conf = parseConf(readFileSync(confPath, 'utf8'));
  else if (!dry) return lost(`no config at ${confPath} (PAGE_URL is required: a probe that cannot page is not a watcher)`);
  if (!dry && !conf.PAGE_URL) return lost(`${confPath} sets no PAGE_URL`);
  if (!dry && conf.PAGE_URL_2 && conf.PAGE_URL_2 === conf.PAGE_URL) return lost(`${confPath} sets PAGE_URL_2 to PAGE_URL: two legs on one URL are one leg`);

  const probesPath = conf.PROBES_FILE ?? join(HERE, 'live-probes.json');
  let doc;
  try { doc = JSON.parse(readFileSync(probesPath, 'utf8')); } catch (e) { return lost(`the probes file ${probesPath} cannot be read (${e.message})`); }
  const bad = validateProbes(doc);
  if (bad.length) return lost(`the probes file is malformed: ${bad.join('; ')}`);

  const stateDir = conf.STATE_DIR ?? DEFAULT_STATE_DIR;
  const statePath = join(stateDir, 'state.json');
  let prev = emptyState();
  if (!dry) {
    try { mkdirSync(stateDir, { recursive: true }); } catch (e) { return lost(`the state dir ${stateDir} cannot be created (${e.message})`); }
    if (existsSync(statePath)) {
      try { prev = JSON.parse(readFileSync(statePath, 'utf8')); } catch { console.error('live-probe: state.json unreadable — starting from an empty state (a page may repeat once)'); }
    }
  }

  const answer = arg('fixtures') ? fixtureAnswerer(arg('fixtures')) : (row) => liveAnswer(row, doc.alerting.timeoutMs);
  // ONE trace read per run, IN PARALLEL with the probes (same timeout), judged after both: the run's length and
  // DETECT are unchanged, and an unread trace is UNKNOWN and never fails a probe.
  const traceUrl = traceUrlOf(doc);
  const [traceAnswer, answers] = await Promise.all([
    traceUrl ? answer({ id: 'cdn-cgi-trace', method: 'GET', url: traceUrl }) : Promise.resolve(null),
    Promise.all(doc.rows.map((row) => answer(row))),
  ]);
  const trace = parseTrace(traceAnswer);
  console.log(vantageLine(trace, vantage));
  const results = doc.rows.map((row, i) => ({ id: row.id, ...judge(row, answers[i], trace), ...(row.alert === 'once-per-state' ? { oncePerState: true } : {}) }));
  for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.id} — ${r.why}`);

  const { state, alerts } = decide(prev, results, nowMs, doc.alerting);
  const msg = compose(alerts, nowMs);
  const runLine = JSON.stringify({ v: 1, at: state.lastRunAt, vantage: vantage ?? 'undeclared', colo: trace.colo, loc: trace.loc, allGreen: results.every((r) => r.ok), results });

  if (dry) {
    console.log('live-probe: DRY RUN — nothing sent, no state written.');
    if (msg) console.log(`  would page [${msg.priority}] ${msg.title}\n${msg.text}`);
    return results.every((r) => r.ok) ? 0 : 1;
  }

  let delivered = true;
  if (msg) {
    const paged = await pageAllLegs(conf, msg.text, { headers: { title: msg.title, priority: msg.priority, tags: msg.tags }, timeoutMs: doc.alerting.timeoutMs });
    const sentLegs = paged.legs;
    const sent = paged.ok ? { ok: true } : { ok: false, why: paged.why };
    delivered = sent.ok;
    for (const l of sentLegs) if (!l.ok && sent.ok) console.error(`live-probe: page leg ${l.leg} did not take the alert (${l.why}); another leg did`);
    const line = JSON.stringify({ ...msg.json, delivered: sent.ok, legs: sentLegs.map((l) => ({ leg: l.leg, ok: l.ok, ...(l.ok ? {} : { why: l.why }) })), ...(sent.ok ? {} : { deliveryError: sent.why }) });
    try { appendFileSync(join(stateDir, 'alerts.jsonl'), `${line}\n`); } catch (e) { console.error(`live-probe: alerts.jsonl not written (${e.message})`); }
    if (conf.LEAD_URL) {
      const token = readSecretFile(leadTokenFile(conf));
      const lead = await post(conf.LEAD_URL, line, { title: msg.title, priority: msg.priority, ...(token ? { authorization: `Bearer ${token}` } : {}) }, doc.alerting.timeoutMs);
      if (!lead.ok) console.error(`live-probe: the lead stream did not take the alert (${lead.why}); alerts.jsonl holds it`);
    }
    console.log(`live-probe: ${sent.ok ? 'PAGED' : 'PAGE NOT DELIVERED (re-sent next run)'} [${msg.priority}] ${msg.title}${sent.ok ? '' : ` — ${sent.why}`}`);
  }

  const next = markDelivered(state, delivered);
  try {
    const runs = join(stateDir, 'runs.jsonl');
    // One descriptor for the size check and the write, so nothing can swap the file between them:
    // past the bound it starts over (alerts.jsonl, never truncated, keeps every alert).
    const fd = openSync(runs, 'a+');
    try {
      if (fstatSync(fd).size > RUNS_MAX_BYTES) ftruncateSync(fd, 0);
      writeSync(fd, `${runLine}\n`);
    } finally {
      closeSync(fd);
    }
    writeFileSync(`${statePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(`${statePath}.tmp`, statePath);
  } catch (e) {
    return lost(`the state could not be written to ${stateDir} (${e.message}): the next run cannot count consecutive failures`);
  }

  // The beat comes LAST: it claims a run completed and could page.
  const hb = readSecretFile(conf.HEARTBEAT_URL_FILE);
  if (hb && delivered) {
    const beat = await post(hb, '', {}, doc.alerting.timeoutMs);
    if (!beat.ok) console.error(`live-probe: heartbeat POST failed (${beat.why}); the URL is not printed`);
  }
  return delivered ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
