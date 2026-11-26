import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  Check,
  LoaderCircle,
  FilePenLine,
  FileSearch,
  FileText,
  Forward,
  KeyRound,
  LogIn,
  Mail,
  MoreHorizontal,
  Orbit,
  Paperclip,
  PenLine,
  Plus,
  Reply,
  ReplyAll,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  mail,
  mailDate,
  ownWords,
  type MailAccount,
  type MailDraft,
  type MailMessage,
  type MailThread,
  type MailThreadSummary,
} from "@/lib/mail";
import { formatBytes } from "@/lib/media";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MarkdownAnswer } from "@/chat/MarkdownAnswer";
import "@/models/ai.css";
import type { TreeNode } from "@/lib/api";
import { STAYS_LOCAL } from "./AddAccountDialog";
import { AttachmentDialog, type OpenFile } from "./AttachmentDialog";
import { asDraftHtml, assist, DRAFT_PROMPT, INFO_PROMPT } from "./assist";
import { DraftEditor } from "./DraftEditor";
import { MailAskPanel } from "./MailAskPanel";
import { MessageBody } from "./MessageBody";
import { MENU } from "./menu";
import type { MailState } from "./useMail";
import { VaultChoice } from "./VaultChoice";
import { useMicrosoftSignIn } from "./useMicrosoftSignIn";

const SEARCH_DELAY_MS = 250;
// The actions on a conversation: small and quiet, so the mail itself stands out.
const QUIET =
  "h-7 gap-1.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground [&_svg:not([class*='size-'])]:size-3.5";
// A forwarded mail is its quote: that one stays open.
const FORWARD = /^\s*(fwd?|doorst|wg|tr)\s*:/i;

function statusLine(account: MailAccount): string {
  if (account.state === "error") return account.error;
  if (account.state === "syncing" || account.state === "waiting") return "Fetching mail…";
  return account.synced_at ? `Updated ${mailDate(account.synced_at)}` : "";
}

const initial = (message: MailMessage) =>
  (message.sender_name || message.sender_email || "?").trim().charAt(0).toUpperCase();

/** The Mail tab: the conversations of the chosen account and folder, the reader, and Ask AI
 * beside it. The accounts and folders themselves are in the sidebar (`MailRail`). */
