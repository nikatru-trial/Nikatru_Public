// ─────────────────────────────────────────────────────────────────────────────
// bounded-retry.mjs — THE ONE READING OF "IS THIS FAILURE A BLIP OR AN OUTAGE?"
// FOR EVERY READER UNDER tooling/ops/.
//
// NOT A GUARD. It scans nothing, reads no file, makes no request and never sets
// an exit code. Pure classification plus one injectable sleep. The COVERAGE LOST
// decision stays with the caller, exactly as it does for text-reductions.mjs and
// capture-suite-scan.mjs: this module answers "ask again?", never "is it fine?".
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
// 🔴 ONE DROPPED TCP CONNECTION TURNED A WHOLE ops-watch RUN RED (row
// O-PAGES-FETCH-TRANSIENT-NOT-RETRIED). Run 35478397730 read
// `✗ nikatru (git) — TypeError: fetch failed`: 0 RED, 1 NOT JUDGED, exit 2, while
// the other two projects read fine in the SAME run and a dispatch sixteen minutes
// later was green. A red ops-watch reddens `ci-gate` on `main`, so that blip froze
// the merge queue — and it teaches every reader to shrug at an ops-watch red,
// which is how a genuinely red one (eight missed heartbeats) sat unnoticed for
// eight hours the same day.
//
// #852 fixed that ONE reader and said, in its own header, that the class sweep
// wanted a shared `tooling/ops/` retry module. This is that module, and the
// primitives below are #852's, MOVED rather than rewritten: same names, same
// numbers, same semantics. check-pages-deployments.mjs now imports them and
// re-exports them, so the 82 cases it already shipped are the green control for
// the move (MOVED CODE SILENCES GUARDS — the move was proved before the sweep
// that follows it, not assumed).
//
// ── THE MEASURED CLASS, SWEPT 2026-09-21 ────────────────────────────────────
// ELEVEN readers under tooling/ops/ turned a single un-retried `fetch` into a
// run-level verdict with NO retry of any kind — check-heartbeats,
// check-analytics-liveness, status, verify-supabase-templates,
// check-prod-provenance, verify-monitors, verify-alarm-chains,
// verify-auth-providers, check-wildcard-dns, check-turnstile-hosts,
// check-retired-names-live. Two more had a private one:
// check-d1-accepts-live-sql retried ONCE with no gap and only on a transport
// throw (a 429 was final), and verify-free-api-scope had a module-local
// `fetchWithRetry` on a LINEAR gap. record-deployment.mjs exports the policy
// primitives (`RETRY_ATTEMPTS`, `isRetryable`, `retryDelayMs`) but no wrapper,
// and its policy is GitHub-shaped: it deliberately EXCLUDES 429, which for the
// Cloudflare API is exactly the "ask again" case. So it is not the home for this,
// and this module does not shadow its exports with different meanings.
//
// 🔴 `status.mjs` WAS THE WORST SHAPED, AND ITS DEFECT WAS THE VERDICT, NOT THE
// RETRY. `probeLive` turned EVERY transport failure into `{ error }`, which
// `evaluateSurface` reds as `unreachable`, which exits 1 — "I LOOKED, IT IS
// BROKEN". A DNS blip on the runner therefore accused a healthy surface of being
// down. Un-reached is not the same claim as broken, and this repo already spends
// a whole exit code on the difference.
//
// ── THE THREE-VALUED CONTRACT THIS MODULE SERVES ────────────────────────────
//   0  green       · 1  a finding (it really is wrong) · 2  COVERAGE LOST
// A failure that outlives the plan STAYS at the caller's COVERAGE LOST. The
// retry distinguishes a blip from an outage; it forgives neither. Swallowing a
// persistent failure into a pass would turn a real vendor outage into a green
// sweep, which is strictly worse than the false red this module exists to remove.
//
// ── THE NUMBERS, AND WHY EACH ONE IS THAT NUMBER ────────────────────────────
// Every constant here is JUDGEMENT recorded as judgement. None is a vendor SLA
// and none may be cited as one.
//
//   READ_ATTEMPTS = 3, RETRY_BASE_MS = 1000  →  gaps of 1 s then 2 s, so
//   RETRY_CEILING_MS = 3 s of waiting per read. The measured defect is ONE
//   dropped connection, which needs one more try and not six. #852's numbers,
//   unchanged, so adopting this module cannot move the behaviour that row proved.
//
//   RETRY_AFTER_CEILING_MS = 5000. A server that sends `Retry-After` has told us
//   when it will answer; asking sooner burns an attempt on a refusal it already
//   announced. But an honoured header is an UNBOUNDED wait unless it is clamped,
//   and the arithmetic has to fit the smallest job in ops-watch.yml, which is
//   `timeout-minutes: 5` (300 s). The widest fan-out on this lane is status.mjs,
//   which probes one surface per declared hostname at PROBE_TIMEOUT_MS = 10 s
//   each. At ten surfaces the worst case is 10 × 2 gaps × 5 s = 100 s of waiting
//   plus 10 × 10 s = 100 s of probing = 200 s, inside 300 s with margin. At 8 s
//   the same arithmetic reaches 260 s, which is inside the timeout but not inside
//   it with room to be wrong about the surface count.
//   ⏱ APPENDED 2026-09-22 (row O-OPS-READER-NO-CEILING): the `timeout-minutes: 5`
//   job above is `alert`, which runs no reader. Every job that runs a reader is
//   `timeout-minutes: 10` (600 s), and the sum that has to fit it is the one in
//   "THE PER-REQUEST CEILING" below, not this one. The 5 s clamp is unchanged.
//   ⏱ APPENDED 2026-09-25 (row O-OPS-PROBE-US-EDGE-STALL): status.mjs now adds
//   ONE second look, run IN PARALLEL over the surfaces its sweep left unreached,
//   so it adds one second look's wall clock, not one per surface. Its worst case
//   is DERIVED in status.mjs (`statusWorstCaseMs`) from these constants:
//   N × (3 × 10 s + RETRY_WALL_CEILING_MS 10 s) + secondLookWallMs(10 s) 85 s
//   = 11 × 40 s + 85 s = 525 s for the 11 surfaces probed on 2026-09-25, inside
//   the status job's `timeout-minutes: 10` (600 s) with 75 s to spare.
//   ops-status.test.mjs case (d) re-derives it from the live register and the
//   workflow on every run. See "THE SECOND LOOK" below.
//
//   REQUEST_TIMEOUT_MS = 15 000. The longest ONE attempt may take, armed HERE
//   and not in each reader (see "THE PER-REQUEST CEILING"). 15 s is the ceiling
//   this repository already uses for one request in assert-ops-register.mjs,
//   assert-alert-disposition.mjs and post-deploy-smoke.mjs, so it is not a new
//   number; it is the one number moved to where every reader inherits it.
//
//   READ_WALL_CEILING_MS is DERIVED: attempts × REQUEST_TIMEOUT_MS +
//   RETRY_WALL_CEILING_MS = 3 × 15 s + 10 s = 55 s, the most wall clock ONE read
//   may spend in total when every attempt hangs to the ceiling and the server
//   asks for the longest wait on every gap.
//
//   RETRY_WALL_CEILING_MS is DERIVED, never typed: (attempts − 1) ×
//   RETRY_AFTER_CEILING_MS — the most wall-clock ONE read may spend waiting even
//   when the server asks for longer on every gap. A hand-copied ceiling is the
//   number that drifts away from the loop it claims to describe, which is why
//   RETRY_CEILING_MS is SUMMED from backoffPlan() too.
//
// ── WHAT IS RE-ASKED, AND WHAT IS AN ANSWER ─────────────────────────────────
// RETRYABLE: the transport failing outright (`TypeError: fetch failed`,
// ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, ECONNREFUSED, EPIPE, an aborted
// request), HTTP 429, HTTP 5xx.
// AN ANSWER, failed on first sight: every other 4xx — a 401/403 is a revoked
// token and does not improve in two seconds, and re-asking a 404 only spends the
// ceiling — plus unparseable JSON, `success: false`, a missing credential, and
// every programming error a reader could throw. Three identical lines in the log
// are not evidence of anything.
//
// ── THE PER-REQUEST CEILING (row O-OPS-READER-NO-CEILING, 2026-09-22) ────────
// 🔴 A RETRY BOUNDS THE NUMBER OF ATTEMPTS, NOT THE LENGTH OF ONE. Twelve
// fetch sites in ten ops-watch readers passed no signal, so a vendor that
// accepted the connection and never answered held the attempt until the JOB's
// timeout cancelled it — and a cancelled job reports nothing at all, which is
// the silent failure this module exists to remove.
//
// So the ceiling lives in `readWithBoundedRetry`, once: a FRESH ceiling per
// attempt (an aborted signal stays aborted, so one hoisted above the loop would
// fail every retry instantly). `attemptWithCeiling` gives each attempt its own
// `AbortController`, aborted by a ref'd `setTimeout` and not by
// `AbortSignal.timeout` (why ref'd: the note on that function), and combines it
// with the caller's own signal through `AbortSignal.any`, never replacing it.
// ⏱ CORRECTED 2026-09-24: this paragraph said `AbortSignal.timeout`; the code
// under it is the ref'd timer. The read receives the combined signal as
// `read(attempt, { signal })` and passes it to its fetch.
// The attempt is also RACED against that signal, so a read that forgets to pass
// it still ends: its timeout is a transient look, retried, and then COULD NOT
// LOOK (exit 2), exactly like a dropped connection. A caller's own abort is not
// ours to retry, so it ends the loop at once with the caller's reason.
//
// A reader may pass `timeoutMs` to SHORTEN the ceiling (status.mjs keeps its
// 10 s for its fan-out arithmetic); nothing may lengthen it. The env knob
// OPS_REQUEST_TIMEOUT_MS exists for the behavioural tests and may only shorten
// it too (`Math.min`), on the VERIFY_FREE_API_SCOPE_RETRY_MS precedent — a knob
// that could raise it would be a way to switch the ceiling off from outside.
//
// ⏱ APPENDED 2026-09-26 (train W30, lead ruling W30-20): ONE named exception, a
// DOWNLOAD. A read that fetches a large body passes `download: true`, and each
// of its attempts gets DOWNLOAD_TIMEOUT_MS = 60 000 instead. It is a boolean
// choosing between two numbers written HERE, never a number a caller supplies,
// so nothing outside this module can raise a ceiling past 60 s or switch it off;
// `timeoutMs` and OPS_REQUEST_TIMEOUT_MS still only shorten it. Why: a CI job
// log is a body, not an answer — 306 cached failure logs of the Guards job measured
// a median of 170 KB and a max of 1.77 MB, and one log GET missed the 15 s ceiling
// on all three attempts (W30's second live fetch, run 36025008104). The attempt
// count is unchanged. DOWNLOAD_WALL_CEILING_MS = 3 × 60 s + 10 s = 190 s is
// DERIVED like READ_WALL_CEILING_MS. The one caller is triage-failed-runs.mjs's
// job-log GET; every JSON read keeps 15 s.
//
// The sum that has to fit: every reader job in ops-watch.yml is
// `timeout-minutes: 10` (600 s), and one read costs at most READ_WALL_CEILING_MS
// (55 s). Ten sequential reads that ALL hang already reach 550 s, and the
// heartbeats job (check-d1-accepts-live-sql reads once per statement per
// database) and the glitchtip job (seven readers in one job) run more than ten.
// So the job ceiling alone cannot guarantee that a later reader in the same job
// runs after an outage. ⏱ CORRECTED 2026-09-24: this said each reader STEP
// carries its own `timeout-minutes`. Measured in ops-watch.yml, it is set per
// JOB, on nine lines (the `alert` job's 5, every other job's 10), and on no
// step. A job whose reads all hang can therefore reach its 10 minutes and be
// cancelled, and the readers after the hung one in that job do not run. A
// per-step `timeout-minutes` on each reader step is a named follow-on of row
// O-OPS-READER-NO-CEILING.
//
// 🔴 CLASSIFICATION IS MARKED AT THE THROW SITE, NEVER INFERRED FROM A MESSAGE.
// `transientLook()` sets the flag; `isTransientLook()` reads it. A future branch
// therefore has to DECIDE which of the two a new failure is, rather than having
// a substring match decide for it — and a message this module never wrote can
// never be mistaken for a promise to retry.
//
// 🔴 ONLY SAFE METHODS ARE RE-ASKED BY DEFAULT. `isSafeMethod` exists because
// verify-alarm-chains.mjs shares one `api()` between its GET reads and the PUT
// its --self-test uses to break and restore a live alert. Re-sending a write
// whose response was lost is a different decision from re-asking a read, and it
// is not this module's to make silently.
//
// Imported by: check-pages-deployments, status, check-heartbeats,
// check-analytics-liveness, check-d1-accepts-live-sql, verify-supabase-templates,
// check-prod-provenance, verify-monitors, verify-alarm-chains,
// verify-auth-providers, verify-free-api-scope, check-wildcard-dns,
// check-turnstile-hosts, check-retired-names-live, check-mail-auth-dns,
// check-apple-signing-expiry (2026-09-24, row O-APPLE-SIGNING-EXPIRY-UNWATCHED);
// check-live-signin-key (2026-09-25); the GlitchTip writes
// create-glitchtip-release, upload-web-sourcemaps and upload-native-symbols
// (2026-09-23, row O-GLITCHTIP-CALLS-HAVE-NO-RETRY — each re-sends a WRITE, and
// each records why that is safe at its own call site); and, outside tooling/ops,
// tooling/ci/assert-runner-budget.mjs (2026-09-22, for the per-request ceiling).
// ⏱ APPENDED 2026-09-25: the second look (below) is taken by status (directly,
// in parallel), verify-monitors, verify-alarm-chains (GETs only),
// create-glitchtip-release and upload-web-sourcemaps (`secondLook: true`) —
// every GitHub-runner call to a tunnel host whose stall reds main or fails a
// deploy (row O-OPS-PROBE-US-EDGE-STALL).
// Failing cases: tooling/ci/test/ops-bounded-retry.test.mjs (this module and the
// adoption, both directions) and tooling/ci/test/pages-deployments.test.mjs (the
// green control for the move).
// ─────────────────────────────────────────────────────────────────────────────

