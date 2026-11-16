import { useEffect } from "react";
import { toast } from "sonner";
import { checkForUpdate, installUpdate, useUpdateState } from "@/lib/updates";

const TOAST_ID = "app-update";
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Looks for a newer Graite shortly after startup and a few times a day, and says so when
 * there is one. Nothing is installed until the user asks for it. Renders nothing itself. */
export function UpdateNotice() {
  const state = useUpdateState();

  useEffect(() => {
    const first = window.setTimeout(() => void checkForUpdate(), FIRST_CHECK_MS);
    const again = window.setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(again);
    };
  }, []);

  useEffect(() => {
    if (state.step === "available") {
      toast(`Graite ${state.update.version} is available`, {
        id: TOAST_ID,
        description: "Installing takes a moment and restarts Graite.",
        duration: Infinity,
        closeButton: true,
        action: { label: "Install and restart", onClick: () => void installUpdate() },
      });
    } else if (state.step === "installing") {
      const percent = state.fraction === null ? "" : ` ${Math.round(state.fraction * 100)}%`;
      toast.loading(`Installing Graite ${state.update.version}…${percent}`, {
        id: TOAST_ID,
        description: "Graite restarts when it is done.",
        duration: Infinity,
      });
    } else {
      // A failure is shown in Settings, where the check can be repeated; no toast to nag with.
      toast.dismiss(TOAST_ID);
    }
  }, [state]);

  return null;
}
