import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { useErrorToast } from "../useErrorToast";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const error = vi.mocked(toast.error);

afterEach(() => {
  cleanup();
  error.mockClear();
});

it("toasts each new error once and nothing while there is none", () => {
  const { rerender } = renderHook(({ e }: { e: string | null }) => useErrorToast(e), {
    initialProps: { e: null as string | null },
  });
  expect(error).not.toHaveBeenCalled();
  rerender({ e: "Microphone blocked" });
  rerender({ e: "Microphone blocked" });
  expect(error).toHaveBeenCalledTimes(1);
  expect(error.mock.calls[0]![0]).toBe("Microphone blocked");
  rerender({ e: null });
  rerender({ e: "Model stopped" });
  expect(error).toHaveBeenCalledTimes(2);
});

it("puts the action on the toast", () => {
  const onClick = vi.fn();
  renderHook(() => useErrorToast("No model", { label: "Open Settings", onClick }));
  const options = error.mock.calls[0]![1] as { action: { label: string; onClick: () => void } };
  expect(options.action.label).toBe("Open Settings");
  options.action.onClick();
  expect(onClick).toHaveBeenCalled();
});
