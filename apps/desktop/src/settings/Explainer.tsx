import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** The top of every settings section: what it is in one line, then why you would want it,
 * what it takes and what leaves this computer. The same three questions everywhere, each
 * answered in a sentence, so sections compare at a glance. */
export function Explainer({
  icon: Icon,
  title,
  lede,
  why,
  need,
  leaves,
}: {
  icon: LucideIcon;
  title: string;
  /** What it is, in one line. */
  lede: string;
  why?: ReactNode;
  need?: ReactNode;
  leaves?: ReactNode;
}) {
  const facts: [string, ReactNode][] = [
    ["Why", why],
    ["You need", need],
    ["Leaves this computer", leaves],
  ];
  const shown = facts.filter(([, text]) => text);
  return (
    <header className="settings-explainer">
      <div className="settings-explainer-title">
        <span className="settings-explainer-icon">
          <Icon size={18} />
        </span>
        <div>
          <h1>{title}</h1>
          <p>{lede}</p>
        </div>
      </div>
      {shown.length > 0 && (
        <dl>
          {shown.map(([label, text]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      )}
    </header>
  );
}
