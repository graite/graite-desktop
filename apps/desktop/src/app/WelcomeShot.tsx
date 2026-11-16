import { useEffect, useState } from "react";
import { ImageOff, Maximize2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useTheme } from "@/lib/theme";

/** The screenshots of the welcome page. Each has a whole picture, `public/welcome/<name>-light.png`,
 * and a zoomed-in part of it, `<name>-zoom-light.png`, which is what the page shows; `-dark`
 * variants are optional. `capture` says what the picture has to show, for whoever takes it. */
export const WELCOME_SHOTS = {
  overview: {
    alt: "The Graite window: sidebar, page tabs, an open page and its buttons",
    capture:
      "The whole window with a page open: sidebar with the page tree, two or three tabs, and the AI settings, Ask AI and ⋯ buttons at the top right.",
  },
  "ai-instructions": {
    alt: "The AI settings of a page, with its instructions and permissions",
    capture:
      "The AI settings dialog of a subpage: instructions filled in on the left and the three choices on the right.",
  },
  review: {
    alt: "A page with a change proposed by AI, waiting to be accepted or rejected",
    capture:
      "A page with open proposals: the review bar at the top and a proposed change shown in the page with Accept and Reject.",
  },
  "claude-add": {
    alt: "Claude: the dialog that adds a custom connector, with a name and an address",
    capture: "Claude → Connectors → Add custom connector, with the dialog open and empty.",
  },
  "claude-connected": {
    alt: "Claude: Graite connected, with its address and the tools Claude may use",
    capture: "Claude → Connectors → Graite, connected. No account details in the picture.",
  },
} as const;

export type WelcomeShotName = keyof typeof WELCOME_SHOTS;

/** A screenshot in the welcome page: the zoomed-in part, which opens the whole picture when
 * clicked. It follows the theme, falls back to the light picture when there is no dark one,
 * and says what is missing when there is none at all. */
export function WelcomeShot({ name, caption }: { name: WelcomeShotName; caption?: string }) {
  const theme = useTheme();
  const shot = WELCOME_SHOTS[name];
  // Which file to try: the theme's own, then the light one, then give up.
  const [attempt, setAttempt] = useState<"theme" | "light" | "missing">("theme");
  const [large, setLarge] = useState(false);
  useEffect(() => setAttempt("theme"), [theme, name]);
  if (attempt === "missing")
    return (
      <figure className="welcome-shot welcome-shot-missing" aria-label={shot.alt}>
        <ImageOff size={18} />
        <figcaption>
          <strong>Screenshot to add: {name}-light.png</strong>
          <span>{shot.capture}</span>
        </figcaption>
      </figure>
    );
  const variant = attempt === "theme" ? theme : "light";
  const src = `/welcome/${name}-zoom-${variant}.png`;
  const whole = `/welcome/${name}-${variant}.png`;
  return (
    <figure className="welcome-shot">
      <button type="button" aria-label={`Enlarge: ${shot.alt}`} onClick={() => setLarge(true)}>
        <img
          src={src}
          alt={shot.alt}
          loading="lazy"
          onError={() => setAttempt(attempt === "theme" && theme === "dark" ? "light" : "missing")}
        />
        <span className="welcome-shot-zoom" aria-hidden="true">
          <Maximize2 size={13} />
        </span>
      </button>
      <Dialog open={large} onOpenChange={setLarge}>
        <DialogContent className="welcome-shot-large">
          <DialogTitle className="sr-only">Screenshot</DialogTitle>
          <DialogDescription className="sr-only">{shot.alt}</DialogDescription>
          <img src={whole} alt={shot.alt} />
        </DialogContent>
      </Dialog>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
