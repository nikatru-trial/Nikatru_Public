// ─────────────────────────────────────────────────────────────────────────────
// bridge-read.mjs — the shell's ci-gate reads a private pull request AS IT IS
// NOW, through the bridge's POST /pr-meta (services/gh-bridge/src/pr-meta.ts).
//
// ⏱ 2026-10-05 · lead ruling p7-bridge-payload-r2, item 4. A private PR's body
// never travels in the public repository's dispatch payload; the shell's own
// token cannot read the private repository; so the gate asks the bridge, the
// only holder of a private-repo token, at gate time. A re-run of ci-gate (by
// hand, or the shell's pr-recheck.yml after an edit) therefore judges the body
// as it is now, never a replayed one. This is the ONE module that makes that
// read: tooling/ci/gate-pr-body.mjs calls it, and nothing reads the body from
// repos/$GITHUB_REPOSITORY/pulls in the shell.
//
//   readPrMeta({url, secret, number, sha, oidc?, now?, fetchImpl?, timeoutMs?})
//     POST {number, sha, ts} with X-Bridge-Signature = sha256=HMAC-SHA256 of
//     `<number>.<sha>.<ts>` under `secret` (BRIDGE_READ_SECRET), and — ⏱
//     sysfix-a4-gh-bridge (A4-01) — X-Bridge-OIDC, the token `oidc()` gives
//     (./actions-oidc.mjs callerToken; null sends none): the bridge reads a PR
//     only for a live run of that PR, never on the key alone. ⏱ 2026-10-08 · A7-05:
//     in the shell the gate's own pre-read signs it (readPrMetaFile, below); this is the
//     form for a shell generated before the pre-read existed.
//     → {meta: {number, head_sha, state, draft, base_ref, created_at, body}}
//     → {lost: why} — no URL, no secret, a bad input, a refused or failed read,
//       or an answer of the wrong shape. The caller treats `lost` as COVERAGE
//       LOST (exit 2), never as a pass. `why` never carries the body: a failed
//       answer's text is not read into it.
//
//   readPrMetaFile({file, number, readFile?})
//     ⏱ 2026-10-08 · A7-05 (system review A7-security-supply). In the shell the read is no longer
//     made HERE: the PR's own code must not hold BRIDGE_READ_SECRET. The gate job's generated
//     pre-read step — the shell's own copy of tooling/ci/shell-report.py (`pr-meta`), before any
//     private code of the job runs — signs the read, with its job's OIDC token, and writes the answer
//     (or {lost}) to NIKATRU_PR_META_FILE; this reads that file through the same shape check.
//     → {meta} | {lost}, as readPrMeta.
//
// ⏱ 2026-10-10 · fix-pr216 (independent review of PR #216, finding 1): a 429 is the bridge's per-minute bucket
// (services/gh-bridge/src/intake.ts), not a verdict, so it is TRANSIENT: the read is re-signed (a fresh `ts` and
// token) and sent again after each of RATE_WAITS_MS — together past one bucket period — and only a 429 after the
// last is lost. tooling/ops/bridge-ops.mjs and bridge-artifact.mjs retry a 429 on the same waits.
//
// ⏱ 2026-10-13 · fix-bridge-report-403-race (PR #553): a send that got NO answer (fetch's TypeError) is resent the
// same way after each of NETWORK_WAITS_MS; a TimeoutError (the bridge took the connection and did not answer in
// READ_TIMEOUT_MS) is lost at once, as is every HTTP answer but a 429.
//
// tooling/ci/test/bridge-read.test.mjs holds every path against a stubbed bridge. It lives in
// tooling/ops beside land-rules.mjs, the gate's other shared module: it scans nothing, so the
// coverage question is its caller's (gate-pr-body.mjs turns every `lost` into exit 2).
// ─────────────────────────────────────────────────────────────────────────────
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { oidcHeaders } from './actions-oidc.mjs';

const SHA = /^[0-9a-f]{40}$/;
/** @ceiling none — how long one read may take before it is COVERAGE LOST (the bridge makes one GitHub GET). */
export const READ_TIMEOUT_MS = 20_000;
/** @ceiling none — fix-pr216 (finding 1): the waits before re-sending a call the bridge's rate bucket refused (429);
 *  together past the bucket's 60 s period (wrangler.jsonc `ratelimits`), so the last send meets a fresh bucket. */
export const RATE_WAITS_MS = Object.freeze([20_000, 45_000]);
/** @ceiling none — the waits before re-sending a read whose send got no answer at all (fetch's TypeError: a dropped
 *  connection or a DNS blip, PR #553); short, because the gate's other reads wait on this one. */
export const NETWORK_WAITS_MS = Object.freeze([2_000, 6_000]);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The string the bridge verifies: `<number>.<sha>.<ts>` (services/gh-bridge/src/pr-meta.ts readMessage). */
export const readMessage = (number, sha, ts) => `${number}.${sha}.${ts}`;

