import { describe, expect, it } from "vitest";
import { modelFit, recommended } from "../modelFit";

const light = { id: "light", min_ram_gb: 8, min_vram_gb: null };
const everyday = { id: "everyday", min_ram_gb: 16, min_vram_gb: null };
const powerful = { id: "powerful", min_ram_gb: 32, min_vram_gb: 16 };
const maximum = { id: "maximum", min_ram_gb: 32, min_vram_gb: 24 };
const all = [light, everyday, powerful, maximum];

describe("modelFit", () => {
  it("allows for reported memory being a little under the label", () => {
    expect(modelFit(everyday, { ram_gb: 15.5 })).toBe("good");
    expect(modelFit(everyday, { ram_gb: 8 })).toBe("too_big");
  });

  it("calls big models slow without a large enough graphics card", () => {
    expect(modelFit(powerful, { ram_gb: 32, vram_gb: 8 })).toBe("slow");
    expect(modelFit(powerful, { ram_gb: 16, vram_gb: 16 })).toBe("good");
    expect(modelFit(powerful, { ram_gb: 16, vram_gb: 8 })).toBe("too_big");
  });
});

describe("recommended", () => {
  it("picks the largest model that runs well", () => {
    expect(recommended(all, { ram_gb: 31.3 })?.id).toBe("everyday");
    expect(recommended(all, { ram_gb: 64, vram_gb: 24 })?.id).toBe("maximum");
    expect(recommended(all, { ram_gb: 36, vram_gb: 36 })?.id).toBe("maximum");
  });

  it("falls back to the smallest model that runs at all, or nothing", () => {
    expect(recommended([powerful, maximum], { ram_gb: 32 })?.id).toBe("powerful");
    expect(recommended(all, { ram_gb: 4 })).toBeNull();
  });
});
