import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({ status: vi.fn(), save: vi.fn(), request: vi.fn() }));
vi.mock("@/lib/api", () => ({ request: mocks.request }));
vi.mock("@/lib/ai", () => ({ ai: mocks }));
const cloudMocks = vi.hoisted(() => ({
  status: vi.fn(async () => ({ signed_in: false, cloud_url: "https://api.getgraite.com" })),
  models: vi.fn(async () => [] as unknown[]),
}));
vi.mock("@/lib/cloud", () => ({ cloud: cloudMocks }));
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
