/** Model-family logos, so people recognise a model by who made it. */
const BRANDS = [
  { match: /gemma|google/i, name: "Google", logo: "/model-brands/google.png" },
  { match: /qwen/i, name: "Qwen", logo: "/model-brands/qwen.png" },
] as const;

/** The brand behind a repository, model name or author, if it is one we have a logo for. */
export function brandFor(text: string) {
  return BRANDS.find((b) => b.match.test(text)) ?? null;
}

export function BrandMark({ of, size = 34 }: { of: string; size?: number }) {
  const brand = brandFor(of);
  return (
    <span className="ai-brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      {brand ? <img src={brand.logo} alt="" /> : (of.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
