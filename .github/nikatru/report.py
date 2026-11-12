#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# shell-report.py — the public shell's verdicts, signed, to the bridge Worker.
#
# GitHub migration P4 (Private/research/session-2026-10-04/github-migration/
# PLAN.md, design items 2 and 4; lead ruling on PR #1234, finding 2). It runs in
# the TWO generated jobs at the end of each root workflow, `nikatru-collect` and
# `nikatru-report` (below), which need the gate and every lane the gate needs,
# check out ONLY the public shell repository, and run nothing from the private
# checkout. tooling/ci/gen-public-shell.mjs ships a byte copy of this file as
# shell/.github/nikatru/report.py, beside the generated <workflow>.json config of
# each root workflow (assert-public-shell.mjs limb A holds both to the generator).
# The report secret exists in the report job's last two steps (the send and its
# no-detail fallback) and nowhere else in the shell (limb H): a step that runs
# pull-request code never holds it, and the job that holds it restores nothing
# another job saved (limb I). NIKATRU_DETAIL_KEY is in each quiet job's hand-off
# STAGING step and the report job's send step only (limb J): ⏱ 2026-10-08 · A7-05, every
# quiet job runs the shell's OWN staged copy of this file (and of quiet-step.mjs), never the
# private checkout's; its staging step derives this run attempt's key (`derive`) before any
# private code runs, and the hand-off seals under that key alone (limb Z).
#
# Why Python: the job must run without the private tree, so the reporter is a
# file of the shell repository, and it needs nothing but the standard library
# (HMAC, JSON, HTTP). CodeQL in this repository analyses JavaScript/TypeScript
# only, so this file is NOT CodeQL-analysed; its one data flow — a red step's
# detail, read from a file, sealed, handed on, posted to the bridge — is the
# by-design flow, and
# tooling/ci/test/shell-report.test.mjs grades it.
#
#   Every quiet job hands its red detail over SEALED (lead ruling p7-bridge-payload-r3,
#   item 3: the private repo's test output and PR text never sit in plain text in the
#   PUBLIC repo's Actions cache). Its generated steps run the shell's STAGED copy of this file:
#   report.py derive        (the staging step, before any private code) this run attempt's
#                           key, HMAC of `<run_id>-<attempt>` under NIKATRU_DETAIL_KEY, to
#                           NIKATRU_DETAIL_KEY_FILE (A7-05); with NIKATRU_BASELINE_KEY_FILE
#                           set, also the CodeQL baseline key (HKDF of the master, info
#                           'nikatru-codeql-baseline'), so the baseline's verify and seal
#                           steps never hold the master
#   report.py handoff       $RUNNER_TEMP/report-detail.md within the cap (fit_bytes: each
#                           red section's failing tests kept, its tail cut first), sealed with
#                           that run key and bound to its own cache key
#                           (NIKATRU_HANDOFF), written as .nikatru-detail/detail.sealed,
#                           and `has=true` to $GITHUB_OUTPUT so actions/cache/save runs;
#                           no key, no hand-off: nothing is ever cached in the clear
#
#   Two generated jobs per root workflow, so the job that holds the report secret
#   never restores what a job that ran pull-request code saved (review of #1234,
#   finding B: an actions/cache archive is shaped by whoever saved it, not by the
#   restore's `path:`, and can overwrite this very file):
#
#   nikatru-collect — NO report secret, NO detail key. Restores the sealed hand-offs:
#   report.py plan <cfg>    list this run+attempt's detail hand-offs (actions/cache
#                           keys) and write key_0..key_<n-1> and `overflow` to
#                           $GITHUB_OUTPUT; the job restores each into .nikatru-detail/
#   report.py place <key>   move the restored .nikatru-detail/detail.sealed to
#                           .nikatru-collected/<key>.sealed
#   report.py collect <cfg> every restored hand-off, carried through UNCHANGED (still
#                           sealed), as ONE JSON bundle {v, handoffs: {key: sealed},
#                           unrestored: [key]} within SEALED_MAX_CHARS, written as the
#                           job output `detail`, spilling into `detail_2` .. (DETAIL_OUTPUTS);
#                           one that does not fit in any is named only
#
#   report.py pr-meta       (the gate job's pre-read, before any private code) the private PR
#                           as it is now through POST /pr-meta, signed with BRIDGE_READ_SECRET and
#                           bound to this run, to NIKATRU_PR_META_FILE; a PR that changes a
#                           RUNNER_SOURCES file without the lead's RUNNER_LABEL (A7-05/A7-06) is a
#                           wait recorded as the gate's HOLD (green step, `::warning`), which send
#                           posts pending; the step output `meta` is `clear` only when it decided so
#   report.py tier          (the pin job's last step, ci.yml only; runbook §0e rule 2) this run's CI tier,
#                           `light` or `full`, to $GITHUB_OUTPUT `tier` with its reason printed: `full`
#                           unless the run is a pull_request, its ref is not refs/heads/train/*, the
#                           NIKATRU_TIER_LIGHT variable is `on`, POST /pr-meta answered (the same
#                           read_pr_meta as pr-meta) and the PR carries no `ci-full` label. Fails CLOSED:
#                           any doubt is `full`, and it always exits 0 (the job output defaults to full)
#
#   nikatru-report — the report secret; restores nothing, runs nothing another job
#   wrote (assert-public-shell.mjs limb I). A fresh sparse checkout of this shell, then
#   /usr/bin/python3 -I .github/nikatru/report.py send <cfg>
#                           one commit status per lane the gate needs (state from
#                           NIKATRU_RESULTS, so a green re-run clears a red one), then
#                           the gate's. The bundle arrives as NIKATRU_DETAIL, plain
#                           data in `env:`; it is unsealed, parsed and checked against
#                           its own key (known members of this run, this attempt or an
#                           earlier one: a re-run of the report job alone reuses the
#                           earlier attempt's bundle; size caps).
#                           A bundle that fails — another key, another run, a hand-off
#                           moved to another key, altered, malformed — is COVERAGE LOST:
#                           every status still goes out without detail, and the step
#                           exits 2, never an empty pass. Having attempted every
#                           status it writes `reported=true` to $GITHUB_OUTPUT (a file).
#   The report job's LAST step runs the same `send` WITHOUT the detail, if that output is
#   not `true`: the step above never started (a job output may be 1 MB, and Linux refuses
#   to start a process with one environment string over 128 KiB), or it died. So no
#   hand-off can withhold the statuses (review of #1245, finding 1).
#
# Why sealed AT HAND-OFF: an actions/cache entry of a public repository's default-branch
# scope can be restored by a later run of that repository (a fork's pull_request run
# included, where Actions lets one run), an artifact is downloadable by anyone signed in
# (limb C), and a job output reaches a step only through an expression, whose value the
# runner prints in the step's public log header. So each hand-off is encrypted and
# authenticated (HMAC-SHA256 in counter mode as the keystream, encrypt-then-MAC, its own
# cache key — run, attempt, job — bound in) BEFORE actions/cache/save, under
# NIKATRU_DETAIL_KEY, held by the hand-off steps and the report job's send step. The
# hand-off steps run pull-request code of the PRIVATE repository, whose authors already
# read its pull requests; the key keeps the detail from everyone else. The worst a
# poisoned hand-off can do to the report job is drop the detail and red that step.
#
# The bridge's contract (services/gh-bridge/src/report.ts parseReport):
#   POST <bridgeUrl>   x-bridge-signature: sha256=<HMAC-SHA256 of the raw body>
#   {run_id, run_attempt, sha, context, state, summary, detail?, ts}   (ts: the attempt's epoch seconds, post())
# `sha` is the private HEAD the bridge dispatched (NIKATRU_HEAD_SHA = the payload's
# sha), never the merge commit a pull-request job checks out.
#
# ⏱ 2026-10-05 (gh-bridge f1, round 3; lead ruling): THE GATE COMES ONLY FROM A RUN THAT HAS
# ONE. The gate's context is sent only when the run was dispatched for a pull request
# (NIKATRU_P_EVENT pull_request with a PR number) or for a push to main or of a tag; any
# other run reports its lanes and NOT the gate, and exits 1. The bridge dispatches nothing
# else, so this is defence in depth: a run without the PR range can never write the
# verdict the landers gate on. The bridge itself holds the context to this workflow's own
# set (services/gh-bridge/src/generated/shell.ts, written by gen-public-shell.mjs).
#
# ⏱ 2026-10-05 (p7-shell-fixes, B1): EVERY POST NAMES ITS OWN AGENT. The bridge's route is
# workers.dev, behind Cloudflare's Browser Integrity Check, which refuses Python's default
# `User-Agent: Python-urllib/3.x` with 403 / error code 1010 before the Worker runs. Measured
# from Box A in the P7 rehearsal: that agent 403/1010, a curl agent 401 "bad signature" (it
# reached the Worker), and every report of R1 and R2 was the 403 — no status from the shell.
# post() sends USER_AGENT; the test bridge refuses the default agent exactly as the edge does.
#
# ⏱ 2026-10-06 (ops-followups-1006): A TRANSIENT ANSWER IS RETRIED. Shell run 37430771854
# attempt 2 went red on ONE `ci/lane-workers success -> HTTP 502 (GitHub call failed)` while
# 22 other posts of the same job returned 200. post() retries a 502/503/504 and a post that got
# no answer at all, RETRY_DELAYS seconds apart (2, then 6), then reports the last answer as
# before. ⏱ 2026-11-06 (O-CI-REPORT-STEP-GIVES-UP-ON-502): the 11-05 04:19-04:21Z GitHub 5xx outlasted those 8 s,
# so the waits now grow, jittered, over a BOUNDED window (RETRY_WINDOW_S) that spans a ~2 min GitHub 5xx; past
# it the last answer still stands and the step still exits non-zero. Repeating a report is safe: the bridge's POST /report sets a commit status (the
# newest of a context wins) and edits, never duplicates, its marked comment, and the bridge
# itself re-reads by that marker before it re-creates one. Nothing else is retried: a 4xx is
# the bridge's verdict on the report, and a retry cannot change it.
#
# ⏱ 2026-10-06 (followups-r3, PR #16 review finding 2): ONE LAYER'S TIME, NOT TWO STACKED. Each post
# waits the config's `postTimeoutS` (gen-public-shell.mjs REPORT_POST_TIMEOUT_S: the bridge's
# REPORT_BUDGET_MS plus a margin, one source), so a post never gives up on — and re-posts beside —
# a /report that is still running. And a bridge 502 is retried only when its `upstream` (GitHub's
# own answer behind it) is transient too, or absent (the edge's 502): a GitHub 4xx behind a 502 is
# not cured by asking again.
#
# ⏱ 2026-10-08 (capture-detail-private): A MANUAL RUN'S RED DETAIL REACHES THE PRIVATE SIDE. A root whose shell
# `on:` carries `workflow_dispatch` runs its collect and report jobs on such a run too (gen-public-shell.mjs
# reportEventIf), and `send` then posts NO status — the run was dispatched by a person or the platform, not
# for a private commit, and POST /report refuses it — but ONE signed body {run_id, run_attempt, detail} to the
# config's `dispatchDetailUrl` (services/gh-bridge/src/dispatch-detail.ts). The bridge re-reads the run as
# /report does and files the detail on its durable PRIVATE issue. The detail is the hand-offs' text, which
# the quiet step wrapper masked when it captured it; this log prints only the HTTP status. Red jobs with no detail
# handed over still post their names; nothing red and nothing lost posts nothing. A 409 is the bridge saying
# this attempt's detail is already filed (the fallback step after a send that died past its post): not a failure.
# ⏱ 2026-10-24 (O-SCHEDULED-RUN-RED-DETAIL-NEVER-DELIVERED): A SCHEDULED RUN'S TOO. Such a root that also runs on a
# clock (e2e, codeql, extensions, build-platforms) sealed its scheduled run's red detail into hand-offs that no job
# collected — its report job ran only on a dispatch — so the public log's `RED <step> exit N` was all anyone saw. The
# generator now runs the pair on `schedule` too (reportEventIf `scheduled`), and `send` files that run's detail at the
# same door, the same way (UNDISPATCHED_EVENTS): masked by the wrapper, fenced as data, never printed here.
#
# ⏱ 2026-10-08 (gitleaks-pr-scoped-r2, review 26acc3ec finding 2): A GREEN GATE CAN CARRY NOTES. A
# quiet step's `::nikatru-detail::` line lands in its job's detail as a `### NOTE <step>` section on a
# green step too (the quiet-step wrapper), so a job with a note hands a detail over while green.
# Every job's NOTE sections are added to the GATE's detail, and a `success` gate posts those sections
# (and nothing else) as its detail; a lane's success still posts none. The first such note is an
# applied PR-scoped secret-scan exemption (tooling/ci/scan-secrets.mjs), a hole a reviewer must see.
#
# ⏱ 2026-10-23 (ci-gate-holds, O-FIRST-PASS-AUDIT-LANE-FIXES decision 2): A HOLD IS PENDING, NOT A FAILURE. The
# first-pass audit of 2026-10-17 counted a gate that only WAITS (a runner-source PR with no RUNNER_LABEL yet, which
# the lane is told to ask for before its first run) as a red CI run, and the lane re-diagnosed a red that was a wait.
# pr-meta records such a wait as a `### HOLD <what>` section of the gate's detail (HOLD_HEADER), and `send` posts the
# gate `pending` instead of `failure` only when the hold is the ONLY red (held): every lane of the config reported
# success, the bundle was read, the gate's detail carries a HOLD section and no `### RED` section. Pending is never
# green: a lander gates on success.
#
# ⏱ 2026-10-24 (ci-gate-hold-not-red, lead decision; supersedes "the step still fails" above): A LABEL WAIT IS NOT A
# RED RUN. The pr-meta step failing on a hold kept the PUBLIC gate job, and so the whole run, at `failure` with every
# lane green (#1037, #1049 run 40069468612, #1055 run 40079869892), and the owner read a red X for a wait. pr-meta
# now ends a label-only hold at exit 0 with its `::warning` HOLD annotation, so the Public job and run are green. What
# that exit used to buy, "a hold whose record is lost reads as the failure it always was", is now bought by a
# POSITIVE signal instead: pr-meta writes the step output `meta` (GATE_CLEAR when it decided the PR is clear: no
# RUNNER_SOURCES file touched, or the label present; GATE_HOLD on a hold; nothing when it cannot decide, exit 2), the
# gate job carries it as `outputs.meta`, and the report job hands it to `send` as NIKATRU_GATE_META. For a config
# whose gate reads the PR (`gateMeta`), a pull request's gate is posted `success` only when that signal is
# GATE_CLEAR AND its detail carries no HOLD section (the second witness, cleared). A gate job that succeeded without
# it — the output lost, the step skipped, pr-meta crashed before writing it, the hold record lost — posts `pending`
# when it is held, else `failure`; never `success`. The other reds are unchanged: a RED section, a lane not green, a
# lost bundle, pr-meta's exit 2. After the label, the existing gate-only re-run (pr-recheck.yml re-runs the gate job,
# GitHub re-runs its dependents, the attempt reads only its own hand-offs) writes GATE_CLEAR, and the gate posts
# success. The residual, said: the private status, not the Public run's colour, is the gate's verdict; a Public run
# that is green on a hold reads pending privately, and the landers still refuse it.
#
# ⏱ 2026-10-27 (ci-tier-shell, runbook §0e rule 2 "one full CI per batch, not per PR"): A LIGHT RUN SAYS SO. When
# the pin job decided this run's tier `light` (`tier`, above: lane-build deferred to the train's full CI), the report
# job hands NIKATRU_TIER=light to `send`, and the summary of EVERY status it posts ends TIER_LIGHT_SUFFIX, inside
# SUMMARY_MAX_CHARS (the run text is trimmed, never the suffix). A full run adds no word: every status posted before
# the cut-over was full, so a reader reads "no word" as full. NO SUCH READER IS IN THIS TREE YET (review of #1148,
# finding 3): the landing rule that refuses a light-green PR landing alone (lane 2's train-land/full-tier-ensure) is
# out of tree, and tooling/ops/land-rules.mjs / land-gate.mjs grade the ci-gate conclusion only. So the switch
# (NIKATRU_TIER_LIGHT) stays off until that rule lands: docs/ci/README.md "The CI tier", Ships OFF.
#
# Exit 0 every report accepted (handoff: sealed, or nothing to hand over; collect: the
# bundle written) · 1 a report refused or not delivered (a verdict that did not land
# must not look green) · 2 COVERAGE LOST: no config, no bridge URL, no secret, no sha —
# nothing could be signed or sent; send: a detail bundle that does not unseal (the
# statuses went out without it); handoff: no key or no hand-off key, so nothing handed.
# ─────────────────────────────────────────────────────────────────────────────
import base64
import hashlib
import hmac
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SUMMARY_MAX_CHARS = 140
DETAIL_MAX_BYTES = 60 * 1024
CONTEXT = re.compile(r'^[A-Za-z0-9][A-Za-z0-9 ._/():-]{0,99}$')
SHA = re.compile(r'^[0-9a-f]{40}$')
STATE_OF = {'success': 'success', 'failure': 'failure', 'cancelled': 'error'}
# The collect output's cap: it fits one environment variable (Linux caps one at 128 KiB)
# and a job output (1 MB).
SEALED_MAX_CHARS = 120 * 1024
# One hand-off's plain tail: sealed, at least four fit in the collect output; the rest
# that do not fit are named in the gate's detail.
HANDOFF_MAX_BYTES = 16 * 1024
# ⏱ 2026-11-05 · club-1105m-lo-guards (O-REPORT-LOSES-RED-DETAIL-PAST-ITS-SIZE). #1263 and #1264 ended
# "(12 more red job(s) handed over detail this report could not carry: ...)": the collect output held ONE
# bundle of SEALED_MAX_CHARS (~5 sealed hand-offs), so restored hand-offs past it were dropped, and each was
# sealed under its own run key, so nobody could ever read them. collect now spills into DETAIL_OUTPUTS
# bundles, the job outputs `detail`, `detail_2` .. `detail_<DETAIL_OUTPUTS>` (each one environment string;
# all of them well inside a job's 1 MB of outputs), and send reads every one. Enough for every restore slot's
# hand-off at its cap (gen-public-shell.mjs REPORT_SLOTS; shell-report.test.mjs holds it); what is named
# now is only what no restore slot reached.
DETAIL_OUTPUTS = 3
HANDOFF_PREFIX = 'nikatru-detail-'
DETAIL_FILE = 'report-detail.md'
SEALED_FILE = 'detail.sealed'
# ⏱ 2026-11-11 · fix1110b #4 (row O-RED-DETAIL-COMPLETE). NO WHOLE-JOB DROP. Each hand-off also seals its CORE (every
# section's header, full-log line, failing tests and finding lines, within CORE_MAX_BYTES) beside the detail, bound to
# `<key>` + CORE_SUFFIX. collect carries a job's core wherever its whole detail does not fit the outputs, so a run with
# more red detail than DETAIL_OUTPUTS × SEALED_MAX_CHARS loses output tails, never a job's findings or its log link.
CORE_FILE = 'detail.core.sealed'
CORE_SUFFIX = '.core'
CORE_MAX_BYTES = 3 * 1024
BUNDLE_VERSION = 2
SEAL_VERSION = b'\x01'
NONCE_BYTES = 16
TAG_BYTES = 32
DETAIL_DIR = '.nikatru-detail'
# A green step's own detail section (the quiet-step wrapper's noteSection).
NOTE_HEADER = '### NOTE '
# A red step's detail section (the quiet-step wrapper's detailSection), and a gate step that only WAITS (pr-meta).
RED_HEADER = '### RED '
HOLD_HEADER = '### HOLD '
# ⏱ 2026-10-24 · ci-gate-hold-not-red: pr-meta's step output `meta` — the POSITIVE clear a gate's success needs
# (cleared), or the hold it recorded. Any other value, or none, is not clear.
GATE_CLEAR = 'clear'
GATE_HOLD = 'hold'
# ⏱ 2026-10-27 · ci-tier-shell: the CI tier (`tier`, `summary_of`). gen-public-shell.mjs holds the same names
# (TIER_VAR, TIER_LIGHT_VAR, TIER_LABEL; test/gen-public-shell.test.mjs pins them equal).
TIER_ENV = 'NIKATRU_TIER'
TIER_LIGHT = 'light'
TIER_FULL = 'full'
TIER_LIGHT_SUFFIX = ' · tier light'
TIER_SWITCH = 'NIKATRU_TIER_LIGHT'
TIER_LABEL = 'ci-full'
TRAIN_REF = re.compile(r'^refs/heads/train/')
# The agent every POST to the bridge names (B1): never urllib's default, which the edge bans.
USER_AGENT = 'nikatru-shell-report/1'
COLLECTED_DIR = '.nikatru-collected'
# The answers a retry may cure (a gateway's; 0 is no answer at all), and the waits, in seconds,
# before the second and third attempts.
RETRY_STATUSES = (0, 502, 503, 504)
# ⏱ 2026-10-09 (ci-noise-1009, lead e19de7 item 5): GitHub's answers BEHIND a bridge 502 that a retry may cure. A
# GitHub 500 joins the gateway's: a 500 on one status write turned green runs 37883824894 and 37883613137 red at
# `x ci/site-tokens success -> HTTP 502 (GitHub call failed)`. The bridge's OWN 500 (a binding unset) is not retried.
RETRY_UPSTREAMS = (0, 500, 502, 503, 504)
# ⏱ 2026-11-06 · O-CI-REPORT-STEP-GIVES-UP-ON-502 (club-next-1106-12): the 11-05 04:19-04:21Z GitHub 5xx (~2 min)
# outlasted (2, 6), 8 s of waiting, and green runs reported `HTTP 502`. The waits now GROW to 30 s, and every one is
# JITTERED by ±RETRY_JITTER (a run's 22 posts and a train's runs do not retry in lockstep against a recovering GitHub),
# and no attempt STARTS past RETRY_WINDOW_S after the first: the last wait is cut to land on the window's end. So one
# post spans a ~2 min GitHub 5xx, takes at most post_worst_s, and past it the last answer stands (the step exits 1).
RETRY_DELAYS = (2, 6, 12, 20, 30, 30, 30, 30, 30)
RETRY_WINDOW_S = 150
RETRY_JITTER = 0.25
# ⏱ 2026-10-10 (fix-pr216, independent review of PR #216, finding 1): A 429 IS TRANSIENT TOO. The bridge's /report
# bucket refills each minute, and one run posts one report per lane plus one for the gate, so a burst of heads in
# one minute could 429 a green run's statuses (`x … -> HTTP 429`, report.py exit 1). A 429 is retried after
# RATE_DELAYS seconds — together past one whole bucket period (60 s), so the next attempt meets a fresh bucket.
RATE_DELAYS = (20, 45)


