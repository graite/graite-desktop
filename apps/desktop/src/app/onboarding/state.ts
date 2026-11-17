import type { Profile } from "@/lib/profile";

// App-wide, not per vault: the onboarding runs once per computer.
export const ONBOARDED_KEY = "graite.onboarded";
/** Set by the name question that came before the onboarding: those people know Graite. */
export const NAME_ASKED_KEY = "graite.nameAsked";

function stored(key: string): boolean {
  try {
    return !!localStorage.getItem(key);
  } catch {
    return true; // storage unavailable: don't show it on every start
  }
}

/** Whether to show the first-run onboarding. Not before the profile has loaded (null), and
 * never to people who finished it, were asked their name before it existed, or have a name. */
export function needsOnboarding(me: Profile | null): boolean {
  if (me === null || me.first_name) return false;
  return !stored(ONBOARDED_KEY) && !stored(NAME_ASKED_KEY);
}

export function markOnboarded() {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
    localStorage.setItem(NAME_ASKED_KEY, "1");
  } catch {
    /* storage unavailable: nothing to remember it in */
  }
}
