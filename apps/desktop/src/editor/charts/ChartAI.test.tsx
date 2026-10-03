import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChartAI } from "./ChartAI";

const ai = vi.hoisted(() => vi.fn());
vi.mock("@/lib/charts", () => ({ charts: { ai } }));

afterEach(cleanup);

it("sends the request with the current chart and hands back the spec", async () => {
  ai.mockResolvedValue({
    spec: { source: "cars", type: "line", x: "name" },
    message: "As a line.",
  });
  const onResult = vi.fn();
  render(
    <ChartAI
      pagePath="Garage"
      current={{ source: "cars", x: "name" }}
      placeholder="Change this chart…"
      onResult={onResult}
    />,
  );
  fireEvent.change(screen.getByLabelText("Describe a chart"), { target: { value: "as a line" } });
  fireEvent.click(screen.getByRole("button", { name: "Make the chart" }));
  await vi.waitFor(() =>
    expect(onResult).toHaveBeenCalledWith(
      { source: "cars", type: "line", x: "name" },
      "As a line.",
    ),
  );
  expect(ai.mock.calls[0]!.slice(0, 3)).toEqual([
    "Garage",
    "as a line",
    { source: "cars", x: "name" },
  ]);
});

it("says where to set up a model when there is none", async () => {
  ai.mockRejectedValue(new Error("Choose a model in Settings → Chat first."));
  const opened = vi.fn();
  window.addEventListener("graite:open-settings", opened);
  render(
    <ChartAI
      pagePath="Garage"
      placeholder="Describe"
      onResult={() => {}}
      ideas={["rating per car"]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "rating per car" }));
  fireEvent.click(await screen.findByRole("button", { name: "Set up a model" }));
  expect(opened).toHaveBeenCalled();
  window.removeEventListener("graite:open-settings", opened);
});
