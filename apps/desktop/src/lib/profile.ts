import { useEffect, useState } from "react";
import { request } from "./api";
import type { components } from "@graite/api-types";

export type Profile = components["schemas"]["Profile"];

/** What the user told Graite about themselves. One profile for the whole app, kept by the
 * daemon in the app folder and given to the AI so it can address them by name. */
export const profile = {
  get: () => request<Profile>("/api/v1/profile"),
  save: (value: Profile) =>
    request<Profile>("/api/v1/profile", { method: "PUT", body: JSON.stringify(value) }),
};

const listeners = new Set<(value: Profile) => void>();

/** Save and tell every open view (the welcome greeting, Settings). */
export async function saveProfile(value: Profile): Promise<Profile> {
  const saved = await profile.save(value);
  for (const listener of listeners) listener(saved);
  return saved;
}

/** The profile, or null while it loads or when the daemon cannot be reached. */
export function useProfile(): Profile | null {
  const [value, setValue] = useState<Profile | null>(null);
  useEffect(() => {
    let live = true;
    profile
      .get()
      .then((p) => live && setValue(p))
      .catch(() => undefined);
    listeners.add(setValue);
    return () => {
      live = false;
      listeners.delete(setValue);
    };
  }, []);
  return value;
}
