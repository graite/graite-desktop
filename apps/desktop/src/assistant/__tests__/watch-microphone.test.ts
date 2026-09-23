import { afterEach, describe, expect, it, vi } from "vitest";
import { watchMicrophone } from "../useVoiceSession";

class FakeTrack extends EventTarget {}

function devices(list: MediaDeviceInfo[]) {
  const target = new EventTarget() as EventTarget & {
    enumerateDevices: () => Promise<MediaDeviceInfo[]>;
  };
  target.enumerateDevices = () => Promise.resolve(list);
  Object.defineProperty(navigator, "mediaDevices", { value: target, configurable: true });
  return target;
}

afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
});

describe("watchMicrophone", () => {
  it("reports an ended track once, and nothing after cleanup", () => {
    devices([]);
    const track = new FakeTrack();
    const lost = vi.fn();
    const stop = watchMicrophone(track as unknown as MediaStreamTrack, lost);
    track.dispatchEvent(new Event("ended"));
    track.dispatchEvent(new Event("ended"));
    expect(lost).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reports when the last input disappears, not when another remains", async () => {
    const list = [{ kind: "audioinput" } as MediaDeviceInfo];
    const media = devices(list);
    const lost = vi.fn();
    const stop = watchMicrophone(new FakeTrack() as unknown as MediaStreamTrack, lost);
    media.dispatchEvent(new Event("devicechange"));
    await Promise.resolve();
    await Promise.resolve();
    expect(lost).not.toHaveBeenCalled();
    list.length = 0;
    media.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
    stop();
  });
});