class Lost(Exception):
    """Nothing could be signed or sent: exit 2."""


def load_config(path):
    # The config is named by path in the workflow (so the tree's dead-file guard sees its
    # consumer), and only one of the generated configs beside this script is accepted.
    if not re.match(r'^\.github/nikatru/[A-Za-z0-9_-]+\.json$', path):
        raise Lost(f'{path!r} is not a config of .github/nikatru/')
    try:
        with open(path, encoding='utf-8') as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        raise Lost(f'{path} is unreadable: {e}')
    for k in ('prefix', 'slots', 'gate', 'lanes', 'postTimeoutS'):
        if k not in cfg:
            raise Lost(f'{path} has no `{k}`')
    if not isinstance(cfg['postTimeoutS'], (int, float)) or isinstance(cfg['postTimeoutS'], bool) or cfg['postTimeoutS'] <= 0:
        raise Lost(f'{path}: postTimeoutS {cfg["postTimeoutS"]!r} is not a positive number of seconds')
    budget = cfg.get('sendBudgetS', None)
    if budget is not None and (not isinstance(budget, (int, float)) or isinstance(budget, bool) or budget < post_worst_s(cfg)):
        raise Lost(f'{path}: sendBudgetS {budget!r} is not a number of seconds that fits one whole post ({post_worst_s(cfg)} s)')
    for c in items(cfg):
        if not CONTEXT.match(c.get('context', '')):
            raise Lost(f'{path}: {c.get("context")!r} is not a status context the bridge accepts')
    return cfg


def items(cfg):
    """⏱ 2026-10-08 (sysfix-a1-ci-shell, m2/m6): what a config reports, the GATE FIRST: a post-gate config
    (<stem>-deploys.json) has no gate (`gate: null`). The gate leads so that a bridge that eats the send's
    budget still gets the one status the landers gate on."""
    return ([cfg['gate']] if cfg.get('gate') else []) + list(cfg['lanes'])


def is_gate(item, cfg):
    return cfg.get('gate') is not None and item is cfg['gate']


def post_worst_s(cfg):
    """The longest one post() can take: no attempt starts past RETRY_WINDOW_S (attempts and waits together), and the
    last one may take its whole timeout. (Until 2026-11-06: every attempt at its timeout plus every pause.)"""
    return RETRY_WINDOW_S + cfg['postTimeoutS']


def wanted(key, prefix, cfg):
    """True when the hand-off `key` is this run's and belongs to a job this config reports."""
    member = member_of(key, prefix)
    return member is not None and any(f'{member}.'.startswith(p) for item in items(cfg) for p in item['members'])


def run_of(env):
    return f"{env['GITHUB_RUN_ID']}-{env['GITHUB_RUN_ATTEMPT']}"


def run_prefix(cfg, env):
    return f"{cfg['prefix']}{run_of(env)}-"


def member_of(key, prefix):
    """`<stem>.<job>` of a hand-off key, or None when the key is not this run's."""
    if not key.startswith(prefix):
        return None
    rest = key[len(prefix):]
    head, _, index = rest.rpartition('.')
    return head if head and index.isdigit() else None


def run_member_of(key, cfg, env):
    """`<stem>.<job>` of a hand-off key of THIS run, of this attempt or an EARLIER one; None for any other run
    and for a later attempt. ⏱ 2026-10-13 (transient-reads-retry): re-running only a failed report job starts
    attempt N+1 but reuses the bundle the attempt-N collect job handed over, whose keys name attempt N, and the
    send refused its own run's hand-off (run 38267174747 attempt 2: `nikatru-detail-38267174747-1-codeql.analyze.0
    is not a hand-off of this run and attempt`). Each hand-off stays sealed to its OWN key, attempt included."""
    m = re.match(r'^' + re.escape(f"{cfg['prefix']}{env['GITHUB_RUN_ID']}-") + r'([1-9][0-9]{0,5})-', key)
    if m is None or int(m.group(1)) > int(env['GITHUB_RUN_ATTEMPT']):
        return None
    return member_of(key, m.group(0))


def tail_bytes(text, cap):
    raw = text.encode('utf-8')
    if len(raw) <= cap:
        return text
    note = '(earlier detail cut to fit the report)\n'
    cut = raw[len(raw) - (cap - len(note.encode('utf-8'))):].decode('utf-8', errors='ignore')
    nl = cut.find('\n')
    if 0 <= nl < len(cut) - 1:
        cut = cut[nl + 1:]
    return note + cut


