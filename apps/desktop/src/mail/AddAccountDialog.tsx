import { useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, HardDrive } from "lucide-react";
import { mail, type MailAccount } from "@/lib/mail";
import { useMicrosoftSignIn } from "./useMicrosoftSignIn";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const field = "w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1";

type Kind = "gmail" | "workspace" | "microsoft" | "icloud" | "other";

const KINDS: { kind: Kind; title: string; detail: string }[] = [
  { kind: "gmail", title: "Gmail", detail: "A personal address ending in @gmail.com" },
  {
    kind: "workspace",
    title: "Google Workspace",
    detail: "Gmail from work or school, with your organisation’s own address",
  },
  {
    kind: "microsoft",
    title: "Microsoft",
    detail: "Outlook.com, Hotmail, Live, or Microsoft 365 from work or school",
  },
  { kind: "icloud", title: "iCloud Mail", detail: "@icloud.com, @me.com or @mac.com" },
  {
    kind: "other",
    title: "Another provider",
    detail: "Fastmail, Proton (with Bridge), your own domain, anything with IMAP",
  },
];

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="underline underline-offset-2"
      onClick={() => window.open(href, "_blank", "noopener")}
    >
      {children}
    </button>
  );
}

const HELP = {
  googleTwoStep: "https://support.google.com/accounts/answer/185839",
  googleAppPasswords: "https://support.google.com/accounts/answer/185833",
  googleAdminImap: "https://support.google.com/a/answer/105694",
  appleAppPasswords: "https://support.apple.com/102654",
  microsoftSignIn:
    "https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d",
};

/** Said wherever an account is added: where the mail is kept. */
export const STAYS_LOCAL =
  "Your mail stays on this computer. It is never sent to or stored on a Graite server.";

const GOOGLE_STEPS = (
  <>
    <li>
      Turn on 2-Step Verification for your Google account, if it is not on yet:{" "}
      <Link href="https://myaccount.google.com/signinoptions/twosv">
        myaccount.google.com → Security → 2-Step Verification
      </Link>
      . (<Link href={HELP.googleTwoStep}>Google’s instructions</Link>)
    </li>
    <li>
      Open <Link href="https://myaccount.google.com/apppasswords">App passwords</Link>, type{" "}
      <b>Graite</b> as the name and press Create. (
      <Link href={HELP.googleAppPasswords}>Google’s instructions</Link>)
    </li>
    <li>Google shows a password of 16 letters. Copy it and paste it below.</li>
  </>
);

function LocalNote() {
  return (
    <p className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
      <HardDrive className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      {STAYS_LOCAL}
    </p>
  );
}

/** What to do before the form can be filled in, per kind of account. */
function Steps({ kind }: { kind: Kind }) {
  if (kind === "gmail")
    return (
      <>
        <p>
          Google does not let mail apps sign in with your normal password. You make a separate
          password that only Graite uses, and you can take it away again at any time.
        </p>
        <ol className="grid list-decimal gap-1.5 pl-5">{GOOGLE_STEPS}</ol>
      </>
    );
  if (kind === "workspace")
    return (
      <>
        <p>
          The steps are the same as for a personal Gmail address, but your organisation decides
          whether they are allowed.
        </p>
        <ol className="grid list-decimal gap-1.5 pl-5">{GOOGLE_STEPS}</ol>
        <p>
          If Google says “The setting you are looking for is not available for your account”, your
          administrator has switched app passwords off. Ask them to allow app passwords and IMAP for
          your account (<Link href={HELP.googleAdminImap}>Google’s page for administrators</Link>).
          Signing in with Google, which does not need this, is not in Graite yet.
        </p>
      </>
    );
  if (kind === "icloud")
    return (
      <ol className="grid list-decimal gap-1.5 pl-5">
        <li>
          Go to <Link href="https://account.apple.com">account.apple.com</Link> and sign in.
        </li>
        <li>
          Open Sign-In and Security → App-Specific Passwords, add one and name it <b>Graite</b>. (
          <Link href={HELP.appleAppPasswords}>Apple’s instructions</Link>)
        </li>
        <li>Copy the password Apple shows and paste it below.</li>
      </ol>
    );
  if (kind === "microsoft")
    return (
      <>
        <p>
          Microsoft does not let mail apps sign in with a password. You sign in on Microsoft’s own
          page instead; Graite never sees your password. (
          <Link href={HELP.microsoftSignIn}>Microsoft’s explanation</Link>)
        </p>
        <ol className="grid list-decimal gap-1.5 pl-5">
          <li>Press “Sign in with Microsoft”. Your browser opens Microsoft’s sign-in page.</li>
          <li>Choose your account and sign in as you normally do.</li>
          <li>
            Microsoft asks whether Graite may read and send your mail. Choose Accept, then come back
            here.
          </li>
        </ol>
        <p>
          A work or school account may say that an administrator has to approve Graite first. Then
          only your organisation’s IT can let it in.
        </p>
      </>
    );
  return (
    <p>
      You need the address of your provider’s incoming mail (IMAP) server and a password. Many
      providers ask you to make an app password in your account’s security settings; search their
      help pages for “IMAP”.
    </p>
  );
}

