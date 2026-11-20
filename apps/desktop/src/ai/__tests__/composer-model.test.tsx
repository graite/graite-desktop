import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  save: vi.fn(),
  request: vi.fn(),
  reasoning: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ request: mocks.request }));
vi.mock("@/lib/ai", () => ({ ai: mocks }));
const cloudMocks = vi.hoisted(() => ({
  status: vi.fn(async () => ({ signed_in: false, cloud_url: "https://api.getgraite.com" })),
  models: vi.fn(async () => [] as unknown[]),
}));
vi.mock("@/lib/cloud", () => ({ cloud: cloudMocks }));
const computeMocks = vi.hoisted(() => ({
  status: vi.fn(async () => ({ serving: false, devices: [] as unknown[] })),
  use: vi.fn(async () => ({})),
}));
vi.mock("@/lib/compute", () => ({ compute: computeMocks }));
import { ComposerModel } from "../ComposerModel";
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const CATALOG = [
  { id: "one", name: "One", role: "chat", status: "installed", local_path: "/one.gguf" },
  { id: "two", name: "Two", role: "chat", status: "installed", local_path: "/two.gguf" },
  { id: "three", name: "Not downloaded", role: "chat", status: "available" },
  { id: "embed", name: "Embedding", role: "embedding", status: "installed" },
];
const STORE = {
  connections: [
    {
      id: "c1",
      name: "OpenRouter",
      kind: "compatible",
      base_url: "https://openrouter.ai/api/v1",
      created_at: "",
      key_saved: true,
    },
  ],
  models: [
    {
      id: "m1",
      connection_id: "c1",
      model: "anthropic/claude-sonnet-4",
      label: "Sonnet 4",
      context_length: 200000,
      added_at: "",
    },
  ],
};

function setup(config: Record<string, unknown>) {
  mocks.status.mockResolvedValue({
    config,
    active: config.provider === "local" ? { label: "One" } : { label: "Sonnet 4" },
  });
  mocks.request.mockImplementation(async (url: string) =>
    url.endsWith("/catalog") ? CATALOG : STORE,
  );
  mocks.save.mockImplementation(async (next: Record<string, unknown>) => next);
}

it("lists installed local models and saved remote models grouped by connection", async () => {
  const config = {
    provider: "local",
    model_path: "/one.gguf",
    context_size: 8192,
    saved_model_id: null,
  };
  setup(config);
  const onModelChanged = vi.fn();
  render(
    <ComposerModel
      busy={false}
      working={false}
      onWorking={vi.fn()}
      value=""
      onChange={vi.fn()}
      onModelChanged={onModelChanged}
    />,
  );
  await screen.findByText("One");
  fireEvent.keyDown(screen.getByRole("button", { name: "Choose chat model" }), {
    key: "ArrowDown",
  });
  await screen.findByText("On device");
  expect(screen.getByText("OpenRouter")).toBeTruthy();
  expect(screen.queryByText("Not downloaded")).toBeNull();
  expect(screen.queryByText("Embedding")).toBeNull();
  fireEvent.click(await screen.findByRole("menuitem", { name: /Sonnet 4/ }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ ...config, saved_model_id: "m1" }));
  expect(onModelChanged).toHaveBeenCalled();
});

it("switching back to a local model drops the saved-model link and keeps other settings", async () => {
  const config = {
    provider: "compatible",
    model: "anthropic/claude-sonnet-4",
    saved_model_id: "m1",
    context_size: 8192,
  };
  setup(config);
  render(
    <ComposerModel busy={false} working={false} onWorking={vi.fn()} value="" onChange={vi.fn()} />,
  );
  await screen.findByText("Sonnet 4");
  fireEvent.keyDown(screen.getByRole("button", { name: "Choose chat model" }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Two" }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      ...config,
      provider: "local",
      model_path: "/two.gguf",
      saved_model_id: null,
    }),
  );
});

