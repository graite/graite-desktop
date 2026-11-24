import { useEffect, useRef, useState } from "react";
import { Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { mail, type MailAccount, type MailDraft } from "@/lib/mail";
import { Button } from "@/components/ui/button";

const SAVE_DELAY_MS = 600;
const line = "min-w-0 flex-1 bg-transparent py-1.5 text-[13px] outline-none";

type Fields = Pick<MailDraft, "to" | "cc" | "bcc" | "subject" | "body">;
const fieldsOf = (d: MailDraft): Fields => ({
  to: d.to,
  cc: d.cc,
  bcc: d.bcc,
  subject: d.subject,
  body: d.body,
});

/**
 * One mail being written. It saves itself while you type and is sent only by the Send
 * button; if sending fails the draft stays as it is.
 */
export function DraftEditor({
  account,
  draft,
  onGone,
  onSaved,
  onSendingSettings,
}: {
  account: MailAccount;
  draft: MailDraft;
  /** The draft was sent or discarded. */
  onGone: (how: "sent" | "discarded") => void;
  onSaved: () => void;
  onSendingSettings: () => void;
}) {
  const [fields, setFields] = useState<Fields>(() => fieldsOf(draft));
  const [more, setMore] = useState(!!(draft.cc || draft.bcc));
  const [saved, setSaved] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(fields);
  const dirty = useRef(false);
  const body = useRef<HTMLTextAreaElement>(null);

  const save = async () => {
    if (!dirty.current) return;
    dirty.current = false;
    await mail.saveDraft(account.id, draft.id, latest.current);
    setSaved(true);
    onSaved();
  };

  const change = (patch: Partial<Fields>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    dirty.current = true;
    setFields(next);
    setSaved(false);
    setError("");
  };

  useEffect(() => {
    if (saved) return;
    const timer = setTimeout(() => void save().catch(() => {}), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
    // `save` reads refs; it only has to be scheduled when the text changed.
  }, [fields, saved]);
  // Leaving the editor (another mail, another tab) must not lose the last words typed.
  useEffect(
    () => () => {
      if (dirty.current) void mail.saveDraft(account.id, draft.id, latest.current).catch(() => {});
    },
    [account.id, draft.id],
  );

  useEffect(() => {
    const element = body.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.max(element.scrollHeight, 140)}px`;
  }, [fields.body]);
  // A reply opens with the cursor above the quoted mail.
  useEffect(() => {
    const element = body.current;
    if (!element || !draft.in_reply_to || draft.to === "") return;
    element.focus();
    element.setSelectionRange(0, 0);
  }, [draft.id, draft.in_reply_to, draft.to]);

  const send = async () => {
    setSending(true);
    setError("");
    try {
      dirty.current = true;
      await save();
      const result = await mail.sendDraft(account.id, draft.id);
      if (result.saved_copy) toast.success("Sent");
      else toast.warning("Sent, but a copy could not be saved to your Sent folder.");
      onGone("sent");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const discard = async () => {
    dirty.current = false;
    try {
      await mail.discardDraft(account.id, draft.id);
      onGone("discarded");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const row = (label: string, key: "to" | "cc" | "bcc" | "subject", extra?: React.ReactNode) => (
    <label className="flex items-baseline gap-3 border-b px-4">
      <span className="w-14 shrink-0 text-xs text-muted-foreground">{label}</span>
      <input
        className={line}
        aria-label={label}
        value={fields[key]}
        autoFocus={key === "to" && !draft.to}
        placeholder={key === "subject" ? "" : "name@example.com, …"}
        onChange={(e) => change({ [key]: e.target.value })}
      />
      {extra}
    </label>
  );

  return (
    <section className="min-w-0 rounded-xl border" aria-label="Draft">
      <header className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2">
        <span className="text-sm font-medium">{draft.in_reply_to ? "Reply" : "New email"}</span>
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground hover:underline"
          title="Change your name on sent mail, or the outgoing server"
          onClick={onSendingSettings}
        >
          From {account.sender_name ? `${account.sender_name} <${account.email}>` : account.email}
        </button>
        <span className="shrink-0 text-xs text-muted-foreground" aria-live="polite">
          {saved ? "Saved" : "Saving…"}
        </span>
      </header>
      {row(
        "To",
        "to",
        !more && (
          <button
            type="button"
            className="shrink-0 text-xs text-muted-foreground hover:underline"
            onClick={() => setMore(true)}
          >
            Cc Bcc
          </button>
        ),
      )}
      {more && row("Cc", "cc")}
      {more && row("Bcc", "bcc")}
      {row("Subject", "subject")}
      <textarea
        ref={body}
        className="block w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-relaxed outline-none"
        aria-label="Message"
        placeholder="Write your message…"
        value={fields.body}
        onChange={(e) => change({ body: e.target.value })}
      />
      {error && (
        <p role="alert" className="border-t px-5 py-2.5 text-sm text-destructive">
          {error}
        </p>
      )}
      <footer className="flex items-center gap-2 border-t px-4 py-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          Nothing is sent until you press Send.
        </p>
        <Button variant="ghost" size="sm" onClick={() => void discard()} disabled={sending}>
          <Trash2 /> Discard
        </Button>
        <Button size="sm" onClick={() => void send()} disabled={sending || !fields.to.trim()}>
          <Send /> {sending ? "Sending…" : "Send"}
        </Button>
      </footer>
    </section>
  );
}
