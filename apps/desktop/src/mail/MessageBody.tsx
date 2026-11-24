import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ImageIcon, Link2, MoreHorizontal } from "lucide-react";
import {
  mail,
  mailDocument,
  mailTone,
  markQuoted,
  shortenLinks,
  shortLink,
  splitQuoted,
  textWithLinks,
} from "@/lib/mail";

const WEB_LINK = /^(https?:|mailto:)/i;
const IMAGES_KEY = "graite.mail.images";
// A mail taller than this opens cut off, with a button for the rest.
const CUT_PX = 420;

function alwaysShow(): boolean {
  try {
    return localStorage.getItem(IMAGES_KEY) === "always";
  } catch {
    return false;
  }
}

/**
 * One mail's body. HTML mail goes into a frame that runs no scripts and loads nothing from
 * the network. Pictures the mail links to are fetched only when asked for (once, or always),
 * because fetching them tells the sender the mail was opened. The mail it quotes is folded
 * away behind "…": that keeps a long back-and-forth short.
 */
export function MessageBody({
  html,
  text,
  fold = true,
}: {
  html: string;
  text: string;
  /** Fold the mail this one quotes away (not for a forward, where the quote is the point). */
  fold?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);
  const [showQuoted, setShowQuoted] = useState(false);
  const [whole, setWhole] = useState(false);
  const plain = useRef<HTMLPreElement>(null);
  const [plainTall, setPlainTall] = useState(false);
  const [hasQuoted, setHasQuoted] = useState(false);
  const [remote, setRemote] = useState(0);
  const [pictures, setPictures] = useState<"hidden" | "shown">(() =>
    alwaysShow() ? "shown" : "hidden",
  );
  const fetched = useRef(new Map<string, string>());
  const wired = useRef(new WeakSet<Document>());
  // The app's theme, also when it changes while a mail is open.
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const root = document.documentElement;
    const watch = new MutationObserver(() => setDark(root.classList.contains("dark")));
    watch.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => watch.disconnect();
  }, []);
  const hide = fold && !showQuoted;

  useEffect(() => {
    const urls = fetched.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let observer: ResizeObserver | null = null;
    let live = true;
    const ready = () => {
      const doc = element.contentDocument;
      if (!doc?.body) return;
      // The body's own height: the document's never gets smaller than the frame is now.
      const measure = () =>
        setHeight(Math.min(Math.ceil(doc.body.getBoundingClientRect().height) + 2, 20_000));
      measure();
      observer?.disconnect();
      observer = new ResizeObserver(measure);
      observer.observe(doc.body);
      shortenLinks(doc);
      setHasQuoted(fold && markQuoted(doc));
      doc.body.toggleAttribute("data-fold", hide);
      // The mail on the app's own background: a light mail is turned dark in the dark
      // theme, and a mail that brings a dark page is turned light in the light theme.
      if (!doc.body.dataset.tone) doc.body.dataset.tone = mailTone(doc);
      const ownDark = doc.body.dataset.tone === "dark";
      doc.body.toggleAttribute("data-flip", dark !== ownDark);
      // In the dark theme white lands on the app's near-black, not on pure black.
      doc.body.style.setProperty("--flip", dark ? "0.96" : "1");
      // A frame whose colour scheme differs from the app's gets an opaque white canvas from
      // the browser; with the same scheme it stays see-through, on the app's background.
      doc.documentElement.style.colorScheme = dark ? "dark" : "light";
      const linked = [...doc.querySelectorAll<HTMLImageElement>('img[src^="http"]')];
      setRemote(linked.length);
      if (pictures === "shown")
        for (const image of linked) {
          const source = image.getAttribute("src") ?? "";
          const known = fetched.current.get(source);
          if (known) {
            image.src = known;
            continue;
          }
          void mail
            .image(source)
            .then((blob) => {
              if (!live) return;
              const local = URL.createObjectURL(blob);
              fetched.current.set(source, local);
              image.src = local;
            })
            .catch(() => {});
        }
      // Once per document: this runs again when pictures are shown.
      if (wired.current.has(doc)) return;
      wired.current.add(doc);
      doc.addEventListener("click", (event) => {
        const link = (event.target as Element | null)?.closest?.("a");
        if (!link) return;
        event.preventDefault();
        const href = link.getAttribute("href") ?? "";
        if (WEB_LINK.test(href)) window.open(href, "_blank", "noopener");
      });
    };
    element.addEventListener("load", ready);
    ready();
    return () => {
      live = false;
      element.removeEventListener("load", ready);
      observer?.disconnect();
    };
  }, [html, hide, pictures, fold, dark]);

  useEffect(() => {
    const element = plain.current;
    if (element) setPlainTall(element.scrollHeight > CUT_PX + 80);
  }, [text, showQuoted, html]);

  const quotedToggle = (shown: boolean) => (
    <button
      type="button"
      className="mt-2 flex h-4 items-center rounded-full bg-muted px-1.5 text-muted-foreground hover:bg-accent"
      title={shown ? "Hide the quoted mail" : "Show the quoted mail"}
      aria-label={shown ? "Hide quoted text" : "Show quoted text"}
      aria-expanded={shown}
      onClick={() => setShowQuoted(!shown)}
    >
      <MoreHorizontal size={14} />
    </button>
  );

  const more = (tall: boolean) =>
    tall && (
      <button
        type="button"
        className="mt-1 flex w-full items-center justify-center gap-1 rounded-md py-1 text-xs text-muted-foreground hover:bg-accent"
        aria-expanded={whole}
        onClick={() => setWhole(!whole)}
      >
        {whole ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        {whole ? "Show less" : "Show the whole mail"}
      </button>
    );
  const cut = (tall: boolean): React.CSSProperties =>
    tall && !whole
      ? {
          maxHeight: CUT_PX,
          overflow: "hidden",
          maskImage: "linear-gradient(to bottom, black calc(100% - 48px), transparent)",
        }
      : {};

  if (!html) {
    const parts = fold ? splitQuoted(text) : { own: text, quoted: "" };
    return (
      <>
        <pre
          ref={plain}
          style={cut(plainTall)}
          className="font-sans text-[13px] leading-relaxed break-words whitespace-pre-wrap"
        >
          {textWithLinks(showQuoted || !parts.quoted ? text : parts.own).map((part, index) =>
            "url" in part ? (
              <a
                key={index}
                href={part.url}
                title={part.url}
                className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 align-baseline text-[12px] text-foreground no-underline hover:bg-accent"
                onClick={(event) => {
                  event.preventDefault();
                  window.open(part.url, "_blank", "noopener");
                }}
              >
                <Link2 size={11} className="shrink-0 text-muted-foreground" />
                <span className="truncate">{shortLink(part.url)}</span>
              </a>
            ) : (
              part.text
            ),
          )}
        </pre>
        {more(plainTall)}
        {parts.quoted && quotedToggle(showQuoted)}
      </>
    );
  }
  return (
    <>
      {remote > 0 && pictures === "hidden" && (
        <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground">
          <ImageIcon size={13} className="shrink-0" />
          <span>Pictures are not loaded, so the sender cannot see that you opened this.</span>
          <button type="button" className="underline" onClick={() => setPictures("shown")}>
            Show pictures
          </button>
          <button
            type="button"
            className="underline"
            onClick={() => {
              try {
                localStorage.setItem(IMAGES_KEY, "always");
              } catch {
                /* storage unavailable: shown for this mail */
              }
              setPictures("shown");
            }}
          >
            Always show
          </button>
        </p>
      )}
      <iframe
        ref={frame}
        title="Mail content"
        // Same origin so its height can be read; no "allow-scripts", so nothing in it runs.
        sandbox="allow-same-origin"
        srcDoc={mailDocument(html)}
        style={{ height, ...cut(height > CUT_PX + 80) }}
        className="block w-full border-0"
      />
      {more(height > CUT_PX + 80)}
      {hasQuoted && quotedToggle(showQuoted)}
    </>
  );
}
