// ─────────────────────────────────────────────────────────────────────────────
// fit-ops-body.mjs — fit an ops report to the bridge's POST /ops body cap before
// it is sent, so a report is never refused for its size.
//
// ⏱ 2026-10-06 · ops-digest-fit (fix-first). The bridge refuses an `ops-issue`
// body over OPS_BODY_MAX_BYTES (services/gh-bridge/src/ops.ts parseOps, 400
// `body exceeds 61440 bytes`). The weekly digest carries the WHOLE output of a
// red assert-ops-register.mjs, and the last digest the old flow posted
// (`gh issue create`, issue "Weekly ops digest", 2026-10-06T00:57Z) measured
// 127,084 chars / 129,159 UTF-8 bytes, 119 KB of it that one red section. So
// the shell's first digest through the bridge (run 37434011444, step
// digest.4) was refused, and every digest after it would be.
//
// A VERDICT LINE IS NEVER CUT (review of #14, finding 1): a line that starts
// with ✗ / ❌ / 🔴 (and the indented lines that continue a ✗ or ❌ line — the
// register prints each blocking verdict there), a line naming RED, LOST or
// BLOCKING, and every `exit` line. The first version cut a span greedily, and
// with two large red sections the larger lost its whole span, its
// `✗ COVERAGE LOST` verdict included.
//
// The client fits the body, in this order, and stops at the first that fits:
//   1 · it already fits — sent byte for byte, untouched;
//   2 · every GREEN section (a fenced block ending `exit: 0`) is reduced to its
//       summary line (the guard's own last word) and its exit line;
//   3 · non-verdict lines are dropped from the MIDDLE of the largest red
//       section outward, then the next largest, then any other section; each
//       run of dropped lines becomes ONE `[… N line(s) / M bytes cut to fit …]`
//       line. A heading and a fence are outside the span a cut may take;
//   4 · the verdicts alone still overflow: every green section goes down to
//       its exit line;
//   5 · and still: the middle of the whole text is cut with the same marker
//       (the only step that may take a verdict line — printed as such), and a
//       text below the marker's own size is truncated with a short marker.
// A cut is never silent: the marker names what went, and fitOpsBody returns
// the notes ops-issue.mjs prints in the step log.
//
// Fences are parsed as markdown parses them: a fence of N backticks opens a
// block, and only a line of at least N backticks and nothing else closes it —
// so a reader line starting with backticks inside a block cannot open, close or
// split a section.
//
// Sizes are UTF-8 BYTES (what the bridge counts), never JS string lengths: a
// body of 4-byte emoji is 2 UTF-16 units and 4 bytes per character, and a cut
// never splits a character. The result is also within GitHub's 65,536-char
// comment limit, because chars <= bytes and the bridge's header is short.
// ─────────────────────────────────────────────────────────────────────────────

/** @ceiling none — mirrors services/gh-bridge/src/ops.ts OPS_BODY_MAX_BYTES (tooling/ci/test/bridge-ops.test.mjs pins the two equal). */
export const OPS_BODY_MAX_BYTES = 60 * 1024;

const enc = new TextEncoder();
export const utf8Bytes = (s) => enc.encode(s).byteLength;

/** The longest prefix of `s` within `max` UTF-8 bytes, never splitting a code point. */
function prefixWithin(s, max) {
  let bytes = 0;
  let i = 0;
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (bytes + b > max) break;
    bytes += b;
    i += ch.length;
  }
  return s.slice(0, i);
}

/** The longest suffix of `s` within `max` UTF-8 bytes, never splitting a code point. */
function suffixWithin(s, max) {
  const cps = [...s];
  let bytes = 0;
  let n = 0;
  for (let k = cps.length - 1; k >= 0; k--) {
    const b = utf8Bytes(cps[k]);
    if (bytes + b > max) break;
    bytes += b;
    n += cps[k].length;
  }
  return n === 0 ? '' : s.slice(s.length - n);
}

export const cutMarker = (lines, bytes) => `[… ${lines} line(s) / ${bytes} bytes cut to fit the bridge's ${OPS_BODY_MAX_BYTES}-byte ops body cap …]`;

/**
 * Cut the middle of `text` so the result is at most `max` bytes, the marker on a line of its own where the cut was.
 * Whole lines are kept when a line boundary lies in the kept head or tail; a single overlong line is cut inside.
 * → {text, lines, bytes} (lines and bytes cut). When `max` is below the marker's own size the whole text goes and
 * the marker alone is returned, over `max`: the caller re-measures, and never sends a result it has not measured.
 */
