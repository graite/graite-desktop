import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DashboardAddDialog } from "./DashboardAddDialog";

const write = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dashboards", () => ({ dashboards: { write } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("adds an uploaded HTML file to the page", async () => {
  write.mockResolvedValue({});
  const onPick = vi.fn();
  render(
    <DashboardAddDialog
      pagePath="Notes"
      onPick={onPick}
      onCreateAI={() => {}}
      onCancel={() => {}}
    />,
  );
  const file = new File(["<!doctype html><title>Overview</title>"], "overview.html", {
    type: "text/html",
  });
  fireEvent.change(screen.getByLabelText("Upload HTML file"), { target: { files: [file] } });
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith(
      "Notes",
      "_dashboards/overview.html",
      "<!doctype html><title>Overview</title>",
      true,
    ),
  );
  expect(onPick).toHaveBeenCalledWith("_dashboards/overview.html");
});

it("offers dashboard, report and a custom idea through page chat", () => {
  const onCreateAI = vi.fn();
  render(
    <DashboardAddDialog
      pagePath="Notes"
      onPick={() => {}}
      onCreateAI={onCreateAI}
      onCancel={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /DashboardMetrics/ }));
  expect(onCreateAI).toHaveBeenCalledWith("dashboard");
  fireEvent.click(screen.getByRole("button", { name: /ReportA structured/ }));
  expect(onCreateAI).toHaveBeenCalledWith("report");
  fireEvent.change(screen.getByLabelText("Describe the HTML you want"), {
    target: { value: "A weekly delivery report" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create HTML with AI" }));
  expect(onCreateAI).toHaveBeenCalledWith("dashboard", "A weekly delivery report");
});
