import { useEffect, useState } from "react";
import { Hand, Mic, MicOff, PhoneOff, Settings2, Speech } from "lucide-react";
import { Button } from "@/components/ui/button";
import { voice as voiceApi, type VoiceStatus } from "@/lib/voice";
import type { useVoiceSession } from "./useVoiceSession";

const LABELS: Record<string, string> = {
  connecting: "Opening the microphone…",
  loading: "Waking up voice, this takes a few seconds…",
  listening: "Listening",
  transcribing: "Got it…",
  thinking: "Thinking…",
  speaking: "Speaking",
};

/** The talk controls above the message box: start a voice conversation, see its state,
 * interrupt, mute, end. */
export function VoiceBar({
  name,
  session,
  disabled,
  onStart,
  onSettings,
  settingsVersion,
}: {
  /** Opens Settings; with "voice" it lands on the Voice tab (microphone test). */
  name: string;
  session: ReturnType<typeof useVoiceSession>;
  disabled: boolean;
  onStart: () => void;
  onSettings: (tab?: "voice") => void;
  settingsVersion: number;
}) {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const { phase, active, level, userSpeaking, checking, silent, muted, bargeIn, echoSafe } =
    session;
  useEffect(() => {
    if (!active)
      void voiceApi
        .status()
        .then(setStatus)
        .catch(() => setStatus(null));
  }, [active, settingsVersion]);
  useEffect(() => {
    if (phase !== "speaking" && phase !== "thinking") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.code !== "Space" || target?.closest("textarea, input, [contenteditable=true]"))
        return;
      event.preventDefault();
      session.interrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, session]);

  if (!active) {
    const missing = status && !status.ready ? (status.missing ?? []) : [];
    return (
      <div className="voice-bar" data-idle>
        <Button
          size="sm"
          className="voice-start"
          disabled={disabled || !!missing.length}
          onClick={onStart}
        >
          <Mic size={15} /> Talk to {name}
        </Button>
        {!!missing.length && (
          <button
            className="voice-missing"
            onClick={() => onSettings("voice")}
            title={missing.map((m) => m.text).join("\n")}
          >
            <Settings2 size={13} /> Voice needs setting up: {missing[0].text}
            {missing.length > 1 ? ` (+${missing.length - 1})` : ""}
          </button>
        )}
        {session.error && (
          <span className="voice-error" role="alert">
            {session.error}
          </span>
        )}
      </div>
    );
  }
  const last = session.lines[session.lines.length - 1];
  return (
    <div className="voice-bar" data-phase={phase}>
      <div
        className="voice-orb"
        data-phase={phase}
        data-speaking={userSpeaking || undefined}
        style={{ ["--level" as string]: phase === "listening" && !muted ? level.toFixed(2) : "0" }}
        aria-hidden
      />
      <div className="voice-state" aria-live="polite">
        <strong>
          {muted && phase === "listening"
            ? "Muted"
            : checking
              ? "Listening to you…"
              : (LABELS[phase] ?? phase)}
        </strong>
        {session.status ? (
          <small className="ai-shimmer">{session.status}</small>
        ) : (
          <small>
            {last
              ? `${last.role === "user" ? "You" : name}: ${last.text}`
              : phase === "listening"
                ? "Say something. Pauses are fine, I wait until you are done."
                : ""}
          </small>
        )}
      </div>
      {(phase === "speaking" || phase === "thinking") && (
        <Button variant="ghost" size="sm" onClick={session.interrupt} title="Interrupt (Space)">
          <Hand size={14} /> Interrupt
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-pressed={bargeIn}
        title={
          bargeIn
            ? `Interrupt by speaking is on: just start talking.${echoSafe ? "" : " Loud speakers can drown you out; the Interrupt button always works."}`
            : "Interrupt by speaking is off: use the Interrupt button or Space."
        }
        aria-label="Interrupt by speaking"
        onClick={() => session.setBargeIn(!bargeIn)}
      >
        <Speech size={15} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-pressed={muted}
        title={muted ? "Unmute" : "Mute"}
        aria-label={muted ? "Unmute" : "Mute"}
        onClick={session.toggleMute}
      >
        {muted ? <MicOff size={15} /> : <Mic size={15} />}
      </Button>
      <Button variant="ghost" size="sm" onClick={session.stop}>
        <PhoneOff size={14} /> End
      </Button>
      {session.error && (
        <span className="voice-error" role="alert">
          {session.error}
        </span>
      )}
      {silent && phase === "listening" && !muted && (
        <button className="voice-silent" role="alert" onClick={() => onSettings("voice")}>
          {silent === "silence"
            ? "Your microphone is sending only silence. A Bluetooth headset may be in music mode; pick its headset microphone or another input."
            : "Your microphone is not sending anything."}{" "}
          Check it in Settings
        </button>
      )}
    </div>
  );
}