# ⏱ 2026-10-12 · red-detail-failures-first: a red test step's detail lost every failing test's name. The
# quiet-step wrapper kept the output's tail, and the hand-off's 16 KiB cut here kept only the END of that, so
# PR #429's ten failures (run 38262466034) reached the private pull request as a hundred passing lines. The
# wrapper (its detailSection, in tooling/ci) now writes a red step's failing tests and counts ABOVE an
# OUTPUT_TAIL_MARK line; a cut keeps every section's header and that head, and cuts the section's tail.
OUTPUT_TAIL_MARK = '#### output tail'
# The head never takes more than this share of its section's bytes, so the output's last lines survive too.
HEAD_SHARE = 0.75


def head_bytes(text, cap):
    """The first `cap` bytes of `text`, cut back to a whole line and saying so."""
    raw = text.encode('utf-8')
    if len(raw) <= cap:
        return text
    note = '(later lines cut to fit the report)\n'
    cut = raw[:max(0, cap - len(note.encode('utf-8')))].decode('utf-8', errors='ignore')
    nl = cut.rfind('\n')
    return (cut[:nl + 1] if nl >= 0 else '') + note


# ⏱ 2026-10-12 · review of #447, finding 6: under this many bytes a section's share cannot hold its failures
# block AND a useful tail (sixteen or more red sections in one 16 KiB hand-off), so fit_small keeps the two
# lines that matter, the section's header and its first failing test, and only then any tail that still fits.
SECTION_FLOOR = 1024
SMALL_TAIL_MIN = 256


# ⏱ 2026-11-11 · fix1110b #1/#2/#4 (row O-RED-DETAIL-COMPLETE). The quiet-step wrapper marks each finding line of a red
# section FINDING_MARK (`» L<n>: …`) and names the step's full log on a `full log: ` line (RED_LOG_LINE). A cut keeps
# them before anything else of the section: a small share keeps the header, the full-log line, the first failing test
# and as many finding lines as fit, the rest counted — so no red job loses its failing line or its log to a size cut.
FINDING_MARK = '» '
# fix1110b round 2: the quiet-step wrapper's no-match fallback (its last output line). Kept by a cut like a finding line,
# but NOT a finding: has_detail never counts it.
LAST_LINE_MARK = '(last line) '
RED_LOG_LINE = 'full log: '


def _must_keep(lines):
    """The lines of a section no cut may lose: the `### ` header, the full-log line(s), the first `✖ ` failing test and
    the first `» ` finding line."""
    keep = lines[:1] if lines and lines[0].startswith('### ') else []
    keep += [line for line in lines if line.startswith(RED_LOG_LINE)][:2]
    keep += [line for line in lines if line.startswith('✖ ')][:1]
    keep += [line for line in lines if line.startswith(FINDING_MARK)][:1]
    return keep


def _priority(lines, room):
    """`lines`' header, full-log line(s), `✖ ` failing tests and `» ` finding lines, in that order, as many as fit in
    `room` bytes; the lines that do not fit are counted, never dropped silently. b'' when there are none."""
    order = (lines[:1] if lines and lines[0].startswith('### ') else []) + [line for line in lines if line.startswith(RED_LOG_LINE)][:2]
    order += [line for line in lines if line.startswith('✖ ')] + [line for line in lines if line.startswith((FINDING_MARK, LAST_LINE_MARK))]
    if not order:
        return b''
    room -= 64
    raw, dropped = b'', 0
    for line in order:
        b = (line + '\n').encode('utf-8')
        if len(raw) + len(b) <= room:
            raw += b
        elif not raw:
            raw = b[:max(0, room - 1)] + b'\n'
        else:
            dropped += 1
    if dropped:
        raw += f'({dropped} more failing or finding line(s) in the full log)\n'.encode('utf-8')
    return raw


def fit_small(text, cap):
    """A section in a share under SECTION_FLOOR: its `### ` header, its full-log line, its `✖ ` failing tests and its
    `» ` finding lines (as many as fit, the rest counted), then the end of its output if SMALL_TAIL_MIN bytes are left.
    A section with none of them keeps its tail, as before."""
    lines = lines_of(text)
    note = '(cut to fit the report)\n'
    raw = _priority(lines, cap - len(note.encode('utf-8')))
    if not raw:
        return tail_bytes(text, cap)
    head = raw.decode('utf-8', errors='ignore') + note
    left = cap - len(head.encode('utf-8'))
    mark = text.find('\n' + OUTPUT_TAIL_MARK + '\n')
    rest = text[mark + len(OUTPUT_TAIL_MARK) + 2:] if mark >= 0 else '\n'.join(lines[1:])
    return head + (tail_bytes(rest, left) if left >= SMALL_TAIL_MIN else '')


def fit_section(text, cap):
    """One `### ` section within `cap` bytes: its header line and the part above OUTPUT_TAIL_MARK kept first,
    the rest (the output's tail) cut from its start."""
    if len(text.encode('utf-8')) <= cap:
        return text
    if cap < SECTION_FLOOR:
        return fit_small(text, cap)
    mark = text.find('\n' + OUTPUT_TAIL_MARK + '\n')
    if mark >= 0:
        cut = mark + len(OUTPUT_TAIL_MARK) + 2
    elif text.startswith('### ') and '\n' in text:
        cut = text.index('\n') + 1
    else:
        return tail_bytes(text, cap)
    head, rest = text[:cut], text[cut:]
    head_cap = int(cap * HEAD_SHARE)
    if len(head.encode('utf-8')) > head_cap:
        room = head_cap - len(OUTPUT_TAIL_MARK) - 1
        cut = head_bytes(head, room)
        # fix1110b #4: a head cut from its end loses the full-log line (last above the tail) and any finding line past
        # the cut; when it would lose one, the head is its must-keep lines instead, the rest counted.
        if any(line not in lines_of(cut) for line in _must_keep(lines_of(head))):
            cut = (_priority(lines_of(head), room) or cut.encode('utf-8')).decode('utf-8', errors='ignore')
        head = cut + OUTPUT_TAIL_MARK + '\n'
    return head + tail_bytes(rest, cap - len(head.encode('utf-8')))


