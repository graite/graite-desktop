import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const media = vi.hoisted(() => ({
  attachments: vi.fn(),
  trashAttachment: vi.fn(),
  location: vi.fn(),
}));
const open = vi.hoisted(() => vi.fn());
const host = vi.hoisted(() => ({
  platform: { revealFolder: undefined as undefined | ((path: string) => Promise<void>) },
}));
const events = vi.hoisted(() => ({
  listener: null as null | ((e: { type: string; data: unknown }) => void),
}));
const Api = vi.hoisted(() => ({
  Error: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/api", () => ({
  ApiError: Api.Error,
  onDaemonEvent: (l: typeof events.listener) => {
    events.listener = l;
    return () => {
      events.listener = null;
    };
  },
}));
vi.mock("@/lib/media", () => ({
  media,
  openAttachment: open,
  formatBytes: (n: number) => `${n} B`,
}));
vi.mock("@/lib/platform", () => host);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { AttachmentsDialog } from "../AttachmentsDialog";

const item = (file: string, name: string, referenced: boolean) => ({
  file,
  name,
  kind: "image",
  size: 10,
  modified: "2026-09-15T12:00:00Z",
  referenced,
  referenced_by: referenced ? ["Notes"] : [],
});
const used = item("a".repeat(32) + "-used.png", "used.png", true);
const orphan = item("b".repeat(32) + "-orphan.png", "orphan.png", false);
const show = () =>
  render(<AttachmentsDialog pageId="p1" title="Notes" open onOpenChange={vi.fn()} />);

beforeEach(() => {
  vi.clearAllMocks();
  open.mockResolvedValue(undefined);
  host.platform.revealFolder = undefined;
  media.trashAttachment.mockResolvedValue({ trash_id: "t" });
});
afterEach(cleanup);

