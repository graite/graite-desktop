import { useSyncExternalStore } from "react";

/**
 * How a question in Ask mode is answered. "quick" (the default) is one search and one model
 * call; "deep" researches in several small steps and takes longer. App-wide and remembered.
 */
export type Depth = "quick" | "deep";

const KEY = "graite.chat.depth";
const listeners = new Set<() => void>();

export function chatDepth(): Depth {
  try {
    return localStorage.getItem(KEY) === "deep" ? "deep" : "quick";
  } catch {
    return "quick";
  }
}

export function setChatDepth(depth: Depth): void {
  try {
    localStorage.setItem(KEY, depth);
  } catch {
    // Storage can be unavailable; the choice then lasts until the next reload.
  }
  listeners.forEach((listener) => listener());
}

export function useDepth(): [Depth, (depth: Depth) => void] {
  const depth = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    chatDepth,
    () => "quick" as Depth,
  );
  return [depth, setChatDepth];
}
