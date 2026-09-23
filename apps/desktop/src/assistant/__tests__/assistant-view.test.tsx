import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const assistantMock = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  optInMemory: vi.fn(),
  conversation: vi.fn(),
  conversations: vi.fn(),
  memories: vi.fn(),
  addMemory: vi.fn(),
  upgradeMemory: vi.fn(),
  tidyMemory: vi.fn(),
}));
const aiMock = vi.hoisted(() => ({ status: vi.fn(), conversation: vi.fn(), cancel: vi.fn() }));
const apiMock = vi.hoisted(() => ({
  onDaemonEvent: vi.fn(() => () => {}),
  request: vi.fn(async () => []),
  isOwnRequest: () => false,
  ConflictError: class extends Error {
    constructor(
      public hash: string,
      public body: string,
    ) {
      super("changed on disk");
    }
  },
  pages: { get: vi.fn(), put: vi.fn(), patch: vi.fn(), remove: vi.fn() },
}));
const MEMORY_BODIES: Record<string, string> = {
  "Ada/Journal": "- 2026-09-20: Looked at Atlas.\n",
};
const MEMORIES = [
  {
    path: "Ada/Memories/Goes by Sam",
    title: "Goes by Sam",
    body: "",
    kind: "About",
    pinned: true,
    last_recalled: null,
  },
  {
    path: "Ada/Memories/Keep it short",
    title: "Keep it short",
    body: "Spoken answers\nstay brief.",
    kind: "Lesson",
    pinned: false,
    last_recalled: "2026-09-20",
  },
];

vi.mock("@/lib/assistant", async () => {
  const actual = await vi.importActual<typeof import("@/lib/assistant")>("@/lib/assistant");
  return { ...actual, assistant: assistantMock };
});
vi.mock("@/lib/ai", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai");
  return { ...actual, ai: aiMock, sendMessage: vi.fn() };
});
vi.mock("@/lib/api", () => apiMock);
vi.mock("@/editor/TextInstructionsEditor", () => ({
  TextInstructionsEditor: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
  }) => <textarea aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />,
}));
vi.mock("../AssistantPage", () => ({
  AssistantPage: ({ path }: { path: string }) => <div>Assistant document: {path}</div>,
}));
vi.mock("@/ai/Composer", () => ({
  Composer: ({ placeholder }: { placeholder: string }) => <div>{placeholder}</div>,
}));

import { AssistantView } from "../AssistantView";
import { useAssistant } from "../useAssistant";

const ADA = {
  configured: true,
  name: "Ada",
  description: "",
  path: "_agents/assistant.md",
  sections: { personality: "Warm.", context: "", guidelines: "", goals: "- Ship Atlas." },
  scope: { kind: "vault", roots: [], excluded: [] },
  mode: "act",
  model: null,
  skills: null,
  tools: null,
  schedule: null,
  triggers: [],
  voice: { language: "auto", exaggeration: 0.5, cfg: 0.5 },
  memory: {
    page_id: "m1",
    root: "Ada",
    pages: { Memories: "Ada/Memories", Journal: "Ada/Journal" },
    auto_apply: true,
    opted_in: true,
    legacy: [] as string[],
  },
  conversation_id: null,
};

function Harness({ onNavigate = () => {} }: { onNavigate?: (path: string) => void }) {
  const state = useAssistant();
  return (
    <AssistantView
      state={state}
      tree={[]}
      visible
      onNavigate={onNavigate}
      onSettings={() => {}}
      settingsVersion={1}
      onOpenRun={() => {}}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.pages.put.mockResolvedValue({ hash: "h2" });
  apiMock.pages.get.mockImplementation(async (path: string) => ({
    id: `id-${path}`,
    path,
    body: MEMORY_BODIES[path] ?? "",
    hash: `h-${path}`,
    frontmatter: {},
  }));
  apiMock.pages.remove.mockResolvedValue({ trash_id: "t1" });
  assistantMock.memories.mockResolvedValue({
    root: "Ada",
    parent: "Ada/Memories",
    kinds: [],
    items: MEMORIES,
  });
  assistantMock.addMemory.mockResolvedValue(MEMORIES[0]);
  assistantMock.upgradeMemory.mockResolvedValue({ created: 3 });
  aiMock.status.mockResolvedValue({
    config: { provider: "compatible", model: "test", base_url: "http://x" },
    hardware: {},
    key_saved: false,
  });
  aiMock.conversation.mockResolvedValue({
    id: "c1",
    title: "",
    messages: [],
    scope: { kind: "vault", roots: [], excluded: [] },
    mode: "act",
    page_id: null,
    updated_at: "now",
    kind: "assistant",
  });
  assistantMock.conversation.mockResolvedValue({ id: "c1", title: "", updated_at: "now" });
});
afterEach(cleanup);

