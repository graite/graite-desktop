import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, Link as LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { linkLabel, normalizeUrl } from "./linkChips";

export interface WebLink {
  url: string;
  label: string;
}

/** Paste a web address and get a short link for it; the name can be changed before adding. */
export function LinkDialog({
  open,
  onAdd,
  onCancel,
}: {
  open: boolean;
  onAdd: (link: WebLink) => void;
  onCancel: () => void;
}) {
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setAddress("");
    setName("");
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);
  const url = normalizeUrl(address);
  const label = name.trim() || (url ? linkLabel(url) : "");
  const paste = async () => {
    try {
      setAddress((await navigator.clipboard.readText()).trim());
    } catch {
      input.current?.focus(); // no clipboard access: Cmd/Ctrl+V in the box works
    }
  };
  const submit = () => {
    if (url) onAdd({ url, label });
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="gap-3 p-4 sm:max-w-md" showCloseButton={false}>
        <DialogTitle className="text-sm font-medium">Add a link</DialogTitle>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex items-center gap-2">
            <input
              ref={input}
              className="link-dialog-input"
              aria-label="Web address"
              placeholder="Paste a web address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <Button type="button" variant="secondary" size="sm" onClick={() => void paste()}>
              <ClipboardPaste size={14} /> Paste
            </Button>
          </div>
          <input
            className="link-dialog-input"
            aria-label="Link name"
            placeholder={url ? linkLabel(url) : "Name (optional)"}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="min-h-6 min-w-0 truncate">
              {url && (
                <span className="link-chip link-chip-preview">
                  <LinkIcon size={12} /> {label}
                </span>
              )}
            </span>
            <span className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!url}>
                Add link
              </Button>
            </span>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
