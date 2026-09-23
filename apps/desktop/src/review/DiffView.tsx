import { parsePatch } from "diff";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Render whole Markdown documents, so changes across formatting boundaries stay valid. */
function ReviewMarkdown({ text, kind }: { text: string; kind?: "add" | "del" }) {
  return (
    <div className="review-markdown" data-kind={kind}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          // Previews must not fetch images, or navigate away from an unsaved review.
          img: ({ alt }) => <span className="review-image-label">{alt || "Image"}</span>,
          a: ({ children }) => <span className="review-link-label">{children}</span>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

/** Label complete before/after versions instead of breaking Markdown into word fragments. */
export function TextDiff({
  oldText,
  newText,
  highlightChanges = false,
}: {
  oldText: string;
  newText: string;
  highlightChanges?: boolean;
}) {
  const changed = oldText !== newText;
  return (
    <div
      className="review-changes"
      data-highlight-changes={highlightChanges || undefined}
      aria-label="Changes"
    >
      {oldText && changed && (
        <section className="review-version review-version-before">
          <p className="review-version-label">{highlightChanges ? "− Removed" : "Before"}</p>
          <ReviewMarkdown text={oldText} kind="del" />
        </section>
      )}
      {newText && (
        <section className="review-version">
          {changed && (oldText || highlightChanges) && (
            <p className="review-version-label">{highlightChanges ? "+ Added" : "After"}</p>
          )}
          <ReviewMarkdown text={newText} kind={changed ? "add" : undefined} />
        </section>
      )}
    </div>
  );
}

/** Legacy/delete proposals only carry a patch. Keep separate hunks separate. */
export function PatchView({ patch }: { patch: string }) {
  let files;
  try {
    files = parsePatch(patch);
  } catch {
    return (
      <pre className="review-patch-fallback" aria-label="Changes">
        {patch}
      </pre>
    );
  }
  return (
    <div className="review-patch">
      {files.flatMap((file, i) =>
        file.hunks.map((hunk, j) => (
          <TextDiff
            highlightChanges
            key={`${i}-${j}`}
            oldText={hunk.lines
              .filter((line) => line.startsWith(" ") || line.startsWith("-"))
              .map((line) => line.slice(1))
              .join("\n")}
            newText={hunk.lines
              .filter((line) => line.startsWith(" ") || line.startsWith("+"))
              .map((line) => line.slice(1))
              .join("\n")}
          />
        )),
      )}
    </div>
  );
}
