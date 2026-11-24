import { useCallback, useEffect, useRef, useState } from "react";
import { mail } from "@/lib/mail";

const POLL_MS = 1500;

/**
 * "Sign in with Microsoft": the daemon opens Microsoft's page in the browser and waits for
 * it to come back; this watches until that is done. The password is typed at Microsoft,
 * never in Graite.
 */
export function useMicrosoftSignIn(onDone: (accountId: string) => void) {
  // The sign-in page's address while waiting, shown in case no browser opened.
  const [waiting, setWaiting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const done = useRef(onDone);
  done.current = onDone;

  const stop = useCallback(() => {
    clearTimeout(timer.current);
    setWaiting(null);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const start = useCallback(async (accountId?: string) => {
    setError("");
    clearTimeout(timer.current);
    try {
      const started = await mail.microsoftSignIn(accountId);
      setWaiting(started.url);
      const watch = async () => {
        try {
          const state = await mail.signInState(started.id);
          if (state.status === "done" && state.account_id) {
            setWaiting(null);
            done.current(state.account_id);
            return;
          }
          if (state.status === "error") {
            setWaiting(null);
            setError(state.error || "The sign-in did not finish.");
            return;
          }
        } catch (e) {
          setWaiting(null);
          setError((e as Error).message);
          return;
        }
        timer.current = setTimeout(() => void watch(), POLL_MS);
      };
      timer.current = setTimeout(() => void watch(), POLL_MS);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  return { waiting, error, start, stop };
}
