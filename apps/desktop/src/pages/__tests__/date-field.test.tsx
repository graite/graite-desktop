import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateField, formatDate, parseDateInput } from "../DateField";
afterEach(cleanup);

it("formats ISO dates as text and parses the common ways of typing one", () => {
  expect(formatDate("2026-09-15")).toBe("September 15, 2026");
  expect(formatDate("2026-09-15T10:00:00Z")).toBe("September 15, 2026");
  for (const typed of [
    "September 15, 2026",
    "sept 15 2026",
    "15 sept 2026",
    "15 September 2026",
    "15/9/2026",
    "15-09-2026",
    "2026-09-15",
  ]) {
    expect(parseDateInput(typed), typed).toBe("2026-09-15");
  }
  expect(parseDateInput("31 feb 2026")).toBeNull();
  expect(parseDateInput("someday")).toBeNull();
});

it("shows the value as text and commits a typed or picked date", async () => {
  const onChange = vi.fn();
  render(<DateField value="2026-09-15" label="Due" onChange={onChange} />);
  const trigger = screen.getByLabelText("Due");
  expect(trigger.textContent).toBe("September 15, 2026");
  fireEvent.click(trigger);
  const input = await screen.findByLabelText("Due as text");
  fireEvent.change(input, { target: { value: "1 oct 2026" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("2026-10-01");
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByLabelText("September 3, 2026"));
  expect(onChange).toHaveBeenLastCalledWith("2026-09-03");
});
