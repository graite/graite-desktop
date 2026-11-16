/** A page's `icon` field: an emoji, or a Lucide icon written `lucide:<name>` with an optional
 * colour, `lucide:<name>:<color>` (docs/vault-format.md). */

/** The colours an icon can take; the same names and values as property tags. */
export const iconColors = [
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;
export type IconColor = (typeof iconColors)[number];

export type ParsedIcon =
  { kind: "emoji"; value: string } | { kind: "lucide"; name: string; color: IconColor };

const PREFIX = "lucide:";

export function parseIcon(icon: string | null | undefined): ParsedIcon | null {
  if (!icon) return null;
  if (!icon.startsWith(PREFIX)) return { kind: "emoji", value: icon };
  const [name = "", color = ""] = icon.slice(PREFIX.length).split(":");
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const known = (iconColors as readonly string[]).includes(color);
  return { kind: "lucide", name, color: known ? (color as IconColor) : "default" };
}

export function formatIcon(name: string, color: IconColor = "default"): string {
  return color === "default" ? `${PREFIX}${name}` : `${PREFIX}${name}:${color}`;
}

/** `file-text` -> `FileText`, the key of the component in lucide-react's `icons`. */
export function lucideComponentName(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
