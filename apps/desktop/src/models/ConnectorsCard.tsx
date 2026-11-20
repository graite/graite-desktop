import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Copy, Globe, Laptop, Loader2, Plug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { onDaemonEvent } from "@/lib/api";
import { cloud, type CloudStatus } from "@/lib/cloud";
import {
  claudeCodeCommand,
  codexCommand,
  httpCommand,
  jsonConfig,
  mcp,
  type ClientId,
  type ClientStatus,
  type McpInfo,
  type RemoteInfo,
  type TestResult,
} from "@/lib/mcp";
import { platform } from "@/lib/platform";
import "./mcp.css";

function Snippet({ label, hint, text }: { label: string; hint: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  };
  return (
    <div className="mcp-snippet">
      <div className="mcp-snippet-head">
        <div>
          <strong>{label}</strong>
          <small>{hint}</small>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Copy ${label} setup`}
          onClick={() => void copy()}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre tabIndex={0}>{text}</pre>
    </div>
  );
}

/** "2 minutes ago", for the line that says an app really did use Graite. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
  ];
  let [size, name] = units[0]!;
  for (const unit of units) if (seconds >= unit[0]) [size, name] = unit;
  const count = Math.max(1, Math.round(seconds / size));
  return `${count} ${name}${count === 1 ? "" : "s"} ago`;
}

/** What a test found, in one sentence. */
function Outcome({ result }: { result: TestResult }) {
  return result.ok ? (
    <p className="connector-outcome" data-ok role="status">
      <Check size={14} />
      {result.via === "bridge"
        ? `Works. The app can start Graite and sees ${result.tools} tools (${result.ms} ms).`
        : `Works. An app can use ${result.tools} tools and read your ${result.pages} ${
            result.pages === 1 ? "page" : "pages"
          } (${result.ms} ms).`}
    </p>
  ) : (
    <p className="connector-outcome" role="alert">
      <CircleAlert size={14} />
      {result.error || "It did not work."}
    </p>
  );
}

/** A "Test" button with its result under it. */
function useTest(via: "server" | "bridge") {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await mcp.test(via));
    } catch (e) {
      setResult({ ok: false, via, tools: 0, pages: 0, ms: 0, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return { busy, result, run, clear: () => setResult(null) };
}

/** Claude, ChatGPT or Grok in the browser: through Graite Cloud. */
function BrowserConnector({
  initial,
  onOpenAccount,
}: {
  initial: RemoteInfo;
  onOpenAccount?: () => void;
}) {
  const [account, setAccount] = useState<CloudStatus | null>(null);
  const [remote, setRemote] = useState(initial);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refreshAccount = useCallback(async () => {
    try {
      const next = await cloud.status();
      if (mounted.current) setAccount(next);
    } catch {
      if (mounted.current) setAccount(null);
    }
  }, []);
  useEffect(() => {
    void refreshAccount();
    // The browser sign-in ends in the daemon, which tells every window.
    return onDaemonEvent((event) => {
      if (event.type === "cloud_status") {
        void refreshAccount();
        void mcp
          .info()
          .then((info) => mounted.current && setRemote(info.remote))
          .catch(() => {});
      }
    });
  }, [refreshAccount]);
  useEffect(() => {
    if (!remote.enabled || remote.connected) return;
    // The relay connects in the background; look again until it has or says why not.
    const timer = setTimeout(() => {
      void mcp
        .info()
        .then((info) => mounted.current && setRemote(info.remote))
        .catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
  }, [remote]);

  const signIn = async () => {
    try {
      const started = await cloud.login(false);
      if (!started.opened)
        toast.error("Your browser didn’t open. Try again from Settings → Graite Cloud.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const toggle = async () => {
    setBusy(true);
    try {
      setRemote(await mcp.setRemote(!remote.enabled));
    } catch {
      toast.error("Could not change remote access. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const signedIn = !!account?.signed_in;
  const ready = remote.enabled && remote.connected;
  const status = !signedIn
    ? "Sign in first"
    : !remote.enabled
      ? "Off"
      : remote.connected
        ? "Connected"
        : remote.error || "Connecting…";
  return (
    <section className="connector" aria-label="Apps in the browser">
      <header className="connector-head">
        <Globe size={18} />
        <div>
          <h3>Your pages inside Claude and ChatGPT</h3>
          <p>
            Ask Claude or ChatGPT on the web about your notes, and let them suggest changes. It
            works while Graite is open on this computer, and only you can get in.
          </p>
        </div>
      </header>
      <ol className="connector-steps" aria-label="How to connect">
        <li data-done={signedIn || undefined}>Sign in to Graite Cloud</li>
        <li data-done={(signedIn && remote.enabled) || undefined}>Switch on remote access</li>
        <li>Paste the address into Claude or ChatGPT</li>
      </ol>
      {!signedIn ? (
        <div className="connector-row">
          <span>
            <strong>Sign in to Graite Cloud</strong>
            <small>The AI app signs in with the same account and you click Allow.</small>
          </span>
          <div className="connector-actions">
            {onOpenAccount && (
              <Button size="sm" variant="ghost" onClick={onOpenAccount}>
                What is Graite Cloud?
              </Button>
            )}
            <Button size="sm" onClick={() => void signIn()}>
              Sign in
            </Button>
          </div>
        </div>
      ) : (
        <div className="connector-row">
          <span>
            <label htmlFor="mcp-remote-switch">
              <strong>Remote access</strong>
            </label>
            <small id="mcp-remote-hint" data-state={ready ? "ok" : undefined}>
              {status}
              {account?.email ? ` · signed in as ${account.email}` : ""}. Works while Graite is open
              on this computer.
            </small>
          </span>
          <Switch
            id="mcp-remote-switch"
            aria-label="Remote access"
            checked={remote.enabled}
            aria-describedby="mcp-remote-hint"
            disabled={busy}
            onCheckedChange={() => void toggle()}
          />
        </div>
      )}
      {signedIn && remote.enabled && (
        <>
          <Snippet
            label="Connector URL"
            hint="Paste it into your AI app as a custom connector"
            text={remote.url}
          />
          <details>
            <summary>Where to paste it in Claude, ChatGPT and Grok</summary>
            <ul className="connector-howto" aria-label="How to add the connector">
              <li>
                <strong>Claude</strong>
                <span>
                  Open Settings → Connectors and choose Add custom connector. Give it a name, paste
                  the address and add it, then choose Connect.
                </span>
              </li>
              <li>
                <strong>ChatGPT</strong>
                <span>
                  In ChatGPT on the web, open Settings → Apps &amp; Connectors → Advanced settings
                  and turn on Developer mode. Then create a connector, paste the address as its
                  server URL and confirm that you trust it.
                </span>
              </li>
              <li>
                <strong>Grok</strong>
                <span>
                  Open grok.com/connectors, choose New connector → Custom, give it a name and paste
                  the address.
                </span>
              </li>
            </ul>
            <small className="mcp-note">
              These apps rename their menus now and then, and some offer custom connectors only on
              certain plans. Look for “Connectors” in the app’s settings if a step has moved.
            </small>
          </details>
        </>
      )}
    </section>
  );
}

const MANUAL: Record<ClientId, (info: McpInfo) => { hint: string; text: string }> = {
  "claude-code": (info) => ({ hint: "Run once in a terminal", text: claudeCodeCommand(info) }),
  codex: (info) => ({ hint: "Run once in a terminal", text: codexCommand(info) }),
  cursor: (info) => ({
    hint: "Add to ~/.cursor/mcp.json, then restart Cursor",
    text: jsonConfig(info),
  }),
};

function ClientRow({ info, initial }: { info: McpInfo; initial: ClientStatus }) {
  const [client, setClient] = useState(initial);
  const [busy, setBusy] = useState(false);
  const test = useTest("bridge");
  const add = async () => {
    setBusy(true);
    test.clear();
    try {
      const next = await mcp.addClient(client.id as ClientId);
      setClient(next);
      toast.success(`Graite is added to ${client.name}. Restart ${client.name} to pick it up.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ready = client.installed && !client.outdated;
  const state = client.installed
    ? client.outdated
      ? "Added, but pointing at an older Graite. Press Update."
      : "Added"
    : client.found
      ? "Not added yet"
      : "Not found on this computer";
  const manual = MANUAL[client.id as ClientId]?.(info);
  return (
    <li className="connector-app" aria-label={client.name}>
      <div className="connector-app-head">
        <div>
          <strong>
            {client.name}
            {ready && (
              <span className="connector-added">
                <Check size={13} /> Added
              </span>
            )}
          </strong>
          {!ready && <small>{state}</small>}
          {client.note && <small className="mcp-note">{client.note}</small>}
        </div>
        {ready ? (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Test ${client.name}`}
            onClick={() => void test.run()}
            disabled={test.busy}
          >
            {test.busy ? <Loader2 size={14} className="animate-spin" /> : null} Test
          </Button>
        ) : client.can_install ? (
          <Button size="sm" onClick={() => void add()} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            {client.installed ? "Update" : `Add to ${client.name}`}
          </Button>
        ) : null}
      </div>
      {test.result && <Outcome result={test.result} />}
      {manual ? (
        // Open when one click cannot do it: then these are the instructions.
        <details open={!ready && !client.can_install}>
          <summary>Set it up by hand</summary>
          <small className="mcp-note">
            Graite writes one entry, <code>graite-local</code>, to <code>{client.where}</code> and
            leaves the rest alone. This is the same thing by hand.
          </small>
          <Snippet label={client.name} hint={manual.hint} text={manual.text} />
        </details>
      ) : null}
    </li>
  );
}

/** Claude Code, Codex and Cursor on this computer: Graite adds itself to their config. */
function LocalApps({ info }: { info: McpInfo }) {
  const [token, setToken] = useState("");
  useEffect(() => {
    let live = true;
    void platform
      .getDaemonInfo()
      .then((daemon) => live && setToken(daemon.token))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  // An AppImage is mounted at a new path on every start. The daemon hands out the AppImage
  // file itself instead (`<file> mcp`); the mount path only shows up if it could not find it.
  // One app at a time: the one already set up or installed here, until another is picked.
  const [picked, setPicked] = useState<string | null>(null);
  const shown =
    info.clients.find((c) => c.id === picked) ??
    info.clients.find((c) => c.installed) ??
    info.clients.find((c) => c.found) ??
    info.clients[0];
  const moving = info.stdio_command.startsWith("/tmp/.mount_");
  return (
    <section className="connector" aria-label="Apps on this computer">
      <header className="connector-head">
        <Laptop size={18} />
        <div>
          <h3>Apps on this computer</h3>
          <p>Pick your app, add Graite, restart the app. No account needed.</p>
        </div>
      </header>
      <div className="settings-segments" role="radiogroup" aria-label="App">
        {info.clients.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={c.id === shown?.id}
            onClick={() => setPicked(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <ul className="connector-apps">
        {shown && <ClientRow key={shown.id} info={info} initial={shown} />}
      </ul>
      {info.http_stable && token ? (
        <details>
          <summary>Another app, over HTTP</summary>
          <Snippet
            label="Direct HTTP"
            hint="This daemon keeps its address and token between launches"
            text={httpCommand(info, token)}
          />
        </details>
      ) : null}
      {moving ? (
        <p className="mcp-note" role="note">
          This copy of Graite runs from an AppImage, which gets a new location every time it starts,
          and its file could not be found. Start Graite by opening the .AppImage file itself, or
          install the .deb or .rpm package.
        </p>
      ) : null}
    </section>
  );
}

/**
 * Settings → AI connectors. One switch decides whether AI apps can use Graite at all, "Test"
 * says whether it works right now, and under it each kind of app is one short section.
 */
export function ConnectorsCard({ onOpenAccount }: { onOpenAccount?: () => void } = {}) {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const test = useTest("server");
  const live = useRef(true);
  const load = useCallback(async () => {
    try {
      const value = await mcp.info();
      if (live.current) {
        setInfo(value);
        setError("");
      }
    } catch (e) {
      if (live.current) setError((e as Error).message || "Graite did not answer.");
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);
  if (!info)
    return error ? (
      <div className="connectors">
        <section className="connector" aria-label="AI connectors">
          <p className="connector-outcome" role="alert">
            <CircleAlert size={14} /> Could not load the connector settings: {error}
          </p>
          <div className="connector-actions">
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        </section>
      </div>
    ) : null;
  // A daemon from before the switch existed is always on.
  const enabled = info.enabled !== false;
  const toggle = async () => {
    setBusy(true);
    test.clear();
    try {
      setInfo(await mcp.setEnabled(!enabled));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="connectors">
      <section className="connector" aria-label="AI connectors">
        <div className="connector-toggle">
          <Plug size={18} />
          <span>
            <label htmlFor="mcp-enabled-switch">
              <strong>Let AI apps use Graite</strong>
            </label>
            <small id="mcp-enabled-hint">
              {enabled
                ? info.last_used
                  ? `On · last used by ${info.last_used.client}, ${ago(info.last_used.at)}.`
                  : "On · no app has used it yet."
                : "Off. No app can read or change anything. What you set up below is kept."}
            </small>
          </span>
          <Switch
            id="mcp-enabled-switch"
            aria-label="Let AI apps use Graite"
            checked={enabled}
            aria-describedby="mcp-enabled-hint"
            disabled={busy}
            onCheckedChange={() => void toggle()}
          />
        </div>
        {enabled && (
          <>
            <div className="connector-row">
              <span>
                <small>
                  Apps can read and search your pages and propose changes. Every change waits in
                  Review until you accept it, and pages marked local-only or with AI turned off stay
                  hidden.
                </small>
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void test.run().then(load)}
                disabled={test.busy}
              >
                {test.busy ? <Loader2 size={14} className="animate-spin" /> : null} Test
              </Button>
            </div>
            {test.result && <Outcome result={test.result} />}
          </>
        )}
      </section>
      {enabled && (
        <>
          <BrowserConnector initial={info.remote} onOpenAccount={onOpenAccount} />
          <LocalApps info={info} />
        </>
      )}
    </div>
  );
}
