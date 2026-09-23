import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AudioPlayer } from "./AudioPlayer";
import { readableTranscript } from "./transcript";
afterEach(cleanup);
it("does not show buffering for paused files and clears it when playback resumes", () => {
  const { container } = render(<AudioPlayer src="blob:test" name="Voice note" />);
  const audio = container.querySelector("audio")!;
  fireEvent.waiting(audio);
  expect(screen.queryByRole("status")).toBeNull();
  Object.defineProperty(audio, "paused", { value: false, configurable: true });
  fireEvent.play(audio);
  fireEvent.waiting(audio);
  expect(screen.getByRole("status").textContent).toBe("Buffering…");
  fireEvent.playing(audio);
  expect(screen.queryByRole("status")).toBeNull();
});
it("seeks and pauses using accessible controls without native dragging", () => {
  const { container } = render(<AudioPlayer src="blob:test" name="Voice note" />);
  const audio = container.querySelector("audio")!;
  Object.defineProperty(audio, "duration", { value: 120 });
  Object.defineProperty(audio, "paused", { value: false });
  audio.pause = vi.fn();
  fireEvent.loadedMetadata(audio);
  fireEvent.change(screen.getByRole("slider"), { target: { value: "250" } });
  expect(audio.currentTime).toBe(30);
  fireEvent.play(audio);
  fireEvent.click(screen.getByRole("button", { name: "Pause Voice note" }));
  expect(audio.pause).toHaveBeenCalledOnce();
  expect(audio.draggable).toBe(false);
});
it("adds paragraph breaks to existing transcripts without changing their words", () => {
  const text = Array(60).fill("A short sentence.").join(" ");
  const result = readableTranscript(text);
  expect(result.split(/\s+/)).toEqual(text.split(/\s+/));
  expect(result.split("\n\n").length).toBeGreaterThan(2);
});
