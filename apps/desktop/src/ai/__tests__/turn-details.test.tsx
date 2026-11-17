import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TurnDetails, duration, summary, type TurnMetrics } from "../TurnDetails";

afterEach(cleanup);

const METRICS: TurnMetrics = {
  retrieval_ms: 120,
  pages: 4,
  chunks: 6,
  context_tokens: 2100,
  prompt_tokens: 3400,
  completion_tokens: 180,
  cached_tokens: 900,
  first_token_ms: 1240,
  total_ms: 6100,
  tokens_per_second: 38.4,
  model_calls: 1,
  tool_calls: 0,
  searches: [{ query: "invoice Q3", hits: 6, ms: 120 }],
};

it("formats durations and the one-line summary", () => {
  expect(duration(120)).toBe("120 ms");
  expect(duration(1240)).toBe("1.2 s");
  expect(summary(METRICS)).toBe("38 tok/s · read 4 pages · 6.1 s");
  // A cloud model without a reported speed, and a turn that used no pages.
  expect(summary({ ...METRICS, tokens_per_second: null, pages: 0, context_tokens: 0 })).toBe(
    "no pages read · 6.1 s",
  );
});

it("shows the full breakdown and the searches that ran behind a small info button", async () => {
  render(
    <TooltipProvider>
      <TurnDetails metrics={METRICS} />
    </TooltipProvider>,
  );
  expect(screen.getByText("38 tok/s · read 4 pages · 6.1 s")).toBeTruthy();
  expect(screen.queryByText("Pages read")).toBeNull();
  fireEvent.focus(screen.getByRole("button", { name: "Answer details" }));
  expect(
    (await screen.findAllByText("4 pages, 6 passages, about 2,100 tokens")).length,
  ).toBeGreaterThan(0);
  expect(screen.getAllByText("3,400 tokens, 900 reused").length).toBeGreaterThan(0);
  expect(screen.getAllByText("180 tokens at 38.4 tok/s").length).toBeGreaterThan(0);
  expect(screen.getAllByText("“invoice Q3” · 6 hits · 120 ms").length).toBeGreaterThan(0);
  expect(screen.queryByText("Steps")).toBeNull();
});

it("shows nothing for answers from before metrics were recorded", () => {
  const { container } = render(<TurnDetails metrics={undefined} />);
  expect(container.innerHTML).toBe("");
});