export function cutMiddle(text, max) {
  if (utf8Bytes(text) <= max) return { text, lines: 0, bytes: 0 };
  // The marker's own size depends on the numbers in it: reserve for the widest it can be.
  const reserve = utf8Bytes(cutMarker(text.length, utf8Bytes(text))) + 2;
  const room = Math.max(0, max - reserve);
  let head = prefixWithin(text, Math.floor(room / 2));
  if (head.includes('\n')) head = head.slice(0, head.lastIndexOf('\n') + 1);
  let tail = suffixWithin(text, room - utf8Bytes(head));
  if (tail.includes('\n') && tail.indexOf('\n') < tail.length - 1) tail = tail.slice(tail.indexOf('\n') + 1);
  const cut = text.slice(head.length, text.length - tail.length);
  const lines = cut.split('\n').length - (cut.endsWith('\n') ? 1 : 0);
  const marker = cutMarker(lines, utf8Bytes(cut));
  const out = `${head}${head === '' || head.endsWith('\n') ? '' : '\n'}${marker}\n${tail}`;
  return { text: out, lines, bytes: utf8Bytes(cut) };
}

/** A verdict line: never cut before step 5. */
export const VERDICT_LINE = /^\s*(✗|❌|🔴)|\b(RED|LOST|BLOCKING)\b|^exit[: ]/;
const CONTINUED_BY_INDENT = /^\s*(✗|❌)/;

/** PURE. `lines` → a boolean per line: is it a verdict line, or an indented line continuing a ✗ / ❌ one? */
export function verdictFlags(lines) {
  let cont = false;
  return lines.map((l) => {
    const indented = /^\s+\S/.test(l);
    const v = VERDICT_LINE.test(l) || (cont && indented);
    cont = CONTINUED_BY_INDENT.test(l) || (cont && indented);
    return v;
  });
}

const FENCE_OPEN = /^(`{3,})/;
const closesFence = (line, n) => new RegExp(`^\`{${n},}\\s*$`).test(line);

/**
 * The body as sections: the preamble before the first `## ` heading, then one per heading outside a fence. A
 * section with a fenced block carries `open` / `close` (the fence lines); one whose block ends in `exit: <code>`
 * (the digest's reader shape) also carries `exit` and `exitAt`.
 */
export function sections(body) {
  const lines = body.split('\n');
  const out = [];
  let cur = { lines: [] };
  let fence = 0;
  for (const line of lines) {
    if (!fence && line.startsWith('## ') && (cur.lines.length || out.length)) {
      out.push(cur);
      cur = { lines: [] };
    }
    if (fence) {
      if (closesFence(line, fence)) {
        fence = 0;
        if (cur.close === undefined) cur.close = cur.lines.length;
      }
    } else {
      const m = FENCE_OPEN.exec(line);
      if (m) {
        fence = m[1].length;
        if (cur.open === undefined) cur.open = cur.lines.length;
      }
    }
    cur.lines.push(line);
  }
  out.push(cur);
  for (const s of out) {
    if (s.open !== undefined && s.close !== undefined && s.close - 1 > s.open && /^exit: \S/.test(s.lines[s.close - 1])) {
      s.exitAt = s.close - 1;
      s.exit = s.lines[s.exitAt].slice('exit: '.length).trim();
    }
  }
  return out;
}

const join = (secs) => secs.map((s) => s.lines.join('\n')).join('\n');
const name = (s) => (s.lines[0]?.startsWith('## ') ? s.lines[0].slice(3) : 'the preamble');
const isRed = (s) => s.exit !== undefined && s.exit !== '0';

/** Reduce a green section to heading, fence, a marker, then its summary line (or none, `bare`) and its exit line. */
function reduceGreen(s, bare = false) {
  const keepFrom = bare ? s.exitAt : s.exitAt - 1;
  const body = s.lines.slice(s.open + 1, keepFrom).filter((l) => !l.startsWith('[… '));
  const went = s.lines.slice(s.open + 1, keepFrom);
  if (went.length === 0 || (went.length === 1 && went[0].startsWith('[… '))) return null;
  const n = body.length + (bare && s.reduced ? s.reduced : 0);
  const bytes = utf8Bytes(body.join('\n')) + (bare && s.reducedBytes ? s.reducedBytes : 0);
  const marker = `[… ${n} line(s) / ${bytes} bytes of a GREEN section cut to fit — ${bare ? 'its exit line follows' : 'its summary and exit line follow'} …]`;
  s.lines = [...s.lines.slice(0, s.open + 1), marker, ...s.lines.slice(keepFrom)];
  s.exitAt = s.open + 2 + (bare ? 0 : 1);
  s.close = s.exitAt + 1;
  s.reduced = n;
  s.reducedBytes = bytes;
  return `${name(s)}: green, reduced to ${bare ? 'its exit line' : 'its summary and exit line'} (${n} line(s) cut)`;
}

