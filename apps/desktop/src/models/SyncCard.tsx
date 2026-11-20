import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Loader2, MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { vaultName } from "@/lib/storage";
import { sync, type SyncDevice, type SyncSpace, type SyncStatus } from "@/lib/sync";
import { WORD_COUNT, WordBlocks, WordInputs } from "./SecretWords";
import "./cloud.css";

const POLL_MS = 5000;

function deviceState(device: SyncDevice): string {
  if (device.in_sync === null || device.in_sync === undefined) return "not synced yet";
  const state = device.in_sync ? "up to date" : "behind";
  return device.connected ? state : `${state} · offline`;
}

function Devices({ space }: { space: SyncSpace }) {
  return (
    <ul className="sync-devices" aria-label="Devices">
      {space.devices.map((device) => (
        <li key={device.id}>
          <span>
            {device.name}
            {device.this_device && " (this computer)"}
          </span>
          <small data-behind={device.in_sync === false || undefined}>{deviceState(device)}</small>
        </li>
      ))}
    </ul>
  );
}

/** The whole idea in three steps, shown until this vault is shared. */
function HowItWorks() {
  return (
    <ol className="sync-how" aria-label="How it works">
      <li>
        <b aria-hidden>1</b>
        <strong>Share on this computer</strong>
        <span>You get six secret words.</span>
      </li>
      <li>
        <b aria-hidden>2</b>
        <strong>Type them on the other</strong>
        <span>Open Graite there, sign in, type the six words.</span>
      </li>
      <li>
        <b aria-hidden>3</b>
        <strong>Same pages everywhere</strong>
        <span>What you write on one appears on the other.</span>
      </li>
    </ol>
  );
}

/** Settings → Sync devices: share this vault with your other devices. One thing to do at a
 * time: share it (first computer), or type the six words and pick the vault (the others);
 * after that, who has what. */
