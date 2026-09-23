import { microphone } from "./recording";
import type { DaemonInfo, Platform } from "./types";

/** PWA served by the daemon itself (M9): same origin, token handed over at pairing time.
 * The daemon owns the vault here, so the vault-selection methods are absent. */
export const webPlatform: Platform = {
  kind: "web",
  microphone,
  async getDaemonInfo(): Promise<DaemonInfo> {
    const token = sessionStorage.getItem("graite.token") ?? "";
    return { url: window.location.origin, token, vault: null, dev: false };
  },
  mediaUrl(path) {
    return `/media/${path.split("/").map(encodeURIComponent).join("/")}`;
  },
};
