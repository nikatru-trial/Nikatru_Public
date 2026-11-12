#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// owner-page-watch.mjs — THE OWNER PAGE THAT SURVIVES A CLOUDFLARE OUTAGE, A HOSTINGER OUTAGE AND A MAIL DRAIN.
//
// ⏱ 2026-10-17 · live-ops-containment (T-65, a constraint on PT P0-5's phone page). Every page this platform
// sends left through one of three things that fail together with what they report on:
//   · ntfy (the `nikatru-page` topic of tooling/ops/alarm-chains.json) is served from Box B THROUGH THE CLOUDFLARE
//     TUNNEL (tooling/edge/zone.json, ntfy.nikatru.com `proxied: true`) — a Cloudflare or a Hostinger outage takes
//     the page with the site; live-probe.mjs (the minute probe on the ops box) pages there, and runs there;
//   · the platform Worker's owner page (services/platform/src/lib/owner-page.ts) runs ON Cloudflare, pages only
//     after two six-hourly misses, and mails through Resend on the free key password resets share — a mail drain
//     loses it;
//   · GlitchTip's alerts run on Box B and relay through Resend.
// This runner is the second path, on neither: GitHub's runners probe the customer path (the rows of
// tooling/ops/live-probes.json, judged by live-probe.mjs's own `judge`, its `page-channel` row included), EVERY HOUR,
// and page when a row fails twice INSIDE the run (RECHECK_AFTER_MS apart: an hourly backstop has no next minute, and a
// single dropped request must not wake the owner) through:
//   1. OWNER_PAGE_PUSH_URL — a push endpoint that is on neither Cloudflare nor our boxes: the external monitor's
//      push API or a phone-push topic (docs/ops/owner-paging.md). A URL in our own zone, or on any host
//      tooling/edge/zone.json says Cloudflare fronts, is REFUSED (it is the tunnel), and a push that answers through Cloudflare (a `cf-ray` header) is a FINDING: delivered today,
//      lost in the outage it exists for. Optional bearer: OWNER_PAGE_PUSH_TOKEN.
//   2. OWNER_PAGE_HEARTBEAT_URL — the external uptime monitor's heartbeat (O-17, an owner account with its own
//      app or SMS). Beaten ONLY on a run that saw everything healthy and could page: a miss, a run that cannot
//      page, and GitHub Actions stopping altogether all end the beats, and the monitor pages by its own channel.
// Neither path uses Cloudflare, Hostinger or mail. The monitor ALSO probes the Worker itself (its own account's
// setting, O-17): this runner never stands in for it.
//
// Usage: node tooling/ops/owner-page-watch.mjs [--dry-run] [--probes <file>]
//   --dry-run  probe and judge, print the page it would send; send and beat nothing.
// ops-watch.yml's `alert` job pages through THIS file's channels() and zone rules too: tooling/ops/ops-issue.mjs --page-alert.
// Env (names only; values never printed): OWNER_PAGE_PUSH_URL, OWNER_PAGE_PUSH_TOKEN, OWNER_PAGE_HEARTBEAT_URL.
// Exit: 0 the run could page — every probe healthy (heartbeat beaten), or the page delivered. A probe that is DOWN
//       is a page, never a red run · 1 a FINDING: the page went out through Cloudflare · 2 COVERAGE LOST — the probes
//       unreadable, NEITHER channel configured (nothing can page: precondition O-17), a push URL in our own zone, or
//       a page owed and delivered on no channel.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, liveAnswer, validateProbes } from './live-probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROBES_FILE = join(HERE, 'live-probes.json');
export const ENV_NAMES = Object.freeze({ push: 'OWNER_PAGE_PUSH_URL', pushToken: 'OWNER_PAGE_PUSH_TOKEN', heartbeat: 'OWNER_PAGE_HEARTBEAT_URL' });
/** Our zone's ONE source: its name and its DNS records, each saying whether Cloudflare fronts it (`proxied`). */
export const ZONE_FILE = join(HERE, '..', 'edge', 'zone.json');
/**
 * The id of the live-probes.json row that probes the page channel itself (the ntfy server every box-side page goes
 * to). Its loss is invisible to anything that pages through it, so only an off-box watch can say it; a probes file
 * without that row is refused (COVERAGE LOST), never a pass over everything else.
 */
export const PAGE_CHANNEL_ID = 'page-channel';

