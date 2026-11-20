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

it("lists Graite Cloud first and Local AI as one tab per task", async () => {
  render(<ModelsPage onClose={() => {}} />);
  await screen.findByText("starter-models");
  const labels = () =>
    nav()
      .getAllByRole("button")
      .map((b) => b.textContent?.replace("In use", "").trim());
  expect(labels()).toEqual([
    "General",
    "Graite Cloud",
    "Sync devices",
    "AI connectors",
    "API keys",
    "Chat",
    "Search",
    "Documents",
    "Speech",
  ]);
  for (const title of ["Graite", "Your AI apps", "Your own keys", "Local AI"])
    expect(nav().getByText(title)).toBeTruthy();
  // Chat runs on this computer, so Settings opens there and marks it.
  expect(panel("Chat").hidden).toBe(false);
  expect(nav().getByRole("button", { name: /^Chat/ }).textContent).toContain("In use");
  expect(nav().getByRole("button", { name: /Graite Cloud/ }).textContent).not.toContain("In use");
  // Beginners see the starter models; engine and full library wait for geek mode.
  expect(within(panel("Chat")).getByText("starter-models")).toBeTruthy();
  expect(within(panel("Chat")).queryByText("engine:llama")).toBeNull();
  expect(within(panel("Chat")).queryByText("library:chat")).toBeNull();
  // Talking with the assistant needs the local voice engine whichever way speech runs.
  expect(within(panel("Speech")).getByText("library:vad,turn,tts")).toBeTruthy();
  expect(within(panel("Speech")).getByText("engine:crispasr")).toBeTruthy();
  expect(within(panel("Search")).getByText("library:embedding")).toBeTruthy();
  expect(within(panel("AI connectors")).getByText("connectors-card")).toBeTruthy();
  expect(within(panel("General")).getByText("vault-card")).toBeTruthy();
  // Geek mode lives under General and adds "Your own server" to the sidebar.
  fireEvent.click(
    within(panel("General")).getByRole("switch", { name: "I’m a proper geek", hidden: true }),
  );
  expect(labels()).toContain("Your own server");
  expect(within(panel("Chat")).getByText("engine:llama")).toBeTruthy();
});

