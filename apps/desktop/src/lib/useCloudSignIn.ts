import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { onDaemonEvent } from "./api";
import { cloud, type CloudModel, type CloudStatus } from "./cloud";

/** The Graite account as the UI sees it: its status, and the browser sign-in. The daemon runs
 * the sign-in and tells every window when it ends (`cloud_status`), so this updates by itself.
 * Used by the Graite Cloud card in Settings and by the first-run onboarding. */
export function useCloudSignIn({ loadModels = false }: { loadModels?: boolean } = {}) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [models, setModels] = useState<CloudModel[]>([]);
  const [waiting, setWaiting] = useState<string | null>(null); // the sign-in URL
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Requests can finish after the view is gone (leaving Settings, a test ending).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await cloud.status();
      const offered = loadModels && next.signed_in ? await cloud.models() : [];
      if (!mounted.current) return;
      setStatus(next);
      if (next.signed_in) setWaiting(null);
      setModels(offered);
      setError("");
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }, [loadModels]);

  useEffect(() => {
    void refresh();
    return onDaemonEvent((event) => {
      if (event.type === "cloud_status") void refresh();
    });
  }, [refresh]);

  const signIn = async (signup: boolean) => {
    setError("");
    try {
      const started = await cloud.login(signup);
      if (!mounted.current) return;
      setWaiting(started.url);
      if (!started.opened) setError("Your browser didn’t open. Copy the link and open it there.");
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  };
  const copyLink = async () => {
    if (!waiting) return;
    try {
      await navigator.clipboard.writeText(waiting);
      setCopied(true);
      setTimeout(() => mounted.current && setCopied(false), 1500);
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  };
  const signOut = async () => {
    try {
      await cloud.logout();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return {
    status,
    models,
    waiting,
    error,
    copied,
    signIn,
    copyLink,
    signOut,
    refresh,
    /** Stop waiting for the browser (the sign-in there may still finish). */
    cancel: () => setWaiting(null),
  };
}
