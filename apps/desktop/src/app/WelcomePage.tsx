import type { ReactNode } from "react";
import {
  Bot,
  Cpu,
  FilePlus,
  Inbox,
  MessageSquare,
  MessageSquareHeart,
  Orbit,
  type LucideIcon,
} from "lucide-react";
import type { Section } from "@/ai/ConversationList";

interface Step {
  icon: LucideIcon;
  title: string;
  text: string;
  action: string;
  onClick: () => void;
}

function StepCard({ step }: { step: Step }) {
  const Icon = step.icon;
  return (
    <button
      onClick={step.onClick}
      className="group flex items-start gap-4 rounded-lg border p-4 text-left hover:bg-accent"
    >
      <span className="mt-0.5 rounded-md bg-muted p-2 text-muted-foreground group-hover:text-foreground">
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{step.title}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{step.text}</span>
        <span className="mt-2 block text-xs font-medium">{step.action} →</span>
      </span>
    </button>
  );
}

/** First screen in a vault, and the place to come back to: what Graite does and where to start. */
export function WelcomePage({
  onCreatePage,
  onSettings,
  onStudio,
  onFeedback,
}: {
  onCreatePage: () => void;
  onSettings: () => void;
  onStudio: (section: Section) => void;
  /** Absent when this build has nowhere to send feedback. */
  onFeedback?: () => void;
}) {
  const steps: Step[] = [
    {
      icon: FilePlus,
      title: "Write your first page",
      text: "Pages are plain Markdown files in this folder, so they also open in Obsidian or any text editor. Type / in a page for headings, lists, tables and views.",
      action: "New page",
      onClick: onCreatePage,
    },
    {
      icon: Cpu,
      title: "Choose an AI model",
      text: "Download a model that runs on this computer, or connect an online one. Nothing leaves your computer unless you choose an online model.",
      action: "Open settings",
      onClick: onSettings,
    },
    {
      icon: MessageSquare,
      title: "Ask about your notes",
      text: "Chat with an AI that searches and reads your pages to answer.",
      action: "Open chat",
      onClick: () => onStudio("chat"),
    },
    {
      icon: Orbit,
      title: "Meet your assistant",
      text: "A personal assistant you can talk to. It remembers what matters to you and keeps track of your goals.",
      action: "Set up the assistant",
      onClick: () => onStudio("assistant"),
    },
    {
      icon: Bot,
      title: "Let agents do the routine work",
      text: "Agents follow your instructions on a schedule or when a page changes, such as a weekly summary or tidying up meeting notes.",
      action: "Build an agent",
      onClick: () => onStudio("agents"),
    },
    {
      icon: Inbox,
      title: "Stay in control",
      text: "AI suggests changes to your pages, and you accept or reject them in the review queue. Each page’s AI settings decide how much it may do on its own.",
      action: "Open the review queue",
      onClick: () => onStudio("review"),
    },
  ];
  return (
    <main className="h-full overflow-auto px-10 py-12">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-2 text-2xl font-semibold">Welcome to Graite</h1>
        <p className="mb-8 text-sm text-muted-foreground">
          Your notes, with AI that works on this computer. Here are a few places to start. You can
          come back to this page any time from the sidebar.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {steps.map((step) => (
            <StepCard key={step.title} step={step} />
          ))}
        </div>
        {onFeedback && (
          <Footer>
            <button
              className="inline-flex items-center gap-2 font-medium text-foreground underline-offset-4 hover:underline"
              onClick={onFeedback}
            >
              <MessageSquareHeart size={15} />
              Send feedback
            </button>{" "}
            Tell us what works, what doesn’t and what you’d like to see.
          </Footer>
        )}
      </div>
    </main>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <p className="mt-8 flex flex-wrap items-center gap-x-2 border-t pt-6 text-sm text-muted-foreground">
      {children}
    </p>
  );
}