it("runs documents and speech in Graite Cloud until local AI is switched on", async () => {
  aiMock.status.mockResolvedValue({
    config: { ...CONFIG, ocr_provider: "auto", stt_provider: "auto" },
    hardware: { ram_gb: 32, gpu: null, binary_path: "" },
    loaded: false,
    ocr_source: "graite",
    speech_source: "graite",
    cloud_signed_in: true,
  });
  render(<ModelsPage onClose={() => {}} initialTab="documents" />);
  await screen.findByText("voices-card");
  const documents = within(panel("Documents"));
  expect(await documents.findByText(/Documents are read through Graite Cloud/)).toBeTruthy();
  expect(documents.queryByText("library:ocr")).toBeNull();
  const toggle = documents.getByRole("switch", { name: "Read everything in-house" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  expect(documents.getByText("library:ocr")).toBeTruthy();
  // OCR reports the chat engine rather than mounting a second, competing engine card.
  expect(await documents.findByText(/Uses the chat engine — already downloaded/)).toBeTruthy();
  expect(within(panel("Speech")).queryByText("library:speech")).toBeNull();
  expect(
    within(panel("Speech")).getByText(/Speech to text runs through Graite Cloud/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(aiMock.save).toHaveBeenCalledTimes(1));
  expect(aiMock.save.mock.calls[0][0]).toMatchObject({ ocr_provider: "local" });
  expect(aiMock.save.mock.calls[0][0].stt_provider).toBe("auto");
});

it("offers to sign in when Graite Cloud would do the work but nobody is signed in", async () => {
  aiMock.status.mockResolvedValue({
    config: { ...CONFIG, stt_provider: "graite" },
    hardware: { ram_gb: 32, gpu: null, binary_path: "" },
    loaded: false,
    speech_source: null,
    cloud_signed_in: false,
  });
  render(<ModelsPage onClose={() => {}} initialTab="voice" />);
  await screen.findByText("voices-card");
  const speech = within(panel("Speech"));
  fireEvent.click(await speech.findByRole("button", { name: "Sign in to Graite Cloud" }));
  expect(panel("Graite Cloud").hidden).toBe(false);
});

it("starts every section at its top", async () => {
  render(<ModelsPage onClose={() => {}} initialTab="voice" />);
  await screen.findByText("voices-card");
  const scroller = screen.getByRole("region", { name: "Settings" });
  scroller.scrollTop = 500;
  open(/Documents/);
  expect(scroller.scrollTop).toBe(0);
});

it("tells you to refresh the connector's tools after an update", async () => {
  render(<ModelsPage onClose={() => {}} initialTab="connectors" />);
  await screen.findByText("connectors-card");
  expect(within(panel("AI connectors")).getByText(/refresh the tools/)).toBeTruthy();
  expect(within(panel("AI connectors")).getByText(/Claude, ChatGPT, Gemini/)).toBeTruthy();
});

it("keeps search on this computer and explains why", async () => {
  render(<ModelsPage onClose={() => {}} initialTab="search" />);
  await screen.findByText("index-card");
  const search = within(panel("Search"));
  expect(search.queryByRole("switch", { name: "Use local AI on my computer" })).toBeNull();
  expect(search.getByText(/It runs here, on this computer/)).toBeTruthy();
  expect(search.getByText(/Recommended: download the search model/)).toBeTruthy();
});

it("explains every section the same way before its controls", async () => {
  render(<ModelsPage onClose={() => {}} />);
  await screen.findByText("starter-models");
  for (const name of [
    "Chat",
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
    // One card: the page's icon, a title and a line or two. No table of questions.
    const card = section.getByRole("heading", { level: 1, name, hidden: true }).closest("header");
    expect(card?.querySelector("p")?.textContent?.length).toBeGreaterThan(20);
    expect(card?.querySelectorAll("svg").length).toBe(1);
    expect(section.queryByText("Leaves this computer")).toBeNull();
  }
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
  expect(panel("Chat").hidden).toBe(true);
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
  await screen.findByText("starter-models");
  expect(screen.queryByLabelText(/GPU layers/)).toBeNull();
  const advanced = within(panel("General")).getByRole("switch", {
    name: "I’m a proper geek",
    hidden: true,
  });
  expect(advanced.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(advanced);
  expect(advanced.getAttribute("aria-checked")).toBe("true");
  expect(within(panel("Chat")).getByText("engine:llama")).toBeTruthy();
  expect(within(panel("Chat")).getByText("library:chat")).toBeTruthy();
  fireEvent.change(await screen.findByLabelText(/GPU layers/), { target: { value: "20" } });
  // Leave and come back: the panels stay mounted, so the draft must survive.
  open(/Speech/);
  open(/Documents/);
  open(/^Chat/);
  expect((screen.getByLabelText(/GPU layers/) as HTMLInputElement).value).toBe("20");
  fireEvent.click(screen.getByRole("checkbox", { name: /Keep ready for the next question/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(aiMock.save).toHaveBeenCalledTimes(1));
  expect(aiMock.save.mock.calls[0][0]).toMatchObject({ gpu_layers: 20, resident: false });
});

it("switches chat to Graite Cloud from the Chat tab's local switch", async () => {
  render(<ModelsPage onClose={() => {}} initialTab="chat" />);
  await screen.findByText("starter-models");
  const chat = within(panel("Chat"));
  const toggle = chat.getByRole("switch", { name: "Use local AI on my computer" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  expect(chat.queryByText("starter-models")).toBeNull();
  expect(chat.getByText(/Your chats use Graite Cloud once you save/)).toBeTruthy();
});

it("shows your own whisper-server only in geek mode, without asking anyone to use Homebrew", async () => {
  aiMock.status.mockResolvedValue({
    config: CONFIG,
    hardware: { ram_gb: 32, gpu: null, binary_path: "" },
    loaded: false,
    whisper_binary: "/app/bin/crispasr",
  });
  render(<ModelsPage onClose={() => {}} initialTab="voice" />);
  await screen.findByText("voices-card");
  expect(screen.queryByLabelText(/Your own whisper-server/)).toBeNull();
  expect(screen.queryByText(/brew/)).toBeNull();
  fireEvent.click(
    within(panel("General")).getByRole("switch", { name: "I’m a proper geek", hidden: true }),
  );
  const field = within(panel("Speech")).getByLabelText(/Your own whisper-server/);
  expect(
    within(panel("Speech")).getByText(/Speech to text runs \/app\/bin\/crispasr/),
  ).toBeTruthy();
  fireEvent.change(field, { target: { value: "/opt/whisper.cpp/whisper-server" } });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(aiMock.save).toHaveBeenCalledTimes(1));
  expect(aiMock.save.mock.calls[0][0]).toMatchObject({
    provider: "local",
    whisper_binary_path: "/opt/whisper.cpp/whisper-server",
  });
  expect(await screen.findByText("Settings saved.")).toBeTruthy();
});

it("saves speech settings while the chat model choice is unfinished, and keeps a newer chat model", async () => {
  // Chat was pointed at a connection without a saved model; meanwhile the composer's model
  // picker saved another model. Saving the Speech page must do neither harm.
  aiMock.status.mockResolvedValueOnce({
    config: { ...CONFIG, provider: "compatible", saved_model_id: null },
    hardware: { ram_gb: 32, gpu: null, binary_path: "" },
    loaded: false,
  });
  aiMock.status.mockResolvedValue({
    config: { ...CONFIG, provider: "compatible", saved_model_id: "picked-in-composer" },
    hardware: { ram_gb: 32, gpu: null, binary_path: "" },
    loaded: false,
  });
  localStorage.setItem("graite.techMode", "1");
  render(<ModelsPage onClose={() => {}} initialTab="voice" />);
  await screen.findByText("voices-card");
  fireEvent.change(within(panel("Speech")).getByLabelText(/Your own whisper-server/), {
    target: { value: "/opt/whisper-server" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(aiMock.save).toHaveBeenCalledTimes(1));
  expect(aiMock.save.mock.calls[0][0]).toMatchObject({
    saved_model_id: "picked-in-composer",
    whisper_binary_path: "/opt/whisper-server",
  });
});

it("still says so when a stored path overrides the OCR engine Graite installed", async () => {
  // Set outside the app (an .env). Invisible is worse than read-only: it changes what runs.
  aiMock.status.mockResolvedValue({
    config: { ...CONFIG, ocr_binary_path: "/opt/llama-server", ocr_provider: "local" },
    hardware: { ram_gb: 32, gpu: null, binary_path: "" },
    loaded: false,
  });
  render(<ModelsPage onClose={() => {}} initialTab="voice" />);
  await screen.findByText("voices-card");
  expect(within(panel("Documents")).getByText("/opt/llama-server")).toBeTruthy();
});

it("switches chat to Graite Cloud only when asked, and saves the picked model", async () => {
  render(<ModelsPage onClose={() => {}} initialTab="graite" />);
  await screen.findByText("pick-graite-fast");
  // Looking at the section does not change which model chat uses.
  const section = within(panel("Graite Cloud"));
  expect(section.getByText(/Your chats use a model on this computer now/)).toBeTruthy();
  fireEvent.click(section.getByRole("button", { name: "Chat with Graite Cloud" }));
  expect(section.getByText(/Your chats use Graite Cloud once you save/)).toBeTruthy();
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
