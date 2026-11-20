import type { ReactNode } from "react";
import {
  ArrowRight,
  Bot,
  Cpu,
  FilePlus,
  Inbox,
  MessageSquare,
  MessageSquareHeart,
  MonitorSmartphone,
  Orbit,
  type LucideIcon,
} from "lucide-react";
import type { Section } from "@/ai/ConversationList";
import type { SettingsTab } from "@/settings/sections";
import { PRINCIPLES } from "./principles";
import { AiAppIcons } from "@/components/AiAppIcons";
import { SettingsArt } from "@/settings/SettingsArt";
import { WelcomeShot, type WelcomeShotName } from "./WelcomeShot";
import "./welcome.css";

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
    <button onClick={step.onClick} className="welcome-start">
      <span className="welcome-start-icon">
        <Icon size={16} />
      </span>
      <strong>{step.title}</strong>
      <span>{step.text}</span>
      <em>{step.action} →</em>
    </button>
  );
}

/** One card of the guide: a close-up of the thing itself, a title, one sentence and where
 * to go. */
function Chapter({
  n,
  title,
  shots = [],
  visual,
  text,
  action,
}: {
  n: number;
  title: string;
  /** One picture, or a few side by side, each with a caption. */
  shots?: [WelcomeShotName, string?][];
  /** Something to show instead of screenshots. */
  visual?: ReactNode;
  text: ReactNode;
  action?: { label: string; onClick: () => void } | false;
}) {
  return (
    <section className="welcome-chapter" aria-labelledby={`welcome-${n}`}>
      {visual ? (
        <div className="welcome-visual">{visual}</div>
      ) : (
        <div className="welcome-shots" data-count={shots.length}>
          {shots.map(([name, caption]) => (
            <WelcomeShot key={name} name={name} caption={caption} />
          ))}
        </div>
      )}
      <div className="welcome-chapter-text">
        <span className="welcome-number">{String(n).padStart(2, "0")}</span>
        <h2 id={`welcome-${n}`}>{title}</h2>
        <p className="welcome-line">{text}</p>
        {action && (
          <button className="welcome-action" onClick={action.onClick}>
            {action.label} <ArrowRight size={14} />
          </button>
        )}
      </div>
    </section>
  );
}

/** First screen in a vault, and the place to come back to: how Graite works, where things
 * are, and where to start. */
export function WelcomePage({
  onCreatePage,
  onSettings,
  onStudio,
  onTemplates,
  onFeedback,
  firstName,
}: {
  onCreatePage: () => void;
  /** Open Settings, on a section when one is named. */
  onSettings: (section?: SettingsTab) => void;
  onStudio: (section: Section) => void;
  /** Open the templates, where the example instructions are. */
  onTemplates?: () => void;
  /** Absent when this build has nowhere to send feedback. */
  onFeedback?: () => void;
  firstName?: string;
}) {
  const steps: Step[] = [
    {
      icon: FilePlus,
      title: "Write your first page",
      text: "Type / in a page for headings, lists, tables and views.",
      action: "New page",
      onClick: onCreatePage,
    },
    {
      icon: Cpu,
      title: "Choose an AI model",
      text: "Graite Cloud, an API key, or local AI on this computer.",
      action: "Open settings",
      onClick: () => onSettings("chat"),
    },
    {
      icon: MessageSquare,
      title: "Ask about your notes",
      text: "Chat searches your pages and shows what it used.",
      action: "Open chat",
      onClick: () => onStudio("chat"),
    },
    {
      icon: Orbit,
      title: "Meet your assistant",
      text: "Talk to it. It remembers what matters to you.",
      action: "Set up the assistant",
      onClick: () => onStudio("assistant"),
    },
    {
      icon: Bot,
      title: "Hand over routine work",
      text: "Agents run on a schedule or when a page changes.",
      action: "Build an agent",
      onClick: () => onStudio("agents"),
    },
    {
      icon: MonitorSmartphone,
      title: "Use it on all your devices",
      text: "Sync a vault between your computers, encrypted.",
      action: "Open Sync devices",
      onClick: () => onSettings("sync"),
    },
    {
      icon: Inbox,
      title: "Stay in control",
      text: "Accept or reject what AI proposes, in one queue.",
      action: "Open the review queue",
      onClick: () => onStudio("review"),
    },
  ];
  return (
    <main className="welcome h-full overflow-auto">
      <div className="welcome-inner">
        <header className="welcome-hero">
          <h1>{firstName ? `Welcome, ${firstName}` : "Welcome to Graite"}</h1>
          <p>Your notes, with AI that works on your terms.</p>
        </header>

        <div className="welcome-principles">
          {PRINCIPLES.map(({ icon: Icon, title, text }) => (
            <div key={title}>
              <span>
                <Icon size={17} />
              </span>
              <strong>{title}</strong>
              <p>{text}</p>
            </div>
          ))}
        </div>

        <div className="welcome-chapters">
          <Chapter
            n={1}
            title="Tabs and page buttons"
            shots={[["overview"]]}
            text={
              <>
                Pages open in tabs. At the top right of each: <b>AI settings</b>, <b>Ask AI</b> and{" "}
                <b>⋯</b>.
              </>
            }
            action={{ label: "Write a page", onClick: onCreatePage }}
          />
          <Chapter
            n={2}
            title="Instructions for AI"
            shots={[["ai-instructions"]]}
            text="Tell AI once how a section works, in plain words. It follows that every time."
            action={onTemplates && { label: "Browse example instructions", onClick: onTemplates }}
          />
          <Chapter
            n={3}
            title="Reviews"
            shots={[["review"]]}
            text={
              <>
                AI never edits a page itself. It proposes; you <b>accept</b> or reject.
              </>
            }
            action={{ label: "Open the review queue", onClick: () => onStudio("review") }}
          />
          <Chapter
            n={4}
            title="Connect to Claude, ChatGPT or others"
            visual={<AiAppIcons size={44} />}
            text="Keep the AI app you already use. Plug Graite in and it knows your pages."
            action={{ label: "Open AI connectors", onClick: () => onSettings("connectors") }}
          />
          <Chapter
            n={5}
            title="Sync your devices"
            visual={<SettingsArt name="sync" size={88} />}
            text="The same pages on all your computers. Share once, type six words on the other. Only your devices can read them."
            action={{ label: "Open Sync devices", onClick: () => onSettings("sync") }}
          />
        </div>

        <h2 className="welcome-start-title">Start here</h2>
        <div className="welcome-starts">
          {steps.map((step) => (
            <StepCard key={step.title} step={step} />
          ))}
        </div>
        {onFeedback && (
          <p className="welcome-feedback">
            <button onClick={onFeedback}>
              <MessageSquareHeart size={15} />
              Send feedback
            </button>{" "}
            Tell us what works, what doesn’t and what you’d like to see.
          </p>
        )}
      </div>
    </main>
  );
}
