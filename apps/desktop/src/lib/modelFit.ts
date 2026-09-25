/** Whether a model suits this computer, in terms a beginner can act on. */
export type Fit = "good" | "slow" | "too_big";

type Needs = { min_ram_gb: number; min_vram_gb?: number | null };
type Machine = { ram_gb: number; vram_gb?: number };

// Reported memory is a little under the number on the box: 16 GB reads as about 15.5.
const SLACK = 0.9;

export function modelFit(model: Needs, machine: Machine): Fit {
  const enoughMemory = machine.ram_gb >= model.min_ram_gb * SLACK;
  if (model.min_vram_gb == null) return enoughMemory ? "good" : "too_big";
  // Shared-memory machines (Apple Silicon, GB10) report their memory as graphics memory too.
  if ((machine.vram_gb ?? 0) >= model.min_vram_gb * SLACK) return "good";
  return enoughMemory ? "slow" : "too_big";
}

/** The largest model that runs well, else the smallest one that runs at all. */
export function recommended<T extends Needs>(models: T[], machine: Machine): T | null {
  const good = models.filter((m) => modelFit(m, machine) === "good");
  if (good.length) return good[good.length - 1];
  return models.find((m) => modelFit(m, machine) !== "too_big") ?? null;
}
