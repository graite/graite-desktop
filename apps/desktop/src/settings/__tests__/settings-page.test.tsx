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
vi.mock("@/models/StarterModels", () => ({ StarterModels: () => <div>starter-models</div> }));
vi.mock("@/models/IndexCard", () => ({ IndexCard: () => <div>index-card</div> }));
vi.mock("@/models/VaultCard", () => ({ VaultCard: () => <div>vault-card</div> }));
vi.mock("@/models/ConnectorsCard", () => ({ ConnectorsCard: () => <div>connectors-card</div> }));
vi.mock("@/models/ConnectionsCard", () => ({ ConnectionsCard: () => <div>connections</div> }));
vi.mock("@/models/GraiteCloudCard", () => ({
  GraiteCloudCard: ({ onPick }: { onPick: (model: { id: string }) => void }) => (
    <button type="button" onClick={() => onPick({ id: "graite/fast" })}>
      pick-graite-fast
    </button>
  ),
}));
vi.mock("@/settings/VoicesCard", () => ({ VoicesCard: () => <div>voices-card</div> }));
const profileMock = vi.hoisted(() => ({
  saveProfile: vi.fn(async (value: { first_name: string }) => value),
}));
vi.mock("@/lib/profile", () => ({
  useProfile: () => ({ first_name: "Sam" }),
  saveProfile: profileMock.saveProfile,
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { ModelsPage } from "@/models/ModelsPage";

const CONFIG = {
  provider: "local",
  base_url: "http://127.0.0.1:1234/v1",
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
  localStorage.clear(); // tech mode is remembered app-wide
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
const nav = () => within(screen.getByRole("navigation", { name: "Settings sections" }));
const open = (name: RegExp) => fireEvent.click(nav().getByRole("button", { name }));

it("has a sidebar of sections grouped by where the AI runs", async () => {
  render(<ModelsPage onClose={() => {}} />);
  await screen.findByText("starter-models");
  expect(
    nav()
      .getAllByRole("button")
      .map((b) => b.textContent?.replace("In use", "").trim()),
  ).toEqual([
    "General",
    "On this computer",
    "Speech",
    "Search",
    "Documents",
    "Your own server",
    "Graite Cloud",
    "AI connectors",
    "API keys",
  ]);
  for (const title of ["Local AI", "Graite", "Your AI apps", "Your own keys"])
    expect(nav().getByText(title)).toBeTruthy();
  // Chat runs on this computer, so Settings opens there and marks it.
  expect(panel("On this computer").hidden).toBe(false);
  expect(nav().getByRole("button", { name: /On this computer/ }).textContent).toContain("In use");
  expect(nav().getByRole("button", { name: /Graite Cloud/ }).textContent).not.toContain("In use");
  // Beginners see the starter models; engine and full library wait for tech mode.
  expect(within(panel("On this computer")).getByText("starter-models")).toBeTruthy();
  expect(within(panel("On this computer")).queryByText("engine:llama")).toBeNull();
  expect(within(panel("On this computer")).queryByText("library:chat")).toBeNull();
  expect(within(panel("Speech")).getByText("library:speech,vad,turn,tts")).toBeTruthy();
  expect(within(panel("Speech")).getByText("engine:crispasr")).toBeTruthy();
  expect(within(panel("Search")).getByText("library:embedding")).toBeTruthy();
  expect(within(panel("Documents")).getByText("library:ocr")).toBeTruthy();
  expect(within(panel("AI connectors")).getByText("connectors-card")).toBeTruthy();
  expect(within(panel("General")).getByText("vault-card")).toBeTruthy();
  // OCR reports the chat engine rather than mounting a second, competing engine card.
  expect(screen.queryAllByText("engine:llama")).toHaveLength(0);
  expect(
    await within(panel("Documents")).findByText(/Uses the chat engine — already downloaded/),
  ).toBeTruthy();
  expect(within(panel("Documents")).getByText("/managed/llama-server")).toBeTruthy();
});

it("explains every section the same way before its controls", async () => {
  render(<ModelsPage onClose={() => {}} />);
  await screen.findByText("starter-models");
  for (const name of [
    "On this computer",
    "Your own server",
    "Speech",
    "Search",
    "Documents",
    "Graite Cloud",
    "AI connectors",
    "API keys",
  ]) {
    const section = within(panel(name));
    expect(section.getByRole("heading", { level: 1, name, hidden: true })).toBeTruthy();
    for (const question of ["Why", "You need", "Leaves this computer"])
      expect(section.getByText(question)).toBeTruthy();
  }
  expect(within(panel("Graite Cloud")).getByText(/Zero data retention/)).toBeTruthy();
  expect(within(panel("On this computer")).getByText("Nothing.")).toBeTruthy();
});

it("goes back to the pages from the sidebar", async () => {
  const onClose = vi.fn();
  render(<ModelsPage onClose={onClose} />);
  await screen.findByText("starter-models");
  fireEvent.click(screen.getByRole("button", { name: "Back to pages" }));
  expect(onClose).toHaveBeenCalled();
});

it("opens on the requested section without microphone settings or tests", async () => {
  render(<ModelsPage onClose={() => {}} initialTab="voice" />);
  await screen.findByText("voices-card");
  expect(screen.queryByText("microphone-picker")).toBeNull();
  expect(screen.queryByText("voice-test")).toBeNull();
  expect(panel("Speech").hidden).toBe(false);
  expect(panel("On this computer").hidden).toBe(true);
  open(/Search/);
  expect(screen.queryByText("voice-test")).toBeNull();
  expect(panel("Search").hidden).toBe(false);
});

it("still understands the names from before the sidebar", async () => {
  const { unmount } = render(<ModelsPage onClose={() => {}} initialTab="vault" />);
  await screen.findByText("starter-models");
  expect(panel("General").hidden).toBe(false);
  unmount();
  // "chat" opens the section of the model chat uses: here a key for an outside provider.
  aiMock.status.mockResolvedValue({
    config: { ...CONFIG, provider: "compatible", base_url: "https://api.openai.com/v1" },
    hardware: { ram_gb: 32, gpu: null, binary_path: "" },
    loaded: false,
  });
  render(<ModelsPage onClose={() => {}} initialTab="chat" />);
  await waitFor(() => expect(panel("API keys").hidden).toBe(false));
  expect(nav().getByRole("button", { name: /API keys/ }).textContent).toContain("In use");
});

it("counts a server on this computer or network as your own server", async () => {
  aiMock.status.mockResolvedValue({
    config: { ...CONFIG, provider: "compatible", base_url: "http://127.0.0.1:11434/v1" },
    hardware: { ram_gb: 32, gpu: null, binary_path: "" },
    loaded: false,
  });
  render(<ModelsPage onClose={() => {}} />);
  await waitFor(() => expect(panel("Your own server").hidden).toBe(false));
  expect(nav().getByRole("button", { name: /Your own server/ }).textContent).toContain("In use");
});

it("keeps an unsaved change when switching sections and saves it once", async () => {
  render(<ModelsPage onClose={() => {}} initialTab="chat" />);
  expect(screen.queryByLabelText(/GPU layers/)).toBeNull();
  const advanced = await screen.findByRole("switch", { name: "I’m a proper geek" });
  expect(advanced.getAttribute("aria-checked")).toBe("false");
  // The first thing in the local card, above the starter models.
  expect(
    advanced.compareDocumentPosition(screen.getByText("starter-models")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(advanced);
  expect(advanced.getAttribute("aria-checked")).toBe("true");
  expect(within(panel("On this computer")).getByText("engine:llama")).toBeTruthy();
  expect(within(panel("On this computer")).getByText("library:chat")).toBeTruthy();
  fireEvent.change(await screen.findByLabelText(/GPU layers/), { target: { value: "20" } });
  // Leave and come back: the panels stay mounted, so the draft must survive.
  open(/Speech/);
  open(/Documents/);
  open(/On this computer/);
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
  expect(within(panel("Speech")).getByText("/opt/whisper-server")).toBeTruthy();
  expect(within(panel("Speech")).getByText(/Speech to text runs a build of your own/)).toBeTruthy();
  expect(within(panel("Documents")).getByText("/opt/llama-server")).toBeTruthy();
  // …and no input: it is a statement, not a setting.
  expect(screen.queryByLabelText(/executable/i)).toBeNull();
});

it("switches chat to Graite Cloud only when asked, and saves the picked model", async () => {
  render(<ModelsPage onClose={() => {}} initialTab="graite" />);
  await screen.findByText("pick-graite-fast");
  // Looking at the section does not change which model chat uses.
  const section = within(panel("Graite Cloud"));
  expect(section.getByText(/Chat uses On this computer now/)).toBeTruthy();
  fireEvent.click(section.getByRole("button", { name: "Use for chat" }));
  expect(section.getByText(/Chat uses this once you save/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(await screen.findByText(/choose a Graite Cloud model first/)).toBeTruthy();
  expect(aiMock.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("pick-graite-fast"));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() =>
    expect(aiMock.save).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "graite", model: "graite/fast", saved_model_id: null }),
    ),
  );
});

it("edits your name and the appearance under General", async () => {
  render(<ModelsPage onClose={() => {}} initialTab="general" />);
  const name = (await screen.findByLabelText(/First name/)) as HTMLInputElement;
  await waitFor(() => expect(name.value).toBe("Sam"));
  fireEvent.change(name, { target: { value: "Samira" } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await waitFor(() =>
    expect(profileMock.saveProfile).toHaveBeenCalledWith({ first_name: "Samira" }),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Light" }));
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  // The model settings are not this section's business: no Save bar here.
  expect(
    (
      screen.getByRole("button", { name: "Save settings", hidden: true })
        .parentElement as HTMLElement
    ).hidden,
  ).toBe(true);
});
