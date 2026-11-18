// ─────────────────────────────────────────────────────────────────────────────
// bridge-ops.mjs — the shell's ops duties ask the bridge for what only its token
// may read or write: POST /ops (services/gh-bridge/src/ops.ts).
//
// ⏱ 2026-10-06 · ops-watch-postcutover (lead decision: one door, three uses).
// After the cutover the shell's own GITHUB_TOKEN cannot read the private code
// repository, no account-admin PAT may sit among the PUBLIC shell's secrets, and
// an ops issue filed in the public shell would publish ops detail. So:
//   billing          the shell owner's Actions billing ledger
//                    (tooling/ci/assert-runner-budget.mjs); params `accept_last_good: true`
//                    (⏱ 2026-10-29 · bridge-lastgood-1029, opt-in) lets the bridge answer a live
//                    read's outside hiccup from the ledger's last-good copy ≤ 24 h old, listed in
//                    the answer's `lastGood` (graded AMBER: tooling/ops/last-good-reads.mjs); its
//                    502 then carries `last_good_age_seconds`, surfaced as `lost`'s `lastGoodAgeSeconds`;
//   issue-activity   the private repo's newest issue whose title contains a
//                    fragment (tooling/ci/assert-ops-register.mjs, duty.renovate);
//   branch-state     ⏱ 2026-10-07 · final-review-ci: whether each branch the
//                    failure ledger's rows name still exists in the private
//                    repo, and its pull request (tooling/ops/triage-failed-runs.mjs);
//   ops-issue        the durable ops issue in the private repo, for a live run
//                    of the workflow that files it (tooling/ops/ops-issue.mjs).
//
//   callBridgeOps({url, secret, op, params?, oidc?, now?, fetchImpl?, timeoutMs?, hiccupWaits?})
//     POST {op, ts, ...params} with X-Bridge-Signature = sha256=HMAC-SHA256 of the
//     RAW body under `secret` (BRIDGE_READ_SECRET), and — ⏱ sysfix-a4-gh-bridge
//     (A4-01) — X-Bridge-OIDC, the token `oidc()` gives (./actions-oidc.mjs
//     callerToken; null sends none): the bridge serves an op only to a live run of
//     a workflow whose steps make it, never on the key alone.
//     → {answer, status: 200}
//     → {refused: why, status} — the bridge answered 4xx: it looked and said no
//       (a forged or stale run, a bad signature, a malformed op);
//     → {lost: why} — no URL, no secret, a bad URL, the network, a 5xx (the
//       bridge's upstream failed), a 404 or 405 (no /ops door at that URL: the
//       bridge is not deployed there, or an edge still serves a version without
//       it — the /ops handler itself never answers either) or an answer that is
//       not JSON. Every caller
//       turns `lost` into COVERAGE LOST (exit 2), never a pass. `why` never
//       carries an answer's body.
//   opsEnv(env)  {url, secret, oidc} from NIKATRU_BRIDGE_OPS_URL / BRIDGE_READ_SECRET
//     and this job's OIDC token source,
//     which gen-public-shell.mjs puts in exactly the steps public-shell.json
//     `bridgeOps.steps` declares. `url` empty outside the shell: the callers
//     then keep their own pre-cutover read.
//
// ⏱ 2026-10-10 · fix-pr216 (independent review of PR #216, finding 1): a 429 (the bridge's per-minute bucket) is
// TRANSIENT, never `refused`: the call is re-signed and sent again after each of RATE_WAITS_MS (./bridge-read.mjs),
// and a 429 after the last is `lost` (COVERAGE LOST), never a verdict.
//
// ⏱ 2026-11-15 · bl-platformx1-1-aw202611151727 (row O-GITHUB-HICCUP-FREEZES-MERGES, CONTAIN IMPACT item 2): ONE
// outside hiccup still froze merges after bridge-lastgood-1029. The bridge's last-good copies cover the issuer keys and
// the billing ledger, but its live re-read of the CALLER's run (src/oidc.ts readCaller, deliberately never answered
// from a copy) answers a bare 502 when GitHub hiccups. A cold isolate with no usable keys answers 502 as well, and
// src/oidc.ts says "a client may try again". So does a send whose wire drops or times out. callBridgeOps sent ONCE, so each
// of these was `lost`: runner-budget exit 2, a red job of a blocking unit, frozen merges. `hiccupWaits` (default none)
// lets a READ caller re-sign and resend after each wait on such a TRANSIENT answer: a thrown send, or a 502/503/504
// that carries no `last_good_age_seconds`. That field means the bridge already fell back to its copy and the copy is
// too old or absent, so a resend cannot help and that answer stays `lost` at once. A write (ops-issue) never opts in:
// a lost response there may have filed the issue (class 21). Every resend is re-signed with a fresh ts and token,
// like a 429. The answer lists what was re-asked in `hiccups`, so the reader prints it. Nothing is silently absorbed.
//
// tooling/ci/test/bridge-ops.test.mjs holds every path against a stubbed bridge.
// ─────────────────────────────────────────────────────────────────────────────
import { createHmac } from 'node:crypto';
import { RATE_WAITS_MS, readUrlOk, sleep } from './bridge-read.mjs';
import { callerToken, oidcHeaders } from './actions-oidc.mjs';
import { READ_ATTEMPTS, READ_WALL_CEILING_MS, backoffPlan } from './bounded-retry.mjs';

