import { useState } from "react";
import { request } from "@/lib/api";

export function SpeechCheck({ disabled }: { disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="ai-speech-check">
      <label className="ai-field">
        Try a recording
        <input
          type="file"
          accept=".wav,audio/wav"
          disabled={disabled || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setError("");
            setText("");
            if (file.size > 30_000_000) {
              setError("Choose a WAV recording smaller than 30 MB.");
              return;
            }
            setBusy(true);
            void request<{ text: string; seconds: number }>("/api/v1/ai/speech/check", {
              method: "POST",
              body: file,
              headers: { "Content-Type": "audio/wav" },
            })
              .then((result) => setText(result.text || "No speech detected."))
              .catch((e: Error) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        />
        <small>16-bit WAV · up to 5 minutes · transcribed on this computer</small>
      </label>
      {busy && <p role="status">Listening to your recording…</p>}
      {error && (
        <p role="alert" className="ai-error">
          {error}
        </p>
      )}
      {text && (
        <div className="ai-transcript" role="status">
          {text}
        </div>
      )}
    </div>
  );
}
