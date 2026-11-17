import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Cloud,
  Cpu,
  MessageCircle,
  MousePointer2,
  PenLine,
  Settings2,
  SlidersHorizontal,
  Telescope,
} from "lucide-react";
import { toast } from "sonner";
import { ai, type AIConfig, type AIStatus } from "@/lib/ai";
import { cloud, type CloudModel } from "@/lib/cloud";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatMode } from "@/lib/ai";
import { useModelOptions, type ModelOption } from "@/models/useModelOptions";
import { DictationButton } from "./DictationButton";
import { offersReasoning, ReasoningControl, ReasoningItems } from "./ReasoningControl";

/** The composer's own choices, folded into one settings menu when there is no room for a
 * button each (the chat beside a page). */
export interface CompactControls {
  modes?: { id: ChatMode; label: string; hint: string }[];
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  actEnabled: boolean;
  depth?: "quick" | "deep";
  onDepthChange?: (depth: "quick" | "deep") => void;
}

const MODE_ICONS = { ask: MessageCircle, draft: PenLine, act: MousePointer2 } as const;

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
  const refreshCloud = useCallback(async () => {
    let offered: CloudModel | null = null;
    try {
      const account = await cloud.status();
      if (account.signed_in) offered = (await cloud.models()).find((m) => m.available) ?? null;
    } catch {
      offered = null;
    }
    if (mounted.current) setCloudModel(offered);
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
      {!cloudModel && !groups.some((g) => g.options.length) && (
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
    const current = compact.modes?.find((m) => m.id === compact.mode);
    const summary = [current?.label, compact.depth === "deep" ? "Deep" : null, label]
      .filter(Boolean)
      .join(" · ");
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
            {compact.modes && (
              <>
                <DropdownMenuLabel className="ai-model-group">Mode</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={compact.mode}
                  onValueChange={(value) => compact.onModeChange(value as ChatMode)}
                >
                  {compact.modes.map((m) => {
                    const Icon = MODE_ICONS[m.id];
                    return (
                      <DropdownMenuRadioItem
                        key={m.id}
                        value={m.id}
                        disabled={m.id === "act" && !compact.actEnabled}
                        title={m.hint}
                      >
                        <Icon size={15} />
                        <span className="flex-1">
                          <span className="block">{m.label}</span>
                          <span className="text-xs text-muted-foreground">{m.hint}</span>
                        </span>
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuRadioGroup>
              </>
            )}
            {compact.onDepthChange && compact.mode === "ask" && (
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
            {compact.modes && <DropdownMenuSeparator />}
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
