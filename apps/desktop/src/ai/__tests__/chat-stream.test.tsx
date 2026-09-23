import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";

const aiMock = vi.hoisted(() => ({ conversation: vi.fn(), cancel: vi.fn() }));
const sendMessage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai");
  return { ...actual, ai: aiMock, sendMessage };
});

import { useChatStream } from "../useChatStream";
import type { Conversation } from "@/lib/ai";

const conversation = (id: string, text: string): Conversation =>
  ({
    id,
    title: id,
    mode: "ask",
    page_id: null,
    updated_at: "now",
    scope: { kind: "vault", roots: [], excluded: [] },
    messages: [{ role: "assistant", content: text, interrupted: false }],
  }) as Conversation;

const A = conversation("a", "A history");
const B = conversation("b", "B history");

function Harness() {
  const [open, setOpen] = useState<Conversation>(A);
  const chat = useChatStream({
    conversation: open,
    ensureConversation: async () => open,
  });
  return (
    <div>
      <button onClick={() => setOpen(B)}>open B</button>
      <button onClick={() => void chat.send("Question")}>send</button>
      <p data-testid="messages">{chat.messages.map((m) => m.content).join(" | ")}</p>
      <p data-testid="stream">{chat.stream}</p>
      <p data-testid="busy">{String(chat.busy)}</p>
      <p data-testid="context">{chat.context.map((c) => `${c.n}:${c.added_turn}`).join(" ")}</p>
      <p data-testid="new">{chat.newSources.map((c) => c.n).join(" ")}</p>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  aiMock.conversation.mockResolvedValue(A);
  aiMock.cancel.mockResolvedValue({ cancelled: true });
});
afterEach(cleanup);

it("stops streaming into a chat the user navigated away from", async () => {
  let emit: ((event: { type: string; text: string }) => void) | null = null;
  let finish: (() => void) | null = null;
  sendMessage.mockImplementation(async (_id, _body, _signal, onEvent) => {
    emit = onEvent;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  render(<Harness />);
  await act(async () => {
    screen.getByText("send").click();
  });
  act(() => emit?.({ type: "token", text: "partial" }));
  expect(screen.getByTestId("stream").textContent).toBe("partial");
  expect(screen.getByTestId("busy").textContent).toBe("true");

  await act(async () => {
    screen.getByText("open B").click();
  });
  expect(screen.getByTestId("messages").textContent).toBe("B history");
  expect(screen.getByTestId("stream").textContent).toBe("");
  expect(screen.getByTestId("busy").textContent).toBe("false");
  expect(aiMock.cancel).toHaveBeenCalledWith("a"); // the daemon stops generating too

  // Late events from the abandoned turn must not reach the open chat.
  act(() => emit?.({ type: "token", text: " more" }));
  expect(screen.getByTestId("stream").textContent).toBe("");
  await act(async () => {
    finish?.();
  });
  expect(screen.getByTestId("messages").textContent).toBe("B history");
});

it("keeps the optimistic question visible while the first answer streams", async () => {
  sendMessage.mockImplementation(async (_id, _body, _signal, onEvent) => {
    onEvent({ type: "token", text: "Answering" });
  });
  render(<Harness />);
  await act(async () => {
    screen.getByText("send").click();
  });
  expect(screen.getByTestId("messages").textContent).toContain("A history");
});

it("merges streamed sources into the context set and lists only the new ones", async () => {
  const source = (n: number) => ({
    n,
    kind: "page" as const,
    page_path: `P${n}`,
    page_id: null,
    title: `P${n}`,
    heading_path: [],
    snippet: "",
    hash: null,
    chunk_ids: [n],
    start_line: null,
    end_line: null,
  });
  const withContext = {
    ...A,
    context: [{ ...source(1), added_turn: 1, last_cited_turn: 1, stale: false }],
  };
  // The daemon persists the grown set; the refetch after the turn must not shrink it.
  aiMock.conversation.mockResolvedValue({
    ...withContext,
    context: [
      ...withContext.context,
      { ...source(2), added_turn: 2, last_cited_turn: 0, stale: false },
    ],
  });
  sendMessage.mockImplementation(async (_id, _body, _signal, onEvent) => {
    onEvent({ type: "sources", sources: [source(1), source(2)], new: [2] });
  });
  function WithContext() {
    const chat = useChatStream({
      conversation: withContext,
      ensureConversation: async () => withContext,
    });
    return (
      <div>
        <button onClick={() => void chat.send("More")}>send</button>
        <p data-testid="context">{chat.context.map((c) => `${c.n}:${c.added_turn}`).join(" ")}</p>
        <p data-testid="new">{chat.newSources.map((c) => c.n).join(" ")}</p>
      </div>
    );
  }
  render(<WithContext />);
  expect(screen.getByTestId("context").textContent).toBe("1:1");
  await act(async () => {
    screen.getByText("send").click();
  });
  expect(screen.getByTestId("context").textContent).toBe("1:1 2:2");
  expect(screen.getByTestId("new").textContent).toBe("2");
});
