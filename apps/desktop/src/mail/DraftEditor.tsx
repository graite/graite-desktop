import { useEffect, useRef, useState } from "react";
import { Bold, Italic, List, ListOrdered, Paperclip, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { mail, textToHtml, type MailAccount, type MailDraft } from "@/lib/mail";
import { formatBytes } from "@/lib/media";
import { Button } from "@/components/ui/button";
import { RecipientField } from "./RecipientField";

const SAVE_DELAY_MS = 600;
const line = "min-w-0 flex-1 bg-transparent py-1.5 text-[13px] outline-none";
const tool =
  "grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50";

type Fields = Pick<MailDraft, "to" | "cc" | "bcc" | "subject" | "html">;
const fieldsOf = (d: MailDraft): Fields => ({
  to: d.to,
  cc: d.cc,
  bcc: d.bcc,
  subject: d.subject,
  // A draft from before formatting existed has only its plain text.
  html: d.html || textToHtml(d.body),
});

const TOOLS = [
  { command: "bold", label: "Bold", icon: Bold },
  { command: "italic", label: "Italic", icon: Italic },
  { command: "insertUnorderedList", label: "Bulleted list", icon: List },
  { command: "insertOrderedList", label: "Numbered list", icon: ListOrdered },
] as const;

/**
 * One mail being written, with bold, italic and lists, and files that go along. It saves
 * itself while you type and is sent only by the Send button; if sending fails the draft
 * stays as it is.
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
  const [files, setFiles] = useState(draft.attachments ?? []);
  const [more, setMore] = useState(!!(draft.cc || draft.bcc));
  const [saved, setSaved] = useState(true);
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(fields);
  const dirty = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

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

  // The message is put in once; after that the editor itself holds what is typed. What
  // comes from the daemon was rebuilt there from an allow-list, so it is safe to show.
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    element.innerHTML = latest.current.html;
    // A reply opens with the cursor above the quoted mail.
    if (draft.in_reply_to && draft.to) {
      element.focus();
      const range = document.createRange();
      range.setStart(element, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    // Once per draft. Running it again when the saved recipients change would take the
    // cursor out of the line being typed, which made a pill of a single letter.
  }, [draft.id]);

  const format = (command: string) => {
    body.current?.focus();
    document.execCommand?.(command);
    if (body.current) change({ html: body.current.innerHTML });
  };

  const attach = async (list: FileList | null) => {
    if (!list?.length) return;
    setAttaching(true);
    setError("");
    try {
      for (const file of Array.from(list)) {
        const changed = await mail.attachToDraft(account.id, draft.id, file, file.name);
        setFiles(changed.attachments ?? []);
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAttaching(false);
      if (picker.current) picker.current.value = "";
    }
  };

  const detach = async (fileId: string) => {
    try {
      const changed = await mail.detachFromDraft(account.id, draft.id, fileId);
      setFiles(changed.attachments ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  };

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

  const people = (label: string, key: "to" | "cc" | "bcc") => (
    <RecipientField
      accountId={account.id}
      label={label}
      value={fields[key]}
      autoFocus={key === "to" && !draft.to}
      onChange={(value) => change({ [key]: value })}
    />
  );

  return (
    <div className="min-w-0">
      <section className="min-w-0 rounded-xl border" aria-label="Draft">
        <header className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2">
          <span className="text-sm font-medium">
            {draft.in_reply_to ? "Reply" : draft.forwarded ? "Forward" : "New email"}
          </span>
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
        <div className="relative">
          {people("To", "to")}
          {!more && (
            <button
              type="button"
              className="absolute top-[7px] right-4 text-xs text-muted-foreground hover:underline"
              onClick={() => setMore(true)}
            >
              Cc Bcc
            </button>
          )}
        </div>
        {more && people("Cc", "cc")}
        {more && people("Bcc", "bcc")}
        <label className="flex items-baseline gap-3 border-b px-4">
          <span className="w-14 shrink-0 text-xs text-muted-foreground">Subject</span>
          <input
            className={line}
            aria-label="Subject"
            value={fields.subject}
            onChange={(e) => change({ subject: e.target.value })}
          />
        </label>
        <div
          ref={body}
          role="textbox"
          aria-multiline="true"
          aria-label="Message"
          contentEditable
          suppressContentEditableWarning
          className="min-h-[140px] px-4 py-3 text-[13px] leading-relaxed outline-none [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:min-h-[1.2em] [&_p+p]:mt-2 [&_p+ul]:mt-2 [&_p+ol]:mt-2 [&_ul+p]:mt-2 [&_ol+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5"
          onInput={(e) => change({ html: e.currentTarget.innerHTML })}
          // Pasted text comes in as plain words: formatting from elsewhere stays out.
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            if (document.execCommand) document.execCommand("insertText", false, text);
            else e.currentTarget.append(text);
            change({ html: e.currentTarget.innerHTML });
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            void attach(e.dataTransfer.files);
          }}
        />
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 border-t px-4 py-2" aria-label="Attached files">
            {files.map((file) => (
              <li
                key={file.id}
                className="flex items-center gap-1.5 rounded-md border py-1 pr-1 pl-2 text-xs"
              >
                <Paperclip className="size-3 text-muted-foreground" />
                <span className="max-w-48 truncate">{file.name}</span>
                <span className="text-muted-foreground">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => void detach(file.id)}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="border-t px-4 py-2.5 text-sm text-destructive">
            {error}
          </p>
        )}
        <footer className="flex flex-wrap items-center gap-1 border-t px-3 py-2">
          <div
            className="flex min-w-0 flex-1 items-center gap-0.5"
            role="toolbar"
            aria-label="Formatting"
          >
            <button
              type="button"
              title="Attach files"
              aria-label="Attach files"
              disabled={attaching}
              className={tool}
              onClick={() => picker.current?.click()}
            >
              <Paperclip className="size-3.5" />
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              aria-label="Files to attach"
              onChange={(e) => void attach(e.target.files)}
            />
            {TOOLS.map((item) => (
              <button
                key={item.command}
                type="button"
                title={item.label}
                aria-label={item.label}
                className={tool}
                // Keep the selection in the message: the click must not take the focus away.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => format(item.command)}
              >
                <item.icon className="size-3.5" />
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => void discard()} disabled={sending}>
            <Trash2 /> Discard
          </Button>
          <Button
            size="sm"
            onClick={() => void send()}
            disabled={sending || attaching || !fields.to.trim()}
          >
            <Send /> {sending ? "Sending…" : attaching ? "Attaching…" : "Send"}
          </Button>
        </footer>
      </section>
      <p className="mt-1.5 pr-1 text-right text-[11px] text-muted-foreground">
        Nothing is sent until you press Send.
      </p>
    </div>
  );
}
