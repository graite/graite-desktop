import { useSyncExternalStore } from "react";

/** Light or dark, chosen by the user or following the system. One setting for the whole app. */
export type ThemeChoice = "light" | "dark" | "system";
export type Theme = "light" | "dark";

const KEY = "graite.theme";
const listeners = new Set<() => void>();

function systemDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function themeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* storage unavailable: follow the system */
  }
  return "system";
}

export function currentTheme(): Theme {
  const choice = themeChoice();
  if (choice === "system") return systemDark() ? "dark" : "light";
  return choice;
}

/** Put the theme on the document. Charts and dashboards watch the `dark` class. */
export function applyTheme(): void {
  const theme = currentTheme();
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  for (const listener of listeners) listener();
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* storage unavailable: the choice lasts for this session's document only */
    document.documentElement.classList.toggle(
      "dark",
      choice === "dark" || (choice === "system" && systemDark()),
    );
  }
  applyTheme();
}

/** Apply the stored theme and keep following the system while the user has not chosen. */
export function initTheme(): void {
  applyTheme();
  if (typeof matchMedia !== "function") return;
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => "light" as const);
}

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, themeChoice, () => "system" as const);
}
