import { useEffect, useState } from "react";
import { ArrowUpRight, FileText, Orbit } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ConflictError, pages, type AiSettings, type PageDoc } from "@/lib/api";
import { TextInstructionsEditor } from "@/editor/TextInstructionsEditor";
import "./ai-settings.css";

type Autonomy = "auto-apply" | "propose" | "none";
type Cloud = "allowed" | "local-only";

function Choices<T extends string>({
  label,
  options,
  value,
  onChange,
  locked,
}: {
  label: string;
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
  locked?: boolean;
}) {
  return (
    <fieldset className="ai-page-choices">
      <legend>{label}</legend>
      {options.map(([key, text]) => (
        <label key={key}>
          <input
            type="radio"
            name={label}
            value={key}
            checked={value === key}
            disabled={locked && key !== value}
            onChange={() => onChange(key)}
          />
          {text}
        </label>
      ))}
    </fieldset>
  );
}

function SourceEditor({
  source,
  onClose,
  onSaved,
}: {
  source: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState("");
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void pages.instructions
      .get(source)
      .then((s) => {
        if (live) {
          setText(s.text);
          setHash(s.hash);
        }
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [source]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="ai-settings-dialog ai-source-dialog">
        <DialogHeader>
          <DialogTitle>
            {source === "AGENTS.md" ? "Workspace instructions" : `Instructions · ${source}`}
          </DialogTitle>
        </DialogHeader>
        <p className="ai-setting-note">
          These shared instructions apply wherever this source is inherited.
        </p>
        <div className="ai-setting">
          {hash !== null && (
            <TextInstructionsEditor
              label="Shared instructions"
              value={text}
              onChange={setText}
              readOnly={busy}
            />
          )}
        </div>
        {text.length > 16000 && (
          <p className="ai-setting-error">Keep shared instructions under 16,000 characters.</p>
        )}
        {error && (
          <p role="alert" className="ai-setting-error">
            {error}
          </p>
        )}
        <div className="ai-setting-actions">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={hash === null || busy || text.length > 16000}
            onClick={async () => {
              if (hash === null) return;
              setBusy(true);
              setError("");
              try {
                await pages.instructions.put(source, text, hash);
                onSaved();
                onClose();
              } catch (e) {
                setError(
                  e instanceof ConflictError
                    ? "These instructions changed elsewhere. Close and reopen to load the latest version."
                    : (e as Error).message,
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save instructions"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AiSettingsDialog({
  path,
  title,
  open,
  onOpenChange,
  onNavigateSettings,
  onSaved,
}: {
  path: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigateSettings?: (path: string) => Promise<void>;
  onSaved?: (page: PageDoc) => void;
}) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [instructions, setInstructions] = useState("");
  const [access, setAccess] = useState<"page" | "subtree">("subtree");
  const [autonomy, setAutonomy] = useState<Autonomy | null>(null);
  const [cloud, setCloud] = useState<Cloud | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editingSource, setEditingSource] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setSettings(null);
    setError("");
    void pages.aiSettings
      .get(path)
      .then((data) => {
        if (!live) return;
        setSettings(data);
        setInstructions(String(data.own.instructions ?? ""));
        setAccess(data.own.ai_scope === "page" ? "page" : "subtree");
        setAutonomy((data.own.autonomy as Autonomy) ?? null);
        setCloud((data.own.cloud as Cloud) ?? null);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [open, path]);
  const inherited = settings?.inherited ?? settings?.effective;
  const lockedChanges =
    inherited?.values.autonomy === "none" && inherited.sources.autonomy !== path;
  const lockedCloud = inherited?.values.cloud === "local-only" && inherited.sources.cloud !== path;
  const activeAutonomy = lockedChanges
    ? "none"
    : (autonomy ?? (inherited?.values.autonomy as Autonomy) ?? "propose");
  const activeCloud = lockedCloud
    ? "local-only"
    : (cloud ?? (inherited?.values.cloud as Cloud) ?? "allowed");
  const ancestors = (settings?.effective.instructions ?? []).filter((i) => i.source !== path);
  const sourceName = (s: string) =>
    s === "AGENTS.md"
      ? "Workspace instructions"
      : s === "vault"
        ? "Workspace defaults"
        : s.replace(/\/AGENTS\.md$/, " · shared instructions");
  const save = async (close = true) => {
    if (!settings || instructions.length > 8000) return false;
    setSaving(true);
    setError("");
    try {
      const updated = await pages.aiSettings.put(
        path,
        {
          instructions: instructions.trim() || null,
          ai_scope: access,
          autonomy,
          cloud,
          model: null,
          auto_apply_kinds:
            autonomy === "auto-apply" ? ["append", "create", "edit", "properties"] : null,
        },
        settings.page?.hash ?? null,
      );
      setSettings(updated);
      if (updated.page) onSaved?.(updated.page);
      toast.success("AI settings saved");
      if (close) onOpenChange(false);
      return true;
    } catch (e) {
      setError(
        e instanceof ConflictError
          ? "This page changed elsewhere. Reopen settings to load the latest version; your draft has not been saved."
          : (e as Error).message,
      );
      return false;
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="ai-settings-dialog">
          <DialogHeader className="ai-settings-header">
            <div className="ai-settings-heading-icon">
              <Orbit size={21} />
            </div>
            <div>
              <DialogTitle>AI settings · {title}</DialogTitle>
              <DialogDescription>Guide how AI works with this page.</DialogDescription>
            </div>
          </DialogHeader>
          {!settings ? (
            <p className="ai-setting-note">{error || "Loading…"}</p>
          ) : (
            <div className="ai-settings-form">
              <div className="ai-settings-main">
                <section className="ai-setting">
                  <h3>Instructions</h3>
                  <p className="ai-setting-note">
                    New contacts must contain… Add your guidance below.
                  </p>
                  <TextInstructionsEditor value={instructions} onChange={setInstructions} />
                  <p className="ai-setting-note">
                    Use / for text, headings, bullet points, bold and italic.
                  </p>
                </section>
                <section className="ai-inherited-sources">
                  <h3>
                    Inherited instructions <span>{ancestors.length}</span>
                  </h3>
                  <p className="ai-setting-note">
                    These apply here too. Open a source to read them; edit them in its own settings.
                  </p>
                  {ancestors.length === 0 && (
                    <p className="ai-setting-note">No instructions inherited from parent pages.</p>
                  )}
                  {ancestors.map((entry) => (
                    <details key={entry.source}>
                      <summary>
                        <FileText size={15} />
                        <span>{sourceName(entry.source)}</span>
                      </summary>
                      <TextInstructionsEditor
                        value={entry.text}
                        readOnly
                        label={`Inherited instructions from ${entry.source}`}
                      />
                      {entry.source.endsWith("AGENTS.md") ? (
                        <button onClick={() => setEditingSource(entry.source)}>
                          <ArrowUpRight size={14} />
                          Open shared instruction settings
                        </button>
                      ) : (
                        entry.source !== "vault" &&
                        onNavigateSettings && (
                          <button
                            disabled={saving}
                            onClick={() =>
                              void (async () => {
                                const dirty =
                                  instructions !== String(settings.own.instructions ?? "") ||
                                  access !==
                                    (settings.own.ai_scope === "page" ? "page" : "subtree") ||
                                  autonomy !== (settings.own.autonomy ?? null) ||
                                  cloud !== (settings.own.cloud ?? null);
                                if (dirty && !(await save(false))) return;
                                try {
                                  await onNavigateSettings(entry.source);
                                  onOpenChange(false);
                                } catch (e) {
                                  setError((e as Error).message);
                                }
                              })()
                            }
                          >
                            <ArrowUpRight size={14} />
                            Open page settings
                          </button>
                        )
                      )}
                    </details>
                  ))}
                  {!ancestors.some((i) => i.source === "AGENTS.md") && (
                    <button
                      className="ai-setting-reset"
                      onClick={() => setEditingSource("AGENTS.md")}
                    >
                      Open workspace instruction settings
                    </button>
                  )}
                  {onNavigateSettings && ancestors.some((i) => !i.source.endsWith("AGENTS.md")) && (
                    <p className="ai-setting-note">
                      Your changes are saved when you open another page’s settings.
                    </p>
                  )}
                </section>
              </div>
              <aside className="ai-settings-permissions">
                <Choices
                  label="Access"
                  value={access}
                  onChange={setAccess}
                  options={[
                    ["page", "This page"],
                    ["subtree", "This page + children"],
                  ]}
                />
                <p className="ai-setting-note">
                  Choose where these instructions and permissions apply.
                </p>
                <Choices
                  label="Changes"
                  value={activeAutonomy}
                  onChange={setAutonomy}
                  locked={lockedChanges}
                  options={[
                    ["propose", "Ask before applying"],
                    ["auto-apply", "Apply changes automatically"],
                    ["none", "Don’t allow changes"],
                  ]}
                />
                {lockedChanges ? (
                  <p className="ai-setting-note">
                    Changes are disabled by {sourceName(inherited!.sources.autonomy)}. Edit that
                    source to change this.
                  </p>
                ) : (
                  <div className="ai-setting-note">
                    {autonomy === null ? (
                      `Inherited from ${sourceName(inherited?.sources.autonomy ?? "defaults")}.`
                    ) : (
                      <button className="ai-setting-reset" onClick={() => setAutonomy(null)}>
                        Use inherited change permissions
                      </button>
                    )}
                    {activeAutonomy === "auto-apply" && (
                      <p>
                        Edits, additions, new pages and property changes apply automatically.
                        Deleting or moving pages still asks first.
                      </p>
                    )}
                  </div>
                )}
                <Choices
                  label="Cloud"
                  value={activeCloud}
                  onChange={setCloud}
                  locked={lockedCloud}
                  options={[
                    ["allowed", "Allowed"],
                    ["local-only", "Local models only"],
                  ]}
                />
                <p className="ai-setting-note">
                  {lockedCloud ? (
                    `Local models only is required by ${sourceName(inherited!.sources.cloud)}.`
                  ) : cloud === null ? (
                    `Inherited from ${sourceName(inherited?.sources.cloud ?? "defaults")}.`
                  ) : (
                    <button className="ai-setting-reset" onClick={() => setCloud(null)}>
                      Use inherited cloud permissions
                    </button>
                  )}{" "}
                  Models are selected in chat or in the agent.
                </p>
              </aside>
              {instructions.length > 8000 && (
                <p className="ai-setting-error">Keep page instructions under 8,000 characters.</p>
              )}
              {error && (
                <p role="alert" className="ai-setting-error">
                  {error}
                </p>
              )}
              <div className="ai-setting-actions">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button disabled={saving || instructions.length > 8000} onClick={() => void save()}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {editingSource && (
        <SourceEditor
          source={editingSource}
          onClose={() => setEditingSource(null)}
          onSaved={() => {
            void pages.aiSettings
              .get(path)
              .then(setSettings)
              .catch((e: Error) => setError(e.message));
          }}
        />
      )}
    </>
  );
}
