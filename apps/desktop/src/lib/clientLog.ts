import { platform } from "./platform";

/** Forward UI errors to the daemon log (visible in the terminal / log bundle). Fire-and-forget. */
export function reportError(message: string, error?: unknown, context?: string): void {
  const stack =
    error instanceof Error ? error.stack : error !== undefined ? String(error) : undefined;
  void platform
    .getDaemonInfo()
    .then(({ url, token }) =>
      fetch(`${url}/api/v1/client-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ level: "error", message, stack, context }),
      }),
    )
    .catch(() => {});
}

export function installGlobalErrorReporting(): void {
  window.addEventListener("error", (e) => reportError(e.message, e.error, "window.onerror"));
  window.addEventListener("unhandledrejection", (e) =>
    reportError(
      e.reason instanceof Error ? e.reason.message : String(e.reason),
      e.reason,
      "unhandledrejection",
    ),
  );
}
