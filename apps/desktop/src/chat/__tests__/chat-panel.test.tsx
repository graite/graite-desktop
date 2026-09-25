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

const conversation = (kind: "page" | "folder") => ({
  id: "c1",
  title: "New conversation",
  messages: [],
  mode: "ask",
  page_id: "p",
  updated_at: "now",
  scope: { kind, roots: ["Notes"], excluded: [] },
});

beforeEach(() => {
  vi.clearAllMocks();
  aiMock.status.mockResolvedValue({
    config: { provider: "local", model_path: "/m", binary_path: "/b" },
    hardware: { binary_path: "" },
    key_saved: false,
  });
  aiMock.conversations.mockResolvedValue([]);
  aiMock.createConversation.mockResolvedValue(conversation("folder"));
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

const props = {
  path: "Notes",
  title: "Notes",
  onClose: vi.fn(),
  onSettings: vi.fn(),
  onNavigate: vi.fn(),
  settingsVersion: 0,
};

it("chats about the page and its subpages, and can narrow to the page alone", async () => {
  render(<ChatPanel {...props} />);
  await screen.findByRole("button", { name: "& subpages" });
  fireEvent.change(screen.getByLabelText("Ask about this page…"), {
    target: { value: "Summary?" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(aiMock.createConversation).toHaveBeenCalled());
  expect(aiMock.createConversation.mock.calls[0][0].scope).toEqual({
    kind: "folder",
    roots: ["Notes"],
    excluded: [],
  });
  expect(sendMessage.mock.calls[0][1]).toMatchObject({ message: "Summary?", page_path: "Notes" });
  fireEvent.click(screen.getByRole("button", { name: "This page" }));
  await waitFor(() =>
    expect(aiMock.updateConversation).toHaveBeenCalledWith("c1", {
      scope: { kind: "page", roots: ["Notes"], excluded: [] },
    }),
  );
});

it("offers the editor selection as a source only when text is selected", async () => {
  const { rerender } = render(<ChatPanel {...props} />);
  await screen.findByRole("button", { name: "& subpages" });
  expect(screen.queryByRole("button", { name: /selection/i })).toBeNull();
  rerender(<ChatPanel {...props} selection="The launch colour is amber." />);
  fireEvent.click(screen.getByRole("button", { name: "Use selection" }));
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
  const pressed = (name: string) =>
    screen.getByRole("button", { name }).getAttribute("aria-pressed");
  expect(pressed("This page")).toBe("true");
  fireEvent.keyDown(history, { key: "ArrowDown" });
  const items = await screen.findAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining("Budget questions"),
    expect.stringContaining("Launch plan"),
  ]);
  fireEvent.click(items[0]);
  // Opening the other one restores its scope too.
  await waitFor(() => expect(pressed("& subpages")).toBe("true"));
});