/** Raised where the answer is "nothing was judged", never "it is fine".
 *
 *  ONE class for the whole lane. Each reader used to declare its own, so
 *  `err instanceof CouldNotLook` was only ever true inside the file that threw —
 *  which is survivable while every throw and every catch sit in one file, and is
 *  exactly the thing that breaks the first time a helper moves. */
export class CouldNotLook extends Error {}

/** A `CouldNotLook` that is worth ASKING AGAIN: the transport failed, or the API
 *  answered with a shape that says "not now" rather than "no".
 *
 *  `retryAfterMs` carries a server-stated wait, already clamped by
 *  `retryAfterMs(res)`. It is a FLOOR-AND-CAP on the next gap, not a replacement
 *  for the plan: the loop waits the LONGER of the plan's gap and the server's
 *  request, so honouring a polite header can never make the reader ask FASTER
 *  than its own backoff. */
export function transientLook(message, { retryAfterMs: after } = {}) {
  const e = new CouldNotLook(message);
  e.retryable = true;
  if (Number.isFinite(after) && after > 0) e.retryAfterMs = after;
  return e;
}

/** PURE. Only a failure MARKED transient is re-asked. Anything else — a missing
 *  credential, a 403, a body that is not JSON, and every programming error a
 *  reader could throw — is final. */
