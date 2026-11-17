// Node 25+ defines its own `localStorage` global, which is unusable without
// `--localstorage-file` and shadows jsdom's. Give every test a working, empty one.
class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  let usable = false;
  try {
    usable = typeof globalThis[name]?.clear === "function";
  } catch {
    usable = false;
  }
  if (!usable) {
    Object.defineProperty(globalThis, name, {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}

// jsdom has no ResizeObserver; Radix uses it to place tooltips and popovers. Nothing is laid
// out in tests, so an observer that never fires is enough.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