export function MailPage({
  state,
  onSettings,
  onNavigate,
  settingsVersion = 0,
  tree = [],
}: {
  state: MailState;
  /** The pages, to choose one to put an attachment on. */
  tree?: TreeNode[];
  onSettings?: () => void;
  onNavigate?: (path: string) => void;
  settingsVersion?: number;
}) {
  const { accounts, loadError, loadAccounts, account, current, shownFolder, openId, setOpenId } =
    state;
  const { search: input, setSearch: setInput, version, folders } = state;
  const [threads, setThreads] = useState<MailThreadSummary[]>([]);
  const [more, setMore] = useState(false);
  const [query, setQuery] = useState(input.trim());
  const [thread, setThread] = useState<MailThread | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState<MailAccount | null>(null);
  const [repairing, setRepairing] = useState<MailAccount | null>(null);
  const [sendingSettings, setSendingSettings] = useState<MailAccount | null>(null);
  const [drafts, setDrafts] = useState<MailDraft[]>([]);
  const { draftId, setDraftId, showsDrafts } = state;

  const loadDrafts = useCallback(async () => {
    if (!current) return setDrafts([]);
    try {
      setDrafts((await mail.drafts(current)).drafts);
    } catch {
      /* the list keeps what it had */
    }
  }, [current]);
  useEffect(() => void loadDrafts(), [loadDrafts, version]);

  /** Start writing: a new mail, or a reply to a mail of the open conversation. */
  const compose = async (
    reply?: { to: number; all?: boolean; html?: string },
    forward?: number,
  ) => {
    if (!current) return;
    // "New email" twice does not leave an empty draft behind: the empty one is used again.
    const blank = drafts.find((d) => !d.in_reply_to && !d.to && !d.subject && !d.body);
    if (!reply && forward === undefined && blank) {
      setOpenId(null);
      setDraftId(blank.id);
      return;
    }
    try {
      const made = await mail.createDraft(
        current,
        reply
          ? { reply_to: reply.to, reply_all: reply.all, html: reply.html }
          : forward !== undefined
            ? { forward }
            : {},
      );
      if (!reply) setOpenId(null);
      setDrafts((old) => [made, ...old]);
      setDraftId(made.id);
      void loadAccounts();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // The latest request wins: switching account or folder quickly never shows stale mail.
  const listRequest = useRef(0);
  const loadList = useCallback(async () => {
    if (!current) return;
    const ticket = ++listRequest.current;
    try {
      const page = query
        ? await mail.threads(current, { q: query })
        : shownFolder && !showsDrafts
          ? await mail.threads(current, { folder: shownFolder })
          : { threads: [], more: false };
      if (ticket !== listRequest.current) return;
      setThreads(page.threads.filter((t) => !leaving.current.has(t.thread_id)));
      setMore(page.more);
    } catch (e) {
      if (ticket === listRequest.current) toast.error((e as Error).message);
    }
  }, [current, shownFolder, showsDrafts, query]);
  // `version` goes up when new mail came in for this account.
  useEffect(() => void loadList(), [loadList, version]);

  const loadOlder = async () => {
    const last = threads[threads.length - 1];
    if (!current || !last) return;
    try {
      const page = await mail.threads(current, {
        before: last.date,
        ...(query ? { q: query } : { folder: shownFolder ?? undefined }),
      });
      setThreads((old) => [...old, ...page.threads]);
      setMore(page.more);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    setAsking(false);
    if (!current || !openId) {
      setThread(null);
      return;
    }
    let live = true;
    setHelp(null);
    setFound(null);
    helping.current?.abort();
    const show = (found: MailThread) => {
      setThread(found);
      // The newest mail is open; the ones before it are one line each until clicked.
      const last = found.messages[found.messages.length - 1];
      setExpanded(new Set(last ? [last.id] : []));
    };
    // A conversation opened before shows at once; the fresh copy replaces it when it differs.
    const key = `${current}/${openId}`;
    const kept = opened.current.get(key);
    if (kept) show(kept);
    mail
      .thread(current, openId)
      .then((found) => {
        opened.current.set(key, found);
        if (live && (!kept || kept.messages.length !== found.messages.length)) show(found);
        // Opening a mail reads it: the dot goes at once, the mailbox follows.
        if (live && found.messages.some((m) => !m.seen)) {
          setThreads((old) => old.map((t) => (t.thread_id === openId ? { ...t, unread: 0 } : t)));
          void mail
            .markRead(current, openId)
            .then(() => {
              opened.current.set(key, {
                ...found,
                messages: found.messages.map((m) => ({ ...m, seen: true })),
              });
              void loadAccounts();
              state.bump();
            })
            .catch(() => {});
        }
      })
      .catch(() => live && !kept && setThread(null));
    return () => {
      live = false;
    };
  }, [current, openId]);

  // New mail came in (or a reply was just sent): the open conversation shows it too.
  useEffect(() => {
    if (!current || !openId || version === 0) return;
    let live = true;
    mail
      .thread(current, openId)
      .then((found) => {
        if (!live) return;
        setThread((old) => {
          const known = new Set(old?.messages.map((m) => m.id));
          const fresh = found.messages.filter((m) => !known.has(m.id)).map((m) => m.id);
          if (fresh.length) setExpanded((open) => new Set([...open, ...fresh]));
          return found;
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // Only when mail changed; opening a conversation is the effect above.
  }, [version]);

  const opened = useRef(new Map<string, MailThread>());
  // "Generate draft" and "Get info from pages": one runs at a time, shown under the mail.
  const helping = useRef<AbortController | null>(null);
  const [help, setHelp] = useState<{ kind: "draft" | "info"; status: string } | null>(null);
  // What "Get info from pages" found: stays while a draft is written and after.
  const [found, setFound] = useState<{
    text: string;
    pages: { path: string; title: string }[];
  } | null>(null);
  /** A few mails the user sent from this account lately, as examples of how they write.
   * Read from the local copy; they only go along when a draft is asked for. */
  const myVoice = async (): Promise<string[]> => {
    const sent = folders.find((f) => f.role === "sent");
    if (!current || !account || !sent) return [];
    try {
      const recent = (await mail.threads(current, { folder: sent.name })).threads.slice(0, 6);
      const found: string[] = [];
      for (const item of recent) {
        const full = await mail.thread(current, item.thread_id);
        for (const message of full.messages) {
          if (message.sender_email.toLowerCase() !== account.email.toLowerCase()) continue;
          const words = ownWords(message);
          if (words.length >= 40) found.push(words);
        }
        if (found.length >= 4) break;
      }
      return found.slice(-4);
    } catch {
      return []; // a draft without examples is still a draft
    }
  };
  const runHelp = async (kind: "draft" | "info") => {
    if (!thread) return;
    const last = thread.messages[thread.messages.length - 1];
    helping.current?.abort();
    const controller = new AbortController();
    helping.current = controller;
    setHelp({ kind, status: "Looking in your pages…" });
    try {
      const examples = kind === "draft" ? await myVoice() : [];
      if (controller.signal.aborted) return;
      const result = await assist(
        thread,
        kind === "draft" ? DRAFT_PROMPT : INFO_PROMPT,
        controller.signal,
        (status) => !controller.signal.aborted && setHelp({ kind, status }),
        examples,
      );
      if (controller.signal.aborted) return;
      setHelp(null);
      if (kind === "info") setFound(result);
      else {
        if (last) await compose({ to: last.id, html: asDraftHtml(result.text) });
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      setHelp(null);
      toast.error((e as Error).message, {
        action: onSettings ? { label: "AI settings", onClick: onSettings } : undefined,
      });
    }
  };
  const [viewing, setViewing] = useState<OpenFile | null>(null);
  const microsoft = useMicrosoftSignIn(() => void loadAccounts());
  useEffect(() => {
    if (microsoft.error) toast.error(microsoft.error);
  }, [microsoft.error]);
  // Conversations ticked in the list, to archive or delete together.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set()), [current, shownFolder, query]);
  const pick = (id: string) =>
    setPicked((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // Archive and delete show at once: the mailbox itself takes a moment (a round trip to the
  // mail server), so the conversation leaves the list first and comes back only when the
  // server refuses. `leaving` keeps a list fetched meanwhile from showing it again.
  const leaving = useRef(new Set<string>());
  const moveAway = async (
    ids: string[],
    where: "archive" | "trash",
    work: () => Promise<unknown>,
  ) => {
    const before = threads;
    const wasOpen = openId;
    // Archiving from a search keeps the result in the list: it still matches the search.
    const hide = where === "trash" || !query;
    if (hide) {
      for (const id of ids) leaving.current.add(id);
      setThreads((old) => old.filter((t) => !ids.includes(t.thread_id)));
    }
    if (openId && ids.includes(openId)) setOpenId(null);
    try {
      await work();
      const many = ids.length === 1 ? "1 conversation" : `${ids.length} conversations`;
      toast.success(
        ids.length === 1 && wasOpen === ids[0]
          ? where === "archive"
            ? "Archived"
            : "Moved to Trash"
          : where === "archive"
            ? `Archived ${many}`
            : `Moved ${many} to Trash`,
      );
      for (const id of ids) leaving.current.delete(id);
      void loadAccounts();
    } catch (e) {
      for (const id of ids) leaving.current.delete(id);
      // Put back what was taken out, where it was; anything that arrived meanwhile stays.
      setThreads((old) => {
        const have = new Set(old.map((t) => t.thread_id));
        const missing = before.filter((t) => ids.includes(t.thread_id) && !have.has(t.thread_id));
        if (!missing.length) return old;
        const order = new Map(before.map((t, n) => [t.thread_id, n]));
        return [...old, ...missing].sort(
          (a, b) => (order.get(a.thread_id) ?? -1) - (order.get(b.thread_id) ?? -1),
        );
      });
      if (wasOpen && ids.includes(wasOpen)) setOpenId(wasOpen);
      toast.error((e as Error).message);
    }
  };
  const movePicked = async (where: "archive" | "trash") => {
    if (!current || !picked.size) return;
    const ids = [...picked];
    setPicked(new Set());
    await moveAway(ids, where, () => mail.move(current, ids, where));
  };
  /** Archive or delete the open conversation, in the mailbox itself. */
  const move = async (where: "archive" | "trash") => {
    if (!current || !thread) return;
    const id = thread.thread_id;
    await moveAway([id], where, () => mail[where](current, id));
  };

  const remove = async () => {
    const target = removing;
    setRemoving(null);
    if (!target) return;
    try {
      await mail.remove(target.id);
      if (target.id === current) state.choose(null);
      await loadAccounts();
    } catch (e) {
      toast.error(`Could not remove the account: ${(e as Error).message}`);
    }
  };

  if (accounts === null)
    return (
      <main className="grid h-full place-items-center text-sm text-muted-foreground">
        {loadError ? <p role="alert">{loadError}</p> : <p>Loading…</p>}
      </main>
    );

  if (!accounts.length)
    return (
      <main className="grid h-full place-items-center px-8">
        <div className="max-w-md text-center">
          <Mail className="mx-auto mb-4 size-8 text-muted-foreground" />
          <h1 className="mb-2 text-xl font-semibold">Mail</h1>
          <p className="mb-6 text-sm text-muted-foreground">
            Read your mail next to your notes. {STAYS_LOCAL} Graite only reads: nothing changes in
            your mailbox.
          </p>
          <Button onClick={() => state.setAdding(true)}>
            <Plus /> Add a mail account
          </Button>
        </div>
      </main>
    );

  // The draft being written; else the reply already begun for the open conversation.
  const draft =
    drafts.find((d) => d.id === draftId) ??
    (thread ? drafts.find((d) => d.thread_id === thread.thread_id) : undefined);
  const editor = draft && account && (
    <DraftEditor
      key={draft.id}
      account={account}
      draft={draft}
      onSaved={() => void loadDrafts()}
      onSendingSettings={() => setSendingSettings(account)}
      onGone={() => {
        setDraftId(null);
        setDrafts((old) => old.filter((d) => d.id !== draft.id));
        void loadAccounts();
      }}
    />
  );
  const folder = folders.find((f) => f.name === shownFolder);
  const waiting = account?.state === "syncing" || account?.state === "waiting";
  return (
    <main className="flex h-full min-h-0">
      <section className="flex w-[20rem] shrink-0 flex-col border-r" aria-label="Conversations">
        {account && (
          <header className="flex items-start gap-0.5 px-4 pt-3 pb-2">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold">
                {query ? "Search" : showsDrafts ? "Drafts" : (folder?.title ?? "Inbox")}
              </h1>
              <p
                className={`truncate text-xs ${account.state === "error" ? "text-destructive" : "text-muted-foreground"}`}
                title={statusLine(account)}
              >
                {account.state === "error"
                  ? account.error
                  : [
                      account.name,
                      !query && folder?.unread ? `${folder.unread} unread` : "",
                      statusLine(account),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </p>
            </div>
            {account.needs_password &&
              (account.auth === "microsoft" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={microsoft.waiting !== null}
                  onClick={() => void microsoft.start(account.id)}
                >
                  {microsoft.waiting ? "Waiting for sign-in…" : "Sign in again"}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setRepairing(account)}>
                  Enter password
                </Button>
              ))}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              title="New email"
              aria-label="New email"
              onClick={() => void compose()}
            >
              <PenLine className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              title="Check for new mail"
              aria-label="Check for new mail"
              onClick={() => void mail.sync(account.id).catch(() => {})}
            >
              <RefreshCw className={`size-3.5 ${waiting ? "animate-spin" : ""}`} />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground"
                  aria-label="Account options"
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={MENU}>
                <DropdownMenuItem onSelect={() => setSendingSettings(account)}>
                  <Settings2 /> Account settings…
                </DropdownMenuItem>
                {account.auth === "microsoft" ? (
                  <DropdownMenuItem onSelect={() => void microsoft.start(account.id)}>
                    <LogIn /> Sign in with Microsoft again…
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => setRepairing(account)}>
                    <KeyRound /> Change password…
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setRemoving(account)}>
                  <Trash2 /> Remove account…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>
        )}
        <div className="px-3 pb-2">
          <label className="flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-muted-foreground focus-within:bg-background focus-within:ring-1 focus-within:ring-ring">
            <Search size={15} className="shrink-0" />
            <input
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Search mail"
              placeholder="Search sender, subject or text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setInput("")}
            />
            {input && (
              <button
                type="button"
                aria-label="Clear search"
                className="rounded p-0.5 hover:bg-accent"
                onClick={() => setInput("")}
              >
                <X size={14} />
              </button>
            )}
          </label>
          {query && (
            <p className="mt-2 px-1 text-xs text-muted-foreground">
              {threads.length
                ? `${threads.length}${more ? "+" : ""} ${threads.length === 1 ? "conversation" : "conversations"} in every folder`
                : ""}
            </p>
          )}
        </div>
        {picked.size > 0 && (
          <div className="flex items-center gap-1 border-t bg-muted/50 px-3 py-1.5 text-xs">
            <span className="flex-1 font-medium whitespace-nowrap">{picked.size} selected</span>
            <button
              type="button"
              className="rounded px-1.5 py-1 hover:bg-accent"
              title="Select every conversation in this list"
              aria-label="Select all"
              onClick={() => setPicked(new Set(threads.map((t) => t.thread_id)))}
            >
              All
            </button>
            {!query && folder?.role === "inbox" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => void movePicked("archive")}
              >
                <Archive className="size-3.5" /> Archive
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void movePicked("trash")}
            >
              <Trash2 className="size-3.5" /> Delete
            </Button>
            <button
              type="button"
              className="rounded p-1 hover:bg-accent"
              aria-label="Clear selection"
              title="Clear selection"
              onClick={() => setPicked(new Set())}
            >
              <X size={13} />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto border-t">
          {showsDrafts && !query ? (
            !drafts.length ? (
              <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                No drafts. Drafts are kept in Graite until you send or discard them.
              </p>
            ) : (
              <ul>
                {drafts.map((d) => (
                  <li key={d.id} className="border-b">
                    <button
                      onClick={() => {
                        setOpenId(d.thread_id || null);
                        setDraftId(d.id);
                      }}
                      aria-current={d.id === draft?.id ? "true" : undefined}
                      className={`block w-full px-4 py-2 text-left hover:bg-accent/60 ${d.id === draft?.id ? "bg-accent" : ""}`}
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px]">
                          {d.to ? `To ${d.to}` : "No recipient yet"}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {mailDate(d.updated_at)}
                        </span>
                      </span>
                      <span className="block truncate text-[13px]">
                        {d.subject || "(no subject)"}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {d.body.replace(/\s+/g, " ").slice(0, 200)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : !threads.length ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              {query ? "Nothing matches." : waiting ? "Fetching mail…" : "No mail here."}
            </p>
          ) : (
            <ul>
              {threads.map((t) => (
                <li
                  key={t.thread_id}
                  className={`group flex border-b hover:bg-accent/60 ${t.thread_id === openId || picked.has(t.thread_id) ? "bg-accent" : ""}`}
                >
                  {/* The unread dot's place: a tick box on hover, and while any is ticked. */}
                  <label className="relative flex w-7 shrink-0 cursor-pointer justify-center pt-[10px]">
                    <input
                      type="checkbox"
                      className="peer sr-only"
                      aria-label={`Select the conversation “${t.subject || "(no subject)"}”`}
                      checked={picked.has(t.thread_id)}
                      onChange={() => pick(t.thread_id)}
                    />
                    <span
                      className={`grid size-[13px] place-items-center rounded-[4px] border border-muted-foreground/35 text-background peer-checked:border-foreground/70 peer-checked:bg-foreground/70 peer-focus-visible:ring-2 peer-focus-visible:ring-ring ${picked.size ? "" : "opacity-0 group-hover:opacity-100"}`}
                    >
                      {picked.has(t.thread_id) && <Check size={10} strokeWidth={3} />}
                    </span>
                    {!picked.size && (
                      <span
                        className={`pointer-events-none absolute top-[14px] size-1.5 rounded-full group-hover:hidden ${t.unread ? "bg-foreground" : ""}`}
                        aria-label={t.unread ? "Unread" : undefined}
                      />
                    )}
                  </label>
                  <button
                    onClick={() => {
                      setDraftId(null);
                      setOpenId(t.thread_id);
                    }}
                    aria-current={t.thread_id === openId ? "true" : undefined}
                    className="flex min-w-0 flex-1 py-2 pr-3 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span
                          className={`min-w-0 flex-1 truncate text-[13px] ${t.unread ? "font-semibold" : ""}`}
                        >
                          {t.participants.join(", ") || t.sender_email}
                          {t.count > 1 && (
                            <span className="font-normal text-muted-foreground"> · {t.count}</span>
                          )}
                        </span>
                        {t.has_attachments && (
                          <Paperclip
                            className="size-3 shrink-0 self-center text-muted-foreground"
                            aria-label="Has attachments"
                          />
                        )}
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {mailDate(t.date)}
                        </span>
                      </span>
                      <span
                        className={`block truncate text-[13px] ${t.unread ? "font-semibold" : ""}`}
                      >
                        {t.subject || "(no subject)"}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t.snippet}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {more && (
            <button
              className="w-full px-4 py-3 text-xs text-muted-foreground hover:bg-accent"
              onClick={() => void loadOlder()}
            >
              Show older mail
            </button>
          )}
        </div>
      </section>

      <section className="min-w-0 flex-1 overflow-y-auto" aria-label="Conversation">
        {!thread && editor ? (
          <div className="mx-auto max-w-2xl px-6 py-5">{editor}</div>
        ) : !thread ? (
          <div className="grid h-full place-items-center">
            <div className="text-center text-sm text-muted-foreground">
              <Mail className="mx-auto mb-3 size-6" />
              Choose a conversation to read it.
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl px-6 py-5">
            <header className="mb-4 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h1 className="text-lg leading-tight font-semibold text-balance">
                  {thread.subject || "(no subject)"}
                </h1>
                <p className="mt-1 text-xs text-muted-foreground">
                  {thread.messages.length === 1
                    ? "1 message"
                    : `${thread.messages.length} messages`}
                  {" · "}
                  {[...new Set(thread.messages.map((m) => m.sender_name || m.sender_email))].join(
                    ", ",
                  )}
                </p>
              </div>
              {thread.messages.some((m) => m.folders.includes("Inbox")) && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground"
                  title="Archive: take it out of the inbox"
                  aria-label="Archive"
                  onClick={() => void move("archive")}
                >
                  <Archive className="size-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                title="Delete: move it to the mailbox's Trash"
                aria-label="Delete"
                onClick={() => void move("trash")}
              >
                <Trash2 className="size-3.5" />
              </Button>
              {(() => {
                const last = thread.messages[thread.messages.length - 1];
                if (!last || (draft && draft.thread_id === thread.thread_id)) return null;
                const many = last.recipients.length + last.cc.length > 1;
                return (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={QUIET}
                      onClick={() => void compose({ to: last.id })}
                    >
                      <Reply /> Reply
                    </Button>
                    {many && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className={QUIET}
                        onClick={() => void compose({ to: last.id, all: true })}
                      >
                        <ReplyAll /> Reply all
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className={QUIET}
                      onClick={() => void compose(undefined, last.id)}
                    >
                      <Forward /> Forward
                    </Button>
                  </>
                );
              })()}
              {onSettings && !asking && (
                <Button variant="ghost" size="sm" className={QUIET} onClick={() => setAsking(true)}>
                  <Orbit /> Ask AI
                </Button>
              )}
            </header>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
              {thread.messages.map((message) => {
                const open = expanded.has(message.id);
                return (
                  <article key={message.id} className="min-w-0 rounded-xl border">
                    <button
                      type="button"
                      aria-expanded={open}
                      className="flex w-full items-center gap-2.5 px-4 py-2 text-left"
                      onClick={() =>
                        setExpanded((old) => {
                          const next = new Set(old);
                          if (!next.delete(message.id)) next.add(message.id);
                          return next;
                        })
                      }
                    >
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium">
                        {initial(message)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">
                          {message.sender_name || message.sender_email}
                          {message.sender_name && open && (
                            <span className="ml-2 font-normal text-muted-foreground">
                              {message.sender_email}
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {open
                            ? `To ${message.recipients.map((p) => p.name || p.email).join(", ") || "—"}${
                                message.cc.length
                                  ? ` · Cc ${message.cc.map((p) => p.name || p.email).join(", ")}`
                                  : ""
                              }`
                            : message.body_text.replace(/\s+/g, " ").slice(0, 140)}
                        </span>
                      </span>
                      {!open && message.attachments.length > 0 && (
                        <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <time
                        className="shrink-0 text-xs text-muted-foreground tabular-nums"
                        title={new Date(message.date).toLocaleString()}
                      >
                        {mailDate(message.date)}
                      </time>
                      {/* Reply to, or pass on, this mail in particular. */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={`Actions for the mail from ${message.sender_name || message.sender_email}`}
                            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className={MENU}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <DropdownMenuItem onSelect={() => void compose({ to: message.id })}>
                            <Reply /> Reply
                          </DropdownMenuItem>
                          {message.recipients.length + message.cc.length > 1 && (
                            <DropdownMenuItem
                              onSelect={() => void compose({ to: message.id, all: true })}
                            >
                              <ReplyAll /> Reply all
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onSelect={() => void compose(undefined, message.id)}>
                            <Forward /> Forward
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </button>
                    {open && (
                      <>
                        <div className="px-4 pt-1 pb-4">
                          {message.partial ? (
                            <p className="text-sm text-muted-foreground">
                              This mail is {formatBytes(message.size)}, too large for Graite to keep
                              a copy. Open it in your mail app.
                            </p>
                          ) : (
                            <MessageBody
                              html={message.body_html}
                              text={message.body_text}
                              fold={!FORWARD.test(message.subject)}
                            />
                          )}
                        </div>
                        {message.attachments.length > 0 && (
                          <footer className="flex flex-wrap gap-2 border-t px-4 py-2.5">
                            {message.attachments.map((file, index) => (
                              <button
                                key={index}
                                type="button"
                                title={`Open ${file.name}`}
                                className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left hover:bg-accent"
                                onClick={() =>
                                  current &&
                                  setViewing({
                                    accountId: current,
                                    messageId: message.id,
                                    index,
                                    name: file.name,
                                    size: file.size,
                                  })
                                }
                              >
                                <FileText className="size-4 shrink-0 text-muted-foreground" />
                                <span className="min-w-0">
                                  <span className="block max-w-56 truncate text-sm">
                                    {file.name}
                                  </span>
                                  <span className="block text-xs text-muted-foreground">
                                    {formatBytes(file.size)}
                                  </span>
                                </span>
                              </button>
                            ))}
                          </footer>
                        )}
                      </>
                    )}
                  </article>
                );
              })}
              {onSettings && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {!(draft && draft.thread_id === thread.thread_id) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={QUIET}
                      disabled={help !== null}
                      onClick={() => void runHelp("draft")}
                    >
                      <FilePenLine /> Generate draft
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className={QUIET}
                    disabled={help !== null}
                    onClick={() => void runHelp("info")}
                  >
                    <FileSearch /> Get info from pages
                  </Button>
                </div>
              )}
              {help && (
                <div
                  className="flex items-center gap-2.5 rounded-xl border px-4 py-3 text-[13px] text-muted-foreground"
                  role="status"
                >
                  <LoaderCircle className="size-4 shrink-0 animate-spin" />
                  <span className="min-w-0 flex-1 truncate">
                    {help.kind === "draft" ? "Writing a draft" : "Getting info"} · {help.status}
                  </span>
                  <button
                    type="button"
                    className="text-xs underline"
                    onClick={() => {
                      helping.current?.abort();
                      setHelp(null);
                    }}
                  >
                    Stop
                  </button>
                </div>
              )}
              {found && (
                <section className="min-w-0 rounded-xl border" aria-label="From your pages">
                  <header className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2">
                    <FileText className="size-4 text-muted-foreground" />
                    <span className="flex-1 text-[13px] font-medium">From your pages</span>
                    <button
                      type="button"
                      className="rounded p-1 hover:bg-accent"
                      aria-label="Close"
                      onClick={() => setFound(null)}
                    >
                      <X size={14} />
                    </button>
                  </header>
                  <div className="ai-prose markdown px-4 py-3 text-[13px] leading-relaxed">
                    <MarkdownAnswer content={found.text} onNavigate={onNavigate ?? (() => {})} />
                  </div>
                  {found.pages.length > 0 && (
                    <footer className="flex flex-wrap gap-1.5 border-t px-4 py-2.5">
                      {found.pages.map((page) => (
                        <button
                          key={page.path}
                          type="button"
                          title={page.path}
                          className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-accent"
                          onClick={() => onNavigate?.(page.path)}
                        >
                          <FileText className="size-3 text-muted-foreground" />
                          {page.title}
                        </button>
                      ))}
                    </footer>
                  )}
                </section>
              )}
              {draft && draft.thread_id === thread.thread_id && editor}
            </div>
          </div>
        )}
      </section>

      {asking && thread && current && onSettings && (
        <MailAskPanel
          key={thread.thread_id}
          accountId={current}
          thread={thread}
          onClose={() => setAsking(false)}
          onUseAsDraft={(text) => {
            const last = thread.messages[thread.messages.length - 1];
            if (last) void compose({ to: last.id, html: asDraftHtml(text) });
          }}
          onSettings={onSettings}
          onNavigate={onNavigate ?? (() => {})}
          settingsVersion={settingsVersion}
        />
      )}

      <AttachmentDialog
        file={viewing}
        tree={tree}
        onClose={() => setViewing(null)}
        onAskAI={onSettings ? () => setAsking(true) : undefined}
        onNavigate={onNavigate}
      />
      <SendingDialog
        account={sendingSettings}
        onClose={() => setSendingSettings(null)}
        onSaved={() => {
          setSendingSettings(null);
          void loadAccounts();
        }}
      />
      <PasswordDialog
        account={repairing}
        onClose={() => setRepairing(null)}
        onSaved={() => {
          setRepairing(null);
          void loadAccounts();
        }}
      />
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removing?.name}” from Graite?</AlertDialogTitle>
            <AlertDialogDescription>
              The copy of its mail on this device and the saved password are deleted. Nothing
              changes in the mailbox itself.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>Remove account</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function PasswordDialog({
  account,
  onClose,
  onSaved,
}: {
  account: MailAccount | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      await mail.update(account.id, { password });
      setPassword("");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={account !== null} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Password for {account?.name}</DialogTitle>
            <DialogDescription>
              Graite signs in once to check it, then stores it in your system keychain.
            </DialogDescription>
          </DialogHeader>
          <input
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1"
            type="password"
            aria-label="Password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !password}>
              {busy ? "Signing in…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SendingDialog({
  account,
  onClose,
  onSaved,
}: {
  account: MailAccount | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState("");
  const [vaults, setVaults] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setLabel(account?.name ?? "");
    setVaults(account?.vaults ?? []);
    setName(account?.sender_name ?? "");
    setHost(account?.smtp_host ?? "");
    setPort(account ? String(account.smtp_port) : "");
    setError("");
  }, [account]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!account) return;
    try {
      await mail.update(account.id, {
        ...(label.trim() && label.trim() !== account.name ? { name: label.trim() } : {}),
        ...(vaults.join("\n") !== (account.vaults ?? []).join("\n") ? { vaults } : {}),
        sender_name: name,
        // Unchanged: leave the server to be worked out from the incoming one.
        ...(host.trim() !== account.smtp_host || Number(port) !== account.smtp_port
          ? { smtp_host: host.trim(), smtp_port: Number(port) || 0 }
          : {}),
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const input =
    "w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1";
  return (
    <Dialog open={account !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{account?.email}</DialogTitle>
            <DialogDescription>
              Mail is sent from this computer straight to your mail provider, with the same sign-in
              as for reading.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1.5 text-sm">
            Name of this account in Graite
            <input
              className={input}
              placeholder="Work, Private…"
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          {account && <VaultChoice key={account.id} value={vaults} onChange={setVaults} />}
          <label className="grid gap-1.5 text-sm">
            Your name, as recipients see it
            <input
              className={input}
              placeholder="First and last name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <label className="grid gap-1.5 text-sm">
              Outgoing mail (SMTP) server
              <input className={input} value={host} onChange={(e) => setHost(e.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">
              Port
              <input
                className={input}
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Graite fills in the server for well-known providers. Change it only if sending fails.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
