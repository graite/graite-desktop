/**
 * The assistant's memories as the Memory tab shows them: one page per memory (daemon:
 * `assistant/memory.py`), grouped by Kind, filtered by a search box. Kind and Pinned are
 * ordinary page properties, so changing one is a property write like on any list.
 */
import type { MemoryItem } from "@/lib/assistant";
import type { PageProperty } from "@/lib/workspace";

/** Same order and colours as KINDS / KIND_COLORS in `assistant/memory.py`. */
export const MEMORY_KINDS = [
  "About",
  "Preference",
  "Person",
  "Project",
  "Routine",
  "Lesson",
  "Other",
] as const;
const KIND_COLORS: Record<string, string> = {
  About: "blue",
  Preference: "purple",
  Person: "pink",
  Project: "green",
  Routine: "yellow",
  Lesson: "orange",
  Other: "gray",
};

export interface MemoryGroup {
  kind: string;
  items: MemoryItem[];
}

/** Every word of the query appears in the title or the body (case-insensitive). */
export function matches(item: MemoryItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${item.title}\n${item.body ?? ""}\n${item.kind ?? ""}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Pinned first within a kind, then by title; kinds in their fixed order, unknown last. */
export function groupMemories(items: MemoryItem[], query = ""): MemoryGroup[] {
  const shown = query.trim() ? items.filter((i) => matches(i, query)) : items;
  const byKind = new Map<string, MemoryItem[]>();
  for (const item of shown) {
    const kind = item.kind && item.kind.trim() ? item.kind : "No kind";
    byKind.set(kind, [...(byKind.get(kind) ?? []), item]);
  }
  const order = [
    ...MEMORY_KINDS,
    ...[...byKind.keys()].filter((k) => !(MEMORY_KINDS as readonly string[]).includes(k)).sort(),
  ];
  return order
    .filter((kind) => byKind.has(kind))
    .map((kind) => ({
      kind,
      items: byKind
        .get(kind)!
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title)),
    }));
}

/** The page's properties with Kind and/or Pinned set; adds the field when the page lacks it. */
export function withMemoryFields(
  properties: PageProperty[],
  change: { kind?: string | null; pinned?: boolean },
): PageProperty[] {
  let next = properties.map((p) => ({ ...p }));
  const find = (name: string) => next.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (change.kind !== undefined) {
    const field = find("Kind");
    const options = [
      ...new Set([
        ...(field?.options ?? []),
        ...MEMORY_KINDS,
        ...(change.kind ? [change.kind] : []),
      ]),
    ];
    if (field) {
      field.options = options;
      field.value = change.kind;
    } else {
      next = [
        ...next,
        {
          id: "kind",
          name: "Kind",
          type: "single_select",
          options,
          colors: { ...KIND_COLORS },
          value: change.kind,
        },
      ];
    }
  }
  if (change.pinned !== undefined) {
    const field = find("Pinned");
    if (field) field.value = change.pinned;
    else
      next = [
        ...next,
        { id: "pinned", name: "Pinned", type: "checkbox", options: [], value: change.pinned },
      ];
  }
  return next;
}

/** "today", "yesterday", "3 days ago" or the date, for "last came up". */
export function recalledLabel(date: string | null | undefined, now = new Date()): string {
  if (!date) return "Not recalled yet";
  const then = new Date(`${date}T00:00:00Z`);
  const days = Math.round(
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - then.getTime()) /
      86_400_000,
  );
  if (Number.isNaN(days)) return "";
  if (days <= 0) return "Recalled today";
  if (days === 1) return "Recalled yesterday";
  if (days < 30) return `Recalled ${days} days ago`;
  return `Recalled ${then.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}`;
}
