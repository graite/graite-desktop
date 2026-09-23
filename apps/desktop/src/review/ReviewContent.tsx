import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/** Clips the preview, never the proposal payload. Measure wrapping at the current width. */
export function ReviewContent({
  children,
  editing = false,
  pagePreview = false,
}: {
  children: ReactNode;
  editing?: boolean;
  pagePreview?: boolean;
}) {
  const id = useId();
  const limit = pagePreview ? 320 : 176;
  const body = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => setLong(element.scrollHeight > limit + 1);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children, limit]);
  const shown = expanded || editing;
  return (
    <div
      className="review-preview"
      data-page-preview={pagePreview || undefined}
      data-truncated={(long && !shown) || undefined}
    >
      <div id={id} className="review-preview-clip">
        <div ref={body} className="review-preview-body">
          {children}
        </div>
      </div>
      {long && !editing && (
        <button
          type="button"
          className="review-read-more"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {expanded ? "Read less" : "Read more"}
        </button>
      )}
    </div>
  );
}
