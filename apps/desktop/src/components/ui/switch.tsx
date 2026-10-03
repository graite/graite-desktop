import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * The app's one on/off switch. Use it for every boolean setting instead of a hand-styled
 * button or a checkbox, so toggles look and behave the same everywhere.
 */
export function Switch({
  checked,
  onCheckedChange,
  size = "md",
  className,
  ...props
}: Omit<ComponentProps<"button">, "onChange" | "role" | "type"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn("ui-switch", size === "sm" && "ui-switch-sm", className)}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    />
  );
}
