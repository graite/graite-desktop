import { useEffect, useRef, useState } from "react";
import { Copy, PencilLine, X } from "lucide-react";
import { toast } from "sonner";
import { mail } from "@/lib/mail";
import { MENU } from "./menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface Recipient {
  name: string;
  email: string;
}

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** "Kim Roofer <kim@x>, sam@y" as people. Text that is no address is kept as it is, with an
 * empty `email`, so nothing typed is lost and it shows as something to fix. */
export function parseRecipients(text: string): Recipient[] {
  const found: Recipient[] = [];
  // Split on commas and semicolons that are not inside quotes or angle brackets.
  let part = "";
  let quoted = false;
  let angle = false;
  const parts: string[] = [];
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (char === "<" && !quoted) angle = true;
    else if (char === ">" && !quoted) angle = false;
    if ((char === "," || char === ";") && !quoted && !angle) {
      parts.push(part);
      part = "";
    } else part += char;
  }
  parts.push(part);
  for (const raw of parts) {
    const piece = raw.trim();
    if (!piece) continue;
    const match = piece.match(/^(.*?)<\s*([^<>]+?)\s*>$/);
    if (match) {
      const name = match[1]!
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim();
      found.push({ name, email: match[2]!.trim() });
    } else if (EMAIL.test(piece)) found.push({ name: "", email: piece });
    else found.push({ name: piece, email: "" });
  }
  return found;
}