export function AddAccountDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (account: MailAccount) => void;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const microsoft = useMicrosoftSignIn(async (accountId) => {
    const found = (await mail.accounts()).accounts.find((a) => a.id === accountId);
    reset();
    if (found) onAdded(found);
  });

  const reset = () => {
    setKind(null);
    setEmail("");
    setPassword("");
    setName("");
    setHost("");
    setPort("993");
    setUsername("");
    setError("");
  };
  const close = () => {
    if (busy) return;
    microsoft.stop();
    reset();
    onClose();
  };

  const google = kind === "gmail" || kind === "workspace";
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const account = await mail.add({
        email: email.trim(),
        // Google shows its app passwords in four groups; the spaces are not part of it.
        password: google ? password.replace(/\s+/g, "") : password,
        name: name.trim() || undefined,
        host: google ? "imap.gmail.com" : host.trim() || undefined,
        port: kind === "other" && Number(port) ? Number(port) : undefined,
        username: username.trim() || undefined,
      });
      reset();
      onAdded(account);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chosen = KINDS.find((k) => k.kind === kind);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {!chosen ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Add a mail account</DialogTitle>
              <DialogDescription>
                Graite keeps a copy of your last 90 days of mail and only reads: nothing is marked,
                moved or deleted in your mailbox. Which kind of account is it?
              </DialogDescription>
            </DialogHeader>
            <LocalNote />
            <div className="grid gap-2">
              {KINDS.map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  className="flex items-center gap-3 rounded-lg border px-4 py-3 text-left hover:bg-accent"
                  onClick={() => setKind(item.kind)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{item.title}</span>
                    <span className="block text-xs text-muted-foreground">{item.detail}</span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{chosen.title}</DialogTitle>
              <DialogDescription>{chosen.detail}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 rounded-lg bg-muted/50 px-4 py-3 text-sm">
              <Steps kind={chosen.kind} />
            </div>
            <LocalNote />
            {chosen.kind !== "microsoft" && (
              <>
                <label className="grid gap-1.5 text-sm">
                  Email address
                  <input
                    className={field}
                    type="email"
                    required
                    autoFocus
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  {chosen.kind === "other" ? "Password" : "App password"}
                  <input
                    className={field}
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">
                    Stored in your system keychain, never in a file.
                  </span>
                </label>
                {chosen.kind === "other" && (
                  <div className="grid grid-cols-[1fr_6rem] gap-3">
                    <label className="grid gap-1.5 text-sm">
                      Incoming mail (IMAP) server
                      <input
                        className={field}
                        placeholder="imap.example.com"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm">
                      Port
                      <input
                        className={field}
                        inputMode="numeric"
                        value={port}
                        onChange={(e) => setPort(e.target.value)}
                      />
                    </label>
                    <label className="col-span-2 grid gap-1.5 text-sm">
                      Username, if it is not the email address
                      <input
                        className={field}
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                      />
                    </label>
                  </div>
                )}
                <label className="grid gap-1.5 text-sm">
                  Name in Graite (optional)
                  <input
                    className={field}
                    placeholder="Work, Private…"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              </>
            )}
            {chosen.kind === "microsoft" && microsoft.waiting && (
              <div className="grid gap-1.5 text-sm" role="status">
                <p>Waiting for you to sign in in your browser…</p>
                <p className="text-xs text-muted-foreground">
                  No browser window?{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void navigator.clipboard.writeText(microsoft.waiting ?? "")}
                  >
                    Copy the sign-in link
                  </button>{" "}
                  and open it in your browser on this computer.
                </p>
              </div>
            )}
            {(error || (chosen.kind === "microsoft" && microsoft.error)) && (
              <p role="alert" className="text-sm text-destructive">
                {error || microsoft.error}
              </p>
            )}
            <DialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  microsoft.stop();
                  setKind(null);
                }}
                disabled={busy}
              >
                <ArrowLeft /> Back
              </Button>
              {chosen.kind === "microsoft" ? (
                <Button
                  type="button"
                  disabled={microsoft.waiting !== null}
                  onClick={() => void microsoft.start()}
                >
                  {microsoft.waiting ? "Waiting…" : "Sign in with Microsoft"}
                </Button>
              ) : (
                <Button type="submit" disabled={busy || !email || !password}>
                  {busy ? "Signing in…" : "Add account"}
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
