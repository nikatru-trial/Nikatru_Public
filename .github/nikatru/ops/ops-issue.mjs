#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// ops-issue.mjs — file one report against a durable ops issue in the PRIVATE
// repository, through the bridge's POST /ops `ops-issue` (tooling/ops/bridge-ops.mjs).
//
// ⏱ 2026-10-06 · ops-watch-postcutover. ops-watch.yml's `alert` and `digest`
// jobs and e2e.yml's `alert` job filed with `gh issue create` in the CI
// repository; after the cutover that is the PUBLIC shell, where the job's
// `contents: read` refused it (shell run 37415112024, step alert.1, exit 1) and
// where an ops issue would publish ops detail. The bridge holds the only token
// that writes to the private repository; it re-reads THIS run (GITHUB_RUN_ID,
// GITHUB_RUN_ATTEMPT — the shell's own run) and files only for a live run of
// the workflow the kind belongs to. The title is the bridge's, rendered from the
// step's own `TITLE:` (gen-public-shell.mjs opsIssueKinds), never sent.
//
// ⏱ 2026-10-06 · ops-digest-fit. The bridge refuses a body over 61,440 bytes,
// and the weekly digest with a red register measured 129,159: the body is fitted
// first (tooling/ops/fit-ops-body.mjs — green sections to their summary, then
// the middle of the largest red section cut with a marker, never an exit line),
// and every reduction is printed here. A report is never refused for its size.
//
// Usage: node tooling/ops/ops-issue.mjs --kind <kind> --body-file <file>
//        node tooling/ops/ops-issue.mjs --page-alert   (⏱ 2026-11-09 · review52-ops-001: ops-watch `alert`'s page,
//        pageAlert below; env OWNER_PAGE_PUSH_URL, OWNER_PAGE_PUSH_TOKEN, RUN_URL; its exits are pageAlert's)
// Env:   NIKATRU_BRIDGE_OPS_URL, BRIDGE_READ_SECRET (the step's, from the shell),
//        GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT. The red jobs are named by the bridge from
//        its own read of the run, never sent from here: an expression in `env:` is
//        printed in the shell's public log.
// Exit:  0 filed · 1 the bridge refused (it looked and said no) · 2 COVERAGE
//        LOST — nothing could be sent, or the bridge could not complete it.
//        A report that did not land is never a pass.
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callBridgeOps, opsEnv } from './bridge-ops.mjs';
import { fitOpsBody } from './fit-ops-body.mjs';
import { ENV_NAMES, ZONE_FILE, channels, sendPage, viaCloudflare, zoneFacts } from './owner-page-watch.mjs';

const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
};

/** ⏱ 2026-10-08 (system review A3, m11). PURE. The bridge's 200 answer, CHECKED: a positive issue number and
 *  one of the bridge's three actions (services/gh-bridge/src/ops.ts fileOpsIssue). A malformed 200 printed
 *  `#undefined` and exited 0 — a report counted as filed that nothing shows landed. `{ ok }` or `{ lost }`. */
export const OPS_ISSUE_ACTIONS = Object.freeze(['created', 'commented', 'updated']);
export function judgeAnswer(answer) {
  const issue = answer?.issue;
  const action = answer?.action;
  if (!Number.isSafeInteger(issue) || issue <= 0) return { lost: `the bridge answered 200 with no issue number (${JSON.stringify(issue ?? null)})` };
  if (!OPS_ISSUE_ACTIONS.includes(action)) return { lost: `the bridge answered 200 with an action it never takes (${JSON.stringify(action ?? null)})` };
  return { ok: { issue, action } };
}

async function main() {
  const kind = flag('--kind');
  const file = flag('--body-file');
  if (!kind || !file) {
    console.error('LOST  usage: ops-issue.mjs --kind <kind> --body-file <file>');
    return 2;
  }
  const runId = Number(process.env.GITHUB_RUN_ID);
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(runId) || runId <= 0 || !Number.isSafeInteger(attempt) || attempt <= 0) {
    console.error('LOST  GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT do not name a run: the bridge binds the report to one');
    return 2;
  }
  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`LOST  the report body ${file} could not be read (${e.code ?? e.message})`);
    return 2;
  }
  const fit = fitOpsBody(body);
  for (const note of fit.notes) console.log(`fit  ${note}`);
  const r = await callBridgeOps({ ...opsEnv(), op: 'ops-issue', params: { kind, run_id: runId, run_attempt: attempt, body: fit.text } });
  if (r.lost) {
    console.error(`LOST  ${r.lost} — the ${kind} report did not land, and that is never a pass`);
    return 2;
  }
  if (r.refused) {
    console.error(`FAIL  ${r.refused}`);
    return 1;
  }
  const judged = judgeAnswer(r.answer);
  if (judged.lost) {
    console.error(`LOST  ${judged.lost} — the ${kind} report is not known to have landed, and that is never a pass`);
    return 2;
  }
  console.log(`ok  the ${kind} report is on private issue #${judged.ok.issue} (${judged.ok.action})`);
  return 0;
}

