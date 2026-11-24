import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DaemonEvent } from "@graite/api-types";

const cloudMock = vi.hoisted(() => ({
  status: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  models: vi.fn(),
  openAccount: vi.fn(),
}));
const templatesMock = vi.hoisted(() => ({ list: vi.fn(), use: vi.fn(), instructions: vi.fn() }));
const saveProfile = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Set<(event: DaemonEvent) => void>());
vi.mock("@/lib/cloud", () => ({ cloud: cloudMock }));
vi.mock("@/lib/templates", () => ({ templates: templatesMock }));
const mailMock = vi.hoisted(() => ({ accounts: vi.fn(), add: vi.fn() }));
vi.mock("@/lib/mail", () => ({ mail: mailMock }));
vi.mock("@/lib/profile", () => ({ saveProfile }));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    onDaemonEvent: (listener: (event: DaemonEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { Onboarding } from "../onboarding/Onboarding";
import { markOnboarded, needsOnboarding } from "../onboarding/state";

const SIGNED_OUT = { signed_in: false, cloud_url: "https://api.getgraite.com" };
const SIGNED_IN = { ...SIGNED_OUT, signed_in: true, email: "ada@example.com" };
const TEMPLATES = [
  { slug: "crm", name: "CRM", description: "Companies and contacts", icon: "🤝", category: "Work" },
  { slug: "reading", name: "Reading list", description: "Books", icon: "📚", category: "Life" },
];

// An in-memory localStorage: newer Node versions put an unusable one in front of jsdom's.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
});

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  localStorage.clear();
  cloudMock.status.mockResolvedValue(SIGNED_OUT);
  cloudMock.login.mockResolvedValue({ url: "https://api.getgraite.com/auth/x", opened: true });
  templatesMock.list.mockResolvedValue(TEMPLATES);
  mailMock.accounts.mockResolvedValue({ accounts: [] });
  saveProfile.mockImplementation(async (p: { first_name: string }) => p);
});
afterEach(cleanup);

const title = () => screen.getByRole("heading", { level: 1 }).textContent;
const next = () => fireEvent.click(screen.getByRole("button", { name: "Continue" }));

function setup() {
  const props = { onFinish: vi.fn(), onCreateBlankPage: vi.fn() };
  render(<Onboarding {...props} />);
  return props;
}

/** From the name step to the account step, without a name. */
function toAccount() {
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  for (let i = 0; i < 5; i++) next();
  expect(title()).toBe("Your Graite account");
}

