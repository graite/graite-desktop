import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelLibrary } from "./ModelLibrary";
import { ModelSources } from "./ModelSources";
import { request } from "@/lib/api";
import { platform } from "@/lib/platform";

vi.mock("@/lib/api", () => ({ request: vi.fn(), connectEvents: () => () => {} }));
vi.mock("@/lib/platform", () => ({ platform: { kind: "desktop", pickModelPath: vi.fn() } }));
const models = [
  {
    id: "recommended",
    name: "Qwen 3 · Everyday",
    role: "chat",
    status: "available",
    local_path: "",
    size: 100,
  },
  {
    id: "chat",
    name: "My chat",
    role: "chat",
    status: "installed",
    local_path: "/models/chat.gguf",
    size: 100,
    source: "local",
  },
  {
    id: "embed",
    name: "EmbeddingGemma",
    role: "embedding",
    status: "installed",
    local_path: "/models/embed.gguf",
    size: 100,
  },
  {
    id: "speech",
    name: "Whisper Q8",
    role: "speech",
    status: "available",
    local_path: "",
    size: 100,
  },
];
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(request).mockResolvedValue(models);
});
afterEach(cleanup);

it("keeps embedding and speech models out of the chat picker", async () => {
  render(<ModelLibrary selectedPath="" onChoose={() => {}} disabled={false} />);
  await waitFor(() => expect(screen.getByText("My chat")).toBeTruthy());
  expect(screen.queryByText("Qwen 3 · Everyday")).toBeNull();
  expect(screen.queryByText("EmbeddingGemma")).toBeNull();
  expect(screen.queryByText("Whisper Q8")).toBeNull();
});

it("keeps utilities separate from chat and discovery", async () => {
  render(<ModelLibrary kind="utilities" selectedPath="" onChoose={() => {}} disabled={false} />);
  await screen.findByText("EmbeddingGemma");
  expect(screen.queryByText("Whisper Q8")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Set up local utilities" }));
  expect(screen.getByText("Whisper Q8")).toBeTruthy();
  expect(screen.queryByText("My chat")).toBeNull();
  expect(screen.queryByRole("button", { name: "Discover models" })).toBeNull();
});

it("registers a native folder selection but does nothing when cancelled", async () => {
  const changed = vi.fn(async () => {});
  const picker = vi.mocked(platform.pickModelPath!);
  picker.mockResolvedValueOnce(null).mockResolvedValueOnce("/models");
  render(<ModelSources disabled={false} onChange={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
  await waitFor(() => expect(picker).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Add folder" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/api/v1/ai/hub/folder", {
      method: "POST",
      body: JSON.stringify({ path: "/models" }),
    }),
  );
  expect(changed).toHaveBeenCalled();
});

it("discovers the requested Qwen family and selects a Q4 version", async () => {
  vi.mocked(request).mockResolvedValue([
    {
      id: "q4",
      filename: "model-UD-Q4_K_M.gguf",
      size: 100,
      repo: "unsloth/Qwen3.8-27B-GGUF",
      revision: "abc",
    },
  ]);
  render(<ModelSources disabled={false} onChange={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Quantization" }).textContent).toContain(
      "UD-Q4_K_M",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: /Qwen3.8/ }));
  await waitFor(() =>
    expect(request).toHaveBeenLastCalledWith("/api/v1/ai/hub/browse", {
      method: "POST",
      body: JSON.stringify({ repository: "unsloth/Qwen3.8-27B-GGUF" }),
    }),
  );
  expect(screen.getByRole("combobox", { name: "Quantization" }).textContent).toContain("UD-Q4_K_M");
});

it("downloads VAD and turn taking together, and retries only the failed download", async () => {
  const vad = { id: "vad", name: "Silero", role: "vad", status: "available", size: 2_000_000 };
  const turn = { id: "turn", name: "Smart Turn", role: "turn", status: "error", size: 8_000_000 };
  vi.mocked(request).mockImplementation(async (path) => {
    if (path === "/api/v1/ai/catalog") return [vad, turn];
    if (path.includes("/vad/")) return { ...vad, status: "installed" };
    throw new Error("Download interrupted");
  });
  render(
    <ModelLibrary
      kind="utilities"
      roles={["vad", "turn"]}
      selectedPath=""
      onChoose={() => {}}
      disabled={false}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Download speech models" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(request).toHaveBeenCalledWith("/api/v1/ai/catalog/vad/download", { method: "POST" });
  expect(request).toHaveBeenCalledWith("/api/v1/ai/catalog/turn/download", { method: "POST" });
  vi.mocked(request).mockClear();
  vi.mocked(request).mockResolvedValue({ ...turn, status: "installed" });
  fireEvent.click(screen.getByRole("button", { name: "Download speech models" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Download speech models" })).toBeNull(),
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith("/api/v1/ai/catalog/turn/download", { method: "POST" });
});

it("pauses and removes the two listening models as one", async () => {
  const installed = [
    { id: "vad", name: "Silero", role: "vad", status: "installed", size: 2_000_000 },
    { id: "turn", name: "Smart Turn", role: "turn", status: "installed", size: 8_000_000 },
  ];
  vi.mocked(request).mockImplementation(async (path) => {
    if (path === "/api/v1/ai/catalog") return installed;
    return { ...installed[0], status: "available" };
  });
  const first = render(
    <ModelLibrary
      kind="utilities"
      roles={["vad", "turn"]}
      selectedPath=""
      onChoose={() => {}}
      disabled={false}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Remove the speech models" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/api/v1/ai/catalog/vad/remove", { method: "POST" }),
  );
  expect(request).toHaveBeenCalledWith("/api/v1/ai/catalog/turn/remove", { method: "POST" });

  const downloading = installed.map((m) => ({ ...m, status: "downloading", progress: 40 }));
  vi.mocked(request).mockImplementation(async (path) => {
    if (path === "/api/v1/ai/catalog") return downloading;
    return { ...downloading[0], status: "paused" };
  });
  first.unmount();
  render(
    <ModelLibrary
      kind="utilities"
      roles={["vad", "turn"]}
      selectedPath=""
      onChoose={() => {}}
      disabled={false}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Pause the speech model downloads" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/api/v1/ai/catalog/vad/pause", { method: "POST" }),
  );
  expect(request).toHaveBeenCalledWith("/api/v1/ai/catalog/turn/pause", { method: "POST" });
});
