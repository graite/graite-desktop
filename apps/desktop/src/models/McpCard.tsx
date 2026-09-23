import { useEffect, useState } from "react";
import { Check, Copy, Plug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { claudeCodeCommand, httpCommand, jsonConfig, mcp, type McpInfo } from "@/lib/mcp";
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

/** How to let MCP clients on this computer (Claude Code, Claude Desktop, Cursor) work with this vault. */
export function McpCard() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [token, setToken] = useState("");
  useEffect(() => {
    let live = true;
    void mcp
      .info()
      .then((value) => {
        if (live) setInfo(value);
      })
      .catch(() => {
        if (live) setInfo(null);
      });
    void platform
      .getDaemonInfo()
      .then((daemon) => {
        if (live) setToken(daemon.token);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!info) return null;
  // An AppImage is mounted at a new path on every start. The daemon hands out the AppImage
  // file itself instead (`<file> mcp`); the mount path only shows up if it could not find it.
  const moving = info.stdio_command.startsWith("/tmp/.mount_");
  const appImage = /\.appimage$/i.test(info.stdio_command);
  return (
    <section className="ai-utilities" aria-label="Connect AI apps">
      <div className="ai-section-heading">
        <h2>Connect AI apps</h2>
        <span>MCP for Claude, Cursor and others on this computer</span>
      </div>
      <div className="mcp-card">
        <p className="mcp-lead">
          <Plug size={16} />
          <span>
            Connected apps can search and read your pages and <strong>propose</strong> changes: new
            pages, edits, moves. Every proposal waits in Review until you accept it, unless the page
            is set to apply AI changes automatically. Pages marked local-only stay hidden from them.
            Graite has to be open.
          </span>
        </p>
        <Snippet label="Claude Code" hint="Run once in a terminal" text={claudeCodeCommand(info)} />
        <Snippet
          label="Claude Desktop · Cursor"
          hint="Add to claude_desktop_config.json or ~/.cursor/mcp.json, then restart the app"
          text={jsonConfig(info)}
        />
        {info.http_stable && token ? (
          <Snippet
            label="Direct HTTP"
            hint="This daemon keeps its address and token between launches"
            text={httpCommand(info, token)}
          />
        ) : null}
        {appImage ? (
          <p className="mcp-note" role="note">
            This keeps working across restarts. If you move or rename the AppImage file, copy the
            setup again.
          </p>
        ) : moving ? (
          <p className="mcp-note" role="note">
            This copy of Graite runs from an AppImage, which gets a new location every time it
            starts, and its file could not be found. Start Graite by opening the .AppImage file
            itself, or install the .deb or .rpm package.
          </p>
        ) : null}
        <p className="mcp-note">Tools: {info.tools.join(", ")}</p>
      </div>
    </section>
  );
}
