import { CircleAlert } from "lucide-react";

/** What went wrong with a download or an install, as one line inside its card. The same
 * message is also shown once as a popup when it happens (`useEngine`, `useCatalog`). */
export function FailureLine({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="ai-failure">
      <CircleAlert size={14} aria-hidden />
      <span>{children}</span>
    </p>
  );
}
