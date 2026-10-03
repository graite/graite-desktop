import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Switch } from "./switch";

afterEach(cleanup);

it("is a switch that reports the opposite state when clicked", () => {
  const onChange = vi.fn();
  render(<Switch checked={false} onCheckedChange={onChange} aria-label="Wrap" />);
  const sw = screen.getByRole("switch", { name: "Wrap" });
  expect(sw.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(sw);
  expect(onChange).toHaveBeenCalledWith(true);
});