it("walks through the steps in order, saving the name and greeting with it", async () => {
  setup();
  expect(screen.getByRole("list", { name: "Step 1 of 9" })).toBeTruthy();
  expect(title()).toBe("Nice to meet you! And you are...?");
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  fireEvent.change(screen.getByLabelText("First name"), { target: { value: "  Sam " } });
  next();
  await waitFor(() => expect(title()).toBe("Welcome aboard, Sam"));
  expect(saveProfile).toHaveBeenCalledWith({ first_name: "Sam" });
  expect(screen.getByText(/whether changes wait for your review/)).toBeTruthy();
  next();
  expect(title()).toBe("The basics");
  next();
  expect(title()).toBe("Connect to Claude, ChatGPT or others");
  expect(screen.getByRole("list", { name: /Claude, ChatGPT, Gemini/ })).toBeTruthy();
  next();
  expect(title()).toBe("AI settings for every page");
  next();
  // Review is a choice per page, not a rule.
  expect(title()).toBe("Review changes, or let AI apply them");
  expect(screen.getByText(/applied directly/)).toBeTruthy();
  next();
  expect(title()).toBe("Your Graite account");
  expect(screen.getByText("Free, and it comes with:")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Graite" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
  // Mail is a step of its own: several mailboxes, or none for now.
  expect(title()).toBe("Bring your mail in");
  expect(screen.getByText(/as many mailboxes as you have/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  expect(title()).toBe("Your first page");
  expect(screen.getByRole("list", { name: "Step 9 of 9" })).toBeTruthy();
  // Back returns to where you were.
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(title()).toBe("Bring your mail in");
});

it("welcomes without a name when the name is skipped", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  expect(title()).toBe("Welcome aboard");
  expect(saveProfile).not.toHaveBeenCalled();
});

it("creates an account or signs in through the browser, then continues", async () => {
  setup();
  toAccount();
  const cont = () => screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
  expect(cont().disabled).toBe(true);
  fireEvent.click(await screen.findByRole("button", { name: "Create an account" }));
  expect(await screen.findByText(/Finish in your browser/)).toBeTruthy();
  expect(cloudMock.login).toHaveBeenCalledWith(true);
  expect(screen.getByRole("button", { name: /Copy link/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByText(/Finish in your browser/);
  expect(cloudMock.login).toHaveBeenLastCalledWith(false);

  cloudMock.status.mockResolvedValue(SIGNED_IN);
  act(() => {
    for (const listener of listeners) listener({ type: "cloud_status", data: { signed_in: true } });
  });
  expect(await screen.findByText(/Signed in as ada@example.com/)).toBeTruthy();
  expect(cont().disabled).toBe(false);
  next();
  expect(title()).toBe("Bring your mail in");
});

it("shows the account as signed in when it already is", async () => {
  cloudMock.status.mockResolvedValue(SIGNED_IN);
  setup();
  toAccount();
  expect(await screen.findByText(/Signed in as ada@example.com/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create an account" })).toBeNull();
  expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

it("makes the first page from a template and finishes with it", async () => {
  templatesMock.use.mockResolvedValue({ path: "CRM" });
  const props = setup();
  toAccount();
  fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
  fireEvent.click(screen.getByRole("button", { name: "Skip" })); // mail
  fireEvent.click(await screen.findByRole("button", { name: /CRM/ }));
  await waitFor(() => expect(props.onFinish).toHaveBeenCalledWith({ createdPath: "CRM" }));
  expect(templatesMock.use).toHaveBeenCalledWith("crm", {
    parentPath: "",
    title: "CRM",
    sampleData: true,
  });
});

it("makes a blank page, or finishes without one", async () => {
  const props = setup();
  props.onCreateBlankPage.mockResolvedValue("Untitled");
  toAccount();
  fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
  fireEvent.click(screen.getByRole("button", { name: "Skip" })); // mail
  await screen.findByRole("button", { name: /CRM/ });
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  expect(props.onFinish).toHaveBeenCalledWith({});
  expect(props.onCreateBlankPage).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /Blank page/ }));
  await waitFor(() => expect(props.onFinish).toHaveBeenLastCalledWith({ createdPath: "Untitled" }));
});

it("adds one mailbox after another in the mail step", async () => {
  setup();
  toAccount();
  fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
  expect(title()).toBe("Bring your mail in");
  const cont = () => screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
  expect(cont().disabled).toBe(true);
  // The same dialog as in Mail: first which kind of mailbox it is.
  fireEvent.click(screen.getByRole("button", { name: "Add a mailbox" }));
  expect(await screen.findByText("Google Workspace")).toBeTruthy();
  fireEvent.click(screen.getByText("Gmail"));
  mailMock.add.mockResolvedValue({ id: "a1", email: "sam@example.org" });
  mailMock.accounts.mockResolvedValue({
    accounts: [{ id: "a1", email: "sam@example.org", name: "Work" }],
  });
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "sam@example.org" },
  });
  fireEvent.change(screen.getByLabelText(/^App password/), { target: { value: "abcd" } });
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
  expect(await screen.findByText("sam@example.org")).toBeTruthy();
  // One is in: another can follow, and the step can be left.
  expect(screen.getByRole("button", { name: "Add another mailbox" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  expect(cont().disabled).toBe(false);
});

it("is only for new users", () => {
  expect(needsOnboarding(null)).toBe(false); // profile still loading
  expect(needsOnboarding({ first_name: "" })).toBe(true);
  expect(needsOnboarding({ first_name: "Sam" })).toBe(false);
  // Asked their name before the onboarding existed.
  localStorage.setItem("graite.nameAsked", "1");
  expect(needsOnboarding({ first_name: "" })).toBe(false);
  localStorage.clear();
  markOnboarded();
  expect(needsOnboarding({ first_name: "" })).toBe(false);
  expect(localStorage.getItem("graite.nameAsked")).toBe("1");
});
