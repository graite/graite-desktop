import { useEffect, useState } from "react";
import { ChevronRight, Orbit, Sparkles } from "lucide-react";
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
import { InstructionExamples } from "./InstructionExamples";
import "./ai-settings.css";

type Autonomy = "auto-apply" | "propose" | "none";
type Cloud = "allowed" | "local-only" | "none";
/** Who may read a page, from most to least open. A page can only be stricter than its parents. */
const CLOUD_ORDER: Cloud[] = ["allowed", "local-only", "none"];
const CLOUD_LABEL: Record<Cloud, string> = {
  allowed: "Cloud and local AI",
  "local-only": "Local models only",
  none: "No AI",
};

/** A radio group. Each option is `[value, label, what it means]`. */
function Choices<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: [T, string, string?][];
  value: T;
  onChange: (value: T) => void;
  /** Options a parent's stricter choice rules out. */
  disabled?: (key: T) => boolean;
}) {
  return (
    <fieldset className="ai-page-choices">
      <legend>{label}</legend>
      {options.map(([key, text, hint]) => (
        <div key={key} className="ai-page-choice">
          <label>
            <input
              type="radio"
              name={label}
              value={key}
              checked={value === key}
              disabled={disabled?.(key) && key !== value}
              aria-describedby={hint ? `${label}-${key}-hint` : undefined}
              onChange={() => onChange(key)}
            />
            {text}
          </label>
          {hint && <small id={`${label}-${key}-hint`}>{hint}</small>}
        </div>
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
  const [examplesOpen, setExamplesOpen] = useState(false);
  // The inherited source whose full text is shown.
  const [expanded, setExpanded] = useState<string | null>(null);
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
  // The strictest reading rule set above this page; this page can only match it or go further.
  const cloudFloor: Cloud =
    inherited && inherited.sources.cloud !== path && inherited.values.cloud !== "allowed"
      ? (inherited.values.cloud as Cloud)
      : "allowed";
  const lockedCloud = cloudFloor !== "allowed";
  const stricter = (a: Cloud, b: Cloud) =>
    CLOUD_ORDER.indexOf(a) >= CLOUD_ORDER.indexOf(b) ? a : b;
  const activeAutonomy = lockedChanges
    ? "none"
    : (autonomy ?? (inherited?.values.autonomy as Autonomy) ?? "propose");
  const activeCloud = stricter(
    cloud ?? (inherited?.values.cloud as Cloud) ?? "allowed",
    cloudFloor,
  );
  const ancestors = (settings?.effective.instructions ?? []).filter((i) => i.source !== path);
  const sourceName = (s: string) =>
    s === "AGENTS.md"
      ? "Workspace instructions"
      : s === "vault"
        ? "Workspace defaults"
        : s.replace(/\/AGENTS\.md$/, " · shared instructions");
  // The workspace comes first in the chain even when it has no instructions yet.
  const steps = ancestors.some((i) => i.source === "AGENTS.md")
    ? ancestors
    : [{ source: "AGENTS.md", text: "" }, ...ancestors];
  /** The first lines of some instructions, as plain text. */
  const preview = (text: string) =>
    text
      .replace(/^[#>\-*\d.\s]+/gm, "")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
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
            autonomy === "auto-apply" ? ["append", "create", "edit", "properties", "rows"] : null,
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
  const openPageSettings = async (source: string) => {
    if (!settings || !onNavigateSettings) return;
    const dirty =
      instructions !== String(settings.own.instructions ?? "") ||
      access !== (settings.own.ai_scope === "page" ? "page" : "subtree") ||
      autonomy !== (settings.own.autonomy ?? null) ||
      cloud !== (settings.own.cloud ?? null);
    if (dirty && !(await save(false))) return;
    try {
      await onNavigateSettings(source);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
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
              <DialogDescription>
                Tell AI how to work with this page, and decide what it may read and change.
              </DialogDescription>
            </div>
          </DialogHeader>
          {!settings ? (
            <p className="ai-setting-note">{error || "Loading…"}</p>
          ) : (
            <div className="ai-settings-form">
              <div className="ai-settings-main">
                <section className="ai-setting">
                  <div className="ai-setting-head">
                    <div>
                      <h3>Instructions</h3>
                      <p className="ai-setting-note">
                        What AI should know or do here. It reads this every time it reads, changes
                        or creates pages here: in chat, agents and connected apps.
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setExamplesOpen(true)}>
                      <Sparkles size={14} /> Examples
                    </Button>
                  </div>
                  <TextInstructionsEditor value={instructions} onChange={setInstructions} />
                </section>
                <section className="ai-inherited-sources" aria-label="Inherited instructions">
                  <h3>Also applies here</h3>
                  <p className="ai-setting-note">
                    Instructions add up from the top down, so write a rule once, on the highest page
                    it applies to. Permissions take the nearest choice above, and can only get
                    stricter further down.
                  </p>
                  <ol className="ai-chain" aria-label="Order in which instructions apply">
                    {steps.map((entry) => {
                      const name = sourceName(entry.source);
                      const shared = entry.source.endsWith("AGENTS.md");
                      const isOpen = expanded === entry.source;
                      return (
                        <li key={entry.source} data-open={isOpen || undefined}>
                          <div className="ai-chain-row">
                            <button
                              type="button"
                              className="ai-chain-name"
                              aria-expanded={isOpen}
                              disabled={!entry.text}
                              onClick={() => setExpanded(isOpen ? null : entry.source)}
                            >
                              <strong>
                                {name}
                                {entry.text && <ChevronRight size={13} />}
                              </strong>
                              {!isOpen && (
                                <span>
                                  {entry.text ? preview(entry.text) : "No instructions yet"}
                                </span>
                              )}
                            </button>
                            {shared ? (
                              <button
                                type="button"
                                className="ai-chain-action"
                                aria-label={`Edit ${name.toLowerCase()}`}
                                onClick={() => setEditingSource(entry.source)}
                              >
                                {entry.text ? "Edit" : "Add"}
                              </button>
                            ) : (
                              entry.source !== "vault" &&
                              onNavigateSettings && (
                                <button
                                  type="button"
                                  className="ai-chain-action"
                                  aria-label={`Open AI settings of ${name}`}
                                  title="Your changes here are saved first"
                                  disabled={saving}
                                  onClick={() => void openPageSettings(entry.source)}
                                >
                                  Open
                                </button>
                              )
                            )}
                          </div>
                          {isOpen && (
                            <TextInstructionsEditor
                              value={entry.text}
                              readOnly
                              label={`Inherited instructions from ${entry.source}`}
                            />
                          )}
                        </li>
                      );
                    })}
                    <li data-current>
                      <div className="ai-chain-row">
                        <div className="ai-chain-name">
                          <strong>This page</strong>
                          <span>
                            {instructions.trim()
                              ? "The instructions above"
                              : "No instructions of its own yet"}
                          </span>
                        </div>
                      </div>
                    </li>
                  </ol>
                </section>
              </div>
              <aside className="ai-settings-permissions">
                <Choices
                  label="Applies to"
                  value={access}
                  onChange={setAccess}
                  options={[
                    ["page", "This page"],
                    ["subtree", "This page + children"],
                  ]}
                />
                <p className="ai-setting-note">
                  Where the instructions and permissions you set here count.
                </p>
                <Choices
                  label="Changes"
                  value={activeAutonomy}
                  onChange={setAutonomy}
                  disabled={() => lockedChanges}
                  options={[
                    [
                      "propose",
                      "Ask before applying",
                      "AI suggests a change; you accept or reject it in the review.",
                    ],
                    [
                      "auto-apply",
                      "Apply changes automatically",
                      "Changes are made straight away and listed afterwards.",
                    ],
                    ["none", "Don’t allow changes", "AI can read the page but never change it."],
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
                        Edits, additions, new pages, property changes and table rows apply
                        automatically. Deleting or moving pages still asks first.
                      </p>
                    )}
                  </div>
                )}
                <Choices
                  label="Who can read this page"
                  value={activeCloud}
                  onChange={setCloud}
                  disabled={(key) => CLOUD_ORDER.indexOf(key) < CLOUD_ORDER.indexOf(cloudFloor)}
                  options={[
                    [
                      "allowed",
                      CLOUD_LABEL.allowed,
                      "Any model you use: on this computer, Graite Cloud, a model with an API key, and connected apps such as Claude or ChatGPT.",
                    ],
                    [
                      "local-only",
                      CLOUD_LABEL["local-only"],
                      "Only models running on this computer. The page is never sent to a cloud model or a connected app.",
                    ],
                    [
                      "none",
                      CLOUD_LABEL.none,
                      "No model reads this page: not in chat, agents, your assistant or connected apps.",
                    ],
                  ]}
                />
                <p className="ai-setting-note">
                  {lockedCloud && (
                    <>
                      {sourceName(inherited!.sources.cloud)} sets “{CLOUD_LABEL[cloudFloor]}”, so
                      this page cannot be more open than that.{" "}
                    </>
                  )}
                  {cloud === null ? (
                    !lockedCloud &&
                    `Inherited from ${sourceName(inherited?.sources.cloud ?? "defaults")}.`
                  ) : (
                    <button className="ai-setting-reset" onClick={() => setCloud(null)}>
                      Use the inherited choice
                    </button>
                  )}
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
      <InstructionExamples
        open={examplesOpen}
        onOpenChange={setExamplesOpen}
        hasText={!!instructions.trim()}
        onUse={(example, replace) =>
          setInstructions(
            replace || !instructions.trim()
              ? example.text
              : `${instructions.trimEnd()}\n\n${example.text}`,
          )
        }
      />
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
