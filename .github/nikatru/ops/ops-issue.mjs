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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callBridgeOps, opsEnv } from './bridge-ops.mjs';
import { fitOpsBody } from './fit-ops-body.mjs';
import { sendWithBoundedRetry } from './bounded-retry.mjs';
import { ENV_NAMES, SEND_TIMEOUT_MS as PAGE_SEND_TIMEOUT_MS, ZONE_FILE, channels, viaCloudflare, zoneFacts } from './owner-page-watch.mjs';

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
 * Cloudflare or mail. Here, not in owner-page-watch.mjs, because an ops-watch reader that sends must use the shared
 * send plan (ops-bounded-retry.test.mjs B8), which owner-page-watch.mjs's own timers do not.
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

/**
 * The alert page's sender: sendPush's request under the shared send plan (bounded-retry.mjs sendWithBoundedRetry —
 * re-sent only when it provably never left the runner, so one dropped connection does not lose the page and no page is
 * sent twice). `{ ok, status, headers }`, never throws; an error carries the error's NAME only (never the URL).
 */
export async function sendPushBounded(url, token, title, text, fetchImpl = globalThis.fetch, opts = {}) {
  const headers = { 'content-type': 'text/plain; charset=utf-8', title, priority: 'urgent', tags: 'rotating_light' };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await sendWithBoundedRetry(({ signal }) => fetchImpl(url, { method: 'POST', body: text, headers, signal }), { timeoutMs: PAGE_SEND_TIMEOUT_MS, slowPath: () => {}, ...opts });
    return { ok: res.ok, status: res.status, headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])) };
  } catch (e) {
    return { ok: false, status: 0, headers: {}, error: e?.name ?? 'send failed' };
  }
}

/**
 * `--page-alert`: send composeAlertPage once. Effects injectable as in main(): send, readZone, log.
 * Exit: 0 delivered off Cloudflare · 1 a FINDING, delivered through Cloudflare · 2 COVERAGE LOST — no push channel
 * (a heartbeat alone cannot carry an event page), a push URL refused, the zone unreadable, or the push refused.
 */
export async function pageAlert(env = process.env, deps = {}) {
  const { send = sendPushBounded, log = (line) => process.stdout.write(`${line}\n`) } = deps;
  const readZone = deps.readZone ?? (() => JSON.parse(readFileSync(ZONE_FILE, 'utf8')));
  const notPaged = (why) => (log(`::error title=The owner was NOT paged for this ops-watch red::${why}. The durable issue may be the only record, and it is filed under the owner's own account; tell the owner yourself.`), 2);
  let ch;
  try {
    ch = channels(env, zoneFacts(readZone()));
  } catch (e) {
    return notPaged(`the zone register is unreadable: ${e.message}`);
  }
  if (ch.error) return notPaged(ch.error);
  if (ch.push === null) return notPaged(`${ENV_NAMES.push} is not set (a heartbeat cannot carry an event page)`);
  const page = composeAlertPage(env);
  const sent = await send(ch.push, ch.pushToken, page.title, page.text);
  if (!sent?.ok) return notPaged(`the push answered HTTP ${sent?.status ?? 0}${sent?.error ? `, ${sent.error}` : ''}`);
  if (viaCloudflare(sent.headers)) {
    log(`FINDING: the ops-watch page was delivered, but ${ENV_NAMES.push} answered through Cloudflare (cf-ray): in a Cloudflare outage it is lost.`);
    return 1;
  }
  log(`PAGED: the owner was told (${page.title}); the push answered HTTP ${sent.status}, off Cloudflare.`);
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = process.argv.includes('--page-alert') ? await pageAlert() : await main();
