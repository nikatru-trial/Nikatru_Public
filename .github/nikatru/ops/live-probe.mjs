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
//   node live-probe.mjs --once [--dry-run] [--now <ISO>] [--fixtures <file.json>]
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
    if (r.method !== 'GET' && r.method !== 'HEAD') errors.push(`${id}: method must be GET or HEAD`);
    let u = null;
    try { u = new URL(r.url); } catch { errors.push(`${id}: url does not parse`); }
    if (u && (u.protocol !== 'https:' || u.search || u.hash)) errors.push(`${id}: url must be https with no query and no fragment (a probe never names a transaction)`);
    const e = r.expect ?? {};
    if (!(e.status === 'below-500' || (Array.isArray(e.status) && e.status.length > 0 && e.status.every(Number.isInteger)))) {
      errors.push(`${id}: expect.status must be "below-500" or a non-empty array of integers`);
    }
    if (r.method === 'HEAD' && (e.bodyIncludes || e.launcher)) errors.push(`${id}: a HEAD has no body to judge`);
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

// ── judging one answer ──────────────────────────────────────────────────────

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

/** PURE. One probe's verdict from one answer: `{ok, why}`. `answer` is {status, body} or {error}. */
export function judge(row, answer) {
  if (!answer || answer.error) return { ok: false, why: `no answer (${answer?.error ?? 'none'})` };
  const e = row.expect;
  const statusOk = e.status === 'below-500' ? answer.status < 500 : e.status.includes(answer.status);
  if (!statusOk) return { ok: false, why: `HTTP ${answer.status}, expected ${e.status === 'below-500' ? 'below 500' : e.status.join('/')}` };
  const body = String(answer.body ?? '');
  const missing = (e.bodyIncludes ?? []).filter((s) => !body.includes(s));
  if (missing.length) return { ok: false, why: `HTTP ${answer.status} but the body lacks ${missing.map((s) => JSON.stringify(s)).join(', ')}` };
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
        p.paged = { at, level: 'page', lastNotifiedAt: at };
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

function readSecretFile(path) {
  if (!path) return null;
  try { return readFileSync(path, 'utf8').trim() || null; } catch { return null; }
}

/** One probe's live answer, `{status, body}` or `{error}`. Exported for tooling/ops/owner-page-watch.mjs, the off-Cloudflare
 *  backstop that runs the same probes from GitHub's runners (T-65). */
export async function liveAnswer(row, timeoutMs) {
  try {
    const res = await fetch(row.url, { method: row.method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'nikatru-live-probe/1' } });
    const body = row.method === 'GET' ? await res.text() : '';
    return { status: res.status, body };
  } catch (err) {
    return { error: err?.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : (err?.cause?.code ?? err?.name ?? 'fetch failed') };
  }
}

function fixtureAnswerer(file) {
  const table = JSON.parse(readFileSync(file, 'utf8'));
  return async (row) => table[`${row.method} ${row.url}`] ?? { error: 'fixture has no answer' };
}

/** The owner page's legs, in order: leg 1 (PAGE_URL, the primary) and, when set, leg 2 (PAGE_URL_2). Each leg
 *  carries ITS OWN token file only: a token is never sent to the other leg's host. */
export function pageLegs(conf) {
  return [
    ...(conf.PAGE_URL ? [{ leg: 'primary', url: conf.PAGE_URL, tokenFile: conf.PAGE_TOKEN_FILE }] : []),
    ...(conf.PAGE_URL_2 ? [{ leg: 'leg2', url: conf.PAGE_URL_2, tokenFile: conf.PAGE_TOKEN_FILE_2 }] : []),
  ];
}

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
  const flag = (n) => argv.includes(n);
  const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
  if (!flag('--once')) {
    console.error('usage: live-probe.mjs --once [--dry-run] [--now <ISO>] [--fixtures <file>]');
    return 2;
  }
  const dry = flag('--dry-run');
  const nowMs = arg('--now') ? Date.parse(arg('--now')) : Date.now();
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

  const answer = arg('--fixtures') ? fixtureAnswerer(arg('--fixtures')) : (row) => liveAnswer(row, doc.alerting.timeoutMs);
  const results = await Promise.all(doc.rows.map(async (row) => ({ id: row.id, ...judge(row, await answer(row)) })));
  for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.id} — ${r.why}`);

  const { state, alerts } = decide(prev, results, nowMs, doc.alerting);
  const msg = compose(alerts, nowMs);
  const runLine = JSON.stringify({ v: 1, at: state.lastRunAt, allGreen: results.every((r) => r.ok), results });

  if (dry) {
    console.log('live-probe: DRY RUN — nothing sent, no state written.');
    if (msg) console.log(`  would page [${msg.priority}] ${msg.title}\n${msg.text}`);
    return results.every((r) => r.ok) ? 0 : 1;
  }

  let delivered = true;
  if (msg) {
    const legs = pageLegs(conf);
    const sentLegs = await Promise.all(legs.map(async (l) => {
      const token = readSecretFile(l.tokenFile);
      const headers = { title: msg.title, priority: msg.priority, tags: msg.tags, ...(token ? { authorization: `Bearer ${token}` } : {}) };
      return { leg: l.leg, ...(await post(l.url, msg.text, headers, doc.alerting.timeoutMs)) };
    }));
    const sent = sentLegs.some((l) => l.ok) ? { ok: true } : { ok: false, why: sentLegs.map((l) => `${l.leg}: ${l.why}`).join('; ') };
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
