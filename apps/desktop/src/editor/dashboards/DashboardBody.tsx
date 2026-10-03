import { useContext, useState } from "react";
import { Code2, LayoutDashboard, RefreshCw, Sparkles } from "lucide-react";
import { useDismissableLayerSurface } from "@radix-ui/react-dismissable-layer";
import { MediaContext } from "../media/context";
import type { GraiteEditor } from "../schema";
import { DashboardAddDialog } from "./DashboardAddDialog";
import { DashboardFrame } from "./DashboardFrame";
import "../tables/tables.css";
import "./dashboards.css";

export interface DashboardProps {
  src: string;
  height: number;
}

function askPageAI(prompt: string, send = true) {
  window.dispatchEvent(
    new CustomEvent("graite:ask-ai", {
      detail: { prompt, mode: "act", send },
    }),
  );
}

function creationPrompt(kind: "dashboard" | "report", idea?: string): string {
  const style =
    kind === "report"
      ? "a structured report with a strong narrative hierarchy, compact metrics, and supporting charts"
      : "a concise dashboard with aligned KPIs, live charts, and useful detail rows";
  return [
    `Create ${style} for this page using its real table data.`,
    "Load the charts-and-dashboards skill, inspect the available tables, then use propose_dashboard to build the complete self-contained HTML and show it on this page.",
    "Keep the default grayscale, use sharp pie and donut sectors, thin dividers, and a responsive layout. Do not invent values.",
    idea
      ? `My specific request: ${idea}`
      : "Choose the most useful measures and comparisons from the data.",
  ].join(" ");
}

export function DashboardBody({
  id,
  props,
  editor,
}: {
  id: string;
  props: DashboardProps;
  editor: GraiteEditor;
}) {
  const { pagePath } = useContext(MediaContext);
  const dismissSurface = useDismissableLayerSurface();
  const [reload, setReload] = useState(0);
  const update = (next: Partial<DashboardProps>) =>
    editor.updateBlock(id, { type: "dashboard", props: next });

  if (!pagePath)
    return <div className="table-empty">Save the page before adding an HTML file.</div>;

  if (!props.src)
    return (
      <div ref={dismissSurface} className="dashboard-add-anchor" contentEditable={false}>
        <Code2 size={15} /> Add HTML
        <DashboardAddDialog
          pagePath={pagePath}
          onPick={(src) => update({ src })}
          onCancel={() => editor.getBlock(id) && editor.removeBlocks([id])}
          onCreateAI={(kind, idea) => {
            if (editor.getBlock(id)) editor.removeBlocks([id]);
            // Let the editor apply the removal before Workspace flushes the page and opens chat.
            requestAnimationFrame(() => askPageAI(creationPrompt(kind, idea)));
          }}
        />
      </div>
    );

  const name = props.src.replace(/^_dashboards\//, "").replace(/\.html$/i, "");
  return (
    <div ref={dismissSurface} className="dashboard-view" contentEditable={false}>
      <div className="dashboard-head">
        <LayoutDashboard size={14} />
        <span className="dashboard-name">{name}</span>
        <div className="dashboard-actions">
          <button
            type="button"
            className="view-button"
            title="Reload"
            aria-label="Reload HTML"
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            className="view-button"
            onClick={() =>
              askPageAI(
                `Revise the existing HTML dashboard ${props.src} on this page. Read it first, then use the charts-and-dashboards skill and propose_dashboard with the same file name. My requested change: `,
                false,
              )
            }
          >
            <Sparkles size={13} /> Ask AI
          </button>
        </div>
      </div>
      <DashboardFrame
        key={reload}
        pagePath={pagePath}
        src={props.src}
        height={props.height}
        title={name}
      />
    </div>
  );
}
