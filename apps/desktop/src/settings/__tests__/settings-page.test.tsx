import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const aiMock = vi.hoisted(() => ({
  status: vi.fn(),
  save: vi.fn(),
  check: vi.fn(),
  unload: vi.fn(),
  indexStatus: vi.fn(),
  rebuildIndex: vi.fn(),
}));
vi.mock("@/lib/ai", async () => ({
  ...(await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai")),
  ai: aiMock,
}));
vi.mock("@/lib/connections", async () => ({
  ...(await vi.importActual<typeof import("@/lib/connections")>("@/lib/connections")),
  connections: { list: vi.fn(async () => ({ connections: [], models: [] })) },
}));
const LLAMA = {
  id: "llama",
  name: "Chat engine",
  purpose: "Runs your models.",
  version: "b1",
  installed_version: "b1",
  installed_variant: "vulkan",
  previous_version: null,
  update_available: false,
  recommended: "vulkan",
  recommended_label: null,
  recommended_size: 1,
  reason: "",
  variants: [],
  custom_path: "",
  path: "/managed/llama-server",
  status: "idle",
  progress: 0,
  error: null,
};
vi.mock("@/lib/api", () => ({
  onDaemonEvent: () => () => {},
  request: vi.fn(async (path: string) => (path === "/api/v1/engines" ? [LLAMA] : [])),
  api: { health: vi.fn(async () => ({})) },
}));
vi.mock("@/models/EngineCard", () => ({
  EngineCard: ({ engineId }: { engineId: string }) => <div>engine:{engineId}</div>,
}));
vi.mock("@/models/ModelLibrary", () => ({
  ModelLibrary: ({ roles, kind }: { roles?: string[]; kind?: string }) => (
    <div>library:{roles?.join(",") ?? kind ?? "chat"}</div>
  ),
}));
vi.mock("@/models/IndexCard", () => ({ IndexCard: () => <div>index-card</div> }));
vi.mock("@/models/VaultCard", () => ({ VaultCard: () => <div>vault-card</div> }));
vi.mock("@/models/ConnectionsCard", () => ({ ConnectionsCard: () => <div>connections</div> }));
vi.mock("@/settings/VoicesCard", () => ({ VoicesCard: () => <div>voices-card</div> }));

import { ModelsPage } from "@/models/ModelsPage";

const CONFIG = {
  provider: "local",
  model_path: "/m.gguf",
  binary_path: "",
  whisper_binary_path: "",
  ocr_binary_path: "",
  tts_binary_path: "",
  context_size: 8192,
  gpu_layers: -1,
  resident: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  aiMock.status.mockResolvedValue({
    config: CONFIG,
    hardware: { ram_gb: 32, gpu: null, binary_path: "" },
    loaded: false,
  });
  aiMock.save.mockImplementation(async (config) => config);
});
afterEach(cleanup);

// Hidden panels have no accessible name to query by, so look them up by their label.
const panel = (name: string) =>
  document.querySelector(`[role="tabpanel"][aria-label="${name}"]`) as HTMLElement;

it("is called Settings, has a tab per concern, and no longer shows the MCP card", async () => {
  render(<ModelsPage onClose={() => {}} />);
  expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
  expect(screen.getAllByRole("tab").map((t) => t.textContent?.trim())).toEqual([
    "Chat",
    "Voice",
    "Search",
    "Documents",
    "Vault",
  ]);
  expect(screen.queryByText(/Connect AI apps/i)).toBeNull();
  expect(panel("Chat").hidden).toBe(false);
  expect(within(panel("Chat")).getByText("engine:llama")).toBeTruthy();
  expect(within(panel("Voice")).getByText("library:speech,vad,turn,tts")).toBeTruthy();
  expect(within(panel("Voice")).getByText("engine:crispasr")).toBeTruthy();
  expect(within(panel("Search")).getByText("library:embedding")).toBeTruthy();
  expect(within(panel("Documents")).getByText("library:ocr")).toBeTruthy();
  // OCR reports the chat engine rather than mounting a second, competing engine card.
  expect(screen.getAllByText("engine:llama")).toHaveLength(1);
  expect(
    await within(panel("Documents")).findByText(/Uses the chat engine — already downloaded/),
  ).toBeTruthy();
  expect(within(panel("Documents")).getByText("/managed/llama-server")).toBeTruthy();
  expect(within(panel("Vault")).getByText("vault-card")).toBeTruthy();
});

it("opens on the requested tab without microphone settings or tests", async () => {
  render(<ModelsPage onClose={() => {}} initialTab="voice" />);
  await screen.findByText("voices-card");
  expect(screen.queryByText("microphone-picker")).toBeNull();
  expect(screen.queryByText("voice-test")).toBeNull();
  expect(panel("Voice").hidden).toBe(false);
  expect(panel("Chat").hidden).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: /Search/ }));
  expect(screen.queryByText("voice-test")).toBeNull();
  expect(panel("Search").hidden).toBe(false);
});

it("keeps an unsaved change when switching tabs and saves it once", async () => {
  render(<ModelsPage onClose={() => {}} initialTab="chat" />);
  fireEvent.change(await screen.findByLabelText(/GPU layers/), { target: { value: "20" } });
  // Leave and come back: the panels stay mounted, so the draft must survive.
  fireEvent.click(screen.getByRole("tab", { name: /Voice/ }));
  fireEvent.click(screen.getByRole("tab", { name: /Documents/ }));
  fireEvent.click(screen.getByRole("tab", { name: /Chat/ }));
  expect((screen.getByLabelText(/GPU layers/) as HTMLInputElement).value).toBe("20");
  fireEvent.click(screen.getByRole("checkbox", { name: /Keep ready for the next question/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(aiMock.save).toHaveBeenCalledTimes(1));
  expect(aiMock.save.mock.calls[0][0]).toMatchObject({ gpu_layers: 20, resident: false });
});

it("offers no way to point at an outside executable", async () => {
  render(<ModelsPage onClose={() => {}} initialTab="voice" />);
  await screen.findByText("voices-card");
  expect(screen.queryByLabelText(/executable/i)).toBeNull();
});

it("still says so when a stored path overrides the engine Graite installed", async () => {
  // Set outside the app (an .env, or an older version's Advanced field). Invisible is worse
  // than read-only: it changes what runs.
  aiMock.status.mockResolvedValue({
    config: {
      ...CONFIG,
      whisper_binary_path: "/opt/whisper-server",
      ocr_binary_path: "/opt/llama-server",
    },
    hardware: { ram_gb: 32, gpu: null, binary_path: "" },
    loaded: false,
  });
  render(<ModelsPage onClose={() => {}} initialTab="voice" />);
  await screen.findByText("voices-card");
  expect(within(panel("Voice")).getByText("/opt/whisper-server")).toBeTruthy();
  expect(within(panel("Voice")).getByText(/Speech to text runs a build of your own/)).toBeTruthy();
  expect(within(panel("Documents")).getByText("/opt/llama-server")).toBeTruthy();
  // …and no input: it is a statement, not a setting.
  expect(screen.queryByLabelText(/executable/i)).toBeNull();
});
