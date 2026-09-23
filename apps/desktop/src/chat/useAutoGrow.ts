import { useLayoutEffect, type RefObject } from "react";

/** Height for a textarea that grows with its content up to `maxRows`, then scrolls. */
export function growTo(scrollHeight: number, lineHeight: number, maxRows: number, padding: number) {
  const max = lineHeight * maxRows + padding;
  return {
    height: Math.min(scrollHeight, max),
    overflow: scrollHeight > max ? "auto" : "hidden",
  } as const;
}

export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxRows = 8,
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    el.style.height = "auto";
    const size = growTo(el.scrollHeight || lineHeight + padding, lineHeight, maxRows, padding);
    el.style.height = `${size.height}px`;
    el.style.overflowY = size.overflow;
  }, [ref, value, maxRows]);
}
