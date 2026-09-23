import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PropertyValue } from "../PageProperties";
import { PropertySelect } from "../PropertySelect";
import type { PageDoc } from "@/lib/api";
import type { PageProperty } from "@/lib/workspace";
afterEach(cleanup);
it("saves decimal numbers as numbers and empty values as null", () => {
  const onChange = vi.fn();
  render(
    <PropertyValue
      page={{} as PageDoc}
      field={{ id: "n", name: "Budget", type: "number", options: [], value: null }}
      onChange={onChange}
    />,
  );
  const input = screen.getByLabelText("Budget");
  fireEvent.change(input, { target: { value: "12.75" } });
  fireEvent.blur(input);
  expect(onChange).toHaveBeenCalledWith(12.75);
});
it("creates a select option and stores its selected value together", () => {
  const save = vi.fn();
  const field: PageProperty = {
    id: "s",
    name: "Status",
    type: "status",
    options: ["Done"],
    value: "Done",
    colors: { Done: "green" },
  };
  render(<PropertySelect field={field} disabled={false} onChange={vi.fn()} onFieldChange={save} />);
  expect(screen.getByText("Done").getAttribute("data-color")).toBe("green");
  fireEvent.click(screen.getByLabelText("Status"));
  fireEvent.change(screen.getByLabelText("Find or create an option"), {
    target: { value: "Review" },
  });
  fireEvent.click(screen.getByText("Create “Review”"));
  expect(save).toHaveBeenCalledWith({ ...field, options: ["Done", "Review"], value: "Review" });
});
