import { useMemo, useState } from "react";
import { icons, type LucideIcon } from "lucide-react";
import dynamicIconImports from "lucide-react/dynamicIconImports";
import { EmojiPickerPanel } from "./EmojiPickerPanel";
import {
  formatIcon,
  iconColors,
  lucideComponentName,
  parseIcon,
  type IconColor,
} from "@/lib/pageIcon";
import "./page-icon.css";

const components = icons as Record<string, LucideIcon>;
/** Every Lucide icon by its own name (`file-text`), without the aliases of renamed icons. */
const ALL_ICONS = Object.keys(dynamicIconImports)
  .filter((name) => components[lucideComponentName(name)])
  .sort();
/** Shown before a search: icons people reach for first. */
const COMMON = (
  "star heart house folder file-text book bookmark calendar circle-check clock flag lightbulb " +
  "rocket target briefcase users user mail message-square phone map-pin globe camera image " +
  "music video code terminal database settings wrench shopping-cart credit-card wallet " +
  "chart-bar chart-line trending-up graduation-cap pencil notebook list-todo inbox archive tag " +
  "gift coffee utensils dumbbell plane car leaf sun moon cloud zap flame key lock shield bell " +
  "search link paperclip brain sparkles bot"
)
  .split(" ")
  .filter((name) => ALL_ICONS.includes(name));
const MAX_SHOWN = 160;

/** The page-icon picker shared by the page header and the sidebar tree: an emoji, or an icon
 * in a colour. */
export function IconPicker({
  icon,
  onPick,
  onRemove,
}: {
  icon: string | null | undefined;
  onPick: (icon: string) => void;
  onRemove: () => void;
}) {
  const current = parseIcon(icon);
  const [tab, setTab] = useState<"emoji" | "icons">(current?.kind === "lucide" ? "icons" : "emoji");
  const [query, setQuery] = useState("");
  const [color, setColor] = useState<IconColor>(
    current?.kind === "lucide" ? current.color : "default",
  );
  const found = useMemo(() => {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) return COMMON;
    return ALL_ICONS.filter((name) => words.every((word) => name.includes(word)));
  }, [query]);
  const chosen = current?.kind === "lucide" ? current.name : null;

  return (
    <div className="icon-picker">
      <div className="icon-picker-tabs" role="tablist" aria-label="Icon type">
        <button role="tab" aria-selected={tab === "emoji"} onClick={() => setTab("emoji")}>
          Emoji
        </button>
        <button role="tab" aria-selected={tab === "icons"} onClick={() => setTab("icons")}>
          Icons
        </button>
        {icon && (
          <button className="icon-picker-remove" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      {tab === "emoji" ? (
        <EmojiPickerPanel onPick={onPick} />
      ) : (
        <div className="icon-picker-icons">
          <input
            className="icon-picker-search"
            placeholder="Search icons..."
            aria-label="Search icons"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className="icon-picker-colors" role="radiogroup" aria-label="Icon colour">
            {iconColors.map((name) => (
              <button
                key={name}
                role="radio"
                aria-checked={color === name}
                aria-label={name}
                title={name[0]!.toUpperCase() + name.slice(1)}
                className="page-icon"
                data-color={name}
                onClick={() => {
                  setColor(name);
                  // The page already has an icon: recolour it straight away.
                  if (chosen) onPick(formatIcon(chosen, name));
                }}
              >
                <span />
              </button>
            ))}
          </div>
          <div className="icon-picker-grid">
            {found.slice(0, MAX_SHOWN).map((name) => {
              const Icon = components[lucideComponentName(name)]!;
              return (
                <button
                  key={name}
                  title={name}
                  aria-label={name}
                  aria-pressed={name === chosen}
                  onClick={() => onPick(formatIcon(name, color))}
                >
                  <Icon className="page-icon size-[18px]" data-color={color} aria-hidden />
                </button>
              );
            })}
          </div>
          <div className="icon-picker-note">
            {found.length === 0
              ? "No icons match"
              : found.length > MAX_SHOWN
                ? `Showing ${MAX_SHOWN} of ${found.length}. Keep typing to narrow down.`
                : query
                  ? `${found.length} icon${found.length === 1 ? "" : "s"}`
                  : `Search ${ALL_ICONS.length} icons`}
          </div>
        </div>
      )}
    </div>
  );
}
