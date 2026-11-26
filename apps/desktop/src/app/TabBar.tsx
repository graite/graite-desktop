import { useState } from "react";
import { FilePlus, Mail, MessageCircle, Plus, Search, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PagePicker } from "@/editor/PagePicker";
import { PageIcon } from "@/components/PageIcon";
import type { TreeNode } from "@/lib/api";
import { findNode, lastSegment } from "@/editor/tree-utils";
import type { ChatTab } from "./tabs";

/** The open pages (and open Studio chats), across the top of the page area. Click to switch, × or middle-click to close.
 * The + makes a new page or opens an existing one in a new tab. */
export function TabBar({
  tabs,
  active,
  tree,
  onSelect,
  onClose,
  onNew,
  onOpen,
  mail,
  chats,
}: {
  tabs: string[];
  active: string | null;
  tree: TreeNode[];
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onNew: () => void;
  /** Open an existing page in a new tab. */
  onOpen: (path: string) => void;
  /** The Mail tab, while it is open: it sits before the pages and switches like one. */
  mail?: { title: string; active: boolean; onSelect: () => void; onClose: () => void };
  /** Conversations open in Studio: they sit after the pages and switch like one. */
  chats?: {
    tabs: ChatTab[];
    active: string | null;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
  };
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="page-tabs" role="tablist" aria-label="Open pages">
      {mail && (
        <div className="page-tab" data-active={mail.active || undefined}>
          <button
            type="button"
            role="tab"
            aria-selected={mail.active}
            title={mail.title}
            className="page-tab-open"
            onClick={mail.onSelect}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              mail.onClose();
            }}
          >
            <Mail className="size-3.5 shrink-0" />
            <span>{mail.title}</span>
          </button>
          <button
            type="button"
            className="page-tab-close"
            aria-label={`Close ${mail.title}`}
            title="Close tab"
            onClick={mail.onClose}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {tabs.map((path) => {
        const node = findNode(tree, path);
        const title = node?.title ?? lastSegment(path);
        const selected = path === active;
        return (
          <div key={path} className="page-tab" data-active={selected || undefined}>
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              title={title}
              className="page-tab-open"
              onClick={() => onSelect(path)}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                onClose(path);
              }}
            >
              <PageIcon
                icon={node?.icon ?? null}
                hasContent={node?.has_content ?? false}
                className="size-3.5 shrink-0"
              />
              <span>{title}</span>
            </button>
            <button
              type="button"
              className="page-tab-close"
              aria-label={`Close ${title}`}
              title="Close tab"
              onClick={() => onClose(path)}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      {chats?.tabs.map((chat) => {
        const selected = chat.id === chats.active;
        const title = chat.title.trim() || "New chat";
        return (
          <div
            key={`chat:${chat.id}`}
            className="page-tab"
            data-kind="chat"
            data-active={selected || undefined}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              title={title}
              className="page-tab-open"
              onClick={() => chats.onSelect(chat.id)}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                chats.onClose(chat.id);
              }}
            >
              <MessageCircle className="size-3.5 shrink-0" />
              <span>{title}</span>
            </button>
            <button
              type="button"
              className="page-tab-close"
              aria-label={`Close ${title}`}
              title="Close tab"
              onClick={() => chats.onClose(chat.id)}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="page-tab-new" aria-label="New tab" title="New tab">
            <Plus size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={onNew}>
            <FilePlus size={15} /> Add new page
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPicking(true)}>
            <Search size={15} /> Open a page…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PagePicker
        open={picking}
        tree={tree}
        excludePath={null}
        title="Open a page"
        onPick={(page) => {
          setPicking(false);
          onOpen(page.path);
        }}
        onCancel={() => setPicking(false)}
      />
    </div>
  );
}
