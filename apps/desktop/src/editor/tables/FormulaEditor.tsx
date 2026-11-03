import { useEffect, useRef, useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { tables, type FormulaCheck, type TableColumn } from "@/lib/tables";
import { FORMULA_FORMATS, formatNumber, formatValue, NUMERIC_TYPES, TypeIcon } from "./columns";
import { CurrencyList, CurrencyRow, DecimalsChoice } from "./NumberFormat";

export interface FormulaChoice {
  formula: string;
  format: string;
  currency: string | null;
  /** Fixed decimals for a numeric format (D82); null shows what the value has. */
  decimals: number | null;
}

/** The functions a formula can use (graite/tables/formula.py), with a short hint each. */
const FUNCTIONS: [string, string][] = [
  ["if(test, then, else)", 'if(stage = "Won", value, 0)'],
  ["round(x, digits)", "round(net * 0.21, 2)"],
  ["days_between(a, b)", "days_between(issue_date, paid_on)"],
  ["add_days(date, n)", "add_days(issue_date, 30)"],
  ["concat(a, b, …)", 'concat(first, " ", last)'],
  ["coalesce(a, b)", "coalesce(paid, 0)"],
  ["min / max / abs", "max(a, b)"],
  ["year / quarter / month", "quarter(date)"],
];

/** Write a formula column (D75): the expression, checked live against the table's first
 *  rows, and how its values show. */
export function FormulaEditor({
  path,
  columns,
  column,
  initial,
  submit,
  onSubmit,
  onCancel,
}: {
  /** The table, for the live check. */
  path: string;
  /** Fields a formula may read (not the one being edited). */
  columns: TableColumn[];
  /** The formula column being edited, or null for a new one. */
  column: string | null;
  initial?: Partial<FormulaChoice>;
  submit: string;
  onSubmit: (choice: FormulaChoice) => void;
  onCancel: () => void;
}) {
  const [formula, setFormula] = useState(initial?.formula ?? "");
  const [format, setFormat] = useState(initial?.format ?? "number");
  const [currency, setCurrency] = useState(initial?.currency ?? "EUR");
  const [decimals, setDecimals] = useState<number | null>(initial?.decimals ?? null);
  const [pickingCurrency, setPickingCurrency] = useState(false);
  const numeric = NUMERIC_TYPES.includes(format);
  const [check, setCheck] = useState<FormulaCheck | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const text = formula.trim();
    if (!text) {
      setCheck(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      tables
        .checkFormula(path, text, column)
        .then((result) => live && setCheck(result))
        .catch((e: Error) => live && setCheck({ ok: false, error: e.message, sample: [] }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path, formula, column]);

  /** Put a field's name where the cursor is, quoted when it needs to be. */
  const insert = (name: string) => {
    const ref = /^[A-Za-z_][\w.]*$/.test(name) ? name : `\`${name}\``;
    const el = area.current;
    const at = el?.selectionStart ?? formula.length;
    const end = el?.selectionEnd ?? at;
    const before = formula.slice(0, at);
    const pad = before && !/[\s(,]$/.test(before) ? " " : "";
    const next = before + pad + ref + formula.slice(end);
    setFormula(next);
    requestAnimationFrame(() => {
      el?.focus();
      const cursor = at + pad.length + ref.length;
      el?.setSelectionRange(cursor, cursor);
    });
  };

  const preview: TableColumn = {
    name: column ?? "",
    type: format,
    currency: format === "currency" ? currency : null,
    decimals: numeric ? decimals : null,
    options: [],
    colors: {},
    wrap: false,
    invalid: 0,
  };

  if (pickingCurrency)
    return (
      <CurrencyList
        value={currency}
        onBack={() => setPickingCurrency(false)}
        onPick={(code) => {
          setCurrency(code);
          setPickingCurrency(false);
        }}
      />
    );

  return (
    <form
      className="formula-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!formula.trim() || check?.ok === false) return;
        onSubmit({
          formula: formula.trim(),
          format,
          currency: format === "currency" ? currency : null,
          decimals: numeric ? decimals : null,
        });
      }}
    >
      <textarea
        ref={area}
        className="table-input mono"
        autoFocus
        rows={3}
        spellCheck={false}
        placeholder="net * vat_rate / 100"
        aria-label="Formula"
        value={formula}
        onChange={(e) => setFormula(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="formula-status" aria-live="polite">
        {check === null ? (
          <span className="muted">Write an expression over this row’s fields.</span>
        ) : check.ok ? (
          <span>
            <Check size={12} />{" "}
            {check.sample?.length
              ? check.sample
                  .slice(0, 3)
                  .map((v) => formatValue(preview, v) || "—")
                  .join(" · ")
              : "Works (no rows yet)"}
          </span>
        ) : (
          <span className="error">
            <TriangleAlert size={12} /> {check.error}
          </span>
        )}
      </div>
      <small>Fields</small>
      <div className="formula-fields">
        {columns.map((c) => (
          <button
            key={c.name}
            type="button"
            className="formula-chip"
            onClick={() => insert(c.name)}
          >
            <TypeIcon type={c.type} size={11} />
            {c.name}
          </button>
        ))}
      </div>
      <details className="formula-help">
        <summary>Functions</summary>
        <ul>
          {FUNCTIONS.map(([name, example]) => (
            <li key={name}>
              <code>{name}</code>
              <span>{example}</span>
            </li>
          ))}
          <li>
            <code>+ − × ÷, = != &lt; &gt;, and or not, is empty</code>
          </li>
        </ul>
      </details>
      <div className="formula-format">
        <small>Show as</small>
        <div className="formula-format-options" role="radiogroup" aria-label="Show as">
          {FORMULA_FORMATS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={format === value}
              className={`view-chip-choice ${format === value ? "active" : ""}`}
              onClick={() => setFormat(value)}
            >
              <TypeIcon type={value} size={12} />
              {label}
            </button>
          ))}
        </div>
        {format === "currency" && (
          <CurrencyRow value={currency} onOpen={() => setPickingCurrency(true)} />
        )}
        {numeric && (
          <DecimalsChoice
            value={decimals}
            example={(d) => formatNumber({ ...preview, decimals: d }, 1234.5)}
            onChange={setDecimals}
          />
        )}
      </div>
      <div className="table-form-actions">
        <button type="button" className="table-button ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="table-button solid"
          disabled={!formula.trim() || check?.ok === false}
        >
          {submit}
        </button>
      </div>
    </form>
  );
}
