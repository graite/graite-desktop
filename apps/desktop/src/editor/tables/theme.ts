import { useEffect, useState } from "react";
import type { Theme } from "@glideapps/glide-data-grid";
import { mix } from "./cells";

/**
 * Glide draws on a canvas, so it needs concrete colors rather than CSS variables. The app's
 * tokens are oklch(); painting each one onto a 1×1 canvas and reading the pixel back gives an
 * rgb() every canvas understands.
 */
let probe: CanvasRenderingContext2D | null | undefined;

function toRgb(color: string, fallback: string): string {
  if (!color) return fallback;
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return fallback;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = fallback;
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${((a ?? 255) / 255).toFixed(3)})`;
}

/** A CSS color token of the app (`--foreground`, ...) as rgb(), for canvas drawing. */
export function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return toRgb(value, fallback);
}

/** The blue of the page views' filter pills (views.css), used for selection instead of the
 *  near-black primary color, which drew heavy black rings around selected cells. */
const SELECTION = "#3189d1";

/** Colors the grid needs outside Glide's theme (misfit cells, checkboxes). */
export interface GridColors {
  foreground: string;
  background: string;
  destructive: string;
}

export function readColors(): GridColors {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    toRgb(style.getPropertyValue(`--${name}`).trim(), fallback);
  return {
    foreground: token("foreground", "#1a1a1a"),
    background: token("background", "#ffffff"),
    destructive: token("destructive", "#dc2626"),
  };
}

function readTheme(): Partial<Theme> {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    toRgb(style.getPropertyValue(`--${name}`).trim(), fallback);
  const background = token("background", "#ffffff");
  const foreground = token("foreground", "#1a1a1a");
  const muted = token("muted", "#f4f4f5");
  const mutedFg = token("muted-foreground", "#71717a");
  const border = token("border", "#e4e4e7");
  const accent = token("accent", "#f4f4f5");
  return {
    accentColor: SELECTION,
    accentFg: "#ffffff",
    accentLight: mix(SELECTION, 0.12, background),
    textDark: foreground,
    textMedium: mutedFg,
    textLight: mutedFg,
    textBubble: foreground,
    textHeader: mutedFg,
    textHeaderSelected: "#ffffff",
    bgIconHeader: mutedFg,
    fgIconHeader: background,
    bgCell: background,
    bgCellMedium: muted,
    bgHeader: background,
    bgHeaderHasFocus: muted,
    bgHeaderHovered: muted,
    bgBubble: muted,
    bgBubbleSelected: background,
    bgSearchResult: accent,
    borderColor: border,
    horizontalBorderColor: border,
    drilldownBorder: border,
    linkColor: SELECTION,
    fontFamily: getComputedStyle(document.body).fontFamily,
    baseFontStyle: "13px",
    headerFontStyle: "500 12px",
    editorFontSize: "13px",
  };
}

/** The grid theme and extra colors, re-read when the app switches between light and dark. */
export function useGridTheme(): { theme: Partial<Theme>; colors: GridColors } {
  const [value, setValue] = useState(() => ({ theme: readTheme(), colors: readColors() }));
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setValue({ theme: readTheme(), colors: readColors() }),
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return value;
}
