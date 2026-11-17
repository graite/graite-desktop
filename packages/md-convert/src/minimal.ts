/**
 * Minimal-diff save (docs/design/editor-roundtrip.md §5).
 *
 * The editor serializes the whole document in canonical form, so the first edit used to
 * normalise every untouched line of a hand-written file (`*` bullets, `*em*`, table padding,
 * blank lines). `minimalSave` keeps the text on disk wherever the user did not edit: a
 * line-based three-way merge with
 *
 *   base   = canonical form of the document as it was loaded,
 *   ours   = canonical form of the document now,
 *   theirs = the text on disk at load.
 *
 * Where the editor changed a region, the editor's lines win. The result is only used when it
 * parses to the same document as `ours`; otherwise the canonical text is returned unchanged.
 */
import { fromBlocks, toBlocks } from "./blocks";

function lines(text: string): string[] {
  return text.split("\n");
}

/**
 * Pairs `[i, j]` of equal lines forming a longest common subsequence of `a` and `b`, after
 * trimming the common prefix and suffix. Falls back to prefix/suffix only when the middle is
 * too large for the quadratic table.
 */
function matches(a: string[], b: string[]): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    out.push([start, start]);
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  const tail: [number, number][] = [];
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    tail.push([endA, endB]);
  }
  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && n * m <= 4_000_000) {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] =
          a[start + i] === b[start + j]
            ? table[(i + 1) * width + j + 1]! + 1
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        out.push([start + i, start + j]);
        i++;
        j++;
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++;
      else j++;
    }
  }
  tail.reverse();
  out.push(...tail);
  return out;
}

function same(a: string[], aFrom: number, aTo: number, b: string[], bFrom: number, bTo: number) {
  if (aTo - aFrom !== bTo - bFrom) return false;
  for (let k = 0; k < aTo - aFrom; k++) if (a[aFrom + k] !== b[bFrom + k]) return false;
  return true;
}

const BULLET = /^(\s*)([-*+])(\s)/;

/**
 * A list item the editor added is written with `-`; next to items the file spells with `*`
 * or `+` it would start a second list, so it takes its neighbour's marker.
 */
function adoptBullets(out: string[], own: Set<number>): void {
  for (const index of own) {
    const item = BULLET.exec(out[index]!);
    if (!item) continue;
    for (const step of [-1, 1]) {
      let at = index + step;
      while (own.has(at)) at += step;
      const near = BULLET.exec(out[at] ?? "");
      if (near && near[1] === item[1]) {
        if (near[2] !== item[2]) out[index] = out[index]!.replace(BULLET, `$1${near[2]}$3`);
        break;
      }
    }
  }
}

/** The three-way merge itself; exported for tests. */
export function merge3(base: string, ours: string, theirs: string): string {
  const b = lines(base);
  const o = lines(ours);
  const t = lines(theirs);
  const toOurs = new Map(matches(b, o));
  const toTheirs = new Map(matches(b, t));
  const fromOurs = new Map([...toOurs].map(([base, mine]) => [mine, base]));
  const out: string[] = [];
  // Indexes into `out` of the lines that are the editor's own (changed or added).
  const own = new Set<number>();
  const mine = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      own.add(out.length);
      out.push(o[k]!);
    }
  };
  let bi = 0;
  let oi = 0;
  let ti = 0;
  const flush = (bEnd: number, oEnd: number, tEnd: number) => {
    // An unstable region: untouched by the editor means the disk text stays.
    if (same(b, bi, bEnd, o, oi, oEnd)) out.push(...t.slice(ti, tEnd));
    else if (bEnd - bi === tEnd - ti) {
      // The disk differs line for line (bullet markers, emphasis, table padding): a line the
      // editor kept takes the disk's spelling, a line it changed or added is the editor's.
      for (let k = oi; k < oEnd; k++) {
        const kept = fromOurs.get(k);
        if (kept !== undefined && kept >= bi && kept < bEnd) out.push(t[ti + kept - bi]!);
        else mine(k, k + 1);
      }
    } else mine(oi, oEnd);
    bi = bEnd;
    oi = oEnd;
    ti = tEnd;
  };
  for (let k = 0; k < b.length; k++) {
    const inOurs = toOurs.get(k);
    const inTheirs = toTheirs.get(k);
    if (inOurs === undefined || inTheirs === undefined) continue;
    // Line k of the base survives on both sides: it closes the region before it.
    flush(k, inOurs, inTheirs);
    out.push(t[inTheirs]!);
    bi = k + 1;
    oi = inOurs + 1;
    ti = inTheirs + 1;
  }
  flush(b.length, o.length, t.length);
  adoptBullets(out, own);
  return out.join("\n");
}

/**
 * The text to write for an edited document.
 *
 * @param disk the body on disk when the document was loaded
 * @param baseline `fromBlocks` of the document as loaded
 * @param next `fromBlocks` of the document now
 */
export function minimalSave(disk: string, baseline: string, next: string): string {
  if (disk === baseline || baseline === next) return baseline === next ? disk : next;
  let merged: string;
  try {
    // Empty-paragraph markers at the end of the file are not content (`fromBlocks` no longer
    // writes them); left in, new text typed at the end would land after them.
    merged = merge3(baseline, next, disk.replace(/(\n+<!-- graite:empty -->)+\n*$/, "\n"));
    // Compared as documents, not as text: a `graite:empty` marker left at the end of the file
    // is the same document as one without it.
    if (fromBlocks(toBlocks(merged)) !== fromBlocks(toBlocks(next))) return next;
  } catch {
    return next;
  }
  return merged;
}
