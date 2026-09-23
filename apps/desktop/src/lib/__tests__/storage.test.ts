import { expect, it } from "vitest";
import { scopedKey, setStorageScope, vaultName } from "../storage";

it("scopes keys per vault and leaves them plain when no vault is known", () => {
  setStorageScope(null);
  expect(scopedKey("graite.selectedPath")).toBe("graite.selectedPath");
  setStorageScope("/home/me/Notes");
  const notes = scopedKey("graite.selectedPath");
  expect(notes.startsWith("graite.selectedPath:")).toBe(true);
  setStorageScope("/home/me/Work");
  expect(scopedKey("graite.selectedPath")).not.toBe(notes);
  setStorageScope("/home/me/Notes");
  expect(scopedKey("graite.selectedPath")).toBe(notes);
  setStorageScope("");
  expect(scopedKey("x")).toBe("x");
});

it("names a vault after its folder", () => {
  expect(vaultName("/home/me/Notes/")).toBe("Notes");
  expect(vaultName("C:\\Users\\me\\Vault")).toBe("Vault");
  expect(vaultName(null)).toBe("Graite");
});
