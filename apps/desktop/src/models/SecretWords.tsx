import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Check, Copy } from "lucide-react";

export const WORD_COUNT = 6;

/** The six secret words, each in its own numbered block with a copy button, and one button
 * that copies them all, to read off or paste on the other computer. */
export function WordBlocks({ words }: { words: string }) {
  // Which word was copied last ("all" for the whole set), to show a tick for a moment.
  const [copied, setCopied] = useState<number | "all" | null>(null);
  const copy = (text: string, what: number | "all") => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied((now) => (now === what ? null : now)), 1500);
    });
  };
  return (
    <div className="sync-words-box">
      <ol className="sync-words" aria-label="Six secret words">
        {words.split(/\s+/).map((word, i) => (
          <li key={i}>
            <small>{i + 1}</small>
            <span>{word}</span>
            <button
              type="button"
              aria-label={`Copy word ${i + 1}`}
              title="Copy"
              onClick={() => copy(word, i)}
            >
              {copied === i ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="sync-words-all" onClick={() => copy(words, "all")}>
        {copied === "all" ? <Check size={13} /> : <Copy size={13} />}
        {copied === "all" ? "Copied" : "Copy all six"}
      </button>
    </div>
  );
}

/** Six small fields for the six words. Space or Enter moves on, Backspace in an empty field
 * goes back, and pasting all six fills them at once. `value` is the words joined by spaces. */
export function WordInputs({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const fields = useRef<(HTMLInputElement | null)[]>([]);
  const words = value.split(" ");
  while (words.length < WORD_COUNT) words.push("");
  const set = (next: string[]) => onChange(next.slice(0, WORD_COUNT).join(" ").trimEnd());
  const focus = (i: number) => fields.current[Math.max(0, Math.min(WORD_COUNT - 1, i))]?.focus();

  /** Put several words in, starting at field `from`: a paste, or typing with a space in it. */
  const spread = (from: number, text: string) => {
    const typed = text
      .toLowerCase()
      .split(/[\s,-]+/)
      .filter(Boolean);
    const next = [...words];
    typed.forEach((word, k) => {
      if (from + k < WORD_COUNT) next[from + k] = word;
    });
    set(next);
    focus(from + typed.length);
  };
  const change = (i: number, text: string) => {
    if (/[\s,-]/.test(text)) return spread(i, text + " ");
    const next = [...words];
    next[i] = text.toLowerCase();
    set(next);
  };
  const keyDown = (i: number, event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === " " || event.key === "Enter") && i < WORD_COUNT - 1 && words[i]) {
      event.preventDefault();
      focus(i + 1);
    } else if (event.key === "Backspace" && !words[i] && i > 0) {
      event.preventDefault();
      focus(i - 1);
    }
  };
  const paste = (i: number, event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    spread(i, event.clipboardData.getData("text"));
  };

  return (
    <div className="sync-words" role="group" aria-label="Six secret words">
      {words.slice(0, WORD_COUNT).map((word, i) => (
        <label key={i}>
          <small>{i + 1}</small>
          <input
            ref={(element) => {
              fields.current[i] = element;
            }}
            type="text"
            aria-label={`Word ${i + 1}`}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={word}
            onChange={(e) => change(i, e.target.value)}
            onKeyDown={(e) => keyDown(i, e)}
            onPaste={(e) => paste(i, e)}
          />
        </label>
      ))}
    </div>
  );
}
