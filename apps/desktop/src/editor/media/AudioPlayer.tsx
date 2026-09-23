import { useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useDismissableLayerSurface } from "@radix-ui/react-dismissable-layer";

const time = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Local files are already fetched before mounting: paused audio is ready, not buffering. */
export function AudioPlayer({ src, name = "Recording" }: { src: string; name?: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  // The stopped mousedown would otherwise keep open popovers from closing.
  const dismissSurface = useDismissableLayerSurface();
  const metadata = () => {
    const value = audio.current?.duration;
    if (value && Number.isFinite(value)) setDuration(value);
  };
  const toggle = async () => {
    if (!audio.current) return;
    if (!audio.current.paused) {
      audio.current.pause();
      return;
    }
    setError("");
    try {
      await audio.current.play();
    } catch {
      setWaiting(false);
      setError("This audio could not be played. Try downloading the original file.");
    }
  };
  return (
    <div
      ref={dismissSurface}
      className="graite-audio"
      draggable={false}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <audio
        ref={audio}
        src={src}
        preload="auto"
        draggable={false}
        onLoadedMetadata={metadata}
        onDurationChange={metadata}
        onTimeUpdate={() => setPosition(audio.current?.currentTime ?? 0)}
        onPlay={() => setPlaying(true)}
        onPlaying={() => setWaiting(false)}
        onWaiting={() => {
          if (!audio.current?.paused) setWaiting(true);
        }}
        onCanPlay={() => setWaiting(false)}
        onPause={() => {
          setPlaying(false);
          setWaiting(false);
        }}
        onEnded={() => {
          setPlaying(false);
          setWaiting(false);
        }}
        onError={() => {
          setPlaying(false);
          setWaiting(false);
          setError("This audio format could not be played. Download the original to listen.");
        }}
      />
      <button
        type="button"
        className="audio-play"
        aria-label={`${playing ? "Pause" : "Play"} ${name}`}
        onClick={() => void toggle()}
      >
        {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
      </button>
      <input
        type="range"
        aria-label={`Seek ${name}`}
        min={0}
        max={1000}
        step={1}
        style={{
          background: `linear-gradient(to right, #303234 ${duration ? Math.min(100, (position / duration) * 100) : 0}%, #dedede 0)`,
        }}
        value={duration ? Math.min(1000, (position / duration) * 1000) : 0}
        disabled={!duration}
        onChange={(e) => {
          const value = (Number(e.target.value) / 1000) * duration;
          if (audio.current) audio.current.currentTime = value;
          setPosition(value);
        }}
      />
      <span className="audio-time">
        {time(position)}
        {duration ? ` / ${time(duration)}` : ""}
      </span>
      {waiting && playing && <small role="status">Buffering…</small>}
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