/**
 * ⏱ 2026-11-09 · fix52-ops (review52-ops-001). THE OPS-WATCH ALERT'S PAGE. ops-watch.yml's `alert` job files every
 * unattended red against ONE durable issue in the private code repository, through the bridge — whose token is the
 * owner account's own PAT (tooling/worker-secrets.json NIKATRU_GITHUB_PAT), and GitHub sends no notification for an
 * account's own activity by default. So the issue comment alone may reach nobody. This is the job's second step: one
 * page through owner-page-watch.mjs's push channel (OWNER_PAGE_PUSH_URL — the same secret and refusal rules, channels()
 * and zoneFacts(), that the hourly watch, kill-switch-dispatch.mjs and org-move.mjs use), never through the bridge,
 * Cloudflare or mail. ⏱ 2026-11-25 · O-STD-OWNER-PUSH-ONE-SENDER-CODEMOD: the sender under the shared send plan that
 * lived here (sendPushBounded) moved to owner-page-watch.mjs as sendPage, the ONE sender every CI-side owner page uses.
 * PURE. The page for one red run: `{ title, text }`. RUN_URL is the shell run's public URL; nothing secret is in it.
 */
export function composeAlertPage(env) {
  const run = (env.RUN_URL ?? '').trim() || '(the run URL was not given)';
  const attempt = (env.GITHUB_RUN_ATTEMPT ?? '').trim();
  return {
    title: 'NIKATRU ops-watch is red: a scheduled duty is not reporting healthy',
    text: [`An unattended ops-watch run failed${attempt ? ` (attempt ${attempt})` : ''}: ${run}`, "The run log names the red job; the private issue 'Scheduled duty is not reporting healthy' carries every red as a comment."].join('\n'),
  };
}

/** PURE. The one record line of a delivered page: the id (or `unread`) and the push URL's HOST only — never its path (the topic) or a token. */
export function pagedRecord(pushUrl, id) {
  let host = 'unread';
  try {
    host = new URL(pushUrl).hostname || 'unread';
  } catch {
    /* the URL was accepted by channels(); an unparsable one still records no path */
  }
  return `PAGED id=${id ?? 'unread'} topic-host=${host}`;
}

/**
 * ⏱ 2cf6974e · O-R52-OPS-001 (rulings 60c6c88b478b, d857127a4295; lane ops-drills-4-1121): THE RECORD'S CHANNEL. In the
 * shell this step runs under quiet-step, which swallows a green step's stdout (the ::notice) AND points
 * GITHUB_STEP_SUMMARY at a private file it shows only on red (tooling/ci/quiet-step.mjs), so the lead's signed-in read of
 * slot run 44684822875 found no PAGED line at all. The record therefore goes where the failure path's reason already
 * goes: the bridge's POST /ops `ops-issue`, kind `alert-page` (one filing step per kind, the same durable PRIVATE issue,
 * a comment the run attempt owns). Chosen over a `::nikatru-public::` line (it would publish the push host on a public
 * run page and needs a publicLines entry) and over a step output (no job prints it): the private issue is durable (ntfy's
 * cache keeps a message 72 h), already signed by this step's bridge env, and it is where the lead reads the alert.
 * Best-effort, as notPaged's filing: the page WAS delivered, so a lost record never changes the exit; it is said.
 * Returns the line it logged (tests).
 */
export async function fileRecord(record, env, report, log) {
  const runId = Number(env.GITHUB_RUN_ID);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  let r;
  try {
    r = Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(attempt) && attempt > 0
      ? await report({ kind: 'alert-page', run_id: runId, run_attempt: attempt, body: fitOpsBody(`${record}\nThe owner was paged off GitHub for this ops-watch red. This line is the page's delivery record (alarm-chains.json chainsObserved.ops-watch-page).`).text })
      : { lost: 'GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT do not name a run' };
  } catch (e) {
    r = { lost: e?.name ?? 'the /ops call failed' };
  }
  const judged = r?.answer ? judgeAnswer(r.answer) : null;
  const line = judged?.ok
    ? `filed: the page record is on private issue #${judged.ok.issue} (${judged.ok.action})`
    : `::warning title=The page was delivered, but its record was NOT filed::${r?.lost ?? r?.refused ?? judged?.lost ?? 'no answer'}`;
  log(line);
  return line;
}