export function formatRecipients(list: Recipient[]): string {
  return list
    .map((person) => {
      if (!person.email) return person.name;
      if (!person.name) return person.email;
      const name = /[,;<>"]/.test(person.name) ? `"${person.name.replace(/"/g, "")}"` : person.name;
      return `${name} <${person.email}>`;
    })
    .join(", ");
}

export const validRecipient = (person: Recipient) => EMAIL.test(person.email);

/** What a pill says: the name when there is one, else the address. */
const short = (person: Recipient) => person.name || person.email;

/**
 * One line of recipients. An address becomes a pill when you type a space, a comma or Enter
 * after it, or move on; a pill shows the name and opens to copy the address, edit or remove. While you type, people this
 * mailbox has written with are suggested.
 */
export function RecipientField({
  accountId,
  label,
  value,
  onChange,
  autoFocus = false,
}: {
  accountId: string;
  label: string;
  /** The line as it is stored: "Name <address>, address". */
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const [people, setPeople] = useState<Recipient[]>(() => parseRecipients(value));
  const [text, setText] = useState("");
  const [suggested, setSuggested] = useState<Recipient[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // What is being typed counts as part of the line, so it is saved even before it is a pill.
  const report = (list: Recipient[], pending: string) =>
    onChange(formatRecipients([...list, ...parseRecipients(pending)]));

  const commit = (list: Recipient[], pending: string) => {
    const next = [...list, ...parseRecipients(pending)];
    setPeople(next);
    setText("");
    setSuggested([]);
    onChange(formatRecipients(next));
  };

  useEffect(() => {
    const word = text.trim();
    if (!word) {
      setSuggested([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      mail
        .contacts(accountId, word)
        .then((found) => {
          if (!live) return;
          const have = new Set(people.map((p) => p.email.toLowerCase()));
          setSuggested(found.contacts.filter((c) => !have.has(c.email.toLowerCase())));
          setActive(0);
        })
        .catch(() => {});
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, accountId, people]);

  const pick = (person: Recipient) => {
    commit([...people, person], "");
    input.current?.focus();
  };

  return (
    <div className="relative flex items-start gap-3 border-b px-4">
      <span className="w-14 shrink-0 pt-[7px] text-xs text-muted-foreground">{label}</span>
      <div
        className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1"
        onClick={() => input.current?.focus()}
      >
        {people.map((person, index) => (
          <span
            key={`${person.email}-${person.name}-${index}`}
            className={`inline-flex max-w-56 items-center rounded-full border text-xs transition-colors hover:bg-accent ${validRecipient(person) ? "" : "border-destructive"}`}
            onClick={(event) => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={person.email || "Not an email address"}
                  aria-label={`${label}: ${person.name || person.email}`}
                  className={`min-w-0 truncate rounded-l-full py-0.5 pr-1 pl-2 ${validRecipient(person) ? "" : "text-destructive"}`}
                >
                  {short(person)}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className={MENU}>
                <DropdownMenuLabel className="px-2 py-1 font-normal">
                  {person.name && (
                    <span className="block truncate text-xs font-medium">{person.name}</span>
                  )}
                  <span
                    className={`block truncate text-[11px] ${person.email ? "text-muted-foreground" : "text-destructive"}`}
                  >
                    {person.email || "Not an email address"}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {person.email && (
                  <DropdownMenuItem
                    onSelect={() =>
                      void navigator.clipboard
                        .writeText(person.email)
                        .then(() => toast.success("Address copied"))
                    }
                  >
                    <Copy /> Copy address
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={() => {
                    // Back into the line as text, to change it.
                    const rest = people.filter((_, at) => at !== index);
                    setPeople(rest);
                    const again = formatRecipients([person]);
                    setText(again);
                    report(rest, again);
                    setTimeout(() => input.current?.focus(), 0);
                  }}
                >
                  <PencilLine /> Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    commit(
                      people.filter((_, at) => at !== index),
                      "",
                    )
                  }
                >
                  <X /> Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              aria-label={`Remove ${person.name || person.email}`}
              title="Remove"
              className="mr-0.5 grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              onClick={() =>
                commit(
                  people.filter((_, at) => at !== index),
                  "",
                )
              }
            >
              <X size={10} strokeWidth={2.5} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          className="min-w-24 flex-1 bg-transparent py-0.5 text-[13px] outline-none"
          aria-label={label}
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={suggested.length > 0}
          aria-autocomplete="list"
          placeholder={people.length ? "" : "name@example.com"}
          value={text}
          onChange={(event) => {
            const typed = event.target.value;
            // A space, comma or semicolon after a whole address makes it a pill.
            const end = typed.slice(-1);
            const before = typed.slice(0, -1).trim();
            if ((end === " " || end === "," || end === ";") && before) {
              const made = parseRecipients(before);
              if (end !== " " || made.every(validRecipient)) {
                commit(people, before);
                return;
              }
            }
            setText(typed);
            report(people, typed);
          }}
          onKeyDown={(event) => {
            if (suggested.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((active + step + suggested.length) % suggested.length);
            } else if (event.key === "Enter" || event.key === "Tab") {
              if (suggested.length && event.key === "Enter") {
                event.preventDefault();
                pick(suggested[active]!);
              } else if (text.trim()) {
                if (event.key === "Enter") event.preventDefault();
                commit(people, text);
              }
            } else if (event.key === "Escape") setSuggested([]);
            else if (event.key === "Backspace" && !text && people.length)
              commit(people.slice(0, -1), "");
          }}
          onBlur={() => {
            // Moving on makes a pill of what was typed; a click on a suggestion comes first.
            setTimeout(() => {
              setSuggested([]);
              if (input.current && input.current.value.trim()) commit(people, input.current.value);
            }, 120);
          }}
        />
      </div>
      {suggested.length > 0 && (
        <ul
          role="listbox"
          aria-label={`Suggestions for ${label}`}
          className="absolute top-full left-[4.75rem] z-20 mt-0.5 w-80 max-w-[calc(100%-5rem)] overflow-hidden rounded-lg border bg-popover py-1 shadow-md"
        >
          {suggested.map((person, index) => (
            <li key={person.email} role="option" aria-selected={index === active}>
              <button
                type="button"
                className={`block w-full px-3 py-1.5 text-left hover:bg-accent ${index === active ? "bg-accent" : ""}`}
                // Before the field loses focus, or the click would never land.
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(person);
                }}
              >
                <span className="block truncate text-[13px]">{person.name || person.email}</span>
                {person.name && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {person.email}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
