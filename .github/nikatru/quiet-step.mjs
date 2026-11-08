#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// quiet-step.mjs — run one CI step with its output kept OFF the public log.
//
// GitHub migration P4 (Private/research/session-2026-10-04/github-migration/
// PLAN.md, design item 4). The public shell's logs are readable by anyone, and a
// guard's output quotes the private tree. So every script step the generator
// (tooling/ci/gen-public-shell.mjs) wraps runs through this file, which:
//   · runs the command with stdout and stderr captured to a file, never echoed;
//   · prints ONE public line: `ok <name> <ms>` or `RED <name> exit N`;
//   · on red, appends the last TAIL_LINES lines of the capture (secrets masked)
//     to $RUNNER_TEMP/report-detail.md, which the job hands to the generated
//     report jobs, whose tooling/ci/shell-report.py sends it to the private pull
//     request through the bridge's POST /report;
//   · points GITHUB_STEP_SUMMARY at a private file (a step summary is public on the
//     run page) and appends it to the detail on red;
//   · passes `::add-mask::` lines through, so a value the script masks is masked
//     by the runner too, and masks it (and every secret-named variable's value) in
//     the detail;
//   · ⏱ 2026-10-05 · gh-migrate-repoint: prints the text of a `::nikatru-public::<text>`
//     line, masked — the ONE way a script publishes a line on purpose (CodeQL's
//     counts, tooling/ci/codeql-sarif-report.mjs). Nothing else is ever echoed.
//     ⏱ 2026-10-05 · gh-repoint-f1 (review of #1249, nit b): ONLY under `--public`,
//     which the generator passes to the steps tooling/ci/public-shell.json
//     `publicLines` declares and to no other — in any other step a private script
//     that prints the prefix publishes nothing;
//   · ⏱ 2026-10-08 · gitleaks-pr-scoped-r2: hands the text of a `::nikatru-detail::<text>` line
//     to the PRIVATE detail, masked, on a GREEN step too (a `### NOTE <name>` section) — the ONE
//     way a script says something to the private pull request when nothing is red (an applied
//     PR-scoped secret-scan exemption, tooling/ci/scan-secrets.mjs). It is never echoed; on a red
//     step the line is in the tail like any other;
//   · ⏱ 2026-10-12 · red-detail-failures-first: on red, when the output holds test results (flutter/dart
//     test, node --test, vitest, Playwright) or the step's runners wrote JSON results to the directory it
//     names in NIKATRU_TEST_RESULTS (`flutter test --file-reporter json:<dir>/<x>.json`), the section opens
//     with the FAILING tests and the counts, and the tail follows under `#### output tail` — the part
//     tooling/ci/shell-report.py cuts first. PR #429's run 38262466034 handed over a tail of passing lines
//     and named none of its ten failures. A red step with no failing test in its output keeps the old layout;
//   · exits with the command's code, so `continue-on-error`, `if: failure()` and
//     the job verdict are what they were;
//   · ⏱ 2026-10-08 (A2 review G-22): ends when the command EXITS, not when its
//     output pipes reach EOF — a grandchild left holding them hung the step to
//     its timeout-minutes with an empty log. The pipes get DRAIN_MS after the
//     exit, then are cut, and the capture says so.
//
//   · ⏱ 2026-11-07 · O-SCHEDULED-RUN-RED-DETAIL-NEVER-DELIVERED (club-1107-1): THE FORCED-RED DRILL. The door that
//     files a manual or scheduled run's red detail (services/gh-bridge/src/dispatch-detail.ts) had no control: nothing
//     could make a green run red on purpose to prove the detail arrives. A dispatchable reporting root (the generator's
//     `dispatchable`, the bridge's DISPATCH_DETAIL_WORKFLOWS) now takes a `red_drill` dispatch input, bound to
//     RED_DRILL_ENV at the workflow's top level. When it names THIS step (`--name`, exactly) on a `workflow_dispatch`
//     run, and the command exited 0, the step goes red (exit 1): its public line says `(drill)` and its detail
//     section opens with RED_DRILL_BANNER above the real tail. It can only turn a green step red, never a red one
//     green; any other event, or any other name, leaves the step as it was. It reaches the root's own jobs only (a
//     workflow's env does not pass into a called workflow). Cases: tooling/ci/test/quiet-step-red-drill.test.mjs.
//
//   node tooling/ci/quiet-step.mjs --name <name> [--public] -- <cmd> [args...]
//   node tooling/ci/quiet-step.mjs --name <name> [--public] --default-shell <script-file>
//
// The second form is a custom `shell:` for a step whose runner OS is only known at
// run time (a `runs-on: ${{ matrix.os }}` job with no `shell:`): it runs the script
// the way the runner's default would — `bash -e` on Linux and macOS; on Windows
// pwsh with `$ErrorActionPreference = 'stop'` and the script's last exit code, the
// two lines the runner adds around a pwsh step.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDir } from './tree-walk.mjs';

