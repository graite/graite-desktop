import { useEffect, useRef, useState } from "react";
import { onDaemonEvent } from "@/lib/api";
import { charts } from "@/lib/charts";
import { dashboards } from "@/lib/dashboards";
import { paletteColors } from "../charts/palettes";
import { cssColor } from "../tables/theme";

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 4000;

function theme() {
  const dark = document.documentElement.classList.contains("dark");
  return {
    mode: dark ? "dark" : "light",
    colors: {
      background: cssColor("background", "#ffffff"),
      foreground: cssColor("foreground", "#1a1a1a"),
      muted: cssColor("muted-foreground", "#71717a"),
      border: cssColor("border", "#e4e4e7"),
      accent: cssColor("accent", "#f4f4f5"),
      palette: [...paletteColors(undefined, dark)],
    },
    font: getComputedStyle(document.body).fontFamily,
  };
}

/**
 * A dashboard in a sandboxed iframe (`allow-scripts` only: no access to the app, its storage
 * or the network). The frame asks for data over postMessage and this side answers, reading
 * only the tables `pagePath` may read; it also passes on theme changes and table changes.
 */
export function DashboardFrame({
  pagePath,
  src,
  proposalId,
  height,
  maxHeight = MAX_HEIGHT,
  title,
}: {
  pagePath: string;
  src?: string;
  proposalId?: string;
  /** A fixed height in pixels, or 0 to fit the dashboard's content. */
  height: number;
  /** When fitting the content: at most this tall. */
  maxHeight?: number;
  title: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [fitted, setFitted] = useState(480);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    dashboards
      .frameUrl(pagePath, { src, proposalId })
      .then((u) => live && (setUrl(u), setError("")))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [pagePath, src, proposalId, version]);

  useEffect(() => {
    const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");
    const onMessage = async (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const m = event.data as {
        graite?: number;
        id?: number;
        method?: string;
        args?: Record<string, unknown>;
        event?: string;
        value?: number;
      };
      if (!m || m.graite !== 1) return;
      if (m.event === "ready") post({ graite: 1, event: "theme", theme: theme() });
      else if (m.event === "height" && typeof m.value === "number")
        setFitted(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(m.value))));
      else if (m.id && m.method) {
        try {
          let result: unknown;
          if (m.method === "query")
            result = await charts.query(pagePath, String(m.args?.sql ?? ""));
          else if (m.method === "chart")
            result = await charts.data(pagePath, (m.args?.spec ?? {}) as Record<string, string>);
          else if (m.method === "page")
            result = { path: pagePath, title: pagePath.split("/").pop() };
          else throw new Error(`Unknown request ${m.method}.`);
          post({ graite: 1, id: m.id, result });
        } catch (e) {
          post({ graite: 1, id: m.id, error: (e as Error).message });
        }
      }
    };
    window.addEventListener("message", onMessage);
    const observer = new MutationObserver(() =>
      post({ graite: 1, event: "theme", theme: theme() }),
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onDaemonEvent((e) => {
      const data = e.data as { path?: string };
      if (e.type === "table_changed") {
        clearTimeout(timer);
        timer = setTimeout(
          () => post({ graite: 1, event: "change", detail: { table: data.path } }),
          250,
        );
      } else if (e.type === "dashboard_changed" && src && data.path === `${pagePath}/${src}`) {
        setVersion((v) => v + 1);
      }
    });
    return () => {
      window.removeEventListener("message", onMessage);
      observer.disconnect();
      clearTimeout(timer);
      stop();
    };
  }, [pagePath, src]);

  if (error) return <div className="table-empty error">{error}</div>;
  return url ? (
    <iframe
      ref={frame}
      key={url}
      src={url}
      title={title}
      className="dashboard-frame"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ height: height || Math.min(fitted, maxHeight) }}
    />
  ) : (
    <div className="table-empty">Loading dashboard…</div>
  );
}
