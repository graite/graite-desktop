import { useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronRight, Coins, Hash, Search } from "lucide-react";
import { CURRENCIES } from "./columns";

/** Every currency the browser knows, the common ones first. */
function allCurrencies(): string[] {
  let known: string[] = [];
  try {
    known =
      (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("currency") ??
      [];
  } catch {
    known = [];
  }
  return [...CURRENCIES, ...known.filter((c) => !CURRENCIES.includes(c))];
}

/** `€` for EUR, `US$` for USD, the code itself when there is no symbol. */
export function currencySymbol(code: string): string {
  try {
    const part = new Intl.NumberFormat(undefined, { style: "currency", currency: code })
      .formatToParts(0)
      .find((p) => p.type === "currency");
    return part?.value ?? code;
  } catch {
    return code;
  }
}

function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A menu row that opens the currency list: "Currency   € EUR ›". */
export function CurrencyRow({ value, onOpen }: { value: string; onOpen: () => void }) {
  return (
    <button type="button" className="view-menu-item" onClick={onOpen}>
      <Coins size={14} /> Currency
      <span className="table-menu-current">
        {currencySymbol(value)} {value}
      </span>
      <ChevronRight size={13} className="table-menu-chevron" />
    </button>
  );
}

/**
 * The currencies, in the menu's own style (D82): a search field and one row per currency
 * with its symbol, code and name. The common ones show first; a search finds any.
 */
export function CurrencyList({
  value,
  onPick,
  onBack,
}: {
  value: string;
  onPick: (code: string) => void;
  onBack: () => void;
}) {
  const [search, setSearch] = useState("");
  const all = useMemo(
    () => allCurrencies().map((code) => ({ code, name: currencyName(code) })),
    [],
  );
  const q = search.trim().toLowerCase();
  const shown = q
    ? all.filter((c) => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    : all.filter((c) => CURRENCIES.includes(c.code) || c.code === value);
  return (
    <div className="currency-list">
      <button type="button" className="view-menu-item table-menu-back" onClick={onBack}>
        <ArrowLeft size={14} /> Currency
      </button>
      <label className="relation-setup-search">
        <Search size={13} />
        <input
          autoFocus
          placeholder="Search currencies"
          aria-label="Search currencies"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="currency-list-items" role="listbox" aria-label="Currency">
        {shown.map((c) => (
          <button
            key={c.code}
            type="button"
            role="option"
            aria-selected={c.code === value}
            className="view-menu-item"
            onClick={() => onPick(c.code)}
          >
            <span className="currency-symbol">{currencySymbol(c.code)}</span>
            <span className="currency-code">{c.code}</span>
            <span className="currency-name">{c.name}</span>
            {c.code === value && <Check size={13} className="ml-auto" />}
          </button>
        ))}
        {!shown.length && <div className="relation-setup-empty">No currency matches.</div>}
      </div>
    </div>
  );
}

const DECIMALS: (number | null)[] = [null, 0, 1, 2, 3, 4];

/** Auto · 0 · 1 · 2 · 3 · 4 decimals (D82), with an example in the chosen format. */
export function DecimalsChoice({
  value,
  example,
  onChange,
}: {
  value: number | null | undefined;
  /** How 1234.5 reads with a given setting. */
  example: (decimals: number | null) => string;
  onChange: (decimals: number | null) => void;
}) {
  const current = value ?? null;
  return (
    <div className="decimals-choice">
      <div className="decimals-choice-label">
        <Hash size={14} /> Decimals
        <span className="table-menu-current">{example(current)}</span>
      </div>
      <div className="decimals-choice-options" role="radiogroup" aria-label="Decimals">
        {DECIMALS.map((d) => (
          <button
            key={String(d)}
            type="button"
            role="radio"
            aria-checked={current === d}
            className={`view-chip-choice ${current === d ? "active" : ""}`}
            onClick={() => onChange(d)}
          >
            {d === null ? "Auto" : d}
          </button>
        ))}
      </div>
    </div>
  );
}
