import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { saveProfile } from "@/lib/profile";

/** The one question asked before the welcome page: what to call the user. Optional. */
export function FirstRunName({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const first_name = name.trim();
    if (!first_name) return onDone();
    setSaving(true);
    try {
      await saveProfile({ first_name });
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-8">
      <form
        className="w-full max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <img src="/logo-graite.svg" alt="" className="mb-6 size-9 dark:invert" />
        <h1 className="text-2xl font-semibold tracking-tight">What should we call you?</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your first name is enough. Graite and its AI use it to address you. It is stored on this
          computer, and you can change it any time in Settings.
        </p>
        <label className="mt-6 block text-sm font-medium" htmlFor="first-name">
          First name
        </label>
        <input
          id="first-name"
          className="mt-1.5 h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-ring"
          value={name}
          maxLength={60}
          autoComplete="given-name"
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        <div className="mt-6 flex items-center gap-2">
          <Button type="submit" disabled={saving}>
            Continue
          </Button>
          <Button type="button" variant="ghost" disabled={saving} onClick={onDone}>
            Skip
          </Button>
        </div>
      </form>
    </div>
  );
}
