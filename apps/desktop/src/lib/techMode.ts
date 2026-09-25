import { useCallback, useState } from "react";

/** App-wide, not per vault: someone who knows their way around models does in every vault. */
const KEY = "graite.techMode";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** "I'm a tech geek": shows every model, quantization and engine control. Off by default. */
export function useTechMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(read);
  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      // Storage can be unavailable; the switch still works for this session.
    }
  }, []);
  return [on, set];
}