export const TAIL_LINES = 400;
export const DETAIL_FILE = 'report-detail.md';
/** How long the output pipes may stay open after the command exits (a leftover background process). */
export const DRAIN_MS = 5000;
/** The one `--name` quiet-step accepts. */
export const STEP_NAME = /^[A-Za-z0-9][A-Za-z0-9._()-]{0,99}$/;
/** A line a script publishes on purpose: its text is printed, masked. */
export const PUBLIC_PREFIX = '::nikatru-public::';
/** A line a script hands to the private detail on purpose, green or red: its text, masked. */
export const DETAIL_PREFIX = '::nikatru-detail::';
/** ⏱ 2026-11-07 · the forced-red drill (header): the step name a `workflow_dispatch` run's `red_drill` input names. */
export const RED_DRILL_ENV = 'NIKATRU_RED_DRILL';
export const RED_DRILL_BANNER = 'RED DRILL: forced red by the dispatch input red_drill. The command itself exited 0; the tail below is its real output.';
/** PURE. Whether this step is the one a drill forces red: a `workflow_dispatch` run whose RED_DRILL_ENV is exactly `name`. */
export const isRedDrill = (env, name) => env.GITHUB_EVENT_NAME === 'workflow_dispatch' && typeof env[RED_DRILL_ENV] === 'string' && env[RED_DRILL_ENV].trim() !== '' && env[RED_DRILL_ENV].trim() === name;
/** An environment variable whose value is a credential by its name. */
export const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|_KEY$|^KEY$|DSN|SALT|AUTH|COOKIE|SIGNING|P12|KEYSTORE)/i;
const MIN_MASK = 6;

/** The values to mask: every secret-named variable's value, and every `::add-mask::` value seen. */
export function maskValues(env, added = []) {
  const vals = new Set(added.filter((v) => v.length >= MIN_MASK));
  for (const [k, v] of Object.entries(env)) if (SECRET_NAME.test(k) && typeof v === 'string' && v.length >= MIN_MASK) vals.add(v);
  return [...vals].sort((a, b) => b.length - a.length);
}

export function mask(text, values) {
  let out = text;
  for (const v of values) out = out.split(v).join('***');
  return out;
}

/** The last `n` lines of `text`. */
export function tail(text, n = TAIL_LINES) {
  const lines = text.replace(/\n$/, '').split('\n');
  return { text: lines.slice(-n).join('\n'), cut: Math.max(0, lines.length - n) };
}

// ⏱ 2026-10-12 · red-detail-failures-first. A red test step's detail named NO failing test: PR #429's run
// 38262466034 failed the apps leg of the workspace gate (3183 passed, 10 failed), and the detail the bridge
// posted was the TAIL of the output, cut again to the hand-off's 16 KiB by tooling/ci/shell-report.py — about
// a hundred passing lines and the counts. The ten names were in neither the sealed public log nor the detail,
// so the lane that owned the PR stopped blind and the lead re-ran the suite on Box A to learn them. So a red
// section now leads with the failing tests (name, file, the first lines of each failure), then the counts,
// then the tail under OUTPUT_TAIL_MARK, and shell-report.py cuts a section's TAIL first, never its failures.
/** The line that opens a red section's tail: everything above it is the part a size cut keeps. */
export const OUTPUT_TAIL_MARK = '#### output tail';
/** The directory a step's test runners write machine-readable results to (`flutter test --file-reporter json:<dir>/<x>.json`). */
export const RESULTS_ENV = 'NIKATRU_TEST_RESULTS';
/** At most this many failures are named, each with at most FAIL_LINES lines of LINE_CHARS characters... */
export const MAX_FAILURES = 30;
export const FAIL_LINES = 6;
const LINE_CHARS = 240;
/** A result file larger than this is not read (a JSON reporter writes a few hundred bytes per test). */
const RESULT_MAX_BYTES = 64 * 1024 * 1024;
/** ...and the whole failures block stays within this, so the tail keeps room under the hand-off's 16 KiB. */
export const FAILURES_MAX_BYTES = 8 * 1024;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

