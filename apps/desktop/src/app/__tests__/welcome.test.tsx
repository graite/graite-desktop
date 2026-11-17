import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const send = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, feedback: { status: vi.fn().mockResolvedValue({ enabled: true }), send } };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { WelcomePage } from "../WelcomePage";
import { FeedbackDialog } from "../FeedbackDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("links each next step to its place in the app", () => {
  const props = { onCreatePage: vi.fn(), onSettings: vi.fn(), onStudio: vi.fn() };
  render(<WelcomePage {...props} />);
  fireEvent.click(screen.getByText("New page →"));
  fireEvent.click(screen.getByText("Open settings →"));
  fireEvent.click(screen.getByText("Open the review queue →"));
  expect(props.onCreatePage).toHaveBeenCalled();
  expect(props.onSettings).toHaveBeenCalled();
  expect(props.onStudio).toHaveBeenCalledWith("review");
  // No feedback endpoint in this build: no link to a form that cannot send.
  expect(screen.queryByText("Send feedback")).toBeNull();
});

it("explains how Graite works, greets by name and marks the screenshots still to add", () => {
  const props = { onCreatePage: vi.fn(), onSettings: vi.fn(), onStudio: vi.fn() };
  render(<WelcomePage {...props} firstName="Sam" />);
  expect(screen.getByRole("heading", { level: 1, name: "Welcome, Sam" })).toBeTruthy();
  expect(
    screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
  ).toEqual([
    "Tabs and page buttons",
    "Instructions for AI",
    "Reviews",
    "Connect to Claude, ChatGPT or others",
    "Start here",
  ]);
  // The pictures are not bundled yet: each slot says which file it wants and what to show.
  for (const img of screen.getAllByRole("img")) fireEvent.error(img);
  for (const name of ["overview", "ai-instructions", "review"])
    expect(screen.getByText(`Screenshot to add: ${name}-light.png`)).toBeTruthy();
  // Connecting shows the apps themselves, not screenshots of one app's (translated) screens.
  expect(screen.getByRole("list", { name: /Claude, ChatGPT, Gemini/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Open AI connectors/ }));
  expect(props.onSettings).toHaveBeenCalledWith("connectors");
});

it("sends feedback and closes", async () => {
  send.mockResolvedValue({ sent: true });
  const onOpenChange = vi.fn();
  render(<FeedbackDialog open onOpenChange={onOpenChange} />);
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "  Menus stay open " } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(send).toHaveBeenCalledWith({
    kind: "bug",
    message: "Menus stay open",
    email: undefined,
    include_log: true,
  });
});
