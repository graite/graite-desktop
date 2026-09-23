/**
 * The assistant's memory pages as rows: `## ` sections of one-line bullets (the Profile), or a
 * single flat list (Playbook, Journal). Parsing keeps everything that is not a plain bullet
 * (paragraphs, nested items, code) as verbatim blocks, so editing one fact never loses the rest
 * of the page. Writing normalises only the spacing: bullets of a section are one tight list,
 * blocks are one blank line apart, and the editor's empty-paragraph markers are dropped.
 */

/** The sections of the pre-D56 Profile page, in order (now only read by the upgrade). */
export const PROFILE_SECTIONS = [
  "About",
  "Preferences",
  "People",
  "Projects & work",
  "Routines",
  "Other",
] as const;

const EMPTY_MARKER = "<!-- graite:empty -->";
const HEADING = /^##[ \t]+(.+?)[ \t#]*$/;
const ITEM = /^([-*+][ \t]+(?:\[[ xX]\][ \t]+)?)(.*)$/;
const FENCE = /^[ \t]*(```|~~~)/;

export type MemoryEntry =
  | { kind: "item"; marker: string; text: string; more: string[] }
  | { kind: "block"; lines: string[] };

export interface MemorySection {
  /** null: whatever comes before the first `## ` heading. */
  title: string | null;
  entries: MemoryEntry[];
}

export function parseMemory(body: string): MemorySection[] {
  const sections: MemorySection[] = [{ title: null, entries: [] }];
  let section = sections[0]!;
  let fence: string | null = null;
  let blank = true; // the previous line was blank (or this is the start of a section)
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const last = section.entries[section.entries.length - 1];
    if (fence) {
      if (last?.kind === "block") last.lines.push(line);
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    const opens = FENCE.exec(line);
    if (opens) {
      fence = opens[1]!;
      if (last?.kind === "block" && !blank) last.lines.push(line);
      else section.entries.push({ kind: "block", lines: [line] });
      blank = false;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed === EMPTY_MARKER) {
      blank = true;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      section = { title: heading[1]!.trim(), entries: [] };
      sections.push(section);
      blank = true;
      continue;
    }
    const item = ITEM.exec(line);
    if (item && item[2]!.trim()) {
      section.entries.push({
        kind: "item",
        marker: item[1]!.replace(/[ \t]+/g, " "),
        text: item[2]!.trim(),
        more: [],
      });
    } else if (last?.kind === "item" && !blank && /^[ \t]/.test(line)) {
      last.more.push(line); // nested items and continuation lines belong to their item
    } else if (last?.kind === "block" && !blank) {
      last.lines.push(line);
    } else {
      section.entries.push({ kind: "block", lines: [line] });
    }
    blank = false;
  }
  return sections;
}

export function serializeMemory(sections: MemorySection[]): string {
  const parts: string[] = [];
  for (const section of sections) {
    const chunks: string[] = [];
    let list: string[] = [];
    for (const entry of section.entries) {
      if (entry.kind === "item") {
        list.push([`${entry.marker}${entry.text}`, ...entry.more].join("\n"));
        continue;
      }
      if (list.length) chunks.push(list.join("\n"));
      list = [];
      chunks.push(entry.lines.join("\n"));
    }
    if (list.length) chunks.push(list.join("\n"));
    if (section.title === null) {
      if (chunks.length) parts.push(chunks.join("\n\n"));
    } else {
      parts.push([`## ${section.title}`, ...chunks].join("\n\n"));
    }
  }
  return parts.length ? parts.join("\n\n") + "\n" : "";
}

/** A copy that can be changed without touching `sections`. */
function clone(sections: MemorySection[]): MemorySection[] {
  return sections.map((s) => ({
    title: s.title,
    entries: s.entries.map((e) =>
      e.kind === "item" ? { ...e, more: [...e.more] } : { kind: "block", lines: [...e.lines] },
    ),
  }));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Replace the text of one item; an empty text deletes it. */
export function editItem(
  sections: MemorySection[],
  section: number,
  entry: number,
  text: string,
): MemorySection[] {
  const next = clone(sections);
  const target = next[section]?.entries[entry];
  if (!target || target.kind !== "item") return sections;
  if (!oneLine(text)) next[section]!.entries.splice(entry, 1);
  else target.text = oneLine(text);
  return next;
}

export function removeItem(
  sections: MemorySection[],
  section: number,
  entry: number,
): MemorySection[] {
  return editItem(sections, section, entry, "");
}

/**
 * Add a bullet at the end of the section titled `title` (null: the untitled start). A Profile
 * section that does not exist yet is created in its place in PROFILE_SECTIONS order.
 */
export function addItem(
  sections: MemorySection[],
  title: string | null,
  text: string,
): MemorySection[] {
  const fact = oneLine(text);
  if (!fact) return sections;
  const next = clone(sections);
  let target = next.find((s) => s.title === title);
  if (!target) {
    target = { title, entries: [] };
    const order = (t: string | null) =>
      PROFILE_SECTIONS.indexOf(t as (typeof PROFILE_SECTIONS)[number]);
    const rank = order(title);
    const before = rank < 0 ? -1 : next.findIndex((s) => order(s.title) > rank);
    if (title === null) next.unshift(target);
    else if (before < 0) next.push(target);
    else next.splice(before, 0, target);
  }
  const marker = target.entries.find((e) => e.kind === "item")?.marker ?? "- ";
  target.entries.push({
    kind: "item",
    marker: marker.replace(/\[[xX]\] /, "[ ] "),
    text: fact,
    more: [],
  });
  return next;
}

/** The last `count` entries of a flat page (the Journal), newest last. */
export function lastEntries(sections: MemorySection[], count: number): MemoryEntry[] {
  return sections.flatMap((s) => s.entries).slice(-count);
}

/** Plain text of an entry, for a read-only row. */
export function entryText(entry: MemoryEntry): string {
  return entry.kind === "item" ? entry.text : entry.lines.join(" ").trim();
}
