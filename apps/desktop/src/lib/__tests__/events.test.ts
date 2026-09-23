import { afterEach, expect, it, vi } from "vitest";
const platform = vi.hoisted(() => ({ getDaemonInfo: vi.fn() }));
vi.mock("../platform", () => ({ platform }));
import { connectEvents } from "../api";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("does not connect an unmounted subscriber after service startup", async () => {
  let ready!: (value: { url: string; token: string }) => void;
  platform.getDaemonInfo.mockReturnValue(
    new Promise((resolve) => {
      ready = resolve;
    }),
  );
  const socket = vi.fn();
  vi.stubGlobal("WebSocket", socket);
  const dispose = connectEvents(vi.fn());
  dispose();
  ready({ url: "http://localhost:1234", token: "test" });
  await Promise.resolve();
  expect(socket).not.toHaveBeenCalled();
});
it("retries failed startup and cancels retry on disposal", async () => {
  vi.useFakeTimers();
  platform.getDaemonInfo.mockRejectedValue(new Error("Starting"));
  const dispose = connectEvents(vi.fn());
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(500);
  expect(platform.getDaemonInfo).toHaveBeenCalledTimes(2);
  dispose();
  await vi.advanceTimersByTimeAsync(10000);
  expect(platform.getDaemonInfo).toHaveBeenCalledTimes(2);
});
