import { useEffect, useState } from "react";
import { api, type Health } from "../lib/api";
import { platform } from "../lib/platform";

export function DaemonStatus({ compact = false }: { compact?: boolean }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      api
        .health()
        .then((h) => {
          if (cancelled) return;
          setHealth(h);
          setError(null);
        })
        .catch((e: Error) => !cancelled && setError(e.message));
    void poll();
    const timer = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const dot = (
    <span
      className={`inline-block size-2 rounded-full ${error ? "bg-red-500" : health ? "bg-green-500" : "bg-neutral-400"}`}
    />
  );

  if (compact) {
    return (
      <div
        className="flex items-center gap-2 text-xs text-muted-foreground"
        title={error ?? health?.vault ?? ""}
      >
        {dot}
        <span className="truncate">
          {error ? "daemon unreachable" : health ? `daemon ${health.version}` : "connecting…"}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4 text-sm">
      <div className="mb-2 flex items-center gap-2">
        {dot}
        <span className="font-medium">Daemon</span>
        <span className="text-muted-foreground">via {platform.kind}</span>
      </div>
      {error && <div className="text-red-600">{error}</div>}
      {health && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">version</dt>
          <dd>{health.version}</dd>
          <dt className="text-muted-foreground">vault</dt>
          <dd className="truncate">{health.vault}</dd>
          <dt className="text-muted-foreground">sqlite-vec</dt>
          <dd>{health.index.vec_version}</dd>
        </dl>
      )}
    </div>
  );
}
