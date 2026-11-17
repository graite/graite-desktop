import { CircleHelp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** "How search works": the short version of docs/search.md, next to the message box. */
export function SearchHelp() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="ai-composer-icon ai-search-help-button"
          aria-label="How search works"
          title="How search works"
        >
          <CircleHelp size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="ai-search-help">
        <h3>How search works</h3>
        <dl>
          <dt>Find or ask</dt>
          <dd>
            <kbd>Ctrl/⌘ K</kbd> finds pages by their title or text at once, without AI. Asking here
            lets the AI read what it found and write an answer with its sources.
          </dd>
          <dt>Where it looks</dt>
          <dd>
            This page, this page and its subpages, or everywhere. “Everywhere” means it may search
            all your pages. It never reads them all: it searches, then reads the few passages that
            match.
          </dd>
          <dt>@page</dt>
          <dd>
            Type <kbd>@</kbd> and a page name to pin that page: the AI reads it first, whatever the
            search finds.
          </dd>
          <dt>Quick or Deep</dt>
          <dd>
            Quick answers from the best few passages of one search. Deep runs several searches in
            small steps and takes longer; use it for questions that span pages.
          </dd>
        </dl>
        <p>Under each answer, the details line shows what was searched and how long it took.</p>
      </PopoverContent>
    </Popover>
  );
}