def fit_bytes(text, cap):
    """`text` within `cap` bytes, cut section by section (a section starts at a `### RED ` or `### NOTE ` line,
    the two headers the quiet-step wrapper writes; ⏱ 2026-10-12 · review of #447, finding 8: any other `### `
    line is the step's own output, inside its section's tail): a section
    smaller than its fair share is kept whole and leaves the rest to the larger ones, each cut by fit_section."""
    if len(text.encode('utf-8')) <= cap:
        return text
    parts = [p for p in re.split(r'(?m)^(?=### (?:RED|NOTE) )', text) if p]
    sizes = [len(p.encode('utf-8')) for p in parts]
    shares, left = [0] * len(parts), cap
    for k, i in enumerate(sorted(range(len(parts)), key=sizes.__getitem__)):
        shares[i] = min(sizes[i], left // (len(parts) - k))
        left -= shares[i]
    return ''.join(fit_section(p, n) for p, n in zip(parts, shares))


def join_detail(sections, cap=DETAIL_MAX_BYTES):
    """Sections joined; over the cap, each keeps an equal share, cut by fit_bytes (failures before tail)."""
    sections = [s for s in sections if s.strip()]
    if not sections:
        return ''
    whole = '\n'.join(sections)
    if len(whole.encode('utf-8')) <= cap:
        return whole
    share = cap // len(sections) - 1
    return '\n'.join(fit_bytes(s, share) for s in sections)


def signature(secret, raw):
    return 'sha256=' + hmac.new(secret.encode('utf-8'), raw, hashlib.sha256).hexdigest()


# ── the sealed bundle ────────────────────────────────────────────────────────

class Refused(ValueError):
    """A detail bundle that is not this run's well-formed, sealed plain data."""


def _seal_keys(key):
    k = key.encode('utf-8')
    return (hmac.new(k, b'nikatru-detail/enc', hashlib.sha256).digest(),
            hmac.new(k, b'nikatru-detail/mac', hashlib.sha256).digest())


def _keystream_xor(enc, nonce, data):
    blocks = (len(data) + 31) // 32
    stream = b''.join(hmac.new(enc, nonce + i.to_bytes(8, 'big'), hashlib.sha256).digest() for i in range(blocks))
    if not data:
        return b''
    return (int.from_bytes(data, 'big') ^ int.from_bytes(stream[:len(data)], 'big')).to_bytes(len(data), 'big')


def _tag(mac, run, nonce, ct):
    return hmac.new(mac, run.encode('utf-8') + b'\0' + SEAL_VERSION + nonce + ct, hashlib.sha256).digest()


def seal(key, run, plain, nonce=None):
    """base64(version · nonce · ciphertext · tag), bound to `run` (`<run_id>-<attempt>`)."""
    enc, mac = _seal_keys(key)
    nonce = nonce or os.urandom(NONCE_BYTES)
    ct = _keystream_xor(enc, nonce, plain)
    return base64.b64encode(SEAL_VERSION + nonce + ct + _tag(mac, run, nonce, ct)).decode('ascii')


def unseal(key, run, sealed):
    if len(sealed) > SEALED_MAX_CHARS:
        raise Refused(f'{len(sealed)} characters, over the {SEALED_MAX_CHARS} cap')
    try:
        raw = base64.b64decode(sealed, validate=True)
    except ValueError:
        raise Refused('not base64')
    if len(raw) < 1 + NONCE_BYTES + TAG_BYTES or raw[:1] != SEAL_VERSION:
        raise Refused('not a sealed bundle of this version')
    enc, mac = _seal_keys(key)
    nonce, ct, tag = raw[1:1 + NONCE_BYTES], raw[1 + NONCE_BYTES:-TAG_BYTES], raw[-TAG_BYTES:]
    if not hmac.compare_digest(tag, _tag(mac, run, nonce, ct)):
        raise Refused("its tag does not verify (another key, another run, or altered)")
    return _keystream_xor(enc, nonce, ct)


def run_key(master, run):
    """The key ONE run attempt's hand-offs are sealed with: HMAC-SHA256 of the run under the master
    NIKATRU_DETAIL_KEY, as hex (A7-05, system review 2026-10-08). A quiet job derives it in its staging
    step, before any private code runs, and its hand-off seals with it alone: the pull-request code a
    quiet job runs can read at most its OWN run attempt's detail, never another run's sealed cache entry
    (every shell run shares main's cache scope)."""
    return hmac.new(master.encode('utf-8'), b'nikatru-detail/run\0' + run.encode('utf-8'), hashlib.sha256).hexdigest()


def run_handoff_key(master, run_id):
    """The key ONE run's sealed artifact hand-offs (tooling/ci/shell-handoff.mjs seal/unseal) use: HMAC-SHA256 of
    the run id under the master NIKATRU_DETAIL_KEY, as hex. ⏱ 2026-10-16 · PR #690 review finding 3 (open item m7):
    a quiet job's seal and unseal read it from NIKATRU_HANDOFF_KEY_FILE and never hold the master. By run id, not
    attempt: a re-run job restores an earlier attempt's hand-off. shell-handoff.mjs handoffRunKey is the same
    function (test/shell-handoff.test.mjs pins the two equal)."""
    if not re.match(r'^[1-9][0-9]{0,19}$', run_id or ''):
        raise Lost(f'GITHUB_RUN_ID is not a run id ({run_id!r})')
    return hmac.new(master.encode('utf-8'), b'nikatru-handoff/run\0' + run_id.encode('utf-8'), hashlib.sha256).hexdigest()


# ⏱ 2026-10-31 · O-CODEQL-BASELINE-SEALED (ci-gates-02, built by cross-g2). Every shell run shares main's cache scope, so
# a pull request's code could SAVE an entry under `codeql-main-baseline-<sha>` that a later pull request restores as
# main's debt. The baseline is SEALED on a main run (`baseline-seal <dir>`) and VERIFIED after a restore
# (`baseline-verify <dir>`), under a key only the shell holds: HKDF-SHA256 (RFC 5869) of the master NIKATRU_DETAIL_KEY
# with info 'nikatru-codeql-baseline', and tag = HMAC-SHA256(key, <cache key> NUL <baseline.json bytes>). A baseline
# that fails is DELETED, so the grade is strict (fail-closed), and one that passes is marked: baseline.verified holds
# the sha256 of the bytes verified, which codeql-sarif-report.mjs --baseline-verified requires.
BASELINE_INFO = b'nikatru-codeql-baseline'
BASELINE_SEAL_VERSION = 1
# ⏱ 2026-11-02 · PR #1229 lead runner review RS1. The verify step runs right AFTER the restore of a cache a pull
# request's run can save, and actions/cache extracts with `tar -P`: an archive saved under main's key can overwrite this
# staged file before the verify runs it. So the verify (and the seal) never hold the master: the staging step, before
# any restore, derives the baseline key alone (`derive` with NIKATRU_BASELINE_KEY_FILE) and these two verbs read only
# that file. A leak of it can forge a baseline (the grade then believes a debt list it should not), never a hand-off key,
# a deploy key or the master; the generated step right after the verify deletes the file.
BASELINE_KEY_FILE_VAR = 'NIKATRU_BASELINE_KEY_FILE'


def hkdf_key(master, info):
    """HKDF-SHA256 (RFC 5869, zero salt, one block) of the master under `info`, as bytes."""
    if not master:
        raise Lost('no master key: no derived key can be made')
    prk = hmac.new(b'\0' * 32, master.encode('utf-8'), hashlib.sha256).digest()
    return hmac.new(prk, info + b'\x01', hashlib.sha256).digest()


def baseline_key(master):
    """HKDF-SHA256 (RFC 5869, zero salt, one block) of the master under BASELINE_INFO, as bytes."""
    if not master:
        raise Lost('no master key: the baseline key cannot be derived')
    return hkdf_key(master, BASELINE_INFO)


# ⏱ 2026-11-02 · independent review at a60129f9, F2 (MAJOR). ops-watch.yml's store-vitals state rides a cache any pull
# request's run can save under `store-vitals-*`, and an all-red planted state silenced the monitor (a real red never
# reads as worsened). The store-vitals job seals state.json and the job's intake verifies it
# (tooling/ops/vitals/state-intake.mjs), under HKDF(master, VITALS_INFO), which the staging step writes to
# NIKATRU_VITALS_KEY_FILE — the master itself is never in a step that reads the handed-over state.
VITALS_INFO = b'nikatru-store-vitals-state'
VITALS_KEY_FILE_VAR = 'NIKATRU_VITALS_KEY_FILE'


def derived_baseline_key(env):
    """The baseline key the staging step wrote to NIKATRU_BASELINE_KEY_FILE (64 hex), as bytes. Never the master: a
    verify or seal step that is handed NIKATRU_DETAIL_KEY is refused, so a generator that regressed to binding the
    master after the restore fails loudly instead of working."""
    if env.get('NIKATRU_DETAIL_KEY', ''):
        raise Lost('NIKATRU_DETAIL_KEY is bound to a baseline step: it runs after a restore a pull request can write, and holds the derived baseline key only')
    path = env.get(BASELINE_KEY_FILE_VAR, '')
    if not path:
        raise Lost(f'no baseline key ({BASELINE_KEY_FILE_VAR} is not set)')
    try:
        with open(path, encoding='ascii') as f:
            raw = f.read().strip()
    except OSError:
        raise Lost(f'no baseline key (the staging step wrote none to {BASELINE_KEY_FILE_VAR})') from None
    if not re.match(r'^[0-9a-f]{64}$', raw):
        raise Lost(f'no baseline key ({BASELINE_KEY_FILE_VAR} does not hold 64 hex)')
    return bytes.fromhex(raw)


def baseline_tag(key, cache_key, data):
    if not re.match(r'^codeql-main-baseline-[0-9a-f]{40}$', cache_key or ''):
        raise Lost(f'{cache_key!r} is not a codeql-main-baseline-<40-hex> cache key')
    return hmac.new(key, cache_key.encode('utf-8') + b'\0' + data, hashlib.sha256).hexdigest()


def baseline_seal(env, d):
    """A main run: seal <d>/baseline.json under its cache key (NIKATRU_BASELINE_CACHE_KEY) into <d>/baseline.seal."""
    with open(os.path.join(d, 'baseline.json'), 'rb') as f:
        data = f.read()
    cache_key = env.get('NIKATRU_BASELINE_CACHE_KEY', '')
    tag = baseline_tag(derived_baseline_key(env), cache_key, data)
    with open(os.path.join(d, 'baseline.seal'), 'w', encoding='ascii') as f:
        json.dump({'version': BASELINE_SEAL_VERSION, 'key': cache_key, 'tag': tag}, f)
    print(f'ok baseline sealed under {cache_key}')
    return 0


def baseline_verify(env, d):
    """After a restore: keep <d>/baseline.json only when its seal verifies for the restore's matched key
    (NIKATRU_BASELINE_MATCHED_KEY), and mark it (<d>/baseline.verified = sha256 of the bytes). Anything else — no seal,
    a seal for another key, a tag that does not match, no baseline key (or the master bound here) — DELETES it: the grade is then strict. Exit 0 either
    way (a missing baseline is a strict grade, not a red step); 2 only when the reporter itself cannot run."""
    path = os.path.join(d, 'baseline.json')
    for stale in ('baseline.verified',):
        try:
            os.remove(os.path.join(d, stale))
        except FileNotFoundError:
            pass
    if not os.path.exists(path):
        print('baseline: none restored (the grade is strict)')
        return 0
    why = None
    try:
        with open(path, 'rb') as f:
            data = f.read()
        with open(os.path.join(d, 'baseline.seal'), encoding='ascii') as f:
            seal = json.load(f)
        matched = env.get('NIKATRU_BASELINE_MATCHED_KEY', '')
        if not isinstance(seal, dict) or seal.get('version') != BASELINE_SEAL_VERSION:
            why = 'the seal is not a version-1 baseline seal'
        elif seal.get('key') != matched:
            why = f"the seal names {seal.get('key')!r}, the restore matched {matched!r}"
        elif not hmac.compare_digest(str(seal.get('tag', '')), baseline_tag(derived_baseline_key(env), matched, data)):
            why = 'the tag does not match: these bytes were not sealed by a main run'
    except FileNotFoundError:
        why = 'it carries no seal'
    except (ValueError, Lost) as e:
        why = f'it cannot be verified ({e})'
    if why:
        for name in ('baseline.json', 'baseline.seal'):
            try:
                os.remove(os.path.join(d, name))
            except FileNotFoundError:
                pass
        print(f'::warning title=CodeQL baseline refused::the restored baseline was deleted — {why}; the grade is strict (fail-closed)')
        return 0
    with open(os.path.join(d, 'baseline.verified'), 'w', encoding='ascii') as f:
        f.write(hashlib.sha256(data).hexdigest())
    print(f'ok baseline verified for {matched}')
    return 0


# ⏱ 2026-11-02 · O-CODEQL-BASELINE-SEALED (rows-club-ci-shell). The restore-keys of a pull request's baseline restore,
# read with git ALONE by the shell's staged copy of this file, before any private code runs: the source workflow's key
# list (codeql-sarif-report.mjs --emit-baseline-keys) is the pull request's own code, and a step that holds the master
# (baseline-verify, right after the restore) must follow no step the pull request wrote. Byte for byte the rule of
# codeql-sarif-report.mjs mainCommits + baselineRestoreKeys: HEAD^1 of the merge checkout and its first parents,
# nearest first, BASELINE_ANCESTORS of them; never the base sha's own key (it is the restore's `key`); at most
# MAX_RESTORE_KEYS (actions/cache takes ten keys counting the primary).
BASELINE_KEY_PREFIX = 'codeql-main-baseline-'
BASELINE_ANCESTORS = 10
MAX_RESTORE_KEYS = 9
SHA40 = re.compile(r'^[0-9a-f]{40}$')


def baseline_main_commits(run=subprocess.run):
    """The first-parent main commits of a pull request's merge checkout, newest first ([] when HEAD is not a two-parent
    merge commit or the history is not there)."""
    try:
        p = run(['git', 'rev-list', '--parents', '-n', '1', 'HEAD'], capture_output=True, text=True, timeout=60)
        if p.returncode != 0 or len(p.stdout.split()) != 3:
            return []
        r = run(['git', 'rev-list', '--first-parent', f'--max-count={BASELINE_ANCESTORS}', 'HEAD^1'], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return []
    if r.returncode != 0:
        return []
    return [l.strip() for l in r.stdout.splitlines() if SHA40.match(l.strip())]


def baseline_keys(env, run=subprocess.run):
    """`baseline-keys`: the restore-keys, to $GITHUB_OUTPUT as the multi-line output `keys`. Never fails the step: no main
    history is no fallback key (the restore then reads the base sha's exact key alone), and is said."""
    base = env.get('NIKATRU_BASE_SHA', '').strip()
    keys = [BASELINE_KEY_PREFIX + c for c in baseline_main_commits(run) if c != base][:MAX_RESTORE_KEYS]
    print(f"baseline-keys: {len(keys)} main commit(s) a baseline may be restored from, nearest first"
          + ('' if keys else " (no merge commit or no history here: the base sha's exact key only)"))
    out = env.get('GITHUB_OUTPUT', '')
    if out:
        with open(out, 'a', encoding='utf-8') as f:
            f.write('keys<<NIKATRU_BASELINE_KEYS\n' + ''.join(k + '\n' for k in keys) + 'NIKATRU_BASELINE_KEYS\n')
    return 0


def _write_key(path, key):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='ascii') as f:
        f.write(key)


def derive(env):
    """A quiet job's staging step: this run attempt's red-detail hand-off key, written to NIKATRU_DETAIL_KEY_FILE,
    and/or this run's artifact hand-off key (run_handoff_key), written to NIKATRU_HANDOFF_KEY_FILE, and/or the CodeQL
    baseline key (baseline_key), written to NIKATRU_BASELINE_KEY_FILE, and/or the store-vitals state key
    (VITALS_INFO), written to NIKATRU_VITALS_KEY_FILE — each 0600 and masked. With no master key (a run that gets no secrets) it writes nothing: a red detail is then not handed
    over and a seal refuses, exactly as a hand-off without a key never was."""
    out = env.get('NIKATRU_DETAIL_KEY_FILE', '')
    handoff_out = env.get('NIKATRU_HANDOFF_KEY_FILE', '')
    baseline_out = env.get(BASELINE_KEY_FILE_VAR, '')
    vitals_out = env.get(VITALS_KEY_FILE_VAR, '')
    if not out and not handoff_out and not baseline_out and not vitals_out:
        raise Lost(f'none of NIKATRU_DETAIL_KEY_FILE, NIKATRU_HANDOFF_KEY_FILE, {BASELINE_KEY_FILE_VAR}, {VITALS_KEY_FILE_VAR} is set: nowhere to put a run key')
    master = env.get('NIKATRU_DETAIL_KEY', '')
    if not master:
        print('-- derive: NIKATRU_DETAIL_KEY is not set; this job hands nothing over')
        return 0
    if out:
        key = run_key(master, run_of(env))
        print(f'::add-mask::{key}')
        _write_key(out, key)
        print(f'ok derive: the hand-off key of run attempt {run_of(env)}')
    if handoff_out:
        key = run_handoff_key(master, env.get('GITHUB_RUN_ID', ''))
        print(f'::add-mask::{key}')
        _write_key(handoff_out, key)
        print(f'ok derive: the artifact hand-off key of run {env.get("GITHUB_RUN_ID", "")}')
    if baseline_out:
        key = baseline_key(master).hex()
        print(f'::add-mask::{key}')
        _write_key(baseline_out, key)
        print('ok derive: the CodeQL baseline key')
    if vitals_out:
        key = hkdf_key(master, VITALS_INFO).hex()
        print(f'::add-mask::{key}')
        _write_key(vitals_out, key)
        print('ok derive: the store-vitals state key')
    return 0


def handoff_key(env):
    """(key, derived): the run key the staging step wrote to NIKATRU_DETAIL_KEY_FILE. A shell generated before
    the staging step existed names no such file and hands this step NIKATRU_DETAIL_KEY itself, as it always
    did; its own report job unseals with that key, so the pair keeps working until the shell is re-synced."""
    path = env.get('NIKATRU_DETAIL_KEY_FILE', '')
    if path:
        try:
            with open(path, encoding='ascii') as f:
                return f.read().strip(), True
        except OSError:
            return '', True
    return env.get('NIKATRU_DETAIL_KEY', ''), False


def handoff_key_ok(name, env):
    """True when `name` is a hand-off cache key of this run+attempt: `nikatru-detail-<run>-<attempt>-<member>.<n>`."""
    return bool(re.match(r'^[A-Za-z0-9._-]{1,400}$', name)) and member_of(name, f'{HANDOFF_PREFIX}{run_of(env)}-') is not None


# ── handoff ──────────────────────────────────────────────────────────────────

# ⏱ 2026-11-11 · fix1110b #2. The quiet-step wrapper leaves each red step's whole output in RED_LOG_DIR and names it
# on a pending line; the job's red-log step (tooling/ops/bridge-artifact.mjs red-logs) stores it and leaves a receipt.
# The hand-off turns each pending line into where the log IS, so the private detail links every red step's full log.
RED_LOG_DIR = 'nikatru-red-logs'
RED_LOG_PENDING = re.compile(r'(?m)^full log: pending upload \(red-log ([A-Za-z0-9][A-Za-z0-9._()-]{0,120}\.log)\)$')
RED_LOG_STORED = 'full log: stored '
STORED_KEY = re.compile(r'^[1-9][0-9]{0,19}/[1-9][0-9]{0,4}/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$')
RED_LOG_READER = 'node tooling/ops/read-red-log.mjs'
# ⏱ 2026-11-11 · fix1110b round 3 (lead DECISION 10:46Z, option C). No red-log upload step is wired in this club: a
# PR-run job may hold no bridge key (A7-05, opsOffPr, assert-public-shell limb M), and the trusted report job uploads
# the handed-off logs after #1350 (row O-ACTIONS-RED-TRIAGE). A log with NO receipt (no upload step ran) says so on this
# line, and send reports it as a NOTE, never a red. A receipt that says refused or lost (an upload that ran and
# failed) stays `full log: NOT stored (…)`, which is red (LOG NOT STORED).
RED_LOG_NOT_WIRED = 'full log: not stored: upload not wired yet (row O-RED-DETAIL-COMPLETE part 2)'


def red_log_lines(text, env):
    """`text` with each pending full-log line turned into the receipt's answer: stored (its key and how to read it)
    or NOT stored (why). A log with no receipt is said so: the job ran no red-log upload."""
    folder = os.path.join(env.get('RUNNER_TEMP', ''), RED_LOG_DIR)
    member = member_of(env.get('NIKATRU_HANDOFF', ''), f'{HANDOFF_PREFIX}{run_of(env)}-') or env.get('GITHUB_JOB', '')

    def one(m):
        try:
            with open(os.path.join(folder, m.group(1) + '.receipt.json'), encoding='utf-8') as f:
                r = json.load(f)
        except (OSError, ValueError):
            return f'{RED_LOG_NOT_WIRED}: {m.group(1)} stayed on the runner'
        key = r.get('stored') if isinstance(r, dict) else None
        if isinstance(key, str) and STORED_KEY.match(key):
            return (f"{RED_LOG_STORED}{key} · read it: {RED_LOG_READER} {env.get('GITHUB_RUN_ID', '')} {member}"
                    " (its signed link is in the bridge's artifact comment)")
        why = str((r.get('refused') or r.get('lost') or 'no answer') if isinstance(r, dict) else 'an unreadable receipt')
        return f'full log: NOT stored ({m.group(1)}: {why[:200]})'
    return RED_LOG_PENDING.sub(one, text)


def core_of(text, cap=CORE_MAX_BYTES):
    """fix1110b #4: each `### RED`/`### NOTE` section's must-keep lines (_priority) within `cap`, or '' when none has any."""
    parts = [p for p in re.split(r'(?m)^(?=### (?:RED|NOTE) )', text) if p.startswith('### ')]
    if not parts:
        return ''
    share = cap // len(parts)
    out = ''.join(_priority(lines_of(p), share).decode('utf-8', errors='ignore') for p in parts)
    if not out.strip():
        return ''
    out += '(output tail not carried: this run\'s red detail was over what the report can carry; the full log has it)\n'
    return out if len(out.encode('utf-8')) <= cap + 256 else head_bytes(out, cap)


def handoff(env):
    """Seal this job's red detail for the cache: plain text never reaches actions/cache/save."""
    try:
        # fix1110b round 5: newline='' — a lone CR stays a character, never a line break the wrapper did not see.
        with open(os.path.join(env.get('RUNNER_TEMP', ''), DETAIL_FILE), encoding='utf-8', errors='replace', newline='') as f:
            text = f.read()
    except OSError:
        text = ''
    if not text.strip():
        print('-- handoff: no red detail to hand over')
        return 0
    name = env.get('NIKATRU_HANDOFF', '')
    if not handoff_key_ok(name, env):
        raise Lost(f'NIKATRU_HANDOFF {name[:100]!r} is not a hand-off key of this run and attempt: nothing handed over')
    text = red_log_lines(text, env)
    key, derived = handoff_key(env)
    if not key:
        raise Lost(('the run key the staging step derives is absent' if derived else 'NIKATRU_DETAIL_KEY is not set')
                   + ': the red detail is NOT handed over (it is never cached in plain text)')
    plain = fit_bytes(text, HANDOFF_MAX_BYTES).encode('utf-8')
    os.makedirs(DETAIL_DIR, exist_ok=True)
    with open(os.path.join(DETAIL_DIR, SEALED_FILE), 'w', encoding='ascii') as f:
        f.write(seal(key, name, plain))
    core = core_of(text)
    if core:
        with open(os.path.join(DETAIL_DIR, CORE_FILE), 'w', encoding='ascii') as f:
            f.write(seal(key, name + CORE_SUFFIX, core.encode('utf-8')))
    with open(env['GITHUB_OUTPUT'], 'a', encoding='utf-8') as f:
        f.write('has=true\n')
    print(f'ok handoff: {len(plain)} byte(s) of red detail sealed for {name}')
    return 0


# ── plan ─────────────────────────────────────────────────────────────────────

def list_keys(env, prefix):
    api = env.get('GITHUB_API_URL', 'https://api.github.com').rstrip('/')
    repo = env['GITHUB_REPOSITORY']
    keys = []
    for page in range(1, 6):
        q = urllib.parse.urlencode({'key': prefix, 'per_page': 100, 'page': page})
        req = urllib.request.Request(f'{api}/repos/{repo}/actions/caches?{q}', headers={
            'authorization': f"Bearer {env.get('GH_TOKEN', '')}",
            'accept': 'application/vnd.github+json',
        })
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.load(r)
        got = [c['key'] for c in body.get('actions_caches', []) if c.get('key', '').startswith(prefix)]
        keys.extend(got)
        if len(body.get('actions_caches', [])) < 100:
            break
    return sorted(set(keys))


def plan(env, cfg):
    prefix = run_prefix(cfg, env)
    slots = int(cfg['slots'])
    try:
        keys = [k for k in list_keys(env, prefix) if wanted(k, prefix, cfg)]
    except (urllib.error.URLError, OSError, ValueError, KeyError) as e:
        # The statuses still go out (send runs `if: always()`); only the detail is lost, and said.
        with open(env['GITHUB_OUTPUT'], 'a', encoding='utf-8') as f:
            f.write('\n'.join(f'key_{i}=' for i in range(slots)) + '\noverflow=\n')
        print(f'x plan: the hand-offs could not be listed ({str(e)[:160]}); the reports go out without detail')
        return 1
    lines = [f'key_{i}={keys[i] if i < len(keys) else ""}' for i in range(slots)]
    lines.append('overflow=' + ','.join(keys[slots:]))
    with open(env['GITHUB_OUTPUT'], 'a', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print(f'ok plan: {len(keys)} red job detail(s) handed over'
          + (f'; {len(keys) - slots} beyond the {slots} restore slot(s)' if len(keys) > slots else ''))
    return 0


# ── place ────────────────────────────────────────────────────────────────────

def place(key):
    src = os.path.join(DETAIL_DIR, SEALED_FILE)
    if not re.match(r'^[A-Za-z0-9._-]+$', key) or not os.path.isfile(src):
        print(f'x place: no restored detail for {key!r}')
        return 1
    os.makedirs(COLLECTED_DIR, exist_ok=True)
    shutil.move(src, os.path.join(COLLECTED_DIR, f'{key}.sealed'))
    core = os.path.join(DETAIL_DIR, CORE_FILE)
    if os.path.isfile(core):
        shutil.move(core, os.path.join(COLLECTED_DIR, f'{key}{CORE_SUFFIX}.sealed'))
    shutil.rmtree(DETAIL_DIR, ignore_errors=True)
    print(f'ok place: {key}')
    return 0


# ── collect ──────────────────────────────────────────────────────────────────

def collected(prefix, cores=False):
    """{key: sealed text} of this run+attempt's hand-offs in .nikatru-collected/, in key order (with `cores`, their
    fix1110b #4 cores instead). Carried as they are: this job holds no key, so it can neither read nor reseal them."""
    out = {}
    if not os.path.isdir(COLLECTED_DIR):
        return out
    tail = CORE_SUFFIX + '.sealed' if cores else '.sealed'
    for name in sorted(os.listdir(COLLECTED_DIR)):
        key = name[:-len(tail)] if name.endswith(tail) else None
        if key is None or member_of(key, prefix) is None:
            continue
        with open(os.path.join(COLLECTED_DIR, name), encoding='ascii', errors='replace') as f:
            out[key] = f.read().strip()
    return out


def detail_for(members, details):
    # A member is `<workflow>.<job>`; a lane's prefixes end in `.` (`ci.guard-tests.` or a
    # whole called workflow, `lane-workers.`), so `ci.guard-tests` never takes `ci.guard-tests-floor`.
    return join_detail([t for m, texts in details.items() if any(f'{m}.'.startswith(p) for p in members) for t in texts])


def notes_of(detail):
    """The `### NOTE <step>` sections of a detail (the quiet-step wrapper's noteSection): what a step
    said to the private pull request on purpose, green or red."""
    return sections_of(detail, NOTE_HEADER)


def sections_of(detail, header):
    """The sections of a detail whose `### ` line starts with `header`, joined."""
    out, keep = [], False
    for line in lines_of(detail):
        if line.startswith('### '):
            keep = line.startswith(header)
        if keep:
            out.append(line)
    return '\n'.join(out).strip('\n')


def held(item, cfg, results, detail, lost):
    """True when the gate's failure is a HOLD and nothing else (see the header): its detail carries a HOLD section
    and no RED section, the bundle was read, and every lane of the config reported success."""
    if not is_gate(item, cfg) or lost or not sections_of(detail, HOLD_HEADER) or sections_of(detail, RED_HEADER):
        return False
    return all(results.get(lane['job']) == 'success' for lane in cfg['lanes'])


def cleared(item, cfg, env, detail):
    """⏱ 2026-10-24 · ci-gate-hold-not-red: False when a gate whose job succeeded may not be posted success: a
    pull request's gate in a config whose gate reads the PR (`gateMeta`), without pr-meta's POSITIVE clear
    (NIKATRU_GATE_META == GATE_CLEAR), or with a HOLD section in its detail all the same. True for everything else."""
    if not is_gate(item, cfg) or cfg.get('gateMeta') is not True or env.get('NIKATRU_P_EVENT', '') != 'pull_request':
        return True
    return env.get('NIKATRU_GATE_META', '') == GATE_CLEAR and not sections_of(detail, HOLD_HEADER)


def summary_of(text, env):
    """A status summary within SUMMARY_MAX_CHARS, ending TIER_LIGHT_SUFFIX on a light run (the text trimmed first)."""
    suffix = TIER_LIGHT_SUFFIX if env.get(TIER_ENV, '') == TIER_LIGHT else ''
    return text[:SUMMARY_MAX_CHARS - len(suffix)] + suffix


def build(context, state, env, detail, gate=False):
    run_id, attempt = int(env['GITHUB_RUN_ID']), int(env['GITHUB_RUN_ATTEMPT'])
    body = {
        'run_id': run_id,
        'run_attempt': attempt,
        'sha': env['NIKATRU_HEAD_SHA'],
        'context': context,
        'state': state,
        'summary': summary_of(f'{context}: {state} (public run {run_id}, attempt {attempt})', env),
    }
    if state == 'pending':
        # A HOLD: the summary says what it waits on (the bridge writes a pending status only, no comment).
        hold = sections_of(detail, HOLD_HEADER).split('\n')
        body['summary'] = summary_of(f'{context}: pending, waits on {hold[0][len(HOLD_HEADER):].strip()} (public run {run_id})', env)
    elif state in ('failure', 'error') and detail.strip():
        body['detail'] = fit_bytes(detail, DETAIL_MAX_BYTES)
    elif state == 'success' and gate and notes_of(detail):
        # ⏱ 2026-10-08 · gitleaks-pr-scoped-r2: a GREEN gate carries its NOTE sections, and only those.
        body['detail'] = fit_bytes(notes_of(detail), DETAIL_MAX_BYTES)
    return body


def post(url, secret, body, timeout, opener=urllib.request.urlopen, sleep=None, now=None, stamp=False, clock=None, jitter=None, oidc=None):
    """(status, why) of the report: a transient answer retried, RETRY_DELAYS apart (each jittered by ±RETRY_JITTER,
    `jitter` a draw in [0, 1)), no attempt starting past RETRY_WINDOW_S after the first (`clock`, monotonic seconds),
    then the last. A 429 waits RATE_DELAYS instead, unjittered (each must outlast the bridge's bucket), and only
    len(RATE_DELAYS) times. sleep/now/clock/jitter are resolved at call time, so a test's patch of the module reaches them.
    `timeout` is the config's postTimeoutS: above the bridge's whole budget for one report.
    ⏱ 2026-10-31 · O-BRIDGE-REPORT-REPLAY-WINDOW: with `stamp` (send's /report posts) every attempt carries its own
    `ts` (epoch seconds, `now`) and is signed afresh, so the bridge refuses a captured body outside its window and a replay of it (409), and a retry is
    a new body, never a replay. A 409 is the bridge saying this body was already delivered (send counts it).
    ⏱ 2026-11-09 · review52-platform-002: `oidc`, when given, is called before every attempt and its token (or None)
    goes as X-Bridge-OIDC, so the bridge binds the report to THIS job (services/gh-bridge/src/report.ts)."""
    sleep = sleep or time.sleep
    now = now or time.time
    clock = clock or time.monotonic
    jitter = jitter or random.random
    started, waited = clock(), 0.0
    for attempt in range(len(RETRY_DELAYS) + 1):
        raw = json.dumps({**body, 'ts': int(now())} if stamp else body, ensure_ascii=False).encode('utf-8')
        status, why, upstream = post_once(url, secret, raw, opener, timeout, oidc() if oidc else None)
        transient = status == 429 or (status in RETRY_STATUSES and (status != 502 or upstream is None or upstream in RETRY_UPSTREAMS))
        if not transient or attempt == len(RETRY_DELAYS) or (status == 429 and attempt >= len(RATE_DELAYS)):
            return status, why
        if status == 429:
            wait = RATE_DELAYS[attempt]
        else:
            wait = round(RETRY_DELAYS[attempt] * (1 + RETRY_JITTER * (2 * jitter() - 1)), 1)
        # Elapsed by the clock, and never less than what this post itself waited (a clock that does not move with
        # the waits cannot stretch the window).
        left = RETRY_WINDOW_S - max(clock() - started, waited)
        if left <= 0:
            return status, why
        wait = min(wait, round(left, 1))
        print(f'-- HTTP {status} is transient; retrying in {wait} s', file=sys.stderr)
        sleep(wait)
        waited += wait


def post_once(url, secret, raw, opener, timeout, token=None):
    """(status, why, upstream): `upstream` is the GitHub status a bridge 502 names, or None."""
    headers = {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        'x-bridge-signature': signature(secret, raw),
    }
    if token:
        headers['x-bridge-oidc'] = token
    req = urllib.request.Request(url, data=raw, method='POST', headers=headers)
    try:
        with opener(req, timeout=timeout) as r:
            return r.status, '', None
    except urllib.error.HTTPError as e:
        why, upstream = '', None
        try:
            answer = json.loads(e.read().decode('utf-8'))
            why = str(answer.get('error', ''))[:200]
            got = answer.get('upstream')
            upstream = got if isinstance(got, int) and not isinstance(got, bool) else None
        except (ValueError, AttributeError):
            pass
        return e.code, why, upstream
    except (urllib.error.URLError, OSError) as e:
        return 0, str(e)[:200], None


def detail_output(i):
    """The collect job's i-th detail output (0-based): `detail`, then `detail_2` .. (gen-public-shell.mjs DETAIL_OUTPUT)."""
    return 'detail' if i == 0 else f'detail_{i + 1}'


def collect(env, cfg):
    """The sealed hand-offs, carried through unchanged in up to DETAIL_OUTPUTS bundles, each within
    SEALED_MAX_CHARS; the restore slots' overflow, and a hand-off no bundle has room for, are named
    (in the first bundle), not carried."""
    prefix = run_prefix(cfg, env)
    handed = collected(prefix)
    cores = collected(prefix, cores=True)
    unrestored = [k for k in env.get('NIKATRU_OVERFLOW', '').split(',') if k and member_of(k, prefix)]
    bundles = [{'v': BUNDLE_VERSION, 'handoffs': {}, 'unrestored': unrestored}]
    fits = lambda b: len(json.dumps(b, separators=(',', ':'))) <= SEALED_MAX_CHARS - 1024

    def put(field, key, sealed):
        for b in bundles:
            b.setdefault(field, {})[key] = sealed
            if fits(b):
                return True
            del b[field][key]
        if len(bundles) < DETAIL_OUTPUTS:
            b = {'v': BUNDLE_VERSION, 'handoffs': {}, 'unrestored': [], field: {key: sealed}}
            if fits(b):
                bundles.append(b)
                return True
        return False

    # fix1110b #4: every job's core is placed FIRST (a few KiB each), then the whole details as room allows; a whole
    # detail placed retires its core, which frees room for the next. Only a job whose core does not fit is named.
    for key, sealed in cores.items():
        if key in handed:
            put('cores', key, sealed)
    for key, sealed in handed.items():
        placed = put('handoffs', key, sealed)
        if placed:
            for b in bundles:
                b.get('cores', {}).pop(key, None)
        elif any(key in b.get('cores', {}) for b in bundles):
            continue
        if not placed:
            bundles[0]['unrestored'].append(key)
            if not fits(bundles[0]):
                # The names alone overflow the first bundle: make room by naming its last carried hand-off too.
                field = 'handoffs' if bundles[0]['handoffs'] else 'cores'
                if bundles[0].get(field):
                    last = list(bundles[0][field])[-1]
                    del bundles[0][field][last]
                    bundles[0]['unrestored'].append(last)
    with open(env['GITHUB_OUTPUT'], 'a', encoding='utf-8') as f:
        f.write(detail_output(0) + '=' + (json.dumps(bundles[0], separators=(',', ':')) if handed or unrestored else '') + '\n')
        for i, b in enumerate(bundles[1:], start=1):
            f.write(detail_output(i) + '=' + json.dumps(b, separators=(',', ':')) + '\n')
    for b in bundles:
        if not b.get('cores'):
            b.pop('cores', None)
    carried = sum(len(b['handoffs']) for b in bundles)
    by_core = sum(len(b.get('cores', {})) for b in bundles)
    print(f'ok collect: {carried} sealed hand-off(s) carried in {len(bundles)} output(s)'
          + (f', {by_core} by its core (findings and log link, no output tail)' if by_core else '')
          + f', {len(bundles[0]["unrestored"])} named only')
    return 0


# ── send ─────────────────────────────────────────────────────────────────────

def received_details(env, cfg):
    """({context: detail}, lost): the bundle nikatru-collect handed over, each hand-off unsealed
    under its own key and checked. It is data: parsed as JSON, never run, imported or written
    out. `lost` names why a bundle that was handed over could not be read: the reports then
    go out without detail and the send exits 2 (COVERAGE LOST), never an empty pass."""
    raws = [env.get(detail_env(i), '') for i in range(DETAIL_OUTPUTS)]
    if not raws[0]:
        print('-- detail: none handed over; the reports go out without detail')
        return {}, None
    try:
        return read_bundle(raws[0], env, cfg, more=[r for r in raws[1:] if r]), None
    except Refused as e:
        return {}, f'the red detail could not be read: {e}; the reports went out without detail'
    except Exception as e:  # whatever a hand-off does, the statuses still go out
        return {}, f'the red detail could not be read ({type(e).__name__}); the reports went out without detail'


def detail_env(i):
    """The send step's environment variable for the collect job's i-th detail output (gen-public-shell.mjs)."""
    return 'NIKATRU_DETAIL' if i == 0 else f'NIKATRU_DETAIL_{i + 1}'


def parse_bundle(raw):
    if len(raw) > SEALED_MAX_CHARS:
        raise Refused(f'{len(raw)} characters, over the {SEALED_MAX_CHARS} cap')
    try:
        bundle = json.loads(raw)
    except Exception as e:  # RecursionError (deep nesting) is a RuntimeError, not a ValueError
        raise Refused(f'not JSON this reporter can read ({type(e).__name__})')
    if not isinstance(bundle, dict) or bundle.get('v') != BUNDLE_VERSION or not isinstance(bundle.get('handoffs'), dict) or not isinstance(bundle.get('unrestored'), list):
        raise Refused(f'not a version-{BUNDLE_VERSION} hand-off bundle')
    bundle.setdefault('cores', {})
    if not isinstance(bundle['cores'], dict):
        raise Refused(f'not a version-{BUNDLE_VERSION} hand-off bundle')
    return bundle


def read_bundle(raw, env, cfg, more=()):
    """The first bundle, and the spilled ones (`more`: collect's detail_2 ..), read as ONE: their hand-offs
    together, each name at most once; a spilled bundle names nothing unrestored (collect names in the first)."""
    bundle = parse_bundle(raw)
    for extra in more:
        b = parse_bundle(extra)
        if b['unrestored']:
            raise Refused('a spilled bundle names unrestored hand-offs (only the first does)')
        for name, sealed in b['handoffs'].items():
            if name in bundle['handoffs']:
                raise Refused(f'{name[:100]!r} is carried twice')
            bundle['handoffs'][name] = sealed
        for name, sealed in b['cores'].items():
            if name in bundle['cores']:
                raise Refused(f'{name[:100]!r} is carried twice')
            bundle['cores'][name] = sealed
    if set(bundle['cores']) & set(bundle['handoffs']):
        raise Refused('a hand-off is carried both whole and by its core')
    master = env.get('NIKATRU_DETAIL_KEY', '')
    if (bundle['handoffs'] or bundle['cores']) and not master:
        raise Refused('NIKATRU_DETAIL_KEY is not set')
    details = {}
    carried = [(n, s, '') for n, s in bundle['handoffs'].items()] + [(n, s, CORE_SUFFIX) for n, s in bundle['cores'].items()]
    for name, sealed, bound in carried:
        member = run_member_of(name, cfg, env) if re.match(r'^[A-Za-z0-9._-]{1,400}$', name) else None
        if member is None or not isinstance(sealed, str):
            raise Refused(f'{name[:100]!r} is not a hand-off of this run (this attempt or an earlier one)')
        # A7-05: each hand-off is sealed under the run key of the attempt that made it, never under the master;
        # a re-run report job (attempt N+1) unseals attempt N's with attempt N's key.
        attempt = name[len(f"{cfg['prefix']}{env['GITHUB_RUN_ID']}-"):].split('-', 1)[0]
        key = run_key(master, f"{env['GITHUB_RUN_ID']}-{attempt}")
        try:
            plain = unseal(key, name + bound, sealed)
        except Refused as e:
            raise Refused(f'hand-off {name!r}{" (its core)" if bound else ""}: {e}')
        if len(plain) > HANDOFF_MAX_BYTES:
            raise Refused(f'hand-off {name!r} is over the {HANDOFF_MAX_BYTES}-byte cap')
        details.setdefault(member, []).append(plain.decode('utf-8', errors='replace'))
    unrestored = [run_member_of(k, cfg, env) for k in bundle['unrestored'] if isinstance(k, str)]
    if None in unrestored or len(unrestored) != len(bundle['unrestored']):
        raise Refused('it names an unrestored hand-off that is not this run\'s')
    # Every job's NOTE sections ride on the gate's detail too: the gate's members are its own job,
    # and a note (an applied PR-scoped secret-scan exemption) is said where the reviewer looks.
    notes = notes_of(join_detail([t for texts in details.values() for t in texts]))
    out = {}
    for item in items(cfg):
        detail = detail_for(item['members'], details)
        if is_gate(item, cfg) and notes and notes not in detail:
            detail = join_detail([detail, notes])
        if is_gate(item, cfg) and unrestored:
            detail += '\n\n(' + str(len(unrestored)) + ' more red job(s) handed over detail this report could not carry: ' + ', '.join(unrestored) + ')\n'
        if detail.strip():
            out[item['context']] = detail
    return out


def gate_origin_ok(env, cfg=None):
    """True when this run may report the gate: a pull request with a number, or a push to main or of a tag.
    A workflow the generator marks `leadDispatch` (2026-10-06, bridge-train-1006: e2e.yml against a PR head)
    may also report it for a `workflow_dispatch`-origin dispatch of a branch: the PR head it was sent for."""
    event = env.get('NIKATRU_P_EVENT', '')
    ref = env.get('NIKATRU_P_REF', '')
    if event == 'pull_request':
        return re.fullmatch(r'[1-9][0-9]{0,9}', env.get('NIKATRU_P_PR', '')) is not None
    if event == 'workflow_dispatch' and (cfg or {}).get('leadDispatch') is True:
        return ref.startswith('refs/heads/')
    return event == 'push' and (ref == 'refs/heads/main' or ref.startswith('refs/tags/'))


def dispatch_detail(details, lost, results, cfg):
    """The ONE detail of a manual run: each red or detailed lane and the gate, a section each, within DETAIL_MAX_BYTES."""
    sections = []
    for item in items(cfg):
        result = results.get(item['job'], 'absent')
        text = details.get(item['context'], '')
        if result in ('failure', 'cancelled') or text.strip():
            sections.append(f"## {item['context']} — {result}\n\n" + (text.strip() or '(no red detail was handed over for this job)') + '\n')
    if lost:
        sections.append(f'## COVERAGE LOST\n\n{lost}\n')
    return join_detail(sections)


# The runs of the SHELL's own events that dispatched no private commit, so they write no status and file their red
# detail at the private home instead (POST /dispatch-detail): a manual run, and ⏱ 2026-10-24 ·
# O-SCHEDULED-RUN-RED-DETAIL-NEVER-DELIVERED a scheduled one, whose hand-offs used to reach nobody.
UNDISPATCHED_EVENTS = ('workflow_dispatch', 'schedule')


def send_dispatch(env, cfg, opener=urllib.request.urlopen):
    """A workflow_dispatch or schedule run: no status (no private commit was dispatched), its red detail to the private home."""
    event = env.get('GITHUB_EVENT_NAME', '')
    url = cfg.get('dispatchDetailUrl')
    if not url:
        raise Lost('the config names no dispatchDetailUrl: this root does not declare workflow_dispatch to the generator')
    secret = env.get('BRIDGE_REPORT_SECRET', '')
    if not secret:
        raise Lost('BRIDGE_REPORT_SECRET is not set: the detail cannot be signed')
    try:
        results = json.loads(env.get('NIKATRU_RESULTS', ''))
    except ValueError:
        raise Lost('NIKATRU_RESULTS is not the JSON map of job results the report job is given')
    details, lost = received_details(env, cfg)
    detail = dispatch_detail(details, lost, results, cfg)
    if env.get('GITHUB_OUTPUT'):
        with open(env['GITHUB_OUTPUT'], 'a', encoding='utf-8') as f:
            f.write('reported=true\n')
    if not detail.strip():
        print(f'-- {event} run: nothing red and no detail; nothing sent to the private home')
        return 0
    body = {'run_id': int(env['GITHUB_RUN_ID']), 'run_attempt': int(env['GITHUB_RUN_ATTEMPT']), 'detail': fit_bytes(detail, DETAIL_MAX_BYTES)}
    status, why = post(url, secret, body, cfg['postTimeoutS'], opener)
    if 200 <= status < 300 or status == 409:
        print(f'ok {event} red detail -> HTTP {status} (filed privately{"; already filed for this attempt" if status == 409 else ""})')
        if lost:
            print(f'x COVERAGE LOST - report.py: {lost}', file=sys.stderr)
            return 2
        return 0
    print(f"x  {event} red detail -> HTTP {status}{f' ({why})' if why else ''}")
    return 1


# ⏱ 2026-11-09 · review52-platform-002: the report job holds `id-token: write` (gen-public-shell.mjs reportJob), and
# every /report attempt carries a FRESH token of it (a retry may outlive one), so the bridge binds the report to this
# job, not to whoever holds REPORT_SECRET. A token that cannot be minted is SAID and the post goes without one: the
# bridge decides (it accepts none until its REPORT_OIDC.required flips, then refuses it 403 with its reason).
REPORT_OIDC_TIMEOUT_S = 10


def report_token(env, opener=urllib.request.urlopen):
    """This job's OIDC token for one /report attempt, or None (printed when the runner would not mint one)."""
    token, why = caller_token(env, opener, REPORT_OIDC_TIMEOUT_S)
    if why:
        print(f'-- X-Bridge-OIDC: {why}; this report goes without one', file=sys.stderr)
    return token


# ⏱ 2026-11-11 · fix1110b #3 (row O-RED-DETAIL-COMPLETE). NO SILENT LOSS. A red job whose detail carries neither a
# finding line (the wrapper's `» ` or a `✖ ` failing test) nor a stored full log (`full log: stored …`) reached the
# private PR as a red status and nothing a lane could act on, and the report job said ok. Now such a job makes the
# report itself red: `x LOST DETAIL <context>` in this log, the same line in the job's posted detail, exit 1. The gate
# is held to it only when it is the one red (a lane's red gate carries the lane's loss already).
LOST_DETAIL = 'LOST DETAIL'
# ⏱ 2026-11-11 · fix1110b round 2 (lead re-review, part 2: FAIL CLOSED; the owner's standard is complete logs, not best
# effort). The wrapper's last-line fallback is no longer a finding (LAST_LINE_MARK), and every `### RED` section must
# link its STORED full log: a section that says `full log: NOT stored`, still `pending upload` (no hand-off ran), or
# names no full log at all is LOG NOT STORED, and the report goes red as for LOST DETAIL.
LOG_NOT_STORED = 'LOG NOT STORED'


# ⏱ 2026-11-11 · fix1110b round 4 (lead final re-review: a BLOCKER and a should-fix). Structure is read from each
# section's HEAD only — the lines above its OUTPUT_TAIL_MARK (or `#### step summary`) — never from the step's output.
# The quiet-step wrapper escapes any output line shaped like structure (its escapeOutput), and this reader never looks
# past a head for a mark; a section header is a header only at a line start, which an escaped line never is. And the
# report step's log is PUBLIC (it is not quiet-wrapped), so what it prints of a detail is COUNTS only, never a name.
TAIL_HEADS = (OUTPUT_TAIL_MARK, '#### step summary')
# ⏱ 2026-11-11 · fix1110b round 5 (lead re-review 11:42Z). The line breaks a detail is split on — the SAME set the
# quiet-step wrapper splits (and escapes) on, its LINE_BREAK. Never str.splitlines (it also breaks on \x0b, \x0c,
# \x1c-\x1e and \x85, which the wrapper keeps inside a line) and never a file read in universal-newline mode (handoff
# opens with newline='').
LINE_BREAK = re.compile('\r\n|\r|\n|\u2028|\u2029')


def lines_of(text):
    """`text` split on LINE_BREAK."""
    return LINE_BREAK.split(text)


def section_heads(detail):
    """[(header or None, [head lines])]: the text before any section (None), then each `### RED`/`### NOTE` section's
    header and its lines above the tail. A tail's lines are skipped, never parsed."""
    out, in_tail = [(None, [])], False
    for line in lines_of(detail):
        if line.startswith((RED_HEADER, NOTE_HEADER)):
            out.append((line, []))
            in_tail = False
        elif line in TAIL_HEADS:
            in_tail = True
        elif not in_tail:
            out[-1][1].append(line)
    return out


def has_detail(detail):
    """True when a section head of `detail` names a real finding line (FINDING_MARK, never the last-line fallback), a
    failing test, or links a stored full log. The output tail is never read."""
    return any(line.startswith((FINDING_MARK, '✖ ', RED_LOG_STORED)) for _, head in section_heads(detail) for line in head)


def unstored_logs(detail):
    """(red, unwired): how many `### RED` sections of `detail` link no STORED full log in their head — `unwired` those
    whose log no upload step was there to store (RED_LOG_NOT_WIRED, a NOTE), `red` every other (an upload that failed,
    a hand-off that never ran, no log at all). Counts, never names: the caller prints them in a public log."""
    red = unwired = 0
    for header, head in section_heads(detail):
        if header is None or not header.startswith(RED_HEADER) or any(line.startswith(RED_LOG_STORED) for line in head):
            continue
        if any(line.startswith(RED_LOG_NOT_WIRED) for line in head):
            unwired += 1
        else:
            red += 1
    return red, unwired


def held_to_detail(item, cfg, results):
    """True when this item's red is its own to explain: a red lane, or a gate that is the one red (fix1110b #3)."""
    if results.get(item['job']) != 'failure':
        return False
    return not is_gate(item, cfg) or all(results.get(lane['job']) == 'success' for lane in cfg['lanes'])


def lost_detail(item, cfg, results, detail):
    """True when a red job's detail cannot tell a reader why it is red (fix1110b #3)."""
    return held_to_detail(item, cfg, results) and not has_detail(detail)


def send(env, cfg, opener=urllib.request.urlopen, clock=time.monotonic):
    if env.get('GITHUB_EVENT_NAME') in UNDISPATCHED_EVENTS:
        return send_dispatch(env, cfg, opener)
    url = cfg.get('bridgeUrl')
    if not url:
        raise Lost('the config names no bridge URL (generated before services/gh-bridge/wrangler.jsonc was in the tree)')
    secret = env.get('BRIDGE_REPORT_SECRET', '')
    if not secret:
        raise Lost('BRIDGE_REPORT_SECRET is not set: no report can be signed')
    if not SHA.match(env.get('NIKATRU_HEAD_SHA', '')):
        raise Lost('NIKATRU_HEAD_SHA is not the 40-hex sha the bridge dispatched')
    try:
        results = json.loads(env.get('NIKATRU_RESULTS', ''))
    except ValueError:
        raise Lost('NIKATRU_RESULTS is not the JSON map of job results the report job is given')
    details, lost = received_details(env, cfg)
    failed = 0
    # ⏱ 2026-10-08 (sysfix-a1-ci-shell, m6): ONE budget for the whole send, so it and its fallback end inside the
    # job's timeout (22 contexts x a hung bridge used to be ~36 min against 10); a post starts only while a whole
    # one still fits, and every context left is named, not sent. The gate goes first (items), so it is the last to lose.
    budget = cfg.get('sendBudgetS')
    started = clock()
    for item in items(cfg):
        state = STATE_OF.get(results.get(item['job'], ''))
        if state is None:
            print(f"-- {item['context']}: {results.get(item['job'], 'absent')}, not reported")
            continue
        if budget is not None and clock() - started + post_worst_s(cfg) > budget:
            failed += 1
            print(f"x  {item['context']}: NOT reported — the send's {budget} s budget cannot fit another post")
            continue
        if is_gate(item, cfg) and not gate_origin_ok(env, cfg):
            failed += 1
            print(f"x  {item['context']}: NOT reported — this run is not a pull request, main or a tag run (nor a lead dispatch its config allows) "
                  f"(event {env.get('NIKATRU_P_EVENT', '')!r}, ref {env.get('NIKATRU_P_REF', '')!r}); only such a run may write the gate")
            continue
        detail = details.get(item['context'], '')
        if not lost and lost_detail(item, cfg, results, detail) and not held(item, cfg, results, detail, lost):
            # fix1110b #3: said here and on the private PR, and the report goes red. (A lost bundle is exit 2 already.)
            failed += 1
            print(f"x {LOST_DETAIL} {item['context']}: red, and its detail names no failing line and links no full log")
            detail = (detail.rstrip('\n') + '\n\n' if detail.strip() else '') + (
                f"{LOST_DETAIL} {item['context']}: this red job handed over no finding line and no stored full log. "
                'Its job log is the public run\'s only record; read it with ' + RED_LOG_READER + ' ' + env.get('GITHUB_RUN_ID', '') + '.\n')
        unstored, unwired = unstored_logs(detail) if not lost and held_to_detail(item, cfg, results) and not held(item, cfg, results, detail, lost) else (0, 0)
        # fix1110b round 4: this log is PUBLIC — the context (the config's) and a count, never text of the detail.
        if unwired:
            # fix1110b round 3: no upload step is wired yet (option C lands after #1350): said, never a red.
            print(f"-- NOTE {item['context']}: full log not stored: upload not wired yet (row O-RED-DETAIL-COMPLETE part 2): {unwired} red step(s)")
        if unstored:
            # fix1110b round 2: a red step's full log that was not stored is a red report, never best effort.
            failed += 1
            print(f"x {LOG_NOT_STORED} {item['context']}: {unstored} red step(s) whose full log was not stored in the bridge's private home")
            detail = detail.rstrip('\n') + '\n\n' + (
                f"{LOG_NOT_STORED} {item['context']}: {unstored} red step(s) whose full log was not stored "
                '(see each section\'s `full log:` line); the report is red until every red step\'s log is.\n')
        if state == 'failure' and held(item, cfg, results, detail, lost):
            state = 'pending'
        elif state == 'success' and not cleared(item, cfg, env, detail):
            # ⏱ 2026-10-24 · ci-gate-hold-not-red: a green gate job is not a green gate without pr-meta's clear.
            state = 'pending' if held(item, cfg, results, detail, lost) else 'failure'
            if state == 'failure':
                print(f"x  {item['context']}: the gate job succeeded without pr-meta's clear "
                      f"(meta {env.get('NIKATRU_GATE_META', '')[:20]!r}, and no hold this report can read): posted failure, never success")
        status, why = post(url, secret, build(item['context'], state, env, detail, is_gate(item, cfg)), cfg['postTimeoutS'], opener, stamp=True,
                           oidc=lambda: report_token(env, opener))
        # A 409 is this very body already delivered (the bridge's seen-key, O-BRIDGE-REPORT-REPLAY-WINDOW): not a failure.
        ok = 200 <= status < 300 or status == 409
        failed += 0 if ok else 1
        print(f"{'ok' if ok else 'x '} {item['context']} {state} -> HTTP {status}{f' ({why})' if why and not ok else ''}")
    # Every status was attempted: the report job's fallback step (no detail) need not run.
    if env.get('GITHUB_OUTPUT'):
        with open(env['GITHUB_OUTPUT'], 'a', encoding='utf-8') as f:
            f.write('reported=true\n')
    if lost:
        print(f'x COVERAGE LOST - report.py: {lost}', file=sys.stderr)
        return 2
    return 1 if failed else 0


# ── pr-meta: the gate's live read, by the shell's own copy ──────────────────
#
# ⏱ 2026-10-08 · A7-05/A7-06 (system review A7-security-supply). The gate's read of the private PR as it is
# now used to be signed by tooling/ci/gate-pr-body.mjs from the pull request's own merge checkout, so the PR's
# code held BRIDGE_READ_SECRET. Now the gate job's staging copy of THIS file signs it, in a generated step that
# runs before any private code of the job, and writes the answer to NIKATRU_PR_META_FILE (outside the
# workspace); the body step reads that file and holds no secret. The read is bound to this live run: it carries
# this job's Actions OIDC token (X-Bridge-OIDC, minted for OIDC_AUDIENCE), and the bridge verifies it and re-reads
# that run, which must be live and titled with exactly this PR and head (sysfix-a4-gh-bridge A4-01, which
# superseded this file's first form: a run id the sender named).
#
# The same step refuses a pull request that changes a file the shell runs as its OWN copy (RUNNER_SOURCES:
# every quiet step's wrapper and this reporter), or the generator and register that decide what is staged and
# what every step runs (PR #165 review finding 4), unless the private PR carries RUNNER_LABEL, which a lead sets:
# after the merge every shell job runs that file, and its wrapper decides every lane's exit code. Shell-owned:
# the PR cannot edit this check out of its own gate.
# PR #213 review finding 3: also the shell's byte copies (what a job runs after the sync) and the generator's
# relative-import closure (a bent import lets --check accept a modified copy).
RUNNER_SOURCES = ('tooling/ci/quiet-step.mjs', 'tooling/ci/shell-report.py', 'tooling/ci/gen-public-shell.mjs',
                  'tooling/ci/public-shell.json',
                  'shell/.github/nikatru/report.py', 'shell/.github/nikatru/quiet-step.mjs',
                  'shell/.github/nikatru/tree-walk.mjs',
                  'tooling/app-yaml/yaml.mjs', 'tooling/ci/app-set.mjs', 'tooling/ci/assert-shell-current.mjs',
                  'tooling/ci/d1-sql-inventory.mjs', 'tooling/ci/d1-stores.mjs', 'tooling/ci/deployment-record.mjs',
                  'tooling/ci/flutter-release-build.mjs', 'tooling/ci/gate-verdict.mjs', 'tooling/ci/github-api-base.mjs',
                  'tooling/ci/previous-ci-history.mjs', 'tooling/ci/record-deployment.mjs',
                  'tooling/ci/run-context.mjs', 'tooling/ci/shell-handoff.mjs', 'tooling/ci/text-reductions.mjs',
                  'tooling/ci/tree-walk.mjs', 'tooling/ci/workflow-scan.mjs', 'tooling/ci/wrangler-environments.mjs',
                  'tooling/e2e/backend.mjs', 'tooling/generated/codehost.mjs',
                  'tooling/ops/actions-oidc.mjs', 'tooling/ops/bounded-retry.mjs', 'tooling/ops/run-jobs.mjs',
                  'tooling/store/capture-backend.mjs')
# ⏱ 2026-10-09 · PR #213 review finding 5. THE LABEL IS ADVISORY. The bridge returns label NAMES, and every lane and
# every lead writes to the private repo as the one GitHub identity, so who applied a label proves nothing and an
# allow-list of appliers would admit everyone it lists. Any writer can add it to its own PR. What the label buys is
# that a change to the shell's runner is deliberate and visible (a named label on the PR, a red gate until then),
# not that a lead reviewed it; the pass line says so on every use.
RUNNER_LABEL = 'lead-reviewed-runner'
RUNNER_LABEL_ADVISORY = ('ADVISORY: the label is not tied to who applied it (one GitHub identity writes for every lane and '
                         'lead), so it marks the change deliberate, not reviewed')
PR_META_TIMEOUT_S = 30
# The audience the bridge accepts (tooling/ops/actions-oidc.mjs BRIDGE_OIDC_AUDIENCE; shell-report.test.mjs holds them equal).
OIDC_AUDIENCE = 'nikatru-gh-bridge-propose'
# A JWT's shape: what an Actions OIDC token is, and nothing that could carry a header break.
JWT = re.compile(r'^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')


def pr_meta_message(number, sha, ts):
    """What the bridge verifies (services/gh-bridge/src/pr-meta.ts readMessage)."""
    return f'{number}.{sha}.{ts}'


def caller_token(env, opener=urllib.request.urlopen, timeout=None):
    """(token | None, why | None): this job's OIDC token for the bridge, as actions-oidc.mjs callerToken. Neither
    ACTIONS_ID_TOKEN_REQUEST_URL nor _TOKEN: (None, None), the read goes without one and the bridge refuses it with
    its reason. An endpoint that will not mint: (None, why), lost, never a silent send without a token."""
    url, bearer = env.get('ACTIONS_ID_TOKEN_REQUEST_URL', ''), env.get('ACTIONS_ID_TOKEN_REQUEST_TOKEN', '')
    if not url and not bearer:
        return None, None
    if not url or not bearer:
        return None, 'the job offers half of the OIDC endpoint (ACTIONS_ID_TOKEN_REQUEST_URL / _TOKEN)'
    u = urllib.parse.urlsplit(url)
    if not (u.scheme == 'https' or (u.scheme == 'http' and u.hostname == '127.0.0.1')) or u.username or u.password:
        return None, 'ACTIONS_ID_TOKEN_REQUEST_URL is not an https URL'
    query = [(k, v) for k, v in urllib.parse.parse_qsl(u.query, keep_blank_values=True) if k != 'audience'] + [('audience', OIDC_AUDIENCE)]
    req = urllib.request.Request(urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, urllib.parse.urlencode(query), '')), method='GET', headers={
        'authorization': f'bearer {bearer}', 'accept': 'application/json; api-version=2.0', 'user-agent': USER_AGENT})
    try:
        with opener(req, timeout=timeout or PR_META_TIMEOUT_S) as r:
            value = json.loads(r.read().decode('utf-8')).get('value') if r.status == 200 else None
    except urllib.error.HTTPError as e:
        return None, f'the runner would not mint the OIDC token (HTTP {e.code})'
    except (urllib.error.URLError, OSError, ValueError, AttributeError) as e:
        return None, f'the OIDC token request failed ({type(e).__name__})'
    if not isinstance(value, str) or not JWT.match(value):
        return None, 'the runner answered with no OIDC token'
    return value, None


