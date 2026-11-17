import { Brain } from "lucide-react";
import { toast } from "sonner";
import { ai, type AIStatus } from "@/lib/ai";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Thinking = "auto" | "on" | "off";
type Effort = "low" | "medium" | "high";

const THINKING: { value: Thinking; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "The model decides" },
  { value: "on", label: "On", hint: "Think first, answer after" },
  { value: "off", label: "Off", hint: "Answer straight away" },
];
const EFFORT: { value: Effort; label: string; hint: string }[] = [
  { value: "low", label: "Low", hint: "Fastest" },
  { value: "medium", label: "Medium", hint: "Balanced" },
  { value: "high", label: "High", hint: "Most thorough" },
];

/**
 * How much the chat model thinks before it answers. Shows only what the model in use can
 * do: a thinking switch, an effort level, both, or nothing at all (the button is not drawn).
 * A change applies from the next question and never reloads the model.
 */
export function ReasoningControl({
  status,
  disabled,
  onChanged,
}: {
  status: AIStatus | null;
  disabled: boolean;
  onChanged: () => void;
}) {
  const offers = status?.reasoning;
  const config = status?.config;
  if (!config || !offers || (!offers.toggle && !offers.effort)) return null;
  const thinking = (config.thinking ?? "auto") as Thinking;
  const effort = (config.effort ?? "medium") as Effort;
  const save = async (change: { thinking?: Thinking; effort?: Effort }) => {
    try {
      await ai.reasoning(change);
      onChanged();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const summary = [
    offers.toggle && thinking !== "auto" ? `Thinking ${thinking}` : "",
    offers.effort && thinking !== "off" && effort !== "medium" ? `${effort} effort` : "",
  ].filter(Boolean);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="ai-composer-model ai-composer-reasoning"
          aria-label="Thinking and effort"
          title={summary.join(", ") || "Thinking and effort"}
          data-set={summary.length ? "" : undefined}
          disabled={disabled}
        >
          <Brain size={14} />
          {summary.length > 0 && <span>{summary.join(" · ")}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-56">
        {offers.toggle && (
          <>
            <DropdownMenuLabel className="ai-model-group">Thinking</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={thinking}
              onValueChange={(value) => void save({ thinking: value as Thinking })}
            >
              {THINKING.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  <span className="flex-1">{option.label}</span>
                  <small className="ai-model-detail">{option.hint}</small>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {offers.toggle && offers.effort && <DropdownMenuSeparator />}
        {offers.effort && (
          <>
            <DropdownMenuLabel className="ai-model-group">Effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={thinking === "off" ? "" : effort}
              onValueChange={(value) => void save({ effort: value as Effort })}
            >
              {EFFORT.map((option) => (
                <DropdownMenuRadioItem
                  key={option.value}
                  value={option.value}
                  disabled={thinking === "off"}
                >
                  <span className="flex-1">{option.label}</span>
                  <small className="ai-model-detail">{option.hint}</small>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
