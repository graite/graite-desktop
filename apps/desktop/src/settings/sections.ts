import {
  AudioLines,
  Cloud,
  FileText,
  KeyRound,
  Monitor,
  Plug,
  Search,
  Server,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import type { AIConfig } from "@/lib/ai";
import { hostOf } from "@/lib/connections";

export type SettingsSection =
  | "general"
  | "local"
  | "server"
  | "voice"
  | "search"
  | "documents"
  | "graite"
  | "connectors"
  | "keys";

/** A section, or a name from before Settings had a sidebar: "chat" opens whichever section
 * holds the model chat uses, "vault" is part of General. */
export type SettingsTab = SettingsSection | "chat" | "vault";

export interface NavItem {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  /** Shown indented under the item before it. */
  sub?: boolean;
}

export const NAV: { title?: string; items: NavItem[] }[] = [
  { items: [{ id: "general", label: "General", icon: Settings2 }] },
  {
    title: "Local AI",
    items: [
      { id: "local", label: "On this computer", icon: Monitor },
      { id: "voice", label: "Speech", icon: AudioLines, sub: true },
      { id: "search", label: "Search", icon: Search, sub: true },
      { id: "documents", label: "Documents", icon: FileText, sub: true },
      { id: "server", label: "Your own server", icon: Server },
    ],
  },
  { title: "Graite", items: [{ id: "graite", label: "Graite Cloud", icon: Cloud }] },
  { title: "Your AI apps", items: [{ id: "connectors", label: "AI connectors", icon: Plug }] },
  { title: "Your own keys", items: [{ id: "keys", label: "API keys", icon: KeyRound }] },
];

export const SECTIONS: SettingsSection[] = NAV.flatMap((group) => group.items.map((i) => i.id));

export function sectionLabel(id: SettingsSection): string {
  return NAV.flatMap((group) => group.items).find((i) => i.id === id)?.label ?? "Settings";
}

/** A loopback address: the server is on this computer. */
export function isThisComputer(host: string): boolean {
  return /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/.test(host);
}

/** An address on this computer or on a private network: infrastructure the user runs. */
export function isOwnNetwork(host: string): boolean {
  if (!host) return false;
  return (
    isThisComputer(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /\.(local|lan|internal|home\.arpa)$/.test(host) ||
    !host.includes(".")
  );
}

/** The section that holds the model this config chats with. */
export function chatSection(config: Pick<AIConfig, "provider" | "base_url">): SettingsSection {
  if (config.provider === "local") return "local";
  if (config.provider === "graite") return "graite";
  if (config.provider === "anthropic") return "keys";
  return isOwnNetwork(hostOf(config.base_url)) ? "server" : "keys";
}

export function resolveSection(
  tab: SettingsTab,
  config: Pick<AIConfig, "provider" | "base_url"> | null,
): SettingsSection {
  if (tab === "vault") return "general";
  if (tab === "chat") return config ? chatSection(config) : "local";
  return tab;
}
