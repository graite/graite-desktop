/** The microphone is requested only after the user explicitly presses Start recording. */
export async function microphone(
  options: { voice?: boolean; deviceId?: string; rearm?: () => Promise<void> } = {},
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "Microphone recording is unavailable in this webview. You can still upload a recording.",
    );
  }
  // Prefer a requested input without requiring it to still be connected.
  const device = options.deviceId ? { deviceId: { ideal: options.deviceId } } : {};
  if (options.voice || options.deviceId) {
    // A conversation plays the assistant's voice while the microphone is open: ask for echo
    // cancellation, and accept the plain microphone where the webview refuses the request.
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          ...device,
          ...(options.voice
            ? {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
              }
            : {}),
        },
        video: false,
      });
    } catch (e) {
      if ((e as DOMException).name === "NotAllowedError" && !options.rearm) throw e;
      await options.rearm?.();
    }
  }
  // Let the device choose its native capture settings. WebKitGTK can reject optional
  // echoCancellation/noiseSuppression constraints before it even opens the microphone.
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (error) {
    // WebKitGTK reports an empty device list as OverconstrainedError("Invalid constraint"),
    // even for audio:true. A Bluetooth headset in playback-only mode produces exactly this.
    const name = (error as DOMException).name;
    if (name === "OverconstrainedError" || name === "NotFoundError") {
      let missing = name === "NotFoundError";
      try {
        if (navigator.mediaDevices.enumerateDevices) {
          missing = !(await navigator.mediaDevices.enumerateDevices()).some(
            (d) => d.kind === "audioinput",
          );
        }
      } catch {
        /* Device enumeration can be unavailable until permission is granted. */
      }
      throw new Error(
        missing
          ? "No microphone input is available. In your computer’s Sound settings, select a microphone. For Bluetooth headphones, choose Headset / Hands-Free mode instead of playback-only mode, then try Talk again."
          : "The microphone could not be opened. Check the input device in your computer’s Sound settings, then try again.",
      );
    }
    throw error;
  }
}

/** Whether the open microphone really cancels echo (voice interruption is safe on speakers). */
export function cancelsEcho(stream: MediaStream): boolean {
  const track = stream.getAudioTracks()[0];
  return track?.getSettings?.().echoCancellation === true;
}
