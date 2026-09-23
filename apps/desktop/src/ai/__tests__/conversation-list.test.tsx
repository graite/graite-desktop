import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ConversationList } from "../ConversationList";
import type { Conversation } from "@/lib/ai";
afterEach(cleanup);
const conversations = Array.from({ length: 12 }, (_, i) => ({
  id: String(i),
  title: `Chat ${i}`,
  updated_at: new Date(2026, 0, i + 1).toISOString(),
  page_id: null,
  mode: "ask",
  scope: { kind: "vault", roots: [], excluded: [] },
  messages: [
    { role: "user", content: i === 0 ? "Hidden recipe for noodles" : "Hello", interrupted: false },
  ],
})) as Conversation[];
it("sorts recent chats, collapses history and opens older chats through full-text search", () => {
  const onSelect = vi.fn();
  render(
    <ConversationList
      conversations={conversations}
      selectedId={null}
      busy={false}
      onSelect={onSelect}
      onNew={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
  expect(screen.getAllByRole("button", { name: /^Chat \d+$/ })[0].textContent).toBe("Chat 11");
  fireEvent.click(screen.getByRole("button", { name: "Chats" }));
  expect(screen.queryByRole("button", { name: "Chat 11" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Search chat history" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Search chats"), { target: { value: "noodles" } });
  expect(within(dialog).queryByText("Chat 11")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: /Chat 0/ }));
  expect(onSelect).toHaveBeenCalledWith(conversations[0]);
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("opens the future sections without creating an agent or workflow", () => {
  const onSection = vi.fn();
  render(
    <ConversationList
      conversations={[]}
      selectedId={null}
      busy={false}
      onSection={onSection}
      onSelect={vi.fn()}
      onNew={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  expect(onSection).toHaveBeenLastCalledWith("agents");
  expect(screen.queryByRole("button", { name: "Workflows" })).toBeNull();
});