const clip = (s) => (s.length > LINE_CHARS ? `${s.slice(0, LINE_CHARS - 1)}…` : s);

// ⏱ 2026-10-12 · review of #447 (a ReDoS pass over the new readers): a step's output is untrusted text, and
// `(.+?)\s*─*$`, `.*\d+ (?:failed|passed).*` and `(\d+) failed` each took over a second on one 40 000-character
// line. The readers match with linear patterns and trim the Playwright rule by hand.
/** `s` without its trailing spaces and `─` rule, by a scan from the end (a regex for it backtracks on a long run). */
function trimRule(s) {
  let end = s.length;
  while (end > 0 && (s[end - 1] === '─' || /\s/.test(s[end - 1]))) end -= 1;
  return s.slice(0, end);
}

/** Up to FAIL_LINES non-blank lines of `lines` from `i`, until `stop(line)` says the failure's text is over. */
function firstLines(lines, i, stop) {
  const out = [];
  for (let j = i; j < lines.length && out.length < FAIL_LINES; j += 1) {
    if (stop(lines[j])) break;
    if (lines[j].trim()) out.push(clip(lines[j].trim()));
  }
  return out;
}

/** The failures and counts in a `flutter test` / `dart test` JSON reporter stream (`--file-reporter json:<path>`). */
export function parseDartJson(text) {
  const suites = new Map();
  const tests = new Map();
  const errors = new Map();
  const failures = [];
  let passed = 0;
  let skipped = 0;
  let any = false;
  for (const raw of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'suite' && e.suite) suites.set(e.suite.id, e.suite.path);
    else if (e.type === 'testStart' && e.test) tests.set(e.test.id, e.test);
    else if (e.type === 'error' && !errors.has(e.testID)) errors.set(e.testID, `${e.error ?? ''}`);
    else if (e.type === 'testDone') {
      any = true;
      if (e.hidden) continue;
      if (e.skipped) skipped += 1;
      else if (e.result === 'success') passed += 1;
      else {
        const t = tests.get(e.testID) ?? {};
        const file = suites.get(t.suiteID) ?? t.root_url?.replace(/^file:\/\//, '') ?? '';
        const lines = (errors.get(e.testID) ?? '').split('\n');
        failures.push({ name: `${t.name ?? `test ${e.testID}`}`, file: `${file}${t.root_line ?? t.line ? `:${t.root_line ?? t.line}` : ''}`, lines: firstLines(lines, 0, () => false) });
      }
    }
  }
  if (!any) return null;
  return { failures, failed: failures.length, counts: `${passed} passed, ${skipped} skipped, ${failures.length} failed` };
}

const DART_PROGRESS = /^([\w.-]+: )?\d+:\d+ \+(\d+)(?: ~(\d+))?(?: -(\d+))?: (.*)$/;
/** `flutter test` / `dart test`, expanded or compact reporter: a test's `[E]` line, then its error. */
function parseDartText(lines) {
  const failures = [];
  let counts = null;
  let failed = 0;
  lines.forEach((l, i) => {
    const m = DART_PROGRESS.exec(l);
    if (!m) return;
    counts = `${m[2]} passed, ${m[3] ?? 0} skipped, ${m[4] ?? 0} failed`;
    failed = Number(m[4] ?? 0);
    const name = / \[E\]$/.test(m[5]) ? m[5].slice(0, -4) : null;
    if (!name) return;
    const file = /^(\S+\.dart): /.exec(name)?.[1] ?? '';
    // melos exec puts its package prefix on every line; the error's lines lose it, the test's name keeps the file.
    const own = (x) => (m[1] && x.startsWith(m[1]) ? x.slice(m[1].length) : x);
    failures.push({ name, file, lines: firstLines(lines.slice(i + 1).map(own), 0, (x) => DART_PROGRESS.test(x)) });
  });
  return counts ? { failures, failed, dart: true, counts: `dart/flutter test: ${counts}` } : null;
}