export function isTransientLook(err) {
  return err instanceof CouldNotLook && err.retryable === true;
}

/** PURE. The HTTP statuses that mean "not now" rather than "no": 429 (the vendor
 *  is rate-limiting us, which is transient BY DEFINITION) and 5xx (the vendor is
 *  unwell). Every other 4xx is an ANSWER. */
export function isTransientStatus(status) {
  return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

/** The error codes and names a dropped connection arrives as. Listed rather than
 *  pattern-matched so that adding one is a reviewed diff, and so a message this
 *  module never wrote cannot accidentally read as retryable. */
const TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** PURE. Did this thrown value come from the WIRE rather than from the answer?
 *
 *  `fetch` rejects with `TypeError: fetch failed` and hangs the real reason on
 *  `.cause`, so the cause chain is walked — one level is enough for undici and a
 *  bounded walk costs nothing. `AbortError`/`TimeoutError` are here because
 *  every reader on this lane arms an `AbortSignal.timeout`, and a probe the
 *  runner gave up on is the same evidence as a probe the network dropped: none.
 *  ⏱ APPENDED 2026-09-22: the sentence above was not true when written — twelve
 *  sites in ten readers armed nothing (row O-OPS-READER-NO-CEILING). Since then
 *  `readWithBoundedRetry` arms it (a ref'd timer since #882, in
 *  `attemptWithCeiling`; its TimeoutError reads the same) for every reader, and
 *  the B8 limb in ops-bounded-retry.test.mjs fails a call site that does not
 *  pass it on.
 *
 *  🔴 IT IS DELIBERATELY NOT "anything that is a TypeError". A reader with a bug
 *  that reads a property of undefined also throws TypeError, and re-asking a
 *  programming error three times only makes the log longer. The name is checked
 *  together with the message `fetch` actually produces. */
export function isTransportFailure(err) {
  for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth += 1) {
    if (typeof e !== 'object') break;
    if (TRANSPORT_CODES.has(e.code)) return true;
    if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
    if (e.name === 'TypeError' && /fetch failed|network|socket|terminated/i.test(String(e.message ?? ''))) return true;
  }
  return false;
}

