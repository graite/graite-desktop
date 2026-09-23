import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const aiMock = vi.hoisted(() => ({
  status: vi.fn(),
  indexStatus: vi.fn(),
  allConversations: vi.fn(),
  conversation: vi.fn(),
  createConversation: vi.fn(),
  updateConversation: vi.fn(),
  deleteConversation: vi.fn(),
  deleteAttachment: vi.fn(),
  uploadAttachment: vi.fn(),
  cancel: vi.fn(),
}));
const sendMessage = vi.hoisted(() => vi.fn());
const apiMock = vi.hoisted(() => ({
  onDaemonEvent: vi.fn(() => () => {}),
  pages: { create: vi.fn(), put: vi.fn() },
  request: vi.fn(),
}));

vi.mock("@/lib/ai", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai");
  return { ...actual, ai: aiMock, sendMessage };
});
vi.mock("@/lib/api", () => apiMock);

import { AIPage } from "../AIPage";
import type { TreeNode } from "@/lib/api";

const tree: TreeNode[] = [
  { path: "Pricing", id: "p", title: "Pricing", icon: null, has_content: true, children: [] },
];
const SOURCE = {
  n: 1,
  kind: "page",
  page_path: "Pricing",
  page_id: "p",
  title: "Pricing",
  heading_path: ["Decision"],
  snippet: "20 euro per seat",
  hash: "h",
  chunk_ids: [1],
  start_line: 1,
  end_line: 2,
};
const CONTEXT = { ...SOURCE, added_turn: 1, last_cited_turn: 1, stale: false };
const answer = {
  role: "assistant",
  content: "Twenty euro per seat [1].",
  interrupted: false,
  context: true,
  thinking: "The price is in the decision section.",
  sources: [SOURCE],
  cited: [1],
  limits: ["Searched 1 page in your vault (keywords)."],
  run_id: "r",
};

const PROPOSAL = {
  id: "p_1",
  run_id: "r",
  conversation_id: "c1",
  page_path: "Pricing",
  page_id: "p",
  page_title: "Pricing",
  kind: "append",
  base_hash: "h",
  old_text: null,
  new_text: "New line.",
  new_path: null,
  patch: "--- a/Pricing\n+++ b/Pricing\n@@ -1 +1,2 @@\n Decision\n+New line.\n",
  summary: "Add a line",
  status: "pending",
  policy: "propose",
  decided_by: null,
  reason: null,
  created_at: "now",
  decided_at: null,
  applied_hash: null,
  snapshot: null,
  trash_id: null,
  edited: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.request.mockImplementation(async (url: string) =>
    url.includes("/ai/proposals") ? [] : [],
  );
  aiMock.status.mockResolvedValue({
    config: { provider: "local", model_path: "/m.gguf", binary_path: "/llama" },
    hardware: { binary_path: "" },
    key_saved: false,
  });
  aiMock.indexStatus.mockResolvedValue({
    pending_chunks: 0,
    chunks: 4,
    pages: 1,
    embedding_model: "e",
  });
  aiMock.allConversations.mockResolvedValue([]);
  aiMock.cancel.mockResolvedValue({ cancelled: true });
  aiMock.deleteAttachment.mockResolvedValue({ ok: true });
  aiMock.deleteConversation.mockResolvedValue({ ok: true });
  aiMock.createConversation.mockResolvedValue({
    id: "c1",
    title: "New conversation",
    messages: [],
    scope: { kind: "vault", roots: [], excluded: [] },
    mode: "ask",
    page_id: null,
    updated_at: "now",
  });
  aiMock.conversation.mockResolvedValue({
    id: "c1",
    title: "Price?",
    messages: [{ role: "user", content: "Price?", interrupted: false }, answer],
    scope: { kind: "vault", roots: [], excluded: [] },
    mode: "ask",
    page_id: null,
    updated_at: "now",
    context: [CONTEXT],
  });
  sendMessage.mockImplementation(async (_id, _body, _signal, onEvent) => {
    onEvent({ type: "sources", sources: [SOURCE], new: [1] });
    onEvent({ type: "thinking", text: "The price is in the decision section." });
    onEvent({ type: "token", text: "Twenty euro per seat [1]." });
    onEvent({
      type: "limits",
      items: ["Searched 1 page in your vault (keywords)."],
      excluded_local_only: [],
      pending_chunks: 0,
    });
    onEvent({
      type: "answer",
      text: "Twenty euro per seat [1].",
      cited: [1],
      sources: [SOURCE],
      new_sources: [SOURCE],
      thinking: "The price is in the decision section.",
      limits: [],
      run_id: "r",
    });
    onEvent({ type: "done" });
  });
});
afterEach(cleanup);

