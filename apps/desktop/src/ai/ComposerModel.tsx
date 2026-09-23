import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Cloud, Cpu, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { ai, type AIConfig, type AIStatus } from "@/lib/ai";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useModelOptions, type ModelOption } from "@/models/useModelOptions";
import { DictationButton } from "./DictationButton";

export function ComposerModel({
  busy,
  contextId,
  working,
  onWorking,
  value,
  onChange,
  onSettings,
  settingsVersion,
  onModelChanged,
}: {
  busy: boolean;
  contextId?: string;
  working: boolean;
  onWorking: (value: boolean) => void;
  value: string;
  onChange: (text: string) => void;
  onSettings?: () => void;
  settingsVersion?: number;
  onModelChanged?: () => void;
}) {
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  const { groups, catalog } = useModelOptions((settingsVersion ?? 0) + version);
  const refresh = useCallback(async () => {
    try {
      const fresh = await ai.status();
      setStatus(fresh);
      return fresh;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh, settingsVersion]);
  const config = status?.config ?? null;
  const isCurrent = (option: ModelOption) =>
    option.kind === "local"
      ? config?.provider === "local" && config.model_path === option.model_path
      : config?.provider !== "local" && config?.saved_model_id === option.saved_model_id;
  const choose = async (option: ModelOption) => {
    if (!config || saving || busy || working) return;
    setSaving(true);
    try {
      const fresh = (await ai.status()).config;
      const next: AIConfig =
        option.kind === "local"
          ? {
              ...fresh,
              provider: "local",
              model_path: option.model_path ?? "",
              saved_model_id: null,
            }
          : { ...fresh, saved_model_id: option.saved_model_id ?? null };
      await ai.save(next);
      await refresh();
      onModelChanged?.();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const label = status?.active?.label;
  const speech = catalog.find((m) => m.id === "whisper-large-v3-turbo-q8");
  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) {
            void refresh();
            setVersion((v) => v + 1);
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="ai-composer-model"
            aria-label="Choose chat model"
            disabled={busy || working || saving}
          >
            <span>{saving ? "Switching…" : label || "Choose model"}</span>
            <ChevronDown size={13} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="min-w-60 max-w-80">
          {groups.map((group) =>
            group.options.length ? (
              <div key={group.id}>
                <DropdownMenuLabel className="ai-model-group">{group.name}</DropdownMenuLabel>
                {group.options.map((option) => (
                  <DropdownMenuItem key={option.key} onSelect={() => void choose(option)}>
                    {option.kind === "local" ? <Cpu size={15} /> : <Cloud size={15} />}
                    <span className="flex-1 truncate">
                      {option.label}
                      {option.detail && <small className="ai-model-detail"> {option.detail}</small>}
                    </span>
                    {isCurrent(option) && <Check size={14} />}
                  </DropdownMenuItem>
                ))}
              </div>
            ) : null,
          )}
          {!groups.some((g) => g.options.length) && (
            <DropdownMenuItem disabled>No models installed or saved yet</DropdownMenuItem>
          )}
          {onSettings && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onSettings}>
                <Settings2 size={15} />
                Settings
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {speech && (
        <DictationButton
          key={contextId}
          available={speech.status === "installed"}
          busy={busy || saving}
          value={value}
          onChange={onChange}
          onWorking={onWorking}
        />
      )}
    </>
  );
}
