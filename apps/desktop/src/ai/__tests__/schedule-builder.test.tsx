import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScheduleBuilder } from "../ScheduleBuilder";

afterEach(cleanup);
HTMLElement.prototype.scrollIntoView = vi.fn();

function Harness({
  initial,
  onChange,
}: {
  initial: string | null;
  onChange: (expr: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ScheduleBuilder
      value={value}
      allowNone
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

it("builds a weekly schedule from day pills and keeps one day selected", () => {
  const onChange = vi.fn();
  render(<Harness initial="0 9 * * 1" onChange={onChange} />);
  expect(screen.getByRole("combobox", { name: "Repeat" }).textContent).toContain("Every week");
  expect(screen.getByText("Mondays at 09:00 UTC")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Mon" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Thu" }));
  expect(onChange).toHaveBeenLastCalledWith("0 9 * * 1,4");
  expect(screen.getByText("Mondays and Thursdays at 09:00 UTC")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Mon" }));
  expect(onChange).toHaveBeenLastCalledWith("0 9 * * 4");
});

it("keeps cron as the advanced path and does not jump while it is typed", () => {
  const onChange = vi.fn();
  render(<Harness initial="30 7 * * 1-5" onChange={onChange} />);
  expect(screen.getByRole("combobox", { name: "Repeat" }).textContent).toContain("Every weekday");
  expect(screen.queryByLabelText("Cron expression")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
  const input = screen.getByLabelText("Cron expression") as HTMLInputElement;
  expect(input.value).toBe("30 7 * * 1-5");
  fireEvent.change(input, { target: { value: "0 9 * * *" } });
  expect(onChange).toHaveBeenLastCalledWith("0 9 * * *");
  expect(screen.getByRole("combobox", { name: "Repeat" }).textContent).toContain("Custom");
  fireEvent.change(input, { target: { value: "*/7 * * * " } });
  expect(onChange).toHaveBeenLastCalledWith("*/7 * * *");
  expect(input.value).toBe("*/7 * * * ");
  fireEvent.change(input, { target: { value: "" } });
  expect(onChange).toHaveBeenLastCalledWith(null);
  expect(screen.getByLabelText("Cron expression")).toBeTruthy();
});

it("offers no schedule and shows an unknown expression as custom", () => {
  render(<Harness initial={null} onChange={vi.fn()} />);
  expect(screen.getByRole("combobox", { name: "Repeat" }).textContent).toContain("No schedule");
  cleanup();
  render(<Harness initial="0 9,17 * * *" onChange={vi.fn()} />);
  expect(screen.getByRole("combobox", { name: "Repeat" }).textContent).toContain("Custom");
  expect((screen.getByLabelText("Cron expression") as HTMLInputElement).value).toBe("0 9,17 * * *");
});

it("offers every minute and hour, including a 37-minute offset", async () => {
  const onChange = vi.fn();
  render(<Harness initial="0 * * * *" onChange={onChange} />);
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Interval" }), { key: "ArrowDown" });
  expect(await screen.findByRole("option", { name: "every 24 hours" })).toBeTruthy();
  fireEvent.click(screen.getByRole("option", { name: "every 5 hours" }));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Minute" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "37" }));
  expect(onChange).toHaveBeenLastCalledWith("@every 5 hours at 37");
});

it("builds a recurrence every three days from the selected date", async () => {
  const onChange = vi.fn();
  render(<Harness initial="30 12 * * *" onChange={onChange} />);
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Interval" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "3 days" }));
  fireEvent.change(screen.getByLabelText("Starting date"), { target: { value: "2026-09-29" } });
  expect(onChange).toHaveBeenLastCalledWith("@every 3 days at 12:30 from 2026-09-29");
});

it("keeps weekday buttons while selecting all seven days", () => {
  const changed = vi.fn();
  render(<Harness initial="30 12 * * 1" onChange={changed} />);
  for (const day of ["Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
    fireEvent.click(screen.getByRole("button", { name: day }));
  expect(screen.getByRole("combobox", { name: "Repeat" }).textContent).toContain("Every week");
  expect(screen.getByRole("combobox", { name: "AM or PM" }).textContent).toBe("PM");
  expect(changed).toHaveBeenLastCalledWith("30 12 * * 0,1,2,3,4,5,6");
});