// ⏱ 2026-11-04 · club-integration-1104: a red `dart test` step (1,078 passed, 1 failed) reached the report as
// `(earlier detail cut to fit the report)` and no failing test's name. On a runner GITHUB_ACTIONS=true, so
// package:test's default reporter is `github`, not the expanded one parseDartText reads: a failure is a
// `::group::❌ <name> (failed)` line, its error, `::endgroup::`, and the run ends `::error::N tests passed, M failed.`
// Without a result file (the `dart test` legs write none) the step named nothing, so its tail was all a cut kept.
const DART_GITHUB_FAIL = /^(?:([\w.-]+): )?(?:::group::)?❌ (.*) \(failed\)$/;
const DART_GITHUB_DONE = /^(?:[\w.-]+: )?(?:::error::|🎉 |✅ )(\d+) tests? passed\b/;
/** `flutter test` / `dart test`, github reporter (package:test's default on GitHub Actions): `❌ … (failed)` groups. */
function parseDartGithub(lines) {
  const failures = [];
  let counts = null;
  let failed = 0;
  lines.forEach((l, i) => {
    const done = l.length < 400 ? DART_GITHUB_DONE.exec(l) : null;
    if (done) {
      const f = Number(/, (\d+) failed\b/.exec(l)?.[1] ?? 0);
      const s = Number(/, (\d+) skipped\b/.exec(l)?.[1] ?? 0);
      counts = `${done[1]} passed, ${s} skipped, ${f} failed`;
      failed = f;
      return;
    }
    const m = DART_GITHUB_FAIL.exec(l);
    if (!m) return;
    const name = m[2];
    const file = /^(\S+\.dart): /.exec(name)?.[1] ?? /^loading (\S+\.dart)$/.exec(name)?.[1] ?? '';
    const own = (x) => (m[1] && x.startsWith(`${m[1]}: `) ? x.slice(m[1].length + 2) : x);
    failures.push({ name, file, lines: firstLines(lines.slice(i + 1).map(own), 0, (x) => /^::endgroup::$|^::group::/.test(x) || DART_GITHUB_FAIL.test(x)) });
  });
  if (!counts && failures.length === 0) return null;
  return { failures, failed: Math.max(failed, failures.length), dart: true, counts: counts ? `dart/flutter test: ${counts}` : null };
}

