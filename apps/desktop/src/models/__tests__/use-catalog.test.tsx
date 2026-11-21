import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  request: vi.fn(),
  listeners: [] as ((e: { type: string }) => void)[],
}));
vi.mock("@/lib/api", () => ({
  request: api.request,
  connectEvents: (l: (e: { type: string }) => void) => {
    api.listeners.push(l);
    return () => {};
  },
}));
const toastMock = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { useCatalog } from "../useCatalog";

function Names() {
  const { models } = useCatalog();
  return <p>{models.map((m) => `${m.name}:${m.status}`).join(",")}</p>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  api.listeners.length = 0;
});

const OLD = { id: "old", name: "Old", status: "error", error: "Checksum mismatch." };
const NEW = { id: "new", name: "Gemma", status: "downloading", error: null };

it("says a download that fails once as a popup, not the failures that were already there", async () => {
  api.request.mockResolvedValue([OLD, NEW]);
  const view = render(<Names />);
  await waitFor(() => expect(view.container.textContent).toContain("Gemma:downloading"));
  expect(toastMock.error).not.toHaveBeenCalled();

  const reason = "The download could not finish. Check your connection and retry.";
  api.request.mockResolvedValue([OLD, { ...NEW, status: "error", error: reason }]);
  api.listeners.forEach((l) => l({ type: "model_progress" }));
  await waitFor(() => expect(view.container.textContent).toContain("Gemma:error"));
  expect(toastMock.error).toHaveBeenCalledTimes(1);
  expect(toastMock.error).toHaveBeenCalledWith(`Gemma: ${reason}`, { id: "model-failed-new" });

  // Looking again changes nothing: the same failure is not announced twice.
  api.listeners.forEach((l) => l({ type: "model_progress" }));
  await waitFor(() => expect(api.request).toHaveBeenCalledTimes(3));
  expect(toastMock.error).toHaveBeenCalledTimes(1);
});
