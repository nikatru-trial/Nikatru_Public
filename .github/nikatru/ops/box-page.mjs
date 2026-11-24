// ─────────────────────────────────────────────────────────────────────────────
// box-page.mjs — THE ONE SHARED LEGS PAGER for a page a box-side runner raises.
//
// ⏱ 2026-11-20 · lane ops-guard-tooling-1120 (row O-STD-BOX-PAGE-BOTH-LEGS-CODEMOD; standard std-box-page-both-legs,
// tooling/standards/register.json). The recorded channel is tooling/ops/alarm-chains.json `boxPageChannel` (lead ruling
// lead-steps-1113 step 18): EVERY page goes to EVERY leg — leg 1 `PAGE_URL` (primary, off the box) and leg 2
// `PAGE_URL_2` — it counts as delivered when ANY leg answers 2xx, each leg's result is reported, and a token is sent
// ONLY to the leg it is named for. live-probe.mjs held `pageLegs` and its own post(); four runners (cron-truth,
// probe-sign-in, test-sessions, review-crawl-signed-in) posted to ONE URL, so a dead primary or a Box B loss (leg 2's
// ntfy lives there) silenced them. They now page through pageAllLegs below.
//
// A RUNNER'S LEGS COME FROM ITS OWN SOURCE, so nothing changes on a box until leg 2 is placed: its existing page URL
// is leg 1, and leg 2 is the SAME name with `_2` (its token `<name>_2_TOKEN`, or `_TOKEN_2` for an env runner whose
// leg-1 token is an env). With only leg 1 set it pages exactly as before; with both, both. (Placing leg 2 on a box is
// a box step, named in alarm-chains.json boxPageChannel.readBy.)
// Pinned by tooling/ci/test/box-page.test.mjs; held by tooling/ci/assert-box-page-legs.mjs (a runner that declares a
// page-URL name and does not import this pager is red).
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';

/** A token file's contents (trimmed), or null when it is unset, missing or unreadable. */
export function readSecretFile(path) {
  if (!path) return null;
  try { return readFileSync(path, 'utf8').trim() || null; } catch { return null; }
}

/** The owner page's legs, in order: leg 1 (PAGE_URL, the primary) and, when set, leg 2 (PAGE_URL_2). Each leg
 *  carries ITS OWN token (a file, PAGE_TOKEN_FILE / PAGE_TOKEN_FILE_2, or a value, PAGE_TOKEN / PAGE_TOKEN_2) only:
 *  a token is never sent to the other leg's host. */
export function pageLegs(conf) {
  const leg = (name, url, tokenFile, token) => ({ leg: name, url, tokenFile, ...(token ? { token } : {}) });
  return [
    ...(conf.PAGE_URL ? [leg('primary', conf.PAGE_URL, conf.PAGE_TOKEN_FILE, conf.PAGE_TOKEN)] : []),
    ...(conf.PAGE_URL_2 ? [leg('leg2', conf.PAGE_URL_2, conf.PAGE_TOKEN_FILE_2, conf.PAGE_TOKEN_2)] : []),
  ];
}

/** The legs of a runner whose page URL is a VAULT name: `name` is leg 1, `<name>_2` leg 2, `<name>_2_TOKEN` its token. */
export function vaultPageConf(get, name) {
  return { PAGE_URL: get(name) ?? undefined, PAGE_URL_2: get(`${name}_2`) ?? undefined, PAGE_TOKEN_2: get(`${name}_2_TOKEN`) ?? undefined };
}

/** The legs of a runner whose page URL and token are ENV names: `<url>_2` and `<token>_2` are leg 2's. `suffix` is
 *  appended to each URL (an ntfy server URL + `/<topic>`). */
export function envPageConf(env, urlName, tokenName, suffix = '') {
  const at = (u) => (u ? `${String(u).replace(/\/$/, '')}${suffix}` : undefined);
  return { PAGE_URL: at(env[urlName]), PAGE_TOKEN: env[tokenName] || undefined, PAGE_URL_2: at(env[`${urlName}_2`]), PAGE_TOKEN_2: env[`${tokenName}_2`] || undefined };
}

/**
 * Send ONE page to EVERY leg at once. → { ok, legs: [{ leg, ok, why? }], why? }: `ok` when ANY leg answered 2xx;
 * `why` (when not ok) names each leg's failure, or that no leg is configured. Never throws.
 */
export async function pageAllLegs(conf, text, { headers = {}, timeoutMs = 10_000, fetchImpl = globalThis.fetch, readToken = readSecretFile } = {}) {
  const legs = pageLegs(conf);
  if (!legs.length) return { ok: false, legs: [], why: 'no page leg is configured' };
  const sent = await Promise.all(legs.map(async (l) => {
    const token = l.token ?? readToken(l.tokenFile);
    try {
      const r = await fetchImpl(l.url, { method: 'POST', body: text, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
      // `ok` as fetch's Response reports it (200-299); a stub that gives only a status is read by its status.
      const good = typeof r?.ok === 'boolean' ? r.ok : r?.status >= 200 && r?.status < 300;
      return good ? { leg: l.leg, ok: true } : { leg: l.leg, ok: false, why: `HTTP ${r?.status ?? '?'}` };
    } catch (err) {
      return { leg: l.leg, ok: false, why: err?.name ?? 'fetch failed' };
    }
  }));
  const ok = sent.some((l) => l.ok);
  return { ok, legs: sent, ...(ok ? {} : { why: sent.map((l) => `${l.leg}: ${l.why}`).join('; ') }) };
}
