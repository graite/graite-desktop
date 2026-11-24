import { useEffect, useState } from "react";
import {
  Archive,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  Inbox,
  Mail,
  PenLine,
  Plus,
  Send,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DRAFTS, mail, type MailFolder } from "@/lib/mail";
import { scopedKey } from "@/lib/storage";
import type { MailState } from "./useMail";

const FOLDED_KEY = "graite.mail.folded";
// Folders the user does not want to see, per account: `{ accountId: [folder names] }`.
const HIDDEN_KEY = "graite.mail.hiddenFolders";

function readHidden(): Record<string, string[]> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(scopedKey(HIDDEN_KEY)) ?? "{}");
    return value && typeof value === "object" ? (value as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

const folderIcon = (role: string) =>
  role === "inbox" ? Inbox : role === "sent" ? Send : role === "archive" ? Archive : Folder;

function readFolded(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(scopedKey(FOLDED_KEY)) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** The sidebar while Mail is chosen: every account, each folding open to its folders like a
 * page folds open to its subpages. */
export function MailRail({ state, onOpen }: { state: MailState; onOpen: () => void }) {
  const { accounts, current, shownFolder, search, version } = state;
  const [folded, setFolded] = useState<string[]>(readFolded);
  const [folders, setFolders] = useState<Record<string, MailFolder[]>>({});
  const [hovered, setHovered] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Record<string, string[]>>(readHidden);
  /** Hide folders of an account, or with `show` put them back. The mail itself is untouched. */
  const setFolderHidden = (accountId: string, names: string[], show = false) => {
    // Hiding the folder that is open: go to the inbox, so it leaves the list at once.
    if (!show && accountId === current && shownFolder && names.includes(shownFolder))
      state.choose(accountId);
    setHidden((old) => {
      const before = old[accountId] ?? [];
      const next = {
        ...old,
        [accountId]: show
          ? before.filter((name) => !names.includes(name))
          : [...new Set([...before, ...names])],
      };
      try {
        localStorage.setItem(scopedKey(HIDDEN_KEY), JSON.stringify(next));
      } catch {
        /* storage unavailable: hidden until the app closes */
      }
      return next;
    });
  };

  const ids = (accounts ?? []).map((a) => a.id).join(",");
  useEffect(() => {
    let live = true;
    for (const id of ids ? ids.split(",") : []) {
      if (folded.includes(id)) continue;
      mail
        .folders(id)
        .then((found) => live && setFolders((old) => ({ ...old, [id]: found.folders })))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [ids, folded, version]);

  const toggle = (id: string) =>
    setFolded((old) => {
      const next = old.includes(id) ? old.filter((x) => x !== id) : [...old, id];
      try {
        localStorage.setItem(scopedKey(FOLDED_KEY), JSON.stringify(next));
      } catch {
        /* storage unavailable: folding lasts until the app closes */
      }
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">Mail</span>
        <button
          className="grid size-7 place-items-center rounded-md hover:bg-accent"
          title="Add a mail account"
          aria-label="Add a mail account"
          onClick={() => state.setAdding(true)}
        >
          <Plus className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {accounts?.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            No mail accounts yet. Click + to add one.
          </p>
        )}
        {accounts?.map((item) => {
          const open = !folded.includes(item.id);
          const all = folders[item.id] ?? [];
          const off = hidden[item.id] ?? [];
          const isShown = (f: MailFolder) => !off.includes(f.name);
          const shown = all.filter(isShown);
          const away = all.filter((f) => !isShown(f));
          const empty = shown.filter((f) => f.total === 0 && f.role !== "inbox");
          return (
            <div key={item.id} className="mb-0.5">
              <div
                className="flex items-center gap-1 rounded-md px-1 text-sm hover:bg-accent"
                onMouseEnter={() => setHovered(item.id)}
                onMouseLeave={() => setHovered(null)}
              >
                <button
                  className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent-foreground/10"
                  aria-label={open ? `Fold ${item.name}` : `Unfold ${item.name}`}
                  aria-expanded={open}
                  onClick={() => toggle(item.id)}
                >
                  {hovered === item.id ? (
                    <ChevronRight
                      className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
                    />
                  ) : (
                    <Mail className="size-4 text-muted-foreground" />
                  )}
                </button>
                <button
                  onClick={() => {
                    state.choose(item.id);
                    if (!open) toggle(item.id);
                    onOpen();
                  }}
                  aria-current={item.id === current ? "true" : undefined}
                  title={item.email}
                  className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left ${item.id === current ? "font-medium" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item.state === "error" ? (
                    <span className="text-xs text-destructive" title={item.error}>
                      !
                    </span>
                  ) : item.unread > 0 ? (
                    <span className="text-xs text-muted-foreground">{item.unread}</span>
                  ) : null}
                </button>
              </div>
              {open &&
                shown.map((f) => {
                  const Icon = folderIcon(f.role);
                  const active =
                    item.id === current &&
                    !search &&
                    (f.name === shownFolder || (!shownFolder && f.role === "inbox"));
                  return (
                    <div
                      key={f.name}
                      className={`group/folder flex items-center rounded-md text-sm hover:bg-accent ${active ? "bg-accent" : ""}`}
                    >
                      <button
                        onClick={() => {
                          state.choose(item.id, f.name);
                          onOpen();
                        }}
                        aria-current={active ? "true" : undefined}
                        className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-1 pl-7 text-left"
                      >
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{f.title}</span>
                        {f.unread > 0 && (
                          <span className="text-xs text-muted-foreground group-hover/folder:hidden">
                            {f.unread}
                          </span>
                        )}
                      </button>
                      {f.role !== "inbox" && (
                        <button
                          className="mr-1 hidden size-5 shrink-0 place-items-center rounded text-muted-foreground group-hover/folder:grid hover:bg-accent-foreground/10 hover:text-foreground"
                          title={`Hide ${f.title} from this list`}
                          aria-label={`Hide ${f.title}`}
                          onClick={() => setFolderHidden(item.id, [f.name])}
                        >
                          <EyeOff className="size-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              {open && (folders[item.id]?.length ?? 0) > 0 && (
                <button
                  onClick={() => {
                    state.choose(item.id, DRAFTS);
                    onOpen();
                  }}
                  aria-current={item.id === current && state.showsDrafts ? "true" : undefined}
                  className={`flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-7 text-left text-sm hover:bg-accent ${item.id === current && state.showsDrafts ? "bg-accent" : ""}`}
                >
                  <PenLine className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">Drafts</span>
                  {item.drafts > 0 && (
                    <span className="text-xs text-muted-foreground">{item.drafts}</span>
                  )}
                </button>
              )}
              {open && (away.length > 0 || empty.length > 0) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-7 text-left text-xs text-muted-foreground hover:bg-accent"
                      aria-label={`Hidden folders of ${item.name}`}
                    >
                      <EyeOff className="size-3.5 shrink-0" />
                      {away.length > 0 ? `${away.length} hidden` : "Hide folders"}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-80 w-60 overflow-y-auto">
                    {empty.length > 0 && (
                      <DropdownMenuItem
                        onSelect={() =>
                          setFolderHidden(
                            item.id,
                            empty.map((f) => f.name),
                          )
                        }
                      >
                        <EyeOff />
                        Hide {empty.length} empty {empty.length === 1 ? "folder" : "folders"}
                      </DropdownMenuItem>
                    )}
                    {empty.length > 0 && away.length > 0 && <DropdownMenuSeparator />}
                    {away.length > 0 && (
                      <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                        Hidden: click to show again
                      </DropdownMenuLabel>
                    )}
                    {away.map((f) => (
                      <DropdownMenuItem
                        key={f.name}
                        onSelect={() => setFolderHidden(item.id, [f.name], true)}
                      >
                        <Eye />
                        <span className="min-w-0 flex-1 truncate">{f.title}</span>
                        {f.total > 0 && (
                          <span className="text-xs text-muted-foreground">{f.total}</span>
                        )}
                      </DropdownMenuItem>
                    ))}
                    {away.length > 1 && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() =>
                            setFolderHidden(
                              item.id,
                              away.map((f) => f.name),
                              true,
                            )
                          }
                        >
                          Show all
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
