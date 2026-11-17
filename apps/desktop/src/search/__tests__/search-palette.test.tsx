import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ request }));

import { SearchPalette } from "../SearchPalette";
import { highlight, queryTerms } from "@/lib/search";

const node = (path: string, title: string, children: unknown[] = []) => ({
  id: path,
  path,
  title,
  icon: null,
  has_content: true,
  children,
});
const TREE = [
  node("Invoices", "Invoices", [node("Invoices/Q3 invoice Halden", "Q3 invoice Halden")]),
  node("Pricing", "Pricing"),
] as never;

const HIT = {
  path: "Invoices/Q3 invoice Halden",
  id: "p1",
  title: "Q3 invoice Halden",
  icon: null,
  heading_path: ["Status"],
  snippet: "The invoice to Halden Freight for 18,400 euros is overdue.",
  score: 0.05,
  matches: 2,
  via: ["text", "title"],
  start_line: 3,
};

function answer(results: unknown[], extra: Record<string, unknown> = {}) {
  request.mockImplementation(async (url: string) => {
    if (url.endsWith("/warm")) return { semantic: false };
    const q = new URL(url, "http://x").searchParams.get("q");
    return { query: q, results, semantic: false, took_ms: 12.4, ...extra };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  answer([HIT]);
});
afterEach(cleanup);

it("splits a query into words and marks them in a result", () => {
  expect(queryTerms("Invoice Q3, halden!")).toEqual(["invoice", "q3", "halden"]);
  expect(highlight("The invoices of Halden.", ["invoice", "halden"])).toEqual([
    { text: "The ", hit: false },
    { text: "invoices", hit: true },
    { text: " of ", hit: false },
    { text: "Halden", hit: true },
    { text: ".", hit: false },
  ]);
  // Inside a word is not a match: "art" does not light up "start".
  expect(highlight("start", ["art"])).toEqual([{ text: "start", hit: false }]);
});

it("shows title matches at once, then the pages whose text matches", async () => {
  const open = vi.fn();
  const close = vi.fn();
  render(<SearchPalette open tree={TREE} onOpenPage={open} onClose={close} />);
  expect(request).toHaveBeenCalledWith("/api/v1/search/warm", { method: "POST" });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "invoice" } });
  // Before the daemon has answered: the titles already in memory.
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    expect.stringContaining("Invoices"),
    expect.stringContaining("Q3 invoice Halden"),
  ]);
  expect(screen.getByRole("status").textContent).toContain("Searching");
  // Then the index: heading path, snippet, timing, and how it searched.
  expect(await screen.findByText(/› Status/)).toBeTruthy();
  expect(screen.getByText(/18,400 euros is overdue/)).toBeTruthy();
  expect(screen.getByText(/2 passages/)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("1 page · 12 ms · words");
  expect(document.querySelectorAll("mark").length).toBeGreaterThan(0);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(open).toHaveBeenCalledWith("Invoices/Q3 invoice Halden");
  expect(close).toHaveBeenCalled();
});

it("moves with the arrow keys and can hand the words to AI instead", async () => {
  const ask = vi.fn();
  const open = vi.fn();
  answer([HIT, { ...HIT, path: "Pricing", title: "Pricing", heading_path: [], matches: 1 }], {
    semantic: true,
  });
  render(<SearchPalette open tree={TREE} onOpenPage={open} onClose={() => {}} onAsk={ask} />);
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "what is overdue" } });
  await screen.findByText(/words and meaning/);
  const options = () => screen.getAllByRole("option");
  expect(options()).toHaveLength(3);
  expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" }); // stops at the last row
  expect(options()[2]!.getAttribute("aria-selected")).toBe("true");
  expect(options()[2]!.textContent).toContain("Ask AI: “what is overdue”");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(ask).toHaveBeenCalledWith("what is overdue");
  expect(open).not.toHaveBeenCalled();
});

it("keeps the newest answer when an older one arrives late, and says when nothing matches", async () => {
  let release: (value: unknown) => void = () => {};
  request.mockImplementation((url: string) => {
    if (url.endsWith("/warm")) return Promise.resolve({ semantic: false });
    const q = new URL(url, "http://x").searchParams.get("q");
    if (q === "inv") return new Promise((resolve) => (release = resolve));
    return Promise.resolve({ query: q, results: [], semantic: false, took_ms: 3 });
  });
  render(<SearchPalette open tree={[] as never} onOpenPage={() => {}} onClose={() => {}} />);
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "inv" } });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  fireEvent.change(input, { target: { value: "zzzz" } });
  expect(await screen.findByText(/No page has these words/)).toBeTruthy();
  release({ query: "inv", results: [HIT], semantic: false, took_ms: 900 });
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText("Q3 invoice Halden")).toBeNull();
});

it("falls back to titles and says so when the daemon does not answer", async () => {
  request.mockImplementation(async (url: string) => {
    if (url.endsWith("/warm")) return { semantic: false };
    throw new Error("Graite is not running.");
  });
  render(<SearchPalette open tree={TREE} onOpenPage={() => {}} onClose={() => {}} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "pric" } });
  expect(await screen.findByText(/Search is not answering: Graite is not running/)).toBeTruthy();
  expect(screen.getByRole("option").textContent).toContain("Pricing");
});
