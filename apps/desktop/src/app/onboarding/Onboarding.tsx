import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  Copy,
  FilePlus,
  FileText,
  Keyboard,
  Loader2,
  MousePointerClick,
  Search,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { AiAppIcons } from "@/components/AiAppIcons";
import { Button } from "@/components/ui/button";
import { templates, type Template } from "@/lib/templates";
import { useCloudSignIn } from "@/lib/useCloudSignIn";
import { NameQuestion, saveFirstName } from "../FirstRunName";
import { WelcomeShot, type WelcomeShotName } from "../WelcomeShot";
import "../welcome.css";
import "./onboarding.css";

export const STEPS = [
  "name",
  "welcome",
  "basics",
  "connect",
  "settings",
  "review",
  "account",
  "page",
] as const;
export type StepId = (typeof STEPS)[number];

export interface OnboardingResult {
  /** The page made in the last step, to open. */
  createdPath?: string;
}

interface Nav {
  back?: () => void;
  next: () => void;
  finish: (result?: OnboardingResult) => void;
}

/** The first run, once per computer: the name, a welcome, the basics, connecting AI apps, a
 * page's AI settings, reviewing changes, the Graite account and a first page. Every step can be passed;
 * the last one ends it. */
export function Onboarding({
  initialName = "",
  onFinish,
  onCreateBlankPage,
}: {
  initialName?: string;
  /** Done or skipped; with the path of the page made in the last step, if any. */
  onFinish: (result: OnboardingResult) => void;
  /** Make an empty page; returns its path. */
  onCreateBlankPage: () => Promise<string>;
}) {
  const [index, setIndex] = useState(0);
  const [firstName, setFirstName] = useState(initialName);
  const step = STEPS[index];
  const nav: Nav = {
    back: index > 0 ? () => setIndex(index - 1) : undefined,
    next: () => setIndex(Math.min(index + 1, STEPS.length - 1)),
    finish: (result = {}) => onFinish(result),
  };
  return (
    <main className="welcome onboarding h-full overflow-auto">
      <div className="onboarding-inner">
        <ol className="onboarding-dots" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
          {STEPS.map((id, i) => (
            <li key={id} data-state={i === index ? "current" : i < index ? "done" : undefined} />
          ))}
        </ol>
        {step === "name" ? (
          <NameStep initial={firstName} onSaved={setFirstName} nav={nav} />
        ) : step === "welcome" ? (
          <WelcomeStep firstName={firstName} nav={nav} />
        ) : step === "basics" ? (
          <BasicsStep nav={nav} />
        ) : step === "connect" ? (
          <ConnectStep nav={nav} />
        ) : step === "settings" ? (
          <SettingsStep nav={nav} />
        ) : step === "review" ? (
          <ReviewStep nav={nav} />
        ) : step === "account" ? (
          <AccountStep nav={nav} />
        ) : (
          <PageStep nav={nav} onCreateBlankPage={onCreateBlankPage} />
        )}
      </div>
    </main>
  );
}

function Footer({
  nav,
  onSkip,
  primary,
  busy,
}: {
  nav: Nav;
  onSkip?: () => void;
  /** The step's main button; Continue by default. */
  primary?: { label: string; onClick: () => void; disabled?: boolean } | null;
  busy?: boolean;
}) {
  const main = primary === undefined ? { label: "Continue", onClick: nav.next } : primary;
  return (
    <footer className="onboarding-footer">
      {nav.back && (
        <Button type="button" variant="ghost" disabled={busy} onClick={nav.back}>
          Back
        </Button>
      )}
      <span className="flex-1" />
      {onSkip && (
        <Button type="button" variant="ghost" disabled={busy} onClick={onSkip}>
          Skip
        </Button>
      )}
      {main && (
        <Button type="button" disabled={busy || main.disabled} onClick={main.onClick}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          {main.label}
        </Button>
      )}
    </footer>
  );
}

function Shots({ shots }: { shots: [WelcomeShotName, string?][] }) {
  return (
    <div className="welcome-shots onboarding-shots" data-count={shots.length}>
      {shots.map(([name, caption]) => (
        <WelcomeShot key={name} name={name} caption={caption} />
      ))}
    </div>
  );
}