/** PURE. HTTP methods a lost response may be re-sent for without asking anyone.
 *  A GET that never answered has changed nothing; a POST that never answered may
 *  have changed everything, and the reader has to say so deliberately.
 *
 *  ⚠️ The D1 and GlitchTip READS on this lane are POSTs carrying SQL or a query
 *  body. They are reads in every sense but the verb, so those callers pass
 *  `safeMethods` explicitly — which is the point of the parameter: the decision
 *  is recorded at the call site rather than guessed here. */
export function isSafeMethod(method, safeMethods = ['GET', 'HEAD', 'OPTIONS']) {
  return safeMethods.includes(String(method ?? 'GET').toUpperCase());
}

/** How many times one read is attempted, and the first gap. #852's numbers,
 *  unchanged. Named constants rather than literals in a branch, so a test pins
 *  them and a change to either is a reviewed diff. */
export const READ_ATTEMPTS = 3;
export const RETRY_BASE_MS = 1000;

/** The longest single server-stated wait this module will honour, and the most
 *  wall clock ONE read may therefore spend waiting. Both defended in the header
 *  ("THE NUMBERS"); the wall ceiling is DERIVED from the other two. */
export const RETRY_AFTER_CEILING_MS = 5000;

/** PURE. The gaps BETWEEN attempts, doubling: 3 attempts at 1000 ms give
 *  [1000, 2000]. `attempts - 1` gaps, because nothing is waited for after the
 *  last attempt — a run that sleeps after its final failure has bought nothing
 *  and spent the time. */
export function backoffPlan(attempts = READ_ATTEMPTS, baseMs = RETRY_BASE_MS) {
  if (!Number.isInteger(attempts) || attempts < 1) return [];
  if (!Number.isFinite(baseMs) || baseMs < 0) return [];
  return Array.from({ length: attempts - 1 }, (_, i) => baseMs * 2 ** i);
}

/** The most wall-clock one read may spend waiting on the PLAN alone. SUMMED from
 *  the plan, never written down a second time. */
export const RETRY_CEILING_MS = backoffPlan().reduce((a, b) => a + b, 0);

/** The most wall-clock one read may spend waiting at ALL — every gap stretched to
 *  the longest `Retry-After` this module honours. DERIVED, for the same reason
 *  RETRY_CEILING_MS is summed. */
export const RETRY_WALL_CEILING_MS = Math.max(0, READ_ATTEMPTS - 1) * RETRY_AFTER_CEILING_MS;

/** The longest ONE attempt may take before the runner stops waiting for it.
 *  Defended in the header ("THE PER-REQUEST CEILING"). Armed by
 *  `readWithBoundedRetry` on every attempt; a reader may shorten it, never
 *  lengthen it. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** The most wall clock ONE read may spend in total: every attempt hanging to the
 *  ceiling plus every gap stretched to the longest honoured wait. DERIVED, for
 *  the same reason RETRY_WALL_CEILING_MS is. */
export const READ_WALL_CEILING_MS = Math.max(1, READ_ATTEMPTS) * REQUEST_TIMEOUT_MS + RETRY_WALL_CEILING_MS;

/** The longest ONE attempt of a `download: true` read may take. Defended in the
 *  header (⏱ 2026-09-26 under "THE PER-REQUEST CEILING"). Chosen by a boolean,
 *  never supplied by a caller. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/** READ_WALL_CEILING_MS for a download read. DERIVED. */
export const DOWNLOAD_WALL_CEILING_MS = Math.max(1, READ_ATTEMPTS) * DOWNLOAD_TIMEOUT_MS + RETRY_WALL_CEILING_MS;

/** ⏱ 2026-11-06 (club 1105 run 3, B8 limb 3). The longest ONE attempt of a `send: true`
 *  call (`sendWithBoundedRetry`) may take: a one-shot POST whose server does real work
 *  before it answers (the bridge's /propose opens a branch and a pull request through
 *  several GitHub calls). 120 s is the ceiling bridge-artifact.mjs already gives one send,
 *  so it is not a new number. Chosen by a boolean, never supplied by a caller; `timeoutMs`
 *  and OPS_REQUEST_TIMEOUT_MS still only shorten it. See "THE SEND CEILING" below. */
export const SEND_TIMEOUT_MS = 120_000;

/** PURE. The ceiling one attempt actually gets: the SHORTEST of the module's
 *  ceiling (DOWNLOAD_TIMEOUT_MS for a download, else REQUEST_TIMEOUT_MS), the
 *  caller's `timeoutMs` and the test-only `OPS_REQUEST_TIMEOUT_MS` knob. Every
 *  input can only shorten it — a value that is missing, zero, negative or not a
 *  number is ignored rather than read as "no ceiling". */
