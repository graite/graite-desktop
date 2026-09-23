import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { Recorder } from "./Recorder";
import { platform } from "@/lib/platform";

vi.mock("@/lib/platform", () => ({ platform: { microphone: vi.fn() } }));
const stopped = vi.fn();
class FakeRecorder {
  static isTypeSupported = () => true;
  mimeType = "audio/webm";
  state = "inactive";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(["captured audio"], { type: this.mimeType }) });
      this.onstop?.();
    });
  }
}
beforeEach(() => {
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  URL.createObjectURL = vi.fn(() => "blob:recording");
  URL.revokeObjectURL = vi.fn();
  vi.mocked(platform.microphone).mockResolvedValue({
    getTracks: () => [{ stop: stopped }],
  } as unknown as MediaStream);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("requests microphone only on start and saves audio when stopped", async () => {
  const save = vi.fn(async () => {});
  render(<Recorder onSave={save} />);
  expect(platform.microphone).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Start recording"));
  await screen.findByText(/Stop & save/);
  fireEvent.click(screen.getByText(/Stop & save/));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]).toEqual([expect.any(Blob), expect.stringMatching(/\.webm$/)]);
  expect(stopped).toHaveBeenCalled();
});
it("keeps a failed upload available for retry and download", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(undefined);
  render(<Recorder onSave={save} />);
  fireEvent.click(screen.getByText("Start recording"));
  fireEvent.click(await screen.findByText(/Stop & save/));
  await screen.findByRole("alert");
  expect(screen.getByText("Download recording")).toBeTruthy();
  fireEvent.click(screen.getByText("Retry saving"));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
});
it("stops the microphone and preserves captured audio on navigation", async () => {
  const save = vi.fn(async () => {});
  const { unmount } = render(<Recorder onSave={save} />);
  fireEvent.click(screen.getByText("Start recording"));
  await screen.findByText(/Stop & save/);
  await act(async () => unmount());
  expect(stopped).toHaveBeenCalled();
  expect(save).toHaveBeenCalledTimes(1);
});
