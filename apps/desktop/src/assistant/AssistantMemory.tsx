import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, ExternalLink, Pin, PinOff, Plus, Search, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { assistant, type AssistantInfo, type MemoryItem } from "@/lib/assistant";
import { ConflictError, onDaemonEvent, pages, type TreeNode } from "@/lib/api";
import { pageProperties, workspace } from "@/lib/workspace";
import { AssistantPage } from "./AssistantPage";
import { ProposalCard } from "@/review/ProposalCard";
import { useProposals } from "@/review/useProposals";
import { entryText, lastEntries, parseMemory } from "./memoryDoc";
import { MEMORY_KINDS, groupMemories, recalledLabel, withMemoryFields } from "./memoryItems";

const JOURNAL_SHOWN = 5;

/** What the assistant remembers: one card per memory, grouped by kind, searchable, each
 * editable in place (title, several lines of detail, kind, pin) or removable. Every change is
 * an ordinary page write; "Open page" keeps the full editor. */
export function AssistantMemory({
  info,
  onNavigate,
  onChanged,
  tree,
  requestedPage,
}: {
  info: AssistantInfo;
  tree: TreeNode[];
  requestedPage?: { path: string; n: number } | null;
  onNavigate: (path: string) => void;
  onChanged: () => void;
}) {
  const memory = info.memory ?? {
    root: null,
    pages: {},
    auto_apply: false,
    opted_in: false,
    legacy: [],
  };
  const [selected, setSelected] = useState<string | null>(null);
  const flush = useRef<(() => Promise<void>) | null>(null);
  const registerFlush = useCallback((fn: (() => Promise<void>) | null) => {
    flush.current = fn;
  }, []);
  const open = async (path: string | null) => {
    try {
      await flush.current?.();
      if (path && memory.root && path !== memory.root && !path.startsWith(memory.root + "/"))
        onNavigate(path);
      else setSelected(path);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (requestedPage) void openRef.current(requestedPage.path);
  }, [requestedPage]);
  const all = useProposals({ limit: 200 });
  const root = memory.root;
  const recent = root
    ? all.proposals
        .filter((p) => p.page_path === root || p.page_path.startsWith(root + "/"))
        .slice(0, 30)
    : [];
  const list = useMemories(root && !selected ? root : null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  if (!root) {
    return (
      <div className="assistant-pane">
        <div className="ai-notice">
          The memory page is missing. Save the profile once to create it again.
        </div>
      </div>
    );
  }
  if (selected)
    return (
      <div className="assistant-memory-document">
        <div className="assistant-memory-nav">
          <Button variant="ghost" size="sm" onClick={() => void open(null)}>
            ← Memory overview
          </Button>
        </div>
        <AssistantPage
          path={selected}
          tree={tree}
          onNavigate={(path) => void open(path)}
          onChanged={onChanged}
          registerFlush={registerFlush}
        />
      </div>
    );
  const legacy = memory.legacy ?? [];
  const groups = groupMemories(list.items, query);
  const upgrade = async () => {
    setUpgrading(true);
    try {
      const { created } = await assistant.upgradeMemory();
      toast.success(`${created} ${created === 1 ? "memory" : "memories"} moved to cards.`);
      onChanged();
      await list.reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUpgrading(false);
    }
  };
  const tidy = async () => {
    try {
      await assistant.tidyMemory();
      toast.success(`${info.name} is tidying its memory. Changes show up below and can be undone.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const journal = memory.pages?.Journal;
  const memoriesPage = memory.pages?.Memories ?? list.parent;
  return (
    <div className="assistant-pane memory-overview" data-page-scroll>
      <h2>Memory</h2>
      <p className="assistant-muted">
        What {info.name} knows about you, one card per memory. Pinned memories are part of every
        conversation; the others come up only when they matter. Click a memory to change it.
      </p>
      {!memory.auto_apply && (
        <div className="ai-notice">
          The memory page’s AI settings ask for review, so every memory update waits in Review.
        </div>
      )}
      {legacy.length > 0 && (
        <div className="ai-notice memory-upgrade">
          <span>
            Your memory is still in the old {legacy.join(" and ")}{" "}
            {legacy.length === 1 ? "list" : "lists"}. Turn every line into its own card so you can
            edit, pin and remove them one by one.
          </span>
          <Button size="sm" onClick={() => void upgrade()} disabled={upgrading}>
            {upgrading ? "Converting…" : "Convert to cards"}
          </Button>
        </div>
      )}

      <section className="memory-block" aria-label="Memories">
        <div className="memory-toolbar">
          <label className="memory-search">
            <Search size={13} aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memories"
              aria-label="Search memories"
            />
          </label>
          <Button variant="outline" size="sm" onClick={() => setAdding(true)} disabled={adding}>
            <Plus size={13} /> Add memory
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void tidy()}
            title="Merge duplicates, generalise and forget what is no longer useful"
          >
            <Sparkles size={13} /> Tidy now
          </Button>
          {memoriesPage && (
            <button
              className="assistant-link memory-open"
              onClick={() => void open(memoriesPage)}
              aria-label="Open the Memories page"
            >
              Open as page <ExternalLink size={12} aria-hidden />
            </button>
          )}
        </div>
        {list.error && (
          <p className="ai-notice ai-error" role="alert">
            {list.error}
          </p>
        )}
        {adding && (
          <MemoryEditor
            initial={{ title: "", body: "", kind: "Preference", pinned: false }}
            label="New memory"
            onCancel={() => setAdding(false)}
            onSave={async (draft) => {
              await assistant.addMemory({
                title: draft.title,
                body: draft.body,
                kind: draft.kind,
                pinned: draft.pinned,
              });
              setAdding(false);
              await list.reload();
            }}
          />
        )}
        {list.loaded && !list.items.length && !adding && (
          <p className="assistant-muted">
            Nothing yet. Tell {info.name} something worth remembering, or add a memory here.
          </p>
        )}
        {list.loaded && list.items.length > 0 && !groups.length && (
          <p className="assistant-muted">No memory matches “{query}”.</p>
        )}
        {groups.map((group) => (
          <div key={group.kind} className="memory-section">
            <h4>
              {group.kind} <span className="memory-count">{group.items.length}</span>
            </h4>
            <ul className="memory-cards">
              {group.items.map((item) => (
                <MemoryCard
                  key={item.path}
                  item={item}
                  onOpen={() => void open(item.path)}
                  onChanged={list.reload}
                />
              ))}
            </ul>
          </div>
        ))}
      </section>

      {journal && (
        <section className="memory-block" aria-label="Journal">
          <div className="memory-head">
            <h3>Journal</h3>
            <small>What it did in the background</small>
            <button
              className="assistant-link memory-open"
              onClick={() => void open(journal)}
              aria-label="Open Journal page"
            >
              Open page <ExternalLink size={12} aria-hidden />
            </button>
          </div>
          <JournalTail path={journal} />
        </section>
      )}

      <section className="memory-block" aria-label="Recent memory changes">
        <div className="memory-head">
          <h3>Recent memory changes</h3>
          {memory.auto_apply && <small>Undo any of them here.</small>}
        </div>
        {!recent.length && <p className="assistant-muted">Nothing yet.</p>}
        {recent.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            actions={all.actions}
            onNavigate={(path) => void open(path)}
            collapsible
            defaultOpen={false}
          />
        ))}
      </section>
    </div>
  );
}

/** The memory list, kept current when the assistant (or anything else) changes a memory. */
function useMemories(root: string | null) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      const list = await assistant.memories();
      setItems(list.items ?? []);
      setParent(list.parent ?? null);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    if (!root) return;
    void reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onDaemonEvent((event) => {
      const data = event.data as { path?: string };
      if (event.type !== "file_changed" && event.type !== "tree_changed") return;
      if (data.path && data.path !== root && !data.path.startsWith(root + "/")) return;
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), 250); // an upgrade or a tidy writes many pages
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [root, reload]);
  return { items, parent, loaded, error, reload };
}

interface Draft {
  title: string;
  body: string;
  kind: string | null;
  pinned: boolean;
}

function MemoryCard({
  item,
  onOpen,
  onChanged,
}: {
  item: MemoryItem;
  onOpen: () => void;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast.error(
        e instanceof ConflictError
          ? "This memory changed meanwhile. It is reloaded; make your change again."
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
      await onChanged();
    }
  };
  const setFields = (change: { kind?: string | null; pinned?: boolean }) =>
    run(async () => {
      const page = await pages.get(item.path);
      await workspace.properties(
        page.id,
        withMemoryFields(pageProperties(page), change),
        page.hash,
      );
    });
  if (editing) {
    return (
      <li className="memory-card" data-editing>
        <MemoryEditor
          initial={{
            title: item.title,
            body: item.body ?? "",
            kind: item.kind ?? null,
            pinned: item.pinned ?? false,
          }}
          label={`Edit ${item.title}`}
          onCancel={() => setEditing(false)}
          onSave={async (draft) => {
            let path = item.path;
            let hash: string | null = null;
            if (draft.title !== item.title) {
              const renamed = await pages.patch(path, { title: draft.title });
              path = renamed.path;
              hash = renamed.hash;
            }
            if (draft.body.trim() !== (item.body ?? "").trim()) {
              hash ??= (await pages.get(path)).hash;
              const saved = await pages.put(
                path,
                draft.body.trim() ? draft.body.trim() + "\n" : "",
                hash,
              );
              hash = saved.hash;
            }
            if (draft.kind !== (item.kind ?? null) || draft.pinned !== (item.pinned ?? false)) {
              const page = await pages.get(path);
              await workspace.properties(
                page.id,
                withMemoryFields(pageProperties(page), { kind: draft.kind, pinned: draft.pinned }),
                page.hash,
              );
            }
            setEditing(false);
            await onChanged();
          }}
        />
      </li>
    );
  }
  return (
    <li
      className="memory-card"
      data-pinned={item.pinned || undefined}
      aria-busy={busy || undefined}
    >
      <button
        className="memory-pin"
        aria-pressed={!!item.pinned}
        disabled={busy}
        title={
          item.pinned
            ? "Pinned: part of every conversation. Click to unpin."
            : "Pin: include in every conversation"
        }
        aria-label={item.pinned ? `Unpin ${item.title}` : `Pin ${item.title}`}
        onClick={() => void setFields({ pinned: !item.pinned })}
      >
        {item.pinned ? <Pin size={13} /> : <PinOff size={13} />}
      </button>
      <button
        className="memory-card-text"
        onClick={() => setEditing(true)}
        aria-label={`Edit memory: ${item.title}`}
      >
        <strong>{item.title}</strong>
        {item.body?.trim() && <span className="memory-card-body">{item.body.trim()}</span>}
        <small>{recalledLabel(item.last_recalled)}</small>
      </button>
      <div className="memory-card-actions">
        <button
          className="memory-delete"
          onClick={onOpen}
          title="Open page"
          aria-label={`Open ${item.title}`}
        >
          <ExternalLink size={13} />
        </button>
        <button
          className="memory-delete"
          disabled={busy}
          title="Forget"
          aria-label={`Forget: ${item.title}`}
          onClick={() =>
            void run(async () => {
              await pages.remove(item.path);
              toast.success("Forgotten. Restore it from the trash if you change your mind.");
            })
          }
        >
          <X size={13} />
        </button>
      </div>
    </li>
  );
}

function MemoryEditor({
  initial,
  label,
  onSave,
  onCancel,
}: {
  initial: Draft;
  label: string;
  onSave: (draft: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!draft.title.trim()) return;
    setSaving(true);
    try {
      await onSave({ ...draft, title: draft.title.trim() });
    } catch (e) {
      toast.error(
        e instanceof ConflictError
          ? "This memory changed meanwhile. Reload and make your change again."
          : (e as Error).message,
      );
    } finally {
      setSaving(false);
    }
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  };
  return (
    <form
      className="memory-editor"
      aria-label={label}
      onKeyDown={keys}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        className="memory-input"
        autoFocus
        value={draft.title}
        placeholder="What to remember, in one line"
        aria-label="Memory"
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        maxLength={200}
      />
      <textarea
        className="memory-input memory-textarea"
        value={draft.body}
        rows={Math.min(8, Math.max(2, draft.body.split("\n").length + 1))}
        placeholder="Details (optional)"
        aria-label="Details"
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
      />
      <div className="memory-editor-row">
        <select
          value={draft.kind ?? ""}
          aria-label="Kind"
          onChange={(e) => setDraft({ ...draft, kind: e.target.value || null })}
        >
          <option value="">No kind</option>
          {MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label className="memory-pin-toggle">
          <input
            type="checkbox"
            checked={draft.pinned}
            onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })}
          />
          Pinned — in every conversation
        </label>
        <span className="memory-editor-actions">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving || !draft.title.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </span>
      </div>
    </form>
  );
}

function JournalTail({ path }: { path: string }) {
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      pages
        .get(path)
        .then((page) => {
          if (live) setBody(page.body);
        })
        .catch(() => {});
    void load();
    const off = onDaemonEvent((event) => {
      if (event.type === "file_changed" && (event.data as { path?: string }).path === path)
        void load();
    });
    return () => {
      live = false;
      off();
    };
  }, [path]);
  if (body === null) return null;
  const entries = lastEntries(parseMemory(body), JOURNAL_SHOWN);
  if (!entries.length) return <p className="assistant-muted">Nothing logged yet.</p>;
  return (
    <details className="memory-journal">
      <summary>
        <ChevronRight size={13} aria-hidden /> Last {entries.length}{" "}
        {entries.length === 1 ? "entry" : "entries"}
      </summary>
      <ul className="memory-rows">
        {entries.map((entry, n) => (
          <li key={n} className="memory-row" data-raw>
            <span className="memory-text">{entryText(entry)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
