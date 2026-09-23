import { useState } from "react";
import { Check, FileCheck2, ChevronDown, X } from "lucide-react";
import { toast } from "sonner";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { review, type Proposal } from "@/lib/review";
import "./review.css";

/** The open page's review count with the two bulk decisions, in the page's top bar. */
export function PageReviewBar({
  proposals,
  beforeAccept,
  onDecided,
  onJump,
}: {
  proposals: Proposal[];
  /** Save pending edits first, so applying a change does not collide with the editor. */
  beforeAccept: () => Promise<void>;
  onDecided: () => void;
  onJump: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (!proposals.length) return null;
  const pending = proposals.filter((p) => p.status === "pending");
  const conflicts = proposals.length - pending.length;
  const work = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      onDecided();
    }
  };
  const acceptAll = () =>
    work(async () => {
      await beforeAccept();
      const result = await review.acceptBatch(pending.map((p) => p.id));
      const applied = `Applied ${result.applied.length} change${result.applied.length === 1 ? "" : "s"}`;
      if (result.stopped_at) toast.warning(`${applied}, then stopped at a conflict.`);
      else toast.success(`${applied}.`);
    });
  const discardAll = () =>
    work(async () => {
      const { rejected } = await review.rejectBatch(proposals.map((p) => p.id));
      toast.success(`Discarded ${rejected.length} proposal${rejected.length === 1 ? "" : "s"}.`);
    });
  return (
    <section className="review-bar" aria-label="Open reviews on this page">
      <button
        type="button"
        className="review-bar-count"
        onClick={onJump}
        title="Show the first one"
      >
        <FileCheck2 size={14} />
        {proposals.length} open review{proposals.length === 1 ? "" : "s"}
        {conflicts ? <span> · {conflicts} in conflict</span> : null}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="review-bar-menu"
            aria-label="Review actions"
            title="Review actions"
            disabled={busy}
          >
            Actions <ChevronDown size={13} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={busy || !pending.length} onSelect={() => void acceptAll()}>
            <Check /> Accept all
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={() => setConfirming(true)}>
            <X /> Discard all
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard {proposals.length} proposal{proposals.length === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every open proposal for this page is rejected. The page itself does not change, and
              this cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction onClick={() => void discardAll()}>Discard all</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
