"use client";

import { CircleAlertIcon, CircleCheckIcon, CircleXIcon, InfoIcon, Loader2Icon } from "lucide-react";

import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/lib/theme";

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      closeButton
      icons={{
        // Round icons, coloured by kind; a shade lighter on the dark theme.
        success: <CircleCheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" />,
        info: <InfoIcon className="size-4 text-blue-600 dark:text-blue-400" />,
        warning: <CircleAlertIcon className="size-4 text-amber-600 dark:text-amber-400" />,
        error: <CircleXIcon className="size-4 text-red-600 dark:text-red-400" />,
        loading: <Loader2Icon className="size-4 animate-spin text-muted-foreground" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
