/** Open page tabs: an ordered list of page paths. Pure helpers, so the rules are testable. */

const under = (path: string, root: string) => path === root || path.startsWith(root + "/");

/** Show `path` in a tab. It reuses the tab of `from` (plain navigation) unless `newTab` is set
 * or `from` has no tab; a page that already has a tab keeps it. */
export function showInTab(
  tabs: string[],
  path: string,
  from: string | null,
  newTab: boolean,
): string[] {
  if (tabs.includes(path)) return tabs;
  const at = from && !newTab ? tabs.indexOf(from) : -1;
  if (at < 0) return [...tabs, path];
  const next = [...tabs];
  next[at] = path;
  return next;
}

/** Close a tab. `active` is the tab to show afterwards: the right neighbour, else the left. */
export function closeTab(
  tabs: string[],
  path: string,
  active: string | null,
): { tabs: string[]; active: string | null } {
  const at = tabs.indexOf(path);
  if (at < 0) return { tabs, active };
  const next = tabs.filter((p) => p !== path);
  if (active !== path) return { tabs: next, active };
  return { tabs: next, active: next[at] ?? next[at - 1] ?? null };
}

/** A page (and so its subpages) moved or was renamed. */
export function renameTabs(tabs: string[], oldPath: string, newPath: string): string[] {
  const next = tabs.map((p) => (under(p, oldPath) ? newPath + p.slice(oldPath.length) : p));
  return [...new Set(next)];
}

/** A page went to the trash: its tab and those of its subpages go too. */
export function dropTabs(tabs: string[], path: string): string[] {
  return tabs.filter((p) => !under(p, path));
}

/** The tab `step` places after `active`, wrapping around. */
export function cycleTab(tabs: string[], active: string | null, step: 1 | -1): string | null {
  if (!tabs.length) return null;
  const at = active ? tabs.indexOf(active) : -1;
  if (at < 0) return tabs[0]!;
  return tabs[(at + step + tabs.length) % tabs.length]!;
}

export function parseTabs(raw: string | null): string[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** A conversation open in a tab next to the pages: its id, and its title as last seen. */
export interface ChatTab {
  id: string;
  title: string;
}

/** Give a conversation a tab, or bring its tab's title up to date. */
export function showChatTab(tabs: ChatTab[], chat: ChatTab): ChatTab[] {
  const at = tabs.findIndex((t) => t.id === chat.id);
  if (at < 0) return [...tabs, chat];
  if (tabs[at]!.title === chat.title) return tabs;
  const next = [...tabs];
  next[at] = chat;
  return next;
}

/** Close a conversation's tab; `next` is the one to show when it was the open one. */
export function closeChatTab(
  tabs: ChatTab[],
  id: string,
): { tabs: ChatTab[]; next: ChatTab | null } {
  const at = tabs.findIndex((t) => t.id === id);
  if (at < 0) return { tabs, next: null };
  const left = tabs.filter((t) => t.id !== id);
  return { tabs: left, next: left[at] ?? left[at - 1] ?? null };
}

export function parseChatTabs(raw: string | null): ChatTab[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) return [];
    return value.filter(
      (t): t is ChatTab =>
        !!t && typeof (t as ChatTab).id === "string" && typeof (t as ChatTab).title === "string",
    );
  } catch {
    return [];
  }
}
