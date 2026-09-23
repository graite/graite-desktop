import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  discover: vi.fn(),
  saveModel: vi.fn(),
  removeModel: vi.fn(),
}));
vi.mock("@/lib/connections", async () => {
  const actual = await vi.importActual<typeof import("@/lib/connections")>("@/lib/connections");
  return { ...actual, connections: api };
});

import { ConnectionsCard } from "../ConnectionsCard";

const CONNECTION = {
  id: "c1",
  name: "OpenRouter",
  kind: "compatible" as const,
  base_url: "https://openrouter.ai/api/v1",
  created_at: "",
  key_saved: true,
};
const SAVED = {
  id: "m1",
  connection_id: "c1",
  model: "anthropic/claude-sonnet-4",
  label: "Sonnet 4",
  context_length: 200000,
  added_at: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.discover.mockResolvedValue({
    models: [
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        context_length: 200000,
        pricing: null,
      },
      { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000, pricing: null },
      { id: "meta/llama-3", name: "Llama 3", context_length: 8000, pricing: null },
    ],
  });
  api.saveModel.mockResolvedValue({ ...SAVED, id: "m2", model: "openai/gpt-4o", label: "GPT-4o" });
  api.add.mockResolvedValue({ ...CONNECTION, id: "c2", name: "Work" });
  api.removeModel.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

it("searches a connection's models and saves one", async () => {
  const onChanged = vi.fn();
  render(
    <ConnectionsCard
      kind="compatible"
      connections={[CONNECTION]}
      models={[SAVED]}
      activeModelId="m1"
      onPick={vi.fn()}
      onChanged={onChanged}
    />,
  );
  const saved = screen.getByRole("list", { name: "Saved models on OpenRouter" });
  expect(
    within(saved)
      .getByRole("button", { name: /^Sonnet 4/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    (within(saved).getByRole("button", { name: "Remove Sonnet 4" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Find models/ }));
  await screen.findByText("GPT-4o");
  expect(api.discover).toHaveBeenCalledWith("c1");
  expect(
    (screen.getByRole("button", { name: "Claude Sonnet 4 saved" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "gpt" } });
  expect(screen.queryByText("Llama 3")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save GPT-4o" }));
  await waitFor(() =>
    expect(api.saveModel).toHaveBeenCalledWith("c1", {
      model: "openai/gpt-4o",
      label: "GPT-4o",
      context_length: 128000,
    }),
  );
  expect(onChanged).toHaveBeenCalled();
});

it("adds a connection with its key and picks a saved model for this vault", async () => {
  const onPick = vi.fn();
  const onChanged = vi.fn();
  render(
    <ConnectionsCard
      kind="compatible"
      connections={[CONNECTION]}
      models={[SAVED]}
      activeModelId={null}
      onPick={onPick}
      onChanged={onChanged}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Sonnet 4/ }));
  expect(onPick).toHaveBeenCalledWith(SAVED);
  const form = screen.getByRole("form", { name: "Add Model server connection" });
  // The OpenRouter shortcut fills the address; the name is suggested from the host.
  fireEvent.click(within(form).getByRole("button", { name: "https://openrouter.ai/api/v1" }));
  expect(
    (within(form).getByPlaceholderText("http://127.0.0.1:1234/v1") as HTMLInputElement).value,
  ).toBe("https://openrouter.ai/api/v1");
  expect(within(form).getByPlaceholderText("OpenRouter")).toBeTruthy();
  fireEvent.change(within(form).getByPlaceholderText("Paste your API key"), {
    target: { value: "sk-or-x" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "Add connection" }));
  await waitFor(() =>
    expect(api.add).toHaveBeenCalledWith({
      name: "OpenRouter",
      kind: "compatible",
      base_url: "https://openrouter.ai/api/v1",
      api_key: "sk-or-x",
    }),
  );
  expect(onChanged).toHaveBeenCalled();
  expect(screen.queryByText("sk-or-x")).toBeNull();
  // A pasted local address suggests a local name.
  fireEvent.change(within(form).getByPlaceholderText("http://127.0.0.1:1234/v1"), {
    target: { value: "http://127.0.0.1:11434/v1" },
  });
  expect(within(form).getByPlaceholderText("Ollama")).toBeTruthy();
});

it("renames a connection and changes its server address", async () => {
  const onChanged = vi.fn();
  api.update.mockResolvedValue({ ...CONNECTION, name: "Work" });
  render(
    <ConnectionsCard
      kind="compatible"
      connections={[CONNECTION]}
      models={[]}
      activeModelId={null}
      onPick={vi.fn()}
      onChanged={onChanged}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit OpenRouter" }));
  fireEvent.change(screen.getByLabelText("Name of OpenRouter"), { target: { value: "Work" } });
  fireEvent.change(screen.getByLabelText("Server address of OpenRouter"), {
    target: { value: "https://example.com/v1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(api.update).toHaveBeenCalledWith("c1", {
      name: "Work",
      base_url: "https://example.com/v1",
    }),
  );
  expect(onChanged).toHaveBeenCalled();
  expect(screen.queryByLabelText("Name of OpenRouter")).toBeNull();
});
