import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StarterModels } from "./StarterModels";
import { request } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  request: vi.fn(),
  connectEvents: () => () => {},
  onDaemonEvent: () => () => {},
}));

const starter = (id: string, level: string, min_ram_gb: number, min_vram_gb: number | null) => ({
  id,
  name: `Model ${level}`,
  level,
  role: "chat",
  tier: "starter",
  repo: id.startsWith("qwen") ? "unsloth/Qwen" : "unsloth/gemma",
  summary: `${level} summary`,
  needs: `${min_ram_gb} GB memory`,
  min_ram_gb,
  min_vram_gb,
  status: "available",
  local_path: "",
  size: 3e9,
  progress: 0,
});
const catalog = [
  starter("gemma-light", "Light", 8, null),
  starter("gemma-everyday", "Everyday", 16, null),
  starter("gemma-powerful", "Powerful", 32, 16),
  starter("qwen-maximum", "Maximum", 32, 24),
  {
    ...starter("old", "", 8, null),
    name: "Older chat",
    tier: "default",
    status: "installed",
    local_path: "/m/old.gguf",
  },
];
const engine = {
  id: "llama",
  status: "idle",
  installed_version: null,
  custom_path: "",
  recommended: "cpu",
  recommended_size: 1e7,
  progress: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(request).mockImplementation(async (path: string) => {
    if (path === "/api/v1/ai/catalog") return catalog;
    if (path === "/api/v1/engines") return [engine];
    if (path === "/api/v1/engines/llama/install") return { ...engine, status: "downloading" };
    if (path.endsWith("/download"))
      return { ...catalog.find((m) => path.includes(`/${m.id}/`)), status: "downloading" };
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(cleanup);

it("explains each starter model and recommends the largest one that runs well", async () => {
  render(
    <StarterModels
      hardware={{ ram_gb: 31.3, available_gb: 20, vram_gb: 0 } as never}
      selectedPath=""
      disabled={false}
      onChoose={() => {}}
      showInstalled
    />,
  );
  const everyday = await screen.findByRole("article", { name: "Everyday: Model Everyday" });
  expect(within(everyday).getByText("Recommended")).toBeTruthy();
  expect(within(everyday).getByText("Runs well on this computer")).toBeTruthy();
  const powerful = screen.getByRole("article", { name: "Powerful: Model Powerful" });
  expect(within(powerful).getByText("Runs, but slowly on this computer")).toBeTruthy();
  // Models already on the computer stay usable without the full library.
  expect(screen.getByText("Older chat")).toBeTruthy();
});

it("sets up the model runner along with the first download", async () => {
  render(
    <StarterModels
      hardware={{ ram_gb: 16, available_gb: 10, vram_gb: 0 } as never}
      selectedPath=""
      disabled={false}
      onChoose={() => {}}
      showInstalled={false}
    />,
  );
  const light = await screen.findByRole("article", { name: "Light: Model Light" });
  await waitFor(() => expect(request).toHaveBeenCalledWith("/api/v1/engines"));
  fireEvent.click(within(light).getByRole("button", { name: /Download/ }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/api/v1/ai/catalog/gemma-light/download", {
      method: "POST",
    }),
  );
  expect(request).toHaveBeenCalledWith("/api/v1/engines/llama/install", expect.anything());
  expect(screen.queryByText("Older chat")).toBeNull();
});