function Text({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="onboarding-text">
      <h1>{title}</h1>
      {children}
    </div>
  );
}

function NameStep({
  initial,
  onSaved,
  nav,
}: {
  initial: string;
  onSaved: (name: string) => void;
  nav: Nav;
}) {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (saving) return;
    setSaving(true);
    const saved = await saveFirstName(name);
    setSaving(false);
    if (saved === null) return;
    if (saved) onSaved(saved);
    nav.next();
  };
  return (
    <form
      className="onboarding-name"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <NameQuestion value={name} onChange={setName} />
      <Footer
        nav={nav}
        busy={saving}
        onSkip={nav.next}
        primary={{ label: "Continue", onClick: () => void submit() }}
      />
    </form>
  );
}

function WelcomeStep({ firstName, nav }: { firstName: string; nav: Nav }) {
  return (
    <>
      <Shots shots={[["overview"]]} />
      <Text title={firstName ? `Welcome aboard, ${firstName}` : "Welcome aboard"}>
        <p>
          Your pages are plain Markdown files on this computer, and they’re yours to keep. AI brings
          suggestions, never surprises: you choose whether changes wait for your review.
        </p>
      </Text>
      <Footer nav={nav} />
    </>
  );
}

const BASICS = [
  {
    icon: Keyboard,
    title: "Type / in a page",
    text: "For headings, lists, tables, views and more.",
  },
  {
    icon: Search,
    title: "Press ⌘K or Ctrl+K",
    text: "Find any page by its title or text, from anywhere.",
  },
  {
    icon: MousePointerClick,
    title: "Pages open in tabs",
    text: "Ctrl+click or ⌘-click a page to open it next to the one you have.",
  },
  {
    icon: Sparkles,
    title: "Ask AI",
    text: "At the top right of every page: ask about it, or about all your notes.",
  },
  {
    icon: FileText,
    title: "Scans and recordings",
    text: "Add a PDF, image or recording to a page and Graite turns it into text.",
  },
] as const;

function BasicsStep({ nav }: { nav: Nav }) {
  return (
    <>
      <Text title="The basics">
        <p>Five things that make everything else easier.</p>
      </Text>
      <ul className="onboarding-basics">
        {BASICS.map(({ icon: Icon, title, text }) => (
          <li key={title}>
            <span>
              <Icon size={17} />
            </span>
            <div>
              <strong>{title}</strong>
              <p>{text}</p>
            </div>
          </li>
        ))}
      </ul>
      <Footer nav={nav} />
    </>
  );
}

function ConnectStep({ nav }: { nav: Nav }) {
  return (
    <>
      <div className="onboarding-apps">
        <AiAppIcons size={44} />
      </div>
      <Text title="Connect to Claude, ChatGPT or others">
        <p>
          With <b>AI connectors</b>, the AI app you already use can read your pages and propose
          changes. Whether a change waits for your review is up to each page’s AI settings.
        </p>
        <p>
          Graite’s own AI runs in <b>Graite Cloud</b>, so it works without installing anything.
          Prefer this computer? Under <b>Settings → Local AI</b>, each task has its own{" "}
          <b>Use local AI on my computer</b> switch.
        </p>
      </Text>
      <Footer nav={nav} />
    </>
  );
}

function SettingsStep({ nav }: { nav: Nav }) {
  return (
    <>
      <Shots shots={[["ai-instructions"]]} />
      <Text title="AI settings for every page">
        <p>
          Each page has <b>AI settings</b>. Write instructions in plain language: the tone, what a
          new page looks like, what to check. AI follows them every time.
        </p>
        <p>
          Choose who may read the page: <b>Cloud and local AI</b>, <b>Local models only</b> or{" "}
          <b>No AI</b>. Subpages follow the same settings.
        </p>
      </Text>
      <Footer nav={nav} />
    </>
  );
}

function ReviewStep({ nav }: { nav: Nav }) {
  return (
    <>
      <Shots shots={[["review"]]} />
      <Text title="Review changes, or let AI apply them">
        <p>
          You decide per page what happens to AI’s changes. They can <b>wait for your review</b>,
          shown right in the page for you to accept or reject, or be <b>applied directly</b>. Set it
          in the page’s AI settings; subpages follow.
        </p>
        <p>
          The <b>Studio</b> is where you ask questions about your notes, set up agents for routine
          work, and find every change waiting for you.
        </p>
      </Text>
      <Footer nav={nav} />
    </>
  );
}

