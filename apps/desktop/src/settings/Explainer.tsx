import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** The top of every settings section: one card that says what the page is for and how to
 * start, in a line or two, with the page's icon on the right. Everything longer belongs
 * further down. */
export function Explainer({
  icon: Icon,
  title,
  text,
}: {
  icon: LucideIcon;
  title: string;
  /** What it is for and how to start: one or two short sentences. */
  text: ReactNode;
}) {
  return (
    <header className="settings-explainer">
      <span className="settings-explainer-icon" aria-hidden>
        <Icon size={20} strokeWidth={1.6} />
      </span>
      <div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
    </header>
  );
}
