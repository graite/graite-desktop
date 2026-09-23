import type { PageProperty } from "@/lib/workspace";
import { PropertyTag } from "@/pages/PropertySelect";

/** One field's value, rendered the way the page itself renders it. */
function Value({ field }: { field: PageProperty }) {
  const { value } = field;
  if (value == null || value === "") return <span className="property-diff-empty">empty</span>;
  if (field.type === "checkbox") return <>{value ? "Yes" : "No"}</>;
  if (Array.isArray(value))
    return (
      <>
        {value.map((v) => (
          <PropertyTag key={String(v)} field={field} option={String(v)} />
        ))}
      </>
    );
  if (field.type === "status" || field.type === "single_select")
    return <PropertyTag field={field} option={String(value)} />;
  return <>{String(value)}</>;
}

const same = (a: PageProperty, b: PageProperty) =>
  JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null);

/** The API omits `options` and `colors` when empty and types `value` loosely; the page does not. */
type ReviewProperty = Omit<PageProperty, "options" | "colors" | "value"> & {
  options?: string[];
  colors?: PageProperty["colors"];
  value?: unknown;
};

const full = (f: ReviewProperty): PageProperty => ({
  ...f,
  options: f.options ?? [],
  colors: f.colors ?? {},
  value: (f.value ?? null) as PageProperty["value"],
});

const byName = (fields: PageProperty[]) =>
  new Map(fields.map((f) => [f.name.trim().toLowerCase(), f]));

/**
 * What accepting this proposal would do to a page's fields. A properties proposal has no text
 * to diff, and a create that carries properties has text that says nothing about them, so
 * without this the reviewer would be asked to approve a change they cannot see.
 */
export function PropertyDiff({
  before,
  after,
}: {
  before: ReviewProperty[] | null;
  after: ReviewProperty[];
}) {
  const previous = byName((before ?? []).map(full));
  const rows = after.map(full).map((field) => {
    const was = previous.get(field.name.trim().toLowerCase());
    return {
      field,
      was,
      state: !was ? "added" : same(was, field) ? "unchanged" : "changed",
    } as const;
  });
  // Fields the proposal does not mention are left alone; showing them as removed would be a lie.
  return (
    <dl className="property-diff">
      {rows.map(({ field, was, state }) => (
        <div key={field.id || field.name} className="property-diff-row" data-state={state}>
          <dt>{field.name}</dt>
          <dd>
            {state === "changed" && was && (
              <>
                <span className="property-diff-was">
                  <Value field={was} />
                </span>
                <span aria-hidden="true"> → </span>
              </>
            )}
            <Value field={field} />
            {state === "added" && <span className="property-diff-badge">new field</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
