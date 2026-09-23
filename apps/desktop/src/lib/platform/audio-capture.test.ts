import { expect, it } from "vitest";
import { Downsampler, Framer, rms } from "./audio-capture";

it("downsamples 48 kHz to 16 kHz by averaging, across chunk boundaries", () => {
  const down = new Downsampler(48000);
  const first = down.push(Float32Array.from([0.3, 0.3, 0.3, 0.6, 0.6]));
  const second = down.push(Float32Array.from([0.6, 0.9, 0.9, 0.9]));
  expect(Array.from(first).map((v) => +v.toFixed(3))).toEqual([0.3]);
  expect(Array.from(second).map((v) => +v.toFixed(3))).toEqual([0.6, 0.9]);
});

it("passes 16 kHz audio through untouched", () => {
  const input = Float32Array.from([0.1, -0.2]);
  expect(new Downsampler(16000).push(input)).toBe(input);
});

it("handles rates that are not a multiple of 16 kHz", () => {
  const down = new Downsampler(44100);
  let total = 0;
  for (let i = 0; i < 10; i++) total += down.push(new Float32Array(4410)).length;
  expect(Math.abs(total - 16000)).toBeLessThanOrEqual(1);
});

it("emits fixed 40 ms little-endian frames and clips loud samples", () => {
  const frames: Int16Array[] = [];
  const framer = new Framer();
  framer.push(new Float32Array(1000).fill(2), (f) => frames.push(f));
  expect(frames).toHaveLength(1);
  framer.push(new Float32Array(300).fill(-2), (f) => frames.push(f));
  expect(frames).toHaveLength(2);
  expect(frames[0].length).toBe(640);
  expect(frames[0][0]).toBe(32767);
  expect(frames[1][639]).toBe(-32768);
});

it("measures loudness", () => {
  expect(rms(new Float32Array(0))).toBe(0);
  expect(rms(Float32Array.from([0.5, -0.5]))).toBeCloseTo(0.5);
});
