import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentInstructionsEditor } from "../AgentInstructionsEditor";

const rect = () => ({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  toJSON() {
    return this;
  },
});
Element.prototype.getBoundingClientRect = rect as never;
Element.prototype.getClientRects = (() => [] as unknown as DOMRectList) as never;
Range.prototype.getBoundingClientRect = rect as never;
Range.prototype.getClientRects = (() => [] as unknown as DOMRectList) as never;
afterEach(cleanup);

it("opens Markdown without saving and navigates an existing knowledge link", async () => {
  const change = vi.fn();
  const navigate = vi.fn();
  render(
    <AgentInstructionsEditor
      value={"## Overview\n\n[[Rules|Routing rules]]\n\n## Workflow\n\n1. Review.\n"}
      onChange={change}
      onNavigate={navigate}
      tree={[
        {
          path: "Rules",
          title: "Routing rules",
          id: "rules",
          icon: null,
          has_content: true,
          children: [],
        },
      ]}
    />,
  );
  expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
  expect(change).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Link knowledge page" })).toBeNull();
  fireEvent.click(await screen.findByText("Routing rules"));
  expect(navigate).toHaveBeenCalledWith("Rules");
});

it("can open an existing agent with empty instructions", () => {
  render(<AgentInstructionsEditor value="" onChange={vi.fn()} onNavigate={vi.fn()} tree={[]} />);
  expect(screen.getByText("Use / for blocks and page links")).toBeTruthy();
});