/** `sha256=<hex>` of `message` under `secret`. */
export const signRead = (secret, message) => `sha256=${createHmac('sha256', secret).update(message).digest('hex')}`;

/** True for the bridge's https URL, or a loopback http one (the tests' stub). */
export function readUrlOk(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password || u.search || u.hash) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}

/** The answer's shape, or why it is not the bridge's. */
function metaOf(raw, number) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'the answer is not an object';
  if (raw.number !== number) return `the answer names PR ${JSON.stringify(raw.number)}, not #${number}`;
  if (typeof raw.head_sha !== 'string' || !SHA.test(raw.head_sha)) return 'the answer has no head sha';
  if (typeof raw.state !== 'string' || raw.state === '') return 'the answer has no state';
  if (typeof raw.draft !== 'boolean') return 'the answer has no draft flag';
  if (typeof raw.base_ref !== 'string' || raw.base_ref === '') return 'the answer has no base ref';
  if (raw.body !== null && typeof raw.body !== 'string') return 'the answer\'s body is neither text nor null';
  return { number, head_sha: raw.head_sha, state: raw.state, draft: raw.draft, base_ref: raw.base_ref, created_at: raw.created_at ?? null, body: raw.body ?? '' };
}

export async function readPrMeta({ url, secret, number, sha, oidc = null, now = Date.now, fetchImpl = globalThis.fetch, timeoutMs = READ_TIMEOUT_MS, rateWaits = RATE_WAITS_MS, networkWaits = NETWORK_WAITS_MS, wait = sleep }) {
  if (!url) return { lost: 'no bridge read URL (NIKATRU_BRIDGE_READ_URL) in this step' };
  if (!readUrlOk(url)) return { lost: 'the bridge read URL is not an https URL' };
  if (!secret) return { lost: 'BRIDGE_READ_SECRET is not set in this step: the read cannot be signed' };
  if (!Number.isSafeInteger(number) || number <= 0) return { lost: 'the PR number is not a positive integer' };
  if (typeof sha !== 'string' || !SHA.test(sha)) return { lost: 'the head sha is not 40 lowercase hex' };
  let res;
  for (let i = 0, k = 0; ; ) {
    const caller = oidcHeaders(oidc ? await oidc() : null);
    if (caller.lost) return { lost: caller.lost };
    const ts = Math.floor(now() / 1000);
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-signature': signRead(secret, readMessage(number, sha, ts)), ...caller.headers },
        body: JSON.stringify({ number, sha, ts }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      // ⏱ 2026-10-13 · fix-bridge-report-403-race (PR #553, public run 38429317211 attempt 2): fetch's TypeError is
      // a send that never got an answer (a dropped connection, a DNS blip), and one lost the gate of a run whose
      // every lane was green. Re-signed and sent again after each of NETWORK_WAITS_MS; a timeout is never resent.
      if (e?.name === 'TypeError' && k < networkWaits.length) {
        await wait(networkWaits[k++]);
        continue;
      }
      const sends = k + 1 + i;
      return { lost: `the bridge read failed: ${e?.name ?? 'error'}${e?.name === 'TypeError' ? ` — after ${sends} sends` : ''}` };
    }
    if (res.status !== 429 || i >= rateWaits.length) break;
    await res.body?.cancel().catch(() => {});
    await wait(rateWaits[i++]);
  }
  if (res.status === 429) return { lost: `the bridge's rate limit refused the read (HTTP 429) — after ${rateWaits.length + 1} sends` };
  if (res.status !== 200) return { lost: `the bridge refused the read (HTTP ${res.status})` };
  let raw;
  try {
    raw = await res.json();
  } catch {
    return { lost: 'the bridge answered something that is not JSON' };
  }
  const meta = metaOf(raw, number);
  return typeof meta === 'string' ? { lost: meta } : { meta };
}

/** The pre-read's answer from `file` (NIKATRU_PR_META_FILE), through the same shape check as a live read. */
export function readPrMetaFile({ file, number, readFile = (f) => readFileSync(f, 'utf8') }) {
  if (!file) return { lost: 'no pre-read file (NIKATRU_PR_META_FILE) in this step' };
  if (!Number.isSafeInteger(number) || number <= 0) return { lost: 'the PR number is not a positive integer' };
  let raw;
  try {
    raw = JSON.parse(readFile(file));
  } catch {
    return { lost: 'the pre-read file is absent or not JSON: the gate\'s pre-read step did not run to its end' };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.lost === 'string') return { lost: `the pre-read failed: ${raw.lost}` };
  const meta = metaOf(raw, number);
  return typeof meta === 'string' ? { lost: meta } : { meta };
}
