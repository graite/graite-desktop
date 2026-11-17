import { useCallback, useSyncExternalStore } from "react";

/** App-wide, not per vault: someone who knows their way around models does in every vault. */
const KEY = "graite.techMode";
const listeners = new Set<() => void>();
// Remembered here too, so the switch works for this session when storage is unavailable.
let fallback = false;

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return fallback;
  }
}

export function setTechMode(on: boolean): void {
  fallback = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Storage can be unavailable; the switch still works for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** "I'm a proper geek" (Settings → General): shows every model, engine build and path, and
 * "Your own server". Off by default. Every reader updates as soon as it is switched. */
export function useTechMode(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, read);
  const set = useCallback((next: boolean) => setTechMode(next), []);
  return [on, set];
}
