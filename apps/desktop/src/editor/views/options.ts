import type { PageDoc } from "@/lib/api";
import { pageProperties, workspace, type PageProperty } from "@/lib/workspace";
import { sameName } from "./collection";

/** One option of a select or status field that was renamed (`to`) or removed (`to` null). */
export interface OptionChange {
  from: string;
  to: string | null;
}

/** What happened to a field's options between two definitions of it. */
export function optionChanges(previous: PageProperty, next: PageProperty): OptionChange[] {
  const gone = previous.options.filter((o) => !next.options.includes(o));
  const added = next.options.filter((o) => !previous.options.includes(o));
  if (!gone.length) return [];
  if (gone.length === 1 && added.length === 1) return [{ from: gone[0]!, to: added[0]! }];
  return gone.map((from) => ({ from, to: null }));
}

/**
 * A page's properties after the options of the field called `name` changed on another page
 * of the same view: the option list follows, and a value that used a removed option is
 * cleared. Null when this page has nothing to change.
 *
 * Every page of a view keeps its own copy of a field's options, and a board draws one column
 * per option any page still lists: without this, an option removed on one page stays a column.
 */
export function withOptionChanges(
  list: PageProperty[],
  name: string,
  changes: OptionChange[],
): PageProperty[] | null {
  let changed = false;
  const next = list.map((field) => {
    if (!sameName(field.name, name)) return field;
    let options = field.options;
    let colors: Record<string, string> = field.colors ?? {};
    let value = field.value;
    for (const { from, to } of changes) {
      if (options.includes(from)) {
        options =
          to === null || options.includes(to)
            ? options.filter((o) => o !== from)
            : options.map((o) => (o === from ? to : o));
        changed = true;
      }
      if (from in colors) {
        const { [from]: color, ...rest } = colors;
        colors = to === null || !color ? rest : { ...rest, [to]: color };
        changed = true;
      }
      if (value === from) {
        value = to;
        changed = true;
      } else if (Array.isArray(value) && (value as unknown[]).includes(from)) {
        const values = value as string[];
        value = (
          to === null ? values.filter((v) => v !== from) : values.map((v) => (v === from ? to : v))
        ) as PageProperty["value"];
        changed = true;
      }
    }
    return { ...field, options, colors, value };
  });
  return changed ? next : null;
}

/**
 * Apply option changes to the other pages of a view (the children of `parentId`), skipping
 * `exceptId`, the page they were made on. Returns the pages that were rewritten.
 */
export async function spreadOptionChanges(
  parentId: string,
  exceptId: string,
  name: string,
  changes: OptionChange[],
  rows?: PageDoc[],
): Promise<PageDoc[]> {
  if (!changes.length) return [];
  const siblings = rows ?? (await workspace.children(parentId));
  const written: PageDoc[] = [];
  for (const row of siblings) {
    if (row.id === exceptId) continue;
    const next = withOptionChanges(pageProperties(row), name, changes);
    if (next) written.push(await workspace.properties(row.id, next, row.hash));
  }
  return written;
}
