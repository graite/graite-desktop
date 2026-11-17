import { FolderOpen, Inbox, ShieldCheck, type LucideIcon } from "lucide-react";

/** How Graite works, in three ideas: on the welcome page and in the onboarding. */
export const PRINCIPLES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: FolderOpen,
    title: "Your pages are files",
    text: "Plain Markdown in a folder you choose. They open in any editor.",
  },
  {
    icon: ShieldCheck,
    title: "You choose where AI runs",
    text: "On this computer, in the cloud, or in an app like Claude. You decide per page.",
  },
  {
    icon: Inbox,
    title: "AI suggests, you decide",
    text: "Changes arrive as proposals. Nothing changes until you accept.",
  },
];
