import { ModelSelect } from "./ModelSelect";
import { useState } from "react";
import { Download, FolderPlus, FilePlus2, Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/api";
import { platform } from "@/lib/platform";
import type { components } from "@graite/api-types";
import { megabytes } from "@/lib/engines";

type Model = components["schemas"]["CatalogModel"];
const families = {
  google: {
    name: "Gemma 4",
    author: "Google",
    models: [
      ["E2B", "unsloth/gemma-4-E2B-it-GGUF"],
      ["E4B", "unsloth/gemma-4-E4B-it-GGUF"],
      ["26B · A4B", "unsloth/gemma-4-26B-A4B-it-GGUF"],
      ["31B", "unsloth/gemma-4-31B-it-GGUF"],
    ],
  },
  qwen: {
    name: "Qwen3.8",
    author: "Qwen",
    models: [["27B", "unsloth/Qwen3.8-27B-GGUF"]],
  },
} as const;

export function ModelSources({
  disabled,
  onChange,
}: {
  disabled: boolean;
  onChange: () => Promise<void>;
}) {
  const [panel, setPanel] = useState<"discover" | "folder" | "file" | null>(null);
  const [family, setFamily] = useState<keyof typeof families>("google");
  const [repository, setRepository] = useState<string>(families.google.models[0][1]);
  const [custom, setCustom] = useState("");
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
          onClick={() => {
            if (panel === "discover") {
              setPanel(null);
              return;
            }
            setPanel("discover");
            if (!results.length) void action("browse", () => browse(repository));
          }}
        >
          <Compass size={14} /> Discover models
        </Button>
        <Button variant="outline" size="sm" disabled={locked} onClick={() => pick("folder")}>
          <FolderPlus size={14} /> Add folder
        </Button>
        <Button variant="outline" size="sm" disabled={locked} onClick={() => pick("file")}>
          <FilePlus2 size={14} /> Add model
        </Button>
      </div>
      {panel === "discover" && (
        <div className="ai-source-panel">
          <div className="ai-discovery-heading">
            <h3>Find your next model</h3>
            <span>GGUF downloads from Unsloth</span>
          </div>
          <div className="ai-family-grid">
            {Object.entries(families).map(([id, f]) => (
              <button
                key={id}
                className={`ai-family ${family === id ? "selected" : ""}`}
                aria-pressed={family === id}
                disabled={locked}
                onClick={() => {
                  const key = id as keyof typeof families;
                  setFamily(key);
                  setRepository(f.models[0][1]);
                  void action("browse", () => browse(f.models[0][1]));
                }}
              >
                <span className="ai-family-mark" aria-hidden="true">
                  {f.author[0]}
                </span>
                <div>
                  <strong>{f.name}</strong>
                  <span>{f.author}</span>
                </div>
              </button>
            ))}
          </div>
          <div className="ai-discovery-fields">
            <label className="ai-field">
              Model
              <ModelSelect
                label="Model"
                value={repository}
                disabled={locked}
                onValueChange={(value) => {
                  setRepository(value);
                  void action("browse", () => browse(value));
                }}
              >
                {!families[family].models.some(([, repo]) => repo === repository) && (
                  <option value={repository}>{repository}</option>
                )}
                {families[family].models.map(([name, repo]) => (
                  <option key={repo} value={repo}>
                    {families[family].name} {name}
                  </option>
                ))}
              </ModelSelect>
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
          <details className="ai-custom-repository">
            <summary>Use another Unsloth repository</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setRepository(custom);
                void action("browse", () => browse(custom));
              }}
            >
              <label className="ai-field">
                Hugging Face link or repository
                <input
                  value={custom}
                  disabled={locked}
                  placeholder="unsloth/model-name-GGUF"
                  onChange={(e) => setCustom(e.target.value)}
                />
              </label>
              <Button size="sm" variant="outline" disabled={locked || !custom.trim()}>
                Find versions
              </Button>
            </form>
          </details>
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
