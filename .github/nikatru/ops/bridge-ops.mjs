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
//   callBridgeOps({url, secret, op, params?, oidc?, now?, fetchImpl?, timeoutMs?})
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
// tooling/ci/test/bridge-ops.test.mjs holds every path against a stubbed bridge.
// ─────────────────────────────────────────────────────────────────────────────
import { createHmac } from 'node:crypto';
import { RATE_WAITS_MS, readUrlOk, sleep } from './bridge-read.mjs';
import { callerToken, oidcHeaders } from './actions-oidc.mjs';

/** @ceiling none — how long one /ops call may take before it is COVERAGE LOST (the bridge makes at most a few GitHub calls). */
export const OPS_TIMEOUT_MS = 30_000;
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

export async function callBridgeOps({ url, secret, op, params = {}, oidc = null, now = Date.now, fetchImpl = globalThis.fetch, timeoutMs = OPS_TIMEOUT_MS, rateWaits = RATE_WAITS_MS, wait = sleep }) {
  if (!url) return { lost: `no bridge ops URL (${OPS_URL_VAR}) in this step` };
  if (!readUrlOk(url) || !/\/ops$/.test(new URL(url).pathname)) return { lost: `${OPS_URL_VAR} is not the bridge's https /ops URL` };
  if (!secret) return { lost: `${OPS_SECRET_VAR} is not set in this step: the call cannot be signed` };
  let res;
  for (let i = 0; ; i++) {
    const caller = oidcHeaders(oidc ? await oidc() : null);
    if (caller.lost) return { lost: `${caller.lost} (/ops ${op})` };
    const body = JSON.stringify({ ...params, op, ts: Math.floor(now() / 1000) });
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-signature': signOps(secret, body), ...caller.headers, 'user-agent': 'nikatru-bridge-ops' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      return { lost: `the bridge's /ops ${op} call failed: ${e?.name ?? 'error'}` };
    }
    if (res.status !== 429 || i >= rateWaits.length) break;
    await res.body?.cancel().catch(() => {});
    await wait(rateWaits[i]);
  }
  let answer = null;
  try {
    answer = await res.json();
  } catch {
    answer = null;
  }
  const why = typeof answer?.error === 'string' ? answer.error.slice(0, 200) : `HTTP ${res.status}`;
  // ⏱ 2026-10-29 · bridge-lastgood-1029: a 502 of `billing` names its last-good copy's age (null: none stored), the one
  // number of the answer carried up; `why` still carries no body.
  const age = answer && typeof answer === 'object' && 'last_good_age_seconds' in answer && (answer.last_good_age_seconds === null || Number.isSafeInteger(answer.last_good_age_seconds)) ? { lastGoodAgeSeconds: answer.last_good_age_seconds } : {};
  if (res.status >= 500 || res.status < 200) return { lost: `the bridge could not complete /ops ${op} (HTTP ${res.status}: ${why})`, ...age };
  if (res.status === 429) return { lost: `the bridge's rate limit refused /ops ${op} (HTTP 429: ${why}) — after ${rateWaits.length + 1} sends` };
  if (res.status === 404 || res.status === 405) return { lost: `the bridge has no /ops door at this URL (HTTP ${res.status}): not deployed there, or an older version at an edge` };
  if (res.status !== 200) return { refused: `the bridge refused /ops ${op} (HTTP ${res.status}: ${why})`, status: res.status };
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return { lost: `the bridge's /ops ${op} answer is not a JSON object` };
  return { answer, status: 200 };
}