def runner_sources_touched(run=subprocess.run):
    """The RUNNER_SOURCES the checked-out merge commit changes against its first parent, or None when git
    cannot say (the gate's first checkout fetches the two parents for this)."""
    try:
        r = run(['git', 'diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD', '--', *RUNNER_SOURCES],
                capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    return sorted({l.strip() for l in r.stdout.splitlines() if l.strip()})


# ⏱ 2026-10-16 · PR #690 review finding 4: the read tooling/ops/bridge-read.mjs made (fix-pr216, PR #553) retried a
# 429 from the bridge's per-minute bucket and a send that got no answer at all; this port made ONE send, so a rate-limit
# hit or one dropped connection lost the gate of a run whose every lane was green. The same bounded waits, re-signed
# each time: a 429 is sent again after each of RATE_WAITS_S, a send with no answer (a refused or dropped connection, a
# DNS blip) after each of NETWORK_WAITS_S; every other HTTP answer is lost at once.
# ⏱ 2026-11-04 · club-integration-1104: a TIMEOUT (the bridge took the connection and did not answer within
# PR_META_TIMEOUT_S) is re-sent, re-signed, exactly TIMEOUT_RESENDS times and then lost: one slow bridge answer used to
# lose the gate of a run whose every lane was green (39 minutes of it). Bounded, so a bridge that never answers costs
# (TIMEOUT_RESENDS + 1) x PR_META_TIMEOUT_S, never a hung step. Tests: tooling/ci/test/pr-meta-timeout-retry.test.mjs.
RATE_WAITS_S = (20, 45)
NETWORK_WAITS_S = (2, 6)
TIMEOUT_RESENDS = 1


def _is_timeout(e):
    return isinstance(e, TimeoutError) or isinstance(getattr(e, 'reason', None), TimeoutError)


def read_pr_meta(env, opener=urllib.request.urlopen, now=time.time, sleep=time.sleep):
    """({answer} | None, why): a signed POST /pr-meta, carrying this job's OIDC token, re-sent on a 429 or on no
    answer at all within RATE_WAITS_S / NETWORK_WAITS_S, and on a timeout TIMEOUT_RESENDS times."""
    url = env.get('NIKATRU_BRIDGE_READ_URL', '')
    secret = env.get('BRIDGE_READ_SECRET', '')
    pr, sha = env.get('NIKATRU_P_PR', ''), env.get('NIKATRU_P_SHA', '')
    if not re.match(r'^https://[A-Za-z0-9.-]+/pr-meta$', url) and not re.match(r'^http://127\.0\.0\.1:[0-9]+/pr-meta$', url):
        return None, 'NIKATRU_BRIDGE_READ_URL is not the bridge\'s https /pr-meta URL'
    if not secret:
        return None, 'BRIDGE_READ_SECRET is not set in this step: the read cannot be signed'
    if not re.fullmatch(r'[1-9][0-9]{0,9}', pr) or not SHA.match(sha):
        return None, 'the dispatch names no PR number and head sha'
    rate, net, slow = 0, 0, 0
    while True:
        token, lost = caller_token(env, opener)
        if lost:
            return None, lost
        ts = int(now())
        body = {'number': int(pr), 'sha': sha, 'ts': ts}
        raw = json.dumps(body).encode('utf-8')
        sig = 'sha256=' + hmac.new(secret.encode('utf-8'), pr_meta_message(pr, sha, ts).encode('utf-8'), hashlib.sha256).hexdigest()
        headers = {'content-type': 'application/json', 'user-agent': USER_AGENT, 'x-bridge-signature': sig}
        if token:
            headers['x-bridge-oidc'] = token
        req = urllib.request.Request(url, data=raw, method='POST', headers=headers)
        try:
            with opener(req, timeout=PR_META_TIMEOUT_S) as r:
                if r.status != 200:
                    return None, f'the bridge answered HTTP {r.status}'
                answer = json.loads(r.read().decode('utf-8'))
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and rate < len(RATE_WAITS_S):
                sleep(RATE_WAITS_S[rate])
                rate += 1
                continue
            if e.code == 429:
                return None, f'the bridge\'s rate limit refused the read (HTTP 429) — after {len(RATE_WAITS_S) + 1} sends'
            return None, f'the bridge refused the read (HTTP {e.code})'
        except (urllib.error.URLError, OSError) as e:
            if _is_timeout(e):
                if slow < TIMEOUT_RESENDS:
                    slow += 1
                    continue
                return None, (f'the bridge read failed ({type(e).__name__}): no answer within {PR_META_TIMEOUT_S}s, '
                              f'{slow + 1} times — after {net + rate + slow + 1} sends')
            if net < len(NETWORK_WAITS_S):
                sleep(NETWORK_WAITS_S[net])
                net += 1
                continue
            return None, f'the bridge read failed ({type(e).__name__}) — after {net + rate + slow + 1} sends'
        except ValueError as e:
            return None, f'the bridge read failed ({type(e).__name__})'
    if not isinstance(answer, dict):
        return None, 'the bridge answered something that is not a JSON object'
    return answer, ''


def pr_meta(env, opener=urllib.request.urlopen, run=subprocess.run, now=time.time, sleep=time.sleep):
    """The gate's pre-read: the answer (or {"lost": why}) to NIKATRU_PR_META_FILE, and the step output `meta`:
    GATE_CLEAR when no RUNNER_SOURCES file changed or RUNNER_LABEL is on the PR, GATE_HOLD (exit 0, a HOLD section,
    a `::warning`) when one changed without it, nothing and exit 2 when that cannot be decided. A lost read alone
    exits 0: the body step turns it into COVERAGE LOST with its reason."""
    out = env.get('NIKATRU_PR_META_FILE', '')
    if not out:
        raise Lost('NIKATRU_PR_META_FILE is not set: nowhere to put the read')
    touched = runner_sources_touched(run)
    answer, why = read_pr_meta(env, opener, now, sleep)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(answer if answer is not None else {'lost': why}, f)
    print(f'ok pr-meta: read PR #{env.get("NIKATRU_P_PR", "?")} live' if answer is not None else f'-- pr-meta: {why}')
    if touched is None:
        print('x COVERAGE LOST - report.py: which shell-run files this pull request changes could not be read (git diff HEAD^1 HEAD)', file=sys.stderr)
        return 2
    if not touched:
        gate_meta(env, GATE_CLEAR)
        return 0
    if answer is None:
        print(f'x COVERAGE LOST - report.py: this pull request changes {", ".join(touched)}, and its labels could not be read: {why}', file=sys.stderr)
        return 2
    labels = answer.get('labels')
    if isinstance(labels, list) and RUNNER_LABEL in labels:
        print(f'ok pr-meta: {", ".join(touched)} changed, and the PR carries {RUNNER_LABEL} — {RUNNER_LABEL_ADVISORY}')
        gate_meta(env, GATE_CLEAR)
        return 0
    # ⏱ 2026-10-23 · ci-gate-holds: a WAIT, recorded as the gate's HOLD (send posts it pending when it is the only red).
    # ⏱ 2026-10-24 · ci-gate-hold-not-red: the step passes (the Public run is green), and the gate's private success
    # needs GATE_CLEAR, which a hold never writes: a hold whose record is lost is still never success (cleared).
    why = (f'this pull request changes {", ".join(touched)}, which every shell job runs as the shell\'s own copy after the merge; '
           f'it waits on a lead adding the label {RUNNER_LABEL} to the private PR (then re-run ci-gate)')
    hold_detail(env, f'the label {RUNNER_LABEL}', why)
    gate_meta(env, GATE_HOLD)
    print(f'::warning title=ci-gate HOLD (pending, not a failure)::{why}')
    return 0


def tier_of(env, read=read_pr_meta):
    """(tier, why) of this run: TIER_LIGHT only for a pull_request whose ref is no train head, with the switch `on`,
    whose labels /pr-meta answered without TIER_LABEL; TIER_FULL on anything else, an unreadable read included.
    The read is made only when every other condition already allows light."""
    event, ref, switch = env.get('NIKATRU_P_EVENT', ''), env.get('NIKATRU_P_REF', ''), env.get(TIER_SWITCH, '')
    seen = f'{event or "(no event)"} on {ref or "(no ref)"}, {TIER_SWITCH}={switch or "(unset)"}'
    if event != 'pull_request':
        return TIER_FULL, f'{seen}: not a pull_request'
    if TRAIN_REF.match(ref):
        return TIER_FULL, f'{seen}: a train head runs full'
    if switch != 'on':
        return TIER_FULL, f'{seen}: the switch is not `on`'
    answer, why = read(env)
    if answer is None:
        return TIER_FULL, f'{seen}, labels unread: /pr-meta could not be read ({why}), failing closed'
    labels = answer.get('labels')
    if not isinstance(labels, list) or not all(isinstance(l, str) for l in labels):
        return TIER_FULL, f'{seen}, labels unread: /pr-meta answered no list of labels, failing closed'
    if TIER_LABEL in labels:
        return TIER_FULL, f'{seen}, labels {json.dumps(sorted(labels))}: the PR carries {TIER_LABEL}'
    return TIER_LIGHT, f'{seen}, labels {json.dumps(sorted(labels))}'


def tier(env, read=read_pr_meta):
    """The pin job's tier step: `tier=<light|full>` to $GITHUB_OUTPUT, the decision and its reason printed. Exit 0
    always: a crash leaves the output unset, and the job output reads an unset tier as full."""
    t, why = tier_of(env, read)
    print(f'tier={t}: {why}')
    out = env.get('GITHUB_OUTPUT', '')
    if out:
        with open(out, 'a', encoding='utf-8') as f:
            f.write(f'tier={t}\n')
    return 0


def gate_meta(env, value):
    """The step output `meta` (GITHUB_OUTPUT), which the gate job carries to the report job as `outputs.meta`."""
    out = env.get('GITHUB_OUTPUT', '')
    if not out:
        return
    with open(out, 'a', encoding='utf-8') as f:
        f.write(f'meta={value}\n')


def hold_detail(env, what, why):
    """A `### HOLD <what>` section on this job's detail ($RUNNER_TEMP/report-detail.md, which the job hands over)."""
    temp = env.get('RUNNER_TEMP', '')
    if not temp:
        return
    with open(os.path.join(temp, DETAIL_FILE), 'a', encoding='utf-8') as f:
        f.write(f'{HOLD_HEADER}{what}\n\n{why}\n\n')


def main(argv, env):
    try:
        if len(argv) == 1 and argv[0] == 'handoff':
            return handoff(env)
        if len(argv) == 1 and argv[0] == 'derive':
            return derive(env)
        if len(argv) == 1 and argv[0] == 'pr-meta':
            return pr_meta(env)
        if len(argv) == 1 and argv[0] == 'tier':
            return tier(env)
        if len(argv) == 2 and argv[0] == 'place':
            return place(argv[1])
        if argv == ['baseline-keys']:
            return baseline_keys(env)
        if len(argv) == 2 and argv[0] == 'baseline-seal':
            return baseline_seal(env, argv[1])
        if len(argv) == 2 and argv[0] == 'baseline-verify':
            return baseline_verify(env, argv[1])
        if len(argv) == 2 and argv[0] in ('plan', 'collect', 'send'):
            cfg = load_config(argv[1])
            return {'plan': plan, 'collect': collect, 'send': send}[argv[0]](env, cfg)
        print('usage: report.py handoff | derive | pr-meta | tier | plan <config> | place <key> | collect <config> | send <config> | baseline-keys | baseline-seal <dir> | baseline-verify <dir>', file=sys.stderr)
        return 2
    except Lost as e:
        print(f'x COVERAGE LOST - report.py: {e}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:], os.environ))
