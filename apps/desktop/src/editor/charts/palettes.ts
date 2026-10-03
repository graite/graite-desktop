/** Chart color themes (D73, D74): a `palette` key on the fence, `mono` when absent. Each color has a
 *  light-mode and a dark-mode shade, so charts stay crisp on both. The same lists are in
 *  apps/daemon/graite/dashboards/static/bridge.js for dashboards. */
interface Palette {
  label: string;
  light: readonly string[];
  dark: readonly string[];
}

export const PALETTES = {
  // A cool blue-led set with enough warmth for categorical charts. This is deliberately
  // quieter than the old violet-first palette: it sits next to page content instead of
  // looking like a separate analytics product.
  vivid: {
    label: "Studio",
    light: ["#3978f6", "#12a594", "#7c5ce7", "#e59428", "#dc5b73", "#1689ad", "#6f7d91", "#55a45c"],
    dark: ["#6ea0ff", "#42c7b3", "#a78bfa", "#f2b950", "#f08093", "#49b7d7", "#9aa7b8", "#79c57f"],
  },
  ocean: {
    label: "Ocean",
    light: ["#1976a8", "#179bb1", "#22a696", "#396ecb", "#5a65c7", "#2b8494", "#67a7c5", "#466c80"],
    dark: ["#55b6e7", "#4fc9dc", "#50cfbd", "#769cff", "#9999ff", "#70bdca", "#93cce5", "#7fa7ba"],
  },
  // Warm-to-cool contrast for comparison charts.
  sunset: {
    label: "Sunset",
    light: ["#e26345", "#eb913d", "#e3b446", "#bf6682", "#8a67bf", "#4f82c4", "#45a1a7", "#718096"],
    dark: ["#f58a6e", "#f6b15f", "#efd16e", "#df8ba2", "#b293df", "#7eace8", "#72c6c9", "#9ca8b8"],
  },
  // Rose, amber, lime, emerald: for good-to-bad scales and statuses.
  forest: {
    label: "Botanical",
    light: ["#31866f", "#66a05c", "#94ad55", "#c2a34a", "#3d8391", "#667c52", "#9a7651", "#65758a"],
    dark: ["#61b99e", "#8ac67e", "#b5ce76", "#dec56c", "#68afbd", "#93a978", "#c59d75", "#91a0b3"],
  },
  candy: {
    label: "Playful",
    light: ["#5677e8", "#9a62db", "#e05f9d", "#ef7a58", "#dfa92f", "#54a97d", "#31a4b7", "#77859a"],
    dark: ["#809bff", "#bd8aef", "#f18bbb", "#f59b7f", "#edc45f", "#7ac89f", "#64c4d1", "#a0abbb"],
  },
  // Grayscale: black to gray in light mode, white to gray in dark mode.
  mono: {
    label: "Grayscale",
    light: ["#0a0a0a", "#262626", "#3d3d3d", "#545454", "#6b6b6b", "#7d7d7d", "#949494", "#ababab"],
    dark: ["#ffffff", "#dedede", "#bebebe", "#a0a0a0", "#868686", "#6f6f6f", "#5a5a5a", "#484848"],
  },
} as const satisfies Record<string, Palette>;

export type PaletteName = keyof typeof PALETTES;

export function isDark(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

/** The palette's colors for the current (or given) mode. */
export function paletteColors(name: string | null | undefined, dark = isDark()): readonly string[] {
  const palette = PALETTES[(name || "mono") as PaletteName] ?? PALETTES.mono;
  return dark ? palette.dark : palette.light;
}

/** A hex color at `alpha`. */
export function fade(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
