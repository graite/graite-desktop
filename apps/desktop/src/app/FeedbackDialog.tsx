import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { feedback, type FeedbackKind } from "@/lib/api";

/** Whether this build has somewhere to send feedback; false until the daemon says so. */
export function useFeedbackEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    feedback.status().then(
      (s) => {
        if (live) setEnabled(s.enabled);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}

const FIELD =
  "w-full rounded-md border bg-transparent px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-ring";

const KINDS: { id: FeedbackKind; label: string }[] = [
  { id: "bug", label: "Something is broken" },
  { id: "idea", label: "An idea" },
  { id: "other", label: "Something else" },
];

export function FeedbackDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [includeLog, setIncludeLog] = useState(true);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setBusy(true);
    try {
      await feedback.send({
        kind,
        message: message.trim(),
        email: email.trim() || undefined,
        include_log: includeLog,
      });
      toast.success("Thanks! Your feedback was sent.");
      setMessage("");
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            Tell us what works, what doesn’t and what you’d like to see. Only what you write here is
            sent.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (message.trim()) void send();
          }}
        >
          <label className="flex flex-col gap-1.5">
            What is it about?
            <select
              className={FIELD}
              value={kind}
              onChange={(e) => setKind(e.target.value as FeedbackKind)}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            Message
            <textarea
              className={FIELD}
              aria-label="Message"
              rows={6}
              maxLength={5000}
              autoFocus
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                kind === "bug" ? "What did you do, and what happened?" : "What’s on your mind?"
              }
            />
          </label>
          <label className="flex flex-col gap-1.5">
            Email (optional, if you’d like a reply)
            <input
              className={FIELD}
              type="email"
              aria-label="Email"
              value={email}
              maxLength={320}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              checked={includeLog}
              onChange={(e) => setIncludeLog(e.target.checked)}
            />
            Include the app’s recent log to help us find problems
          </label>
          <Button type="submit" disabled={busy || !message.trim()}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
