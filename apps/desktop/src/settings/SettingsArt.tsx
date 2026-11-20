import type { ReactNode } from "react";

export type ArtName =
  | "general"
  | "chat"
  | "search"
  | "documents"
  | "speech"
  | "server"
  | "cloud"
  | "sync"
  | "connectors"
  | "keys";

/** What a shape is filled with so it covers the soft disc behind it: the card's own colour. */
const BG = "var(--settings-art-bg, var(--background))";

const ART: Record<ArtName, ReactNode> = {
  // Sliders: the small settings that make it yours.
  general: (
    <>
      <circle cx="32" cy="32" r="28" fill="currentColor" fillOpacity=".06" stroke="none" />
      <path d="M16 22h32M16 32h32M16 42h32" strokeOpacity=".35" />
      <circle cx="26" cy="22" r="4" fill={BG} />
      <circle cx="40" cy="32" r="4" fill={BG} />
      <circle cx="22" cy="42" r="4" fill={BG} />
    </>
  ),
  // A speech bubble, mid-answer.
  chat: (
    <>
      <circle cx="32" cy="32" r="28" fill="currentColor" fillOpacity=".06" stroke="none" />
      <path
        d="M19 18h26a5 5 0 0 1 5 5v15a5 5 0 0 1-5 5H31l-8 6v-6h-4a5 5 0 0 1-5-5V23a5 5 0 0 1 5-5z"
        fill={BG}
      />
      <circle cx="25" cy="30.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="32" cy="30.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="39" cy="30.5" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  // A magnifier over a few lines.
  search: (
    <>
      <circle cx="32" cy="32" r="28" fill="currentColor" fillOpacity=".06" stroke="none" />
      <circle cx="29" cy="29" r="12" fill={BG} />
      <path d="M38 38l10 10" />
      <path d="M23.5 26.5h11M23.5 31.5h7" strokeOpacity=".4" />
    </>
  ),
  // A page with a scan line across it.
  documents: (
    <>
      <circle cx="32" cy="32" r="28" fill="currentColor" fillOpacity=".06" stroke="none" />
      <path d="M22 14h14l8 8v26a2 2 0 0 1-2 2H22a2 2 0 0 1-2-2V16a2 2 0 0 1 2-2z" fill={BG} />
      <path d="M36 14v8h8" />
      <path d="M26 38h12M26 43h8" strokeOpacity=".4" />
      <path d="M13 31h38" />
    </>
  ),
  // A sound wave.
  speech: (
    <>
      <circle cx="32" cy="32" r="28" fill="currentColor" fillOpacity=".06" stroke="none" />
      <path d="M14 30v4M20 25v14M26 19v26M32 23v18M38 16v32M44 26v12M50 30v4" />
    </>
  ),
  // Two stacked machines, lights on.
  server: (
    <>
      <circle cx="32" cy="32" r="28" fill="currentColor" fillOpacity=".06" stroke="none" />
      <rect x="15" y="17" width="34" height="13" rx="3.5" fill={BG} />
      <rect x="15" y="34" width="34" height="13" rx="3.5" fill={BG} />
      <circle cx="21.5" cy="23.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="21.5" cy="40.5" r="1.4" fill="currentColor" stroke="none" />
      <path d="M36 23.5h7M36 40.5h7" strokeOpacity=".4" />
    </>
  ),
  // A cloud with a spark.
  cloud: (
    <>
      <circle cx="32" cy="32" r="28" fill="currentColor" fillOpacity=".06" stroke="none" />
      <path
        d="M23 44a8.5 8.5 0 0 1-1.2-16.9A11.5 11.5 0 0 1 43.6 25 9.5 9.5 0 0 1 42 44z"
        fill={BG}
      />
      <path
        d="M32 29.5l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z"
        fill="currentColor"
        stroke="none"
      />
    </>
  ),
  // Two devices and the round trip between them.
  sync: (
    <>
      <circle cx="32" cy="32" r="28" fill="currentColor" fillOpacity=".06" stroke="none" />
      <rect x="11" y="24" width="16" height="16" rx="4" fill={BG} />
      <rect x="37" y="24" width="16" height="16" rx="4" fill={BG} />
      <path d="M22 18.5c6-4 14-4 20 0M39.5 15.5l2.8 3.2-4.2.9" />
      <path d="M42 45.5c-6 4-14 4-20 0M24.5 48.5l-2.8-3.2 4.2-.9" />
      <path d="M16 30h6M16 34h4M42 30h6M42 34h4" strokeOpacity=".4" />
    </>
  ),
  // One hub, three apps plugged in.
  connectors: (
    <>
      <circle cx="32" cy="32" r="28" fill="currentColor" fillOpacity=".06" stroke="none" />
      <path d="M32 32L18 21M32 32l15-9M32 32l2 17" strokeOpacity=".4" />
      <circle cx="32" cy="32" r="6.5" fill={BG} />
      <circle cx="32" cy="32" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="17" cy="20" r="4" fill={BG} />
      <circle cx="48" cy="22" r="4" fill={BG} />
      <circle cx="34" cy="50" r="4" fill={BG} />
    </>
  ),
  // A key.
  keys: (
    <>
      <circle cx="32" cy="32" r="28" fill="currentColor" fillOpacity=".06" stroke="none" />
      <circle cx="23" cy="32" r="8.5" fill={BG} />
      <circle cx="21" cy="32" r="2" />
      <path d="M31.5 32H50M43 32v6M48 32v4" />
    </>
  ),
};

/** The small drawing on a settings page's top card (and on the welcome page). One style for
 * all, in the text colour only: thin lines on a soft disc, lighter lines for detail. */
export function SettingsArt({ name, size = 56 }: { name: ArtName; size?: number }) {
  return (
    <svg
      className="settings-art"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-art={name}
    >
      {ART[name]}
    </svg>
  );
}
