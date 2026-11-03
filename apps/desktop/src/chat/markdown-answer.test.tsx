import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MarkdownAnswer } from "./MarkdownAnswer";

afterEach(cleanup);

it("renders a Markdown table as a table, with citations still clickable", () => {
  const answer = [
    "You have 2 companies [8]:",
    "",
    "| Company | Status |",
    "| --- | --- |",
    "| Northwind Traders | Customer |",
    "| Acme Robotics | Prospect |",
  ].join("\n");
  render(<MarkdownAnswer content={answer} onNavigate={() => {}} />);
  const table = document.querySelector(".ai-table-scroll > table");
  expect(table).toBeTruthy();
  expect([...document.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
    "Company",
    "Status",
  ]);
  expect(document.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(document.body.textContent).not.toContain("| --- |");
  expect(document.querySelector("button.ai-cite")?.textContent).toBe("8");
});
