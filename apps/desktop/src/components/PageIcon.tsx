import { File, FileText, icons, type LucideIcon } from "lucide-react";
import { lucideComponentName, parseIcon } from "@/lib/pageIcon";
import "./page-icon.css";

/**
 * The one page icon: the page's emoji or its chosen icon when it has one, otherwise a gray
 * page glyph that shows text lines when the page has content and is blank when it is empty.
 */
export function PageIcon({
  icon,
  hasContent,
  className = "size-4",
  emojiClassName = "text-sm leading-none",
}: {
  icon: string | null | undefined;
  hasContent: boolean;
  className?: string;
  emojiClassName?: string;
}) {
  const parsed = parseIcon(icon);
  if (parsed?.kind === "emoji") return <span className={emojiClassName}>{parsed.value}</span>;
  if (parsed?.kind === "lucide") {
    const Chosen = (icons as Record<string, LucideIcon>)[lucideComponentName(parsed.name)];
    if (Chosen)
      return (
        <Chosen
          className={`page-icon shrink-0 ${className}`}
          data-color={parsed.color}
          aria-hidden
        />
      );
  }
  // No icon, or one this version does not know: the page glyph.
  const Glyph = hasContent ? FileText : File;
  return <Glyph className={`shrink-0 text-muted-foreground ${className}`} aria-hidden />;
}

export const hasBodyContent = (body: string | undefined | null) =>
  !!body && body.replace(/<!-- graite:empty -->/g, "").trim().length > 0;