export function requestTimeoutMs(timeoutMs, env = process.env, { download = false, send = false } = {}) {
  let ms = send === true ? SEND_TIMEOUT_MS : download === true ? DOWNLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  for (const v of [timeoutMs, env?.OPS_REQUEST_TIMEOUT_MS]) {
    const n = Number(v);
    if (v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n > 0) ms = Math.min(ms, n);
  }
  return ms;
}

/** ⏱ 2026-11-02. ONE wall ceiling over a BATCH of bounded reads (upload-native-symbols's
 *  concurrent symbol sets): `{ signal, clear }`, the signal aborting with a `TimeoutError`
 *  at `ms`. It lives HERE so the one timer an importer needs over its whole batch is armed
 *  by the shared plan, never by the importer (the NO RIVAL CEILING rule in
 *  tooling/ci/test/ops-bounded-retry.test.mjs). It is NOT a per-request ceiling and cannot
 *  replace one: pass the signal as a read's `signal` option and it is COMBINED with the
 *  per-attempt ceiling through `AbortSignal.any`, so it can only end a read sooner.
 *  Call `clear()` once the batch is over. */
export function wallCeiling(ms) {
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(new DOMException(`no answer within ${ms / 1000}s`, 'TimeoutError')), ms);
  return { signal: own.signal, clear: () => clearTimeout(timer) };
}

/** PURE. A response's `Retry-After` in milliseconds, CLAMPED, or `null`.
 *
 *  RFC 9110 allows two forms and vendors send both: delta-seconds ("30") and an
 *  HTTP-date. Both are read; anything else, a negative delta and a date already
 *  in the past all answer `null` rather than 0, so an unreadable header leaves
 *  the plan's own gap in charge instead of collapsing it.
 *
 *  `now` is injected so the HTTP-date branch is testable without a clock.
 *  `headers` is anything with a `.get()`, so a test passes a `Headers` or a
 *  two-line stub and neither needs a network. */
export function retryAfterMs(res, { ceilingMs = RETRY_AFTER_CEILING_MS, now = Date.now() } = {}) {
  const raw = res?.headers?.get?.('retry-after');
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  let ms = null;
  if (/^\d+$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const at = Date.parse(text);
    if (!Number.isNaN(at)) ms = at - now;
  }
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, ceilingMs);
}

/** IMPURE ONLY IN ITS CLOCK. The default sleep, replaced in every test. */
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ONE attempt, under a FRESH ceiling, raced against it.
 *
 * ⚠️ A REF'D TIMER, NOT `AbortSignal.timeout`. Node unrefs the timer behind
 * `AbortSignal.timeout`, so a read that hangs on something holding no handle (a
 * promise nobody settles) would let the process exit with the read still
 * pending instead of timing it out. The abort reason is the same `TimeoutError`
 * `AbortSignal.timeout` produces, so `isTransportFailure` reads it identically.
 *
 * ⚠️ ON SUCCESS THE TIMER IS UNREF'D, NOT CLEARED. A reader that returns the
 * Response and reads its body AFTER the helper returns (check-d1-accepts-live-sql,
 * verify-supabase-templates) is still reading under this signal, so the body
 * read keeps the same ceiling; unref'd, it no longer holds the process open once
 * nothing else does. On failure it is cleared.
 *
 * The race is what bounds a read that never passes the signal on: its fetch
 * keeps running, but this attempt ends at the ceiling as a transient look.
 */