/** node --test, TAP reporter: `not ok N - name` and its YAML block (a parent whose subtests failed is not named). */
function parseNodeTap(lines) {
  const failures = [];
  const count = {};
  lines.forEach((l, i) => {
    const c = /^# (tests|pass|fail|skipped|todo) (\d+)$/.exec(l);
    if (c) count[c[1]] = c[2];
    const m = /^(\s*)not ok \d+ - (.*?)(?: # .*)?$/.exec(l);
    if (!m) return;
    const block = [];
    for (let j = i + 1; j < lines.length && !/^\s*\.\.\.$/.test(lines[j]) && !/^\s*(?:not )?ok \d+ /.test(lines[j]); j += 1) block.push(lines[j]);
    if (block.some((b) => /failureType: 'subtestsFailed'/.test(b))) return;
    const file = /location: '(.*)'/.exec(block.join('\n'))?.[1] ?? '';
    const at = block.findIndex((b) => /^\s*error: /.test(b));
    const err = at < 0 ? [] : [block[at].replace(/^\s*error: (?:\|-|')?/, '').replace(/'$/, ''), ...block.slice(at + 1)];
    failures.push({ name: m[2], file, lines: firstLines(err, 0, (x) => /^\s*(?:code|name|expected|actual|operator|stack|failureType|location):/.test(x)) });
  });
  if (count.fail === undefined && failures.length === 0) return null;
  return { failures, failed: Number(count.fail ?? failures.length), counts: `node --test: ${count.pass ?? '?'} passed, ${count.fail ?? failures.length} failed${count.tests ? ` of ${count.tests}` : ''}` };
}

/** node --test, spec reporter: its closing `✖ failing tests:` block, `test at <file>` then `✖ <name>` then the error. */
function parseNodeSpec(lines) {
  const count = {};
  for (const l of lines) {
    const c = /^ℹ (tests|pass|fail) (\d+)$/.exec(l);
    if (c) count[c[1]] = c[2];
  }
  const start = lines.findIndex((l) => /^✖ failing tests:$/.test(l));
  const failures = [];
  if (start >= 0) {
    let file = '';
    for (let i = start + 1; i < lines.length; i += 1) {
      const at = /^test at (.+)$/.exec(lines[i]);
      if (at) file = at[1];
      const m = /^\s*✖ (.*?)(?: \([\d.]+m?s\))?$/.exec(lines[i]);
      if (!m) continue;
      const err = firstLines(lines, i + 1, (x) => /^test at |^\s*✖ |^ℹ /.test(x));
      if (!/^\d+ subtests? failed$/.test(err[0] ?? '')) failures.push({ name: m[1], file, lines: err });
      file = '';
    }
  }
  if (count.fail === undefined && failures.length === 0) return null;
  return { failures, failed: Number(count.fail ?? failures.length), counts: `node --test: ${count.pass ?? '?'} passed, ${count.fail ?? failures.length} failed${count.tests ? ` of ${count.tests}` : ''}` };
}

/** vitest: the `Failed Tests` block's ` FAIL  <file> > <name>` headers, and its `Tests  …` summary. */
function parseVitest(lines) {
  const failures = [];
  const seen = new Set();
  let counts = null;
  lines.forEach((l, i) => {
    const t = /^\s*Tests\s{2,}(\S.*)$/.exec(l);
    if (t && /\b\d+ (?:failed|passed)\b/.test(t[1])) counts = `vitest: ${t[1].trim()}`;
    const m = /^\s*FAIL\s+(\S+) > (.+)$/.exec(l);
    if (!m || seen.has(l.trim())) return;
    seen.add(l.trim());
    failures.push({ name: m[2].trim(), file: m[1], lines: firstLines(lines, i + 1, (x) => /^\s*FAIL\s/.test(x) || x.includes('⎯')) });
  });
  return counts || failures.length ? { failures, failed: Number(/\b(\d+) failed/.exec(counts ?? '')?.[1] ?? failures.length), counts } : null;
}

/** Playwright (list or line reporter): the closing `  N) [project] › file:line:col › name` blocks and their counts. */
function parsePlaywright(lines) {
  // ⏱ 2026-10-12 · review of #447, finding 3: `  3 passed` is ordinary output too, so nothing is read before the
  // runner's own `Running N tests using M workers` header.
  const start = lines.findIndex((l) => /^Running \d+ tests? using \d+ workers?/.test(l));
  if (start < 0) return null;
  const failures = [];
  const count = [];
  let failed = 0;
  const run = lines.slice(start);
  run.forEach((l, i) => {
    const c = /^\s+(\d+) (failed|flaky|passed|skipped|did not run)(?: \(.*\))?$/.exec(l);
    if (c) count.push(`${c[1]} ${c[2]}`);
    if (c?.[2] === 'failed') failed = Number(c[1]);
    const m = /^\s+\d+\) (?:\[[^\]]+\] › )?(\S+?:\d+:\d+) › (.+)$/.exec(l);
    if (!m) return;
    failures.push({ name: trimRule(m[2]), file: m[1], lines: firstLines(run, i + 1, (x) => /^\s+\d+\) |^\s+\d+ (?:failed|flaky|passed)/.test(x)) });
  });
  return count.length || failures.length ? { failures, failed: Math.max(failed, failures.length), counts: count.length ? `playwright: ${count.join(', ')}` : null } : null;
}

/**
 * The failing tests and counts in a red step's output and its machine-readable result files: a JSON result
 * wins over its text, and a test named by two readers is named once. Null when the output holds no test results.
 */