it("asks for a name first, creates the assistant and opts its memory in", async () => {
  assistantMock.get
    .mockResolvedValueOnce({ configured: false })
    .mockResolvedValue({ ...ADA, memory: { ...ADA.memory, opted_in: true } });
  assistantMock.save.mockResolvedValue(ADA);
  assistantMock.optInMemory.mockResolvedValue({ opted_in: true });
  render(<Harness />);
  const name = await screen.findByLabelText("Assistant name");
  expect(
    (screen.getByRole("button", { name: "Create assistant" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(name, { target: { value: " Ada " } });
  fireEvent.click(screen.getByRole("button", { name: "Create assistant" }));
  await waitFor(() =>
    expect(assistantMock.save).toHaveBeenCalledWith({ name: "Ada", sections: { goals: "" } }),
  );
  expect(assistantMock.optInMemory).toHaveBeenCalled();
  expect(await screen.findByText("Hi, I’m Ada.")).toBeTruthy();
  expect(screen.getByText("Message Ada…")).toBeTruthy();
});

it("edits the profile sections and saves them", async () => {
  assistantMock.get.mockResolvedValue(ADA);
  assistantMock.save.mockImplementation(async (body) => ({ ...ADA, ...body }));
  render(<Harness />);
  fireEvent.click(await screen.findByRole("tab", { name: /Profile/ }));
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  fireEvent.change(screen.getByLabelText("Goals"), {
    target: { value: "- Ship Atlas.\n- Sleep more." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(assistantMock.save).toHaveBeenCalled());
  expect(assistantMock.save.mock.calls[0][0].sections.goals).toBe("- Ship Atlas.\n- Sleep more.");
  await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
});

it("opens the memory pages inside the assistant, with no review gate", async () => {
  assistantMock.get.mockResolvedValue(ADA);
  const onNavigate = vi.fn();
  render(<Harness onNavigate={onNavigate} />);
  fireEvent.click(await screen.findByRole("tab", { name: /Memory/ }));
  // The assistant owns these pages: nothing asks the user to allow the writes.
  expect(screen.queryByRole("button", { name: /Allow automatic memory updates/ })).toBeNull();
  expect(screen.queryByText(/waits in Review/)).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Open Journal page" }));
  expect(await screen.findByText("Assistant document: Ada/Journal")).toBeTruthy();
  expect(onNavigate).not.toHaveBeenCalled();
});

it("shows one card per memory and edits, adds, finds and forgets them", async () => {
  assistantMock.get.mockResolvedValue(ADA);
  render(<Harness />);
  fireEvent.click(await screen.findByRole("tab", { name: /Memory/ }));
  expect(await screen.findByRole("button", { name: "Edit memory: Keep it short" })).toBeTruthy();
  expect(screen.getByText(/Spoken answers\s+stay brief\./)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Unpin Goes by Sam" }).getAttribute("aria-pressed"),
  ).toBe("true");

  // Several lines of detail, saved as the memory page's body.
  fireEvent.click(screen.getByRole("button", { name: "Edit memory: Keep it short" }));
  fireEvent.change(screen.getByLabelText("Details"), {
    target: { value: "Spoken answers stay brief.\nWritten ones may be longer." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(apiMock.pages.put).toHaveBeenCalledWith(
      "Ada/Memories/Keep it short",
      "Spoken answers stay brief.\nWritten ones may be longer.\n",
      "h-Ada/Memories/Keep it short",
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
  fireEvent.change(screen.getByLabelText("Memory"), { target: { value: "Likes oat milk" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(assistantMock.addMemory).toHaveBeenCalledWith({
      title: "Likes oat milk",
      body: "",
      kind: "Preference",
      pinned: false,
    }),
  );

  fireEvent.change(screen.getByLabelText("Search memories"), { target: { value: "brief" } });
  expect(screen.queryByRole("button", { name: "Edit memory: Goes by Sam" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Search memories"), { target: { value: "" } });

  fireEvent.click(screen.getByRole("button", { name: "Forget: Goes by Sam" }));
  await waitFor(() =>
    expect(apiMock.pages.remove).toHaveBeenCalledWith("Ada/Memories/Goes by Sam"),
  );
  expect(screen.getByText("Last 1 entry")).toBeTruthy();
});

it("offers to turn the old Profile and Playbook into cards", async () => {
  assistantMock.get.mockResolvedValue({
    ...ADA,
    memory: { ...ADA.memory, legacy: ["Profile", "Playbook"] },
  });
  render(<Harness />);
  fireEvent.click(await screen.findByRole("tab", { name: /Memory/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Convert to cards" }));
  await waitFor(() => expect(assistantMock.upgradeMemory).toHaveBeenCalled());
});

it("renames the assistant from its header and updates the conversation title", async () => {
  assistantMock.get.mockResolvedValue(ADA);
  assistantMock.save.mockImplementation(async (body) => ({ ...ADA, ...body }));
  render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: "Rename Ada" }));
  fireEvent.change(screen.getByLabelText("New assistant name"), { target: { value: "Nova" } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  expect(await screen.findByRole("button", { name: "Rename Nova" })).toBeTruthy();
  expect(screen.getByText("Message Nova…")).toBeTruthy();
  expect(assistantMock.save).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Nova", sections: ADA.sections }),
  );
});

it("keeps profile edits across section changes", async () => {
  assistantMock.get.mockResolvedValue(ADA);
  render(<Harness />);
  fireEvent.click(await screen.findByRole("tab", { name: /Profile/ }));
  fireEvent.change(screen.getByLabelText("Goals"), { target: { value: "Draft goal" } });
  fireEvent.click(screen.getByRole("tab", { name: /Memory/ }));
  fireEvent.click(screen.getByRole("tab", { name: /Profile/ }));
  expect((screen.getByLabelText("Goals") as HTMLTextAreaElement).value).toBe("Draft goal");
});
