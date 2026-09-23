import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const auto = vi.hoisted(() => ({
  buildAgent: vi.fn(),
  agents: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  runAgent: vi.fn(),
  workflows: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  runWorkflow: vi.fn(),
  schedules: vi.fn(),
  createSchedule: vi.fn(),
  patchSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  runSchedule: vi.fn(),
  runs: vi.fn(),
  run: vi.fn(),
}));
const aiMock = vi.hoisted(() => ({ jobs: vi.fn(), cancelJob: vi.fn(), status: vi.fn() }));
const request = vi.hoisted(() => vi.fn(async () => []));
const events = vi.hoisted(() => {
  const listeners = new Set<(e: { type: string; data: unknown }) => void>();
  return {
    listeners,
    emit: (type: string, data: unknown) => listeners.forEach((l) => l({ type, data })),
  };
});
vi.mock("@/lib/automation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/automation")>("@/lib/automation");
  return { ...actual, automation: auto };
});
vi.mock("@/lib/ai", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai");
  return { ...actual, ai: aiMock };
});
vi.mock("@/lib/api", () => ({
  onDaemonEvent: vi.fn((listener: (e: { type: string; data: unknown }) => void) => {
    events.listeners.add(listener);
    return () => events.listeners.delete(listener);
  }),
  request,
}));
vi.mock("@/chat/MarkdownAnswer", () => ({
  MarkdownAnswer: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/editor/AgentInstructionsEditor", () => ({
  AgentInstructionsEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (text: string) => void;
  }) => (
    <textarea
      aria-label="Agent instructions"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import { AgentsView } from "../AgentsView";
import { SchedulesView } from "../SchedulesView";
import { RunsView } from "../RunsView";

const AGENT = {
  name: "weekly-review",
  description: "Sum up the week.",
  path: "Projects/_agents/weekly-review.md",
  folder: "Projects",
  scope: { kind: "folder", roots: ["Projects"], excluded: [] },
  mode: "act",
  instructions: "Summarise.",
  model: null,
  skills: null,
  tools: null,
  schedule: "0 7 * * 1",
  last_run: {
    id: "run1",
    status: "succeeded",
    started_at: new Date(Date.now() - 3_600_000).toISOString(),
    finished_at: null,
    error: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  auto.agents.mockResolvedValue([AGENT]);
  auto.createAgent.mockImplementation(async (body) => ({
    ...AGENT,
    ...body,
    path: "_agents/new.md",
    folder: "",
  }));
  auto.updateAgent.mockImplementation(async (_name, body) => ({ ...AGENT, ...body }));
  auto.runAgent.mockResolvedValue({ job_id: "j1" });
  auto.deleteAgent.mockResolvedValue({ ok: true });
  auto.schedules.mockResolvedValue([
    {
      id: "cr1",
      name: "weekly-review",
      expr: "0 7 * * 1",
      source: "agent:weekly-review",
      job_kind: "agent_run",
      payload: {},
      page_path: null,
      enabled: true,
      last_run_at: null,
      next_run_at: new Date(Date.now() + 7_200_000).toISOString(),
      last_status: null,
      failures: 0,
    },
    {
      id: "cr2",
      name: "Digest",
      expr: "0 9 * * 1",
      source: "tool",
      job_kind: "agent_run",
      payload: {},
      page_path: null,
      enabled: false,
      last_run_at: null,
      next_run_at: null,
      last_status: "failed: boom",
      failures: 2,
    },
  ]);
  auto.patchSchedule.mockResolvedValue({});
  auto.runSchedule.mockResolvedValue({ job_id: "j2" });
  const allRuns = [
    {
      id: "run1",
      kind: "agent_run",
      trigger: "manual",
      agent: "weekly-review",
      status: "succeeded",
      started_at: new Date().toISOString(),
      input: { question: "Run now." },
      output: null,
    },
    {
      id: "run2",
      kind: "chat_turn",
      trigger: "user",
      status: "failed",
      started_at: new Date().toISOString(),
      input: { question: "Price?" },
      output: null,
    },
  ];
  auto.runs.mockImplementation(async (params: { kind?: string } = {}) =>
    allRuns.filter((r) => !params.kind || r.kind === params.kind),
  );
  auto.run.mockResolvedValue({
    id: "run1",
    kind: "agent_run",
    trigger: "manual",
    agent: "weekly-review",
    status: "succeeded",
    started_at: new Date().toISOString(),
    provider: "local",
    model: "q",
    input: { question: "Run now.", task: "Summarise." },
    steps: [
      {
        ord: 1,
        kind: "retrieve",
        name: "keywords",
        status: "succeeded",
        input: { pages: 4 },
        output: { candidates: 2 },
      },
      { ord: 2, kind: "generate", name: null, status: "succeeded", output: { tool_calls: 1 } },
      {
        ord: 3,
        kind: "tool",
        name: "propose_append",
        status: "succeeded",
        input: { path: "Projects", summary: "Add summary" },
        output: { page: "Projects", proposal_id: "p_1", summary: "Add summary" },
      },
    ],
    proposals: [],
    children: [],
    output: { answer: "Done.", seconds: 12, tool_calls: 1 },
  });
  aiMock.jobs.mockResolvedValue([
    {
      id: "job1",
      kind: "agent_run",
      status: "pending",
      page_path: null,
      priority: 8,
      attempts: 0,
      progress: null,
      error: null,
      run_id: null,
      created_at: new Date().toISOString(),
      finished_at: null,
    },
  ]);
  aiMock.cancelJob.mockResolvedValue({});
});
afterEach(cleanup);

it("lists agents with their last run, runs one now and creates a new one", async () => {
  const onOpenRun = vi.fn();
  render(<AgentsView tree={[]} onOpenRun={onOpenRun} />);
  const card = await screen.findByLabelText("weekly-review");
  expect(card.textContent).toContain("Projects · proposes changes · Mondays at 07:00 UTC");
  fireEvent.click(within(card).getByRole("button", { name: /succeeded/ }));
  expect(onOpenRun).toHaveBeenCalledWith("run1");
  fireEvent.click(within(card).getByRole("button", { name: /Run now/ }));
  await waitFor(() => expect(auto.runAgent).toHaveBeenCalledWith("weekly-review"));
  fireEvent.click(screen.getByRole("button", { name: /New agent/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Create blank/ }));
  fireEvent.change(await screen.findByLabelText("Agent name"), { target: { value: "inbox" } });
  fireEvent.change(screen.getByLabelText("Agent instructions"), {
    target: { value: "Sort the inbox." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
  await waitFor(() => expect(auto.createAgent).toHaveBeenCalled());
  expect(auto.createAgent.mock.calls[0][0]).toMatchObject({
    name: "inbox",
    instructions: "Sort the inbox.",
    mode: "act",
    folder: null,
  });
});

it("shows schedules with their source and lets the user pause one", async () => {
  render(<SchedulesView />);
  const digest = await screen.findByLabelText("Digest");
  expect(digest.textContent).toContain("Scheduled in chat");
  expect(digest.textContent).toContain("2 failures");
  const weekly = screen.getByLabelText("weekly-review");
  expect(weekly.textContent).toContain("Agent weekly-review");
  expect(within(weekly).queryByRole("button", { name: /Delete/ })).toBeNull(); // definition rows are deleted with the file
  fireEvent.click(within(weekly).getByLabelText("weekly-review enabled"));
  await waitFor(() => expect(auto.patchSchedule).toHaveBeenCalledWith("cr1", { enabled: false }));
  fireEvent.click(within(digest).getByRole("button", { name: /Run now/ }));
  await waitFor(() => expect(auto.runSchedule).toHaveBeenCalledWith("cr2"));
});

it("creates a schedule from words and edits the timing of one made in chat", async () => {
  auto.createSchedule.mockResolvedValue({});
  render(<SchedulesView />);
  expect((await screen.findByLabelText("Digest")).textContent).toContain("Mondays at 09:00 UTC");
  fireEvent.click(screen.getByRole("button", { name: /New schedule/ }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(within(dialog).getByRole("combobox", { name: "Agent" }).textContent).toContain(
      "weekly-review",
    ),
  );
  expect(within(dialog).getByRole("combobox", { name: "Repeat" }).textContent).toContain(
    "Every day",
  );
  expect(
    (within(dialog).getByRole("button", { name: "Create schedule" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(within(dialog).getByLabelText("Schedule name"), {
    target: { value: "Morning review" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create schedule" }));
  await waitFor(() =>
    expect(auto.createSchedule).toHaveBeenCalledWith({
      name: "Morning review",
      expr: "0 9 * * *",
      job_kind: "agent_run",
      payload: { agent: "weekly-review" },
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  fireEvent.click(screen.getByRole("button", { name: "Edit Digest" }));
  const edit = await screen.findByRole("dialog");
  fireEvent.click(within(edit).getByRole("button", { name: "Thu" }));
  fireEvent.click(within(edit).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(auto.patchSchedule).toHaveBeenCalledWith("cr2", { name: "Digest", expr: "0 9 * * 1,4" }),
  );
});

it("lists agent runs first, filters chats in, and opens a run's steps", async () => {
  const onOpenRun = vi.fn();
  const onNavigate = vi.fn();
  const { rerender } = render(
    <RunsView onNavigate={onNavigate} openRunId={null} onOpenRun={onOpenRun} />,
  );
  await screen.findByText("weekly-review");
  expect(screen.queryByText("Price?")).toBeNull(); // chat turns do not bury agent runs
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  await screen.findByText("Price?");
  fireEvent.click(screen.getByText("weekly-review").closest("button") as HTMLButtonElement);
  expect(onOpenRun).toHaveBeenCalledWith("run1");
  fireEvent.click(screen.getByRole("tab", { name: /Jobs/ }));
  await screen.findByText("agent_run");
  fireEvent.click(screen.getByRole("button", { name: /Cancel job/ }));
  await waitFor(() => expect(aiMock.cancelJob).toHaveBeenCalledWith("job1"));
  rerender(<RunsView onNavigate={onNavigate} openRunId="run1" onOpenRun={onOpenRun} />);
  const steps = await screen.findByLabelText("Steps");
  expect(steps.textContent).toContain("Searched the pages");
  expect(steps.textContent).toContain("4 pages in scope · 2 passages found");
  expect(steps.textContent).toContain("Proposed an addition to");
  expect(steps.textContent).toContain("Add summary");
  fireEvent.click(within(steps).getByRole("button", { name: "Projects" }));
  expect(onNavigate).toHaveBeenCalledWith("Projects");
  expect(screen.getByText("Done.")).toBeTruthy();
  expect(screen.getByText(/Run now\. · started/)).toBeTruthy();
  // A live update refetches the open run.
  const calls = auto.run.mock.calls.length;
  events.emit("run_update", { id: "run1", status: "succeeded", step: null });
  await waitFor(() => expect(auto.run.mock.calls.length).toBeGreaterThan(calls));
});

it("follows a queued run from the agent workspace and opens it", async () => {
  const onOpenRun = vi.fn();
  render(<AgentsView tree={[]} onOpenRun={onOpenRun} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit weekly-review" }));
  const strip = screen.getByLabelText("Last run");
  expect(strip.textContent).toContain("Done");
  fireEvent.click(screen.getByRole("button", { name: /Run agent/ }));
  await waitFor(() => expect(auto.runAgent).toHaveBeenCalledWith("weekly-review"));
  await waitFor(() => expect(screen.getByLabelText("Last run").textContent).toContain("Queued"));
  events.emit("job_update", {
    id: "j1",
    status: "running",
    run_id: "run9",
    progress: { message: "Using read_page" },
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Last run").textContent).toContain("Using read_page"),
  );
  events.emit("job_update", {
    id: "j1",
    status: "done",
    run_id: "run9",
    progress: { message: "Using read_page" },
  });
  await waitFor(() => expect(screen.getByLabelText("Last run").textContent).toContain("Done"));
  fireEvent.click(
    within(screen.getByLabelText("Last run")).getByRole("button", { name: "Open run" }),
  );
  expect(onOpenRun).toHaveBeenCalledWith("run9");
});

it("asks follow-up questions and applies chat changes only after review, preserving skills", async () => {
  auto.agents.mockResolvedValue([{ ...AGENT, skills: ["reviewer"] }]);
  auto.buildAgent.mockResolvedValueOnce({ message: "What time should it run?", draft: null });
  render(<AgentsView tree={[]} onOpenRun={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit weekly-review" }));
  expect(screen.queryByLabelText("Message agent builder")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Message agent builder" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Configure in chat" }));
  fireEvent.change(screen.getByLabelText("Message agent builder"), {
    target: { value: "Run every day" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send to agent builder" }));
  await screen.findByText("What time should it run?");
  expect(auto.updateAgent).not.toHaveBeenCalled();
  const before = auto.buildAgent.mock.calls[0][0];
  auto.buildAgent.mockResolvedValueOnce({
    message: "Here is the updated schedule.",
    draft: { ...before, schedule: "0 9 * * *" },
  });
  fireEvent.change(screen.getByLabelText("Message agent builder"), {
    target: { value: "9 AM UTC" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send to agent builder" }));
  fireEvent.click(await screen.findByRole("button", { name: "Apply to draft" }));
  expect(auto.updateAgent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
  expect(screen.getByRole("combobox", { name: "Repeat" }).textContent).toContain("Every day");
  fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
  expect((screen.getByLabelText("Cron expression") as HTMLInputElement).value).toBe("0 9 * * *");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(auto.updateAgent).toHaveBeenCalledWith(
      "weekly-review",
      expect.objectContaining({ schedule: "0 9 * * *", skills: ["reviewer"] }),
    ),
  );
});

it("does not overwrite edits made while a chat suggestion is generated", async () => {
  auto.buildAgent.mockImplementation(async (body) => ({
    message: "Suggested.",
    draft: { ...body, description: "Changed by chat" },
  }));
  render(<AgentsView tree={[]} onOpenRun={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit weekly-review" }));
  expect(screen.queryByLabelText("Message agent builder")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Message agent builder" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Configure in chat" }));
  fireEvent.change(screen.getByLabelText("Message agent builder"), {
    target: { value: "Change description" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send to agent builder" }));
  await screen.findByRole("button", { name: "Apply to draft" });
  fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "My review" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  expect(screen.getByRole("alert").textContent).toContain("You edited the draft");
  expect((screen.getByLabelText("Agent name") as HTMLInputElement).value).toBe("My review");
  fireEvent.click(screen.getByRole("button", { name: "Back to agents" }));
  expect(screen.getByText("You have unsaved changes.")).toBeTruthy();
});

it("minimizes configuration chat and selects tools as pills", async () => {
  render(<AgentsView tree={[]} onOpenRun={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit weekly-review" }));
  expect(screen.queryByRole("textbox", { name: "Message agent builder" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Configure in chat" }));
  expect(screen.getByRole("textbox", { name: "Message agent builder" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Minimize configuration chat" }));
  expect(screen.queryByRole("textbox", { name: "Message agent builder" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
  const tool = screen.getByRole("button", { name: "Read pages" });
  expect(tool.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(tool);
  expect(tool.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(auto.updateAgent).toHaveBeenCalled());
  expect(auto.updateAgent.mock.calls[0][1].tools).not.toContain("read_page");
});