function renderPage(overrides: Partial<Parameters<typeof AIPage>[0]> = {}) {
  const props = {
    tree,
    onNavigate: vi.fn(),
    onSettings: vi.fn(),
    onTreeChanged: vi.fn(),
    settingsVersion: 0,
    ...overrides,
  };
  render(
    <AIPage
      assistantState={{ info: null, error: "", setInfo: () => {}, refresh: async () => {} }}
      {...props}
    />,
  );
  return props;
}

it("answers from the whole vault and shows its sources and limits", async () => {
  const props = renderPage();
  await screen.findByText("How can I help you today?");
  expect(screen.getByRole("button", { name: /All pages/ })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Ask about your pages…"), { target: { value: "Price?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("1 new source");
  expect(sendMessage.mock.calls[0][1]).toMatchObject({ message: "Price?", mode: "ask" });
  await screen.findByText(/Searched 1 page in your vault/);
  fireEvent.click((await screen.findAllByRole("button", { name: /Open Pricing/ }))[0]);
  expect(props.onNavigate).toHaveBeenCalledWith("Pricing");
});

it("shows the context once at the top and only new sources under later answers", async () => {
  const followUp = {
    ...answer,
    content: "Because of the workshop [1].",
    sources: [],
    thinking: "",
  };
  aiMock.allConversations.mockResolvedValue([
    {
      ...(await aiMock.conversation()),
      messages: [
        { role: "user", content: "Price?" },
        answer,
        { role: "user", content: "Why?" },
        followUp,
      ],
    },
  ]);
  renderPage();
  await screen.findByText("How can I help you today?");
  fireEvent.click(await screen.findByRole("button", { name: "Price?" }));
  const context = await screen.findByLabelText("Conversation context");
  expect(context.querySelector("summary")?.textContent).toContain("Using 1 page");
  expect(document.querySelectorAll("#source-1")).toHaveLength(1);
  expect(screen.getAllByText("1 new source")).toHaveLength(1); // the first answer only
  expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
  const bubbles = document.querySelectorAll(".ai-message.user");
  expect(bubbles).toHaveLength(2);
  expect(bubbles[0].textContent).toBe("Price?");
});

it("keeps the model's thinking above the answer, collapsed, before and after the reload", async () => {
  renderPage();
  await screen.findByText("How can I help you today?");
  fireEvent.change(screen.getByLabelText("Ask about your pages…"), { target: { value: "Price?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  const thinking = await screen.findAllByText("Thinking");
  const block = thinking[0].closest("details") as HTMLDetailsElement;
  expect(block.open).toBe(false);
  expect(block.textContent).toContain("The price is in the decision section.");
  const message = block.closest(".ai-message") as HTMLElement;
  expect(message.querySelector("details.ai-thinking + .ai-prose")).toBeTruthy();
});

it("has a plain breadcrumb without a conversation menu", async () => {
  renderPage();
  await screen.findByText("How can I help you today?");
  fireEvent.change(screen.getByLabelText("Ask about your pages…"), { target: { value: "Price?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("1 new source");
  const crumb = screen.getByRole("navigation", { name: "Studio breadcrumb" });
  expect(crumb.querySelector(".ai-chat-title")?.textContent).toBe("Price?");
  expect(crumb.querySelector("button[aria-haspopup]")).toBeNull();
});

it("stops a running answer through the daemon", async () => {
  let release = () => {};
  sendMessage.mockImplementation(async (_id, _body, _signal, onEvent) => {
    onEvent({ type: "token", text: "Partial" });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  renderPage();
  await screen.findByText("How can I help you today?");
  fireEvent.change(screen.getByLabelText("Ask about your pages…"), { target: { value: "Go" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  const stop = await screen.findByRole("button", { name: "Stop answer" });
  fireEvent.click(stop);
  await waitFor(() => expect(aiMock.cancel).toHaveBeenCalledWith("c1"));
  release();
});

it("turns an answer into a page", async () => {
  apiMock.pages.create.mockResolvedValue({ path: "Twenty euro per seat [1]", hash: "h" });
  apiMock.pages.put.mockResolvedValue({ hash: "h2" });
  const props = renderPage();
  await screen.findByText("How can I help you today?");
  fireEvent.change(screen.getByLabelText("Ask about your pages…"), { target: { value: "Price?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findAllByRole("button", { name: "Source 1" });
  fireEvent.click(screen.getByRole("button", { name: /Turn into page/ }));
  await waitFor(() =>
    expect(apiMock.pages.create).toHaveBeenCalledWith({ title: "Twenty euro per seat [1]." }),
  );
  expect(apiMock.pages.put).toHaveBeenCalledWith(
    "Twenty euro per seat [1]",
    "Twenty euro per seat [1].",
    "h",
  );
  expect(props.onTreeChanged).toHaveBeenCalled();
});

it("narrows the pages the AI may use", async () => {
  aiMock.updateConversation.mockResolvedValue({
    id: "c1",
    title: "t",
    messages: [],
    scope: { kind: "vault", roots: [], excluded: ["Pricing"] },
    mode: "ask",
    page_id: null,
    updated_at: "now",
  });
  renderPage();
  await screen.findByText("How can I help you today?");
  fireEvent.click(screen.getByRole("button", { name: /All pages/ }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Pricing" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(
    (screen.getByRole("button", { name: "Use these pages" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it("starts centered even with history, moves the composer after sending, and returns on New chat", async () => {
  aiMock.allConversations.mockResolvedValue([await aiMock.conversation()]);
  renderPage();
  await screen.findByText("How can I help you today?");
  expect(document.querySelector(".ai-page-start")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Ask about your pages…"), { target: { value: "Price?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("1 new source");
  expect(document.querySelector(".ai-page-start")).toBeNull();
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "New chat" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  await screen.findByText("How can I help you today?");
  expect(document.querySelector(".ai-page-start")).toBeTruthy();
});

it("shows a proposal card under the answer that made it and lets the user accept it", async () => {
  apiMock.request.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes("/accept")) return { ...PROPOSAL, status: "accepted" };
    if (url.includes("/ai/proposals")) return init?.method ? PROPOSAL : [PROPOSAL];
    return [];
  });
  aiMock.conversation.mockResolvedValue({
    id: "c1",
    title: "Add",
    scope: { kind: "vault", roots: [], excluded: [] },
    mode: "act",
    page_id: null,
    updated_at: "now",
    context: [],
    messages: [
      { role: "user", content: "Add a line" },
      { ...answer, content: "Proposed.", sources: [], proposals: ["p_1"] },
    ],
  });
  sendMessage.mockImplementation(async (_id, _body, _signal, onEvent) => {
    onEvent({ type: "proposal", proposal: PROPOSAL });
    onEvent({ type: "token", text: "Proposed." });
    onEvent({
      type: "answer",
      text: "Proposed.",
      cited: [],
      sources: [],
      new_sources: [],
      proposals: ["p_1"],
      limits: [],
      run_id: "r",
    });
    onEvent({ type: "done" });
  });
  renderPage();
  await screen.findByText("How can I help you today?");
  fireEvent.change(screen.getByLabelText("Ask about your pages…"), {
    target: { value: "Add a line" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  const card = await screen.findByLabelText("Proposal: Add a line");
  expect(card.textContent).toContain("Awaiting review");
  // In chat the card is one line until opened; the diff is one click away.
  expect(card.querySelector('[data-kind="add"]')).toBeNull();
  fireEvent.click(within(card).getByRole("button", { expanded: false }));
  expect(card.querySelector('[data-kind="add"]')?.textContent).toBe("New line.");
  fireEvent.click(within(card).getByRole("button", { name: /^Accept$/ }));
  await waitFor(() =>
    expect(apiMock.request).toHaveBeenCalledWith(
      "/api/v1/ai/proposals/p_1/accept",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  await screen.findByText("Accepted");
});

it("keeps sources to one line of title chips and opens them when a citation is clicked", async () => {
  const followUp = { ...answer, context: false, content: "See [1].", thinking: "" };
  aiMock.allConversations.mockResolvedValue([
    {
      ...(await aiMock.conversation()),
      context: [],
      messages: [{ role: "user", content: "Price?" }, followUp],
    },
  ]);
  renderPage();
  await screen.findByText("How can I help you today?");
  fireEvent.click(await screen.findByRole("button", { name: "Price?" }));
  const line = (await screen.findByText("1 source")).closest("button") as HTMLButtonElement;
  expect(line.getAttribute("aria-expanded")).toBe("false");
  expect(line.querySelector(".ai-source-chip")?.textContent).toBe("Pricing");
  expect(document.querySelector(".ai-source-card")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Source 1" }));
  await waitFor(() => expect(document.querySelector('.ai-source-card[data-n="1"]')).toBeTruthy());
  expect(
    document.querySelector('.ai-source-card[data-n="1"]')?.hasAttribute("data-highlight"),
  ).toBe(true);
});

it("groups several proposals of one answer under a header, each a one-line card", async () => {
  const second = { ...PROPOSAL, id: "p_2", summary: "Add another line" };
  apiMock.request.mockImplementation(async (url: string) =>
    url.includes("/ai/proposals") ? [PROPOSAL, second] : [],
  );
  aiMock.allConversations.mockResolvedValue([
    {
      id: "c1",
      title: "Add",
      scope: { kind: "vault", roots: [], excluded: [] },
      mode: "act",
      page_id: null,
      updated_at: "now",
      context: [],
      messages: [
        { role: "user", content: "Add lines" },
        { ...answer, content: "Proposed.", sources: [], proposals: ["p_1", "p_2"] },
      ],
    },
  ]);
  renderPage();
  await screen.findByText("How can I help you today?");
  fireEvent.click(await screen.findByRole("button", { name: "Add" }));
  const group = await screen.findByLabelText("2 changes");
  await waitFor(() =>
    expect(group.querySelectorAll(".review-card[data-collapsed]")).toHaveLength(2),
  );
  expect(within(group).getAllByRole("button", { name: "Accept" })).toHaveLength(2);
});

it("shows the running step inline with a shimmer while the answer streams", async () => {
  let release = () => {};
  sendMessage.mockImplementation(async (_id, _body, _signal, onEvent) => {
    onEvent({ type: "round_start", round: 1 });
    onEvent({ type: "thinking", text: "First I look.\nThe price\n  is probably   in Pricing." });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    onEvent({
      type: "activity",
      step: {
        id: "thinking-1",
        round: 1,
        kind: "thinking",
        name: "Thinking",
        status: "succeeded",
        text: "First I look.",
      },
    });
    onEvent({
      type: "activity",
      step: {
        id: "t1",
        round: 1,
        kind: "tool",
        name: "read_page",
        status: "running",
        text: "Pricing",
      },
    });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  renderPage();
  await screen.findByText("How can I help you today?");
  fireEvent.change(screen.getByLabelText("Ask about your pages…"), { target: { value: "Price?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  const live = await screen.findByRole("status");
  expect(live.querySelector(".ai-shimmer")?.textContent).toBe("The price is probably in Pricing.");
  release();
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Reading a page · Pricing"),
  );
  expect(screen.getByText("Thought")).toBeTruthy();
  release();
});
