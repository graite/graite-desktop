import { Button } from "@/components/ui/button";
import {
  checkForUpdate,
  installUpdate,
  RELEASE_PAGE,
  useUpdateState,
  type UpdateState,
} from "@/lib/updates";

function line(state: Exclude<UpdateState, { step: "unsupported" }>): string {
  switch (state.step) {
    case "checking":
      return "Looking for a newer version…";
    case "available":
      return state.installable
        ? `Version ${state.update.version} is available. Installing restarts Graite.`
        : `Version ${state.update.version} is available. Download it and install it over this one.`;
    case "installing":
      return state.fraction === null
        ? `Installing version ${state.update.version}…`
        : `Installing version ${state.update.version}… ${Math.round(state.fraction * 100)}%`;
    case "failed":
      return `Could not check for updates: ${state.message}`;
    case "idle":
      if (state.unpublished) return "No update is published for this kind of computer yet.";
      return state.checkedAt ? "You have the newest version." : "Graite checks a few times a day.";
  }
}

/** Settings → General: the running version and the way to a newer one. A Linux package is
 * told where to download it; the Store build is updated by the Store and shows nothing. */
export function UpdateCard() {
  const state = useUpdateState();
  if (state.step === "unsupported") return null;
  const busy = state.step === "checking" || state.step === "installing";
  return (
    <section className="settings-card" aria-label="Updates">
      <h2>Updates</h2>
      <p>
        Version {state.version}. Graite tells you when there is a newer one; nothing installs until
        you say so.
      </p>
      <div className="settings-update">
        <span role="status">{line(state)}</span>
        {state.step === "available" && !state.installable ? (
          <Button variant="outline" asChild>
            <a href={RELEASE_PAGE} target="_blank" rel="noreferrer">
              Download
            </a>
          </Button>
        ) : state.step === "available" ? (
          <Button variant="outline" onClick={() => void installUpdate()}>
            Install and restart
          </Button>
        ) : (
          <Button variant="outline" disabled={busy} onClick={() => void checkForUpdate()}>
            Check for updates
          </Button>
        )}
      </div>
    </section>
  );
}
