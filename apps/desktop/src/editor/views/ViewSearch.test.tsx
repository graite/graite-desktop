import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ViewSearch } from "./ViewSearch";
afterEach(cleanup);
it("starts as an icon, opens a focused search field and clears on Escape", () => {
  function Harness() {
    const [query, setQuery] = useState("");
    return <ViewSearch query={query} onQuery={setQuery} />;
  }
  render(<Harness />);
  expect(screen.queryByLabelText("Search pages in view")).toBeNull();
  fireEvent.click(screen.getByLabelText("Search view"));
  const input = screen.getByLabelText("Search pages in view");
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "pizza" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByLabelText("Search pages in view")).toBeNull();
  expect(screen.getByLabelText("Search view").getAttribute("aria-expanded")).toBe("false");
});
