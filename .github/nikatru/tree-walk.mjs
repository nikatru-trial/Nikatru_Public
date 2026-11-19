// ─────────────────────────────────────────────────────────────────────────────
// tree-walk.mjs — THE ONE DIRECTORY LISTING. Every guard in tooling/ci reads a
// directory through `listDir`, and nothing in tooling/ci imports `readdirSync`.
//
// ⏱ 2026-10-08 (O-WORKSPACE-CROSSING-HELPER-HAS-NO-CALLER): the second named
// primitive this file carried from 2026-08-18, `listCheckoutsAcrossWorkspace`,
// is RETIRED. It listed the nested checkouts `listDir` hides, for the guards
// whose subject was the workspace OF repositories (the store matrix guards);
// those were retired 2026-09-25, and after that its only callers were its own
// guard and tests. A sanctioned crossing nothing in production takes is a door
// kept open for nobody. There is ONE listing again, and crossing into another
// checkout has no sanctioned route at all: assert-walks-bounded.mjs refuses a
// raw enumeration (R1, R2), refuses any reference to the retired name (R5), and
// refuses any listing entry point this file exports beyond the ones it names
// (R6). A guard whose subject is again the workspace's checkouts is a decision
// that re-adds a route here together with its R4 proof, never a quiet walk.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE, STATED ONCE HERE AND ENFORCED BY assert-walks-bounded.mjs:
//
//   A directory entry is NOT part of the tree under test if
//     · it is a directory that itself contains a `.git` entry — file OR
//       directory — i.e. it is the root of a NESTED CHECKOUT: a git worktree, a
//       submodule, or a stray clone; or
//     · it is named `.claude`, which is gitignored agent scratch space and is
//       where this repository puts every agent worktree; or
//     · it is named `.worktrees`, the gitignored home of every detached
//       checkout the tooling makes (preflight.mjs detachedCheckout) and of
//       lane worktrees. Skipped BY NAME, because the `.git` rule is a
//       point-in-time probe and races the checkout's own lifecycle (below).
//
//   The ROOT of the walk is never itself a candidate for exclusion — only
//   entries found INSIDE it are — so pointing a guard at a checkout (which the
//   real repository always is) still scans it in full.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS. Reproduced on `main` 2026-08-02: with agent worktrees
// present under `.claude/worktrees/` — which this repo creates constantly, one
// per agent task — `node tooling/ci/assert-ops-register.mjs` exited 1 with
// sixteen problems, every one of the form
//
//     .claude/worktrees/agent-<id>/services/platform/wrangler.jsonc declares
//     `triggers.crons` and has no `duty` row …
//
// The guard was walking into NESTED FULL COPIES OF THE REPOSITORY and reading
// their files as if they were the tree's own. CI never sees this, because CI
// checks out one tree and creates no worktrees — so the guard was GREEN IN CI
// AND RED ON A DEVELOPER MACHINE, which is the worst shape a check can take: it
// cries wolf exactly where a human is watching, and the rational response is to
// stop believing it. A guard nobody believes has already stopped guarding.
//
// ⚠️ WHY THE RULE IS `.git`, NOT A HARDCODED `.claude/worktrees/`. The path is an
// accident of this repo's agent harness; the PROPERTY is that the directory is a
// different checkout. Anchoring on the path would leave `git worktree add
// ../wt-probe`-into-the-tree, submodules and stray clones all still wrong, and
// would have to be re-fixed the next time the harness changed its layout.
// `.claude` is skipped IN ADDITION, by name, because it is gitignored scratch
// space that is never part of the tree under test whether or not it happens to
// contain a checkout today.
//
// ⚠️ WHY A SHARED LISTING RATHER THAN N INDEPENDENT FIXES. Five guards were
// descending on the day this was written, and the other thirty-odd walks were
// one refactor away from joining them — the class is reintroduced by writing a
// perfectly ordinary `readdirSync` recursion, which is what every one of them
// already was. So the fix is not "skip nested checkouts in the five": it is that
// no guard enumerates a directory itself any more. `assert-walks-bounded.mjs`
// enforces that as an IMPORT-LEVEL rule — exact and lexical, with no JavaScript
// parsing to get subtly wrong — and it PROVES this file still refuses by
// building a nested checkout in a temp directory and calling `listDir` on it.
//
// Not a guard: it scans nothing of its own, exactly like text-reductions.mjs,
// and is recorded in assert-guard-coverage.mjs's NOT_A_SCANNER for that reason.
// The "did my scan still reach the tree" question belongs to the importers, each
// of which carries its own self-check over what it reads. (As in
// text-reductions.mjs, the marker phrase that check looks for is deliberately
// not spelled out anywhere in this file: it is matched as raw text, so a comment
// ABOUT the marker would claim a self-check this module does not have — prose
// satisfying a check, one level up from the defect this file exists to prevent.)
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, existsSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { join } from 'node:path';