it("lists the page's files and marks the ones no block uses", async () => {
  media.attachments.mockResolvedValue([used, orphan]);
  show();
  expect(await screen.findByText("used.png")).toBeTruthy();
  expect(media.attachments).toHaveBeenCalledWith("p1");
  expect(screen.getByText("In use")).toBeTruthy();
  expect(screen.getByText("Not used")).toBeTruthy();
  expect(screen.getByText(/1 of 2 not used/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open orphan.png" }));
  expect(open).toHaveBeenCalledWith("p1", orphan);
  // The web app has no file manager to reveal a folder in.
  expect(
    (screen.getByRole("button", { name: "Show orphan.png in folder" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("moves an unused file to trash at once, and asks first when a page still uses it", async () => {
  media.attachments.mockResolvedValue([used, orphan]);
  show();
  await screen.findByText("orphan.png");
  fireEvent.click(screen.getByRole("button", { name: "Move orphan.png to trash" }));
  await waitFor(() => expect(media.trashAttachment).toHaveBeenCalledWith("p1", orphan.file, false));
  await waitFor(() => expect(screen.queryByText("orphan.png")).toBeNull());

  fireEvent.click(screen.getByRole("button", { name: "Move used.png to trash" }));
  expect(await screen.findByText(/still used on Notes/)).toBeTruthy();
  expect(media.trashAttachment).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
  await waitFor(() =>
    expect(media.trashAttachment).toHaveBeenLastCalledWith("p1", used.file, true),
  );
});

it("asks before forcing when the daemon says the file came into use", async () => {
  media.attachments.mockResolvedValue([orphan]);
  media.trashAttachment.mockRejectedValueOnce(new Api.Error(409, "Still used on: Notes."));
  show();
  await screen.findByText("orphan.png");
  fireEvent.click(screen.getByRole("button", { name: "Move orphan.png to trash" }));
  expect(await screen.findByText(/still used on/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
  await waitFor(() =>
    expect(media.trashAttachment).toHaveBeenLastCalledWith("p1", orphan.file, true),
  );
});

it("reveals the folder on desktop and refreshes when this page's files change", async () => {
  host.platform.revealFolder = vi.fn().mockResolvedValue(undefined);
  media.location.mockResolvedValue({
    folder: "/vault/Notes/_assets",
    path: "/vault/Notes/_assets/x",
  });
  media.attachments.mockResolvedValueOnce([orphan]).mockResolvedValue([orphan, used]);
  show();
  await screen.findByText("orphan.png");
  fireEvent.click(screen.getByRole("button", { name: "Show orphan.png in folder" }));
  await waitFor(() =>
    expect(host.platform.revealFolder).toHaveBeenCalledWith("/vault/Notes/_assets"),
  );
  events.listener?.({ type: "attachments_changed", data: { page_id: "other" } });
  events.listener?.({ type: "attachments_changed", data: { page_id: "p1" } });
  expect(await screen.findByText("used.png")).toBeTruthy();
  expect(media.attachments).toHaveBeenCalledTimes(2);
});

it("leaves extraction text out of the list and clears the unused leftovers in one step", async () => {
  const text = (file: string, referenced: boolean) => ({
    ...item(file, file.slice(33), referenced),
    kind: "text",
    size: 2048,
    generated: true,
  });
  const stale = text("c".repeat(32) + "-transcript.md", false);
  const stale2 = text("d".repeat(32) + "-ocr.md", false);
  const shown = text("e".repeat(32) + "-ocr.md", true); // an old text block still displays this one
  media.attachments.mockResolvedValue([used, stale, stale2, shown]);
  show();
  await screen.findByText("used.png");
  expect(screen.queryByText("transcript.md")).toBeNull();
  expect(screen.queryByText("ocr.md")).toBeNull();
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByText(/2 leftover text files from earlier extractions · 4096 B/)).toBeTruthy();

  // One of them came into use meanwhile: the daemon refuses it and it is kept, never forced.
  media.trashAttachment.mockImplementation(async (_page: string, file: string) => {
    if (file === stale2.file) throw new Api.Error(409, "Still used on: Notes.");
    return { trash_id: "t" };
  });
  fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
  await waitFor(() => expect(media.trashAttachment).toHaveBeenCalledTimes(2));
  expect(media.trashAttachment.mock.calls).toEqual([
    ["p1", stale.file, false],
    ["p1", stale2.file, false],
  ]);
  expect(media.trashAttachment.mock.calls.flat()).not.toContain(shown.file);
});

it("says a page has no attachments when extraction text is all there is", async () => {
  media.attachments.mockResolvedValue([
    {
      ...item("c".repeat(32) + "-transcript.md", "transcript.md", false),
      kind: "text",
      generated: true,
    },
  ]);
  show();
  expect(await screen.findByText("This page has no attachments.")).toBeTruthy();
  expect(screen.getByText(/1 leftover text file from earlier extractions/)).toBeTruthy();
});

it("extracts the text of several ticked files in one go", async () => {
  media.attachments.mockResolvedValue([
    item("1-a.png", "a.png", true),
    item("2-b.png", "b.png", false),
    { ...item("3-notes.zip", "notes.zip", false), kind: "other" },
    { ...item("4-scan.pdf", "scan.pdf", false), kind: "pdf" },
  ]);
  const onExtract = vi.fn<(items: { name: string }[]) => Promise<void>>(async () => {});
  const onOpenChange = vi.fn();
  render(
    <AttachmentsDialog
      pageId="p1"
      title="Scans"
      open
      onOpenChange={onOpenChange}
      onExtract={onExtract}
    />,
  );
  const run = await screen.findByRole("button", { name: "Extract text" });
  expect((run as HTMLButtonElement).disabled).toBe(true);
  // A file no model can read cannot be ticked.
  expect((screen.getByLabelText("Select notes.zip") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Select images" }));
  fireEvent.click(screen.getByLabelText("Select scan.pdf"));
  fireEvent.click(screen.getByLabelText("Select b.png"));
  fireEvent.click(screen.getByRole("button", { name: "Extract text from 2 files" }));
  await waitFor(() => expect(onExtract).toHaveBeenCalledTimes(1));
  expect(onExtract.mock.calls[0]![0].map((i) => i.name)).toEqual(["a.png", "scan.pdf"]);
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});

it("shows no checkboxes where extraction is not offered", async () => {
  media.attachments.mockResolvedValue([item("1-a.png", "a.png", true)]);
  render(<AttachmentsDialog pageId="p1" title="Scans" open onOpenChange={() => {}} />);
  await screen.findByText("a.png");
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: /Extract text/ })).toBeNull();
});