/** PURE. `{ zone, proxiedHosts }` from a parsed tooling/edge/zone.json; throws when it names no zone. */
export function zoneFacts(doc) {
  if (typeof doc?.zone !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(doc.zone)) throw new Error(`${ZONE_FILE} names no zone`);
  const proxiedHosts = (doc?.dns?.records ?? []).filter((r) => r?.proxied === true && typeof r?.name === 'string').map((r) => r.name.toLowerCase());
  return { zone: doc.zone.toLowerCase(), proxiedHosts };
}
// @ceiling none — a client-side request timeout, not a vendor limit
export const SEND_TIMEOUT_MS = 10_000;
/**
 * The blip filter, inside ONE run (review of #740, finding 2). live-probe.mjs pages on two consecutive failed
 * minute-runs ("a dropped TCP connection must never wake the owner"); an hourly run has no next minute, so every
 * row that fails is probed ONCE more after this pause and pages only if it fails again. 45 s: past a TCP reset and a
 * single edge retry, and well inside the job's 10 minutes.
 */
// @ceiling none — a local wait inside one run, not a vendor limit
export const RECHECK_AFTER_MS = 45_000;

/** PURE. The configured channels, or `{ error }`. A push URL must be https, outside OUR zone and on no host
 *  zone.json says Cloudflare fronts (`zone` is zoneFacts' answer). */
export function channels(env, { zone, proxiedHosts }) {
  const push = (env[ENV_NAMES.push] ?? '').trim() || null;
  const heartbeat = (env[ENV_NAMES.heartbeat] ?? '').trim() || null;
  for (const [name, url] of [[ENV_NAMES.push, push], [ENV_NAMES.heartbeat, heartbeat]]) {
    if (url === null) continue;
    let u;
    try {
      u = new URL(url);
    } catch {
      return { error: `${name} is not a URL` };
    }
    if (u.protocol !== 'https:') return { error: `${name} must be https` };
    const host = u.hostname.toLowerCase();
    if (host === zone || host.endsWith(`.${zone}`) || proxiedHosts.includes(host)) return { error: `${name} is in ${zone}, which Cloudflare fronts (the tunnel; tooling/edge/zone.json): a page through it is lost in the outage it is for` };
  }
  if (push === null && heartbeat === null) return { error: `neither ${ENV_NAMES.push} nor ${ENV_NAMES.heartbeat} is set, so NOTHING can page (precondition O-17: docs/ops/owner-paging.md)` };
  return { push, pushToken: (env[ENV_NAMES.pushToken] ?? '').trim() || null, heartbeat };
}

/** PURE. The page text: one line per probe that is down. */
export function composePage(down, at) {
  return [`NIKATRU DOWN (off-Cloudflare watch, ${at}): ${down.length} check(s) failing.`, ...down.map((d) => `- ${d.id}: ${d.why}`), 'Contain first: docs/ops/incident-response.md, docs/ops/kill-switches.md.'].join('\n');
}

/** PURE. Whether an answer came through Cloudflare. */
export const viaCloudflare = (headers) => Boolean(headers && (headers['cf-ray'] || /cloudflare/i.test(headers.server ?? '')));

/** The default sender: POST the page, `{ ok, status, headers }` (headers lower-cased; never throws). */
export async function sendPush(url, token, title, text, fetchImpl = globalThis.fetch) {
  try {
    const headers = { 'content-type': 'text/plain; charset=utf-8', title, priority: 'urgent', tags: 'rotating_light' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchImpl(url, { method: 'POST', body: text, headers, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    return { ok: res.ok, status: res.status, headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])) };
  } catch (e) {
    return { ok: false, status: 0, headers: {}, error: e?.name ?? 'fetch failed' };
  }
}

/** The default heartbeat: GET the monitor's URL, `{ ok, status }`. */
export async function beat(url, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e?.name ?? 'fetch failed' };
  }
}

