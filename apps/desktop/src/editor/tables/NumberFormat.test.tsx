import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CurrencyList, DecimalsChoice } from "./NumberFormat";

afterEach(cleanup);

it("lists common currencies, finds others by search, and picks one", () => {
  const onPick = vi.fn();
  render(<CurrencyList value="EUR" onPick={onPick} onBack={() => {}} />);
  const eur = screen.getByRole("option", { name: /EUR/ });
  expect(eur.getAttribute("aria-selected")).toBe("true");
  fireEvent.change(screen.getByLabelText("Search currencies"), { target: { value: "usd" } });
  fireEvent.click(screen.getByRole("option", { name: /USD/ }));
  expect(onPick).toHaveBeenCalledWith("USD");
});

it("chooses Auto or a number of decimals", () => {
  const onChange = vi.fn();
  render(<DecimalsChoice value={null} example={(d) => `ex ${d}`} onChange={onChange} />);
  expect(screen.getByRole("radio", { name: "Auto" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("ex null")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "0" }));
  expect(onChange).toHaveBeenCalledWith(0);
});