/** @ceiling none — how long one /ops call may take before it is COVERAGE LOST (the bridge makes at most a few GitHub calls). */
export const OPS_TIMEOUT_MS = 30_000;
/** @ceiling none — O-GITHUB-HICCUP-FREEZES-MERGES: the waits before each resend of a READ whose send hit a transient
 *  hiccup (see the header). ONE resend after 20 s: one GitHub 502 or one dropped wire clears, and a longer outage is
 *  still `lost`. Each send can also spend the OIDC mint's own plan (./actions-oidc.mjs mintOidc, READ_WALL_CEILING_MS
 *  ≈ 55 s) before its OPS_TIMEOUT_MS. So the worst case is (1 + 1 + 2 rate resends) x (55 s + 30 s) + 20 s + 65 s
 *  ≈ 7.1 min. With checkout and setup-node that still fits runner-budget's 10-min job (bridge-ops.test.mjs O7 holds
 *  it). A second resend would not fit: about 9.2 min of the 10. */
export const READ_HICCUP_WAITS_MS = Object.freeze([20_000]);
/** @ceiling none — ⏱ 2026-11-16 · O-HICCUP-WAITS-SHELL-BARRIERS-AND-ISSUE-ACTIVITY (lead ruling rulings-batch-1116 item
 *  12(1)): the plan of an ops-watch READ beside runner-budget's billing (assert-shell-barriers.mjs `shell-barriers`,
 *  ops-register-ops-watch.mjs `issue-activity`): callBridgeOps's own OPS_TIMEOUT_MS and RATE_WAITS_MS, kept as they are
 *  (the bridge's OPS_BUDGET_MS, 20 s, sits 10 s under the 30 s send, and the two 429 waits span the /ops door's 60 s
 *  window), plus the ONE hiccup resend of READ_HICCUP_WAITS_MS. Worst case (readPlanWorstMs): 4 x (55 s + 30 s) + 65 s
 *  + 20 s = 425 s. Each caller's own test holds it against its job's timeout-minutes in ops-watch.yml. */
export const OPS_WATCH_READ_PLAN = Object.freeze({ hiccupWaits: READ_HICCUP_WAITS_MS });
/** @ceiling none — ⏱ 2026-11-17 · O-RUNNER-BUDGET-BILLING-READ-502: runner-budget's billing read is THREE attempts, the
 *  shared plan of ./bounded-retry.mjs (READ_ATTEMPTS, backoffPlan: gaps of 1 s then 2 s), never a number of its own.
 *  GitHub's billing endpoint 502s on and off, and one resend was not enough. Short gaps are what let the second resend
 *  fit: worst case 5 x (55 s + 30 s) + 65 s + 3 s = 493 s, plus 90 s of checkout and setup, inside runner-budget's
 *  10-min job (bridge-ops.test.mjs O7 holds it). An answer still lost after the third send is `transient` (below):
 *  assert-runner-budget.mjs reports it UNKNOWN (ruling 11-16 #30), never a pass and never exit 2. */
export const BILLING_READ_HICCUP_WAITS_MS = Object.freeze(backoffPlan(READ_ATTEMPTS));
/** PURE. The longest a callBridgeOps with this plan can take: every send spends the OIDC mint's whole plan
 *  (READ_WALL_CEILING_MS) AND times out, after every rate and hiccup wait. Defaults are callBridgeOps's own. */
export function readPlanWorstMs({ timeoutMs = OPS_TIMEOUT_MS, rateWaits = RATE_WAITS_MS, hiccupWaits = [] } = {}) {
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return (1 + rateWaits.length + hiccupWaits.length) * (READ_WALL_CEILING_MS + timeoutMs) + sum(rateWaits) + sum(hiccupWaits);
}
/** The bridge statuses that mean "an upstream hiccup, try again", never "the bridge looked and said no". */
const HICCUP_STATUSES = new Set([502, 503, 504]);
export const OPS_URL_VAR = 'NIKATRU_BRIDGE_OPS_URL';
/** ⏱ 2026-10-08 · sysfix-a1-ci-shell (review A1-ci-shell m8): /ops's OWN key, beside the read key in each ops step until
 *  the owner sets it in the shell; signed with it when set (the bridge's opsKey), else with the read key, as before. */
