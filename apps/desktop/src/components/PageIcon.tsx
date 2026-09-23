import { File, FileText } from "lucide-react";

/**
 * The one page icon: the page's emoji when it has one, otherwise a gray page glyph that
 * shows text lines when the page has content and is blank when it is empty.
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
  if (icon) return <span className={emojiClassName}>{icon}</span>;
  const Glyph = hasContent ? FileText : File;
  return <Glyph className={`shrink-0 text-muted-foreground ${className}`} aria-hidden />;
}

export const hasBodyContent = (body: string | undefined | null) =>
  !!body && body.replace(/<!-- graite:empty -->/g, "").trim().length > 0;