export function testFailures(captured, resultFiles = []) {
  const lines = captured.replace(ANSI, '').split('\n').map((l) => l.replace(/\r$/, ''));
  const found = [];
  for (const r of resultFiles) {
    const got = parseDartJson(r.text);
    if (got) found.push({ ...got, counts: `flutter test (${r.name}): ${got.counts}` });
  }
  // The text is read too: a step can run more than one runner, and a result file is written only by the legs that ask.
  const fromText = [parseDartText, parseDartGithub, parseNodeTap, parseNodeSpec, parseVitest, parsePlaywright].map((p) => p(lines)).filter(Boolean);
  if (found.length === 0) found.push(...fromText);
  else {
    // ⏱ 2026-10-12 · review of #447, finding 4: a package that died before its reporter wrote JSON (a compile
    // error, a crash) still names its `[E]` tests in the text, so only a text failure the JSON already names
    // is dropped — by file and name — and the text's counts give way to the files'.
    const inJson = new Set(found.flatMap((r) => r.failures).map((f) => `${f.file.replace(/:\d+$/, '')}\0${f.name}`));
    // A one-suite run prints no path before a test's name (either text reporter), so a text failure with no file
    // is the JSON's when the JSON names it at all.
    const namesInJson = new Set(found.flatMap((r) => r.failures).map((f) => f.name));
    const known = (f) => inJson.has(`${f.file}\0${f.name.replace(/^\S+\.dart: /, '')}`) || (!f.file && namesInJson.has(f.name));
    for (const r of fromText) {
      if (!r.dart) found.push(r);
      else found.push({ ...r, counts: null, failures: r.failures.filter((f) => !known(f)) });
    }
  }
  // ⏱ 2026-10-12 · review of #447, finding 3: a guard's `12:30 +5: deploying` or `  3 passed` is not a test run that
  // failed. The block is written only when a failing test was read or a runner counted one.
  if (!found.some((r) => r.failures.length > 0 || r.failed > 0)) return null;
  const failures = [];
  const seen = new Set();
  for (const f of found.flatMap((r) => r.failures)) {
    const key = `${f.file}\0${f.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push(f);
  }
  return { failures, counts: found.map((r) => r.counts).filter(Boolean) };
}

/** The failures block of a red section: within MAX_FAILURES and FAILURES_MAX_BYTES, the rest counted, never silently dropped. */
export function failuresBlock(found) {
  const out = [`#### failing tests (${found.failures.length})`, ''];
  let bytes = 0;
  let shown = 0;
  for (const f of found.failures) {
    const entry = [`✖ ${clip(f.name)}${f.file ? ` — ${clip(f.file)}` : ''}`, ...f.lines.map((l) => `    ${l}`)];
    const size = Buffer.byteLength(`${entry.join('\n')}\n`);
    if (shown >= MAX_FAILURES || bytes + size > FAILURES_MAX_BYTES) break;
    out.push(...entry);
    bytes += size;
    shown += 1;
  }
  if (shown < found.failures.length) out.push(`(${found.failures.length - shown} more failing test(s) not shown; see the counts)`);
  if (found.failures.length === 0) out.push('(the runner reported failures, but no failing test could be read from its output)');
  out.push('', '#### counts', '', ...(found.counts.length ? found.counts : ['(no counts in the output)']), '');
  return out;
}

/** The detail section for one GREEN step's `DETAIL_PREFIX` lines. */
export function noteSection(name, notes, values) {
  return `${[`### NOTE ${name}`, '', ...notes.map((n) => mask(n, values)), ''].join('\n')}\n`;
}

/**
 * The detail section for one red step. When the output holds test results, the failing tests and the counts
 * come FIRST and the tail follows under OUTPUT_TAIL_MARK; masking covers every part, the names included.
 */
export function detailSection(name, code, captured, summary, values, resultFiles = [], drill = false) {
  const t = tail(captured);
  const parts = [`### RED ${name} exit ${code}`, '', ...(drill ? [RED_DRILL_BANNER, ''] : [])];
  // Masked BEFORE it is read, so a clipped line can never leave half a secret showing.
  const found = testFailures(mask(captured, values), resultFiles.map((r) => ({ name: r.name, text: mask(r.text, values) })));
  if (found) parts.push(...failuresBlock(found).map((l) => mask(l, values)), OUTPUT_TAIL_MARK, '');
  if (t.cut) parts.push(`(last ${TAIL_LINES} lines; ${t.cut} earlier line(s) not shown)`, '');
  parts.push(mask(t.text, values), '');
  if (summary.trim()) parts.push('#### step summary', '', mask(summary.trim(), values), '');
  return `${parts.join('\n')}\n`;
}

/** The JSON result files a step's runners wrote to its RESULTS_ENV directory, name-sorted; an oversized one is skipped. */
export function resultFiles(dir) {
  if (!existsSync(dir)) return [];
  return listDir(dir)
    .filter((f) => f.endsWith('.json') && statSync(join(dir, f)).isFile() && statSync(join(dir, f)).size <= RESULT_MAX_BYTES)
    .sort()
    .map((f) => ({ name: f.replace(/\.json$/, ''), text: readFileSync(join(dir, f), 'utf8') }));
}

/** The argv the runner's default shell would run `file` with, on `platform`. */
export function defaultShellArgv(file, platform = process.platform) {
  if (platform === 'win32') {
    // pwsh dot-sources only a .ps1, so the script is copied into a directory of its own.
    const ps1 = join(mkdtempSync(join(tmpdir(), 'quiet-ps1-')), 'step.ps1');
    const body = readFileSync(file, 'utf8');
    writeFileSync(ps1, `$ErrorActionPreference = 'stop'\n${body}\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n`);
    return ['pwsh', '-command', `. '${ps1}'`];
  }
  return ['bash', '-e', file];
}

export function parseArgs(argv) {
  const out = { name: null, defaultShell: null, cmd: [], public: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      out.cmd = argv.slice(i + 1);
      break;
    }
    if (a === '--name') out.name = argv[++i] ?? null;
    else if (a === '--default-shell') out.defaultShell = argv[++i] ?? null;
    else if (a === '--public') out.public = true;
    else return { error: `unknown argument ${a}` };
  }
  if (!out.name || !STEP_NAME.test(out.name)) return { error: '--name <name> is required: letters, digits and ._()- only' };
  if (out.defaultShell && out.cmd.length) return { error: 'give --default-shell <file> or -- <cmd...>, not both' };
  if (!out.defaultShell && out.cmd.length === 0) return { error: 'no command after --' };
  return out;
}

