// ─────────────────────────────────────────────────────────────────────────────
// actions-oidc.mjs — the GitHub Actions OIDC token a shell job sends the bridge
// so the bridge knows WHICH run is calling (services/gh-bridge/src/oidc.ts).
//
// ⏱ 2026-10-07 · propose-door-followups (review B, finding 1): POST /propose
// first. ⏱ 2026-10-08 · sysfix-a4-gh-bridge (system review A4-gh-bridge,
// findings A4-01 and A4-02): POST /pr-meta, /ops and /artifact too — a shared
// key alone opened them for ANY live run (or none), and the keys sit in steps
// that run a PR's own code or third-party code. The runner hands a job that
// holds `id-token: write` (tooling/ci/gen-public-shell.mjs grants it to every job
// with a step that holds a bridge key) ACTIONS_ID_TOKEN_REQUEST_URL and _TOKEN;
// GitHub signs the token's run_id, run_attempt and workflow_ref for THAT job.
//
//   mintOidc(env, {fetchImpl?, sleep?})  {token} | {lost: why} — the job must hold the right; a
//       network error or a 5xx/429 is asked again on bounded-retry.mjs's plan, a 4xx is lost at once.
//   callerToken(env, {fetchImpl?})  {token} | {none: why} | {lost: why} — `none` when the
//       runner offers no endpoint (a job of a shell published before the right was
//       granted): the client then sends no X-Bridge-OIDC, and a bridge that binds its
//       caller refuses it (403) with the reason. A runner that offers the endpoint but
//       will not mint is `lost` (COVERAGE LOST), never a silent send without a token.
// The token is never printed. tooling/ci/test/actions-oidc.test.mjs holds every path.
// ─────────────────────────────────────────────────────────────────────────────

import { CouldNotLook, fetchWithBoundedRetry } from './bounded-retry.mjs';

/** The audience the bridge accepts: services/gh-bridge/src/propose-policy.ts OIDC_AUDIENCE (held equal by
 *  services/gh-bridge/test/propose.test.ts). One audience for every door: the claims, not the audience, bind a run. */
export const BRIDGE_OIDC_AUDIENCE = 'nikatru-gh-bridge-propose';
/** The header a bound door reads the token from. */
export const OIDC_HEADER = 'x-bridge-oidc';
/** A JWT's shape: what an Actions OIDC token is, and nothing that could carry a header break. */
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The OIDC token this job mints for the bridge: {token} | {lost}. */
export async function mintOidc(env = process.env, { fetchImpl = globalThis.fetch, audience = BRIDGE_OIDC_AUDIENCE, sleep, note = (line) => console.log(`  bridge-oidc: ${line}`) } = {}) {
  const url = String(env.ACTIONS_ID_TOKEN_REQUEST_URL ?? '');
  const bearer = String(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? '');
  if (!url || !bearer) return { lost: 'no ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN in this step: its job does not hold `id-token: write` (gen-public-shell.mjs grants it to each job with a step that holds a bridge key), so the bridge cannot tell which run is calling' };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { lost: 'ACTIONS_ID_TOKEN_REQUEST_URL is not a URL' };
  }
  if (u.protocol !== 'https:') return { lost: 'ACTIONS_ID_TOKEN_REQUEST_URL is not https' };
  u.searchParams.set('audience', audience);
  // ⏱ 2026-11-05 · crawl-fix-1105 (row O-BRIDGE-ARTIFACT-OIDC-NO-RETRY): crawl 41985174443's tablet s1of4 cell
  // finished its crawl, then lost its upload to ONE `TypeError` on this request. The request now rides the shared
  // plan (bounded-retry.mjs fetchWithBoundedRetry): a dropped connection or a 5xx/429 from the runner's token
  // service is asked again on its doubling backoff; a 4xx is the runner's ANSWER (no right, wrong audience) and is
  // `lost` at once; a failure that outlives the plan stays `lost`.
  let res;
  try {
    res = await fetchWithBoundedRetry(
      ({ signal }) => fetchImpl(u.href, { headers: { authorization: `bearer ${bearer}`, accept: 'application/json; api-version=2.0', 'user-agent': 'nikatru-bridge-oidc' }, signal, redirect: 'error' }),
      { describe: (what) => `the OIDC token request failed: ${what}`, sleep, note },
    );
  } catch (e) {
    return { lost: e instanceof CouldNotLook ? e.message : `the OIDC token request failed: ${e?.name ?? 'error'}` };
  }
  try {
    if (!res.ok) return { lost: `the runner would not mint the OIDC token (HTTP ${res.status})` };
    const value = (await res.json())?.value;
    if (typeof value !== 'string' || !JWT.test(value)) return { lost: 'the runner answered with no OIDC token' };
    return { token: value };
  } catch (e) {
    return { lost: `the OIDC token request failed: ${e?.name ?? 'error'}` };
  }
}

/** The token a client of a caller-bound door sends: {token} | {none} (no endpoint offered) | {lost}. */
export async function callerToken(env = process.env, opts = {}) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL && !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return { none: 'this job holds no `id-token: write`: no OIDC token is sent, and a bridge that binds its caller refuses the call' };
  return mintOidc(env, opts);
}

/** The headers a call carries for `oidc` (a callerToken() answer, or null for none); {headers} | {lost}. */
export function oidcHeaders(t) {
  if (!t || t.none) return { headers: {} };
  if (t.lost) return { lost: t.lost };
  return { headers: { [OIDC_HEADER]: t.token } };
}
