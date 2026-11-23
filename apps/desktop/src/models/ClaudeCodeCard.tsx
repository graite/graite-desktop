import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, ShieldCheck, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { claudeCode, type ClaudeCodeInfo, type ClaudeLaunch } from "@/lib/claudeCode";
import "./cloud.css";

/** How often, and for how long, the card looks again while the user is busy in the terminal
 * window. It only looks while waiting: nothing runs in the background otherwise. */
const POLL_MS = 2500;
const WAIT_MS = 5 * 60 * 1000;
const USAGE_URL = "https://claude.ai/settings/usage";

const MODEL_NAMES: Record<string, string> = { sonnet: "Sonnet", opus: "Opus", haiku: "Haiku" };

type Step = "install" | "login";

/** Chat on a Claude subscription, through the user's own Claude Code. Graite opens Claude
 * Code's install and sign-in in a terminal window and then only checks "signed in or not":
 * the sign-in itself is between the user and Anthropic, and no token reaches Graite. */
export function ClaudeCodeCard({
  activeModel,
  disabled,
  onPick,
}: {
  /** The Claude model chat uses, or null while chat uses something else. */
  activeModel: string | null;
  disabled: boolean;
  onPick: (model: string) => void;
}) {
  const [info, setInfo] = useState<ClaudeCodeInfo | null>(null);
  const [waiting, setWaiting] = useState<Step | null>(null);
  const [launch, setLaunch] = useState<ClaudeLaunch | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await claudeCode.status();
      if (!mounted.current) return next;
      setInfo(next);
      setError("");
      return next;
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
      return null;
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While a terminal window is open, look again every few seconds until that step is done.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      void refresh().then((next) => {
        if (!mounted.current) return;
        const done = waiting === "install" ? next?.installed : next?.signed_in;
        if (done || Date.now() - started > WAIT_MS) {
          setWaiting(null);
          setLaunch(null);
        }
      });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [waiting, refresh]);

  const start = async (step: Step) => {
    setError("");
    try {
      const opened = await (step === "install" ? claudeCode.install() : claudeCode.login());
      if (!mounted.current) return;
      setLaunch(opened);
      setWaiting(step);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  };
  const copy = async () => {
    if (!launch?.command) return;
    await navigator.clipboard.writeText(launch.command);
    setCopied(true);
    window.setTimeout(() => mounted.current && setCopied(false), 1500);
  };

  const model = activeModel && info?.models.includes(activeModel) ? activeModel : null;
  return (
    <div className="cloud-card" aria-label="Claude subscription">
      <section className="cloud-zdr" aria-label="Your own sign-in">
        <ShieldCheck size={20} />
        <div>
          <strong>Your sign-in stays with Claude</strong>
          <p>
            Graite runs Claude Code, Anthropic’s own app, on this computer. You sign in with
            Anthropic, so Graite never sees your password. Pages marked local-only are never sent.
          </p>
        </div>
      </section>
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
      {!info ? (
        <p className="cloud-muted">
          <Loader2 size={14} className="animate-spin" /> Looking for Claude Code…
        </p>
      ) : waiting ? (
        <div className="cloud-waiting" role="status">
          <p>
            <Loader2 size={14} className="animate-spin" />
            <span>
              {launch?.opened ? (
                waiting === "install" ? (
                  <>
                    <strong>Installing in the window that opened.</strong> This screen updates by
                    itself when it is done.
                  </>
                ) : (
                  <>
                    <strong>Finish in your browser.</strong> Choose Allow there; this screen updates
                    by itself.
                  </>
                )
              ) : launch?.command ? (
                <>
                  <strong>Run this in a terminal.</strong> This screen updates by itself when it is
                  done.
                </>
              ) : (
                <>
                  <strong>Download Claude Code, then come back.</strong> This screen updates by
                  itself once it is installed.
                </>
              )}
            </span>
          </p>
          {launch?.command && !launch.opened && (
            <code className="claude-command">{launch.command}</code>
          )}
          <div className="cloud-actions">
            {launch?.command && (
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
                {copied ? "Copied" : "Copy command"}
              </Button>
            )}
            {launch?.url && !launch.command && (
              <a className="cloud-link" href={launch.url} target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> Download Claude Code
              </a>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setWaiting(null);
                setLaunch(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : !info.installed ? (
        <div className="cloud-signin">
          <div className="cloud-actions">
            <Button disabled={disabled} onClick={() => void start("install")}>
              <Terminal size={14} /> Set up Claude
            </Button>
          </div>
          <small className="cloud-muted">
            Claude Code isn’t on this computer yet. Graite opens Anthropic’s installer in a terminal
            window, where you can see what it does.
          </small>
        </div>
      ) : !info.signed_in ? (
        <div className="cloud-signin">
          <div className="cloud-actions">
            <Button disabled={disabled} onClick={() => void start("login")}>
              Sign in to Claude
            </Button>
          </div>
          <small className="cloud-muted">
            A terminal window opens with Claude Code’s sign-in, then your browser. Choose Allow and
            come back here.
          </small>
        </div>
      ) : (
        <>
          <div className="cloud-account">
            <div>
              <strong>
                <Check size={14} /> {info.connected ? "Connected" : "Claude Code is signed in"}
              </strong>
              <small>
                {info.connected
                  ? info.plan
                    ? `Claude ${info.plan} plan`
                    : "Claude subscription"
                  : "Not with a Claude subscription: usage is billed to that account."}
              </small>
            </div>
            <div className="cloud-actions">
              {!info.connected && (
                <Button variant="outline" size="sm" onClick={() => void start("login")}>
                  Sign in with a subscription
                </Button>
              )}
              <a className="cloud-link" href={USAGE_URL} target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> Your usage
              </a>
            </div>
          </div>
          <div className="claude-default">
            <strong>Default model</strong>
            <small>
              New chats start with this one. You can switch per chat from the model menu.
            </small>
          </div>
          <div className="claude-models" role="radiogroup" aria-label="Default Claude model">
            {info.models.map((name) => (
              <Button
                key={name}
                role="radio"
                aria-checked={model === name}
                variant={model === name ? "default" : "outline"}
                size="sm"
                disabled={disabled}
                onClick={() => onPick(name)}
              >
                {MODEL_NAMES[name] ?? name}
              </Button>
            ))}
          </div>
          <p className="cloud-muted">
            Chats count toward your Claude plan’s limits. What your plan includes is Anthropic’s to
            say: see Your usage.
          </p>
        </>
      )}
    </div>
  );
}
