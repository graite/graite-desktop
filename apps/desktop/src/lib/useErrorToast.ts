import { useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * Shows an error from an action (a voice turn, a chat answer) as a toast in the corner that
 * goes away by itself, instead of a line that stays next to the control. Fires each time
 * `error` becomes a new non-empty message; the same message twice in a row shows once.
 */
export function useErrorToast(
  error: string | null | undefined,
  action?: { label: string; onClick: () => void },
) {
  const actionRef = useRef(action);
  actionRef.current = action;
  useEffect(() => {
    if (!error) return;
    const current = actionRef.current;
    toast.error(error, {
      id: `error:${error}`,
      duration: 8000,
      action: current ? { label: current.label, onClick: () => current.onClick() } : undefined,
    });
  }, [error]);
}