export function SyncCard({ onOpenCloud }: { onOpenCloud?: () => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  // undefined: not asked for; null: this computer does not have the words.
  const [words, setWords] = useState<string | null | undefined>(undefined);
  const [folder, setFolder] = useState("this folder");

  const refresh = useCallback(() => {
    sync
      .status()
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    api
      .health()
      .then((health) => health.vault && setFolder(`the folder “${vaultName(health.vault)}”`))
      .catch(() => {});
  }, []);

  const run = async (action: () => Promise<SyncStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
      setSecret("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const showWords = () => {
    sync
      .passphrase()
      .then(setWords)
      .catch(() => setWords(null));
  };

  if (!status) {
    return (
      <p className="cloud-muted">
        <Loader2 size={14} className="animate-spin" /> Checking sync…
      </p>
    );
  }
  if (!status.signed_in || status.set_up === null || status.set_up === undefined) {
    return (
      <section className="settings-card" aria-label="Sync">
        <h2>Sign in first</h2>
        <p>Your devices find each other through your Graite account. Sign in, then come back.</p>
        {status.error && (
          <p className="ai-error" role="alert">
            {status.error}
          </p>
        )}
        {onOpenCloud && (
          <div className="cloud-actions">
            <Button onClick={onOpenCloud}>Open Graite Cloud</Button>
          </div>
        )}
      </section>
    );
  }

  const current = status.spaces.find((space) => space.id === status.space_id) ?? null;
  const others = status.spaces.filter((space) => space.id !== status.space_id);
  const problem = error ?? status.error;

  /** First computer: make the six words and share this vault, in one click. */
  const shareFirst = () =>
    void run(async () => {
      await sync.setup();
      const shared = await sync.enable();
      showWords();
      return shared;
    });
  const connect = (event: FormEvent) => {
    event.preventDefault();
    void run(() => sync.unlock(secret));
  };

  const wordsBox =
    words === undefined ? null : words ? (
      <WordBlocks words={words} />
    ) : (
      <p className="cloud-muted">
        This computer does not have the words saved. Use “Get new words” below.
      </p>
    );
  const complete = secret.split(" ").filter(Boolean).length === WORD_COUNT;

  return (
    <div className="sync-steps" aria-label="Sync">
      {problem && (
        <p className="ai-error" role="alert">
          {problem}
        </p>
      )}

      {!status.set_up && (
        <section className="settings-card" aria-label="Share this vault">
          <h2>Share this vault with your other devices</h2>
          <HowItWorks />
          <div className="cloud-actions">
            <Button disabled={busy} onClick={shareFirst}>
              {busy && <Loader2 size={14} className="animate-spin" />}
              Share this vault
            </Button>
          </div>
        </section>
      )}

      {status.set_up && !status.unlocked && (
        <section className="settings-card" aria-label="Connect this computer">
          <h2>Connect this computer</h2>
          <p>
            Type your six secret words. You find them on a computer that already shares, under
            Settings → Sync devices → Show secret words.
          </p>
          <form className="cloud-signin" onSubmit={connect}>
            <WordInputs value={secret} onChange={setSecret} />
            <div className="cloud-actions">
              <Button type="submit" disabled={busy || !complete}>
                {busy && <Loader2 size={14} className="animate-spin" />}
                Connect
              </Button>
            </div>
          </form>
        </section>
      )}

      {status.unlocked && !current && (
        <section className="settings-card" aria-label="Choose a vault">
          {others.length > 0 ? (
            <>
              <h2>Which vault do you want on this computer?</h2>
              <p>
                Its pages are copied into {folder}. Pages already in this folder stay, and are
                shared with your other devices too. For an exact copy, start with an empty folder.
              </p>
              <div className="sync-join">
                {others.map((space) => (
                  <div className="cloud-account" key={space.id}>
                    <div>
                      <strong>{space.name}</strong>
                      <small>
                        on {space.devices.length} device{space.devices.length === 1 ? "" : "s"}
                      </small>
                    </div>
                    <Button disabled={busy} onClick={() => void run(() => sync.enable(space.id))}>
                      Get this vault here
                    </Button>
                  </div>
                ))}
              </div>
              <div className="cloud-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => sync.enable())}
                >
                  Or share {folder} as a separate vault
                </Button>
              </div>
            </>
          ) : (
            <>
              <h2>Share this vault with your other devices</h2>
              <HowItWorks />
              <div className="cloud-actions">
                <Button disabled={busy} onClick={() => void run(() => sync.enable())}>
                  Share this vault
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {current && (
        <>
          <section className="settings-card" aria-label="This vault">
            <h2>
              <MonitorSmartphone size={15} /> “{current.name}” is shared
            </h2>
            <p>
              {status.connected
                ? status.waiting > 0
                  ? `Receiving ${status.waiting} change${status.waiting === 1 ? "" : "s"}…`
                  : "Everything is up to date. A computer that is off catches up when it is back on."
                : "Not connected right now. It continues by itself when the connection is back."}
            </p>
            <Devices space={current} />
          </section>

          <section className="settings-card" aria-label="Add a device">
            <h2>Add another device</h2>
            <p>
              Open Graite on the other computer, sign in with the same account, open an empty folder
              and type these six words under Settings → Sync devices.
            </p>
            {wordsBox}
            <div className="cloud-actions">
              <Button
                variant="outline"
                size="sm"
                onClick={() => (words === undefined ? showWords() : setWords(undefined))}
              >
                {words === undefined ? "Show secret words" : "Hide secret words"}
              </Button>
            </div>
          </section>
        </>
      )}

      {status.set_up && (
        <section className="settings-card" aria-label="Stop or get new words">
          {current && (
            <div className="sync-choice">
              <div>
                <strong>Don’t want to share from this computer anymore?</strong>
                <small>
                  Your pages stay on this computer. It stops sending and receiving changes.
                </small>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void run(sync.disable)}
              >
                Stop sharing here
              </Button>
            </div>
          )}
          <div className="sync-choice">
            <div>
              <strong>
                {status.unlocked ? "Lost your six words, or a device?" : "Don’t have the words?"}
              </strong>
              <small>
                No pages are removed. Sharing pauses on every device until you type the new words
                there.
              </small>
            </div>
            {confirmReset ? (
              <span className="cloud-actions">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setConfirmReset(false);
                    setWords(undefined);
                    void run(sync.reset);
                  }}
                >
                  Yes, new words for all my devices
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirmReset(true)}>
                Get new words
              </Button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
