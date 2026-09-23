import type { ReactNode } from "react";

/** One page setting: either inherited from an ancestor or set on this page. */
export function SegmentedSetting({
  label,
  hint,
  inheritedLabel,
  inheritedFrom,
  own,
  onOwnChange,
  children,
}: {
  label: string;
  hint?: string;
  /** Human label of the value that applies when the page sets nothing. */
  inheritedLabel: string;
  /** Where the inherited value comes from ("Projects/AGENTS.md", "vault settings", "default"). */
  inheritedFrom: string;
  own: boolean;
  onOwnChange: (own: boolean) => void;
  /** The controls shown when the page sets its own value. */
  children: ReactNode;
}) {
  return (
    <fieldset className="ai-setting" data-own={own || undefined}>
      <legend>
        {label}
        {hint && <span className="ai-setting-hint">{hint}</span>}
      </legend>
      <div className="ai-segments" role="radiogroup" aria-label={`${label} source`}>
        <button
          type="button"
          role="radio"
          aria-checked={!own}
          data-active={!own || undefined}
          onClick={() => onOwnChange(false)}
        >
          <strong>Inherited · {inheritedLabel}</strong>
          <small>from {inheritedFrom}</small>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={own}
          data-active={own || undefined}
          onClick={() => onOwnChange(true)}
        >
          <strong>Set on this page</strong>
          <small>applies here and to every subpage</small>
        </button>
      </div>
      {own && <div className="ai-setting-own">{children}</div>}
    </fieldset>
  );
}
