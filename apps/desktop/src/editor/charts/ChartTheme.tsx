import { Check } from "lucide-react";
import { isDark, PALETTES, type PaletteName } from "./palettes";

const PALETTE_NAMES: PaletteName[] = ["mono", "vivid", "ocean", "sunset", "forest", "candy"];

/** The color themes as swatch rows; `value` "" means grayscale. */
export function ThemeSwatches({
  value,
  onChange,
}: {
  value: string;
  onChange: (palette: string) => void;
}) {
  const current = (value || "mono") as PaletteName;
  return (
    <div className="chart-themes" role="radiogroup" aria-label="Colors">
      {PALETTE_NAMES.map((name) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={current === name}
          className="chart-theme"
          onClick={() => onChange(name === "mono" ? "" : name)}
        >
          <span className="chart-theme-dots">
            {(isDark() ? PALETTES[name].dark : PALETTES[name].light).slice(0, 5).map((c) => (
              <i key={c} style={{ background: c }} />
            ))}
          </span>
          <span>{PALETTES[name].label}</span>
          {current === name && <Check size={13} className="ml-auto" />}
        </button>
      ))}
    </div>
  );
}
