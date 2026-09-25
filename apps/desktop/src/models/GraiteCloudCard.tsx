import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Cloud,
  Copy,
  ExternalLink,
  Loader2,
  LogOut,
  Clock,
  MailWarning,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { onDaemonEvent } from "@/lib/api";
import { cloud, type CloudModel, type CloudStatus } from "@/lib/cloud";
import "./cloud.css";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

/** Graite Cloud in Settings → Chat: what it is, signing in through the browser, and today's
 * credits. There is nothing to choose: the vault uses the model Graite Cloud offers (the first
 * available one), picked here as soon as the account is signed in. */
export function GraiteCloudCard({
  activeModel,
  disabled,
  onPick,
}: {
  activeModel: string | null;
  disabled: boolean;
  onPick: (model: CloudModel) => void;
}) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [models, setModels] = useState<CloudModel[]>([]);
  const [waiting, setWaiting] = useState<string | null>(null); // the sign-in URL
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Requests can finish after the card is gone (leaving Settings, a test ending).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await cloud.status();
      const offered = next.signed_in ? await cloud.models() : [];
      if (!mounted.current) return;
      setStatus(next);
      if (next.signed_in) setWaiting(null);
      setModels(offered);
      setError("");
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The browser flow ends in the daemon; it tells every window.
    return onDaemonEvent((event) => {
      if (event.type === "cloud_status") void refresh();
    });
  }, [refresh]);

  // One model for everyone: select it, so saving just works.
  const offered = models.find((m) => m.available) ?? null;
  useEffect(() => {
    if (offered && offered.id !== activeModel) onPick(offered);
  }, [offered, activeModel, onPick]);

  const signIn = async (signup: boolean) => {
    setError("");
    try {
      const started = await cloud.login(signup);
      setWaiting(started.url);
      if (!started.opened) setError("Your browser didn’t open. Copy the link and open it there.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const copyLink = async () => {
    if (!waiting) return;
    try {
      await navigator.clipboard.writeText(waiting);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  };
  const signOut = async () => {
    try {
      await cloud.logout();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const today = status?.today;
  const percent = today?.percent_used ?? null;
  return (
    <div className="cloud-card" aria-label="Graite Cloud">
      <section className="cloud-zdr" aria-label="Zero data retention">
        <ShieldCheck size={20} />
        <div>
          <strong>Zero data retention</strong>
          <p>
            Your chats and pages are never stored and never used to train models. We only count
            tokens for your daily credits. Pages marked local-only never leave this computer.
          </p>
        </div>
      </section>
      <p className="cloud-intro">
        <Cloud size={15} />
        Graite Cloud runs the models for you, with nothing to download or set up. Free accounts get
        daily credits.
      </p>
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
      {!status ? (
        <p className="cloud-muted">
          <Loader2 size={14} className="animate-spin" /> Checking your Graite account…
        </p>
      ) : !status.signed_in ? (
        waiting ? (
          <div className="cloud-waiting" role="status">
            <p>
              <Loader2 size={14} className="animate-spin" />
              <span>
                <strong>Finish in your browser.</strong> Sign in there and choose Connect; this
                screen updates by itself.
              </span>
            </p>
            <div className="cloud-actions">
              <Button variant="outline" size="sm" onClick={() => void copyLink()}>
                {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
                {copied ? "Copied" : "Copy link"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setWaiting(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="cloud-signin">
            <div className="cloud-actions">
              <Button disabled={disabled} onClick={() => void signIn(false)}>
                Sign in with Graite
              </Button>
              <Button variant="outline" disabled={disabled} onClick={() => void signIn(true)}>
                Create an account
              </Button>
            </div>
            <small className="cloud-muted">
              Your browser opens on {new URL(status.cloud_url).host}. Come back here when you’re
              done.
            </small>
          </div>
        )
      ) : (
        <>
          <div className="cloud-account">
            <div>
              <strong>{status.email}</strong>
              <small>{status.plan ? `${status.plan} plan` : "Signed in"}</small>
            </div>
            <div className="cloud-actions">
              <Button variant="ghost" size="sm" onClick={() => void cloud.openAccount()}>
                <ExternalLink size={14} /> Manage account
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                <LogOut size={14} /> Sign out
              </Button>
            </div>
          </div>
          {status.verify_by && (
            <p className="cloud-reminder">
              <MailWarning size={15} />
              <span>
                Confirm your email by {day(status.verify_by)} to keep using Graite Cloud. We sent
                you a link when you signed up.
              </span>
            </p>
          )}
          {today &&
            percent !== null &&
            (status.plan_id === "free" ? (
              // Free accounts see no meter, only when today's credits are spent.
              percent >= 100 && (
                <p className="cloud-reminder" role="status">
                  <Clock size={15} />
                  <span>
                    You’ve used today’s free credits. They reset at {time(today.resets_at)}.
                  </span>
                </p>
              )
            ) : (
              <div className="cloud-usage">
                <div
                  className="cloud-meter"
                  role="progressbar"
                  aria-label="Today’s credits used"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <span data-full={percent >= 100 || undefined} style={{ width: `${percent}%` }} />
                </div>
                <small>
                  {percent >= 100
                    ? `You’ve used today’s credits. They reset at ${time(today.resets_at)}.`
                    : `${percent}% of today’s credits used · resets at ${time(today.resets_at)}`}
                </small>
              </div>
            ))}
          {status.error && <p className="cloud-muted">{status.error}</p>}
          {offered ? (
            <p className="cloud-muted">
              <Check size={14} /> Ready to chat with Graite Cloud.
            </p>
          ) : (
            !status.error && (
              <p className="cloud-muted">
                Graite Cloud isn’t available right now. Try again in a little while.
              </p>
            )
          )}
        </>
      )}
    </div>
  );
}