function AccountStep({ nav }: { nav: Nav }) {
  const { status, waiting, error, copied, signIn, copyLink, cancel } = useCloudSignIn();
  const signedIn = !!status?.signed_in;
  return (
    <>
      <img src="/logo-graite.svg" alt="Graite" className="onboarding-logo dark:invert" />
      <Text title="Your Graite account">
        <p>Free, and it comes with:</p>
        <ul>
          <li>Graite’s AI for chat, document reading and speech-to-text.</li>
          <li>AI connectors, so Claude or ChatGPT can work with your pages.</li>
        </ul>
        <p className="onboarding-note">Prefer to wait? Settings has you covered later.</p>
      </Text>
      <div className="onboarding-account">
        {error && (
          <p className="onboarding-error" role="alert">
            {error}
          </p>
        )}
        {signedIn ? (
          <p className="onboarding-success" role="status">
            <Check size={15} /> Signed in{status?.email ? ` as ${status.email}` : ""}.
          </p>
        ) : waiting ? (
          <div className="onboarding-waiting" role="status">
            <p>
              <Loader2 size={14} className="animate-spin" />
              <span>
                <strong>Finish in your browser.</strong> This screen updates by itself.
              </span>
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void copyLink()}>
                {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
                {copied ? "Copied" : "Copy link"}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : !status && !error ? (
          <p className="onboarding-muted">
            <Loader2 size={14} className="animate-spin" /> Checking your Graite account…
          </p>
        ) : (
          <div className="flex gap-2">
            <Button type="button" onClick={() => void signIn(true)}>
              Create an account
            </Button>
            <Button type="button" variant="outline" onClick={() => void signIn(false)}>
              Sign in
            </Button>
          </div>
        )}
      </div>
      <Footer
        nav={nav}
        onSkip={signedIn ? undefined : nav.next}
        primary={{ label: "Continue", onClick: nav.next, disabled: !signedIn }}
      />
    </>
  );
}

function PageStep({
  nav,
  onCreateBlankPage,
}: {
  nav: Nav;
  onCreateBlankPage: () => Promise<string>;
}) {
  const [list, setList] = useState<Template[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // the slug being made, or "blank"
  useEffect(() => {
    let live = true;
    templates
      .list()
      .then((t) => live && setList(t))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, []);
  const make = async (key: string, create: () => Promise<string>) => {
    if (busy) return;
    setBusy(key);
    try {
      nav.finish({ createdPath: await create() });
    } catch (e) {
      toast.error(`Could not create the page: ${(e as Error).message}`);
      setBusy(null);
    }
  };
  return (
    <>
      <Text title="Your first page">
        <p>
          Start with a blank page, or with a template. Templates come with example data you can
          delete later.
        </p>
      </Text>
      <div className="onboarding-templates" aria-busy={!list || !!busy}>
        <button
          type="button"
          className="onboarding-template"
          disabled={!!busy}
          onClick={() => void make("blank", onCreateBlankPage)}
        >
          <span className="onboarding-template-icon">
            {busy === "blank" ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <FilePlus size={18} />
            )}
          </span>
          <strong>Blank page</strong>
          <span>An empty page to write in.</span>
        </button>
        {list?.map((t) => (
          <button
            key={t.slug}
            type="button"
            className="onboarding-template"
            disabled={!!busy}
            onClick={() =>
              void make(t.slug, () =>
                templates
                  .use(t.slug, { parentPath: "", title: t.name, sampleData: true })
                  .then((page) => page.path),
              )
            }
          >
            <span className="onboarding-template-icon">
              {busy === t.slug ? <Loader2 size={18} className="animate-spin" /> : t.icon}
            </span>
            <strong>{t.name}</strong>
            <span>{t.description}</span>
          </button>
        ))}
        {!list && (
          <p className="onboarding-muted">
            <Loader2 size={14} className="animate-spin" /> Loading templates…
          </p>
        )}
      </div>
      <Footer nav={nav} busy={!!busy} onSkip={() => nav.finish()} primary={null} />
    </>
  );
}