/** Render `lines` with every maximal run of dropped indices replaced by one marker. */
function render(lines, dropped) {
  const out = [];
  let run = null;
  const flush = () => {
    if (run) out.push(cutMarker(run.n, utf8Bytes(run.text.join('\n'))));
    run = null;
  };
  lines.forEach((l, i) => {
    if (dropped.has(i)) {
      run ??= { n: 0, text: [] };
      run.n += 1;
      run.text.push(l);
    } else {
      flush();
      out.push(l);
    }
  });
  flush();
  return out;
}

/** Drop non-verdict lines of one section's span, middle outward, until the whole body is within `max` or none
 *  are left. → a note, or null when nothing could be dropped. */
function cutSection(secs, s, max) {
  const fenced = s.open !== undefined && s.close !== undefined;
  const from = fenced ? s.open + 1 : s.lines[0]?.startsWith('## ') ? 1 : 0;
  const to = fenced ? s.close : s.lines.length;
  const span = s.lines.slice(from, to);
  const keep = verdictFlags(span);
  const centre = (span.length - 1) / 2;
  const order = span.map((_, i) => i).filter((i) => !keep[i]).sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);
  if (order.length === 0) return null;
  const rest = utf8Bytes(join(secs)) - utf8Bytes(span.join('\n'));
  const fits = (lines) => rest + utf8Bytes(lines.join('\n')) <= max;
  const need = utf8Bytes(join(secs)) - max;
  const dropped = new Set();
  let est = 0;
  let lines = span;
  for (const i of order) {
    dropped.add(i);
    est += utf8Bytes(span[i]) + 1;
    if (est < need) continue;
    lines = render(span, dropped);
    if (fits(lines)) break;
  }
  if (lines === span) lines = render(span, dropped);
  s.lines = [...s.lines.slice(0, from), ...lines, ...s.lines.slice(to)];
  if (fenced) {
    s.close = from + lines.length;
    if (s.exitAt !== undefined) s.exitAt = s.close - 1;
  }
  const bytes = span.filter((_, i) => dropped.has(i)).reduce((a, l) => a + utf8Bytes(l) + 1, 0);
  return `${name(s)}: ${s.exit !== undefined ? `exit ${s.exit}, ` : ''}${dropped.size} non-verdict line(s) / ${bytes} bytes cut from its middle, every verdict line kept`;
}

/**
 * Fit `body` within `max` UTF-8 bytes. → {text, notes}: `notes` is empty when the body was sent untouched, else one
 * line per reduction or cut, in the order they were made.
 */
export function fitOpsBody(body, max = OPS_BODY_MAX_BYTES) {
  if (utf8Bytes(body) <= max) return { text: body, notes: [] };
  const notes = [`the report is ${utf8Bytes(body)} bytes, over the bridge's ${max}-byte cap`];
  const over = () => utf8Bytes(join(secs)) > max;
  const secs = sections(body);
  const greens = secs.filter((s) => s.exit === '0');
  for (const s of greens) {
    if (!over()) break;
    const n = reduceGreen(s);
    if (n) notes.push(n);
  }
  const size = (s) => utf8Bytes(s.lines.join('\n'));
  const order = [...secs.filter(isRed).sort((a, b) => size(b) - size(a)), ...secs.filter((s) => !isRed(s) && s.exit !== '0').sort((a, b) => size(b) - size(a))];
  for (const s of order) {
    if (!over()) break;
    const n = cutSection(secs, s, max);
    if (n) notes.push(n);
  }
  for (const s of greens) {
    if (!over()) break;
    const n = reduceGreen(s, true);
    if (n) notes.push(n);
  }
  let text = join(secs);
  if (utf8Bytes(text) > max) {
    const r = cutMiddle(text, max);
    if (utf8Bytes(r.text) <= max) {
      text = r.text;
      notes.push(`the verdict lines alone overflow: the whole report had ${r.lines} line(s) / ${r.bytes} bytes cut from its middle, verdicts included`);
    } else {
      const mark = '[… truncated to fit …]';
      text = utf8Bytes(mark) + 1 <= max ? `${prefixWithin(text, max - utf8Bytes(mark) - 1)}\n${mark}` : prefixWithin(text, max);
      notes.push('the whole report: truncated to its head, below the size of a cut marker');
    }
  }
  notes.push(`sent ${utf8Bytes(text)} bytes`);
  return { text, notes };
}