it("offers Graite Cloud once signed in and switches the vault to it", async () => {
  const config = {
    provider: "local",
    model_path: "/one.gguf",
    context_size: 8192,
    saved_model_id: null,
  };
  setup(config);
  cloudMocks.status.mockResolvedValue({ signed_in: true, cloud_url: "https://api.getgraite.com" });
  cloudMocks.models.mockResolvedValue([
    { id: "graite/default", name: "Graite", context_length: null, available: true, min_plan: null },
  ]);
  const onModelChanged = vi.fn();
  render(
    <ComposerModel
      busy={false}
      working={false}
      onWorking={vi.fn()}
      value=""
      onChange={vi.fn()}
      onModelChanged={onModelChanged}
    />,
  );
  await screen.findByText("One");
  fireEvent.keyDown(screen.getByRole("button", { name: "Choose chat model" }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Graite Cloud" }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      ...config,
      provider: "graite",
      model: "graite/default",
      saved_model_id: null,
      connection_id: null,
    }),
  );
  expect(onModelChanged).toHaveBeenCalled();
});

const props = {
  busy: false,
  working: false,
  onWorking: () => {},
  value: "",
  onChange: () => {},
};

it("offers thinking and effort only where the model in use has them", async () => {
  const config = { provider: "local", model_path: "/one.gguf", thinking: "auto", effort: "medium" };
  setup(config);
  // A model with neither: no control at all.
  const none = render(<ComposerModel {...props} />);
  await screen.findByText("One");
  expect(screen.queryByRole("button", { name: "Thinking and effort" })).toBeNull();
  none.unmount();

  // A local model with a thinking switch but no effort level.
  mocks.status.mockResolvedValue({
    config,
    active: { label: "One" },
    reasoning: { toggle: true, effort: false },
  });
  mocks.reasoning.mockImplementation(async (change: Record<string, string>) => {
    mocks.status.mockResolvedValue({
      config: { ...config, ...change },
      active: { label: "One" },
      reasoning: { toggle: true, effort: false },
    });
    return { ...config, ...change };
  });
  render(<ComposerModel {...props} />);
  const button = await screen.findByRole("button", { name: "Thinking and effort" });
  fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
  expect(await screen.findByText("Thinking")).toBeTruthy();
  expect(screen.queryByText("Effort")).toBeNull();
  fireEvent.click(screen.getByRole("menuitemradio", { name: /Off/ }));
  await waitFor(() => expect(mocks.reasoning).toHaveBeenCalledWith({ thinking: "off" }));
  // The button says what is set, and choosing it did not go through the model-reloading save.
  expect(await screen.findByText("Thinking off")).toBeTruthy();
  expect(mocks.save).not.toHaveBeenCalled();
});

it("offers effort on a model that has it, and greys it out while thinking is off", async () => {
  const config = { provider: "compatible", saved_model_id: "m1", thinking: "off", effort: "high" };
  mocks.status.mockResolvedValue({
    config,
    active: { label: "Sonnet 4" },
    reasoning: { toggle: true, effort: true },
  });
  mocks.request.mockImplementation(async (url: string) =>
    url.endsWith("/catalog") ? CATALOG : STORE,
  );
  render(<ComposerModel {...props} />);
  const button = await screen.findByRole("button", { name: "Thinking and effort" });
  fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
  const high = await screen.findByRole("menuitemradio", { name: /High/ });
  expect(high.getAttribute("aria-disabled") ?? high.getAttribute("data-disabled")).not.toBeNull();
});

it("lists the chat models of your AI workstation and switches chat to one", async () => {
  setup({ provider: "local", model_path: "/one.gguf", context_size: 8192, saved_model_id: null });
  computeMocks.status.mockResolvedValue({
    serving: false,
    devices: [
      { id: "r2", name: "Desk", chat_model: "gemma-12b", chat_models: ["gemma-12b", "big-27b"] },
    ],
  });
  const onModelChanged = vi.fn();
  render(
    <ComposerModel
      busy={false}
      working={false}
      onWorking={vi.fn()}
      value=""
      onChange={vi.fn()}
      onModelChanged={onModelChanged}
    />,
  );
  await screen.findByText("One");
  fireEvent.keyDown(screen.getByRole("button", { name: "Choose chat model" }), {
    key: "ArrowDown",
  });
  expect(await screen.findByText("Workstation · Desk")).toBeTruthy();
  fireEvent.click(await screen.findByRole("menuitem", { name: "big-27b" }));
  await waitFor(() => expect(computeMocks.use).toHaveBeenCalledWith("r2", "chat", true, "big-27b"));
  await waitFor(() => expect(onModelChanged).toHaveBeenCalled());
  expect(mocks.save).not.toHaveBeenCalled();
});
