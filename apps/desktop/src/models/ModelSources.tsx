import { ModelSelect } from "./ModelSelect";
import { useState } from "react";
import { Download, FolderPlus, FilePlus2, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/api";
import { platform } from "@/lib/platform";
import type { components } from "@graite/api-types";
import { megabytes } from "@/lib/engines";

type Model = components["schemas"]["CatalogModel"];

/** `owner/name` from a Hugging Face link or repository id; the daemon normalises it the same
 * way (models/hub.py), this is only for labels before it answers. */
export function repositoryOf(value: string): string {
  const trimmed = value.trim().replace(/^https?:\/\/(www\.)?huggingface\.co\//i, "");
  return trimmed.split(/[/?#]/).slice(0, 2).join("/");
}

/** "Qwen3.8-27B-GGUF" for "unsloth/Qwen3.8-27B-GGUF": what the Model dropdown shows. */
export function modelName(repository: string): string {
  return repository.split("/").pop() || repository;
}

export function ModelSources({
  disabled,
  onChange,
}: {
  disabled: boolean;
  onChange: () => Promise<void>;
}) {
  const [panel, setPanel] = useState<"discover" | "folder" | "file" | null>(null);
  // Repositories looked up in this session, as `owner/name`; the dropdown switches between them.
  const [repositories, setRepositories] = useState<string[]>([]);
  const [repository, setRepository] = useState("");
  const [link, setLink] = useState("");
  const [path, setPath] = useState("");
  const [results, setResults] = useState<Model[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const action = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const browse = async (repo: string) => {
    setResults([]);
    setSelected("");
    const models = await request<Model[]>("/api/v1/ai/hub/browse", {
      method: "POST",
      body: JSON.stringify({ repository: repo }),
    });
    const found = models[0]?.repo ?? repositoryOf(repo);
    setRepository(found);
    setRepositories((known) => (known.includes(found) ? known : [...known, found]));
    if (!models.length) throw new Error("No GGUF files found in this Hugging Face repository.");
    setResults(models);
    setSelected(
      (
        models.find((m) => /UD-Q4_K_M/i.test(m.filename)) ??
        models.find((m) => /Q4_K_M/i.test(m.filename)) ??
        models[0]
      )?.id ?? "",
    );
  };
  const addPath = async (kind: "folder" | "file", value: string) => {
    await request(`/api/v1/ai/hub/${kind}`, {
      method: "POST",
      body: JSON.stringify({ path: value }),
    });
    await onChange();
    setNotice(
      kind === "folder"
        ? "Folder added. Choose a model from your library."
        : "Model added to your library.",
    );
  };
  const pick = (kind: "folder" | "file") =>
    void action("picker", async () => {
      if (!platform.pickModelPath) {
        setPanel(kind);
        return;
      }
      const chosen = await platform.pickModelPath(kind);
      if (chosen) {
        await addPath(kind, chosen);
        setPanel(null);
      }
    });
  const chosen = results.find((m) => m.id === selected);
  const locked = disabled || !!busy;
  return (
    <div className="ai-model-sources">
      <div className="ai-source-buttons">
        <Button
          variant={panel === "discover" ? "secondary" : "outline"}
          size="sm"
          disabled={locked}
          aria-expanded={panel === "discover"}
          onClick={() => setPanel(panel === "discover" ? null : "discover")}
        >
          <Link2 size={14} /> Add from Hugging Face
        </Button>
        <Button variant="outline" size="sm" disabled={locked} onClick={() => pick("folder")}>
          <FolderPlus size={14} /> Add folder
        </Button>
        <Button variant="outline" size="sm" disabled={locked} onClick={() => pick("file")}>
          <FilePlus2 size={14} /> Add model file
        </Button>
      </div>
      <p className="ai-source-hint">
        Paste a link to a GGUF model on Hugging Face, or pick a model file or a folder of models on
        this computer.
      </p>
      {panel === "discover" && (
        <div className="ai-source-panel">
          <div className="ai-discovery-heading">
            <h3>Add a model from Hugging Face</h3>
            <span>GGUF files, downloaded to this computer</span>
          </div>
          <form
            className="ai-hub-link"
            onSubmit={(e) => {
              e.preventDefault();
              void action("browse", () => browse(link.trim()));
            }}
          >
            <label className="ai-field">
              Hugging Face link
              <input
                value={link}
                disabled={locked}
                placeholder="https://huggingface.co/owner/model-GGUF"
                spellCheck={false}
                onChange={(e) => setLink(e.target.value)}
              />
            </label>
            <Button size="sm" variant="outline" disabled={locked || !link.trim()}>
              {busy === "browse" ? "Finding versions…" : "Find versions"}
            </Button>
          </form>
          {repositories.length > 0 && (
            <div className="ai-discovery-fields">
              <label className="ai-field">
                Model
                <ModelSelect
                  label="Model"
                  value={repository}
                  disabled={locked}
                  onValueChange={(value) => void action("browse", () => browse(value))}
                >
                  {repositories.map((repo) => (
                    <option key={repo} value={repo}>
                      {modelName(repo)}
                    </option>
                  ))}
                </ModelSelect>
                <small className="ai-field-hint">from {repository.split("/")[0]}</small>
              </label>
              <label className="ai-field">
                Quantization
                <ModelSelect
                  label="Quantization"
                  value={selected}
                  disabled={locked || !results.length}
                  onValueChange={(value) => setSelected(value)}
                >
                  {!results.length && (
                    <option value="">
                      {busy === "browse" ? "Finding versions…" : "No versions loaded"}
                    </option>
                  )}
                  {results.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.filename.match(/(?:UD-)?(?:IQ\d|Q\d|BF16|F16|F32)[A-Z0-9_]*/i)?.[0] ??
                        m.filename}{" "}
                      · {megabytes(m.size)}
                    </option>
                  ))}
                </ModelSelect>
              </label>
            </div>
          )}
          {repositories.length > 0 && (
            <div className="ai-discovery-footer">
              <p>
                {chosen
                  ? `${megabytes(chosen.size)} download${(chosen.files?.length ?? 0) > 1 ? ` · ${chosen.files?.length} parts` : ""}`
                  : "Choose a model and version."}
                <br />
                These models need a recent llama.cpp engine.
              </p>
              <Button
                size="sm"
                disabled={locked || !chosen}
                onClick={() =>
                  chosen &&
                  void action("download", async () => {
                    await request("/api/v1/ai/hub/add", {
                      method: "POST",
                      body: JSON.stringify({
                        repository: chosen.repo,
                        filename: chosen.filename,
                        revision: chosen.revision,
                      }),
                    });
                    await onChange();
                    setNotice("Added to your library. The download continues below.");
                  })
                }
              >
                <Download size={14} />
                {busy === "download" ? "Adding…" : "Download model"}
              </Button>
            </div>
          )}
        </div>
      )}
      {(panel === "folder" || panel === "file") && (
        <form
          className="ai-source-panel"
          onSubmit={(e) => {
            e.preventDefault();
            void action("local", () => addPath(panel, path));
          }}
        >
          <label className="ai-field">
            {panel === "folder" ? "Model folder" : "GGUF model file"}
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              disabled={locked}
              placeholder={panel === "folder" ? "~/Models" : "~/Models/model.gguf"}
            />
          </label>
          <Button size="sm" disabled={locked || !path.trim()}>
            Add {panel === "folder" ? "folder" : "model"}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="ai-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="ai-source-notice">
          {notice}
        </p>
      )}
    </div>
  );
}
