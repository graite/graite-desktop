import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { VaultGate } from "./app/VaultGate";
import { Workspace } from "./app/Workspace";

export default function App() {
  // Ctrl/Cmd+Shift+R reloads the webview (dev aid: clears stale hot-reloaded modules).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "R" || e.key === "r")) {
        e.preventDefault();
        window.location.reload();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <TooltipProvider>
      <VaultGate>{(info) => <Workspace vault={info} />}</VaultGate>
      <Toaster />
    </TooltipProvider>
  );
}
