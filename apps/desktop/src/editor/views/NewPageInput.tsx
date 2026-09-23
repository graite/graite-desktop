import { useState } from "react";
import { toast } from "sonner";

/** Inline title field shown after "+ New": Enter creates the page, Escape or an empty blur cancels. */
export function NewPageInput({
  onCreate,
  onDone,
  placeholder = "Page title",
}: {
  onCreate: (title: string) => Promise<unknown>;
  onDone: () => void;
  placeholder?: string;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    if (!title.trim()) {
      onDone();
      return;
    }
    setBusy(true);
    try {
      await onCreate(title.trim());
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <input
      className="view-new-input"
      aria-label="New page title"
      autoFocus
      placeholder={placeholder}
      value={title}
      disabled={busy}
      maxLength={200}
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void submit();
        }
        if (e.key === "Escape") onDone();
        e.stopPropagation();
      }}
      onBlur={() => void submit()}
    />
  );
}
