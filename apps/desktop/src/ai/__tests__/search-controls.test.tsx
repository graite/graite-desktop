import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const tree = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  pages: { tree },
}));

import { Composer } from "../Composer";
import { ScopeMenu } from "../ScopeMenu";
import { stepCost } from "../TaskProgress";
import { chatDepth, setChatDepth } from "../depth";
import { mentionAt, mentionMatches, mentionedPaths, setMentionPages } from "../mentions";

const flat = (path: string, title: string) => ({
  path,
  title,
  icon: null,
  hasContent: true,
  breadcrumb: path.includes("/") ? path.split("/").slice(0, -1).join(" / ") : "",
});
const PAGES = [
  flat("Product/Offline mode", "Offline mode"),
  flat("Product/Offline", "Offline"),
  flat("Customers/Fernhill", "Fernhill"),
];
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

beforeEach(() => {
  vi.clearAllMocks();
  setChatDepth("quick");
  setMentionPages(PAGES);
  tree.mockResolvedValue([]);
});
afterEach(cleanup);

it("finds the mention being typed and the pages it names", () => {
  expect(mentionAt("Compare @Off", 12)).toEqual({ start: 8, query: "Off" });
  expect(mentionAt("mail me at a@b.c", 16)).toBeNull(); // an address, not a mention
  expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionMatches("off", PAGES).map((p) => p.title)).toEqual(["Offline", "Offline mode"]);
  // The longest title wins, so "Offline mode" is not read as "Offline" plus a word.
  expect(mentionedPaths("What changed in @Offline mode since @fernhill?", PAGES)).toEqual([
    "Product/Offline mode",
    "Customers/Fernhill",
  ]);
  expect(mentionedPaths("See @Offline.", PAGES)).toEqual(["Product/Offline"]);
  expect(mentionedPaths("@Offlinemodes and a@Fernhill", PAGES)).toEqual([]);
});

it("offers pages after @ and puts the picked title in the message", async () => {
  const onChange = vi.fn();
  const onSend = vi.fn();
  render(<Composer {...base} value="Ask @Fer" onChange={onChange} onSend={onSend} />);
  const box = screen.getByLabelText("Ask about your pages…") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Ask @Fern" } });
  const option = await screen.findByRole("option", { name: /Fernhill/ });
  expect(option.textContent).toContain("Customers");
  // Enter picks the page; it does not send the half-typed message.
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  expect(onChange).toHaveBeenLastCalledWith("Ask @Fernhill ");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
});

it("switches between a quick answer and deep research, and remembers it", () => {
  render(<Composer {...base} />);
  const toggle = screen.getByRole("button", { name: "Deep research" });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(toggle.textContent).toContain("Quick");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(toggle.textContent).toContain("Deep");
  expect(chatDepth()).toBe("deep");
  cleanup();
  // Draft and Act always work with tools: no toggle there.
  render(<Composer {...base} mode="act" />);
  expect(screen.queryByRole("button", { name: "Deep research" })).toBeNull();
});

it("explains search from the message box", async () => {
  render(<Composer {...base} />);
  fireEvent.click(screen.getByRole("button", { name: "How search works" }));
  expect(await screen.findByText(/It never reads them all/)).toBeTruthy();
  expect(screen.getByText("Quick or Deep")).toBeTruthy();
});

it("shows the usual scopes as chips in a page's chat", () => {
  const onChange = vi.fn();
  render(
    <ScopeMenu
      scope={{ kind: "vault", roots: [], excluded: [] }}
      tree={[]}
      page="Projects/Atlas"
      chips
      onChange={onChange}
      onChoose={() => {}}
    />,
  );
  const pressed = (name: string) =>
    screen.getByRole("button", { name }).getAttribute("aria-pressed");
  expect(pressed("Everywhere")).toBe("true");
  expect(pressed("This page")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "This page" }));
  expect(onChange).toHaveBeenCalledWith({ kind: "page", roots: ["Projects/Atlas"], excluded: [] });
  fireEvent.click(screen.getByRole("button", { name: "+ subpages" }));
  expect(onChange).toHaveBeenLastCalledWith({
    kind: "folder",
    roots: ["Projects/Atlas"],
    excluded: [],
  });
});

it("says what a step cost", () => {
  const step = { id: "1", round: 1, kind: "tool", name: "search_vault", status: "succeeded" };
  expect(stepCost({ ...step, text: "", hits: 6, ms: 120 })).toBe("6 hits · 120 ms");
  expect(stepCost({ ...step, text: "", hits: 1, ms: 8 })).toBe("1 hit · 8 ms");
  expect(stepCost({ ...step, text: "" })).toBe("");
});
