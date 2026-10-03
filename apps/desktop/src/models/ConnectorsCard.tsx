import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Globe, Laptop, Loader2 } from "lucide-react";
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

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="connector-step" data-done={done}>
      <span className="connector-step-n" aria-hidden>
        {done ? <Check size={13} /> : n}
      </span>
      <div>
        <strong>{title}</strong>
        {children}
      </div>
    </li>
  );
}

/** Claude or ChatGPT in the browser: through Graite Cloud, in three steps. */
function BrowserConnector({ initial }: { initial: RemoteInfo }) {
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
      if (!started.opened) toast.error("Your browser didn’t open. Try again from Settings → Chat.");
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
  const status = !remote.enabled
    ? "Off"
    : remote.connected
      ? "Connected through Graite Cloud"
      : remote.error || "Connecting…";
  return (
    <section className="connector" aria-label="Connect in the browser">
      <header className="connector-head">
        <Globe size={18} />
        <div>
          <h3>Connect Claude or ChatGPT</h3>
          <p>Let an AI app in your browser work in this vault, through your Graite account.</p>
        </div>
      </header>
      <ol className="connector-steps">
        <Step n={1} title="Sign in to Graite Cloud" done={signedIn}>
          {signedIn ? (
            <small>Signed in{account?.email ? ` as ${account.email}` : ""}.</small>
          ) : (
            <>
              <small>Your Graite account is what the AI app signs in with.</small>
              <Button size="sm" variant="outline" onClick={() => void signIn()}>
                Sign in
              </Button>
            </>
          )}
        </Step>
        <Step n={2} title="Turn on remote access" done={remote.enabled && remote.connected}>
          <div className="mcp-remote">
            <small id="mcp-remote-hint">
              Opens a secure connection from this computer to Graite Cloud while Graite is open.{" "}
              {status}.
            </small>
            <Switch
              aria-label="Remote access"
              checked={remote.enabled}
              aria-describedby="mcp-remote-hint"
              disabled={busy || !signedIn}
              onCheckedChange={() => void toggle()}
            />
          </div>
        </Step>
        <Step n={3} title="Add Graite as a connector in your AI app" done={false}>
          <small>
            <b>Claude:</b> Settings → Connectors → Add custom connector. <b>ChatGPT:</b> Settings →
            Connectors (developer mode) → Create. Paste this URL, then sign in with your Graite
            account and click Allow.
          </small>
          <Snippet label="Connector URL" hint="Paste it into your AI app" text={remote.url} />
        </Step>
      </ol>
      <div className="connector-can">
        <strong>Then you can ask it to</strong>
        <ul>
          <li>show your pages as a tree and find a page by name</li>
          <li>read and search your pages</li>
          <li>create pages, boards, cards and properties</li>
          <li>follow the AI instructions you set on a page</li>
        </ul>
        <p className="mcp-note">
          Every change waits in Review until you accept it, unless the page applies AI changes
          automatically. Pages marked local-only stay hidden. Graite has to be open on this
          computer.
        </p>
      </div>
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
  const add = async () => {
    setBusy(true);
    try {
      const next = await mcp.addClient(client.id as ClientId);
      setClient(next);
      toast.success(`Graite is added to ${client.name}. Restart it to pick it up.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const state = client.installed
    ? client.outdated
      ? "Added, but pointing at an older Graite"
      : "Added"
    : client.found
      ? "Not added yet"
      : "Not found on this computer";
  const manual = MANUAL[client.id as ClientId]?.(info);
  return (
    <li className="connector-app" aria-label={client.name}>
      <div className="connector-app-head">
        <div>
          <strong>{client.name}</strong>
          <small>
            {state} · <code>{client.where}</code>
          </small>
          {client.note && <small className="mcp-note">{client.note}</small>}
        </div>
        {client.can_install && (!client.installed || client.outdated) ? (
          <Button size="sm" onClick={() => void add()} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            {client.installed ? "Update" : `Add to ${client.name}`}
          </Button>
        ) : client.installed ? (
          <span className="connector-added">
            <Check size={14} /> Added
          </span>
        ) : null}
      </div>
      {manual ? (
        <details>
          <summary>Set it up by hand</summary>
          <Snippet label={client.name} hint={manual.hint} text={manual.text} />
        </details>
      ) : null}
    </li>
  );
}

/** Claude Code, Codex and Cursor on this computer: Graite adds itself to their config. */
function LocalApps({ info }: { info: McpInfo }) {
  const [open, setOpen] = useState(info.clients.some((c) => c.installed));
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
  const moving = info.stdio_command.startsWith("/tmp/.mount_");
  return (
    <section className="connector" aria-label="Apps on this computer">
      <div className="connector-toggle">
        <Laptop size={18} />
        <span>
          <label htmlFor="local-apps-switch">
            <strong>Also connect apps on this computer</strong>
          </label>
          <small id="local-apps-hint">
            Claude Code, Codex or Cursor. They talk to Graite directly, without Graite Cloud.
          </small>
        </span>
        <Switch
          id="local-apps-switch"
          checked={open}
          aria-describedby="local-apps-hint"
          onCheckedChange={setOpen}
        />
      </div>
      {open ? (
        <>
          <ol className="connector-steps">
            <Step n={1} title="Add Graite to your app" done={info.clients.some((c) => c.installed)}>
              <small>
                Graite writes one entry, <code>graite-local</code>, into the app’s own settings and
                leaves the rest alone.
              </small>
            </Step>
            <Step n={2} title="Restart the app and ask about your vault" done={false}>
              <small>It can do everything listed above. Graite has to be open.</small>
            </Step>
          </ol>
          <ul className="connector-apps">
            {info.clients.map((c) => (
              <ClientRow key={c.id} info={info} initial={c} />
            ))}
          </ul>
          {info.http_stable && token ? (
            <Snippet
              label="Direct HTTP"
              hint="This daemon keeps its address and token between launches"
              text={httpCommand(info, token)}
            />
          ) : null}
          {moving ? (
            <p className="mcp-note" role="note">
              This copy of Graite runs from an AppImage, which gets a new location every time it
              starts, and its file could not be found. Start Graite by opening the .AppImage file
              itself, or install the .deb or .rpm package.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** Settings → AI connectors: AI apps in the browser first, apps on this computer second. */
export function ConnectorsCard() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  useEffect(() => {
    let live = true;
    void mcp
      .info()
      .then((value) => live && setInfo(value))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, []);
  if (!info) return null;
  return (
    <div className="connectors">
      <BrowserConnector initial={info.remote} />
      <LocalApps info={info} />
    </div>
  );
}
