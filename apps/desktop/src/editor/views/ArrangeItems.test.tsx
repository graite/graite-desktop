import { afterEach, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render } from "@testing-library/react";
import { ArrangeItems } from "./ArrangeItems";
afterEach(cleanup);
it.each([
  { y: 105, position: "before", result: ["B", "A", "C"] },
  { y: 135, position: "after", result: ["B", "C", "A"] },
])("previews $position the target and drops at that exact position", ({ y, position, result }) => {
  const onOrder = vi.fn();
  const { container } = render(
    <ArrangeItems
      names={["A", "B", "C"]}
      label={(n) => n}
      shown={() => true}
      onToggle={vi.fn()}
      onOrder={onOrder}
    />,
  );
  const rows = container.querySelectorAll<HTMLElement>(".view-arrange-row");
  const target = rows[2];
  target.getBoundingClientRect = () => ({ top: 100, height: 40 }) as DOMRect;
  const dataTransfer = {
    types: ["application/graite-arrange"],
    setData: vi.fn(),
    dropEffect: "",
    effectAllowed: "",
  };
  fireEvent.dragStart(rows[0].querySelector("[draggable]")!, { dataTransfer });
  const at = (type: "dragOver" | "drop") => {
    const event = createEvent[type](target, { dataTransfer });
    Object.defineProperty(event, "clientY", { value: y });
    return event;
  };
  fireEvent(target, at("dragOver"));
  expect(target.getAttribute("data-reorder-position")).toBe(position);
  expect(onOrder).not.toHaveBeenCalled();
  fireEvent(target, at("drop"));
  expect(onOrder).toHaveBeenCalledWith(result);
  expect(target.hasAttribute("data-reorder-position")).toBe(false);
  expect(rows[0].hasAttribute("data-dragging")).toBe(false);
});
it("clears the preview when dragging is cancelled", () => {
  const onOrder = vi.fn();
  const { container } = render(
    <ArrangeItems
      names={["A", "B"]}
      label={(n) => n}
      shown={() => true}
      onToggle={vi.fn()}
      onOrder={onOrder}
    />,
  );
  const rows = container.querySelectorAll(".view-arrange-row");
  const dataTransfer = { types: ["application/graite-arrange"], setData: vi.fn() };
  fireEvent.dragStart(rows[0].querySelector("[draggable]")!, { dataTransfer });
  fireEvent.dragOver(rows[1], { dataTransfer });
  expect(rows[1].hasAttribute("data-reorder-position")).toBe(true);
  fireEvent.dragEnd(window);
  expect(rows[1].hasAttribute("data-reorder-position")).toBe(false);
  expect(onOrder).not.toHaveBeenCalled();
});