async function attemptWithCeiling(read, attempt, ceilingMs, callerSignal) {
  const own = new AbortController();
  const timer = setTimeout(
    () => own.abort(new DOMException(`no answer within ${ceilingMs / 1000}s`, 'TimeoutError')),
    ceilingMs,
  );
  const signal = callerSignal ? AbortSignal.any([callerSignal, own.signal]) : own.signal;
  let onAbort = () => {};
  const ended = new Promise((_, reject) => {
    onAbort = () =>
      reject(
        callerSignal?.aborted
          ? callerSignal.reason
          : transientLook(`no answer within ${ceilingMs / 1000}s (the per-request ceiling, attempt ${attempt})`),
      );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  let answered = false;
  try {
    const value = await Promise.race([Promise.resolve().then(() => read(attempt, { signal })), ended]);
    answered = true;
    return value;
  } finally {
    if (answered) timer.unref?.();
    else clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Run `read` until it succeeds or the bounded plan is exhausted.
 *
 * `read(attempt)` is called with the 1-based attempt number so a caller can say
 * which try a line came from. It must throw a `transientLook()` for anything
 * worth re-asking and anything else for an answer.
 *
 * `sleep` is injected so a test can prove BOTH directions — a transient failure
 * followed by a success, and a failure that persists — without waiting for a real
 * second; `note` is where the retry is said out loud, so a run that needed one is
 * visible in the log rather than silently clean.
 *
 * 🔴 A PERSISTENT FAILURE STILL THROWS `CouldNotLook`, so it is still the
 * caller's exit 2. The caller cannot tell it from the un-retried version except
 * by the attempt count in the message, which is the point: this distinguishes a
 * blip from an outage, it does not forgive the outage. The rethrown error is a
 * PLAIN `CouldNotLook` with `retryable` unset — a caller that re-wraps must not
 * be able to send an already-exhausted failure round a second loop.
 *
 * `read(attempt, { signal })` — the second argument carries THIS attempt's
 * signal, armed here with the per-request ceiling (header, "THE PER-REQUEST
 * CEILING"). Pass it to the fetch. `signal` in the options is the caller's own,
 * combined with ours and never replaced; `timeoutMs` may only shorten the ceiling.
 * `download: true` swaps the ceiling for DOWNLOAD_TIMEOUT_MS (header, ⏱ 2026-09-26).
 */
export async function readWithBoundedRetry(
  read,
  {
    attempts = READ_ATTEMPTS,
    baseMs = RETRY_BASE_MS,
    sleep = nap,
    note = () => {},
    signal: callerSignal,
    timeoutMs,
    download = false,
    send = false,
    secondLook: withSecondLook = false,
    slowPath = (line) => console.warn(line),
  } = {},
) {
  // A send is never looked at twice: the second look is a re-send by another name.
  if (send === true && withSecondLook) throw new CouldNotLook('a one-shot send takes no second look: it would re-send a POST that may have opened');
  const gaps = backoffPlan(attempts, baseMs);
  const ceilingMs = requestTimeoutMs(timeoutMs, process.env, { download, send });
  let last = null;
  let waited = 0;
  for (let i = 0; i < Math.max(1, attempts); i += 1) {
    if (callerSignal?.aborted) throw callerSignal.reason;
    try {
      return await attemptWithCeiling(read, i + 1, ceilingMs, callerSignal);
    } catch (e) {
      // The caller's own abort is an instruction, not a blip: never re-asked.
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (!isTransientLook(e)) throw e;
      // THE SEND CEILING: a one-shot POST is re-sent ONLY when it provably never left.
      // Anything else transient — the per-request ceiling firing, a reset mid-answer —
      // means the server may already have acted, so it is final, and SAID to be.
      if (send === true && e.unsent !== true) throw mayHaveOpened(e.message);
      last = e;
      if (i < gaps.length) {
        // The LONGER of our plan and the server's request, then clamped: an
        // honoured header may slow us down, never speed us up, and may never
        // take one read past RETRY_WALL_CEILING_MS.
        const asked = Number.isFinite(e.retryAfterMs) ? e.retryAfterMs : 0;
        const gap = Math.min(Math.max(gaps[i], asked), RETRY_AFTER_CEILING_MS);
        waited += gap;
        note(
          `attempt ${i + 1}/${attempts} failed (${e.message}); re-asking in ${gap / 1000}s` +
            (asked > gaps[i] ? ' (the server asked for the wait, and it was honoured)' : ''),
        );
        await sleep(gap);
      }
    }
  }
  const exhausted = new CouldNotLook(
    `${last.message} — and the same on all ${attempts} attempt(s) over ${waited / 1000}s. A failure that ` +
      `outlives the retry is an OUTAGE, not a blip, so this is COULD NOT LOOK and not a pass.`,
  );
  if (!withSecondLook) throw exhausted;
  // ⏱ 2026-09-25 — opted in: one more, time-spread look before the verdict
  // ("THE SECOND LOOK", below). Its own exhaustion is still COULD NOT LOOK.
  const { value, attempt } = await secondLook(read, { sleep, note, signal: callerSignal, timeoutMs, download, firstPass: exhausted });
  slowPath(
    `⚠ SLOW PATH — nothing answered on any of the ${attempts} first-pass attempt(s); second-look attempt ` +
      `${attempt}/${SECOND_LOOK_ATTEMPTS} answered. Graded on that answer, exactly like a first-pass one.`,
  );
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// ⏱ 2026-09-25 — THE SECOND LOOK (row O-OPS-PROBE-US-EDGE-STALL).
//
// 🔴 THE FIRST PASS IS TOO SHORT TO OUTLAST ONE STALL AT THE CLOUDFLARE EDGE. The
// Box B hostnames are served by a Cloudflare Tunnel whose connectors sit in
// Mumbai (colos bom06/bom09/bom10). A GitHub runner reaches them through a US
// edge, and some US-edge requests STALL: the edge never gets an answer from the
// tunnel, the client gives up, and Cloudflare logs edgeResponseStatus 499 with
// originResponseStatus 0. cloudflared logs nothing, because the request never
// reached it. 03:01-08:44Z on 2026-09-25 that was 35 stalls in about 1,300
// requests, all at US colos (PDX 23, MSP 10, SJC 1, SEA 1), against 0 in 1,056 at
// Indian colos; 22-24 Sep, about 100, all at US colos. status.mjs spent its three
// attempts in about 33 s (10 s each, 1 s and 2 s apart), all three landed in one
// stall, and ops-watch went red with NOTHING ANSWERED three times while the box
// was up (runs 35996417635, 36110724525, 36113462303).
//
// So a caller may opt in (`secondLook: true`, or `secondLook()` directly) to ONE
// more, time-spread look after its first pass is exhausted: SECOND_LOOK_ATTEMPTS
// attempts, SECOND_LOOK_GAP_MS apart, each under the same per-request ceiling.
//   · An ANSWER on the second look is graded exactly like a first-pass answer.
//   · Nothing on the second look is still COULD NOT LOOK. Never a silent green.
//   · It is never silent when it helped: the caller's `slowPath` line prints
//     (default `console.warn`), because a run that needed it is evidence that
//     the path is degrading, even when the verdict is green.
//
// ⚠️ EACH SECOND-LOOK ATTEMPT OPENS A NEW CONNECTION — measured 2026-09-25 on Node
// v24.18.0 against a 127.0.0.1 server that holds the first requests unanswered.
// An attempt this module aborts has its socket DESTROYED: attempts 1 and 3 each
// arrived on a fresh connection. That matters because Cloudflare picks the edge
// per connection: in run 36113462303 one glitchtip attempt hit MSP (499) and the
// next hit ORD (200). THE ONE EXCEPTION, also measured: an idle keep-alive socket
// left by an EARLIER ANSWERED request to the same origin IS reused (attempt 2
// went out on the warm-up's socket). status.mjs's second look only re-asks a
// surface that never answered in this process, so it holds no such socket.
//
// THE NUMBERS. SECOND_LOOK_ATTEMPTS = 4 and SECOND_LOOK_GAP_MS = 15 000 are
// judgement: four looks spread over about a minute and a half, on top of the
// first pass's half a minute, outlast every stall in the evidence without
// Argo Smart Routing (a spend, owner-gated) or opening Box B ports (a security
// change). The wall clock one second look may take is DERIVED
// (`secondLookWallMs`): attempts × the ceiling + (attempts − 1) × the gap —
// 4 × 15 s + 3 × 15 s = 105 s at REQUEST_TIMEOUT_MS, 4 × 10 s + 3 × 15 s = 85 s
// at status.mjs's PROBE_TIMEOUT_MS. The gap is FIXED, not doubled and not
// clamped by RETRY_AFTER_CEILING_MS: spreading the looks in time is the whole
// point, and a 5 s clamp would silently fold them back into one stall.
// OPS_SECOND_LOOK_GAP_MS is the test-only knob, and like OPS_REQUEST_TIMEOUT_MS
// it may only SHORTEN the gap.

/** How many second-look attempts, and how far apart. Judgement, defended in the
 *  block above; a test pins both. */
export const SECOND_LOOK_ATTEMPTS = 4;
export const SECOND_LOOK_GAP_MS = 15_000;

/** PURE. The gap the second look actually waits: SECOND_LOOK_GAP_MS, or the
 *  test-only OPS_SECOND_LOOK_GAP_MS when that is SHORTER. A value that is
 *  missing, negative or not a number is ignored; zero is accepted (no wait). */
export function secondLookGapMs(env = process.env) {
  const v = env?.OPS_SECOND_LOOK_GAP_MS;
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n) || n < 0) return SECOND_LOOK_GAP_MS;
  return Math.min(SECOND_LOOK_GAP_MS, n);
}

/** PURE. The most wall clock ONE second look may take: every attempt hanging to
 *  its ceiling, plus every gap. DERIVED from the constants, never typed. */
export function secondLookWallMs(timeoutMs = REQUEST_TIMEOUT_MS) {
  return SECOND_LOOK_ATTEMPTS * requestTimeoutMs(timeoutMs, {}) + (SECOND_LOOK_ATTEMPTS - 1) * SECOND_LOOK_GAP_MS;
}

/**
 * The second look itself, for a caller that runs it on its own schedule
 * (status.mjs re-asks every unreached surface IN PARALLEL after its sweep).
 *
 * `read(attempt, { signal })` is the SAME read the first pass used. Resolves to
 * `{ value, attempt }`, the 1-based second-look attempt that answered. An answer
 * (anything `read` throws that is not a `transientLook`) is re-thrown at once,
 * un-retried, exactly as in the first pass. Exhaustion throws a plain
 * `CouldNotLook` naming both passes.
 */
export async function secondLook(read, { sleep = nap, note = () => {}, signal: callerSignal, timeoutMs, download = false, firstPass } = {}) {
  const ceilingMs = requestTimeoutMs(timeoutMs, process.env, { download });
  const gap = secondLookGapMs();
  let last = null;
  for (let i = 0; i < SECOND_LOOK_ATTEMPTS; i += 1) {
    if (callerSignal?.aborted) throw callerSignal.reason;
    if (i > 0) {
      note(`second look ${i}/${SECOND_LOOK_ATTEMPTS} got nothing (${last.message}); asking again in ${gap / 1000}s`);
      await sleep(gap);
    }
    try {
      return { value: await attemptWithCeiling(read, i + 1, ceilingMs, callerSignal), attempt: i + 1 };
    } catch (e) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (!isTransientLook(e)) throw e;
      last = e;
    }
  }
  throw new CouldNotLook(
    `${firstPass ? `${firstPass.message} ` : ''}SECOND LOOK: ${last.message} — and the same on all ` +
      `${SECOND_LOOK_ATTEMPTS} second-look attempt(s), ${gap / 1000}s apart. Nothing answered either pass, ` +
      'so this is COULD NOT LOOK and not a pass.',
  );
}

/**
 * The classification half, for a reader that already has its own `fetch`
 * wrapper and only needs to know which of the two a failure is.
 *
 * Returns the error to throw: a `transientLook` when the wire dropped, a plain
 * `CouldNotLook` when a bug or an answer produced it. Callers that classify a
 * RESPONSE (rather than a thrown value) use `isTransientStatus` + `retryAfterMs`
 * instead — those two together are the response-shaped half of the same rule.
 */
export function classifyThrown(err, message) {
  return isTransportFailure(err) ? transientLook(message) : new CouldNotLook(message);
}

/**
 * ⏱ 2026-09-24 — A WHOLE-RUN CEILING, for a reader that makes MANY reads and has
 * to end inside its step's budget (check-mail-auth-dns: every declared record,
 * asked of two resolvers, under a `timeout-minutes: 3` step). Pass `.signal` as
 * the caller `signal` of every read: `readWithBoundedRetry` already combines it
 * with the per-request ceiling, and a caller abort ends the loop at once,
 * un-retried, with this reason.
 *
 * It lives HERE and not in the reader for the reason the per-request ceiling
 * does: B8 in ops-bounded-retry.test.mjs refuses a timer armed by an importer of
 * this module, because two timers written in two places disagree silently. This
 * module is the one place a timer on this lane is armed.
 *
 * The reason is a PLAIN `CouldNotLook`: a run that outlived its ceiling judged
 * nothing more, which is COULD NOT LOOK and never a pass. The timer is unref'd so
 * a run that finished early does not wait for it; `cancel()` clears it.
 */
export function runDeadline(ms) {
  const ctl = new AbortController();
  const timer = setTimeout(
    () => ctl.abort(new CouldNotLook(`the whole-run ceiling of ${ms / 1000}s passed before every read answered`)),
    ms,
  );
  timer.unref?.();
  return { signal: ctl.signal, cancel: () => clearTimeout(timer) };
}

// ─────────────────────────────────────────────────────────────────────────────
// ⏱ 2026-11-06 — THE SEND CEILING, for ONE-SHOT POSTs (club 1105 run 3, B8 limb 3;
// lead ruling e5f41654af95 (2)).
//
// 🔴 A READ THAT NEVER ANSWERED CHANGED NOTHING; A POST THAT NEVER ANSWERED MAY HAVE
// CHANGED EVERYTHING. bridge-propose.mjs held a private loop that re-sent its /propose
// POST on every transport throw and every 5xx — the same "is this transient?" this
// module exists to own, answered a second way, and answered WRONG for a POST: the
// bridge may have opened the pull request before the answer was lost.
//
// So `sendWithBoundedRetry` is the plan with three differences, and nothing else:
//   · RE-SENT ONLY WHEN IT NEVER LEFT. A connect-phase failure (`neverSent`: the
//     name did not resolve, the host refused or was unreachable, the connect timed
//     out) proves the server never saw the request; that, and only that, is re-sent,
//     under the same plan (READ_ATTEMPTS, RETRY_BASE_MS).
//   · ANYTHING THAT MAY HAVE OPENED IS FINAL. A reset or a timeout after the connect,
//     and the per-request ceiling itself, end the loop at once as a plain
//     `CouldNotLook` that says the send was not repeated (`mayHaveOpened`).
//   · EVERY RESPONSE IS AN ANSWER. A 429 is a REFUSAL and a 5xx is the server's own
//     account of what it did; the Response comes straight back on first sight and
//     the caller grades it. Neither is re-sent here.
// The ceiling of one send is SEND_TIMEOUT_MS (120 s), armed here as every ceiling on
// this lane is; a send takes no second look (it would be a re-send by another name).

/** The codes a request arrives as when it NEVER LEFT the runner: no name, no route, no
 *  listener, no connect. Listed for the reason TRANSPORT_CODES is. ETIMEDOUT is NOT
 *  here: a socket that timed out may have carried the whole request first. */
const NEVER_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/** PURE. Did this thrown value come from a request that provably never reached the
 *  server? The cause chain is walked exactly as `isTransportFailure` walks it. */
export function neverSent(err) {
  for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth += 1) {
    if (typeof e !== 'object') break;
    if (NEVER_SENT_CODES.has(e.code)) return true;
  }
  return false;
}

/** A transient look for a send that NEVER LEFT: the one kind a send loop re-sends. */
export function unsentLook(message) {
  const e = transientLook(message);
  e.unsent = true;
  return e;
}

/** The FINAL error of a send that may have opened. A plain `CouldNotLook`, so the
 *  caller's COVERAGE LOST, and never re-asked by any loop. */
export function mayHaveOpened(message) {
  return new CouldNotLook(`${message} — the send may have reached the server, so it was NOT sent again (a one-shot POST is re-sent only when it never left)`);
}

/**
 * ONE one-shot POST under the shared plan and THE SEND CEILING (above).
 *
 * `doSend({ signal })` performs ONE request and resolves to a Response; it passes
 * `signal` to its fetch, and builds anything that must be fresh per send (a signed
 * body, a token) inside, because a send that never left is sent again from scratch.
 * Returns the Response for EVERY status — a 429 and a 5xx included — and the caller
 * grades it. A transport failure that may have opened throws `mayHaveOpened`; a
 * programming error in `doSend` escapes undisguised.
 */
export async function sendWithBoundedRetry(doSend, { describe = (s) => s, ...opts } = {}) {
  return readWithBoundedRetry(
    async (_attempt, { signal }) => {
      try {
        return await doSend({ signal });
      } catch (err) {
        const why = `${err?.name ?? 'error'}: ${err?.message ?? err}`;
        if (neverSent(err)) throw unsentLook(describe(`the send never left (${why})`));
        if (isTransportFailure(err)) throw mayHaveOpened(describe(`the send did not answer (${why})`));
        throw err;
      }
    },
    { ...opts, send: true, secondLook: false },
  );
}

/**
 * The whole rule in one call, for the eleven readers whose fetch wrapper is the
 * same five lines.
 *
 * `doFetch({ signal })` performs ONE request and resolves to a Response; it
 * passes `signal` to its fetch so the per-request ceiling reaches the wire.
 * Everything below
 * is the shared judgement: a dropped wire is transient, 429/5xx is transient and
 * honours `Retry-After`, any other non-OK status is an ANSWER, and the caller
 * still owns what a returned Response means.
 *
 * `describe(what)` builds the message, so each reader keeps its own wording —
 * the lines this lane's operators read have not moved.
 */
export async function fetchWithBoundedRetry(doFetch, { describe = (s) => s, ...opts } = {}) {
  return readWithBoundedRetry(async (_attempt, { signal }) => {
    let res;
    try {
      res = await doFetch({ signal });
    } catch (err) {
      throw classifyThrown(err, describe(`the request did not answer (${err?.name ?? 'error'}: ${err?.message ?? err})`));
    }
    if (isTransientStatus(res.status)) {
      throw transientLook(describe(`the request answered HTTP ${res.status}`), { retryAfterMs: retryAfterMs(res) });
    }
    return res;
  }, opts);
}
