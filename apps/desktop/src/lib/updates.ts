import { useEffect, useState } from "react";
import { platform, type AppUpdate } from "@/lib/platform";

/** Where the app is with updating itself. One state for the whole window, so the notice at
 * startup and the card in Settings always agree. */
export type UpdateState =
  | { step: "unsupported" }
  | { step: "idle"; version: string; checkedAt: number | null }
  | { step: "checking"; version: string }
  | { step: "available"; version: string; update: AppUpdate }
  /** `fraction` is null while the size of the download is not known. */
  | { step: "installing"; version: string; update: AppUpdate; fraction: number | null }
  | { step: "failed"; version: string; message: string };

let state: UpdateState = { step: "unsupported" };
let started: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: UpdateState) {
  state = next;
  for (const listener of listeners) listener();
}

/** Ask the host once whether this install can update itself, and which version it runs. */
function start(): Promise<void> {
  started ??= (async () => {
    const status = await platform.updates?.status().catch(() => null);
    if (status?.supported) set({ step: "idle", version: status.version, checkedAt: null });
  })();
  return started;
}

/** Look for a newer version. Quiet when one is already found or being installed. */
export async function checkForUpdate(): Promise<void> {
  await start();
  if (!platform.updates || state.step === "unsupported") return;
  if (state.step === "checking" || state.step === "available" || state.step === "installing")
    return;
  const version = state.version;
  set({ step: "checking", version });
  try {
    const update = await platform.updates.check();
    set(
      update
        ? { step: "available", version, update }
        : { step: "idle", version, checkedAt: Date.now() },
    );
  } catch (e) {
    set({ step: "failed", version, message: e instanceof Error ? e.message : String(e) });
  }
}

/** Download and install the update that was found. The app restarts when it is in place. */
export async function installUpdate(): Promise<void> {
  if (!platform.updates || state.step !== "available") return;
  const { version, update } = state;
  set({ step: "installing", version, update, fraction: null });
  try {
    await platform.updates.install((fraction) =>
      set({ step: "installing", version, update, fraction }),
    );
  } catch (e) {
    set({ step: "failed", version, message: e instanceof Error ? e.message : String(e) });
  }
}

export function useUpdateState(): UpdateState {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    void start();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}

/** For tests: forget what was found. */
export function resetUpdatesForTest() {
  state = { step: "unsupported" };
  started = null;
  listeners.clear();
}