export const OPS_OWN_SECRET_VAR = 'BRIDGE_OPS_SECRET';
export const OPS_SECRET_VAR = 'BRIDGE_READ_SECRET';

/** `sha256=<hex>` of the raw body under `secret` — what services/gh-bridge/src/hmac.ts verifySignature checks. */
export const signOps = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** The door's URL and key in this step, read by name. */
export function opsEnv(env = process.env) {
  return { url: String(env[OPS_URL_VAR] ?? '').trim(), secret: String(env[OPS_OWN_SECRET_VAR] || env[OPS_SECRET_VAR] || ''), oidc: () => callerToken(env) };
}

export async function callBridgeOps({ url, secret, op, params = {}, oidc = null, now = Date.now, fetchImpl = globalThis.fetch, timeoutMs = OPS_TIMEOUT_MS, rateWaits = RATE_WAITS_MS, hiccupWaits = [], wait = sleep }) {
  if (!url) return { lost: `no bridge ops URL (${OPS_URL_VAR}) in this step` };
  if (!readUrlOk(url) || !/\/ops$/.test(new URL(url).pathname)) return { lost: `${OPS_URL_VAR} is not the bridge's https /ops URL` };
  if (!secret) return { lost: `${OPS_SECRET_VAR} is not set in this step: the call cannot be signed` };
  let res;
  let answer = null;
  const hiccups = [];
  // ⏱ 2026-11-17 · O-RUNNER-BUDGET-BILLING-READ-502: the LAST send's own hiccup (none: null). A loss whose last send was
  // itself a hiccup is marked `transient: true` — an upstream outage that outlived the plan, not a refusal or a config gap.
  let lastHiccup = null;
  for (let rate = 0; ; ) {
    const caller = oidcHeaders(oidc ? await oidc() : null);
    if (caller.lost) return { lost: `${caller.lost} (/ops ${op})` };
    const body = JSON.stringify({ ...params, op, ts: Math.floor(now() / 1000) });
    let thrown = null;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-signature': signOps(secret, body), ...caller.headers, 'user-agent': 'nikatru-bridge-ops' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      thrown = `the bridge's /ops ${op} call failed: ${e?.name ?? 'error'}`;
    }
    if (thrown === null && res.status === 429 && rate < rateWaits.length) {
      await res.body?.cancel().catch(() => {});
      await wait(rateWaits[rate++]);
      continue;
    }
    answer = null;
    if (thrown === null) {
      try {
        answer = await res.json();
      } catch {
        answer = null;
      }
    }
    // O-GITHUB-HICCUP-FREEZES-MERGES: a transient hiccup is re-asked only by a caller that opted in (a read).
    const copyTooOld = answer !== null && typeof answer === 'object' && 'last_good_age_seconds' in answer;
    const hiccup = thrown ?? (HICCUP_STATUSES.has(res.status) && !copyTooOld ? `HTTP ${res.status}` : null);
    lastHiccup = hiccup;
    if (hiccup !== null && hiccups.length < hiccupWaits.length) {
      await wait(hiccupWaits[hiccups.length]);
      hiccups.push(hiccup);
      continue;
    }
    if (thrown !== null) return { lost: hiccups.length ? `${thrown} — after ${hiccups.length + 1} sends (${hiccups.join(', ')})` : thrown, transient: true };
    break;
  }
  const again = hiccups.length ? { hiccups } : {};
  const why = typeof answer?.error === 'string' ? answer.error.slice(0, 200) : `HTTP ${res.status}`;
  // ⏱ 2026-10-29 · bridge-lastgood-1029: a 502 of `billing` names its last-good copy's age (null: none stored), the one
  // number of the answer carried up; `why` still carries no body.
  const age = answer && typeof answer === 'object' && 'last_good_age_seconds' in answer && (answer.last_good_age_seconds === null || Number.isSafeInteger(answer.last_good_age_seconds)) ? { lastGoodAgeSeconds: answer.last_good_age_seconds } : {};
  const sends = hiccups.length ? ` — after ${hiccups.length + 1} sends (${hiccups.join(', ')})` : '';
  if (res.status >= 500 || res.status < 200) return { lost: `the bridge could not complete /ops ${op} (HTTP ${res.status}: ${why})${sends}`, ...age, ...(lastHiccup !== null ? { transient: true } : {}) };
  if (res.status === 429) return { lost: `the bridge's rate limit refused /ops ${op} (HTTP 429: ${why}) — after ${rateWaits.length + hiccups.length + 1} sends` };
  if (res.status === 404 || res.status === 405) return { lost: `the bridge has no /ops door at this URL (HTTP ${res.status}): not deployed there, or an older version at an edge` };
  if (res.status !== 200) return { refused: `the bridge refused /ops ${op} (HTTP ${res.status}: ${why})`, status: res.status };
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return { lost: `the bridge's /ops ${op} answer is not a JSON object` };
  return { answer, status: 200, ...again };
}
