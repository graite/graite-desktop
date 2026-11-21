import { request } from "./api";
import type { components } from "@graite/api-types";

export type SyncStatus = components["schemas"]["SyncStatus"];
export type SyncSpace = components["schemas"]["SyncSpace"];
export type SyncDevice = components["schemas"]["SyncDevice"];

const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

/** Sync between your devices through Graite Cloud. The daemon holds the keys and does the
 * work; the passphrase is shown or typed here and never kept by the page. */
export const sync = {
  status: () => request<SyncStatus>("/api/v1/sync/status"),
  /** Makes the account's keys and a six-word passphrase on this computer. */
  setup: () => post<SyncStatus>("/api/v1/sync/setup"),
  /** The passphrase to type on another device; null when this computer does not hold it. */
  passphrase: () =>
    request<components["schemas"]["PassphraseOut"]>("/api/v1/sync/passphrase").then(
      (out) => out.passphrase ?? null,
    ),
  unlock: (passphrase: string) => post<SyncStatus>("/api/v1/sync/unlock", { passphrase }),
  enable: (spaceId?: string) =>
    post<SyncStatus>("/api/v1/sync/enable", spaceId ? { space_id: spaceId } : {}),
  disable: () => post<SyncStatus>("/api/v1/sync/disable"),
  /** Start sync over for the whole account (forgotten passphrase, lost device). */
  reset: () => post<SyncStatus>("/api/v1/sync/reset"),
};
