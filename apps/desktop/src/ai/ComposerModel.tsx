import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Cloud,
  Cpu,
  MonitorCog,
  Settings2,
  SlidersHorizontal,
  Telescope,
  Ticket,
} from "lucide-react";
import { toast } from "sonner";
import { ai, type AIConfig, type AIStatus } from "@/lib/ai";
import { cloud, type CloudModel } from "@/lib/cloud";
import { claudeCode } from "@/lib/claudeCode";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatMode } from "@/lib/ai";
import { useModelOptions, type ModelOption } from "@/models/useModelOptions";
import { useWorkstations } from "@/models/useWorkstations";
import { compute, type ComputeDevice } from "@/lib/compute";
import { DictationButton } from "./DictationButton";
import { offersReasoning, ReasoningControl, ReasoningItems } from "./ReasoningControl";

/** The composer's own choices, folded into one settings menu when there is no room for a
 * button each (the chat beside a page). */
export interface CompactControls {
  mode: ChatMode;
  depth?: "quick" | "deep";
  onDepthChange?: (depth: "quick" | "deep") => void;
}

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
  compact,
}: {
  /** Fold mode, depth, model and thinking into one menu. */
  compact?: CompactControls;
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
  // Your AI workstations: the chat models on your other computers. Looked up with the rest
  // when the menu opens.
  const workstations = useWorkstations((settingsVersion ?? 0) + version, false).status;
  const stations = (workstations?.devices ?? []).filter((d) => d.chat_models.length > 0);
  const chooseStation = async (device: ComputeDevice, model: string) => {
    if (saving || busy || working) return;
    setSaving(true);
    try {
      await compute.use(device.id, "chat", true, model);
      await refresh();
      onModelChanged?.();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  // Graite Cloud, when signed in: one entry, the model it offers.
  const [cloudModel, setCloudModel] = useState<CloudModel | null>(null);
  // The lookup can finish after the picker is gone (closing a chat, a test ending).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A Claude subscription, when Claude Code is signed in: its models, by family.
  const [claudeModels, setClaudeModels] = useState<string[]>([]);
  const refreshCloud = useCallback(async () => {
    let offered: CloudModel | null = null;
    try {
      const account = await cloud.status();
      if (account.signed_in) offered = (await cloud.models()).find((m) => m.available) ?? null;
    } catch {
      offered = null;
    }
    let claude: string[] = [];
    try {
      const found = await claudeCode.status();
      if (found.signed_in) claude = found.models;
    } catch {
      claude = [];
    }
    if (!mounted.current) return;
    setCloudModel(offered);
    setClaudeModels(claude);
  }, []);
  useEffect(() => {
    void refreshCloud();
  }, [refreshCloud, settingsVersion]);
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
  const choose = async (option: ModelOption | CloudModel) => {
    if (!config || saving || busy || working) return;
    setSaving(true);
    try {
      const fresh = (await ai.status()).config;
      const next: AIConfig = !("kind" in option)
        ? {
            ...fresh,
            provider: "graite",
            model: option.id,
            saved_model_id: null,
            connection_id: null,
          }
        : option.kind === "local"
          ? {
              ...fresh,
              provider: "local",
              model_path: option.model_path ?? "",
              saved_model_id: null,
            }
          : {
              ...fresh,
              // Graite Cloud and a workstation are not saved connections: leaving either as
              // the provider would make the daemon drop the saved model again.
              provider:
                fresh.provider === "graite" ||
                fresh.provider === "device" ||
                fresh.provider === "claude_code"
                  ? "compatible"
                  : fresh.provider,
              saved_model_id: option.saved_model_id ?? null,
            };
      await ai.save(next);
      await refresh();
      onModelChanged?.();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const chooseClaude = async (model: string) => {
    if (!config || saving || busy || working) return;
    setSaving(true);
    try {
      const fresh = (await ai.status()).config;
      await ai.save({
        ...fresh,
        provider: "claude_code",
        model,
        saved_model_id: null,
        connection_id: null,
      });
      await refresh();
      onModelChanged?.();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const label = status?.active?.label;
  // Dictation works wherever speech to text can run: local Whisper or Graite Cloud.
  const speech = catalog.some((m) => m.id === "whisper-large-v3-turbo-q8");
  const openModels = (open: boolean) => {
    if (open) {
      void refresh();
      void refreshCloud();
      setVersion((v) => v + 1);
    }
  };
  const modelItems = (
    <>
      {cloudModel && (
        <div>
          <DropdownMenuLabel className="ai-model-group">Graite Cloud</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => void choose(cloudModel)}>
            <Cloud size={15} />
            <span className="flex-1 truncate">Graite Cloud</span>
            {config?.provider === "graite" && <Check size={14} />}
          </DropdownMenuItem>
        </div>
      )}
      {claudeModels.length > 0 && (
        <div>
          <DropdownMenuLabel className="ai-model-group">Claude subscription</DropdownMenuLabel>
          {claudeModels.map((model) => (
            <DropdownMenuItem key={model} onSelect={() => void chooseClaude(model)}>
              <Ticket size={15} />
              <span className="flex-1 truncate">
                Claude {model.charAt(0).toUpperCase() + model.slice(1)}
              </span>
              {config?.provider === "claude_code" && config.model === model && <Check size={14} />}
            </DropdownMenuItem>
          ))}
        </div>
      )}
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
      {stations.map((device) => (
        <div key={device.id}>
          <DropdownMenuLabel className="ai-model-group">
            Workstation · {device.name}
          </DropdownMenuLabel>
          {device.chat_models.map((model) => (
            <DropdownMenuItem key={model} onSelect={() => void chooseStation(device, model)}>
              <MonitorCog size={15} />
              <span className="flex-1 truncate">{model}</span>
              {config?.provider === "device" &&
                config.device_id === device.id &&
                config.model === model && <Check size={14} />}
            </DropdownMenuItem>
          ))}
        </div>
      ))}
      {!cloudModel &&
        !claudeModels.length &&
        !stations.length &&
        !groups.some((g) => g.options.length) && (
          <DropdownMenuItem disabled>
            No model yet. Download one or connect a server in Settings.
          </DropdownMenuItem>
        )}
      {onSettings && !compact && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSettings}>
            <Settings2 size={15} />
            Settings
          </DropdownMenuItem>
        </>
      )}
    </>
  );
  const dictation = speech && (
    <DictationButton
      key={contextId}
      available={!!status?.speech_source}
      busy={busy || saving}
      value={value}
      onChange={onChange}
      onWorking={onWorking}
    />
  );
  if (compact) {
    const summary = [compact.depth === "deep" ? "Deep" : null, label].filter(Boolean).join(" · ");
    return (
      <>
        <DropdownMenu onOpenChange={openModels}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="ai-composer-icon ai-composer-settings"
              aria-label="Chat settings"
              title={summary || "Chat settings"}
              disabled={busy || working || saving}
            >
              <SlidersHorizontal size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="min-w-64 max-w-80">
            {compact.onDepthChange && compact.mode !== "act" && (
              <DropdownMenuCheckboxItem
                checked={compact.depth === "deep"}
                onCheckedChange={(on) => compact.onDepthChange?.(on ? "deep" : "quick")}
                onSelect={(e) => e.preventDefault()}
              >
                <Telescope size={15} />
                <span className="flex-1">
                  <span className="block">Deep research</span>
                  <span className="text-xs text-muted-foreground">
                    Several searches, a fuller answer, slower
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
            )}
            {compact.onDepthChange && compact.mode !== "act" && <DropdownMenuSeparator />}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Cpu size={15} />
                <span className="flex-1 truncate">
                  Model
                  <small className="ai-model-detail">
                    {" "}
                    {saving ? "Switching…" : label || "Choose"}
                  </small>
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-60 max-w-80">
                {modelItems}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {offersReasoning(status) && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <SlidersHorizontal size={15} />
                  <span className="flex-1">Thinking and effort</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-56">
                  <ReasoningItems status={status} onChanged={() => void refresh()} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
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
        {dictation}
      </>
    );
  }
  return (
    <>
      <ReasoningControl
        status={status}
        disabled={busy || working || saving}
        onChanged={() => void refresh()}
      />
      <DropdownMenu onOpenChange={openModels}>
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
          {modelItems}
        </DropdownMenuContent>
      </DropdownMenu>
      {dictation}
    </>
  );
}
