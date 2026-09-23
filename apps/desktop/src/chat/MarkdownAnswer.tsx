import Markdown from "react-markdown";

/** `[3]` citations become clickable markers; `graite:` links open pages. Never loads remote images. */
export function withCitationLinks(content: string): string {
  return content.replace(
    /\[(\d+(?:\s*,\s*\d+)*)\]/g,
    (match, group: string) =>
      group
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => `[${n}](graite-cite:${n})`)
        .join("") || match,
  );
}

export function MarkdownAnswer({
  content,
  onNavigate,
  onCite,
}: {
  content: string;
  onNavigate: (path: string) => void;
  onCite?: (n: number) => void;
}) {
  return (
    <Markdown
      urlTransform={(url) => (/^(graite:|graite-cite:|https?:|mailto:)/i.test(url) ? url : "")}
      components={{
        img: ({ alt }) => <span>{alt}</span>,
        a: ({ href, children }) =>
          href?.startsWith("graite-cite:") ? (
            <button
              type="button"
              className="ai-cite"
              aria-label={`Source ${href.slice(12)}`}
              onClick={() => onCite?.(Number(href.slice(12)))}
            >
              {href.slice(12)}
            </button>
          ) : href?.startsWith("graite:") ? (
            <button type="button" className="ai-source" onClick={() => onNavigate(href.slice(7))}>
              {children}
            </button>
          ) : (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
      }}
    >
      {withCitationLinks(content)}
    </Markdown>
  );
}