/**
 * Runs the step. Returns {code, line}. `io` is for tests: {env, tempDir, stdout, platform, drainMs}.
 */
export async function runQuiet(opts, io = {}) {
  const env = io.env ?? process.env;
  const drainMs = io.drainMs ?? DRAIN_MS;
  // The detail goes to the job's own RUNNER_TEMP, where the job's hand-off step reads it. Off a runner
  // there is no such directory, and a fixed name in the shared temp dir is guessable, so it goes
  // to this step's private directory instead.
  const runnerTemp = io.tempDir ?? env.RUNNER_TEMP ?? null;
  const say = io.stdout ?? ((s) => process.stdout.write(s));
  const work = mkdtempSync(join(runnerTemp ?? tmpdir(), 'quiet-'));
  const logPath = join(work, `${opts.name}.log`);
  const summaryPath = join(work, `${opts.name}.summary.md`);
  writeFileSync(summaryPath, '');
  const resultsDir = join(work, 'results');
  mkdirSync(resultsDir);
  const cmd = opts.defaultShell ? defaultShellArgv(opts.defaultShell, io.platform) : opts.cmd;
  const log = createWriteStream(logPath);
  const added = [];
  const notes = [];
  let pending = '';
  const scan = (chunk) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const l of lines) {
      const m = /^::add-mask::(.*)$/.exec(l.replace(/\r$/, ''));
      if (m) {
        added.push(m[1]);
        say(`${l}\n`);
      } else if (l.startsWith(DETAIL_PREFIX)) {
        notes.push(l.slice(DETAIL_PREFIX.length).replace(/\r$/, ''));
      } else if (opts.public && l.startsWith(PUBLIC_PREFIX)) {
        say(`${mask(l.slice(PUBLIC_PREFIX.length).replace(/\r$/, ''), maskValues(env, added))}\n`);
      }
    }
  };
  const started = Date.now();
  const code = await new Promise((done) => {
    let child;
    try {
      child = spawn(cmd[0], cmd.slice(1), { env: { ...env, GITHUB_STEP_SUMMARY: summaryPath, [RESULTS_ENV]: resultsDir }, stdio: ['inherit', 'pipe', 'pipe'] });
    } catch (e) {
      log.write(`quiet-step: could not start ${cmd[0]}: ${e.message}\n`);
      done(127);
      return;
    }
    for (const s of [child.stdout, child.stderr]) {
      s.on('data', (c) => {
        log.write(c);
        scan(c);
      });
    }
    child.on('error', (e) => {
      log.write(`quiet-step: could not start ${cmd[0]}: ${e.message}\n`);
      done(127);
    });
    // 🔴 Settle on 'exit', never on 'close' alone (2026-10-09 · e2e-unhang). 'close' waits for every
    // holder of the stdout/stderr pipes, and a background grandchild the step started and never
    // reaped (E2E's `chromedriver &`) holds them for ever: the step then hung to the job's 30-minute
    // limit with its exit code already known. After 'exit' the pipes get DRAIN_MS to flush what the
    // child wrote, then are dropped.
    let settled = false;
    const settle = (c) => {
      if (settled) return;
      settled = true;
      done(c);
    };
    child.on('close', (c, signal) => settle(c ?? (signal ? 128 : 1)));
    child.on('exit', (c, signal) => {
      const verdict = c ?? (signal ? 128 : 1);
      const timer = setTimeout(() => {
        for (const s of [child.stdout, child.stderr]) s.destroy();
        log.write(`quiet-step: the command exited ${verdict}, but a process it left behind still held its output after ${drainMs} ms; stopped reading\n`);
        settle(verdict);
      }, drainMs);
      timer.unref();
    });
  });
  // A last line with no newline is still a line: an `::add-mask::` there must be passed
  // through and masked like any other.
  if (pending !== '') scan('\n');
  await new Promise((r) => log.end(r));
  const ms = Date.now() - started;
  // ⏱ 2026-11-07 · the forced-red drill (header): a green step the drill names goes red; a red one stays as it is.
  const drill = code === 0 && isRedDrill(env, opts.name);
  if (drill) return redStep({ opts, code: 1, logPath, summaryPath, runnerTemp, work, env, added, resultsDir, say, drill, notes });
  if (code === 0) {
    if (notes.length) appendFileSync(join(runnerTemp ?? work, DETAIL_FILE), noteSection(opts.name, notes, maskValues(env, added)));
    const line = `ok ${opts.name} ${ms}`;
    say(`${line}\n`);
    return { code, line };
  }
  return redStep({ opts, code, logPath, summaryPath, runnerTemp, work, env, added, resultsDir, say, drill: false, notes });
}

/** A red step's detail section and public line (`(drill)` when the drill forced it). */
function redStep({ opts, code, logPath, summaryPath, runnerTemp, work, env, added, resultsDir, say, drill, notes }) {
  const captured = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const summary = readFileSync(summaryPath, 'utf8');
  // A drilled step was green, so a `::nikatru-detail::` note it printed is kept, as its green run would have.
  if (drill && notes.length) appendFileSync(join(runnerTemp ?? work, DETAIL_FILE), noteSection(opts.name, notes, maskValues(env, added)));
  appendFileSync(join(runnerTemp ?? work, DETAIL_FILE), detailSection(opts.name, code, captured, summary, maskValues(env, added), resultFiles(resultsDir), drill));
  const line = `RED ${opts.name} exit ${code}${drill ? ' (drill)' : ''}`;
  say(`${line}\n`);
  return { code, line };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    // Nothing was run, so there is no verdict to pass through: not a pass, and not a red of the step's.
    console.error(`x COVERAGE LOST - quiet-step: ${opts.error}; nothing was run`);
    process.exit(2);
  }
  const { code } = await runQuiet(opts);
  process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
