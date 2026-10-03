import { useRef, useState } from "react";
import { ArrowUp, Code2, FileText, LayoutDashboard, Loader2, Sparkles, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { dashboards } from "@/lib/dashboards";

/** Add a self-contained HTML file, or hand creation to the page's side chat (D74). */
export function DashboardAddDialog({
  pagePath,
  onPick,
  onCreateAI,
  onCancel,
}: {
  pagePath: string;
  onPick: (src: string) => void;
  onCreateAI: (kind: "dashboard" | "report", idea?: string) => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");

  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    if (!/\.html$/i.test(file.name)) {
      setError("Choose an .html file.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const stem = file.name.replace(/\.html$/i, "");
      const src = `_dashboards/${stem}.html`;
      await dashboards.write(pagePath, src, await file.text(), true);
      onPick(src);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="dashboard-add-dialog" aria-describedby="dashboard-add-description">
        <div className="dashboard-add-head">
          <DialogTitle>Add HTML</DialogTitle>
          <DialogDescription id="dashboard-add-description">
            Upload an HTML file or create a live report with the page’s AI chat.
          </DialogDescription>
        </div>

        <button
          type="button"
          className={`dashboard-upload${dragging ? " dragging" : ""}`}
          disabled={busy}
          onClick={() => input.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void upload(event.dataTransfer.files[0]);
          }}
        >
          {busy ? <Loader2 className="dashboard-spin" size={22} /> : <Upload size={22} />}
          <strong>{busy ? "Adding HTML…" : "Upload HTML file"}</strong>
          <span>or drag and drop a self-contained .html file here</span>
        </button>
        <input
          ref={input}
          className="sr-only"
          type="file"
          accept=".html,text/html"
          aria-label="Upload HTML file"
          onChange={(event) => void upload(event.target.files?.[0])}
        />

        <section className="dashboard-create-ai">
          <div className="dashboard-add-label">
            <Sparkles size={13} /> Create with AI in this page’s chat
          </div>
          <div className="dashboard-ai-types">
            <button type="button" onClick={() => onCreateAI("dashboard")}>
              <span data-tone="dashboard">
                <LayoutDashboard size={18} />
              </span>
              <div>
                <strong>Dashboard</strong>
                <small>Metrics and live charts</small>
              </div>
            </button>
            <button type="button" onClick={() => onCreateAI("report")}>
              <span data-tone="report">
                <FileText size={18} />
              </span>
              <div>
                <strong>Report</strong>
                <small>A structured data story</small>
              </div>
            </button>
          </div>
          <form
            className="dashboard-idea"
            onSubmit={(event) => {
              event.preventDefault();
              if (idea.trim()) onCreateAI("dashboard", idea.trim());
            }}
          >
            <Code2 size={15} />
            <input
              value={idea}
              placeholder="Or describe the HTML you want…"
              aria-label="Describe the HTML you want"
              onChange={(event) => setIdea(event.target.value)}
            />
            <button type="submit" aria-label="Create HTML with AI" disabled={!idea.trim()}>
              <ArrowUp size={14} />
            </button>
          </form>
        </section>
        {error && (
          <p className="dashboard-add-error" role="alert">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
