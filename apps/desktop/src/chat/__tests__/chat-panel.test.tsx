import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const aiMock = vi.hoisted(() => ({
  status: vi.fn(),
  conversations: vi.fn(),
  conversation: vi.fn(),
  createConversation: vi.fn(),
  updateConversation: vi.fn(),
  deleteAttachment: vi.fn(),
  uploadAttachment: vi.fn(),
  cancel: vi.fn(),
}));
const sendMessage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai");
  return { ...actual, ai: aiMock, sendMessage };
});
vi.mock("@/lib/api", () => ({
  onDaemonEvent: vi.fn(() => () => {}),
  request: vi.fn(async () => []),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ChatPanel } from "../ChatPanel";

const conversation = (kind: "page" | "folder" | "vault") => ({
  id: "c1",
  title: "New conversation",
  messages: [],
  mode: "ask",
  page_id: "p",
  updated_at: "now",
  scope: { kind, roots: kind === "vault" ? [] : ["Notes"], excluded: [] },
});
const tree = [
  { id: "p", path: "Notes", title: "Notes", icon: null, has_content: true, children: [] },
  { id: "q", path: "Other", title: "Other", icon: null, has_content: true, children: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  aiMock.status.mockResolvedValue({
    config: { provider: "local", model_path: "/m", binary_path: "/b" },
    hardware: { binary_path: "" },
    key_saved: false,
  });
  aiMock.conversations.mockResolvedValue([]);
  aiMock.createConversation.mockResolvedValue(conversation("vault"));
  aiMock.updateConversation.mockResolvedValue(conversation("page"));
  aiMock.conversation.mockResolvedValue({
    ...conversation("folder"),
    messages: [{ role: "assistant", content: "Fine.", interrupted: false }],
  });
  sendMessage.mockImplementation(async (_id, _body, _signal, onEvent) => {
    onEvent({ type: "answer", text: "Fine.", cited: [], sources: [], limits: [], run_id: "r" });
    onEvent({ type: "done" });
  });
});
afterEach(cleanup);

/** Beside a page the scope is an icon next to +; its name and tooltip say the choice. */
const scopeButton = () => screen.getByRole("button", { name: /^Pages the AI can use: / });
const scopeShown = (text: RegExp) => expect(scopeButton().getAttribute("aria-label")).toMatch(text);
async function pickScope(name: RegExp) {
  fireEvent.keyDown(scopeButton(), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

const props = {
  path: "Notes",
  tree,
  onClose: vi.fn(),
  onSettings: vi.fn(),
  onNavigate: vi.fn(),
  settingsVersion: 0,
};

it("starts with this page and its subpages, and can narrow to the page alone", async () => {
  render(<ChatPanel {...props} />);
  // In the message box, as an icon.
  await waitFor(() => scopeShown(/: This page & subpages$/));
  expect(scopeButton().textContent).toBe("");
  // Only icons in the box: no scope chips or labels squeezed next to the message.
  expect(screen.queryByRole("group", { name: "Where the AI may search" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Ask about this page…"), {
    target: { value: "Summary?" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(aiMock.createConversation).toHaveBeenCalled());
  // The chat belongs to the page, whatever it may read.
  expect(aiMock.createConversation.mock.calls[0][0]).toMatchObject({
    page_path: "Notes",
    scope: { kind: "folder", roots: ["Notes"], excluded: [] },
  });
  expect(sendMessage.mock.calls[0][1]).toMatchObject({ message: "Summary?", page_path: "Notes" });
  await waitFor(() => scopeShown(/: This page & subpages$/));
  await pickScope(/^This page\s*Only the page/);
  await waitFor(() =>
    expect(aiMock.updateConversation).toHaveBeenCalledWith("c1", {
      scope: { kind: "page", roots: ["Notes"], excluded: [] },
    }),
  );
});

it("deselects all pages in one step", async () => {
  render(<ChatPanel {...props} />);
  await waitFor(() => scopeShown(/: This page & subpages$/));
  await pickScope(/Deselect all/);
  await waitFor(() => scopeShown(/No pages/));
});

it("offers the editor selection as a source only when text is selected", async () => {
  const { rerender } = render(<ChatPanel {...props} />);
  await waitFor(() => scopeShown(/: This page & subpages$/));
  expect(screen.queryByRole("button", { name: /selection/i })).toBeNull();
  rerender(<ChatPanel {...props} selection="The launch colour is amber." />);
  fireEvent.click(screen.getByRole("button", { name: "Use your selection" }));
  expect(screen.getByRole("button", { name: "Using your selection" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Ask about this page…"), {
    target: { value: "What colour?" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(sendMessage).toHaveBeenCalled());
  expect(sendMessage.mock.calls[0][1].selection).toEqual({
    page_path: "Notes",
    text: "The launch colour is amber.",
  });
});

it("keeps earlier conversations behind a history button, newest first", async () => {
  aiMock.conversations.mockResolvedValue([
    {
      ...conversation("page"),
      id: "old",
      title: "Launch plan",
      updated_at: "2026-09-20T10:00:00Z",
    },
    {
      ...conversation("folder"),
      id: "new",
      title: "Budget questions",
      updated_at: "2026-09-24T10:00:00Z",
    },
  ]);
  render(<ChatPanel {...props} />);
  expect(screen.queryByRole("combobox", { name: "Conversation history" })).toBeNull();
  const history = await screen.findByRole("button", { name: "Conversation history" });
  await waitFor(() => expect((history as HTMLButtonElement).disabled).toBe(false));
  // The panel opens on the first conversation, which was about this page alone.
  await waitFor(() => scopeShown(/: This page$/));
  fireEvent.keyDown(history, { key: "ArrowDown" });
  const items = await screen.findAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining("Budget questions"),
    expect.stringContaining("Launch plan"),
  ]);
  fireEvent.click(items[0]);
  // Opening the other one restores its scope too.
  await waitFor(() => scopeShown(/: This page & subpages$/));
});

it("opens a handed-off HTML request in Act mode without sending when asked to draft it", async () => {
  render(
    <ChatPanel
      {...props}
      request={{
        id: 7,
        prompt: "Revise the existing HTML dashboard: ",
        mode: "act",
        send: false,
      }}
    />,
  );
  const composer = await screen.findByLabelText("Ask about this page…");
  await waitFor(() =>
    expect((composer as HTMLTextAreaElement).value).toBe("Revise the existing HTML dashboard: "),
  );
  // Beside a page the composer is narrow: mode, depth and model live in one settings menu,
  // whose tooltip says what is chosen.
  expect(screen.queryByRole("button", { name: "Answer mode" })).toBeNull();
  expect(screen.getByRole("button", { name: "Chat settings" }).title).toMatch(/^Act/);
  expect(sendMessage).not.toHaveBeenCalled();
});
