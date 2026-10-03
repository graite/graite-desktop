import type { ViewFilter } from "../views/settings";

/**
 * The page views' filter pills over a table's `filter:` text (graite/tables/query.py).
 *
 * The fence keeps the readable language, so people and agents can write it. The pills can show
 * a plain `and` of simple conditions; anything else (`or`, `not`, parentheses, `in`) is left as
 * written and shown as one custom filter, never rewritten.
 */

const KEYWORDS = new Set(["and", "or", "not", "in", "is", "empty", "contains", "true", "false"]);
const SYMBOL: Partial<Record<ViewFilter["op"], string>> = {
  equals: "=",
  not: "!=",
  gt: ">",
  lt: "<",
  contains: "contains",
};

function name(field: string): string {
  return /^[A-Za-z_][\w.-]*$/.test(field) && !KEYWORDS.has(field.toLowerCase())
    ? field
    : "`" + field.replace(/`/g, "") + "`";
}

function literal(value: string, numeric: boolean): string {
  const v = value.trim();
  if (numeric && /^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase();
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Complete rules as filter text; a rule still missing its value is left out. */
export function rulesToFilter(rules: ViewFilter[], numeric: (field: string) => boolean): string {
  return rules
    .map((r) => {
      if (r.op === "empty") return `${name(r.field)} is empty`;
      if (r.op === "filled") return `${name(r.field)} is not empty`;
      if (!r.value.trim()) return "";
      return `${name(r.field)} ${SYMBOL[r.op]} ${literal(r.value, numeric(r.field))}`;
    })
    .filter(Boolean)
    .join(" and ");
}

/** Split on top-level ` and `, outside quotes and backquotes; null on anything else. */
function terms(text: string): string[] | null {
  const out: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === ")" || c === "[") return null;
    else if (/\s/.test(c)) {
      const word = /^\s+(and|or)\s+/i.exec(text.slice(i));
      if (word) {
        if (word[1]!.toLowerCase() === "or") return null;
        out.push(text.slice(start, i));
        i += word[0].length - 1;
        start = i + 1;
      }
    }
  }
  if (quote) return null;
  out.push(text.slice(start));
  return out.map((t) => t.trim());
}

const TERM =
  /^(?:`([^`]+)`|([^\s"'`()=!<>]+))\s*(is\s+not\s+empty|is\s+empty|contains|==|=|!=|<>|>(?!=)|<(?!=))\s*(.*)$/i;

function unquote(value: string): string | null {
  const v = value.trim();
  const m = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/.exec(v);
  if (m) return (m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1");
  return /^[^\s"'`]+$/.test(v) ? v : null;
}

/** The rules a filter text stands for, or null when it needs the custom filter. */
export function filterToRules(text: string): ViewFilter[] | null {
  if (!text.trim()) return [];
  const parts = terms(text.trim());
  if (!parts) return null;
  const rules: ViewFilter[] = [];
  for (const part of parts) {
    const m = TERM.exec(part);
    if (!m) return null;
    const field = m[1] ?? m[2]!;
    if (!m[1] && KEYWORDS.has(field.toLowerCase())) return null;
    const op = m[3]!.toLowerCase().replace(/\s+/g, " ");
    const rest = m[4]!;
    if (op === "is empty" || op === "is not empty") {
      if (rest.trim()) return null;
      rules.push({ field, op: op === "is empty" ? "empty" : "filled", value: "" });
      continue;
    }
    const value = unquote(rest);
    if (value === null) return null;
    const kind: ViewFilter["op"] =
      op === "contains"
        ? "contains"
        : op === ">"
          ? "gt"
          : op === "<"
            ? "lt"
            : op === "!=" || op === "<>"
              ? "not"
              : "equals";
    rules.push({ field, op: kind, value });
  }
  return rules;
}