/** The gitignored agent scratch directory. Skipped by name as well as by the
 *  `.git` rule: it is never part of the tree under test, and on a machine where
 *  the agent harness has not yet created a worktree it would not otherwise be
 *  recognisable as scratch. */
export const SCRATCH_DIR_NAME = '.claude';

/** The gitignored home of detached and lane checkouts, skipped by name at every
 *  depth (as `.claude` is).
 *
 *  ⏱ 2026-11-18 · lane bl-wf-worktree-race-1119 (its row is being filed).
 *  preflight.mjs `detachedCheckout` puts a base checkout at
 *  `<main checkout>/.worktrees/<tag>-<sha8>-<pid>` — inside the tree when `.git`
 *  sits at the checkout root, as on every CI runner. It must stay there (the
 *  guards it re-runs find the workspace by walking UP; see rerunRedsOnBase).
 *  real-submission-refusals makes one WHILE affected-guards (`--jobs 2`) runs
 *  other guards, and the `.git` rule alone cannot hide it: `isNestedCheckout` is
 *  asked once, when the parent is listed, and `git worktree remove --force`
 *  deletes the checkout's files in directory order — `.git` can go first and the
 *  rest is a full tree with no `.git`. #1586 run 44402756736: limb 16 of
 *  assert-ports read `.worktrees/rsr-…/services/platform/src/adapters/mail/resend.ts`
 *  as this tree's file. A name is not a probe, so it cannot lose that race. */
export const WORKTREES_DIR_NAME = '.worktrees';

/** Directory names that are never part of the tree under test, at any depth. */
const SKIPPED_BY_NAME = new Set([SCRATCH_DIR_NAME, WORKTREES_DIR_NAME]);

/** Is `absDir` the root of a different checkout? `.git` is a DIRECTORY in a
 *  clone or a submodule and a FILE (`gitdir: …`) in a worktree, so the test is
 *  existence, never `isDirectory()` — the worktree case is the one that bit. */
export function isNestedCheckout(absDir) {
  return existsSync(join(absDir, '.git'));
}

/** `readdirSync` minus the entries that are not part of the tree under test.
 *
 *  Deliberately NOT a recursive walker: the guards' walks differ in what they
 *  collect, what else they prune and what they do at each node, and replacing
 *  thirty-five of those with one traversal would be a rewrite of every guard's
 *  meaning rather than a repair. What they all shared — and all got wrong the
 *  same way — is the single question "what is in this directory", so that is
 *  the one thing centralised.
 *
 *  Only the `withFileTypes` option is supported, and anything else THROWS
 *  rather than being silently ignored: an option quietly dropped here would
 *  change a caller's semantics with no signal at all. */
export function listDir(dir, options) {
  if (options !== undefined) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError(`listDir(${dir}): options must be an object, got ${typeof options}`);
    }
    for (const key of Object.keys(options)) {
      if (key !== 'withFileTypes') {
        throw new TypeError(
          `listDir(${dir}): unsupported option \`${key}\`. Only \`withFileTypes\` is supported; ` +
            'silently ignoring an option would change the caller\'s meaning with no signal.',
        );
      }
    }
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  const kept = entries.filter(
    (e) => !(e.isDirectory() && (SKIPPED_BY_NAME.has(e.name) || isNestedCheckout(join(dir, e.name)))),
  );
  return options?.withFileTypes ? kept : kept.map((e) => e.name);
}

/** Does every directory on the way to `relPath` belong to the tree at `root`?
 *
 *  The ancestor chain has to be walked, not just the leaf: a glob reports the
 *  matched FILE, and the thing that disqualifies it is a nested checkout several
 *  segments above it. */
export function withinTree(root, relPath) {
  let cur = root;
  for (const segment of String(relPath).split(/[\\/]/).filter((s) => s !== '' && s !== '.')) {
    cur = join(cur, segment);
    if (SKIPPED_BY_NAME.has(segment) || isNestedCheckout(cur)) return false;
  }
  return true;
}

/** `fs/promises.glob` minus the matches that are not part of the tree under
 *  test. A `**` pattern is the same defect as a `readdirSync` recursion with a
 *  shorter spelling — it descends through whatever is on disk — so it goes
 *  through this file too rather than being reasoned about as a special case.
 *
 *  Results are filtered rather than the traversal being pruned: correctness is
 *  the point, and a nested checkout is a handful of directories, not a cost. */
export async function* boundedGlob(pattern, options) {
  const cwd = options?.cwd ?? process.cwd();
  for await (const match of glob(pattern, options)) {
    if (withinTree(cwd, match)) yield match;
  }
}
