import { useEffect, useRef, useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, Check, GripVertical } from "lucide-react";
import { moveName } from "./settings";

/** Shared ordering and visibility controls, with keyboard-accessible alternatives to dragging. */
export function ArrangeItems({
  names,
  label,
  shown,
  onToggle,
  onOrder,
}: {
  names: string[];
  label: (name: string) => React.ReactNode;
  shown: (name: string) => boolean;
  onToggle: (name: string) => void;
  onOrder: (names: string[]) => void;
}) {
  const source = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<{ name: string; position: "before" | "after" } | null>(null);
  const clear = () => {
    source.current = null;
    setDragging(null);
    setTarget(null);
  };
  useEffect(() => {
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);
  const positionAt = (event: DragEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? ("before" as const) : ("after" as const);
  };
  const accepts = (event: DragEvent) =>
    source.current !== null && event.dataTransfer.types.includes("application/graite-arrange");
  return (
    <div className="view-arrange-list">
      {names.map((name, index) => (
        <div
          key={name}
          className="view-arrange-row"
          data-dragging={dragging === name || undefined}
          data-reorder-position={target?.name === name ? target.position : undefined}
          onDragOver={(e) => {
            if (!accepts(e)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            setTarget(source.current === name ? null : { name, position: positionAt(e) });
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(null);
          }}
          onDrop={(e) => {
            if (!accepts(e)) return;
            e.preventDefault();
            e.stopPropagation();
            const from = source.current!;
            const position = positionAt(e);
            clear();
            if (from === name) return;
            const next = names.filter((n) => n !== from);
            next.splice(next.indexOf(name) + (position === "after" ? 1 : 0), 0, from);
            onOrder(next);
          }}
        >
          <span
            draggable
            className="view-grip"
            title="Drag to reorder"
            onDragEnd={clear}
            onDragStart={(e) => {
              source.current = name;
              setDragging(name);
              e.dataTransfer.setData("application/graite-arrange", name);
              e.dataTransfer.effectAllowed = "move";
              e.stopPropagation();
            }}
          >
            <GripVertical size={14} />
          </span>
          <button
            className="view-visibility-toggle"
            role="checkbox"
            aria-checked={shown(name)}
            aria-label={`Show ${name || "ungrouped"}`}
            onClick={() => onToggle(name)}
          >
            <span className="view-check" aria-hidden="true">
              {shown(name) && <Check size={11} strokeWidth={3} />}
            </span>
            <span className="view-arrange-label">{label(name)}</span>
          </button>
          <button
            className="view-order-button"
            disabled={index === 0}
            aria-label={`Move ${name || "ungrouped"} earlier`}
            onClick={() => onOrder(moveName(names, name, names[index - 1]))}
          >
            <ArrowUp size={12} />
          </button>
          <button
            className="view-order-button"
            disabled={index === names.length - 1}
            aria-label={`Move ${name || "ungrouped"} later`}
            onClick={() => onOrder(moveName(names, name, names[index + 1]))}
          >
            <ArrowDown size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
