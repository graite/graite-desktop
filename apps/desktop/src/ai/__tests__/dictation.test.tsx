import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({
  microphone: vi.fn(),
  request: vi.fn(),
  error: vi.fn(),
  stopTrack: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@/lib/platform", () => ({ platform: { microphone: mocks.microphone } }));
vi.mock("@/lib/api", () => ({ request: mocks.request }));
vi.mock("sonner", () => ({ toast: { error: mocks.error, info: vi.fn() } }));
vi.mock("@/lib/platform/audio-recorder", () => ({
  AudioRecorder: class {
    onstop: (() => void) | null = null;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    async start() {}
    stop() {
      mocks.stop();
      this.ondataavailable?.({ data: new Blob(["audio"]) });
      this.onstop?.();
    }
  },
}));
import { DictationButton, WHISPER_UNAVAILABLE } from "../DictationButton";
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("explains missing Whisper without asking for microphone permission", () => {
  render(
    <DictationButton
      available={false}
      busy={false}
      value=""
      onChange={vi.fn()}
      onWorking={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
  expect(mocks.microphone).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith(WHISPER_UNAVAILABLE, { position: "bottom-right" });
});
it("transcribes locally, appends to the latest draft, and releases the microphone", async () => {
  mocks.microphone.mockResolvedValue({ getTracks: () => [{ stop: mocks.stopTrack }] });
  mocks.request.mockResolvedValue({ text: "dictated words" });
  const onChange = vi.fn();
  const onWorking = vi.fn();
  const view = render(
    <DictationButton
      available
      busy={false}
      value="Original"
      onChange={onChange}
      onWorking={onWorking}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
  await screen.findByRole("button", { name: "Stop dictation" });
  view.rerender(
    <DictationButton
      available
      busy={false}
      value="Edited"
      onChange={onChange}
      onWorking={onWorking}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith("Edited dictated words"));
  expect(mocks.request.mock.calls[0][0]).toBe("/api/v1/ai/speech/check");
  expect(mocks.stopTrack).toHaveBeenCalled();
  expect(onWorking).toHaveBeenLastCalledWith(false);
});
it("releases the microphone without transcribing when leaving the composer", async () => {
  mocks.microphone.mockResolvedValue({ getTracks: () => [{ stop: mocks.stopTrack }] });
  const view = render(
    <DictationButton available busy={false} value="" onChange={vi.fn()} onWorking={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
  await screen.findByRole("button", { name: "Stop dictation" });
  view.unmount();
  expect(mocks.stopTrack).toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});