/**
 * `--page-alert`: send composeAlertPage once. Effects injectable as in main(): send, readZone, log.
 * Exit: 0 delivered off Cloudflare · 1 a FINDING, delivered through Cloudflare · 2 COVERAGE LOST — no push channel
 * (a heartbeat alone cannot carry an event page), a push URL refused, the zone unreadable, or the push refused.
 */
export async function pageAlert(env = process.env, deps = {}) {
  const { log = (line) => process.stdout.write(`${line}\n`) } = deps;
  const send = deps.send ?? ((url, token, title, text) => sendPage(url, token, title, text, deps.fetch));
  // The step summary is the record quiet-step cannot hide (it swallows a green step's stdout).
  const summary = deps.summary ?? ((line) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`));
  const readZone = deps.readZone ?? (() => JSON.parse(readFileSync(ZONE_FILE, 'utf8')));
  // ⏱ 2026-11-12 · lane c1113-ci, row O-R1110-OPS-WATCH-ALERT-NO-HANDOFF, lead ruling (b): the alert is a shell-own job that
  // holds no key and seals no hand-off, so a failed page's REASON goes to the bridge's /ops door — ops-issue, kind alert-page (its own kind, one filing step per kind; the same title, so
  // the same durable private issue) — and not only to this quiet step's log, where it was stored nowhere. Best-effort:
  // the exit stays 2 whatever the bridge answers. [deps.report] (tests) replaces the door.
  const report = deps.report ?? ((params) => callBridgeOps({ ...opsEnv(), op: 'ops-issue', params }));
  const notPaged = async (why) => {
    const line = `The owner was NOT paged for this ops-watch red: ${why}. The durable issue may be the only record, and it is filed under the owner's own account; tell the owner yourself.`;
    log(`::error title=The owner was NOT paged for this ops-watch red::${why}. The durable issue may be the only record, and it is filed under the owner's own account; tell the owner yourself.`);
    const runId = Number(env.GITHUB_RUN_ID);
    const attempt = Number(env.GITHUB_RUN_ATTEMPT);
    let r;
    try {
      r = Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(attempt) && attempt > 0 ? await report({ kind: 'alert-page', run_id: runId, run_attempt: attempt, body: fitOpsBody(line).text }) : { lost: 'GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT do not name a run' };
    } catch (e) {
      r = { lost: e?.name ?? 'the /ops call failed' };
    }
    const judged = r?.answer ? judgeAnswer(r.answer) : null;
    if (judged?.ok) log(`filed: the reason is on private issue #${judged.ok.issue} (${judged.ok.action})`);
    else log(`::error title=The page's reason was NOT filed either::${r?.lost ?? r?.refused ?? judged?.lost ?? 'no answer'}`);
    return 2;
  };
  let ch;
  try {
    ch = channels(env, zoneFacts(readZone()));
  } catch (e) {
    return await notPaged(`the zone register is unreadable: ${e.message}`);
  }
  if (ch.error) return await notPaged(ch.error);
  if (ch.push === null) return await notPaged(`${ENV_NAMES.push} is not set (a heartbeat cannot carry an event page)`);
  const page = composeAlertPage(env);
  const sent = await send(ch.push, ch.pushToken, page.title, page.text);
  if (!sent?.ok) return await notPaged(`the push answered HTTP ${sent?.status ?? 0}${sent?.error ? `, ${sent.error}` : ''}`);
  const id = /^[A-Za-z0-9_-]{1,64}$/.test(String(sent.id ?? '')) ? String(sent.id) : null;
  const record = pagedRecord(ch.push, id);
  try {
    summary(record);
  } catch {
    /* an unwritable summary never turns a delivered page into a failure */
  }
  log(`::notice title=owner page::PAGED id=${id ?? 'unread'}`);
  await fileRecord(record, env, report, log);
  if (viaCloudflare(sent.headers)) {
    log(`FINDING: the ops-watch page was delivered, but ${ENV_NAMES.push} answered through Cloudflare (cf-ray): in a Cloudflare outage it is lost.`);
    return 1;
  }
  log(`PAGED: the owner was told (${page.title}); the push answered HTTP ${sent.status}, off Cloudflare.`);
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = process.argv.includes('--page-alert') ? await pageAlert() : await main();
