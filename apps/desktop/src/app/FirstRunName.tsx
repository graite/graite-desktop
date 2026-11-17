import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { saveProfile } from "@/lib/profile";

/** The question itself: what to call the user. Shared by the standalone form below and the
 * first step of the onboarding, which bring their own buttons. */
export function NameQuestion({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <img src="/logo-graite.svg" alt="" className="mb-6 size-9 dark:invert" />
      <h1 className="text-2xl font-semibold tracking-tight">Nice to meet you! And you are...?</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your first name is plenty. It’s saved right here on this computer, and Settings lets you
        change it whenever the mood strikes.
      </p>
      <label className="mt-6 block text-sm font-medium" htmlFor="first-name">
        First name
      </label>
      <input
        id="first-name"
        className="mt-1.5 h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-ring"
        value={value}
        maxLength={60}
        autoComplete="given-name"
        autoFocus
        onChange={(e) => onChange(e.target.value)}
      />
    </>
  );
}

/** Save the name when one was given. Returns the saved first name ("" when there was none),
 * or null when saving failed (the error is shown). */
export async function saveFirstName(name: string): Promise<string | null> {
  const first_name = name.trim();
  if (!first_name) return "";
  try {
    const saved = await saveProfile({ first_name });
    return saved.first_name || first_name;
  } catch (e) {
    toast.error((e as Error).message);
    return null;
  }
}

/** The one question asked before the welcome page: what to call the user. Optional. */
export function FirstRunName({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    const saved = await saveFirstName(name);
    setSaving(false);
    if (saved !== null) onDone();
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
        <NameQuestion value={name} onChange={setName} />
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
