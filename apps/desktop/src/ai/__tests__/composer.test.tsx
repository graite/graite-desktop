import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "../Composer";
import { growTo } from "@/chat/useAutoGrow";

afterEach(cleanup);

const base = {
  value: "",
  onChange: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  busy: false,
  mode: "ask" as const,
  onModeChange: vi.fn(),
  attachments: [],
  onAttach: vi.fn(),
  onRemoveAttachment: vi.fn(),
};

it("grows with the text up to eight lines, then scrolls", () => {
  const line = 20;
  const padding = 24;
  expect(growTo(line + padding, line, 8, padding)).toEqual({ height: 44, overflow: "hidden" });
  expect(growTo(line * 8 + padding, line, 8, padding)).toEqual({ height: 184, overflow: "hidden" });
  expect(growTo(line * 12 + padding, line, 8, padding)).toEqual({ height: 184, overflow: "auto" });
});

it("sends on Enter and keeps Shift+Enter for a new line", () => {
  const onSend = vi.fn();
  render(<Composer {...base} value="Hello" onSend={onSend} />);
  const box = screen.getByLabelText("Ask about your pages…");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
  expect(onSend).toHaveBeenCalledTimes(1);
});

it("offers a mode dropdown with Ask, Draft and Act", async () => {
  const onModeChange = vi.fn();
  render(<Composer {...base} onModeChange={onModeChange} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Answer mode" }), { key: "ArrowDown" });
  const act = await screen.findByRole("menuitem", { name: /Act/ });
  expect(act.getAttribute("data-disabled")).toBeNull();
  expect(act.textContent).toContain("Propose changes");
  fireEvent.click(act);
  await waitFor(() => expect(onModeChange).toHaveBeenCalledWith("act"));
});

it("opens files and nested page selection from the plus menu", async () => {
  const onPages = vi.fn();
  render(<Composer {...base} onPages={onPages} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Add context" }), { key: "ArrowDown" });
  expect(await screen.findByRole("menuitem", { name: "Files" })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Pages" }));
  expect(onPages).toHaveBeenCalled();
});

it("shows attachment chips with their reading status and stops a running answer", () => {
  const onStop = vi.fn();
  const onRemove = vi.fn();
  render(
    <Composer
      {...base}
      busy
      onStop={onStop}
      onRemoveAttachment={onRemove}
      attachments={[
        {
          id: "a",
          conversation_id: "c",
          name: "brief.pdf",
          kind: "pdf",
          mime: "application/pdf",
          size: 10,
          text_status: "pending",
          created_at: "now",
        },
        {
          id: "b",
          conversation_id: "c",
          name: "scan.png",
          kind: "image",
          mime: "image/png",
          size: 10,
          text_status: "failed",
          error: "no text",
          created_at: "now",
        },
      ]}
    />,
  );
  expect(screen.getByText("brief.pdf")).toBeTruthy();
  expect(screen.getByLabelText("Reading")).toBeTruthy();
  expect(screen.getByLabelText("Could not read")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove scan.png" }));
  expect(onRemove).toHaveBeenCalledWith("b");
  fireEvent.click(screen.getByRole("button", { name: "Stop answer" }));
  expect(onStop).toHaveBeenCalled();
});

it("accepts dropped files", () => {
  const onAttach = vi.fn();
  const { container } = render(<Composer {...base} onAttach={onAttach} />);
  const form = container.querySelector("form")!;
  const file = new File(["x"], "notes.md", { type: "text/markdown" });
  fireEvent.drop(form, { dataTransfer: { files: [file], types: ["Files"] } });
  expect(onAttach).toHaveBeenCalled();
});

it("keeps the draft when Enter is pressed while an answer is streaming", () => {
  const onSend = vi.fn();
  const onChange = vi.fn();
  render(<Composer {...base} busy value="Next question" onSend={onSend} onChange={onChange} />);
  fireEvent.keyDown(screen.getByLabelText("Ask about your pages…"), { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
});

it("ignores Enter on an empty box", () => {
  const onSend = vi.fn();
  render(<Composer {...base} value="   " onSend={onSend} />);
  fireEvent.keyDown(screen.getByLabelText("Ask about your pages…"), { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
});