/**
 * One run. Every effect is injectable (the tests pass fakes; nothing real is reached):
 *   answer(row, timeoutMs) → {status, body} | {error}   send(url, token, title, text) → {ok, status, headers}
 *   beat(url) → {ok, status}   readProbes() → the probes document   env, now() → Date, log(line)
 * Returns `{ code, down, paged, beaten }`.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    env = process.env,
    answer = liveAnswer,
    send = sendPush,
    beat: beatImpl = beat,
    now = () => new Date(),
    log = (line) => process.stdout.write(`${line}\n`),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = deps;
  const dryRun = argv.includes('--dry-run');
  const at = now().toISOString();
  const i = argv.indexOf('--probes');
  const readProbes = deps.readProbes ?? (() => JSON.parse(readFileSync(i === -1 ? PROBES_FILE : argv[i + 1], 'utf8')));
  const readZone = deps.readZone ?? (() => JSON.parse(readFileSync(ZONE_FILE, 'utf8')));
  const lost = (msg, extra = {}) => (log(`COVERAGE LOST: ${msg}`), { code: 2, down: [], paged: false, beaten: false, ...extra });

  let doc;
  try {
    doc = readProbes();
  } catch (e) {
    return lost(`the probes file is unreadable: ${e.message}`);
  }
  const errors = validateProbes(doc);
  if (errors.length) return lost(`the probes file is invalid: ${errors.join('; ')}`);
  if (!doc.rows.some((r) => r.id === PAGE_CHANNEL_ID)) return lost(`the probes file has no \`${PAGE_CHANNEL_ID}\` row: the page channel itself would go unwatched`);
  let zone;
  try {
    zone = zoneFacts(readZone());
  } catch (e) {
    return lost(`the zone register is unreadable: ${e.message}`);
  }
  const ch = channels(env, zone);
  if (ch.error && !dryRun) return lost(ch.error);

  const probe = (rows) => Promise.all(rows.map(async (row) => ({ id: row.id, ...judge(row, await answer(row, doc.alerting.timeoutMs)) })));
  const first = await probe(doc.rows);
  for (const r of first) log(`${r.ok ? 'ok  ' : 'miss'} ${r.id}: ${r.why}`);
  let down = first.filter((r) => !r.ok);
  if (down.length > 0) {
    // One more look at the rows that failed, after a pause: only a second miss pages.
    log(`${down.length} row(s) failed once — probing them again in ${RECHECK_AFTER_MS / 1000}s before any page.`);
    await sleep(RECHECK_AFTER_MS);
    const again = await probe(doc.rows.filter((row) => down.some((d) => d.id === row.id)));
    for (const r of again) log(`${r.ok ? 'ok  ' : 'DOWN'} ${r.id} (second look): ${r.why}`);
    down = again.filter((r) => !r.ok);
  }

  if (dryRun) {
    log(down.length ? `DRY RUN — would page:\n${composePage(down, at)}` : 'DRY RUN — all healthy; would beat the heartbeat.');
    if (ch.error) log(`NOTE: ${ch.error}`);
    return { code: down.length ? 1 : 0, down, paged: false, beaten: false };
  }

  if (down.length === 0) {
    if (ch.heartbeat === null) {
      log(`ALL HEALTHY. No heartbeat configured (${ENV_NAMES.heartbeat}): the external monitor cannot see this watch stop (precondition O-17).`);
      return { code: 0, down, paged: false, beaten: false };
    }
    const b = await beatImpl(ch.heartbeat);
    if (!b.ok) return lost(`all healthy, but the heartbeat was refused (HTTP ${b.status}${b.error ? `, ${b.error}` : ''}): the monitor will page for a watch that is running`, { down });
    log('ALL HEALTHY. Heartbeat beaten.');
    return { code: 0, down, paged: false, beaten: true };
  }

  // A page is owed. The heartbeat is NOT beaten: its absence is the second channel.
  const text = composePage(down, at);
  log(`PAGE OWED:\n${text}`);
  if (ch.push === null) {
    if (ch.heartbeat === null) return lost('a page is owed and no channel is configured', { down });
    log(`PAGED by withholding the heartbeat only (no ${ENV_NAMES.push}): the monitor pages after its own grace period.`);
    return { code: 0, down, paged: true, beaten: false };
  }
  const sent = await send(ch.push, ch.pushToken, `NIKATRU DOWN: ${down.map((d) => d.id).join(', ')}`.slice(0, 120), text);
  if (!sent.ok) {
    if (ch.heartbeat !== null) {
      log(`WARNING: the push was refused (HTTP ${sent.status}${sent.error ? `, ${sent.error}` : ''}); the withheld heartbeat still pages.`);
      return { code: 2, down, paged: true, beaten: false };
    }
    return lost(`the page could not be delivered (HTTP ${sent.status}${sent.error ? `, ${sent.error}` : ''}) and no heartbeat is configured`, { down });
  }
  if (viaCloudflare(sent.headers)) {
    log(`FINDING: the page was delivered, but ${ENV_NAMES.push} answered through Cloudflare (cf-ray): in a Cloudflare outage it is lost. Point it at a push service Cloudflare does not front.`);
    return { code: 1, down, paged: true, beaten: false };
  }
  log(`PAGED: the push answered HTTP ${sent.status}, off Cloudflare.`);
  return { code: 0, down, paged: true, beaten: false };
}

const isThisModule = () => {
  try {
    return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};
if (isThisModule()) {
  main().then(
    (r) => process.exit(r.code),
    (e) => {
      process.stdout.write(`COVERAGE LOST: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    },
  );
}
